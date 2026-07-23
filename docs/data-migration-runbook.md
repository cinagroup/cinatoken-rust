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
23-file sequence from `0001_core.sql` through
`0023_relay_billing_reservations.sql`. The SQLite verifier applies all 23
migrations by default and requires 29 target tables. A real local Wrangler D1
apply completed through 0020 on 2026-07-10 and must be refreshed through 0023.

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
carries migrations 0001-0023, including `0004_schema_parity.sql`,
`0008_model_meta.sql`, `0010_custom_oauth.sql`, and
`0021_realtime_billing_bridge_segments.sql`,
`0022_realtime_billing_global_recovery.sql`, and
`0023_relay_billing_reservations.sql`. Apply the complete ordered
migration set to staging D1 and re-run the row/hash verification below before
treating Wave 0 as passed. Local SQLite schema replay currently succeeds with
all 23 migrations, 29 required tables, 105 incremental key columns, and 20 key
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
movement. Verify the exact 23-file ledger and capability snapshot before the
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

## 2026-07-15 Task Poll Lease Schema And Active-Row Runbook

This current-head overlay applies to migrations 0034/0035 and does not alter
historical import reports. These migrations change ownership metadata, not the
source business payload. Existing `tasks` and `midjourneys` rows receive empty
owner, generation zero, expiry zero, applied generation zero, and write
revision zero through column defaults.

### Pre-migration inventory

Record separately for video, Suno, and Midjourney:

- terminal and nonterminal row counts;
- rows with missing upstream task IDs;
- rows older than each timeout boundary;
- duplicate provider operation/task IDs within and across users/channels;
- active Go/Worker/TaskRunner writers and their versions;
- unresolved submit-unknown and provider-accepted operations;
- D1 backup/Time Travel point, migration ledger, and deterministic sample
  hashes before schema expansion.

Duplicate provider operation identity is a report-and-block condition. The
lease schema does not add provider-operation uniqueness and must not silently
deduplicate or choose a winner.

### Schema application

1. Keep Go/VPS authoritative and all Rust task poll authority off.
2. Apply 0034 and 0035. Do not modify the singleton control defaults.
3. Verify every pre-existing row has a valid zero-generation/no-owner shape;
   verify terminal status, progress, provider ID, quota, reservation linkage,
   and row counts are unchanged.
4. Verify the two due indexes and four triggers by object name and SQL shape.
5. Verify 0033-compatible lifecycle writes still work while enforcement is
   zero, and malformed lease transitions fail under the active shape guards.
6. Re-run deterministic hashes excluding only the newly added ownership
   columns, then record those columns separately.

Wrangler may apply all pending migrations. Archive the remote ledger after the
command; do not infer 0035 presence from a local file or deployment commit.

### Active-row cutover

Do not copy a transient in-memory poll owner from Go into D1. Active imported
rows begin unclaimed. Before Rust receives authority, stop old polling and
TaskRunner arming, wait for in-flight provider work, and reconcile every
accepted provider operation. Then enable D1 authority, D1 enforcement, and env
authority in that order. Timeout settlement also claims and therefore must not
run during the overlap window.

Normal video, Suno, and Midjourney scans are separate, but imported rows still
need family classification validation. Reject or quarantine an empty/unknown
platform that would enter the wrong video/Suno query. Suno rows must never
create video TaskRunner state.

### Rollback and reconciliation

1. Disable recovery, scheduler, env authority, and TaskRunner arming in that
   order.
2. Disable D1 authority.
3. Disable D1 enforcement.
4. Wait for lease expiry or clear only with matching owner and generation.
5. Reconcile local Task/Midjourney state, provider console/API state, wallet,
   token, channel, request counts, audits, and invoice deltas.
6. Resume only a 0033-compatible writer. Keep 0034/0035 schema and all
   generations; never downgrade or reset them to make an old poller fit.

Data migration approval does not close scheduling design. Migration 0036 now
provides the local persisted shape and runtime fairness/backoff/quarantine is
implemented locally. Provider-operation uniqueness/idempotency lookup, remote
whole-operation deadline/abort evidence, fault injection, and the 0037 recovery
campaign remain required before customer cutover.

## 0036 Schedule-State Migration Runbook

0036 is an additive expand after 0034/0035. It does not authorize a poller.
Keep Go/VPS authoritative and all Rust scheduler/lease/TaskRunner gates false
while applying and validating it.

### Preflight and apply

1. Confirm the target database identity and a restorable point. Archive the
   ordered migration ledger, active writer inventory, terminal/nonterminal
   counts by family, duplicate provider operation IDs, and deterministic hashes
   of business columns.
