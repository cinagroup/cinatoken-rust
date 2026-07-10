CREATE TABLE IF NOT EXISTS realtime_billing_reservations (
  reservation_key TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  client_event_id_hash TEXT NOT NULL DEFAULT '',
  reservation_sequence INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL,
  token_id INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL,
  selected_group TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL,
  pre_consumed_quota INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  token_name TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL DEFAULT 0,
  endpoint_path TEXT NOT NULL DEFAULT 'realtime',
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'settled', 'refunded')),
  upstream_response_id_hash TEXT NOT NULL DEFAULT '',
  replay_key TEXT NOT NULL DEFAULT '',
  final_quota INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER NOT NULL DEFAULT 0,
  refunded_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_session_status
  ON realtime_billing_reservations(session, status, reservation_sequence, reservation_key);

CREATE INDEX IF NOT EXISTS idx_realtime_billing_reservations_user_status
  ON realtime_billing_reservations(user_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reservations_replay_key
  ON realtime_billing_reservations(replay_key)
  WHERE replay_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_billing_reservations_response
  ON realtime_billing_reservations(session, upstream_response_id_hash)
  WHERE upstream_response_id_hash <> '';
