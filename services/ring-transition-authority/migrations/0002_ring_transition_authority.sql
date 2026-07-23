-- Apply only after every 0059 runner is disabled and no active transition
-- claim remains. The transport-outcome enforcement is intentionally
-- incompatible with an old writer that omits the new evidence column.

CREATE TABLE migration_0060_ring_transition_authority_drain_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

INSERT INTO migration_0060_ring_transition_authority_drain_guard (active_count)
SELECT COUNT(*)
FROM relay_container_ring_transition_claims
WHERE status IN (
  'claimed',
  't1_verified',
  'controller_inflight',
  'controller_verified',
  'edge_prechecked',
  'edge_inflight'
);

DROP TABLE migration_0060_ring_transition_authority_drain_guard;

ALTER TABLE relay_container_ring_transition_steps
ADD COLUMN transport_outcome TEXT NOT NULL DEFAULT 'not_applicable'
  CHECK (transport_outcome IN (
    'not_applicable',
    'success',
    'ambiguous',
    'rejected'
  ));

CREATE TABLE relay_container_ring_transition_expiry_events (
  authorization_id_sha256 TEXT NOT NULL,
  state_version INTEGER NOT NULL
    CHECK (typeof(state_version) = 'integer' AND state_version BETWEEN 1 AND 6),
  from_status TEXT NOT NULL
    CHECK (from_status IN (
      'claimed',
      't1_verified',
      'controller_verified',
      'edge_prechecked'
    )),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('expired', 'recovery_required')),
  authority_actor_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_actor_id_sha256) = 'text'
      AND length(authority_actor_id_sha256) = 64
      AND authority_actor_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      typeof(evidence_sha256) = 'text'
      AND length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  expiry_event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(expiry_event_digest_sha256) = 'text'
      AND length(expiry_event_digest_sha256) = 64
      AND expiry_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  failure_class TEXT NOT NULL
    CHECK (failure_class = 'authorization_expired'),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  PRIMARY KEY (authorization_id_sha256, state_version),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_ring_transition_claims(authorization_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_ring_transition_expiry_recorded
ON relay_container_ring_transition_expiry_events(recorded_at, authorization_id_sha256);

DROP TRIGGER relay_container_ring_transition_claim_update_guard;

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
    UNION ALL
    SELECT 1
    FROM relay_container_ring_transition_expiry_events AS expiry
    WHERE expiry.authorization_id_sha256 = OLD.authorization_id_sha256
      AND expiry.state_version = NEW.state_version
      AND expiry.from_status = OLD.status
      AND expiry.to_status = NEW.status
      AND expiry.authority_actor_id_sha256 <> OLD.claim_owner_sha256
      AND expiry.recorded_at = unixepoch()
  ) THEN RAISE(ABORT, 'ring transition claim state requires matching authority evidence') END;

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

DROP TRIGGER relay_container_ring_transition_step_insert_guard;

