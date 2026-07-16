-- Expand the global Container operation authority with caller replay identity
-- and an immutable financial terminal ledger. Existing writers remain valid:
-- the new operation identity defaults to the all-empty legacy shape, and this
-- migration does not backfill or synthesize operation, event, or outbox rows.

ALTER TABLE relay_container_operations
  ADD COLUMN client_idempotency_hmac_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(client_idempotency_hmac_sha256) = 'text'
      AND (
        client_idempotency_hmac_sha256 = ''
        OR (
          length(client_idempotency_hmac_sha256) = 64
          AND client_idempotency_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      )
    );

ALTER TABLE relay_container_operations
  ADD COLUMN client_request_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(client_request_sha256) = 'text'
      AND (
        client_request_sha256 = ''
        OR (
          length(client_request_sha256) = 64
          AND client_request_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      )
    );

ALTER TABLE relay_container_operations
  ADD COLUMN reconciliation_id TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(reconciliation_id) = 'text'
      AND (
        reconciliation_id = ''
        OR (
          length(reconciliation_id) = 64
          AND reconciliation_id NOT GLOB '*[^0-9a-f]*'
        )
      )
      AND (
        (
          client_idempotency_hmac_sha256 = ''
          AND client_request_sha256 = ''
          AND reconciliation_id = ''
        )
        OR (
          client_idempotency_hmac_sha256 <> ''
          AND client_request_sha256 <> ''
          AND reconciliation_id <> ''
        )
      )
    );

CREATE UNIQUE INDEX idx_relay_container_operations_client_idempotency_hmac
  ON relay_container_operations(client_idempotency_hmac_sha256)
  WHERE client_idempotency_hmac_sha256 <> '';

CREATE UNIQUE INDEX idx_relay_container_operations_reconciliation_id
  ON relay_container_operations(reconciliation_id)
  WHERE reconciliation_id <> '';

DROP TRIGGER relay_container_operation_identity_immutable_guard;

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
                 client_idempotency_hmac_sha256,
                 client_request_sha256,
                 reconciliation_id,
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
  NEW.client_idempotency_hmac_sha256 IS NOT OLD.client_idempotency_hmac_sha256 OR
  NEW.client_request_sha256 IS NOT OLD.client_request_sha256 OR
  NEW.reconciliation_id IS NOT OLD.reconciliation_id OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay container operation identity is immutable');
END;

