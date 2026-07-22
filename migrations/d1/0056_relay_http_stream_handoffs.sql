-- Durable handoff for ordinary HTTP SSE relays.
--
-- The row is created after the billing reservation is bound to one selected
-- provider attempt and before response bytes are exposed to the client. It
-- stores only bounded accounting evidence: counters, usage, rolling hashes,
-- and the frozen billing finalization event. Request/response bodies and raw
-- SSE frames are deliberately excluded.

CREATE TABLE relay_http_stream_handoffs (
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
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_group TEXT NOT NULL
    CHECK (
      typeof(selected_group) = 'text'
      AND length(selected_group) BETWEEN 1 AND 128
      AND selected_group = trim(selected_group)
    ),
  expr_hash TEXT NOT NULL
    CHECK (
      typeof(expr_hash) = 'text'
      AND length(expr_hash) BETWEEN 1 AND 96
      AND expr_hash = trim(expr_hash)
    ),
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
  billing_snapshot_sha256 TEXT NOT NULL
    CHECK (
      typeof(billing_snapshot_sha256) = 'text'
      AND length(billing_snapshot_sha256) = 64
      AND billing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'forwarding'
    CHECK (
      status IN (
        'forwarding', 'terminal_staged', 'finalization_enqueued', 'terminal',
        'recovery_required'
      )
    ),
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at > 0),
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(checkpoint_sequence) = 'integer' AND checkpoint_sequence >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(chunk_count) = 'integer' AND chunk_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(byte_count) = 'integer' AND byte_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(prompt_tokens) = 'integer' AND prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(completion_tokens) = 'integer' AND completion_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_tokens) = 'integer' AND total_tokens >= 0),
  cached_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cached_tokens) = 'integer' AND cached_tokens >= 0),
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cache_creation_tokens) = 'integer' AND cache_creation_tokens >= 0),
  provider_terminal_observed INTEGER NOT NULL DEFAULT 0
    CHECK (provider_terminal_observed IN (0, 1)),
  rolling_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      rolling_sha256 = ''
      OR (
        typeof(rolling_sha256) = 'text'
        AND length(rolling_sha256) = 64
        AND rolling_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  terminal_kind TEXT NOT NULL DEFAULT ''
    CHECK (
      terminal_kind IN (
        '', 'provider_done', 'provider_error', 'eof_without_provider_terminal',
        'idle_timeout', 'stream_read_error', 'worker_termination'
      )
    ),
  terminal_reason TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(terminal_reason) = 'text'
      AND length(terminal_reason) <= 96
    ),
  finalization_event_json TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(finalization_event_json) = 'text'
      AND length(CAST(finalization_event_json AS BLOB)) <= 65536
    ),
  finalization_event_id TEXT NOT NULL DEFAULT ''
    CHECK (
      finalization_event_id = ''
      OR (
        typeof(finalization_event_id) = 'text'
        AND length(finalization_event_id) BETWEEN 1 AND 192
        AND finalization_event_id = trim(finalization_event_id)
      )
    ),
  finalization_event_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      finalization_event_sha256 = ''
      OR (
        typeof(finalization_event_sha256) = 'text'
        AND length(finalization_event_sha256) = 64
        AND finalization_event_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  outbox_status TEXT NOT NULL DEFAULT 'none'
    CHECK (
      outbox_status IN ('none', 'pending', 'leased', 'delivered', 'dead_letter')
    ),
  delivery_generation INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivery_generation) = 'integer' AND delivery_generation >= 0),
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivery_attempt_count) = 'integer' AND delivery_attempt_count >= 0),
  delivery_lease_expires_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(delivery_lease_expires_at) = 'integer'
      AND delivery_lease_expires_at >= 0
    ),
  delivery_available_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivery_available_at) = 'integer' AND delivery_available_at >= 0),
  delivered_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(delivered_at) = 'integer' AND delivered_at >= 0),
  finalization_applied_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(finalization_applied_at) = 'integer' AND finalization_applied_at >= 0),
  last_error TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(last_error) = 'text'
      AND length(CAST(last_error AS BLOB)) <= 4096
    ),
  terminal_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(terminal_at) = 'integer' AND terminal_at >= 0),
  recovery_required_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(recovery_required_at) = 'integer' AND recovery_required_at >= 0),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  CHECK (lease_expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (checkpoint_sequence = 0 AND chunk_count = 0 AND byte_count = 0 AND rolling_sha256 = '')
    OR (checkpoint_sequence > 0 AND chunk_count > 0 AND byte_count > 0 AND rolling_sha256 <> '')
  ),
  CHECK (
    (finalization_event_json = '' AND finalization_event_id = ''
      AND finalization_event_sha256 = '')
    OR (finalization_event_json <> '' AND finalization_event_id <> ''
      AND finalization_event_sha256 <> '')
  ),
  CHECK (
    (outbox_status = 'none' AND delivery_generation = 0
      AND delivery_attempt_count = 0 AND delivery_lease_expires_at = 0
      AND delivery_available_at = 0 AND delivered_at = 0)
    OR (outbox_status = 'pending' AND delivery_lease_expires_at = 0
      AND delivery_available_at > 0 AND delivered_at = 0)
    OR (outbox_status = 'leased' AND delivery_generation > 0
      AND delivery_attempt_count > 0 AND delivery_lease_expires_at > updated_at
      AND delivery_available_at > 0 AND delivered_at = 0)
    OR (outbox_status = 'delivered' AND delivery_generation > 0
      AND delivery_attempt_count > 0 AND delivery_lease_expires_at = 0
      AND delivery_available_at > 0 AND delivered_at > 0)
    OR (outbox_status = 'dead_letter' AND delivery_attempt_count > 0
      AND delivery_lease_expires_at = 0 AND delivery_available_at > 0
      AND delivered_at = 0 AND last_error <> '')
  ),
  CHECK (
    (status = 'forwarding' AND provider_terminal_observed = 0
      AND terminal_kind = '' AND terminal_reason = ''
      AND finalization_event_json = '' AND finalization_event_id = ''
      AND outbox_status = 'none'
      AND terminal_at = 0 AND recovery_required_at = 0
      AND finalization_applied_at = 0)
    OR (status = 'terminal_staged' AND terminal_kind IN ('provider_done', 'provider_error')
      AND terminal_reason <> '' AND finalization_event_json <> ''
      AND outbox_status IN ('pending', 'leased')
      AND terminal_at > 0 AND recovery_required_at = 0
      AND finalization_applied_at = 0)
    OR (status = 'finalization_enqueued'
      AND terminal_kind IN ('provider_done', 'provider_error')
      AND terminal_reason <> '' AND finalization_event_json <> ''
      AND outbox_status = 'delivered' AND terminal_at > 0
      AND recovery_required_at = 0 AND finalization_applied_at = 0)
    OR (status = 'terminal' AND terminal_kind IN ('provider_done', 'provider_error')
      AND terminal_reason <> '' AND finalization_event_json <> ''
      AND outbox_status = 'delivered' AND terminal_at > 0
      AND recovery_required_at = 0 AND finalization_applied_at > 0)
    OR (status = 'recovery_required'
      AND terminal_kind IN (
        'eof_without_provider_terminal', 'idle_timeout', 'stream_read_error',
        'worker_termination', 'provider_done', 'provider_error'
      )
      AND terminal_reason <> '' AND recovery_required_at > 0
      AND outbox_status IN ('none', 'dead_letter')
      AND finalization_applied_at = 0)
  ),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_billing_reservations(reservation_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE relay_http_stream_finalization_receipts (
  reservation_key TEXT PRIMARY KEY NOT NULL,
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation >= 2),
  finalization_event_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(finalization_event_id) = 'text'
      AND length(finalization_event_id) BETWEEN 1 AND 192
      AND finalization_event_id = trim(finalization_event_id)
    ),
  finalization_event_sha256 TEXT NOT NULL
    CHECK (
      typeof(finalization_event_sha256) = 'text'
      AND length(finalization_event_sha256) = 64
      AND finalization_event_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  applied_at INTEGER NOT NULL
    CHECK (typeof(applied_at) = 'integer' AND applied_at > 0),
  FOREIGN KEY (reservation_key)
    REFERENCES relay_http_stream_handoffs(reservation_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (reservation_key)
    REFERENCES relay_billing_reservations(reservation_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX idx_relay_http_stream_handoffs_stale_forwarding
  ON relay_http_stream_handoffs(lease_expires_at, reservation_key)
  WHERE status = 'forwarding';

CREATE INDEX idx_relay_http_stream_handoffs_pending_outbox
  ON relay_http_stream_handoffs(delivery_available_at, reservation_key)
  WHERE outbox_status = 'pending';

CREATE INDEX idx_relay_http_stream_handoffs_expired_outbox_lease
  ON relay_http_stream_handoffs(delivery_lease_expires_at, reservation_key)
  WHERE outbox_status = 'leased';

CREATE TRIGGER relay_http_stream_handoff_insert_guard
BEFORE INSERT ON relay_http_stream_handoffs
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.status <> 'forwarding'
    OR NEW.outbox_status <> 'none'
    OR NEW.checkpoint_sequence <> 0
  THEN RAISE(ABORT, 'relay HTTP stream handoff must start forwarding') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_billing_reservations AS reservation
    WHERE reservation.reservation_key = NEW.reservation_key
      AND reservation.status = 'reserved'
      AND reservation.owner_generation = NEW.owner_generation
      AND reservation.channel_id = NEW.channel_id
      AND reservation.selected_group = NEW.selected_group
      AND reservation.expr_hash = NEW.expr_hash
      AND reservation.lease_expires_at >= NEW.lease_expires_at
  ) THEN RAISE(ABORT, 'relay HTTP stream handoff reservation identity mismatch') END;
END;

CREATE TRIGGER relay_http_stream_handoff_identity_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN NEW.reservation_key <> OLD.reservation_key
  OR NEW.owner_generation <> OLD.owner_generation
  OR NEW.attempt_generation <> OLD.attempt_generation
  OR NEW.channel_id <> OLD.channel_id
  OR NEW.selected_group <> OLD.selected_group
  OR NEW.expr_hash <> OLD.expr_hash
  OR NEW.provider_operation_id <> OLD.provider_operation_id
  OR NEW.worker_version_id <> OLD.worker_version_id
  OR NEW.billing_snapshot_sha256 <> OLD.billing_snapshot_sha256
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream handoff identity is immutable');
END;

CREATE TRIGGER relay_http_stream_handoff_checkpoint_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN NEW.checkpoint_sequence < OLD.checkpoint_sequence
  OR NEW.chunk_count < OLD.chunk_count
  OR NEW.byte_count < OLD.byte_count
  OR NEW.prompt_tokens < OLD.prompt_tokens
  OR NEW.completion_tokens < OLD.completion_tokens
  OR NEW.total_tokens < OLD.total_tokens
  OR NEW.cached_tokens < OLD.cached_tokens
  OR NEW.cache_creation_tokens < OLD.cache_creation_tokens
  OR NEW.lease_expires_at < OLD.lease_expires_at
  OR NEW.updated_at < OLD.updated_at
  OR (
    NEW.checkpoint_sequence = OLD.checkpoint_sequence
    AND (
      NEW.chunk_count <> OLD.chunk_count
      OR NEW.byte_count <> OLD.byte_count
      OR NEW.prompt_tokens <> OLD.prompt_tokens
      OR NEW.completion_tokens <> OLD.completion_tokens
      OR NEW.total_tokens <> OLD.total_tokens
      OR NEW.cached_tokens <> OLD.cached_tokens
      OR NEW.cache_creation_tokens <> OLD.cache_creation_tokens
      OR NEW.rolling_sha256 <> OLD.rolling_sha256
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream handoff checkpoint is not monotonic');
END;

CREATE TRIGGER relay_http_stream_handoff_finalization_evidence_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN OLD.finalization_event_sha256 <> '' AND (
  NEW.provider_terminal_observed <> OLD.provider_terminal_observed
  OR NEW.terminal_kind <> OLD.terminal_kind
  OR NEW.terminal_reason <> OLD.terminal_reason
  OR NEW.finalization_event_json <> OLD.finalization_event_json
  OR NEW.finalization_event_id <> OLD.finalization_event_id
  OR NEW.finalization_event_sha256 <> OLD.finalization_event_sha256
  OR NEW.terminal_at <> OLD.terminal_at
)
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream finalization evidence is immutable');
END;

CREATE TRIGGER relay_http_stream_handoff_lifecycle_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN NOT (
  (OLD.status = 'forwarding'
    AND NEW.status IN ('forwarding', 'terminal_staged', 'recovery_required'))
  OR (OLD.status = 'terminal_staged'
    AND NEW.status IN (
      'terminal_staged', 'finalization_enqueued', 'terminal', 'recovery_required'
    ))
  OR (OLD.status = 'finalization_enqueued'
    AND NEW.status IN ('finalization_enqueued', 'terminal', 'recovery_required'))
  OR (OLD.status = 'recovery_required'
    AND NEW.status IN ('recovery_required', 'terminal_staged', 'terminal'))
  OR (OLD.status = 'terminal' AND NEW.status = 'terminal')
)
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream handoff lifecycle transition is invalid');
END;

CREATE TRIGGER relay_http_stream_handoff_financial_terminal_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN NEW.status = 'terminal' AND OLD.status <> 'terminal'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_finalization_receipts AS receipt
    WHERE receipt.reservation_key = OLD.reservation_key
      AND receipt.owner_generation = OLD.owner_generation
      AND receipt.finalization_event_id = OLD.finalization_event_id
      AND receipt.finalization_event_sha256 = OLD.finalization_event_sha256
  ) THEN RAISE(ABORT, 'relay HTTP stream billing finalization receipt is missing') END;
END;

CREATE TRIGGER relay_http_stream_handoff_terminal_guard
BEFORE UPDATE ON relay_http_stream_handoffs
FOR EACH ROW
WHEN OLD.status = 'terminal' AND (
  NEW.status <> OLD.status
  OR NEW.lease_expires_at <> OLD.lease_expires_at
  OR NEW.checkpoint_sequence <> OLD.checkpoint_sequence
  OR NEW.chunk_count <> OLD.chunk_count
  OR NEW.byte_count <> OLD.byte_count
  OR NEW.prompt_tokens <> OLD.prompt_tokens
  OR NEW.completion_tokens <> OLD.completion_tokens
  OR NEW.total_tokens <> OLD.total_tokens
  OR NEW.cached_tokens <> OLD.cached_tokens
  OR NEW.cache_creation_tokens <> OLD.cache_creation_tokens
  OR NEW.provider_terminal_observed <> OLD.provider_terminal_observed
  OR NEW.rolling_sha256 <> OLD.rolling_sha256
  OR NEW.terminal_kind <> OLD.terminal_kind
  OR NEW.terminal_reason <> OLD.terminal_reason
  OR NEW.finalization_event_json <> OLD.finalization_event_json
  OR NEW.finalization_event_id <> OLD.finalization_event_id
  OR NEW.finalization_event_sha256 <> OLD.finalization_event_sha256
  OR NEW.outbox_status <> OLD.outbox_status
  OR NEW.delivery_generation <> OLD.delivery_generation
  OR NEW.delivery_attempt_count <> OLD.delivery_attempt_count
  OR NEW.delivery_lease_expires_at <> OLD.delivery_lease_expires_at
  OR NEW.delivery_available_at <> OLD.delivery_available_at
  OR NEW.delivered_at <> OLD.delivered_at
  OR NEW.finalization_applied_at <> OLD.finalization_applied_at
  OR NEW.last_error <> OLD.last_error
  OR NEW.terminal_at <> OLD.terminal_at
  OR NEW.recovery_required_at <> OLD.recovery_required_at
  OR NEW.updated_at <> OLD.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream handoff terminal state is immutable');
END;

CREATE TRIGGER relay_http_stream_finalization_receipt_insert_guard
BEFORE INSERT ON relay_http_stream_finalization_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_http_stream_handoffs AS handoff
    JOIN relay_billing_reservations AS reservation
      ON reservation.reservation_key = handoff.reservation_key
    JOIN logs AS audit
      ON audit.billing_finalization_event_id = handoff.finalization_event_id
    WHERE handoff.reservation_key = NEW.reservation_key
      AND handoff.owner_generation = NEW.owner_generation
      AND handoff.finalization_event_id = NEW.finalization_event_id
      AND handoff.finalization_event_sha256 = NEW.finalization_event_sha256
      AND handoff.status IN (
        'terminal_staged', 'finalization_enqueued', 'recovery_required', 'terminal'
      )
      AND reservation.status IN ('settled', 'refunded')
      AND reservation.owner_generation = NEW.owner_generation + 1
  ) THEN RAISE(ABORT, 'relay HTTP stream finalization receipt identity mismatch') END;
END;

CREATE TRIGGER relay_http_stream_finalization_receipt_update_guard
BEFORE UPDATE ON relay_http_stream_finalization_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream finalization receipts are immutable');
END;

CREATE TRIGGER relay_http_stream_finalization_receipt_delete_guard
BEFORE DELETE ON relay_http_stream_finalization_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream finalization receipts are append-preserved');
END;

CREATE TRIGGER relay_http_stream_handoff_delete_guard
BEFORE DELETE ON relay_http_stream_handoffs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay HTTP stream handoff rows are append-preserved');
END;
