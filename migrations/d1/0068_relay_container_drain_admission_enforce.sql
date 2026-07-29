-- Enforce one D1-linearized admission fence for the global Container scope.
--
-- This migration deliberately closes every pre-0068 atomic-admission writer:
-- a new 0050 receipt is valid only when the same transaction first appends a
-- fence-bound admission commit. Historical 0050 receipts are preserved and
-- deterministically backfilled into the accepted-sequence ledger.
--
-- Apply only after compatible readers and writers are deployed, every old
-- writer is inventoried and drained, and backup/Time Travel evidence exists.

ALTER TABLE relay_container_drain_campaigns
ADD COLUMN accepted_source_schema_sha256 TEXT
  CHECK (
    accepted_source_schema_sha256 IS NULL
    OR (
      typeof(accepted_source_schema_sha256) = 'text'
      AND length(accepted_source_schema_sha256) = 64
      AND accepted_source_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE relay_container_drain_campaigns
ADD COLUMN accepted_source_readback_sha256 TEXT
  CHECK (
    accepted_source_readback_sha256 IS NULL
    OR (
      typeof(accepted_source_readback_sha256) = 'text'
      AND length(accepted_source_readback_sha256) = 64
      AND accepted_source_readback_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE TABLE relay_container_admission_fences (
  admission_fence_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(admission_fence_id_sha256) = 'text'
      AND length(admission_fence_id_sha256) = 64
      AND admission_fence_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  fence_contract TEXT NOT NULL
    CHECK (fence_contract = 'relay-container-admission-fence-v1'),
  fence_kind TEXT NOT NULL
    CHECK (fence_kind = 'admission'),
  environment TEXT NOT NULL
    CHECK (environment IN ('local', 'staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind = 'global'),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      scope_id_sha256 =
        '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    ),
  fence_generation INTEGER NOT NULL
    CHECK (typeof(fence_generation) = 'integer' AND fence_generation > 0),
  admission_open INTEGER NOT NULL
    CHECK (typeof(admission_open) = 'integer' AND admission_open IN (0, 1)),
  cutoff_at INTEGER
    CHECK (
      cutoff_at IS NULL
      OR (typeof(cutoff_at) = 'integer' AND cutoff_at > 0)
    ),
  accepted_high_watermark INTEGER
    CHECK (
      accepted_high_watermark IS NULL
      OR (
        typeof(accepted_high_watermark) = 'integer'
        AND accepted_high_watermark >= 0
      )
    ),
  accepted_bookmark_sha256 TEXT
    CHECK (
      accepted_bookmark_sha256 IS NULL
      OR (
        typeof(accepted_bookmark_sha256) = 'text'
        AND length(accepted_bookmark_sha256) = 64
        AND accepted_bookmark_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  accepted_member_count INTEGER
    CHECK (
      accepted_member_count IS NULL
      OR (
        typeof(accepted_member_count) = 'integer'
        AND accepted_member_count >= 0
      )
    ),
  accepted_set_manifest_sha256 TEXT
    CHECK (
      accepted_set_manifest_sha256 IS NULL
      OR (
        typeof(accepted_set_manifest_sha256) = 'text'
        AND length(accepted_set_manifest_sha256) = 64
        AND accepted_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  accepted_first_sequence INTEGER
    CHECK (
      accepted_first_sequence IS NULL
      OR (
        typeof(accepted_first_sequence) = 'integer'
        AND accepted_first_sequence >= 0
      )
    ),
  accepted_first_operation_id TEXT,
  accepted_last_sequence INTEGER
    CHECK (
      accepted_last_sequence IS NULL
      OR (
        typeof(accepted_last_sequence) = 'integer'
        AND accepted_last_sequence >= 0
      )
    ),
  accepted_last_operation_id TEXT,
  accepted_source_schema_sha256 TEXT
    CHECK (
      accepted_source_schema_sha256 IS NULL
      OR (
        typeof(accepted_source_schema_sha256) = 'text'
        AND length(accepted_source_schema_sha256) = 64
        AND accepted_source_schema_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  accepted_source_readback_sha256 TEXT
    CHECK (
      accepted_source_readback_sha256 IS NULL
      OR (
        typeof(accepted_source_readback_sha256) = 'text'
        AND length(accepted_source_readback_sha256) = 64
        AND accepted_source_readback_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  closed_campaign_id TEXT,
  state_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(state_digest_sha256) = 'text'
      AND length(state_digest_sha256) = 64
      AND state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(created_by_admin_id) = 'integer'
      AND created_by_admin_id > 0
    ),
  closed_by_admin_id INTEGER
    CHECK (
      closed_by_admin_id IS NULL
      OR (
        typeof(closed_by_admin_id) = 'integer'
        AND closed_by_admin_id > 0
      )
    ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  closed_at INTEGER
    CHECK (
      closed_at IS NULL
      OR (typeof(closed_at) = 'integer' AND closed_at >= created_at)
    ),
  UNIQUE (environment, scope_kind, scope_id_sha256, fence_generation),
  UNIQUE (closed_campaign_id),
  FOREIGN KEY (closed_campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (
      admission_open = 1
      AND fence_kind = 'admission'
      AND cutoff_at IS NULL
      AND accepted_high_watermark IS NULL
      AND accepted_bookmark_sha256 IS NULL
      AND accepted_member_count IS NULL
      AND accepted_set_manifest_sha256 IS NULL
      AND accepted_first_sequence IS NULL
      AND accepted_first_operation_id IS NULL
      AND accepted_last_sequence IS NULL
      AND accepted_last_operation_id IS NULL
      AND accepted_source_schema_sha256 IS NULL
      AND accepted_source_readback_sha256 IS NULL
      AND closed_campaign_id IS NULL
      AND closed_by_admin_id IS NULL
      AND closed_at IS NULL
    )
    OR
    (
      admission_open = 0
      AND cutoff_at IS NOT NULL
      AND accepted_high_watermark IS NOT NULL
      AND accepted_bookmark_sha256 IS NOT NULL
      AND accepted_member_count IS NOT NULL
      AND accepted_set_manifest_sha256 IS NOT NULL
      AND accepted_first_sequence IS NOT NULL
      AND accepted_last_sequence IS NOT NULL
      AND accepted_source_schema_sha256 IS NOT NULL
      AND accepted_source_readback_sha256 IS NOT NULL
      AND closed_campaign_id IS NOT NULL
      AND closed_by_admin_id IS NOT NULL
      AND closed_at IS NOT NULL
      AND cutoff_at = closed_at
      AND (
        (
          accepted_member_count = 0
          AND accepted_high_watermark = 0
          AND accepted_first_sequence = 0
          AND accepted_first_operation_id IS NULL
          AND accepted_last_sequence = 0
          AND accepted_last_operation_id IS NULL
        )
        OR
        (
          accepted_member_count > 0
          AND accepted_high_watermark > 0
          AND accepted_first_sequence > 0
          AND accepted_first_operation_id IS NOT NULL
          AND length(accepted_first_operation_id) BETWEEN 1 AND 128
          AND accepted_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          AND accepted_last_sequence >= accepted_first_sequence
          AND accepted_last_sequence <= accepted_high_watermark
          AND accepted_last_operation_id IS NOT NULL
          AND length(accepted_last_operation_id) BETWEEN 1 AND 128
          AND accepted_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      )
    )
  )
);

CREATE TABLE relay_container_admission_scope_heads (
  environment TEXT NOT NULL
    CHECK (environment IN ('local', 'staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind = 'global'),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      scope_id_sha256 =
        '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    ),
  current_fence_id_sha256 TEXT NOT NULL,
  current_fence_generation INTEGER NOT NULL
    CHECK (
      typeof(current_fence_generation) = 'integer'
      AND current_fence_generation > 0
    ),
  head_version INTEGER NOT NULL
    CHECK (typeof(head_version) = 'integer' AND head_version > 0),
  head_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(head_digest_sha256) = 'text'
      AND length(head_digest_sha256) = 64
      AND head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  updated_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(updated_by_admin_id) = 'integer'
      AND updated_by_admin_id > 0
    ),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  PRIMARY KEY (environment, scope_kind, scope_id_sha256),
  UNIQUE (current_fence_id_sha256),
  FOREIGN KEY (current_fence_id_sha256)
    REFERENCES relay_container_admission_fences(admission_fence_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TABLE relay_container_admission_commits (
  accepted_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  source_contract TEXT NOT NULL
    CHECK (
      source_contract IN (
        'pre-0068-atomic-admission-v1',
        'fenced-atomic-admission-v1'
      )
    ),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind = 'global'),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      scope_id_sha256 =
        '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    ),
  admission_fence_id_sha256 TEXT,
  fence_generation INTEGER NOT NULL
    CHECK (typeof(fence_generation) = 'integer' AND fence_generation >= 0),
  reservation_key TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,
  atomic_admission_sha256 TEXT NOT NULL UNIQUE,
  operation_admission_sha256 TEXT NOT NULL,
  billing_snapshot_sha256 TEXT NOT NULL,
  client_request_sha256 TEXT NOT NULL,
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  shard_count INTEGER NOT NULL
    CHECK (typeof(shard_count) = 'integer' AND shard_count BETWEEN 1 AND 1024),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  admission_commit_sha256 TEXT NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(committed_at) = 'integer' AND committed_at > 0),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_container_atomic_admissions(reservation_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (admission_fence_id_sha256)
    REFERENCES relay_container_admission_fences(admission_fence_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    typeof(reservation_key) = 'text'
    AND length(reservation_key) BETWEEN 1 AND 128
    AND substr(reservation_key, 1, 1) GLOB '[A-Za-z0-9]'
    AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND typeof(operation_id) = 'text'
    AND length(operation_id) BETWEEN 1 AND 128
    AND substr(operation_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND reservation_key = operation_id
    AND length(atomic_admission_sha256) = 64
    AND atomic_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_admission_sha256) = 64
    AND operation_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(billing_snapshot_sha256) = 64
    AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(client_request_sha256) = 64
    AND client_request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(admission_commit_sha256) = 64
    AND admission_commit_sha256 NOT GLOB '*[^0-9a-f]*'
    AND shard_index < shard_count
  ),
  CHECK (
    (
      source_contract = 'pre-0068-atomic-admission-v1'
      AND admission_fence_id_sha256 IS NULL
      AND fence_generation = 0
      AND admission_commit_sha256 = atomic_admission_sha256
    )
    OR
    (
      source_contract = 'fenced-atomic-admission-v1'
      AND admission_fence_id_sha256 IS NOT NULL
      AND length(admission_fence_id_sha256) = 64
      AND admission_fence_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND fence_generation > 0
    )
  )
);

CREATE UNIQUE INDEX idx_relay_container_admission_open_scope
  ON relay_container_admission_fences(
    environment,
    scope_kind,
    scope_id_sha256
  )
  WHERE admission_open = 1;

CREATE INDEX idx_relay_container_admission_fence_generation
  ON relay_container_admission_fences(
    environment,
    scope_kind,
    scope_id_sha256,
    fence_generation
  );

CREATE INDEX idx_relay_container_admission_commits_scope
  ON relay_container_admission_commits(
    scope_kind,
    scope_id_sha256,
    accepted_sequence
  );

INSERT INTO relay_container_admission_commits (
  accepted_sequence,
  source_contract,
  scope_kind,
  scope_id_sha256,
  admission_fence_id_sha256,
  fence_generation,
  reservation_key,
  operation_id,
  atomic_admission_sha256,
  operation_admission_sha256,
  billing_snapshot_sha256,
  client_request_sha256,
  owner_generation,
  ring_generation,
  shard_count,
  shard_index,
  admission_commit_sha256,
  committed_at
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY admission.created_at, admission.operation_id
  ),
  'pre-0068-atomic-admission-v1',
  'global',
  '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251',
  NULL,
  0,
  admission.reservation_key,
  admission.operation_id,
  admission.atomic_admission_sha256,
  admission.operation_admission_sha256,
  admission.billing_snapshot_sha256,
  admission.client_request_sha256,
  admission.owner_generation,
  operation.ring_generation,
  operation.shard_count,
  operation.shard_index,
  admission.atomic_admission_sha256,
  admission.created_at
FROM relay_container_atomic_admissions AS admission
JOIN relay_container_operations AS operation
  ON operation.operation_id = admission.operation_id
ORDER BY admission.created_at, admission.operation_id;

CREATE TRIGGER relay_container_admission_fence_insert_guard
BEFORE INSERT ON relay_container_admission_fences
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'admission fence time must come from D1') END;

  SELECT CASE WHEN
    NEW.fence_kind <> 'admission'
    OR NEW.fence_generation <> 1
    OR NEW.admission_open <> 1
    OR EXISTS (
      SELECT 1
      FROM relay_container_admission_fences AS fence
    )
  THEN RAISE(ABORT, 'admission fence generation is invalid') END;
END;

CREATE TRIGGER relay_container_admission_fence_update_guard
BEFORE UPDATE ON relay_container_admission_fences
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_admission_scope_heads AS head
    WHERE head.environment = OLD.environment
      AND head.scope_kind = OLD.scope_kind
      AND head.scope_id_sha256 = OLD.scope_id_sha256
      AND head.current_fence_id_sha256 =
            OLD.admission_fence_id_sha256
      AND head.current_fence_generation = OLD.fence_generation
  )
  THEN RAISE(ABORT, 'admission fence close requires current scope head') END;

  SELECT CASE WHEN
    OLD.fence_kind <> 'admission'
    OR OLD.admission_open <> 1
    OR NEW.admission_open <> 0
    OR NEW.admission_fence_id_sha256 IS NOT OLD.admission_fence_id_sha256
    OR NEW.contract_version IS NOT OLD.contract_version
    OR NEW.fence_contract IS NOT OLD.fence_contract
    OR NEW.fence_kind IS NOT OLD.fence_kind
    OR NEW.environment IS NOT OLD.environment
    OR NEW.scope_kind IS NOT OLD.scope_kind
    OR NEW.scope_id_sha256 IS NOT OLD.scope_id_sha256
    OR NEW.fence_generation IS NOT OLD.fence_generation
    OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.closed_at <> unixepoch()
    OR NEW.cutoff_at IS NOT NEW.closed_at
    OR NEW.accepted_high_watermark IS NOT COALESCE((
      SELECT MAX(commit_row.accepted_sequence)
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
    ), 0)
    OR NEW.accepted_member_count IS NOT (
      SELECT COUNT(*)
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <= NEW.accepted_high_watermark
    )
    OR NEW.accepted_first_sequence IS NOT COALESCE((
      SELECT commit_row.accepted_sequence
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <= NEW.accepted_high_watermark
      ORDER BY commit_row.accepted_sequence ASC
      LIMIT 1
    ), 0)
    OR NEW.accepted_first_operation_id IS NOT (
      SELECT commit_row.operation_id
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <= NEW.accepted_high_watermark
      ORDER BY commit_row.accepted_sequence ASC
      LIMIT 1
    )
    OR NEW.accepted_last_sequence IS NOT COALESCE((
      SELECT commit_row.accepted_sequence
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <= NEW.accepted_high_watermark
      ORDER BY commit_row.accepted_sequence DESC
      LIMIT 1
    ), 0)
    OR NEW.accepted_last_operation_id IS NOT (
      SELECT commit_row.operation_id
      FROM relay_container_admission_commits AS commit_row
      WHERE commit_row.scope_kind = NEW.scope_kind
        AND commit_row.scope_id_sha256 = NEW.scope_id_sha256
        AND commit_row.accepted_sequence <= NEW.accepted_high_watermark
      ORDER BY commit_row.accepted_sequence DESC
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_operations AS operation
      LEFT JOIN relay_container_admission_commits AS commit_row
        ON commit_row.reservation_key = operation.reservation_key
       AND commit_row.operation_id = operation.operation_id
      WHERE operation.status IN (
        'prepared',
        'dispatched',
        'recovery_required'
      )
        AND commit_row.accepted_sequence IS NULL
    )
  THEN RAISE(ABORT, 'admission fence close is not linearizable') END;
END;

CREATE TRIGGER relay_container_admission_fence_delete_guard
BEFORE DELETE ON relay_container_admission_fences
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'admission fences are append-preserved');
END;

CREATE TRIGGER relay_container_admission_scope_head_insert_guard
BEFORE INSERT ON relay_container_admission_scope_heads
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.updated_at <> unixepoch()
  THEN RAISE(ABORT, 'admission scope head time must come from D1') END;

  SELECT CASE WHEN
    NEW.current_fence_generation <> 1
    OR NEW.head_version <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM relay_container_admission_fences AS fence
      WHERE fence.admission_fence_id_sha256 =
              NEW.current_fence_id_sha256
        AND fence.environment = NEW.environment
        AND fence.scope_kind = NEW.scope_kind
        AND fence.scope_id_sha256 = NEW.scope_id_sha256
        AND fence.fence_generation = NEW.current_fence_generation
        AND fence.fence_kind = 'admission'
        AND fence.admission_open = 1
    )
  THEN RAISE(ABORT, 'admission scope head does not name the open fence') END;
END;

CREATE TRIGGER relay_container_admission_scope_head_update_guard
BEFORE UPDATE ON relay_container_admission_scope_heads
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'admission scope head is immutable under 0068');
END;

CREATE TRIGGER relay_container_admission_scope_head_delete_guard
BEFORE DELETE ON relay_container_admission_scope_heads
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'admission scope heads are append-preserved');
END;

CREATE TRIGGER relay_container_admission_commit_insert_guard
BEFORE INSERT ON relay_container_admission_commits
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    NEW.source_contract <> 'fenced-atomic-admission-v1'
    OR NEW.committed_at <> unixepoch()
    OR NOT EXISTS (
      SELECT 1
      FROM relay_container_admission_scope_heads AS head
      JOIN relay_container_admission_fences AS fence
        ON fence.admission_fence_id_sha256 =
             head.current_fence_id_sha256
      WHERE head.scope_kind = NEW.scope_kind
        AND head.scope_id_sha256 = NEW.scope_id_sha256
        AND head.current_fence_id_sha256 =
              NEW.admission_fence_id_sha256
        AND head.current_fence_generation = NEW.fence_generation
        AND fence.fence_generation = NEW.fence_generation
        AND fence.admission_open = 1
    )
  THEN RAISE(ABORT, 'relay container admission fence is closed or stale') END;
END;

CREATE TRIGGER relay_container_admission_commit_update_guard
BEFORE UPDATE ON relay_container_admission_commits
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container admission commits are immutable');
END;

CREATE TRIGGER relay_container_admission_commit_delete_guard
BEFORE DELETE ON relay_container_admission_commits
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container admission commits are append-preserved');
END;

CREATE TRIGGER relay_container_atomic_admission_fence_guard
BEFORE INSERT ON relay_container_atomic_admissions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_admission_commits AS commit_row
  JOIN relay_container_admission_fences AS fence
    ON fence.admission_fence_id_sha256 =
         commit_row.admission_fence_id_sha256
  JOIN relay_container_admission_scope_heads AS head
    ON head.current_fence_id_sha256 =
         commit_row.admission_fence_id_sha256
   AND head.current_fence_generation = commit_row.fence_generation
  WHERE commit_row.source_contract = 'fenced-atomic-admission-v1'
    AND commit_row.reservation_key = NEW.reservation_key
    AND commit_row.operation_id = NEW.operation_id
    AND commit_row.atomic_admission_sha256 = NEW.atomic_admission_sha256
    AND commit_row.operation_admission_sha256 =
          NEW.operation_admission_sha256
    AND commit_row.billing_snapshot_sha256 =
          NEW.billing_snapshot_sha256
    AND commit_row.client_request_sha256 = NEW.client_request_sha256
    AND commit_row.owner_generation = NEW.owner_generation
    AND fence.admission_open = 1
)
BEGIN
  SELECT RAISE(ABORT, 'relay container atomic admission lacks an open D1 fence');
END;

CREATE TRIGGER relay_container_operation_admission_fence_guard
BEFORE INSERT ON relay_container_operations
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_admission_commits AS commit_row
    JOIN relay_container_admission_fences AS fence
      ON fence.admission_fence_id_sha256 =
           commit_row.admission_fence_id_sha256
    JOIN relay_container_admission_scope_heads AS head
      ON head.current_fence_id_sha256 =
           commit_row.admission_fence_id_sha256
     AND head.current_fence_generation = commit_row.fence_generation
    WHERE commit_row.source_contract = 'fenced-atomic-admission-v1'
      AND commit_row.reservation_key = NEW.reservation_key
      AND commit_row.operation_id = NEW.operation_id
      AND commit_row.operation_admission_sha256 = NEW.admission_sha256
      AND commit_row.owner_generation = NEW.owner_generation
      AND commit_row.ring_generation = NEW.ring_generation
      AND commit_row.shard_count = NEW.shard_count
      AND commit_row.shard_index = NEW.shard_index
      AND fence.admission_open = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container operation lacks an open D1 fence');
END;

CREATE TRIGGER relay_container_drain_campaign_admission_fence_guard
BEFORE INSERT ON relay_container_drain_campaigns
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_admission_scope_heads AS head
  JOIN relay_container_admission_fences AS fence
    ON fence.admission_fence_id_sha256 =
         head.current_fence_id_sha256
  WHERE head.environment = NEW.environment
    AND head.scope_kind = NEW.scope_kind
    AND head.scope_id_sha256 = NEW.scope_id_sha256
    AND head.current_fence_id_sha256 =
          NEW.admission_fence_id_sha256
    AND head.current_fence_generation = NEW.fence_generation
    AND fence.fence_generation = NEW.fence_generation
    AND fence.admission_open = 0
    AND fence.closed_campaign_id = NEW.campaign_id
    AND fence.closed_by_admin_id = NEW.created_by_admin_id
    AND fence.closed_at <= NEW.created_at
    AND fence.cutoff_at = NEW.cutoff_at
    AND fence.accepted_high_watermark = NEW.accepted_high_watermark
    AND fence.accepted_bookmark_sha256 = NEW.accepted_bookmark_sha256
    AND fence.accepted_member_count = NEW.accepted_member_count
    AND fence.accepted_set_manifest_sha256 =
          NEW.accepted_set_manifest_sha256
    AND fence.accepted_first_sequence = NEW.accepted_first_sequence
    AND fence.accepted_first_operation_id IS
          NEW.accepted_first_operation_id
    AND fence.accepted_last_sequence = NEW.accepted_last_sequence
    AND fence.accepted_last_operation_id IS
          NEW.accepted_last_operation_id
    AND fence.accepted_source_schema_sha256 =
          NEW.accepted_source_schema_sha256
    AND fence.accepted_source_readback_sha256 =
          NEW.accepted_source_readback_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'drain campaign does not match the closed admission fence');
END;

CREATE TRIGGER relay_container_drain_campaign_source_identity_update_guard
BEFORE UPDATE ON relay_container_drain_campaigns
FOR EACH ROW
WHEN
  NEW.accepted_source_schema_sha256 IS NOT
    OLD.accepted_source_schema_sha256
  OR NEW.accepted_source_readback_sha256 IS NOT
    OLD.accepted_source_readback_sha256
BEGIN
  SELECT RAISE(ABORT, 'drain campaign source identity is immutable');
END;
