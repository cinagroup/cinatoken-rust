# Production Migration Execution Plan

Date: 2026-06-22

Status: production execution source of truth. Update this file whenever a gate,
workstream status, or rollout decision changes.

## Purpose

This plan turns the original migration plan and production audit into an
operational execution checklist for moving the Go/VPS deployment of
`github:cinagroup/cinatoken` to the Rust/Cloudflare deployment in
`cinatoken-rust`.

Read this file with:

- `docs/cinatoken-rust-migration-plan.md` for the original target architecture.
- `docs/production-migration-plan-audit.md` for risk findings and phase intent.
- `docs/verification.md` for verified local and staging evidence.
- `docs/phase-1.md` for current implementation status.

This file is deliberately gate-driven: production cutover is allowed only when
the required evidence exists, not when implementation "looks close".

## Current Baseline

Completed or substantially implemented:

- Rust workspace and Cloudflare Worker MVP.
- D1 core schema, migration CLI, repository boundary, token auth, channel
  selection, model mapping, audit logging, Upstash-backed rate limiting, and
  read-through token/channel cache.
- OpenAI-compatible JSON relay families for chat/completions/responses,
  completions, embeddings, image generations, audio speech, Jina/Cohere rerank,
  native Anthropic Messages, and native Gemini generate/embed/count-token
  routes.
- Streaming passthrough for the main SSE relay routes with audit work moved to
  `wait_until` where a Worker `Context` is available.
- Tiered billing expression foundations, request-rule splitting, frozen
  preflight snapshots, reserve/refund/delta settlement, and growing Go/Rust
  golden parity coverage.
- Bounded JSON request-body reads, bounded non-stream JSON response reads, and
  explicit inactive request body modes for multipart/raw/stream endpoints.

Current production blockers:

- Real staging/prod Cloudflare resources and binding IDs are not configured in
  the repository.
- Live Worker, D1, Upstash, and upstream provider smoke tests are still
  missing.
- Multipart/raw/pass-through request body forwarding is not implemented, so
  file upload style endpoints must remain blocked.
- Queue, R2, KV, Pages, admin APIs, payments, subscriptions, async tasks,
  OAuth/Passkey/2FA, and full frontend migration remain incomplete.
- Billing expression parity is not yet broad enough for full production
  settlement ownership.

## Best-Practice Anchors

Cloudflare references were refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>

Production rules for this migration:

- Keep the Worker hot path small: auth, routing, quota reservation, relay,
  settlement, and minimal audit metadata.
- Stream unknown-size request and response bodies. Buffer only when an
  endpoint-specific limit is documented and enforced.
- Use `wait_until` for non-critical audit/settlement side work only when the
  customer response can safely proceed.
- Keep D1 as the source of truth for core relational state, not as the only
  high-volume event sink.
- Use Upstash Redis for hot counters, caches, locks, and short TTL state.
- Use Queues for high-volume logs, async task writes, and retryable background
  work.
- Use R2 for large audit payloads, generated files, task artifacts, and
  export/import archives.
- Store secrets with Wrangler/Cloudflare secret facilities, never in committed
  config or docs.
- Run generated Worker binding type updates after every binding change.
- Make every production change reversible with a rehearsed rollback path.

## Production Gates

| Gate | Name | Opens When | Required Evidence | Blocks |
| --- | --- | --- | --- | --- |
| G0 | Scope and inventory freeze | Go source, DB, routes, providers, env, and secrets are inventoried | Route matrix, table matrix, provider matrix, secret inventory without values | Any production deployment planning |
| G1 | Cloudflare staging foundation | Staging Worker has real D1/KV/R2/Queue/Upstash/provider bindings | `wrangler deploy --env staging`, `/api/status`, generated binding types, logs visible | Live smoke and canary |
| G2 | Data dry run | D1 migrations cover production-critical tables | Source counts/hashes, staging import report, verification report, rollback export | Any data cutover |
| G3 | Relay parity | P0 relay routes are implemented and live-smoked | Non-stream smoke, SSE smoke, error mapping smoke, upstream ID capture | Any customer relay canary |
| G4 | Billing parity | Billing expression and quota deltas match Go for production-shaped inputs | Golden fixtures, shadow settlement reports, delta threshold report | Paid traffic ownership |
| G5 | Admin/frontend parity | Admin can operate staging without direct DB edits | Login, token, channel, user, log, billing, and settings smoke | Operator cutover |
| G6 | Observability and security | SLO dashboards, alerts, WAF/rate limits, secret policy, and runbooks exist | Logs/traces, alert screenshots, incident runbook, security checklist | Canary above internal traffic |
| G7 | Canary | Rust Worker handles selected safe traffic with Go rollback ready | 1%/5%/25% reports, no unexplained billing deltas, rollback rehearsal | Full cutover |
| G8 | Cutover | All P0 gates pass and freeze window is approved | Final checklist, backup/export, DNS/route plan, owner approval | Retiring Go/VPS |
| G9 | Post-cutover hardening | Rust is primary and stable for the agreed window | Post-cutover audit, cost report, cleanup plan | VPS decommission |

