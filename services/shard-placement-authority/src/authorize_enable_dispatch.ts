import {
  createExactApplicationPreEnableGrant,
  type ApplicationPreEnableGrantClientEnv,
  type ApplicationPreEnableGrantReadback,
} from "./application_pre_enable_grant_client";
import {
  createOperationFiveApplicationGrant,
  readExactExecutionClaim,
  readExactOperationFiveApplicationGrant,
  readExactOperationFiveDispatchOutbox,
  type ExecutionClaimSnapshot,
  type OperationFiveApplicationGrantReceipt,
  type OperationFiveApplicationGrantReceiptRow,
  type OperationFiveDispatchOutboxRow,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const AUTHORIZE_ENABLE_DISPATCH_CONTRACT =
  "cinatoken-shard-placement-authority-authorize-enable-dispatch-v1";
export const OPERATION_FIVE_APPLICATION_GRANT_RECEIPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "dispatchOutboxDigestSha256",
  "grantRequestIdSha256",
] as const;

export interface AuthorizeEnableDispatchCommand {
  schemaVersion: 1;
  contract: typeof AUTHORIZE_ENABLE_DISPATCH_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  dispatchOutboxDigestSha256: string;
  grantRequestIdSha256: string;
}

export interface AuthorizeEnableDispatchEnv
  extends ApplicationPreEnableGrantClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_RECEIPT_WRITE_ENABLED:
    string;
}

export interface AuthorizeEnableDispatchResult {
  result: "application_grant_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchOutboxDigestSha256: string;
  applicationGrantDigestSha256: string;
  applicationGrantReceiptDigestSha256: string;
  applicationVersionId: string;
  receiptCount: number;
  receiptHeadSha256: string;
  authorityVersionId: string;
}

interface AuthorizeEnableDispatchDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): ReturnType<typeof readExactExecutionClaim>;
  readOutbox(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): ReturnType<typeof readExactOperationFiveDispatchOutbox>;
  readGrantReceipt(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): ReturnType<typeof readExactOperationFiveApplicationGrant>;
  createApplicationGrant(
    env: ApplicationPreEnableGrantClientEnv,
    outbox: OperationFiveDispatchOutboxRow,
    command: {
      callerRequestIdSha256: string;
      authorityLedgerIdentitySha256: string;
    },
  ): Promise<ApplicationPreEnableGrantReadback>;
  createGrantReceipt(
    database: D1Database,
    receipt: OperationFiveApplicationGrantReceipt,
  ): ReturnType<typeof createOperationFiveApplicationGrant>;
}

const DEFAULT_DEPENDENCIES: AuthorizeEnableDispatchDependencies = {
  readClaim: readExactExecutionClaim,
  readOutbox: readExactOperationFiveDispatchOutbox,
  readGrantReceipt: readExactOperationFiveApplicationGrant,
  createApplicationGrant: createExactApplicationPreEnableGrant,
  createGrantReceipt: createOperationFiveApplicationGrant,
};

export function parseAuthorizeEnableDispatchCommand(
  body: Uint8Array,
): AuthorizeEnableDispatchCommand {
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
      AUTHORIZE_ENABLE_DISPATCH_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    dispatchOutboxDigestSha256: requireSha256(
      object.dispatchOutboxDigestSha256,
    ),
    grantRequestIdSha256: requireSha256(
      object.grantRequestIdSha256,
    ),
  };
}

