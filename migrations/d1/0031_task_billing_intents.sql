-- Durable pre-provider ownership for asynchronous task billing.
--
-- The intent is inserted and quota is reserved before provider I/O. A provider
-- response can then attach the public task exactly once. If the Worker exits
-- before attachment, the scheduled recovery path can refund the owned reserve
-- from this row without guessing from logs or transient Durable Object state.

CREATE TABLE task_billing_intents (
  reservation_key TEXT PRIMARY KEY,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('task', 'midjourney')),
  public_task_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  token_id INTEGER NOT NULL DEFAULT 0 CHECK (token_id >= 0),
  channel_id INTEGER NOT NULL CHECK (channel_id > 0),
  quota INTEGER NOT NULL DEFAULT 0 CHECK (quota >= 0),
  funding_source TEXT NOT NULL DEFAULT 'wallet'
    CHECK (funding_source IN ('wallet', 'subscription')),
  subscription_id INTEGER NOT NULL DEFAULT 0 CHECK (subscription_id >= 0),
  billing_contract_json TEXT NOT NULL CHECK (
    json_valid(billing_contract_json) AND
    length(billing_contract_json) BETWEEN 2 AND 32768
  ),
  billing_contract_sha256 TEXT NOT NULL CHECK (
    length(billing_contract_sha256) = 64 AND
    billing_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (
    status IN ('reserved', 'attached', 'settled', 'refunded', 'recovery_required')
  ),
  submit_state TEXT NOT NULL DEFAULT 'prepared' CHECK (
    submit_state IN ('prepared', 'submitting', 'submitted', 'rejected', 'submit_unknown')
  ),
  provider_kind TEXT NOT NULL DEFAULT '',
  provider_idempotency_key TEXT NOT NULL DEFAULT '',
  provider_task_id TEXT NOT NULL DEFAULT '',
  request_accounted INTEGER NOT NULL DEFAULT 0 CHECK (request_accounted IN (0, 1)),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > 0),
  owner_generation INTEGER NOT NULL DEFAULT 1 CHECK (owner_generation > 0),
  submit_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (submit_attempt_count >= 0),
  recovery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
  recovery_last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  attached_at INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER NOT NULL DEFAULT 0,
  refunded_at INTEGER NOT NULL DEFAULT 0,
  recovery_required_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_task_billing_intents_status_lease
  ON task_billing_intents(status, lease_expires_at, reservation_key);
CREATE INDEX idx_task_billing_intents_user_status
  ON task_billing_intents(user_id, status, updated_at);
CREATE UNIQUE INDEX idx_task_billing_intents_provider_task
  ON task_billing_intents(task_kind, channel_id, provider_task_id)
  WHERE provider_task_id <> '';

-- Financial identity is frozen once the pre-provider reserve exists. Lifecycle
-- and recovery metadata may advance, but repricing or moving the charge to a
-- different account/task is forbidden.
CREATE TRIGGER task_billing_intent_contract_immutable_guard
BEFORE UPDATE ON task_billing_intents
FOR EACH ROW
WHEN
  NEW.reservation_key IS NOT OLD.reservation_key OR
  NEW.task_kind IS NOT OLD.task_kind OR
  NEW.public_task_id IS NOT OLD.public_task_id OR
  NEW.user_id IS NOT OLD.user_id OR
  NEW.token_id IS NOT OLD.token_id OR
  NEW.channel_id IS NOT OLD.channel_id OR
  NEW.quota IS NOT OLD.quota OR
  NEW.funding_source IS NOT OLD.funding_source OR
  NEW.subscription_id IS NOT OLD.subscription_id OR
  NEW.billing_contract_json IS NOT OLD.billing_contract_json OR
  NEW.billing_contract_sha256 IS NOT OLD.billing_contract_sha256 OR
  NEW.provider_kind IS NOT OLD.provider_kind OR
  NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'task billing intent contract is immutable');
END;

CREATE TRIGGER task_billing_intent_insert_guard
BEFORE INSERT ON task_billing_intents
FOR EACH ROW
WHEN
  NEW.status <> 'reserved' OR
  NEW.submit_state <> 'prepared' OR
  NEW.request_accounted <> 0 OR
  NEW.provider_task_id <> '' OR
  (NEW.funding_source = 'wallet' AND NEW.subscription_id <> 0) OR
  (NEW.funding_source = 'subscription' AND NEW.subscription_id <= 0) OR
  NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.user_id
      AND deleted_at IS NULL
      AND (
        NEW.funding_source <> 'wallet' OR
        quota >= NEW.quota
      )
  ) OR
  NOT EXISTS (
    SELECT 1 FROM channels
    WHERE id = NEW.channel_id
  ) OR
  (
    NEW.token_id > 0 AND NOT EXISTS (
      SELECT 1 FROM tokens
      WHERE id = NEW.token_id
        AND user_id = NEW.user_id
        AND deleted_at IS NULL
        AND (unlimited_quota <> 0 OR remain_quota >= NEW.quota)
    )
  ) OR
  (
    NEW.funding_source = 'subscription' AND NOT EXISTS (
      SELECT 1 FROM user_subscriptions
      WHERE id = NEW.subscription_id
        AND user_id = NEW.user_id
        AND status = 'active'
        AND end_time > NEW.created_at
        AND (amount_total <= 0 OR amount_total - amount_used >= NEW.quota)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'task billing intent admission failed');
END;

-- A channel remains part of the frozen provider ownership contract until the
-- intent reaches a financial terminal state. Deleting it earlier would make an
-- accepted provider task impossible to attach or poll safely.
CREATE TRIGGER task_billing_intent_channel_delete_guard
BEFORE DELETE ON channels
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM task_billing_intents
  WHERE channel_id = OLD.id
    AND status IN ('reserved', 'attached', 'recovery_required')
)
BEGIN
  SELECT RAISE(ABORT, 'channel has active task billing intent');
