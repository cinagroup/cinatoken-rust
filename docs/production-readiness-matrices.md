# Production Readiness Matrices

Date: 2026-06-22

Status: companion evidence matrix for
`docs/production-migration-execution-plan.md`.

## Purpose

This file tracks the concrete evidence required to migrate from the Go/VPS
deployment to the Rust/Cloudflare deployment. The execution plan defines gates;
this file defines the matrices that those gates consume.

Detailed staging/prod Cloudflare binding, secret, and observability gates are
tracked in `docs/cloudflare-production-config-checklist.md`. Traffic ramp,
rollback, reconciliation, and decommission steps are tracked in
`docs/cutover-rollback-runbook.md`. Executable G3 route/provider parity is
tracked in `docs/route-provider-parity-runbook.md`. Executable G5
admin/frontend/auth parity is tracked in
`docs/admin-frontend-parity-runbook.md`. Performance, capacity, and cost
evidence is tracked in `docs/performance-capacity-cost-runbook.md`.

Source inputs inspected for this revision:

- `C:\cinagroup\cinatoken\router\relay-router.go`
- `C:\cinagroup\cinatoken\router\video-router.go`
- `C:\cinagroup\cinatoken\router\api-router.go`
- `C:\cinagroup\cinatoken\router\dashboard.go`
- `C:\cinagroup\cinatoken\router\web-router.go`
- `C:\cinagroup\cinatoken\web\default\package.json`
- `C:\cinagroup\cinatoken\web\default\src`
- `C:\cinagroup\cinatoken\model\main.go`
- `C:\cinagroup\cinatoken\model\{user,token,channel,ability,option,log}.go`
- `migrations/d1/0001_core.sql`
- `C:\cinagroup\cinatoken\constant\channel.go`
- `C:\cinagroup\cinatoken\constant\api_type.go`
- `C:\cinagroup\cinatoken\common\api_type.go`
- `C:\cinagroup\cinatoken\relay\relay_adaptor.go`
- `C:\cinagroup\cinatoken\relay\channel`
- `C:\cinagroup\cinatoken\.env.example`
- `C:\cinagroup\cinatoken\constant\env.go`
- `wrangler.toml`
- `crates/worker/src/lib.rs`
- `crates/worker/src/relay.rs`

Cloudflare references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Wrangler configuration:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Compatibility dates:
  <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Workers Fetch:
  <https://developers.cloudflare.com/workers/runtime-apis/fetch/>
- Gradual deployments:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
- Rollbacks:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>
- Workers static assets:
  <https://developers.cloudflare.com/workers/static-assets/>
- Workers SPA routing:
  <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Turnstile server-side validation:
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Workers pricing:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- D1 pricing:
  <https://developers.cloudflare.com/d1/platform/pricing/>
- D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>
- Queues limits:
  <https://developers.cloudflare.com/queues/platform/limits/>
- R2 limits:
  <https://developers.cloudflare.com/r2/platform/limits/>

## Status Legend

| Status | Meaning |
| --- | --- |
| Done | Implemented and covered by local tests or docs evidence. |
| Partial | Some implementation exists, but live evidence or parity is missing. |
| Planned | Required for production but not implemented in Rust yet. |
| Blocked | Cannot proceed until a prerequisite is implemented or external data exists. |
| Deferred | Not part of the first production cutover scenario. |

Gate labels:

- G0: inventory freeze
- G1: Cloudflare staging foundation
- G2: data dry run
- G3: relay parity
- G4: billing parity
- G5: admin/frontend parity
- G6: observability/security
- G7: canary
- G8: cutover
- G9: post-cutover hardening

## Evidence Model

Every production-ready row should eventually carry:

- source evidence: Go route/model/provider/config location;
- Rust evidence: source file, test, or migration file;
- live evidence: staging smoke log, request ID, or dashboard proof;
- data evidence: row counts, hashes, import result, or rollback bundle;
- rollback evidence: how to return authority to Go/VPS.

Do not mark a row `Done` for production solely because local unit tests pass.
Local tests can satisfy implementation evidence, but live staging evidence is
required for G1-G8 decisions.

## Gate Evidence Matrix

| Gate | Required Matrix Rows | Current Status | Next Evidence |
| --- | --- | --- | --- |
| G0 | Route, provider, table, secret, config inventory | Partial | Canonical route inventory (`docs/source-route-inventory.md`), provider/channel mapping (`docs/source-provider-channel-matrix.md`), and deployment env inventory (Environment And Config Inventory below) landed 2026-06-25. Remaining: real production per-table row counts and a redacted secret-name inventory from the production `options` table. |
| G1 | Cloudflare binding/config checklist | Partial | Deploy staging Worker with real D1/KV/R2/Queue IDs and generated types. |
| G2 | Table migration matrix | Partial | P0 field-level parity captured (`docs/source-d1-schema-parity.md`) with corrective `0004_schema_parity.sql`. Remaining: apply D1 migrations through `0004` to staging, then run real source export/import/verify (row counts + hashes). |
| G3 | Relay route and provider matrices | Partial | Route inventory, provider/channel mapping, and channel-selection algorithm captured (`docs/source-route-inventory.md`, `docs/source-provider-channel-matrix.md`, `docs/source-channel-selection-parity.md`). Weighted selection is wired into the retry loop with a Worker CSPRNG-backed bounded RNG and deterministic tests. Remaining: staging weighted-random/affinity/cross-group-retry evidence, retry/auto-ban/recovery parity (`docs/source-retry-autoban-parity.md`), and a redacted G3 report from `docs/route-provider-parity-runbook.md`. |
| G4 | Billing matrix | Partial | Engine contract + 56-test golden gap map captured (`docs/source-billing-expr-parity.md`). Remaining: close priority gaps (rounding, non-tiered/flat, time helpers, image/audio, math, fuzz, gjson `param()`), then run shadow settlement report. |
| G5 | Admin/frontend route, auth/session, operator CRUD, cache, and audit matrix | Partial | Auth/session and core operator CRUD have landed. The tracked React/Bun workspace now passes type/build, Prettier, and strict ESLint with a zero-debt no-regression baseline enforced during `bun run check`; the built frontend bundle is scanned for high-confidence secret/token leakage; an executable bundle-size ratchet budget is enforced; `/api/status` + `/api/setup` match the frontend contract; and the broadened frontend route audit baseline is down to 0 missing calls / 0 visible-admin / 0 operations-debt / 0 payment-debt / 0 capability-hidden-product gaps across 214 Worker-facing frontend routes, including constant endpoint objects, SSE constructors, navigation calls/assignments, and API-prefixed JSX `href`/`src` attributes. This evidence follows indexed channel-affinity stats/clear, usage diagnostics, bounded upstream batch slices, Ollama admin model management, Worker-native operations endpoints, upstream ratio sync, custom OAuth provider/admin binding management, async task/Midjourney usage-log read lists, user daily check-in, admin redemption-code management, public rankings, subscription core, Stripe wallet/topup history compatibility, Stripe subscription checkout/settlement, Creem subscription checkout/settlement, public redemption-code topup, legacy online amount estimation, Epay wallet checkout/callback, Epay subscription checkout/notify/return settlement, Waffo wallet checkout/webhook settlement, Waffo Pancake amount/admin helpers, Waffo Pancake wallet checkout/webhook settlement, Waffo Pancake subscription checkout/webhook settlement, Creem wallet checkout/webhook settlement, Worker-owned io.net deployment admin compatibility, Passkey route boundary/challenge generation, email verification/bind/password reset backed by `flow_state` KV + Cloudflare `send_email`, WeChat login/bind backed by a public HTTPS operator WeChat Server, and CSPRNG hardening for generated user access tokens, affiliation codes, and balance-pay subscription order suffixes. Remaining: deployed browser smoke, Passkey finish verification, real EMAIL/WeChat Server smoke, dynamic runtime callback smoke, and provider/deployment replay/reconciliation evidence. See `docs/migration-progress-audit-2026-07-02.md`. |
| G6 | Observability/security matrix | Partial | Prove logs, traces, alerts, WAF/rate limits, redaction, and runbooks. |
| G7 | Canary matrix, rollback runbook, performance/capacity/cost report | Planned | Rehearse rollback, produce redacted performance/cost report, and run internal-token canary. |
| G8 | Cutover evidence checklist | Planned | Capture final export, DNS/route plan, freeze window, owner sign-off, and approved 1x/2x/5x cost forecast. |
| G9 | Decommission matrix | Planned | Post-cutover audit, cost report, and VPS decommission plan. |

