# Phase 1 Notes

This phase creates the Rust workspace and a Cloudflare Worker MVP.

## Implemented

- Workspace crate layout.
- Worker route entrypoint.
- `GET /api/status`.
- `GET /v1/models`, `GET /v1/models/:model`, `GET /v1beta/models`, and
  `GET /v1beta/openai/models` token-authenticated model compatibility
  endpoints backed by D1 `abilities` and token `model_limits`.
- `POST /v1/chat/completions` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/completions` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/responses` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/embeddings` non-stream OpenAI-compatible relay MVP.
- `POST /v1/rerank` non-stream rerank JSON relay MVP for Jina channel type
  `38` and Cohere channel type `34`, including Go-compatible
  `query`/`documents` request validation and Cohere request/response
  adaptation.
- `POST /v1/images/generations` OpenAI-compatible relay MVP, including
  streaming passthrough for `stream: true`.
- `POST /v1/audio/speech` OpenAI-compatible relay MVP for JSON request
  passthrough and unparsed audio/SSE response passthrough.
- `POST /v1/messages` native Anthropic Messages relay MVP for native Anthropic
  channel type `14`, including streaming passthrough for `stream: true`.
- `POST /v1beta/models/{model}:generateContent` and
  `POST /v1beta/models/{model}:streamGenerateContent` native Gemini relay MVP
  for native Gemini channel type `24`, with `/v1/...` aliases.
- `POST /v1beta/models/{model}:embedContent` and
  `POST /v1beta/models/{model}:batchEmbedContents` native Gemini embedding
  relay MVP for native Gemini channel type `24`, with `/v1/...` aliases.
- `POST /v1beta/models/{model}:countTokens` native Gemini token-count relay
  MVP for native Gemini channel type `24`, with `/v1/...` aliases.
- D1 token authentication with status, expiry, quota-presence, model-limit, and IP allowlist checks.
- Best-effort D1 token status update for expired and exhausted tokens.
- D1 channel selection for OpenAI-compatible provider types.
- D1 channel selection can now filter by endpoint provider family, including
  rerank-only selection for `/v1/rerank`, Anthropic-only selection for
  `/v1/messages`, and Gemini-only selection for native Gemini generate-content,
  embedding, and token-count endpoints.
- Ability-first channel selection with channel CSV fallback.
- Relay weighted channel selection now uses a Worker CSPRNG-backed
  `random_u64_below()` helper with rejection sampling, preserving the existing
  Go-compatible priority/weight selector while removing the final direct
  `Math.random()` Worker runtime dependency.
- Model mapping before upstream forwarding.
- Token access update, user request-count update, and zero-quota consume audit logs.
- Streaming chat completion, completion, response, image generation, and
  Anthropic Messages passthrough with pending zero-quota stream audit logs.
- Pure Rust relay helper tests for model mapping, IP allowlists, key
  selection, JSON/SSE usage parsing, and URL normalization.
- OpenAI-compatible JSON/SSE usage parsing extracts cached/cache-creation,
  Anthropic cache, GPT image generation output image tokens, and image/audio
  input/output token details for billing settlement.
- Native Gemini JSON/SSE usage parsing extracts `usageMetadata`, `countTokens`
  totals, cached content, and image/audio token details for billing settlement.
- Pure Rust billing primitives for quota rounding, price conversion,
  expression version parsing, Go-compatible expression hashing, compile-style
  metadata validation, variable detection, tiered token normalization, and
  pre-consume settlement deltas.
- Pure Rust billing expression execution foundation with `tier()`,
  conditionals, math helpers, request `param()`/`header()` probes, `has()`,
  time helpers, multimodal variables, trace capture, and `|||` request-rule
  multiplier handling.
- Pure Rust tiered billing snapshot and settlement helpers that freeze
  pre-consume expression state including expression hash, apply group ratio,
  detect tier crossing, and compute final/refund/additional quota deltas.
- Shared storage-layer record types for authenticated tokens, relay channels, and relay audit logs.
- Worker-side D1 repository boundary for auth, channel selection, token updates, user counters, and relay audit logs.
- Worker-side D1 billing option lookup and non-streaming tiered-expression
  shadow settlement metadata in audit logs.
- Worker-side request-time tiered-expression preflight snapshots with
  prompt/completion token estimates, visible request-body media fallback
  counts, expression-variable-aware `img`/`ai` normalization, frozen request
  probes, and post-response settlement against the frozen snapshot.
- Worker-side tiered-expression settlement rebuilds actual token parameters
  from upstream usage details and the frozen expression's variable usage, so
  cached/image/audio sub-categories are not double-counted in `p` or `c`.
- Cached-auth quota-state refresh plus request-time D1 reserve, failed-request
  refund, and post-response delta settlement for successful tiered-expression
  responses, including streaming chat, completions, responses, image
  generations, Anthropic Messages, and native Gemini after full-stream usage
  reconciliation.
- Worker-side tiered billing metadata now marks whether a frozen expression
  carried a request-rule multiplier without logging the full rule body.
- Successful Worker-side tiered-expression audit logs now include Go-compatible
  top-level usage-log display fields: `billing_mode`, base-expression
  `expr_b64`, and `matched_tier`.
- Worker-side streaming usage reconciliation for chat, completions, responses,
  image generations, Anthropic Messages, and native Gemini passthrough via
  response tee, incremental SSE usage parsing, and `wait_until` audit
  recording.
- Worker-side non-stream relay audit now uses a cloned upstream response branch
  in `wait_until` when a Worker `Context` is available, so the client path can
  return the original upstream response stream without buffering it first.
- Worker-side non-stream relay endpoints can opt out of response-body usage
  parsing, used by audio speech to preserve binary/audio-event passthrough.
- Worker-side non-stream JSON response usage parsing and Cohere rerank
  transformation now use bounded response-body reads with endpoint-specific
  defaults and an optional `RELAY_JSON_RESPONSE_LIMIT_BYTES` global override.
- Worker relay endpoint metadata now carries an explicit JSON request-body
  mode; the JSON preparation stage owns bounded byte reads, validation, and
  the billing request-input snapshot for current relay endpoints.
- Relay request-body reading now has a shared bounded byte reader underneath
  the JSON parser, so future raw and multipart modes can reuse the same
  content-length precheck and stream over-limit guardrails.
- JSON relay mode now preflights explicit request `Content-Type` values and
  rejects non-JSON bodies before buffering; absent `Content-Type` still falls
  through to JSON parsing for client compatibility.
- The `Content-Type` preflight is now a reusable policy layer with tested JSON,
  multipart, and raw passthrough policies; current endpoints still bind only
  JSON mode.
- Multipart, raw-bytes, and pass-through stream request-body modes now have
  explicit metadata plus guarded 501 handling if selected before their
  extraction/forwarding implementation is complete.
- First Go/Rust billing parity fixtures for multi-condition expressions,
  Claude tier boundaries, cache split pricing, `len` tiering,
  ratio-equivalent quota conversion, nested/array/missing request probes,
  request-rule multipliers, common frontend time zones, math helpers,
  multimodal variables, and used-variable detection.
- Cache traits for string KV, expiring counters, and rate limiting.
- Upstash Redis REST client abstraction with Worker fetch transport.
- Runtime status feature detection for D1 and Upstash Redis configuration.
- Optional Upstash-backed relay token/IP rate limiting.
- Relay cache key helpers, versioned token/channel cache record wrappers, and
  Upstash-backed read-through caching.
- Relay channel cache keys include endpoint provider family to avoid
  cross-provider channel reuse for the same group/model.
- Migration CLI `dev-seed` command for local D1 seed SQL.
- Initial D1 schema for users, tokens, channels, abilities, options, and logs.
- `wrangler.toml` now carries explicit `[env.staging]` and
  `[env.production]` blocks with placeholder resource IDs and environment-
  scoped observability sampling, ready for the first real staging deploy once
  the placeholders are replaced.
- OpenAI-compatible channel selection now recognizes 12 providers: OpenAI(1),
  Zhipu(16), OpenRouter(20), Moonshot(25), Perplexity(27), LingYiWanWu(31),
  SiliconFlow(40), Mistral(42), DeepSeek(43), MokaAI(44), xAI(48),
  Submodel(53). `default_base_url` returns each provider's documented upstream
  root, and `upstream_v1_url` honors any trailing `/v<digit>` segment
  (including Zhipu's `/v4`) instead of always appending `/v1`.
- Relay now walks the full ordered channel candidate list and retries against
  the next candidate when the upstream returns a Go-default retryable status
  (excluding 504/524) or fetch fails. `RELAY_RETRY_TIMES` (default 0) controls
  the budget. Tiered reserve is applied once before the loop and refunded only
  when every attempt fails.
- Best-effort channel auto-disable: channels returning 401 are disabled
  immediately via `disable_channel_best_effort`, and a 60s rolling Upstash
  Redis error counter auto-disables channels exceeding
  `RELAY_CHANNEL_AUTOBAN_THRESHOLD` (default 5).
- `crates/ssrf` ports the Go gateway's `common/ssrf_protection.go` validation
  surface (HTTP/HTTPS only, port allowlist, private/loopback/metadata IPv4
  and IPv6 CIDR table, domain and IP CIDR allow/block lists) behind a
  `SsrfPolicy`/`SsrfPolicyBuilder` API, with full Go-parity unit coverage.
  Standalone for now; see `docs/ssrf.md` for the boundary.
- D1 `migrations/d1/0002_admin_tables.sql` adds the `vendors` and `models`
  admin tables and the `logs` indexes that back admin log/stat queries.
- Model metadata management now includes default-frontend list/detail
  enrichment for `bound_channels`, `enable_groups`, `quota_types`,
  `matched_models`, `matched_count`, endpoint backfill, `vendor_counts`, and
  server-side `status` / `sync_official` filters. The enrichment reuses the
  pricing-row context and D1 batch channel lookups instead of per-row queries.
- `crates/session` implements the stateless HMAC-signed session cookie codec
  (base64url JSON payload + HMAC-SHA256 signature). 11 unit tests cover
  round-trip, tamper/expiry rejection, secret-length enforcement, and legacy
  Rust cookie parsing without `iat`. Cookie name is `session` and attributes
  are `HttpOnly; SameSite=Strict; Secure`, matching the React dashboard's
  expectations.
- Operational dashboard compatibility (`crates/worker/src/operations.rs`):
  `GET /api/uptime/status` reads Uptime Kuma group options and performs
  bounded outbound JSON fetches with timeout/body limits and SSRF guardrails;
  `GET /api/perf-metrics/summary` and `GET /api/perf-metrics` aggregate D1
  `logs` into the frontend's model-performance schema; root-only
  `/api/performance/*` routes return explicit Worker-native no-op responses
  for local disk/GC maintenance while preserving admin audit logs.
- Upstream ratio sync compatibility (`crates/worker/src/ratio_sync.rs`):
  root-only `GET /api/ratio_sync/channels` and `POST /api/ratio_sync/fetch`
  now back the default frontend's price-sync dialog. The Worker lists D1
  channels plus the Go-compatible official and models.dev presets, fetches
  selected upstream pricing with timeout/body limits, converts OpenRouter
  `/v1/models`, models.dev `/api.json`, ratio-config envelopes, and
  `/api/pricing` rows into the local sync schema, compares against effective
  default-plus-option ratio maps, and returns the frontend's
  `differences`/`test_results` contract without exposing upstream keys.
- Custom OAuth provider admin compatibility
  (`crates/worker/src/admin_custom_oauth.rs`): root-only provider
  list/get/create/update/delete plus discovery fetch are implemented at the
  default frontend paths. Migration 0010 adds `custom_oauth_providers` and
  `user_oauth_bindings`, the migration CLI can import both tables, responses
  never include `client_secret`, discovery is SSRF/timeout/body-limit guarded,
  and `/api/status` exposes enabled provider metadata for the login page. The
  generic `GET /api/oauth/:provider` callback now supports enabled custom
  providers by slug or numeric id, including backend-initiated bind redirects,
  browser-bound single-use OAuth state, token exchange with params/basic auth
  styles, bounded SSRF-guarded token/userinfo fetches, configured userinfo
  field extraction, access-policy enforcement, D1 binding conflict checks, JSON
  login/bind responses for the default frontend, and secret-safe bind audit.
  Remaining evidence is real-provider staging replay plus redirect-origin and
  access-policy smoke, not route ownership.
- Async usage-log read compatibility (`crates/worker/src/admin_task_logs.rs`):
  `GET /api/mj`, `GET /api/mj/self`, `GET /api/task`, and
  `GET /api/task/self` list D1 Midjourney/unified task rows with Go-compatible
  pagination and filters. Self routes force the session user scope, task self
  responses hide `channel_id`, and Midjourney `submit_time`/`finish_time`
  writes preserve millisecond values to match Go/frontend filters.
- User daily check-in compatibility (`crates/worker/src/admin_checkin.rs`):
  `GET /api/user/checkin` and `POST /api/user/checkin` use D1
  `checkins` rows plus `checkin_setting.*` options, expose
  `checkin_enabled` through `/api/status`, enforce one check-in per user per
  UTC day with a unique D1 guard, increment quota with rollback on failure,
  write best-effort system logs, and run Turnstile on submit when configured.
  Migration `0011_checkins.sql` and the migration CLI import table set now
  include `checkins`.
- Admin redemption-code compatibility (`crates/worker/src/admin_redemption.rs`):
  `GET/POST/PUT /api/redemption`, `GET /api/redemption/search`,
  `GET/DELETE /api/redemption/:id`, and
  `DELETE /api/redemption/invalid` are D1-backed with Go-compatible
  pagination, id/name-prefix search, create bounds, payment-compliance guard,
  status-only updates, soft delete, admin audit, and the default frontend
  response shapes. Migration `0012_redemptions.sql` and the migration CLI
  import table set now include `redemptions`; public redemption/top-up payment
  flows remain deferred.
- Public rankings compatibility (`crates/worker/src/rankings_api.rs`):
  `GET /api/rankings` now honors `HeaderNavModules.rankings`, including the
  legacy boolean/string enabled form and `requireAuth`. The response preserves
  the default frontend snapshot shape: model/vendor leaderboards, movers,
  droppers, model history, and vendor share history. Go reads a background
  `quota_data` table; the Worker computes the same public view from live D1
  `logs`, matching the Rust dashboard trend strategy. The status endpoint no
  longer hard-hides the rankings header module.
- The D1 repository log filters were corrected to match the current D1 schema
  and Go `model.Log`: `logs` is not a soft-delete table, so live log analytics
  no longer add `deleted_at IS NULL` to `logs` queries.
- `crates/auth` gained bcrypt password helpers (Go-compatible PHB format),
  role/status constants, and `is_admin`/`is_root`/`outranks` helpers.
- Worker admin auth surface (`crates/worker/src/admin.rs`): `POST
  /api/user/login`, `POST /api/user/logout`, `GET /api/user/self`,
  `GET /api/setup`, `POST /api/setup`, plus `require_user_auth` /
  `require_admin_auth` / `require_root_auth` middleware helpers for the next
  G5 batch. Session guards now re-fetch live D1 user role/status/group, and the
  fixed GitHub/Discord/OIDC OAuth callbacks require browser-bound single-use
  state before token exchange. Migration `0017_user_session_epoch.sql` adds
  `users.session_epoch`; signed Rust cookies now carry `iat`, and auth rejects
  cookies older than the live epoch so password changes and admin
  disable/delete/role changes revoke stale browser sessions.
- `GET /api/status` reports `session_auth: true` when `SESSION_SECRET` is
  configured.
- Frontend deploy pipeline: `wrangler.toml` `[assets]` block + Worker SPA
  fallback (`is_static_asset_path` + `env.assets("ASSETS")`) + `build:web` /
  `build:all` scripts. Same-origin deployment keeps the React dashboard's
  cookie auth working without frontend changes.
- Frontend route audit broadening: `tools/audit_frontend_routes.mjs` now
  resolves imported constant endpoint objects, SSE constructors, navigation
  calls/assignments, and API-prefixed JSX `href`/`src` attributes. The
  reviewed baseline covers 215 Worker-facing frontend routes with 0 missing
  calls, and the frontend task-log video content link is Worker-owned through
  the token-or-session-owner-scoped `/v1/videos/:task_id/content` route.
- OpenAI-compatible video create/fetch shell: `POST /v1/videos` now reuses the
  Worker task submit orchestration but returns an OpenAI video `queued` object,
  while `GET /v1/videos/:task_id` returns a token-owner-scoped DB-backed video
  status object with Go-compatible status/progress mapping, origin-model
  fallback, `metadata.url`, and failure error details. Task inserts now persist
  Go-style `properties` plus raw provider `data` from submit/poll responses;
  video fetch enriches from that stored data for Sora/OpenAI passthrough fields,
  common provider video URL shapes, nested first-video arrays, and provider
  error messages while preserving local task `created_at` for non-Sora data.
  The no-extra-I/O portions of provider-specific `ConvertToOpenAIVideo` are now
  ported for Ali status/error mapping, Doubao/Kling/Vidu/Jimeng/Hailuo error
  shapes, Kling provider time/seconds fields, Doubao legacy `task_id`, and
  Gemini/Vertex Veo model extraction from encoded upstream operation names.
  `GET /v1/videos/:task_id/content` now serves completed,
  token-or-session-owner-scoped tasks from stored result/provider URLs or
  bounded `data:` URLs with SSRF validation, redirect-follow disabled, and
  streaming upstream response passthrough. `POST /v1/videos/:video_id/remix`
  now resolves the owner's origin task, locks the submit to the origin
  channel, forwards to the stored upstream Sora/OpenAI video id, and derives
  remix billing ratios from origin task data.
- Admin CRUD P0 surface (`crates/worker/src/admin_crud.rs`): admin + self log
  list/stat/delete, root-only option list/update with sensitive-key
  filtering, and user-scoped token CRUD with key masking, ownership
  enforcement, `ct-`-prefixed random key generation, and cache invalidation
  after every mutation.
- Cache invalidation module (`crates/worker/src/cache_invalidation.rs`):
  Upstash SCAN + DEL pattern-based invalidation for token/channel/option
  caches, called by admin mutations; falls back to TTL on Redis errors.
- Channel admin Tier 1 CRUD (`crates/worker/src/admin_channel.rs`):
  list/search/get/create/update/delete/batch-delete/fix-abilities. Every
  write keeps `abilities` in sync and invalidates the relay channel cache.
  Create is single-mode only (batch/multi_to_single deferred). List/get
  never expose the upstream key.
- User admin CRUD (`crates/worker/src/admin_user.rs`): list/search/get/
  create/edit/delete + `POST /api/user/manage` 8-action switch
  (disable/enable/delete/promote/demote/quota add/subtract/override).
  Permission tiers match Go; quota mutations are atomic SQL; DELETE is soft
  delete with token cache invalidation. Generated user access tokens and
  affiliation codes now use the Worker CSPRNG through `getrandom` with
  base62 rejection sampling instead of `Math.random()`.
- Non-tiered billing (`crates/billing/src/flat.rs` + `pricing.rs`): models
  without a `tiered_expr` but with a `ModelRatio`/`ModelPrice` option now
  charge quota via the per-token or fixed-price formula, wired into
  `record_relay_audit`. OpenAI-vs-Anthropic cache semantics, zero-usage
  guard, and the `quota <= 0 → 1` floor all match Go.
- Tokenizer crate (`crates/tokenizer`): char-class estimator (OpenAI /
  Claude / Gemini family weights) used by the tiered preflight for prompt
  sizing. Settlement still uses provider-reported usage.
- Subscription core (`crates/worker/src/admin_subscription.rs` +
  `migrations/d1/0013_subscriptions.sql`): D1-compatible subscription plans,
  Go-compatible subscription orders, user subscriptions, and pre-consume
  idempotency records; admin plan CRUD; admin user-subscription
  list/bind/invalidate/delete; self subscription summary and billing
  preference persistence; balance-pay purchase with quota debit, order record,
  plan duration/reset calculation, and group upgrade/downgrade parity.
  Stripe subscription checkout is implemented at
  `POST /api/subscription/stripe/pay`, creating a pending
  `subscription_orders` row before calling Stripe Checkout, returning the
  frontend `pay_link`, and settling `checkout.session.completed` /
  `checkout.session.expired` through the shared Stripe webhook before falling
  back to wallet topups. Creem subscription checkout is implemented at
  `POST /api/subscription/creem/pay`, creating the pending subscription order
  before calling Creem Checkout and settling signature-valid
  `checkout.completed` + paid events through the shared subscription D1 batch
  before falling back to wallet topups. Epay subscription checkout is
  implemented at `POST /api/subscription/epay/pay`, returning the signed
  Go-compatible Epay form and settling `GET/POST
  /api/subscription/epay/notify` plus `GET/POST
  /api/subscription/epay/return` through the shared subscription D1 batch.
  Waffo Pancake subscription checkout is implemented at
  `POST /api/subscription/waffo-pancake/pay`, creating the pending
  subscription order before authenticated Pancake checkout creation and
  settling signed `order.completed` events through the shared
  `/api/waffo-pancake/webhook/:env` handler.
- Wallet/topup compatibility (`crates/worker/src/admin_payment.rs`): Stripe
  amount estimation, frontend-compatible Stripe `pay_link`, wallet
  `topup/info`, self/admin topup history pagination with Go's 30-day self
  window, string status mapping, admin manual completion for pending Stripe
  rows, and `/api/user/self` affiliation fields consumed by the wallet rewards
  card. Public redemption-code topup now uses D1-backed, compliance-gated
  `POST /api/user/topup` with a durable `redemptions.credited` idempotency
  anchor and topup log rows. Legacy online/Epay-style amount estimation is
  implemented at `POST /api/user/amount` with Go-compatible `MinTopUp`,
  `Price`, `QuotaPerUnit`, `TopupGroupRatio`, token-display, and
  `payment_setting.amount_discount` formula parity. Epay wallet checkout is
  implemented at `POST /api/user/pay` with Go SDK-compatible MD5-signed form
  parameters, CSPRNG `USR{id}NO...` order IDs, `PayMethods` allowlist checks,
  `CustomCallbackAddress`/`FRONTEND_BASE_URL` callback resolution, D1
  `topups.payment_provider`, and `GET/POST /api/user/epay/notify` callback
  settlement through the existing credited-anchor atomic topup credit path.
  The callback requires bounded POST bodies, constant-time signature comparison,
  provider/money replay checks, and complete/credit/mark batch verification
  before ACKing a first-time settlement.
  Waffo Pancake amount estimation is implemented at
  `POST /api/user/waffo-pancake/amount` with the Go direct-minimum and
  token-display/unit-price formula. Waffo Pancake admin
  config save is implemented at `POST /api/option/waffo-pancake/save` with
  root-only auth, option-cache invalidation, redacted audit details, and the Go
  "blank private key keeps current key" behavior. Waffo Pancake admin catalog
  reads are implemented at `POST /api/option/waffo-pancake/catalog` and
  `POST /api/option/waffo-pancake/subscription-product-options` with root-only
  auth, Go-compatible credential fallback, signed GraphQL requests, timeout and
  response-size limits, and active onetime-product filtering. Waffo Pancake
  external resource helpers are implemented at
  `POST /api/option/waffo-pancake/pair` and
  `POST /api/option/waffo-pancake/subscription-product` with root-only auth,
  signed REST actions, deterministic SDK-style idempotency keys,
  orphan-store surfacing, Go-compatible Waffo admin frontend envelopes, and
  redacted admin audit. Waffo Pancake wallet checkout is implemented at
  `POST /api/user/waffo-pancake/pay`, creating the D1 pending topup before
  signed authenticated checkout creation and using Go-compatible
  `WAFFO_PANCAKE-{user}-{millis}-{rand}` order IDs, buyer identity
  `cinatoken-user-{id}`, price snapshots, token-fragment checkout URLs, and
  token-display quota normalization. `POST /api/waffo-pancake/webhook/:env`
  verifies `X-Waffo-Signature` with RSA-SHA256/PKCS#1 v1.5 over
  `timestamp.payload`, enforces the test/prod route env, checks local order
  provider, buyer identity, and amount before crediting through the
  provider-aware D1 credited-anchor batch. Creem wallet checkout is implemented
  at `POST /api/user/creem/pay`, using configured `CreemProducts`, D1 pending
  topups, Go-compatible `ref_` SHA1 order IDs, and bounded outbound checkout
  creation against the production/test Creem API. `POST /api/creem/webhook`
  verifies the `creem-signature` HMAC-SHA256 raw-body signature, accepts only
  `checkout.completed` + paid + onetime wallet events, checks amount/provider
  replay conditions, credits through the provider-aware D1 credited-anchor
  batch, records `payment_events`, and backfills an empty user email from the
  verified Creem customer payload. Legacy Waffo wallet checkout is implemented
  at `POST /api/user/waffo/pay`, using the Go-compatible
  `WAFFO-{user}-{UnixMilli}-{rand6}` order shape, Waffo sandbox/prod
  credential selection, RSA-SHA256/PKCS#1 v1.5 request signing, bounded
  outbound order creation, default Card/Apple Pay/Google Pay method parsing,
  `QuotaPerUnit` token-display normalization, and D1 pending topups before the
  provider call. `POST /api/waffo/webhook` verifies the raw-body
  `X-SIGNATURE` with the configured Waffo public cert before any write, credits
  only `PAYMENT_NOTIFICATION` + `PAY_SUCCESS` wallet events with matching
  provider and amount, signs the Go-compatible `{"message":"success"}` /
  `{"message":"failed"}` response body, records `payment_events`, and treats
  duplicate successful deliveries as replay no-ops only when the local topup is
  already success+credited with matching provider/method/money. Wallet
  `topup/info` now exposes Waffo only when payment compliance and active-mode
  Waffo credentials are complete, exposes Waffo Pancake only when compliance
  and merchant/private/product settings are complete, and exposes Creem
  products only when compliance, API key, products, and webhook secret are all
  configured. Creem subscription checkout is now also exposed when the selected
  plan has a Creem product id and Creem payment settings are complete. Epay
  subscription checkout is now exposed when payment compliance, Epay config,
  and a configured pay method are present. Waffo Pancake subscription checkout
  is now exposed when payment compliance, Pancake merchant credentials, and the
  selected plan product id are present. Remaining production exposure is gated
  by provider-specific staging replay and reconciliation evidence. Subscription
  balance-pay order IDs now preserve the Go-visible
  `SUBBALUSR{id}NO{digits}{millis}` shape while using Worker CSPRNG digits
  instead of `Math.random()`.

## Next

- Keep `docs/production-migration-execution-plan.md` current as the production
  gate source of truth for platform, data, relay, billing, observability,
  security, canary, and rollback readiness.
- Keep `docs/production-readiness-matrices.md` and
  `docs/staging-smoke-runbook.md` current as production evidence and live smoke
  requirements become more concrete.
- Use `docs/cloudflare-production-config-checklist.md` and
  `docs/cutover-rollback-runbook.md` as the production config and traffic
  cutover control documents before any customer canary.
- Use `docs/data-migration-runbook.md` for production-shaped source inventory,
  D1 import verification, row-count/sample-hash checks, and rollback evidence.
- Use `docs/billing-parity-runbook.md` for expression parity, shadow settlement
  thresholds, and paid settlement go/no-go evidence.
- Use `docs/route-provider-parity-runbook.md` for G3 route/provider body
  modes, adapter evidence, JSON/SSE smoke, failure-mode smoke, and rollback
  choices.
- Use `docs/observability-slo-security-runbook.md` for G6 log schema,
  sampling, alert drills, SLO thresholds, redaction, and security go/no-go
  evidence.
- Use `docs/admin-frontend-parity-runbook.md` for G5 admin/frontend/auth
  parity, operator CRUD smoke, cache invalidation, admin audit, and frontend
  deployment evidence before Scenario B.
- Use `docs/performance-capacity-cost-runbook.md` for load profiles, D1/
  Upstash/Queue/R2 capacity checks, Worker resource-limit evidence, and
  1x/2x/5x cost forecasts before canary expansion or full cutover.
- Continue broadening Go/Rust golden parity tests for billing expression edge
  cases.
- Continue replacing the Worker request-token estimate with Go `TokenCountMeta`
  parity, especially exact tokenizer counts plus image dimension and audio
  duration media counts.
- Continue hardening explicit request-body modes after the first multipart
  upload routes. `/v1/audio/transcriptions`, `/v1/audio/translations`, and
  `/v1/images/edits` now forward bounded multipart bodies; the next steps are
  real-file replay for the non-WAV/WebM audio duration parsers,
  raw/pass-through stream extraction where needed, live upstream smoke, and
  billing shadow evidence.
- Continue the async-video G7 path by adding provider replay fixtures for the
  newly ported OpenAI video serializers/content proxy, Kling official
  text/image submit aliases, Jimeng official aliases, and Sora remix; complete
  artifact retrieval gaps that require provider credentials, capture live
  Jimeng submit/fetch replay, harden billing-settlement evidence, and move
  video artifact retrieval/retention into Queue/R2 before full production
  ownership.
- Capture async-task timeout-sweep staging evidence: the local
  `bun run check:task-refund-batch` replay now covers timeout/provider-failure
  refunds once, legacy imported-row no-refund behavior, and stale-window
  unblock; next seed the same stale video/Suno task rows and provider-failure
  rows in staging D1, prove the Worker cron fails them through CAS, applies the
  CAS-winner refund batch once, skips legacy imported-row refunds, and
  continues polling newer tasks after the stale window is cleared.
- Continue TaskRunner M5b only after M5a staging evidence: the `TASK_RUNNER`
  Durable Object alarm foundation and video/remix/Suno submit-path arming are
  wired default-off. Alarm firing now reuses the shared provider poll and D1 CAS
  settlement path, but live alarm replay, cron-sweeper fallback, rollback, and
  no-double-poll CAS proof remain required before `TASK_RUNNER_DO_ENABLED` can
  be enabled outside a controlled staging replay.
- Continue defining explicit response buffering limits as each broader
  provider-specific transform is added.
- Add provider-specific adapters beyond OpenAI-compatible providers.
- Capture staging distribution/route evidence for relay weighted channel
  selection, including retry, auto-group, affinity, and provider-family filters.
- Capture provider-specific staging replay/reconciliation evidence before
  exposing payment methods broadly in production.
- Capture io.net deployment staging evidence with real credentials: settings
  save/connection test, catalog reads, price estimation, list/detail/log smoke,
  one reversible mutation smoke, and rollback notes.
- Continue Passkey hardening. The default-frontend Passkey route boundary is
  now Worker-owned and route-debt is zero, but register/login/step-up finish
  handlers deliberately fail closed until a Worker-safe WebAuthn verifier or
  service-binding/Container verifier is selected and tested.
- Capture logged-in playground chat completion staging evidence for
  `POST /pg/chat/completions`: non-stream and stream success, group
  override allow/deny, user quota debit, channel quota/audit rows, token-table
  non-mutation for the synthetic playground token, and logout/disabled/quota
  negative cases.
