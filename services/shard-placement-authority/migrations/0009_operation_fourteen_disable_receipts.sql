CREATE TABLE shard_placement_authority_operation_fourteen_attempts (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  operation_ordinal INTEGER NOT NULL
    CHECK (operation_ordinal = 14),
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  attempt_contract TEXT NOT NULL
    CHECK (
      attempt_contract =
        'cinatoken-shard-placement-authority-operation-fourteen-attempt-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL,
  claim_owner_sha256 TEXT NOT NULL,
  lease_owner_sha256 TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_generation INTEGER NOT NULL
    CHECK (lease_generation >= 1),
  execution_plan_sha256 TEXT NOT NULL,
  operation_schedule_sha256 TEXT NOT NULL,
  authority_database_identity_sha256 TEXT NOT NULL,
  authority_ledger_identity_sha256 TEXT NOT NULL,
  ledger_version_before INTEGER NOT NULL
    CHECK (ledger_version_before BETWEEN 1 AND 52),
  ledger_head_before_sha256 TEXT NOT NULL,
  operation_start_sequence INTEGER NOT NULL
    CHECK (operation_start_sequence = ledger_version_before + 1),
  operation_five_terminal_receipt_sha256 TEXT NOT NULL,
  operation_five_send_attempt_digest_sha256 TEXT NOT NULL,
  operation_id_sha256 TEXT NOT NULL UNIQUE,
  operation_request_sha256 TEXT NOT NULL UNIQUE,
  controller_service_name TEXT NOT NULL,
  controller_enabled_source_version_id TEXT NOT NULL,
  controller_baseline_target_version_id TEXT NOT NULL,
  authority_command_contract TEXT NOT NULL
    CHECK (
      authority_command_contract =
        'cinatoken-shard-placement-authority-disable-command-v1'
    ),
  authority_command_digest_sha256 TEXT NOT NULL UNIQUE,
  gateway_command_contract TEXT NOT NULL
    CHECK (
      gateway_command_contract =
        'cinatoken-controller-deployment-gateway-disable-command-v1'
    ),
  gateway_command_digest_sha256 TEXT NOT NULL UNIQUE,
  gateway_idempotency_contract TEXT NOT NULL
    CHECK (
      gateway_idempotency_contract =
        'cinatoken-controller-deployment-gateway-disable-idempotency-v1'
    ),
  gateway_idempotency_key_sha256 TEXT NOT NULL UNIQUE,
  gateway_create_credential_id_sha256 TEXT NOT NULL,
  gateway_create_request_id_sha256 TEXT NOT NULL UNIQUE,
  gateway_status_credential_id_sha256 TEXT NOT NULL,
  gateway_status_request_id_sha256 TEXT NOT NULL UNIQUE,
  authority_version_id TEXT NOT NULL,
  expected_gateway_version_id TEXT NOT NULL,
  disable_deadline_at INTEGER NOT NULL,
  mutation_attempt_limit INTEGER NOT NULL
    CHECK (mutation_attempt_limit = 1),
  retry_limit INTEGER NOT NULL
    CHECK (retry_limit = 0),
  missing_readback_allows_resend INTEGER NOT NULL
    CHECK (missing_readback_allows_resend = 0),
  attempt_digest_sha256 TEXT NOT NULL UNIQUE,
  operation_start_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
  disable_dispatched_event_digest_sha256 TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_execution_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id_sha256, operation_ordinal)
    REFERENCES shard_placement_authority_execution_operations(
      authorization_id_sha256,
      ordinal
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_five_terminal_receipt_sha256)
    REFERENCES shard_placement_authority_operation_five_terminals(
      generic_terminal_receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_five_send_attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_five_send_attempts(
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_start_receipt_digest_sha256)
    REFERENCES shard_placement_authority_execution_receipts(
      receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (disable_dispatched_event_digest_sha256)
    REFERENCES shard_placement_authority_operation_fourteen_gateway_events(
      event_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    controller_enabled_source_version_id <>
      controller_baseline_target_version_id
  ),
  CHECK (
    length(controller_service_name) BETWEEN 1 AND 128
    AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(controller_enabled_source_version_id) BETWEEN 1 AND 128
    AND controller_enabled_source_version_id
      NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(controller_baseline_target_version_id) BETWEEN 1 AND 128
    AND controller_baseline_target_version_id
      NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(authority_version_id) BETWEEN 1 AND 128
    AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(expected_gateway_version_id) BETWEEN 1 AND 128
    AND expected_gateway_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    disable_deadline_at > recorded_at
  ),
  CHECK (
    attempt_digest_sha256 <>
      operation_start_receipt_digest_sha256
    AND attempt_digest_sha256 <>
      disable_dispatched_event_digest_sha256
    AND operation_start_receipt_digest_sha256 <>
      disable_dispatched_event_digest_sha256
  ),
  CHECK (
    length(authorization_id_sha256) = 64
    AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_owner_sha256) = 64
    AND claim_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(lease_owner_sha256) = 64
    AND lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(lease_token_sha256) = 64
    AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(execution_plan_sha256) = 64
    AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_schedule_sha256) = 64
    AND operation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_database_identity_sha256) = 64
    AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_ledger_identity_sha256) = 64
    AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(ledger_head_before_sha256) = 64
    AND ledger_head_before_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_five_terminal_receipt_sha256) = 64
    AND operation_five_terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_five_send_attempt_digest_sha256) = 64
    AND operation_five_send_attempt_digest_sha256
      NOT GLOB '*[^0-9a-f]*'
    AND length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_request_sha256) = 64
    AND operation_request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_command_digest_sha256) = 64
    AND authority_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_command_digest_sha256) = 64
    AND gateway_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_idempotency_key_sha256) = 64
    AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_create_credential_id_sha256) = 64
    AND gateway_create_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_create_request_id_sha256) = 64
    AND gateway_create_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_status_credential_id_sha256) = 64
    AND gateway_status_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_status_request_id_sha256) = 64
    AND gateway_status_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_digest_sha256) = 64
    AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_start_receipt_digest_sha256) = 64
    AND operation_start_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(disable_dispatched_event_digest_sha256) = 64
    AND disable_dispatched_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_attempt_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_fourteen_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_fourteen_attempt_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_claims AS claim
      JOIN shard_placement_authority_execution_operations AS operation
        ON operation.authorization_id_sha256 =
             claim.authorization_id_sha256
       AND operation.ordinal = 14
      JOIN shard_placement_authority_operation_five_terminals AS enabled
        ON enabled.authorization_id_sha256 =
             claim.authorization_id_sha256
      JOIN shard_placement_authority_operation_five_send_attempts
        AS enable_attempt
        ON enable_attempt.authorization_id_sha256 =
             claim.authorization_id_sha256
      WHERE claim.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
        AND claim.claim_owner_sha256 = NEW.claim_owner_sha256
        AND claim.lease_owner_sha256 = NEW.lease_owner_sha256
        AND claim.lease_token_sha256 = NEW.lease_token_sha256
        AND claim.lease_generation = NEW.lease_generation
        AND claim.execution_plan_sha256 = NEW.execution_plan_sha256
        AND claim.operation_schedule_sha256 =
              NEW.operation_schedule_sha256
        AND claim.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND claim.ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND claim.ledger_version = NEW.ledger_version_before
        AND claim.ledger_version <= 52
        AND claim.ledger_head_sha256 =
              NEW.ledger_head_before_sha256
        AND NEW.operation_start_sequence =
              claim.ledger_version + 1
        AND claim.inflight_operation_ordinal IS NULL
        AND claim.inflight_operation_id_sha256 IS NULL
        AND claim.inflight_request_sha256 IS NULL
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND (
          (
            claim.status = 'running'
            AND claim.last_completed_ordinal = 13
          )
          OR claim.status = 'disable_required'
        )
        AND NEW.recorded_at < claim.lease_expires_at
        AND NEW.recorded_at < claim.recovery_deadline_at
        AND NEW.disable_deadline_at > NEW.recorded_at
        AND NEW.disable_deadline_at <= claim.recovery_deadline_at
        AND operation.operation_id_sha256 =
              NEW.operation_id_sha256
        AND operation.kind = 'disable_controller_deployment'
        AND operation.shard_index IS NULL
        AND enabled.generic_terminal_receipt_digest_sha256 =
              NEW.operation_five_terminal_receipt_sha256
        AND enabled.attempt_digest_sha256 =
              NEW.operation_five_send_attempt_digest_sha256
        AND enabled.controller_service_name =
              NEW.controller_service_name
        AND enabled.controller_enabled_version_id =
              NEW.controller_enabled_source_version_id
        AND enabled.controller_baseline_version_id =
              NEW.controller_baseline_target_version_id
        AND enabled.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND enabled.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND enable_attempt.attempt_digest_sha256 =
              NEW.operation_five_send_attempt_digest_sha256
        AND enable_attempt.controller_service_name =
              NEW.controller_service_name
        AND enable_attempt.controller_enabled_version_id =
              NEW.controller_enabled_source_version_id
        AND enable_attempt.controller_baseline_version_id =
              NEW.controller_baseline_target_version_id
        AND enable_attempt.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND enable_attempt.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
    )
      THEN RAISE(ABORT, 'operation_fourteen_attempt_source_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_attempt_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_fourteen_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_fourteen_attempt');
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_attempt_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_fourteen_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_preserved_operation_fourteen_attempt');
END;