## Route Readiness Matrix

The complete, source-derived route list (every method/path, auth class, handler,
and parity finding) is `docs/source-route-inventory.md` (canonical). The matrix
below is the gated status view; where they disagree on what routes exist, the
inventory wins.

The first production migration should prefer Scenario A from the execution
plan: relay-only beta. Admin, payments, async tasks, and long-tail media routes
should not be cut over until their own rows are proven.
Detailed route body-mode, provider-adapter, smoke, and rollback evidence is
controlled by `docs/route-provider-parity-runbook.md`.

Route audit evidence is useful but not exhaustive. As of 2026-07-05 the local
audit resolves imported constant endpoint objects, SSE constructors,
navigation calls/assignments, and API-prefixed JSX `href`/`src` attributes.
It now covers both `POST /pg/chat/completions` and the task-log video content
link `GET /v1/videos/:task_id/content`, with 0 missing calls. It still does
not replace deployed browser smoke for runtime-generated OAuth/provider URLs,
role/feature-flag-hidden UI branches, credentialed redirects, or routes that
only become visible with production data.

| Route Family | Source Evidence | Rust Status | Body/Stream Mode | Gate | Next Evidence |
| --- | --- | --- | --- | --- | --- |
| Public status and setup: `/api/status`, `/api/setup`, static content endpoints | `api-router.go`, `web-router.go`, `web/default` | Substantial: Go-compatible status/setup envelopes, public content handlers, and SPA routing implemented; deployed frontend contract smoke pending | JSON/read-only/static assets | G1/G5 | Deploy current frontend/status fixes and capture anonymous/setup/hard-refresh smoke. |
| Relay model list: `GET /v1/models`, `GET /v1/models/:model` | `relay-router.go` | Partial: token-authenticated D1-backed list/retrieve implemented using token `model_limits`, effective group/auto-group enabled abilities, OpenAI envelope, Anthropic header-compatible shape, and model-not-found error shape; provider owner metadata and full billing-config visibility filtering remain incomplete | JSON | G3 | Live token smoke for unrestricted token, limited token, auto-group token, Anthropic header shape, missing model, disabled/exhausted token, and provider owner metadata parity. |
| Gemini model list: `GET /v1beta/models`, `/v1beta/openai/models` | `relay-router.go` | Partial: token-authenticated D1-backed Gemini list and Gemini OpenAI-compatible list implemented from the same visible model set | JSON | G3 | Live Gemini-client smoke with `x-goog-api-key` / `key` auth, limited-token filtering, and empty-list behavior. |
| Playground: `POST /pg/chat/completions` | `relay-router.go`, `controller/playground.go`, `middleware/distributor.go`, `service/quota.go` | Partial: Worker-owned session-backed OpenAI chat relay with group override checks, synthetic zero-id token context, JSON/SSE forwarding, token-table mutation bypass, per-user playground rate-limit key, and local `group` stripping before upstream forwarding | Bounded JSON request, JSON/SSE response | G5/G3/G4 | Logged-in staging playground smoke for non-stream + stream, group allowed/denied, user quota debit, channel quota/audit rows, rate limit scoping, and logout/disabled/quota-exhausted errors. |
| OpenAI chat/completions: `/v1/chat/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI completions: `/v1/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI responses: `/v1/responses` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live smoke for response usage and error mapping. |
| Responses compaction: `/v1/responses/compact` | `relay-router.go` | Partial: Worker relay route is implemented through the OpenAI-compatible Responses pipeline; live upstream smoke and billing shadow evidence remain | Bounded JSON request, JSON/SSE response | G3/G4 | Live compact smoke for success, unsupported channel, usage, and billing settlement/refund shape. |
| Moderations: `/v1/moderations` | `relay-router.go` | Partial: Worker relay route is implemented as OpenAI-compatible JSON passthrough with bounded request/response behavior; live upstream smoke and usage/error fixture remain | Bounded JSON request/response | G3/G4 | Live moderation smoke and fixture evidence for error mapping and zero/absent usage handling. |
| Embeddings: `/v1/embeddings`, `/v1/engines/:model/embeddings` | `relay-router.go` | Partial: `/v1/embeddings` and the legacy `/v1/engines/:model/embeddings` alias are Worker-owned through the same bounded JSON OpenAI-compatible embeddings relay. The engines alias falls back to the path `:model` only when body `model` is missing or blank, matching Go's embeddings-mode model fallback without adding a second provider path. | Bounded JSON request/response | G3/G4 | Live embeddings smoke for canonical and legacy-engine paths, batch-size checks, provider-specific adapter fixtures, and billing shadow evidence. |
| Image generations: `/v1/images/generations` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, bounded/stream response | G3/G4 | Live image smoke and large response policy evidence. |
| Image edits and legacy edits: `/v1/images/edits`, `/v1/edits` | `relay-router.go` | Partial: `/v1/images/edits` multipart forwarding and legacy `/v1/edits` compatibility route are Worker-owned; byte-safe multipart field extraction prevents binary uploads from hiding the `model` field | Multipart or JSON depending provider | G3/G4 | Live image-edit upstream smoke, usage/billing evidence, and provider-specific transform fixtures remain pending. |
| Image variations and files/fine-tunes not implemented in Go | `relay-router.go` | Deferred | Large body/file | G3 | Keep explicit 501/unsupported behavior documented. |
| Audio speech: `/v1/audio/speech` | `relay-router.go` | Partial: JSON passthrough implemented | Bounded JSON request, unparsed audio/SSE response | G3 | Live binary/audio-event smoke and audit policy evidence. |
| Audio transcription/translation: `/v1/audio/transcriptions`, `/v1/audio/translations` | `relay-router.go` | Partial: multipart forwarding is Worker-owned with bounded 25 MiB reads, byte-safe `model` extraction from binary bodies, and duration-derived prompt-token preflight estimates for WAV, MP3, FLAC, M4A/MP4, OGG/Vorbis, Opus, AIFF/AIFC, AAC ADTS, and WebM EBML `Duration`; final settlement policy and live upstream smoke remain pending | Multipart/raw upload | G3/G4 | Add real-file fixtures and replay for non-WAV/WebM formats, run live STT translation/transcription smoke, and capture billing shadow/reconciliation evidence before production ownership. |
| Anthropic Messages: `/v1/messages` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live Anthropic smoke and billing shadow report. |
| Native Gemini: `/v1beta/models/*path`, `/v1/models/*path` aliases | `relay-router.go`, Rust path parser | Partial: generate/stream/embed/count routes implemented | Bounded JSON request, streaming response for stream action | G3/G4 | Live Gemini smoke for generate, stream, embed, and countTokens. |
| OpenAI realtime: `/v1/realtime` | `relay-router.go` | Partial: `RealtimeSession` Durable Object foundation is implemented with WebSocket hibernation accepts, socket attachments, status/control smoke behavior, a default-off `/api/platform/realtime/:session...` gateway hook, and `REALTIME_SESSIONS` Wrangler bindings/migration. `/v1/realtime` protocol/auth/upstream bridge is not wired yet. | WebSocket | G7 | Wire relay-token/session auth, upstream Realtime WebSocket bridge, backpressure/error mapping, billing/audit settlement, hibernation smoke, and live protocol replay before production ownership. |
| Midjourney: `/mj/*`, `/:mode/mj/*` | `relay-router.go` | Planned | Task + images + uploads | G7 | Queue/R2 task design, image proxy policy, billing replay tests. |
| Suno: `/suno/submit/:action`, `/suno/fetch`, `/suno/fetch/:id` | `relay-router.go` | Planned | Async task | G7 | Queue/Workflow task design and idempotent polling. |
| Video OpenAI-compatible: `/v1/videos`, `/v1/video/generations`, `/v1/videos/:id/remix` | `video-router.go` | Partial: `/v1/video/generations` submit/fetch is Worker-owned through task orchestration; `/v1/videos` submit now uses the same path and returns an OpenAI video `queued` shell. Task rows now persist Go-style `properties`, channel-type `platform`, `private_data.upstream_task_id`, and raw provider submit/poll `data`; `GET /v1/videos/:task_id` uses that data for DB-backed OpenAI video status enrichment including progress fallback, common provider URL shapes, nested first-video arrays, Sora/OpenAI passthrough fields, and provider error fallback while preserving local `created_at` for non-Sora provider data. No-extra-I/O provider-specific serializer pieces are implemented for Ali status/error mapping, Doubao/Kling/Vidu/Jimeng/Hailuo error shapes, Kling provider timestamps/seconds, Doubao legacy `task_id`, and Gemini/Vertex Veo model extraction. `GET /v1/videos/:task_id/content` is Worker-owned for completed token-or-session-owner-scoped tasks when a stored result/provider URL or bounded `data:` URL is available; HTTP URLs are SSRF-validated and streamed through the Worker, while inline payloads are capped. `POST /v1/videos/:video_id/remix` is Worker-owned for Sora/OpenAI origin tasks: it owner-scopes the public origin id, locks to the origin channel, submits to the stored upstream video id, and derives remix ratios from origin task data. Credentialed provider refetch and durable artifact retention remain Partial. | Async task + binary content | G7 | Queue/R2 artifact plan, provider-specific OpenAI video conversion/content fixtures, remix provider replay, task billing replay tests, and artifact retention evidence. |
| Kling/Jimeng video routes | `video-router.go` | Partial: Kling official `POST /kling/v1/videos/text2video`, `POST /kling/v1/videos/image2video`, and their `GET .../:task_id` fetch aliases are Worker-owned. Kling submit wraps the official body into the unified task shape (`model`, `prompt`, `metadata`), preserves official provider fields in metadata, forces the correct `textGenerate`/`generate` action for the upstream Kling URL, and returns the same OpenAI video queued shell as Go's Kling adaptor. Jimeng official `POST /jimeng/` and `POST /jimeng` are also Worker-owned: non-empty submit `Action` values wrap `req_key`, `prompt`, and original metadata into unified task submit, `image` presence selects `generate` vs `textGenerate` like Go, `Action=CVSync2AsyncGetResult` maps body `task_id` to owner-scoped TaskDto fetch, and the Jimeng submit parser now returns `data.task_id` on provider `code == 10000`. | Async task + provider conversion | G7 | Provider-specific conversion fixtures, live Kling/Jimeng text-image submit and fetch replay, task billing replay tests, and artifact retention evidence. |
| Dashboard billing usage: `/dashboard/billing/*`, `/v1/dashboard/billing/*` | `dashboard.go`, `web/default/src/features/dashboard`, `web/default/src/features/pricing` | Planned | Token-auth read-only | G5/G4 | Decide whether dashboard compatibility stays on Go during Scenario A; use G5 report if moved. |
| User auth/profile/payment/checkin/OAuth/Passkey/2FA | `api-router.go`, `web/default/src/features/auth`, `profile`, `wallet` | Partial: session login/current-user/logout, public register, generated access-token and affiliation-code CSPRNG hardening, email verification/reset/bind, WeChat login/bind, core profile/self-service endpoints, wallet affiliation fields, Stripe wallet topup info/amount/pay link, Stripe subscription checkout/settlement, Creem subscription checkout/settlement, Epay subscription checkout/notify/return settlement, Waffo Pancake subscription checkout/webhook settlement, legacy online amount estimation, Epay wallet checkout/callback, Waffo wallet checkout/webhook, Waffo Pancake wallet checkout/webhook, Creem wallet checkout/webhook, Waffo Pancake admin config/catalog/subscription-product-option read paths and pair/subscription-product creation helpers, public redemption-code topup, topup history lists, 2FA frontend contract routes, Passkey status/delete plus register/login/verify begin routes and fail-closed finish routes, custom OAuth provider/binding admin surfaces, and D1-backed daily check-in are implemented; Passkey cryptographic finish verification, generic/custom OAuth callback/login/bind, provider staging replay evidence, and staging browser proof remain deferred | Session/JSON/security-sensitive | G5/G6 | Capture authenticated staging browser smoke, auth-flow defer policy, Turnstile evidence, Passkey verifier/forced-reset decision, real WeChat Server/EMAIL binding smoke, and forced re-auth/rebind decisions in `docs/admin-frontend-parity-runbook.md`. |
| Channel admin | `api-router.go`, `web/default/src/features/channels` | Partial: Tier 1 CRUD implemented (list/search/get/create/update/delete/batch/fix-abilities with abilities sync + cache invalidation); key reveal, test, fetch_models, tag ops, multi-key, single-channel and bounded-batch upstream_updates detect/apply, Codex usage/credential refresh, and Rust-native channel-affinity cache stats/clear plus usage diagnostics implemented; Ollama management deferred | Admin JSON + secret access | G5/G6 | D1 APIs, secret redaction, key reveal controls, cache invalidation, admin audit. |
| Token admin/user token management | `api-router.go`, `web/default/src/features/keys` | Partial: list/search/get/create/update/delete/batch/reveal implemented, user-scoped with ownership checks, key masking, cache invalidation | User JSON + secret access | G5/G6 | D1 APIs, cache invalidation, key reveal controls, operator UI smoke. |
| Logs, quota data, usage | `api-router.go`, `web/default/src/features/usage-logs` | Partial: admin + self log list/stat/delete implemented (`admin_crud.rs`); Midjourney and unified task read lists implemented at `/api/mj`, `/api/mj/self`, `/api/task`, and `/api/task/self`; `/api/usage/*` and search routes still Planned | Query/read-heavy | G5/G6 | Authenticated browser smoke, D1 query/index evidence, Queue/R2/archive strategy, and redaction checks. |
| Models, vendors, prefill groups | `api-router.go`, `apps/web/source/default/src/features/models`, `system-settings` | Partial: D1 schema/import, model/vendor CRUD, prefill-group CRUD, missing-model list, fixed-origin official metadata preview/sync, and default-frontend model list/detail enrichment are implemented; enrichment returns bound channels, enabled groups, quota types, matched rule models/counts, endpoint backfill, vendor counts, and server-side status/sync filters | Admin JSON | G5 | Authenticated operator UI smoke for list/search/filter/detail/create/update/delete/sync, pricing/cache invalidation evidence after model metadata mutation, and prefill-group pagination decision. |
| Redemptions, topups, subscriptions, payment webhooks | `api-router.go` | Partial: admin redemption management, public redemption-code topup with D1 `credited` idempotency, Stripe topup checkout/webhook/reference path, Stripe subscription checkout/webhook settlement, Creem subscription checkout/webhook settlement, Epay wallet checkout/callback with provider-aware `topups.payment_provider`, Epay subscription checkout/notify/return settlement with signed callback verification and local amount checks, legacy online amount estimation, Waffo wallet checkout/webhook with RSA signature and amount checks, Waffo Pancake wallet checkout/webhook with env/identity/amount checks, Waffo Pancake subscription checkout/webhook settlement with env/identity/amount checks, Creem wallet checkout/webhook with HMAC signature and amount checks, Waffo Pancake admin config/catalog/subscription-product-option read paths and pair/subscription-product creation helpers, topup info/history/admin completion, subscription core, and balance-pay are implemented; staging replay/reconciliation evidence remains deferred | Payment/idempotent writes | G4/G5/G6 | Provider-specific signature verification, replay tests, double-credit prevention, staging payment evidence, and reconciliation. Order model, per-provider quota formulas, and the two-layer idempotency design (event dedup + conditional `UPDATE WHERE status=0`) specified in `docs/source-payment-idempotency-parity.md`. |
| Custom OAuth provider management | `api-router.go` | Partial: root-admin provider CRUD/discovery, D1 schema/import, secret-redacted responses, admin audit, and `/api/status` enabled-provider exposure implemented; login/bind callbacks remain planned | Root-admin JSON + secrets | G5/G6 | Auth-flow state replay checks, callback origin policy, account-binding smoke, and staging proof that `client_secret` is never returned. |
| Performance, ratio sync, deployments/io.net | `api-router.go` | Partial: Worker-native performance compatibility, upstream ratio sync, and io.net deployment admin compatibility are implemented; real-credential deployment smoke remains pending | External API/ops | G7 | Capture authenticated staging smoke for performance/ratio sync and io.net settings, catalogs, price estimation, list/detail/log reads, one reversible mutation, and rollback. |

