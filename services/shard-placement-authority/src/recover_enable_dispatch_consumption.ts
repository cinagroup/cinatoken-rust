import {
  readHistoricalApplicationDispatchConsumption,
  type ApplicationDispatchConsumptionHistoryClientEnv,
  type HistoricalApplicationDispatchConsumptionReadback,
} from "./application_dispatch_consumption_history_client";
import { operationFiveDispatchClaimDigest } from "./claim_enable_dispatch";
import {
  createRecoveredOperationFiveDispatchConsumption,
  readExactOperationFiveDispatchClaim,
  readExactOperationFiveDispatchConsumption,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchClaimRow,
  type OperationFiveDispatchConsumptionReceipt,
  type OperationFiveDispatchConsumptionReceiptRow,
  type OperationFiveDispatchConsumptionRecoveryEvidence,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  operationFiveDispatchConsumptionReceiptDigest,
} from "./consume_enable_dispatch";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const RECOVER_ENABLE_DISPATCH_CONSUMPTION_CONTRACT =
  "cinatoken-shard-placement-authority-recover-enable-dispatch-consumption-v1";
export const OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-recovery-v1";
const OPERATION_FIVE_DISPATCH_CONSUMPTION_RECEIPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1";
const OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1";
const COMMAND_LIMIT_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "dispatchClaimDigestSha256",
  "dispatchConsumptionRequestIdSha256",
  "recoveryRequestIdSha256",
] as const;

export interface RecoverEnableDispatchConsumptionCommand {
  schemaVersion: 1;
  contract: typeof RECOVER_ENABLE_DISPATCH_CONSUMPTION_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionRequestIdSha256: string;
  recoveryRequestIdSha256: string;
}

export interface RecoverEnableDispatchConsumptionEnv
  extends ApplicationDispatchConsumptionHistoryClientEnv {
  DB: D1Database;
  SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
}

export interface RecoverEnableDispatchConsumptionResult {
  result: "dispatch_consumption_receipt_recovered" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  recoveryEvidenceDigestSha256: string | null;
  applicationVersionId: string;
  authorityVersionId: string;
  controllerEnableOperationIdSha256: string;
  retentionDeadlineAt: number | null;
  receiptCount: 4;
  receiptHeadSha256: string;
  sendAttemptCreated: false;
  controllerRequestSent: false;
}

export interface RecoverEnableDispatchConsumptionDependencies {
  readDispatchClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveDispatchClaimRow | null>;
  readReceipt(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveDispatchConsumptionReceiptRow | null>;
  readApplicationHistory(
    env: ApplicationDispatchConsumptionHistoryClientEnv,
    dispatchClaim: OperationFiveDispatchClaimRow,
    dispatchConsumptionRequestIdSha256: string,
    recoveryRequestIdSha256: string,
  ): Promise<HistoricalApplicationDispatchConsumptionReadback>;
  createRecoveredReceipt(
    database: D1Database,
    receipt: OperationFiveDispatchConsumptionReceipt,
    recovery: OperationFiveDispatchConsumptionRecoveryEvidence,
  ): Promise<{
    classification: "recorded" | "exact_replay";
    receipt: OperationFiveDispatchConsumptionReceiptRow;
    recovery: {
      recovery_evidence_digest_sha256: string;
      retention_deadline_at: number;
    } | null;
  }>;
}

const DEFAULT_DEPENDENCIES: RecoverEnableDispatchConsumptionDependencies = {
  readDispatchClaim: readExactOperationFiveDispatchClaim,
  readReceipt: readExactOperationFiveDispatchConsumption,
  readApplicationHistory: readHistoricalApplicationDispatchConsumption,
  createRecoveredReceipt:
    createRecoveredOperationFiveDispatchConsumption,
};

export function parseRecoverEnableDispatchConsumptionCommand(
  body: Uint8Array,
): RecoverEnableDispatchConsumptionCommand {
  if (body.byteLength === 0 || body.byteLength > COMMAND_LIMIT_BYTES) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_recovery_command_too_large",
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
      RECOVER_ENABLE_DISPATCH_CONSUMPTION_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    dispatchClaimDigestSha256: requireSha256(
      object.dispatchClaimDigestSha256,
    ),
    dispatchConsumptionRequestIdSha256: requireSha256(
      object.dispatchConsumptionRequestIdSha256,
    ),
    recoveryRequestIdSha256: requireSha256(
      object.recoveryRequestIdSha256,
    ),
  };
}

