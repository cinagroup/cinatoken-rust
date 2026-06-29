-- Migration 0006: two-factor authentication (2FA / TOTP) tables.
--
-- Ports the Go GORM models `model.TwoFA` and `model.TwoFABackupCode`
-- (model/twofa.go) so the enrollment + step-up flows (item 4.6, and the 2FA
-- method of secure-verification §2.3) have a home. The TOTP math is already
-- ported in `cinatoken_auth::totp`.
--
-- Divergence from Go: Go soft-deletes (gorm `DeletedAt`). Here a 2FA disable is
-- a HARD delete of the row + its backup codes, so the TOTP secret is actually
-- removed on disable (more secure, and simpler reads — no `deleted_at` filter
-- on the hot path). Timestamps are unix-seconds INTEGERs and booleans are
-- 0/1 INTEGERs, matching the rest of the D1 schema.

CREATE TABLE IF NOT EXISTS two_fa (
  id INTEGER PRIMARY KEY,
  -- One 2FA config per user (Go `gorm:"unique"`).
  user_id INTEGER NOT NULL UNIQUE,
  -- Base32 TOTP secret. Never returned to the client.
  secret TEXT NOT NULL,
  -- 0 while a secret is provisioned but not yet confirmed; 1 once a valid code
  -- has been presented (Go `IsEnabled`).
  is_enabled INTEGER NOT NULL DEFAULT 0,
  -- Failed-attempt lockout bookkeeping (Go `FailedAttempts` / `LockedUntil`).
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS two_fa_backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  -- Hash of a single-use backup code (Go `CodeHash`); the plaintext is shown
  -- once at enrollment and never stored.
  code_hash TEXT NOT NULL,
  is_used INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_two_fa_backup_codes_user_id
  ON two_fa_backup_codes(user_id);
