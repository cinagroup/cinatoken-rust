import type { ExecutionReceipt } from "./execution_protocol";
import {
  readExactExecutionClaim,
  type ExecutionClaimRow,
  type ExecutionReceiptRow,
} from "./execution_repository";
import {
  RepositoryConflictError,
  RepositoryUnavailableError,
} from "./repository";

export const OPERATION_READINESS_ATTEMPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-readiness-attempt-v1";
export const OPERATION_READINESS_TERMINAL_CONTRACT =
  "cinatoken-shard-placement-authority-operation-readiness-terminal-v1";

const INSERT_RECEIPT_SQL = `
INSERT INTO shard_placement_authority_execution_receipts (
  authorization_id_sha256, sequence, event_kind,
  claim_digest_sha256, execution_plan_sha256,
  ledger_identity_sha256, operation_ordinal,
  operation_id_sha256, operation_kind, shard_index,
  predecessor_receipt_sha256, request_sha256, response_sha256,
  cloudflare_request_id_sha256, evidence_sha256, safety_reason,
  outcome, lease_owner_sha256, lease_token_sha256,
  lease_generation, lease_expires_at,
  receipt_credential_id_sha256, request_id_sha256,
  receipt_digest_sha256
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, claim.lease_expires_at,
  ?21, ?22, ?23
FROM shard_placement_authority_execution_claims AS claim
WHERE claim.authorization_id_sha256 = ?1
  AND claim.claim_digest_sha256 = ?4
  AND claim.execution_plan_sha256 = ?5
  AND claim.ledger_identity_sha256 = ?6
`.trim();

const INSERT_ATTEMPT_SQL = `
INSERT INTO shard_placement_authority_operation_readiness_attempts (
  authorization_id_sha256, operation_ordinal, shard_index,
  contract_version, attempt_contract, claim_digest_sha256,
  claim_owner_sha256, lease_owner_sha256, lease_token_sha256,
  lease_generation, execution_plan_sha256,
  operation_schedule_sha256, authority_database_identity_sha256,
  authority_ledger_identity_sha256, ledger_head_before_sha256,
  predecessor_receipt_sha256,
  operation_five_terminal_receipt_sha256,
  operation_id_sha256, operation_request_sha256, campaign_id,
  campaign_nonce_sha256, ring_generation, shard_count,
  instance_name, controller_service_name,
  controller_enabled_version_id, runtime_build_id,
  probe_id_sha256, attempt_generation, dispatch_mode,
  wake_attempt_limit, wake_retry_limit,
  missing_readback_allows_resend, probe_deadline_at_ms,
  authority_version_id, send_credential_id_sha256,
  send_request_id_sha256, attempt_digest_sha256,
  operation_start_receipt_digest_sha256
) VALUES (
  ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, 1, 'wake_once', 1, 0, 0, ?28, ?29, ?30, ?31, ?32, ?33
)
`.trim();

const SELECT_ATTEMPT_SQL = `
SELECT *
FROM shard_placement_authority_operation_readiness_attempts
WHERE authorization_id_sha256 = ?1
  AND operation_ordinal = ?2
LIMIT 1
`.trim();

const INSERT_TERMINAL_SQL = `
INSERT INTO shard_placement_authority_operation_readiness_terminals (
  authorization_id_sha256, operation_ordinal, shard_index,
  contract_version, terminal_contract, claim_digest_sha256,
  attempt_digest_sha256, operation_id_sha256, probe_id_sha256,
  operation_request_sha256, operation_start_receipt_digest_sha256,
  result_outcome, recovery_mode, controller_service_name,
  expected_controller_version_id, observed_controller_version_id,
  expected_runtime_build_id, observed_runtime_build_id,
  readiness_result_code, process_ready, execution_ready,
  runtime_execution_enabled, controller_execution_enabled,
  container_state, readiness_result_sha256,
  controller_response_sha256, controller_response_bytes,
  controller_request_id_sha256,
  terminal_writer_credential_id_sha256,
  terminal_writer_request_id_sha256,
  terminal_authority_version_id, terminal_evidence_sha256,
  generic_terminal_receipt_digest_sha256
) VALUES (
  ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, ?29, ?30, ?31, ?32
)
`.trim();

