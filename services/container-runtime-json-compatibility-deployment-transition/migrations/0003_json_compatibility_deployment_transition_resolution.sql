CREATE TABLE json_compatibility_deployment_transition_resolution_claims (
  operation_id_sha256 TEXT NOT NULL,
  operation_digest_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL
    CHECK (typeof(generation) = 'integer' AND generation > 0),
  claim_digest_sha256 TEXT NOT NULL UNIQUE,
  authorization_digest_sha256 TEXT NOT NULL UNIQUE,
  resolver_identity_sha256 TEXT NOT NULL,
  journal_head_ordinal INTEGER NOT NULL
    CHECK (typeof(journal_head_ordinal) = 'integer' AND journal_head_ordinal > 0),
  journal_head_digest_sha256 TEXT NOT NULL,
  pending_mutation_intent_ordinal INTEGER NOT NULL
    CHECK (
      typeof(pending_mutation_intent_ordinal) = 'integer'
      AND pending_mutation_intent_ordinal > 0
      AND pending_mutation_intent_ordinal <= journal_head_ordinal
    ),
  pending_mutation_intent_digest_sha256 TEXT NOT NULL,
  expected_target_state_sha256 TEXT NOT NULL,
  execution_disabled_evidence_digest_sha256 TEXT NOT NULL,
  execution_disabled_evidence_json TEXT NOT NULL
    CHECK (
      json_valid(execution_disabled_evidence_json)
      AND length(CAST(execution_disabled_evidence_json AS BLOB))
        BETWEEN 2 AND 32768
    ),
  claim_json TEXT NOT NULL
    CHECK (
      json_valid(claim_json)
      AND length(CAST(claim_json AS BLOB)) BETWEEN 2 AND 65536
    ),
  quiesced_at INTEGER NOT NULL CHECK (typeof(quiesced_at) = 'integer'),
  settle_not_before INTEGER NOT NULL
    CHECK (typeof(settle_not_before) = 'integer'),
  source_authentication_expires_at INTEGER NOT NULL
    CHECK (typeof(source_authentication_expires_at) = 'integer'),
  authorization_expires_at INTEGER NOT NULL
    CHECK (typeof(authorization_expires_at) = 'integer'),
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer'),
  claimed_at INTEGER NOT NULL CHECK (typeof(claimed_at) = 'integer'),
  PRIMARY KEY (operation_id_sha256, generation),
  FOREIGN KEY (operation_id_sha256)
    REFERENCES json_compatibility_deployment_transition_operations(
      operation_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(operation_digest_sha256) = 64
    AND operation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(authorization_digest_sha256) = 64
    AND authorization_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(resolver_identity_sha256) = 64
    AND resolver_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(journal_head_digest_sha256) = 64
    AND journal_head_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(pending_mutation_intent_digest_sha256) = 64
    AND pending_mutation_intent_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(expected_target_state_sha256) = 64
    AND expected_target_state_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(execution_disabled_evidence_digest_sha256) = 64
    AND execution_disabled_evidence_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    claim_digest_sha256 <> authorization_digest_sha256
    AND claim_digest_sha256 <> resolver_identity_sha256
    AND authorization_digest_sha256 <> resolver_identity_sha256
  ),
  CHECK (
    quiesced_at < settle_not_before
    AND settle_not_before <= claimed_at
    AND claimed_at < lease_expires_at
    AND lease_expires_at <= source_authentication_expires_at
    AND lease_expires_at <= authorization_expires_at
  )
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_resolution_observations (
  operation_id_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL
    CHECK (typeof(generation) = 'integer' AND generation > 0),
  observation_ordinal INTEGER NOT NULL
    CHECK (observation_ordinal IN (1, 2)),
  claim_digest_sha256 TEXT NOT NULL,
  request_digest_sha256 TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL
    CHECK (
      json_valid(request_json)
      AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 65536
    ),
  observation_digest_sha256 TEXT NOT NULL UNIQUE,
  observation_json TEXT NOT NULL
    CHECK (
      json_valid(observation_json)
      AND length(CAST(observation_json AS BLOB)) BETWEEN 2 AND 131072
    ),
  observed_state_sha256 TEXT NOT NULL,
  readback_version_id TEXT NOT NULL
    CHECK (
      length(readback_version_id) BETWEEN 1 AND 128
      AND readback_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  readback_identity_sha256 TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer'),
  PRIMARY KEY (operation_id_sha256, generation, observation_ordinal),
  FOREIGN KEY (operation_id_sha256, generation)
    REFERENCES json_compatibility_deployment_transition_resolution_claims(
      operation_id_sha256,
      generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(request_digest_sha256) = 64
    AND request_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(observation_digest_sha256) = 64
    AND observation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(observed_state_sha256) = 64
    AND observed_state_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(readback_identity_sha256) = 64
    AND readback_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (request_digest_sha256 <> observation_digest_sha256)
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_resolution_outcomes (
  operation_id_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL
    CHECK (typeof(generation) = 'integer' AND generation > 0),
  claim_digest_sha256 TEXT NOT NULL,
  classification TEXT NOT NULL
    CHECK (
      classification IN (
        'target_confirmed',
        'manual_review_required',
        'readback_inconclusive'
      )
    ),
  observation_one_digest_sha256 TEXT NOT NULL,
  observation_two_digest_sha256 TEXT NOT NULL,
  resolution_digest_sha256 TEXT NOT NULL UNIQUE,
  resolution_json TEXT NOT NULL
    CHECK (
      json_valid(resolution_json)
      AND length(CAST(resolution_json AS BLOB)) BETWEEN 2 AND 262144
    ),
  resolved_at INTEGER NOT NULL CHECK (typeof(resolved_at) = 'integer'),
  PRIMARY KEY (operation_id_sha256, generation),
  FOREIGN KEY (operation_id_sha256, generation)
    REFERENCES json_compatibility_deployment_transition_resolution_claims(
      operation_id_sha256,
      generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(operation_id_sha256) = 64
    AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(claim_digest_sha256) = 64
    AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(resolution_digest_sha256) = 64
    AND resolution_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(observation_one_digest_sha256) = 64
    AND observation_one_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(observation_two_digest_sha256) = 64
    AND observation_two_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    AND observation_one_digest_sha256 <> observation_two_digest_sha256
  )
) WITHOUT ROWID;

-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
-- These append-only identity ledgers survive the implicit delete and make the
-- corresponding main-table AFTER INSERT trigger abort every replacement.
CREATE TABLE json_compatibility_deployment_transition_resolution_claim_identities (
  operation_id_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL,
  claim_digest_sha256 TEXT NOT NULL UNIQUE,
  authorization_digest_sha256 TEXT NOT NULL UNIQUE,
  PRIMARY KEY (operation_id_sha256, generation),
  FOREIGN KEY (operation_id_sha256, generation)
    REFERENCES json_compatibility_deployment_transition_resolution_claims(
      operation_id_sha256,
      generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_resolution_observation_identities (
  operation_id_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL,
  observation_ordinal INTEGER NOT NULL,
  request_digest_sha256 TEXT NOT NULL UNIQUE,
  observation_digest_sha256 TEXT NOT NULL UNIQUE,
  PRIMARY KEY (operation_id_sha256, generation, observation_ordinal),
  FOREIGN KEY (operation_id_sha256, generation, observation_ordinal)
    REFERENCES json_compatibility_deployment_transition_resolution_observations(
      operation_id_sha256,
      generation,
      observation_ordinal
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_resolution_outcome_identities (
  operation_id_sha256 TEXT NOT NULL,
  generation INTEGER NOT NULL,
  resolution_digest_sha256 TEXT NOT NULL UNIQUE,
  PRIMARY KEY (operation_id_sha256, generation),
  FOREIGN KEY (operation_id_sha256, generation)
    REFERENCES json_compatibility_deployment_transition_resolution_outcomes(
      operation_id_sha256,
      generation
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_json_compatibility_deployment_transition_resolution_claims_lease
ON json_compatibility_deployment_transition_resolution_claims(
  operation_id_sha256,
  lease_expires_at,
  generation
);

CREATE UNIQUE INDEX idx_json_compatibility_deployment_transition_one_final_resolution
ON json_compatibility_deployment_transition_resolution_outcomes(
  operation_id_sha256
)
WHERE classification IN ('target_confirmed', 'manual_review_required');

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.claimed_at <> unixepoch()
  THEN RAISE(ABORT, 'resolution claim time must come from D1') END;
  SELECT CASE WHEN NEW.quiesced_at > unixepoch()
  THEN RAISE(ABORT, 'resolution quiescence cannot be in the future') END;
  SELECT CASE WHEN NEW.lease_expires_at <> NEW.claimed_at + 45
  THEN RAISE(ABORT, 'resolution claim lease must be derived from D1 time') END;
  SELECT CASE WHEN NEW.lease_expires_at > NEW.source_authentication_expires_at
  THEN RAISE(ABORT, 'resolution claim lease exceeds source proof') END;
  SELECT CASE WHEN NEW.lease_expires_at > NEW.authorization_expires_at
  THEN RAISE(ABORT, 'resolution claim lease exceeds authorization') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_terminal_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_receipts
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_outcomes
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND classification IN ('target_confirmed', 'manual_review_required')
)
BEGIN
  SELECT RAISE(ABORT, 'terminal transition cannot be claimed for resolution');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_generation_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN NEW.generation <> COALESCE((
  SELECT MAX(generation) + 1
  FROM json_compatibility_deployment_transition_resolution_claims
  WHERE operation_id_sha256 = NEW.operation_id_sha256
), 1)
BEGIN
  SELECT RAISE(ABORT, 'resolution claim generation conflict');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_lease_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND lease_expires_at > unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'resolution claim lease is still active');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_operation_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_operations AS operation
  JOIN json_compatibility_deployment_transition_authorities AS authority
    ON authority.operation_id_sha256 = operation.operation_id_sha256
  WHERE operation.operation_id_sha256 = NEW.operation_id_sha256
    AND operation.operation_digest_sha256 = NEW.operation_digest_sha256
    AND authority.mutation_identity_sha256 <> NEW.resolver_identity_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'resolution claim operation or resolver identity mismatch');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_payload_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN json_extract(NEW.execution_disabled_evidence_json, '$.evidenceSha256')
    IS NOT NEW.execution_disabled_evidence_digest_sha256
OR json_extract(NEW.execution_disabled_evidence_json, '$.executionDisabledAt')
    IS NOT NEW.quiesced_at
OR json_extract(
    NEW.execution_disabled_evidence_json,
    '$.quiescenceSatisfiedAt'
  ) IS NOT NEW.settle_not_before
OR json_extract(NEW.execution_disabled_evidence_json, '$.executionEnabled')
    IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'resolution claim evidence is not column-bound');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_journal_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
WHEN NEW.journal_head_ordinal <> COALESCE((
  SELECT MAX(event_ordinal)
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
), 0)
OR NEW.journal_head_ordinal <> (
  SELECT COUNT(*)
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
OR NEW.journal_head_digest_sha256 <> COALESCE((
  SELECT event_digest_sha256
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
  ORDER BY event_ordinal DESC
  LIMIT 1
), '')
OR NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal = NEW.pending_mutation_intent_ordinal
    AND event_kind = 'mutation_intent'
    AND event_digest_sha256 = NEW.pending_mutation_intent_digest_sha256
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal > NEW.pending_mutation_intent_ordinal
    AND event_kind = 'mutation_intent'
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal > NEW.pending_mutation_intent_ordinal
    AND event_kind NOT IN ('mutation_outcome', 'target_readback')
)
OR 1 < (
  SELECT COUNT(*)
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal > NEW.pending_mutation_intent_ordinal
    AND event_kind = 'mutation_outcome'
)
OR (
  0 < (
    SELECT COUNT(*)
    FROM json_compatibility_deployment_transition_events
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND event_ordinal > NEW.pending_mutation_intent_ordinal
      AND event_kind = 'target_readback'
  )
  AND 0 = (
    SELECT COUNT(*)
    FROM json_compatibility_deployment_transition_events
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND event_ordinal > NEW.pending_mutation_intent_ordinal
      AND event_kind = 'mutation_outcome'
  )
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal > NEW.pending_mutation_intent_ordinal
    AND event_kind = 'mutation_outcome'
    AND event_ordinal <> NEW.pending_mutation_intent_ordinal + 1
)
OR 2 < (
  SELECT COUNT(*)
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_ordinal > NEW.pending_mutation_intent_ordinal
    AND event_kind = 'target_readback'
)
BEGIN
  SELECT RAISE(ABORT, 'resolution claim journal checkpoint mismatch');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.observed_at <> unixepoch()
  THEN RAISE(ABORT, 'resolution observation time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_claim_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims AS claim
  WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
    AND claim.generation = NEW.generation
    AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
    AND claim.generation = (
      SELECT MAX(generation)
      FROM json_compatibility_deployment_transition_resolution_claims
      WHERE operation_id_sha256 = NEW.operation_id_sha256
    )
    AND unixepoch() >= claim.settle_not_before
    AND unixepoch() < claim.lease_expires_at
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_outcomes
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND generation = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'resolution observation claim is inactive');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_payload_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
WHEN json_extract(NEW.request_json, '$.readbackRequestSha256')
    IS NOT NEW.request_digest_sha256
OR json_extract(NEW.observation_json, '$.readbackRequestSha256')
    IS NOT NEW.request_digest_sha256
OR json_extract(NEW.observation_json, '$.observationDigestSha256')
    IS NOT NEW.observation_digest_sha256
OR json_extract(NEW.observation_json, '$.readbackServiceIdentitySha256')
    IS NOT NEW.readback_identity_sha256
OR json_extract(NEW.observation_json, '$.classification')
    NOT IN ('observed', 'ambiguous')
OR (
  json_extract(NEW.observation_json, '$.classification') = 'observed'
  AND json_extract(NEW.observation_json, '$.remoteStateSha256')
    IS NOT NEW.observed_state_sha256
)
OR (
  json_extract(NEW.observation_json, '$.classification') = 'ambiguous'
  AND (
    json_type(NEW.observation_json, '$.remoteStateSha256') <> 'null'
    OR NEW.observed_state_sha256 <> NEW.observation_digest_sha256
  )
)
BEGIN
  SELECT RAISE(ABORT, 'resolution observation payload is not column-bound');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_reader_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_authorities
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND readback_version_id = NEW.readback_version_id
    AND readback_identity_sha256 = NEW.readback_identity_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'resolution observation reader identity mismatch');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_sequence_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
WHEN (
  NEW.observation_ordinal = 1
  AND EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_observations
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND generation = NEW.generation
  )
)
OR (
  NEW.observation_ordinal = 2
  AND NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_observations
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND generation = NEW.generation
      AND observation_ordinal = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'resolution observation sequence conflict');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_stability_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
WHEN NEW.observation_ordinal = 2
AND NEW.observed_at < (
  SELECT observed_at + 5
  FROM json_compatibility_deployment_transition_resolution_observations
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND generation = NEW.generation
    AND observation_ordinal = 1
)
BEGIN
  SELECT RAISE(ABORT, 'resolution observations require five seconds of stability');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.resolved_at <> unixepoch()
  THEN RAISE(ABORT, 'resolution outcome time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_claim_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims AS claim
  WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
    AND claim.generation = NEW.generation
    AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
    AND claim.generation = (
      SELECT MAX(generation)
      FROM json_compatibility_deployment_transition_resolution_claims
      WHERE operation_id_sha256 = NEW.operation_id_sha256
    )
    AND unixepoch() >= claim.settle_not_before
    AND unixepoch() < claim.lease_expires_at
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_receipts
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
OR EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_outcomes
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND classification IN ('target_confirmed', 'manual_review_required')
)
BEGIN
  SELECT RAISE(ABORT, 'resolution outcome claim is inactive or terminal');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_observation_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_observations
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND generation = NEW.generation
      AND observation_ordinal = 1
      AND observation_digest_sha256 = NEW.observation_one_digest_sha256
  )
OR NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_observations
    WHERE operation_id_sha256 = NEW.operation_id_sha256
      AND generation = NEW.generation
      AND observation_ordinal = 2
      AND observation_digest_sha256 = NEW.observation_two_digest_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'resolution outcome observation mismatch');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_payload_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
WHEN json_extract(NEW.resolution_json, '$.operationIdSha256')
    IS NOT NEW.operation_id_sha256
OR json_extract(NEW.resolution_json, '$.claimGeneration') IS NOT NEW.generation
OR json_extract(NEW.resolution_json, '$.classification')
    IS NOT NEW.classification
OR json_extract(NEW.resolution_json, '$.resolutionReceiptSha256')
    IS NOT NEW.resolution_digest_sha256
OR json_extract(
    NEW.resolution_json,
    '$.targetReadbacks[0].observationDigestSha256'
  ) IS NOT NEW.observation_one_digest_sha256
OR json_extract(
    NEW.resolution_json,
    '$.targetReadbacks[1].observationDigestSha256'
  ) IS NOT NEW.observation_two_digest_sha256
OR NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims AS claim
  WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
    AND claim.generation = NEW.generation
    AND json_extract(NEW.resolution_json, '$.operationDigestSha256')
      = claim.operation_digest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'resolution outcome payload is not column-bound');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_classification_guard
BEFORE INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
WHEN (
  NEW.classification = 'target_confirmed'
  AND NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_claims AS claim
    JOIN json_compatibility_deployment_transition_resolution_observations AS first
      ON first.operation_id_sha256 = claim.operation_id_sha256
      AND first.generation = claim.generation
      AND first.observation_ordinal = 1
    JOIN json_compatibility_deployment_transition_resolution_observations AS second
      ON second.operation_id_sha256 = claim.operation_id_sha256
      AND second.generation = claim.generation
      AND second.observation_ordinal = 2
    WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
      AND claim.generation = NEW.generation
      AND first.observation_digest_sha256 = NEW.observation_one_digest_sha256
      AND second.observation_digest_sha256 = NEW.observation_two_digest_sha256
      AND json_extract(first.observation_json, '$.classification') = 'observed'
      AND json_extract(second.observation_json, '$.classification') = 'observed'
      AND json_extract(first.observation_json, '$.readbackRequestIdSha256')
        <> json_extract(second.observation_json, '$.readbackRequestIdSha256')
      AND first.observed_state_sha256 = claim.expected_target_state_sha256
      AND second.observed_state_sha256 = claim.expected_target_state_sha256
  )
)
OR (
  NEW.classification = 'manual_review_required'
  AND NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_claims AS claim
    JOIN json_compatibility_deployment_transition_resolution_observations AS first
      ON first.operation_id_sha256 = claim.operation_id_sha256
      AND first.generation = claim.generation
      AND first.observation_ordinal = 1
    JOIN json_compatibility_deployment_transition_resolution_observations AS second
      ON second.operation_id_sha256 = claim.operation_id_sha256
      AND second.generation = claim.generation
      AND second.observation_ordinal = 2
    WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
      AND claim.generation = NEW.generation
      AND first.observation_digest_sha256 = NEW.observation_one_digest_sha256
      AND second.observation_digest_sha256 = NEW.observation_two_digest_sha256
      AND json_extract(first.observation_json, '$.classification') = 'observed'
      AND json_extract(second.observation_json, '$.classification') = 'observed'
      AND json_extract(first.observation_json, '$.readbackRequestIdSha256')
        <> json_extract(second.observation_json, '$.readbackRequestIdSha256')
      AND first.observed_state_sha256 = second.observed_state_sha256
      AND first.observed_state_sha256 <> claim.expected_target_state_sha256
  )
)
OR (
  NEW.classification = 'readback_inconclusive'
  AND NOT EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_claims AS claim
    JOIN json_compatibility_deployment_transition_resolution_observations AS first
      ON first.operation_id_sha256 = claim.operation_id_sha256
      AND first.generation = claim.generation
      AND first.observation_ordinal = 1
    JOIN json_compatibility_deployment_transition_resolution_observations AS second
      ON second.operation_id_sha256 = claim.operation_id_sha256
      AND second.generation = claim.generation
      AND second.observation_ordinal = 2
    WHERE claim.operation_id_sha256 = NEW.operation_id_sha256
      AND claim.generation = NEW.generation
      AND first.observation_digest_sha256 = NEW.observation_one_digest_sha256
      AND second.observation_digest_sha256 = NEW.observation_two_digest_sha256
      AND json_extract(first.observation_json, '$.classification')
        IN ('observed', 'ambiguous')
      AND json_extract(second.observation_json, '$.classification')
        IN ('observed', 'ambiguous')
      AND (
        json_extract(first.observation_json, '$.classification') = 'ambiguous'
        OR json_extract(second.observation_json, '$.classification') = 'ambiguous'
        OR json_extract(first.observation_json, '$.readbackRequestIdSha256')
          = json_extract(second.observation_json, '$.readbackRequestIdSha256')
        OR first.observed_state_sha256 <> second.observed_state_sha256
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'resolution outcome classification contradicts observations');
END;

CREATE TRIGGER json_compatibility_deployment_transition_event_resolution_guard
BEFORE INSERT ON json_compatibility_deployment_transition_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'transition events cannot follow a resolution claim');
END;

