import {
  createOperationFiveDispatchClaim,
  readExactExecutionClaim,
  readExactOperationFiveApplicationGrant,
  readExactOperationFiveDispatchClaim,
  readExactOperationFiveDispatchOutbox,
  type ExecutionClaimSnapshot,
  type OperationFiveApplicationGrantReceiptRow,
  type OperationFiveDispatchClaim,
  type OperationFiveDispatchClaimRow,
  type OperationFiveDispatchOutboxRow,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const CLAIM_ENABLE_DISPATCH_CONTRACT =
  "cinatoken-shard-placement-authority-claim-enable-dispatch-v1";
export const OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1";
const OPERATION_FIVE_DISPATCH_OUTBOX_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1";
const OPERATION_FIVE_APPLICATION_GRANT_RECEIPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "dispatchOutboxDigestSha256",
  "applicationGrantReceiptDigestSha256",
  "dispatchClaimRequestIdSha256",
] as const;

export type {
  OperationFiveDispatchClaim,
  OperationFiveDispatchClaimRow,
} from "./execution_repository";

export interface ClaimEnableDispatchCommand {
  schemaVersion: 1;
  contract: typeof CLAIM_ENABLE_DISPATCH_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  dispatchOutboxDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  dispatchClaimRequestIdSha256: string;
}

export interface ClaimEnableDispatchEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_CLAIM_WRITE_ENABLED: string;
}

export interface ClaimEnableDispatchResult {
  result: "dispatch_claim_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchOutboxDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  applicationGrantDigestSha256: string;
  dispatchClaimDigestSha256: string;
  controllerEnableOperationIdSha256: string;
  authorityVersionId: string;
  receiptCount: number;
  receiptHeadSha256: string;
  sendAttemptCreated: false;
  controllerRequestSent: false;
}

export interface ClaimEnableDispatchDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): Promise<ExecutionClaimSnapshot>;
  readOutbox(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveDispatchOutboxRow | null>;
  readApplicationGrant(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveApplicationGrantReceiptRow | null>;
  readDispatchClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveDispatchClaimRow | null>;
  createDispatchClaim(
    database: D1Database,
    claim: OperationFiveDispatchClaim,
  ): Promise<{
    classification: "claimed" | "exact_replay";
    dispatchClaim: OperationFiveDispatchClaimRow;
    claim: ExecutionClaimSnapshot["claim"];
  }>;
}

const DEFAULT_DEPENDENCIES: ClaimEnableDispatchDependencies = {
  readClaim: readExactExecutionClaim,
  readOutbox: readExactOperationFiveDispatchOutbox,
  readApplicationGrant: readExactOperationFiveApplicationGrant,
  readDispatchClaim: readExactOperationFiveDispatchClaim,
  createDispatchClaim: createOperationFiveDispatchClaim,
};

export function parseClaimEnableDispatchCommand(
  body: Uint8Array,
): ClaimEnableDispatchCommand {
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
      CLAIM_ENABLE_DISPATCH_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    dispatchOutboxDigestSha256: requireSha256(
      object.dispatchOutboxDigestSha256,
    ),
    applicationGrantReceiptDigestSha256: requireSha256(
      object.applicationGrantReceiptDigestSha256,
    ),
    dispatchClaimRequestIdSha256: requireSha256(
      object.dispatchClaimRequestIdSha256,
    ),
  };
}

