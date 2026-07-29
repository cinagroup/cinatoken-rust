import { describe, expect, it, vi } from "vitest";

import type {
  ControllerDisableAttestationEvidence,
} from "../src/controller_disable_attestation_client";
import type {
  ControllerDisableGatewayCallEvidence,
  ControllerDisableStatusResult,
} from "../src/controller_deployment_disable_gateway_client";
import {
  requestIdSha256,
  type ExecutionReceipt,
} from "../src/execution_protocol";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveSendAttemptPair,
  OperationFiveTerminalRow,
} from "../src/execution_repository";
import {
  OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
  executeOperationFourteenDisable,
  parseOperationFourteenDisableCommand,
  type OperationFourteenDisableCommand,
  type OperationFourteenDisableDependencies,
  type OperationFourteenDisableEnv,
} from "../src/operation_fourteen_disable";
import type {
  OperationFourteenAttempt,
  OperationFourteenAttemptRow,
  OperationFourteenEvidence,
  OperationFourteenGatewayEvent,
  OperationFourteenGatewayEventRow,
  OperationFourteenTerminal,
  OperationFourteenTerminalRow,
} from "../src/operation_fourteen_repository";
import {
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";
import type { IssuanceRow } from "../src/repository";
import {
  authorityRoutingForTest,
  type AuthorityEnv,
} from "../src/index";

const NOW = 1_900_000_000;
const digest = (value: string): string => value.repeat(64);

describe("Authority operation 14 disable orchestration", () => {
  it("uses isolated fresh/recovery routes and blocks ordinal 14 generic receipts", () => {
    const authorization = digest("1");
    const prefix =
      "https://authority.internal/internal/v1/shard-placement/execution-claims/"
      + authorization;
    const fresh = authorityRoutingForTest.match(new Request(
      `${prefix}/disable-controller-deployment`,
      { method: "POST" },
    ));
    expect(fresh).toEqual({
      kind: "execution_disable_controller_deployment",
      role: "send",
    });
    const recovery = authorityRoutingForTest.match(new Request(
      `${prefix}/recover-disable-controller-deployment`,
      { method: "POST" },
    ));
    expect(recovery).toEqual({
      kind: "execution_recover_disable_controller_deployment",
      role: "recovery",
    });
    const gates = {
      SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_DISABLE_ENABLED:
        "true",
      SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_READBACK_ENABLED:
        "true",
      SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_ATTEMPT_WRITE_ENABLED:
        "true",
      SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED:
        "true",
      SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_TERMINAL_WRITE_ENABLED:
        "true",
    } as AuthorityEnv;
    expect(() =>
      authorityRoutingForTest.requireGate(fresh.kind, gates)
    ).not.toThrow();
    expect(() =>
      authorityRoutingForTest.requireGate(recovery.kind, gates)
    ).not.toThrow();
    expect(() =>
      authorityRoutingForTest.requireGate(fresh.kind, {
        ...gates,
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED:
          "false",
      })
    ).toThrowError(/authority_operation_fourteen_disable_disabled/);
    expect(
      authorityRoutingForTest.requiresDedicatedOperationRoute(14),
    ).toBe(true);
  });

  it("parses only the exact canonical operation 14 command", async () => {
    const command = await commandFixture();
    expect(parseOperationFourteenDisableCommand(
      new TextEncoder().encode(canonicalJson(command)),
    )).toEqual(command);
    expect(() => parseOperationFourteenDisableCommand(
      new TextEncoder().encode(canonicalJson({
        ...command,
        callerBaselineVersionId: "forbidden",
      })),
    )).toThrowError(/invalid_shape/);
  });

  it("never resends after an unknown mutation and completes only after stable readback plus Controller attestation", async () => {
    const fixture = await orchestrationFixture();

    const first = await executeOperationFourteenDisable(
      fixture.env,
      fixture.command,
      fixture.sendAuthentication,
      "fresh",
      fixture.dependencies,
    );
    expect(first).toMatchObject({
      result: "disable_outcome_unknown",
      lastGatewayEventKind: "mutation_unknown",
      gatewayEventCount: 2,
      recoveryAction: "status_only",
    });
    expect(fixture.createGateway).toHaveBeenCalledTimes(1);
    expect(fixture.readGatewayStatus).not.toHaveBeenCalled();

    fixture.clock = NOW + 6;
    fixture.statusTargetStable = false;
    const second = await executeOperationFourteenDisable(
      fixture.env,
      fixture.command,
      fixture.recoveryAuthentication,
      "readback",
      fixture.dependencies,
    );
    expect(second).toMatchObject({
      result: "status_observation_recorded",
      lastGatewayEventKind: "status_target",
      gatewayEventCount: 3,
      recoveryAction: "status_only",
    });
    expect(fixture.createGateway).toHaveBeenCalledTimes(1);
    expect(fixture.readGatewayStatus).toHaveBeenCalledTimes(1);
    expect(fixture.readControllerAttestation).not.toHaveBeenCalled();

    fixture.clock = NOW + 12;
    fixture.statusTargetStable = true;
    const third = await executeOperationFourteenDisable(
      fixture.env,
      fixture.command,
      fixture.recoveryAuthentication,
      "readback",
      fixture.dependencies,
    );
    expect(third).toMatchObject({
      result: "terminal_recorded",
      lastGatewayEventKind: "stable_disabled",
      gatewayEventCount: 4,
      status: "completed",
      disableConfirmed: true,
      recoveryAction: "none",
    });
    expect(fixture.createGateway).toHaveBeenCalledTimes(1);
    expect(fixture.readGatewayStatus).toHaveBeenCalledTimes(2);
    expect(fixture.readControllerAttestation).toHaveBeenCalledTimes(1);
    expect(fixture.createdTerminal).toMatchObject({
      resultOutcome: "ambiguous_recovered",
      recoveryMode: "readback_only",
      terminalEventKind: "stable_disabled",
    });
  });
});

async function orchestrationFixture() {
  const requestId = "operation-14-disable-request";
  const command: OperationFourteenDisableCommand = {
    schemaVersion: 1,
    contract: OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    claimOwnerSha256: digest("3"),
    operationIdSha256: digest("4"),
    operationRequestIdSha256: await requestIdSha256(requestId),
  };
  let clock = NOW;
  let snapshot = snapshotFixture(command);
  const issuance = issuanceFixture(command);
  const operationFiveTerminal = operationFiveTerminalFixture(command);
  const operationFiveSendAttempt = operationFiveSendAttemptFixture(
    command,
  );
  let evidence: OperationFourteenEvidence = {
    attempt: null,
    gatewayEvents: [],
    terminal: null,
  };
  let createdTerminal: OperationFourteenTerminal | null = null;
  let statusTargetStable = false;

  const createGateway = vi.fn(async () => {
    throw new Error("mutation outcome unknown");
  });
  const readGatewayStatus = vi.fn(async () =>
    statusEvidence(
      evidence.attempt!,
      statusTargetStable,
      clock,
    )
  );
  const readControllerAttestation = vi.fn(async () =>
    attestationEvidence(evidence.attempt!)
  );

  const dependencies: OperationFourteenDisableDependencies = {
    async readClaim() {
      return snapshot;
    },
    async readIssuance() {
      return { ...issuance, database_now: clock };
    },
    async readOperationFiveTerminal() {
      return operationFiveTerminal;
    },
    async readOperationFiveSendAttempt() {
      return operationFiveSendAttempt;
    },
    async readEvidence() {
      return evidence;
    },
    async readDatabaseNow() {
      return clock;
    },
    async createAttempt(_database, attempt, receipt, dispatchEvent) {
      const persistedAttempt = attemptRow(attempt, clock);
      const persistedDispatch = eventRow(dispatchEvent, clock);
      evidence = {
        attempt: persistedAttempt,
        gatewayEvents: [persistedDispatch],
        terminal: null,
      };
      snapshot = {
        ...snapshot,
        claim: {
          ...snapshot.claim,
          ledger_version: receipt.sequence,
          ledger_head_sha256: receipt.receiptDigestSha256,
          inflight_operation_ordinal: 14,
          inflight_operation_id_sha256: attempt.operationIdSha256,
          inflight_request_sha256: attempt.operationRequestSha256,
          inflight_started_generation: attempt.leaseGeneration,
          inflight_started_owner_sha256: attempt.leaseOwnerSha256,
          inflight_started_lease_token_sha256:
            attempt.leaseTokenSha256,
        },
      };
      return {
        classification: "created",
        attempt: persistedAttempt,
        receipt: receiptRow(receipt, snapshot.claim, clock),
        dispatchEvent: persistedDispatch,
        claim: snapshot.claim,
      };
    },
    async appendEvent(_database, event) {
      const persisted = eventRow(event, clock);
      evidence = {
        ...evidence,
        gatewayEvents: [...evidence.gatewayEvents, persisted],
      };
      return { classification: "created", event: persisted };
    },
    async createTerminal(_database, terminal, receipt) {
      createdTerminal = terminal;
      const persisted = terminalRow(terminal, clock);
      const success =
        terminal.resultOutcome === "exact_success"
        || terminal.resultOutcome === "ambiguous_recovered";
      snapshot = {
        ...snapshot,
        claim: {
          ...snapshot.claim,
          status: success ? "completed" : "recovery_required",
          ledger_version: receipt.sequence,
          ledger_head_sha256: receipt.receiptDigestSha256,
          last_completed_ordinal: success ? 14 : 13,
          inflight_operation_ordinal: null,
          inflight_operation_id_sha256: null,
          inflight_request_sha256: null,
          inflight_started_generation: null,
          inflight_started_owner_sha256: null,
          inflight_started_lease_token_sha256: null,
          inflight_readback_only: 0,
          disable_confirmed: success ? 1 : 0,
          terminal_at: clock,
        },
      };
      evidence = { ...evidence, terminal: persisted };
      return {
        classification: "created",
        terminal: persisted,
        receipt: receiptRow(receipt, snapshot.claim, clock),
        claim: snapshot.claim,
      };
    },
    createGateway: createGateway as
      OperationFourteenDisableDependencies["createGateway"],
    readGatewayStatus: readGatewayStatus as
      OperationFourteenDisableDependencies["readGatewayStatus"],
    readControllerAttestation: readControllerAttestation as
      OperationFourteenDisableDependencies["readControllerAttestation"],
  };

  const env = {
    DB: {} as D1Database,
    CF_VERSION_METADATA: { id: "authority-version-14" },
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: digest("5"),
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: digest("6"),
    SHARD_PLACEMENT_AUTHORITY_EXPECTED_CONTROLLER_DEPLOYMENT_GATEWAY_VERSION_ID:
      "gateway-version-14",
    SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_ATTEMPT_WRITE_ENABLED:
      "true",
    SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED:
      "true",
    SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_TERMINAL_WRITE_ENABLED:
      "true",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("7"),
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("8"),
  } as OperationFourteenDisableEnv;
  const sendAuthentication: AuthenticatedRequest = {
    role: "send",
    credentialIdSha256: digest("9"),
    keyId: "send-current",
    bodySha256: digest("a"),
    requestId,
  };
  const recoveryAuthentication: AuthenticatedRequest = {
    role: "recovery",
    credentialIdSha256: digest("b"),
    keyId: "recovery-current",
    bodySha256: digest("c"),
    requestId: "operation-14-disable-recovery",
  };

  return {
    env,
    command,
    sendAuthentication,
    recoveryAuthentication,
    dependencies,
    createGateway,
    readGatewayStatus,
    readControllerAttestation,
    get clock() {
      return clock;
    },
    set clock(value: number) {
      clock = value;
    },
    get statusTargetStable() {
      return statusTargetStable;
    },
    set statusTargetStable(value: boolean) {
      statusTargetStable = value;
    },
    get createdTerminal() {
      return createdTerminal;
    },
  };
}

async function commandFixture(): Promise<OperationFourteenDisableCommand> {
  return {
    schemaVersion: 1,
    contract: OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    claimOwnerSha256: digest("3"),
    operationIdSha256: digest("4"),
    operationRequestIdSha256:
      await requestIdSha256("operation-14-parser"),
  };
}

function snapshotFixture(
  command: OperationFourteenDisableCommand,
): ExecutionClaimSnapshot {
  const claim = {
    authorization_id_sha256: command.authorizationIdSha256,
    permit_subject_digest_sha256: digest("d"),
    authority_database_identity_sha256: digest("5"),
    ledger_identity_sha256: digest("6"),
    campaign_id: digest("e"),
    claim_owner_sha256: command.claimOwnerSha256,
    lease_owner_sha256: command.claimOwnerSha256,
    lease_token_sha256: digest("f"),
    lease_generation: 1,
    lease_expires_at: NOW + 300,
    permit_expires_at: NOW + 600,
    normal_deadline_at: NOW + 300,
    recovery_deadline_at: NOW + 600,
    execution_plan_sha256: digest("a"),
    operation_schedule_sha256: digest("b"),
    claim_digest_sha256: command.claimDigestSha256,
    status: "running",
    ledger_version: 22,
    ledger_head_sha256: digest("c"),
    last_completed_ordinal: 13,
    inflight_operation_ordinal: null,
    inflight_operation_id_sha256: null,
    inflight_request_sha256: null,
    inflight_started_generation: null,
    inflight_started_owner_sha256: null,
    inflight_started_lease_token_sha256: null,
    inflight_readback_only: 0,
    enable_intent_seen: 1,
    disable_confirmed: 0,
    terminal_at: null,
  } as ExecutionClaimRow;
  return {
    claim,
    operations: [{
      authorization_id_sha256: command.authorizationIdSha256,
      ordinal: 14,
      operation_id_sha256: command.operationIdSha256,
      kind: "disable_controller_deployment",
      shard_index: null,
    }],
    receipts: [],
  };
}

function issuanceFixture(
  command: OperationFourteenDisableCommand,
): IssuanceRow {
  return {
    authorization_id_sha256: command.authorizationIdSha256,
    permit_subject_digest_sha256: digest("d"),
    campaign_id: digest("e"),
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_version_id: "controller-baseline-version",
    action_gate_inventory_sha256: digest("a"),
    revoked_at: null,
    database_now: NOW,
  } as IssuanceRow;
}

function operationFiveTerminalFixture(
  command: OperationFourteenDisableCommand,
): OperationFiveTerminalRow {
  return {
    authorization_id_sha256: command.authorizationIdSha256,
    claim_digest_sha256: command.claimDigestSha256,
    attempt_digest_sha256: digest("1"),
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_enabled_version_id: "controller-enabled-version",
    authority_database_identity_sha256: digest("5"),
    authority_ledger_identity_sha256: digest("6"),
    generic_terminal_receipt_digest_sha256: digest("c"),
  } as OperationFiveTerminalRow;
}

function operationFiveSendAttemptFixture(
  command: OperationFourteenDisableCommand,
): OperationFiveSendAttemptPair {
  return {
    attempt: {
      authorization_id_sha256: command.authorizationIdSha256,
      claim_digest_sha256: command.claimDigestSha256,
      attempt_digest_sha256: digest("1"),
      controller_service_name:
        "cinatoken-container-controller-staging",
      controller_enabled_version_id: "controller-enabled-version",
      controller_baseline_version_id: "controller-baseline-version",
      authority_database_identity_sha256: digest("5"),
      authority_ledger_identity_sha256: digest("6"),
    },
    event: {},
  } as OperationFiveSendAttemptPair;
}

function attemptRow(
  value: OperationFourteenAttempt,
  recordedAt: number,
): OperationFourteenAttemptRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    operation_ordinal: 14,
    contract_version: 1,
    attempt_contract: value.attemptContract,
    claim_digest_sha256: value.claimDigestSha256,
    claim_owner_sha256: value.claimOwnerSha256,
    lease_owner_sha256: value.leaseOwnerSha256,
    lease_token_sha256: value.leaseTokenSha256,
    lease_generation: value.leaseGeneration,
    execution_plan_sha256: value.executionPlanSha256,
    operation_schedule_sha256: value.operationScheduleSha256,
    authority_database_identity_sha256:
      value.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      value.authorityLedgerIdentitySha256,
    ledger_version_before: value.ledgerVersionBefore,
    ledger_head_before_sha256: value.ledgerHeadBeforeSha256,
    operation_start_sequence: value.operationStartSequence,
    operation_five_terminal_receipt_sha256:
      value.operationFiveTerminalReceiptSha256,
    operation_five_send_attempt_digest_sha256:
      value.operationFiveSendAttemptDigestSha256,
    operation_id_sha256: value.operationIdSha256,
    operation_request_sha256: value.operationRequestSha256,
    controller_service_name: value.controllerServiceName,
    controller_enabled_source_version_id:
      value.controllerEnabledSourceVersionId,
    controller_baseline_target_version_id:
      value.controllerBaselineTargetVersionId,
    authority_command_contract: value.authorityCommandContract,
    authority_command_digest_sha256:
      value.authorityCommandDigestSha256,
    gateway_command_contract: value.gatewayCommandContract,
    gateway_command_digest_sha256: value.gatewayCommandDigestSha256,
    gateway_idempotency_contract: value.gatewayIdempotencyContract,
    gateway_idempotency_key_sha256:
      value.gatewayIdempotencyKeySha256,
    gateway_create_credential_id_sha256:
      value.gatewayCreateCredentialIdSha256,
    gateway_create_request_id_sha256:
      value.gatewayCreateRequestIdSha256,
    gateway_status_credential_id_sha256:
      value.gatewayStatusCredentialIdSha256,
    gateway_status_request_id_sha256:
      value.gatewayStatusRequestIdSha256,
    authority_version_id: value.authorityVersionId,
    expected_gateway_version_id: value.expectedGatewayVersionId,
    disable_deadline_at: value.disableDeadlineAt,
    mutation_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    attempt_digest_sha256: value.attemptDigestSha256,
    operation_start_receipt_digest_sha256:
      value.operationStartReceiptDigestSha256,
    disable_dispatched_event_digest_sha256:
      value.disableDispatchedEventDigestSha256,
    recorded_at: recordedAt,
  };
}

