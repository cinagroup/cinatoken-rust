# Production Migration Plan And Audit

Date: 2026-06-21

Audited revision: `b826076`

Follow-up implementation note: after this audit, the Rust migration added a
bounded relay JSON body reader, bounded non-stream JSON response readers,
Workers observability config, and local Wrangler preflight scripts. Raw,
multipart, and pass-through stream request body support remains part of Phase 3.

Scope: pause feature implementation and define the production-grade migration
plan for moving `github:cinagroup/cinatoken` to `cinatoken-rust`, including a
best-practices audit of the current Rust/Cloudflare Worker state.

Primary references:

- Cloudflare Workers Best Practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Cloudflare Workers Limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare D1 Best Practices:
  <https://developers.cloudflare.com/d1/best-practices/>
- Cloudflare Queues:
  <https://developers.cloudflare.com/queues/>
- Cloudflare Workflows Rules:
  <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>

## Executive Summary

`cinatoken-rust` has a credible Worker relay MVP, but it is not yet a
production migration. The current codebase is strongest in these areas:

- Rust workspace and Cloudflare Worker entrypoint are in place.
- Core D1 schema, migration CLI, token auth, channel selection, model mapping,
  cache, rate limit, tiered billing foundation, and relay audit logs exist.
- Several high-frequency relay routes now have unit and wasm compile coverage:
  OpenAI-compatible chat/completions/responses/embeddings/images/audio speech,
  native Anthropic Messages, native Gemini generate/embedding/countTokens, and
  Jina/Cohere rerank.
- Streaming passthrough is implemented for the main SSE routes, with audit
  parsing delegated to `wait_until`.

The production blockers are not mysterious, but they are important:

- Production Cloudflare configuration is still a development placeholder,
  though Workers observability is now enabled in the base local config.
- Live Worker, D1, Redis, upstream SSE, and provider smoke tests have not been
  completed.
- Queue/R2/KV bindings exist in configuration but are not used by Worker code.
- Multipart/raw-body relay, exact tokenizer/media estimation, non-tiered
  billing, retry/auto-ban/health scoring, admin APIs, payments, async tasks,
  OAuth/Passkey/2FA, and frontend migration remain open.
- Current JSON request bodies and non-stream JSON response audit/transform
  reads are now explicitly bounded, with endpoint-specific defaults for current
  JSON relays. Buffering remains acceptable only when bounded; production
  migration must preserve streaming for unbounded bodies and must gate any new
  provider-specific response rewrite by endpoint-specific payload limits.

Production direction: keep the current Worker as the high-frequency relay and
auth/billing edge, but treat D1 as source of truth, Upstash Redis as hot
counter/cache/lock layer, Queues as async write buffer, R2 as archival/blob
storage, Durable Objects as realtime/session state, and optional native Rust
services as escape hatches for long-running or runtime-incompatible workloads.

## Audit Method

The audit used:

- official Cloudflare Workers best practices and current platform references;
- local inspection of `wrangler.toml`, `package.json`, `README.md`, core docs,
  D1 schema, Worker entrypoints, relay pipeline, cache transport, billing docs,
  and verification docs;
- targeted scans for Worker anti-patterns: unbounded buffering, missing
  `wait_until`, unused Cloudflare bindings, secrets handling, pending
  limitations, and production config gaps.

No business code was changed for this audit.

## Current State Snapshot

Implemented production-relevant foundation:

- Worker routes: `/api/status`, `/v1/models`, `/v1/chat/completions`,
  `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/rerank`,
  `/v1/images/generations`, `/v1/audio/speech`, `/v1/messages`, and native
  Gemini `/v1beta`/`/v1` generate/stream/embed/countTokens paths.
- D1 repositories isolate most Worker SQL in `crates/worker/src/d1_repositories.rs`.
- Upstash Redis REST client exists for relay read-through cache and rate
  limiting.
- Tiered billing expression preflight/reserve/settlement foundation is wired
  for many relay paths.
- Verification docs list passing Rust, wasm, migration, and Bun checks.

Known incomplete areas:

- `wrangler.toml` uses development vars, placeholder D1/KV IDs, and TOML
  rather than JSONC; the base config now has an observability block, but
  staging/prod sampling policy still needs to be set deliberately.
