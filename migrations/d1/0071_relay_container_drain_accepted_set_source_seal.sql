-- Bind every drain close command to an immutable, independently assembled
-- accepted-set source seal.
--
-- This migration adds no route, credential, write gate, traffic authority,
-- or reopen path. It makes 0070 fail closed until a complete source scan,
-- deterministic member/page/shard inventory, and two-role seal exist.

CREATE TABLE relay_container_drain_source_scans (
  source_scan_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(source_scan_id_sha256) = 'text'
      AND length(source_scan_id_sha256) = 64
      AND source_scan_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  scan_contract TEXT NOT NULL
    CHECK (scan_contract = 'relay-container-drain-source-scan-v1'),
  scan_migration TEXT NOT NULL
    CHECK (
      scan_migration =
        '0071_relay_container_drain_accepted_set_source_seal.sql'
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
    CHECK (
      typeof(fence_generation) = 'integer'
      AND fence_generation = 1
    ),
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
  collector_run_id_sha256 TEXT NOT NULL
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
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(started_at) = 'integer' AND started_at > 0),
  FOREIGN KEY (
    environment,
    scope_kind,
    scope_id_sha256
  ) REFERENCES relay_container_admission_scope_heads(
    environment,
    scope_kind,
    scope_id_sha256
  )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (admission_fence_id_sha256)
    REFERENCES relay_container_admission_fences(admission_fence_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
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
  )
);

