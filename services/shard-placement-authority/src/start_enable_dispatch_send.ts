import { operationFiveDispatchClaimDigest } from "./claim_enable_dispatch";
import {
  operationFiveDispatchConsumptionReceiptDigest,
} from "./consume_enable_dispatch";
import {
  createOperationFiveSendAttemptPair,
  readExactOperationFiveDispatchConsumption,
  readExactOperationFiveDispatchConsumptionRecovery,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchConsumptionReceipt,
  type OperationFiveDispatchConsumptionReceiptRow,
  type OperationFiveSendAttempt,
  type OperationFiveSendAttemptPair,
  type OperationFiveSendStartedEvent,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const START_ENABLE_DISPATCH_SEND_CONTRACT =
  "cinatoken-shard-placement-authority-start-enable-dispatch-send-v1";
export const OPERATION_FIVE_SEND_ATTEMPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-send-attempt-v1";
export const OPERATION_FIVE_SEND_ATTEMPT_EVENT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1";
export const CONTROLLER_ENABLE_COMMAND_CONTRACT =
  "cinatoken-controller-deployment-gateway-enable-command-v1";
export const GATEWAY_IDEMPOTENCY_CONTRACT =
  "cinatoken-controller-deployment-gateway-idempotency-v1";
export const SEND_STARTED_EVENT_SEMANTICS =
  "unique_send_authority_persisted_network_may_not_have_occurred";
export const ZERO_EVENT_DIGEST_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000";

const MAX_COMMAND_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "dispatchOwnerSha256",
  "dispatchClaimDigestSha256",
  "dispatchConsumptionReceiptDigestSha256",
  "controllerCommandDigestSha256",
  "gatewayIdempotencyKeySha256",
  "sendAttemptRequestIdSha256",
] as const;

export interface StartEnableDispatchSendCommand {
  schemaVersion: 1;
  contract: typeof START_ENABLE_DISPATCH_SEND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchOwnerSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  sendAttemptRequestIdSha256: string;
}

export interface FrozenControllerEnableCommand {
  schemaVersion: 1;
  contract: typeof CONTROLLER_ENABLE_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  applicationTicketIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
}

export interface StartEnableDispatchSendEnv {
  DB: D1Database;
  SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
}

export interface StartEnableDispatchSendResult {
  result: "send_attempt_created" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  attemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  attemptGeneration: 1;
  retryLimit: 0;
  sendAttemptLimit: 1;
  sendAttemptCreated: boolean;
  controllerRequestSent: false;
  gatewayRequestSent: false;
}

export interface StartEnableDispatchSendDependencies {
  readReceipt(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveDispatchConsumptionReceiptRow | null>;
  readRecovery(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<unknown | null>;
  createPair(
    database: D1Database,
    attempt: OperationFiveSendAttempt,
    event: OperationFiveSendStartedEvent,
  ): Promise<{
    classification: "created" | "exact_replay";
    pair: OperationFiveSendAttemptPair;
  }>;
}

const DEFAULT_DEPENDENCIES: StartEnableDispatchSendDependencies = {
  readReceipt: readExactOperationFiveDispatchConsumption,
  readRecovery: readExactOperationFiveDispatchConsumptionRecovery,
  createPair: createOperationFiveSendAttemptPair,
};

export function parseStartEnableDispatchSendCommand(
  body: Uint8Array,
): StartEnableDispatchSendCommand {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    throw new ProtocolError(
      "operation_five_send_attempt_command_too_large",
      413,
    );
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new ProtocolError("noncanonical_json", 400);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_json", 400);
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...COMMAND_FIELDS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      START_ENABLE_DISPATCH_SEND_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    dispatchOwnerSha256: requireSha256(object.dispatchOwnerSha256),
    dispatchClaimDigestSha256: requireSha256(
      object.dispatchClaimDigestSha256,
    ),
    dispatchConsumptionReceiptDigestSha256: requireSha256(
      object.dispatchConsumptionReceiptDigestSha256,
    ),
    controllerCommandDigestSha256: requireSha256(
      object.controllerCommandDigestSha256,
    ),
    gatewayIdempotencyKeySha256: requireSha256(
      object.gatewayIdempotencyKeySha256,
    ),
    sendAttemptRequestIdSha256: requireSha256(
      object.sendAttemptRequestIdSha256,
    ),
  };
}

export async function startControllerEnableDispatchSend(
  env: StartEnableDispatchSendEnv,
  command: StartEnableDispatchSendCommand,
  authentication: AuthenticatedRequest,
  dependencies: StartEnableDispatchSendDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<StartEnableDispatchSendResult> {
  const startedAt = Date.now();
  if (authentication.role !== "send") {
    throw new ProtocolError(
      "operation_five_send_attempt_role_mismatch",
      403,
    );
  }
  if (
    env.SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_send_attempt_write_disabled",
      503,
    );
  }

  const receipt = await dependencies.readReceipt(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (receipt === null) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_receipt_missing",
      409,
    );
  }
  if (
    await dependencies.readRecovery(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
    ) !== null
  ) {
    throw new ProtocolError(
      "operation_five_send_attempt_recovered_consumption_forbidden",
      409,
    );
  }

