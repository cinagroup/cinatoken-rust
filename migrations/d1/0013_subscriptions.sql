-- Go-compatible subscription schema. The original 0001 migration created a
-- small payment-order stub; keep those legacy columns and add the Go fields so
-- existing D1 databases and fresh databases converge on the same shape.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  price_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  duration_unit TEXT NOT NULL DEFAULT 'month',
  duration_value INTEGER NOT NULL DEFAULT 1,
  custom_seconds INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  allow_balance_pay INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT NOT NULL DEFAULT '',
  creem_product_id TEXT NOT NULL DEFAULT '',
  waffo_pancake_product_id TEXT NOT NULL DEFAULT '',
  max_purchase_per_user INTEGER NOT NULL DEFAULT 0,
  upgrade_group TEXT NOT NULL DEFAULT '',
  total_amount INTEGER NOT NULL DEFAULT 0,
  quota_reset_period TEXT NOT NULL DEFAULT 'never',
  quota_reset_custom_seconds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_enabled_sort
  ON subscription_plans(enabled, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_upgrade_group
  ON subscription_plans(upgrade_group);

ALTER TABLE subscription_orders ADD COLUMN money REAL NOT NULL DEFAULT 0;
ALTER TABLE subscription_orders ADD COLUMN trade_no TEXT NOT NULL DEFAULT '';
ALTER TABLE subscription_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE subscription_orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE subscription_orders ADD COLUMN create_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_orders ADD COLUMN complete_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_orders ADD COLUMN provider_payload TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_orders_trade_no
  ON subscription_orders(trade_no)
  WHERE trade_no <> '';
CREATE INDEX IF NOT EXISTS idx_subscription_orders_plan_id
  ON subscription_orders(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscription_orders_provider_status
  ON subscription_orders(payment_provider, status);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  amount_total INTEGER NOT NULL DEFAULT 0,
  amount_used INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  end_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'order',
  last_reset_time INTEGER NOT NULL DEFAULT 0,
  next_reset_time INTEGER NOT NULL DEFAULT 0,
  upgrade_group TEXT NOT NULL DEFAULT '',
  prev_user_group TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_active
  ON user_subscriptions(user_id, status, end_time);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan_id
  ON user_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_next_reset_time
  ON user_subscriptions(next_reset_time);

CREATE TABLE IF NOT EXISTS subscription_pre_consume_records (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL DEFAULT 0,
  user_subscription_id INTEGER NOT NULL DEFAULT 0,
  pre_consumed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subscription_pre_consume_user_id
  ON subscription_pre_consume_records(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_pre_consume_user_subscription_id
  ON subscription_pre_consume_records(user_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_pre_consume_status
  ON subscription_pre_consume_records(status);
CREATE INDEX IF NOT EXISTS idx_subscription_pre_consume_updated_at
  ON subscription_pre_consume_records(updated_at);
