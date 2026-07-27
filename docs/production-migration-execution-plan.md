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
Migration 0042 is an expand-only event/identity contract and does not authorize
any of these flags. Migration 0046 is now implemented locally as the separate
trigger-only enforcement boundary, but it must not be applied remotely until
the old Cloudflare/D1 writer cohort is drained and the pre-enforcement audit is
clean. Go/VPS does not write the Container operation or terminal-event tables;
its traffic and financial-authority drain remains a separate cutover concern.

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
| G1 | Cloudflare staging foundation | Staging Worker has authenticated, verified D1/KV/R2/Queue/DO/Upstash/provider bindings | Rotated credential evidence; authenticated resource and secret-name readback; disabled provider-egress, Controller, then edge reader deployment; remote 0001-0051 with every action gate false; drained 0052 followed by 0053, then default-off 0054, 0055, and 0056 apply/readback; `/api/status`, generated binding types, logs visible | Live smoke and canary |
| G2 | Data dry run | D1 migrations cover production-critical tables and are applied to remote staging | Source counts/hashes, staging import report, verification report, rollback export; local 56/56 replay with 64 tables, 814 checked incremental columns, and 94 key indexes plus clean 0052/0053/0054/0055/0056 pre/post audits are prerequisites only | Any data cutover |
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
| Data migration | Partial: local exact-set SQLite replay passes 56/56 migrations, 64 tables, 814 checked incremental columns, and 94 key indexes; 0052 adds drained immutable provider/client response evidence, 0053 adds financial terminal v2, 0054 adds the immutable shard activation ledger, 0055 adds one-time campaign authority, and 0056 adds ordinary HTTP SSE handoff plus exact apply receipts while every new gate remains false; historical remote evidence is older | Reversible source export, D1 import, row/hash verification, and rollback bundle | Authenticated reader-first remote staging apply with all gates false; exact writer/version inventory; pre-0052 drain; ordered 0052 through 0056 backup/apply/readback/post-audit; immutable negative probes; unchanged business fingerprint; real source inventory; staging import report; rollback point |
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

1. Stop new Rust traffic with token-group, route, feature, or DNS gates first.
   A Cloudflare rollback replaces a split deployment with one selected version
   at 100% traffic, so never interpret "previous" as automatically safe. Roll
   back only to a pre-recorded, rehearsed artifact that is compatible with the
   current D1 schema, bindings, and Durable Object lifecycle; otherwise keep
   traffic gated away and deploy a reviewed compatible recovery artifact.
2. Preserve Rust logs and D1 evidence and block unrelated D1 mutation. If the
   current schema has durable operation/outbox/recovery work, keep exactly one
   inventoried, schema-compatible recovery artifact as the sole writer until
   those ownership/lease inventories reach zero; only then freeze D1 fully for
   investigation.
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

## 2026-07-17 Migration 0046 Enforcement Rollout

Migration `0046_relay_container_financial_terminal_enforce.sql` is locally
implemented and verified, but has not been applied to a remote D1 database. It
creates four triggers and performs no table/index creation, backfill, update,
delete, or synthetic event write:

1. every new protocol-v1 operation must carry exact lowercase 64-hex client
   idempotency, request, and reconciliation identities;
2. every new protocol-v1 operation must begin in `prepared`, closing the direct
   terminal-insert bypass;
3. every protocol-v1 terminal status update must already have the exact
   immutable terminal event and its matching outbox state; and
4. every revision-2 event must have the exact earlier revision-1 recovery
   predecessor for the same operation, owner generation, reconciliation ID,
   billing generation, and time order.

Historical legacy and eventless terminal rows are not rewritten. Therefore
0046 is an enforcement boundary, not a repair migration. Before applying it,
operators must reconcile every active legacy operation, every terminal event
without outbox state, and every revision-2 predecessor gap. An old
Cloudflare/D1 writer becomes incompatible after 0046; Go/VPS is not that writer
because it does not write these Container tables.

The remote sequence is mandatory and ordered:

1. Keep all Container admission, execution, terminal, reconciliation, retry,
   outbox, canary, and compaction gates false. Apply only through 0045.
2. Deploy the 0046-compatible Worker candidate while 0046 is still absent.
   Archive its Worker version/deployment ID, artifact hash, traffic percentage,
   Queue consumers, Cron/alarm owners, and deployment timestamp `Tdeploy`.
3. Move every request, Queue, Cron, alarm, recovery, and maintenance ownership
   path off every pre-0046 writer. After readback proves the candidate is the
   sole Cloudflare/D1 owner, record `Tdrain`; this is the value passed to the
   audit, not `Tdeploy`. Any old owner, isolate, scheduled event, or Queue
   consumer observed again invalidates the signed inventory, its SHA-256, every
   prior preflight JSON, `Tdrain`, and the entire observation window. Recollect
   and sign the full owner inventory, generate a new digest, and record a new
   `Tdrain` only after sole-owner readback passes again.
   Compute that window as the maximum old isolate, request, Queue, Cron, alarm,
   deployment, active operation deadline, and owner lease lifetime plus an
   approved safety margin. The audit tool enforces an 86,400-second floor, but
   that floor is not proof that the computed remote maximum is only one day.
