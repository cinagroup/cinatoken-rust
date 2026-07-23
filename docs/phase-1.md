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
  exist locally. The edge owns no Container, but now declares a private
  environment-specific Controller service binding.
- The token binds `kid`, issuer, audience, protocol, dispatch, method, path,
  body digest, and a bounded time window. The operation carries the full shard
  fence, owner lease/generation, stable provider identity, admission/input
  digests, bounded R2 version, and execution deadline.
- DO claim state persists dispatch replay, operation conflicts, ring fence, and
  lifecycle before a possible Container call. Capacity rejection is retryable
  and does not poison the operation ID with a terminal claim. Provider and
  billing authority stay outside the DO and Container.
- Ten Workerd/SQLite ledger scenarios prove max+1 serialization, conflict
  handling, expired 504 recovery, late-result CAS, capacity release, bounded
  time/count compaction, refreshed-dispatch protection, legacy rejection
  migration, replay-window backpressure, and eviction persistence.
  Seven-day/10,000-row retention is explicit in all Controller configs.
- Controller and execution flags are false in all Controller configs. Secrets
  are untracked and separated by domain. The native runtime executes only
  `health_probe`.

The signed Rust-to-TypeScript status path and private binding are now compiled,
but `CONTAINER_CONTROLLER_PROBE_ENABLED=false` everywhere. The status contract
rejects a body and keyring drift, bounds the whole subrequest, and keeps
transport verification separate from Controller/execution acceptance. The
public edge `/internal/*` surface fails into API 404 rather than SPA fallback.

Next is Controller-first isolated staging deployment, signed status readback,
then a targeted shard `/readyz` deep probe and actual `RelayShardContainer`
protocol/lifecycle coverage. It must include remote SQLite concurrency and
eviction, linux/amd64 build/SBOM/sign/scan, Container lifecycle faults,
D1/KV/R2 contracts, provider deny/allow/injection negatives, and N/N-1 rollout.
No relay or Task route may use the binding before those pass. Production
remains **NO-GO**.

## 2026-07-16 Phase 1 Targeted Container Readiness Gate

- The admin-only edge route accepts only a canonical shard index, active ring
  generation, explicit wake choice, and matching confirmation. It signs a
  bounded private POST; callers cannot provide an instance name or authority
  material.
- Ledger inspection is enabled separately from wake. Ledger mode does not call
  `getState` or `containerFetch`, does not extend Container activity, and never
  claims readiness.
- Live mode persists one-time dispatch and generation state before Container
  I/O. It separates process readiness from execution readiness and requires
  healthy state, exact runtime contract, execution gates, non-draining
  lifecycle, and capacity before top-level ready can become true.
- Draining now rejects new operation claims. Ring generation may advance for a
  readiness probe only when the old generation has zero in-flight operations.
- `CONTAINER_SHARD_READINESS_PROBE_ENABLED`,
  `CONTAINER_SHARD_READINESS_WAKE_ENABLED`, and
  `CONTAINER_SHARD_READINESS_STAGING_VERIFIED` are false in every edge scope;
  both Controller readiness switches are also false.

Next is Controller-first isolated staging deployment with shallow status
readback first, ledger-only inspection second, and one explicitly approved
cold/warm shard probe third. N/N-1, real lifecycle/fault, image supply-chain,
storage/provider/billing, load/cost, rollback, and approval evidence remain
hard blockers. Production remains **NO-GO**.

## 2026-07-16 Phase 1 Durable Operation Recovery Gate

Local code now provides strict Container outcomes, result-required non-health
completion, deterministic terminal outcome manifests, pre-dispatch persistent
deadline scheduling, recovery_required for ambiguous running operations, and
reserved/live D1 admission checks. A terminal duplicate does not execute the
Container again.

Portable protocol, Workerd SQLite, native runtime, TypeScript, and Rust source
capability tests cover this contract. Docker is unavailable locally, so no real
Container process, schedule callback, or multi-Worker E2E is claimed. Next is
the narrow non-streaming chat canary described in
docs/container-operation-recovery.md: billing bind before dispatch, immutable
R2 input, private Controller client, deterministic Container adapter, verified
R2 byte replay, and normal settlement/audit.

Every tracked execution, storage, scheduler, and staging switch remains false.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-16 Phase 1 Container Shared Storage Gate

The Controller now compiles a narrow shared-storage contract for the sharded
execution plane. A Container may request only an exact R2 input, create an
immutable R2 result, read bounded operation configuration from KV, or read a
minimal owner-fenced admission snapshot from D1. The owning DO authorizes each
action only for the current running generation before its deadline and
generation-CAS records the R2 result identity for replay.

All four storage action flags are false in local, staging, and production
configuration. Local protocol, Workerd ledger, TypeScript, Rust capability,
type-generation, and Wrangler dry-run evidence can qualify the contract for an
isolated remote canary, but cannot enable customer traffic. Remote binding
readback, real Container calls, R2/KV/D1 fault cases, N/N-1, provider recovery,
billing convergence, image provenance, load/cost, and rollback evidence remain
hard blockers. Production remains **NO-GO**.

## 2026-07-16 Phase 1 Global Container Operation Authority

Migration 0040 now provides the default-inert global operation record between
the financial D1 reservation and the sharded DO ledger. The Rust repository
binds it through owner/lease/selected-attempt/deadline CAS, while the Controller
performs the same authority join before claiming or executing work. SQLite
identity, type, terminal shape, timestamp, and lifecycle bypasses are covered
by executable verifier cases.

The default-off edge foundation also derives shard ownership from a
domain-separated tenant HMAC, writes immutable content-addressed R2 input,
version/hash-verifies R2 result manifests, and signs a bounded operation over
the private Controller Service Binding. No public relay branch calls these
functions yet, and no storage or execution flag changed.

Next is generation-fenced global lifecycle/terminal CAS, then one deterministic
non-streaming chat canary in the real Linux image with exact response replay,
normal frozen-snapshot settlement/audit, duplicate-operation proof, and the
remote lifecycle/storage fault matrix. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-16 Phase 1 Container Lifecycle CAS And Recovery Query

The Rust repository now implements the operation-side lifecycle boundary:
exact billing-owner `prepared -> dispatched`, exact terminal evidence from
`dispatched`, authorized recovery resolution, canonical readback after
ambiguous D1 results, and a bounded recovery-candidate query. Dispatch replay is
typed as `AlreadyDispatched` and is query-only; terminal replay is a separate
`MatchingTerminal` outcome and requires every persisted field to match.

The Controller and Rust private client now share a signed operation-status
query that remains usable after deadline expiry. It reads only the named DO
ledger and cannot perform admission, claim, schedule, wake, or Container I/O.
An append-only lifecycle migration prevents same-state rewriting of prepared,
dispatched, recovery-required, completed, or failed records. Independent
operation-write, terminal-CAS, reconciliation, chat-canary, and staging-proof
flags are default false and are new mandatory cutover inputs.

This closes the local operation-state CAS, not the financial terminal commit.
Next is one guarded D1 batch for operation terminal state plus frozen billing
settlement/refund/recovery, quota/request/channel accounting, and immutable
audit/outbox, followed by exact R2 client-response replay and the deterministic
Linux canary. No public route or production flag is enabled; Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Client-Abort Watchdog v1

At this historical checkpoint, migration 0058 was the local head at 58
migrations, 66 tables, 848 checked incremental columns, and 97 key indexes.
The 0059 runner-claim section below supersedes only that head/count statement.
`enable_request_signal` is
tracked for the Worker, and positive durable SSE now requires 0056/0057/0058
readiness before provider I/O.

The request path synchronously arms a bounded abort listener before returning
the stream. Reader cancellation appends exact operation identity and atomically
changes a matching forwarding handoff to
`recovery_required/client_disconnected`; it does not settle, refund, or resend.
The first durable decision wins a provider-terminal/client-abort race, and
watchdog disarm follows durable readback rather than process-memory inference.

Local Workerd proves the real Rust route through a gate-enabled candidate
Worker service binding: one chunk is read, the reader is cancelled, one
provider call and one abort event are observed, billing stays reserved, 0057
stays stream-bound, and request accounting stays zero. All production gates
remain false. Remote HTTP/2/HTTP/3/WFP cancellation, D1/restart/Queue/invoice,
P5, Go/VPS drain, credential revocation, and SLO/cost evidence remain open. At
this 0058 checkpoint the default-path clone/tee backpressure proof was also
open; the single-forwarding closure recorded below supersedes that local
blocker. Production remains **NO-GO**.

## 2026-07-16 Phase 1 Container Financial Terminal Expand Gate

Migration 0042 is a default-inert expansion. New operation writers freeze a
scoped client-idempotency HMAC, canonical request digest, and reconciliation
identity; legacy rows remain readable with all three fields empty during the
expand phase. The append-only terminal event freezes the operation transition,
billing action and owner generation, every accounting delta, exact client
response manifest, canonical audit/outbox payload, and recovery revision.

The Rust repository now commits event, outbox state, operation terminal CAS,
billing settle/refund/recovery CAS, and user/token/request/channel accounting in
one D1 batch. A no-op CAS deliberately fails the batch. Lost-response replay
requires an exact joined readback, while the explicit idempotency lookup returns
a distinct conflict for the same scoped key with a different request digest.
Initial ambiguity and later authorized resolution have separate event
identities and billing generations.

This does not make D1, Durable Objects, and R2 one transaction. The exact R2
client-response write/read path, divergence reconciler, deterministic Linux
canary, old-writer drain, future 0046 enforcement, and remote fault evidence
remain open. `CONTAINER_FINANCIAL_TERMINAL_ENABLED`,
`CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED`, and
`CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED` join the five existing gates and
remain false in every tracked environment. No public route, remote migration,
or deployment is enabled; Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-16 Phase 1 Exact Response and Divergence Foundation Gate