const SELECT_TERMINAL_SQL = `
SELECT *
FROM shard_placement_authority_operation_readiness_terminals
WHERE authorization_id_sha256 = ?1
  AND operation_ordinal = ?2
LIMIT 1
`.trim();

const SELECT_RECEIPT_SQL = `
SELECT *
FROM shard_placement_authority_execution_receipts
WHERE authorization_id_sha256 = ?1
  AND sequence = ?2
LIMIT 1
`.trim();

export interface OperationReadinessAttempt {
  authorizationIdSha256: string;
  operationOrdinal: number;
  shardIndex: number;
  attemptContract: typeof OPERATION_READINESS_ATTEMPT_CONTRACT;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  executionPlanSha256: string;
  operationScheduleSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  ledgerHeadBeforeSha256: string;
  predecessorReceiptSha256: string;
  operationFiveTerminalReceiptSha256: string;
  operationIdSha256: string;
  operationRequestSha256: string;
  campaignId: string;
  campaignNonceSha256: string;
  ringGeneration: number;
  shardCount: 8;
  instanceName: string;
  controllerServiceName: string;
  controllerEnabledVersionId: string;
  runtimeBuildId: string;
  probeIdSha256: string;
  probeDeadlineAtMs: number;
  authorityVersionId: string;
  sendCredentialIdSha256: string;
  sendRequestIdSha256: string;
  attemptDigestSha256: string;
  operationStartReceiptDigestSha256: string;
}

export interface OperationReadinessAttemptRow {
  authorization_id_sha256: string;
  operation_ordinal: number;
  shard_index: number;
  contract_version: number;
  attempt_contract: string;
  claim_digest_sha256: string;
  claim_owner_sha256: string;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  execution_plan_sha256: string;
  operation_schedule_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  ledger_head_before_sha256: string;
  predecessor_receipt_sha256: string;
  operation_five_terminal_receipt_sha256: string;
  operation_id_sha256: string;
  operation_request_sha256: string;
  campaign_id: string;
  campaign_nonce_sha256: string;
  ring_generation: number;
  shard_count: number;
  instance_name: string;
  controller_service_name: string;
  controller_enabled_version_id: string;
  runtime_build_id: string;
  probe_id_sha256: string;
  attempt_generation: number;
  dispatch_mode: string;
  wake_attempt_limit: number;
  wake_retry_limit: number;
  missing_readback_allows_resend: number;
  probe_deadline_at_ms: number;
  authority_version_id: string;
  send_credential_id_sha256: string;
  send_request_id_sha256: string;
  attempt_digest_sha256: string;
  operation_start_receipt_digest_sha256: string;
  recorded_at: number;
}

export interface OperationReadinessTerminal {
  authorizationIdSha256: string;
  operationOrdinal: number;
  shardIndex: number;
  terminalContract: typeof OPERATION_READINESS_TERMINAL_CONTRACT;
  claimDigestSha256: string;
  attemptDigestSha256: string;
  operationIdSha256: string;
  probeIdSha256: string;
  operationRequestSha256: string;
  operationStartReceiptDigestSha256: string;
  resultOutcome:
    | "exact_success"
    | "ambiguous_recovered"
    | "rejected"
    | "unresolved";
  recoveryMode: "fresh" | "readback_only";
  controllerServiceName: string;
  expectedControllerVersionId: string;
  observedControllerVersionId: string | null;
  expectedRuntimeBuildId: string;
  observedRuntimeBuildId: string | null;
  readinessResultCode: string | null;
  processReady: boolean | null;
  executionReady: boolean | null;
  runtimeExecutionEnabled: boolean | null;
  controllerExecutionEnabled: boolean | null;
  containerState: string | null;
  readinessResultSha256: string | null;
  controllerResponseSha256: string;
  controllerResponseBytes: number;
  controllerRequestIdSha256: string;
  terminalWriterCredentialIdSha256: string;
  terminalWriterRequestIdSha256: string;
  terminalAuthorityVersionId: string;
  terminalEvidenceSha256: string;
  genericTerminalReceiptDigestSha256: string;
}

