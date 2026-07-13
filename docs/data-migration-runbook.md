# Data Migration Runbook

Date: 2026-07-12

Status: production data migration control document for moving authoritative
state from the Go/VPS deployment to D1-backed Rust/Cloudflare deployment.

## Purpose

Use this runbook when exporting data from `C:\cinagroup\cinatoken`, importing
it into D1 for `cinatoken-rust`, and proving that the imported state is safe
for staging smoke, customer canary, or production cutover.

This document complements:

- `docs/data-export.md` for the current CLI export/import commands.
- `docs/production-readiness-matrices.md` for table-family status.
- `docs/staging-smoke-runbook.md` for staging evidence capture.
- `docs/cutover-rollback-runbook.md` for freeze, rollback, and reconciliation.

Official Cloudflare references used for production constraints:

- D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>
- D1 import/export: <https://developers.cloudflare.com/d1/best-practices/import-export-data/>
- D1 migrations: <https://developers.cloudflare.com/d1/reference/migrations/>
- D1 Time Travel: <https://developers.cloudflare.com/d1/reference/time-travel/>

Verify these references again immediately before production cutover. D1 limits,
backup windows, and import behavior are platform contracts that can change.

## Non-Negotiables

- Go/VPS remains the source of truth until the selected write family has passed
  its explicit cutover gate.
- Export bundles and generated SQL contain secrets and customer data. Keep them
  outside source control; never paste raw values into docs or tickets.
- Never import a table family whose target schema, row-count check, hash check,
  rollback owner, and write authority are not documented.
- Do not use D1 as the only high-volume log/archive sink. Keep recent
  queryable rows in D1 and move large/history payloads to Queue/R2 plans.
- Use separate staging and production D1 databases. A staging import is not
  evidence for production unless the source snapshot, schema, and commands are
  recorded.
- Preserve the pre-import D1 state through Time Travel, export, or explicit
  backup evidence before applying a production import.

### 2026-07-10 Local Evidence Boundary

The repository now enforces two local schema/config prerequisites:

```powershell
bun run check:d1:migration-config
bun run verify:sqlite
```

The config audit requires the top-level, staging, and production D1 binding
tables to set `migrations_dir = "migrations/d1"`; it also requires a contiguous
22-file sequence from `0001_core.sql` through
`0022_realtime_billing_global_recovery.sql`. The SQLite verifier applies all 22
migrations by default and requires 27 target tables. A real local Wrangler D1
apply completed through 0020 on 2026-07-10 and must be refreshed through 0022.

The audit also verifies `wrangler.d1-local.toml`, the narrow local management
shape used by the managed Realtime suite. Wrangler 4.103 can leave a
multi-statement non-JSON `d1 execute` process alive; fixture commands therefore
use `--json`, require every result to report success, and run only while the
managed workerd process is stopped.

This evidence is local only. Wrangler was not authenticated for remote work in
this validation window, so no remote staging migration state, database target,
row count, or Worker binding was verified. G1 and G2 remain closed. Any token
that was exposed during setup must not be reused; revoke/rotate it and
authenticate Wrangler with a replacement credential before remote commands.

## D1 Platform Guardrails

Record these checks before every production-shaped import. Values below reflect
the official D1 docs checked on 2026-06-22 and must be re-verified before a
real production cutover.

| Guardrail | Current Check | Migration Impact |
| --- | --- | --- |
| Database size | D1 production databases are 10 GB per database on Workers Paid. | Do not plan a single unbounded log/history import into one D1 database. |
| `d1 execute --file` import size | Import file limit is 5 GB. | Split generated SQL by table/wave if an export approaches the limit. |
| SQL statement length | Individual SQL statements are limited to 100 KB. | The importer must emit small batched `INSERT` statements, not huge multi-row statements. |
| Row/string/blob size | Maximum row/string/blob size is 2 MB. | Large request/response bodies, artifacts, and provider payloads belong in R2, not D1. |
| Query duration | Maximum SQL query duration is 30 seconds. | Add indexes and avoid cutover plans that require large synchronous scans in request paths. |
| Time Travel | Requires D1 production backend; verify with `wrangler d1 info`. | Capture the current bookmark/version before destructive imports or restores. |
| Migrations target | Cloudflare recommends using database name to avoid wrong binding targets. | Reports must include both database name and ID for staging/prod. |

Pre-import platform commands:

```powershell
wrangler --version
wrangler d1 info cinatoken-rust-db-staging --env staging
wrangler d1 info cinatoken-rust-db --env production
```

