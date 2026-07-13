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
  (601, 'models-primary', 'model', '["gpt-test","gpt-other"]',
   'primary models', 1710002000, 1710002010, NULL),
  (602, 'retired-endpoints', 'endpoint', '{"old":"https://old.example.test"}',
   'soft deleted', 1710002100, 1710002110, 1710000600);

INSERT INTO logs (
  id, user_id, created_at, type, content, username, token_name, model_name,
  quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id,
  token_id, "group", ip, request_id, upstream_request_id, other
) VALUES (
  1001, 1, 1710003000, 2, 'relay complete', 'alice', 'primary', 'gpt-test',
  42, 12, 8, 250, 1, 20, 10, 'default', '203.0.113.5',
  'req-log-1', 'upstream-log-1', '{"trace":{"a":1,"b":2}}'
);

INSERT INTO tasks (
  id, task_id, upstream_task_id, platform, user_id, username, "group",
  channel_id, quota, action, status, fail_reason, progress, submit_time,
  start_time, finish_time, properties, private_data, data, created_at, updated_at
) VALUES (
  1101, 'task-source-1', '', 'suno', 1, '', 'default', 20, 80, 'music',
  'SUCCESS', '', '100%', 1710003100, 1710003101, 1710003110,
  '{"model":"v3","input":"song"}', '{"key_ref":"opaque"}',
  '{"clips":[1,2]}', 1710003100, 1710003110
);

INSERT INTO checkins (
  id, user_id, checkin_date, quota_awarded, created_at
) VALUES (1201, 1, '2024-03-10', 100, 1710028800);

INSERT INTO redemptions (
  id, user_id, "key", status, name, quota, created_time, redeemed_time,
  used_user_id, expired_time, deleted_at, credited
) VALUES (
  1301, 1, 'redeem-used-1', 3, 'launch code', 500,
  1710003200, 1710003300, 1, 0, NULL, 1
);

INSERT INTO subscription_plans (
  id, title, subtitle, price_amount, currency, duration_unit, duration_value,
  custom_seconds, enabled, sort_order, allow_balance_pay, stripe_price_id,
  creem_product_id, waffo_pancake_product_id, max_purchase_per_user,
  upgrade_group, total_amount, quota_reset_period, quota_reset_custom_seconds,
  created_at, updated_at
) VALUES (
  1401, 'Pro', 'Monthly plan', 12.5, 'USD', 'month', 1, 0, 1, 10, 1,
  'price_pro', 'creem_pro', 'waffo_pro', 0, 'pro', 100000,
  'monthly', 0, 1710003400, 1710003401
);

INSERT INTO subscription_orders (
  id, user_id, provider, order_no, plan_id, status, amount, currency,
  created_at, updated_at, money, trade_no, payment_method, payment_provider,
  create_time, complete_time, provider_payload
) VALUES (
  1501, 1, 'stripe', 'sub-order-1', 1401, 'success', '12.5', '',
  1710003500, 1710003510, 12.5, 'sub-order-1', 'card', 'stripe',
  1710003500, 1710003510, '{"event":"paid","attempt":1}'
);

INSERT INTO user_subscriptions (
  id, user_id, plan_id, amount_total, amount_used, start_time, end_time,
  status, source, last_reset_time, next_reset_time, upgrade_group,
  prev_user_group, created_at, updated_at
) VALUES (
  1601, 1, 1401, 100000, 500, 1710003510, 1712595510, 'active', 'order',
  1710003510, 1712595510, 'pro', 'default', 1710003510, 1710003510
);

INSERT INTO subscription_pre_consume_records (
  id, request_id, user_id, user_subscription_id, pre_consumed, status,
  created_at, updated_at
) VALUES (
  1701, 'req-sub-1', 1, 1601, 100, 'consumed', 1710003600, 1710003600
);

INSERT INTO vendors (
  id, name, description, icon, status, created_time, updated_time, deleted_at
) VALUES (
  1801, 'OpenAI', 'model vendor', 'OpenAI', 1, 1710003700, 1710003701, NULL
);

INSERT INTO models (
  id, model_name, description, icon, tags, vendor_id, endpoints, status,
  sync_official, created_time, updated_time, name_rule, deleted_at
) VALUES (
  1901, 'gpt-test', 'test model', 'OpenAI', 'chat,reasoning', 1801,
  '{"responses":true,"chat":["/v1/chat/completions"]}',
  1, 1, 1710003800, 1710003801, 0, NULL
);

INSERT INTO custom_oauth_providers (
  id, name, slug, icon, enabled, client_id, client_secret,
  authorization_endpoint, token_endpoint, user_info_endpoint, scopes,
  user_id_field, username_field, display_name_field, email_field, well_known,
  auth_style, access_policy, access_denied_message, created_at, updated_at
) VALUES (
  2001, 'Corporate OIDC', 'corp-oidc', 'KeyRound', 1, 'client-id',
  'client-secret-opaque', 'https://id.example.test/authorize',
  'https://id.example.test/token', 'https://id.example.test/userinfo',
  'openid profile email', 'sub', 'preferred_username', 'name', 'email',
  'https://id.example.test/.well-known/openid-configuration', 2,
  '{"conditions":[],"logic":"and"}', 'Access denied',
  '2024-03-09 16:30:00+00:00', '2024-03-09 16:31:00+00:00'
);

INSERT INTO user_oauth_bindings (
  id, user_id, provider_id, provider_user_id, created_at
) VALUES (
  2101, 1, 2001, 'corp-user-1', '2024-03-09 16:32:00+00:00'
);
