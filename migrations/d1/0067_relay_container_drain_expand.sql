-- Expand-only global accepted-work drain ledger.
--
-- This migration intentionally does not modify the admission transaction.
-- Campaign creation is database-gated on migration 0068 so an accidentally
-- enabled application flag cannot claim that admission is fenced before the
-- D1 enforcement contract exists.

CREATE TABLE relay_container_drain_campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  campaign_contract TEXT NOT NULL
    CHECK (campaign_contract = 'accepted-work-drain-v1'),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('global', 'tenant', 'group')),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(scope_id_sha256) = 'text'
      AND length(scope_id_sha256) = 64
      AND scope_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  fence_generation INTEGER NOT NULL
    CHECK (typeof(fence_generation) = 'integer' AND fence_generation > 0),
  admission_fence_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_fence_id_sha256) = 'text'
      AND length(admission_fence_id_sha256) = 64
      AND admission_fence_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admission_open INTEGER NOT NULL
    CHECK (typeof(admission_open) = 'integer' AND admission_open = 0),
  fence_enforcement_migration TEXT NOT NULL
    CHECK (
      fence_enforcement_migration =
        '0068_relay_container_drain_admission_enforce.sql'
    ),
  cutoff_at INTEGER NOT NULL
    CHECK (typeof(cutoff_at) = 'integer' AND cutoff_at > 0),
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
  drain_ledger_schema_migration TEXT NOT NULL
    CHECK (
      drain_ledger_schema_migration =
        '0067_relay_container_drain_expand.sql'
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
  state TEXT NOT NULL
    CHECK (
      state IN (
        'fenced',
        'membership_copying',
        'membership_sealed',
        'draining',
        'drained',
        'operation14_complete',
        'eligible_for_traffic_return_review',
        'recovery_required',
        'aborted'
      )
    ),
  state_version INTEGER NOT NULL
    CHECK (typeof(state_version) = 'integer' AND state_version >= 0),
  last_event_digest_sha256 TEXT
    CHECK (
      last_event_digest_sha256 IS NULL
      OR (
        typeof(last_event_digest_sha256) = 'text'
        AND length(last_event_digest_sha256) = 64
        AND last_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  created_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(created_by_admin_id) = 'integer'
      AND created_by_admin_id > 0
    ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  CHECK (cutoff_at = created_at),
  CHECK (
    (
      accepted_member_count = 0
      AND accepted_first_sequence = 0
      AND accepted_first_operation_id IS NULL
      AND accepted_last_sequence = 0
      AND accepted_last_operation_id IS NULL
    )
    OR (
      accepted_member_count > 0
      AND accepted_first_sequence > 0
      AND accepted_first_operation_id IS NOT NULL
      AND length(accepted_first_operation_id) BETWEEN 1 AND 128
      AND substr(accepted_first_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND accepted_first_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND accepted_last_sequence >= accepted_first_sequence
      AND accepted_last_operation_id IS NOT NULL
      AND length(accepted_last_operation_id) BETWEEN 1 AND 128
      AND substr(accepted_last_operation_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND accepted_last_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND accepted_last_sequence <= accepted_high_watermark
    )
  ),
  CHECK (
    (state_version = 0 AND state = 'fenced'
      AND last_event_digest_sha256 IS NULL)
    OR
    (state_version > 0 AND last_event_digest_sha256 IS NOT NULL)
  )
);

CREATE TABLE relay_container_drain_members (
  campaign_id TEXT NOT NULL,
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
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  page_ordinal INTEGER NOT NULL
    CHECK (typeof(page_ordinal) = 'integer' AND page_ordinal > 0),
  member_ordinal INTEGER NOT NULL
    CHECK (typeof(member_ordinal) = 'integer' AND member_ordinal > 0),
  admission_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_receipt_sha256) = 'text'
      AND length(admission_receipt_sha256) = 64
      AND admission_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_attempt_identity_sha256 TEXT
    CHECK (
      provider_attempt_identity_sha256 IS NULL
      OR (
        typeof(provider_attempt_identity_sha256) = 'text'
        AND length(provider_attempt_identity_sha256) = 64
        AND provider_attempt_identity_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  reservation_key_sha256 TEXT NOT NULL
    CHECK (
      typeof(reservation_key_sha256) = 'text'
      AND length(reservation_key_sha256) = 64
      AND reservation_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  expected_terminal_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(expected_terminal_identity_sha256) = 'text'
      AND length(expected_terminal_identity_sha256) = 64
      AND expected_terminal_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  expected_final_ack_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(expected_final_ack_identity_sha256) = 'text'
      AND length(expected_final_ack_identity_sha256) = 64
      AND expected_final_ack_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  required_r2_artifact_class TEXT NOT NULL
    CHECK (
      required_r2_artifact_class IN (
        'none',
        'input',
        'result',
        'client_response',
        'input_and_result'
      )
    ),
  billing_contract_ref_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_contract_ref_sha256) = 'text'
      AND length(billing_contract_ref_sha256) = 64
      AND billing_contract_ref_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  billing_expression_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_expression_sha256) = 'text'
      AND length(billing_expression_sha256) = 64
      AND billing_expression_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  billing_expression_version INTEGER NOT NULL
    CHECK (
      typeof(billing_expression_version) = 'integer'
      AND billing_expression_version > 0
    ),
  usage_semantic TEXT NOT NULL
    CHECK (
      usage_semantic IN (
        'tokens',
        'seconds',
        'images',
        'requests',
        'provider_reported'
      )
    ),
  request_input_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_input_sha256) = 'text'
      AND length(request_input_sha256) = 64
      AND request_input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  member_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(member_digest_sha256) = 'text'
      AND length(member_digest_sha256) = 64
      AND member_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (campaign_id, operation_id, owner_generation),
  UNIQUE (campaign_id, accepted_sequence, operation_id),
  UNIQUE (campaign_id, page_ordinal, member_ordinal),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE relay_container_ambiguity_quarantines (
  quarantine_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(quarantine_id_sha256) = 'text'
      AND length(quarantine_id_sha256) = 64
      AND quarantine_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  reservation_key_sha256 TEXT NOT NULL,
  provider_operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(provider_operation_id_sha256) = 'text'
      AND length(provider_operation_id_sha256) = 64
      AND provider_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  send_before_journal_sha256 TEXT NOT NULL
    CHECK (
      typeof(send_before_journal_sha256) = 'text'
      AND length(send_before_journal_sha256) = 64
      AND send_before_journal_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_sha256) = 'text'
      AND length(request_sha256) = 64
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  last_provider_observation_sha256 TEXT NOT NULL
    CHECK (
      typeof(last_provider_observation_sha256) = 'text'
      AND length(last_provider_observation_sha256) = 64
      AND last_provider_observation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(evidence_manifest_sha256) = 'text'
      AND length(evidence_manifest_sha256) = 64
      AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_resend_allowed INTEGER NOT NULL
    CHECK (typeof(provider_resend_allowed) = 'integer' AND provider_resend_allowed = 0),
  rust_replay_allowed INTEGER NOT NULL
    CHECK (typeof(rust_replay_allowed) = 'integer' AND rust_replay_allowed = 0),
  go_replay_allowed INTEGER NOT NULL
    CHECK (typeof(go_replay_allowed) = 'integer' AND go_replay_allowed = 0),
  reconciliation_owner TEXT NOT NULL
    CHECK (
      reconciliation_owner IN (
        'provider_reconciliation',
        'finance_reconciliation',
        'joint_review'
      )
    ),
  review_deadline_at INTEGER NOT NULL
    CHECK (typeof(review_deadline_at) = 'integer' AND review_deadline_at > 0),
  customer_exposure_quota INTEGER NOT NULL
    CHECK (
      typeof(customer_exposure_quota) = 'integer'
      AND customer_exposure_quota >= 0
    ),
  provider_exposure_microunits INTEGER NOT NULL
    CHECK (
      typeof(provider_exposure_microunits) = 'integer'
      AND provider_exposure_microunits >= 0
    ),
  accounting_disposition TEXT NOT NULL
    CHECK (
      accounting_disposition IN (
        'billing_hold',
        'customer_credited_provider_pending',
        'reviewed_zero_exposure',
        'reviewed_manual_settlement'
      )
    ),
  accounting_disposition_sha256 TEXT NOT NULL
    CHECK (
      typeof(accounting_disposition_sha256) = 'text'
      AND length(accounting_disposition_sha256) = 64
      AND accounting_disposition_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  go_tombstone_sha256 TEXT NOT NULL
    CHECK (
      typeof(go_tombstone_sha256) = 'text'
      AND length(go_tombstone_sha256) = 64
      AND go_tombstone_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approval_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(approval_manifest_sha256) = 'text'
      AND length(approval_manifest_sha256) = 64
      AND approval_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  worm_object_key_sha256 TEXT NOT NULL
    CHECK (
      typeof(worm_object_key_sha256) = 'text'
      AND length(worm_object_key_sha256) = 64
      AND worm_object_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  retention_until INTEGER NOT NULL
    CHECK (typeof(retention_until) = 'integer' AND retention_until > 0),
  quarantine_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(quarantine_digest_sha256) = 'text'
      AND length(quarantine_digest_sha256) = 64
      AND quarantine_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  quarantined_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(quarantined_by_admin_id) = 'integer'
      AND quarantined_by_admin_id > 0
    ),
  quarantined_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(quarantined_at) = 'integer' AND quarantined_at > 0),
  UNIQUE (campaign_id, operation_id, owner_generation),
  FOREIGN KEY (campaign_id, operation_id, owner_generation)
    REFERENCES relay_container_drain_members(
      campaign_id,
      operation_id,
      owner_generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (review_deadline_at > quarantined_at),
  CHECK (retention_until > review_deadline_at)
);

CREATE TABLE relay_container_reverse_sync_manifests (
  manifest_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(manifest_id_sha256) = 'text'
      AND length(manifest_id_sha256) = 64
      AND manifest_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL,
  sync_generation INTEGER NOT NULL
    CHECK (typeof(sync_generation) = 'integer' AND sync_generation > 0),
  snapshot_id_sha256 TEXT NOT NULL,
  source_schema_sha256 TEXT NOT NULL,
  target_schema_sha256 TEXT NOT NULL,
  source_bookmark_sha256 TEXT NOT NULL,
  source_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(source_high_watermark) = 'integer'
      AND source_high_watermark >= 0
    ),
  target_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(target_high_watermark) = 'integer'
      AND target_high_watermark >= 0
    ),
  source_count INTEGER NOT NULL
    CHECK (typeof(source_count) = 'integer' AND source_count >= 0),
  target_count INTEGER NOT NULL
    CHECK (typeof(target_count) = 'integer' AND target_count >= 0),
  rejected_count INTEGER NOT NULL
    CHECK (typeof(rejected_count) = 'integer' AND rejected_count >= 0),
  partition_count INTEGER NOT NULL
    CHECK (typeof(partition_count) = 'integer' AND partition_count > 0),
  partition_manifest_sha256 TEXT NOT NULL,
  go_import_identity_sha256 TEXT NOT NULL,
  shadow_result TEXT NOT NULL
    CHECK (shadow_result IN ('matched', 'diverged', 'not_run')),
  shadow_manifest_sha256 TEXT NOT NULL,
  rust_writes_fenced INTEGER NOT NULL
    CHECK (typeof(rust_writes_fenced) = 'integer' AND rust_writes_fenced = 1),
  go_writes_enabled INTEGER NOT NULL
    CHECK (typeof(go_writes_enabled) = 'integer' AND go_writes_enabled = 0),
  status TEXT NOT NULL
    CHECK (status IN ('passed', 'failed', 'recovery_required')),
  manifest_digest_sha256 TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  UNIQUE (campaign_id, sync_generation),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(snapshot_id_sha256) = 64
    AND snapshot_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(source_schema_sha256) = 64
    AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(target_schema_sha256) = 64
    AND target_schema_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(source_bookmark_sha256) = 64
    AND source_bookmark_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(partition_manifest_sha256) = 64
    AND partition_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(go_import_identity_sha256) = 64
    AND go_import_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(shadow_manifest_sha256) = 64
    AND shadow_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(manifest_digest_sha256) = 64
    AND manifest_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    status <> 'passed'
    OR (
      source_count = target_count
      AND rejected_count = 0
      AND source_high_watermark = target_high_watermark
      AND shadow_result = 'matched'
    )
  )
);

CREATE TABLE relay_container_drain_observations (
  observation_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(observation_id_sha256) = 'text'
      AND length(observation_id_sha256) = 64
      AND observation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL
    CHECK (observation_kind IN ('member_closure', 'global')),
  observation_generation INTEGER NOT NULL
    CHECK (
      typeof(observation_generation) = 'integer'
      AND observation_generation > 0
    ),
  campaign_event_sequence INTEGER NOT NULL
    CHECK (
      typeof(campaign_event_sequence) = 'integer'
      AND campaign_event_sequence > 0
    ),
  operation_id TEXT,
  owner_generation INTEGER,
  closure_class TEXT
    CHECK (
      closure_class IS NULL
      OR closure_class IN (
        'settled_terminal',
        'failed_terminal',
        'quarantined'
      )
    ),
  terminal_event_sha256 TEXT,
  final_ack_sha256 TEXT,
  financial_terminal_sha256 TEXT,
  billing_audit_sha256 TEXT,
  outbox_disposition_sha256 TEXT,
  reconciliation_sha256 TEXT,
  r2_evidence_sha256 TEXT,
  reverse_sync_disposition_sha256 TEXT,
  request_id_sha256 TEXT,
  observer_identity_sha256 TEXT,
  controller_version_id TEXT,
  shard_inventory_sha256 TEXT,
  member_count INTEGER,
  member_closure_count INTEGER,
  quarantine_count INTEGER,
  reverse_manifest_count INTEGER,
  d1_open_count INTEGER,
  billing_open_count INTEGER,
  outbox_open_count INTEGER,
  reconciliation_open_count INTEGER,
  r2_missing_count INTEGER,
  queue_open_count INTEGER,
  reverse_sync_open_count INTEGER,
  memory_batch_open_count INTEGER,
  unclassified_open_count INTEGER,
  member_closure_manifest_sha256 TEXT,
  quarantine_manifest_sha256 TEXT,
  reverse_sync_manifest_sha256 TEXT,
  billing_conservation_sha256 TEXT,
  state_digest_sha256 TEXT,
  observation_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(observation_digest_sha256) = 'text'
      AND length(observation_digest_sha256) = 64
      AND observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  observed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(observed_at) = 'integer' AND observed_at > 0),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (
      observation_kind = 'member_closure'
      AND operation_id IS NOT NULL
      AND owner_generation IS NOT NULL
      AND typeof(owner_generation) = 'integer'
      AND owner_generation > 0
      AND closure_class IS NOT NULL
      AND terminal_event_sha256 IS NOT NULL
      AND final_ack_sha256 IS NOT NULL
      AND financial_terminal_sha256 IS NOT NULL
      AND billing_audit_sha256 IS NOT NULL
      AND outbox_disposition_sha256 IS NOT NULL
      AND reconciliation_sha256 IS NOT NULL
      AND r2_evidence_sha256 IS NOT NULL
      AND reverse_sync_disposition_sha256 IS NOT NULL
      AND request_id_sha256 IS NULL
      AND observer_identity_sha256 IS NULL
      AND controller_version_id IS NULL
      AND shard_inventory_sha256 IS NULL
      AND member_count IS NULL
      AND billing_conservation_sha256 IS NULL
      AND state_digest_sha256 IS NULL
    )
    OR
    (
      observation_kind = 'global'
      AND operation_id IS NULL
      AND owner_generation IS NULL
      AND closure_class IS NULL
      AND terminal_event_sha256 IS NULL
      AND final_ack_sha256 IS NULL
      AND financial_terminal_sha256 IS NULL
      AND billing_audit_sha256 IS NULL
      AND outbox_disposition_sha256 IS NULL
      AND reconciliation_sha256 IS NULL
      AND r2_evidence_sha256 IS NULL
      AND reverse_sync_disposition_sha256 IS NULL
      AND request_id_sha256 IS NOT NULL
      AND observer_identity_sha256 IS NOT NULL
      AND controller_version_id IS NOT NULL
      AND shard_inventory_sha256 IS NOT NULL
      AND member_count IS NOT NULL
      AND member_closure_count IS NOT NULL
      AND quarantine_count IS NOT NULL
      AND reverse_manifest_count IS NOT NULL
      AND d1_open_count IS NOT NULL
      AND billing_open_count IS NOT NULL
      AND outbox_open_count IS NOT NULL
      AND reconciliation_open_count IS NOT NULL
      AND r2_missing_count IS NOT NULL
      AND queue_open_count IS NOT NULL
      AND reverse_sync_open_count IS NOT NULL
      AND memory_batch_open_count IS NOT NULL
      AND unclassified_open_count IS NOT NULL
      AND member_closure_manifest_sha256 IS NOT NULL
      AND quarantine_manifest_sha256 IS NOT NULL
      AND reverse_sync_manifest_sha256 IS NOT NULL
      AND billing_conservation_sha256 IS NOT NULL
      AND state_digest_sha256 IS NOT NULL
    )
  ),
  CHECK (
    observation_kind <> 'member_closure'
    OR (
      length(terminal_event_sha256) = 64
      AND terminal_event_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(final_ack_sha256) = 64
      AND final_ack_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(financial_terminal_sha256) = 64
      AND financial_terminal_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(billing_audit_sha256) = 64
      AND billing_audit_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(outbox_disposition_sha256) = 64
      AND outbox_disposition_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(reconciliation_sha256) = 64
      AND reconciliation_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(r2_evidence_sha256) = 64
      AND r2_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(reverse_sync_disposition_sha256) = 64
      AND reverse_sync_disposition_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    observation_kind <> 'global'
    OR (
      length(request_id_sha256) = 64
      AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(observer_identity_sha256) = 64
      AND observer_identity_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND length(shard_inventory_sha256) = 64
      AND shard_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
      AND member_count >= 0
      AND member_closure_count >= 0
      AND quarantine_count >= 0
      AND reverse_manifest_count >= 0
      AND d1_open_count >= 0
      AND billing_open_count >= 0
      AND outbox_open_count >= 0
      AND reconciliation_open_count >= 0
      AND r2_missing_count >= 0
      AND queue_open_count >= 0
      AND reverse_sync_open_count >= 0
      AND memory_batch_open_count >= 0
      AND unclassified_open_count >= 0
      AND length(member_closure_manifest_sha256) = 64
      AND member_closure_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(quarantine_manifest_sha256) = 64
      AND quarantine_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(reverse_sync_manifest_sha256) = 64
      AND reverse_sync_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(billing_conservation_sha256) = 64
      AND billing_conservation_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(state_digest_sha256) = 64
      AND state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  )
);

CREATE TABLE relay_container_drain_shard_observations (
  observation_id_sha256 TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  placement_attestation_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(placement_attestation_digest_sha256) = 'text'
      AND length(placement_attestation_digest_sha256) = 64
      AND placement_attestation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  local_high_watermark INTEGER NOT NULL
    CHECK (
      typeof(local_high_watermark) = 'integer'
      AND local_high_watermark >= 0
    ),
  snapshot_digest_sha256 TEXT NOT NULL,
  controller_state_digest_sha256 TEXT NOT NULL,
  execution_stop_eligible INTEGER NOT NULL
    CHECK (execution_stop_eligible IN (0, 1)),
  accepted_work_drained INTEGER NOT NULL
    CHECK (accepted_work_drained IN (0, 1)),
  executable_open_count INTEGER NOT NULL
    CHECK (typeof(executable_open_count) = 'integer' AND executable_open_count >= 0),
  final_ack_open_count INTEGER NOT NULL
    CHECK (typeof(final_ack_open_count) = 'integer' AND final_ack_open_count >= 0),
  ambiguity_open_count INTEGER NOT NULL
    CHECK (typeof(ambiguity_open_count) = 'integer' AND ambiguity_open_count >= 0),
  unclassified_operation_count INTEGER NOT NULL
    CHECK (
      typeof(unclassified_operation_count) = 'integer'
      AND unclassified_operation_count >= 0
    ),
  shard_observation_digest_sha256 TEXT NOT NULL,
  observed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(observed_at) = 'integer' AND observed_at > 0),
  PRIMARY KEY (observation_id_sha256, shard_index),
  FOREIGN KEY (observation_id_sha256)
    REFERENCES relay_container_drain_observations(observation_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (placement_attestation_digest_sha256)
    REFERENCES relay_container_shard_placement_attestations(
      placement_attestation_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(snapshot_digest_sha256) = 64
    AND snapshot_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(controller_state_digest_sha256) = 64
    AND controller_state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(shard_observation_digest_sha256) = 64
    AND shard_observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    accepted_work_drained = 0
    OR (
      execution_stop_eligible = 1
      AND executable_open_count = 0
      AND final_ack_open_count = 0
      AND ambiguity_open_count = 0
      AND unclassified_operation_count = 0
    )
  )
);

CREATE TABLE relay_container_traffic_return_receipts (
  receipt_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(receipt_id_sha256) = 'text'
      AND length(receipt_id_sha256) = 64
      AND receipt_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  receipt_contract TEXT NOT NULL
    CHECK (receipt_contract = 'traffic-return-review-eligibility-v1'),
  evidence_enforcement_migration TEXT NOT NULL
    CHECK (
      evidence_enforcement_migration =
        '0069_relay_container_traffic_return_evidence_enforce.sql'
    ),
  first_observation_id_sha256 TEXT NOT NULL,
  second_observation_id_sha256 TEXT NOT NULL,
  reverse_sync_manifest_id_sha256 TEXT NOT NULL,
  membership_manifest_sha256 TEXT NOT NULL,
  member_closure_manifest_sha256 TEXT NOT NULL,
  quarantine_manifest_sha256 TEXT NOT NULL,
  billing_conservation_sha256 TEXT NOT NULL,
  operation14_receipt_sha256 TEXT NOT NULL,
  operation14_baseline_sha256 TEXT NOT NULL,
  go_vps_readiness_sha256 TEXT NOT NULL,
  traffic_rehearsal_sha256 TEXT NOT NULL,
  slo_approval_sha256 TEXT NOT NULL,
  security_approval_sha256 TEXT NOT NULL,
  finance_approval_sha256 TEXT NOT NULL,
  release_approval_sha256 TEXT NOT NULL,
  immutable_evidence_location_sha256 TEXT NOT NULL,
  retention_policy_sha256 TEXT NOT NULL,
  eligible_for_traffic_return_review INTEGER NOT NULL
    CHECK (eligible_for_traffic_return_review = 1),
  traffic_return_authorized INTEGER NOT NULL
    CHECK (traffic_return_authorized = 0),
  reviewer_identity_sha256 TEXT NOT NULL,
  receipt_digest_sha256 TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(issued_at) = 'integer' AND issued_at > 0),
  UNIQUE (campaign_id),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (first_observation_id_sha256)
    REFERENCES relay_container_drain_observations(observation_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (second_observation_id_sha256)
    REFERENCES relay_container_drain_observations(observation_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (reverse_sync_manifest_id_sha256)
    REFERENCES relay_container_reverse_sync_manifests(manifest_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (first_observation_id_sha256 <> second_observation_id_sha256),
  CHECK (
    length(first_observation_id_sha256) = 64
    AND length(second_observation_id_sha256) = 64
    AND length(reverse_sync_manifest_id_sha256) = 64
    AND length(membership_manifest_sha256) = 64
    AND length(member_closure_manifest_sha256) = 64
    AND length(quarantine_manifest_sha256) = 64
    AND length(billing_conservation_sha256) = 64
    AND length(operation14_receipt_sha256) = 64
    AND length(operation14_baseline_sha256) = 64
    AND length(go_vps_readiness_sha256) = 64
    AND length(traffic_rehearsal_sha256) = 64
    AND length(slo_approval_sha256) = 64
    AND length(security_approval_sha256) = 64
    AND length(finance_approval_sha256) = 64
    AND length(release_approval_sha256) = 64
    AND length(immutable_evidence_location_sha256) = 64
    AND length(retention_policy_sha256) = 64
    AND length(reviewer_identity_sha256) = 64
    AND length(receipt_digest_sha256) = 64
    AND (
      first_observation_id_sha256
      || second_observation_id_sha256
      || reverse_sync_manifest_id_sha256
      || membership_manifest_sha256
      || member_closure_manifest_sha256
      || quarantine_manifest_sha256
      || billing_conservation_sha256
      || operation14_receipt_sha256
      || operation14_baseline_sha256
      || go_vps_readiness_sha256
      || traffic_rehearsal_sha256
      || slo_approval_sha256
      || security_approval_sha256
      || finance_approval_sha256
      || release_approval_sha256
      || immutable_evidence_location_sha256
      || retention_policy_sha256
      || reviewer_identity_sha256
      || receipt_digest_sha256
    ) NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE relay_container_drain_events (
  campaign_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL
    CHECK (typeof(event_sequence) = 'integer' AND event_sequence > 0),
  event_code TEXT NOT NULL
    CHECK (
      event_code IN (
        'membership_page_sealed',
        'membership_sealed',
        'drain_started',
        'drain_sealed',
        'operation14_completed',
        'traffic_return_receipt_sealed',
        'recovery_required',
        'aborted'
      )
    ),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  previous_event_digest_sha256 TEXT,
  page_ordinal INTEGER,
  page_member_count INTEGER,
  page_first_accepted_sequence INTEGER,
  page_first_operation_id TEXT,
  page_last_accepted_sequence INTEGER,
  page_last_operation_id TEXT,
  sealed_page_count INTEGER,
  sealed_member_count INTEGER,
  membership_manifest_sha256 TEXT,
  first_observation_id_sha256 TEXT,
  second_observation_id_sha256 TEXT,
  reverse_sync_manifest_id_sha256 TEXT,
  operation14_receipt_sha256 TEXT,
  operation14_baseline_sha256 TEXT,
  traffic_return_receipt_id_sha256 TEXT,
  evidence_manifest_sha256 TEXT NOT NULL,
  actor_identity_sha256 TEXT NOT NULL,
  event_digest_sha256 TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (campaign_id, event_sequence),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    previous_event_digest_sha256 IS NULL
    OR (
      length(previous_event_digest_sha256) = 64
      AND previous_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    length(evidence_manifest_sha256) = 64
    AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(actor_identity_sha256) = 64
    AND actor_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(event_digest_sha256) = 64
    AND event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (
      event_code = 'membership_page_sealed'
      AND page_ordinal IS NOT NULL
      AND typeof(page_ordinal) = 'integer'
      AND page_ordinal > 0
      AND page_member_count IS NOT NULL
      AND typeof(page_member_count) = 'integer'
      AND page_member_count > 0
      AND page_first_accepted_sequence IS NOT NULL
      AND typeof(page_first_accepted_sequence) = 'integer'
      AND page_first_accepted_sequence > 0
      AND page_first_operation_id IS NOT NULL
      AND page_last_accepted_sequence IS NOT NULL
      AND typeof(page_last_accepted_sequence) = 'integer'
      AND page_last_accepted_sequence > 0
      AND page_last_operation_id IS NOT NULL
    )
    OR (
      event_code <> 'membership_page_sealed'
      AND page_ordinal IS NULL
      AND page_member_count IS NULL
      AND page_first_accepted_sequence IS NULL
      AND page_first_operation_id IS NULL
      AND page_last_accepted_sequence IS NULL
      AND page_last_operation_id IS NULL
    )
  ),
  CHECK (
    (
      event_code = 'membership_sealed'
      AND sealed_page_count IS NOT NULL
      AND typeof(sealed_page_count) = 'integer'
      AND sealed_page_count >= 0
      AND sealed_member_count IS NOT NULL
      AND typeof(sealed_member_count) = 'integer'
      AND sealed_member_count >= 0
      AND membership_manifest_sha256 IS NOT NULL
      AND length(membership_manifest_sha256) = 64
      AND membership_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      event_code <> 'membership_sealed'
      AND sealed_page_count IS NULL
      AND sealed_member_count IS NULL
      AND membership_manifest_sha256 IS NULL
    )
  ),
  CHECK (
    (
      event_code = 'drain_sealed'
      AND first_observation_id_sha256 IS NOT NULL
      AND second_observation_id_sha256 IS NOT NULL
      AND reverse_sync_manifest_id_sha256 IS NOT NULL
      AND first_observation_id_sha256 <> second_observation_id_sha256
      AND length(first_observation_id_sha256) = 64
      AND first_observation_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(second_observation_id_sha256) = 64
      AND second_observation_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(reverse_sync_manifest_id_sha256) = 64
      AND reverse_sync_manifest_id_sha256 NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      event_code <> 'drain_sealed'
      AND first_observation_id_sha256 IS NULL
      AND second_observation_id_sha256 IS NULL
      AND reverse_sync_manifest_id_sha256 IS NULL
    )
  ),
  CHECK (
    (
      event_code = 'operation14_completed'
      AND operation14_receipt_sha256 IS NOT NULL
      AND operation14_baseline_sha256 IS NOT NULL
      AND length(operation14_receipt_sha256) = 64
      AND operation14_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(operation14_baseline_sha256) = 64
      AND operation14_baseline_sha256 NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      event_code <> 'operation14_completed'
      AND operation14_receipt_sha256 IS NULL
      AND operation14_baseline_sha256 IS NULL
    )
  ),
  CHECK (
    (
      event_code = 'traffic_return_receipt_sealed'
      AND traffic_return_receipt_id_sha256 IS NOT NULL
      AND length(traffic_return_receipt_id_sha256) = 64
      AND traffic_return_receipt_id_sha256 NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      event_code <> 'traffic_return_receipt_sealed'
      AND traffic_return_receipt_id_sha256 IS NULL
    )
  )
);

CREATE UNIQUE INDEX idx_relay_container_drain_active_scope
  ON relay_container_drain_campaigns(
    environment,
    scope_kind,
    scope_id_sha256
  )
  WHERE state NOT IN ('aborted', 'recovery_required');

CREATE UNIQUE INDEX idx_relay_container_drain_campaign_digest
  ON relay_container_drain_campaigns(campaign_digest_sha256);

CREATE INDEX idx_relay_container_drain_campaign_state
  ON relay_container_drain_campaigns(state, created_at, campaign_id);

CREATE UNIQUE INDEX idx_relay_container_drain_member_digest
  ON relay_container_drain_members(member_digest_sha256);

CREATE INDEX idx_relay_container_drain_members_page
  ON relay_container_drain_members(
    campaign_id,
    page_ordinal,
    member_ordinal
  );

CREATE UNIQUE INDEX idx_relay_container_drain_event_digest
  ON relay_container_drain_events(event_digest_sha256);

CREATE UNIQUE INDEX idx_relay_container_drain_page_seal
  ON relay_container_drain_events(campaign_id, page_ordinal)
  WHERE event_code = 'membership_page_sealed';

CREATE UNIQUE INDEX idx_relay_container_drain_member_closure
  ON relay_container_drain_observations(
    campaign_id,
    operation_id,
    owner_generation
  )
  WHERE observation_kind = 'member_closure';

CREATE INDEX idx_relay_container_drain_global_observations
  ON relay_container_drain_observations(
    campaign_id,
    observation_kind,
    observed_at,
    observation_id_sha256
  );

CREATE UNIQUE INDEX idx_relay_container_drain_observation_digest
  ON relay_container_drain_observations(observation_digest_sha256);

CREATE UNIQUE INDEX idx_relay_container_drain_shard_observation_digest
  ON relay_container_drain_shard_observations(
    shard_observation_digest_sha256
  );

CREATE UNIQUE INDEX idx_relay_container_quarantine_digest
  ON relay_container_ambiguity_quarantines(quarantine_digest_sha256);

CREATE INDEX idx_relay_container_quarantine_review
  ON relay_container_ambiguity_quarantines(
    review_deadline_at,
    campaign_id,
    operation_id
  );

CREATE INDEX idx_relay_container_reverse_sync_status
  ON relay_container_reverse_sync_manifests(
    campaign_id,
    status,
    sync_generation
  );

CREATE UNIQUE INDEX idx_relay_container_traffic_return_receipt_digest
  ON relay_container_traffic_return_receipts(receipt_digest_sha256);

CREATE TRIGGER relay_container_drain_campaign_insert_guard
BEFORE INSERT ON relay_container_drain_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'drain campaign time must come from D1') END;

  SELECT CASE WHEN
    NEW.state <> 'fenced'
    OR NEW.state_version <> 0
    OR NEW.last_event_digest_sha256 IS NOT NULL
  THEN RAISE(ABORT, 'drain campaign must start at the fenced boundary') END;

  SELECT CASE WHEN NEW.fence_generation <> COALESCE((
    SELECT MAX(campaign.fence_generation) + 1
    FROM relay_container_drain_campaigns AS campaign
    WHERE campaign.environment = NEW.environment
      AND campaign.scope_kind = NEW.scope_kind
      AND campaign.scope_id_sha256 = NEW.scope_id_sha256
  ), 1)
  THEN RAISE(
    ABORT,
    'drain campaign fence generation must advance exactly once'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM d1_migrations
    WHERE name = '0068_relay_container_drain_admission_enforce.sql'
  ) THEN RAISE(
    ABORT,
    'drain campaign requires D1 admission enforcement migration 0068'
  ) END;
END;

CREATE TRIGGER relay_container_drain_campaign_update_guard
BEFORE UPDATE ON relay_container_drain_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    NEW.campaign_id <> OLD.campaign_id
    OR NEW.contract_version <> OLD.contract_version
    OR NEW.campaign_contract <> OLD.campaign_contract
    OR NEW.environment <> OLD.environment
    OR NEW.scope_kind <> OLD.scope_kind
    OR NEW.scope_id_sha256 <> OLD.scope_id_sha256
    OR NEW.fence_generation <> OLD.fence_generation
    OR NEW.admission_fence_id_sha256 <> OLD.admission_fence_id_sha256
    OR NEW.admission_open <> OLD.admission_open
    OR NEW.fence_enforcement_migration <> OLD.fence_enforcement_migration
    OR NEW.cutoff_at <> OLD.cutoff_at
    OR NEW.accepted_high_watermark <> OLD.accepted_high_watermark
    OR NEW.accepted_bookmark_sha256 <> OLD.accepted_bookmark_sha256
    OR NEW.accepted_member_count <> OLD.accepted_member_count
    OR NEW.accepted_set_manifest_sha256 <>
         OLD.accepted_set_manifest_sha256
    OR NEW.accepted_first_sequence <> OLD.accepted_first_sequence
    OR NEW.accepted_first_operation_id IS NOT
         OLD.accepted_first_operation_id
    OR NEW.accepted_last_sequence <> OLD.accepted_last_sequence
    OR NEW.accepted_last_operation_id IS NOT
         OLD.accepted_last_operation_id
    OR NEW.drain_ledger_schema_migration <>
         OLD.drain_ledger_schema_migration
    OR NEW.ring_generation <> OLD.ring_generation
    OR NEW.controller_service_name <> OLD.controller_service_name
    OR NEW.controller_version_id <> OLD.controller_version_id
    OR NEW.shard_count <> OLD.shard_count
    OR NEW.shard_inventory_sha256 <> OLD.shard_inventory_sha256
    OR NEW.edge_version_set_sha256 <> OLD.edge_version_set_sha256
    OR NEW.configuration_sha256 <> OLD.configuration_sha256
    OR NEW.reverse_sync_snapshot_id_sha256 <>
         OLD.reverse_sync_snapshot_id_sha256
    OR NEW.reverse_sync_source_schema_sha256 <>
         OLD.reverse_sync_source_schema_sha256
    OR NEW.reverse_sync_target_schema_sha256 <>
         OLD.reverse_sync_target_schema_sha256
    OR NEW.stability_window_seconds <> OLD.stability_window_seconds
    OR NEW.campaign_digest_sha256 <> OLD.campaign_digest_sha256
    OR NEW.created_by_admin_id <> OLD.created_by_admin_id
    OR NEW.created_at <> OLD.created_at
  THEN RAISE(ABORT, 'drain campaign identity is immutable') END;

  SELECT CASE WHEN
    NEW.state_version <> OLD.state_version + 1
    OR NOT EXISTS (
      SELECT 1
      FROM relay_container_drain_events AS event
      WHERE event.campaign_id = OLD.campaign_id
        AND event.event_sequence = NEW.state_version
        AND event.from_state = OLD.state
        AND event.to_state = NEW.state
        AND event.event_digest_sha256 = NEW.last_event_digest_sha256
    )
  THEN RAISE(ABORT, 'drain campaign transition lacks append-only evidence') END;
END;

CREATE TRIGGER relay_container_drain_campaign_delete_guard
BEFORE DELETE ON relay_container_drain_campaigns
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain campaigns are append-preserved');
END;

CREATE TRIGGER relay_container_drain_member_insert_guard
BEFORE INSERT ON relay_container_drain_members
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'drain member time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state IN ('fenced', 'membership_copying')
      AND campaign.accepted_member_count > 0
      AND NEW.accepted_sequence <= campaign.accepted_high_watermark
      AND (
        NEW.accepted_sequence > campaign.accepted_first_sequence
        OR (
          NEW.accepted_sequence = campaign.accepted_first_sequence
          AND NEW.operation_id >= campaign.accepted_first_operation_id
        )
      )
      AND (
        NEW.accepted_sequence < campaign.accepted_last_sequence
        OR (
          NEW.accepted_sequence = campaign.accepted_last_sequence
          AND NEW.operation_id <= campaign.accepted_last_operation_id
        )
      )
      AND NEW.shard_index < campaign.shard_count
      AND NEW.recorded_at >= campaign.cutoff_at
      AND (
        SELECT COUNT(*)
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
      ) < campaign.accepted_member_count
      AND (
        (
          SELECT COUNT(*)
          FROM relay_container_drain_members AS member
          WHERE member.campaign_id = NEW.campaign_id
        ) > 0
        OR (
          NEW.accepted_sequence = campaign.accepted_first_sequence
          AND NEW.operation_id = campaign.accepted_first_operation_id
        )
      )
      AND (
        (
          SELECT COUNT(*) + 1
          FROM relay_container_drain_members AS member
          WHERE member.campaign_id = NEW.campaign_id
        ) < campaign.accepted_member_count
        OR (
          NEW.accepted_sequence = campaign.accepted_last_sequence
          AND NEW.operation_id = campaign.accepted_last_operation_id
        )
      )
      AND NEW.page_ordinal = (
        SELECT COUNT(*) + 1
        FROM relay_container_drain_events AS event
        WHERE event.campaign_id = NEW.campaign_id
          AND event.event_code = 'membership_page_sealed'
      )
  ) THEN RAISE(ABORT, 'drain member is outside the frozen accepted set') END;

  SELECT CASE WHEN NEW.member_ordinal <> (
    SELECT COUNT(*) + 1
    FROM relay_container_drain_members AS member
    WHERE member.campaign_id = NEW.campaign_id
      AND member.page_ordinal = NEW.page_ordinal
  ) THEN RAISE(ABORT, 'drain member page ordinal is not contiguous') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_members AS previous
    WHERE previous.campaign_id = NEW.campaign_id
      AND (
        previous.accepted_sequence > NEW.accepted_sequence
        OR (
          previous.accepted_sequence = NEW.accepted_sequence
          AND previous.operation_id >= NEW.operation_id
        )
      )
  ) THEN RAISE(ABORT, 'drain member keyset is not strictly increasing') END;
END;

CREATE TRIGGER relay_container_drain_member_update_guard
BEFORE UPDATE ON relay_container_drain_members
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain members are immutable');
END;

CREATE TRIGGER relay_container_drain_member_delete_guard
BEFORE DELETE ON relay_container_drain_members
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain members are append-preserved');
END;

CREATE TRIGGER relay_container_ambiguity_quarantine_insert_guard
BEFORE INSERT ON relay_container_ambiguity_quarantines
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.quarantined_at <> unixepoch()
  THEN RAISE(ABORT, 'ambiguity quarantine time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    JOIN relay_container_drain_members AS member
      ON member.campaign_id = campaign.campaign_id
     AND member.operation_id = NEW.operation_id
     AND member.owner_generation = NEW.owner_generation
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state IN ('membership_sealed', 'draining')
      AND member.reservation_key_sha256 = NEW.reservation_key_sha256
  ) THEN RAISE(ABORT, 'ambiguity quarantine member binding mismatch') END;
END;

CREATE TRIGGER relay_container_ambiguity_quarantine_update_guard
BEFORE UPDATE ON relay_container_ambiguity_quarantines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ambiguity quarantines are immutable');
END;

CREATE TRIGGER relay_container_ambiguity_quarantine_delete_guard
BEFORE DELETE ON relay_container_ambiguity_quarantines
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ambiguity quarantines are append-preserved');
END;

CREATE TRIGGER relay_container_reverse_sync_manifest_insert_guard
BEFORE INSERT ON relay_container_reverse_sync_manifests
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'reverse sync manifest time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state IN ('membership_sealed', 'draining')
      AND NEW.snapshot_id_sha256 =
            campaign.reverse_sync_snapshot_id_sha256
      AND NEW.source_schema_sha256 =
            campaign.reverse_sync_source_schema_sha256
      AND NEW.target_schema_sha256 =
            campaign.reverse_sync_target_schema_sha256
      AND NEW.source_bookmark_sha256 =
            campaign.accepted_bookmark_sha256
      AND NEW.source_high_watermark =
            campaign.accepted_high_watermark
      AND NEW.source_count = campaign.accepted_member_count
      AND NEW.sync_generation = (
        SELECT COUNT(*) + 1
        FROM relay_container_reverse_sync_manifests AS manifest
        WHERE manifest.campaign_id = NEW.campaign_id
      )
  ) THEN RAISE(ABORT, 'reverse sync manifest campaign mismatch') END;
END;

CREATE TRIGGER relay_container_reverse_sync_manifest_update_guard
BEFORE UPDATE ON relay_container_reverse_sync_manifests
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'reverse sync manifests are immutable');
END;

CREATE TRIGGER relay_container_reverse_sync_manifest_delete_guard
BEFORE DELETE ON relay_container_reverse_sync_manifests
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'reverse sync manifests are append-preserved');
END;

CREATE TRIGGER relay_container_drain_observation_insert_guard
BEFORE INSERT ON relay_container_drain_observations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.observed_at <> unixepoch()
  THEN RAISE(ABORT, 'drain observation time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state = 'draining'
      AND NEW.campaign_event_sequence = campaign.state_version
      AND (
        NEW.observation_kind <> 'global'
        OR NEW.observation_generation = (
          SELECT COUNT(*) + 1
          FROM relay_container_drain_observations AS observation
          WHERE observation.campaign_id = NEW.campaign_id
            AND observation.observation_kind = 'global'
        )
      )
      AND (
        NEW.observation_kind <> 'global'
        OR (
          NEW.controller_version_id =
            campaign.controller_version_id
          AND NEW.shard_inventory_sha256 =
            campaign.shard_inventory_sha256
          AND NEW.member_count = campaign.accepted_member_count
          AND NEW.member_count = (
            SELECT COUNT(*)
            FROM relay_container_drain_members AS member
            WHERE member.campaign_id = NEW.campaign_id
          )
          AND NEW.member_closure_count = (
            SELECT COUNT(*)
            FROM relay_container_drain_observations AS closure
            WHERE closure.campaign_id = NEW.campaign_id
              AND closure.observation_kind = 'member_closure'
          )
          AND NEW.quarantine_count = (
            SELECT COUNT(*)
            FROM relay_container_ambiguity_quarantines AS quarantine
            WHERE quarantine.campaign_id = NEW.campaign_id
          )
          AND NEW.reverse_manifest_count = (
            SELECT COUNT(*)
            FROM relay_container_reverse_sync_manifests AS manifest
            WHERE manifest.campaign_id = NEW.campaign_id
          )
          AND NEW.billing_open_count >= (
            SELECT COUNT(*)
            FROM relay_container_ambiguity_quarantines AS quarantine
            WHERE quarantine.campaign_id = NEW.campaign_id
              AND quarantine.accounting_disposition = 'billing_hold'
          )
        )
      )
  ) THEN RAISE(ABORT, 'drain observation campaign generation mismatch') END;

  SELECT CASE WHEN
    NEW.observation_kind = 'member_closure'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_drain_members AS member
      WHERE member.campaign_id = NEW.campaign_id
        AND member.operation_id = NEW.operation_id
        AND member.owner_generation = NEW.owner_generation
        AND NEW.terminal_event_sha256 =
              member.expected_terminal_identity_sha256
        AND NEW.final_ack_sha256 =
              member.expected_final_ack_identity_sha256
        AND (
          NEW.closure_class <> 'quarantined'
          OR EXISTS (
            SELECT 1
            FROM relay_container_ambiguity_quarantines AS quarantine
            WHERE quarantine.campaign_id = member.campaign_id
              AND quarantine.operation_id = member.operation_id
              AND quarantine.owner_generation = member.owner_generation
          )
        )
    )
  THEN RAISE(ABORT, 'drain member closure evidence mismatch') END;
END;

CREATE TRIGGER relay_container_drain_observation_update_guard
BEFORE UPDATE ON relay_container_drain_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain observations are immutable');
END;

CREATE TRIGGER relay_container_drain_observation_delete_guard
BEFORE DELETE ON relay_container_drain_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain observations are append-preserved');
END;

CREATE TRIGGER relay_container_drain_shard_observation_insert_guard
BEFORE INSERT ON relay_container_drain_shard_observations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.observed_at <> unixepoch()
  THEN RAISE(ABORT, 'drain shard observation time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_observations AS observation
    JOIN relay_container_drain_campaigns AS campaign
      ON campaign.campaign_id = observation.campaign_id
    JOIN relay_container_shard_placement_attestations AS placement
      ON placement.placement_attestation_digest_sha256 =
          NEW.placement_attestation_digest_sha256
    WHERE observation.observation_id_sha256 =
            NEW.observation_id_sha256
      AND observation.observation_kind = 'global'
      AND observation.campaign_id = NEW.campaign_id
      AND campaign.state = 'draining'
      AND observation.controller_version_id =
            campaign.controller_version_id
      AND placement.environment = campaign.environment
      AND placement.controller_service_name =
            campaign.controller_service_name
      AND placement.controller_version_id =
            campaign.controller_version_id
      AND placement.ring_generation = campaign.ring_generation
      AND placement.shard_count = campaign.shard_count
      AND placement.shard_index = NEW.shard_index
      AND campaign.ring_generation = NEW.ring_generation
      AND NEW.shard_index < campaign.shard_count
      AND NEW.local_high_watermark = COALESCE((
        SELECT MAX(member.accepted_sequence)
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.shard_index = NEW.shard_index
      ), 0)
      AND observation.observed_at = NEW.observed_at
  ) THEN RAISE(ABORT, 'drain shard observation binding mismatch') END;
END;

CREATE TRIGGER relay_container_drain_shard_observation_update_guard
BEFORE UPDATE ON relay_container_drain_shard_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain shard observations are immutable');
END;

CREATE TRIGGER relay_container_drain_shard_observation_delete_guard
BEFORE DELETE ON relay_container_drain_shard_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain shard observations are append-preserved');
END;

CREATE TRIGGER relay_container_traffic_return_receipt_insert_guard
BEFORE INSERT ON relay_container_traffic_return_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.issued_at <> unixepoch()
  THEN RAISE(ABORT, 'traffic return receipt time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM d1_migrations
    WHERE name =
      '0069_relay_container_traffic_return_evidence_enforce.sql'
  ) THEN RAISE(
    ABORT,
    'traffic return receipt requires typed evidence enforcement migration 0069'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    JOIN relay_container_drain_events AS drain_event
      ON drain_event.campaign_id = campaign.campaign_id
     AND drain_event.event_code = 'drain_sealed'
    JOIN relay_container_drain_events AS operation14_event
      ON operation14_event.campaign_id = campaign.campaign_id
     AND operation14_event.event_code = 'operation14_completed'
    JOIN relay_container_drain_observations AS first_observation
      ON first_observation.observation_id_sha256 =
          NEW.first_observation_id_sha256
     AND first_observation.campaign_id = campaign.campaign_id
     AND first_observation.observation_kind = 'global'
    JOIN relay_container_drain_observations AS second_observation
      ON second_observation.observation_id_sha256 =
          NEW.second_observation_id_sha256
     AND second_observation.campaign_id = campaign.campaign_id
     AND second_observation.observation_kind = 'global'
    JOIN relay_container_reverse_sync_manifests AS reverse_sync
      ON reverse_sync.manifest_id_sha256 =
          NEW.reverse_sync_manifest_id_sha256
     AND reverse_sync.campaign_id = campaign.campaign_id
     AND reverse_sync.status = 'passed'
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state = 'operation14_complete'
      AND drain_event.first_observation_id_sha256 =
            NEW.first_observation_id_sha256
      AND drain_event.second_observation_id_sha256 =
            NEW.second_observation_id_sha256
      AND drain_event.reverse_sync_manifest_id_sha256 =
            NEW.reverse_sync_manifest_id_sha256
      AND operation14_event.operation14_receipt_sha256 =
            NEW.operation14_receipt_sha256
      AND operation14_event.operation14_baseline_sha256 =
            NEW.operation14_baseline_sha256
      AND NEW.membership_manifest_sha256 = (
        SELECT membership_event.membership_manifest_sha256
        FROM relay_container_drain_events AS membership_event
        WHERE membership_event.campaign_id = campaign.campaign_id
          AND membership_event.event_code = 'membership_sealed'
      )
      AND NEW.member_closure_manifest_sha256 =
            first_observation.member_closure_manifest_sha256
      AND NEW.member_closure_manifest_sha256 =
            second_observation.member_closure_manifest_sha256
      AND NEW.quarantine_manifest_sha256 =
            first_observation.quarantine_manifest_sha256
      AND NEW.quarantine_manifest_sha256 =
            second_observation.quarantine_manifest_sha256
      AND NEW.billing_conservation_sha256 =
            first_observation.billing_conservation_sha256
      AND NEW.billing_conservation_sha256 =
            second_observation.billing_conservation_sha256
  ) THEN RAISE(ABORT, 'traffic return receipt evidence mismatch') END;
END;

CREATE TRIGGER relay_container_traffic_return_receipt_update_guard
BEFORE UPDATE ON relay_container_traffic_return_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'traffic return receipts are immutable');
END;

