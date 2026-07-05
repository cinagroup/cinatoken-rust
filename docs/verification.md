# Verification

Last checked: 2026-07-05

## Passed

- `bun run check`: passed after adding the cinaVibeSDK-inspired Cloudflare
  platform foundation (default-off WFP dispatch gateway, AdminAuth platform
  capabilities endpoint, and `RealtimeSession` Durable Object hibernation
  skeleton). The run covered frontend type/build, bundle redaction audit,
  bundle budget audit, zero-debt lint baseline, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 305 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:quality`: passed after closing the imported React strict
  lint debt to zero without weakening the lint rules. The final cleanup moved
  model mutation drawer initialization out of synchronous effect state writes,
  initialized ratio settings saved baselines without render-time ref reads,
  derived tiered-pricing number-input display values during render, and derived
  upstream ratio-sync endpoint defaults without effect-driven state mirroring.
- `bun run check:web:lint-debt`: passed with 0 ESLint errors, 0 warnings,
  0 files with findings, and 0 regressions against
  `tools/frontend_lint_debt_baseline.json`.
- `bun run format:check` in `apps/web/source/default`: passed after removing
  one stale `react-hooks/set-state-in-effect` disable comment from the imported
  frontend source.
- `bun run check`: passed after wiring frontend lint-debt regression checking
  into the main verification chain, covering frontend type/build, bundle
  redaction audit, bundle budget audit, lint-debt baseline, route-debt
  baseline, `cargo fmt --all --check`, Rust workspace tests excluding the
  Worker, and Worker wasm check. The route audit reported 214 frontend
  Worker-facing routes, 304 Worker routes, 0 missing calls, categories `{}`,
  and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:bundle-budget`: passed after adding the executable
  frontend bundle-size budget. It scanned 245 built assets in
  `apps/web/source/default/dist`: 18.95 MB raw / 4.49 MB gzip total,
  18.25 MB raw / 4.14 MB gzip JavaScript, 4.29 MB raw / 1.23 MB gzip
  initial JavaScript, and 5.28 MB raw / 1.00 MB gzip for the largest
  JavaScript chunk; all 10 configured budgets passed.
- `bun run check`: passed after wiring the frontend bundle-size budget into
  the main verification chain, covering frontend type/build, bundle redaction
  audit, bundle budget audit, route-debt baseline, `cargo fmt --all --check`,
  Rust workspace tests excluding the Worker, and Worker wasm check. The route
  audit reported 214 frontend Worker-facing routes, 304 Worker routes, 0
  missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:bundle`: passed after adding the frontend bundle
  redaction audit. It scanned 460 built frontend text assets
  (37,284,076 bytes) across `apps/web/source/default/dist` and
  `apps/web/dist`, with 0 findings.
- `bun run check`: passed after wiring the frontend bundle redaction audit
  into the main verification chain, covering frontend type/build, bundle
  redaction audit, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  reported 214 frontend Worker-facing routes, 304 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the legacy engines embeddings alias.
- `cargo test -p cinatoken-worker --lib json_model_fallback`: passed after
  adding the `/v1/engines/:model/embeddings` path-model fallback.
- `cargo test -p cinatoken-worker --lib static_asset_path_routes_api_paths_to_router`:
  passed after routing `/v1/engines/text-embedding-3-small/embeddings` to the
  Worker router.
- `cargo test -p cinatoken-worker --lib`: 378 passed after adding the legacy
  engines embeddings alias.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the legacy engines embeddings alias; the only warnings were the
  pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the legacy engines embeddings alias,
  covering frontend type/build, route-debt baseline, `cargo fmt --all --check`,
  Rust workspace tests excluding the Worker, and Worker wasm check. The route
  audit reported 214 frontend Worker-facing routes, 304 Worker routes, 0
  missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the Jimeng official video route
  aliases.
- `cargo test -p cinatoken-tasks jimeng --lib`: 9 passed after porting the
  Jimeng submit-response parser.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::jimeng_`:
  3 passed after adding official Jimeng body conversion, fetch-body
  validation, and image/action-selection coverage.
- `cargo test -p cinatoken-worker --lib tests::static_asset_path_routes_api_paths_to_router`:
  passed after routing `/jimeng` and `/jimeng/` to the Worker router.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 24
  passed after adding the Jimeng official video route aliases.
- `cargo test -p cinatoken-worker --lib`: 377 passed after adding the Jimeng
  official video route aliases.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Jimeng aliases; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the Jimeng aliases, covering frontend
  type/build, route-debt baseline, `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, and Worker wasm check. The route audit reported
  214 frontend Worker-facing routes, 304 Worker routes, 0 missing calls,
  categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the Kling official video route
  aliases.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::kling_`: 2
  passed after adding official Kling body conversion and action-selection
  coverage.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 21
  passed after adding the Kling official video route aliases.
- `cargo test -p cinatoken-worker --lib`: 374 passed after adding the Kling
  official video route aliases.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Kling aliases; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the Kling aliases, covering frontend
  type/build, route-debt baseline, `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, and Worker wasm check. The route audit reported
  214 frontend Worker-facing routes, 302 Worker routes, 0 missing calls,
  categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the OpenAI video Sora remix submit
  slice.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::remix_`: 2
  passed after adding origin-model precedence and origin-data remix billing
  ratio coverage.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 19
  passed after adding the OpenAI video Sora remix submit slice.