The default-off Worker now compiles a 4 MiB exact client-response R2 contract.
Writes are deterministic and create-only; both new and existing objects require
version/checksum/size/type/custom-metadata verification. Replay additionally
performs a bounded GET and recomputes the actual body digest and length before
reconstructing the canonical status and allowlisted no-store headers. D1
terminal receipts are revalidated against the same header, status, key, and
body contract rather than trusting persisted metadata.

The generic billing orphan sweep now detects migration 0040 and excludes every
reservation owned by a global Container operation at candidate and mutation
time. A pure fail-closed D1/DO/R2 classifier supplies the policy foundation for
exact replay and recovery without performing a second provider attempt or a
financial mutation.

No public relay path calls these helpers, and the bounded reconciliation runner
still needs fair pagination, durable backoff, metrics, authorization, and
operator resolution. The Linux canary, provider-attempt journal, remote R2 and
DO lifecycle faults, old-writer drain, 0046 enforcement, and N/N-1 evidence
also remain open. Exact-response and divergence compiled-readiness claims stay
false, all eight Container gates remain false, no remote action occurred,
Go/VPS remains authoritative, and production remains **NO-GO**.

## 2026-07-16 Phase 1 Bounded Container Reconciliation Observer Gate

Migration 0043 adds a default-lazy observation table and a singleton cursor;
it seeds only that cursor and does not backfill operations. Per-item claim
leases and the global scheduled-run lease both use owner/generation fencing,
strict lifecycle triggers, monotonic timestamps, and delete denial. The fair
reader freezes a high watermark and advances by `(created_at, reservation_key)`
keyset, so no OFFSET or permanently hot first page can starve later work.

The default-off scheduled observer processes 4 items by default and never more
than 8, with a 25-second wall budget, 45-second run lease, 30-second item lease,
deterministic 15-to-900-second jittered backoff, and a 24-hour dead-letter
horizon. It preserves D1 `prepared`/`dispatched` and DO `claimed`/`running`
phases, and records only bounded normalized classes and static error codes.
Its only writes are to the new observer cursor/state tables. It cannot change
an operation, billing or accounting state, a DO ledger, R2, or provider state,
and cannot retry provider execution.

The existing reconciliation flag remains false in all tracked environments;
exact-response and divergence compiled cutover claims remain false as well.
Next are bounded R2 orphan inventory, authenticated retry preview,
provider-attempt journaling, a separately gated generation-fenced apply path,
edge exact replay, the Linux canary, remote fault/N/N-1 evidence, old-writer
drain, and enforcement migration 0046. No remote action occurred. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Container Reconciliation Operator Read Gate

The Worker now exposes an AdminAuth, no-store aggregate status and a RootAuth,
no-store observation list for the 0043 Container observer. Status includes
schema/runtime state, redacted scan/run progress, state totals, due/expired
lease counts, and class totals. List pagination uses immutable observation
sequence, defaults to 20, caps at 50, and accepts only exact allowlisted status
and class filters.

Raw operation/reservation/reconciliation IDs, claim owner, provider identity,
request data, billing snapshots, quota, and credentials are never returned.
Domain-separated SHA-256 references replace the operational identities, and
inconsistent stored counters or unknown state/class values fail closed. At
that checkpoint, a Workerd test applied all 43 then-current migrations and
verified unauthenticated denial, Root access, no-store headers, filters,
aggregates, and response redaction.

These status/list routes perform only parameterized D1 reads. At that
checkpoint no retry or apply endpoint existed; the next increment below adds
preview only. R2 orphan inventory, retry apply, provider-attempt journal,
generation-fenced resolution, edge replay, Linux canary, remote faults/N/N-1,
old-writer drain, and 0046 enforcement remain open. All Container gates stay
false, no remote action occurred, Go/VPS remains authoritative, and production
remains **NO-GO**.

## 2026-07-17 Phase 1 Container Reconciliation Retry Preview Gate

The RootAuth observation list now emits a stable target made from immutable
sequence plus a domain-separated identity digest. A new RootAuth, no-store
preview route resolves the sequence through a parameterized D1 lookup and
recomputes the digest before returning any result. Missing and digest-mismatched
targets share the same 404 response.

Preview accepts only an allowlisted remediation reason and bounded evidence
reference for a valid dead-letter row. The response hashes rather than echoes
the evidence reference, contains only redacted operation/reconciliation
references, and binds its preview token to all generation, lifecycle, class,
error, timestamp, reason, action, and evidence fields. Non-dead-letter records
return 409 because the automatic observer already owns them.

This is intentionally not an execution surface. The contract reports retry
apply as uncompiled and disabled, requires future step-up, and forbids provider,
operation, billing, DO, and R2 mutation. No apply route or runtime flag exists.
Next are bounded R2 orphan inventory, a separately migrated observer-only retry
apply protocol, provider-attempt journaling, edge replay, Linux canary, remote
fault/N/N-1 evidence, old-writer drain, and enforcement migration 0046. All
Container gates remain false and production remains **NO-GO**.

## 2026-07-17 Phase 1 Default-Off R2 Orphan Inventory Gate

Migration 0044 adds three independent, generation-fenced inventory cursors and
an immutable finding ledger for Container input, result, and client-response
objects. It seeds only the three lane identities, performs no operation
backfill, and adds exact lookup indexes for existing D1 manifests. Findings
have no operation foreign key so a genuinely missing operation can be recorded.

The scheduled Worker uses one binding-level R2 LIST page per lane, defaults to
four objects with a hard limit of eight, carries the returned opaque cursor only
when `truncated` is true, requests HTTP/custom metadata, and never reads a body
or mutates an object. Recent objects are deferred for 24 hours. Key, checksum,
size, content type, and lane-specific metadata must all match the immutable
artifact contract. Exact D1 references include result provider/admission and
client response status/header provenance and resolve findings. Active or
recovery operations defer unattached artifacts. Divergent key/version
attachments remain observed; only unattached anomalies can pass the two-
completed-generation candidate gate.

An AdminAuth no-store status exposes lane progress and bounded class totals.
A RootAuth no-store list exposes only domain-separated object/operation
references and strict filters. Apply and delete are explicitly uncompiled and
no such routes exist. `CONTAINER_R2_ORPHAN_INVENTORY_ENABLED=false` in every
tracked environment; scan limit is 4 and grace is 86400 seconds. This observer
is not a Container cutover gate and does not authorize retry, cleanup,
financial/operation mutation, provider calls, remote migration, or deployment.

Next are an independently migrated retry-apply protocol, provider-attempt
journaling, edge replay, the Linux canary, isolated real-R2 fault/cost evidence,
N/N-1, old-writer drain, and enforcement migration 0046. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Default-Off Container Retry Apply Gate

Migration 0045 adds an immutable retry-event ledger and one exact
`dead_letter -> retry` transition for the 0043 observer. It is separately
gated and does not authorize provider execution, operation or financial
mutation, Durable Object writes, or R2 access. The trigger preserves immutable
identity, claim/attempt generation, attempt history, class, and recovery
deadline; clears only observer error/dead-letter fields; resets consecutive
failures; and requires at least 60 seconds of retry horizon after scheduling.

The apply route requires RootAuth, fresh step-up, 0045 schema readiness, the
state-bound preview token, one allowlisted remediation decision, a bounded
idempotency key, and explicit confirmation. Event insertion and redacted admin
audit execute in one D1 batch. Exact repeats read back the immutable event and
return `duplicate`; a stale generation, exhausted horizon, no-op trigger, or
reused old preview with a new idempotency key fails closed. The raw
idempotency key is not stored or returned.

Status now separates apply compiled, schema-ready, and runtime-enabled state.
`CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED=false` in development, staging,
and production; the flag is true only in the isolated Workerd test. Local
SQLite and Workerd evidence proves stale/horizon rejection, one event plus one
audit, exact duplicate readback, and unchanged operation, terminal/outbox,
billing, user, token, channel, and R2 state.

Remote rollout remains schema-first and disable-first: apply 0045 with the
flag false, verify exact trigger readback and zero events, then permit one
approved isolated-staging Root + fresh-step-up drill before disabling it again.
Because 0045 now owns this expand-only apply protocol, the planned legacy
identity/event enforcement migration moves to 0046. Provider-attempt
journaling, edge replay, Linux canary, real R2/Container faults, N/N-1,
old-writer drain, remote 0042-0045 proof, 0046 enforcement, rollback, and C1-C5
remain open. All eight cutover gates stay false; Go/VPS remains authoritative
and production remains **NO-GO**.

## 2026-07-17 Phase 1 Default-Off Provider Attempt Journal Gate

The isolated Controller now has a Durable Object-owned provider-attempt
journal, but the gate remains closed. After deadline recovery is scheduled,
one DO SQLite transaction starts the operation, freezes a versioned retry
policy, creates attempt 1 as `prepared`, and appends the first immutable event.
The Container-facing host exposes only strict dispatch and terminal actions.
It cannot create attempt 1, prepare a retry, select a new channel, or mutate
financial state.

Dispatch authority is consumed once and survives DO eviction. Exact replay
returns `send_authorized=false`. A prepared deadline becomes a safe
`cancelled`/failed outcome; a dispatched deadline or explicit ambiguous result
becomes `recovery_required`. Success requires an attempt-fenced R2 manifest
already attached to the operation. Definite rejection forbids a result and is
the only classification that can enter the internally tested retry waiting
state.

Status v1 is unchanged. Status v2 adds the attempt snapshot under a separately
signed path, and the Rust Worker falls back to v1 only when an older Controller
returns exact `route_not_found`. R2 result custom metadata carries gateway
schema 2 plus `attempt_generation` for journaled operations; stale or missing
generations cannot attach the result.

Tracked development, staging, and production config keeps journal, retry, and
staging verification false and max attempts at one. Runtime code additionally
rejects retry enablement or a larger maximum. The provider Service Binding
egress broker, DO retry scheduler, global D1 terminal ack, multi-attempt R2
contract, actual Linux Container client, N/N-1 deployment drill, and remote
fault evidence are still absent. Migration 0046 remains reserved for legacy
enforcement. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Default-Off Private Provider Egress Canary