## Workstream Status

| Workstream | Current Status | Production Target | Next Evidence |
| --- | --- | --- | --- |
| Platform/IaC | Partial | Reproducible staging/prod Cloudflare config with real bindings and generated types | `wrangler deploy --env staging` plus typed bindings |
| Data migration | Partial | Reversible source export, D1 import, row/hash verification, and rollback bundle | Real source inventory and staging import report |
| Relay/API parity | Partial | P0/P1 routes implemented with correct body mode, streaming behavior, errors, and live smoke | Route matrix and provider smoke log |
| Billing/quota | Partial | Go-compatible pricing, pre-consume, settlement, refunds, subscriptions, and shadow mode | Golden fixture set and shadow delta report |
| Cache/rate limit | Partial | Hot auth/channel cache, invalidation policy, rate limits, outage fallback | Redis failure-mode smoke |
| Observability/SRE | Partial | Logs, traces, metrics, alerts, runbooks, and incident ownership | Dashboard and alert checklist |
| Security/compliance | Partial | Secret isolation, CORS/WAF/rate limits, SSRF controls, admin audit, OAuth/webhook checks | Security checklist and smoke evidence |
| Admin/frontend | Planned | Pages-deployed operator UI with auth, token, channel, billing, log, and settings flows | Staging Pages smoke |
| Async/tasks/payments | Planned | Queue/R2/Workflow-backed async processing and idempotent payment flows | Replay/idempotency tests |
| Performance/cost | Planned | Load-tested SLOs and cost forecast | Mixed traffic load report |
| Release/cutover | Planned | Canary, rollback, cutover, and decommission runbooks | Rehearsed cutover checklist |

## Platform And Cloudflare Plan

Target:

- `wrangler.jsonc` or equivalent explicit environment config.
- Separate staging and production Workers.
- Separate staging and production D1 databases.
- Separate staging and production KV namespaces, R2 buckets, and Queues.
- Upstash staging/prod databases or logical prefixes with strict key
  separation.
- AI Gateway ID and direct-provider fallback policy documented per provider.
- Generated Worker types committed or regenerated through a documented command.

Required tasks:

1. Replace placeholder binding IDs with real staging IDs first.
2. Add a production environment block only after staging deploy is proven.
3. Move all secrets to Wrangler secret flow:
   upstream API keys, Upstash credentials, payment webhook secrets, OAuth
   client secrets, JWT/session secrets, Turnstile secrets, and admin bootstrap
   secrets.
4. Add a config checklist that records each binding name, Cloudflare resource,
   environment, owner, and rotation date.