export async function claimControllerEnableDispatch(
  env: ClaimEnableDispatchEnv,
  command: ClaimEnableDispatchCommand,
  authentication: AuthenticatedRequest,
  dependencies: ClaimEnableDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<ClaimEnableDispatchResult> {
  const startedAt = Date.now();
  const snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const outbox = await dependencies.readOutbox(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (outbox === null) {
    throw new ProtocolError(
      "operation_five_dispatch_outbox_missing",
      409,
    );
  }
  const applicationGrant = await dependencies.readApplicationGrant(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (applicationGrant === null) {
    throw new ProtocolError(
      "operation_five_application_grant_missing",
      409,
    );
  }

  requireSourceIdentityMatches(
    env,
    snapshot,
    outbox,
    applicationGrant,
    command,
  );
  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const candidate = await buildDispatchClaim({
    env,
    snapshot,
    outbox,
    applicationGrant,
    command,
    credentialIdSha256: authentication.credentialIdSha256,
    routeRequestIdSha256,
  });
  const existing = await dependencies.readDispatchClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existing !== null) {
    requireExactDispatchClaimReplay(existing, candidate);
    const result = dispatchClaimResult(
      "exact_replay",
      existing,
      snapshot,
    );
    recordDispatchClaimObservation(
      result,
      Date.now() - startedAt,
    );
    return result;
  }

  requireOperationFiveDispatchClaimAdmissible(snapshot, outbox);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_DISPATCH_CLAIM_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_dispatch_claim_write_disabled",
      503,
    );
  }

  const persisted = await dependencies.createDispatchClaim(
    env.DB,
    candidate,
  );
  requireExactDispatchClaimReplay(
    persisted.dispatchClaim,
    candidate,
  );
  const result = dispatchClaimResult(
    persisted.classification === "claimed"
      ? "dispatch_claim_recorded"
      : "exact_replay",
    persisted.dispatchClaim,
    {
      ...snapshot,
      claim: persisted.claim,
    },
  );
  recordDispatchClaimObservation(
    result,
    Date.now() - startedAt,
  );
  return result;
}

export async function operationFiveDispatchClaimDigest(
  claim: Omit<
    OperationFiveDispatchClaim,
    "dispatchClaimDigestSha256"
  >,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: claim.claimContract,
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    applicationTicketIdSha256: claim.applicationTicketIdSha256,
    applicationDatabaseIdentitySha256:
      claim.applicationDatabaseIdentitySha256,
    authorityDispatchOutboxDigestSha256:
      claim.authorityDispatchOutboxDigestSha256,
    applicationGrantReceiptDigestSha256:
      claim.applicationGrantReceiptDigestSha256,
    applicationGrantDigestSha256:
      claim.applicationGrantDigestSha256,
    operationFiveStartReceiptSha256:
      claim.operationFiveStartReceiptSha256,
    authorityDatabaseIdentitySha256:
      claim.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      claim.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256:
      claim.authorityLedgerHeadSha256,
    authorityVersionId: claim.authorityVersionId,
    applicationVersionId: claim.applicationVersionId,
    dispatchOwnerSha256: claim.dispatchOwnerSha256,
    leaseTokenSha256: claim.leaseTokenSha256,
    leaseGeneration: claim.leaseGeneration,
    leaseExpiresAt: claim.leaseExpiresAt,
    normalDeadlineAt: claim.normalDeadlineAt,
    permitExpiresAt: claim.permitExpiresAt,
    dispatchClaimCredentialIdSha256:
      claim.dispatchClaimCredentialIdSha256,
    dispatchClaimRequestIdSha256:
      claim.dispatchClaimRequestIdSha256,
    commandDispatchClaimRequestIdSha256:
      claim.commandDispatchClaimRequestIdSha256,
    controllerServiceName: claim.controllerServiceName,
    controllerEnableOperationIdSha256:
      claim.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      claim.controllerBaselineVersionId,
    controllerEnabledVersionId:
      claim.controllerEnabledVersionId,
    sendAttemptLimit: claim.sendAttemptLimit,
    retryLimit: claim.retryLimit,
    missingReadbackAllowsResend:
      claim.missingReadbackAllowsResend,
    claimState: claim.claimState,
  })));
}