CREATE TABLE shard_placement_authority_operation_fourteen_gateway_events (
  authorization_id_sha256 TEXT NOT NULL,
  attempt_digest_sha256 TEXT NOT NULL,
  event_sequence INTEGER NOT NULL
    CHECK (event_sequence BETWEEN 1 AND 64),
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  event_contract TEXT NOT NULL
    CHECK (
      event_contract =
        'cinatoken-shard-placement-authority-operation-fourteen-gateway-event-v1'
    ),
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'disable_dispatched',
        'mutation_accepted',
        'mutation_rejected',
        'mutation_unknown',
        'status_target',
        'status_drift',
        'status_unknown',
        'stable_disabled'
      )
    ),
  dispatch_semantics TEXT NOT NULL
    CHECK (
      dispatch_semantics =
        'authority_persisted_network_may_not_have_occurred'
    ),
  credential_role TEXT NOT NULL
    CHECK (credential_role IN ('disable_create', 'disable_status')),
  credential_id_sha256 TEXT NOT NULL,
  request_id_sha256 TEXT NOT NULL UNIQUE,
  authority_command_digest_sha256 TEXT NOT NULL,
  gateway_command_digest_sha256 TEXT NOT NULL,
  gateway_idempotency_key_sha256 TEXT NOT NULL,
  controller_service_name TEXT NOT NULL,
  controller_baseline_target_version_id TEXT NOT NULL,
  expected_gateway_version_id TEXT NOT NULL,
  observed_gateway_version_id TEXT,
  observed_controller_version_id TEXT,
  status_classification TEXT
    CHECK (
      status_classification IS NULL
      OR status_classification IN (
        'target_observed',
        'drift_observed',
        'unknown'
      )
    ),
  gateway_http_status INTEGER
    CHECK (
      gateway_http_status IS NULL
      OR gateway_http_status BETWEEN 100 AND 599
    ),
  gateway_response_sha256 TEXT,
  gateway_response_bytes INTEGER
    CHECK (
      gateway_response_bytes IS NULL
      OR gateway_response_bytes BETWEEN 1 AND 65536
    ),
  cloudflare_request_id_sha256 TEXT,
  deployment_set_sha256 TEXT,
  observation_digest_sha256 TEXT,
  stability_minimum_seconds INTEGER
    CHECK (
      stability_minimum_seconds IS NULL
      OR stability_minimum_seconds BETWEEN 5 AND 120
    ),
  predecessor_event_digest_sha256 TEXT NOT NULL,
  event_digest_sha256 TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (attempt_digest_sha256, event_sequence),
  UNIQUE (
    authorization_id_sha256,
    attempt_digest_sha256,
    event_sequence
  ),
  FOREIGN KEY (attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_fourteen_attempts(
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(controller_service_name) BETWEEN 1 AND 128
    AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(controller_baseline_target_version_id) BETWEEN 1 AND 128
    AND controller_baseline_target_version_id
      NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(expected_gateway_version_id) BETWEEN 1 AND 128
    AND expected_gateway_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND (
      observed_gateway_version_id IS NULL
      OR (
        length(observed_gateway_version_id) BETWEEN 1 AND 128
        AND observed_gateway_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    )
    AND (
      observed_controller_version_id IS NULL
      OR (
        length(observed_controller_version_id) BETWEEN 1 AND 128
        AND observed_controller_version_id
          NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    )
  ),
  CHECK (
    length(authorization_id_sha256) = 64
    AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_digest_sha256) = 64
    AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(credential_id_sha256) = 64
    AND credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(request_id_sha256) = 64
    AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_command_digest_sha256) = 64
    AND authority_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_command_digest_sha256) = 64
    AND gateway_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_idempotency_key_sha256) = 64
    AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(predecessor_event_digest_sha256) = 64
    AND predecessor_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(event_digest_sha256) = 64
    AND event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (
      gateway_response_sha256 IS NULL
      OR (
        length(gateway_response_sha256) = 64
        AND gateway_response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      cloudflare_request_id_sha256 IS NULL
      OR (
        length(cloudflare_request_id_sha256) = 64
        AND cloudflare_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      deployment_set_sha256 IS NULL
      OR (
        length(deployment_set_sha256) = 64
        AND deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      observation_digest_sha256 IS NULL
      OR (
        length(observation_digest_sha256) = 64
        AND observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
  ),
  CHECK (
    (
      event_kind = 'disable_dispatched'
      AND event_sequence = 1
      AND credential_role = 'disable_create'
      AND status_classification IS NULL
      AND gateway_http_status IS NULL
      AND gateway_response_sha256 IS NULL
      AND gateway_response_bytes IS NULL
      AND cloudflare_request_id_sha256 IS NULL
      AND observed_gateway_version_id IS NULL
      AND observed_controller_version_id IS NULL
      AND deployment_set_sha256 IS NULL
      AND observation_digest_sha256 IS NULL
      AND stability_minimum_seconds IS NULL
    )
    OR (
      event_kind IN (
        'mutation_accepted',
        'mutation_rejected',
        'mutation_unknown'
      )
      AND event_sequence = 2
      AND credential_role = 'disable_create'
      AND status_classification IS NULL
      AND observed_controller_version_id IS NULL
      AND deployment_set_sha256 IS NULL
      AND observation_digest_sha256 IS NULL
      AND stability_minimum_seconds IS NULL
    )
    OR (
      event_kind IN (
        'status_target',
        'status_drift',
        'status_unknown',
        'stable_disabled'
      )
      AND event_sequence >= 2
      AND credential_role = 'disable_status'
    )
  ),
  CHECK (
    (gateway_response_sha256 IS NULL) =
      (gateway_response_bytes IS NULL)
  ),
  CHECK (
    event_digest_sha256 <> predecessor_event_digest_sha256
  ),
  CHECK (
    event_kind <> 'mutation_accepted'
    OR (
      gateway_http_status BETWEEN 200 AND 299
      AND gateway_response_sha256 IS NOT NULL
    )
  ),
  CHECK (
    event_kind <> 'mutation_rejected'
    OR (
      gateway_http_status BETWEEN 400 AND 599
      AND gateway_response_sha256 IS NOT NULL
    )
  ),
  CHECK (
    event_kind NOT IN ('status_target', 'stable_disabled')
    OR (
      status_classification = 'target_observed'
      AND observed_controller_version_id =
            controller_baseline_target_version_id
      AND gateway_http_status BETWEEN 200 AND 299
      AND gateway_response_sha256 IS NOT NULL
      AND observed_gateway_version_id = expected_gateway_version_id
      AND deployment_set_sha256 IS NOT NULL
      AND observation_digest_sha256 IS NOT NULL
    )
  ),
  CHECK (
    event_kind <> 'status_drift'
    OR (
      status_classification = 'drift_observed'
      AND gateway_http_status BETWEEN 200 AND 299
      AND gateway_response_sha256 IS NOT NULL
      AND observed_gateway_version_id IS NOT NULL
      AND observed_controller_version_id IS NOT NULL
      AND deployment_set_sha256 IS NOT NULL
      AND observation_digest_sha256 IS NOT NULL
    )
  ),
  CHECK (
    event_kind <> 'status_unknown'
    OR status_classification = 'unknown'
  ),
  CHECK (
    event_kind <> 'stable_disabled'
    OR stability_minimum_seconds IS NOT NULL
  )
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_gateway_event_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_fourteen_gateway_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_fourteen_gateway_event_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_fourteen_attempts AS attempt
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.attempt_digest_sha256 =
              NEW.attempt_digest_sha256
        AND attempt.authority_command_digest_sha256 =
              NEW.authority_command_digest_sha256
        AND attempt.gateway_command_digest_sha256 =
              NEW.gateway_command_digest_sha256
        AND attempt.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND attempt.controller_service_name =
              NEW.controller_service_name
        AND attempt.controller_baseline_target_version_id =
              NEW.controller_baseline_target_version_id
        AND attempt.expected_gateway_version_id =
              NEW.expected_gateway_version_id
        AND NEW.recorded_at <= attempt.disable_deadline_at
        AND (
          (
            NEW.credential_role = 'disable_create'
            AND NEW.credential_id_sha256 =
                  attempt.gateway_create_credential_id_sha256
          )
          OR (
            NEW.credential_role = 'disable_status'
            AND NEW.credential_id_sha256 =
                  attempt.gateway_status_credential_id_sha256
          )
        )
    )
      THEN RAISE(ABORT, 'operation_fourteen_gateway_event_source_mismatch')
  END;

  SELECT CASE
    WHEN (
      NEW.event_sequence = 1
      AND (
        NEW.event_kind <> 'disable_dispatched'
        OR NEW.predecessor_event_digest_sha256 <>
             NEW.attempt_digest_sha256
        OR NEW.event_digest_sha256 <> (
          SELECT attempt.disable_dispatched_event_digest_sha256
          FROM shard_placement_authority_operation_fourteen_attempts
            AS attempt
          WHERE attempt.attempt_digest_sha256 =
                  NEW.attempt_digest_sha256
        )
        OR NEW.request_id_sha256 <> (
          SELECT attempt.gateway_create_request_id_sha256
          FROM shard_placement_authority_operation_fourteen_attempts
            AS attempt
          WHERE attempt.attempt_digest_sha256 =
                  NEW.attempt_digest_sha256
        )
      )
    )
    OR (
      NEW.event_sequence > 1
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_fourteen_gateway_events
          AS predecessor
        WHERE predecessor.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND predecessor.event_sequence =
                NEW.event_sequence - 1
          AND predecessor.event_digest_sha256 =
                NEW.predecessor_event_digest_sha256
      )
    )
      THEN RAISE(ABORT, 'operation_fourteen_gateway_event_chain_mismatch')
  END;

  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM shard_placement_authority_operation_fourteen_gateway_events
        AS existing
      WHERE existing.attempt_digest_sha256 =
              NEW.attempt_digest_sha256
    ) <> NEW.event_sequence - 1
      THEN RAISE(ABORT, 'operation_fourteen_gateway_event_sequence_gap')
  END;

  SELECT CASE
    WHEN NEW.event_kind = 'stable_disabled'
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_fourteen_gateway_events
          AS predecessor
        WHERE predecessor.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND predecessor.event_sequence =
                NEW.event_sequence - 1
          AND predecessor.event_digest_sha256 =
                NEW.predecessor_event_digest_sha256
          AND predecessor.event_kind = 'status_target'
          AND predecessor.status_classification = 'target_observed'
          AND predecessor.observed_gateway_version_id =
                NEW.observed_gateway_version_id
          AND predecessor.observed_controller_version_id =
                NEW.observed_controller_version_id
          AND predecessor.deployment_set_sha256 =
                NEW.deployment_set_sha256
          AND predecessor.observation_digest_sha256 =
                NEW.observation_digest_sha256
          AND NEW.recorded_at - predecessor.recorded_at >=
                NEW.stability_minimum_seconds
      )
      THEN RAISE(ABORT, 'operation_fourteen_stable_disabled_mismatch')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_fourteen_terminals
        AS terminal
      WHERE terminal.attempt_digest_sha256 =
              NEW.attempt_digest_sha256
    )
      THEN RAISE(ABORT, 'operation_fourteen_gateway_chain_closed')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_gateway_event_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_fourteen_gateway_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_fourteen_gateway_event');
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_gateway_event_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_fourteen_gateway_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_preserved_operation_fourteen_gateway_event');
END;

