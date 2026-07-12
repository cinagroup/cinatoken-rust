-- A reservation created before bridge-segment ownership cannot be safely
-- attributed to one of multiple sockets in the same Durable Object. Require
-- explicit reconciliation before enabling segment-scoped cleanup.
CREATE TABLE IF NOT EXISTS migration_0021_realtime_segment_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

DELETE FROM migration_0021_realtime_segment_guard;

INSERT INTO migration_0021_realtime_segment_guard (active_count)
SELECT COUNT(1)
FROM realtime_billing_reservations
WHERE status = 'reserved';

DROP TABLE migration_0021_realtime_segment_guard;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN bridge_segment TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_segment_status
  ON realtime_billing_reservations(
    session,
    bridge_segment,
    status,
    reservation_sequence,
    reservation_key
  );
