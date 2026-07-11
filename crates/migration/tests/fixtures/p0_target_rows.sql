INSERT INTO users (
  id, username, password, display_name, status, "group", aff_code, quota, setting
) VALUES (
  1, 'alice', 'bcrypt-hash', 'Alice', 1, 'default', 'aff-alice', 5000,
  '{"limits":{"a":1,"b":2},"theme":"dark"}'
);

INSERT INTO tokens (
  id, user_id, "key", status, name, remain_quota, model_limits, "group"
) VALUES (
  10, 1, 'source-token-secret', 1, 'primary', 4000, 'gpt-test', 'default'
);

INSERT INTO channels (
  id, type, "key", status, name, models, "group", channel_info, settings
) VALUES (
  20, 1, 'source-channel-secret', 1, 'openai-compatible', 'gpt-test',
  'default', '{"is_multi_key":false,"multi_key_size":1}', '{}'
);

INSERT INTO abilities (
  id, group_name, model, channel_id, enabled, priority, weight, tag
) VALUES (
  77, 'default', 'gpt-test', 20, 1, 5, 100, 'primary'
);

INSERT INTO options (id, "key", value) VALUES
  (89, 'SystemName', 'CinaToken'),
  (88, 'ModelRatio', '{"gpt-other":2,"gpt-test":1}');
