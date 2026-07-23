CREATE TABLE relay_container_ring_transition_claims (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(execution_nonce_sha256) = 'text'
      AND length(execution_nonce_sha256) = 64
      AND execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_contract TEXT NOT NULL
    CHECK (claim_contract = 'd1-unique-claim-v1'),
  claim_scope TEXT NOT NULL
    CHECK (claim_scope = 'staging-worker-ring-transition'),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  authorization_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(authorization_manifest_sha256) = 64
      AND authorization_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorization_subject_sha256 TEXT NOT NULL
    CHECK (
      length(authorization_subject_sha256) = 64
      AND authorization_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorization_policy_sha256 TEXT NOT NULL
    CHECK (
      length(authorization_policy_sha256) = 64
      AND authorization_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transition_manifest_sha256 TEXT NOT NULL
    CHECK (
      length(transition_manifest_sha256) = 64
      AND transition_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transition_subject_sha256 TEXT NOT NULL
    CHECK (
      length(transition_subject_sha256) = 64
      AND transition_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transition_policy_sha256 TEXT NOT NULL
    CHECK (
      length(transition_policy_sha256) = 64
      AND transition_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transition_plan_sha256 TEXT NOT NULL
    CHECK (
      length(transition_plan_sha256) = 64
      AND transition_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  candidate_sha256 TEXT NOT NULL
    CHECK (
      length(candidate_sha256) = 64
      AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_plan_sha256 TEXT NOT NULL
    CHECK (
      length(execution_plan_sha256) = 64
      AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  account_id_sha256 TEXT NOT NULL
    CHECK (
      length(account_id_sha256) = 64
      AND account_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      length(ledger_identity_sha256) = 64
      AND ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  read_credential_id_sha256 TEXT NOT NULL
    CHECK (
      length(read_credential_id_sha256) = 64
      AND read_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_credential_id_sha256 TEXT NOT NULL
    CHECK (
      length(claim_credential_id_sha256) = 64
      AND claim_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  deploy_credential_id_sha256 TEXT NOT NULL
    CHECK (
      length(deploy_credential_id_sha256) = 64
      AND deploy_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_service_name TEXT NOT NULL
    CHECK (
      length(controller_service_name) BETWEEN 1 AND 63
      AND controller_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  controller_previous_version_id TEXT NOT NULL
    CHECK (length(controller_previous_version_id) BETWEEN 1 AND 128),
  controller_previous_deployment_set_sha256 TEXT NOT NULL
    CHECK (
      length(controller_previous_deployment_set_sha256) = 64
      AND controller_previous_deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_target_version_id TEXT NOT NULL
    CHECK (length(controller_target_version_id) BETWEEN 1 AND 128),
  edge_service_name TEXT NOT NULL
    CHECK (
      length(edge_service_name) BETWEEN 1 AND 63
      AND edge_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  edge_previous_version_id TEXT NOT NULL
    CHECK (length(edge_previous_version_id) BETWEEN 1 AND 128),
  edge_previous_deployment_set_sha256 TEXT NOT NULL
    CHECK (
      length(edge_previous_deployment_set_sha256) = 64
      AND edge_previous_deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  edge_target_version_id TEXT NOT NULL
    CHECK (length(edge_target_version_id) BETWEEN 1 AND 128),
  runner_build_sha256 TEXT NOT NULL
    CHECK (
      length(runner_build_sha256) = 64
      AND runner_build_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  runner_trust_config_sha256 TEXT NOT NULL
    CHECK (
      length(runner_trust_config_sha256) = 64
      AND runner_trust_config_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_owner_sha256 TEXT NOT NULL
    CHECK (
      length(claim_owner_sha256) = 64
      AND claim_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL
    CHECK (status IN (
      'claimed',
      't1_verified',
      'controller_inflight',
      'controller_verified',
      'edge_prechecked',
      'edge_inflight',
      'completed',
      'recovery_required',
      'aborted',
      'expired'
    )),
  state_version INTEGER NOT NULL
    CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 0 AND 6),
  generated_at INTEGER NOT NULL CHECK (typeof(generated_at) = 'integer'),
  claimed_at INTEGER NOT NULL CHECK (typeof(claimed_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  terminal_at INTEGER CHECK (terminal_at IS NULL OR typeof(terminal_at) = 'integer'),
  CHECK (authorization_id_sha256 <> execution_nonce_sha256),
  CHECK (
    read_credential_id_sha256 <> claim_credential_id_sha256
    AND read_credential_id_sha256 <> deploy_credential_id_sha256
    AND claim_credential_id_sha256 <> deploy_credential_id_sha256
  ),
  CHECK (controller_previous_version_id <> controller_target_version_id),
  CHECK (edge_previous_version_id <> edge_target_version_id),
  CHECK (
    (
      status IN ('completed', 'recovery_required', 'aborted', 'expired')
      AND terminal_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('completed', 'recovery_required', 'aborted', 'expired')
      AND terminal_at IS NULL
    )
  )
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_relay_container_ring_transition_active_scope
ON relay_container_ring_transition_claims(claim_scope)
WHERE status IN (
  'claimed',
  't1_verified',
  'controller_inflight',
  'controller_verified',
  'edge_prechecked',
  'edge_inflight'
);

CREATE INDEX idx_relay_container_ring_transition_claim_expiry
ON relay_container_ring_transition_claims(status, expires_at);

CREATE TABLE relay_container_ring_transition_steps (
  authorization_id_sha256 TEXT NOT NULL,
  state_version INTEGER NOT NULL
    CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 1 AND 6),
  step_code TEXT NOT NULL
    CHECK (step_code IN (
      't1_readback',
      'controller_mutation_intent',
      'controller_post_readback',
      'edge_pre_readback',
      'edge_mutation_intent',
      'edge_post_readback',
      'terminal'
    )),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_execution_id_sha256 TEXT NOT NULL
    CHECK (
      length(actor_execution_id_sha256) = 64
      AND actor_execution_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  mutation_request_sha256 TEXT
    CHECK (
      mutation_request_sha256 IS NULL
      OR (
        length(mutation_request_sha256) = 64
        AND mutation_request_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  cloudflare_request_id_sha256 TEXT
    CHECK (
      cloudflare_request_id_sha256 IS NULL
      OR (
        length(cloudflare_request_id_sha256) = 64
        AND cloudflare_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  deployment_set_sha256 TEXT
    CHECK (
      deployment_set_sha256 IS NULL
      OR (
        length(deployment_set_sha256) = 64
        AND deployment_set_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  failure_class TEXT NOT NULL
    CHECK (failure_class IN (
      '',
      'authorization_expired',
      'operator_abort',
      'transport_response_lost',
      'http_rejected',
      'readback_drift',
      'target_not_stable'
    )),
  step_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(step_digest_sha256) = 64
      AND step_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  PRIMARY KEY (authorization_id_sha256, state_version),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_ring_transition_claims(authorization_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_ring_transition_steps_recorded
ON relay_container_ring_transition_steps(recorded_at, authorization_id_sha256);

CREATE TRIGGER relay_container_ring_transition_claim_insert_guard
BEFORE INSERT ON relay_container_ring_transition_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    typeof(NEW.authorization_manifest_sha256) <> 'text'
    OR typeof(NEW.authorization_subject_sha256) <> 'text'
    OR typeof(NEW.authorization_policy_sha256) <> 'text'
    OR typeof(NEW.transition_manifest_sha256) <> 'text'
    OR typeof(NEW.transition_subject_sha256) <> 'text'
    OR typeof(NEW.transition_policy_sha256) <> 'text'
    OR typeof(NEW.transition_plan_sha256) <> 'text'
    OR typeof(NEW.candidate_sha256) <> 'text'
    OR typeof(NEW.execution_plan_sha256) <> 'text'
    OR typeof(NEW.account_id_sha256) <> 'text'
    OR typeof(NEW.ledger_identity_sha256) <> 'text'
    OR typeof(NEW.read_credential_id_sha256) <> 'text'
    OR typeof(NEW.claim_credential_id_sha256) <> 'text'
    OR typeof(NEW.deploy_credential_id_sha256) <> 'text'
    OR typeof(NEW.controller_service_name) <> 'text'
    OR typeof(NEW.controller_previous_version_id) <> 'text'
    OR typeof(NEW.controller_previous_deployment_set_sha256) <> 'text'
    OR typeof(NEW.controller_target_version_id) <> 'text'
    OR typeof(NEW.edge_service_name) <> 'text'
    OR typeof(NEW.edge_previous_version_id) <> 'text'
    OR typeof(NEW.edge_previous_deployment_set_sha256) <> 'text'
    OR typeof(NEW.edge_target_version_id) <> 'text'
    OR typeof(NEW.runner_build_sha256) <> 'text'
    OR typeof(NEW.runner_trust_config_sha256) <> 'text'
    OR typeof(NEW.claim_owner_sha256) <> 'text'
    OR typeof(NEW.claim_digest_sha256) <> 'text'
  THEN RAISE(ABORT, 'ring transition claim identities must be text') END;

  SELECT CASE WHEN NEW.status <> 'claimed'
    OR NEW.state_version <> 0
    OR NEW.terminal_at IS NOT NULL
  THEN RAISE(ABORT, 'ring transition claim must start in claimed state') END;

  SELECT CASE WHEN NEW.claimed_at <> unixepoch()
    OR NEW.updated_at <> unixepoch()
    OR NEW.generated_at > unixepoch()
  THEN RAISE(ABORT, 'ring transition claim time must come from D1') END;

  SELECT CASE WHEN NEW.expires_at < unixepoch() + 60
    OR NEW.expires_at > NEW.generated_at + 600
  THEN RAISE(ABORT, 'ring transition claim validity window is invalid') END;
END;

CREATE TRIGGER relay_container_ring_transition_claim_update_guard
BEFORE UPDATE ON relay_container_ring_transition_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    NEW.authorization_id_sha256 IS NOT OLD.authorization_id_sha256
    OR NEW.execution_nonce_sha256 IS NOT OLD.execution_nonce_sha256
    OR NEW.claim_contract IS NOT OLD.claim_contract
    OR NEW.claim_scope IS NOT OLD.claim_scope
    OR NEW.environment IS NOT OLD.environment
    OR NEW.authorization_manifest_sha256 IS NOT OLD.authorization_manifest_sha256
    OR NEW.authorization_subject_sha256 IS NOT OLD.authorization_subject_sha256
    OR NEW.authorization_policy_sha256 IS NOT OLD.authorization_policy_sha256
    OR NEW.transition_manifest_sha256 IS NOT OLD.transition_manifest_sha256
    OR NEW.transition_subject_sha256 IS NOT OLD.transition_subject_sha256
    OR NEW.transition_policy_sha256 IS NOT OLD.transition_policy_sha256
    OR NEW.transition_plan_sha256 IS NOT OLD.transition_plan_sha256
    OR NEW.candidate_sha256 IS NOT OLD.candidate_sha256
    OR NEW.execution_plan_sha256 IS NOT OLD.execution_plan_sha256
    OR NEW.account_id_sha256 IS NOT OLD.account_id_sha256
    OR NEW.ledger_identity_sha256 IS NOT OLD.ledger_identity_sha256
    OR NEW.read_credential_id_sha256 IS NOT OLD.read_credential_id_sha256
    OR NEW.claim_credential_id_sha256 IS NOT OLD.claim_credential_id_sha256
    OR NEW.deploy_credential_id_sha256 IS NOT OLD.deploy_credential_id_sha256
    OR NEW.controller_service_name IS NOT OLD.controller_service_name
    OR NEW.controller_previous_version_id IS NOT OLD.controller_previous_version_id
    OR NEW.controller_previous_deployment_set_sha256 IS NOT OLD.controller_previous_deployment_set_sha256
    OR NEW.controller_target_version_id IS NOT OLD.controller_target_version_id
    OR NEW.edge_service_name IS NOT OLD.edge_service_name
    OR NEW.edge_previous_version_id IS NOT OLD.edge_previous_version_id
    OR NEW.edge_previous_deployment_set_sha256 IS NOT OLD.edge_previous_deployment_set_sha256
    OR NEW.edge_target_version_id IS NOT OLD.edge_target_version_id
    OR NEW.runner_build_sha256 IS NOT OLD.runner_build_sha256
    OR NEW.runner_trust_config_sha256 IS NOT OLD.runner_trust_config_sha256
    OR NEW.claim_owner_sha256 IS NOT OLD.claim_owner_sha256
    OR NEW.claim_digest_sha256 IS NOT OLD.claim_digest_sha256
    OR NEW.generated_at IS NOT OLD.generated_at
    OR NEW.claimed_at IS NOT OLD.claimed_at
    OR NEW.expires_at IS NOT OLD.expires_at
  THEN RAISE(ABORT, 'ring transition claim identity is immutable') END;

  SELECT CASE WHEN NEW.state_version <> OLD.state_version + 1
    OR NEW.updated_at <> unixepoch()
  THEN RAISE(ABORT, 'ring transition claim state version is invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_ring_transition_steps AS step
    WHERE step.authorization_id_sha256 = OLD.authorization_id_sha256
      AND step.state_version = NEW.state_version
      AND step.from_status = OLD.status
      AND step.to_status = NEW.status
      AND step.actor_execution_id_sha256 = OLD.claim_owner_sha256
      AND step.recorded_at = unixepoch()
  ) THEN RAISE(ABORT, 'ring transition claim state requires matching step evidence') END;

  SELECT CASE WHEN
    (
      NEW.status IN ('completed', 'recovery_required', 'aborted', 'expired')
      AND NEW.terminal_at <> unixepoch()
    )
    OR
    (
      NEW.status NOT IN ('completed', 'recovery_required', 'aborted', 'expired')
      AND NEW.terminal_at IS NOT NULL
    )
  THEN RAISE(ABORT, 'ring transition claim terminal time is invalid') END;

  SELECT CASE WHEN NOT (
    (OLD.status = 'claimed' AND NEW.status IN ('t1_verified', 'aborted', 'expired'))
    OR (OLD.status = 't1_verified' AND NEW.status IN ('controller_inflight', 'aborted', 'expired'))
    OR (OLD.status = 'controller_inflight' AND NEW.status IN ('controller_verified', 'recovery_required'))
    OR (OLD.status = 'controller_verified' AND NEW.status IN ('edge_prechecked', 'recovery_required'))
    OR (OLD.status = 'edge_prechecked' AND NEW.status IN ('edge_inflight', 'recovery_required'))
    OR (OLD.status = 'edge_inflight' AND NEW.status IN ('completed', 'recovery_required'))
  ) THEN RAISE(ABORT, 'ring transition claim lifecycle transition is invalid') END;
END;

CREATE TRIGGER relay_container_ring_transition_claim_delete_guard
BEFORE DELETE ON relay_container_ring_transition_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ring transition claims are append-preserved');
END;

CREATE TRIGGER relay_container_ring_transition_step_insert_guard
BEFORE INSERT ON relay_container_ring_transition_steps
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    typeof(NEW.actor_execution_id_sha256) <> 'text'
    OR typeof(NEW.evidence_sha256) <> 'text'
    OR typeof(NEW.step_digest_sha256) <> 'text'
    OR (
      NEW.mutation_request_sha256 IS NOT NULL
      AND typeof(NEW.mutation_request_sha256) <> 'text'
    )
    OR (
      NEW.cloudflare_request_id_sha256 IS NOT NULL
      AND typeof(NEW.cloudflare_request_id_sha256) <> 'text'
    )
    OR (
      NEW.deployment_set_sha256 IS NOT NULL
      AND typeof(NEW.deployment_set_sha256) <> 'text'
    )
  THEN RAISE(ABORT, 'ring transition step identities must be text') END;

  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'ring transition step time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_ring_transition_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
      AND claim.status = NEW.from_status
      AND claim.state_version + 1 = NEW.state_version
      AND claim.claim_owner_sha256 = NEW.actor_execution_id_sha256
  ) THEN RAISE(ABORT, 'ring transition step does not own the current claim state') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_ring_transition_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
      AND unixepoch() >= claim.expires_at
      AND claim.status NOT IN ('controller_inflight', 'edge_inflight')
      AND NOT (
        NEW.step_code = 'terminal'
        AND NEW.to_status = 'expired'
        AND NEW.failure_class = 'authorization_expired'
      )
  ) THEN RAISE(ABORT, 'ring transition claim expired before the next mutation step') END;

  SELECT CASE WHEN NOT (
    (
      NEW.step_code = 't1_readback'
      AND NEW.from_status = 'claimed'
      AND NEW.to_status IN ('t1_verified', 'aborted')
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND (
        (NEW.to_status = 't1_verified' AND NEW.failure_class = '')
        OR
        (NEW.to_status = 'aborted' AND NEW.failure_class = 'readback_drift')
      )
    )
    OR (
      NEW.step_code = 'controller_mutation_intent'
      AND NEW.from_status = 't1_verified'
      AND NEW.to_status = 'controller_inflight'
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NULL
      AND NEW.failure_class = ''
    )
    OR (
      NEW.step_code = 'controller_post_readback'
      AND NEW.from_status = 'controller_inflight'
      AND NEW.to_status IN ('controller_verified', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND (
        (NEW.to_status = 'controller_verified' AND NEW.failure_class = '')
        OR
        (NEW.to_status = 'recovery_required' AND NEW.failure_class <> '')
      )
    )
    OR (
      NEW.step_code = 'edge_pre_readback'
      AND NEW.from_status = 'controller_verified'
      AND NEW.to_status IN ('edge_prechecked', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND (
        (NEW.to_status = 'edge_prechecked' AND NEW.failure_class = '')
        OR
        (
          NEW.to_status = 'recovery_required'
          AND NEW.failure_class = 'readback_drift'
        )
      )
    )
    OR (
      NEW.step_code = 'edge_mutation_intent'
      AND NEW.from_status = 'edge_prechecked'
      AND NEW.to_status = 'edge_inflight'
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NULL
      AND NEW.failure_class = ''
    )
    OR (
      NEW.step_code = 'edge_post_readback'
      AND NEW.from_status = 'edge_inflight'
      AND NEW.to_status IN ('completed', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND (
        (NEW.to_status = 'completed' AND NEW.failure_class = '')
        OR
        (NEW.to_status = 'recovery_required' AND NEW.failure_class <> '')
      )
    )
    OR (
      NEW.step_code = 'terminal'
      AND NEW.from_status IN ('claimed', 't1_verified', 'edge_prechecked')
      AND (
        (NEW.to_status = 'aborted' AND NEW.failure_class = 'operator_abort')
        OR
        (NEW.to_status = 'expired' AND NEW.failure_class = 'authorization_expired')
        OR
        (
          NEW.from_status = 'edge_prechecked'
          AND NEW.to_status = 'recovery_required'
          AND NEW.failure_class = 'operator_abort'
        )
      )
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NULL
    )
  ) THEN RAISE(ABORT, 'ring transition step lifecycle evidence is invalid') END;
END;

CREATE TRIGGER relay_container_ring_transition_step_apply
AFTER INSERT ON relay_container_ring_transition_steps
FOR EACH ROW
BEGIN
  UPDATE relay_container_ring_transition_claims
  SET
    status = NEW.to_status,
    state_version = NEW.state_version,
    updated_at = unixepoch(),
    terminal_at = CASE
      WHEN NEW.to_status IN ('completed', 'recovery_required', 'aborted', 'expired')
      THEN unixepoch()
      ELSE NULL
    END
  WHERE authorization_id_sha256 = NEW.authorization_id_sha256
    AND status = NEW.from_status
    AND state_version = NEW.state_version - 1;
END;

CREATE TRIGGER relay_container_ring_transition_step_update_guard
BEFORE UPDATE ON relay_container_ring_transition_steps
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ring transition steps are immutable');
END;

CREATE TRIGGER relay_container_ring_transition_step_delete_guard
BEFORE DELETE ON relay_container_ring_transition_steps
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ring transition steps are append-preserved');
END;