export async function recoverControllerEnableDispatchConsumption(
  env: RecoverEnableDispatchConsumptionEnv,
  command: RecoverEnableDispatchConsumptionCommand,
  authentication: AuthenticatedRequest,
  dependencies: RecoverEnableDispatchConsumptionDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<RecoverEnableDispatchConsumptionResult> {
  const startedAt = Date.now();
  if (authentication.role !== "recovery") {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_recovery_role_mismatch",
      403,
    );
  }

  const existing = await dependencies.readReceipt(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existing !== null) {
    await requireExactHistoricalReceipt(existing, command);
    const replay = recoveryResult("exact_replay", existing, null, null);
    recordRecoveryObservation(replay, Date.now() - startedAt);
    return replay;
  }

  let dispatchClaim = await dependencies.readDispatchClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (dispatchClaim === null) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_missing",
      409,
    );
  }
  await requireHistoricalDispatchClaimMatches(env, dispatchClaim, command);

  const application = await dependencies.readApplicationHistory(
    env,
    dispatchClaim,
    command.dispatchConsumptionRequestIdSha256,
    command.recoveryRequestIdSha256,
  );

  const initialDispatchClaim = dispatchClaim;
  dispatchClaim = await dependencies.readDispatchClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (dispatchClaim === null) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_missing",
      409,
    );
  }
  if (canonicalJson(initialDispatchClaim) !== canonicalJson(dispatchClaim)) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_changed",
      409,
    );
  }
  await requireHistoricalDispatchClaimMatches(env, dispatchClaim, command);

  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const consumption = application.consumption;
  const receiptWithoutDigest: Omit<
    OperationFiveDispatchConsumptionReceipt,
    "receiptDigestSha256"
  > = {
    authorizationIdSha256: command.authorizationIdSha256,
    receiptContract:
      OPERATION_FIVE_DISPATCH_CONSUMPTION_RECEIPT_CONTRACT,
    claimDigestSha256: command.claimDigestSha256,
    applicationTicketIdSha256: consumption.ticketIdSha256,
    campaignId: consumption.campaignId,
    applicationDatabaseIdentitySha256:
      consumption.applicationDatabaseIdentitySha256,
    applicationVersionId: consumption.applicationVersionId,
    applicationGrantReceiptDigestSha256:
      consumption.applicationGrantReceiptDigestSha256,
    applicationGrantDigestSha256:
      consumption.applicationGrantDigestSha256,
    authorityDispatchOutboxDigestSha256:
      consumption.authorityDispatchOutboxDigestSha256,
    operationFiveStartReceiptSha256:
      consumption.operationFiveStartReceiptSha256,
    authorityDispatchClaimDigestSha256:
      consumption.authorityDispatchClaimDigestSha256,
    authorityDatabaseIdentitySha256:
      consumption.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      consumption.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256:
      consumption.authorityLedgerHeadSha256,
    authorityVersionId: consumption.authorityVersionId,
    dispatchOwnerSha256: consumption.dispatchOwnerSha256,
    leaseTokenSha256: consumption.leaseTokenSha256,
    leaseGeneration: 1,
    leaseExpiresAt: consumption.leaseExpiresAt,
    normalDeadlineAt: consumption.normalDeadlineAt,
    permitExpiresAt: consumption.permitExpiresAt,
    dispatchClaimCredentialIdSha256:
      consumption.dispatchClaimCredentialIdSha256,
    dispatchClaimRequestIdSha256:
      consumption.dispatchClaimRequestIdSha256,
    commandDispatchClaimRequestIdSha256:
      consumption.commandDispatchClaimRequestIdSha256,
    authorityDispatchClaimedAt:
      consumption.authorityDispatchClaimedAt,
    controllerServiceName: consumption.controllerServiceName,
    controllerEnableOperationIdSha256:
      consumption.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      consumption.controllerBaselineVersionId,
    controllerEnabledVersionId:
      consumption.controllerEnabledVersionId,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    applicationDispatchConsumptionDigestSha256:
      consumption.dispatchConsumptionDigestSha256,
    applicationDispatchConsumptionCredentialIdSha256:
      consumption.applicationDispatchConsumptionCredentialIdSha256,
    applicationDispatchConsumptionRequestIdSha256:
      consumption.applicationDispatchConsumptionRequestIdSha256,
    commandDispatchConsumptionRequestIdSha256:
      consumption.commandDispatchConsumptionRequestIdSha256,
    applicationConsumptionState: "consumed",
    applicationConsumedAt: consumption.consumedAt,
    applicationResponseSha256: application.responseSha256,
    applicationResponseBytes: application.responseBytes,
    consumeCredentialIdSha256:
      authentication.credentialIdSha256,
    consumeRequestIdSha256: routeRequestIdSha256,
    commandConsumeRequestIdSha256: command.recoveryRequestIdSha256,
  };
  const receipt: OperationFiveDispatchConsumptionReceipt = {
    ...receiptWithoutDigest,
    receiptDigestSha256:
      await operationFiveDispatchConsumptionReceiptDigest(
        receiptWithoutDigest,
      ),
  };
  const recoveryWithoutDigest: Omit<
    OperationFiveDispatchConsumptionRecoveryEvidence,
    "recoveryEvidenceDigestSha256"
  > = {
    authorizationIdSha256: command.authorizationIdSha256,
    recoveryContract:
      OPERATION_FIVE_DISPATCH_CONSUMPTION_RECOVERY_CONTRACT,
    claimDigestSha256: command.claimDigestSha256,
    applicationTicketIdSha256: consumption.ticketIdSha256,
    campaignId: consumption.campaignId,
    applicationDatabaseIdentitySha256:
      consumption.applicationDatabaseIdentitySha256,
    applicationVersionId: consumption.applicationVersionId,
    authorityDispatchClaimDigestSha256:
      consumption.authorityDispatchClaimDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      consumption.dispatchConsumptionDigestSha256,
    applicationDispatchConsumptionCredentialIdSha256:
      consumption.applicationDispatchConsumptionCredentialIdSha256,
    applicationDispatchConsumptionRequestIdSha256:
      consumption.applicationDispatchConsumptionRequestIdSha256,
    commandDispatchConsumptionRequestIdSha256:
      consumption.commandDispatchConsumptionRequestIdSha256,
    applicationConsumedAt: consumption.consumedAt,
    applicationHistoryReadCredentialIdSha256:
      application.readCredentialIdSha256,
    applicationHistoryReadRequestIdSha256:
      application.readRequestIdSha256,
    applicationResponseSha256: application.responseSha256,
    applicationResponseBytes: application.responseBytes,
    applicationDatabaseNow: application.applicationDatabaseNow,
    recoveryCredentialIdSha256:
      authentication.credentialIdSha256,
    recoveryRequestIdSha256: routeRequestIdSha256,
    commandRecoveryRequestIdSha256: command.recoveryRequestIdSha256,
    retentionDeadlineAt: application.retentionDeadlineAt,
    receiptDigestSha256: receipt.receiptDigestSha256,
  };
  const recovery: OperationFiveDispatchConsumptionRecoveryEvidence = {
    ...recoveryWithoutDigest,
    recoveryEvidenceDigestSha256:
      await operationFiveDispatchConsumptionRecoveryEvidenceDigest(
        recoveryWithoutDigest,
      ),
  };

  const persisted = await dependencies.createRecoveredReceipt(
    env.DB,
    receipt,
    recovery,
  );
  requireReceiptMatchesApplicationConsumption(
    persisted.receipt,
    application.consumption,
    command,
  );
  await requireExactHistoricalReceipt(persisted.receipt, command);
  const result = recoveryResult(
    persisted.classification === "recorded"
      ? "dispatch_consumption_receipt_recovered"
      : "exact_replay",
    persisted.receipt,
    persisted.recovery?.recovery_evidence_digest_sha256
      ?? (persisted.classification === "recorded"
        ? recovery.recoveryEvidenceDigestSha256
        : null),
    persisted.recovery?.retention_deadline_at
      ?? (persisted.classification === "recorded"
        ? recovery.retentionDeadlineAt
        : null),
  );
  recordRecoveryObservation(result, Date.now() - startedAt);
  return result;
}

