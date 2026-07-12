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

INSERT INTO passkey_credentials (
  id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count,
  clone_warning, user_present, user_verified, backup_eligible, backup_state,
  transports, attachment, last_used_at, created_at, updated_at, deleted_at
) VALUES (
  201, 1, 'cred-{"a":1}', 'pk\raw''quote', 'none', 'aaguid-base64==', 42,
  0, 1, 1, 1, 0, '["internal","hybrid"]', 'platform',
  1710000000, 1710000000, 1710000010, NULL
);

INSERT INTO two_fa (
  id, user_id, secret, is_enabled, failed_attempts, locked_until, last_used_at,
  created_at, updated_at
) VALUES (
  301, 1, 'JBSWY3DPEHPK3PXP', 1, 2, 1710000060, 1710000020,
  1710000000, 1710000020
);

INSERT INTO two_fa_backup_codes (
  id, user_id, code_hash, is_used, used_at, created_at
) VALUES
  (401, 1, '$2a$10$opaque/hash''one', 0, NULL, 1710000000),
  (402, 1, '$2a$10$opaque/hash-two', 1, 1710000030, 1710000000);
