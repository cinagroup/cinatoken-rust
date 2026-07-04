# Admin, Frontend, And Auth Parity Runbook

Date: 2026-06-22

Status: production migration runbook for G5 in
`docs/production-migration-execution-plan.md`.

## Purpose

This runbook defines how `cinatoken-rust` proves that operators can run the
Rust/Cloudflare staging environment without direct D1 edits. It covers the
admin API surface, the React frontend migration, login/session choices,
operator CRUD flows, audit logging, cache invalidation, and go/no-go evidence
for Scenario B and later cutovers.

G5 is not required for the earliest relay-only beta, but it is required before
operators depend on Rust for token, channel, user, setting, log, or auth
operations.

Read this file with:

- `docs/production-migration-execution-plan.md`
- `docs/production-readiness-matrices.md`
- `docs/cloudflare-production-config-checklist.md`
- `docs/staging-smoke-runbook.md`
- `docs/cutover-rollback-runbook.md`
- `docs/data-migration-runbook.md`
- `docs/observability-slo-security-runbook.md`
- `docs/billing-parity-runbook.md` for any billing, quota, subscription, or
  payment behavior.
- `docs/verification.md`

Do not store production cookies, bearer tokens, provider keys, payment secrets,
OAuth secrets, Turnstile secrets, screenshots with secrets, or raw database
exports in this repository.

## Cache Invalidation Policy

Admin mutations that change rows the relay hot path caches must invalidate
those caches so the next relay request sees the new state immediately rather
than waiting for the TTL. The Worker implements this in
`crates/worker/src/cache_invalidation.rs` using Upstash Redis SCAN + bulk DEL:

| Mutation | Invalidation | Notes |
| --- | --- | --- |
| Token create / update / delete / reveal | `invalidate_token_cache` → `relay:auth:*` | Pattern clear (token cache keys include a fingerprint, not a user id); brief cache-miss storm mirrors the Go gateway. |
| Channel create / update / delete / status (future) | `invalidate_channel_cache` → `relay:channel:*` | Helper exists; wired when channel CRUD lands. |
| Option update | `invalidate_option_cache` → `relay:option:*` | Placeholder; options are not cached in the relay path today. |

All invalidations are best-effort: if Upstash is not configured or SCAN/DEL
fails, the helper logs a `console_warn!` and returns `Ok(())` so the mutation
that triggered it is not rolled back. The TTL is the safety net.

## Current Inputs

Source Go/backend inputs inspected for this runbook:

- `C:\cinagroup\cinatoken\router\api-router.go`
- `C:\cinagroup\cinatoken\router\dashboard.go`
- `C:\cinagroup\cinatoken\router\web-router.go`
- `C:\cinagroup\cinatoken\web\default\package.json`
- `C:\cinagroup\cinatoken\web\default\src`

Source frontend shape:

- Rsbuild + React + TanStack Router/Query.
- Main frontend commands are `dev`, `build`, `build:check`, `typecheck`,
  `lint`, `format:check`, and `preview`.
- The frontend uses same-origin API calls by default through
  `VITE_REACT_APP_SERVER_URL` fallback behavior.
- Important feature folders include `auth`, `keys`, `channels`, `users`,
  `usage-logs`, `dashboard`, `subscriptions`, `system-settings`, `models`,
  `redemption-codes`, `wallet`, `profile`, and `setup`.

Rust/Cloudflare target inputs:

- Worker API routes live under `crates/worker/src`.
- D1 repository boundaries live in `crates/worker/src/d1_repositories.rs`.
- Token/channel read-through cache and rate limit behavior use Upstash Redis.
- Frontend deployment is still planned and must be wired before G5 can pass.

Cloudflare references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers static assets:
  <https://developers.cloudflare.com/workers/static-assets/>
- Workers SPA routing:
  <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Workers environment variables:
  <https://developers.cloudflare.com/workers/configuration/environment-variables/>
- Turnstile server-side validation:
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Turnstile testing:
  <https://developers.cloudflare.com/turnstile/troubleshooting/testing/>

Tooling reference:

- Latest `@cloudflare/workers-types` fetched with `npm pack` on 2026-06-22:
  `4.20260621.1`.

## G5 Principles

- Operators must use the admin UI/API for normal staging work. Manual D1 edits
  are allowed only for break-glass recovery with an incident note.
- Admin mutations must be authenticated, authorized, audited, and redacted.
- Any token, channel, model mapping, group, option, or user quota mutation must
  either invalidate hot caches immediately or document the maximum stale TTL.
