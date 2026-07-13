ALTER TABLE logs
  ADD COLUMN billing_finalization_event_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_billing_finalization_event_id
  ON logs(billing_finalization_event_id)
  WHERE billing_finalization_event_id <> '';
