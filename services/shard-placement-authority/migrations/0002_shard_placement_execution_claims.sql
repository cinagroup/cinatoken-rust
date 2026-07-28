CREATE TABLE shard_placement_authority_execution_claims (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_subject_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(permit_subject_digest_sha256) = 'text'
      AND length(permit_subject_digest_sha256) = 64
      AND permit_subject_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_nonce_sha256 TEXT NOT NULL
    CHECK (
      typeof(execution_nonce_sha256) = 'text'
      AND length(execution_nonce_sha256) = 64
      AND execution_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_ticket_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(application_ticket_id_sha256) = 'text'
      AND length(application_ticket_id_sha256) = 64
      AND application_ticket_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  application_ticket_digest_sha256 TEXT NOT NULL
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
  authority_database_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_database_identity_sha256) = 'text'
      AND length(authority_database_identity_sha256) = 64
      AND authority_database_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_nonce_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_nonce_sha256) = 'text'
      AND length(campaign_nonce_sha256) = 64
      AND campaign_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_scope TEXT NOT NULL
    CHECK (claim_scope = 'staging-controller-placement-v1'),
  execution_plan_sha256 TEXT NOT NULL
    CHECK (
      typeof(execution_plan_sha256) = 'text'
      AND length(execution_plan_sha256) = 64
      AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
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
  claim_owner_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_owner_sha256) = 'text'
      AND length(claim_owner_sha256) = 64
      AND claim_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_owner_sha256 TEXT NOT NULL
    CHECK (
      typeof(lease_owner_sha256) = 'text'
      AND length(lease_owner_sha256) = 64
      AND lease_owner_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(ledger_identity_sha256) = 'text'
      AND length(ledger_identity_sha256) = 64
      AND ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_token_sha256 TEXT NOT NULL
    CHECK (
      typeof(lease_token_sha256) = 'text'
      AND length(lease_token_sha256) = 64
      AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_generation INTEGER NOT NULL
    CHECK (typeof(lease_generation) = 'integer' AND lease_generation >= 1),
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at > 0),
  baseline_operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(baseline_operation_id_sha256) = 'text'
      AND length(baseline_operation_id_sha256) = 64
      AND baseline_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  baseline_terminal_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(baseline_terminal_digest_sha256) = 'text'
      AND length(baseline_terminal_digest_sha256) = 64
      AND baseline_terminal_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  preparation_operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(preparation_operation_id_sha256) = 'text'
      AND length(preparation_operation_id_sha256) = 64
      AND preparation_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_operation_id_sha256) = 'text'
      AND length(claim_operation_id_sha256) = 64
      AND claim_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_schedule_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_schedule_sha256) = 'text'
      AND length(operation_schedule_sha256) = 64
      AND operation_schedule_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_credential_id_sha256) = 'text'
      AND length(claim_credential_id_sha256) = 64
      AND claim_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_request_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_request_id_sha256) = 'text'
      AND length(claim_request_id_sha256) = 64
      AND claim_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_acquired_receipt_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_acquired_receipt_digest_sha256) = 'text'
      AND length(claim_acquired_receipt_digest_sha256) = 64
      AND claim_acquired_receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_expires_at INTEGER NOT NULL
    CHECK (typeof(permit_expires_at) = 'integer' AND permit_expires_at > 0),
  normal_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(normal_deadline_at) = 'integer'
      AND normal_deadline_at > 0
      AND normal_deadline_at <= permit_expires_at
    ),
  recovery_deadline_at INTEGER NOT NULL
    CHECK (
      typeof(recovery_deadline_at) = 'integer'
      AND recovery_deadline_at = permit_expires_at + 600
    ),
  status TEXT NOT NULL DEFAULT 'acquiring'
    CHECK (
      status IN (
        'acquiring',
        'claimed',
        'running',
        'disable_required',
        'completed',
        'aborted',
        'recovery_required',
        'revoked'
      )
    ),
  ledger_version INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(ledger_version) = 'integer'
      AND ledger_version BETWEEN 0 AND 64
    ),
  ledger_head_sha256 TEXT NOT NULL
    CHECK (
      typeof(ledger_head_sha256) = 'text'
      AND length(ledger_head_sha256) = 64
      AND ledger_head_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  last_completed_ordinal INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(last_completed_ordinal) = 'integer'
      AND last_completed_ordinal BETWEEN 1 AND 14
    ),
  inflight_operation_ordinal INTEGER
    CHECK (
      inflight_operation_ordinal IS NULL
      OR (
        typeof(inflight_operation_ordinal) = 'integer'
        AND inflight_operation_ordinal BETWEEN 4 AND 14
      )
    ),
  inflight_operation_id_sha256 TEXT
    CHECK (
      inflight_operation_id_sha256 IS NULL
      OR (
        typeof(inflight_operation_id_sha256) = 'text'
        AND length(inflight_operation_id_sha256) = 64
        AND inflight_operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  inflight_request_sha256 TEXT
    CHECK (
      inflight_request_sha256 IS NULL
      OR (
        typeof(inflight_request_sha256) = 'text'
        AND length(inflight_request_sha256) = 64
        AND inflight_request_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  inflight_cloudflare_request_id_sha256 TEXT
    CHECK (
      inflight_cloudflare_request_id_sha256 IS NULL
      OR (
        typeof(inflight_cloudflare_request_id_sha256) = 'text'
        AND length(inflight_cloudflare_request_id_sha256) = 64
        AND inflight_cloudflare_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  inflight_started_generation INTEGER
    CHECK (
      inflight_started_generation IS NULL
      OR (
        typeof(inflight_started_generation) = 'integer'
        AND inflight_started_generation >= 1
      )
    ),
  inflight_started_owner_sha256 TEXT
    CHECK (
      inflight_started_owner_sha256 IS NULL
      OR (
        typeof(inflight_started_owner_sha256) = 'text'
        AND length(inflight_started_owner_sha256) = 64
        AND inflight_started_owner_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  inflight_started_lease_token_sha256 TEXT
    CHECK (
      inflight_started_lease_token_sha256 IS NULL
      OR (
        typeof(inflight_started_lease_token_sha256) = 'text'
        AND length(inflight_started_lease_token_sha256) = 64
        AND inflight_started_lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  inflight_readback_only INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(inflight_readback_only) = 'integer'
      AND inflight_readback_only IN (0, 1)
    ),
  enable_intent_seen INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(enable_intent_seen) = 'integer'
      AND enable_intent_seen IN (0, 1)
    ),
  disable_confirmed INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(disable_confirmed) = 'integer'
      AND disable_confirmed IN (0, 1)
    ),
  application_activation_digest_sha256 TEXT
    CHECK (
      application_activation_digest_sha256 IS NULL
      OR (
        typeof(application_activation_digest_sha256) = 'text'
        AND length(application_activation_digest_sha256) = 64
        AND application_activation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  ticket_activation_confirmed INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(ticket_activation_confirmed) = 'integer'
      AND ticket_activation_confirmed IN (0, 1)
    ),
  renewal_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(renewal_count) = 'integer' AND renewal_count >= 0),
  takeover_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(takeover_count) = 'integer' AND takeover_count >= 0),
  generated_at INTEGER NOT NULL
    CHECK (typeof(generated_at) = 'integer' AND generated_at > 0),
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(claimed_at) = 'integer' AND claimed_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  terminal_at INTEGER
    CHECK (
      terminal_at IS NULL
      OR (
        typeof(terminal_at) = 'integer'
        AND terminal_at >= claimed_at
      )
    ),
  CHECK (
    (ledger_version = 0
      AND ledger_head_sha256 = baseline_terminal_digest_sha256
      AND last_completed_ordinal = 1)
    OR ledger_version > 0
  ),
  CHECK (
    (
      inflight_operation_ordinal IS NULL
      AND inflight_operation_id_sha256 IS NULL
      AND inflight_request_sha256 IS NULL
      AND inflight_cloudflare_request_id_sha256 IS NULL
      AND inflight_started_generation IS NULL
      AND inflight_started_owner_sha256 IS NULL
      AND inflight_started_lease_token_sha256 IS NULL
      AND inflight_readback_only = 0
    )
    OR (
      inflight_operation_ordinal IS NOT NULL
      AND inflight_operation_id_sha256 IS NOT NULL
      AND inflight_request_sha256 IS NOT NULL
      AND inflight_started_generation IS NOT NULL
      AND inflight_started_owner_sha256 IS NOT NULL
      AND inflight_started_lease_token_sha256 IS NOT NULL
    )
  ),
  CHECK (
    (status IN ('completed', 'aborted', 'revoked') AND terminal_at IS NOT NULL)
    OR (
      status IN (
        'acquiring',
        'claimed',
        'running',
        'disable_required',
        'recovery_required'
      )
      AND terminal_at IS NULL
    )
  ),
  CHECK (
    status NOT IN ('disable_required', 'recovery_required')
    OR (enable_intent_seen = 1 AND disable_confirmed = 0)
  ),
  CHECK (
    status <> 'completed'
    OR (enable_intent_seen = 1 AND disable_confirmed = 1)
  ),
  CHECK (
    status NOT IN ('aborted', 'revoked')
    OR (enable_intent_seen = 0 AND disable_confirmed = 1)
  ),
  CHECK (
    (ticket_activation_confirmed = 0
      AND application_activation_digest_sha256 IS NULL)
    OR (
      ticket_activation_confirmed = 1
      AND application_activation_digest_sha256 IS NOT NULL
    )
  ),
  FOREIGN KEY (
    authorization_id_sha256,
    permit_subject_digest_sha256
  ) REFERENCES shard_placement_authority_issuances(
    authorization_id_sha256,
    permit_subject_digest_sha256
  )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

-- Lease expiry deliberately does not release this index. Only a durable
-- terminal projection can release the single active staging scope.
CREATE UNIQUE INDEX idx_shard_placement_authority_execution_claims_active_scope
ON shard_placement_authority_execution_claims(claim_scope)
WHERE status IN (
  'acquiring',
  'claimed',
  'running',
  'disable_required',
  'recovery_required'
);

CREATE UNIQUE INDEX idx_shard_placement_authority_execution_claims_digest
ON shard_placement_authority_execution_claims(claim_digest_sha256);

CREATE TABLE shard_placement_authority_execution_operations (
  authorization_id_sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL
    CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 4 AND 14),
  operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_id_sha256) = 'text'
      AND length(operation_id_sha256) = 64
      AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'activate_execution_ticket',
        'enable_controller_deployment',
        'probe_shard_readiness',
        'disable_controller_deployment'
      )
    ),
  shard_index INTEGER
    CHECK (
      shard_index IS NULL
      OR (
        typeof(shard_index) = 'integer'
        AND shard_index BETWEEN 0 AND 7
      )
    ),
  PRIMARY KEY (authorization_id_sha256, ordinal),
  CHECK (
    (ordinal = 4
      AND kind = 'activate_execution_ticket'
      AND shard_index IS NULL)
    OR (ordinal = 5
      AND kind = 'enable_controller_deployment'
      AND shard_index IS NULL)
    OR (ordinal BETWEEN 6 AND 13
      AND kind = 'probe_shard_readiness'
      AND shard_index = ordinal - 6)
    OR (ordinal = 14
      AND kind = 'disable_controller_deployment'
      AND shard_index IS NULL)
  ),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_execution_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_shard_placement_authority_execution_operations_id
ON shard_placement_authority_execution_operations(operation_id_sha256);

CREATE TABLE shard_placement_authority_execution_receipts (
  authorization_id_sha256 TEXT NOT NULL,
  sequence INTEGER NOT NULL
    CHECK (typeof(sequence) = 'integer' AND sequence BETWEEN 1 AND 64),
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'claim_acquired',
        'lease_renewed',
        'lease_taken_over',
        'operation_started',
        'operation_terminal',
        'safety_diverted'
      )
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  execution_plan_sha256 TEXT NOT NULL
    CHECK (
      typeof(execution_plan_sha256) = 'text'
      AND length(execution_plan_sha256) = 64
      AND execution_plan_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(ledger_identity_sha256) = 'text'
      AND length(ledger_identity_sha256) = 64
      AND ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_ordinal INTEGER NOT NULL
    CHECK (
      typeof(operation_ordinal) = 'integer'
      AND operation_ordinal BETWEEN 3 AND 14
    ),
  operation_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(operation_id_sha256) = 'text'
      AND length(operation_id_sha256) = 64
      AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_kind TEXT NOT NULL
    CHECK (
      operation_kind IN (
        'create_authority_claim',
        'activate_execution_ticket',
        'enable_controller_deployment',
        'probe_shard_readiness',
        'disable_controller_deployment'
      )
    ),
  shard_index INTEGER
    CHECK (
      shard_index IS NULL
      OR (
        typeof(shard_index) = 'integer'
        AND shard_index BETWEEN 0 AND 7
      )
    ),
  predecessor_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_receipt_sha256) = 'text'
      AND length(predecessor_receipt_sha256) = 64
      AND predecessor_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_sha256) = 'text'
      AND length(request_sha256) = 64
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  response_sha256 TEXT
    CHECK (
      response_sha256 IS NULL
      OR (
        typeof(response_sha256) = 'text'
        AND length(response_sha256) = 64
        AND response_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  cloudflare_request_id_sha256 TEXT
    CHECK (
      cloudflare_request_id_sha256 IS NULL
      OR (
        typeof(cloudflare_request_id_sha256) = 'text'
        AND length(cloudflare_request_id_sha256) = 64
        AND cloudflare_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      typeof(evidence_sha256) = 'text'
      AND length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  safety_reason TEXT
    CHECK (
      safety_reason IS NULL
      OR safety_reason IN (
        'operation_failed',
        'lease_expired',
        'lease_revoked'
      )
    ),
  outcome TEXT NOT NULL
    CHECK (
      (event_kind = 'operation_started' AND outcome = 'pending')
      OR (
        event_kind = 'operation_terminal'
        AND outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered',
          'rejected',
          'unresolved'
        )
      )
      OR (
        event_kind IN (
          'claim_acquired',
          'lease_renewed',
          'lease_taken_over'
        )
        AND outcome = 'exact_success'
      )
      OR (
        event_kind = 'safety_diverted'
        AND outcome = 'disable_required'
      )
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
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at > 0),
  receipt_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(receipt_credential_id_sha256) = 'text'
      AND length(receipt_credential_id_sha256) = 64
      AND receipt_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_id_sha256) = 'text'
      AND length(request_id_sha256) = 64
      AND request_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(receipt_digest_sha256) = 'text'
      AND length(receipt_digest_sha256) = 64
      AND receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (authorization_id_sha256, sequence),
  CHECK (receipt_digest_sha256 <> predecessor_receipt_sha256),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES shard_placement_authority_execution_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_shard_placement_authority_execution_receipts_digest
ON shard_placement_authority_execution_receipts(receipt_digest_sha256);

CREATE UNIQUE INDEX idx_shard_placement_authority_execution_receipts_start
ON shard_placement_authority_execution_receipts(
  authorization_id_sha256,
  operation_ordinal
)
WHERE event_kind = 'operation_started';

CREATE UNIQUE INDEX idx_shard_placement_authority_execution_receipts_terminal
ON shard_placement_authority_execution_receipts(
  authorization_id_sha256,
  operation_ordinal
)
WHERE event_kind = 'operation_terminal';

CREATE TRIGGER shard_placement_authority_execution_claim_insert_guard
BEFORE INSERT ON shard_placement_authority_execution_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    NEW.claimed_at <> unixepoch()
    OR NEW.updated_at <> unixepoch()
  THEN RAISE(ABORT, 'placement execution claim time must come from D1') END;

  SELECT CASE WHEN
    NEW.status <> 'acquiring'
    OR NEW.lease_owner_sha256 <> NEW.claim_owner_sha256
    OR NEW.lease_generation <> 1
    OR NEW.lease_expires_at <> NEW.claimed_at + 60
    OR NEW.ledger_version <> 0
    OR NEW.ledger_head_sha256 <>
      NEW.baseline_terminal_digest_sha256
    OR NEW.last_completed_ordinal <> 1
    OR NEW.inflight_operation_ordinal IS NOT NULL
    OR NEW.inflight_operation_id_sha256 IS NOT NULL
    OR NEW.inflight_request_sha256 IS NOT NULL
    OR NEW.inflight_cloudflare_request_id_sha256 IS NOT NULL
    OR NEW.inflight_started_generation IS NOT NULL
    OR NEW.inflight_started_owner_sha256 IS NOT NULL
    OR NEW.inflight_started_lease_token_sha256 IS NOT NULL
    OR NEW.inflight_readback_only <> 0
    OR NEW.enable_intent_seen <> 0
    OR NEW.disable_confirmed <> 1
    OR NEW.application_activation_digest_sha256 IS NOT NULL
    OR NEW.ticket_activation_confirmed <> 0
    OR NEW.renewal_count <> 0
    OR NEW.takeover_count <> 0
    OR NEW.terminal_at IS NOT NULL
  THEN RAISE(ABORT, 'placement execution claim initial projection is invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_issuances AS issuance
    WHERE issuance.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND issuance.permit_subject_digest_sha256 =
        NEW.permit_subject_digest_sha256
      AND issuance.execution_nonce_sha256 =
        NEW.execution_nonce_sha256
      AND issuance.campaign_id = NEW.campaign_id
      AND issuance.campaign_nonce_sha256 =
        NEW.campaign_nonce_sha256
      AND issuance.shard_count = 8
      AND issuance.environment = 'staging'
      AND issuance.permit_issued_at <= unixepoch()
      AND issuance.permit_expires_at =
        NEW.permit_expires_at
      AND NEW.generated_at >= issuance.permit_issued_at
      AND NEW.generated_at <= unixepoch()
      AND NEW.normal_deadline_at <=
        issuance.permit_expires_at
      AND NEW.normal_deadline_at >= unixepoch() + 60
      AND NEW.lease_expires_at <=
        NEW.normal_deadline_at
  ) THEN RAISE(ABORT, 'placement execution claim does not match an active eight-shard issuance') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM shard_placement_authority_revocations AS revocation
    WHERE revocation.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND revocation.permit_subject_digest_sha256 =
        NEW.permit_subject_digest_sha256
  ) THEN RAISE(ABORT, 'placement execution claim authorization is revoked') END;
END;

CREATE TRIGGER shard_placement_authority_execution_claim_identity_update_guard
BEFORE UPDATE OF
  authorization_id_sha256,
  permit_subject_digest_sha256,
  execution_nonce_sha256,
  application_ticket_id_sha256,
  application_ticket_digest_sha256,
  application_database_identity_sha256,
  authority_database_identity_sha256,
  campaign_id,
  campaign_nonce_sha256,
  claim_scope,
  execution_plan_sha256,
  release_sha256,
  publication_sha256,
  execution_activation_sha256,
  runner_build_sha256,
  claim_owner_sha256,
  ledger_identity_sha256,
  baseline_operation_id_sha256,
  baseline_terminal_digest_sha256,
  preparation_operation_id_sha256,
  claim_operation_id_sha256,
  operation_schedule_sha256,
  claim_credential_id_sha256,
  claim_request_id_sha256,
  claim_digest_sha256,
  claim_acquired_receipt_digest_sha256,
  permit_expires_at,
  normal_deadline_at,
  recovery_deadline_at,
  generated_at,
  claimed_at
ON shard_placement_authority_execution_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution claim identity is immutable');
END;

CREATE TRIGGER shard_placement_authority_execution_claim_projection_update_guard
BEFORE UPDATE OF
  lease_owner_sha256,
  lease_token_sha256,
  lease_generation,
  lease_expires_at,
  status,
  ledger_version,
  ledger_head_sha256,
  last_completed_ordinal,
  inflight_operation_ordinal,
  inflight_operation_id_sha256,
  inflight_request_sha256,
  inflight_cloudflare_request_id_sha256,
  inflight_started_generation,
  inflight_started_owner_sha256,
  inflight_started_lease_token_sha256,
  inflight_readback_only,
  enable_intent_seen,
  disable_confirmed,
  application_activation_digest_sha256,
  ticket_activation_confirmed,
  renewal_count,
  takeover_count,
  updated_at,
  terminal_at
ON shard_placement_authority_execution_claims
FOR EACH ROW
WHEN NOT (
  (
    NEW.ledger_version = OLD.ledger_version + 1
    AND EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_receipts AS receipt
      WHERE receipt.authorization_id_sha256 =
        OLD.authorization_id_sha256
        AND receipt.sequence = NEW.ledger_version
        AND receipt.predecessor_receipt_sha256 =
          OLD.ledger_head_sha256
        AND NEW.ledger_head_sha256 =
          receipt.receipt_digest_sha256
        AND NEW.updated_at = receipt.recorded_at
    )
  )
  OR (
    NEW.ledger_version = OLD.ledger_version
    AND NEW.ledger_head_sha256 = OLD.ledger_head_sha256
    AND NEW.lease_owner_sha256 = OLD.lease_owner_sha256
    AND NEW.lease_token_sha256 = OLD.lease_token_sha256
    AND NEW.lease_generation = OLD.lease_generation
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.last_completed_ordinal =
      OLD.last_completed_ordinal
    AND NEW.inflight_operation_ordinal IS
      OLD.inflight_operation_ordinal
    AND NEW.inflight_operation_id_sha256 IS
      OLD.inflight_operation_id_sha256
    AND NEW.inflight_request_sha256 IS
      OLD.inflight_request_sha256
    AND NEW.inflight_cloudflare_request_id_sha256 IS
      OLD.inflight_cloudflare_request_id_sha256
    AND NEW.inflight_started_generation IS
      OLD.inflight_started_generation
    AND NEW.inflight_started_owner_sha256 IS
      OLD.inflight_started_owner_sha256
    AND NEW.inflight_started_lease_token_sha256 IS
      OLD.inflight_started_lease_token_sha256
    AND NEW.enable_intent_seen = OLD.enable_intent_seen
    AND NEW.disable_confirmed = OLD.disable_confirmed
    AND NEW.application_activation_digest_sha256 IS
      OLD.application_activation_digest_sha256
    AND NEW.ticket_activation_confirmed =
      OLD.ticket_activation_confirmed
    AND NEW.renewal_count = OLD.renewal_count
    AND NEW.takeover_count = OLD.takeover_count
    AND OLD.status IN (
      'claimed',
      'running',
      'disable_required',
      'recovery_required'
    )
    AND EXISTS (
      SELECT 1
      FROM shard_placement_authority_revocations AS revocation
      WHERE revocation.authorization_id_sha256 =
        OLD.authorization_id_sha256
        AND revocation.permit_subject_digest_sha256 =
          OLD.permit_subject_digest_sha256
        AND NEW.updated_at = revocation.recorded_at
        AND NEW.status = CASE
          WHEN OLD.enable_intent_seen = 0
            THEN 'revoked'
          ELSE 'disable_required'
        END
        AND NEW.inflight_readback_only = CASE
          WHEN OLD.enable_intent_seen = 1
            AND OLD.inflight_operation_ordinal IS NOT NULL
            THEN 1
          ELSE OLD.inflight_readback_only
        END
        AND NEW.terminal_at IS CASE
          WHEN OLD.enable_intent_seen = 0
            THEN revocation.recorded_at
          ELSE OLD.terminal_at
        END
    )
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'placement execution projection requires a receipt or revocation'
  );
END;

CREATE TRIGGER shard_placement_authority_execution_claim_delete_guard
BEFORE DELETE ON shard_placement_authority_execution_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution claims are append-preserved');
END;

CREATE TRIGGER shard_placement_authority_execution_operation_insert_guard
BEFORE INSERT ON shard_placement_authority_execution_operations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status = 'claimed'
      AND claim.ledger_version = 1
      AND claim.last_completed_ordinal = 3
      AND claim.inflight_operation_ordinal IS NULL
      AND unixepoch() < claim.lease_expires_at
      AND unixepoch() < claim.normal_deadline_at
      AND NOT EXISTS (
        SELECT 1
        FROM shard_placement_authority_revocations AS revocation
        WHERE revocation.authorization_id_sha256 =
          claim.authorization_id_sha256
          AND revocation.permit_subject_digest_sha256 =
            claim.permit_subject_digest_sha256
      )
  ) THEN RAISE(ABORT, 'placement execution operation does not match a fresh claim') END;
END;


CREATE TRIGGER shard_placement_authority_execution_receipt_insert_guard
BEFORE INSERT ON shard_placement_authority_execution_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'placement execution receipt time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND NEW.sequence = claim.ledger_version + 1
      AND NEW.predecessor_receipt_sha256 =
        claim.ledger_head_sha256
      AND NEW.claim_digest_sha256 =
        claim.claim_digest_sha256
      AND NEW.execution_plan_sha256 =
        claim.execution_plan_sha256
      AND NEW.ledger_identity_sha256 =
        claim.ledger_identity_sha256
  ) THEN RAISE(ABORT, 'placement execution receipt fence mismatch') END;

  SELECT CASE WHEN NEW.event_kind IN (
    'operation_started',
    'operation_terminal',
    'safety_diverted'
  ) AND (
    (
      SELECT COUNT(*)
      FROM shard_placement_authority_execution_operations AS operation
      WHERE operation.authorization_id_sha256 =
        NEW.authorization_id_sha256
    ) <> 11
    OR NOT EXISTS (
      SELECT 1
      FROM shard_placement_authority_execution_operations AS operation
      WHERE operation.authorization_id_sha256 =
        NEW.authorization_id_sha256
        AND operation.ordinal = NEW.operation_ordinal
        AND operation.operation_id_sha256 =
          NEW.operation_id_sha256
        AND operation.kind = NEW.operation_kind
        AND operation.shard_index IS NEW.shard_index
    )
  )
  THEN RAISE(ABORT, 'placement execution operation identity mismatch') END;

  SELECT CASE WHEN NEW.event_kind = 'claim_acquired' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status = 'acquiring'
      AND claim.ledger_version = 0
      AND NEW.sequence = 1
      AND NEW.operation_ordinal = 3
      AND NEW.operation_id_sha256 =
        claim.claim_operation_id_sha256
      AND NEW.operation_kind = 'create_authority_claim'
      AND NEW.shard_index IS NULL
      AND NEW.request_sha256 = claim.claim_digest_sha256
      AND NEW.response_sha256 IS NULL
      AND NEW.cloudflare_request_id_sha256 IS NULL
      AND NEW.safety_reason IS NULL
      AND NEW.outcome = 'exact_success'
      AND NEW.lease_owner_sha256 =
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 =
        claim.lease_token_sha256
      AND NEW.lease_generation = 1
      AND NEW.lease_expires_at =
        claim.lease_expires_at
      AND NEW.receipt_digest_sha256 =
        claim.claim_acquired_receipt_digest_sha256
      AND NEW.receipt_credential_id_sha256 =
        claim.claim_credential_id_sha256
      AND NEW.request_id_sha256 =
        claim.claim_request_id_sha256
      AND NEW.recorded_at = claim.claimed_at
  ) THEN RAISE(ABORT, 'placement execution acquisition receipt is invalid') END;

  SELECT CASE WHEN NEW.event_kind = 'lease_renewed' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status IN (
        'claimed',
        'running',
        'disable_required',
        'recovery_required'
      )
      AND NEW.operation_ordinal = 3
      AND NEW.operation_id_sha256 =
        claim.claim_operation_id_sha256
      AND NEW.operation_kind = 'create_authority_claim'
      AND NEW.shard_index IS NULL
      AND NEW.response_sha256 IS NULL
      AND NEW.cloudflare_request_id_sha256 IS NULL
      AND NEW.safety_reason IS NULL
      AND NEW.outcome = 'exact_success'
      AND NEW.lease_owner_sha256 =
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 =
        claim.lease_token_sha256
      AND NEW.lease_generation =
        claim.lease_generation
      AND NEW.recorded_at < claim.lease_expires_at
      AND NEW.lease_expires_at = NEW.recorded_at + 60
      AND NEW.lease_expires_at > claim.lease_expires_at
      AND NEW.lease_expires_at <= CASE
        WHEN claim.enable_intent_seen = 1
          THEN claim.recovery_deadline_at
        ELSE claim.normal_deadline_at
      END
  ) THEN RAISE(ABORT, 'placement execution lease renewal is invalid') END;

  SELECT CASE WHEN NEW.event_kind = 'lease_taken_over' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status IN (
        'claimed',
        'running',
        'disable_required',
        'recovery_required'
      )
      AND NEW.operation_ordinal = 3
      AND NEW.operation_id_sha256 =
        claim.claim_operation_id_sha256
      AND NEW.operation_kind = 'create_authority_claim'
      AND NEW.shard_index IS NULL
      AND NEW.response_sha256 IS NULL
      AND NEW.cloudflare_request_id_sha256 IS NULL
      AND NEW.safety_reason IS NULL
      AND NEW.outcome = 'exact_success'
      AND NEW.lease_generation =
        claim.lease_generation + 1
      AND NEW.lease_owner_sha256 <>
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 <>
        claim.lease_token_sha256
      AND NEW.recorded_at >= claim.lease_expires_at
      AND NEW.lease_expires_at = NEW.recorded_at + 60
      AND NEW.lease_expires_at <= claim.recovery_deadline_at
  ) THEN RAISE(ABORT, 'placement execution lease takeover is invalid') END;

  SELECT CASE WHEN NEW.event_kind = 'operation_started' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status IN (
        'claimed',
        'running',
        'disable_required'
      )
      AND claim.inflight_operation_ordinal IS NULL
      AND NEW.cloudflare_request_id_sha256 IS NULL
      AND NEW.response_sha256 IS NULL
      AND NEW.safety_reason IS NULL
      AND NEW.outcome = 'pending'
      AND NEW.lease_owner_sha256 =
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 =
        claim.lease_token_sha256
      AND NEW.lease_generation =
        claim.lease_generation
      AND NEW.lease_expires_at =
        claim.lease_expires_at
      AND NEW.recorded_at < claim.lease_expires_at
      AND (
        (
          claim.status IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM shard_placement_authority_revocations AS revocation
            WHERE revocation.authorization_id_sha256 =
              claim.authorization_id_sha256
              AND revocation.permit_subject_digest_sha256 =
                claim.permit_subject_digest_sha256
          )
          AND NEW.operation_ordinal =
            claim.last_completed_ordinal + 1
          AND NEW.operation_ordinal BETWEEN 4 AND 13
          AND (
            NEW.operation_ordinal <> 5
            OR (
              claim.ticket_activation_confirmed = 1
              AND claim.application_activation_digest_sha256 IS NOT NULL
            )
          )
          AND NEW.recorded_at < claim.normal_deadline_at
        )
        OR (
          NEW.operation_ordinal = 14
          AND (
            (
              claim.status IN ('claimed', 'running')
              AND claim.last_completed_ordinal = 13
            )
            OR claim.status = 'disable_required'
          )
          AND NEW.recorded_at < claim.recovery_deadline_at
        )
      )
  ) THEN RAISE(ABORT, 'placement execution operation start is invalid') END;

  SELECT CASE WHEN NEW.event_kind = 'operation_terminal' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    JOIN shard_placement_authority_execution_receipts AS started
      ON started.authorization_id_sha256 =
        claim.authorization_id_sha256
      AND started.event_kind = 'operation_started'
      AND started.operation_ordinal =
        claim.inflight_operation_ordinal
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status IN ('running', 'disable_required')
      AND claim.inflight_operation_ordinal =
        NEW.operation_ordinal
      AND claim.inflight_operation_id_sha256 =
        NEW.operation_id_sha256
      AND claim.inflight_request_sha256 =
        NEW.request_sha256
      AND NEW.operation_id_sha256 =
        started.operation_id_sha256
      AND NEW.operation_kind =
        started.operation_kind
      AND NEW.shard_index IS started.shard_index
      AND NEW.request_sha256 =
        started.request_sha256
      AND NEW.response_sha256 IS NOT NULL
      AND NEW.safety_reason IS NULL
      AND NEW.lease_owner_sha256 =
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 =
        claim.lease_token_sha256
      AND NEW.lease_generation =
        claim.lease_generation
      AND NEW.lease_expires_at =
        claim.lease_expires_at
      AND NEW.recorded_at < claim.lease_expires_at
      AND NEW.recorded_at < claim.recovery_deadline_at
  ) THEN RAISE(ABORT, 'placement execution terminal is not an exact readback') END;

  SELECT CASE WHEN NEW.event_kind = 'safety_diverted' AND NOT EXISTS (
    SELECT 1
    FROM shard_placement_authority_execution_claims AS claim
    WHERE claim.authorization_id_sha256 =
      NEW.authorization_id_sha256
      AND claim.status IN (
        'claimed',
        'running',
        'disable_required'
      )
      AND claim.inflight_operation_ordinal IS NULL
      AND NEW.operation_ordinal = 14
      AND NEW.operation_id_sha256 = (
        SELECT operation.operation_id_sha256
        FROM shard_placement_authority_execution_operations AS operation
        WHERE operation.authorization_id_sha256 =
          claim.authorization_id_sha256
          AND operation.ordinal = 14
      )
      AND NEW.operation_kind = 'disable_controller_deployment'
      AND NEW.shard_index IS NULL
      AND NEW.response_sha256 IS NULL
      AND NEW.cloudflare_request_id_sha256 IS NULL
      AND NEW.outcome = 'disable_required'
      AND NEW.safety_reason IS NOT NULL
      AND NEW.lease_owner_sha256 =
        claim.lease_owner_sha256
      AND NEW.lease_token_sha256 =
        claim.lease_token_sha256
      AND NEW.lease_generation =
        claim.lease_generation
      AND NEW.lease_expires_at =
        claim.lease_expires_at
      AND NEW.recorded_at < claim.lease_expires_at
      AND NEW.recorded_at < claim.recovery_deadline_at
  ) THEN RAISE(ABORT, 'placement execution safety diversion is invalid') END;