## Admin, Frontend, And Auth Matrix

Executable G5 evidence is tracked in
`docs/admin-frontend-parity-runbook.md`. Keep this matrix conservative until a
redacted G5 staging report exists.

| Area | Source Evidence | Rust/Cloudflare Target | Current Status | Required Evidence |
| --- | --- | --- | --- | --- |
| Frontend build | `web/default/package.json`, `web/default/bun.lock` | Bun-driven typecheck/build with recorded source commit and artifact path | Partial/E2: full workspace tracked at `apps/web/source`; frozen install, TypeScript, Rsbuild production build, Prettier, and strict ESLint pass; built text assets are scanned for high-confidence secret/token leakage during `bun run check`; bundle-size ratchet budgets are enforced during `bun run check`; strict ESLint now has a zero-debt baseline enforced during `bun run check` | Retain build/redaction/budget/lint-baseline evidence, tighten bundle budgets after heavy-route splitting, and capture deployed browser/performance evidence before G5 sign-off |
| Frontend hosting | `web-router.go`, `web/default/src/routes` | Worker static assets with SPA fallback and API route precedence | Partial/E2: real bundle produced and Static Assets wiring exists; staging browser/hard-refresh smoke is pending | Smoke supported visible routes; remaining unsupported auth flows stay deferred until APIs land |
| API base URL and CORS | `web/default/src/lib/api.ts` | Same-origin API and cookie policy | Partial/E2: production base URL is empty and dev proxies cover all known prefixes; deployed credential/session smoke pending | Prove no localhost/cross-origin production URL and capture credentialed session smoke |
| Login/current user/logout | `api-router.go`, `features/auth/api.ts`, `lib/api.ts` | Rust session authority, secure cookies, role checks, or forced re-auth policy | Partial: `/api/user/login`, `/api/user/logout`, `/api/user/self` implemented with HMAC session cookies (`crates/session`); forced re-auth from Go is the documented policy. Mechanism parity (access-token fallback, `New-Api-User` header, `sk-<key>-<channelid>` admin pin, key extraction) specified in `docs/source-auth-session-parity.md` | Login/current-user/logout smoke and expired-session handling |
| OAuth/Passkey/2FA | `api-router.go`, `features/auth`, `features/users` | Migrated securely or forced rebind/reset/defer | Partial: GitHub/Discord/OIDC, WeChat, 2FA, secure verification, email verification/reset, Passkey status/delete, KV-backed Passkey begin challenge routes, fail-closed Passkey finish routes, and admin Passkey reset are Worker-owned; Passkey cryptographic finish verification and generic/custom OAuth callbacks remain deferred | WebAuthn verifier or forced-reset/re-enroll decision, state/replay tests, credential import/reset decision, real WeChat Server smoke, admin reset audit. Flow detail (OAuth CSRF state, TOTP, WebAuthn ceremonies) + KV/DO single-use state requirement in `docs/source-oauth-2fa-passkey-parity.md` |
| Token management | `api-router.go`, `features/keys/api.ts` | Token CRUD, reveal controls, status changes, cache invalidation | Partial: list/search/get/create/update/delete/batch/reveal implemented with ownership checks, masking, audit, and cache invalidation | Operator smoke, reveal audit, token cache invalidation evidence |
| Channel management | `api-router.go`, `features/channels/api.ts` | Channel CRUD/test/disable/copy, key reveal controls, cache invalidation, Codex usage/refresh, and indexed channel-affinity stats/clear plus usage diagnostics | Partial | Operator smoke, channel selection update, secret redaction evidence |
| User and quota management | `api-router.go`, `features/users/api.ts` | User list/search/detail/manage/quota/reset with audit | Partial: list/search/get/create/update/delete, manage enable/disable/delete/promote/demote, quota add/subtract/override, generated access-token and affiliation-code CSPRNG hardening, 2FA reset, Passkey reset, and OAuth binding management routes are implemented with role-tier checks and audit rows | Atomic quota smoke, role/status smoke, audit row |
| Logs and usage | `api-router.go`, `features/usage-logs` | Recent D1 searchable logs plus archive path; task/Midjourney read lists | Partial | Request ID search, token/channel/model filters, authenticated browser smoke, no secret leakage |
| Options/settings | `api-router.go`, `features/system-settings` | Typed settings update with audit and cache invalidation | Partial: root-only list (sensitive filtered) + upsert implemented; Waffo Pancake config save, catalog/subscription-product-option reads, and pair/subscription-product creation helpers implemented with blank-private-key preservation, credential fallback, signed Waffo action calls, option-cache invalidation, and redacted audit; broader per-key validation (OAuth/ratio/console_setting) deferred | Safe option update smoke and config-cache evidence |
| Models/vendors/groups | `api-router.go`, `features/models` | Operator-visible model mapping and group/vendor config | Partial: group lookup plus model/vendor/prefill CRUD and model-list enrichment are Worker-owned; staging browser smoke and cache invalidation proof remain | Relay uses updated mapping after invalidation/TTL |
| Payment/subscription surfaces | `api-router.go`, `features/subscriptions`, `features/wallet` | Deferred to Go or covered by G4/G6 evidence | Partial: Stripe wallet topup, Stripe subscription checkout/settlement, Creem subscription checkout/settlement, Epay wallet checkout/callback, Epay subscription checkout/notify/return settlement, Waffo wallet checkout/webhook, Waffo Pancake wallet checkout/webhook, Waffo Pancake subscription checkout/webhook settlement, Creem wallet checkout/webhook, balance-pay subscriptions, redemption-code topup, amount estimation, and Waffo Pancake config/catalog/subscription-product-option/pair/product helper paths are implemented; production cutover still gated by G4/G6 replay and reconciliation evidence | Billing runbook link, webhook replay/idempotency evidence before Rust ownership (`docs/source-payment-idempotency-parity.md`) |
| Admin audit | Go audit/log behavior, Rust relay audit logs | Actor/action/target/request ID on every sensitive mutation | Planned | Redacted audit samples for token, channel, user, and option mutations |
| Frontend bundle redaction | `web/default/dist` after build | Static assets contain public config only | Partial/E2: `tools/audit_frontend_bundle_redaction.mjs` scans built frontend text assets for high-confidence private keys, API tokens, bearer literals, and credentialed URLs. `bun run check:web:bundle` and `bun run check` passed on 2026-07-05 with 460 files / 37,284,076 bytes scanned across both dist roots and 0 findings. | Keep the scan in CI, add an explicit documented allowlist only if real benign findings appear, and capture staging artifact/hash evidence before G5 sign-off |
| Frontend bundle-size budget | `web/default/dist` after build | Static assets stay inside an explicit, reviewed ratchet budget | Partial/E2: `tools/audit_frontend_bundle_budget.mjs` enforces `tools/frontend_bundle_budget.json`. `bun run check:web:bundle-budget` and `bun run check` passed on 2026-07-05 with 245 files, 18.95 MB raw / 4.49 MB gzip total, 4.29 MB raw / 1.23 MB gzip initial JS, and 5.28 MB raw / 1.00 MB gzip largest JS chunk, all within the configured budget. | Keep the budget in CI, avoid raising it without a migration note, split heavy route-specific chunks, and capture deployed browser/performance evidence before G5 sign-off |
| Frontend lint debt | `web/default/src`, `eslint.config.js` | Strict lint debt is paid down without new regressions | Complete/E2: the imported React strict-lint baseline is now zero. The final cleanup moved model mutation drawer initialization out of synchronous effect state writes, initialized ratio settings saved baselines without render-time ref reads, derived tiered-pricing number-input display values during render, and derived upstream ratio-sync endpoint defaults without effect-driven state mirroring. `tools/audit_frontend_lint_debt.mjs` enforces `tools/frontend_lint_debt_baseline.json`. `bun run check:web:quality` and `bun run check:web:lint-debt` pass on 2026-07-05 with 0 ESLint errors / 0 warnings / 0 files with findings and 0 regressions. | Keep the zero-debt lint gate in CI and capture deployed browser smoke before G5 sign-off |

