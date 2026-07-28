import {
  readExactApplicationAuthorityAck,
  type ApplicationAuthorityAckClientEnv,
  type ApplicationAuthorityAckReadback,
} from "./application_ack_client";
import {
  createOperationFiveDispatchOutbox,
  readExactExecutionClaim,
  readExactOperationFiveAdmission,
  readExactOperationFiveDispatchOutbox,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type ExecutionReceiptRow,
  type OperationFiveAdmissionRow,
  type OperationFiveDispatchOutbox,
  type OperationFiveDispatchOutboxRow,
} from "./execution_repository";
import { requestIdSha256 } from "./execution_protocol";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const PREPARE_ENABLE_DISPATCH_CONTRACT =
  "cinatoken-shard-placement-authority-prepare-enable-dispatch-v1";
export const OPERATION_FIVE_DISPATCH_OUTBOX_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "applicationAcknowledgementDigestSha256",
  "operationFiveAdmissionDigestSha256",
  "operationFiveStartReceiptSha256",
  "dispatchRequestIdSha256",
] as const;

export interface PrepareEnableDispatchCommand {
  schemaVersion: 1;
  contract: typeof PREPARE_ENABLE_DISPATCH_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  dispatchRequestIdSha256: string;
}

export interface PrepareEnableDispatchEnv
  extends ApplicationAuthorityAckClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED: string;
}

export interface PrepareEnableDispatchResult {
  result: "dispatch_outbox_prepared" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  dispatchRequestSha256: string;
  dispatchOutboxDigestSha256: string;
  outboxState: "prepared";
  receiptCount: number;
  receiptHeadSha256: string;
  authorityVersionId: string;
}

interface PrepareEnableDispatchDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): ReturnType<typeof readExactExecutionClaim>;
  readAdmission(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): ReturnType<typeof readExactOperationFiveAdmission>;
  readOutbox(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): ReturnType<typeof readExactOperationFiveDispatchOutbox>;
  readAcknowledgement(
    env: ApplicationAuthorityAckClientEnv,
    authority: ExecutionClaimSnapshot,
    command: {
      applicationAcknowledgementDigestSha256: string;
      callerRequestIdSha256: string;
      requestDomain: "op5-dispatch";
    },
    authorityVersionId: string,
  ): Promise<ApplicationAuthorityAckReadback>;
  createOutbox(
    database: D1Database,
    outbox: OperationFiveDispatchOutbox,
  ): ReturnType<typeof createOperationFiveDispatchOutbox>;
}

const DEFAULT_DEPENDENCIES: PrepareEnableDispatchDependencies = {
  readClaim: readExactExecutionClaim,
  readAdmission: readExactOperationFiveAdmission,
  readOutbox: readExactOperationFiveDispatchOutbox,
  readAcknowledgement: readExactApplicationAuthorityAck,
  createOutbox: createOperationFiveDispatchOutbox,
};

export function parsePrepareEnableDispatchCommand(
  body: Uint8Array,
): PrepareEnableDispatchCommand {
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
      PREPARE_ENABLE_DISPATCH_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    applicationAcknowledgementDigestSha256: requireSha256(
      object.applicationAcknowledgementDigestSha256,
    ),
    operationFiveAdmissionDigestSha256: requireSha256(
      object.operationFiveAdmissionDigestSha256,
    ),
    operationFiveStartReceiptSha256: requireSha256(
      object.operationFiveStartReceiptSha256,
    ),
    dispatchRequestIdSha256: requireSha256(
      object.dispatchRequestIdSha256,
    ),
  };
}