4. Run the read-only preflight after the computed window and archive its JSON:

   ```powershell
   bun tools/audit_relay_container_enforcement_readiness.mjs `
     --database <staging-database> --wrangler-env staging `
     --account-id <lowercase-account-id> `
     --database-id <lowercase-d1-uuid> `
     --candidate-version <worker-version-id> `
     --deployment-inventory-sha256 <lowercase-sha256> `
     --drain-started-at <Tdrain-unix-seconds> `
     --minimum-drain-seconds <computed-window> --phase pre --json
   ```

   `snapshotReady=true` is one D1 snapshot, not rollout authorization; the
   report always returns `authorizesEnforcement=false`. The snapshot requires
   the exact 45-row pre-enforcement migration set, no 0046 trigger or trigger
   body,
   a complete drain window, zero open protocol-v1 operations regardless of
   whether they began before or after `Tdrain`, zero new/active legacy
   identities, zero suspected direct non-`prepared` inserts, zero recent
   terminal rows lacking exact event-plus-outbox evidence, zero terminal
   events without outbox state, and zero revision-2 predecessor gaps. The
   Wrangler first resolves the database through an ephemeral config pinned to
   the supplied account and fails if its UUID differs. The subsequent read uses
   that verified UUID, not the database alias; the target account, database
   UUID/name/argument, and Wrangler environment are embedded in the report. The
   aggregate report is also bound to the signed deployment inventory by its
   lowercase SHA-256, but it does not independently verify that inventory,
   continuous old-writer absence, or the computed lifecycle upper bound. Those
   external proofs plus named approval remain mandatory.
5. Execute the freeze in this exact order: block every new application, admin,
   Queue, Cron, alarm, DO, and maintenance write to the target D1; wait for and
   prove all in-flight writes have finished; verify the target UUID and that
   `wrangler d1 info` reports the production backend; verify the active plan's
   retention window covers the rollback exercise; capture the pre-apply
   disaster-recovery Time Travel bookmark; then archive the migration ledger,
   trigger SQL, aggregate report, active-operation inventory, and a full
   application-data fingerprint. The fingerprint is a logical-export SHA-256
   plus deterministic per-table row counts/hashes/high-watermarks for every
   application table.
   Apply 0046 as the only permitted writer, using the stable database name and
   an account-pinned migration config whose D1 name/UUID/environment exactly
   match the audited target. Re-resolve and compare the UUID immediately before
   apply; archive the exact command, migration receipt, and post-apply target
   readback. The only allowed logical delta is the exact 0046 migration-ledger
   row plus its four trigger definitions; application-table DML must remain
   zero.
6. Rerun the audit with `--phase post`. `snapshotReady=true` must include the
   exact normalized body of all four local 0046 triggers, not merely their
   names, while still returning `authorizesEnforcement=false`. Prove direct D1
   negatives for empty identity, terminal initial state, eventless/outbox-less
   terminal update, and revision-2 without predecessor. Put every probe's
   fixture statements and expected failing statement in one `D1Database.batch()`
   so the failure rolls back the entire sequence. Require the expected failing
   statement ordinal and exact 0046 trigger message; a foreign-key, uniqueness,
   unrelated-trigger, transport, timeout, or ambiguous response is a failed
   probe, never a pass. The four expected messages are, respectively,
   `relay container v1 operation identity is required`,
   `relay container v1 operation must start prepared`,
   `relay container terminal transition requires event and outbox`, and
   `relay container revision 2 predecessor is missing`. After every probe,
   recompute the full application-table hashes, counts, and high-watermarks and
   require an exact match with the post-migration baseline.
7. Branch on post-apply validation. On success, archive the complete evidence
   packet, then restore only the pre-inventoried non-Container D1 writers in
   controlled waves with count/head/set readback after each wave. Also compare
   the Container-table row counts, hashes, and high-watermarks plus the exact
   writer artifact/route/Queue/Cron/alarm inventory after every wave; any
   unexpected delta immediately refreezes all writers. Keep every
   Container admission, execution, terminal, reconciliation, retry, outbox,
   canary, and compaction gate false; a clean 0046 postflight grants no traffic
   or financial authority. On failure, keep every writer frozen and quarantine
   the database. Compare the complete pre/post application-data fingerprints.
   Named data-owner and SRE approvers may authorize an in-place Time Travel
   restore only when every application table is unchanged and the exact 0046
   ledger row plus four trigger definitions are the only logical differences.
   Before restore, reconfirm `version: production`, bookmark validity inside the
   30-day Paid or 7-day Free retention window, target UUID, and all-writer
   freeze. The restore overwrites the database and cancels in-flight queries,
   so archive the failed state, the complete restore receipt, and the returned
   previous/undo bookmark; then revalidate the restored ledger and full
   fingerprint before any retry. Any application DML, incomplete full-database
   evidence, or uncertain writer provenance forbids restore: keep the database
   quarantined, route new traffic to Go, preserve the 0046-compatible recovery artifact, and
   ship a separately reviewed forward repair migration. Never delete a trigger,
   rewrite the ledger, or use an N-1 writer as repair.
8. Rehearse normal operational rollback without removing 0046: route new
   traffic back to Go, disable Rust admission first, retain the 0046-compatible Rust recovery
   writer for existing D1 operations, drain outbox leases, and roll the
   Controller back last. Never delete triggers, edit `d1_migrations`, or deploy
   an N-1 writer that emits the legacy empty identity.

N/N-1 acceptance is asymmetric. The new candidate must run against schema 0045
before enforcement. Once schema 0046 is applied, only 0046-compatible writers
may write Container operations; rollback is code/gate rollback to a compatible
artifact, not schema rollback. Time Travel is an exceptional destructive
recovery branch for a failed validation with zero application DML and only the
exact expected 0046 ledger/trigger delta, not routine rollback. See Cloudflare's
[D1 Time Travel restore contract](https://developers.cloudflare.com/d1/reference/time-travel/).
Frozen billing-expression snapshots and actual usage settlement semantics are
unchanged by this migration.

The authenticated `/api/platform/capabilities` readback is phase-specific. On
schema 0045 it must report applied count 45, latest 0045, expected migration
0046, `d1_expected_migration_applied=false`, and `d1_migration_ready=false`;
that false value is the expected default-off pre-enforcement state. After a
valid 0046 apply it must report count 46, latest/expected 0046,
`d1_expected_migration_applied=true`, exact-set match, and readiness true.
Trigger-body evidence comes from the readiness CLI or direct `sqlite_master`
readback, not `/api/status` or the capability response.

The trigger set is defense in depth, not a substitute for writer provenance.
The approved writer must still prove one D1 batch ordered as terminal event,
outbox, operation transition, billing transition, and accounting mutations.
The event/outbox trigger can reject an incomplete operation transition, but it
cannot by itself attest that every later financial statement in that batch was
issued by the approved artifact. Archive the exact candidate version, batch
contract tests, remote trigger SQL, and post-apply negative probes together.

No remote D1 mutation, deployment, traffic switch, secret provisioning, or
provider call is claimed here. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-18 Migration 0050 Atomic Admission Rollout

Migration `0050_relay_container_atomic_admission.sql` is implemented in the
local source tree for the bounded non-streaming Container chat canary. The Rust
path constructs a stable reservation identity from the client idempotency HMAC,
freezes the billing and selected-route contract, writes the R2 input, and then
uses one receipt-first D1 batch for the receipt, all current/previous HMAC alias
claims, reservation, user/token debit, channel authority recheck, and
generation-2 prepared operation. Completed local validation reports Workerd
14/14, Worker Rust 820/820, and SQLite 50 migrations / 48 tables / 540
incremental columns / 72 key indexes; the repository-wide `bun run check`, now
including the root Worker Wrangler dry-run, also passes. No remote apply,
Worker deploy, Container start, provider
request, financial mutation, or traffic switch is claimed.

The final application gate remains
`container_chat_canary_admission_compiled() == false`. The separate atomic
implementation and schema-ready functions do not authorize activation. The
aggregate capability endpoint, migration-head audit, and full SQLite verifier
now incorporate 0050 locally. Their authenticated remote readback and the full
cutover predicate remain mandatory before a rollout packet can be considered
complete.

### Non-negotiable admission contract

- One tenant-scoped client idempotency HMAC over user ID, token ID, and the
  validated `Idempotency-Key` maps to one
  `relaycontainer-v1-{client_idempotency_hmac_sha256}` reservation key. The key
  does not include model, selected group/channel, transformed provider input,
  or pricing, so mutable planning drift cannot allocate a second reservation or
  debit.
- The client request-conflict digest is only model plus the original request
  body. A different model/body under the same tenant-scoped key is a request
  conflict. Provider transformation does not change this digest.
- The atomic digest separately protects the persisted winner's billing,
  selected group/channel/type/snapshot key, transformed input, shard, and
  provider-operation facts. These are admission authority, not client identity.
- The current secret defines the canonical reservation/operation identity. The
  receipt stores `idempotency_alias_count` plus the order-independent
  `idempotency_aliases_sha256` digest of the sorted, length-framed
  current/previous alias set, as well as the frozen
  billing snapshot digest, selected channel type/key, group, channel,
  user/token/quota, owner generation 2, owner deadline, and attempt generation
  1. Flat settlement resolves the frozen snapshot with that snapshot key, not
  `channel_id`.
- Three-record settlement revalidation runs in both the quote and final
  financial commit: each rereads receipt, reservation, and operation,
  recomputes the billing snapshot SHA-256 and complete atomic admission digest,
  and rejects before mutation if any record diverges.
- `PRAGMA defer_foreign_keys = ON` allows the immutable receipt to be inserted
  first, followed by every immutable alias claim before the reservation. The
  alias HMAC is a global primary key. Guard statements make every required
  mutation exactly one row; any alias collision, quota, authority, trigger,
  uniqueness, or row-count failure rolls back the entire batch, after which
  readback queries all aliases for the persisted winner.
- User status/deletion/quota, token owner/status/deletion/expiry/quota, and
  channel status/type/group/model authority are rechecked inside the batch.
- After request parse, model/auth resolution, and relay rate limiting, replay
  derives current/previous tenant HMAC candidates plus the model/original-body
  digest and queries immutable `relay_container_idempotency_aliases` as the
  authority. Retry/model fallback, current channel pools, affinity, provider
  transformation, ordinary reserve/debit, and upstream send occur after a miss
  only when a successful 0050 history probe also proves durable history is
  empty and replay-only mode is inactive. Any miss with existing history
  returns 503 because an older secret generation may be absent. A match resumes the persisted winner and
  uses its stored channel/group for dispatch, settlement, and audit; a disabled
  or removed current channel cannot block lookup. Schema/query failure or
  partial linkage is never a client conflict: it returns a server-side 503
  integrity failure.

### Default-off replay-only rollback foundation

The current source contains a separate replay-only path, but it is not a
production activation claim. `CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED` and
`CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED` each default to false and accept
only exact `true`. The former enables replay lookup only for the bounded
route/token/model cohort; the latter is an additional fence for a persisted
`prepared` operation. The final new-admission compile gate remains false.

New admission is canonical-current-write: the current secret names the
reservation and operation, while the same deferred-FK batch claims both the
current HMAC and a distinct previous-key HMAC as immutable aliases. Replay reads
current then previous candidates through that alias authority. The previous
key is read authority for the persisted canonical winner, never a separate new
write identity. A global alias collision rolls the entire attempted admission
back; authoritative readback then returns the persisted winner or an immutable
conflict. This is what prevents rolling versions with different current keys
from allocating two reservations or operations. Previous-key retirement
therefore requires a proved drain, not a blind rotation.

The recovery path fails closed when alias authority is unavailable. Every
eligible idempotent request probes 0050 history, including requests for which a
current or previous secret is configured. Missing or incomplete schema,
history/alias query errors, immutable linkage conflicts, and any alias miss
while durable history exists return 503. Ordinary relay processing after a
miss may continue only when the history probe succeeds, reports no 0050
history, and replay-only mode is inactive. This strict rule remains until
secret-generation/key-ID coverage and bounded retention are implemented and
proved, so a dropped old key cannot turn a replay into a new provider call.

The execution order is request parse, model/auth, relay rate limit, replay
identity plus 0050 lookup, and only then retry/model-fallback parsing, current
channel discovery/selection, affinity, provider-body transformation, ordinary
billing pre-reserve/debit, and upstream send. On an active replay-only miss,
the Worker returns HTTP 503 with `Retry-After: 5` and must not enter any later
reserve or upstream path. Completed/failed owners are read-only terminal replay
only when exact-response replay is enabled and `FILE_BUCKET` is available;
otherwise they return HTTP 202 pending. `dispatched`/`recovery_required` require
their Controller/replay readiness. Before a `prepared` row can advance in D1,
the Worker additionally requires operation replay readiness, scheduler
enablement, a valid ring and routing secret, the explicit prepared-resume gate,
and a verified Controller status proving binding, authority, controller
enablement, and execution enablement. A closed state gate leaves the row
`prepared` and returns HTTP 202 pending evidence without a new admission.

### Ordered rollout phases

| Phase | Required action | Exit evidence | Abort condition |
| --- | --- | --- | --- |
| A0 credential containment | Revoke/rotate the exposed Cloudflare credential; issue separate least-privilege deploy and readback identities | Rotation record with names/scopes only, never values | Any known credential remains usable or appears in logs/files/CLI history |
| A1 candidate freeze | Sign the exact Worker/Controller/Container/broker commits and migration 0050 hash; keep all Container, provider, terminal, reconciliation, scheduler, canary, replay-only, and prepared-resume gates false | Artifact inventory, generated binding types, migration set, gate readback | Moving target, uncommitted candidate, unknown writer, or any true execution gate |
| A2 old-writer drain | Remove every pre-0050 chat-canary request, Queue, Cron, alarm, DO, and maintenance writer; query protocol-v1 `chat_completions_canary` rows and observe zero for the computed maximum old-writer lifetime plus margin | Signed owner inventory, zero-row snapshots, `Tdrain`, computed window | Any old owner reappears or any existing canary row remains; reset the drain clock |
| A3 target freeze and backup | Freeze target-D1 writers, wait for in-flight completion, verify account/database UUID/environment, capture Time Travel bookmark and full logical fingerprints | Target identity, bookmark, migration ledger, normalized trigger SQL, per-table counts/hashes/high-watermarks | Target ambiguity, retention gap, active writer, incomplete fingerprint |
| A4 schema apply | Apply only 0050 while every traffic/financial gate is false | Exact migration row, receipt and alias tables, both indexes, and all eight normalized guards | Drain guard failure, unexpected DML, missing object, wrong trigger body |
| A5 negative proof | Run each probe in one D1 batch and prove full rollback: old-writer operation insert, alias collision/mutation/deletion, receipt mismatch/mutation/deletion, user/token quota failure, and user/token/channel authority loss | Expected trigger/error class plus unchanged fingerprints, alias ownership, and quota | Partial row/alias/debit, unrelated error, ambiguous response, or changed business data |
| A6 disabled candidate | Deploy/read back the 0050-aware Worker while the final canary gate stays false; expose atomic schema, history-probe-known plus boolean history, R2 binding, terminal/dispatched/prepared replay readiness, and exact migration head in authenticated capabilities | Version/deployment ID, bindings, D1 schema, all gates false | Capability omits a state gate, leaks identity, reports false history with an unknown probe as safe, wrong version, or route receives canary traffic |
| A7 isolated staging faults | Run an endpoint-level Worker matrix against remote D1/Controller/R2, then deploy two real Worker versions and rotate current/previous keys across them; include concurrent replay, response loss, schema/query faults, missing and stale-secret history, alias miss with history, prepared resume without each Controller/scheduler prerequisite, authority race, R2 orphan, DO eviction, Container restart, provider ambiguity, terminal replay, every state gate, and alias collision | One canonical alias winner and one reservation/debit/provider attempt/terminal result per identity, state-specific 202/503 evidence, zero unexplained rows, archived versioned traces | Duplicate reservation/debit/provider call, replay-only/history-miss fallthrough, schema error treated as miss, prepared row advanced before verified readiness, raw success without receipt, unresolved identity divergence |
| A8 canary decision | Complete scheduled terminalizer, shared response interpretation, provider idempotency/lookup, invoice reconciliation, code-audit and sign the replay-only rollback artifact plus idempotency-secret retention/keyring runbook, load/cost/alerts, security review, rollback rehearsal, and C1-C5/G1-G8 sign-off | Signed promotion packet and bounded token/model/channel cohort | Any missing approval/evidence, unresolved replay/secret audit, or unexplained financial/provider delta |

### Schema apply and readback details

The 0050 migration must be applied only after the old-writer drain query is
empty. It intentionally refuses to run when an existing protocol-v1
`chat_completions_canary` operation is present. It does not rewrite or backfill
historical non-canary operations.

Post-apply readback must prove all of the following, not only the migration row:

1. the receipt table has the exact primary/unique/check/foreign-key contract;
2. the alias table has a global HMAC primary key, exact canonical linkage,
   immutable update/delete guards, and its reservation index;
3. receipt alias count and order-independent alias-set digest match the complete
   one- or two-row alias set;
4. owner generation is fixed to 2, attempt count and provider attempt
   generation are fixed to 1, and selected snapshot key equals the textual
   selected channel type;
5. receipt update/delete and canary operation delete are rejected;
6. the operation insert guard requires the exact receipt, canonical alias, and
   selected reservation, so a pre-0050 writer cannot leave an unmarked row;
7. canary operation updates require exact immutable receipt linkage; and
8. a receipt-first batch commits only when every alias plus the later
   reservation and operation satisfy the deferred foreign keys.

Current local tests cover batch success/convergence, persisted-winner readback,
quota/authority/marker rollback, old-writer exclusion, alias schema and digest
checks, three-record settlement, current/previous identity derivation, and the
state action matrix. Completed local validation reports Workerd 14/14, Worker
Rust 820/820, SQLite 50 migrations / 48 tables / 540 incremental columns / 72
key indexes, and a passing repository-wide `bun run check` that includes the
root Worker Wrangler dry-run. Remote
staging must repeat the semantics through the deployed endpoint and target D1;
local coverage cannot prove Cloudflare deployment, Controller/R2 faults, real
Container lifecycle, key rotation, or provider billing.

The capability response now exposes the boolean-only
`container_chat_canary_replay_history_probe_known` and
`container_chat_canary_replay_history_present`,
`container_chat_canary_r2_binding_available`, and separate
`container_chat_canary_terminal_replay_runtime_ready`,
`container_chat_canary_dispatched_recovery_runtime_ready`, and
`container_chat_canary_prepared_resume_runtime_ready`. Aggregate
`container_chat_canary_replay_runtime_ready` is the conjunction of those three.
`container_chat_canary_replay_only_active` is only the actual flag plus the
configured cohort predicate; it neither includes nor replaces readiness. An
unknown history probe forces every replay-readiness field false. A false
history value is usable in rollback audit only with schema-ready and
`container_chat_canary_replay_history_probe_known=true`; the capability must
never expose an identity.

### Rollback and incident handling

Normal rollback is disable-first and schema-forward:

1. keep or set `CONTAINER_CHAT_CANARY_ENABLED=false` and preserve the hard
   source admission gate;
2. stop new edge admission, then provider, terminal, reconciliation, Queue,
   Cron, and alarm producers; freeze the exact historical token/model cohort
   while replay-only and prepared-resume remain false;
3. retain the current/previous idempotency secrets, read back 0050 schema plus
   `container_chat_canary_replay_history_probe_known=true`, and quarantine the
   rollback if key-generation coverage, history, or alias authority is
   uncertain;
4. set `CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED=true` only for that frozen
   cohort while `CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED=false`; prove a
   miss returns 503 and cannot reach ordinary reservation or provider I/O;
5. open recovery by durable state, never all at once: terminal replay first
   after exact R2 evidence, dispatched/recovery query-only second after verified
   Controller readiness, and prepared resume last by enabling the scheduler and
   `CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED=true` only after every
   pre-dispatch gate reads ready;
6. classify every receipt/reservation/operation tuple as resumable, terminal,
   or quarantined from exact D1/R2/DO evidence; never resubmit an ambiguous
   provider attempt;
7. disable prepared resume, scheduler execution, and then replay-only after all
   owners are terminal or quarantined; archive the before/after capability and
   row-count evidence;
8. return traffic and financial authority to Go/VPS;
9. retain migration 0050, its guards, immutable receipts, terminal/outbox rows,
   R2 artifacts, DO state, logs, and deployment inventory; and
10. roll application artifacts back only to a version that cannot emit a
   pre-0050 canary operation.

Do not drop 0050 objects, delete receipts, edit `d1_migrations`, compensate
quota with ad hoc SQL, or deploy an old canary writer. A destructive Time Travel
restore is allowed only under an all-writer freeze, named data-owner/SRE
approval, exact target/bookmark proof, and complete before/after fingerprints.

The local default-off foundation can read existing generation-2 owners without
opening new admission, but it is not yet a reviewed rollback artifact. The
signed rollback candidate may terminal-replay existing owners and may resume
non-terminal owners only under the state gates above. It must never admit a new
canary. Canonical-current-write plus atomic current/previous aliases must
preserve lookup for the entire replay/evidence horizon and fail closed on any
alias ownership conflict. Rollback audit must capture history-probe-known, the
boolean history signal, and all three state-specific readiness fields, treating
schema/query uncertainty as 503 rather than absence. Code audit, a previous-key
drain/retirement runbook, endpoint-level Worker fault proof against remote
D1/Controller/R2, a real two-version rotation, and rollback rehearsal remain
open cutover requirements.

Current decision: phases A0-A8 have no authenticated remote evidence packet.
Local 0050 migration/capability integration is present, but endpoint-level
faults, two-version rotation, remote D1/Controller/R2 evidence, deployed
capability readback, and authenticated remote evidence remain absent. Local
validation totals are recorded above but cannot substitute for those gates.
The final source gate is false. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-18 Migration 0051 Scheduled Terminalizer Rollout

This stage follows, and cannot bypass, the complete 0050 atomic-admission
rollout. Migration 0051 is local only. Neither 0051 nor its terminalizer has
been applied or enabled remotely. The tracked local, staging, and production
values for `CONTAINER_SCHEDULED_TERMINALIZER_ENABLED` and
`CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED` are `false`, so this section
is an execution checklist rather than deployment authorization.

### Promotion invariant

The scheduled observer may mutate financial state only when both new gates are
exact `true`, existing operation replay authority is ready, `FILE_BUCKET` is
present, and 0051 schema readiness is true. Before any item claim, a live
Controller probe must prove probe enablement, service binding, configured
authority, signature verification, controller enablement, and execution
enablement. The observer must then hold the exact live claim owner/generation
and frozen claim expiry and accept only a D1 `dispatched` or
`recovery_required` operation whose signed Controller state is exact
`Completed`/`DefinitiveTerminal` under status contract v3.

It may read Controller, D1, and R2 and invoke the existing settlement writer.
It may not claim or dispatch a DO operation, wake a Container, send/retry the
provider, infer success from an HTTP transport response, or compensate an
ambiguous financial state. Results above the 4 MiB replay ceiling are rejected
from manifest metadata before the body is buffered. Unavailable stores and
missing replay material remain bounded retries; divergent response material,
protocol/identity/quote violations, and conflicting financial decisions keep
their exact error code and dead-letter immediately. None permits a provider or
financial side effect.

The terminal event, outbox, user/token/channel accounting, operation terminal
transition, reservation settlement, and 0051 evidence must commit in one D1
batch. The 0051 insert is last and verifies the active observation owner,
generation, exact frozen lease expiry, lease/recovery horizons against D1
transaction-time `unixepoch()`, and the resulting terminal state. A stale
owner or any failed statement therefore rolls back all D1 effects. The
preceding R2 client-response create is outside the batch and must be treated as
non-authoritative orphan inventory until D1 readback succeeds.

Client and scheduled replay use the same financial audit schema v2 derived from
the persisted reservation and operation. It includes frozen `request_id_hash`
and excludes request-attempt ID/CF Ray and client IP, so the terminal decision
digest is path-independent.

### Ordered rollout phases

| Phase | Required action | Exit evidence | Abort condition |
| --- | --- | --- | --- |
| T0 credential and candidate freeze | Revoke/rotate exposed credentials; issue separate least-privilege deploy/readback identities; sign exact Worker, Controller, DO, Container, broker and rollback artifacts plus 0050/0051 hashes | Redacted identity/scope record, commit/version/image inventory, all action gates false | Credential remains usable, candidate moves, secret appears in file/log/CLI, or any action gate is true |
| T1 writer and object inventory | Enumerate Worker, Cron, Queue, alarm, admin, Controller, DO and maintenance owners; inventory object namespace/binding/class/migration/jurisdiction and all open 0050 operations | Named owner matrix, zero old-writer observations for computed drain window, object/class inventory | Unknown writer/object, old owner reappears, or open state lacks compatible recovery ownership |
| T2 target freeze and backup | Freeze target-D1 writers; validate account/database name and UUID; capture Time Travel bookmark, migration ledger, full logical fingerprints and normalized trigger SQL | Signed target and bookmark packet with retention deadline | Target ambiguity, active writer, incomplete fingerprint, or invalid bookmark |
| T3 disabled schema apply | Apply/read back 0050 if absent, then only 0051, while canary/provider/terminal/reconciliation gates remain false | Exact migration rows; 0051 table, committed index and three guards; unchanged business fingerprints | Unexpected DML, wrong head/hash/body, missing object, or any enabled writer |
| T4 direct negative proof | Probe stale owner, wrong generation, wrong frozen lease expiry, lease expired by D1 transaction time despite a fresh Worker timestamp, expired recovery horizon, wrong revision, forged terminal/receipt/result, missing 0050 admission, update and delete | Expected 0051 trigger/check failure and unchanged full-table fingerprints after every probe | Transport ambiguity, unrelated error, or any partial row/accounting change |
| T5 same-batch fault proof | Inject failure before and after each terminal event/outbox/accounting/operation/reservation/0051 statement and lose the client response after commit | Zero partial commits; one immutable winner after response loss; R2 orphan classified without authority | Duplicate accounting/event/outbox, incomplete terminal tuple, or orphan treated as settlement authority |
| T6 disabled runtime deploy | Deploy target-first Controller/DO/Container and then edge candidate with both new gates false; read back bindings, migration head and terminalizer capability components | Authenticated version/binding/schema/gate readback, no eligible traffic | Wrong target/version/binding, capability conflates requested with ready, or route reaches terminalizer |
| T7 isolated exact-terminal rehearsal | Enable only the first gate, prove no mutation; after named approval set staging-verified for a synthetic cohort and exercise exact Controller Completed + DefinitiveTerminal | One settlement and one 0051 row per operation, zero provider resend, exact D1/R2/DO/client replay, and one stable client/scheduler audit digest | Any non-definitive state settles, second provider call occurs, audit digest varies by path, or owner fence is bypassed |
| T8 lifecycle and mixed-version faults | Exercise lease expiry/reclaim, duplicate Cron/alarm, response loss, DO eviction/cold start, Container sleep/restart/OOM, pre-body 4 MiB rejection, R2 missing/divergent/orphan, transient/permanent error routing, D1 unavailable, N/N-1 deployment and rollback | Redacted traces proving convergence, bounded retry or immediate dead-letter as classified, with no duplicate financial/provider side effect | Unknown alarm/class/object version proceeds, permanent divergence retries, transient outage is treated as success, provenance gap, or unexplained financial delta |
| T9 financial and operational soak | Reconcile D1 reservation/event/outbox/0051 against provider invoice and Go baseline; run load/cost/SLO/alerts and retention cleanup | Zero unexplained delta, bounded backlog/latency/cost, tested alert and orphan runbook | Amount/invoice mismatch, alert blind spot, unbounded lease/orphan/backlog, or SLO breach |
| T10 promotion decision | Complete security/privacy/data/platform/SRE reviews, disable-first rollback rehearsal and C1-C5/G1-G8 approval | Signed promotion packet naming cohort, duration, abort owner and rollback artifact | Missing evidence/owner/approval or any unresolved blocker below |

T7 is permitted only in an isolated staging account with synthetic data and
provider credentials scoped to that rehearsal. Enabling the first gate alone
must remain inert because the staging-verified gate is still false. The final
readiness decision must also fail if existing replay authority, `FILE_BUCKET`,
the Controller probe/binding/authority/verified/execution predicate, or 0051
schema readiness is unavailable.

### DO object and lifecycle subgate

Before T8, the deployment packet must preserve one canonical DO/Container per
logical shard. Its name is `cinatoken-relay-shard-v1-XXXX`; the tenant HMAC
digest selects the shard but never enters the object name. A tenant-specific
name would invalidate the bounded pool and capacity model. Environment is
isolated by distinct Worker service/namespace/binding deployments. The packet
must record the canonical-name digest, namespace, service, binding, class,
selected Wrangler lifecycle mode and state, SQLite schema,
`ctx.id.jurisdiction`, shard index, and ring generation in redacted operation
provenance.

The current repository uses legacy append-only `migrations`; Cloudflare now
prefers declarative `exports` for new Workers, and the two modes are mutually
exclusive. Before the first remote Container deployment, approve either the
retained legacy chain or a separately reviewed one-time conversion, then freeze
that choice through canary and rollback. New namespaces use SQLite. Class
rename/delete/transfer is atomic and cannot use a gradual deployment. It
requires old-binding inventory, stored-data compatibility, remote lifecycle
reconciliation output, old-object readback/drain, and a rollback reader.
Cold-start initialization must be idempotent and block dispatch until storage
schema, durable owner, deadline, pending alarm and result identity are valid.
Constructor `blockConcurrencyWhile` is bounded to schema/state work, performs
no external I/O, and stays below its reset timeout; SQL schema version uses a
durable migration table rather than `PRAGMA user_version`. It must not execute
a provider or financial side effect.

Alarm payload/intent is a versioned ABI. The `Container` base class owns the
single platform alarm and multiplexes callbacks through `schedule()`;
`RelayShardContainer` must not override `alarm()` or compete with it through
direct `setAlarm`. The application persists its own deadline intent in DO
SQLite. Version N always reads legacy v0 and strict v1, while v1 writing needs
both default-false gates; N-1 must be drained or isolated before the first v1
write. In `@cloudflare/containers` 0.3.7 a callback exception is caught and the
one-shot schedule is deleted, so the callback itself records delivery and
creates a bounded retry or quarantine. Unknown future versions, stale
generations, duplicate, early, late, retry-exhausted, and rollback-era tasks
fail closed without provider resend or settlement. The mixed-version rehearsal
must join edge, Controller, DO, Container, broker, provider, D1, R2,
terminal/outbox/billing and 0051 evidence into one redacted cross-layer trace.

### Rollback and evidence retention

Rollback order is fixed:

1. set both scheduled-terminalizer gates false and verify the deployed
   readback;
2. close new canary admission and prepared resume, then stop provider and other
   terminal/reconciliation producers;
3. allow active D1 leases to finish or expire, classify every existing 0050
   owner from exact D1/R2/DO evidence, and never resend an ambiguous provider
   operation;
4. route new traffic and financial authority to Go/VPS while retaining a
   0051-aware Rust recovery reader;
5. retain 0050/0051 schema, immutable admission/terminal/scheduled evidence,
   outbox, R2 artifacts, DO storage, deployment and alarm provenance; and
6. roll application components back in reverse target-first order only to
   artifacts that can read existing objects and cannot emit incompatible rows.

Do not drop 0051, delete evidence, edit `d1_migrations`, rename/delete a DO
class as rollback, reuse a DO identity in another jurisdiction, issue ad hoc
quota SQL, or restore D1 while any writer runs. Time Travel is reserved for an
all-writer-frozen disaster with exact target/bookmark, complete before/after
fingerprints, named approval, and archived undo bookmark.

Open blockers after the local 0051 implementation are provider-native
idempotency or deterministic lookup, provider-response-before-R2 ambiguity,
shared non-2xx response semantics, independent amount authority and invoice
convergence, production R2 orphan policy, real proof for the locally implemented
DO identity/cold-start/alarm substrate, frozen class lifecycle, jurisdiction,
and cross-layer provenance, remote fault/lifecycle evidence,
load/cost/SLO/alerts, signed rollback, and C1-C5/G1-G8 approval. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-18 Durable Alarm Intent v1 Execution Addendum

This addendum changes the local implementation baseline for the T8 lifecycle
subgate. It authorizes no remote action and adds no D1 0052.

| Step | Required action | Exit evidence | Abort condition |
| --- | --- | --- | --- |
| A0 candidate freeze | Pin `@cloudflare/containers` 0.3.7, Controller artifact, three Wrangler files, generated types, legacy migration chain, and DO-local schema migrations 1/2 | Signed hashes and source/config readback; both v1 writer gates false | Package/config/source drift or any gate true |
| A1 reader-first deploy | In isolated staging only, deploy v0/v1 reader, local schema validation, and unarmed rearm while writer gates remain false | Every active logical shard reports the same service/binding/class/version; no per-tenant object creation; zero new v1 rows | N-1 object can receive traffic, identity/jurisdiction ambiguity, or unexpected v1 write |
| A2 real lifecycle fault proof | Exercise actual `RelayShardContainer` cold/warm start, eviction, duplicate schedule, callback throw/delete, Container sleep/restart/OOM, malformed/future payload, and dependency upgrade guard | Intent and package schedule traces converge or quarantine; provider and financial counters remain unchanged | Pending work loses all wake paths, callback escapes without durable disposition, or any provider/financial delta |
| A3 half-enabled negatives | Test `CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED=true` with staging-verified false, then enabled false with `CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED=true`, while execution is requested | Outer Controller and shard DO both return `operation_recovery_intent_v1_disabled` before claim, readiness is false, and zero operation/intent/v0 rows appear | Any claim, v0/v1 schedule, Container wake, provider action, or ready result occurs |
| A4 synthetic v1 rehearsal | After named approval, set both gates for an isolated synthetic shard, inject crash before schedule and after schedule/before armed, then duplicate/early/late/stale/exhausted deliveries | One operation terminal outcome, bounded retry/quarantine, exact shard/owner fence, no provider resend or financial mutation | Lost intent, unbounded retry, wrong operation mutation, second provider call, or settlement/refund |
| A5 rollback | Set both gates false first, retain the v1 reader, drain/quarantine v1 intents, and route new work to the reader-compatible artifact | No new v1 writes; every existing intent completed/quarantined; legacy v0 remains readable | Rollback artifact cannot read v1, schema/evidence deletion, N-1 receives v1, or object is recreated in another jurisdiction |

The application does not own the platform alarm. The `Container` base class
multiplexes `schedule()` tasks, and package 0.3.7 catches callback exceptions
before deleting a one-shot task. A2/A4 must therefore prove the application
records delivery and creates the next schedule before callback return. Direct
`setAlarm`, subclass `alarm()` overrides, or a second scheduler owner are
release blockers. A2/A4 must also prove a failed persistence or replacement
schedule reaches `ctx.abort()` before base one-shot cleanup and is recoverable
after object restart.

After A0-A5, T8 still remains open for jurisdiction, class migration, full
cross-layer provenance, remote load/cost/alerts, and mixed-version deployment.
The next implementation packet must also close Go-parity HTTP 200/non-200 and
stream-interruption response interpretation before canary promotion. Production
remains **NO-GO**.

## 2026-07-18 Response Interpretation Execution Addendum

This addendum is governed by `docs/response-interpreter-production-plan.md` and
pins Go commit `73652508abc5cb09214dde02d51d69d1d1ccc703` plus Rust contract
`go-openai-response-v1`.

| Step | Required action | Exit evidence | Abort condition |
| --- | --- | --- | --- |
| R0 source freeze | Regenerate the clean-commit Go corpus and verify source/template/script/manifest hashes | Exact immutable case count and Rust replay | source, case, or digest drift |
| R1 shared adapters | Route bounded Worker and Container egress responses through one pure ABI | Exact 200, typed-200, non-200, malformed, headers, usage, and stream-fault tests | caller-specific semantic fork |
| R2 evidence readers | Add migration 0052 readers and protocol-v3 parsers while writers remain false | Local/remote schema and mixed-version readback | old artifact can receive new state |
| R3 dual writers | Persist create-only raw provider evidence, then interpreted client artifact | R2/D1/DO exact replay and orphan inventory | overwrite, digest mismatch, or evidence conflation |
| R4 terminal owner | Bind success receipt or interpreted reject to one financial terminal decision | duplicate/lost-response/fault convergence | second provider or quota mutation |
| R5 isolated staging | Run real Container, N/N-1, faults, load/cost/SLO/alerts, and rollback | signed evidence bundle and zero unexplained divergence | customer traffic or missing rollback proof |

R0-R1 are local semantic work only. R2-R5 remain required before any canary.
All response-artifact, execution, provider-egress, scheduler, and traffic gates
stay false until their named step exits.

### Local P2 execution checkpoint

The repository now contains the local 0052 schema and create-only R2 storage
boundary. This advances the implementation packet, but not the remote execution
step named R2 above: no migration has been applied and no v3 reader has been
deployed.

Before remote R2 can begin, freeze the exact 0052 SQL/object fingerprints and
every artifact that can write a protocol-v1 operation. Prove the migration's
temporary drain query returns zero against the target D1 database, archive the
account/name/UUID and bookmark, and keep all action gates false. Apply once,
then read back eight persistent tables, seven indexes, 34 triggers, the terminal
artifact column, the nullable operation writer-contract column, and zero
evidence/inventory rows. Prove an N-1 insert without the contract fails before
prepared state and provider count remains unchanged. Any old writer, active old
operation, object mismatch, or unexpected row aborts deployment.

P3 implementation must precede any dual writer: exact egress protocol-3
envelope, strict Controller verifier, DO-local migration 3, rejected runtime
outcome, and exact edge replay. Raw R2 creation then precedes raw D1, client R2,
client D1, optional exact-200 receipt, DO terminalization, financial terminal,
and client delivery. A failed later step leaves evidence or bounded orphan
inventory; it never authorizes overwrite, provider resend, settlement, refund,
or delete.

Rollback disables admission, response-artifact writing, terminal consumption,
provider egress, scheduler ownership, and traffic before changing artifacts.
It retains 0053, both R2 namespaces, identity/inventory rows, and P3/P4-capable
readers until every operation is completed or quarantined. Go/VPS remains the
fallback and production remains **NO-GO**.

## 2026-07-19 P5 Evidence Decision Addendum

The R5 isolated-staging exit now has an executable verifier contract in
`docs/relay-container-p5-evidence-contract.md`. Ten exact evidence kinds and
five external Ed25519 approvals bind one immutable candidate. The verifier is
offline, bounded, credential-free, and has no deployment or traffic authority.

The ordered operational campaign remains unchanged: provider egress first,
Controller second, edge reader third, all gates false, ordered 0052/0053
readback and direct negatives, then isolated faults/load/rollback and approval.
Both Controller deploy scripts run a fail-closed config/secret-name preflight;
the tracked production placeholder IDs intentionally block that preflight.
Cloudflare gradual deployments can skew Service Binding versions, so the
packet must prove version override/pinning or a blue/green namespace;
percentages alone are insufficient.

The production decision adds a separate Go/VPS drain requirement because the
source holds deferred accounting and request-local billing state in process
memory. Before Go can become the rollback-only target, ingress and sockets are
zero, two batch intervals and one export interval are stable, no process-owned
finance remains, all scheduler owners are unique, source/target reconciliation
has no unexplained delta, and reverse synchronization contains every accepted
Cloudflare write. No local verifier fixture satisfies those external gates.

## 2026-07-19 Foundation Collection And Go Drain Addendum

P5 foundation collection is now executable but remains non-authoritative. Use
`docs/relay-container-p5-foundation-collector.md` for the strict request/source
contracts and live command. The collector must run only in staging with a
rotated dedicated readback identity and all action gates false.

The execution order for the foundation packet is fixed:

1. revoke the exposed credential and provision a separate replacement
   readback token outside arguments and tracked files;
2. freeze the exact candidate, Container image/SBOM/signature, source
   collectors, app-owned shard ledger, and rollback artifacts;
3. run the credential-free dry plan and local collector/P5 tests;
4. start the read-only before snapshot of the exact three Workers, shared
   D1/R2/KV, Container application/instances/image, and collector artifacts;
5. during the bounded observation window, capture action gates, every logical
   shard from the stable registry/activation ledger, R2 writers/objects, and
   zero-customer-traffic isolation;
6. collect the identical after snapshot, require complete pagination and zero
   drift, and materialize candidate-freeze plus remote-inventory facts from the
   same capture binding; and
7. archive the canonical capture for independent review without enabling a
   writer, waking a Container, deploying, or changing traffic.

Running Container instances are not the namespace ledger. If any shard is
sleeping or absent from the control-plane list, the app-owned registry still
must prove its deterministic identity, activation generation, and disposition.
Any missing source remains `not-proven`.

Production cutover uses the separate contract in
`docs/go-vps-cutover-evidence-contract.md`. Build its eight canonical evidence
records only after the live cohort is frozen. The verifier requires exact Go
topology, four-protocol ingress drain, zero process-owned financial and batch
state, persistence/export stability, one owner per scheduler, zero
bidirectional reconciliation delta, complete pending task/order disposition,
and a measured rollback package containing every accepted write.

`eligible-for-production-cutover-review` is not authorization. The verifier's
`productionCutoverAuthorized` field is always false, and G8 plus all named
business/security/finance/operations/rollback owners remain mandatory. No live
capture or production action occurred in this addendum; production remains
**NO-GO**.

## 2026-07-19 Shard Ledger And Control-Plane Pagination Addendum

The production sequence now treats logical shard inventory and Cloudflare
control-plane inventory as two independent evidence planes. Neither can replace
the other.

1. Rotate the exposed credential and freeze a replacement least-privilege
   readback identity. Never place it in arguments, tracked files, evidence, or
   command output.
2. Freeze the final staging candidate including Controller Worker version,
   Container image digest, runtime executable build ID, SBOM, and a signed or
   otherwise approved provenance artifact that maps that build to that image.
3. Back up staging D1 and apply 0054 with all execution/provider/financial and
   activation-recording gates false. Read back the table, indexes, triggers,
   empty-row state, immutable negatives, and unchanged business fingerprint.
4. Deploy provider-egress, Controller reader, then edge reader. The Controller
   must accept both legacy and build-bearing readiness, but no activation row
   may be written yet.
5. Roll the Container candidate at 10% and 100%. At each stage, prove the
   control-plane image, compatible runtime protocol, zero customer traffic,
   and zero provider/financial delta. Do not infer sleeping shard absence from
   the running instance list.
6. Implement and approve a same-Controller-version one-time activation
   campaign with a root-authorized nonce, exact candidate, expiry, per-shard
   single consumption, automatic seal and immutable audit. Do not toggle the
   static activation environment variable: each edit creates another Worker
   version and breaks candidate/action-gate identity.
7. Use that campaign to perform one approved live readiness probe per logical
   shard, then require it to seal with every effective action gate false. Rows
   must be generation one and fresh for this campaign.
8. Run the shard collector for 300-7200 seconds. Every page must use the first
   response's high watermark; cursors and event sequences must be strictly
   increasing; the final cursor must be null; before/after canonical records
   must be identical; indexes must equal `0..N-1` with zero noncandidate rows.
9. In parallel, collect the exact action-gate, SBOM/provenance, R2 inventory,
   traffic-isolation, Worker deployment, D1/R2/KV, and Container application
   evidence. All artifacts must overlap one observation window.
10. Run foundation collector v4's fixed direct Cloudflare API readback. Require
    stable KV page/count totals, bounded unique Container page tokens with an
    explicit terminal, no duplicate records, and identical before/after
    digests; page size or finding the expected object is never completion.
11. Archive the canonical foundation capture itself at
    `evidence/foundation-capture.json`; the manifest must bind its byte count
    and full SHA-256, and its emitted facts must exactly match the two evidence
    records.
12. Only after the ten P5 evidence categories and five signatures pass may the
    isolated synthetic canary be reviewed. Customer and production authority
    remain separate decisions.

Steps 6 and 10 are implemented locally but are not deployed or exercised.
Remote S3/S4 therefore remain blocked until a rotated least-privilege token
proves the real endpoint permissions and collector-v4 before/after inventory.
Local fixtures for activation and foundation integrity waive neither
requirement.

Rollback disables customer admission, provider/financial writers, schedulers,
and activation recording before artifact changes. It retains 0054/0055,
activation/campaign rows, P3/P4 readers, R2 artifacts, DO state, and evidence. The hot Go target is
usable only after the live drain contract proves all process-local work and
bidirectional synchronization. Production remains **NO-GO**.

## 2026-07-19 Migration 0055 Activation Campaign Addendum

This addendum supersedes the former step-6 implementation gap: the same-version
one-time campaign is implemented locally. A later collector-v4 increment also
closes the step-10 local implementation gap. Authenticated remote execution
and production authorization remain blocked.

### Promotion invariant

S3 succeeds only when one immutable campaign is bound to the deployed
Controller version and frozen candidate, every one of the 22 Controller action
gates is false, D1 claims each shard before a DO lookup, the DO performs at
most one wake per claim, and D1 seals `complete/all_shards_consumed` with exact
N/N receipts and matching 0054 rows. Aggregate counts without receipts, an
expired/failed/aborted campaign, or a second campaign after any candidate
effect is not promotable.

### Execution phases

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A credential and candidate freeze | Rotate the exposed credential; split deploy/readback identities; freeze commits, versions, image/build/provenance, foundation manifest, resources and rollback | One canonical candidate, no secret in argv/files/output, all static gates false | Any old token, placeholder identity, candidate drift, or provenance gap |
| B schema expand | Back up staging D1; prove writer/operation drain; apply 0054 then 0055 | Remote 0055/55, 62/771/91, four tables/one view/eight indexes/fourteen triggers, immutable negatives, unchanged business fingerprint | Schema/catalog drift, unexpected rows, incompatible writer, provider or financial delta |
| C reader/runtime rollout | Deploy provider-egress, Controller and edge readers; roll the exact Container 10% then 100% | Same Controller version metadata, exact runtime build/image, compatible readiness, zero customer/provider/financial effect | Version or image mismatch, N-1 incompatibility, unexplained wake/effect |
| D campaign create | Root plus step-up creates one 60-3600 second campaign | Open status with zero claims/consumptions; exact candidate/action-gate/foundation digest; nonce handled only in operator memory | Legacy writer enabled, any action gate true, active/conflicting campaign, schema not ready |
| E shard consumption | Submit one deterministic campaign readiness request per index | D1 claim precedes DO lookup; completed retry is replay-only; result JSON/hash stable; no second wake | Ambiguous journal, timeout, result/hash mismatch, readiness rejection, version/ring/build drift |
| F seal and readback | Read root campaign status and 0054 frozen snapshot | `sealed_complete`, N/N, receipts `0..N-1`, one-to-one activation rows, final seal digest/timestamp match | Any non-complete seal, gap/duplicate, stale or execution-ready receipt, unexpected activation |
| G S4 stability and P5 | Capture campaign, activation, action-gate, SBOM/provenance, R2, traffic and control-plane sources over 300-7200 seconds | Identical before/after campaign and activation digests, sources-v3, explicit all-page proof, ten P5 kinds, five signatures | Drift, partial pagination, traffic, unknown writer/object, stale evidence, signature failure |

The campaign capability bypasses only the ordinary edge readiness probe/wake
flags when a strict campaign credential is present. Ordinary probes remain
default-off, Controller execution/readiness/provider/action gates remain false,
and production wake still requires prior staging verification. Do not turn on
the legacy `CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED` path.

### Failure and rollback

On a pre-claim failure, preserve the open campaign and diagnose without a
Container wake. On a post-claim timeout or lost response, read the exact D1
claim and DO journal; never retry a wake. Ambiguous or corrupt journal evidence
seals failed and retires the candidate. Expiry cron is bounded and idempotent.
Rollback retains 0054/0055, campaign and journal evidence, readers, image,
artifacts, and the hot Go authority; it disables customer admission and all
provider/financial/scheduler writers before any artifact rollback.

No remote action occurred for this addendum. The exposed credential still
requires rotation, remote 0055 is unapplied, no campaign has run, all-page
Cloudflare inventory is unproven, and the P5/Go drain packets are absent.
Production remains **NO-GO**.

## 2026-07-22 Migration 0056 HTTP SSE Handoff Addendum

Migration 0056 is an expand-only, default-inert schema change. It adds the
ordinary HTTP SSE handoff state machine and append-preserved finalization
receipts. It does not alter the historical 0055 one-time activation campaign;
0055 remains the campaign evidence baseline while 0056 is the current schema
head and therefore part of every new candidate identity and schema readback.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A security/candidate freeze | Revoke the exposed credential; freeze exact Worker, Queue, migration, rollback, Go/VPS, and provider-counter identities | Separate least-privilege deploy/readback identities; no secret in argv/files/output; all four SSE gates false | Old credential, identity drift, missing rollback, or any gate true |
| B reader-first expand | Back up isolated staging D1; prove old writer and active-operation drain; apply 0056 with every gate false | Remote 0056/56 and 64/814/94; two tables, three indexes, eleven triggers; immutable/monotonic/receipt negatives; unchanged business fingerprint | Schema drift, incompatible writer, unexpected row, or financial/provider delta |
| C reader and drain-only rehearsal | Deploy the exact reader; seed synthetic rows; enable staging approval plus outbox/recovery only | Producer remains off; exact leased delivery/retry/dead-letter/receipt reconciliation; zero provider calls | Producer row appears, mutable event, duplicate apply, stale lease mutation, or body/secret evidence |
| D isolated producer canary | Enable staging approval, outbox, recovery, then producer for a tiny no-customer cohort | One provider operation, monotonic checkpoints, event persisted before terminal release, one audit/billing terminal/receipt | Any duplicate call/effect, unexplained recovery, missing receipt, partial-usage settlement, or traffic leak |
| E fault and soak | Execute before-header, client-cancel, D1/Queue ambiguity, restart, N/N-1, idle, failed-terminal, and rollback campaigns | Every row reaches one terminal or reviewed recovery state; provider/D1/invoice counters reconcile; alert and cost/SLO budgets pass | Stranded reservation, retry dispatch, unknown terminal, data leak, unbounded age/cost, or rollback failure |
| F promotion review | Bind all results to the existing P5 subject and independent owners | Security, migration, billing, SRE, and rollback approvals over one candidate | Missing/stale evidence or signature failure |

Rollback disables the producer first and preserves staging approval plus
outbox/recovery until forwarding, staged, due, and leased backlogs converge.
Migration 0056 and its evidence are retained; rollback never down-migrates or
deletes receipts. Go/VPS remains hot and authoritative.

Current blockers are the provider-dispatch-to-handoff crash window, lease-only
client-cancel recovery, missing total stream timeout, absent real Queue/D1 and
restart/version-skew campaigns, remote 0056/readback, credential rotation, P5,
and Go/VPS drain. See `docs/relay-http-stream-durable-handoff.md`. Production
remains **NO-GO**.

## 2026-07-22 Migration 0057 Dispatch Intent Addendum

This addendum supersedes the current-head, dispatch-window, and total-deadline
statements in the 0056 addendum. The 0056 terminal/outbox/receipt protocol is
retained. The 0057 increment baseline was 0057/57 with 65 tables, 841 checked incremental
columns, and 96 key indexes.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A producer drain | Keep all SSE gates false; stop every old 0056 producer and paid SSE operation | Frozen provider watermark, zero active old operation, N-1 reader-only inventory | Any old producer can still insert a handoff |
| B 0057 expand | Apply 0057 once after backup and fingerprint | One table, two indexes, ten triggers, hard-deadline column; atomic promotion/recovery negatives; unchanged business data | Partial schema, catalog drift, or hidden provider/financial effect |
| C compatible readers | Deploy N with producer false; retain N-1 only for read/non-SSE traffic | N reads/sweeps 0057, N-1 reads expanded schema, no durable write | N-1 producer activation or unexplained row |
| D drain-only | Seed expired intents and existing 0056 work; enable approved recovery/outbox only | Atomic billing recovery, no provider calls, exact receipt convergence, zero backlog | Partial owner transition, dispatch, duplicate terminal, or stale lease write |
| E isolated producer | Enable staging, outbox, recovery, then producer | One `prepared -> dispatched` grant, one provider call, 200 atomic bind, 120-second header and 900-second hard-deadline evidence | Retry/fallback, client byte before bind, partial state, or unknown ownership |
| F faults and rollback | Run CAS response loss, delayed/non-200 headers, D1 statement faults, stream/deadline/cancel, Queue/DLQ, restart and N/N-1 | Counters conserve and producer-off rollback drains through N while Go/VPS is hot | Resend, auto-refund ambiguity, stranded row, unbounded backlog, or rollback miss |

Rollback cannot deploy N-1 as the durable SSE producer because 0057 guards new
0056 inserts. It disables producer, returns new work to Go/VPS, and retains the
N drain worker plus both migrations until every intent, handoff, reservation,
outbox item, receipt, and provider operation is reconciled.

At the 0057 increment, immediate `Request.signal` cancellation/watchdog proof
and default-path clone/tee backpressure proof remained open, as did remote 0057, provider invoice,
Queue/restart, P5, SLO/cost/security approval, and Go/VPS drain evidence.
Production remains **NO-GO**.

## 2026-07-22 Migration 0058 Client-Abort Watchdog Addendum

This addendum supersedes the current-head and immediate-cancellation gaps in
the 0057 addendum. Current local head is 0058/58 with 66 tables, 848 checked
incremental columns, and 97 key indexes. The 0056 handoff and 0057 dispatch
intent remain immutable prerequisites.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A security/candidate freeze | Prove exposed credential revoked; freeze N/N-1, D1 backup, Queue/DLQ, provider watermark, Go/VPS and rollback | Separate least-privilege identities; all four SSE gates false; no secret in argv/files/logs/evidence | Credential reuse, candidate drift, unknown writer, gate true or missing rollback |
| B old-writer drain | Stop all pre-0058 durable SSE producers and active paid streams | Zero old producer/operation; stable provider and financial watermark | Any binary can create an unowned handoff |
| C 0058 expand | Apply 0058 once after backup/fingerprint | Remote 0058/58, 66/848/97; exact table/index/five triggers/seven columns; unchanged business data | Partial schema, forbidden field, catalog drift or side effect |
| D reader/drain | Deploy N with producer false and N-1 reader-only; exercise synthetic rows | N checks 0058 before send; abort/terminal races converge; zero provider call during drain | N-1 write, mutable evidence, partial recovery or unexpected call |
| E isolated producer | Enable staging, outbox, recovery, then producer | Direct/Gateway/WFP HTTP/2/HTTP/3 disconnects produce one call, one abort decision and exact accounting | Lost signal/evidence, retry/refund, duplicate effect, body leak or unknown owner |
| F fault/soak/rollback | Inject D1 response loss, restart/deploy, version skew, Queue ambiguity and scheduler overlap; then producer-off rollback | Bounded SLO/cost/backlog; invoice/D1/audit/request conservation; N drains to zero; Go/VPS resumes within RTO/RPO | Stranded/duplicate state, unbounded cost/age, rollback data loss or unsafe Go target |
| G promotion | Bind remote 0058 packet to P5, security/privacy, billing, SRE, migration, rollback and Go/VPS approvals | One immutable signed candidate eligible for review | Missing/stale/mixed/unsigned evidence |

Rollback never down-migrates. Disable producer first, route new traffic to hot
Go/VPS, and retain N with staging/outbox/recovery until all 0057 intents, 0056
handoffs, 0058 abort events, outbox leases, receipts, billing rows and provider
counters are terminal or explicitly reconciled. Never restore N-1 producer
authority, automatically refund an ambiguous reservation, or resend its
provider operation.

Local Workerd now proves reader cancellation through incoming
`Request.signal` over a service binding. Production remains **NO-GO** pending
the real Cloudflare fault matrix, remote 0058 readback, provider invoice,
Queue/restart/version-skew, P5, SLO/cost/security approvals, credential
revocation, default-path backpressure, and Go/VPS drain/reverse-sync evidence.

## 2026-07-23 Migration 0059 Ring Transition Claim Addendum

This addendum supersedes the current-head statements above, not the 0056-0058
SSE safety contracts. Current local head is 0059/59 with 68 required tables,
899 checked incremental columns, and 100 key indexes.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A credential and runner freeze | Revoke the exposed credential; freeze read/claim/deploy identities, two policy roots, key fingerprints, account/ledger/service pins, runner source/build/trust/release digests | Three pairwise-distinct least-privilege identities; immutable disabled runner artifact; no secret in argv/files/logs/evidence | Missing revocation, shared identity, writable/unpinned runner, origin/service override, or broad D1/deploy scope |
| B reader-first 0059 expand | Back up staging D1; keep runner/claim authority and all traffic/provider gates false; apply 0059 once | Remote 0059/59 and 68/899/100; exact tables/indexes/triggers; unchanged business fingerprint; zero claim/provider/financial/traffic delta | Partial catalog, unexpected claim, old writer, drift, or side effect |
| C claim authority | Deploy the private D1-bound claim Worker with create/read-only protocol and dedicated secret | Bounded authenticated request; unique auth/nonce/scope; D1 time/TTL; replay/concurrency/expiry negatives; redacted logs | General SQL API, bearer leak, duplicate active claim, mutable evidence, or ambiguous ownership |
| D immutable runner | Publish attested build with fixed origins/account/policies/keys/services/claim ledger and exactly two deployment POSTs | Checkout/config/argv/env cannot override pins; read/claim/deploy secrets isolated; native bounded fetch; redirects off; POST retry zero; `force` absent | Shell/Wrangler/SDK retry, inherited broad env, arbitrary URL/service/version, unbounded body, or secret output |
| E Controller transition | Claim once, stable T1, persist Controller intent, POST once, stable target readback | Exact reviewed target at 100 percent twice; durable request/evidence digests; no customer/provider/financial action | T1 drift, response loss without target proof, old/mixed target, readback drift, second POST, or generation rollback |
| F Edge transition | Re-read old Edge, persist Edge intent, POST once, stable target readback | Exact reviewed Edge target at 100 percent twice; completed claim and redacted receipt | Controller drift, old Edge mismatch, response ambiguity, second POST, or unreviewed cleanup |
| G overlap and fault campaign | Exercise old/new Edge, named DO, Linux Container, KV/D1/R2, cutoff replay, restart/OOM, runner crash, concurrent invocation, D1/readback faults | One claim owner, one mutation per service, no duplicate provider/financial effect, forward-safe recovery, measured RTO/RPO/SLO/cost | Unknown owner, retry, stranded state, accounting mismatch, data leak, unsafe Go rollback, or unbounded backlog |
| H P5-B and production decision | Bind remote results to the frozen candidate and independent security/operations/release/rollback/Go approvals | Complete signed P5-B, reverse-sync and Go drain packet, G1-G8/C1-C5 acceptance | Missing/stale/mixed evidence, live Go authority not retained, or any production gate open |

Controller success with Edge failure is an intentional partial-success boundary:
retain the dual-ring Controller, keep the exact old Edge if still verified,
return new traffic to Go/VPS, disable Rust admission, and repair forward with a
new packet. Never roll generation backward or reuse the old authorization.

The local repository currently implements only B's schema and the fail-closed
contract portions of A/D/E/F. The private authority, live transport, immutable
enabled artifact, revocation, and all remote phases remain open. Production
remains **NO-GO**.

## 2026-07-23 Migration 0060 Authority Isolation Addendum

This addendum supersedes only the current-head and current claim-authority
statements in the 0059 addendum. The 0059 claim identity and ordered-step
history remain the immutable baseline. Current local workspace head/count is
`0060/60`, with 69 required tables, 909 checked incremental columns, and 101 key
indexes.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| A local 0060 schema freeze | Freeze the exact 0059/0060 file digests, disable every 0059 writer, prove zero active transition claims, then apply the incompatible migration; keep every ring, provider, financial and traffic gate false | Drain guard passes; local `0060/60`, `69/909/101`; one expiry table, one expiry index, `transport_outcome`, recreated claim/step guards, immutable expiry evidence | Any old writer or active claim, partial catalog, changed business data, early expiry, post-mutation ordinary expiry, digest mismatch accepted, or rejected transport accepted as success |
| B independent control D1 design | Define `cinatoken-ring-control-staging` with only claim, step and expiry domain tables plus provider migration metadata; keep it separate from application D1 | Reviewed control-schema lineage pinned to 0059/0060 digests, exact catalog allowlist, backup/Time Travel, restore plan, retention and access-owner inventory | Shared application D1 binding, unrelated table, missing source provenance, broad token, or no restore owner |
| C default-disabled Authority Worker | Build a staging-only Worker bound only to the control D1 and Version Metadata; set `workers_dev=false`, `preview_urls=false`; publish no production config; keep authority/claim/step/expiry write gates false | Config audit proves exactly two bindings, no alternate public endpoint, no production config and every write gate false | KV/R2/DO/Container/Queue/service/application-D1 binding, public preview, route bypass, or any true write gate |
| D layered authentication | Put the staging hostname behind Access Service Auth; verify application HMAC over method/path/time/request/body/credential identity; verify a short-lived Ed25519 permit over the canonical claim and authorization | Missing, stale, future, replayed, wrong-path, wrong-body, wrong-credential, wrong-key, altered-target and altered-policy requests all fail before D1 write | Caller assertion treated as proof, caller-selected actor, secret/body/header logging, Cookie/CORS authority, or redirect |
| E exact ledger protocol | Create/read a claim, append an owner step, and append an authority expiry event only through fixed prepared statements and exact readback | Concurrent single winner; exact replay only; independent expiry actor; pre-mutation `expired`; post-mutation `recovery_required`; matching intent digest; `rejected -> recovery_required/http_rejected` | UPSERT/replace/ignore, arbitrary SQL, claim-owner expiry authority, skipped state, replay ambiguity, second mutation, or leaked row/error |
| F remote staging acceptance | After credential revocation evidence and independent review, create the isolated resources with all gates false, apply/read back the control schema, then run no-customer fault campaigns | Authenticated resource/version/route/Access/D1 readback, unchanged application D1/business fingerprint, redacted logs, zero provider/financial/traffic effect | Any missing revocation proof, unexpected remote write, mixed candidate, customer traffic, unexplained row, or inability to disable immediately |
| G promotion decision | Bind the retained remote packet to immutable runner, P5-B, security/privacy, SLO/cost/alerts, rollback, reverse-sync and Go/VPS drain approvals | One fresh exact-candidate packet reviewed by independent owners | Missing/stale/mixed evidence, production config present, Go/VPS not hot, or any control/write gate open |

Expiry handling is authority-driven, not runner impersonation. D1 time decides
expiry. `claimed` and `t1_verified` may become `expired`; after a successful
Controller mutation, `controller_verified` and `edge_prechecked` may only
become `recovery_required`. Inflight states remain bound to authenticated
readback. Controller and Edge post-readback evidence must repeat the exact
persisted mutation-intent digest. `transport_outcome=rejected` is legal only
with `to_status=recovery_required` and `failure_class=http_rejected`.

The integrated repository total `0060/60, 69/909/101` and the isolated control
D1 catalog are separate evidence facts. The latter must prove exactly the three
domain tables and its own migration metadata; it must not claim the integrated
69-table total.

The current local Authority Worker configuration correctly names the dedicated
`cinatoken-ring-control-staging` database and the config audit rejects the
shared application database name. It is still not deployable: the database ID
and trust identities are placeholders, every write gate is false, and the
authenticated remote D1, route, Access, secret-rotation, and revocation packet
is absent. Phase C cannot start until those independent resources and evidence
are reviewed.

This addendum is a local production plan only. No control D1, Authority Worker,
Access policy, route, secret, permit key, migration, deployment, provider call,
customer traffic, or financial state was changed remotely. Production remains
**NO-GO**, and Go/VPS remains authoritative.

## 2026-07-23 Immutable Runner And Native Transport Addendum

This addendum replaces the local implementation status in phases C-D of the
0060 addendum. The Authority, compiled launcher, and native transport now exist
locally, but remain deliberately disconnected from a live execution command.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| H Authority preflight freeze | Freeze exact Authority origin/version, HMAC issuer/audience/key ID and permit issuer/key ID/SPKI; call the read-only preflight before claim traffic | Authenticated response echoes request ID, credential hash, permit SPKI and Version Metadata ID; no D1 operation or write gate | Version/SPKI/identity drift, body accepted, D1 access, alternate path, redirect or unbounded response |
| I credential transport freeze | Load only account/read/HMAC/deploy fixed handles; verify read and deploy token identities against the exact account; prove all three credential IDs differ | Raw account hash matches build-time pin; exact token IDs and HMAC preflight match; descriptors and receipts contain no raw secret | Ambient env enumeration, shared credential, broad token, secret logging, caller URL/service or identity mismatch |
| J immutable release build | Build the Rust launcher from a clean source archive twice; create canonical manifest, module inventory, evidence and policy; sign DSSE with an independent Ed25519 release key | Commit/tree/locks/toolchain/target/env/modules/artifact/two-build/Authority pins match and signature is current; installed by digest outside checkout | Dirty tree, unknown field, mutable artifact, differing build, expired signature, release key reused for claim/deploy/approval |
| K resumable orchestration | On every start verify release and exact claim; persist Controller intent, POST once, read twice; then repeat for Edge; append immutable evidence | Crash at every boundary converges to one claim and at most one POST per service; inflight restart is readback-only; receipt hash chain seals | Any second POST, skipped state, result inferred from HTTP success, mutable evidence, target drift or backward generation |
| L staging ceremony | After exposed-token revocation proof and independent review, provision isolated control D1/Authority/Access with all gates false; apply/read back 0059/0060 and run synthetic fault matrix | Exact resource/version/route/policy/catalog and zero business/provider/financial/customer delta retained against one signed candidate | Missing revocation, mixed candidate, unknown endpoint, customer traffic, unexplained delta or inability to disable |

The native transport permits no POST retry. Validated 4xx is terminal rejected
evidence; timeout/reset/truncation/invalid success body, 408/425/429/5xx and
Authority outcome-unknown are ambiguous and schedule exact authenticated
readback only. Cloudflare deployment success still requires the reviewed
target at 100 percent in two stable observations.

The checked-in Rust launcher remains `enabled=false`; its `--execute` path
fails before credential or network use. This closes the mutable script as
trust-root design gap, but not signed release provenance or orchestration.
There was no remote action in this increment. Production remains **NO-GO** and
Go/VPS remains hot authority.

## 2026-07-23 Detached Release And Fresh-Intent Addendum

This addendum supersedes the release shape and reference-mutation boundary in
phases J-K above.

The release is deliberately detached. The compiled launcher pins only fixed
packet/policy names, release-policy digest, independent release-key SPKI
digest, and staging Authority origin. The post-build canonical manifest binds
the executable plus source, build, evidence, and Authority identities and is
signed once with standard DSSE Ed25519 PAE. A later create-new publication
receipt binds packet, policy, and executable without requiring the executable
or manifest to contain its own final digest.

The local verifier and source collector now enforce exact packet schemas,
signature/policy windows, key separation inventory, clean commit-object input,
portable module closure, repeated-build digest equality, artifact
TOCTOU/symlink/hardlink defenses, and no runtime authority. This is not a real
release ceremony: two isolated builds, retained evidence, an independent
signature, compiled non-null pins, digest installation, and publication
receipt remain open. Rust-side sidecar/current-executable verification is now
implemented by the later release-authorization addendum.

The JavaScript reference deployment transport now has a structural one-write
boundary:

1. canonicalize and freeze trust; reject overlap among transition,
   authorization, and permit signing keys;
2. accept a mutation capability only from an exact authenticated Authority
   `step_appended` response for the just-persisted intent;
3. bind that opaque capability to authorization ID, claim digest, phase/state
   version, step digest, and canonical request digest;
4. consume it before any request validation or network I/O;
5. match current claim validity, credentials, policies, account, ledger,
   service, target, URL, body, full authorization annotation, semantic intent
   digest, and persisted request digest; and
6. perform at most one POST. Replayed intents, ambiguity, validation failure,
   process restart, or permit reuse yield zero additional POSTs.

The Rust-owned orchestrator must preserve this capability property with a
private, non-cloneable `FreshIntentPermit<S>` created only by the
`step_appended` branch. Reducers over restored snapshots must never return a
deployment write. The remaining acceptance campaign must inject a crash before
send, during send, after response, after each readback, and after each receipt
append, then prove lifetime POST count at most one per service.

No remote Cloudflare operation, credential read, release signing, artifact
installation, customer traffic, provider call, or financial mutation occurred.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-23 Rust Resumable Orchestrator Core Addendum

This addendum supersedes only the statement above that the Rust capability and
snapshot reducer are entirely open. The new library is offline and
non-authorizing; phases J-L still require an enabled immutable release, live
bounded clients and retained remote evidence.

| Phase | Required action | Pass evidence | Abort and retain |
| --- | --- | --- | --- |
| K0 snapshot reconstruction | Read bounded strict Authority claim/state/steps/expiry bytes and reconstruct one continuous versioned history | Claim/state/final timestamps bind; every version occurs exactly once; canonical claim/step/expiry digests match; duplicate/unknown/mixed query results fail | Any gap, duplicate, digest/actor/status/time mismatch, oversized body or unknown field |
| K1 pure resume decision | Derive only read, intent append, inflight observation, Authority wait or receipt seal from verified state and current time | Controller/Edge inflight remains readback-only before and after expiry; terminal states cannot prepare intent; no reducer branch returns deployment POST | A restored, replayed, expired or terminal snapshot can schedule a write |
| K2 fresh intent append | Consume a typed prepared intent into one request-ID-bound append attempt; accept only exact `step_appended` | Response binds request ID, authorization, claim, state/status, step digest and Authority version; `step_replayed` mints no permit | Generic/reusable response bytes, replay, ambiguity or drift can mint a permit |
| K3 single transport join | Consume the typed permit and exact canonical request digest at the sole Rust deployment POST call site | Lifetime deployment history contains at most one POST per service; pinned account/service/target/body match | Descriptor-only send, clone/serialization, force, retry/fallback, caller URL or second POST |
| K4 stable result proof | On accepted or ambiguous response, perform two authenticated exact target reads under signed timing bounds and append one terminal/recovery step | Same target/deployment set/version details twice; post-readback request digest matches persisted intent | HTTP success alone advances state, pair is too close/old, reads drift, or ambiguity is resent |
| K5 receipt and restart | Append create-new hash-chained digest-only evidence and restart after every durable/network boundary | One continuous receipt chain binds release, Authority version, claim, steps, reads and final state; every inflight restart reads only | Mutable/overwritten receipt, secret/body leak, missing predecessor, skipped observation or write after restart |
| K6 signed artifact campaign | Verify fixed sidecars/current executable, then run concurrent/crash/fault matrix with the exact digest-installed artifact | Two isolated builds match, independent DSSE passes, release/module closure includes orchestrator, complete fault packet is retained | Writable/unpinned executable, unsigned/mixed candidate, missing crash point or non-reproducible build |

### Required fault points

The campaign must kill or isolate the runner at least:

1. before and after fixed-sidecar/current-executable verification;
2. before and after each credential identity proof;
3. before claim POST, after claim response loss and after exact claim readback;
4. before Authority intent append, after append commit/response loss, and after
   fresh append confirmation;
5. immediately before the deployment POST, during upload, after headers, after
   response loss and before the first readback;
6. before, between and after both stable readbacks;
7. before and after each post-readback Authority append; and
8. before and after each local receipt append and final seal.

Run each point for Controller and Edge, with two concurrent runner processes,
Authority 4xx/5xx/timeout/truncation, D1 outcome-unknown, Cloudflare
408/425/429/5xx/reset/invalid JSON, clock-boundary expiry and target drift.
The invariant is lifetime count, not per-process count: no restart or second
process may create a second deployment POST for one service under one
authorization.

### Rollout consequence

This core advances local readiness from "state machine absent" to "pure
decision and capability boundary implemented." It does not advance phase L.
The Rust HTTP/credential/release/receipt integration, signed stable-read timing
policy, real fault campaign, exposed-credential revocation, isolated control
D1/Authority/Access resources, four-layer old/new ring overlap, P5-B and
Go/VPS drain remain mandatory. No remote action occurred; production remains
**NO-GO**.

## 2026-07-23 Rust Release Authorization Addendum

This addendum advances only the local phase-J runtime verifier. The checked-in
launcher remains disabled, and phases K-L remain blocked.

| Phase | Required action | Current evidence | Remaining pass evidence | Abort and retain |
| --- | --- | --- | --- | --- |
| J0 compiled root | Validate fixed enabled flag, policy/key/origin pins before clock, filesystem, credential or network access | Implemented in Rust; checked-in null pins fail first | One reviewed release build with non-null immutable pins | Runtime override, placeholder pin, alternate origin/path |
| J1 sidecar verification | Read current executable plus fixed policy/packet siblings; verify canonical exact schemas, one Ed25519 DSSE signature and bounded time windows | Rust unit/cross-language vectors pass | Independent packet/key review from frozen release workspace | Unknown/duplicate field, invalid PAE/signature, future/expired policy or packet |
| J2 provenance closure | Verify 18 required modules, Git/locks/package, two-build/evidence/Authority identities and permit-key separation | Rust and JavaScript closure/tamper tests pass | Two separately extracted real builds and retained evidence | Missing/transitive module drift, key reuse, build/evidence/Authority mismatch |
| J3 installed artifact | Verify stable regular current-executable bytes, signed name/length/digest and compile target | Rust rejects symlink/replacement/parent/Unix-hardlink/foreign-target drift; JS rejects Windows hardlinks pre-install | Atomic digest-addressed generation outside checkout | Mixed sidecars, in-place overwrite, writable active generation, path/link drift |
| J4 publication receipt | Bind final policy, packet, executable and activated generation after signing | Rust signed publication verifier plus create-new generation and append-only predecessor-CAS activation are implemented locally | Real signed candidate installed under an operator-owned root plus independent byte/activation readback | Missing/overwritten receipt, digest drift, ambiguous activation |
| K execution join | Read fixed credential handles only after J0-J4; sole POST consumes typed fresh permit | Rust release and pure capability cores are separate and fail closed | Bounded Authority/read/deploy clients, stable reads, execution receipt and crash campaign | Credential before release, generic/retry send, restored permit or duplicate POST |

Required release-campaign order:

1. freeze one clean commit and review the 20-path module inventory;
2. build twice from separate archive extractions under the pinned Rust 1.78
   toolchain and fixed environment;
3. run complete local/fault/security/no-secret gates against both identical
   executables;
4. generate the external policy and DSSE packet with an independent release
   key, then independently verify all bytes;
5. compile the reviewed non-null policy/key/origin pins into the final launcher
   and repeat the two-build comparison;
6. pre-install link/path checks, install one create-new digest generation, and
   seal/read back the publication receipt; and
7. run the disabled-write staging preflight before any consideration of
   credentials or remote mutation.

The release packet alone never authorizes installation, customer traffic or a
Cloudflare write. Missing credential-revocation evidence, any mismatch between
the reviewed and installed generation, or any unexplained business/provider
delta keeps Go/VPS authoritative and production **NO-GO**.

## 2026-07-23 Append-Only Publication Activation Addendum

Phase J4 now has a local Rust implementation. This does not advance phase K or
authorize a real installation.

The implementation replaces the planned mutable activation pointer with an
append-only protocol:

1. release-key DSSE signs a distinct publication payload type;
2. the payload binds the exact release policy, packet and executable plus a
   canonical three-file generation digest;
3. its manifest digest derives the create-new publication directory;
4. activation sequence 1 requires no predecessor, while every later sequence
   signs the exact prior publication-manifest digest;
5. the installer creates and flushes all four generation files, re-verifies
   them, and freezes the directory;
6. one fixed 20-digit sequence activation record is created last and binds
   manifest, outer packet, generation and predecessor digests; and
7. runtime authorization verifies that record and the compile target before
   credential access.

| Fault | Durable observation | Recovery/abort rule |
| --- | --- | --- |
| Crash before generation directory | No candidate bytes | Retry only with the same independently verified candidate |
| Crash during file creation | Unactivated partial manifest-hash directory | Quarantine and repair forward; never overwrite/adopt/delete automatically |
| Crash after readback/freeze, before activation | Complete but unactivated generation | Independent evidence may authorize a new forward candidate; it cannot execute |
| Two candidates at one sequence | One create-new activation path | First complete create wins; loser remains unactivated and is quarantined |
| Activation short write or replacement | Runtime canonical/exact-byte verification fails | No credential or network access; preserve evidence |
| Predecessor mismatch or gap | New generation is not created | Re-read append-only history and issue a newly signed next candidate |

The real ceremony must still prove filesystem ownership/ACLs, Windows source
hardlink rejection, Unix link count one, two isolated Rust 1.78 builds,
independent signature custody, power-loss durability, process-manager launch
from the selected generation, and exact readback from a non-checkout root.
Until then the checked-in launcher remains disabled and production is
**NO-GO**.

## 2026-07-23 Activated Credential Boundary Addendum

This addendum advances the local part of phase K execution integration. It
does not authorize credential provisioning or network access.

| Phase | Required action | Current local evidence | Remaining pass evidence | Abort and retain |
| --- | --- | --- | --- | --- |
| K0 activation capability | Produce activation only from checked-in release trust and exact installed publication | Current verifier/capability are crate-private; alternate caller trust cannot mint activation | Independent binary/API review of the exact signed build | Public/custom-trust activation path or reusable capability |
| K1 credential trust | Match compiled account/role/Authority/permit/trust-config pins to the activated signed release | Disabled/null checked-in trust; exact validation and mixed-generation tests | Reviewed non-null pins compiled into two identical builds | Runtime override, pin drift, shared role identity or unsigned config |
| K2 fixed loading | Read account, then read/claim/deploy from exactly four fixed handles; zeroize all secret storage | Counted fake source proves order and zero reads on disabled/mismatched trust | Service-account environment/ACL evidence with no process or log exposure | Enumeration, alias/file/CLI fallback, account mismatch or leaked secret |
| K3 token identity | Prove read/deploy active token ID hashes with bounded duplicate-free responses | Consuming Rust typestate and JS negative tests pass | Bounded no-proxy client plus account/owner/scope/revocation attestation | ID/status drift, wrong account, writable read token or over-scoped deploy token |
| K4 claim identity | Produce exact HS256 preflight and match claim ID, request, Authority version and permit SPKI | Rust/JS/Authority fixed vector agrees; JS preflight is private and proofs are atomic | Explicit Cloudflare Access workload identity, deployed policy/readback and bounded Rust Authority client | HMAC-only Access bypass, public preflight, partial proof state or identity drift |
| K5 coherent execution | Consume fully verified credentials in coherent claim resume and sole typed POST | Pure orchestrator and credentials are separate, private capability cores | One client owns stable reads, canonical request bytes, fresh permit, deploy token and one POST | Generic send, restored/forged permit, retry, clock rollback or second POST |

### Credential fault matrix

The exact signed generation must be killed or failed:

1. before credential trust, after credential trust and before account read;
2. after account read/hash and before each secret read;
3. before/after read token verification and deploy token verification;
4. before HMAC construction, after preflight send, on response loss and after
   response identity validation; and
5. after all identities verify but before claim read/create.

Every restart begins again at release/publication activation. No partial proof
is persisted or reconstructed. A failed revalidation clears all proof state
and zeroizes every loaded secret.

### Identity evidence still required

Cloudflare `/tokens/verify` returns active ID evidence, not an authoritative
least-privilege scope attestation. The ceremony must separately retain
redacted token owner/account/scope/revocation records and prove read/deploy
role separation.

The private Authority is also expected to sit behind Cloudflare Access.
HMAC authenticates the runner protocol and the Ed25519 permit authorizes a
claim; neither authenticates the workload to Access. Before K4 can pass, the
deployment design must explicitly freeze either Access service-token handles
and exact headers or a reviewed WARP/mTLS identity. Ambient browser sessions,
proxy credentials and undocumented header injection are abort conditions.

No credential value, Cloudflare API call, remote resource or mutation was used
for this addendum. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-24 Bounded Native Control Plane Addendum

This addendum supersedes the local K2-K5 status above. The bounded Rust
identity/Authority client and sole typed deployment POST now exist locally.
Stable readback, receipt durability, enabled signed release evidence, and all
remote acceptance remain open.

| Phase | Implemented local boundary | Required production evidence | Abort and retain Go/VPS |
| --- | --- | --- | --- |
| K2 six-handle load | Account, read, claim-HMAC, deploy, Access client ID, Access secret; account and Access client-ID compile-time pins; pairwise distinct zeroized material | Service-manager ACL/process-owner evidence and redacted fixed-handle inventory for the exact installed generation | Alias/fallback/enumeration, shared material, runtime pin override or secret in process arguments/logs |
| K3 ordered identities | Account-scoped read/deploy token verification followed by Access service-token + HMAC Authority preflight | Remote account/owner/scope/revocation packet plus deployed Access app/policy/service-token readback | HMAC without Access, writable read token, broad deploy token, version/SPKI/client-ID drift |
| K4 coherent resume | Bounded exact-claim GET binds claim, credentials, build, trust config and service names | Authenticated isolated-staging claim read from the exact Authority version and control D1 catalog | Mixed snapshot, shared application D1, unknown field, claim/build/service drift |
| K5 typed one POST | Canonical request owns service/target/body/digest through fresh append permit; private transport consumes it once; no redirect/proxy/retry | Deployment history plus crash campaign proves lifetime at most one POST per service and exact body annotation | Caller URL/body, permit restoration, any automatic/manual resend, unexpected deployment |
| K6 stable proof | Not implemented | Two policy-timed authenticated reads match target, deployment set and version details; exact Authority post-readback append | HTTP response alone advances state, unstable pair, target drift, read after policy expiry |
| K7 receipt/restart | Not implemented | Create-new predecessor-bound digest-only receipt survives kill/power-loss and every restart remains readback-only | Mutable receipt, missing predecessor, secret/body leak, inflight restart can write |

### Transport acceptance profile

- Linux release: `hyper-rustls 0.27.7`, WebPKI roots, `ring`, TLS 1.2+,
  HTTP/1, direct HTTPS only.
- Windows local validation: Schannel via `hyper-tls 0.6.0` and
  `native-tls 0.2.13`, TLS 1.2+, HTTPS only.
- Both: fixed origins and paths, one shared response deadline, endpoint byte
  limits, JSON-only unencoded bodies, no proxy, redirect, retry, caller URL,
  subprocess, Wrangler, or SDK fallback.
- Mutation classification: only valid `success=true` 2xx is transport success;
  explicit non-timeout 4xx is rejected; redirect, response loss, malformed
  response, 408/425/429, and 5xx are ambiguous; every class has
  `retry=false`.

The signed source closure is 21 paths including `transport.rs`. Before phase L,
the release owner must reproduce the exact Linux bytes twice under Rust 1.78,
independently sign and install them, compile reviewed non-null release,
credential, Access, Authority, account, and service pins, then run the required
two-process fault matrix.

No tracked default/staging/production mutation gate changed. No credential or
remote request was used. The exposed-credential revocation proof, isolated
control resources, Access policy, stable readback, receipts, P5-B,
accounting/SLO/cost, rollback, G1-G8 approval, and Go/VPS drain remain hard
blockers. Production remains **NO-GO**.

## 2026-07-24 Stable Readback And Observation Append Addendum

This addendum supersedes the K6 local-status row above. K6 is implemented
locally; no remote acceptance evidence has been produced.

| Phase | Implemented local boundary | Required production evidence | Abort and retain Go/VPS |
| --- | --- | --- | --- |
| K6 stable proof | Trust-pinned 5-120 second interval; fixed deployment/version GET pair, wait, second GET pair; strict normalized deployment and complete target-version hashes; sealed Controller/Edge observation phases; exact Access/HMAC Authority append or replay | Two independent reads against the exact isolated staging account/services, deployed Access policy identity, exact Authority version, deployment history, redacted evidence digest, and state 3/6 readback | Any Access header on Cloudflare API, mutable interval, retry, redirect, unstable pair, annotation/version drift, fabricated evidence, or HTTP response alone advancing state |
| K6 restart | Restored inflight claims can construct readback-only ambiguity and cannot mint a fresh intent permit or deployment request | Kill before/after each of four GETs and before/during/after Authority append; restart from exact claim; prove no second deployment POST | Any restart path that accepts caller body/digest, reuses deploy authority, or advances without exact current state |
| K7 receipt/restart | Still open | Create-new predecessor-bound digest-only execution receipt, independent replay verifier, retention/ACL evidence, and power-loss recovery | Mutable or replaceable receipt, missing predecessor, secret/raw body retention, or unrecoverable ambiguous append |

The fixed network order is deployment GET, target-version GET, compiled wait,
deployment GET, target-version GET, then at most one Authority step POST. The
four Cloudflare reads use only the least-privilege read token. The Authority
POST alone uses the Access service token plus claim-HMAC proof. Any failed
read, invalid clock window, parse drift, or failed append leaves the claim
inflight and schedules no write retry.

The signed source closure is 22 paths including `transport.rs` and
`readback.rs`. The exact Rust 1.78 Linux reproducible artifact, independent
signature and append-only installation, remote token scope/owner/revocation
packet, deployed Access readback, crash campaign, execution receipts, P5-B,
accounting/SLO/cost, rollback, G1-G8 approval, and Go/VPS drain remain hard
gates. Production remains **NO-GO**.

## 2026-07-24 K7 Execution Receipt V1 And Recovery Boundary

This addendum freezes the K7 production contract and records the local Rust
terminal projection, create-new writer and replay verifier. It does not claim
real-time driver integration, installed-filesystem independent verification,
Linux durability proof or an external anchor. A separate JavaScript verifier
currently covers canonical in-memory replay. K7 remains open.

### Receipt V1 contract

Each authorization owns one independent append-only chain under a fixed,
release-controlled receipt root. A chain starts at sequence 1 and cannot be
joined to, continued by or used to repair another authorization. Every record
is bounded canonical JSON with an exact closed schema, duplicate and unknown
fields rejected, no floating-point values, and one byte representation shared
by the Rust writer and an independent verifier.

Receipt content is digest-only. It may bind the authorization, claim and
owner digests; Authority ledger/version identity; installed release,
publication and credential identities; state version; allowlisted event and
failure classifications; request-ID, request, response, deployment-set,
version-detail, observation and evidence digests; bounded timestamps; and
terminal status. It must never retain a credential, authorization header,
Access material, HMAC value, permit, request or response body, provider
payload, SQL text/error, or unbounded Cloudflare metadata.

`receiptSha256` is SHA-256 over the complete canonical record bytes and is not
serialized into that same record. Sequence 1 has a null predecessor; every
later record carries the exact prior `receiptSha256`. The fixed path is:

```text
execution-receipts/<authorizationIdSha256>/<sequence:020>.receipt.json
```

The writer may create a missing next record only when its expected predecessor
exists, is canonical, hashes exactly and is not terminal. An existing target
is an idempotent replay only when its bytes equal the proposed canonical bytes.
Different, truncated, noncanonical, linked, out-of-order or post-seal content
is a hard conflict: do not overwrite, delete, skip, truncate or repair it in
place.

The last record is a `terminal_seal`. Only Authority-verified
`completed`, `recovery_required`, `aborted` or `expired` state may produce it.
It binds the final state version and snapshot/evidence digests, terminal time,
chain length and predecessor. No record is valid after the seal. Repair
requires a new authorization; an old chain is retained as evidence.

### Linux publish and durability boundary

The production writer is Linux-only. It must hold trusted directory
descriptors and resolve beneath them with `openat`, `O_NOFOLLOW`,
`O_EXCL` and regular-file/link-count checks. It writes and verifies a private
same-directory staging object, applies final receipt permissions, calls file
`fsync`, and publishes with `renameat2(RENAME_NOREPLACE)` or a reviewed
equivalent create-new primitive. It then `fsync`s the receipt directory and
every newly created parent directory before reporting success, followed by an
independent exact-byte readback.

A failure after possible publication or during parent-directory `fsync` is
`durability_unknown`, not permission to rewrite. Recovery reopens the fixed
sequence and accepts only the exact canonical bytes and digest; missing content
may retry only the same bytes after predecessor revalidation. Conflict,
partial content, unsafe type/link/path, a replaced directory or an unverifiable
filesystem stops execution and preserves the installation for audit.

Windows runs validate canonical bytes, predecessor logic, exact replay,
conflict handling and restart semantics only. Windows results are not evidence
for Linux `openat` path confinement, `renameat2` no-replace publication,
single-link enforcement, directory `fsync`, ACLs or power-loss durability.

### Recovery authority boundary

The receipt is an audit projection, never the state authority and never a
deployment capability. Every start re-verifies the signed installed release,
fixed execution activation and credential identities, validates the complete
local chain, then reads the exact current Authority claim. Authority state
alone selects the reducer path. Receipt presence, absence or a locally observed
success can never advance the claim or authorize a Cloudflare write.

A fresh, process-local, non-serializable POST permit exists only after the
current process obtains an exact fresh Authority intent append. It is never
written into a receipt and is never reconstructed after response loss, process
death, reboot or failover. Restarted `controller_inflight` and `edge_inflight`
claims are readback-only. A durable pre-POST authorization record means the
request may have escaped; restart therefore performs stable readback and
Authority observation only, never another deployment POST. Ambiguous receipt
append results are resolved by exact fixed-path readback, not by replaying a
network mutation.

### Remaining K7 gates

The local Rust writer/replay foundation now covers canonical terminal
projection, exact predecessor replay, conflict/gap/post-seal rejection and
directory synchronization. K7 passes only after all of the following are
retained for the exact signed Linux artifact:

1. the Rust writer is integrated before and after every network boundary and
   the independent JavaScript replay verifier agrees on every canonical
   vector, predecessor, exact-replay, conflict and terminal-seal rule and is
   extended to securely read the installed Linux chain;
2. two concurrent processes plus the full kill matrix prove at most one
   deployment POST per service lifetime and no restored permit;
3. operator-owned UID/GID, directory ownership, append-only writer boundary,
   auditor read access, exact POSIX ACLs, retention and backup policy are
   reviewed and read back;
4. ext4 or XFS fault-injection/power-loss tests prove returned-success files
   and directory entries survive, while `durability_unknown` converges by
   digest-only readback; and
5. the terminal receipt chain head is committed to an independently signed
   P5 evidence packet or reviewed WORM/Authority anchor so whole-chain
   replacement is externally detectable.

Local hashes and read-only mode alone do not satisfy the external-anchor or
deletion-resistance requirement. Until the writer, verifier, ACL, external
chain head, retention and real Linux power-loss evidence pass, K7 remains a
hard blocker, Go/VPS remains authoritative, and production remains **NO-GO**.

## 2026-07-24 Signed Execution Activation Addendum

This addendum inserts a required execution authorization between signed
publication activation and all credential access. It is a local production
boundary only. Checked-in trust is disabled, no live Authority claim was
created, and no Cloudflare API, deployment, route, DNS, customer traffic or
Go/VPS authority changed.

| Boundary | Local contract | Production evidence required | Abort and retain Go/VPS |
| --- | --- | --- | --- |
| Fixed activation | `execution-activations/<publication-manifest-sha>.execution-activation.json`; runner-derived path and identity; no caller target or replace option | Operator-owned installation root, exact signed publication/activation inventory, UID/GID and ACL readback | Caller-selected path/ID/service, mutable current pointer, overwrite, symlink/link/path escape |
| Signed claim request | Strict canonical closed JSON; recomputed claim digest; domain-separated Ed25519 permit; fixed issuer/key/SPKI, locator and bounded validity | Independent verifier agreement, permit-key custody/rotation packet, exact Authority origin/version and Access policy readback | Unknown/duplicate/noncanonical fields, key reuse, locator/retry drift, invalid clock or signature |
| Identity join | Publication manifest/packet/generation/sequence/build/trust joined to policies, account, ledger, three credential IDs, services, authorization, nonce, owner and claim | Redacted cross-system identity packet from release, Authority, Cloudflare token verification and installed generation | Any build/trust/policy/account/service/credential mismatch or mixed generation |
| Create-new replay | Same-directory staging, no-replace publish, exact-byte readback; existing exact bytes are replay, different bytes conflict | Exact Linux no-follow/no-replace/sync/link-count/power-loss and concurrent installer evidence | Replace/delete/repair in place, partial acceptance, ambiguous write treated as permission to rewrite |
| Typestate | `publication -> activation -> credentials -> preflight -> prepared control plane` | Source/release closure and runtime traces proving no handle/network access before activation | Public bypass constructor, reordered handle access, preflight without installed activation |

One publication manifest can authorize only its fixed activation bytes. A new
authorization requires a new signed publication; operations must not rotate an
activation underneath an existing generation. The activation permit
authorizes submission of only the embedded canonical claim request. It is not
a Cloudflare deployment permit, does not advance Authority state, and cannot
restore an inflight mutation capability.

The release closure is 28 modules: the existing 25-module packet plus
the Rust activation implementation, independent JavaScript verifier and its
adversarial tests. Both collectors agree on the 28-path inventory and all
derived release/publication vectors. The merged local runner gates observed
76 library, one binary, two CLI and 38 JavaScript tests; the broader
ring-transition suite observed 65 tests and repository-wide `bun run check`
exited successfully.

Remaining P0 is:

1. live Authority claim creation and exact response-loss recovery;
2. typed T1 and Edge-previous phases;
3. live predecessor-bound receipt append around every network boundary;
4. the library-owned restart/resume driver;
5. Linux adversarial concurrency, path/link, crash, sync and power-loss tests;
6. full four-approval authorization revalidation;
7. an external independently signed or reviewed WORM chain-head anchor;
8. actual exposed-credential revocation and replacement evidence.

Until all eight items and the broader production gates pass, the activation is
local fail-closed evidence only, Go/VPS remains authoritative, and production
remains **NO-GO**.

## 2026-07-24 Single-Action Driver Addendum

Phase K now has a compiled local reducer boundary. This changes the
implementation status, not the production decision.

| K subphase | Current status | Required production evidence | Abort and retain |
| --- | --- | --- | --- |
| K1 startup authorization | Implemented locally: every call re-verifies release, publication, signed activation, credential identities, operation chains and exact Authority state | Signed Linux candidate trace proving fixed ordering and no credential proof network request before local receipt audit | Any caller-injected state, skipped verification, ambient handle or mixed generation |
| K2 crash recovery | Implemented locally: every real unfinished mutation start is sealed ambiguous; no existing start restores send authority | Two-process kill/response-loss matrix on exact Linux artifact, including parent sync and backup/restore | Any second POST, synthetic start, overwritten finish or restored permit |
| K3 one-action reducer | Implemented locally: fresh claim stops; each state performs one legal reduction; inflight restart is deployment-read-only | Isolated staging lifetime counters proving at most one Controller and one Edge deployment across restarts/failover | Two reductions per invocation, second deployment, HTTP success treated as state, skipped readback |
| K4 complete receipt closure | Partial locally: every current GET is request-bound; terminal/external closure remains open | Every operation head bound to terminal seal and independent WORM/signed anchor | Missing request boundary, locally replaceable whole history or observation treated as authority |
| K5 durable owner and execution adapter | Open | Versioned DO supervisor owns state/fencing/alarms/drain; disposable Container adapter survives crash/fault/load/cost campaigns | Container memory becomes authority, split generation, unfenced alarm or provider retry |

The local reducer model is consistent with the source migration boundary:
cinaVibeSDK places durable state in a Durable Object and delegates disposable
execution, while cinatoken Go requires CAS ownership before winner-only side
effects. Cloudflare production must preserve both: the DO/Authority is the
durable owner; Container and native runner capabilities are ephemeral and
rederived from exact persisted state.

K1-K3 local completion cannot start phase L. Phase L still requires
replacement-credential revocation evidence, secure Linux receipt
installation, K4-K5 completion, remote default-disabled resource/config
readback, the complete fault/load/cost/SLO/rollback packet, remaining Go
compatibility, Go/VPS hot fallback/drain and G1-G8 against one immutable
candidate. Production remains **NO-GO**.

## 2026-07-24 Read-Only Operation Receipt Addendum

K4 request-boundary coverage is implemented locally for all native Authority
and Cloudflare GETs. Each read has a unique local nonce, absolute HTTPS target
digest, read/deploy/endpoint kind, legal state version, create-new start before
send and first-terminal finish. Receipts are non-authorizing; exact Authority
or stable Cloudflare evidence still selects state.

The restart and capacity rules are now explicit:

- an existing read operation performs zero network;
- unfinished starts are sealed ambiguous without recreating authority;
- `408`, `425`, `429`, redirect, `5xx` and response loss are ambiguous;
- Cloudflare observations cannot start after claim expiry;
- exact claim and identity proofs have at most 600 seconds of read-only
  recovery after expiry; and
- 128 fixed create-new capacity markers are available per authorization; the
  129th contender persists no operation directory/start and cannot progress
  to network. A crash-stranded marker consumes capacity without authorizing a
  send. A marker-backed empty operation directory is also ignored by audit and
  recovery until the exact operation resumes normal slot-1 publication;
  markers and history are never deleted or reused.

This changes K4 from open to partial locally. It does not satisfy terminal
closure: an operator with directory-write access can still replace an entire
internally consistent operation tree. Phase K remains blocked until all
execution and operation heads are committed to the terminal seal and an
independently reviewed signed/WORM anchor.

Phase L also remains blocked on exact Rust 1.78 Linux process/path/link/fsync/
ACL/backup/ext4/XFS/power-loss proof, replacement-credential isolated staging,
the versioned DO shard supervisor and disposable Container adapter, remaining
Go compatibility, credential revocation, Go/VPS hot fallback/drain and G1-G8.
No remote action was performed; production remains **NO-GO**.

## 2026-07-24 K7 Aggregate Local Closure Addendum

This addendum replaces the earlier K4 wording that required modification of
the Execution Receipt V1 terminal seal. Execution Receipt V1 is frozen and
unchanged. The local aggregate is formed by two separate immutable objects:
`OperationHeadSetV1` and `OperationHeadLocalSealV1`. This is the required
production contract, not a claim that the current implementation or Linux
evidence has passed.

`TerminalSnapshotCandidateV1` is the durable pre-closure bridge for an
accepted terminal Authority GET. Before the operation is finished `accepted`,
the runner create-new publishes the canonical verified snapshot plus its
digest/length, exact GET operation/start receipt, HTTP/response digests,
finish time and expected Execution Receipt head/count. The candidate is an
admission barrier and remains bound into the final local seal.

### Operator-visible terminal typestate

`OperationHeadSetV1` is a canonical slot-sorted inventory of every published
capacity marker for one authorization. It includes both:

- terminal operation chains, with their exact start digest, two-receipt count,
  terminal head and outcome; and
- marker-only reservations, with zero receipts and no head or outcome.

Its exact entry count and recorded counts must satisfy:

```text
entries = capacityReservationCount
capacityReservationCount = operationCount + markerOnlyCount
capacityReservationCount <= 128
```

`OperationHeadLocalSealV1` is the local aggregate root. It binds the terminal
Execution Receipt V1 head, receipt count, terminal status and state version to
the exact head-set SHA-256, canonical byte length and all three counts. It
also carries an all-null or all-populated candidate tuple: candidate
SHA-256/bytes and candidate operation/start-receipt identities. A populated
tuple must resolve to an `accepted` terminal head-set entry and to the exact
installed terminal execution chain. The terminal states are therefore:

| Observed durable state | Operator interpretation | Allowed next action |
| --- | --- | --- |
| Nonterminal execution chain; no head set | Resumable, not closed | Re-audit locally, then perform at most one separately authorized reducer action |
| Terminal candidate present; operation finish/closure incomplete | Admission closed, accepted terminal response is locally recoverable | Recover the bound accepted finish and complete all closure objects without network |
| Terminal execution chain only | Admission closed, aggregate recovery required | Local-only finish of existing starts and head-set construction |
| Head set present; local seal absent | Operation tree frozen, closure interrupted | Verify exact bytes and publish only the implied local seal |
| Valid local seal present | Full local terminal closure | Export for external signing/WORM anchoring; no further operation |
| Any conflict or impossible combination | Quarantined | Disable candidate, retain evidence, create a new authorization |

The V1 execution terminal seal alone is not full K7 closure. A head set or
terminal execution chain, a committed terminal candidate, or indeterminate
operation/closure staging is an admission barrier: no new capacity
reservation, identity proof, credential proof or network call may start.

### Linux linearization procedure

All reserve, finish, recovery and closure mutations use one exclusive
per-authorization Linux `flock`. The lock is acquired on a fixed trusted local
filesystem authorization-directory inode after current path/type validation
and is held through
re-audit, create-new publication, file sync, parent sync and exact readback.
The lock is released before network I/O after a reservation and reacquired to
record the finish. It is never treated as durable evidence or a capability.

Current Windows/local evidence does not establish the production Linux path
boundary. The implementation locks one authorization-directory inode but
still re-resolves later pathnames. Production requires pinned trusted-parent
and authorization dirfds, `fstat` UID/GID/mode/inode continuity, contained
`openat2`/`*at` scans/publications and real rename-replacement contention
tests. Until then, directory replacement can split the intended lock domain
and K7 remains open.

For every process start:

1. load and locally bind only the fixed activation-scoped credential handles;
   make no remote identity proof or network call;
2. acquire the authorization lock and audit the execution chain, all 128
   marker slots, operation directories and both closure objects;
3. treat any recognized operation/closure staging without its committed
   target as indeterminate durability and quarantine; when a valid terminal
   candidate exists, restore its bound operation as `accepted`, finish other
   unfinished starts `ambiguous`, install its exact terminal Execution Receipt
   plan and publish only the implied aggregate objects;
4. release the lock;
5. proceed to identity and network work only when the execution chain is
   nonterminal, no head set exists, the operation tree is canonical and the
   reducer separately grants a fresh action.

Holding the lock across a Cloudflare request is prohibited. A process killed
while holding it leaves no inherited authority; the kernel releases the lock
and the successor repeats local audit from durable bytes.

### Crash acceptance matrix

| Kill point | Required restart result | Network allowance |
| --- | --- | --- |
| Before marker publication with no durable target/staging residue | No slot consumed | Only a later fresh reservation may send |
| Candidate/operation/closure staging remains without committed target | Quarantine as indeterminate durability | Zero |
| After marker, before start | Marker retained and later sealed as `marker_only` if terminal | Zero during recovery |
| After start, before/during response | Start finished `ambiguous` locally when recovering | Zero resend |
| After terminal candidate, before accepted finish | Candidate-bound accepted finish is recovered; terminal chain and aggregate seal are completed | Zero |
| After terminal finish | Exact finish retained; head set may be constructed | Zero during closure |
| After head-set publication | Head set is immutable admission barrier; publish exact local seal | Zero |
| After local-seal publication | Verify full typestate and return existing closure | Zero |
| Candidate deleted/replaced after local seal | Local seal verification fails; quarantine | Zero |
| Lock-holder death at any point | Next process reacquires and re-audits all durable state | No inherited send permit |
| Conflict, unsafe path or count drift | Quarantine without repair | Zero |

### K7 local and external gates

K4 becomes locally complete only when one exact Linux artifact proves:

1. Execution Receipt V1 vectors and bytes remain unchanged;
2. Rust and an independent verifier agree on canonical head-set and local-seal
   vectors, including every marker-only slot and the candidate tuple;
3. two competing processes cannot reserve or finish across either admission
   barrier and cannot publish different aggregate bytes;
4. every crash row above converges without deletion, overwrite, slot reuse,
   synthetic start or network replay;
5. fixed-path, symlink, hard-link, dirfd/inode continuity, owner, mode, ACL,
   local-filesystem `flock`, `openat2`, no-replace, fsync, backup/restore and
   ext4/XFS power-loss checks pass; and
6. pre-identity and pre-network counters remain exactly zero throughout local
   recovery and closure.

Local completion is not external anchoring. A future independent DSSE signer
must sign the exact local seal and candidate identity. A separate provider
WORM proof must demonstrate object identity, retention deadline, retention
mode and denied deletion/overwrite. Signature validity and retention are
separate gates and must not be collapsed into one checkbox.
A candidate-less local seal may verify structurally for older or non-claim
terminal history, but it cannot satisfy production claim-read promotion.

### Rollback and irreversibility

Published candidates, markers, operation receipts, head sets and local seals
are never deleted, replaced, truncated or reused. Publication of the head set
irreversibly freezes that authorization's operation tree. Publication of the
local seal irreversibly closes its local terminal typestate. A failed or
conflicting closure cannot be rolled back in place; quarantine it and issue a
new authorization.

Operational rollback disables the candidate first, performs no additional
Cloudflare mutation from the quarantined authorization, returns new work to
hot Go/VPS, and preserves local, DSSE and WORM evidence for review. Key
revocation does not erase historical signature evidence, and retention expiry
does not invalidate the signature claim; each lifecycle is reviewed
separately.

The audited cinaVibeSDK and cinatoken Go source trees have no direct parity for
this aggregate closure, Linux lock protocol, DSSE anchor or provider WORM
retention. They remain sources for durable-owner and CAS-winner principles
only. Until local K4, external anchoring, K5, isolated staging, compatibility,
rollback, Go/VPS drain and G1-G8 all pass for one immutable candidate, Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-25 K7 Linux Publication-FD Gate

The first Linux pathname hardening increment is implemented at the immutable
file publication boundary. Every execution receipt, operation receipt,
capacity marker, terminal candidate, operation head set and local seal now
uses one opened parent directory descriptor from staging creation through
`RENAME_NOREPLACE`, parent `fsync` and final target readback. The verifier
binds the installed file to the staging file's dev/inode/UID/GID/mode/nlink
identity and rejects hard links or writable/foreign objects.

The Ubuntu 24.04 gate includes three Linux-only adversarial cases:

1. replace the parent pathname after staging sync and prove the final target
   remains in the original opened inode while publication fails closed on the
   pathname-to-inode mismatch;
2. create a competing target before rename and prove it is never overwritten;
3. add a second hard link to an existing target and require fail-closed
   rejection.

The immutable native evidence is commit
`0b8f50567d30d8c69e51982af44555879d7cf691` and
[run 30142006553](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142006553).
Formatting, 127 Linux library tests and warning-free Clippy all passed. The
clean commit-object inventory contains 31 modules and 1501593 bytes with
SHA-256
`26eea3d220a34d8c6538eedea55dbeca73de858f7965960db64b7c6523a4dac6`.

This is a partial K7 gate. The production transaction still needs a typed
`LockedAuthorization` that owns the trusted root, operation-receipts parent,
authorization, execution-chain and closure dirfds. After `flock`, production
code must accept that type instead of `Path`/`PathBuf`; scans must consume
directory descriptors, children must be opened with reviewed `openat2`
containment flags, and all chmod/rename/fsync calls must use those retained
descriptors. Linux multi-process split-lock, seccomp/strace no-`AT_FDCWD`,
kill-after-sync and ext4/XFS power-loss campaigns remain promotion blockers.

Cloudflare Container root disks are not a persistence layer. The official
[Container lifecycle documentation](https://developers.cloudflare.com/containers/platform-details/architecture/)
states that disk is ephemeral after sleep/restart, and also states that the
Container class is backed by a Durable Object while the DO and container are
not guaranteed to run in the same location. Consequently:

- the per-shard DO owns durable lifecycle/routing state;
- D1/R2 hold shared durable records and immutable artifacts;
- the Linux shard container treats its filesystem as replaceable scratch; and
- K7 release receipts remain in an external reviewed Linux runner store until
  independently anchored in DSSE/WORM storage.

No Cloudflare mutation or credential use is authorized by this gate. Go/VPS
remains traffic, scheduler and financial authority; production remains
**NO-GO**.

## 2026-07-25 K7 Authorization Lock Capability Gate

The next Linux increment replaces the implicit authorization lock convention
with a typed `LockedAuthorization`. The capability retains the opened
`operation-receipts` parent and authorization directory descriptors, their
stable identities and their exclusive `flock` ownership. The authorization
directory is opened relative to the retained parent, not by independently
resolving a second absolute path.

Acquisition takes the parent lock first and the authorization lock second.
This deliberately serializes the low-volume control-plane mutation boundary
so two cooperative runner processes cannot split across old and replacement
authorization inodes. Locks are released before network I/O. Reserve, finish,
local recovery and terminal closure require the capability and revalidate both
path attachments before granting fresh send authority or terminal success.

Commit `63df95c6f8390579e00b2788378abdb89eb5f3c5` is the immutable native
candidate for this gate.
[Run 30142822377](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142822377)
passed formatting, 129 native Linux tests and warning-free Clippy. The local
aggregate runner gate passed 124 Rust library tests, 3 binary/CLI tests and 61
Bun tests with 242 expectations. Clean source evidence is Git tree
`b73035bebda0b3f713243cf1353cef09f3fd0c80`, source archive SHA-256
`05b3eb98b90a9f90f201f4ca0153b8c59767223b165894714d7c3545b89de112`
and module-inventory SHA-256
`8fd60cc8c0849f89ace289d6eb6b099f11f8a061d1226708185e946aa872d971`
for 31 modules and 1509783 bytes.

This gate remains partial. The implementation must next retain the trusted
root, execution-chain, operation and closure descriptors; convert post-lock
tree scans and child operations to reviewed `openat2`/`*at` calls; and prove
zero unapproved `AT_FDCWD` path resolution through syscall tracing. The
promotion campaign still requires real two-process replacement and kill
injection, exact ACLs, backup/restore, ext4/XFS power-loss, external DSSE/WORM
closure, isolated Cloudflare lifecycle tests and G1-G8 approval for one
candidate. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 K7 openat2 Child-Containment Gate

The native Linux child-open primitive now uses `SYS_openat2` with
`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV`. It is shared by:

1. authorization directories opened relative to the retained
   `operation-receipts` parent;
2. immutable staging files created relative to their immediate parent; and
3. immutable targets reopened for bounded stable readback.

There is no legacy-kernel or policy-denial fallback to path-based `open` or
plain `openat`. An unsupported or blocked syscall prevents publication and
fresh send authority. A Linux test accepts a real child and rejects both
`../` escape and symlink traversal.

Commit `7c015f812ca42b73388166abd67b24da4d7cb6ae` passed
[run 30143505878](https://github.com/cinagroup/cinatoken-rust/actions/runs/30143505878)
with formatting, 130 Linux library tests and warning-free Clippy. Clean source
evidence is Git tree `6dd3bd5366171c35295b4dc19d623459f308a34c`,
source-archive SHA-256
`72e9662384e3d2de4c3434fd8ae1df3679d0d741af436152b3ec67f9b33624a7`
and module-inventory SHA-256
`86fa2af05728e11ed6d338e8dfb727489de1a821b38c10626042b735e0250be7`
for 31 modules and 1511043 bytes.

The next implementation gate is not another wrapper. It is the reserve
transaction: terminal-barrier reads, capacity publication, operation
directory creation, operation-chain audit and start publication must all
derive from `LockedAuthorization` descriptors before `Fresh` can escape.
Execution and closure roots, finish/recovery/terminal closure, real
multi-process faults, syscall tracing, ext4/XFS power-loss, DSSE/WORM and
Cloudflare lifecycle evidence remain blockers. Production remains **NO-GO**.

## 2026-07-25 K7 Reserve Operation Dirfd Gate

The Linux reserve path now derives capacity and operation state from
`LockedAuthorization` descriptors through the point immediately before a
fresh send capability is returned:

1. capacity markers publish relative to the retained authorization dirfd;
2. the operation directory is created with `mkdirat` and reopened with
   fail-closed `openat2` containment;
3. operation entries are enumerated with `fdopendir`/`readdir` after rewinding
   the duplicated directory descriptor;
4. receipt children are opened beneath the retained operation dirfd; and
5. start append/readback/verification and operation-directory chmod/fsync use
   that same retained directory object.

The runner compares the retained operation identity with both its
authorization-relative entry and absolute pathname before `Fresh` can escape.
A Linux test renames that directory after descriptor acquisition, recreates
the old pathname and proves fail-closed rejection with no fresh authorization
and no redirected receipt publication. Repeated direct scans are separately
tested to catch shared directory-offset regressions.

Commit `8cf817f081d0001fc7ef1f6992984f990a1f8b50` passed
[run 30144317849](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849)
and
[job 89643177206](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849/job/89643177206)
with formatting, 132 Linux library tests and warning-free Clippy. The local
aggregate gate passed 124 Rust library tests, 3 binary/CLI tests and 61 Bun
tests with 242 expectations. Clean source evidence is Git tree
`a46f6cf1bc1d3f3843fdde28e4c98c60043c8a36`, source-archive SHA-256
`ee1e9c865893fe01075e1baaa169f901b83d996ef27a2c3e3e99c4fe7cbbd781`
and module-inventory SHA-256
`2f9d12f0893b65d88001f61becc08d92a95f818e1ca03849d8bd715f06f3f6f0`
for 31 modules and 1534319 bytes.

[Run 30144186705](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144186705)
remains archived as the intermediate gate: all Linux tests passed, but Clippy
rejected dead fallback code and an over-wide test-hook signature. The final
candidate fixes both without lint suppression.

This gate does not authorize production. The reserve terminal barrier still
re-resolves execution, head-set, closure and candidate paths and is the next
P0. It must become one retained descriptor graph and be revalidated
immediately before `Fresh`; finish, recovery and terminal closure follow.
Publication staging cleanup/error fidelity is a P2 hardening item. Native
multi-process replacement and process-death campaigns, syscall traces,
ACL/restore, ext4/XFS power-loss, external DSSE/WORM, isolated Cloudflare
lifecycle tests and G1-G8 approval remain required. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-25 K7 Reserve Terminal Descriptor Graph Gate

The reserve admission transaction now captures one Linux descriptor graph
after `LockedAuthorization` acquisition. It includes the installation root,
optional execution-receipts root and authorization chain, the retained
operation-receipts/authorization pair, and the optional closure root and
authorization closure. Child acquisition uses the common
`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)` primitive.

The graph distinguishes shared and authorization-specific state. Shared
top-level directories bind inode identity but not global `mtime`/`ctime`;
unrelated authorizations therefore do not invalidate this transaction.
Execution-chain and closure directories bind both identity and content
version. Optional absence is rechecked. Execution receipts, head set, local
seal and terminal candidate are read from retained descriptors, in the same
short-circuit order as the original barrier.

The final authorization-wide audit has also moved from `fs::read_dir(Path)` to
the retained authorization fd. Capacity markers, every sibling operation
directory and each operation receipt are validated directly. Reserve runs the
terminal graph both before capacity mutation and immediately before returning
a reservation. A newly introduced head set stops before start publication.

Commit `79b3f4a3e2534f3249c57e21f9314295d389105e` passed
[run 30147304951](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951)
and
[job 89651524827](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951/job/89651524827)
with formatting, 136 Linux library tests and warning-free Clippy. The local
aggregate gate passed 124 Rust library tests, 3 binary/CLI tests and 61 Bun
tests with 242 expectations. Clean source evidence is Git tree
`85e4f7f267996c3d128a30bef6bfc17e1b3d780b`, source-archive SHA-256
`c0dd0f59f9582f9c18b20271f851c67a104341abaad36ae15fe02a3b7a851dd5`
and module-inventory SHA-256
`51e2c990d72bf140588ffa175f73600abbd4b6ffa4319a0ef0f9e63d674f8890`
for 31 modules and 1569772 bytes.

The preceding
[run 30145270642](https://github.com/cinagroup/cinatoken-rust/actions/runs/30145270642)
is archived as a Linux-only test-compilation failure caused by a duplicate
fixture name. The correction renamed that fixture and left production logic
unchanged.

This gate proves official-writer linearization and fail-closed drift detection
after graph capture. It cannot prove continuous absence against a malicious
same-UID peer that ignores `flock`; the production host must enforce a
dedicated service identity, exact parent ACLs/ownership and workload/mount
isolation. Finish, recovery, candidate installation and terminal closure must
next consume retained graphs. Native process-death/replacement campaigns,
syscall tracing, ext4/XFS power loss, DSSE/WORM, Cloudflare lifecycle and
G1-G8 approval remain blockers. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-25 K7 Finish and Recovery Retained Graph Gate

The Linux finish and startup-recovery transactions now retain operation
directory capabilities instead of returning to path lookup after acquiring
the authorization lock. Ordinary finish, unresolved-operation finish and the
candidate-bound accepted finish all verify and append beneath the same
operation dirfd while the retained terminal graph is checked around the
decision.

Candidate finish is stricter than ordinary first-terminal-wins replay. It
requires the candidate's start-receipt SHA-256 to equal the retained
operation start and requires the full canonical finish receipt to equal the
candidate input. A different terminal receipt cannot satisfy the gate merely
because both outcomes are `Accepted`.

Unfinished recovery captures the complete sorted operation graph, including
one retained dirfd per verified chain. It completes every ordinary unfinished
operation as ambiguous and only the exact candidate operation as accepted.
It then verifies the same retained objects, rescans the authorization
descriptor for the identical operation-ID set, and rereads the retained
candidate before returning its audit.

Commit `33bbda404a01ae2b2e068237f891a44a1a3b8a68` passed
[run 30148796402](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402)
and
[job 89655504013](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402/job/89655504013)
with formatting, 140 Linux library tests and warning-free Clippy. The local
aggregate gate passed 126 Rust library tests, 3 binary/CLI tests and 61 Bun
tests with 242 expectations. Clean source evidence is Git tree
`34947264d0812d4faefd1d7006bf577463bcaefd`, source-archive SHA-256
`5741487d63c7e710d0469dc3d8a8741c9c7c5521cb7d97eb08e625f30d290aea`
and module-inventory SHA-256
`637906e8da2927e55467134368f584b6ffb500dce553efb650086f9bea2d7b5a`
for 31 modules and 1591919 bytes.

[Run 30148493686](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148493686)
is archived as the intermediate gate. Its Linux filesystem tests passed, but
Clippy correctly rejected path fallbacks that had become Linux-production
dead code. The frozen candidate platform-gates those fallbacks without lint
suppression.

The next P0 implementation gate is terminal publication and closure:
candidate creation, head-set/local-seal publication, terminal-closure
recovery and closure verification must consume one retained root-to-leaf
graph. Dedicated UID/GID, exact ACL and parent ownership, mount isolation,
native multiprocess/process-death campaigns, syscall traces, ext4/XFS
power-loss, backup/restore, independent DSSE/WORM, Cloudflare lifecycle and
G1-G8 approval remain mandatory. Go/VPS remains traffic, scheduler and
financial authority; production remains **NO-GO**.

## 2026-07-25 K7 Terminal Publication and Recovery Descriptor Gate

The terminal publication transaction now consumes the retained graph required
by the preceding gate. Candidate creation, execution receipt installation,
operation head-set publication, operation-directory freeze, local-seal
publication, recovery and final verification no longer return to path-based
Linux production helpers.

The authorization snapshot records its directory version, every verified
operation with an open dirfd, marker-only directories, capacity reservations
and an optional installed head set. Authorized publication and chmod
operations refresh only the versions they intentionally change. Every
cross-directory step revalidates both the terminal graph and authorization
snapshot before the next artifact is published.

Startup recovery is exact and local. It reads the candidate, execution chain,
head set and local seal from retained descriptors. A candidate replays its
deterministic terminal plan; a sealed execution chain without a local seal
continues closure; an unsealed or empty chain returns no closure only when no
head set or local seal contradicts that state. No recovery branch mints send
authority or performs network I/O.

Linux tests cover closure replacement after candidate capture, execution
replacement during terminal append, operation replacement after state
capture, closure replacement after candidate read, and a process crash after
head-set publication but before local-seal publication. The crash case
recovers the same closure twice, proving idempotent replay.

Commit `3cbddd719c1354ea7765d24089837120fdf6ca04` passed
[run 30154588102](https://github.com/cinagroup/cinatoken-rust/actions/runs/30154588102)
and
[job 89670450774](https://github.com/cinagroup/cinatoken-rust/actions/runs/30154588102/job/89670450774)
with formatting, 145 Linux library tests and warning-free Clippy. The local
aggregate gate passed 126 Rust library tests, 3 binary/CLI tests and 61 Bun
tests with 242 expectations. Clean source evidence is Git tree
`c673790199bba2f1090654a4cfbc64b42c977934`, source-archive SHA-256
`08bd3fb6857222853381a72be72c2d2604f85638e3d22de9c92b524098b758d9`
and module-inventory SHA-256
`a2d6a538fca14072171642185e926db35a1b24837cbda526ec80abda37c0b140`
for 31 modules and 1637476 bytes.

This gate closes the current single-process official-writer descriptor unit,
not the production migration. Next acceptance work is native multi-process
rename/kill and syscall-trace evidence, exact UID/GID/ACL and mount controls,
ext4/XFS power-loss and restore campaigns, independent DSSE/WORM closure,
then isolated Cloudflare DO/Container lifecycle tests and G1-G8 review.
Go/VPS remains traffic, scheduler and financial authority; production remains
**NO-GO**.

## 2026-07-25 K7 Native Process-Death and Syscall Gate

This P0 increment converts the first part of the remaining native-fault
requirement into an executable Linux gate.

Completed evidence:

1. an independent process replaces the authorization closure pathname after
   the parent captures the terminal candidate graph; publication fails closed
   and neither old nor replacement closure receives the candidate;
2. a child publishes and syncs the head set while retaining the authorization
   lock, is terminated by `SIGKILL`, and a fresh store recovers one exact
   local seal twice;
3. an unfinished closure attempt is now read-only until operation-state
   validation succeeds, so it creates no empty terminal graph and cannot
   strand a concurrent finish at `PredecessorMissing`; and
4. focused recovery tracing rejects every post-lock `AT_FDCWD` mutation and
   requires two exclusive locks, dirfd-confined `openat2`/`renameat2`,
   descriptor chmod and directory sync.

Acceptance evidence is frozen at
`467fba330164841142c0cdd7c11658acd5605674`.
[Run 30157298245](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245)
and
[job 89677148809](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245/job/89677148809)
passed formatting, 147 Linux library tests, the trace step and warning-free
Clippy. The aggregate local gate passed 126 Rust library tests, 3 binary/CLI
tests and 61 Bun tests with 242 expectations.

Clean source evidence:

| Field | Value |
| --- | --- |
| Git tree | `215e80c3220756764afe9cd3ae0829a00a60a887` |
| Source archive | 35901440 bytes |
| Source archive SHA-256 | `54bd395057dfedb4089ba344ad0835215ca717af75d7a440b6a35598363d1e90` |
| Required modules | 31 |
| Required module bytes | 1649358 |
| Module inventory SHA-256 | `ae61249e39efe9cb70ac855302837995d0ea59a0b22d388250f4157e49175b9f` |

Two intermediate runs remain part of the audit trail. Run `30156048897`
exposed the terminal-graph ordering race rather than being retried away. Run
`30157120814` passed all code and trace assertions but failed to remove the
intentionally read-only temporary fixture. The final workflow restores owner
write permission after tracing, then removes only that isolated fixture.

Still required before any production promotion:

1. broaden process campaigns across reserve, finish, candidate installation,
   closure publication and every declared crash boundary;
2. prove dedicated UID/GID, exact parent ownership/POSIX ACLs and mount
   isolation on the production image;
3. run ext4 and XFS abrupt-power-loss and durability-unknown quarantine
   matrices;
4. prove backup/restore and missing-local-tree quarantine against D1/DO
   operation state;
5. independently sign and deletion-protect the trace, receipt and source
   evidence; and
6. complete isolated Cloudflare DO/Container lifecycle tests and G1-G8 review.

The current inline trace parser is useful CI evidence but is not an
independently signed/WORM artifact. No credentials or remote mutations were
used, and no traffic or financial authority moved. Go/VPS remains traffic,
scheduler and financial authority; production remains **NO-GO**.

## 2026-07-25 K7 Full Terminal Transaction Syscall Gate

This K7 increment broadened native Linux tracing from a prepared recovery
fixture to one full happy-path terminal transaction. A dedicated child process
must reserve an exact claim-read operation, install its terminal candidate,
finish only that candidate-bound operation, install the complete terminal
closure and recover the same closure after reopening the store.

The production acceptance invariant is now:

1. after the first successful exclusive lock, neither trace may mutate through
   `AT_FDCWD`;
2. focused recovery must show at least two successful exclusive locks;
3. the full transaction must show at least five successful exclusive locks;
4. both must show retained-dirfd `openat2` and `renameat2`, descriptor chmod
   and directory sync; and
5. the full transaction must additionally show retained-dirfd `mkdirat`.

Local code and contract gates passed for
`11c938720875dee8da5d19481a3b39a03bda9c84`: 126 Rust library tests, 3
binary/CLI tests, 61 Bun tests with 242 expectations, formatting and strict
all-target Clippy. Clean source identity is Git tree
`82d824341ccf6188a4515c4ff2373c3793d7ee86`, archive SHA-256
`f4605c6af5c6924da2262d9531929cd65e4e0b979bb5fcd36b62afc59aad7672`
and module-inventory SHA-256
`2cc6f847b14da90f66ff0c3b4f82e72d8e60b0fc520ba6718841263e57dc24ab`
for 31 modules totaling 1652800 bytes.

The Ubuntu acceptance box remains open. Runs `30157797156` and `30158073337`
produced no jobs and reported GitHub internal-server errors during the
[official Actions outage](https://stspg.io/448g37mrq066). They are retained as
platform incident evidence and do not satisfy or fail the syscall acceptance
gate. A fresh green run of the exact frozen candidate is required.

The subsequent execution order is unchanged: finish native crash-boundary
coverage; attest UID/GID, ownership, ACL and mounts; execute ext4/XFS
power-loss and restore campaigns; externalize signed immutable evidence; then
run isolated Cloudflare DO/Container lifecycle, fault, load/cost/SLO and
rollback campaigns before G1-G8 review. No production authority moved.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 K7 Audited Syscall Evidence Gate

The production evidence parser is now part of the frozen runner source, not
only workflow text. The old selected-syscall/minimum-lock policy is superseded
by:

1. full `%file` tracing with descriptor paths from `strace -yy`;
2. fail-closed parsing of every emitted syscall line;
3. success-result checks for every violation and positive-evidence decision;
4. per-PID descriptor, dup, close and lock tracking;
5. fixture-root and two-lock enforcement for successful mutations;
6. exact receipts/authorization lock pairs: 4 for focused recovery and 10 for
   the full transaction; and
7. successful, object-bound dirfd/sync/chmod evidence.

The verifier and test are required by the Rust release manifest, JavaScript
release contract and clean source collector. A missing verifier or verifier
test fails source collection. Dependent deterministic release, publication and
activation hashes were regenerated and cross-runtime tests pass.

Acceptance evidence is frozen at
`938950b2f3057167d8cbf5749650681732006e0b`,
[run 30159686961](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961)
and
[job 89682866508](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961/job/89682866508).
All 147 Ubuntu library tests, both syscall traces, formatting and strict Clippy
passed. The local aggregate passed 126 library tests, 3 binary/CLI tests and 70
Bun tests with 258 expectations.

Clean source:

| Field | Value |
| --- | --- |
| Git tree | `ed6bcf39865d4cb5ee695cf3f9e53577daa26881` |
| Archive SHA-256 | `6a03ced213ccd8837890b2cd7eb5b0903fb416749b3461c6ecbafd3dcf0e6293` |
| Archive bytes | 35962880 |
| Inventory SHA-256 | `6fe6f610a4835faa860d56076009cb8a70cff80fa6036919c0968c1bbb2b3222` |
| Modules / bytes | 33 / 1678772 |

K7 execution now advances to the candidate-after-sync process-death boundary,
then the remaining reserve/finish/closure and concurrent-recovery matrix.
Production image ownership/ACL/mount evidence remains the next environmental
gate after that local state-machine matrix. No production authority moved;
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 K7 Candidate-Synced SIGKILL Acceptance Gate

K7 now covers a real process death after the terminal candidate is durably
published and independently read back, but before the corresponding accepted
finish is appended. The killed process retains both authorization locks until
the parent sends `SIGKILL` to its recorded tracee PID. Recovery is performed
by a separate process and fresh store.

The production acceptance invariant for this boundary is:

1. candidate publication is create-new and ordered
   `renameat2 -> closure fsync/fdatasync -> object-bound readback`;
2. the exact writer PID then exits only through `SIGKILL`, with status 137;
3. no operation finish, execution chain, head set or local seal exists at the
   death boundary;
4. fresh recovery installs only the candidate-bound accepted finish and
   reports zero ambiguous outcomes;
5. the resulting local seal binds the exact candidate SHA-256;
6. authorization audit reports no unfinished operation after recovery;
7. a second closure recovery changes no immutable file byte, inode, mode or
   count; and
8. startup completes this recovery before credential verification can
   construct the bounded HTTP core or restore send authority.

The exact syscall policies are now 4 locks for focused recovery, 10 for a full
terminal transaction, 4 for the killed candidate writer and 8 for fresh
candidate recovery, audit and immutable replay. Every successful mutation
after the first lock remains under the fixture root and both locks; legacy or
`AT_FDCWD` mutation fails the run.

Acceptance evidence is frozen at
`43b1536f0e1f075d27c249ca849f7e67a7655b89`,
[run 30162862290](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290)
and
[job 89690905464](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/job/89690905464).
Ubuntu passed 148 library tests, the four 4/10/4/8 syscall policies,
formatting and strict Clippy. The local aggregate passed 127 library tests, 3
binary/CLI tests and 72 Bun tests with 276 expectations.

The five machine-readable success summaries are retained in
[artifact 8620731294](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/artifacts/8620731294),
SHA-256
`8c68ec0966a7bfe5dda0408031b7bdb27befe01935ccb5aba33ba6481d87f2a2`.
Clean source evidence is:

| Field | Value |
| --- | --- |
| Git tree | `5a1c408426534d6a27ad7fa1d5b71edf0c2f3f5e` |
| Archive SHA-256 / bytes | `8c41a77cb0f366e02f6eb3a689669f31ea71654abdf4f53eb8913cc590f63923` / 36003840 |
| Inventory SHA-256 | `534170adf68de8e647bdd9b0382d00097f5b665df1b356aa6e2466c4d9427e7b` |
| Modules / bytes | 34 / 1719654 |

This advances K7 but does not authorize K7 completion or production
promotion. Concurrent receipt-store candidate recovery is accepted below;
real dual startup remains open. The ordered next units include
candidate-finish-before-plan, the remaining receipt-prefix crash sweep,
production UID/GID/ACL and mount attestation, ext4/XFS power-loss and restore,
externally signed WORM evidence, isolated Cloudflare DO/Container lifecycle
and then G1-G8. Go/VPS remains traffic, scheduler and financial authority;
production remains **NO-GO**.

## 2026-07-26 K7 Concurrent Receipt-Store Recovery Gate

The bounded concurrency gate launches two independent harness processes
against one candidate-after-sync fixture. Each validates the fixture before a
shared release gate. Their Rust test threads then recover concurrently and
must satisfy all of these acceptance conditions:

1. both return the same terminal closure identity;
2. unfinished counts are exactly `1:0` or `0:1`;
3. the store contains one accepted finish, exactly two operation receipts and
   one sealed execution graph;
4. candidate fixture file identity remains unchanged and post-seal audit is
   fail-closed;
5. strace observes two distinct lock TIDs, six locks each and twelve total;
6. process PID and lock TID are retained separately and the TIDs exactly match
   the strace lock identities; and
7. a read-only loser is allowed only when the two-trace union contains the
   complete retained-dirfd mutation and durability evidence.

Acceptance is frozen at
`aaa52936765ec47afdc2871ccab4fd2e6115ffbd`,
[run 30183935884](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884)
and
[job 89745204486](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/job/89745204486).
Ubuntu passed 148 library tests, exact 4/10/4/8 standalone traces, the 6+6
concurrent bundle, formatting, evidence upload and strict Clippy.

[Artifact 8626449986](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/artifacts/8626449986)
retains the configured raw and structured evidence for 30 days. GitHub reports
87879 bytes, digest
`sha256:a97bb267dd8e24d81f5bf16c3e7dd258107ebc251032cd1ee7f3132cb6b2a589`
and expiry `2026-08-25T02:05:23Z`. Candidate Git tree:
`fb8a9ae44621e0c04b57496393391e56762601ff`.

K7 is still not accepted for production. Before promotion, execute:

1. repeated Ubuntu stress/soak until the unexplained run `30183488782`
   full-suite failure is root-caused or a documented consecutive-green
   threshold is met;
2. two real `verify_loaded_credentials()` startup processes with zero
   `socket`/`connect` syscalls before sealed recovery completes;
3. bounded lock acquisition and fail-closed timeout/availability behavior;
4. candidate-finish-before-plan and the remaining receipt-prefix crash sweep;
5. production UID/GID/ACL/mount, ext4/XFS power-loss and restore campaigns;
6. external signed WORM evidence and isolated Cloudflare DO/Container
   lifecycle; and
7. the complete G1-G8 approval path.

The pinned upload action's Node 20 deprecation warning is also CI maintenance
debt. Go/VPS remains traffic, scheduler and financial authority; production
remains **NO-GO**.

## 2026-07-26 K7 Real Dual-Startup Network Observation Gate

The second K7 item above is now closed at an explicitly bounded observation
scope. Two environment-cleared child processes execute the real
`verify_loaded_credentials()` path concurrently against one
candidate-after-sync fixture. Unique successful create-new marker opens bound
each worker's evidence window from immediately before credential/startup
recovery through the local `ReceiptSealed` execution result. The startup
implementation now accepts a concurrent `AlreadySealed` audit/recovery result
only by recovering the already installed terminal closure and returns before
constructing an HTTP core.

The gate requires:

1. two distinct process PIDs and two distinct current-thread Tokio TIDs;
2. both marker windows complete in order on their declared TIDs;
3. both prepared control planes have no HTTP core and do not verify an access
   token;
4. both return the same terminal closure and local `ReceiptSealed` result;
5. zero successful or failed `%network` syscall attempts in both windows;
6. exactly three network-class calls outside the windows, all `socketpair`;
7. all other outside-window network names fail globally, including calls from
   a newly spawned background thread; and
8. a third real startup replay and direct `AlreadySealed` audit preserve the
   installed closure.

Acceptance packet:

| Evidence | Frozen value |
| --- | --- |
| Candidate | `eb90c27af35b56e169b64e676eba2bbb37d0fe15` |
| Git tree | `cf9a63b698c35b8addaa97c7d84bb69f46ebbfa1` |
| Ubuntu run/job | [30186091600](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600) / [89750973529](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/job/89750973529) |
| Linux library tests | 149 passed |
| Startup trace | 7252 parsed; 3880 window-scoped; 0 scoped network; 64 unscoped split lines; 3 unscoped `socketpair` |
| Summary artifact | [8627086351](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086351), 14803 bytes, `sha256:91720d03fd24d8daf49609671d84a238db8b1df0bf1a331b97c8ec6d01b30f5f`, expires `2026-08-25T03:24:49Z` |
| Successful raw traces | [8627086439](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086439), 123728 bytes, `sha256:d177ca95b21a796e3f686644f24af3563079377a7e34d938d0e7fff063bceb95`, expires `2026-08-25T03:24:49Z` |
| Local aggregate | 127 Rust library + 3 binary/CLI + 147 Bun; 608 expectations; format/YAML/Node/Clippy passed |

The three preceding failed campaigns remain part of the audit trail:

| Run | Rejected assumption | Corrective control |
| --- | --- | --- |
| [30184982382](https://github.com/cinagroup/cinatoken-rust/actions/runs/30184982382) | Whole test tree could be labeled zero-network | Separate harness/runtime identities from the business call |
| [30185436031](https://github.com/cinagroup/cinatoken-rust/actions/runs/30185436031) | All unfinished/resumed lines should be rejected | Reconcile exact TID/syscall pairs and disclose unscoped splits |
| [30185637997](https://github.com/cinagroup/cinatoken-rust/actions/runs/30185637997) | A worker TID alone identifies the business interval | Bind successful create-new start/finish windows around the real call |

This gate must not be interpreted as an egress sandbox. `%network` does not
prove absence of traffic through an inherited socket using ordinary
`read`/`write`, `sendfile` or `io_uring`. Production promotion still requires
runtime FD closure, network namespace/seccomp or equivalent isolation
evidence, repeated schedule soak, bounded `flock`, candidate-finish-before-
plan, the remaining receipt-prefix crash matrix, UID/GID/ACL/mount and
ext4/XFS power-loss/restore campaigns, external signed WORM evidence,
isolated Cloudflare lifecycle and all G1-G8 approvals.

The only accepted-run annotation is the pinned upload action's Node 20
deprecation warning while GitHub forces Node 24. Go/VPS remains traffic,
scheduler and financial authority; production remains **NO-GO**.

## 2026-07-26 K7 Bounded Receipt Authorization Lock Gate

The blocking-`flock` item carried by the preceding gate is now closed for the
official Linux writer. Promotion remains prohibited; this is one K7 sub-gate.

Implementation acceptance:

1. create one 5,000-millisecond monotonic deadline before acquiring the
   receipts-root lock and pass the same deadline to the authorization lock;
2. use only `LOCK_EX | LOCK_NB`, retry contention every 10 milliseconds with
   absolute `CLOCK_MONOTONIC` sleep, and preserve the deadline across `EINTR`;
3. classify only `EAGAIN`/`EWOULDBLOCK` as contention and return typed
   scope-bearing timeout/system errors for every other outcome;
4. release the root lock if authorization acquisition fails and create no
   receipt, execution or closure object before both locks and retained-path
   identity checks succeed;
5. verify exact lock flags, result, order, identity and unlocks from native
   traces; bind each contention retry to one required monotonic sleep; and
6. keep exact successful lock counts independent of nondeterministic attempt
   counts.

Frozen gate:

| Evidence | Result |
| --- | --- |
| Candidate / tree | `d96753c5fe90cc59d0ea539be346c27285fbdb69` / `a7a8c8aaa4ce97506432b21f84672c1af7636634` |
| Ubuntu run/job | [30187560531](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531) / [89754869675](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/job/89754869675) |
| Linux source gate | 154/154 library tests, formatting and strict all-target Clippy passed |
| Exact standalone successes | 4 recovery, 10 full transaction, 4 candidate writer, 8 candidate recovery |
| Receipt-store concurrency | 12 successes / 57 attempts / 45 contention retries / 45 absolute monotonic sleeps / 0 blocking |
| Real startup concurrency | 24 successes / 58 attempts / 34 contention retries / 34 absolute monotonic sleeps / 0 blocking |
| Startup isolation observation | 7008 parsed / 3456 scoped / 0 scoped network / 348 split lines reconciled |
| Summary artifact | [8627504413](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504413), 15924 bytes, `sha256:f6ed76b44a6232ec388ed4a3d1f7ff31974b23c018ace23af7f99697ace09583` |
| Raw traces | [8627504519](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504519), 120805 bytes, `sha256:2390b75f13b58f315b88b64e3f4096e95f203af82489d17d80c12df3da33b720` |
| Artifact expiry | `2026-08-25T04:19:18Z` |

Run
[30187320790](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187320790)
is retained as the Linux schedule that exposed the legal `AlreadySealed`
recovery loser. Run
[30187432173](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187432173)
passed all 154 library tests, then rejected an incomplete relative
50-millisecond test-harness sleep when the candidate writer was deliberately
killed. Only that writer trace omits `clock_nanosleep`; all retry-capable
recovery, concurrent and startup traces retain it, and any writer contention
still fails without its required absolute sleep evidence.

Next K7 execution units, in order:

1. add a real `verify_loaded_credentials()` process test whose peer holds the
   receipts lock past the shared deadline, with watchdog-bounded typed timeout,
   zero HTTP core and no mutation authority;
2. run repeated concurrent startup/recovery soak and retain schedule
   distribution rather than pinning retry counts;
3. attest dedicated UID/GID, ownership, ACL, mount and inherited-FD isolation
   in the production Container image;
4. complete ext4/XFS crash/power-loss and backup/restore campaigns; and
5. bind externally signed immutable receipt evidence before isolated
   Cloudflare lifecycle rehearsal and G1-G8.

No credential, remote API, provider, traffic, scheduler or financial mutation
was used for this gate. Go/VPS remains all production authority; production
remains **NO-GO**.

## 2026-07-26 K7 Real Startup Receipt-Lock Timeout Gate

The first remaining execution unit from the bounded-lock gate is complete.
Promotion remains prohibited; this gate proves only local cooperative timeout
propagation through the real startup path.

Execution acceptance:

1. install one terminal-candidate fixture and capture descendant filesystem
   identity, mode, link and byte state;
2. start an independent holder that locks the exact production receipts root
   and must stay alive through the timeout observation;
3. execute `verify_loaded_credentials()` in a separate process and
   current-thread Tokio runtime with an HTTP-construction fail-fast tripwire;
4. require only the typed 5,000-millisecond receipts-root timeout within the
   4,900-8,000-millisecond observation bound;
5. verify from `strace` that the marker window has at least one contention,
   zero successful locks, exactly one absolute monotonic sleep per contention,
   no blocking lock and no network syscall;
6. require zero HTTP exchange construction and an unchanged fixture snapshot
   before release; and
7. release the holder and prove a new real startup recovers `ReceiptSealed`
   without an HTTP core.

Frozen gate:

| Evidence | Result |
| --- | --- |
| Candidate / tree | `56acfce31dbe5e154dd5450d5112882aef4f5dbd` / `d4e6fe556049047745638c1d653b3d0edb50f426` |
| Ubuntu run/job | [30188739169](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169) / [89757895460](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/job/89757895460) |
| Source gate | Ubuntu 24.04.4, rustc/cargo 1.97.1, formatting, 156/156 library tests and strict all-target Clippy passed |
| Timeout result | typed `operation_receipts_lock` / 5,000ms; 5,002ms observed; 15,000ms workflow watchdog |
| Lock evidence | 491 scoped attempts / 0 success / 491 contention / 491 absolute monotonic sleeps / 0 interrupted / 0 blocking |
| Authority evidence | 0 scoped network syscalls, 0 HTTP exchange construction, unchanged metadata-and-byte snapshot, safe post-release `ReceiptSealed` recovery |
| Summary artifact | [8627833392](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833392), 18671 bytes, `sha256:370e16a6f46c4a0156ca7288e6a4280a4a9b72550a61086ae8ebc2f447c0288a`, expires `2026-08-25T05:04:15Z` |
| Raw traces | [8627833482](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833482), 150104 bytes, `sha256:337a52b48e2e1be92b674f05120a128831d34f41da0008bf65a1c7f1a88ddfb1`, expires `2026-08-25T05:04:16Z` |

Run
[30188633076](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188633076)
retains the same successful runtime/trace evidence but failed the final Linux
lint step on a redundant import and tuple complexity; the accepted candidate
fixes only those findings.

Repeated startup/recovery schedule soak is closed by the execution gate below.
Next K7 execution units are production Container
UID/GID/ownership/ACL/mount/inherited-FD attestation, ext4/XFS power-loss and
restore, external signed immutable anchoring, then isolated Cloudflare
lifecycle rehearsal. This gate is not namespace/seccomp, remote lifecycle or
production deployment evidence. No credential or remote authority was used.
Go/VPS remains all production authority and production remains **NO-GO**.

## K7 OCI Supply-Chain Execution Packet (2026-07-26)

The first executable OCI packet is accepted for the reproduction-only
boundary:

| Evidence | Result |
| --- | --- |
| Candidate / tree | `383f53f5559674a9947b1939993ef2d9bdf0dd6a` / `3ced752e73b6e82faaa29ceff85dc1bad3e012cf` |
| Ubuntu run/job | [30196543635](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635) / [89778965995](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/job/89778965995) |
| Builder contract | Two separate BuildKit `v0.31.2` daemons from one pinned image digest; Buildx `v0.35.0`; Docker Engine `28.0.4` |
| Archive equality | A/B 10,378,752 bytes; exact `sha256:bdd67bd4335a922081e35fe344fb481599730ec37a3833d17fea85407852fb7e` |
| OCI graph | index `258828d4...`; manifest `84ff0214...`; config `7b1326fd...`; 19 exact compressed layers and diffIDs |
| Runtime join | final-layer binary `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` |
| Retained packet | [artifact 8630296572](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/artifacts/8630296572), 20,767,686 bytes, `sha256:8ccbf80f44f8d134579b89f4cde8806d7f1460ee33524b27244ee5c8ed4d8014`, expires `2026-08-25T09:31:03Z` |

### Mandatory continuation order

1. **R2: independent-runner reproduction.** Re-run the same contract on a
   successor candidate and compare archive plus portable OCI graph. A mismatch
   blocks release; host-local logs are diagnostic only.
2. **S1: SBOM.** Use a version- and digest-pinned generator against the frozen
   OCI subject. Hash canonical output, inventory packages/licenses, and bind it
   to the platform manifest without changing that subject.
3. **S2: vulnerability decision.** Scan the same subject with pinned database
   identity and retention metadata. Critical/high counts remain unknown until
   the scan exists and may never be inferred as zero.
4. **S3: provenance/signature.** Produce DSSE/SLSA-style source/build
   provenance, verify the subject digest and signer policy, record transparency
   inclusion, and copy evidence to approved immutable/WORM retention.
5. **R3: registry publication/readback.** Push only by digest, read back index
   and platform manifest identities, reject tag-only evidence, and decide the
   canonical P5 `containerImageDigest`.
6. **C1: isolated Cloudflare staging.** Deploy the read-back digest with all
   traffic and financial action gates false; join Controller, DO, Container
   class, shard generation, runtime build, policy and cold-start observations.

No step may synthesize missing SBOM/provenance hashes or convert unknown
vulnerability counts to zero. The current packet keeps signature, registry,
Cloudflare, P5, traffic and cutover authorization false. Go/VPS remains the
only production authority and production remains **NO-GO**.

### R2 successor result

Step R2 has now passed for one independent hosted successor. Candidate
`61be8211f599a48b14e9419a1ce04e26d5128360` ran on a fresh worker in
[run 30197404664](https://github.com/cinagroup/cinatoken-rust/actions/runs/30197404664)
and reproduced the exact archive SHA-256, OCI index, platform manifest, config,
19 compressed layers, 19 diffIDs and runtime build. The successor diagnostic
packet is
[artifact 8630552244](https://github.com/cinagroup/cinatoken-rust/actions/runs/30197404664/artifacts/8630552244),
20,767,686 bytes,
`sha256:36439496d6b6a1b61821a9ac0b3205b1a4dcc19bd13fcfdbef12f5b47cf14089`,
expiring `2026-08-25T09:59:47Z`.

R2 completion advances execution to S1/S2. It does not skip SBOM, scan,
provenance/signature, registry readback or Cloudflare staging.

### S1 deterministic SBOM result

Step S1 has passed for one frozen hosted-job subject. Candidate
`53c7e1802dd7461f58bd9755a30dfcf3e5201a20` passed
[run 30200272629](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629)
and
[job 89788901459](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629/job/89788901459).
The digest-pinned Syft 1.49.0 generator ran twice with no network, nonroot
identity, read-only root, dropped capabilities, bounded resources, exact
read-only archive input, and exact output-file binding.

Both archives generated the same 973,539-byte `syft-json` document at
`sha256:0b28e8fb597b6294605a68977f33968b294cebbad79bdac9986e062ff432ec60`.
The verifier accepted 10 packages and 1,293 relationships and rebound the
catalog to manifest `sha256:84ff0214...`, config `sha256:7b1326fd...`, all 19
compressed layer descriptors, all 19 uncompressed diffIDs, and runtime build
`1ec31f...`.

The retained packet is
[artifact 8631431136](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629/artifacts/8631431136),
22,725,635 bytes,
`sha256:a189a1f5aaa4ba6d38042fc03fe5472c19b80b4fa9fbeab12c440f6084bfb3a2`,
expiring `2026-08-25T11:32:53Z`.

The independent successor is also accepted. Candidate
`24a7252641bb7906b9a9091a39b624b18cedcbf9` passed
[run 30200802649](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200802649)
and reproduced the exact OCI and SBOM portable identities on a fresh worker.
Its
[artifact 8631590135](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200802649/artifacts/8631590135)
is 22,725,602 bytes,
`sha256:66d3786ffe01cf3cbe38cf4bdba8ea77f173cfe4ad870d9db5402e9b2a5c9b6f`,
expiring `2026-08-25T11:49:32Z`.

S1 is intentionally scoped to local SBOM reproducibility. S2 must pin both the
scanner and the complete vulnerability database identity, retain the database
acquisition/source metadata, scan this exact subject, distinguish unapproved
from policy-approved findings, and leave unavailable counts null. No SBOM
result may itself assert zero vulnerabilities, provenance, signature
validity, registry identity, Cloudflare deployment, P5 eligibility, or traffic
authority.

### S2 vulnerability decision result

The S2 mechanism is complete and fail-closed; the current release subject is
not promotable. Candidate `93dca768deca3f09a3085772e8ba3dff1781c1e9`
completed
[run 30204421553](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553)
and
[job 89799900370](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553/job/89799900370).
OCI and S1 checks passed first. S2 then emitted its full report and failed the
job because the blocked count was nonzero.

The verifier binds digest-pinned Grype 0.116.0 and its exact linux/amd64
manifest to the exact S1 SBOM, a retained `v6.1.9` source listing/archive, two
independent DB imports/status reports/files, two read-only and network-disabled
scans, the checked-in policy, and the empty approval set. The imported DB is
1,957,412,864 bytes at
`sha256:55279915a94b36f1307f5104a66d2e6980f52f34a9c67f09c4413a46d7db9253`.
Both scans are exact, expose suppressed matches, and contain no ignored match.

The result is 17 unique findings: 12 Negligible, 2 Medium, 2 High, and
1 Critical. The three unapproved blockers all affect Debian 12 `libc6`
`2.36-9+deb12u14`: `CVE-2026-5450` (Critical), `CVE-2026-5435` (High), and
`CVE-2026-5928` (High). Policy blocks Unknown/Critical/High, forbids
Unknown/Critical approval, and currently contains zero exact High approvals.
No exception is authorized.

The retained packet is
[artifact 8632661369](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553/artifacts/8632661369),
160,649,108 bytes,
`sha256:7b3abc803ba0af46da58bc78d3cfdd9d0bf88d7d1969fa61b85469772cbc2b91`,
expiring `2026-08-25T13:41:35Z`.

Promotion remains stopped between S2 and S3. Replace the glibc runtime with a
digest-pinned static-musl image, rebuild the OCI subject, regenerate S1, and
repeat S2 until the blocked count is zero. Provenance/signature, registry
publication/readback, Cloudflare deployment, P5, remote mutation, traffic, and
cutover stay false. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-26 K7 Reproducible Container Image Gate

The release path now rejects an image whose executable behavior is stable but
whose image identity drifts. This gate is downstream of source tests and
upstream of registry publication or Cloudflare deployment.

### Mandatory build controls

| Control | Required state |
| --- | --- |
| Source | One frozen checkout and lockfile; no credential-bearing build input |
| Builder/runtime bases | Exact digest-pinned Rust 1.78 builder and distroless runtime |
| Build isolation | Two sequential `linux/amd64 --no-cache` Buildx builds |
| Time | `SOURCE_DATE_EPOCH=0`; image exporter `rewrite-timestamp=true` |
| Rust | `CARGO_INCREMENTAL=0`; one release package and locked dependencies |
| Runtime root | Builder installs mode-0755 binary, normalizes every root-tree mtime, and final stage copies it as root-owned |
| Equality | Valid equal image IDs, complete configs, ordered non-empty RootFS layers, and copied binary SHA-256 values |
| Runtime | Live readiness build ID equals copied binary hash; isolation and restart policy remain stable |
| Evidence | Both image inspections, both binary hashes, attestation JSON, and stderr retained for 30 days |

### Accepted packet

| Field | Value |
| --- | --- |
| Candidate / tree | `cbe749907931435e280686c9b8c935b08fdd085f` / `0a21ce473d857fbcfc2adc60a5e7362bd7784bff` |
| Run / job | [30194108625](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625) / [89772437472](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/job/89772437472) |
| Image | `sha256:6a2f92415570e2b13e033b8c0d3d1acaadccf2bfa60ebd8d63faa359b687c514`; 19 exact layers across two builds |
| Binary/build | `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` for both copied binaries and live runtime |
| Policy | `sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`; primary, restart, embedded, and independent recomputation equal |
| Artifact | [8629556865](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/artifacts/8629556865), 7822 bytes, `sha256:1bfac70cb2dd38418da1115ef5b6a15a67b46bb893fd00076a1cc5e8fe2b8ffe`, expires `2026-08-25T08:10:57Z` |

### Promotion sequence

1. **Complete:** docs-only successor
   `d407e44285a71d7d3fab50db0107eeca877450db` passed
   [run 30194409010](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010)
   with the same image, 19 layers, binary, policy, and attestation identity.
   Artifact
   [8629649636](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010/artifacts/8629649636)
   is 7828 bytes with
   `sha256:ccef6562a6fa8d2774ef196a152c55506472e6c264bffe53c8aab1443c0d7648`.
2. Pin the release builder/export compatibility and produce two independently
   retained registry-bound OCI packets; compare manifest/index and compressed
   layer digests, not only Docker image ID and uncompressed RootFS identity.
3. Generate and policy-check an SBOM and vulnerability report, then bind
   source, lockfile, builder, OCI digest, SBOM, and test evidence in signed
   provenance with independent transparency/WORM retention.
4. Publish by digest to the approved registry and require authenticated
   readback before isolated Cloudflare staging installation.
5. Join the deployed digest to Controller/edge version, Container class, DO
   binding, shard/ring generation, runtime build/policy, lifecycle and fault
   evidence before canary review.

Failure at any step quarantines the candidate; no mutable tag may substitute
for digest identity. This gate still does not attest registry bytes,
independent builders, signatures, Cloudflare deployment, or production
lifecycle. No remote action or authority change occurred. Go/VPS remains
authoritative and production remains **NO-GO**.

Portable equality excludes Docker `GraphDriver` storage paths and
`Metadata.LastTagTime`; those differed across the two hosted jobs while image
ID, Config, and RootFS layer identities remained exact. Release tooling must
continue comparing defined OCI identities rather than serializing host-local
Docker inspection state.

## 2026-07-26 K7 Container Runtime Isolation Gate

The first production-image isolation gate is now implemented and accepted for
the local Ubuntu/Docker boundary. The gate builds the digest-pinned
linux/amd64 image, starts it on an internal network without host ports, probes
the real HTTP contract, runs a read-only PID 1 attestation subcommand, performs
graceful shutdown, starts a second instance from the same image, and requires
the normalized policy hash to remain identical.

### Mandatory local controls

| Control | Enforced state |
| --- | --- |
| Image supply chain | Two exact digest-pinned bases; fixed root-owned 0755 binary, `/` workdir, nonroot entrypoint |
| Container privilege | Nonprivileged, read-only rootfs, `cap-drop=ALL`, NNP, 256 MiB, 128 PIDs |
| PID 1 identity | UID/GID 65532, PPID 0, no tracer, fixed executable and cwd |
| Kernel controls | All five capability masks zero; seccomp mode 2 with at least one filter |
| Writable state | Private `/tmp` only for application data: 16 MiB, 0700, uid/gid 65532, nodev/noexec/nosuid |
| Application layout | `/usr`, `/usr/local`, `/usr/local/bin`, and binary are root-owned 0755 with no POSIX ACL override |
| Mount denial | No caller bind, volume, device, writable `/usr`, `/opt`, `/app`, or unexpected writable mount |
| FD denial | 4-64 descriptors; fixed standard streams; bounded socket/event-loop classes; no unexpected path-backed target |
| Network | Internal Docker network, in-network probe, no host port publication |
| Restart identity | Same runtime build ID and normalized policy SHA-256 |

### Accepted packet

| Field | Value |
| --- | --- |
| Candidate / tree | `304a8c1569db9c479430ef003379cc55d688ce54` / `66e7ecdbad0430ba38ef120be1957d202afbb170` |
| Run / job | [30192249580](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580) / [89767475624](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/job/89767475624) |
| Environment | Ubuntu 24.04.4; runner image `20260720.247.2`; read-only workflow token |
| Image | `sha256:85b333c3804a82031359929ea422baf98f35aed15e3062bff95ba0744f86f9e6`; 19 rootfs layers |
| Build identity | `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` |
| Policy identity | `sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`; primary, restart, embedded, and independent recomputation all equal |
| FD observations | Primary 12; restart 10; policy stable and both within bound |
| Artifact | [8628969468](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/artifacts/8628969468), 2761 bytes, `sha256:c9d7d549c39e6879cf1cb29f7ea1982f93f4c39a537d5381037935c30686964a`, expires `2026-08-25T07:08:57Z` |
| JSON | 7901 bytes, `sha256:29d05f1d142423140d4f479e2817d59020ebdab804c8099a5356cb1467412977`; empty stderr log has standard empty-file SHA-256 |

Three retained negative packets document fail-closed calibration:

| Run | Rejected assumption | Artifact |
| --- | --- | --- |
| [30191008408](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191008408) | Docker inspect had to repeat HostConfig tmpfs as exactly one `Mounts` entry | [8628562669](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191008408/artifacts/8628562669), 442 bytes, `sha256:82576ff8a2676d8cab07301486646120759ec0844ca3b351f08e34f1e01d9e79` |
| [30191475197](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191475197) | Runtime workdir could be inherited from the base image | [8628703302](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191475197/artifacts/8628703302), 438 bytes, `sha256:5c73a0237bf99ca5d3d7bcfba3424d364a7b794741ae1964ffb520f0b31cbc07` |
| [30191703953](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191703953) | `--chown=nonroot` could own the immutable `/usr/local` layout | [8628772816](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191703953/artifacts/8628772816), 435 bytes, `sha256:11bd960cf69716ed75b6b1838b23f679612f2c2362bae25747877d02aa54f3ec` |

The corrections preserve the core controls: Docker inspect may omit its
redundant tmpfs entry, while HostConfig and PID 1 mountinfo must still agree;
the image now pins `/`; and immutable application files are root-owned while
the process remains nonroot.

### Next execution order

1. Publish the digest-bound image to the approved registry with signed
   provenance and independently retained SBOM/vulnerability evidence.
2. Deploy only to an isolated Cloudflare staging Container class with every
   traffic, paid execution, financial, and cutover gate false.
3. Read back image/version/class, Controller/DO binding, runtime policy,
   namespace/cgroup/lifecycle observations, and join them to the candidate,
   build, policy, shard generation, and deployment identities.
4. Exercise restart, eviction, network loss, mixed version, bounded load,
   cost/SLO/alerts, and D1/DO/R2 recovery while proving at-most-once provider
   execution and exactly-once financial finalization.
5. Complete ext4/XFS power-loss, backup/restore, external signed/WORM evidence,
   credential revocation, G1-G8 approval, and rollback rehearsal before any
   canary authorization.

This packet is not Cloudflare-host attestation and not a release authorization.
No credential, remote mutation, provider request, customer traffic change, or
Go/VPS drain occurred. Go/VPS remains authoritative and production remains
**NO-GO**.

### K7 repeated startup schedule soak

The local repeated-schedule gate is now accepted with this immutable boundary:

| Evidence | Result |
| --- | --- |
| Candidate / tree | `01c04940c77610a0d98a3feb61fa235724838d58` / `2f2ecc7d93da479d8ebf19e39f880da965c50af7` |
| Ubuntu run/job | [30189628276](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276) / [89760384170](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/job/89760384170) |
| Source gate | Ubuntu 24.04.4, rustc/cargo 1.97.1, formatting, 156/156 library tests, all syscall policies and strict all-target Clippy passed |
| Campaign | 32 required / 32 observed exact dual-process startup tests; all per-iteration PID/TID pairs unequal; all actions `ReceiptSealed` |
| Bounds | 15,000ms per iteration and 120,000ms per campaign; observed 173-177ms per iteration and 6,133ms for the campaign |
| Closure admission | successful exact Rust test must prove equal child closure plus safe replay/recovery; 7 cross-fixture closures were observed but are not a threshold |
| Records | 32-sample NDJSON and embedded boundary samples, `sha256:c72f8ad9a5b80ec88af002883bc33c0d1673c31532184f931fb04639a9bdc1d4` |
| Trace policy | `single-captured-sample-plus-process-soak-v1`; one separate successful startup trace, `sha256:63ce773e5ba81b128373135ad4f3a1f8341c9d81308bb2bd9401f35e33a3b462` |
| Summary artifact | [8628118657](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118657), 24 files, 28940 bytes, `sha256:b83cb16e39540e6dc25ec34c5f6ea4562bddcf2faca8f4f9d2054c0ce4e710e0`, expires `2026-08-25T05:36:45Z` |
| Raw traces | [8628118769](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118769), 8 files, 149155 bytes, `sha256:16d0a7c08df3b6d62e5776790632d51d8c429a0dcbe06af390982390da624e7e`, expires `2026-08-25T05:36:46Z` |

Run
[30189502740](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189502740)
is negative calibration evidence: every schedule sample passed, but the first
aggregate incorrectly required independent fixtures to have one global
closure. The corrected gate keeps equality strict inside each participant
pair and treats cross-fixture closure count as observation only.

The next executable K7 units are production Container
UID/GID/ownership/ACL/mount/inherited-FD attestation, ext4/XFS power-loss and
restore, external signed immutable anchoring and isolated Cloudflare lifecycle
rehearsal. The accepted soak is not remote replacement, long-duration load or
production deployment evidence. No credential or remote authority was used.
Go/VPS remains all production authority and production remains **NO-GO**.

## 2026-07-27 Static-musl S2 Promotion Checkpoint

The S2 remediation loop is closed for candidate
`162cad5b9515309b40addcde52fcb66fc753d3b3`.
[Run 30229751845](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845),
[job 89866237796](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845/job/89866237796),
and
[artifact 8639704084](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845/artifacts/8639704084)
bind one exact static-musl OCI subject to a byte-identical 665,849-byte SBOM,
two byte-identical frozen DB extractions, two byte-identical Grype scans, and a
zero-blocker policy result.

| Checkpoint | Accepted result |
| --- | --- |
| R2 subject | Archive `7089fef2...`; index `ad706ef6...`; manifest `21a453f4...`; config `6feab213...`; runtime `01fa7759...` |
| S1 | 4 packages; 665,849 bytes; `sha256:76aa5ae7bc8f849f0bd5af8dd3bb257be191a0e37639f28e858748bc9064ab9c` |
| S2 DB | Archive `766bec0e...`; A/B raw DB 1,475,883,008 bytes at `5e1fd554...`; xxh64 `d8a8cef5bc65efe7`; deterministic metadata `303e1b7f...` |
| S2 decision | 0 matches, 0 ignored, 0 Unknown/Critical/High; exact A/B scan `62c9c6e...`; zero approvals |
| Retention | 144,729,887-byte GitHub packet, `sha256:29a2f64564298f6b1ed77f6b920be8fcd3d3a93fd882edd80db558884e54d05b`, 30-day expiry |

### Database evidence lanes

1. **Candidate refresh:** fetch `latest.json` in a credential-free scheduled or
   manual job, verify transport and schema, download the proposed archive,
   derive archive/raw-DB/import identities, run the exact current subject, and
   emit a reviewable candidate packet. Do not commit, push, deploy, or alter the
   active policy automatically.
2. **Candidate adoption:** a human-reviewed commit freezes the complete listing,
   archive, DB, import metadata, scanner, policy, and approval identities. The
   release run must observe the database within 48 hours of `built`.
3. **Historical replay:** select a previously frozen contract and retained
   archive by digest, re-run immutable extraction and policy checks, and report
   historical validity separately. Freshness must not be reinterpreted as a
   current release claim.

The next promotion boundary is S3: generate subject-bound provenance, verify
signature/signer policy and transparency inclusion, and retain the packet in
approved immutable storage. Only then may registry publication/readback and
isolated Cloudflare staging begin. All registry, Cloudflare, P5, production,
traffic, billing, and Go/VPS shutdown authorities remain false. Production
remains **NO-GO**.