END;

CREATE TRIGGER shard_placement_authority_execution_receipt_apply
AFTER INSERT ON shard_placement_authority_execution_receipts
FOR EACH ROW
BEGIN
  UPDATE shard_placement_authority_execution_claims
  SET
    lease_owner_sha256 = CASE
      WHEN NEW.event_kind = 'lease_taken_over'
        THEN NEW.lease_owner_sha256
      ELSE lease_owner_sha256
    END,
    lease_token_sha256 = CASE
      WHEN NEW.event_kind = 'lease_taken_over'
        THEN NEW.lease_token_sha256
      ELSE lease_token_sha256
    END,
    lease_generation = CASE
      WHEN NEW.event_kind = 'lease_taken_over'
        THEN NEW.lease_generation
      ELSE lease_generation
    END,
    lease_expires_at = CASE
      WHEN NEW.event_kind IN (
        'lease_renewed',
        'lease_taken_over'
      )
        THEN NEW.lease_expires_at
      ELSE lease_expires_at
    END,
    status = CASE
      WHEN NEW.event_kind = 'claim_acquired' THEN 'claimed'
      WHEN NEW.event_kind = 'safety_diverted'
        AND enable_intent_seen = 0 THEN 'aborted'
      WHEN NEW.event_kind = 'safety_diverted'
        THEN 'disable_required'
      WHEN NEW.event_kind = 'lease_taken_over'
        AND enable_intent_seen = 1
        THEN 'disable_required'
      WHEN NEW.event_kind = 'operation_started'
        AND status = 'claimed' THEN 'running'
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 14
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN 'completed'
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 14
        THEN 'recovery_required'
      WHEN NEW.event_kind = 'operation_terminal'
        AND EXISTS (
          SELECT 1
          FROM shard_placement_authority_revocations AS revocation
          WHERE revocation.authorization_id_sha256 =
            NEW.authorization_id_sha256
        )
        THEN 'disable_required'
      WHEN NEW.event_kind = 'operation_terminal'
        AND status = 'disable_required'
        THEN 'disable_required'
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN 'running'
      WHEN NEW.event_kind = 'operation_terminal'
        AND enable_intent_seen = 1
        THEN 'disable_required'
      WHEN NEW.event_kind = 'operation_terminal'
        THEN 'aborted'
      ELSE status
    END,
    ledger_version = ledger_version + 1,
    ledger_head_sha256 = NEW.receipt_digest_sha256,
    last_completed_ordinal = CASE
      WHEN NEW.event_kind = 'claim_acquired' THEN 3
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN NEW.operation_ordinal
      ELSE last_completed_ordinal
    END,
    inflight_operation_ordinal = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.operation_ordinal
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_operation_ordinal
    END,
    inflight_operation_id_sha256 = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.operation_id_sha256
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_operation_id_sha256
    END,
    inflight_request_sha256 = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.request_sha256
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_request_sha256
    END,
    inflight_cloudflare_request_id_sha256 = CASE
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_cloudflare_request_id_sha256
    END,
    inflight_started_generation = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.lease_generation
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_started_generation
    END,
    inflight_started_owner_sha256 = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.lease_owner_sha256
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_started_owner_sha256
    END,
    inflight_started_lease_token_sha256 = CASE
      WHEN NEW.event_kind = 'operation_started'
        THEN NEW.lease_token_sha256
      WHEN NEW.event_kind = 'operation_terminal' THEN NULL
      ELSE inflight_started_lease_token_sha256
    END,
    inflight_readback_only = CASE
      WHEN NEW.event_kind = 'lease_taken_over'
        AND inflight_operation_ordinal IS NOT NULL
        THEN 1
      WHEN NEW.event_kind = 'operation_terminal' THEN 0
      ELSE inflight_readback_only
    END,
    enable_intent_seen = CASE
      WHEN NEW.event_kind = 'operation_started'
        AND NEW.operation_ordinal = 5 THEN 1
      ELSE enable_intent_seen
    END,
    disable_confirmed = CASE
      WHEN NEW.event_kind = 'operation_started'
        AND NEW.operation_ordinal = 5 THEN 0
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 14
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN 1
      ELSE disable_confirmed
    END,
    application_activation_digest_sha256 = CASE
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 4
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN NEW.evidence_sha256
      ELSE application_activation_digest_sha256
    END,
    ticket_activation_confirmed = CASE
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 4
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN 1
      ELSE ticket_activation_confirmed
    END,
    renewal_count = renewal_count + CASE
      WHEN NEW.event_kind = 'lease_renewed' THEN 1
      ELSE 0
    END,
    takeover_count = takeover_count + CASE
      WHEN NEW.event_kind = 'lease_taken_over' THEN 1
      ELSE 0
    END,
    updated_at = NEW.recorded_at,
    terminal_at = CASE
      WHEN NEW.event_kind = 'safety_diverted'
        AND enable_intent_seen = 0 THEN NEW.recorded_at
      WHEN NEW.event_kind = 'operation_terminal'
        AND NEW.operation_ordinal = 14
        AND NEW.outcome IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN NEW.recorded_at
      WHEN NEW.event_kind = 'operation_terminal'
        AND enable_intent_seen = 0
        AND NEW.outcome NOT IN (
          'exact_success',
          'exact_replay',
          'ambiguous_recovered'
        )
        THEN NEW.recorded_at
      ELSE terminal_at
    END
  WHERE authorization_id_sha256 = NEW.authorization_id_sha256;