The local execution plane now connects the real Rust Linux runtime client to a
private credential-owning Worker broker, but every tracked activation gate is
still false. The Container reads and re-hashes the exact owner-fenced R2 input,
then can call only `provider-egress.cinatoken.internal` through the Controller's
`outboundByHost`. Direct internet remains disabled and the real provider host
is not in the Container allowlist.

The Controller validates the immutable DO grant and exact global D1
`dispatched` row before consuming one-shot attempt authority. Only the first
committed `prepared -> dispatched` transition may call the `PROVIDER_EGRESS`
Service Binding. The broker owns one fixed, non-streaming chat-completions
profile, injects its secret internally, denies redirects, bounds request and
response bodies to 4 MiB, enforces an absolute five-minute deadline, and never
retries or interprets usage.

Success is persisted to create-only R2, attached to the same attempt generation,
and then recorded terminal. Every uncertainty after dispatch becomes a strict
202 ambiguous outcome. Dispatch replay never calls the broker; an attached
result replay finishes from durable evidence; a lost terminal RPC rereads the
DO. Tests cover success, broker loss, dispatched replay, attached-result replay,
R2-to-DO uncertainty, terminal RPC loss, disabled/malformed requests, deadline
rejection, and non-dispatched D1 admission.

`CONTAINER_PROVIDER_CLIENT_ENABLED=false` and
`CONTAINER_PROVIDER_EGRESS_ENABLED=false` join the existing false journal,
retry, and staging-proof gates. The separate broker Worker also has a false
gate, empty model, no route, and disabled development/preview URLs. No secret is
tracked, no remote deployment or provider call occurred, and no public relay
path is wired.

Before isolated staging, the migration still needs immutable egress-profile
identity, provider-native idempotency or lookup, durable upstream response
provenance, global terminal acknowledgement/compaction, exact edge replay and
financial convergence, actual Container lifecycle and R2/DO/network faults,
remote broker readiness/version readback, N/N-1, secret rotation,
load/cost/alerts, rollback, and C1-C5 approvals. Go/VPS remains authoritative
and production remains **NO-GO**.

## 2026-07-17 Phase 1 Pre-Dispatch Broker Readiness

The private provider broker now exposes one exact configuration-readiness GET
over its Service Binding. It returns ready only when the broker gate is true,
the fixed model is configured, and the API-key secret is present. Its no-store
response contains only protocol version, fixed profile, and a boolean; model and
credential values are never returned and no provider request is made.

After global D1 admission, the Controller requires that response before
consuming the DO's one-shot dispatch. The read is capped at two seconds and
1 KiB and rejects non-200, wrong headers/profile, non-JSON, extra fields, or
transport failure. Direct gateway failure is 503 with zero dispatch. If the
Linux runtime reports conservative recovery, the still-prepared DO attempt is
cancelled as provably unsent rather than marked ambiguous.

Compiled Workerd tests exercise ready, disabled, missing-model, missing-secret,
wrong-method, and wrong-profile cases against the Rust Wasm Worker. This closes
the local configuration-readiness gap only. Credential validity, provider
reachability, deployment-version affinity, remote readback, immutable D1/DO
egress-profile identity, provider idempotency/lookup, actual Container faults,
and production canary evidence remain open. All tracked gates stay false;
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Provider Broker Version Affinity

The private broker now preserves the exact three-field readiness v1 body and
exposes its actual `CF_VERSION_METADATA.id` in a private response header. Local,
staging, and production declare the binding explicitly and the enabled broker
fails closed without it.
The Controller sends readiness and execute with the same
`Cloudflare-Workers-Version-Key`, derived from the immutable provider operation
identity, but treats affinity as routing assistance rather than a version lock.

Before the only provider POST, `dispatchProviderAttemptV2` atomically stores the
fixed broker profile and readiness Worker version in the shard DO attempt and
append-only event log. The execute response must return that exact version.
Execute protocol v2 first sends the committed version back to the broker, which
rejects a runtime mismatch before secret access or provider I/O. Missing or
different post-dispatch evidence still becomes
`provider_egress_version_ambiguous`, writes no R2 result, and cannot retry. A
successful result uses R2 custom metadata schema 3 with the same identity.

Legacy DO rows and the old dispatch RPC remain readable with a null version
identity, and R2 metadata schemas 1 and 2 remain valid. The Rust inventory
reader now validates schemas 1/2/3 independently, including a Workerd schema-3
scan. Broker N can therefore roll out before Controller N without breaking the
N-1 readiness body; rollback reverses that order. An old DO without the V2 RPC
fails before send. No D1 migration was used, so 0046 stays reserved and
global D1 egress provenance remains a later 0047 task. Remote version readback,
mixed-version proof, full edge/controller/DO/container provenance, provider
idempotency, real faults, and production evidence remain open. All gates stay
false; Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Global Terminal Acknowledgement

The existing D1 financial terminal outbox now has a bounded local path to the
owning shard Durable Object. The scheduled Worker claims rows with a
generation-fenced 30-second lease, scans four by default and eight at most,
retries transient failures with capped exponential delay, and dead-letters only
explicit permanent conflicts. Revision 2 remains blocked until revision 1 is
delivered.

The private Controller request is signed over its exact 4 KiB-bounded JSON body
and contains only terminal event, operation, optional result manifest, shard,
and trace identity. It omits financial mutations, audit/client payloads, and
credentials. Controller responses are strict no-store JSON and every echoed
identity is checked before the D1 lease can become delivered. Old Controllers
return exact route-not-found and the row safely retries.

The shard ledger stores canonical acknowledgement evidence transactionally in
a dedicated table that does not depend on provider journaling. Exact replay is
idempotent, including the locally proven response-loss case where the retry
receives `duplicate`. Recovery revision 1 is non-final; revision 2 must
name the predecessor and is checked against the frozen recovery snapshot while
the DO operation stays `recovery_required`; an exact recovery result manifest
is legal. A separate `compaction_authorized_at` field remains null, and the
false compaction gate short-circuits both age and count deletion, so
acknowledgement cannot release terminal history.

The financial writer's first transactional insert also requires the exact
revision-1 predecessor before revision 2. Missing evidence leaves all dependent
outbox, operation, billing, and accounting writes unchanged. This is a
writer-side guard only: migration 0046 remains reserved for database-level
enforcement after old-writer drain and deployed-version proof.

The edge producer/staging gates and Controller acknowledgement/compaction gates
are false in every tracked environment. Operators have an admin-only aggregate
outbox status endpoint with no event or operation identifiers. No D1 migration
was added and 0046 remains reserved.

This is local acknowledgement and retention evidence only. Remote schema and
binding readback, key rotation, mixed-version rollout, real Container/network
faults, provider-native idempotency or lookup, end-to-end provenance, exact
edge replay, financial convergence, load/cost/alerts, rollback, and approvals
remain open. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-17 Phase 1 Financial Terminal Enforcement Gate

This section supersedes the preceding statement that migration 0046 is only
reserved. The local D1 chain now contains 46 contiguous migrations with
`0046_relay_container_financial_terminal_enforce.sql` as its head. The new
migration is trigger-only and rejects new protocol-v1 legacy identities,
non-`prepared` initial operations, terminal updates without an exact immutable
event plus outbox row, and revision-2 events without the exact revision-1
recovery predecessor. It does not rewrite historical rows or alter pricing.

The Worker repository contains a future schema-readiness helper that requires
migrations 0040, 0041, 0042, and 0046 plus all four exact trigger names. It is
compiled and source-tested but has no production call site; the active status
capability still uses the exact migration set, and every Container operation
path remains default-off and unwired. Local SQLite replay and the readiness CLI
self-test cover real 0001-0045/0046 SQL replay, direct terminal insert,
eventless and outbox-less update, legacy identity, pre- and post-`Tdrain` open
operations, migration drift, trigger set drift, and exact trigger-body drift.

Remote sequencing remains blocked and ordered: apply only through 0045 with all
gates false; deploy and inventory the 0046-compatible candidate at `Tdeploy`;
remove and read back every old owner, then establish `Tdrain`. Any old owner
reappearance invalidates the signed inventory, digest, preflight, and drain
clock; recollect and resign before restarting. Compute the old-writer window
from every Worker, request, Queue, Cron,
alarm, deployment, operation deadline, and owner lease upper bound plus margin;
then run the read-only preflight for at least that window. Its 86,400-second
floor is not a substitute for the calculation. The report must be bound to the
signed deployment inventory hash and must show the exact 45-row migration set,
no 0046 trigger, no open protocol-v1 operation from either side of `Tdrain`, and
zero contract anomalies. `snapshotReady=true` is a single D1 snapshot and the
report always returns `authorizesEnforcement=false`; signed continuous-owner
evidence and named approval remain external gates.

Only after every target-D1 writer is frozen and a pre-apply disaster-recovery
Time Travel bookmark plus full application-data fingerprint is archived may
staging apply 0046 against the revalidated account/name/UUID/environment,
rerun the post-audit against the exact 46-row/four-trigger set and exact
normalized trigger bodies, and execute direct negative probes as atomic
all-or-rollback batches that match the intended statement ordinal and exact
0046 error, reject ambiguous outcomes, and are followed by full fingerprint
comparison. A
destructive restore after failed validation requires data-owner/SRE approval
and proof that every application table is unchanged; `version: production`,
retention-valid bookmark, target UUID, all-writer freeze, and archival of the
restore's previous/undo bookmark are also mandatory. The exact 0046 ledger row
and four trigger definitions are the only permitted logical differences. Any
application DML, incomplete full-database evidence, or uncertain provenance
requires quarantine plus reviewed forward repair. Normal rollback never
removes 0046 or reintroduces a pre-0046 writer; an 0046-compatible Rust recovery
artifact remains available for existing D1 work.

