# Cutover And Rollback Runbook

Date: 2026-06-22

Status: production cutover and rollback runbook for G7, G8, and G9 in
`docs/production-migration-execution-plan.md`.

## Purpose

This runbook controls the transition from Go/VPS authority to the
Rust/Cloudflare deployment. It is intentionally conservative: Rust traffic can
increase only when the previous window has observable evidence and a rehearsed
rollback path.

Read with:

- `docs/production-migration-execution-plan.md`
- `docs/production-readiness-matrices.md`
- `docs/cloudflare-production-config-checklist.md`
- `docs/route-provider-parity-runbook.md`
- `docs/data-migration-runbook.md`
- `docs/billing-parity-runbook.md`
- `docs/observability-slo-security-runbook.md`
- `docs/admin-frontend-parity-runbook.md`
- `docs/performance-capacity-cost-runbook.md`
- `docs/staging-smoke-runbook.md`
- `docs/data-export.md`
- `docs/verification.md`

## Cutover Principles

- Go/VPS remains the rollback target until the G9 decommission gate passes.
- Never cut over a write family whose source of truth is ambiguous.
- Prefer Cloudflare Worker version deployments for Worker-code canaries.
- Prefer token/group/channel routing for application-level canaries when
  billing or provider selection must be scoped by customer segment.
- Preserve Rust logs and D1 state after rollback for reconciliation.
- Do not run customer canary if logs/traces are unavailable.
- Do not enable multipart/raw upload routes before their body modes are
  implemented and live-smoked.
- Do not let Rust own paid settlement until billing shadow deltas pass.

## Roles

Fill before G7:

| Role | Person | Responsibility |
| --- | --- | --- |
| Release commander | TBD | Owns go/no-go and timeline |
| Platform operator | TBD | Worker deploy, Cloudflare routes, rollback |
| Data operator | TBD | exports, imports, D1 backup/restore, reconciliation |
| Relay operator | TBD | provider smoke, channel/model routing |
| Billing operator | TBD | quota/billing shadow and delta review |
| SRE operator | TBD | logs, traces, metrics, alerts |
| Support/comms owner | TBD | customer/operator communication |
| Security owner | TBD | secrets, redaction, WAF, incident response |

## Source Of Truth Matrix

Fill before every cutover scenario:

| Write Family | Before Canary | During Canary | After Full Cutover | Rollback Target |
| --- | --- | --- | --- | --- |
| Relay auth/token status | Go/VPS | Go or Rust per canary scope | Rust only after G8 | Go/VPS |
| User/token quota | Go/VPS | Go unless Rust billing ownership is approved | Rust after G4/G8 | Go/VPS with reconciliation |
| Channel config | Go/VPS | Go with D1 import snapshots unless admin Rust is live | Rust after G5/G8 | Go/VPS |
| Usage/audit logs | Go/VPS plus Rust shadow logs | Both, with Rust marked by environment | Rust plus archive after G8 | Preserve both |
| Payments/topups | Go/VPS | Go only until payment cutover | Rust only after G4/G5/G8 | Go/VPS with event reconciliation |
| Auth/session/OAuth/Passkey/2FA | Go/VPS | Go unless Scenario B includes auth cutover | Rust or forced re-auth | Go/VPS |
| Admin/frontend operator changes | Go/VPS | Go unless G5 report approves Rust admin | Rust after G5/G8 | Go/VPS with mutation reconciliation |
| Async tasks/files | Go/VPS | Go until Queue/R2 task cutover | Rust after G7/G8 | Go/VPS plus task reconciliation |

## Scenario Selection

| Scenario | Use When | Required Gates |
| --- | --- | --- |
| A: Relay-only beta | Move selected AI relay traffic first | G1, G2 subset, G3, G4 shadow, G6 |
| B: Relay plus admin core | Operators need Rust admin without direct D1 edits | Scenario A plus G5 |
| C: Billing and payment cutover | Rust owns balances/subscriptions/payments | Scenario B plus full G4 and payment replay tests |
| D: Full platform cutover | Go/VPS can be retired | Scenario C plus async/tasks/files/realtime plan |

Default next scenario: Scenario A.

## T-7 Days Checklist

- Pick scenario and exact scope.
- Name all roles.
- Freeze new Go/VPS features touching the selected scope.
- Confirm staging smoke report is complete and redacted summary is in
  `docs/verification.md`.
- Confirm `docs/production-readiness-matrices.md` rows for scope are `Partial`
  only because live customer canary is missing.
- Confirm route/provider body modes, live smoke status, blocked routes, and
  provider rollback choices from `docs/route-provider-parity-runbook.md`.
- Confirm production Cloudflare config checklist is complete for scope.
- Confirm data migration wave, write authority, row-count/hash strategy, and
  rollback point from `docs/data-migration-runbook.md`.
- Confirm billing mode, fixture coverage, shadow thresholds, and abort triggers
  from `docs/billing-parity-runbook.md`.
