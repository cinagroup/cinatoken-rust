import type { ExecutionReceipt } from "./execution_protocol";
import type {
  ExecutionClaimRow,
  ExecutionReceiptRow,
} from "./execution_repository";
import {
  RepositoryConflictError,
  RepositoryUnavailableError,
} from "./repository";

export const OPERATION_FOURTEEN_ATTEMPT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-fourteen-attempt-v1";
export const OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-fourteen-gateway-event-v1";
export const OPERATION_FOURTEEN_TERMINAL_CONTRACT =
  "cinatoken-shard-placement-authority-operation-fourteen-terminal-v1";
export const OPERATION_FOURTEEN_DISPATCH_SEMANTICS =
  "authority_persisted_network_may_not_have_occurred";

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
INSERT INTO shard_placement_authority_operation_fourteen_attempts (
  authorization_id_sha256, operation_ordinal, contract_version,
  attempt_contract, claim_digest_sha256, claim_owner_sha256,
  lease_owner_sha256, lease_token_sha256, lease_generation,
  execution_plan_sha256, operation_schedule_sha256,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, ledger_version_before,
  ledger_head_before_sha256, operation_start_sequence,
  operation_five_terminal_receipt_sha256,
  operation_five_send_attempt_digest_sha256,
  operation_id_sha256, operation_request_sha256,
  controller_service_name, controller_enabled_source_version_id,
  controller_baseline_target_version_id,
  authority_command_contract, authority_command_digest_sha256,
  gateway_command_contract, gateway_command_digest_sha256,
  gateway_idempotency_contract, gateway_idempotency_key_sha256,
  gateway_create_credential_id_sha256,
  gateway_create_request_id_sha256,
  gateway_status_credential_id_sha256,
  gateway_status_request_id_sha256,
  authority_version_id, expected_gateway_version_id,
  disable_deadline_at, mutation_attempt_limit, retry_limit,
  missing_readback_allows_resend, attempt_digest_sha256,
  operation_start_receipt_digest_sha256,
  disable_dispatched_event_digest_sha256
) VALUES (
  ?1, 14, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
  ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
  ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, 1, 0, 0,
  ?35, ?36, ?37
)
`.trim();

const INSERT_GATEWAY_EVENT_SQL = `
INSERT INTO shard_placement_authority_operation_fourteen_gateway_events (
  authorization_id_sha256, attempt_digest_sha256, event_sequence,
  contract_version, event_contract, event_kind, dispatch_semantics,
  credential_role, credential_id_sha256, request_id_sha256,
  authority_command_digest_sha256, gateway_command_digest_sha256,
  gateway_idempotency_key_sha256, controller_service_name,
  controller_baseline_target_version_id,
  expected_gateway_version_id, observed_gateway_version_id,
  observed_controller_version_id, status_classification,
  gateway_http_status, gateway_response_sha256,
  gateway_response_bytes, cloudflare_request_id_sha256,
  deployment_set_sha256, observation_digest_sha256,
  stability_minimum_seconds, predecessor_event_digest_sha256,
  event_digest_sha256
) VALUES (
  ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27
)
`.trim();

const INSERT_TERMINAL_SQL = `
INSERT INTO shard_placement_authority_operation_fourteen_terminals (
  authorization_id_sha256, operation_ordinal, contract_version,
  terminal_contract, claim_digest_sha256, claim_owner_sha256,
  attempt_lease_owner_sha256, attempt_lease_token_sha256,
  attempt_lease_generation,
  lease_owner_sha256, lease_token_sha256, lease_generation,
  execution_plan_sha256, operation_schedule_sha256,
  authority_database_identity_sha256,
  authority_ledger_identity_sha256, attempt_digest_sha256,
  operation_id_sha256, operation_request_sha256,
  operation_start_receipt_digest_sha256, controller_service_name,
  controller_enabled_source_version_id,
  controller_baseline_target_version_id,
  authority_command_digest_sha256, gateway_command_digest_sha256,
  gateway_idempotency_key_sha256, terminal_event_sequence,
  terminal_event_digest_sha256, terminal_event_kind,
  terminal_event_response_sha256, terminal_event_request_id_sha256,
  terminal_event_cloudflare_request_id_sha256,
  terminal_event_observation_digest_sha256,
  terminal_event_deployment_set_sha256, result_outcome,
  recovery_mode, terminal_response_sha256, terminal_evidence_sha256,
  authority_terminal_version_id,
  terminal_writer_credential_id_sha256,
  terminal_writer_request_id_sha256, ledger_version_before,
  ledger_head_before_sha256, generic_receipt_sequence,
  generic_terminal_receipt_digest_sha256
) VALUES (
  ?1, 14, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
  ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
  ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36,
  ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44
)
`.trim();

const SELECT_ATTEMPT_SQL = `
SELECT *
FROM shard_placement_authority_operation_fourteen_attempts
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const SELECT_GATEWAY_EVENT_SQL = `
SELECT *
FROM shard_placement_authority_operation_fourteen_gateway_events
WHERE attempt_digest_sha256 = ?1
  AND event_sequence = ?2
LIMIT 1
`.trim();

const SELECT_GATEWAY_EVENTS_SQL = `
SELECT *
FROM shard_placement_authority_operation_fourteen_gateway_events
WHERE attempt_digest_sha256 = ?1
ORDER BY event_sequence
`.trim();

