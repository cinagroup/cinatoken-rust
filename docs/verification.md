# Verification

Last checked: 2026-07-01

## Passed

- `cargo fmt --all`
- `cargo test --workspace --exclude cinatoken-worker`
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
- `bun run check` from `C:\cinagroup\cinatoken-rust`.
- `cargo test -p cinatoken-relay` covering OpenAI-compatible relay helpers,
  generalized `/v1/...` upstream URL generation, Anthropic Messages URL
  generation, native Gemini path parsing and upstream URL generation, relay
  cache key normalization, token fingerprinting, JSON/SSE usage parsing,
  Responses `response.completed` usage parsing, GPT image generation usage
  parsing, nested usage token details, Anthropic cache usage details,
  Anthropic streaming `message_start`/`message_delta` usage merging, Gemini
  generate and embedding `usageMetadata` parsing, Gemini `countTokens`
  `totalTokens` parsing, Jina/Cohere rerank URL and usage parsing including
  Cohere `search_units`, split streaming byte chunks, and versioned
  token/channel cache wrappers.
- `cargo test -p cinatoken-migration` covering `dev-seed` SQL generation.
- `cargo test -p cinatoken-migration` covering source repository inspection
  argument parsing and local SQLite candidate discovery.
- `cargo test -p cinatoken-migration` covering SQLite export argument parsing,
  default core table selection, `--all`, and unknown-table rejection.
- `cargo test -p cinatoken-migration` covering D1 import SQL argument parsing,
  supported-table validation, SQL literal escaping, and `abilities.group` to
  `abilities.group_name` mapping.
- `cargo test -p cinatoken-migration` covering migration verification argument
  parsing, export-bundle validation, malformed-row rejection, and D1 SQL
  execution against SQLite.
- `bun run inspect:source -- --repo Z:\cinatoken` confirming the source
  checkout has the expected Go/backend/frontend markers.
- Smoke-tested `cinatoken-migrate export --sqlite ... --output ... --table users
  --table tokens` against a temporary SQLite database; JSON output included both
  tables and expected rows.
- Smoke-tested `bun run export:sqlite` followed by `bun run import:d1-sql`
  against a temporary SQLite source database, then executed the generated SQL
  with `python tools/verify_sqlite.py --seed <generated.sql>`.
- Smoke-tested `bun run verify:migration -- --input <export.json> --sql
  <generated.sql>` against a generated export and D1 SQL pair.
- `cargo test -p cinatoken-billing` covering quota conversion, settlement
  primitives, billing expression version/variable detection, expression
  execution helpers, request `param()`/`header()` probes, tiered
  pre-consume/post-consume settlement snapshots, and GPT/OpenAI versus Claude
  token normalization.