## Provider And Channel Matrix

Canonical, source-derived ground truth is
`docs/source-provider-channel-matrix.md` (one row per channel type, resolved
through `ChannelType2APIType` -> `GetAdaptor`). The family table below is a
cutover-planning view; where it disagrees with the canonical matrix, the
canonical matrix wins.

Correction (2026-06-25): an earlier revision of this table over-broadened the
"OpenAI-compatible" family and double-listed channel types 22, 23, 45, 46, 47
across families. Only channel types served by the generic `openai.Adaptor`
(1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47) are truly OpenAI-compatible at the code
level. Types 16, 25, 27, 35, 40, 42-46, 48, 53 have dedicated Go adapters and
need their own Rust adapters/fixtures even when OpenAI-shaped. Two source-level
findings also apply: channel type 21 (AIProxyLibrary) returns a nil adapter in
Go and must stay Unsupported/Deferred; channel type 25 (Moonshot) bridges to the
Claude API and is not plain OpenAI-compatible.

Source channel constants currently span OpenAI-compatible text, native
provider APIs, rerank, task/media providers, deployments, and special
subscription-backed credentials. Rust production should cut over by provider
family rather than by channel number alone. Each provider family must have a
G3 adapter report before canary, as defined in
`docs/route-provider-parity-runbook.md`.