const SELECT_TERMINAL_SQL = `
SELECT *
FROM shard_placement_authority_operation_fourteen_terminals
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

const SELECT_RECEIPT_SQL = `
SELECT *
FROM shard_placement_authority_execution_receipts
WHERE authorization_id_sha256 = ?1
  AND sequence = ?2
LIMIT 1
`.trim();

const SELECT_CLAIM_SQL = `
SELECT *
FROM shard_placement_authority_execution_claims
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

export type OperationFourteenGatewayEventKind =
  | "disable_dispatched"
  | "mutation_accepted"
  | "mutation_rejected"
  | "mutation_unknown"
  | "status_target"
  | "status_drift"
  | "status_unknown"
  | "stable_disabled";

export interface OperationFourteenAttempt {
  authorizationIdSha256: string;
  attemptContract: typeof OPERATION_FOURTEEN_ATTEMPT_CONTRACT;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: number;
  executionPlanSha256: string;
  operationScheduleSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  ledgerVersionBefore: number;
  ledgerHeadBeforeSha256: string;
  operationStartSequence: number;
  operationFiveTerminalReceiptSha256: string;
  operationFiveSendAttemptDigestSha256: string;
  operationIdSha256: string;
  operationRequestSha256: string;
  controllerServiceName: string;
  controllerEnabledSourceVersionId: string;
  controllerBaselineTargetVersionId: string;
  authorityCommandContract:
    "cinatoken-shard-placement-authority-disable-command-v1";
  authorityCommandDigestSha256: string;
  gatewayCommandContract:
    "cinatoken-controller-deployment-gateway-disable-command-v1";
  gatewayCommandDigestSha256: string;
  gatewayIdempotencyContract:
    "cinatoken-controller-deployment-gateway-disable-idempotency-v1";
  gatewayIdempotencyKeySha256: string;
  gatewayCreateCredentialIdSha256: string;
  gatewayCreateRequestIdSha256: string;
  gatewayStatusCredentialIdSha256: string;
  gatewayStatusRequestIdSha256: string;
  authorityVersionId: string;
  expectedGatewayVersionId: string;
  disableDeadlineAt: number;
  attemptDigestSha256: string;
  operationStartReceiptDigestSha256: string;
  disableDispatchedEventDigestSha256: string;
}

