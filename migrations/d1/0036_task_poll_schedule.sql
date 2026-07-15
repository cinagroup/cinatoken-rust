-- Persisted, family-fair scheduling for generation-fenced async task polling.
--
-- D1 is the scheduling authority. Durable Object alarms are optional wake-up
-- accelerators and must obey these due-at/quarantine fields before provider I/O.
-- This migration is rolling-compatible with 0035-aware Workers: every added
-- column has an inert default and no existing lifecycle writer is rejected.

ALTER TABLE tasks
  ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0
  CHECK (next_poll_at >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (poll_attempt_count >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK (poll_consecutive_failures >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_last_attempt_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_last_attempt_at >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_last_error_code TEXT NOT NULL DEFAULT ''
  CHECK (length(poll_last_error_code) <= 64);
ALTER TABLE tasks
  ADD COLUMN poll_quarantined_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_quarantined_at >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_quarantine_reason TEXT NOT NULL DEFAULT ''
  CHECK (length(poll_quarantine_reason) <= 64);

ALTER TABLE midjourneys
  ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0
  CHECK (next_poll_at >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (poll_attempt_count >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK (poll_consecutive_failures >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_last_attempt_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_last_attempt_at >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_last_error_code TEXT NOT NULL DEFAULT ''
  CHECK (length(poll_last_error_code) <= 64);
ALTER TABLE midjourneys
  ADD COLUMN poll_quarantined_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_quarantined_at >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_quarantine_reason TEXT NOT NULL DEFAULT ''
  CHECK (length(poll_quarantine_reason) <= 64);

CREATE INDEX idx_tasks_poll_schedule_due
  ON tasks(next_poll_at, id)
  WHERE status NOT IN ('SUCCESS', 'FAILURE')
    AND upstream_task_id != ''
    AND poll_quarantined_at = 0;

CREATE INDEX idx_midjourneys_poll_schedule_due
  ON midjourneys(next_poll_at, id)
  WHERE status NOT IN ('SUCCESS', 'FAILURE')
    AND mj_id != ''
    AND poll_quarantined_at = 0;

CREATE TABLE task_poll_family_cursors (
  family TEXT PRIMARY KEY
    CHECK (family IN (
      'video',
      'suno',
      'midjourney',
      'task_timeout',
      'midjourney_timeout'
    )),
  last_row_id INTEGER NOT NULL DEFAULT 0 CHECK (last_row_id >= 0),
  round_high_watermark INTEGER NOT NULL DEFAULT 0
    CHECK (round_high_watermark >= 0),
  scan_generation INTEGER NOT NULL DEFAULT 0 CHECK (scan_generation >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
  CHECK (round_high_watermark >= last_row_id)
);

INSERT INTO task_poll_family_cursors (family) VALUES
  ('video'),
  ('suno'),
  ('midjourney'),
  ('task_timeout'),
  ('midjourney_timeout');
