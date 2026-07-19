-- Three-stage shard activation authority:
--   1. an admin creates one bounded campaign;
--   2. the Controller claims one shard before invoking its Durable Object;
--   3. the Controller finalizes the exact claim after readiness succeeds.
-- Completion seals are automatic. Other terminal seals are explicit.

CREATE TABLE relay_container_shard_activation_campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_nonce_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_nonce_sha256) = 'text'
      AND length(campaign_nonce_sha256) = 64
      AND campaign_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  action_gate_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(action_gate_inventory_sha256) = 'text'
      AND length(action_gate_inventory_sha256) = 64
      AND action_gate_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  action_gate_count INTEGER NOT NULL
    CHECK (typeof(action_gate_count) = 'integer' AND action_gate_count = 22),
  all_action_gates_false INTEGER NOT NULL
    CHECK (typeof(all_action_gates_false) = 'integer' AND all_action_gates_false = 1),
  foundation_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(foundation_manifest_sha256) = 'text'
      AND length(foundation_manifest_sha256) = 64
      AND foundation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_build_id TEXT NOT NULL
    CHECK (
      typeof(runtime_build_id) = 'text'
      AND length(runtime_build_id) = 64
      AND runtime_build_id NOT GLOB '*[^0-9a-f]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  shard_contract_version INTEGER NOT NULL
    CHECK (
      typeof(shard_contract_version) = 'integer'
      AND shard_contract_version BETWEEN 1 AND 1000000
    ),
  runtime_protocol_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_protocol_version) = 'integer'
      AND runtime_protocol_version BETWEEN 1 AND 1000000
    ),
  runtime_contract_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_contract_version) = 'integer'
      AND runtime_contract_version BETWEEN 1 AND 1000000
    ),
  activation_generation INTEGER NOT NULL
    CHECK (
      typeof(activation_generation) = 'integer'
      AND activation_generation BETWEEN 1 AND 1000000
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  created_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(created_by_admin_id) = 'integer'
      AND created_by_admin_id > 0
    ),
  campaign_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  expires_at INTEGER NOT NULL
    CHECK (
      typeof(expires_at) = 'integer'
      AND expires_at > created_at
      AND expires_at <= created_at + 3600
    )
);