- `cargo test -p cinatoken-storage` covering shared storage record helpers.
- `cargo test -p cinatoken-cache` covering Upstash REST command encoding,
  response/error parsing, `/multi-exec` expiring counters, and rate limiter
  decisions.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` covering the
  Worker Upstash Redis REST fetch transport and status feature detection.
- `cargo test -p cinatoken-worker --lib` covering relay rate-limit and
  read-through cache TTL configuration parsing and invalid configuration
  rejection, chat/completions/responses/image generation/audio speech,
  Anthropic, and native Gemini streaming relay gating, D1 provider-family
  channel filters, native Gemini embedding/count non-stream action gating, D1
  billing option parsing, tiered settlement metadata, D1 quota mutation
  guardrails, and the Worker crate after D1 SQL was moved behind repository
  functions.
- `cargo test -p cinatoken-worker --lib` covering Worker request-body token
  estimation, max-token extraction, request-time tiered billing preflight
  snapshots, usage-detail token normalization, and settlement deltas against
  frozen snapshots.
- `cargo test -p cinatoken-worker --lib` covering `/v1/rerank` endpoint
  metadata, Jina channel type `38`, Cohere channel type `34`, local
  non-streaming rejection, Go-compatible `query`/`documents` and integer
  `top_n` validation, Cohere rerank request adaptation, Cohere rerank response
  transformation and request-estimate fallback, rerank request-token estimates, and
  endpoint-specific Jina/Cohere rerank usage parsing.
- `cargo test -p cinatoken-worker --lib` covering visible request-body media
  fallback counts for OpenAI-style and Gemini-style token preflight estimates,
  including request-time `img`/`ai` normalization when expressions reference
  those variables.
- `cargo test -p cinatoken-worker --lib` covering tiered reserve
  fallback/refund metadata and compiling the D1 repository pre-consume quota
  mutation paths.
- `cargo test -p cinatoken-worker --lib` covering tiered usage-log display
  metadata, Go-compatible base64 expression encoding, and matched-tier
  injection.
- `cargo test -p cinatoken-worker --lib` compiling the non-stream cloned
  upstream audit branch and buffered fallback path.
- `cargo test -p cinatoken-worker --lib` covering audio speech endpoint
  routing metadata and response-body usage parsing opt-out.
- `cargo test -p cinatoken-worker --lib` covering streaming missing-usage
  refund reason metadata and compiling the Worker streaming audit/reserve path
  for chat, completions, responses, image generation, Anthropic, and native
  Gemini.
- `cargo test -p cinatoken-worker --lib` covering relay JSON request-body
  limit configuration, invalid limit rejection, invalid JSON reporting, and
  payload-too-large errors before parsing.
- `cargo test -p cinatoken-worker --lib` covering relay JSON response-body
  limit configuration, fixed-body over-limit classification, and stream
  over-limit consumed-body classification for non-stream audit/transform
  guardrails.
- `cargo test -p cinatoken-worker --lib` covering endpoint-specific JSON
  response buffer defaults for embeddings, image generation, rerank, and
  native Gemini, plus the `RELAY_JSON_RESPONSE_LIMIT_BYTES` global override.
- `cargo test -p cinatoken-worker --lib` covering explicit JSON request-body
  mode metadata for current relay endpoints and the shared JSON preparation
  stage boundary.
- `cargo test -p cinatoken-worker --lib` covering the shared bounded relay
  request-byte reader error mapping used by the JSON body parser and future
  raw/multipart body modes.
- `cargo test -p cinatoken-worker --lib` covering JSON relay request
  `Content-Type` policy, including JSON media types and explicit multipart or
  octet-stream rejection before body reads.
- `cargo test -p cinatoken-worker --lib` covering the shared relay
  `Content-Type` policy layer for JSON, multipart, and raw passthrough modes.
- `cargo test -p cinatoken-worker --lib` covering relay request body mode
  metadata for JSON, multipart, raw-bytes, and pass-through stream modes plus
  pending-mode guard metadata.
- No live Jina or Cohere `/v1/rerank` upstream request has been executed yet.
- `bun run dev:seed:sql -- --model gpt-test --token-key ct-test --output .wrangler/dev-seed-test.sql`
  with a local Cargo target directory.
- Python `sqlite3` in-memory execution of `migrations/d1/0001_core.sql` plus
  generated dev seed SQL.
- `python tools/verify_sqlite.py`
- `cargo --version`: `cargo 1.96.0 (30a34c682 2026-05-25)`
- `rustc --version`: `rustc 1.96.0 (ac68faa20 2026-05-25)`
- `bun --version`: `1.3.14`
- `wrangler --version`: `4.101.0`
- Fetched latest `@cloudflare/workers-types` with `npm pack`; observed version
  `4.20260621.1`.
- Refreshed the production migration plan against current official Cloudflare
  Workers best-practices, Workers limits, Workers observability, and D1 limits
  docs; detailed execution gates now live in
  `docs/production-migration-execution-plan.md`.
- Added production readiness matrices and a staging smoke runbook, based on
  source router/model/channel inspection and current Cloudflare Workers
  best-practice, Wrangler config, compatibility date, observability, gradual
  deployment, and rollback references.
- Added Cloudflare production config and cutover/rollback runbooks, using
  current Cloudflare Workers best-practice, Wrangler config, environments,
  gradual deployment, rollback, observability, and D1 backup/restore references.
- Added `docs/data-migration-runbook.md` for production source inventory, export
  artifact policy, D1 import commands, row-count/sample-hash evidence,
  freeze/delta handling, rollback, and redacted import reports.
- Added `docs/billing-parity-runbook.md` after reading
  `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md`; it defines expression
  compatibility, golden fixtures, shadow settlement, billing gates, abort
  triggers, and redacted billing reports.
- Added `docs/route-provider-parity-runbook.md` for G3 route inventory,
  provider adapter contracts, body-mode policy, JSON/SSE smoke, failure-mode
  smoke, usage parser evidence, billing-shadow coupling, and redacted G3
  reports.
- Added `docs/observability-slo-security-runbook.md` for G6 structured logs,
  Workers Logs sampling and retention policy, SLO/abort thresholds, dashboard
  and alert matrices, security controls, staging alert drills, redaction checks,
  and incident templates.
- Added `docs/admin-frontend-parity-runbook.md` for G5 admin API, frontend
  deployment, auth/session strategy, operator CRUD smoke, cache invalidation,
  admin audit, secret redaction, and Scenario B go/no-go evidence.
- Added `docs/performance-capacity-cost-runbook.md` for performance load
  profiles, Worker/D1/Upstash/Queue/R2 capacity checks, cost forecasting,
  bottleneck ownership, and canary/full-cutover go/no-go evidence.
- Added local Cloudflare preflight scripts:
  `bun run check:cf:dry-run` for `wrangler deploy --dry-run --minify` and
  `bun run check:cf:startup` for `wrangler check startup` over a dry-run
  deploy.
- `wrangler.toml` now carries explicit `[env.staging]` and `[env.production]`
  blocks with `REPLACE_WITH_*` placeholder binding IDs, environment-scoped
  observability sampling (staging 1.0, production 0.1), and staging-suffixed
  resource names. The top-level block still describes the local development
  shape. See `docs/cloudflare-production-config-checklist.md` for the SOP.
- `OPENAI_COMPATIBLE_CHANNEL_TYPES` now covers 12 providers: OpenAI(1),
  Zhipu(16), OpenRouter(20), Moonshot(25), Perplexity(27), LingYiWanWu(31),
  SiliconFlow(40), Mistral(42), DeepSeek(43), MokaAI(44), xAI(48),
  Submodel(53). `default_base_url` returns each provider's documented
  upstream root, and `upstream_v1_url` now honors any trailing `/v<digit>`
  segment (including Zhipu's `/v4`) instead of always appending `/v1`.
- Relay now walks the full ordered channel candidate list and retries against
  the next candidate when an upstream returns a retryable status (Go-default
  `AutomaticRetryStatusCodeRanges` minus 504/524) or fetch fails. Reserve is
  applied once before the loop and refunded only when every attempt fails.
  Channels that return the auto-disable status set (default `{401}`) are
  marked disabled best-effort via `disable_channel_best_effort`, and a
  Redis-backed rolling error counter auto-disables channels that exceed
  `RELAY_CHANNEL_AUTOBAN_THRESHOLD` (default 5) within a 60s window.
  `RELAY_RETRY_TIMES` controls the retry budget (default 0 = single attempt).
- `crates/ssrf` ports the Go gateway's `common/ssrf_protection.go` validation
  surface (HTTP/HTTPS only, port allowlist, private/loopback/metadata IPv4
  and IPv6 CIDR table, domain allow/block lists, IP CIDR blocklist) behind a
  `SsrfPolicy`/`SsrfPolicyBuilder` API. 14 unit tests cover the Go parity
  cases. The module is standalone for now and is not wired into any Worker
  route; see `docs/ssrf.md` for the boundary and the DNS-resolution
  limitation.
- `migrations/d1/0002_admin_tables.sql` adds the `vendors` and `models`
  admin tables (mirroring Go `model/vendor_meta.go` and
  `model/model_meta.go`) plus the `logs` indexes (`type`,
  `(created_at, type)`, `token_name`, `channel_id`, `group`, `ip`,
  `username`, `(model_name, username)`) that back the upcoming admin log
  queries and the rpm/tpm stat. Verified via
  `python tools/verify_sqlite.py --seed migrations/d1/0001_core.sql --seed
  migrations/d1/0002_admin_tables.sql`.
- The migration CLI now imports `vendors` and `models` as first-class D1
  tables (`crates/migration/src/main.rs` `D1_IMPORT_TABLES`,
  `VENDORS_D1_COLUMNS`, `MODELS_D1_COLUMNS`, and the importer spec).
- `crates/session` implements the stateless HMAC-signed session cookie codec
  used by the Rust Worker. Format is `base64url(payload_json).base64url(hmac_sha256(payload))`;
  10 unit tests cover round-trip, tamper rejection, expiry, secret-length
  enforcement, and cookie header formatting. See `docs/admin-frontend-parity-runbook.md`
  for the "Forced re-auth on Rust" compatibility boundary (Go-issued cookies
  are not portable to Rust).
- `crates/auth` gained bcrypt password helpers (`hash_password` /
  `verify_password`, Go-compatible PHB format), role/status constants
  (`ROLE_COMMON_USER=1`, `ROLE_ADMIN_USER=10`, `ROLE_ROOT_USER=100`,
  `USER_STATUS_ENABLED=1`, `USER_STATUS_DISABLED=2`), and `is_admin` /
  `is_root` / `outranks` helpers.
- Worker admin auth surface landed: `POST /api/user/login`, `POST
  /api/user/logout`, `GET /api/user/self`, `GET /api/setup`, `POST
  /api/setup`, plus `require_user_auth` / `require_admin_auth` /
  `require_root_auth` middleware helpers in `crates/worker/src/admin.rs`.
  Login verifies bcrypt against `users.password`, issues a signed `session`
  cookie (`HttpOnly; SameSite=Strict; Secure`), and returns a Go-style
  `{success, message, data}` envelope. Setup bootstraps the initial root
  user when none exists.
- `GET /api/status` now reports `session_auth: true` when `SESSION_SECRET`
  is configured and at least 32 bytes long.
- Frontend deploy pipeline is in place: `wrangler.toml` carries an
  `[assets]` block (directory `apps/web/dist`, binding `ASSETS`,
  `not_found_handling = "single-page-application"`) in dev/staging/production;
  the Worker `fetch` handler routes non-API paths through
  `env.assets("ASSETS")` so SPA client-side routes survive hard refresh;
  `package.json` adds `build:web` and `build:all` scripts. The actual
  frontend bundle build and end-to-end smoke are G1 staging steps.
- Admin CRUD P0 routes landed (`crates/worker/src/admin_crud.rs`):
  - Logs: `GET /api/log/`, `GET /api/log/stat`, `DELETE /api/log/`,
    `GET /api/log/self`, `GET /api/log/self/stat` (admin + self paths, with
    self logs stripping `channel_id` and `other` for safety). Deprecated
    `/api/log/search` and `/api/log/self/search` return the Go-compatible
    "deprecated" envelope.
  - Options: `GET /api/option/` (root-only, sensitive keys filtered),
    `PUT /api/option/` (root-only upsert).
  - Tokens: `GET /api/token/`, `GET /api/token/search`, `GET /api/token/:id`,
    `POST /api/token/:id/key` (reveal), `POST /api/token/`, `PUT /api/token/`,
    `DELETE /api/token/:id`, `POST /api/token/batch` — all user-scoped
    (ownership enforced), list/get responses mask keys, create generates a
    `ct-<32 random>` key, and every mutation triggers
    `invalidate_token_cache`.
- Cache invalidation module (`crates/worker/src/cache_invalidation.rs`)
  implements Upstash Redis SCAN + bulk DEL for `relay:auth:*`,
  `relay:channel:*`, `relay:option:*`. Best-effort: failures fall back to TTL
  with a `console_warn!`. 5 unit tests cover SCAN response parsing.
- The migration CLI now accepts `midjourneys` as the unsupported-table
  example and vendors/models as first-class import tables (covered by
  `cargo test -p cinatoken-migration`).
- Channel admin Tier 1 CRUD landed (`crates/worker/src/admin_channel.rs`):
  `GET /api/channel/` (list with `type_counts` aggregation), `GET
  /api/channel/search`, `GET /api/channel/:id`, `POST /api/channel/`
  (create, single-mode only), `PUT /api/channel/`, `DELETE /api/channel/:id`,
  `POST /api/channel/batch` (batch delete), `POST /api/channel/fix` (rebuild
  the entire `abilities` table from `channels.models × channels.group`).
  Every write operation keeps the `abilities` table in sync so the relay's
  `select_channels_from_abilities` finds new/edited channels, and triggers
  `invalidate_channel_cache` so the relay drops stale channel cache entries.
  List/get responses never expose the upstream key (reveal is a separate
  RootAuth route, Tier 2).
- Channel + abilities D1 repository functions added in
  `crates/worker/src/d1_repositories.rs`: `list_channels`, `search_channels`,
  `count_channels`, `count_channels_by_type`, `find_channel_by_id`,
  `create_channel`, `update_channel`, `delete_channel`,
  `delete_channels_batch`, plus the load-bearing abilities sync helpers
  `add_abilities_for_channel`, `update_abilities_for_channel`,
  `delete_abilities_for_channel`, and `fix_abilities`.
- User admin CRUD landed (`crates/worker/src/admin_user.rs`): `GET
  /api/user/` (list), `GET /api/user/search`, `GET /api/user/:id`,
  `POST /api/user/` (create with role clamp `new_role < caller_role`),
  `PUT /api/user/` (edit username/display_name/group/remark/password),
  `DELETE /api/user/:id` (soft delete + token cache invalidation), and
  `POST /api/user/manage` (the 8-action switch: disable/enable/delete/
  promote/demote/add_quota×{add,subtract,override}). Permission rules match
  Go `canManageTargetRole`: promote is root-only; disable/delete/demote
  block if target is root; delete requires strict `caller_role >
  target_role`. Quota mutations use atomic SQL (`quota = quota + ?`).
  Responses omit `password` (SQL-level) and `access_token` (handler-level).
- User admin D1 repository functions: `list_users`, `search_users`,
  `count_users`, `count_search_users`, `find_user_by_id_full`,
  `find_user_role_status`, `create_user`, `edit_user`, `soft_delete_user`,
  `set_user_status`, `set_user_role`, `increase_user_quota`,
  `decrease_user_quota`, `override_user_quota`.
- Non-tiered ("flat") billing landed. When a model has no `tiered_expr`
  configured AND has a `ModelRatio` or `ModelPrice` option entry, the relay
  now computes and applies quota via `crates/billing/src/flat.rs`
  (`compute_flat_quota`), wired into `record_relay_audit` alongside the
  existing tiered path. The formula mirrors Go's
  `calculateTextQuotaSummary` core: `model_ratio × group_ratio` per-token,
  with `completion_ratio` premium, OpenAI-vs-Anthropic cache semantic
  branching, `model_price` fixed-price mode, zero-usage guard, and the
  `ratio != 0 && quota <= 0 → 1` floor. Audit metadata records
  `flat_billing: {quota, mode, model_ratio, completion_ratio, group_ratio,
  cache_ratio}`. 11 unit tests cover the core cases.
- Pricing config module (`crates/billing/src/pricing.rs`): loads
  `ModelRatio`, `CompletionRatio`, `ModelPrice`, `CacheRatio`,
  `group_ratio_setting.group_ratio`, `QuotaPerUnit` from D1 options as
  JSON maps. Defaults: ratio 1.0, quota_per_unit 500_000. 6 unit tests.
- Tokenizer crate (`crates/tokenizer`): char-class token estimator porting
  Go's `service/token_estimator.go`. Per-family weights (OpenAI / Claude /
  Gemini) with CJK / Latin / Number / Emoji / MathSymbol classification.
  Used by the tiered billing preflight (via `token_params_from_request`)
  for more accurate prompt-token estimates than the legacy char/4 heuristic.
  10 unit tests. tiktoken BPE is intentionally NOT embedded (Worker bundle
  size); settlement always prefers provider-reported usage.
- D1 `option_values(db, keys)` batch reader added for the pricing options
  round-trip.
- Multipart/raw body relay mode landed. Three upload endpoints are now
  wired and forward `multipart/form-data` bodies to the upstream verbatim:
  `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`,
  `POST /v1/images/edits`. The `model` form field is extracted via a
  lightweight boundary-split parser (`crates/relay/src/multipart.rs`,
  `extract_multipart_field`) so the relay can authenticate, route, and bill
  the request; the full multipart body is replayed to the upstream through
  `forward_raw_openai_compatible` (raw bytes via `Uint8Array`, original
  Content-Type with boundary preserved). Body limit for multipart
  endpoints is 25 MiB. 9 unit tests cover boundary extraction, text-field
  extraction, file-part skipping, and edge cases.
- `RelayRequestBody` enum (`Json(Value)` / `Raw { bytes, content_type }`)
  replaces the prior `Value`-only body shape, with `prepare_relay_request`
  dispatching to `prepare_json_relay_request` or
  `prepare_multipart_relay_request` based on the endpoint's
  `request_body_mode`.
- Three Chinese cloud AI providers added as OpenAI-compatible channel
  types: Baidu Qianfan v2 (type 15, `https://qianfan.baidubce.com/v2`),
  Ali DashScope compatible-mode (type 17,
  `https://dashscope.aliyuncs.com/compatible-mode/v1`), and Zhipu v4
  (type 26, `https://open.bigmodel.cn/api/paas/v4`). `OPENAI_COMPATIBLE_CHANNEL_TYPES`
  now covers 15 providers. Baidu's native ERNIE API (OAuth token exchange +
  per-model URL mapping) and Ali's native DashScope API
  (`/api/v1/services/...` rerank/image) are deferred to a later batch.
