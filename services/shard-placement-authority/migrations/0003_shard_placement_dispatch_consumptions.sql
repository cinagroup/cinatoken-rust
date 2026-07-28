CREATE TABLE shard_placement_authority_operation_five_dispatch_consumptions (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  receipt_contract TEXT NOT NULL
    CHECK (
      receipt_contract =
        'cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1'
    ),
  claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
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
  application_grant_receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_grant_receipt_digest_sha256) = 'text'
      AND length(application_grant_receipt_digest_sha256) = 64
      AND application_grant_receipt_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_grant_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_grant_digest_sha256) = 'text'
      AND length(application_grant_digest_sha256) = 64
      AND application_grant_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_outbox_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_dispatch_outbox_digest_sha256) = 'text'
      AND length(authority_dispatch_outbox_digest_sha256) = 64
      AND authority_dispatch_outbox_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  operation_five_start_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_five_start_receipt_sha256) = 'text'
      AND length(operation_five_start_receipt_sha256) = 64
      AND operation_five_start_receipt_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_dispatch_claim_digest_sha256) = 'text'
      AND length(authority_dispatch_claim_digest_sha256) = 64
      AND authority_dispatch_claim_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
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
  authority_ledger_head_sha256 TEXT NOT NULL UNIQUE
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
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at > 0),
  normal_deadline_at INTEGER NOT NULL
    CHECK (typeof(normal_deadline_at) = 'integer' AND normal_deadline_at > 0),
  permit_expires_at INTEGER NOT NULL
    CHECK (typeof(permit_expires_at) = 'integer' AND permit_expires_at > 0),
  dispatch_claim_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(dispatch_claim_credential_id_sha256) = 'text'
      AND length(dispatch_claim_credential_id_sha256) = 64
      AND dispatch_claim_credential_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  dispatch_claim_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(dispatch_claim_request_id_sha256) = 'text'
      AND length(dispatch_claim_request_id_sha256) = 64
      AND dispatch_claim_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  command_dispatch_claim_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(command_dispatch_claim_request_id_sha256) = 'text'
      AND length(command_dispatch_claim_request_id_sha256) = 64
      AND command_dispatch_claim_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_claimed_at INTEGER NOT NULL
    CHECK (
      typeof(authority_dispatch_claimed_at) = 'integer'
      AND authority_dispatch_claimed_at > 0
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
      AND controller_baseline_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_enabled_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_enabled_version_id) = 'text'
      AND length(controller_enabled_version_id) BETWEEN 1 AND 128
      AND controller_enabled_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND controller_enabled_version_id <> controller_baseline_version_id
    ),
  send_attempt_limit INTEGER NOT NULL
    CHECK (
      typeof(send_attempt_limit) = 'integer'
      AND send_attempt_limit = 1
    ),
  retry_limit INTEGER NOT NULL
    CHECK (
      typeof(retry_limit) = 'integer'
      AND retry_limit = 0
    ),
  missing_readback_allows_resend INTEGER NOT NULL
    CHECK (
      typeof(missing_readback_allows_resend) = 'integer'
      AND missing_readback_allows_resend = 0
    ),
  application_dispatch_consumption_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_dispatch_consumption_digest_sha256) = 'text'
      AND length(application_dispatch_consumption_digest_sha256) = 64
      AND application_dispatch_consumption_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_dispatch_consumption_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_dispatch_consumption_credential_id_sha256) = 'text'
      AND length(application_dispatch_consumption_credential_id_sha256) = 64
      AND application_dispatch_consumption_credential_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_dispatch_consumption_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_dispatch_consumption_request_id_sha256) = 'text'
      AND length(application_dispatch_consumption_request_id_sha256) = 64
      AND application_dispatch_consumption_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  command_dispatch_consumption_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(command_dispatch_consumption_request_id_sha256) = 'text'
      AND length(command_dispatch_consumption_request_id_sha256) = 64
      AND command_dispatch_consumption_request_id_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_consumption_state TEXT NOT NULL
    CHECK (application_consumption_state = 'consumed'),
  application_consumed_at INTEGER NOT NULL
    CHECK (
      typeof(application_consumed_at) = 'integer'
      AND application_consumed_at > 0
      AND authority_dispatch_claimed_at <= application_consumed_at
    ),
  application_response_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_response_sha256) = 'text'
      AND length(application_response_sha256) = 64
      AND application_response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_response_bytes INTEGER NOT NULL
    CHECK (
      typeof(application_response_bytes) = 'integer'
      AND application_response_bytes BETWEEN 1 AND 65536
    ),
  consume_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(consume_credential_id_sha256) = 'text'
      AND length(consume_credential_id_sha256) = 64
      AND consume_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  consume_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(consume_request_id_sha256) = 'text'
      AND length(consume_request_id_sha256) = 64
      AND consume_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  command_consume_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(command_consume_request_id_sha256) = 'text'
      AND length(command_consume_request_id_sha256) = 64
      AND command_consume_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(receipt_digest_sha256) = 'text'
      AND length(receipt_digest_sha256) = 64
      AND receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  CHECK (
    lease_expires_at <= normal_deadline_at
    AND normal_deadline_at <= permit_expires_at
  ),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_operation_five_dispatch_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER shard_placement_authority_operation_five_dispatch_consumption_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_five_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'placement operation-five dispatch consumption time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    JOIN shard_placement_authority_execution_receipts AS started
      ON started.authorization_id_sha256 =
           claim.authorization_id_sha256
     AND started.sequence = 4
     AND started.event_kind = 'operation_started'
     AND started.operation_ordinal = 5
    JOIN shard_placement_authority_issuances AS issuance
      ON issuance.authorization_id_sha256 =
           claim.authorization_id_sha256
     AND issuance.permit_subject_digest_sha256 =
           claim.permit_subject_digest_sha256
    LEFT JOIN shard_placement_authority_revocations AS revocation
      ON revocation.authorization_id_sha256 =
           claim.authorization_id_sha256
     AND revocation.permit_subject_digest_sha256 =
           claim.permit_subject_digest_sha256
    WHERE claim.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
      AND claim.application_ticket_id_sha256 =
            NEW.application_ticket_id_sha256
      AND claim.campaign_id = NEW.campaign_id
      AND claim.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND claim.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND claim.ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND claim.status = 'running'
      AND claim.ledger_version = 4
      AND claim.ledger_head_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND claim.ledger_head_sha256 =
            NEW.authority_ledger_head_sha256
      AND claim.last_completed_ordinal = 4
      AND claim.inflight_operation_ordinal = 5
      AND claim.inflight_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND claim.inflight_operation_id_sha256 =
            started.operation_id_sha256
      AND claim.inflight_request_sha256 = started.request_sha256
      AND claim.inflight_readback_only = 0
      AND claim.enable_intent_seen = 1
      AND claim.disable_confirmed = 0
      AND claim.ticket_activation_confirmed = 1
      AND claim.claim_owner_sha256 = NEW.dispatch_owner_sha256
      AND claim.lease_owner_sha256 = NEW.dispatch_owner_sha256
      AND claim.inflight_started_owner_sha256 =
            NEW.dispatch_owner_sha256
      AND claim.lease_token_sha256 = NEW.lease_token_sha256
      AND claim.inflight_started_lease_token_sha256 =
            NEW.lease_token_sha256
      AND claim.lease_generation = 1
      AND claim.lease_generation = NEW.lease_generation
      AND claim.inflight_started_generation = 1
      AND claim.renewal_count = 0
      AND claim.takeover_count = 0
      AND claim.lease_expires_at = NEW.lease_expires_at
      AND claim.normal_deadline_at = NEW.normal_deadline_at
      AND claim.permit_expires_at = NEW.permit_expires_at
      AND NEW.recorded_at < claim.lease_expires_at
      AND NEW.recorded_at < claim.normal_deadline_at
      AND NEW.recorded_at < claim.permit_expires_at
      AND revocation.authorization_id_sha256 IS NULL
      AND started.receipt_digest_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND started.operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND started.operation_kind = 'enable_controller_deployment'
      AND started.shard_index IS NULL
      AND started.outcome = 'pending'
      AND started.lease_owner_sha256 =
            NEW.dispatch_owner_sha256
      AND started.lease_token_sha256 = NEW.lease_token_sha256
      AND started.lease_generation = NEW.lease_generation
      AND started.lease_expires_at = NEW.lease_expires_at
      AND issuance.campaign_id = NEW.campaign_id
      AND issuance.controller_service_name =
            NEW.controller_service_name
      AND issuance.controller_version_id =
            NEW.controller_enabled_version_id
      AND issuance.permit_expires_at = NEW.permit_expires_at
  ) THEN RAISE(
    ABORT,
    'placement operation-five dispatch consumption is not admissible'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_operation_five_dispatch_outbox
      AS outbox
    WHERE outbox.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND outbox.claim_digest_sha256 = NEW.claim_digest_sha256
      AND outbox.application_ticket_id_sha256 =
            NEW.application_ticket_id_sha256
      AND outbox.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND outbox.outbox_digest_sha256 =
            NEW.authority_dispatch_outbox_digest_sha256
      AND outbox.operation_five_start_receipt_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND outbox.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND outbox.authority_ledger_head_sha256 =
            NEW.authority_ledger_head_sha256
      AND outbox.authority_version_id = NEW.authority_version_id
      AND outbox.controller_service_name =
            NEW.controller_service_name
      AND outbox.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND outbox.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND outbox.controller_enabled_version_id =
            NEW.controller_enabled_version_id
      AND outbox.outbox_state = 'prepared'
  ) THEN RAISE(
    ABORT,
    'placement operation-five dispatch consumption is not admissible'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_operation_five_application_grants
      AS application_grant
    WHERE application_grant.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND application_grant.claim_digest_sha256 =
            NEW.claim_digest_sha256
      AND application_grant.application_ticket_id_sha256 =
            NEW.application_ticket_id_sha256
      AND application_grant.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND application_grant.application_version_id =
            NEW.application_version_id
      AND application_grant.receipt_digest_sha256 =
            NEW.application_grant_receipt_digest_sha256
      AND application_grant.application_grant_digest_sha256 =
            NEW.application_grant_digest_sha256
      AND application_grant.authority_dispatch_outbox_digest_sha256 =
            NEW.authority_dispatch_outbox_digest_sha256
      AND application_grant.operation_five_start_receipt_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND application_grant.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND application_grant.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND application_grant.authority_ledger_head_sha256 =
            NEW.authority_ledger_head_sha256
      AND application_grant.authority_version_id =
            NEW.authority_version_id
      AND application_grant.controller_service_name =
            NEW.controller_service_name
      AND application_grant.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND application_grant.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND application_grant.controller_enabled_version_id =
            NEW.controller_enabled_version_id
  ) THEN RAISE(
    ABORT,
    'placement operation-five dispatch consumption is not admissible'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_operation_five_dispatch_claims
      AS dispatch_claim
    JOIN shard_placement_authority_operation_five_application_grants
      AS application_grant
      ON application_grant.authorization_id_sha256 =
           dispatch_claim.authorization_id_sha256
    WHERE dispatch_claim.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND dispatch_claim.claim_contract =
            'cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1'
      AND dispatch_claim.claim_digest_sha256 =
            NEW.claim_digest_sha256
      AND dispatch_claim.application_ticket_id_sha256 =
            NEW.application_ticket_id_sha256
      AND dispatch_claim.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND dispatch_claim.application_version_id =
            NEW.application_version_id
      AND dispatch_claim.application_grant_receipt_digest_sha256 =
            NEW.application_grant_receipt_digest_sha256
      AND dispatch_claim.application_grant_digest_sha256 =
            NEW.application_grant_digest_sha256
      AND dispatch_claim.authority_dispatch_outbox_digest_sha256 =
            NEW.authority_dispatch_outbox_digest_sha256
      AND dispatch_claim.operation_five_start_receipt_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND dispatch_claim.dispatch_claim_digest_sha256 =
            NEW.authority_dispatch_claim_digest_sha256
      AND dispatch_claim.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND dispatch_claim.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND dispatch_claim.authority_ledger_head_sha256 =
            NEW.authority_ledger_head_sha256
      AND dispatch_claim.authority_version_id =
            NEW.authority_version_id
      AND dispatch_claim.dispatch_owner_sha256 =
            NEW.dispatch_owner_sha256
      AND dispatch_claim.lease_token_sha256 = NEW.lease_token_sha256
      AND dispatch_claim.lease_generation = NEW.lease_generation
      AND dispatch_claim.lease_expires_at = NEW.lease_expires_at
      AND dispatch_claim.normal_deadline_at = NEW.normal_deadline_at
      AND dispatch_claim.permit_expires_at = NEW.permit_expires_at
      AND dispatch_claim.dispatch_claim_credential_id_sha256 =
            NEW.dispatch_claim_credential_id_sha256
      AND dispatch_claim.dispatch_claim_request_id_sha256 =
            NEW.dispatch_claim_request_id_sha256
      AND dispatch_claim.command_dispatch_claim_request_id_sha256 =
            NEW.command_dispatch_claim_request_id_sha256
      AND dispatch_claim.claimed_at =
            NEW.authority_dispatch_claimed_at
      AND dispatch_claim.controller_service_name =
            NEW.controller_service_name
      AND dispatch_claim.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND dispatch_claim.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND dispatch_claim.controller_enabled_version_id =
            NEW.controller_enabled_version_id
      AND dispatch_claim.send_attempt_limit = NEW.send_attempt_limit
      AND dispatch_claim.retry_limit = NEW.retry_limit
      AND dispatch_claim.missing_readback_allows_resend =
            NEW.missing_readback_allows_resend
      AND dispatch_claim.claim_state = 'claimed'
      AND application_grant.recorded_at <= dispatch_claim.claimed_at
      AND dispatch_claim.claimed_at <= NEW.application_consumed_at
      AND NEW.application_consumed_at <= NEW.recorded_at
  ) THEN RAISE(
    ABORT,
    'placement operation-five dispatch consumption is not admissible'
  ) END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_dispatch_consumption_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_five_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'placement operation-five dispatch consumptions are immutable'
  );
END;

CREATE TRIGGER shard_placement_authority_operation_five_dispatch_consumption_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_five_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'placement operation-five dispatch consumptions are append-preserved'
  );
END;