async function buildDispatchClaim(input: {
  env: ClaimEnableDispatchEnv;
  snapshot: ExecutionClaimSnapshot;
  outbox: OperationFiveDispatchOutboxRow;
  applicationGrant: OperationFiveApplicationGrantReceiptRow;
  command: ClaimEnableDispatchCommand;
  credentialIdSha256: string;
  routeRequestIdSha256: string;
}): Promise<OperationFiveDispatchClaim> {
  const withoutDigest: Omit<
    OperationFiveDispatchClaim,
    "dispatchClaimDigestSha256"
  > = {
    authorizationIdSha256:
      input.command.authorizationIdSha256,
    claimContract:
      OPERATION_FIVE_DISPATCH_CLAIM_CONTRACT,
    claimDigestSha256: input.command.claimDigestSha256,
    applicationTicketIdSha256:
      input.applicationGrant.application_ticket_id_sha256,
    applicationDatabaseIdentitySha256:
      input.applicationGrant.application_database_identity_sha256,
    authorityDispatchOutboxDigestSha256:
      input.outbox.outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      input.applicationGrant.receipt_digest_sha256,
    applicationGrantDigestSha256:
      input.applicationGrant.application_grant_digest_sha256,
    operationFiveStartReceiptSha256:
      input.outbox.operation_five_start_receipt_sha256,
    authorityDatabaseIdentitySha256:
      input.env
        .SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256,
    authorityLedgerIdentitySha256:
      input.env
        .SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256,
    authorityLedgerHeadSha256:
      input.snapshot.claim.ledger_head_sha256,
    authorityVersionId: input.env.CF_VERSION_METADATA.id,
    applicationVersionId:
      input.applicationGrant.application_version_id,
    dispatchOwnerSha256: input.command.claimOwnerSha256,
    leaseTokenSha256: input.snapshot.claim.lease_token_sha256,
    leaseGeneration: 1,
    leaseExpiresAt: input.snapshot.claim.lease_expires_at,
    normalDeadlineAt: input.snapshot.claim.normal_deadline_at,
    permitExpiresAt: input.snapshot.claim.permit_expires_at,
    dispatchClaimCredentialIdSha256:
      input.credentialIdSha256,
    dispatchClaimRequestIdSha256:
      input.routeRequestIdSha256,
    commandDispatchClaimRequestIdSha256:
      input.command.dispatchClaimRequestIdSha256,
    controllerServiceName:
      input.outbox.controller_service_name,
    controllerEnableOperationIdSha256:
      input.outbox.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      input.outbox.controller_baseline_version_id,
    controllerEnabledVersionId:
      input.outbox.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    claimState: "claimed",
  };
  return {
    ...withoutDigest,
    dispatchClaimDigestSha256:
      await operationFiveDispatchClaimDigest(withoutDigest),
  };
}