- The `LOG_QUEUE`, `TASK_QUEUE`, `FILE_BUCKET`, `CACHE_KV`, and `CONFIG_KV`
  bindings are declared but currently unused by Worker code.
- Worker relay now marks current relay endpoints as explicit JSON-only body
  mode. The JSON body is read through a size-limited stream reader, but
  multipart/raw-body endpoints remain blocked until dedicated body modes are
  implemented.
- No live provider smoke, no live SSE verification, and no production D1 or
  Wrangler dev end-to-end result is recorded.
- Source database row counts/hashes for a real deployment have not been
  captured in the current shell.

## Production Audit Findings

### P0: Production Wrangler Configuration Is Not Ready

Evidence:

- `wrangler.toml:9-12` sets `ENVIRONMENT = "development"`,
  `FRONTEND_BASE_URL = "http://localhost:3000"`, and an empty `AI_GATEWAY_ID`.
- `wrangler.toml:14-25` uses zero placeholder D1/KV IDs.
- `wrangler.toml` now enables Workers observability in the base config, but
  production/staging environments still need explicit real bindings and
  sampling policy.
- Cloudflare recommends current compatibility dates, secrets via Wrangler, and
  Workers Logs/Traces before production.

Impact:

Deploying this config as-is would either fail binding resolution or deploy a
development-shaped Worker with no production telemetry baseline.

Production requirement:

- Move to deliberate environment config, preferably `wrangler.jsonc`.
- Keep `compatibility_date` fresh and retain `nodejs_compat`.
- Add production/staging bindings with real IDs.
- Store secrets only through `wrangler secret put` or the chosen secret-store
  flow.
- Enable Workers Logs/Traces with explicit staging/prod sampling rates.
- Run `wrangler types` after every binding change and check generated binding
  types into the appropriate generated file policy.

### P0: Live End-To-End Verification Is Missing

Evidence:

- `docs/verification.md` records no live Jina/Cohere rerank request.
- The pending section records no live upstream provider request, no live SSE
  upstream coverage, and no `wrangler dev` end-to-end run with real D1.

Impact:

Unit and wasm compile coverage are strong but insufficient for cutover.
Provider behavior, headers, stream chunking, D1 binding behavior, Redis REST
latency/errors, and Cloudflare runtime differences remain unproven.

Production requirement:

- Create a staging Worker with real D1, Upstash, and at least one real upstream
  provider key per P0 path.
- Run smoke tests for non-stream and stream variants.
- Capture request IDs, upstream IDs, logs, quota deltas, and latency.
- Add a repeatable `staging-smoke` checklist before any canary traffic.

### P0: Request Body Handling Must Split JSON, Raw, Multipart, And Streams

Evidence:

- Current relay endpoints are explicitly JSON-only and parse into
  `serde_json::Value` after a bounded body read.
- The relay preparation stage now centralizes JSON bounded reads, endpoint
  validation, and billing request-input snapshots.
- `docs/relay-mvp.md` marks audio transcription/translation multipart paths
  as pending.

Impact:

Adding `/v1/audio/transcriptions`, `/v1/audio/translations`, file uploads,
image edits, or provider-specific multipart APIs on top of the current JSON
helper would force buffering or incorrect content-type handling.

Production requirement:

- Extend the request body mode abstraction before new upload endpoints:
  `JsonBody`, `RawBody`, `MultipartBody`, and `PassThroughStream`.
- Bound all buffered bodies by endpoint-specific limits.
- Preserve downstream content type and upstream streaming behavior.
- Add tests for large body rejection and streaming pass-through.

### P1: Some Response Paths Buffer Bodies And Need Endpoint-Specific Bounds

Evidence:

- Cohere rerank response transformation, fallback non-stream responses, and
  cloned non-stream audit responses now use a bounded JSON response reader with
  endpoint-specific defaults for current JSON relay families.
- `crates/worker/src/cache.rs:34` buffers Upstash REST responses, which are
  expected to be small JSON.

Impact:

Cloudflare best practices are clear: large or unknown request/response bodies
should stream. The JSON response guardrails prevent accidental unbounded reads,
but future provider-specific response transforms still need explicit
endpoint-level limits and live upstream validation.

Production requirement:

- Classify each buffered response path by expected maximum size.
- Keep Upstash JSON buffering, because it is bounded.
- Keep non-stream usage audit buffering only for JSON endpoints with an
  explicit endpoint max-size policy.
