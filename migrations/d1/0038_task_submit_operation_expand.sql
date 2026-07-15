-- Expand phase for frozen provider-operation identity and bounded task submit.
--
-- Existing Workers do not write submit_deadline_at, so the additive column
-- keeps a zero default during rollout. The operation key is already generated
-- from the unique public task id; making that provider/channel identity unique
-- is compatible with both old and new writers. Enforcement follows in 0039
-- only after every writer persists a valid deadline.

ALTER TABLE task_billing_intents
  ADD COLUMN submit_deadline_at INTEGER NOT NULL DEFAULT 0
    CHECK (submit_deadline_at >= 0);

ALTER TABLE task_billing_intents
  ADD COLUMN client_operation_key_sha256 TEXT NOT NULL DEFAULT '' CHECK (
    client_operation_key_sha256 = '' OR (
      length(client_operation_key_sha256) = 64 AND
      client_operation_key_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE task_billing_intents
  ADD COLUMN client_request_sha256 TEXT NOT NULL DEFAULT '' CHECK (
    client_request_sha256 = '' OR (
      length(client_request_sha256) = 64 AND
      client_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE UNIQUE INDEX idx_task_billing_intents_client_operation
  ON task_billing_intents(
    user_id,
    token_id,
    task_kind,
    client_operation_key_sha256
  )
  WHERE client_operation_key_sha256 <> '';

CREATE UNIQUE INDEX idx_task_billing_intents_provider_operation
  ON task_billing_intents(
    task_kind,
    provider_kind,
    channel_id,
    provider_idempotency_key
  )
  WHERE provider_idempotency_key <> '';

CREATE INDEX idx_task_billing_intents_submit_deadline
  ON task_billing_intents(submit_state, submit_deadline_at, reservation_key)
  WHERE status = 'reserved'
    AND submit_state IN ('prepared', 'submitting', 'rejected');