A clean postflight permits only controlled restoration of the pre-inventoried
non-Container D1 writers with phase-correct capability readback, exact owner
inventory, and unchanged Container-table fingerprints after every wave. Every Container
gate remains false, and postflight success grants no traffic or financial
authority.

The database gate does not close two billing cutover blockers: time-derived
pricing facts still need a frozen evaluation instant (or disabled time
functions), and tiered settlement needs a durable canonical reservation
snapshot that survives Worker loss. No remote D1 mutation, deployment, secret
change, provider call, financial mutation, or traffic switch occurred. Every
Container gate remains false; Go/VPS remains authoritative and production
remains **NO-GO**.

## Migration 0047 Provider-Egress Authority

The local D1 head is now 0047. The new immutable
`relay_container_provider_egress_grants` row is created after private broker
readiness but before DO attempt dispatch or provider I/O. A `first-primary`
session performs an exact `INSERT OR IGNORE ... SELECT` from the live operation
and reservation, then compares a complete readback. Missing schema, stale
authority, changed broker version/profile, changed request/R2/billing identity,
or ambiguous readback fails before the one-shot send boundary.

New tiered reservations now persist a canonical group snapshot with a frozen
evaluation instant and bounded expression-referenced scalar request facts.
Sensitive headers/content paths, structured values, dynamic lookup keys, and
DST-dependent timezones are rejected before reserve. HTTP and Realtime use the
strict snapshot-only settlement API; D1 rejects empty or cross-group-divergent
new tiered contracts.

This is not financial recovery completion. Actual usage is not yet durably
captured at the egress boundary, historical empty snapshots remain legacy, and
the terminal event is not yet linked to the grant. Production rollout still
requires 0046 completion, old-writer drain, isolated 0047 apply/readback,
broker-first/Controller-second N/N-1 proof, real Linux/R2/provider faults,
usage receipt recovery, idempotency/lookup, convergence, rollback, load/cost,
and approvals. All Container gates remain false; Go/VPS is authoritative and
production remains **NO-GO**.

## Migration 0048 Immutable Provider Usage Receipt

This section supersedes the 0047 statement that provider usage is not captured
at the egress boundary. The local D1 head is now 0048. For a bounded
non-streaming chat-completions response, the private egress Worker drains the
entire upstream body under the same absolute provider deadline, parses usage,
and returns an immutable canonical receipt plus its SHA-256 in private headers.
It never forwards upstream `Cache-Control`; the final projected response is
always forced to `no-store`.

Receipt v1 is exact, not extensible by accident. Its canonical JSON contains
these 38 fields in wire order:

```text
schema_version, parser_contract, normalization_contract, source, estimated,
operation_id, owner_generation, attempt_generation, provider_operation_id,
request_sha256, egress_profile, egress_worker_version_id,
provider_response_status, provider_response_sha256, provider_request_id,
provider_completed_at, usage_present, reported_usage_fields, prompt_tokens,
completion_tokens, total_tokens, cached_tokens, cache_creation_tokens,
cache_creation_tokens_5m, cache_creation_tokens_1h, image_input_tokens,
image_output_tokens, audio_input_tokens, audio_output_tokens,
is_anthropic_usage_semantic, usage_semantic_source, provider_cost_usd,
cache_creation_source, responses_web_search_calls,
responses_file_search_calls, claude_web_search_calls,
image_generation_quality, image_generation_size
```

The fixed constants are schema 1,
`openai-chat-completions-usage-v1`,
`billing-token-normalization-v1`, `provider_response`, `estimated=false`, and
`openai-chat-completions-canary-v1`. Canonical JSON is limited to 8,192 bytes
and its unpadded base64url header to 12,288 bytes. The eleven-bit
`reported_usage_fields` mask is: bit 0 prompt, 1 completion, 2 total, 3 cached,
4 aggregate cache creation, 5 five-minute cache creation, 6 one-hour cache
creation, 7 image input, 8 image output, 9 audio input, and 10 audio output.
The maximum is 2047. Missing fields normalize to zero with the bit clear;
reported zero retains the bit. `usage_present` is true exactly when bits 0 and
1 are set. Flat settlement derives its checked total from prompt plus
completion even when bit 2 is clear.

The frozen tiered expression or flat snapshot determines which priced bits are
mandatory. Cached, cache-creation, image, and audio categories required by the
selected contract must be reported; absence rejects settlement instead of
pricing zero. Tiered tool/image-generation settlement is still unversioned and
rejects. OpenAI-semantic `cc1h` expressions also reject because that variable
is Anthropic-only. Estimated usage, noncanonical JSON, unknown mask bits, hash
or identity mismatch, missing prompt/completion, out-of-range raw token values,
non-finite tiered results, the flat `i64::MAX` overflow sentinel, and a nonzero
value with its bit clear all fail closed.

The durable order is R2 create-only result write, D1
`INSERT OR IGNORE` plus exact same-session readback, then shard-DO result
attachment. R2 metadata schema 4 carries the receipt hash. D1 stores the exact
receipt/result/grant/billing identity and a separate append-only identity
ledger; it blocks update/delete and also blocks `INSERT OR REPLACE` when SQLite
recursive triggers are disabled. The terminal event must bind receipt hash,
result hash, and attempt 1. Its client status and the completed operation status
must equal the provider status. A provider-status 202 receipt may remain as
evidence, but cannot complete or settle.

This is intentionally incompatible with a true 0047 settle writer after schema
0048: missing receipt linkage is rejected. Before 0048 can be applied to an
active target, every 0047 writer and in-flight provider operation must be
inventoried, removed, read back, drained, or quarantined while all gates remain
false. Rollback is disable-first and retains schema, receipt/identity rows,
triggers, R2 evidence, and migration history; an older artifact may return only
when it cannot receive provider traffic.

Production is still **NO-GO**. D1 does not independently evaluate arbitrary
billing expressions or attest the final amount; the DO ledger does not yet
store/compare the receipt hash; reconciliation does not close the
R2/D1/DO/terminal/provider-invoice hash loop; no production terminal caller is
enabled; provider-native idempotency/lookup is absent; and the
post-provider/pre-R2 crash window remains ambiguous. No remote schema apply,
deployment, binding, secret, provider canary, or traffic change has occurred.
Go/VPS remains authoritative and all Container gates remain false.

## Migration 0049 Provider Usage Binding and Convergence Guard

This section supersedes the 0048 statement that the shard DO and local
reconciliation path do not bind the provider usage receipt. The local D1 head
is now 0049. The bounded canary path closes the local R2/D1/DO/terminal loop;
it does not add provider-invoice evidence or independent D1 amount authority.

The Controller persists a provider result in this order: create-only R2 object
with metadata schema 4, exact D1 receipt read-before-write/readback, atomic
shard-DO result-and-receipt attachment, then provider-attempt terminal state. The DO
stores the same receipt hash on both the operation and active attempt. SQLite
guards permit only the one-time `NULL -> hash` attachment, keep the result and
hash inseparable, and make the hash immutable. The old optional
`recordStorageResult` provider path is rejected even when its caller omits the
attempt generation.

Post-send replay is read-before-write. A non-prepared attempt first reads and
revalidates the canonical D1 receipt, including canonical JSON, admission,
request, egress Worker version, provider status, R2 result manifest, and
receipt digest. Missing or temporarily unavailable evidence and an `existing`
dispatch return non-mutating recovery and never send a second provider request;
only a
verified row/hash/identity conflict terminalizes the attempt as ambiguous. This
lets the first in-flight provider request complete under a concurrent replay.
An exact existing D1 receipt is returned read-only, so a post-convergence
replay never issues INSERT. If D1 is exact but the DO attachment response was
lost, the Controller attaches or exactly replays the result/hash pair and then
records terminal state. Provider status 202 remains ambiguous and cannot be
converted into success.

The signed Controller status contract is now v3. Status v1 and v2 retain their
exact historical response shapes; v3 adds the operation receipt digest plus
the attempt digest and attachment time. The terminal acknowledgement endpoint
has a v2 signed domain/path and carries the explicit tuple
`{attempt_generation, receipt_sha256, result_sha256}`. A receipt-bearing
operation cannot be acknowledged through v1 or with a null/divergent tuple.
Historical operations without receipts remain readable and may use the legacy
contract. Status v3 itself accepts a succeeded historical operation only when
the root digest, attempt digest, and attachment time are all null; a D1-backed
receipt still requires the exact non-null v3 tuple before convergence.

The Worker observer reads status v3 first, verifies the canonical D1 receipt
and terminal tuple, and performs a read-only R2 HEAD against exact metadata
schema 4. It may record `converged_replayable` only when D1, DO, R2, and the
terminal event expose the same attempt, receipt digest, and result digest.
Missing v3 evidence, v2/v1 fallback for a receipt-bearing operation, a missing
R2 object, or any single-bit divergence fails closed.

Migration 0049 expands reconciliation observations with canonical receipt and
result identity plus DO, R2, and terminal evidence. Receipt-backed historical
non-terminal rows become `pending`; historical converged rows are retained but
marked `divergent` because 0049 cannot invent external proof. An old observer
may continue retry/dead-letter transitions, but D1 rejects its attempt to
converge a receipt-backed row without `matching` four-store evidence. Matching
and canonical evidence becomes immutable.

Every receipt INSERT after an observation is converged remains blocked,
including an identical `INSERT OR IGNORE`; exact replay is the Controller's
read-only path. Reconciliation readiness composes the full 0047/0048 provider
grant/receipt guard check and then verifies 0049 plus the rebuilt lifecycle
trigger still contains the audited 0045 retry-event state machine.

Rollout is default-off and ordered: freeze provider/terminal/reconciliation
writers; drain or quarantine in-flight provider work; archive a pre-apply D1
bookmark and complete writer inventory; apply/read back 0049; deploy and read
back the 0049-aware Controller and Worker; prove status v3, ACK v2, R2 HEAD,
duplicate/lost-response/eviction/version-skew faults in isolated staging; then
consider a gated canary. N-1 must not receive provider traffic and must not run
receipt-backed convergence. Normal rollback disables admission, provider,
terminal, and reconciliation first, retains 0049 schema/evidence/triggers, and
returns only to an artifact that cannot exercise the incompatible paths.