- Before expanding Cohere/rerank/provider transforms, add payload-size guards
  or move to streaming passthrough plus async audit branch.

### P1: Queue And R2 Architecture Is Planned But Not Implemented

Evidence:

- `wrangler.toml:27-37` declares R2 and Queue bindings.
- `rg` finds no Worker code usage of `LOG_QUEUE`, `TASK_QUEUE`,
  `FILE_BUCKET`, `CACHE_KV`, or `CONFIG_KV`.
- Current relay audit writes still go through D1 synchronously or via
  `wait_until`.

Impact:

The Worker can operate as an MVP, but high-volume production traffic will put
logs and settlement writes on D1 hot paths. This is a known risk in the
original migration plan.

Production requirement:

- Keep quota mutation strongly consistent.
- Move high-volume audit/event logs to Queue producers with D1 batch consumers.
- Archive large raw audit objects and task outputs to R2.
- Use D1 for recent queryable logs and R2/Analytics Engine for long-term
  analytics.

### P1: Data Migration Coverage Is Not Yet Production Complete

Evidence:

- `migrations/d1/0001_core.sql` covers core relay tables plus partial payment
  and subscription rows.
- Original plan lists many source tables beyond the current D1 MVP:
  Passkey, OAuth, 2FA, checkins, redemptions, quota history, subscriptions,
  pre-consume records, setup/config tables, perf metrics, and task history.
- `docs/data-export.md` currently prefers core export until D1 import and
  verification are ready.

Impact:

Core relay can be tested, but a full production migration could lose admin,
auth, payment, task, or historical data unless table-by-table coverage is
finished and verified.

Production requirement:

- Build a source-to-target table matrix with owner, schema status, import
  status, validation hash, rollback path, and production criticality.
- Complete D1 migrations before importing production data.
- Store export bundles outside source control and encrypt transport/storage.
- Verify row counts, stable sample hashes, quota totals, and referential
  integrity before any cutover.

### P1: Billing Is Good But Not Yet Cutover-Safe

Evidence:

- `docs/billing-migration.md` records strong tiered billing progress.
- The same doc still lists exact tokenizer counts plus image dimension/audio
  duration parity as remaining.
- Non-tiered billing is still documented as `quota = 0` and
  `other.billing_pending = true`.

Impact:

Billing correctness is the highest-risk cutover dimension. A small mismatch
can create customer-facing quota errors.

Production requirement:

- Finish exact token/media estimation parity.
- Finish non-tiered billing settlement.
- Add broad Go/Rust golden parity fixtures, including real production-shaped
  pricing expressions.
- Run shadow billing in staging and then canary production before applying
  Rust deltas as source of truth.

### P1: Security Controls Are Partially Planned, Not Implemented

Evidence:

- `.dev.vars`, `exports/`, and `*.cinatoken-export.json` are ignored.
- README instructs storing secrets with Wrangler.
- The original migration plan calls out SSRF protection, key masking,
  Turnstile, OAuth state, webhook signing, and audit logging.
- Current Worker relay supports token auth and IP allowlist, but admin auth,
  OAuth, Passkey, Turnstile, payment webhooks, and SSRF protection are not
  production-complete.

Impact:

Relay MVP security is acceptable for local/staging MVP but not for full
production API/admin/payment exposure.

Production requirement:

- Add a security gate for each externally configurable URL, file URL, webhook,
  and provider base URL.
- Implement constant-time or hash-based secret comparison where applicable.
- Encrypt or otherwise protect channel keys/tokens at rest if production threat
  model requires it.
- Add admin audit logs for every sensitive mutation.
- Add WAF, Turnstile, and rate-limit policies to the cutover runbook.

### P2: README And Operational Docs Lag Behind Current Capabilities

Evidence:

- README still describes zero-quota audit logs and final settlement as pending,
  while later docs show tiered settlement is implemented for many paths.

Impact:

Operators can follow stale instructions or underestimate current risks.

Production requirement:

- Update README after the production plan is accepted.
- Keep `docs/verification.md`, `docs/relay-mvp.md`, and this audit plan as the
  source of truth for cutover status.

## Target Production Architecture