function requireReceiptMatchesApplicationConsumption(
  row: OperationFiveDispatchConsumptionReceiptRow,
  consumption: HistoricalApplicationDispatchConsumptionReadback[
    "consumption"
  ],
  command: RecoverEnableDispatchConsumptionCommand,
): void {
  if (
    row.authorization_id_sha256 !== consumption.authorizationIdSha256
    || row.claim_digest_sha256 !== consumption.authorityClaimDigestSha256
    || row.application_ticket_id_sha256 !== consumption.ticketIdSha256
    || row.campaign_id !== consumption.campaignId
    || row.application_database_identity_sha256
      !== consumption.applicationDatabaseIdentitySha256
    || row.application_version_id !== consumption.applicationVersionId
    || row.application_grant_receipt_digest_sha256
      !== consumption.applicationGrantReceiptDigestSha256
    || row.application_grant_digest_sha256
      !== consumption.applicationGrantDigestSha256
    || row.authority_dispatch_outbox_digest_sha256
      !== consumption.authorityDispatchOutboxDigestSha256
    || row.operation_five_start_receipt_sha256
      !== consumption.operationFiveStartReceiptSha256
    || row.authority_dispatch_claim_digest_sha256
      !== consumption.authorityDispatchClaimDigestSha256
    || row.authority_database_identity_sha256
      !== consumption.authorityDatabaseIdentitySha256
    || row.authority_ledger_identity_sha256
      !== consumption.authorityLedgerIdentitySha256
    || row.authority_ledger_head_sha256
      !== consumption.authorityLedgerHeadSha256
    || row.authority_version_id !== consumption.authorityVersionId
    || row.dispatch_owner_sha256 !== consumption.dispatchOwnerSha256
    || row.lease_token_sha256 !== consumption.leaseTokenSha256
    || row.lease_generation !== consumption.leaseGeneration
    || row.lease_expires_at !== consumption.leaseExpiresAt
    || row.normal_deadline_at !== consumption.normalDeadlineAt
    || row.permit_expires_at !== consumption.permitExpiresAt
    || row.dispatch_claim_credential_id_sha256
      !== consumption.dispatchClaimCredentialIdSha256
    || row.dispatch_claim_request_id_sha256
      !== consumption.dispatchClaimRequestIdSha256
    || row.command_dispatch_claim_request_id_sha256
      !== consumption.commandDispatchClaimRequestIdSha256
    || row.authority_dispatch_claimed_at
      !== consumption.authorityDispatchClaimedAt
    || row.controller_service_name !== consumption.controllerServiceName
    || row.controller_enable_operation_id_sha256
      !== consumption.controllerEnableOperationIdSha256
    || row.controller_baseline_version_id
      !== consumption.controllerBaselineVersionId
    || row.controller_enabled_version_id
      !== consumption.controllerEnabledVersionId
    || row.send_attempt_limit !== consumption.sendAttemptLimit
    || row.retry_limit !== consumption.retryLimit
    || row.missing_readback_allows_resend
      !== consumption.missingReadbackAllowsResend
    || row.application_dispatch_consumption_digest_sha256
      !== consumption.dispatchConsumptionDigestSha256
    || row.application_dispatch_consumption_credential_id_sha256
      !== consumption.applicationDispatchConsumptionCredentialIdSha256
    || row.application_dispatch_consumption_request_id_sha256
      !== consumption.applicationDispatchConsumptionRequestIdSha256
    || row.command_dispatch_consumption_request_id_sha256
      !== consumption.commandDispatchConsumptionRequestIdSha256
    || row.command_dispatch_consumption_request_id_sha256
      !== command.dispatchConsumptionRequestIdSha256
    || row.application_consumption_state !== consumption.consumptionState
    || row.application_consumed_at !== consumption.consumedAt
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_recovery_source_drift",
      409,
    );
  }
}

