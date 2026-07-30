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

## 2026-07-24 Stable Readback And Authority Observation

Phase 1 now includes the local post-mutation proof boundary. The activated
credential identity compiles a 5-120 second observation interval. A verified
Controller or Edge inflight snapshot re-derives the persisted canonical
request and annotation, then performs exactly two read-token-only deployment
and target-version snapshots separated by that interval. No caller can choose
the account, service, target, annotation, request digest, interval, origin, or
path.

Deployment responses are bounded, duplicate-free, percentage-only, and
normalized into one or two distinct nonzero ASCII-sorted versions totaling
100. The deployment-set digest is cross-checked against the JavaScript
contract. The complete target-version result is canonicalized and hashed.
Stable exact target, 100 percent allocation, matching canonical annotation,
matching version detail, and a valid 5-120 second window are required for a
confirmed observation.

The Rust orchestrator separates observation capabilities from mutation
capabilities. State 3 and state 6 steps obtain their mutation request digest
only from the verified inflight history. Confirmed success or response loss
advances; rejected transport, drift, or a stable non-target state enters
`recovery_required` with the existing exact failure class. One fixed
Access/HMAC Authority append accepts only exact append or replay. Failed reads
or append ambiguity remain inflight. Restarts are permanently readback-only
and cannot recreate the deployment POST.

The release closure is 22 paths and now requires `readback.rs`. The checked-in
trust remains disabled and the public CLI still stops before claim execution.
Create-new execution receipts, full restart driver, exact Rust 1.78 Linux
reproducible release, remote Access/token/revocation evidence, isolated
staging, and the fault campaign remain P0. Go/VPS remains authoritative and
production remains **NO-GO**.

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

## 2026-07-29 Authority To Deployment Gateway Integration

Authority migration 0006 now extends operation 5 without rewriting migration
0005. A Gateway-specific immutable side table projects every dispatch,
create-result, and status event into the existing send-attempt event stream.
The event chain is contiguous, predecessor-bound, role-isolated, and protected
against update and delete.

The send route now commits the send attempt, `send_started`, and
`gateway_create_dispatched` in one first-primary D1 batch. Only a definite new
three-row result may call the private Gateway Service Binding. Exact replay,
unknown D1 result, concurrent loss, and result-event write failure can never
authorize another create.

Gateway create uses a separate create HMAC, one request, no retry, a 3-second
budget, 4 KiB canonical request, and 64 KiB response bound. Authority
independently reconstructs the Cloudflare deployment mutation digest before
persisting dispatch authority and rejects a mismatched Gateway response.
Accepted, rejected, and ambiguous outcomes are appended at sequence 3.

The new recovery-role route
`read-enable-dispatch-status` reconstructs the frozen command from the
immutable attempt and calls only Gateway status. A crash after dispatch but
before create-result persistence is first normalized to
`gateway_create_ambiguous`; recovery never calls create. Target, baseline,
drift, ambiguous, and stable observations are append-preserved. Stable
requires the same target observation in two consecutive Authority events and
the Gateway stability interval.

Authority and Gateway create/status credentials are independently validated.
Tracked local and staging configs add only the private Service Binding, empty
public credential identities, and three false gates. Secrets remain absent
and production config remains absent.

Controller `/internal/v1/status` now emits an exact v1 serializer shared by a
golden fixture with the Rust strict parser. Jurisdiction and Controller
service fields are semantically checked, while unknown and missing fields
remain rejected.

Focused Authority, Gateway, Controller, Workerd, migration, config, and Rust
checks pass. The implementation and fault evidence remain local and synthetic.
Operation 5 is not terminally closed: a dedicated receipt must still bind the
stable Gateway event into the execution claim and advance the operation
ordinal. Remote D1 readback, token scope, credential rotation, at-most-one
mutation fault campaigns, operations 6-14, reverse sync, drain, traffic, DNS,
and approvals remain open. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-29 Controller Deployment Gateway Foundation

Phase 1 now contains a separate local
`controller-deployment-gateway`. It is a private, default-off control-plane
Worker with a dedicated D1 database and no public route. It is the only
component designed to hold the future Cloudflare deploy/read credentials;
Authority, Controller, DOs, Containers, and the edge Worker remain
credential-free.

The create endpoint atomically persists immutable operation and dispatch
evidence before external I/O. Only a definite first D1 creation may execute
one canonical Cloudflare deployment POST. Exact replay, concurrent loss,
indeterminate D1 result, timeout, disconnect, malformed response, response
loss, restart, and rollout all become status-only and can never authorize a
second POST.

The status endpoint performs only deployment-list and target-version GETs
with an independent read identity. It verifies the configured account and
script, deterministic annotation, exact target, readable version, and
100-percent allocation. Stable target requires the latest two consecutive
target observations separated by at least five seconds.

Focused typegen, dry-run build, unit, Workerd/D1, migration, and configuration
checks pass. The Workerd outbound API is synthetic; all tracked gates remain
false, production config is absent, and no real credential or remote state
was used.

Authority integration, migration 0006, fresh-only create, status-only
recovery, stable Authority evidence, and the Controller status/Rust strict
parser contract are now implemented locally in the
Authority-to-Gateway checkpoint above. The remaining Phase 1 P0 is operation-5
terminal closure from the stable event, followed by remote fault and
least-privilege evidence. Go/VPS remains authoritative and production
remains **NO-GO**.

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

## 2026-07-27 WORM B4 Data Collector

Phase 1 now includes a predecessor-bound B4 collector with separate
`publish` and `readback` roles.

Publication requires the exact B1 empty-baseline and B3 lock-revocation
verifier receipts, strict chronology, the same target, and the same publisher
access-key digest recorded by B1. Six exact, stable, single-link artifact
files are streamed through create-only `PutObject` requests with
`If-None-Match: *`, `Content-MD5`, exact content type/size, v2
contract/commit/SHA-256 metadata, provider request IDs, and ETags.

Independent readback uses a distinct read-only credential. It exhausts object
and multipart pagination, admits exactly six expected objects, downloads each
with `If-Match` bound to its publication ETag, streams into an empty output
directory without replacement, and rehashes every committed file.

Focused verification passes 11 tests with 76 expectations. The lifecycle
gate passes 18 tests with 115 expectations after enforcing strict ordering
across every B3 revocation timestamp. All nine container supply-chain suites
pass 104 tests with 938 expectations. The self-test proves only the offline
contract: no credential, request, local file write, remote mutation, WORM,
complete S3, P5, traffic, or production authority. The complete repository
gate passes with exit code 0 in 604 seconds; 21 existing Rust `dead_code`
findings remain warnings only.

No Cloudflare operation was performed. B5 still requires provider
overwrite/delete probes, publisher lifecycle revocation and independent
readback, post-probe object readback, final lock readback, and canonical v2
assembly. Go/VPS remains authoritative and production remains **NO-GO**.

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
mandatory in the 20-file detached-release module closure.

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
complete 20-path source closure; reproducible-build/evidence/Authority
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

## 2026-07-23 Activated Credential Identity Core

The Rust runner now consumes verified publication activation before it can
touch runtime credential handles. Current-publication verification uses only
checked-in release trust and no longer exposes a public activation constructor
or caller-selected trust input. The activated release retains its signed
trust-config and permit-SPKI identities so a separate compiled credential
trust must match the exact generation.

The credential trust is still disabled with null pins. An enabled build reads
only the fixed account/read/claim-HMAC/deploy environment names, never
enumerates the environment, and validates the account hash before reading any
secret. Secret material is 32-4096 UTF-8 bytes, pairwise different, whitespace
free and stored in zeroizing non-cloneable/non-debuggable wrappers.

Identity proof is an ordered consuming Rust typestate. Read and deploy token
responses require active exact token IDs. The claim state creates the exact
Authority HMAC preflight and verifies request ID, claim credential, Authority
version and permit SPKI. A fixed vector is accepted byte-for-byte by Rust, the
JavaScript transport and the Authority verifier.

The JavaScript reference transport now applies the same atomic rule: preflight
is private, all non-preflight Authority traffic requires all three proofs, and
any revalidation failure clears every proof. HMAC key IDs and secret byte
bounds now match the Authority protocol.

This closes only local handle ordering, secret lifetime and identity proof.
Cloudflare token scope/owner/revocation evidence, an explicit Cloudflare Access
workload identity for the Authority, bounded Rust HTTP clients, coherent claim
resume, the sole typed deployment POST, stable readback, receipts and crash
campaign remain P0. No credential value or network was used. Production
remains **NO-GO**.

## 2026-07-24 Bounded Rust Control Plane And Access Identity

Phase 1 now has a bounded native Rust control-plane client behind the verified
release/publication capability. The Access workload identity is fixed to
Cloudflare Access service-token mode. The loader reads six exact handles,
pins the account and Access client ID before completing secret loading, and
keeps all secret material pairwise distinct and zeroized. Standard Access
headers are emitted only to the fixed private Authority origin.

The client proves read token, deploy token, and Authority preflight identities
in order; performs exact claim resume bound to account, role credentials,
runner build, trust config, owner, and Controller/Edge services; and accepts no
proxy, redirect, retry, caller origin, or caller path. Responses share one
deadline and enforce JSON/content-encoding/content-length/streaming byte
bounds.

The Rust orchestrator now owns canonical Controller/Edge deployment body bytes
and digest. That opaque request is consumed through the persisted
request-ID-bound Authority append and exact fresh permit. The sole private POST
consumes `AuthorizedMutation<P>` and cannot accept a replacement URL, service,
target, body, or digest. 408/425/429/5xx, redirect, timeout, disconnect,
truncation, and invalid success envelopes are ambiguous and never retried.

The release closure is 21 paths including `transport.rs`. Local Rust tests
execute successfully on Windows using the MSRV-compatible Schannel dependency
lock; Linux remains the release target with Rustls/WebPKI. Local loopback
faults cover redirect, poisoned proxy variables, timeout, disconnect,
Content-Length/chunked overflow and secret non-disclosure.

This does not advance a remote gate. Next are policy-timed stable double
readback, Authority post-readback steps, create-new execution receipts, an
exact Rust 1.78 two-build Linux release, independent signature/installation,
actual exposed-credential revocation, deployed Access policy readback, token
scope evidence, and the two-process fault campaign. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-24 K7 Execution Receipt V1 And Recovery Boundary

