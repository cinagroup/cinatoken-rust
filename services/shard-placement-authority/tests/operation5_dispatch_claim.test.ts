import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAIM_ENABLE_DISPATCH_CONTRACT,
  OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT,
  claimControllerEnableDispatch,
  operationFiveDispatchClaimDigest,
  parseClaimEnableDispatchCommand,
  type ClaimEnableDispatchCommand,
  type ClaimEnableDispatchDependencies,
  type ClaimEnableDispatchEnv,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchClaimRow,
} from "../src/claim_enable_dispatch";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveApplicationGrantReceiptRow,
  OperationFiveDispatchOutboxRow,
} from "../src/execution_repository";
import { requestIdSha256 } from "../src/execution_protocol";
import {
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";

const digest = (value: string): string => value.repeat(64);
const now = 1_750_000_000;

function startedSnapshot(): ExecutionClaimSnapshot {
  const operationFiveId = digest("2");
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
    inflight_request_sha256: digest("3"),
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
      ? claim.inflight_request_sha256!
      : digest("c"),
    response_sha256: eventKind === "operation_terminal"
      ? digest("d")
      : null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: operationOrdinal === 5
      ? digest("4")
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

function outboxFor(
  snapshot: ExecutionClaimSnapshot,
): OperationFiveDispatchOutboxRow {
  return {
    authorization_id_sha256:
      snapshot.claim.authorization_id_sha256,
    contract_version: 1,
    dispatch_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1",
    claim_digest_sha256: snapshot.claim.claim_digest_sha256,
    application_ticket_id_sha256:
      snapshot.claim.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      snapshot.claim.application_ticket_digest_sha256,
    application_database_identity_sha256:
      snapshot.claim.application_database_identity_sha256,
    application_activation_digest_sha256:
      snapshot.claim.application_activation_digest_sha256!,
    application_acknowledgement_digest_sha256: digest("e"),
    operation_five_admission_digest_sha256: digest("4"),
    operation_five_start_receipt_sha256:
      snapshot.claim.ledger_head_sha256,
    authority_database_identity_sha256:
      snapshot.claim.authority_database_identity_sha256,
    authority_version_id: "authority-dispatch-version",
    authority_ledger_head_sha256:
      snapshot.claim.ledger_head_sha256,
    application_version_id: "application-ack-version",
    application_read_credential_id_sha256: digest("b"),
    application_read_request_id_sha256: digest("c"),
    application_response_sha256: digest("d"),
    application_response_bytes: 2048,
    application_database_now: now,
    dispatch_credential_id_sha256: digest("e"),
    dispatch_request_id_sha256: digest("f"),
    command_dispatch_request_id_sha256: digest("0"),
    controller_service_name: "controller-staging",
    controller_enable_operation_id_sha256:
      snapshot.operations[0]!.operation_id_sha256,
    controller_baseline_version_id: "controller-baseline",
    controller_enabled_version_id: "controller-enabled",
    dispatch_request_sha256: digest("1"),
    outbox_digest_sha256: digest("2"),
    outbox_state: "prepared",
    prepared_at: now,
  };
}

function applicationGrantFor(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
): OperationFiveApplicationGrantReceiptRow {
  return {
    authorization_id_sha256:
      snapshot.claim.authorization_id_sha256,
    contract_version: 1,
    receipt_contract:
      "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1",
    claim_digest_sha256: snapshot.claim.claim_digest_sha256,
    application_ticket_id_sha256:
      outbox.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      outbox.application_ticket_digest_sha256,
    application_database_identity_sha256:
      outbox.application_database_identity_sha256,
    application_activation_digest_sha256:
      outbox.application_activation_digest_sha256,
    application_acknowledgement_digest_sha256:
      outbox.application_acknowledgement_digest_sha256,
    operation_five_admission_digest_sha256:
      outbox.operation_five_admission_digest_sha256,
    operation_five_start_receipt_sha256:
      outbox.operation_five_start_receipt_sha256,
    authority_dispatch_outbox_digest_sha256:
      outbox.outbox_digest_sha256,
    application_grant_digest_sha256: digest("6"),
    application_grant_credential_id_sha256: digest("4"),
    application_grant_request_id_sha256: digest("5"),
    application_version_id: "application-grant-version",
    application_response_sha256: digest("7"),
    application_response_bytes: 3072,
    application_database_now: now,
    application_granted_at: now,
    authority_database_identity_sha256:
      outbox.authority_database_identity_sha256,
    authority_ledger_identity_sha256:
      snapshot.claim.ledger_identity_sha256,
    authority_ledger_head_sha256:
      outbox.authority_ledger_head_sha256,
    authority_version_id: outbox.authority_version_id,
    grant_credential_id_sha256: digest("8"),
    grant_request_id_sha256: digest("9"),
    command_grant_request_id_sha256: digest("a"),
    controller_service_name: outbox.controller_service_name,
    controller_enable_operation_id_sha256:
      outbox.controller_enable_operation_id_sha256,
    controller_baseline_version_id:
      outbox.controller_baseline_version_id,
    controller_enabled_version_id:
      outbox.controller_enabled_version_id,
    receipt_digest_sha256: digest("b"),
    recorded_at: now,
  };
}

function commandFor(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
  applicationGrant: OperationFiveApplicationGrantReceiptRow,
): ClaimEnableDispatchCommand {
  return {
    schemaVersion: 1,
    contract: CLAIM_ENABLE_DISPATCH_CONTRACT,
    authorizationIdSha256:
      snapshot.claim.authorization_id_sha256,
    claimDigestSha256: snapshot.claim.claim_digest_sha256,
    claimOwnerSha256: snapshot.claim.claim_owner_sha256,
    dispatchOutboxDigestSha256: outbox.outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      applicationGrant.receipt_digest_sha256,
    dispatchClaimRequestIdSha256: digest("c"),
  };
}

function rowFor(
  claim: OperationFiveDispatchClaim,
): OperationFiveDispatchClaimRow {
  return {
    authorization_id_sha256: claim.authorizationIdSha256,
    contract_version: 1,
    claim_contract: claim.claimContract,
    claim_digest_sha256: claim.claimDigestSha256,
    application_ticket_id_sha256:
      claim.applicationTicketIdSha256,
    application_database_identity_sha256:
      claim.applicationDatabaseIdentitySha256,
    authority_dispatch_outbox_digest_sha256:
      claim.authorityDispatchOutboxDigestSha256,
    application_grant_receipt_digest_sha256:
      claim.applicationGrantReceiptDigestSha256,
    application_grant_digest_sha256:
      claim.applicationGrantDigestSha256,
    operation_five_start_receipt_sha256:
      claim.operationFiveStartReceiptSha256,
    authority_database_identity_sha256:
      claim.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      claim.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256:
      claim.authorityLedgerHeadSha256,
    authority_version_id: claim.authorityVersionId,
    application_version_id: claim.applicationVersionId,
    dispatch_owner_sha256: claim.dispatchOwnerSha256,
    lease_token_sha256: claim.leaseTokenSha256,
    lease_generation: claim.leaseGeneration,
    lease_expires_at: claim.leaseExpiresAt,
    normal_deadline_at: claim.normalDeadlineAt,
    permit_expires_at: claim.permitExpiresAt,
    dispatch_claim_credential_id_sha256:
      claim.dispatchClaimCredentialIdSha256,
    dispatch_claim_request_id_sha256:
      claim.dispatchClaimRequestIdSha256,
    command_dispatch_claim_request_id_sha256:
      claim.commandDispatchClaimRequestIdSha256,
    controller_service_name: claim.controllerServiceName,
    controller_enable_operation_id_sha256:
      claim.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      claim.controllerBaselineVersionId,
    controller_enabled_version_id:
      claim.controllerEnabledVersionId,
    send_attempt_limit: claim.sendAttemptLimit,
    retry_limit: claim.retryLimit,
    missing_readback_allows_resend:
      claim.missingReadbackAllowsResend,
    dispatch_claim_digest_sha256:
      claim.dispatchClaimDigestSha256,
    claim_state: claim.claimState,
    claimed_at: now,
  };
}

const env = {
  DB: {} as D1Database,
  CF_VERSION_METADATA: { id: "authority-dispatch-version" },
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: digest("7"),
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: digest("0"),
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_CLAIM_WRITE_ENABLED: "true",
} as ClaimEnableDispatchEnv;

const authentication = {
  role: "grant",
  credentialIdSha256: digest("d"),
  keyId: "dispatch-claim-current-v1",
  bodySha256: digest("e"),
  requestId: "operation5-dispatch-claim-route-request-1",
} satisfies AuthenticatedRequest;

describe("Authority operation 5 dispatch claim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only the exact canonical command keys", () => {
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const applicationGrant = applicationGrantFor(snapshot, outbox);
    const command = commandFor(snapshot, outbox, applicationGrant);

    expect(parseClaimEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson(command)),
    )).toEqual(command);
    expect(() => parseClaimEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson({
        ...command,
        extra: true,
      })),
    )).toThrowError(expect.objectContaining({
      code: "invalid_shape",
      status: 400,
    }));
    expect(() => parseClaimEnableDispatchCommand(
      new TextEncoder().encode(JSON.stringify(command)),
    )).toThrowError(expect.objectContaining({
      code: "noncanonical_json",
      status: 400,
    }));
  });

  it("keeps the dispatch claim digest fixed across runtimes", async () => {
    await expect(operationFiveDispatchClaimDigest({
      authorizationIdSha256: digest("1"),
      claimContract:
        OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT,
      claimDigestSha256: digest("2"),
      applicationTicketIdSha256: digest("3"),
      applicationDatabaseIdentitySha256: digest("4"),
      authorityDispatchOutboxDigestSha256: digest("6"),
      applicationGrantReceiptDigestSha256: digest("7"),
      applicationGrantDigestSha256: digest("8"),
      operationFiveStartReceiptSha256: digest("5"),
      authorityDatabaseIdentitySha256: digest("9"),
      authorityLedgerIdentitySha256: digest("a"),
      authorityLedgerHeadSha256: digest("b"),
      authorityVersionId: "authority-version-1",
      applicationVersionId: "application-version-1",
      dispatchOwnerSha256: digest("3"),
      leaseTokenSha256: digest("4"),
      leaseGeneration: 1,
      leaseExpiresAt: 1_750_000_100,
      normalDeadlineAt: 1_750_000_200,
      permitExpiresAt: 1_750_000_300,
      dispatchClaimCredentialIdSha256: digest("c"),
      dispatchClaimRequestIdSha256: digest("d"),
      commandDispatchClaimRequestIdSha256: digest("e"),
      controllerServiceName: "controller-staging",
      controllerEnableOperationIdSha256: digest("f"),
      controllerBaselineVersionId: "controller-baseline",
      controllerEnabledVersionId: "controller-enabled",
      sendAttemptLimit: 1,
      retryLimit: 0,
      missingReadbackAllowsResend: 0,
      claimState: "claimed",
    })).resolves.toBe(
      "3aa5f40fdcc708c68933fc4c483afaa94effa22e9e7522151fb5407640b6b404",
    );
  });

  it("reads every fence before recording a claim and never sends", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const applicationGrant = applicationGrantFor(snapshot, outbox);
    const command = commandFor(snapshot, outbox, applicationGrant);
    const calls: string[] = [];
    let created: OperationFiveDispatchClaim | undefined;

    const result = await claimControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          calls.push("read_claim");
          return snapshot;
        },
        async readOutbox() {
          calls.push("read_outbox");
          return outbox;
        },
        async readApplicationGrant() {
          calls.push("read_application_grant");
          return applicationGrant;
        },
        async readDispatchClaim() {
          calls.push("read_dispatch_claim");
          return null;
        },
        async createDispatchClaim(_database, claim) {
          calls.push("create_dispatch_claim");
          created = claim;
          return {
            classification: "claimed",
            dispatchClaim: rowFor(claim),
            claim: snapshot.claim,
          };
        },
      },
    );

    expect(calls).toEqual([
      "read_claim",
      "read_outbox",
      "read_application_grant",
      "read_dispatch_claim",
      "create_dispatch_claim",
    ]);
    expect(created).toMatchObject({
      authorizationIdSha256:
        command.authorizationIdSha256,
      claimDigestSha256: command.claimDigestSha256,
      dispatchOwnerSha256: command.claimOwnerSha256,
      applicationTicketIdSha256:
        applicationGrant.application_ticket_id_sha256,
      applicationDatabaseIdentitySha256:
        applicationGrant.application_database_identity_sha256,
      applicationVersionId:
        applicationGrant.application_version_id,
      authorityDispatchOutboxDigestSha256:
        command.dispatchOutboxDigestSha256,
      applicationGrantReceiptDigestSha256:
        command.applicationGrantReceiptDigestSha256,
      controllerEnableOperationIdSha256:
        outbox.controller_enable_operation_id_sha256,
      authorityVersionId: env.CF_VERSION_METADATA.id,
    });
    expect(result).toMatchObject({
      result: "dispatch_claim_recorded",
      dispatchClaimDigestSha256:
        created!.dispatchClaimDigestSha256,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns only a full-field exact replay without writing or sending", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const applicationGrant = applicationGrantFor(snapshot, outbox);
    const command = commandFor(snapshot, outbox, applicationGrant);
    const routeRequestId = await requestIdSha256(
      authentication.requestId,
    );
    const claimWithoutDigest: Omit<
      OperationFiveDispatchClaim,
      "dispatchClaimDigestSha256"
    > = {
      authorizationIdSha256: command.authorizationIdSha256,
      claimContract:
        OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT,
      claimDigestSha256: command.claimDigestSha256,
      applicationTicketIdSha256:
        applicationGrant.application_ticket_id_sha256,
      applicationDatabaseIdentitySha256:
        applicationGrant.application_database_identity_sha256,
      authorityDispatchOutboxDigestSha256:
        outbox.outbox_digest_sha256,
      applicationGrantReceiptDigestSha256:
        applicationGrant.receipt_digest_sha256,
      applicationGrantDigestSha256:
        applicationGrant.application_grant_digest_sha256,
      operationFiveStartReceiptSha256:
        outbox.operation_five_start_receipt_sha256,
      authorityDatabaseIdentitySha256:
        snapshot.claim.authority_database_identity_sha256,
      authorityLedgerIdentitySha256:
        snapshot.claim.ledger_identity_sha256,
      authorityLedgerHeadSha256:
        snapshot.claim.ledger_head_sha256,
      authorityVersionId: outbox.authority_version_id,
      applicationVersionId:
        applicationGrant.application_version_id,
      dispatchOwnerSha256: command.claimOwnerSha256,
      leaseTokenSha256: snapshot.claim.lease_token_sha256,
      leaseGeneration: 1,
      leaseExpiresAt: snapshot.claim.lease_expires_at,
      normalDeadlineAt: snapshot.claim.normal_deadline_at,
      permitExpiresAt: snapshot.claim.permit_expires_at,
      dispatchClaimCredentialIdSha256:
        authentication.credentialIdSha256,
      dispatchClaimRequestIdSha256: routeRequestId,
      commandDispatchClaimRequestIdSha256:
        command.dispatchClaimRequestIdSha256,
      controllerServiceName: outbox.controller_service_name,
      controllerEnableOperationIdSha256:
        outbox.controller_enable_operation_id_sha256,
      controllerBaselineVersionId:
        outbox.controller_baseline_version_id,
      controllerEnabledVersionId:
        outbox.controller_enabled_version_id,
      sendAttemptLimit: 1,
      retryLimit: 0,
      missingReadbackAllowsResend: 0,
      claimState: "claimed",
    };
    const stored = rowFor({
      ...claimWithoutDigest,
      dispatchClaimDigestSha256:
        await operationFiveDispatchClaimDigest(
          claimWithoutDigest,
        ),
    });
    const createDispatchClaim = vi.fn();
    const dependencies = dependenciesFor(
      snapshot,
      outbox,
      applicationGrant,
      stored,
      createDispatchClaim,
    );

    const result = await claimControllerEnableDispatch(
      env,
      command,
      authentication,
      dependencies,
    );

    expect(createDispatchClaim).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "exact_replay",
      dispatchClaimDigestSha256:
        stored.dispatch_claim_digest_sha256,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });

    const drifted = {
      ...stored,
      controller_enabled_version_id: "controller-drifted",
    };
    await expect(claimControllerEnableDispatch(
      env,
      command,
      authentication,
      dependenciesFor(
        snapshot,
        outbox,
        applicationGrant,
        drifted,
        createDispatchClaim,
      ),
    )).rejects.toMatchObject({
      code: "operation_five_dispatch_claim_replay_mismatch",
      status: 409,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects fence drift and a disabled gate before any write or send", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const applicationGrant = applicationGrantFor(snapshot, outbox);
    const command = commandFor(snapshot, outbox, applicationGrant);
    const createDispatchClaim = vi.fn();
    const drifted = {
      ...snapshot,
      claim: {
        ...snapshot.claim,
        inflight_started_lease_token_sha256: digest("d"),
      },
    } satisfies ExecutionClaimSnapshot;

    await expect(claimControllerEnableDispatch(
      env,
      command,
      authentication,
      dependenciesFor(
        drifted,
        outbox,
        applicationGrant,
        null,
        createDispatchClaim,
      ),
    )).rejects.toMatchObject({
      code: "operation_five_dispatch_claim_not_admissible",
      status: 409,
    });

    await expect(claimControllerEnableDispatch(
      {
        ...env,
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CLAIM_WRITE_ENABLED:
          "false",
      },
      command,
      authentication,
      dependenciesFor(
        snapshot,
        outbox,
        applicationGrant,
        null,
        createDispatchClaim,
      ),
    )).rejects.toMatchObject({
      code: "authority_dispatch_claim_write_disabled",
      status: 503,
    });
    expect(createDispatchClaim).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function dependenciesFor(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
  applicationGrant: OperationFiveApplicationGrantReceiptRow,
  dispatchClaim: OperationFiveDispatchClaimRow | null,
  createDispatchClaim: ClaimEnableDispatchDependencies[
    "createDispatchClaim"
  ],
): ClaimEnableDispatchDependencies {
  return {
    async readClaim() {
      return snapshot;
    },
    async readOutbox() {
      return outbox;
    },
    async readApplicationGrant() {
      return applicationGrant;
    },
    async readDispatchClaim() {
      return dispatchClaim;
    },
    createDispatchClaim,
  };
}
