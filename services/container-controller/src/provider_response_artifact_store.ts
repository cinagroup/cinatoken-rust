import type {
  ClientResponseArtifactManifest,
  ProviderResponseArtifactAttachment,
  ProviderResponseEvidenceManifest,
  StorageResultRecord,
} from "./ledger";
import {
  PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
  PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
  PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
  type ProviderResponseClassV3,
  type VerifiedProviderResponseV3,
} from "./provider_response_v3";
import { ProtocolError } from "./protocol";
import {
  CONTENT_SHA256_HEADER,
  R2_CLIENT_ARTIFACT_HOST,
  R2_CLIENT_ARTIFACT_PATH,
  R2_OBJECT_VERSION_HEADER,
  R2_PROVIDER_EVIDENCE_HOST,
  R2_PROVIDER_EVIDENCE_PATH,
  R2_RESULT_HOST,
  R2_RESULT_PATH,
  STORAGE_GATEWAY_ACTIONS,
  deriveR2ClientArtifactKey,
  deriveR2ProviderEvidenceKey,
  deriveR2ResultKey,
  handleStorageGatewayRequest,
  requireD1ProviderUsageReceipt,
  requireD1ProviderUsageReceiptSchema,
  type CanonicalProviderUsageReceipt,
  type D1AdmissionSnapshot,
  type ProviderUsageReceiptOutcome,
  type R2ClientArtifactPutGrant,
  type R2ProviderEvidencePutGrant,
  type R2ResultPutGrant,
  type StorageGatewayEnvironment,
} from "./storage_gateway";

export const PROVIDER_RESPONSE_ARTIFACT_CONTRACT =
  "container-response-artifacts-v1" as const;
export const RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK =
  "application/octet-stream" as const;

const MAX_RESPONSE_BODY_BYTES = 4_194_304;
const MAX_GATEWAY_RESPONSE_BYTES = 1_024;
const MAX_UNIX_MILLISECONDS = 253_402_300_799_999;
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTENT_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/;
const AUTHORITY_TOKEN: unique symbol = Symbol("provider-response-artifact-authority");
const RAW_PERSISTENCE_TOKEN: unique symbol = Symbol("raw-provider-evidence-persisted");

export type ProviderResponseArtifactPersistenceBoundary =
  | "before_raw_r2"
  | "after_raw_r2"
  | "before_raw_d1_insert"
  | "after_raw_d1_insert"
  | "after_raw_d1_readback"
  | "before_client_r2"
  | "after_client_r2"
  | "before_compatibility_r2"
  | "after_compatibility_r2"
  | "before_usage_receipt_d1"
  | "after_usage_receipt_d1"
  | "before_client_d1_insert"
  | "after_client_d1_insert"
  | "after_client_d1_readback";

export interface ProviderResponseArtifactPersistenceOptions {
  readonly onBoundary?: (
    boundary: ProviderResponseArtifactPersistenceBoundary,
  ) => void | Promise<void>;
}

export interface ProviderResponseArtifactAuthority {
  readonly admission: Readonly<D1AdmissionSnapshot>;
  readonly atomic_admission_sha256: string;
  readonly response_artifact_contract: typeof PROVIDER_RESPONSE_ARTIFACT_CONTRACT;
  readonly recovery_state: ProviderResponseArtifactRecoveryState;
  readonly [AUTHORITY_TOKEN]: true;
}

export type ProviderResponseArtifactRecoveryState =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "raw_only";
      readonly raw_manifest: ProviderResponseEvidenceManifest;
      readonly provider_status: number;
      readonly provider_response_evidence_sha256: string;
      readonly recorded_at: number;
    }
  | {
      readonly kind: "complete";
      readonly raw_manifest: ProviderResponseEvidenceManifest;
      readonly client_manifest: ClientResponseArtifactManifest;
      readonly classification: ProviderResponseClassV3;
      readonly provider_status: number;
      readonly client_status: number;
      readonly status: "succeeded" | "interpreted_reject";
      readonly provider_usage_receipt_sha256: string | null;
      readonly attachment: ProviderResponseArtifactAttachment;
    };

export interface PersistedRawProviderEvidence {
  readonly manifest: ProviderResponseEvidenceManifest;
  readonly recorded_at: number;
  readonly r2_replayed: boolean;
  readonly d1_replayed: boolean;
  readonly [RAW_PERSISTENCE_TOKEN]: true;
}

export interface PersistedProviderResponseArtifacts {
  readonly raw: PersistedRawProviderEvidence;
  readonly raw_manifest: ProviderResponseEvidenceManifest;
  readonly client_manifest: ClientResponseArtifactManifest;
  readonly classification: ProviderResponseClassV3;
  readonly provider_status: number;
  readonly client_status: number;
  readonly status: "succeeded" | "interpreted_reject";
  readonly provider_usage_receipt_sha256: string | null;
  readonly compatibility_result: StorageResultRecord | null;
  readonly client_r2_replayed: boolean;
  readonly client_d1_replayed: boolean;
  readonly compatibility_result_replayed: boolean | null;
  readonly usage_receipt_replayed: boolean | null;
  readonly attachment: ProviderResponseArtifactAttachment;
}

interface AtomicAdmissionAuthorityRow {
  reservation_key: string;
  operation_id: string;
  owner_generation: number;
  provider_attempt_generation: number;
  atomic_admission_sha256: string;
  operation_admission_sha256: string;
  response_artifact_contract: string;
}

interface R2WriteRecord extends StorageResultRecord {
  replayed: boolean;
}

type ResponseArtifactGrant =
  | R2ProviderEvidencePutGrant
  | R2ClientArtifactPutGrant
  | R2ResultPutGrant;

type ExpectedRow = Readonly<Record<string, string | number | null>>;
type D1ReadSession = Pick<D1Database, "prepare">;

const RAW_ROW_COLUMNS = [
  "operation_id",
  "reservation_key",
  "owner_generation",
  "attempt_generation",
  "provider_operation_id",
  "atomic_admission_sha256",
  "admission_sha256",
  "request_sha256",
  "channel_id",
  "selected_group",
  "model_name",
  "endpoint_path",
  "egress_profile",
  "egress_worker_version_id",
  "raw_response_status",
  "raw_response_content_type",
  "raw_response_headers_json",
  "raw_response_headers_sha256",
  "raw_response_object_key",
  "raw_response_object_version",
  "raw_response_sha256",
  "raw_response_size",
  "provider_request_id",
  "provider_completed_at",
  "interpreter_source_commit",
  "response_contract",
  "provider_response_evidence_sha256",
  "recorded_at",
] as const;

const CLIENT_ROW_COLUMNS = [
  "operation_id",
  "owner_generation",
  "attempt_generation",
  "provider_response_evidence_sha256",
  "response_contract",
  "response_class",
  "client_response_status",
  "client_response_content_type",
  "client_response_headers_json",
  "client_response_headers_sha256",
  "client_response_object_key",
  "client_response_object_version",
  "client_response_sha256",
  "client_response_size",
  "provider_usage_receipt_sha256",
  "client_response_artifact_sha256",
  "created_at",
] as const;

const RAW_NUMERIC_COLUMNS = new Set<string>([
  "owner_generation",
  "attempt_generation",
  "channel_id",
  "raw_response_status",
  "raw_response_size",
  "provider_completed_at",
  "recorded_at",
]);
const RAW_NULLABLE_STRING_COLUMNS = new Set<string>([
  "raw_response_content_type",
  "provider_request_id",
]);
const CLIENT_NUMERIC_COLUMNS = new Set<string>([
  "owner_generation",
  "attempt_generation",
  "client_response_status",
  "client_response_size",
  "created_at",
]);
const CLIENT_NULLABLE_STRING_COLUMNS = new Set<string>([
  "provider_usage_receipt_sha256",
]);