| Provider Family | Source Channel Types | Rust Status | Required Evidence |
| --- | --- | --- | --- |
| OpenAI-compatible (generic `openai.Adaptor`) | 1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47 | Partial | URL mapping, header mapping, model mapping, usage parser, error mapping, live smoke per first-canary provider. Correction: the prior "12 first-party OpenAI-compatible" Rust filter incorrectly included dedicated-adapter types — Zhipu (16), Perplexity (27), SiliconFlow (40), Mistral (42), DeepSeek (43), MokaAI (44), xAI (48), Submodel (53) — and Moonshot (25), which bridges to the Claude API. Those are OpenAI-shaped but have their own Go adapters and must each get a Rust adapter + fixtures; they are not covered by the generic OpenAI-compatible path. Channel type 21 (AIProxyLibrary) returns a nil adapter in Go and stays Unsupported. See `docs/source-provider-channel-matrix.md`. |
| Dedicated OpenAI-like text adapters | 27, 40, 42, 43, 44, 48, 53; 25 (Moonshot, Claude+OpenAI bridge) | Planned | Each has its own Go adapter; needs Rust adapter, URL/usage/error fixtures, and live smoke. Do not route through the generic OpenAI-compatible filter without parity proof. |
| Anthropic native | 14 | Partial | Live Messages non-stream/SSE smoke, cache token usage parity, error mapping. |
| Gemini native | 24 | Partial | Live generate/stream/embed/batch/count smoke, path alias parity, usageMetadata parity. |
| Jina rerank | 38 | Partial | Live `/v1/rerank` smoke, request estimate, usage parser evidence. |
| Cohere rerank | 34 | Partial | Live `/v1/rerank` smoke, request/response transform parity, billed unit usage evidence. |
| Baidu/Zhipu/Ali/Tencent/Xunfei/360/VolcEngine regional adapters | 15-19, 23, 45, 46 | Planned | Adapter fixtures, auth headers, error normalization, usage parser parity. |
| AWS/Vertex AI/Cloudflare Workers AI | 33, 41 and Cloudflare adapter | Planned | Credential/binding strategy, region/project config, usage parser, live smoke. |
| Ollama/Xinference/self-hosted | 4, 47 | Planned | Network reachability model; Cloudflare Worker may need service fallback or Tunnel. |
| Dify/Coze/FastGPT/application APIs | 22, 37, 49 | Planned | App-specific request/response fixtures and billing semantics. |
| Midjourney/Suno/Kling/Jimeng/Vidu/Sora/Replicate/video task providers | 2, 5, 36, 50-52, 54-56 | Partial: Worker task submit/poll/settle foundation exists for several video providers, with channel-type platform persistence and raw provider task data retained for OpenAI video conversion. Midjourney/Suno remain separate task subsystems and broader provider-specific conversion/replay is not production-proven. | Queue/R2 task architecture, callback/polling idempotency, artifact retention. |
| Codex subscription-backed channel | 57 | Partial | Admin usage + OAuth credential refresh implemented with identity preservation, CAS key replacement, best-effort cache invalidation, bounded HTTPS outbound, proxy-setting rejection, and secret-safe audit. Remaining: Codex relay adapter/live subscription smoke and any non-bounded runtime escape hatch. |

