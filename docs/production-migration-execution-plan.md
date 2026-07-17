# Production Migration Execution Plan

Date: 2026-07-12

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
- `docs/production-readiness-matrices.md` for route, provider, data, billing,
  Cloudflare binding, observability, security, and SLO evidence tracking.
- `docs/cloudflare-production-config-checklist.md` for staging/prod bindings,
  secrets, observability, environment separation, and config gates.
- `docs/data-migration-runbook.md` for source export, D1 import, row-count,
  sample-hash, freeze, rollback, and reconciliation control.
- `docs/billing-parity-runbook.md` for billing-expression parity, shadow
  settlement, reserve/refund, and paid-cutover gates.
- `docs/route-provider-parity-runbook.md` for G3 route/provider coverage,
  body modes, streaming behavior, usage parsing, error mapping, and smoke
  evidence.
- `docs/source-provider-channel-matrix.md` for the canonical, source-derived
  channel-type -> APIType -> adapter mapping that the route/provider matrices
  must agree with.
- `docs/source-route-inventory.md` for the canonical, source-derived list of
  every Go route with its auth class, handler, and parity findings.
- `docs/source-d1-schema-parity.md` for P0-table field/index/PK parity against
  the D1 migrations, including corrective `0004_schema_parity.sql`.
- `docs/source-billing-expr-parity.md` for the source-derived billing-expression
  engine contract and the 56-test golden fixture gap map.
- `docs/source-token-estimation-parity.md` for the source-derived request-time
  token estimation (tiktoken, image algorithm, audio duration) that feeds
  pre-consume reservation.
- `docs/source-auth-session-parity.md` for the source-derived auth/session model
  (session vs access-token, `New-Api-User`, relay token-key extraction, admin
  channel pin, OAuth/2FA/Passkey enrollment) the Rust auth layer must match.
- `docs/source-payment-idempotency-parity.md` for the source-derived payment
  order model, per-provider quota formulas, and the two-layer webhook
  idempotency design that prevents double-credit.
- `docs/source-usage-parsing-parity.md` for the source-derived SSE/non-stream
  usage extraction, missing-usage estimate fallback, and stream_options matrix
  that feed settlement.
- `docs/source-retry-autoban-parity.md` for the source-derived relay retry loop,
  retryable-error classification, channel auto-ban (status + keyword, per-key),
  and auto-recovery.
- `docs/source-ssrf-parity.md` for the Go<->Rust SSRF/outbound-URL validation
  parity, CIDR-table divergences, DNS-rebinding decision, and wiring gate.
- `docs/source-task-lifecycle-parity.md` for the source-derived async media-task
  submit/poll/settle lifecycle, three billing hooks, CAS idempotency, and the
  Workflows/Queue/R2 Cloudflare mapping.
- `docs/source-pricing-ratio-parity.md` for the source-derived non-tiered
  (ratio/price) billing resolution — the default path and the current
  `quota=0/billing_pending` cutover blocker.
- `docs/source-security-middleware-parity.md` for the source-derived Turnstile,
  secure-verification (step-up), and CORS middleware parity and the KV/DO
  session-state requirement.
- `docs/source-oauth-2fa-passkey-parity.md` for the source-derived OAuth state
  (CSRF), TOTP 2FA, and WebAuthn/Passkey enrollment flows and their KV/DO
  single-use state requirement.
- `docs/parity-implementation-backlog.md` is the implementation companion: it
  sequences all 15 source-parity checklists into gate/scenario-ordered phases
  with dependencies and the hard-blocker short list.
- `docs/source-channel-selection-parity.md` for the source-derived channel
  selection algorithm (priority/weight/smoothing, affinity, auto cross-group
  retry) that the Rust selector must match.
- `docs/observability-slo-security-runbook.md` for G6 logs, traces, SLOs,
  alert drills, redaction, WAF/rate-limit/CORS, and incident evidence.
- `docs/admin-frontend-parity-runbook.md` for G5 admin API, frontend, auth,
  session, operator CRUD, cache invalidation, and audit evidence.
- `docs/performance-capacity-cost-runbook.md` for load profiles, D1/Redis/
  Queue/R2 capacity, Worker limits, cost forecasts, and canary efficiency
  evidence.
- `docs/staging-smoke-runbook.md` for the staging deploy and live smoke
  checklist before canary.
- `docs/cutover-rollback-runbook.md` for traffic ramp, abort, rollback,
  reconciliation, full cutover, and post-cutover decommission.
- `docs/verification.md` for verified local and staging evidence.
- `docs/phase-1.md` for current implementation status.

This file is deliberately gate-driven: production cutover is allowed only when
the required evidence exists, not when implementation "looks close".

## Current Baseline

Completed or substantially implemented:

- Rust workspace and Cloudflare Worker MVP.
- D1 core schema, migration CLI, repository boundary, token auth, channel
  selection, model mapping, audit logging, Workers-native Rate Limiting
  bindings, and optional Upstash read-through token/channel cache.
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

- Staging resource IDs are present in the repository but have not been proven
  by authenticated Wrangler output; production binding IDs remain placeholders.
- No authenticated remote staging deploy, D1 migration, binding, log/trace, or
  Realtime settlement result exists. Local evidence cannot replace it.
- Multipart/raw/pass-through request body forwarding is not implemented, so
  file upload style endpoints must remain blocked.
- Queue, R2, KV, Pages, admin APIs, payments, subscriptions, async tasks,
  OAuth/Passkey/2FA, and full frontend migration remain incomplete.
- Billing expression parity is not yet broad enough for full production
  settlement ownership.

### 2026-07-10 Operations Increment

Completed local evidence:

- `bun run check:d1:migration-config` passes and requires all three D1 binding
  tables to use `migrations/d1`, with 20 contiguous migrations through `0020`.
- `bun run verify:sqlite` applies all 20 migrations by default and verifies 26
  required tables, 56 incremental key columns, and 14 key indexes.
- Local Wrangler D1 applied 20/20 migrations on Windows after installing the
  Microsoft Visual C++ 2015-2022 x64 runtime required by `workerd`.
- The compiled Worker capability now requires the exact 20-name D1 ledger; the
  previous localhost HTTP snapshot verified the 19-name ledger and must be
  refreshed before it counts as current runtime evidence. That earlier request
  returned D1 readiness true. It also exposed and closed a
  wasm billing-clock panic; Realtime billing probes passed after switching the
  wasm default clock to `js_sys::Date`.
- The localhost Realtime settlement Worker-binding smoke passed six of six
  scenarios and cleaned all smoke fixture rows after fixing route precedence
  for `/api/platform/realtime/settlement-batch/smoke`.

Gate interpretation:

- G1 remains closed: Wrangler was not authenticated and no staging deployment,
  resource identity, binding, status, log, or trace was verified.
- G2 remains closed: no remote staging migration output, source export/import,
  row counts, sample hashes, or rollback point was captured.
- G7 and Realtime production enablement remain closed: local 6/6 settlement
  evidence must be repeated through deployed staging D1 with live
  no-double-charge and protocol evidence.
- The exposed token must not be used. Revoke/rotate it and authenticate with a
  replacement least-privilege credential before remote execution.

### 2026-07-12 Native Admission And Topup Migration Increment

Completed local evidence:

- All tracked development, staging, and production shapes now declare distinct
  token and IP Rate Limiting namespaces and explicitly select the native
  backend. Keys are route-family scoped; IP values are SHA-256 fingerprints.
  Missing/malformed native bindings fail closed. Legacy Upstash counters remain
  an explicit compatibility mode only.
- `bun run check:cf:native-rate-limits` verifies six environment-scoped
  namespaces plus the isolated Realtime runtime shape. The full six-scenario
  local Realtime workerd/D1 suite passed through the native binding adapter.
- The migration CLI now imports source `top_ups` into D1 `topups` without
  replacing existing orders. It maps pending/success/failed/expired to
  0/1/2/3, validates provider ownership, marks only successful history as
  credited, and includes topups in canonical reconciliation and user
  relationship checks.
