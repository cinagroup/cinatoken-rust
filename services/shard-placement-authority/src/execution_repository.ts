import type {
  ExecutionClaim,
  ExecutionOperation,
  ExecutionReceipt,
} from "./execution_protocol";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryUnavailableError,
} from "./repository";

const CLAIM_COLUMNS = [
  "authorization_id_sha256",
  "permit_subject_digest_sha256",
  "execution_nonce_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "authority_database_identity_sha256",
  "campaign_id",
  "campaign_nonce_sha256",
  "claim_scope",
  "execution_plan_sha256",
  "release_sha256",
  "publication_sha256",
  "execution_activation_sha256",
  "runner_build_sha256",
  "claim_owner_sha256",
  "lease_owner_sha256",
  "ledger_identity_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "baseline_operation_id_sha256",
  "baseline_terminal_digest_sha256",
  "preparation_operation_id_sha256",
  "claim_operation_id_sha256",
  "operation_schedule_sha256",
  "claim_credential_id_sha256",
  "claim_request_id_sha256",
  "claim_digest_sha256",
  "claim_acquired_receipt_digest_sha256",
  "permit_expires_at",
  "normal_deadline_at",
  "recovery_deadline_at",
  "status",
  "ledger_version",
  "ledger_head_sha256",
  "last_completed_ordinal",
  "inflight_operation_ordinal",
  "inflight_operation_id_sha256",
  "inflight_request_sha256",
  "inflight_cloudflare_request_id_sha256",
  "inflight_started_generation",
  "inflight_started_owner_sha256",
  "inflight_started_lease_token_sha256",
  "inflight_readback_only",
  "enable_intent_seen",
  "disable_confirmed",
  "application_activation_digest_sha256",
  "ticket_activation_confirmed",
  "renewal_count",
  "takeover_count",
  "generated_at",
  "claimed_at",
  "updated_at",
  "terminal_at",
] as const;
const OPERATION_COLUMNS = [
  "authorization_id_sha256",
  "ordinal",
  "operation_id_sha256",
  "kind",
  "shard_index",
] as const;
const RECEIPT_COLUMNS = [
  "authorization_id_sha256",
  "sequence",
  "event_kind",
  "claim_digest_sha256",
  "execution_plan_sha256",
  "ledger_identity_sha256",
  "operation_ordinal",
  "operation_id_sha256",
  "operation_kind",
  "shard_index",
  "predecessor_receipt_sha256",
  "request_sha256",
  "response_sha256",
  "cloudflare_request_id_sha256",
  "evidence_sha256",
  "safety_reason",
  "outcome",
  "lease_owner_sha256",
  "lease_token_sha256",
  "lease_generation",
  "lease_expires_at",
  "receipt_credential_id_sha256",
  "request_id_sha256",
  "receipt_digest_sha256",
  "recorded_at",
] as const;
const OPERATION_FIVE_ADMISSION_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "confirmation_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "application_activation_digest_sha256",
  "authority_activation_terminal_receipt_sha256",
  "authority_ledger_head_sha256",
  "authority_database_identity_sha256",
  "authority_version_id",
  "application_acknowledgement_digest_sha256",
  "application_version_id",
  "application_read_credential_id_sha256",
  "application_read_request_id_sha256",
  "application_response_sha256",
  "application_response_bytes",
  "enable_credential_id_sha256",
  "enable_request_id_sha256",
  "command_enable_request_id_sha256",
  "enable_operation_request_sha256",
  "confirmation_digest_sha256",
  "operation_start_receipt_digest_sha256",
  "confirmed_at",
] as const;
const OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS = [
  "authorization_id_sha256",
  "contract_version",
  "dispatch_contract",
  "claim_digest_sha256",
  "application_ticket_id_sha256",
  "application_ticket_digest_sha256",
  "application_database_identity_sha256",
  "application_activation_digest_sha256",
  "application_acknowledgement_digest_sha256",
  "operation_five_admission_digest_sha256",
  "operation_five_start_receipt_sha256",
  "authority_database_identity_sha256",
  "authority_version_id",
  "authority_ledger_head_sha256",
  "application_version_id",
  "application_read_credential_id_sha256",
  "application_read_request_id_sha256",
  "application_response_sha256",
  "application_response_bytes",
  "application_database_now",
  "dispatch_credential_id_sha256",
  "dispatch_request_id_sha256",
  "command_dispatch_request_id_sha256",
  "controller_service_name",
  "controller_enable_operation_id_sha256",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "dispatch_request_sha256",
  "outbox_digest_sha256",
  "outbox_state",
  "prepared_at",
] as const;

const SCHEMA_PROBE_SQL = `
SELECT
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_claims'
      )
      ORDER BY cid
    )
  ) AS claim_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_operations'
      )
      ORDER BY cid
    )
  ) AS operation_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_execution_receipts'
      )
      ORDER BY cid
    )
  ) AS receipt_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_admissions'
      )
      ORDER BY cid
    )
  ) AS operation_five_admission_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_five_dispatch_outbox'
      )
      ORDER BY cid
    )
  ) AS operation_five_dispatch_outbox_columns
`.trim();

