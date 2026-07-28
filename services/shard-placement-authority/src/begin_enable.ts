import {
  readExactApplicationAuthorityAck,
  type ApplicationAuthorityAckClientEnv,
  type ApplicationAuthorityAckReadback,
} from "./application_ack_client";
import {
  EXECUTION_RECEIPT_CONTRACT,
  requestIdSha256,
  type ExecutionReceipt,
} from "./execution_protocol";
import {
  admitAndStartOperationFive,
  readExactExecutionClaim,
  readExactOperationFiveAdmission,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type ExecutionReceiptRow,
  type OperationFiveAdmission,
  type OperationFiveAdmissionRow,
} from "./execution_repository";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const BEGIN_ENABLE_CONTRACT =
  "cinatoken-shard-placement-authority-begin-enable-v1";
export const OPERATION_FIVE_ADMISSION_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-admission-v1";

const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "applicationAcknowledgementDigestSha256",
  "enableRequestIdSha256",
] as const;
const SHA256 = /^[0-9a-f]{64}$/;

export interface BeginEnableCommand {
  schemaVersion: 1;
  contract: typeof BEGIN_ENABLE_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  applicationAcknowledgementDigestSha256: string;
  enableRequestIdSha256: string;
}

export interface BeginEnableEnv extends ApplicationAuthorityAckClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED: string;
}

export interface BeginEnableResult {
  result: "enable_intent_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  admissionDigestSha256: string;
  operationStartedReceiptSha256: string;
  receiptCount: number;
  receiptHeadSha256: string;
  authorityVersionId: string;
}

export interface BeginEnableDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): Promise<ExecutionClaimSnapshot>;
  readAdmission(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveAdmissionRow | null>;
  readAcknowledgement(
    env: ApplicationAuthorityAckClientEnv,
    authority: ExecutionClaimSnapshot,
    command: {
      applicationAcknowledgementDigestSha256: string;
      callerRequestIdSha256: string;
      requestDomain: "op5";
    },
    authorityVersionId: string,
  ): Promise<ApplicationAuthorityAckReadback>;
  admitAndStart(
    database: D1Database,
    admission: OperationFiveAdmission,
    receipt: ExecutionReceipt,
  ): ReturnType<typeof admitAndStartOperationFive>;
}

const DEFAULT_DEPENDENCIES: BeginEnableDependencies = {
  readClaim: readExactExecutionClaim,
  readAdmission: readExactOperationFiveAdmission,
  readAcknowledgement: readExactApplicationAuthorityAck,
  admitAndStart: admitAndStartOperationFive,
};

export function parseBeginEnableCommand(
  body: Uint8Array,
): BeginEnableCommand {
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
    contract: requireLiteral(object.contract, BEGIN_ENABLE_CONTRACT),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    applicationAcknowledgementDigestSha256: requireSha256(
      object.applicationAcknowledgementDigestSha256,
    ),
    enableRequestIdSha256: requireSha256(
      object.enableRequestIdSha256,
    ),
  };
}

