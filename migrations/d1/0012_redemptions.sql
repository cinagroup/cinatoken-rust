-- Redemption code records (Go model.Redemption, model/redemption.go).
--
-- GORM soft-delete semantics are represented by deleted_at. Admin list/search/
-- get routes only read live rows; delete operations set deleted_at.

CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  "key" TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT 100,
  created_time INTEGER NOT NULL DEFAULT 0,
  redeemed_time INTEGER NOT NULL DEFAULT 0,
  used_user_id INTEGER NOT NULL DEFAULT 0,
  expired_time INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_redemptions_name ON redemptions(name);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions(status);
CREATE INDEX IF NOT EXISTS idx_redemptions_expired_time ON redemptions(expired_time);
CREATE INDEX IF NOT EXISTS idx_redemptions_deleted_at ON redemptions(deleted_at);