- Frontend bundles may contain only public environment configuration. Secrets
  stay in Worker bindings, Wrangler/Cloudflare secrets, or the chosen secret
  store.
- Source-of-truth ownership must be explicit for every write family. Do not
  let Go and Rust both accept independent writes for the same family unless a
  reconciliation plan exists.
- Payment and subscription operations are G4/G5/G6 shared territory. Use the
  billing runbook for settlement, idempotency, and paid cutover decisions.
- OAuth, Passkey, 2FA, and sessions are security-sensitive. If they are not
  migrated before Scenario B, document a forced re-auth or defer-to-Go policy.
- Use Cloudflare bindings and Worker environment variables for platform
  integration. Do not call Cloudflare REST APIs from the Worker hot path for
  resources that should be bindings.
- Use `ctx.waitUntil()` only for post-response work that is safe to complete
  after the client receives the response. Authorization, validation, quota
  mutation, and required audit writes stay on the request-critical path.

## Workstreams

| Workstream | Owner | Target | G5 Evidence |
| --- | --- | --- | --- |
| Frontend build and deploy | Frontend/Platform | Bun-driven build deployed as Cloudflare static assets, Pages, or a documented equivalent | Build output, route fallback smoke, same-origin/API URL decision |
| Admin API parity | Backend | Rust exposes the operator routes required by Scenario B | Route matrix, unit tests, staging smoke |
| Auth and sessions | Backend/Security | Login/current-user/logout and role enforcement are proven, or forced re-auth/defer plan is approved | Auth strategy record, cookie/session smoke |
| Operator CRUD flows | Backend/Frontend | Token, channel, user, model, log, and settings flows work without D1 edits | UI/API smoke report |
| Cache consistency | Backend/SRE | Mutations invalidate token/channel/model/option caches or define bounded stale behavior | Cache smoke evidence |
| Audit and redaction | SRE/Security | Sensitive mutations create audit events without leaking secrets | Log/audit sample, redaction scan |
| Payments/subscriptions | Billing/Security | Deferred, Go-owned, or Rust-owned with idempotency and replay evidence | Link to billing parity report |
| OAuth/Passkey/2FA | Security | Migrated securely or explicitly reset/deferred | Security smoke or defer decision |

## Source Route Inventory

The source API is broad. G5 should migrate only the routes needed for the
selected cutover scenario, while keeping deferred rows explicit.

