-- Daily check-in records (Go model.Checkin, model/checkin.go).
--
-- The unique (user_id, checkin_date) index is the concurrency guard that keeps
-- a user from receiving the daily award more than once.

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  quota_awarded INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_user_date
  ON checkins(user_id, checkin_date);

