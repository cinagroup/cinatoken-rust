-- Add the default-off durable observer queue for Container reconciliation.
-- This is an expand-only migration: it seeds only the singleton scan cursor
-- and does not synthesize observations for existing operations.

CREATE TABLE relay_container_reconciliation_observations (
  operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  reservation_key TEXT NOT NULL UNIQUE
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_created_at INTEGER NOT NULL
    CHECK (
      typeof(operation_created_at) = 'integer'
      AND operation_created_at BETWEEN 1 AND 2147483647
    ),
  owner_generation INTEGER NOT NULL
    CHECK (
      typeof(owner_generation) = 'integer'
      AND owner_generation BETWEEN 1 AND 2147483647
    ),
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
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      typeof(status) = 'text'
      AND status IN ('pending', 'leased', 'retry', 'converged', 'dead_letter')
    ),
  claim_generation INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(claim_generation) = 'integer'
      AND claim_generation BETWEEN 0 AND 2147483647
    ),
  claim_owner TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(claim_owner) = 'text'
      AND (
        claim_owner = ''
        OR (
          length(claim_owner) = 32
          AND claim_owner NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  claim_lease_expires_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(claim_lease_expires_at) = 'integer'
      AND claim_lease_expires_at BETWEEN 0 AND 2147483647
    ),
  available_at INTEGER NOT NULL
    CHECK (
      typeof(available_at) = 'integer'
      AND available_at BETWEEN 0 AND 2147483647
    ),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(attempt_count) = 'integer'
      AND attempt_count BETWEEN 0 AND 2147483647
    ),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(consecutive_failures) = 'integer'
      AND consecutive_failures BETWEEN 0 AND 2147483647
    ),
  first_observed_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(first_observed_at) = 'integer'
      AND first_observed_at BETWEEN 0 AND 2147483647
    ),
  last_attempt_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(last_attempt_at) = 'integer'
      AND last_attempt_at BETWEEN 0 AND 2147483647
    ),
  last_observed_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(last_observed_at) = 'integer'
      AND last_observed_at BETWEEN 0 AND 2147483647
    ),
  last_class TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(last_class) = 'text'
      AND last_class IN (
        '',
        'converged_replayable',
        'prepared_do_absent',
        'dispatched_do_absent',
        'pending_do_claimed',
        'pending_do_running',
        'd1_lagging_dispatch',
        'd1_lagging_terminal',
        'recovery_do_absent',
        'recovery_pending',
        'recovery_resolvable',
        'terminal_do_absent',
        'terminal_conflict',
        'terminal_response_missing',
        'terminal_response_divergent',
        'response_r2_orphan',
        'legacy_terminal_without_receipt',
        'store_unavailable',
        'contract_violation'
      )
    ),
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(last_error_code) = 'text'
      AND length(last_error_code) <= 64
      AND last_error_code NOT GLOB '*[^a-z0-9_:-]*'
    ),
  recovery_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(recovery_deadline_at) = 'integer'
      AND recovery_deadline_at BETWEEN 1 AND 2147483647
    ),
  converged_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(converged_at) = 'integer'
      AND converged_at BETWEEN 0 AND 2147483647
    ),
  dead_lettered_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(dead_lettered_at) = 'integer'
      AND dead_lettered_at BETWEEN 0 AND 2147483647
    ),
  dead_letter_reason TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(dead_letter_reason) = 'text'
      AND length(dead_letter_reason) <= 64
      AND dead_letter_reason NOT GLOB '*[^a-z0-9_:-]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 2147483647),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 1 AND 2147483647),
  CHECK (operation_id = reservation_key),
  CHECK (claim_generation = attempt_count),
  CHECK (consecutive_failures <= attempt_count),
  CHECK (operation_created_at <= created_at),
  CHECK (created_at <= updated_at),
  CHECK (recovery_deadline_at > created_at),
  CHECK (
    first_observed_at = 0
    OR first_observed_at BETWEEN created_at AND updated_at
  ),
  CHECK (
    last_attempt_at = 0
    OR (
      first_observed_at > 0
      AND last_attempt_at BETWEEN first_observed_at AND updated_at
    )
  ),
  CHECK (
    last_observed_at = 0
    OR (
      first_observed_at > 0
      AND last_observed_at BETWEEN first_observed_at AND updated_at
    )
  ),
  CHECK (
    (
      status = 'pending'
      AND claim_generation = 0
      AND claim_owner = ''
      AND claim_lease_expires_at = 0
      AND available_at = created_at
      AND attempt_count = 0
      AND consecutive_failures = 0
      AND first_observed_at = 0
      AND last_attempt_at = 0
      AND last_observed_at = 0
      AND last_class = ''
      AND last_error_code = ''
      AND converged_at = 0
      AND dead_lettered_at = 0
      AND dead_letter_reason = ''
    )
    OR (
      status = 'leased'
      AND claim_generation > 0
      AND length(claim_owner) = 32
      AND claim_lease_expires_at > updated_at
      AND available_at = 0
      AND attempt_count > 0
      AND first_observed_at > 0
      AND last_attempt_at = updated_at
      AND last_observed_at <= last_attempt_at
      AND (last_class <> '' OR last_error_code = '')
      AND converged_at = 0
      AND dead_lettered_at = 0
      AND dead_letter_reason = ''
    )
    OR (
      status = 'retry'
      AND claim_generation > 0
      AND claim_owner = ''
      AND claim_lease_expires_at = 0
      AND available_at > updated_at
      AND attempt_count > 0
      AND first_observed_at > 0
      AND last_attempt_at > 0
      AND last_observed_at = updated_at
      AND length(last_class) > 0
      AND converged_at = 0
      AND dead_lettered_at = 0
      AND dead_letter_reason = ''
    )
    OR (
      status = 'converged'
      AND claim_generation > 0
      AND claim_owner = ''
      AND claim_lease_expires_at = 0
      AND available_at = 0
      AND attempt_count > 0
      AND consecutive_failures = 0
      AND first_observed_at > 0
      AND last_attempt_at > 0
      AND last_observed_at = updated_at
      AND length(last_class) > 0
      AND last_error_code = ''
      AND converged_at = updated_at
      AND dead_lettered_at = 0
      AND dead_letter_reason = ''
    )
    OR (
      status = 'dead_letter'
      AND claim_generation > 0
      AND claim_owner = ''
      AND claim_lease_expires_at = 0
      AND available_at = 0
      AND attempt_count > 0
      AND first_observed_at > 0
      AND last_attempt_at > 0
      AND last_observed_at = updated_at
      AND length(last_class) > 0
      AND converged_at = 0
      AND dead_lettered_at = updated_at
      AND length(dead_letter_reason) > 0
    )
  ),
  FOREIGN KEY (operation_id)
    REFERENCES relay_container_operations(operation_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_relay_container_reconciliation_observations_due
  ON relay_container_reconciliation_observations(
    available_at,
    operation_created_at,
    reservation_key
  )
  WHERE status IN ('pending', 'retry');

CREATE INDEX idx_relay_container_reconciliation_observations_lease
  ON relay_container_reconciliation_observations(
    claim_lease_expires_at,
    operation_id
  )
  WHERE status = 'leased';

CREATE INDEX idx_relay_container_reconciliation_observations_class
  ON relay_container_reconciliation_observations(
    last_class,
    status,
    last_observed_at,
    operation_id
  )
  WHERE last_class <> '';

CREATE TRIGGER relay_container_reconciliation_observation_insert_guard
BEFORE INSERT ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.status <> 'pending' OR
  NEW.claim_generation <> 0 OR
  NEW.claim_owner <> '' OR
  NEW.claim_lease_expires_at <> 0 OR
  NEW.available_at <> NEW.created_at OR
  NEW.attempt_count <> 0 OR
  NEW.consecutive_failures <> 0 OR
  NEW.first_observed_at <> 0 OR
  NEW.last_attempt_at <> 0 OR
  NEW.last_observed_at <> 0 OR
  NEW.last_class <> '' OR
  NEW.last_error_code <> '' OR
  NEW.converged_at <> 0 OR
  NEW.dead_lettered_at <> 0 OR
  NEW.dead_letter_reason <> '' OR
  NEW.updated_at <> NEW.created_at OR
  NOT EXISTS (
    SELECT 1
    FROM relay_container_operations AS operation
    WHERE operation.operation_id = NEW.operation_id
      AND operation.reservation_key = NEW.reservation_key
      AND operation.created_at = NEW.operation_created_at
      AND operation.owner_generation = NEW.owner_generation
      AND operation.reconciliation_id = NEW.reconciliation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation observation identity or initial state is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_observation_identity_immutable_guard
BEFORE UPDATE OF operation_id,
                 reservation_key,
                 operation_created_at,
                 owner_generation,
                 reconciliation_id,
                 recovery_deadline_at,
                 created_at
ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.operation_id IS NOT OLD.operation_id OR
  NEW.reservation_key IS NOT OLD.reservation_key OR
  NEW.operation_created_at IS NOT OLD.operation_created_at OR
  NEW.owner_generation IS NOT OLD.owner_generation OR
  NEW.reconciliation_id IS NOT OLD.reconciliation_id OR
  NEW.recovery_deadline_at IS NOT OLD.recovery_deadline_at OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation observation identity is immutable');
END;

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
  AND OLD.status NOT IN ('converged', 'dead_letter')
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
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation observation transition is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_observation_delete_guard
BEFORE DELETE ON relay_container_reconciliation_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation observation cannot be deleted');
END;

CREATE TABLE relay_container_reconciliation_cursor (
  cursor_name TEXT PRIMARY KEY NOT NULL
    CHECK (typeof(cursor_name) = 'text' AND cursor_name = 'operation_observer_v1'),
  last_created_at INTEGER NOT NULL
    CHECK (
      typeof(last_created_at) = 'integer'
      AND last_created_at BETWEEN 0 AND 2147483647
    ),
  last_reservation_key TEXT NOT NULL
    CHECK (
      typeof(last_reservation_key) = 'text'
      AND length(last_reservation_key) <= 128
      AND last_reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  round_high_created_at INTEGER NOT NULL
    CHECK (
      typeof(round_high_created_at) = 'integer'
      AND round_high_created_at BETWEEN 0 AND 2147483647
    ),
  round_high_reservation_key TEXT NOT NULL
    CHECK (
      typeof(round_high_reservation_key) = 'text'
      AND length(round_high_reservation_key) <= 128
      AND round_high_reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  scan_generation INTEGER NOT NULL
    CHECK (
      typeof(scan_generation) = 'integer'
      AND scan_generation BETWEEN 0 AND 2147483647
    ),
  run_generation INTEGER NOT NULL
    CHECK (
      typeof(run_generation) = 'integer'
      AND run_generation BETWEEN 0 AND 2147483647
    ),
  run_owner TEXT NOT NULL
    CHECK (
      typeof(run_owner) = 'text'
      AND (
        run_owner = ''
        OR (
          length(run_owner) = 32
          AND run_owner NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  run_lease_expires_at INTEGER NOT NULL
    CHECK (
      typeof(run_lease_expires_at) = 'integer'
      AND run_lease_expires_at BETWEEN 0 AND 2147483647
    ),
  last_started_at INTEGER NOT NULL
    CHECK (
      typeof(last_started_at) = 'integer'
      AND last_started_at BETWEEN 0 AND 2147483647
    ),
  last_completed_at INTEGER NOT NULL
    CHECK (
      typeof(last_completed_at) = 'integer'
      AND last_completed_at BETWEEN 0 AND 2147483647
    ),
  last_success_at INTEGER NOT NULL
    CHECK (
      typeof(last_success_at) = 'integer'
      AND last_success_at BETWEEN 0 AND 2147483647
    ),
  last_error_code TEXT NOT NULL
    CHECK (
      typeof(last_error_code) = 'text'
      AND length(last_error_code) <= 64
      AND last_error_code NOT GLOB '*[^a-z0-9_:-]*'
    ),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 2147483647),
  CHECK (
    (last_created_at = 0 AND last_reservation_key = '')
    OR (last_created_at > 0 AND length(last_reservation_key) > 0)
  ),
  CHECK (
    (round_high_created_at = 0 AND round_high_reservation_key = '')
    OR (round_high_created_at > 0 AND length(round_high_reservation_key) > 0)
  ),
  CHECK (
    round_high_created_at = 0
    OR last_created_at < round_high_created_at
    OR (
      last_created_at = round_high_created_at
      AND last_reservation_key <= round_high_reservation_key
    )
  ),
  CHECK (
    (
      scan_generation = 0
      AND last_created_at = 0
      AND round_high_created_at = 0
    )
    OR (
      scan_generation > 0
      AND round_high_created_at > 0
    )
  ),
  CHECK (last_success_at <= last_completed_at),
  CHECK (last_started_at <= updated_at),
  CHECK (last_completed_at <= updated_at),
  CHECK (
    (
      run_generation = 0
      AND run_owner = ''
      AND run_lease_expires_at = 0
      AND last_started_at = 0
      AND last_completed_at = 0
      AND last_success_at = 0
      AND last_error_code = ''
    )
    OR (
      run_generation > 0
      AND last_started_at > 0
      AND (
        (
          length(run_owner) = 32
          AND run_lease_expires_at > updated_at
          AND last_completed_at <= last_started_at
          AND last_error_code = ''
        )
        OR (
          run_owner = ''
          AND run_lease_expires_at = 0
          AND last_completed_at >= last_started_at
          AND (
            (
              last_error_code = ''
              AND last_success_at = last_completed_at
            )
            OR length(last_error_code) > 0
          )
        )
      )
    )
  )
);

INSERT INTO relay_container_reconciliation_cursor (
  cursor_name,
  last_created_at,
  last_reservation_key,
  round_high_created_at,
  round_high_reservation_key,
  scan_generation,
  run_generation,
  run_owner,
  run_lease_expires_at,
  last_started_at,
  last_completed_at,
  last_success_at,
  last_error_code,
  updated_at
) VALUES ('operation_observer_v1', 0, '', 0, '', 0, 0, '', 0, 0, 0, 0, '', 0);

CREATE TRIGGER relay_container_reconciliation_cursor_identity_immutable_guard
BEFORE UPDATE OF cursor_name
ON relay_container_reconciliation_cursor
FOR EACH ROW
WHEN NEW.cursor_name IS NOT OLD.cursor_name
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation cursor identity is immutable');
END;

CREATE TRIGGER relay_container_reconciliation_cursor_lifecycle_guard
BEFORE UPDATE ON relay_container_reconciliation_cursor
FOR EACH ROW
WHEN NOT (
  NEW.cursor_name IS OLD.cursor_name
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (
      NEW.last_created_at = OLD.last_created_at
      AND NEW.last_reservation_key = OLD.last_reservation_key
      AND NEW.round_high_created_at = OLD.round_high_created_at
      AND NEW.round_high_reservation_key = OLD.round_high_reservation_key
      AND NEW.scan_generation = OLD.scan_generation
      AND NEW.run_generation = OLD.run_generation + 1
      AND length(NEW.run_owner) = 32
      AND NEW.run_lease_expires_at > NEW.updated_at
      AND NEW.last_started_at = NEW.updated_at
      AND NEW.last_started_at >= OLD.last_started_at
      AND NEW.last_completed_at = OLD.last_completed_at
      AND NEW.last_success_at = OLD.last_success_at
      AND NEW.last_error_code = ''
      AND (
        (OLD.run_owner = '' AND OLD.run_lease_expires_at = 0)
        OR (
          length(OLD.run_owner) = 32
          AND OLD.run_lease_expires_at <= NEW.updated_at
        )
      )
    )
    OR (
      NEW.run_generation = OLD.run_generation
      AND NEW.run_owner = OLD.run_owner
      AND NEW.run_lease_expires_at = OLD.run_lease_expires_at
      AND NEW.last_started_at = OLD.last_started_at
      AND NEW.last_completed_at = OLD.last_completed_at
      AND NEW.last_success_at = OLD.last_success_at
      AND NEW.last_error_code = OLD.last_error_code
      AND length(OLD.run_owner) = 32
      AND OLD.run_lease_expires_at > NEW.updated_at
      AND (
        (
          NEW.scan_generation = OLD.scan_generation + 1
          AND NEW.last_created_at = 0
          AND NEW.last_reservation_key = ''
          AND NEW.round_high_created_at > 0
          AND length(NEW.round_high_reservation_key) > 0
        )
        OR (
          NEW.scan_generation = OLD.scan_generation
          AND NEW.round_high_created_at = OLD.round_high_created_at
          AND NEW.round_high_reservation_key = OLD.round_high_reservation_key
          AND (
            NEW.last_created_at > OLD.last_created_at
            OR (
              NEW.last_created_at = OLD.last_created_at
              AND NEW.last_reservation_key > OLD.last_reservation_key
            )
          )
        )
      )
    )
    OR (
      NEW.last_created_at = OLD.last_created_at
      AND NEW.last_reservation_key = OLD.last_reservation_key
      AND NEW.round_high_created_at = OLD.round_high_created_at
      AND NEW.round_high_reservation_key = OLD.round_high_reservation_key
      AND NEW.scan_generation = OLD.scan_generation
      AND length(OLD.run_owner) = 32
      AND OLD.run_lease_expires_at > NEW.updated_at
      AND NEW.run_generation = OLD.run_generation
      AND NEW.run_owner = ''
      AND NEW.run_lease_expires_at = 0
      AND NEW.last_started_at = OLD.last_started_at
      AND NEW.last_completed_at = NEW.updated_at
      AND NEW.last_completed_at >= OLD.last_completed_at
      AND (
        (
          NEW.last_success_at = NEW.updated_at
          AND NEW.last_error_code = ''
        )
        OR (
          NEW.last_success_at = OLD.last_success_at
          AND length(NEW.last_error_code) > 0
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation cursor transition is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_cursor_delete_guard
BEFORE DELETE ON relay_container_reconciliation_cursor
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation cursor cannot be deleted');
END;