  await requireExactReceiptSource(env, command, receipt);
  const frozenControllerCommand =
    frozenControllerEnableCommandFromReceipt(receipt);
  const controllerCommandDigestSha256 =
    await frozenControllerEnableCommandDigest(frozenControllerCommand);
  if (
    controllerCommandDigestSha256
      !== command.controllerCommandDigestSha256
  ) {
    throw new ProtocolError(
      "operation_five_controller_command_digest_mismatch",
      409,
    );
  }
  const gatewayIdempotencyKeySha256 =
    await operationFiveGatewayIdempotencyKeyDigest({
      authorizationIdSha256: receipt.authorization_id_sha256,
      dispatchConsumptionReceiptDigestSha256:
        receipt.receipt_digest_sha256,
      controllerCommandDigestSha256,
      controllerEnableOperationIdSha256:
        receipt.controller_enable_operation_id_sha256,
    });
  if (
    gatewayIdempotencyKeySha256
      !== command.gatewayIdempotencyKeySha256
  ) {
    throw new ProtocolError(
      "operation_five_gateway_idempotency_digest_mismatch",
      409,
    );
  }

  const sendRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const attemptWithoutDigest: Omit<
    OperationFiveSendAttempt,
    "attemptDigestSha256"
  > = {
    authorizationIdSha256: receipt.authorization_id_sha256,
    attemptContract: OPERATION_FIVE_SEND_ATTEMPT_CONTRACT,
    attemptGeneration: 1,
    retryCount: 0,
    retryLimit: 0,
    sendAttemptLimit: 1,
    sendAuthorityState: "granted",
    claimDigestSha256: receipt.claim_digest_sha256,
    authorityDispatchClaimDigestSha256:
      receipt.authority_dispatch_claim_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      receipt.receipt_digest_sha256,
    applicationDispatchConsumptionDigestSha256:
      receipt.application_dispatch_consumption_digest_sha256,
    applicationTicketIdSha256: receipt.application_ticket_id_sha256,
    campaignId: receipt.campaign_id,
    applicationDatabaseIdentitySha256:
      receipt.application_database_identity_sha256,
    applicationVersionId: receipt.application_version_id,
    authorityDatabaseIdentitySha256:
      receipt.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      receipt.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256:
      receipt.authority_ledger_head_sha256,
    authorityVersionId: receipt.authority_version_id,
    dispatchOwnerSha256: receipt.dispatch_owner_sha256,
    leaseTokenSha256: receipt.lease_token_sha256,
    leaseGeneration: 1,
    controllerServiceName: receipt.controller_service_name,
    controllerEnableOperationIdSha256:
      receipt.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      receipt.controller_baseline_version_id,
    controllerEnabledVersionId:
      receipt.controller_enabled_version_id,
    controllerCommandContract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    controllerCommandDigestSha256,
    gatewayIdempotencyContract: GATEWAY_IDEMPOTENCY_CONTRACT,
    gatewayIdempotencyKeySha256,
    sendCredentialIdSha256: authentication.credentialIdSha256,
    sendRequestIdSha256,
    commandSendAttemptRequestIdSha256:
      command.sendAttemptRequestIdSha256,
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
  };
  const attempt: OperationFiveSendAttempt = {
    ...attemptWithoutDigest,
    attemptDigestSha256:
      await operationFiveSendAttemptDigest(attemptWithoutDigest),
  };
  const eventWithoutDigest: Omit<
    OperationFiveSendStartedEvent,
    "eventDigestSha256"
  > = {
    authorizationIdSha256: attempt.authorizationIdSha256,
    attemptDigestSha256: attempt.attemptDigestSha256,
    eventSequence: 1,
    eventContract: OPERATION_FIVE_SEND_ATTEMPT_EVENT_CONTRACT,
    eventKind: "send_started",
    fromState: "consumption_receipted",
    toState: "send_started",
    eventSemantics: SEND_STARTED_EVENT_SEMANTICS,
    predecessorEventDigestSha256: ZERO_EVENT_DIGEST_SHA256,
    dispatchConsumptionReceiptDigestSha256:
      attempt.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256:
      attempt.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      attempt.gatewayIdempotencyKeySha256,
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
  };
  const event: OperationFiveSendStartedEvent = {
    ...eventWithoutDigest,
    eventDigestSha256:
      await operationFiveSendStartedEventDigest(eventWithoutDigest),
  };
  const persisted = await dependencies.createPair(
    env.DB,
    attempt,
    event,
  );
  const result = sendAttemptResult(persisted.classification, persisted.pair);
  recordSendAttemptObservation(result, Date.now() - startedAt);
  return result;
}

