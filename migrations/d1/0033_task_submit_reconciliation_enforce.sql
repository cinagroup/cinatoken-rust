-- Contract phase for Task submit reconciliation.
--
-- Apply only after the 0032 expand migration is live, Task submit traffic is
-- drained, and every Worker writer has been upgraded to persist a frozen attach
-- contract. Once applied, rollback to a 0031-era Worker is intentionally blocked.

DROP TRIGGER task_billing_intent_reconciliation_expand_backfill;
DROP TRIGGER task_billing_intent_insert_guard;

CREATE TRIGGER task_billing_intent_insert_guard
BEFORE INSERT ON task_billing_intents
FOR EACH ROW
WHEN
  NEW.status <> 'reserved' OR
  NEW.submit_state <> 'prepared' OR
  NEW.request_accounted <> 0 OR
  NEW.provider_task_id <> '' OR
  NEW.reconciliation_id <> '' OR
  NEW.reconciliation_revision <> 0 OR
  NEW.reconciliation_resolution <> '' OR
  NOT json_valid(NEW.attach_contract_json) OR
  NEW.attach_contract_json = '{}' OR
  length(NEW.attach_contract_json) NOT BETWEEN 2 AND 65536 OR
  length(NEW.attach_contract_sha256) <> 64 OR
  NEW.attach_contract_sha256 GLOB '*[^0-9a-f]*' OR
  (NEW.funding_source = 'wallet' AND NEW.subscription_id <> 0) OR
  (NEW.funding_source = 'subscription' AND NEW.subscription_id <= 0) OR
  NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW.user_id
      AND deleted_at IS NULL
      AND (NEW.funding_source <> 'wallet' OR quota >= NEW.quota)
  ) OR
  NOT EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id) OR
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
