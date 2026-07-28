import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationAuthorityAckReadback,
  ApplicationAuthorityAckSnapshot,
} from "../src/application_ack_client";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveAdmissionRow,
  OperationFiveDispatchOutbox,
  OperationFiveDispatchOutboxRow,
} from "../src/execution_repository";
import { requestIdSha256 } from "../src/execution_protocol";
import {
  PREPARE_ENABLE_DISPATCH_CONTRACT,
  prepareControllerEnableDispatch,
  parsePrepareEnableDispatchCommand,
  type PrepareEnableDispatchCommand,
  type PrepareEnableDispatchEnv,
} from "../src/prepare_enable_dispatch";
import {
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";

const digest = (value: string): string => value.repeat(64);
const now = 1_750_000_000;

function commandFor(
  snapshot: ExecutionClaimSnapshot,
  admission: OperationFiveAdmissionRow,
): PrepareEnableDispatchCommand {
  return {
    schemaVersion: 1,
    contract: PREPARE_ENABLE_DISPATCH_CONTRACT,
    authorizationIdSha256:
      snapshot.claim.authorization_id_sha256,
    claimDigestSha256: snapshot.claim.claim_digest_sha256,
    claimOwnerSha256: snapshot.claim.claim_owner_sha256,
    applicationAcknowledgementDigestSha256:
      admission.application_acknowledgement_digest_sha256,
    operationFiveAdmissionDigestSha256:
      admission.confirmation_digest_sha256,
    operationFiveStartReceiptSha256:
      admission.operation_start_receipt_digest_sha256,
    dispatchRequestIdSha256: digest("6"),
  };
}

function startedSnapshot(): ExecutionClaimSnapshot {
  const operationFiveId = digest("2");
  const operationFiveRequest = digest("3");
  const operationFiveAdmission = digest("4");
  const operationFiveStart = digest("5");
  const claim = {
    authorization_id_sha256: digest("1"),
    permit_subject_digest_sha256: digest("2"),
    execution_nonce_sha256: digest("3"),
    application_ticket_id_sha256: digest("4"),
    application_ticket_digest_sha256: digest("5"),
    application_database_identity_sha256: digest("6"),
    authority_database_identity_sha256: digest("7"),
    campaign_id: digest("8"),
    campaign_nonce_sha256: digest("9"),
    claim_scope: "staging-controller-placement-v1",
    execution_plan_sha256: digest("a"),
    release_sha256: digest("b"),
    publication_sha256: digest("c"),
    execution_activation_sha256: digest("d"),
    runner_build_sha256: digest("e"),
    claim_owner_sha256: digest("f"),
    lease_owner_sha256: digest("f"),
    ledger_identity_sha256: digest("0"),
    lease_token_sha256: digest("1"),
    lease_generation: 1,
    lease_expires_at: 2_100_000_100,
    baseline_operation_id_sha256: digest("2"),
    baseline_terminal_digest_sha256: digest("3"),
    preparation_operation_id_sha256: digest("4"),
    claim_operation_id_sha256: digest("5"),
    operation_schedule_sha256: digest("6"),
    claim_credential_id_sha256: digest("7"),
    claim_request_id_sha256: digest("8"),
    claim_digest_sha256: digest("9"),
    claim_acquired_receipt_digest_sha256: digest("a"),
    permit_expires_at: 2_100_000_500,
    normal_deadline_at: 2_100_000_500,
    recovery_deadline_at: 2_100_001_100,
    status: "running",
    ledger_version: 4,
    ledger_head_sha256: operationFiveStart,
    last_completed_ordinal: 4,
    inflight_operation_ordinal: 5,
    inflight_operation_id_sha256: operationFiveId,
    inflight_request_sha256: operationFiveRequest,
    inflight_cloudflare_request_id_sha256: null,
    inflight_started_generation: 1,
    inflight_started_owner_sha256: digest("f"),
    inflight_started_lease_token_sha256: digest("1"),
    inflight_readback_only: 0,
    enable_intent_seen: 1,
    disable_confirmed: 0,
    application_activation_digest_sha256: digest("e"),
    ticket_activation_confirmed: 1,
    renewal_count: 0,
    takeover_count: 0,
    generated_at: now - 10,
    claimed_at: now,
    updated_at: now + 4,
    terminal_at: null,
  } satisfies ExecutionClaimRow;
  const receipt = (
    sequence: number,
    eventKind: string,
    operationOrdinal: number,
    operationIdSha256: string,
    receiptDigestSha256: string,
    predecessorReceiptSha256: string,
  ): ExecutionReceiptRow => ({
    authorization_id_sha256: claim.authorization_id_sha256,
    sequence,
    event_kind: eventKind,
    claim_digest_sha256: claim.claim_digest_sha256,
    execution_plan_sha256: claim.execution_plan_sha256,
    ledger_identity_sha256: claim.ledger_identity_sha256,
    operation_ordinal: operationOrdinal,
    operation_id_sha256: operationIdSha256,
    operation_kind: operationOrdinal === 5
      ? "enable_controller_deployment"
      : "activate_execution_ticket",
    shard_index: null,
    predecessor_receipt_sha256: predecessorReceiptSha256,
    request_sha256: operationOrdinal === 5
      ? operationFiveRequest
      : digest("c"),
    response_sha256: eventKind === "operation_terminal"
      ? digest("d")
      : null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: operationOrdinal === 5
      ? operationFiveAdmission
      : digest("e"),
    safety_reason: null,
    outcome: eventKind === "operation_started"
      ? "pending"
      : "exact_success",
    lease_owner_sha256: claim.lease_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: claim.lease_generation,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: digest("0"),
    request_id_sha256: digest("1"),
    receipt_digest_sha256: receiptDigestSha256,
    recorded_at: now + sequence,
  });
  return {
    claim,
    operations: [{
      authorization_id_sha256: claim.authorization_id_sha256,
      ordinal: 5,
      operation_id_sha256: operationFiveId,
      kind: "enable_controller_deployment",
      shard_index: null,
    }],
    receipts: [
      receipt(
        1,
        "claim_acquired",
        3,
        claim.claim_operation_id_sha256,
        claim.claim_acquired_receipt_digest_sha256,
        claim.baseline_terminal_digest_sha256,
      ),
      receipt(
        2,
        "operation_started",
        4,
        digest("b"),
        digest("b"),
        claim.claim_acquired_receipt_digest_sha256,
      ),
      receipt(
        3,
        "operation_terminal",
        4,
        digest("b"),
        digest("c"),
        digest("b"),
      ),
      receipt(
        4,
        "operation_started",
        5,
        operationFiveId,
        operationFiveStart,
        digest("c"),
      ),
    ],
  };
}

function admissionFor(
  snapshot: ExecutionClaimSnapshot,
): OperationFiveAdmissionRow {
  return {
    authorization_id_sha256:
      snapshot.claim.authorization_id_sha256,
    contract_version: 1,
    confirmation_contract:
      "cinatoken-shard-placement-authority-operation-five-admission-v1",
    claim_digest_sha256: snapshot.claim.claim_digest_sha256,
    application_ticket_id_sha256:
      snapshot.claim.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      snapshot.claim.application_ticket_digest_sha256,
    application_database_identity_sha256:
      snapshot.claim.application_database_identity_sha256,
    application_activation_digest_sha256:
      snapshot.claim.application_activation_digest_sha256!,
    authority_activation_terminal_receipt_sha256: digest("d"),
    authority_ledger_head_sha256: digest("d"),
    authority_database_identity_sha256:
      snapshot.claim.authority_database_identity_sha256,
    authority_version_id: "authority-admission-version",
    application_acknowledgement_digest_sha256: digest("e"),
    application_version_id: "application-admission-version",
    application_read_credential_id_sha256: digest("f"),
    application_read_request_id_sha256: digest("0"),
    application_response_sha256: digest("1"),
    application_response_bytes: 1_024,
    enable_credential_id_sha256: digest("2"),
    enable_request_id_sha256: digest("3"),
    command_enable_request_id_sha256: digest("4"),
    enable_operation_request_sha256:
      snapshot.claim.inflight_request_sha256!,
    confirmation_digest_sha256:
      snapshot.receipts[3]!.evidence_sha256,
    operation_start_receipt_digest_sha256:
      snapshot.receipts[3]!.receipt_digest_sha256,
    confirmed_at: now,
  };
}

function acknowledgementFor(
  snapshot: ExecutionClaimSnapshot,
  admission: OperationFiveAdmissionRow,
): ApplicationAuthorityAckReadback {
  const acknowledgement = {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-container-shard-placement-authority-ack-snapshot-v1",
    ticketIdSha256: snapshot.claim.application_ticket_id_sha256,
    ticketDigestSha256:
      snapshot.claim.application_ticket_digest_sha256,
    authorizationIdSha256:
      snapshot.claim.authorization_id_sha256,
    campaignId: snapshot.claim.campaign_id,
    applicationDatabaseIdentitySha256:
      snapshot.claim.application_database_identity_sha256,
    authorityDatabaseIdentitySha256:
      snapshot.claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      snapshot.claim.ledger_identity_sha256,
    operationScheduleSha256:
      snapshot.claim.operation_schedule_sha256,
    controllerServiceName: "controller-service-from-ack",
    controllerBaselineVersionId: "controller-baseline-from-ack",
    controllerEnabledVersionId: "controller-enabled-from-ack",
    controllerEnableOperationIdSha256:
      snapshot.operations[0]!.operation_id_sha256,
    authorityClaimDigestSha256:
      snapshot.claim.claim_digest_sha256,
    authorityClaimAcquiredReceiptSha256:
      snapshot.claim.claim_acquired_receipt_digest_sha256,
    authorityClaimOperationIdSha256:
      snapshot.claim.claim_operation_id_sha256,
    authorityActivationOperationIdSha256: digest("c"),
    applicationActivationDigestSha256:
      snapshot.claim.application_activation_digest_sha256!,
    authorityActivationTerminalReceiptSha256: digest("d"),
    authorityLedgerHeadSha256: digest("d"),
    authorityVersionId: admission.authority_version_id,
    authorityReadCredentialIdSha256: digest("e"),
    authorityReadRequestIdSha256: digest("f"),
    acknowledgementDigestSha256:
      admission.application_acknowledgement_digest_sha256,
    acknowledgedByAdminId: 7,
    preparedAt: now - 20,
    activatedAt: now - 10,
    acknowledgedAt: now - 5,
    activationDeadlineAt: now + 200,
    executionDeadlineAt: now + 500,
    permitExpiresAt: now + 500,
    campaignExpiresAt: now + 500,
    campaignSealedAt: null,
    databaseNow: now,
  } satisfies ApplicationAuthorityAckSnapshot;
  return {
    acknowledgement,
    applicationVersionId: "application-dispatch-read-version",
    responseSha256: digest("a"),
    responseBytes: 2_048,
    credentialIdSha256: digest("b"),
    requestIdSha256: digest("c"),
  };
}

function outboxRow(
  outbox: OperationFiveDispatchOutbox,
): OperationFiveDispatchOutboxRow {
  return {
    authorization_id_sha256: outbox.authorizationIdSha256,
    contract_version: 1,
    dispatch_contract: outbox.dispatchContract,
    claim_digest_sha256: outbox.claimDigestSha256,
    application_ticket_id_sha256:
      outbox.applicationTicketIdSha256,
    application_ticket_digest_sha256:
      outbox.applicationTicketDigestSha256,
    application_database_identity_sha256:
      outbox.applicationDatabaseIdentitySha256,
    application_activation_digest_sha256:
      outbox.applicationActivationDigestSha256,
    application_acknowledgement_digest_sha256:
      outbox.applicationAcknowledgementDigestSha256,
    operation_five_admission_digest_sha256:
      outbox.operationFiveAdmissionDigestSha256,
    operation_five_start_receipt_sha256:
      outbox.operationFiveStartReceiptSha256,
    authority_database_identity_sha256:
      outbox.authorityDatabaseIdentitySha256,
    authority_version_id: outbox.authorityVersionId,
    authority_ledger_head_sha256:
      outbox.authorityLedgerHeadSha256,
    application_version_id: outbox.applicationVersionId,
    application_read_credential_id_sha256:
      outbox.applicationReadCredentialIdSha256,
    application_read_request_id_sha256:
      outbox.applicationReadRequestIdSha256,
    application_response_sha256:
      outbox.applicationResponseSha256,
    application_response_bytes: outbox.applicationResponseBytes,
    application_database_now: outbox.applicationDatabaseNow,
    dispatch_credential_id_sha256:
      outbox.dispatchCredentialIdSha256,
    dispatch_request_id_sha256: outbox.dispatchRequestIdSha256,
    command_dispatch_request_id_sha256:
      outbox.commandDispatchRequestIdSha256,
    controller_service_name: outbox.controllerServiceName,
    controller_enable_operation_id_sha256:
      outbox.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      outbox.controllerBaselineVersionId,
    controller_enabled_version_id:
      outbox.controllerEnabledVersionId,
    dispatch_request_sha256: outbox.dispatchRequestSha256,
    outbox_digest_sha256: outbox.outboxDigestSha256,
    outbox_state: "prepared",
    prepared_at: now,
  };
}

const env = {
  DB: {} as D1Database,
  CF_VERSION_METADATA: { id: "authority-dispatch-version" },
  SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED: "true",
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED: "true",
} as PrepareEnableDispatchEnv;

const authentication = {
  role: "dispatch",
  credentialIdSha256: digest("7"),
  keyId: "dispatch-current-v1",
  bodySha256: digest("8"),
  requestId: "operation5-dispatch-route-request-1",
} satisfies AuthenticatedRequest;

describe("Authority operation 5 dispatch preparation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only an exact canonical command", () => {
    const snapshot = startedSnapshot();
    const command = commandFor(snapshot, admissionFor(snapshot));

    expect(parsePrepareEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson(command)),
    )).toEqual(command);
    expect(() => parsePrepareEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson({
        ...command,
        extra: true,
      })),
    )).toThrowError(expect.objectContaining({
      code: "invalid_shape",
      status: 400,
    }));
    expect(() => parsePrepareEnableDispatchCommand(
      new TextEncoder().encode(JSON.stringify(command)),
    )).toThrowError(expect.objectContaining({
      code: "noncanonical_json",
      status: 400,
    }));
  });

  it("rereads the ACK and fence before preparing the outbox", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = startedSnapshot();
    const admission = admissionFor(snapshot);
    const command = commandFor(snapshot, admission);
    const acknowledgement = acknowledgementFor(snapshot, admission);
    const calls: string[] = [];
    let claimReads = 0;
    let createdOutbox: OperationFiveDispatchOutbox | undefined;
    const dependencies = {
      async readClaim() {
        calls.push("read_claim");
        claimReads += 1;
        return snapshot;
      },
      async readAdmission() {
        calls.push("read_admission");
        return admission;
      },
      async readOutbox() {
        calls.push("read_outbox");
        return null;
      },
      async readAcknowledgement(
        _clientEnv: unknown,
        authority: ExecutionClaimSnapshot,
        readCommand: {
          applicationAcknowledgementDigestSha256: string;
          callerRequestIdSha256: string;
          requestDomain: "op5-dispatch";
        },
        authorityVersionId: string,
      ) {
        calls.push("read_application_ack");
        expect(authority).toBe(snapshot);
        expect(readCommand).toEqual({
          applicationAcknowledgementDigestSha256:
            command.applicationAcknowledgementDigestSha256,
          callerRequestIdSha256: command.dispatchRequestIdSha256,
          requestDomain: "op5-dispatch",
        });
        expect(authorityVersionId).toBe(
          admission.authority_version_id,
        );
        return acknowledgement;
      },
      async createOutbox(
        _database: D1Database,
        outbox: OperationFiveDispatchOutbox,
      ) {
        calls.push("create_outbox");
        createdOutbox = outbox;
        return {
          classification: "prepared" as const,
          outbox: outboxRow(outbox),
          claim: snapshot.claim,
        };
      },
    };

    const result = await prepareControllerEnableDispatch(
      env,
      command,
      authentication,
      dependencies,
    );

    expect(claimReads).toBe(2);
    expect(calls).toEqual([
      "read_claim",
      "read_admission",
      "read_outbox",
      "read_application_ack",
      "read_claim",
      "create_outbox",
    ]);
    expect(createdOutbox).toMatchObject({
      applicationVersionId: acknowledgement.applicationVersionId,
      controllerServiceName:
        acknowledgement.acknowledgement.controllerServiceName,
      controllerEnableOperationIdSha256:
        acknowledgement.acknowledgement
          .controllerEnableOperationIdSha256,
      controllerBaselineVersionId:
        acknowledgement.acknowledgement
          .controllerBaselineVersionId,
      controllerEnabledVersionId:
        acknowledgement.acknowledgement.controllerEnabledVersionId,
      authorityVersionId: env.CF_VERSION_METADATA.id,
    });
    expect(result).toMatchObject({
      result: "dispatch_outbox_prepared",
      outboxState: "prepared",
      receiptCount: 4,
      receiptHeadSha256: snapshot.claim.ledger_head_sha256,
      authorityVersionId: env.CF_VERSION_METADATA.id,
    });
  });

  it("returns an exact replay without rereading the ACK or writing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = startedSnapshot();
    const admission = admissionFor(snapshot);
    const command = commandFor(snapshot, admission);
    const routeRequestIdSha256 = await requestIdSha256(
      authentication.requestId,
    );
    const replayOutbox = outboxRow({
      authorizationIdSha256: command.authorizationIdSha256,
      dispatchContract:
        "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1",
      claimDigestSha256: command.claimDigestSha256,
      applicationTicketIdSha256:
        snapshot.claim.application_ticket_id_sha256,
      applicationTicketDigestSha256:
        snapshot.claim.application_ticket_digest_sha256,
      applicationDatabaseIdentitySha256:
        snapshot.claim.application_database_identity_sha256,
      applicationActivationDigestSha256:
        snapshot.claim.application_activation_digest_sha256!,
      applicationAcknowledgementDigestSha256:
        command.applicationAcknowledgementDigestSha256,
      operationFiveAdmissionDigestSha256:
        command.operationFiveAdmissionDigestSha256,
      operationFiveStartReceiptSha256:
        command.operationFiveStartReceiptSha256,
      authorityDatabaseIdentitySha256:
        snapshot.claim.authority_database_identity_sha256,
      authorityVersionId: "authority-dispatch-version",
      authorityLedgerHeadSha256:
        snapshot.claim.ledger_head_sha256,
      applicationVersionId: "application-dispatch-read-version",
      applicationReadCredentialIdSha256: digest("b"),
      applicationReadRequestIdSha256: digest("c"),
      applicationResponseSha256: digest("a"),
      applicationResponseBytes: 2_048,
      applicationDatabaseNow: now,
      dispatchCredentialIdSha256:
        authentication.credentialIdSha256,
      dispatchRequestIdSha256: routeRequestIdSha256,
      commandDispatchRequestIdSha256:
        command.dispatchRequestIdSha256,
      controllerServiceName: "controller-service-from-ack",
      controllerEnableOperationIdSha256:
        snapshot.operations[0]!.operation_id_sha256,
      controllerBaselineVersionId:
        "controller-baseline-from-ack",
      controllerEnabledVersionId: "controller-enabled-from-ack",
      dispatchRequestSha256: digest("d"),
      outboxDigestSha256: digest("e"),
    });
    const readAcknowledgement = vi.fn();
    const createOutbox = vi.fn();
    const calls: string[] = [];

    const result = await prepareControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          calls.push("read_claim");
          return snapshot;
        },
        async readAdmission() {
          calls.push("read_admission");
          return admission;
        },
        async readOutbox() {
          calls.push("read_outbox");
          return replayOutbox;
        },
        readAcknowledgement,
        createOutbox,
      },
    );

    expect(calls).toEqual([
      "read_claim",
      "read_admission",
      "read_outbox",
    ]);
    expect(readAcknowledgement).not.toHaveBeenCalled();
    expect(createOutbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "exact_replay",
      dispatchRequestSha256: replayOutbox.dispatch_request_sha256,
      dispatchOutboxDigestSha256:
        replayOutbox.outbox_digest_sha256,
      outboxState: "prepared",
    });
  });

  it("rejects a changed fence before writing the outbox", async () => {
    const snapshot = startedSnapshot();
    const changed = {
      ...snapshot,
      claim: {
        ...snapshot.claim,
        lease_expires_at: snapshot.claim.lease_expires_at + 1,
      },
    } satisfies ExecutionClaimSnapshot;
    const admission = admissionFor(snapshot);
    const command = commandFor(snapshot, admission);
    const acknowledgement = acknowledgementFor(snapshot, admission);
    const calls: string[] = [];
    let claimReads = 0;
    const createOutbox = vi.fn();

    await expect(prepareControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          calls.push("read_claim");
          claimReads += 1;
          return claimReads === 1 ? snapshot : changed;
        },
        async readAdmission() {
          calls.push("read_admission");
          return admission;
        },
        async readOutbox() {
          calls.push("read_outbox");
          return null;
        },
        async readAcknowledgement() {
          calls.push("read_application_ack");
          return acknowledgement;
        },
        createOutbox,
      },
    )).rejects.toMatchObject({
      code: "operation_five_dispatch_fence_changed",
      status: 409,
    });
    expect(calls).toEqual([
      "read_claim",
      "read_admission",
      "read_outbox",
      "read_application_ack",
      "read_claim",
    ]);
    expect(createOutbox).not.toHaveBeenCalled();
  });
});