Phase 1 now freezes the K7 receipt and restart contract and includes the local
Rust terminal projection, create-new store and replay verifier. It does not
claim the real-time driver, installed-filesystem independent verification or
production proof. A separate JavaScript verifier covers canonical in-memory
replay only.

Each authorization has one independent bounded canonical digest-only chain at
`execution-receipts/<authorizationIdSha256>/<sequence:020>.receipt.json`.
Sequence 1 has no predecessor. Every later record binds the SHA-256 of the
complete prior canonical bytes. The chain records only allowlisted release,
publication, credential, Authority, claim, state, request-ID, readback,
deployment-set and evidence identities or digests. It never stores secrets,
headers, permits, HMAC values, raw request/response/provider bodies, SQL
details or unbounded remote metadata.

Writes are create-new. An existing sequence is an exact replay only when its
bytes equal the proposed canonical record. Different, partial, noncanonical,
linked, skipped or post-seal content is a permanent conflict and is never
overwritten or repaired in place. A final `terminal_seal` is allowed only for
Authority-verified `completed`, `recovery_required`, `aborted` or `expired`
state, binds the final state and prior receipt, and forbids any later record.

The production filesystem contract is Linux-only: trusted directory
descriptors, `openat` path confinement, `O_NOFOLLOW`, `O_EXCL`,
single-link regular files, private same-directory staging, verified bytes,
final permissions, file `fsync`, create-new publication through
`renameat2(RENAME_NOREPLACE)` or a reviewed equivalent, parent-directory
`fsync`, and independent readback. An uncertain publish or directory-sync
result is resolved by exact fixed-path digest readback and never authorizes
overwrite. Windows validates protocol and restart semantics only; it cannot
close Linux path, link, ACL, directory-sync or power-loss gates.

Receipts are audit evidence, not state authority. Every restart must reverify
the signed installation and identities, validate the chain, then read the
exact Authority claim. A deployment POST permit is fresh, process-local and
non-serializable; it is never persisted or reconstructed. Restored inflight
claims perform stable readback and Authority observation only and can never
issue another POST.

K7 remains P0 and production **NO-GO** until the local writer is integrated at
every network boundary, the independent verifier securely reads the installed
Linux chain, the complete
concurrent crash campaign passes, exact
operator/append-writer/auditor ACL and retention evidence is retained, real
Linux ext4/XFS power-loss durability is demonstrated, and the terminal chain
head is anchored in independently signed P5 evidence or reviewed WORM/Authority
storage. Go/VPS remains authoritative.

## 2026-07-24 Signed Execution Activation Core

Phase 1 now inserts a publication-specific execution activation before
credential loading. The sole installed location is:

```text
execution-activations/<publication-manifest-sha>.execution-activation.json
```

The filename is derived by the runner from the verified publication manifest.
No caller-selected path, authorization ID, service, target or force/replace
flag is accepted. The file is bounded strict canonical JSON and contains the
exact publication binding, fixed Access-protected Authority claim locator,
permit SPKI, canonical claim, and domain-separated Ed25519 signed claim
permit. Duplicate/unknown fields, noncanonical bytes, signature drift, expiry
drift or locator drift fail closed.

The claim and permit bind the publication manifest/packet, generation,
activation sequence, runner build/trust config, transition and authorization
policies, account, ledger, read/claim/deploy credential identities,
Controller/Edge services, authorization, execution nonce, owner and claim
digest. Credential loading and preflight occur only after those joins succeed:

```text
publication -> execution activation -> credentials -> preflight
```

Installation is create-new at the fixed path. Existing exact bytes are an
idempotent replay; different bytes are a permanent conflict and are never
replaced. Uncertain durability is resolved by fixed-path digest readback only.
The checked-in execution-activation trust is disabled, `--execute` remains
fail-closed, and no credential or remote action was used.

The signed release closure is 28 modules: the previous 25 plus the Rust
activation module, independent JavaScript verifier and its tests. The merged
local gates observed 76 runner library tests, one runner binary test, two
runner CLI tests, 38 runner JavaScript tests, 65 broader ring-transition tests,
859 Worker library tests and 71 frontend tests; repository-wide
`bun run check` exited successfully.

Remaining P0 is live Authority claim creation, typed T1 and Edge phases, live
receipt append at every network boundary, the resumable driver, Linux
adversarial and power-loss tests, full four-approval revalidation, an external
receipt-chain anchor, and the exposed-credential revocation gate. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-24 At-Most-Once Claim Dispatch And Recovery

Phase 1 now contains the local native Authority claim-create path. Before the
one fixed POST, the runner creates and durably reads back a publication-bound
`claim-dispatch.json` record. Exactly one concurrent process receives the
fresh in-memory capability; restart sees the record and is permanently
GET-only. A crash after guard publication but before socket write may produce
zero POSTs, so the guarantee is at-most-once authorization rather than
distributed exactly-once delivery.

Only exact `201/created` and `200/exact_replay` responses are accepted, and
even those require a full exact Authority GET before the runner becomes
claimed. Response loss, invalid success, `409`, throttling, `5xx`, and
`outcome_unknown` never retry POST. Recovery consumes and returns a GET-only
typestate until a complete snapshot passes identity and history verification.
Only the claimed typestate exposes later append/deploy/observe operations,
all bound to the same authorization and claim digest.

The dispatch schema is independently verified by the already signed
JavaScript activation verifier, so the release closure remains 28 modules.
Focused gates pass with 82 Rust library tests, one binary test, two CLI tests,
strict Clippy, 39 runner JavaScript tests/146 expectations, and 65 broader
ring-transition tests/728 expectations. The complete repository
`bun run check` passed in 719.5 seconds.

No checked-in trust was enabled and no credential or remote API was used.
Next are typed T1 and Edge-previous phases, live receipt integration, the
resumable driver, Linux crash/power-loss proof, full approval revalidation,
external receipt anchoring, isolated staging proof, and exposed-credential
revocation. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-24 Typed T1 And Edge-Previous Baselines

Phase 1 now has local native stable-baseline execution for the T1 Controller
previous-deployment boundary and the later Edge previous-deployment boundary.
The phases are sealed Rust types, own their verified Authority snapshot, and
cannot be interchanged.

Each phase performs two stable deployment/version observations separated by
the compiled wait. Both observations must match each other and the exact
signed previous version and normalized deployment set. Drift records the
existing fail-closed outcome: T1 aborts; Edge enters recovery-required. No
deployment ability is minted by a baseline phase.

After the wait, the runner checks clock monotonicity and claim expiry before
the single Authority append. Only exact `201/step_appended` and
`200/step_replayed` pairs are accepted. Every ambiguous result is never
reposted and is resolved only by one exact Authority GET.

Both baseline methods consume `ClaimedControlPlane`. The next control
plane can contain only the fresh GET-verified snapshot with the exact step;
failure drops the stale capability. Rust and independent JavaScript agree on
the frozen T1 step digest.

Focused gates pass with 91 Rust library tests, one binary test, two CLI tests,
strict Clippy, 39 runner JavaScript tests/146 expectations, and 66 broader
ring-transition tests/729 expectations. The complete repository
`bun run check` passed with exit code 0 in 747 seconds, including 859 Worker
tests and 71 frontend tests. Checked-in trust remains disabled and no
credential or remote API was used.

Next are live receipt append around every request/readback/recovery boundary,
the resumable single-action driver, strict append recovery for the remaining
mutation and observation paths, Linux crash/power-loss proof, approval and
external-anchor evidence, isolated staging, and credential revocation.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-24 Incremental Authority Receipt Prefix

Phase 1 now persists every exact verified Authority claim snapshot before
returning it as a runner capability. The existing Receipt V1 format is
extended operationally, not structurally:

```text
claimed exact GET -> create/replay genesis prefix
T1 exact GET      -> replay genesis + create/replay T1 suffix
terminal GET      -> replay prefix + create/replay terminal seal
```

Only the missing create-new suffix may be written. Existing exact bytes are
replayed; a stale shorter view, divergent history, slot conflict, gap,
unknown file, linked file, invalid semantic digest, or unconfirmed durability
fails closed. A receipt failure prevents the snapshot capability from
escaping.

The independent JavaScript prefix verifier matches Rust and rejects terminal
status without a seal. Terminal-only APIs continue to reject all unsealed
prefixes. Receipts remain non-authorizing audit evidence and cannot restore a
POST, append or deployment capability.

Focused and aggregate verification passes with 95 runner Rust library tests,
one binary test, two CLI tests, 13 JavaScript receipt tests/32 expectations,
40 runner JavaScript tests/150 expectations, and 66 broader ring-transition
tests/729 expectations. The fixed signed source closure remains 28 modules.
Eight concurrent genesis writers produce one creation and exact replays only.
The complete repository gate passed in 694.2 seconds with 859 Worker tests,
71 frontend tests, required WASM checks, and zero frontend redaction or budget
findings. No checked-in trust, credential or remote API was used.

Next is the operation boundary layer: durable request-start plus
request-finish/ambiguous receipts before and after every Authority or
Cloudflare side effect, deterministic operation identities, and restart-time
GET-only recovery. Then comes the one-action resumable driver, remaining
append-path recovery, Linux crash/power-loss evidence, approval and external
anchor gates, isolated staging, credential revocation and G1-G8. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-24 Mutation Operation Receipt Gate

Phase 1 now has a durable at-most-once send gate for every implemented native
runner mutation:

```text
freeze exact POST identity
  -> create-new request_started receipt
  -> Fresh only: perform one bounded zero-retry send
  -> create-new accepted | rejected | ambiguous finish
  -> exact GET or stable readback decides subsequent state
```

Claim creation uses state version 0, Authority appends use the canonical step
version, and Cloudflare Controller/Edge deployments use versions 2/5. The
operation ID is independent of random request IDs and local time, so
concurrent processes converge on one operation. The winning request-ID digest
and timestamps remain audit facts inside the records.

Restart after any existing start is read-only. An unfinished start becomes
ambiguous, an existing finish remains terminal, and neither restores a POST.
A recovery probe does not synthesize a missing start. The first terminal
finish wins even when another process later receives a valid success.

Operation Receipt V1 is separate from the deterministic Authority-history
Execution Receipt V1 chain. Both join the same release, publication,
activation, claim, credential and trust identities. Operation records store
only request/response and provider-ID digests; no secret or raw body enters
the chain.

Rust and the independent JavaScript verifier agree on the frozen operation
ID, start head and accepted finish head. Current local gates pass with 101
Rust library tests, 46 runner JavaScript tests/169 expectations and 66 broader
ring-transition tests/729 expectations. The signed source closure remains 28
modules. The complete repository `bun run check` passes with exit code 0 in
675.6 seconds.

