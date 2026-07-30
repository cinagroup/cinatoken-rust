-- Consume each accepted-source authorization through one action-bound Root
-- registration receipt, one execution claim, and one terminal receipt.
--
-- This migration remains default-inert. It adds no route, credential issuer,
-- collector, close endpoint, traffic authority, or reopen path. Its guards
-- make the future writer protocol fail closed and append-preserved.

CREATE TABLE relay_container_drain_source_consumption_preflight (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1)
);

CREATE TRIGGER relay_container_drain_source_consumption_preflight_guard
BEFORE INSERT ON relay_container_drain_source_consumption_preflight
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    EXISTS (SELECT 1 FROM relay_container_drain_close_commands)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_scans)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_members)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_pages)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_shards)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_seals)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_authorizations)
    OR EXISTS (SELECT 1 FROM relay_container_drain_source_attestations)
  THEN RAISE(
    ABORT,
    '0073 requires an empty 0070-0072 drain authority and stopped writers'
  ) END;
END;

INSERT INTO relay_container_drain_source_consumption_preflight(singleton)
VALUES (1);

DROP TRIGGER relay_container_drain_source_consumption_preflight_guard;
DROP TABLE relay_container_drain_source_consumption_preflight;

CREATE TABLE relay_container_drain_source_authorization_registrations (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(authorization_id_sha256) = 'text'
      AND length(authorization_id_sha256) = 64
      AND authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  registration_contract TEXT NOT NULL
    CHECK (
      registration_contract =
        'relay-container-drain-source-authorization-registration-v1'
    ),
  registration_migration TEXT NOT NULL
    CHECK (
      registration_migration =
        '0073_relay_container_drain_source_authorization_consumption.sql'
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind = 'global'),
  scope_id_sha256 TEXT NOT NULL
    CHECK (
      scope_id_sha256 =
        '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    ),
  source_scan_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(source_scan_id_sha256) = 'text'
      AND length(source_scan_id_sha256) = 64
      AND source_scan_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  root_admin_id INTEGER NOT NULL
    CHECK (typeof(root_admin_id) = 'integer' AND root_admin_id > 0),
  root_session_epoch INTEGER NOT NULL
    CHECK (
      typeof(root_session_epoch) = 'integer'
      AND root_session_epoch >= 0
    ),
  root_session_binding_sha256 TEXT NOT NULL
    CHECK (
      typeof(root_session_binding_sha256) = 'text'
      AND length(root_session_binding_sha256) = 64
      AND root_session_binding_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  passkey_credential_row_id INTEGER NOT NULL
    CHECK (
      typeof(passkey_credential_row_id) = 'integer'
      AND passkey_credential_row_id > 0
    ),
  passkey_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(passkey_credential_id_sha256) = 'text'
      AND length(passkey_credential_id_sha256) = 64
      AND passkey_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  passkey_assertion_subject_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(passkey_assertion_subject_sha256) = 'text'
      AND length(passkey_assertion_subject_sha256) = 64
      AND passkey_assertion_subject_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  passkey_assertion_signature_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(passkey_assertion_signature_sha256) = 'text'
      AND length(passkey_assertion_signature_sha256) = 64
      AND passkey_assertion_signature_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  secure_verification_challenge_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(secure_verification_challenge_sha256) = 'text'
      AND length(secure_verification_challenge_sha256) = 64
      AND secure_verification_challenge_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  secure_verification_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(secure_verification_receipt_sha256) = 'text'
      AND length(secure_verification_receipt_sha256) = 64
      AND secure_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  action_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(action_digest_sha256) = 'text'
      AND length(action_digest_sha256) = 64
      AND action_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admin_audit_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(admin_audit_digest_sha256) = 'text'
      AND length(admin_audit_digest_sha256) = 64
      AND admin_audit_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  change_ticket_sha256 TEXT NOT NULL
    CHECK (
      typeof(change_ticket_sha256) = 'text'
      AND length(change_ticket_sha256) = 64
      AND change_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reason_code TEXT NOT NULL
    CHECK (
      typeof(reason_code) = 'text'
      AND length(reason_code) BETWEEN 1 AND 64
      AND substr(reason_code, 1, 1) GLOB '[a-z0-9]'
      AND substr(reason_code, -1, 1) GLOB '[a-z0-9]'
      AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
    ),
  registered_by_service_name TEXT NOT NULL
    CHECK (
      typeof(registered_by_service_name) = 'text'
      AND length(registered_by_service_name) BETWEEN 1 AND 128
      AND substr(registered_by_service_name, 1, 1) GLOB '[a-z0-9]'
      AND substr(registered_by_service_name, -1, 1) GLOB '[a-z0-9]'
      AND registered_by_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  registered_by_version_id TEXT NOT NULL
    CHECK (
      typeof(registered_by_version_id) = 'text'
      AND length(registered_by_version_id) BETWEEN 1 AND 128
      AND substr(registered_by_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND registered_by_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  registration_execution_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(registration_execution_id_sha256) = 'text'
      AND length(registration_execution_id_sha256) = 64
      AND registration_execution_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  registration_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(registration_credential_id_sha256) = 'text'
      AND length(registration_credential_id_sha256) = 64
      AND registration_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  registration_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(registration_request_sha256) = 'text'
      AND length(registration_request_sha256) = 64
      AND registration_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(receipt_sequence) = 'integer'
      AND receipt_sequence BETWEEN 1 AND 1000000
    ),
  ledger_head_before_sha256 TEXT NOT NULL
    CHECK (
      typeof(ledger_head_before_sha256) = 'text'
      AND length(ledger_head_before_sha256) = 64
      AND ledger_head_before_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  registration_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(registration_receipt_sha256) = 'text'
      AND length(registration_receipt_sha256) = 64
      AND registration_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  verified_at INTEGER NOT NULL
    CHECK (typeof(verified_at) = 'integer' AND verified_at > 0),
  verification_expires_at INTEGER NOT NULL
    CHECK (
      typeof(verification_expires_at) = 'integer'
      AND verification_expires_at > verified_at
      AND verification_expires_at - verified_at BETWEEN 30 AND 300
    ),
  registered_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (
      typeof(registered_at) = 'integer'
      AND registered_at >= verified_at
      AND registered_at < verification_expires_at
    ),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (root_admin_id)
    REFERENCES users(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    authorization_id_sha256 <> source_scan_id_sha256
    AND root_session_binding_sha256 <> passkey_credential_id_sha256
    AND passkey_assertion_subject_sha256 <>
          passkey_assertion_signature_sha256
    AND secure_verification_challenge_sha256 <>
          secure_verification_receipt_sha256
    AND secure_verification_challenge_sha256 <> action_digest_sha256
    AND secure_verification_receipt_sha256 <> action_digest_sha256
    AND registration_execution_id_sha256 <>
          registration_credential_id_sha256
    AND registration_request_sha256 <> registration_receipt_sha256
    AND registration_receipt_sha256 <>
          secure_verification_receipt_sha256
    AND authority_ledger_identity_sha256 = scope_id_sha256
    AND ledger_head_before_sha256 <> registration_receipt_sha256
  )
);

CREATE TABLE relay_container_drain_source_authorization_claims (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  claim_contract TEXT NOT NULL
    CHECK (
      claim_contract =
        'relay-container-drain-source-authorization-claim-v1'
    ),
  claim_migration TEXT NOT NULL
    CHECK (
      claim_migration =
        '0073_relay_container_drain_source_authorization_consumption.sql'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  registration_receipt_sha256 TEXT NOT NULL,
  execution_nonce_sha256 TEXT NOT NULL,
  claim_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_id_sha256) = 'text'
      AND length(claim_id_sha256) = 64
      AND claim_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_request_sha256) = 'text'
      AND length(claim_request_sha256) = 64
      AND claim_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  predecessor_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_receipt_sha256) = 'text'
      AND length(predecessor_receipt_sha256) = 64
      AND predecessor_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(receipt_sequence) = 'integer'
      AND receipt_sequence BETWEEN 2 AND 1000000
    ),
  claim_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_owner_service_name TEXT NOT NULL
    CHECK (
      typeof(claim_owner_service_name) = 'text'
      AND length(claim_owner_service_name) BETWEEN 1 AND 128
      AND substr(claim_owner_service_name, 1, 1) GLOB '[a-z0-9]'
      AND substr(claim_owner_service_name, -1, 1) GLOB '[a-z0-9]'
      AND claim_owner_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  claim_owner_version_id TEXT NOT NULL
    CHECK (
      typeof(claim_owner_version_id) = 'text'
      AND length(claim_owner_version_id) BETWEEN 1 AND 128
      AND substr(claim_owner_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND claim_owner_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  claim_owner_execution_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(claim_owner_execution_id_sha256) = 'text'
      AND length(claim_owner_execution_id_sha256) = 64
      AND claim_owner_execution_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_credential_id_sha256) = 'text'
      AND length(claim_credential_id_sha256) = 64
      AND claim_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  lease_expires_at INTEGER NOT NULL
    CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at > 0),
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(claimed_at) = 'integer' AND claimed_at > 0),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorization_registrations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    registration_receipt_sha256 = predecessor_receipt_sha256
    AND execution_nonce_sha256 <> claim_id_sha256
    AND claim_id_sha256 <> claim_request_sha256
    AND claim_id_sha256 <> claim_digest_sha256
    AND claim_request_sha256 <> claim_digest_sha256
    AND claim_owner_execution_id_sha256 <>
          claim_credential_id_sha256
    AND claim_digest_sha256 <> predecessor_receipt_sha256
    AND lease_expires_at > claimed_at
    AND lease_expires_at - claimed_at BETWEEN 30 AND 900
  )
);

CREATE TABLE relay_container_drain_source_terminal_receipts (
  authorization_id_sha256 TEXT PRIMARY KEY NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  terminal_contract TEXT NOT NULL
    CHECK (
      terminal_contract =
        'relay-container-drain-source-authorization-terminal-v1'
    ),
  terminal_migration TEXT NOT NULL
    CHECK (
      terminal_migration =
        '0073_relay_container_drain_source_authorization_consumption.sql'
    ),
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  registration_receipt_sha256 TEXT NOT NULL,
  claim_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_id_sha256) = 'text'
      AND length(claim_id_sha256) = 64
      AND claim_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  claim_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(claim_digest_sha256) = 'text'
      AND length(claim_digest_sha256) = 64
      AND claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(receipt_sequence) = 'integer'
      AND receipt_sequence BETWEEN 3 AND 1000000
    ),
  predecessor_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_receipt_sha256) = 'text'
      AND length(predecessor_receipt_sha256) = 64
      AND predecessor_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_outcome TEXT NOT NULL
    CHECK (
      terminal_outcome IN (
        'succeeded',
        'failed',
        'expired',
        'ambiguous'
      )
    ),
  terminal_phase TEXT NOT NULL
    CHECK (
      terminal_phase IN (
        'authorization',
        'claim',
        'scan',
        'assemble',
        'verify',
        'seal',
        'evidence'
      )
    ),
  source_scan_id_sha256 TEXT NOT NULL,
  source_seal_id_sha256 TEXT,
  source_seal_digest_sha256 TEXT,
  failure_class TEXT,
  ambiguity_class TEXT,
  evidence_manifest_sha256 TEXT,
  evidence_object_key TEXT,
  evidence_object_version_sha256 TEXT,
  evidence_object_etag_sha256 TEXT,
  evidence_content_sha256 TEXT,
  evidence_bytes INTEGER,
  retention_policy_sha256 TEXT,
  terminal_actor_service_name TEXT NOT NULL
    CHECK (
      typeof(terminal_actor_service_name) = 'text'
      AND length(terminal_actor_service_name) BETWEEN 1 AND 128
      AND substr(terminal_actor_service_name, 1, 1) GLOB '[a-z0-9]'
      AND substr(terminal_actor_service_name, -1, 1) GLOB '[a-z0-9]'
      AND terminal_actor_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  terminal_actor_version_id TEXT NOT NULL
    CHECK (
      typeof(terminal_actor_version_id) = 'text'
      AND length(terminal_actor_version_id) BETWEEN 1 AND 128
      AND substr(terminal_actor_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND terminal_actor_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  terminal_actor_execution_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(terminal_actor_execution_id_sha256) = 'text'
      AND length(terminal_actor_execution_id_sha256) = 64
      AND terminal_actor_execution_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_credential_id_sha256 TEXT NOT NULL
    CHECK (
      typeof(terminal_credential_id_sha256) = 'text'
      AND length(terminal_credential_id_sha256) = 64
      AND terminal_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  reason_code TEXT NOT NULL
    CHECK (
      typeof(reason_code) = 'text'
      AND length(reason_code) BETWEEN 1 AND 64
      AND substr(reason_code, 1, 1) GLOB '[a-z0-9]'
      AND substr(reason_code, -1, 1) GLOB '[a-z0-9]'
      AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
    ),
  observation_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(observation_sha256) = 'text'
      AND length(observation_sha256) = 64
      AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_receipt_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(terminal_receipt_sha256) = 'text'
      AND length(terminal_receipt_sha256) = 64
      AND terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  terminal_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(terminal_at) = 'integer' AND terminal_at > 0),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorization_registrations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorization_claims(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(registration_receipt_sha256) = 64
    AND registration_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    AND length(source_scan_id_sha256) = 64
    AND source_scan_id_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (
      source_seal_id_sha256 IS NULL
      AND source_seal_digest_sha256 IS NULL
      AND terminal_outcome <> 'succeeded'
    )
    OR (
      source_seal_id_sha256 IS NOT NULL
      AND length(source_seal_id_sha256) = 64
      AND source_seal_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND source_seal_digest_sha256 IS NOT NULL
      AND length(source_seal_digest_sha256) = 64
      AND source_seal_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND source_seal_id_sha256 <> source_seal_digest_sha256
      AND terminal_outcome = 'succeeded'
    )
  ),
  CHECK (
    (
      terminal_outcome = 'failed'
      AND failure_class IS NOT NULL
      AND length(failure_class) BETWEEN 1 AND 64
      AND substr(failure_class, 1, 1) GLOB '[a-z0-9]'
      AND substr(failure_class, -1, 1) GLOB '[a-z0-9]'
      AND failure_class NOT GLOB '*[^a-z0-9._:-]*'
      AND ambiguity_class IS NULL
    )
    OR (
      terminal_outcome = 'ambiguous'
      AND failure_class IS NULL
      AND ambiguity_class IS NOT NULL
      AND length(ambiguity_class) BETWEEN 1 AND 64
      AND substr(ambiguity_class, 1, 1) GLOB '[a-z0-9]'
      AND substr(ambiguity_class, -1, 1) GLOB '[a-z0-9]'
      AND ambiguity_class NOT GLOB '*[^a-z0-9._:-]*'
    )
    OR (
      terminal_outcome IN ('succeeded', 'expired')
      AND failure_class IS NULL
      AND ambiguity_class IS NULL
    )
  ),
  CHECK (
    (
      terminal_outcome = 'succeeded'
      AND terminal_phase = 'evidence'
      AND evidence_manifest_sha256 IS NOT NULL
      AND length(evidence_manifest_sha256) = 64
       AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
       AND evidence_object_key IS NOT NULL
       AND typeof(evidence_object_key) = 'text'
       AND length(evidence_object_key) BETWEEN 1 AND 512
       AND substr(evidence_object_key, 1, 1) <> '/'
       AND instr(CAST(evidence_object_key AS BLOB), X'00') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'01') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'02') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'03') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'04') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'05') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'06') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'07') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'08') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'09') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0A') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0B') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0C') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0D') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0E') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'0F') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'10') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'11') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'12') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'13') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'14') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'15') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'16') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'17') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'18') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'19') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1A') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1B') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1C') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1D') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1E') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'1F') = 0
       AND instr(CAST(evidence_object_key AS BLOB), X'7F') = 0
       AND evidence_object_version_sha256 IS NOT NULL
      AND length(evidence_object_version_sha256) = 64
      AND evidence_object_version_sha256 NOT GLOB '*[^0-9a-f]*'
      AND evidence_object_etag_sha256 IS NOT NULL
      AND length(evidence_object_etag_sha256) = 64
      AND evidence_object_etag_sha256 NOT GLOB '*[^0-9a-f]*'
      AND evidence_content_sha256 IS NOT NULL
      AND length(evidence_content_sha256) = 64
      AND evidence_content_sha256 NOT GLOB '*[^0-9a-f]*'
      AND typeof(evidence_bytes) = 'integer'
      AND evidence_bytes > 0
      AND retention_policy_sha256 IS NOT NULL
      AND length(retention_policy_sha256) = 64
      AND retention_policy_sha256 NOT GLOB '*[^0-9a-f]*'
    )
    OR (
      terminal_outcome <> 'succeeded'
      AND evidence_manifest_sha256 IS NULL
      AND evidence_object_key IS NULL
      AND evidence_object_version_sha256 IS NULL
      AND evidence_object_etag_sha256 IS NULL
      AND evidence_content_sha256 IS NULL
      AND evidence_bytes IS NULL
      AND retention_policy_sha256 IS NULL
    )
  ),
  CHECK (
    terminal_actor_execution_id_sha256 <>
      terminal_credential_id_sha256
    AND observation_sha256 <> terminal_receipt_sha256
    AND claim_digest_sha256 = predecessor_receipt_sha256
    AND terminal_receipt_sha256 <> predecessor_receipt_sha256
  )
);