```text
Client SDKs / Admin Browser
        |
Cloudflare DNS / CDN / WAF / Turnstile
        |
+---------------------+       +-------------------------+
| Pages admin frontend|       | Rust Worker API Gateway |
+---------------------+       +-------------------------+
                                      |
         +----------------------------+----------------------------+
         |                            |                            |
        D1                         Upstash                      Queues
 users/tokens/channels       rate limits/cache/locks       log/task/payment events
 options/billing/logs        hot token/channel rows         retry + DLQ
         |                            |                            |
         +----------------------------+----------------------------+
                                      |
                                     R2
                          exports, archived logs, task outputs
                                      |
                         Durable Objects / Workflows
                   realtime sessions, long-running orchestration
                                      |
                AI Gateway / Workers AI / External Providers
```

Production principles:

- Stream unknown or large bodies; buffer only bounded JSON.
- Use D1 bindings, not Cloudflare REST APIs, for D1 access.
- Use Queues/Workflows for retriable background work.
- Keep billing/quota mutation idempotent and observable.
- Keep secrets out of config/source.
- Make every production change reversible.

## Production Migration Phases

### Phase 0: Freeze, Inventory, And Source Truth

Goal: establish a complete source inventory before more implementation.

Deliverables:

- Route matrix from Go source: method, path, auth, request body type, response
  type, streaming/multipart/task/realtime, production criticality.
- Provider matrix: channel type, auth scheme, base URL, model mapping,
  request transform, response transform, streaming support, usage parser,
  retry/auto-ban behavior, tests.
- Data matrix: source table, target D1 table, migration status, row count,
  sample hash, sensitive columns, rollback behavior.
- Billing matrix: model pricing mode, group ratio, expression, request-rule,
  Go/Rust parity fixture, shadow result.
- Protected attribution scan policy for existing protected project identity
  references.

Exit gates:

- Every P0/P1 route and table has an owner and status.
- Source database snapshot path and row counts are recorded.
- Production secrets inventory exists without writing secret values to docs.

### Phase 1: Production Cloudflare Foundation

Goal: make the platform deployment shape production-ready before more API
surface is added.

Deliverables:

- Convert or supplement `wrangler.toml` with environment-specific
  `wrangler.jsonc` or a documented TOML policy.
- Real staging/prod bindings for D1, R2, Queue, KV, AI Gateway, and optional
  Durable Objects.