const RESPONSE_ARTIFACT_SCHEMA_READINESS_SQL = `
SELECT
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table'
      AND name = 'relay_container_provider_response_evidence') AS raw_table_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_provider_response_evidence'))
    AS raw_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_provider_response_evidence')
    WHERE name IN (
      'operation_id', 'reservation_key', 'owner_generation', 'attempt_generation',
      'provider_operation_id', 'atomic_admission_sha256', 'admission_sha256',
      'request_sha256', 'channel_id', 'selected_group', 'model_name',
      'endpoint_path', 'egress_profile', 'egress_worker_version_id',
      'raw_response_status', 'raw_response_content_type',
      'raw_response_headers_json', 'raw_response_headers_sha256',
      'raw_response_object_key', 'raw_response_object_version',
      'raw_response_sha256', 'raw_response_size', 'provider_request_id',
      'provider_completed_at', 'interpreter_source_commit', 'response_contract',
      'provider_response_evidence_sha256', 'recorded_at'
    )) AS raw_required_column_count,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table'
      AND name = 'relay_container_provider_response_evidence_identities')
    AS raw_identity_table_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_provider_response_evidence_identities'))
    AS raw_identity_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_provider_response_evidence_identities')
    WHERE name IN (
      'operation_id', 'owner_generation', 'attempt_generation',
      'provider_operation_id', 'provider_response_evidence_sha256',
      'raw_response_object_key', 'raw_response_object_version'
    )) AS raw_identity_required_column_count,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table'
      AND name = 'relay_container_client_response_artifacts') AS client_table_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_client_response_artifacts'))
    AS client_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_client_response_artifacts')
    WHERE name IN (
      'operation_id', 'owner_generation', 'attempt_generation',
      'provider_response_evidence_sha256', 'response_contract', 'response_class',
      'client_response_status', 'client_response_content_type',
      'client_response_headers_json', 'client_response_headers_sha256',
      'client_response_object_key', 'client_response_object_version',
      'client_response_sha256', 'client_response_size',
      'provider_usage_receipt_sha256', 'client_response_artifact_sha256',
      'created_at'
    )) AS client_required_column_count,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table'
      AND name = 'relay_container_client_response_artifact_identities')
    AS client_identity_table_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_client_response_artifact_identities'))
    AS client_identity_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_client_response_artifact_identities')
    WHERE name IN (
      'operation_id', 'owner_generation', 'attempt_generation',
      'provider_response_evidence_sha256', 'client_response_artifact_sha256',
      'client_response_object_key', 'client_response_object_version'
    )) AS client_identity_required_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_operations')
    WHERE name = 'response_artifact_contract') AS operation_contract_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_terminal_events')
    WHERE name = 'client_response_artifact_sha256') AS terminal_artifact_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_atomic_admissions')
    WHERE name IN (
      'reservation_key', 'operation_id', 'owner_generation',
      'provider_attempt_generation', 'atomic_admission_sha256',
      'operation_admission_sha256'
    )) AS atomic_identity_column_count,
  (SELECT COUNT(*)
     FROM pragma_table_info('relay_container_provider_usage_receipts')
    WHERE name IN (
      'operation_id', 'owner_generation', 'attempt_generation',
      'usage_receipt_sha256'
    )) AS receipt_identity_column_count,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'index'
      AND name IN (
        'idx_relay_container_atomic_admissions_response_artifact_identity',
        'idx_relay_container_provider_usage_receipts_response_artifact_identity',
        'idx_relay_container_provider_response_evidence_recorded',
        'idx_relay_container_client_response_artifacts_created',
        'idx_relay_container_terminal_events_response_artifact'
      )) AS required_index_count,
  (SELECT COUNT(*) FROM pragma_index_info(
      'idx_relay_container_atomic_admissions_response_artifact_identity')
    WHERE (seqno = 0 AND name = 'reservation_key')
       OR (seqno = 1 AND name = 'operation_id')
       OR (seqno = 2 AND name = 'owner_generation')
       OR (seqno = 3 AND name = 'provider_attempt_generation')
       OR (seqno = 4 AND name = 'atomic_admission_sha256')
       OR (seqno = 5 AND name = 'operation_admission_sha256'))
    AS atomic_identity_index_column_count,
  (SELECT COUNT(*) FROM pragma_index_info(
      'idx_relay_container_provider_usage_receipts_response_artifact_identity')
    WHERE (seqno = 0 AND name = 'operation_id')
       OR (seqno = 1 AND name = 'owner_generation')
       OR (seqno = 2 AND name = 'attempt_generation')
       OR (seqno = 3 AND name = 'usage_receipt_sha256'))
    AS receipt_identity_index_column_count,
  (SELECT COUNT(*) FROM pragma_index_info(
      'idx_relay_container_provider_response_evidence_recorded')
    WHERE (seqno = 0 AND name = 'provider_completed_at')
       OR (seqno = 1 AND name = 'recorded_at')
       OR (seqno = 2 AND name = 'operation_id'))
    AS raw_recorded_index_column_count,
  (SELECT COUNT(*) FROM pragma_index_info(
      'idx_relay_container_client_response_artifacts_created')
    WHERE (seqno = 0 AND name = 'response_class')
       OR (seqno = 1 AND name = 'created_at')
       OR (seqno = 2 AND name = 'operation_id'))
    AS client_created_index_column_count,
  (SELECT COUNT(*) FROM pragma_index_info(
      'idx_relay_container_terminal_events_response_artifact')
    WHERE seqno = 0 AND name = 'client_response_artifact_sha256')
    AS terminal_artifact_index_column_count,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN (
        'relay_container_response_artifact_operation_insert_guard',
        'relay_container_response_artifact_operation_contract_guard',
        'relay_container_provider_response_evidence_identity_insert_guard',
        'relay_container_provider_response_evidence_insert_authority_guard',
        'relay_container_provider_response_evidence_identity_guard',
        'relay_container_provider_response_evidence_identity_update_guard',
        'relay_container_provider_response_evidence_identity_delete_guard',
        'relay_container_provider_response_evidence_update_guard',
        'relay_container_provider_response_evidence_delete_guard',
        'relay_container_client_response_artifact_identity_insert_guard',
        'relay_container_client_response_artifact_insert_authority_guard',
        'relay_container_client_response_artifact_identity_guard',
        'relay_container_client_response_artifact_identity_update_guard',
        'relay_container_client_response_artifact_identity_delete_guard',
        'relay_container_client_response_artifact_update_guard',
        'relay_container_client_response_artifact_delete_guard',
        'relay_container_terminal_event_response_artifact_guard',
        'relay_container_operation_response_artifact_terminal_guard',
        'relay_container_scheduled_terminalization_response_artifact_guard',
        'relay_container_reconciliation_response_artifact_convergence_guard'
      )) AS required_trigger_count,
  (SELECT COUNT(*)
     FROM pragma_foreign_key_list('relay_container_provider_response_evidence')
    WHERE "table" IN (
      'relay_container_atomic_admissions',
      'relay_container_provider_egress_grants'
    )) AS raw_foreign_key_column_count,
  (SELECT COUNT(*)
     FROM pragma_foreign_key_list('relay_container_client_response_artifacts')
    WHERE "table" IN (
      'relay_container_provider_response_evidence',
      'relay_container_provider_usage_receipts'
    )) AS client_foreign_key_column_count
`.trim();

const ATOMIC_ADMISSION_AUTHORITY_SQL = `
SELECT atomic.reservation_key,
       atomic.operation_id,
       atomic.owner_generation,
       atomic.provider_attempt_generation,
       atomic.atomic_admission_sha256,
       atomic.operation_admission_sha256,
       operation.response_artifact_contract
FROM relay_container_atomic_admissions AS atomic
JOIN relay_container_operations AS operation
  ON operation.operation_id = atomic.operation_id
 AND operation.reservation_key = atomic.reservation_key
 AND operation.owner_generation = atomic.owner_generation
JOIN relay_billing_reservations AS reservation
  ON reservation.reservation_key = atomic.reservation_key
 AND reservation.owner_generation = atomic.owner_generation
WHERE atomic.reservation_key = ?1
  AND atomic.operation_id = ?2
  AND atomic.owner_generation = ?3
  AND atomic.provider_attempt_generation = 1
  AND atomic.operation_admission_sha256 = ?4
  AND operation.provider_operation_id = ?5
  AND operation.admission_sha256 = ?4
  AND operation.input_sha256 = ?6
  AND operation.channel_id = ?7
  AND reservation.channel_id = ?7
  AND operation.selected_group = ?8
  AND reservation.selected_group = ?8
  AND reservation.model_name = ?9
  AND reservation.endpoint_path = ?10
  AND operation.protocol_version = ?11
  AND operation.operation_kind = ?12
  AND operation.status IN ('prepared', 'dispatched')
  AND reservation.status = 'reserved'
  AND operation.response_artifact_contract = 'container-response-artifacts-v1'
LIMIT 1
`.trim();