export async function authorizeControllerEnableDispatch(
  env: AuthorizeEnableDispatchEnv,
  command: AuthorizeEnableDispatchCommand,
  authentication: AuthenticatedRequest,
  dependencies: AuthorizeEnableDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<AuthorizeEnableDispatchResult> {
  const startedAt = Date.now();
  let snapshot = await dependencies.readClaim(
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
  requireOutboxMatchesCommand(env, snapshot, outbox, command);

  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const existing = await dependencies.readGrantReceipt(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existing !== null) {
    const replay = exactGrantReplay(
      snapshot,
      outbox,
      existing,
      command,
      authentication.credentialIdSha256,
      routeRequestIdSha256,
    );
    recordGrantObservation({
      result: replay.result,
      receipt: existing,
      elapsedMilliseconds: Date.now() - startedAt,
    });
    return replay;
  }

  requireOperationFiveGrantAdmissible(snapshot, outbox);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_pre_enable_grant_write_disabled",
      503,
    );
  }
  if (
    env
      .SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_RECEIPT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_pre_enable_grant_receipt_write_disabled",
      503,
    );
  }

  const applicationGrant =
    await dependencies.createApplicationGrant(
      env,
      outbox,
      {
        callerRequestIdSha256: command.grantRequestIdSha256,
        authorityLedgerIdentitySha256:
          snapshot.claim.ledger_identity_sha256,
      },
    );

  const initial = snapshot;
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  requireOperationFiveGrantAdmissible(snapshot, outbox);
  requireUnchangedFence(initial, snapshot);

  const receiptWithoutDigest: Omit<
    OperationFiveApplicationGrantReceipt,
    "receiptDigestSha256"
  > = {
    authorizationIdSha256: command.authorizationIdSha256,
    receiptContract:
      OPERATION_FIVE_APPLICATION_GRANT_RECEIPT_CONTRACT,
    claimDigestSha256: command.claimDigestSha256,
    applicationTicketIdSha256: outbox.application_ticket_id_sha256,
    applicationTicketDigestSha256:
      outbox.application_ticket_digest_sha256,
    applicationDatabaseIdentitySha256:
      outbox.application_database_identity_sha256,
    applicationActivationDigestSha256:
      outbox.application_activation_digest_sha256,
    applicationAcknowledgementDigestSha256:
      outbox.application_acknowledgement_digest_sha256,
    operationFiveAdmissionDigestSha256:
      outbox.operation_five_admission_digest_sha256,
    operationFiveStartReceiptSha256:
      outbox.operation_five_start_receipt_sha256,
    authorityDispatchOutboxDigestSha256:
      outbox.outbox_digest_sha256,
    applicationGrantDigestSha256:
      applicationGrant.grant.grantDigestSha256,
    applicationGrantCredentialIdSha256:
      applicationGrant.credentialIdSha256,
    applicationGrantRequestIdSha256:
      applicationGrant.requestIdSha256,
    applicationVersionId: applicationGrant.applicationVersionId,
    applicationResponseSha256: applicationGrant.responseSha256,
    applicationResponseBytes: applicationGrant.responseBytes,
    applicationDatabaseNow:
      applicationGrant.grant.databaseNow,
    applicationGrantedAt: applicationGrant.grant.grantedAt,
    authorityDatabaseIdentitySha256:
      env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256,
    authorityLedgerIdentitySha256:
      env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256,
    authorityLedgerHeadSha256:
      snapshot.claim.ledger_head_sha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
    grantCredentialIdSha256:
      authentication.credentialIdSha256,
    grantRequestIdSha256: routeRequestIdSha256,
    commandGrantRequestIdSha256:
      command.grantRequestIdSha256,
    controllerServiceName: outbox.controller_service_name,
    controllerEnableOperationIdSha256:
      outbox.controller_enable_operation_id_sha256,
    controllerBaselineVersionId:
      outbox.controller_baseline_version_id,
    controllerEnabledVersionId:
      outbox.controller_enabled_version_id,
  };
  const receipt: OperationFiveApplicationGrantReceipt = {
    ...receiptWithoutDigest,
    receiptDigestSha256:
      await operationFiveApplicationGrantReceiptDigest(
        receiptWithoutDigest,
      ),
  };
  const persisted = await dependencies.createGrantReceipt(
    env.DB,
    receipt,
  );
  const result = grantResult(
    persisted.classification === "recorded"
      ? "application_grant_recorded"
      : "exact_replay",
    persisted.receipt,
    persisted.claim.ledger_version,
    persisted.claim.ledger_head_sha256,
  );
  recordGrantObservation({
    result: result.result,
    receipt: persisted.receipt,
    elapsedMilliseconds: Date.now() - startedAt,
  });
  return result;
}