CREATE TABLE relay_container_shard_activation_campaign_claims (
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  presented_nonce_sha256 TEXT NOT NULL
    CHECK (
      typeof(presented_nonce_sha256) = 'text'
      AND length(presented_nonce_sha256) = 64
      AND presented_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  action_gate_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(action_gate_inventory_sha256) = 'text'
      AND length(action_gate_inventory_sha256) = 64
      AND action_gate_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  action_gate_count INTEGER NOT NULL
    CHECK (typeof(action_gate_count) = 'integer' AND action_gate_count = 22),
  all_action_gates_false INTEGER NOT NULL
    CHECK (typeof(all_action_gates_false) = 'integer' AND all_action_gates_false = 1),
  foundation_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(foundation_manifest_sha256) = 'text'
      AND length(foundation_manifest_sha256) = 64
      AND foundation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_build_id TEXT NOT NULL
    CHECK (
      typeof(runtime_build_id) = 'text'
      AND length(runtime_build_id) = 64
      AND runtime_build_id NOT GLOB '*[^0-9a-f]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  instance_name TEXT NOT NULL
    CHECK (
      typeof(instance_name) = 'text'
      AND instance_name = printf('cinatoken-relay-shard-v1-%04d', shard_index)
    ),
  shard_contract_version INTEGER NOT NULL
    CHECK (
      typeof(shard_contract_version) = 'integer'
      AND shard_contract_version BETWEEN 1 AND 1000000
    ),
  runtime_protocol_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_protocol_version) = 'integer'
      AND runtime_protocol_version BETWEEN 1 AND 1000000
    ),
  runtime_contract_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_contract_version) = 'integer'
      AND runtime_contract_version BETWEEN 1 AND 1000000
    ),
  activation_generation INTEGER NOT NULL
    CHECK (
      typeof(activation_generation) = 'integer'
      AND activation_generation BETWEEN 1 AND 1000000
    ),
  probe_id TEXT NOT NULL
    CHECK (
      typeof(probe_id) = 'text'
      AND length(probe_id) = 64
      AND probe_id NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(claimed_at) = 'integer' AND claimed_at > 0),
  PRIMARY KEY (campaign_id, shard_index),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_shard_activation_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE relay_container_shard_activation_campaign_consumptions (
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  probe_id TEXT NOT NULL
    CHECK (
      typeof(probe_id) = 'text'
      AND length(probe_id) = 64
      AND probe_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  action_gate_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(action_gate_inventory_sha256) = 'text'
      AND length(action_gate_inventory_sha256) = 64
      AND action_gate_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  action_gate_count INTEGER NOT NULL
    CHECK (typeof(action_gate_count) = 'integer' AND action_gate_count = 22),
  all_action_gates_false INTEGER NOT NULL
    CHECK (typeof(all_action_gates_false) = 'integer' AND all_action_gates_false = 1),
  foundation_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(foundation_manifest_sha256) = 'text'
      AND length(foundation_manifest_sha256) = 64
      AND foundation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  instance_name TEXT NOT NULL
    CHECK (
      typeof(instance_name) = 'text'
      AND instance_name = printf('cinatoken-relay-shard-v1-%04d', shard_index)
    ),
  shard_contract_version INTEGER NOT NULL
    CHECK (
      typeof(shard_contract_version) = 'integer'
      AND shard_contract_version BETWEEN 1 AND 1000000
    ),
  runtime_protocol_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_protocol_version) = 'integer'
      AND runtime_protocol_version BETWEEN 1 AND 1000000
    ),
  runtime_contract_version INTEGER NOT NULL
    CHECK (
      typeof(runtime_contract_version) = 'integer'
      AND runtime_contract_version BETWEEN 1 AND 1000000
    ),
  runtime_build_id TEXT NOT NULL
    CHECK (
      typeof(runtime_build_id) = 'text'
      AND length(runtime_build_id) = 64
      AND runtime_build_id NOT GLOB '*[^0-9a-f]*'
    ),
  activation_generation INTEGER NOT NULL
    CHECK (
      typeof(activation_generation) = 'integer'
      AND activation_generation BETWEEN 1 AND 1000000
    ),
  activation_probe_generation INTEGER NOT NULL
    CHECK (
      typeof(activation_probe_generation) = 'integer'
      AND activation_probe_generation BETWEEN 1 AND 1000000
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  container_status TEXT NOT NULL
    CHECK (container_status = 'healthy'),
  readiness_result_code TEXT NOT NULL
    CHECK (readiness_result_code = 'process_ready_execution_disabled'),
  readiness_result_sha256 TEXT NOT NULL
    CHECK (
      typeof(readiness_result_sha256) = 'text'
      AND length(readiness_result_sha256) = 64
      AND readiness_result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  process_ready INTEGER NOT NULL
    CHECK (process_ready = 1),
  runtime_execution_enabled INTEGER NOT NULL
    CHECK (runtime_execution_enabled = 0),
  controller_execution_enabled INTEGER NOT NULL
    CHECK (controller_execution_enabled = 0),
  activation_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(activation_digest_sha256) = 'text'
      AND length(activation_digest_sha256) = 64
      AND activation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  consumption_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(consumption_digest_sha256) = 'text'
      AND length(consumption_digest_sha256) = 64
      AND consumption_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  readiness_checked_at INTEGER NOT NULL
    CHECK (typeof(readiness_checked_at) = 'integer' AND readiness_checked_at > 0),
  consumed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(consumed_at) = 'integer' AND consumed_at > 0),
  PRIMARY KEY (campaign_id, shard_index),
  FOREIGN KEY (campaign_id, shard_index)
    REFERENCES relay_container_shard_activation_campaign_claims(
      campaign_id,
      shard_index
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE relay_container_shard_activation_campaign_seals (
  campaign_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  consumed_shard_count INTEGER NOT NULL
    CHECK (
      typeof(consumed_shard_count) = 'integer'
      AND consumed_shard_count BETWEEN 0 AND 1024
    ),
  seal_reason TEXT NOT NULL
    CHECK (seal_reason IN ('complete', 'failed', 'expired', 'aborted')),
  seal_detail_code TEXT NOT NULL
    CHECK (
      seal_detail_code IN (
        'all_shards_consumed',
        'claim_execution_failed',
        'readiness_rejected',
        'campaign_expired',
        'operator_aborted',
        'candidate_superseded'
      )
    ),
  last_consumption_digest_sha256 TEXT
    CHECK (
      last_consumption_digest_sha256 IS NULL
      OR (
        typeof(last_consumption_digest_sha256) = 'text'
        AND length(last_consumption_digest_sha256) = 64
        AND last_consumption_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  sealed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(sealed_at) = 'integer' AND sealed_at > 0),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_shard_activation_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE VIEW relay_container_shard_activation_campaign_expiry_candidates AS
SELECT
  campaign.campaign_id,
  campaign.campaign_digest_sha256,
  (
    SELECT COUNT(*)
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = campaign.campaign_id
  ) AS consumed_shard_count,
  (
    SELECT consumption.consumption_digest_sha256
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = campaign.campaign_id
    ORDER BY consumption.consumed_at DESC, consumption.shard_index DESC
    LIMIT 1
  ) AS last_consumption_digest_sha256
FROM relay_container_shard_activation_campaigns AS campaign
WHERE campaign.expires_at <= unixepoch()
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_seals AS seal
    WHERE seal.campaign_id = campaign.campaign_id
  )
  AND (
    SELECT COUNT(*)
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = campaign.campaign_id
  ) < campaign.shard_count;

-- Canonical Worker minute-cron materialization. It is intentionally explicit
-- and idempotent; no claim or consumption trigger materializes expiry:
-- INSERT OR IGNORE INTO relay_container_shard_activation_campaign_seals (
--   campaign_id, campaign_digest_sha256, consumed_shard_count, seal_reason,
--   seal_detail_code, last_consumption_digest_sha256, sealed_at
-- )
-- SELECT campaign_id, campaign_digest_sha256, consumed_shard_count, 'expired',
--   'campaign_expired', last_consumption_digest_sha256, unixepoch()
-- FROM relay_container_shard_activation_campaign_expiry_candidates;

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaigns_nonce
  ON relay_container_shard_activation_campaigns(campaign_nonce_sha256);

CREATE INDEX idx_relay_container_shard_activation_campaigns_candidate
  ON relay_container_shard_activation_campaigns(
    controller_version_id,
    runtime_build_id,
    ring_generation,
    expires_at,
    campaign_id
  );

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_claims_probe
  ON relay_container_shard_activation_campaign_claims(probe_id);

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_claims_digest
  ON relay_container_shard_activation_campaign_claims(claim_digest_sha256);

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_claims_instance
  ON relay_container_shard_activation_campaign_claims(
    campaign_id,
    instance_name
  );

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_consumptions_activation
  ON relay_container_shard_activation_campaign_consumptions(
    activation_digest_sha256
  );

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_consumptions_consumption
  ON relay_container_shard_activation_campaign_consumptions(
    consumption_digest_sha256
  );

CREATE UNIQUE INDEX idx_relay_container_shard_activation_campaign_consumptions_instance
  ON relay_container_shard_activation_campaign_consumptions(
    campaign_id,
    instance_name
  );

CREATE TRIGGER relay_container_shard_activation_campaign_insert_guard
BEFORE INSERT ON relay_container_shard_activation_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at < unixepoch() - 5
    OR NEW.created_at > unixepoch() + 5
  THEN RAISE(ABORT, 'relay container shard activation campaign creation time is outside D1 clock tolerance') END;

  SELECT CASE WHEN NEW.expires_at < unixepoch() + 60
    OR NEW.expires_at > unixepoch() + 3600
  THEN RAISE(ABORT, 'relay container shard activation campaign expiry is outside the D1 window') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.controller_version_id = NEW.controller_version_id
      AND campaign.action_gate_inventory_sha256 <> NEW.action_gate_inventory_sha256
  ) THEN RAISE(ABORT, 'relay container shard activation controller action gate inventory mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activations AS activation
    WHERE activation.controller_version_id = NEW.controller_version_id
      AND activation.runtime_build_id = NEW.runtime_build_id
      AND activation.ring_generation = NEW.ring_generation
  ) THEN RAISE(ABORT, 'relay container shard activation campaign candidate already activated') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.controller_version_id = NEW.controller_version_id
      AND campaign.runtime_build_id = NEW.runtime_build_id
      AND campaign.ring_generation = NEW.ring_generation
      AND unixepoch() < campaign.expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_shard_activation_campaign_seals AS seal
        WHERE seal.campaign_id = campaign.campaign_id
      )
  ) THEN RAISE(ABORT, 'relay container shard activation candidate already has an active campaign') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.controller_version_id = NEW.controller_version_id
      AND campaign.runtime_build_id = NEW.runtime_build_id
      AND campaign.ring_generation = NEW.ring_generation
      AND NOT (
        EXISTS (
          SELECT 1
          FROM relay_container_shard_activation_campaign_seals AS seal
          WHERE seal.campaign_id = campaign.campaign_id
            AND seal.seal_reason IN ('expired', 'aborted')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_shard_activation_campaign_claims AS claim
          WHERE claim.campaign_id = campaign.campaign_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_shard_activation_campaign_consumptions AS consumption
          WHERE consumption.campaign_id = campaign.campaign_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_shard_activations AS activation
          WHERE activation.controller_version_id = campaign.controller_version_id
            AND activation.runtime_build_id = campaign.runtime_build_id
            AND activation.ring_generation = campaign.ring_generation
        )
      )
  ) THEN RAISE(ABORT, 'relay container shard activation candidate is not reusable') END;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_update_guard
