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
| J4 publication receipt | Bind final policy, packet, executable and activated generation after signing | Contract planned only | Create-new signed/approved receipt plus independently read back installed digests | Missing/overwritten receipt, digest drift, ambiguous activation |
| K execution join | Read fixed credential handles only after J0-J4; sole POST consumes typed fresh permit | Rust release and pure capability cores are separate and fail closed | Bounded Authority/read/deploy clients, stable reads, execution receipt and crash campaign | Credential before release, generic/retry send, restored permit or duplicate POST |

Required release-campaign order:

1. freeze one clean commit and review the 18-path module inventory;
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