export interface OperationFourteenAttemptRow {
  authorization_id_sha256: string;
  operation_ordinal: number;
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
  ledger_version_before: number;
  ledger_head_before_sha256: string;
  operation_start_sequence: number;
  operation_five_terminal_receipt_sha256: string;
  operation_five_send_attempt_digest_sha256: string;
  operation_id_sha256: string;
  operation_request_sha256: string;
  controller_service_name: string;
  controller_enabled_source_version_id: string;
  controller_baseline_target_version_id: string;
  authority_command_contract: string;
  authority_command_digest_sha256: string;
  gateway_command_contract: string;
  gateway_command_digest_sha256: string;
  gateway_idempotency_contract: string;
  gateway_idempotency_key_sha256: string;
  gateway_create_credential_id_sha256: string;
  gateway_create_request_id_sha256: string;
  gateway_status_credential_id_sha256: string;
  gateway_status_request_id_sha256: string;
  authority_version_id: string;
  expected_gateway_version_id: string;
  disable_deadline_at: number;
  mutation_attempt_limit: number;
  retry_limit: number;
  missing_readback_allows_resend: number;
  attempt_digest_sha256: string;
  operation_start_receipt_digest_sha256: string;
  disable_dispatched_event_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFourteenGatewayEvent {
  authorizationIdSha256: string;
  attemptDigestSha256: string;
  eventSequence: number;
  eventContract: typeof OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT;
  eventKind: OperationFourteenGatewayEventKind;
  dispatchSemantics: typeof OPERATION_FOURTEEN_DISPATCH_SEMANTICS;
  credentialRole: "disable_create" | "disable_status";
  credentialIdSha256: string;
  requestIdSha256: string;
  authorityCommandDigestSha256: string;
  gatewayCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  controllerServiceName: string;
  controllerBaselineTargetVersionId: string;
  expectedGatewayVersionId: string;
  observedGatewayVersionId: string | null;
  observedControllerVersionId: string | null;
  statusClassification:
    | "target_observed"
    | "drift_observed"
    | "unknown"
    | null;
  gatewayHttpStatus: number | null;
  gatewayResponseSha256: string | null;
  gatewayResponseBytes: number | null;
  cloudflareRequestIdSha256: string | null;
  deploymentSetSha256: string | null;
  observationDigestSha256: string | null;
  stabilityMinimumSeconds: number | null;
  predecessorEventDigestSha256: string;
  eventDigestSha256: string;
}

export interface OperationFourteenGatewayEventRow {
  authorization_id_sha256: string;
  attempt_digest_sha256: string;
  event_sequence: number;
  contract_version: number;
  event_contract: string;
  event_kind: string;
  dispatch_semantics: string;
  credential_role: string;
  credential_id_sha256: string;
  request_id_sha256: string;
  authority_command_digest_sha256: string;
  gateway_command_digest_sha256: string;
  gateway_idempotency_key_sha256: string;
  controller_service_name: string;
  controller_baseline_target_version_id: string;
  expected_gateway_version_id: string;
  observed_gateway_version_id: string | null;
  observed_controller_version_id: string | null;
  status_classification: string | null;
  gateway_http_status: number | null;
  gateway_response_sha256: string | null;
  gateway_response_bytes: number | null;
  cloudflare_request_id_sha256: string | null;
  deployment_set_sha256: string | null;
  observation_digest_sha256: string | null;
  stability_minimum_seconds: number | null;
  predecessor_event_digest_sha256: string;
  event_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFourteenTerminal {
  authorizationIdSha256: string;
  terminalContract: typeof OPERATION_FOURTEEN_TERMINAL_CONTRACT;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  attemptLeaseOwnerSha256: string;
  attemptLeaseTokenSha256: string;
  attemptLeaseGeneration: number;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: number;
  executionPlanSha256: string;
  operationScheduleSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  attemptDigestSha256: string;
  operationIdSha256: string;
  operationRequestSha256: string;
  operationStartReceiptDigestSha256: string;
  controllerServiceName: string;
  controllerEnabledSourceVersionId: string;
  controllerBaselineTargetVersionId: string;
  authorityCommandDigestSha256: string;
  gatewayCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  terminalEventSequence: number;
  terminalEventDigestSha256: string;
  terminalEventKind:
    | "mutation_rejected"
    | "mutation_unknown"
    | "status_drift"
    | "status_unknown"
    | "stable_disabled";
  terminalEventResponseSha256: string | null;
  terminalEventRequestIdSha256: string;
  terminalEventCloudflareRequestIdSha256: string | null;
  terminalEventObservationDigestSha256: string | null;
  terminalEventDeploymentSetSha256: string | null;
  resultOutcome:
    | "exact_success"
    | "ambiguous_recovered"
    | "rejected"
    | "unresolved";
  recoveryMode: "fresh" | "readback_only";
  terminalResponseSha256: string;
  terminalEvidenceSha256: string;
  authorityTerminalVersionId: string;
  terminalWriterCredentialIdSha256: string;
  terminalWriterRequestIdSha256: string;
  ledgerVersionBefore: number;
  ledgerHeadBeforeSha256: string;
  genericReceiptSequence: number;
  genericTerminalReceiptDigestSha256: string;
}

export interface OperationFourteenTerminalRow {
  authorization_id_sha256: string;
  operation_ordinal: number;
  contract_version: number;
  terminal_contract: string;
  claim_digest_sha256: string;
  claim_owner_sha256: string;
  attempt_lease_owner_sha256: string;
  attempt_lease_token_sha256: string;
  attempt_lease_generation: number;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  execution_plan_sha256: string;
  operation_schedule_sha256: string;
  authority_database_identity_sha256: string;
  authority_ledger_identity_sha256: string;
  attempt_digest_sha256: string;
  operation_id_sha256: string;
  operation_request_sha256: string;
  operation_start_receipt_digest_sha256: string;
  controller_service_name: string;
  controller_enabled_source_version_id: string;
  controller_baseline_target_version_id: string;
  authority_command_digest_sha256: string;
  gateway_command_digest_sha256: string;
  gateway_idempotency_key_sha256: string;
  terminal_event_sequence: number;
  terminal_event_digest_sha256: string;
  terminal_event_kind: string;
  terminal_event_response_sha256: string | null;
  terminal_event_request_id_sha256: string;
  terminal_event_cloudflare_request_id_sha256: string | null;
  terminal_event_observation_digest_sha256: string | null;
  terminal_event_deployment_set_sha256: string | null;
  result_outcome: string;
  recovery_mode: string;
  terminal_response_sha256: string;
  terminal_evidence_sha256: string;
  authority_terminal_version_id: string;
  terminal_writer_credential_id_sha256: string;
  terminal_writer_request_id_sha256: string;
  ledger_version_before: number;
  ledger_head_before_sha256: string;
  generic_receipt_sequence: number;
  generic_terminal_receipt_digest_sha256: string;
  recorded_at: number;
}

export interface OperationFourteenEvidence {
  attempt: OperationFourteenAttemptRow | null;
  gatewayEvents: OperationFourteenGatewayEventRow[];
  terminal: OperationFourteenTerminalRow | null;
}

export async function readOperationFourteenEvidence(
  database: D1Database,
  authorizationIdSha256: string,
): Promise<OperationFourteenEvidence> {
  const session = database.withSession("first-primary");
  const attempt = await readAttempt(session, authorizationIdSha256);
  return {
    attempt,
    gatewayEvents: attempt === null
      ? []
      : await readGatewayEvents(session, attempt.attempt_digest_sha256),
    terminal: await readTerminal(session, authorizationIdSha256),
  };
}

export async function createOperationFourteenAttemptTriple(
  database: D1Database,
  attempt: OperationFourteenAttempt,
  receipt: ExecutionReceipt,
  dispatchEvent: OperationFourteenGatewayEvent,
): Promise<{
  classification: "created" | "exact_replay";
  attempt: OperationFourteenAttemptRow;
  receipt: ExecutionReceiptRow;
  dispatchEvent: OperationFourteenGatewayEventRow;
  claim: ExecutionClaimRow;
}> {
  requireAttemptTripleMatch(attempt, receipt, dispatchEvent);
  const session = database.withSession("first-primary");
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      attemptInsertStatement(session, attempt),
      receiptInsertStatement(session, receipt),
      gatewayEventInsertStatement(session, dispatchEvent),
    ]);
    writeOutcome = exactWrite(results, 3) ? "created" : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persistedAttempt = await readAttempt(
    session,
    attempt.authorizationIdSha256,
  );
  const persistedReceipt = await readReceipt(
    session,
    attempt.authorizationIdSha256,
    receipt.sequence,
  );
  const persistedEvent = await readGatewayEvent(
    session,
    attempt.attemptDigestSha256,
    1,
  );
  if (
    persistedAttempt === null
    || persistedReceipt === null
    || persistedEvent === null
    || !matchesAttempt(persistedAttempt, attempt)
    || !matchesReceipt(
      persistedReceipt,
      receipt,
      attempt.gatewayCreateCredentialIdSha256,
    )
    || !matchesGatewayEvent(persistedEvent, dispatchEvent)
  ) {
    throwWriteFailure(
      writeOutcome,
      "operation_fourteen_attempt_conflict",
    );
  }

