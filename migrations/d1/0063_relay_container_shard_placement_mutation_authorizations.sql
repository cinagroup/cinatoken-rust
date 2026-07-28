-- Bind the default-only placement writer to one signed, single-use staging
-- authorization. The permit is verified before this row is inserted; D1 owns
-- replay prevention, time-of-consumption, campaign linkage, and the final
-- placement insert guard.

CREATE TABLE relay_container_shard_placement_mutation_authorizations (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(execution_nonce_sha256) = 'text'
      AND length(execution_nonce_sha256) = 64
      AND execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_nonce_sha256) = 'text'
      AND length(campaign_nonce_sha256) = 64
      AND campaign_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  subject_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(subject_digest_sha256) = 'text'
      AND length(subject_digest_sha256) = 64
      AND subject_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  authorization_contract TEXT NOT NULL
    CHECK (
      authorization_contract =
        'cinatoken-relay-shard-placement-mutation-authorization-v1'
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
  signer_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(signer_spki_sha256) = 'text'
      AND length(signer_spki_sha256) = 64
      AND signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  controller_service_name TEXT NOT NULL
    CHECK (
      controller_service_name = 'cinatoken-container-controller-staging'
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
  campaign_lifetime_seconds INTEGER NOT NULL
    CHECK (
      typeof(campaign_lifetime_seconds) = 'integer'
      AND campaign_lifetime_seconds BETWEEN 60 AND 3600
    ),
  permit_issued_at INTEGER NOT NULL
    CHECK (typeof(permit_issued_at) = 'integer' AND permit_issued_at > 0),
  permit_expires_at INTEGER NOT NULL
    CHECK (
      typeof(permit_expires_at) = 'integer'
      AND permit_expires_at >= permit_issued_at + 60
      AND permit_expires_at <= permit_issued_at + 600
    ),
  campaign_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_expires_at INTEGER NOT NULL
    CHECK (
      typeof(campaign_expires_at) = 'integer'
      AND campaign_expires_at > 0
    ),
  consumed_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(consumed_by_admin_id) = 'integer'
      AND consumed_by_admin_id > 0
    ),
  consumed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(consumed_at) = 'integer' AND consumed_at > 0),
  CHECK (
    authorization_id_sha256 <> execution_nonce_sha256
    AND authorization_id_sha256 <> campaign_nonce_sha256
    AND execution_nonce_sha256 <> campaign_nonce_sha256
  ),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_shard_activation_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_shard_placement_authorizations_candidate
ON relay_container_shard_placement_mutation_authorizations(
  controller_version_id,
  ring_generation,
  campaign_id
);

CREATE TRIGGER relay_container_shard_placement_authorization_insert_guard
BEFORE INSERT ON relay_container_shard_placement_mutation_authorizations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.consumed_at <> unixepoch()
  THEN RAISE(ABORT, 'shard placement authorization time must come from D1') END;

  SELECT CASE WHEN
    NEW.permit_issued_at > unixepoch() + 120
    OR NEW.permit_expires_at < unixepoch() + 60
  THEN RAISE(ABORT, 'shard placement authorization permit is outside its D1 window') END;

END;

CREATE TRIGGER relay_container_shard_placement_authorization_update_guard
BEFORE UPDATE ON relay_container_shard_placement_mutation_authorizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement authorizations are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_authorization_delete_guard
BEFORE DELETE ON relay_container_shard_placement_mutation_authorizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement authorizations are append-preserved');
END;

CREATE TRIGGER relay_container_shard_activation_campaign_authorization_guard
AFTER INSERT ON relay_container_shard_activation_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_mutation_authorizations AS authorization
    WHERE authorization.campaign_id = NEW.campaign_id
      AND authorization.campaign_digest_sha256 =
            NEW.campaign_digest_sha256
      AND authorization.campaign_nonce_sha256 =
            NEW.campaign_nonce_sha256
      AND authorization.controller_version_id = NEW.controller_version_id
      AND authorization.action_gate_inventory_sha256 =
            NEW.action_gate_inventory_sha256
      AND NEW.action_gate_count = 22
      AND NEW.all_action_gates_false = 1
      AND authorization.foundation_manifest_sha256 =
            NEW.foundation_manifest_sha256
      AND authorization.runtime_build_id = NEW.runtime_build_id
      AND authorization.ring_generation = NEW.ring_generation
      AND authorization.shard_count = NEW.shard_count
      AND NEW.shard_contract_version = 1
      AND authorization.environment = NEW.environment
      AND authorization.consumed_by_admin_id = NEW.created_by_admin_id
      AND abs(authorization.consumed_at - NEW.created_at) <= 5
      AND authorization.campaign_expires_at = NEW.expires_at
      AND NEW.expires_at - NEW.created_at =
            authorization.campaign_lifetime_seconds
  ) THEN RAISE(ABORT, 'shard activation campaign authorization mismatch') END;
END;

DROP TRIGGER relay_container_shard_placement_attestation_insert_guard;

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
    FROM relay_container_shard_placement_mutation_authorizations AS authorization
    WHERE authorization.campaign_id = NEW.campaign_id
      AND authorization.environment = NEW.environment
      AND authorization.controller_service_name =
            NEW.controller_service_name
      AND authorization.controller_version_id = NEW.controller_version_id
      AND authorization.ring_generation = NEW.ring_generation
      AND authorization.shard_count = NEW.shard_count
      AND authorization.consumed_at <= NEW.recorded_at
      AND NEW.recorded_at < authorization.campaign_expires_at
  ) THEN RAISE(ABORT, 'shard placement mutation authorization is unavailable') END;

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
