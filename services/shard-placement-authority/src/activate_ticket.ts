import {
  readExactApplicationActivation,
  type ApplicationActivationClientEnv,
  type ApplicationActivationReadback,
} from "./application_activation_client";
import {
  EXECUTION_RECEIPT_CONTRACT,
  requestIdSha256,
  type ExecutionReceipt,
} from "./execution_protocol";
import {
  appendExecutionReceipt,
  readExactExecutionClaim,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type ExecutionReceiptRow,
} from "./execution_repository";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const ACTIVATE_TICKET_CONTRACT =
  "cinatoken-shard-placement-authority-activate-ticket-v1";

const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "applicationActivationDigestSha256",
  "activationRequestIdSha256",
] as const;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ActivateTicketCommand {
  schemaVersion: 1;
  contract: typeof ACTIVATE_TICKET_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  applicationActivationDigestSha256: string;
  activationRequestIdSha256: string;
}

export interface ActivateTicketEnv extends ApplicationActivationClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED: string;
}

export interface ActivateTicketResult {
  result: "activated" | "exact_replay" | "ambiguous_recovered";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  applicationActivationDigestSha256: string;
  operationStartedReceiptSha256: string;
  operationTerminalReceiptSha256: string;
  receiptCount: number;
  receiptHeadSha256: string;
  authorityVersionId: string;
}

export interface ActivateTicketDependencies {
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): Promise<ExecutionClaimSnapshot>;
  readActivation(
    env: ApplicationActivationClientEnv,
    claim: ExecutionClaimSnapshot["claim"],
    activationOperationIdSha256: string,
    command: {
      applicationActivationDigestSha256: string;
      activationRequestIdSha256: string;
    },
    authorityVersionId: string,
  ): Promise<ApplicationActivationReadback>;
  appendReceipt(
    database: D1Database,
    authorizationIdSha256: string,
    receipt: ExecutionReceipt,
    receiptCredentialIdSha256: string,
  ): Promise<{
    classification: "receipt_appended" | "receipt_replayed";
    claim: ExecutionClaimSnapshot["claim"];
    receipt: ExecutionReceiptRow;
  }>;
}

const DEFAULT_DEPENDENCIES: ActivateTicketDependencies = {
  readClaim: readExactExecutionClaim,
  readActivation: readExactApplicationActivation,
  appendReceipt: appendExecutionReceipt,
};

export function parseActivateTicketCommand(
  body: Uint8Array,
): ActivateTicketCommand {
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
    contract: requireLiteral(object.contract, ACTIVATE_TICKET_CONTRACT),
    authorizationIdSha256: requireSha256(
      object.authorizationIdSha256,
    ),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    claimOwnerSha256: requireSha256(object.claimOwnerSha256),
    applicationActivationDigestSha256: requireSha256(
      object.applicationActivationDigestSha256,
    ),
    activationRequestIdSha256: requireSha256(
      object.activationRequestIdSha256,
    ),
  };
}

