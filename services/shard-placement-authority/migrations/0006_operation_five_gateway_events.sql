CREATE TABLE shard_placement_authority_operation_five_gateway_events (
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
  send_started_event_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(send_started_event_digest_sha256) = 'text'
      AND length(send_started_event_digest_sha256) = 64
      AND send_started_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  event_sequence INTEGER NOT NULL
    CHECK (
      typeof(event_sequence) = 'integer'
      AND event_sequence BETWEEN 2 AND 9007199254740991
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  event_contract TEXT NOT NULL
    CHECK (
      event_contract =
        'cinatoken-shard-placement-authority-operation-five-gateway-event-v1'
    ),
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'gateway_create_dispatched',
        'gateway_create_accepted',
        'gateway_create_rejected',
        'gateway_create_ambiguous',
        'gateway_status_target',
        'gateway_status_baseline',
        'gateway_status_drift',
        'gateway_status_ambiguous',
        'gateway_status_stable'
      )
    ),
  predecessor_event_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_event_digest_sha256) = 'text'
      AND length(predecessor_event_digest_sha256) = 64
      AND predecessor_event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_idempotency_key_sha256 TEXT NOT NULL
    CHECK (
      typeof(gateway_idempotency_key_sha256) = 'text'
      AND length(gateway_idempotency_key_sha256) = 64
      AND gateway_idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  controller_command_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(controller_command_digest_sha256) = 'text'
      AND length(controller_command_digest_sha256) = 64
      AND controller_command_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_credential_role TEXT NOT NULL
    CHECK (gateway_credential_role IN ('create', 'status')),
  gateway_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(gateway_credential_id_sha256) = 'text'
      AND length(gateway_credential_id_sha256) = 64
      AND gateway_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_request_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(gateway_request_id_sha256) = 'text'
      AND length(gateway_request_id_sha256) = 64
      AND gateway_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  gateway_response_sha256 TEXT
    CHECK (
      gateway_response_sha256 IS NULL
      OR (
        typeof(gateway_response_sha256) = 'text'
        AND length(gateway_response_sha256) = 64
        AND gateway_response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  gateway_response_bytes INTEGER
    CHECK (
      gateway_response_bytes IS NULL
      OR (
        typeof(gateway_response_bytes) = 'integer'
        AND gateway_response_bytes BETWEEN 1 AND 65536
      )
    ),
  gateway_version_id TEXT
    CHECK (
      gateway_version_id IS NULL
      OR (
        typeof(gateway_version_id) = 'text'
        AND length(gateway_version_id) BETWEEN 1 AND 128
        AND gateway_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
  mutation_request_sha256 TEXT
    CHECK (
      mutation_request_sha256 IS NULL
      OR (
        typeof(mutation_request_sha256) = 'text'
        AND length(mutation_request_sha256) = 64
        AND mutation_request_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  result_classification TEXT
    CHECK (
      result_classification IS NULL
      OR result_classification IN ('accepted', 'rejected', 'ambiguous')
    ),
  result_http_status INTEGER
    CHECK (
      result_http_status IS NULL
      OR (
        typeof(result_http_status) = 'integer'
        AND result_http_status BETWEEN 100 AND 599
      )
    ),
  result_response_body_sha256 TEXT
    CHECK (
      result_response_body_sha256 IS NULL
      OR (
        typeof(result_response_body_sha256) = 'text'
        AND length(result_response_body_sha256) = 64
        AND result_response_body_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  result_response_request_id_sha256 TEXT
    CHECK (
      result_response_request_id_sha256 IS NULL
      OR (
        typeof(result_response_request_id_sha256) = 'text'
        AND length(result_response_request_id_sha256) = 64
        AND result_response_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  result_response_bytes INTEGER
    CHECK (
      result_response_bytes IS NULL
      OR (
        typeof(result_response_bytes) = 'integer'
        AND result_response_bytes BETWEEN 0 AND 65536
      )
    ),
  status_classification TEXT
    CHECK (
      status_classification IS NULL
      OR status_classification IN (
        'target_observed',
        'baseline_observed',
        'deployment_drift',
        'ambiguous'
      )
    ),
  deployments_http_status INTEGER
    CHECK (
      deployments_http_status IS NULL
      OR (
        typeof(deployments_http_status) = 'integer'
        AND deployments_http_status BETWEEN 100 AND 599
      )
    ),
  version_http_status INTEGER
    CHECK (
      version_http_status IS NULL
      OR (
        typeof(version_http_status) = 'integer'
        AND version_http_status BETWEEN 100 AND 599
      )
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
  target_version_sha256 TEXT
    CHECK (
      target_version_sha256 IS NULL
      OR (
        typeof(target_version_sha256) = 'text'
        AND length(target_version_sha256) = 64
        AND target_version_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  status_response_request_id_sha256 TEXT
    CHECK (
      status_response_request_id_sha256 IS NULL
      OR (
        typeof(status_response_request_id_sha256) = 'text'
        AND length(status_response_request_id_sha256) = 64
        AND status_response_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  observation_digest_sha256 TEXT
    CHECK (
      observation_digest_sha256 IS NULL
      OR (
        typeof(observation_digest_sha256) = 'text'
        AND length(observation_digest_sha256) = 64
        AND observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  gateway_recorded_at INTEGER
    CHECK (
      gateway_recorded_at IS NULL
      OR (
        typeof(gateway_recorded_at) = 'integer'
        AND gateway_recorded_at > 0
      )
    ),
  target_stable INTEGER
    CHECK (
      target_stable IS NULL
      OR (
        typeof(target_stable) = 'integer'
        AND target_stable IN (0, 1)
      )
    ),
  required_matching_observations INTEGER
    CHECK (
      required_matching_observations IS NULL
      OR (
        typeof(required_matching_observations) = 'integer'
        AND required_matching_observations = 2
      )
    ),
  stability_minimum_seconds INTEGER
    CHECK (
      stability_minimum_seconds IS NULL
      OR (
        typeof(stability_minimum_seconds) = 'integer'
        AND stability_minimum_seconds BETWEEN 5 AND 120
      )
    ),
  stability_predecessor_observation_digest_sha256 TEXT
    CHECK (
      stability_predecessor_observation_digest_sha256 IS NULL
      OR (
        typeof(stability_predecessor_observation_digest_sha256) = 'text'
        AND length(stability_predecessor_observation_digest_sha256) = 64
        AND stability_predecessor_observation_digest_sha256
          NOT GLOB '*[^0-9a-f]*'
      )
    ),
  stability_predecessor_recorded_at INTEGER
    CHECK (
      stability_predecessor_recorded_at IS NULL
      OR (
        typeof(stability_predecessor_recorded_at) = 'integer'
        AND stability_predecessor_recorded_at > 0
      )
    ),
  event_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(event_digest_sha256) = 'text'
      AND length(event_digest_sha256) = 64
      AND event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND event_digest_sha256 <> predecessor_event_digest_sha256
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (attempt_digest_sha256, event_sequence),
  UNIQUE (authorization_id_sha256, event_sequence),
  CHECK (
    (
      gateway_response_sha256 IS NULL
      AND gateway_response_bytes IS NULL
      AND gateway_version_id IS NULL
    )
    OR (
      gateway_response_sha256 IS NOT NULL
      AND gateway_response_bytes IS NOT NULL
      AND gateway_version_id IS NOT NULL
    )
  ),
  CHECK (
    (
      result_response_body_sha256 IS NULL
      AND result_response_bytes IS NULL
    )
    OR (
      result_response_body_sha256 IS NOT NULL
      AND result_response_bytes IS NOT NULL
    )
  ),
  CHECK (
    (
      event_kind = 'gateway_create_dispatched'
      AND gateway_credential_role = 'create'
      AND mutation_request_sha256 IS NOT NULL
      AND result_classification IS NULL
      AND result_http_status IS NULL
      AND result_response_body_sha256 IS NULL
      AND result_response_request_id_sha256 IS NULL
      AND result_response_bytes IS NULL
      AND gateway_response_sha256 IS NULL
      AND status_classification IS NULL
      AND deployments_http_status IS NULL
      AND version_http_status IS NULL
      AND deployment_set_sha256 IS NULL
      AND target_version_sha256 IS NULL
      AND status_response_request_id_sha256 IS NULL
      AND observation_digest_sha256 IS NULL
      AND target_stable IS NULL
      AND required_matching_observations IS NULL
      AND stability_minimum_seconds IS NULL
      AND stability_predecessor_observation_digest_sha256 IS NULL
      AND stability_predecessor_recorded_at IS NULL
    )
    OR (
      event_kind IN (
        'gateway_create_accepted',
        'gateway_create_rejected',
        'gateway_create_ambiguous'
      )
      AND gateway_credential_role = 'create'
      AND mutation_request_sha256 IS NOT NULL
      AND result_classification IS NOT NULL
      AND status_classification IS NULL
      AND deployments_http_status IS NULL
      AND version_http_status IS NULL
      AND deployment_set_sha256 IS NULL
      AND target_version_sha256 IS NULL
      AND status_response_request_id_sha256 IS NULL
      AND observation_digest_sha256 IS NULL
      AND target_stable IS NULL
      AND required_matching_observations IS NULL
      AND stability_minimum_seconds IS NULL
      AND stability_predecessor_observation_digest_sha256 IS NULL
      AND stability_predecessor_recorded_at IS NULL
    )
    OR (
      event_kind IN (
        'gateway_status_target',
        'gateway_status_baseline',
        'gateway_status_drift',
        'gateway_status_ambiguous',
        'gateway_status_stable'
      )
      AND gateway_credential_role = 'status'
      AND mutation_request_sha256 IS NULL
      AND result_classification IS NULL
      AND result_http_status IS NULL
      AND result_response_body_sha256 IS NULL
      AND result_response_request_id_sha256 IS NULL
      AND result_response_bytes IS NULL
      AND status_classification IS NOT NULL
    )
  ),
  CHECK (
    (event_kind <> 'gateway_create_accepted'
      OR (
        result_classification = 'accepted'
        AND result_http_status BETWEEN 200 AND 299
        AND result_response_body_sha256 IS NOT NULL
        AND gateway_response_sha256 IS NOT NULL
        AND gateway_recorded_at IS NOT NULL
      ))
    AND
    (event_kind <> 'gateway_create_rejected'
      OR (
        result_classification = 'rejected'
        AND result_http_status BETWEEN 300 AND 499
        AND result_http_status NOT IN (408, 425, 429)
        AND result_response_body_sha256 IS NOT NULL
        AND gateway_response_sha256 IS NOT NULL
        AND gateway_recorded_at IS NOT NULL
      ))
    AND
    (event_kind <> 'gateway_create_ambiguous'
      OR result_classification = 'ambiguous')
  ),
  CHECK (
    event_kind <> 'gateway_create_ambiguous'
    OR gateway_response_sha256 IS NOT NULL
    OR (
      result_http_status IS NULL
      AND result_response_body_sha256 IS NULL
      AND result_response_request_id_sha256 IS NULL
      AND result_response_bytes IS NULL
    )
  ),
  CHECK (
    (event_kind <> 'gateway_status_target'
      OR (
        status_classification = 'target_observed'
        AND target_stable = 0
      ))
    AND
    (event_kind <> 'gateway_status_baseline'
      OR (
        status_classification = 'baseline_observed'
        AND target_stable = 0
      ))
    AND
    (event_kind <> 'gateway_status_drift'
      OR (
        status_classification = 'deployment_drift'
        AND target_stable = 0
      ))
    AND
    (event_kind <> 'gateway_status_ambiguous'
      OR (
        status_classification = 'ambiguous'
        AND (target_stable IS NULL OR target_stable = 0)
      ))
    AND
    (event_kind <> 'gateway_status_stable'
      OR (
        status_classification = 'target_observed'
        AND target_stable = 1
      ))
  ),
  CHECK (
    event_kind NOT IN (
      'gateway_status_target',
      'gateway_status_baseline',
      'gateway_status_drift',
      'gateway_status_stable'
    )
    OR (
      deployments_http_status BETWEEN 200 AND 299
      AND version_http_status BETWEEN 200 AND 299
      AND deployment_set_sha256 IS NOT NULL
      AND target_version_sha256 IS NOT NULL
      AND observation_digest_sha256 IS NOT NULL
      AND gateway_response_sha256 IS NOT NULL
      AND gateway_recorded_at IS NOT NULL
      AND required_matching_observations = 2
      AND stability_minimum_seconds BETWEEN 5 AND 120
    )
  ),
  CHECK (
    event_kind <> 'gateway_status_ambiguous'
    OR (
      (
        gateway_response_sha256 IS NULL
        AND deployments_http_status IS NULL
        AND version_http_status IS NULL
        AND deployment_set_sha256 IS NULL
        AND target_version_sha256 IS NULL
        AND status_response_request_id_sha256 IS NULL
        AND observation_digest_sha256 IS NULL
        AND target_stable IS NULL
        AND required_matching_observations IS NULL
        AND stability_minimum_seconds IS NULL
      )
      OR (
        gateway_response_sha256 IS NOT NULL
        AND observation_digest_sha256 IS NOT NULL
        AND gateway_recorded_at IS NOT NULL
        AND target_stable = 0
        AND required_matching_observations = 2
        AND stability_minimum_seconds BETWEEN 5 AND 120
      )
    )
  ),
  CHECK (
    (
      event_kind = 'gateway_status_stable'
      AND stability_predecessor_observation_digest_sha256 IS NOT NULL
      AND stability_predecessor_recorded_at IS NOT NULL
      AND observation_digest_sha256 =
            stability_predecessor_observation_digest_sha256
      AND gateway_recorded_at >=
            stability_predecessor_recorded_at + stability_minimum_seconds
    )
    OR (
      event_kind <> 'gateway_status_stable'
      AND stability_predecessor_observation_digest_sha256 IS NULL
      AND stability_predecessor_recorded_at IS NULL
    )
  ),
  FOREIGN KEY (authorization_id_sha256, attempt_digest_sha256)
    REFERENCES shard_placement_authority_operation_five_send_attempts(
      authorization_id_sha256,
      attempt_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (send_started_event_digest_sha256)
    REFERENCES shard_placement_authority_operation_five_send_attempt_events(
      event_digest_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (attempt_digest_sha256, event_sequence)
    REFERENCES shard_placement_authority_operation_five_send_attempt_events(
      attempt_digest_sha256,
      event_sequence
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;

CREATE UNIQUE INDEX
  idx_shard_placement_authority_operation_five_gateway_create_request
ON shard_placement_authority_operation_five_gateway_events(
  gateway_request_id_sha256
)
WHERE event_kind = 'gateway_create_dispatched';

CREATE UNIQUE INDEX
  idx_shard_placement_authority_operation_five_gateway_mutation_request
ON shard_placement_authority_operation_five_gateway_events(
  mutation_request_sha256
)
WHERE event_kind = 'gateway_create_dispatched';

CREATE UNIQUE INDEX
  idx_shard_placement_authority_operation_five_gateway_status_request
ON shard_placement_authority_operation_five_gateway_events(
  gateway_request_id_sha256
)
WHERE gateway_credential_role = 'status';

DROP TRIGGER
  shard_placement_authority_operation_five_send_attempt_event_insert_guard;

CREATE TRIGGER shard_placement_authority_operation_five_send_attempt_event_insert_guard
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
  SELECT CASE
    WHEN NEW.event_sequence = 1
      AND (
        NEW.event_kind <> 'send_started'
        OR NEW.from_state <> 'consumption_receipted'
        OR NEW.to_state <> 'send_started'
        OR NEW.event_semantics <>
             'unique_send_authority_persisted_network_may_not_have_occurred'
        OR NEW.predecessor_event_digest_sha256 <>
             '0000000000000000000000000000000000000000000000000000000000000000'
        OR NEW.controller_request_sent <> 0
        OR NEW.gateway_request_sent <> 0
      )
      THEN RAISE(
        ABORT,
        'operation_five_send_attempt_initial_event_mismatch'
      )
  END;
  SELECT CASE
    WHEN NEW.event_sequence = 1
      AND NOT EXISTS (
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
  SELECT CASE
    WHEN NEW.event_sequence > 1
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_five_gateway_events
          AS gateway_event
        WHERE gateway_event.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND gateway_event.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND gateway_event.event_sequence = NEW.event_sequence
          AND gateway_event.event_kind = NEW.event_kind
          AND gateway_event.predecessor_event_digest_sha256 =
                NEW.predecessor_event_digest_sha256
          AND gateway_event.gateway_idempotency_key_sha256 =
                NEW.gateway_idempotency_key_sha256
          AND gateway_event.controller_command_digest_sha256 =
                NEW.controller_command_digest_sha256
          AND gateway_event.event_digest_sha256 =
                NEW.event_digest_sha256
          AND gateway_event.recorded_at = NEW.recorded_at
          AND NEW.dispatch_consumption_receipt_digest_sha256 = (
            SELECT attempt.dispatch_consumption_receipt_digest_sha256
            FROM shard_placement_authority_operation_five_send_attempts
              AS attempt
            WHERE attempt.authorization_id_sha256 =
                    gateway_event.authorization_id_sha256
              AND attempt.attempt_digest_sha256 =
                    gateway_event.attempt_digest_sha256
          )
          AND NEW.from_state = (
            SELECT predecessor.to_state
            FROM
              shard_placement_authority_operation_five_send_attempt_events
                AS predecessor
            WHERE predecessor.attempt_digest_sha256 =
                    gateway_event.attempt_digest_sha256
              AND predecessor.event_sequence =
                    gateway_event.event_sequence - 1
          )
          AND NEW.to_state = gateway_event.event_kind
          AND NEW.event_semantics = CASE gateway_event.event_kind
            WHEN 'gateway_create_dispatched'
              THEN
                'unique_gateway_create_authority_persisted_network_may_not_have_occurred'
            WHEN 'gateway_create_accepted'
              THEN 'gateway_create_accepted_status_readback_required'
            WHEN 'gateway_create_rejected'
              THEN 'gateway_create_rejected_status_only'
            WHEN 'gateway_create_ambiguous'
              THEN 'gateway_create_ambiguous_status_only'
            WHEN 'gateway_status_target'
              THEN 'gateway_status_target_observed'
            WHEN 'gateway_status_baseline'
              THEN 'gateway_status_baseline_observed'
            WHEN 'gateway_status_drift'
              THEN 'gateway_status_deployment_drift'
            WHEN 'gateway_status_ambiguous'
              THEN 'gateway_status_ambiguous'
            WHEN 'gateway_status_stable'
              THEN 'gateway_status_target_stable'
          END
          AND NEW.controller_request_sent = 0
          AND NEW.gateway_request_sent = CASE
            WHEN gateway_event.event_kind = 'gateway_create_dispatched'
              THEN 0
            ELSE 1
          END
      )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_event_projection_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_gateway_event_insert_guard
BEFORE INSERT ON shard_placement_authority_operation_five_gateway_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.recorded_at <> unixepoch()
      THEN RAISE(
        ABORT,
        'operation_five_gateway_event_clock_mismatch'
      )
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_operation_five_send_attempts AS attempt
      JOIN shard_placement_authority_operation_five_send_attempt_events
        AS send_started
        ON send_started.authorization_id_sha256 =
             attempt.authorization_id_sha256
       AND send_started.attempt_digest_sha256 =
             attempt.attempt_digest_sha256
       AND send_started.event_sequence = 1
      WHERE attempt.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND attempt.attempt_digest_sha256 = NEW.attempt_digest_sha256
        AND attempt.gateway_idempotency_key_sha256 =
              NEW.gateway_idempotency_key_sha256
        AND attempt.controller_command_digest_sha256 =
              NEW.controller_command_digest_sha256
        AND send_started.event_kind = 'send_started'
        AND send_started.from_state = 'consumption_receipted'
        AND send_started.to_state = 'send_started'
        AND send_started.event_digest_sha256 =
              NEW.send_started_event_digest_sha256
        AND send_started.recorded_at <= NEW.recorded_at
    )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_event_source_mismatch'
      )
  END;
  SELECT CASE
    WHEN (
      NEW.event_sequence = 2
      AND (
        NEW.event_kind <> 'gateway_create_dispatched'
        OR NEW.predecessor_event_digest_sha256 <>
             NEW.send_started_event_digest_sha256
      )
    )
    OR (
      NEW.event_sequence > 2
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_five_gateway_events
          AS predecessor
        WHERE predecessor.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND predecessor.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND predecessor.event_sequence = NEW.event_sequence - 1
          AND predecessor.event_digest_sha256 =
                NEW.predecessor_event_digest_sha256
          AND predecessor.recorded_at <= NEW.recorded_at
      )
    )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_event_predecessor_mismatch'
      )
  END;
  SELECT CASE
    WHEN (
      NEW.event_sequence = 3
      AND NEW.event_kind NOT IN (
        'gateway_create_accepted',
        'gateway_create_rejected',
        'gateway_create_ambiguous'
      )
    )
    OR (
      NEW.event_sequence >= 4
      AND NEW.event_kind NOT IN (
        'gateway_status_target',
        'gateway_status_baseline',
        'gateway_status_drift',
        'gateway_status_ambiguous',
        'gateway_status_stable'
      )
    )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_event_order_mismatch'
      )
  END;
  SELECT CASE
    WHEN NEW.event_sequence = 3
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_five_gateway_events
          AS dispatch
        WHERE dispatch.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND dispatch.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND dispatch.event_sequence = 2
          AND dispatch.event_kind = 'gateway_create_dispatched'
          AND dispatch.gateway_credential_id_sha256 =
                NEW.gateway_credential_id_sha256
          AND dispatch.gateway_request_id_sha256 =
                NEW.gateway_request_id_sha256
          AND dispatch.mutation_request_sha256 =
                NEW.mutation_request_sha256
      )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_create_result_source_mismatch'
      )
  END;
  SELECT CASE
    WHEN NEW.gateway_credential_role = 'status'
      AND EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_five_gateway_events
          AS dispatch
        WHERE dispatch.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND dispatch.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND dispatch.event_sequence = 2
          AND dispatch.event_kind = 'gateway_create_dispatched'
          AND (
            dispatch.gateway_credential_id_sha256 =
              NEW.gateway_credential_id_sha256
            OR dispatch.gateway_request_id_sha256 =
              NEW.gateway_request_id_sha256
          )
      )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_role_identity_collision'
      )
  END;
  SELECT CASE
    WHEN NEW.event_kind = 'gateway_status_stable'
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_operation_five_gateway_events
          AS predecessor
        WHERE predecessor.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND predecessor.attempt_digest_sha256 =
                NEW.attempt_digest_sha256
          AND predecessor.event_sequence = NEW.event_sequence - 1
          AND predecessor.event_kind IN (
            'gateway_status_target',
            'gateway_status_stable'
          )
          AND predecessor.status_classification = 'target_observed'
          AND predecessor.observation_digest_sha256 =
                NEW.stability_predecessor_observation_digest_sha256
          AND predecessor.gateway_recorded_at =
                NEW.stability_predecessor_recorded_at
          AND predecessor.stability_minimum_seconds =
                NEW.stability_minimum_seconds
          AND predecessor.gateway_request_id_sha256 <>
                NEW.gateway_request_id_sha256
          AND NEW.gateway_recorded_at - predecessor.gateway_recorded_at
                >= NEW.stability_minimum_seconds
      )
      THEN RAISE(
        ABORT,
        'operation_five_gateway_stability_predecessor_mismatch'
      )
  END;
END;

CREATE TRIGGER shard_placement_authority_operation_five_gateway_event_append
AFTER INSERT ON shard_placement_authority_operation_five_gateway_events
FOR EACH ROW
BEGIN
  INSERT INTO shard_placement_authority_operation_five_send_attempt_events (
    authorization_id_sha256,
    attempt_digest_sha256,
    event_sequence,
    contract_version,
    event_contract,
    event_kind,
    from_state,
    to_state,
    event_semantics,
    predecessor_event_digest_sha256,
    dispatch_consumption_receipt_digest_sha256,
    controller_command_digest_sha256,
    gateway_idempotency_key_sha256,
    controller_request_sent,
    gateway_request_sent,
    event_digest_sha256,
    recorded_at
  )
  SELECT
    NEW.authorization_id_sha256,
    NEW.attempt_digest_sha256,
    NEW.event_sequence,
    1,
    'cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1',
    NEW.event_kind,
    predecessor.to_state,
    NEW.event_kind,
    CASE NEW.event_kind
      WHEN 'gateway_create_dispatched'
        THEN
          'unique_gateway_create_authority_persisted_network_may_not_have_occurred'
      WHEN 'gateway_create_accepted'
        THEN 'gateway_create_accepted_status_readback_required'
      WHEN 'gateway_create_rejected'
        THEN 'gateway_create_rejected_status_only'
      WHEN 'gateway_create_ambiguous'
        THEN 'gateway_create_ambiguous_status_only'
      WHEN 'gateway_status_target'
        THEN 'gateway_status_target_observed'
      WHEN 'gateway_status_baseline'
        THEN 'gateway_status_baseline_observed'
      WHEN 'gateway_status_drift'
        THEN 'gateway_status_deployment_drift'
      WHEN 'gateway_status_ambiguous'
        THEN 'gateway_status_ambiguous'
      WHEN 'gateway_status_stable'
        THEN 'gateway_status_target_stable'
    END,
    NEW.predecessor_event_digest_sha256,
    attempt.dispatch_consumption_receipt_digest_sha256,
    NEW.controller_command_digest_sha256,
    NEW.gateway_idempotency_key_sha256,
    0,
    CASE
      WHEN NEW.event_kind = 'gateway_create_dispatched' THEN 0
      ELSE 1
    END,
    NEW.event_digest_sha256,
    NEW.recorded_at
  FROM shard_placement_authority_operation_five_send_attempt_events
    AS predecessor
  JOIN shard_placement_authority_operation_five_send_attempts AS attempt
    ON attempt.authorization_id_sha256 = NEW.authorization_id_sha256
   AND attempt.attempt_digest_sha256 = NEW.attempt_digest_sha256
  WHERE predecessor.attempt_digest_sha256 = NEW.attempt_digest_sha256
    AND predecessor.event_sequence = NEW.event_sequence - 1;
END;

CREATE TRIGGER shard_placement_authority_operation_five_gateway_event_update_guard
BEFORE UPDATE ON shard_placement_authority_operation_five_gateway_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_gateway_event');
END;

CREATE TRIGGER shard_placement_authority_operation_five_gateway_event_delete_guard
BEFORE DELETE ON shard_placement_authority_operation_five_gateway_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'immutable_operation_five_gateway_event');
END;