  const claim = await readClaim(
    session,
    attempt.authorizationIdSha256,
  );
  if (
    claim === null
    || claim.claim_digest_sha256 !== attempt.claimDigestSha256
    || claim.claim_owner_sha256 !== attempt.claimOwnerSha256
    || claim.ledger_version !== receipt.sequence
    || claim.ledger_head_sha256 !== receipt.receiptDigestSha256
    || claim.inflight_operation_ordinal !== 14
    || claim.inflight_operation_id_sha256 !== attempt.operationIdSha256
    || claim.inflight_request_sha256 !== attempt.operationRequestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    attempt: persistedAttempt,
    receipt: persistedReceipt,
    dispatchEvent: persistedEvent,
    claim,
  };
}

export async function appendOperationFourteenGatewayEvent(
  database: D1Database,
  event: OperationFourteenGatewayEvent,
): Promise<{
  classification: "created" | "exact_replay";
  event: OperationFourteenGatewayEventRow;
}> {
  const session = database.withSession("first-primary");
  let writeOutcome: "created" | "failed" | "unknown";
  try {
    const results = await session.batch([
      gatewayEventInsertStatement(session, event),
    ]);
    writeOutcome = exactWrite(results, 1) ? "created" : "unknown";
  } catch {
    writeOutcome = "failed";
  }
  const persisted = await readGatewayEvent(
    session,
    event.attemptDigestSha256,
    event.eventSequence,
  );
  if (persisted === null || !matchesGatewayEvent(persisted, event)) {
    throwWriteFailure(
      writeOutcome,
      "operation_fourteen_gateway_event_conflict",
    );
  }
  return {
    classification: writeOutcome === "created"
      ? "created"
      : "exact_replay",
    event: persisted,
  };
}

export async function createOperationFourteenTerminal(
  database: D1Database,
  terminal: OperationFourteenTerminal,
  receipt: ExecutionReceipt,
): Promise<{
  classification: "created" | "exact_replay";
  terminal: OperationFourteenTerminalRow;
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
    writeOutcome = exactWrite(results, 2) ? "created" : "unknown";
  } catch {
    writeOutcome = "failed";
  }

  const persistedTerminal = await readTerminal(
    session,
    terminal.authorizationIdSha256,
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
    throwWriteFailure(
      writeOutcome,
      "operation_fourteen_terminal_conflict",
    );
  }

  const claim = await readClaim(
    session,
    terminal.authorizationIdSha256,
  );
  const success =
    terminal.resultOutcome === "exact_success"
    || terminal.resultOutcome === "ambiguous_recovered";
  if (
    claim === null
    || claim.claim_digest_sha256 !== terminal.claimDigestSha256
    || claim.claim_owner_sha256 !== terminal.claimOwnerSha256
    || claim.ledger_version !== receipt.sequence
    || claim.ledger_head_sha256 !== receipt.receiptDigestSha256
    || claim.inflight_operation_ordinal !== null
    || (
      success
        ? (
          claim.status !== "completed"
          || claim.last_completed_ordinal !== 14
          || claim.disable_confirmed !== 1
        )
        : (
          claim.status !== "recovery_required"
          || claim.disable_confirmed !== 0
        )
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
    claim,
  };
}

export async function readOperationFourteenDatabaseNow(
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
  value: OperationFourteenAttempt,
): D1PreparedStatement {
  return session.prepare(INSERT_ATTEMPT_SQL).bind(
    value.authorizationIdSha256,
    value.attemptContract,
    value.claimDigestSha256,
    value.claimOwnerSha256,
    value.leaseOwnerSha256,
    value.leaseTokenSha256,
    value.leaseGeneration,
    value.executionPlanSha256,
    value.operationScheduleSha256,
    value.authorityDatabaseIdentitySha256,
    value.authorityLedgerIdentitySha256,
    value.ledgerVersionBefore,
    value.ledgerHeadBeforeSha256,
    value.operationStartSequence,
    value.operationFiveTerminalReceiptSha256,
    value.operationFiveSendAttemptDigestSha256,
    value.operationIdSha256,
    value.operationRequestSha256,
    value.controllerServiceName,
    value.controllerEnabledSourceVersionId,
    value.controllerBaselineTargetVersionId,
    value.authorityCommandContract,
    value.authorityCommandDigestSha256,
    value.gatewayCommandContract,
    value.gatewayCommandDigestSha256,
    value.gatewayIdempotencyContract,
    value.gatewayIdempotencyKeySha256,
    value.gatewayCreateCredentialIdSha256,
    value.gatewayCreateRequestIdSha256,
    value.gatewayStatusCredentialIdSha256,
    value.gatewayStatusRequestIdSha256,
    value.authorityVersionId,
    value.expectedGatewayVersionId,
    value.disableDeadlineAt,
    value.attemptDigestSha256,
    value.operationStartReceiptDigestSha256,
    value.disableDispatchedEventDigestSha256,
  );
}