export async function beginControllerEnable(
  env: BeginEnableEnv,
  command: BeginEnableCommand,
  authentication: AuthenticatedRequest,
  dependencies: BeginEnableDependencies = DEFAULT_DEPENDENCIES,
): Promise<BeginEnableResult> {
  const startedAt = Date.now();
  let snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const operation = requireOperationFive(snapshot);
  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const existingAdmission = await dependencies.readAdmission(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (existingAdmission !== null) {
    const replay = exactAdmissionReplay(
      snapshot,
      operation,
      existingAdmission,
      command,
      authentication.credentialIdSha256,
      routeRequestIdSha256,
      env.CF_VERSION_METADATA.id,
    );
    recordOperationFiveObservation({
      result: replay.result,
      admission: existingAdmission,
      elapsedMilliseconds: Date.now() - startedAt,
    });
    return replay;
  }
  requirePristineOperationFive(snapshot);
  if (
    env.SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_pre_enable_reads_disabled", 503);
  }
  if (
    env.SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_enable_intent_write_disabled",
      503,
    );
  }

  const acknowledgement = await dependencies.readAcknowledgement(
    env,
    snapshot,
    {
      applicationAcknowledgementDigestSha256:
        command.applicationAcknowledgementDigestSha256,
      callerRequestIdSha256: command.enableRequestIdSha256,
      requestDomain: "op5",
    },
    env.CF_VERSION_METADATA.id,
  );
  const initial = snapshot;
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  requirePristineOperationFive(snapshot);
  requireUnchangedFence(initial, snapshot);

  const operationRequestSha256 = await operationFiveRequestDigest(
    snapshot,
    operation,
    command,
  );
  const admissionDigestSha256 = await operationFiveAdmissionDigest({
    snapshot,
    operation,
    command,
    acknowledgement,
    operationRequestSha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
    enableCredentialIdSha256: authentication.credentialIdSha256,
    routeRequestIdSha256,
  });
  const receipt = await operationFiveStartReceipt({
    snapshot,
    operation,
    authentication,
    routeRequestIdSha256,
    operationRequestSha256,
    admissionDigestSha256,
  });
  const terminal = requireOperationFourTerminal(snapshot);
  const admission: OperationFiveAdmission = {
    authorizationIdSha256: command.authorizationIdSha256,
    confirmationContract: OPERATION_FIVE_ADMISSION_CONTRACT,
    claimDigestSha256: command.claimDigestSha256,
    applicationTicketIdSha256:
      snapshot.claim.application_ticket_id_sha256,
    applicationTicketDigestSha256:
      snapshot.claim.application_ticket_digest_sha256,
    applicationDatabaseIdentitySha256:
      snapshot.claim.application_database_identity_sha256,
    applicationActivationDigestSha256:
      snapshot.claim.application_activation_digest_sha256!,
    authorityActivationTerminalReceiptSha256:
      terminal.receipt_digest_sha256,
    authorityLedgerHeadSha256:
      snapshot.claim.ledger_head_sha256,
    authorityDatabaseIdentitySha256:
      snapshot.claim.authority_database_identity_sha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    applicationVersionId: acknowledgement.applicationVersionId,
    applicationReadCredentialIdSha256:
      acknowledgement.credentialIdSha256,
    applicationReadRequestIdSha256:
      acknowledgement.requestIdSha256,
    applicationResponseSha256: acknowledgement.responseSha256,
    applicationResponseBytes: acknowledgement.responseBytes,
    enableCredentialIdSha256: authentication.credentialIdSha256,
    enableRequestIdSha256: routeRequestIdSha256,
    commandEnableRequestIdSha256: command.enableRequestIdSha256,
    enableOperationRequestSha256: operationRequestSha256,
    confirmationDigestSha256: admissionDigestSha256,
    operationStartReceiptDigestSha256: receipt.receiptDigestSha256,
  };
  const persisted = await dependencies.admitAndStart(
    env.DB,
    admission,
    receipt,
  );
  if (
    persisted.claim.enable_intent_seen !== 1
    || persisted.receipt.sequence !== 4
    || persisted.receipt.receipt_digest_sha256
      !== receipt.receiptDigestSha256
  ) {
    throw new ProtocolError(
      "operation_five_admission_readback_mismatch",
      503,
    );
  }
  const result: BeginEnableResult = {
    result: persisted.classification === "admitted"
      ? "enable_intent_recorded"
      : "exact_replay",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    admissionDigestSha256,
    operationStartedReceiptSha256: receipt.receiptDigestSha256,
    receiptCount: persisted.claim.ledger_version,
    receiptHeadSha256: persisted.claim.ledger_head_sha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
  };
  recordOperationFiveObservation({
    result: result.result,
    admission: persisted.admission,
    elapsedMilliseconds: Date.now() - startedAt,
  });
  return result;
}

export async function operationFiveRequestDigest(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  command: BeginEnableCommand,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: BEGIN_ENABLE_CONTRACT,
    authorizationIdSha256: snapshot.claim.authorization_id_sha256,
    claimDigestSha256: snapshot.claim.claim_digest_sha256,
    applicationTicketIdSha256:
      snapshot.claim.application_ticket_id_sha256,
    applicationTicketDigestSha256:
      snapshot.claim.application_ticket_digest_sha256,
    applicationDatabaseIdentitySha256:
      snapshot.claim.application_database_identity_sha256,
    authorityDatabaseIdentitySha256:
      snapshot.claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      snapshot.claim.ledger_identity_sha256,
    operationOrdinal: 5,
    operationIdSha256: operation.operation_id_sha256,
    predecessorReceiptSha256:
      snapshot.claim.ledger_head_sha256,
    applicationActivationDigestSha256:
      snapshot.claim.application_activation_digest_sha256,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    enableRequestIdSha256: command.enableRequestIdSha256,
  })));
}