2. Stop if 0034/0035 are absent, out of order, partially applied, or their
   singleton control row is not `(authority_enabled=0,
   enforcement_enabled=0)` for a schema-only rollout.
3. Apply 0036 once. Do not edit its migration ledger row, re-run individual
   `ALTER TABLE` statements, or treat a local file as remote proof.
4. Verify both tables gained exactly the seven schedule columns; verify
   `idx_tasks_poll_schedule_due`, `idx_midjourneys_poll_schedule_due`, and the
   five exact `task_poll_family_cursors` keys.
5. For pre-existing rows, require numeric schedule fields to be zero and error
   and quarantine reasons empty immediately after migration. Recompute hashes
   excluding only the new fields and require unchanged status, progress,
   provider identity, reservation, quota, timestamps, and row counts.

`poll_attempt_count=0` is a cutover baseline, not reconstructed historical
truth. Cursor generation zero is a seed, not fairness evidence.

### Active-row scheduling

Every eligible pre-existing row has `next_poll_at=0` and would be immediately
due if the scheduler were enabled. Therefore:

1. Inventory and classify all nonterminal rows into video, Suno, Midjourney,
   Task timeout, and Midjourney timeout views. Block unknown/ambiguous family or
   duplicate provider identity; do not guess.
2. Reconcile provider-accepted operations and identify deterministic poison.
   Quarantine poison with a stable redacted reason, without terminal or
   financial mutation.
3. Select a bounded staging canary, remove it from legacy polling, and assign
   reviewed due times in small readback-verified batches. Hold or exclude all
   other active rows so zero defaults cannot create a poll storm.
4. Advance a family cursor only as part of a successfully persisted bounded
   scan checkpoint. On ambiguous response, read D1 canonically; never jump or
   rewind a cursor speculatively.
5. Only after 0034/0035 lease authority and enforcement are active and verified
   may the isolated scheduler gate be enabled.

### Rollback and retention

Disable recovery first, then scheduler and DO wake-ups, reconcile accepted
provider work, and wait for lease fencing before resuming another poller. Do
not down-migrate 0036,
zero lifetime attempts/failures, clear quarantine in bulk, delete cursor rows,
or overwrite due times from an old snapshot. Scheduler-only rollback may use a
0035-aware Worker with 0036 retained. Full lease rollback follows env off -> D1
authority off -> D1 enforcement off -> lease drain -> 0033-compatible Worker.
Reconcile every quarantine before Go/VPS sees the row.

## 0037 Recovery-Event Migration Runbook

0037 is additive and default-inert. It adds recovery objects around existing
0036 quarantine state; it does not repair, clear, or reclassify an existing
row. Apply it with recovery, scheduler, lease env authority, and TaskRunner
disabled.

### Preflight

1. Verify the target D1 identity, restore point, ordered 0034/0035/0036 ledger,
   active writers, and candidate/config/migration hashes.
2. Inventory Task and Midjourney quarantines by redacted entity ID, family,
   generation, revision, timestamp, reason, timeout eligibility, and provider
   identity hash. Do not export provider IDs or credentials.
3. Identify duplicate provider operations, near/expired hard timeouts, active
   leases, unresolved accepted submits, and rows that a legacy Go poller would
   process if quarantine were ignored. Any ambiguity is a stop condition.
4. Record business row counts and deterministic hashes. The verified local
   schema acceptance is 37 migrations, 35 tables, 241 checked incremental
   columns, and 42 key indexes; remote readback is independent evidence.

### Apply and validate

1. Apply 0037 once. Do not hand-run its statements or rewrite the migration
   ledger.
2. Read back `task_poll_recovery_events`, the entity lookup index, unique
   entity/revision index, both exact partial quarantine indexes, and all six
   immutable/guard/apply triggers.
3. Verify all four digest/token columns reject wrong length, uppercase, and
   non-hex values. Verify update/delete of a recovery event fails.
4. Verify both indexes use `(poll_quarantined_at, id)`. The Task predicate must
   be exactly `poll_quarantined_at > 0 AND status NOT IN ('SUCCESS', 'FAILURE')
   AND upstream_task_id != ''`; the Midjourney predicate must replace only the
   final identity clause with `mj_id != ''`. Reject a broad, different-key, or
   non-partial replacement.
5. Recompute business hashes and counts. Existing status, progress, provider
   identity, schedule, quarantine, quota, reservation, and cursor state must be
   unchanged.

### Active-row disposition

Do not bulk-requeue existing quarantines after migration. For an isolated row:

1. repair or verify the external cause and collect a bounded evidence
   reference;
