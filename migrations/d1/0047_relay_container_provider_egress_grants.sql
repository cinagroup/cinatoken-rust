-- Freeze the global D1 authority for the one-shot provider egress boundary.
-- Grant rows are created only after the operation dispatch is durable and its
-- billing reservation is still active. They are immutable provenance: this
-- migration does not backfill grants for historical operations.

CREATE TABLE relay_container_provider_egress_grants (
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation = 1),
  provider_operation_id TEXT NOT NULL
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
  request_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_sha256) = 'text'
      AND length(request_sha256) = 64
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  egress_profile TEXT NOT NULL
    CHECK (
      typeof(egress_profile) = 'text'
      AND egress_profile = 'openai-chat-completions-canary-v1'
    ),
  egress_worker_version_id TEXT NOT NULL
    CHECK (
      typeof(egress_worker_version_id) = 'text'
      AND length(egress_worker_version_id) BETWEEN 1 AND 128
      AND egress_worker_version_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
    ),
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_group TEXT NOT NULL
    CHECK (typeof(selected_group) = 'text' AND length(selected_group) BETWEEN 1 AND 64),
  model_name TEXT NOT NULL
    CHECK (
      typeof(model_name) = 'text'
      AND length(model_name) BETWEEN 1 AND 200
      AND model_name NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  endpoint_path TEXT NOT NULL
    CHECK (
      typeof(endpoint_path) = 'text'
      AND length(endpoint_path) BETWEEN 1 AND 256
      AND endpoint_path NOT GLOB '*[^A-Za-z0-9_./:-]*'
    ),
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
  billing_kind TEXT NOT NULL
    CHECK (typeof(billing_kind) = 'text' AND billing_kind IN ('tiered_expr', 'flat')),
  billing_contract_hash TEXT NOT NULL
    CHECK (
      typeof(billing_contract_hash) = 'text'
      AND (
        (
          billing_kind = 'tiered_expr'
          AND length(billing_contract_hash) = 64
          AND billing_contract_hash NOT GLOB '*[^0-9a-f]*'
        )
        OR (
          billing_kind = 'flat'
          AND length(billing_contract_hash) BETWEEN 66 AND 96
          AND substr(billing_contract_hash, length(billing_contract_hash) - 64, 1) = ':'
          AND substr(billing_contract_hash, -64) NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_snapshot_sha256) = 'text'
      AND length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stream_policy TEXT NOT NULL
    CHECK (typeof(stream_policy) = 'text' AND stream_policy = 'non_streaming'),
  operation_created_at INTEGER NOT NULL
    CHECK (typeof(operation_created_at) = 'integer' AND operation_created_at > 0),
  operation_dispatched_at INTEGER NOT NULL
    CHECK (
      typeof(operation_dispatched_at) = 'integer'
      AND operation_dispatched_at >= operation_created_at
    ),
  authorized_at INTEGER NOT NULL
    CHECK (
      typeof(authorized_at) = 'integer'
      AND authorized_at >= operation_dispatched_at
    ),
  execution_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(execution_deadline_at) = 'integer'
      AND execution_deadline_at > authorized_at
    ),
  owner_lease_expires_at INTEGER NOT NULL
    CHECK (
      typeof(owner_lease_expires_at) = 'integer'
      AND owner_lease_expires_at > execution_deadline_at
    ),
  reservation_owner_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(reservation_owner_deadline_at) = 'integer'
      AND reservation_owner_deadline_at >= execution_deadline_at
      AND reservation_owner_deadline_at > authorized_at
    ),
  reservation_lease_expires_at INTEGER NOT NULL
    CHECK (
      typeof(reservation_lease_expires_at) = 'integer'
      AND reservation_lease_expires_at >= owner_lease_expires_at
      AND reservation_lease_expires_at >= reservation_owner_deadline_at
    ),
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  FOREIGN KEY (operation_id) REFERENCES relay_container_operations(operation_id),
  FOREIGN KEY (reservation_key) REFERENCES relay_billing_reservations(reservation_key),
  CHECK (operation_id = reservation_key),
  CHECK (request_sha256 = input_sha256),
  CHECK (
    input_object_key =
      'container-inputs/v1/' || operation_id || '/' || owner_generation || '/' || input_sha256
  ),
  CHECK (
    billing_kind = 'tiered_expr'
    OR
    (billing_kind = 'flat'
      AND billing_snapshot_sha256 = substr(billing_contract_hash, -64))
  )
);

