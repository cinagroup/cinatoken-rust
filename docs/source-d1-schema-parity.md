# Source D1 Schema Parity (P0 Tables)

Date: 2026-06-25

Status: canonical, source-derived field-level parity between the Go GORM models
and the D1 migration for the P0 core tables. This is a G2 (data dry run)
deliverable consumed by `docs/data-migration-runbook.md`. It records every
column/type/index/default/PK difference that the ETL and the Rust query layer
must account for, plus a ready-to-apply corrective migration.

## Source Of Truth

- Go models: `C:\cinagroup\cinatoken\model\{user,token,channel,ability,option,log}.go`.
- D1 schema: `migrations/d1/0001_core.sql`.

Scope: P0 tables only (User, Token, Channel, Ability, Option, Log). Channel/admin
long-tail tables are tracked in the Data And Table Matrix, not here.

## Findings Summary (prioritized)

1. **P0 — `abilities` is structurally divergent and lossy.** Go `Ability` has a
   composite primary key `(group, model, channel_id)` and a `Tag` column; D1 used
   a synthetic `id` PK, **renamed `group` to `group_name`**, **dropped the `tag`
   column**, and has **no UNIQUE constraint** enforcing one row per
   (group, model, channel). Ability sync and tag-based channel filtering depend on
   both the uniqueness and the tag. This must be fixed before importing abilities.

2. **P0 — `logs` is missing most search indexes.** Go declares indexes on
   `username`, `token_name`, `channel_id`, `token_id`, `group`, `ip`, a composite
   `(username, model_name)`, and `(created_at, type)`. D1 has only
   `created_at+id`, `user_id+id`, `model_name`, `request_id`,
   `upstream_request_id`. Admin log search filters by the missing columns, so on
   D1 they become full scans on the highest-volume table. Either add the indexes
   (corrective migration below) or move heavy log search off D1 to Analytics
   Engine/R2 per migration-plan §21.3/§7.9 — decide explicitly.

3. **P0 — `users` is missing OAuth-id lookup indexes.** Go indexes
   `github_id`, `discord_id`, `oidc_id`, `wechat_id`, `telegram_id`,
   `linux_do_id` (plus `display_name`, `inviter_id`, `stripe_customer`). OAuth
   login resolves a user by `WHERE <provider>_id = ?`; without these indexes
   every social login is a full table scan.

4. **P1 — soft-delete semantics must be replicated.** `User`, `Token` use
   `gorm.DeletedAt`; GORM auto-appends `WHERE deleted_at IS NULL` to every query.
   The Rust query layer must apply the same filter or it will return deleted
   rows. `Channel`, `Ability`, `Option`, `Log` are hard-deleted (no DeletedAt).

5. **P1 — JSON field names differ from column names** (API serialization parity):
   `Log.ChannelId` serializes as `channel` (not `channel_id`);
   `User.AffHistoryQuota` serializes as `aff_history_quota` but its column is
   `aff_history`. The Rust API responses must match the JSON tags the frontend
   consumes, independent of the D1 column names.

6. **P2 — nullable pointer vs NOT NULL.** Several Go `*string`/`*int`/`*uint`
   fields (e.g. `Token.AllowIps`, `Channel.StatusCodeMapping`, `Channel.Weight`,
   `Channel.BaseURL`) are nullable in Go but `NOT NULL DEFAULT ...` in D1. The ETL
   must map Go `NULL` to the D1 default; otherwise import fails on NOT NULL.

## Per-Table Parity (differences only)

Matching fields are omitted. "OK" tables are noted as such.

### users

| Go field (column) | Go index/type | D1 state | Action |
| --- | --- | --- | --- |
| GitHubId (`github_id`) | index | column present, **no index** | Add `idx_users_github_id` |
| DiscordId (`discord_id`) | index | **no index** | Add index |
| OidcId (`oidc_id`) | index | **no index** | Add index |
| WeChatId (`wechat_id`) | index | **no index** | Add index |
| TelegramId (`telegram_id`) | index | **no index** | Add index |
| LinuxDOId (`linux_do_id`) | index | **no index** | Add index |
| DisplayName (`display_name`) | index | **no index** | Add index |
| InviterId (`inviter_id`) | index | **no index** | Add index |
| StripeCustomer (`stripe_customer`) | varchar(64) index | **no index** | Add index |
| AffHistoryQuota | json `aff_history_quota`, column `aff_history` | column `aff_history` OK | Rust API must emit `aff_history_quota` |
| DeletedAt | `gorm.DeletedAt` (NullTime) | `deleted_at INTEGER` nullable | ETL time->int; Rust auto-filters `IS NULL` |
| OriginalPassword, VerificationCode | `gorm:"-:all"` | absent (correct) | Never persist |

Note: D1 has no `updated_at` for users; Go `User` has none either. OK.

### tokens

| Go field | Go index/type | D1 state | Action |
| --- | --- | --- | --- |
| Name (`name`) | index | column present, **no index** | Add `idx_tokens_name` |
| AllowIps (`allow_ips`) | `*string default:''` (nullable) | `NOT NULL DEFAULT ''` | ETL NULL->'' |
| UnlimitedQuota/ModelLimitsEnabled/CrossGroupRetry | Go `bool` | `INTEGER 0/1` | Bool<->int at query layer |
| DeletedAt | `gorm.DeletedAt` | `deleted_at INTEGER` | Auto-filter `IS NULL` |