export async function operationFiveDispatchConsumptionRecoveryEvidenceDigest(
  recovery: Omit<
    OperationFiveDispatchConsumptionRecoveryEvidence,
    "recoveryEvidenceDigestSha256"
  >,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: recovery.recoveryContract,
    authorizationIdSha256: recovery.authorizationIdSha256,
    claimDigestSha256: recovery.claimDigestSha256,
    applicationTicketIdSha256: recovery.applicationTicketIdSha256,
    campaignId: recovery.campaignId,
    applicationDatabaseIdentitySha256:
      recovery.applicationDatabaseIdentitySha256,
    applicationVersionId: recovery.applicationVersionId,
    authorityDispatchClaimDigestSha256:
      recovery.authorityDispatchClaimDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      recovery.applicationDispatchConsumptionDigestSha256,
    applicationDispatchConsumptionCredentialIdSha256:
      recovery.applicationDispatchConsumptionCredentialIdSha256,
    applicationDispatchConsumptionRequestIdSha256:
      recovery.applicationDispatchConsumptionRequestIdSha256,
    commandDispatchConsumptionRequestIdSha256:
      recovery.commandDispatchConsumptionRequestIdSha256,
    applicationConsumedAt: recovery.applicationConsumedAt,
    applicationHistoryReadCredentialIdSha256:
      recovery.applicationHistoryReadCredentialIdSha256,
    applicationHistoryReadRequestIdSha256:
      recovery.applicationHistoryReadRequestIdSha256,
    applicationResponseSha256: recovery.applicationResponseSha256,
    applicationResponseBytes: recovery.applicationResponseBytes,
    applicationDatabaseNow: recovery.applicationDatabaseNow,
    recoveryCredentialIdSha256: recovery.recoveryCredentialIdSha256,
    recoveryRequestIdSha256: recovery.recoveryRequestIdSha256,
    commandRecoveryRequestIdSha256:
      recovery.commandRecoveryRequestIdSha256,
    retentionDeadlineAt: recovery.retentionDeadlineAt,
    receiptDigestSha256: recovery.receiptDigestSha256,
  })));
}