function eventRow(
  value: OperationFourteenGatewayEvent,
  recordedAt: number,
): OperationFourteenGatewayEventRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    attempt_digest_sha256: value.attemptDigestSha256,
    event_sequence: value.eventSequence,
    contract_version: 1,
    event_contract: value.eventContract,
    event_kind: value.eventKind,
    dispatch_semantics: value.dispatchSemantics,
    credential_role: value.credentialRole,
    credential_id_sha256: value.credentialIdSha256,
    request_id_sha256: value.requestIdSha256,
    authority_command_digest_sha256:
      value.authorityCommandDigestSha256,
    gateway_command_digest_sha256: value.gatewayCommandDigestSha256,
    gateway_idempotency_key_sha256:
      value.gatewayIdempotencyKeySha256,
    controller_service_name: value.controllerServiceName,
    controller_baseline_target_version_id:
      value.controllerBaselineTargetVersionId,
    expected_gateway_version_id: value.expectedGatewayVersionId,
    observed_gateway_version_id: value.observedGatewayVersionId,
    observed_controller_version_id: value.observedControllerVersionId,
    status_classification: value.statusClassification,
    gateway_http_status: value.gatewayHttpStatus,
    gateway_response_sha256: value.gatewayResponseSha256,
    gateway_response_bytes: value.gatewayResponseBytes,
    cloudflare_request_id_sha256:
      value.cloudflareRequestIdSha256,
    deployment_set_sha256: value.deploymentSetSha256,
    observation_digest_sha256: value.observationDigestSha256,
    stability_minimum_seconds: value.stabilityMinimumSeconds,
    predecessor_event_digest_sha256:
      value.predecessorEventDigestSha256,
    event_digest_sha256: value.eventDigestSha256,
    recorded_at: recordedAt,
  };
}

