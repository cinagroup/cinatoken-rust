-- Durable Object alarm state cannot be reconstructed by a D1 migration. Fail
-- closed until every pre-lease reservation has been explicitly reconciled.
CREATE TABLE IF NOT EXISTS migration_0020_realtime_reservation_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

DELETE FROM migration_0020_realtime_reservation_guard;

INSERT INTO migration_0020_realtime_reservation_guard (active_count)
SELECT COUNT(1)
FROM realtime_billing_reservations
WHERE status = 'reserved';

DROP TABLE migration_0020_realtime_reservation_guard;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_lease
  ON realtime_billing_reservations(session, status, lease_expires_at, reservation_sequence)
  WHERE status = 'reserved' AND lease_expires_at > 0;