CREATE UNIQUE INDEX idx_relay_container_provider_egress_grants_provider_operation
  ON relay_container_provider_egress_grants(provider_operation_id);

CREATE INDEX idx_relay_container_provider_egress_grants_worker_version
  ON relay_container_provider_egress_grants(
    egress_profile,
    egress_worker_version_id,
    authorized_at DESC,
    operation_id
  );

CREATE TRIGGER relay_container_provider_egress_grant_insert_authority_guard
BEFORE INSERT ON relay_container_provider_egress_grants
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_operations AS operation
  JOIN relay_billing_reservations AS reservation
    ON reservation.reservation_key = operation.reservation_key
  WHERE operation.operation_id = NEW.operation_id
    AND operation.reservation_key = NEW.reservation_key
    AND operation.protocol_version = 1
    AND operation.status = 'dispatched'
    AND operation.owner_generation = NEW.owner_generation
    AND operation.provider_operation_id = NEW.provider_operation_id
    AND operation.admission_sha256 = NEW.admission_sha256
    AND operation.channel_id = NEW.channel_id
    AND operation.selected_group = NEW.selected_group
    AND operation.input_mode = NEW.input_mode
    AND operation.input_object_key = NEW.input_object_key
    AND operation.input_object_version = NEW.input_object_version
    AND operation.input_sha256 = NEW.input_sha256
    AND operation.input_sha256 = NEW.request_sha256
    AND operation.input_size = NEW.input_size
    AND operation.input_content_type = NEW.input_content_type
    AND operation.created_at = NEW.operation_created_at
    AND operation.updated_at = NEW.operation_dispatched_at
    AND operation.execution_deadline_at = NEW.execution_deadline_at
    AND operation.owner_lease_expires_at = NEW.owner_lease_expires_at
    AND reservation.status = 'reserved'
    AND reservation.owner_generation = NEW.owner_generation
    AND reservation.channel_id = NEW.channel_id
    AND reservation.selected_group = NEW.selected_group
    AND reservation.selected_at > 0
    AND reservation.selected_at <= NEW.operation_created_at
    AND reservation.model_name = NEW.model_name
    AND reservation.endpoint_path = NEW.endpoint_path
    AND reservation.billing_kind = NEW.billing_kind
    AND reservation.expr_hash = NEW.billing_contract_hash
    AND reservation.owner_deadline_at = NEW.reservation_owner_deadline_at
    AND reservation.lease_expires_at = NEW.reservation_lease_expires_at
    AND reservation.owner_deadline_at >= operation.execution_deadline_at
    AND reservation.lease_expires_at >= operation.owner_lease_expires_at
    AND NEW.authorized_at >= operation.updated_at
    AND NEW.authorized_at < operation.execution_deadline_at
    AND NEW.authorized_at < operation.owner_lease_expires_at
    AND NEW.authorized_at < reservation.owner_deadline_at
    AND NEW.authorized_at < reservation.lease_expires_at
    AND length(trim(reservation.billing_snapshot_json)) > 0
    AND json_valid(reservation.billing_snapshot_json)
    AND json_type(reservation.billing_snapshot_json) = 'object'
    AND (
      reservation.billing_kind = 'tiered_expr'
      OR (
        reservation.billing_kind = 'flat'
        AND NEW.billing_snapshot_sha256 = substr(reservation.expr_hash, -64)
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container provider egress grant authority mismatch');
END;

CREATE TRIGGER relay_container_provider_egress_grant_update_guard
BEFORE UPDATE ON relay_container_provider_egress_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider egress grant is immutable');
END;

CREATE TRIGGER relay_container_provider_egress_grant_delete_guard
BEFORE DELETE ON relay_container_provider_egress_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider egress grant cannot be deleted');
END;
