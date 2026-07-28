import {
  createExactApplicationDispatchConsumption,
  type ApplicationDispatchConsumptionClientEnv,
  type ApplicationDispatchConsumptionReadback,
} from "./application_dispatch_consumption_client";
import {
  operationFiveDispatchClaimDigest,
} from "./claim_enable_dispatch";
import {
  createOperationFiveDispatchConsumption,
  readExactExecutionClaim,
  readExactOperationFiveDispatchClaim,
  readExactOperationFiveDispatchConsumption,
  type ExecutionClaimSnapshot,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchClaimRow,
  type OperationFiveDispatchConsumptionReceipt,
  type OperationFiveDispatchConsumptionReceiptRow,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const CONSUME_ENABLE_DISPATCH_CONTRACT =
  "cinatoken-shard-placement-authority-consume-enable-dispatch-v1";
export const OPERATION_FIVE_DISPATCH_CONSUMPTION_RECEIPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1";
const OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1";
const MINIMUM_CONSUMPTION_REMAINING_SECONDS = 30;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "dispatchClaimDigestSha256",
  "dispatchConsumptionRequestIdSha256",
] as const;

export interface ConsumeEnableDispatchCommand {
  schemaVersion: 1;
  contract: typeof CONSUME_ENABLE_DISPATCH_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionRequestIdSha256: string;
}

export interface ConsumeEnableDispatchEnv
  extends ApplicationDispatchConsumptionClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_WRITE_ENABLED:
    string;
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECEIPT_WRITE_ENABLED:
    string;
}

export interface ConsumeEnableDispatchResult {
  result: "dispatch_consumption_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  applicationVersionId: string;
  authorityVersionId: string;
  controllerEnableOperationIdSha256: string;
  receiptCount: number;
  receiptHeadSha256: string;
  sendAttemptCreated: false;
  controllerRequestSent: false;
}

export interface ConsumeEnableDispatchDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): Promise<ExecutionClaimSnapshot>;
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
  createApplicationConsumption(
    env: ApplicationDispatchConsumptionClientEnv,
    dispatchClaim: OperationFiveDispatchClaimRow,
    dispatchConsumptionRequestIdSha256: string,
  ): Promise<ApplicationDispatchConsumptionReadback>;
  createReceipt(
    database: D1Database,
    receipt: OperationFiveDispatchConsumptionReceipt,
  ): Promise<{
    classification: "recorded" | "exact_replay";
    receipt: OperationFiveDispatchConsumptionReceiptRow;
  }>;
}

const DEFAULT_DEPENDENCIES: ConsumeEnableDispatchDependencies = {
  readClaim: readExactExecutionClaim,
  readDispatchClaim: readExactOperationFiveDispatchClaim,
  readReceipt: readExactOperationFiveDispatchConsumption,
  createApplicationConsumption:
    createExactApplicationDispatchConsumption,
  createReceipt: createOperationFiveDispatchConsumption,
};

export function parseConsumeEnableDispatchCommand(
  body: Uint8Array,
): ConsumeEnableDispatchCommand {
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
      CONSUME_ENABLE_DISPATCH_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    dispatchClaimDigestSha256: requireSha256(
      object.dispatchClaimDigestSha256,
    ),
    dispatchConsumptionRequestIdSha256: requireSha256(
      object.dispatchConsumptionRequestIdSha256,
    ),
  };
}