Production remains **NO-GO**. Provider-native idempotency or lookup and the
post-provider/pre-R2 ambiguity remain unresolved. Provider invoice comparison,
independent D1 billing-expression/final-amount authority, a proven production
terminal caller, remote migration/readback, real fault/load/cost/alert data,
rollback rehearsal, and C1-C5/G1-G8 approvals are still absent. No remote
schema, deployment, binding, secret, provider, financial, or traffic action is
authorized by this local increment; Go/VPS remains authoritative and every
Container gate remains false.

## Default-Off Edge-to-Shard Chat Canary Foundation

The Phase 1 edge now contains a locally compiled orchestration foundation for
one exact API-key, non-streaming `/v1/chat/completions` cohort. It freezes the
transformed body in R2, derives HMAC-scoped idempotency and deterministic shard
identity, binds the selected attempt, dispatches only after a global D1 CAS,
requires status v3 plus the immutable provider receipt, reads exact R2 bytes,
and uses the atomic financial terminal writer before replaying the client
artifact. `AlreadyDispatched` is query-only, while `prepared` may retry only
the dispatch CAS. Browser preflight now permits `Idempotency-Key`.

This is not an activation milestone. `container_chat_canary_admission_compiled`
is false because quota reservation, selected-attempt binding, and operation
preparation are still separate commits. A client retry can otherwise encounter
a reserved-but-unbound state. The code-level gate is required in addition to
`CONTAINER_SCHEDULER_ENABLED`, every operation gate, the empty token/model/
channel cohort, and the two secret-readiness checks. Malformed cohort input is
off and cannot fail unrelated relay routes.

The next Phase 1 data task is planned migration 0050, if schema changes are
needed, to atomically admit or resume reservation plus operation state. It is
followed by an owner-fenced autonomous terminalizer, source-parity non-2xx and
response interpretation, N/N-1 or blue/green protocol rollout, real
`RelayShardContainer` lifecycle tests, and isolated remote staging evidence.
All tracked gates remain false; no remote mutation occurred; Go/VPS remains
authoritative and production remains **NO-GO**.

Phase 1 acceptance remains blocked until all of the following are archived:

- atomic reservation/selection/operation admission with resumable matching;
- a request-usable complete scheduler-cutover predicate, not partial flags;
- autonomous owner-fenced terminalization without a client retry;
- durable non-2xx and source-parity response/error/usage behavior;
- N/N-1 protocol range or isolated blue/green rollout;
- provider idempotency/lookup and independent amount/invoice convergence; and
- real D1/R2/DO/Container faults, lifecycle, load/cost, alerts, rollback,
  security review, and C1-C5/G1-G8 approval.

The detailed contracts are migration plan section 22.243,
`docs/container-operation-recovery.md`, the 0049/canary readiness matrices,
and the matching entry in `docs/verification.md`.

## Migration 0050/0051 Atomic Admission And Scheduled Terminalization

This section supersedes the earlier Phase 1 next-task statement. Migration 0050
now provides local atomic admission and migration 0051 now provides local
owner-fenced scheduled settlement for one exact completed operation. Both are
implementation milestones, not activation milestones. No remote migration,
deployment, secret, provider, financial, alarm, or traffic action occurred.

The 0051 terminalizer remains disabled unless
`CONTAINER_SCHEDULED_TERMINALIZER_ENABLED` and
`CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED` are both exact `true`.
Existing Container operation replay authority, `FILE_BUCKET`, the compiled
bounded observer, and complete 0051 schema readiness are also mandatory. A live
Controller probe must prove probe/binding/authority, verified status, controller
enablement, and execution enablement before the scheduled run claims an item;
the capability endpoint uses the same probe. Both new gates remain false for
every tracked environment, and the final canary admission source gate remains
false.

Only an observation lease owned by the current claim generation may settle.
The D1 operation must be `dispatched` or `recovery_required`; Controller status
must be exact `Completed` and classified `DefinitiveTerminal`; status-v3 with no
v1/v2 fallback, provider receipt/result, R2 result, immutable 0050 admission,
reservation, operation, frozen quote and client response must converge. Results
above the 4 MiB replay ceiling are rejected from the manifest before the body
is buffered. The terminalizer does not claim, dispatch, wake, retry, or resend
the provider.

The final D1 batch contains terminal event, outbox, user/token/channel
accounting, operation completion, reservation settlement, and immutable 0051
evidence. The evidence insert verifies the active owner/generation, exact frozen
claim expiry, lease/recovery horizons against D1 transaction-time `unixepoch()`,
and complete same-batch result. Any failure rolls back all D1 effects. The
earlier R2 client artifact is non-authoritative until D1 commits and may become
bounded orphan inventory.

Financial audit schema v2 is shared by client and scheduled replay and is
derived from the persisted reservation/operation. It keeps the frozen
`request_id_hash` but excludes current request ID/CF Ray and client IP. Typed
terminal failures preserve exact codes: unavailable stores and missing replay
material remain bounded retries, while divergent response evidence, contract
violations, and conflicting financial decisions dead-letter immediately.

Crash handling is explicit: pre-commit crashes leave no financial decision and
are reclaimed after lease expiry; post-commit response loss is resolved from
the immutable terminal/0051 tuple; stale owners cannot commit; duplicate
schedules reobserve the completed operation without a second provider or
accounting action. Rollback disables both new gates first, preserves 0050/0051
and all evidence, drains or quarantines owners, and routes new traffic to
Go/VPS.

Phase 1 still cannot graduate until isolated staging proves:

- authenticated 0050/0051 apply and exact schema/capability readback with all
  action gates false;
- same-batch failure at every statement, lost-response readback, exact frozen
  lease expiry plus D1-clock rejection, duplicate Cron/alarm and zero partial
  accounting;
- stable logical-shard object identity plus a separately approved jurisdiction,
  one frozen DO class lifecycle mode (declarative `exports` or retained legacy
  migrations),
  bounded idempotent cold start, single at-least-once alarm ABI N/N-1, and full
  cross-layer provenance;
- real D1/R2/DO/Controller/Container eviction, restart/OOM, pre-body 4 MiB
  rejection, missing/divergent/orphan and transient/permanent classification,
  stable client/scheduler audit digest, rolling-version and rollback faults
  with one provider call at most;
- provider-native idempotency or deterministic lookup, shared non-2xx response
  semantics, independent amount authority and provider-invoice convergence;
- R2 retention, load/cost/SLO/alerts, security/privacy/data review,
  disable-first rollback, and C1-C5/G1-G8 approvals.

The local alarm/bootstrap substrate is now implemented. Remaining production
blockers are real Container/package lifecycle and jurisdiction proof, frozen
class lifecycle, end-to-end provenance, the shared response interpreter,
provider ambiguity authority, and independent financial attestation. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-18 Phase 1 Durable Container Alarm Bridge

The local Controller now persists deadline intent before scheduling whenever
both new writer gates are enabled. Claim and the first unarmed v1 intent share
one DO SQLite transaction; cold start and operation replay can rearm an
unarmed intent. Legacy three-field schedules remain readable, while strict v1
adds shard and delivery-generation fencing. Early, duplicate, late, stale, and
failed callbacks converge, retry at most eight deliveries within 24 hours, or
quarantine without provider or financial I/O.

Both `CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED` and
`CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED` remain `false` in
local, staging, and production configuration. Reader/rearm compatibility is
always present. The state is local to each SQLite DO and adds no D1 migration
0052. `@cloudflare/containers` remains the only alarm owner; the subclass uses
`schedule()` and never overrides `alarm()`. Version 0.3.7 catches callback
exceptions and deletes the one-shot schedule, so application retry/quarantine
must be persisted and rescheduled before callback return. If persistence or
rescheduling fails, the object aborts the invocation before package cleanup can
commit.

Execution has no new legacy-v0 writer path. The outer Controller and shard DO
both reject execution before claim unless both v1 gates are exact `true`, and
readiness reports false for either half-enabled combination. V0 remains readable
only for existing schedules and compatible rollback.

Phase 1 has local proof for pure v0/v1 parsing and Workerd SQLite eviction,
replay, terminalization, retry, mismatch, and migration-ledger behavior. It
does not yet have a real `RelayShardContainer`/Linux Container alarm lifecycle
fixture or remote evidence. Before either writer gate changes, staging must
deploy the reader everywhere, isolate N-1, exercise real callback deletion and
restart/OOM faults, read back both gates, and prove zero provider/financial
delta.

The next implementation milestone is a shared Go-parity response interpreter:
exact HTTP-200 success policy, HTTP-200 typed errors, compatible non-200 error
envelopes/header filtering, and interrupted-stream usage settlement. Stable
logical-shard naming stays canonical; jurisdiction selection and provenance
remain separate blockers. Production remains **NO-GO**.

## 2026-07-18 Phase 1 Response Interpreter Contract

Response parity now has a pinned source and versioned ABI. Go commit
`73652508abc5cb09214dde02d51d69d1d1ccc703` is authoritative and the Rust
contract is `go-openai-response-v1`. The pure `crates/relay` foundation freezes
exact-200 success, typed errors inside HTTP 200, malformed-success handling,
Go-compatible non-200 envelopes, a six-header success allowlist, zero error
header forwarding, success-only usage, and independent stream-fault/usage
facts.

This closes only the semantic foundation. Container canary remains blocked by
the lack of separate durable raw-provider evidence and interpreted client
artifacts. Receipt v1 stays immutable; response-artifact migration 0052,
protocol v3, a new DO interpreted-reject shape, exact financial terminal
linkage, remote fault evidence, and approvals remain future conjunctive gates.
The detailed sequence and abort conditions are frozen in
`docs/response-interpreter-production-plan.md`.

