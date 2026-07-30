-- Make the effective registration command schema treat the Root session
-- epoch as a revocation generation, never as a timestamp.
--
-- Migration 0074 remains immutable. Because the command writer is still
-- default-inert, this migration fails closed unless the command and every
-- command-derived projection are empty, then rebuilds only that empty table
-- and its direct trigger closure.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE relay_container_drain_source_registration_command_exact_session_generation_preflight (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1)
);

CREATE TRIGGER relay_container_drain_source_registration_command_exact_session_generation_preflight_guard
BEFORE INSERT
ON relay_container_drain_source_registration_command_exact_session_generation_preflight
FOR EACH ROW
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'relay_container_drain_source_registration_commands'
        AND instr(
          sql,
          'root_session_issued_at >= root_session_epoch'
        ) > 0
    )
    OR NOT EXISTS (
      SELECT 1
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name =
          'relay_container_drain_source_registration_command_insert_guard'
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
        AND instr(
          sql,
          'NEW.root_session_issued_at >= root_user.session_epoch'
        ) > 0
    )
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
        AND sql IS NOT NULL
    ) <> 2
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_relay_container_drain_source_registration_command_audit',
          'idx_relay_container_drain_source_registration_command_expiry'
        )
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
    ) <> 2
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
        AND sql IS NULL
    ) <> 16
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
    ) <> 5
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'relay_container_drain_source_registration_command_insert_guard',
          'relay_container_drain_source_registration_command_project',
          'relay_container_drain_source_registration_command_update_guard',
          'relay_container_drain_source_registration_command_delete_guard',
          'relay_container_drain_source_command_exact_root_guard'
        )
        AND tbl_name =
          'relay_container_drain_source_registration_commands'
    ) <> 5
    OR (
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND (
          (
            name =
              'relay_container_drain_source_protected_audit_insert_guard'
            AND tbl_name = 'logs'
          )
          OR (
            name =
              'relay_container_drain_source_registration_insert_guard'
            AND tbl_name =
              'relay_container_drain_source_authorization_registrations'
          )
          OR (
            name =
              'relay_container_drain_source_registration_exact_root_guard'
            AND tbl_name =
              'relay_container_drain_source_authorization_registrations'
          )
        )
    ) <> 3
  THEN RAISE(
    ABORT,
    '0076 requires exact 0074/0075 registration command schema'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM relay_container_drain_source_registration_commands
    )
    OR EXISTS (
      SELECT 1
      FROM logs
      WHERE drain_source_registration_command_id_sha256 IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorization_registrations
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorization_claims
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_terminal_receipts
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_receipt_ledger
    )
  THEN RAISE(
    ABORT,
    '0076 requires empty 0074 registration command state'
  ) END;
END;

INSERT INTO relay_container_drain_source_registration_command_exact_session_generation_preflight(
  singleton
) VALUES (1);

DROP TRIGGER relay_container_drain_source_registration_command_exact_session_generation_preflight_guard;
DROP TABLE relay_container_drain_source_registration_command_exact_session_generation_preflight;

DROP TRIGGER relay_container_drain_source_protected_audit_insert_guard;
DROP TRIGGER relay_container_drain_source_registration_insert_guard;

DROP TABLE relay_container_drain_source_registration_commands;