CREATE TABLE shard_placement_authority_operation_fourteen_terminals (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  operation_ordinal INTEGER NOT NULL
    CHECK (operation_ordinal = 14),
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  terminal_contract TEXT NOT NULL
    CHECK (
      terminal_contract =
        'cinatoken-shard-placement-authority-operation-fourteen-terminal-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL,
  claim_owner_sha256 TEXT NOT NULL,
  attempt_lease_owner_sha256 TEXT NOT NULL,
  attempt_lease_token_sha256 TEXT NOT NULL,
  attempt_lease_generation INTEGER NOT NULL
    CHECK (attempt_lease_generation >= 1),
  lease_owner_sha256 TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_generation INTEGER NOT NULL
    CHECK (lease_generation >= 1),
  execution_plan_sha256 TEXT NOT NULL,
  operation_schedule_sha256 TEXT NOT NULL,
  authority_database_identity_sha256 TEXT NOT NULL,
  authority_ledger_identity_sha256 TEXT NOT NULL,
  attempt_digest_sha256 TEXT NOT NULL UNIQUE,
  operation_id_sha256 TEXT NOT NULL UNIQUE,
  operation_request_sha256 TEXT NOT NULL UNIQUE,
  operation_start_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
  controller_service_name TEXT NOT NULL,
  controller_enabled_source_version_id TEXT NOT NULL,
  controller_baseline_target_version_id TEXT NOT NULL,
  authority_command_digest_sha256 TEXT NOT NULL,
  gateway_command_digest_sha256 TEXT NOT NULL,
  gateway_idempotency_key_sha256 TEXT NOT NULL,
  terminal_event_sequence INTEGER NOT NULL,
  terminal_event_digest_sha256 TEXT NOT NULL UNIQUE,
  terminal_event_kind TEXT NOT NULL
    CHECK (
      terminal_event_kind IN (
        'mutation_rejected',
        'mutation_unknown',
        'status_drift',
        'status_unknown',
        'stable_disabled'
      )
    ),
  terminal_event_response_sha256 TEXT,
  terminal_event_request_id_sha256 TEXT NOT NULL,
  terminal_event_cloudflare_request_id_sha256 TEXT,
  terminal_event_observation_digest_sha256 TEXT,
  terminal_event_deployment_set_sha256 TEXT,
  result_outcome TEXT NOT NULL
    CHECK (
      result_outcome IN (
        'exact_success',
        'ambiguous_recovered',
        'rejected',
        'unresolved'
      )
    ),
  recovery_mode TEXT NOT NULL
    CHECK (recovery_mode IN ('fresh', 'readback_only')),
  terminal_response_sha256 TEXT NOT NULL,
  terminal_evidence_sha256 TEXT NOT NULL UNIQUE,
  authority_terminal_version_id TEXT NOT NULL,
  terminal_writer_credential_id_sha256 TEXT NOT NULL,
  terminal_writer_request_id_sha256 TEXT NOT NULL UNIQUE,
  ledger_version_before INTEGER NOT NULL
    CHECK (ledger_version_before BETWEEN 2 AND 63),
  ledger_head_before_sha256 TEXT NOT NULL,
  generic_receipt_sequence INTEGER NOT NULL
    CHECK (generic_receipt_sequence = ledger_version_before + 1),
  generic_terminal_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_execution_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_fourteen_attempts(
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (attempt_digest_sha256, terminal_event_sequence)
    REFERENCES shard_placement_authority_operation_fourteen_gateway_events(
      attempt_digest_sha256,
      event_sequence
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (generic_terminal_receipt_digest_sha256)
    REFERENCES shard_placement_authority_execution_receipts(
      receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    length(controller_service_name) BETWEEN 1 AND 128
    AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(controller_enabled_source_version_id) BETWEEN 1 AND 128
    AND controller_enabled_source_version_id
      NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(controller_baseline_target_version_id) BETWEEN 1 AND 128
    AND controller_baseline_target_version_id
      NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length(authority_terminal_version_id) BETWEEN 1 AND 128
    AND authority_terminal_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(authorization_id_sha256) = 64
    AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_owner_sha256) = 64
    AND claim_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_lease_owner_sha256) = 64
    AND attempt_lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_lease_token_sha256) = 64
    AND attempt_lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(lease_owner_sha256) = 64
    AND lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(lease_token_sha256) = 64
    AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(execution_plan_sha256) = 64
    AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_schedule_sha256) = 64
    AND operation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_database_identity_sha256) = 64
    AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_ledger_identity_sha256) = 64
    AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_digest_sha256) = 64
    AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_request_sha256) = 64
    AND operation_request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_start_receipt_digest_sha256) = 64
    AND operation_start_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authority_command_digest_sha256) = 64
    AND authority_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_command_digest_sha256) = 64
    AND gateway_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(gateway_idempotency_key_sha256) = 64
    AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_event_digest_sha256) = 64
    AND terminal_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_event_request_id_sha256) = 64
    AND terminal_event_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_response_sha256) = 64
    AND terminal_response_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_evidence_sha256) = 64
    AND terminal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_writer_credential_id_sha256) = 64
    AND terminal_writer_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_writer_request_id_sha256) = 64
    AND terminal_writer_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(ledger_head_before_sha256) = 64
    AND ledger_head_before_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(generic_terminal_receipt_digest_sha256) = 64
    AND generic_terminal_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND (
      terminal_event_response_sha256 IS NULL
      OR (
        length(terminal_event_response_sha256) = 64
        AND terminal_event_response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      terminal_event_cloudflare_request_id_sha256 IS NULL
      OR (
        length(terminal_event_cloudflare_request_id_sha256) = 64
        AND terminal_event_cloudflare_request_id_sha256
          NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      terminal_event_observation_digest_sha256 IS NULL
      OR (
        length(terminal_event_observation_digest_sha256) = 64
        AND terminal_event_observation_digest_sha256
          NOT GLOB '*[^0-9a-f]*'
      )
    )
    AND (
      terminal_event_deployment_set_sha256 IS NULL
      OR (
        length(terminal_event_deployment_set_sha256) = 64
        AND terminal_event_deployment_set_sha256
          NOT GLOB '*[^0-9a-f]*'
      )
    )
  ),
  CHECK (
    result_outcome NOT IN ('exact_success', 'ambiguous_recovered')
    OR terminal_event_kind = 'stable_disabled'
  ),
  CHECK (
    result_outcome <> 'exact_success'
    OR recovery_mode = 'fresh'
  ),
  CHECK (
    result_outcome <> 'ambiguous_recovered'
    OR recovery_mode = 'readback_only'
  ),
  CHECK (
    result_outcome <> 'rejected'
    OR terminal_event_kind IN ('mutation_rejected', 'status_drift')
  ),
  CHECK (
    result_outcome <> 'unresolved'
    OR terminal_event_kind IN (
      'mutation_unknown',
      'status_drift',
      'status_unknown'
    )
  ),
  CHECK (
    terminal_response_sha256 <> terminal_evidence_sha256
    AND terminal_response_sha256 <>
      generic_terminal_receipt_digest_sha256
    AND terminal_evidence_sha256 <>
      generic_terminal_receipt_digest_sha256
  )
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_terminal_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_fourteen_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_fourteen_terminal_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_fourteen_attempts AS attempt
      JOIN shard_placement_authority_execution_claims AS claim
        ON claim.authorization_id_sha256 =
             attempt.authorization_id_sha256
      JOIN shard_placement_authority_operation_fourteen_gateway_events
        AS terminal_event
        ON terminal_event.attempt_digest_sha256 =
             attempt.attempt_digest_sha256
       AND terminal_event.event_sequence =
             NEW.terminal_event_sequence
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.attempt_digest_sha256 =
              NEW.attempt_digest_sha256
        AND attempt.claim_digest_sha256 =
              NEW.claim_digest_sha256
        AND attempt.claim_owner_sha256 =
              NEW.claim_owner_sha256
        AND attempt.lease_owner_sha256 =
              NEW.attempt_lease_owner_sha256
        AND attempt.lease_token_sha256 =
              NEW.attempt_lease_token_sha256
        AND attempt.lease_generation =
              NEW.attempt_lease_generation
        AND attempt.execution_plan_sha256 =
              NEW.execution_plan_sha256
        AND attempt.operation_schedule_sha256 =
              NEW.operation_schedule_sha256
        AND attempt.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND attempt.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND attempt.operation_id_sha256 =
              NEW.operation_id_sha256
        AND attempt.operation_request_sha256 =
              NEW.operation_request_sha256
        AND attempt.operation_start_receipt_digest_sha256 =
              NEW.operation_start_receipt_digest_sha256
        AND attempt.controller_service_name =
              NEW.controller_service_name
        AND attempt.controller_enabled_source_version_id =
              NEW.controller_enabled_source_version_id
        AND attempt.controller_baseline_target_version_id =
              NEW.controller_baseline_target_version_id
        AND attempt.authority_command_digest_sha256 =
              NEW.authority_command_digest_sha256
        AND attempt.gateway_command_digest_sha256 =
              NEW.gateway_command_digest_sha256
        AND attempt.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND claim.claim_digest_sha256 =
              NEW.claim_digest_sha256
        AND claim.claim_owner_sha256 =
              NEW.claim_owner_sha256
        AND claim.lease_owner_sha256 =
              NEW.lease_owner_sha256
        AND claim.lease_token_sha256 =
              NEW.lease_token_sha256
        AND claim.lease_generation =
              NEW.lease_generation
        AND claim.execution_plan_sha256 =
              NEW.execution_plan_sha256
        AND claim.operation_schedule_sha256 =
              NEW.operation_schedule_sha256
        AND claim.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND claim.ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND claim.ledger_version =
              NEW.ledger_version_before
        AND claim.ledger_head_sha256 =
              NEW.ledger_head_before_sha256
        AND NEW.generic_receipt_sequence =
              claim.ledger_version + 1
        AND claim.status IN ('running', 'disable_required')
        AND claim.inflight_operation_ordinal = 14
        AND claim.inflight_operation_id_sha256 =
              NEW.operation_id_sha256
        AND claim.inflight_request_sha256 =
              NEW.operation_request_sha256
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND NEW.recorded_at < claim.lease_expires_at
        AND NEW.recorded_at < claim.recovery_deadline_at
        AND terminal_event.event_digest_sha256 =
              NEW.terminal_event_digest_sha256
        AND terminal_event.event_kind =
              NEW.terminal_event_kind
        AND terminal_event.gateway_response_sha256 IS
              NEW.terminal_event_response_sha256
        AND terminal_event.request_id_sha256 =
              NEW.terminal_event_request_id_sha256
        AND terminal_event.cloudflare_request_id_sha256 IS
              NEW.terminal_event_cloudflare_request_id_sha256
        AND terminal_event.observation_digest_sha256 IS
              NEW.terminal_event_observation_digest_sha256
        AND terminal_event.deployment_set_sha256 IS
              NEW.terminal_event_deployment_set_sha256
        AND terminal_event.recorded_at <= NEW.recorded_at
        AND NOT EXISTS (
          SELECT 1
          FROM shard_placement_authority_operation_fourteen_gateway_events
            AS later
          WHERE later.attempt_digest_sha256 =
                  NEW.attempt_digest_sha256
            AND later.event_sequence >
                  NEW.terminal_event_sequence
        )
        AND (
          NEW.result_outcome <> 'ambiguous_recovered'
          OR (
            claim.inflight_readback_only = 1
            OR EXISTS (
              SELECT 1
              FROM shard_placement_authority_operation_fourteen_gateway_events
                AS unknown_event
              WHERE unknown_event.attempt_digest_sha256 =
                      NEW.attempt_digest_sha256
                AND unknown_event.event_sequence <
                      NEW.terminal_event_sequence
                AND unknown_event.event_kind = 'mutation_unknown'
            )
          )
        )
        AND (
          NEW.result_outcome <> 'exact_success'
          OR (
            EXISTS (
              SELECT 1
              FROM shard_placement_authority_operation_fourteen_gateway_events
                AS accepted_event
              WHERE accepted_event.attempt_digest_sha256 =
                      NEW.attempt_digest_sha256
                AND accepted_event.event_sequence = 2
                AND accepted_event.event_kind = 'mutation_accepted'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM shard_placement_authority_operation_fourteen_gateway_events
                AS ambiguous_event
              WHERE ambiguous_event.attempt_digest_sha256 =
                      NEW.attempt_digest_sha256
                AND ambiguous_event.event_kind IN (
                      'mutation_rejected',
                      'mutation_unknown'
                    )
            )
          )
        )
    )
      THEN RAISE(ABORT, 'operation_fourteen_terminal_source_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_terminal_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_fourteen_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_fourteen_terminal');
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_terminal_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_fourteen_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_preserved_operation_fourteen_terminal');
END;