- `cargo test -p cinatoken-worker --lib`: 372 passed after adding the OpenAI
  video Sora remix submit slice.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the remix submit slice; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the remix submit slice, covering
  frontend type/build, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  remained 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding session-auth parity to the OpenAI
  video content proxy.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 17
  passed after adding TokenOrUserAuth-style session fallback coverage for the
  OpenAI video content proxy.
- `cargo test -p cinatoken-worker --lib`: 370 passed after adding session-auth
  parity to the OpenAI video content proxy.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding session-auth parity to the content proxy; the only warnings were
  the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding session-auth parity to the content
  proxy, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit remained 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the first OpenAI video content proxy
  slice.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 16
  passed after adding content-source fallback, self-proxy skip, Vertex data URL
  extraction, and bounded data URL decode coverage.
- `cargo test -p cinatoken-worker --lib`: 369 passed after adding the first
  OpenAI video content proxy slice.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the content proxy slice; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the content proxy slice, covering
  frontend type/build, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  remained 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding provider-specific OpenAI video
  serializer overlays.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 10
  passed after adding Ali status/error mapping, Kling provider time/seconds/error
  mapping, and Gemini/Vertex Veo operation-name model extraction.
- `cargo test -p cinatoken-worker --lib`: 363 passed after adding
  provider-specific OpenAI video serializer overlays.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding provider-specific OpenAI video serializer overlays; the only
  warnings were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding provider-specific OpenAI video
  serializer overlays, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit remained 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check`: passed after task-data persistence and OpenAI video
  enrichment, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after task-data persistence and OpenAI video
  enrichment.
- `cargo test -p cinatoken-worker --lib`: 360 passed after persisting raw
  provider task data through submit/poll and enriching OpenAI video fetch from
  stored task data. New/updated tests cover Sora/OpenAI passthrough metadata,
  provider URL fallback, nested first-video URL extraction, and non-Sora
  `created_at` protection.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after task-data persistence and OpenAI video enrichment; the only warnings
  were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after the OpenAI-compatible video create/fetch shell,
  covering frontend type/build, route-debt baseline, rustfmt check, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  reported 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the OpenAI-compatible video
  create/fetch shell.
- `cargo test -p cinatoken-worker --lib`: 356 passed after adding
  `POST /v1/videos`, `GET /v1/videos/:task_id`, and explicit
  `/v1/videos/:video_id/remix` 501 ownership. The new tests cover the OpenAI
  video submit shell, status/progress/model/result URL mapping, and failure
  error shape.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the OpenAI-compatible video create/fetch shell; the only
  warnings were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  214 frontend Worker-facing routes, detection kinds
  `call=243` / `jsx-attribute=1` / `navigation=1` / `stream=1`,
  295 Worker routes, 0 missing calls, categories `{}`, SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check`: passed after the broadened frontend route-audit slice,
  covering frontend build, route-debt baseline, rustfmt check, Rust workspace
  tests excluding the Worker, and Worker wasm check.
- `cargo test -p cinatoken-worker --lib`: 353 passed after adding the
  fail-closed video-content route boundary.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the fail-closed `/v1/videos/:task_id/content` Worker route;
  the only warnings were the pre-existing `dead_code` warnings in
  `d1_repositories.rs`.
- `cargo fmt --all --check`: passed after broadening the frontend route audit
  and adding the video-content route boundary.
- `cargo test -p cinatoken-worker --lib`: 350 passed after CSPRNG hardening for
  relay weighted channel selection; generated user access tokens, affiliation
  codes, and subscription balance-pay order suffixes remain covered.
- `cargo test -p cinatoken-worker --lib relay::tests::`: 102 passed for the
  relay planner, bounded random draw, and RNG error-propagation tests.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same relay CSPRNG hardening slice.
- `cargo fmt --all --check`: passed for the same relay CSPRNG hardening slice.
- `rg -n "Math::random|js_sys::Math" crates/worker/src`: no matches.
- Fetched the current Cloudflare Worker references and latest
  `@cloudflare/workers-types` with `npm pack`; observed version
  `5.20260704.1`.
- `bun run check`: passed after the relay CSPRNG hardening slice, covering the
  frontend build, route-debt baseline, Rust workspace tests excluding the
  Worker, rustfmt check, and Worker wasm check.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  212 frontend calls, 294 Worker routes, 0 missing calls, categories `{}`,
  SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Older entries below are historical evidence; their route-debt counts may be
superseded by the current 0 missing-call / 0 unclassified / 0 deferred-debt
baseline above.

- `cargo test -p cinatoken-worker --lib`: 303 passed after adding Creem wallet
  checkout and webhook settlement at `POST /api/user/creem/pay` and
  `POST /api/creem/webhook`, including Go-compatible `ref_` SHA1 order IDs,
  HMAC-SHA256 raw-body webhook signature checks, product-list parsing, amount
  replay checks, provider-aware credited-anchor settlement, and optional
  empty-email backfill from the verified Creem customer payload.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same Creem wallet/webhook slice.
- `bun run check`: passed after the Creem wallet/webhook slice, covering the
  frontend build, route-debt baseline, Rust workspace tests excluding the Worker,
  rustfmt check, and Worker wasm check.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 244 Worker routes, 36 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 1 payment-deferred,
  SHA-256 `5cdffd5d02a44c03b55467410820893a988a9303d18be2cb1f03b55acb1409fd`.

