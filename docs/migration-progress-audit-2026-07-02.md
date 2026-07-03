# Go -> Rust Migration Progress Audit

Date: 2026-07-02

Scope:

- Source: `C:\cinagroup\cinatoken`
- Target: `C:\cinagroup\cinatoken-rust`
- Runtime target: Cloudflare Workers + D1 + Static Assets, with other
  Cloudflare primitives introduced only where the workload requires them.
- Canonical route source: `docs/source-route-inventory.md`
- Architecture baseline: `docs/cinatoken-rust-migration-plan.md`

## Executive Finding

The migration has a substantial, testable Rust core, but it is **not a complete
Go replacement and is not ready for an all-traffic production cutover**.

The strongest areas are the Worker foundation, token-authenticated relay,
streaming/non-streaming usage settlement, core admin CRUD, D1 repositories,
session auth, and task settlement primitives. The weakest production gates are
full route parity, real production data migration, complete frontend/API
runtime parity, subscriptions and non-Stripe payments, task result/read APIs,
production Cloudflare configuration, and cutover evidence.

The React frontend is now tracked in this repository and produces a real
production bundle. That closes the source/build gap, but not the runtime parity
gap: several frontend feature families still call APIs that do not exist in the
Rust Worker. The Worker now advertises only the supported sidebar modules.

## Evidence Levels

Every status in this audit uses the following evidence model:

| Level | Meaning |
| --- | --- |
| E0 | Source behavior inventoried only |
| E1 | Rust implementation exists |
| E2 | Unit/type/build verification passes |
| E3 | Local integration or contract smoke passes |
| E4 | Staging deployment smoke passes against real Cloudflare resources |
| E5 | Production canary and rollback evidence passes |

No item is called production-ready below E5. A staging result does not prove
production data correctness, capacity, cost, or rollback.

## Current Capability Matrix

| Workstream | Status | Evidence | Production gap |
| --- | --- | --- | --- |
| Rust workspace and Worker entrypoint | Substantial | E2-E4 | Keep compatibility date/types current; production config still incomplete |
| D1 schema/repositories | Substantial | E2-E4 | Real source export/import/hash reconciliation and capacity evidence |
| Relay core | Substantial, not route-complete | E2-E4 | Missing aliases, multipart routes, model negotiation, realtime, explicit 501 parity |
| Streaming | Implemented for major relay paths | E2-E4 | Abort/disconnect and provider-family canary matrix still required |
| Billing and quota settlement | Substantial core | E2-E4 | Production shadow report, exact tokenizer/media parity, subscription ownership |
| Token/channel cache and rate limits | Implemented | E2-E4 | Final native-vs-Upstash production decision and failure-mode evidence |
| Session auth and core user self-service | Substantial | E2-E4 | Email, Passkey, some OAuth, check-in staging/import policy, policy enforcement gaps |
| Admin CRUD | Substantial core | E2-E4 | Long-tail channel ops, redemption, subscription, prefill/group, deployment ops |
| Async task submit/poll/settle | Substantial internals | E2-E4 | Remaining content/proxy routes, real provider smoke, R2 artifact policy |
| Stripe top-up | Partial | E2-E4 | Production webhook replay/currency reconciliation and operator sign-off |
| Non-Stripe payments/subscriptions | Incomplete | E0-E1 | Provider implementations, secrets, schemas, replay tests |
| Frontend source and production build | Implemented; public staging contract verified | E2-E4 | Authenticated/rendered browser smoke, API parity, lint debt, bundle-size budget |
| Production Cloudflare deployment | Incomplete | E0-E4 by subsystem | Replace production placeholders, migrate data, canary, rollback rehearsal |

## Backend Audit

### Confirmed Implemented

- Worker routing, API-path/static-asset precedence, CORS handling, D1 bindings,
  Queue/Cron hooks, and Cloudflare-oriented runtime configuration.
- OpenAI-compatible chat, completions, responses, embeddings, image generation,
  audio speech, rerank, Anthropic Messages, and native Gemini action routes.
- JSON and SSE relay, retries, channel selection, model mapping, token/channel
  caches, token/IP limits, audit logging, quota reserve/settle/refund, and
  tiered billing expressions.
- Session login/logout/self/setup, registration, core profile and affiliation
  functions, 2FA, GitHub/Discord/OIDC callbacks, Turnstile gate, and secure
  verification.
- Core admin user/token/channel/log/option/model/vendor APIs, key masking and
  reveal controls, mutation audit, and cache invalidation.
