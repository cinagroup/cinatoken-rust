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
- `POST /v1/embeddings` non-stream OpenAI-compatible relay MVP, including
  route-explicit Jina type `38` support with Go-compatible `encoding_format`
  removal.
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
- Realtime billing now freezes a redacted pre-settlement snapshot, carries the
  full snapshot plus a bounded sensitive-header-filtered request probe only in
  the internal DO connect handoff, attaches a private settlement mutation plan
  with user/token/channel/pre-consumed-quota scope, and includes a default-off
  D1 writer foundation that can apply the existing reserve/refund/final helper
  only when `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED=true`. Persisted DO
  metrics expose redacted write status, quota deltas, and a derived replay-key
  hash. A new D1 `realtime_settlement_replays` marker table can skip duplicate
  replay attempts after an applied marker is recorded. Applied settlements can
  now also produce Go-compatible `logs` audit rows with redacted tiered billing
  metadata, base-expression `expr_b64`, matched tier, replay-key hash, and
  audit attempt/record/error status in DO metrics; the request-rule body,
  request probe values, raw headers, raw payloads, bearer tokens, and Realtime
  protocol API keys remain excluded. The writer now has a D1 batch/CAS
  foundation that applies the replay marker, guarded quota settlement, and
  audit row together, with assertion statements turning guarded-update
  mismatches into a rollback. `bun run
  check:realtime-session:settlement-batch-contract` now replays the SQL shape
  locally against SQLite for applied, duplicate, guarded-update failure,
  audit-failure rollback, refund, and tokenless paths. This is still a
  foundation, not final production settlement. The companion
  `check:realtime-session:settlement-staging-plan` command now emits reviewed
  staging setup/verify/cleanup artifacts and explicitly requires Worker-binding
  apply evidence instead of standalone Wrangler SQL:
  `realtime_session_billing_settlement_compiled` remains false until the batch
  is proven with controlled staging D1 applied, duplicate, failure, rollback,
  and no-double-charge evidence.
- A default-off Worker-binding smoke route now exists at
  `POST /api/platform/realtime/settlement-batch/smoke`, gated by
  `REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED`. `bun run
  check:realtime-session:settlement-binding-smoke-plan` dry-runs the six fixed
  scenarios; live staging still requires an admin cookie, `--confirm-live`, and
  archived D1/capability evidence before any cutover flag can move.
- 2026-07-10 D1 migration discovery correction: the root/default, staging, and
  production Wrangler `DB` bindings now all set
  `migrations_dir = "migrations/d1"`, so they resolve the repository's
  contiguous `0001` through `0020` migration chain. This aligns config only;
  the remote staging and production databases were not migrated or verified in
  this local increment.
- 2026-07-10 local D1 evidence: a real local Wrangler D1 applied all 20/20
  migrations and exposed 26 business tables. The Realtime gateway candidate
  matcher was narrowed so `/api/platform/realtime/settlement-batch/smoke` is
  owned by the platform settlement handler rather than the generic Realtime
  session prefix. The resulting local Worker-binding smoke passed all six fixed
  settlement scenarios and cleanup left zero residual smoke rows. This proves
  the local binding path, not remote staging or production settlement.
- The admin Cloudflare Platform capability now reads the D1 migration ledger,
  requires the exact compiled 20-name set, and exposes count/latest/expected,
  set-match, and readiness fields to the frontend. A live localhost capability
  request returned all D1 migration checks ready. Its first execution also
  exposed and closed a wasm billing-clock panic by using `js_sys::Date` for the
  expression engine's Worker default clock; the rebuilt billing probes passed.
- The Realtime mock upstream replay harness now makes the
  `response-done-usage` scenario seed an isolated tiered billing expression in
  review-only D1 SQL, then requires live/status metrics to contain both the
  redacted billing snapshot and settlement preview before normal mock close.
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
- Workers-native token/IP/route-family admission through environment-scoped
  Rate Limiting bindings, with an explicit legacy Upstash compatibility mode.
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
- Generic OpenAI-compatible channel selection now matches the 14 channel types
  that the Go source dispatches through `openai.Adaptor`: 1, 3, 6-10, 12, 13,
  19, 20, 22, 31, and 47. OpenAI-shaped dedicated channel types remain outside
  that set. Mistral(42), DeepSeek(43), and xAI(48) now have explicit Rust
  adapters and fail-closed route sets; the remaining dedicated types stay
  deferred.
- The Mistral adapter exposes only source-supported chat completions. It ports
  Go's request whitelist, multimodal normalization, 9-character tool-call ID
  remapping, and `max_completion_tokens` precedence. Worker-side IDs use
  Web Crypto-backed CSPRNG entropy and fail before upstream dispatch if a valid
  ID cannot be produced. Mistral embeddings and Responses remain fail-closed
  because their Go adapter methods are unimplemented.
- The xAI adapter covers chat completions, legacy completions, Responses, and
  image generations. It preserves the Go `-search` and
  `grok-3-mini-{high,low}` compatibility transforms, forwards current Responses
  tool payloads unchanged, and allows default-off AI Gateway planning only for
  chat and Responses. Live usage, error, billing, and rollback evidence is
  still required before an xAI canary.
- Mistral chat and xAI chat/Responses have default-off, channel-opt-in AI
  Gateway plans plus same-channel direct fallback that strips only the audited
  provider prefix. Provider transforms, central reserve/settlement, and audit
  still run on the direct path. The same normalization applies when the Gateway
  runtime is unavailable or the planner selects direct; a known prefix that is
  not approved for the selected channel fails closed before provider egress.
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
  reviewed baseline covers 216 Worker-facing frontend routes with 0 missing
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
  D1 import verification, deterministic P0 reconciliation, row-count/sample-hash
  checks, and rollback evidence. The local `reconcile:migration` hard gate now
  covers core counts, logical-key bounds, full canonical hashes, deterministic
  samples, and relationships; it still needs the real frozen source and staging
  target before production data readiness can advance.
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
- Run the now-complete 23/23 deterministic reconciler against a frozen real
  source snapshot and a locally migrated target, then repeat against staging
  D1 and archive the redacted count/hash/sample/domain/relationship manifest.
  Local fixture coverage closes the implementation gap but is not a G2 pass.
- Exercise the completed G5 channel compatibility routes in an authenticated
  staging browser: model discovery, copy-by-id, bounded no-id test, and bounded
  no-id balance refresh. The route auditor now rejects dynamic `/:id` false
  positives and reports 217 frontend calls with zero missing routes; unattended
  all-channel maintenance still belongs in Queue/Workflow orchestration.
- Preserve the new WFP/Realtime boundaries: preview HTTP responses strip the
  three browser side-effect headers, platform Realtime requires AdminAuth, and
  local multi-Worker exactly-one-egress evidence remains distinct from remote
  staging verification.
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
- Continue AI Gateway cross-model fallback from the default-off Rust outer
  model-attempt foundation. It supports OpenAI-compatible chat/Responses and
  schema-gated Anthropic Messages, re-checks token limits, reads the complete
  fallback-model D1 pool, applies per-channel mappings before eligibility,
  rebuilds billing input, swaps tiered reservations only after an executable
  fallback plan exists, and records requested-versus-served model data.
  Keep `RELAY_MODEL_FALLBACK_ENABLED=false` and
  `RELAY_MODEL_FALLBACK_STAGING_VERIFIED=false` until isolated staging proves
  all status/fetch/refund/settlement/audit/stream/rollback cases. Before auto
  tokens are admitted, prove the locally implemented maximum-candidate reserve
  and actual-serving-group settlement against staging D1. The model-prefix
  registry now covers the documented Cloudflare REST provider set, while safe
  same-channel direct fallback is deliberately limited to matching OpenAI,
  Anthropic, DeepSeek, Mistral, Perplexity, and xAI channels. Submodel model IDs
  remain direct-only opaque values and never enter prefix routing. The
  all-fetch-failed path emits a bounded, secret-free Go-compatible
  type-5 attempt ledger through
  `LOG_QUEUE`/D1; prove queue delivery, synchronous fallback, refund ordering,
  and admin-log visibility in staging before production cutover.
  Keep `RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED=false` until an
  independent Messages replay also proves logical/effective schema rejection,
  `401`/`403`/`429` sticky veto, full-D1 channel selection, streaming, billing,
  audit, and rollback; overall cutover waits on both markers.
