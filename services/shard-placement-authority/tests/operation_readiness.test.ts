import { describe, expect, it, vi } from "vitest";

import type {
  ContainerControllerReadinessCallResult,
} from "../src/container_controller_readiness_client";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveTerminalRow,
} from "../src/execution_repository";
import {
  executeOperationReadiness,
  type OperationReadinessCommand,
  type OperationReadinessDependencies,
  type OperationReadinessEnv,
} from "../src/operation_readiness";
import type {
  OperationReadinessAttempt,
  OperationReadinessAttemptRow,
  OperationReadinessTerminal,
  OperationReadinessTerminalRow,
} from "../src/operation_readiness_repository";
import {
  requestIdSha256,
  type ExecutionReceipt,
} from "../src/execution_protocol";
import {
  sha256Hex,
  type AuthenticatedRequest,
} from "../src/protocol";
import type { IssuanceRow } from "../src/repository";
import { authorityRoutingForTest } from "../src/index";

const NOW = 1_750_000_000;
const digest = (value: string): string => value.repeat(64);
const encoder = new TextEncoder();

describe("Authority operation 6-13 readiness orchestration", () => {
  it("routes fresh and recovery calls through isolated roles and gates", async () => {
    const fixture = await readinessFixture(healthy("fresh"));
    const prefix =
      "https://authority.internal/internal/v1/shard-placement/execution-claims/"
      + fixture.command.authorizationIdSha256;
    const probeRoute = authorityRoutingForTest.match(new Request(
      `${prefix}/probe-shard-readiness`,
      { method: "POST" },
    ));
    const recoveryRoute = authorityRoutingForTest.match(new Request(
      `${prefix}/recover-shard-readiness`,
      { method: "POST" },
    ));
    expect(probeRoute).toEqual({
      kind: "execution_probe_shard_readiness",
      role: "send",
    });
    expect(recoveryRoute).toEqual({
      kind: "execution_recover_shard_readiness",
      role: "recovery",
    });

    const enabled = {
      ...fixture.env,
      SHARD_PLACEMENT_AUTHORITY_READINESS_PROBE_ENABLED: "true",
      SHARD_PLACEMENT_AUTHORITY_READINESS_READBACK_ENABLED: "true",
    };
    expect(() => authorityRoutingForTest.requireGate(
      probeRoute.kind,
      enabled,
    )).not.toThrow();
    expect(() => authorityRoutingForTest.requireGate(
      recoveryRoute.kind,
      enabled,
    )).not.toThrow();
    expect(() => authorityRoutingForTest.requireGate(
      probeRoute.kind,
      {
        ...enabled,
        SHARD_PLACEMENT_AUTHORITY_READINESS_PROBE_ENABLED: "false",
      },
    )).toThrow(
      expect.objectContaining({
        message: "authority_operation_readiness_probe_disabled",
        status: 503,
      }),
    );
    expect(() => authorityRoutingForTest.requireGate(
      recoveryRoute.kind,
      {
        ...enabled,
        SHARD_PLACEMENT_AUTHORITY_READINESS_READBACK_ENABLED: "false",
      },
    )).toThrow(
      expect.objectContaining({
        message: "authority_operation_readiness_readback_disabled",
        status: 503,
      }),
    );
    expect(
      Array.from(
        { length: 11 },
        (_, index) => index + 4,
      ).every(
        authorityRoutingForTest.requiresDedicatedOperationRoute,
      ),
    ).toBe(true);
    expect(
      authorityRoutingForTest.requiresDedicatedOperationRoute(3),
    ).toBe(false);
  });

  it("persists the start before the only wake and records disabled readiness", async () => {
    const fixture = await readinessFixture(healthy("fresh"));

    const result = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      result: "readiness_recorded",
      operationOrdinal: 6,
      shardIndex: 0,
      status: "running",
      receiptCount: 7,
      lastCompletedOrdinal: 6,
      nextOperationOrdinal: 7,
      recoveryAction: "none",
    });
    expect(fixture.calls).toEqual([
      "read_evidence",
      "read_claim",
      "read_issuance",
      "read_operation_five_terminal",
      "create_attempt",
      "read_claim",
      "probe",
      "read_claim",
      "read_database_now",
      "create_terminal",
    ]);
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.readback).not.toHaveBeenCalled();
    expect(fixture.createdAttempt).toMatchObject({
      operationOrdinal: 6,
      shardIndex: 0,
      shardCount: 8,
      instanceName: "cinatoken-relay-shard-v1-0000",
    });
    expect(fixture.createdTerminal).toMatchObject({
      resultOutcome: "exact_success",
      recoveryMode: "fresh",
      processReady: true,
      executionReady: false,
      runtimeExecutionEnabled: false,
      controllerExecutionEnabled: false,
      containerState: "healthy",
    });
  });

  it("never resends an unknown wake and permits only readback recovery", async () => {
    const fixture = await readinessFixture(unknown("wake_once"));

    const first = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );
    expect(first).toMatchObject({
      result: "probe_outcome_unknown",
      receiptCount: 6,
      nextOperationOrdinal: 6,
      recoveryAction: "readback_only",
      operationTerminalReceiptSha256: null,
    });
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.readback).not.toHaveBeenCalled();
    expect(fixture.createdTerminal).toBeNull();

    fixture.readback.mockResolvedValue(healthy("exact_replay"));
    fixture.calls.length = 0;
    const recovered = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );

    expect(recovered).toMatchObject({
      result: "ambiguous_recovered",
      receiptCount: 7,
      lastCompletedOrdinal: 6,
      nextOperationOrdinal: 7,
      recoveryAction: "none",
    });
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.readback).toHaveBeenCalledOnce();
    expect(fixture.calls).toEqual([
      "read_evidence",
      "read_claim",
      "read_issuance",
      "read_operation_five_terminal",
      "read_claim",
      "read_database_now",
      "create_terminal",
    ]);
    expect(fixture.createdTerminal).toMatchObject({
      resultOutcome: "ambiguous_recovered",
      recoveryMode: "readback_only",
    });
  });

  it("converts explicit unhealthy evidence into operation-14 recovery", async () => {
    const fixture = await readinessFixture(unhealthy());

    const result = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      result: "disable_required",
      status: "disable_required",
      receiptCount: 7,
      lastCompletedOrdinal: 5,
      nextOperationOrdinal: 14,
      recoveryAction: "operation_14",
    });
    expect(fixture.createdTerminal).toMatchObject({
      resultOutcome: "rejected",
      recoveryMode: "fresh",
      processReady: null,
      controllerExecutionEnabled: null,
    });
  });

  it("records unresolved when the independent recovery readback stays unknown", async () => {
    const fixture = await readinessFixture(unknown("wake_once"));
    await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );
    fixture.readback.mockResolvedValue(unknown("replay_only"));

    const result = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.recoveryAuthentication,
      "readback",
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      result: "disable_required",
      status: "disable_required",
      lastCompletedOrdinal: 5,
      nextOperationOrdinal: 14,
      recoveryAction: "operation_14",
    });
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.readback).toHaveBeenCalledOnce();
    expect(fixture.createdTerminal).toMatchObject({
      resultOutcome: "unresolved",
      recoveryMode: "readback_only",
    });
  });

  it("returns an immutable terminal replay without reading mutable sources", async () => {
    const fixture = await readinessFixture(healthy("fresh"));
    await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );
    fixture.calls.length = 0;
    fixture.probe.mockClear();
    fixture.readback.mockClear();

    const result = await executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "probe",
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      result: "exact_replay",
      receiptCount: 7,
      lastCompletedOrdinal: 6,
      nextOperationOrdinal: 7,
    });
    expect(fixture.calls).toEqual(["read_evidence"]);
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.readback).not.toHaveBeenCalled();
  });

  it("rejects recovery without a persisted wake attempt", async () => {
    const fixture = await readinessFixture(healthy("exact_replay"));

    await expect(executeOperationReadiness(
      fixture.env,
      fixture.command,
      fixture.recoveryAuthentication,
      "readback",
      fixture.dependencies,
    )).rejects.toMatchObject({
      message: "operation_readiness_attempt_missing",
      status: 409,
    });
    expect(fixture.probe).not.toHaveBeenCalled();
    expect(fixture.readback).not.toHaveBeenCalled();
  });
});