export async function operationFiveApplicationGrantReceiptDigest(
  receipt: Omit<
    OperationFiveApplicationGrantReceipt,
    "receiptDigestSha256"
  >,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: receipt.receiptContract,
    authorizationIdSha256: receipt.authorizationIdSha256,
    claimDigestSha256: receipt.claimDigestSha256,
    applicationTicketIdSha256:
      receipt.applicationTicketIdSha256,
    applicationTicketDigestSha256:
      receipt.applicationTicketDigestSha256,
    applicationDatabaseIdentitySha256:
      receipt.applicationDatabaseIdentitySha256,
    applicationActivationDigestSha256:
      receipt.applicationActivationDigestSha256,
    applicationAcknowledgementDigestSha256:
      receipt.applicationAcknowledgementDigestSha256,
    operationFiveAdmissionDigestSha256:
      receipt.operationFiveAdmissionDigestSha256,
    operationFiveStartReceiptSha256:
      receipt.operationFiveStartReceiptSha256,
    authorityDispatchOutboxDigestSha256:
      receipt.authorityDispatchOutboxDigestSha256,
    applicationGrantDigestSha256:
      receipt.applicationGrantDigestSha256,
    applicationGrantCredentialIdSha256:
      receipt.applicationGrantCredentialIdSha256,
    applicationGrantRequestIdSha256:
      receipt.applicationGrantRequestIdSha256,
    applicationVersionId: receipt.applicationVersionId,
    applicationResponseSha256:
      receipt.applicationResponseSha256,
    applicationResponseBytes: receipt.applicationResponseBytes,
    applicationDatabaseNow: receipt.applicationDatabaseNow,
    applicationGrantedAt: receipt.applicationGrantedAt,
    authorityDatabaseIdentitySha256:
      receipt.authorityDatabaseIdentitySha256,
    authorityLedgerIdentitySha256:
      receipt.authorityLedgerIdentitySha256,
    authorityLedgerHeadSha256:
      receipt.authorityLedgerHeadSha256,
    authorityVersionId: receipt.authorityVersionId,
    grantCredentialIdSha256:
      receipt.grantCredentialIdSha256,
    grantRequestIdSha256: receipt.grantRequestIdSha256,
    commandGrantRequestIdSha256:
      receipt.commandGrantRequestIdSha256,
    controllerServiceName: receipt.controllerServiceName,
    controllerEnableOperationIdSha256:
      receipt.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      receipt.controllerBaselineVersionId,
    controllerEnabledVersionId:
      receipt.controllerEnabledVersionId,
  })));
}

function requireOutboxMatchesCommand(
  env: AuthorizeEnableDispatchEnv,
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
  command: AuthorizeEnableDispatchCommand,
): void {
  if (
    outbox.authorization_id_sha256
      !== command.authorizationIdSha256
    || outbox.claim_digest_sha256 !== command.claimDigestSha256
    || outbox.outbox_digest_sha256
      !== command.dispatchOutboxDigestSha256
    || outbox.application_ticket_id_sha256
      !== snapshot.claim.application_ticket_id_sha256
    || outbox.application_ticket_digest_sha256
      !== snapshot.claim.application_ticket_digest_sha256
    || outbox.application_database_identity_sha256
      !== snapshot.claim.application_database_identity_sha256
    || outbox.application_activation_digest_sha256
      !== snapshot.claim.application_activation_digest_sha256
    || outbox.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || outbox.authority_database_identity_sha256
      !== snapshot.claim.authority_database_identity_sha256
    || snapshot.claim.ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || outbox.authority_version_id !== env.CF_VERSION_METADATA.id
    || outbox.outbox_state !== "prepared"
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_outbox_mismatch",
      409,
    );
  }
}

