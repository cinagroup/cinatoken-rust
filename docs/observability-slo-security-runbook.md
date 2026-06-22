# Observability, SLO, And Security Runbook

Date: 2026-06-22

Status: G6 production readiness runbook for observability, SLOs, alerting,
incident response, and security controls.

## Purpose

Use this runbook to prove that the Rust/Cloudflare deployment can be operated
safely before customer canary traffic moves beyond internal or tightly scoped
tokens.

This runbook supports G6 in `docs/production-migration-execution-plan.md` and
complements:

- `docs/cloudflare-production-config-checklist.md`
- `docs/staging-smoke-runbook.md`
- `docs/cutover-rollback-runbook.md`
- `docs/data-migration-runbook.md`
- `docs/billing-parity-runbook.md`

Official Cloudflare references checked on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers Logs:
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Cloudflare WAF:
  <https://developers.cloudflare.com/waf/>

Re-verify platform limits, log retention, sampling fields, and security product
settings before a production cutover. They are operational contracts, not static
application code.

## G6 Principles

- If operators cannot see a request, they cannot safely canary it.
- If a secret can appear in a log, the migration is not production-ready.
- If an alert has never been triggered in staging, it is only a hope.
- If SLO thresholds are not written before canary, promotion decisions become
  subjective.
- If rollback cannot be started from the alert context, the alert is
  incomplete.

## Worker Platform Guardrails

Record these current Cloudflare platform facts in every production readiness
review:

| Guardrail | Current Official Value Or Rule | Migration Impact |
| --- | --- | --- |
| Worker memory | 128 MB per isolate | Do not buffer unknown-size provider, file, or export payloads. |
| Worker startup | 1 second | Keep bundle size and cold-start initialization small. |
| Worker CPU | Paid plan default is 30 seconds and configurable up to 5 minutes | Relay hot path must remain lightweight; long work moves to Queue/Workflow. |
| Outgoing connections | 6 simultaneous outgoing connections per request | Avoid fan-out per relay request; keep provider calls bounded. |
| Subrequests | Paid plan allows substantially more than Free, but still bounded | Count D1, KV/R2, cache, and provider calls in load tests. |
| Workers Logs sampling | `head_sampling_rate` is configured from 0 to 1 | Staging should normally sample 1. Production sampling must be approved for cost and incident needs. |
| Workers Logs retention | Current docs list a 7 day maximum log retention period | Use Logpush or external retention for longer audit windows. |
| Workers log size | Current docs list a 256 KB maximum log size | Log compact metadata and store large payloads in R2 or redacted reports. |

## Structured Log Schema

Every relay request and sensitive admin/payment/auth mutation should emit
structured JSON metadata. Do not log raw request bodies by default.

Minimum fields:

| Field | Required For | Redaction Rule |
| --- | --- | --- |
| `request_id` | All routes | Generated or propagated ID, never a bearer token. |
| `environment` | All routes | `local`, `staging`, or `production`. |
| `route_family` | All routes | Normalized route family, not full secret-bearing URL. |
| `method` | All routes | HTTP method. |
| `status` | All routes | Worker response status. |
| `outcome` | All routes | success, rejected, upstream_error, billing_pending, timeout, aborted. |
| `user_id` | Authenticated routes | Numeric/string ID if non-sensitive, otherwise fingerprint. |
| `token_fingerprint` | Relay routes | Hash/fingerprint only; never raw token. |
| `channel_id` | Relay routes | ID is allowed; upstream key is forbidden. |
| `provider_family` | Relay routes | Normalized family. |
| `model_requested` | Relay routes | Requested model after redaction. |
| `model_upstream` | Relay routes | Mapped model after redaction. |
| `upstream_status` | Relay routes | Provider status if upstream called. |
| `upstream_request_id` | Relay routes | Header/request ID only if safe to store. |
| `latency_ms` | All routes | Wall latency. |
| `worker_cpu_ms` | Smoke/load reports | From Workers logs/metrics when available. |
| `d1_reads` / `d1_writes` | Auth/billing/admin | Counts, not raw SQL. |
| `cache_status` | Cached paths | hit, miss, bypass, error. |
| `rate_limit_decision` | Rate-limited paths | allow, deny, degraded. |
| `quota_delta` | Billing paths | Numeric delta; no raw expression request-rule body. |
| `billing_mode` | Billing paths | flat, tiered, shadow, pending. |
| `expr_hash` | Billing paths | Hash only. |
| `matched_tier` | Billing paths | Tier label/index if available. |
| `error_class` | Failures | Coarse class, not raw provider payload. |

