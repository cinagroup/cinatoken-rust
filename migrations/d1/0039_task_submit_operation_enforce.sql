-- Enforce the v1 task provider-operation deadline after the 0038 expand phase.
--
-- Apply only after all task-submit writers persist submit_deadline_at and the
-- expand-phase readback has no newly created zero-deadline rows. Historical
-- rows keep zero and remain resolvable by the 0032/0033 reconciliation path.

CREATE TRIGGER task_billing_intent_submit_operation_insert_guard
BEFORE INSERT ON task_billing_intents
FOR EACH ROW
WHEN
  length(NEW.client_operation_key_sha256) <> 64 OR
  NEW.client_operation_key_sha256 GLOB '*[^0-9a-f]*' OR
  length(NEW.client_request_sha256) <> 64 OR
  NEW.client_request_sha256 GLOB '*[^0-9a-f]*' OR
  NEW.submit_deadline_at <= NEW.created_at OR
  NEW.submit_deadline_at > NEW.lease_expires_at OR
  NEW.submit_deadline_at - NEW.created_at NOT BETWEEN 5 AND 120
BEGIN
  SELECT RAISE(ABORT, 'task submit operation contract is invalid');
END;

CREATE TRIGGER task_billing_intent_submit_operation_immutable_guard
BEFORE UPDATE OF submit_deadline_at,
                 client_operation_key_sha256,
                 client_request_sha256
ON task_billing_intents
FOR EACH ROW
WHEN
  NEW.submit_deadline_at IS NOT OLD.submit_deadline_at OR
  NEW.client_operation_key_sha256 IS NOT OLD.client_operation_key_sha256 OR
  NEW.client_request_sha256 IS NOT OLD.client_request_sha256
BEGIN
  SELECT RAISE(ABORT, 'task submit operation identity is immutable');
END;