function requireSourceIdentityMatches(
  env: ClaimEnableDispatchEnv,
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
  applicationGrant: OperationFiveApplicationGrantReceiptRow,
  command: ClaimEnableDispatchCommand,
): void {
  const claim = snapshot.claim;
  if (
    claim.authorization_id_sha256
      !== command.authorizationIdSha256
    || claim.claim_digest_sha256 !== command.claimDigestSha256
    || claim.claim_owner_sha256 !== command.claimOwnerSha256
    || claim.authority_database_identity_sha256
      !== env
        .SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || claim.ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || outbox.contract_version !== 1
    || outbox.dispatch_contract
      !== OPERATION_FIVE_DISPATCH_OUTBOX_CONTRACT
    || outbox.authorization_id_sha256
      !== command.authorizationIdSha256
    || outbox.claim_digest_sha256 !== command.claimDigestSha256
    || outbox.outbox_digest_sha256
      !== command.dispatchOutboxDigestSha256
    || outbox.application_ticket_id_sha256
      !== claim.application_ticket_id_sha256
    || outbox.application_ticket_digest_sha256
      !== claim.application_ticket_digest_sha256
    || outbox.application_database_identity_sha256
      !== claim.application_database_identity_sha256
    || outbox.application_activation_digest_sha256
      !== claim.application_activation_digest_sha256
    || outbox.authority_database_identity_sha256
      !== claim.authority_database_identity_sha256
    || outbox.authority_ledger_head_sha256
      !== claim.ledger_head_sha256
    || outbox.authority_version_id
      !== env.CF_VERSION_METADATA.id
    || outbox.outbox_state !== "prepared"
    || applicationGrant.contract_version !== 1
    || applicationGrant.receipt_contract
      !== OPERATION_FIVE_APPLICATION_GRANT_RECEIPT_CONTRACT
    || applicationGrant.authorization_id_sha256
      !== command.authorizationIdSha256
    || applicationGrant.claim_digest_sha256
      !== command.claimDigestSha256
    || applicationGrant.receipt_digest_sha256
      !== command.applicationGrantReceiptDigestSha256
    || applicationGrant.application_ticket_id_sha256
      !== outbox.application_ticket_id_sha256
    || applicationGrant.application_ticket_digest_sha256
      !== outbox.application_ticket_digest_sha256
    || applicationGrant.application_database_identity_sha256
      !== outbox.application_database_identity_sha256
    || applicationGrant.application_activation_digest_sha256
      !== outbox.application_activation_digest_sha256
    || applicationGrant.application_acknowledgement_digest_sha256
      !== outbox.application_acknowledgement_digest_sha256
    || applicationGrant.operation_five_admission_digest_sha256
      !== outbox.operation_five_admission_digest_sha256
    || applicationGrant.operation_five_start_receipt_sha256
      !== outbox.operation_five_start_receipt_sha256
    || applicationGrant.authority_dispatch_outbox_digest_sha256
      !== outbox.outbox_digest_sha256
    || applicationGrant.authority_database_identity_sha256
      !== outbox.authority_database_identity_sha256
    || applicationGrant.authority_ledger_identity_sha256
      !== claim.ledger_identity_sha256
    || applicationGrant.authority_ledger_head_sha256
      !== outbox.authority_ledger_head_sha256
    || applicationGrant.authority_version_id
      !== outbox.authority_version_id
    || applicationGrant.controller_service_name
      !== outbox.controller_service_name
    || applicationGrant.controller_enable_operation_id_sha256
      !== outbox.controller_enable_operation_id_sha256
    || applicationGrant.controller_baseline_version_id
      !== outbox.controller_baseline_version_id
    || applicationGrant.controller_enabled_version_id
      !== outbox.controller_enabled_version_id
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_source_mismatch",
      409,
    );
  }
}

function requireOperationFiveDispatchClaimAdmissible(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
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
      !== outbox.operation_five_start_receipt_sha256
    || claim.ledger_head_sha256
      !== outbox.authority_ledger_head_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== 5
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_operation_id_sha256
      !== outbox.controller_enable_operation_id_sha256
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
    || claim.application_activation_digest_sha256
      !== outbox.application_activation_digest_sha256
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.permit_expires_at <= now
    || snapshot.receipts.length !== 4
    || started.operation_id_sha256
      !== operation.operation_id_sha256
    || started.request_sha256 !== claim.inflight_request_sha256
    || started.evidence_sha256
      !== outbox.operation_five_admission_digest_sha256
    || started.receipt_digest_sha256
      !== outbox.operation_five_start_receipt_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_not_admissible",
      409,
    );
  }
}

