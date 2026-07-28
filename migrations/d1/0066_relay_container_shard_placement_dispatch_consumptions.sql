-- Make Application D1 the final operation-five dispatch decision point. A
-- consumption is create-only, records no send attempt, and performs no I/O.
-- A campaign seal committed before this insert wins; a seal committed after
-- this insert remains valid history but cannot revoke the consumed decision.

CREATE TABLE relay_container_shard_placement_dispatch_consumptions (
  ticket_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(ticket_id_sha256) = 'text'
      AND length(ticket_id_sha256) = 64
      AND ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  consumption_contract TEXT NOT NULL
    CHECK (
      consumption_contract =
        'cinatoken-relay-container-shard-placement-dispatch-consumption-v1'
    ),
  authorization_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
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
      AND application_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_version_id TEXT NOT NULL
    CHECK (
      typeof(application_version_id) = 'text'
      AND length(application_version_id) BETWEEN 1 AND 128
      AND substr(application_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND application_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  application_grant_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_grant_digest_sha256) = 'text'
      AND length(application_grant_digest_sha256) = 64
      AND application_grant_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_claim_digest_sha256) = 'text'
      AND length(authority_claim_digest_sha256) = 64
      AND authority_claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_outbox_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_dispatch_outbox_digest_sha256) = 'text'
      AND length(authority_dispatch_outbox_digest_sha256) = 64
      AND authority_dispatch_outbox_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  application_grant_receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_grant_receipt_digest_sha256) = 'text'
      AND length(application_grant_receipt_digest_sha256) = 64
      AND application_grant_receipt_digest_sha256
        NOT GLOB '*[^0-9a-f]*'
    ),
  operation_five_start_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_five_start_receipt_sha256) = 'text'
      AND length(operation_five_start_receipt_sha256) = 64
      AND operation_five_start_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
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
      AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
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
      AND substr(authority_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  dispatch_owner_sha256 TEXT NOT NULL
    CHECK (
      typeof(dispatch_owner_sha256) = 'text'
      AND length(dispatch_owner_sha256) = 64
      AND dispatch_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(lease_token_sha256) = 'text'
      AND length(lease_token_sha256) = 64
      AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_generation INTEGER NOT NULL
    CHECK (typeof(lease_generation) = 'integer' AND lease_generation = 1),
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
      AND dispatch_claim_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  dispatch_claim_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(dispatch_claim_request_id_sha256) = 'text'
      AND length(dispatch_claim_request_id_sha256) = 64
      AND dispatch_claim_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
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
      controller_service_name =
        'cinatoken-container-controller-staging'
    ),
  controller_enable_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(controller_enable_operation_id_sha256) = 'text'
      AND length(controller_enable_operation_id_sha256) = 64
      AND controller_enable_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_baseline_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_baseline_version_id) = 'text'
      AND length(controller_baseline_version_id) BETWEEN 1 AND 128
      AND substr(controller_baseline_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_baseline_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  controller_enabled_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_enabled_version_id) = 'text'
      AND length(controller_enabled_version_id) BETWEEN 1 AND 128
      AND substr(controller_enabled_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_enabled_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND controller_enabled_version_id <> controller_baseline_version_id
    ),
  send_attempt_limit INTEGER NOT NULL
    CHECK (typeof(send_attempt_limit) = 'integer' AND send_attempt_limit = 1),
  retry_limit INTEGER NOT NULL
    CHECK (typeof(retry_limit) = 'integer' AND retry_limit = 0),
  missing_readback_allows_resend INTEGER NOT NULL
    CHECK (
      typeof(missing_readback_allows_resend) = 'integer'
      AND missing_readback_allows_resend = 0
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
  dispatch_consumption_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(dispatch_consumption_digest_sha256) = 'text'
      AND length(dispatch_consumption_digest_sha256) = 64
      AND dispatch_consumption_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  consumption_state TEXT NOT NULL CHECK (consumption_state = 'consumed'),
  consumed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(consumed_at) = 'integer' AND consumed_at > 0),
  CHECK (
    authority_ledger_head_sha256 = operation_five_start_receipt_sha256
    AND lease_expires_at <= normal_deadline_at
    AND normal_deadline_at <= permit_expires_at
    AND dispatch_claim_credential_id_sha256 <>
          dispatch_claim_request_id_sha256
    AND application_dispatch_consumption_credential_id_sha256 <>
          application_dispatch_consumption_request_id_sha256
    AND dispatch_consumption_digest_sha256 <>
          authority_dispatch_claim_digest_sha256
  ),
  FOREIGN KEY (ticket_id_sha256)
    REFERENCES relay_container_shard_placement_pre_enable_grants(
      ticket_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_shard_placement_dispatch_consumptions_claim
ON relay_container_shard_placement_dispatch_consumptions(
  authority_dispatch_claim_digest_sha256,
  controller_enabled_version_id
);

CREATE TRIGGER relay_container_shard_placement_dispatch_consumption_insert_guard
BEFORE INSERT ON relay_container_shard_placement_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.consumed_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'shard placement dispatch consumption time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_pre_enable_grants AS grant_row
    JOIN relay_container_shard_placement_execution_tickets AS ticket
      ON ticket.ticket_id_sha256 = grant_row.ticket_id_sha256
     AND ticket.authorization_id_sha256 =
           grant_row.authorization_id_sha256
    JOIN relay_container_shard_placement_execution_ticket_activations
      AS activation
      ON activation.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_execution_ticket_authority_acks
      AS acknowledgement
      ON acknowledgement.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_mutation_authorizations
      AS authorization
      ON authorization.authorization_id_sha256 =
           ticket.authorization_id_sha256
    JOIN relay_container_shard_activation_campaigns AS campaign
      ON campaign.campaign_id = ticket.campaign_id
    LEFT JOIN relay_container_shard_activation_campaign_seals AS seal
      ON seal.campaign_id = ticket.campaign_id
    WHERE grant_row.ticket_id_sha256 = NEW.ticket_id_sha256
      AND grant_row.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND ticket.campaign_id = NEW.campaign_id
      AND authorization.campaign_id = NEW.campaign_id
      AND campaign.campaign_id = NEW.campaign_id
      AND grant_row.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND ticket.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND grant_row.grant_digest_sha256 =
            NEW.application_grant_digest_sha256
      AND grant_row.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND activation.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND acknowledgement.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND grant_row.authority_dispatch_outbox_digest_sha256 =
            NEW.authority_dispatch_outbox_digest_sha256
      AND grant_row.operation_five_start_receipt_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND grant_row.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND ticket.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND activation.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND acknowledgement.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND grant_row.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND ticket.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND activation.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND grant_row.authority_ledger_head_sha256 =
            NEW.authority_ledger_head_sha256
      AND NEW.authority_ledger_head_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND grant_row.authority_version_id = NEW.authority_version_id
      AND grant_row.controller_service_name =
            NEW.controller_service_name
      AND ticket.controller_service_name = NEW.controller_service_name
      AND grant_row.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND ticket.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND grant_row.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND ticket.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND grant_row.controller_enabled_version_id =
            NEW.controller_enabled_version_id
      AND ticket.controller_enabled_version_id =
            NEW.controller_enabled_version_id
      AND acknowledgement.application_ticket_digest_sha256 =
            grant_row.application_ticket_digest_sha256
      AND activation.activation_digest_sha256 =
            grant_row.application_activation_digest_sha256
      AND acknowledgement.application_activation_digest_sha256 =
            grant_row.application_activation_digest_sha256
      AND acknowledgement.acknowledgement_digest_sha256 =
            grant_row.application_acknowledgement_digest_sha256
      AND authorization.campaign_digest_sha256 =
            ticket.campaign_digest_sha256
      AND campaign.campaign_digest_sha256 =
            ticket.campaign_digest_sha256
      AND grant_row.granted_at <= NEW.authority_dispatch_claimed_at
      AND NEW.authority_dispatch_claimed_at <= NEW.consumed_at
      AND NEW.consumed_at < NEW.lease_expires_at
      AND NEW.consumed_at < NEW.normal_deadline_at
      AND NEW.consumed_at < NEW.permit_expires_at
      AND NEW.consumed_at < ticket.execution_deadline_at
      AND NEW.consumed_at < authorization.permit_expires_at
      AND NEW.consumed_at < authorization.campaign_expires_at
      AND NEW.consumed_at < campaign.expires_at
      AND NEW.normal_deadline_at = ticket.execution_deadline_at
      AND ticket.execution_deadline_at = authorization.campaign_expires_at
      AND ticket.execution_deadline_at = campaign.expires_at
      AND NEW.permit_expires_at = authorization.permit_expires_at
      AND NEW.lease_generation = 1
      AND NEW.send_attempt_limit = 1
      AND NEW.retry_limit = 0
      AND NEW.missing_readback_allows_resend = 0
      AND seal.campaign_id IS NULL
  ) THEN RAISE(
    ABORT,
    'shard placement dispatch consumption is not admissible'
  ) END;
END;

CREATE TRIGGER relay_container_shard_placement_dispatch_consumption_update_guard
BEFORE UPDATE ON relay_container_shard_placement_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'shard placement dispatch consumptions are immutable'
  );
END;

CREATE TRIGGER relay_container_shard_placement_dispatch_consumption_delete_guard
BEFORE DELETE ON relay_container_shard_placement_dispatch_consumptions
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'shard placement dispatch consumptions are append-preserved'
  );
END;