CREATE TRIGGER json_compatibility_deployment_transition_receipt_resolution_guard
BEFORE INSERT ON json_compatibility_deployment_transition_receipts
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_resolution_claims
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'transition receipts cannot follow a resolution claim');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_identity_guard
AFTER INSERT ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'resolution claim identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_claim_identities
    WHERE (
        operation_id_sha256 = NEW.operation_id_sha256
        AND generation = NEW.generation
      )
      OR claim_digest_sha256 = NEW.claim_digest_sha256
      OR authorization_digest_sha256 = NEW.authorization_digest_sha256
  );
  INSERT INTO json_compatibility_deployment_transition_resolution_claim_identities (
    operation_id_sha256,
    generation,
    claim_digest_sha256,
    authorization_digest_sha256
  ) VALUES (
    NEW.operation_id_sha256,
    NEW.generation,
    NEW.claim_digest_sha256,
    NEW.authorization_digest_sha256
  );
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_identity_guard
AFTER INSERT ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'resolution observation identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_observation_identities
    WHERE (
        operation_id_sha256 = NEW.operation_id_sha256
        AND generation = NEW.generation
        AND observation_ordinal = NEW.observation_ordinal
      )
      OR request_digest_sha256 = NEW.request_digest_sha256
      OR observation_digest_sha256 = NEW.observation_digest_sha256
  );
  INSERT INTO json_compatibility_deployment_transition_resolution_observation_identities (
    operation_id_sha256,
    generation,
    observation_ordinal,
    request_digest_sha256,
    observation_digest_sha256
  ) VALUES (
    NEW.operation_id_sha256,
    NEW.generation,
    NEW.observation_ordinal,
    NEW.request_digest_sha256,
    NEW.observation_digest_sha256
  );
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_identity_guard
AFTER INSERT ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'resolution outcome identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM json_compatibility_deployment_transition_resolution_outcome_identities
    WHERE (
        operation_id_sha256 = NEW.operation_id_sha256
        AND generation = NEW.generation
      )
      OR resolution_digest_sha256 = NEW.resolution_digest_sha256
  );
  INSERT INTO json_compatibility_deployment_transition_resolution_outcome_identities (
    operation_id_sha256,
    generation,
    resolution_digest_sha256
  ) VALUES (
    NEW.operation_id_sha256,
    NEW.generation,
    NEW.resolution_digest_sha256
  );
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_identity_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_claim_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution claim identities are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_identity_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_claim_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution claim identities are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_identity_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_observation_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution observation identities are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_identity_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_observation_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution observation identities are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_identity_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_outcome_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution outcome identities are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_identity_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_outcome_identities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution outcome identities are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution claims are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_claim_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_claims
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution claims are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution observations are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_observation_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_observations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution observations are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution outcomes are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_resolution_outcome_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_resolution_outcomes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'resolution outcomes are append-preserved');
END;