export async function consumeControllerEnableDispatch(
  env: ConsumeEnableDispatchEnv,
  command: ConsumeEnableDispatchCommand,
  authentication: AuthenticatedRequest,
  dependencies: ConsumeEnableDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<ConsumeEnableDispatchResult> {
  const startedAt = Date.now();
  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const existing = await dependencies.readReceipt(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existing !== null) {
    const replay = exactConsumptionReplay(
      existing,
      command,
      authentication.credentialIdSha256,
      routeRequestIdSha256,
    );
    recordConsumptionObservation(
      replay,
      Date.now() - startedAt,
    );
    return replay;
  }

  let snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
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
  await requireDispatchClaimMatches(
    env,
    snapshot,
    dispatchClaim,
    command,
  );
  requireConsumptionAdmissible(snapshot, dispatchClaim);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_dispatch_consumption_write_disabled",
      503,
    );
  }
  if (
    env
      .SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECEIPT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_dispatch_consumption_receipt_write_disabled",
      503,
    );
  }

  const application =
    await dependencies.createApplicationConsumption(
      env,
      dispatchClaim,
      command.dispatchConsumptionRequestIdSha256,
    );

  const initialSnapshot = snapshot;
  const initialDispatchClaim = dispatchClaim;
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
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
  requireUnchangedFence(initialSnapshot, snapshot);
  requireSameDispatchClaim(initialDispatchClaim, dispatchClaim);
  await requireDispatchClaimMatches(
    env,
    snapshot,
    dispatchClaim,
    command,
  );
  requireConsumptionAdmissible(snapshot, dispatchClaim);

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
      application.credentialIdSha256,
    applicationDispatchConsumptionRequestIdSha256:
      application.requestIdSha256,
    commandDispatchConsumptionRequestIdSha256:
      command.dispatchConsumptionRequestIdSha256,
    applicationConsumptionState: "consumed",
    applicationConsumedAt: consumption.consumedAt,
    applicationResponseSha256: application.responseSha256,
    applicationResponseBytes: application.responseBytes,
    consumeCredentialIdSha256:
      authentication.credentialIdSha256,
    consumeRequestIdSha256: routeRequestIdSha256,
    commandConsumeRequestIdSha256:
      command.dispatchConsumptionRequestIdSha256,
  };
  const receipt: OperationFiveDispatchConsumptionReceipt = {
    ...receiptWithoutDigest,
    receiptDigestSha256:
      await operationFiveDispatchConsumptionReceiptDigest(
        receiptWithoutDigest,
      ),
  };
  const persisted = await dependencies.createReceipt(env.DB, receipt);
  const result = consumptionResult(
    persisted.classification === "recorded"
      ? "dispatch_consumption_recorded"
      : "exact_replay",
    persisted.receipt,
    snapshot,
  );
  recordConsumptionObservation(
    result,
    Date.now() - startedAt,
  );
  return result;
}

export async function operationFiveDispatchConsumptionReceiptDigest(
  receipt: Omit<
    OperationFiveDispatchConsumptionReceipt,
    "receiptDigestSha256"
  >,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: receipt.receiptContract,
    authorizationIdSha256: receipt.authorizationIdSha256,
    claimDigestSha256: receipt.claimDigestSha256,
    applicationTicketIdSha256: receipt.applicationTicketIdSha256,
    campaignId: receipt.campaignId,
    applicationDatabaseIdentitySha256:
      receipt.applicationDatabaseIdentitySha256,
    applicationVersionId: receipt.applicationVersionId,
    applicationGrantReceiptDigestSha256:
      receipt.applicationGrantReceiptDigestSha256,
    applicationGrantDigestSha256:
      receipt.applicationGrantDigestSha256,
    authorityDispatchOutboxDigestSha256:
      receipt.authorityDispatchOutboxDigestSha256,
    operationFiveStartReceiptSha256:
      receipt.operationFiveStartReceiptSha256,
    authorityDispatchClaimDigestSha256:
      receipt.authorityDispatchClaimDigestSha256,
    authorityDatabaseIdentitySha256:
      receipt.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      receipt.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256:
      receipt.authorityLedgerHeadSha256,
    authorityVersionId: receipt.authorityVersionId,
    dispatchOwnerSha256: receipt.dispatchOwnerSha256,
    leaseTokenSha256: receipt.leaseTokenSha256,
    leaseGeneration: receipt.leaseGeneration,
    leaseExpiresAt: receipt.leaseExpiresAt,
    normalDeadlineAt: receipt.normalDeadlineAt,
    permitExpiresAt: receipt.permitExpiresAt,
    dispatchClaimCredentialIdSha256:
      receipt.dispatchClaimCredentialIdSha256,
    dispatchClaimRequestIdSha256:
      receipt.dispatchClaimRequestIdSha256,
    commandDispatchClaimRequestIdSha256:
      receipt.commandDispatchClaimRequestIdSha256,
    authorityDispatchClaimedAt: receipt.authorityDispatchClaimedAt,
    controllerServiceName: receipt.controllerServiceName,
    controllerEnableOperationIdSha256:
      receipt.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      receipt.controllerBaselineVersionId,
    controllerEnabledVersionId:
      receipt.controllerEnabledVersionId,
    sendAttemptLimit: receipt.sendAttemptLimit,
    retryLimit: receipt.retryLimit,
    missingReadbackAllowsResend:
      receipt.missingReadbackAllowsResend,
    applicationDispatchConsumptionDigestSha256:
      receipt.applicationDispatchConsumptionDigestSha256,
    applicationDispatchConsumptionCredentialIdSha256:
      receipt.applicationDispatchConsumptionCredentialIdSha256,
    applicationDispatchConsumptionRequestIdSha256:
      receipt.applicationDispatchConsumptionRequestIdSha256,
    commandDispatchConsumptionRequestIdSha256:
      receipt.commandDispatchConsumptionRequestIdSha256,
    applicationConsumptionState: receipt.applicationConsumptionState,
    applicationConsumedAt: receipt.applicationConsumedAt,
    applicationResponseSha256: receipt.applicationResponseSha256,
    applicationResponseBytes: receipt.applicationResponseBytes,
    consumeCredentialIdSha256:
      receipt.consumeCredentialIdSha256,
    consumeRequestIdSha256: receipt.consumeRequestIdSha256,
    commandConsumeRequestIdSha256:
      receipt.commandConsumeRequestIdSha256,
  })));
}

