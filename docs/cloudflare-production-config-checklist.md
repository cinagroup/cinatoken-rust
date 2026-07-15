# Cloudflare Production Config Checklist

Date: 2026-07-12

Status: production configuration checklist for G1, G5, and G6 in
`docs/production-migration-execution-plan.md`.

## Purpose

This checklist defines what must be true before `cinatoken-rust` can be treated
as a production-shaped Cloudflare deployment. It complements:

- `docs/production-readiness-matrices.md`
- `docs/observability-slo-security-runbook.md`
- `docs/admin-frontend-parity-runbook.md`
- `docs/performance-capacity-cost-runbook.md`
- `docs/staging-smoke-runbook.md`
- `docs/cutover-rollback-runbook.md`

Do not put secret values in this file. Track only secret names, ownership, and
rotation evidence.

## References Refreshed

Cloudflare references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Wrangler configuration:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Workers environments:
  <https://developers.cloudflare.com/workers/wrangler/environments/>
- Workers gradual deployments:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
- Workers rollbacks:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers Logs:
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Workers static assets:
  <https://developers.cloudflare.com/workers/static-assets/>
- Workers SPA routing:
  <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Turnstile server-side validation:
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Workers pricing:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- D1 pricing:
  <https://developers.cloudflare.com/d1/platform/pricing/>
- D1 Time Travel and backups:
  <https://developers.cloudflare.com/d1/reference/time-travel/>

Cloudflare references added 2026-06-25 (see migration-plan §21):

- Workers Rate Limiting binding (GA 2025-09-19):
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- D1 global read replication / Sessions API:
  <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- D1 limits (10 GB/db, 50k dbs/account):
  <https://developers.cloudflare.com/d1/platform/limits/>
- Durable Objects (incl. WebSocket Hibernation):
  <https://developers.cloudflare.com/durable-objects/>
- Cloudflare Containers (GA 2026-04-13):
  <https://developers.cloudflare.com/containers/>
- Cloudflare Workflows:
  <https://developers.cloudflare.com/workflows/>
- Secrets Store:
  <https://developers.cloudflare.com/secrets-store/>

Cloudflare references added 2026-07-04:

- Cloudflare Email Service / Workers `send_email` binding:
  <https://developers.cloudflare.com/email-service/api/send-emails/workers-api/>
- Smart Placement:
  <https://developers.cloudflare.com/workers/configuration/smart-placement/>

Cloudflare references added 2026-07-05:

- Workers for Platforms dispatch namespaces:
  <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/>
- Durable Object WebSocket Hibernation:
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- AI Gateway:
  <https://developers.cloudflare.com/ai-gateway/>

## Current Config Snapshot

### 2026-07-10 D1 And Credential Update

- The top-level, `[env.staging]`, and `[env.production]` D1 binding tables now
  each set `migrations_dir = "migrations/d1"`.
- `bun run check:d1:migration-config` passes locally and proves exactly three
  `DB` bindings, a contiguous 20-migration chain, and alignment between the
  latest migration and the Worker capability constant.
- `bun run verify:sqlite` passes locally by applying all 20 migrations and
  requiring 26 tables, 56 incremental key columns, and 14 key indexes. Local
  Wrangler D1 also applied 20/20 migrations.
- Staging resource identifiers are present in `wrangler.toml`, but Wrangler was
  not authenticated during this evidence window. Their account ownership,
  existence, remote migration state, bindings, secrets, deployability, and
  runtime behavior remain unverified.
- A credential exposed during setup is compromised evidence, not a recovery
  path. Do not use it. Revoke/rotate it, authenticate Wrangler with a
  replacement least-privilege credential, and record only credential name,
  scope, owner, and rotation time.

Result: local D1/config prerequisites pass, but G1 remains **NO-GO**. No local
command or local Worker smoke substitutes for authenticated staging deploy,
remote D1 migration output, `/api/status`, capabilities, logs, or traces.

### 2026-07-14 Billing Recovery Migration Update

- The current compiled and SQLite-verified chain contains 24 migrations through
  `0024_relay_billing_finalization_events.sql`, with 29 required tables, 106
  incremental key columns, and 21 key indexes.
- Migration 0021 fails closed while any Realtime billing reservation remains
  `reserved`; disable Realtime settlement writes, reconcile the ledger to zero,
  and archive redacted evidence before applying it.
- The 2026-07-10 local Wrangler 20/20 apply remains historical evidence and
  must be refreshed through 0024. No authenticated staging apply has occurred.
- Migration 0022 adds the indexed global expiry scan, bounded retry-deferral
  metadata, and a singleton aggregate sweep status. It does not start refunds:
  `REALTIME_BILLING_ORPHAN_RECOVERY_ENABLED` remains `false` in every tracked
  environment until isolated staging passes the recovery subgate.
- Migration 0023 is additive and must be applied while the old Worker still
  serves, before publishing code that writes HTTP tiered reservations. Keep
  `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED=false`: selected positive-reserve SSE
  now has generation-fenced lease renewal, but no deployed stream has crossed
  its original lease and survived disconnect, D1-failure, restart, and recovery
  overlap fixtures. The admin-only
  `/api/platform/relay-billing/ledger/status` endpoint must be `no-store` and
  emit only hashed identities. Expired unbound fixtures may refund after grace;
  expired bound fixtures must enter `recovery_required` without quota mutation.
- All environments explicitly set the selected lease to 3600 seconds, the
  heartbeat to 900 seconds, staging verification false, and recovery false.
  Heartbeat accepts 5 seconds through one third of the effective lease and
  applies deterministic +/-10% jitter. Invalid explicit values are visible as
  invalid capabilities and must prevent a scheduled recovery sweep.
- Treat `relay_billing_stream_lease_renewal_compiled` as implementation evidence,
  `relay_billing_stream_lease_renewal_staging_verified` as deployed evidence,
  and `relay_billing_orphan_recovery_cutover_ready` as the final conjunction.
  Do not infer one from another or set the verification flag from a local test.

### 2026-07-12 Native Rate Limit Snapshot

- Top-level, staging, and production each declare
  `RELAY_TOKEN_RATE_LIMITER` (120/60s) and `RELAY_IP_RATE_LIMITER` (600/60s)
  with separate account-local numeric namespace IDs.
- Every environment explicitly sets `RELAY_RATE_LIMIT_BACKEND = "native"`.
  Binding settings, not legacy vars, are the limit authority.
- `bun run check:cf:native-rate-limits` verifies named-environment coverage,
  namespace separation, limits, periods, and the isolated Realtime local shape.
- Local workerd passed the six-scenario Realtime suite through these bindings.
  Cloudflare staging still needs 429, route-family isolation, locality/load,
  logs/Analytics Engine, and rollback evidence.

Current `wrangler.toml` is development-shaped:

- Worker name: `cinatoken-rust-api`
- Entry point: `crates/worker/build/worker/shim.mjs`
- Compatibility date: `2026-06-17`
- Compatibility flags: `nodejs_compat`
- Observability: enabled with full head sampling
- Build command: `bun tools/build_worker.mjs --release`
- `ENVIRONMENT = "development"`
- `FRONTEND_BASE_URL = "http://localhost:3000"`
- `RELAY_RATE_LIMIT_BACKEND = "native"`
- `AI_GATEWAY_ID = ""`
- `RELAY_AI_GATEWAY_ROUTER_ENABLED = "false"`
- `RELAY_MODEL_FALLBACK_ENABLED = "false"`
- `RELAY_MODEL_FALLBACKS_JSON = "{}"`
- `RELAY_MODEL_FALLBACK_STAGING_VERIFIED = "false"`
- `RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED = "false"`
- Route-specific WFP tenant AI Gateway IDs default empty:
  `AI_GATEWAY_ID_OPENAI_CHAT`, `AI_GATEWAY_ID_OPENAI_RESPONSES`,
  `AI_GATEWAY_ID_ANTHROPIC_MESSAGES`, and `AI_GATEWAY_ID_AI_RUN`