function requireExactDispatchClaimReplay(
  row: OperationFiveDispatchClaimRow,
  claim: OperationFiveDispatchClaim,
): void {
  if (
    row.authorization_id_sha256 !== claim.authorizationIdSha256
    || row.contract_version !== 1
    || row.claim_contract !== claim.claimContract
    || row.claim_digest_sha256 !== claim.claimDigestSha256
    || row.application_ticket_id_sha256
      !== claim.applicationTicketIdSha256
    || row.application_database_identity_sha256
      !== claim.applicationDatabaseIdentitySha256
    || row.authority_dispatch_outbox_digest_sha256
      !== claim.authorityDispatchOutboxDigestSha256
    || row.application_grant_receipt_digest_sha256
      !== claim.applicationGrantReceiptDigestSha256
    || row.application_grant_digest_sha256
      !== claim.applicationGrantDigestSha256
    || row.operation_five_start_receipt_sha256
      !== claim.operationFiveStartReceiptSha256
    || row.authority_database_identity_sha256
      !== claim.authorityDatabaseIdentitySha256
    || row.authority_ledger_identity_sha256
      !== claim.authorityLedgerIdentitySha256
    || row.authority_ledger_head_sha256
      !== claim.authorityLedgerHeadSha256
    || row.authority_version_id !== claim.authorityVersionId
    || row.application_version_id !== claim.applicationVersionId
    || row.dispatch_owner_sha256 !== claim.dispatchOwnerSha256
    || row.lease_token_sha256 !== claim.leaseTokenSha256
    || row.lease_generation !== claim.leaseGeneration
    || row.lease_expires_at !== claim.leaseExpiresAt
    || row.normal_deadline_at !== claim.normalDeadlineAt
    || row.permit_expires_at !== claim.permitExpiresAt
    || row.dispatch_claim_credential_id_sha256
      !== claim.dispatchClaimCredentialIdSha256
    || row.dispatch_claim_request_id_sha256
      !== claim.dispatchClaimRequestIdSha256
    || row.command_dispatch_claim_request_id_sha256
      !== claim.commandDispatchClaimRequestIdSha256
    || row.controller_service_name !== claim.controllerServiceName
    || row.controller_enable_operation_id_sha256
      !== claim.controllerEnableOperationIdSha256
    || row.controller_baseline_version_id
      !== claim.controllerBaselineVersionId
    || row.controller_enabled_version_id
      !== claim.controllerEnabledVersionId
    || row.send_attempt_limit !== claim.sendAttemptLimit
    || row.retry_limit !== claim.retryLimit
    || row.missing_readback_allows_resend
      !== claim.missingReadbackAllowsResend
    || row.dispatch_claim_digest_sha256
      !== claim.dispatchClaimDigestSha256
    || row.claim_state !== claim.claimState
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_claim_replay_mismatch",
      409,
    );
  }
}

function dispatchClaimResult(
  result: ClaimEnableDispatchResult["result"],
  row: OperationFiveDispatchClaimRow,
  snapshot: ExecutionClaimSnapshot,
): ClaimEnableDispatchResult {
  return {
    result,
    authorizationIdSha256: row.authorization_id_sha256,
    claimDigestSha256: row.claim_digest_sha256,
    dispatchOutboxDigestSha256:
      row.authority_dispatch_outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      row.application_grant_receipt_digest_sha256,
    applicationGrantDigestSha256:
      row.application_grant_digest_sha256,
    dispatchClaimDigestSha256:
      row.dispatch_claim_digest_sha256,
    controllerEnableOperationIdSha256:
      row.controller_enable_operation_id_sha256,
    authorityVersionId: row.authority_version_id,
    receiptCount: snapshot.claim.ledger_version,
    receiptHeadSha256: snapshot.claim.ledger_head_sha256,
    sendAttemptCreated: false,
    controllerRequestSent: false,
  };
}

function recordDispatchClaimObservation(
  result: ClaimEnableDispatchResult,
  elapsedMilliseconds: number,
): void {
  console.info(canonicalJson({
    event: "shard_placement.operation_five_dispatch_claim",
    result: result.result,
    authorizationIdSha256: result.authorizationIdSha256,
    claimDigestSha256: result.claimDigestSha256,
    dispatchOutboxDigestSha256:
      result.dispatchOutboxDigestSha256,
    applicationGrantReceiptDigestSha256:
      result.applicationGrantReceiptDigestSha256,
    applicationGrantDigestSha256:
      result.applicationGrantDigestSha256,
    dispatchClaimDigestSha256:
      result.dispatchClaimDigestSha256,
    controllerEnableOperationIdSha256:
      result.controllerEnableOperationIdSha256,
    authorityVersionId: result.authorityVersionId,
    sendAttemptCreated: result.sendAttemptCreated,
    controllerRequestSent: result.controllerRequestSent,
    elapsedMilliseconds: Math.max(
      0,
      Math.round(elapsedMilliseconds),
    ),
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
