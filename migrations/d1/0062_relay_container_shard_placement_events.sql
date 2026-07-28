-- Add a database-ordered event sequence for immutable placement attestations.
-- activation_id is an association key, not an insertion-order watermark: a
-- placement may be appended later for an older activation. The sidecar ledger
-- gives read-only evidence collectors a real frozen keyset boundary without
-- altering the published 0061 attestation row ABI.

CREATE TABLE relay_container_shard_placement_events (
  placement_event_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK (
      typeof(placement_event_sequence) = 'integer'
      AND placement_event_sequence > 0
    ),
  placement_attestation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(placement_attestation_digest_sha256) = 'text'
      AND length(placement_attestation_digest_sha256) = 64
      AND placement_attestation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  activation_id INTEGER NOT NULL UNIQUE
    CHECK (typeof(activation_id) = 'integer' AND activation_id > 0),
  FOREIGN KEY (placement_attestation_digest_sha256)
    REFERENCES relay_container_shard_placement_attestations(
      placement_attestation_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (activation_id)
    REFERENCES relay_container_shard_activations(activation_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

INSERT INTO relay_container_shard_placement_events (
  placement_attestation_digest_sha256,
  controller_version_id,
  ring_generation,
  campaign_id,
  activation_id
)
SELECT
  placement_attestation_digest_sha256,
  controller_version_id,
  ring_generation,
  campaign_id,
  activation_id
FROM relay_container_shard_placement_attestations
ORDER BY recorded_at, activation_id, placement_attestation_digest_sha256;

CREATE INDEX idx_relay_container_shard_placement_events_candidate
ON relay_container_shard_placement_events(
  controller_version_id,
  ring_generation,
  campaign_id,
  placement_event_sequence
);

CREATE TRIGGER relay_container_shard_placement_event_insert_guard
BEFORE INSERT ON relay_container_shard_placement_events
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_attestations AS placement
    WHERE placement.placement_attestation_digest_sha256 =
            NEW.placement_attestation_digest_sha256
      AND placement.controller_version_id = NEW.controller_version_id
      AND placement.ring_generation = NEW.ring_generation
      AND placement.campaign_id = NEW.campaign_id
      AND placement.activation_id = NEW.activation_id
  ) THEN RAISE(ABORT, 'shard placement event does not match its attestation') END;
END;

CREATE TRIGGER relay_container_shard_placement_event_update_guard
BEFORE UPDATE ON relay_container_shard_placement_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement events are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_event_delete_guard
BEFORE DELETE ON relay_container_shard_placement_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement events are append-preserved');
END;

CREATE TRIGGER relay_container_shard_placement_attestation_event_append
AFTER INSERT ON relay_container_shard_placement_attestations
FOR EACH ROW
BEGIN
  INSERT INTO relay_container_shard_placement_events (
    placement_attestation_digest_sha256,
    controller_version_id,
    ring_generation,
    campaign_id,
    activation_id
  ) VALUES (
    NEW.placement_attestation_digest_sha256,
    NEW.controller_version_id,
    NEW.ring_generation,
    NEW.campaign_id,
    NEW.activation_id
  );
END;
