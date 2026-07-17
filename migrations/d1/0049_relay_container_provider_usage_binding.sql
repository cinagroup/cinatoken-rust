-- Bind reconciliation convergence to the immutable provider usage receipt.
-- DO status v3 and R2 metadata v4 are external observations: the strict
-- observer writes their receipt digests only after validating the complete
-- attempt/receipt/result tuple. D1 can independently verify its canonical
-- 0048 receipt and the local immutable terminal event.

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN provider_usage_binding_state TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK (
      typeof(provider_usage_binding_state) = 'text'
      AND provider_usage_binding_state IN (
        'not_applicable',
        'pending',
        'matching',
        'divergent'
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN provider_attempt_generation INTEGER
    CHECK (
      provider_attempt_generation IS NULL
      OR (
        typeof(provider_attempt_generation) = 'integer'
        AND provider_attempt_generation = 1
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN provider_usage_receipt_sha256 TEXT
    CHECK (
      provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(provider_usage_receipt_sha256) = 'text'
        AND length(provider_usage_receipt_sha256) = 64
        AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN provider_result_sha256 TEXT
    CHECK (
      provider_result_sha256 IS NULL
      OR (
        typeof(provider_result_sha256) = 'text'
        AND length(provider_result_sha256) = 64
        AND provider_result_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN do_provider_usage_receipt_sha256 TEXT
    CHECK (
      do_provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(do_provider_usage_receipt_sha256) = 'text'
        AND length(do_provider_usage_receipt_sha256) = 64
        AND do_provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN r2_provider_usage_receipt_sha256 TEXT
    CHECK (
      r2_provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(r2_provider_usage_receipt_sha256) = 'text'
        AND length(r2_provider_usage_receipt_sha256) = 64
        AND r2_provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

ALTER TABLE relay_container_reconciliation_observations
  ADD COLUMN terminal_provider_usage_receipt_sha256 TEXT
    CHECK (
      terminal_provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(terminal_provider_usage_receipt_sha256) = 'text'
        AND length(terminal_provider_usage_receipt_sha256) = 64
        AND terminal_provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    );

-- The 0045 lifecycle trigger rejects every in-place terminal update, so it is
-- removed only for the deterministic compatibility backfill and recreated
-- below with the complete 0045 state machine.
DROP TRIGGER relay_container_reconciliation_observation_lifecycle_guard;

UPDATE relay_container_reconciliation_observations AS observation
SET provider_usage_binding_state = CASE
      WHEN observation.status = 'converged' THEN 'divergent'
      ELSE 'pending'
    END,
    provider_attempt_generation = (
      SELECT receipt.attempt_generation
      FROM relay_container_provider_usage_receipts AS receipt
      WHERE receipt.operation_id = observation.operation_id
        AND receipt.reservation_key = observation.reservation_key
        AND receipt.owner_generation = observation.owner_generation
    ),
    provider_usage_receipt_sha256 = (
      SELECT receipt.usage_receipt_sha256
      FROM relay_container_provider_usage_receipts AS receipt
      WHERE receipt.operation_id = observation.operation_id
        AND receipt.reservation_key = observation.reservation_key
        AND receipt.owner_generation = observation.owner_generation
    ),
    provider_result_sha256 = (
      SELECT receipt.result_sha256
      FROM relay_container_provider_usage_receipts AS receipt
      WHERE receipt.operation_id = observation.operation_id
        AND receipt.reservation_key = observation.reservation_key
        AND receipt.owner_generation = observation.owner_generation
    )
WHERE EXISTS (
  SELECT 1
  FROM relay_container_provider_usage_receipts AS receipt
  WHERE receipt.operation_id = observation.operation_id
    AND receipt.reservation_key = observation.reservation_key
    AND receipt.owner_generation = observation.owner_generation
);

CREATE INDEX idx_relay_container_reconciliation_observations_provider_usage_binding
  ON relay_container_reconciliation_observations(
    provider_usage_binding_state,
    status,
    last_observed_at,
    operation_id
  )
  WHERE provider_usage_binding_state <> 'not_applicable';

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

CREATE TRIGGER relay_container_reconciliation_provider_usage_shape_insert_guard
BEFORE INSERT ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  (
    NEW.provider_usage_binding_state = 'not_applicable'
    AND (
      NEW.provider_attempt_generation IS NOT NULL
      OR NEW.provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.provider_result_sha256 IS NOT NULL
      OR NEW.do_provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.r2_provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.terminal_provider_usage_receipt_sha256 IS NOT NULL
    )
  )
  OR (
    NEW.provider_usage_binding_state <> 'not_applicable'
    AND (
      NEW.provider_attempt_generation IS NULL
      OR NEW.provider_usage_receipt_sha256 IS NULL
      OR NEW.provider_result_sha256 IS NULL
    )
  )
  OR (
    NEW.provider_usage_binding_state = 'matching'
    AND (
      NEW.status <> 'converged'
      OR NEW.do_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
      OR NEW.r2_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
      OR NEW.terminal_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding shape is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_shape_update_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  (
    NEW.provider_usage_binding_state = 'not_applicable'
    AND (
      NEW.provider_attempt_generation IS NOT NULL
      OR NEW.provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.provider_result_sha256 IS NOT NULL
      OR NEW.do_provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.r2_provider_usage_receipt_sha256 IS NOT NULL
      OR NEW.terminal_provider_usage_receipt_sha256 IS NOT NULL
    )
  )
  OR (
    NEW.provider_usage_binding_state <> 'not_applicable'
    AND (
      NEW.provider_attempt_generation IS NULL
      OR NEW.provider_usage_receipt_sha256 IS NULL
      OR NEW.provider_result_sha256 IS NULL
    )
  )
  OR (
    NEW.provider_usage_binding_state = 'matching'
    AND (
      NEW.status <> 'converged'
      OR NEW.do_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
      OR NEW.r2_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
      OR NEW.terminal_provider_usage_receipt_sha256 IS NOT NEW.provider_usage_receipt_sha256
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding shape is invalid');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_authority_insert_guard
BEFORE INSERT ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.provider_usage_binding_state <> 'not_applicable'
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_provider_usage_receipts AS receipt
    WHERE receipt.operation_id = NEW.operation_id
      AND receipt.reservation_key = NEW.reservation_key
      AND receipt.owner_generation = NEW.owner_generation
      AND receipt.attempt_generation = NEW.provider_attempt_generation
      AND receipt.usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
      AND receipt.result_sha256 = NEW.provider_result_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding is outside the canonical receipt');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_authority_update_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.provider_usage_binding_state <> 'not_applicable'
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_provider_usage_receipts AS receipt
    WHERE receipt.operation_id = NEW.operation_id
      AND receipt.reservation_key = NEW.reservation_key
      AND receipt.owner_generation = NEW.owner_generation
      AND receipt.attempt_generation = NEW.provider_attempt_generation
      AND receipt.usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
      AND receipt.result_sha256 = NEW.provider_result_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding is outside the canonical receipt');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_canonical_immutable_guard
BEFORE UPDATE OF provider_attempt_generation,
                 provider_usage_receipt_sha256,
                 provider_result_sha256
ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  OLD.provider_attempt_generation IS NOT NULL
  AND (
    NEW.provider_attempt_generation IS NOT OLD.provider_attempt_generation
    OR NEW.provider_usage_receipt_sha256 IS NOT OLD.provider_usage_receipt_sha256
    OR NEW.provider_result_sha256 IS NOT OLD.provider_result_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation canonical provider usage binding is immutable');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_matching_immutable_guard
BEFORE UPDATE OF provider_usage_binding_state,
                 provider_attempt_generation,
                 provider_usage_receipt_sha256,
                 provider_result_sha256,
                 do_provider_usage_receipt_sha256,
                 r2_provider_usage_receipt_sha256,
                 terminal_provider_usage_receipt_sha256
ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  (OLD.provider_usage_binding_state = 'matching' OR OLD.status = 'converged')
  AND (
    NEW.provider_usage_binding_state IS NOT OLD.provider_usage_binding_state
    OR NEW.provider_attempt_generation IS NOT OLD.provider_attempt_generation
    OR NEW.provider_usage_receipt_sha256 IS NOT OLD.provider_usage_receipt_sha256
    OR NEW.provider_result_sha256 IS NOT OLD.provider_result_sha256
    OR NEW.do_provider_usage_receipt_sha256 IS NOT OLD.do_provider_usage_receipt_sha256
    OR NEW.r2_provider_usage_receipt_sha256 IS NOT OLD.r2_provider_usage_receipt_sha256
    OR NEW.terminal_provider_usage_receipt_sha256 IS NOT OLD.terminal_provider_usage_receipt_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation matched provider usage binding is immutable');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_matching_terminal_insert_guard
BEFORE INSERT ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.provider_usage_binding_state = 'matching'
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    WHERE event.operation_id = NEW.operation_id
      AND event.reservation_key = NEW.reservation_key
      AND event.owner_generation = NEW.owner_generation
      AND event.reconciliation_id = NEW.reconciliation_id
      AND event.operation_from_status = 'dispatched'
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND event.provider_attempt_generation = NEW.provider_attempt_generation
      AND event.provider_usage_receipt_sha256 = NEW.terminal_provider_usage_receipt_sha256
      AND event.provider_result_sha256 = NEW.provider_result_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding lacks an exact terminal event');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_matching_terminal_update_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  NEW.provider_usage_binding_state = 'matching'
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    WHERE event.operation_id = NEW.operation_id
      AND event.reservation_key = NEW.reservation_key
      AND event.owner_generation = NEW.owner_generation
      AND event.reconciliation_id = NEW.reconciliation_id
      AND event.operation_from_status = 'dispatched'
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND event.provider_attempt_generation = NEW.provider_attempt_generation
      AND event.provider_usage_receipt_sha256 = NEW.terminal_provider_usage_receipt_sha256
      AND event.provider_result_sha256 = NEW.provider_result_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding lacks an exact terminal event');
END;

CREATE TRIGGER relay_container_reconciliation_provider_usage_convergence_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  OLD.status <> 'converged'
  AND NEW.status = 'converged'
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_usage_receipts AS receipt
    WHERE receipt.operation_id = NEW.operation_id
      AND receipt.reservation_key = NEW.reservation_key
      AND receipt.owner_generation = NEW.owner_generation
  )
  AND NOT (
    NEW.provider_usage_binding_state = 'matching'
    AND NEW.do_provider_usage_receipt_sha256 IS NEW.provider_usage_receipt_sha256
    AND NEW.r2_provider_usage_receipt_sha256 IS NEW.provider_usage_receipt_sha256
    AND NEW.terminal_provider_usage_receipt_sha256 IS NEW.provider_usage_receipt_sha256
    AND EXISTS (
      SELECT 1
      FROM relay_container_provider_usage_receipts AS receipt
      WHERE receipt.operation_id = NEW.operation_id
        AND receipt.reservation_key = NEW.reservation_key
        AND receipt.owner_generation = NEW.owner_generation
        AND receipt.attempt_generation = NEW.provider_attempt_generation
        AND receipt.usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
        AND receipt.result_sha256 = NEW.provider_result_sha256
    )
    AND EXISTS (
      SELECT 1
      FROM relay_container_terminal_events AS event
      WHERE event.operation_id = NEW.operation_id
        AND event.reservation_key = NEW.reservation_key
        AND event.owner_generation = NEW.owner_generation
        AND event.reconciliation_id = NEW.reconciliation_id
        AND event.operation_from_status = 'dispatched'
        AND event.operation_status = 'completed'
        AND event.billing_action = 'settle'
        AND event.provider_attempt_generation = NEW.provider_attempt_generation
        AND event.provider_usage_receipt_sha256 = NEW.terminal_provider_usage_receipt_sha256
        AND event.provider_result_sha256 = NEW.provider_result_sha256
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation provider usage binding must match before convergence');
END;

-- A receipt cannot be attached after a reconciliation has already converged;
-- such a row could never acquire external evidence because terminal rows are
-- intentionally immutable. Exact post-convergence replay is read-only in the
-- Controller and therefore never reaches this INSERT guard. Pre-0049 rows are
-- handled by the backfill above.
CREATE TRIGGER relay_container_provider_usage_receipt_reconciliation_guard
BEFORE INSERT ON relay_container_provider_usage_receipts
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM relay_container_reconciliation_observations AS observation
  WHERE observation.operation_id = NEW.operation_id
    AND observation.reservation_key = NEW.reservation_key
    AND observation.owner_generation = NEW.owner_generation
    AND observation.status = 'converged'
)
BEGIN
  SELECT RAISE(ABORT, 'relay container provider usage receipt cannot follow reconciliation convergence');
END;
