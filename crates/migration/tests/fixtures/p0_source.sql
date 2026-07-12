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