Forbidden in logs:

- raw bearer tokens;
- upstream provider keys;
- channel key bodies;
- payment secrets;
- OAuth client secrets;
- session/JWT signing secrets;
- full provider request/response bodies containing customer data;
- request-rule expression bodies after `|||`.

## Sampling And Retention Policy

Fill before G6:

| Environment | Invocation Log Sampling | Trace Sampling | Retention Path | Owner |
| --- | --- | --- | --- | --- |
| staging | 1.0 unless cost blocks it | 1.0 for smoke windows or approved value | Workers Logs plus redacted reports | TBD |
| production internal canary | TBD, must preserve every canary request or deterministic sample | TBD | Workers Logs plus incident export | TBD |
| production broad canary | TBD based on traffic/cost | TBD | Logpush/external storage decision if longer than Workers retention | TBD |
| production steady state | TBD based on SLO/error budget | TBD | Long-term audit path for billing/payment/security events | TBD |

Evidence:

- config snippet or dashboard screenshot showing sampling;
- smoke request IDs that can be found in logs;
- one forced error that appears at error severity;
- one sampled trace or documented trace limitation;
- retention/export decision for billing and security events.

## SLO And Abort Thresholds

Set thresholds before customer canary. The starting points below are candidates
for Scenario A relay-only beta; owners must tighten or replace them after real
staging and Go/VPS baseline data exists.

| Signal | Candidate Initial Threshold | Abort If |
| --- | --- | --- |
| Rust 5xx rate | No worse than Go/VPS baseline plus 0.5 percentage points for the same route/provider window | Sustained breach for 5 minutes or any unknown 5xx spike during internal canary. |
| Upstream routing correctness | 100% correct provider family/channel family for sampled requests | Any request routes to the wrong provider family. |
| Auth rejection correctness | 100% of invalid/disabled/expired tokens rejected before upstream call | Any invalid token reaches upstream. |
| Non-stream added latency | p95 overhead under 300 ms versus Go/VPS baseline for same provider class | Sustained p95 breach without provider-side cause. |
| SSE first-byte overhead | p95 overhead under 500 ms versus Go/VPS baseline | Stream start regression impacts customers or support can reproduce. |
| Stream completion integrity | 0 unexplained truncations | Any customer-impacting truncation or response corruption. |
| D1 auth/reserve/settlement writes | 0 failed P0 writes in internal canary | Any quota-affecting write fails without safe refund/pending path. |
| Upstash availability | No data corruption; degraded mode documented | Redis failure corrupts source-of-truth state or blocks rollback. |
| Billing delta | Follow `docs/billing-parity-runbook.md` thresholds | Any unexplained positive charge delta. |
| Logs/traces | All canary requests searchable by request ID or approved sample | Logs unavailable during canary. |
| Raw secret exposure | 0 | Any raw secret appears in logs/reports. |

## Dashboard Checklist

Create or document dashboards for:

| Dashboard | Minimum Panels |
| --- | --- |
| Relay health | Request count, status classes, route family, provider family, model, p50/p95/p99 latency, stream duration. |
| Provider health | Upstream status, upstream latency, provider 429/5xx, channel ID distribution, model mapping errors. |
| D1 health | Auth read latency, reserve/write latency, write failures, overloaded/query errors, migration/import status. |
| Cache/rate limit | Upstash latency/errors, token cache hit ratio, channel cache hit ratio, rate-limit denials by token/IP/route. |
| Billing health | Reserve count, refund count, additional debit count, pending billing, shadow delta distribution. |
| Queue/R2/tasks | Queue backlog, DLQ count, retry count, artifact upload/read/delete failures. |
| Security | Auth failures, WAF/rate-limit blocks, admin mutation audit, OAuth/webhook failures, secret scan events. |
| Platform limits | CPU time, wall time, memory/limit errors, subrequests, outgoing connection failures, startup errors. |

## Alert Matrix

Every alert must include owner, query/source, threshold, first action, rollback
action, and evidence link.