async function readinessFixture(
  probeResult: ContainerControllerReadinessCallResult,
) {
  const requestId = "operation-6-request";
  const campaignNonce = digest("9");
  const campaignNonceSha256 = await sha256Hex(
    encoder.encode(campaignNonce),
  );
  const command: OperationReadinessCommand = {
    schemaVersion: 1,
    contract:
      "cinatoken-shard-placement-authority-operation-readiness-command-v1",
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    claimOwnerSha256: digest("3"),
    operationOrdinal: 6,
    operationIdSha256: digest("4"),
    campaignNonce,
    operationRequestIdSha256: await requestIdSha256(requestId),
  };
  let snapshot = snapshotFixture(command, campaignNonceSha256);
  const issuance = issuanceFixture(command, campaignNonceSha256);
  const operationFiveTerminal =
    operationFiveTerminalFixture(command);
  let persistedAttempt: OperationReadinessAttemptRow | null = null;
  let persistedTerminal: OperationReadinessTerminalRow | null = null;
  let createdAttempt: OperationReadinessAttempt | null = null;
  let createdTerminal: OperationReadinessTerminal | null = null;
  const calls: string[] = [];
  const probe = vi.fn(async () => {
    calls.push("probe");
    return probeResult;
  });
  const readback = vi.fn(async () => {
    calls.push("readback");
    return healthy("exact_replay");
  });
  const dependencies: OperationReadinessDependencies = {
    async readClaim() {
      calls.push("read_claim");
      return snapshot;
    },
    async readIssuance() {
      calls.push("read_issuance");
      return issuance;
    },
    async readOperationFiveTerminal() {
      calls.push("read_operation_five_terminal");
      return operationFiveTerminal;
    },
    async readEvidence() {
      calls.push("read_evidence");
      return {
        attempt: persistedAttempt,
        terminal: persistedTerminal,
      };
    },
    async readDatabaseNow() {
      calls.push("read_database_now");
      return NOW;
    },
    async createAttempt(_database, attempt, receipt) {
      calls.push("create_attempt");
      createdAttempt = attempt;
      persistedAttempt = attemptRow(attempt);
      snapshot = {
        ...snapshot,
        claim: {
          ...snapshot.claim,
          ledger_version: receipt.sequence,
          ledger_head_sha256: receipt.receiptDigestSha256,
          inflight_operation_ordinal: attempt.operationOrdinal,
          inflight_operation_id_sha256: attempt.operationIdSha256,
          inflight_request_sha256: attempt.operationRequestSha256,
          inflight_started_generation: 1,
          inflight_started_owner_sha256: attempt.leaseOwnerSha256,
          inflight_started_lease_token_sha256:
            attempt.leaseTokenSha256,
        },
      };
      return {
        classification: "created",
        attempt: persistedAttempt,
        receipt: receiptRow(receipt, snapshot.claim),
        claim: snapshot.claim,
      };
    },
    async createTerminal(
      _database,
      terminal,
      receipt,
    ) {
      calls.push("create_terminal");
      createdTerminal = terminal;
      persistedTerminal = terminalRow(terminal);
      const success = terminal.resultOutcome === "exact_success"
        || terminal.resultOutcome === "ambiguous_recovered";
      snapshot = {
        ...snapshot,
        claim: {
          ...snapshot.claim,
          status: success ? "running" : "disable_required",
          ledger_version: receipt.sequence,
          ledger_head_sha256: receipt.receiptDigestSha256,
          last_completed_ordinal: success
            ? terminal.operationOrdinal
            : terminal.operationOrdinal - 1,
          inflight_operation_ordinal: null,
          inflight_operation_id_sha256: null,
          inflight_request_sha256: null,
          inflight_started_generation: null,
          inflight_started_owner_sha256: null,
          inflight_started_lease_token_sha256: null,
          inflight_readback_only: 0,
        },
      };
      return {
        classification: "created",
        terminal: persistedTerminal,
        receipt: receiptRow(receipt, snapshot.claim),
        claim: snapshot.claim,
      };
    },
    probe,
    readback,
  };
  const env = {
    DB: {} as D1Database,
    CF_VERSION_METADATA: { id: "authority-version-1" },
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: digest("5"),
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: digest("6"),
    SHARD_PLACEMENT_AUTHORITY_READINESS_ATTEMPT_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_AUTHORITY_READINESS_TERMINAL_WRITE_ENABLED: "true",
  } as OperationReadinessEnv;
  const sendAuthentication: AuthenticatedRequest = {
    role: "send",
    credentialIdSha256: digest("7"),
    keyId: "send-current",
    bodySha256: digest("8"),
    requestId,
  };
  const recoveryAuthentication: AuthenticatedRequest = {
    ...sendAuthentication,
    role: "recovery",
    credentialIdSha256: digest("a"),
    keyId: "recovery-current",
    requestId: "operation-6-recovery",
  };

  return {
    env,
    command,
    sendAuthentication,
    recoveryAuthentication,
    dependencies,
    calls,
    probe,
    readback,
    get createdAttempt() {
      return createdAttempt;
    },
    get createdTerminal() {
      return createdTerminal;
    },
  };
}

