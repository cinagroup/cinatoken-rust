-- Add an immutable, activation-linked placement identity without changing the
-- frozen 0054 activation or 0055 campaign/claim/consumption ABIs.
--
-- The current 0055 campaign v1 cannot authorize a restricted jurisdiction.
-- This migration therefore accepts only "default" rows. A later campaign
-- contract must replace the insert guard before eu/us/fedramp evidence can be
-- recorded.

CREATE TABLE relay_container_shard_placement_attestations (
  placement_attestation_digest_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(placement_attestation_digest_sha256) = 'text'
      AND length(placement_attestation_digest_sha256) = 64
      AND placement_attestation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
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
  durable_object_namespace_binding TEXT NOT NULL
    CHECK (durable_object_namespace_binding = 'RELAY_SHARDS'),
  durable_object_class TEXT NOT NULL
    CHECK (durable_object_class = 'RelayShardContainer'),
  jurisdiction TEXT NOT NULL
    CHECK (jurisdiction IN ('default', 'eu', 'us', 'fedramp', 'fedramp-high')),
  canonical_name_sha256 TEXT NOT NULL
    CHECK (
      typeof(canonical_name_sha256) = 'text'
      AND length(canonical_name_sha256) = 64
      AND canonical_name_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  object_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(object_id_sha256) = 'text'
      AND length(object_id_sha256) = 64
      AND object_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  shard_contract_version INTEGER NOT NULL
    CHECK (typeof(shard_contract_version) = 'integer' AND shard_contract_version = 1),
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
  shard_index INTEGER NOT NULL
    CHECK (
      typeof(shard_index) = 'integer'
      AND shard_index BETWEEN 0 AND shard_count - 1
    ),
  instance_name TEXT NOT NULL
    CHECK (
      typeof(instance_name) = 'text'
      AND instance_name = printf('cinatoken-relay-shard-v1-%04d', shard_index)
    ),
  activation_id INTEGER NOT NULL
    CHECK (typeof(activation_id) = 'integer' AND activation_id > 0),
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  readiness_result_sha256 TEXT NOT NULL
    CHECK (
      typeof(readiness_result_sha256) = 'text'
      AND length(readiness_result_sha256) = 64
      AND readiness_result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
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
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  UNIQUE (activation_id),
  UNIQUE (
    environment,
    controller_service_name,
    controller_version_id,
    jurisdiction,
    ring_generation,
    shard_index
  ),
  UNIQUE (
    environment,
    controller_service_name,
    controller_version_id,
    jurisdiction,
    object_id_sha256
  ),
  FOREIGN KEY (activation_id)
    REFERENCES relay_container_shard_activations(activation_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id, shard_index)
    REFERENCES relay_container_shard_activation_campaign_consumptions(
      campaign_id,
      shard_index
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_shard_placement_attestations_candidate
ON relay_container_shard_placement_attestations(
  environment,
  controller_service_name,
  controller_version_id,
  ring_generation,
  shard_index
);

CREATE INDEX idx_relay_container_shard_placement_attestations_object
ON relay_container_shard_placement_attestations(
  jurisdiction,
  object_id_sha256,
  recorded_at
);

CREATE TRIGGER relay_container_shard_placement_attestation_insert_guard
BEFORE INSERT ON relay_container_shard_placement_attestations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'shard placement attestation time must come from D1') END;

  SELECT CASE WHEN NEW.jurisdiction <> 'default'
  THEN RAISE(ABORT, 'restricted shard placement requires activation campaign v2') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_consumptions AS consumption
    JOIN relay_container_shard_activations AS activation
      ON activation.activation_id = NEW.activation_id
     AND activation.controller_version_id = consumption.controller_version_id
     AND activation.runtime_build_id = consumption.runtime_build_id
     AND activation.ring_generation = consumption.ring_generation
     AND activation.shard_index = consumption.shard_index
     AND activation.activation_digest_sha256 = consumption.activation_digest_sha256
    WHERE consumption.campaign_id = NEW.campaign_id
      AND consumption.shard_index = NEW.shard_index
      AND consumption.claim_digest_sha256 = NEW.claim_digest_sha256
      AND consumption.readiness_result_sha256 = NEW.readiness_result_sha256
      AND consumption.activation_digest_sha256 = NEW.activation_digest_sha256
      AND consumption.consumption_digest_sha256 = NEW.consumption_digest_sha256
      AND consumption.environment = NEW.environment
      AND consumption.controller_version_id = NEW.controller_version_id
      AND consumption.shard_contract_version = NEW.shard_contract_version
      AND consumption.ring_generation = NEW.ring_generation
      AND consumption.shard_count = NEW.shard_count
      AND consumption.instance_name = NEW.instance_name
  ) THEN RAISE(ABORT, 'shard placement attestation activation evidence mismatch') END;
END;

CREATE TRIGGER relay_container_shard_placement_attestation_update_guard
BEFORE UPDATE ON relay_container_shard_placement_attestations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement attestations are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_attestation_delete_guard
BEFORE DELETE ON relay_container_shard_placement_attestations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement attestations are append-preserved');
END;