- Platform capabilities now report Realtime bridge and settlement as compiled
  implementation. Cutover readiness remains false unless DO, D1, environment,
  settlement-write, and staging evidence gates all pass.

Gate interpretation:

- This closes the local Upstash hot-path dependency for relay admission and the
  missing topup conversion/reconciliation implementation. It does not prove
  Cloudflare's location-local limit behavior under staging load or any real
  source data import.
- G1 still requires authenticated binding readback and 429 telemetry. G2/G4/G7
  still require production-source topup counts/hashes, remote import, callback
  replay, no-double-credit, and paid reconciliation evidence.

### 2026-07-11 Layered Architecture Re-Audit

Production decisions from the refreshed cinaVibeSDK and Cloudflare audit:

- TaskRunner now uses a bounded recurring-alarm state machine rather than a
  one-shot poll. Non-terminal progress re-arms, transient failures back off,
  lost CAS outcomes re-read D1, and the fast path explicitly falls back to cron
  after its configured horizon. The runtime gate remains false pending staging
  alarm/cron race and no-double-settlement evidence.
- AI Gateway now has a default-off Rust cross-model fallback foundation for
  explicitly mapped OpenAI-compatible chat/responses requests. It separates
  provider-native direct model names, fails closed on auth/rate-limit responses,
  re-runs token/channel policy, and hands settlement to the served model. Treat
  it as non-production until deployed replay is archived, all-fetch-failed
  type-5 audit delivery/refund ordering is proven through staging Queue and D1,
  and `auto` billing follows the actual serving group; keep Cloudflare Dynamic
  Routing as a separately canaried option.
- WFP tenant AI routes are not an alternate paid entry point. The local
  increment now makes WFP a post-admission transport: the central relay owns
  token auth, D1 channel selection, reserve, settlement/refund, and audit, while
  `channels.other_info.wfp_worker` selects the tenant Worker. A 30-second
  central-authority v3 HMAC binds body, path, method, channel, request ID,
  public worker, physical dispatch Worker, and fixed outbound policy directly
  with platform-only `WFP_RELAY_AUTHORITY_SECRET`.
  Tenants receive no signing/verifier key or replay binding. Cloudflare passes
  a bounded route/public-worker/dispatch-worker context to the outbound Worker,
  which validates context, final path/body, signature, and one-time consumption
  through the platform-owned `WfpAuthorityReplay` DO before bearer access.
  The outbound service, not the tenant, owns Gateway IDs, retry/cache/logging,
  and signed-claim attribution metadata. Duplicate/invalid/unavailable checks
  fail closed. Keep
  `WFP_RELAY_TRANSPORT_ENABLED=false` until staging proves the complete path,
  external binding identity, and sequential/concurrent replay behavior.

## Best-Practice Anchors

Cloudflare references were refreshed on 2026-07-13:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Durable Object alarms:
  <https://developers.cloudflare.com/durable-objects/api/alarms/>
- AI Gateway dynamic routing:
  <https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/>
- Workers for Platforms architecture:
  <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/>
- WFP dynamic dispatch:
  <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/>
- Workers for Platforms Scripts REST API:
  <https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Workers Fetch:
  <https://developers.cloudflare.com/workers/runtime-apis/fetch/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers Logs:
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Workers static assets:
  <https://developers.cloudflare.com/workers/static-assets/>
- Workers SPA routing:
  <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Turnstile server-side validation:
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Workers pricing:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- D1 pricing:
  <https://developers.cloudflare.com/d1/platform/pricing/>
- Queues limits:
  <https://developers.cloudflare.com/queues/platform/limits/>
- R2 limits:
  <https://developers.cloudflare.com/r2/platform/limits/>
- Cloudflare WAF:
  <https://developers.cloudflare.com/waf/>
- D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>
- D1 import/export:
  <https://developers.cloudflare.com/d1/best-practices/import-export-data/>
- D1 migrations:
  <https://developers.cloudflare.com/d1/reference/migrations/>
- D1 Time Travel:
  <https://developers.cloudflare.com/d1/reference/time-travel/>

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

### 2026-06-25 Platform Best-Practice Update

Several Cloudflare capabilities GA'd in H1 2026 supersede earlier primitive
choices in this plan. These are authoritative; see
`docs/cinatoken-rust-migration-plan.md` §21 for full rationale. New anchors:

- Workers Rate Limiting binding (GA 2025-09-19):
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- D1 global read replication / Sessions API:
  <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- Cloudflare Containers + Sandboxes (GA 2026-04-13):
  <https://developers.cloudflare.com/containers/>
- Cloudflare Workflows (GA, durable execution):
  <https://developers.cloudflare.com/workflows/>
- Workers gradual deployments:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>

Corrected production rules:

- Rate limiting is a Workers-native Rate Limiting binding, not an Upstash REST
  hot-path call. Keep the non-Cloudflare egress on the hot path at zero.
- Hot atomic state (round-robin index, concurrency caps, channel breaker, locks)
  is Durable Objects, not Upstash. Upstash is not a production hard dependency.
- Read-heavy D1 access uses the Sessions API with read replicas and read-your-
  writes bookmarks; write-then-read admin paths reuse the same session.
- WASM-incompatible or long-running workloads (Passkey/WebAuthn, complex AWS/
  Vertex/Tencent signing, Realtime WebSocket bridge, Codex relay/runtime work
  beyond the bounded Worker admin usage/refresh flow, io.net, heavy tokenizers)
  run in Cloudflare Containers, not a separate VPS.
- Multi-step async (media task polling, payment reconciliation) uses Workflows
  for durable, idempotent, replayable steps; Queues stay for high-volume fan-in.
- Canary is driven primarily by Workers gradual deployments (version-percentage
  split) plus token-group gating, not DNS swaps.

### Container operation terminal-commit overlay (2026-07-16)

For the four-layer Worker -> sharded DO -> Linux Container -> KV/D1/R2 design,
D1 is the only global operation and financial authority. The DO is the durable
execution supervisor and the Container is disposable compute; neither a DO
terminal row nor an R2 result can authorize a client-visible response alone.

The mandatory order for the first non-streaming chat canary is:

1. freeze the normal billing snapshot and selected channel/group at the edge;
2. create immutable R2 input and bind the exact 0040 operation to the live
   billing owner;
3. win the global `prepared -> dispatched` CAS before the first Service Binding
   send; `AlreadyDispatched` is status-query-only and never sends again;
4. execute or query the same named shard and verify the exact R2 result;
5. in one guarded D1 batch commit operation terminal state, billing terminal
   state, quota/request/channel mutations, and immutable audit/outbox evidence;
6. only after matching canonical readback, read the version-pinned R2 response
   and return its exact status, allowlisted headers, and bytes;
7. on ambiguity, query the same operation and reconcile; never switch provider,
   create a new provider identity, settle, or refund by timeout alone.

Eight independent flags must remain false until their own evidence exists:
`CONTAINER_OPERATION_WRITE_ENABLED`, `CONTAINER_TERMINAL_CAS_ENABLED`,
`CONTAINER_FINANCIAL_TERMINAL_ENABLED`,
`CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED`,
`CONTAINER_OPERATION_RECONCILIATION_ENABLED`,
`CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED`,
`CONTAINER_CHAT_CANARY_ENABLED`, and
`CONTAINER_OPERATION_STAGING_VERIFIED`. They are mandatory inputs to Container
cutover readiness, not operational hints. The local lifecycle CAS, signed
status-only query, and 0042 cross-ledger terminal batch do not open G4 or G7:
the batch is not wired into the edge canary, and exact response replay, the
Linux image, remote fault matrix, and C1-C5 approvals remain incomplete.
Migration 0042 is an expand-only event/identity contract;
it does not authorize any of these flags. A later 0046 enforcement migration
requires a drained old-writer cohort and remote proof that every v1 operation
has non-empty client/reconciliation identity.

