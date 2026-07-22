-- Durable pre-dispatch evidence for positive paid ordinary HTTP SSE relays.
-- The row is admitted in the same D1 batch that binds the billing reservation,
-- before the first poll of the provider transport future.

CREATE TABLE relay_http_stream_dispatch_intents (
  reservation_key TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL
    CHECK (
      typeof(attempt_generation) = 'integer'
      AND attempt_generation BETWEEN 1 AND 2147483647
    ),
  prebind_owner_generation INTEGER NOT NULL
    CHECK (
      typeof(prebind_owner_generation) = 'integer'
      AND prebind_owner_generation BETWEEN 1 AND 2147483646
    ),
  owner_generation INTEGER NOT NULL
    CHECK (
      typeof(owner_generation) = 'integer'
      AND owner_generation = prebind_owner_generation + 1
    ),
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_group TEXT NOT NULL
    CHECK (length(selected_group) BETWEEN 1 AND 128),
  expr_hash TEXT NOT NULL
    CHECK (length(expr_hash) BETWEEN 1 AND 96),
  provider_operation_id TEXT NOT NULL
    CHECK (
      length(provider_operation_id) = 64
      AND provider_operation_id = lower(provider_operation_id)
      AND provider_operation_id NOT GLOB '*[^0-9a-f]*'
    ),
  worker_version_id TEXT NOT NULL
    CHECK (length(worker_version_id) BETWEEN 1 AND 128),
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 = lower(billing_snapshot_sha256)
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  endpoint_path TEXT NOT NULL
    CHECK (length(endpoint_path) BETWEEN 1 AND 192),
  transport_kind TEXT NOT NULL
    CHECK (transport_kind IN ('ai_gateway', 'direct_provider', 'wfp_binding', 'raw_provider')),
  status TEXT NOT NULL
    CHECK (
      status IN (
        'prepared',
        'dispatched',
        'response_received',
        'stream_bound',
        'recovery_required'
      )
    ),
  selected_at INTEGER NOT NULL
    CHECK (typeof(selected_at) = 'integer' AND selected_at > 0),
  lease_expires_at INTEGER NOT NULL
    CHECK (
      typeof(lease_expires_at) = 'integer'
      AND lease_expires_at > selected_at
    ),
  hard_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(hard_deadline_at) = 'integer'
      AND hard_deadline_at > selected_at
      AND hard_deadline_at <= selected_at + 3600
      AND lease_expires_at <= hard_deadline_at
    ),
  dispatched_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(dispatched_at) = 'integer'
      AND (dispatched_at = 0 OR dispatched_at >= selected_at)
    ),
  response_status INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(response_status) = 'integer'
      AND (response_status = 0 OR response_status BETWEEN 100 AND 599)
    ),
  upstream_request_id_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      upstream_request_id_sha256 = ''
      OR (
        length(upstream_request_id_sha256) = 64
        AND upstream_request_id_sha256 = lower(upstream_request_id_sha256)
        AND upstream_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  response_received_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(response_received_at) = 'integer' AND response_received_at >= 0),
  handoff_bound_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(handoff_bound_at) = 'integer' AND handoff_bound_at >= 0),
  recovery_required_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(recovery_required_at) = 'integer' AND recovery_required_at >= 0),
  terminal_reason TEXT NOT NULL DEFAULT ''
    CHECK (length(terminal_reason) <= 96),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at = selected_at),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  PRIMARY KEY (reservation_key, attempt_generation),
  UNIQUE (provider_operation_id),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_billing_reservations(reservation_key),
  CHECK (
    (status = 'prepared'
      AND dispatched_at = 0
      AND response_status = 0 AND upstream_request_id_sha256 = ''
      AND response_received_at = 0 AND handoff_bound_at = 0
      AND recovery_required_at = 0 AND terminal_reason = '')
    OR (status = 'dispatched'
      AND dispatched_at >= selected_at
      AND response_status = 0 AND upstream_request_id_sha256 = ''
      AND response_received_at = 0 AND handoff_bound_at = 0
      AND recovery_required_at = 0 AND terminal_reason = '')
    OR (status = 'response_received'
      AND dispatched_at >= selected_at
      AND response_status BETWEEN 100 AND 599
      AND response_received_at >= dispatched_at
      AND handoff_bound_at = 0 AND recovery_required_at = 0
      AND terminal_reason = '')
    OR (status = 'stream_bound'
      AND dispatched_at >= selected_at
      AND response_status = 200 AND response_received_at >= dispatched_at
      AND handoff_bound_at >= response_received_at
      AND recovery_required_at = 0 AND terminal_reason = '')
    OR (status = 'recovery_required'
      AND handoff_bound_at = 0 AND recovery_required_at >= selected_at
      AND terminal_reason <> '')
  )
);

