# Cloudflare Production Config Checklist

Date: 2026-06-22

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

Current `wrangler.toml` is development-shaped:

- Worker name: `cinatoken-rust-api`
- Entry point: `crates/worker/build/worker/shim.mjs`
- Compatibility date: `2026-06-17`
- Compatibility flags: `nodejs_compat`
- Observability: enabled with full head sampling
- Build command: `cd crates/worker && worker-build --release`
- `ENVIRONMENT = "development"`
- `FRONTEND_BASE_URL = "http://localhost:3000"`
- `AI_GATEWAY_ID = ""`
- WFP/realtime flags default off or empty: `WFP_DISPATCH_ENABLED`,
  `WFP_INTERNAL_DISPATCH_ENABLED`, `WFP_PREVIEW_HOST_SUFFIX`,
  `WFP_DISPATCH_WORKER_PREFIX`, `REALTIME_SESSION_GATEWAY_ENABLED`
- D1/KV IDs are placeholders
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

Placeholder binding IDs (`00000000-...` for dev, `REPLACE_WITH_STAGING_*` /
`REPLACE_WITH_PRODUCTION_*` for staging/prod) are intentional and must be
replaced before the corresponding deploy. Production deploy is gated by G8 in
`docs/production-migration-execution-plan.md`.

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
   # provider keys, JWT/session, payment, OAuth, Turnstile as required by scope
   ```

5. Run the Cloudflare preflight scripts (`bun run check:cf:dry-run` and
   `bun run check:cf:startup`) once `worker-build` is installed.
6. Deploy with `wrangler deploy --env staging` (or `--env production`).
7. Verify `/api/status` reports the expected `ENVIRONMENT` and feature flags.

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
| `TASK_QUEUE` | Optional | Real queue once async task flow is enabled | Real queue plus consumer/DLQ | Platform/Tasks | Queue smoke, replay test |
| `EMAIL` send_email | Optional | Required for email verification/reset smoke | Required before enabling `EmailVerificationEnabled` or password reset in production | Platform/Auth | Verified sender, `SMTPFrom`/`SMTPAccount` option, send-code/reset smoke |
| AI Gateway | Optional | Real ID or direct-provider decision | Real ID or direct-provider decision | Relay | Provider matrix decision |
| Static assets or Pages | Optional | Required before G5 frontend smoke | Required before Scenario B/C frontend cutover | Frontend/Platform | SPA fallback, API route precedence, bundle redaction smoke |
| Service bindings | Optional | Use for Worker-to-Worker calls if split | Same | Platform | Binding type and smoke |
| `CHANNEL_AFFINITY` Durable Object | Optional | Required before channel-affinity canary | Same | Relay/Platform | Migration entry, affinity smoke, fail-open smoke |
| `REALTIME_SESSIONS` Durable Object | Optional | Required before realtime/session cutover | Same | Platform/Relay | Migration entry, hibernation WebSocket smoke, protocol bridge smoke |
| `DISPATCHER` WFP dispatch namespace | Optional | Required before tenant/preview WFP traffic | Required before WFP cutover | Platform | Namespace created, binding uncommented, tenant script smoke |
| Rate Limiting binding | Optional | Required once relay rate limits move off Upstash | Required before relay canary | Platform/Security | 429 telemetry via Analytics Engine, limit smoke |
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
| Upstash | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Cache/rate limit | Staging/prod secret dates |
| Provider smoke | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, provider-specific names | Live relay smoke | Low-risk key policy |
| Payment | Stripe/Creem/Waffo/Epay webhook and API secret names | Payment cutover | Webhook replay test |
| OAuth | GitHub/Discord/OIDC/custom provider secret names | Auth cutover | State/replay test |
| Session/JWT | Session signing/encryption secret names | Admin/frontend cutover | Forced re-auth decision |
| Turnstile | Turnstile secret names | Public auth/forms | Staging challenge test |
| Admin bootstrap | Initial root/admin secret name | Operator bootstrap | Rotation after first login |

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
| `WFP_DISPATCH_ENABLED` | Enables the Rust dispatch Worker pre-router for tenant/preview traffic | `DISPATCHER` dispatch namespace, route smoke |
| `WFP_PREVIEW_HOST_SUFFIX` | Maps `{tenant}.{suffix}` hostnames to dispatch namespace worker names | DNS/route review, tenant-name validation |
| `WFP_INTERNAL_DISPATCH_ENABLED` | Enables `/api/platform/dispatch/:worker/...` as an internal dispatch test path | Operator smoke plan; keep off in production unless explicitly needed |
| `WFP_DISPATCH_WORKER_PREFIX` | Prefixes sanitized tenant names before `DISPATCHER.get()` | Naming convention and collision review |
| `REALTIME_SESSION_GATEWAY_ENABLED` | Enables `/api/platform/realtime/:session...` -> `REALTIME_SESSIONS` DO forwarding | `REALTIME_SESSIONS` binding and WebSocket hibernation smoke; not a `/v1/realtime` cutover by itself |

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
| `GEMINI_VERSION` | var, default `v1beta` — Gemini/Veo API version. |
| `VERTEX_REGION` | var, default `us-central1` — Vertex region for `predictLongRunning` (per-channel region edge cases TBD on staging). |
| Channel types | Each provider is a channel `type`: Ali=17, Gemini=24, MiniMax/Hailuo=35, SunoAPI=36, VertexAi=41, VolcEngine=45, Kling=50, Jimeng=51, Vidu=52, DoubaoVideo=54, Sora=55/OpenAI=1; Midjourney=2/5. A task model with no matching enabled channel returns 503. |
| Channel keys | Provider-specific: bearer key (sora/doubao/ali/hailuo/suno), `Token` (vidu), `mj-api-secret` (mj), `accessKey\|secretKey` (kling JWT / jimeng SigV4), or the **service-account JSON** (vertex). |
| Pricing | Task billing models are `suno_<action>`, `mj_<action>`, or the video model name — price them or they bill 0. |

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

1. Staging Worker deploys with real resource IDs.
2. `wrangler types` or the Rust equivalent binding verification is refreshed
   after binding changes.
3. `/api/status` reports expected staging feature flags.
4. Logs/traces show the status request.
5. D1 migrations are applied to staging.
6. Upstash staging credentials are configured or the feature is deliberately
   disabled.
7. No placeholder IDs or development origins remain in staging config.
8. No secrets are stored in `vars`.
9. `docs/staging-smoke-runbook.md` Phase 0 and Phase 1 pass.

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
- logs/traces evidence;
- known deviations.
