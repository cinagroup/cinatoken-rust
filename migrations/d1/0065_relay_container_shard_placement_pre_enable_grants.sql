-- Make application D1 the final pre-enable linearization point. The grant is
-- create-only and can exist only while the exact ticket, activation,
-- acknowledgement, campaign, and operation-five authority evidence remain
-- admissible. It does not dispatch to the Controller.

CREATE TABLE relay_container_shard_placement_pre_enable_grants (
  ticket_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(ticket_id_sha256) = 'text'
      AND length(ticket_id_sha256) = 64
      AND ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  grant_contract TEXT NOT NULL
    CHECK (
      grant_contract =
        'cinatoken-relay-container-shard-placement-pre-enable-grant-v1'
    ),
  authorization_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_ticket_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_ticket_digest_sha256) = 'text'
      AND length(application_ticket_digest_sha256) = 64
      AND application_ticket_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_database_identity_sha256) = 'text'
      AND length(application_database_identity_sha256) = 64
      AND application_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_claim_digest_sha256) = 'text'
      AND length(authority_claim_digest_sha256) = 64
      AND authority_claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_activation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_activation_digest_sha256) = 'text'
      AND length(application_activation_digest_sha256) = 64
      AND application_activation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_acknowledgement_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_acknowledgement_digest_sha256) = 'text'
      AND length(application_acknowledgement_digest_sha256) = 64
      AND application_acknowledgement_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_five_admission_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_five_admission_digest_sha256) = 'text'
      AND length(operation_five_admission_digest_sha256) = 64
      AND operation_five_admission_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_five_start_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_five_start_receipt_sha256) = 'text'
      AND length(operation_five_start_receipt_sha256) = 64
      AND operation_five_start_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_dispatch_outbox_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_dispatch_outbox_digest_sha256) = 'text'
      AND length(authority_dispatch_outbox_digest_sha256) = 64
      AND authority_dispatch_outbox_digest_sha256 NOT GLOB '*[^0-9a-f]*'
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
  controller_service_name TEXT NOT NULL
    CHECK (
      controller_service_name = 'cinatoken-container-controller-staging'
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
  application_grant_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_grant_credential_id_sha256) = 'text'
      AND length(application_grant_credential_id_sha256) = 64
      AND application_grant_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_grant_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(application_grant_request_id_sha256) = 'text'
      AND length(application_grant_request_id_sha256) = 64
      AND application_grant_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  grant_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(grant_digest_sha256) = 'text'
      AND length(grant_digest_sha256) = 64
      AND grant_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(granted_at) = 'integer' AND granted_at > 0),
  CHECK (
    application_grant_credential_id_sha256 <>
      application_grant_request_id_sha256
    AND authority_ledger_head_sha256 =
      operation_five_start_receipt_sha256
    AND grant_digest_sha256 <> authority_dispatch_outbox_digest_sha256
  ),
  FOREIGN KEY (ticket_id_sha256)
    REFERENCES relay_container_shard_placement_execution_ticket_authority_acks(
      ticket_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_shard_placement_pre_enable_grants_claim
ON relay_container_shard_placement_pre_enable_grants(
  authority_claim_digest_sha256,
  controller_enabled_version_id
);

CREATE TRIGGER relay_container_shard_placement_pre_enable_grant_insert_guard
BEFORE INSERT ON relay_container_shard_placement_pre_enable_grants
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.granted_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'shard placement pre-enable grant time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_execution_tickets AS ticket
    JOIN relay_container_shard_placement_execution_ticket_activations AS activation
      ON activation.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_execution_ticket_authority_acks AS acknowledgement
      ON acknowledgement.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_mutation_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           ticket.authorization_id_sha256
    JOIN relay_container_shard_activation_campaigns AS campaign
      ON campaign.campaign_id = ticket.campaign_id
    LEFT JOIN relay_container_shard_activation_campaign_seals AS seal
      ON seal.campaign_id = ticket.campaign_id
    WHERE ticket.ticket_id_sha256 = NEW.ticket_id_sha256
      AND ticket.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND ticket.ticket_digest_sha256 =
            NEW.application_ticket_digest_sha256
      AND ticket.application_database_identity_sha256 =
            NEW.application_database_identity_sha256
      AND activation.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND activation.activation_digest_sha256 =
            NEW.application_activation_digest_sha256
      AND acknowledgement.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND acknowledgement.application_activation_digest_sha256 =
            NEW.application_activation_digest_sha256
      AND acknowledgement.acknowledgement_digest_sha256 =
            NEW.application_acknowledgement_digest_sha256
      AND ticket.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND activation.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND acknowledgement.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND ticket.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND NEW.authority_ledger_head_sha256 =
            NEW.operation_five_start_receipt_sha256
      AND NEW.authority_ledger_head_sha256 <>
            acknowledgement.authority_ledger_head_sha256
      AND ticket.controller_service_name =
            NEW.controller_service_name
      AND ticket.controller_enable_operation_id_sha256 =
            NEW.controller_enable_operation_id_sha256
      AND ticket.controller_baseline_version_id =
            NEW.controller_baseline_version_id
      AND ticket.controller_enabled_version_id =
            NEW.controller_enabled_version_id
      AND authorization.campaign_id = ticket.campaign_id
      AND authorization.campaign_digest_sha256 =
            ticket.campaign_digest_sha256
      AND campaign.campaign_digest_sha256 =
            ticket.campaign_digest_sha256
      AND campaign.expires_at = ticket.execution_deadline_at
      AND authorization.campaign_expires_at =
            ticket.execution_deadline_at
      AND ticket.prepared_at <= activation.activated_at
      AND activation.activated_at <= acknowledgement.acknowledged_at
      AND acknowledgement.acknowledged_at <= NEW.granted_at
      AND NEW.granted_at < ticket.execution_deadline_at
      AND NEW.granted_at < authorization.permit_expires_at
      AND NEW.granted_at < authorization.campaign_expires_at
      AND seal.campaign_id IS NULL
  ) THEN RAISE(
    ABORT,
    'shard placement pre-enable grant is not admissible'
  ) END;
END;

CREATE TRIGGER relay_container_shard_placement_pre_enable_grant_update_guard
BEFORE UPDATE ON relay_container_shard_placement_pre_enable_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'shard placement pre-enable grants are immutable'
  );
END;

CREATE TRIGGER relay_container_shard_placement_pre_enable_grant_delete_guard
BEFORE DELETE ON relay_container_shard_placement_pre_enable_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'shard placement pre-enable grants are append-preserved'
  );
END;
