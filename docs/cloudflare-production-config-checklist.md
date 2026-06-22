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
- D1 Time Travel and backups:
  <https://developers.cloudflare.com/d1/reference/time-travel/>

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
- D1/KV IDs are placeholders
- R2/Queue names are declared but Worker code does not yet use them

Production decision:

- Prefer migrating to `wrangler.jsonc` before production, because JSONC is the
  preferred shape for newer Workers configuration and comments.
- A TOML exception is acceptable only if the exact staging/prod config is
  validated with Wrangler, generated binding types, and dry-run/startup checks.

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
| AI Gateway | Optional | Real ID or direct-provider decision | Real ID or direct-provider decision | Relay | Provider matrix decision |
| Static assets or Pages | Optional | Required before G5 frontend smoke | Required before Scenario B/C frontend cutover | Frontend/Platform | SPA fallback, API route precedence, bundle redaction smoke |
| Service bindings | Optional | Use for Worker-to-Worker calls if split | Same | Platform | Binding type and smoke |
| Durable Objects | Optional | Required before realtime/session cutover | Required before realtime/session cutover | Platform | Migration entry and WebSocket smoke |
| Workflows | Optional | Required before multi-step async cutover | Required before multi-step async cutover | Platform/Tasks | Workflow smoke and retry test |

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
10. `docs/cutover-rollback-runbook.md` has named operators and abort criteria.

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
