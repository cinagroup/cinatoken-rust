CREATE TABLE shard_placement_authority_issuances (
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
  campaign_id TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_id) = 'text'
      AND length(campaign_id) = 64
      AND campaign_id NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_nonce_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(campaign_nonce_sha256) = 'text'
      AND length(campaign_nonce_sha256) = 64
      AND campaign_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_subject_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(permit_subject_digest_sha256) = 'text'
      AND length(permit_subject_digest_sha256) = 64
      AND permit_subject_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  issuance_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(issuance_request_sha256) = 'text'
      AND length(issuance_request_sha256) = 64
      AND issuance_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approvals_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(approvals_digest_sha256) = 'text'
      AND length(approvals_digest_sha256) = 64
      AND approvals_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  policy_id TEXT NOT NULL
    CHECK (
      typeof(policy_id) = 'text'
      AND length(policy_id) BETWEEN 1 AND 64
      AND substr(policy_id, 1, 1) GLOB '[a-z0-9]'
      AND policy_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  policy_sha256 TEXT NOT NULL
    CHECK (
      typeof(policy_sha256) = 'text'
      AND length(policy_sha256) = 64
      AND policy_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  permit_issuer TEXT NOT NULL
    CHECK (
      typeof(permit_issuer) = 'text'
      AND length(permit_issuer) BETWEEN 1 AND 128
      AND substr(permit_issuer, 1, 1) GLOB '[A-Za-z0-9]'
      AND permit_issuer NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  permit_key_id TEXT NOT NULL
    CHECK (
      typeof(permit_key_id) = 'text'
      AND length(permit_key_id) BETWEEN 1 AND 64
      AND substr(permit_key_id, 1, 1) GLOB '[a-z0-9]'
      AND permit_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  permit_signer_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(permit_signer_spki_sha256) = 'text'
      AND length(permit_signer_spki_sha256) = 64
      AND permit_signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  environment TEXT NOT NULL CHECK (environment = 'staging'),
  controller_service_name TEXT NOT NULL
    CHECK (
      controller_service_name = 'cinatoken-container-controller-staging'
    ),
  controller_version_id TEXT NOT NULL
    CHECK (
      typeof(controller_version_id) = 'text'
      AND length(controller_version_id) BETWEEN 1 AND 128
      AND substr(controller_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND controller_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  action_gate_inventory_sha256 TEXT NOT NULL
    CHECK (
      typeof(action_gate_inventory_sha256) = 'text'
      AND length(action_gate_inventory_sha256) = 64
      AND action_gate_inventory_sha256 NOT GLOB '*[^0-9a-f]*'
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
  campaign_lifetime_seconds INTEGER NOT NULL
    CHECK (
      typeof(campaign_lifetime_seconds) = 'integer'
      AND campaign_lifetime_seconds BETWEEN 60 AND 3600
    ),
  permit_issued_at INTEGER NOT NULL
    CHECK (typeof(permit_issued_at) = 'integer' AND permit_issued_at > 0),
  permit_expires_at INTEGER NOT NULL
    CHECK (
      typeof(permit_expires_at) = 'integer'
      AND permit_expires_at >= permit_issued_at + 60
      AND permit_expires_at <= permit_issued_at + 600
    ),
  security_key_id TEXT NOT NULL
    CHECK (
      typeof(security_key_id) = 'text'
      AND length(security_key_id) BETWEEN 1 AND 64
      AND substr(security_key_id, 1, 1) GLOB '[a-z0-9]'
      AND security_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  security_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(security_spki_sha256) = 'text'
      AND length(security_spki_sha256) = 64
      AND security_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  security_signed_at INTEGER NOT NULL
    CHECK (typeof(security_signed_at) = 'integer' AND security_signed_at > 0),
  security_expires_at INTEGER NOT NULL
    CHECK (
      typeof(security_expires_at) = 'integer'
      AND security_expires_at > security_signed_at
    ),
  operations_key_id TEXT NOT NULL
    CHECK (
      typeof(operations_key_id) = 'text'
      AND length(operations_key_id) BETWEEN 1 AND 64
      AND substr(operations_key_id, 1, 1) GLOB '[a-z0-9]'
      AND operations_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  operations_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(operations_spki_sha256) = 'text'
      AND length(operations_spki_sha256) = 64
      AND operations_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operations_signed_at INTEGER NOT NULL
    CHECK (typeof(operations_signed_at) = 'integer' AND operations_signed_at > 0),
  operations_expires_at INTEGER NOT NULL
    CHECK (
      typeof(operations_expires_at) = 'integer'
      AND operations_expires_at > operations_signed_at
    ),
  release_key_id TEXT NOT NULL
    CHECK (
      typeof(release_key_id) = 'text'
      AND length(release_key_id) BETWEEN 1 AND 64
      AND substr(release_key_id, 1, 1) GLOB '[a-z0-9]'
      AND release_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  release_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(release_spki_sha256) = 'text'
      AND length(release_spki_sha256) = 64
      AND release_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  release_signed_at INTEGER NOT NULL
    CHECK (typeof(release_signed_at) = 'integer' AND release_signed_at > 0),
  release_expires_at INTEGER NOT NULL
    CHECK (
      typeof(release_expires_at) = 'integer'
      AND release_expires_at > release_signed_at
    ),
  rollback_key_id TEXT NOT NULL
    CHECK (
      typeof(rollback_key_id) = 'text'
      AND length(rollback_key_id) BETWEEN 1 AND 64
      AND substr(rollback_key_id, 1, 1) GLOB '[a-z0-9]'
      AND rollback_key_id NOT GLOB '*[^a-z0-9._-]*'
    ),
  rollback_spki_sha256 TEXT NOT NULL
    CHECK (
      typeof(rollback_spki_sha256) = 'text'
      AND length(rollback_spki_sha256) = 64
      AND rollback_spki_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  rollback_signed_at INTEGER NOT NULL
    CHECK (typeof(rollback_signed_at) = 'integer' AND rollback_signed_at > 0),
  rollback_expires_at INTEGER NOT NULL
    CHECK (
      typeof(rollback_expires_at) = 'integer'
      AND rollback_expires_at > rollback_signed_at
    ),
  issue_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(issue_credential_id_sha256) = 'text'
      AND length(issue_credential_id_sha256) = 64
      AND issue_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_version_id TEXT NOT NULL
    CHECK (
      typeof(authority_version_id) = 'text'
      AND length(authority_version_id) BETWEEN 1 AND 128
      AND substr(authority_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND authority_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  CHECK (
    authorization_id_sha256 <> execution_nonce_sha256
    AND authorization_id_sha256 <> campaign_nonce_sha256
    AND execution_nonce_sha256 <> campaign_nonce_sha256
  ),
  CHECK (
    security_key_id <> operations_key_id
    AND security_key_id <> release_key_id
    AND security_key_id <> rollback_key_id
    AND operations_key_id <> release_key_id
    AND operations_key_id <> rollback_key_id
    AND release_key_id <> rollback_key_id
  ),
  CHECK (
    security_spki_sha256 <> operations_spki_sha256
    AND security_spki_sha256 <> release_spki_sha256
    AND security_spki_sha256 <> rollback_spki_sha256
    AND operations_spki_sha256 <> release_spki_sha256
    AND operations_spki_sha256 <> rollback_spki_sha256
    AND release_spki_sha256 <> rollback_spki_sha256
    AND permit_signer_spki_sha256 <> security_spki_sha256
    AND permit_signer_spki_sha256 <> operations_spki_sha256
    AND permit_signer_spki_sha256 <> release_spki_sha256
    AND permit_signer_spki_sha256 <> rollback_spki_sha256
  )
) WITHOUT ROWID;

CREATE INDEX idx_shard_placement_authority_issuances_candidate
ON shard_placement_authority_issuances(
  controller_version_id,
  ring_generation,
  campaign_id
);

CREATE TRIGGER shard_placement_authority_issuance_insert_guard
BEFORE INSERT ON shard_placement_authority_issuances
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'placement authority time must come from D1') END;

  SELECT CASE WHEN
    NEW.permit_issued_at > unixepoch() + 120
    OR NEW.permit_expires_at < unixepoch() + 60
  THEN RAISE(ABORT, 'placement authority permit is outside its D1 window') END;

  SELECT CASE WHEN
    NEW.security_signed_at > unixepoch() + 120
    OR NEW.operations_signed_at > unixepoch() + 120
    OR NEW.release_signed_at > unixepoch() + 120
    OR NEW.rollback_signed_at > unixepoch() + 120
    OR NEW.security_expires_at < NEW.permit_expires_at
    OR NEW.operations_expires_at < NEW.permit_expires_at
    OR NEW.release_expires_at < NEW.permit_expires_at
    OR NEW.rollback_expires_at < NEW.permit_expires_at
  THEN RAISE(ABORT, 'placement authority approval window is invalid') END;
END;

CREATE TRIGGER shard_placement_authority_issuance_update_guard
BEFORE UPDATE ON shard_placement_authority_issuances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement authority issuances are immutable');
END;

CREATE TRIGGER shard_placement_authority_issuance_delete_guard
BEFORE DELETE ON shard_placement_authority_issuances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement authority issuances are append-preserved');
END;

CREATE TABLE shard_placement_authority_revocations (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  permit_subject_digest_sha256 TEXT NOT NULL,
  reason_code TEXT NOT NULL
    CHECK (
      reason_code IN (
        'operator_abort',
        'key_compromise',
        'candidate_retired',
        'evidence_drift'
      )
    ),
  evidence_sha256 TEXT NOT NULL
    CHECK (
      typeof(evidence_sha256) = 'text'
      AND length(evidence_sha256) = 64
      AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  revocation_event_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(revocation_event_sha256) = 'text'
      AND length(revocation_event_sha256) = 64
      AND revocation_event_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  revoke_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(revoke_credential_id_sha256) = 'text'
      AND length(revoke_credential_id_sha256) = 64
      AND revoke_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
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

CREATE UNIQUE INDEX idx_shard_placement_authority_issuance_subject
ON shard_placement_authority_issuances(
  authorization_id_sha256,
  permit_subject_digest_sha256
);

CREATE INDEX idx_shard_placement_authority_revocations_recorded
ON shard_placement_authority_revocations(recorded_at, authorization_id_sha256);

CREATE TRIGGER shard_placement_authority_revocation_insert_guard
BEFORE INSERT ON shard_placement_authority_revocations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'placement authority revocation time must come from D1') END;
END;

CREATE TRIGGER shard_placement_authority_revocation_update_guard
BEFORE UPDATE ON shard_placement_authority_revocations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement authority revocations are immutable');
END;

CREATE TRIGGER shard_placement_authority_revocation_delete_guard
BEFORE DELETE ON shard_placement_authority_revocations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'placement authority revocations are append-preserved');
END;