Migration 0044 is also expand-only and default inert. It adds a three-lane R2
orphan inventory whose only authority is LIST plus writes to its own fenced D1
cursor/finding tables. Candidate status requires two completed scan generations
and a second D1 reference/active-operation check. It adds no cleanup route,
delete permission, provider retry, financial write, or cutover flag. The
tracked runtime switch is false in development, staging, and production.

Migration 0045 is independently default-off. It adds an immutable operator
retry event and an exact event-backed `dead_letter -> retry` transition only in
the 0043 observation table. The apply route requires RootAuth, fresh step-up,
an exact state-bound preview token, a bounded allowlisted decision, and an
idempotency key. Event insertion and redacted admin audit use one D1 batch;
stale state, exhausted horizon, less than 60 seconds of remaining recovery
margin, and any no-op fence fail closed. It cannot dispatch, call a provider,
or mutate an operation, billing/accounting state, DO ledger, or R2 object.
`CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED` remains false in every tracked
environment and is not a Container cutover flag.

## Production Gates

| Gate | Name | Opens When | Required Evidence | Blocks |
| --- | --- | --- | --- | --- |
| G0 | Scope and inventory freeze | Go source, DB, routes, providers, env, and secrets are inventoried | Route matrix, table matrix, provider matrix, secret inventory without values | Any production deployment planning |
| G1 | Cloudflare staging foundation | Staging Worker has authenticated, verified D1/KV/R2/Queue/DO/Upstash/provider bindings | Rotated credential evidence, `wrangler deploy --env staging`, remote migrations 0001-0045 with every mutation/cutover/retry gate false, `/api/status`, generated binding types, logs visible | Live smoke and canary |
| G2 | Data dry run | D1 migrations cover production-critical tables and are applied to remote staging | Source counts/hashes, staging import report, verification report, rollback export; local 45/45 and 43-table replay are prerequisites only | Any data cutover |
| G3 | Relay parity | P0 relay routes are implemented and live-smoked | G3 report from `docs/route-provider-parity-runbook.md`, non-stream smoke, SSE smoke, error mapping smoke, upstream ID capture | Any customer relay canary |
| G4 | Billing parity | Billing expression and quota deltas match Go, and Container operation/billing/quota/audit terminal state commits atomically | Golden fixtures, cross-ledger D1 batch rollback faults, exact replay, shadow settlement reports, delta threshold report | Paid traffic ownership |
| G5 | Admin/frontend parity | Admin can operate staging without direct DB edits | G5 report from `docs/admin-frontend-parity-runbook.md`, login/current-user/logout, token/channel/user/log/settings smoke, cache invalidation, admin audit, frontend build/deploy evidence | Operator cutover |
| G6 | Observability and security | SLO dashboards, alerts, WAF/rate limits, secret policy, and runbooks exist | G6 report from `docs/observability-slo-security-runbook.md`, logs/traces, alert drill, redaction smoke, incident template | Canary above internal traffic |
| G7 | Canary | Rust Worker handles selected safe traffic with Go rollback ready and every Container operation/canary/reconciliation/staging gate true from archived evidence | 1%/5%/25% reports, no unexplained billing or DO/D1/R2 deltas, duplicate-operation proof, rollback rehearsal | Full cutover |
| G8 | Cutover | All P0 gates pass and freeze window is approved | Final checklist, backup/export, DNS/route plan, owner approval | Retiring Go/VPS |
| G9 | Post-cutover hardening | Rust is primary and stable for the agreed window | Post-cutover audit, cost report, cleanup plan | VPS decommission |

## Workstream Status

| Workstream | Current Status | Production Target | Next Evidence |
| --- | --- | --- | --- |
| Platform/IaC | Partial: local D1 config audit passes; staging IDs remain unauthenticated/unverified | Reproducible staging/prod Cloudflare config with real bindings and generated types | Revoke/rotate leaked token, authenticate replacement credential, verify account/resources, then `wrangler deploy --env staging` plus typed bindings |
| Data migration | Partial: local exact-set SQLite replay passes 45/45 migrations, 43 tables, 434 checked incremental columns, and 64 key indexes; 0041 freezes same-state Container lifecycle outcomes, 0042 adds immutable financial terminal/outbox authority, 0043 adds observer-only reconciliation, 0044 adds observer-only R2 inventory, and 0045 adds default-off audited observer retry apply; historical remote evidence is older | Reversible source export, D1 import, row/hash verification, and rollback bundle | Authenticated remote 45/45 staging apply with all Container writer/proof/inventory/retry gates false, immutable-contract negative probes, old-writer drain inventory, real source inventory, staging import report, and rollback point |
| Relay/API parity | Partial | P0/P1 routes implemented with correct body mode, streaming behavior, errors, and live smoke | Route matrix and provider smoke log |
| Billing/quota | Partial: D1 owner-generation/Queue recovery is local; QuotaCoordinator has default-off tiered reserve/direct-finalization/Queue/recovery producers plus bounded commit-watermark compaction and a 1.5 MB local JSON guard, but no deployed retention proof, shadow reconciliation, or authority | Go-compatible pricing, pre-consume, settlement, refunds, subscriptions, measured tiered shadow operation, and a proven shadow mode while D1 remains authoritative | Golden fixtures, deployed hot-token window/structured-clone/load/cost report, off-path reconciliation/alerts, disable-first rollback, and signed 30-day shadow delta report |
| Cache/rate limit | Partial | Hot auth/channel cache, invalidation policy, rate limits, outage fallback | Redis failure-mode smoke |
| Observability/SRE | Partial | Logs, traces, metrics, alerts, runbooks, and incident ownership | Dashboard and alert checklist |
| Security/compliance | Partial | Secret isolation, CORS/WAF/rate limits, SSRF controls, admin audit, OAuth/webhook checks | Security checklist and smoke evidence |
| Admin/frontend | Partial | Cloudflare-deployed operator UI with auth, token, channel, billing/log/settings flows, redaction, audit, and cache invalidation | Redacted G5 report from `docs/admin-frontend-parity-runbook.md`; authenticated browser smoke for the reviewed 35-call / 0 payment-deferred route-debt baseline |
| Async/tasks/payments | Planned | Queue/R2/Workflow-backed async processing and idempotent payment flows | Replay/idempotency tests |
| Performance/cost | Planned | Load-tested SLOs, capacity budget, D1/Redis/Queue/R2 cost forecast, and bottleneck owners | Redacted report from `docs/performance-capacity-cost-runbook.md` |
| Release/cutover | Planned | Canary, rollback, cutover, and decommission runbooks | Rehearsed cutover checklist |

## Platform And Cloudflare Plan

Target:

- `wrangler.jsonc` or equivalent explicit environment config.
- Separate staging and production Workers.
- Separate staging and production D1 databases, with Sessions API read
  replication enabled for read-heavy paths.
- Separate staging and production KV namespaces, R2 buckets, and Queues.
- A Durable Object namespace per environment for hot atomic state (round-robin
  index, concurrency caps, channel breaker, locks).
- A Rate Limiting binding per environment for token/IP/route-family limits.
- Workflows bindings for async task and payment reconciliation orchestration.
- Frontend served as Workers Static Assets from the same Worker (single origin),
  not a separate Pages project.
- Cloudflare Containers for WASM-incompatible / long-running fallback workloads,
  addressed from the Worker by binding/hostname.
- Secrets Store for provider/payment secrets shared across Worker and Container,
  with per-Worker `wrangler secret put` for Worker-only secrets.
- Upstash retained only as a transitional cache, with staging/prod separation;
  not a production hard dependency (see Cache plan).
