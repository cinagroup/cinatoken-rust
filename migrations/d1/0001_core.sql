CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL DEFAULT '',
  github_id TEXT NOT NULL DEFAULT '',
  discord_id TEXT NOT NULL DEFAULT '',
  oidc_id TEXT NOT NULL DEFAULT '',
  wechat_id TEXT NOT NULL DEFAULT '',
  telegram_id TEXT NOT NULL DEFAULT '',
  linux_do_id TEXT NOT NULL DEFAULT '',
  access_token TEXT UNIQUE,
  quota INTEGER NOT NULL DEFAULT 0,
  used_quota INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT 'default',
  aff_code TEXT NOT NULL DEFAULT '' UNIQUE,
  aff_count INTEGER NOT NULL DEFAULT 0,
  aff_quota INTEGER NOT NULL DEFAULT 0,
  aff_history INTEGER NOT NULL DEFAULT 0,
  inviter_id INTEGER NOT NULL DEFAULT 0,
  setting TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  stripe_customer TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_group ON users("group");
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  "key" TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  created_time INTEGER NOT NULL DEFAULT 0,
  accessed_time INTEGER NOT NULL DEFAULT 0,
  expired_time INTEGER NOT NULL DEFAULT -1,
  remain_quota INTEGER NOT NULL DEFAULT 0,
  unlimited_quota INTEGER NOT NULL DEFAULT 0,
  model_limits_enabled INTEGER NOT NULL DEFAULT 0,
  model_limits TEXT NOT NULL DEFAULT '',
  allow_ips TEXT NOT NULL DEFAULT '',
  used_quota INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  cross_group_retry INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_key ON tokens("key");
CREATE INDEX IF NOT EXISTS idx_tokens_deleted_at ON tokens(deleted_at);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL DEFAULT 0,
  "key" TEXT NOT NULL,
  openai_organization TEXT,
  test_model TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  test_time INTEGER NOT NULL DEFAULT 0,
  response_time INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  balance_updated_time INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '',
  "group" TEXT NOT NULL DEFAULT 'default',
  used_quota INTEGER NOT NULL DEFAULT 0,
  model_mapping TEXT,
  status_code_mapping TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  auto_ban INTEGER NOT NULL DEFAULT 1,
  other_info TEXT NOT NULL DEFAULT '',
  tag TEXT,
  setting TEXT,
  param_override TEXT,
  header_override TEXT,
  remark TEXT,
  channel_info TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
CREATE INDEX IF NOT EXISTS idx_channels_tag ON channels(tag);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels("group");

CREATE TABLE IF NOT EXISTS abilities (
  id INTEGER PRIMARY KEY,
  group_name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_abilities_group_model ON abilities(group_name, model);
CREATE INDEX IF NOT EXISTS idx_abilities_channel_id ON abilities(channel_id);

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  token_name TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  use_time INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER NOT NULL DEFAULT 0,
  token_id INTEGER NOT NULL DEFAULT 0,
  "group" TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  upstream_request_id TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at_id ON logs(created_at, id);
CREATE INDEX IF NOT EXISTS idx_logs_user_id_id ON logs(user_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_model_name ON logs(model_name);
CREATE INDEX IF NOT EXISTS idx_logs_request_id ON logs(request_id);
CREATE INDEX IF NOT EXISTS idx_logs_upstream_request_id ON logs(upstream_request_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  upstream_task_id TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  "group" TEXT NOT NULL DEFAULT '',
  channel_id INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  submit_time INTEGER NOT NULL DEFAULT 0,
  start_time INTEGER NOT NULL DEFAULT 0,
  finish_time INTEGER NOT NULL DEFAULT 0,
  properties TEXT NOT NULL DEFAULT '{}',
  private_data TEXT NOT NULL DEFAULT '{}',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_channel_id ON tasks(channel_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  raw_payload TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order_id ON payment_events(order_id);

CREATE TABLE IF NOT EXISTS subscription_orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  order_no TEXT NOT NULL UNIQUE,
  plan_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subscription_orders_user_id ON subscription_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_orders_status ON subscription_orders(status);