- `CLOUDFLARE_ACCOUNT_ID = ""`
- WFP/realtime flags default off or empty: `WFP_DISPATCH_ENABLED`,
  `WFP_INTERNAL_DISPATCH_ENABLED`, `WFP_PREVIEW_HOST_SUFFIX`,
  `WFP_DISPATCH_WORKER_PREFIX`, `WFP_DISPATCH_NAMESPACE`,
  `WFP_TENANT_COMPATIBILITY_DATE`, `REALTIME_SESSION_GATEWAY_ENABLED`,
  `REALTIME_SESSION_V1_ENABLED`
- Top-level D1/KV IDs and production D1/KV IDs are placeholders; staging has
  concrete-looking IDs that are not yet authenticated or remotely verified
- All three D1 binding tables explicitly use `migrations/d1`
- R2/Queue names are declared; relay audit logging and async task polling use
  Queue bindings when configured
- `CHANNEL_AFFINITY` and `REALTIME_SESSIONS` Durable Objects are declared; WFP
  `DISPATCHER` dispatch namespace blocks remain commented until the namespace
  exists

Production decision:

- Prefer migrating to `wrangler.jsonc` before production, because JSONC is the
  preferred shape for newer Workers configuration and comments.
- A TOML exception is acceptable only if the exact staging/prod config is
  validated with Wrangler, generated binding types, and dry-run/startup checks.

## Environment Layout

`wrangler.toml` now carries three explicit shapes:

| Block | Worker name | Environment | Used by |
| --- | --- | --- | --- |
| Top level (no `[env.*]`) | `cinatoken-rust-api` | `development` | `wrangler dev`, local D1, smoke tests |
| `[env.staging]` | `cinatoken-rust-api-staging` | `staging` | staging smoke, canary rehearsal |
| `[env.production]` | `cinatoken-rust-api` | `production` | customer canary and full cutover |

Top-level zero IDs and `REPLACE_WITH_PRODUCTION_*` production IDs are
intentional placeholders and must be replaced before the corresponding deploy.
The staging block currently contains concrete-looking resource IDs, but they
must not be called verified until authenticated Wrangler commands prove the
account, target resources, and remote binding state. Production deploy is gated
by G8 in `docs/production-migration-execution-plan.md`.

Promotion SOP:

1. Create the real Cloudflare resources with `wrangler d1 create`,
   `wrangler kv namespace create`, `wrangler r2 bucket create`,
   `wrangler queues create`.
2. Record the real IDs (database_id / namespace id / bucket name / queue name)
   in the release operator's private notes — never in the repository.
3. Replace the matching `REPLACE_WITH_*` placeholder in `wrangler.toml`. The
   diff is the audit trail.
4. Set secrets out of band:

   ```powershell
   wrangler secret put --env staging UPSTASH_REDIS_REST_URL
   wrangler secret put --env staging UPSTASH_REDIS_REST_TOKEN
   wrangler secret put --env staging CLOUDFLARE_API_TOKEN
   # provider keys, JWT/session, payment, OAuth, Turnstile as required by scope
   ```

5. Run the Cloudflare preflight scripts (`bun run check:cf:dry-run` and
   `bun run check:cf:startup`) once `worker-build` is installed.
6. Deploy with `wrangler deploy --env staging` (or `--env production`).
7. Verify `/api/status` reports the expected `ENVIRONMENT` and feature flags,
   then open the admin Operations -> Cloudflare Platform panel to confirm
   `/api/platform/capabilities` matches the intended binding and flag state.

## Environment Model

Use three distinct environments:

| Environment | Purpose | Traffic | Data Authority |
| --- | --- | --- | --- |
| local | Developer validation | No customer traffic | Local D1/SQLite/dev seed only |
| staging | Production-shaped verification | Internal or synthetic traffic only | Staging D1/Redis/provider keys |
| production | Customer traffic | Canary then full traffic | Production D1 after approved cutover |

Rules:

- Treat every environment block as explicit. Do not assume bindings, vars, or
  secrets carry over unless Wrangler output proves it.
- Use separate Cloudflare resource IDs for staging and production.
- Use separate Upstash databases or key prefixes for staging and production.
- Use separate provider keys when providers support it.
- Use production provider keys in staging only for approved smoke tests and only
  with safe prompts, low limits, and redacted reports.

## Config Invariants

These must be true for every deployable environment:

| Item | Requirement | Evidence |
| --- | --- | --- |
| `name` | Environment-specific Worker name or documented route separation | Wrangler deploy output |
| `main` | Points to the Worker build output | Dry-run/startup check |
| `compatibility_date` | Current enough for the release; reviewed before prod deploy | Date review note |
| `compatibility_flags` | Includes `nodejs_compat` | Wrangler config and generated types |
| `observability` | Enabled with environment-specific sampling policy | Logs/traces visible |
| Build command | Produces Worker shim reproducibly | `bun run check:cf:dry-run` |
| Binding names | Match Worker code and generated types exactly | `wrangler types` output |
| D1 migration directory | Every D1 binding table sets `migrations_dir = "migrations/d1"` | `bun run check:d1:migration-config` |
| Secrets | Set out of band, never under `vars` | Secret inventory without values |
| Dev URLs | No localhost or development origins in production | Config review |
| Placeholder IDs | No zero/placeholder IDs in staging/prod | Config review |
| Cloudflare service access | Use bindings instead of Cloudflare REST API from Worker | Code review |

## Binding Checklist

| Binding | Local | Staging Required | Production Required | Owner | Evidence |
| --- | --- | --- | --- | --- | --- |
| `DB` D1 | Local D1 or SQLite smoke | Real staging D1 ID | Real production D1 ID | Platform/Data | Migrations applied, `/api/status` D1 true |
| `CACHE_KV` | Optional | Real namespace or removed | Real namespace or removed | Platform | Binding decision and generated types |
| `CONFIG_KV` | Optional | Real namespace or removed | Real namespace or removed | Platform | Binding decision and generated types |
| `FILE_BUCKET` R2 | Optional | Real bucket if task/file features enabled | Real bucket before task/file cutover | Platform/Tasks | R2 smoke and retention policy |
| `LOG_QUEUE` | Optional | Real queue once queue producer is enabled | Real queue plus consumer/DLQ | Platform/SRE | Queue smoke, DLQ alert |
| `BILLING_QUEUE` | Default-off | Separate staging producer/consumer/DLQ; keep gate false until migration and readback pass | Separate production producer/consumer/DLQ; never reuse staging DLQ | Platform/Billing/SRE | `bun run check:cf:billing-queue`, authenticated create/readback, duplicate/retry exhaustion, DLQ alert, reconcile/rollback drill |
| `TASK_QUEUE` | Optional | Real queue once async task flow is enabled | Real queue plus consumer/DLQ | Platform/Tasks | Queue smoke, replay test |
| `EMAIL` send_email | Optional | Required for email verification/reset smoke | Required before enabling `EmailVerificationEnabled` or password reset in production | Platform/Auth | Verified sender, `SMTPFrom`/`SMTPAccount` option, send-code/reset smoke |
| AI Gateway | Optional | Real ID or direct-provider decision | Real ID or direct-provider decision | Relay | Provider matrix decision |
| Static assets or Pages | Optional | Required before G5 frontend smoke | Required before Scenario B/C frontend cutover | Frontend/Platform | SPA fallback, API route precedence, bundle redaction smoke |
| Service bindings | Optional | Use for Worker-to-Worker calls if split | Same | Platform | Binding type and smoke |
| `CHANNEL_AFFINITY` Durable Object | Optional | Required before channel-affinity canary | Same | Relay/Platform | Migration entry, affinity smoke, fail-open smoke |
| `REALTIME_SESSIONS` Durable Object | Optional | Required before realtime/session cutover | Same | Platform/Relay | Migration entry, `bun run smoke:realtime-session` hibernation WebSocket smoke, restored attachment + persisted metrics smoke, unsupported-control no-echo probe, protocol bridge smoke |
| `WFP_AUTHORITY_REPLAY` Durable Object | Optional until WFP canary | Required before any paid WFP tenant route | Required before WFP cutover | Platform/Security | `v4-wfp-authority-replay` migration, main script/class plus outbound external-binding readback, tenant binding absence, sequential/concurrent duplicate rejection, eviction and cleanup smoke |
| `DISPATCHER` WFP dispatch namespace | Optional | Required before tenant/preview WFP traffic | Required before WFP cutover | Platform | Namespace created, binding uncommented, tenant script plan/deploy smoke, admin-authenticated `bun run smoke:wfp-dispatch -- --expect-runtime rust-wasm` status/route smoke |
| `RELAY_TOKEN_RATE_LIMITER`, `RELAY_IP_RATE_LIMITER` | Declared and locally replayed | Declared; authenticated runtime verification required | Declared; G8 deploy still blocked | Platform/Security | `bun run check:cf:native-rate-limits`, `/api/status`, route-family 429 and Analytics Engine/log evidence |
| Workflows | Optional | Required before multi-step async cutover | Required before multi-step async cutover | Platform/Tasks | Workflow smoke and retry test |
| Containers | Optional | Required before any WASM-incompatible/long-running fallback path | Same | Platform | Container build, Worker->Container smoke |
| Secrets Store | Optional | Recommended for shared provider/payment secrets | Recommended | Security/Platform | Store binding, rotation audit |