function statusEvidence(
  attempt: OperationFourteenAttemptRow,
  targetStable: boolean,
  recordedAt: number,
): ControllerDisableGatewayCallEvidence<ControllerDisableStatusResult> {
  return {
    value: {
      result: "disable_status_observation_recorded",
      requestId: `status-${recordedAt}`,
      gatewayDisableIdempotencyKeySha256:
        attempt.gateway_idempotency_key_sha256,
      controllerDisableCommandDigestSha256:
        attempt.gateway_command_digest_sha256,
      remoteMutationSent: false,
      remoteReadSent: true,
      targetStable,
      requiredMatchingObservations: 2,
      stabilityMinimumSeconds: 5,
      observation: {
        classification: "exact_disable_observed",
        deploymentsHttpStatus: 200,
        baselineVersionHttpStatus: 200,
        deploymentSetSha256: digest("d"),
        baselineVersionSha256: digest("e"),
        responseRequestIdSha256: digest("f"),
        stateDigestSha256: digest("0"),
        observationDigestSha256: digest("1"),
        recordedAt,
      },
      gatewayVersionId: attempt.expected_gateway_version_id,
    },
    gatewayCredentialIdSha256:
      attempt.gateway_status_credential_id_sha256,
    gatewayRequestIdSha256: digest("2"),
    gatewayResponseSha256: digest("3"),
    gatewayResponseBytes: 512,
  };
}