async function requireHistoricalDispatchClaimMatches(
  env: RecoverEnableDispatchConsumptionEnv,
  row: OperationFiveDispatchClaimRow,
  command: RecoverEnableDispatchConsumptionCommand,
): Promise<void> {
  if (
    row.authorization_id_sha256 !== command.authorizationIdSha256
    || row.contract_version !== 1
    || row.claim_contract !== OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT
    || row.claim_digest_sha256 !== command.claimDigestSha256
    || row.dispatch_claim_digest_sha256
      !== command.dispatchClaimDigestSha256
    || row.application_database_identity_sha256
      !== env.SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256
    || row.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || row.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || row.send_attempt_limit !== 1
    || row.retry_limit !== 0
    || row.missing_readback_allows_resend !== 0
    || row.claim_state !== "claimed"
    || row.claimed_at <= 0
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_recovery_source_mismatch",
      409,
    );
  }
  if (
    await operationFiveDispatchClaimDigest(dispatchClaimFromRow(row))
      !== row.dispatch_claim_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_digest_mismatch",
      409,
    );
  }
}

async function requireExactHistoricalReceipt(
  row: OperationFiveDispatchConsumptionReceiptRow,
  command: RecoverEnableDispatchConsumptionCommand,
): Promise<void> {
  if (
    row.authorization_id_sha256 !== command.authorizationIdSha256
    || row.contract_version !== 1
    || row.receipt_contract
      !== OPERATION_FIVE_DISPATCH_CONSUMPTION_RECEIPT_CONTRACT
    || row.claim_digest_sha256 !== command.claimDigestSha256
    || row.authority_dispatch_claim_digest_sha256
      !== command.dispatchClaimDigestSha256
    || row.command_dispatch_consumption_request_id_sha256
      !== command.dispatchConsumptionRequestIdSha256
    || row.application_consumption_state !== "consumed"
    || row.send_attempt_limit !== 1
    || row.retry_limit !== 0
    || row.missing_readback_allows_resend !== 0
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_recovery_replay_mismatch",
      409,
    );
  }
  const receipt = receiptFromRow(row);
  const {
    receiptDigestSha256: _receiptDigestSha256,
    ...receiptWithoutDigest
  } = receipt;
  if (
    await operationFiveDispatchConsumptionReceiptDigest(
      receiptWithoutDigest,
    ) !== row.receipt_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_receipt_digest_mismatch",
      409,
    );
  }
}

