# Data Migration Runbook

Date: 2026-06-22

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
wrangler d1 info cinatoken-rust-db --env staging
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
| `TopUp`, `Redemption` | Wave 3 | Blocked until payment idempotency and reconciliation are proven. |
| `SubscriptionPlan`, `SubscriptionOrder`, `UserSubscription`, `SubscriptionPreConsumeRecord` | Wave 3 | Blocked until billing/payment ownership is approved. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | Wave 4 | Migrate only with secure hash/secret handling; otherwise force re-auth/reset. |
| `CustomOAuthProvider`, `UserOAuthBinding` | Wave 4 | Requires provider secret policy, redirect/SSRF checks, and state replay checks. |
| `Checkin` | Wave 4 | Decide import versus reset; quota awards must be idempotent. |
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
| 4: Auth/security | Passkey, OAuth, 2FA, checkin | Forced re-auth decision or secure migration plan (flow detail + forced re-enroll policy in `docs/source-oauth-2fa-passkey-parity.md`) | Auth/session smoke and support rollback plan |
| 5: Async/media | Task, Midjourney, media artifacts, perf history | Queue/R2 design, retention, DLQ, replay tests (lifecycle + CAS idempotency in `docs/source-task-lifecycle-parity.md`) | Async provider smoke and artifact cleanup evidence |

Schema parity prerequisite (2026-06-25): before Wave 0 import, resolve the
field-level defects in `docs/source-d1-schema-parity.md`. In particular
`abilities` must regain its `tag` column and `(group_name, model, channel_id)`
uniqueness (verify dedup first), `users` needs its OAuth-id lookup indexes, and
the `logs` admin-search index/strategy must be decided. The repository now
carries migrations 0001-0009, including `0004_schema_parity.sql`,
`0008_model_meta.sql`, and `0009_prefill_groups.sql`. Apply the complete ordered
migration set to staging D1 and re-run the row/hash verification below before
treating Wave 0 as passed. Local SQLite schema replay currently succeeds with
all 9 target tables; that is not a substitute for source-row reconciliation or
staging D1 evidence.

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

python tools\verify_sqlite.py
```

Review the SQL before applying it to D1. Use `--truncate` only for a fresh
target or a deliberate overwrite with documented rollback approval.

## Apply To D1

Staging example:

```powershell
wrangler d1 migrations apply cinatoken-rust-db --env staging

wrangler d1 execute cinatoken-rust-db `
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
- export bundle verified;
- generated SQL reviewed;
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
