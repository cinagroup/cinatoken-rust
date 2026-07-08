CREATE TABLE IF NOT EXISTS realtime_settlement_replays (
  replay_key TEXT PRIMARY KEY,
  session TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  token_id INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL DEFAULT 0,
  model_name TEXT NOT NULL DEFAULT '',
  pre_consumed_quota INTEGER NOT NULL DEFAULT 0,
  final_quota INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied',
  created_at INTEGER NOT NULL DEFAULT 0,
  applied_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_realtime_settlement_replays_user
  ON realtime_settlement_replays(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_realtime_settlement_replays_status
  ON realtime_settlement_replays(status, created_at);