### channels

Column parity is complete. D1 adds helpful indexes Go does not declare in the
struct (`idx_channels_type`, `idx_channels_status`, `idx_channels_group`) — this
is a superset and benefits channel selection; keep them. Nullable pointers
(`status_code_mapping`, `base_url`, `weight`) are `NOT NULL DEFAULT` in D1 —
ETL maps NULL to default. `ChannelInfo`/`settings` JSON stored as TEXT — OK.
No DeletedAt (hard delete) — OK.

### abilities (structurally divergent — fix before import)

| Aspect | Go | D1 (`0001_core.sql`) | Action |
| --- | --- | --- | --- |
| Primary key | composite `(group, model, channel_id)` | synthetic `id INTEGER` | Add `UNIQUE(group_name, model, channel_id)` |
| Group column | `group` (reserved word) | renamed `group_name` | ETL/query map `group`<->`group_name` |
| Tag | `Tag *string` index | **column missing** | Add `tag TEXT` + index |
| Priority | index | **no index** | Add index |
| Weight | index | **no index** | Add index |

### options

Go PK is `key`; D1 uses synthetic `id` + `"key" TEXT UNIQUE`. UNIQUE preserves
lookup semantics. Acceptable; no change required.

### logs (missing search indexes — see Finding 2)

| Go index | D1 state | Action |
| --- | --- | --- |
| `username` | missing | Add `idx_logs_username` |
| `(username, model_name)` composite | missing | Add `idx_logs_username_model` |
| `token_name` | missing | Add `idx_logs_token_name` |
| `channel_id` (json `channel`) | missing | Add `idx_logs_channel_id`; Rust API emits `channel` |
| `token_id` | missing | Add `idx_logs_token_id` |
| `group` | missing | Add `idx_logs_group` |
| `ip` | missing | Add `idx_logs_ip` |
| `(created_at, type)` composite | missing | Add `idx_logs_created_at_type` |
| ChannelName (`gorm:"->"`) | not stored | Computed join; do not add column |

## Recommended Corrective Migration (proposed, not yet applied)

Append-only per migration-plan §8.4 (no edits to `0001_core.sql`). Two cautions
before applying:

- The `abilities` UNIQUE constraint requires the imported data to already be
  de-duplicated on `(group_name, model, channel_id)`; verify during the G2 dry
  run before adding it. SQLite cannot add a table-level UNIQUE via `ALTER`, so
  abilities needs a `CREATE UNIQUE INDEX` instead.
- Confirm the log-search strategy (D1 indexes vs Analytics Engine/R2) before
  committing the log indexes; they add write amplification on the hottest table.

```sql
-- migrations/d1/0004_schema_parity.sql (proposed)

-- users: OAuth-id and admin lookup indexes
CREATE INDEX IF NOT EXISTS idx_users_github_id   ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_discord_id  ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_oidc_id     ON users(oidc_id);
CREATE INDEX IF NOT EXISTS idx_users_wechat_id   ON users(wechat_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_linux_do_id ON users(linux_do_id);
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_inviter_id  ON users(inviter_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer);

-- tokens: name search
CREATE INDEX IF NOT EXISTS idx_tokens_name ON tokens(name);

-- abilities: restore tag column, uniqueness, and selection indexes
ALTER TABLE abilities ADD COLUMN tag TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_abilities_group_model_channel
  ON abilities(group_name, model, channel_id);
CREATE INDEX IF NOT EXISTS idx_abilities_priority ON abilities(priority);
CREATE INDEX IF NOT EXISTS idx_abilities_weight   ON abilities(weight);
CREATE INDEX IF NOT EXISTS idx_abilities_tag      ON abilities(tag);

-- logs: admin search indexes (only if D1 remains the search surface)
CREATE INDEX IF NOT EXISTS idx_logs_username         ON logs(username);
CREATE INDEX IF NOT EXISTS idx_logs_username_model   ON logs(username, model_name);
CREATE INDEX IF NOT EXISTS idx_logs_token_name       ON logs(token_name);
CREATE INDEX IF NOT EXISTS idx_logs_channel_id       ON logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_logs_token_id         ON logs(token_id);
CREATE INDEX IF NOT EXISTS idx_logs_group            ON logs("group");
CREATE INDEX IF NOT EXISTS idx_logs_ip               ON logs(ip);
CREATE INDEX IF NOT EXISTS idx_logs_created_at_type  ON logs(created_at, type);
```

## Cross-Check And Next Steps

- The Data And Table Matrix in `docs/production-readiness-matrices.md` marks the
  P0 tables `Partial D1 core`; this file is the field-level backing for that row.
- Before G2 import: decide log-search strategy, verify abilities dedup, then
  apply `0004_schema_parity.sql` to staging D1 and re-run row/hash verification.
- The Rust query layer must: auto-filter `deleted_at IS NULL` for users/tokens,
  emit JSON tags (`channel`, `aff_history_quota`) regardless of column names, and
  convert bool<->int for `unlimited_quota`, `model_limits_enabled`,
  `cross_group_retry`, `is_stream`, `enabled`, `auto_ban`.
