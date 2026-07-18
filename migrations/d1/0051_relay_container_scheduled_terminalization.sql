-- Record the exact reconciliation lease that won an autonomous Container
-- financial terminalization. The row is inserted in the same D1 batch as the
-- terminal event, outbox, operation, reservation, and quota/stat mutations.

CREATE TABLE relay_container_scheduled_terminalizations (
  billing_event_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(billing_event_id) = 'text'
      AND length(billing_event_id) = 64
      AND billing_event_id NOT GLOB '*[^0-9a-f]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (
      typeof(owner_generation) = 'integer'
      AND owner_generation BETWEEN 1 AND 2147483647
    ),
  operation_from_status TEXT NOT NULL
    CHECK (
      typeof(operation_from_status) = 'text'
      AND operation_from_status IN ('dispatched', 'recovery_required')
    ),
  billing_owner_generation INTEGER NOT NULL
    CHECK (
      typeof(billing_owner_generation) = 'integer'
      AND billing_owner_generation BETWEEN 1 AND 2147483646
    ),
  reconciliation_id TEXT NOT NULL
    CHECK (
      typeof(reconciliation_id) = 'text'
      AND length(reconciliation_id) = 64
      AND reconciliation_id NOT GLOB '*[^0-9a-f]*'
    ),
  reconciliation_revision INTEGER NOT NULL
    CHECK (
      typeof(reconciliation_revision) = 'integer'
      AND reconciliation_revision IN (1, 2)
    ),
  observation_claim_generation INTEGER NOT NULL
    CHECK (
      typeof(observation_claim_generation) = 'integer'
      AND observation_claim_generation BETWEEN 1 AND 2147483647
    ),
  observation_claim_owner TEXT NOT NULL
    CHECK (
      typeof(observation_claim_owner) = 'text'
      AND length(observation_claim_owner) = 32
      AND observation_claim_owner NOT GLOB '*[^0-9a-f]*'
    ),
  observation_claim_lease_expires_at INTEGER NOT NULL
    CHECK (
      typeof(observation_claim_lease_expires_at) = 'integer'
      AND observation_claim_lease_expires_at BETWEEN 1 AND 2147483647
    ),
  decision TEXT NOT NULL DEFAULT 'settle'
    CHECK (typeof(decision) = 'text' AND decision = 'settle'),
  provider_usage_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(provider_usage_receipt_sha256) = 'text'
      AND length(provider_usage_receipt_sha256) = 64
      AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  provider_result_sha256 TEXT NOT NULL
    CHECK (
      typeof(provider_result_sha256) = 'text'
      AND length(provider_result_sha256) = 64
      AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_contract_sha256 TEXT NOT NULL
    CHECK (
      typeof(terminal_contract_sha256) = 'text'
      AND length(terminal_contract_sha256) = 64
      AND terminal_contract_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  committed_at INTEGER NOT NULL
    CHECK (
      typeof(committed_at) = 'integer'
      AND committed_at BETWEEN 1 AND 2147483647
    ),
  created_at INTEGER NOT NULL
    CHECK (
      typeof(created_at) = 'integer'
      AND created_at BETWEEN 1 AND 2147483647
    ),
  CHECK (reservation_key = operation_id),
  CHECK (created_at = committed_at),
  CHECK (
    (operation_from_status = 'dispatched' AND reconciliation_revision = 1)
    OR (
      operation_from_status = 'recovery_required'
      AND reconciliation_revision = 2
    )
  ),
  UNIQUE (operation_id, reconciliation_revision),
  FOREIGN KEY (billing_event_id)
    REFERENCES relay_container_terminal_events(billing_event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_reconciliation_observations(operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (reservation_key)
    REFERENCES relay_container_atomic_admissions(reservation_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_scheduled_terminalizations_committed
  ON relay_container_scheduled_terminalizations(committed_at, operation_id);

CREATE TRIGGER relay_container_scheduled_terminalization_insert_guard
BEFORE INSERT ON relay_container_scheduled_terminalizations
FOR EACH ROW
WHEN
  NOT EXISTS (
    SELECT 1
    FROM relay_container_reconciliation_observations AS observation
    WHERE observation.operation_id = NEW.operation_id
      AND observation.reservation_key = NEW.reservation_key
      AND observation.owner_generation = NEW.owner_generation
      AND observation.reconciliation_id = NEW.reconciliation_id
      AND observation.status = 'leased'
      AND observation.claim_generation = NEW.observation_claim_generation
      AND observation.attempt_count = NEW.observation_claim_generation
      AND observation.claim_owner = NEW.observation_claim_owner
      AND observation.claim_lease_expires_at = NEW.observation_claim_lease_expires_at
      AND observation.updated_at <= NEW.committed_at
      AND observation.claim_lease_expires_at > NEW.committed_at
      AND observation.claim_lease_expires_at > unixepoch()
      AND observation.recovery_deadline_at > NEW.committed_at
      AND observation.recovery_deadline_at > unixepoch()
  )
  OR NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    WHERE event.billing_event_id = NEW.billing_event_id
      AND event.reservation_key = NEW.reservation_key
      AND event.operation_id = NEW.operation_id
      AND event.owner_generation = NEW.owner_generation
      AND event.operation_from_status = NEW.operation_from_status
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND event.billing_owner_generation = NEW.billing_owner_generation
      AND event.reconciliation_id = NEW.reconciliation_id
      AND event.reconciliation_revision = NEW.reconciliation_revision
      AND event.provider_usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
      AND event.provider_result_sha256 = NEW.provider_result_sha256
      AND event.terminal_contract_sha256 = NEW.terminal_contract_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM relay_container_operations AS operation
    WHERE operation.operation_id = NEW.operation_id
      AND operation.reservation_key = NEW.reservation_key
      AND operation.owner_generation = NEW.owner_generation
      AND operation.reconciliation_id = NEW.reconciliation_id
      AND operation.status = 'completed'
  )
  OR NOT EXISTS (
    SELECT 1
    FROM relay_billing_reservations AS reservation
    WHERE reservation.reservation_key = NEW.reservation_key
      AND reservation.status = 'settled'
      AND reservation.owner_generation = NEW.billing_owner_generation + 1
      AND reservation.request_accounted = 1
  )
  OR NOT EXISTS (
    SELECT 1
    FROM relay_container_atomic_admissions AS admission
    WHERE admission.reservation_key = NEW.reservation_key
      AND admission.operation_id = NEW.operation_id
      AND admission.owner_generation = NEW.owner_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container scheduled terminalization fence is invalid');
END;

CREATE TRIGGER relay_container_scheduled_terminalization_immutable_guard
BEFORE UPDATE ON relay_container_scheduled_terminalizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container scheduled terminalization is immutable');
END;

CREATE TRIGGER relay_container_scheduled_terminalization_delete_guard
BEFORE DELETE ON relay_container_scheduled_terminalizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container scheduled terminalization cannot be deleted');
END;
