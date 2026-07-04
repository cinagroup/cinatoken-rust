-- Migration 0016: Passkey credential storage (G5 auth-admin slice).
--
-- Mirrors Go `model/passkey.go` so Worker-side account recovery can delete a
-- target user's Passkey credentials now, and the later full WebAuthn
-- register/login/step-up flow has a durable D1 home. Go stores WebAuthn binary
-- values base64-encoded; this schema keeps that representation for migration
-- and replay parity.
--
-- Deletion is intentionally a HARD delete, matching Go's `Unscoped()` delete in
-- `DeletePasskeyByUserID` and avoiding stale unique-index conflicts when a user
-- re-registers a credential.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id INTEGER PRIMARY KEY,
  -- One active Passkey credential per user in the current Go model.
  user_id INTEGER NOT NULL UNIQUE,
  -- Base64-encoded WebAuthn credential id.
  credential_id TEXT NOT NULL UNIQUE,
  -- Base64-encoded public key.
  public_key TEXT NOT NULL,
  attestation_type TEXT NOT NULL DEFAULT '',
  -- Base64-encoded authenticator AAGUID.
  aaguid TEXT NOT NULL DEFAULT '',
  sign_count INTEGER NOT NULL DEFAULT 0,
  clone_warning INTEGER NOT NULL DEFAULT 0,
  user_present INTEGER NOT NULL DEFAULT 0,
  user_verified INTEGER NOT NULL DEFAULT 0,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backup_state INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id
  ON passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id
  ON passkey_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_deleted_at
  ON passkey_credentials(deleted_at);