| Family | Source Routes | Scenario B Priority | Rust Target |
| --- | --- | --- | --- |
| Public status/setup | `/api/status`, `/api/setup`, setup/static metadata | P1 | Keep `/api/status`; decide setup/public metadata before frontend deploy |
| Login/session | `/api/user/login`, `/api/user/login/2fa`, `/api/user/logout`, `/api/user/self` | P0 | Rust login/current-user/logout, or Go-owned session bridge with forced re-auth |
| Register/password/OAuth start | `/api/user/register`, `/api/reset_password`, `/api/oauth/*` | P1/P2 | Defer unless public auth moves in Scenario B |
| Passkey/2FA self-service | `/api/user/passkey/*`, `/api/user/2fa/*` | P1/P2 | 2FA setup/enable/status/disable/backup-code frontend contract implemented and unit-verified; Passkey remains deferred pending credential/import policy |
| Profile check-in | `/api/user/checkin` | P1 | Implemented: status and submit routes use D1 `checkins`, Go-compatible envelopes, option-backed enable/min/max settings, Turnstile on submit when configured, a unique per-user UTC day guard, quota increment rollback on failure, and best-effort system logs; authenticated staging duplicate-submit smoke still required |
| User admin | `/api/user`, `/api/user/search`, `/api/user/manage`, binding reset routes | P0 | Partial: list/search/get/create/edit/delete + `POST /api/user/manage` 8-action switch (disable/enable/delete/promote/demote/quota add/subtract/override) implemented in `admin_user.rs`; permission tiers match Go, quota mutations atomic, DELETE soft-deletes with token cache invalidation; binding reset routes deferred (OAuth batch) |
| Token/key admin | `/api/token`, `/api/token/search`, key reveal, batch delete | P0 | Implemented: list/search/get/create/update/delete/batch/reveal plus secure user-scoped batch-key reveal (100-id limit), ownership checks, masking, audit, and cache invalidation |
| Channel admin | `/api/channel`, test, key reveal, tags, balance, model fetch | P0 | Partial: CRUD, key reveal, test/fetch-models including Ollama `/api/tags`, tag enable/disable/edit, batch-tag, tag-model lookup, provider balance refresh, multi-key management, single-channel and bounded-batch upstream-update detect/apply, Codex usage/credential refresh, Ollama version/delete/pull-stream management, abilities sync and cache invalidation implemented |
| Logs and usage | `/api/log`, `/api/log/search`, `/api/log/self`, `/api/usage/*`, `/api/mj`, `/api/task` | P0/P1 | Logs: list/stat/delete (admin + self) implemented in `crates/worker/src/admin_crud.rs`; Midjourney/task read-only usage-log lists implemented in `crates/worker/src/admin_task_logs.rs`; `/api/usage/*` still Planned |
| Groups/models/vendors/prefill | `/api/group`, `/api/models`, `/api/vendors`, `/api/prefill_group` | P1 | Group lookup, model/vendor CRUD, D1-backed prefill-group CRUD, and fixed-origin official model metadata preview/sync implemented |
| Options/settings | `/api/option/*`, setup/system settings | P0/P1 | Option list (root-only, sensitive filtered) + update (root-only upsert) implemented; Waffo Pancake config save, catalog/subscription-product-option reads, and pair/subscription-product creation helpers implemented with root-only auth, credential fallback, private-key non-echo, signed Waffo action calls, option-cache invalidation, and redacted audit; broader per-key validation (OAuth/ratio/console_setting) deferred to next batch |
| Dashboard billing | `/dashboard/billing/*`, `/v1/dashboard/billing/*` | P1/G4 | Read-only billing dashboard or Go-owned until G4 evidence exists |
| Subscriptions/payments | `/api/subscription/*`, payment callbacks | G4/G6 | Partial: subscription core, admin/user subscription state, billing preference, and balance-pay are implemented. External subscription checkout/callback providers remain deferred pending provider-specific signature/idempotency/replay evidence |
| Redemptions/topups | `/api/redemption`, topup/pay routes | P1/G4/G6 | Partial: admin redemption-code management is implemented at `/api/redemption`; public redemption-code topup is implemented at `POST /api/user/topup` with D1 `credited` idempotency; Stripe topup info/amount/pay link, legacy online amount estimation at `POST /api/user/amount`, Waffo Pancake amount estimation at `POST /api/user/waffo-pancake/amount`, Waffo Pancake admin config/catalog/subscription-product-option read paths and pair/subscription-product creation helpers, self/admin topup history, and admin manual completion are implemented. Non-Stripe order creation/callback providers remain deferred until provider-specific signature, webhook idempotency, and reconciliation evidence exist |
| Performance/ratio sync | `/api/performance`, `/api/ratio_sync`, perf metrics | P2/G7 | Partial: Worker-native uptime/perf metrics, explicit no-op local maintenance responses, and upstream ratio sync implemented; authenticated staging smoke still required |
| Async/tasks/media | `/api/task`, `/api/mj`, video routes | G7 | Partial: read-only `/api/task` and `/api/mj` usage-log lists are implemented for the admin frontend; task submit/poll/content/proxy ownership still requires Queue/R2/Workflow design and G7 smoke before cutover |
| Custom OAuth providers | `/api/custom-oauth-provider` | P1/G6 | Partial: root-admin provider CRUD/discovery implemented with secret-redacted responses, D1 import/schema, admin audit, SSRF controls, and `/api/status` enabled-provider exposure; login/bind callbacks remain deferred |

## Frontend Deployment Policy

Choose one deployment model before G5:

| Model | Use When | Required Config |
| --- | --- | --- |
| Worker static assets | Frontend and API should share a Worker/custom domain | Wrangler `assets.directory`, SPA fallback, API route precedence |
| Cloudflare Pages plus Worker API | Frontend and API deploy separately | Pages project, API base URL, CORS/cookie domain policy |
| Temporary Go-hosted frontend | Scenario A only or staged comparison | Explicit defer note; G5 cannot pass for Rust admin |

Preferred G5 target:

1. Build the source frontend with Bun:

```powershell
cd C:\cinagroup\cinatoken\web\default
bun install --frozen-lockfile
bun run typecheck
bun run build
```

2. Decide whether the built assets are copied into the Rust repository,
   produced by a CI artifact, or deployed from the source frontend repository.
   Record the artifact path and commit SHA.
3. Configure staging so `/api/*`, `/v1/*`, and provider relay routes go to the
   Worker API, while SPA routes fall back to `index.html`.
4. Keep `VITE_REACT_APP_SERVER_URL` empty for same-origin staging unless a
   separate Pages/API domain is deliberately selected.