- Dashboard data endpoints landed (`crates/worker/src/admin_data.rs`):
  `GET /api/data/` (admin quota trend by model, with optional username
  filter), `GET /api/data/self` (user's own quota trend, 30-day cap),
  `GET /api/data/users` (admin quota trend by user), and
  `GET /api/usage/token/` (OpenAI-style token usage via Bearer token auth).
  All trends are computed live from the `logs` table with hour-floored
  `GROUP BY` (D1's `(created_at, type)` index makes this efficient). The
  Go gateway's `quota_data` pre-aggregation table + flush job is deferred
  (would require a Cloudflare Cron Trigger).
- Stripe topup MVP landed (`crates/worker/src/admin_payment.rs` +
  `crates/payments/src/lib.rs`): `POST /api/user/stripe/pay` creates a
  Stripe Checkout Session and records a pending topup;
  `POST /api/stripe/webhook` verifies the HMAC-SHA256 signature, completes
  the topup atomically (status 0→1), credits quota, and records a
  `payment_events` row for idempotency; `GET /api/user/topup` lists recent
  topups. D1 migration 0003 adds the `topups` table. 8 unit tests cover
  signature parsing, HMAC verification, and config defaults.
  `type=3` (LogTypeManage) row into the `logs` table via
  `insert_admin_audit_log` (`crates/worker/src/d1_repositories.rs`), with
  the operator identity in `other.admin_info` and the action+params in
  `other.op`. 12 explicit audit points cover: user create/update/delete/
  manage (disable/enable/promote/demote/quota add/subtract/override),
  channel create/update/delete/batch-delete, option update, log clear, and
  token key reveal. Secret values (option values, token keys) are NEVER
  recorded — only key names / token ids. Self-log queries strip `other` so
  target users see the action but not the operator identity. Audit rows are
  queryable via the existing `GET /api/log/?type=3` endpoint.
- LOG_QUEUE producer+consumer landed for relay audit logs. The relay path
  now sends `AuditLogEvent` messages to `LOG_QUEUE` (via
  `env.queue("LOG_QUEUE").send(...)`) instead of doing a synchronous D1
  INSERT inside `wait_until`. A new `#[event(queue)]` handler in
  `crates/worker/src/lib.rs` drains batches of up to 100 messages (or every
  5 seconds) and bulk-INSERTs them into D1 in a single `db.batch()` call.
  On D1 failure the batch is retried (up to 3 times, then dead-letter
  queue). Falls back to synchronous D1 INSERT when the queue binding is not
  configured (local dev / `cargo test`). Admin audit logs remain
  synchronous (low-frequency, not a bottleneck). `wrangler.toml` now
  declares `[[queues.consumers]]` with `max_batch_size=100`,
  `max_batch_timeout=5`, `max_retries=3`, and a DLQ in all three
  environments.
- **Staging deployment + operational verification (2026-07-01).** All D1
  migrations (0001-0007) applied to the live staging database
  (`cinatoken-rust-db-staging`). The current worker deployed to
  `cinatoken-rust-api-staging` via `wrangler deploy --env staging` (host has
  no linker for `worker-build`, so the build was replicated manually:
  `cargo build --target wasm32-unknown-unknown --release`, then
  `wasm-bindgen --target module` — not `bundler`, whose `__wbindgen_start`
  glue expects a bundler to instantiate the wasm and fails workerd startup —
  followed by worker-build's `import source ` → `import ` rewrite). Startup
  succeeded (Worker Startup Time ~5ms, no exceptions). `GET /api/status`
  returns `environment: staging` with `d1`/`session_auth`/`worker` features
  enabled. The task poller cron (`* * * * *`) is live; `wrangler tail`
  captured a real scheduled fire running all three drivers
  (`poll_unfinished_{tasks,suno_tasks,midjourney_tasks}`) against the live D1
  with `outcome: ok` and no exceptions.
- **End-to-end async-task lifecycle smoke against a protocol-faithful
  emulator (2026-07-01).** No real provider credentials are available in this
  environment, so the Sora wire protocol (`POST {base}/v1/videos` →
  `{"id":...}`, `GET {base}/v1/videos/{id}` → `{"status":...}`) was emulated
  by a separate Worker on a real (non-`workers.dev`) custom domain — same-zone
  `*.workers.dev` → `*.workers.dev` calls hit Cloudflare's same-zone
  worker-to-worker block (`error code: 1042`), and Sora's submit/poll wire
  shape is simple enough to emulate faithfully rather than mock. A throwaway
  user/token/channel/ability were seeded in staging D1. Two real
  `POST /v1/video/generations` submits (one designed to succeed, one to fail)
  went through the full stack — auth, channel selection, billing
  pre-charge/reserve, a genuine outbound HTTP call, response parsing, task
  insert — then the live cron poller picked them up, made a genuine outbound
  poll call, and settled both via the CAS: the success task reached `SUCCESS`
  keeping its charge, the failure task reached `FAILURE` with the upstream
  error message and refunded its reserve. Quota deltas were verified exactly
  against both the user and the token rows before and after.
  This smoke surfaced and fixed two real bugs (see the same-day source commit
  for detail): `find_channel_by_id` and the abilities-rebuild query filtered
  a non-existent `channels.deleted_at` column, silently breaking every poll
  channel lookup; and the poll-failure refund only credited the user, not the
  reserving token (Go's `RefundTaskQuota` credits both). Both fixed and
  re-verified live. Test fixtures and the emulator/custom-domain route were
  torn down after verification.
- **End-to-end RELAY smoke — chat/completions, non-stream + streaming, with
  exact billing (2026-07-01).** Closes the long-standing "no live relay
  upstream request" gap on the core product path. An OpenAI-compatible echo
  Worker (fixed usage `prompt=100, completion=50`) was deployed to a real
  custom domain (same 1042 same-zone bypass as the task smoke; the CF token
  lacks Workers-Routes permission so the custom domain was attached via the
  `accounts/workers/domains` API rather than wrangler's route path). A
  throwaway user/token + a type-1 (OpenAI-compatible) channel → the echo +
  an ability + `ModelRatio {"echo-chat-1":1}` were seeded. A real
  `POST /v1/chat/completions` through the live staging worker returned the
  upstream response verbatim (HTTP 200) with usage parsed, and the flat
  billing settled to the exact unit: quota `= (100 + 50×1)×1×1 = 150` charged
  to **both** user and token (user.quota 1000000→999850, token.remain→999850,
  both `used`→150), with a type-2 consume audit-log row (model, token counts,
  quota 150). The streaming variant (`stream:true`) passed the SSE through
  unbuffered (content chunk → final-usage chunk → `[DONE]`) and settled the
  final-chunk usage identically (another exact 150). No relay bugs found —
  the relay path (unlike the task poller) was already solid. Fixtures + echo
  worker + custom domain torn down after verification.
- **End-to-end RELAY smoke against a REAL provider — DeepSeek, three families,
  exact billing on real usage (2026-07-01).** The user supplied a real
  DeepSeek key + endpoints, so the relay was exercised against a genuine
  upstream (`api.deepseek.com`, no emulator, no 1042 — real provider, real
  zone). A throwaway user/token + `ModelRatio {"deepseek-v4-pro":1}` were
  seeded, with a channel per family holding the provider key. All three
  returned HTTP 200 with the real upstream body and settled billing to the
  exact unit on the provider-reported usage (charged to both user and token,
  each with a type-2 consume audit-log row):
  - `POST /v1/chat/completions` (type-1 channel, `base_url=https://api.deepseek.com`):
    real usage prompt 12 / completion 39 (incl. 36 reasoning tokens) →
    quota 51.
  - `POST /v1/chat/completions` `stream:true` with `stream_options.include_usage`:
    real SSE passed through unbuffered, final-chunk usage prompt 7 /
    completion 100 → quota 107.
  - `POST /v1/messages` (Anthropic Messages, type-14 channel,
    `base_url=https://api.deepseek.com/anthropic`): native Anthropic
    thinking+text response, usage input 7 / output 49 → quota 56.
  Cumulative settled 214, matching the sum exactly. No bugs found — the
  OpenAI-compatible and Anthropic relay adapters both work against a live
  third-party provider. All fixtures (including the channel rows holding the
  provider key) were deleted from staging D1 after verification; the key was
  never committed and lives only in the throwaway local scratchpad.

- **User self-registration (`POST /api/user/register`) — implemented +
  staging-verified (2026-07-01).** Ports Go `controller.Register`, the core
  auth flow that was missing (the worker had admin user-create + login but no
  self-signup). Live smoke on staging: a fresh register returned
  `{success:true}` (200); an 8–20 password-length violation returned 400 with
  the Go-matching message; a duplicate username returned 409; and the
  register→login round-trip succeeded, proving the bcrypt hash is loginable.
  The created row was role=common, group=default, 4-char aff_code,
  inviter_id=0, 60-char bcrypt password (`QuotaForNewUser`=0 default). 153
  worker lib tests pass (+3 new for validation/option-parsing). Deferred
  parity (all off by default, noted in-code): Turnstile, email-verified
  registration (email subsystem unported), default-token generation, the
  payment-compliance sub-gate, and informational system logs.

- **Self-service account endpoints + a critical cookie-auth bugfix —
  staging-verified (2026-07-01).** Added four Go `controller/user.go`
  self-routes (`GET /api/user/aff`, `GET /api/user/token`,
  `POST /api/user/aff_transfer`, `DELETE /api/user/self`). Smoking them with a
  real session cookie surfaced a **showstopper latent bug**: `session_cookie()`
  fetched the request header named `COOKIE_NAME` ("session") instead of the
  `Cookie` header, so *every* cookie-authenticated endpoint (get_self,
  require_user_auth, 2FA, secure-verify, admin-via-session, self-service)
  always saw "not logged in" — cookie login persistence was entirely broken and
  had never been integration-tested (only `extract_session_cookie` had unit
  coverage). Fixed (commit `079c045`); `GET /api/user/self` went 401→200 with a
  login cookie. Then all four self-service endpoints verified end-to-end: aff
  code lazily generated + returned; 32-char access token minted; transfer
  min-gate (400 "minimum transfer is 500000") and insufficient-affiliation-quota
  CAS (400) both fire; `DELETE /api/user/self` soft-deletes (subsequent self →
  401 "session user no longer exists", re-login → 401). 154 worker tests pass.
  Fixtures cleaned up.

- **Self-profile update + public-info endpoints — staging-verified
  (2026-07-01).** `PUT /api/user/self` (Go `UpdateSelf` profile branch) and
  `GET /api/notice` / `/api/about` / `/api/home_page_content` (Go misc). Live:
  a display_name update is reflected in `GET /api/user/self`; a password change
  rejects a wrong `original_password` (400) and accepts the correct one (200),
  after which the new password logs in (200) and the old one is rejected (401);
  the info endpoints return their option value (set→"staging notice OK",
  unset→""). 156 worker tests pass. Deferred: the `sidebar_modules`/`language`
  user-setting branches of `UpdateSelf` (display-only, `setting` JSON unmanaged).

- **Usable-groups endpoints (`GET /api/user/self/groups` + `/api/user/groups`)
  — staging-verified (2026-07-01).** Ports Go `GetUserGroups` for the
  default-config path (defaults baked in: GroupRatio {default,vip,svip}=1 merged
  with the option; UserUsableGroups {default,vip} replaced by the option). Live:
  public returns `{default:{ratio:1.0,desc:"默认分组"}, vip:{...}}` with `svip`
  correctly excluded (rated but not usable); `/self/groups` is 401 without a
  session, 200 with. 159 worker tests pass. Deferred: per-user-group ratio
  overrides + `GroupSpecialUsableGroup` `+:`/`-:` rules (Go defaults are
  placeholders; non-default configs only).

- **`GET /api/user/models` (user's available models) — staging-verified
  (2026-07-01).** Ports Go `GetUserModels`: distinct enabled models unioned
  across the caller's usable groups (`SELECT DISTINCT model FROM abilities
  WHERE group_name=? AND enabled=1` per usable group). Live: with abilities
  seeded default(alpha)+vip(beta) enabled and default(disabled) off, returned
  `[gpt-4o, smoke-model-alpha, smoke-model-beta]` — disabled excluded,
  pre-existing gpt-4o included; no-auth → 401. `GET /api/models`
  (DashboardListModels) intentionally not ported (returns per-adaptor static
  model lists baked into Go, not a DB query). 159 worker tests pass.

## Local Notes

The preferred workspace is now `C:\cinagroup\cinatoken-rust`, which avoids the
VirtualBox/shared-drive file-lock issues seen under `Z:`. If the old `Z:`
checkout is used, move Cargo output to a local temp directory before running
checks:

```powershell
$env:CARGO_HTTP_TIMEOUT='120'
$env:CARGO_NET_RETRY='10'
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check
```

## Still Pending

- `worker-build` installation previously exceeded the local command timeout.
  Install it with `bun run install:worker-build`, then run `bun run dev` and
  the Cloudflare preflight scripts.
- `bun run check:cf:dry-run` and `bun run check:cf:startup` currently reach
  Wrangler's custom build step but fail on this machine because `worker-build`
  is not installed.
- `wrangler d1 migrations apply cinatoken-rust-db --local` currently fails on
  this Windows/shared-drive machine with `write EOF` from Wrangler's local D1
  process. The same schema and seed SQL pass SQLite execution.
- `wrangler dev` has not been run end-to-end with a real D1 database binding.
- The relay path now has a live smoke against a REAL provider (DeepSeek):
  `/v1/chat/completions` non-stream + streaming and `/v1/messages` (Anthropic
  Messages), all with exact billing on real usage (see the entry above). The
  async-task (video) path's live smoke still used a protocol-faithful emulator
  (no real video-provider credentials were supplied), so a real video-provider
  task submit is the one untested live path.
- Relay families beyond chat/completions and Anthropic Messages (embeddings,
  rerank, native Gemini, image generation, responses) still have compile/unit
  coverage only — not yet exercised against a live upstream (streaming and
  Anthropic Messages ARE now live-verified via the DeepSeek smoke above).
- No source SQLite file or SQL DSN is available in the current shell, so real
  source row counts have not been captured yet.