export async function frozenControllerEnableCommandDigest(
  command: FrozenControllerEnableCommand,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(command)),
  );
}

export async function operationFiveGatewayIdempotencyKeyDigest(
  input: {
    authorizationIdSha256: string;
    dispatchConsumptionReceiptDigestSha256: string;
    controllerCommandDigestSha256: string;
    controllerEnableOperationIdSha256: string;
  },
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: GATEWAY_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    ...input,
  })));
}

export async function operationFiveSendAttemptDigest(
  attempt: Omit<OperationFiveSendAttempt, "attemptDigestSha256">,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    ...attempt,
  })));
}

export async function operationFiveSendStartedEventDigest(
  event: Omit<OperationFiveSendStartedEvent, "eventDigestSha256">,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    ...event,
  })));
}

export function frozenControllerEnableCommandFromReceipt(
  receipt: OperationFiveDispatchConsumptionReceiptRow,
): FrozenControllerEnableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    authorizationIdSha256: receipt.authorization_id_sha256,
    claimDigestSha256: receipt.claim_digest_sha256,
    dispatchClaimDigestSha256:
      receipt.authority_dispatch_claim_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      receipt.receipt_digest_sha256,
    applicationDispatchConsumptionDigestSha256:
      receipt.application_dispatch_consumption_digest_sha256,
    applicationTicketIdSha256: receipt.application_ticket_id_sha256,
    campaignId: receipt.campaign_id,
    applicationDatabaseIdentitySha256:
      receipt.application_database_identity_sha256,
    applicationVersionId: receipt.application_version_id,
    authorityDatabaseIdentitySha256:
      receipt.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      receipt.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256:
      receipt.authority_ledger_head_sha256,
    authorityVersionId: receipt.authority_version_id,
    dispatchOwnerSha256: receipt.dispatch_owner_sha256,
    leaseTokenSha256: receipt.lease_token_sha256,
    leaseGeneration: 1,
    controllerServiceName: receipt.controller_service_name,
    controllerEnableOperationIdSha256:
      receipt.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      receipt.controller_baseline_version_id,
    controllerEnabledVersionId:
      receipt.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