CREATE TABLE relay_container_terminal_events (
  billing_event_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(billing_event_id) = 'text'
      AND length(billing_event_id) = 64
      AND billing_event_id NOT GLOB '*[^0-9a-f]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  operation_from_status TEXT NOT NULL
    CHECK (
      typeof(operation_from_status) = 'text'
      AND operation_from_status IN ('prepared', 'dispatched', 'recovery_required')
    ),
  operation_status TEXT NOT NULL
    CHECK (
      typeof(operation_status) = 'text'
      AND operation_status IN ('completed', 'failed', 'recovery_required')
    ),
  terminal_contract_sha256 TEXT NOT NULL
    CHECK (
      typeof(terminal_contract_sha256) = 'text'
      AND length(terminal_contract_sha256) = 64
      AND terminal_contract_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  billing_action TEXT NOT NULL
    CHECK (
      typeof(billing_action) = 'text'
      AND billing_action IN ('settle', 'refund', 'recovery_required')
    ),
  billing_owner_generation INTEGER NOT NULL
    CHECK (
      typeof(billing_owner_generation) = 'integer'
      AND billing_owner_generation > 0
    ),
  billing_from_status TEXT NOT NULL
    CHECK (
      typeof(billing_from_status) = 'text'
      AND billing_from_status IN ('reserved', 'recovery_required')
    ),
  billing_final_quota INTEGER
    CHECK (
      billing_final_quota IS NULL
      OR (typeof(billing_final_quota) = 'integer' AND billing_final_quota >= 0)
    ),
  billing_request_accounted INTEGER NOT NULL
    CHECK (
      typeof(billing_request_accounted) = 'integer'
      AND billing_request_accounted IN (0, 1)
    ),
  billing_reason TEXT NOT NULL
    CHECK (
      typeof(billing_reason) = 'text'
      AND length(billing_reason) BETWEEN 1 AND 256
    ),
  pre_consumed_quota INTEGER NOT NULL
    CHECK (typeof(pre_consumed_quota) = 'integer' AND pre_consumed_quota >= 0),
  user_quota_delta INTEGER NOT NULL
    CHECK (typeof(user_quota_delta) = 'integer'),
  token_quota_delta INTEGER NOT NULL
    CHECK (typeof(token_quota_delta) = 'integer'),
  user_used_quota_delta INTEGER NOT NULL
    CHECK (typeof(user_used_quota_delta) = 'integer'),
  channel_used_quota_delta INTEGER NOT NULL
    CHECK (typeof(channel_used_quota_delta) = 'integer'),
  request_count_delta INTEGER NOT NULL
    CHECK (typeof(request_count_delta) = 'integer'),
  reconciliation_id TEXT NOT NULL
    CHECK (
      typeof(reconciliation_id) = 'text'
      AND length(reconciliation_id) = 64
      AND reconciliation_id NOT GLOB '*[^0-9a-f]*'
    ),
  reconciliation_revision INTEGER NOT NULL
    CHECK (
      typeof(reconciliation_revision) = 'integer'
      AND reconciliation_revision > 0
    ),
  client_response_status INTEGER
    CHECK (
      client_response_status IS NULL
      OR (
        typeof(client_response_status) = 'integer'
        AND client_response_status BETWEEN 100 AND 599
      )
    ),
  client_response_headers_json TEXT
    CHECK (
      client_response_headers_json IS NULL
      OR (
        typeof(client_response_headers_json) = 'text'
        AND length(client_response_headers_json) BETWEEN 2 AND 4096
        AND CASE
          WHEN json_valid(client_response_headers_json) = 1
          THEN json_type(client_response_headers_json) = 'object'
          ELSE 0
        END
      )
    ),
  client_response_headers_sha256 TEXT
    CHECK (
      client_response_headers_sha256 IS NULL
      OR (
        typeof(client_response_headers_sha256) = 'text'
        AND length(client_response_headers_sha256) = 64
        AND client_response_headers_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  client_response_object_key TEXT
    CHECK (
      client_response_object_key IS NULL
      OR (
        typeof(client_response_object_key) = 'text'
        AND length(client_response_object_key) BETWEEN 8 AND 512
      )
    ),
  client_response_object_version TEXT
    CHECK (
      client_response_object_version IS NULL
      OR (
        typeof(client_response_object_version) = 'text'
        AND length(client_response_object_version) BETWEEN 1 AND 128
        AND client_response_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
  client_response_sha256 TEXT
    CHECK (
      client_response_sha256 IS NULL
      OR (
        typeof(client_response_sha256) = 'text'
        AND length(client_response_sha256) = 64
        AND client_response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  client_response_size INTEGER
    CHECK (
      client_response_size IS NULL
      OR (
        typeof(client_response_size) = 'integer'
        AND client_response_size BETWEEN 0 AND 67108864
      )
    ),
  client_response_content_type TEXT
    CHECK (
      client_response_content_type IS NULL
      OR (
        typeof(client_response_content_type) = 'text'
        AND length(client_response_content_type) BETWEEN 3 AND 128
      )
    ),
  outbox_schema_version INTEGER NOT NULL
    CHECK (typeof(outbox_schema_version) = 'integer' AND outbox_schema_version = 1),
  outbox_payload_json TEXT NOT NULL
    CHECK (
      typeof(outbox_payload_json) = 'text'
      AND length(outbox_payload_json) BETWEEN 2 AND 65536
      AND CASE
        WHEN json_valid(outbox_payload_json) = 1
        THEN json_type(outbox_payload_json) = 'object'
        ELSE 0
      END
    ),
  outbox_payload_sha256 TEXT NOT NULL
    CHECK (
      typeof(outbox_payload_sha256) = 'text'
      AND length(outbox_payload_sha256) = 64
      AND outbox_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  CHECK (reservation_key = operation_id),
  CHECK (
    (
      operation_from_status IN ('prepared', 'dispatched')
      AND billing_from_status = 'reserved'
      AND billing_owner_generation = owner_generation
      AND reconciliation_revision = 1
    )
    OR (
      operation_from_status = 'recovery_required'
      AND billing_from_status = 'recovery_required'
      AND billing_owner_generation = owner_generation + 1
      AND reconciliation_revision = 2
    )
  ),
  CHECK (
    (
      billing_action = 'settle'
      AND operation_from_status IN ('dispatched', 'recovery_required')
      AND operation_status = 'completed'
      AND typeof(billing_final_quota) = 'integer'
      AND billing_request_accounted = 1
      AND user_quota_delta = pre_consumed_quota - billing_final_quota
      AND user_used_quota_delta = billing_final_quota
      AND channel_used_quota_delta = billing_final_quota
      AND request_count_delta = 1
      AND client_response_status IS NOT NULL
      AND client_response_status BETWEEN 200 AND 299
      AND client_response_headers_json IS NOT NULL
      AND client_response_headers_sha256 IS NOT NULL
      AND client_response_object_key IS NOT NULL
      AND client_response_object_version IS NOT NULL
      AND client_response_sha256 IS NOT NULL
      AND client_response_size IS NOT NULL
      AND client_response_content_type IS NOT NULL
    )
    OR (
      billing_action = 'refund'
      AND operation_status = 'failed'
      AND billing_final_quota IS NULL
      AND user_quota_delta = pre_consumed_quota
      AND user_used_quota_delta = 0
      AND channel_used_quota_delta = 0
      AND request_count_delta = billing_request_accounted
      AND client_response_status IS NOT NULL
      AND client_response_status BETWEEN 400 AND 599
      AND client_response_headers_json IS NOT NULL
      AND client_response_headers_sha256 IS NOT NULL
      AND client_response_object_key IS NOT NULL
      AND client_response_object_version IS NOT NULL
      AND client_response_sha256 IS NOT NULL
      AND client_response_size IS NOT NULL
      AND client_response_content_type IS NOT NULL
    )
    OR (
      billing_action = 'recovery_required'
      AND operation_from_status IN ('prepared', 'dispatched')
      AND operation_status = 'recovery_required'
      AND billing_final_quota IS NULL
      AND billing_request_accounted = 0
      AND user_quota_delta = 0
      AND token_quota_delta = 0
      AND user_used_quota_delta = 0
      AND channel_used_quota_delta = 0
      AND request_count_delta = 0
      AND client_response_status IS NULL
      AND client_response_headers_json IS NULL
      AND client_response_headers_sha256 IS NULL
      AND client_response_object_key IS NULL
      AND client_response_object_version IS NULL
      AND client_response_sha256 IS NULL
      AND client_response_size IS NULL
      AND client_response_content_type IS NULL
    )
  ),
  CHECK (
    client_response_object_key IS NULL
    OR client_response_object_key =
      'container-client-responses/v1/' || operation_id || '/' ||
      owner_generation || '/' || client_response_sha256
  ),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_billing_reservations(reservation_key),
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
);

CREATE UNIQUE INDEX idx_relay_container_terminal_events_operation_identity
  ON relay_container_terminal_events(
    operation_id,
    owner_generation,
    operation_from_status
  );

CREATE UNIQUE INDEX idx_relay_container_terminal_events_reconciliation_identity
  ON relay_container_terminal_events(reconciliation_id, reconciliation_revision);

CREATE TRIGGER relay_container_terminal_event_insert_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_operations AS operation
  JOIN relay_billing_reservations AS reservation
    ON reservation.reservation_key = operation.reservation_key
  JOIN users AS billing_user
    ON billing_user.id = reservation.user_id
  LEFT JOIN tokens AS billing_token
    ON billing_token.id = reservation.token_id
  JOIN channels AS billing_channel
    ON billing_channel.id = reservation.channel_id
  WHERE operation.reservation_key = NEW.reservation_key
    AND operation.operation_id = NEW.operation_id
    AND operation.owner_generation = NEW.owner_generation
    AND operation.status = NEW.operation_from_status
    AND operation.reconciliation_id = NEW.reconciliation_id
    AND operation.channel_id = reservation.channel_id
    AND operation.selected_group = reservation.selected_group
    AND reservation.owner_generation = NEW.billing_owner_generation
    AND reservation.status = NEW.billing_from_status
    AND (reservation.token_id = 0 OR billing_token.user_id = reservation.user_id)
    AND (
      (
        NEW.billing_action = 'settle'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta =
          reservation.pre_consumed_quota - NEW.billing_final_quota
        AND NEW.token_quota_delta = CASE
          WHEN reservation.token_id = 0 THEN 0
          ELSE reservation.pre_consumed_quota - NEW.billing_final_quota
        END
        AND NEW.user_used_quota_delta = NEW.billing_final_quota
        AND NEW.channel_used_quota_delta = NEW.billing_final_quota
        AND NEW.request_count_delta = 1
      )
      OR (
        NEW.billing_action = 'refund'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta = reservation.pre_consumed_quota
        AND NEW.token_quota_delta = CASE
          WHEN reservation.token_id = 0 THEN 0
          ELSE reservation.pre_consumed_quota
        END
        AND NEW.user_used_quota_delta = 0
        AND NEW.channel_used_quota_delta = 0
        AND NEW.request_count_delta = NEW.billing_request_accounted
      )
      OR (
        NEW.billing_action = 'recovery_required'
        AND NEW.pre_consumed_quota = reservation.pre_consumed_quota
        AND NEW.user_quota_delta = 0
        AND NEW.token_quota_delta = 0
        AND NEW.user_used_quota_delta = 0
        AND NEW.channel_used_quota_delta = 0
        AND NEW.request_count_delta = 0
      )
    )
    AND (
      NEW.client_response_headers_json IS NULL
      OR CASE
        WHEN json_valid(NEW.client_response_headers_json) = 1 THEN (
          json_extract(
            NEW.client_response_headers_json,
            '$."content-type"'
          ) = NEW.client_response_content_type
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(NEW.client_response_headers_json) AS header
            WHERE header.key NOT IN (
              'anthropic-request-id',
              'cache-control',
              'content-type',
              'openai-request-id',
              'retry-after',
              'x-request-id'
            )
            OR header.type <> 'text'
            OR length(CAST(header.value AS TEXT)) NOT BETWEEN 1 AND 1024
          )
        )
        ELSE 1
      END
    )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event authority mismatch');
END;

CREATE TRIGGER relay_container_terminal_event_update_guard
BEFORE UPDATE ON relay_container_terminal_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event is append-only');
END;

CREATE TRIGGER relay_container_terminal_event_delete_guard
BEFORE DELETE ON relay_container_terminal_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event is append-only');
END;

CREATE TABLE relay_container_terminal_outbox_state (
  billing_event_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(billing_event_id) = 'text'
      AND length(billing_event_id) = 64
      AND billing_event_id NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      typeof(status) = 'text'
      AND status IN ('pending', 'leased', 'delivered', 'dead_letter')
    ),
  delivery_generation INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivery_generation) = 'integer' AND delivery_generation >= 0),
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(delivery_attempt_count) = 'integer'
      AND delivery_attempt_count >= 0
    ),
  lease_expires_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at >= 0),
  available_at INTEGER NOT NULL
    CHECK (typeof(available_at) = 'integer' AND available_at > 0),
  delivered_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivered_at) = 'integer' AND delivered_at >= 0),
  last_error TEXT NOT NULL DEFAULT ''
    CHECK (typeof(last_error) = 'text' AND length(last_error) <= 4096),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  CHECK (delivery_generation = delivery_attempt_count),
  CHECK (
    (
      status = 'pending'
      AND lease_expires_at = 0
      AND delivered_at = 0
      AND available_at >= updated_at
      AND (
        (delivery_attempt_count = 0 AND last_error = '')
        OR (delivery_attempt_count > 0 AND length(last_error) > 0)
      )
    )
    OR (
      status = 'leased'
      AND delivery_attempt_count > 0
      AND lease_expires_at > updated_at
      AND available_at <= updated_at
      AND delivered_at = 0
      AND last_error = ''
    )
    OR (
      status = 'delivered'
      AND delivery_attempt_count > 0
      AND lease_expires_at = 0
      AND available_at <= updated_at
      AND delivered_at = updated_at
      AND last_error = ''
    )
    OR (
      status = 'dead_letter'
      AND delivery_attempt_count > 0
      AND lease_expires_at = 0
      AND available_at <= updated_at
      AND delivered_at = 0
      AND length(last_error) > 0
    )
  ),
  FOREIGN KEY (billing_event_id)
    REFERENCES relay_container_terminal_events(billing_event_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_terminal_outbox_pending
  ON relay_container_terminal_outbox_state(available_at, created_at, billing_event_id)
  WHERE status = 'pending';

CREATE INDEX idx_relay_container_terminal_outbox_leased
  ON relay_container_terminal_outbox_state(lease_expires_at, billing_event_id)
  WHERE status = 'leased';

CREATE TRIGGER relay_container_terminal_outbox_insert_guard
BEFORE INSERT ON relay_container_terminal_outbox_state
FOR EACH ROW
WHEN
  NEW.status <> 'pending' OR
  NEW.delivery_generation <> 0 OR
  NEW.delivery_attempt_count <> 0 OR
  NEW.lease_expires_at <> 0 OR
  NEW.delivered_at <> 0 OR
  NEW.last_error <> '' OR
  NEW.available_at <> NEW.created_at OR
  NEW.updated_at <> NEW.created_at OR
  NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    WHERE event.billing_event_id = NEW.billing_event_id
      AND event.created_at = NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal outbox initial state is invalid');
END;

CREATE TRIGGER relay_container_terminal_outbox_identity_immutable_guard
BEFORE UPDATE OF billing_event_id, created_at
ON relay_container_terminal_outbox_state
FOR EACH ROW
WHEN
  NEW.billing_event_id IS NOT OLD.billing_event_id OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal outbox identity is immutable');
END;

CREATE TRIGGER relay_container_terminal_outbox_lifecycle_guard
BEFORE UPDATE ON relay_container_terminal_outbox_state
FOR EACH ROW
WHEN NOT (
  NEW.billing_event_id IS OLD.billing_event_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at > OLD.updated_at
  AND OLD.status NOT IN ('delivered', 'dead_letter')
  AND (
    (
      OLD.status = 'pending'
      AND NEW.status = 'leased'
      AND NEW.delivery_generation = OLD.delivery_generation + 1
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count + 1
      AND NEW.lease_expires_at > NEW.updated_at
      AND NEW.available_at = OLD.available_at
      AND NEW.delivered_at = 0
      AND NEW.last_error = ''
    )
    OR (
      OLD.status = 'leased'
      AND NEW.status = 'leased'
      AND NEW.delivery_generation = OLD.delivery_generation
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count
      AND OLD.lease_expires_at > NEW.updated_at
      AND NEW.lease_expires_at > OLD.lease_expires_at
      AND NEW.lease_expires_at > NEW.updated_at
      AND NEW.available_at = OLD.available_at
      AND NEW.delivered_at = 0
      AND NEW.last_error = ''
    )
    OR (
      OLD.status = 'leased'
      AND NEW.status = 'leased'
      AND OLD.lease_expires_at <= NEW.updated_at
      AND NEW.delivery_generation = OLD.delivery_generation + 1
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count + 1
      AND NEW.lease_expires_at > NEW.updated_at
      AND NEW.available_at = OLD.available_at
      AND NEW.delivered_at = 0
      AND NEW.last_error = ''
    )
    OR (
      OLD.status = 'leased'
      AND NEW.status = 'pending'
      AND NEW.delivery_generation = OLD.delivery_generation
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count
      AND OLD.lease_expires_at > NEW.updated_at
      AND NEW.lease_expires_at = 0
      AND NEW.available_at >= NEW.updated_at
      AND NEW.delivered_at = 0
      AND length(NEW.last_error) > 0
    )
    OR (
      OLD.status = 'leased'
      AND NEW.status = 'delivered'
      AND NEW.delivery_generation = OLD.delivery_generation
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count
      AND OLD.lease_expires_at > NEW.updated_at
      AND NEW.lease_expires_at = 0
      AND NEW.available_at = OLD.available_at
      AND NEW.delivered_at = NEW.updated_at
      AND NEW.last_error = ''
    )
    OR (
      OLD.status = 'leased'
      AND NEW.status = 'dead_letter'
      AND NEW.delivery_generation = OLD.delivery_generation
      AND NEW.delivery_attempt_count = OLD.delivery_attempt_count
      AND OLD.lease_expires_at > NEW.updated_at
      AND NEW.lease_expires_at = 0
      AND NEW.available_at = OLD.available_at
      AND NEW.delivered_at = 0
      AND length(NEW.last_error) > 0
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal outbox transition is invalid');
END;

CREATE TRIGGER relay_container_terminal_outbox_delete_guard
BEFORE DELETE ON relay_container_terminal_outbox_state
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal outbox state cannot be deleted');
END;