Next is the library-owned one-action `execute_current()` resume boundary,
followed by read-only request receipts, terminal operation-head anchoring,
exact Linux crash/power-loss proof, approval revalidation, isolated staging,
credential revocation and remaining Go compatibility work. No remote action
or credential read occurred. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-24 Library-Owned Single-Action Resume Driver

Phase 1 now has a public Rust `execute_current()` library boundary. Every
invocation re-enters through release, publication, signed activation,
credential and control-plane authorization. It audits the complete local
operation directory before credential proof network traffic, seals every real
unfinished start ambiguous after proof, recovers the exact Authority claim,
installs its receipt prefix, derives one state-machine decision, performs at
most one reducer action and stops.

The action model is deliberately bounded. A fresh claim stops after claim
establishment. `claimed` records T1. `t1_verified` can append one fresh
Controller intent and perform one Controller deployment. Controller inflight
can only read back and append its observation. The Edge half follows the same
baseline, fresh-intent and readback-only-inflight sequence. Expired wait and
terminal states perform no new operation.

An action may contain one Authority state CAS and one Cloudflare deployment;
it cannot contain two state reductions or a deployment retry. Existing or
recovered operation starts return a typed recovery-pending result with no
network. A process restart never reconstructs `FreshIntentPermit<S>`.

The architecture follows the audited source boundaries: cinaVibeSDK keeps
durable state in its Durable Object while treating sandbox/container work as
disposable, and cinatoken Go uses CAS before winner-only terminal effects.
The Rust driver therefore rehydrates durable Authority/receipt state each
time and keeps write capabilities process-local.

Focused gates pass with 105 Rust library tests, one binary test, two CLI
tests, strict Clippy, 46 runner JavaScript tests/169 expectations and 66
broader ring-transition tests/729 expectations. The signed source closure
remains 28 modules. The complete repository `bun run check` passes with exit
code 0 in 639.9 seconds. Checked-in trust and the CLI execution path remain
disabled.

Next are read-only request receipts, terminal operation-head anchoring, exact
Linux crash/power-loss and ACL proof, the DO shard supervisor/Container
adapter, replacement-credential isolated staging, remaining Go compatibility
and G1-G8. No credential or remote action was used. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-24 Read-Only Operation Receipt Gate

Phase 1 now records every native-runner GET: separate read/deploy Cloudflare
token proofs, Authority preflight, exact claim recovery, deployment sets and
version details. The mutation rule above remains unchanged: a write operation
ID is a deterministic singleton. A read operation is intentionally unique per
runner-local request nonce and binds `GET`, the absolute HTTPS target, kind,
state and nonce digest.

Slot 1 is create-new and exactly read back before send. Existing operations
perform zero network. HTTP `200` is accepted only for subsequent endpoint
semantics; deterministic client rejection is rejected; `408`, `425`, `429`,
redirect, `5xx`, transport loss and malformed/identity-drifting success are
ambiguous. Authority snapshots and stable-readback evidence remain the state
source.

Cloudflare deployment/version observations cannot start after expiry. Exact
claim plus credential/preflight proofs have a fixed 600-second read-only
recovery window; all writes remain strictly pre-expiry. The directory limit is
128 chains per authorization, with a nominal lifecycle estimate of about 59.
Fixed create-new capacity markers use synced same-directory staging,
no-replace publication and exact readback before operation directories. The
129th contender persists no directory/start and fails before network progress.
Interrupted staging is non-authorizing. A complete crash-stranded marker, with
or without its marker-backed empty operation directory, is also
non-authorizing but consumes its slot. Audit ignores the absent start; only the
same operation can later resume through normal slot-1 publication. Markers and
evidence are never reused or deleted, and exhaustion requires a new
authorization.

Focused local gates pass with 111 Rust library tests and 21 independent
receipt tests/72 expectations. Cross-runtime frozen read-request,
operation-ID and start-head vectors agree. Checked-in trust remains disabled,
and no credential or remote action was used.

Read request coverage closes only part of K4. Terminal binding of every
operation head, an independent signed/WORM anchor, Linux crash/durability
proof, the DO shard supervisor/Container adapter, isolated staging, remaining
Go compatibility, revocation and G1-G8 remain open. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-27 R2 WORM Staging Collector Foundation

Phase 1 now contains the first executable retention staging boundary. The
collector has separate publisher baseline and lock-operator configuration
processes, defaults to dry-run, accepts secrets only from phase-specific
environment variables, writes no files, and emits canonical redacted receipts.
It fully paginates exact-prefix objects and multipart uploads. The lock path
first calls
`GET /accounts/{account_id}/tokens/verify`, then performs the bounded
bucket-lock `GET -> PUT -> GET` transaction with rule preservation and exact
readback.

The lock preflight requires an active provider token with an effective
validity window, an explicit expiry, and no more than 3600 seconds of remaining
lifetime. Its `credentialIdSha256` is SHA-256 of the provider token ID, never
of the API token secret. Cloudflare defines the R2 S3 Access Key ID as that API
token ID, so the publisher baseline hash and lock preflight hash share one
provider-ID domain for later revocation and authority-separation evidence.
The staging phase receipt is therefore versioned as schema/contract v2; v1
lock receipts have different digest semantics and are not interchangeable.

The collector passed 16 focused tests with 106 expectations plus a
credential-free three-case/19-invariant self-test. The tests reject phase
credential overlap, shell-like identity input, pagination cycles, prefix
escape, preexisting objects/uploads, Cloudflare redirects, missing request
IDs, unknown response fields, credential reflection, ambiguous reruns, lock
drift, inactive or expired tokens, missing expiry, overlong lifetime,
future-effective tokens, and malformed provider identity.

All seven container supply-chain suites passed 74 tests with 668
expectations. The complete repository gate passed with exit code 0 in 601.6
seconds; only the existing Rust `dead_code` warnings remained.

No live phase was run. Token self-verification is not revocation evidence.
`API Tokens::Edit` is a separate non-R2 lifecycle permission and must remain
outside all four R2 ceremony roles. The repository has not implemented the
complete provider revoke plus independent readback needed to prove the exact
lock-operator or publisher token ID is no longer usable; B2 therefore remains
incomplete.

The next retention boundary is that lifecycle revoke/readback chain, followed
by predecessor-bound create-only publication, independent object readback,
enforcement probes, publisher revocation, final lock/object readback,
approval, and offline verification. Until that complete B1-B7 chain exists,
`wormRetentionVerified=false`, `s3Complete=false`, R3/C1 remain blocked,
Go/VPS remains authoritative, and production remains **NO-GO**.

## 2026-07-27 WORM Lock-Operator Lifecycle Collector

Phase 1 now implements the account-token lifecycle boundary that follows a
successful B3 lock receipt. A default-dry-run CLI has two isolated processes:

- `revoke` consumes a canonical live staging lock receipt v2, self-verifies a
  distinct short-lived lifecycle operator with account-token read/edit but no
  R2 authority, deletes the exact lock-operator provider token ID with exact
  `200`, and reads the same resource back with exact `404`;
- `verify` consumes the canonical revoke receipt, self-verifies a third
  short-lived provider identity, and independently observes exact `404` for
  the same target.

The target token ID is environment-only and must match the predecessor's
provider-ID hash. Operator, target, and verifier identities must all differ.
The two absence observations require strict Cloudflare JSON envelopes, valid
`cf-ray`, bounded body hashes, matching numeric error-code sequences, no
redirect, and no reflected sensitive input. Raw account/token IDs, API token
secrets, headers, response messages, and raw bodies are never emitted.

Receipt files must be canonical JSON plus one LF and pass byte, JSON-shape,
regular-file, single-link, no-follow, realpath, and stable metadata checks.
The successor hashes the exact canonical predecessor bytes. All live
confirmation flags are phase-specific; dry-run reads no credentials and
performs no network operation.

Focused verification passes 17 tests with 107 expectations and the built-in
credential-free self-test passes four cases with 12 invariants. The complete
eight-suite container supply-chain set passes 91 tests with 775 expectations.
The complete repository gate passes with exit code 0 in 635.0 seconds; 21
existing Rust `dead_code` findings remain warnings only. No live Cloudflare
call or credential read occurred.

B2 is still incomplete. Self-verification cannot prove the reviewed account
token permission inventory, and the current final retention verifier cannot
consume the two lifecycle receipts. Next is verifier contract v2 with six
distinct roles, exact permission inventories, DELETE/operator-readback/
independent-readback bindings, predecessor digests, and strict time ordering.
Only then can a predecessor-bound create-only B4 publisher be implemented.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-27 WORM Final Verifier V2

Phase 1 now has the fail-closed final evidence shape required by the
lifecycle collector. Protocol/trust/manifest/evidence/anchor contracts are
version 2 and reject all v1 predecessors.

The authority boundary requires four exact R2 roles plus separate
account-token read/edit operator and read-only verifier roles. Scope,
permission arrays, capability matrices, provider-ID digests, expiry, and
all-six identity separation are exact. Lifecycle roles cannot carry R2
authority, R2 roles cannot carry account-token authority, and every credential
has at most 3600 seconds remaining at authority capture.

Two independent evidence envelopes bind lock-operator and publisher
revocation. Both require a target-bound DELETE `200`, operator GET `404`, and
independent verifier GET `404`; matching bounded error codes; distinct
provider request IDs; response-body and predecessor/revoke/verify file
digests; and strict chronology. Lock revocation completes before upload.
Publisher revocation starts after both provider probes and completes before
the final object readback.

Focused verification passes 11 tests with 217 expectations, including v1
downgrade, authority escalation, receipt collision, status/error/request/body
drift, and ordering negatives. The credential-free self-test reports contract
version 2 while retaining all remote, S3, registry, P5, traffic, and
production facts as false. The synchronized staging collector passes 16 tests
with 110 expectations, and all eight container supply-chain suites pass 92
tests with 854 expectations. The complete repository gate passes with exit
code 0 in 611.2 seconds; 21 existing Rust `dead_code` findings remain
warnings only.

No live evidence was collected. Next is B4/B5 create-only upload, complete
independent object readback, enforcement probes, publisher lifecycle
collection, final lock readback, and canonical v2 evidence assembly. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-27 WORM B5 Enforcement Collector

Phase 1 now contains five positive B5 processes plus two incident-only
publisher-revocation processes:

- publisher create-only credential preflight followed by one unconditional
  different-content overwrite and one unconditional delete;
- lifecycle-operator exact publisher-token DELETE plus operator readback;
- independent lifecycle-verifier absence readback;
- object-verifier post-probe `If-Match` readback of the original bytes;
- sixth-identity lock-verifier readback of the complete original rule set.
- emergency lifecycle-operator revoke directly from B3/B4 plus an incident
  digest when no positive probe receipt can exist;
- independent emergency revocation verification, with both receipts
  permanently marked `positiveEvidenceEligible=false`.

The probe transport signs raw S3 requests with SigV4 and never delegates
error evidence to an SDK retry/exception path. It forbids redirects, performs
one request per operation, bounds XML responses to 1 MiB, validates strict
UTF-8 and XML without DTD/entities, binds request-ID source/value to the raw
body, and records response bytes, media type, hash, attempt time, and
completion time. Publisher revocation cannot start before both probe
responses complete.

Receipt ingestion is now shared across B4/B5 through a no-follow,
single-link, fixed-length, path/inode/stat-stable, canonical JSON reader.
Predecessor parsing proves exact six-object inventory, bounded pagination,
all five prior identities distinct, exact target/operation chains, and strict
chronology before a mutation credential can be read. Final verifier v2 also
binds all three actor digests and distinct request IDs.

The focused B5 suite passes 18 tests with 91 expectations, and its
credential-free self-test passes seven cases with 22 invariants. The synchronized
B4, lifecycle, final verifier, and staging suites pass 11/78, 18/115, 11/274,
and 16/110 respectively. The ten-suite container supply-chain aggregate
passes 122 tests with 1088 expectations. The complete repository gate passes
with exit code 0 in 629.4 seconds; 21 existing Rust `dead_code` findings
remain warnings only.

No live phase was run. The fixed staging tuples require independent
disposable-prefix calibration because Cloudflare documents Bucket Lock
enforcement but not a stable error response tuple. Next is credential-free
B6/B7 canonical evidence assembly, independent operations/security approval,
and clean-host verifier replay. B2 permission inventories remain incomplete.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-28 WORM B6/B7 Offline Assembly And Approval

Phase 1 now includes the complete local, credential-free bridge from the 11
positive B1-B5 receipts to a verifier-v2 candidate bundle. The assembler
replays all collector normalizers, ingests an exact six-role authority review,
snapshots every receipt and retained object, derives six canonical evidence
envelopes, validates retained ZIP structure, and emits an unsigned manifest
plus a fully bound signing request.

Operations and security approve in separate processes with distinct Ed25519
roots and stdin-only private keys. Their detached receipts bind both the
verifier-v2 anchor and the richer source ceremony. The finalizer has no
private-key or historical-clock surface; it creates a new candidate, verifies
both approvals, writes `manifest.json` last, runs the production verifier, and
requires an exclusive external decision-report file. The verifier-kit digest
must remain stable across replay. Clean-host replay remains mandatory.

The protocol now distinguishes a 365-day minimum remaining-retention decision
from the configured 400-day age lock. Stable protocol/source snapshots,
per-object limits, JSON complexity limits, object-capture chronology, and
bounded ZIP local/central structure all fail closed. Focused gates pass
B6/B7 5/33 and verifier v2 11/278.

This is local tooling readiness only. No live receipt, permission review,
Cloudflare request, credential read, retention decision, complete S3, R3/C1,
P5, traffic, billing, drain, or cutover authority was created. Next is an
independently reviewed live staging B1-B7 ceremony with clean-host B7 replay.
Go/VPS remains authoritative and production remains **NO-GO**.

All 11 container supply-chain suites pass 127 tests with 1125 expectations.
The complete repository gate passes with exit code 0 in 587.1 seconds; the 21
existing Rust `dead_code` findings remain warnings only.

## 2026-07-28 Shard Placement Attestation v1

Phase 1 now includes a strict Rust/TypeScript placement identity and D1
migration 0061. The domain-separated attestation binds Controller
service/version, DO binding/class, jurisdiction, hashed canonical name and
object ID, and the frozen v1 shard tuple. One shared fixture proves identical
serialization and digest behavior; unknown fields and identity drift fail
closed.

The new append-only D1 row must match one existing 0054 activation and 0055
consumption across campaign, claim, readiness, activation and consumption
digests plus candidate and shard identity. One activation can have only one
placement attestation. Updates, deletes, mismatched evidence, and restricted
jurisdictions all fail. The latter is intentional: campaign v1 cannot bind a
jurisdiction, so a versioned campaign v2 is mandatory before a restricted
writer can exist.

Migration 0061 remains the frozen attestation ABI. Security review adds the
0062 placement-event sidecar. Migration 0063 subsequently advances the global
schema candidate to head 0063/count 63 and 72 tables while preserving both
0061 and 0062 ABIs. P5 binds the complete 0063 schema while the separate
transition authority database remains 0059/0060. `activation_id` remains the
0054 association key and is not placement insertion order.

The default-only runtime writer now exists but is inert in every tracked
environment. The object RPC proves the same completed readiness journal and
derives identity from its actual `ctx.id`; the Controller separately derives
the expected identity from the selected stub ID, verifies the stub
jurisdiction, and requires exact canonical attestation and digest equality.
After 0055 completion, the D1 repository probes the exact 0061 attestation and
0062 event schemas, appends or exactly replays one 0061 row, and requires its
automatically appended 0062 event on authoritative readback. Missing,
conflicting, or malformed event/attestation readback fails closed.

Both placement-writer gates remain `false`, must change together, are visible
on private status, and are pinned false by deploy preflight. No remote schema
apply, gate change, object wake, or ledger record occurred. The staging-only
permit verifier, D1 single-use consumption, and Controller pre-wake check are
now implemented by 0063, but the four-role Authority issuer and deployment
runner are not. The ordinary deployment path therefore still cannot enable
the writer. Next is reader-first isolated staging apply and empty-schema
readback, Authority/runner implementation, one exact writer-version N/N
campaign, and a bounded root-authenticated P5 placement readback that also
binds the consumed 0063 authorization.
Restricted relocation and shared D1/KV/R2 residency remain later, separately
approved contracts. Go/VPS remains authoritative and production remains
**NO-GO**.

Focused placement/campaign/config/preflight verification passes 86 tests with
837 expectations. The complete repository gate passes with exit code 0 in 764
seconds; 21 existing Rust `dead_code` findings remain warnings only.

## 2026-07-28 Placement Readback And Shard Registry v3 Contract

Phase 1 now freezes the production acceptance boundary for a bounded
0062-event/0061-attestation reader at
`GET /api/platform/container/shards/placements`. The route is required to be
root-only, authenticate before storage access, read D1 only, and apply
`Cache-Control: no-store` to success and failure. It must never enumerate or
wake Durable Objects or Containers, call a Controller service binding, mutate
D1, change a gate, or authorize a campaign or deployment.

The query binds one Controller version, ring generation, and sealed campaign.
The first page freezes the maximum database-assigned
`placement_event_sequence` plus record count. Later pages repeat that watermark
and use the last returned event sequence as an exclusive, strictly increasing
keyset cursor. Page size is bounded to 64 with one lookahead row. The reader
verifies the exact 0061 attestation ABI and 0062 event table/index/triggers,
joins the event to the full attestation, validates every row, recomputes
canonical-name and placement attestation hashes, and exposes no raw Durable
Object ID. `activation_id` is retained only to prove the 0054 association.

Shard registry evidence advances to capture v3 and collector version 3. The
collector must retain sealed 0055 campaign, frozen 0054 activation, and frozen
0062 event-backed 0061 placement snapshots both before and after one 300-7200
second window. Before/after watermarks, counts, canonical-record digests, and
rows must be identical. Every candidate shard must have exactly one event and
attestation that strictly match its 0054 activation and 0055 receipt across
activation ID, campaign, candidate/shard identity, claim, readiness,
activation, and consumption digests. Missing, duplicate, unknown,
cross-candidate, non-default, or drifting rows fail P5.

This document contract is not deployment evidence. Placement writer gates
remain false and deploy preflight must continue to reject enabling them. The
0063 runtime verifies and atomically consumes a separately signed, single-use
isolated-staging authorization, but no Authority issuer or deployment runner
exists and no remote 0061/0062/0063 snapshot or v3 capture has been collected.
Revoke and rotate the exposed Cloudflare token before any staging readback or
mutation. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-28 Placement Mutation Authorization v1

Phase 1 now implements the local runtime side of the staging placement
authorization boundary. Rust and JavaScript share the exact
`cinatoken-relay-shard-placement-mutation-authorization-v1` Ed25519 subject,
canonical length-prefixed encoding, fixed vector, permit window, trust pins,
candidate binding, and replay-identity rules. The Worker accepts only staging,
the fixed staging Controller service, a 60-600 second permit, and at least 60
seconds of remaining validity. Raw campaign nonces, signatures, SPKI bytes,
and request bodies are not stored or logged.

Migration 0063 advances the application D1 head to 63 migrations, 72 tables,
962 checked incremental columns, and 105 key indexes. Its append-preserved
authorization table uniquely consumes the authorization ID, execution nonce,
campaign nonce, signed-subject digest, campaign ID, and campaign digest. One
D1 batch inserts the authorization before the campaign, appends the
administrator audit record, and reads both records back. Deferred foreign-key
ordering permits that sequence, while the campaign trigger requires exact
candidate, digest, lifetime, administrator, gate-inventory, and D1-time
agreement.

When placement writer gates are enabled, the Controller requires the exact
0063 authorization/campaign join before D1 claim or Durable Object lookup.
The final placement insert trigger independently requires that authorization
before validating the existing 0054 activation and 0055 consumption chain.
Production has no authorization trust variables, checked-in staging values are
empty, and all tracked writer gates remain false.

This closes local permit verification and single-use runtime consumption, not
the production ceremony. The offline JavaScript verifier is a reference tool,
not an issuer. A deployment-pinned Authority must still collect distinct
security, operations, release, and rollback approvals and issue one bounded
permit; a separate zero-retry runner must bind replacement least-privilege
credentials, deploy Controller before edge, classify response loss by
authenticated readback, disable the writer after the campaign, and retain
revocation evidence. P5 must also ingest and verify the 0063 authorization
row.

