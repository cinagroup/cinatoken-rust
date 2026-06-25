-- Migration 0003: topups table for Stripe payment flow.
--
-- Stores topup orders created when a user initiates a Stripe checkout
-- session. The webhook handler flips status from pending (0) to success (1)
-- and credits the user's quota atomically. Mirrors Go `model/topup.go:14-25`.
--
-- Idempotency: the webhook handler uses `WHERE status = 0` in the UPDATE to
-- ensure a topup is completed exactly once, backed by the UNIQUE constraint
-- on trade_no and the payment_events table's UNIQUE(provider, event_id).
--
-- Idempotent: every statement uses IF NOT EXISTS so re-applying is safe.

CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,    -- quota to credit on completion
  money REAL NOT NULL DEFAULT 0.0,      -- USD amount paid
  trade_no TEXT NOT NULL UNIQUE,        -- internal order id (ref_ + sha1)
  payment_method TEXT NOT NULL DEFAULT 'stripe',
  status INTEGER NOT NULL DEFAULT 0,    -- 0=pending, 1=success, 2=failed, 3=expired
  create_time INTEGER NOT NULL DEFAULT 0,
  complete_time INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_topups_user_id ON topups(user_id);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);
CREATE INDEX IF NOT EXISTS idx_topups_trade_no ON topups(trade_no);