CREATE TRIGGER relay_container_traffic_return_receipt_delete_guard
BEFORE DELETE ON relay_container_traffic_return_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'traffic return receipts are append-preserved');
END;

CREATE TRIGGER relay_container_drain_event_insert_guard
BEFORE INSERT ON relay_container_drain_events
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'drain event time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state = NEW.from_state
      AND NEW.event_sequence = campaign.state_version + 1
      AND (
        (campaign.state_version = 0
          AND NEW.previous_event_digest_sha256 IS NULL)
        OR
        (campaign.state_version > 0
          AND NEW.previous_event_digest_sha256 =
            campaign.last_event_digest_sha256)
      )
  ) THEN RAISE(ABORT, 'drain event does not extend the campaign chain') END;

  SELECT CASE WHEN NOT (
    (
      NEW.event_code = 'membership_page_sealed'
      AND NEW.from_state IN ('fenced', 'membership_copying')
      AND NEW.to_state = 'membership_copying'
    )
    OR (
      NEW.event_code = 'membership_sealed'
      AND NEW.from_state IN ('fenced', 'membership_copying')
      AND NEW.to_state = 'membership_sealed'
    )
    OR (
      NEW.event_code = 'drain_started'
      AND NEW.from_state = 'membership_sealed'
      AND NEW.to_state = 'draining'
    )
    OR (
      NEW.event_code = 'drain_sealed'
      AND NEW.from_state = 'draining'
      AND NEW.to_state = 'drained'
    )
    OR (
      NEW.event_code = 'operation14_completed'
      AND NEW.from_state = 'drained'
      AND NEW.to_state = 'operation14_complete'
    )
    OR (
      NEW.event_code = 'traffic_return_receipt_sealed'
      AND NEW.from_state = 'operation14_complete'
      AND NEW.to_state =
        'eligible_for_traffic_return_review'
    )
    OR (
      NEW.event_code = 'recovery_required'
      AND NEW.from_state NOT IN (
        'eligible_for_traffic_return_review',
        'recovery_required',
        'aborted'
      )
      AND NEW.to_state = 'recovery_required'
    )
    OR (
      NEW.event_code = 'aborted'
      AND NEW.from_state IN ('fenced', 'membership_copying')
      AND NEW.to_state = 'aborted'
    )
  ) THEN RAISE(ABORT, 'drain event lifecycle transition is invalid') END;

  SELECT CASE WHEN
    NEW.event_code = 'membership_page_sealed'
    AND (
      NEW.page_ordinal IS NULL
      OR NEW.page_member_count IS NULL
      OR NEW.page_first_accepted_sequence IS NULL
      OR NEW.page_first_operation_id IS NULL
      OR NEW.page_last_accepted_sequence IS NULL
      OR NEW.page_last_operation_id IS NULL
      OR NEW.page_ordinal <> (
        SELECT COUNT(*) + 1
        FROM relay_container_drain_events AS event
        WHERE event.campaign_id = NEW.campaign_id
          AND event.event_code = 'membership_page_sealed'
      )
      OR NEW.page_member_count <> (
        SELECT COUNT(*)
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.page_ordinal = NEW.page_ordinal
      )
      OR NEW.page_first_accepted_sequence <> (
        SELECT member.accepted_sequence
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.member_ordinal ASC
        LIMIT 1
      )
      OR NEW.page_first_operation_id <> (
        SELECT member.operation_id
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.member_ordinal ASC
        LIMIT 1
      )
      OR NEW.page_last_accepted_sequence <> (
        SELECT member.accepted_sequence
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.member_ordinal DESC
        LIMIT 1
      )
      OR NEW.page_last_operation_id <> (
        SELECT member.operation_id
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
          AND member.page_ordinal = NEW.page_ordinal
        ORDER BY member.member_ordinal DESC
        LIMIT 1
      )
    )
  THEN RAISE(ABORT, 'drain membership page seal is not keyset-complete') END;

  SELECT CASE WHEN
    NEW.event_code = 'membership_sealed'
    AND (
      NEW.sealed_page_count IS NULL
      OR NEW.sealed_member_count IS NULL
      OR NEW.membership_manifest_sha256 IS NULL
      OR NEW.sealed_page_count <> (
        SELECT COUNT(*)
        FROM relay_container_drain_events AS event
        WHERE event.campaign_id = NEW.campaign_id
          AND event.event_code = 'membership_page_sealed'
      )
      OR NEW.sealed_member_count <> (
        SELECT COUNT(*)
        FROM relay_container_drain_members AS member
        WHERE member.campaign_id = NEW.campaign_id
      )
      OR NEW.sealed_member_count <> COALESCE((
        SELECT SUM(event.page_member_count)
        FROM relay_container_drain_events AS event
        WHERE event.campaign_id = NEW.campaign_id
          AND event.event_code = 'membership_page_sealed'
      ), 0)
      OR NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_campaigns AS campaign
        WHERE campaign.campaign_id = NEW.campaign_id
          AND NEW.sealed_member_count = campaign.accepted_member_count
          AND NEW.membership_manifest_sha256 =
                campaign.accepted_set_manifest_sha256
          AND (
            (
              campaign.accepted_member_count = 0
              AND NOT EXISTS (
                SELECT 1
                FROM relay_container_drain_members AS member
                WHERE member.campaign_id = NEW.campaign_id
              )
            )
            OR (
              campaign.accepted_member_count > 0
              AND campaign.accepted_first_sequence = (
                SELECT member.accepted_sequence
                FROM relay_container_drain_members AS member
                WHERE member.campaign_id = NEW.campaign_id
                ORDER BY
                  member.accepted_sequence ASC,
                  member.operation_id ASC
                LIMIT 1
              )
              AND campaign.accepted_first_operation_id = (
                SELECT member.operation_id
                FROM relay_container_drain_members AS member
                WHERE member.campaign_id = NEW.campaign_id
                ORDER BY
                  member.accepted_sequence ASC,
                  member.operation_id ASC
                LIMIT 1
              )
              AND campaign.accepted_last_sequence = (
                SELECT member.accepted_sequence
                FROM relay_container_drain_members AS member
                WHERE member.campaign_id = NEW.campaign_id
                ORDER BY
                  member.accepted_sequence DESC,
                  member.operation_id DESC
                LIMIT 1
              )
              AND campaign.accepted_last_operation_id = (
                SELECT member.operation_id
                FROM relay_container_drain_members AS member
                WHERE member.campaign_id = NEW.campaign_id
                ORDER BY
                  member.accepted_sequence DESC,
                  member.operation_id DESC
                LIMIT 1
              )
            )
          )
      )
    )
  THEN RAISE(ABORT, 'drain membership seal is incomplete') END;

  SELECT CASE WHEN
    NEW.event_code = 'drain_sealed'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_drain_observations AS first_observation
      JOIN relay_container_drain_observations AS second_observation
        ON second_observation.observation_id_sha256 =
            NEW.second_observation_id_sha256
       AND second_observation.campaign_id =
            first_observation.campaign_id
      JOIN relay_container_reverse_sync_manifests AS reverse_sync
        ON reverse_sync.manifest_id_sha256 =
            NEW.reverse_sync_manifest_id_sha256
       AND reverse_sync.campaign_id =
            first_observation.campaign_id
      JOIN relay_container_drain_campaigns AS campaign
        ON campaign.campaign_id = first_observation.campaign_id
      WHERE first_observation.observation_id_sha256 =
              NEW.first_observation_id_sha256
        AND first_observation.campaign_id = NEW.campaign_id
        AND first_observation.observation_kind = 'global'
        AND second_observation.observation_kind = 'global'
        AND first_observation.campaign_event_sequence =
              campaign.state_version
        AND second_observation.campaign_event_sequence =
              campaign.state_version
        AND first_observation.request_id_sha256 <>
              second_observation.request_id_sha256
        AND first_observation.observer_identity_sha256 <>
              second_observation.observer_identity_sha256
        AND second_observation.observation_generation =
              first_observation.observation_generation + 1
        AND second_observation.observation_generation = (
              SELECT MAX(observation.observation_generation)
              FROM relay_container_drain_observations AS observation
              WHERE observation.campaign_id = NEW.campaign_id
                AND observation.observation_kind = 'global'
            )
        AND first_observation.state_digest_sha256 =
              second_observation.state_digest_sha256
        AND second_observation.observed_at -
              first_observation.observed_at >=
              campaign.stability_window_seconds
        AND first_observation.member_count =
              second_observation.member_count
        AND first_observation.member_closure_count =
              first_observation.member_count
        AND second_observation.member_closure_count =
              second_observation.member_count
        AND first_observation.member_closure_count = (
              SELECT COUNT(*)
              FROM relay_container_drain_observations AS closure
              WHERE closure.campaign_id = NEW.campaign_id
                AND closure.observation_kind = 'member_closure'
            )
        AND first_observation.quarantine_count =
              second_observation.quarantine_count
        AND first_observation.quarantine_count = (
              SELECT COUNT(*)
              FROM relay_container_ambiguity_quarantines AS quarantine
              WHERE quarantine.campaign_id = NEW.campaign_id
            )
        AND first_observation.reverse_manifest_count =
              second_observation.reverse_manifest_count
        AND first_observation.reverse_manifest_count = (
              SELECT COUNT(*)
              FROM relay_container_reverse_sync_manifests AS manifest
              WHERE manifest.campaign_id = NEW.campaign_id
            )
        AND first_observation.member_closure_manifest_sha256 =
              second_observation.member_closure_manifest_sha256
        AND first_observation.quarantine_manifest_sha256 =
              second_observation.quarantine_manifest_sha256
        AND first_observation.reverse_sync_manifest_sha256 =
              second_observation.reverse_sync_manifest_sha256
        AND first_observation.billing_conservation_sha256 =
              second_observation.billing_conservation_sha256
        AND first_observation.reverse_sync_manifest_sha256 =
              reverse_sync.manifest_digest_sha256
        AND reverse_sync.status = 'passed'
        AND reverse_sync.sync_generation = (
              SELECT MAX(manifest.sync_generation)
              FROM relay_container_reverse_sync_manifests AS manifest
              WHERE manifest.campaign_id = NEW.campaign_id
            )
        AND first_observation.d1_open_count = 0
        AND first_observation.billing_open_count = 0
        AND first_observation.outbox_open_count = 0
        AND first_observation.reconciliation_open_count = 0
        AND first_observation.r2_missing_count = 0
        AND first_observation.queue_open_count = 0
        AND first_observation.reverse_sync_open_count = 0
        AND first_observation.memory_batch_open_count = 0
        AND first_observation.unclassified_open_count = 0
        AND second_observation.d1_open_count = 0
        AND second_observation.billing_open_count = 0
        AND second_observation.outbox_open_count = 0
        AND second_observation.reconciliation_open_count = 0
        AND second_observation.r2_missing_count = 0
        AND second_observation.queue_open_count = 0
        AND second_observation.reverse_sync_open_count = 0
        AND second_observation.memory_batch_open_count = 0
        AND second_observation.unclassified_open_count = 0
        AND (
          SELECT COUNT(*)
          FROM relay_container_drain_shard_observations AS shard
          WHERE shard.observation_id_sha256 =
                  first_observation.observation_id_sha256
            AND shard.accepted_work_drained = 1
            AND shard.unclassified_operation_count = 0
        ) = campaign.shard_count
        AND (
          SELECT COUNT(*)
          FROM relay_container_drain_shard_observations AS shard
          WHERE shard.observation_id_sha256 =
                  second_observation.observation_id_sha256
            AND shard.accepted_work_drained = 1
            AND shard.unclassified_operation_count = 0
        ) = campaign.shard_count
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_drain_shard_observations AS first_shard
          LEFT JOIN relay_container_drain_shard_observations AS second_shard
            ON second_shard.observation_id_sha256 =
                second_observation.observation_id_sha256
           AND second_shard.shard_index = first_shard.shard_index
          WHERE first_shard.observation_id_sha256 =
                  first_observation.observation_id_sha256
            AND (
              second_shard.shard_index IS NULL
              OR second_shard.ring_generation IS NOT
                   first_shard.ring_generation
              OR second_shard.owner_generation IS NOT
                   first_shard.owner_generation
              OR second_shard.local_high_watermark IS NOT
                   first_shard.local_high_watermark
              OR second_shard.placement_attestation_digest_sha256 IS NOT
                   first_shard.placement_attestation_digest_sha256
              OR second_shard.snapshot_digest_sha256 IS NOT
                   first_shard.snapshot_digest_sha256
              OR second_shard.controller_state_digest_sha256 IS NOT
                   first_shard.controller_state_digest_sha256
              OR second_shard.execution_stop_eligible IS NOT
                   first_shard.execution_stop_eligible
              OR second_shard.accepted_work_drained IS NOT
                   first_shard.accepted_work_drained
              OR second_shard.executable_open_count IS NOT
                   first_shard.executable_open_count
              OR second_shard.final_ack_open_count IS NOT
                   first_shard.final_ack_open_count
              OR second_shard.ambiguity_open_count IS NOT
                   first_shard.ambiguity_open_count
              OR second_shard.unclassified_operation_count IS NOT
                   first_shard.unclassified_operation_count
            )
        )
    )
  THEN RAISE(ABORT, 'drain seal lacks two stable complete observations') END;

  SELECT CASE WHEN
    NEW.event_code = 'traffic_return_receipt_sealed'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_traffic_return_receipts AS receipt
      WHERE receipt.receipt_id_sha256 =
              NEW.traffic_return_receipt_id_sha256
        AND receipt.campaign_id = NEW.campaign_id
        AND receipt.eligible_for_traffic_return_review = 1
        AND receipt.traffic_return_authorized = 0
    )
  THEN RAISE(ABORT, 'traffic return event lacks eligibility receipt') END;
END;

CREATE TRIGGER relay_container_drain_event_apply
AFTER INSERT ON relay_container_drain_events
FOR EACH ROW
BEGIN
  UPDATE relay_container_drain_campaigns
  SET state = NEW.to_state,
      state_version = NEW.event_sequence,
      last_event_digest_sha256 = NEW.event_digest_sha256
  WHERE campaign_id = NEW.campaign_id;
END;

CREATE TRIGGER relay_container_drain_event_update_guard
BEFORE UPDATE ON relay_container_drain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain events are immutable');
END;

CREATE TRIGGER relay_container_drain_event_delete_guard
BEFORE DELETE ON relay_container_drain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain events are append-preserved');
END;