- `cargo test -p cinatoken-worker --lib`: 298 passed after adding Waffo
  Pancake wallet checkout and webhook settlement at
  `POST /api/user/waffo-pancake/pay` and
  `POST /api/waffo-pancake/webhook/:env`, including authenticated checkout
  session-token/session action helpers, Go-compatible buyer identity and order
  IDs, token-display quota normalization into the Rust D1 final-quota
  invariant, RSA-SHA256 webhook signature parsing, env/identity/amount replay
  checks, provider-aware credited-anchor settlement, and route-gated frontend
  subscription protection.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same Waffo Pancake wallet/webhook slice.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 242 Worker routes, 37 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 2 payment-deferred,
  SHA-256 `15339560f12bfb286e08b72afe867ce802b72f7bd3fcd0d21ae741c089ba0af7`.

- `cargo test -p cinatoken-worker --lib`: 292 passed after adding the
  Epay-compatible wallet topup path at `POST /api/user/pay` plus
  `GET/POST /api/user/epay/notify`, including MD5 SDK-signature parity,
  signed purchase-form parameters, CSPRNG order ids, constant-time Epay
  signature comparison, Stripe order suffix CSPRNG hardening, provider-aware D1
  topup writes, bounded notify parsing with required POST `Content-Length`,
  replay-vs-mismatch callback handling, and atomic credited-anchor callback
  settlement that verifies complete/credit/mark batch changes.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 240 Worker routes, 38 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 3 payment-deferred,
  SHA-256 `8968b7ebbb9422657492c9a67dc1177b414ccdebf80873bdfdb55f6503175b9c`.
- `cargo test -p cinatoken-worker --lib`: 286 passed after adding root-only
  Waffo Pancake signed action helpers at
  `POST /api/option/waffo-pancake/pair` and
  `POST /api/option/waffo-pancake/subscription-product`, including
  deterministic SDK-style idempotency keys, short-ID/amount validation,
  SuccessURL serialization, orphan-store response handling, and Go-compatible
  Waffo admin frontend envelopes.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 237 Worker routes, 39 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 4 payment-deferred,
  SHA-256 `a3ffcf011d892afb7b2a2388b3321b66c64456564271cddccb22e29735b4021c`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`
  passes with the reviewed 38-call route-debt baseline.
- `cargo test -p cinatoken-worker --lib`: 283 passed after adding root-only
  Waffo Pancake catalog reads at `POST /api/option/waffo-pancake/catalog` and
  `POST /api/option/waffo-pancake/subscription-product-options`, including
  signed GraphQL request helpers, timeout/response-size guards, active-product
  filtering, optional-body/content-length parsing, and private-key
  normalization coverage.
- `cargo test -p cinatoken-worker --lib`: 276 passed after adding root-only
  Waffo Pancake config save at `POST /api/option/waffo-pancake/save`, including
  tests for required merchant/store/product fields and the Go-compatible
  "blank private key keeps current key" behavior.
- `cargo test -p cinatoken-worker --lib`: 273 passed after adding Waffo
  Pancake amount estimation at `POST /api/user/waffo-pancake/amount`, keeping
  checkout/callback hidden while covering Go-compatible token-display,
  unit-price, group-ratio, and discount formula parity.
- `cargo test -p cinatoken-worker --lib`: 268 passed after adding wallet/topup
  compatibility: Stripe amount estimation, frontend-compatible Stripe pay link,
  `topup/info`, self/admin topup history pagination, admin manual topup
  completion, and `/api/user/self` affiliation wallet fields.
- `cargo test -p cinatoken-migration`: 23 passed after adding the
  `redemptions.credited` import/default boundary, including automatic
  `status=used -> credited=1` mapping for imported Go redemption rows.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes
  after the Waffo Pancake action-helper batch.
- In-memory SQLite replay of `migrations/d1/0001_core.sql` plus
  `migrations/d1/0013_subscriptions.sql`, confirming
  `subscription_plans`, upgraded `subscription_orders`,
  `subscription_pre_consume_records`, and `user_subscriptions` exist.
- `migrations/d1/0014_redemptions_credited.sql` adds a D1-only redemption
  `credited` anchor and marks already-used imported Go rows as credited.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the Waffo Pancake action-helper batch.
- `cargo test -p cinatoken-worker --lib`: 262 passed after adding public
  rankings, `HeaderNavModules.rankings` access enforcement, live `logs`
  aggregation, status capability exposure, and rankings unit coverage.
- `cargo test -p cinatoken-migration`: 21 passed after adding `checkins` and
  `redemptions` to the D1 import table set.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes
  after the public rankings batch.
- `bun tools/audit_frontend_routes.mjs --summary --details`: 212 frontend
  calls, 213 Worker routes, 63 missing calls, categories 13 auth-deferred / 34
  capability-hidden-product / 16 payment-deferred, SHA-256
  `63b9b8f87ecdf6caa7cb15269c86be22c2cbeed1c27d3f6659258a37f146f6b1`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`
  passes with the reviewed 63-call route-debt baseline.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the public rankings batch.
- D1 log analytics queries now match the Go/D1 schema: `logs` has no
  `deleted_at` column, so repository log filters and quota/ranking trend
  queries do not add soft-delete predicates to `logs`.
- `cargo test -p cinatoken-worker --lib`: 255 passed after adding admin
  redemption-code management routes, D1-backed redemptions, payment-compliance
  create guard, status-only updates, sidebar exposure, and redemption request
  validation coverage.
- In-memory SQLite replay of `migrations/d1/0001_core.sql` plus
  `migrations/d1/0011_checkins.sql` plus
  `migrations/d1/0012_redemptions.sql`, confirming the `checkins` and
  `redemptions` tables plus their key live-row indexes.