const RAW_INSERT_SQL = `
INSERT OR IGNORE INTO relay_container_provider_response_evidence (
  operation_id, reservation_key, owner_generation, attempt_generation,
  provider_operation_id, atomic_admission_sha256, admission_sha256,
  request_sha256, channel_id, selected_group, model_name, endpoint_path,
  egress_profile, egress_worker_version_id, raw_response_status,
  raw_response_content_type, raw_response_headers_json,
  raw_response_headers_sha256, raw_response_object_key,
  raw_response_object_version, raw_response_sha256, raw_response_size,
  provider_request_id, provider_completed_at, interpreter_source_commit,
  response_contract, provider_response_evidence_sha256, recorded_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
  ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
  ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28
)
`.trim();

const RAW_READBACK_SQL = `
SELECT operation_id, reservation_key, owner_generation, attempt_generation,
       provider_operation_id, atomic_admission_sha256, admission_sha256,
       request_sha256, channel_id, selected_group, model_name, endpoint_path,
       egress_profile, egress_worker_version_id, raw_response_status,
       raw_response_content_type, raw_response_headers_json,
       raw_response_headers_sha256, raw_response_object_key,
       raw_response_object_version, raw_response_sha256, raw_response_size,
       provider_request_id, provider_completed_at, interpreter_source_commit,
       response_contract, provider_response_evidence_sha256, recorded_at
FROM relay_container_provider_response_evidence
WHERE operation_id = ?1
  AND owner_generation = ?2
  AND attempt_generation = ?3
LIMIT 1
`.trim();

const CLIENT_INSERT_SQL = `
INSERT OR IGNORE INTO relay_container_client_response_artifacts (
  operation_id, owner_generation, attempt_generation,
  provider_response_evidence_sha256, response_contract, response_class,
  client_response_status, client_response_content_type,
  client_response_headers_json, client_response_headers_sha256,
  client_response_object_key, client_response_object_version,
  client_response_sha256, client_response_size,
  provider_usage_receipt_sha256, client_response_artifact_sha256, created_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
  ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
)
`.trim();

const CLIENT_READBACK_SQL = `
SELECT operation_id, owner_generation, attempt_generation,
       provider_response_evidence_sha256, response_contract, response_class,
       client_response_status, client_response_content_type,
       client_response_headers_json, client_response_headers_sha256,
       client_response_object_key, client_response_object_version,
       client_response_sha256, client_response_size,
       provider_usage_receipt_sha256, client_response_artifact_sha256, created_at
FROM relay_container_client_response_artifacts
WHERE operation_id = ?1
  AND owner_generation = ?2
  AND attempt_generation = ?3
LIMIT 1
`.trim();

/** Verify the complete 0052 writer boundary before any provider dispatch. */
export async function preflightProviderResponseArtifactStore(
  env: StorageGatewayEnvironment,
  admission: D1AdmissionSnapshot,
): Promise<ProviderResponseArtifactAuthority> {
  if (!validAdmissionForResponseArtifacts(admission)) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ProtocolError("provider_response_artifact_schema_unavailable", 503);
  }

  let session: ReturnType<NonNullable<typeof database.withSession>>;
  try {
    session = database.withSession("first-primary");
    const schema = await session
      .prepare(RESPONSE_ARTIFACT_SCHEMA_READINESS_SQL)
      .first<Record<string, unknown>>();
    if (!validResponseArtifactSchema(schema)) {
      throw new ProtocolError("provider_response_artifact_schema_unavailable", 503);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("provider_response_artifact_schema_unavailable", 503);
  }

  try {
    await requireD1ProviderUsageReceiptSchema(env);
  } catch {
    throw new ProtocolError("provider_response_artifact_schema_unavailable", 503);
  }

  let value: Record<string, unknown> | null;
  try {
    value = await session
      .prepare(ATOMIC_ADMISSION_AUTHORITY_SQL)
      .bind(
        admission.reservation_key,
        admission.operation_id,
        admission.owner_generation,
        admission.admission_sha256,
        admission.provider_operation_id,
        admission.input_sha256,
        admission.channel_id,
        admission.selected_group,
        admission.model_name,
        admission.endpoint_path,
        admission.protocol_version,
        admission.operation_kind,
      )
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("provider_response_artifact_preflight_unavailable", 503);
  }
  if (value === null) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
  if (!isAtomicAdmissionAuthorityRow(value)) {
    throw new ProtocolError("provider_response_artifact_preflight_readback_invalid", 502);
  }
  if (!atomicAdmissionAuthorityMatches(value, admission)) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }

  const frozenAdmission = Object.freeze({ ...admission });
  const recoveryState = await readRecoveryStateFromSession(
    session,
    frozenAdmission,
    value.atomic_admission_sha256,
  );
  return Object.freeze({
    admission: frozenAdmission,
    atomic_admission_sha256: value.atomic_admission_sha256,
    response_artifact_contract: PROVIDER_RESPONSE_ARTIFACT_CONTRACT,
    recovery_state: recoveryState,
    [AUTHORITY_TOKEN]: true as const,
  });
}

/** Refresh immutable 0052 recovery state without R2 access or provider I/O. */
export async function readProviderResponseArtifactRecoveryState(
  env: StorageGatewayEnvironment,
  authority: ProviderResponseArtifactAuthority,
): Promise<ProviderResponseArtifactRecoveryState> {
  requireStoreAuthority(authority);
  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ProtocolError("provider_response_artifact_recovery_unavailable", 503);
  }
  try {
    const session = database.withSession("first-primary");
    return await readRecoveryStateFromSession(
      session,
      authority.admission,
      authority.atomic_admission_sha256,
    );
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("provider_response_artifact_recovery_unavailable", 503);
  }
}

/** Persist create-only raw R2 evidence, then append/read back the exact 0052 raw row. */
export async function persistRawProviderEvidence(
  env: StorageGatewayEnvironment,
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
  options: ProviderResponseArtifactPersistenceOptions = {},
): Promise<PersistedRawProviderEvidence> {
  await requireVerifiedAuthority(authority, verified);
  requireProviderResponsePersistenceEligibility(verified);
  const { admission } = authority;
  const { identity } = verified.envelope;
  const raw = verified.envelope.raw;
  const storageContentType = raw.content_type ?? RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK;
  const grant: R2ProviderEvidencePutGrant = {
    action: STORAGE_GATEWAY_ACTIONS.R2_PROVIDER_EVIDENCE_PUT,
    operation_id: admission.operation_id,
    owner_generation: admission.owner_generation,
    attempt_generation: identity.attempt_generation,
    provider_operation_id: admission.provider_operation_id,
    admission_sha256: admission.admission_sha256,
    egress_profile: identity.egress_profile,
    egress_worker_version_id: identity.egress_worker_version_id,
    provider_response_evidence_sha256:
      verified.envelope.provider_response_evidence_sha256,
    sha256: raw.body_sha256,
    size: raw.body_length,
    content_type: storageContentType,
  };

  await emitBoundary(options, "before_raw_r2");
  const object = await putR2Object(env, grant, verified.raw_body, {
    host: R2_PROVIDER_EVIDENCE_HOST,
    path: R2_PROVIDER_EVIDENCE_PATH,
    expectedKey: deriveR2ProviderEvidenceKey(grant),
    conflictCode: "provider_response_evidence_conflict",
    invalidCode: "provider_response_evidence_readback_invalid",
    unavailableCode: "provider_response_evidence_unavailable",
  });
  await emitBoundary(options, "after_raw_r2");

  const manifest: ProviderResponseEvidenceManifest = Object.freeze({
    object_key: object.object_key,
    object_version: object.object_version,
    provider_response_evidence_sha256:
      verified.envelope.provider_response_evidence_sha256,
    sha256: object.sha256,
    size: object.size,
    content_type: object.content_type,
  });
  const expected = rawExpectedRow(authority, verified, manifest);
  const d1Replayed = await persistExactD1Row(
    env,
    RAW_INSERT_SQL,
    RAW_READBACK_SQL,
    RAW_ROW_COLUMNS,
    RAW_NUMERIC_COLUMNS,
    RAW_NULLABLE_STRING_COLUMNS,
    expected,
    [identity.operation_id, identity.owner_generation, identity.attempt_generation],
    options,
    {
      before: "before_raw_d1_insert",
      afterInsert: "after_raw_d1_insert",
      afterReadback: "after_raw_d1_readback",
      conflictCode: "provider_response_evidence_conflict",
      readbackInvalidCode: "provider_response_evidence_readback_invalid",
      unavailableCode: "provider_response_evidence_unavailable",
    },
  );

  return Object.freeze({
    manifest,
    recorded_at: raw.completed_at,
    r2_replayed: object.replayed,
    d1_replayed: d1Replayed,
    [RAW_PERSISTENCE_TOKEN]: true as const,
  });
}

