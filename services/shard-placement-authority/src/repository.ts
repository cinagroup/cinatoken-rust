import type {
  RevocationRequest,
  VerifiedApproval,
  VerifiedIssuance,
} from "./protocol";

const ISSUANCE_COLUMNS = [
  "authorization_id_sha256",
  "execution_nonce_sha256",
  "campaign_id",
  "campaign_nonce_sha256",
  "permit_subject_digest_sha256",
  "issuance_request_sha256",
  "approvals_digest_sha256",
  "policy_id",
  "policy_sha256",
  "permit_issuer",
  "permit_key_id",
  "permit_signer_spki_sha256",
  "environment",
  "controller_service_name",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "campaign_lifetime_seconds",
  "permit_issued_at",
  "permit_expires_at",
  "security_key_id",
  "security_spki_sha256",
  "security_signed_at",
  "security_expires_at",
  "operations_key_id",
  "operations_spki_sha256",
  "operations_signed_at",
  "operations_expires_at",
  "release_key_id",
  "release_spki_sha256",
  "release_signed_at",
  "release_expires_at",
  "rollback_key_id",
  "rollback_spki_sha256",
  "rollback_signed_at",
  "rollback_expires_at",
  "issue_credential_id_sha256",
  "authority_version_id",
  "recorded_at",
] as const;
const REVOCATION_COLUMNS = [
  "authorization_id_sha256",
  "permit_subject_digest_sha256",
  "reason_code",
  "evidence_sha256",
  "revocation_event_sha256",
  "revoke_credential_id_sha256",
  "recorded_at",
] as const;
const EXPECTED_SCHEMA_OBJECTS = [
  "index:idx_shard_placement_authority_issuance_subject",
  "index:idx_shard_placement_authority_issuances_candidate",
  "index:idx_shard_placement_authority_revocations_recorded",
  "table:shard_placement_authority_issuances",
  "table:shard_placement_authority_revocations",
  "trigger:shard_placement_authority_execution_revocation_apply",
  "trigger:shard_placement_authority_issuance_delete_guard",
  "trigger:shard_placement_authority_issuance_insert_guard",
  "trigger:shard_placement_authority_issuance_update_guard",
  "trigger:shard_placement_authority_revocation_delete_guard",
  "trigger:shard_placement_authority_revocation_insert_guard",
  "trigger:shard_placement_authority_revocation_update_guard",
].join("|");

const SCHEMA_PROBE_SQL = `
SELECT
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info('shard_placement_authority_issuances')
      ORDER BY cid
    )
  ) AS issuance_columns,
  (
    SELECT group_concat(name, ',')
    FROM (
      SELECT name
      FROM pragma_table_info('shard_placement_authority_revocations')
      ORDER BY cid
    )
  ) AS revocation_columns,
  (
    SELECT group_concat(type || ':' || name, '|')
    FROM (
      SELECT type, name
      FROM sqlite_master
      WHERE tbl_name IN (
        'shard_placement_authority_issuances',
        'shard_placement_authority_revocations'
      )
        AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type || ':' || name
    )
  ) AS schema_objects
`.trim();

const INSERT_ISSUANCE_SQL = `
INSERT INTO shard_placement_authority_issuances (
  authorization_id_sha256, execution_nonce_sha256, campaign_id,
  campaign_nonce_sha256, permit_subject_digest_sha256,
  issuance_request_sha256, approvals_digest_sha256, policy_id,
  policy_sha256, permit_issuer, permit_key_id,
  permit_signer_spki_sha256, environment, controller_service_name,
  controller_version_id, action_gate_inventory_sha256,
  foundation_manifest_sha256, runtime_build_id, ring_generation,
  shard_count, campaign_lifetime_seconds, permit_issued_at,
  permit_expires_at, security_key_id, security_spki_sha256,
  security_signed_at, security_expires_at, operations_key_id,
  operations_spki_sha256, operations_signed_at, operations_expires_at,
  release_key_id, release_spki_sha256, release_signed_at,
  release_expires_at, rollback_key_id, rollback_spki_sha256,
  rollback_signed_at, rollback_expires_at, issue_credential_id_sha256,
  authority_version_id
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
  ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27,
  ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40,
  ?41
)
ON CONFLICT(authorization_id_sha256) DO NOTHING
`.trim();