- Workers Logs/Traces enabled with sampling rates.
- Generated Worker binding types via `wrangler types`.
- CI command set:
  `cargo fmt --all --check`,
  `cargo test --workspace --exclude cinatoken-worker`,
  `cargo test -p cinatoken-worker --lib`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check`,
  migration verification,
  protected-reference scan.
- Secrets runbook for staging/prod:
  `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`,
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, provider keys,
  payment keys, webhook secrets, Turnstile secret.

Exit gates:

- `wrangler dev` and staging deploy run against real bindings.
- `/api/status` reports expected feature flags in staging.
- No placeholder Cloudflare IDs remain in production config.

### Phase 2: D1 Schema And Data Migration Hardening

Goal: make production data import reversible and verifiable.

Deliverables:

- D1 migrations for all production-critical tables:
  users, tokens, channels, abilities, options, logs, tasks, payments,
  subscriptions, OAuth, Passkey, 2FA, redemptions, quota history, checkins,
  setup/config, and perf metrics.
- Export/import support for every table in the matrix.
- Verification modes:
  row count,
  stable row hash,
  quota aggregate hash,
  key masking validation,
  referential checks,
  sampling diff.
- Backup policy:
  source DB snapshot,
  D1 export,
  R2 encrypted archive for migration bundles,
  time-travel/restore procedure.

Exit gates:

- Core and full exports pass local SQLite verification.
- A staging D1 import passes row count/hash checks.
- Rollback import/export path is rehearsed.

### Phase 3: Relay Core Production Hardening

Goal: turn MVP relay into a robust production gateway.

Deliverables:

- Shared request body layer for JSON/raw/multipart/stream. The JSON path now
  has an explicit size limit; raw, multipart, and pass-through stream modes
  still need to be introduced before upload endpoints.
- Bounded buffering policy per endpoint.
- Streaming audit parser for all streaming routes with live SSE smoke.
- Retry, fallback, status-code mapping, channel health, auto-ban, and
  cross-group retry parity.
- Provider-specific request/response transform registry.
- SSRF and base URL validation for custom upstream URLs.
- AI Gateway integration policy with direct-provider fallback.
- Live smoke matrix for OpenAI-compatible, Anthropic, Gemini, Jina, Cohere,
  image generation, audio speech, and at least one streaming route per family.

Exit gates:

- No unbounded `response.text()` path for large/unknown bodies.
- Provider live smoke produces correct logs, quota deltas, and upstream IDs.
- Failure injection covers upstream 429/5xx, timeout, stream abort, and
  malformed usage.

### Phase 4: Billing, Quota, And Settlement Cutover Safety

Goal: protect customer balances before production traffic.

Deliverables:

- Read and preserve source billing semantics from
  `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md` before further billing
  expression work.
- Exact tokenizer/media request estimation parity.
- Non-tiered billing settlement implementation.
- Subscription funding source support.
- Idempotent reserve, refund, final settlement, and payment credit operations.
- Shadow billing:
  run Go and Rust outputs side by side,
  log delta,
  block cutover above threshold.
- Billing dashboard/admin audit surfaces.

Exit gates:

- Golden parity passes for production-shaped expressions.
- Shadow billing runs with zero critical deltas for an agreed sample window.
- Refund and additional debit behavior is tested under stream aborts and
  upstream errors.

### Phase 5: Admin API And Frontend Migration

Goal: restore the operational control plane.

Deliverables:

- Admin/user auth: login, session/JWT, password reset, OAuth/OIDC, 2FA,
  Passkey plan.
- Token management API.
- Channel/provider management API.
- Model, pricing, group, option, and ability management API.
- Logs and usage query API.
- Frontend port from source `web/default` with Bun build.
- E2E tests for login, token create, channel create/test, relay call, log view,
  quota display.

Exit gates:

- Admin can operate staging without direct D1 edits.
- Existing frontend routes either work unchanged or have documented
  compatibility shims.

### Phase 6: Provider Parity Waves

Goal: migrate provider surface in risk-ranked batches.

Wave A, production baseline:

- OpenAI-compatible direct providers.
- Anthropic native messages.
- Gemini native generate/embed/count.
- OpenAI-compatible images/audio speech.
- Jina/Cohere rerank.

Wave B, mainstream transforms:

- OpenAI-to-Claude conversion.
- OpenAI-to-Gemini conversion.
- Azure, AWS Bedrock, Vertex, Mistral, DeepSeek, Zhipu, Ali, Baidu,
  Tencent, VolcEngine, SiliconFlow, xAI, Ollama.

Wave C, upload and task APIs:

- Audio transcription/translation.
- Image edits.
- Async image/video/music tasks.
- Midjourney/Suno/Kling/Jimeng/Vidu/Sora/Replicate/Coze/Dify.

Wave D, specialized/long-tail:

- Realtime WebSocket.
- Codex subscription refresh.
- io.net deployment management.
- Any provider requiring native runtime fallback.

Exit gates:

- Each provider has a golden request/response fixture, usage parser, error
  mapping, and live smoke.
- Each streaming provider has chunk and abort tests.

### Phase 7: Async Tasks, Payments, Subscriptions, And Realtime

Goal: migrate non-relay business flows with idempotency.

Deliverables:

- Queue producers/consumers for audit logs and task polling.
- Dead-letter queue and replay tooling.
- R2 storage for task outputs and archived logs.
- Payment providers with signature verification and event idempotency.
- Subscription lifecycle and pre-consume records.
- Durable Object or service fallback plan for realtime sessions.
- Workflows for long-running multi-step processes where retry semantics matter.

Exit gates:

- Payment replay cannot double-credit.
- Task retry cannot double-charge.
- Queue backlog and DLQ alarms exist.

### Phase 8: Observability, Security, And Load Testing

Goal: make production behavior visible and enforceable.

Deliverables:

- Structured JSON logs with request ID, endpoint, model, channel, status,
  latency, quota, cache status, and upstream request ID.
- Workers Logs/Traces and dashboard queries.
- Metrics for p50/p95/p99, stream duration, D1 mutation failures, queue lag,
  Redis failures, upstream 429/5xx, billing shadow deltas, payment failures.
- Alerts and runbooks.
- WAF, Turnstile, CORS allowlist policy, SSRF validation, secret masking.
- Load tests for mixed relay traffic and admin query patterns.

Exit gates:

- On-call can answer: who called what, which channel, which quota mutation,
  which upstream request, what failed, and how to replay/refund.
- 500-concurrency mixed relay test passes agreed SLOs.

### Phase 9: Shadow, Canary, And Cutover

Goal: switch traffic without losing rollback ability.

Plan:

- Shadow mode:
  mirror selected read/relay traffic where possible,
  compare auth, channel choice, billing estimate, usage parse, and logs.
- Canary:
  route a small percentage or selected internal tokens to Rust Worker.
  Keep Go as primary rollback.
- Progressive rollout:
  1%, 5%, 25%, 50%, 100% after SLO windows.
- Freeze windows:
  restrict admin/payment mutations during high-risk migration windows if
  bidirectional sync is not ready.

Exit gates:

- No unexplained quota deltas.
- Error rate and latency stay within threshold.
- Rollback has been rehearsed.

### Phase 10: Post-Cutover Hardening

Goal: retire migration risk gradually.

Deliverables:

- Archive source exports and migration reports.
- Remove temporary compatibility shims only after documented grace period.
- Continue provider parity expansion.
- Add cost optimization, cache invalidation, and analytics improvements.
- Conduct post-cutover security review.

## Hard Go/No-Go Gates

No production cutover until all P0 gates pass:

- Real staging deploy succeeds with real Cloudflare bindings.
- Production config has no placeholder IDs or development origins.
- Secrets are configured out-of-band and never committed.
- Live smoke passes for P0 relay paths, including at least one SSE route.
- D1 import verification passes row counts and stable hashes for production
  critical tables.
- Billing shadow mode passes threshold.
- Logs/traces/alerts are enabled.
- Rollback procedure is rehearsed.

No new large-body endpoint until:

- request body layer supports raw/multipart/stream;
- endpoint size limits are defined;
- unbounded buffering is absent.

No new billing-expression change until:

- source `pkg/billingexpr/expr.md` has been read for that change;
- Go/Rust golden parity is added;
- shadow settlement is available for production-shaped inputs.

## Verification Matrix

Local required checks:

```powershell
cargo fmt --all --check
cargo test --workspace --exclude cinatoken-worker
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check
python tools/verify_sqlite.py
rg -n "<protected-project-identity-pattern>"
```

Staging required checks:

- `wrangler d1 migrations apply` against staging D1.
- `wrangler deploy --env staging` or equivalent environment deploy.
- `/api/status` feature flag check.
- Auth failure/success checks.
- Non-stream relay smoke.
- SSE relay smoke.
- Billing reserve/refund/success settlement smoke.
- Upstash outage fallback smoke.
- D1 quota mutation failure simulation if feasible.

Production preflight:

- Cloudflare dashboard/resource IDs match config.
- Workers Logs/Traces visible.
- Queue and DLQ metrics visible.
- WAF/Turnstile/rate limit rules active.
- Rollback DNS/route plan ready.
- Source DB snapshot and D1 backup/export captured.

## Operating Model

Owners should be assigned per workstream:

- Platform: Wrangler config, bindings, deployments, observability.
- Data: D1 schema, export/import/verify, rollback.
- Relay: provider adapters, streaming, request/response body policy.
- Billing: expressions, quota mutation, subscriptions, shadow mode.
- Admin/frontend: API compatibility and Pages deployment.
- Security: secrets, SSRF, WAF, OAuth, webhooks, audit logs.
- SRE: load testing, alerts, runbooks, incident response.

Each workstream must maintain:

- status;
- owner;
- risks;
- test evidence;
- rollback notes;
- production gate status.

## Next Recommended Non-Code Steps

1. Replace the original high-level migration plan with a tracked matrix:
   route matrix, provider matrix, table matrix, billing matrix.
2. Create a production configuration checklist for staging and prod bindings.
3. Capture a real source database inventory: table counts, sizes, critical
   columns, and sensitive columns.
4. Define SLOs: auth/route overhead, stream first-byte overhead, error budget,
   billing-delta tolerance, and queue lag.
5. Write the first cutover runbook: staging deploy, smoke tests, canary,
   rollback, and post-cutover monitoring.