5. Run route smoke for hard refreshes on `/dashboard`, `/channels`, `/keys`,
   `/users`, `/usage-logs`, `/models`, `/subscriptions`, `/system-settings`,
   and `/profile`.
6. Confirm no secret value appears in the static bundle:

```powershell
rg -n "UPSTASH|SECRET|TOKEN|PRIVATE|CLIENT_SECRET|WEBHOOK|API_KEY" dist
```

Use an allowlist for public names such as `TURNSTILE_SITE_KEY`; secret values
must never be present.

## Auth And Session Strategy

The source-derived auth/session mechanism (session vs access-token user auth, the
`New-Api-User` double-submit header, relay token-key extraction, the
`sk-<key>-<channelid>` admin pin, role model, and OAuth/2FA/Passkey enrollment) is
specified in `docs/source-auth-session-parity.md`. Use it to resolve the
decisions below.

Pick exactly one strategy for each cutover scenario.

| Strategy | Use When | Tradeoff | G5 Requirement |
| --- | --- | --- | --- |
| Forced re-auth on Rust | Session schemas are not migrated | Simple and explicit customer/operator boundary | Cookie names, expiry, logout, and current-user smoke |
| Go-owned auth bridge | Go remains admin authority during Scenario A | Lower Rust scope, but G5 is not complete | Document that Scenario B is blocked |
| Session import | Existing sessions should survive | Requires safe secret/key import and format parity | Import tests, session replay/expiry tests |
| New Rust session authority | Rust owns admin/frontend auth | Clean target state | D1/session schema, cookie policy, CSRF/state, role tests |
| Durable Object/session service | Realtime or high-write session state is needed | More moving parts | DO migration and WebSocket/session smoke |