Focused authorization checks pass 15 Bun and 22 Rust tests; Controller suites
pass 178 and 46 tests; the DO runtime passes 53 tests; and the Worker library
passes 872 tests. The complete repository gate passes with exit code 0 in
849.1 seconds. No Cloudflare credential was read, no migration was applied
remotely, and no permit, campaign, placement, Container wake, customer
traffic, provider effect, or financial authority was created. The exposed
historical credential must be revoked and replaced before staging. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-28 Private Placement Authority, Runner Plan, And P5 v4

Phase 1 now has three additional local foundations, all intentionally inert:

1. `services/shard-placement-authority` verifies one externally signed v1
   permit plus fixed-order security, operations, release, and rollback
   Ed25519 approvals. It stores only safe issuance/revocation digests and
   fingerprints in an isolated append-only D1. Read, issue, and revoke callers
   use separate body-bound HMAC roles; these machine roles never replace the
   four human-owner approvals.
2. `cinatoken-relay-container-shard-placement-execution-plan-v1` freezes the
   first runner cohort to staging, Controller-only, and exactly eight shards.
   It derives 13 deterministic mutation operation IDs, permits one send and
   zero retries per operation, requires a persisted start receipt before
   send, allows only exact GET readback after ambiguity, forbids resend when
   readback is absent, forbids Edge mutation, and requires disable-first after
   an enable intent.
3. P5 shard registry capture v4 and collector version 6 retain the historical
   v3 campaign/activation/placement core and add the exact safe 25-column 0063
   row before and after the same observation. Foundation source v4 binds its
   canonical row digest into candidate-freeze and remote-inventory evidence.

The new root route
`GET /api/platform/container/shards/placement-mutation-authorizations`
authenticates before D1, accepts only one lowercase 64-hex `campaign_id`,
probes the exact 0061-0063 schema, joins the authorization to its immutable
campaign, returns only the 25 safe fields, and applies `Cache-Control:
no-store` to every outcome. It has no DO, Container, service-binding, D1-write,
deployment, campaign-create, or gate-change path.

The Authority has no public staging route, `workers.dev`, preview URL, or
production configuration. Its only intended ingress is a future exact Service
Binding from a separately Access-protected approval/workload gateway. The
checked-in trust placeholders and all seven Authority gates remain false. The
runner description also reports exclusive Authority claim and workload routes
as uncompiled, reads no credential, performs no network request or mutation,
and grants no remote or production authority.

These foundations do not yet form a production transaction. Authority
issuance/revocation and application-D1 consumption remain separate ledgers;
revocation cannot yet block an already authorized 0063 campaign; the local
exclusive claim/lease/step ledger is not yet joined to application D1 or the
Rust runner;
campaign/readiness still depend on root session; approval-key overlap rotation
and WORM retention of replayable signed evidence are absent; and Cloudflare
deployment inventory pagination is not yet independently complete.

The next production-critical implementation order is:

1. revoke the exposed historical Cloudflare credential and independently
   prove absence before reading or mutating staging;
2. select one dedicated placement-control D1 for Authority subject, approvals,
   issuance, revocation, execution claim/steps, campaign, activation,
   placement, and immutable events, or formally prove an alternative
   cross-database protocol;
3. add an Access-protected gateway with no D1 and one private Authority Service
   Binding; verify Access `aud`, stable owner identity, group-to-role mapping,
   and four distinct owner identities;
4. add current/next-or-previous approval-key validity and revocation policy,
   external WORM retention of canonical signed evidence, and a two-owner
   security+rollback revocation ceremony;
5. connect the implemented exclusive Authority claim, 60-second generation
   lease, and predecessor-bound execution ledger to application-D1 activation,
   then compile the runner's read, enable, rollback, Authority, and gateway
   credential typestates and trust pins;
6. replace root runner access with path/body/role-bound workload HMAC plus
   Access, and add read-only recovery plus zero-retry abort/disable routes;
7. apply 0061-0063 reader-first to isolated staging with every writer gate
   false, prove exact catalog and zero rows, then run one Controller-only 8/8
   synthetic campaign with Edge held to its signed baseline;
8. disable the Controller first on every success, rejection, timeout, response
   loss, or local crash; seal success only after stable disabled readback,
   unchanged Edge readback, sealed 8/8 campaign, exact 0063 row, and complete
   0054/0055/0061/0062 evidence; and
9. collect fault/load/cost/SLO/security/privacy/rollback evidence, five P5
   owner signatures, clean-host replay, and Go/VPS drain/reverse-sync evidence
   before any production review.

Focused Authority, Workerd, migration/config, P5, Worker-reader, and runner
plan tests pass locally, and the complete repository gate passes with exit
code 0 in 1000.6 seconds. No Cloudflare credential was read, no remote request
or migration was made, no gate changed, and no permit, campaign, placement,
Container wake, customer traffic, financial authority, Go/VPS drain, DNS
change, or production cutover occurred. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-28 Execution Ownership Checkpoint

The private Authority now has a locally exercised execution ledger in
`0002_shard_placement_execution_claims.sql`. One create-new batch persists the
claim, D1-generated acquisition receipt, and exact 11-operation schedule.
Concurrent identical requests classify as one `created` plus one
`exact_replay`; conflicting identities fail closed.

The projection is driven only by immutable receipts or revocation. It tracks
the current lease owner/token/generation, D1 expiry, predecessor head,
in-flight operation, readback-only recovery, enable intent, disable
confirmation, renewal/takeover counts, and terminal status. Lease expiry never
frees the active scope. A successor must append a generation-incrementing
takeover; the old owner and token are permanently fenced.

Operation 3 is the point of no return. Once its start receipt exists,
revocation or takeover changes the claim to `disable_required`. A pending
operation can only be closed by exact terminal readback, and no later normal
operation can start; operation 13 is the only allowed mutation. This rule is
enforced in D1, not delegated to runner memory.

This checkpoint does not authorize a staging run. Phase 1 still lacks:

1. an application-D1 activation ticket that joins 0063 consumption to the
   Authority claim without a cross-database double-spend window;
2. Rust/TypeScript fixed-vector parity and the zero-retry Authority HTTP
   client;
3. the Access-protected, D1-free gateway and workload routes;
4. approval-key overlap rotation and replayable WORM evidence;
5. remote reader-first migration/catalog proof and all P5 Authority-ledger
   capture; and
6. replacement credentials after independent revocation proof for the
   historical exposed credential.

The next code increment is therefore application migration 0064 plus the
two-ledger activation acknowledgement. Runner transport begins only after
that state machine and its revocation races are locally proven. The complete
repository gate passes this checkpoint with exit code 0 in 929.3 seconds;
existing Rust `dead_code` findings remain warnings only.

## 2026-07-28 Two-Ledger Execution Ticket v1

Phase 1 now includes the local application-D1 half and Authority-D1 half of
the placement execution ticket protocol. This checkpoint supersedes the
13-slot plan and the statement that migration 0064 is still absent. It does
not make the protocol remotely executable.

Application migration 0064 adds immutable execution ticket, activation, and
Authority acknowledgement tables. Campaign preparation now writes the 0063
authorization consumption, execution ticket, campaign, administrator audit,
and exact readbacks in one batch while every placement writer gate remains
false. The ticket binds the candidate, permit and campaign lifetime,
14-operation schedule, Controller versions, application D1 identity,
Authority D1 identity, and Authority ledger identity. These identities come
only from deployment configuration.

The Authority claim binds the same ticket and database identities. Operation
4 is the activation handshake, operation 5 records enable intent and performs
the only eligible Controller enable deployment, operations 6-13 are the eight
ordered shard probes, and operation 14 restores and proves the disabled
deployment. Authority D1 rejects operation 5 until an exact successful
operation-4 terminal receipt has projected the application activation digest.
The application D1 rejects a campaign claim until both its activation row and
its exact Authority acknowledgement mirror exist.

The Controller read path now requires the exact authorization, ticket,
activation, acknowledgement, and campaign tuple before any Durable Object
lookup or shard wake. Migration and evidence totals advance to 64 migrations,
75 tables, 1032 checked incremental columns, and 109 key indexes.

The protocol remains deliberately unable to enable staging. The remaining P0
work is:

1. add the authenticated application activation writer after exact Authority
   claim readback;
2. add the private Authority operation-4 workload path and application-D1
   Service Binding readback;
3. add the application acknowledgement writer after exact Authority receipt
   and ledger-head readback;
4. close the cross-D1 revocation race at every pre-enable boundary;
5. reserve receipt capacity for disable, bound renewal churn, and complete
   in-flight safety-diversion recovery;
6. replace shared execution secrets with independently scoped and rotated
   workload identities protected by Access;
7. add cross-runtime fixed vectors and fault campaigns for every ticket,
   activation, acknowledgement, receipt, response-loss, takeover, expiry,
   stale-read, revocation, and disable-ambiguity path; and
8. independently prove remote bindings, database identities, exact catalogs,
   zero-row baselines, gates, versions, credentials, and revocation state.

The first isolated-staging ceremony may reach operation 5 only after the exact
operation-2 preparation, operation-3 claim, and two-ledger operation-4
handshake are durably read back. Ambiguity before operation 5 grants no
mutation authority. Ambiguity after enable intent grants only readback and
operation-14 disable authority. The historical Cloudflare credential must be
revoked and independently proven absent before any remote read or write.
The complete repository gate passes with exit code 0 in 1043.0 seconds; the
Worker library separately passes 875 tests, and existing Rust `dead_code`
findings remain warnings only. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-28 Application Ticket Activation Writer

Phase 1 now includes the default-off application-D1 activation writer and a
bounded, signed private-Service-Binding read client for the placement
Authority. This section supersedes the first remaining-P0 item in the
two-ledger checkpoint above. The operation-4 handshake is still incomplete.

The root-only activation endpoint performs secure verification before parsing
a strict 4 KiB request, loads the immutable 0064 ticket and current
authorization from application D1, and reads the exact ticket-bound claim
from the Authority. It accepts only the staging environment. Deployment-owned
database and ledger identities, D1 `unixepoch()` time, Authority version,
receipt chain, operation IDs, and credential identity cannot be supplied by
the caller.

Fresh activation is admitted only for the exact pristine generation-1 claim
at operation 4 with one acquisition receipt, the complete operation 4-14
schedule, no in-flight or projected mutation, and unexpired authorization,
permit, campaign, and ticket. The D1 write is create-only and batches the
activation, administrator audit, and exact readback. Exact existing evidence
classifies response loss without another write, including after the write gate
is returned to false.

