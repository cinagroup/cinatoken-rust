ALTER TABLE realtime_billing_reservations
  ADD COLUMN recovery_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN recovery_next_attempt_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN recovery_last_attempt_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS realtime_billing_recovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_started_at INTEGER NOT NULL DEFAULT 0,
  last_completed_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER NOT NULL DEFAULT 0,
  last_candidates INTEGER NOT NULL DEFAULT 0,
  last_refunded INTEGER NOT NULL DEFAULT 0,
  last_failed INTEGER NOT NULL DEFAULT 0,
  last_deferred INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO realtime_billing_recovery_state (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_global_lease
  ON realtime_billing_reservations(
    lease_expires_at,
    reservation_sequence,
    reservation_key
  )
  WHERE status = 'reserved' AND lease_expires_at > 0;

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_recent_outcome
  ON realtime_billing_reservations(
    updated_at DESC,
    reservation_sequence DESC,
    reservation_key
  );