BEFORE UPDATE ON relay_container_shard_activation_campaigns
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_delete_guard
BEFORE DELETE ON relay_container_shard_activation_campaigns
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_claim_insert_guard
BEFORE INSERT ON relay_container_shard_activation_campaign_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
  ) THEN RAISE(ABORT, 'relay container shard activation campaign does not exist') END;

  SELECT CASE WHEN NEW.claimed_at <> unixepoch()
  THEN RAISE(ABORT, 'relay container shard activation claim time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.created_at <= unixepoch()
      AND unixepoch() < campaign.expires_at
  ) THEN RAISE(ABORT, 'relay container shard activation campaign is outside its D1 validity window') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_seals AS seal
    WHERE seal.campaign_id = NEW.campaign_id
  ) THEN RAISE(ABORT, 'relay container shard activation campaign is sealed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.campaign_nonce_sha256 = NEW.presented_nonce_sha256
  ) THEN RAISE(ABORT, 'relay container shard activation campaign nonce mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.campaign_digest_sha256 = NEW.campaign_digest_sha256
      AND campaign.controller_version_id = NEW.controller_version_id
      AND campaign.action_gate_inventory_sha256 = NEW.action_gate_inventory_sha256
      AND campaign.action_gate_count = NEW.action_gate_count
      AND campaign.all_action_gates_false = NEW.all_action_gates_false
      AND campaign.foundation_manifest_sha256 = NEW.foundation_manifest_sha256
      AND campaign.runtime_build_id = NEW.runtime_build_id
      AND campaign.ring_generation = NEW.ring_generation
      AND campaign.shard_count = NEW.shard_count
      AND campaign.shard_contract_version = NEW.shard_contract_version
      AND campaign.runtime_protocol_version = NEW.runtime_protocol_version
      AND campaign.runtime_contract_version = NEW.runtime_contract_version
      AND campaign.activation_generation = NEW.activation_generation
      AND campaign.environment = NEW.environment
  ) THEN RAISE(ABORT, 'relay container shard activation campaign candidate mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND NEW.shard_index BETWEEN 0 AND campaign.shard_count - 1
      AND NEW.instance_name = printf(
        'cinatoken-relay-shard-v1-%04d',
        NEW.shard_index
      )
  ) THEN RAISE(ABORT, 'relay container shard activation claim identity mismatch') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_claims AS claim
    WHERE claim.campaign_id = NEW.campaign_id
      AND claim.shard_index = NEW.shard_index
  ) THEN RAISE(ABORT, 'relay container shard activation claim replayed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = NEW.campaign_id
      AND consumption.shard_index = NEW.shard_index
  ) THEN RAISE(ABORT, 'relay container shard activation shard already consumed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activations AS activation
    WHERE activation.controller_version_id = NEW.controller_version_id
      AND activation.runtime_build_id = NEW.runtime_build_id
      AND activation.ring_generation = NEW.ring_generation
      AND (
        activation.shard_index = NEW.shard_index
        OR activation.instance_name = NEW.instance_name
      )
  ) THEN RAISE(ABORT, 'relay container shard activation claim already has activation evidence') END;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_claim_update_guard