function gatewayEventInsertStatement(
  session: D1DatabaseSession,
  value: OperationFourteenGatewayEvent,
): D1PreparedStatement {
  return session.prepare(INSERT_GATEWAY_EVENT_SQL).bind(
    value.authorizationIdSha256,
    value.attemptDigestSha256,
    value.eventSequence,
    value.eventContract,
    value.eventKind,
    value.dispatchSemantics,
    value.credentialRole,
    value.credentialIdSha256,
    value.requestIdSha256,
    value.authorityCommandDigestSha256,
    value.gatewayCommandDigestSha256,
    value.gatewayIdempotencyKeySha256,
    value.controllerServiceName,
    value.controllerBaselineTargetVersionId,
    value.expectedGatewayVersionId,
    value.observedGatewayVersionId,
    value.observedControllerVersionId,
    value.statusClassification,
    value.gatewayHttpStatus,
    value.gatewayResponseSha256,
    value.gatewayResponseBytes,
    value.cloudflareRequestIdSha256,
    value.deploymentSetSha256,
    value.observationDigestSha256,
    value.stabilityMinimumSeconds,
    value.predecessorEventDigestSha256,
    value.eventDigestSha256,
  );
}

function terminalInsertStatement(
  session: D1DatabaseSession,
  value: OperationFourteenTerminal,
): D1PreparedStatement {
  return session.prepare(INSERT_TERMINAL_SQL).bind(
    value.authorizationIdSha256,
    value.terminalContract,
    value.claimDigestSha256,
    value.claimOwnerSha256,
    value.attemptLeaseOwnerSha256,
    value.attemptLeaseTokenSha256,
    value.attemptLeaseGeneration,
    value.leaseOwnerSha256,
    value.leaseTokenSha256,
    value.leaseGeneration,
    value.executionPlanSha256,
    value.operationScheduleSha256,
    value.authorityDatabaseIdentitySha256,
    value.authorityLedgerIdentitySha256,
    value.attemptDigestSha256,
    value.operationIdSha256,
    value.operationRequestSha256,
    value.operationStartReceiptDigestSha256,
    value.controllerServiceName,
    value.controllerEnabledSourceVersionId,
    value.controllerBaselineTargetVersionId,
    value.authorityCommandDigestSha256,
    value.gatewayCommandDigestSha256,
    value.gatewayIdempotencyKeySha256,
    value.terminalEventSequence,
    value.terminalEventDigestSha256,
    value.terminalEventKind,
    value.terminalEventResponseSha256,
    value.terminalEventRequestIdSha256,
    value.terminalEventCloudflareRequestIdSha256,
    value.terminalEventObservationDigestSha256,
    value.terminalEventDeploymentSetSha256,
    value.resultOutcome,
    value.recoveryMode,
    value.terminalResponseSha256,
    value.terminalEvidenceSha256,
    value.authorityTerminalVersionId,
    value.terminalWriterCredentialIdSha256,
    value.terminalWriterRequestIdSha256,
    value.ledgerVersionBefore,
    value.ledgerHeadBeforeSha256,
    value.genericReceiptSequence,
    value.genericTerminalReceiptDigestSha256,
  );
}

function receiptInsertStatement(
  session: D1DatabaseSession,
  value: ExecutionReceipt,
): D1PreparedStatement {
  return session.prepare(INSERT_RECEIPT_SQL).bind(
    value.authorizationIdSha256,
    value.sequence,
    value.eventKind,
    value.claimDigestSha256,
    value.executionPlanSha256,
    value.ledgerIdentitySha256,
    value.operationOrdinal,
    value.operationIdSha256,
    value.operationKind,
    value.shardIndex,
    value.predecessorReceiptSha256,
    value.requestSha256,
    value.responseSha256,
    value.cloudflareRequestIdSha256,
    value.evidenceSha256,
    value.safetyReason,
    value.outcome,
    value.actorOwnerSha256,
    value.leaseTokenSha256,
    value.leaseGeneration,
    value.actorCredentialIdSha256,
    value.requestIdSha256,
    value.receiptDigestSha256,
  );
}

async function readAttempt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFourteenAttemptRow | null> {
  return firstOrUnavailable<OperationFourteenAttemptRow>(
    session.prepare(SELECT_ATTEMPT_SQL).bind(authorizationIdSha256),
  );
}

async function readGatewayEvent(
  session: D1DatabaseSession,
  attemptDigestSha256: string,
  eventSequence: number,
): Promise<OperationFourteenGatewayEventRow | null> {
  return firstOrUnavailable<OperationFourteenGatewayEventRow>(
    session
      .prepare(SELECT_GATEWAY_EVENT_SQL)
      .bind(attemptDigestSha256, eventSequence),
  );
}

