-- Enforce the v1 Container financial-terminal contract after the 0042
-- expand phase. Apply only after every 0042-compatible writer is deployed,
-- no protocol-v1 operation remains open, no active legacy-identity operation
-- remains, and independently attested old-writer drain evidence has stayed
-- clean for the required observation window.
--
-- This migration is trigger-only. Historical legacy or eventless terminal
-- rows remain readable and are not rewritten or backfilled.

CREATE TRIGGER relay_container_operation_v1_identity_insert_guard
BEFORE INSERT ON relay_container_operations
FOR EACH ROW
WHEN
  NEW.protocol_version = 1
  AND (
    typeof(NEW.client_idempotency_hmac_sha256) <> 'text'
    OR length(NEW.client_idempotency_hmac_sha256) <> 64
    OR NEW.client_idempotency_hmac_sha256 GLOB '*[^0-9a-f]*'
    OR typeof(NEW.client_request_sha256) <> 'text'
    OR length(NEW.client_request_sha256) <> 64
    OR NEW.client_request_sha256 GLOB '*[^0-9a-f]*'
    OR typeof(NEW.reconciliation_id) <> 'text'
    OR length(NEW.reconciliation_id) <> 64
    OR NEW.reconciliation_id GLOB '*[^0-9a-f]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container v1 operation identity is required');
END;

CREATE TRIGGER relay_container_operation_v1_initial_state_insert_guard
BEFORE INSERT ON relay_container_operations
FOR EACH ROW
WHEN NEW.protocol_version = 1 AND NEW.status <> 'prepared'
BEGIN
  SELECT RAISE(ABORT, 'relay container v1 operation must start prepared');
END;

CREATE TRIGGER relay_container_operation_terminal_event_guard
BEFORE UPDATE OF status ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.protocol_version = 1
  AND NEW.status IS NOT OLD.status
  AND NEW.status IN ('completed', 'failed', 'recovery_required')
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_terminal_outbox_state AS outbox
      ON outbox.billing_event_id = event.billing_event_id
    WHERE event.reservation_key = OLD.reservation_key
      AND event.operation_id = OLD.operation_id
      AND event.owner_generation = OLD.owner_generation
      AND event.operation_from_status = OLD.status
      AND event.operation_status = NEW.status
      AND event.reconciliation_id = OLD.reconciliation_id
      AND event.reconciliation_revision = CASE
        WHEN OLD.status = 'recovery_required' THEN 2
        ELSE 1
      END
      AND event.created_at <= NEW.updated_at
      AND outbox.created_at = event.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal transition requires event and outbox');
END;

CREATE TRIGGER relay_container_terminal_event_revision_predecessor_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN
  NEW.reconciliation_revision = 2
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS predecessor
    WHERE predecessor.reservation_key = NEW.reservation_key
      AND predecessor.operation_id = NEW.operation_id
      AND predecessor.owner_generation = NEW.owner_generation
      AND predecessor.operation_from_status IN ('prepared', 'dispatched')
      AND predecessor.operation_status = 'recovery_required'
      AND predecessor.billing_action = 'recovery_required'
      AND predecessor.billing_owner_generation = predecessor.owner_generation
      AND predecessor.billing_from_status = 'reserved'
      AND predecessor.reconciliation_id = NEW.reconciliation_id
      AND predecessor.reconciliation_revision = 1
      AND predecessor.billing_owner_generation + 1 = NEW.billing_owner_generation
      AND predecessor.created_at <= NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container revision 2 predecessor is missing');
END;