BEFORE UPDATE ON relay_container_shard_activation_campaign_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign claim rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_claim_delete_guard
BEFORE DELETE ON relay_container_shard_activation_campaign_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign claim rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_consumption_insert_guard
BEFORE INSERT ON relay_container_shard_activation_campaign_consumptions
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_claims AS claim
    WHERE claim.campaign_id = NEW.campaign_id
      AND claim.shard_index = NEW.shard_index
  ) THEN RAISE(ABORT, 'relay container shard activation consumption requires a claim') END;

  SELECT CASE WHEN NEW.consumed_at <> unixepoch()
  THEN RAISE(ABORT, 'relay container shard activation consumption time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.created_at <= unixepoch()
      AND unixepoch() < campaign.expires_at
  ) THEN RAISE(ABORT, 'relay container shard activation campaign is outside its D1 validity window') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_seals AS seal
    WHERE seal.campaign_id = NEW.campaign_id
  ) THEN RAISE(ABORT, 'relay container shard activation campaign is sealed') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_claims AS claim
    WHERE claim.campaign_id = NEW.campaign_id
      AND claim.shard_index = NEW.shard_index
      AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
      AND claim.probe_id = NEW.probe_id
      AND claim.campaign_digest_sha256 = NEW.campaign_digest_sha256
      AND claim.controller_version_id = NEW.controller_version_id
      AND claim.action_gate_inventory_sha256 = NEW.action_gate_inventory_sha256
      AND claim.action_gate_count = NEW.action_gate_count
      AND claim.all_action_gates_false = NEW.all_action_gates_false
      AND claim.foundation_manifest_sha256 = NEW.foundation_manifest_sha256
      AND claim.runtime_build_id = NEW.runtime_build_id
      AND claim.ring_generation = NEW.ring_generation
      AND claim.shard_count = NEW.shard_count
      AND claim.instance_name = NEW.instance_name
      AND claim.shard_contract_version = NEW.shard_contract_version
      AND claim.runtime_protocol_version = NEW.runtime_protocol_version
      AND claim.runtime_contract_version = NEW.runtime_contract_version
      AND claim.activation_generation = NEW.activation_generation
      AND claim.environment = NEW.environment
      AND claim.claimed_at <= unixepoch()
  ) THEN RAISE(ABORT, 'relay container shard activation consumption claim mismatch') END;

  SELECT CASE WHEN NEW.container_status <> 'healthy'
    OR NEW.readiness_result_code <> 'process_ready_execution_disabled'
    OR NEW.process_ready <> 1
    OR NEW.runtime_execution_enabled <> 0
    OR NEW.controller_execution_enabled <> 0
    OR typeof(NEW.activation_probe_generation) <> 'integer'
    OR NEW.activation_probe_generation NOT BETWEEN 1 AND 1000000
  THEN RAISE(ABORT, 'relay container shard activation consumption readiness mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_claims AS claim
    WHERE claim.campaign_id = NEW.campaign_id
      AND claim.shard_index = NEW.shard_index
      AND NEW.readiness_checked_at BETWEEN claim.claimed_at AND unixepoch()
  ) THEN RAISE(ABORT, 'relay container shard activation readiness time is invalid') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = NEW.campaign_id
      AND consumption.shard_index = NEW.shard_index
  ) THEN RAISE(ABORT, 'relay container shard activation consumption replayed') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_shard_activations AS activation
    WHERE activation.controller_version_id = NEW.controller_version_id
      AND activation.runtime_build_id = NEW.runtime_build_id
      AND activation.ring_generation = NEW.ring_generation
      AND (
        activation.shard_index = NEW.shard_index
        OR activation.instance_name = NEW.instance_name
      )
  ) THEN RAISE(ABORT, 'relay container shard activation consumption already has activation evidence') END;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_consumption_apply
