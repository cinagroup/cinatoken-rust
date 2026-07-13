CREATE TABLE IF NOT EXISTS relay_billing_reservations (
  reservation_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  token_id INTEGER NOT NULL DEFAULT 0 CHECK (token_id >= 0),
  model_name TEXT NOT NULL CHECK (length(model_name) > 0),
  endpoint_path TEXT NOT NULL DEFAULT '',
  request_id_hash TEXT NOT NULL DEFAULT '',
  expr_hash TEXT NOT NULL DEFAULT '',
  candidate_group_count INTEGER NOT NULL DEFAULT 1 CHECK (candidate_group_count > 0),
  reservation_strategy TEXT NOT NULL DEFAULT 'selected_group',
  pre_consumed_quota INTEGER NOT NULL DEFAULT 0 CHECK (pre_consumed_quota >= 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'settled', 'refunded', 'recovery_required')),
  channel_id INTEGER NOT NULL DEFAULT 0 CHECK (channel_id >= 0),
  selected_group TEXT NOT NULL DEFAULT '',
  selected_at INTEGER NOT NULL DEFAULT 0,
  final_quota INTEGER NOT NULL DEFAULT 0 CHECK (final_quota >= 0),
  finalization_reason TEXT NOT NULL DEFAULT '',
  request_accounted INTEGER NOT NULL DEFAULT 0 CHECK (request_accounted IN (0, 1)),
  lease_expires_at INTEGER NOT NULL,
  recovery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
  recovery_next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (recovery_next_attempt_at >= 0),
  recovery_last_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (recovery_last_attempt_at >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER NOT NULL DEFAULT 0,
  refunded_at INTEGER NOT NULL DEFAULT 0,
  recovery_required_at INTEGER NOT NULL DEFAULT 0,
  CHECK (reservation_strategy IN ('selected_group', 'max_candidate_group')),
  CHECK (lease_expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (channel_id = 0 AND selected_group = '' AND selected_at = 0)
    OR (channel_id > 0 AND length(selected_group) > 0 AND selected_at > 0)
  ),
  CHECK (
    (status = 'reserved' AND settled_at = 0 AND refunded_at = 0 AND recovery_required_at = 0)
    OR (
      status = 'settled' AND channel_id > 0 AND length(finalization_reason) > 0
      AND request_accounted = 1 AND settled_at > 0
      AND refunded_at = 0 AND recovery_required_at = 0
    )
    OR (
      status = 'refunded' AND length(finalization_reason) > 0 AND settled_at = 0
      AND refunded_at > 0 AND recovery_required_at = 0
    )
    OR (
      status = 'recovery_required' AND channel_id > 0
      AND length(finalization_reason) > 0 AND settled_at = 0
      AND refunded_at = 0 AND recovery_required_at > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_relay_billing_reservations_global_lease
  ON relay_billing_reservations(
    lease_expires_at,
    recovery_next_attempt_at,
    reservation_key
  )
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_relay_billing_reservations_recent_outcome
  ON relay_billing_reservations(updated_at DESC, reservation_key);

CREATE INDEX IF NOT EXISTS idx_relay_billing_reservations_recovery_required
  ON relay_billing_reservations(recovery_required_at, reservation_key)
  WHERE status = 'recovery_required';

CREATE TABLE IF NOT EXISTS relay_billing_recovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_started_at INTEGER NOT NULL DEFAULT 0,
  last_completed_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER NOT NULL DEFAULT 0,
  last_candidates INTEGER NOT NULL DEFAULT 0,
  last_refunded INTEGER NOT NULL DEFAULT 0,
  last_recovery_required INTEGER NOT NULL DEFAULT 0,
  last_failed INTEGER NOT NULL DEFAULT 0,
  last_deferred INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO relay_billing_recovery_state (id) VALUES (1);