END;

CREATE TRIGGER task_billing_intent_submit_transition_guard
BEFORE UPDATE OF submit_state ON task_billing_intents
FOR EACH ROW
WHEN NOT (
  NEW.submit_state = OLD.submit_state OR
  (OLD.submit_state = 'prepared' AND NEW.submit_state IN ('submitting', 'rejected')) OR
  (OLD.submit_state = 'submitting' AND NEW.submit_state IN ('submitted', 'rejected', 'submit_unknown')) OR
  (OLD.submit_state = 'submit_unknown' AND NEW.submit_state IN ('submitted', 'rejected'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid task billing intent submit transition');
END;

CREATE TRIGGER task_billing_intent_reserve_apply
AFTER INSERT ON task_billing_intents
FOR EACH ROW
BEGIN
  UPDATE users
  SET quota = quota - NEW.quota
  WHERE id = NEW.user_id
    AND NEW.funding_source = 'wallet';

  UPDATE user_subscriptions
  SET amount_used = amount_used + NEW.quota,
      updated_at = NEW.created_at
  WHERE id = NEW.subscription_id
    AND NEW.funding_source = 'subscription';

  UPDATE tokens
  SET remain_quota = remain_quota - NEW.quota,
      used_quota = used_quota + NEW.quota,
      accessed_time = NEW.created_at
  WHERE id = NEW.token_id
    AND NEW.token_id > 0;
END;

-- Lifecycle is monotonic. Recovery can take ownership of an expired reserve,
-- while attached work can only settle or refund once.
CREATE TRIGGER task_billing_intent_status_transition_guard
BEFORE UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN NOT (
  NEW.status = OLD.status OR
  (OLD.status = 'reserved' AND NEW.status IN ('attached', 'refunded', 'recovery_required')) OR
  (OLD.status = 'attached' AND NEW.status IN ('settled', 'refunded', 'recovery_required')) OR
  (OLD.status = 'recovery_required' AND NEW.status IN ('refunded', 'attached'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid task billing intent status transition');
END;

CREATE TRIGGER task_billing_intent_attach_guard
BEFORE UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN NEW.status = 'attached' AND (
  NEW.provider_task_id = '' OR
  NEW.submit_state <> 'submitted' OR
  NEW.request_accounted <> 1 OR
  NEW.attached_at <= 0 OR
  NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id) OR
  NOT EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id)
)
BEGIN
  SELECT RAISE(ABORT, 'attached task billing intent is incomplete');
END;

CREATE TRIGGER task_billing_intent_attach_accounting
AFTER UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN OLD.status <> 'attached' AND NEW.status = 'attached'
BEGIN
  UPDATE users
  SET used_quota = used_quota + NEW.quota,
      request_count = request_count + 1
  WHERE id = NEW.user_id;

  UPDATE channels
  SET used_quota = used_quota + NEW.quota
  WHERE id = NEW.channel_id;
END;

CREATE TRIGGER task_billing_intent_terminal_guard
BEFORE UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN NEW.status = 'settled' AND (
  OLD.status <> 'attached' OR
  NEW.request_accounted <> 1 OR
  NEW.settled_at <= 0
)
BEGIN
  SELECT RAISE(ABORT, 'settled task billing intent is incomplete');
END;

CREATE TRIGGER task_billing_intent_refund_guard
BEFORE UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN NEW.status = 'refunded' AND (
  NEW.refunded_at <= 0 OR
  NOT (
    OLD.status = 'attached' OR
    (OLD.status IN ('reserved', 'recovery_required') AND NEW.submit_state IN ('prepared', 'rejected'))
  ) OR
  NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id) OR
  (
    NEW.token_id > 0 AND NOT EXISTS (
      SELECT 1 FROM tokens
      WHERE id = NEW.token_id AND user_id = NEW.user_id
    )
  ) OR
  (
    NEW.funding_source = 'subscription' AND NOT EXISTS (
      SELECT 1 FROM user_subscriptions
      WHERE id = NEW.subscription_id AND user_id = NEW.user_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'refunded task billing intent is incomplete');
END;

CREATE TRIGGER task_billing_intent_refund_apply
AFTER UPDATE OF status ON task_billing_intents
FOR EACH ROW
WHEN OLD.status <> 'refunded' AND NEW.status = 'refunded'
BEGIN
  UPDATE users
  SET quota = quota + NEW.quota
  WHERE id = NEW.user_id
    AND NEW.funding_source = 'wallet';

  UPDATE user_subscriptions
  SET amount_used = MAX(amount_used - NEW.quota, 0),
      updated_at = NEW.refunded_at
  WHERE id = NEW.subscription_id
    AND NEW.funding_source = 'subscription';

  UPDATE tokens
  SET remain_quota = remain_quota + NEW.quota,
      used_quota = MAX(used_quota - NEW.quota, 0),
      accessed_time = NEW.refunded_at
  WHERE id = NEW.token_id
    AND NEW.token_id > 0;
END;