END;

CREATE TRIGGER shard_placement_authority_execution_claim_acquire
AFTER INSERT ON shard_placement_authority_execution_claims
FOR EACH ROW
BEGIN
  INSERT INTO shard_placement_authority_execution_receipts (
    authorization_id_sha256,
    sequence,
    event_kind,
    claim_digest_sha256,
    execution_plan_sha256,
    ledger_identity_sha256,
    operation_ordinal,
    operation_id_sha256,
    operation_kind,
    shard_index,
    predecessor_receipt_sha256,
    request_sha256,
    response_sha256,
    cloudflare_request_id_sha256,
    evidence_sha256,
    safety_reason,
    outcome,
    lease_owner_sha256,
    lease_token_sha256,
    lease_generation,
    lease_expires_at,
    receipt_credential_id_sha256,
    request_id_sha256,
    receipt_digest_sha256,
    recorded_at
  ) VALUES (
    NEW.authorization_id_sha256,
    1,
    'claim_acquired',
    NEW.claim_digest_sha256,
    NEW.execution_plan_sha256,
    NEW.ledger_identity_sha256,
    3,
    NEW.claim_operation_id_sha256,
    'create_authority_claim',
    NULL,
    NEW.baseline_terminal_digest_sha256,
    NEW.claim_digest_sha256,
    NULL,
    NULL,
    NEW.claim_digest_sha256,
    NULL,
    'exact_success',
    NEW.claim_owner_sha256,
    NEW.lease_token_sha256,
    1,
    NEW.lease_expires_at,
    NEW.claim_credential_id_sha256,
    NEW.claim_request_id_sha256,
    NEW.claim_acquired_receipt_digest_sha256,
    NEW.claimed_at
  );