The response packet does not change either Durable Alarm Intent v1 gate. The
alarm bridge remains DO-local and still needs no D1 schema of its own; the new
0052 reservation applies only to future response evidence. All execution,
provider-egress, and canary gates stay false. Production remains **NO-GO**.

## 2026-07-18 Response Evidence P2 Phase Update

This update supersedes the preceding statements that separate response
artifacts remain future work or that global D1 head is 0051. P1 shared
interpretation and P2 evidence storage now exist locally. The alarm bridge
itself still needs no global D1 schema, and no action gate is activated.

| Boundary | Local evidence | Remaining production gate | Status |
| --- | --- | --- | --- |
| D1 0052 | Drained old-writer apply fence; separate immutable raw/client records and identity ledgers; terminal/convergence guards; exact schema fingerprints and negative fixtures | Authenticated account/name/UUID-bound staging apply/readback after every pre-0052 writer and operation is drained | Local candidate |
| R2 evidence | Distinct provider/client namespaces, server-derived keys, 4 MiB bounds, create-only conditional writes, exact replay/conflict checks | Real R2 response-loss/concurrency/orphan/divergence campaign with retention and cost evidence | Local candidate |
| Inventory | Separate immutable cursor/finding ledgers, provider/client classification, observe-only and hard-zero apply/delete authority | Reviewed scanner, default-false activation, alerts, retention disposition, and proof it cannot mutate authoritative rows or objects | Schema only; inert |
| Protocol v3 | Exact envelope, Rust encoder, Controller verifier/store/replay, DO schema migration 3, and runtime rejected outcome are locally verified and default-inert | N/N-1 or isolated blue/green proof plus P4/P5 promotion evidence | Local candidate (P3) |
| Financial terminal | 0052 can bind an artifact to existing successful terminal evidence | Add typed-200/non-200 interpreted reject and exact-200 success ownership with one immutable financial CAS/outbox/audit decision | **Blocked (P4)** |
| Remote proof | No Cloudflare state changed | Reader-first apply/deploy, real Container/DO lifecycle and faults, provider-call counter, load/cost/SLO/alerts, rollback, security and approvals | **NO-GO (P5)** |

The current development order is P3 protocol, P4 terminal ownership, then P5
staging proof. Go/VPS remains the traffic and financial authority.

## 2026-07-18 Response Protocol P3 Local Candidate

P3 is now implemented as a local, default-inert candidate. This supersedes the
preceding table row that described the protocol-v3 encoder, verifier, DO schema,
runtime rejected outcome, and exact replay as unimplemented. It does not
supersede any P4, P5, production, or approval blocker.

The local boundary now contains all of the following:

- a canonical Rust protocol-v3 envelope for exact success, typed HTTP-200
  error, non-200 HTTP error, and invalid HTTP-200 body;
- an exact TypeScript reader that rejects mixed versions, noncanonical JSON,
  invalid UTF-8/base64url, duplicate/reordered/unknown fields, dishonest sizes,
  digest drift, and contradictory receipt or interpretation facts;
- a Controller pre-dispatch 0052 schema/authority/recovery preflight before
  readiness, DO dispatch, or provider I/O;
- phased raw and client writers using create-only R2 objects and append-only D1
  rows, with exact readback and conflict handling at every boundary;
- the 0048/0052-compatible success order: raw R2/D1, client R2, byte-identical
  `container-results/v1` with exact `application/json`, immutable usage receipt,
  client D1, DO result/receipt attachment, then DO response-manifest attachment;
- receipt-less success rejected before raw R2, preventing a knowingly
  unrecoverable partial success inventory;
- error paths that never create the compatibility result or success receipt;
- DO-local schema migration 3 and immutable generation-fenced attachment of
  separate raw/client manifests, provider/client status, response class, and
  optional success receipt digest; and
- a Linux runtime `Rejected` outcome with outer 422, while provider 202 remains
  an interpreted HTTP error and runtime recovery remains outer 202.

Pre-dispatch recovery distinguishes `none`, `raw_only`, and `complete` using
strict D1 readback. A complete row can reconstruct and attach the canonical DO
record without R2 body access or provider I/O. A raw-only, R2-only, existing
dispatch, unavailable readback, or integrity conflict cannot authorize another
provider call. Live parse-only and raw-only runs are quarantined as ambiguous;
complete P3 artifacts remain recovery-required until P4 owns the terminal
decision.

The current P3 rollout cap is narrower than the frozen 4 MiB storage schema:
protocol-3 egress reads at most 1 MiB of provider bytes and Controller reads at
most a 3.2 MB envelope. Exact `content-length` preallocation, canonical text
comparison without a duplicate byte array, and removal of decoded base64 text
preserve concurrency headroom under the shared 128 MB Worker isolate limit.
Raising these bounds requires a streaming/direct-persistence design and remote
memory/load evidence, not only a configuration change.

The four rollout gates remain independent and exact `false` in default,
staging, and production configuration:

- `CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED`;
- `CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED`;
- `CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED`; and
- `CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED`.

Gate coherence is fail-closed: raw requires parse, client requires raw, and
terminal requires client. Because P4 is not present, terminal `true` is rejected
before provider I/O even when all preceding gates are true. No tracked
configuration enables a P3 writer.

P4 is now the next code milestone. It must atomically bind exact-success or
interpreted-reject evidence to one financial disposition, terminal event,
outbox, audit digest, client/scheduler replay result, and DO/global convergence
decision. P4 must preserve receipt v1 compatibility for exact success, keep
typed/non-200 errors receipt-free, and inject crashes before and after every
financial statement, DO ACK, and delivery boundary. P5 remains the isolated
reader-first Cloudflare migration, real lifecycle/fault/load/cost campaign,
disable-first rollback drill, security review, and signed approvals. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-18 Financial Terminal P4 Local Candidate

P4 is now implemented and verified locally as a disabled candidate. This
supersedes the preceding `Blocked (P4)` financial-terminal row, but no remote or
production gate has changed.

| Boundary | Local P4 evidence | Remaining production gate | Status |
| --- | --- | --- | --- |
| Status ownership | Controller status v4 atomically binds operation, attempt, provider interpretation, raw evidence, client artifact, and optional usage receipt | Authenticated staging readback and mixed-version evidence | Local candidate |
| D1 terminal | Migration 0053 adds a drained, immutable financial-terminal-v2 contract and exact success/reject/refund guards | Remote apply after every old writer and active operation is drained | Local candidate |
| Financial result | Exact 200 success settles; typed, HTTP, and invalid-body rejects refund fully without request accounting; ambiguity remains recovery | Real accounting reconciliation and fault-injection evidence | Local candidate |
| ACK and replay | ACK v3 binds response-backed final outcomes; unbound recovery stays on ACK v2; client bytes replay from the immutable artifact | Real DO/Worker response-loss, alarm, retry, and rollback campaign | Local candidate |
| Artifact proof | Worker verifies exact R2 key/version/checksum/size/content type, 12 metadata fields, bounded body hash, and client artifact identity | Real R2 concurrency, loss, retention, and cost proof | Local candidate |
| Remote promotion | No Cloudflare state changed; every rollout flag remains false | Reader-first P5, lifecycle/load/cost/SLO, security/privacy, rollback, and approvals | **NO-GO (P5)** |

The terminal transaction has one owner and one immutable event/outbox/audit
identity. Replays must match exactly; partial or contradictory evidence cannot
settle, refund, deliver, or authorize another provider request. The complete
local aggregate passes with D1 head 0053 and 837 Worker tests. Go/VPS remains
the traffic and financial authority until P5 is completed and approved.

## 2026-07-19 P5 Evidence Gate Local Candidate

P5 now has an offline, fail-closed evidence contract. It requires one canonical
candidate plus ten exact evidence kinds and five independent Ed25519 owner
approvals. Artifact hashes, freshness, candidate identity, reader-first order,
0054 schema, lifecycle/financial faults, provenance, load/cost/SLO, rollback,
and security/privacy are verified together rather than accepted as separate
free-form reports.

The local contract suite passes 42 tests. It rejects noncanonical JSON,
candidate or artifact drift, stale evidence, customer traffic, writer-before-
reader ordering, incomplete lifecycle/provenance, duplicate provider or
financial effects, non-conserving response/settle/refund counts, elapsed cohort
windows, request accounting on refunds, weak load, unsafe rollback, path
traversal or symlink evidence, same-directory trust-policy aliases, duplicate
public-key material, and missing, premature, inverted-window, wrong-role, or
tampered approvals.

Three Controller configs now use the same configured D1 names as their edge
environment, and configuration tests bind the same D1 name/ID, CONFIG_KV,
FILE_BUCKET, and Controller Service Binding values across both planes.
Production IDs remain placeholders and are not authenticated identities.
The deploy path now adds a separate 18-test preflight that rejects placeholders,
zero IDs, public entrypoints, disabled observability, enabled action gates, and
missing remote secret names before Wrangler can deploy the Controller.

This is verifier implementation, not remote P5 evidence. A complete packet can
only become eligible for human review of an isolated staging synthetic canary;
it cannot authorize customer traffic or production. Authenticated collectors,
real faults/load/rollback and approvals remain open. Production cutover also
requires the separately documented Go/VPS process-state drain and reversible
data path. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-19 P5 Foundation And Production Drain Contracts

Phase 1 now includes the missing collection boundary behind the offline P5
verifier. Foundation collector version 4 is staging-only, uses 13 fixed direct
Cloudflare API GET requests, and captures exact control-plane digests before
and after a bounded observation window. A dedicated rotated readback token is
injected only into in-memory Authorization headers after the credential-free
request plan is validated; no credential, raw response, cursor, payload,
account ID, KV ID, or Container application ID is emitted.