If `wrangler d1 info` does not show a production backend for the target
database, do not assume Time Travel rollback is available.

## Artifact Policy

Recommended local artifact layout:

```text
exports/
  YYYYMMDD-HHMM-scope/
    source-inventory.redacted.txt
    source-counts.json
    source-sample-hashes.json
    core.cinatoken-export.json
    core.d1.sql
    d1-verify.redacted.txt
    import-report.redacted.md
```

Commit only redacted reports. Do not commit:

- `*.cinatoken-export.json`
- generated SQL containing customer, token, channel, or secret data
- source database copies
- D1 dumps containing production rows
- provider keys, bearer tokens, OAuth secrets, payment secrets, or session keys

## Source Inventory

Before each migration wave, capture a redacted inventory from the source repo
and database:

```powershell
bun run inspect:source -- --repo C:\cinagroup\cinatoken
```

For the real source database or DSN, capture:

```text
Snapshot ID:
Source path or DSN alias:
Source application commit:
Export operator:
Export host:
Export start time:
Export end time:
Tables included:
Tables intentionally excluded:
Known source writes still open:
```

Minimum table-family inventory:

| Table Family | Wave | Cutover Rule |
| --- | --- | --- |
| `User` | Wave 0/1 | Required for token ownership, quota, role, group, deletion, and payment identity. |
| `Token` | Wave 0/1 | Required for relay auth; token keys must be handled as secrets. |
| `Channel` | Wave 0/1 | Required for provider routing; upstream keys must stay redacted. |
| `Ability` | Wave 0/1 | Required for group/model/channel mapping. |
| `Option` | Wave 0/1 | Required for billing expressions, ratios, feature flags, and limits. |
| `Model`, `Vendor`, `PrefillGroup`, `Setup` | Wave 0/2 | Required before Rust admin can own model/vendor/operator views. |
| `Log`, `QuotaData` | Wave 1/2 | Import only recent queryable windows unless archive strategy is ready. |
| `Redemption` | Wave 2/3 | D1 schema/import support exists in `0012_redemptions.sql` for admin code management; public paid redemption/top-up traffic is still blocked until payment idempotency and reconciliation are proven. |
| `TopUp` | Wave 3 | `top_ups -> topups` import and P0 reconciliation are implemented for pending/success/failed/expired, provider mapping, credited backfill, idempotent duplicate import, and user relationships. Production source snapshot, remote D1 import, webhook replay, and paid reconciliation remain blocking. |
| `SubscriptionPlan`, `SubscriptionOrder`, `UserSubscription`, `SubscriptionPreConsumeRecord` | Wave 3 | Blocked until billing/payment ownership is approved. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | Wave 4 | Local import/reconciliation is implemented with byte-exact credential/secret/hash preservation, strict datetime/boolean/count validation, soft-delete filtering for 2FA rows, and idempotent no-overwrite behavior. Production source snapshot, remote import, real-authenticator/TOTP/backup-code login, and rollback or forced-reset policy remain blocking. |
| `CustomOAuthProvider`, `UserOAuthBinding` | Wave 4 | D1 schema/import support exists in migration 0010; production traffic still requires provider secret policy evidence, redirect/SSRF checks, callback state replay checks, and account-binding smoke. |
| `Checkin` | Wave 4 | D1 schema/import support exists in `0011_checkins.sql`; decide import versus reset, preserve/verify quota awards, and smoke duplicate-submit idempotency. |
| `Midjourney`, `Task` | Wave 5 | Requires Queue/R2 task and artifact retention plan. |
| `PerfMetric` | Wave 5 | Usually start fresh in Workers observability unless historical dashboards need it. |

## Migration Waves

Use waves so production traffic can move before long-tail tables are complete.