- AI Gateway ID and direct-provider fallback policy documented per provider;
  prefer AI Gateway for upstream fallback/retry/cache/observability over
  reimplementing them in the Worker hot path.
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
| Auth/security | OAuth, Passkey, 2FA, sessions, checkins | Partial: session auth, public email/reset/bind, WeChat OAuth, 2FA frontend contract, custom OAuth provider/binding admin surfaces, D1-backed daily check-in, and Worker-native Passkey register/login/step-up with a strongly consistent challenge DO exist; forced re-auth/session migration policy remains | Session migration or forced re-auth policy; Passkey real-authenticator/import/replay/session-isolation staging evidence; check-in history import/reset decision and duplicate-submit staging smoke |
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
| `POST /v1/embeddings` | JSON implemented for generic OpenAI-compatible and route-explicit Jina type 38 | Live upstream smoke, Jina request/usage parity, batch size policy | G3/G4 |
| `POST /v1/rerank` | Jina/Cohere JSON implemented | Additional providers, live Jina/Cohere smoke | G3/G4 |
| `POST /v1/images/generations` | JSON + SSE implemented | Provider smoke, large response policy | G3/G4 |
| `POST /v1/audio/speech` | JSON passthrough implemented | Binary/audio live smoke, response audit policy | G3 |
| `POST /v1/audio/transcriptions` | Partial: multipart forwarding and common audio/WebM duration preflight implemented | Live upstream smoke, real-file non-WAV/WebM replay, billing shadow evidence | G3/G4 |
| `POST /v1/audio/translations` | Partial: multipart forwarding and common audio/WebM duration preflight implemented | Live upstream smoke, real-file non-WAV/WebM replay, billing shadow evidence | G3/G4 |
| `POST /v1/messages` | Anthropic JSON + SSE implemented | Live Anthropic smoke, billing shadow | G3/G4 |
| Gemini generate/stream/embed/count | Implemented | Live Gemini smoke, model/path parity | G3/G4 |
| Admin APIs | Planned | Route matrix, auth, audit, frontend smoke | G5 |
| Payment/webhook APIs | Planned | Signature verification, idempotency, replay tests | G5/G7 |
| Async task APIs | Planned | Queue/R2/Workflow implementation | G7 |

Required tasks:

1. Use `docs/route-provider-parity-runbook.md` to produce a route matrix from
   the Go source with method, path, auth,
   request-body type, response type, streaming behavior, provider family, and
   production priority.
2. Keep JSON endpoints on the bounded JSON body path.
3. Continue multipart/raw/pass-through stream modes before broader file upload
   or binary body routes. The first multipart audio/image routes and common
   audio/WebM duration preflight are in place; raw/pass-through stream paths
   remain open.
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

Target (revised 2026-06-25):

- Hot-path primitives are Cloudflare-native first; the non-Cloudflare egress on
  the relay hot path is zero.
- Rate limiting uses the Workers Rate Limiting binding, not Upstash REST.
- Atomic state (round-robin index, concurrency caps, channel breaker, locks)
  uses Durable Objects.
- Read-heavy token/channel/options access uses the D1 Sessions API with read
  replicas; KV/Cache API holds derived config caches.
- Upstash, if retained at all, is a transitional cache only and never the only
  source of critical truth; cache keys are versioned, environment-scoped, and
  include provider family where route behavior differs.

Required tasks:

1. Replace per-token/IP/route-family rate limits with the Rate Limiting binding;
   retire the `ct:rate:*` Redis keys. Observe 429s via Workers Logs + an
   Analytics Engine `rate_limited` data point (the binding is not in the
   dashboard).
2. Stand up a Durable Object namespace for round-robin index, concurrency caps,
   and channel breaker state; DO single-threaded serialization replaces explicit
   Upstash locks.
3. Adopt D1 Sessions API for read paths and pass read-your-writes bookmarks so
   admin mutations are immediately visible to the mutating session.
4. Document all remaining cache key prefixes, TTLs, and invalidation triggers
   (KV/DO), and invalidate token/channel cache on admin mutations.
5. Define outage behavior: fail open only for non-critical cache reads; rate
   limit / concurrency controls fail closed or degrade to a local approximation.
6. Add staging smoke for Rate Limiting binding behavior, DO contention, and (if
   Upstash is still present) Upstash success/timeout/error responses.

Exit evidence:

- Rate Limiting binding enforces limits with no added hot-path egress; 429
  telemetry visible in Analytics Engine.
- DO atomic-state paths are covered by tests or staging smoke under contention.
- Cache invalidation is covered by tests or staging smoke.
- D1 Sessions API read-your-writes verified for a write-then-read admin path.
- Any retained Upstash outage mode is documented and observed.
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
- Scenario B requires a G5 report from
  `docs/admin-frontend-parity-runbook.md` before Rust becomes the admin source
  of truth.

Required tasks:

1. Choose the frontend deployment model: Worker static assets, Cloudflare
   Pages plus Worker API, or a documented temporary Go-hosted defer path.
2. Build the frontend staging deployment using Bun and record the source
   commit, build command, artifact path, route fallback behavior, and API base
   URL policy.
3. Migrate login/session flows, token management, channel management, model
   mapping, log search, user/quota management, billing settings, and system
   settings.
4. Make sensitive admin mutations write audit events and invalidate token,
   channel, model, group, option, and auth caches where relevant.
5. Add payment provider flows with webhook signature verification and idempotent
   event storage; use a Workflow per payment with `waitForEvent` for the webhook
   so reconciliation is durable and replay-safe.
6. Orchestrate async media task lifecycle (submit, upstream poll via
   `step.sleep/sleepUntil`, R2 artifact storage, settlement/refund) with
   Workflows for durable, idempotent, replayable steps; keep Queues for
   high-volume log fan-in and Cron only for scheduled cleanup/reconciliation
   triggers.
7. Use Durable Objects as the first realtime/session-heavy foundation: the
   Rust Worker now has a default-off `RealtimeSession` DO with WebSocket
   Hibernation accepts and socket attachments. The remaining decision is the
   `/v1/realtime` protocol bridge boundary: pure DO bridge first, or a
   Cloudflare Container fallback for provider-specific native WebSocket edge
   cases. Realtime billing also remains default-off: the D1 replay marker,
   guarded quota mutation, and Go-compatible audit row now have a batch/CAS
   foundation, but production still needs local/staging proof for applied,
   duplicate, guarded-update failure, audit failure, rollback, and
   no-double-charge paths.
8. Build and upload only the strict Rust/Wasm WFP tenant artifact. The generated
   JavaScript fallback is status-only and
   `/api/platform/wfp/tenant-script/deploy` is disabled. The uploader must
   validate the main shim, Wasm magic/import graph, and module hashes; bind only
   reviewed non-secret tenant configuration; reject every Cloudflare bearer,
   authority key/master, and replay namespace; and archive real PUT plus GET
   content, hash, and binding readback evidence. The platform master must remain
   on the main Worker only.
   Deploy the environment-specific outbound service separately. Its dispatch
   attachment must name the exact service/environment and declare only
   `CINATOKEN_WFP_OUTBOUND_CONTEXT`; its external `WFP_AUTHORITY_REPLAY`
   binding must point to the matching main Worker/class. Archive schema-3
   readback and prove live Dynamic Dispatch parameter propagation before paid
   canary. The local static Workerd object is contract evidence only.
   Admin dispatch may prove tenant status only. For paid smoke, seed
   `channels.other_info.wfp_worker`, temporarily arm
   `WFP_RELAY_TRANSPORT_ENABLED`, and call one of chat/responses/messages/ai-run
   through the normal relay token path. Prove signed-authority, missing/wrong
   invocation-context, final-path, and exact-body rejection cases cause zero
   provider calls, then prove exactly one central reserve followed by
   settlement/refund and audit for the accepted request.
   Prove the same envelope has exactly one winner under sequential and
   concurrent replay, alternate DO IDs are rejected, eviction/redeploy does not
   reset consumption, cleanup is late enough, and only one provider call is
   observed. This exact-envelope guard does not make a newly signed retry an
   exactly-once upstream execution. Then turn the transport gate off.
   `/v1/embeddings` is not in the tenant route set.