- Continue TaskRunner M5b only after M5a staging evidence: the `TASK_RUNNER`
  Durable Object and video/remix/Suno submit-path arming remain default-off.
  Its typed poll result now distinguishes terminal settlement from non-terminal
  progress, re-reads D1 after a lost CAS, re-arms progress, retries transient
  failures with bounded `15/30/60s` backoff, and records cron fallback after the
  configurable `TASK_RUNNER_MAX_ALARM_FIRES` horizon (default `20`, max `240`).
  The capability/status/frontend surfaces expose the rearm contract, observed
  terminal state, rearm/failure counts, delay, and fallback reason. Live alarm
  replay, cron-sweeper fallback, rollback, and no-double-poll CAS proof still
  remain required before `TASK_RUNNER_DO_ENABLED` can be enabled outside a
  controlled staging replay.
- Continue Realtime billing from the default-off D1 writer plus replay-marker,
  audit-log, and D1 batch/CAS foundation to production-safe settlement. The
  prior real local Wrangler D1 evidence has 20/20 migrations and 26 business
  tables, while the current SQLite chain has 21 migrations, and
  the local Worker-binding settlement smoke passes 6/6 with zero residual rows
  after cleanup. Migration 0019 and the Durable Object now reserve each
  explicit `response.create` atomically, bind hashed `response.created`
  identities in sequence order, settle out-of-order `response.done` events by
  exact identity, refund terminal failures idempotently, and retain up to 64
  failed settlements behind one bounded-backoff alarm. `/v1/realtime` still
  fails closed unless both its route gate and
  `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED` are on. The local capability
  proves exact migration-ledger match, Worker-safe billing probes, retry
  contract, and write-gate state. Migration 0020 now persists a 600-second
  active-reservation lease before D1 reserve and shares the same alarm across
  lease refunds and settlement retries; transient refund failures remain
  scheduled after settlement retry exhaustion. Migration 0021 scopes response
  binding, settlement, terminal refund, and lease handoff to a generated bridge
  segment, so an old outbound bridge cannot mutate a replacement bridge that
  reuses the same logical session. Legacy attachments without a segment fail
  closed to lease recovery. The 14-case settlement self-test includes reverse
  completion, lease-expiry, stale-generation, and cross-segment isolation
  proofs. Production
  safety still requires
  authenticating Wrangler, refreshing local Wrangler through 0021, applying
  and verifying the same chain on an
  isolated remote staging D1, and archiving staging evidence for
  multi-response, alarm/eviction, disconnect-refund, queue-capacity, and
  Go/Rust reconciliation, plus capability and Worker-binding proof for
  disabled, applied, duplicate,
  guarded-update failure, audit-row failure, rollback, redaction, cleanup, and
  no-double-charge paths before flipping
  `realtime_session_billing_settlement_compiled` or
  `realtime_session_v1_cutover_ready`.
- Realtime attachment restoration now fails closed when a business text or
  binary frame arrives after DO reconstruction but the request-scoped outbound
  upstream bridge no longer exists. The DO emits a metadata-only
  `upstream_unavailable` terminal event and closes the client with 1011 before
  any D1 await, then best-effort refunds session reservations except retry-owned
  work; `ping` and `status` remain available as diagnostic controls. A release
  Rust/Wasm `RealtimeSession` now passes a real local Workerd eviction test with
  SQLite storage: the same hibernatable client socket survives explicit
  eviction, restores its serialized attachment and bridge segment, and advances
  persisted metrics. The remaining higher-risk replay must start with an active
  mock upstream bridge and prove one 1011 terminal event, idempotent
  refund/lease handoff, no replacement provider call, no payload or credential
  disclosure, and successful reconnect with a fresh bridge segment. Deployed
  Cloudflare staging evidence remains mandatory.
- Continue defining explicit response buffering limits as each broader
  provider-specific transform is added.
- Add provider-specific adapters beyond the currently implemented OpenAI,
  Anthropic, direct-only Moonshot OpenAI/Claude bridge, Perplexity Sonar chat,
  direct-only SiliconFlow, Mistral, DeepSeek, xAI, direct-only Submodel,
  Gemini-native, Workers AI, and rerank surfaces.
  SiliconFlow now has local FIM, completions, embeddings, rerank, image,
  response-bound, usage, and fixed-price image-count fixtures; close its G3
  staging evidence before canary. Keep MokaAI Deferred until an official or
  staging-verifiable hosted embeddings contract exists. A Cloudflare Gateway
  prefix or custom-provider possibility does not make a same-channel adapter
  ready without an explicit managed contract.
- Close Moonshot G3 evidence for chat/completions JSON/SSE, embeddings, rerank,
  Anthropic Messages JSON/SSE, coding-plan chat/Messages, Kimi K2.6 temperature
  normalization, nested cached-token usage, unsupported image/fallthrough
  rejection, billing/refunds, disable, and Go rollback. Keep type 25 off AI
  Gateway and WFP until this repository owns an explicit managed provider
  contract and credential lifecycle.
- Close ZhipuV4 G3 evidence for chat JSON/SSE, multimodal base64, embeddings,
  provider-URL image responses, Anthropic Messages JSON/SSE, bounded errors and
  refunds, audit/billing reconciliation, and Go rollback. Inventory every type
  16 channel and migrate it explicitly to type 26 before Rust cutover; do not
  revive the undocumented v3 invoke protocol. Keep type 26 off AI Gateway and
  WFP until a managed custom-provider slug, deploy/readback, and credential
  lifecycle are owned by this repository.
- Close VolcEngine G3 evidence for Ark v3 chat JSON/SSE, embeddings, image
  generations, Responses, coding-plan chat, DeepSeek thinking normalization,
  response bounds, usage, errors/refunds, audit/billing reconciliation, disable,
  and Go rollback. Keep Bot chat, TTS, rerank, image edits, ordinary Messages,
  AI Gateway, and WFP fail-closed until each has an owned route/format/credential
  contract.
- Close BaiduV2 G3 evidence for normal and `-search` chat JSON/SSE, Bearer and
  optional `appid` separation, bounded responses, usage, errors/refunds,
  unsupported-route rejection, audit/billing reconciliation, disable, and Go
  rollback. Do not infer embeddings/image/rerank support from source URL cases
  whose converters are not implemented, and keep AI Gateway/WFP fail-closed.
