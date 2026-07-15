-- Operator reconciliation for provider submits whose outcome is ambiguous.
--
-- Future task intents freeze the local attachment contract before provider I/O.
-- Existing submit_unknown rows remain refundable with evidence, but deliberately
-- cannot be attached because migration 0031 did not retain that contract.

ALTER TABLE task_billing_intents
  ADD COLUMN attach_contract_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE task_billing_intents
  ADD COLUMN attach_contract_sha256 TEXT NOT NULL DEFAULT
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_id TEXT NOT NULL DEFAULT '';

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_resolution TEXT NOT NULL DEFAULT ''
    CHECK (reconciliation_resolution IN ('', 'attached', 'refunded'));

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_resolution_key TEXT NOT NULL DEFAULT '';

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_resolved_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_operator_id INTEGER NOT NULL DEFAULT 0;

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_evidence_sha256 TEXT NOT NULL DEFAULT '';

ALTER TABLE task_billing_intents
  ADD COLUMN reconciliation_reason TEXT NOT NULL DEFAULT '';

-- Backfill a stable queue identity for rows quarantined before this migration.
-- Their attach contract remains `{}`, so the runtime only offers evidence-based
-- refund; it never fabricates a task row from incomplete historical data.
UPDATE task_billing_intents
SET reconciliation_id = lower(hex(randomblob(32))),
    reconciliation_revision = 1
WHERE status = 'recovery_required'
  AND submit_state = 'submit_unknown'
  AND reconciliation_id = '';

CREATE UNIQUE INDEX idx_task_billing_intent_reconciliation_id
  ON task_billing_intents(reconciliation_id)
  WHERE reconciliation_id <> '';

CREATE UNIQUE INDEX idx_task_billing_intent_reconciliation_resolution_key
  ON task_billing_intents(reconciliation_resolution_key)
  WHERE reconciliation_resolution_key <> '';

CREATE INDEX idx_task_billing_intent_reconciliation_queue
  ON task_billing_intents(recovery_required_at, reconciliation_id)
  WHERE status = 'recovery_required'
    AND submit_state = 'submit_unknown'
    AND reconciliation_resolution = '';

