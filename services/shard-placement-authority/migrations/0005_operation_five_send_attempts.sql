CREATE TABLE shard_placement_authority_operation_five_send_attempts (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  attempt_contract TEXT NOT NULL
    CHECK (
      attempt_contract =
        'cinatoken-shard-placement-authority-operation-five-send-attempt-v1'
    ),
  attempt_generation INTEGER NOT NULL
    CHECK (
      typeof(attempt_generation) = 'integer'
      AND attempt_generation = 1
    ),
  retry_count INTEGER NOT NULL
    CHECK (typeof(retry_count) = 'integer' AND retry_count = 0),
  retry_limit INTEGER NOT NULL
    CHECK (typeof(retry_limit) = 'integer' AND retry_limit = 0),
  send_attempt_limit INTEGER NOT NULL
    CHECK (
      typeof(send_attempt_limit) = 'integer'
      AND send_attempt_limit = 1
    ),
  send_authority_state TEXT NOT NULL
    CHECK (send_authority_state = 'granted'),
  claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_dispatch_claim_digest_sha256) = 'text'
      AND length(authority_dispatch_claim_digest_sha256) = 64
      AND authority_dispatch_claim_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  dispatch_consumption_receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(dispatch_consumption_receipt_digest_sha256) = 'text'
      AND length(dispatch_consumption_receipt_digest_sha256) = 64
      AND dispatch_consumption_receipt_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_dispatch_consumption_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_dispatch_consumption_digest_sha256) = 'text'
      AND length(application_dispatch_consumption_digest_sha256) = 64
      AND application_dispatch_consumption_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_ticket_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_ticket_id_sha256) = 'text'
      AND length(application_ticket_id_sha256) = 64
      AND application_ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  application_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_database_identity_sha256) = 'text'
      AND length(application_database_identity_sha256) = 64
      AND application_database_identity_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_version_id TEXT NOT NULL
    CHECK (
      typeof(application_version_id) = 'text'
      AND length(application_version_id) BETWEEN 1 AND 128
      AND application_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  authority_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_database_identity_sha256) = 'text'
      AND length(authority_database_identity_sha256) = 64
      AND authority_database_identity_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_head_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_head_sha256) = 'text'
      AND length(authority_ledger_head_sha256) = 64
      AND authority_ledger_head_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_version_id TEXT NOT NULL
    CHECK (
      typeof(authority_version_id) = 'text'
      AND length(authority_version_id) BETWEEN 1 AND 128
      AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  dispatch_owner_sha256 TEXT NOT NULL
    CHECK (
      typeof(dispatch_owner_sha256) = 'text'
      AND length(dispatch_owner_sha256) = 64
      AND dispatch_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token_sha256 TEXT NOT NULL
    CHECK (
      typeof(lease_token_sha256) = 'text'
      AND length(lease_token_sha256) = 64
      AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_generation INTEGER NOT NULL
    CHECK (
      typeof(lease_generation) = 'integer'
      AND lease_generation = 1
    ),
  controller_service_name TEXT NOT NULL
    CHECK (
      typeof(controller_service_name) = 'text'
      AND length(controller_service_name) BETWEEN 1 AND 128
      AND controller_service_name NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_enable_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(controller_enable_operation_id_sha256) = 'text'
      AND length(controller_enable_operation_id_sha256) = 64
      AND controller_enable_operation_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  controller_baseline_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_baseline_version_id) = 'text'
      AND length(controller_baseline_version_id) BETWEEN 1 AND 128
      AND controller_baseline_version_id
        NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_enabled_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_enabled_version_id) = 'text'
      AND length(controller_enabled_version_id) BETWEEN 1 AND 128
      AND controller_enabled_version_id
        NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND controller_enabled_version_id <> controller_baseline_version_id
    ),
  controller_command_contract TEXT NOT NULL
    CHECK (
      controller_command_contract =
        'cinatoken-controller-deployment-gateway-enable-command-v1'
    ),
  controller_command_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(controller_command_digest_sha256) = 'text'
      AND length(controller_command_digest_sha256) = 64
      AND controller_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_idempotency_contract TEXT NOT NULL
    CHECK (
      gateway_idempotency_contract =
        'cinatoken-controller-deployment-gateway-idempotency-v1'
    ),
  gateway_idempotency_key_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(gateway_idempotency_key_sha256) = 'text'
      AND length(gateway_idempotency_key_sha256) = 64
      AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  send_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(send_credential_id_sha256) = 'text'
      AND length(send_credential_id_sha256) = 64
      AND send_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  send_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(send_request_id_sha256) = 'text'
      AND length(send_request_id_sha256) = 64
      AND send_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  command_send_attempt_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(command_send_attempt_request_id_sha256) = 'text'
      AND length(command_send_attempt_request_id_sha256) = 64
      AND command_send_attempt_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  controller_request_sent INTEGER NOT NULL
    CHECK (
      typeof(controller_request_sent) = 'integer'
      AND controller_request_sent = 0
    ),
  gateway_request_sent INTEGER NOT NULL
    CHECK (
      typeof(gateway_request_sent) = 'integer'
      AND gateway_request_sent = 0
    ),
  attempt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(attempt_digest_sha256) = 'text'
      AND length(attempt_digest_sha256) = 64
      AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  UNIQUE (authorization_id_sha256, attempt_digest_sha256),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_operation_five_dispatch_consumptions(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_source_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_dispatch_consumptions
        AS consumption
      JOIN shard_placement_authority_operation_five_dispatch_claims
        AS dispatch_claim
        ON dispatch_claim.authorization_id_sha256 =
             consumption.authorization_id_sha256
      WHERE consumption.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND consumption.claim_digest_sha256 =
              NEW.claim_digest_sha256
        AND consumption.authority_dispatch_claim_digest_sha256 =
              NEW.authority_dispatch_claim_digest_sha256
        AND consumption.receipt_digest_sha256 =
              NEW.dispatch_consumption_receipt_digest_sha256
        AND consumption.application_dispatch_consumption_digest_sha256 =
              NEW.application_dispatch_consumption_digest_sha256
        AND consumption.application_ticket_id_sha256 =
              NEW.application_ticket_id_sha256
        AND consumption.campaign_id = NEW.campaign_id
        AND dispatch_claim.dispatch_claim_digest_sha256 =
              NEW.authority_dispatch_claim_digest_sha256
        AND dispatch_claim.claim_digest_sha256 = NEW.claim_digest_sha256
        AND dispatch_claim.application_ticket_id_sha256 =
              NEW.application_ticket_id_sha256
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_source_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_clock_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.created_at <> unixepoch()
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_clock_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_identity_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_dispatch_consumptions
        AS consumption
      WHERE consumption.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND consumption.application_database_identity_sha256 =
              NEW.application_database_identity_sha256
        AND consumption.application_version_id =
              NEW.application_version_id
        AND consumption.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND consumption.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND consumption.authority_ledger_head_sha256 =
              NEW.authority_ledger_head_sha256
        AND consumption.authority_version_id =
              NEW.authority_version_id
        AND consumption.dispatch_owner_sha256 =
              NEW.dispatch_owner_sha256
        AND consumption.lease_token_sha256 =
              NEW.lease_token_sha256
        AND consumption.lease_generation = NEW.lease_generation
        AND consumption.controller_service_name =
              NEW.controller_service_name
        AND consumption.controller_enable_operation_id_sha256 =
              NEW.controller_enable_operation_id_sha256
        AND consumption.controller_baseline_version_id =
              NEW.controller_baseline_version_id
        AND consumption.controller_enabled_version_id =
              NEW.controller_enabled_version_id
        AND consumption.send_attempt_limit = NEW.send_attempt_limit
        AND consumption.retry_limit = NEW.retry_limit
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_identity_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_live_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_dispatch_consumption_recoveries
      WHERE authorization_id_sha256 = NEW.authorization_id_sha256
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_recovered_consumption_forbidden'
      )
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM shard_placement_authority_revocations
      WHERE authorization_id_sha256 = NEW.authorization_id_sha256
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_revoked'
      )
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_claims AS claim
      JOIN shard_placement_authority_operation_five_dispatch_consumptions
        AS consumption
        ON consumption.authorization_id_sha256 =
             claim.authorization_id_sha256
      WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
        AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
        AND claim.status = 'running'
        AND claim.ledger_version = 4
        AND claim.ledger_head_sha256 =
              NEW.authority_ledger_head_sha256
        AND claim.last_completed_ordinal = 4
        AND claim.inflight_operation_ordinal = 5
        AND claim.inflight_operation_id_sha256 =
              NEW.controller_enable_operation_id_sha256
        AND claim.inflight_readback_only = 0
        AND claim.enable_intent_seen = 1
        AND claim.disable_confirmed = 0
        AND claim.application_ticket_id_sha256 =
              NEW.application_ticket_id_sha256
        AND claim.application_database_identity_sha256 =
              NEW.application_database_identity_sha256
        AND claim.authority_database_identity_sha256 =
              NEW.authority_database_identity_sha256
        AND claim.ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND claim.claim_owner_sha256 = NEW.dispatch_owner_sha256
        AND claim.lease_owner_sha256 = NEW.dispatch_owner_sha256
        AND claim.lease_token_sha256 = NEW.lease_token_sha256
        AND claim.lease_generation = NEW.lease_generation
        AND claim.renewal_count = 0
        AND claim.takeover_count = 0
        AND claim.lease_expires_at = consumption.lease_expires_at
        AND claim.normal_deadline_at = consumption.normal_deadline_at
        AND claim.permit_expires_at = consumption.permit_expires_at
        AND claim.lease_expires_at > unixepoch() + 30
        AND claim.normal_deadline_at > unixepoch() + 30
        AND claim.permit_expires_at > unixepoch() + 30
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_not_live'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_send_attempt');
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_five_send_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_send_attempt');
END;