Exit evidence:

- Operator staging smoke passes without direct database edits.
- Frontend build, static asset/Pages route fallback, and auth/session smoke
  pass under the selected Cloudflare deployment model.
- Token/channel/user/model/option mutations have audit and cache-invalidation
  evidence.
- Payment replay cannot double-credit.
- Task retry cannot double-charge or lose artifacts.
- Frontend build and route checks pass under Bun.
- WFP evidence proves the Cloudflare dispatch namespace Scripts REST API,
  strict Rust/Wasm upload/readback, separate deploy/runtime credentials,
  `DISPATCHER` binding, authority rejection cases, and central billing/audit
  ownership before tenant traffic is routed through the new path.

No WFP upload, external-binding readback, signed-authority billing canary, or
live replay race has been completed or is claimed by this execution plan.

## Performance And Cost Plan

Target:

- Rust/Cloudflare improves global availability without introducing hidden cost
  or latency regressions.
- Performance, capacity, and cost evidence is produced through
  `docs/performance-capacity-cost-runbook.md` before canary expansion and full
  cutover.

Required tasks:

1. Define SLOs before canary:
   auth/route overhead, upstream first-byte overhead, non-stream added latency,
   stream first-token overhead, D1 mutation latency, billing mismatch tolerance,
   and queue lag.
2. Capture Go/VPS or owner-approved inferred baseline by route family,
   provider family, model, stream mode, and token group.
3. Run load profiles LT-001 through LT-007 for Scenario A, LT-008 before
   Scenario B, and LT-009 before async/task/media cutover.
4. Validate Worker CPU, memory, resource-limit errors, subrequests, D1 rows
   read/written, D1 query duration, Queue backlog, R2 operations, and Upstash
   commands/errors.
5. Forecast cost at current, 2x, and 5x traffic, including Worker requests and
   CPU, D1 reads/writes/storage, Upstash commands, log volume, Queue/R2 usage,
   and provider spend.
6. Verify cache hit rates, rate-limit behavior, and Redis failure mode under
   load.
7. Assign owners to the top bottlenecks and mitigation paths before promotion.

Exit evidence:

- 500-concurrency mixed relay test, or an agreed production-shaped equivalent,
  passes SLOs.
- D1 hot-path queries have bounded row reads and acceptable duration.
- Upstash failure-mode test does not corrupt D1 source-of-truth state.
- Soak or internal canary window shows no Worker resource-limit errors.
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
- Deploy the admin/frontend staging surface with the selected Cloudflare static
  assets or Pages model.
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

Canary mechanism (revised 2026-06-25):

- Primary control is Workers gradual deployments: split traffic between Worker
  versions by percentage, with instant version rollback. This satisfies the
  15-minute rollback requirement without DNS changes.
- Secondary control is business-scoped gating: internal tokens, then selected
  token/user groups, then route family. Use gating for who is exposed; use
  gradual deployments for how much of a new version is live.

Canary ramp:

1. Internal tokens only (gating), new version at a low gradual-deployment %.
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

1. Stop new Rust traffic: roll the gradual deployment back to the previous
   Worker version (fastest), and/or stop exposure by token group, route rule,
   feature flag, or DNS.
2. Keep Rust logs and D1 state immutable for investigation.
3. Reconcile any Rust-applied quota/payment deltas back to Go.
4. Rotate any secrets exposed during incident response.
5. Write a short rollback report before restarting canary.

## Production Evidence Checklist

Before G8 cutover, the repository or deployment runbook must contain:

- Route matrix with live smoke status.
- Provider matrix with channel types, model mapping, fallback, and smoke status.
- Redacted G3 route/provider parity report from
  `docs/route-provider-parity-runbook.md`.
- Table matrix with source counts, target counts, hashes, and rollback notes.
- Redacted data migration report from `docs/data-migration-runbook.md`.
- Billing matrix with expression coverage, settlement mode, and shadow deltas.
- Redacted billing parity report from `docs/billing-parity-runbook.md`.
- Redacted G5 admin/frontend/auth report from
  `docs/admin-frontend-parity-runbook.md`.
- Cloudflare binding checklist for staging and production:
  `docs/cloudflare-production-config-checklist.md`.
- Secret inventory without values and rotation owners.
- Observability dashboard and alert checklist.
- Security checklist.
- Redacted G6 observability/SLO/security report from
  `docs/observability-slo-security-runbook.md`.
- Redacted performance/capacity/cost report from
  `docs/performance-capacity-cost-runbook.md`.
- Cutover and rollback runbook:
  `docs/cutover-rollback-runbook.md`.
- Post-cutover monitoring checklist.

## Immediate Next Planning Milestones

1. Keep `docs/production-readiness-matrices.md` current as route, provider,
   table, billing, config, observability, security, and SLO evidence changes.
2. Use `docs/cloudflare-production-config-checklist.md` to replace
   placeholder staging resource IDs only after real resources exist.
3. Use `docs/staging-smoke-runbook.md` for the first real staging smoke and
   copy only redacted evidence summaries back into `docs/verification.md`.
4. Use `docs/cutover-rollback-runbook.md` to rehearse rollback before any
   customer canary.
5. Use `docs/data-migration-runbook.md` for the first production-shaped source
   inventory, export bundle, D1 SQL conversion, row-count check, sample-hash
   check, and rollback evidence.
6. Use `docs/billing-parity-runbook.md` to expand golden fixtures and produce
   a redacted shadow settlement report before any paid settlement canary.
7. Use `docs/route-provider-parity-runbook.md` to turn the current route and
   provider matrix into a G3 smoke report before any relay canary.
8. Use `docs/observability-slo-security-runbook.md` to define SLO thresholds,
   alert drills, redaction evidence, and security go/no-go before any customer
   canary.
9. Use `docs/admin-frontend-parity-runbook.md` to produce the G5 admin,
   frontend, auth/session, operator CRUD, cache invalidation, and audit report
   before Scenario B.
10. Use `docs/performance-capacity-cost-runbook.md` to produce the
    performance, capacity, and 1x/2x/5x cost forecast before canary expansion
    and full cutover.

## Realtime Paid-Traffic Subgate

Realtime is not covered by a generic WebSocket connectivity smoke. Before any
paid `/v1/realtime` canary, all of the following evidence is required:

1. D1 migrations are an exact 21-file set through
   `0021_realtime_billing_bridge_segments.sql` in the target environment. The
   reservation ledger was exported and reconciled with zero remaining
   `reserved` rows before both 0020 and 0021; each fails closed because active
   DO alarm or bridge ownership cannot be reconstructed during migration.
2. Reusing one logical session across an old and replacement bridge proves that
   response binding, settlement, terminal refund, and lease handoff affect only
   the owning bridge segment. A legacy attachment without segment metadata
   leaves recovery to its durable lease instead of issuing a session-wide refund.
3. A single connection completes at least two independently reserved cycles,
   binds distinct `response.created` identities, and settles their
   `response.done` events out of order with distinct correct audit rows.
4. Replaying either client `event_id` or upstream response identity produces no
   second debit, credit, request-count increment, channel increment, or log.
5. Insufficient user quota, insufficient token quota, and a forced guarded D1
   failure leave no partial reservation or quota mutation and do not forward
   the client event upstream.
6. Missing usage, local forward failure, disconnect, and upstream terminal
   failure each produce one documented refund outcome.
7. Two simultaneous settlement failures persist as two records; alarm retry,
   alarm replacement, DO eviction, and restart recover both without overwrite;
   retry exhaustion refunds rather than stranding reserved quota.
8. An active reservation lease is persisted before its D1 reservation becomes
   externally useful. A not-yet-due alarm leaves it reserved, while expiry
   after bridge loss, hibernation, eviction, or restart refunds it exactly once
   through D1 CAS. Forced D1 refund failures keep one redacted lease record and
   retry without a fixed attempt cap.