- Task persistence, polling, CAS settlement/refund foundations and scheduled
  polling.
- Stripe checkout/webhook reference path.

### Confirmed Route Gaps

The following source route families are not yet equivalent:

- Model discovery negotiation: `/v1/models/:model`, `/v1beta/models`,
  `/v1beta/openai/models`, and Go's header-conditional model-list behavior.
- Relay aliases/features: `/pg/chat/completions`, `/v1/responses/compact`,
  `/v1/edits`, `/v1/engines/:model/embeddings`, `/v1/moderations`.
- Multipart routes: image edits, audio transcription, audio translation.
- `/v1/realtime` WebSocket.
- Go's explicit 501 surface for files, fine-tunes, variations, and model delete.
- Dashboard billing compatibility routes.
- Public rankings and performance-summary routes.
- Remaining task result/content/proxy routes for Suno, Midjourney, and video.
- Redemption, subscription, email/reset/bind, Passkey, custom OAuth,
  and non-Stripe payment families.
- Deployment/io.net operations and several provider-specific channel operations.

These gaps must remain visible in planning. A generic Worker 404 is not
behavioral parity where Go intentionally returns a typed 501 or a specific
auth/error envelope.

## Frontend Audit

### Source And Build

- The complete Bun workspace is now under `apps/web/source/`.
- `apps/web/source/default` is the default React 19/Rsbuild application.
- `apps/web/source/classic` is retained because the source workspace and lockfile
  include it.
- Source baseline copied from Go commit
  `73652508abc5cb09214dde02d51d69d1d1ccc703` (2026-06-16).
- `bun install --frozen-lockfile` completed successfully.
- TypeScript project build and Rsbuild production build completed successfully.
- `tools/build_web.mjs` copies the produced bundle to `apps/web/dist/` using a
  cross-platform build path.
- Production API base URL is empty, so browser calls are same-origin.

### Contract Findings And Fixes

The first real build/integration audit found two production-blocking contract
defects:

1. The React application expects `/api/status` to return
   `{success,message,data}`, but the Worker returned a raw internal status
   object. The Worker now returns the Go-compatible envelope, public option
   values, runtime feature diagnostics, and OAuth/Turnstile capability flags.
2. Rust returned `/api/setup.data.status = !completed`, while the frontend and
   Go source define `true` as setup complete. This would redirect initialized
   deployments back to `/setup`. The direction is corrected and tested.

The status response now clamps navigation to APIs currently supported by Rust.
Rankings, playground, wallet/top-up, redemption, subscriptions, and io.net model
deployments remain hidden until their backend contracts are complete. Task and
Midjourney usage-log read APIs now exist, but navigation remains conservative
until authenticated browser smoke and the remaining task content/proxy routes
are proven.

### 2026-07-03 Frontend Contract Delta

An AST-based audit now compares the default frontend's 212 distinct API calls
with the Worker router. TypeChecker-based local-variable resolution found real
calls the initial syntax-only scan missed; local helper-method inference then
classified MJ/task reads and removed a false-positive `endsWith('/v1')` call.
The first baseline found 122 unmatched calls. Successive P0 compatibility
batches, the parser correction, single-channel upstream update migration, Codex
admin usage/refresh migration, the Rust-native channel-affinity cache control
surface and usage diagnostics, bounded upstream batch slices, Ollama admin
model management, Worker-native operations endpoints, upstream ratio sync,
custom OAuth provider/binding management, async task/Midjourney usage-log read
migration, and user daily check-in migration reduced that number to 71 and
added:

- Go-compatible `/api/group` and `/api/group/`;
- secure, user-scoped `POST /api/token/batch/keys`;
- `POST /api/channel/batch/tag` and `GET /api/channel/tag/models`;
- default-frontend aliases `/api/user/2fa/enable` and
  `/api/user/2fa/backup_codes`;
- complete setup/status/disable 2FA payload parity, including stable backup
  codes, lock state, and remaining-code count;
- `DELETE /api/user/:id/2fa` for the user-admin action;
- D1-backed prefill-group CRUD;
- fixed-origin official model metadata preview/sync;
- provider balance refresh and multi-key channel management;
- single-channel `/api/channel/upstream_updates/detect` and
  `/api/channel/upstream_updates/apply` with bounded outbound fetches,
  provider URL special cases, regex ignored models, model-mapping alias
  protection, optimistic `models/settings` persistence, ability rebuilds, and
  audit logging for apply.