| Alert | Severity | First Action | Rollback Action |
| --- | --- | --- | --- |
| Missing logs during canary | P0 | Stop promotion, verify Workers Logs config and dashboard access | Stop Rust traffic if observability cannot be restored quickly. |
| Rust 5xx above threshold | P0/P1 | Identify route/provider/channel and compare Go baseline | Roll back Worker version or traffic selection. |
| Wrong provider/channel family | P0 | Disable affected channel/group and inspect routing logs | Route selected tokens back to Go/VPS. |
| D1 quota write failure | P0 | Stop paid settlement promotion and inspect pending/refund metadata | Stop Rust billing apply and reconcile from logs. |
| Billing delta above threshold | P0 | Freeze promotion and compare expression hash/usage parser | Return to shadow mode or Go/VPS settlement. |
| Raw secret exposure | P0 | Stop affected traffic and identify secret class | Rotate secret, purge reports, and redeploy if needed. |
| Payment replay/double-credit risk | P0 | Disable Rust payment path and preserve event logs | Route payment/webhooks back to Go/VPS. |
| Queue DLQ/backlog | P1 | Pause async promotion and inspect retry cause | Keep async/task routes on Go/VPS. |
| Upstash outage | P1 | Confirm documented fail-open/fail-closed behavior | Disable cache/rate-limit dependent canary if unsafe. |
| CPU/resource limit errors | P1 | Inspect route/provider and payload class | Roll back route family or disable large-body endpoint. |

## Security Control Checklist

G6 cannot pass until each selected-scope item has evidence.

| Control | Evidence |
| --- | --- |
| Secret storage | Secret names and owners recorded; no secret values in config/docs. |
| Secret rotation | Rotation date and rollback owner for Upstash, provider, payment, OAuth, session, and admin bootstrap secrets. |
| Log redaction | Staging smoke proves raw bearer/provider/payment/OAuth/session secrets do not appear. |
| Token comparison | Security-sensitive comparisons use timing-safe or hash-first comparison where applicable. |
| WAF/rate limits | Staging/prod route policy documented and tested for abusive paths. |
| CORS | Environment-specific allowlist documented and smoke-tested. |
| SSRF | Any user-controlled URL fetch path has scheme, host, IP range, redirect, and size restrictions. |
| OAuth | State, nonce, callback origin, and replay checks are tested before auth cutover. |
| Payment webhooks | Signature verification, idempotency, and replay tests pass before payment cutover. |
| Admin audit | Sensitive admin mutations record actor, action, target, request ID, and result. |
| Data export handling | Export bundles and smoke artifacts stay outside source control. |
| Protected references | Protected project identity scan passes before commit and deploy. |

Targeted local scans:

```powershell
rg -n "sk-|Bearer |BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY|UPSTASH_REDIS_REST_TOKEN|STRIPE|GITHUB_CLIENT_SECRET|DISCORD_CLIENT_SECRET" .
rg -n "<protected-project-identity-pattern>" .
git diff --check
```

The first scan is only a quick heuristic. Use the organization's normal secret
scanner before any production deploy.

## Staging Drill

Run after Phase 7 data/D1 smoke and before canary rehearsal.

1. Send one valid relay request and record request ID.
2. Send one invalid-token request and verify no upstream call.
3. Trigger one provider error or use a controlled bad upstream key.
4. Trigger one D1 write failure simulation if feasible.
5. Trigger one rate-limit denial.
6. Confirm each event is searchable by request ID, route family, token
   fingerprint, provider family, and status.
7. Confirm no raw secrets appear in logs.
8. Confirm each configured alert can be triggered or has a documented synthetic
   test path.
9. Produce a redacted G6 report.

## G6 Go/No-Go

G6 passes only when:

- structured log schema exists and is visible in staging;
- sampling and retention policy is approved for staging and production canary;
- dashboards exist or the query set is documented well enough for incidents;
- P0 alerts have owners, thresholds, first actions, and rollback actions;
- at least one staging alert drill has been run;
- SLO and abort thresholds are written before canary;
- redaction smoke passes;
- WAF/rate-limit/CORS policy is documented for selected routes;
- secret inventory and rotation owners exist without secret values;
- protected-reference and secret scans pass;
- incident report template is ready.

## Redacted G6 Report Template

```text
Report:
Commit:
Environment:
Worker name:
Wrangler version:
Workers types version:
Sampling policy:
Dashboards/queries:
Alerts tested:
SLO thresholds:
Abort thresholds:
Security controls tested:
Secret scan result:
Protected-reference scan result:
Known deviations:
Go/no-go decision:
Approvers:
```

## Incident Note Template

```text
Incident:
Detected at:
Detected by:
Severity:
Route/provider/model:
Request IDs:
Customer impact:
Source of truth during incident:
First action:
Rollback action:
Data reconciliation needed:
Secrets rotated:
Root cause:
Restart criteria:
Owner:
```
