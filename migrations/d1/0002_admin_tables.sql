-- Migration 0002: admin tables and log indexes.
--
-- Closes the gap between the Worker MVP schema (0001_core.sql) and the
-- upcoming admin/frontend (G5) surface. Adds:
--   * vendors, models admin tables (used by /api/vendors, /api/models/*)
--   * logs indexes that back admin log queries and stat (without these the
--     admin log pages and the rpm/tpm stat would full-scan)
--
-- Note: users.password is already in 0001_core.sql (line 4); login works
-- against that column directly. No ALTER TABLE is needed.
--
-- Idempotent: every statement uses IF NOT EXISTS so re-applying is safe.

-- vendors: admin-managed vendor metadata. Mirrors Go `model/vendor_meta.go`.
-- name is unique among non-deleted rows; D1/SQLite does not support partial
-- unique indexes portably across all runtimes, so uniqueness is enforced in
-- application code (same as Go which uses `name:varchar(128) uniqueIndex` with
-- a soft-delete pattern).
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
CREATE INDEX IF NOT EXISTS idx_vendors_deleted_at ON vendors(deleted_at);

-- models: admin-managed model metadata. Mirrors Go `model/model_meta.go`.
-- model_name uniqueness among non-deleted rows is enforced in application code
-- for the same reason as vendors.
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  model_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  vendor_id INTEGER NOT NULL DEFAULT 0,
  endpoints TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,
  sync_official INTEGER NOT NULL DEFAULT 1,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0,
  name_rule INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_models_model_name ON models(model_name);
CREATE INDEX IF NOT EXISTS idx_models_vendor_id ON models(vendor_id);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
CREATE INDEX IF NOT EXISTS idx_models_deleted_at ON models(deleted_at);

-- logs indexes: the admin log pages (`/api/log/`, `/api/log/stat`) and the
-- self log pages filter by type, time window, username, token_name,
-- channel_id, group, and ip. The rpm/tpm stat scans the last 60 seconds by
-- `type=2 AND created_at >= ?`. Without these indexes D1 would full-scan the
-- logs table on every admin query.
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
CREATE INDEX IF NOT EXISTS idx_logs_created_at_type ON logs(created_at, type);
CREATE INDEX IF NOT EXISTS idx_logs_token_name ON logs(token_name);
CREATE INDEX IF NOT EXISTS idx_logs_channel_id ON logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_logs_group ON logs("group");
CREATE INDEX IF NOT EXISTS idx_logs_ip ON logs(ip);
CREATE INDEX IF NOT EXISTS idx_logs_username ON logs(username);
CREATE INDEX IF NOT EXISTS idx_logs_model_name_username ON logs(model_name, username);