2. require root queue/preview, fresh step-up apply, exact preview and revision,
   confirmation, approved reason, and unique idempotency key;
3. require enough hard-timeout headroom: more than the greater of 60 seconds
   and the poll lease;
4. commit one immutable event plus root audit and requeue atomically;
5. reconcile canonical readback before retrying any 503 or ambiguous response;
6. treat a 409 as stale/conflicting state requiring a fresh preview, never as a
   reason to force the row;
7. let TaskRunner rearm only best-effort after a first Task apply; cron must
   discover the row when the DO path fails.

### Rollback

1. Set recovery false, then scheduler and TaskRunner false, then lease env
   authority false.
2. Disable D1 authority and D1 enforcement only after new work has stopped.
3. Drain fenced leases and reconcile provider, billing, request/channel, audit,
   event, and invoice state. Keep 0037 and immutable events in place.
4. Before Go/VPS resumes, resolve each quarantine, retain it under an approved
   hold, or exclude it from legacy polling. Never delete an event, reset a
   revision/generation, or clear quarantine in bulk to fit the old poller.

Provider-operation uniqueness/native idempotency, whole-submit operation
deadlines, remote D1/staging/provider/TaskRunner hot-path proof, WFP namespace
upload/readback, paid canary, alerts/load, and signed rollback remain hard
blockers. Production remains **NO-GO**.

## 0038/0039 Task Submit Operation Migration Runbook

0038 is an expand migration and 0039 is its writer-enforcement boundary. They
must not be applied as one unobserved step in production.

### Preflight

1. Verify the exact D1 target, restore point, migration ledger through 0037,
   active Worker versions, Queue/cron/alarm deliveries, Go/VPS task writers,
   and provider invoice watermark.
2. Inventory active Task/Midjourney intents by redacted status, submit state,
   creation time, provider/channel digest, and attachment state. Stop on a
   duplicate provider operation or unresolved accepted create.
3. Record deterministic business counts/hashes and the number of newly created
   rows with missing client digests or deadline. Do not export raw provider IDs,
   caller idempotency keys, requests, credentials, or billing contracts.

### Expand and dual write

1. Apply only 0038. Read back all three columns,
   `idx_task_billing_intents_client_operation`,
   `idx_task_billing_intents_provider_operation`, and
   `idx_task_billing_intents_submit_deadline` with exact SQL and uniqueness.
2. Prove a 0037-era writer can still insert a zero-value row and the new writer
   inserts two lowercase SHA-256 digests plus a deadline 5..120 seconds after
   creation and before lease expiry.
3. Deploy the new candidate with Rust task traffic disabled or an isolated
   cohort. Keep client-key requirement, reconciliation mutation, scheduler,
   TaskRunner, and every staging/cutover proof false.
4. Observe beyond the maximum old isolate, request, Queue, cron, alarm, and
   deployment lifetime. Stop unless every new candidate row is fully populated
   and the count of newly created zero-value rows remains zero.

### Enforce and validate

1. Drain and remove every old writer, then apply 0039 once. Do not hand-edit the
   migration ledger or rewrite historical zero-value rows.
2. Verify the insert and immutable triggers. Wrong length, uppercase, non-hex,
   missing digest, deadline below 5 seconds, deadline above 120 seconds,
   deadline past lease, or later identity/deadline mutation must fail.
3. Verify historical rows retain zero values and remain recoverable through the
   legacy lease branch. Verify the new deadline sweep uses the deadline index
   while the legacy branch uses the lease index.
4. Retry the same token/task/key and request: one intent and no second provider
   call. Change route/model/body under the same key: conflict and no provider
   call. Use a different token: no cross-token disclosure or replay.
5. Inject timeout, redirect, 408/409/425/429/5xx, oversized response,
   unclassified response, and post-accept attachment failure. Require a stable
   202 status handle, retained reserve, and canonical owner-token query.

### Rollback

Disable required-key admission and Rust task traffic first, then reconciliation
mutation, TaskRunner, scheduler, recovery, and lease authority as appropriate.
Retain 0038/0039 and deploy only a 0039-compatible Worker. Reconcile all
`submitting`, `submit_unknown`, and accepted-but-unattached rows against the
provider and invoice before Go/VPS creates or polls overlapping work. Never
drop the indexes/triggers, backfill guessed keys, reuse a caller key, or return
to an old writer. Production remains **NO-GO**.

## 0056 Ordinary HTTP SSE Handoff Migration Runbook