CREATE TABLE shard_placement_authority_operation_five_send_attempt_events (
  authorization_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  attempt_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(attempt_digest_sha256) = 'text'
      AND length(attempt_digest_sha256) = 64
      AND attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  event_sequence INTEGER NOT NULL
    CHECK (
      typeof(event_sequence) = 'integer'
      AND event_sequence BETWEEN 1 AND 9007199254740991
    ),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  event_contract TEXT NOT NULL
    CHECK (
      event_contract =
        'cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1'
    ),
  event_kind TEXT NOT NULL
    CHECK (
      typeof(event_kind) = 'text'
      AND length(event_kind) BETWEEN 1 AND 64
      AND event_kind NOT GLOB '*[^a-z0-9_]*'
    ),
  from_state TEXT NOT NULL
    CHECK (
      typeof(from_state) = 'text'
      AND length(from_state) BETWEEN 1 AND 64
      AND from_state NOT GLOB '*[^a-z0-9_]*'
    ),
  to_state TEXT NOT NULL
    CHECK (
      typeof(to_state) = 'text'
      AND length(to_state) BETWEEN 1 AND 64
      AND to_state NOT GLOB '*[^a-z0-9_]*'
    ),
  event_semantics TEXT NOT NULL
    CHECK (
      typeof(event_semantics) = 'text'
      AND length(event_semantics) BETWEEN 1 AND 128
      AND event_semantics NOT GLOB '*[^a-z0-9_]*'
    ),
  predecessor_event_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_event_digest_sha256) = 'text'
      AND length(predecessor_event_digest_sha256) = 64
      AND predecessor_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  dispatch_consumption_receipt_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(dispatch_consumption_receipt_digest_sha256) = 'text'
      AND length(dispatch_consumption_receipt_digest_sha256) = 64
      AND dispatch_consumption_receipt_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  controller_command_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(controller_command_digest_sha256) = 'text'
      AND length(controller_command_digest_sha256) = 64
      AND controller_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_idempotency_key_sha256 TEXT NOT NULL
    CHECK (
      typeof(gateway_idempotency_key_sha256) = 'text'
      AND length(gateway_idempotency_key_sha256) = 64
      AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_request_sent INTEGER NOT NULL
    CHECK (
      typeof(controller_request_sent) = 'integer'
      AND controller_request_sent IN (0, 1)
    ),
  gateway_request_sent INTEGER NOT NULL
    CHECK (
      typeof(gateway_request_sent) = 'integer'
      AND gateway_request_sent IN (0, 1)
    ),
  event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(event_digest_sha256) = 'text'
      AND length(event_digest_sha256) = 64
      AND event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (attempt_digest_sha256, event_sequence),
  UNIQUE (authorization_id_sha256, event_sequence),
  FOREIGN KEY (authorization_id_sha256, attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_five_send_attempts(
      authorization_id_sha256,
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_event_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempt_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.event_sequence <> 1
      OR NEW.event_kind <> 'send_started'
      OR NEW.from_state <> 'consumption_receipted'
      OR NEW.to_state <> 'send_started'
      OR NEW.event_semantics <>
           'unique_send_authority_persisted_network_may_not_have_occurred'
      OR NEW.predecessor_event_digest_sha256 <>
           '0000000000000000000000000000000000000000000000000000000000000000'
      OR NEW.controller_request_sent <> 0
      OR NEW.gateway_request_sent <> 0
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_initial_event_mismatch'
      )
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_send_attempts AS attempt
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND attempt.dispatch_consumption_receipt_digest_sha256 =
              NEW.dispatch_consumption_receipt_digest_sha256
        AND attempt.controller_command_digest_sha256 =
              NEW.controller_command_digest_sha256
        AND attempt.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND attempt.controller_request_sent = NEW.controller_request_sent
        AND attempt.gateway_request_sent = NEW.gateway_request_sent
        AND attempt.created_at <= NEW.recorded_at
    )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_event_source_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_event_clock_guard
BEFORE INSERT ON shard_placement_authority_operation_five_send_attempt_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_event_clock_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_event_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_five_send_attempt_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_send_attempt_event');
END;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_event_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_five_send_attempt_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_send_attempt_event');
END;