An activation row is pending cross-ledger evidence, not operation-4 success.
Authority operation 4 must revalidate and conditionally consume the then
current claim, ledger head, lease generation, deadlines, and revocation in
Authority D1. Any Authority change racing the application write must deny the
later transition.

Local and staging declare `SHARD_PLACEMENT_AUTHORITY`, but the Authority read
and application activation writer gates remain false. The HMAC secret is a
Worker secret and is absent from tracked variables. Production declares no
binding or gates. The Rust token has a TypeScript verifier fixed vector.

This root bootstrap endpoint is not the final runner workload boundary.
Remaining Phase 1 P0 work is the private/scoped workload gateway, Authority
operation-4 application readback and receipt writer, exact application
acknowledgement mirror, immediate pre-operation-5 revocation closure,
reserved disable capacity, bounded recovery, independent credential rotation,
adversarial fault campaigns, and independent remote evidence. No remote state
or credential was accessed. Go/VPS remains authoritative and production
remains **NO-GO**.

The complete local repository gate passed with exit code 0 in 935.6 seconds.
The Worker library passed 886 tests and the Wasm build retained only the 21
existing `dead_code` warnings.

## 2026-07-28 Operation-4 Two-Ledger Handshake

Phase 1 now has a complete local, default-off operation-4 handshake. The
application exposes one authenticated exact activation read through an
independent application HMAC domain. Authority persists operation start before
that cross-Worker read, validates the strict no-store response, re-reads its
current lease/receipt/revocation state, and appends one terminal receipt whose
response digest covers the exact application bytes. Application then mirrors
that exact terminal/head/version tuple in the append-only 0064 acknowledgement
table with administrator audit and exact readback.

Application reads use one D1 batch for ticket, activation, and D1-time context.
Authority retries require the same receipt credential and HMAC request
identity. Response loss can resume an existing start but cannot resend a
mutation or substitute new activation evidence. Existing terminal and
acknowledgement rows classify only exact replay.

The undeployed Authority 0002 start and terminal triggers now keep operation 4
on the pristine generation-1 claim with the sole acquisition predecessor and
reject a racing revocation or any lease, renewal, takeover, enable, credential,
request, predecessor, or evidence drift. SQLite tests prove a taken-over claim
cannot start operation 4 and a revoked in-flight claim remains unprojected. The
application activation bootstrap also now correctly requires the Authority's
initially verified disabled Controller baseline.

All new local/staging gates are false and every secret remains a Worker secret
placeholder outside tracked configuration. Production declares neither side
of the new Service Binding. This is not operation-5 authority: remaining P0 is
the immediate pre-enable revocation plus acknowledgement fence, independently
scoped workload identities, the operation 5-14 resumable runner, adversarial
cross-Worker fault campaigns, remote inventory/credential evidence, and the
Go/VPS shadow, rollback, drain, and reverse-sync ceremony. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-29 Operation-5 Pre-Enable Admission

Phase 1 now includes a local, default-off operation-5 admission boundary. The
Authority uses an independent `enable` HMAC identity, reads the immutable
application ACK through its independently authenticated Service Binding,
re-reads the current Authority claim, and writes one immutable admission plus
the sequence-4 operation-start receipt in a single D1 batch. That start is the
local enable-intent linearization point; this checkpoint performs no
Controller or Container mutation.

The admission binds the ACK digest and raw response hash, application and
Authority versions, both database identities, the operation-4 terminal/head,
ACK-reader and enable-writer credentials/requests, operation-5 request, and
expected start receipt. D1 independently requires a live generation-1 lease,
zero renewal/takeover, no revocation, exact operation-4 projection, and live
normal/permit deadlines. Missing ACK admission, raced revocation, lease
drift, or any receipt mismatch rejects the whole batch.

Operation 4 and operation 5 are no longer accepted through the generic
receipt route. They use independent `activate` and `enable` identities with
current/previous overlap. Application activation-read and ACK-read verifiers
also have current/previous overlap and reject cross-role key, credential, or
secret reuse when both roles are configured. All tracked local/staging values
remain blank or false and production remains absent.

Source review confirms the 5-14 runner must use deterministic tenant/ring
evidence and durable CAS ownership. cinaVibeSDK's DO-by-name ownership and
bounded process states are useful, but `hash(session) % N`, process-local
maps/timers/promises, unlimited retry, and container filesystem metadata are
not control-plane truth. cinatoken-go's post-selection revalidation and
affected-row CAS winner semantics are retained for exact shard/version
readback and single-side-effect ownership.

Next is the durable operation-5 dispatch/outbox and status-only ambiguity
recovery, followed by ordered shard probes 6-13 and reserved operation-14
disable. The application seal context must be re-read immediately before
dispatch because the two D1 databases cannot share a transaction. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-29 Operation-5 Prepared Dispatch Outbox

This Phase 1 increment adds only the durable preparation
half of operation-5 dispatch. After the existing admission and sequence-4
start, Authority performs a second exact Application ACK read, then re-reads
its own claim and receipt fence, and finally creates one immutable outbox row
with `outbox_state='prepared'`.

The second ACK uses the separate `op5-dispatch` request domain and must still
prove the Application campaign is unsealed, the ticket and Controller
identities are exact, and every application-owned deadline is live at
Application D1 time. The following Authority re-read rejects revocation,
lease, owner, generation, token, renewal, takeover, receipt-head, operation,
activation, database, version, and schedule drift before the D1 insert.

This checkpoint is intentionally not a sender:

- there is no Controller Service Binding or network call;
- `prepared` is neither a dispatch claim nor a send permission;
- exact replay returns the same immutable evidence without re-reading the ACK;
- a prepared row cannot prove Controller enable, Container readiness, or an
  operation-5 terminal; and
- the sequence-4 start remains enable-intent admission, not final send
  linearization.

Authority preparation is protected by an independent `dispatch` HMAC role.
`SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED` and
`SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED` are separate,
required, default-off gates. Both remain false in tracked local/staging
configuration. Even when both are enabled in a future isolated ceremony, they
authorize only the second read and prepared-row write, not Controller traffic.

The next P0 is the Application D1 create-only pre-enable grant. Its single D1
transaction must make the campaign seal and application deadlines race against
grant creation, bind the exact prepared outbox and frozen Controller command,
and become the final send linearization point. Authority may then add a
durable one-owner dispatch claim and sender. Any timeout or response loss must
use Controller status-only readback and must never resend enable.

After exact operation-5 recovery, the runner still owes ordered shard proofs
for operations 6-13 and the pre-reserved operation-14 disable path, including
takeover, rollout, stale-read, revocation, seal-race, response-loss, and
disable-failure campaigns.

No production Authority configuration, grant, sender, Controller mutation,
Container wake, remote evidence, traffic change, billing authority, reverse
sync, drain, or DNS change is established by this increment. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-29 Application Pre-Enable Grant

Phase 1 now includes the next default-off operation-5 boundary. Application
migration 0065 creates one immutable pre-enable grant only while the exact
0064 ticket, activation, acknowledgement, authorization, unsealed campaign,
deadlines, Authority operation-5 admission/start, prepared outbox, ledger
head, Worker version, and frozen Controller identities remain admissible.
Application D1 time and triggers are the final write authority.

Authority uses a dedicated inbound `grant` identity and an independent
outbound Application `pre_enable_grant` identity. It reads the exact prepared
outbox, creates or exactly replays the Application grant over a private
Service Binding, re-reads its claim fence, and stores the exact Application
response in an immutable Authority D1 receipt. Activation-read, ACK-read, and
grant credentials are pairwise isolated. All tracked grant gates are false
and production configuration remains absent.

This closes Application-side pre-enable linearization only. It does not claim
a sender, call the Controller, prove enabled state, advance the operation-5
terminal, wake a Container, or prove shards. The next P0 is a durable
one-owner dispatch claim, persist-before-I/O Controller sender, status-only
ambiguity recovery with zero resend, exact operation-5 terminal readback,
ordered operations 6-13, and the reserved operation-14 disable path.

Migration totals are now 65 migrations, 76 required tables, 1056 checked
incremental columns, and 110 key indexes. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-29 Operation-5 Immutable Dispatch Claim

Phase 1 now includes a local, default-off create-only Authority dispatch
claim. One immutable row assigns the exact operation-5 command to one owner
only after the Application grant receipt, prepared outbox, operation-5 start,
lease, deadlines, revocation state, ledger head, versions, and frozen
Controller identities still match. Exact replay is read-only; conflicting
ownership or fence drift fails closed.

This checkpoint deliberately ends with `sendAttemptCreated=false` and
`controllerRequestSent=false`. The Application grant receipt and the new
Authority claim are durable history, not live Controller send authority. A
later seal, revocation, expiry, lease change, version change, or ledger drift
must still be able to stop the future send path.

The Authority verifier now accepts the declared `grant` role correctly and
adds an independently isolated `send` HMAC role. All claim gates remain false
in tracked local and staging configuration. Production placement
configuration remains absent.

The current Controller has neither a deployment-enable route nor a Cloudflare
deployment control-plane client. Its `/operations/status` routes cannot be
used as deployment status. Authority will not hold a deployment credential.
The future private `controller-deployment-gateway` alone may hold the minimum
Cloudflare credential and must provide the narrow create-once mutation plus
status-only readback boundary.

The next P0 sequence is Application-owned create-only dispatch consumption
ordered against campaign seal, one atomic attempt plus event before I/O, the
dedicated deployment gateway, and status-only ambiguity recovery with no
second enable. Application D1 remains 65 migrations, 76 required tables, 1056
checked incremental columns, and 110 key indexes; Authority migration
inventory remains two files.

The complete local repository gate, `bun run check`, passed with exit 0 in
703.8 seconds after this integration.

No secret was used and no remote state was read or changed. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-29 Operation-5 Dispatch Consumption and Receipt

Phase 1 now includes the local, default-off Application 0066 dispatch
consumption and Authority 0003 immutable receipt contracts. Application
consumption binds the exact grant, dispatch claim, owner and lease, deadlines,
ledger identities, versions, and frozen Controller command. Authority records
the exact Application response as append-preserved evidence.

The Application campaign seal and consumption are linearized by D1 commit
order. If the seal commits first, a new consumption fails closed. If the
consumption commits first, the one-shot right is historically consumed; a
later seal can still be recorded but cannot update, delete, or retroactively
undo that history. Exact historical replay is read-only evidence and never
restores new authorization after seal, expiry, or version drift.