## Data And Table Matrix

Source `model/main.go` auto-migrates the following production-relevant models.
Current Rust D1 coverage is intentionally smaller than the Go schema; do not
cut over non-covered table families until the target schema and import/verify
steps exist. The executable data migration procedure is
`docs/data-migration-runbook.md`.

Field-level parity for the P0 tables (User, Token, Channel, Ability, Option, Log)
against `migrations/d1/0001_core.sql`, `0002_admin_tables.sql`, and
`0004_schema_parity.sql` is in `docs/source-d1-schema-parity.md`. It records the
source-derived defects that `0004` corrects before G2 import: ability tag,
composite uniqueness, priority/weight/tag indexes, the remaining log token-id
index, user OAuth/admin lookup indexes, and token name lookup. The `group` to
`group_name` rename remains an ETL/query mapping rule.

| Source Model/Table Family | Production Criticality | Current Rust Coverage | Required Migration Evidence |
| --- | --- | --- | --- |
| `User` | P0 | Partial D1 core | Row count/hash, quota fields, role/status, group, OAuth IDs, stripe customer, deletion handling. |
| `Token` | P0 | Partial D1 core | Key handling, quota fields, model limits, IP allowlist, token group, expiry/status, cache invalidation. |
| `Channel` | P0 | Partial D1 core | Provider type, base URL, keys, models, groups, status, weight/priority, key encryption/redaction policy. |
| `Ability` | P0 | Partial D1 core | `0004_schema_parity.sql` restores `tag`, composite uniqueness, and priority/weight/tag indexes. Verify dedup before import and map Go `group` to D1 `group_name`. See `docs/source-d1-schema-parity.md`. |
| `Option` | P0 | Partial D1 core | Billing expressions, group ratios, rate limits, feature flags, security/payment settings. |
| `Log` | P0/P1 | Partial relay audit logs | Recent queryable D1 logs plus Queue/R2 archive plan, request/upstream ID preservation. `0002_admin_tables.sql` and `0004_schema_parity.sql` cover the Go search indexes tracked for P0 parity; heavy log search may still move to Analytics Engine/R2 for write-amplification and retention. `channel_id` serializes as JSON `channel`. See `docs/source-d1-schema-parity.md`. |
| `QuotaData` | P1 | Planned | Aggregation import or recomputation strategy, dashboard parity. |
| `Model`, `Vendor`, `PrefillGroup`, `Setup` | P1 | Export-supported, D1/API incomplete | Admin schema, import, operator smoke, frontend display parity. |
| `TopUp`, `Redemption` | P1 | Planned | Payment/accounting import, idempotency, double-credit prevention, refund/replay tests. |
| `SubscriptionPlan`, `SubscriptionOrder`, `UserSubscription`, `SubscriptionPreConsumeRecord` | P1 | Partial billing foundation, schema incomplete | Plan/order/subscription import, settlement ownership decision, shadow billing report. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | P1/P2 | Partial | `TwoFA`/backup-code flows and `passkey_credentials` storage/status/delete are implemented; Passkey finish verification still requires a Worker-safe verifier or forced re-enroll/reset policy. |
| `CustomOAuthProvider`, `UserOAuthBinding` | P1/P2 | Partial: D1 schema/import and root-admin provider config CRUD/discovery implemented | Provider secret migration evidence, login/bind state replay protections, callback origin checks, account-binding smoke, forced rebind option. |
| `Checkin` | P2 | Partial: D1 schema/import support and user status/submit routes implemented with a UTC daily key and unique `(user_id, checkin_date)` guard | Import source history or document reset policy, verify per-user quota deltas, and smoke idempotent duplicate submit behavior on staging. |
| `Midjourney`, `Task` | P2/G7 | Partial: D1 task rows, public/upstream task IDs, channel-type platform, properties/private_data/data JSON, submit/poll status CAS, and OpenAI video status DTO enrichment are implemented for the Worker task path. | Queue/R2 task state, provider polling, billing replay, artifact retention. Submit/poll/settle lifecycle, three billing hooks, CAS idempotency, exact provider-specific DTO conversion, and the Workflows/Queue/R2 mapping in `docs/source-task-lifecycle-parity.md`. |
| `PerfMetric` | P2 | Planned | Decide whether to import historical metrics or start fresh with Workers logs/traces. |