function attestationEvidence(
  attempt: OperationFourteenAttemptRow,
): ControllerDisableAttestationEvidence {
  return {
    value: {
      schemaVersion: 1,
      contract: "cinatoken-container-controller-disable-attestation-v1",
      requestIdSha256: digest("4"),
      controllerServiceName: attempt.controller_service_name,
      controllerVersionId:
        attempt.controller_baseline_target_version_id,
      controllerEnabled: false,
      executionEnabled: false,
      allActionGatesFalse: true,
      actionGates: {
        allActionGatesFalse: true,
        count: 22,
        digestSha256: digest("a"),
        inventory: Array.from({ length: 22 }, (_, index) => ({
          enabled: false as const,
          name: `ACTION_GATE_${index}`,
        })),
      },
    },
    credentialIdSha256: digest("5"),
    requestIdSha256: digest("4"),
    responseSha256: digest("6"),
    responseBytes: 1024,
  };
}

function terminalRow(
  value: OperationFourteenTerminal,
  recordedAt: number,
): OperationFourteenTerminalRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    claim_digest_sha256: value.claimDigestSha256,
    claim_owner_sha256: value.claimOwnerSha256,
    operation_id_sha256: value.operationIdSha256,
    attempt_digest_sha256: value.attemptDigestSha256,
    operation_start_receipt_digest_sha256:
      value.operationStartReceiptDigestSha256,
    controller_service_name: value.controllerServiceName,
    controller_enabled_source_version_id:
      value.controllerEnabledSourceVersionId,
    controller_baseline_target_version_id:
      value.controllerBaselineTargetVersionId,
    result_outcome: value.resultOutcome,
    recovery_mode: value.recoveryMode,
    generic_receipt_sequence: value.genericReceiptSequence,
    generic_terminal_receipt_digest_sha256:
      value.genericTerminalReceiptDigestSha256,
    recorded_at: recordedAt,
  } as OperationFourteenTerminalRow;
}

