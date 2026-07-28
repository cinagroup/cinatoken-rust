-- Prepare the application-D1 half of the placement execution handshake before
-- an Authority claim can exist. The ticket is immutable and candidate-bound;
-- activation is a separate append-only acknowledgement of one exact Authority
-- claim. Cross-database atomicity is intentionally not assumed.

CREATE TABLE relay_container_shard_placement_execution_tickets (
  ticket_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(ticket_id_sha256) = 'text'
      AND length(ticket_id_sha256) = 64
      AND ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  ticket_contract TEXT NOT NULL
    CHECK (
      ticket_contract =
        'cinatoken-relay-container-shard-placement-execution-ticket-v1'
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
  campaign_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_digest_sha256) = 'text'
      AND length(campaign_digest_sha256) = 64
      AND campaign_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(execution_nonce_sha256) = 'text'
      AND length(execution_nonce_sha256) = 64
      AND execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_subject_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(permit_subject_digest_sha256) = 'text'
      AND length(permit_subject_digest_sha256) = 64
      AND permit_subject_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_database_identity_sha256) = 'text'
      AND length(application_database_identity_sha256) = 64
      AND application_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
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
  execution_plan_sha256 TEXT NOT NULL
    CHECK (
      typeof(execution_plan_sha256) = 'text'
      AND length(execution_plan_sha256) = 64
      AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_schedule_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_schedule_sha256) = 'text'
      AND length(operation_schedule_sha256) = 64
      AND operation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  preparation_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(preparation_operation_id_sha256) = 'text'
      AND length(preparation_operation_id_sha256) = 64
      AND preparation_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_operation_id_sha256) = 'text'
      AND length(claim_operation_id_sha256) = 64
      AND claim_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  activation_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(activation_operation_id_sha256) = 'text'
      AND length(activation_operation_id_sha256) = 64
      AND activation_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_enable_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(controller_enable_operation_id_sha256) = 'text'
      AND length(controller_enable_operation_id_sha256) = 64
      AND controller_enable_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_disable_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(controller_disable_operation_id_sha256) = 'text'
      AND length(controller_disable_operation_id_sha256) = 64
      AND controller_disable_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  release_sha256 TEXT NOT NULL
    CHECK (
      typeof(release_sha256) = 'text'
      AND length(release_sha256) = 64
      AND release_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  publication_sha256 TEXT NOT NULL
    CHECK (
      typeof(publication_sha256) = 'text'
      AND length(publication_sha256) = 64
      AND publication_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_activation_sha256 TEXT NOT NULL
    CHECK (
      typeof(execution_activation_sha256) = 'text'
      AND length(execution_activation_sha256) = 64
      AND execution_activation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  runner_build_sha256 TEXT NOT NULL
    CHECK (
      typeof(runner_build_sha256) = 'text'
      AND length(runner_build_sha256) = 64
      AND runner_build_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_service_name TEXT NOT NULL
    CHECK (
      controller_service_name = 'cinatoken-container-controller-staging'
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
    ),
  controller_disabled_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_disabled_version_id) = 'text'
      AND length(controller_disabled_version_id) BETWEEN 1 AND 128
      AND substr(controller_disabled_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_disabled_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  edge_baseline_version_id TEXT NOT NULL
    CHECK (
      typeof(edge_baseline_version_id) = 'text'
      AND length(edge_baseline_version_id) BETWEEN 1 AND 128
      AND substr(edge_baseline_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND edge_baseline_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  action_gate_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(action_gate_inventory_sha256) = 'text'
      AND length(action_gate_inventory_sha256) = 64
      AND action_gate_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  action_gate_count INTEGER NOT NULL
    CHECK (typeof(action_gate_count) = 'integer' AND action_gate_count = 22),
  all_action_gates_false INTEGER NOT NULL
    CHECK (
      typeof(all_action_gates_false) = 'integer'
      AND all_action_gates_false = 1
    ),
  foundation_manifest_sha256 TEXT NOT NULL
    CHECK (
      typeof(foundation_manifest_sha256) = 'text'
      AND length(foundation_manifest_sha256) = 64
      AND foundation_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  runtime_build_id TEXT NOT NULL
    CHECK (
      typeof(runtime_build_id) = 'text'
      AND length(runtime_build_id) = 64
      AND runtime_build_id NOT GLOB '*[^0-9a-f]*'
    ),
  ring_generation INTEGER NOT NULL
    CHECK (
      typeof(ring_generation) = 'integer'
      AND ring_generation BETWEEN 1 AND 1000000
    ),
  shard_count INTEGER NOT NULL
    CHECK (
      typeof(shard_count) = 'integer'
      AND shard_count BETWEEN 1 AND 1024
    ),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  prepared_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(prepared_by_admin_id) = 'integer'
      AND prepared_by_admin_id > 0
    ),
  activation_deadline_at INTEGER NOT NULL
    CHECK (typeof(activation_deadline_at) = 'integer' AND activation_deadline_at > 0),
  execution_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(execution_deadline_at) = 'integer'
      AND execution_deadline_at > activation_deadline_at
    ),
  ticket_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(ticket_digest_sha256) = 'text'
      AND length(ticket_digest_sha256) = 64
      AND ticket_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  prepared_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(prepared_at) = 'integer' AND prepared_at > 0),
  CHECK (
    controller_enabled_version_id <> controller_baseline_version_id
    AND controller_enabled_version_id <> controller_disabled_version_id
  ),
  CHECK (
    ticket_id_sha256 <> authorization_id_sha256
    AND ticket_id_sha256 <> execution_nonce_sha256
    AND ticket_id_sha256 <> permit_subject_digest_sha256
    AND ticket_id_sha256 <> campaign_id
    AND ticket_id_sha256 <> campaign_digest_sha256
    AND ticket_id_sha256 <> execution_plan_sha256
    AND ticket_id_sha256 <> operation_schedule_sha256
    AND preparation_operation_id_sha256 <> claim_operation_id_sha256
    AND preparation_operation_id_sha256 <> activation_operation_id_sha256
    AND preparation_operation_id_sha256 <> controller_enable_operation_id_sha256
    AND preparation_operation_id_sha256 <> controller_disable_operation_id_sha256
    AND claim_operation_id_sha256 <> activation_operation_id_sha256
    AND claim_operation_id_sha256 <> controller_enable_operation_id_sha256
    AND claim_operation_id_sha256 <> controller_disable_operation_id_sha256
    AND activation_operation_id_sha256 <> controller_enable_operation_id_sha256
    AND activation_operation_id_sha256 <> controller_disable_operation_id_sha256
    AND controller_enable_operation_id_sha256 <>
          controller_disable_operation_id_sha256
  ),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_shard_placement_mutation_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_shard_activation_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE TABLE relay_container_shard_placement_execution_ticket_activations (
  ticket_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(ticket_id_sha256) = 'text'
      AND length(ticket_id_sha256) = 64
      AND ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  activation_contract TEXT NOT NULL
    CHECK (
      activation_contract =
        'cinatoken-relay-container-shard-placement-execution-ticket-activation-v1'
    ),
  authority_claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_claim_digest_sha256) = 'text'
      AND length(authority_claim_digest_sha256) = 64
      AND authority_claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_claim_acquired_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_claim_acquired_receipt_sha256) = 'text'
      AND length(authority_claim_acquired_receipt_sha256) = 64
      AND authority_claim_acquired_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_claim_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_claim_operation_id_sha256) = 'text'
      AND length(authority_claim_operation_id_sha256) = 64
      AND authority_claim_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_activation_operation_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_activation_operation_id_sha256) = 'text'
      AND length(authority_activation_operation_id_sha256) = 64
      AND authority_activation_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
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
  authority_version_id TEXT NOT NULL
    CHECK (
      typeof(authority_version_id) = 'text'
      AND length(authority_version_id) BETWEEN 1 AND 128
      AND substr(authority_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  activation_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(activation_credential_id_sha256) = 'text'
      AND length(activation_credential_id_sha256) = 64
      AND activation_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  activation_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(activation_request_id_sha256) = 'text'
      AND length(activation_request_id_sha256) = 64
      AND activation_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  activation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(activation_digest_sha256) = 'text'
      AND length(activation_digest_sha256) = 64
      AND activation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  activated_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(activated_by_admin_id) = 'integer'
      AND activated_by_admin_id > 0
    ),
  activated_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(activated_at) = 'integer' AND activated_at > 0),
  CHECK (
    authority_claim_digest_sha256 <>
      authority_claim_acquired_receipt_sha256
    AND authority_claim_operation_id_sha256 <>
      authority_activation_operation_id_sha256
    AND activation_credential_id_sha256 <> activation_request_id_sha256
  ),
  FOREIGN KEY (ticket_id_sha256)
    REFERENCES relay_container_shard_placement_execution_tickets(
      ticket_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE relay_container_shard_placement_execution_ticket_authority_acks (
  ticket_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(ticket_id_sha256) = 'text'
      AND length(ticket_id_sha256) = 64
      AND ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  acknowledgement_contract TEXT NOT NULL
    CHECK (
      acknowledgement_contract =
        'cinatoken-relay-container-shard-placement-authority-ack-v1'
    ),
  application_ticket_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_ticket_digest_sha256) = 'text'
      AND length(application_ticket_digest_sha256) = 64
      AND application_ticket_digest_sha256 NOT GLOB '*[^0-9a-f]*'
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
  authority_activation_terminal_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_activation_terminal_receipt_sha256) = 'text'
      AND length(authority_activation_terminal_receipt_sha256) = 64
      AND authority_activation_terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_head_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_head_sha256) = 'text'
      AND length(authority_ledger_head_sha256) = 64
      AND authority_ledger_head_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_database_identity_sha256) = 'text'
      AND length(authority_database_identity_sha256) = 64
      AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_version_id TEXT NOT NULL
    CHECK (
      typeof(authority_version_id) = 'text'
      AND length(authority_version_id) BETWEEN 1 AND 128
      AND substr(authority_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  authority_read_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_read_credential_id_sha256) = 'text'
      AND length(authority_read_credential_id_sha256) = 64
      AND authority_read_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_read_request_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_read_request_id_sha256) = 'text'
      AND length(authority_read_request_id_sha256) = 64
      AND authority_read_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  acknowledgement_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(acknowledgement_digest_sha256) = 'text'
      AND length(acknowledgement_digest_sha256) = 64
      AND acknowledgement_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  acknowledged_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(acknowledged_by_admin_id) = 'integer'
      AND acknowledged_by_admin_id > 0
    ),
  acknowledged_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(acknowledged_at) = 'integer' AND acknowledged_at > 0),
  CHECK (
    authority_claim_digest_sha256 <>
      application_activation_digest_sha256
    AND authority_claim_digest_sha256 <>
      authority_activation_terminal_receipt_sha256
    AND application_activation_digest_sha256 <>
      authority_activation_terminal_receipt_sha256
    AND authority_read_credential_id_sha256 <>
      authority_read_request_id_sha256
  ),
  FOREIGN KEY (ticket_id_sha256)
    REFERENCES relay_container_shard_placement_execution_ticket_activations(
      ticket_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_shard_placement_execution_tickets_candidate
ON relay_container_shard_placement_execution_tickets(
  controller_enabled_version_id,
  ring_generation,
  campaign_id
);

CREATE INDEX idx_relay_container_shard_placement_execution_tickets_plan
ON relay_container_shard_placement_execution_tickets(
  execution_plan_sha256,
  operation_schedule_sha256
);

CREATE INDEX idx_relay_container_shard_placement_execution_ticket_activations_claim
ON relay_container_shard_placement_execution_ticket_activations(
  authority_claim_digest_sha256,
  ticket_id_sha256
);

CREATE INDEX idx_relay_container_shard_placement_execution_ticket_authority_acks_claim
ON relay_container_shard_placement_execution_ticket_authority_acks(
  authority_claim_digest_sha256,
  ticket_id_sha256
);

CREATE TRIGGER relay_container_shard_placement_execution_ticket_insert_guard
BEFORE INSERT ON relay_container_shard_placement_execution_tickets
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.prepared_at <> unixepoch()
  THEN RAISE(ABORT, 'shard placement execution ticket time must come from D1') END;

  SELECT CASE WHEN
    NEW.activation_deadline_at <= NEW.prepared_at
    OR NEW.activation_deadline_at > NEW.prepared_at + 600
    OR NEW.execution_deadline_at <= NEW.activation_deadline_at
  THEN RAISE(ABORT, 'shard placement execution ticket activation window is invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_mutation_authorizations AS authorization
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.execution_nonce_sha256 = NEW.execution_nonce_sha256
      AND authorization.subject_digest_sha256 =
            NEW.permit_subject_digest_sha256
      AND authorization.campaign_id = NEW.campaign_id
      AND authorization.campaign_digest_sha256 = NEW.campaign_digest_sha256
      AND authorization.environment = NEW.environment
      AND authorization.controller_service_name =
            NEW.controller_service_name
      AND authorization.controller_version_id =
            NEW.controller_enabled_version_id
      AND authorization.action_gate_inventory_sha256 =
            NEW.action_gate_inventory_sha256
      AND NEW.action_gate_count = 22
      AND NEW.all_action_gates_false = 1
      AND authorization.foundation_manifest_sha256 =
            NEW.foundation_manifest_sha256
      AND authorization.runtime_build_id = NEW.runtime_build_id
      AND authorization.ring_generation = NEW.ring_generation
      AND authorization.shard_count = NEW.shard_count
      AND authorization.consumed_by_admin_id = NEW.prepared_by_admin_id
      AND abs(authorization.consumed_at - NEW.prepared_at) <= 5
      AND NEW.activation_deadline_at <= authorization.permit_expires_at
      AND NEW.activation_deadline_at <= authorization.campaign_expires_at
      AND NEW.execution_deadline_at = authorization.campaign_expires_at
      AND NEW.execution_deadline_at <= authorization.permit_expires_at
  ) THEN RAISE(ABORT, 'shard placement execution ticket authorization mismatch') END;
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_update_guard
BEFORE UPDATE ON relay_container_shard_placement_execution_tickets
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement execution tickets are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_delete_guard
BEFORE DELETE ON relay_container_shard_placement_execution_tickets
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement execution tickets are append-preserved');
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_activation_insert_guard
BEFORE INSERT ON relay_container_shard_placement_execution_ticket_activations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.activated_at <> unixepoch()
  THEN RAISE(ABORT, 'shard placement execution ticket activation time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_execution_tickets AS ticket
    JOIN relay_container_shard_placement_mutation_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           ticket.authorization_id_sha256
    LEFT JOIN relay_container_shard_activation_campaign_seals AS seal
      ON seal.campaign_id = ticket.campaign_id
    WHERE ticket.ticket_id_sha256 = NEW.ticket_id_sha256
      AND ticket.claim_operation_id_sha256 =
            NEW.authority_claim_operation_id_sha256
      AND ticket.activation_operation_id_sha256 =
            NEW.authority_activation_operation_id_sha256
      AND ticket.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND ticket.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND ticket.prepared_at <= NEW.activated_at
      AND NEW.activated_at < ticket.activation_deadline_at
      AND NEW.activated_at < authorization.permit_expires_at
      AND NEW.activated_at < authorization.campaign_expires_at
      AND seal.campaign_id IS NULL
  ) THEN RAISE(ABORT, 'shard placement execution ticket is not activatable') END;
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_activation_update_guard
BEFORE UPDATE ON relay_container_shard_placement_execution_ticket_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement execution ticket activations are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_activation_delete_guard
BEFORE DELETE ON relay_container_shard_placement_execution_ticket_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement execution ticket activations are append-preserved');
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_authority_ack_insert_guard
BEFORE INSERT ON relay_container_shard_placement_execution_ticket_authority_acks
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.acknowledged_at <> unixepoch()
  THEN RAISE(ABORT, 'shard placement Authority acknowledgement time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_execution_tickets AS ticket
    JOIN relay_container_shard_placement_execution_ticket_activations AS activation
      ON activation.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_mutation_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           ticket.authorization_id_sha256
    LEFT JOIN relay_container_shard_activation_campaign_seals AS seal
      ON seal.campaign_id = ticket.campaign_id
    WHERE ticket.ticket_id_sha256 = NEW.ticket_id_sha256
      AND activation.authority_claim_digest_sha256 =
            NEW.authority_claim_digest_sha256
      AND ticket.ticket_digest_sha256 =
            NEW.application_ticket_digest_sha256
      AND activation.activation_digest_sha256 =
            NEW.application_activation_digest_sha256
      AND activation.authority_database_identity_sha256 =
            NEW.authority_database_identity_sha256
      AND activation.authority_version_id = NEW.authority_version_id
      AND activation.activated_at <= NEW.acknowledged_at
      AND NEW.acknowledged_at < ticket.activation_deadline_at
      AND NEW.acknowledged_at < authorization.permit_expires_at
      AND NEW.acknowledged_at < authorization.campaign_expires_at
      AND seal.campaign_id IS NULL
  ) THEN RAISE(ABORT, 'shard placement Authority acknowledgement is not admissible') END;
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_authority_ack_update_guard
BEFORE UPDATE ON relay_container_shard_placement_execution_ticket_authority_acks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement Authority acknowledgements are immutable');
END;

CREATE TRIGGER relay_container_shard_placement_execution_ticket_authority_ack_delete_guard
BEFORE DELETE ON relay_container_shard_placement_execution_ticket_authority_acks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'shard placement Authority acknowledgements are append-preserved');
END;

