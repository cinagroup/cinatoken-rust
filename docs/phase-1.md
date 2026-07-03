# Phase 1 Notes

This phase creates the Rust workspace and a Cloudflare Worker MVP.

## Implemented

- Workspace crate layout.
- Worker route entrypoint.
- `GET /api/status`.
- `GET /v1/models`.
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
- `crates/session` implements the stateless HMAC-signed session cookie codec
  (base64url JSON payload + HMAC-SHA256 signature). 10 unit tests cover
  round-trip, tamper/expiry rejection, and secret-length enforcement. Cookie
  name is `session` and attributes are `HttpOnly; SameSite=Strict; Secure`,
  matching the React dashboard's expectations.
- Operational dashboard compatibility (`crates/worker/src/operations.rs`):
  `GET /api/uptime/status` reads Uptime Kuma group options and performs
  bounded outbound JSON fetches with timeout/body limits and SSRF guardrails;
  `GET /api/perf-metrics/summary` and `GET /api/perf-metrics` aggregate D1
  `logs` into the frontend's model-performance schema; root-only
  `/api/performance/*` routes return explicit Worker-native no-op responses
  for local disk/GC maintenance while preserving admin audit logs.
- `crates/auth` gained bcrypt password helpers (Go-compatible PHB format),
  role/status constants, and `is_admin`/`is_root`/`outranks` helpers.
- Worker admin auth surface (`crates/worker/src/admin.rs`): `POST
  /api/user/login`, `POST /api/user/logout`, `GET /api/user/self`,
  `GET /api/setup`, `POST /api/setup`, plus `require_user_auth` /
  `require_admin_auth` / `require_root_auth` middleware helpers for the next
  G5 batch.
- `GET /api/status` reports `session_auth: true` when `SESSION_SECRET` is
  configured.
- Frontend deploy pipeline: `wrangler.toml` `[assets]` block + Worker SPA
  fallback (`is_static_asset_path` + `env.assets("ASSETS")`) + `build:web` /
  `build:all` scripts. Same-origin deployment keeps the React dashboard's
  cookie auth working without frontend changes.
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
  delete with token cache invalidation.
- Non-tiered billing (`crates/billing/src/flat.rs` + `pricing.rs`): models
  without a `tiered_expr` but with a `ModelRatio`/`ModelPrice` option now
  charge quota via the per-token or fixed-price formula, wired into
  `record_relay_audit`. OpenAI-vs-Anthropic cache semantics, zero-usage
  guard, and the `quota <= 0 → 1` floor all match Go.
- Tokenizer crate (`crates/tokenizer`): char-class estimator (OpenAI /
  Claude / Gemini family weights) used by the tiered preflight for prompt
  sizing. Settlement still uses provider-reported usage.

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
- Extend the explicit request-body mode foundation with multipart/raw/stream
  modes before adding `/v1/audio/transcriptions` and
  `/v1/audio/translations`; the current JSON relay path must not buffer
  unbounded file uploads. Mode metadata, shared content-type policy, and
  bounded byte reading are in place; the next step is raw/multipart extraction
  and upstream forwarding.
- Continue defining explicit response buffering limits as each broader
  provider-specific transform is added.
- Add provider-specific adapters beyond OpenAI-compatible providers.