## Environment And Config Inventory

Source: `C:\cinagroup\cinatoken\.env.example` and `constant/env.go` (G0 source
inventory). This closes the G0 "environment inventory" row.

Critical migration note: in cinatoken, **`.env`/`os.Getenv` carries only
deployment-level bootstrap config. The bulk of runtime configuration and almost
all integration secrets (JWT/session secret beyond `SESSION_SECRET`, provider
keys, Stripe/Creem/Waffo/Epay keys and webhook secrets, OAuth client secrets,
Turnstile keys, SMTP, ratios, feature flags) live in the DB `options` table**,
managed from the admin UI. Therefore most config/secret migration is governed by
the `Option` table row (P0) in the Data And Table Matrix, the
`docs/cloudflare-production-config-checklist.md` secret inventory, and the
Secrets Store decision in migration-plan §21.7 — not by env vars alone.

Deployment env vars map to Cloudflare destinations as follows:

| Env Group | Examples (Go) | Cloudflare Destination | Notes |
| --- | --- | --- | --- |
| Server/runtime | `PORT`, `HOSTNAME`, `NODE_TYPE` | Drop | Workers are stateless and multi-region; no port or master/slave node model. |
| Frontend | `FRONTEND_BASE_URL` | Worker `[vars]` | Already present; same-origin Static Assets reduces its role. |
| Debug/profiling | `ENABLE_PPROF`, `DEBUG`, `PYROSCOPE_*` | Drop | Replaced by Workers Logs/Traces/observability. |
| Primary database | `SQL_DSN`, `SQLITE_PATH`, `SQL_MAX_*` | Drop | Replaced by the `DB` D1 binding (+ Sessions API). |
| Log database | `LOG_SQL_DSN`, `ERROR_LOG_ENABLED` | Drop / Worker var | Logs go to Queue->D1 + R2/Analytics Engine. |
| Cache/sync | `REDIS_CONN_STRING`, `MEMORY_CACHE_ENABLED`, `SYNC_FREQUENCY`, `CHANNEL_UPDATE_FREQUENCY`, `BATCH_UPDATE_*` | Replace | Rate limit -> Rate Limiting binding; atomic state -> DO; cache -> KV/D1 read replicas (§21.1/§21.2). The Go memory/sync/batch model does not map to per-isolate Workers. |
| Relay behavior | `RELAY_TIMEOUT`, `RELAY_IDLE_CONN_TIMEOUT`, `STREAMING_TIMEOUT`, `GEMINI_VISION_MAX_IMAGE_NUM`, `MAX_REQUEST_BODY_MB`, `STREAM_SCANNER_MAX_BUFFER_MB`, `FORCE_STREAM_OPTION`, `AZURE_DEFAULT_API_VERSION` | Worker `[vars]` or `[limits]` | Map to relay config; body limits already enforced by bounded readers. |
| Token/media accounting | `GET_MEDIA_TOKEN`, `GET_MEDIA_TOKEN_NOT_STREAM`, `COUNT_TOKEN` | Worker `[vars]` | Tie to billing token-estimation parity. |
| TLS | `TLS_INSECURE_SKIP_VERIFY` | Drop | Worker `fetch` does not expose this; not portable. |
| Security/redirect | `TRUSTED_REDIRECT_DOMAINS` | Worker `[vars]` | Feeds SSRF/redirect validation (`docs/ssrf.md`). |
| Session | `SESSION_SECRET` | Worker secret / Secrets Store | Session cookie signing (`crates/session`). |
| Provider tunables | `COHERE_SAFETY_SETTING`, `DIFY_DEBUG` | Worker `[vars]` | Provider-specific behavior flags. |
| OAuth endpoints | `LINUX_DO_TOKEN_ENDPOINT`, `LINUX_DO_USER_ENDPOINT` | Worker `[vars]` | Non-secret endpoints; client secret is in `options`/Secrets Store. |
| Tasks | `UPDATE_TASK`, `TASK_QUERY_LIMIT`, `TASK_TIMEOUT_MINUTES`, `TASK_PRICE_PATCHES` | Worker `[vars]` / Workflows config | Async task lifecycle moves to Workflows (§21.5). |

Required G0 evidence still pending: real production row counts per table and a
redacted secret-name inventory captured from the production `options` table.

## Cloudflare Binding And Secret Matrix

Current `wrangler.toml` is development-shaped. Production readiness requires
real IDs, deliberate environments, generated types, and out-of-band secrets.

| Binding/Config | Current State | Production Target | Evidence |
| --- | --- | --- | --- |
| Config format | `wrangler.toml` | Prefer `wrangler.jsonc` or documented TOML exception | Config migration PR or exception note. |
| `compatibility_date` | `2026-06-17` | Keep current; review periodically | Date review recorded before deploy. |
| `compatibility_flags` | `nodejs_compat` enabled | Keep enabled | `wrangler types` generated Env after binding changes. |
| Observability | Enabled with `head_sampling_rate = 1` | Staging/prod sampling policy documented | Logs/traces visible in staging. |
| `DB` D1 | Placeholder UUID | Separate staging/prod D1 IDs | Staging migrations applied and `/api/status` D1 true. |
| `CACHE_KV`, `CONFIG_KV` | Placeholder IDs | Real namespaces or remove unused bindings | Binding checklist and code usage decision. |
| `FILE_BUCKET` | Named bucket, no code usage | Real R2 bucket plus retention policy | R2 smoke for upload/read/delete if enabled. |
| `LOG_QUEUE`, `TASK_QUEUE` | Declared producers, no code usage | Real queues with consumers/DLQ when async moves | Queue producer/consumer smoke and DLQ alert. |
| Upstash vars/secrets | Runtime env driven | Separate staging/prod credentials | Secret names, no values, rotation owner. |
| Provider API keys | D1 channel keys | Encrypted/redacted storage policy | Admin key reveal audit and redaction tests. |
| Payment/OAuth/Turnstile/JWT/session secrets | Go/VPS-owned today | Cloudflare secrets or forced re-auth/defer plan | Secret inventory without values. |
| AI Gateway ID | Empty var | Real ID or direct-provider policy | Provider matrix records chosen path. |
| `DISPATCHER` WFP namespace | Commented binding; tenant script control-plane routes implemented | Real dispatch namespace, binding enabled after live deploy smoke | Root-only plan/deploy route evidence plus internal dispatch status smoke. |
| `cinatoken-wfp-tenant` Rust/Wasm runtime | Compile-ready crate under `crates/wfp-tenant`; local artifact uploader wired; live upload not proven | worker-build artifact uploaded to dispatch namespace | `bun run check:wfp-tenant`, `bun run check:wfp-tenant:deploy-plan`, artifact manifest, tenant status smoke shows `runtime: "rust-wasm"`. |
| `CLOUDFLARE_ACCOUNT_ID`, `WFP_DISPATCH_NAMESPACE`, `WFP_TENANT_COMPATIBILITY_DATE` | Empty/default vars | Real account/namespace/date in staging/prod | Redacted plan response shows deployable metadata. |
| `CLOUDFLARE_API_TOKEN` | Secret-only; not in config | Scoped secret for dispatch script deploy and tenant AI Gateway runtime | Secret inventory, deploy 2xx, rotation owner. |

