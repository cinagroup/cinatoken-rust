PRAGMA foreign_keys = ON;

CREATE TABLE json_compatibility_deployment_mutation_claims (
  mutation_intent_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (length(mutation_intent_sha256) = 64 AND mutation_intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  mutation_rpc_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(mutation_rpc_request_sha256) = 64 AND mutation_rpc_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_id_sha256 TEXT NOT NULL
    CHECK (length(operation_id_sha256) = 64 AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_digest_sha256 TEXT NOT NULL
    CHECK (length(operation_digest_sha256) = 64 AND operation_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorized_request_sha256 TEXT NOT NULL
    CHECK (length(authorized_request_sha256) = 64 AND authorized_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  campaign_plan_digest_sha256 TEXT NOT NULL
    CHECK (length(campaign_plan_digest_sha256) = 64 AND campaign_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  state_plan_digest_sha256 TEXT NOT NULL
    CHECK (length(state_plan_digest_sha256) = 64 AND state_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  execution_authority_sha256 TEXT NOT NULL
    CHECK (length(execution_authority_sha256) = 64 AND execution_authority_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_authentication_digest_sha256 TEXT NOT NULL
    CHECK (length(source_authentication_digest_sha256) = 64 AND source_authentication_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_readback_set_sha256 TEXT NOT NULL
    CHECK (length(source_readback_set_sha256) = 64 AND source_readback_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_intent TEXT NOT NULL CHECK (length(canonical_intent) BETWEEN 2 AND 262144),
  exact_request_body TEXT NOT NULL CHECK (
    length(exact_request_body) BETWEEN 2 AND 4096
    AND instr(exact_request_body, '"force"') = 0
  ),
  mutation_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(mutation_request_sha256) = 64 AND mutation_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  mutation_annotation TEXT NOT NULL UNIQUE CHECK (length(mutation_annotation) BETWEEN 1 AND 512),
  mutation_annotation_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(mutation_annotation_sha256) = 64 AND mutation_annotation_sha256 NOT GLOB '*[^0-9a-f]*'),
  endpoint_path TEXT NOT NULL CHECK (
    length(endpoint_path) BETWEEN 1 AND 1024
    AND substr(endpoint_path, 1, 20) = '/client/v4/accounts/'
    AND instr(substr(endpoint_path, 21), '/workers/scripts/') > 1
    AND substr(endpoint_path, -12) = '/deployments'
  ),
  endpoint_sha256 TEXT NOT NULL
    CHECK (length(endpoint_sha256) = 64 AND endpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_role TEXT NOT NULL CHECK (
    target_role IN ('controller', 'executor', 'permitIssuer', 'invoker', 'operator', 'runner', 'caller')
  ),
  target_service_name TEXT NOT NULL CHECK (length(target_service_name) BETWEEN 1 AND 128),
  target_entrypoint TEXT NOT NULL CHECK (length(target_entrypoint) BETWEEN 1 AND 128),
  target_version_id TEXT NOT NULL CHECK (length(target_version_id) BETWEEN 1 AND 128),
  target_config_sha256 TEXT NOT NULL
    CHECK (length(target_config_sha256) = 64 AND target_config_sha256 NOT GLOB '*[^0-9a-f]*'),
  mutation_service_identity_json TEXT NOT NULL
    CHECK (length(mutation_service_identity_json) BETWEEN 2 AND 4096),
  mutation_service_identity_sha256 TEXT NOT NULL
    CHECK (length(mutation_service_identity_sha256) = 64 AND mutation_service_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
  credential_id_sha256 TEXT NOT NULL
    CHECK (length(credential_id_sha256) = 64 AND credential_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  authentication_identity_sha256 TEXT NOT NULL
    CHECK (length(authentication_identity_sha256) = 64 AND authentication_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_id_sha256 TEXT NOT NULL
    CHECK (length(account_id_sha256) = 64 AND account_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  mutator_service_name TEXT NOT NULL CHECK (length(mutator_service_name) BETWEEN 1 AND 128),
  mutator_entrypoint TEXT NOT NULL
    CHECK (mutator_entrypoint = 'JsonCompatibilityDeploymentMutationEntrypoint'),
  mutator_version_id TEXT NOT NULL CHECK (length(mutator_version_id) BETWEEN 1 AND 128),
  mutator_profile_version INTEGER NOT NULL CHECK (mutator_profile_version = 1),
  dispatch_semantics TEXT NOT NULL CHECK (
    dispatch_semantics = 'fresh_create_once_claim_only_network_may_not_have_occurred'
  ),
  claimed_at INTEGER NOT NULL CHECK (typeof(claimed_at) = 'integer'),
  CHECK (
    (target_role = 'controller'
      AND target_service_name = 'cinatoken-container-controller-staging'
      AND target_entrypoint = 'JsonCompatibilityProbeEntrypoint')
    OR (target_role = 'executor'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-executor-staging'
      AND target_entrypoint = 'JsonCompatibilityCampaignExecutorEntrypoint')
    OR (target_role = 'permitIssuer'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-permit-issuer-staging'
      AND target_entrypoint = 'JsonCompatibilityPermitIssuerEntrypoint')
    OR (target_role = 'invoker'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-invoker-staging'
      AND target_entrypoint = 'JsonCompatibilityCampaignInvokerEntrypoint')
    OR (target_role = 'operator'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-operator-staging'
      AND target_entrypoint = 'JsonCompatibilityCampaignOperatorEntrypoint')
    OR (target_role = 'runner'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-runner-staging'
      AND target_entrypoint = 'JsonCompatibilityCampaignRunnerEntrypoint')
    OR (target_role = 'caller'
      AND target_service_name = 'cinatoken-container-runtime-json-compatibility-caller-staging'
      AND target_entrypoint = 'JsonCompatibilityCampaignCallerEntrypoint')
  )
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_mutation_outcomes (
  mutation_intent_sha256 TEXT PRIMARY KEY NOT NULL,
  outcome_json TEXT NOT NULL CHECK (length(outcome_json) BETWEEN 2 AND 16384),
  outcome_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(outcome_digest_sha256) = 64 AND outcome_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK (classification IN ('accepted', 'rejected', 'ambiguous')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_body_sha256 TEXT CHECK (
    response_body_sha256 IS NULL
    OR (length(response_body_sha256) = 64 AND response_body_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  response_request_id_sha256 TEXT CHECK (
    response_request_id_sha256 IS NULL
    OR (length(response_request_id_sha256) = 64 AND response_request_id_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes BETWEEN 0 AND 65536),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  CHECK (
    (response_body_sha256 IS NULL AND response_bytes IS NULL)
    OR (response_body_sha256 IS NOT NULL AND response_bytes IS NOT NULL)
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
  FOREIGN KEY (mutation_intent_sha256)
    REFERENCES json_compatibility_deployment_mutation_claims(mutation_intent_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER json_compatibility_deployment_mutation_claim_insert_guard
BEFORE INSERT ON json_compatibility_deployment_mutation_claims
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.claimed_at <> unixepoch()
    THEN RAISE(ABORT, 'mutation claim time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_mutation_outcome_insert_guard
BEFORE INSERT ON json_compatibility_deployment_mutation_outcomes
FOR EACH ROW BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
    THEN RAISE(ABORT, 'mutation outcome time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_mutation_claim_update_guard
BEFORE UPDATE ON json_compatibility_deployment_mutation_claims
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'mutation claims are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_mutation_claim_delete_guard
BEFORE DELETE ON json_compatibility_deployment_mutation_claims
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'mutation claims are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_mutation_outcome_update_guard
BEFORE UPDATE ON json_compatibility_deployment_mutation_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'mutation outcomes are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_mutation_outcome_delete_guard
BEFORE DELETE ON json_compatibility_deployment_mutation_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'mutation outcomes are append-preserved');
END;