async function requireExactReceiptSource(
  env: StartEnableDispatchSendEnv,
  command: StartEnableDispatchSendCommand,
  receipt: OperationFiveDispatchConsumptionReceiptRow,
): Promise<void> {
  if (
    receipt.contract_version !== 1
    || receipt.receipt_contract
      !== "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1"
    || receipt.authorization_id_sha256
      !== command.authorizationIdSha256
    || receipt.claim_digest_sha256 !== command.claimDigestSha256
    || receipt.dispatch_owner_sha256 !== command.dispatchOwnerSha256
    || receipt.authority_dispatch_claim_digest_sha256
      !== command.dispatchClaimDigestSha256
    || receipt.receipt_digest_sha256
      !== command.dispatchConsumptionReceiptDigestSha256
    || receipt.application_database_identity_sha256
      !== env.SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256
    || receipt.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || receipt.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || receipt.lease_generation !== 1
    || receipt.send_attempt_limit !== 1
    || receipt.retry_limit !== 0
    || receipt.missing_readback_allows_resend !== 0
    || receipt.application_consumption_state !== "consumed"
    || receipt.recorded_at <= 0
  ) {
    throw new ProtocolError(
      "operation_five_send_attempt_source_mismatch",
      409,
    );
  }
  const receiptCandidate = dispatchConsumptionReceiptFromRow(receipt);
  if (
    await operationFiveDispatchConsumptionReceiptDigest(receiptCandidate)
      !== receipt.receipt_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_receipt_digest_mismatch",
      409,
    );
  }
  const dispatchClaim = dispatchClaimFromReceipt(receipt);
  if (
    await operationFiveDispatchClaimDigest(dispatchClaim)
      !== receipt.authority_dispatch_claim_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_digest_mismatch",
      409,
    );
  }
}

function dispatchConsumptionReceiptFromRow(
  row: OperationFiveDispatchConsumptionReceiptRow,
): Omit<OperationFiveDispatchConsumptionReceipt, "receiptDigestSha256"> {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    receiptContract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1",
    claimDigestSha256: row.claim_digest_sha256,
    applicationTicketIdSha256: row.application_ticket_id_sha256,
    campaignId: row.campaign_id,
    applicationDatabaseIdentitySha256:
      row.application_database_identity_sha256,
    applicationVersionId: row.application_version_id,
    applicationGrantReceiptDigestSha256:
      row.application_grant_receipt_digest_sha256,
    applicationGrantDigestSha256:
      row.application_grant_digest_sha256,
    authorityDispatchOutboxDigestSha256:
      row.authority_dispatch_outbox_digest_sha256,
    operationFiveStartReceiptSha256:
      row.operation_five_start_receipt_sha256,
    authorityDispatchClaimDigestSha256:
      row.authority_dispatch_claim_digest_sha256,
    authorityDatabaseIdentitySha256:
      row.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      row.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256: row.authority_ledger_head_sha256,
    authorityVersionId: row.authority_version_id,
    dispatchOwnerSha256: row.dispatch_owner_sha256,
    leaseTokenSha256: row.lease_token_sha256,
    leaseGeneration: 1,
    leaseExpiresAt: row.lease_expires_at,
    normalDeadlineAt: row.normal_deadline_at,
    permitExpiresAt: row.permit_expires_at,
    dispatchClaimCredentialIdSha256:
      row.dispatch_claim_credential_id_sha256,
    dispatchClaimRequestIdSha256:
      row.dispatch_claim_request_id_sha256,
    commandDispatchClaimRequestIdSha256:
      row.command_dispatch_claim_request_id_sha256,
    authorityDispatchClaimedAt: row.authority_dispatch_claimed_at,
    controllerServiceName: row.controller_service_name,
    controllerEnableOperationIdSha256:
      row.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      row.controller_baseline_version_id,
    controllerEnabledVersionId:
      row.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    applicationDispatchConsumptionDigestSha256:
      row.application_dispatch_consumption_digest_sha256,
    applicationDispatchConsumptionCredentialIdSha256:
      row.application_dispatch_consumption_credential_id_sha256,
    applicationDispatchConsumptionRequestIdSha256:
      row.application_dispatch_consumption_request_id_sha256,
    commandDispatchConsumptionRequestIdSha256:
      row.command_dispatch_consumption_request_id_sha256,
    applicationConsumptionState: "consumed",
    applicationConsumedAt: row.application_consumed_at,
    applicationResponseSha256: row.application_response_sha256,
    applicationResponseBytes: row.application_response_bytes,
    consumeCredentialIdSha256: row.consume_credential_id_sha256,
    consumeRequestIdSha256: row.consume_request_id_sha256,
    commandConsumeRequestIdSha256:
      row.command_consume_request_id_sha256,
  };
}