function requireOperationFiveGrantAdmissible(
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
    || claim.status !== "running"
    || claim.ledger_version !== 4
    || claim.ledger_head_sha256
      !== outbox.operation_five_start_receipt_sha256
    || claim.ledger_head_sha256
      !== outbox.authority_ledger_head_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== 5
    || claim.inflight_operation_id_sha256
      !== outbox.controller_enable_operation_id_sha256
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_request_sha256 === null
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
    || started.receipt_digest_sha256
      !== outbox.operation_five_start_receipt_sha256
    || started.evidence_sha256
      !== outbox.operation_five_admission_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_application_grant_not_admissible",
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
      "operation_five_application_grant_fence_changed",
      409,
    );
  }
}

function exactGrantReplay(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
  receipt: OperationFiveApplicationGrantReceiptRow,
  command: AuthorizeEnableDispatchCommand,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
): AuthorizeEnableDispatchResult {
  if (
    receipt.authorization_id_sha256
      !== command.authorizationIdSha256
    || receipt.claim_digest_sha256 !== command.claimDigestSha256
    || receipt.authority_dispatch_outbox_digest_sha256
      !== command.dispatchOutboxDigestSha256
    || receipt.authority_dispatch_outbox_digest_sha256
      !== outbox.outbox_digest_sha256
    || receipt.command_grant_request_id_sha256
      !== command.grantRequestIdSha256
    || receipt.grant_credential_id_sha256
      !== credentialIdSha256
    || receipt.grant_request_id_sha256 !== routeRequestIdSha256
    || receipt.authority_ledger_identity_sha256
      !== snapshot.claim.ledger_identity_sha256
    || receipt.authority_ledger_head_sha256
      !== outbox.authority_ledger_head_sha256
    || receipt.authority_version_id !== outbox.authority_version_id
    || receipt.controller_service_name
      !== outbox.controller_service_name
    || receipt.controller_enable_operation_id_sha256
      !== outbox.controller_enable_operation_id_sha256
    || receipt.controller_baseline_version_id
      !== outbox.controller_baseline_version_id
    || receipt.controller_enabled_version_id
      !== outbox.controller_enabled_version_id
  ) {
    throw new ProtocolError(
      "operation_five_application_grant_replay_mismatch",
      409,
    );
  }
  return grantResult(
    "exact_replay",
    receipt,
    snapshot.claim.ledger_version,
    snapshot.claim.ledger_head_sha256,
  );
}

function grantResult(
  result: AuthorizeEnableDispatchResult["result"],
  receipt: OperationFiveApplicationGrantReceiptRow,
  receiptCount: number,
  receiptHeadSha256: string,
): AuthorizeEnableDispatchResult {
  return {
    result,
    authorizationIdSha256: receipt.authorization_id_sha256,
    claimDigestSha256: receipt.claim_digest_sha256,
    dispatchOutboxDigestSha256:
      receipt.authority_dispatch_outbox_digest_sha256,
    applicationGrantDigestSha256:
      receipt.application_grant_digest_sha256,
    applicationGrantReceiptDigestSha256:
      receipt.receipt_digest_sha256,
    applicationVersionId: receipt.application_version_id,
    receiptCount,
    receiptHeadSha256,
    authorityVersionId: receipt.authority_version_id,
  };
}

function recordGrantObservation(input: {
  result: AuthorizeEnableDispatchResult["result"];
  receipt: OperationFiveApplicationGrantReceiptRow;
  elapsedMilliseconds: number;
}): void {
  console.info(JSON.stringify({
    event: "shard_placement.operation_five_application_grant",
    result: input.result,
    authorizationIdSha256:
      input.receipt.authorization_id_sha256,
    claimDigestSha256: input.receipt.claim_digest_sha256,
    dispatchOutboxDigestSha256:
      input.receipt.authority_dispatch_outbox_digest_sha256,
    applicationGrantDigestSha256:
      input.receipt.application_grant_digest_sha256,
    applicationGrantReceiptDigestSha256:
      input.receipt.receipt_digest_sha256,
    elapsedMilliseconds: input.elapsedMilliseconds,
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