export async function activateExecutionTicket(
  env: ActivateTicketEnv,
  command: ActivateTicketCommand,
  authentication: AuthenticatedRequest,
  dependencies: ActivateTicketDependencies = DEFAULT_DEPENDENCIES,
): Promise<ActivateTicketResult> {
  let snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const operation = requireOperationFour(snapshot);
  const requestSha256 = await activationOperationRequestDigest(
    snapshot,
    operation,
    command,
  );
  const routeRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const replay = exactTerminalReplay(
    snapshot,
    command,
    operation,
    requestSha256,
    env.CF_VERSION_METADATA.id,
    authentication.credentialIdSha256,
    routeRequestIdSha256,
  );
  if (replay !== null) return replay;
  if (
    env.SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED !== "true"
  ) {
    throw new ProtocolError("authority_activation_write_disabled", 503);
  }

  let resumed = snapshot.claim.inflight_operation_ordinal === 4;
  const initial = !resumed;
  if (initial) requirePristineOperationFour(snapshot);
  else requireRecoverableOperationFour(snapshot, operation, requestSha256);

  let started: ExecutionReceiptRow;
  if (initial) {
    const start = await buildOperationReceipt({
      snapshot,
      operation,
      authentication,
      command,
      requestSha256,
      routeRequestIdSha256,
      eventKind: "operation_started",
      outcome: "pending",
    });
    const appended = await dependencies.appendReceipt(
      env.DB,
      command.authorizationIdSha256,
      start,
      authentication.credentialIdSha256,
    );
    resumed = appended.classification === "receipt_replayed";
    started = appended.receipt;
  } else {
    started = requireStartedReceipt(
      snapshot,
      operation,
      requestSha256,
      command.applicationActivationDigestSha256,
      authentication.credentialIdSha256,
      routeRequestIdSha256,
    );
  }

  const readback = await dependencies.readActivation(
    env,
    snapshot.claim,
    operation.operation_id_sha256,
    command,
    env.CF_VERSION_METADATA.id,
  );

  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  requireRecoverableOperationFour(snapshot, operation, requestSha256);
  const persistedStart = requireStartedReceipt(
    snapshot,
    operation,
    requestSha256,
    command.applicationActivationDigestSha256,
    authentication.credentialIdSha256,
    routeRequestIdSha256,
  );
  if (
    persistedStart.receipt_digest_sha256 !== started.receipt_digest_sha256
    || persistedStart.receipt_credential_id_sha256
      !== authentication.credentialIdSha256
  ) {
    throw new ProtocolError("operation4_start_mismatch", 409);
  }

  const terminalOutcome = resumed
    ? "ambiguous_recovered"
    : "exact_success";
  const terminal = await buildOperationReceipt({
    snapshot,
    operation,
    authentication,
    command,
    requestSha256,
    routeRequestIdSha256,
    readback,
    eventKind: "operation_terminal",
    outcome: terminalOutcome,
  });
  const appended = await dependencies.appendReceipt(
    env.DB,
    command.authorizationIdSha256,
    terminal,
    authentication.credentialIdSha256,
  );
  if (
    appended.claim.ticket_activation_confirmed !== 1
    || appended.claim.application_activation_digest_sha256
      !== command.applicationActivationDigestSha256
    || appended.claim.last_completed_ordinal !== 4
    || appended.claim.ledger_head_sha256
      !== appended.receipt.receipt_digest_sha256
  ) {
    throw new ProtocolError("operation4_readback_mismatch", 503);
  }
  return {
    result: appended.classification === "receipt_replayed"
      ? "exact_replay"
      : resumed
        ? "ambiguous_recovered"
        : "activated",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationActivationDigestSha256:
      command.applicationActivationDigestSha256,
    operationStartedReceiptSha256:
      persistedStart.receipt_digest_sha256,
    operationTerminalReceiptSha256:
      appended.receipt.receipt_digest_sha256,
    receiptCount: appended.claim.ledger_version,
    receiptHeadSha256: appended.claim.ledger_head_sha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
  };
}

export async function activationOperationRequestDigest(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  command: ActivateTicketCommand,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    contract: ACTIVATE_TICKET_CONTRACT,
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
    operationOrdinal: 4,
    operationIdSha256: operation.operation_id_sha256,
    predecessorReceiptSha256:
      snapshot.receipts[0]?.receipt_digest_sha256 ?? "",
    applicationActivationDigestSha256:
      command.applicationActivationDigestSha256,
    activationRequestIdSha256: command.activationRequestIdSha256,
  })));
}

async function buildOperationReceipt(input: {
  snapshot: ExecutionClaimSnapshot;
  operation: ExecutionOperationRow;
  authentication: AuthenticatedRequest;
  command: ActivateTicketCommand;
  requestSha256: string;
  routeRequestIdSha256: string;
  readback?: ApplicationActivationReadback;
  eventKind: "operation_started" | "operation_terminal";
  outcome: "pending" | "exact_success" | "ambiguous_recovered";
}): Promise<ExecutionReceipt> {
  const claim = input.snapshot.claim;
  const receipt: Omit<ExecutionReceipt, "receiptDigestSha256"> = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: input.eventKind,
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    executionPlanSha256: claim.execution_plan_sha256,
    ledgerIdentitySha256: claim.ledger_identity_sha256,
    sequence: claim.ledger_version + 1,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    leaseGeneration: claim.lease_generation,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: claim.lease_owner_sha256,
    actorCredentialIdSha256:
      input.authentication.credentialIdSha256,
    requestIdSha256: input.routeRequestIdSha256,
    operationOrdinal: 4,
    operationIdSha256: input.operation.operation_id_sha256,
    operationKind: "activate_execution_ticket",
    shardIndex: null,
    outcome: input.outcome,
    requestSha256: input.requestSha256,
    responseSha256: input.eventKind === "operation_terminal"
      ? input.readback?.responseSha256 ?? null
      : null,
    evidenceSha256:
      input.command.applicationActivationDigestSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
  };
  return {
    ...receipt,
    receiptDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(receipt)),
    ),
  };
}