function snapshotFixture(
  command: OperationReadinessCommand,
  campaignNonceSha256: string,
): ExecutionClaimSnapshot {
  const claim: ExecutionClaimRow = {
    authorization_id_sha256: command.authorizationIdSha256,
    permit_subject_digest_sha256: digest("b"),
    execution_nonce_sha256: digest("c"),
    application_ticket_id_sha256: digest("d"),
    application_ticket_digest_sha256: digest("e"),
    application_database_identity_sha256: digest("f"),
    authority_database_identity_sha256: digest("5"),
    campaign_id: digest("0"),
    campaign_nonce_sha256: campaignNonceSha256,
    claim_scope: "staging-controller-placement-v1",
    execution_plan_sha256: digest("a"),
    release_sha256: digest("b"),
    publication_sha256: digest("c"),
    execution_activation_sha256: digest("d"),
    runner_build_sha256: digest("e"),
    claim_owner_sha256: command.claimOwnerSha256,
    lease_owner_sha256: command.claimOwnerSha256,
    ledger_identity_sha256: digest("6"),
    lease_token_sha256: digest("f"),
    lease_generation: 1,
    lease_expires_at: NOW + 300,
    baseline_operation_id_sha256: digest("1"),
    baseline_terminal_digest_sha256: digest("2"),
    preparation_operation_id_sha256: digest("3"),
    claim_operation_id_sha256: digest("4"),
    operation_schedule_sha256: digest("5"),
    claim_credential_id_sha256: digest("6"),
    claim_request_id_sha256: digest("7"),
    claim_digest_sha256: command.claimDigestSha256,
    claim_acquired_receipt_digest_sha256: digest("8"),
    permit_expires_at: NOW + 600,
    normal_deadline_at: NOW + 600,
    recovery_deadline_at: NOW + 900,
    status: "running",
    ledger_version: 5,
    ledger_head_sha256: digest("9"),
    last_completed_ordinal: 5,
    inflight_operation_ordinal: null,
    inflight_operation_id_sha256: null,
    inflight_request_sha256: null,
    inflight_cloudflare_request_id_sha256: null,
    inflight_started_generation: null,
    inflight_started_owner_sha256: null,
    inflight_started_lease_token_sha256: null,
    inflight_readback_only: 0,
    enable_intent_seen: 1,
    disable_confirmed: 0,
    application_activation_digest_sha256: digest("a"),
    ticket_activation_confirmed: 1,
    renewal_count: 0,
    takeover_count: 0,
    generated_at: NOW - 100,
    claimed_at: NOW - 90,
    updated_at: NOW - 1,
    terminal_at: null,
  };
  return {
    claim,
    operations: [{
      authorization_id_sha256: command.authorizationIdSha256,
      ordinal: 6,
      operation_id_sha256: command.operationIdSha256,
      kind: "probe_shard_readiness",
      shard_index: 0,
    }],
    receipts: [],
  };
}