This increment still stops before a sender:

- `sendAttemptCreated=false`;
- `controllerRequestSent=false`;
- no Controller, deployment gateway, queue, or Cloudflare control-plane I/O
  occurs; and
- the current Controller `/operations/status` route remains
  business-operation status, not deployment status.

Application D1 and Authority D1 cannot commit atomically. The remaining orphan
gap is a committed Application consumption with no Authority receipt after
response loss or process failure. Before a normal new consumption, Authority
requires at least 30 seconds remaining on each of the lease, normal deadline,
and permit deadline.

The Authority-to-Application client uses isolated current and previous
credential sets. It may use previous only when current receives a no-write
`409`, and only to replay the same deterministic request exactly. Previous
must be retained until its orphan window is proven empty; timeout,
disconnect, malformed response, or another status does not permit fallback.

The current protocol can append a missing receipt by exact POST replay only
while the Authority fence remains live, the same or previous credential is
retained, write gates remain open, and inbound HMAC and runtime trust still
pass. Authority receipt HTTP replay is not an unconditional read interface.
After revocation, expiry, gate closure, or required previous-credential
retirement, there is no independent historical Application readback route or
historical Authority receipt admission. Such an orphan remains permanently
fail-closed and must never create an attempt, send Controller, create a
second consumption, or renew send authority.

The next P0 blocker, before attempt/event, is an independent historical
Application readback route plus historical Authority receipt admission that
can append only the exact missing receipt without reviving send authority.
After that boundary, one Authority transaction may commit the immutable send
attempt and `send_started` event before external I/O. Phase 1 may then
introduce the independent private `controller-deployment-gateway` and its
create-once command plus status-only recovery. Authority must not hold the
deployment credential, and ambiguous mutation recovery must never resend
enable.

Application inventory is now 66 migrations, 77 required tables, 1096 checked
incremental columns, and 111 key indexes. Authority migration inventory is
three files (`0001-0003`). All related gates remain false in tracked local and
staging configuration, production placement configuration is absent, and no
secret or remote state was accessed. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-29 Historical Recovery And Send Attempt

The prior P0 recovery blocker is now implemented locally. Application provides
an independent HMAC-authenticated, bounded POST historical readback for an
immutable 0066 dispatch-consumption row. Application D1 time enforces a
2,592,000-second retention window, and the route is independent from live
write gates, leases, fences, current ownership, and normal deadlines.

Authority migration 0004 appends exact historical recovery evidence and the
missing canonical receipt in one first-primary D1 batch. Authority checks the
same retention contract across Application D1, Authority D1, and Worker
clocks. Recovery cannot create a send attempt, cannot contact Controller, and
cannot renew live authority.

Authority migration 0005 and the private send-role route now atomically create
one immutable operation-5 send attempt and its sequence-1 `send_started`
event. The event means unique send authority was persisted while network I/O
may not have occurred. Both records keep Controller/gateway sent flags at
zero. Only a definite first insert returns `sendAttemptCreated=true`; exact
replay returns false, and partial or mismatched state fails closed.

This phase deliberately stops before external mutation. There is no Controller
or Cloudflare API call and Authority holds no deployment credential. The next
P0 is a separate private `controller-deployment-gateway` that accepts one
frozen create-once command only from a newly created attempt and exposes
status-only recovery for every ambiguous outcome.

Architecture inheritance is now explicit: retain deterministic ownership,
Durable Object persistence, Go compare-and-swap, and transactional
idempotency; use keyed Jump Consistent Hash instead of modulo resizing; reject
post-I/O authority persistence and best-effort asynchronous authority audit.

Application inventory remains 66 migrations / 77 tables / 1096 checked
incremental columns / 111 key indexes. Authority inventory is now five files
(`0001-0005`). The full repository `bun run check` and focused Rust, wasm,
Workerd, migration, protocol, and configuration suites pass. All tracked
gates remain false, production
placement configuration is absent, no secret or remote state was accessed,
Go/VPS remains authoritative, and production remains **NO-GO**.

## 2026-07-29 Operation-5 Terminal Receipt

Phase 1 now closes operation 5 locally without adding another external call.
The dedicated receipt-role route consumes only the latest immutable
`gateway_status_stable` event. Authority migration 0007 inserts the terminal
sidecar, projects execution receipt sequence 5, advances the claim to
`last_completed_ordinal=5`, clears inflight, and identifies operation 6 in one
D1 statement.

The terminal manifest binds the attempt, send-started event, stable Gateway
chain head, operation start, admission evidence, Controller enabled version,
Gateway and Authority Worker versions, database and ledger identities,
terminal writer identity, before-ledger head, and operation-6 successor. The
generic receipt retains the operation-start actor identity required by
migration 0002. Exact replay reads the sidecar only and makes zero Gateway or
Cloudflare calls.

Gateway public status evidence now uses a deployment-state digest rather than
a per-request event digest. Distinct status requests can prove unchanged
state; classification, HTTP status, deployment set, or target-version evidence
drift changes the digest and prevents stability. The Controller enabled
version ID and Cloudflare version response SHA remain separate.

All tracked terminal, Gateway, and placement gates remain false. No remote
state or secret was accessed. Operations 6-14, remote proof, rollback
campaigns, reverse sync, drain, traffic, DNS, security, SRE, and migration
approvals remain open. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-29 Accepted-Work Drain Reader Foundation

Operations 6-14 now have local control-plane implementations documented in
the migration plan; this checkpoint corrects the rollback order around
operation 14. The named **Accepted Work Drain and Traffic Return Safety v1**
protocol is not operation 15:

```text
D1 admission fence
-> immutable accepted-set freeze
-> terminal ACK, billing, reconciliation, reverse sync, and drain
-> per-operation ambiguity quarantine
-> operation 14
-> independent traffic-return review
```

The preceding reader checkpoint provided only persisted shard drain counts,
separate `execution_stop_eligible` and local `accepted_work_drained`
predicates, activity-expiry stop protection, and a default-off authenticated
Controller read over fixed shards 0-7. Its response always sets
`traffic_return_authorized=false`.

Its next implementation boundary was the expand-only 0067 global drain schema
and D1 admission-fence design, with every new write gate false. Before 0068
enforcement, all old writers must be inventoried and drained. Accepted-set
membership, cross-layer financial joins, ambiguity quarantine, reverse sync,
stable observations, operation-14 prerequisite enforcement, and independent
traffic-return review remain open.

See
[`accepted-work-drain-traffic-return.md`](accepted-work-drain-traffic-return.md).
No Cloudflare remote state or Go/VPS authority changed. Production remains
**NO-GO**.

## 2026-07-29 Global Accepted-Work Drain Expand Ledger

Application migration `0067_relay_container_drain_expand.sql` now provides the
local expand-only global ledger for the accepted-work drain protocol. It adds
eight scope-bound tables for campaigns, events, frozen members, member/global
observations, exact shard observations, per-operation ambiguity quarantine,
reverse synchronization, and eligibility-only traffic-return receipts.

The database contract is deliberately default-inert:

- campaign insertion requires the future
  `0068_relay_container_drain_admission_enforce.sql` migration marker;
- one active campaign is allowed per environment and scope; a terminal
  `recovery_required` or `aborted` campaign permits only the next exact fence
  generation;
- accepted membership uses strictly increasing
  `(accepted_sequence, operation_id)` keysets and contiguous page/member
  ordinals; NULL page/count fields are rejected, and the seal must equal the
  campaign's frozen member count, declared manifest, and first/last key;
- campaign state can advance only through an append-preserved hash-linked
  event;
- every accepted member needs one immutable terminal/ACK/financial/outbox/
  reconciliation/R2/reverse-sync closure observation whose terminal and ACK
  identities match the frozen member;
- a quarantined closure requires its exact immutable non-replay quarantine;
- shard observations must use the frozen per-shard accepted watermark and an
  immutable 0061 placement attestation for the exact Controller/ring/shard;
- reverse-sync snapshot/schema/bookmark/count/high-watermark values must match
  the campaign freeze, generations are contiguous, and only the latest is
  eligible for drain;
- a `billing_hold` quarantine prevents a zero billing-open observation;
- drain sealing requires the latest two consecutive observation generations
  separated by the frozen stability window, equal request-independent state
  and billing-conservation digests, exact shard coverage, zero open or
  unclassified work, and a passing reverse-sync manifest, with stable
  per-shard placement, owner generation, snapshot digest, Controller state,
  drain predicates, and open counts;
- operation 14 cannot be recorded before the successful drain seal; and
- a traffic-return record must bind the stable closure, quarantine, billing,
  reverse-sync, and operation-14 evidence, is rejected until future 0069 typed
  evidence enforcement is installed, and can state only
  `eligible_for_traffic_return_review=1` while the database requires
  `traffic_return_authorized=0`.

The Rust repository adds exact migration, ordered-column, index, and trigger
readiness plus a validated read-only campaign lookup. It does not expose a
0067 mutation method. `/api/platform/capabilities` now reports 0067 readiness,
all five write gates, their aggregate all-false state, and that traffic-return
authorization is not compiled.

This is structural binding, not yet authoritative source completeness. 0068
must derive the frozen values atomically from admission rows and independently
recompute every source/member/page/set digest. The production writer must also
resolve the existing immutable billing snapshot and replay the complete
normalized settlement vector against the canonical expression; 0067 does not
duplicate or prove that formula.

The five gates are explicitly `false` in tracked local, staging, and production
Worker configuration:

- `CONTAINER_DRAIN_CAMPAIGN_WRITE_ENABLED`;
- `CONTAINER_DRAIN_OBSERVATION_WRITE_ENABLED`;
- `CONTAINER_AMBIGUITY_QUARANTINE_WRITE_ENABLED`;
- `CONTAINER_REVERSE_SYNC_MANIFEST_WRITE_ENABLED`; and
- `CONTAINER_TRAFFIC_RETURN_RECEIPT_WRITE_ENABLED`.

The canonical local SQLite verifier now executes the complete positive
lifecycle and negative cases for missing 0068, incomplete and NULL membership,
duplicate active scope, exact recovery generation, terminal/ACK identity
drift, operation-14 ordering, append-only evidence, frozen reverse-export
identity, reverse-generation gaps, stale placement, shard-watermark and
Controller-state drift, snapshot-digest drift, billing-hold blocking, skipped
global generations, `A -> B -> A` stability resets, exact shard coverage,
missing 0069, receipt manifest drift, and non-authorizing receipts.
Application inventory is 67
migrations / 85 required tables / 1310 checked incremental columns / 126 key
indexes.

