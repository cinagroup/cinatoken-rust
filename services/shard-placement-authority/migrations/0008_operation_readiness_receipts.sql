CREATE TABLE shard_placement_authority_operation_readiness_attempts (
  authorization_id_sha256 TEXT NOT NULL,
  operation_ordinal INTEGER NOT NULL,
  shard_index INTEGER NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  attempt_contract TEXT NOT NULL
    CHECK (
      attempt_contract =
        'cinatoken-shard-placement-authority-operation-readiness-attempt-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL,
  claim_owner_sha256 TEXT NOT NULL,
  lease_owner_sha256 TEXT NOT NULL,
  lease_token_sha256 TEXT NOT NULL,
  lease_generation INTEGER NOT NULL
    CHECK (lease_generation = 1),
  execution_plan_sha256 TEXT NOT NULL,
  operation_schedule_sha256 TEXT NOT NULL,
  authority_database_identity_sha256 TEXT NOT NULL,
  authority_ledger_identity_sha256 TEXT NOT NULL,
  ledger_head_before_sha256 TEXT NOT NULL,
  predecessor_receipt_sha256 TEXT NOT NULL,
  operation_five_terminal_receipt_sha256 TEXT NOT NULL,
  operation_id_sha256 TEXT NOT NULL,
  operation_request_sha256 TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_nonce_sha256 TEXT NOT NULL,
  ring_generation INTEGER NOT NULL
    CHECK (ring_generation > 0),
  shard_count INTEGER NOT NULL
    CHECK (shard_count = 8),
  instance_name TEXT NOT NULL,
  controller_service_name TEXT NOT NULL,
  controller_enabled_version_id TEXT NOT NULL,
  runtime_build_id TEXT NOT NULL,
  probe_id_sha256 TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL
    CHECK (attempt_generation = 1),
  dispatch_mode TEXT NOT NULL
    CHECK (dispatch_mode = 'wake_once'),
  wake_attempt_limit INTEGER NOT NULL
    CHECK (wake_attempt_limit = 1),
  wake_retry_limit INTEGER NOT NULL
    CHECK (wake_retry_limit = 0),
  missing_readback_allows_resend INTEGER NOT NULL
    CHECK (missing_readback_allows_resend = 0),
  probe_deadline_at_ms INTEGER NOT NULL,
  authority_version_id TEXT NOT NULL,
  send_credential_id_sha256 TEXT NOT NULL,
  send_request_id_sha256 TEXT NOT NULL,
  attempt_digest_sha256 TEXT NOT NULL UNIQUE,
  operation_start_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (authorization_id_sha256, operation_ordinal),
  UNIQUE (authorization_id_sha256, shard_index),
  UNIQUE (authorization_id_sha256, operation_id_sha256),
  UNIQUE (authorization_id_sha256, probe_id_sha256),
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
  FOREIGN KEY (operation_start_receipt_digest_sha256)
    REFERENCES shard_placement_authority_execution_receipts(
      receipt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (operation_ordinal BETWEEN 6 AND 13),
  CHECK (shard_index = operation_ordinal - 6),
  CHECK (length(instance_name) BETWEEN 1 AND 128),
  CHECK (
    instance_name NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    probe_deadline_at_ms > 0
    AND probe_deadline_at_ms % 1000 = 0
  ),
  CHECK (
    length(controller_service_name) BETWEEN 1 AND 128
    AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(controller_enabled_version_id) BETWEEN 1 AND 128
    AND controller_enabled_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(authority_version_id) BETWEEN 1 AND 128
    AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(runtime_build_id) = 64
    AND runtime_build_id NOT GLOB '*[^0-9a-f]*'
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
    AND length(predecessor_receipt_sha256) = 64
    AND predecessor_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_five_terminal_receipt_sha256) = 64
    AND operation_five_terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_request_sha256) = 64
    AND operation_request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(campaign_id) = 64
    AND campaign_id NOT GLOB '*[^0-9a-f]*'
    AND length(campaign_nonce_sha256) = 64
    AND campaign_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(probe_id_sha256) = 64
    AND probe_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(send_credential_id_sha256) = 64
    AND send_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(send_request_id_sha256) = 64
    AND send_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_digest_sha256) = 64
    AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_start_receipt_digest_sha256) = 64
    AND operation_start_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_attempt_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_readiness_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_readiness_attempt_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_claims AS claim
      JOIN shard_placement_authority_execution_operations AS operation
        ON operation.authorization_id_sha256 =
             claim.authorization_id_sha256
       AND operation.ordinal = NEW.operation_ordinal
      JOIN shard_placement_authority_operation_five_terminals AS enabled
        ON enabled.authorization_id_sha256 =
             claim.authorization_id_sha256
      JOIN shard_placement_authority_issuances AS issuance
        ON issuance.authorization_id_sha256 =
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
        AND claim.ledger_head_sha256 = NEW.ledger_head_before_sha256
        AND NEW.predecessor_receipt_sha256 =
              claim.ledger_head_sha256
        AND claim.status = 'running'
        AND claim.ledger_version = (2 * NEW.operation_ordinal) - 7
        AND claim.last_completed_ordinal =
              NEW.operation_ordinal - 1
        AND claim.inflight_operation_ordinal IS NULL
        AND claim.inflight_readback_only = 0
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND claim.ticket_activation_confirmed = 1
        AND claim.renewal_count = 0
        AND claim.takeover_count = 0
        AND NEW.recorded_at < claim.lease_expires_at
        AND NEW.recorded_at < claim.normal_deadline_at
        AND NEW.recorded_at < claim.permit_expires_at
        AND NEW.probe_deadline_at_ms >
              (NEW.recorded_at * 1000)
        AND NEW.probe_deadline_at_ms <=
              (claim.normal_deadline_at * 1000)
        AND NEW.probe_deadline_at_ms <=
              ((NEW.recorded_at + 60) * 1000)
        AND claim.campaign_id = NEW.campaign_id
        AND claim.campaign_nonce_sha256 =
              NEW.campaign_nonce_sha256
        AND operation.operation_id_sha256 =
              NEW.operation_id_sha256
        AND operation.kind = 'probe_shard_readiness'
        AND operation.shard_index = NEW.shard_index
        AND enabled.generic_terminal_receipt_digest_sha256 =
              NEW.operation_five_terminal_receipt_sha256
        AND enabled.controller_service_name =
              NEW.controller_service_name
        AND enabled.controller_enabled_version_id =
              NEW.controller_enabled_version_id
        AND issuance.controller_service_name =
              NEW.controller_service_name
        AND issuance.runtime_build_id = NEW.runtime_build_id
        AND issuance.ring_generation = NEW.ring_generation
        AND issuance.shard_count = NEW.shard_count
        AND NEW.instance_name = printf(
              'cinatoken-relay-shard-v1-%04d',
              NEW.shard_index
            )
        AND NOT EXISTS (
          SELECT 1
          FROM shard_placement_authority_revocations AS revocation
          WHERE revocation.authorization_id_sha256 =
                  claim.authorization_id_sha256
            AND revocation.permit_subject_digest_sha256 =
                  claim.permit_subject_digest_sha256
        )
    )
      THEN RAISE(ABORT, 'operation_readiness_attempt_source_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_attempt_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_readiness_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_readiness_attempt');