The collector fails closed unless the before/after snapshots are complete and
stable and the same window includes app-owned shard-registry, action-gate,
SBOM/signature, R2 writer/object, and traffic-isolation sources. Container
instance visibility alone is explicitly insufficient because sleeping Durable
Objects are outside that running inventory. P5 candidate-freeze and
remote-inventory records must bind the same capture and pagination result.

The Go/VPS production drain is now a separate offline evidence contract rather
than a prose-only elapsed-time check. It requires all HTTP, SSE, WebSocket, and
task-submit ingress to drain; every process-owned BillingSession/refund/batch
map to reach zero; successful persistence and export windows; stable SQL and
LOG_DB snapshots; unique scheduler ownership; zero forward/reverse
reconciliation delta; complete task/order disposition; and measured rollback.
A complete packet is review input only and never authorizes cutover.

Focused local verification passes 44 P5 evidence tests, 24 foundation collector tests,
23 Go/VPS cutover tests, and 22 shared subprocess/deploy-preflight tests. No
authenticated collection or remote mutation occurred. Phase 1 remains
production **NO-GO** pending real staging and Go/VPS evidence.

## 2026-07-19 P5 Shard Activation Ledger v1

Phase 1 now has a local, default-disabled implementation for the stable
app-owned shard inventory required by P5. Migration 0054 adds an immutable
global activation ledger keyed by Controller version, runtime build, ring, and
shard. The Controller records only a live, healthy readiness result whose
runtime build exactly matches the configured candidate. Legacy readiness stays
readable for rollout compatibility but cannot create an activation row.

The root-only Worker inventory endpoint uses a frozen D1 high watermark and
bounded keyset pagination. It validates the canonical instance name, protocol
and gate facts, and cross-runtime SHA-256 before returning a row. It performs no
DO lookup and cannot wake a Container.

The P5 shard collector derives readiness from each canonical shard index and
compares complete before/after records. Source bundle v2 binds the actual
capture digest, candidate Controller version, runtime build, image digest, and
runtime-to-image provenance. Shard count is capped at 1024. A claimed
`verifiedShardCount` can no longer substitute for the entries.

The signed P5 subject now binds the actual canonical
`evidence/foundation-capture.json` file by path, size, and complete SHA-256.
The verifier recomputes its subject digest and requires its two fact objects to
equal candidate-freeze and remote-inventory evidence; two copied digest strings
cannot satisfy the contract.

The static activation environment gate is not yet a valid staging ceremony.
Enabling it and later disabling it creates different Controller versions,
while the ledger, action-gate source, and candidate require one exact version.
Phase 1 therefore requires a root-authorized same-version one-time campaign
with nonce, expiry, per-shard consumption, automatic seal, and immutable audit
before live activation collection can begin.

Collector version 4 now provides fail-closed direct API pagination locally:
strict KV page-number totals and opaque Container tokens must reach explicit
terminal conditions without duplicates, loops, drift, or unsafe responses.
This does not make foundation evidence ready because no rotated credential or
real staging endpoint was used. Remote 0054/0055 apply/readback, authenticated
Cloudflare API pagination, a live one-time activation campaign, real
runtime/image provenance, all-shard probes,
fault/load/rollback campaigns, Go/VPS drain, and approvals remain open.
Production remains **NO-GO**.

## 2026-07-19 P5 Shard Activation Campaign v1

The same-version ceremony required by the preceding section is now implemented
locally. Migration 0055 advances the exact D1 baseline to 55 migrations, 62
tables, 771 checked incremental columns, and 91 key indexes. It adds immutable
campaign, claim, consumption, and seal evidence plus bounded expiry
materialization. Final consumption atomically creates the matching 0054 row and
seals only at N/N.

The protocol is D1-first and at-most-once. A campaign readiness request claims
its shard before any Durable Object lookup. The Controller strips the raw nonce
before `readinessProbeV2`; the DO v6 journal stores started/completed/ambiguous
state, exact canonical result JSON/hash, and at least two hours of terminal
retention. Timeout never authorizes a second wake. Completed D1 consumption is
replayed only when the DO hash matches.

The legacy static activation writer and all 22 Controller action gates remain
false. A strict root campaign credential is the one-time capability that lets
the edge readiness endpoint bypass only its ordinary probe/wake flags. Missing
or malformed campaign requests remain static-gated, and production wake still
requires prior staging verification.

The shard collector now uses capture v2 and foundation sources v3. It reads a
stable `sealed_complete` campaign before and after the observation, validates
receipts `0..N-1`, recomputes readiness/activation/consumption hashes, and
requires one matching 0054 row per receipt. Local P5 focused tests cover 44
evidence cases, 24 foundation cases plus self-test, and 13 shard/campaign
collector cases.

This closes the local campaign implementation blocker only. Credential
rotation, remote 0055 apply/readback, same-version deployment, a live N/N
campaign, authenticated collector-v4 all-page Cloudflare inventory, provenance and traffic
sources, P5 faults/load/cost/SLO, five approvals, and the Go/VPS drain and
reverse-sync packet remain open. Production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Durable Terminal Handoff v1

Phase 1 now includes a default-off durable owner for positive paid ordinary
HTTP SSE. Migration 0056 advances the local exact-set baseline to 56
migrations, 64 tables, 814 checked incremental columns, and 94 key indexes. It
adds generation-fenced handoff state and append-preserved exact finalization
receipts.

The Worker uses one instrumented upstream stream, bounded incremental SSE
parsing, monotonic usage/checkpoint counters and rolling digest, billing-lease-
bound heartbeats, immutable staged event identity, an atomic leased outbox, and
receipt-only financial terminal convergence. Recovery never calls the provider.
Failed/incomplete provider terminals and any unproven stream end remain
`recovery_required`. Stream parse failure settles only the frozen reserve and
never partial usage.

All four producer/staging/outbox/recovery flags remain false in default,
staging, and production. Outbox/recovery can be independently enabled for an
approved drain while the producer stays false, but both require the staging
verification latch.

Local implementation closes the isolate-clone terminal ownership gap only for
the covered path. It does not prove the provider-dispatch-to-handoff window,
immediate cancellation, a total stream deadline, real Queue/D1 ambiguity,
restart/version skew, remote 0056, provider-family failed-terminal policy, P5,
or Go/VPS drain. See `docs/relay-http-stream-durable-handoff.md`. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Pre-Dispatch Intent v1

Migration 0057 supersedes only the current-head and crash-window statements in
the preceding 0056 section. The 0056 handoff remains the response-after,
before-first-client-byte terminal owner. The exact 0057 increment baseline is 57
migrations, 65 tables, 841 checked incremental columns, and 96 key indexes.

Positive paid SSE now completes local request preparation before one atomic D1
reservation-bind plus `prepared` insert. Only one successful
`prepared -> dispatched` CAS grants authority to poll the provider future. The
first version allows one attempt and disables post-dispatch channel retry,
model fallback, and AI Gateway direct fallback. Transport ambiguity, the
120-second response-header limit, and every non-200 status atomically move the
0057 intent and billing reservation into `recovery_required` without provider
resend or automatic refund.

For HTTP 200, the 0056 handoff insert and 0057 `stream_bound` promotion are one
SQLite transaction. A 900-second immutable hard stream deadline bounds lease
renewal, and scheduled recovery sweeps expired pre-handoff intents. Local
SQLite, Rust, P5 fixture, and Workerd CAS/promotion/recovery cases pass.

At the 0057 increment, immediate client-disconnect recovery was still lease/
scheduler-owned. The 0058 section in this document closes that local
implementation gap.
At the 0057 increment the default durable-disabled clone/tee path still retained
slow-client backpressure risk; the closure below supersedes that historical
state. Remote current-head cancellation/restart/Queue/provider-invoice
evidence, P5, and Go/VPS drain remain open. All four SSE gates stay exact false.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Single-Forwarding Backpressure Closure

Ordinary durable-disabled HTTP SSE now returns one response-owned, pull-driven
Rust stream. Bounded usage parsing advances inside that stream. Provider terminal
ownership is claimed and registered as a short-lived `waitUntil` task before the
terminal chunk is yielded; the `Request.signal` listener and stream Drop can
claim only while ownership remains pending. No `Response::cloned()`/clone/tee body consumer
remains. `Request.signal` and stream Drop register client finalization only when
cancellation occurs. The lease heartbeat uses one cancelable timer and one short
renewal task at a time; it cannot read or buffer the provider body or keep a
response-lifetime `waitUntil` pending.

Local Workerd proves the bound with a 256-chunk pull-generated provider: after
one client chunk and a 300 ms pause, the provider is incomplete and has at most
eight pulls. Controlled provider-terminal release and client drain add at most
one pull, remain below 256, and finish with positive upstream usage, no parse
failure, one request accounting update, billing Queue settlement, and
`provider_terminal_event` convergence. Static mutation audit rejects restoring
pull-owned async financial finalization.

Accepted patterns are one pull-driven forwarding stream, bounded incremental
state, synchronous provider-terminal `waitUntil` registration, a separate
first-owner client-abort listener/drop fallback, single-timer heartbeat, and
frozen-reserve cancellation. Clone/tee,
detached audit body reads,
pull-owned async financial finalization, unbounded buffering,
partial-usage charging after ambiguous disconnect, and automatic refund/resend
are rejected.

Rollout keeps durable SSE gates false, freezes the exact candidate and Go/VPS
fallback, proves slow-reader and terminal accounting in isolated staging, then
collects direct/Gateway/WFP HTTP/2 and HTTP/3 disconnect evidence before any
promotion. Rollback routes new SSE traffic to hot Go/VPS, retains migrations
0056-0058 and the N drain owner, and never restores clone/tee or resends an
ambiguous provider operation.

The local slow-consumer blocker is closed. Real Cloudflare HTTP/2, HTTP/3, and
TCP client-disconnect propagation remains remote evidence. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-22 Cross-Language Container Shard Routing v1