- `cargo fmt --all`
- `cargo test --workspace --exclude cinatoken-worker`
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
- `cargo fmt --all --check` after the async usage-log read batch.
- `cargo test -p cinatoken-worker --lib`: 248 passed after adding
  `/api/mj`, `/api/mj/self`, `/api/task`, and `/api/task/self` read-only
  usage-log lists plus the Midjourney millisecond `submit_time`/`finish_time`
  binding fixes.
- `cargo test -p cinatoken-migration`: 20 passed after adding
  `custom_oauth_providers` and `user_oauth_bindings` to the D1 import table set.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` after the
  async usage-log read batch.
- In-memory SQLite replay of migrations 0001-0010, confirming
  `custom_oauth_providers` and `user_oauth_bindings` exist.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified`:
  212 frontend calls, 200 Worker routes, 71 missing calls, categories
  13 auth-deferred / 42 capability-hidden-product / 16 payment-deferred,
  SHA-256 `ec37c0cf67e953733ee7e43c291150f17f0d1f859073cc352e7d66b80865e677`.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the async usage-log read batch.
- `cargo test -p cinatoken-worker --lib`: 174 passed after the frontend status
  envelope and setup-status compatibility fixes.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes after
  the same compatibility fixes.
- `bun install --frozen-lockfile` in `apps/web/source`: 2841 packages installed
  from the tracked workspace lockfile.
- `bun run build:web`: TypeScript and Rsbuild production build pass; the real
  bundle is copied to `apps/web/dist/`.
- `bun run check:web`: frontend type/build contract passes.
- `bunx eslint src/features/models/index.tsx` passes for the Rust capability
  gating added to the imported frontend.
- `bun run format:check` in `apps/web/source/default` passes.
- `/api/status` compatibility tests prove the Go-style envelope data retains
  Rust runtime diagnostics and clamps unsupported sidebar modules.
- `/api/setup` compatibility test proves `data.status=true` means setup is
  complete, matching Go and the React router.
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
  `5.20260703.1`.
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

- **UpdateSelf setting branches (sidebar_modules / language) — staging-verified
  (2026-07-01).** Completes `PUT /api/user/self` to Go parity: preference fields
  merge into the user `setting` JSON (preserving others), separate from the
  profile branch. Live: sidebar_modules then language merged incrementally
  (`{sidebar_modules,language}`); a later display_name update changed the
  profile while the setting JSON survived. 160 worker tests pass. The full
  `PUT /api/user/setting` (UpdateUserSetting — notification prefs with
  webhook/bark/gotify validation) is a separate follow-up.

- **`PUT /api/user/setting` (notification prefs) — staging-verified
  (2026-07-01).** Ports Go `UpdateUserSetting`: notify-type + threshold +
  type-specific URL/email/token validation, persisted as a fresh notification
  `setting` JSON (Gotify priority clamped 0-10). Live: valid webhook→200; bad
  type→400; webhook w/o url→400; gotify priority 99 stored as 5. 162 tests
  pass. The notification *dispatch* subsystem is unported (config-only).

- **`GET /api/ratio_config` (exposed ratio tables) — staging-verified
  (2026-07-01).** Ports Go `GetRatioConfig`/`GetExposedData`: 5 merged ratio
  maps (default `cinatoken_core::default_ratios` tables + options override),
  gated by `ExposeRatioEnabled` (off→403). Live: off→403; on→200 with
  gpt-4o=0.5 default + a my-custom-model override merged. 163 tests pass.

- **Legal/midjourney public info + admin enabled-models — staging-verified
  (2026-07-01).** `GET /api/user-agreement`, `/api/privacy-policy`,
  `/api/midjourney` (option-backed strings, verified returning set values); and
  `GET /api/channel/models_enabled` (Go `EnabledListModels`, admin-only) —
  verified returning `[gpt-4o, smoke-enabled-model]` for an admin and 403 for a
  common user.

- **Admin ratio-reset + channel tag ops — staging-verified (2026-07-01/02).**
  `POST /api/option/rest_model_ratio` (root: rewrites ModelRatio from the
  default table — verified 6657-byte value with gpt-4o; common→403);
  `POST /api/channel/tag/{disabled,enabled}` (toggles channels + their
  abilities 2/2) and `DELETE /api/channel/disabled` (deleted exactly the 2
  disabled channels + abilities, data=2, leaving the enabled mocks intact;
  empty tag→400). `POST /api/option/payment_compliance` (admin: persists the 5
  `payment_setting.compliance_*` options incl. confirming user id + client IP;
  confirmed:false→400; common→403).
- **`GET /api/pricing` + 0008 models/vendors schema — staging-verified
  (2026-07-02).** Ports Go `GetPricing`/`updatePricing`; migration 0008 applied
  to staging D1. Anonymous smoke: priced model → quota_type 1/price 0.25; ratio
  model → ratio 3.5 with full metadata enrichment (desc/icon/tags/vendor_id via
  exact name-rule) and vip group; pre-existing gpt-4o → default-table ratio
  1.25, hardcoded completion 4.0, cache 0.5; a restricted-group model was
  filtered out; vendors/auto_groups/group_ratio (usable-only)/
  supported_endpoint/pricing_version all correct. 168 worker tests pass (+4:
  endpoint mapping, name-rule priority, price-vs-ratio + disabled-meta,
  usable-group filter).
- **Models/vendors admin CRUD (`/api/models/*`, `/api/vendors/*`) —
  staging-verified (2026-07-02).** Full lifecycle over the 0008 tables:
  missing=[gpt-4o] → vendor+meta created → duplicate name 409 → missing=[] →
  `/api/pricing` live-enriched (tags/desc/vendor on gpt-4o) →
  `?status_only=true` status=0 hid gpt-4o from pricing → soft deletes → gets
  404 and gpt-4o returned to pricing → search keyword total=1; no-auth 401.