CREATE TABLE task_billing_reconciliation_events (
  resolution_key TEXT PRIMARY KEY CHECK (
    length(resolution_key) = 64 AND resolution_key NOT GLOB '*[^0-9a-f]*'
  ),
  reconciliation_id TEXT NOT NULL,
  reservation_key TEXT NOT NULL,
  reconciliation_revision INTEGER NOT NULL CHECK (reconciliation_revision > 0),
  action TEXT NOT NULL CHECK (action IN ('attach', 'refund')),
  reason TEXT NOT NULL,
  provider_task_id TEXT NOT NULL DEFAULT '',
  evidence_reference TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK (
    length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  preview_token TEXT NOT NULL CHECK (
    length(preview_token) = 64 AND preview_token NOT GLOB '*[^0-9a-f]*'
  ),
  decision_sha256 TEXT NOT NULL CHECK (
    length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operator_id INTEGER NOT NULL CHECK (operator_id > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  FOREIGN KEY (reservation_key) REFERENCES task_billing_intents(reservation_key)
);

CREATE UNIQUE INDEX idx_task_billing_reconciliation_event_identity
  ON task_billing_reconciliation_events(reconciliation_id);

CREATE TRIGGER task_billing_reconciliation_event_update_guard
BEFORE UPDATE ON task_billing_reconciliation_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task billing reconciliation event is immutable');
END;

CREATE TRIGGER task_billing_reconciliation_event_delete_guard
BEFORE DELETE ON task_billing_reconciliation_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task billing reconciliation event is immutable');
END;

DROP TRIGGER task_billing_intent_contract_immutable_guard;
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
  NEW.attach_contract_json IS NOT OLD.attach_contract_json OR
  NEW.attach_contract_sha256 IS NOT OLD.attach_contract_sha256 OR
  NEW.provider_kind IS NOT OLD.provider_kind OR
  NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'task billing intent contract is immutable');
END;

-- Reconciliation metadata may be initialized only while quarantining an
-- ambiguous submit, then advanced exactly once alongside an immutable event.
CREATE TRIGGER task_billing_intent_reconciliation_guard
BEFORE UPDATE ON task_billing_intents
FOR EACH ROW
WHEN NOT (
  (
    NEW.reconciliation_id IS OLD.reconciliation_id AND
    NEW.reconciliation_revision IS OLD.reconciliation_revision AND
    NEW.reconciliation_resolution IS OLD.reconciliation_resolution AND
    NEW.reconciliation_resolution_key IS OLD.reconciliation_resolution_key AND
    NEW.reconciliation_resolved_at IS OLD.reconciliation_resolved_at AND
    NEW.reconciliation_operator_id IS OLD.reconciliation_operator_id AND
    NEW.reconciliation_evidence_sha256 IS OLD.reconciliation_evidence_sha256 AND
    NEW.reconciliation_reason IS OLD.reconciliation_reason AND
    NOT (
      OLD.status = 'recovery_required' AND
      OLD.submit_state = 'submit_unknown' AND
      OLD.reconciliation_resolution = '' AND
      (NEW.status IS NOT OLD.status OR NEW.submit_state IS NOT OLD.submit_state)
    )
  ) OR (
    OLD.reconciliation_id = '' AND
    OLD.reconciliation_revision = 0 AND
    OLD.reconciliation_resolution = '' AND
    length(NEW.reconciliation_id) = 64 AND
    NEW.reconciliation_id NOT GLOB '*[^0-9a-f]*' AND
    NEW.reconciliation_revision = 1 AND
    NEW.reconciliation_resolution = '' AND
    NEW.reconciliation_resolution_key = '' AND
    NEW.reconciliation_resolved_at = 0 AND
    NEW.reconciliation_operator_id = 0 AND
    NEW.reconciliation_evidence_sha256 = '' AND
    NEW.reconciliation_reason = '' AND
    NEW.status = 'recovery_required' AND
    NEW.submit_state = 'submit_unknown'
  ) OR (
    OLD.reconciliation_id <> '' AND
    NEW.reconciliation_id = OLD.reconciliation_id AND
    OLD.reconciliation_revision > 0 AND
    NEW.reconciliation_revision = OLD.reconciliation_revision + 1 AND
    OLD.reconciliation_resolution = '' AND
    NEW.reconciliation_resolution IN ('attached', 'refunded') AND
    length(NEW.reconciliation_resolution_key) = 64 AND
    NEW.reconciliation_resolution_key NOT GLOB '*[^0-9a-f]*' AND
    NEW.reconciliation_resolved_at > 0 AND
    NEW.reconciliation_operator_id > 0 AND
    length(NEW.reconciliation_evidence_sha256) = 64 AND
    NEW.reconciliation_evidence_sha256 NOT GLOB '*[^0-9a-f]*' AND
    NEW.reconciliation_reason <> '' AND
    EXISTS (
      SELECT 1 FROM task_billing_reconciliation_events event
      WHERE event.resolution_key = NEW.reconciliation_resolution_key
        AND event.reconciliation_id = OLD.reconciliation_id
        AND event.reservation_key = OLD.reservation_key
        AND event.reconciliation_revision = OLD.reconciliation_revision
        AND event.action = CASE NEW.reconciliation_resolution
          WHEN 'attached' THEN 'attach' ELSE 'refund' END
        AND event.reason = NEW.reconciliation_reason
        AND event.provider_task_id = NEW.provider_task_id
        AND event.evidence_sha256 = NEW.reconciliation_evidence_sha256
        AND event.operator_id = NEW.reconciliation_operator_id
        AND event.created_at = NEW.reconciliation_resolved_at
    ) AND (
      (NEW.reconciliation_resolution = 'attached' AND
       NEW.status = 'attached' AND NEW.submit_state = 'submitted') OR
      (NEW.reconciliation_resolution = 'refunded' AND
       NEW.status = 'refunded' AND NEW.submit_state = 'rejected')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid task billing reconciliation transition');
END;

-- Expand-phase compatibility for a 0031 Worker that enters submit_unknown
-- after 0032 has been applied. The contract migration removes this trigger
-- only after every writer persists reconciliation metadata itself.
CREATE TRIGGER task_billing_intent_reconciliation_expand_backfill
AFTER UPDATE OF status, submit_state ON task_billing_intents
FOR EACH ROW
WHEN NEW.status = 'recovery_required'
  AND NEW.submit_state = 'submit_unknown'
  AND NEW.reconciliation_id = ''
  AND NEW.reconciliation_revision = 0
BEGIN
  UPDATE task_billing_intents
  SET reconciliation_id = lower(hex(randomblob(32))),
      reconciliation_revision = 1
  WHERE reservation_key = NEW.reservation_key
    AND reconciliation_id = ''
    AND reconciliation_revision = 0;
END;
