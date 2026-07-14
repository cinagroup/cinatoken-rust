ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_id TEXT NOT NULL DEFAULT '';

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_resolution TEXT NOT NULL DEFAULT ''
    CHECK (reconciliation_resolution IN ('', 'settled', 'refunded'));

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_resolution_key TEXT NOT NULL DEFAULT '';

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_resolved_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_operator_id INTEGER NOT NULL DEFAULT 0;

ALTER TABLE realtime_billing_reservations
  ADD COLUMN reconciliation_evidence_sha256 TEXT NOT NULL DEFAULT '';

UPDATE realtime_billing_reservations
SET reconciliation_id = lower(hex(randomblob(32)))
WHERE reconciliation_id = ''
  AND status = 'reserved'
  AND finalization_owner = 'usage_reconciliation';

UPDATE realtime_billing_reservations
SET reconciliation_revision = 1
WHERE status = 'reserved'
  AND finalization_owner = 'usage_reconciliation'
  AND reconciliation_revision = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reconciliation_id
  ON realtime_billing_reservations(reconciliation_id)
  WHERE reconciliation_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reconciliation_resolution_key
  ON realtime_billing_reservations(reconciliation_resolution_key)
  WHERE reconciliation_resolution_key <> '';

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reconciliation_operator_queue
  ON realtime_billing_reservations(
    finalization_required_at,
    reconciliation_id
  )
  WHERE status = 'reserved'
    AND finalization_owner = 'usage_reconciliation'
    AND reconciliation_resolution = '';