Detailed binding and secret ownership is tracked in
`docs/cloudflare-production-config-checklist.md`.

## Billing And Quota Matrix

Billing is a cutover blocker. Rust can relay traffic before it owns paid
settlement only if shadow mode proves deltas. The executable parity and shadow
settlement procedure is `docs/billing-parity-runbook.md`; the source-derived
engine contract and 56-test golden gap map is
`docs/source-billing-expr-parity.md`.

| Billing Area | Rust Status | Required Evidence |
| --- | --- | --- |
| Tiered expression parser/executor | Partial | Golden fixtures across real production expressions. |
| `billing_expr|||request_rule_expr` split | Partial | Go/Rust fixture coverage and metadata redaction evidence. |
| Request-time token estimate | Partial | Go `TokenCountMeta` parity for tokenizer (cl100k+o200k), OpenAI formatting overhead, model-specific image algorithm, audio duration, and media fallbacks — fully specified in `docs/source-token-estimation-parity.md`. |
| Streaming usage reconciliation | Partial | Live SSE smoke with final usage and refund-on-missing-usage behavior. Final-chunk/audio-second-to-last extraction, `ValidUsage` gate, missing-usage estimate fallback, and stream_options matrix specified in `docs/source-usage-parsing-parity.md`. |
| Non-stream usage reconciliation | Partial | Live JSON smoke for each first-canary provider. Usage parse + `ValidUsage`/estimate fallback per `docs/source-usage-parsing-parity.md`. |
| Reserve/refund/additional settlement | Partial | Success, upstream error, timeout, client disconnect, missing usage tests. |
| Non-tiered billing | Partial (implemented) | Implemented + wired (`crates/billing/src/flat.rs` -> `relay.rs:3200`). Remaining gaps: hardcoded completion-ratio table (defaults to 1.0), cache 5m/1h split, sub-category subtraction, tool surcharge, OtherRatios, `37.5` model-ratio default. See `docs/source-pricing-ratio-parity.md`. |
| Subscription/pre-consume records | Planned | Schema, import, idempotency, replay tests. |
| Payment balance mutations | Planned | Webhook signature validation, idempotent event storage, double-credit prevention. |
| Shadow billing report | Planned | Production-shaped request sample with agreed delta threshold. |

## Observability, Security, And SLO Matrix

Executable G6 evidence is tracked in
`docs/observability-slo-security-runbook.md`.

| Area | Required Production Evidence | Current Status |
| --- | --- | --- |
| Structured logs | Request ID, user/token fingerprint, endpoint, model, channel, upstream status, latency, quota delta, billing mode | Partial |
| Workers Logs/Traces | Staging and prod sampling policy; visible traces during smoke | Partial |
| Sampling/retention | Environment-specific `head_sampling_rate`, trace sampling, and long-term audit retention decision | Planned |
| Alerts | 5xx, D1 failures, Redis failures, queue lag, billing mismatch, payment replay failures, raw secret exposure | Planned |
| Alert drills | At least one staging drill that proves alert source, owner, first action, and rollback action | Planned |
| Redaction and generated randomness | No raw keys, bearer tokens, payment secrets, OAuth secrets, or full provider credentials in logs; generated bearer credentials, payment/order suffixes, and Worker-side bounded random draws avoid `Math.random()` | Partial: admin user access tokens, affiliation codes, balance-pay subscription order suffixes, and relay weighted channel selection are CSPRNG-backed; staging distribution and live route evidence remain required |
| CORS/WAF/rate limits | Environment-specific allowlist and abuse protection | Planned: Turnstile/secure-verification/CORS parity + KV/DO session-state requirement in `docs/source-security-middleware-parity.md` |
| SSRF controls | Any user-controlled URL fetch path is validated | Partial: `crates/ssrf` ported (not yet wired). CIDR-table divergences, DNS-rebinding decision, and wiring gate in `docs/source-ssrf-parity.md` |
| Admin audit | Every sensitive admin mutation writes actor/action/target/request ID | Planned |
| Rollback | DNS/route/feature rollback rehearsed; Rust state preserved for investigation | Planned |
| SLOs | Auth overhead, first-byte overhead, stream duration, D1 write latency, error budget, queue lag, billing delta | Planned |
| Load test | Mixed 500-concurrency or agreed production-shaped equivalent | Planned |

Rollback and reconciliation procedures are tracked in
`docs/cutover-rollback-runbook.md`.

## Performance, Capacity, And Cost Matrix

Executable performance and cost evidence is tracked in
`docs/performance-capacity-cost-runbook.md`. This matrix supports G6, G7, G8,
and G9 decisions.

| Area | Required Production Evidence | Current Status |
| --- | --- | --- |
| Go/VPS baseline | Route/provider/model/stream latency, error rate, and request-count baseline or owner-approved inferred baseline | Planned |
| Traffic mix | Current, staging, and canary traffic mix by route, provider, model, token group, and body-size class | Planned |
| Load profiles | LT-001 through LT-007 for Scenario A; LT-008 before Scenario B; LT-009 before async/task/media cutover | Planned |
| Mixed relay load | 500-concurrency or agreed production-shaped equivalent with JSON and SSE route families | Planned |
| Worker resource limits | CPU, wall time, memory/resource-limit errors, subrequests, and outgoing connection evidence | Planned |
| D1 capacity | Query duration, rows read/written, overloaded/query errors, index coverage, and hot-path row-read bounds | Planned |
| Upstash capacity | Command count, latency, error rate, cache hit ratio, rate-limit denials, and failure-mode behavior | Planned |
| Queue/R2 capacity | Queue backlog, retry/DLQ count, batch size, R2 operation count, artifact size, and retention policy | Planned |
| Log/analytics cost | Workers Logs sampling, Logpush/Analytics Engine decision, retention path, and estimated monthly volume | Planned |
| Cost forecast | Approved current, 2x, 5x, and incident-spike forecast across Worker, D1, Upstash, logs, Queue, R2, and providers | Planned |
| Bottleneck ownership | Top bottlenecks have owner, mitigation, rollback path, and re-test profile | Planned |

## Update Rules

1. Update this file when adding a route, provider, table, binding, or billing
   behavior.
2. Keep status conservative: `Partial` is the default until live evidence
   exists.
3. Add links to smoke logs or verification docs instead of pasting secrets or
   raw provider responses.
4. Never store production export bundles, API keys, channel keys, OAuth
   secrets, payment secrets, or raw bearer tokens in this repository.
5. If a billing expression implementation changes, first read
   `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md` and add Go/Rust parity
   evidence before updating production status.