AFTER INSERT ON relay_container_shard_activation_campaign_consumptions
FOR EACH ROW
BEGIN
  INSERT INTO relay_container_shard_activations (
    controller_version_id,
    ring_generation,
    shard_count,
    shard_index,
    instance_name,
    shard_contract_version,
    runtime_protocol_version,
    runtime_contract_version,
    runtime_build_id,
    activation_generation,
    activation_probe_generation,
    environment,
    container_status,
    readiness_result_code,
    process_ready,
    runtime_execution_enabled,
    controller_execution_enabled,
    activation_digest_sha256,
    activated_at
  ) VALUES (
    NEW.controller_version_id,
    NEW.ring_generation,
    NEW.shard_count,
    NEW.shard_index,
    NEW.instance_name,
    NEW.shard_contract_version,
    NEW.runtime_protocol_version,
    NEW.runtime_contract_version,
    NEW.runtime_build_id,
    NEW.activation_generation,
    NEW.activation_probe_generation,
    NEW.environment,
    NEW.container_status,
    NEW.readiness_result_code,
    NEW.process_ready,
    NEW.runtime_execution_enabled,
    NEW.controller_execution_enabled,
    NEW.activation_digest_sha256,
    NEW.readiness_checked_at
  );

  INSERT INTO relay_container_shard_activation_campaign_seals (
    campaign_id,
    campaign_digest_sha256,
    consumed_shard_count,
    seal_reason,
    seal_detail_code,
    last_consumption_digest_sha256,
    sealed_at
  )
  SELECT
    campaign.campaign_id,
    campaign.campaign_digest_sha256,
    campaign.shard_count,
    'complete',
    'all_shards_consumed',
    (
      SELECT consumption.consumption_digest_sha256
      FROM relay_container_shard_activation_campaign_consumptions AS consumption
      WHERE consumption.campaign_id = campaign.campaign_id
      ORDER BY consumption.consumed_at DESC, consumption.shard_index DESC
      LIMIT 1
    ),
    unixepoch()
  FROM relay_container_shard_activation_campaigns AS campaign
  WHERE campaign.campaign_id = NEW.campaign_id
    AND (
      SELECT COUNT(*)
      FROM relay_container_shard_activation_campaign_consumptions AS consumption
      WHERE consumption.campaign_id = campaign.campaign_id
    ) = campaign.shard_count;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_consumption_update_guard
