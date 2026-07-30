-- Require one short-lived collection authorization and two independently
-- verified source attestations before an accepted-source seal can exist.
--
-- This is an append-only authorization/evidence boundary. It adds no route,
-- secret, write gate, close authority, traffic authority, or reopen path.

CREATE TABLE relay_container_drain_source_authorization_preflight (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1)
);

CREATE TRIGGER relay_container_drain_source_authorization_preflight_guard
BEFORE INSERT ON relay_container_drain_source_authorization_preflight
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    EXISTS (SELECT 1 FROM relay_container_drain_source_scans)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_members)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_pages)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_shards)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_seals)
  THEN RAISE(
    ABORT,
    '0072 requires empty 0071 source tables and a stopped 0071 writer'
  ) END;
END;

INSERT INTO relay_container_drain_source_authorization_preflight(singleton)
VALUES (1);

DROP TRIGGER relay_container_drain_source_authorization_preflight_guard;
DROP TABLE relay_container_drain_source_authorization_preflight;

CREATE TABLE relay_container_drain_source_authorizations (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  authorization_contract TEXT NOT NULL
    CHECK (
      authorization_contract =
        'relay-container-drain-source-authorization-v1'
    ),
  authorization_migration TEXT NOT NULL
    CHECK (
      authorization_migration =
        '0072_relay_container_drain_source_authorization.sql'
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind = 'global'),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      scope_id_sha256 =
        '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    ),
  admission_fence_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_fence_id_sha256) = 'text'
      AND length(admission_fence_id_sha256) = 64
      AND admission_fence_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  fence_generation INTEGER NOT NULL
    CHECK (typeof(fence_generation) = 'integer' AND fence_generation = 1),
  expected_fence_state_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(expected_fence_state_digest_sha256) = 'text'
      AND length(expected_fence_state_digest_sha256) = 64
      AND expected_fence_state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  expected_head_version INTEGER NOT NULL
    CHECK (
      typeof(expected_head_version) = 'integer'
      AND expected_head_version = 1
    ),
  expected_head_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(expected_head_digest_sha256) = 'text'
      AND length(expected_head_digest_sha256) = 64
      AND expected_head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  source_scan_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(source_scan_id_sha256) = 'text'
      AND length(source_scan_id_sha256) = 64
      AND source_scan_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  collector_service_name TEXT NOT NULL
    CHECK (
      typeof(collector_service_name) = 'text'
      AND length(collector_service_name) BETWEEN 1 AND 128
      AND substr(collector_service_name, 1, 1) GLOB '[a-z0-9]'
      AND substr(collector_service_name, -1, 1) GLOB '[a-z0-9]'
      AND collector_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  collector_version_id TEXT NOT NULL
    CHECK (
      typeof(collector_version_id) = 'text'
      AND length(collector_version_id) BETWEEN 1 AND 128
      AND substr(collector_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND collector_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  collector_run_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(collector_run_id_sha256) = 'text'
      AND length(collector_run_id_sha256) = 64
      AND collector_run_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  started_by_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(started_by_credential_id_sha256) = 'text'
      AND length(started_by_credential_id_sha256) = 64
      AND started_by_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  page_size INTEGER NOT NULL
    CHECK (
      typeof(page_size) = 'integer'
      AND page_size BETWEEN 1 AND 512
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  accepted_source_schema_sha256 TEXT NOT NULL
    CHECK (
      accepted_source_schema_sha256 =
        'fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50'
    ),
  authorizer_issuer TEXT NOT NULL
    CHECK (
      typeof(authorizer_issuer) = 'text'
      AND length(authorizer_issuer) BETWEEN 1 AND 128
      AND substr(authorizer_issuer, 1, 1) GLOB '[A-Za-z0-9]'
      AND authorizer_issuer NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  authorizer_key_id TEXT NOT NULL
    CHECK (
      typeof(authorizer_key_id) = 'text'
      AND length(authorizer_key_id) BETWEEN 1 AND 64
      AND substr(authorizer_key_id, 1, 1) GLOB '[a-z0-9]'
      AND authorizer_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  authorizer_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authorizer_identity_sha256) = 'text'
      AND length(authorizer_identity_sha256) = 64
      AND authorizer_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorizer_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(authorizer_spki_sha256) = 'text'
      AND length(authorizer_spki_sha256) = 64
      AND authorizer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorization_subject_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authorization_subject_sha256) = 'text'
      AND length(authorization_subject_sha256) = 64
      AND authorization_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorization_signature_envelope_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authorization_signature_envelope_sha256) = 'text'
      AND length(authorization_signature_envelope_sha256) = 64
      AND authorization_signature_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(execution_nonce_sha256) = 'text'
      AND length(execution_nonce_sha256) = 64
      AND execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_issued_at INTEGER NOT NULL
    CHECK (typeof(permit_issued_at) = 'integer' AND permit_issued_at > 0),
  permit_expires_at INTEGER NOT NULL
    CHECK (
      typeof(permit_expires_at) = 'integer'
      AND permit_expires_at > permit_issued_at
      AND permit_expires_at - permit_issued_at BETWEEN 60 AND 900
    ),
  authorized_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(authorized_by_admin_id) = 'integer'
      AND authorized_by_admin_id > 0
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (
      typeof(recorded_at) = 'integer'
      AND recorded_at >= permit_issued_at
      AND recorded_at <= permit_expires_at
    ),
  CHECK (
    authorization_id_sha256 <> source_scan_id_sha256
    AND authorization_id_sha256 <> collector_run_id_sha256
    AND authorization_id_sha256 <> execution_nonce_sha256
    AND source_scan_id_sha256 <> collector_run_id_sha256
    AND source_scan_id_sha256 <> execution_nonce_sha256
    AND collector_run_id_sha256 <> execution_nonce_sha256
    AND authorizer_identity_sha256 <> authorizer_spki_sha256
    AND authorization_subject_sha256 <>
          authorization_signature_envelope_sha256
  )
);

CREATE TABLE relay_container_drain_source_attestations (
  authorization_id_sha256 TEXT NOT NULL,
  attestation_role TEXT NOT NULL
    CHECK (attestation_role IN ('assembler', 'verifier')),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  attestation_contract TEXT NOT NULL
    CHECK (
      attestation_contract =
        'relay-container-drain-source-attestation-v1'
    ),
  attestation_migration TEXT NOT NULL
    CHECK (
      attestation_migration =
        '0072_relay_container_drain_source_authorization.sql'
    ),
  source_scan_id_sha256 TEXT NOT NULL,
  source_seal_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(source_seal_id_sha256) = 'text'
      AND length(source_seal_id_sha256) = 64
      AND source_seal_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  issuer TEXT NOT NULL
    CHECK (
      typeof(issuer) = 'text'
      AND length(issuer) BETWEEN 1 AND 128
      AND substr(issuer, 1, 1) GLOB '[A-Za-z0-9]'
      AND issuer NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  key_id TEXT NOT NULL
    CHECK (
      typeof(key_id) = 'text'
      AND length(key_id) BETWEEN 1 AND 64
      AND substr(key_id, 1, 1) GLOB '[a-z0-9]'
      AND key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(identity_sha256) = 'text'
      AND length(identity_sha256) = 64
      AND identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  signer_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(signer_spki_sha256) = 'text'
      AND length(signer_spki_sha256) = 64
      AND signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  attestation_subject_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(attestation_subject_sha256) = 'text'
      AND length(attestation_subject_sha256) = 64
      AND attestation_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  signature_envelope_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(signature_envelope_sha256) = 'text'
      AND length(signature_envelope_sha256) = 64
      AND signature_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_bookmark_sha256 TEXT NOT NULL,
  accepted_set_manifest_sha256 TEXT NOT NULL,
  accepted_source_schema_sha256 TEXT NOT NULL
    CHECK (
      accepted_source_schema_sha256 =
        'fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50'
    ),
  accepted_source_readback_sha256 TEXT NOT NULL,
  page_count INTEGER NOT NULL
    CHECK (typeof(page_count) = 'integer' AND page_count >= 0),
  first_page_digest_sha256 TEXT,
  last_page_digest_sha256 TEXT,
  shard_set_manifest_sha256 TEXT NOT NULL,
  captured_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(captured_high_watermark) = 'integer'
      AND captured_high_watermark >= 0
    ),
  captured_member_count INTEGER NOT NULL
    CHECK (
      typeof(captured_member_count) = 'integer'
      AND captured_member_count >= 0
    ),
  captured_first_sequence INTEGER NOT NULL
    CHECK (
      typeof(captured_first_sequence) = 'integer'
      AND captured_first_sequence >= 0
    ),
  captured_first_operation_id TEXT,
  captured_last_sequence INTEGER NOT NULL
    CHECK (
      typeof(captured_last_sequence) = 'integer'
      AND captured_last_sequence >= 0
    ),
  captured_last_operation_id TEXT,
  attested_at INTEGER NOT NULL
    CHECK (typeof(attested_at) = 'integer' AND attested_at > 0),
  valid_until INTEGER NOT NULL
    CHECK (
      typeof(valid_until) = 'integer'
      AND valid_until > attested_at
      AND valid_until - attested_at BETWEEN 30 AND 900
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (
      typeof(recorded_at) = 'integer'
      AND recorded_at >= attested_at
      AND recorded_at - attested_at BETWEEN 0 AND 120
      AND recorded_at < valid_until
    ),
  PRIMARY KEY (authorization_id_sha256, attestation_role),
  UNIQUE (authorization_id_sha256, identity_sha256),
  UNIQUE (authorization_id_sha256, signer_spki_sha256),
  UNIQUE (source_seal_id_sha256, attestation_role),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (source_scan_id_sha256)
    REFERENCES relay_container_drain_source_scans(source_scan_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(authorization_id_sha256) = 64
    AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(source_scan_id_sha256) = 64
    AND source_scan_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(accepted_bookmark_sha256) = 64
    AND accepted_bookmark_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(accepted_set_manifest_sha256) = 64
    AND accepted_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(accepted_source_readback_sha256) = 64
    AND accepted_source_readback_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(shard_set_manifest_sha256) = 64
    AND shard_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (
      page_count = 0
      AND first_page_digest_sha256 IS NULL
      AND last_page_digest_sha256 IS NULL
    )
    OR (
      page_count > 0
      AND length(first_page_digest_sha256) = 64
      AND first_page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(last_page_digest_sha256) = 64
      AND last_page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (
      captured_member_count = 0
      AND captured_high_watermark = 0
      AND captured_first_sequence = 0
      AND captured_first_operation_id IS NULL
      AND captured_last_sequence = 0
      AND captured_last_operation_id IS NULL
    )
    OR (
      captured_member_count > 0
      AND captured_high_watermark = captured_member_count
      AND captured_first_sequence = 1
      AND captured_first_operation_id IS NOT NULL
      AND length(captured_first_operation_id) BETWEEN 1 AND 128
      AND substr(captured_first_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND captured_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND captured_last_sequence = captured_high_watermark
      AND captured_last_operation_id IS NOT NULL
      AND length(captured_last_operation_id) BETWEEN 1 AND 128
      AND substr(captured_last_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND captured_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  CHECK (
    identity_sha256 <> signer_spki_sha256
    AND attestation_subject_sha256 <> signature_envelope_sha256
    AND source_scan_id_sha256 <> source_seal_id_sha256
  )
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_drain_source_authorization_expiry
  ON relay_container_drain_source_authorizations(
    environment,
    permit_expires_at,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_authorization_audit
  ON relay_container_drain_source_authorizations(
    recorded_at,
    authorized_by_admin_id,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_attestation_seal
  ON relay_container_drain_source_attestations(
    source_seal_id_sha256,
    attestation_role
  );

CREATE INDEX idx_relay_container_drain_source_attestation_audit
  ON relay_container_drain_source_attestations(
    recorded_at,
    attestation_role,
    authorization_id_sha256
  );

CREATE TRIGGER relay_container_drain_source_authorization_insert_guard
BEFORE INSERT ON relay_container_drain_source_authorizations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
       OR authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
       OR authorization.collector_run_id_sha256 =
            NEW.collector_run_id_sha256
       OR authorization.authorization_subject_sha256 =
            NEW.authorization_subject_sha256
       OR authorization.authorization_signature_envelope_sha256 =
            NEW.authorization_signature_envelope_sha256
       OR authorization.execution_nonce_sha256 =
            NEW.execution_nonce_sha256
  ) THEN RAISE(
    ABORT,
    'drain source authorization identity already exists'
  ) END;

  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source authorization time must come from D1'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql',
      '0072_relay_container_drain_source_authorization.sql'
    )
  ) <> 6
  THEN RAISE(
    ABORT,
    'drain source authorization requires the complete 0067 through 0072 chain'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_admission_scope_heads AS head
    JOIN relay_container_admission_fences AS fence
      ON fence.admission_fence_id_sha256 =
           head.current_fence_id_sha256
     AND fence.environment = head.environment
     AND fence.scope_kind = head.scope_kind
     AND fence.scope_id_sha256 = head.scope_id_sha256
     AND fence.fence_generation = head.current_fence_generation
    WHERE head.environment = NEW.environment
      AND head.scope_kind = NEW.scope_kind
      AND head.scope_id_sha256 = NEW.scope_id_sha256
      AND head.current_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND head.current_fence_generation = NEW.fence_generation
      AND head.head_version = NEW.expected_head_version
      AND head.head_digest_sha256 = NEW.expected_head_digest_sha256
      AND fence.fence_kind = 'admission'
      AND fence.admission_open = 1
      AND fence.state_digest_sha256 =
            NEW.expected_fence_state_digest_sha256
  ) THEN RAISE(
    ABORT,
    'drain source authorization lost the current admission fence'
  ) END;

  SELECT CASE WHEN
    NEW.recorded_at < NEW.permit_issued_at
    OR NEW.recorded_at >= NEW.permit_expires_at
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_scans AS scan
      WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
         OR scan.collector_run_id_sha256 = NEW.collector_run_id_sha256
    )
  THEN RAISE(
    ABORT,
    'drain source authorization is expired, replayed, or detached'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_authorization_update_guard
BEFORE UPDATE ON relay_container_drain_source_authorizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source authorizations are immutable');
END;

CREATE TRIGGER relay_container_drain_source_authorization_delete_guard
BEFORE DELETE ON relay_container_drain_source_authorizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source authorizations are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_scan_authorization_guard
BEFORE INSERT ON relay_container_drain_source_scans
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND authorization.environment = NEW.environment
      AND authorization.scope_kind = NEW.scope_kind
      AND authorization.scope_id_sha256 = NEW.scope_id_sha256
      AND authorization.admission_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND authorization.fence_generation = NEW.fence_generation
      AND authorization.expected_fence_state_digest_sha256 =
            NEW.expected_fence_state_digest_sha256
      AND authorization.expected_head_version =
            NEW.expected_head_version
      AND authorization.expected_head_digest_sha256 =
            NEW.expected_head_digest_sha256
      AND authorization.collector_service_name =
            NEW.collector_service_name
      AND authorization.collector_version_id =
            NEW.collector_version_id
      AND authorization.collector_run_id_sha256 =
            NEW.collector_run_id_sha256
      AND authorization.started_by_credential_id_sha256 =
            NEW.started_by_credential_id_sha256
      AND authorization.page_size = NEW.page_size
      AND authorization.shard_count = NEW.shard_count
      AND authorization.recorded_at <= NEW.started_at
      AND NEW.started_at < authorization.permit_expires_at
      AND unixepoch() < authorization.permit_expires_at
  ) THEN RAISE(
    ABORT,
    'drain source scan requires an exact unexpired authorization'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_attestation_insert_guard
BEFORE INSERT ON relay_container_drain_source_attestations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_attestations AS attestation
    WHERE (
      attestation.authorization_id_sha256 =
        NEW.authorization_id_sha256
      AND (
        attestation.attestation_role = NEW.attestation_role
        OR attestation.identity_sha256 = NEW.identity_sha256
        OR attestation.signer_spki_sha256 = NEW.signer_spki_sha256
      )
    )
       OR attestation.attestation_subject_sha256 =
            NEW.attestation_subject_sha256
       OR attestation.signature_envelope_sha256 =
            NEW.signature_envelope_sha256
       OR (
         attestation.source_seal_id_sha256 =
           NEW.source_seal_id_sha256
         AND attestation.attestation_role = NEW.attestation_role
       )
  ) THEN RAISE(
    ABORT,
    'drain source attestation identity already exists'
  ) END;

  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source attestation receipt time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_scans AS scan
      ON scan.source_scan_id_sha256 =
           authorization.source_scan_id_sha256
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND authorization.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND scan.captured_high_watermark =
            NEW.captured_high_watermark
      AND scan.captured_member_count = NEW.captured_member_count
      AND scan.captured_first_sequence =
            NEW.captured_first_sequence
      AND scan.captured_first_operation_id IS
            NEW.captured_first_operation_id
      AND scan.captured_last_sequence =
            NEW.captured_last_sequence
      AND scan.captured_last_operation_id IS
            NEW.captured_last_operation_id
      AND NEW.attested_at >= scan.started_at
      AND NEW.attested_at >= authorization.recorded_at
      AND NEW.recorded_at < authorization.permit_expires_at
      AND NEW.valid_until <= authorization.permit_expires_at
      AND NEW.identity_sha256 <>
            authorization.authorizer_identity_sha256
      AND NEW.signer_spki_sha256 <>
            authorization.authorizer_spki_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_seals AS seal
        WHERE seal.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
           OR seal.source_seal_id_sha256 =
                NEW.source_seal_id_sha256
      )
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
      )
      AND NEW.page_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
      )
      AND scan.shard_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_shards AS shard
        WHERE shard.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
      )
      AND scan.captured_member_count = COALESCE((
        SELECT SUM(page.page_member_count)
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
      ), 0)
      AND scan.captured_member_count = COALESCE((
        SELECT SUM(shard.shard_member_count)
        FROM relay_container_drain_source_shards AS shard
        WHERE shard.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
      ), 0)
      AND NEW.first_page_digest_sha256 IS (
        SELECT page.page_digest_sha256
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
        ORDER BY page.page_ordinal ASC
        LIMIT 1
      )
      AND NEW.last_page_digest_sha256 IS (
        SELECT page.page_digest_sha256
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
        ORDER BY page.page_ordinal DESC
        LIMIT 1
      )
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      )
      AND scan.captured_high_watermark = COALESCE((
        SELECT MAX(commit_row.accepted_sequence)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      ), 0)
  ) THEN RAISE(
    ABORT,
    'drain source attestation is incomplete, stale, or unauthorized'
  ) END;

  SELECT CASE WHEN
    (
      NEW.attestation_role = 'assembler'
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_attestations AS prior
        WHERE prior.authorization_id_sha256 =
                NEW.authorization_id_sha256
      )
    )
    OR (
      NEW.attestation_role = 'verifier'
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_attestations AS assembler
        WHERE assembler.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND assembler.attestation_role = 'assembler'
          AND assembler.source_scan_id_sha256 =
                NEW.source_scan_id_sha256
          AND assembler.source_seal_id_sha256 =
                NEW.source_seal_id_sha256
          AND assembler.identity_sha256 <> NEW.identity_sha256
          AND assembler.signer_spki_sha256 <>
                NEW.signer_spki_sha256
          AND assembler.signature_envelope_sha256 <>
                NEW.signature_envelope_sha256
          AND assembler.accepted_bookmark_sha256 =
                NEW.accepted_bookmark_sha256
          AND assembler.accepted_set_manifest_sha256 =
                NEW.accepted_set_manifest_sha256
          AND assembler.accepted_source_schema_sha256 =
                NEW.accepted_source_schema_sha256
          AND assembler.accepted_source_readback_sha256 =
                NEW.accepted_source_readback_sha256
          AND assembler.page_count = NEW.page_count
          AND assembler.first_page_digest_sha256 IS
                NEW.first_page_digest_sha256
          AND assembler.last_page_digest_sha256 IS
                NEW.last_page_digest_sha256
          AND assembler.shard_set_manifest_sha256 =
                NEW.shard_set_manifest_sha256
          AND assembler.captured_high_watermark =
                NEW.captured_high_watermark
          AND assembler.captured_member_count =
                NEW.captured_member_count
          AND assembler.captured_first_sequence =
                NEW.captured_first_sequence
          AND assembler.captured_first_operation_id IS
                NEW.captured_first_operation_id
          AND assembler.captured_last_sequence =
                NEW.captured_last_sequence
          AND assembler.captured_last_operation_id IS
                NEW.captured_last_operation_id
          AND assembler.attested_at <= NEW.attested_at
          AND assembler.recorded_at <= NEW.recorded_at
      )
    )
  THEN RAISE(
    ABORT,
    'drain source attestations require ordered independent roles'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_attestation_update_guard
BEFORE UPDATE ON relay_container_drain_source_attestations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source attestations are immutable');
END;

CREATE TRIGGER relay_container_drain_source_attestation_delete_guard
BEFORE DELETE ON relay_container_drain_source_attestations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source attestations are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_seal_authorization_guard
BEFORE INSERT ON relay_container_drain_source_seals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_scans AS scan
      ON scan.source_scan_id_sha256 =
           authorization.source_scan_id_sha256
    JOIN relay_container_drain_source_attestations AS assembler
      ON assembler.authorization_id_sha256 =
           authorization.authorization_id_sha256
     AND assembler.attestation_role = 'assembler'
    JOIN relay_container_drain_source_attestations AS verifier
      ON verifier.authorization_id_sha256 =
           authorization.authorization_id_sha256
     AND verifier.attestation_role = 'verifier'
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND NEW.sealed_at >= verifier.recorded_at
      AND NEW.sealed_at < authorization.permit_expires_at
      AND NEW.sealed_at < assembler.valid_until
      AND NEW.sealed_at < verifier.valid_until
      AND assembler.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND verifier.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND assembler.source_seal_id_sha256 =
            NEW.source_seal_id_sha256
      AND verifier.source_seal_id_sha256 =
            NEW.source_seal_id_sha256
      AND assembler.identity_sha256 =
            NEW.assembler_identity_sha256
      AND assembler.signature_envelope_sha256 =
            NEW.assembler_signature_envelope_sha256
      AND verifier.identity_sha256 =
            NEW.verifier_identity_sha256
      AND verifier.signature_envelope_sha256 =
            NEW.verifier_signature_envelope_sha256
      AND assembler.identity_sha256 <> verifier.identity_sha256
      AND assembler.signer_spki_sha256 <>
            verifier.signer_spki_sha256
      AND assembler.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND verifier.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND assembler.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND verifier.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND assembler.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND verifier.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND assembler.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
      AND verifier.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
      AND assembler.page_count = NEW.page_count
      AND verifier.page_count = NEW.page_count
      AND assembler.first_page_digest_sha256 IS
            NEW.first_page_digest_sha256
      AND verifier.first_page_digest_sha256 IS
            NEW.first_page_digest_sha256
      AND assembler.last_page_digest_sha256 IS
            NEW.last_page_digest_sha256
      AND verifier.last_page_digest_sha256 IS
            NEW.last_page_digest_sha256
      AND assembler.shard_set_manifest_sha256 =
            NEW.shard_set_manifest_sha256
      AND verifier.shard_set_manifest_sha256 =
            NEW.shard_set_manifest_sha256
      AND assembler.captured_high_watermark =
            scan.captured_high_watermark
      AND verifier.captured_high_watermark =
            scan.captured_high_watermark
      AND assembler.captured_member_count =
            scan.captured_member_count
      AND verifier.captured_member_count =
            scan.captured_member_count
      AND assembler.captured_first_sequence =
            scan.captured_first_sequence
      AND verifier.captured_first_sequence =
            scan.captured_first_sequence
      AND assembler.captured_first_operation_id IS
            scan.captured_first_operation_id
      AND verifier.captured_first_operation_id IS
            scan.captured_first_operation_id
      AND assembler.captured_last_sequence =
            scan.captured_last_sequence
      AND verifier.captured_last_sequence =
            scan.captured_last_sequence
      AND assembler.captured_last_operation_id IS
            scan.captured_last_operation_id
      AND verifier.captured_last_operation_id IS
            scan.captured_last_operation_id
  ) THEN RAISE(
    ABORT,
    'drain source seal requires exact authorized independent attestations'
  ) END;
END;