/**
 * Persist the client artifact after raw evidence. Success additionally writes the
 * byte-identical result-v1 alias and receipt before the client D1 foreign key.
 */
export async function persistClientResponseArtifact(
  env: StorageGatewayEnvironment,
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
  persistedRaw: PersistedRawProviderEvidence,
  options: ProviderResponseArtifactPersistenceOptions = {},
): Promise<PersistedProviderResponseArtifacts> {
  await requireVerifiedAuthority(authority, verified);
  requirePersistedRawMatches(authority, verified, persistedRaw);
  requireProviderResponsePersistenceEligibility(verified);

  const { admission } = authority;
  const { identity, interpretation, client, raw } = verified.envelope;
  const clientGrant: R2ClientArtifactPutGrant = {
    action: STORAGE_GATEWAY_ACTIONS.R2_CLIENT_ARTIFACT_PUT,
    operation_id: admission.operation_id,
    owner_generation: admission.owner_generation,
    attempt_generation: identity.attempt_generation,
    provider_operation_id: admission.provider_operation_id,
    admission_sha256: admission.admission_sha256,
    egress_profile: identity.egress_profile,
    egress_worker_version_id: identity.egress_worker_version_id,
    client_response_artifact_sha256:
      verified.envelope.client_response_artifact_sha256,
    sha256: client.body_sha256,
    size: client.body_length,
    content_type: client.content_type,
  };

  await emitBoundary(options, "before_client_r2");
  const clientObject = await putR2Object(env, clientGrant, verified.client_body, {
    host: R2_CLIENT_ARTIFACT_HOST,
    path: R2_CLIENT_ARTIFACT_PATH,
    expectedKey: deriveR2ClientArtifactKey(clientGrant),
    conflictCode: "client_response_artifact_conflict",
    invalidCode: "client_response_artifact_readback_invalid",
    unavailableCode: "client_response_artifact_unavailable",
  });
  await emitBoundary(options, "after_client_r2");
  const clientManifest: ClientResponseArtifactManifest = Object.freeze({
    object_key: clientObject.object_key,
    object_version: clientObject.object_version,
    client_response_artifact_sha256:
      verified.envelope.client_response_artifact_sha256,
    sha256: clientObject.sha256,
    size: clientObject.size,
    content_type: "application/json",
  });

  let compatibilityResult: StorageResultRecord | null = null;
  let compatibilityResultReplayed: boolean | null = null;
  let receiptOutcome: ProviderUsageReceiptOutcome | null = null;
  if (interpretation.response_class === "success") {
    const usageReceiptSha256 = requireNonNull(verified.usage_receipt_sha256);
    const compatibilityGrant: R2ResultPutGrant = {
      action: STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT,
      operation_id: admission.operation_id,
      owner_generation: admission.owner_generation,
      provider_operation_id: admission.provider_operation_id,
      admission_sha256: admission.admission_sha256,
      attempt_generation: identity.attempt_generation,
      egress_profile: identity.egress_profile,
      egress_worker_version_id: identity.egress_worker_version_id,
      usage_receipt_sha256: usageReceiptSha256,
      sha256: raw.body_sha256,
      size: raw.body_length,
      content_type: "application/json",
    };
    await emitBoundary(options, "before_compatibility_r2");
    const compatibilityObject = await putR2Object(
      env,
      compatibilityGrant,
      verified.raw_body,
      {
        host: R2_RESULT_HOST,
        path: R2_RESULT_PATH,
        expectedKey: deriveR2ResultKey(compatibilityGrant),
        conflictCode: "provider_response_compatibility_result_conflict",
        invalidCode: "provider_response_compatibility_result_readback_invalid",
        unavailableCode: "provider_response_compatibility_result_unavailable",
      },
    );
    compatibilityResult = Object.freeze({
      object_key: compatibilityObject.object_key,
      object_version: compatibilityObject.object_version,
      sha256: compatibilityObject.sha256,
      size: compatibilityObject.size,
      content_type: compatibilityObject.content_type,
    });
    compatibilityResultReplayed = compatibilityObject.replayed;
    await emitBoundary(options, "after_compatibility_r2");

    const receiptEvidence: CanonicalProviderUsageReceipt = {
      receipt: requireNonNull(verified.usage_receipt),
      json: requireNonNull(verified.usage_receipt_json),
      sha256: usageReceiptSha256,
    };
    await emitBoundary(options, "before_usage_receipt_d1");
    receiptOutcome = await requireD1ProviderUsageReceipt(
      env,
      admission,
      receiptEvidence,
      compatibilityResult,
      raw.completed_at,
    );
    await emitBoundary(options, "after_usage_receipt_d1");
  }

  const receiptSha256 = verified.usage_receipt_sha256;
  const expected = clientExpectedRow(
    verified,
    clientManifest,
    persistedRaw.recorded_at,
    receiptSha256,
  );
  const clientD1Replayed = await persistExactD1Row(
    env,
    CLIENT_INSERT_SQL,
    CLIENT_READBACK_SQL,
    CLIENT_ROW_COLUMNS,
    CLIENT_NUMERIC_COLUMNS,
    CLIENT_NULLABLE_STRING_COLUMNS,
    expected,
    [identity.operation_id, identity.owner_generation, identity.attempt_generation],
    options,
    {
      before: "before_client_d1_insert",
      afterInsert: "after_client_d1_insert",
      afterReadback: "after_client_d1_readback",
      conflictCode: "client_response_artifact_conflict",
      readbackInvalidCode: "client_response_artifact_readback_invalid",
      unavailableCode: "client_response_artifact_unavailable",
    },
  );

  const attachment = responseArtifactAttachment(
    verified,
    persistedRaw.manifest,
    clientManifest,
  );
  return Object.freeze({
    raw: persistedRaw,
    raw_manifest: persistedRaw.manifest,
    client_manifest: clientManifest,
    classification: interpretation.response_class,
    provider_status: interpretation.provider_status,
    client_status: interpretation.client_status,
    status:
      interpretation.response_class === "success"
        ? "succeeded"
        : "interpreted_reject",
    provider_usage_receipt_sha256: receiptSha256,
    compatibility_result: compatibilityResult,
    client_r2_replayed: clientObject.replayed,
    client_d1_replayed: clientD1Replayed,
    compatibility_result_replayed: compatibilityResultReplayed,
    usage_receipt_replayed: receiptOutcome?.replayed ?? null,
    attachment,
  });
}

/** Compose the raw and client gates after a pre-dispatch preflight. */
export async function persistProviderResponseArtifacts(
  env: StorageGatewayEnvironment,
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
  options: ProviderResponseArtifactPersistenceOptions = {},
): Promise<PersistedProviderResponseArtifacts> {
  const raw = await persistRawProviderEvidence(env, authority, verified, options);
  return persistClientResponseArtifact(env, authority, verified, raw, options);
}