CREATE TABLE relay_container_drain_source_registration_commands (
  command_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(command_id_sha256) = 'text'
      AND length(command_id_sha256) = 64
      AND command_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  command_contract TEXT NOT NULL
    CHECK (
      command_contract =
        'relay-container-drain-source-registration-command-v1'
    ),
  command_migration TEXT NOT NULL
    CHECK (
      command_migration =
        '0074_relay_container_drain_source_registration_command.sql'
    ),
  action TEXT NOT NULL
    CHECK (
      action =
        'relay_container.drain_source_authorization_register'
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  authorization_id_sha256 TEXT NOT NULL UNIQUE,
  permit_id_sha256 TEXT NOT NULL UNIQUE,
  permit_subject_sha256 TEXT NOT NULL UNIQUE,
  permit_signature_envelope_sha256 TEXT NOT NULL UNIQUE,
  issuer_request_id_sha256 TEXT NOT NULL UNIQUE,
  issuer_version_id TEXT NOT NULL
    CHECK (
      typeof(issuer_version_id) = 'text'
      AND length(issuer_version_id) BETWEEN 1 AND 128
      AND substr(issuer_version_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND issuer_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  permit_issuer TEXT NOT NULL
    CHECK (
      typeof(permit_issuer) = 'text'
      AND length(permit_issuer) BETWEEN 1 AND 128
      AND permit_issuer NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  permit_key_id TEXT NOT NULL
    CHECK (
      typeof(permit_key_id) = 'text'
      AND length(permit_key_id) BETWEEN 1 AND 128
      AND permit_key_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  permit_signer_identity_sha256 TEXT NOT NULL,
  permit_signer_spki_sha256 TEXT NOT NULL,
  action_subject_sha256 TEXT NOT NULL UNIQUE,
  action_digest_sha256 TEXT NOT NULL UNIQUE,
  registration_request_sha256 TEXT NOT NULL UNIQUE,
  admin_audit_digest_sha256 TEXT NOT NULL UNIQUE,
  change_ticket_sha256 TEXT NOT NULL,
  reason_code TEXT NOT NULL
    CHECK (
      typeof(reason_code) = 'text'
      AND length(reason_code) BETWEEN 1 AND 64
      AND substr(reason_code, 1, 1) GLOB '[a-z0-9]'
      AND substr(reason_code, -1, 1) GLOB '[a-z0-9]'
      AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
    ),
  admin_network_identity_hmac_sha256 TEXT NOT NULL
    CHECK (
      typeof(admin_network_identity_hmac_sha256) = 'text'
      AND length(admin_network_identity_hmac_sha256) = 64
      AND admin_network_identity_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  root_admin_id INTEGER NOT NULL
    CHECK (typeof(root_admin_id) = 'integer' AND root_admin_id > 0),
  root_session_epoch INTEGER NOT NULL
    CHECK (
      typeof(root_session_epoch) = 'integer'
      AND root_session_epoch >= 0
    ),
  root_session_binding_sha256 TEXT NOT NULL,
  root_session_issued_at INTEGER NOT NULL
    CHECK (typeof(root_session_issued_at) = 'integer'),
  root_session_expires_at INTEGER NOT NULL
    CHECK (typeof(root_session_expires_at) = 'integer'),
  passkey_credential_row_id INTEGER NOT NULL
    CHECK (
      typeof(passkey_credential_row_id) = 'integer'
      AND passkey_credential_row_id > 0
    ),
  passkey_credential_registration_id_sha256 TEXT NOT NULL,
  passkey_credential_id_sha256 TEXT NOT NULL,
  passkey_credential_binding_sha256 TEXT NOT NULL,
  passkey_previous_use_generation INTEGER NOT NULL
    CHECK (
      typeof(passkey_previous_use_generation) = 'integer'
      AND passkey_previous_use_generation >= 0
      AND passkey_previous_use_generation <= 9007199254740990
    ),
  passkey_next_use_generation INTEGER NOT NULL
    CHECK (
      typeof(passkey_next_use_generation) = 'integer'
      AND passkey_next_use_generation > 0
      AND passkey_next_use_generation <= 9007199254740991
    ),
  passkey_assertion_subject_sha256 TEXT NOT NULL UNIQUE,
  passkey_assertion_signature_sha256 TEXT NOT NULL UNIQUE,
  secure_verification_challenge_sha256 TEXT NOT NULL UNIQUE,
  passkey_previous_sign_count INTEGER NOT NULL
    CHECK (
      typeof(passkey_previous_sign_count) = 'integer'
      AND passkey_previous_sign_count BETWEEN 0 AND 4294967295
    ),
  passkey_sign_count INTEGER NOT NULL
    CHECK (
      typeof(passkey_sign_count) = 'integer'
      AND passkey_sign_count BETWEEN 0 AND 4294967295
    ),
  passkey_user_present INTEGER NOT NULL
    CHECK (
      typeof(passkey_user_present) = 'integer'
      AND passkey_user_present = 1
    ),
  passkey_user_verified INTEGER NOT NULL
    CHECK (
      typeof(passkey_user_verified) = 'integer'
      AND passkey_user_verified = 1
    ),
  passkey_backup_eligible INTEGER NOT NULL
    CHECK (
      typeof(passkey_backup_eligible) = 'integer'
      AND passkey_backup_eligible IN (0, 1)
    ),
  passkey_backup_state INTEGER NOT NULL
    CHECK (
      typeof(passkey_backup_state) = 'integer'
      AND passkey_backup_state IN (0, 1)
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
  registration_execution_id_sha256 TEXT NOT NULL UNIQUE,
  registration_credential_id_sha256 TEXT NOT NULL,
  authority_ledger_identity_sha256 TEXT NOT NULL,
  receipt_sequence INTEGER NOT NULL
    CHECK (
      typeof(receipt_sequence) = 'integer'
      AND receipt_sequence BETWEEN 1 AND 1000000
    ),
  ledger_head_before_sha256 TEXT NOT NULL,
  verification_expires_at INTEGER NOT NULL
    CHECK (typeof(verification_expires_at) = 'integer'),
  verified_at INTEGER NOT NULL
    CHECK (typeof(verified_at) = 'integer' AND verified_at > 0),
  permit_issued_at INTEGER NOT NULL
    CHECK (typeof(permit_issued_at) = 'integer' AND permit_issued_at > 0),
  permit_expires_at INTEGER NOT NULL
    CHECK (typeof(permit_expires_at) = 'integer' AND permit_expires_at > 0),
  secure_verification_receipt_sha256 TEXT NOT NULL UNIQUE,
  registration_receipt_sha256 TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
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
    passkey_next_use_generation = passkey_previous_use_generation + 1
    AND (
      (
        passkey_previous_sign_count = 0
        AND passkey_sign_count = 0
      )
      OR passkey_sign_count > passkey_previous_sign_count
    )
    AND passkey_backup_state <= passkey_backup_eligible
    AND passkey_credential_registration_id_sha256
          <> passkey_credential_id_sha256
    AND passkey_credential_registration_id_sha256
          <> passkey_credential_binding_sha256
    AND passkey_credential_id_sha256
          <> passkey_credential_binding_sha256
    AND root_session_issued_at < root_session_expires_at
    AND verified_at >= root_session_issued_at
    AND verification_expires_at <= root_session_expires_at
    AND verified_at <= permit_issued_at
    AND permit_issued_at - verified_at BETWEEN 0 AND 5
    AND permit_issued_at <= created_at + 5
    AND permit_issued_at < permit_expires_at
    AND permit_expires_at <= verification_expires_at
    AND permit_expires_at - permit_issued_at BETWEEN 5 AND 30
    AND created_at >= verified_at
    AND created_at < permit_expires_at
    AND created_at - verified_at BETWEEN 0 AND 30
    AND authority_ledger_identity_sha256 =
          '53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251'
    AND registration_execution_id_sha256 <>
          registration_credential_id_sha256
  )
);

CREATE INDEX idx_relay_container_drain_source_registration_command_audit
  ON relay_container_drain_source_registration_commands(
    environment,
    created_at,
    root_admin_id,
    authorization_id_sha256
  );

CREATE INDEX idx_relay_container_drain_source_registration_command_expiry
  ON relay_container_drain_source_registration_commands(
    permit_expires_at,
    verification_expires_at,
    command_id_sha256
  );

CREATE TRIGGER relay_container_drain_source_registration_command_insert_guard
BEFORE INSERT
ON relay_container_drain_source_registration_commands
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'drain source registration command time must come from D1'
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
      '0073_relay_container_drain_source_authorization_consumption.sql',
      '0074_relay_container_drain_source_registration_command.sql'
    )
  ) <> 8
  THEN RAISE(
    ABORT,
    'drain source registration command requires the complete 0067 through 0074 chain'
  ) END;

  SELECT CASE WHEN
    NOT (
      length(NEW.authorization_id_sha256) = 64
      AND NEW.authorization_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.permit_id_sha256) = 64
      AND NEW.permit_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.permit_subject_sha256) = 64
      AND NEW.permit_subject_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.permit_signature_envelope_sha256) = 64
      AND NEW.permit_signature_envelope_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.issuer_request_id_sha256) = 64
      AND NEW.issuer_request_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.permit_signer_identity_sha256) = 64
      AND NEW.permit_signer_identity_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.permit_signer_spki_sha256) = 64
      AND NEW.permit_signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.action_subject_sha256) = 64
      AND NEW.action_subject_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.action_digest_sha256) = 64
      AND NEW.action_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.registration_request_sha256) = 64
      AND NEW.registration_request_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.admin_audit_digest_sha256) = 64
      AND NEW.admin_audit_digest_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.admin_network_identity_hmac_sha256) = 64
      AND NEW.admin_network_identity_hmac_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.change_ticket_sha256) = 64
      AND NEW.change_ticket_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.root_session_binding_sha256) = 64
      AND NEW.root_session_binding_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.passkey_credential_registration_id_sha256) = 64
      AND NEW.passkey_credential_registration_id_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.passkey_credential_id_sha256) = 64
      AND NEW.passkey_credential_id_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.passkey_credential_binding_sha256) = 64
      AND NEW.passkey_credential_binding_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.passkey_assertion_subject_sha256) = 64
      AND NEW.passkey_assertion_subject_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.passkey_assertion_signature_sha256) = 64
      AND NEW.passkey_assertion_signature_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.secure_verification_challenge_sha256) = 64
      AND NEW.secure_verification_challenge_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.registration_execution_id_sha256) = 64
      AND NEW.registration_execution_id_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.registration_credential_id_sha256) = 64
      AND NEW.registration_credential_id_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.authority_ledger_identity_sha256) = 64
      AND NEW.authority_ledger_identity_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.ledger_head_before_sha256) = 64
      AND NEW.ledger_head_before_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.secure_verification_receipt_sha256) = 64
      AND NEW.secure_verification_receipt_sha256
            NOT GLOB '*[^0-9a-f]*'
      AND length(NEW.registration_receipt_sha256) = 64
      AND NEW.registration_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  THEN RAISE(
    ABORT,
    'drain source registration command has an invalid digest'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM users AS root_user
    JOIN passkey_credentials AS passkey
      ON passkey.id = NEW.passkey_credential_row_id
     AND passkey.user_id = root_user.id
     AND passkey.credential_registration_id_sha256 =
           NEW.passkey_credential_registration_id_sha256
     AND passkey.credential_id_sha256 =
           NEW.passkey_credential_id_sha256
     AND passkey.credential_binding_sha256 =
           NEW.passkey_credential_binding_sha256
     AND passkey.credential_use_generation =
           NEW.passkey_previous_use_generation
     AND passkey.sign_count = NEW.passkey_previous_sign_count
     AND passkey.clone_warning = 0
     AND passkey.deleted_at IS NULL
    WHERE root_user.id = NEW.root_admin_id
      AND root_user.role >= 100
      AND root_user.status = 1
      AND root_user.deleted_at IS NULL
      AND root_user.session_epoch = NEW.root_session_epoch
      AND NEW.created_at < NEW.root_session_expires_at
  ) THEN RAISE(
    ABORT,
    'drain source registration command lost Root or passkey state'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_authorizations AS authorization
    JOIN relay_container_admission_scope_heads AS head
      ON head.environment = authorization.environment
     AND head.scope_kind = authorization.scope_kind
     AND head.scope_id_sha256 = authorization.scope_id_sha256
     AND head.current_fence_id_sha256 =
           authorization.admission_fence_id_sha256
     AND head.current_fence_generation =
           authorization.fence_generation
     AND head.head_version = authorization.expected_head_version
     AND head.head_digest_sha256 =
           authorization.expected_head_digest_sha256
    JOIN relay_container_admission_fences AS fence
      ON fence.admission_fence_id_sha256 =
           head.current_fence_id_sha256
     AND fence.environment = head.environment
     AND fence.scope_kind = head.scope_kind
     AND fence.scope_id_sha256 = head.scope_id_sha256
     AND fence.fence_generation = head.current_fence_generation
    WHERE authorization.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND authorization.environment = NEW.environment
      AND authorization.authorized_by_admin_id = NEW.root_admin_id
      AND authorization.recorded_at <= NEW.verified_at
      AND NEW.verification_expires_at <= authorization.permit_expires_at
      AND NEW.created_at < authorization.permit_expires_at
      AND authorization.scope_kind = 'global'
      AND authorization.scope_id_sha256 =
            NEW.authority_ledger_identity_sha256
      AND fence.fence_kind = 'admission'
      AND fence.admission_open = 1
      AND fence.state_digest_sha256 =
            authorization.expected_fence_state_digest_sha256
  ) THEN RAISE(
    ABORT,
    'drain source registration command lost authorization or fence state'
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
    'drain source registration command lost the current ledger head'
  ) END;

  SELECT CASE WHEN
    EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorization_claims AS claim
      WHERE claim.authorization_id_sha256 = NEW.authorization_id_sha256
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_terminal_receipts AS terminal
      WHERE terminal.authorization_id_sha256 =
              NEW.authorization_id_sha256
    )
    OR EXISTS (
      SELECT 1
      FROM relay_container_drain_source_authorizations AS authorization
      JOIN relay_container_drain_source_scans AS scan
        ON scan.source_scan_id_sha256 = authorization.source_scan_id_sha256
      WHERE authorization.authorization_id_sha256 =
              NEW.authorization_id_sha256
    )
  THEN RAISE(
    ABORT,
    'drain source registration command is claimed, terminal, or replayed'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_registration_command_project
AFTER INSERT
ON relay_container_drain_source_registration_commands
FOR EACH ROW
BEGIN
  INSERT INTO logs (
    user_id,
    created_at,
    type,
    content,
    username,
    token_name,
    model_name,
    quota,
    prompt_tokens,
    completion_tokens,
    use_time,
    is_stream,
    channel_id,
    token_id,
    "group",
    ip,
    request_id,
    upstream_request_id,
    other,
    drain_source_registration_command_id_sha256
  )
  SELECT
    NEW.root_admin_id,
    NEW.created_at,
    3,
    'Root registered relay container drain-source authorization',
    '',
    '',
    '',
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    '',
    '',
    NEW.admin_audit_digest_sha256,
    '',
    json_object(
      'op',
      json_object(
        'action',
        NEW.action,
        'params',
        json_object(
          'authorization_id_sha256',
          NEW.authorization_id_sha256,
          'action_subject_sha256',
          NEW.action_subject_sha256,
          'action_digest_sha256',
          NEW.action_digest_sha256,
          'registration_request_sha256',
          NEW.registration_request_sha256,
          'command_id_sha256',
          NEW.command_id_sha256,
          'permit_id_sha256',
          NEW.permit_id_sha256,
          'change_ticket_sha256',
          NEW.change_ticket_sha256,
          'reason_code',
          NEW.reason_code,
          'admin_network_identity_hmac_sha256',
          NEW.admin_network_identity_hmac_sha256
        )
      ),
      'admin_info',
      json_object(
        'admin_id',
        NEW.root_admin_id,
        'admin_username',
        '',
        'admin_role',
        root_user.role,
        'auth_method',
        'passkey'
      ),
      'audit_info',
      json_object(
        'request_path',
        '/internal/relay-container/drain-source/register',
        'request_method',
        'POST',
        'status_code',
        200,
        'result',
        'success'
      )
    ),
    NEW.command_id_sha256
  FROM users AS root_user
  WHERE root_user.id = NEW.root_admin_id;

  SELECT CASE WHEN changes() <> 1
  THEN RAISE(
    ABORT,
    'drain source registration protected audit projection failed'
  ) END;

  UPDATE passkey_credentials
  SET sign_count = NEW.passkey_sign_count,
      clone_warning = 0,
      user_present = NEW.passkey_user_present,
      user_verified = NEW.passkey_user_verified,
      backup_eligible = NEW.passkey_backup_eligible,
      backup_state = NEW.passkey_backup_state,
      credential_use_generation = NEW.passkey_next_use_generation,
      last_used_at = NEW.verified_at,
      updated_at = NEW.created_at
  WHERE id = NEW.passkey_credential_row_id
    AND user_id = NEW.root_admin_id
    AND credential_registration_id_sha256 =
          NEW.passkey_credential_registration_id_sha256
    AND credential_id_sha256 = NEW.passkey_credential_id_sha256
    AND credential_binding_sha256 =
          NEW.passkey_credential_binding_sha256
    AND credential_use_generation =
          NEW.passkey_previous_use_generation
    AND sign_count = NEW.passkey_previous_sign_count
    AND clone_warning = 0
    AND deleted_at IS NULL;

  SELECT CASE WHEN changes() <> 1
  THEN RAISE(
    ABORT,
    'drain source registration passkey CAS failed'
  ) END;

  INSERT INTO relay_container_drain_source_authorization_registrations (
    authorization_id_sha256,
    contract_version,
    registration_contract,
    registration_migration,
    environment,
    scope_kind,
    scope_id_sha256,
    source_scan_id_sha256,
    root_admin_id,
    root_session_epoch,
    root_session_binding_sha256,
    passkey_credential_row_id,
    passkey_credential_id_sha256,
    passkey_assertion_subject_sha256,
    passkey_assertion_signature_sha256,
    secure_verification_challenge_sha256,
    secure_verification_receipt_sha256,
    action_digest_sha256,
    admin_audit_digest_sha256,
    change_ticket_sha256,
    reason_code,
    registered_by_service_name,
    registered_by_version_id,
    registration_execution_id_sha256,
    registration_credential_id_sha256,
    registration_request_sha256,
    authority_ledger_identity_sha256,
    receipt_sequence,
    ledger_head_before_sha256,
    registration_receipt_sha256,
    verified_at,
    verification_expires_at,
    registered_at
  )
  SELECT
    NEW.authorization_id_sha256,
    1,
    'relay-container-drain-source-authorization-registration-v1',
    '0073_relay_container_drain_source_authorization_consumption.sql',
    authorization.environment,
    authorization.scope_kind,
    authorization.scope_id_sha256,
    authorization.source_scan_id_sha256,
    NEW.root_admin_id,
    NEW.root_session_epoch,
    NEW.root_session_binding_sha256,
    NEW.passkey_credential_row_id,
    NEW.passkey_credential_id_sha256,
    NEW.passkey_assertion_subject_sha256,
    NEW.passkey_assertion_signature_sha256,
    NEW.secure_verification_challenge_sha256,
    NEW.secure_verification_receipt_sha256,
    NEW.action_digest_sha256,
    NEW.admin_audit_digest_sha256,
    NEW.change_ticket_sha256,
    NEW.reason_code,
    NEW.registered_by_service_name,
    NEW.registered_by_version_id,
    NEW.registration_execution_id_sha256,
    NEW.registration_credential_id_sha256,
    NEW.registration_request_sha256,
    NEW.authority_ledger_identity_sha256,
    NEW.receipt_sequence,
    NEW.ledger_head_before_sha256,
    NEW.registration_receipt_sha256,
    NEW.verified_at,
    NEW.verification_expires_at,
    NEW.created_at
  FROM relay_container_drain_source_authorizations AS authorization
  WHERE authorization.authorization_id_sha256 =
          NEW.authorization_id_sha256;

  SELECT CASE WHEN changes() <> 1
  THEN RAISE(
    ABORT,
    'drain source registration receipt projection failed'
  ) END;
END;

CREATE TRIGGER relay_container_drain_source_registration_command_update_guard
BEFORE UPDATE
ON relay_container_drain_source_registration_commands
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'drain source registration commands are immutable');
END;