export async function prepareControllerEnableDispatch(
  env: PrepareEnableDispatchEnv,
  command: PrepareEnableDispatchCommand,
  authentication: AuthenticatedRequest,
  dependencies: PrepareEnableDispatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrepareEnableDispatchResult> {
  const startedAt = Date.now();
  let snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const admission = await dependencies.readAdmission(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (admission === null) {
    throw new ProtocolError(
      "operation_five_dispatch_admission_missing",
      409,
    );
  }
  requireAdmissionMatchesCommand(snapshot, admission, command);
  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const existingOutbox = await dependencies.readOutbox(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existingOutbox !== null) {
    const replay = exactOutboxReplay(
      snapshot,
      admission,
      existingOutbox,
      command,
      authentication.credentialIdSha256,
      routeRequestIdSha256,
    );
    recordDispatchOutboxObservation({
      result: replay.result,
      outbox: existingOutbox,
      elapsedMilliseconds: Date.now() - startedAt,
    });
    return replay;
  }

  requireOperationFiveStarted(snapshot, admission);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_pre_dispatch_reads_disabled",
      503,
    );
  }
  if (
    env.SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_dispatch_outbox_write_disabled",
      503,
    );
  }

  const acknowledgement = await dependencies.readAcknowledgement(
    env,
    snapshot,
    {
      applicationAcknowledgementDigestSha256:
        command.applicationAcknowledgementDigestSha256,
      callerRequestIdSha256: command.dispatchRequestIdSha256,
      requestDomain: "op5-dispatch",
    },
    admission.authority_version_id,
  );
  const initial = snapshot;
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  requireOperationFiveStarted(snapshot, admission);
  requireUnchangedFence(initial, snapshot);

  const operation = requireOperationFive(snapshot);
  const dispatchRequestSha256 = await dispatchRequestDigest({
    snapshot,
    admission,
    command,
    acknowledgement,
    operation,
  });
  const outboxWithoutDigest: Omit<
    OperationFiveDispatchOutbox,
    "outboxDigestSha256"
  > = {
    authorizationIdSha256: command.authorizationIdSha256,
    dispatchContract: OPERATION_FIVE_DISPATCH_OUTBOX_CONTRACT,
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
    authorityVersionId: env.CF_VERSION_METADATA.id,
    authorityLedgerHeadSha256:
      snapshot.claim.ledger_head_sha256,
    applicationVersionId: acknowledgement.applicationVersionId,
    applicationReadCredentialIdSha256:
      acknowledgement.credentialIdSha256,
    applicationReadRequestIdSha256:
      acknowledgement.requestIdSha256,
    applicationResponseSha256: acknowledgement.responseSha256,
    applicationResponseBytes: acknowledgement.responseBytes,
    applicationDatabaseNow:
      acknowledgement.acknowledgement.databaseNow,
    dispatchCredentialIdSha256:
      authentication.credentialIdSha256,
    dispatchRequestIdSha256: routeRequestIdSha256,
    commandDispatchRequestIdSha256:
      command.dispatchRequestIdSha256,
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
    dispatchRequestSha256,
  };
  const outbox: OperationFiveDispatchOutbox = {
    ...outboxWithoutDigest,
    outboxDigestSha256: await dispatchOutboxDigest(
      outboxWithoutDigest,
    ),
  };
  const persisted = await dependencies.createOutbox(env.DB, outbox);
  const result: PrepareEnableDispatchResult = {
    result: persisted.classification === "prepared"
      ? "dispatch_outbox_prepared"
      : "exact_replay",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    operationFiveAdmissionDigestSha256:
      command.operationFiveAdmissionDigestSha256,
    operationFiveStartReceiptSha256:
      command.operationFiveStartReceiptSha256,
    dispatchRequestSha256,
    dispatchOutboxDigestSha256:
      persisted.outbox.outbox_digest_sha256,
    outboxState: "prepared",
    receiptCount: persisted.claim.ledger_version,
    receiptHeadSha256: persisted.claim.ledger_head_sha256,
    authorityVersionId: persisted.outbox.authority_version_id,
  };
  recordDispatchOutboxObservation({
    result: result.result,
    outbox: persisted.outbox,
    elapsedMilliseconds: Date.now() - startedAt,
  });
  return result;
}

async function dispatchRequestDigest(input: {
  snapshot: ExecutionClaimSnapshot;
  admission: OperationFiveAdmissionRow;
  command: PrepareEnableDispatchCommand;
  acknowledgement: ApplicationAuthorityAckReadback;
  operation: ExecutionOperationRow;
}): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: PREPARE_ENABLE_DISPATCH_CONTRACT,
    authorizationIdSha256:
      input.snapshot.claim.authorization_id_sha256,
    claimDigestSha256: input.snapshot.claim.claim_digest_sha256,
    operationFiveAdmissionDigestSha256:
      input.admission.confirmation_digest_sha256,
    operationFiveStartReceiptSha256:
      input.admission.operation_start_receipt_digest_sha256,
    applicationAcknowledgementDigestSha256:
      input.admission.application_acknowledgement_digest_sha256,
    applicationReadResponseSha256:
      input.acknowledgement.responseSha256,
    applicationDatabaseNow:
      input.acknowledgement.acknowledgement.databaseNow,
    authorityLedgerHeadSha256:
      input.snapshot.claim.ledger_head_sha256,
    controllerServiceName:
      input.acknowledgement.acknowledgement.controllerServiceName,
    controllerEnableOperationIdSha256:
      input.operation.operation_id_sha256,
    controllerBaselineVersionId:
      input.acknowledgement.acknowledgement
        .controllerBaselineVersionId,
    controllerEnabledVersionId:
      input.acknowledgement.acknowledgement
        .controllerEnabledVersionId,
    dispatchRequestIdSha256:
      input.command.dispatchRequestIdSha256,
  })));
}