const INSERT_CLAIM_SQL = `
INSERT INTO shard_placement_authority_execution_claims (
  authorization_id_sha256, permit_subject_digest_sha256,
  execution_nonce_sha256, application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  authority_database_identity_sha256, campaign_id, campaign_nonce_sha256,
  claim_scope, execution_plan_sha256, release_sha256,
  publication_sha256, execution_activation_sha256,
  runner_build_sha256, claim_owner_sha256, lease_owner_sha256,
  ledger_identity_sha256, lease_token_sha256, lease_generation,
  lease_expires_at, baseline_operation_id_sha256,
  baseline_terminal_digest_sha256, preparation_operation_id_sha256,
  claim_operation_id_sha256,
  operation_schedule_sha256, claim_credential_id_sha256,
  claim_request_id_sha256, claim_digest_sha256,
  claim_acquired_receipt_digest_sha256, permit_expires_at,
  normal_deadline_at, recovery_deadline_at, ledger_head_sha256,
  generated_at, claimed_at, updated_at
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
  ?15, ?16, ?16, ?17, ?18, 1, unixepoch() + 60, ?19, ?20, ?21, ?22,
  ?23, ?24, ?25, ?26, ?27, issuance.permit_expires_at, ?28,
  issuance.permit_expires_at + 600, ?20, ?29, unixepoch(),
  unixepoch()
FROM shard_placement_authority_issuances AS issuance
LEFT JOIN shard_placement_authority_revocations AS revocation
  ON revocation.authorization_id_sha256 =
       issuance.authorization_id_sha256
WHERE issuance.authorization_id_sha256 = ?1
  AND issuance.permit_subject_digest_sha256 = ?2
  AND issuance.execution_nonce_sha256 = ?3
  AND issuance.campaign_id = ?8
  AND issuance.campaign_nonce_sha256 = ?9
  AND issuance.environment = 'staging'
  AND issuance.shard_count = 8
  AND revocation.authorization_id_sha256 IS NULL
`.trim();

const INSERT_OPERATION_SQL = `
INSERT INTO shard_placement_authority_execution_operations (
  authorization_id_sha256, ordinal, operation_id_sha256, kind,
  shard_index
) VALUES (?1, ?2, ?3, ?4, ?5)
`.trim();

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
  ?14, ?15, ?16, ?17, ?18, ?19, ?20,
  CASE
    WHEN ?3 IN ('lease_renewed', 'lease_taken_over')
      THEN unixepoch() + 60
    ELSE claim.lease_expires_at
  END,
  ?21, ?22, ?23
FROM shard_placement_authority_execution_claims AS claim
WHERE claim.authorization_id_sha256 = ?1
  AND claim.claim_digest_sha256 = ?4
  AND claim.execution_plan_sha256 = ?5
  AND claim.ledger_identity_sha256 = ?6
