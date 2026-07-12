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
  HMAC-SHA256 authority binds body, path, method, channel, request ID, and
  worker using a per-worker key derived from platform-only
  `WFP_RELAY_AUTHORITY_SECRET`. The uploader binds only
  `WFP_RELAY_AUTHORITY_KEY` into that tenant; the platform master must never
  enter the tenant binding set. The tenant now atomically consumes the signed
  request ID through the platform-owned `WfpAuthorityReplay` DO before egress;
  duplicate/invalid/unavailable checks fail closed. Keep
  `WFP_RELAY_TRANSPORT_ENABLED=false` until staging proves the complete path,
  external binding identity, and sequential/concurrent replay behavior.

## Best-Practice Anchors

Cloudflare references were refreshed on 2026-07-11:

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

## Production Gates

| Gate | Name | Opens When | Required Evidence | Blocks |
| --- | --- | --- | --- | --- |
| G0 | Scope and inventory freeze | Go source, DB, routes, providers, env, and secrets are inventoried | Route matrix, table matrix, provider matrix, secret inventory without values | Any production deployment planning |
| G1 | Cloudflare staging foundation | Staging Worker has authenticated, verified D1/KV/R2/Queue/Upstash/provider bindings | Rotated credential evidence, `wrangler deploy --env staging`, remote migrations 0001-0020, `/api/status`, generated binding types, logs visible | Live smoke and canary |
| G2 | Data dry run | D1 migrations cover production-critical tables and are applied to remote staging | Source counts/hashes, staging import report, verification report, rollback export; local 20/20 and 26-table replay are prerequisites only | Any data cutover |
| G3 | Relay parity | P0 relay routes are implemented and live-smoked | G3 report from `docs/route-provider-parity-runbook.md`, non-stream smoke, SSE smoke, error mapping smoke, upstream ID capture | Any customer relay canary |
| G4 | Billing parity | Billing expression and quota deltas match Go for production-shaped inputs | Golden fixtures, shadow settlement reports, delta threshold report | Paid traffic ownership |
| G5 | Admin/frontend parity | Admin can operate staging without direct DB edits | G5 report from `docs/admin-frontend-parity-runbook.md`, login/current-user/logout, token/channel/user/log/settings smoke, cache invalidation, admin audit, frontend build/deploy evidence | Operator cutover |
| G6 | Observability and security | SLO dashboards, alerts, WAF/rate limits, secret policy, and runbooks exist | G6 report from `docs/observability-slo-security-runbook.md`, logs/traces, alert drill, redaction smoke, incident template | Canary above internal traffic |
| G7 | Canary | Rust Worker handles selected safe traffic with Go rollback ready | 1%/5%/25% reports, no unexplained billing deltas, rollback rehearsal | Full cutover |
| G8 | Cutover | All P0 gates pass and freeze window is approved | Final checklist, backup/export, DNS/route plan, owner approval | Retiring Go/VPS |
| G9 | Post-cutover hardening | Rust is primary and stable for the agreed window | Post-cutover audit, cost report, cleanup plan | VPS decommission |

## Workstream Status

| Workstream | Current Status | Production Target | Next Evidence |
| --- | --- | --- | --- |
| Platform/IaC | Partial: local D1 config audit passes; staging IDs remain unauthenticated/unverified | Reproducible staging/prod Cloudflare config with real bindings and generated types | Revoke/rotate leaked token, authenticate replacement credential, verify account/resources, then `wrangler deploy --env staging` plus typed bindings |
| Data migration | Partial: local 20/20 Wrangler apply and 26-table SQLite replay pass | Reversible source export, D1 import, row/hash verification, and rollback bundle | Authenticated remote 20/20 staging apply, real source inventory, staging import report, and rollback point |
| Relay/API parity | Partial | P0/P1 routes implemented with correct body mode, streaming behavior, errors, and live smoke | Route matrix and provider smoke log |
| Billing/quota | Partial | Go-compatible pricing, pre-consume, settlement, refunds, subscriptions, and shadow mode | Golden fixture set and shadow delta report |
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
| `POST /v1/embeddings` | JSON implemented | Live upstream smoke, batch size policy | G3/G4 |
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
   validate the main shim, Wasm magic/import graph, and module hashes; require a
   tenant runtime token distinct from the deploy token; derive the named
   worker's key from `WFP_RELAY_AUTHORITY_SECRET`; bind only
   `WFP_RELAY_AUTHORITY_KEY` into the tenant; bind the environment-specific
   platform `WfpAuthorityReplay` namespace using
   `--authority-replay-script`; and archive real PUT plus GET content, hash,
   class, and script readback evidence. The platform master must remain
   platform-side.
   Admin dispatch may prove tenant status only. For paid smoke, seed
   `channels.other_info.wfp_worker`, temporarily arm
   `WFP_RELAY_TRANSPORT_ENABLED`, and call one of chat/responses/messages/ai-run
   through the normal relay token path. Prove signed-authority rejection cases
   and exactly one central reserve followed by settlement/refund and audit.
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

1. D1 migrations are an exact 20-file set through
   `0020_realtime_billing_reservation_leases.sql` in the target environment.
   The pre-0020 reservation ledger was exported and reconciled with zero
   remaining `reserved` rows before apply; 0020 fails closed if this invariant
   is not met because a D1 migration cannot reconstruct DO alarm ownership.
2. A single connection completes at least two independently reserved cycles,
   binds distinct `response.created` identities, and settles their
   `response.done` events out of order with distinct correct audit rows.
3. Replaying either client `event_id` or upstream response identity produces no
   second debit, credit, request-count increment, channel increment, or log.
4. Insufficient user quota, insufficient token quota, and a forced guarded D1
   failure leave no partial reservation or quota mutation and do not forward
   the client event upstream.
5. Missing usage, local forward failure, disconnect, and upstream terminal
   failure each produce one documented refund outcome.
6. Two simultaneous settlement failures persist as two records; alarm retry,
   alarm replacement, DO eviction, and restart recover both without overwrite;
   retry exhaustion refunds rather than stranding reserved quota.
7. An active reservation lease is persisted before its D1 reservation becomes
   externally useful. A not-yet-due alarm leaves it reserved, while expiry
   after bridge loss, hibernation, eviction, or restart refunds it exactly once
   through D1 CAS. Forced D1 refund failures keep one redacted lease record and
   retry without a fixed attempt cap.
8. The settlement retry queue and active lease queue have exclusive ownership:
   moving work to settlement retry removes its lease, and retry exhaustion
   either refunds immediately or durably returns ownership to the lease queue.
   One alarm is always scheduled for the earliest deadline across both queues.
9. `REALTIME_BILLING_RESERVATION_LEASE_SECONDS` is derived from measured
   staging response-duration p99 plus approved retry/clock-skew margin, remains
   within `30..3600`, and has an alert for repeated expiry-refund attempts.
10. Public status, frontend capability output, Worker logs, and archived smoke
   artifacts contain hashes/metadata only, never raw prompts, event IDs,
   billing expressions, token IDs, or credentials.
11. Go/Rust reconciliation for the same frozen request inputs stays inside the
   approved quota-delta threshold, and rollback/refund ownership is named.

Until every item is archived from isolated staging,
`realtime_session_billing_settlement_compiled` and
`realtime_session_v1_cutover_ready` remain false.