async function operationFiveAdmissionDigest(input: {
  snapshot: ExecutionClaimSnapshot;
  operation: ExecutionOperationRow;
  command: BeginEnableCommand;
  acknowledgement: ApplicationAuthorityAckReadback;
  operationRequestSha256: string;
  authorityVersionId: string;
  enableCredentialIdSha256: string;
  routeRequestIdSha256: string;
}): Promise<string> {
  const terminal = requireOperationFourTerminal(input.snapshot);
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: OPERATION_FIVE_ADMISSION_CONTRACT,
    authorizationIdSha256:
      input.snapshot.claim.authorization_id_sha256,
    claimDigestSha256: input.snapshot.claim.claim_digest_sha256,
    applicationTicketIdSha256:
      input.snapshot.claim.application_ticket_id_sha256,
    applicationTicketDigestSha256:
      input.snapshot.claim.application_ticket_digest_sha256,
    applicationDatabaseIdentitySha256:
      input.snapshot.claim.application_database_identity_sha256,
    applicationActivationDigestSha256:
      input.snapshot.claim.application_activation_digest_sha256,
    authorityActivationTerminalReceiptSha256:
      terminal.receipt_digest_sha256,
    authorityLedgerHeadSha256:
      input.snapshot.claim.ledger_head_sha256,
    authorityDatabaseIdentitySha256:
      input.snapshot.claim.authority_database_identity_sha256,
    authorityVersionId: input.authorityVersionId,
    operationOrdinal: 5,
    operationIdSha256: input.operation.operation_id_sha256,
    applicationAcknowledgementDigestSha256:
      input.command.applicationAcknowledgementDigestSha256,
    applicationVersionId: input.acknowledgement.applicationVersionId,
    applicationReadCredentialIdSha256:
      input.acknowledgement.credentialIdSha256,
    applicationReadRequestIdSha256:
      input.acknowledgement.requestIdSha256,
    applicationResponseSha256:
      input.acknowledgement.responseSha256,
    applicationResponseBytes:
      input.acknowledgement.responseBytes,
    enableCredentialIdSha256: input.enableCredentialIdSha256,
    enableRequestIdSha256: input.routeRequestIdSha256,
    commandEnableRequestIdSha256:
      input.command.enableRequestIdSha256,
    enableOperationRequestSha256: input.operationRequestSha256,
  })));
}

async function operationFiveStartReceipt(input: {
  snapshot: ExecutionClaimSnapshot;
  operation: ExecutionOperationRow;
  authentication: AuthenticatedRequest;
  routeRequestIdSha256: string;
  operationRequestSha256: string;
  admissionDigestSha256: string;
}): Promise<ExecutionReceipt> {
  const claim = input.snapshot.claim;
  const unsigned: Omit<ExecutionReceipt, "receiptDigestSha256"> = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_started",
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    executionPlanSha256: claim.execution_plan_sha256,
    ledgerIdentitySha256: claim.ledger_identity_sha256,
    sequence: 4,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    leaseGeneration: claim.lease_generation,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: claim.lease_owner_sha256,
    actorCredentialIdSha256:
      input.authentication.credentialIdSha256,
    requestIdSha256: input.routeRequestIdSha256,
    operationOrdinal: 5,
    operationIdSha256: input.operation.operation_id_sha256,
    operationKind: "enable_controller_deployment",
    shardIndex: null,
    outcome: "pending",
    requestSha256: input.operationRequestSha256,
    responseSha256: null,
    evidenceSha256: input.admissionDigestSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
  };
  return {
    ...unsigned,
    receiptDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(unsigned)),
    ),
  };
}

function requirePristineOperationFive(
  snapshot: ExecutionClaimSnapshot,
): void {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  const terminal = requireOperationFourTerminal(snapshot);
  if (
    claim.status !== "running"
    || claim.ledger_version !== 3
    || claim.ledger_head_sha256 !== terminal.receipt_digest_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== null
    || claim.inflight_operation_id_sha256 !== null
    || claim.inflight_request_sha256 !== null
    || claim.inflight_readback_only !== 0
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.ticket_activation_confirmed !== 1
    || claim.application_activation_digest_sha256 === null
    || claim.enable_intent_seen !== 0
    || claim.disable_confirmed !== 1
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.permit_expires_at <= now
    || snapshot.receipts.length !== 3
  ) {
    throw new ProtocolError("operation_five_claim_not_admissible", 409);
  }
}