CREATE TABLE relay_container_drain_source_receipt_ledger (
  authority_ledger_identity_sha256 TEXT NOT NULL
    CHECK (
      typeof(authority_ledger_identity_sha256) = 'text'
      AND length(authority_ledger_identity_sha256) = 64
      AND authority_ledger_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(receipt_sequence) = 'integer'
      AND receipt_sequence BETWEEN 1 AND 1000000
    ),
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('registration', 'claim', 'terminal')),
  authorization_id_sha256 TEXT NOT NULL,
  predecessor_receipt_sha256 TEXT NOT NULL
    CHECK (
      typeof(predecessor_receipt_sha256) = 'text'
      AND length(predecessor_receipt_sha256) = 64
      AND predecessor_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(receipt_digest_sha256) = 'text'
      AND length(receipt_digest_sha256) = 64
      AND receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND receipt_digest_sha256 <> predecessor_receipt_sha256
    ),
  recorded_at INTEGER NOT NULL
    CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
  PRIMARY KEY (
    authority_ledger_identity_sha256,
    receipt_sequence
  ),
  UNIQUE (
    authority_ledger_identity_sha256,
    predecessor_receipt_sha256
  ),
  UNIQUE (authorization_id_sha256, event_kind),
  FOREIGN KEY (authorization_id_sha256)
    REFERENCES relay_container_drain_source_authorizations(
      authorization_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_drain_source_registration_audit
  ON relay_container_drain_source_authorization_registrations(
    environment,
    registered_at,
    root_admin_id,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_registration_expiry
  ON relay_container_drain_source_authorization_registrations(
    verification_expires_at,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_claim_lease
  ON relay_container_drain_source_authorization_claims(
    lease_expires_at,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_claim_owner
  ON relay_container_drain_source_authorization_claims(
    claim_owner_service_name,
    claim_owner_version_id,
    claim_owner_execution_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_terminal_outcome
  ON relay_container_drain_source_terminal_receipts(
    terminal_outcome,
    terminal_at,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_terminal_evidence
  ON relay_container_drain_source_terminal_receipts(
    evidence_content_sha256,
    terminal_receipt_sha256
  );

CREATE INDEX idx_relay_container_drain_source_receipt_ledger_authorization
  ON relay_container_drain_source_receipt_ledger(
    authorization_id_sha256,
    event_kind,
    receipt_sequence
  );

CREATE INDEX idx_relay_container_drain_source_receipt_ledger_audit
  ON relay_container_drain_source_receipt_ledger(
    recorded_at,
    authority_ledger_identity_sha256,
    receipt_sequence
  );

CREATE TRIGGER relay_container_drain_source_registration_insert_guard
BEFORE INSERT
ON relay_container_drain_source_authorization_registrations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorization_registrations AS receipt
    WHERE receipt.authorization_id_sha256 = NEW.authorization_id_sha256
       OR receipt.source_scan_id_sha256 = NEW.source_scan_id_sha256
       OR receipt.passkey_assertion_subject_sha256 =
            NEW.passkey_assertion_subject_sha256
       OR receipt.passkey_assertion_signature_sha256 =
            NEW.passkey_assertion_signature_sha256
       OR receipt.secure_verification_challenge_sha256 =
            NEW.secure_verification_challenge_sha256
       OR receipt.secure_verification_receipt_sha256 =
            NEW.secure_verification_receipt_sha256
       OR receipt.action_digest_sha256 = NEW.action_digest_sha256
       OR receipt.admin_audit_digest_sha256 =
            NEW.admin_audit_digest_sha256
       OR receipt.registration_execution_id_sha256 =
            NEW.registration_execution_id_sha256
       OR receipt.registration_request_sha256 =
            NEW.registration_request_sha256
       OR receipt.registration_receipt_sha256 =
            NEW.registration_receipt_sha256
  ) THEN RAISE(
    ABORT,
    'drain source registration identity already exists'
  ) END;

  SELECT CASE WHEN NEW.registered_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source registration time must come from D1'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql',
      '0072_relay_container_drain_source_authorization.sql',
      '0073_relay_container_drain_source_authorization_consumption.sql'
    )
  ) <> 7
  THEN RAISE(
    ABORT,
    'drain source registration requires the complete 0067 through 0073 chain'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.environment = NEW.environment
      AND authorization.scope_kind = NEW.scope_kind
      AND authorization.scope_id_sha256 = NEW.scope_id_sha256
      AND authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND authorization.authorized_by_admin_id = NEW.root_admin_id
      AND authorization.recorded_at >= NEW.verified_at
      AND authorization.recorded_at <= NEW.registered_at
      AND NEW.registered_at - authorization.recorded_at BETWEEN 0 AND 5
      AND NEW.verification_expires_at <= authorization.permit_expires_at
      AND NEW.registered_at < authorization.permit_expires_at
  ) THEN RAISE(
    ABORT,
    'drain source registration is detached from its authorization'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_receipt_ledger AS ledger
        WHERE ledger.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
      )
      AND NEW.receipt_sequence = 1
      AND NEW.ledger_head_before_sha256 = (
        SELECT authorization.expected_head_digest_sha256
        FROM relay_container_drain_source_authorizations AS authorization
        WHERE authorization.authorization_id_sha256 =
                NEW.authorization_id_sha256
      )
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_receipt_ledger AS head
      WHERE head.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND head.receipt_sequence = NEW.receipt_sequence - 1
        AND head.receipt_digest_sha256 = NEW.ledger_head_before_sha256
        AND head.event_kind = 'terminal'
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_drain_source_receipt_ledger AS later
          WHERE later.authority_ledger_identity_sha256 =
                  NEW.authority_ledger_identity_sha256
            AND later.receipt_sequence >= NEW.receipt_sequence
        )
    )
  ) THEN RAISE(
    ABORT,
    'drain source registration must consume the current terminal ledger head'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM users AS root_user
    JOIN passkey_credentials AS passkey
      ON passkey.id = NEW.passkey_credential_row_id
     AND passkey.user_id = root_user.id
     AND passkey.deleted_at IS NULL
     AND passkey.clone_warning = 0
     AND passkey.user_present = 1
     AND passkey.user_verified = 1
     AND passkey.last_used_at = NEW.verified_at
     AND passkey.updated_at = NEW.verified_at
    WHERE root_user.id = NEW.root_admin_id
      AND root_user.role >= 100
      AND root_user.status = 1
      AND root_user.deleted_at IS NULL
      AND root_user.session_epoch = NEW.root_session_epoch
  ) THEN RAISE(
    ABORT,
    'drain source registration requires a live Root passkey assertion'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM logs AS audit
    JOIN users AS root_user
      ON root_user.id = NEW.root_admin_id
    WHERE audit.user_id = NEW.root_admin_id
      AND audit.created_at = NEW.registered_at
      AND audit.type = 3
      AND audit.username = root_user.username
      AND audit.request_id = NEW.admin_audit_digest_sha256
      AND json_valid(audit.other)
      AND json_extract(audit.other, '$.op.action') =
            'relay_container.drain_source_authorization_register'
      AND json_extract(
            audit.other,
            '$.op.params.authorization_id_sha256'
          ) = NEW.authorization_id_sha256
      AND json_extract(
            audit.other,
            '$.op.params.action_digest_sha256'
          ) = NEW.action_digest_sha256
      AND json_extract(audit.other, '$.admin_info.admin_id') =
            NEW.root_admin_id
      AND json_extract(audit.other, '$.admin_info.admin_role') >= 100
      AND json_extract(audit.other, '$.admin_info.auth_method') = 'passkey'
  ) THEN RAISE(
    ABORT,
    'drain source registration requires an exact Root audit row'
  ) END;

  SELECT CASE WHEN
    NEW.registered_at - NEW.verified_at NOT BETWEEN 0 AND 30
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorization_claims AS claim
      WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_terminal_receipts AS terminal
      WHERE terminal.authorization_id_sha256 = NEW.authorization_id_sha256
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_scans AS scan
      WHERE scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
    )
  THEN RAISE(
    ABORT,
    'drain source registration is stale, claimed, terminal, or replayed'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_registration_project
AFTER INSERT
ON relay_container_drain_source_authorization_registrations
FOR EACH ROW
BEGIN
  INSERT INTO relay_container_drain_source_receipt_ledger (
    authority_ledger_identity_sha256,
    receipt_sequence,
    event_kind,
    authorization_id_sha256,
    predecessor_receipt_sha256,
    receipt_digest_sha256,
    recorded_at
  ) VALUES (
    NEW.authority_ledger_identity_sha256,
    NEW.receipt_sequence,
    'registration',
    NEW.authorization_id_sha256,
    NEW.ledger_head_before_sha256,
    NEW.registration_receipt_sha256,
    NEW.registered_at
  );
END;

CREATE TRIGGER relay_container_drain_source_registration_update_guard
BEFORE UPDATE
ON relay_container_drain_source_authorization_registrations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source registrations are immutable');
END;

CREATE TRIGGER relay_container_drain_source_registration_delete_guard
BEFORE DELETE
ON relay_container_drain_source_authorization_registrations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source registrations are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_claim_insert_guard
BEFORE INSERT ON relay_container_drain_source_authorization_claims
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorization_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
       OR claim.claim_id_sha256 = NEW.claim_id_sha256
       OR claim.claim_request_sha256 = NEW.claim_request_sha256
       OR claim.claim_digest_sha256 = NEW.claim_digest_sha256
       OR claim.claim_owner_execution_id_sha256 =
            NEW.claim_owner_execution_id_sha256
  ) THEN RAISE(
    ABORT,
    'drain source authorization claim identity already exists'
  ) END;

  SELECT CASE WHEN NEW.claimed_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source authorization claim time must come from D1'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql',
      '0072_relay_container_drain_source_authorization.sql',
      '0073_relay_container_drain_source_authorization_consumption.sql'
    )
  ) <> 7
  THEN RAISE(
    ABORT,
    'drain source claim requires the complete 0067 through 0073 chain'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_registrations AS receipt
      ON receipt.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.execution_nonce_sha256 =
            NEW.execution_nonce_sha256
      AND receipt.registration_receipt_sha256 =
            NEW.registration_receipt_sha256
      AND receipt.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND NEW.receipt_sequence = receipt.receipt_sequence + 1
      AND NEW.predecessor_receipt_sha256 =
            receipt.registration_receipt_sha256
      AND authorization.collector_service_name =
            NEW.claim_owner_service_name
      AND authorization.collector_version_id =
            NEW.claim_owner_version_id
      AND authorization.collector_run_id_sha256 =
            NEW.claim_owner_execution_id_sha256
      AND authorization.started_by_credential_id_sha256 =
            NEW.claim_credential_id_sha256
      AND receipt.registration_credential_id_sha256 <>
            NEW.claim_credential_id_sha256
      AND receipt.registered_at <= NEW.claimed_at
      AND NEW.claimed_at < receipt.verification_expires_at
      AND NEW.claimed_at < authorization.permit_expires_at
      AND NEW.lease_expires_at <= authorization.permit_expires_at
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_receipt_ledger AS head
        WHERE head.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
          AND head.receipt_sequence = receipt.receipt_sequence
          AND head.event_kind = 'registration'
          AND head.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND head.receipt_digest_sha256 =
                receipt.registration_receipt_sha256
          AND NOT EXISTS (
            SELECT 1
            FROM relay_container_drain_source_receipt_ledger AS later
            WHERE later.authority_ledger_identity_sha256 =
                    NEW.authority_ledger_identity_sha256
              AND later.receipt_sequence > head.receipt_sequence
          )
      )
  ) THEN RAISE(
    ABORT,
    'drain source authorization claim is detached, stale, or misowned'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM relay_container_drain_source_terminal_receipts AS terminal
      WHERE terminal.authorization_id_sha256 = NEW.authorization_id_sha256
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_scans AS scan
      JOIN relay_container_drain_source_authorizations AS authorization
        ON authorization.source_scan_id_sha256 =
             scan.source_scan_id_sha256
      WHERE authorization.authorization_id_sha256 =
              NEW.authorization_id_sha256
    )
  THEN RAISE(
    ABORT,
    'drain source authorization claim is terminal or already consumed'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_claim_project
AFTER INSERT ON relay_container_drain_source_authorization_claims
FOR EACH ROW
BEGIN
  INSERT INTO relay_container_drain_source_receipt_ledger (
    authority_ledger_identity_sha256,
    receipt_sequence,
    event_kind,
    authorization_id_sha256,
    predecessor_receipt_sha256,
    receipt_digest_sha256,
    recorded_at
  ) VALUES (
    NEW.authority_ledger_identity_sha256,
    NEW.receipt_sequence,
    'claim',
    NEW.authorization_id_sha256,
    NEW.predecessor_receipt_sha256,
    NEW.claim_digest_sha256,
    NEW.claimed_at
  );
END;

CREATE TRIGGER relay_container_drain_source_claim_update_guard
BEFORE UPDATE ON relay_container_drain_source_authorization_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source authorization claims are immutable');
END;

CREATE TRIGGER relay_container_drain_source_claim_delete_guard
BEFORE DELETE ON relay_container_drain_source_authorization_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'drain source authorization claims are append-preserved'
  );
