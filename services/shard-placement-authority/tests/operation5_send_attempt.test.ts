import { describe, expect, it, vi } from "vitest";

import { operationFiveDispatchClaimDigest } from "../src/claim_enable_dispatch";
import {
  operationFiveDispatchConsumptionReceiptDigest,
} from "../src/consume_enable_dispatch";
import {
  operationFiveSendAttemptRepositoryForTest,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchConsumptionReceipt,
  type OperationFiveDispatchConsumptionReceiptRow,
  type OperationFiveSendAttempt,
  type OperationFiveSendAttemptPair,
  type OperationFiveSendAttemptRow,
  type OperationFiveSendStartedEvent,
  type OperationFiveSendStartedEventRow,
} from "../src/execution_repository";
import {
  authorityRoutingForTest,
  type AuthorityEnv,
} from "../src/index";
import {
  CONTROLLER_ENABLE_COMMAND_CONTRACT,
  START_ENABLE_DISPATCH_SEND_CONTRACT,
  frozenControllerEnableCommandDigest,
  frozenControllerEnableCommandFromReceipt,
  operationFiveGatewayIdempotencyKeyDigest,
  parseStartEnableDispatchSendCommand,
  startControllerEnableDispatchSend,
  type StartEnableDispatchSendCommand,
  type StartEnableDispatchSendDependencies,
  type StartEnableDispatchSendEnv,
} from "../src/start_enable_dispatch_send";
import {
  ProtocolError,
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";
import {
  RepositoryConflictError,
  RepositoryUnavailableError,
} from "../src/repository";

const digest = (value: string): string => value.repeat(64);

async function receipt(): Promise<OperationFiveDispatchConsumptionReceiptRow> {
  const now = Math.floor(Date.now() / 1_000);
  const dispatchClaimWithoutDigest: Omit<
    OperationFiveDispatchClaim,
    "dispatchClaimDigestSha256"
  > = {
    authorizationIdSha256: digest("1"),
    claimContract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1",
    claimDigestSha256: digest("2"),
    applicationTicketIdSha256: digest("3"),
    applicationDatabaseIdentitySha256: digest("4"),
    authorityDispatchOutboxDigestSha256: digest("5"),
    applicationGrantReceiptDigestSha256: digest("6"),
    applicationGrantDigestSha256: digest("7"),
    operationFiveStartReceiptSha256: digest("8"),
    authorityDatabaseIdentitySha256: digest("9"),
    authorityLedgerIdentitySha256: digest("a"),
    authorityLedgerHeadSha256: digest("8"),
    authorityVersionId: "authority-version-1",
    applicationVersionId: "application-version-1",
    dispatchOwnerSha256: digest("b"),
    leaseTokenSha256: digest("c"),
    leaseGeneration: 1,
    leaseExpiresAt: now + 300,
    normalDeadlineAt: now + 400,
    permitExpiresAt: now + 500,
    dispatchClaimCredentialIdSha256: digest("d"),
    dispatchClaimRequestIdSha256: digest("e"),
    commandDispatchClaimRequestIdSha256: digest("f"),
    controllerServiceName: "container-controller-staging",
    controllerEnableOperationIdSha256: digest("0"),
    controllerBaselineVersionId: "controller-baseline-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    claimState: "claimed",
  };
  const dispatchClaimDigestSha256 =
    await operationFiveDispatchClaimDigest(dispatchClaimWithoutDigest);
  const receiptWithoutDigest: Omit<
    OperationFiveDispatchConsumptionReceipt,
    "receiptDigestSha256"
  > = {
    authorizationIdSha256:
      dispatchClaimWithoutDigest.authorizationIdSha256,
    receiptContract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1",
    claimDigestSha256: dispatchClaimWithoutDigest.claimDigestSha256,
    applicationTicketIdSha256:
      dispatchClaimWithoutDigest.applicationTicketIdSha256,
    campaignId: digest("1"),
    applicationDatabaseIdentitySha256:
      dispatchClaimWithoutDigest.applicationDatabaseIdentitySha256,
    applicationVersionId:
      dispatchClaimWithoutDigest.applicationVersionId,
    applicationGrantReceiptDigestSha256:
      dispatchClaimWithoutDigest.applicationGrantReceiptDigestSha256,
    applicationGrantDigestSha256:
      dispatchClaimWithoutDigest.applicationGrantDigestSha256,
    authorityDispatchOutboxDigestSha256:
      dispatchClaimWithoutDigest.authorityDispatchOutboxDigestSha256,
    operationFiveStartReceiptSha256:
      dispatchClaimWithoutDigest.operationFiveStartReceiptSha256,
    authorityDispatchClaimDigestSha256:
      dispatchClaimDigestSha256,
    authorityDatabaseIdentitySha256:
      dispatchClaimWithoutDigest.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      dispatchClaimWithoutDigest.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256:
      dispatchClaimWithoutDigest.authorityLedgerHeadSha256,
    authorityVersionId:
      dispatchClaimWithoutDigest.authorityVersionId,
    dispatchOwnerSha256:
      dispatchClaimWithoutDigest.dispatchOwnerSha256,
    leaseTokenSha256: dispatchClaimWithoutDigest.leaseTokenSha256,
    leaseGeneration: 1,
    leaseExpiresAt: dispatchClaimWithoutDigest.leaseExpiresAt,
    normalDeadlineAt: dispatchClaimWithoutDigest.normalDeadlineAt,
    permitExpiresAt: dispatchClaimWithoutDigest.permitExpiresAt,
    dispatchClaimCredentialIdSha256:
      dispatchClaimWithoutDigest.dispatchClaimCredentialIdSha256,
    dispatchClaimRequestIdSha256:
      dispatchClaimWithoutDigest.dispatchClaimRequestIdSha256,
    commandDispatchClaimRequestIdSha256:
      dispatchClaimWithoutDigest.commandDispatchClaimRequestIdSha256,
    authorityDispatchClaimedAt: now - 60,
    controllerServiceName:
      dispatchClaimWithoutDigest.controllerServiceName,
    controllerEnableOperationIdSha256:
      dispatchClaimWithoutDigest.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      dispatchClaimWithoutDigest.controllerBaselineVersionId,
    controllerEnabledVersionId:
      dispatchClaimWithoutDigest.controllerEnabledVersionId,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    applicationDispatchConsumptionDigestSha256: digest("2"),
    applicationDispatchConsumptionCredentialIdSha256: digest("3"),
    applicationDispatchConsumptionRequestIdSha256: digest("4"),
    commandDispatchConsumptionRequestIdSha256: digest("5"),
    applicationConsumptionState: "consumed",
    applicationConsumedAt: now - 30,
    applicationResponseSha256: digest("6"),
    applicationResponseBytes: 1024,
    consumeCredentialIdSha256: digest("7"),
    consumeRequestIdSha256: digest("8"),
    commandConsumeRequestIdSha256: digest("9"),
  };
  return {
    authorization_id_sha256:
      receiptWithoutDigest.authorizationIdSha256,
    contract_version: 1,
    receipt_contract: receiptWithoutDigest.receiptContract,
    claim_digest_sha256: receiptWithoutDigest.claimDigestSha256,
    application_ticket_id_sha256:
      receiptWithoutDigest.applicationTicketIdSha256,
    campaign_id: receiptWithoutDigest.campaignId,
    application_database_identity_sha256:
      receiptWithoutDigest.applicationDatabaseIdentitySha256,
    application_version_id:
      receiptWithoutDigest.applicationVersionId,
    application_grant_receipt_digest_sha256:
      receiptWithoutDigest.applicationGrantReceiptDigestSha256,
    application_grant_digest_sha256:
      receiptWithoutDigest.applicationGrantDigestSha256,
    authority_dispatch_outbox_digest_sha256:
      receiptWithoutDigest.authorityDispatchOutboxDigestSha256,
    operation_five_start_receipt_sha256:
      receiptWithoutDigest.operationFiveStartReceiptSha256,
    authority_dispatch_claim_digest_sha256:
      receiptWithoutDigest.authorityDispatchClaimDigestSha256,
    authority_database_identity_sha256:
      receiptWithoutDigest.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      receiptWithoutDigest.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256:
      receiptWithoutDigest.authorityLedgerHeadSha256,
    authority_version_id: receiptWithoutDigest.authorityVersionId,
    dispatch_owner_sha256: receiptWithoutDigest.dispatchOwnerSha256,
    lease_token_sha256: receiptWithoutDigest.leaseTokenSha256,
    lease_generation: 1,
    lease_expires_at: receiptWithoutDigest.leaseExpiresAt,
    normal_deadline_at: receiptWithoutDigest.normalDeadlineAt,
    permit_expires_at: receiptWithoutDigest.permitExpiresAt,
    dispatch_claim_credential_id_sha256:
      receiptWithoutDigest.dispatchClaimCredentialIdSha256,
    dispatch_claim_request_id_sha256:
      receiptWithoutDigest.dispatchClaimRequestIdSha256,
    command_dispatch_claim_request_id_sha256:
      receiptWithoutDigest.commandDispatchClaimRequestIdSha256,
    authority_dispatch_claimed_at:
      receiptWithoutDigest.authorityDispatchClaimedAt,
    controller_service_name:
      receiptWithoutDigest.controllerServiceName,
    controller_enable_operation_id_sha256:
      receiptWithoutDigest.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      receiptWithoutDigest.controllerBaselineVersionId,
    controller_enabled_version_id:
      receiptWithoutDigest.controllerEnabledVersionId,
    send_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    application_dispatch_consumption_digest_sha256:
      receiptWithoutDigest.applicationDispatchConsumptionDigestSha256,
    application_dispatch_consumption_credential_id_sha256:
      receiptWithoutDigest
        .applicationDispatchConsumptionCredentialIdSha256,
    application_dispatch_consumption_request_id_sha256:
      receiptWithoutDigest.applicationDispatchConsumptionRequestIdSha256,
    command_dispatch_consumption_request_id_sha256:
      receiptWithoutDigest.commandDispatchConsumptionRequestIdSha256,
    application_consumption_state: "consumed",
    application_consumed_at:
      receiptWithoutDigest.applicationConsumedAt,
    application_response_sha256:
      receiptWithoutDigest.applicationResponseSha256,
    application_response_bytes:
      receiptWithoutDigest.applicationResponseBytes,
    consume_credential_id_sha256:
      receiptWithoutDigest.consumeCredentialIdSha256,
    consume_request_id_sha256:
      receiptWithoutDigest.consumeRequestIdSha256,
    command_consume_request_id_sha256:
      receiptWithoutDigest.commandConsumeRequestIdSha256,
    receipt_digest_sha256:
      await operationFiveDispatchConsumptionReceiptDigest(
        receiptWithoutDigest,
      ),
    recorded_at: now - 20,
  };
}

async function command(
  source: OperationFiveDispatchConsumptionReceiptRow,
): Promise<StartEnableDispatchSendCommand> {
  const controllerCommandDigestSha256 =
    await frozenControllerEnableCommandDigest(
      frozenControllerEnableCommandFromReceipt(source),
    );
  return {
    schemaVersion: 1,
    contract: START_ENABLE_DISPATCH_SEND_CONTRACT,
    authorizationIdSha256: source.authorization_id_sha256,
    claimDigestSha256: source.claim_digest_sha256,
    dispatchOwnerSha256: source.dispatch_owner_sha256,
    dispatchClaimDigestSha256:
      source.authority_dispatch_claim_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      source.receipt_digest_sha256,
    controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      await operationFiveGatewayIdempotencyKeyDigest({
        authorizationIdSha256: source.authorization_id_sha256,
        dispatchConsumptionReceiptDigestSha256:
          source.receipt_digest_sha256,
        controllerCommandDigestSha256,
        controllerEnableOperationIdSha256:
          source.controller_enable_operation_id_sha256,
      }),
    sendAttemptRequestIdSha256: digest("a"),
  };
}

function authentication(): AuthenticatedRequest {
  return {
    role: "send",
    credentialIdSha256: digest("b"),
    keyId: "send-hmac-v1",
    bodySha256: digest("c"),
    requestId: "operation-five-send-attempt-route-1",
  };
}

function env(
  source: OperationFiveDispatchConsumptionReceiptRow,
): StartEnableDispatchSendEnv {
  return {
    DB: {} as D1Database,
    SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED: "true",
    SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256:
      source.application_database_identity_sha256,
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256:
      source.authority_database_identity_sha256,
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256:
      source.authority_ledger_identity_sha256,
  };
}

function pair(
  attempt: OperationFiveSendAttempt,
  event: OperationFiveSendStartedEvent,
): OperationFiveSendAttemptPair {
  const now = Math.floor(Date.now() / 1_000);
  const attemptRow: OperationFiveSendAttemptRow = {
    authorization_id_sha256: attempt.authorizationIdSha256,
    contract_version: 1,
    attempt_contract: attempt.attemptContract,
    attempt_generation: 1,
    retry_count: 0,
    retry_limit: 0,
    send_attempt_limit: 1,
    send_authority_state: "granted",
    claim_digest_sha256: attempt.claimDigestSha256,
    authority_dispatch_claim_digest_sha256:
      attempt.authorityDispatchClaimDigestSha256,
    dispatch_consumption_receipt_digest_sha256:
      attempt.dispatchConsumptionReceiptDigestSha256,
    application_dispatch_consumption_digest_sha256:
      attempt.applicationDispatchConsumptionDigestSha256,
    application_ticket_id_sha256: attempt.applicationTicketIdSha256,
    campaign_id: attempt.campaignId,
    application_database_identity_sha256:
      attempt.applicationDatabaseIdentitySha256,
    application_version_id: attempt.applicationVersionId,
    authority_database_identity_sha256:
      attempt.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      attempt.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256:
      attempt.authorityLedgerHeadSha256,
    authority_version_id: attempt.authorityVersionId,
    dispatch_owner_sha256: attempt.dispatchOwnerSha256,
    lease_token_sha256: attempt.leaseTokenSha256,
    lease_generation: 1,
    controller_service_name: attempt.controllerServiceName,
    controller_enable_operation_id_sha256:
      attempt.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      attempt.controllerBaselineVersionId,
    controller_enabled_version_id:
      attempt.controllerEnabledVersionId,
    controller_command_contract: attempt.controllerCommandContract,
    controller_command_digest_sha256:
      attempt.controllerCommandDigestSha256,
    gateway_idempotency_contract: attempt.gatewayIdempotencyContract,
    gateway_idempotency_key_sha256:
      attempt.gatewayIdempotencyKeySha256,
    send_credential_id_sha256: attempt.sendCredentialIdSha256,
    send_request_id_sha256: attempt.sendRequestIdSha256,
    command_send_attempt_request_id_sha256:
      attempt.commandSendAttemptRequestIdSha256,
    controller_request_sent: 0,
    gateway_request_sent: 0,
    attempt_digest_sha256: attempt.attemptDigestSha256,
    created_at: now,
  };
  const eventRow: OperationFiveSendStartedEventRow = {
    authorization_id_sha256: event.authorizationIdSha256,
    attempt_digest_sha256: event.attemptDigestSha256,
    event_sequence: 1,
    contract_version: 1,
    event_contract: event.eventContract,
    event_kind: "send_started",
    from_state: "consumption_receipted",
    to_state: "send_started",
    event_semantics:
      "unique_send_authority_persisted_network_may_not_have_occurred",
    predecessor_event_digest_sha256: digest("0"),
    dispatch_consumption_receipt_digest_sha256:
      event.dispatchConsumptionReceiptDigestSha256,
    controller_command_digest_sha256:
      event.controllerCommandDigestSha256,
    gateway_idempotency_key_sha256:
      event.gatewayIdempotencyKeySha256,
    controller_request_sent: 0,
    gateway_request_sent: 0,
    event_digest_sha256: event.eventDigestSha256,
    recorded_at: now,
  };
  return { attempt: attemptRow, event: eventRow };
}

function dependencies(
  source: OperationFiveDispatchConsumptionReceiptRow,
  classification: "created" | "exact_replay" = "created",
): StartEnableDispatchSendDependencies {
  return {
    readReceipt: vi.fn().mockResolvedValue(source),
    readRecovery: vi.fn().mockResolvedValue(null),
    createPair: vi.fn(
      async (
        _database: D1Database,
        attempt: OperationFiveSendAttempt,
        event: OperationFiveSendStartedEvent,
      ) => ({
        classification,
        pair: pair(attempt, event),
      }),
    ),
  };
}

describe("operation-5 send attempt boundary", () => {
  it("parses only bounded canonical commands", async () => {
    const source = await receipt();
    const input = await command(source);
    const body = new TextEncoder().encode(canonicalJson(input));
    expect(parseStartEnableDispatchSendCommand(body)).toEqual(input);
    expect(() =>
      parseStartEnableDispatchSendCommand(
        new TextEncoder().encode(JSON.stringify(input, null, 2)),
      )
    ).toThrowError("noncanonical_json");
    expect(() =>
      parseStartEnableDispatchSendCommand(
        new Uint8Array(4097).fill(32),
      )
    ).toThrowError("operation_five_send_attempt_command_too_large");
  });

  it("creates one frozen pair and reports zero external requests", async () => {
    const source = await receipt();
    const input = await command(source);
    const deps = dependencies(source);
    const result = await startControllerEnableDispatchSend(
      env(source),
      input,
      authentication(),
      deps,
    );
    expect(result).toMatchObject({
      result: "send_attempt_created",
      authorizationIdSha256: source.authorization_id_sha256,
      attemptGeneration: 1,
      retryLimit: 0,
      sendAttemptLimit: 1,
      sendAttemptCreated: true,
      controllerRequestSent: false,
      gatewayRequestSent: false,
    });
    expect(result.attemptDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sendStartedEventDigestSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(deps.createPair).toHaveBeenCalledOnce();
    const [, attempt, event] =
      vi.mocked(deps.createPair).mock.calls[0]!;
    expect(attempt).toMatchObject({
      attemptGeneration: 1,
      retryCount: 0,
      retryLimit: 0,
      sendAttemptLimit: 1,
      controllerCommandContract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
      controllerRequestSent: 0,
      gatewayRequestSent: 0,
    });
    expect(event).toMatchObject({
      eventSequence: 1,
      eventKind: "send_started",
      eventSemantics:
        "unique_send_authority_persisted_network_may_not_have_occurred",
      predecessorEventDigestSha256: digest("0"),
      controllerRequestSent: 0,
      gatewayRequestSent: 0,
    });
  });

  it("maps exact and unknown-result readback to no new send authority", async () => {
    const source = await receipt();
    const input = await command(source);
    const deps = dependencies(source, "exact_replay");
    const result = await startControllerEnableDispatchSend(
      env(source),
      input,
      authentication(),
      deps,
    );
    expect(result).toMatchObject({
      result: "exact_replay",
      sendAttemptCreated: false,
      controllerRequestSent: false,
      gatewayRequestSent: false,
    });

    const [, attempt, event] =
      vi.mocked(deps.createPair).mock.calls[0]!;
    const persisted = pair(attempt, event);
    expect(
      operationFiveSendAttemptRepositoryForTest.classifyReadback(
        "unknown",
        persisted,
        attempt,
        event,
      ),
    ).toMatchObject({
      classification: "exact_replay",
      pair: persisted,
    });
    expect(
      operationFiveSendAttemptRepositoryForTest.classifyReadback(
        "failed",
        persisted,
        attempt,
        event,
      ),
    ).toMatchObject({ classification: "exact_replay" });
  });

  it("rejects missing or historically recovered receipt evidence", async () => {
    const source = await receipt();
    const input = await command(source);
    const missing = dependencies(source);
    vi.mocked(missing.readReceipt).mockResolvedValue(null);
    await expect(
      startControllerEnableDispatchSend(
        env(source),
        input,
        authentication(),
        missing,
      ),
    ).rejects.toMatchObject({
      code: "operation_five_dispatch_consumption_receipt_missing",
      status: 409,
    });
    expect(missing.createPair).not.toHaveBeenCalled();

    const recovered = dependencies(source);
    vi.mocked(recovered.readRecovery).mockResolvedValue({});
    await expect(
      startControllerEnableDispatchSend(
        env(source),
        input,
        authentication(),
        recovered,
      ),
    ).rejects.toMatchObject({
      code:
        "operation_five_send_attempt_recovered_consumption_forbidden",
      status: 409,
    });
    expect(recovered.createPair).not.toHaveBeenCalled();
  });

  it("rejects direct orchestration calls without the send HMAC role", async () => {
    const source = await receipt();
    const input = await command(source);
    const deps = dependencies(source);
    await expect(
      startControllerEnableDispatchSend(
        env(source),
        input,
        {
          ...authentication(),
          role: "recovery",
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "operation_five_send_attempt_role_mismatch",
      status: 403,
    });
    expect(deps.readReceipt).not.toHaveBeenCalled();
    expect(deps.createPair).not.toHaveBeenCalled();
  });

  it("fails closed on digest, identity, partial, and mismatched readback", async () => {
    const source = await receipt();
    const input = await command(source);
    const mismatched = {
      ...input,
      controllerCommandDigestSha256: digest("f"),
    };
    const deps = dependencies(source);
    await expect(
      startControllerEnableDispatchSend(
        env(source),
        mismatched,
        authentication(),
        deps,
      ),
    ).rejects.toMatchObject({
      code: "operation_five_controller_command_digest_mismatch",
      status: 409,
    });
    expect(deps.createPair).not.toHaveBeenCalled();

    const badEnv = env(source);
    badEnv.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256 =
      digest("f");
    await expect(
      startControllerEnableDispatchSend(
        badEnv,
        input,
        authentication(),
        dependencies(source),
      ),
    ).rejects.toMatchObject({
      code: "operation_five_send_attempt_source_mismatch",
      status: 409,
    });

    expect(() =>
      operationFiveSendAttemptRepositoryForTest.assemblePair(
        {} as OperationFiveSendAttemptRow,
        null,
      )
    ).toThrow(RepositoryUnavailableError);

    const capture = dependencies(source);
    await startControllerEnableDispatchSend(
      env(source),
      input,
      authentication(),
      capture,
    );
    const [, attempt, event] =
      vi.mocked(capture.createPair).mock.calls[0]!;
    const persisted = pair(attempt, event);
    persisted.event.event_digest_sha256 = digest("f");
    expect(() =>
      operationFiveSendAttemptRepositoryForTest.classifyReadback(
        "failed",
        persisted,
        attempt,
        event,
      )
    ).toThrow(RepositoryConflictError);
  });

  it("keeps the private route on send HMAC and its own default-off gate", () => {
    const authorizationIdSha256 = digest("1");
    const request = new Request(
      `https://authority.test/internal/v1/shard-placement/execution-claims/${authorizationIdSha256}/start-enable-dispatch-send`,
      { method: "POST" },
    );
    expect(authorityRoutingForTest.match(request)).toEqual({
      kind: "execution_start_enable_dispatch_send",
      role: "send",
    });
    expect(() =>
      authorityRoutingForTest.requireGate(
        "execution_start_enable_dispatch_send",
        {
          SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED:
            "false",
        } as AuthorityEnv,
      )
    ).toThrow(ProtocolError);
  });
});
