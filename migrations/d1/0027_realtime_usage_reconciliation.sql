ALTER TABLE realtime_billing_reservations
  ADD COLUMN finalization_owner TEXT NOT NULL DEFAULT '';

ALTER TABLE realtime_billing_reservations
  ADD COLUMN finalization_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE realtime_billing_reservations
  ADD COLUMN finalization_required_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_recovery_state
  ADD COLUMN last_recovery_required INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_finalization_owner
  ON realtime_billing_reservations(
    finalization_required_at,
    reservation_sequence,
    reservation_key
  )
  WHERE status = 'reserved' AND finalization_owner = 'usage_reconciliation';