0056 is an expand-only operational ownership migration, not a business-data
import. It must be applied reader-first with all four HTTP stream handoff gates
false. Its historical checkpoint is 56 migrations, 64 tables, 814 checked
incremental columns, and 94 key indexes; the 0057 runbook below defines the
current target.

### Preflight

1. Revoke the exposed Cloudflare credential and use approved replacement
   deploy/readback identities without placing values in arguments or evidence.
2. Freeze target database, backup/Time Travel point, exact migration ledger,
   active Worker versions, Queue consumers, scheduled handlers, provider call
   watermark, business fingerprint, and rollback artifact.
3. Prove every old writer and active paid SSE operation is drained. Confirm
   producer, staging approval, outbox, and recovery flags are exact false.

### Apply and read back

1. Apply `0056_relay_http_stream_handoffs.sql` once. Do not hand-run statements
   or edit the migration ledger.
2. Read back both tables, three indexes, eleven triggers, exact SQL, migration
   count/head, normalized schema digest, and unchanged business fingerprint.
3. Run negative probes for identity mutation, usage regression, finalization
   event replacement, terminal without exact receipt, receipt update/delete,
   and handoff delete. Remove only synthetic nonterminal fixtures through the
   pre-approved test database reset, never by bypassing production triggers.
4. Deploy only a 0056-compatible reader while all gates remain false. Observe
   beyond the maximum old isolate, Queue, cron, and deployment lifetime.

### Drain-only and producer canary

Use synthetic staging data only. Producer remains false while staging approval,
outbox, and recovery prove lease/retry/dead-letter/receipt convergence. A later
producer canary requires separate approval, no customer traffic, a provider
call counter, and the complete fault matrix in
`docs/relay-http-stream-durable-handoff.md`.

### Rollback

Disable producer first, route the cohort to hot Go/VPS, and keep approved drain
gates on until every existing row is terminal or explicitly reviewed. Retain
0056, handoff rows, receipts, audit events, Queue/DLQ evidence, and billing/
provider reconciliation. Never down-migrate, delete receipts, replace a staged
event, or resend an ambiguous provider operation. Production remains **NO-GO**.

## 0057 HTTP SSE Dispatch Intent Migration Runbook

0057 is an expand-only ownership migration layered on 0056. It adds one table,
two indexes, ten triggers, and `relay_http_stream_handoffs.dispatch_hard_deadline_at`.
The exact target is 57 migrations, 65 tables, 841 checked incremental columns,
and 96 key indexes.

### Compatibility preflight

1. Keep all four SSE gates exact false and drain every 0056 producer plus every
   active paid SSE operation. N-1 may remain deployed only as a reader.
2. Freeze the D1 target, Time Travel/backup point, migration ledger, business
   fingerprint, Worker versions, Queue/DLQ, cron, provider-call watermark, and
   hot Go/VPS rollback route.
3. Stop if any active binary can create a 0056 handoff. After 0057, such an
   insert requires a matching 0057 `response_received` row and old producer
   code is deliberately incompatible.
4. Revoke the exposed credential. Provision deploy and readback identities
   through the approved secret workflow without argv, file, log, or evidence
   disclosure.

### Apply and exact readback

1. Apply `0057_relay_http_stream_dispatch_intents.sql` once through the normal
   ordered migration runner; never hand-edit `d1_migrations`.
2. Read back migration head/count, normalized schema digest, one new table, two
   new indexes, ten new triggers, and the nonnegative immutable handoff hard
   deadline column. Verify the business fingerprint is unchanged.
3. Prove invalid initial state, malformed digest/identity, identity/deadline
   mutation, illegal lifecycle edge, unbound handoff insert, dispatch delete,
   and partial recovery all fail.
4. Prove a valid `prepared -> dispatched -> response_received` row plus exact
   0056 insert becomes `stream_bound` atomically. Prove
   `prepared|dispatched|response_received -> recovery_required` advances the
   billing reservation to recovery with the next owner generation atomically.
5. Deploy the N reader with all gates false and observe beyond the maximum old
   Worker, Queue, cron, and deployment lifetime. Any unexpected intent/handoff,
   provider call, or financial delta aborts the candidate.

### Drain rehearsal and canary

Seed only bounded synthetic staging rows. With producer false, enable staging
approval plus recovery/outbox to prove expired-intent sweep and 0056 outbox/
receipt drain, then restore all flags to false. A later no-customer producer
canary must prove exactly one dispatch CAS grant and provider call, no
retry/fallback, atomic 0056/0057 promotion before the first client byte,
bounded headers/hard deadline, and one terminal or explicit recovery owner.

### Rollback