export interface OperationReadinessTerminalRow {
  authorization_id_sha256: string;
  operation_ordinal: number;
  shard_index: number;
  contract_version: number;
  terminal_contract: string;
  claim_digest_sha256: string;
  attempt_digest_sha256: string;
  operation_id_sha256: string;
  probe_id_sha256: string;
  operation_request_sha256: string;
  operation_start_receipt_digest_sha256: string;
  result_outcome: string;
  recovery_mode: string;
  controller_service_name: string;
  expected_controller_version_id: string;
  observed_controller_version_id: string | null;
  expected_runtime_build_id: string;
  observed_runtime_build_id: string | null;
  readiness_result_code: string | null;
  process_ready: number | null;
  execution_ready: number | null;
  runtime_execution_enabled: number | null;
  controller_execution_enabled: number | null;
  container_state: string | null;
  readiness_result_sha256: string | null;
  controller_response_sha256: string;
  controller_response_bytes: number;
  controller_request_id_sha256: string;
  terminal_writer_credential_id_sha256: string;
  terminal_writer_request_id_sha256: string;
  terminal_authority_version_id: string;
  terminal_evidence_sha256: string;
  generic_terminal_receipt_digest_sha256: string;
  recorded_at: number;
}

export async function createOperationReadinessAttempt(
  database: D1Database,
  attempt: OperationReadinessAttempt,
  receipt: ExecutionReceipt,
): Promise<{
  classification: "created" | "exact_replay";
  attempt: OperationReadinessAttemptRow;
  receipt: ExecutionReceiptRow;
  claim: ExecutionClaimRow;
}> {
  requireAttemptReceiptMatch(attempt, receipt);
  const session = database.withSession("first-primary");
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      attemptInsertStatement(session, attempt),
      receiptInsertStatement(session, receipt),
    ]);
    writeOutcome =
      results.length === 2
      && results.every((result) =>
        result.success === true && (result.meta?.changes ?? 0) > 0
      )
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persistedAttempt = await readAttempt(
    session,
    attempt.authorizationIdSha256,
    attempt.operationOrdinal,
  );
  const persistedReceipt = await readReceipt(
    session,
    attempt.authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persistedAttempt === null
    || persistedReceipt === null
    || !matchesAttempt(persistedAttempt, attempt)
    || !matchesReceipt(
      persistedReceipt,
      receipt,
      attempt.sendCredentialIdSha256,
    )
  ) {
    if (writeOutcome === "unknown") {
      throw new RepositoryUnavailableError(true);
    }
    throw new RepositoryConflictError(
      "operation_readiness_attempt_conflict",
    );
  }
  const snapshot = await readExactExecutionClaim(
    database,
    attempt.authorizationIdSha256,
    attempt.claimDigestSha256,
    attempt.claimOwnerSha256,
  );
  if (
    snapshot.claim.ledger_version !== receipt.sequence
    || snapshot.claim.ledger_head_sha256
      !== receipt.receiptDigestSha256
    || snapshot.claim.inflight_operation_ordinal
      !== attempt.operationOrdinal
    || snapshot.claim.inflight_operation_id_sha256
      !== attempt.operationIdSha256
    || snapshot.claim.inflight_request_sha256
      !== attempt.operationRequestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    attempt: persistedAttempt,
    receipt: persistedReceipt,
    claim: snapshot.claim,
  };
}