END;

CREATE TRIGGER relay_container_drain_source_terminal_insert_guard
BEFORE INSERT ON relay_container_drain_source_terminal_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_terminal_receipts AS terminal
    WHERE terminal.authorization_id_sha256 = NEW.authorization_id_sha256
       OR terminal.terminal_actor_execution_id_sha256 =
            NEW.terminal_actor_execution_id_sha256
       OR terminal.observation_sha256 = NEW.observation_sha256
       OR terminal.terminal_receipt_sha256 =
            NEW.terminal_receipt_sha256
  ) THEN RAISE(
    ABORT,
    'drain source terminal receipt identity already exists'
  ) END;

  SELECT CASE WHEN NEW.terminal_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source terminal receipt time must come from D1'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM d1_migrations
    WHERE name IN (
      '0067_relay_container_drain_expand.sql',
      '0068_relay_container_drain_admission_enforce.sql',
      '0069_relay_container_traffic_return_evidence_enforce.sql',
      '0070_relay_container_drain_close_command.sql',
      '0071_relay_container_drain_accepted_set_source_seal.sql',
      '0072_relay_container_drain_source_authorization.sql',
      '0073_relay_container_drain_source_authorization_consumption.sql'
    )
  ) <> 7
  THEN RAISE(
    ABORT,
    'drain source terminal requires the complete 0067 through 0073 chain'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_registrations AS receipt
      ON receipt.authorization_id_sha256 =
           authorization.authorization_id_sha256
    JOIN relay_container_drain_source_authorization_claims AS claim
      ON claim.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND receipt.registration_receipt_sha256 =
            NEW.registration_receipt_sha256
      AND claim.claim_id_sha256 = NEW.claim_id_sha256
      AND claim.claim_digest_sha256 = NEW.claim_digest_sha256
      AND claim.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND receipt.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND NEW.receipt_sequence = claim.receipt_sequence + 1
      AND NEW.predecessor_receipt_sha256 =
            claim.claim_digest_sha256
      AND receipt.registration_credential_id_sha256 <>
            NEW.terminal_credential_id_sha256
      AND claim.claim_credential_id_sha256 <>
            NEW.terminal_credential_id_sha256
      AND claim.claimed_at <= NEW.terminal_at
      AND (
        (
          NEW.terminal_outcome IN ('succeeded', 'failed')
          AND NEW.terminal_at <= claim.lease_expires_at
        )
        OR (
          NEW.terminal_outcome = 'expired'
          AND NEW.terminal_at >= claim.lease_expires_at
        )
        OR (
          NEW.terminal_outcome = 'ambiguous'
          AND NEW.terminal_at <= claim.lease_expires_at + 300
        )
      )
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_receipt_ledger AS head
        WHERE head.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
          AND head.receipt_sequence = claim.receipt_sequence
          AND head.event_kind = 'claim'
          AND head.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND head.receipt_digest_sha256 =
                claim.claim_digest_sha256
          AND NOT EXISTS (
            SELECT 1
            FROM relay_container_drain_source_receipt_ledger AS later
            WHERE later.authority_ledger_identity_sha256 =
                    NEW.authority_ledger_identity_sha256
              AND later.receipt_sequence > head.receipt_sequence
          )
      )
  ) THEN RAISE(
    ABORT,
    'drain source terminal receipt is detached from the current claim head'
  ) END;

  SELECT CASE WHEN
    NEW.terminal_outcome = 'succeeded'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorizations AS authorization
      JOIN relay_container_drain_source_scans AS scan
        ON scan.source_scan_id_sha256 =
             authorization.source_scan_id_sha256
      WHERE authorization.authorization_id_sha256 =
              NEW.authorization_id_sha256
        AND scan.source_scan_id_sha256 = NEW.source_scan_id_sha256
        AND scan.started_at <= NEW.terminal_at
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_drain_source_seals AS seal
          WHERE seal.source_scan_id_sha256 =
                  scan.source_scan_id_sha256
             OR seal.source_seal_id_sha256 =
                  NEW.source_seal_id_sha256
             OR seal.seal_digest_sha256 =
                  NEW.source_seal_digest_sha256
        )
        AND (
          SELECT COUNT(*)
          FROM relay_container_drain_source_attestations AS attestation
          WHERE attestation.authorization_id_sha256 =
                  authorization.authorization_id_sha256
            AND attestation.source_scan_id_sha256 =
                  scan.source_scan_id_sha256
            AND attestation.source_seal_id_sha256 =
                  NEW.source_seal_id_sha256
            AND attestation.attestation_role IN ('assembler', 'verifier')
            AND attestation.recorded_at <= NEW.terminal_at
            AND NEW.terminal_at < attestation.valid_until
        ) = 2
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_drain_source_attestations AS assembler
          JOIN relay_container_drain_source_attestations AS verifier
            ON verifier.authorization_id_sha256 =
                 assembler.authorization_id_sha256
           AND verifier.attestation_role = 'verifier'
          WHERE assembler.authorization_id_sha256 =
                  authorization.authorization_id_sha256
            AND assembler.attestation_role = 'assembler'
            AND (
              assembler.accepted_bookmark_sha256 <>
                verifier.accepted_bookmark_sha256
              OR assembler.accepted_set_manifest_sha256 <>
                verifier.accepted_set_manifest_sha256
              OR assembler.accepted_source_schema_sha256 <>
                verifier.accepted_source_schema_sha256
              OR assembler.accepted_source_readback_sha256 <>
                verifier.accepted_source_readback_sha256
              OR assembler.page_count <> verifier.page_count
              OR assembler.first_page_digest_sha256 IS NOT
                verifier.first_page_digest_sha256
              OR assembler.last_page_digest_sha256 IS NOT
                verifier.last_page_digest_sha256
              OR assembler.shard_set_manifest_sha256 <>
                verifier.shard_set_manifest_sha256
            )
        )
    )
  THEN RAISE(
    ABORT,
    'successful drain source receipt requires exact unsealed attestations'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_terminal_project
AFTER INSERT ON relay_container_drain_source_terminal_receipts
FOR EACH ROW
BEGIN
  INSERT INTO relay_container_drain_source_seals (
    source_seal_id_sha256,
    source_scan_id_sha256,
    contract_version,
    seal_contract,
    seal_migration,
    bookmark_contract,
    pagination_contract,
    accepted_bookmark_sha256,
    accepted_set_manifest_sha256,
    accepted_source_schema_sha256,
    accepted_source_readback_sha256,
    page_count,
    first_page_digest_sha256,
    last_page_digest_sha256,
    shard_set_manifest_sha256,
    assembler_identity_sha256,
    assembler_signature_envelope_sha256,
    verifier_identity_sha256,
    verifier_signature_envelope_sha256,
    seal_digest_sha256,
    sealed_at
  )
  SELECT
    NEW.source_seal_id_sha256,
    NEW.source_scan_id_sha256,
    1,
    'relay-container-drain-source-seal-v1',
    '0071_relay_container_drain_accepted_set_source_seal.sql',
    'd1-session-first-primary-bookmark-v1',
    'accepted-sequence-keyset-v1',
    assembler.accepted_bookmark_sha256,
    assembler.accepted_set_manifest_sha256,
    assembler.accepted_source_schema_sha256,
    assembler.accepted_source_readback_sha256,
    assembler.page_count,
    assembler.first_page_digest_sha256,
    assembler.last_page_digest_sha256,
    assembler.shard_set_manifest_sha256,
    assembler.identity_sha256,
    assembler.signature_envelope_sha256,
    verifier.identity_sha256,
    verifier.signature_envelope_sha256,
    NEW.source_seal_digest_sha256,
    NEW.terminal_at
  FROM relay_container_drain_source_attestations AS assembler
  JOIN relay_container_drain_source_attestations AS verifier
    ON verifier.authorization_id_sha256 =
         assembler.authorization_id_sha256
   AND verifier.attestation_role = 'verifier'
  WHERE NEW.terminal_outcome = 'succeeded'
    AND assembler.authorization_id_sha256 =
          NEW.authorization_id_sha256
    AND assembler.attestation_role = 'assembler';

  SELECT CASE WHEN
    NEW.terminal_outcome = 'succeeded'
    AND NOT EXISTS (
      SELECT 1
      FROM relay_container_drain_source_seals AS seal
      WHERE seal.source_scan_id_sha256 = NEW.source_scan_id_sha256
        AND seal.source_seal_id_sha256 = NEW.source_seal_id_sha256
        AND seal.seal_digest_sha256 = NEW.source_seal_digest_sha256
        AND seal.sealed_at = NEW.terminal_at
    )
  THEN RAISE(
    ABORT,
    'successful drain source terminal failed atomic seal projection'
  ) END;

  INSERT INTO relay_container_drain_source_receipt_ledger (
    authority_ledger_identity_sha256,
    receipt_sequence,
    event_kind,
    authorization_id_sha256,
    predecessor_receipt_sha256,
    receipt_digest_sha256,
    recorded_at
  ) VALUES (
    NEW.authority_ledger_identity_sha256,
    NEW.receipt_sequence,
    'terminal',
    NEW.authorization_id_sha256,
    NEW.predecessor_receipt_sha256,
    NEW.terminal_receipt_sha256,
    NEW.terminal_at
  );
END;

CREATE TRIGGER relay_container_drain_source_terminal_update_guard
BEFORE UPDATE ON relay_container_drain_source_terminal_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source terminal receipts are immutable');
END;

CREATE TRIGGER relay_container_drain_source_terminal_delete_guard
BEFORE DELETE ON relay_container_drain_source_terminal_receipts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source terminal receipts are append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_receipt_ledger_insert_guard
BEFORE INSERT ON relay_container_drain_source_receipt_ledger
FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_drain_source_receipt_ledger AS ledger
    WHERE (
      ledger.authority_ledger_identity_sha256 =
        NEW.authority_ledger_identity_sha256
      AND (
        ledger.receipt_sequence = NEW.receipt_sequence
        OR ledger.predecessor_receipt_sha256 =
             NEW.predecessor_receipt_sha256
      )
    )
       OR ledger.receipt_digest_sha256 = NEW.receipt_digest_sha256
       OR (
         ledger.authorization_id_sha256 = NEW.authorization_id_sha256
         AND ledger.event_kind = NEW.event_kind
       )
  ) THEN RAISE(
    ABORT,
    'drain source receipt ledger identity already exists'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.receipt_sequence = 1
      AND NEW.event_kind = 'registration'
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_receipt_ledger AS earlier
        WHERE earlier.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
      )
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_receipt_ledger AS predecessor
      WHERE predecessor.authority_ledger_identity_sha256 =
              NEW.authority_ledger_identity_sha256
        AND predecessor.receipt_sequence = NEW.receipt_sequence - 1
        AND predecessor.receipt_digest_sha256 =
              NEW.predecessor_receipt_sha256
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_drain_source_receipt_ledger AS later
          WHERE later.authority_ledger_identity_sha256 =
                  NEW.authority_ledger_identity_sha256
            AND later.receipt_sequence >= NEW.receipt_sequence
        )
    )
  ) THEN RAISE(
    ABORT,
    'drain source receipt ledger predecessor is not the current head'
  ) END;

  SELECT CASE WHEN NOT (
    (
      NEW.event_kind = 'registration'
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_authorization_registrations
             AS registration
        WHERE registration.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND registration.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
          AND registration.receipt_sequence = NEW.receipt_sequence
          AND registration.ledger_head_before_sha256 =
                NEW.predecessor_receipt_sha256
          AND registration.registration_receipt_sha256 =
                NEW.receipt_digest_sha256
          AND registration.registered_at = NEW.recorded_at
      )
    )
    OR (
      NEW.event_kind = 'claim'
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_authorization_claims AS claim
        WHERE claim.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND claim.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
          AND claim.receipt_sequence = NEW.receipt_sequence
          AND claim.predecessor_receipt_sha256 =
                NEW.predecessor_receipt_sha256
          AND claim.claim_digest_sha256 = NEW.receipt_digest_sha256
          AND claim.claimed_at = NEW.recorded_at
      )
    )
    OR (
      NEW.event_kind = 'terminal'
      AND EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                NEW.authorization_id_sha256
          AND terminal.authority_ledger_identity_sha256 =
                NEW.authority_ledger_identity_sha256
          AND terminal.receipt_sequence = NEW.receipt_sequence
          AND terminal.predecessor_receipt_sha256 =
                NEW.predecessor_receipt_sha256
          AND terminal.terminal_receipt_sha256 =
                NEW.receipt_digest_sha256
          AND terminal.terminal_at = NEW.recorded_at
      )
    )
  ) THEN RAISE(
    ABORT,
    'drain source receipt ledger accepts only exact receipt projections'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_receipt_ledger_update_guard
BEFORE UPDATE ON relay_container_drain_source_receipt_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source receipt ledger is immutable');
END;

CREATE TRIGGER relay_container_drain_source_receipt_ledger_delete_guard
BEFORE DELETE ON relay_container_drain_source_receipt_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source receipt ledger is append-preserved');
END;

CREATE TRIGGER relay_container_drain_source_scan_claim_guard
BEFORE INSERT ON relay_container_drain_source_scans
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_registrations AS receipt
      ON receipt.authorization_id_sha256 =
           authorization.authorization_id_sha256
    JOIN relay_container_drain_source_authorization_claims AS claim
      ON claim.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND claim.claim_owner_service_name = NEW.collector_service_name
      AND claim.claim_owner_version_id = NEW.collector_version_id
      AND claim.claim_owner_execution_id_sha256 =
            NEW.collector_run_id_sha256
      AND claim.claim_credential_id_sha256 =
            NEW.started_by_credential_id_sha256
      AND claim.claimed_at <= NEW.started_at
      AND NEW.started_at < claim.lease_expires_at
      AND unixepoch() < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                authorization.authorization_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source scan requires the exact live authorization claim'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_member_claim_guard
BEFORE INSERT ON relay_container_drain_source_members
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_claims AS claim
      ON claim.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND unixepoch() < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                authorization.authorization_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source member requires a live nonterminal claim'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_page_claim_guard
BEFORE INSERT ON relay_container_drain_source_pages
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_claims AS claim
      ON claim.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND unixepoch() < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                authorization.authorization_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source page requires a live nonterminal claim'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_shard_claim_guard
BEFORE INSERT ON relay_container_drain_source_shards
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_authorization_claims AS claim
      ON claim.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND unixepoch() < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                authorization.authorization_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source shard requires a live nonterminal claim'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_attestation_claim_guard
BEFORE INSERT ON relay_container_drain_source_attestations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorization_claims AS claim
    WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
      AND unixepoch() < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_drain_source_terminal_receipts AS terminal
        WHERE terminal.authorization_id_sha256 =
                NEW.authorization_id_sha256
      )
  ) THEN RAISE(
    ABORT,
    'drain source attestation requires a live nonterminal claim'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_seal_terminal_projection_guard
BEFORE INSERT ON relay_container_drain_source_seals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_drain_source_terminal_receipts AS terminal
      ON terminal.authorization_id_sha256 =
           authorization.authorization_id_sha256
    WHERE authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND terminal.terminal_outcome = 'succeeded'
      AND terminal.terminal_phase = 'evidence'
      AND terminal.source_scan_id_sha256 = NEW.source_scan_id_sha256
      AND terminal.source_seal_id_sha256 = NEW.source_seal_id_sha256
      AND terminal.source_seal_digest_sha256 = NEW.seal_digest_sha256
      AND terminal.terminal_at = NEW.sealed_at
  ) THEN RAISE(
    ABORT,
    'drain source seal is only an atomic successful terminal projection'
  ) END;
