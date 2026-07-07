-- Session revocation epoch for the Rust stateless session cookie.
--
-- A user's signed cookie is accepted only when its `iat` is greater than or
-- equal to this value. Existing users default to 0, so no session is revoked
-- until a password/reset/disable/delete/role-change path bumps the epoch.
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_session_epoch ON users(session_epoch);