CREATE TRIGGER relay_container_ring_transition_step_insert_guard
BEFORE INSERT ON relay_container_ring_transition_steps
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    typeof(NEW.actor_execution_id_sha256) <> 'text'
    OR typeof(NEW.evidence_sha256) <> 'text'
    OR typeof(NEW.step_digest_sha256) <> 'text'
    OR typeof(NEW.transport_outcome) <> 'text'
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
      AND unixepoch() < claim.expires_at
      AND (
        NEW.to_status = 'expired'
        OR NEW.failure_class = 'authorization_expired'
      )
  ) THEN RAISE(ABORT, 'ring transition claim is not expired') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_ring_transition_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
      AND unixepoch() >= claim.expires_at
      AND claim.status NOT IN ('controller_inflight', 'edge_inflight')
      AND NOT (
        NEW.step_code = 'terminal'
        AND NEW.failure_class = 'authorization_expired'
        AND (
          (
            NEW.from_status IN ('claimed', 't1_verified')
            AND NEW.to_status = 'expired'
          )
          OR
          (
            NEW.from_status IN ('controller_verified', 'edge_prechecked')
            AND NEW.to_status = 'recovery_required'
          )
        )
      )
  ) THEN RAISE(ABORT, 'ring transition claim expired before the next mutation step') END;

  SELECT CASE WHEN
    NEW.step_code = 'controller_post_readback'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_ring_transition_steps AS intent
      WHERE intent.authorization_id_sha256 = NEW.authorization_id_sha256
        AND intent.state_version = NEW.state_version - 1
        AND intent.step_code = 'controller_mutation_intent'
        AND intent.mutation_request_sha256 = NEW.mutation_request_sha256
    )
  THEN RAISE(ABORT, 'controller post-readback does not match persisted mutation intent') END;

  SELECT CASE WHEN
    NEW.step_code = 'edge_post_readback'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_ring_transition_steps AS intent
      WHERE intent.authorization_id_sha256 = NEW.authorization_id_sha256
        AND intent.state_version = NEW.state_version - 1
        AND intent.step_code = 'edge_mutation_intent'
        AND intent.mutation_request_sha256 = NEW.mutation_request_sha256
    )
  THEN RAISE(ABORT, 'edge post-readback does not match persisted mutation intent') END;

  SELECT CASE WHEN NOT (
    (
      NEW.step_code = 't1_readback'
      AND NEW.from_status = 'claimed'
      AND NEW.to_status IN ('t1_verified', 'aborted')
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND NEW.transport_outcome = 'not_applicable'
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
      AND NEW.transport_outcome = 'not_applicable'
      AND NEW.failure_class = ''
    )
    OR (
      NEW.step_code = 'controller_post_readback'
      AND NEW.from_status = 'controller_inflight'
      AND NEW.to_status IN ('controller_verified', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND NEW.transport_outcome IN ('success', 'ambiguous', 'rejected')
      AND (
        (
          NEW.to_status = 'controller_verified'
          AND NEW.transport_outcome IN ('success', 'ambiguous')
          AND NEW.failure_class = ''
        )
        OR
        (
          NEW.to_status = 'recovery_required'
          AND (
            (
              NEW.transport_outcome = 'rejected'
              AND NEW.failure_class = 'http_rejected'
            )
            OR
            (
              NEW.transport_outcome IN ('success', 'ambiguous')
              AND NEW.failure_class <> ''
            )
          )
        )
      )
    )
    OR (
      NEW.step_code = 'edge_pre_readback'
      AND NEW.from_status = 'controller_verified'
      AND NEW.to_status IN ('edge_prechecked', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND NEW.transport_outcome = 'not_applicable'
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
      AND NEW.transport_outcome = 'not_applicable'
      AND NEW.failure_class = ''
    )
    OR (
      NEW.step_code = 'edge_post_readback'
      AND NEW.from_status = 'edge_inflight'
      AND NEW.to_status IN ('completed', 'recovery_required')
      AND NEW.mutation_request_sha256 IS NOT NULL
      AND NEW.deployment_set_sha256 IS NOT NULL
      AND NEW.transport_outcome IN ('success', 'ambiguous', 'rejected')
      AND (
        (
          NEW.to_status = 'completed'
          AND NEW.transport_outcome IN ('success', 'ambiguous')
          AND NEW.failure_class = ''
        )
        OR
        (
          NEW.to_status = 'recovery_required'
          AND (
            (
              NEW.transport_outcome = 'rejected'
              AND NEW.failure_class = 'http_rejected'
            )
            OR
            (
              NEW.transport_outcome IN ('success', 'ambiguous')
              AND NEW.failure_class <> ''
            )
          )
        )
      )
    )
    OR (
      NEW.step_code = 'terminal'
      AND (
        (
          NEW.from_status IN ('claimed', 't1_verified')
          AND (
            (NEW.to_status = 'aborted' AND NEW.failure_class = 'operator_abort')
            OR
            (NEW.to_status = 'expired' AND NEW.failure_class = 'authorization_expired')
          )
        )
        OR
        (
          NEW.from_status = 'edge_prechecked'
          AND NEW.to_status = 'recovery_required'
          AND NEW.failure_class = 'operator_abort'
        )
        OR
        (
          NEW.from_status IN ('controller_verified', 'edge_prechecked')
          AND NEW.to_status = 'recovery_required'
          AND NEW.failure_class = 'authorization_expired'
        )
      )
      AND NEW.mutation_request_sha256 IS NULL
      AND NEW.deployment_set_sha256 IS NULL
      AND NEW.transport_outcome = 'not_applicable'
    )
  ) THEN RAISE(ABORT, 'ring transition step lifecycle evidence is invalid') END;
END;

CREATE TRIGGER relay_container_ring_transition_expiry_insert_guard
BEFORE INSERT ON relay_container_ring_transition_expiry_events
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'ring transition expiry time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_ring_transition_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
      AND claim.status = NEW.from_status
      AND claim.state_version + 1 = NEW.state_version
      AND claim.claim_owner_sha256 <> NEW.authority_actor_id_sha256
      AND unixepoch() >= claim.expires_at
  ) THEN RAISE(ABORT, 'ring transition expiry does not match an expired active claim') END;

  SELECT CASE WHEN NOT (
    (
      NEW.from_status IN ('claimed', 't1_verified')
      AND NEW.to_status = 'expired'
    )
    OR
    (
      NEW.from_status IN ('controller_verified', 'edge_prechecked')
      AND NEW.to_status = 'recovery_required'
    )
  ) THEN RAISE(ABORT, 'ring transition expiry lifecycle evidence is invalid') END;
END;

CREATE TRIGGER relay_container_ring_transition_expiry_apply
AFTER INSERT ON relay_container_ring_transition_expiry_events
FOR EACH ROW
BEGIN
  UPDATE relay_container_ring_transition_claims
  SET
    status = NEW.to_status,
    state_version = NEW.state_version,
    updated_at = unixepoch(),
    terminal_at = unixepoch()
  WHERE authorization_id_sha256 = NEW.authorization_id_sha256
    AND status = NEW.from_status
    AND state_version = NEW.state_version - 1;
END;

CREATE TRIGGER relay_container_ring_transition_expiry_update_guard
BEFORE UPDATE ON relay_container_ring_transition_expiry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ring transition expiry evidence is immutable');
END;

CREATE TRIGGER relay_container_ring_transition_expiry_delete_guard
BEFORE DELETE ON relay_container_ring_transition_expiry_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ring transition expiry evidence is append-preserved');
END;
