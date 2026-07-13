CREATE TABLE relay_billing_finalization_incidents (
  incident_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL DEFAULT '',
  queue_message_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL CHECK (classification IN ('replayable', 'invalid')),
  status TEXT NOT NULL CHECK (status IN ('open', 'replaying', 'resolved', 'invalid')),
  delivery_count INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  replay_generation INTEGER NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  replay_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_attempt_count >= 0),
  replay_lease_expires_at INTEGER NOT NULL DEFAULT 0,
  last_replay_at INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER NOT NULL DEFAULT 0,
  resolution TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (
    (classification = 'replayable' AND payload_json <> '' AND status <> 'invalid') OR
    (classification = 'invalid' AND payload_json = '' AND status = 'invalid')
  )
);

CREATE UNIQUE INDEX idx_relay_billing_finalization_incidents_event
  ON relay_billing_finalization_incidents(event_id)
  WHERE event_id <> '';

CREATE INDEX idx_relay_billing_finalization_incidents_status
  ON relay_billing_finalization_incidents(status, last_seen_at DESC);