- **Cloudflare Workers AI + AI Gateway integration — staging-verified with
  REAL inference (2026-07-02).** Type-39 (Cloudflare) channels join the
  OpenAI-compatible set with Go-parity REST/gateway URL routing
  (host-tested), plus a NEW native path: key=`internal` channels execute over
  the Workers AI `AI` binding in-platform (no egress, no API token). Live:
  `@cf/meta/llama-4-scout-17b-16e-instruct` through the full relay → "pong",
  real usage 86/2, billing settled exactly (88 = 86 + 2×1.0) with audit; a
  second call billed cumulatively (181); a deprecated model's `AiError`
  surfaced through the normal relay error path; stream on a binding channel →
  clean 400; `/api/status` shows `workers_ai=true` / `ai_gateway=false`.
  This is the first REAL-provider relay verification needing zero external
  credentials. AI Gateway routing (`AI_GATEWAY_ID` + 3-arg binding `run` via
  reflection) is code-complete but config-gated — verifying it needs a
  gateway created in the dashboard (the staging token lacks AI Gateway
  permissions).
- **Channel connectivity ops — staging-verified (2026-07-02).**
  `GET /api/channel/test/:id` (1-token chat probe with the channel's own key:
  success time=0.033s, `response_time`/`test_time` persisted; unreachable
  base_url → `success:false` "upstream status 530"; no-auth 401),
  `GET /api/channel/fetch_models/:id` → the echo upstream's two model ids, and
  `POST /api/channel/fetch_models` (pre-create probe: multi-line key trimmed
  to first line → ids; missing base_url → 400). Echo + fixtures torn down.