BEFORE UPDATE ON relay_container_shard_activation_campaign_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign consumption rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_consumption_delete_guard
BEFORE DELETE ON relay_container_shard_activation_campaign_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign consumption rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_seal_insert_guard
BEFORE INSERT ON relay_container_shard_activation_campaign_seals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
  ) THEN RAISE(ABORT, 'relay container shard activation seal campaign does not exist') END;

  SELECT CASE WHEN NEW.sealed_at <> unixepoch()
  THEN RAISE(ABORT, 'relay container shard activation seal time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.campaign_digest_sha256 = NEW.campaign_digest_sha256
      AND campaign.created_at <= unixepoch()
  ) THEN RAISE(ABORT, 'relay container shard activation campaign seal identity mismatch') END;

  SELECT CASE WHEN NEW.consumed_shard_count <> (
    SELECT COUNT(*)
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = NEW.campaign_id
  ) THEN RAISE(ABORT, 'relay container shard activation campaign seal count mismatch') END;

  SELECT CASE WHEN NOT (
    (NEW.consumed_shard_count = 0 AND NEW.last_consumption_digest_sha256 IS NULL)
    OR
    (NEW.consumed_shard_count > 0 AND NEW.last_consumption_digest_sha256 = (
      SELECT consumption.consumption_digest_sha256
      FROM relay_container_shard_activation_campaign_consumptions AS consumption
      WHERE consumption.campaign_id = NEW.campaign_id
      ORDER BY consumption.consumed_at DESC, consumption.shard_index DESC
      LIMIT 1
    ))
  ) THEN RAISE(ABORT, 'relay container shard activation campaign seal last consumption mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    WHERE campaign.campaign_id = NEW.campaign_id
      AND (
        (NEW.seal_reason = 'complete'
          AND NEW.seal_detail_code = 'all_shards_consumed'
          AND NEW.consumed_shard_count = campaign.shard_count)
        OR
        (NEW.seal_reason = 'failed'
          AND NEW.seal_detail_code IN ('claim_execution_failed', 'readiness_rejected')
          AND NEW.consumed_shard_count < campaign.shard_count)
        OR
        (NEW.seal_reason = 'expired'
          AND NEW.seal_detail_code = 'campaign_expired'
          AND NEW.consumed_shard_count < campaign.shard_count
          AND campaign.expires_at <= unixepoch())
        OR
        (NEW.seal_reason = 'aborted'
          AND NEW.seal_detail_code IN ('operator_aborted', 'candidate_superseded')
          AND NEW.consumed_shard_count < campaign.shard_count)
      )
  ) THEN RAISE(ABORT, 'relay container shard activation campaign seal reason mismatch') END;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_seal_update_guard