DROP TRIGGER relay_container_shard_activation_campaign_authorization_guard;

CREATE TRIGGER relay_container_shard_activation_campaign_authorization_guard
AFTER INSERT ON relay_container_shard_activation_campaigns
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_placement_mutation_authorizations AS authorization
    JOIN relay_container_shard_placement_execution_tickets AS ticket
      ON ticket.authorization_id_sha256 =
           authorization.authorization_id_sha256
     AND ticket.campaign_id = authorization.campaign_id
     AND ticket.campaign_digest_sha256 =
           authorization.campaign_digest_sha256
     AND ticket.execution_nonce_sha256 =
           authorization.execution_nonce_sha256
     AND ticket.permit_subject_digest_sha256 =
           authorization.subject_digest_sha256
    WHERE authorization.campaign_id = NEW.campaign_id
      AND authorization.campaign_digest_sha256 =
            NEW.campaign_digest_sha256
      AND authorization.campaign_nonce_sha256 =
            NEW.campaign_nonce_sha256
      AND authorization.controller_version_id = NEW.controller_version_id
      AND ticket.controller_enabled_version_id = NEW.controller_version_id
      AND authorization.action_gate_inventory_sha256 =
            NEW.action_gate_inventory_sha256
      AND ticket.action_gate_inventory_sha256 =
            NEW.action_gate_inventory_sha256
      AND NEW.action_gate_count = 22
      AND NEW.all_action_gates_false = 1
      AND authorization.foundation_manifest_sha256 =
            NEW.foundation_manifest_sha256
      AND ticket.foundation_manifest_sha256 =
            NEW.foundation_manifest_sha256
      AND authorization.runtime_build_id = NEW.runtime_build_id
      AND ticket.runtime_build_id = NEW.runtime_build_id
      AND authorization.ring_generation = NEW.ring_generation
      AND ticket.ring_generation = NEW.ring_generation
      AND authorization.shard_count = NEW.shard_count
      AND ticket.shard_count = NEW.shard_count
      AND NEW.shard_contract_version = 1
      AND authorization.environment = NEW.environment
      AND ticket.environment = NEW.environment
      AND authorization.consumed_by_admin_id = NEW.created_by_admin_id
      AND ticket.prepared_by_admin_id = NEW.created_by_admin_id
      AND abs(authorization.consumed_at - NEW.created_at) <= 5
      AND abs(ticket.prepared_at - NEW.created_at) <= 5
      AND authorization.campaign_expires_at = NEW.expires_at
      AND NEW.expires_at - NEW.created_at =
            authorization.campaign_lifetime_seconds
      AND ticket.activation_deadline_at <= NEW.expires_at
      AND ticket.execution_deadline_at = NEW.expires_at
  ) THEN RAISE(ABORT, 'shard activation campaign execution ticket mismatch') END;