CREATE INDEX idx_relay_http_stream_dispatch_intents_recovery
  ON relay_http_stream_dispatch_intents(
    status, recovery_required_at, reservation_key, attempt_generation
  )
  WHERE status = 'recovery_required';

CREATE INDEX idx_relay_http_stream_dispatch_intents_active_lease
  ON relay_http_stream_dispatch_intents(
    hard_deadline_at, lease_expires_at, reservation_key, attempt_generation
  )
  WHERE status IN ('prepared', 'dispatched', 'response_received');

CREATE TRIGGER relay_http_stream_dispatch_intent_insert_guard
BEFORE INSERT ON relay_http_stream_dispatch_intents
BEGIN
  SELECT CASE WHEN NEW.status <> 'prepared'
    THEN RAISE(ABORT, 'relay HTTP stream dispatch must start prepared') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_billing_reservations AS reservation
    WHERE reservation.reservation_key = NEW.reservation_key
      AND reservation.status = 'reserved'
      AND reservation.owner_generation = NEW.owner_generation
      AND reservation.channel_id = NEW.channel_id
      AND reservation.selected_group = NEW.selected_group
      AND reservation.expr_hash = NEW.expr_hash
      AND reservation.selected_at = NEW.selected_at
      AND reservation.lease_expires_at = NEW.lease_expires_at
      AND reservation.owner_deadline_at >= NEW.selected_at
  ) THEN RAISE(ABORT, 'relay HTTP stream dispatch reservation mismatch') END;
END;

CREATE TRIGGER relay_http_stream_dispatch_intent_identity_guard
BEFORE UPDATE ON relay_http_stream_dispatch_intents
WHEN
  NEW.reservation_key IS NOT OLD.reservation_key
  OR NEW.attempt_generation IS NOT OLD.attempt_generation
  OR NEW.prebind_owner_generation IS NOT OLD.prebind_owner_generation
  OR NEW.owner_generation IS NOT OLD.owner_generation
  OR NEW.channel_id IS NOT OLD.channel_id
  OR NEW.selected_group IS NOT OLD.selected_group
  OR NEW.expr_hash IS NOT OLD.expr_hash
  OR NEW.provider_operation_id IS NOT OLD.provider_operation_id
  OR NEW.worker_version_id IS NOT OLD.worker_version_id
  OR NEW.billing_snapshot_sha256 IS NOT OLD.billing_snapshot_sha256
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.endpoint_path IS NOT OLD.endpoint_path
  OR NEW.transport_kind IS NOT OLD.transport_kind
  OR NEW.selected_at IS NOT OLD.selected_at
  OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
  OR NEW.hard_deadline_at IS NOT OLD.hard_deadline_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.dispatched_at <> 0 AND NEW.dispatched_at IS NOT OLD.dispatched_at)
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream dispatch identity is immutable');
END;

ALTER TABLE relay_http_stream_handoffs
  ADD COLUMN dispatch_hard_deadline_at INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(dispatch_hard_deadline_at) = 'integer'
    AND (
      dispatch_hard_deadline_at = 0
      OR dispatch_hard_deadline_at > created_at
    )
  );

CREATE TRIGGER relay_http_stream_dispatch_intent_lifecycle_guard
BEFORE UPDATE ON relay_http_stream_dispatch_intents
WHEN NOT (
  (OLD.status = 'prepared'
    AND NEW.status IN ('dispatched', 'recovery_required'))
  OR (OLD.status = 'dispatched'
    AND NEW.status IN ('response_received', 'recovery_required'))
  OR (OLD.status = 'response_received'
    AND NEW.status IN ('stream_bound', 'recovery_required'))
)
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream dispatch lifecycle transition is invalid');
END;

CREATE TRIGGER relay_http_stream_dispatch_intent_recovery_apply
AFTER UPDATE ON relay_http_stream_dispatch_intents
WHEN NEW.status = 'recovery_required'
BEGIN
  UPDATE relay_billing_reservations
  SET status = 'recovery_required', owner_generation = owner_generation + 1,
      finalization_reason = NEW.terminal_reason,
      recovery_last_attempt_at = NEW.recovery_required_at,
      recovery_required_at = NEW.recovery_required_at,
      updated_at = NEW.recovery_required_at
  WHERE reservation_key = NEW.reservation_key
    AND status = 'reserved'
    AND owner_generation = NEW.owner_generation
    AND channel_id = NEW.channel_id
    AND selected_group = NEW.selected_group
    AND selected_at = NEW.selected_at;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM relay_billing_reservations AS reservation
    WHERE reservation.reservation_key = NEW.reservation_key
      AND reservation.status = 'recovery_required'
      AND reservation.owner_generation = NEW.owner_generation + 1
      AND reservation.channel_id = NEW.channel_id
      AND reservation.selected_group = NEW.selected_group
      AND reservation.selected_at = NEW.selected_at
      AND reservation.finalization_reason = NEW.terminal_reason
      AND reservation.recovery_required_at = NEW.recovery_required_at
  ) THEN RAISE(ABORT, 'relay HTTP stream dispatch recovery apply failed') END;