function requireUnchangedFence(
  before: ExecutionClaimSnapshot,
  after: ExecutionClaimSnapshot,
): void {
  const left = before.claim;
  const right = after.claim;
  if (
    left.ledger_version !== right.ledger_version
    || left.ledger_head_sha256 !== right.ledger_head_sha256
    || left.status !== right.status
    || left.lease_owner_sha256 !== right.lease_owner_sha256
    || left.lease_token_sha256 !== right.lease_token_sha256
    || left.lease_generation !== right.lease_generation
    || left.lease_expires_at !== right.lease_expires_at
    || left.renewal_count !== right.renewal_count
    || left.takeover_count !== right.takeover_count
    || left.application_activation_digest_sha256
      !== right.application_activation_digest_sha256
    || left.ticket_activation_confirmed
      !== right.ticket_activation_confirmed
  ) {
    throw new ProtocolError("operation_five_fence_changed", 409);
  }
}

function requireOperationFourTerminal(
  snapshot: ExecutionClaimSnapshot,
): ExecutionReceiptRow {
  const terminal = snapshot.receipts.find(
    (candidate) =>
      candidate.sequence === 3
      && candidate.event_kind === "operation_terminal"
      && candidate.operation_ordinal === 4,
  );
  if (
    terminal === undefined
    || terminal.operation_kind !== "activate_execution_ticket"
    || terminal.shard_index !== null
    || terminal.response_sha256 === null
    || terminal.evidence_sha256
      !== snapshot.claim.application_activation_digest_sha256
    || !["exact_success", "exact_replay", "ambiguous_recovered"].includes(
      terminal.outcome,
    )
  ) {
    throw new ProtocolError("operation_four_terminal_mismatch", 409);
  }
  return terminal;
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
    throw new ProtocolError("operation_five_schedule_mismatch", 409);
  }
  return operation;
}

function exactAdmissionReplay(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  admission: OperationFiveAdmissionRow,
  command: BeginEnableCommand,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
  authorityVersionId: string,
): BeginEnableResult {
  const started = snapshot.receipts.find(
    (candidate) =>
      candidate.sequence === 4
      && candidate.event_kind === "operation_started"
      && candidate.operation_ordinal === 5,
  );
  if (
    started === undefined
    || started.operation_id_sha256 !== operation.operation_id_sha256
    || started.operation_kind !== "enable_controller_deployment"
    || started.shard_index !== null
    || admission.application_acknowledgement_digest_sha256
      !== command.applicationAcknowledgementDigestSha256
    || admission.command_enable_request_id_sha256
      !== command.enableRequestIdSha256
    || admission.enable_credential_id_sha256 !== credentialIdSha256
    || admission.enable_request_id_sha256 !== routeRequestIdSha256
    || admission.enable_operation_request_sha256
      !== started.request_sha256
    || admission.confirmation_digest_sha256
      !== started.evidence_sha256
    || admission.operation_start_receipt_digest_sha256
      !== started.receipt_digest_sha256
    || admission.authority_version_id !== authorityVersionId
    || snapshot.claim.enable_intent_seen !== 1
    || snapshot.claim.ledger_version < 4
  ) {
    throw new ProtocolError("operation_five_replay_mismatch", 409);
  }
  return {
    result: "exact_replay",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationAcknowledgementDigestSha256:
      command.applicationAcknowledgementDigestSha256,
    admissionDigestSha256: admission.confirmation_digest_sha256,
    operationStartedReceiptSha256:
      admission.operation_start_receipt_digest_sha256,
    receiptCount: snapshot.claim.ledger_version,
    receiptHeadSha256: snapshot.claim.ledger_head_sha256,
    authorityVersionId,
  };
}

function recordOperationFiveObservation(input: {
  result: BeginEnableResult["result"];
  admission: OperationFiveAdmissionRow;
  elapsedMilliseconds: number;
}): void {
  console.info(canonicalJson({
    event: "shard_placement.operation_five_admission",
    result: input.result,
    authorizationIdSha256: input.admission.authorization_id_sha256,
    claimDigestSha256: input.admission.claim_digest_sha256,
    admissionDigestSha256:
      input.admission.confirmation_digest_sha256,
    operationStartReceiptSha256:
      input.admission.operation_start_receipt_digest_sha256,
    applicationVersionId: input.admission.application_version_id,
    authorityVersionId: input.admission.authority_version_id,
    applicationReadCredentialIdSha256:
      input.admission.application_read_credential_id_sha256,
    enableCredentialIdSha256:
      input.admission.enable_credential_id_sha256,
    applicationResponseBytes:
      input.admission.application_response_bytes,
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
  if (value !== expected) throw new ProtocolError("invalid_value", 400);
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_value", 400);
  }
  return value;
}