- `/api/channel/:id/codex/usage` and `/api/channel/:id/codex/refresh` with
  bounded HTTPS outbound, one 401/403 refresh/retry, JWT identity extraction,
  D1 CAS credential replacement, best-effort cache invalidation, secret-safe
  audit, and an explicit rejection of Go VPS local-proxy settings.
- `GET /api/option/channel_affinity_cache` and
  `DELETE /api/option/channel_affinity_cache` for the Worker-native indexed
  Durable Object affinity subset. The routes expose real KV-indexed stats and
  bounded clear operations; they do not synthesize Go's configurable
  rule-template or usage-stat caches.
- `GET /api/log/channel_affinity_usage_cache` for the Rust fixed-rule
  affinity subset. Relay success logs now attach frontend-visible
  `other.admin_info.channel_affinity` metadata and update TTL-bounded
  cache-hit/token counters when upstream usage is present.
- `POST /api/channel/upstream_updates/detect_all` and
  `POST /api/channel/upstream_updates/apply_all` as after-id bounded Worker
  slices. The default frontend now loops over cursors and aggregates
  Go-compatible counts, avoiding a single synchronous Worker request that
  scans every channel and calls every upstream.
- `GET /api/channel/ollama/version/:id`, `DELETE /api/channel/ollama/delete`,
  and `POST /api/channel/ollama/pull/stream`, plus Ollama `/api/tags` model
  listing for probe and stored-channel fetch paths. Workers require HTTPS/443
  base URLs reachable through Cloudflare-native ingress, not VPS-local daemon
  access.
- `GET /api/ratio_sync/channels` and `POST /api/ratio_sync/fetch` for the
  default frontend's upstream price-sync dialog. The Worker lists D1 channels
  plus the Go-compatible official/models.dev presets, fetches selected
  upstreams with timeout and 10 MiB body limits, converts OpenRouter,
  models.dev, ratio-config, and `/api/pricing` payloads, and compares them
  against effective local default-plus-option ratio maps without returning
  upstream keys.
- Root-admin custom OAuth provider CRUD/discovery:
  `GET/POST /api/custom-oauth-provider`, trailing-slash aliases,
  `GET/PUT/DELETE /api/custom-oauth-provider/:id`, and
  `POST /api/custom-oauth-provider/discovery`. The Worker stores provider
  config in D1 migration 0010/import tables, never returns `client_secret`,
  writes secret-safe admin audit rows, exposes enabled non-secret providers via
  `/api/status`, and bounds discovery with SSRF validation, redirect errors,
  a 20s timeout, and a 1 MiB response cap. Custom OAuth login/bind callbacks
  remain deferred to the auth-flow batch.
- Custom OAuth account-binding management:
  `GET/DELETE /api/user/oauth/bindings/:provider_id`,
  `GET/DELETE /api/user/:id/oauth/bindings/:provider_id`, and
  `DELETE /api/user/:id/bindings/:binding_type`. The Worker lists bindings via
  the D1 `user_oauth_bindings` table joined to custom providers, treats missing
  bindings as successful unbinds like Go, audits self/admin unbind and built-in
  binding-clear actions, and exposes built-in binding IDs in self/admin user
  responses for the default profile/users UI. Custom OAuth callback/login flows,
  WeChat, email reset, and Passkey remain deferred.
- Async usage-log read lists:
  `GET /api/mj`, `GET /api/mj/self`, `GET /api/task`, and
  `GET /api/task/self`. The Worker reads D1 `midjourneys`/`tasks` with
  Go-compatible pagination and filters, scopes self routes to the session user,
  hides task `channel_id` on self responses, and preserves Midjourney
  `submit_time`/`finish_time` millisecond writes to match Go and the default
  frontend.
  Provider task submission, polling, and artifact/content routes still require
  separate G7 smoke evidence.
- User daily check-in:
  `GET /api/user/checkin` and `POST /api/user/checkin`. The Worker reads
  `checkin_setting.enabled`, `checkin_setting.min_quota`, and
  `checkin_setting.max_quota` from D1 options, exposes `checkin_enabled` via
  `/api/status`, persists daily records in the new D1 `checkins` table, applies
  a unique `(user_id, checkin_date)` guard, increments user quota atomically
  after insert, rolls the record back on quota-update failure, writes a
  best-effort system log, and runs Turnstile on submit when configured. The
  Worker uses UTC dates for the daily boundary because Cloudflare Workers do
  not have a stable deployment-local VPS timezone.