function receiptFromRow(
  row: OperationFiveDispatchConsumptionReceiptRow,
): OperationFiveDispatchConsumptionReceipt {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    receiptContract:
      OPERATION_FIVE_DISPATCH_CONSUMPTION_RECEIPT_CONTRACT,
    claimDigestSha256: row.claim_digest_sha256,
    applicationTicketIdSha256: row.application_ticket_id_sha256,
    campaignId: row.campaign_id,
    applicationDatabaseIdentitySha256:
      row.application_database_identity_sha256,
    applicationVersionId: row.application_version_id,
    applicationGrantReceiptDigestSha256:
      row.application_grant_receipt_digest_sha256,
    applicationGrantDigestSha256: row.application_grant_digest_sha256,
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
    controllerBaselineVersionId: row.controller_baseline_version_id,
    controllerEnabledVersionId: row.controller_enabled_version_id,
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
    commandConsumeRequestIdSha256: row.command_consume_request_id_sha256,
    receiptDigestSha256: row.receipt_digest_sha256,
  };
}

function dispatchClaimFromRow(
  row: OperationFiveDispatchClaimRow,
): Omit<OperationFiveDispatchClaim, "dispatchClaimDigestSha256"> {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    claimContract: OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT,
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
    controllerBaselineVersionId: row.controller_baseline_version_id,
    controllerEnabledVersionId: row.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    claimState: "claimed",
  };
}

function recoveryResult(
  result: RecoverEnableDispatchConsumptionResult["result"],
  receipt: OperationFiveDispatchConsumptionReceiptRow,
  recoveryEvidenceDigestSha256: string | null,
  retentionDeadlineAt: number | null,
): RecoverEnableDispatchConsumptionResult {
  return {
    result,
    authorizationIdSha256: receipt.authorization_id_sha256,
    claimDigestSha256: receipt.claim_digest_sha256,
    dispatchClaimDigestSha256:
      receipt.authority_dispatch_claim_digest_sha256,
    applicationDispatchConsumptionDigestSha256:
      receipt.application_dispatch_consumption_digest_sha256,
    dispatchConsumptionReceiptDigestSha256:
      receipt.receipt_digest_sha256,
    recoveryEvidenceDigestSha256,
    applicationVersionId: receipt.application_version_id,
    authorityVersionId: receipt.authority_version_id,
    controllerEnableOperationIdSha256:
      receipt.controller_enable_operation_id_sha256,
    retentionDeadlineAt,
    receiptCount: 4,
    receiptHeadSha256: receipt.authority_ledger_head_sha256,
    sendAttemptCreated: false,
    controllerRequestSent: false,
  };
}

function recordRecoveryObservation(
  result: RecoverEnableDispatchConsumptionResult,
  elapsedMilliseconds: number,
): void {
  console.info(JSON.stringify({
    event:
      "shard_placement.operation_five_dispatch_consumption_recovery",
    result: result.result,
    authorizationIdSha256: result.authorizationIdSha256,
    claimDigestSha256: result.claimDigestSha256,
    dispatchClaimDigestSha256: result.dispatchClaimDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      result.applicationDispatchConsumptionDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      result.dispatchConsumptionReceiptDigestSha256,
    recoveryEvidenceDigestSha256:
      result.recoveryEvidenceDigestSha256,
    retentionDeadlineAt: result.retentionDeadlineAt,
    sendAttemptCreated: false,
    controllerRequestSent: false,
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