5. Run local checks after each binding change:
   `bun run check`, `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
   and the Cloudflare dry-run/startup checks once `worker-build` is installed.

Exit evidence:

- Staging Worker deploy succeeds with real bindings.
- `/api/status` reports D1 and Upstash as configured.
- Workers Logs/Traces show request IDs.
- No placeholder IDs, local origins, or committed secret values remain in the
  production config.

## Data Migration Plan

Target:

- Source Go/VPS data remains authoritative until G8 cutover.
- D1 staging receives repeated dry-run imports until row counts and sample
  hashes are stable.
- Production D1 import is run from an immutable export bundle captured during a
  freeze window.
- Rollback can restore Go/VPS authority without losing quota/payment state.

Table families:

| Family | Examples | Current Rust Coverage | Production Requirement |
| --- | --- | --- | --- |
| Core identity | users, tokens, abilities, options | Partial D1 core schema | Full mapping, row/hash verification, sensitive column review |
| Relay config | channels, model mappings, groups | Partial | Provider-family compatibility, encrypted key handling, fallback behavior |
| Quota and logs | user/token quotas, usage logs, quota history | Partial | Pre/post consume parity, replay-safe settlement, archive strategy |
| Billing/subscription | pricing options, subscriptions, pre-consume records | Partial | Go/Rust parity, idempotent import, shadow billing report |
| Auth/security | OAuth, Passkey, 2FA, sessions | Planned | Session migration or forced re-auth policy |
| Payments | payment orders, webhook events, balance records | Planned | Webhook idempotency and double-credit prevention |
| Tasks/files | async task records, generated files | Planned | R2 object mapping, task replay policy |
| Admin/config | setup/config tables, system settings | Planned | Operator-visible staging verification |

Required tasks:

1. Capture source inventory from `C:\cinagroup\cinatoken`: routes, tables,
   config files, provider types, and env vars.
2. For each source table, record production criticality, D1 destination,
   transform rule, row count, sample hash, sensitive columns, and rollback
   behavior.
3. Extend D1 migrations before importing tables that do not yet have a target.
4. Run staging import from a real source snapshot.
5. Verify row counts and deterministic hashes.
6. Create a production export bundle with checksum and timestamp before G8.
7. Keep Go/VPS write authority during shadow and early canary unless a
   bidirectional sync plan exists.

Exit evidence:

- `docs/data-export.md` or a dedicated runbook records real source counts.
- Staging import can be recreated from scratch.
- D1 verification report includes row counts, hashes, and failed rows.
- Rollback export and restore steps have been rehearsed.

## Relay And API Parity Plan

Target:

- Rust Worker serves high-frequency relay traffic first.
- Every endpoint has explicit request body mode, response handling mode, usage
  parser policy, billing policy, and live smoke status.
- New large-body endpoints remain disabled until raw/multipart/stream body modes
  are implemented.

Route readiness:

| Route Family | Rust Status | Production Blockers | Gate |
| --- | --- | --- | --- |
| `GET /api/status` | Implemented | Staging/live feature validation | G1 |
| `GET /v1/models` | Implemented | Provider/model parity with source config | G3 |
| `POST /v1/chat/completions` | JSON + SSE implemented | Live upstream smoke, billing shadow | G3/G4 |
| `POST /v1/completions` | JSON + SSE implemented | Live upstream smoke, billing shadow | G3/G4 |
| `POST /v1/responses` | JSON + SSE implemented | Live upstream smoke, response usage edge cases | G3/G4 |
| `POST /v1/embeddings` | JSON implemented | Live upstream smoke, batch size policy | G3/G4 |
| `POST /v1/rerank` | Jina/Cohere JSON implemented | Additional providers, live Jina/Cohere smoke | G3/G4 |
| `POST /v1/images/generations` | JSON + SSE implemented | Provider smoke, large response policy | G3/G4 |
| `POST /v1/audio/speech` | JSON passthrough implemented | Binary/audio live smoke, response audit policy | G3 |
| `POST /v1/audio/transcriptions` | Blocked | Multipart body mode and upstream forwarding | G3 |
| `POST /v1/audio/translations` | Blocked | Multipart body mode and upstream forwarding | G3 |
| `POST /v1/messages` | Anthropic JSON + SSE implemented | Live Anthropic smoke, billing shadow | G3/G4 |
| Gemini generate/stream/embed/count | Implemented | Live Gemini smoke, model/path parity | G3/G4 |
| Admin APIs | Planned | Route matrix, auth, audit, frontend smoke | G5 |
| Payment/webhook APIs | Planned | Signature verification, idempotency, replay tests | G5/G7 |
| Async task APIs | Planned | Queue/R2/Workflow implementation | G7 |

Required tasks:

1. Produce a route matrix from the Go source with method, path, auth,
   request-body type, response type, streaming behavior, provider family, and
   production priority.
2. Keep JSON endpoints on the bounded JSON body path.
3. Implement multipart/raw/pass-through stream modes before file upload or
   binary body routes.
4. For every provider adapter, add golden request/response fixtures, URL
   mapping tests, error mapping tests, and usage parser tests.
5. Run live smoke tests per route family in staging.
6. Record upstream request IDs, channel IDs, model mapping, latency, status,
   usage fields, and billing deltas.

Exit evidence:

- P0 relay matrix shows `implemented`, `unit-tested`, `wasm-checked`, and
  `live-smoked`.
- Streaming routes have first-byte and stream-completion evidence.
- Large-body routes prove no unbounded buffering.

## Billing, Quota, And Settlement Plan

Target:

- Go remains the billing source of truth until Rust shadow settlement is proven.
- Rust production settlement is enabled only after golden fixtures and shadow
  deltas pass thresholds.
- Any billing expression implementation change must first read
  `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md`.

Required tasks:

1. Expand Go/Rust golden fixtures for:
   nested ternaries, tier boundaries, cached token pricing, image/audio token
   variables, request `param()` and `header()` probes, `|||` request rules,
   missing values, invalid expressions, timezone helpers, and non-tiered
   pricing.
2. Replace heuristic request-token estimates with Go `TokenCountMeta` parity,
   including tokenizer counts, image dimensions, audio duration, and cache
   categories.
3. Implement non-tiered billing paths and subscription/pre-consume records.
4. Add shadow settlement mode:
   Go applies production quota deltas, Rust computes and logs deltas, and any
   mismatch is reported without affecting balances.
5. Define mismatch thresholds before canary. Recommended initial blockers:
   any negative balance bug, any double charge, any missed charge above a small
   configured amount, or any unexplained aggregate delta.
6. Add operator-visible billing audit surfaces before paid traffic cutover.

Exit evidence:

- Golden fixture suite passes locally.
- Shadow billing report covers real production-shaped requests.
- Refund/additional settlement behavior is verified for success, upstream
  error, timeout, client disconnect, and missing usage.
- Paid canary has no unexplained deltas.

## Cache, Rate Limit, And Consistency Plan

Target:

- Upstash improves latency and load but never becomes the only source of
  critical truth.
- Cache keys are versioned, scoped by environment, and include provider family
  where route behavior differs.

Required tasks:

1. Document all Redis key prefixes, TTLs, and invalidation triggers.
2. Invalidate token/channel cache on admin mutations.
3. Define outage behavior:
   fail open only for non-critical cache reads, fail closed or degrade for
   abuse/rate-limit controls where appropriate.
4. Keep rate limits scoped by token, IP, route family, and environment.
5. Add staging smoke for Upstash success, timeout, and error responses.

Exit evidence:

- Cache invalidation is covered by tests or staging smoke.
- Redis outage mode is documented and observed.
- Rate-limit headers/errors are compatible with clients or explicitly
  documented as changed behavior.

## Observability And SRE Plan

Target:

- Operators can answer who called what, through which token/channel/model, what
  upstream did, which quota mutation happened, and how to replay/refund.

Signals:

- Request ID, trace ID, token fingerprint, user ID, endpoint, model, channel,
  provider family, upstream request ID, status, latency, stream duration,
  request/response byte class, cache status, rate-limit decision, quota delta,
  and billing mode.
- D1 error rate, D1 latency, queue lag, DLQ count, Upstash latency/errors,
  upstream 429/5xx, Worker CPU/timeouts, stream aborts, payment failures, and
  billing shadow deltas.

Required tasks:

1. Define structured log schema and redaction rules.
2. Enable Workers Logs/Traces with staging/prod sampling policies.
3. Add dashboards for relay health, provider health, billing health, data
   migration, queues, and security events.
4. Add alerts for sustained 5xx, D1 mutation failures, queue backlog, billing
   mismatches, payment replay failures, and provider-wide outages.
5. Write incident runbooks for:
   upstream outage, D1 write failure, Redis outage, billing mismatch, payment
   replay, queue backlog, and rollback to Go/VPS.

Exit evidence:

- Staging smoke creates visible logs and traces.
- Alerts can be triggered in a controlled staging test.
- Runbooks identify owner, first action, rollback action, and customer impact.

## Security And Compliance Plan

Target:

- Production secrets, keys, user balances, provider credentials, and admin
  actions are protected at least as strongly as the Go/VPS deployment.

Required tasks:

1. Keep protected project identity references intact during migration.
2. Store secrets outside committed config and rotate them per environment.
3. Ensure logs never include raw API keys, bearer tokens, payment secrets,
   OAuth secrets, or full provider credentials.
4. Add WAF/rate-limit rules for abusive paths.
5. Define CORS allowlist by environment.
6. Validate OAuth state and callback origins.
7. Verify payment webhook signatures and replay protection.
8. Add admin audit logs for sensitive mutations.
9. Add SSRF protections for any user-controlled URL fetch path.
10. Define key encryption or storage policy for provider/channel credentials.

Exit evidence:

- Security checklist is complete for staging.
- Secrets scan and protected-reference scan pass.
- OAuth/webhook/admin mutation smokes pass.
- Rollback plan preserves secret rotation and revocation steps.

## Admin, Frontend, Payments, And Async Plan

Target:

- Relay can go first, but operators must not need direct D1 edits for normal
  production work.

Required tasks:

1. Build the Pages staging deployment using Bun.
2. Migrate login/session flows, token management, channel management, model
   mapping, log search, user/quota management, billing settings, and system
   settings.
3. Add payment provider flows with webhook signature verification and idempotent
   event storage.
4. Move async task polling and generated artifacts to Queues/R2/Workflows as
   appropriate.
5. Decide whether realtime/session-heavy flows use Durable Objects, a separate
   Rust service, or stay on Go until later.

Exit evidence:

- Operator staging smoke passes without direct database edits.
- Payment replay cannot double-credit.
- Task retry cannot double-charge or lose artifacts.
- Frontend build and route checks pass under Bun.

## Performance And Cost Plan

Target:

- Rust/Cloudflare improves global availability without introducing hidden cost
  or latency regressions.

Required tasks:

1. Define SLOs before canary:
   auth/route overhead, upstream first-byte overhead, non-stream added latency,
   stream first-token overhead, D1 mutation latency, billing mismatch tolerance,
   and queue lag.
2. Load-test mixed relay traffic with realistic model distribution.
3. Validate Worker CPU, memory, subrequest, D1, Queue, R2, and Upstash usage.
4. Forecast cost at current, 2x, and 5x traffic.
5. Verify cache hit rates and rate-limit behavior under load.

Exit evidence:

- 500-concurrency mixed relay test, or an agreed production-shaped equivalent,
  passes SLOs.
- Cost forecast is approved before full cutover.
- Top bottlenecks have owner and mitigation plan.

## Cutover Scenarios

### Scenario A: Relay-Only Beta

Use when the goal is to move high-frequency AI relay traffic first.

- Keep Go/VPS as source of truth for admin, payments, and most writes.
- Import required token/channel/model/billing data into D1 staging/prod.
- Route selected internal tokens to Rust Worker.
- Compare quota and usage logs against Go.
- Promote only after G1, G2 subset, G3, G4 shadow, and G6 pass.

### Scenario B: Relay Plus Admin Core

Use when operators need to manage Rust production without direct D1 access.

- Complete Scenario A.
- Deploy Pages/admin staging.
- Migrate token/channel/user/log/settings APIs.
- Keep payment and long-tail async tasks on Go if not yet proven.
- Promote after G5 passes.

### Scenario C: Full Billing And Payment Cutover

Use only when Rust should own customer balances and subscription state.

- Complete Scenario B.
- Enable payment webhooks and idempotent event storage.
- Enable Rust settlement as source of truth after shadow passes.
- Run paid canary with strict rollback triggers.
- Promote after G4, G5, G6, and G7 pass.

### Scenario D: Full Platform Cutover

Use when Go/VPS can be retired.

- Complete Scenario C.
- Migrate async tasks, files, realtime/session strategy, and long-tail
  providers.
- Freeze writes, import final deltas, warm cache, route DNS/traffic to Rust.
- Keep Go/VPS hot for rollback until the agreed stability window passes.

## Canary And Rollback Plan

Canary ramp:

1. Internal tokens only.
2. 1% of selected low-risk relay traffic.
3. 5% after one clean observation window.
4. 25% after billing, latency, and error metrics remain within thresholds.
5. 50% only after rollback rehearsal succeeds.
6. 100% after owner sign-off and final export/backup.

Candidate rollback triggers:

- Any quota or balance corruption.
- Any payment double-credit or missed-credit event.
- Sustained Rust 5xx above Go baseline plus the agreed threshold.
- D1 mutation failures affecting auth, reserve, or settlement.
- Billing shadow delta above the agreed threshold.
- Provider-wide routing error caused by Rust channel selection.
- Logs/traces unavailable during canary.
- Operator cannot revoke a bad token/channel quickly.

Rollback actions:

1. Stop new Rust traffic by route rule, DNS, token group, or feature flag.
2. Keep Rust logs and D1 state immutable for investigation.
3. Reconcile any Rust-applied quota/payment deltas back to Go.
4. Rotate any secrets exposed during incident response.
5. Write a short rollback report before restarting canary.

## Production Evidence Checklist

Before G8 cutover, the repository or deployment runbook must contain:

- Route matrix with live smoke status.
- Provider matrix with channel types, model mapping, fallback, and smoke status.
- Table matrix with source counts, target counts, hashes, and rollback notes.
- Billing matrix with expression coverage, settlement mode, and shadow deltas.
- Cloudflare binding checklist for staging and production.
- Secret inventory without values and rotation owners.
- Observability dashboard and alert checklist.
- Security checklist.
- Load-test report.
- Cutover runbook.
- Rollback runbook.
- Post-cutover monitoring checklist.

## Immediate Next Planning Milestones

1. Produce the real Go source route matrix from `C:\cinagroup\cinatoken`.
2. Produce the real source DB/table matrix, including counts and sensitive
   columns when a production snapshot or DSN is available.
3. Create the staging Cloudflare binding checklist and replace placeholder
   resource IDs only after real resources exist.
4. Write the first staging smoke runbook covering status, auth, non-stream
   relay, SSE relay, billing reserve/refund/success, Upstash failure mode, and
   D1 write failure mode.
5. Expand the billing fixture plan before any new billing expression change.
6. Define SLO thresholds and rollback thresholds before any customer canary.