- Deploy and attach the Rust outbound service `cinatoken-wfp-outbound` to the
  staging dispatch namespace. Store `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` only on
  that service; the tenant must receive only
  `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1` for outbound auth and
  no Cloudflare bearer. Then run the strict WFP upload against replacement
  credentials, capture the official details/settings/content APIs plus a
  positive internal dispatch, and feed all artifacts to
  `tools/verify_wfp_post_upload.mjs`. Archive outbound-policy proof for only
  `POST application/json`, valid JSON up to 4 MiB, the exact account-scoped
  `/ai/run`, `/ai/v1/chat/completions`, `/ai/v1/responses`, and
  `/ai/v1/messages` URLs, header stripping/auth injection, and redirect
  rejection. See Cloudflare's
  [Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
  and [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
  docs. Keep dispatch and paid relay gates off until remote attachment,
  bearer-free tenant readback, live egress, the attachment collector's scoped
  `verified=true`, and authority
  replay/billing race evidence are archived. Production remains **NO-GO**.
  The local read-only attachment collector is now available as
  `bun run check:wfp-outbound:readback-collector` and
  `bun run collect:wfp-outbound:readback`. After credential rotation, run the
  latter with explicit account, namespace, dispatcher, and outbound identities
  plus both confirmation flags. Archive its redacted `verified=true` output
  before any live egress smoke; it fails closed on trusted namespaces, identity
   drift, wrong/missing outbound attachment, account-var mismatch, outbound-token
   ownership drift, forbidden deploy/readback bearers, redirects, malformed API
   envelopes, oversized responses, enabled workers.dev/Preview URLs, and any
   Custom Domain associated with the outbound service. The tracked outbound
   Wrangler config also declares no route. After credential rotation, archive a
   separate account Zone-route inventory because the Domains endpoint does not
   prove route absence.
  The paid-path preflight is now executable through
  `check:wfp-outbound:egress-contract`, `check:wfp-outbound:egress-plan`, and
  `smoke:wfp-outbound-egress`. Live mode is staging-host-pinned and executes one
  fixed, non-streaming, low-token route per invocation through the normal relay
  token boundary. It requires a fixed non-`auto` group, one WFP channel,
  capabilities `relay_retry_times=0`, cross-model fallback off, and readback
  proof that outbound Gateway attempts equal one and tenant Gateway bindings
  are absent. It then requires one exact
  type-2 audit row with the requested worker/channel, resolved billing or
  refund, and no internal/sensitive response headers. Four-route local planning
  is not remote evidence; execute and reconcile each route separately after
  credential rotation.
- Keep `bun run check:do-lifecycle-runtime` in the local release gate. It builds
  the deployable Rust Worker artifact and runs it under Workerd to prove one
  concurrent WFP authority winner, replay rejection after DO eviction,
  tamper/wrong-shard rejection, TaskRunner storage-decode error propagation,
  a successful missing-record alarm no-op, and Realtime client WebSocket plus
  attachment/metrics restoration after eviction. The Realtime binding uses the
  SQLite DO backend to match production migrations. This closes a local runtime
  gap, but does not replace staging eviction/redeploy, active-upstream bridge
  loss, provider-call, D1 billing, alarm retry, latency, throughput, or cleanup
  evidence.
- Treat `smoke:wfp-outbound-egress` output as scoped evidence. A positive live
  result may set only `positiveRelayBillingVerified=true` under
  `verificationScope=positive-relay-billing-audit`; the authority negative
  matrix, replay, exactly-one provider call, and production fields remain false
  until their independent artifacts are collected and reconciled.
- Capture staging distribution/route evidence for relay weighted channel
  selection, including retry, auto-group, affinity, and provider-family filters.
- Capture provider-specific staging replay/reconciliation evidence before
  exposing payment methods broadly in production.
- Capture io.net deployment staging evidence with real credentials: settings
  save/connection test, catalog reads, price estimation, list/detail/log smoke,
  one reversible mutation smoke, and rollback notes.
- Continue Passkey hardening from the Worker-native ES256/RS256 verifier and
  SQLite Durable Object ceremony state. Go Passkey, TOTP, and backup-code rows
  now have byte-exact local import/reconciliation; next capture a production
  source count/hash, remote D1 import, real imported-authenticator login,
  TOTP/backup-code verification, replay/session-isolation, eviction/alarm,
  forced-reset fallback, and rollback evidence.
- Promote the locally verified Playground contract to isolated staging after
  credential rotation. The complete Rust Worker Workerd test now proves login,
  default capability advertisement, user-specific `+:`/`-:` group resolution,
  `GroupGroupRatio` overrides, chat-capable enabled-model filtering, denied
  group override, non-stream and SSE success, user quota debit, request counts,
  and consumption audits. Staging must still archive token-table non-mutation,
  channel quota reconciliation, native rate-limit scoping, logout/disabled/
  quota-exhausted negatives, frontend browser interaction, and rollback.

## 2026-07-13 Realtime Global Recovery Increment

- Added migration 0022 and verified the local D1 chain at 22 migrations, 27
  required tables, 69 incremental columns, and 17 key indexes.
- Added a default-off scheduled global orphan scan with an inclusive 300-second
  settlement deadline, defensive sweep limit 32/max 64, atomic refund reuse,
  failed-row retry deferral, and aggregate sweep status.
- Added an admin-only no-store hashed ledger/policy endpoint outside the generic
  Realtime DO prefix, plus capability-only frontend readiness.
- Release Workerd evidence now passes 11 lifecycle cases, including concurrent
  scheduled refund idempotency and failed-head fairness. SQLite settlement
  evidence passes the exact deadline and delayed-retry race.
- Phase 1 still does not approve production: remote 0022 application,
  authenticated reserve/settlement across DO eviction, current DO owner
  correlation, alerts, billing reconciliation, provider replay, and rollback
  remain required.
## 2026-07-13 Ali Provider Increment

- Ali channel type 17 moved from Deferred to Partial with an explicit
  six-route direct-only allowlist: Chat Completions, legacy Completions,
  Responses, Embeddings, Anthropic Messages, and Rerank.
- URL ownership follows the current DashScope contracts. The obsolete Go
  Responses prefix is not copied; Rust uses `/compatible-mode/v1/responses`.
- Messages defaults to the source-native `qwen`, `deepseek-v4`, `kimi`, `glm`,
  and `minimax-m` model families and retains the bounded
  `ALI_ANTHROPIC_MESSAGES_MODELS` operator override. Other Claude inputs do not
  silently enter the source's Claude-to-OpenAI bridge.
- Rerank request/response conversion is bounded and restricted to
  `gte-rerank-v2`; qwen3 rerank protocols remain Deferred. Malformed 200 responses
  become owned 502 audit/refund outcomes. Image polling and arbitrary provider
  URL downloads remain outside the Worker request path.
- Optional `X-DashScope-Plugin` comes only from printable, at-most-4-KiB
  server-side `channels.other`. Relay cache schema v4 invalidates older cached
  channel rows, and main/fallback/Admin OpenAI SSE paths share one usage-option
  policy while native Messages remains Anthropic-shaped.
- The capability registry now reports 16 Ready, 15 Partial, and 22 Deferred
  channel types. This changes implementation readiness, not the G3 staging or
  production decision; production remains **NO-GO**.

## 2026-07-13 Tencent Hunyuan Direct Adapter Increment

- Tencent channel type 23 moved from Deferred to Partial for one deliberately
  narrow route: direct, non-streaming, text-only Chat Completions.
- The Worker uses the fixed official Hunyuan host and action/version contract,
  parses the source-compatible `appId|secretId|secretKey` credential, and signs
  the exact serialized body with request-local TC3-HMAC-SHA256 headers. appId
  remains compatibility metadata and is neither transmitted nor signed.
- Unsupported OpenAI fields, non-text message parts, streaming, custom base
  URLs, AI Gateway, and WFP are rejected before quota reservation. Provider
  HTTP-200 error envelopes are normalized before retry, affinity, settlement,
  and audit classification; direct and enveloped successes share bounded
  OpenAI response conversion and preserve a bounded provider `Note`.
- Local fixtures cover fixed URL ownership, credential parsing, request shape,
  UTC date/signature stability, response forms, missing usage, error classes,
  readiness projection, and wasm compilation. This does not establish live
  credential health or provider parity.
- The capability registry now reports 16 Ready, 15 Partial, and 22 Deferred
  channel types. Production remains **NO-GO** until rotated-credential staging
  proves TC3 acceptance, skew/error behavior, usage and billing reconciliation,
  disable/recovery, canary, and Go rollback.

## 2026-07-13 Ordinary Relay Durable Billing Increment

- Added migration 0023 with an ordinary HTTP relay reservation ledger and
  aggregate recovery state. The verified local chain is now 23 migrations, 29
  required tables, 105 incremental columns, and 20 key indexes.
- Positive tiered pre-consumption now inserts its reservation row and debits
  user/token quota in one D1 batch. Selected channel/group binding extends the
  lease before fallible response-header processing.
- Settlement and refund are status-CAS D1 batches. Matching replays are no-ops;
  conflicting finalization and settle-vs-refund race winners are distinct.
- Buffered tiered responses attempt settlement synchronously. Streaming usage
  remains a `waitUntil` branch; after lease expiry plus a 300-second grace, the
  default-off cron refunds only unbound reservations and moves bound rows with
  missing final usage to `recovery_required` without changing quota.
- Admin capabilities and the frontend Cloudflare panel expose ledger compiled,
  lease, recovery gate/readiness, grace, and sweep-limit state. The admin-only,
  `no-store` ledger status endpoint exposes only hashed identities and bounded
  recovery metadata. Audit metadata carries the random reservation key and
  final ledger outcome for correlation.
- This is local E3 evidence, not production approval. Migration 0023, cron
  delivery, long-stream lease bounds, accounting reconciliation, alerting,
  fault injection, and rollback remain staging requirements. See
  `docs/relay-billing-reservations.md`.

## 2026-07-13 HTTP SSE Billing Lease Heartbeat Increment

- Selected positive-reserve HTTP SSE now renews its D1 reservation lease while
  the cloned audit stream remains active. The CAS fences reservation key,
  selected channel/group/timestamp, and the exact previous lease generation;
  it does not mutate quota or request count.
- Heartbeat configuration is bounded to 5 seconds through one third of the
  effective lease and uses deterministic +/-10% per-reservation jitter. A D1
  error records a failure and retries within 60 seconds without interrupting
  the client response. Finalized, stale, expired, conflicting, or missing rows
  stop renewal without reviving ownership during settlement grace.
- Capabilities and the React/Bun readiness UI now distinguish compiled renewal,
  explicit/valid heartbeat configuration, deployed staging verification, and
  recovery cutover readiness. All tracked environments keep staging proof and
  recovery false.
- Release Workerd now uses an explicit provider release barrier to prove one
  lease growth before stream completion, zero active request-count mutation,
  one terminal settlement, exact user/token/channel quota, and bounded audit
  evidence. This remains local E3 evidence.
- Next: apply migration 0023 to isolated staging after credential rotation and
  run beyond the original lease with direct/Gateway/WFP transports, disconnect,
  malformed/provider error, D1 failure, rollout/restart, settlement/recovery
  races, write-cost/latency measurement, reconciliation, alerts, and rollback.
  Recovery and production remain **NO-GO** until that evidence is approved.

## 2026-07-14 HTTP SSE Partial Usage Recovery Increment

- Stream chunk errors no longer discard previously parsed usage, text, or tool
  evidence. Settlement receives the accumulated result plus a bounded terminal
  error classification instead of a synthetic zero usage.
- OpenAI Responses deltas now feed the accumulator. Empty Responses remains
  zero usage; output deltas can use the source-compatible estimate path. Chat
  and Completions retain the existing text plus tool-count estimate semantics.
- Workerd covers content then error and reported usage then error, with exact
  ledger/user/token/channel/request/provider/audit assertions. Malformed then
  valid Responses accumulation has a Rust unit fixture.
- Platform/frontend readiness now separates compiled recovery, explicit estimate
  state, stream staging proof, billing Queue availability, replay code, replay
  proof, and final cutover. The absent Queue/replay keeps cutover false even if
  stream evidence flags are changed.
- Pre-bind owner generation is now locally closed by migration 0026. Positive-
  reserve non-stream responses are also finalized synchronously: an intact 2xx
  response that cannot be inspected settles at the approved reserve, while a
  consumed or malformed response is converted to 502 and refunded before the
  error is returned.
- Next: prove those paths on deployed direct/Gateway/WFP transports, instrument
  flat and zero-reserve forwarding, and complete the abort/idle-timeout,
  Queue/DLQ, reconciliation, and provider-invoice matrix.

## 2026-07-14 Durable HTTP Billing Finalization Queue Increment

- Added migration 0024 with a unique partial index on
  `logs.billing_finalization_event_id`. The local exact set is now 24
  migrations, 29 tables, 106 explicitly checked incremental columns, and 21
  explicitly checked key indexes.
- Added default-off `BILLING_QUEUE` transport for positive reservation-backed
  tiered settlement/refund. Events freeze only the terminal decision and a
  redacted audit projection; flat and task billing paths are unchanged.
- Added an exact-name/per-message Rust consumer with D1 CAS replay, individual
  ACK/retry, bounded retries, and environment-specific DLQs. Producer failure
  uses the same idempotent D1 finalizer synchronously.
- Added `bun run check:cf:billing-queue` to the full gate. Release Workerd proves
  normal delivery, matching duplicate ACK/no-double-mutation, cross-queue retry,
  and mixed-batch poison isolation. Frontend readiness no longer accepts a
  proof flag when runtime prerequisites are false.
- Reconcile/DLQ replay remains deliberately unimplemented and visible as false.
  Therefore scheduled HTTP orphan recovery and final cutover remain fail-closed.
  Next: implement the bounded operator reconcile workflow, then run authenticated
  staging migration/Queue readback, retry exhaustion/DLQ alert, cancellation,
  D1 ambiguity, and settlement/recovery race drills. Production remains
  **NO-GO**.

## 2026-07-14 Billing Finalization DLQ Reconcile Increment

- Added migration 0025 and a D1 incident ledger for valid frozen events and
  invalid poison-message fingerprints. Invalid payload bodies are not stored;
  event/payload identity conflicts fail closed.
- Added the environment-specific DLQ consumer, replay generation/lease claims,
  sanitized admin list, root + fresh step-up replay route, redacted manage
  audit, and single-event requeue through `BILLING_QUEUE`. The management route
  accepts no charge-affecting or replacement event fields and returns
  asynchronous `202 queued`.
- The main Queue consumer remains the only financial executor and closes an
  incident after the existing idempotent D1 finalizer. Workerd proves
  quarantine, redaction, pre-replay no-mutation, authorization, one refund, one
  billing audit, one manage audit, resolution, and duplicate replay rejection.
- The config audit now requires the DLQ consumer and environment-specific
  parking queue. The smoke tool requires one explicit incident ID and a pre-
  verified root session. Both Queue and reconciliation remain false in all
  tracked environments.
- Next: rotate the exposed credential, apply 0025 in isolated staging, create
  and read back producer/consumer/DLQ/parking resources, attach alerts and an
  operator response inside the four-day DLQ retention window, then run retry-
  exhaustion, D1 outage, identity-conflict, concurrent-claim, completion-
  ambiguity, recovery-race, reconciliation, and rollback drills. Production
  remains **NO-GO**.
- Final local gate: `bun run check` passed with Workerd 19/19, Playground 1/1,
  frontend readiness 26/26, exact 25-migration replay, all local smoke
  contracts, workspace tests, and all three wasm32 targets.

## 2026-07-14 WFP Authority V3 And Realtime Admission Increment

- WFP authority v3 now binds the public tenant, physical dispatch Worker, and
  fixed `platform-ai-gateway-v1` policy profile. A deployment target or policy
  drift is rejected before replay consumption or bearer access.
- The Rust tenant forwards only content type, accept, and the opaque authority.
  The platform outbound Worker discards tenant Gateway/identity inputs and owns
  route Gateway IDs, bounded retry/cache/logging policy, signed-claim metadata,
  replay, and bearer injection.
- The root-admin Cloudflare panel can generate a strict Rust/Wasm tenant upload
  plan and copy only a redacted evidence allowlist. It performs no deployment,
  accepts no Cloudflare token, and proves no tenant Gateway bindings are
  attached. The artifact uploader retires the old Gateway flags, while
  readback/verifier contracts reject any such binding.
- Realtime now fails closed with `realtime_billing_mode_unsupported` before the
  WebSocket upgrade when no tiered billing expression is available. Workerd
  evidence requires zero provider calls, reservations, and quota mutations.
- Next: rotate the exposed credential, collect authenticated outbound/tenant
  staging readback, prove Dynamic Dispatch context and v3 tamper/replay
  negatives, run the four-route billing canary, and race real Realtime
  settlement/recovery boundaries. Production remains **NO-GO**.

## 2026-07-14 Realtime Ambiguous-Usage Reconciliation Increment

- Added migration 0027 and a single-writer `usage_reconciliation` owner for
  Realtime reservations whose response identity, terminal usage, or settlement
  outcome cannot be verified. Owned rows remain reserved and are excluded from
  settlement, terminal refund, lease refund, and global orphan recovery.
- `response.done` parsing now requires an allowed terminal status plus a
  complete, non-negative, internally consistent usage object. Missing, null,
  malformed, unknown-status, and completed-zero cases fail closed with a safe
  error and 1011 close before the terminal provider frame is forwarded.
- Release Workerd covers a real authenticated reserve and mock null-usage
  terminal frame, then forces the lease overdue and runs scheduled recovery.
  The pre-consumption remains unchanged with no settlement replay, audit, or
  refund.
- Added capability and admin frontend visibility. The ledger contract v2 is
  no-store and hash-only; the React panel is read-only and strips fields outside
  its explicit response allowlist.
- The exact local schema is now 27 migrations, 30 tables, 130 checked
  incremental columns, and 24 indexes. Next: credential rotation, isolated
  remote 0027 application, live provider usage/invoice reconciliation, fault
  and redeploy races, alert/retention ownership, and an independently approved
  operator resolution workflow. Production remains **NO-GO**.

## 2026-07-14 Realtime Reconciliation Operator Increment

- Migration 0028 adds public reconciliation identity, revision fencing,
  terminal resolution, idempotency, operator attribution, and evidence hashing
  only for the quarantined Realtime billing workflow.
- The Worker now exposes an admin no-store queue and root preview/apply APIs.
  Preview recomputes quota from the frozen tiered expression; apply requires
  fresh secure verification and a matching preview/idempotency contract.
- Settle/refund mutations are one D1 batch across terminal reservation state,
  quota counters, replay where applicable, and audit. Quarantine reason/time is
  retained after terminal resolution.
- The React/Bun operations panel provides pagination, controlled decision and
  evidence inputs, server preview, risk acknowledgement, and step-up. Mutation
  stays disabled by default in base, staging, and production Wrangler config.
- Current local schema proof is 28 migrations, 30 tables, 137 checked
  incremental columns, and 27 indexes. Next: rotate the credential, apply 0028
  in isolated staging with all Realtime writers off, establish dual-control and
  retention policy, replay provider/D1/concurrency/rollback faults, and archive
  invoice-to-ledger reconciliation. Production remains **NO-GO**.

## 2026-07-14 Non-Stream Billing And Reconciliation Cutover Increment

- Positive-reserve non-stream relay responses no longer depend on a detached
  clone for financial completion. The Worker reads within the configured JSON
  bound before returning the response and validates non-empty bodies as JSON.
- If the original response remains forwardable but usage inspection is blocked
  before body consumption, the client receives the provider 2xx and the frozen
  reservation settles conservatively at `pre_consumed_quota`, with audit source
  `unavailable_parse_failure`. If reading consumed the body or JSON is malformed,
  the Worker returns 502 and synchronously refunds through the same owned
  Queue/D1 finalizer. Cohere rerank now follows the same terminal rule.
- Release Workerd regressions cover both outcomes with one provider call, one
  terminal reservation, exact user/token/channel/request accounting, and Queue
  finalization evidence.
- Realtime reconciliation now has separate compiled, runtime-ready, staging-
  verified, and cutover-ready capabilities. The v1 Realtime predicate requires
  reconciliation cutover readiness as its 37th independent gate. The immutable
  staging-proof flag remains false in every tracked Wrangler environment.
- A local forced-eviction experiment with an active outbound WebSocket was
  rejected because the DO still had active references. This matches the
  platform boundary: accepted inbound WebSockets may hibernate, while an active
  outgoing WebSocket keeps the DO active. Existing local eviction evidence is
  therefore limited to the detached-upstream fail-closed path; live redeploy,
  network interruption, provider accounting, and rollback proof remain open.
- Production remains **NO-GO** pending credential rotation, remote migration
  and resource readback, the signed staging fault/accounting matrix, and G1-G8
  approval.

## 2026-07-14 Zero-Reserve And Usage-Less Billing Intent Increment

- Successful non-stream usage parsing now completes synchronously before the
  response is returned, including flat traffic and tiered estimates of zero.
- Every tiered request creates and binds a reservation even when estimated
  quota is zero. Actual-positive usage therefore settles through the existing
  Queue event identity and D1 CAS instead of the unkeyed direct-debit path.
- An intact uninspectable 2xx is forwarded only when a positive frozen reserve
  can be conservatively settled. Flat and zero-reserve traffic returns 502
  before client delivery and records a redacted blocked/no-charge observation.
- Audio speech, transcription, and translation now use an explicit usage-less
  request contract. Configured fixed `ModelPrice` billing is applied before
  returning the binary/text provider response.
- Release Workerd now passes 34/34. New cases prove zero-to-positive Queue/CAS
  settlement, flat body-limit blocking without charge, and synchronous
  fixed-price audio debit.
- Next: introduce a frozen, idempotent ledger intent for generic flat billing,
  add client-abort and upstream-idle taxonomy, and execute the signed remote
  direct/Gateway/WFP fault and provider-invoice matrix after credential
  rotation. Production remains **NO-GO**.

## 2026-07-14 Frozen Flat Billing Intent Increment

- Migration 0029 adds additive flat intent kind/snapshot fields plus database
  guards that reject empty flat snapshots and preserve legacy tiered writers.
- Flat requests now freeze candidate group/channel pricing, reserve the maximum
  estimate, bind the actual serving attempt, and settle/refund through Queue v2
  and D1 CAS. The `flat-v1` digest is recomputed by the repository.
- Stable caller request IDs derive private `relayreserve-v2` keys. Concurrent or
  terminal replay returns 409 before another provider call; no raw request ID is
  stored.
- Ordinary failure and zero-usage refund paths no longer increment request
  count. The fixed-price audio reserve is synchronous, while terminal channel
  and request accounting is Queue-owned; this corrects the previous phase note.
- QuotaCoordinator now observes the generic reservation ledger. The admin
  cockpit separates flat intent implementation, runtime, staging proof, Go
  pricing parity, and cutover.
- Local schema proof is 29 migrations, 30 tables, 139 checked incremental
  columns, and 27 key indexes. Remaining flat cutover blockers are decimal
  terminal parity, unset-ratio/self-use policy, complete image/audio/tool and
  provider `OtherRatios`, remote 0029/Queue evidence, abort/idle taxonomy,
  invoice reconciliation, credential rotation, rollback, and G1-G8 approval.
  `relay_flat_billing_go_parity_ready` remains hard false and production remains
  **NO-GO**.

## 2026-07-14 Flat Pricing Admission And Contract Immutability Increment

- Flat quota math now uses exact decimal intermediates and Go-compatible
  half-away-from-zero final rounding. Anthropic generic cache creation is no
  longer incorrectly assigned to the explicit 5m bucket.
- Existing D1 option rows replace the seeded default pricing map, including an
  intentional empty object. Missing rows retain defaults; zero remains an
  explicit configured value.
- Unconfigured flat models are rejected before provider egress unless site
  self-use or the authenticated user's unset-model policy admits them. Admitted
  unknowns use ratio 37.5, and model discovery follows the same rule.
- Migration 0030 makes the frozen reservation identity and financial contract
  immutable after insert. SQLite and Workerd regressions prove snapshot and
  quota mutation are rejected.
- Local evidence now passes 30 migrations / 30 tables / 139 checked columns /
  27 indexes, Worker 671/671, billing 87 unit plus 10 Go-expression parity
  fixtures, and release Workerd 38/38.
- Remaining flat blockers are provider-specific audio, image, tool-call,
  `OtherRatios`, and usage-source semantics plus a Go-generated immutable flat
  golden manifest. Remote 0030/Queue/DLQ/provider-invoice evidence, abort/idle
  faults, credential rotation, rollback, and G1-G8 approval remain open.
  `relay_flat_billing_go_parity_ready` stays hard false and production remains
  **NO-GO**.

## 2026-07-14 Flat Provider Pricing Contract V2 Increment

- The frozen flat snapshot is now schema v2 and uses a domain-separated
  `flat-v2` contract hash. It stores image size/quality and `OtherRatios` as
  separate facts so reservation and terminal settlement follow Go's order.
- Fixed-price reservation now truncates
  `model_price * image_price_ratio * quota_per_unit * group_ratio` and excludes
  image count. Terminal settlement performs one decimal half-away-from-zero
  round after applying `OtherRatios`.
- `OtherRatios` now apply to both fixed-price and per-token flat billing. The
  request resolver covers image `n`, Ali `z-image` `prompt_extend`, and removes
  the prior SiliconFlow `batch_size` billing divergence.
- DALL-E size and quality pricing now matches Go, including 256/512 square,
  rectangular, and DALL-E 3 HD combinations. Gemini input-audio pricing is
  frozen per model and added without the model ratio, as in Go.
- Successful usage-less audio requests now settle from the frozen request
  estimate instead of refunding per-token reservations; audit provenance is
  `request_estimate`.
- Local Worker tests pass 671/671. Remaining flat blockers include response-
  duration TTS charging, dedicated audio-detail ratios, image edits and Ali
  actual-count replacement, tool-call surcharges, provider usage normalization,
  a Go-generated immutable flat manifest, and all remote evidence. Production
  remains **NO-GO**.

## 2026-07-14 Frozen Tool Surcharge And Usage Normalization V3 Increment

- Flat snapshots are schema v3 with `flat-v3:<sha256>`. The exact request-time
  `tool_price_setting.prices` resolution is frozen per candidate: longest
  model-prefix override, tool default, Go fallback, then zero. The nine GPT
  Image 1 quality/size prices are also durable contract facts.
- Non-stream Responses counts actual `output` items. Streaming Responses counts
  bounded `response.output_item.done` items, deduplicates at most 256 IDs, and
  now covers web, file, and image-generation calls. Claude uses the maximum
  cumulative `usage.server_tool_use.web_search_requests` value.
- The retained request tool type selects preview versus current web-search
  pricing. Legacy `*-search-preview` models still receive one preview call when
  no built-in response fact exists. Image generation remains one charge per
  response, matching Go.
- Flat settlement adds search/file per-1K and image per-call quota after the
  token/fixed base, applies the frozen `OtherRatios` product, and performs one
  decimal half-away-from-zero round. Audit metadata records counts, frozen unit
  prices, selected image class, and surcharge quota before `OtherRatios`.
- Provider normalization now accepts Zhipu-style top-level
  `usage.cached_tokens`, applies `timings.cache_n` only to channel type 1 when
  standard cache evidence is absent, and applies Gemini's 1,400 completion
  tokens per streamed generated image without rewriting provider total usage.
- Local tests pass billing 95/95, relay 80/80, Worker 673/673, Workerd 38/38,
  frontend readiness 52/52, route parity 223/326 with zero missing, and the
  complete workspace/main-tenant-outbound Wasm gate. Remaining
  flat blockers include OpenRouter cost-based cache-write inference, TTS
  response-duration/audio-detail arithmetic, Gemini Imagen actual-image usage,
  image-edit/Ali actual-count settlement, the Go-generated immutable flat
  manifest, and all remote Queue/D1/provider evidence. Tiered tool surcharges
  were intentionally not changed in this increment. Production remains
  **NO-GO**.

## 2026-07-15 WFP Deployment Evidence And Dedicated Gateway Credential Increment

- The tenant artifact uploader now targets the real Rust/Wasm build output,
  `crates/wfp-tenant/build/index.js` plus `index_bg.wasm`, instead of the
  Wrangler-only compatibility shim. Strict manifest validation remains
  mandatory before upload.
- Upload metadata enables observability with a nonzero sampling rate. Evidence
  schema v3 requires exact upload, Scripts Settings GET, and multipart Content
  GET observability agreement and rejects disabled or drifted readback.
- Tenant bindings exclude AI Gateway identity/policy and all Cloudflare or WFP
  authority credentials. Paid AI routing remains centralized in the reviewed
  outbound Worker.
- Main-relay AI Gateway runtime and capability readiness use the same
  fail-closed policy and require only the dedicated
  `CLOUDFLARE_AI_GATEWAY_TOKEN`; a generic Cloudflare API token cannot satisfy
  the data-plane gate.
- Local evidence passes Worker 676/676, artifact manifest 5/5, deploy policy
  3/3, readback collector 19/19, post-upload verifier 28/28, and the complete
  release gate with Workerd 38/38, frontend readiness 52/52, zero route parity
  gaps, D1 schema checks, workspace tests, and all three Wasm targets.
- Next: implement and freeze TTS duration/audio-detail settlement and OpenRouter
  cost/cache semantic provenance, then capture authenticated staging upload,
  Settings/Content readback, tenant smoke, Queue/D1/provider reconciliation,
  fault/load/alert, credential rotation, rollback, and signed G1-G8 evidence.
Production remains **NO-GO**.

## 2026-07-15 Flat Audio, OpenRouter, And Auth Lifecycle Increment

- Flat snapshots advance to schema v4 and `flat-v4:<sha256>`, freezing audio
  ratios, Go's audio-detail-routing decision, and OpenRouter
  default-ratio/inference eligibility. A deployment must first drain every v3
  reservation and Queue/DLQ/parking replay.
- Bounded speech response settlement now derives PCM/container duration or the
  Go decimal-byte fallback, applies dedicated input/output audio ratios, and
  refunds oversized consumed responses before client delivery.
- OpenRouter type 20 preserves Decimal provider cost and explicit semantic
  provenance. Anthropic flat usage uses `P-H-W`; eligible missing aggregate
  cache-write is reconstructed from cost, while explicit aggregate, custom
  ratio, fixed-price, and invalid candidates remain untouched and audited.
- Tiered expressions retain provider-original usage and do not consume this
  flat-only inference.
- Frontend auth verification and each request's HTTP 401 cleanup now share a
  generation fence, and GET deduplication is scoped to one generation. The
  production build and focused lifecycle tests pass; Playwright desktop/mobile
  evidence is still required.
- Remaining next work: provider actual image/count and image-edit parity,
  browser journey automation, then remote Queue/D1/provider reconciliation
  after credential rotation. Production remains **NO-GO**.

## 2026-07-15 Immutable Go Flat Billing Manifest Increment

- A schema-1 manifest is now generated by executing the real Go
  `calculateTextQuotaSummary`, `calculateAudioQuota`, and `ModelPriceHelper`
  paths against source commit `73652508abc5`. The generator copies bounded test
  templates into the Go checkout only for the test process, refuses to
  overwrite an existing file, and removes every temporary file in `finally`.
- The artifact freezes eight source-file hashes, the generator-script hash,
  both generator-template hashes, 10 terminal formula cases, 8
  admission/pre-consume cases, and a
  canonical payload SHA-256. `bun run check:billing-flat-manifest` verifies the
  committed artifact without requiring the Go checkout or network.
- Rust replays the manifest through `FlatPricingSnapshot`,
  `compute_flat_quota_from_snapshot`, pricing admission, and pre-consume. The
  corpus covers token/fixed modes, cache/image/audio categories, tool
  surcharges, DALL-E request multipliers, unknown-model policy, free models,
  and zero/fractional/large group ratios.
- Local focused evidence passes manifest integrity and all 3 Rust replay tests;
  the source Go checkout returns to its original state after generation.
- This removes the immutable Go flat-manifest item from G4. Provider
  actual-image/count and multipart image-edit settlement, runtime free-model
  policy completion, browser journeys, remote Queue/D1/provider reconciliation,
  credential rotation, rollback, and signed G1-G8 approval remain open.
  Production remains **NO-GO**.

## 2026-07-15 Multipart Image Edit Flat Settlement Increment

- The Go source audit at commit `73652508abc5` confirms that ordinary
  OpenAI-compatible, SiliconFlow, and xAI fixed-price image requests settle
  from request `n`; only Ali/Bailian replaces a positive request count with
  upstream `usage.image_count` or a non-empty converted response `data` count.
- Bounded multipart `/v1/images/edits` preparation now extracts only
  `model`, `n`, `size`, and `quality` into a separate flat-pricing body. The
  original multipart bytes, including image and mask files, are still
  forwarded unchanged.
- The separate body is intentional: flat snapshots now receive the same
  request-count and DALL-E size/quality facts as Go, while `tiered_expr` keeps
  Go's multipart limitation and sees only the existing minimal model context.
  This avoids silently making `param("n")` billable after migration.
- Successful image edits without token usage now use the same one-token
  request contract as image generations and settle the frozen flat intent.
  Provider/HTTP/JSON failures continue down the reservation refund path.
- Zhipu v4 image generation now forwards request `n`, matching the Go type-26
  pass-through contract and preventing a request-count charge from diverging
  from the actual upstream generation count.
- No snapshot schema or digest changed: the request facts are resolved before
  the existing schema-v4 snapshot is serialized, so `flat-v4` replay and drain
  requirements remain intact.
- `/api/platform/capabilities` now exposes stable flat-parity blocker IDs, and
  the Cloudflare Platform panel renders their translated names instead of a
  generic `Parity blocked` badge. A contradictory backend response that claims
  parity while retaining blockers remains fail-closed in the frontend.
- Local evidence passes the complete root `bun run check` gate, Rust formatting,
  all 681 Worker library tests, and all 52 frontend readiness tests,
  including binary multipart extraction, expression isolation, DALL-E edit
  ratios, request `n`, and usage-less edit settlement.
- Ali native image submit/poll and response actual-count replacement remain
  open. That adapter requires bounded asynchronous orchestration and remote
  provider evidence; SiliconFlow/xAI image edits remain unsupported and must
  continue to fail before reserve. Production remains **NO-GO**.

## 2026-07-15 Native Provider Usage Recovery Increment

- Gemini JSON/SSE now fills a missing prompt from the frozen request estimate,
  estimates a missing completion from native candidate text, preserves a
  positive provider total, and excludes input IMAGE details from Go's billed
  subcategory view while retaining AUDIO details.
- Anthropic-wire SSE accumulates text/thinking and `message_stop`. A missing or
  incomplete terminal usage supplements prompt/completion only, preserving
  cache read and split cache-creation facts collected at `message_start`.
- The behavior stays behind `RELAY_MISSING_USAGE_ESTIMATE_ENABLED`; the default
  cutover state is unchanged.
- Nonstandard cache fields are now provider-scoped like Go. Durable audit
  metadata separates provider/wire source, normalized semantic provenance,
  local estimation, and transport route. Provider parity is now fail-closed by
  the explicit staging reconciliation blocker instead of one aggregate label.
- Parallel source audit rejected a tempting free-model shortcut: Go skips
  pre-consume but can still post-charge tool/audio additions. HTTP, Realtime,
  Task, wallet admission, request counting, and serving-group semantics must be
  implemented together before that blocker can close.
- Ali asynchronous image settlement remains an explicit tranche using
  the existing TaskRunner DO, D1 CAS, and billing Queue. cinaVibeSDK is a design
  reference for DO alarms and WFP dispatch only, not a billing source of truth.

Production remains **NO-GO**.

## 2026-07-15 Ali Synchronous Image Actual-Count Increment

- Type 17 now exposes `/v1/images/generations` and `/v1/images/edits` only for
  source-audited synchronous models; asynchronous models and Wan edits remain
  fail-closed before reserve.
- Generation JSON and multipart edit input are converted to DashScope native
  multimodal JSON. Edit conversion preserves all files from `image`, then
  `image[]`, then indexed `image[n]`, with Worker safety limits of 16 images and
  12 MiB total image bytes. Extraction stops on the 17th match and rejects
  part headers above 8 KiB. Ali response conversion is capped at 8 MiB and
  emits compact metadata without duplicating image payloads.
- Successful responses convert results/choices into OpenAI image data and
  select the billed count from positive `usage.image_count`, non-empty converted
  output count, then normalized request `n`.
- The terminal flat snapshot clone alone receives the actual-count adjustment.
  The persisted `flat-v4` snapshot/digest and tiered billing-expression request
  context are unchanged, preserving the mandatory expression contract.
- Audit evidence stores requested, converted, actual, and provenance fields but
  no image data or provider credentials. `b64_json` never fetches provider URLs;
  URL-only/partial conversion fails with 502 and refunds. The bounded
  `ALI_SYNC_IMAGE_MODELS` override keeps production Go model configuration
  aligned across candidate filtering, Admin probe, and request conversion.
- The structured blocker is narrowed from `ali_actual_image_count` to
  `ali_async_image_task_settlement`. That remaining tranche requires durable
  task/reservation linkage, TaskRunner DO alarms, provider-terminal D1 CAS,
  idempotent Queue finalization, recovery scan, timeout/refund, and staging
  invoice reconciliation.

Production remains **NO-GO** pending synchronous live evidence, the asynchronous
state machine, free-model runtime policy, provider usage staging reconciliation,
credential rotation, rollback, and signed G1-G8 approval.

## 2026-07-15 Task v2 Durable Ownership And Funding UI Fail-Closed Increment

- D1 head advances to `0031_task_billing_intents.sql`. Video, Suno, and
  Midjourney now create an immutable billing intent and reserve wallet/token
  quota before provider I/O.
- Submission state is independent from financial state. A Worker interruption or
  unclassifiable response after outbound I/O becomes `submit_unknown` and
  `recovery_required`; the scheduled recovery path cannot automatically refund
  or blindly resubmit it.
- Unified Task and Midjourney provider attachment, successful-request accounting,
  and terminal settle/refund use guarded D1 batches. Conditional zero-row writes
  force transaction abort, and refund triggers verify the original user/token
  targets before marking the intent final.
- Expired `prepared` intents are safe to refund because provider submission was
  never claimed. Expired `submitting` intents are quarantined for reconciliation
  instead. Zero-quota tasks still attach and count once.
- `/api/platform/capabilities` now separates TaskRunner fast-path readiness from
  Task v2 financial ownership and publishes stable blockers for Task v2,
  subscription funding-source parity, and Realtime flat billing parity.
- Subscription purchase/management remains available, but ordinary request
  funding still uses wallet only. The self-subscription contract now exposes
  this limitation and the UI disables non-wallet funding preferences rather than
  promising behavior the runtime cannot perform.
- Local schema verification covers the 31-file migration set, 31 tables, 167
  incremental columns, 30 key indexes, and the Task intent state machine. See
  `docs/task-v2-durable-ownership.md` for the failure matrix and remaining gates.
- Structured provider rejection now refunds atomically; malformed or ambiguous
  results remain quarantined. Active intent channels cannot be deleted, and an
  owned refund still reaches soft-deleted user/token rows.
- Midjourney timeout recovery is D1-driven before provider polling, and Task
  FreeModel admission delays only the user-wallet check until the frozen policy
  decision. Token and access-policy checks remain pre-provider.

Open production gates remain substantial: shared generation-fenced D1 poll
leases across cron/DO, provider idempotency or lookup recovery, automated
`submit_unknown` reconciliation, task-family fairness/backoff, subscription
funding on HTTP/Task/Realtime, Realtime flat/free-model parity, remote D1 and
provider fault replay, invoice reconciliation, browser evidence, credential
rotation, rollback, monitoring, and signed G1-G8 approval. Go/VPS remains the
production authority and Cloudflare remains **NO-GO**.

## 2026-07-15 Task Submit Reconciliation Increment

- Added D1 0032 as the rolling-compatible expand phase and 0033 as the final
  writer contract. The current local head is 0033; after it is applied, a
  0031-era Worker cannot safely be restored.
- Every new Task/Midjourney intent freezes an attachment contract and digest
  before provider I/O. Accepted provider IDs are retained when local attachment
  is ambiguous. Ordinary attachment cannot consume a quarantined row.
- Added root-only queue and preview APIs plus a root/fresh-step-up apply API.
  Preview binds current revision, owner generation, provider/evidence decision,
  financial facts, and both frozen hashes. Apply requires confirmation and an
  idempotency key.
- Resolution writes one immutable evidence event and atomically attaches the
  provider task or refunds the frozen reserve, updates request/channel
  accounting, advances the intent, and records the root audit. Identical replay
  converges; conflicting or stale replay returns 409.
- Legacy unknown rows without an attachment contract are refund-only. APIs do
  not expose the frozen payload. Retained Midjourney prompt and Task identity
  metadata still require a formal production retention/deletion policy.
- The Cloudflare Platform UI now exposes implementation, runtime, staging, and
  cutover signals and a bounded operator workbench. Both Task reconciliation
  flags remain false in all tracked environments.
- Local D1 verification now covers 33 migrations, 32 tables, 190 incremental
  columns, 34 indexes, required-event resolution, atomic refund, and immutable
  event history. Worker host/Wasm and frontend gates remain required.

This increment supplies a controlled local resolution path but does not infer
provider outcome. Provider-native idempotency/lookup, remote 0032/0033 rollout,
fault/invoice/browser evidence, shared poll ownership, fair retry, checked i64
D1 bindings, FreeModel/subscription parity, credential rotation, rollback, and
G1-G8 approval remain open. Go/VPS remains authoritative and Cloudflare stays
**NO-GO**.

## 2026-07-15 Phase 1 Task Poll Lease Increment

This current-head overlay closes the local implementation item for shared
generation-fenced polling. It does not promote Phase 1 or replace any earlier
evidence. Migrations 0034/0035 add default-inert Task and Midjourney lease
state, D1 authority/enforcement controls, due indexes, shape guards, and
old-writer lifecycle guards. The Worker publishes contract version 1 plus
schema, env authority, D1 authority, enforcement, runtime, staging, cutover,
and lease-duration capabilities.

Implemented local behavior:

- cron, the video `TaskRunner`, Task timeout, Suno batch poll, Midjourney batch
  poll, and Midjourney timeout claim before mutation;
- result apply requires owner, generation, and a strictly unexpired lease;
- ambiguous claim errors perform canonical readback, and failed/no-op paths
  release best-effort while expiry remains the recovery boundary;
- normal video, Suno, and Midjourney candidate windows are separate;
- Suno is not armed into the video `TaskRunner`;
- provider HTTP poll timeout is capped at 90 seconds and keeps 15 seconds of
  configured lease headroom.

Phase 1 production rollout is fixed: apply migrations with both DB flags off;
deploy the new Worker with env authority and TaskRunner off; drain every old
poller, alarm, and provider call; enable D1 authority; enable D1 enforcement;
enable env authority for cron canaries; review staging evidence; then canary
the video TaskRunner. Rollback is env authority off, D1 authority off, D1
enforcement off, active-lease drain, and rollback only to a 0033-compatible
Worker.

Migration 0036 now supplies the local persisted `next_poll_at`, five-family
cursor, failure/backoff, and quarantine schema. It does not supply staging or
remote evidence. Remaining Phase 1 blockers include runtime proof of that
policy, provider-operation uniqueness/idempotency lookup, full
Vertex/auth-plus-fetch deadline enforcement, remote D1/provider fault
injection, duplicate alarm/cron/timeout replay, invoice and quota
reconciliation, load/alert evidence, credential rotation, rollback rehearsal,
and G1-G8 approval. Production remains **NO-GO**.

## Phase 1 Scheduler Gate

The committed default/staging/production contract is scheduler disabled,
15-second retry base, 900-second retry cap, eight consecutive failures before
quarantine, and staging verification false. Phase 1 may not enable the
scheduler until migrations 0034/0035/0036 are present in order and the 0034/0035
lease has passed drain, authority, enforcement, race, and rollback checks.

Staging must then prove five independent finite high-watermark cursor families,
claim-only cursor advance, one normal family per minute slot with an eight-row
cap, no poll before D1 `next_poll_at`, deterministic jittered delay ranges of
15-18/30-33/60-63/120-123/240-243/480-483/900 seconds, failure reset after a
validated response, and threshold quarantine instead of another retry on
failure eight. Immediate-poison classification and audited manual release are
now implemented locally: unsupported provider, invalid provider task identity,
and deterministically invalid provider credential quarantine immediately, and
0037 supplies root/step-up preview/apply with immutable audit and idempotent
requeue. Network, invalid upstream response, and missing-item failures still
follow threshold backoff. Staging must also prove no financial side effect from
quarantine, stale-generation rejection, and cron operation when the DO fast
path is unavailable. The
staging-verification flag stays false while this evidence is collected and may
change only in a later reviewed candidate.

Rollback order is scheduler off, TaskRunner off, in-flight reconciliation,
then lease env off -> D1 authority off -> D1 enforcement off if the whole Rust
ownership path is being withdrawn. Keep 0036 and all scheduling metadata in
place. Reconcile quarantined rows before returning them to Go/VPS.

## 2026-07-15 Phase 1 Task Poll Recovery Gate

- D1 head advances to `0037_task_poll_recovery.sql`. The verified local schema
  report is 37 migrations, 35 tables, 241 checked incremental columns, and 42
  key indexes. Remote D1 must be verified independently.
- Recovery events are immutable and one-per-entity/revision. Lowercase-hex
  checks cover resolution, evidence, preview, and decision digests. Exact
  partial indexes contain only open, provider-identified quarantine rows.
- Root queue/preview and root plus fresh-step-up apply expose
  `task_reference`, SHA-256, hard timeout, timeout eligibility, and a
  lease-sized margin. They do not return the original Midjourney provider ID.
- Apply atomically guards generation, revision, quarantine facts, empty lease,
  nonterminal state, and timeout headroom. Stale/conflicting state is `409`;
  D1, audit, or readback uncertainty is `503`.
- The first Task apply may best-effort rearm TaskRunner after D1 commit. Cron
  remains the authority, and rearm failure cannot fail or reverse recovery.
- `TASK_POLL_RECOVERY_ENABLED=false` and
  `TASK_POLL_RECOVERY_STAGING_VERIFIED=false` remain the committed values.
  Scheduler cutover is blocked until recovery cutover is ready.

Phase 1 staging order is 0034 -> 0035 -> 0036 -> 0037, disabled deploy, old
writer/cohort drain, D1 authority, D1 enforcement, lease env, scheduler runtime,
recovery canary, independent recovery review, scheduler review, then optional
video TaskRunner canary. There is no production activation wave.

Rollback turns recovery off first, then scheduler and TaskRunner, then lease
env and D1 authority/enforcement. Reconcile accepted operations and every
quarantined row before Go/VPS resumes. Provider-operation uniqueness/native
idempotency, whole-submit deadlines, remote D1/staging/provider/TaskRunner hot
paths, WFP namespace upload/readback, paid canary, and signed G1-G8 evidence
remain hard blockers. Production is **NO-GO**.

## 2026-07-15 Phase 1 Submit Operation Gate

- D1 head advances through compatible 0038 expansion to 0039 enforcement. The
  local baseline is 39 migrations, 35 tables, 244 checked incremental columns,
  and 45 key indexes.
- New writers persist a token-scoped client operation digest, request digest,
  and 5..120 second absolute submit deadline before provider I/O. Same-key,
  same-request replay performs no second provider create.
- Ambiguous create results return 202 plus `submission_id`/`status_url` and stay
  reserved for reconciliation. The owner-token status route is private,
  no-store, and redacted.
- `TASK_CLIENT_IDEMPOTENCY_REQUIRED=false` remains explicit in every tracked
  environment. Phase 1 cannot report Task v2 runtime/cutover ready until a
  reviewed staging candidate requires the key.
- Provider-native idempotency and deterministic lookup remain false capability
  gates. Local uniqueness is not a substitute for provider evidence.

Activation order is 0038 expand -> disabled dual-writer deploy -> old-writer
drain -> zero-value readback -> 0039 enforce -> isolated required-key client
canary -> provider fault/lookup/invoice campaign -> independent review. After
0039, rollback must use a 0039-compatible writer and retain both migrations.
There is no production activation wave. Production remains **NO-GO**.

## 2026-07-15 Phase 1 Native Container Shard Gate

- `cinatoken-sharding` contract v1 and the four tracked scheduler variables are
  local routing foundation only. They do not add a Container, controller
  Worker, service binding, image, or provider path.
- The eight-shard ring is disabled in default, staging, and production.
  `CONTAINER_SCHEDULER_ROUTING_SECRET` is intentionally absent from tracked
  configuration and must be provisioned as a secret in a later phase.
- Stable shard names exclude ring generation. Every private operation must carry
  generation, topology, protocol, owner generation, input digest, and deadline;
  stale work fails before Container startup.
- D1 remains the business and billing authority. DO SQLite owns shard-local
  leases/fences, KV is configuration/cache only, R2 owns immutable large
  payloads/evidence, and Container disk is disposable scratch.
- The next implementation step is the isolated TypeScript controller Worker,
  followed by the fixed native image. The controller deploys first with no edge
  binding and no public route.

Phase C0 validation is local. Controller/image, deny-by-default egress, N/N-1
rollout, capacity rejection, remote fault injection, staging soak, canary,
cost, and rollback evidence are all false gates. Production remains **NO-GO**.

## 2026-07-16 Phase 1 Container Controller Gate

- The isolated Controller, SQLite `RelayShardContainer`, deny-all outbound
  proxy, Rust authority crate, native axum server, and non-root Dockerfile now
  exist locally. The edge config still owns no Container or Controller binding.
- The token binds `kid`, issuer, audience, protocol, dispatch, method, path,
  body digest, and a bounded time window. The operation carries the full shard
  fence, owner lease/generation, stable provider identity, admission/input
  digests, bounded R2 version, and execution deadline.
- DO claim state persists dispatch replay, operation conflicts, ring fence,
  lifecycle, and capacity rejection before a possible Container call. Provider
  and billing authority stay outside the DO and Container.
- Controller and execution flags are false in all Controller configs. Secrets
  are untracked and separated by domain. The native runtime executes only
  `health_probe`.

Next is an isolated Controller staging deploy with no edge binding, secret and
config readback, Workerd/remote SQLite concurrency and eviction, an actual
linux/amd64 image build/SBOM/sign/scan, Container lifecycle faults, D1/KV/R2
contracts, provider deny/allow/injection negatives, then N/N-1 rollout. Only
after those pass may C3 add a disabled edge binding for synthetic shadow work.
Production remains **NO-GO**.