- **`PUT /api/channel/tag` (bulk edit by tag) — staging-verified (2026-07-02).**
  Ports Go `EditTagChannels`/`EditChannelByTag`. All three paths live-verified:
  priority/weight-only edit propagated to both channels and their abilities
  (2/2 each, no rebuild); invalid `param_override` → 400 ("must be valid
  JSON"); models change + retag rewrote both channels (new tag + models) and
  rebuilt abilities exactly (4 new rows = 2 channels × 2 models, 0 stale).
  164 worker tests pass.

- **Route-review batches 1+2 — staging-verified (2026-07-02).** A full diff of
  every Go route against the Rust router. Closed + live-smoked: task fetch
  (`GET /v1/video/generations/:task_id` → full TaskDto incl. `result_url`
  from private_data and parsed `data`; `GET/POST /suno/fetch` by-id + batch;
  unknown → `task_not_exist` 400; no-auth 401); mj client fetch
  (`/mj/task/:id/fetch` + `list-by-condition` → exact MidjourneyDto with
  parsed buttons/properties; unknown → `{code:4}`); billing views
  (subscription hard_limit 2.0 and usage 50.0 exactly matching a seeded
  750k/250k token); passthroughs routed (moderations/edits/responses-compact
  → 401 auth gate, not 404); `GET /v1/files` → Go-shaped 501. Also FOUND+FIXED
  the poll path never persisting the task result URL, and caught (via the
  canonical route inventory) that Go relays `/v1/engines/:model/embeddings`
  in GEMINI format — the initial OpenAI-shaped port was reverted to a
  structured 501 rather than ship a wrong-format relay. 174 worker tests pass.

- **Frontend contract audit + two P0 compatibility batches — locally verified
  (2026-07-03).** Added `tools/audit_frontend_routes.mjs` (TypeScript AST
  frontend-call inventory) and `tools/verify_frontend_contract.mjs`
  (non-mutating deployed contract smoke). TypeChecker-based resolution now
  covers 212 distinct default-frontend calls and reduced unmatched calls from
  122 to 72 after
  adding complete 2FA frontend payload/lifecycle parity, batch token-key
  reveal, channel batch-tag/tag-model routes, admin group lookup, and the
  frontend admin-2FA-reset path, followed by prefill-group CRUD, official model
  metadata preview/sync, provider balance refresh, and multi-key channel
  management, then single-channel upstream model detect/apply, Codex
  usage/credential refresh, Rust-native channel-affinity cache stats/clear,
  channel-affinity usage diagnostics, bounded upstream batch
  detect/apply slices, and Ollama version/delete/pull-stream/model-list
  management through HTTPS/443 base URLs, followed by Worker-native operations
  endpoints for Uptime Kuma, model performance metrics, explicit no-op
  `/api/performance/*` local-maintenance compatibility, upstream ratio
  sync for `/api/ratio_sync/channels` plus `/api/ratio_sync/fetch`, and
  root-admin custom OAuth provider CRUD/discovery with D1 schema/import and
  `/api/status` enabled-provider exposure, custom OAuth binding list/unbind
  for self/admin users plus admin built-in binding clear, async
  Midjourney/task usage-log read lists at `/api/mj`, `/api/mj/self`,
  `/api/task`, and `/api/task/self`, D1-backed daily check-in at
  `/api/user/checkin`, admin redemption-code management at `/api/redemption`,
  and public rankings at `/api/rankings`.
  The reviewed route-debt baseline is enforced by `bun run check:web:routes`:
  63 missing calls, no unclassified entries, and no remaining visible-admin or
  operations-debt gaps. `cargo test -p cinatoken-worker --lib` passes 262
  tests; migrations 0001-0012 replay including custom OAuth provider,
  binding, check-in, and redemption tables. The wasm32 and default frontend
  TypeScript/Rsbuild checks pass.
- **Channel settings persistence contract — locally verified (2026-07-03).**
  Channel create/update now carries the frontend `settings` JSON through the
  request and D1 repository instead of silently replacing it with an empty
  string or ignoring updates.
- **Single-channel upstream model updates — locally verified (2026-07-03).**
  `POST /api/channel/upstream_updates/detect` and `POST
  /api/channel/upstream_updates/apply` now persist pending add/remove models
  into `settings`, apply selected changes to `models`, rebuild abilities when
  models change, invalidate relay channel cache, and audit apply without
  storing upstream keys. Outbound model-list fetches are HTTPS-only, redirect
  disabled, timeout-bounded, response-size-bounded, and share the same helper
  with `/api/channel/fetch_models/:id`; Ollama direct local-daemon access and
  batch detect/apply remain deferred to protected management/asynchronous
  designs.
- **Codex channel usage and credential refresh — locally verified
  (2026-07-03).** `GET /api/channel/:id/codex/usage` and `POST
  /api/channel/:id/codex/refresh` now match the default frontend contract.
  Stored OAuth credentials are validated as JSON objects; 401/403 usage
  responses trigger at most one refresh/retry; refreshed keys use D1
  compare-and-swap so a concurrent admin edit is not overwritten. The flow
  attempts best-effort channel cache invalidation and writes an audit record
  without tokens.
  Outbound requests are HTTPS/443 only, redirect-disabled, timeout-bounded,
  and body-size-bounded. Go VPS `setting.proxy` semantics are rejected
  explicitly because Workers cannot attach a process-local proxy. Unit tests
  cover parsing, JWT account/email extraction, SSRF targets, proxy rejection,
  and identity preservation.
- **Bounded upstream model batch updates - locally verified (2026-07-03).**
  `POST /api/channel/upstream_updates/detect_all` and
  `POST /api/channel/upstream_updates/apply_all` now expose after-id bounded
  slices over enabled channels. The default frontend loops with a page limit of
  5 and aggregates the Go-compatible counts, while each Worker request keeps a
  fixed amount of D1 and outbound model-list work. A future Queue/Workflow can
  reuse the same cursor contract for background orchestration.
- **Ollama admin model management - locally verified (2026-07-03).**
  `GET /api/channel/ollama/version/:id`, `DELETE /api/channel/ollama/delete`,
  and `POST /api/channel/ollama/pull/stream` are implemented for Ollama
  channels with HTTPS/443 base URLs. Pull progress is streamed from Ollama
  NDJSON into the existing frontend SSE UI without buffering the full operation;
  `POST /api/channel/fetch_models` and `GET /api/channel/fetch_models/:id`
  also use Ollama `/api/tags` when channel type is 4.
- **Channel affinity cache stats/clear - locally verified (2026-07-03).**
  `GET /api/option/channel_affinity_cache` and
  `DELETE /api/option/channel_affinity_cache` now cover the Rust Worker
  affinity subset that is actually written by relay success paths. The per-key
  Durable Object remains the source of truth; `CACHE_KV` stores bounded
  admin-list metadata for stats and clear. The routes are AdminAuth-protected,
  clear operations are audited, scans are capped at 1000 indexed entries per
  request, and the response explicitly labels the scope as the Rust minimal
  user/model/group rule rather than synthesizing Go's rule-template or
  usage-stat caches.
- **Channel affinity usage diagnostics - locally verified (2026-07-03).**
  `GET /api/log/channel_affinity_usage_cache` now serves the default
  usage-log dialog for the Rust fixed-rule subset. Relay success audits attach
  `other.admin_info.channel_affinity` metadata with a frontend-visible key
  fingerprint, and successful upstream usage responses update TTL-bounded
  `CACHE_KV` hit/total/token counters without exposing the raw affinity key.
- **Staging static/public HTTP contract — verified (2026-07-02/03).**
  `bun run check:web:staging` passes all seven groups against
  `cinatoken-rust-api-staging.cinagroup.workers.dev`: capability-clamped
  status, setup shape, 11 SPA hard-refresh routes, eight static assets, exact
  deployed/local index identity, ten public envelopes, and API-before-SPA
  precedence. This does not verify authenticated DOM workflows. The new
  2026-07-03 backend compatibility routes still require redeployment.

## Local Notes

- **Admin Passkey reset - locally verified route surface (2026-07-04).**
  `DELETE /api/user/:id/reset_passkey` is now Worker-owned with AdminAuth,
  manage-target role checks, `user.reset_passkey` admin audit, and a D1
  `passkey_credentials` table for Go-compatible credential storage. The route
  audit now reports 212 frontend calls, 275 Worker routes, and 12 remaining
  auth-deferred gaps with SHA-256
  `d51581aed82f7f8a3024885b5fd075834c8dc96b983b74aec6e0144b579905fe`.

- **Email verification/reset/bind - locally verified route surface
  (2026-07-04).** `GET /api/verification`, `GET /api/reset_password`,
  `POST /api/user/reset`, and `POST /api/oauth/email/bind` are now
  Worker-owned. The implementation uses `flow_state` KV TTLs instead of Go's
  process-local map and Cloudflare `send_email` binding `EMAIL` instead of
  SMTP sockets. Local route audit reports 212 frontend calls, 279 Worker routes,
  and 8 remaining auth-deferred gaps with SHA-256
  `65f9ed7547e329d29cd3b7bfb6e9b1cccdf23290c112a87bf2cd5b5db5ca0f99`.

- **WeChat login/bind - locally verified route surface (2026-07-04).**
  `GET /api/oauth/wechat`, `GET /api/oauth/wechat/bind`, and the Go-compatible
  `POST /api/oauth/wechat/bind` are now Worker-owned. The Worker reads
  `WeChatAuthEnabled`, `WeChatServerAddress`, `WeChatServerToken`, and
  `WeChatAccountQRCodeImageURL` from D1 options, verifies codes through an
  operator-managed public HTTPS WeChat Server, and issues the same session
  response shape as password/OAuth login. Local route audit reports 212
  frontend calls, 282 Worker routes, and 6 remaining auth-deferred gaps with
  SHA-256 `8bcefa9b62aaa9473541032cc28e21d6e31e9711db66b6f5706b3976c736b457`.

- **Multipart upload binary parser and WAV estimate - locally verified
  (2026-07-05).** `cinatoken_relay::multipart` now scans bodies as bytes rather
  than requiring the entire upload to be valid UTF-8, so binary audio/image
  parts do not prevent `model` extraction. Worker multipart audio preflight
  derives Go-compatible prompt-token estimates from WAV duration for
  `/v1/audio/transcriptions` and `/v1/audio/translations`, while preserving
  byte-for-byte upstream multipart forwarding for audio uploads and
  `/v1/images/edits`. Local evidence so far:
  `cargo test -p cinatoken-relay multipart` (12 passed) and
  `cargo test -p cinatoken-worker --lib multipart_audio_wav_duration_feeds_prompt_estimate`
  (passed).

- **Common audio duration preflight parsers - locally verified (2026-07-05).**
  `cinatoken_core::audio_duration::audio_duration_seconds` now parses WAV, MP3,
  FLAC, M4A/MP4, OGG/Vorbis, Opus, AIFF/AIFC, AAC ADTS, and WebM EBML
  `Duration` metadata without external tools, and Worker multipart audio
  preflight uses the uploaded file name plus part `Content-Type` to feed STT
  prompt-token estimates. Local evidence:
  `cargo test -p cinatoken-core audio_duration` (14 passed) and
  `cargo test -p cinatoken-worker --lib multipart_audio_flac_duration_feeds_prompt_estimate`
  (passed), plus
  `cargo test -p cinatoken-worker --lib multipart_audio_webm_duration_feeds_prompt_estimate`
  (passed).

- **OpenAI video create/fetch shell - locally verified (2026-07-05).**
  `POST /v1/videos` now returns an OpenAI video `queued` shell after the
  existing Worker task submit path succeeds, and `GET /v1/videos/:task_id`
  returns an owner-scoped DB-backed OpenAI video status object. Remix
  (`POST /v1/videos/:video_id/remix`) and content streaming
  (`GET /v1/videos/:task_id/content`) remain structured 501 boundaries until
  origin-task/channel-lock resolution and Queue/R2 artifact proxying are
  ported. Local evidence: `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib` (356 passed), and
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed).