async function readGatewayEvents(
  session: D1DatabaseSession,
  attemptDigestSha256: string,
): Promise<OperationFourteenGatewayEventRow[]> {
  try {
    const result = await session
      .prepare(SELECT_GATEWAY_EVENTS_SQL)
      .bind(attemptDigestSha256)
      .all<OperationFourteenGatewayEventRow>();
    if (result.success !== true) {
      throw new Error("gateway_event_read_failed");
    }
    return result.results;
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readTerminal(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFourteenTerminalRow | null> {
  return firstOrUnavailable<OperationFourteenTerminalRow>(
    session.prepare(SELECT_TERMINAL_SQL).bind(authorizationIdSha256),
  );
}

async function readReceipt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  sequence: number,
): Promise<ExecutionReceiptRow | null> {
  return firstOrUnavailable<ExecutionReceiptRow>(
    session
      .prepare(SELECT_RECEIPT_SQL)
      .bind(authorizationIdSha256, sequence),
  );
}

async function readClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<ExecutionClaimRow | null> {
  return firstOrUnavailable<ExecutionClaimRow>(
    session.prepare(SELECT_CLAIM_SQL).bind(authorizationIdSha256),
  );
}

async function firstOrUnavailable<T>(
  statement: D1PreparedStatement,
): Promise<T | null> {
  try {
    return await statement.first<T>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function exactWrite(
  results: D1Result<unknown>[],
  expected: number,
): boolean {
  return (
    results.length === expected
    && results.every((result) =>
      result.success === true && (result.meta?.changes ?? 0) > 0
    )
  );
}

function throwWriteFailure(
  outcome: "created" | "failed" | "unknown",
  conflictCode: string,
): never {
  if (outcome === "unknown") {
    throw new RepositoryUnavailableError(true);
  }
  throw new RepositoryConflictError(conflictCode);
}

function requireAttemptTripleMatch(
  attempt: OperationFourteenAttempt,
  receipt: ExecutionReceipt,
  dispatch: OperationFourteenGatewayEvent,
): void {
  if (
    attempt.ledgerVersionBefore > 52
    || attempt.operationStartSequence !== attempt.ledgerVersionBefore + 1
    || receipt.eventKind !== "operation_started"
    || receipt.operationOrdinal !== 14
    || receipt.operationKind !== "disable_controller_deployment"
    || receipt.shardIndex !== null
    || receipt.authorizationIdSha256 !== attempt.authorizationIdSha256
    || receipt.claimDigestSha256 !== attempt.claimDigestSha256
    || receipt.executionPlanSha256 !== attempt.executionPlanSha256
    || receipt.ledgerIdentitySha256
      !== attempt.authorityLedgerIdentitySha256
    || receipt.sequence !== attempt.operationStartSequence
    || receipt.predecessorReceiptSha256
      !== attempt.ledgerHeadBeforeSha256
    || receipt.operationIdSha256 !== attempt.operationIdSha256
    || receipt.requestSha256 !== attempt.operationRequestSha256
    || receipt.responseSha256 !== null
    || receipt.cloudflareRequestIdSha256 !== null
    || receipt.evidenceSha256 !== attempt.attemptDigestSha256
    || receipt.safetyReason !== null
    || receipt.outcome !== "pending"
    || receipt.actorOwnerSha256 !== attempt.leaseOwnerSha256
    || receipt.leaseTokenSha256 !== attempt.leaseTokenSha256
    || receipt.leaseGeneration !== attempt.leaseGeneration
    || receipt.actorCredentialIdSha256
      !== attempt.gatewayCreateCredentialIdSha256
    || receipt.requestIdSha256 !== attempt.gatewayCreateRequestIdSha256
    || receipt.receiptDigestSha256
      !== attempt.operationStartReceiptDigestSha256
    || dispatch.authorizationIdSha256 !== attempt.authorizationIdSha256
    || dispatch.attemptDigestSha256 !== attempt.attemptDigestSha256
    || dispatch.eventSequence !== 1
    || dispatch.eventKind !== "disable_dispatched"
    || dispatch.dispatchSemantics
      !== OPERATION_FOURTEEN_DISPATCH_SEMANTICS
    || dispatch.credentialRole !== "disable_create"
    || dispatch.credentialIdSha256
      !== attempt.gatewayCreateCredentialIdSha256
    || dispatch.requestIdSha256
      !== attempt.gatewayCreateRequestIdSha256
    || dispatch.authorityCommandDigestSha256
      !== attempt.authorityCommandDigestSha256
    || dispatch.gatewayCommandDigestSha256
      !== attempt.gatewayCommandDigestSha256
    || dispatch.gatewayIdempotencyKeySha256
      !== attempt.gatewayIdempotencyKeySha256
    || dispatch.controllerServiceName !== attempt.controllerServiceName
    || dispatch.controllerBaselineTargetVersionId
      !== attempt.controllerBaselineTargetVersionId
    || dispatch.expectedGatewayVersionId
      !== attempt.expectedGatewayVersionId
    || dispatch.predecessorEventDigestSha256
      !== attempt.attemptDigestSha256
    || dispatch.eventDigestSha256
      !== attempt.disableDispatchedEventDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_fourteen_attempt_triple_mismatch",
    );
  }
}

function requireTerminalReceiptMatch(
  terminal: OperationFourteenTerminal,
  receipt: ExecutionReceipt,
): void {
  if (
    terminal.genericReceiptSequence !== terminal.ledgerVersionBefore + 1
    || receipt.eventKind !== "operation_terminal"
    || receipt.operationOrdinal !== 14
    || receipt.operationKind !== "disable_controller_deployment"
    || receipt.shardIndex !== null
    || receipt.authorizationIdSha256 !== terminal.authorizationIdSha256
    || receipt.claimDigestSha256 !== terminal.claimDigestSha256
    || receipt.executionPlanSha256 !== terminal.executionPlanSha256
    || receipt.ledgerIdentitySha256
      !== terminal.authorityLedgerIdentitySha256
    || receipt.sequence !== terminal.genericReceiptSequence
    || receipt.predecessorReceiptSha256
      !== terminal.ledgerHeadBeforeSha256
    || receipt.operationIdSha256 !== terminal.operationIdSha256
    || receipt.requestSha256 !== terminal.operationRequestSha256
    || receipt.responseSha256 !== terminal.terminalResponseSha256
    || receipt.cloudflareRequestIdSha256
      !== terminal.terminalEventCloudflareRequestIdSha256
    || receipt.evidenceSha256 !== terminal.terminalEvidenceSha256
    || receipt.safetyReason !== null
    || receipt.outcome !== terminal.resultOutcome
    || receipt.actorOwnerSha256 !== terminal.leaseOwnerSha256
    || receipt.leaseTokenSha256 !== terminal.leaseTokenSha256
    || receipt.leaseGeneration !== terminal.leaseGeneration
    || receipt.actorCredentialIdSha256
      !== terminal.terminalWriterCredentialIdSha256
    || receipt.requestIdSha256
      !== terminal.terminalWriterRequestIdSha256
    || receipt.receiptDigestSha256
      !== terminal.genericTerminalReceiptDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_fourteen_terminal_receipt_mismatch",
    );
  }
}

function matchesAttempt(
  row: OperationFourteenAttemptRow,
  value: OperationFourteenAttempt,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.operation_ordinal === 14
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
    && row.ledger_version_before === value.ledgerVersionBefore
    && row.ledger_head_before_sha256 === value.ledgerHeadBeforeSha256
    && row.operation_start_sequence === value.operationStartSequence
    && row.operation_five_terminal_receipt_sha256
      === value.operationFiveTerminalReceiptSha256
    && row.operation_five_send_attempt_digest_sha256
      === value.operationFiveSendAttemptDigestSha256
    && row.operation_id_sha256 === value.operationIdSha256
    && row.operation_request_sha256 === value.operationRequestSha256
    && row.controller_service_name === value.controllerServiceName
    && row.controller_enabled_source_version_id
      === value.controllerEnabledSourceVersionId
    && row.controller_baseline_target_version_id
      === value.controllerBaselineTargetVersionId
    && row.authority_command_contract === value.authorityCommandContract
    && row.authority_command_digest_sha256
      === value.authorityCommandDigestSha256
    && row.gateway_command_contract === value.gatewayCommandContract
    && row.gateway_command_digest_sha256
      === value.gatewayCommandDigestSha256
    && row.gateway_idempotency_contract
      === value.gatewayIdempotencyContract
    && row.gateway_idempotency_key_sha256
      === value.gatewayIdempotencyKeySha256
    && row.gateway_create_credential_id_sha256
      === value.gatewayCreateCredentialIdSha256
    && row.gateway_create_request_id_sha256
      === value.gatewayCreateRequestIdSha256
    && row.gateway_status_credential_id_sha256
      === value.gatewayStatusCredentialIdSha256
    && row.gateway_status_request_id_sha256
      === value.gatewayStatusRequestIdSha256
    && row.authority_version_id === value.authorityVersionId
    && row.expected_gateway_version_id === value.expectedGatewayVersionId
    && row.disable_deadline_at === value.disableDeadlineAt
    && row.mutation_attempt_limit === 1
    && row.retry_limit === 0
    && row.missing_readback_allows_resend === 0
    && row.attempt_digest_sha256 === value.attemptDigestSha256
    && row.operation_start_receipt_digest_sha256
      === value.operationStartReceiptDigestSha256
    && row.disable_dispatched_event_digest_sha256
      === value.disableDispatchedEventDigestSha256
  );
}

function matchesGatewayEvent(
  row: OperationFourteenGatewayEventRow,
  value: OperationFourteenGatewayEvent,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.attempt_digest_sha256 === value.attemptDigestSha256
    && row.event_sequence === value.eventSequence
    && row.contract_version === 1
    && row.event_contract === value.eventContract
    && row.event_kind === value.eventKind
    && row.dispatch_semantics === value.dispatchSemantics
    && row.credential_role === value.credentialRole
    && row.credential_id_sha256 === value.credentialIdSha256
    && row.request_id_sha256 === value.requestIdSha256
    && row.authority_command_digest_sha256
      === value.authorityCommandDigestSha256
    && row.gateway_command_digest_sha256
      === value.gatewayCommandDigestSha256
    && row.gateway_idempotency_key_sha256
      === value.gatewayIdempotencyKeySha256
    && row.controller_service_name === value.controllerServiceName
    && row.controller_baseline_target_version_id
      === value.controllerBaselineTargetVersionId
    && row.expected_gateway_version_id === value.expectedGatewayVersionId
    && row.observed_gateway_version_id === value.observedGatewayVersionId
    && row.observed_controller_version_id
      === value.observedControllerVersionId
    && row.status_classification === value.statusClassification
    && row.gateway_http_status === value.gatewayHttpStatus
    && row.gateway_response_sha256 === value.gatewayResponseSha256
    && row.gateway_response_bytes === value.gatewayResponseBytes
    && row.cloudflare_request_id_sha256
      === value.cloudflareRequestIdSha256
    && row.deployment_set_sha256 === value.deploymentSetSha256
    && row.observation_digest_sha256 === value.observationDigestSha256
    && row.stability_minimum_seconds === value.stabilityMinimumSeconds
    && row.predecessor_event_digest_sha256
      === value.predecessorEventDigestSha256
    && row.event_digest_sha256 === value.eventDigestSha256
  );
}

