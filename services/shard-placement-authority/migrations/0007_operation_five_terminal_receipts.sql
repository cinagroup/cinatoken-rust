CREATE TABLE shard_placement_authority_operation_five_terminals (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  terminal_contract TEXT NOT NULL
    CHECK (
      terminal_contract =
        'cinatoken-shard-placement-authority-operation-five-terminal-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_owner_sha256 TEXT NOT NULL
    CHECK (
      length(claim_owner_sha256) = 64
      AND claim_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_owner_sha256 TEXT NOT NULL
    CHECK (
      length(lease_owner_sha256) = 64
      AND lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token_sha256 TEXT NOT NULL
    CHECK (
      length(lease_token_sha256) = 64
      AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_generation INTEGER NOT NULL
    CHECK (typeof(lease_generation) = 'integer' AND lease_generation = 1),
  attempt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(attempt_digest_sha256) = 64
      AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  send_started_event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(send_started_event_digest_sha256) = 64
      AND send_started_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_event_sequence INTEGER NOT NULL
    CHECK (
      typeof(stable_gateway_event_sequence) = 'integer'
      AND stable_gateway_event_sequence >= 5
    ),
  stable_gateway_event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(stable_gateway_event_digest_sha256) = 64
      AND stable_gateway_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_predecessor_event_digest_sha256 TEXT NOT NULL
    CHECK (
      length(stable_gateway_predecessor_event_digest_sha256) = 64
      AND stable_gateway_predecessor_event_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(stable_gateway_request_id_sha256) = 64
      AND stable_gateway_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_response_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(stable_gateway_response_sha256) = 64
      AND stable_gateway_response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_response_bytes INTEGER NOT NULL
    CHECK (
      typeof(stable_gateway_response_bytes) = 'integer'
      AND stable_gateway_response_bytes BETWEEN 1 AND 65536
    ),
  stable_observation_digest_sha256 TEXT NOT NULL
    CHECK (
      length(stable_observation_digest_sha256) = 64
      AND stable_observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  stable_status_response_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(stable_status_response_request_id_sha256) = 64
      AND stable_status_response_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  stable_gateway_recorded_at INTEGER NOT NULL
    CHECK (
      typeof(stable_gateway_recorded_at) = 'integer'
      AND stable_gateway_recorded_at > 0
    ),
  deployment_set_sha256 TEXT NOT NULL
    CHECK (
      length(deployment_set_sha256) = 64
      AND deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  target_version_sha256 TEXT NOT NULL
    CHECK (
      length(target_version_sha256) = 64
      AND target_version_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_version_id TEXT NOT NULL
    CHECK (
      length(gateway_version_id) BETWEEN 1 AND 128
      AND gateway_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_service_name TEXT NOT NULL
    CHECK (
      length(controller_service_name) BETWEEN 1 AND 128
      AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_enabled_version_id TEXT NOT NULL
    CHECK (
      length(controller_enabled_version_id) BETWEEN 1 AND 128
      AND controller_enabled_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_command_digest_sha256 TEXT NOT NULL
    CHECK (
      length(controller_command_digest_sha256) = 64
      AND controller_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_idempotency_key_sha256 TEXT NOT NULL
    CHECK (
      length(gateway_idempotency_key_sha256) = 64
      AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_database_identity_sha256 TEXT NOT NULL
    CHECK (
      length(authority_database_identity_sha256) = 64
      AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_version_id TEXT NOT NULL
    CHECK (
      length(authority_dispatch_version_id) BETWEEN 1 AND 128
      AND authority_dispatch_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  authority_terminal_version_id TEXT NOT NULL
    CHECK (
      length(authority_terminal_version_id) BETWEEN 1 AND 128
      AND authority_terminal_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_five_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_five_id_sha256) = 64
      AND operation_five_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_five_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_five_request_sha256) = 64
      AND operation_five_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_start_receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_start_receipt_digest_sha256) = 64
      AND operation_start_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_start_credential_id_sha256 TEXT NOT NULL
    CHECK (
      length(operation_start_credential_id_sha256) = 64
      AND operation_start_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_start_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_start_request_id_sha256) = 64
      AND operation_start_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admission_confirmation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(admission_confirmation_digest_sha256) = 64
      AND admission_confirmation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_writer_credential_id_sha256 TEXT NOT NULL
    CHECK (
      length(terminal_writer_credential_id_sha256) = 64
      AND terminal_writer_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_writer_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(terminal_writer_request_id_sha256) = 64
      AND terminal_writer_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_command_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(terminal_command_digest_sha256) = 64
      AND terminal_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ledger_head_before_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(ledger_head_before_sha256) = 64
      AND ledger_head_before_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ledger_head_after_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(ledger_head_after_sha256) = 64
      AND ledger_head_after_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_evidence_manifest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(terminal_evidence_manifest_sha256) = 64
      AND terminal_evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND terminal_evidence_manifest_sha256 <> ledger_head_after_sha256
    ),
  generic_receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(generic_receipt_sequence) = 'integer'
      AND generic_receipt_sequence = 5
    ),
  generic_terminal_receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(generic_terminal_receipt_digest_sha256) = 64
      AND generic_terminal_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND generic_terminal_receipt_digest_sha256 =
            ledger_head_after_sha256
    ),
  next_operation_ordinal INTEGER NOT NULL
    CHECK (
      typeof(next_operation_ordinal) = 'integer'
      AND next_operation_ordinal = 6
    ),
  next_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(next_operation_id_sha256) = 64
      AND next_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_execution_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id_sha256, attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_five_send_attempts(
      authorization_id_sha256,
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (attempt_digest_sha256, stable_gateway_event_sequence)
    REFERENCES shard_placement_authority_operation_five_gateway_events(
      attempt_digest_sha256,
      event_sequence
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_start_receipt_digest_sha256)
    REFERENCES shard_placement_authority_execution_receipts(
      receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (generic_terminal_receipt_digest_sha256)
    REFERENCES shard_placement_authority_execution_receipts(
      receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_five_terminal_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_claims AS claim
      JOIN shard_placement_authority_execution_operations AS operation_five
        ON operation_five.authorization_id_sha256 =
             claim.authorization_id_sha256
       AND operation_five.ordinal = 5
      JOIN shard_placement_authority_execution_operations AS operation_six
        ON operation_six.authorization_id_sha256 =
             claim.authorization_id_sha256
       AND operation_six.ordinal = 6
      WHERE claim.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
        AND claim.claim_owner_sha256 = NEW.claim_owner_sha256
        AND claim.lease_owner_sha256 = NEW.lease_owner_sha256
        AND claim.lease_token_sha256 = NEW.lease_token_sha256
        AND claim.lease_generation = NEW.lease_generation
        AND claim.status = 'running'
        AND claim.ledger_version = 4
        AND claim.ledger_head_sha256 = NEW.ledger_head_before_sha256
        AND claim.last_completed_ordinal = 4
        AND claim.inflight_operation_ordinal = 5
        AND claim.inflight_operation_id_sha256 =
              NEW.operation_five_id_sha256
        AND claim.inflight_request_sha256 =
              NEW.operation_five_request_sha256
        AND claim.inflight_started_generation = 1
        AND claim.inflight_started_owner_sha256 =
              NEW.claim_owner_sha256
        AND claim.inflight_started_lease_token_sha256 =
              NEW.lease_token_sha256
        AND claim.inflight_readback_only = 0
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND claim.ticket_activation_confirmed = 1
        AND claim.renewal_count = 0
        AND claim.takeover_count = 0
        AND claim.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND claim.ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND NEW.recorded_at < claim.lease_expires_at
        AND NEW.recorded_at < claim.normal_deadline_at
        AND NEW.recorded_at < claim.permit_expires_at
        AND NEW.recorded_at < claim.recovery_deadline_at
        AND operation_five.operation_id_sha256 =
              NEW.operation_five_id_sha256
        AND operation_five.kind = 'enable_controller_deployment'
        AND operation_five.shard_index IS NULL
        AND operation_six.operation_id_sha256 =
              NEW.next_operation_id_sha256
        AND operation_six.kind = 'probe_shard_readiness'
        AND operation_six.shard_index = 0
        AND NEW.next_operation_ordinal = operation_six.ordinal
        AND NEW.generic_receipt_sequence = claim.ledger_version + 1
        AND NEW.ledger_head_after_sha256 =
              NEW.generic_terminal_receipt_digest_sha256
        AND NOT EXISTS (
          SELECT 1
          FROM shard_placement_authority_revocations AS revocation
          WHERE revocation.authorization_id_sha256 =
                  claim.authorization_id_sha256
            AND revocation.permit_subject_digest_sha256 =
                  claim.permit_subject_digest_sha256
        )
    )
      THEN RAISE(ABORT, 'operation_five_terminal_source_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_attempt_guard
BEFORE INSERT ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_send_attempts AS attempt
      JOIN shard_placement_authority_operation_five_send_attempt_events
        AS send_started
        ON send_started.authorization_id_sha256 =
             attempt.authorization_id_sha256
       AND send_started.attempt_digest_sha256 =
             attempt.attempt_digest_sha256
       AND send_started.event_sequence = 1
      JOIN shard_placement_authority_execution_receipts AS started
        ON started.authorization_id_sha256 =
             attempt.authorization_id_sha256
       AND started.sequence = 4
      JOIN shard_placement_authority_operation_five_admissions AS admission
        ON admission.authorization_id_sha256 =
             attempt.authorization_id_sha256
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND attempt.claim_digest_sha256 = NEW.claim_digest_sha256
        AND attempt.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND attempt.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND attempt.authority_ledger_head_sha256 =
              NEW.ledger_head_before_sha256
        AND attempt.authority_version_id =
              NEW.authority_dispatch_version_id
        AND attempt.authority_version_id =
              NEW.authority_terminal_version_id
        AND attempt.dispatch_owner_sha256 = NEW.claim_owner_sha256
        AND attempt.lease_token_sha256 = NEW.lease_token_sha256
        AND attempt.lease_generation = NEW.lease_generation
        AND attempt.controller_service_name =
              NEW.controller_service_name
        AND attempt.controller_enable_operation_id_sha256 =
              NEW.operation_five_id_sha256
        AND attempt.controller_enabled_version_id =
              NEW.controller_enabled_version_id
        AND attempt.controller_command_digest_sha256 =
              NEW.controller_command_digest_sha256
        AND attempt.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND send_started.event_kind = 'send_started'
        AND send_started.event_digest_sha256 =
              NEW.send_started_event_digest_sha256
        AND started.event_kind = 'operation_started'
        AND started.operation_ordinal = 5
        AND started.operation_id_sha256 =
              NEW.operation_five_id_sha256
        AND started.operation_kind = 'enable_controller_deployment'
        AND started.shard_index IS NULL
        AND started.request_sha256 =
              NEW.operation_five_request_sha256
        AND started.predecessor_receipt_sha256 =
              admission.authority_activation_terminal_receipt_sha256
        AND started.receipt_digest_sha256 =
              NEW.operation_start_receipt_digest_sha256
        AND started.receipt_digest_sha256 =
              NEW.ledger_head_before_sha256
        AND started.receipt_credential_id_sha256 =
              NEW.operation_start_credential_id_sha256
        AND started.request_id_sha256 =
              NEW.operation_start_request_id_sha256
        AND started.evidence_sha256 =
              NEW.admission_confirmation_digest_sha256
        AND started.lease_owner_sha256 = NEW.lease_owner_sha256
        AND started.lease_token_sha256 = NEW.lease_token_sha256
        AND started.lease_generation = NEW.lease_generation
        AND admission.claim_digest_sha256 = NEW.claim_digest_sha256
        AND admission.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND admission.enable_credential_id_sha256 =
              NEW.operation_start_credential_id_sha256
        AND admission.enable_request_id_sha256 =
              NEW.operation_start_request_id_sha256
        AND admission.enable_operation_request_sha256 =
              NEW.operation_five_request_sha256
        AND admission.confirmation_digest_sha256 =
              NEW.admission_confirmation_digest_sha256
        AND admission.operation_start_receipt_digest_sha256 =
              NEW.operation_start_receipt_digest_sha256
    )
      THEN RAISE(ABORT, 'operation_five_terminal_attempt_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_gateway_guard
BEFORE INSERT ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_gateway_events AS stable
      JOIN shard_placement_authority_operation_five_gateway_events
        AS stable_predecessor
        ON stable_predecessor.authorization_id_sha256 =
             stable.authorization_id_sha256
       AND stable_predecessor.attempt_digest_sha256 =
             stable.attempt_digest_sha256
       AND stable_predecessor.event_sequence = stable.event_sequence - 1
      WHERE stable.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND stable.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND stable.event_sequence = NEW.stable_gateway_event_sequence
        AND stable.event_kind = 'gateway_status_stable'
        AND stable.status_classification = 'target_observed'
        AND stable.target_stable = 1
        AND stable.required_matching_observations = 2
        AND stable.stability_minimum_seconds BETWEEN 5 AND 120
        AND stable.event_digest_sha256 =
              NEW.stable_gateway_event_digest_sha256
        AND stable.predecessor_event_digest_sha256 =
              NEW.stable_gateway_predecessor_event_digest_sha256
        AND stable.gateway_request_id_sha256 =
              NEW.stable_gateway_request_id_sha256
        AND stable.gateway_response_sha256 =
              NEW.stable_gateway_response_sha256
        AND stable.gateway_response_bytes =
              NEW.stable_gateway_response_bytes
        AND stable.observation_digest_sha256 =
              NEW.stable_observation_digest_sha256
        AND stable.status_response_request_id_sha256 =
              NEW.stable_status_response_request_id_sha256
        AND stable.gateway_recorded_at =
              NEW.stable_gateway_recorded_at
        AND stable.deployments_http_status BETWEEN 200 AND 299
        AND stable.version_http_status BETWEEN 200 AND 299
        AND stable.deployment_set_sha256 = NEW.deployment_set_sha256
        AND stable.target_version_sha256 = NEW.target_version_sha256
        AND stable.gateway_version_id = NEW.gateway_version_id
        AND stable.controller_command_digest_sha256 =
              NEW.controller_command_digest_sha256
        AND stable.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND stable.recorded_at <= NEW.recorded_at
        AND stable_predecessor.event_digest_sha256 =
              NEW.stable_gateway_predecessor_event_digest_sha256
        AND stable_predecessor.event_kind IN (
              'gateway_status_target',
              'gateway_status_stable'
            )
        AND stable_predecessor.status_classification = 'target_observed'
        AND stable_predecessor.observation_digest_sha256 =
              NEW.stable_observation_digest_sha256
        AND stable_predecessor.deployment_set_sha256 =
              NEW.deployment_set_sha256
        AND stable_predecessor.target_version_sha256 =
              NEW.target_version_sha256
        AND stable_predecessor.gateway_version_id =
              NEW.gateway_version_id
        AND stable.stability_predecessor_observation_digest_sha256 =
              stable_predecessor.observation_digest_sha256
        AND stable.stability_predecessor_recorded_at =
              stable_predecessor.gateway_recorded_at
        AND stable.gateway_recorded_at -
              stable_predecessor.gateway_recorded_at >=
              stable.stability_minimum_seconds
    )
      THEN RAISE(ABORT, 'operation_five_terminal_gateway_mismatch')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_gateway_events AS later
      WHERE later.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND later.event_sequence > NEW.stable_gateway_event_sequence
    )
      THEN RAISE(ABORT, 'operation_five_terminal_gateway_not_head')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_gateway_events AS event
      WHERE event.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND event.gateway_version_id IS NOT NULL
        AND event.gateway_version_id <> NEW.gateway_version_id
    )
      THEN RAISE(ABORT, 'operation_five_terminal_gateway_version_mismatch')
  END;

  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM shard_placement_authority_operation_five_gateway_events AS event
      WHERE event.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND event.event_sequence BETWEEN
              2 AND NEW.stable_gateway_event_sequence
    ) <> NEW.stable_gateway_event_sequence - 1
      THEN RAISE(ABORT, 'operation_five_terminal_gateway_chain_gap')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_send_attempt_events AS event
      WHERE event.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND event.event_sequence = NEW.stable_gateway_event_sequence
        AND event.event_digest_sha256 =
              NEW.stable_gateway_event_digest_sha256
        AND event.event_kind = 'gateway_status_stable'
    )
      THEN RAISE(ABORT, 'operation_five_terminal_gateway_mirror_mismatch')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_send_attempt_events AS event
      WHERE event.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND event.event_sequence > NEW.stable_gateway_event_sequence
    )
      THEN RAISE(ABORT, 'operation_five_terminal_send_chain_not_head')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_digest_guard
BEFORE INSERT ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.terminal_evidence_manifest_sha256 =
           NEW.generic_terminal_receipt_digest_sha256
      THEN RAISE(ABORT, 'operation_five_terminal_digest_alias')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_project
AFTER INSERT ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  INSERT INTO shard_placement_authority_execution_receipts (
    authorization_id_sha256,
    sequence,
    event_kind,
    claim_digest_sha256,
    execution_plan_sha256,
    ledger_identity_sha256,
    operation_ordinal,
    operation_id_sha256,
    operation_kind,
    shard_index,
    predecessor_receipt_sha256,
    request_sha256,
    response_sha256,
    cloudflare_request_id_sha256,
    evidence_sha256,
    safety_reason,
    outcome,
    lease_owner_sha256,
    lease_token_sha256,
    lease_generation,
    lease_expires_at,
    receipt_credential_id_sha256,
    request_id_sha256,
    receipt_digest_sha256,
    recorded_at
  )
  SELECT
    NEW.authorization_id_sha256,
    NEW.generic_receipt_sequence,
    'operation_terminal',
    NEW.claim_digest_sha256,
    claim.execution_plan_sha256,
    NEW.authority_ledger_identity_sha256,
    5,
    NEW.operation_five_id_sha256,
    'enable_controller_deployment',
    NULL,
    NEW.ledger_head_before_sha256,
    NEW.operation_five_request_sha256,
    NEW.terminal_evidence_manifest_sha256,
    NEW.stable_status_response_request_id_sha256,
    NEW.admission_confirmation_digest_sha256,
    NULL,
    'exact_success',
    NEW.lease_owner_sha256,
    NEW.lease_token_sha256,
    NEW.lease_generation,
    claim.lease_expires_at,
    NEW.operation_start_credential_id_sha256,
    NEW.operation_start_request_id_sha256,
    NEW.generic_terminal_receipt_digest_sha256,
    NEW.recorded_at
  FROM shard_placement_authority_execution_claims AS claim
  WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_claims AS claim
      WHERE claim.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND claim.status = 'running'
        AND claim.ledger_version = 5
        AND claim.ledger_head_sha256 =
              NEW.generic_terminal_receipt_digest_sha256
        AND claim.last_completed_ordinal = 5
        AND claim.inflight_operation_ordinal IS NULL
        AND claim.inflight_operation_id_sha256 IS NULL
        AND claim.inflight_request_sha256 IS NULL
        AND claim.inflight_cloudflare_request_id_sha256 IS NULL
        AND claim.inflight_started_generation IS NULL
        AND claim.inflight_started_owner_sha256 IS NULL
        AND claim.inflight_started_lease_token_sha256 IS NULL
        AND claim.inflight_readback_only = 0
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
    )
      THEN RAISE(ABORT, 'operation_five_terminal_projection_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_gateway_closed_guard
BEFORE INSERT ON shard_placement_authority_operation_five_gateway_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM shard_placement_authority_operation_five_terminals AS terminal
  WHERE terminal.authorization_id_sha256 = NEW.authorization_id_sha256
    AND terminal.attempt_digest_sha256 = NEW.attempt_digest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'operation_five_gateway_chain_closed');
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_terminal');
END;

CREATE TRIGGER
  shard_placement_authority_operation_five_terminal_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_five_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_terminal');
END;
