-- Migration 0004: Go-parity schema fixes (G2).
--
-- Closes the field/index/constraint gaps found by comparing the Go GORM models
-- against the D1 schema (0001_core.sql + 0002_admin_tables.sql). See
-- docs/source-d1-schema-parity.md for the full analysis.
--
-- Scope (only genuinely-missing items; 0002 already added most log indexes):
--   * users  : OAuth-id + admin lookup indexes (login resolves users by these;
--               without them every social login full-scans `users`).
--   * tokens : name search index (admin token search).
--   * abilities : restore the `tag` column, the composite-key UNIQUE that the Go
--               composite PK (group, model, channel_id) guarantees, and the
--               priority/weight/tag selection indexes.
--   * logs   : only `token_id` remains (username/token_name/channel_id/group/ip/
--               created_at+type/model+username composites are already in 0002).
--
-- Idempotency note: every CREATE uses IF NOT EXISTS, but the `ALTER TABLE
-- abilities ADD COLUMN tag` is NOT re-runnable (SQLite has no ADD COLUMN IF NOT
-- EXISTS). D1 migrations are tracked and applied once, so this is safe in the
-- normal flow; do not re-apply this file out of band.

-- ---------------------------------------------------------------------------
-- users: OAuth-id and admin lookup indexes (Go indexes these columns).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_github_id      ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_discord_id     ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_oidc_id        ON users(oidc_id);
CREATE INDEX IF NOT EXISTS idx_users_wechat_id      ON users(wechat_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id    ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_linux_do_id    ON users(linux_do_id);
CREATE INDEX IF NOT EXISTS idx_users_display_name   ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_inviter_id     ON users(inviter_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer);

-- ---------------------------------------------------------------------------
-- tokens: name search (Go indexes Token.Name).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tokens_name ON tokens(name);

-- ---------------------------------------------------------------------------
-- logs: the one index 0002 did not add (Go indexes Log.TokenId).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_logs_token_id ON logs(token_id);

-- ---------------------------------------------------------------------------
-- abilities: restore parity with Go `model/ability.go`.
--   Go uses a composite primary key (group, model, channel_id) and a Tag column;
--   0001_core.sql modelled abilities with a synthetic `id`, renamed `group` to
--   `group_name`, and dropped both `tag` and the uniqueness guarantee.
-- ---------------------------------------------------------------------------

-- 1. Restore the tag column (channel tag-based ability filtering depends on it).
ALTER TABLE abilities ADD COLUMN tag TEXT;

-- 2. Restore the composite-key uniqueness the Go composite PK guarantees.
--    Precondition: abilities must be de-duplicated on (group_name, model,
--    channel_id) or the UNIQUE INDEX creation fails. The DELETE below removes
--    only true duplicates (which violate the Go invariant and should never
--    exist), keeping the lowest id per key. This is a no-op on clean data.
DELETE FROM abilities
WHERE id NOT IN (
  SELECT MIN(id) FROM abilities GROUP BY group_name, model, channel_id
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_abilities_group_model_channel
  ON abilities(group_name, model, channel_id);

-- 3. Selection indexes (Go indexes Priority, Weight, Tag).
CREATE INDEX IF NOT EXISTS idx_abilities_priority ON abilities(priority);
CREATE INDEX IF NOT EXISTS idx_abilities_weight   ON abilities(weight);
CREATE INDEX IF NOT EXISTS idx_abilities_tag      ON abilities(tag);