| Wave | Scope | Required Before Import | Required Before Traffic |
| --- | --- | --- | --- |
| 0: Core dry-run | `users`, `tokens`, `channels`, `abilities`, `options`, `models`, `vendors`, `prefill_groups`, `setups` | Local schema verification and staging D1 database | Row counts, sample hashes, `/api/status`, auth rejection smoke |
| 1: Relay beta | Wave 0 plus recent logs needed for operator traceability | Billing shadow fixtures and provider smoke plan | Relay JSON/SSE smoke, quota reserve/refund smoke, cache/rate-limit smoke |
| 2: Admin core | Models, vendors, prefill groups, setup, logs, quota data | Admin API/schema and redaction tests | Operator CRUD smoke and audit log smoke |
| 3: Billing/payment | Topups, redemptions, subscriptions, pre-consume records, payment events | Billing parity runbook pass and webhook idempotency (order model + two-layer idempotency in `docs/source-payment-idempotency-parity.md`) | Paid canary with strict abort triggers |
| 4: Auth/security | Passkey, OAuth, 2FA, checkin | Byte-exact credential import/reconciliation plus an approved fallback forced re-auth/re-enroll policy (flow detail in `docs/source-oauth-2fa-passkey-parity.md`) | Imported Passkey/TOTP/backup-code auth smoke, session isolation, and support rollback plan |
| 5: Async/media | Task, Midjourney, media artifacts, perf history | Queue/R2 design, retention, DLQ, replay tests (lifecycle + CAS idempotency in `docs/source-task-lifecycle-parity.md`) | Async provider smoke and artifact cleanup evidence |

Schema parity prerequisite (2026-06-25): before Wave 0 import, resolve the
field-level defects in `docs/source-d1-schema-parity.md`. In particular
`abilities` must regain its `tag` column and `(group_name, model, channel_id)`
uniqueness (verify dedup first), `users` needs its OAuth-id lookup indexes, and
the `logs` admin-search index/strategy must be decided. The repository now
carries migrations 0001-0022, including `0004_schema_parity.sql`,
`0008_model_meta.sql`, `0010_custom_oauth.sql`, and
`0021_realtime_billing_bridge_segments.sql` and
`0022_realtime_billing_global_recovery.sql`. Apply the complete ordered
migration set to staging D1 and re-run the row/hash verification below before
treating Wave 0 as passed. Local SQLite schema replay currently succeeds with
all 22 migrations, 27 required tables, 69 incremental key columns, and 17 key
indexes; that is not a substitute for source-row reconciliation or staging D1
evidence.

Migration 0020 intentionally fails before altering the table when any 0019-era
`realtime_billing_reservations.status = 'reserved'` row exists. D1 migration
cannot reconstruct the corresponding Durable Object alarm queue. Before
applying 0020, keep Realtime settlement writes disabled, export the rows,
reconcile each reservation and quota delta against Go/VPS, refund or settle it
through an approved repair, verify the active count is zero, and archive the
redacted reconciliation evidence. Do not change a row to terminal status
without applying the matching quota correction.

Migration 0021 has the same zero-active-reservation precondition. It introduces
the bridge-segment ownership key used to prevent an old Realtime outbound bridge
from binding, settling, or refunding a replacement bridge under the same logical
session. Keep settlement writes disabled after the 0020 reconciliation, verify
the active count is still zero immediately before 0021, apply the migration,
and confirm the segment column/index plus exact migration ledger before
re-enabling a controlled staging writer. Existing active rows cannot be assigned
to a segment safely after the fact.

Migration 0022 must be applied while global recovery remains disabled. It adds
only the global scan/retry/status schema; applying it does not authorize money
movement. Verify the exact 22-file ledger and capability snapshot before the
isolated Phase 4c recovery smoke enables the gate.

## Export And Convert

For a core export:

```powershell
bun run export:sqlite -- `
  --sqlite <source-sqlite-path> `
  --output exports\YYYYMMDD-HHMM-core\core.cinatoken-export.json
```

For a reviewed full-scope export:

```powershell
bun run export:sqlite -- `
  --sqlite <source-sqlite-path> `
  --output exports\YYYYMMDD-HHMM-full\full.cinatoken-export.json `
  --all
```

Verify bundle structure and counts:

```powershell
bun run verify:migration -- `
  --input exports\YYYYMMDD-HHMM-core\core.cinatoken-export.json
```

Generate reviewable D1 SQL:

```powershell
bun run import:d1-sql -- `
  --input exports\YYYYMMDD-HHMM-core\core.cinatoken-export.json `
  --output exports\YYYYMMDD-HHMM-core\core.d1.sql
```

Validate generated SQL against local SQLite:

```powershell
bun run verify:migration -- `
  --input exports\YYYYMMDD-HHMM-core\core.cinatoken-export.json `
  --sql exports\YYYYMMDD-HHMM-core\core.d1.sql

bun run check:d1:migration-config
bun run verify:sqlite
```

Build a local D1-compatible SQLite target with the complete migration chain and
the generated import SQL, then run the deterministic P0 reconciliation gate:

```powershell
bun run reconcile:migration -- `
  --source <source-sqlite-path> `
  --target <locally-migrated-target-sqlite-path> `
  --manifest-output exports\YYYYMMDD-HHMM-core\p0-reconciliation-manifest.json
```

`reconcile:migration` is a hard gate for all 23 importable tables. The set is
defined once by `D1_IMPORT_TABLES`, and a Rust invariant test requires the
reconciliation set and every table projection to remain identical:

- core/control plane: `users`, `tokens`, `channels`, `abilities`, `options`;
- relay history and async work: `logs`, `tasks`, `midjourneys`;
- quota/payment state: `checkins`, `redemptions`, `topups`;
- subscriptions: `subscription_plans`, `subscription_orders`,
  `user_subscriptions`, `subscription_pre_consume_records`;
- model catalog: `vendors`, `models`, `prefill_groups`;
- authentication: `custom_oauth_providers`, `user_oauth_bindings`,
  `passkey_credentials`, `two_fa`, `two_fa_backup_codes`.

The versioned
`cinatoken-source-to-d1-reconciliation-v1` manifest records, per table:

- row count and logical primary-key minimum/maximum;
- a full canonical SHA-256 over rows ordered by logical primary key;
- up to 1,000 deterministic samples selected by a SHA-256 of the logical key;
- logical-key uniqueness/null checks and non-empty option keys;
- `tokens.user_id -> users.id` and
  `abilities.channel_id -> channels.id` relationship checks;
- `top_ups` string status to D1 integer mapping (`pending=0`, `success=1`,
  `failed=2`, `expired=3`), provider-domain validation, success-only
  `credited=1`, and `topups.user_id -> users.id` checks;
- log/task user, channel, and token ownership; check-in/redemption user
  ownership; subscription user/plan/subscription ownership; model/vendor
  ownership; and OAuth user/provider ownership;
- redemption credited derivation, subscription order compatibility columns,
  non-negative quota/amount/count domains, status/provider/source/reset-period
  domains, boolean domains, and declared JSON column validity;
- Passkey credential/public-key/sign-counter/flag domains, TOTP secret and
  lockout domains, backup-code hash/used-at consistency, unique user and
  credential IDs, and all auth-table user/2FA relationships. Sensitive values
  affect canonical hashes but never appear in samples or difference output.

The canonical projection mirrors import semantics: `abilities.group` maps to
`group_name`, source null/missing values use target D1 defaults where the
importer would omit them, SQLite numeric affinities are normalized, and JSON
object key order is ignored only for explicitly declared JSON configuration
columns. Opaque credentials such as token/channel keys remain byte-exact even
when their text happens to parse as JSON. Synthetic target IDs for `abilities` and
`options` are excluded in favor of their source logical keys. Sample artifacts
contain logical keys and row hashes, not token/channel secrets or raw rows.
Any count, logical-key range, full hash, sample, or relationship/integrity drift
returns a non-zero process exit and must block staging/cutover.

`quota_data`, `setups`, and `perf_metrics` remain intentionally excluded and
must be represented by the versioned exclusion/rebuild manifest. Full local
23/23 reconciliation is implementation evidence only: G2 still requires a
frozen production SQLite snapshot, reviewed import SQL, remote D1 application,
redacted manifest archival, rollback rehearsal, and owner sign-off.

Review the SQL before applying it to D1. Use `--truncate` only for a fresh
target or a deliberate overwrite with documented rollback approval.

Topup imports use `ON CONFLICT DO NOTHING` rather than replacing existing D1
orders. This protects any order already created or settled by the Rust payment
path. A conflict is not reconciliation success by itself: row counts, canonical
hashes, credited/status integrity, and webhook replay must still pass before
paid traffic moves.

## Apply To D1

Run the config and full-chain checks before either local or remote application:

```powershell
bun run check:d1:migration-config
bun run verify:sqlite
```

For a local toolchain rehearsal only:

```powershell
wrangler d1 migrations apply cinatoken-rust-db --local
```

Record the applied/total count; the 2026-07-10 local rehearsal applied 20/20.
Do not carry that result into the staging report. The staging report must come
from an authenticated remote command and identify the remote database by name
and ID.

Staging example:

```powershell
wrangler d1 migrations apply cinatoken-rust-db-staging --env staging

wrangler d1 execute cinatoken-rust-db-staging `
  --env staging `
  --file exports\YYYYMMDD-HHMM-core\core.d1.sql
```

Production example:

```powershell
wrangler d1 migrations apply cinatoken-rust-db --env production

