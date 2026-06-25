# Source D1 Schema Parity (P0 Tables)

Date: 2026-06-25

Status: canonical, source-derived field-level parity between the Go GORM models
and the D1 migration for the P0 core tables. This is a G2 (data dry run)
deliverable consumed by `docs/data-migration-runbook.md`. It records every
column/type/index/default/PK difference that the ETL and the Rust query layer
must account for, plus a ready-to-apply corrective migration.

## Source Of Truth

- Go models: `C:\cinagroup\cinatoken\model\{user,token,channel,ability,option,log}.go`.
- D1 schema: `migrations/d1/0001_core.sql` **and** `0002_admin_tables.sql`
  (0002 already adds most `logs` search indexes — see the corrected Finding 2).

Scope: P0 tables only (User, Token, Channel, Ability, Option, Log). Channel/admin
long-tail tables are tracked in the Data And Table Matrix, not here.

## Findings Summary (prioritized)

1. **P0 — `abilities` is structurally divergent and lossy.** Go `Ability` has a
   composite primary key `(group, model, channel_id)` and a `Tag` column; D1 used
   a synthetic `id` PK, **renamed `group` to `group_name`**, **dropped the `tag`
   column**, and has **no UNIQUE constraint** enforcing one row per
   (group, model, channel). Ability sync and tag-based channel filtering depend on
   both the uniqueness and the tag. This must be fixed before importing abilities.

2. **P1 — `logs` is missing one search index (corrected 2026-06-25).** An earlier
   revision analyzed only `0001_core.sql` and overstated this gap.
   `0002_admin_tables.sql` already adds `idx_logs_{type,created_at_type,
   token_name,channel_id,group,ip,username}` and the `(model_name, username)`
   composite. The **only** genuinely-missing Go index is `token_id`
   (`idx_logs_token_id`, added in `0004`). If heavy log search later moves to
   Analytics Engine/R2 (§21.3/§7.9), these D1 indexes can be reconsidered for
   write-amplification.

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

### logs (mostly covered by 0002 — see corrected Finding 2)

| Go index | D1 state | Action |
| --- | --- | --- |
| `username`, `token_name`, `channel_id`, `group`, `ip`, `type` | **present (0002)** | none |
| `(model_name, username)` composite | **present (0002)** `idx_logs_model_name_username` | none |
| `(created_at, type)` composite | **present (0002)** | none |
| `channel_id` (json `channel`) | present (0002) | Rust API must emit `channel` (json tag) |
| `token_id` | missing | Add `idx_logs_token_id` (in `0004`) |
| ChannelName (`gorm:"->"`) | not stored | Computed join; do not add column |

## Corrective Migration (`0004_schema_parity.sql`, created 2026-06-25)

The corrective migration now exists at `migrations/d1/0004_schema_parity.sql`
(append-only per migration-plan §8.4; no edits to `0001`/`0002`). It adds only
the genuinely-missing items: the `users` OAuth-id/admin-lookup indexes,
`idx_tokens_name`, `idx_logs_token_id` (the one log index not already in `0002`),
and the `abilities` `tag` column + `(group_name, model, channel_id)` UNIQUE +
priority/weight/tag indexes.

Cautions encoded in the file:

- The `abilities` UNIQUE index requires de-duplicated data; the migration runs a
  `DELETE` that removes only true duplicates (keeping the lowest `id` per key) so
  the UNIQUE index creation is safe. This restores the Go composite-PK invariant.
- The `ALTER TABLE abilities ADD COLUMN tag` is not re-runnable (SQLite lacks
  `ADD COLUMN IF NOT EXISTS`); rely on D1's tracked single-run migration flow.
- Log search indexes are already in `0002`; if log search later moves to
  Analytics Engine/R2 (§21.3/§7.9), revisit them for write-amplification.

## Cross-Check And Next Steps

- The Data And Table Matrix in `docs/production-readiness-matrices.md` marks the
  P0 tables `Partial D1 core`; this file is the field-level backing for that row.
- Before G2 import: decide log-search strategy, verify abilities dedup, then
  apply `0004_schema_parity.sql` to staging D1 and re-run row/hash verification.
- The Rust query layer must: auto-filter `deleted_at IS NULL` for users/tokens,
  emit JSON tags (`channel`, `aff_history_quota`) regardless of column names, and
  convert bool<->int for `unlimited_quota`, `model_limits_enabled`,
  `cross_group_retry`, `is_stream`, `enabled`, `auto_ban`.