- **Cloudflare WFP dispatch and RealtimeSession DO foundation - locally
  verified (2026-07-05).** The Worker now has an AdminAuth
  `/api/platform/capabilities` probe, a default-off WFP dispatch pre-router
  using the `DISPATCHER` dynamic dispatcher binding, default-off preview-host
  and internal dispatch selectors, a `REALTIME_SESSIONS` Durable Object binding
  and migration, and a `RealtimeSession` DO that accepts hibernatable
  WebSockets with serialized socket attachments. `/v1/realtime` remains
  protocol-unwired and G7-gated. Local evidence:
  `cargo test -p cinatoken-worker --lib platform_gateway` (3 passed),
  `cargo test -p cinatoken-worker --lib realtime_session` (2 passed),
  `cargo test -p cinatoken-worker --lib` (383 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  `git diff --check` (passed), and `bun run check` (passed; route audit
  214 frontend calls / 305 Worker routes / 0 missing calls).

- **WFP tenant script control plane - locally verified (2026-07-05).** The
  Worker now exposes root-only
  `POST /api/platform/wfp/tenant-script/plan` and
  `POST /api/platform/wfp/tenant-script/deploy` endpoints. The generated tenant
  Worker forwards supported AI routes, including `/v1/messages`, to
  Cloudflare AI Gateway REST with a Worker-owned bearer token, optional
  `cf-aig-gateway-id`, Worker-owned `cf-aig-metadata`, and streamed request
  bodies; it does not forward the client's `Authorization` header. The fallback
  status reports `runtime: "js-fallback"` so smoke tests can distinguish it
  from the Rust/Wasm artifact path. The deploy call uploads multipart
  `metadata` plus `tenant.mjs` to the Workers for
  Platforms dispatch namespace API and caps Cloudflare API response reads at
  32 KiB. Local evidence:
  `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed),
  `cargo test -p cinatoken-worker --lib` (388 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  `git diff --check` (passed), and `bun run check` (passed; route audit
  214 frontend calls / 307 Worker routes / 0 missing calls).

- **WFP Rust/Wasm tenant runtime - locally verified (2026-07-05).** Added the
  standalone `cinatoken-wfp-tenant` Worker crate under `crates/wfp-tenant`.
  It exposes `GET /__cinatoken/tenant/status` with `runtime: "rust-wasm"` and
  forwards `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
  `/v1/embeddings`, and `/ai/run` to Cloudflare AI Gateway REST using
  tenant-owned `CF_ACCOUNT_ID`/`CF_API_TOKEN`/`AI_GATEWAY_ID` bindings. It
  leaves legacy `/v1/completions` on the main relay because Cloudflare's
  current REST API docs do not list `/ai/v1/completions`. It attaches flat
  `cf-aig-metadata` (`tenant_id`, `runtime`,
  `source`, `route`, `api`) for AI Gateway analytics without forwarding client
  authorization. The inbound request body is passed through as a
  `ReadableStream` via `RequestInit`; the Rust runtime does not call `bytes()`
  or `json()` on the AI request body. Local evidence:
  `bun run check:wfp-tenant` (passed; 5 tenant tests, 6 generated fallback
  tests, and wasm32 check), `cargo test -p cinatoken-wfp-tenant` (5 passed),
  `cargo check -p cinatoken-wfp-tenant --target wasm32-unknown-unknown`
  (passed), `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed),
  and `bun run check` (passed; frontend route audit 214 calls / 307 Worker
  routes / 0 missing calls; existing worker dead-code warnings only).

- **WFP tenant response-header hygiene - locally verified (2026-07-05).** The
  Rust/Wasm tenant runtime and generated JS fallback now rebuild AI Gateway
  responses with a safe public header allowlist while preserving streamed
  response bodies. Public interoperability headers such as `content-type`,
  cache validators, `retry-after`, and common provider request IDs may pass
  through; upstream `authorization`, `set-cookie`, `content-length`,
  transfer/platform headers, `cf-aig-*` observability headers, and upstream
  `x-cinatoken-*` headers are not exposed to tenant clients. Local evidence:
  `cargo test -p cinatoken-wfp-tenant` (5 passed) and
  `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed), plus
  `bun run check` (passed; frontend gates, WFP deploy-plan/generated fallback
  gates, workspace tests, and Worker/WFP wasm32 checks). Live WFP smoke still
  needs redacted response-header evidence for both the generated fallback and
  the Rust/Wasm artifact.