The missing-route set is now classified and stored as a SHA-256 baseline:
13 auth-deferred, 42 capability-hidden-product, 16 payment-deferred, and 0
operations-debt / visible-admin-debt. The root check fails on
unclassified additions or unreviewed baseline changes.

The public staging verifier passes seven non-mutating checks: status, setup,
11 SPA routes, eight assets, artifact identity, public envelopes, and
API-before-SPA precedence. This raises the static hosting/public HTTP slice to
E4, but does not raise authenticated or rendered workflows above E2 because
staging is uninitialized and no browser DOM session was available.

### Remaining Frontend Risks

- Strict lint currently reports 101 errors and 4 warnings in the migrated source.
  Most are React 19 hook/compiler correctness rules. The build/typecheck gate
  passes; the quality gate remains intentionally separate and failing.
- The production bundle is approximately 18.9 MB uncompressed / 4.4 MB gzip.
  The largest chunks are approximately 5.3 MB, 2.7 MB, and 1.9 MB. Route-level
  lazy loading and heavy dependency isolation need a defined budget before G5.
- Public HTTP hard-refresh and artifact identity now pass on staging. Login,
  setup mutations, role gating, CRUD, console/network inspection, and the
  dashboard/keys/channels/users/logs/models/settings/profile rendered flows
  still need browser smoke against an initialized staging environment.
- Hidden navigation is a temporary compatibility boundary, not completion.
  Direct URLs must also fail predictably until their APIs are migrated.

## Documentation Audit Findings

Prior documents mixed evidence levels and contained stale claims:

- `docs/migration-completion-status.md` said all portable follow-ups were done.
  That is contradicted by the canonical route inventory and frontend API calls.
- `docs/frontend-deploy.md` said frontend source was not in this repository and
  the real build had not run. Both statements are now obsolete.
- Several readiness-matrix rows still described auth/admin/task work as planned
  even though implementations exist, while other documents called entire
  families complete despite missing public routes.

This audit is the current correction layer. Detailed matrices should be updated
from this evidence, not from commit count or implementation presence alone.

## Production-Critical Next Sequence

### P0: Make The Current Product Slice Honest And Deployable

1. Deploy the current P0 backend compatibility batch to staging.
2. Run browser smoke for setup, anonymous status, login/logout/current-user,
   dashboard, keys, channels, users, logs, models, settings, and profile.
3. Move bounded upstream `detect_all`/`apply_all` slices to Queue/Workflow
   orchestration with progress, idempotency, and failed-channel retry evidence.
4. Upgrade affinity beyond the current enumerable Rust subset only when
   rule-template parity is implemented; do not expose
   placeholder all-zero Go-compatible usage stats.
6. Replace all production `REPLACE_WITH_PRODUCTION_*` values before any canary.

### P1: Close High-Value Route And Data Gaps

1. Model-list/retrieve negotiation and remaining low-complexity JSON aliases.
2. Task fetch/read/content APIs using the existing task repository.
3. Dashboard billing usage/subscription compatibility reads.
4. Real Go SQLite export -> D1 import -> row/hash/relationship reconciliation.
5. Paid billing shadow comparison with explicit mismatch thresholds.

### P2: Complete Product Families

1. Subscriptions and redemption.
2. Multipart relay routes.
3. Email/reset/bind and Passkey.
4. Non-Stripe payments with independent signature/replay tests.
5. Long-tail provider/channel operations and deployment management.
6. Realtime design and implementation.

### P3: Cutover

Only after P0-P2 scope selected for production is E4:

1. Load/cost/capacity test the selected route set.
2. Rehearse D1 restore and traffic rollback.
3. Run internal-token canary, then percentage canary.
4. Freeze/export/reconcile source data.
5. Promote only with named operator sign-off and abort thresholds.

## Definition Of Complete

The Go-to-Rust migration is complete only when:

- every source route is implemented, intentionally retired with an approved
  compatibility response, or explicitly retained on a documented fallback;
- production data migration and rollback are rehearsed;
- billing/payment replay and reconciliation evidence pass;
- the frontend has no visible call to an unsupported API;
- production configuration has no placeholders;
- selected SLO, capacity, cost, security, canary, and rollback gates are E5.

Until then, the accurate label is: **substantial Rust/Cloudflare migration in
progress, with a deployable core slice and incomplete full-product parity**.
