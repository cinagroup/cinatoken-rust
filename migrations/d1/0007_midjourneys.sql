-- Midjourney task subsystem (Go model.Midjourney, model/midjourney.go).
--
-- Midjourney predates the unified TaskAdaptor and keeps its own model,
-- controller, submit, and batch-poll, so it persists to a dedicated table rather
-- than the shared `tasks` table. Columns + indexes mirror the Go struct (gorm
-- tags). `video_urls`/`buttons`/`properties` are JSON stored as text.

CREATE TABLE IF NOT EXISTS midjourneys (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  mj_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  submit_time INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  finish_time INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  video_urls TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT 0,
  buttons TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_midjourneys_user_id ON midjourneys(user_id);
CREATE INDEX IF NOT EXISTS idx_midjourneys_action ON midjourneys(action);
CREATE INDEX IF NOT EXISTS idx_midjourneys_mj_id ON midjourneys(mj_id);
CREATE INDEX IF NOT EXISTS idx_midjourneys_submit_time ON midjourneys(submit_time);
CREATE INDEX IF NOT EXISTS idx_midjourneys_start_time ON midjourneys(start_time);
CREATE INDEX IF NOT EXISTS idx_midjourneys_finish_time ON midjourneys(finish_time);
CREATE INDEX IF NOT EXISTS idx_midjourneys_status ON midjourneys(status);
CREATE INDEX IF NOT EXISTS idx_midjourneys_progress ON midjourneys(progress);
