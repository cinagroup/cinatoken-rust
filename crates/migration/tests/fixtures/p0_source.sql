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
