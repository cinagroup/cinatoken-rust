CREATE TABLE controller_deployment_gateway_disable_operations (
  gateway_disable_idempotency_key_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(gateway_disable_idempotency_key_sha256) = 'text'
      AND length(gateway_disable_idempotency_key_sha256) = 64
      AND gateway_disable_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  command_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(command_digest_sha256) = 'text'
      AND length(command_digest_sha256) = 64
      AND command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  command_json TEXT NOT NULL
    CHECK (
      typeof(command_json) = 'text'
      AND length(command_json) BETWEEN 2 AND 4096
    ),
  authorization_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation14_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation14_id_sha256) = 'text'
      AND length(operation14_id_sha256) = 64
      AND operation14_id_sha256 NOT GLOB '*[^0-9a-f]*'
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
    ),
  lease_owner_sha256 TEXT NOT NULL
    CHECK (
      typeof(lease_owner_sha256) = 'text'
      AND length(lease_owner_sha256) = 64
      AND lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token_sha256 TEXT NOT NULL
    CHECK (
      typeof(lease_token_sha256) = 'text'
      AND length(lease_token_sha256) = 64
      AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_generation INTEGER NOT NULL
    CHECK (typeof(lease_generation) = 'integer' AND lease_generation >= 1),
  controller_service_name TEXT NOT NULL
    CHECK (
      typeof(controller_service_name) = 'text'
      AND length(controller_service_name) BETWEEN 1 AND 63
      AND controller_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  enabled_source_version_id TEXT NOT NULL
    CHECK (
      typeof(enabled_source_version_id) = 'text'
      AND length(enabled_source_version_id) BETWEEN 1 AND 128
    ),
  baseline_target_version_id TEXT NOT NULL
    CHECK (
      typeof(baseline_target_version_id) = 'text'
      AND length(baseline_target_version_id) BETWEEN 1 AND 128
    ),
  authority_attempt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authority_attempt_digest_sha256) = 'text'
      AND length(authority_attempt_digest_sha256) = 64
      AND authority_attempt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  send_started_event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(send_started_event_digest_sha256) = 'text'
      AND length(send_started_event_digest_sha256) = 64
      AND send_started_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  account_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(account_id_sha256) = 'text'
      AND length(account_id_sha256) = 64
      AND account_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_profile_version INTEGER NOT NULL
    CHECK (
      typeof(gateway_profile_version) = 'integer'
      AND gateway_profile_version = 1
    ),
  disable_create_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(disable_create_credential_id_sha256) = 'text'
      AND length(disable_create_credential_id_sha256) = 64
      AND disable_create_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  disable_create_request_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(disable_create_request_id_sha256) = 'text'
      AND length(disable_create_request_id_sha256) = 64
      AND disable_create_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  CHECK (enabled_source_version_id <> baseline_target_version_id)
) WITHOUT ROWID;

CREATE TABLE controller_deployment_gateway_disable_dispatches (
  gateway_disable_idempotency_key_sha256 TEXT PRIMARY KEY NOT NULL,
  mutation_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(mutation_request_sha256) = 'text'
      AND length(mutation_request_sha256) = 64
      AND mutation_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  mutation_body TEXT NOT NULL
    CHECK (
      typeof(mutation_body) = 'text'
      AND length(mutation_body) BETWEEN 2 AND 4096
    ),
  mutation_annotation TEXT NOT NULL UNIQUE
    CHECK (
      typeof(mutation_annotation) = 'text'
      AND length(mutation_annotation) BETWEEN 1 AND 512
      AND substr(mutation_annotation, 1, 32) =
        'cinatoken-controller-disable-v1:'
    ),
  intent_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(intent_digest_sha256) = 'text'
      AND length(intent_digest_sha256) = 64
      AND intent_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  endpoint_path TEXT NOT NULL
    CHECK (
      typeof(endpoint_path) = 'text'
      AND length(endpoint_path) BETWEEN 1 AND 1024
      AND substr(endpoint_path, 1, 20) = '/client/v4/accounts/'
      AND instr(substr(endpoint_path, 21), '/workers/scripts/') > 1
      AND substr(endpoint_path, -12) = '/deployments'
    ),
  dispatch_semantics TEXT NOT NULL
    CHECK (
      dispatch_semantics =
        'unique_disable_mutation_authority_persisted_network_may_not_have_occurred'
    ),
  authorized_at INTEGER NOT NULL CHECK (typeof(authorized_at) = 'integer'),
  FOREIGN KEY (gateway_disable_idempotency_key_sha256)
    REFERENCES controller_deployment_gateway_disable_operations(
      gateway_disable_idempotency_key_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE controller_deployment_gateway_disable_outcomes (
  gateway_disable_idempotency_key_sha256 TEXT PRIMARY KEY NOT NULL,
  classification TEXT NOT NULL
    CHECK (classification IN ('accepted', 'rejected', 'ambiguous')),
  http_status INTEGER
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_body_sha256 TEXT
    CHECK (
      response_body_sha256 IS NULL
      OR (
        typeof(response_body_sha256) = 'text'
        AND length(response_body_sha256) = 64
        AND response_body_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  response_request_id_sha256 TEXT
    CHECK (
      response_request_id_sha256 IS NULL
      OR (
        typeof(response_request_id_sha256) = 'text'
        AND length(response_request_id_sha256) = 64
        AND response_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  response_bytes INTEGER
    CHECK (response_bytes IS NULL OR response_bytes BETWEEN 0 AND 65536),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  CHECK (
    (response_body_sha256 IS NULL AND response_bytes IS NULL)
    OR
    (response_body_sha256 IS NOT NULL AND response_bytes IS NOT NULL)
  ),
  CHECK (
    classification = 'ambiguous'
    OR (
      classification = 'accepted'
      AND http_status BETWEEN 200 AND 299
      AND response_body_sha256 IS NOT NULL
    )
    OR (
      classification = 'rejected'
      AND http_status BETWEEN 300 AND 499
      AND http_status NOT IN (408, 425, 429)
      AND response_body_sha256 IS NOT NULL
    )
  ),
  FOREIGN KEY (gateway_disable_idempotency_key_sha256)
    REFERENCES controller_deployment_gateway_disable_dispatches(
      gateway_disable_idempotency_key_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE controller_deployment_gateway_disable_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_disable_idempotency_key_sha256 TEXT NOT NULL,
  disable_status_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(disable_status_credential_id_sha256) = 'text'
      AND length(disable_status_credential_id_sha256) = 64
      AND disable_status_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  disable_status_request_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(disable_status_request_id_sha256) = 'text'
      AND length(disable_status_request_id_sha256) = 64
      AND disable_status_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  classification TEXT NOT NULL
    CHECK (
      classification IN (
        'exact_disable_observed',
        'enabled_source_observed',
        'deployment_drift',
        'ambiguous'
      )
    ),
  deployments_http_status INTEGER
    CHECK (
      deployments_http_status IS NULL
      OR deployments_http_status BETWEEN 100 AND 599
    ),
  baseline_version_http_status INTEGER
    CHECK (
      baseline_version_http_status IS NULL
      OR baseline_version_http_status BETWEEN 100 AND 599
    ),
  deployment_set_sha256 TEXT
    CHECK (
      deployment_set_sha256 IS NULL
      OR (
        typeof(deployment_set_sha256) = 'text'
        AND length(deployment_set_sha256) = 64
        AND deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  baseline_version_sha256 TEXT
    CHECK (
      baseline_version_sha256 IS NULL
      OR (
        typeof(baseline_version_sha256) = 'text'
        AND length(baseline_version_sha256) = 64
        AND baseline_version_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  response_request_id_sha256 TEXT
    CHECK (
      response_request_id_sha256 IS NULL
      OR (
        typeof(response_request_id_sha256) = 'text'
        AND length(response_request_id_sha256) = 64
        AND response_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  remote_observation_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(remote_observation_digest_sha256) = 'text'
      AND length(remote_observation_digest_sha256) = 64
      AND remote_observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  state_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(state_digest_sha256) = 'text'
      AND length(state_digest_sha256) = 64
      AND state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  observation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(observation_digest_sha256) = 'text'
      AND length(observation_digest_sha256) = 64
      AND observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  CHECK (
    classification = 'ambiguous'
    OR (
      deployments_http_status BETWEEN 200 AND 299
      AND baseline_version_http_status BETWEEN 200 AND 299
      AND deployment_set_sha256 IS NOT NULL
      AND baseline_version_sha256 IS NOT NULL
    )
  ),
  UNIQUE (
    gateway_disable_idempotency_key_sha256,
    disable_status_request_id_sha256
  ),
  FOREIGN KEY (gateway_disable_idempotency_key_sha256)
    REFERENCES controller_deployment_gateway_disable_dispatches(
      gateway_disable_idempotency_key_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX idx_controller_deployment_gateway_disable_observations_operation
ON controller_deployment_gateway_disable_observations(
  gateway_disable_idempotency_key_sha256,
  observation_id
);

CREATE TRIGGER controller_deployment_gateway_disable_operation_insert_guard
BEFORE INSERT ON controller_deployment_gateway_disable_operations
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'disable operation time must come from D1') END;
END;

CREATE TRIGGER controller_deployment_gateway_disable_dispatch_insert_guard
BEFORE INSERT ON controller_deployment_gateway_disable_dispatches
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.authorized_at <> unixepoch()
  THEN RAISE(ABORT, 'disable dispatch time must come from D1') END;
END;

CREATE TRIGGER controller_deployment_gateway_disable_outcome_insert_guard
BEFORE INSERT ON controller_deployment_gateway_disable_outcomes
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'disable outcome time must come from D1') END;
END;

CREATE TRIGGER controller_deployment_gateway_disable_observation_insert_guard
BEFORE INSERT ON controller_deployment_gateway_disable_observations
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'disable observation time must come from D1') END;
END;

CREATE TRIGGER controller_deployment_gateway_disable_operation_update_guard
BEFORE UPDATE ON controller_deployment_gateway_disable_operations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable operations are immutable');
END;

CREATE TRIGGER controller_deployment_gateway_disable_operation_delete_guard
BEFORE DELETE ON controller_deployment_gateway_disable_operations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable operations are append-preserved');
END;

CREATE TRIGGER controller_deployment_gateway_disable_dispatch_update_guard
BEFORE UPDATE ON controller_deployment_gateway_disable_dispatches
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable dispatches are immutable');
END;

CREATE TRIGGER controller_deployment_gateway_disable_dispatch_delete_guard
BEFORE DELETE ON controller_deployment_gateway_disable_dispatches
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable dispatches are append-preserved');
END;

CREATE TRIGGER controller_deployment_gateway_disable_outcome_update_guard
BEFORE UPDATE ON controller_deployment_gateway_disable_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable outcomes are immutable');
END;

CREATE TRIGGER controller_deployment_gateway_disable_outcome_delete_guard
BEFORE DELETE ON controller_deployment_gateway_disable_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable outcomes are append-preserved');
END;

CREATE TRIGGER controller_deployment_gateway_disable_observation_update_guard
BEFORE UPDATE ON controller_deployment_gateway_disable_observations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable observations are immutable');
END;

CREATE TRIGGER controller_deployment_gateway_disable_observation_delete_guard
BEFORE DELETE ON controller_deployment_gateway_disable_observations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'disable observations are append-preserved');
END;