export async function createOperationReadinessTerminal(
  database: D1Database,
  terminal: OperationReadinessTerminal,
  receipt: ExecutionReceipt,
  claimOwnerSha256: string,
): Promise<{
  classification: "created" | "exact_replay";
  terminal: OperationReadinessTerminalRow;
  receipt: ExecutionReceiptRow;
  claim: ExecutionClaimRow;
}> {
  requireTerminalReceiptMatch(terminal, receipt);
  const session = database.withSession("first-primary");
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      terminalInsertStatement(session, terminal),
      receiptInsertStatement(session, receipt),
    ]);
    writeOutcome =
      results.length === 2
      && results.every((result) =>
        result.success === true && (result.meta?.changes ?? 0) > 0
      )
        ? "created"
        : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persistedTerminal = await readTerminal(
    session,
    terminal.authorizationIdSha256,
    terminal.operationOrdinal,
  );
  const persistedReceipt = await readReceipt(
    session,
    terminal.authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persistedTerminal === null
    || persistedReceipt === null
    || !matchesTerminal(persistedTerminal, terminal)
    || !matchesReceipt(
      persistedReceipt,
      receipt,
      terminal.terminalWriterCredentialIdSha256,
    )
  ) {
    if (writeOutcome === "unknown") {
      throw new RepositoryUnavailableError(true);
    }
    throw new RepositoryConflictError(
      "operation_readiness_terminal_conflict",
    );
  }
  const snapshot = await readExactExecutionClaim(
    database,
    terminal.authorizationIdSha256,
    terminal.claimDigestSha256,
    claimOwnerSha256,
  );
  const success =
    terminal.resultOutcome === "exact_success"
    || terminal.resultOutcome === "ambiguous_recovered";
  if (
    snapshot.claim.ledger_version !== receipt.sequence
    || snapshot.claim.ledger_head_sha256
      !== receipt.receiptDigestSha256
    || snapshot.claim.inflight_operation_ordinal !== null
    || (
      success
        ? snapshot.claim.last_completed_ordinal
          !== terminal.operationOrdinal
        : snapshot.claim.status !== "disable_required"
    )
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    terminal: persistedTerminal,
    receipt: persistedReceipt,
    claim: snapshot.claim,
  };
}

export async function readOperationReadinessEvidence(
  database: D1Database,
  authorizationIdSha256: string,
  operationOrdinal: number,
): Promise<{
  attempt: OperationReadinessAttemptRow | null;
  terminal: OperationReadinessTerminalRow | null;
}> {
  const session = database.withSession("first-primary");
  return {
    attempt: await readAttempt(
      session,
      authorizationIdSha256,
      operationOrdinal,
    ),
    terminal: await readTerminal(
      session,
      authorizationIdSha256,
      operationOrdinal,
    ),
  };
}

