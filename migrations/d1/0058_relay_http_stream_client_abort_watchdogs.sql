-- Durable client-disconnect evidence for ordinary HTTP SSE relays.
--
-- The Worker inserts one bounded, append-preserved observation when the
-- incoming Request.signal aborts. The insert and the forwarding ->
-- recovery_required transition share one SQLite transaction. A provider
-- terminal that was already persisted wins the race and remains untouched.

CREATE TABLE relay_http_stream_client_abort_events (
  reservation_key TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 160
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation >= 2),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation >= 1),
  provider_operation_id TEXT NOT NULL
    CHECK (
      typeof(provider_operation_id) = 'text'
      AND length(provider_operation_id) = 64
      AND provider_operation_id NOT GLOB '*[^0-9a-f]*'
    ),
  worker_version_id TEXT NOT NULL
    CHECK (
      typeof(worker_version_id) = 'text'
      AND length(worker_version_id) BETWEEN 1 AND 128
      AND substr(worker_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND worker_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  signal_contract_version INTEGER NOT NULL
    CHECK (typeof(signal_contract_version) = 'integer' AND signal_contract_version = 1),
  observed_at INTEGER NOT NULL
    CHECK (typeof(observed_at) = 'integer' AND observed_at > 0),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_http_stream_handoffs(reservation_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX idx_relay_http_stream_client_abort_events_observed
  ON relay_http_stream_client_abort_events(observed_at, reservation_key);

CREATE TRIGGER relay_http_stream_client_abort_event_insert_guard
BEFORE INSERT ON relay_http_stream_client_abort_events
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_handoffs AS handoff
    WHERE handoff.reservation_key = NEW.reservation_key
      AND handoff.owner_generation = NEW.owner_generation
      AND handoff.attempt_generation = NEW.attempt_generation
      AND handoff.provider_operation_id = NEW.provider_operation_id
      AND handoff.worker_version_id = NEW.worker_version_id
      AND NEW.signal_contract_version = 1
      AND NEW.observed_at >= handoff.created_at
  ) THEN RAISE(ABORT, 'relay HTTP stream client abort identity mismatch') END;
END;

CREATE TRIGGER relay_http_stream_client_abort_event_apply
AFTER INSERT ON relay_http_stream_client_abort_events
FOR EACH ROW
BEGIN
  UPDATE relay_http_stream_handoffs
  SET status = 'recovery_required',
      terminal_kind = 'worker_termination',
      terminal_reason = 'client_disconnected',
      recovery_required_at = NEW.observed_at,
      updated_at = MAX(updated_at, NEW.observed_at)
  WHERE reservation_key = NEW.reservation_key
    AND owner_generation = NEW.owner_generation
    AND attempt_generation = NEW.attempt_generation
    AND provider_operation_id = NEW.provider_operation_id
    AND worker_version_id = NEW.worker_version_id
    AND status = 'forwarding'
    AND provider_terminal_observed = 0
    AND finalization_event_sha256 = ''
    AND outbox_status = 'none';

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_handoffs AS handoff
    WHERE handoff.reservation_key = NEW.reservation_key
      AND handoff.owner_generation = NEW.owner_generation
      AND handoff.attempt_generation = NEW.attempt_generation
      AND handoff.provider_operation_id = NEW.provider_operation_id
      AND handoff.worker_version_id = NEW.worker_version_id
      AND (
        (handoff.status = 'recovery_required'
          AND handoff.terminal_reason <> '')
        OR handoff.status IN (
          'terminal_staged', 'finalization_enqueued', 'terminal'
        )
      )
  ) THEN RAISE(ABORT, 'relay HTTP stream client abort apply failed') END;
END;

CREATE TRIGGER relay_http_stream_client_abort_terminal_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN OLD.status = 'recovery_required'
  AND OLD.terminal_kind = 'worker_termination'
  AND OLD.terminal_reason = 'client_disconnected'
  AND NEW.status <> 'recovery_required'
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream client abort decision is terminal');
END;

CREATE TRIGGER relay_http_stream_client_abort_event_update_guard
BEFORE UPDATE ON relay_http_stream_client_abort_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream client abort events are immutable');
END;

CREATE TRIGGER relay_http_stream_client_abort_event_delete_guard
BEFORE DELETE ON relay_http_stream_client_abort_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream client abort events are append-preserved');
END;
