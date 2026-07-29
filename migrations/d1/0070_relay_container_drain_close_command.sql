-- Provide one D1 statement boundary for closing the current admission fence
-- and creating the matching accepted-work drain campaign.
--
-- The only supported close primitive after this migration is an insert into
-- relay_container_drain_close_commands. Its apply trigger performs both
-- mutations before the outer INSERT statement can commit. This migration
-- adds no route, credential, write gate, traffic authority, or reopen path.

CREATE TABLE relay_container_drain_close_commands (
  close_command_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(close_command_id_sha256) = 'text'
      AND length(close_command_id_sha256) = 64
      AND close_command_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  command_contract TEXT NOT NULL
    CHECK (
      command_contract = 'relay-container-drain-close-command-v1'
    ),
  command_migration TEXT NOT NULL
    CHECK (
      command_migration =
        '0070_relay_container_drain_close_command.sql'
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
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(accepted_high_watermark) = 'integer'
      AND accepted_high_watermark >= 0
    ),
  accepted_bookmark_sha256 TEXT NOT NULL
    CHECK (
      typeof(accepted_bookmark_sha256) = 'text'
      AND length(accepted_bookmark_sha256) = 64
      AND accepted_bookmark_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_member_count INTEGER NOT NULL
    CHECK (
      typeof(accepted_member_count) = 'integer'
      AND accepted_member_count >= 0
    ),
  accepted_set_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(accepted_set_manifest_sha256) = 'text'
      AND length(accepted_set_manifest_sha256) = 64
      AND accepted_set_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_first_sequence INTEGER NOT NULL
    CHECK (
      typeof(accepted_first_sequence) = 'integer'
      AND accepted_first_sequence >= 0
    ),
  accepted_first_operation_id TEXT,
  accepted_last_sequence INTEGER NOT NULL
    CHECK (
      typeof(accepted_last_sequence) = 'integer'
      AND accepted_last_sequence >= 0
    ),
  accepted_last_operation_id TEXT,
  accepted_source_schema_sha256 TEXT NOT NULL
    CHECK (
      typeof(accepted_source_schema_sha256) = 'text'
      AND length(accepted_source_schema_sha256) = 64
      AND accepted_source_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_source_readback_sha256 TEXT NOT NULL
    CHECK (
      typeof(accepted_source_readback_sha256) = 'text'
      AND length(accepted_source_readback_sha256) = 64
      AND accepted_source_readback_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  closed_fence_state_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(closed_fence_state_digest_sha256) = 'text'
      AND length(closed_fence_state_digest_sha256) = 64
      AND closed_fence_state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  controller_service_name TEXT NOT NULL
    CHECK (
      typeof(controller_service_name) = 'text'
      AND length(controller_service_name) BETWEEN 1 AND 128
      AND substr(controller_service_name, 1, 1) GLOB '[a-z0-9]'
      AND substr(controller_service_name, -1, 1) GLOB '[a-z0-9]'
      AND controller_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  shard_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(shard_inventory_sha256) = 'text'
      AND length(shard_inventory_sha256) = 64
      AND shard_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  edge_version_set_sha256 TEXT NOT NULL
    CHECK (
      typeof(edge_version_set_sha256) = 'text'
      AND length(edge_version_set_sha256) = 64
      AND edge_version_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  configuration_sha256 TEXT NOT NULL
    CHECK (
      typeof(configuration_sha256) = 'text'
      AND length(configuration_sha256) = 64
      AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reverse_sync_snapshot_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(reverse_sync_snapshot_id_sha256) = 'text'
      AND length(reverse_sync_snapshot_id_sha256) = 64
      AND reverse_sync_snapshot_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reverse_sync_source_schema_sha256 TEXT NOT NULL
    CHECK (
      typeof(reverse_sync_source_schema_sha256) = 'text'
      AND length(reverse_sync_source_schema_sha256) = 64
      AND reverse_sync_source_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reverse_sync_target_schema_sha256 TEXT NOT NULL
    CHECK (
      typeof(reverse_sync_target_schema_sha256) = 'text'
      AND length(reverse_sync_target_schema_sha256) = 64
      AND reverse_sync_target_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stability_window_seconds INTEGER NOT NULL
    CHECK (
      typeof(stability_window_seconds) = 'integer'
      AND stability_window_seconds BETWEEN 60 AND 86400
    ),
  campaign_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  requested_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(requested_by_admin_id) = 'integer'
      AND requested_by_admin_id > 0
    ),
  command_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(command_digest_sha256) = 'text'
      AND length(command_digest_sha256) = 64
      AND command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
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
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (
      accepted_member_count = 0
      AND accepted_high_watermark = 0
      AND accepted_first_sequence = 0
      AND accepted_first_operation_id IS NULL
      AND accepted_last_sequence = 0
      AND accepted_last_operation_id IS NULL
    )
    OR (
      accepted_member_count > 0
      AND accepted_high_watermark > 0
      AND accepted_first_sequence > 0
      AND accepted_first_operation_id IS NOT NULL
      AND length(accepted_first_operation_id) BETWEEN 1 AND 128
      AND substr(accepted_first_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND accepted_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND accepted_last_sequence >= accepted_first_sequence
      AND accepted_last_sequence <= accepted_high_watermark
      AND accepted_last_operation_id IS NOT NULL
      AND length(accepted_last_operation_id) BETWEEN 1 AND 128
      AND substr(accepted_last_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND accepted_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  CHECK (
    close_command_id_sha256 <> command_digest_sha256
    AND admission_fence_id_sha256 <> campaign_id
    AND expected_fence_state_digest_sha256 <>
          closed_fence_state_digest_sha256
  )
);

CREATE UNIQUE INDEX idx_relay_container_drain_close_command_campaign
  ON relay_container_drain_close_commands(campaign_id);

CREATE UNIQUE INDEX idx_relay_container_drain_close_command_fence
  ON relay_container_drain_close_commands(admission_fence_id_sha256);

CREATE UNIQUE INDEX idx_relay_container_drain_close_command_digest
  ON relay_container_drain_close_commands(command_digest_sha256);

CREATE INDEX idx_relay_container_drain_close_command_audit
  ON relay_container_drain_close_commands(
    environment,
    created_at,
    close_command_id_sha256
  );

CREATE TRIGGER relay_container_drain_close_command_insert_guard
BEFORE INSERT ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'drain close command time must come from D1') END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql'
    )
  ) <> 4
  THEN RAISE(
    ABORT,
    'drain close command requires the complete 0067 through 0070 chain'
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
      AND fence.closed_campaign_id IS NULL
      AND fence.closed_by_admin_id IS NULL
      AND fence.closed_at IS NULL
      AND fence.created_at <= NEW.created_at
  ) THEN RAISE(
    ABORT,
    'drain close command lost the current admission fence'
  ) END;

  SELECT CASE WHEN
    NEW.accepted_high_watermark IS NOT COALESCE((
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
  THEN RAISE(
    ABORT,
    'drain close command accepted boundary is stale'
  ) END;

  SELECT CASE WHEN EXISTS (
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
  ) THEN RAISE(
    ABORT,
    'drain close command found an uncommitted open operation'
  ) END;
END;

CREATE TRIGGER relay_container_admission_fence_close_command_guard
BEFORE UPDATE ON relay_container_admission_fences
FOR EACH ROW
WHEN OLD.admission_open = 1 AND NEW.admission_open = 0
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_close_commands AS command
    JOIN relay_container_admission_scope_heads AS head
      ON head.environment = command.environment
     AND head.scope_kind = command.scope_kind
     AND head.scope_id_sha256 = command.scope_id_sha256
    WHERE command.environment = OLD.environment
      AND command.scope_kind = OLD.scope_kind
      AND command.scope_id_sha256 = OLD.scope_id_sha256
      AND command.admission_fence_id_sha256 =
            OLD.admission_fence_id_sha256
      AND command.fence_generation = OLD.fence_generation
      AND command.expected_fence_state_digest_sha256 =
            OLD.state_digest_sha256
      AND command.expected_head_version = head.head_version
      AND command.expected_head_digest_sha256 =
            head.head_digest_sha256
      AND command.campaign_id = NEW.closed_campaign_id
      AND command.accepted_high_watermark =
            NEW.accepted_high_watermark
      AND command.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND command.accepted_member_count = NEW.accepted_member_count
      AND command.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND command.accepted_first_sequence =
            NEW.accepted_first_sequence
      AND command.accepted_first_operation_id IS
            NEW.accepted_first_operation_id
      AND command.accepted_last_sequence =
            NEW.accepted_last_sequence
      AND command.accepted_last_operation_id IS
            NEW.accepted_last_operation_id
      AND command.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND command.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
      AND command.closed_fence_state_digest_sha256 =
            NEW.state_digest_sha256
      AND command.requested_by_admin_id = NEW.closed_by_admin_id
      AND command.created_at = NEW.closed_at
      AND command.created_at = NEW.cutoff_at
  ) THEN RAISE(
    ABORT,
    'admission fence close requires a 0070 command'
  ) END;
END;

CREATE TRIGGER relay_container_drain_campaign_close_command_guard
BEFORE INSERT ON relay_container_drain_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_close_commands AS command
    WHERE command.campaign_id = NEW.campaign_id
      AND command.environment = NEW.environment
      AND command.scope_kind = NEW.scope_kind
      AND command.scope_id_sha256 = NEW.scope_id_sha256
      AND command.admission_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND command.fence_generation = NEW.fence_generation
      AND command.created_at = NEW.cutoff_at
      AND command.created_at = NEW.created_at
      AND command.accepted_high_watermark =
            NEW.accepted_high_watermark
      AND command.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND command.accepted_member_count = NEW.accepted_member_count
      AND command.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND command.accepted_first_sequence =
            NEW.accepted_first_sequence
      AND command.accepted_first_operation_id IS
            NEW.accepted_first_operation_id
      AND command.accepted_last_sequence =
            NEW.accepted_last_sequence
      AND command.accepted_last_operation_id IS
            NEW.accepted_last_operation_id
      AND command.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND command.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
      AND command.ring_generation = NEW.ring_generation
      AND command.controller_service_name =
            NEW.controller_service_name
      AND command.controller_version_id = NEW.controller_version_id
      AND command.shard_count = NEW.shard_count
      AND command.shard_inventory_sha256 =
            NEW.shard_inventory_sha256
      AND command.edge_version_set_sha256 =
            NEW.edge_version_set_sha256
      AND command.configuration_sha256 = NEW.configuration_sha256
      AND command.reverse_sync_snapshot_id_sha256 =
            NEW.reverse_sync_snapshot_id_sha256
      AND command.reverse_sync_source_schema_sha256 =
            NEW.reverse_sync_source_schema_sha256
      AND command.reverse_sync_target_schema_sha256 =
            NEW.reverse_sync_target_schema_sha256
      AND command.stability_window_seconds =
            NEW.stability_window_seconds
      AND command.campaign_digest_sha256 =
            NEW.campaign_digest_sha256
      AND command.requested_by_admin_id = NEW.created_by_admin_id
  ) THEN RAISE(
    ABORT,
    'drain campaign requires a 0070 close command'
  ) END;
END;

CREATE TRIGGER relay_container_drain_close_command_update_guard
BEFORE UPDATE ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain close commands are immutable');
END;

CREATE TRIGGER relay_container_drain_close_command_delete_guard
BEFORE DELETE ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain close commands are append-preserved');
END;

CREATE TRIGGER relay_container_drain_close_command_apply
AFTER INSERT ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  UPDATE relay_container_admission_fences
  SET admission_open = 0,
      cutoff_at = NEW.created_at,
      accepted_high_watermark = NEW.accepted_high_watermark,
      accepted_bookmark_sha256 = NEW.accepted_bookmark_sha256,
      accepted_member_count = NEW.accepted_member_count,
      accepted_set_manifest_sha256 = NEW.accepted_set_manifest_sha256,
      accepted_first_sequence = NEW.accepted_first_sequence,
      accepted_first_operation_id = NEW.accepted_first_operation_id,
      accepted_last_sequence = NEW.accepted_last_sequence,
      accepted_last_operation_id = NEW.accepted_last_operation_id,
      accepted_source_schema_sha256 =
        NEW.accepted_source_schema_sha256,
      accepted_source_readback_sha256 =
        NEW.accepted_source_readback_sha256,
      closed_campaign_id = NEW.campaign_id,
      state_digest_sha256 = NEW.closed_fence_state_digest_sha256,
      closed_by_admin_id = NEW.requested_by_admin_id,
      closed_at = NEW.created_at
  WHERE admission_fence_id_sha256 =
          NEW.admission_fence_id_sha256
    AND environment = NEW.environment
    AND scope_kind = NEW.scope_kind
    AND scope_id_sha256 = NEW.scope_id_sha256
    AND fence_generation = NEW.fence_generation
    AND admission_open = 1
    AND state_digest_sha256 =
          NEW.expected_fence_state_digest_sha256;

  SELECT CASE WHEN changes() <> 1
  THEN RAISE(ABORT, 'drain close command lost its fence CAS') END;

  INSERT INTO relay_container_drain_campaigns (
    campaign_id,
    contract_version,
    campaign_contract,
    environment,
    scope_kind,
    scope_id_sha256,
    fence_generation,
    admission_fence_id_sha256,
    admission_open,
    fence_enforcement_migration,
    cutoff_at,
    accepted_high_watermark,
    accepted_bookmark_sha256,
    accepted_member_count,
    accepted_set_manifest_sha256,
    accepted_first_sequence,
    accepted_first_operation_id,
    accepted_last_sequence,
    accepted_last_operation_id,
    accepted_source_schema_sha256,
    accepted_source_readback_sha256,
    drain_ledger_schema_migration,
    ring_generation,
    controller_service_name,
    controller_version_id,
    shard_count,
    shard_inventory_sha256,
    edge_version_set_sha256,
    configuration_sha256,
    reverse_sync_snapshot_id_sha256,
    reverse_sync_source_schema_sha256,
    reverse_sync_target_schema_sha256,
    stability_window_seconds,
    campaign_digest_sha256,
    state,
    state_version,
    last_event_digest_sha256,
    created_by_admin_id,
    created_at
  ) VALUES (
    NEW.campaign_id,
    1,
    'accepted-work-drain-v1',
    NEW.environment,
    NEW.scope_kind,
    NEW.scope_id_sha256,
    NEW.fence_generation,
    NEW.admission_fence_id_sha256,
    0,
    '0068_relay_container_drain_admission_enforce.sql',
    NEW.created_at,
    NEW.accepted_high_watermark,
    NEW.accepted_bookmark_sha256,
    NEW.accepted_member_count,
    NEW.accepted_set_manifest_sha256,
    NEW.accepted_first_sequence,
    NEW.accepted_first_operation_id,
    NEW.accepted_last_sequence,
    NEW.accepted_last_operation_id,
    NEW.accepted_source_schema_sha256,
    NEW.accepted_source_readback_sha256,
    '0067_relay_container_drain_expand.sql',
    NEW.ring_generation,
    NEW.controller_service_name,
    NEW.controller_version_id,
    NEW.shard_count,
    NEW.shard_inventory_sha256,
    NEW.edge_version_set_sha256,
    NEW.configuration_sha256,
    NEW.reverse_sync_snapshot_id_sha256,
    NEW.reverse_sync_source_schema_sha256,
    NEW.reverse_sync_target_schema_sha256,
    NEW.stability_window_seconds,
    NEW.campaign_digest_sha256,
    'fenced',
    0,
    NULL,
    NEW.requested_by_admin_id,
    NEW.created_at
  );

  SELECT CASE WHEN changes() <> 1
  THEN RAISE(ABORT, 'drain close command campaign insert failed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_close_commands AS command
    JOIN relay_container_admission_fences AS fence
      ON fence.admission_fence_id_sha256 =
           command.admission_fence_id_sha256
    JOIN relay_container_drain_campaigns AS campaign
      ON campaign.campaign_id = command.campaign_id
    WHERE command.close_command_id_sha256 =
            NEW.close_command_id_sha256
      AND fence.admission_open = 0
      AND fence.closed_campaign_id = command.campaign_id
      AND fence.closed_at = command.created_at
      AND campaign.admission_fence_id_sha256 =
            command.admission_fence_id_sha256
      AND campaign.cutoff_at = command.created_at
      AND campaign.created_at = command.created_at
      AND campaign.accepted_set_manifest_sha256 =
            command.accepted_set_manifest_sha256
      AND campaign.campaign_digest_sha256 =
            command.campaign_digest_sha256
  ) THEN RAISE(
    ABORT,
    'drain close command readback is inconsistent'
  ) END;
END;