function issuanceFixture(
  command: OperationReadinessCommand,
  campaignNonceSha256: string,
): IssuanceRow {
  return {
    authorization_id_sha256: command.authorizationIdSha256,
    campaign_id: digest("0"),
    campaign_nonce_sha256: campaignNonceSha256,
    permit_subject_digest_sha256: digest("b"),
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_version_id: "controller-version-1",
    action_gate_inventory_sha256: digest("c"),
    runtime_build_id: digest("e"),
    ring_generation: 1,
    shard_count: 8,
    revoked_at: null,
    database_now: NOW,
  } as IssuanceRow;
}

function operationFiveTerminalFixture(
  command: OperationReadinessCommand,
): OperationFiveTerminalRow {
  return {
    authorization_id_sha256: command.authorizationIdSha256,
    claim_digest_sha256: command.claimDigestSha256,
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_enabled_version_id: "controller-version-1",
    authority_terminal_version_id: "authority-version-1",
    generic_receipt_sequence: 5,
    generic_terminal_receipt_digest_sha256: digest("9"),
    next_operation_ordinal: 6,
  } as OperationFiveTerminalRow;
}

function attemptRow(
  attempt: OperationReadinessAttempt,
): OperationReadinessAttemptRow {
  return {
    authorization_id_sha256: attempt.authorizationIdSha256,
    operation_ordinal: attempt.operationOrdinal,
    shard_index: attempt.shardIndex,
    contract_version: 1,
    attempt_contract: attempt.attemptContract,
    claim_digest_sha256: attempt.claimDigestSha256,
    claim_owner_sha256: attempt.claimOwnerSha256,
    lease_owner_sha256: attempt.leaseOwnerSha256,
    lease_token_sha256: attempt.leaseTokenSha256,
    lease_generation: 1,
    execution_plan_sha256: attempt.executionPlanSha256,
    operation_schedule_sha256: attempt.operationScheduleSha256,
    authority_database_identity_sha256:
      attempt.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      attempt.authorityLedgerIdentitySha256,
    ledger_head_before_sha256: attempt.ledgerHeadBeforeSha256,
    predecessor_receipt_sha256: attempt.predecessorReceiptSha256,
    operation_five_terminal_receipt_sha256:
      attempt.operationFiveTerminalReceiptSha256,
    operation_id_sha256: attempt.operationIdSha256,
    operation_request_sha256: attempt.operationRequestSha256,
    campaign_id: attempt.campaignId,
    campaign_nonce_sha256: attempt.campaignNonceSha256,
    ring_generation: attempt.ringGeneration,
    shard_count: 8,
    instance_name: attempt.instanceName,
    controller_service_name: attempt.controllerServiceName,
    controller_enabled_version_id:
      attempt.controllerEnabledVersionId,
    runtime_build_id: attempt.runtimeBuildId,
    probe_id_sha256: attempt.probeIdSha256,
    attempt_generation: 1,
    dispatch_mode: "wake_once",
    wake_attempt_limit: 1,
    wake_retry_limit: 0,
    missing_readback_allows_resend: 0,
    probe_deadline_at_ms: attempt.probeDeadlineAtMs,
    authority_version_id: attempt.authorityVersionId,
    send_credential_id_sha256: attempt.sendCredentialIdSha256,
    send_request_id_sha256: attempt.sendRequestIdSha256,
    attempt_digest_sha256: attempt.attemptDigestSha256,
    operation_start_receipt_digest_sha256:
      attempt.operationStartReceiptDigestSha256,
    recorded_at: NOW,
  };
}