BEFORE UPDATE ON relay_container_shard_activation_campaign_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign seal rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_seal_delete_guard
BEFORE DELETE ON relay_container_shard_activation_campaign_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation campaign seal rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_authority_guard
BEFORE INSERT ON relay_container_shard_activations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_shard_activation_campaign_consumptions AS consumption
  JOIN relay_container_shard_activation_campaign_claims AS claim
    ON claim.campaign_id = consumption.campaign_id
   AND claim.shard_index = consumption.shard_index
   AND claim.claim_digest_sha256 = consumption.claim_digest_sha256
   AND claim.probe_id = consumption.probe_id
  JOIN relay_container_shard_activation_campaigns AS campaign
    ON campaign.campaign_id = claim.campaign_id
   AND campaign.campaign_digest_sha256 = claim.campaign_digest_sha256
   AND campaign.controller_version_id = claim.controller_version_id
   AND campaign.action_gate_inventory_sha256 = claim.action_gate_inventory_sha256
   AND campaign.runtime_build_id = claim.runtime_build_id
   AND campaign.ring_generation = claim.ring_generation
  WHERE consumption.controller_version_id = NEW.controller_version_id
    AND consumption.ring_generation = NEW.ring_generation
    AND consumption.shard_count = NEW.shard_count
    AND consumption.shard_index = NEW.shard_index
    AND consumption.instance_name = NEW.instance_name
    AND consumption.shard_contract_version = NEW.shard_contract_version
    AND consumption.runtime_protocol_version = NEW.runtime_protocol_version
    AND consumption.runtime_contract_version = NEW.runtime_contract_version
    AND consumption.runtime_build_id = NEW.runtime_build_id
    AND consumption.activation_generation = NEW.activation_generation
    AND consumption.activation_probe_generation = NEW.activation_probe_generation
    AND consumption.environment = NEW.environment
    AND consumption.container_status = NEW.container_status
    AND consumption.readiness_result_code = NEW.readiness_result_code
    AND consumption.process_ready = NEW.process_ready
    AND consumption.runtime_execution_enabled = NEW.runtime_execution_enabled
    AND consumption.controller_execution_enabled = NEW.controller_execution_enabled
    AND consumption.activation_digest_sha256 = NEW.activation_digest_sha256
    AND consumption.readiness_checked_at = NEW.activated_at
)
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation requires a matching final consumption');
END;
