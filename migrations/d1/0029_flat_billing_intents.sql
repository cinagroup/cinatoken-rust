ALTER TABLE relay_billing_reservations
  ADD COLUMN billing_kind TEXT NOT NULL DEFAULT 'tiered_expr'
    CHECK (billing_kind IN ('tiered_expr', 'flat'));

ALTER TABLE relay_billing_reservations
  ADD COLUMN billing_snapshot_json TEXT NOT NULL DEFAULT ''
    CHECK (length(billing_snapshot_json) <= 32768);

CREATE TRIGGER relay_flat_billing_snapshot_insert_guard
BEFORE INSERT ON relay_billing_reservations
WHEN NEW.billing_kind = 'flat' AND length(trim(NEW.billing_snapshot_json)) = 0
BEGIN
  SELECT RAISE(ABORT, 'flat billing snapshot is required');
END;

CREATE TRIGGER relay_flat_billing_snapshot_update_guard
BEFORE UPDATE OF billing_kind, billing_snapshot_json ON relay_billing_reservations
WHEN NEW.billing_kind = 'flat' AND length(trim(NEW.billing_snapshot_json)) = 0
BEGIN
  SELECT RAISE(ABORT, 'flat billing snapshot is required');
END;