CREATE TABLE relay_container_drain_source_members (
  source_scan_id_sha256 TEXT NOT NULL,
  accepted_sequence INTEGER NOT NULL
    CHECK (
      typeof(accepted_sequence) = 'integer'
      AND accepted_sequence > 0
    ),
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND substr(operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  source_contract TEXT NOT NULL
    CHECK (
      source_contract IN (
        'pre-0068-atomic-admission-v1',
        'fenced-atomic-admission-v1'
      )
    ),
  admission_fence_id_sha256 TEXT
    CHECK (
      admission_fence_id_sha256 IS NULL
      OR (
        typeof(admission_fence_id_sha256) = 'text'
        AND length(admission_fence_id_sha256) = 64
        AND admission_fence_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  fence_generation INTEGER NOT NULL
    CHECK (
      typeof(fence_generation) = 'integer'
      AND fence_generation >= 0
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND substr(reservation_key, 1, 1) GLOB '[A-Za-z0-9]'
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  atomic_admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(atomic_admission_sha256) = 'text'
      AND length(atomic_admission_sha256) = 64
      AND atomic_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_admission_sha256) = 'text'
      AND length(operation_admission_sha256) = 64
      AND operation_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_snapshot_sha256) = 'text'
      AND length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_request_sha256 TEXT NOT NULL
    CHECK (
      typeof(client_request_sha256) = 'text'
      AND length(client_request_sha256) = 64
      AND client_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (
      typeof(owner_generation) = 'integer'
      AND owner_generation > 0
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  source_shard_count INTEGER NOT NULL
    CHECK (
      typeof(source_shard_count) = 'integer'
      AND source_shard_count BETWEEN 1 AND 1024
    ),
  shard_index INTEGER NOT NULL
    CHECK (
      typeof(shard_index) = 'integer'
      AND shard_index >= 0
      AND shard_index < source_shard_count
    ),
  admission_commit_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_commit_sha256) = 'text'
      AND length(admission_commit_sha256) = 64
      AND admission_commit_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  committed_at INTEGER NOT NULL
    CHECK (typeof(committed_at) = 'integer' AND committed_at > 0),
  page_ordinal INTEGER NOT NULL
    CHECK (typeof(page_ordinal) = 'integer' AND page_ordinal > 0),
  member_ordinal INTEGER NOT NULL
    CHECK (typeof(member_ordinal) = 'integer' AND member_ordinal > 0),
  member_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(member_digest_sha256) = 'text'
      AND length(member_digest_sha256) = 64
      AND member_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  collected_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(collected_at) = 'integer' AND collected_at > 0),
  PRIMARY KEY (source_scan_id_sha256, accepted_sequence),
  UNIQUE (source_scan_id_sha256, operation_id),
  UNIQUE (
    source_scan_id_sha256,
    page_ordinal,
    member_ordinal
  ),
  FOREIGN KEY (source_scan_id_sha256)
    REFERENCES relay_container_drain_source_scans(source_scan_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (accepted_sequence)
    REFERENCES relay_container_admission_commits(accepted_sequence)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (reservation_key = operation_id),
  CHECK (member_digest_sha256 = admission_commit_sha256),
  CHECK (
    (
      source_contract = 'pre-0068-atomic-admission-v1'
      AND admission_fence_id_sha256 IS NULL
      AND fence_generation = 0
      AND admission_commit_sha256 = atomic_admission_sha256
    )
    OR (
      source_contract = 'fenced-atomic-admission-v1'
      AND admission_fence_id_sha256 IS NOT NULL
      AND fence_generation > 0
    )
  )
) WITHOUT ROWID;

CREATE TABLE relay_container_drain_source_pages (
  source_scan_id_sha256 TEXT NOT NULL,
  page_ordinal INTEGER NOT NULL
    CHECK (typeof(page_ordinal) = 'integer' AND page_ordinal > 0),
  page_member_count INTEGER NOT NULL
    CHECK (
      typeof(page_member_count) = 'integer'
      AND page_member_count > 0
    ),
  page_first_sequence INTEGER NOT NULL
    CHECK (
      typeof(page_first_sequence) = 'integer'
      AND page_first_sequence > 0
    ),
  page_first_operation_id TEXT NOT NULL
    CHECK (
      typeof(page_first_operation_id) = 'text'
      AND length(page_first_operation_id) BETWEEN 1 AND 128
      AND substr(page_first_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND page_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  page_last_sequence INTEGER NOT NULL
    CHECK (
      typeof(page_last_sequence) = 'integer'
      AND page_last_sequence >= page_first_sequence
    ),
  page_last_operation_id TEXT NOT NULL
    CHECK (
      typeof(page_last_operation_id) = 'text'
      AND length(page_last_operation_id) BETWEEN 1 AND 128
      AND substr(page_last_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND page_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  previous_page_digest_sha256 TEXT
    CHECK (
      previous_page_digest_sha256 IS NULL
      OR (
        typeof(previous_page_digest_sha256) = 'text'
        AND length(previous_page_digest_sha256) = 64
        AND previous_page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  page_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(page_digest_sha256) = 'text'
      AND length(page_digest_sha256) = 64
      AND page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  sealed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(sealed_at) = 'integer' AND sealed_at > 0),
  PRIMARY KEY (source_scan_id_sha256, page_ordinal),
  UNIQUE (source_scan_id_sha256, page_digest_sha256),
  FOREIGN KEY (source_scan_id_sha256)
    REFERENCES relay_container_drain_source_scans(source_scan_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (
      page_ordinal = 1
      AND previous_page_digest_sha256 IS NULL
    )
    OR (
      page_ordinal > 1
      AND previous_page_digest_sha256 IS NOT NULL
      AND previous_page_digest_sha256 <> page_digest_sha256
    )
  )
) WITHOUT ROWID;

CREATE TABLE relay_container_drain_source_shards (
  source_scan_id_sha256 TEXT NOT NULL,
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  shard_member_count INTEGER NOT NULL
    CHECK (
      typeof(shard_member_count) = 'integer'
      AND shard_member_count >= 0
    ),
  shard_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(shard_high_watermark) = 'integer'
      AND shard_high_watermark >= 0
    ),
  shard_first_sequence INTEGER NOT NULL
    CHECK (
      typeof(shard_first_sequence) = 'integer'
      AND shard_first_sequence >= 0
    ),
  shard_first_operation_id TEXT,
  shard_last_sequence INTEGER NOT NULL
    CHECK (
      typeof(shard_last_sequence) = 'integer'
      AND shard_last_sequence >= 0
    ),
  shard_last_operation_id TEXT,
  shard_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(shard_manifest_sha256) = 'text'
      AND length(shard_manifest_sha256) = 64
      AND shard_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  sealed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(sealed_at) = 'integer' AND sealed_at > 0),
  PRIMARY KEY (source_scan_id_sha256, shard_index),
  UNIQUE (source_scan_id_sha256, shard_manifest_sha256),
  FOREIGN KEY (source_scan_id_sha256)
    REFERENCES relay_container_drain_source_scans(source_scan_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (
      shard_member_count = 0
      AND shard_high_watermark = 0
      AND shard_first_sequence = 0
      AND shard_first_operation_id IS NULL
      AND shard_last_sequence = 0
      AND shard_last_operation_id IS NULL
    )
    OR (
      shard_member_count > 0
      AND shard_high_watermark > 0
      AND shard_first_sequence > 0
      AND shard_first_operation_id IS NOT NULL
      AND length(shard_first_operation_id) BETWEEN 1 AND 128
      AND substr(shard_first_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND shard_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND shard_last_sequence >= shard_first_sequence
      AND shard_last_sequence = shard_high_watermark
      AND shard_last_operation_id IS NOT NULL
      AND length(shard_last_operation_id) BETWEEN 1 AND 128
      AND substr(shard_last_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND shard_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  )
) WITHOUT ROWID;

CREATE TABLE relay_container_drain_source_seals (
  source_seal_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(source_seal_id_sha256) = 'text'
      AND length(source_seal_id_sha256) = 64
      AND source_seal_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  source_scan_id_sha256 TEXT NOT NULL UNIQUE,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  seal_contract TEXT NOT NULL
    CHECK (seal_contract = 'relay-container-drain-source-seal-v1'),
  seal_migration TEXT NOT NULL
    CHECK (
      seal_migration =
        '0071_relay_container_drain_accepted_set_source_seal.sql'
    ),
  bookmark_contract TEXT NOT NULL
    CHECK (bookmark_contract = 'd1-session-first-primary-bookmark-v1'),
  pagination_contract TEXT NOT NULL
    CHECK (pagination_contract = 'accepted-sequence-keyset-v1'),
  accepted_bookmark_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(accepted_bookmark_sha256) = 'text'
      AND length(accepted_bookmark_sha256) = 64
      AND accepted_bookmark_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_set_manifest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(accepted_set_manifest_sha256) = 'text'
      AND length(accepted_set_manifest_sha256) = 64
      AND accepted_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_source_schema_sha256 TEXT NOT NULL
    CHECK (
      accepted_source_schema_sha256 =
        'fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50'
    ),
  accepted_source_readback_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(accepted_source_readback_sha256) = 'text'
      AND length(accepted_source_readback_sha256) = 64
      AND accepted_source_readback_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  page_count INTEGER NOT NULL
    CHECK (typeof(page_count) = 'integer' AND page_count >= 0),
  first_page_digest_sha256 TEXT,
  last_page_digest_sha256 TEXT,
  shard_set_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(shard_set_manifest_sha256) = 'text'
      AND length(shard_set_manifest_sha256) = 64
      AND shard_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  assembler_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(assembler_identity_sha256) = 'text'
      AND length(assembler_identity_sha256) = 64
      AND assembler_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  assembler_signature_envelope_sha256 TEXT NOT NULL
    CHECK (
      typeof(assembler_signature_envelope_sha256) = 'text'
      AND length(assembler_signature_envelope_sha256) = 64
      AND assembler_signature_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  verifier_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(verifier_identity_sha256) = 'text'
      AND length(verifier_identity_sha256) = 64
      AND verifier_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  verifier_signature_envelope_sha256 TEXT NOT NULL
    CHECK (
      typeof(verifier_signature_envelope_sha256) = 'text'
      AND length(verifier_signature_envelope_sha256) = 64
      AND verifier_signature_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  seal_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(seal_digest_sha256) = 'text'
      AND length(seal_digest_sha256) = 64
      AND seal_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  sealed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(sealed_at) = 'integer' AND sealed_at > 0),
  FOREIGN KEY (source_scan_id_sha256)
    REFERENCES relay_container_drain_source_scans(source_scan_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (
      page_count = 0
      AND first_page_digest_sha256 IS NULL
      AND last_page_digest_sha256 IS NULL
    )
    OR (
      page_count > 0
      AND first_page_digest_sha256 IS NOT NULL
      AND length(first_page_digest_sha256) = 64
      AND first_page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND last_page_digest_sha256 IS NOT NULL
      AND length(last_page_digest_sha256) = 64
      AND last_page_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    assembler_identity_sha256 <> verifier_identity_sha256
    AND assembler_signature_envelope_sha256 <>
          verifier_signature_envelope_sha256
    AND source_seal_id_sha256 <> seal_digest_sha256
  )
);

CREATE UNIQUE INDEX idx_relay_container_drain_source_scan_run
  ON relay_container_drain_source_scans(collector_run_id_sha256);

CREATE INDEX idx_relay_container_drain_source_scan_scope
  ON relay_container_drain_source_scans(
    environment,
    started_at,
    source_scan_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_member_page
  ON relay_container_drain_source_members(
    source_scan_id_sha256,
    page_ordinal,
    accepted_sequence
  );

CREATE INDEX idx_relay_container_drain_source_member_shard
  ON relay_container_drain_source_members(
    source_scan_id_sha256,
    shard_index,
    accepted_sequence
  );

CREATE INDEX idx_relay_container_drain_source_page_chain
  ON relay_container_drain_source_pages(
    source_scan_id_sha256,
    page_ordinal,
    previous_page_digest_sha256,
    page_digest_sha256
  );

CREATE INDEX idx_relay_container_drain_source_shard_inventory
  ON relay_container_drain_source_shards(
    source_scan_id_sha256,
    shard_index,
    shard_high_watermark
  );

CREATE INDEX idx_relay_container_drain_source_seal_audit
  ON relay_container_drain_source_seals(
    sealed_at,
    source_seal_id_sha256
  );

CREATE TRIGGER relay_container_drain_source_scan_insert_guard
BEFORE INSERT ON relay_container_drain_source_scans
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_scans AS scan
    WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
       OR scan.collector_run_id_sha256 = NEW.collector_run_id_sha256
  ) THEN RAISE(
    ABORT,
    'drain source scan identity already exists'
  ) END;

  SELECT CASE WHEN NEW.started_at <> unixepoch()
  THEN RAISE(ABORT, 'drain source scan time must come from D1') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql'
    )
  ) <> 5
  THEN RAISE(
    ABORT,
    'drain source scan requires the complete 0067 through 0071 chain'
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
    'drain source scan lost the current admission fence'
  ) END;

  SELECT CASE WHEN
    NEW.captured_high_watermark IS NOT COALESCE((
      SELECT MAX(commit_row.accepted_sequence)
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
    ), 0)
    OR NEW.captured_member_count IS NOT (
      SELECT COUNT(*)
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
    )
    OR NEW.captured_first_sequence IS NOT COALESCE((
      SELECT commit_row.accepted_sequence
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
      ORDER BY commit_row.accepted_sequence ASC
      LIMIT 1
    ), 0)
    OR NEW.captured_first_operation_id IS NOT (
      SELECT commit_row.operation_id
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
      ORDER BY commit_row.accepted_sequence ASC
      LIMIT 1
    )
    OR NEW.captured_last_sequence IS NOT COALESCE((
      SELECT commit_row.accepted_sequence
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
      ORDER BY commit_row.accepted_sequence DESC
      LIMIT 1
    ), 0)
    OR NEW.captured_last_operation_id IS NOT (
      SELECT commit_row.operation_id
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
      ORDER BY commit_row.accepted_sequence DESC
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <=
              NEW.captured_high_watermark
        AND commit_row.shard_index >= NEW.shard_count
    )
  THEN RAISE(
    ABORT,
    'drain source scan boundary is stale or unroutable'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_scan_update_guard
BEFORE UPDATE ON relay_container_drain_source_scans
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source scans are immutable');
END;

CREATE TRIGGER relay_container_drain_source_scan_delete_guard
BEFORE DELETE ON relay_container_drain_source_scans
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source scans are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_member_insert_guard
BEFORE INSERT ON relay_container_drain_source_members
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_members AS member
    WHERE member.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND (
        member.accepted_sequence = NEW.accepted_sequence
        OR member.operation_id = NEW.operation_id
        OR (
          member.page_ordinal = NEW.page_ordinal
          AND member.member_ordinal = NEW.member_ordinal
        )
      )
  ) THEN RAISE(
    ABORT,
    'drain source member identity already exists'
  ) END;

  SELECT CASE WHEN NEW.collected_at <> unixepoch()
  THEN RAISE(ABORT, 'drain source member time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_scans AS scan
    JOIN relay_container_admission_commits AS commit_row
      ON commit_row.accepted_sequence = NEW.accepted_sequence
     AND commit_row.operation_id = NEW.operation_id
     AND commit_row.source_contract = NEW.source_contract
     AND commit_row.admission_fence_id_sha256 IS
           NEW.admission_fence_id_sha256
     AND commit_row.fence_generation = NEW.fence_generation
     AND commit_row.reservation_key = NEW.reservation_key
     AND commit_row.atomic_admission_sha256 =
           NEW.atomic_admission_sha256
     AND commit_row.operation_admission_sha256 =
           NEW.operation_admission_sha256
     AND commit_row.billing_snapshot_sha256 =
           NEW.billing_snapshot_sha256
     AND commit_row.client_request_sha256 =
           NEW.client_request_sha256
     AND commit_row.owner_generation = NEW.owner_generation
     AND commit_row.ring_generation = NEW.ring_generation
     AND commit_row.shard_count = NEW.source_shard_count
     AND commit_row.shard_index = NEW.shard_index
     AND commit_row.admission_commit_sha256 =
           NEW.admission_commit_sha256
     AND commit_row.committed_at = NEW.committed_at
    WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND NEW.accepted_sequence <= scan.captured_high_watermark
      AND NEW.shard_index < scan.shard_count
      AND NEW.page_ordinal =
            ((NEW.accepted_sequence - 1) / scan.page_size) + 1
      AND NEW.member_ordinal =
            ((NEW.accepted_sequence - 1) % scan.page_size) + 1
      AND NEW.collected_at >= scan.started_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_seals AS seal
        WHERE seal.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source member does not match the immutable admission source'
  ) END;

  SELECT CASE WHEN NEW.accepted_sequence IS NOT COALESCE((
    SELECT MAX(member.accepted_sequence) + 1
    FROM relay_container_drain_source_members AS member
    WHERE member.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
  ), 1)
  THEN RAISE(
    ABORT,
    'drain source member keyset is not contiguous'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_member_update_guard
BEFORE UPDATE ON relay_container_drain_source_members
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source members are immutable');
END;

CREATE TRIGGER relay_container_drain_source_member_delete_guard
BEFORE DELETE ON relay_container_drain_source_members
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source members are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_page_insert_guard
BEFORE INSERT ON relay_container_drain_source_pages
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_pages AS page
    WHERE page.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND (
        page.page_ordinal = NEW.page_ordinal
        OR page.page_digest_sha256 = NEW.page_digest_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source page identity already exists'
  ) END;

  SELECT CASE WHEN NEW.sealed_at <> unixepoch()
  THEN RAISE(ABORT, 'drain source page time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_scans AS scan
    WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND scan.captured_member_count > 0
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND NEW.page_ordinal =
            (
              SELECT COUNT(*) + 1
              FROM relay_container_drain_source_pages AS page
              WHERE page.source_scan_id_sha256 =
                      scan.source_scan_id_sha256
            )
      AND NEW.page_ordinal <=
            (
              scan.captured_member_count + scan.page_size - 1
            ) / scan.page_size
      AND NEW.page_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.page_ordinal = NEW.page_ordinal
      )
      AND NEW.page_first_sequence = (
        SELECT member.accepted_sequence
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.accepted_sequence ASC
        LIMIT 1
      )
      AND NEW.page_first_operation_id = (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.accepted_sequence ASC
        LIMIT 1
      )
      AND NEW.page_last_sequence = (
        SELECT member.accepted_sequence
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.accepted_sequence DESC
        LIMIT 1
      )
      AND NEW.page_last_operation_id = (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.accepted_sequence DESC
        LIMIT 1
      )
      AND (
        (
          NEW.page_ordinal = 1
          AND NEW.previous_page_digest_sha256 IS NULL
        )
        OR (
          NEW.page_ordinal > 1
          AND NEW.previous_page_digest_sha256 = (
            SELECT page.page_digest_sha256
            FROM relay_container_drain_source_pages AS page
            WHERE page.source_scan_id_sha256 =
                    scan.source_scan_id_sha256
              AND page.page_ordinal = NEW.page_ordinal - 1
          )
        )
      )
      AND NEW.sealed_at >= scan.started_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_seals AS seal
        WHERE seal.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source page is incomplete or out of order'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_page_update_guard
BEFORE UPDATE ON relay_container_drain_source_pages
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source pages are immutable');
END;

CREATE TRIGGER relay_container_drain_source_page_delete_guard
BEFORE DELETE ON relay_container_drain_source_pages
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source pages are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_shard_insert_guard
BEFORE INSERT ON relay_container_drain_source_shards
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_shards AS shard
    WHERE shard.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND (
        shard.shard_index = NEW.shard_index
        OR shard.shard_manifest_sha256 = NEW.shard_manifest_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source shard identity already exists'
  ) END;

  SELECT CASE WHEN NEW.sealed_at <> unixepoch()
  THEN RAISE(ABORT, 'drain source shard time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_scans AS scan
    WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND NEW.shard_index < scan.shard_count
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND NEW.shard_index = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_shards AS shard
        WHERE shard.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND NEW.shard_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
      )
      AND NEW.shard_high_watermark = COALESCE((
        SELECT MAX(member.accepted_sequence)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
      ), 0)
      AND NEW.shard_first_sequence = COALESCE((
        SELECT member.accepted_sequence
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
        ORDER BY member.accepted_sequence ASC
        LIMIT 1
      ), 0)
      AND NEW.shard_first_operation_id IS (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
        ORDER BY member.accepted_sequence ASC
        LIMIT 1
      )
      AND NEW.shard_last_sequence = COALESCE((
        SELECT member.accepted_sequence
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
        ORDER BY member.accepted_sequence DESC
        LIMIT 1
      ), 0)
      AND NEW.shard_last_operation_id IS (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
          AND member.shard_index = NEW.shard_index
        ORDER BY member.accepted_sequence DESC
        LIMIT 1
      )
      AND NEW.sealed_at >= scan.started_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_seals AS seal
        WHERE seal.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source shard manifest does not match its members'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_shard_update_guard
BEFORE UPDATE ON relay_container_drain_source_shards
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source shard manifests are immutable');
END;

CREATE TRIGGER relay_container_drain_source_shard_delete_guard
BEFORE DELETE ON relay_container_drain_source_shards
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source shard manifests are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_seal_insert_guard
BEFORE INSERT ON relay_container_drain_source_seals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_seals AS seal
    WHERE seal.source_seal_id_sha256 = NEW.source_seal_id_sha256
       OR seal.source_scan_id_sha256 = NEW.source_scan_id_sha256
       OR seal.accepted_bookmark_sha256 = NEW.accepted_bookmark_sha256
       OR seal.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
       OR seal.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
       OR seal.seal_digest_sha256 = NEW.seal_digest_sha256
  ) THEN RAISE(
    ABORT,
    'drain source seal identity already exists'
  ) END;

  SELECT CASE WHEN NEW.sealed_at <> unixepoch()
  THEN RAISE(ABORT, 'drain source seal time must come from D1') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql'
    )
  ) <> 5
  THEN RAISE(
    ABORT,
    'drain source seal requires the complete 0067 through 0071 chain'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_scans AS scan
    JOIN relay_container_admission_scope_heads AS head
      ON head.environment = scan.environment
     AND head.scope_kind = scan.scope_kind
     AND head.scope_id_sha256 = scan.scope_id_sha256
     AND head.current_fence_id_sha256 =
           scan.admission_fence_id_sha256
     AND head.current_fence_generation = scan.fence_generation
     AND head.head_version = scan.expected_head_version
     AND head.head_digest_sha256 =
           scan.expected_head_digest_sha256
    JOIN relay_container_admission_fences AS fence
      ON fence.admission_fence_id_sha256 =
           scan.admission_fence_id_sha256
     AND fence.environment = scan.environment
     AND fence.scope_kind = scan.scope_kind
     AND fence.scope_id_sha256 = scan.scope_id_sha256
     AND fence.fence_generation = scan.fence_generation
     AND fence.admission_open = 1
     AND fence.state_digest_sha256 =
           scan.expected_fence_state_digest_sha256
    WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND NEW.sealed_at >= scan.started_at
      AND scan.captured_high_watermark = COALESCE((
        SELECT MAX(commit_row.accepted_sequence)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      ), 0)
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      )
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND scan.captured_first_sequence = COALESCE((
        SELECT MIN(member.accepted_sequence)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      ), 0)
      AND scan.captured_first_operation_id IS (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
        ORDER BY member.accepted_sequence ASC
        LIMIT 1
      )
      AND scan.captured_last_sequence = COALESCE((
        SELECT MAX(member.accepted_sequence)
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      ), 0)
      AND scan.captured_last_operation_id IS (
        SELECT member.operation_id
        FROM relay_container_drain_source_members AS member
        WHERE member.source_scan_id_sha256 =
                scan.source_scan_id_sha256
        ORDER BY member.accepted_sequence DESC
        LIMIT 1
      )
      AND NEW.page_count = (
        scan.captured_member_count + scan.page_size - 1
      ) / scan.page_size
      AND NEW.page_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND scan.captured_member_count = (
        SELECT COALESCE(SUM(page.page_member_count), 0)
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND NEW.first_page_digest_sha256 IS (
        SELECT page.page_digest_sha256
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                scan.source_scan_id_sha256
        ORDER BY page.page_ordinal ASC
        LIMIT 1
      )
      AND NEW.last_page_digest_sha256 IS (
        SELECT page.page_digest_sha256
        FROM relay_container_drain_source_pages AS page
        WHERE page.source_scan_id_sha256 =
                scan.source_scan_id_sha256
        ORDER BY page.page_ordinal DESC
        LIMIT 1
      )
      AND scan.shard_count = (
        SELECT COUNT(*)
        FROM relay_container_drain_source_shards AS shard
        WHERE shard.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND scan.captured_member_count = (
        SELECT COALESCE(SUM(shard.shard_member_count), 0)
        FROM relay_container_drain_source_shards AS shard
        WHERE shard.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_seals AS seal
        WHERE seal.source_scan_id_sha256 =
                scan.source_scan_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source seal is incomplete, stale, or detached'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_seal_update_guard
BEFORE UPDATE ON relay_container_drain_source_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source seals are immutable');
END;

CREATE TRIGGER relay_container_drain_source_seal_delete_guard
BEFORE DELETE ON relay_container_drain_source_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source seals are append-preserved');
END;

CREATE TRIGGER relay_container_drain_close_command_source_seal_guard
BEFORE INSERT ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_seals AS seal
    JOIN relay_container_drain_source_scans AS scan
      ON scan.source_scan_id_sha256 = seal.source_scan_id_sha256
    WHERE scan.environment = NEW.environment
      AND scan.scope_kind = NEW.scope_kind
      AND scan.scope_id_sha256 = NEW.scope_id_sha256
      AND scan.admission_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND scan.fence_generation = NEW.fence_generation
      AND scan.expected_fence_state_digest_sha256 =
            NEW.expected_fence_state_digest_sha256
      AND scan.expected_head_version = NEW.expected_head_version
      AND scan.expected_head_digest_sha256 =
            NEW.expected_head_digest_sha256
      AND scan.captured_high_watermark =
            NEW.accepted_high_watermark
      AND scan.captured_member_count = NEW.accepted_member_count
      AND scan.captured_first_sequence =
            NEW.accepted_first_sequence
      AND scan.captured_first_operation_id IS
            NEW.accepted_first_operation_id
      AND scan.captured_last_sequence = NEW.accepted_last_sequence
      AND scan.captured_last_operation_id IS
            NEW.accepted_last_operation_id
      AND scan.shard_count = NEW.shard_count
      AND seal.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND seal.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND seal.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND seal.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
      AND scan.captured_high_watermark = COALESCE((
        SELECT MAX(commit_row.accepted_sequence)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      ), 0)
      AND scan.captured_member_count = (
        SELECT COUNT(*)
        FROM relay_container_admission_commits AS commit_row
        WHERE commit_row.scope_kind = scan.scope_kind
          AND commit_row.scope_id_sha256 = scan.scope_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain close command requires an exact sealed accepted source'
  ) END;
END;