CREATE TRIGGER relay_container_drain_source_registration_command_delete_guard
BEFORE DELETE
ON relay_container_drain_source_registration_commands
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'drain source registration commands are append-preserved'
  );
END;

CREATE TRIGGER relay_container_drain_source_command_exact_root_guard
BEFORE INSERT ON relay_container_drain_source_registration_commands
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM users AS root_user
  WHERE root_user.id = NEW.root_admin_id
    AND root_user.role = 100
    AND root_user.status = 1
    AND root_user.deleted_at IS NULL
    AND root_user.session_epoch = NEW.root_session_epoch
)
BEGIN
  SELECT RAISE(
    ABORT,
    'drain source registration command requires exact live Root authority'
  );
END;

CREATE TRIGGER relay_container_drain_source_protected_audit_insert_guard
BEFORE INSERT ON logs
FOR EACH ROW
WHEN NEW.drain_source_registration_command_id_sha256 IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_registration_commands AS command
    JOIN users AS root_user
      ON root_user.id = command.root_admin_id
    WHERE command.command_id_sha256 =
            NEW.drain_source_registration_command_id_sha256
      AND NEW.user_id = command.root_admin_id
      AND NEW.created_at = command.created_at
      AND NEW.type = 3
      AND NEW.content =
            'Root registered relay container drain-source authorization'
      AND NEW.username = ''
      AND NEW.token_name = ''
      AND NEW.model_name = ''
      AND NEW.quota = 0
      AND NEW.prompt_tokens = 0
      AND NEW.completion_tokens = 0
      AND NEW.use_time = 0
      AND NEW.is_stream = 0
      AND NEW.channel_id = 0
      AND NEW.token_id = 0
      AND NEW."group" = ''
      AND NEW.ip = ''
      AND NEW.request_id = command.admin_audit_digest_sha256
      AND NEW.upstream_request_id = ''
      AND NEW.other = json_object(
        'op',
        json_object(
          'action',
          command.action,
          'params',
          json_object(
            'authorization_id_sha256',
            command.authorization_id_sha256,
            'action_subject_sha256',
            command.action_subject_sha256,
            'action_digest_sha256',
            command.action_digest_sha256,
            'registration_request_sha256',
            command.registration_request_sha256,
            'command_id_sha256',
            command.command_id_sha256,
            'permit_id_sha256',
            command.permit_id_sha256,
            'change_ticket_sha256',
            command.change_ticket_sha256,
            'reason_code',
            command.reason_code,
            'admin_network_identity_hmac_sha256',
            command.admin_network_identity_hmac_sha256
          )
        ),
        'admin_info',
        json_object(
          'admin_id',
          command.root_admin_id,
          'admin_username',
          '',
          'admin_role',
          root_user.role,
          'auth_method',
          'passkey'
        ),
        'audit_info',
        json_object(
          'request_path',
          '/internal/relay-container/drain-source/register',
          'request_method',
          'POST',
          'status_code',
          200,
          'result',
          'success'
        )
      )
  ) THEN RAISE(
    ABORT,
    'drain source registration protected audit is non-canonical'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM logs AS existing
    WHERE existing.drain_source_registration_command_id_sha256 =
            NEW.drain_source_registration_command_id_sha256
       OR existing.request_id = NEW.request_id
  ) THEN RAISE(
    ABORT,
    'drain source registration protected audit already exists'
  ) END;