- **WFP internal dispatch path rewrite - locally verified (2026-07-05).** The
  main Worker now rewrites internal dispatch URLs before calling the
  `DISPATCHER` binding: `/api/platform/dispatch/:worker/<tenant-path>` is
  forwarded to the tenant Worker as `/<tenant-path>` while preserving method,
  query string, headers, and the original request body stream. Preview-host
  dispatch still forwards the original path. This makes the documented
  `/api/platform/dispatch/:worker/__cinatoken/tenant/status` smoke actually
  reach the tenant status route. Local evidence:
  `cargo test -p cinatoken-worker --lib platform_gateway` (4 passed),
  `cargo test -p cinatoken-worker --lib` (394 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed;
  existing worker dead-code warnings only), and `bun run check` (passed;
  frontend gates, WFP deploy-plan/generated fallback gates, workspace tests,
  and Worker/WFP wasm32 checks). Live staging still needs the real `DISPATCHER`
  binding plus uploaded tenant scripts.

- **WFP Rust/Wasm artifact deploy uploader - locally verified (2026-07-05).**
  Added `tools/deploy_wfp_tenant_artifact.mjs` and `bun run deploy:wfp-tenant`
  for local upload of `crates/wfp-tenant/build/worker` to the Cloudflare WFP
  dispatch namespace multipart API. Local evidence:
  `bun tools/deploy_wfp_tenant_artifact.mjs --help` (passed),
  `bun run check:wfp-tenant:deploy-plan` (passed), and a dry-run against an
  ignored synthetic artifact directory with `shim.mjs` plus `index_bg.wasm`
  (2 modules discovered; JavaScript module and Wasm content types assigned;
  `CF_API_TOKEN` redacted). `bun run check` also passed with the new
  deploy-plan gate included. Attempted `worker-build` installation on the
  current Windows workstation is blocked by local native toolchain setup:
  GNU lacks `dlltool.exe`, while MSVC resolves `link.exe` to
  `C:\Users\cina\.hermes\git\usr\bin\link.exe` instead of Visual Studio Build
  Tools. Live dispatch upload still requires a working `worker-build`
  environment plus staging Cloudflare credentials and namespace.

- **OpenAI Realtime DO auth boundary - locally verified (2026-07-05).**
  `/v1/realtime` is now an early-dispatch, default-off WebSocket route gated
  by `REALTIME_SESSION_V1_ENABLED`. When enabled, it requires GET,
  `Upgrade: websocket`, `Sec-WebSocket-Key`, a non-empty `model` query
  parameter, and a relay API key from the Go-compatible Realtime subprotocol
  (`openai-insecure-api-key.<token>`), `Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`, or query `key`. The entry reuses D1 relay-token auth,
  model/IP/quota checks, auth cache, and token/IP rate limits before forwarding
  the original WebSocket request to the hibernatable `RealtimeSession` Durable
  Object. Socket attachments now store sanitized context, including token
  source, non-plaintext token fingerprint, auth state, model, and redacted
  protocol summary; raw protocol tokens are not serialized. Local evidence:
  `cargo test -p cinatoken-worker --lib realtime_session` (6 passed),
  `cargo test -p cinatoken-worker --lib` (392 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  and `bun run check` (passed; route audit 214 frontend calls / 307 Worker
  routes / 0 missing calls; existing worker dead-code warnings only). Upstream
  Realtime bridge, preconsume/settlement/audit, and live hibernation/protocol
  replay remain G7-gated.

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

- The frontend artifact and public HTTP contract still need deployed
  verification. Rendered browser smoke, authenticated session/role/CRUD/2FA
  flows, console inspection, and the 2026-07-03 backend route batch deployment
  remain pending.
- The production bundle-size budget is now enforced locally, but the bundle
  still needs heavy route-specific chunk splitting and deployed browser
  performance evidence before G5 production approval.

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