const READ_ISSUANCE_SQL = `
SELECT
  issuance.*,
  revocation.reason_code AS revocation_reason_code,
  revocation.evidence_sha256 AS revocation_evidence_sha256,
  revocation.revocation_event_sha256,
  revocation.revoke_credential_id_sha256,
  revocation.recorded_at AS revoked_at,
  unixepoch() AS database_now
FROM shard_placement_authority_issuances AS issuance
LEFT JOIN shard_placement_authority_revocations AS revocation
  ON revocation.authorization_id_sha256 =
       issuance.authorization_id_sha256
WHERE issuance.authorization_id_sha256 = ?1
  AND issuance.permit_subject_digest_sha256 = ?2
  AND issuance.campaign_id = ?3
LIMIT 1
`.trim();

const INSERT_REVOCATION_SQL = `
INSERT INTO shard_placement_authority_revocations (
  authorization_id_sha256, permit_subject_digest_sha256, reason_code,
  evidence_sha256, revocation_event_sha256, revoke_credential_id_sha256
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
FROM shard_placement_authority_issuances AS issuance
WHERE issuance.authorization_id_sha256 = ?1
  AND issuance.permit_subject_digest_sha256 = ?2
ON CONFLICT(authorization_id_sha256) DO NOTHING
`.trim();

const READ_REVOCATION_SQL = `
SELECT authorization_id_sha256, permit_subject_digest_sha256, reason_code,
       evidence_sha256, revocation_event_sha256,
       revoke_credential_id_sha256, recorded_at
FROM shard_placement_authority_revocations
WHERE authorization_id_sha256 = ?1
LIMIT 1
`.trim();

interface SchemaProbeRow {
  issuance_columns: string;
  revocation_columns: string;
  schema_objects: string;
}

export interface IssuanceRow {
  authorization_id_sha256: string;
  execution_nonce_sha256: string;
  campaign_id: string;
  campaign_nonce_sha256: string;
  permit_subject_digest_sha256: string;
  issuance_request_sha256: string;
  approvals_digest_sha256: string;
  policy_id: string;
  policy_sha256: string;
  permit_issuer: string;
  permit_key_id: string;
  permit_signer_spki_sha256: string;
  environment: string;
  controller_service_name: string;
  controller_version_id: string;
  action_gate_inventory_sha256: string;
  foundation_manifest_sha256: string;
  runtime_build_id: string;
  ring_generation: number;
  shard_count: number;
  campaign_lifetime_seconds: number;
  permit_issued_at: number;
  permit_expires_at: number;
  security_key_id: string;
  security_spki_sha256: string;
  security_signed_at: number;
  security_expires_at: number;
  operations_key_id: string;
  operations_spki_sha256: string;
  operations_signed_at: number;
  operations_expires_at: number;
  release_key_id: string;
  release_spki_sha256: string;
  release_signed_at: number;
  release_expires_at: number;
  rollback_key_id: string;
  rollback_spki_sha256: string;
  rollback_signed_at: number;
  rollback_expires_at: number;
  issue_credential_id_sha256: string;
  authority_version_id: string;
  recorded_at: number;
  revocation_reason_code: string | null;
  revocation_evidence_sha256: string | null;
  revocation_event_sha256: string | null;
  revoke_credential_id_sha256: string | null;
  revoked_at: number | null;
  database_now: number;
}

export interface RevocationRow {
  authorization_id_sha256: string;
  permit_subject_digest_sha256: string;
  reason_code: string;
  evidence_sha256: string;
  revocation_event_sha256: string;
  revoke_credential_id_sha256: string;
  recorded_at: number;
}