function receiptRow(
  value: ExecutionReceipt,
  claim: ExecutionClaimRow,
  recordedAt: number,
): ExecutionReceiptRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    sequence: value.sequence,
    event_kind: value.eventKind,
    claim_digest_sha256: value.claimDigestSha256,
    execution_plan_sha256: value.executionPlanSha256,
    ledger_identity_sha256: value.ledgerIdentitySha256,
    operation_ordinal: value.operationOrdinal,
    operation_id_sha256: value.operationIdSha256,
    operation_kind: value.operationKind,
    shard_index: value.shardIndex,
    predecessor_receipt_sha256: value.predecessorReceiptSha256,
    request_sha256: value.requestSha256,
    response_sha256: value.responseSha256,
    cloudflare_request_id_sha256: value.cloudflareRequestIdSha256,
    evidence_sha256: value.evidenceSha256,
    safety_reason: value.safetyReason,
    outcome: value.outcome,
    lease_owner_sha256: claim.lease_owner_sha256,
    lease_token_sha256: value.leaseTokenSha256,
    lease_generation: value.leaseGeneration,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: value.actorCredentialIdSha256,
    request_id_sha256: value.requestIdSha256,
    receipt_digest_sha256: value.receiptDigestSha256,
    recorded_at: recordedAt,
  };
}
