-- Add the global, owner-fenced operation identity used by the sharded
-- Container execution plane. This is an expand-only migration: no existing
-- relay writer is required to create rows until the default-off canary is
-- explicitly enabled after remote verification.

CREATE TABLE IF NOT EXISTS relay_container_operations (
  reservation_key TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  owner_lease_expires_at INTEGER NOT NULL
    CHECK (typeof(owner_lease_expires_at) = 'integer' AND owner_lease_expires_at > 0),
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_group TEXT NOT NULL
    CHECK (typeof(selected_group) = 'text' AND length(selected_group) BETWEEN 1 AND 64),
  operation_kind TEXT NOT NULL
    CHECK (
      typeof(operation_kind) = 'text'
      AND length(operation_kind) BETWEEN 1 AND 64
      AND operation_kind NOT GLOB '*[^a-z0-9_:-]*'
    ),
  provider_operation_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(provider_operation_id) = 'text'
      AND length(provider_operation_id) BETWEEN 1 AND 128
      AND provider_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_sha256) = 'text'
      AND length(admission_sha256) = 64
      AND admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  protocol_version INTEGER NOT NULL
    CHECK (typeof(protocol_version) = 'integer' AND protocol_version BETWEEN 1 AND 255),
  shard_contract_version INTEGER NOT NULL
    CHECK (typeof(shard_contract_version) = 'integer' AND shard_contract_version = 1),
  ring_generation INTEGER NOT NULL
    CHECK (typeof(ring_generation) = 'integer' AND ring_generation > 0),
  shard_count INTEGER NOT NULL
    CHECK (typeof(shard_count) = 'integer' AND shard_count BETWEEN 1 AND 1024),
  shard_index INTEGER NOT NULL
    CHECK (typeof(shard_index) = 'integer' AND shard_index >= 0 AND shard_index < shard_count),
  instance_name TEXT NOT NULL
    CHECK (
      typeof(instance_name) = 'text'
      AND length(instance_name) BETWEEN 29 AND 64
      AND instance_name = printf('cinatoken-relay-shard-v1-%04d', shard_index)
    ),
  execution_deadline_at INTEGER NOT NULL
    CHECK (typeof(execution_deadline_at) = 'integer' AND execution_deadline_at > 0),
  input_mode TEXT NOT NULL
    CHECK (typeof(input_mode) = 'text' AND input_mode = 'r2'),
  input_object_key TEXT NOT NULL
    CHECK (typeof(input_object_key) = 'text' AND length(input_object_key) BETWEEN 8 AND 512),
  input_object_version TEXT NOT NULL
    CHECK (
      typeof(input_object_version) = 'text'
      AND length(input_object_version) BETWEEN 1 AND 128
      AND input_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  input_sha256 TEXT NOT NULL
    CHECK (
      typeof(input_sha256) = 'text'
      AND length(input_sha256) = 64
      AND input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  input_size INTEGER NOT NULL
    CHECK (typeof(input_size) = 'integer' AND input_size BETWEEN 0 AND 67108864),
  input_content_type TEXT NOT NULL
    CHECK (
      typeof(input_content_type) = 'text'
      AND length(input_content_type) BETWEEN 3 AND 128
    ),
  trace_id TEXT NOT NULL
    CHECK (
      typeof(trace_id) = 'text'
      AND length(trace_id) BETWEEN 1 AND 128
      AND trace_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (
      typeof(status) = 'text'
      AND status IN ('prepared', 'dispatched', 'completed', 'failed', 'recovery_required')
    ),
  response_status INTEGER,
  response_code TEXT,
  result_object_key TEXT,
  result_object_version TEXT,
  result_sha256 TEXT,
  result_size INTEGER,
  result_content_type TEXT,
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  CHECK (operation_id = reservation_key),
  CHECK (created_at < execution_deadline_at),
  CHECK (execution_deadline_at < owner_lease_expires_at),
  CHECK (
    input_object_key =
      'container-inputs/v1/' || operation_id || '/' || owner_generation || '/' || input_sha256
  ),
  CHECK (
    (status IN ('prepared', 'dispatched')
      AND response_status IS NULL AND response_code IS NULL
      AND result_object_key IS NULL AND result_object_version IS NULL
      AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL)
    OR
    (status = 'completed'
      AND typeof(response_status) = 'integer' AND response_status BETWEEN 200 AND 299
      AND response_code IS NULL
      AND typeof(result_object_key) = 'text' AND length(result_object_key) BETWEEN 8 AND 512
      AND typeof(result_object_version) = 'text'
      AND length(result_object_version) BETWEEN 1 AND 128
      AND result_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND typeof(result_sha256) = 'text'
      AND length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
      AND result_object_key =
        'container-results/v1/' || operation_id || '/' || owner_generation || '/' || result_sha256
      AND typeof(result_size) = 'integer' AND result_size BETWEEN 0 AND 67108864
      AND typeof(result_content_type) = 'text'
      AND length(result_content_type) BETWEEN 3 AND 128)
    OR
    (status = 'failed'
      AND typeof(response_status) = 'integer' AND response_status BETWEEN 400 AND 599
      AND typeof(response_code) = 'text' AND length(response_code) BETWEEN 1 AND 64
      AND response_code NOT GLOB '*[^a-z0-9_:-]*'
      AND result_object_key IS NULL AND result_object_version IS NULL
      AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL)
    OR
    (status = 'recovery_required'
      AND typeof(response_status) = 'integer' AND response_status = 202
      AND typeof(response_code) = 'text' AND length(response_code) BETWEEN 1 AND 64
      AND response_code NOT GLOB '*[^a-z0-9_:-]*'
      AND (
        (result_object_key IS NULL AND result_object_version IS NULL
          AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL)
        OR
        (typeof(result_object_key) = 'text' AND length(result_object_key) BETWEEN 8 AND 512
          AND typeof(result_object_version) = 'text'
          AND length(result_object_version) BETWEEN 1 AND 128
          AND result_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
          AND typeof(result_sha256) = 'text'
          AND length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
          AND result_object_key =
            'container-results/v1/' || operation_id || '/' || owner_generation || '/' || result_sha256
          AND typeof(result_size) = 'integer' AND result_size BETWEEN 0 AND 67108864
          AND typeof(result_content_type) = 'text'
          AND length(result_content_type) BETWEEN 3 AND 128)
      ))
  )
);

CREATE INDEX IF NOT EXISTS idx_relay_container_operations_recovery
  ON relay_container_operations(status, execution_deadline_at, reservation_key)
  WHERE status IN ('prepared', 'dispatched', 'recovery_required');

CREATE INDEX IF NOT EXISTS idx_relay_container_operations_shard
  ON relay_container_operations(
    ring_generation,
    shard_index,
    status,
    execution_deadline_at,
    reservation_key
  );

CREATE INDEX IF NOT EXISTS idx_relay_container_operations_updated
  ON relay_container_operations(updated_at DESC, reservation_key);

CREATE TRIGGER relay_container_operation_identity_immutable_guard
BEFORE UPDATE OF reservation_key,
                 operation_id,
                 owner_generation,
                 owner_lease_expires_at,
                 channel_id,
                 selected_group,
                 operation_kind,
                 provider_operation_id,
                 admission_sha256,
                 protocol_version,
                 shard_contract_version,
                 ring_generation,
                 shard_count,
                 shard_index,
                 instance_name,
                 execution_deadline_at,
                 input_mode,
                 input_object_key,
                 input_object_version,
                 input_sha256,
                 input_size,
                 input_content_type,
                 trace_id,
                 created_at
ON relay_container_operations
FOR EACH ROW
WHEN
  NEW.reservation_key IS NOT OLD.reservation_key OR
  NEW.operation_id IS NOT OLD.operation_id OR
  NEW.owner_generation IS NOT OLD.owner_generation OR
  NEW.owner_lease_expires_at IS NOT OLD.owner_lease_expires_at OR
  NEW.channel_id IS NOT OLD.channel_id OR
  NEW.selected_group IS NOT OLD.selected_group OR
  NEW.operation_kind IS NOT OLD.operation_kind OR
  NEW.provider_operation_id IS NOT OLD.provider_operation_id OR
  NEW.admission_sha256 IS NOT OLD.admission_sha256 OR
  NEW.protocol_version IS NOT OLD.protocol_version OR
  NEW.shard_contract_version IS NOT OLD.shard_contract_version OR
  NEW.ring_generation IS NOT OLD.ring_generation OR
  NEW.shard_count IS NOT OLD.shard_count OR
  NEW.shard_index IS NOT OLD.shard_index OR
  NEW.instance_name IS NOT OLD.instance_name OR
  NEW.execution_deadline_at IS NOT OLD.execution_deadline_at OR
  NEW.input_mode IS NOT OLD.input_mode OR
  NEW.input_object_key IS NOT OLD.input_object_key OR
  NEW.input_object_version IS NOT OLD.input_object_version OR
  NEW.input_sha256 IS NOT OLD.input_sha256 OR
  NEW.input_size IS NOT OLD.input_size OR
  NEW.input_content_type IS NOT OLD.input_content_type OR
  NEW.trace_id IS NOT OLD.trace_id OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay container operation identity is immutable');
END;

CREATE TRIGGER relay_container_operation_lifecycle_guard
BEFORE UPDATE ON relay_container_operations
FOR EACH ROW
WHEN
  NEW.updated_at < OLD.updated_at OR
  NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'prepared'
      AND NEW.status IN ('dispatched', 'failed', 'recovery_required')) OR
    (OLD.status = 'dispatched'
      AND NEW.status IN ('completed', 'failed', 'recovery_required')) OR
    (OLD.status = 'recovery_required'
      AND NEW.status IN ('completed', 'failed'))
  ) OR
  (
    OLD.status IN ('completed', 'failed')
    AND (
      NEW.status IS NOT OLD.status OR
      NEW.response_status IS NOT OLD.response_status OR
      NEW.response_code IS NOT OLD.response_code OR
      NEW.result_object_key IS NOT OLD.result_object_key OR
      NEW.result_object_version IS NOT OLD.result_object_version OR
      NEW.result_sha256 IS NOT OLD.result_sha256 OR
      NEW.result_size IS NOT OLD.result_size OR
      NEW.result_content_type IS NOT OLD.result_content_type OR
      NEW.updated_at IS NOT OLD.updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container operation lifecycle transition is invalid');
END;