export class RepositoryConflictError extends Error {
  constructor(readonly code = "authorization_conflict") {
    super(code);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor() {
    super("authorization_not_found");
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryUnavailableError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super("repository_unavailable");
    this.name = "RepositoryUnavailableError";
  }
}

export async function createIssuance(
  database: D1Database,
  issuance: VerifiedIssuance,
  issueCredentialIdSha256: string,
  authorityVersionId: string,
): Promise<{
  classification: "created" | "exact_replay";
  issuance: IssuanceRow;
}> {
  const approvals = approvalMap(issuance.approvals);
  const session = database.withSession("first-primary");
  await requireSchema(session);
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_ISSUANCE_SQL)
      .bind(
        issuance.permit.authorization_id_sha256,
        issuance.permit.execution_nonce_sha256,
        issuance.permit.campaign_id,
        issuance.permit.campaign_nonce_sha256,
        issuance.permitSubjectDigestSha256,
        issuance.issuanceRequestSha256,
        issuance.approvalsDigestSha256,
        issuance.policyId,
        issuance.policySha256,
        issuance.permit.issuer,
        issuance.permit.key_id,
        issuance.permitSignerSpkiSha256,
        issuance.permit.environment,
        issuance.permit.controller_service_name,
        issuance.permit.controller_version_id,
        issuance.permit.action_gate_inventory_sha256,
        issuance.permit.foundation_manifest_sha256,
        issuance.permit.runtime_build_id,
        issuance.permit.ring_generation,
        issuance.permit.shard_count,
        issuance.permit.campaign_lifetime_seconds,
        issuance.permit.issued_at,
        issuance.permit.expires_at,
        approvals.security.keyId,
        approvals.security.spkiSha256,
        approvals.security.signedAt,
        approvals.security.expiresAt,
        approvals.operations.keyId,
        approvals.operations.spkiSha256,
        approvals.operations.signedAt,
        approvals.operations.expiresAt,
        approvals.release.keyId,
        approvals.release.spkiSha256,
        approvals.release.signedAt,
        approvals.release.expiresAt,
        approvals.rollback.keyId,
        approvals.rollback.spkiSha256,
        approvals.rollback.signedAt,
        approvals.rollback.expiresAt,
        issueCredentialIdSha256,
        authorityVersionId,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }
  let row: IssuanceRow | null;
  try {
    row = await readIssuanceFromSession(
      session,
      issuance.permit.authorization_id_sha256,
      issuance.permitSubjectDigestSha256,
      issuance.permit.campaign_id,
    );
  } catch {
    throw new RepositoryUnavailableError(writeSucceeded);
  }
  if (
    row === null
    || !matchesIssuance(
      row,
      issuance,
      issueCredentialIdSha256,
      authorityVersionId,
    )
  ) {
    throw new RepositoryConflictError();
  }
  return {
    classification: writeSucceeded ? "created" : "exact_replay",
    issuance: row,
  };
}

export async function readExactIssuance(
  database: D1Database,
  authorizationIdSha256: string,
  permitSubjectDigestSha256: string,
  campaignId: string,
): Promise<IssuanceRow> {
  const session = database.withSession("first-primary");
  await requireSchema(session);
  try {
    const row = await readIssuanceFromSession(
      session,
      authorizationIdSha256,
      permitSubjectDigestSha256,
      campaignId,
    );
    if (row === null) throw new RepositoryNotFoundError();
    return row;
  } catch (error) {
    if (error instanceof RepositoryNotFoundError) throw error;
    throw new RepositoryUnavailableError(false);
  }
}

export async function revokeIssuance(
  database: D1Database,
  revocation: RevocationRequest,
  revokeCredentialIdSha256: string,
): Promise<{
  classification: "revoked" | "exact_replay";
  revocation: RevocationRow;
}> {
  const session = database.withSession("first-primary");
  await requireSchema(session);
  let writeSucceeded = false;
  try {
    const result = await session
      .prepare(INSERT_REVOCATION_SQL)
      .bind(
        revocation.authorizationIdSha256,
        revocation.permitSubjectDigestSha256,
        revocation.reasonCode,
        revocation.evidenceSha256,
        revocation.revocationEventSha256,
        revokeCredentialIdSha256,
      )
      .run();
    writeSucceeded =
      result.success === true
      && (result.meta?.changes ?? 0) > 0;
  } catch {
    writeSucceeded = false;
  }
  let row: RevocationRow | null;
  try {
    row = await session
      .prepare(READ_REVOCATION_SQL)
      .bind(revocation.authorizationIdSha256)
      .first<RevocationRow>();
  } catch {
    throw new RepositoryUnavailableError(writeSucceeded);
  }
  if (
    row === null
    || row.permit_subject_digest_sha256
      !== revocation.permitSubjectDigestSha256
    || row.reason_code !== revocation.reasonCode
    || row.evidence_sha256 !== revocation.evidenceSha256
    || row.revocation_event_sha256
      !== revocation.revocationEventSha256
    || row.revoke_credential_id_sha256
      !== revokeCredentialIdSha256
  ) {
    throw new RepositoryConflictError("revocation_conflict");
  }
  return {
    classification: writeSucceeded ? "revoked" : "exact_replay",
    revocation: row,
  };
}