async function requireDispatchClaimMatches(
  env: ConsumeEnableDispatchEnv,
  snapshot: ExecutionClaimSnapshot,
  row: OperationFiveDispatchClaimRow,
  command: ConsumeEnableDispatchCommand,
): Promise<void> {
  const claim = snapshot.claim;
  if (
    row.authorization_id_sha256 !== command.authorizationIdSha256
    || row.contract_version !== 1
    || row.claim_contract !== OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT
    || row.claim_digest_sha256 !== command.claimDigestSha256
    || row.dispatch_claim_digest_sha256
      !== command.dispatchClaimDigestSha256
    || row.dispatch_owner_sha256 !== command.claimOwnerSha256
    || row.application_ticket_id_sha256
      !== claim.application_ticket_id_sha256
    || row.application_database_identity_sha256
      !== claim.application_database_identity_sha256
    || row.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || row.authority_database_identity_sha256
      !== claim.authority_database_identity_sha256
    || row.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || row.authority_ledger_identity_sha256
      !== claim.ledger_identity_sha256
    || row.authority_ledger_head_sha256 !== claim.ledger_head_sha256
    || row.authority_version_id !== env.CF_VERSION_METADATA.id
    || row.dispatch_owner_sha256 !== claim.claim_owner_sha256
    || row.lease_token_sha256 !== claim.lease_token_sha256
    || row.lease_generation !== claim.lease_generation
    || row.lease_expires_at !== claim.lease_expires_at
    || row.normal_deadline_at !== claim.normal_deadline_at
    || row.permit_expires_at !== claim.permit_expires_at
    || row.controller_enable_operation_id_sha256
      !== claim.inflight_operation_id_sha256
    || row.send_attempt_limit !== 1
    || row.retry_limit !== 0
    || row.missing_readback_allows_resend !== 0
    || row.claim_state !== "claimed"
    || row.claimed_at <= 0
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_source_mismatch",
      409,
    );
  }
  const candidate = dispatchClaimFromRow(row);
  if (
    await operationFiveDispatchClaimDigest(candidate)
      !== row.dispatch_claim_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_digest_mismatch",
      409,
    );
  }
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

function requireConsumptionAdmissible(
  snapshot: ExecutionClaimSnapshot,
  dispatchClaim: OperationFiveDispatchClaimRow,
): void {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === 5,
  );
  const started = snapshot.receipts.find(
    (candidate) =>
      candidate.sequence === 4
      && candidate.event_kind === "operation_started"
      && candidate.operation_ordinal === 5,
  );
  if (
    operation === undefined
    || operation.kind !== "enable_controller_deployment"
    || operation.shard_index !== null
    || started === undefined
    || started.operation_kind !== "enable_controller_deployment"
    || started.shard_index !== null
    || started.outcome !== "pending"
    || started.response_sha256 !== null
    || started.cloudflare_request_id_sha256 !== null
    || claim.status !== "running"
    || claim.ledger_version !== 4
    || claim.ledger_head_sha256
      !== dispatchClaim.operation_five_start_receipt_sha256
    || claim.ledger_head_sha256
      !== dispatchClaim.authority_ledger_head_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== 5
    || claim.inflight_operation_id_sha256
      !== dispatchClaim.controller_enable_operation_id_sha256
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_request_sha256 === null
    || claim.inflight_started_generation !== 1
    || claim.inflight_started_owner_sha256
      !== claim.claim_owner_sha256
    || claim.inflight_started_lease_token_sha256
      !== claim.lease_token_sha256
    || claim.inflight_readback_only !== 0
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || claim.ticket_activation_confirmed !== 1
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.lease_expires_at
      <= now + MINIMUM_CONSUMPTION_REMAINING_SECONDS
    || claim.normal_deadline_at
      <= now + MINIMUM_CONSUMPTION_REMAINING_SECONDS
    || claim.permit_expires_at
      <= now + MINIMUM_CONSUMPTION_REMAINING_SECONDS
    || snapshot.receipts.length !== 4
    || started.operation_id_sha256 !== operation.operation_id_sha256
    || started.request_sha256 !== claim.inflight_request_sha256
    || started.receipt_digest_sha256
      !== dispatchClaim.operation_five_start_receipt_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_not_admissible",
      409,
    );
  }
}