9. The settlement retry queue and active lease queue have exclusive ownership:
   moving work to settlement retry removes its lease, and retry exhaustion
   either refunds immediately or durably returns ownership to the lease queue.
   One alarm is always scheduled for the earliest deadline across both queues.
10. `REALTIME_BILLING_RESERVATION_LEASE_SECONDS` is derived from measured
   staging response-duration p99 plus approved retry/clock-skew margin, remains
   within `900..3600`, never falls below the 840-second bridge lifetime plus
   the mandatory 60-second safety margin, and has an alert for repeated
   expiry-refund attempts.
11. Public status, frontend capability output, Worker logs, and archived smoke
   artifacts contain hashes/metadata only, never raw prompts, event IDs,
   billing expressions, token IDs, or credentials.
12. Go/Rust reconciliation for the same frozen request inputs stays inside the
   approved quota-delta threshold, and rollback/refund ownership is named.

Until every item is archived from isolated staging,
`realtime_session_billing_settlement_compiled` and
`realtime_session_v1_cutover_ready` remain false.

## 2026-07-13 Realtime Recovery Subgate Supersession

This addendum supersedes the earlier 21-file Realtime migration wording. The
target must have the exact 24-file chain through
`0024_relay_billing_finalization_events.sql`. Migrations 0020 and 0021 still
require the documented zero-active-reservation freeze; 0022 is applied only
after those checks and while every Realtime admission, settlement-write, and
global-recovery gate is off.

The production sequence is:

1. Rotate the exposed Cloudflare credential, inventory account/resource
   ownership with a replacement least-privilege credential, and archive no
   secret values.
2. Freeze Realtime writes, reconcile the ledger to zero, apply all 24
   migrations to isolated staging, and verify 29 required tables, 106 key
   columns, 21 indexes, and exact migration-set readiness.
3. Deploy with both Realtime and HTTP relay recovery disabled, Realtime lease
   900, HTTP lease 3600, grace 300, and sweep limit 1. Capture admin
   capabilities and prove cron is inert. Migration 0023 must precede this
   deployment because tiered HTTP requests write the new ledger immediately;
   migration 0024 must precede any billing Queue consumer delivery.
4. Enable only global recovery for reviewed fixtures and complete every Phase
   4c case in `docs/staging-smoke-runbook.md`: grace no-op, post-grace refund,
   concurrent schedules, failed-head fairness, late settlement rejection,
   no-store hashed status, alert, and rollback.
5. Repeat the locally proven authenticated public reserve path against deployed
   staging, then add a live provider settlement retry across eviction/redeploy.
   Correlate D1 policy state with redacted DO status because neither D1 nor
   local Workerd can identify the running remote retry owner.
6. Expand the limit from 1 toward 32 only after measuring D1 queries, rows read,
   task-poller headroom, latency, errors, and cost. Values above 64 are rejected
   by the Worker.
7. Enable settlement writes and then `/v1/realtime` only after billing shadow,
   provider replay, observability, security, canary, and rollback approval. No
   single capability boolean is approval.

Rollback disables new Realtime admission first, then the global recovery gate.
Do not drop migration 0022 during an incident. Preserve D1 rows, reconcile each
terminal outcome and quota delta, and keep Go/VPS authoritative until G8 is
signed off.

## 2026-07-13 WFP Outbound Private-Ingress Deployment Gate

Before deploying or enabling paid WFP traffic:

1. Revoke the exposed Cloudflare token and issue separate least-privilege deploy
   and readback credentials. Never attach either credential to a tenant or the
   outbound runtime.
2. Build from the tracked config with `workers_dev=false`,
   `preview_urls=false`, and no `route`/`routes`; require
   `wfp_outbound_private_ingress_config_compiled=true` before smoke execution.
3. Deploy only to isolated staging, run the schema-3 outbound readback, and
   require workers.dev disabled, Preview URLs disabled, zero Custom Domains,
   exact service/environment/context parameter attachment, environment-correct
   replay binding, and outbound-only runtime secret ownership.
4. Enumerate all account Zones and Worker routes with the rotated credential;
   fail the gate if any route points to `cinatoken-wfp-outbound`. Archive only
   redacted names/status, never credential values.
5. Complete the remote main Worker -> Dynamic Dispatch -> Rust tenant -> Rust
   outbound -> AI Gateway/provider -> central settlement/audit canary and the
   documented negative cases. Rehearse removal of the namespace attachment and
   disable paid WFP gates before any production decision.

Compiled capability state alone cannot satisfy this gate. No remote evidence is
currently archived, so Go/VPS remains authoritative and production is
**NO-GO**.

## 2026-07-14 Ordinary HTTP Billing Finalization Workstream

This workstream supersedes any plan that treats clone-stream `waitUntil()` plus
lease renewal as sufficient HTTP billing durability.

1. Add an unbound reservation owner generation at reserve time. Every provider,
   AI Gateway, and model-fallback attempt carries that owner; bind requires the
   expected generation and an unexpired deadline. Recovery cannot refund or
   revive the same generation concurrently.
2. Close successful buffered-response clone/read/size failures. A delivered 2xx
   must produce a durable usage/finalization disposition rather than a silent
   missing-usage refund.
3. Replace dual-consumer accounting with one instrumented forwarding stream.
   Bound memory for text/tool estimation, classify clean EOF, done, malformed,
   upstream error, client abort, idle timeout, and Worker cancellation, and
   preserve reported usage before any failure.
4. Define a versioned `RelayBillingFinalizationEvent` containing only the
   reservation/event idempotency keys, frozen expression/request snapshot,
   bounded usage/termination metadata, and timestamps. It contains no prompt,
   response body, raw request id, credential, or client IP.
5. Bind a dedicated `BILLING_QUEUE` and DLQ. Its at-least-once consumer uses D1
   CAS to settle/refund/quarantine, treats matching delivery as success, exposes
   lag/retry/DLQ metrics, and supports an admin-authenticated reconcile action.
6. Run deterministic Workerd faults for pre-bind recovery race, D1 ambiguous
   commit, Queue duplicate/retry/DLQ, Worker cancellation, and recovery overlap.
   Then repeat the full direct/Gateway/WFP matrix in isolated staging beyond the
   original lease and post-response execution window.
7. Promote gates in order: implementation, explicit heartbeat/estimate config,
   stream renewal proof, abnormal termination proof, finalization replay proof,
   recovery fixture approval, then limited canary. Any unexplained pending row,
   double mutation, provider-call mismatch, or mutable-price replay returns
   traffic to Go/VPS and disables recovery first.

No ordinary HTTP request gains a Durable Object in this workstream. The Rust
gateway owns finance, WFP owns authorized transport, Realtime DO owns stateful
WebSocket sessions, and D1 plus Queue own durable finalization. Until steps 1-7
are archived, HTTP orphan recovery and production remain **NO-GO**.

Implementation status on 2026-07-14: step 4's bounded frozen-decision event and
step 5's default-off producer, per-message consumer, D1 CAS replay, unique audit
marker, retry policy, environment-specific DLQ/parking queues, migration-0025
incident ledger, and root + step-up single-event reconcile command are locally
implemented. Workerd proves matching duplicate ACK/no-double-mutation,
cross-queue retry, poison isolation, valid/invalid DLQ quarantine, redaction,
authorization, queue-mediated replay, incident completion, and duplicate admin
replay rejection. Step 5 remains Partial because authenticated remote resource
readback, retry exhaustion, four-day-retention alerts, and the deployed fault
drill are absent; both Queue and reconcile gates remain false and the runtime/
cutover predicate stays false. Steps 1-3 and the deployed matrix in steps 6-7
also remain open.

### Step 5a: Staging Reconcile Promotion Order

1. Rotate the exposed credential and verify the target account without storing
   the replacement value. Apply migration 0025 while Queue and reconcile gates
   remain false.