Disable producer first, route new traffic to Go/VPS, and retain the N drain
worker until all 0057 intents, 0056 handoffs, outbox leases, receipts, billing
reservations, and provider counters reconcile. Never re-enable an N-1 durable
producer, down-migrate 0057, clear a dispatch row, rewrite a hard deadline, or
resend an ambiguous provider operation. Production remains **NO-GO**.

## 0058 HTTP SSE Client-Abort Watchdog Migration Runbook

0058 is an expand-only evidence migration layered on 0056/0057. The exact
target is 58 migrations, 66 tables, 848 checked incremental columns, and 97
key indexes. It adds one table, one index, five triggers, and no business-data
column.

### Compatibility preflight

1. Keep all four SSE gates false. Drain every old durable SSE producer and
   active paid SSE operation; N-1 may remain only as a reader.
2. Freeze the D1 backup/Time Travel point, normalized catalog and business
   fingerprint, N/N-1 Worker versions, Queue/DLQ, cron, provider watermark,
   hot Go/VPS route, and rollback owner.
3. Require N to carry `enable_request_signal` and to check 0058 before provider
   I/O. Stop if any active producer can create a 0056 handoff without 0058.
4. Prove the exposed credential revoked and use separately approved
   least-privilege deploy/readback identities without secret-bearing argv,
   files, logs, or evidence.

### Apply and exact readback

1. Apply `0058_relay_http_stream_client_abort_watchdogs.sql` once through the
   ordered migration runner; never hand-edit `d1_migrations`.
2. Read back head/count 0058/58, 66/848/97 totals, the exact seven columns, one
   index, five triggers, normalized schema digest, and unchanged business
   fingerprint.
3. Reject partial schema, duplicate DDL, invalid handoff identity, stale owner
   or attempt, mutable/delete evidence, body/header/frame/credential fields,
   and any provider or financial side effect during expand.
4. Prove abort-first atomically yields `recovery_required/client_disconnected`
   and blocks provider terminal overwrite. Prove terminal-first remains staged
   or terminal when the append-only abort event arrives.
5. Deploy N as reader/drain owner with producer false and observe beyond the
   maximum N-1, Queue, cron, and deployment lifetime before any canary.

### Rollback

Disable producer first and retain N for drain. Route new traffic to hot Go/VPS;
retain 0056/0057/0058, every abort event, handoff, receipt, billing row, audit
and provider counter. Never down-migrate, delete or rewrite abort evidence,
re-enable an N-1 producer, refund an ambiguous reservation automatically, or
resend its provider operation. Production remains **NO-GO**.

## 0059 Ring Transition Claim Ledger Migration Runbook

0059 is an expand-only control-plane evidence migration after 0058. The exact
local target is 59 migrations, 68 required tables, 899 checked incremental
columns, and 100 key indexes. It adds no customer, provider, billing, task, or
relay payload column.

### Compatibility preflight

1. Keep every ring-transition and SSE mutation gate false. Go/VPS remains
   traffic and scheduler authority.
2. Revoke the exposed credential and retain independent revocation evidence.
   Do not create or use replacement write credentials before review.
3. Freeze the D1 backup/Time Travel point, normalized catalog, business
   fingerprint, old/new Worker version candidates, runner release identity,
   claim-authority identity, rollback owner, and provider/financial counters.
4. Require all pre-0059 binaries to be reader-only for the affected staging
   control path. No executable runner or general D1-write claim token is
   permitted.

### Apply and exact readback

1. Apply `0059_relay_container_ring_transition_claims.sql` once through the
   ordered migration runner; never hand-edit migration history.
2. Read back 0059/59, 68/899/100, both exact tables, three named indexes, seven
   claim/step triggers, normalized schema digest, and unchanged business
   fingerprint.
3. Prove duplicate authorization ID, duplicate nonce, concurrent active scope,
   replayed digest, wrong owner, skipped state, expired pre-write action,
   identity mutation, evidence mutation/deletion, and duplicate DDL all fail.
4. Prove Controller/Edge intent persistence precedes each simulated write and
   an ambiguous post-write observation becomes immutable
   `recovery_required`, never a retry.
5. Deploy only 0059-aware readers with execution disabled. Observe longer than
   the maximum old Worker/deployment lifetime and require zero claim/step rows,
   provider calls, financial changes, customer traffic, and unexplained wake.

### Rollback

Disable the unpublished runner/claim authority first and retain 0059. Claims
and steps are audit evidence and are never down-migrated, deleted, rewritten,
or reused. If a mutation was attempted, preserve the dual-ring Controller and
Go/VPS traffic authority, classify by authenticated readback, and repair
forward under a new authorization. Production remains **NO-GO**.