async function dispatchOutboxDigest(
  outbox: Omit<OperationFiveDispatchOutbox, "outboxDigestSha256">,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: outbox.dispatchContract,
    authorizationIdSha256: outbox.authorizationIdSha256,
    claimDigestSha256: outbox.claimDigestSha256,
    applicationTicketIdSha256: outbox.applicationTicketIdSha256,
    applicationTicketDigestSha256:
      outbox.applicationTicketDigestSha256,
    applicationDatabaseIdentitySha256:
      outbox.applicationDatabaseIdentitySha256,
    applicationActivationDigestSha256:
      outbox.applicationActivationDigestSha256,
    applicationAcknowledgementDigestSha256:
      outbox.applicationAcknowledgementDigestSha256,
    operationFiveAdmissionDigestSha256:
      outbox.operationFiveAdmissionDigestSha256,
    operationFiveStartReceiptSha256:
      outbox.operationFiveStartReceiptSha256,
    authorityDatabaseIdentitySha256:
      outbox.authorityDatabaseIdentitySha256,
    authorityVersionId: outbox.authorityVersionId,
    authorityLedgerHeadSha256:
      outbox.authorityLedgerHeadSha256,
    applicationVersionId: outbox.applicationVersionId,
    applicationReadCredentialIdSha256:
      outbox.applicationReadCredentialIdSha256,
    applicationReadRequestIdSha256:
      outbox.applicationReadRequestIdSha256,
    applicationResponseSha256: outbox.applicationResponseSha256,
    applicationResponseBytes: outbox.applicationResponseBytes,
    applicationDatabaseNow: outbox.applicationDatabaseNow,
    dispatchCredentialIdSha256:
      outbox.dispatchCredentialIdSha256,
    dispatchRequestIdSha256: outbox.dispatchRequestIdSha256,
    commandDispatchRequestIdSha256:
      outbox.commandDispatchRequestIdSha256,
    controllerServiceName: outbox.controllerServiceName,
    controllerEnableOperationIdSha256:
      outbox.controllerEnableOperationIdSha256,
    controllerBaselineVersionId:
      outbox.controllerBaselineVersionId,
    controllerEnabledVersionId:
      outbox.controllerEnabledVersionId,
    dispatchRequestSha256: outbox.dispatchRequestSha256,
  })));
}

function requireAdmissionMatchesCommand(
  snapshot: ExecutionClaimSnapshot,
  admission: OperationFiveAdmissionRow,
  command: PrepareEnableDispatchCommand,
): void {
  if (
    admission.authorization_id_sha256
      !== command.authorizationIdSha256
    || admission.claim_digest_sha256 !== command.claimDigestSha256
    || admission.application_acknowledgement_digest_sha256
      !== command.applicationAcknowledgementDigestSha256
    || admission.confirmation_digest_sha256
      !== command.operationFiveAdmissionDigestSha256
    || admission.operation_start_receipt_digest_sha256
      !== command.operationFiveStartReceiptSha256
    || admission.application_ticket_id_sha256
      !== snapshot.claim.application_ticket_id_sha256
    || admission.application_ticket_digest_sha256
      !== snapshot.claim.application_ticket_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_admission_mismatch",
      409,
    );
  }
}

function requireOperationFiveStarted(
  snapshot: ExecutionClaimSnapshot,
  admission: OperationFiveAdmissionRow,
): void {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  const operation = requireOperationFive(snapshot);
  const started = requireOperationFiveStart(snapshot);
  if (
    claim.status !== "running"
    || claim.ledger_version !== 4
    || claim.ledger_head_sha256 !== started.receipt_digest_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== 5
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_request_sha256
      !== admission.enable_operation_request_sha256
    || claim.inflight_readback_only !== 0
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || claim.ticket_activation_confirmed !== 1
    || claim.application_activation_digest_sha256 === null
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.permit_expires_at <= now
    || snapshot.receipts.length !== 4
    || started.operation_id_sha256 !== operation.operation_id_sha256
    || started.request_sha256
      !== admission.enable_operation_request_sha256
    || started.evidence_sha256
      !== admission.confirmation_digest_sha256
    || started.receipt_digest_sha256
      !== admission.operation_start_receipt_digest_sha256
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_not_admissible",
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
      "operation_five_dispatch_fence_changed",
      409,
    );
  }
}

