# Source Route Inventory (Canonical)

Date: 2026-06-25

Status: canonical, source-derived inventory of every HTTP route registered by the
Go `cinatoken` server. This is the ground truth that the family-level Route
Readiness Matrix in `docs/production-readiness-matrices.md` and the route tables
in `docs/route-provider-parity-runbook.md` must agree with. Where they disagree,
this inventory wins because it is read directly from the router registration
code.

## Source Of Truth

Read from `C:\cinagroup\cinatoken\router\`:

- `relay-router.go` — `/v1`, `/v1beta`, `/pg`, `/mj`, `/suno` relay surface.
- `video-router.go` — `/v1/video*`, `/kling/v1`, `/jimeng` async media.
- `dashboard.go` — `/dashboard/billing/*` (route tag `old_api`).
- `api-router.go` — `/api/*` admin/user/auth/payment/options surface.
- `web-router.go` — SPA static serving and `NoRoute` fallback.

Auth/middleware semantics are read from `middleware/` (TokenAuth, UserAuth,
AdminAuth, RootAuth, TokenAuthReadOnly, TokenOrUserAuth, Distribute, Turnstile,
rate limits, SecureVerificationRequired, DisableCache).

## Auth And Middleware Taxonomy

Every route carries an auth class and zero or more guards. The Rust Worker must
preserve these classes; collapsing them is a security regression.

| Class | Go middleware | Meaning | Rust target |
| --- | --- | --- | --- |
| Token | `TokenAuth()` | `Authorization: Bearer sk-...` API key | Relay token auth (implemented) |
| Token read-only | `TokenAuthReadOnly()` | Token auth for usage/log reads | Token auth, read scope |
| User session | `UserAuth()` | Browser session/JWT | `crates/session` HMAC cookie |
| Admin | `AdminAuth()` | Admin role required | Session + role check |
| Root | `RootAuth()` | Root role required | Session + role check |
| Token-or-user | `TokenOrUserAuth()` | Either token or session (video proxy) | Dual auth resolver |
| Anonymous | none (+ signature) | Public/webhook; body-size limited | Public route + signature verify |
| Guard: Turnstile | `TurnstileCheck()` | Bot check on register/login/reset/checkin | Turnstile server-side verify |
| Guard: distribute | `Distribute()` | Channel selection + model routing | Channel selector (implemented) |
| Guard: secure verify | `SecureVerificationRequired()` | Step-up for channel key reveal | Secure verification flow |
| Guard: disable cache | `DisableCache()` | Force fresh read for secret reveal | Bypass read-through cache |
| Guard: rate limits | `Global/Critical/Model/Search/EmailVerification...RateLimit()` | Tiered rate limits | Rate Limiting binding (per §21.1) |
| Guard: perf | `SystemPerformanceCheck()` | Shed load under pressure | Optional; Worker has its own limits |
| Guard: body limit | `AnonymousRequestBodyLimit()` | Bound anonymous bodies | Bounded body reader (implemented) |

## Relay Routes (`relay-router.go`)

Global middleware on this surface: `CORS`, `DecompressRequestMiddleware`,
`BodyStorageCleanup`, `StatsMiddleware`.

| Method | Path | Auth | Handler / Relay Format | Notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/models` | Token | `ListModels`/`RetrieveModel` | **Header-conditional**: `x-api-key`+`anthropic-version` -> Anthropic list; `x-goog-api-key` or `?key` -> Gemini retrieve; else OpenAI list. Parity-critical. |
| GET | `/v1/models/:model` | Token | `RetrieveModel` | Anthropic if `x-api-key`+`anthropic-version`, else OpenAI. |
| GET | `/v1beta/models` | Token | `ListModels(Gemini)` | Gemini model list. |
| GET | `/v1beta/openai/models` | Token | `ListModels(OpenAI)` | Gemini-OpenAI-compat model list. |
| POST | `/pg/chat/completions` | User session | `Playground` | `UserAuth`+`Distribute`; admin playground, not token. |
| GET | `/v1/realtime` | Token | `Relay(OpenAIRealtime)` | **WebSocket**; `Distribute`. Needs DO/Container (§21.4). |
| POST | `/v1/messages` | Token | `Relay(Claude)` | Anthropic Messages. |
| POST | `/v1/completions` | Token | `Relay(OpenAI)` | |
| POST | `/v1/chat/completions` | Token | `Relay(OpenAI)` | |
| POST | `/v1/responses` | Token | `Relay(OpenAIResponses)` | |
| POST | `/v1/responses/compact` | Token | `Relay(OpenAIResponsesCompaction)` | |
| POST | `/v1/edits` | Token | `Relay(OpenAIImage)` | Legacy edits -> image format. |
| POST | `/v1/images/generations` | Token | `Relay(OpenAIImage)` | |
| POST | `/v1/images/edits` | Token | `Relay(OpenAIImage)` | **Multipart** implemented; live upstream/billing evidence pending. |
| POST | `/v1/embeddings` | Token | `Relay(Embedding)` | |
| POST | `/v1/audio/transcriptions` | Token | `Relay(OpenAIAudio)` | **Multipart** implemented; byte-safe model extraction and common audio duration preflight estimate; live upstream/billing evidence pending. |
| POST | `/v1/audio/translations` | Token | `Relay(OpenAIAudio)` | **Multipart** implemented; byte-safe model extraction and common audio duration preflight estimate; live upstream/billing evidence pending. |
| POST | `/v1/audio/speech` | Token | `Relay(OpenAIAudio)` | Binary response. |
| POST | `/v1/rerank` | Token | `Relay(Rerank)` | Jina/Cohere. |
| POST | `/v1/engines/:model/embeddings` | Token | `Relay(Gemini)` | Legacy engines alias -> Gemini format. |
| POST | `/v1/models/*path` | Token | `Relay(Gemini)` | Gemini path-style under `/v1`. |
| POST | `/v1/moderations` | Token | `Relay(OpenAI)` | |
| POST | `/v1beta/models/*path` | Token | `Relay(Gemini)` | Native Gemini `:action` path. |
| POST | `/suno/submit/:action` | Token | `RelayTask` | Async; `Distribute`. |
| POST | `/suno/fetch` | Token | `RelayTaskFetch` | |
| GET | `/suno/fetch/:id` | Token | `RelayTaskFetch` | |
| POST | `/mj[/:mode]/submit/*` | Token | `RelayMidjourney` | 11 submit actions (action/shorten/modal/imagine/change/simple-change/describe/blend/edits/video/upload-discord-images). |
| GET | `/mj[/:mode]/task/:id/fetch` | Token | `RelayMidjourney` | Also `/image-seed`. |
| POST | `/mj[/:mode]/task/list-by-condition` | Token | `RelayMidjourney` | |
| POST | `/mj[/:mode]/insight-face/swap` | Token | `RelayMidjourney` | |
| GET | `/mj[/:mode]/image/:id` | Anonymous | `RelayMidjourneyImage` | Image proxy before TokenAuth. |
| POST,GET,DELETE | `/v1/images/variations`, `/v1/files*`, `/v1/fine-tunes*`, `DELETE /v1/models/:model` | Token | `RelayNotImplemented` | **Explicit 501s** — Rust must preserve, not 404. |

`/mj` is registered twice: `/mj/*` and `/:mode/mj/*` (mode-prefixed variant).

## Async Media Routes (`video-router.go`)

| Method | Path | Auth | Handler | Notes |
| --- | --- | --- | --- | --- |
| GET | `/v1/videos/:task_id/content` | **Token-or-user** | `VideoProxy` | Dual auth: dashboard session or API token. |
| POST | `/v1/video/generations` | Token | `RelayTask` | `Distribute`. |
| GET | `/v1/video/generations/:task_id` | Token | `RelayTaskFetch` | |
| POST | `/v1/videos/:video_id/remix` | Token | `RelayTask` | |
| POST | `/v1/videos` | Token | `RelayTask` | OpenAI-compatible video create. |
| GET | `/v1/videos/:task_id` | Token | `RelayTaskFetch` | |
| POST | `/kling/v1/videos/text2video` | Token | `RelayTask` | `KlingRequestConvert` middleware. |
| POST | `/kling/v1/videos/image2video` | Token | `RelayTask` | |
| GET | `/kling/v1/videos/{text2video,image2video}/:task_id` | Token | `RelayTaskFetch` | |
| POST | `/jimeng/` | Token | `RelayTask` | `JimengRequestConvert`; maps to VolcEngine `Action=CVSync2Async*`. |

## Dashboard Billing Routes (`dashboard.go`, route tag `old_api`)

Middleware: `gzip`, `GlobalAPIRateLimit`, `CORS`, `TokenAuth`.

| Method | Path | Auth | Handler |
| --- | --- | --- | --- |
| GET | `/dashboard/billing/subscription` | Token | `GetSubscription` |
| GET | `/v1/dashboard/billing/subscription` | Token | `GetSubscription` |
| GET | `/dashboard/billing/usage` | Token | `GetUsage` |
| GET | `/v1/dashboard/billing/usage` | Token | `GetUsage` |

## `/api/*` Surface (`api-router.go`)

Global middleware: `RouteTag(api)`, `gzip`, `BodyStorageCleanup`,
`GlobalAPIRateLimit`. Grouped below by auth class.

### Public / anonymous

| Method | Path | Guards | Handler |
| --- | --- | --- | --- |
| GET | `/api/setup` | — | `GetSetup` |
| POST | `/api/setup` | bodyLimit | `PostSetup` |
| GET | `/api/status` | — | `GetStatus` (implemented in Rust) |
| GET | `/api/uptime/status` | — | `GetUptimeKumaStatus` |
| GET | `/api/notice`,`/about`,`/home_page_content`,`/user-agreement`,`/privacy-policy` | — | content getters |
| GET | `/api/pricing` | HeaderNav(pricing) | `GetPricing` |
| GET | `/api/perf-metrics`,`/api/perf-metrics/summary` | HeaderNav public-or-user | perf getters |
| GET | `/api/rankings` | HeaderNav(rankings) | `GetRankings` |
| GET | `/api/verification` | EmailVerifyRL + Turnstile | `SendEmailVerification` |
| GET | `/api/reset_password` | CriticalRL + Turnstile | `SendPasswordResetEmail` |
| POST | `/api/user/reset` | CriticalRL + bodyLimit | `ResetPassword` |
| GET | `/api/oauth/state` | CriticalRL | `GenerateOAuthCode` |
| POST | `/api/oauth/email/bind` | CriticalRL + bodyLimit | `EmailBind` |
| GET/POST | `/api/oauth/wechat[/bind]` | CriticalRL | `WeChatAuth`/`WeChatBind` |
| GET | `/api/oauth/telegram/{login,bind}` | CriticalRL | Telegram |
| GET | `/api/oauth/:provider` | CriticalRL | `HandleOAuth` (GitHub/Discord/OIDC/LinuxDO) |
| GET | `/api/ratio_config` | CriticalRL | `GetRatioConfig` |
| POST | `/api/stripe/webhook` | bodyLimit | `StripeWebhook` |
| POST | `/api/creem/webhook` | bodyLimit | `CreemWebhook` |
| POST | `/api/waffo/webhook` | bodyLimit | `WaffoWebhook` |
| POST | `/api/waffo-pancake/webhook/:env` | bodyLimit | `WaffoPancakeWebhook` (env-scoped) |
| POST/GET | `/api/user/epay/notify` | bodyLimit | `EpayNotify` |
| POST/GET | `/api/subscription/epay/{notify,return}` | bodyLimit | subscription Epay callbacks |

All webhook/notify routes are **anonymous and signature-verified** — a primary
SSRF/replay surface for the payment migration (G4/G6).

### User self (`/api/user/*` under `UserAuth`)

`register`, `login`, `login/2fa`, `passkey/login/{begin,finish}` are anonymous
(+CriticalRL+Turnstile/bodyLimit); `logout`, `groups` anonymous. Authed self
routes: `self` (GET/PUT/DELETE), `models`, `self/groups`, `token`
(`GenerateAccessToken`), `aff`, `setting`, passkey register/verify/delete,
2FA status/setup/enable/disable/backup_codes, checkin status/do, topup
info/self/`TopUp`, pay flows (`pay`,`amount`,`stripe/*`,`creem/*`,`waffo*`,
`waffo-pancake/*`), `aff_transfer`, custom oauth bindings get/delete.

### User admin (`/api/user/*` under `AdminAuth`)

`GET /` all users, `topup`, `topup/complete`, `search`, `:id`, `POST /` create,
`manage`, `PUT /` update, `DELETE /:id`, `:id/reset_passkey`, oauth bindings by
admin, `:id/bindings/:binding_type` clear, 2FA stats/`:id/2fa` disable.

### Subscription (`/api/subscription` user, `/api/subscription/admin` admin)

User: `plans`, `self`, `self/preference`, balance/epay/stripe/creem/waffo-pancake
pay. Admin: plans CRUD + status PATCH, `bind`, user-subscriptions list/create/
invalidate/delete.

### Root-only

| Group | Routes |
| --- | --- |
| `/api/option` | `GET/PUT /`, `payment_compliance`, `channel_affinity_cache` get/clear, `rest_model_ratio`, `migrate_console_setting`, waffo-pancake catalog/pair/save/subscription-product(-options) |
| `/api/custom-oauth-provider` | discovery, CRUD (`GET/POST/PUT/DELETE`) |
| `/api/performance` | stats, disk_cache delete, reset_stats, gc, logs get/delete |
| `/api/ratio_sync` | `channels`, `fetch` |

### Admin CRUD groups

| Group (`AdminAuth`) | Notable routes |
| --- | --- |
| `/api/channel` | list/search/models/models_enabled/`:id`/test(/`:id`)/update_balance/add/update/delete/batch/fix/copy; `:id/key` (Root+SecureVerify+DisableCache); fetch_models(/`:id`); tag ops; `:id/codex/{refresh,usage}`; ollama pull/pull-stream/delete/version; multi_key/manage; upstream_updates detect/apply(/all) |
| `/api/token` | list/search/`:id`/`:id/key` (DisableCache)/add/update/delete/batch/batch/keys (user-scoped via `UserAuth`) |
| `/api/redemption` | list/search/`:id`/add/update/delete(invalid/`:id`) |
| `/api/log` | `/` (Admin), `stat`, `search`, `self`/`self/stat`/`self/search` (User), `channel_affinity_usage_cache`, `token` (TokenAuthReadOnly), `DELETE /` history |
| `/api/data` | `/` (Admin), `users`, `self` (User) — quota dates |
| `/api/usage/token` | `GetTokenUsage` (TokenAuthReadOnly) |
| `/api/group` | `GET /` |
| `/api/prefill_group` | list/create/update/delete |
| `/api/vendors` | list/search/`:id`/create/update/delete |
| `/api/models` | sync_upstream(/preview), missing, list/search/`:id`/create/update/delete |
| `/api/mj`,`/api/task` | self (User) + all (Admin) listings |
| `/api/deployments` | io.net deployment mgmt: settings, test-connection, list/search, hardware-types, locations, available-replicas, price-estimation, check-name, CRUD, `:id` logs/containers/extend/name |
| `/api/verify` | `UniversalVerify` (User + CriticalRL) — secure verification |

## Web / Static (`web-router.go`)

SPA served via embedded FS or external mode. `NoRoute` returns the SPA index for
non-`/v1`,`/api`,`/assets` paths; `/v1`/`/api`/`/assets` misses return
`RelayNotFound`. Rust equivalent: Workers Static Assets with
`not_found_handling = "single-page-application"` (already in `wrangler.toml`),
plus API-path precedence so unknown `/v1`/`/api` paths return a relay-style 404,
not the SPA shell (§21.6).

## Findings (parity-critical)

1. **Header-conditional model routing.** `GET /v1/models` and `/v1/models/:model`
   branch on `x-api-key`+`anthropic-version` (Anthropic) vs `x-goog-api-key`/
   `?key` (Gemini) vs default (OpenAI). The Rust route must reproduce this
   content negotiation, not assume OpenAI.

2. **Explicit 501 routes must be preserved.** `images/variations`, all `files*`
   and `fine-tunes*`, and `DELETE /v1/models/:model` return
   `RelayNotImplemented` in Go. Rust must return the same explicit unsupported
   shape, not a generic 404, so SDKs see consistent behavior.

3. **Dual-auth video proxy.** `GET /v1/videos/:task_id/content` uses
   `TokenOrUserAuth` so both dashboard sessions and API tokens work. The Rust
   auth layer needs a combined resolver for this one route.

4. **Anonymous, signature-verified webhooks are a distinct security class.**
   Stripe/Creem/Waffo/Waffo-Pancake(`:env`)/Epay (+ subscription Epay) notify
   routes have no auth middleware; correctness depends entirely on signature
   verification and idempotency (G4/G6). They must never share the token/session
   auth path.

5. **Secret-reveal routes carry step-up guards.** `POST /api/channel/:id/key`
   stacks `RootAuth`+`CriticalRateLimit`+`DisableCache`+
   `SecureVerificationRequired`; `POST /api/token/:id/key` uses
   `DisableCache`. Rust must replicate step-up + cache-bypass, not serve these
   from the read-through cache.

6. **Three relay route prefixes carry video/media converters as middleware**
   (`KlingRequestConvert`, `JimengRequestConvert`) before `Distribute`. These are
   request transforms that must run before channel selection, not in the adapter.

7. **`old_api` dashboard billing endpoints** (`/dashboard/billing/*` and the
   `/v1/` aliases) are token-authed and separate from `/api/*`. Decide in
   Scenario A whether these stay on Go or move with relay.

## Cross-Check Against Existing Matrices

The family-level Route Readiness Matrix in
`docs/production-readiness-matrices.md` is consistent with this inventory at the
family level. This inventory adds the previously under-specified detail:
per-route auth class, the explicit 501 set, dual-auth video proxy, the full
webhook set, secret-reveal step-up guards, kling/jimeng converter route groups,
and header-conditional model routing. Use this file as the G0 route-matrix
source; keep the readiness matrix as the gated status view.
