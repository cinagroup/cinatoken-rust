CREATE TABLE shard_placement_authority_execution_claims (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  claim_digest_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  ledger_version INTEGER NOT NULL,
  ledger_head_sha256 TEXT NOT NULL,
  last_completed_ordinal INTEGER NOT NULL,
  inflight_operation_ordinal INTEGER NOT NULL,
  inflight_operation_id_sha256 TEXT NOT NULL,
  inflight_readback_only INTEGER NOT NULL,
  enable_intent_seen INTEGER NOT NULL,
  disable_confirmed INTEGER NOT NULL,
  application_ticket_id_sha256 TEXT NOT NULL,
  application_database_identity_sha256 TEXT NOT NULL,
  authority_database_identity_sha256 TEXT NOT NULL,
  ledger_identity_sha256 TEXT NOT NULL,
  claim_owner_sha256 TEXT NOT NULL,
  lease_owner_sha256 TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  normal_deadline_at INTEGER NOT NULL,
  permit_expires_at INTEGER NOT NULL,
  renewal_count INTEGER NOT NULL,
  takeover_count INTEGER NOT NULL
);

CREATE TABLE shard_placement_authority_revocations (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE shard_placement_authority_operation_five_dispatch_claims (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  dispatch_claim_digest_sha256 TEXT NOT NULL,
  claim_digest_sha256 TEXT NOT NULL,
  application_ticket_id_sha256 TEXT NOT NULL
);

CREATE TABLE shard_placement_authority_operation_five_dispatch_consumptions (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  claim_digest_sha256 TEXT NOT NULL,
  authority_dispatch_claim_digest_sha256 TEXT NOT NULL,
  receipt_digest_sha256 TEXT NOT NULL,
  application_dispatch_consumption_digest_sha256 TEXT NOT NULL,
  application_ticket_id_sha256 TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  application_database_identity_sha256 TEXT NOT NULL,
  application_version_id TEXT NOT NULL,
  authority_database_identity_sha256 TEXT NOT NULL,
  authority_ledger_identity_sha256 TEXT NOT NULL,
  authority_ledger_head_sha256 TEXT NOT NULL,
  authority_version_id TEXT NOT NULL,
  dispatch_owner_sha256 TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  normal_deadline_at INTEGER NOT NULL,
  permit_expires_at INTEGER NOT NULL,
  controller_service_name TEXT NOT NULL,
  controller_enable_operation_id_sha256 TEXT NOT NULL,
  controller_baseline_version_id TEXT NOT NULL,
  controller_enabled_version_id TEXT NOT NULL,
  send_attempt_limit INTEGER NOT NULL,
  retry_limit INTEGER NOT NULL
);

CREATE TABLE shard_placement_authority_operation_five_dispatch_consumption_recoveries (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
);