CREATE TRIGGER
  shard_placement_authority_operation_fourteen_receipt_sidecar_guard
BEFORE INSERT ON shard_placement_authority_execution_receipts
FOR EACH ROW
WHEN NEW.operation_ordinal = 14
  AND NEW.event_kind IN ('operation_started', 'operation_terminal')
BEGIN
  SELECT CASE
    WHEN NEW.event_kind = 'operation_started'
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_fourteen_attempts AS attempt
        WHERE attempt.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND attempt.operation_ordinal = NEW.operation_ordinal
          AND attempt.claim_digest_sha256 =
                NEW.claim_digest_sha256
          AND attempt.execution_plan_sha256 =
                NEW.execution_plan_sha256
          AND attempt.authority_ledger_identity_sha256 =
                NEW.ledger_identity_sha256
          AND attempt.operation_start_sequence =
                NEW.sequence
          AND attempt.ledger_head_before_sha256 =
                NEW.predecessor_receipt_sha256
          AND attempt.operation_id_sha256 =
                NEW.operation_id_sha256
          AND NEW.operation_kind =
                'disable_controller_deployment'
          AND NEW.shard_index IS NULL
          AND attempt.operation_request_sha256 =
                NEW.request_sha256
          AND NEW.response_sha256 IS NULL
          AND NEW.cloudflare_request_id_sha256 IS NULL
          AND attempt.attempt_digest_sha256 =
                NEW.evidence_sha256
          AND NEW.safety_reason IS NULL
          AND NEW.outcome = 'pending'
          AND attempt.lease_owner_sha256 =
                NEW.lease_owner_sha256
          AND attempt.lease_token_sha256 =
                NEW.lease_token_sha256
          AND attempt.lease_generation =
                NEW.lease_generation
          AND attempt.gateway_create_credential_id_sha256 =
                NEW.receipt_credential_id_sha256
          AND attempt.gateway_create_request_id_sha256 =
                NEW.request_id_sha256
          AND attempt.operation_start_receipt_digest_sha256 =
                NEW.receipt_digest_sha256
      )
      THEN RAISE(
        ABORT,
        'operation_fourteen_started_receipt_sidecar_mismatch'
      )
  END;

  SELECT CASE
    WHEN NEW.event_kind = 'operation_terminal'
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_fourteen_terminals
          AS terminal
        WHERE terminal.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND terminal.operation_ordinal =
                NEW.operation_ordinal
          AND terminal.claim_digest_sha256 =
                NEW.claim_digest_sha256
          AND terminal.execution_plan_sha256 =
                NEW.execution_plan_sha256
          AND terminal.authority_ledger_identity_sha256 =
                NEW.ledger_identity_sha256
          AND terminal.generic_receipt_sequence =
                NEW.sequence
          AND terminal.ledger_head_before_sha256 =
                NEW.predecessor_receipt_sha256
          AND terminal.operation_id_sha256 =
                NEW.operation_id_sha256
          AND NEW.operation_kind =
                'disable_controller_deployment'
          AND NEW.shard_index IS NULL
          AND terminal.operation_request_sha256 =
                NEW.request_sha256
          AND terminal.terminal_response_sha256 =
                NEW.response_sha256
          AND terminal.terminal_event_cloudflare_request_id_sha256 IS
                NEW.cloudflare_request_id_sha256
          AND terminal.terminal_evidence_sha256 =
                NEW.evidence_sha256
          AND NEW.safety_reason IS NULL
          AND terminal.result_outcome =
                NEW.outcome
          AND terminal.lease_owner_sha256 =
                NEW.lease_owner_sha256
          AND terminal.lease_token_sha256 =
                NEW.lease_token_sha256
          AND terminal.lease_generation =
                NEW.lease_generation
          AND terminal.terminal_writer_credential_id_sha256 =
                NEW.receipt_credential_id_sha256
          AND terminal.terminal_writer_request_id_sha256 =
                NEW.request_id_sha256
          AND terminal.generic_terminal_receipt_digest_sha256 =
                NEW.receipt_digest_sha256
      )
      THEN RAISE(
        ABORT,
        'operation_fourteen_terminal_receipt_sidecar_mismatch'
      )
  END;
END;