function terminalRow(
  terminal: OperationReadinessTerminal,
): OperationReadinessTerminalRow {
  return {
    authorization_id_sha256: terminal.authorizationIdSha256,
    operation_ordinal: terminal.operationOrdinal,
    shard_index: terminal.shardIndex,
    contract_version: 1,
    terminal_contract: terminal.terminalContract,
    claim_digest_sha256: terminal.claimDigestSha256,
    attempt_digest_sha256: terminal.attemptDigestSha256,
    operation_id_sha256: terminal.operationIdSha256,
    probe_id_sha256: terminal.probeIdSha256,
    operation_request_sha256: terminal.operationRequestSha256,
    operation_start_receipt_digest_sha256:
      terminal.operationStartReceiptDigestSha256,
    result_outcome: terminal.resultOutcome,
    recovery_mode: terminal.recoveryMode,
    controller_service_name: terminal.controllerServiceName,
    expected_controller_version_id:
      terminal.expectedControllerVersionId,
    observed_controller_version_id:
      terminal.observedControllerVersionId,
    expected_runtime_build_id: terminal.expectedRuntimeBuildId,
    observed_runtime_build_id: terminal.observedRuntimeBuildId,
    readiness_result_code: terminal.readinessResultCode,
    process_ready: booleanInteger(terminal.processReady),
    execution_ready: booleanInteger(terminal.executionReady),
    runtime_execution_enabled:
      booleanInteger(terminal.runtimeExecutionEnabled),
    controller_execution_enabled:
      booleanInteger(terminal.controllerExecutionEnabled),
    container_state: terminal.containerState,
    readiness_result_sha256: terminal.readinessResultSha256,
    controller_response_sha256: terminal.controllerResponseSha256,
    controller_response_bytes: terminal.controllerResponseBytes,
    controller_request_id_sha256:
      terminal.controllerRequestIdSha256,
    terminal_writer_credential_id_sha256:
      terminal.terminalWriterCredentialIdSha256,
    terminal_writer_request_id_sha256:
      terminal.terminalWriterRequestIdSha256,
    terminal_authority_version_id:
      terminal.terminalAuthorityVersionId,
    terminal_evidence_sha256: terminal.terminalEvidenceSha256,
    generic_terminal_receipt_digest_sha256:
      terminal.genericTerminalReceiptDigestSha256,
    recorded_at: NOW,
  };
}