The native Container shard planner now has executable Rust/Bun parity evidence.
A strict versioned fixture freezes HMAC-SHA256 domain separation, tenant-byte
length encoding, unsigned Jump Consistent Hash arithmetic, canonical instance
names, generation-fenced plans, and the 1024-shard maximum. Four test-only
vectors produce 16 exact plans and eight `N -> N+1` transitions; unchanged
owners remain stable and the one moved vector lands only on the appended shard.

`bun run check:container-shard-routing-contract` runs four Bun tests plus a
six-mutation self-test. The Worker unit suite reads the same fixture and
recomputes every digest and `ShardPlan`, so a JavaScript-only or Rust-only drift
cannot pass the repository aggregate.

The adjacent dual-generation Controller contract now supersedes the mandatory
drained expansion. A configured `G/N -> G+1/M` transition (`M>N`) accepts old
ring operations only inside an absolute window of at most 900 seconds. After
cutoff, DO SQLite allows only exact existing-operation replay; status, recovery,
and terminal ACK continue to drain by their persisted historical fence. Current
readiness may advance a shared shard while old work remains active, but the old
`ring_generation_in_flight` fence still applies without the exact transition.

All four previous-ring values remain `0` in tracked configs and ordinary deploy
preflight. The production order, forward-only rollback, and required remote
evidence are defined in `docs/relay-container-ring-transition.md`. No remote
resource, credential, provider, or traffic action occurred; production remains
**NO-GO**.

## 2026-07-23 Offline Signed Adjacent Ring Transition Manifest

Phase 1 now has a strict offline integrity boundary for the adjacent expansion.
The canonical v1 manifest reuses the strict P5 candidate schema and binds a
candidate-foundation artifact that makes no remote-promotion claim. It then
binds `G/N -> G+1/M`, the 30-900 second whole-second admission window,
300-second preflight lead, `max_instances >= M`, routing identity, non-secret
key IDs, a synthetic no-customer/no-paid-provider cohort, capacity/observability/
rollback/revocation canonical artifacts, and short-lived Go/VPS hot-fallback readiness.
Go/VPS must remain traffic and scheduler authority; the manifest cannot drain
ingress or stop its processes.

The signed subject also carries a fresh canonical previous-ring readback
produced by a separately authenticated collector. Its old edge/Controller
deployment identities are frozen; its commit, resource identities, Container
image/build/provenance/SBOM, provider-egress, schema, protocols, key IDs, and key
fingerprints must match the new candidate, preventing expansion from carrying
unrelated artifacts or same-ID key rotation.

Five distinct Ed25519 role keys sign a transition-specific subject after all
evidence and before admission. The verifier reads and hashes seven fixed evidence
artifacts and rejects P5-domain replay,
noncanonical/symlink/hard-linked/changing files, ring/capacity/window drift,
stale evidence, authority escalation, and digest or signature mutation. It
outputs only a deterministic declarative overlay and plan digest. It reads no
credential, uses no network or subprocess, writes no file, and leaves every
deploy, mutation, provider, traffic, production, rotation, rollback, and Go/VPS
shutdown authority false.

`bun run check:relay-container:ring-transition` covers 17 focused contract/CLI
cases. The ordinary Controller deploy preflight still requires all four
previous-ring variables to be zero and cannot be bypassed by this result. This
closes the local signed-manifest gap only; authenticated remote status,
propagation, lifecycle/fault, overlap/cutoff/replay, accounting, SLO/cost,
post-transition P5-B, real replacement-credential revocation, and Go/VPS cutover
evidence remain open. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-23 Staging Ring Transition Mutation Authorization

Phase 1 now separates review from mutation with a second canonical signed
contract. It re-runs the complete transition verifier, binds the transition
manifest/subject/review-policy/plan/candidate digests, and verifies signatures
over only the exact Controller-first then Edge staging deployment pair. The
signed decision lasts 60-600 seconds, expires before admission, uses a distinct
external trust policy, and requires security, operations, release, and rollback
signatures from four Ed25519 keys that are distinct from one another and from
every transition-review key.

Five actual canonical artifacts bind fresh stable Controller/Edge deployment
sets and active-version settings, revoked exposed credentials and separate least-
privilege read/claim/deploy identities, a two-person live operator ceremony, an
unclaimed expiring D1 unique claim, and Go/VPS forward-safe rollback. The output
requires an atomic remote claim plus T1, Controller post-write, Edge pre-write,
and Edge post-write readbacks. It explicitly states that Cloudflare native
atomic CAS is not claimed. Because both policy paths are caller inputs, the
offline result keeps `trustedPolicyAnchorVerified=false` and
`remoteMutationAuthorized=false`; a runner must pin both policy digests outside
caller control.

The companion read-only collector normalizes the locked Wrangler 4.110.0 /
Cloudflare SDK 5.2.0 token-verify, deployments, and versions API shapes. It
proves the account-owned read-token ID, then samples Controller and Edge twice
through eight more GET requests. All nine response bodies are streamed under a
2 MiB bound with redirects disabled and no retry. It hashes the active
deployment and full version-detail response and rejects deployment, allocation,
or version-detail drift. Non-versioned script settings remain a separate runner
precondition. Dry-run reads no credential; live mode accepts only a dedicated
replacement read token from a named environment variable and requires explicit
revocation/no-mutation confirmations.

`bun run check:relay-container:ring-transition` now covers 29 focused
review/authorization/collector/CLI cases. This closes the local authorization
and readback-shape gap only. The deployment-pinned trust roots, D1 claim
authority, and mutation runner do not yet exist, and no Cloudflare request or
mutation was performed. Remote
revocation/permission proof, claim races, response-loss classification,
post-deployment readbacks, four-layer Workerd/remote overlap, accounting,
fault/load/SLO/cost, P5-B, and Go/VPS cutover remain open. Production remains
**NO-GO**.

## 2026-07-23 Ring Transition Claim And Fail-Closed Runner Foundation

The previous "claim authority and runner do not yet exist" statement is now
partially superseded. Migration 0059 implements the D1 single-use claim and
ordered step ledger, and the authorization contract now requires separate
least-privilege read, claim, and deploy credential identities. Local exact
schema replay passes at 59 migrations, 68 tables, 899 checked incremental
columns, and 100 key indexes.

The new runner contract pins account, policy, approval-key, service,
claim-authority, source/build, trust-config, and release identities. It
constructs only the exact Controller/Edge 100-percent deployment requests,
marks them zero-retry, and classifies response loss only through two stable
authenticated target readbacks. An inflight claim never schedules another
mutation.

The checked-in trust object remains `enabled=false`; the runner CLI rejects
execution before credential or network access. The private claim-authority
Worker, live read/claim/deploy transports, immutable enabled runner artifact,
credential revocation, remote 0059, fault campaign, P5-B, Go/VPS drain, and
production decision remain open. No Cloudflare request or mutation occurred.
Production remains **NO-GO**.

## 2026-07-23 Rust Ring Transition Resumption Core

The Rust runner now contains a pure resumable orchestration library aligned to
the current 0060 Authority protocol. It strictly parses one bounded
claim/state/step/expiry snapshot, rejects unknown and duplicate fields,
recomputes canonical cross-language digests, reconstructs every state version,
and rejects mixed sequential-query results. Execution steps remain claim-owner
bound; expiry remains Authority-owned; post-readback evidence must repeat the
immediately preceding persisted request digest.

The reducer cannot return a deployment action. It returns reads, intent
appends, inflight observations, Authority expiry/recovery waits or terminal
receipt sealing. Controller and Edge inflight states are readback-only even
after expiry.

A new mutation uses sealed Controller/Edge phase types. The prepared intent is
consumed into a non-cloneable, request-ID-bound Authority append attempt. Only
an exact fresh `step_appended` result consumes that attempt into a private
non-cloneable/non-serializable permit; replay does not. Binding the exact
canonical deployment request digest consumes the permit again. The
orchestrator, release-verifier and publication/activation sources are now
mandatory in the 19-file detached-release module closure.

This closes the local pure reducer and capability gap. Rust fixed-sidecar,
compiled-pin, DSSE, current-executable and host-target verification are also
implemented; credential/Authority/Cloudflare clients, sole-POST type join,
timed stable double readback, create-new hash-chained receipt, two-build signed
release, crash matrix, exposed-credential revocation and every remote staging
or production gate remain open. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-23 Rust Detached Release Verification

The compiled launcher now owns the release authorization boundary before any
credential or network access. An enabled build accepts only its current
executable and the two fixed sibling sidecars, then requires canonical,
duplicate-free exact-schema JSON; compiled policy/key/origin pins; one
Ed25519 DSSE signature; bounded validity; permit/release key separation; the
complete 19-path source closure; reproducible-build/evidence/Authority
identities; the current artifact bytes; and a target matching the launcher's
compile-time x86_64 architecture/OS/ABI.

The checked-in build remains disabled with null pins and exits before reading
the clock, filesystem, credentials or network. The signed publication and
create-new append-only activation core is now also implemented locally. The
remaining P0 release work is a real two-build artifact, independent signature,
reviewed non-null pins, Windows/Unix pre-install link checks and an
operator-owned installation ceremony. Live Rust clients, stable readback,
execution receipt, crash campaign and all remote gates remain open.

## 2026-07-23 Signed Publication And Activation Core

The Rust runner now verifies a domain-separated publication DSSE packet after
the detached release. It binds the exact policy/release-packet/executable
bytes, generation digest, release/Authority/target identity, monotonic
activation sequence and exact predecessor publication.

Installation creates a manifest-hash-derived directory and all four files with
create-new semantics, re-verifies the installed bytes, freezes the generation,
then creates the fixed sequence activation record last. There is no mutable
`current` pointer, overwrite path or cleanup path. Concurrent candidates for
one sequence contend on one activation filename; only one can become active.

`--execute` now requires the installed directory name, compile target and
activation record to match the signed publication before credentials. The
checked-in build still fails at disabled trust before clock or filesystem
access. Real signing/build/install evidence and all remote gates remain open.