## External Service Checklist

| Service | Stored In | Staging Required | Production Required | Owner | Evidence |
| --- | --- | --- | --- | --- | --- |
| WeChat Server | D1 `options`: `WeChatAuthEnabled`, `WeChatServerAddress`, `WeChatServerToken`, `WeChatAccountQRCodeImageURL` | Required before WeChat QR/code smoke | Required before enabling `WeChatAuthEnabled` in production | Auth/Platform | Public HTTPS URL, no query/fragment, token set, QR image visible, code exchange/login/bind smoke, disabled/missing-code/expired-code negative tests |

## 2026-06-25 Native Primitive And Canary Updates

These supersede earlier Upstash-first / Pages-first / VPS-fallback assumptions.
Authoritative rationale: `docs/cinatoken-rust-migration-plan.md` §21.

| Item | Requirement | Evidence |
| --- | --- | --- |
| Rate limiting | Workers Rate Limiting binding per environment; no `ct:rate:*` Upstash keys on the hot path | Binding config, 429 Analytics Engine data point |
| Hot atomic state | Durable Object namespace for round-robin index, concurrency caps, channel breaker, locks | DO migration entry, contention smoke |
| D1 reads | Sessions API enabled; read-your-writes bookmark on write-then-read admin paths | Replica read smoke, bookmark test |
| D1 size | Per-db 10 GB budget tracked; logs/history archived to R2/Analytics Engine; sharding plan if approaching cap | Storage forecast, archive job |
| Frontend | Workers Static Assets from the same Worker (one origin); no separate Pages project | `[assets]` config, SPA fallback smoke |
| Native fallback | Cloudflare Containers (not VPS) for WASM-incompatible/long-running workloads | Container config, Worker->Container smoke |
| Async/payments | Workflows for durable task/payment orchestration; Queues for log fan-in only | Workflow + queue smoke |
| Canary | Workers gradual deployments (version %) + token-group gating; instant version rollback | Gradual-deploy config, rollback rehearsal |
| Secrets sharing | Secrets Store for provider/payment secrets shared across Worker + Container | Store binding, rotation audit |
| Compatibility date | Reviewed and bumped on a quarterly cadence, not only at prod deploy | Date review note in this file |

Compatibility-date cadence: review `compatibility_date` every quarter (next due
2026-09). Bump deliberately, re-run dry-run/startup checks, and record the date
review note here rather than discovering drift at cutover.

## Secret Inventory

Track names, not values.

| Secret Group | Example Secret Names | Required For | Rotation Evidence |
| --- | --- | --- | --- |
| Upstash | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional read-through cache and legacy compatibility only | Staging/prod secret dates or explicit removal decision |
| Provider smoke | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, provider-specific names | Live relay smoke | Low-risk key policy |
| Payment | Stripe/Creem/Waffo/Epay webhook and API secret names | Payment cutover | Webhook replay test |
| OAuth | GitHub/Discord/OIDC/custom provider secret names | Auth cutover | State/replay test |
| Session/JWT | Session signing/encryption secret names | Admin/frontend cutover | Forced re-auth decision |
| Turnstile | Turnstile secret names | Public auth/forms | Staging challenge test |
| Admin bootstrap | Initial root/admin secret name | Operator bootstrap | Rotation after first login |
| Cloudflare platform | `CLOUDFLARE_API_TOKEN` | WFP tenant script deploy API | Scoped token, deployment smoke, rotation date |

Rules:

- Use Wrangler/Cloudflare secret facilities for deployed environments.
- Use `.dev.vars` or `.env` only for local development and keep them ignored.
- Do not commit `.dev.vars*`, `.env*`, exports, smoke payloads, or screenshots
  that contain secrets.
- Frontend build-time configuration must contain only public values. Public
  names such as a Turnstile site key are allowed; API keys, webhook secrets,
  OAuth client secrets, session secrets, and provider keys are not.
- Rotate any key that appears in logs or a smoke report.

## Exact Worker Env Vars (source of truth)

The groups above are intentionally generic. The names below are the **exact**
identifiers the Worker reads from `crates/worker/src/*.rs` as of the auth/security
+ usage cutover. Each is read **`secret(NAME)` first, then `var(NAME)`** — set the
secret halves with `wrangler secret put --env <env> NAME`; the public halves
(client IDs, URLs) may be plaintext `[env.*.vars]`. A feature whose vars are unset
is **inert** (the endpoint returns "not configured"), so partial enablement is
safe.

Platform/WFP and relay feature flags are the exception: they are plain vars,
not secret-first settings.

| Var | Kind | Feature | Notes |
| --- | --- | --- | --- |
| `SESSION_SECRET` | secret | Session cookie HMAC | Required for any login; rotating it forces re-auth |
| `FRONTEND_BASE_URL` | var | OAuth redirect target | Must be the real frontend origin in staging/prod, not `localhost` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | id=var, secret=secret | GitHub OAuth | Both required or GitHub login is inert |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_TOKEN_URL` / `OIDC_USERINFO_URL` / `OIDC_REDIRECT_URI` / `OIDC_AUTHORIZATION_ENDPOINT` | ids/URLs=var, secret=secret | Generic OIDC (incl. Google) | First five configure the callback; the authorization endpoint must come from the env var or migrated D1 `oidc.authorization_endpoint` before the frontend advertises OIDC |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_REDIRECT_URI` | id/URI=var, secret=secret | Discord OAuth | All three required or Discord login is inert |
| `TURNSTILE_SECRET` | secret | Turnstile verification | Unset ⇒ Turnstile checks are skipped (no-op), per `require_turnstile` |

### Relay feature flags (default OFF — behavior/charge-affecting)

These are plain `vars` parsed truthy on `"true"` or `"1"`; **absent ⇒ off**.
Each is off by default precisely because flipping it changes upstream behavior or
billing, so it is a staging-gated cutover, not a deploy-time default.

| Flag | Effect when on | Risk class |
| --- | --- | --- |
| `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` | On missing/invalid upstream usage, estimate completion tokens and **bill** (Go parity) instead of refunding to zero | charge-affecting |
| `RELAY_STREAM_OPTIONS_INJECT_ENABLED` | Inject `stream_options.include_usage=true` for supported streaming channels (strip it for unsupported) so the upstream emits real usage | behavior-affecting |
| `RELAY_CHANNEL_KEYWORD_BAN_ENABLED` | Auto-disable a channel when an upstream error body matches the auto-ban keyword list | behavior-affecting |
| `RELAY_CHANNEL_AFFINITY_ENABLED` | Use the `CHANNEL_AFFINITY` Durable Object for sticky channel selection | requires the DO binding |

Enable order (per flag): deploy with it **off** → smoke the off path → flip it on
in **staging** only → re-smoke (verify billing/usage and audit `usage_source`) →
then arm it in production. Never flip a charge-affecting flag straight to prod.

### Platform feature flags (default OFF)

These flags expose platform-level traffic routing and stateful WebSocket
surfaces. Keep them off until the matching binding exists and staging smoke is
captured.