wrangler d1 execute cinatoken-rust-db `
  --env production `
  --file exports\YYYYMMDD-HHMM-core\core.d1.sql
```

Record the exact Wrangler version, account, database name, database ID, command
output, and operator. Do not rely on a database name alone in the report; names
can be reused across environments, while IDs prove the target.

## Verification Evidence

Each import report must include:

```text
Source snapshot:
Export command:
Export SHA-256:
Generated SQL SHA-256:
Target D1 database name:
Target D1 database ID:
Wrangler version:
Migrations applied:
Rows inserted by table:
Rows skipped by table:
Rows failed by table:
Sample hash seed:
Sample hash result by table:
Known excluded columns:
Known redacted columns:
Rollback point:
Operator:
Reviewer:
```

Minimum row-count check:

| Table | Source Count | D1 Count | Difference | Accepted? |
| --- | --- | --- | --- | --- |
| `users` | TBD | TBD | TBD | TBD |
| `tokens` | TBD | TBD | TBD | TBD |
| `channels` | TBD | TBD | TBD | TBD |
| `abilities` | TBD | TBD | TBD | TBD |
| `options` | TBD | TBD | TBD | TBD |

Minimum deterministic sample hash strategy:

- Use stable primary keys, not random row order.
- Exclude volatile columns such as updated timestamps when they are rewritten by
  the importer.
- Normalize JSON field ordering before hashing.
- Redact or HMAC secret-like fields before writing evidence.
- Use the same hash seed and column list for source and target.

Recommended sample sizes:

| Table Size | Sample Rule |
| --- | --- |
| 0-100 rows | Hash every row. |
| 101-10,000 rows | Hash first 50, last 50, and 100 deterministic keyed samples. |
| More than 10,000 rows | Hash first 100, last 100, and 1,000 deterministic keyed samples. |

## Freeze And Delta Plan

For Scenario A relay-only beta, Go can remain writable if Rust uses a scoped
snapshot and selected internal/customer tokens. For broader scenarios, define a
freeze window.

Freeze checklist:

1. Announce selected table families and write window.
2. Disable or pause conflicting Go admin/payment writes for the selected scope.
3. Capture final source backup/export.
4. Import final D1 delta.
5. Verify counts and sample hashes.
6. Warm Rust token/channel/model caches.
7. Start production smoke.
8. Start canary only after data owner sign-off.

Delta reconciliation checklist:

- Identify source writes that occurred after the export start time.
- Classify each write as before-freeze, during-freeze, or after-canary.
- Replay approved source writes into D1 or reject cutover if replay is unsafe.
- For Rust writes during canary, reconcile back to Go if rollback activates.
- Record every compensating mutation with request ID, actor, table, key, old
  value hash, new value hash, and approver.

## Rollback

Rollback can be traffic-only, data-compensating, or D1 restore.

Traffic-only rollback:

1. Stop Rust traffic by Worker version, route, token group, or feature flag.
2. Keep D1 and Rust logs immutable.
3. Continue Go/VPS as source of truth.
4. Reconcile any Rust quota/log mutations if they were applied.

Data-compensating rollback:

1. Export Rust-applied mutations for the affected window.
2. Compare against Go/VPS source of truth.
3. Apply compensating Go/VPS or D1 mutations with data owner approval.
4. Preserve the original evidence bundle.

D1 restore rollback:

1. Stop all Rust writes first.
2. Confirm the D1 Time Travel or backup point.
3. Restore only after approval from release, data, and billing owners.
4. Re-run row-count and sample-hash verification.
5. Re-run staging or production internal smoke before sending traffic again.

## Go/No-Go Gates

Data migration can support customer canary only when all selected-scope rows
pass:

- source inventory recorded;
- target D1 schema and migrations applied;
- remote staging migration state captured independently of local 20/20
  evidence;
- export bundle verified;
- generated SQL reviewed;
- local P0 source-to-target reconciliation passed with the versioned manifest
  archived;
- D1 import applied to the intended environment;
- source and target row counts match or have approved differences;
- deterministic sample hashes match;
- sensitive fields are redacted in reports;
- rollback point is documented and tested for the environment;
- write authority is unambiguous;
- reconciliation owner signs off.

## Redacted Import Report Template

```text
Report:
Scenario:
Wave:
Commit:
Source snapshot:
Target environment:
Target D1 database:
Tables:
Row-count result:
Sample-hash result:
Known exclusions:
Sensitive fields checked:
Rollback point:
Smoke cases linked:
Go/no-go decision:
Approvers:
```