`.trim();

const INSERT_OPERATION_FIVE_ADMISSION_SQL = `
INSERT INTO shard_placement_authority_operation_five_admissions (
  authorization_id_sha256, contract_version,
  confirmation_contract, claim_digest_sha256,
  application_ticket_id_sha256, application_ticket_digest_sha256,
  application_database_identity_sha256,
  application_activation_digest_sha256,
  authority_activation_terminal_receipt_sha256,
  authority_ledger_head_sha256,
  authority_database_identity_sha256, authority_version_id,
  application_acknowledgement_digest_sha256,
  application_version_id, application_read_credential_id_sha256,
  application_read_request_id_sha256, application_response_sha256,
  application_response_bytes, enable_credential_id_sha256,
  enable_request_id_sha256,
  command_enable_request_id_sha256, enable_operation_request_sha256,
  confirmation_digest_sha256,
  operation_start_receipt_digest_sha256
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
)
`.trim();

const INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL = `
INSERT INTO shard_placement_authority_operation_five_dispatch_outbox (
  authorization_id_sha256, contract_version, dispatch_contract,
  claim_digest_sha256, application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  application_activation_digest_sha256,
  application_acknowledgement_digest_sha256,
  operation_five_admission_digest_sha256,
  operation_five_start_receipt_sha256,
  authority_database_identity_sha256, authority_version_id,
  authority_ledger_head_sha256, application_version_id,
  application_read_credential_id_sha256,
  application_read_request_id_sha256, application_response_sha256,
  application_response_bytes, application_database_now,
  dispatch_credential_id_sha256, dispatch_request_id_sha256,
  command_dispatch_request_id_sha256, controller_service_name,
  controller_enable_operation_id_sha256,
  controller_baseline_version_id, controller_enabled_version_id,
  dispatch_request_sha256, outbox_digest_sha256, outbox_state
) VALUES (
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
  ?26, ?27, ?28, 'prepared'
)
`.trim();

interface SchemaProbeRow {
  claim_columns: string;
  operation_columns: string;
  receipt_columns: string;
  operation_five_admission_columns: string;
  operation_five_dispatch_outbox_columns: string;
}

export interface ExecutionClaimRow {
  authorization_id_sha256: string;
  permit_subject_digest_sha256: string;
  execution_nonce_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  authority_database_identity_sha256: string;
  campaign_id: string;
  campaign_nonce_sha256: string;
  claim_scope: string;
  execution_plan_sha256: string;
  release_sha256: string;
  publication_sha256: string;
  execution_activation_sha256: string;
  runner_build_sha256: string;
  claim_owner_sha256: string;
  lease_owner_sha256: string;
  ledger_identity_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  baseline_operation_id_sha256: string;
  baseline_terminal_digest_sha256: string;
  preparation_operation_id_sha256: string;
  claim_operation_id_sha256: string;
  operation_schedule_sha256: string;
  claim_credential_id_sha256: string;
  claim_request_id_sha256: string;
  claim_digest_sha256: string;
  claim_acquired_receipt_digest_sha256: string;
  permit_expires_at: number;
  normal_deadline_at: number;
  recovery_deadline_at: number;
  status: string;
  ledger_version: number;
  ledger_head_sha256: string;
  last_completed_ordinal: number;
  inflight_operation_ordinal: number | null;
  inflight_operation_id_sha256: string | null;
  inflight_request_sha256: string | null;
  inflight_cloudflare_request_id_sha256: string | null;
  inflight_started_generation: number | null;
  inflight_started_owner_sha256: string | null;
  inflight_started_lease_token_sha256: string | null;
  inflight_readback_only: number;
  enable_intent_seen: number;
  disable_confirmed: number;
  application_activation_digest_sha256: string | null;
  ticket_activation_confirmed: number;
  renewal_count: number;
  takeover_count: number;
  generated_at: number;
  claimed_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface ExecutionOperationRow {
  authorization_id_sha256: string;
  ordinal: number;
  operation_id_sha256: string;
  kind: string;
  shard_index: number | null;
}

export interface ExecutionReceiptRow {
  authorization_id_sha256: string;
  sequence: number;
  event_kind: string;
  claim_digest_sha256: string;
  execution_plan_sha256: string;
  ledger_identity_sha256: string;
  operation_ordinal: number;
  operation_id_sha256: string;
  operation_kind: string;
  shard_index: number | null;
  predecessor_receipt_sha256: string;
  request_sha256: string;
  response_sha256: string | null;
  cloudflare_request_id_sha256: string | null;
  evidence_sha256: string;
  safety_reason: string | null;
  outcome: string;
  lease_owner_sha256: string;
  lease_token_sha256: string;
  lease_generation: number;
  lease_expires_at: number;
  receipt_credential_id_sha256: string;
  request_id_sha256: string;
  receipt_digest_sha256: string;
  recorded_at: number;
}

export interface ExecutionClaimSnapshot {
  claim: ExecutionClaimRow;
  operations: readonly ExecutionOperationRow[];
  receipts: readonly ExecutionReceiptRow[];
}

export interface OperationFiveAdmission {
  authorizationIdSha256: string;
  confirmationContract:
    "cinatoken-shard-placement-authority-operation-five-admission-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationActivationDigestSha256: string;
  authorityActivationTerminalReceiptSha256: string;
  authorityLedgerHeadSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityVersionId: string;
  applicationAcknowledgementDigestSha256: string;
  applicationVersionId: string;
  applicationReadCredentialIdSha256: string;
  applicationReadRequestIdSha256: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  enableCredentialIdSha256: string;
  enableRequestIdSha256: string;
  commandEnableRequestIdSha256: string;
  enableOperationRequestSha256: string;
  confirmationDigestSha256: string;
  operationStartReceiptDigestSha256: string;
}

export interface OperationFiveAdmissionRow {
  authorization_id_sha256: string;
  contract_version: number;
  confirmation_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  application_activation_digest_sha256: string;
  authority_activation_terminal_receipt_sha256: string;
  authority_ledger_head_sha256: string;
  authority_database_identity_sha256: string;
  authority_version_id: string;
  application_acknowledgement_digest_sha256: string;
  application_version_id: string;
  application_read_credential_id_sha256: string;
  application_read_request_id_sha256: string;
  application_response_sha256: string;
  application_response_bytes: number;
  enable_credential_id_sha256: string;
  enable_request_id_sha256: string;
  command_enable_request_id_sha256: string;
  enable_operation_request_sha256: string;
  confirmation_digest_sha256: string;
  operation_start_receipt_digest_sha256: string;
  confirmed_at: number;
}

export interface OperationFiveDispatchOutbox {
  authorizationIdSha256: string;
  dispatchContract:
    "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1";
  claimDigestSha256: string;
  applicationTicketIdSha256: string;
  applicationTicketDigestSha256: string;
  applicationDatabaseIdentitySha256: string;
  applicationActivationDigestSha256: string;
  applicationAcknowledgementDigestSha256: string;
  operationFiveAdmissionDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityVersionId: string;
  authorityLedgerHeadSha256: string;
  applicationVersionId: string;
  applicationReadCredentialIdSha256: string;
  applicationReadRequestIdSha256: string;
  applicationResponseSha256: string;
  applicationResponseBytes: number;
  applicationDatabaseNow: number;
  dispatchCredentialIdSha256: string;
  dispatchRequestIdSha256: string;
  commandDispatchRequestIdSha256: string;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  dispatchRequestSha256: string;
  outboxDigestSha256: string;
}

export interface OperationFiveDispatchOutboxRow {
  authorization_id_sha256: string;
  contract_version: number;
  dispatch_contract: string;
  claim_digest_sha256: string;
  application_ticket_id_sha256: string;
  application_ticket_digest_sha256: string;
  application_database_identity_sha256: string;
  application_activation_digest_sha256: string;
  application_acknowledgement_digest_sha256: string;
  operation_five_admission_digest_sha256: string;
  operation_five_start_receipt_sha256: string;
  authority_database_identity_sha256: string;
  authority_version_id: string;
  authority_ledger_head_sha256: string;
  application_version_id: string;
  application_read_credential_id_sha256: string;
  application_read_request_id_sha256: string;
  application_response_sha256: string;
  application_response_bytes: number;
  application_database_now: number;
  dispatch_credential_id_sha256: string;
  dispatch_request_id_sha256: string;
  command_dispatch_request_id_sha256: string;
  controller_service_name: string;
  controller_enable_operation_id_sha256: string;
  controller_baseline_version_id: string;
  controller_enabled_version_id: string;
  dispatch_request_sha256: string;
  outbox_digest_sha256: string;
  outbox_state: "prepared";
  prepared_at: number;
}

export async function createExecutionClaim(
  database: D1Database,
  claim: ExecutionClaim,
): Promise<{
  classification: "created" | "exact_replay";
  snapshot: ExecutionClaimSnapshot;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const statements = [
    session
      .prepare(INSERT_CLAIM_SQL)
      .bind(
        claim.authorizationIdSha256,
        claim.permitSubjectDigestSha256,
        claim.executionNonceSha256,
        claim.applicationTicketIdSha256,
        claim.applicationTicketDigestSha256,
        claim.applicationDatabaseIdentitySha256,
        claim.authorityDatabaseIdentitySha256,
        claim.campaignId,
        claim.campaignNonceSha256,
        claim.claimScope,
        claim.executionPlanSha256,
        claim.releaseSha256,
        claim.publicationSha256,
        claim.executionActivationSha256,
        claim.runnerBuildSha256,
        claim.claimOwnerSha256,
        claim.ledgerIdentitySha256,
        claim.leaseTokenSha256,
        claim.baselineOperationIdSha256,
        claim.baselineTerminalReceiptSha256,
        claim.preparationOperationIdSha256,
        claim.claimOperationIdSha256,
        claim.operationScheduleSha256,
        claim.claimCredentialIdSha256,
        claim.requestIdSha256,
        claim.claimDigestSha256,
        claim.claimAcquiredReceiptSha256,
        claim.normalDeadlineAt,
        claim.generatedAt,
      ),
    ...claim.operations.map((operation) =>
      session
        .prepare(INSERT_OPERATION_SQL)
        .bind(
          claim.authorizationIdSha256,
          operation.ordinal,
          operation.operationIdSha256,
          operation.kind,
          operation.shardIndex,
        )
    ),
  ];
  let writeSucceeded = false;
  try {
    const results = await session.batch(statements);
    writeSucceeded =
      results.length === statements.length
      && results.every((result) => result.success === true);
  } catch {
    writeSucceeded = false;
  }

  let snapshot: ExecutionClaimSnapshot;
  try {
    snapshot = await readSnapshot(
      session,
      claim.authorizationIdSha256,
      claim.claimDigestSha256,
      claim.claimOwnerSha256,
    );
  } catch (error) {
    if (
      error instanceof RepositoryConflictError
      || error instanceof RepositoryNotFoundError
    ) {
      if (writeSucceeded) throw new RepositoryUnavailableError(true);
      throw new RepositoryConflictError("execution_claim_conflict");
    }
    throw error;
  }
  if (!matchesClaimSnapshot(snapshot, claim)) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("execution_claim_conflict");
  }
  return {
    classification: writeSucceeded ? "created" : "exact_replay",
    snapshot,
  };
}

export async function readExactExecutionClaim(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  return readSnapshot(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    claimOwnerSha256,
  );
}

export async function readExactOperationFiveAdmission(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveAdmissionRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const admission = await readOperationFiveAdmission(
    session,
    authorizationIdSha256,
  );
  if (
    admission !== null
    && admission.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_admission_conflict",
    );
  }
  return admission;
}

export async function readExactOperationFiveDispatchOutbox(
  database: D1Database,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<OperationFiveDispatchOutboxRow | null> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  const outbox = await readOperationFiveDispatchOutbox(
    session,
    authorizationIdSha256,
  );
  if (
    outbox !== null
    && outbox.claim_digest_sha256 !== claimDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_dispatch_outbox_conflict",
    );
  }
  return outbox;
}

export async function appendExecutionReceipt(
  database: D1Database,
  authorizationIdSha256: string,
  receipt: ExecutionReceipt,
  receiptCredentialIdSha256: string,
): Promise<{
  classification: "receipt_appended" | "receipt_replayed";
  claim: ExecutionClaimRow;
  receipt: ExecutionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  if (authorizationIdSha256 !== receipt.authorizationIdSha256) {
    throw new RepositoryConflictError("execution_receipt_path_mismatch");
  }
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_RECEIPT_SQL)
      .bind(
        authorizationIdSha256,
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
        receiptCredentialIdSha256,
        receipt.requestIdSha256,
        receipt.receiptDigestSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }
  const persisted = await readReceipt(
    session,
    authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persisted === null
    || !matchesReceipt(
      persisted,
      receipt,
      receiptCredentialIdSha256,
    )
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError("execution_receipt_conflict");
  }
  const snapshot = await readSnapshotByDigest(
    session,
    authorizationIdSha256,
    receipt.claimDigestSha256,
  );
  if (
    snapshot.claim.ledger_identity_sha256
      !== receipt.ledgerIdentitySha256
    || snapshot.claim.execution_plan_sha256
      !== receipt.executionPlanSha256
    || snapshot.claim.ledger_version !== receipt.sequence
    || snapshot.claim.ledger_head_sha256
      !== receipt.receiptDigestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded
      ? "receipt_appended"
      : "receipt_replayed",
    claim: snapshot.claim,
    receipt: persisted,
  };
}

export async function admitAndStartOperationFive(
  database: D1Database,
  admission: OperationFiveAdmission,
  receipt: ExecutionReceipt,
): Promise<{
  classification: "admitted" | "exact_replay";
  admission: OperationFiveAdmissionRow;
  claim: ExecutionClaimRow;
  receipt: ExecutionReceiptRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  if (
    admission.authorizationIdSha256 !== receipt.authorizationIdSha256
    || receipt.eventKind !== "operation_started"
    || receipt.operationOrdinal !== 5
    || receipt.actorCredentialIdSha256
      !== admission.enableCredentialIdSha256
    || receipt.requestIdSha256 !== admission.enableRequestIdSha256
    || receipt.requestSha256 !== admission.enableOperationRequestSha256
    || receipt.evidenceSha256 !== admission.confirmationDigestSha256
    || receipt.receiptDigestSha256
      !== admission.operationStartReceiptDigestSha256
  ) {
    throw new RepositoryConflictError(
      "operation_five_admission_mismatch",
    );
  }

  const statements = [
    session
      .prepare(INSERT_OPERATION_FIVE_ADMISSION_SQL)
      .bind(
        admission.authorizationIdSha256,
        admission.confirmationContract,
        admission.claimDigestSha256,
        admission.applicationTicketIdSha256,
        admission.applicationTicketDigestSha256,
        admission.applicationDatabaseIdentitySha256,
        admission.applicationActivationDigestSha256,
        admission.authorityActivationTerminalReceiptSha256,
        admission.authorityLedgerHeadSha256,
        admission.authorityDatabaseIdentitySha256,
        admission.authorityVersionId,
        admission.applicationAcknowledgementDigestSha256,
        admission.applicationVersionId,
        admission.applicationReadCredentialIdSha256,
        admission.applicationReadRequestIdSha256,
        admission.applicationResponseSha256,
        admission.applicationResponseBytes,
        admission.enableCredentialIdSha256,
        admission.enableRequestIdSha256,
        admission.commandEnableRequestIdSha256,
        admission.enableOperationRequestSha256,
        admission.confirmationDigestSha256,
        admission.operationStartReceiptDigestSha256,
      ),
    session
      .prepare(INSERT_RECEIPT_SQL)
      .bind(
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
        admission.enableCredentialIdSha256,
        receipt.requestIdSha256,
        receipt.receiptDigestSha256,
      ),
  ];
  let writeSucceeded = false;
  try {
    const results = await session.batch(statements);
    writeSucceeded =
      results.length === statements.length
      && results.every((result) =>
        result.success === true && (result.meta?.changes ?? 0) > 0
      );
  } catch {
    writeSucceeded = false;
  }

  const persistedAdmission = await readOperationFiveAdmission(
    session,
    admission.authorizationIdSha256,
  );
  const persistedReceipt = await readReceipt(
    session,
    receipt.authorizationIdSha256,
    receipt.sequence,
  );
  if (
    persistedAdmission === null
    || persistedReceipt === null
    || !matchesOperationFiveAdmission(persistedAdmission, admission)
    || !matchesReceipt(
      persistedReceipt,
      receipt,
      admission.enableCredentialIdSha256,
    )
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError(
      "operation_five_admission_conflict",
    );
  }
  const snapshot = await readSnapshotByDigest(
    session,
    admission.authorizationIdSha256,
    admission.claimDigestSha256,
  );
  if (
    snapshot.claim.enable_intent_seen !== 1
    || snapshot.claim.ledger_version < receipt.sequence
    || snapshot.receipts[receipt.sequence - 1]?.receipt_digest_sha256
      !== receipt.receiptDigestSha256
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "admitted" : "exact_replay",
    admission: persistedAdmission,
    claim: snapshot.claim,
    receipt: persistedReceipt,
  };
}

export async function createOperationFiveDispatchOutbox(
  database: D1Database,
  outbox: OperationFiveDispatchOutbox,
): Promise<{
  classification: "prepared" | "exact_replay";
  outbox: OperationFiveDispatchOutboxRow;
  claim: ExecutionClaimRow;
}> {
  const session = database.withSession("first-primary");
  await requireExecutionSchema(session);
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL)
      .bind(
        outbox.authorizationIdSha256,
        outbox.dispatchContract,
        outbox.claimDigestSha256,
        outbox.applicationTicketIdSha256,
        outbox.applicationTicketDigestSha256,
        outbox.applicationDatabaseIdentitySha256,
        outbox.applicationActivationDigestSha256,
        outbox.applicationAcknowledgementDigestSha256,
        outbox.operationFiveAdmissionDigestSha256,
        outbox.operationFiveStartReceiptSha256,
        outbox.authorityDatabaseIdentitySha256,
        outbox.authorityVersionId,
        outbox.authorityLedgerHeadSha256,
        outbox.applicationVersionId,
        outbox.applicationReadCredentialIdSha256,
        outbox.applicationReadRequestIdSha256,
        outbox.applicationResponseSha256,
        outbox.applicationResponseBytes,
        outbox.applicationDatabaseNow,
        outbox.dispatchCredentialIdSha256,
        outbox.dispatchRequestIdSha256,
        outbox.commandDispatchRequestIdSha256,
        outbox.controllerServiceName,
        outbox.controllerEnableOperationIdSha256,
        outbox.controllerBaselineVersionId,
        outbox.controllerEnabledVersionId,
        outbox.dispatchRequestSha256,
        outbox.outboxDigestSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }

  const persisted = await readOperationFiveDispatchOutbox(
    session,
    outbox.authorizationIdSha256,
  );
  if (
    persisted === null
    || !matchesOperationFiveDispatchOutbox(persisted, outbox)
  ) {
    if (writeSucceeded) throw new RepositoryUnavailableError(true);
    throw new RepositoryConflictError(
      "operation_five_dispatch_outbox_conflict",
    );
  }
  const snapshot = await readSnapshotByDigest(
    session,
    outbox.authorizationIdSha256,
    outbox.claimDigestSha256,
  );
  if (
    snapshot.claim.ledger_version < 4
    || snapshot.claim.enable_intent_seen !== 1
  ) {
    throw new RepositoryUnavailableError(true);
  }
  return {
    classification: writeSucceeded ? "prepared" : "exact_replay",
    outbox: persisted,
    claim: snapshot.claim,
  };
}

async function requireExecutionSchema(
  session: D1DatabaseSession,
): Promise<void> {
  let row: SchemaProbeRow | null;
  try {
    row = await session
      .prepare(SCHEMA_PROBE_SQL)
      .first<SchemaProbeRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (
    row === null
    || row.claim_columns !== CLAIM_COLUMNS.join(",")
    || row.operation_columns !== OPERATION_COLUMNS.join(",")
    || row.receipt_columns !== RECEIPT_COLUMNS.join(",")
    || row.operation_five_admission_columns
      !== OPERATION_FIVE_ADMISSION_COLUMNS.join(",")
    || row.operation_five_dispatch_outbox_columns
      !== OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS.join(",")
  ) {
    throw new RepositoryUnavailableError(false);
  }
}

async function readOperationFiveAdmission(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveAdmissionRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${OPERATION_FIVE_ADMISSION_COLUMNS.join(", ")}
         FROM shard_placement_authority_operation_five_admissions
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<OperationFiveAdmissionRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readOperationFiveDispatchOutbox(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<OperationFiveDispatchOutboxRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${OPERATION_FIVE_DISPATCH_OUTBOX_COLUMNS.join(", ")}
         FROM shard_placement_authority_operation_five_dispatch_outbox
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<OperationFiveDispatchOutboxRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

async function readSnapshot(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  claimOwnerSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const claim = await readClaim(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    "AND claim_owner_sha256 = ?3",
    claimOwnerSha256,
  );
  return readSnapshotRows(session, claim);
}

async function readSnapshotByDigest(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
): Promise<ExecutionClaimSnapshot> {
  const claim = await readClaim(
    session,
    authorizationIdSha256,
    claimDigestSha256,
    "",
  );
  return readSnapshotRows(session, claim);
}

async function readClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  claimDigestSha256: string,
  extraPredicate: string,
  extraBinding?: string,
): Promise<ExecutionClaimRow> {
  let claim: ExecutionClaimRow | null;
  try {
    const statement = session
      .prepare(
        `SELECT ${CLAIM_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_claims
         WHERE authorization_id_sha256 = ?1
           AND claim_digest_sha256 = ?2
           ${extraPredicate}
         LIMIT 1`,
      );
    claim = extraBinding === undefined
      ? await statement
        .bind(authorizationIdSha256, claimDigestSha256)
        .first<ExecutionClaimRow>()
      : await statement
        .bind(authorizationIdSha256, claimDigestSha256, extraBinding)
        .first<ExecutionClaimRow>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (claim === null) {
    await classifyMissingClaim(session, authorizationIdSha256);
  }
  return claim!;
}

async function readSnapshotRows(
  session: D1DatabaseSession,
  claim: ExecutionClaimRow,
): Promise<ExecutionClaimSnapshot> {
  try {
    const operations = await session
      .prepare(
        `SELECT ${OPERATION_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_operations
         WHERE authorization_id_sha256 = ?1
         ORDER BY ordinal`,
      )
      .bind(claim.authorization_id_sha256)
      .all<ExecutionOperationRow>();
    const receipts = await session
      .prepare(
        `SELECT ${RECEIPT_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_receipts
         WHERE authorization_id_sha256 = ?1
         ORDER BY sequence`,
      )
      .bind(claim.authorization_id_sha256)
      .all<ExecutionReceiptRow>();
    return {
      claim,
      operations: operations.results,
      receipts: receipts.results,
    };
  } catch {
    throw new RepositoryUnavailableError(false);
  }
}

async function classifyMissingClaim(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
): Promise<never> {
  let present: { present: number } | null;
  try {
    present = await session
      .prepare(
        `SELECT 1 AS present
         FROM shard_placement_authority_execution_claims
         WHERE authorization_id_sha256 = ?1
         LIMIT 1`,
      )
      .bind(authorizationIdSha256)
      .first<{ present: number }>();
  } catch {
    throw new RepositoryUnavailableError(false);
  }
  if (present === null) throw new RepositoryNotFoundError();
  throw new RepositoryConflictError("exact_execution_claim_mismatch");
}

async function readReceipt(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  sequence: number,
): Promise<ExecutionReceiptRow | null> {
  try {
    return await session
      .prepare(
        `SELECT ${RECEIPT_COLUMNS.join(", ")}
         FROM shard_placement_authority_execution_receipts
         WHERE authorization_id_sha256 = ?1
           AND sequence = ?2
         LIMIT 1`,
      )
      .bind(authorizationIdSha256, sequence)
      .first<ExecutionReceiptRow>();
  } catch {
    throw new RepositoryUnavailableError(true);
  }
}

function matchesClaimSnapshot(
  snapshot: ExecutionClaimSnapshot,
  claim: ExecutionClaim,
): boolean {
  const row = snapshot.claim;
  return (
    row.authorization_id_sha256 === claim.authorizationIdSha256
    && row.permit_subject_digest_sha256
      === claim.permitSubjectDigestSha256
    && row.execution_nonce_sha256 === claim.executionNonceSha256
    && row.application_ticket_id_sha256
      === claim.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === claim.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === claim.applicationDatabaseIdentitySha256
    && row.authority_database_identity_sha256
      === claim.authorityDatabaseIdentitySha256
    && row.campaign_id === claim.campaignId
    && row.campaign_nonce_sha256 === claim.campaignNonceSha256
    && row.claim_scope === claim.claimScope
    && row.execution_plan_sha256 === claim.executionPlanSha256
    && row.release_sha256 === claim.releaseSha256
    && row.publication_sha256 === claim.publicationSha256
    && row.execution_activation_sha256
      === claim.executionActivationSha256
    && row.runner_build_sha256 === claim.runnerBuildSha256
    && row.claim_owner_sha256 === claim.claimOwnerSha256
    && row.ledger_identity_sha256 === claim.ledgerIdentitySha256
    && row.baseline_operation_id_sha256
      === claim.baselineOperationIdSha256
    && row.baseline_terminal_digest_sha256
      === claim.baselineTerminalReceiptSha256
    && row.preparation_operation_id_sha256
      === claim.preparationOperationIdSha256
    && row.claim_operation_id_sha256
      === claim.claimOperationIdSha256
    && row.operation_schedule_sha256
      === claim.operationScheduleSha256
    && row.claim_credential_id_sha256
      === claim.claimCredentialIdSha256
    && row.claim_request_id_sha256 === claim.requestIdSha256
    && row.claim_digest_sha256 === claim.claimDigestSha256
    && row.claim_acquired_receipt_digest_sha256
      === claim.claimAcquiredReceiptSha256
    && row.generated_at === claim.generatedAt
    && row.normal_deadline_at === claim.normalDeadlineAt
    && snapshot.operations.length === claim.operations.length
    && snapshot.operations.every(
      (operation, index) =>
        matchesOperation(operation, claim.operations[index]!),
    )
    && snapshot.receipts.length >= 1
    && snapshot.receipts[0]?.receipt_digest_sha256
      === claim.claimAcquiredReceiptSha256
    && snapshot.receipts[0]?.lease_owner_sha256
      === claim.claimOwnerSha256
    && snapshot.receipts[0]?.lease_token_sha256
      === claim.leaseTokenSha256
    && snapshot.receipts[0]?.lease_generation === 1
  );
}

function matchesOperation(
  row: ExecutionOperationRow,
  operation: ExecutionOperation,
): boolean {
  return (
    row.ordinal === operation.ordinal
    && row.operation_id_sha256 === operation.operationIdSha256
    && row.kind === operation.kind
    && row.shard_index === operation.shardIndex
  );
}

function matchesReceipt(
  row: ExecutionReceiptRow,
  receipt: ExecutionReceipt,
  credentialIdSha256: string,
): boolean {
  return (
    row.sequence === receipt.sequence
    && row.event_kind === receipt.eventKind
    && row.claim_digest_sha256 === receipt.claimDigestSha256
    && row.execution_plan_sha256 === receipt.executionPlanSha256
    && row.ledger_identity_sha256 === receipt.ledgerIdentitySha256
    && row.operation_ordinal === receipt.operationOrdinal
    && row.operation_id_sha256 === receipt.operationIdSha256
    && row.operation_kind === receipt.operationKind
    && row.shard_index === receipt.shardIndex
    && row.predecessor_receipt_sha256
      === receipt.predecessorReceiptSha256
    && row.request_sha256 === receipt.requestSha256
    && row.response_sha256 === receipt.responseSha256
    && row.cloudflare_request_id_sha256
      === receipt.cloudflareRequestIdSha256
    && row.evidence_sha256 === receipt.evidenceSha256
    && row.safety_reason === receipt.safetyReason
    && row.outcome === receipt.outcome
    && row.lease_owner_sha256 === receipt.actorOwnerSha256
    && row.lease_token_sha256 === receipt.leaseTokenSha256
    && row.lease_generation === receipt.leaseGeneration
    && row.receipt_credential_id_sha256 === credentialIdSha256
    && row.request_id_sha256 === receipt.requestIdSha256
    && row.receipt_digest_sha256 === receipt.receiptDigestSha256
  );
}

function matchesOperationFiveAdmission(
  row: OperationFiveAdmissionRow,
  admission: OperationFiveAdmission,
): boolean {
  return (
    row.authorization_id_sha256 === admission.authorizationIdSha256
    && row.contract_version === 1
    && row.confirmation_contract === admission.confirmationContract
    && row.claim_digest_sha256 === admission.claimDigestSha256
    && row.application_ticket_id_sha256
      === admission.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === admission.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === admission.applicationDatabaseIdentitySha256
    && row.application_activation_digest_sha256
      === admission.applicationActivationDigestSha256
    && row.authority_activation_terminal_receipt_sha256
      === admission.authorityActivationTerminalReceiptSha256
    && row.authority_ledger_head_sha256
      === admission.authorityLedgerHeadSha256
    && row.authority_database_identity_sha256
      === admission.authorityDatabaseIdentitySha256
    && row.authority_version_id === admission.authorityVersionId
    && row.application_acknowledgement_digest_sha256
      === admission.applicationAcknowledgementDigestSha256
    && row.application_version_id === admission.applicationVersionId
    && row.application_read_credential_id_sha256
      === admission.applicationReadCredentialIdSha256
    && row.application_read_request_id_sha256
      === admission.applicationReadRequestIdSha256
    && row.application_response_sha256
      === admission.applicationResponseSha256
    && row.application_response_bytes
      === admission.applicationResponseBytes
    && row.enable_credential_id_sha256
      === admission.enableCredentialIdSha256
    && row.enable_request_id_sha256 === admission.enableRequestIdSha256
    && row.command_enable_request_id_sha256
      === admission.commandEnableRequestIdSha256
    && row.enable_operation_request_sha256
      === admission.enableOperationRequestSha256
    && row.confirmation_digest_sha256
      === admission.confirmationDigestSha256
    && row.operation_start_receipt_digest_sha256
      === admission.operationStartReceiptDigestSha256
    && Number.isSafeInteger(row.confirmed_at)
    && row.confirmed_at > 0
  );
}

function matchesOperationFiveDispatchOutbox(
  row: OperationFiveDispatchOutboxRow,
  outbox: OperationFiveDispatchOutbox,
): boolean {
  return (
    row.authorization_id_sha256 === outbox.authorizationIdSha256
    && row.contract_version === 1
    && row.dispatch_contract === outbox.dispatchContract
    && row.claim_digest_sha256 === outbox.claimDigestSha256
    && row.application_ticket_id_sha256
      === outbox.applicationTicketIdSha256
    && row.application_ticket_digest_sha256
      === outbox.applicationTicketDigestSha256
    && row.application_database_identity_sha256
      === outbox.applicationDatabaseIdentitySha256
    && row.application_activation_digest_sha256
      === outbox.applicationActivationDigestSha256
    && row.application_acknowledgement_digest_sha256
      === outbox.applicationAcknowledgementDigestSha256
    && row.operation_five_admission_digest_sha256
      === outbox.operationFiveAdmissionDigestSha256
    && row.operation_five_start_receipt_sha256
      === outbox.operationFiveStartReceiptSha256
    && row.authority_database_identity_sha256
      === outbox.authorityDatabaseIdentitySha256
    && row.authority_version_id === outbox.authorityVersionId
    && row.authority_ledger_head_sha256
      === outbox.authorityLedgerHeadSha256
    && row.application_version_id === outbox.applicationVersionId
    && row.application_read_credential_id_sha256
      === outbox.applicationReadCredentialIdSha256
    && row.application_read_request_id_sha256
      === outbox.applicationReadRequestIdSha256
    && row.application_response_sha256
      === outbox.applicationResponseSha256
    && row.application_response_bytes
      === outbox.applicationResponseBytes
    && row.application_database_now === outbox.applicationDatabaseNow
    && row.dispatch_credential_id_sha256
      === outbox.dispatchCredentialIdSha256
    && row.dispatch_request_id_sha256
      === outbox.dispatchRequestIdSha256
    && row.command_dispatch_request_id_sha256
      === outbox.commandDispatchRequestIdSha256
    && row.controller_service_name === outbox.controllerServiceName
    && row.controller_enable_operation_id_sha256
      === outbox.controllerEnableOperationIdSha256
    && row.controller_baseline_version_id
      === outbox.controllerBaselineVersionId
    && row.controller_enabled_version_id
      === outbox.controllerEnabledVersionId
    && row.dispatch_request_sha256 === outbox.dispatchRequestSha256
    && row.outbox_digest_sha256 === outbox.outboxDigestSha256
    && row.outbox_state === "prepared"
    && Number.isSafeInteger(row.prepared_at)
    && row.prepared_at > 0
  );
}

export const executionRepositorySqlForTest = {
  insertClaim: INSERT_CLAIM_SQL,
  insertOperation: INSERT_OPERATION_SQL,
  insertReceipt: INSERT_RECEIPT_SQL,
  insertOperationFiveAdmission:
    INSERT_OPERATION_FIVE_ADMISSION_SQL,
  insertOperationFiveDispatchOutbox:
    INSERT_OPERATION_FIVE_DISPATCH_OUTBOX_SQL,
} as const;