2. Create and authenticate-read back the producer, primary consumer, DLQ,
   DLQ consumer, and environment-specific parking queue. Archive batch, retry,
   and dead-letter ownership without message payloads.
3. Attach lag, oldest-message, DLQ-ingress, and reconcile-failure alerts. Name
   an operator response that acts before Cloudflare's four-day retention.
4. Enable Queue only for an isolated fixture. Prove normal, duplicate, retry-
   exhaustion, D1 unavailable, and identity-conflict paths before enabling the
   reconcile endpoint.
5. Enable reconcile for one explicit incident. Require root plus fresh step-up,
   `202 queued`, one manage audit, one financial CAS, terminal resolution, and
   duplicate rejection. Disable reconcile immediately after the drill.
6. Reconcile provider calls, user/token/channel quota, request count, ledger,
   billing audit, manage audit, Queue attempts, incident state, and cleanup.
   Any unexplained delta or raw payload/secret leakage is an immediate abort.

## 2026-07-14 HTTP Pre-Bind Owner Generation Rollout

This sequence supersedes instructions to apply only migrations 0023-0025 or to
enable HTTP recovery after stream-heartbeat proof alone.

1. Rotate the exposed Cloudflare credential. Use separate least-privilege
   deploy and readback credentials and archive names/status only.
2. Freeze old and new Rust relay admission. Drain Queue/DLQ work and reconcile
   every HTTP billing row until `status='reserved'` is zero. Keep Go/VPS
   authoritative.
3. Apply the exact migration set through 0030 in isolated staging. The 0026
   guard must reject a nonzero active count, 0029 must reject an empty flat
   snapshot while preserving an old tiered writer, and 0030 must reject later
   mutation of reservation identity and financial-contract fields. Verify 30
   migrations, 30 tables, 139 checked incremental columns, 27 indexes, and
   exact-set state.
4. Deploy with Queue, reconcile, orphan recovery, and staging-proof flags false.
   Explicitly configure the reservation deadline and heartbeat. Require owner
   generation compiled/schema/configured true and staging/cutover false.
5. Execute Phase 4f from `docs/staging-smoke-runbook.md`: delayed headers,
   timely/late bind, direct/Gateway/model fallback, exact D1 readback,
   L+300/L+301, terminal/recovery races, Worker interruption, Queue schema-v2
   duplicate delivery, and disable-first rollback.
6. Enable Queue only for isolated v2 fixtures after resource readback and
   alerts. Drain legacy v1 events only at generation 1. Never recreate or
   downgrade a generation during incident replay.
7. Promote proof metadata only after signed provider-call and accounting
   reconciliation with zero pending rows. Recovery and cutover still require
   finalization, observability, security, performance, and G1-G8 gates.

Rollback order is recovery off, reconcile off, Queue finalization off, new Rust
admission off, traffic to Go/VPS, then ledger/Queue drain and reconciliation.
Retain migrations 0026-0030 and the highest generation/Realtime finalization
owner. No remote evidence is
currently archived, so production remains **NO-GO**.

## 2026-07-14 Realtime Usage Reconciliation Rollout

1. Keep Go/VPS authoritative. Rotate the exposed Cloudflare credential and use
   a separate scoped deploy identity from the readback identity.
2. Freeze new Realtime admission, drain or explicitly classify every active
   reservation, and archive redacted counts by status/finalization owner.
3. Apply 0027 through 0030 with `REALTIME_SESSION_V1_ENABLED=false`, settlement
   writes false, reconciliation mutation false, and global orphan recovery
   false. Require exact 30-file migration readback, 139 checked columns, 27
   indexes, immutable-contract negative probes, and both reconciliation
   capability signals compiled/schema-ready.
4. Enable one isolated fixture. Replay valid completed/cancelled/failed/
   incomplete usage plus missing identity, missing/null/malformed/negative/
   inconsistent/completed-zero usage, D1 ambiguity, client disconnect, provider
   disconnect, DO eviction, Worker redeploy, and scheduled-recovery races.
5. For every ambiguous case require one retained pre-consumption, owner
   `usage_reconciliation`, no terminal refund/settlement/replay/audit mutation,
   no raw identity in API/UI/logs, an alert, and provider invoice correlation.
6. Review the landed operator resolution contract before enabling it: root plus
   fresh step-up, frozen-expression preview, controlled evidence, revision and
   idempotency fences, one financial/audit batch, replay convergence, and
   disable-first rollback. Add the production dual-control and bounded evidence
   retention policy; quarantine rows must never be mutated by ad hoc SQL.
7. Promote Realtime traffic only after zero unexplained rows, signed accounting
   reconciliation, alert/retention ownership, load/cost evidence, disable-first
   rollback rehearsal, and G1-G8 approval.

## 2026-07-14 QuotaCoordinator Shadow Rollout Order

This sequence applies only to tiered-expression observation. It must never be
used to move financial writes during the shadow phase.

1. Deploy the `QUOTA_COORD` class and both false gates with Go/VPS and D1 still
   authoritative. Verify binding/migration readback and summary redaction; do
   not infer readiness from class availability.
2. Audit the compiled best-effort producers for D1 reserve, synchronous
   settle/refund, billing Queue finalization/replay, and orphan recovery against
   the exact deployed candidate. Local source and Workerd coverage exist; a DO
   failure must remain observable without changing the committed D1 outcome.
3. Prove the per-token storage model under long-lived hot-token load, including
   record-size headroom, capacity/compaction behavior, eviction, duplicate and
   conflict storms, corruption propagation, cost, and alert thresholds.
4. Enable shadow only for isolated staging tokens. Reconcile asynchronously off
   the relay hot path and retain redacted evidence for every producer family.
5. Run at least 30 days with zero unexplained quota, request-count, channel-
   usage, settlement, refund, and audit deltas. Exercise disable-first rollback
   repeatedly while D1 continues to serve every financial read and write.
6. Set staging verification only after owner sign-off. Any later read-authority
   proposal requires a separate design/review/gate; write authority requires an
   additional migration and is not enabled by this foundation.

Rollback is `QUOTA_COORD_SHADOW_ENABLED=false` first, followed by observer
emission off and reconciliation drain. Preserve DO evidence for audit; do not
compensate quota from observer state. D1 and Go/VPS ownership are unchanged.

Current local status: producer coverage and bounded commit-watermark compaction
are complete and config-audited. The configured maximum fixture is 1,234,821
JSON bytes behind a 1,500,000-byte write guard. Every tracked environment keeps
`QUOTA_COORD_RETENTION_VERIFIED=false`,
`QUOTA_COORD_SHADOW_ENABLED=false`, and `QUOTA_COORD_SHADOW_TOKEN_IDS` empty.
Shadow enablement is blocked until step 3 produces deployed load, window-
duration, structured-clone-size, cost, eviction, and alert evidence;
then staging may set a bounded allowlist before opening the shadow gate. This is
not staging evidence and does not change the production **NO-GO** decision.

## 2026-07-14 Flat Pricing Admission And 0030 Rollout

1. Keep Go/VPS authoritative and rotate the exposed Cloudflare credential.
   Preserve separate least-privilege deploy and readback identities; never put
   their values in the evidence packet.
2. DONE locally: generate the schema-1 immutable flat-pricing manifest from Go
   baseline `73652508abc5`; bind source/generator/template hashes, 10 terminal
   cases, 8 admission/pre-consume cases, and the exact final integer quota.
   Regenerate and sign it again at the approved cutover commit.
3. DONE locally for synchronous Ali images: native generation/edit conversion,
   bounded multi-image multipart input, source-compatible actual-count
   precedence, immutable flat-snapshot adjustment, secret-free provenance,
   file-17/part-header/response-memory guards, URL-only `b64_json` 502/refund,
   compact metadata, and a bounded `ALI_SYNC_IMAGE_MODELS` override. Freeze the
   production override against Go `SyncImageModels` in the signed canary packet.
   Next, close Ali asynchronous task settlement, free-model runtime policy, and
   provider usage staging reconciliation. Keep
   `relay_flat_billing_go_parity_ready` hard false until those gaps and remote
   reconciliation are exact.