function matchesTerminal(
  row: OperationFourteenTerminalRow,
  value: OperationFourteenTerminal,
): boolean {
  return (
    row.authorization_id_sha256 === value.authorizationIdSha256
    && row.operation_ordinal === 14
    && row.contract_version === 1
    && row.terminal_contract === value.terminalContract
    && row.claim_digest_sha256 === value.claimDigestSha256
    && row.claim_owner_sha256 === value.claimOwnerSha256
    && row.attempt_lease_owner_sha256
      === value.attemptLeaseOwnerSha256
    && row.attempt_lease_token_sha256
      === value.attemptLeaseTokenSha256
    && row.attempt_lease_generation
      === value.attemptLeaseGeneration
    && row.lease_owner_sha256 === value.leaseOwnerSha256
    && row.lease_token_sha256 === value.leaseTokenSha256
    && row.lease_generation === value.leaseGeneration
    && row.execution_plan_sha256 === value.executionPlanSha256
    && row.operation_schedule_sha256 === value.operationScheduleSha256
    && row.authority_database_identity_sha256
      === value.authorityDatabaseIdentitySha256
    && row.authority_ledger_identity_sha256
      === value.authorityLedgerIdentitySha256
    && row.attempt_digest_sha256 === value.attemptDigestSha256
    && row.operation_id_sha256 === value.operationIdSha256
    && row.operation_request_sha256 === value.operationRequestSha256
    && row.operation_start_receipt_digest_sha256
      === value.operationStartReceiptDigestSha256
    && row.controller_service_name === value.controllerServiceName
    && row.controller_enabled_source_version_id
      === value.controllerEnabledSourceVersionId
    && row.controller_baseline_target_version_id
      === value.controllerBaselineTargetVersionId
    && row.authority_command_digest_sha256
      === value.authorityCommandDigestSha256
    && row.gateway_command_digest_sha256
      === value.gatewayCommandDigestSha256
    && row.gateway_idempotency_key_sha256
      === value.gatewayIdempotencyKeySha256
    && row.terminal_event_sequence === value.terminalEventSequence
    && row.terminal_event_digest_sha256
      === value.terminalEventDigestSha256
    && row.terminal_event_kind === value.terminalEventKind
    && row.terminal_event_response_sha256
      === value.terminalEventResponseSha256
    && row.terminal_event_request_id_sha256
      === value.terminalEventRequestIdSha256
    && row.terminal_event_cloudflare_request_id_sha256
      === value.terminalEventCloudflareRequestIdSha256
    && row.terminal_event_observation_digest_sha256
      === value.terminalEventObservationDigestSha256
    && row.terminal_event_deployment_set_sha256
      === value.terminalEventDeploymentSetSha256
    && row.result_outcome === value.resultOutcome
    && row.recovery_mode === value.recoveryMode
    && row.terminal_response_sha256 === value.terminalResponseSha256
    && row.terminal_evidence_sha256 === value.terminalEvidenceSha256
    && row.authority_terminal_version_id
      === value.authorityTerminalVersionId
    && row.terminal_writer_credential_id_sha256
      === value.terminalWriterCredentialIdSha256
    && row.terminal_writer_request_id_sha256
      === value.terminalWriterRequestIdSha256
    && row.ledger_version_before === value.ledgerVersionBefore
    && row.ledger_head_before_sha256 === value.ledgerHeadBeforeSha256
    && row.generic_receipt_sequence === value.genericReceiptSequence
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

export const operationFourteenRepositorySqlForTest = {
  insertAttempt: INSERT_ATTEMPT_SQL,
  insertGatewayEvent: INSERT_GATEWAY_EVENT_SQL,
  insertReceipt: INSERT_RECEIPT_SQL,
  insertTerminal: INSERT_TERMINAL_SQL,
  selectAttempt: SELECT_ATTEMPT_SQL,
  selectClaim: SELECT_CLAIM_SQL,
  selectGatewayEvent: SELECT_GATEWAY_EVENT_SQL,
  selectGatewayEvents: SELECT_GATEWAY_EVENTS_SQL,
  selectReceipt: SELECT_RECEIPT_SQL,
  selectTerminal: SELECT_TERMINAL_SQL,
} as const;