END;

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

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_source_registration_commands AS command
    JOIN relay_container_drain_source_authorizations AS authorization
      ON authorization.authorization_id_sha256 =
           command.authorization_id_sha256
    JOIN users AS root_user
      ON root_user.id = command.root_admin_id
     AND root_user.role >= 100
     AND root_user.status = 1
     AND root_user.deleted_at IS NULL
     AND root_user.session_epoch = command.root_session_epoch
    JOIN passkey_credentials AS passkey
      ON passkey.id = command.passkey_credential_row_id
     AND passkey.user_id = command.root_admin_id
     AND passkey.credential_registration_id_sha256 =
           command.passkey_credential_registration_id_sha256
     AND passkey.credential_id_sha256 =
           command.passkey_credential_id_sha256
     AND passkey.credential_binding_sha256 =
           command.passkey_credential_binding_sha256
     AND passkey.credential_use_generation =
           command.passkey_next_use_generation
     AND passkey.sign_count = command.passkey_sign_count
     AND passkey.clone_warning = 0
     AND passkey.user_present = 1
     AND passkey.user_verified = 1
     AND passkey.backup_eligible = command.passkey_backup_eligible
     AND passkey.backup_state = command.passkey_backup_state
     AND passkey.last_used_at = command.verified_at
     AND passkey.updated_at = command.created_at
     AND passkey.deleted_at IS NULL
    JOIN logs AS audit
      ON audit.drain_source_registration_command_id_sha256 =
           command.command_id_sha256
     AND audit.user_id = command.root_admin_id
     AND audit.created_at = command.created_at
     AND audit.type = 3
     AND audit.username = ''
     AND audit.ip = ''
     AND audit.request_id = command.admin_audit_digest_sha256
    WHERE command.authorization_id_sha256 =
            NEW.authorization_id_sha256
      AND command.environment = NEW.environment
      AND authorization.environment = NEW.environment
      AND authorization.scope_kind = NEW.scope_kind
      AND authorization.scope_id_sha256 = NEW.scope_id_sha256
      AND authorization.source_scan_id_sha256 =
            NEW.source_scan_id_sha256
      AND command.root_admin_id = NEW.root_admin_id
      AND command.root_session_epoch = NEW.root_session_epoch
      AND command.root_session_binding_sha256 =
            NEW.root_session_binding_sha256
      AND command.passkey_credential_row_id =
            NEW.passkey_credential_row_id
      AND command.passkey_credential_id_sha256 =
            NEW.passkey_credential_id_sha256
      AND command.passkey_assertion_subject_sha256 =
            NEW.passkey_assertion_subject_sha256
      AND command.passkey_assertion_signature_sha256 =
            NEW.passkey_assertion_signature_sha256
      AND command.secure_verification_challenge_sha256 =
            NEW.secure_verification_challenge_sha256
      AND command.secure_verification_receipt_sha256 =
            NEW.secure_verification_receipt_sha256
      AND command.action_digest_sha256 = NEW.action_digest_sha256
      AND command.admin_audit_digest_sha256 =
            NEW.admin_audit_digest_sha256
      AND command.change_ticket_sha256 = NEW.change_ticket_sha256
      AND command.reason_code = NEW.reason_code
      AND command.registered_by_service_name =
            NEW.registered_by_service_name
      AND command.registered_by_version_id =
            NEW.registered_by_version_id
      AND command.registration_execution_id_sha256 =
            NEW.registration_execution_id_sha256
      AND command.registration_credential_id_sha256 =
            NEW.registration_credential_id_sha256
      AND command.registration_request_sha256 =
            NEW.registration_request_sha256
      AND command.authority_ledger_identity_sha256 =
            NEW.authority_ledger_identity_sha256
      AND command.receipt_sequence = NEW.receipt_sequence
      AND command.ledger_head_before_sha256 =
            NEW.ledger_head_before_sha256
      AND command.registration_receipt_sha256 =
            NEW.registration_receipt_sha256
      AND command.verified_at = NEW.verified_at
      AND command.verification_expires_at =
            NEW.verification_expires_at
      AND command.created_at = NEW.registered_at
      AND NEW.registered_at < command.root_session_expires_at
      AND NEW.registered_at < command.permit_expires_at
  ) THEN RAISE(
    ABORT,
    'drain source registration must be projected by an exact 0074 command'
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