4. Apply migrations through 0030 in isolated staging with all Queue, recovery,
   reconciliation, and staging-proof gates false. Archive exact-set readback,
   then prove direct D1 attempts to mutate every protected financial field are
   rejected without changing the row.
5. Run strict, site-self-use, and per-user-unset admission across direct,
   AI Gateway, and WFP. For rejection require zero provider calls and zero
   ledger/quota/audit mutation; for admission require one frozen ratio 37.5,
   one provider call, and one terminal Queue/D1 outcome.
6. Replay fixed and per-token success, body limit, malformed usage, client
   abort, upstream idle, clean EOF, Queue duplicate, DLQ, D1 ambiguity, Worker
   interruption, and disable-first rollback. Correlate provider invoice, user,
   token, channel, request count, reservation, Queue, and audit identities.
7. Promote the staging-proof flag only after signed zero-delta reconciliation,
   alert/runbook ownership, retention evidence, and rollback rehearsal. The
   proof flag cannot override the compiled source-parity predicate.
8. Allow a bounded internal-token canary only after G1-G6 pass. Broader rollout
   still requires G7 and G8 approval; any unexplained financial delta returns
   traffic to Go/VPS and drains the Rust ledger before retry.

No authenticated remote evidence is currently archived. This sequence is a
runbook, not a release authorization; production remains **NO-GO**.

## 2026-07-17 Provider Attempt Journal Rollout Order

This rollout is blocked at step 0. The landed code is a default-off local
contract, not permission to deploy provider execution.

0. Complete the missing atomic provider egress broker, Container client,
   global terminal acknowledgement, and attempt-aware multi-generation R2
   contract. Keep retry hard disabled. Review the broker's credential,
   allowlist, absolute-deadline, response-bound, idempotency/lookup, terminal-
   classification, and redaction design before any remote journal drill.
1. Build and sign the real linux/amd64 image. Archive digest, SBOM, signature,
   vulnerability scan, non-root/no-SSH/no-internet configuration, and exact
   Controller commit. Do not use a mutable image tag as evidence.
2. Deploy the Controller first with journal, retry, staging proof, execution,
   storage actions, readiness wake, and edge routing all false. Verify private
   Service Bindings, DO class/migration, Container class, image digest, D1/KV/R2
   resource IDs, account/zone, compatibility date, and secret names without
   recording secret values.
3. Prove N/N-1 before execution: old Worker -> new Controller uses unchanged
   status v1; new Worker -> old Controller receives exact v2 route-not-found
   and falls back to v1; new Worker -> new Controller accepts v2; malformed or
   contradictory attempt snapshots fail closed. Roll Controller forward first
   and back last.
4. In an isolated non-provider fixture, exercise DO start/dispatch/terminal
   persistence across eviction, duplicate dispatch, stale generation, prepared
   deadline cancellation, dispatched deadline ambiguity, R2 write followed by
   attach failure, and capacity retention with missing global ack. The journal
   flag remains false for real Container operations during this proof.
5. After the broker and Container client exist, enable only journal plus the
   minimum storage gates for one deterministic local provider fixture. Keep
   retry false and max attempts 1. Prove one schedule, one prepared row, one
   send grant, one provider invocation, one result object, one terminal event,
   one global ack, and one exact replay under client retry and Worker/DO/image
   restart races.
6. Run the provider fault matrix: definite pre-send rejection, connection
   failure before known send, timeout after dispatch, partial response,
   oversized response, provider 429/5xx, result PUT ambiguity, DO attach
   ambiguity, Container OOM, host restart, sleep/wake, Controller redeploy, and
   mixed protocol versions. Any dispatched uncertainty must converge through
   recovery without a second provider call.
7. Reconcile provider invoice, operation, R2, terminal/outbox, reservation,
   settlement/refund, request count, channel usage, and audit identity. Require
   zero unexplained rows, alerts and retention ownership, measured load/cost,
   and a disable-first rollback rehearsal before setting any staging-proof
   value.
8. Retry remains a separate later release. It requires a DO-owned scheduler,
   exact definite-reject allowlist, bounded delay/horizon, max 2 for initial
   rollout, a versioned R2 key/manifest, generation-fenced result attachment,
   global terminal acknowledgement, duplicate alarm proof, and its own signed
   candidate and approvals. The current runtime intentionally rejects retry.

Rollback order is edge Container routing off, journal admission off, execution
off, storage writes off, then Controller/image rollback after in-flight
operations are classified and globally acknowledged. Preserve DO attempts,
events, R2 objects, D1 operation/financial rows, and provider evidence. Never
delete an unacknowledged attempt to regain capacity. Go/VPS remains the traffic
and financial authority throughout these steps; production remains **NO-GO**.

## 2026-07-17 Terminal Outbox Acknowledgement Rollout Order

This sequence remains blocked before remote step 1. Local code and tests are not
authorization to enable the feature.

0. Preserve migration 0046 and confirm remote migration 0042 exact schema,
   triggers, indexes, and immutable terminal/outbox rows. Do not create an ad
   hoc acknowledgement migration.
1. Deploy the Controller first with
   `CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED=false` and
   `CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED=false`. Verify the private
   edge binding target, Durable Object class/migration, all resource IDs,
   authority key names, compatibility date, and generated Env types without
   recording secret values.
2. Prove Controller N/N-1 before enabling: an old edge Worker ignores the new
   route; a new edge Worker receiving exact `404 route_not_found` from an old
   Controller retains and retries the D1 row; a new Controller accepts the
   strict signed body; malformed, oversized, unsigned, cross-shard, and
   conflicting bodies fail closed.
3. Deploy the edge Worker with `CONTAINER_TERMINAL_OUTBOX_ENABLED=false` and
   `CONTAINER_TERMINAL_OUTBOX_STAGING_VERIFIED=false`. Archive deployed config,
   binding, route, and D1 schema readback. Confirm the aggregate status endpoint
   remains admin-only and identifier-free.
4. In isolated staging, enable Controller acknowledgement only. Seed immutable
   non-provider fixtures for completed, failed, recovery revision 1, and ordered
   revision 2. Exercise duplicate delivery, stale/expired leases, Controller
   timeout/503/429, authority rotation, old-route 404, permanent conflict,
   Worker interruption after remote acceptance, overlapping schedulers, and DO
   eviction. Confirm journal-disabled operations use the dedicated ACK table.
5. Review the archived results, then set the edge staging proof and bounded
   producer gate for at most four rows per Cron. Require one Controller result
   for each D1 event, exact duplicate convergence after lost responses, zero
   skipped revision-2 predecessors, zero unexplained dead letters, and bounded
   backlog/latency/cost.
6. Reconcile terminal event, outbox state, global operation, reservation,
   accounting, audit, Controller operation, provider retry state, attempt
   events, R2 manifest, and provider invoice. Any missing identity or financial
   delta disables the edge producer and leaves all rows retained.
7. Keep compaction false. A separate future release must add complete
   execution-provenance evidence, retention/archive policy, authenticated
   readback, restore proof, and explicit approval before any path can write
   `compaction_authorized_at`. Before 0046 database enforcement, prove every
   old financial writer is drained and the deployed writer rejects revision 2
   without the exact revision-1 recovery predecessor.
8. Only after remote fault/load/cost/alert evidence, rollback rehearsal,
   provider idempotency or lookup, financial convergence, and C1-C5/G1-G8
   approval may this acknowledgement chain become a cutover prerequisite.

Rollback order is edge producer gate off, allow active 30-second leases to
complete or expire, reconcile pending/leased/dead-letter rows, Controller
acknowledgement off, then Controller rollback. Never clear D1 outbox or DO
journal rows to make rollback appear complete. Go/VPS remains authoritative and
production remains **NO-GO**.