function requireOperationFive(
  snapshot: ExecutionClaimSnapshot,
): ExecutionOperationRow {
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === 5,
  );
  if (
    operation === undefined
    || operation.kind !== "enable_controller_deployment"
    || operation.shard_index !== null
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_schedule_mismatch",
      409,
    );
  }
  return operation;
}

function requireOperationFiveStart(
  snapshot: ExecutionClaimSnapshot,
): ExecutionReceiptRow {
  const started = snapshot.receipts.find(
    (candidate) =>
      candidate.sequence === 4
      && candidate.event_kind === "operation_started"
      && candidate.operation_ordinal === 5,
  );
  if (
    started === undefined
    || started.operation_kind !== "enable_controller_deployment"
    || started.shard_index !== null
    || started.outcome !== "pending"
    || started.response_sha256 !== null
    || started.cloudflare_request_id_sha256 !== null
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_start_mismatch",
      409,
    );
  }
  return started;
}

function exactOutboxReplay(
  snapshot: ExecutionClaimSnapshot,
  admission: OperationFiveAdmissionRow,
  outbox: OperationFiveDispatchOutboxRow,
  command: PrepareEnableDispatchCommand,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
): PrepareEnableDispatchResult {
  if (
    outbox.authorization_id_sha256
      !== command.authorizationIdSha256
    || outbox.claim_digest_sha256 !== command.claimDigestSha256
    || outbox.application_acknowledgement_digest_sha256
      !== command.applicationAcknowledgementDigestSha256
    || outbox.operation_five_admission_digest_sha256
      !== command.operationFiveAdmissionDigestSha256
    || outbox.operation_five_start_receipt_sha256
      !== command.operationFiveStartReceiptSha256
    || outbox.command_dispatch_request_id_sha256
      !== command.dispatchRequestIdSha256
    || outbox.dispatch_credential_id_sha256 !== credentialIdSha256
    || outbox.dispatch_request_id_sha256 !== routeRequestIdSha256
    || outbox.operation_five_admission_digest_sha256
      !== admission.confirmation_digest_sha256
    || outbox.operation_five_start_receipt_sha256
      !== admission.operation_start_receipt_digest_sha256
    || outbox.outbox_state !== "prepared"
  ) {
    throw new ProtocolError(
      "operation_five_dispatch_replay_mismatch",
      409,
    );
  }
  return {
    result: "exact_replay",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    operationFiveAdmissionDigestSha256:
      command.operationFiveAdmissionDigestSha256,
    operationFiveStartReceiptSha256:
      command.operationFiveStartReceiptSha256,
    dispatchRequestSha256: outbox.dispatch_request_sha256,
    dispatchOutboxDigestSha256: outbox.outbox_digest_sha256,
    outboxState: "prepared",
    receiptCount: snapshot.claim.ledger_version,
    receiptHeadSha256: snapshot.claim.ledger_head_sha256,
    authorityVersionId: outbox.authority_version_id,
  };
}

function recordDispatchOutboxObservation(input: {
  result: PrepareEnableDispatchResult["result"];
  outbox: OperationFiveDispatchOutboxRow;
  elapsedMilliseconds: number;
}): void {
  console.info(canonicalJson({
    event: "shard_placement.operation_five_dispatch_outbox",
    result: input.result,
    authorizationIdSha256: input.outbox.authorization_id_sha256,
    claimDigestSha256: input.outbox.claim_digest_sha256,
    dispatchOutboxDigestSha256:
      input.outbox.outbox_digest_sha256,
    operationFiveStartReceiptSha256:
      input.outbox.operation_five_start_receipt_sha256,
    applicationVersionId: input.outbox.application_version_id,
    authorityVersionId: input.outbox.authority_version_id,
    applicationReadCredentialIdSha256:
      input.outbox.application_read_credential_id_sha256,
    dispatchCredentialIdSha256:
      input.outbox.dispatch_credential_id_sha256,
    applicationResponseBytes:
      input.outbox.application_response_bytes,
    outboxState: input.outbox.outbox_state,
    elapsedMilliseconds: Math.max(
      0,
      Math.round(input.elapsedMilliseconds),
    ),
  }));
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_value", 400);
  }
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_value", 400);
  }
  return value;
}
