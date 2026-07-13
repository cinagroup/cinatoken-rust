CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  "group" TEXT NOT NULL DEFAULT 'default',
  aff_code TEXT NOT NULL,
  quota INTEGER NOT NULL DEFAULT 0,
  setting TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  remain_quota INTEGER NOT NULL DEFAULT 0,
  model_limits TEXT NOT NULL DEFAULT '',
  "group" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL DEFAULT 0,
  "key" TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  base_url TEXT,
  models TEXT NOT NULL DEFAULT '',
  "group" TEXT NOT NULL DEFAULT 'default',
  channel_info TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT ''
);

CREATE TABLE abilities (
  "group" TEXT NOT NULL,
  model TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0,
  tag TEXT,
  PRIMARY KEY ("group", model, channel_id)
);

CREATE TABLE options (
  "key" TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE top_ups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  money REAL NOT NULL DEFAULT 0,
  trade_no TEXT NOT NULL UNIQUE,
  payment_method TEXT NOT NULL DEFAULT '',
  payment_provider TEXT NOT NULL DEFAULT '',
  create_time INTEGER NOT NULL DEFAULT 0,
  complete_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE passkey_credentials (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  attestation_type TEXT NOT NULL DEFAULT '',
  aaguid TEXT NOT NULL DEFAULT '',
  sign_count INTEGER NOT NULL DEFAULT 0,
  clone_warning INTEGER NOT NULL DEFAULT 0,
  user_present INTEGER NOT NULL DEFAULT 0,
  user_verified INTEGER NOT NULL DEFAULT 0,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backup_state INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE two_fas (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE two_fa_backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE midjourneys (
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

CREATE TABLE prefill_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  items BLOB,
  description TEXT NOT NULL DEFAULT '',
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE quota_data (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  model_name TEXT,
  created_at INTEGER,
  token_used INTEGER,
  count INTEGER,
  quota INTEGER
);

CREATE TABLE setups (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL,
  initialized_at INTEGER NOT NULL
);

CREATE TABLE perf_metrics (
  id INTEGER PRIMARY KEY,
  model_name TEXT,
  "group" TEXT,
  bucket_ts INTEGER,
  request_count INTEGER,
  success_count INTEGER,
  total_latency_ms INTEGER,
  ttft_sum_ms INTEGER,
  ttft_count INTEGER,
  output_tokens INTEGER,
  generation_ms INTEGER
);

INSERT INTO users (
  id, username, password, display_name, status, "group", aff_code, quota, setting
) VALUES (
  1, 'alice', 'bcrypt-hash', 'Alice', 1, 'default', 'aff-alice', 5000,
  '{"theme":"dark","limits":{"b":2,"a":1}}'
);

INSERT INTO tokens (
  id, user_id, "key", status, name, remain_quota, model_limits, "group"
) VALUES (
  10, 1, 'source-token-secret', 1, 'primary', 4000, 'gpt-test', 'default'
);

INSERT INTO channels (
  id, type, "key", status, name, base_url, models, "group", channel_info, settings
) VALUES (
  20, 1, 'source-channel-secret', 1, 'openai-compatible', NULL, 'gpt-test',
  'default', '{"multi_key_size":1,"is_multi_key":false}', '{}'
);

INSERT INTO abilities (
  "group", model, channel_id, enabled, priority, weight, tag
) VALUES (
  'default', 'gpt-test', 20, 1, 5, 100, 'primary'
);

INSERT INTO options ("key", value) VALUES
  ('ModelRatio', '{"gpt-test":1,"gpt-other":2}'),
  ('SystemName', 'CinaToken');

INSERT INTO top_ups (
  id, user_id, amount, money, trade_no, payment_method, payment_provider,
  create_time, complete_time, status
) VALUES
  (101, 1, 1000, 10.0, 'topup-pending', 'alipay', '', 1710000000, 0, 'pending'),
  (102, 1, 2000, 20.0, 'topup-success', 'stripe', 'stripe', 1710000100, 1710000110, 'success'),
  (103, 1, 3000, 30.0, 'topup-failed', 'creem', 'creem', 1710000200, 1710000210, 'failed'),
  (104, 1, 4000, 40.0, 'topup-expired', 'wxpay', 'epay', 1710000300, 1710000310, 'expired');

INSERT INTO passkey_credentials (
  id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count,
  clone_warning, user_present, user_verified, backup_eligible, backup_state,
  transports, attachment, last_used_at, created_at, updated_at, deleted_at
) VALUES (
  201, 1, 'cred-{"a":1}', 'pk\raw''quote', 'none', 'aaguid-base64==', 42,
  0, 1, 1, 1, 0, '["internal","hybrid"]', 'platform',
  '2024-03-09T17:00:00.999+01:00', '2024-03-09 16:00:00+00:00',
  '2024-03-09 16:00:10Z', NULL
);

INSERT INTO two_fas (
  id, user_id, secret, is_enabled, failed_attempts, locked_until, last_used_at,
  created_at, updated_at, deleted_at
) VALUES (
  301, 1, 'JBSWY3DPEHPK3PXP', 1, 2, '2024-03-09 16:01:00+00:00',
  '2024-03-09 16:00:20+00:00', '2024-03-09 16:00:00+00:00',
  '2024-03-09 16:00:20+00:00', NULL
);

INSERT INTO two_fa_backup_codes (
  id, user_id, code_hash, is_used, used_at, created_at, deleted_at
) VALUES
  (401, 1, '$2a$10$opaque/hash''one', 0, NULL, '2024-03-09 16:00:00+00:00', NULL),
  (402, 1, '$2a$10$opaque/hash-two', 1, '2024-03-09 16:00:30+00:00', '2024-03-09 16:00:00+00:00', NULL),
  (403, 1, '$2a$10$soft-deleted', 0, NULL, '2024-03-09 16:00:00+00:00', '2024-03-09 16:02:00+00:00');

INSERT INTO midjourneys (
  id, code, user_id, action, mj_id, prompt, prompt_en, description, state,
  submit_time, start_time, finish_time, image_url, video_url, video_urls,
  status, progress, fail_reason, channel_id, quota, buttons, properties
) VALUES (
  501, 1, 1, 'IMAGINE', 'mj-source-501', 'a ''quoted'' prompt', 'translated prompt',
  'finished task', 'state-opaque', 1710001000000, 1710001001000, 1710001009000,
  'https://example.test/image.png', '', '["https://example.test/video.mp4"]',
  'SUCCESS', '100%', '', 20, 125, '[{"label":"U1"}]', '{"seed":42}'
);

INSERT INTO prefill_groups (
  id, name, type, items, description, created_time, updated_time, deleted_at
) VALUES
  (601, 'models-primary', 'model', CAST('["gpt-test","gpt-other"]' AS BLOB),
   'primary models', 1710002000, 1710002010, NULL),
  (602, 'retired-endpoints', 'endpoint', CAST('{"old":"https://old.example.test"}' AS BLOB),
   'soft deleted', 1710002100, 1710002110, '2024-03-09 16:10:00+00:00');

INSERT INTO quota_data (
  id, user_id, username, model_name, created_at, token_used, count, quota
) VALUES (701, 1, 'alice', 'gpt-test', 1710000000, 321, 2, 640);

INSERT INTO setups (id, version, initialized_at)
VALUES (801, 'go-vps-legacy', 1700000000);

INSERT INTO perf_metrics (
  id, model_name, "group", bucket_ts, request_count, success_count,
  total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms
) VALUES (901, 'gpt-test', 'default', 1710000000, 2, 2, 850, 220, 2, 321, 700);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, created_at INTEGER, type INTEGER, content TEXT,
  username TEXT, token_name TEXT, model_name TEXT, quota INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, use_time INTEGER,
  is_stream INTEGER, channel_id INTEGER, token_id INTEGER, "group" TEXT,
  ip TEXT, request_id TEXT, upstream_request_id TEXT, other TEXT
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  task_id TEXT, platform TEXT, user_id INTEGER, "group" TEXT,
  channel_id INTEGER, quota INTEGER, action TEXT, status TEXT,
  fail_reason TEXT, progress TEXT, submit_time INTEGER, start_time INTEGER,
  finish_time INTEGER, properties TEXT, private_data TEXT, data TEXT,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, checkin_date TEXT, quota_awarded INTEGER, created_at INTEGER
);

CREATE TABLE redemptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, "key" TEXT, status INTEGER, name TEXT, quota INTEGER,
  created_time INTEGER, redeemed_time INTEGER, used_user_id INTEGER,
  expired_time INTEGER, deleted_at TEXT
);

CREATE TABLE subscription_plans (
  id INTEGER PRIMARY KEY,
  title TEXT, subtitle TEXT, price_amount REAL, currency TEXT,
  duration_unit TEXT, duration_value INTEGER, custom_seconds INTEGER,
  enabled INTEGER, sort_order INTEGER, allow_balance_pay INTEGER,
  stripe_price_id TEXT, creem_product_id TEXT, waffo_pancake_product_id TEXT,
  max_purchase_per_user INTEGER, upgrade_group TEXT, total_amount INTEGER,
  quota_reset_period TEXT, quota_reset_custom_seconds INTEGER,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE subscription_orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, plan_id INTEGER, money REAL, trade_no TEXT,
  payment_method TEXT, payment_provider TEXT, status TEXT,
  create_time INTEGER, complete_time INTEGER, provider_payload TEXT
);

CREATE TABLE user_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, plan_id INTEGER, amount_total INTEGER, amount_used INTEGER,
  start_time INTEGER, end_time INTEGER, status TEXT, source TEXT,
  last_reset_time INTEGER, next_reset_time INTEGER, upgrade_group TEXT,
  prev_user_group TEXT, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE subscription_pre_consume_records (
  id INTEGER PRIMARY KEY,
  request_id TEXT, user_id INTEGER, user_subscription_id INTEGER,
  pre_consumed INTEGER, status TEXT, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE vendors (
  id INTEGER PRIMARY KEY,
  name TEXT, description TEXT, icon TEXT, status INTEGER,
  created_time INTEGER, updated_time INTEGER, deleted_at TEXT
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  model_name TEXT, description TEXT, icon TEXT, tags TEXT, vendor_id INTEGER,
  endpoints TEXT, status INTEGER, sync_official INTEGER,
  created_time INTEGER, updated_time INTEGER, name_rule INTEGER,
  deleted_at TEXT
);

CREATE TABLE custom_oauth_providers (
  id INTEGER PRIMARY KEY,
  name TEXT, slug TEXT, icon TEXT, enabled INTEGER, client_id TEXT,
  client_secret TEXT, authorization_endpoint TEXT, token_endpoint TEXT,
  user_info_endpoint TEXT, scopes TEXT, user_id_field TEXT,
  username_field TEXT, display_name_field TEXT, email_field TEXT,
  well_known TEXT, auth_style INTEGER, access_policy TEXT,
  access_denied_message TEXT, created_at TEXT, updated_at TEXT
);

CREATE TABLE user_oauth_bindings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, provider_id INTEGER, provider_user_id TEXT, created_at TEXT
);

INSERT INTO logs VALUES (
  1001, 1, 1710003000, 2, 'relay complete', 'alice', 'primary', 'gpt-test',
  42, 12, 8, 250, 1, 20, 10, 'default', '203.0.113.5',
  'req-log-1', 'upstream-log-1', '{"trace":{"b":2,"a":1}}'
);

INSERT INTO tasks (
  id, task_id, platform, user_id, "group", channel_id, quota, action, status,
  fail_reason, progress, submit_time, start_time, finish_time, properties,
  private_data, data, created_at, updated_at
) VALUES (
  1101, 'task-source-1', 'suno', 1, 'default', 20, 80, 'music', 'SUCCESS',
  '', '100%', 1710003100, 1710003101, 1710003110,
  '{"input":"song","model":"v3"}', '{"key_ref":"opaque"}',
  '{"clips":[1,2]}', 1710003100, 1710003110
);

INSERT INTO checkins VALUES (1201, 1, '2024-03-10', 100, 1710028800);

INSERT INTO redemptions (
  id, user_id, "key", status, name, quota, created_time, redeemed_time,
  used_user_id, expired_time, deleted_at
) VALUES (
  1301, 1, 'redeem-used-1', 3, 'launch code', 500,
  1710003200, 1710003300, 1, 0, NULL
);

INSERT INTO subscription_plans VALUES (
  1401, 'Pro', 'Monthly plan', 12.5, 'USD', 'month', 1, 0, 1, 10, 1,
  'price_pro', 'creem_pro', 'waffo_pro', 0, 'pro', 100000,
  'monthly', 0, 1710003400, 1710003401
);

INSERT INTO subscription_orders VALUES (
  1501, 1, 1401, 12.5, 'sub-order-1', 'card', 'stripe', 'success',
  1710003500, 1710003510, '{"event":"paid","attempt":1}'
);

INSERT INTO user_subscriptions VALUES (
  1601, 1, 1401, 100000, 500, 1710003510, 1712595510, 'active', 'order',
  1710003510, 1712595510, 'pro', 'default', 1710003510, 1710003510
);

INSERT INTO subscription_pre_consume_records VALUES (
  1701, 'req-sub-1', 1, 1601, 100, 'consumed', 1710003600, 1710003600
);

INSERT INTO vendors VALUES (
  1801, 'OpenAI', 'model vendor', 'OpenAI', 1, 1710003700, 1710003701, NULL
);

INSERT INTO models VALUES (
  1901, 'gpt-test', 'test model', 'OpenAI', 'chat,reasoning', 1801,
  '{"chat":["/v1/chat/completions"],"responses":true}',
  1, 1, 1710003800, 1710003801, 0, NULL
);

INSERT INTO custom_oauth_providers VALUES (
  2001, 'Corporate OIDC', 'corp-oidc', 'KeyRound', 1, 'client-id',
  'client-secret-opaque', 'https://id.example.test/authorize',
  'https://id.example.test/token', 'https://id.example.test/userinfo',
  'openid profile email', 'sub', 'preferred_username', 'name', 'email',
  'https://id.example.test/.well-known/openid-configuration', 2,
  '{"logic":"and","conditions":[]}', 'Access denied',
  '2024-03-09 16:30:00+00:00', '2024-03-09 16:31:00+00:00'
);

INSERT INTO user_oauth_bindings VALUES (
  2101, 1, 2001, 'corp-user-1', '2024-03-09 16:32:00+00:00'
);