Next is not to enable a gate. The next production boundary is 0068 design and
stale-writer inventory: enumerate every admission writer, prove compatible
0067 readers are deployed, freeze the exact admission transaction contract,
and test old/current Worker races in isolated staging before enforcement is
created. After 0068, 0069 must add typed campaign-bound approval/WORM evidence,
validity/retention rules, and reviewer independence before the receipt writer
can be considered. No Cloudflare remote state or credential was accessed.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-30 Global Container Admission Enforcement

Application D1 head is now
`0068_relay_container_drain_admission_enforce.sql`. The migration adds an
append-preserved fence/head/commit authority, deterministically backfills
historical 0050 admissions, and makes every new Container operation require a
current fence-bound commit in the same D1 batch. The compatible canary writer
loads the open environment fence before its R2 input write and commits the
0068 sidecar before the 0050 receipt, aliases, reservation, quota debits,
channel recheck and prepared operation.

The local close contract is also fail-closed: it derives accepted
high-watermark/count/first/last keys from D1, rejects any open operation absent
from the commit ledger, requires the exact current scope head, and must create
the matching 0067 campaign at the same D1 time. Because 0067 binds cutoff to
campaign creation time, the production control plane still needs a one-step
command trigger; two D1 statements that cross a second must fail closed.
Replay and settlement first inspect the migration marker: the compatible
Worker preserves 0050-only reads before 0068, while an installed 0068 requires
and verifies the commit sidecar and current writer's canonical digest.
Historical backfills remain replayable after the fence closes.

0068 is intentionally one-way. The scope head is immutable after creation,
and `recovery_required` or `aborted` cannot reopen admission. Restoring Rust
admission would require a separately reviewed migration and authorization
protocol.

The exact local inventory is 68 migrations / 88 required tables / 1365 checked
incremental columns / 129 key indexes. SQLite verification, 914 Rust library
tests, and 19 real-workerd atomic-admission tests pass for this checkpoint.

This is still default-closed infrastructure. No authenticated initial-fence
or close writer/route exists, the one-shot historical backfill still needs
cardinality and D1-duration proof, manifest/source digests remain
caller-attested, every 0067 write gate remains false, 0069 is absent, and
traffic-return authorization is not compiled.

P5 manifest v3 now requires eleven evidence kinds, including a strict
`admission-fence` item. Its offline assembler verifies canonical capture input,
all eleven fixed digest-only supporting projections, candidate/foundation
binding, N/N-1 writer drain, false gates, same-time close/campaign evidence,
rejection/replay outcomes, and rollback identity. This is contract tooling,
not authenticated remote evidence. The collector performs no network request,
reads no credential, writes no file, and cannot make a production close
possible without the one-SQL-step command migration.

No Cloudflare credential or remote state was used. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-30 Typed Traffic-Return Evidence Enforcement

Application D1 head is now
`0069_relay_container_traffic_return_evidence_enforce.sql`. Three immutable,
campaign-bound tables store the review subject, exactly eight typed evidence
items, and the final evidence seal. D1 enforces fixed evidence-type/issuer-role
mapping, distinct issuer identities and signing keys, bounded validity,
retention, WORM/policy identity, no post-seal items, independent assembly,
sealing and review roles, and append preservation.

The 0067 receipt guard is replaced. A migration marker or arbitrary valid
hashes can no longer satisfy receipt eligibility: every receipt field must
resolve to the exact 0069 subject, seal, and eight evidence items while they
remain valid and retained. The database continues to force
`traffic_return_authorized=0`.

The exact local inventory is 69 migrations / 91 required tables / 1424 checked
incremental columns / 133 key indexes. P5 candidate/schema identity advances
to 0069, while the admission-fence evidence remains pinned to the exact 0068
SQL digest.

This remains default-inert. There is no evidence mutation repository or
route, all five drain write gates remain false, and the separate
one-SQL-step fence-close/campaign command is still absent. No remote
migration, credential, route, DNS, traffic, or Go/VPS authority changed.
Production remains **NO-GO**.

## 2026-07-30 Atomic Drain Close Command

Application D1 head is now
`0070_relay_container_drain_close_command.sql`, with 70 migrations, 92
required tables, 1463 checked incremental columns, and 137 key indexes. This
overlay retains the 0069 typed-evidence boundary and closes only its stated
local one-step command gap.

One append-preserved command `INSERT` now drives a D1 trigger that compares
the exact 0068 head and open fence, verifies the D1-derived accepted-set
boundary, closes the fence, and creates the 0067 campaign in one SQLite
statement. A standalone close or campaign insert is no longer valid. Real
Workerd coverage proves the path with a nonempty accepted set and rejects a
late admission without partial writes. SQLite fault injection proves a failed
campaign insert rolls back both the command and fence mutation.

The Rust repository exposes exact schema readiness, strict joined readback,
and a default-inert apply method. The method requires an admin-audit prepared
statement and batches a fresh command insert, audit, and exact readback. It
has no route, credential, runtime write gate, or production call site.

Current P5 schema identity advances to 0070. Immutable admission provenance
does not: it remains pinned to
`0068_relay_container_drain_admission_enforce.sql` with SHA-256
`fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50`.
The accepted bookmark, manifest, source schema, and source readback remain
caller-attested pending independent recomputation from the authoritative
admission source.

0070 does not change billing-expression or settlement semantics. No remote
D1/Cloudflare migration, readback, credential, route, gate, deployment, DNS,
traffic, or Go/VPS authority was accessed or changed. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-30 Accepted-Set Source Seal

Application D1 head is now
`0071_relay_container_drain_accepted_set_source_seal.sql`, with 71 migrations,
97 required tables, 1550 checked incremental columns, and 144 key indexes.

Five append-preserved source-evidence tables now bind the 0070 command to an
exact 0068 admission scan. D1 enforces contiguous accepted-sequence copying,
deterministic member/page ordinals, complete chained pages, all shard
manifests including empty shards, distinct assembly/verification identities,
and source cardinality checks at both seal and close time. The close command
cannot use a caller-supplied bookmark, accepted-set manifest, source-schema
digest, or source-readback digest unless the same values resolve through one
complete immutable seal.

The source-schema identity remains pinned to the unchanged 0068 normalized SQL
SHA-256
`fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50`.
Local SQLite and Workerd verify multi-page/multi-shard success, empty shards,
missing evidence, tampering, ordering errors, identity conflicts, and late
admission before seal or close.

Phase 1 still does not have a production writer. The next boundary is a root
Application Worker D1 Session collector plus independent verifier, typed
machine authorization/audit receipt, signature validation, response-loss
classification, and isolated-staging N/N-1 fault campaign. No route, secret,
gate, or remote apply is included here. Billing-expression and settlement
semantics are unchanged. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-30 Accepted-Source Authorization Boundary

Application D1 head is now
`0072_relay_container_drain_source_authorization.sql`, with 72 migrations, 99
required tables, 1611 checked incremental columns, and 148 key indexes.

0072 is a reader-first, default-inert authority boundary. Its migration
requires an empty 0071 source ledger before apply and then enforces one exact,
short-lived source authorization plus ordered, independently keyed assembler
and verifier attestations before a source seal. Rust verifies canonical
Ed25519 subjects against three deployment-pinned SPKI roles and hashes the raw
execution nonce without returning it.

The repository uses a private worker-rs 0.5 D1 Sessions bridge for exact
schema and authority readback through `withSession("first-primary")`. Only the
bookmark SHA-256 leaves the bridge. Real Workerd validates that capability.
Sequential consistency does not freeze the source; a future collector still
needs a captured high watermark, bounded keyset pagination, phase-boundary
fence/head/cardinality rereads and independent source recomputation.

Phase 1 still has no 0072 issuer, one-time authorization claim, collector,
terminal receipt, R2 evidence writer, route, credential, write gate, close,
traffic-return or reopen authority. The next production boundary requires
RootAuth plus fresh phishing-resistant second-factor issuance, atomic claim
and admin audit, exactly one terminal outcome, Session batch and
unknown-commit handling, create-only retention-locked R2 evidence, and remote
isolated-staging concurrency/fault/rollback proof.

No billing-expression or settlement semantics changed, and no remote
Cloudflare state or Go/VPS authority changed. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-30 Source-Authorization Consumption Boundary

Application D1 candidate head is now
`0073_relay_container_drain_source_authorization_consumption.sql`, with 73
migrations, 103 required tables, 1701 checked incremental columns, and 156 key
indexes.

0073 adds append-preserved registration, claim, terminal, and global receipt
ledger authorities around 0072. A claimed lease can terminalize as `expired`
without a source scan or seal. A successful terminal instead requires the
exact scan and independent attestations, then atomically projects the 0071
seal and terminal ledger receipt in one SQLite statement. The 0070 close
command requires that retained successful terminal and projected seal.

Registration checks a live user-present/user-verified passkey row and exact
`auth_method=passkey` audit evidence at insert time. Its passkey row ID is
intentionally not retained as a foreign key, so credential rotation or
deletion does not invalidate immutable digest evidence.

This remains a default-inert repository boundary, not a production control
plane. The root Worker now has crate-private first-primary Session batch
support plus unreachable claim and terminal methods with exact readback and
`FreshApplied` / `ExactReplay` / `Conflict` / `OutcomeUnknown`
classification. Workerd counts immutable trigger projections, so fresh
requires the exact operation-specific count plus exact readback: claim `2`
(claim plus ledger), non-success terminal `2` (terminal plus ledger), or
successful terminal `3` (terminal, seal and ledger). Replay requires explicit
`changes=0`; every other count, malformed metadata, batch error and unreadable
readback remains unknown. A fail-closed pre-mutation gate binds 34 exact
schema-object fingerprints and four table PRAGMA fingerprints. Registration
mutation remains absent, and the claim/terminal methods have no route, worker
or gate.

There is no action-bound one-shot passkey ceremony, hard-UV issuer, dedicated
atomic audit writer with exact `request_id`, permit-only verifier, isolated
issuer, claim worker, collector, route, credential, gate, close authority,
traffic-return authority, or reopen authority. Those M1 controls must exist
before any registration writer can be connected.

P5 candidate and schema contracts advance locally to `73/103/1701/156` only.
No remote 0073 application, readback, deployment, credential, route, traffic,
or authority change is claimed. Go/VPS remains authoritative and production
remains **NO-GO**.
