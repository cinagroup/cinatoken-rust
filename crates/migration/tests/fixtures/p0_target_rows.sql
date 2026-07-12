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

INSERT INTO topups (
  id, user_id, amount, money, trade_no, payment_method, payment_provider,
  status, create_time, complete_time, credited
) VALUES
  (101, 1, 1000, 10.0, 'topup-pending', 'alipay', 'epay', 0, 1710000000, 0, 0),
  (102, 1, 2000, 20.0, 'topup-success', 'stripe', 'stripe', 1, 1710000100, 1710000110, 1),
  (103, 1, 3000, 30.0, 'topup-failed', 'creem', 'creem', 2, 1710000200, 1710000210, 0),
  (104, 1, 4000, 40.0, 'topup-expired', 'wxpay', 'epay', 3, 1710000300, 1710000310, 0);