interface RecoveredRawFacts {
  readonly manifest: ProviderResponseEvidenceManifest;
  readonly headers: Readonly<Record<string, string>>;
  readonly headers_length: number;
}

async function readRecoveryStateFromSession(
  session: D1ReadSession,
  admission: Readonly<D1AdmissionSnapshot>,
  atomicAdmissionSha256: string,
): Promise<ProviderResponseArtifactRecoveryState> {
  let rawValue: Record<string, unknown> | null;
  let clientValue: Record<string, unknown> | null;
  try {
    rawValue = await session
      .prepare(RAW_READBACK_SQL)
      .bind(admission.operation_id, admission.owner_generation, 1)
      .first<Record<string, unknown>>();
    clientValue = await session
      .prepare(CLIENT_READBACK_SQL)
      .bind(admission.operation_id, admission.owner_generation, 1)
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("provider_response_artifact_recovery_unavailable", 503);
  }

  if (rawValue === null && clientValue === null) {
    return Object.freeze({ kind: "none" });
  }
  if (rawValue === null) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  if (
    !validD1ReadbackRow(
      rawValue,
      RAW_ROW_COLUMNS,
      RAW_NUMERIC_COLUMNS,
      RAW_NULLABLE_STRING_COLUMNS,
    )
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  const raw = rawValue as ExpectedRow;
  if (!recoveredRawAuthorityMatches(raw, admission, atomicAdmissionSha256)) {
    throw new ProtocolError("provider_response_artifact_recovery_conflict", 409);
  }
  const rawFacts = await validateRecoveredRawRow(raw);

  if (clientValue === null) {
    return Object.freeze({
      kind: "raw_only",
      raw_manifest: rawFacts.manifest,
      provider_status: raw.raw_response_status as number,
      provider_response_evidence_sha256:
        raw.provider_response_evidence_sha256 as string,
      recorded_at: raw.recorded_at as number,
    });
  }
  if (
    !validD1ReadbackRow(
      clientValue,
      CLIENT_ROW_COLUMNS,
      CLIENT_NUMERIC_COLUMNS,
      CLIENT_NULLABLE_STRING_COLUMNS,
    )
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  const client = clientValue as ExpectedRow;
  return validateRecoveredCompleteRows(raw, client, rawFacts);
}

function recoveredRawAuthorityMatches(
  row: ExpectedRow,
  admission: Readonly<D1AdmissionSnapshot>,
  atomicAdmissionSha256: string,
): boolean {
  return (
    row.operation_id === admission.operation_id &&
    row.reservation_key === admission.reservation_key &&
    row.owner_generation === admission.owner_generation &&
    row.attempt_generation === 1 &&
    row.provider_operation_id === admission.provider_operation_id &&
    row.atomic_admission_sha256 === atomicAdmissionSha256 &&
    row.admission_sha256 === admission.admission_sha256 &&
    row.request_sha256 === admission.input_sha256 &&
    row.channel_id === admission.channel_id &&
    row.selected_group === admission.selected_group &&
    row.model_name === admission.model_name &&
    row.endpoint_path === admission.endpoint_path &&
    row.egress_profile === PROVIDER_RESPONSE_V3_EGRESS_PROFILE &&
    row.interpreter_source_commit === PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT &&
    row.response_contract === PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT
  );
}

async function validateRecoveredRawRow(row: ExpectedRow): Promise<RecoveredRawFacts> {
  const status = row.raw_response_status as number;
  const contentType = row.raw_response_content_type as string | null;
  const headersJson = row.raw_response_headers_json as string;
  const headersSha256 = row.raw_response_headers_sha256 as string;
  const objectKey = row.raw_response_object_key as string;
  const objectVersion = row.raw_response_object_version as string;
  const bodySha256 = row.raw_response_sha256 as string;
  const bodySize = row.raw_response_size as number;
  const providerRequestId = row.provider_request_id as string | null;
  const completedAt = row.provider_completed_at as number;
  const recordedAt = row.recorded_at as number;
  const evidenceSha256 = row.provider_response_evidence_sha256 as string;
  const headers = await parsePersistedHeaders(
    headersJson,
    headersSha256,
    [
      "content-language",
      "content-type",
      "openai-request-id",
      "request-id",
      "retry-after",
      "x-request-id",
    ],
    6,
  );
  const expectedProviderRequestId = headers["x-request-id"] ??
    headers["openai-request-id"] ?? headers["request-id"] ?? null;
  if (
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599 ||
    (contentType !== null && !validContentType(contentType)) ||
    (contentType === null
      ? headers["content-type"] !== undefined
      : headers["content-type"] !== contentType) ||
    providerRequestId !== expectedProviderRequestId ||
    (providerRequestId !== null && !validEgressIdentifier(providerRequestId)) ||
    !OBJECT_VERSION.test(objectVersion) ||
    !validSha256(bodySha256) ||
    !Number.isSafeInteger(bodySize) ||
    bodySize < 0 ||
    bodySize > MAX_RESPONSE_BODY_BYTES ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < 1 ||
    completedAt > MAX_UNIX_MILLISECONDS ||
    !Number.isSafeInteger(recordedAt) ||
    recordedAt < completedAt ||
    recordedAt > MAX_UNIX_MILLISECONDS ||
    !validSha256(evidenceSha256) ||
    !validEgressIdentifier(row.egress_worker_version_id) ||
    objectKey !==
      `container-provider-evidence/v1/${row.operation_id}/${row.owner_generation}/${row.attempt_generation}/${bodySha256}`
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  return {
    manifest: Object.freeze({
      object_key: objectKey,
      object_version: objectVersion,
      provider_response_evidence_sha256: evidenceSha256,
      sha256: bodySha256,
      size: bodySize,
      content_type: contentType ?? RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK,
    }),
    headers: Object.freeze(headers),
    headers_length: new TextEncoder().encode(headersJson).byteLength,
  };
}

async function validateRecoveredCompleteRows(
  raw: ExpectedRow,
  client: ExpectedRow,
  rawFacts: RecoveredRawFacts,
): Promise<ProviderResponseArtifactRecoveryState> {
  if (
    client.operation_id !== raw.operation_id ||
    client.owner_generation !== raw.owner_generation ||
    client.attempt_generation !== raw.attempt_generation ||
    client.provider_response_evidence_sha256 !==
      raw.provider_response_evidence_sha256 ||
    client.response_contract !== raw.response_contract
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_conflict", 409);
  }
  const responseClass = client.response_class;
  if (!isProviderResponseClass(responseClass)) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  const providerStatus = raw.raw_response_status as number;
  const clientStatus = client.client_response_status as number;
  const receiptSha256 = client.provider_usage_receipt_sha256 as string | null;
  if (!recoveredClassificationMatches(
    responseClass,
    providerStatus,
    clientStatus,
    receiptSha256,
  )) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }

  const clientContentType = client.client_response_content_type as string;
  const clientHeadersJson = client.client_response_headers_json as string;
  const clientHeaders = await parsePersistedHeaders(
    clientHeadersJson,
    client.client_response_headers_sha256 as string,
    [
      "cache-control",
      "content-language",
      "content-type",
      "openai-request-id",
      "request-id",
      "retry-after",
      "x-request-id",
    ],
    7,
  );
  const expectedClientHeaders: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json",
  };
  if (responseClass === "success") {
    for (const [name, value] of Object.entries(rawFacts.headers)) {
      if (name !== "content-type") expectedClientHeaders[name] = value;
    }
  }
  const canonicalExpectedHeaders = JSON.stringify(
    Object.fromEntries(
      Object.entries(expectedClientHeaders).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
  const objectKey = client.client_response_object_key as string;
  const objectVersion = client.client_response_object_version as string;
  const bodySha256 = client.client_response_sha256 as string;
  const bodySize = client.client_response_size as number;
  const artifactSha256 = client.client_response_artifact_sha256 as string;
  const createdAt = client.created_at as number;
  if (
    clientContentType !== "application/json" ||
    clientHeaders["cache-control"] !== "no-store" ||
    clientHeaders["content-type"] !== "application/json" ||
    clientHeadersJson !== canonicalExpectedHeaders ||
    !OBJECT_VERSION.test(objectVersion) ||
    !validSha256(bodySha256) ||
    !Number.isSafeInteger(bodySize) ||
    bodySize < 2 ||
    bodySize > MAX_RESPONSE_BODY_BYTES ||
    !validSha256(artifactSha256) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < (raw.recorded_at as number) ||
    createdAt > MAX_UNIX_MILLISECONDS ||
    objectKey !==
      `container-client-artifacts/v1/${client.operation_id}/${client.owner_generation}/${artifactSha256}`
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }

  const interpretation = {
    contract: PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
    source_commit: PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
    response_class: responseClass,
    provider_status: providerStatus,
    client_status: clientStatus,
    audit_status: recoveredAuditStatus(responseClass, providerStatus),
  } as const;
  const identity = {
    operation_id: raw.operation_id as string,
    owner_generation: raw.owner_generation as number,
    attempt_generation: raw.attempt_generation as number,
    provider_operation_id: raw.provider_operation_id as string,
    request_sha256: raw.request_sha256 as string,
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: raw.egress_worker_version_id as string,
  } as const;
  const providerAttestation = await sha256Hex(new TextEncoder().encode(JSON.stringify({
    contract: "cinatoken-provider-evidence-attestation-v1",
    identity,
    interpretation,
    raw: {
      content_type: raw.raw_response_content_type,
      headers_length: rawFacts.headers_length,
      headers_sha256: raw.raw_response_headers_sha256,
      body_length: raw.raw_response_size,
      body_sha256: raw.raw_response_sha256,
      provider_request_id: raw.provider_request_id,
      completed_at: raw.provider_completed_at,
    },
  })));
  const bodySameAsRaw = bodySize === raw.raw_response_size &&
    bodySha256 === raw.raw_response_sha256;
  const clientHeadersLength = new TextEncoder().encode(clientHeadersJson).byteLength;
  const clientAttestation = await sha256Hex(new TextEncoder().encode(JSON.stringify({
    contract: "cinatoken-client-response-attestation-v1",
    identity,
    provider_response_evidence_sha256: raw.provider_response_evidence_sha256,
    interpretation,
    client: {
      content_type: "application/json",
      headers_length: clientHeadersLength,
      headers_sha256: client.client_response_headers_sha256,
      body_length: bodySize,
      body_sha256: bodySha256,
      body_same_as_raw: bodySameAsRaw,
    },
    usage_receipt_sha256: receiptSha256,
  })));
  if (
    providerAttestation !== raw.provider_response_evidence_sha256 ||
    clientAttestation !== artifactSha256
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }

  const clientManifest: ClientResponseArtifactManifest = Object.freeze({
    object_key: objectKey,
    object_version: objectVersion,
    client_response_artifact_sha256: artifactSha256,
    sha256: bodySha256,
    size: bodySize,
    content_type: "application/json",
  });
  const attachment = canonicalResponseArtifactAttachment(
    responseClass,
    providerStatus,
    clientStatus,
    rawFacts.manifest,
    clientManifest,
    receiptSha256,
  );
  return Object.freeze({
    kind: "complete",
    raw_manifest: rawFacts.manifest,
    client_manifest: clientManifest,
    classification: responseClass,
    provider_status: providerStatus,
    client_status: clientStatus,
    status: responseClass === "success" ? "succeeded" : "interpreted_reject",
    provider_usage_receipt_sha256: receiptSha256,
    attachment,
  });
}

async function parsePersistedHeaders(
  json: string,
  expectedSha256: string,
  allowedNames: readonly string[],
  maximumCount: number,
): Promise<Record<string, string>> {
  const bytes = new TextEncoder().encode(json);
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > 8_192 ||
    !isRecord(value) ||
    Object.keys(value).length > maximumCount ||
    JSON.stringify(value) !== json ||
    (await sha256Hex(bytes)) !== expectedSha256
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  const keys = Object.keys(value);
  if (
    !keys.every((key) => allowedNames.includes(key)) ||
    !keys.every((key, index) => index === 0 || keys[index - 1]! < key) ||
    keys.some((key) => {
      const header = value[key];
      return typeof header !== "string" ||
        header.length < 1 ||
        header.length > 1_024 ||
        !/^[ -~]+$/.test(header) ||
        (key === "content-type" && !validContentType(header)) ||
        ((key === "x-request-id" ||
          key === "openai-request-id" ||
          key === "request-id") &&
          !validEgressIdentifier(header));
    })
  ) {
    throw new ProtocolError("provider_response_artifact_recovery_readback_invalid", 502);
  }
  return value as Record<string, string>;
}

function recoveredClassificationMatches(
  responseClass: ProviderResponseClassV3,
  providerStatus: number,
  clientStatus: number,
  receiptSha256: string | null,
): boolean {
  switch (responseClass) {
    case "success":
      return providerStatus === 200 && clientStatus === 200 && validSha256(receiptSha256);
    case "typed_error":
      return providerStatus === 200 && clientStatus === 200 && receiptSha256 === null;
    case "http_error":
      return providerStatus !== 200 && clientStatus === providerStatus && receiptSha256 === null;
    case "invalid_body":
      return providerStatus === 200 && clientStatus === 500 && receiptSha256 === null;
  }
}

function recoveredAuditStatus(
  responseClass: ProviderResponseClassV3,
  providerStatus: number,
): number {
  if (responseClass === "success") return 200;
  if (responseClass === "http_error" && providerStatus >= 400) return providerStatus;
  return 500;
}

function isProviderResponseClass(value: unknown): value is ProviderResponseClassV3 {
  return value === "success" || value === "typed_error" ||
    value === "http_error" || value === "invalid_body";
}

function validResponseArtifactSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const expected: Record<string, number> = {
    raw_table_count: 1,
    raw_column_count: 28,
    raw_required_column_count: 28,
    raw_identity_table_count: 1,
    raw_identity_column_count: 7,
    raw_identity_required_column_count: 7,
    client_table_count: 1,
    client_column_count: 17,
    client_required_column_count: 17,
    client_identity_table_count: 1,
    client_identity_column_count: 7,
    client_identity_required_column_count: 7,
    operation_contract_column_count: 1,
    terminal_artifact_column_count: 1,
    atomic_identity_column_count: 6,
    receipt_identity_column_count: 4,
    required_index_count: 5,
    atomic_identity_index_column_count: 6,
    receipt_identity_index_column_count: 4,
    raw_recorded_index_column_count: 3,
    client_created_index_column_count: 3,
    terminal_artifact_index_column_count: 1,
    required_trigger_count: 20,
    raw_foreign_key_column_count: 9,
    client_foreign_key_column_count: 8,
  };
  return exactKeys(value, Object.keys(expected)) &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function validAdmissionForResponseArtifacts(value: D1AdmissionSnapshot): boolean {
  return (
    isRecord(value) &&
    value.operation_id === value.reservation_key &&
    value.operation_reservation_key === value.reservation_key &&
    value.owner_generation === 2 &&
    value.reservation_owner_generation === 2 &&
    value.reservation_status === "reserved" &&
    (value.operation_status === "prepared" || value.operation_status === "dispatched") &&
    value.protocol_version === 1 &&
    value.operation_kind === "chat_completions_canary" &&
    validIdentifier(value.operation_id) &&
    validIdentifier(value.provider_operation_id) &&
    validSha256(value.admission_sha256) &&
    validSha256(value.input_sha256) &&
    Number.isSafeInteger(value.channel_id) &&
    value.channel_id > 0 &&
    value.channel_id === value.reservation_channel_id &&
    value.selected_group === value.reservation_selected_group &&
    typeof value.model_name === "string" &&
    value.model_name.length >= 1 &&
    typeof value.endpoint_path === "string" &&
    value.endpoint_path.length >= 1
  );
}

function isAtomicAdmissionAuthorityRow(
  value: Record<string, unknown>,
): value is Record<string, unknown> & AtomicAdmissionAuthorityRow {
  return (
    exactKeys(value, [
      "reservation_key",
      "operation_id",
      "owner_generation",
      "provider_attempt_generation",
      "atomic_admission_sha256",
      "operation_admission_sha256",
      "response_artifact_contract",
    ]) &&
    typeof value.reservation_key === "string" &&
    typeof value.operation_id === "string" &&
    typeof value.owner_generation === "number" &&
    typeof value.provider_attempt_generation === "number" &&
    typeof value.atomic_admission_sha256 === "string" &&
    validSha256(value.atomic_admission_sha256) &&
    typeof value.operation_admission_sha256 === "string" &&
    validSha256(value.operation_admission_sha256) &&
    typeof value.response_artifact_contract === "string"
  );
}

function atomicAdmissionAuthorityMatches(
  row: AtomicAdmissionAuthorityRow,
  admission: D1AdmissionSnapshot,
): boolean {
  return (
    row.reservation_key === admission.reservation_key &&
    row.operation_id === admission.operation_id &&
    row.owner_generation === admission.owner_generation &&
    row.provider_attempt_generation === 1 &&
    row.operation_admission_sha256 === admission.admission_sha256 &&
    row.response_artifact_contract === PROVIDER_RESPONSE_ARTIFACT_CONTRACT
  );
}

async function requireVerifiedAuthority(
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
): Promise<void> {
  requireStoreAuthority(authority);
  if (
    !isRecord(verified) ||
    !isRecord(verified.envelope)
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
  const { admission } = authority;
  const { identity, interpretation, raw, client } = verified.envelope;
  if (
    identity.operation_id !== admission.operation_id ||
    identity.owner_generation !== admission.owner_generation ||
    identity.attempt_generation !== 1 ||
    identity.provider_operation_id !== admission.provider_operation_id ||
    identity.request_sha256 !== admission.input_sha256 ||
    identity.egress_profile !== PROVIDER_RESPONSE_V3_EGRESS_PROFILE ||
    interpretation.contract !== PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT ||
    interpretation.source_commit !== PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT ||
    verified.raw_body.byteLength !== raw.body_length ||
    verified.client_body.byteLength !== client.body_length ||
    raw.body_length < 0 ||
    raw.body_length > MAX_RESPONSE_BODY_BYTES ||
    client.body_length < 2 ||
    client.body_length > MAX_RESPONSE_BODY_BYTES ||
    !validSha256(raw.body_sha256) ||
    !validSha256(client.body_sha256) ||
    !validSha256(verified.envelope.provider_response_evidence_sha256) ||
    !validSha256(verified.envelope.client_response_artifact_sha256) ||
    !Number.isSafeInteger(raw.completed_at) ||
    raw.completed_at < 1 ||
    raw.completed_at > MAX_UNIX_MILLISECONDS ||
    (raw.content_type !== null && !validContentType(raw.content_type)) ||
    client.content_type !== "application/json" ||
    (await sha256Hex(verified.raw_body)) !== raw.body_sha256 ||
    (await sha256Hex(verified.client_body)) !== client.body_sha256
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
  const rawHeaders = new TextEncoder().encode(raw.headers_json);
  const clientHeaders = new TextEncoder().encode(client.headers_json);
  if (
    rawHeaders.byteLength !== raw.headers_length ||
    clientHeaders.byteLength !== client.headers_length ||
    (await sha256Hex(rawHeaders)) !== raw.headers_sha256 ||
    (await sha256Hex(clientHeaders)) !== client.headers_sha256
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
}

function requireStoreAuthority(authority: ProviderResponseArtifactAuthority): void {
  if (
    !isRecord(authority) ||
    authority[AUTHORITY_TOKEN] !== true ||
    authority.response_artifact_contract !== PROVIDER_RESPONSE_ARTIFACT_CONTRACT ||
    !validSha256(authority.atomic_admission_sha256) ||
    !validAdmissionForResponseArtifacts(authority.admission)
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
}

function requireProviderResponsePersistenceEligibility(
  verified: VerifiedProviderResponseV3,
): void {
  const { interpretation, client, raw } = verified.envelope;
  if (interpretation.response_class !== "success") {
    if (
      verified.usage_receipt !== null ||
      verified.usage_receipt_json !== null ||
      verified.usage_receipt_sha256 !== null
    ) {
      throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
    }
    return;
  }
  if (
    verified.usage_receipt === null ||
    verified.usage_receipt_json === null ||
    verified.usage_receipt_sha256 === null
  ) {
    throw new ProtocolError("provider_response_success_receipt_required", 409);
  }
  if (
    !client.body_same_as_raw ||
    raw.body_length !== client.body_length ||
    raw.body_sha256 !== client.body_sha256 ||
    !bytesEqual(verified.raw_body, verified.client_body)
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
}

function requirePersistedRawMatches(
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
  persisted: PersistedRawProviderEvidence,
): void {
  const { identity, raw } = verified.envelope;
  const manifest = persisted.manifest;
  const expectedContentType =
    raw.content_type ?? RESPONSE_ARTIFACT_STORAGE_CONTENT_TYPE_FALLBACK;
  if (
    !isRecord(persisted) ||
    persisted[RAW_PERSISTENCE_TOKEN] !== true ||
    persisted.recorded_at !== raw.completed_at ||
    manifest.object_key !==
      `container-provider-evidence/v1/${identity.operation_id}/${identity.owner_generation}/${identity.attempt_generation}/${raw.body_sha256}` ||
    manifest.provider_response_evidence_sha256 !==
      verified.envelope.provider_response_evidence_sha256 ||
    manifest.sha256 !== raw.body_sha256 ||
    manifest.size !== raw.body_length ||
    manifest.content_type !== expectedContentType ||
    authority.admission.operation_id !== identity.operation_id
  ) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
}

function rawExpectedRow(
  authority: ProviderResponseArtifactAuthority,
  verified: VerifiedProviderResponseV3,
  manifest: ProviderResponseEvidenceManifest,
): ExpectedRow {
  const { admission } = authority;
  const { identity, interpretation, raw } = verified.envelope;
  return {
    operation_id: admission.operation_id,
    reservation_key: admission.reservation_key,
    owner_generation: admission.owner_generation,
    attempt_generation: identity.attempt_generation,
    provider_operation_id: admission.provider_operation_id,
    atomic_admission_sha256: authority.atomic_admission_sha256,
    admission_sha256: admission.admission_sha256,
    request_sha256: identity.request_sha256,
    channel_id: admission.channel_id,
    selected_group: admission.selected_group,
    model_name: admission.model_name,
    endpoint_path: admission.endpoint_path,
    egress_profile: identity.egress_profile,
    egress_worker_version_id: identity.egress_worker_version_id,
    raw_response_status: interpretation.provider_status,
    raw_response_content_type: raw.content_type,
    raw_response_headers_json: raw.headers_json,
    raw_response_headers_sha256: raw.headers_sha256,
    raw_response_object_key: manifest.object_key,
    raw_response_object_version: manifest.object_version,
    raw_response_sha256: raw.body_sha256,
    raw_response_size: raw.body_length,
    provider_request_id: raw.provider_request_id,
    provider_completed_at: raw.completed_at,
    interpreter_source_commit: interpretation.source_commit,
    response_contract: interpretation.contract,
    provider_response_evidence_sha256:
      verified.envelope.provider_response_evidence_sha256,
    recorded_at: raw.completed_at,
  };
}

function clientExpectedRow(
  verified: VerifiedProviderResponseV3,
  manifest: ClientResponseArtifactManifest,
  createdAt: number,
  usageReceiptSha256: string | null,
): ExpectedRow {
  const { identity, interpretation, client } = verified.envelope;
  return {
    operation_id: identity.operation_id,
    owner_generation: identity.owner_generation,
    attempt_generation: identity.attempt_generation,
    provider_response_evidence_sha256:
      verified.envelope.provider_response_evidence_sha256,
    response_contract: interpretation.contract,
    response_class: interpretation.response_class,
    client_response_status: interpretation.client_status,
    client_response_content_type: client.content_type,
    client_response_headers_json: client.headers_json,
    client_response_headers_sha256: client.headers_sha256,
    client_response_object_key: manifest.object_key,
    client_response_object_version: manifest.object_version,
    client_response_sha256: client.body_sha256,
    client_response_size: client.body_length,
    provider_usage_receipt_sha256: usageReceiptSha256,
    client_response_artifact_sha256:
      verified.envelope.client_response_artifact_sha256,
    created_at: createdAt,
  };
}

async function persistExactD1Row(
  env: StorageGatewayEnvironment,
  insertSql: string,
  readbackSql: string,
  columns: readonly string[],
  numericColumns: ReadonlySet<string>,
  nullableStringColumns: ReadonlySet<string>,
  expected: ExpectedRow,
  identityBindings: readonly [string, number, number],
  options: ProviderResponseArtifactPersistenceOptions,
  errors: {
    before: ProviderResponseArtifactPersistenceBoundary;
    afterInsert: ProviderResponseArtifactPersistenceBoundary;
    afterReadback: ProviderResponseArtifactPersistenceBoundary;
    conflictCode: string;
    readbackInvalidCode: string;
    unavailableCode: string;
  },
): Promise<boolean> {
  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ProtocolError(errors.unavailableCode, 503);
  }
  let session: ReturnType<NonNullable<typeof database.withSession>>;
  try {
    session = database.withSession("first-primary");
  } catch {
    throw new ProtocolError(errors.unavailableCode, 503);
  }

  await emitBoundary(options, errors.before);
  let changes: number;
  try {
    const write = await session
      .prepare(insertSql)
      .bind(...columns.map((column) => expected[column] ?? null))
      .run();
    const value = write?.meta?.changes;
    if (write?.success !== true || (value !== 0 && value !== 1)) {
      throw new ProtocolError(errors.readbackInvalidCode, 502);
    }
    changes = value;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(errors.unavailableCode, 503);
  }
  await emitBoundary(options, errors.afterInsert);

  let row: Record<string, unknown> | null;
  try {
    row = await session
      .prepare(readbackSql)
      .bind(...identityBindings)
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError(errors.unavailableCode, 503);
  }
  if (row === null) {
    throw new ProtocolError(
      changes === 0 ? errors.conflictCode : errors.readbackInvalidCode,
      changes === 0 ? 409 : 502,
    );
  }
  if (!validD1ReadbackRow(row, columns, numericColumns, nullableStringColumns)) {
    throw new ProtocolError(errors.readbackInvalidCode, 502);
  }
  if (!columns.every((column) => Object.is(row[column], expected[column]))) {
    throw new ProtocolError(errors.conflictCode, 409);
  }
  await emitBoundary(options, errors.afterReadback);
  return changes === 0;
}

async function putR2Object(
  env: StorageGatewayEnvironment,
  grant: ResponseArtifactGrant,
  body: Uint8Array,
  target: {
    host: string;
    path: string;
    expectedKey: string;
    conflictCode: string;
    invalidCode: string;
    unavailableCode: string;
  },
): Promise<R2WriteRecord> {
  let response: Response;
  try {
    response = await handleStorageGatewayRequest(
      env,
      new Request(`http://${target.host}${target.path}`, {
        method: "PUT",
        headers: {
          "content-length": String(grant.size),
          "content-type": grant.content_type,
          [CONTENT_SHA256_HEADER]: grant.sha256,
        },
        body: body.byteLength === 0 ? undefined : body,
      }),
      grant,
    );
  } catch {
    throw new ProtocolError(target.unavailableCode, 503);
  }
  if (!response.ok) {
    const status = response.status;
    await cancelResponse(response);
    if (status === 409) throw new ProtocolError(target.conflictCode, 409);
    if (status === 502) throw new ProtocolError(target.invalidCode, 502);
    throw new ProtocolError(target.unavailableCode, status === 503 ? 503 : 502);
  }

  const objectVersion = response.headers.get(R2_OBJECT_VERSION_HEADER);
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, MAX_GATEWAY_RESPONSE_BYTES);
  } catch {
    throw new ProtocolError(target.invalidCode, 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new ProtocolError(target.invalidCode, 502);
  }
  if (
    (response.status !== 201 && response.status !== 200) ||
    objectVersion === null ||
    !OBJECT_VERSION.test(objectVersion) ||
    !isRecord(value) ||
    !exactKeys(value, ["key", "sha256", "size", "replayed"]) ||
    value.key !== target.expectedKey ||
    value.sha256 !== grant.sha256 ||
    value.size !== grant.size ||
    typeof value.replayed !== "boolean" ||
    (response.status === 201) !== (value.replayed === false) ||
    (response.status === 200) !== value.replayed
  ) {
    throw new ProtocolError(target.invalidCode, 502);
  }
  return {
    object_key: target.expectedKey,
    object_version: objectVersion,
    sha256: grant.sha256,
    size: grant.size,
    content_type: grant.content_type,
    replayed: value.replayed,
  };
}

function responseArtifactAttachment(
  verified: VerifiedProviderResponseV3,
  rawManifest: ProviderResponseEvidenceManifest,
  clientManifest: ClientResponseArtifactManifest,
): ProviderResponseArtifactAttachment {
  const interpretation = verified.envelope.interpretation;
  return canonicalResponseArtifactAttachment(
    interpretation.response_class,
    interpretation.provider_status,
    interpretation.client_status,
    rawManifest,
    clientManifest,
    verified.usage_receipt_sha256,
  );
}

function canonicalResponseArtifactAttachment(
  responseClass: ProviderResponseClassV3,
  providerStatus: number,
  clientStatus: number,
  rawManifest: ProviderResponseEvidenceManifest,
  clientManifest: ClientResponseArtifactManifest,
  usageReceiptSha256: string | null,
): ProviderResponseArtifactAttachment {
  if (responseClass === "success") {
    return Object.freeze({
      status: "succeeded",
      provider_status: 200,
      client_status: 200,
      response_class: "success",
      response_code: null,
      raw_manifest: rawManifest,
      client_manifest: clientManifest,
      provider_usage_receipt_sha256: usageReceiptSha256,
    });
  }
  return Object.freeze({
    status: "interpreted_reject",
    provider_status: providerStatus,
    client_status: clientStatus,
    response_class: responseClass,
    response_code: responseCodeFor(responseClass),
    raw_manifest: rawManifest,
    client_manifest: clientManifest,
    provider_usage_receipt_sha256: null,
  });
}

function responseCodeFor(
  responseClass: Exclude<ProviderResponseClassV3, "success">,
): string {
  switch (responseClass) {
    case "typed_error":
      return "provider_typed_error";
    case "http_error":
      return "provider_http_error";
    case "invalid_body":
      return "provider_invalid_body";
  }
}

function validD1ReadbackRow(
  value: Record<string, unknown>,
  columns: readonly string[],
  numericColumns: ReadonlySet<string>,
  nullableStringColumns: ReadonlySet<string>,
): boolean {
  if (!exactKeys(value, columns)) return false;
  return columns.every((column) => {
    const field = value[column];
    if (numericColumns.has(column)) return typeof field === "number" && Number.isSafeInteger(field);
    if (nullableStringColumns.has(column)) return field === null || typeof field === "string";
    return typeof field === "string";
  });
}

async function emitBoundary(
  options: ProviderResponseArtifactPersistenceOptions,
  boundary: ProviderResponseArtifactPersistenceBoundary,
): Promise<void> {
  await options.onBoundary?.(boundary);
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("response_artifact_gateway_response_too_large");
        throw new Error("response artifact gateway response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel("response_artifact_gateway_rejected");
  } catch {
    // Best-effort cleanup after a stable persistence error has already been chosen.
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function requireNonNull<T>(value: T | null): T {
  if (value === null) {
    throw new ProtocolError("provider_response_artifact_authority_mismatch", 409);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string | symbol, unknown> & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function validEgressIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/@-]{1,128}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validContentType(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && CONTENT_TYPE.test(value);
}