| Flag | Effect when on | Required binding/evidence |
| --- | --- | --- |
| `WFP_DISPATCH_ENABLED` | Enables the Rust dispatch Worker pre-router for tenant/preview traffic | `DISPATCHER` dispatch namespace, admin-authenticated `bun run smoke:wfp-dispatch -- --expect-runtime rust-wasm` route smoke for internal paths proving controlled `inbound_dispatch_route=internal-path` |
| `WFP_RELAY_TRANSPORT_ENABLED` | Allows an already authenticated, D1-selected, and quota-reserved central relay request to use the channel's `channels.other_info.wfp_worker` as its outbound transport | Default `false` in every environment; signed-authority rejection tests, replay DO binding/readback and live duplicate race, strict Rust/Wasm upload/readback, and staging reserve/settle/refund/audit canary |
| `WFP_PREVIEW_HOST_SUFFIX` | Maps `{tenant}.{suffix}` hostnames to dispatch namespace worker names | DNS/route review, tenant-name validation |
| `WFP_INTERNAL_DISPATCH_ENABLED` | Enables `/api/platform/dispatch/:worker/...` as an admin-only internal dispatch test path | Admin-authenticated `bun run smoke:wfp-dispatch -- --expect-runtime rust-wasm` status smoke with empty `inbound_sensitive_headers`, `inbound_dispatch_route=internal-path`, matching `inbound_dispatch_worker` and `x-cinatoken-wfp-runtime`, plus unauthenticated 401/403 check; keep off in production unless explicitly needed |
| `WFP_DISPATCH_WORKER_PREFIX` | Prefixes sanitized tenant names before `DISPATCHER.get()` | Naming convention and collision review |
| `REALTIME_SESSION_GATEWAY_ENABLED` | Enables `/api/platform/realtime/:session...` -> `REALTIME_SESSIONS` DO forwarding | `REALTIME_SESSIONS` binding plus `bun run smoke:realtime-session` status/control smoke proving restored attachments, persisted lifecycle metrics, and unsupported-control no-echo behavior; not a `/v1/realtime` cutover by itself |
| `REALTIME_SESSION_V1_ENABLED` | Requests the OpenAI-compatible `/v1/realtime` WebSocket entry after relay-token auth/model/rate-limit checks; the route still fails closed unless settlement writes are enabled | Upstream Realtime bridge, billing/audit settlement, hibernation/resume smoke, persisted metrics smoke, unsupported-control no-echo smoke, and live protocol replay with `bun run smoke:realtime-session -- --mode v1`; keep off until G7 approval |
| `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED` | Permits Realtime D1 quota/replay/audit settlement and allows the public v1 route to proceed past its billing interlock | Isolated staging D1 only until idempotent pre-reserve/refund, per-response replay identity, two-response settlement, bounded alarm retry, rollback, and no-double-charge evidence pass; explicitly false in default/staging/production config |
| `REALTIME_BILLING_RESERVATION_LEASE_SECONDS` | Plain non-secret var that bounds how long a newly created per-response reservation may remain unsettled before the Durable Object's shared alarm attempts an idempotent D1 refund | Default and minimum `900`; accepted range `900..3600`; missing, unparsable, or out-of-range values fall back to `900`. The minimum is the 840-second bridge lifetime plus a mandatory 60-second close/clock-skew margin, preventing a live response from being refunded before its terminal usage arrives. Changes do not rewrite persisted deadlines. Archive the capability value, prove a not-yet-due lease is untouched and an expired lease refunds once after eviction/restart, and alert on repeated refund attempts before production canary. Expiry refunds continue when the settlement write gate is off |
| `REALTIME_BILLING_ORPHAN_RECOVERY_ENABLED` | Allows the scheduled Worker to scan globally orphaned Realtime reservations after the settlement grace deadline | Default `false` in default/staging/production. Enable only after 0022 exact-set readiness, isolated-staging accounting snapshots, concurrent schedule proof, failed-head fairness, alerting, and rollback rehearsal. Disable immediately to stop new global refund attempts; terminal CAS results remain authoritative. |
| `REALTIME_BILLING_ORPHAN_SWEEP_LIMIT` | Bounds candidates handled before the shared task pollers run | Default `32`, accepted `1..64`, invalid values fall back to 32. The defensive maximum preserves D1 query/subrequest headroom for per-candidate guarded batches and the other cron workloads; raise only from measured rows-read/query-count evidence. |
| `REALTIME_BILLING_RECONCILIATION_ENABLED` | Allows the root step-up 0028 operator workflow to apply a revision-fenced settle/refund decision | Default `false` in default/staging/production. Enable only for an isolated drill after remote 0028 readback, dual-control approval, frozen-expression preview validation, D1 rollback injection, invoice reconciliation, and alert ownership. Disable before traffic rollback. |
| `REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED` | Immutable release-evidence assertion used by Realtime reconciliation and v1 cutover capabilities | Default `false` in default/staging/production. It is not a runtime enable switch. Set only in a reviewed candidate after the full operator, concurrency, accounting, invoice, alert, retention, and rollback matrix is archived; code presence, local tests, or enabling mutation cannot satisfy it. |

### WFP tenant artifact, relay authority, and outbound service

The root-only plan route may report redacted artifact requirements, but the
Worker-side deploy route is disabled. The generated JavaScript fallback is
status-only and is not a production AI runtime. Build `crates/wfp-tenant` with
`bun run build:wfp-tenant`, then use only the strict Rust/Wasm artifact uploader
behind `bun run deploy:wfp-tenant`. The uploader consumes the current
`worker-build` runtime artifact from `crates/wfp-tenant/build`, with `index.js`
as the multipart main module; `build/worker/shim.mjs` remains Wrangler-only
compatibility glue. It rejects a missing/empty main module, a
missing or invalid Wasm module, an incomplete import graph, and any retired
tenant Cloudflare-token flag.