function dispatchClaimFromReceipt(
  row: OperationFiveDispatchConsumptionReceiptRow,
): Omit<OperationFiveDispatchClaim, "dispatchClaimDigestSha256"> {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    claimContract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1",
    claimDigestSha256: row.claim_digest_sha256,
    applicationTicketIdSha256: row.application_ticket_id_sha256,
    applicationDatabaseIdentitySha256:
      row.application_database_identity_sha256,
    authorityDispatchOutboxDigestSha256:
      row.authority_dispatch_outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      row.application_grant_receipt_digest_sha256,
    applicationGrantDigestSha256:
      row.application_grant_digest_sha256,
    operationFiveStartReceiptSha256:
      row.operation_five_start_receipt_sha256,
    authorityDatabaseIdentitySha256:
      row.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      row.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256: row.authority_ledger_head_sha256,
    authorityVersionId: row.authority_version_id,
    applicationVersionId: row.application_version_id,
    dispatchOwnerSha256: row.dispatch_owner_sha256,
    leaseTokenSha256: row.lease_token_sha256,
    leaseGeneration: 1,
    leaseExpiresAt: row.lease_expires_at,
    normalDeadlineAt: row.normal_deadline_at,
    permitExpiresAt: row.permit_expires_at,
    dispatchClaimCredentialIdSha256:
      row.dispatch_claim_credential_id_sha256,
    dispatchClaimRequestIdSha256:
      row.dispatch_claim_request_id_sha256,
    commandDispatchClaimRequestIdSha256:
      row.command_dispatch_claim_request_id_sha256,
    controllerServiceName: row.controller_service_name,
    controllerEnableOperationIdSha256:
      row.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      row.controller_baseline_version_id,
    controllerEnabledVersionId:
      row.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    claimState: "claimed",
  };
}

function sendAttemptResult(
  classification: "created" | "exact_replay",
  pair: OperationFiveSendAttemptPair,
): StartEnableDispatchSendResult {
  return {
    result: classification === "created"
      ? "send_attempt_created"
      : "exact_replay",
    authorizationIdSha256: pair.attempt.authorization_id_sha256,
    claimDigestSha256: pair.attempt.claim_digest_sha256,
    dispatchClaimDigestSha256:
      pair.attempt.authority_dispatch_claim_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      pair.attempt.dispatch_consumption_receipt_digest_sha256,
    attemptDigestSha256: pair.attempt.attempt_digest_sha256,
    sendStartedEventDigestSha256: pair.event.event_digest_sha256,
    controllerCommandDigestSha256:
      pair.attempt.controller_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      pair.attempt.gateway_idempotency_key_sha256,
    attemptGeneration: 1,
    retryLimit: 0,
    sendAttemptLimit: 1,
    sendAttemptCreated: classification === "created",
    controllerRequestSent: false,
    gatewayRequestSent: false,
  };
}

function recordSendAttemptObservation(
  result: StartEnableDispatchSendResult,
  elapsedMilliseconds: number,
): void {
  console.info(JSON.stringify({
    event: "shard_placement.operation_five_send_attempt",
    result: result.result,
    authorizationIdSha256: result.authorizationIdSha256,
    claimDigestSha256: result.claimDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      result.dispatchConsumptionReceiptDigestSha256,
    attemptDigestSha256: result.attemptDigestSha256,
    sendStartedEventDigestSha256:
      result.sendStartedEventDigestSha256,
    sendAttemptCreated: result.sendAttemptCreated,
    controllerRequestSent: false,
    gatewayRequestSent: false,
    elapsedMilliseconds,
  }));
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}