- Confirm G6 SLO thresholds, alert drill evidence, redaction evidence, and
  incident template from `docs/observability-slo-security-runbook.md`.
- For Scenario B or later, confirm frontend deploy model, auth/session
  strategy, operator CRUD scope, cache invalidation, and audit evidence from
  `docs/admin-frontend-parity-runbook.md`.
- Confirm load profiles, D1/Upstash/Queue/R2 capacity evidence, bottleneck
  owners, and current/2x/5x cost forecast from
  `docs/performance-capacity-cost-runbook.md`.
- Define SLOs and abort thresholds.
- Define customer/internal token group for canary.
- Confirm rollback can stop Rust traffic without data loss.
- Confirm production D1 backup/export strategy.
- Confirm provider spend limits and rate limits for canary keys.
- Confirm support/comms plan.

## T-3 Days Checklist

- Re-run local verification:

```powershell
bun run check
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
git diff --check
```

- Re-run staging smoke for every route family in scope.
- Produce or refresh the redacted G3 route/provider report for the selected
  scope.
- Capture source export or backup rehearsal for scope.
- Produce or refresh the redacted data migration report for the selected scope.
- Produce or refresh the redacted billing parity/shadow report for the selected
  scope.
- Produce or refresh the redacted G6 observability/SLO/security report for the
  selected scope.
- Produce or refresh the redacted G5 admin/frontend/auth report for Scenario B
  or later.
- Produce or refresh the redacted performance/capacity/cost report for the
  selected scope.
- Rehearse rollback in staging.
- Verify Cloudflare logs/traces/metrics and alert paths.
- Verify no raw secrets appear in logs.
- Verify admin can disable a bad token/channel or route through the approved
  source-of-truth system for the scenario.
- Record known deviations and owner approval.

## T-1 Day Checklist

- Announce freeze window.
- Stop non-essential config changes on Go/VPS and Rust.
- Capture final source inventory for selected scope.
- Confirm production secrets and resource IDs.
- Confirm current Go/VPS version and rollback access.
- Confirm Rust Worker version ID or deployment ID.
- Confirm previous stable Rust Worker version ID if using Worker rollback.
- Confirm D1 backup/export path and retention.
- Confirm Support knows customer impact and abort language.

## T-0 Cutover Checklist

1. Confirm go/no-go from every role.
2. Capture final Go/VPS source backup/export for selected scope.
3. Apply final D1 migration/import for selected scope.
4. Verify row counts and sample hashes for selected table families.
5. Confirm billing shadow/apply mode and abort thresholds.
6. Warm caches for selected token/channel/model groups where applicable.
7. Upload Worker version without sending customer traffic, if using Cloudflare
   version deployments.
8. Run production smoke against internal tokens.
9. Start canary.
10. Watch logs/traces/metrics continuously during the observation window.
11. Record every promotion decision with timestamp, metrics, and approver.

## Cloudflare Worker Version Canary

(Revised 2026-06-25) Worker gradual deployments are the primary canary control
(version-percentage split with instant version rollback); business-scoped gating
(token/user group, route family) is the secondary control for who is exposed.
See `docs/cinatoken-rust-migration-plan.md` §21.7. Use this section when canary
is based on Worker code version.

Create a version without deploying traffic:

```powershell
wrangler versions upload --env production
```

Create or adjust split deployment (assign the percentage of traffic to the new
version vs the previous stable version):

```powershell
wrangler versions deploy --env production
```

Recommended traffic windows:

| Window | Rust Target | Minimum Observation |
| --- | --- | --- |
| Internal | Internal tokens only | One successful smoke pass |
| 1% | 1% low-risk traffic | 30-60 minutes |
| 5% | 5% low-risk traffic | 1-2 hours |
| 25% | 25% selected traffic | One business cycle or agreed load window |
| 50% | 50% selected traffic | One clean SLO window |
| 100% | Full selected scope | Approved by all roles |

If using Cloudflare Dashboard instead of Wrangler, record the version IDs,
traffic percentages, operator, and screenshots in the smoke report.

## Application-Level Canary

Use when canary must be scoped by token, channel, group, model, or provider.

Options:

- selected internal tokens;
- selected low-risk token group;
- selected provider/channel family;
- selected model family;
- selected route family;
- selected custom domain or route.

Required evidence:

- exact selection rule;
- how traffic is stopped;
- how affected quota/payment/log rows are identified;
- how Rust and Go logs are correlated;
- how support identifies impacted customers.

## Promotion Checks

Before increasing traffic:

- Rust 5xx is within threshold.
- Upstream 4xx/5xx does not exceed Go/VPS baseline for the same provider.
- p95 latency overhead is within threshold.
- SSE first-byte overhead is within threshold.
- Logs/traces and G6 alert sources remain available for the canary window.
- D1 auth/reserve/settlement writes are healthy.
- Upstash failures are within threshold.
- Worker CPU/memory/resource-limit errors are absent for the selected scope.
- D1 hot-path row reads and query durations stay within approved thresholds.
- Cost forecast remains approved for current traffic and the next promotion
  window.