The official Workers for Platforms Scripts REST API documents the dispatch
namespace script upload and readback endpoints:
<https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/>.
Cloudflare's Worker guidance also recommends explicit secret handling and
request-boundary validation:
<https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>.
The authoritative egress and upstream route references are Cloudflare's
[Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
configuration and
[AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

The dispatch namespace must attach service `cinatoken-wfp-outbound` as its
outbound Worker. That service permits only `POST application/json` with valid
JSON up to 4 MiB to the exact account-scoped `/ai/run`,
`/ai/v1/chat/completions`, `/ai/v1/responses`, and `/ai/v1/messages` URLs. It
injects authentication, rebuilds request/response headers from allowlists, and
blocks redirects. Its tracked Wrangler config explicitly disables workers.dev
and Preview URLs and declares no public route. A deploy is not accepted until
remote readback also proves zero Custom Domains and an account-wide Zone-route
inventory proves no route targets this service.

| Var/secret | Kind | Required for | Notes |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | var | Tenant script plan/deploy URL and runtime AI Gateway calls | Plain account identifier; may be left empty until WFP staging |
| `CLOUDFLARE_API_TOKEN` | secret | Dispatch namespace Rust/Wasm script upload/readback only | Never commit; use a least-privilege deploy token and do not attach it to the tenant runtime |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | secret | Main-relay AI Gateway REST runtime token once the router is canaried | Required as a dedicated scoped runtime credential. The relay and capability probe reject a configuration that has only `CLOUDFLARE_API_TOKEN`; deploy/readback credentials are never runtime fallbacks |
| `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` | outbound Worker secret | AI Gateway REST authentication for `cinatoken-wfp-outbound` | Required only on the outbound service; never attach to a tenant, dispatch Worker, upload manifest, log, or evidence artifact; do not reuse the dispatch deploy token |
| `CINATOKEN_WFP_OUTBOUND_AUTH_MODE` | tenant plain-text var | Declares platform-owned outbound auth | Must equal `platform-outbound-v1`; this marker replaces tenant runtime Cloudflare tokens and carries no credential |
| `WFP_RELAY_AUTHORITY_SECRET` | platform Worker secret | Central-authority v3 signing and platform replay verification | Master secret, minimum 32 bytes; retained only by the main Worker script and its DO; never make it available to an uploader, tenant, outbound Worker, manifest, log, or evidence artifact |
| `CINATOKEN_WFP_OUTBOUND_CONTEXT` | dispatch outbound parameter | Bind route kind plus public and dispatched worker identity to final egress | The dispatch attachment declares exactly this one parameter; the main Worker supplies it in the Dynamic Dispatch third argument; it is not a tenant binding or credential |
| `WFP_AUTHORITY_REPLAY` | Durable Object binding | One-time central-authority consumption before bearer access | Main Worker owns the class and master verifier; each outbound environment binds the matching main script externally. The tenant must have no replay binding. Missing/error fails paid AI closed |
| `WFP_DISPATCH_NAMESPACE` | var | Tenant script upload target | Must match the commented `DISPATCHER` namespace once WFP is armed |
| `WFP_TENANT_COMPATIBILITY_DATE` | var | Generated tenant Worker metadata | Defaults to `2026-07-11`, matching the tracked main and tenant Worker production date |
| `WFP_TENANT_OBSERVABILITY_HEAD_SAMPLING_RATE` | uploader environment or `--observability-head-sampling-rate` | Generated tenant Worker metadata | Must be greater than 0 and at most 1. The uploader defaults production-shaped plans to `0.1`; staging evidence must pass `1` explicitly |
| `AI_GATEWAY_ID` | outbound Worker var | Optional platform-owned default `cf-aig-gateway-id` header | Configure on `cinatoken-wfp-outbound`, never on the tenant; empty means the account path has no explicit Gateway ID |
| `RELAY_AI_GATEWAY_ROUTER_ENABLED` | var | Main relay AI Gateway REST router gate | Must stay `false` until channel-editor-created `channels.other_info.ai_gateway.enabled` canary metadata, provider-prefix policy, key/base-url coupling, same-channel direct fallback smoke, billing settlement, forwarder smoke, and staging panel evidence are approved |
| `RELAY_MODEL_FALLBACK_ENABLED` | var | Independent Rust primary-to-fallback model gate | Default `false`; requires the AI Gateway router, opted-in primary/fallback channels, supported chat/Responses/Messages route, a validated mapping, `relay_ai_gateway_cross_model_actual_group_billing_compiled=true`, and archived fixed/`auto` staging D1 evidence for maximum reservation plus actual-serving-group settlement/refund |
| `RELAY_MODEL_FALLBACKS_JSON` | var | Exact JSON object from requested primary model to one AI-Gateway-prefixed fallback model | Default `{}`; maximum 128 mappings and 200 characters per model name; never use a silent wildcard or secret value |
| `RELAY_MODEL_FALLBACK_STAGING_VERIFIED` | var | Production cutover evidence marker | Keep `false` until archived staging proves primary server failure, served fallback identity, token denial, channel reselection, exactly-one reserve/refund/settlement, audit metadata, streaming boundary, and rollback |
| `RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED` | var | Messages-specific fallback cutover evidence marker | Default `false`; requires independent `/v1/messages` logical/effective schema mismatch, full D1 candidate selection, sticky 401/403/429 veto, non-stream/stream, billing, audit, and rollback evidence. Overall fallback cutover requires this and the general marker |
| `ALI_SYNC_IMAGE_MODELS` | var | Optional Ali synchronous image model-pattern override | Empty/unset uses the audited Go defaults. A non-empty comma-separated value replaces them consistently in candidate filtering, Admin Channel Test, and native request conversion; at most 32 non-empty patterns of at most 128 bytes are considered. Freeze and hash the production value with the Go `SyncImageModels` setting before canary. |
| `RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED` | var | Admin-only actual-serving-group D1 Worker-binding smoke | Default `false` in every environment. Enable only against isolated non-production D1 for the three fixed smoke scenarios; require the three `relay_ai_gateway_actual_group_billing_staging_smoke_*` capabilities, strict PASS reports, and `cleanupVerified=true`, then disable again. This flag is not a fallback cutover marker. |
| `AI_GATEWAY_ID_OPENAI_CHAT` | outbound Worker var | Optional platform Gateway override for `/v1/chat/completions` | Overrides `AI_GATEWAY_ID` for this route only; never a tenant binding |
| `AI_GATEWAY_ID_OPENAI_RESPONSES` | outbound Worker var | Optional platform Gateway override for `/v1/responses` | Overrides `AI_GATEWAY_ID` for this route only; never a tenant binding |
| `AI_GATEWAY_ID_ANTHROPIC_MESSAGES` | outbound Worker var | Optional platform Gateway override for `/v1/messages` | Overrides `AI_GATEWAY_ID` for this route only; never a tenant binding |
| `AI_GATEWAY_ID_AI_RUN` | outbound Worker var | Optional platform Gateway override for `/ai/run` | Overrides `AI_GATEWAY_ID` for this route only; never a tenant binding |
| `AI_GATEWAY_REQUEST_TIMEOUT_MS` | outbound Worker var | Optional platform `cf-aig-request-timeout` header | Integer 1-600000 milliseconds; tenant input is discarded |
| `AI_GATEWAY_MAX_ATTEMPTS` | outbound Worker var | Platform `cf-aig-max-attempts` header | Integer 1-10; tracked environments pin 1 for central exactly-one-attempt canaries |
| `AI_GATEWAY_RETRY_DELAY_MS` | outbound Worker var | Optional platform `cf-aig-retry-delay` header | Integer 0-60000 milliseconds |
| `AI_GATEWAY_BACKOFF` | outbound Worker var | Optional platform `cf-aig-backoff` header | `constant`, `linear`, or `exponential` |
| `AI_GATEWAY_CACHE_TTL_SECONDS` | outbound Worker var | Optional platform `cf-aig-cache-ttl` header | Non-negative integer seconds |
| `AI_GATEWAY_SKIP_CACHE` | outbound Worker var | Optional platform `cf-aig-skip-cache` header | `true` or `false`; useful for staging/provider parity smoke |
| `AI_GATEWAY_COLLECT_LOG` | outbound Worker var | Platform `cf-aig-collect-log` header | `true` or `false`; tracked environments keep it true for evidence collection |

Smoke order:

1. Keep `WFP_RELAY_TRANSPORT_ENABLED=false`. Provision the platform-only
   `WFP_RELAY_AUTHORITY_SECRET`, a least-privilege dispatch deploy/readback
   token, and `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` only on service
   `cinatoken-wfp-outbound`. Never bind either platform secret or any Cloudflare
   bearer into a tenant Worker.
2. Run the WFP tenant checks and `bun run build:wfp-tenant`; archive the strict
   dry-run manifest from `tools/deploy_wfp_tenant_artifact.mjs`, including every
   module hash and the validated Wasm import graph. Staging must pass
   `--observability-head-sampling-rate 1`; production-shaped plans default to
   `0.1`. Verify the manifest binds
   `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1` and contains neither
   `CF_API_TOKEN` nor any equivalent Cloudflare bearer, authority key/master,
   or replay DO binding.
3. Build and deploy `cinatoken-wfp-outbound` with its staging environment,
   attach it to the staging dispatch namespace with environment `staging` and
   exactly one `CINATOKEN_WFP_OUTBOUND_CONTEXT` parameter, and archive readback
   proving service/environment/parameter identity, account ID, outbound-only
   secret ownership, and the external `WFP_AUTHORITY_REPLAY` binding to class
   `WfpAuthorityReplay` on the exact staging main Worker. Then run the strict
   tenant uploader with only its deploy token. Tenant readback must reject
   `WFP_RELAY_AUTHORITY_KEY`, `WFP_RELAY_AUTHORITY_SECRET`, and
   `WFP_AUTHORITY_REPLAY`. Archive the redacted PUT result and a GET
   content/metadata readback that matches the dry-run artifact hashes,
   compatibility settings, and enabled nonzero observability policy. Do not use
   `/api/platform/wfp/tenant-script/deploy`; it is intentionally disabled.
   Run `bun run check:wfp-tenant:readback-collector`, then set only a rotated,
   read-scoped `CINATOKEN_WFP_READBACK_TOKEN` and collect the official Details,
   Settings, and Content APIs with both confirmations:

   ```powershell
   bun run collect:wfp-tenant:readback -- --account-id <account> --namespace <namespace> --script-name <worker> --confirm-readback --confirm-replacement-token > wfp-readback.json
   ```

   The schema-3 collector rejects redirects, deployment drift, disabled or
   mismatched observability, malformed or oversized multipart content, and
   credential echoes. It does not accept a token on the
   command line and does not read legacy/general Cloudflare token variables.
   Before the tenant verifier, run the independent outbound-attachment
   collector self-test and capture the dispatch namespace plus both platform
   Workers through Cloudflare's official namespace, script settings, script
   secrets, script subdomain, and Worker Domains read APIs: [dispatch namespaces](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/),
   [script settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/),
   [script secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/),
   [script subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/),
   and [Worker Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/).

   ```powershell
   bun run check:wfp-outbound:readback-collector
   bun run collect:wfp-outbound:readback -- --account-id <account> --namespace <namespace> --dispatcher-script <main-worker> --outbound-script cinatoken-wfp-outbound --outbound-environment staging --confirm-readback --confirm-replacement-token > wfp-outbound-readback.json
   ```

   The command reads only the rotated `CINATOKEN_WFP_READBACK_TOKEN`; it accepts
   no credential argument and writes no files itself. A successful
   `verified=true` document proves the namespace stayed untrusted and stable,
   the exact `DISPATCHER` binding points to the requested namespace and
   `cinatoken-wfp-outbound`, its expected environment, and the exact single
   outbound context parameter. The outbound service must have the exact account
   var, bearer secret, and environment-correct external replay binding, while
   deploy/readback bearers remain absent. Schema 3 also requires workers.dev and
   Preview URLs disabled and zero Custom Domains. For Wrangler named
   environments, script Settings/Secrets/Subdomain and Domains readback targets
   the physical `<service>-<environment>` script while the dispatch attachment
   remains the logical service plus environment pair.
   It emits secret names, never values. Separately enumerate all Zones and
   Worker routes with the rotated credential and fail if any route names
   `cinatoken-wfp-outbound`; the service-filtered Domains API does not prove
   Zone-route absence. This is attachment, ownership, and public-ingress
   evidence only; it does not exercise tenant egress or prove that an AI bearer
   is valid.
   Feed the uploader JSON, Cloudflare details/settings/content capture, and live
   dispatch JSON into `bun tools/verify_wfp_post_upload.mjs`. Archive a single
   `verified=true` result with
   `verificationScope=wfp-tenant-artifact-and-status`,
   `paidEgressVerified=false`, and `productionVerified=false`; the verifier
   recomputes module hashes and rejects script, module, binding, compatibility,
   observability, readback, or status-dispatch drift. Run
   `bun run check:wfp-tenant:post-upload-verifier` locally before collecting
   remote evidence.
4. Enable only the gates needed for an admin-authenticated status probe. Confirm
   `/api/platform/dispatch/:worker/__cinatoken/tenant/status` reaches the
   Rust/Wasm runtime, while every admin AI path, preview-host AI path, and
   `/v1/embeddings` attempt is rejected. Status/readback must report the exact
   outbound auth mode and no tenant Cloudflare token.
5. Seed an isolated staging channel with
   `channels.other_info.wfp_worker=<worker>`, enable
   `WFP_RELAY_TRANSPORT_ENABLED` for the canary, and call one retained AI route
   through the normal public relay token boundary. Do not call a tenant AI route
   through the admin dispatch endpoint. Before enabling the gate, require a
   fixed non-`auto` group with one candidate channel, `RELAY_RETRY_TIMES=0`,
   cross-model fallback disabled, outbound `AI_GATEWAY_MAX_ATTEMPTS=1`, and both
   outbound attachment and tenant artifact/status readbacks. Run
   `check:wfp-outbound:egress-contract` and `check:wfp-outbound:egress-plan`,
   then execute `smoke:wfp-outbound-egress` once per route. Live mode uses the
   reviewed staging host and fixed models/bodies; it accepts credentials only
   from `CINATOKEN_WFP_EGRESS_SMOKE_TOKEN` and
   `CINATOKEN_WFP_EGRESS_SMOKE_ADMIN_COOKIE`.
6. Archive authority and invocation-context rejection cases for missing or
   tampered signature, wrong public/dispatch worker, route kind, method, final
   path, body, or channel, stale/expired time, and non-canonical replay-object
   selection. Require zero provider calls for every negative case.
   Submit the same otherwise-valid envelope sequentially and concurrently;
   require exactly one winner and `409` for every duplicate, including after DO
   eviction or Worker redeploy. Measure bucket latency, throughput, storage,
   and alarm cleanup. For the accepted request, prove one provider call, one D1
   channel selection and reserve, then exactly one central settlement or refund
   and the matching audit record. Disable the transport gate after smoke.
7. Archive outbound-policy negatives for non-POST, non-JSON/invalid JSON, body
   over 4 MiB, wrong scheme/host/account/path, query/fragment, caller auth/cookie
   headers, and redirects. Archive one positive request for each exact allowed
   AI REST route and prove only the outbound Worker injected authorization.

No staging upload, outbound-service attachment capture, tenant binding readback,
signed-authority billing canary, live egress request, or live replay race is
claimed by this checklist; those are still required production evidence. The
post-upload verifier proves evidence consistency only when fed real remote
captures; its self-test proves only the contract shape. Production is
**NO-GO**.

### Migration prerequisite

2FA endpoints (`/api/user/2fa/*`, `/api/user/login/2fa`, `/api/verify` with
`method:"2fa"`) require **`migrations/d1/0006_two_fa.sql`** applied to the target
D1 (`two_fa` + `two_fa_backup_codes`). Apply the full ordered set `0001`→`0006`
before the auth smoke.

### Async-task system (video / suno / mj)

The task pipeline (`/v1/video/generations`, `/suno/submit/:action`,
`/mj/submit/:action` + the cron poller) needs:

| Item | Requirement |
| --- | --- |
| Migrations | Apply through **`0007_midjourneys.sql`** (the mj subsystem's own table); the `tasks` table is in `0001`. |
| Cron trigger | `[env.*.triggers] crons = ["* * * * *"]` (added to wrangler.toml) drives the `#[event(scheduled)]` poller. Inert with no in-flight tasks; **required** for any task to settle. |
| `TASK_QUERY_LIMIT` | var, default `100` in Worker envs - bounded per-family provider poll window for video, Suno, and Midjourney. Keep conservative until provider replay and subrequest capacity are measured. |
| `TASK_TIMEOUT_MINUTES` | var, default `1440` - Go-compatible timeout sweep runs before normal polling; set `0` only for emergency diagnostics because stuck rows can otherwise starve newer work. |
| `TASK_RUNNER_DO_ENABLED` | var, default `false` - optional per-task Durable Object alarm fast path. Keep disabled until staging alarm replay, replay-evidence classifier output, rollback, cron fallback, and no-double-poll CAS evidence are archived. |
| `TASK_RUNNER_STAGING_REPLAY_VERIFIED` | var, default `false` - operator cutover guard. Set true only after archived staging evidence proves flag-on arming, alarm fire, provider poll, CAS win/replay no-op, cron fallback, and rollback. |
| `TASK_RUNNER_MAX_ALARM_FIRES` | var, default `20`, clamped to `1..240` - maximum per-task alarm fires before the optional fast path records `fast_path_horizon_exhausted` and returns ownership to the minute cron sweeper. |
| `GEMINI_VERSION` | var, default `v1beta` — Gemini/Veo API version. |
| `VERTEX_REGION` | var, default `us-central1` — Vertex region for `predictLongRunning` (per-channel region edge cases TBD on staging). |
| Channel types | Each provider is a channel `type`: Ali=17, Gemini=24, MiniMax/Hailuo=35, SunoAPI=36, VertexAi=41, VolcEngine=45, Kling=50, Jimeng=51, Vidu=52, DoubaoVideo=54, Sora=55/OpenAI=1; Midjourney=2/5. A task model with no matching enabled channel returns 503. |
| Channel keys | Provider-specific: bearer key (sora/doubao/ali/hailuo/suno), `Token` (vidu), `mj-api-secret` (mj), `accessKey\|secretKey` (kling JWT / jimeng SigV4), or the **service-account JSON** (vertex). |
| Pricing | Task billing models are `suno_<action>`, `mj_<action>`, or the video model name. Missing fixed and ratio configuration fails closed before provider I/O. |

| Capability probe | `/api/platform/capabilities` must show the Task poller/TaskRunner compiled fields, `task_v2_contract_version=1`, `task_v2_ownership_compiled=true`, `task_v2_schema_ready=true`, and `task_v2_runtime_ready=true`, while `task_v2_staging_verified=false`, `task_v2_cutover_ready=false`, and `task_runner_cutover_ready=false` before async task canary. `task_runner_cutover_ready` is only the fast path and cannot replace Task v2 financial readiness. Run `python tools/verify_sqlite.py`, `bun run check:task-refund-batch`, `bun run check:task-runner:alarm-replay-contract`, `bun run check:task-runner:alarm-replay-plan`, and `bun run check:do-lifecycle-runtime` locally and attach their output before staging D1 replay. |

### QuotaCoordinator shadow observer

| Item | Requirement |
| --- | --- |
| `QUOTA_COORD` | SQLite-backed, per-token Durable Object binding for tiered-expression shadow state only. It is not financial authority, and no public route may expose its internal observe/status endpoints. |
| `QUOTA_COORD_SHADOW_ENABLED` | Plain var, default `false`. Open last, only after producer audit, retention approval, and bounded token scope. Closing it is the first rollback action. |
| `QUOTA_COORD_SHADOW_TOKEN_IDS` | Plain comma-separated canonical positive token IDs, default empty and capped at 64. Populate only with isolated staging tokens after retention approval; duplicates, malformed values, zero, and leading zeroes invalidate the entire scope. |
| `QUOTA_COORD_RETENTION_VERIFIED` | Plain var, default `false`, enforced by the producer as a runtime hard gate. Set true only from reviewed long-lived-token size/load/compaction evidence; local tests and binding presence are insufficient. |
| `QUOTA_COORD_STAGING_VERIFIED` | Plain var, default `false`. It is an evidence marker for a bounded zero-diff staging bake and must never be set from local tests, binding presence, or a direct DO smoke. |
| Capability probe | Require foundation, binding, reserve/finalization/recovery producer coverage, tiered-only scope, token allowlist validity/count, retention, no-write-authority, staging bake, runtime readiness, and cutover separately. Producer coverage may be true while runtime and cutover remain false. |
| Local config evidence | `bun run check:cf:quota-coordinator` proves all four producer families are present, all three environments declare the same v6 SQLite class, retention/shadow/proof flags are false, and token scope is empty. It is not staging or financial parity evidence. |
| Storage/load gate | The foundation serializes one bounded state value. Before enabling shadow, measure default and worst-case bytes, CPU, and latency under long-lived hot-token load; retain operational headroom below Cloudflare's [SQLite-backed DO 2 MiB combined key/value limit](https://developers.cloudflare.com/durable-objects/platform/limits/), and define compaction plus saturation alerts. Capacity conflict is a blocker, not successful shadow evidence. |

## Observability Checklist

Detailed sampling, dashboard, alert, SLO, and redaction gates are tracked in
`docs/observability-slo-security-runbook.md`.

| Area | Staging Requirement | Production Requirement |
| --- | --- | --- |
| Logs | Logs visible for every smoke route | Sampling policy approved for traffic/cost |
| Traces | Sampled traces visible during smoke | Trace sampling policy approved |
| Metrics | Request/error/CPU/wall/execution metrics reviewed | Dashboard and alert thresholds set |
| Query Builder | Saved queries or query snippets for relay failures | Incident-ready queries documented |
| Redaction | No raw API keys, bearer tokens, payment secrets, OAuth secrets | Redaction regression check before canary |
| Request IDs | Worker request ID recorded and returned/logged where appropriate | Correlates with D1 audit and upstream ID |

## Staging Config Gate

G1 can pass only when:

1. `bun run check:d1:migration-config`, `bun run verify:sqlite`, and
   `bun run check:cf:quota-coordinator` pass.
2. Any exposed Cloudflare credential is revoked/rotated and the replacement
   credential is validated without recording its value.
3. Authenticated Wrangler output proves the intended account and staging D1
   target; a value present in `wrangler.toml` is not proof by itself.
4. Staging Worker deploys with real resource IDs.
5. `wrangler types` or the Rust equivalent binding verification is refreshed
   after binding changes.
6. `/api/status` reports expected staging feature flags, and the admin
   Operations -> Cloudflare Platform panel reports the expected
   `/api/platform/capabilities` binding/flag state, including
    `d1_migration_status_available=true`, applied count `31`, latest/expected
    `0031_task_billing_intents.sql`, exact set match, and
   `d1_migration_ready=true`.
7. Logs/traces show the status request.
8. D1 migrations 0001-0031 are applied to staging, remote output is archived,
   and the runtime capability exact-set gate agrees with the remote ledger.
   Before both 0020 and 0021, prove the reservation ledger has zero `reserved`
   rows; both migrations fail closed because active ownership cannot be safely
   reconstructed across the lease and bridge-segment schema transitions.
   Apply 0022 with global recovery disabled, then complete the isolated recovery
   smoke before enabling its gate. Apply 0028 with both
   `REALTIME_BILLING_RECONCILIATION_ENABLED=false` and
   `REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED=false`; do not enable
   mutation until the isolated operator drill, dual-control policy, and rollback
   evidence pass. Do not set the staging-proof flag until the independently
   reviewed evidence packet is complete.
   Apply 0029 before flat intent smoke with finalization/recovery gates disabled;
   prove the empty-snapshot guards and old tiered-writer defaults remotely.
   Apply 0030 before admitting new Rust traffic and prove D1 rejects mutation of
   reservation identity, model, endpoint, request/contract hashes, billing kind,
   frozen snapshot, candidate count, strategy, and pre-consumed quota.
   Apply 0031 with task traffic and TaskRunner disabled. Prove reserve is atomic,
   structured rejection refunds atomically, `submit_unknown` cannot auto-refund,
   active intent channels cannot be deleted, soft-deleted owners can receive an
   exact refund, attachment/accounting is exactly once, and terminal
   settle/refund is idempotent. Prove the channel-independent Midjourney timeout
   sweep and zero-wallet FreeModel Task admission, then show rollback restores
   the prior task traffic owner before any task canary.
9. Upstash staging credentials are configured or the feature is deliberately
   disabled.
10. No placeholder IDs or development origins remain in staging config.
11. No secrets are stored in `vars`.
12. `docs/staging-smoke-runbook.md` Phase 0 and Phase 1 pass.

As of 2026-07-10, only item 1 has local evidence. Items 2-12 require credential
remediation and authenticated staging work; G1 is still closed.

## Production Config Gate

Production config can be created only after G1 passes. Production deploy can be
armed only when:

1. Production resource IDs are separate from staging.
2. Production secrets are set and rotation owners are recorded.
3. Production D1 backup/export strategy is documented before first write.
4. Observability sampling and alert thresholds are approved.
5. Production route/custom-domain plan is documented.
6. Rollback target version and traffic stop method are documented.
7. Worker version upload/deploy workflow is rehearsed in staging.
8. G6 report from `docs/observability-slo-security-runbook.md` is approved.
9. G5 report from `docs/admin-frontend-parity-runbook.md` is approved before
   Scenario B or later.
10. Performance/capacity/cost report from
   `docs/performance-capacity-cost-runbook.md` is approved before broad canary
   or full cutover.
11. `docs/cutover-rollback-runbook.md` has named operators and abort criteria.

## HTTP Stream Billing Requirements

- `RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS` is explicitly configured and
  reports both `configured=true` and `valid=true`; an implicit valid default is
  not cutover evidence.
- `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` is reviewed as a charge-affecting gate
  and enabled only with billing shadow approval.
- `RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED` and
  `RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED` remain false
  until their separate deployed matrices pass.
- A dedicated `BILLING_QUEUE`, idempotent replay consumer, DLQ, lag/failure
  alerts, frozen-decision schema, and reconcile path exist before
  `RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED` can become true.
- Local consumer/DLQ/CAS code is not resource evidence. Require authenticated
  Queue/consumer/DLQ readback and a successful operator reconcile/DLQ replay
  drill. The checked-in capability reports the DLQ consumer and reconcile code
  compiled, but `RELAY_BILLING_FINALIZATION_RECONCILE_ENABLED=false` keeps
  reconcile readiness false in every tracked environment.
- Read back the DLQ consumer's environment-specific parking queue and attach an
  alert/runbook that acts before Cloudflare's four-day DLQ retention expires.
  An unconsumed parking queue without this evidence is not a durable archive.
- Request abort signaling and a bounded idle-timeout policy are explicitly
  configured and live-smoked. The current checked-in Worker does not yet expose
  these capabilities, so production HTTP stream billing remains NO-GO.
- Finalization does not depend solely on clone-stream `waitUntil()` work after
  the response or client disconnect; Cloudflare may cancel it after 30 seconds.
- Stream estimation state is bounded per request. Full response text must not
  grow without a documented memory ceiling under the 128 MB isolate limit.
- Pre-bind owner generation and non-stream successful-response parse failures
  have deterministic recovery tests before HTTP orphan recovery is enabled.

### Flat Billing Intent Requirements

- Keep `RELAY_FLAT_BILLING_INTENT_STAGING_VERIFIED=false` in every tracked
  environment until remote 0030, Queue/D1 settlement/refund replay, duplicate
  request identity, body-limit, and rollback evidence is reviewed.
- Require a non-empty frozen snapshot and a repository-validated
  `flat-v4:<sha256>` digest for every flat reservation. Mutable options are not
  a terminal pricing source.
- Before deploying a Worker that accepts only `flat-v4`, prove every `flat-v3`
  reservation is terminal and every related Queue/DLQ/parking replay is
  drained. Do not strand an older snapshot behind the strict v4 repository
  boundary.
- Snapshot schema v4 must contain finite non-negative web/file per-1K prices,
  all nine GPT Image 1 per-call prices, both audio ratios, the resolved
  audio-detail-routing bit, the exact Go-default model-ratio match bit, and the
  OpenRouter inference version. Staging must mutate `tool_price_setting.prices`
  during an in-flight request and prove the terminal charge still uses the
  admitted snapshot.
- Responses SSE tool facts are capped at 256 IDs and duplicate IDs cannot
  double charge. Archive non-stream, stream, duplicate, malformed, oversized,
  Claude cumulative-count, legacy preview, and image quality/size evidence.
- A stable caller request identity must reject an in-flight or terminal replay
  before provider egress. Never log or persist the raw identity.
- Staging proof cannot override source parity. Cutover additionally requires
  `relay_flat_billing_go_parity_ready=true`; this remains hard false until
  Ali asynchronous task settlement, free-model policy, and remaining provider
  usage reconciliation are implemented and verified. Ali synchronous image
  conversion and actual-count replacement, generic OpenAI-compatible multipart
  image-edit flat settlement, the immutable Go flat manifest, TTS binary/audio
  detail, and OpenRouter cost inference are locally closed but still require
  approved cutover-commit regeneration and deployed direct/Gateway/WFP,
  Queue/D1, provider-invoice, abort, and rollback evidence; local parity is not
  sufficient for cutover.
- Multipart image-edit staging evidence must prove that flat pricing receives
  request `n`, `size`, and `quality`, while tiered expressions do not gain new
  multipart parameter visibility. Archive success-without-usage, malformed
  success, provider/HTTP failure, duplicate identity, binary image/mask, body
  limit, count zero/default, and DALL-E size/quality cases.
- `/api/platform/capabilities` must expose a reviewed, non-empty blocker list
  whenever `relay_flat_billing_go_parity_ready=false`; the frontend must render
  the same blocker IDs by name. A true parity bit with any remaining blocker
  must stay fail-closed.
- Ali synchronous image generation and edit must remain restricted to the
  audited synchronous model patterns or an explicitly frozen
  `ALI_SYNC_IMAGE_MODELS` value matching the production Go setting. Staging
  must cover generation/edit,
  multi-image edit, URL/base64 responses, zero/missing `usage.image_count`,
  immediate 17th-file rejection, 8-KiB part-header and 12-MiB request bounds,
  byte-signature MIME rejection, the 8-MiB response conversion bound, compact
  non-image metadata, provider error, duplicate identity, invoice
  reconciliation, and rollback. `b64_json` must never trigger a Worker-side
  fetch of a provider URL; URL-only or partial base64 conversion must return 502
  and refund the reservation.
- Ali asynchronous image capability remains false until submit/poll is owned by
  a bounded TaskRunner DO plus D1/Queue path with idempotent task identity,
  reservation linkage, provider-terminal CAS, terminal timeout/refund,
  duplicate-delivery replay, count provenance, recovery scan, and
  provider-invoice reconciliation. A long polling loop inside one request is
  not production evidence.
- Ordinary upstream failure and zero-usage refund must leave request count and
  channel usage unchanged. Successful billable usage owns one terminal request
  mutation through the reservation ledger.

### Pre-Bind Owner Generation Requirements

- Apply migration 0026 only after old and new admission is frozen and the
  active HTTP reservation count is zero. Its fail-closed drain guard is a
  deployment invariant.
- Require `RELAY_BILLING_RESERVATION_LEASE_SECONDS` and
  `RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS` to be explicit and valid.
  The first value is also the immutable late-bind owner deadline.
- Keep `RELAY_BILLING_PREBIND_OWNER_GENERATION_STAGING_VERIFIED=false` until
  Phase 4f is executed and signed. This variable records evidence; it is not an
  execution switch.
- Require Queue schema v2 for generation-2 events. Accept schema v1 only while
  draining generation-1 events created before cutover.
- Require `/api/platform/capabilities` to report compiled, schema-ready,
  configured, staging-verified, and cutover-ready separately.

### Realtime Usage Reconciliation Requirements

- Apply migration 0027 with public Realtime admission, settlement writes, and
  global orphan recovery disabled. Archive the exact-set migration readback.
- Require `realtime_session_usage_reconciliation_compiled=true` and ledger
  contract v2 before running any isolated fixture. A compiled bit is not remote
  or billing evidence.
- Missing identity or missing/null/malformed/inconsistent/completed-zero usage
  must claim `usage_reconciliation`, retain pre-consumption, suppress the
  provider terminal frame, and remain excluded from automatic refund and
  settlement.
- The admin endpoint and React panel stay read-only, no-store, and hash-only.
  They must not accept a charge/refund/repair body or expose session, bridge,
  response, user, token, channel, IP, request, or provider credential values.
- Attach alert, retention, owner, provider-invoice lookup, dual-control
  resolution, one-CAS financial mutation, audit, and rollback runbooks before
  any reconciliation action is implemented or enabled.
- Preserve `assets.run_worker_first = ["/api/*", "/v1/*"]` in default,
  staging, and production so SPA navigation fallback cannot answer API paths.
  Re-audit this on every asset-routing change against the official Cloudflare
  static-assets routing contract.

## Config Review Checklist

Before every deploy-affecting config change:

```powershell
git diff -- wrangler.toml wrangler.json wrangler.jsonc package.json
bun run check
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
```

When `worker-build` is installed:

```powershell
bun run check:cf:dry-run
bun run check:cf:startup
```

When bindings change:

```powershell
wrangler types
```

If `wrangler types` is not directly applicable to the Rust build path, record
the equivalent binding validation command and the reason.

## Evidence To Record

Add a redacted summary to `docs/verification.md` after staging/prod config
changes:

- commit SHA;
- Wrangler version;
- Worker name/environment;
- config file path;
- compatibility date and flags;
- binding names and resource identifiers redacted or shortened;
- secret names, not values;
- dry-run/startup result;
- generated type result;
- `/api/status` result;
- `/api/platform/capabilities` result and Cloudflare Platform panel screenshot
  with secrets redacted;
- logs/traces evidence;
- known deviations.