function requireUnchangedFence(
  before: ExecutionClaimSnapshot,
  after: ExecutionClaimSnapshot,
): void {
  const left = before.claim;
  const right = after.claim;
  if (
    left.status !== right.status
    || left.ledger_version !== right.ledger_version
    || left.ledger_head_sha256 !== right.ledger_head_sha256
    || left.lease_owner_sha256 !== right.lease_owner_sha256
    || left.lease_token_sha256 !== right.lease_token_sha256
    || left.lease_generation !== right.lease_generation
    || left.lease_expires_at !== right.lease_expires_at
    || left.renewal_count !== right.renewal_count
    || left.takeover_count !== right.takeover_count
    || left.inflight_operation_ordinal
      !== right.inflight_operation_ordinal
    || left.inflight_operation_id_sha256
      !== right.inflight_operation_id_sha256
    || left.inflight_request_sha256
      !== right.inflight_request_sha256
    || left.inflight_readback_only !== right.inflight_readback_only
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_fence_changed",
      409,
    );
  }
}

function requireSameDispatchClaim(
  before: OperationFiveDispatchClaimRow,
  after: OperationFiveDispatchClaimRow,
): void {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_changed",
      409,
    );
  }
}

function exactConsumptionReplay(
  receipt: OperationFiveDispatchConsumptionReceiptRow,
  command: ConsumeEnableDispatchCommand,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
): ConsumeEnableDispatchResult {
  if (
    receipt.authorization_id_sha256
      !== command.authorizationIdSha256
    || receipt.claim_digest_sha256 !== command.claimDigestSha256
    || receipt.dispatch_owner_sha256 !== command.claimOwnerSha256
    || receipt.authority_dispatch_claim_digest_sha256
      !== command.dispatchClaimDigestSha256
    || receipt.command_dispatch_consumption_request_id_sha256
      !== command.dispatchConsumptionRequestIdSha256
    || receipt.command_consume_request_id_sha256
      !== command.dispatchConsumptionRequestIdSha256
    || receipt.consume_credential_id_sha256 !== credentialIdSha256
    || receipt.consume_request_id_sha256 !== routeRequestIdSha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_consumption_replay_mismatch",
      409,
    );
  }
  return consumptionResult("exact_replay", receipt, null);
}

function consumptionResult(
  result: ConsumeEnableDispatchResult["result"],
  receipt: OperationFiveDispatchConsumptionReceiptRow,
  snapshot: ExecutionClaimSnapshot | null,
): ConsumeEnableDispatchResult {
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
    applicationVersionId: receipt.application_version_id,
    authorityVersionId: receipt.authority_version_id,
    controllerEnableOperationIdSha256:
      receipt.controller_enable_operation_id_sha256,
    receiptCount: snapshot?.claim.ledger_version ?? 4,
    receiptHeadSha256:
      snapshot?.claim.ledger_head_sha256
        ?? receipt.authority_ledger_head_sha256,
    sendAttemptCreated: false,
    controllerRequestSent: false,
  };
}

function recordConsumptionObservation(
  result: ConsumeEnableDispatchResult,
  elapsedMilliseconds: number,
): void {
  console.info(JSON.stringify({
    event: "shard_placement.operation_five_dispatch_consumption",
    result: result.result,
    authorizationIdSha256: result.authorizationIdSha256,
    claimDigestSha256: result.claimDigestSha256,
    dispatchClaimDigestSha256: result.dispatchClaimDigestSha256,
    applicationDispatchConsumptionDigestSha256:
      result.applicationDispatchConsumptionDigestSha256,
    dispatchConsumptionReceiptDigestSha256:
      result.dispatchConsumptionReceiptDigestSha256,
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