END;

CREATE TRIGGER shard_placement_authority_execution_receipt_update_guard
BEFORE UPDATE ON shard_placement_authority_execution_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution receipts are immutable');
END;

CREATE TRIGGER shard_placement_authority_execution_receipt_delete_guard
BEFORE DELETE ON shard_placement_authority_execution_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution receipts are append-preserved');
END;

CREATE TRIGGER shard_placement_authority_execution_revocation_apply
AFTER INSERT ON shard_placement_authority_revocations
FOR EACH ROW
BEGIN
  UPDATE shard_placement_authority_execution_claims
  SET
    status = CASE
      WHEN enable_intent_seen = 0 THEN 'revoked'
      ELSE 'disable_required'
    END,
    inflight_readback_only = CASE
      WHEN enable_intent_seen = 1
        AND inflight_operation_ordinal IS NOT NULL
        THEN 1
      ELSE inflight_readback_only
    END,
    updated_at = NEW.recorded_at,
    terminal_at = CASE
      WHEN enable_intent_seen = 0 THEN NEW.recorded_at
      ELSE terminal_at
    END
  WHERE authorization_id_sha256 = NEW.authorization_id_sha256
    AND permit_subject_digest_sha256 =
      NEW.permit_subject_digest_sha256
    AND status IN (
      'claimed',
      'running',
      'disable_required',
      'recovery_required'
    );
END;

CREATE TRIGGER shard_placement_authority_execution_operation_update_guard
BEFORE UPDATE ON shard_placement_authority_execution_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution operations are immutable');
END;

CREATE TRIGGER shard_placement_authority_execution_operation_delete_guard
BEFORE DELETE ON shard_placement_authority_execution_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement execution operations are append-preserved');
END;