async function requireSchema(session: D1DatabaseSession): Promise<void> {
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
    || row.issuance_columns !== ISSUANCE_COLUMNS.join(",")
    || row.revocation_columns !== REVOCATION_COLUMNS.join(",")
    || row.schema_objects !== EXPECTED_SCHEMA_OBJECTS
  ) {
    throw new RepositoryUnavailableError(false);
  }
}

async function readIssuanceFromSession(
  session: D1DatabaseSession,
  authorizationIdSha256: string,
  permitSubjectDigestSha256: string,
  campaignId: string,
): Promise<IssuanceRow | null> {
  return session
    .prepare(READ_ISSUANCE_SQL)
    .bind(
      authorizationIdSha256,
      permitSubjectDigestSha256,
      campaignId,
    )
    .first<IssuanceRow>();
}

function approvalMap(
  approvals: readonly VerifiedApproval[],
): Record<
  "security" | "operations" | "release" | "rollback",
  VerifiedApproval
> {
  const result = Object.fromEntries(
    approvals.map((approval) => [approval.role, approval]),
  ) as Partial<
    Record<
      "security" | "operations" | "release" | "rollback",
      VerifiedApproval
    >
  >;
  if (
    result.security === undefined
    || result.operations === undefined
    || result.release === undefined
    || result.rollback === undefined
  ) {
    throw new RepositoryConflictError("approval_inventory_invalid");
  }
  return {
    security: result.security,
    operations: result.operations,
    release: result.release,
    rollback: result.rollback,
  };
}

function matchesIssuance(
  row: IssuanceRow,
  issuance: VerifiedIssuance,
  issueCredentialIdSha256: string,
  authorityVersionId: string,
): boolean {
  const approvals = approvalMap(issuance.approvals);
  return (
    row.authorization_id_sha256
      === issuance.permit.authorization_id_sha256
    && row.execution_nonce_sha256
      === issuance.permit.execution_nonce_sha256
    && row.campaign_id === issuance.permit.campaign_id
    && row.campaign_nonce_sha256
      === issuance.permit.campaign_nonce_sha256
    && row.permit_subject_digest_sha256
      === issuance.permitSubjectDigestSha256
    && row.issuance_request_sha256
      === issuance.issuanceRequestSha256
    && row.approvals_digest_sha256
      === issuance.approvalsDigestSha256
    && row.policy_id === issuance.policyId
    && row.policy_sha256 === issuance.policySha256
    && row.permit_issuer === issuance.permit.issuer
    && row.permit_key_id === issuance.permit.key_id
    && row.permit_signer_spki_sha256
      === issuance.permitSignerSpkiSha256
    && row.environment === issuance.permit.environment
    && row.controller_service_name
      === issuance.permit.controller_service_name
    && row.controller_version_id
      === issuance.permit.controller_version_id
    && row.action_gate_inventory_sha256
      === issuance.permit.action_gate_inventory_sha256
    && row.foundation_manifest_sha256
      === issuance.permit.foundation_manifest_sha256
    && row.runtime_build_id === issuance.permit.runtime_build_id
    && row.ring_generation === issuance.permit.ring_generation
    && row.shard_count === issuance.permit.shard_count
    && row.campaign_lifetime_seconds
      === issuance.permit.campaign_lifetime_seconds
    && row.permit_issued_at === issuance.permit.issued_at
    && row.permit_expires_at === issuance.permit.expires_at
    && row.security_key_id === approvals.security.keyId
    && row.security_spki_sha256 === approvals.security.spkiSha256
    && row.security_signed_at === approvals.security.signedAt
    && row.security_expires_at === approvals.security.expiresAt
    && row.operations_key_id === approvals.operations.keyId
    && row.operations_spki_sha256 === approvals.operations.spkiSha256
    && row.operations_signed_at === approvals.operations.signedAt
    && row.operations_expires_at === approvals.operations.expiresAt
    && row.release_key_id === approvals.release.keyId
    && row.release_spki_sha256 === approvals.release.spkiSha256
    && row.release_signed_at === approvals.release.signedAt
    && row.release_expires_at === approvals.release.expiresAt
    && row.rollback_key_id === approvals.rollback.keyId
    && row.rollback_spki_sha256 === approvals.rollback.spkiSha256
    && row.rollback_signed_at === approvals.rollback.signedAt
    && row.rollback_expires_at === approvals.rollback.expiresAt
    && row.issue_credential_id_sha256 === issueCredentialIdSha256
    && row.authority_version_id === authorityVersionId
  );
}
