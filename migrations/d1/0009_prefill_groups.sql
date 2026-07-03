-- 0009: reusable prefill groups (Go model.PrefillGroup).
--
-- `items` stores the original JSON value as text so both frontend forms are
-- preserved: string arrays for model/tag groups and serialized endpoint maps.
-- Soft deletion and unix-second timestamps match the Worker D1 conventions.
-- The column set intentionally matches the migration tool's `prefill_groups`
-- projection.

CREATE TABLE IF NOT EXISTS prefill_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  items TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_time INTEGER NOT NULL DEFAULT 0,
  updated_time INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_prefill_name
  ON prefill_groups(name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prefill_groups_type
  ON prefill_groups(type);
CREATE INDEX IF NOT EXISTS idx_prefill_groups_deleted_at
  ON prefill_groups(deleted_at);