function receiptRow(
  receipt: ExecutionReceipt,
  claim: ExecutionClaimRow,
): ExecutionReceiptRow {
  return {
    authorization_id_sha256: receipt.authorizationIdSha256,
    sequence: receipt.sequence,
    event_kind: receipt.eventKind,
    claim_digest_sha256: receipt.claimDigestSha256,
    execution_plan_sha256: receipt.executionPlanSha256,
    ledger_identity_sha256: receipt.ledgerIdentitySha256,
    operation_ordinal: receipt.operationOrdinal,
    operation_id_sha256: receipt.operationIdSha256,
    operation_kind: receipt.operationKind,
    shard_index: receipt.shardIndex,
    predecessor_receipt_sha256: receipt.predecessorReceiptSha256,
    request_sha256: receipt.requestSha256,
    response_sha256: receipt.responseSha256,
    cloudflare_request_id_sha256:
      receipt.cloudflareRequestIdSha256,
    evidence_sha256: receipt.evidenceSha256,
    safety_reason: receipt.safetyReason,
    outcome: receipt.outcome,
    lease_owner_sha256: receipt.actorOwnerSha256,
    lease_token_sha256: receipt.leaseTokenSha256,
    lease_generation: receipt.leaseGeneration,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: receipt.actorCredentialIdSha256,
    request_id_sha256: receipt.requestIdSha256,
    receipt_digest_sha256: receipt.receiptDigestSha256,
    recorded_at: NOW,
  };
}

function healthy(
  replay: "fresh" | "exact_replay",
): ContainerControllerReadinessCallResult {
  return {
    classification: "process_ready_execution_disabled",
    recoveryAction: "continue",
    httpStatus: 200,
    responseBodySha256: digest("1"),
    responseBytes: 512,
    readinessCredentialIdSha256: digest("2"),
    readinessRequestIdSha256: digest("4"),
    evidence: {
      mode: replay === "fresh" ? "wake_once" : "replay_only",
      replay,
      controllerServiceName:
        "cinatoken-container-controller-staging",
      controllerVersionId: "controller-version-1",
      actionGateInventorySha256: digest("c"),
      controllerExecutionEnabled: false,
      runtimeBuildId: digest("e"),
      processReady: true,
      executionReady: false,
      runtimeExecutionEnabled: false,
      containerState: "healthy",
      resultCode: "process_ready_execution_disabled",
      readinessResultSha256: digest("f"),
      journalGeneration: 1,
      journalStartedAtMs: NOW * 1_000,
      journalDeadlineAtMs: (NOW + 45) * 1_000,
      journalCompletedAtMs: (NOW + 1) * 1_000,
      journalRetentionUntilMs: (NOW + 900) * 1_000,
      wakePerformed: replay === "fresh",
    },
  };
}

function unhealthy(): ContainerControllerReadinessCallResult {
  return {
    classification: "explicitly_unhealthy",
    recoveryAction: "disable_required",
    reasonCode: "container_process_not_ready",
    httpStatus: 409,
    responseBodySha256: digest("1"),
    responseBytes: 128,
    readinessCredentialIdSha256: digest("2"),
    readinessRequestIdSha256: digest("4"),
  };
}

function unknown(
  mode: "wake_once" | "replay_only",
): ContainerControllerReadinessCallResult {
  return {
    classification: "outcome_unknown",
    recoveryAction:
      mode === "wake_once" ? "readback_only" : "manual_intervention",
    code: "container_controller_readiness_timeout",
    mode,
    httpStatus: 504,
    responseBodySha256: null,
    responseBytes: null,
  };
}

function booleanInteger(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}
