-- Migration 0010: Custom OAuth provider management (G5 auth-admin slice).
--
-- Mirrors Go `model/custom_oauth_provider.go` and
-- `model/user_oauth_binding.go` for the root-admin custom OAuth provider
-- configuration surface. The login/bind callback flow remains a later auth
-- migration; this migration only creates the durable config/binding tables so
-- provider CRUD, discovery, status exposure, and source imports have a real
-- D1 target.

CREATE TABLE IF NOT EXISTS custom_oauth_providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  authorization_endpoint TEXT NOT NULL DEFAULT '',
  token_endpoint TEXT NOT NULL DEFAULT '',
  user_info_endpoint TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  user_id_field TEXT NOT NULL DEFAULT 'sub',
  username_field TEXT NOT NULL DEFAULT 'preferred_username',
  display_name_field TEXT NOT NULL DEFAULT 'name',
  email_field TEXT NOT NULL DEFAULT 'email',
  well_known TEXT NOT NULL DEFAULT '',
  auth_style INTEGER NOT NULL DEFAULT 0,
  access_policy TEXT NOT NULL DEFAULT '',
  access_denied_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_custom_oauth_providers_slug
  ON custom_oauth_providers(slug);
CREATE INDEX IF NOT EXISTS idx_custom_oauth_providers_enabled
  ON custom_oauth_providers(enabled);

CREATE TABLE IF NOT EXISTS user_oauth_bindings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, provider_id),
  UNIQUE(provider_id, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_bindings_user_id
  ON user_oauth_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_oauth_bindings_provider_id
  ON user_oauth_bindings(provider_id);
