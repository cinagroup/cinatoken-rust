-- Add a default-off, audited operator re-observation command for the 0043
-- Container reconciliation observer. This migration does not grant provider,
-- operation, billing, Durable Object, or R2 mutation authority.

CREATE TABLE relay_container_reconciliation_retry_events (
  resolution_key TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(resolution_key) = 'text'
      AND length(resolution_key) = 64
      AND resolution_key NOT GLOB '*[^0-9a-f]*'
    ),
  observation_sequence INTEGER NOT NULL
    CHECK (typeof(observation_sequence) = 'integer' AND observation_sequence > 0),
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_created_at INTEGER NOT NULL
    CHECK (typeof(operation_created_at) = 'integer' AND operation_created_at > 0),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation > 0),
  reconciliation_id TEXT NOT NULL
    CHECK (
      typeof(reconciliation_id) = 'text'
      AND (
        reconciliation_id = ''
        OR (
          length(reconciliation_id) = 64
          AND reconciliation_id NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  expected_claim_generation INTEGER NOT NULL
    CHECK (typeof(expected_claim_generation) = 'integer' AND expected_claim_generation > 0),
  expected_attempt_count INTEGER NOT NULL
    CHECK (typeof(expected_attempt_count) = 'integer' AND expected_attempt_count > 0),
  expected_consecutive_failures INTEGER NOT NULL
    CHECK (
      typeof(expected_consecutive_failures) = 'integer'
      AND expected_consecutive_failures BETWEEN 0 AND expected_attempt_count
    ),
  expected_first_observed_at INTEGER NOT NULL
    CHECK (typeof(expected_first_observed_at) = 'integer' AND expected_first_observed_at > 0),
  expected_last_attempt_at INTEGER NOT NULL
    CHECK (typeof(expected_last_attempt_at) = 'integer' AND expected_last_attempt_at > 0),
  expected_last_observed_at INTEGER NOT NULL
    CHECK (typeof(expected_last_observed_at) = 'integer' AND expected_last_observed_at > 0),
  expected_last_class TEXT NOT NULL
    CHECK (
      typeof(expected_last_class) = 'text'
      AND length(expected_last_class) BETWEEN 1 AND 64
      AND expected_last_class NOT GLOB '*[^a-z0-9_:-]*'
    ),
  expected_last_error_code TEXT NOT NULL
    CHECK (
      typeof(expected_last_error_code) = 'text'
      AND length(expected_last_error_code) <= 64
      AND expected_last_error_code NOT GLOB '*[^a-z0-9_:-]*'
    ),
  expected_recovery_deadline_at INTEGER NOT NULL
    CHECK (typeof(expected_recovery_deadline_at) = 'integer' AND expected_recovery_deadline_at > 0),
  expected_dead_lettered_at INTEGER NOT NULL
    CHECK (typeof(expected_dead_lettered_at) = 'integer' AND expected_dead_lettered_at > 0),
  expected_dead_letter_reason TEXT NOT NULL
    CHECK (
      typeof(expected_dead_letter_reason) = 'text'
      AND length(expected_dead_letter_reason) BETWEEN 1 AND 64
      AND expected_dead_letter_reason NOT GLOB '*[^a-z0-9_:-]*'
    ),
  expected_updated_at INTEGER NOT NULL
    CHECK (typeof(expected_updated_at) = 'integer' AND expected_updated_at > 0),
  action TEXT NOT NULL
    CHECK (typeof(action) = 'text' AND action = 'reobserve_container_state'),
  reason TEXT NOT NULL
    CHECK (
      typeof(reason) = 'text'
      AND reason IN (
        'infrastructure_recovered',
        'storage_repaired',
        'controller_reconciled',
        'operator_reinspection_approved'
      )
    ),
  evidence_reference TEXT NOT NULL
    CHECK (
      typeof(evidence_reference) = 'text'
      AND length(evidence_reference) BETWEEN 1 AND 128
      AND evidence_reference NOT GLOB '*[^A-Za-z0-9._:/#@-]*'
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      typeof(evidence_sha256) = 'text'
      AND length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  preview_token TEXT NOT NULL
    CHECK (
      typeof(preview_token) = 'text'
      AND length(preview_token) = 64
      AND preview_token NOT GLOB '*[^0-9a-f]*'
    ),
  idempotency_sha256 TEXT NOT NULL
    CHECK (
      typeof(idempotency_sha256) = 'text'
      AND length(idempotency_sha256) = 64
      AND idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  decision_sha256 TEXT NOT NULL
    CHECK (
      typeof(decision_sha256) = 'text'
      AND length(decision_sha256) = 64
      AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operator_id INTEGER NOT NULL
    CHECK (typeof(operator_id) = 'integer' AND operator_id > 0),
  scheduled_at INTEGER NOT NULL
    CHECK (typeof(scheduled_at) = 'integer' AND scheduled_at > 0),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  CHECK (expected_claim_generation = expected_attempt_count),
  CHECK (expected_first_observed_at <= expected_last_attempt_at),
  CHECK (expected_last_attempt_at <= expected_last_observed_at),
  CHECK (expected_last_observed_at = expected_updated_at),
  CHECK (expected_dead_lettered_at = expected_updated_at),
  CHECK (created_at >= expected_updated_at),
  CHECK (scheduled_at = created_at + 1),
  CHECK (expected_recovery_deadline_at - scheduled_at >= 60),
  UNIQUE (operation_id, expected_claim_generation, expected_dead_lettered_at),
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_reconciliation_retry_events_operation
  ON relay_container_reconciliation_retry_events(
    operation_id,
    created_at DESC,
    resolution_key
  );

CREATE INDEX idx_relay_container_reconciliation_retry_events_operator
  ON relay_container_reconciliation_retry_events(
    operator_id,
    created_at DESC,
    resolution_key
  );

CREATE TRIGGER relay_container_reconciliation_retry_event_update_guard
BEFORE UPDATE ON relay_container_reconciliation_retry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation retry events are immutable');
END;

CREATE TRIGGER relay_container_reconciliation_retry_event_delete_guard
BEFORE DELETE ON relay_container_reconciliation_retry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation retry events are immutable');
END;

CREATE TRIGGER relay_container_reconciliation_retry_event_insert_guard
BEFORE INSERT ON relay_container_reconciliation_retry_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_reconciliation_observations AS observation
  JOIN relay_container_operations AS operation
    ON operation.operation_id = observation.operation_id
  WHERE observation.rowid = NEW.observation_sequence
    AND observation.operation_id = NEW.operation_id
    AND observation.operation_created_at = NEW.operation_created_at
    AND observation.owner_generation = NEW.owner_generation
    AND observation.reconciliation_id = NEW.reconciliation_id
    AND observation.status = 'dead_letter'
    AND observation.claim_generation = NEW.expected_claim_generation
    AND observation.claim_owner = ''
    AND observation.claim_lease_expires_at = 0
    AND observation.available_at = 0
    AND observation.attempt_count = NEW.expected_attempt_count
    AND observation.consecutive_failures = NEW.expected_consecutive_failures
    AND observation.first_observed_at = NEW.expected_first_observed_at
    AND observation.last_attempt_at = NEW.expected_last_attempt_at
    AND observation.last_observed_at = NEW.expected_last_observed_at
    AND observation.last_class = NEW.expected_last_class
    AND observation.last_error_code = NEW.expected_last_error_code
    AND observation.recovery_deadline_at = NEW.expected_recovery_deadline_at
    AND observation.converged_at = 0
    AND observation.dead_lettered_at = NEW.expected_dead_lettered_at
    AND observation.dead_letter_reason = NEW.expected_dead_letter_reason
    AND observation.dead_letter_reason <> 'retry_horizon_exhausted'
    AND observation.dead_letter_reason = observation.last_class
    AND observation.updated_at = NEW.expected_updated_at
    AND observation.recovery_deadline_at - NEW.scheduled_at >= 60
    AND operation.reservation_key = observation.reservation_key
    AND operation.created_at = observation.operation_created_at
    AND operation.owner_generation = observation.owner_generation
    AND operation.reconciliation_id = observation.reconciliation_id
)
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation retry preview is stale');
END;

DROP TRIGGER relay_container_reconciliation_observation_lifecycle_guard;

CREATE TRIGGER relay_container_reconciliation_observation_lifecycle_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN NOT (
  NEW.operation_id IS OLD.operation_id
  AND NEW.reservation_key IS OLD.reservation_key
  AND NEW.operation_created_at IS OLD.operation_created_at
  AND NEW.owner_generation IS OLD.owner_generation
  AND NEW.reconciliation_id IS OLD.reconciliation_id
  AND NEW.recovery_deadline_at IS OLD.recovery_deadline_at
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (
      OLD.status NOT IN ('converged', 'dead_letter')
      AND (
        (
          OLD.status IN ('pending', 'retry')
          AND OLD.available_at <= NEW.updated_at
          AND NEW.status = 'leased'
          AND NEW.claim_generation = OLD.claim_generation + 1
          AND length(NEW.claim_owner) = 32
          AND NEW.claim_lease_expires_at > NEW.updated_at
          AND NEW.available_at = 0
          AND NEW.attempt_count = OLD.attempt_count + 1
          AND NEW.consecutive_failures = OLD.consecutive_failures
          AND NEW.first_observed_at = CASE
            WHEN OLD.first_observed_at = 0 THEN NEW.updated_at
            ELSE OLD.first_observed_at
          END
          AND NEW.last_attempt_at = NEW.updated_at
          AND NEW.last_observed_at = OLD.last_observed_at
          AND NEW.last_class = OLD.last_class
          AND NEW.last_error_code = OLD.last_error_code
          AND NEW.converged_at = OLD.converged_at
          AND NEW.dead_lettered_at = OLD.dead_lettered_at
          AND NEW.dead_letter_reason = OLD.dead_letter_reason
        )
        OR (
          OLD.status = 'leased'
          AND NEW.status = 'leased'
          AND OLD.claim_lease_expires_at <= NEW.updated_at
          AND NEW.claim_generation = OLD.claim_generation + 1
          AND length(NEW.claim_owner) = 32
          AND NEW.claim_lease_expires_at > NEW.updated_at
          AND NEW.available_at = 0
          AND NEW.attempt_count = OLD.attempt_count + 1
          AND NEW.consecutive_failures = OLD.consecutive_failures
          AND NEW.first_observed_at = OLD.first_observed_at
          AND NEW.last_attempt_at = NEW.updated_at
          AND NEW.last_observed_at = OLD.last_observed_at
          AND NEW.last_class = OLD.last_class
          AND NEW.last_error_code = OLD.last_error_code
          AND NEW.converged_at = OLD.converged_at
          AND NEW.dead_lettered_at = OLD.dead_lettered_at
          AND NEW.dead_letter_reason = OLD.dead_letter_reason
        )
        OR (
          OLD.status = 'leased'
          AND OLD.claim_lease_expires_at > NEW.updated_at
          AND NEW.status = 'retry'
          AND NEW.claim_generation = OLD.claim_generation
          AND NEW.claim_owner = ''
          AND NEW.claim_lease_expires_at = 0
          AND NEW.available_at > NEW.updated_at
          AND NEW.attempt_count = OLD.attempt_count
          AND (
            NEW.consecutive_failures = 0
            OR NEW.consecutive_failures = OLD.consecutive_failures + 1
          )
          AND NEW.first_observed_at = OLD.first_observed_at
          AND NEW.last_attempt_at = OLD.last_attempt_at
          AND NEW.last_observed_at = NEW.updated_at
          AND length(NEW.last_class) > 0
          AND NEW.converged_at = OLD.converged_at
          AND NEW.dead_lettered_at = OLD.dead_lettered_at
          AND NEW.dead_letter_reason = OLD.dead_letter_reason
        )
        OR (
          OLD.status = 'leased'
          AND OLD.claim_lease_expires_at > NEW.updated_at
          AND NEW.status = 'converged'
          AND NEW.claim_generation = OLD.claim_generation
          AND NEW.claim_owner = ''
          AND NEW.claim_lease_expires_at = 0
          AND NEW.available_at = 0
          AND NEW.attempt_count = OLD.attempt_count
          AND NEW.consecutive_failures = 0
          AND NEW.first_observed_at = OLD.first_observed_at
          AND NEW.last_attempt_at = OLD.last_attempt_at
          AND NEW.last_observed_at = NEW.updated_at
          AND length(NEW.last_class) > 0
          AND NEW.last_error_code = ''
          AND NEW.converged_at = NEW.updated_at
          AND NEW.dead_lettered_at = OLD.dead_lettered_at
          AND NEW.dead_letter_reason = OLD.dead_letter_reason
        )
        OR (
          OLD.status = 'leased'
          AND OLD.claim_lease_expires_at > NEW.updated_at
          AND NEW.status = 'dead_letter'
          AND NEW.claim_generation = OLD.claim_generation
          AND NEW.claim_owner = ''
          AND NEW.claim_lease_expires_at = 0
          AND NEW.available_at = 0
          AND NEW.attempt_count = OLD.attempt_count
          AND NEW.consecutive_failures = OLD.consecutive_failures
          AND NEW.first_observed_at = OLD.first_observed_at
          AND NEW.last_attempt_at = OLD.last_attempt_at
          AND NEW.last_observed_at = NEW.updated_at
          AND length(NEW.last_class) > 0
          AND NEW.converged_at = OLD.converged_at
          AND NEW.dead_lettered_at = NEW.updated_at
          AND length(NEW.dead_letter_reason) > 0
        )
      )
    )
    OR (
      OLD.status = 'dead_letter'
      AND OLD.dead_letter_reason <> 'retry_horizon_exhausted'
      AND NEW.status = 'retry'
      AND NEW.claim_generation = OLD.claim_generation
      AND NEW.claim_owner = ''
      AND NEW.claim_lease_expires_at = 0
      AND NEW.available_at = NEW.updated_at + 1
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.consecutive_failures = 0
      AND NEW.first_observed_at = OLD.first_observed_at
      AND NEW.last_attempt_at = OLD.last_attempt_at
      AND NEW.last_observed_at = NEW.updated_at
      AND NEW.last_class = OLD.last_class
      AND NEW.last_error_code = ''
      AND NEW.converged_at = 0
      AND NEW.dead_lettered_at = 0
      AND NEW.dead_letter_reason = ''
      AND OLD.recovery_deadline_at - NEW.available_at >= 60
      AND EXISTS (
        SELECT 1
        FROM relay_container_reconciliation_retry_events AS event
        WHERE event.observation_sequence = OLD.rowid
          AND event.operation_id = OLD.operation_id
          AND event.operation_created_at = OLD.operation_created_at
          AND event.owner_generation = OLD.owner_generation
          AND event.reconciliation_id = OLD.reconciliation_id
          AND event.expected_claim_generation = OLD.claim_generation
          AND event.expected_attempt_count = OLD.attempt_count
          AND event.expected_consecutive_failures = OLD.consecutive_failures
          AND event.expected_first_observed_at = OLD.first_observed_at
          AND event.expected_last_attempt_at = OLD.last_attempt_at
          AND event.expected_last_observed_at = OLD.last_observed_at
          AND event.expected_last_class = OLD.last_class
          AND event.expected_last_error_code = OLD.last_error_code
          AND event.expected_recovery_deadline_at = OLD.recovery_deadline_at
          AND event.expected_dead_lettered_at = OLD.dead_lettered_at
          AND event.expected_dead_letter_reason = OLD.dead_letter_reason
          AND event.expected_updated_at = OLD.updated_at
          AND event.created_at = NEW.updated_at
          AND event.scheduled_at = NEW.available_at
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation observation transition is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_retry_event_apply
AFTER INSERT ON relay_container_reconciliation_retry_events
FOR EACH ROW
BEGIN
  UPDATE relay_container_reconciliation_observations
  SET status = 'retry',
      claim_owner = '',
      claim_lease_expires_at = 0,
      available_at = NEW.scheduled_at,
      consecutive_failures = 0,
      last_observed_at = NEW.created_at,
      last_error_code = '',
      dead_lettered_at = 0,
      dead_letter_reason = '',
      updated_at = NEW.created_at
  WHERE rowid = NEW.observation_sequence
    AND operation_id = NEW.operation_id
    AND operation_created_at = NEW.operation_created_at
    AND owner_generation = NEW.owner_generation
    AND reconciliation_id = NEW.reconciliation_id
    AND status = 'dead_letter'
    AND claim_generation = NEW.expected_claim_generation
    AND attempt_count = NEW.expected_attempt_count
    AND consecutive_failures = NEW.expected_consecutive_failures
    AND first_observed_at = NEW.expected_first_observed_at
    AND last_attempt_at = NEW.expected_last_attempt_at
    AND last_observed_at = NEW.expected_last_observed_at
    AND last_class = NEW.expected_last_class
    AND last_error_code = NEW.expected_last_error_code
    AND recovery_deadline_at = NEW.expected_recovery_deadline_at
    AND dead_lettered_at = NEW.expected_dead_lettered_at
    AND dead_letter_reason = NEW.expected_dead_letter_reason
    AND updated_at = NEW.expected_updated_at;

  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'relay container reconciliation retry apply lost its fence')
  END;
END;