END;

CREATE TRIGGER relay_container_shard_activation_campaign_claim_execution_ticket_guard
AFTER INSERT ON relay_container_shard_activation_campaign_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaigns AS campaign
    JOIN relay_container_shard_placement_execution_tickets AS ticket
      ON ticket.campaign_id = campaign.campaign_id
    JOIN relay_container_shard_placement_mutation_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           ticket.authorization_id_sha256
    JOIN relay_container_shard_placement_execution_ticket_activations AS activation
      ON activation.ticket_id_sha256 = ticket.ticket_id_sha256
    JOIN relay_container_shard_placement_execution_ticket_authority_acks AS acknowledgement
      ON acknowledgement.ticket_id_sha256 = ticket.ticket_id_sha256
     AND acknowledgement.authority_claim_digest_sha256 =
           activation.authority_claim_digest_sha256
     AND acknowledgement.application_activation_digest_sha256 =
           activation.activation_digest_sha256
     AND acknowledgement.application_ticket_digest_sha256 =
           ticket.ticket_digest_sha256
     AND acknowledgement.authority_database_identity_sha256 =
           activation.authority_database_identity_sha256
     AND acknowledgement.authority_version_id =
           activation.authority_version_id
    WHERE campaign.campaign_id = NEW.campaign_id
      AND activation.activated_at <= NEW.claimed_at
      AND acknowledgement.acknowledged_at <= NEW.claimed_at
      AND NEW.claimed_at < authorization.permit_expires_at
      AND NEW.claimed_at < authorization.campaign_expires_at
      AND NEW.claimed_at < ticket.execution_deadline_at
  ) THEN RAISE(ABORT, 'shard activation campaign claim is not Authority-acknowledged') END;
END;