- Billing shadow or applied deltas are within threshold.
- No raw secrets in logs.
- No unhandled queue/DLQ backlog for enabled async paths.
- Support has no unresolved canary-impacting incidents.

## Abort Triggers

Abort immediately on:

- quota or balance corruption;
- payment double-credit or missed-credit;
- wrong provider/channel family routing;
- D1 write failures on auth/reserve/settlement;
- repeated Worker exceptions or 5xx above threshold;
- missing logs/traces during canary;
- raw secret exposure;
- unexplained billing delta above threshold;
- customer-impacting stream truncation or response corruption;
- inability to revoke or stop affected traffic quickly.

## Rollback Paths

### Worker Version Rollback

Use for code/config regressions where data remains reconcilable.

```powershell
wrangler rollback --env production
```

If specifying a version directly, record the version ID and command output.
Cloudflare currently limits rollback selection to recent published versions, so
record the previous stable version before cutover.

### Traffic Stop Rollback

Use when canary is controlled by route, DNS, token group, feature flag, or
application routing.

1. Set Rust traffic to 0% or remove the Rust route.
2. Route selected tokens/groups back to Go/VPS.
3. Disable new Rust Realtime admission, but keep the 0020-aware Realtime DO
   deployment, `REALTIME_SESSIONS`, and D1 binding available for recovery.
4. Wait until D1 has zero `reserved` Realtime reservations and both persisted
   lease/retry queues report zero records. Archive every terminal/refund
   mutation and reconcile its quota delta.
5. Disable the remaining Rust-specific canary flags and make D1/log state
   immutable only after recovery ownership is empty.
6. Start final reconciliation.

### Data Rollback

Use when Rust applied writes during canary.

1. Stop new Rust traffic.
2. Export Rust-applied mutations for the affected window.
3. Compare against Go/VPS source of truth.
4. Apply compensating Go/VPS mutations or D1 rollback only after data owner
   approval.
5. Preserve the original Rust D1 state for audit until reconciliation closes.

### Ordinary HTTP Billing Rollback Order

Use this order for any pre-bind owner, Queue, or recovery anomaly:

1. Set `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED=false`, then disable reconcile
   and Queue finalization before changing traffic.
2. Stop new Rust relay admission and return the selected scope to Go/VPS. Keep
   the Rust Worker and D1/Queue bindings available for observation.
3. Drain primary Queue, DLQ, parking, `reserved`, and `recovery_required`
   records under one named owner. Record the highest generation and terminal
   disposition for every reservation.
4. Never downgrade, reset, or reuse `owner_generation`; never emit schema-v1
   Queue messages for generation-2 reservations. Resolve ambiguity by exact
   frozen-state readback, not by replay with new pricing.
5. Reconcile provider calls, user/token/channel quota, request count, billing
   and manage audits, incident ledger, and Queue attempts. Compensate only after
   data-owner approval.
6. Retain migration 0026 and all evidence. Do not drop fencing columns during
   an incident. A code rollback must understand the schema or remain inactive.

Settlement owns through `lease_expires_at + 300` inclusive; automated recovery
owns only from `lease_expires_at + 301`. Any boundary violation or unexplained
generation jump is an immediate G3/G4 abort.

### Secret Rollback

Use if any secret may have leaked.

1. Stop affected traffic.
2. Rotate affected upstream/payment/OAuth/session secret.
3. Update Cloudflare secret.
4. Redeploy or confirm runtime secret refresh behavior.
5. Search logs/reports for additional exposure.

## Reconciliation Checklist

After any rollback:

- identify affected request IDs;
- identify affected users/tokens/channels;
- identify Rust quota deltas;
- identify Go/VPS quota deltas;
- compare payment events if any;
- compare logs and usage records;
- refund or add quota if needed;
- record root cause;
- record whether canary can restart.

## Full Cutover Checklist

Do not execute until G8 passes.

1. Freeze selected Go/VPS writes.
2. Capture final source backup/export and checksum.
3. Apply final delta import to production D1.
4. Verify row counts and sample hashes.
5. Warm token/channel/model caches.
6. Set Rust route/version to 100% for selected scope.
7. Run production smoke on internal and customer-like tokens.
8. Monitor SLOs continuously for the agreed window.
9. Keep Go/VPS hot and ready for rollback until G9.

## Post-Cutover Window

For the agreed stability window:

- keep Go/VPS online but do not accept selected-scope writes unless rollback is
  activated;
- compare daily quota and billing aggregates;
- review provider/channel error rates;
- review cost and Worker/D1/Upstash usage;
- keep support watch active;
- write daily status notes.

## G9 Decommission Checklist

Only after stability window passes:

- archive Go/VPS backup/export and migration reports;
- verify no traffic reaches Go/VPS for migrated scope;
- rotate secrets no longer needed by Go/VPS;
- remove temporary compatibility shims only after a documented grace period;
- update `docs/production-readiness-matrices.md` rows to `Done` where evidence
  exists;
- create a post-cutover audit summary.