END;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_attempt_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_readiness_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_preserved_operation_readiness_attempt');
END;

CREATE TABLE shard_placement_authority_operation_readiness_terminals (
  authorization_id_sha256 TEXT NOT NULL,
  operation_ordinal INTEGER NOT NULL,
  shard_index INTEGER NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (contract_version = 1),
  terminal_contract TEXT NOT NULL
    CHECK (
      terminal_contract =
        'cinatoken-shard-placement-authority-operation-readiness-terminal-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL,
  attempt_digest_sha256 TEXT NOT NULL UNIQUE,
  operation_id_sha256 TEXT NOT NULL,
  probe_id_sha256 TEXT NOT NULL,
  operation_request_sha256 TEXT NOT NULL,
  operation_start_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
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
  controller_service_name TEXT NOT NULL,
  expected_controller_version_id TEXT NOT NULL,
  observed_controller_version_id TEXT,
  expected_runtime_build_id TEXT NOT NULL,
  observed_runtime_build_id TEXT,
  readiness_result_code TEXT,
  process_ready INTEGER
    CHECK (process_ready IN (0, 1) OR process_ready IS NULL),
  execution_ready INTEGER
    CHECK (execution_ready IN (0, 1) OR execution_ready IS NULL),
  runtime_execution_enabled INTEGER
    CHECK (
      runtime_execution_enabled IN (0, 1)
      OR runtime_execution_enabled IS NULL
    ),
  controller_execution_enabled INTEGER
    CHECK (
      controller_execution_enabled IN (0, 1)
      OR controller_execution_enabled IS NULL
    ),
  container_state TEXT,
  readiness_result_sha256 TEXT,
  controller_response_sha256 TEXT NOT NULL,
  controller_response_bytes INTEGER NOT NULL
    CHECK (controller_response_bytes BETWEEN 1 AND 16384),
  controller_request_id_sha256 TEXT NOT NULL,
  terminal_writer_credential_id_sha256 TEXT NOT NULL,
  terminal_writer_request_id_sha256 TEXT NOT NULL,
  terminal_authority_version_id TEXT NOT NULL,
  terminal_evidence_sha256 TEXT NOT NULL UNIQUE,
  generic_terminal_receipt_digest_sha256 TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (authorization_id_sha256, operation_ordinal),
  FOREIGN KEY (authorization_id_sha256, operation_ordinal)
    REFERENCES shard_placement_authority_operation_readiness_attempts(
      authorization_id_sha256,
      operation_ordinal
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
  CHECK (operation_ordinal BETWEEN 6 AND 13),
  CHECK (shard_index = operation_ordinal - 6),
  CHECK (
    length(controller_service_name) BETWEEN 1 AND 128
    AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    length(expected_controller_version_id) BETWEEN 1 AND 128
    AND expected_controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    observed_controller_version_id IS NULL
    OR (
      length(observed_controller_version_id) BETWEEN 1 AND 128
      AND observed_controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  CHECK (
    length(expected_runtime_build_id) = 64
    AND expected_runtime_build_id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    observed_runtime_build_id IS NULL
    OR (
      length(observed_runtime_build_id) = 64
      AND observed_runtime_build_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    readiness_result_sha256 IS NULL
    OR (
      length(readiness_result_sha256) = 64
      AND readiness_result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    length(authorization_id_sha256) = 64
    AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(attempt_digest_sha256) = 64
    AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(probe_id_sha256) = 64
    AND probe_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_request_sha256) = 64
    AND operation_request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_start_receipt_digest_sha256) = 64
    AND operation_start_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(controller_response_sha256) = 64
    AND controller_response_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(controller_request_id_sha256) = 64
    AND controller_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_writer_credential_id_sha256) = 64
    AND terminal_writer_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_writer_request_id_sha256) = 64
    AND terminal_writer_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(terminal_evidence_sha256) = 64
    AND terminal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(generic_terminal_receipt_digest_sha256) = 64
    AND generic_terminal_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(terminal_authority_version_id) BETWEEN 1 AND 128
    AND terminal_authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CHECK (
    result_outcome NOT IN ('exact_success', 'ambiguous_recovered')
    OR (
      observed_controller_version_id = expected_controller_version_id
      AND observed_runtime_build_id = expected_runtime_build_id
      AND readiness_result_code =
            'process_ready_execution_disabled'
      AND process_ready = 1
      AND execution_ready = 0
      AND runtime_execution_enabled = 0
      AND controller_execution_enabled = 0
      AND container_state = 'healthy'
      AND readiness_result_sha256 IS NOT NULL
    )
  )
) WITHOUT ROWID;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_terminal_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_readiness_terminals
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(ABORT, 'operation_readiness_terminal_clock_mismatch')
  END;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_readiness_attempts AS attempt
      JOIN shard_placement_authority_execution_claims AS claim
        ON claim.authorization_id_sha256 =
             attempt.authorization_id_sha256
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.operation_ordinal = NEW.operation_ordinal
        AND attempt.shard_index = NEW.shard_index
        AND attempt.claim_digest_sha256 = NEW.claim_digest_sha256
        AND attempt.attempt_digest_sha256 =
              NEW.attempt_digest_sha256
        AND attempt.operation_id_sha256 =
              NEW.operation_id_sha256
        AND attempt.probe_id_sha256 = NEW.probe_id_sha256
        AND attempt.operation_request_sha256 =
              NEW.operation_request_sha256
        AND attempt.operation_start_receipt_digest_sha256 =
              NEW.operation_start_receipt_digest_sha256
        AND attempt.controller_service_name =
              NEW.controller_service_name
        AND attempt.controller_enabled_version_id =
              NEW.expected_controller_version_id
        AND attempt.runtime_build_id =
              NEW.expected_runtime_build_id
        AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
        AND claim.status IN ('running', 'disable_required')
        AND claim.ledger_version =
              (2 * NEW.operation_ordinal) - 6
        AND claim.last_completed_ordinal =
              NEW.operation_ordinal - 1
        AND claim.inflight_operation_ordinal =
              NEW.operation_ordinal
        AND claim.inflight_operation_id_sha256 =
              NEW.operation_id_sha256
        AND claim.inflight_request_sha256 =
              NEW.operation_request_sha256
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND NEW.recorded_at < claim.lease_expires_at
        AND NEW.recorded_at < claim.recovery_deadline_at
        AND (
          (
            claim.inflight_readback_only = 0
            AND claim.status = 'running'
          )
          OR (
            claim.inflight_readback_only = 1
            AND claim.status = 'disable_required'
            AND NEW.result_outcome IN (
              'ambiguous_recovered',
              'unresolved'
            )
          )
        )
        AND (
          NEW.recovery_mode = 'readback_only'
          OR NEW.result_outcome <> 'ambiguous_recovered'
        )
    )
      THEN RAISE(ABORT, 'operation_readiness_terminal_source_mismatch')
  END;
END;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_terminal_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_readiness_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_readiness_terminal');
END;

CREATE TRIGGER
  shard_placement_authority_operation_readiness_terminal_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_readiness_terminals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'append_preserved_operation_readiness_terminal');
END;
