CREATE TABLE migration_0026_relay_owner_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

INSERT INTO migration_0026_relay_owner_guard (active_count)
SELECT COUNT(*)
FROM relay_billing_reservations
WHERE status = 'reserved';

DROP TABLE migration_0026_relay_owner_guard;

ALTER TABLE relay_billing_reservations
  ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 1
    CHECK (owner_generation > 0);

ALTER TABLE relay_billing_reservations
  ADD COLUMN owner_deadline_at INTEGER NOT NULL DEFAULT 0
    CHECK (owner_deadline_at >= 0);

ALTER TABLE relay_billing_reservations
  ADD COLUMN owner_lease_renewed_at INTEGER NOT NULL DEFAULT 0
    CHECK (owner_lease_renewed_at >= 0);

UPDATE relay_billing_reservations
SET owner_generation = 2
WHERE status <> 'reserved';