**Current Rust choice (2026-06-22):** New Rust session authority with forced
re-auth on first Rust visit. The Worker issues stateless HMAC-signed cookies
from `crates/session` (format: `base64url(payload_json).base64url(hmac_sha256(payload))`),
signed with the `SESSION_SECRET` Wrangler secret. The Go gateway's gin-contrib
cookie-store format (gob + AES) is **not** portable, so every existing browser
session expires when traffic moves to Rust and users must sign in once. This
is the documented G5 forced-re-auth policy. Cookie attributes are
`HttpOnly; SameSite=Strict; Secure` (the `Secure` flag is a deliberate
hardening over Go's `Secure: false`). The cookie name is still `session`, so
the existing React dashboard reads and sends it unchanged.

The `New-Api-User` header (Go's anti-CSRF measure) is **not** required on the
Rust side: `SameSite=Strict` + `HttpOnly` + `Secure` cover the same threat.
This is a documented difference from Go.

Minimum session/cookie policy:

- Secure cookies in production.
- `HttpOnly` for session cookies.
- `SameSite=Lax` or stricter unless OAuth/payment return flows require an
  exception.
- Explicit domain/path per staging and production hostname.
- Logout clears every Rust session cookie.
- CORS permits credentialed requests only from approved frontend origins.
- CSRF or state validation is present for form/OAuth flows that need it.
- Turnstile tokens are validated server-side for enabled public auth flows.

OAuth/Passkey/2FA choices:

- If migrated: import or recreate credentials with documented hash/secret
  handling, replay protection, and reset flows.
- If not migrated: require forced re-auth, forced rebind, or admin-assisted
  reset. Record customer/operator impact.
- Custom OAuth provider discovery URLs pass SSRF-origin validation before
  backend fetch. Callback/login enablement still needs state replay checks,
  callback origin checks, and account-binding smoke before production use.

## Admin API Contract

Every sensitive admin mutation must satisfy this contract:

```text
actor_id:
actor_role:
request_id:
method:
route:
target_family:
target_id:
before_fingerprint:
after_fingerprint:
redacted_fields:
cache_invalidations:
source_of_truth:
result:
```

Mutation rules:

- Validate actor role before reading secret-bearing rows.
- Validate request body with explicit size limits.
- Use D1 transactions or tightly scoped repository functions for related
  changes when supported by the Worker path.
- Never return raw channel keys or token keys by default.
- Reveal routes require elevated authorization, critical rate limits,
  no-store response headers, audit logs, and redacted logs.
- Invalidate affected Redis cache keys after token/channel/model/group/option
  changes. If immediate invalidation is not implemented, record the TTL and
  keep Scenario B blocked for high-risk changes.
- Return a response safe for frontend caching and log ingestion.

Suggested repository boundary:

| Domain | Repository Responsibility |
| --- | --- |
| Users | list/search/detail/create/update/status/quota/reset |
| Tokens | list/search/detail/create/update/delete/reveal/cache invalidation |
| Channels | list/search/detail/create/update/delete/test/reveal/cache invalidation |
| Options | read/update with typed option parsing and audit |
| Logs | recent searchable D1 logs plus archive pointer fields |
| Models/vendors | model mapping, vendor metadata, prefill groups |
| Auth | session/current-user/logout, optional password/OAuth/Passkey/2FA |

## Operator Smoke Cases

Run these in staging with an admin account that does not use production
secrets.

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| ADMIN-001 | Login, current user, logout, expired session | Correct role, secure cookie, 401 after logout |
| ADMIN-002 | Open dashboard and hard-refresh SPA routes | Assets served, API calls same-origin or approved CORS |
| ADMIN-003 | Create token, update model/IP/status, reveal key, disable token | Token works only when enabled, reveal audited, cache invalidated |
| ADMIN-004 | Create/update/disable channel and run channel test | Channel selection reflects change, secret redacted, cache invalidated |
| ADMIN-005 | Update model mapping or group config | Relay route uses new mapping after invalidation/TTL |
| ADMIN-006 | Adjust user quota/status/role | D1 row changes once, audit event exists, no double mutation |
| ADMIN-007 | Search logs by token/channel/model/request ID | Recent request is queryable, secrets are redacted |
| ADMIN-008 | Update safe system option | Option readback works, audit event exists, cache invalidated |
| ADMIN-009 | Try forbidden admin action as normal user | 403/compatible error, no mutation |
| ADMIN-010 | Trigger rate limit on reveal or auth-sensitive route | Compatible rejection, no secret leak |
| ADMIN-011 | Disable bad token/channel during relay smoke | New relay requests stop quickly or within documented TTL |
| ADMIN-012 | Export redacted G5 report | Report has request IDs and no secrets |

Optional cases when in scope:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| AUTH-ADMIN-001 | 2FA login and admin reset | Replay-safe, reset audited |
| AUTH-ADMIN-002 | Passkey login/register/reset | Credential handling documented, reset audited |
| AUTH-ADMIN-003 | OAuth login/bind/unbind | State/callback checks, forced rebind policy if not migrated |
| PAY-ADMIN-001 | Subscription plan list/create/update | Follow `docs/billing-parity-runbook.md` |
| PAY-ADMIN-002 | Payment callback replay | Signature/idempotency evidence, no double-credit |

## Cache Invalidation Matrix

| Mutation | Required Invalidation | Blocking If Missing |
| --- | --- | --- |
| Token create/update/delete/status/reveal-related rotation | token auth cache, token rate-limit metadata if needed | Yes |
| User status/quota/group/role | token auth cache for affected user, user summary cache | Yes |
| Channel create/update/delete/status/key/group/model | channel selection cache for affected group/model/provider | Yes |
| Ability/group/model mapping | channel selection cache and model list cache | Yes |
| Option/settings update | option/config cache and frontend status cache | Yes for auth/billing/security settings |
| Log deletion/archive | log query cache, if present | No, if logs are clearly eventual |
| Subscription/payment plan update | billing/subscription cache | Yes before paid cutover |

## Security Checks

G5 must pass these before Scenario B:

- Secret-bearing API responses are `Cache-Control: no-store`.
- Logs do not include raw bearer tokens, cookies, token keys, channel keys,
  OAuth secrets, payment secrets, Turnstile secrets, or full provider
  credentials.
- Frontend bundle scan shows no secret values.
- Admin reveal routes have elevated auth and critical rate limits.
- All admin mutations write audit metadata with actor, action, target, and
  request ID.
- CORS only allows approved origins and credentials policy matches cookie
  strategy.
- Turnstile public auth flows call server-side validation before trusting the
  token.
- OAuth callback/state validation is tested for any enabled provider.
- Custom OAuth provider admin rejects private, loopback, metadata-service, and
  otherwise unsafe URLs unless a documented allowlist exception exists.
- User-controlled URLs in channel/model/provider tools are SSRF-reviewed before
  enablement.
- Channel balance refresh rejects literal private/special IPs, localhost and
  internal suffixes, credentials, fragments, non-80/443 ports, and redirects.
  Worker URL validation cannot resolve admin-supplied hostnames before fetch,
  so DNS rebinding remains a documented residual risk until production uses an
  outbound allowlist, controlled channel domains, or equivalent egress policy.

## Evidence Template

Create a redacted G5 report with:

```text
Date:
Commit:
Frontend source commit:
Frontend build command:
Frontend artifact/deploy target:
Worker deploy/version:
Staging URL:
API base URL policy:
Auth/session strategy:
Cookie policy:
Admin operator:
Security operator:
Source-of-truth matrix version:
Routes in scope:
Routes deferred:
Cache invalidation mode:
Overall result:
Known deviations:
```

For each smoke case:

```text
Case ID:
Actor:
Route/UI path:
Expected status:
Actual status:
Worker request ID:
D1 row/table touched:
Cache invalidation evidence:
Audit/log evidence:
Secret redaction result:
Pass/fail:
Notes:
```

## Go/No-Go

G5 passes only when:

1. Admin/frontend source of truth is clear for the selected scenario.
2. Staging frontend deploy works with the selected static asset/Pages model.
3. Login/current-user/logout and role checks pass, or a forced re-auth/defer
   plan is approved for the scenario.
4. P0 operator flows pass without direct D1 edits: token, channel, user, logs,
   settings, and model/group config.
5. Sensitive mutations write audit entries and preserve request IDs.
6. Token/channel/model/option changes invalidate caches or document a safe TTL.
7. No secret appears in frontend bundles, Worker logs, smoke reports, or API
   responses that should be redacted.
8. Payment/subscription routes are either deferred to Go or covered by the
   billing parity runbook with idempotency evidence.
9. OAuth/Passkey/2FA routes are either migrated and tested or covered by a
   forced re-auth/reset/defer policy.
10. A redacted G5 report is linked from `docs/verification.md`.

G5 fails or stays blocked if:

- Operators still need routine D1 edits.
- Token/channel/user changes can leave the relay cache stale beyond the
  documented TTL.
- A normal user can reach admin mutations.
- A reveal route leaks raw secrets into logs or cacheable responses.
- The frontend bundle contains secret values.
- Source-of-truth ownership for a write family is ambiguous.
- Payment/subscription flows can double-credit or double-charge.

## Rollback

For Scenario B rollback:

1. Stop Rust admin traffic by route, feature flag, or Worker version rollback.
2. Keep Rust relay traffic running only if Scenario A gates still pass.
3. Return admin frontend/API authority to Go/VPS.
4. Preserve Rust D1 rows, audit logs, and cache keys for investigation.
5. Reconcile any token/channel/user/option mutations that occurred in Rust.
6. Rotate any secret that may have been exposed in a failed smoke or report.
7. Add the rollback summary to `docs/verification.md`.

Do not delete Rust-side evidence during rollback. Evidence is required to
decide whether data should be replayed, ignored, or manually reconciled.

## Deferred Work Ledger

Use this table until every row has a concrete owner and migration decision.

| Area | Default Decision | Revisit Before |
| --- | --- | --- |
| Public registration/password reset | Defer unless Rust owns public auth | Scenario B public launch |
| OAuth login/bind/custom providers | Defer or forced rebind | Scenario B if auth moves |
| Passkey/2FA migration | Forced reset unless secure import is proven | Scenario B auth cutover |
| Non-Stripe payment callbacks/topups | Keep on Go | Scenario C |
| Subscriptions/pre-consume records | Use billing runbook | Scenario C |
| Async task/media admin | Keep on Go | Scenario D/G7 |
| Performance/ratio sync ops | Keep on Go or service escape hatch | Scenario D |
| Historical log archive | D1 recent logs first, R2/Queue archive later | G6/G7 |
| Channel affinity control plane | Stats/clear and usage diagnostics for the Rust Worker indexed Durable Object subset are implemented with AdminAuth, bounded KV scans, relay audit metadata, and TTL-bounded usage counters. Remaining: Go rule-template parity | Scenario B affinity enablement |
| Upstream model update batches | Single-channel detect/apply and after-id bounded detect-all/apply-all slices are implemented on bounded Worker fetches. Move the same cursor contract to Queue/Workflow orchestration with progress and idempotency for unattended runs | Scenario B channel automation |
| Codex usage/credential refresh | Implemented as bounded fixed-purpose Worker outbound requests with atomic credential replacement, best-effort cache invalidation, secret-safe audit, and explicit rejection of Go VPS proxy settings; live Codex subscription smoke remains required | Scenario B Codex channels |
| Ollama model management | Route through a Tunnel-protected management service, Container, or approved service binding; do not expose a VPS-local Ollama daemon to public Worker egress | Scenario D/local-provider support |
