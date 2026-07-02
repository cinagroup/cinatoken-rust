-- 0008: model metadata + vendors (Go model.Model / model.Vendor).
--
-- Operator-populated display/metadata tables backing GET /api/pricing (and the
-- Go models/vendors admin CRUD). `models.name_rule` follows Go model_meta.go:
-- 0 = exact, 1 = prefix, 2 = contains, 3 = suffix. `endpoints` is an optional
-- JSON object overriding the per-model supported-endpoint list. Soft delete
-- via `deleted_at` (NULL = live), matching the Go gorm.DeletedAt convention.

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
  name_rule INTEGER NOT NULL DEFAULT 0,
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_models_model_name ON models(model_name);
CREATE INDEX IF NOT EXISTS idx_models_vendor_id ON models(vendor_id);
CREATE INDEX IF NOT EXISTS idx_models_deleted_at ON models(deleted_at);

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
CREATE INDEX IF NOT EXISTS idx_vendors_deleted_at ON vendors(deleted_at);