export async function readOperationReadinessDatabaseNow(
  database: D1Database,
): Promise<number> {
  const session = database.withSession("first-primary");
  try {
    const row = await session
      .prepare("SELECT unixepoch() AS database_now")
      .first<{ database_now: number }>();
    if (
      row === null
      || !Number.isSafeInteger(row.database_now)
      || row.database_now <= 0
    ) {
      throw new Error("invalid_database_clock");
    }
    return row.database_now;
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function attemptInsertStatement(
  session: D1DatabaseSession,
  attempt: OperationReadinessAttempt,
): D1PreparedStatement {
  return session.prepare(INSERT_ATTEMPT_SQL).bind(
    attempt.authorizationIdSha256,
    attempt.operationOrdinal,
    attempt.shardIndex,
    attempt.attemptContract,
    attempt.claimDigestSha256,
    attempt.claimOwnerSha256,
    attempt.leaseOwnerSha256,
    attempt.leaseTokenSha256,
    attempt.leaseGeneration,
    attempt.executionPlanSha256,
    attempt.operationScheduleSha256,
    attempt.authorityDatabaseIdentitySha256,
    attempt.authorityLedgerIdentitySha256,
    attempt.ledgerHeadBeforeSha256,
    attempt.predecessorReceiptSha256,
    attempt.operationFiveTerminalReceiptSha256,
    attempt.operationIdSha256,
    attempt.operationRequestSha256,
    attempt.campaignId,
    attempt.campaignNonceSha256,
    attempt.ringGeneration,
    attempt.shardCount,
    attempt.instanceName,
    attempt.controllerServiceName,
    attempt.controllerEnabledVersionId,
    attempt.runtimeBuildId,
    attempt.probeIdSha256,
    attempt.probeDeadlineAtMs,
    attempt.authorityVersionId,
    attempt.sendCredentialIdSha256,
    attempt.sendRequestIdSha256,
    attempt.attemptDigestSha256,
    attempt.operationStartReceiptDigestSha256,
  );
}

function terminalInsertStatement(
  session: D1DatabaseSession,
  terminal: OperationReadinessTerminal,
): D1PreparedStatement {
  return session.prepare(INSERT_TERMINAL_SQL).bind(
    terminal.authorizationIdSha256,
    terminal.operationOrdinal,
    terminal.shardIndex,
    terminal.terminalContract,
    terminal.claimDigestSha256,
    terminal.attemptDigestSha256,
    terminal.operationIdSha256,
    terminal.probeIdSha256,
    terminal.operationRequestSha256,
    terminal.operationStartReceiptDigestSha256,
    terminal.resultOutcome,
    terminal.recoveryMode,
    terminal.controllerServiceName,
    terminal.expectedControllerVersionId,
    terminal.observedControllerVersionId,
    terminal.expectedRuntimeBuildId,
    terminal.observedRuntimeBuildId,
    terminal.readinessResultCode,
    nullableBoolean(terminal.processReady),
    nullableBoolean(terminal.executionReady),
    nullableBoolean(terminal.runtimeExecutionEnabled),
    nullableBoolean(terminal.controllerExecutionEnabled),
    terminal.containerState,
    terminal.readinessResultSha256,
    terminal.controllerResponseSha256,
    terminal.controllerResponseBytes,
    terminal.controllerRequestIdSha256,
    terminal.terminalWriterCredentialIdSha256,
    terminal.terminalWriterRequestIdSha256,
    terminal.terminalAuthorityVersionId,
    terminal.terminalEvidenceSha256,
    terminal.genericTerminalReceiptDigestSha256,
  );
}

function receiptInsertStatement(
  session: D1DatabaseSession,
  receipt: ExecutionReceipt,
): D1PreparedStatement {
  return session.prepare(INSERT_RECEIPT_SQL).bind(
    receipt.authorizationIdSha256,
    receipt.sequence,
    receipt.eventKind,
    receipt.claimDigestSha256,
    receipt.executionPlanSha256,
    receipt.ledgerIdentitySha256,
    receipt.operationOrdinal,
    receipt.operationIdSha256,
    receipt.operationKind,
    receipt.shardIndex,
    receipt.predecessorReceiptSha256,
    receipt.requestSha256,
    receipt.responseSha256,
    receipt.cloudflareRequestIdSha256,
    receipt.evidenceSha256,
    receipt.safetyReason,
    receipt.outcome,
    receipt.actorOwnerSha256,
    receipt.leaseTokenSha256,
    receipt.leaseGeneration,
    receipt.actorCredentialIdSha256,
    receipt.requestIdSha256,
    receipt.receiptDigestSha256,
  );
}

async function readAttempt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  operationOrdinal: number,
): Promise<OperationReadinessAttemptRow | null> {
  try {
    return await session
      .prepare(SELECT_ATTEMPT_SQL)
      .bind(authorizationIdSha256, operationOrdinal)
      .first<OperationReadinessAttemptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readTerminal(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  operationOrdinal: number,
): Promise<OperationReadinessTerminalRow | null> {
  try {
    return await session
      .prepare(SELECT_TERMINAL_SQL)
      .bind(authorizationIdSha256, operationOrdinal)
      .first<OperationReadinessTerminalRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readReceipt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  sequence: number,
): Promise<ExecutionReceiptRow | null> {
  try {
    return await session
      .prepare(SELECT_RECEIPT_SQL)
      .bind(authorizationIdSha256, sequence)
      .first<ExecutionReceiptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function requireAttemptReceiptMatch(
  attempt: OperationReadinessAttempt,
  receipt: ExecutionReceipt,
): void {
  if (
    receipt.eventKind !== "operation_started"
    || receipt.operationOrdinal !== attempt.operationOrdinal
    || receipt.shardIndex !== attempt.shardIndex
    || receipt.operationKind !== "probe_shard_readiness"
    || receipt.authorizationIdSha256 !== attempt.authorizationIdSha256
    || receipt.claimDigestSha256 !== attempt.claimDigestSha256
    || receipt.executionPlanSha256 !== attempt.executionPlanSha256
    || receipt.ledgerIdentitySha256
      !== attempt.authorityLedgerIdentitySha256
    || receipt.predecessorReceiptSha256
      !== attempt.predecessorReceiptSha256
    || receipt.operationIdSha256 !== attempt.operationIdSha256
    || receipt.requestSha256 !== attempt.operationRequestSha256
    || receipt.responseSha256 !== null
    || receipt.outcome !== "pending"
    || receipt.actorOwnerSha256 !== attempt.leaseOwnerSha256
    || receipt.leaseTokenSha256 !== attempt.leaseTokenSha256
    || receipt.leaseGeneration !== attempt.leaseGeneration
    || receipt.actorCredentialIdSha256
      !== attempt.sendCredentialIdSha256
    || receipt.requestIdSha256 !== attempt.sendRequestIdSha256
    || receipt.receiptDigestSha256
      !== attempt.operationStartReceiptDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_readiness_attempt_receipt_mismatch",
    );
  }
}

function requireTerminalReceiptMatch(
  terminal: OperationReadinessTerminal,
  receipt: ExecutionReceipt,
): void {
  if (
    receipt.eventKind !== "operation_terminal"
    || receipt.operationOrdinal !== terminal.operationOrdinal
    || receipt.shardIndex !== terminal.shardIndex
    || receipt.operationKind !== "probe_shard_readiness"
    || receipt.authorizationIdSha256 !== terminal.authorizationIdSha256
    || receipt.claimDigestSha256 !== terminal.claimDigestSha256
    || receipt.operationIdSha256 !== terminal.operationIdSha256
    || receipt.predecessorReceiptSha256
      !== terminal.operationStartReceiptDigestSha256
    || receipt.requestSha256 !== terminal.operationRequestSha256
    || receipt.responseSha256 !== terminal.controllerResponseSha256
    || receipt.evidenceSha256 !== terminal.terminalEvidenceSha256
    || receipt.outcome !== terminal.resultOutcome
    || receipt.actorCredentialIdSha256
      !== terminal.terminalWriterCredentialIdSha256
    || receipt.requestIdSha256
      !== terminal.terminalWriterRequestIdSha256
    || receipt.receiptDigestSha256
      !== terminal.genericTerminalReceiptDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_readiness_terminal_receipt_mismatch",
    );
  }
}

function matchesAttempt(
  row: OperationReadinessAttemptRow,
  value: OperationReadinessAttempt,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.operation_ordinal === value.operationOrdinal
    && row.shard_index === value.shardIndex
    && row.contract_version === 1
    && row.attempt_contract === value.attemptContract
    && row.claim_digest_sha256 === value.claimDigestSha256
    && row.claim_owner_sha256 === value.claimOwnerSha256
    && row.lease_owner_sha256 === value.leaseOwnerSha256
    && row.lease_token_sha256 === value.leaseTokenSha256
    && row.lease_generation === value.leaseGeneration
    && row.execution_plan_sha256 === value.executionPlanSha256
    && row.operation_schedule_sha256 === value.operationScheduleSha256
    && row.authority_database_identity_sha256
      === value.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === value.authorityLedgerIdentitySha256
    && row.ledger_head_before_sha256 === value.ledgerHeadBeforeSha256
    && row.predecessor_receipt_sha256
      === value.predecessorReceiptSha256
    && row.operation_five_terminal_receipt_sha256
      === value.operationFiveTerminalReceiptSha256
    && row.operation_id_sha256 === value.operationIdSha256
    && row.operation_request_sha256 === value.operationRequestSha256
    && row.campaign_id === value.campaignId
    && row.campaign_nonce_sha256 === value.campaignNonceSha256
    && row.ring_generation === value.ringGeneration
    && row.shard_count === value.shardCount
    && row.instance_name === value.instanceName
    && row.controller_service_name === value.controllerServiceName
    && row.controller_enabled_version_id
      === value.controllerEnabledVersionId
    && row.runtime_build_id === value.runtimeBuildId
    && row.probe_id_sha256 === value.probeIdSha256
    && row.attempt_generation === 1
    && row.dispatch_mode === "wake_once"
    && row.wake_attempt_limit === 1
    && row.wake_retry_limit === 0
    && row.missing_readback_allows_resend === 0
    && row.probe_deadline_at_ms === value.probeDeadlineAtMs
    && row.authority_version_id === value.authorityVersionId
    && row.send_credential_id_sha256 === value.sendCredentialIdSha256
    && row.send_request_id_sha256 === value.sendRequestIdSha256
    && row.attempt_digest_sha256 === value.attemptDigestSha256
    && row.operation_start_receipt_digest_sha256
      === value.operationStartReceiptDigestSha256
  );
}

function matchesTerminal(
  row: OperationReadinessTerminalRow,
  value: OperationReadinessTerminal,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.operation_ordinal === value.operationOrdinal
    && row.shard_index === value.shardIndex
    && row.contract_version === 1
    && row.terminal_contract === value.terminalContract
    && row.claim_digest_sha256 === value.claimDigestSha256
    && row.attempt_digest_sha256 === value.attemptDigestSha256
    && row.operation_id_sha256 === value.operationIdSha256
    && row.probe_id_sha256 === value.probeIdSha256
    && row.operation_request_sha256 === value.operationRequestSha256
    && row.operation_start_receipt_digest_sha256
      === value.operationStartReceiptDigestSha256
    && row.result_outcome === value.resultOutcome
    && row.recovery_mode === value.recoveryMode
    && row.controller_service_name === value.controllerServiceName
    && row.expected_controller_version_id
      === value.expectedControllerVersionId
    && row.observed_controller_version_id
      === value.observedControllerVersionId
    && row.expected_runtime_build_id === value.expectedRuntimeBuildId
    && row.observed_runtime_build_id === value.observedRuntimeBuildId
    && row.readiness_result_code === value.readinessResultCode
    && row.process_ready === nullableBoolean(value.processReady)
    && row.execution_ready === nullableBoolean(value.executionReady)
    && row.runtime_execution_enabled
      === nullableBoolean(value.runtimeExecutionEnabled)
    && row.controller_execution_enabled
      === nullableBoolean(value.controllerExecutionEnabled)
    && row.container_state === value.containerState
    && row.readiness_result_sha256 === value.readinessResultSha256
    && row.controller_response_sha256 === value.controllerResponseSha256
    && row.controller_response_bytes === value.controllerResponseBytes
    && row.controller_request_id_sha256
      === value.controllerRequestIdSha256
    && row.terminal_writer_credential_id_sha256
      === value.terminalWriterCredentialIdSha256
    && row.terminal_writer_request_id_sha256
      === value.terminalWriterRequestIdSha256
    && row.terminal_authority_version_id
      === value.terminalAuthorityVersionId
    && row.terminal_evidence_sha256 === value.terminalEvidenceSha256
    && row.generic_terminal_receipt_digest_sha256
      === value.genericTerminalReceiptDigestSha256
  );
}

function matchesReceipt(
  row: ExecutionReceiptRow,
  value: ExecutionReceipt,
  credentialIdSha256: string,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.sequence === value.sequence
    && row.event_kind === value.eventKind
    && row.claim_digest_sha256 === value.claimDigestSha256
    && row.execution_plan_sha256 === value.executionPlanSha256
    && row.ledger_identity_sha256 === value.ledgerIdentitySha256
    && row.operation_ordinal === value.operationOrdinal
    && row.operation_id_sha256 === value.operationIdSha256
    && row.operation_kind === value.operationKind
    && row.shard_index === value.shardIndex
    && row.predecessor_receipt_sha256
      === value.predecessorReceiptSha256
    && row.request_sha256 === value.requestSha256
    && row.response_sha256 === value.responseSha256
    && row.cloudflare_request_id_sha256
      === value.cloudflareRequestIdSha256
    && row.evidence_sha256 === value.evidenceSha256
    && row.safety_reason === value.safetyReason
    && row.outcome === value.outcome
    && row.lease_owner_sha256 === value.actorOwnerSha256
    && row.lease_token_sha256 === value.leaseTokenSha256
    && row.lease_generation === value.leaseGeneration
    && row.receipt_credential_id_sha256 === credentialIdSha256
    && row.request_id_sha256 === value.requestIdSha256
    && row.receipt_digest_sha256 === value.receiptDigestSha256
  );
}

function nullableBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}