END;

CREATE TRIGGER relay_container_drain_close_command_terminal_receipt_guard
BEFORE INSERT ON relay_container_drain_close_commands
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_terminal_receipts AS terminal
    JOIN relay_container_drain_source_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           terminal.authorization_id_sha256
    JOIN relay_container_drain_source_authorization_registrations AS receipt
      ON receipt.authorization_id_sha256 =
           authorization.authorization_id_sha256
    JOIN relay_container_drain_source_scans AS scan
      ON scan.source_scan_id_sha256 =
           authorization.source_scan_id_sha256
    JOIN relay_container_drain_source_seals AS seal
      ON seal.source_scan_id_sha256 = scan.source_scan_id_sha256
     AND seal.source_seal_id_sha256 = terminal.source_seal_id_sha256
    WHERE terminal.terminal_outcome = 'succeeded'
      AND terminal.terminal_phase = 'evidence'
      AND terminal.terminal_at <= NEW.created_at
      AND receipt.root_admin_id = NEW.requested_by_admin_id
      AND scan.environment = NEW.environment
      AND scan.scope_kind = NEW.scope_kind
      AND scan.scope_id_sha256 = NEW.scope_id_sha256
      AND scan.admission_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND scan.fence_generation = NEW.fence_generation
      AND scan.expected_fence_state_digest_sha256 =
            NEW.expected_fence_state_digest_sha256
      AND scan.expected_head_version = NEW.expected_head_version
      AND scan.expected_head_digest_sha256 =
            NEW.expected_head_digest_sha256
      AND scan.captured_high_watermark = NEW.accepted_high_watermark
      AND scan.captured_member_count = NEW.accepted_member_count
      AND scan.captured_first_sequence = NEW.accepted_first_sequence
      AND scan.captured_first_operation_id IS
            NEW.accepted_first_operation_id
      AND scan.captured_last_sequence = NEW.accepted_last_sequence
      AND scan.captured_last_operation_id IS
            NEW.accepted_last_operation_id
      AND scan.shard_count = NEW.shard_count
      AND seal.accepted_bookmark_sha256 =
            NEW.accepted_bookmark_sha256
      AND seal.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND seal.accepted_source_schema_sha256 =
            NEW.accepted_source_schema_sha256
      AND seal.accepted_source_readback_sha256 =
            NEW.accepted_source_readback_sha256
  ) THEN RAISE(
    ABORT,
    'drain close command requires a retained successful terminal receipt'
  ) END;
END;
