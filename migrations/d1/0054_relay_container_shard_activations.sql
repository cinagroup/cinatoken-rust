-- Persist one immutable, candidate-version-bound activation row per relay
-- Container shard. P5 reads this global ledger instead of instantiating DOs
-- while attempting to enumerate the active ring.

CREATE TABLE relay_container_shard_activations (
  activation_id INTEGER PRIMARY KEY,
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
    CHECK (readiness_result_code IN ('process_ready_execution_disabled', 'execution_ready')),
  process_ready INTEGER NOT NULL
    CHECK (process_ready = 1),
  runtime_execution_enabled INTEGER NOT NULL
    CHECK (runtime_execution_enabled IN (0, 1)),
  controller_execution_enabled INTEGER NOT NULL
    CHECK (controller_execution_enabled IN (0, 1)),
  activation_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(activation_digest_sha256) = 'text'
      AND length(activation_digest_sha256) = 64
      AND activation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  activated_at INTEGER NOT NULL
    CHECK (typeof(activated_at) = 'integer' AND activated_at > 0),
  CHECK (
    (readiness_result_code = 'execution_ready'
      AND runtime_execution_enabled = 1
      AND controller_execution_enabled = 1)
    OR
    (readiness_result_code = 'process_ready_execution_disabled'
      AND (runtime_execution_enabled = 0 OR controller_execution_enabled = 0))
  )
);

CREATE UNIQUE INDEX idx_relay_container_shard_activations_identity
  ON relay_container_shard_activations(
    controller_version_id,
    runtime_build_id,
    ring_generation,
    shard_index
  );

CREATE UNIQUE INDEX idx_relay_container_shard_activations_instance
  ON relay_container_shard_activations(
    controller_version_id,
    runtime_build_id,
    ring_generation,
    instance_name
  );

CREATE TRIGGER relay_container_shard_activation_update_guard
BEFORE UPDATE ON relay_container_shard_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation rows are immutable');
END;

CREATE TRIGGER relay_container_shard_activation_delete_guard
BEFORE DELETE ON relay_container_shard_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container shard activation rows are immutable');
END;