function requirePristineOperationFour(
  snapshot: ExecutionClaimSnapshot,
): void {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  if (
    claim.status !== "claimed"
    || claim.ledger_version !== 1
    || claim.last_completed_ordinal !== 3
    || claim.inflight_operation_ordinal !== null
    || claim.inflight_readback_only !== 0
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.ticket_activation_confirmed !== 0
    || claim.application_activation_digest_sha256 !== null
    || claim.enable_intent_seen !== 0
    || claim.disable_confirmed !== 1
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.permit_expires_at <= now
    || snapshot.receipts.length !== 1
    || snapshot.receipts[0]?.event_kind !== "claim_acquired"
    || snapshot.receipts[0]?.receipt_digest_sha256
      !== claim.claim_acquired_receipt_digest_sha256
  ) {
    throw new ProtocolError("operation4_claim_not_activatable", 409);
  }
}

function requireRecoverableOperationFour(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  requestSha256: string,
): void {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  if (
    claim.status !== "running"
    || claim.ledger_version !== 2
    || claim.last_completed_ordinal !== 3
    || claim.inflight_operation_ordinal !== 4
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_request_sha256 !== requestSha256
    || claim.lease_generation !== 1
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.ticket_activation_confirmed !== 0
    || claim.application_activation_digest_sha256 !== null
    || claim.enable_intent_seen !== 0
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.recovery_deadline_at <= now
  ) {
    throw new ProtocolError("operation4_claim_not_recoverable", 409);
  }
}

function requireOperationFour(
  snapshot: ExecutionClaimSnapshot,
): ExecutionOperationRow {
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === 4,
  );
  if (
    operation === undefined
    || operation.kind !== "activate_execution_ticket"
    || operation.shard_index !== null
  ) {
    throw new ProtocolError("operation4_schedule_mismatch", 409);
  }
  return operation;
}

function requireStartedReceipt(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  requestSha256: string,
  activationDigestSha256: string,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
): ExecutionReceiptRow {
  const receipt = snapshot.receipts.find(
    (candidate) =>
      candidate.event_kind === "operation_started"
      && candidate.operation_ordinal === 4,
  );
  if (
    receipt === undefined
    || receipt.sequence !== 2
    || receipt.operation_id_sha256 !== operation.operation_id_sha256
    || receipt.operation_kind !== "activate_execution_ticket"
    || receipt.shard_index !== null
    || receipt.request_sha256 !== requestSha256
    || receipt.response_sha256 !== null
    || receipt.evidence_sha256 !== activationDigestSha256
    || receipt.outcome !== "pending"
    || receipt.receipt_credential_id_sha256 !== credentialIdSha256
    || receipt.request_id_sha256 !== routeRequestIdSha256
  ) {
    throw new ProtocolError("operation4_start_mismatch", 409);
  }
  return receipt;
}

function exactTerminalReplay(
  snapshot: ExecutionClaimSnapshot,
  command: ActivateTicketCommand,
  operation: ExecutionOperationRow,
  requestSha256: string,
  authorityVersionId: string,
  credentialIdSha256: string,
  routeRequestIdSha256: string,
): ActivateTicketResult | null {
  if (
    snapshot.claim.last_completed_ordinal < 4
    && snapshot.claim.ticket_activation_confirmed !== 1
  ) return null;
  const started = requireStartedReceipt(
    snapshot,
    operation,
    requestSha256,
    command.applicationActivationDigestSha256,
    credentialIdSha256,
    routeRequestIdSha256,
  );
  const terminal = snapshot.receipts.find(
    (candidate) =>
      candidate.event_kind === "operation_terminal"
      && candidate.operation_ordinal === 4,
  );
  if (
    terminal === undefined
    || terminal.sequence !== 3
    || terminal.predecessor_receipt_sha256
      !== started.receipt_digest_sha256
    || terminal.operation_id_sha256 !== operation.operation_id_sha256
    || terminal.request_sha256 !== requestSha256
    || terminal.evidence_sha256
      !== command.applicationActivationDigestSha256
    || terminal.receipt_credential_id_sha256 !== credentialIdSha256
    || terminal.request_id_sha256 !== routeRequestIdSha256
    || !["exact_success", "exact_replay", "ambiguous_recovered"].includes(
      terminal.outcome,
    )
    || snapshot.claim.ticket_activation_confirmed !== 1
    || snapshot.claim.application_activation_digest_sha256
      !== command.applicationActivationDigestSha256
    || snapshot.claim.ledger_version < 3
  ) {
    throw new ProtocolError("operation4_replay_mismatch", 409);
  }
  return {
    result: "exact_replay",
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    applicationActivationDigestSha256:
      command.applicationActivationDigestSha256,
    operationStartedReceiptSha256: started.receipt_digest_sha256,
    operationTerminalReceiptSha256: terminal.receipt_digest_sha256,
    receiptCount: snapshot.claim.ledger_version,
    receiptHeadSha256: snapshot.claim.ledger_head_sha256,
    authorityVersionId,
  };
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