END;

CREATE TRIGGER relay_http_stream_dispatch_intent_stream_bound_guard
BEFORE UPDATE ON relay_http_stream_dispatch_intents
WHEN NEW.status = 'stream_bound' AND OLD.status <> 'stream_bound'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_handoffs AS handoff
    WHERE handoff.reservation_key = NEW.reservation_key
      AND handoff.owner_generation = NEW.owner_generation
      AND handoff.attempt_generation = NEW.attempt_generation
      AND handoff.channel_id = NEW.channel_id
      AND handoff.selected_group = NEW.selected_group
      AND handoff.expr_hash = NEW.expr_hash
      AND handoff.provider_operation_id = NEW.provider_operation_id
      AND handoff.worker_version_id = NEW.worker_version_id
      AND handoff.billing_snapshot_sha256 = NEW.billing_snapshot_sha256
  ) THEN RAISE(ABORT, 'relay HTTP stream dispatch handoff is missing') END;
END;

CREATE TRIGGER relay_http_stream_dispatch_intent_recovery_guard
BEFORE UPDATE ON relay_http_stream_dispatch_intents
WHEN NEW.status = 'recovery_required'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_billing_reservations AS reservation
    WHERE reservation.reservation_key = OLD.reservation_key
      AND reservation.status = 'reserved'
      AND reservation.owner_generation = OLD.owner_generation
      AND reservation.channel_id = OLD.channel_id
      AND reservation.selected_group = OLD.selected_group
      AND reservation.selected_at = OLD.selected_at
      AND reservation.lease_expires_at = OLD.lease_expires_at
  ) THEN RAISE(ABORT, 'relay HTTP stream dispatch recovery reservation mismatch') END;
END;

CREATE TRIGGER relay_http_stream_dispatch_intent_delete_guard
BEFORE DELETE ON relay_http_stream_dispatch_intents
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream dispatch evidence is append-preserved');
END;

CREATE TRIGGER relay_http_stream_handoff_dispatch_deadline_guard
BEFORE UPDATE OF dispatch_hard_deadline_at ON relay_http_stream_handoffs
WHEN NEW.dispatch_hard_deadline_at IS NOT OLD.dispatch_hard_deadline_at
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream dispatch deadline is immutable');
END;

CREATE TRIGGER relay_http_stream_handoff_dispatch_intent_guard
BEFORE INSERT ON relay_http_stream_handoffs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_dispatch_intents AS dispatch
    WHERE dispatch.reservation_key = NEW.reservation_key
      AND dispatch.status = 'response_received'
      AND dispatch.response_status = 200
      AND dispatch.owner_generation = NEW.owner_generation
      AND dispatch.attempt_generation = NEW.attempt_generation
      AND dispatch.channel_id = NEW.channel_id
      AND dispatch.selected_group = NEW.selected_group
      AND dispatch.expr_hash = NEW.expr_hash
      AND dispatch.provider_operation_id = NEW.provider_operation_id
      AND dispatch.worker_version_id = NEW.worker_version_id
      AND dispatch.billing_snapshot_sha256 = NEW.billing_snapshot_sha256
      AND dispatch.hard_deadline_at = NEW.dispatch_hard_deadline_at
  ) THEN RAISE(ABORT, 'relay HTTP stream handoff dispatch intent mismatch') END;
END;

CREATE TRIGGER relay_http_stream_handoff_dispatch_intent_bind
AFTER INSERT ON relay_http_stream_handoffs
BEGIN
  UPDATE relay_http_stream_dispatch_intents
  SET status = 'stream_bound', handoff_bound_at = NEW.created_at,
      updated_at = NEW.created_at
  WHERE reservation_key = NEW.reservation_key
    AND owner_generation = NEW.owner_generation
    AND attempt_generation = NEW.attempt_generation
    AND status = 'response_received'
    AND response_status = 200
    AND provider_operation_id = NEW.provider_operation_id
    AND NEW.created_at >= response_received_at;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM relay_http_stream_dispatch_intents AS dispatch
    WHERE dispatch.reservation_key = NEW.reservation_key
      AND dispatch.owner_generation = NEW.owner_generation
      AND dispatch.attempt_generation = NEW.attempt_generation
      AND dispatch.status = 'stream_bound'
      AND dispatch.provider_operation_id = NEW.provider_operation_id
      AND dispatch.hard_deadline_at = NEW.dispatch_hard_deadline_at
      AND dispatch.handoff_bound_at = NEW.created_at
  ) THEN RAISE(ABORT, 'relay HTTP stream dispatch handoff bind failed') END;
END;
