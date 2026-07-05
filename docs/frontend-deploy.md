# Frontend Deploy

Date: 2026-07-03

Status: source migrated, production build verified, and the deployed staging
artifact/HTTP contract verified; authenticated browser smoke and full
frontend/API parity remain open.

## Source

The complete Bun workspace is tracked at `apps/web/source/`:

- `default/`: React 19 + TypeScript + Rsbuild production frontend.
- `classic/`: retained workspace package.
- `bun.lock`: frozen dependency graph.

The imported source baseline is Go repository commit
`73652508abc5cb09214dde02d51d69d1d1ccc703` (2026-06-16). Future source syncs
must be reviewed as normal repository changes; deployment no longer depends on
an untracked `robocopy` step.

## Build

From the repository root:

```powershell
bun run build:web
```

`tools/build_web.mjs`:

1. runs `bun install --frozen-lockfile` in `apps/web/source`;
2. runs `bun run typecheck` and `bun run build` in
   `apps/web/source/default`;
3. replaces `apps/web/dist/` with the built bundle.

Contract/build verification:

```powershell
bun run check:web
```

Strict source quality verification:

```powershell
bun run check:web:quality
```

As of 2026-07-05, build/typecheck and Prettier pass. Strict lint still reports
50 errors and 2 warnings; this is tracked debt and the lint rules must not be
weakened to hide it. The migration check chain now enforces a no-regression
baseline while the imported React debt is paid down:

```powershell
bun run check:web:lint-debt
```

## Hosting

The Worker serves the SPA through Static Assets:

```toml
[assets]
directory = "apps/web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

API prefixes are routed before the asset binding, while browser routes use SPA
fallback. The production frontend uses an empty
`VITE_REACT_APP_SERVER_URL`, so API and secure session cookies remain
same-origin.

## API Compatibility Boundary

The React application expects Go-style envelopes:

```json
{"success":true,"message":"","data":{}}
```

The Worker `/api/status` now returns this envelope and exposes D1-backed public
configuration plus runtime features. `/api/setup.data.status` follows the Go
meaning: `true` means initialization is complete.

Until all API families are migrated, the status response clamps
`HeaderNavModules` and `SidebarModulesAdmin` so unsupported pages are not
advertised:

- playground;
- remaining product families not yet owned by Rust; payment provider checkout
  and callback routes used by the default frontend are Worker-owned when their
  provider config is complete;
- Midjourney/task logs;
- subscriptions;
- io.net model deployments.

This is a temporary product boundary. It does not replace route migration or
direct-URL error handling.

## Automated Contract Audit

The repository has complementary frontend checks for route compatibility,
static-bundle secret hygiene, bundle-size budgets, and public staging HTTP
contract:

```powershell
bun run audit:web:routes
bun run audit:web:bundle
bun run audit:web:bundle-budget
bun run check:web:staging
```

`audit:web:routes` parses the default frontend with a TypeScript
Program/TypeChecker and compares 214 distinct frontend calls with Worker router
registrations. The 2026-07-03 and 2026-07-04 compatibility batches reduced
unmatched calls from 122 to 63 by closing routes and removing one
false-positive call:

- complete 2FA setup/enable/disable/status/backup-code contracts;
- batch token-key reveal;
- channel batch-tag and tag-model lookup;
- admin group lookup;
- the frontend spelling for admin 2FA reset;
- prefill-group CRUD;
- official model metadata preview/sync;
- channel balance refresh and multi-key management;
- single-channel upstream model detect/apply;
- Codex channel usage and OAuth credential refresh;
- Rust-native channel-affinity cache stats/clear for the indexed Durable
  Object subset.
- Rust-native channel-affinity usage diagnostics for usage-log cache-hit
  detail.
- Worker-bounded upstream model `detect_all`/`apply_all` slices, with the
  frontend looping over after-id cursors to preserve the batch-button workflow.
- Ollama model-management version/delete/pull-stream routes, plus `/api/tags`
  model listing for both probe and stored-channel fetch paths. Workers require
  HTTPS/443 base URLs reachable through Tunnel/Container/service-facing
  gateways instead of VPS-local daemon access.
- Worker-native operations endpoints for Uptime Kuma, model performance
  metrics, and explicit no-op `/api/performance/*` local-maintenance
  compatibility.
- Upstream ratio sync channels/fetch endpoints for the default frontend's
  pricing sync dialog.
- Custom OAuth provider admin CRUD/discovery endpoints and `/api/status`
  enabled-provider exposure. The provider secret remains server-only; custom
  OAuth login/bind callbacks are still deferred to the auth-flow batch.
- Custom OAuth account-binding management for self/admin users plus admin
  built-in binding clear. The route set now covers the default profile and user
  binding dialogs without opening the deferred callback/login flows.
- Async usage-log read lists for Midjourney and unified tasks:
  `GET /api/mj`, `GET /api/mj/self`, `GET /api/task`, and
  `GET /api/task/self`. The routes are D1-backed, session-scoped for self
  requests, and preserve Go's seconds-vs-milliseconds split between task and
  Midjourney timestamps.
- User daily check-in status and submit routes:
  `GET /api/user/checkin` and `POST /api/user/checkin`. The routes use the
  Go-compatible frontend envelope, D1 `checkins` persistence, Turnstile on
  submit when configured, and a UTC day boundary for Cloudflare Workers.
- Admin redemption-code management and public wallet top-up progress:
  `GET/POST/PUT /api/redemption`, `GET /api/redemption/search`,
  `GET/DELETE /api/redemption/:id`, and
  `DELETE /api/redemption/invalid`. The routes are D1-backed, preserve
  Go-style pagination/search/create/update/delete envelopes, require payment
  compliance before code creation, soft-delete rows, and write admin audit
  logs. Public redemption-code topup, Stripe wallet checkout, Epay wallet
  checkout/callback, legacy Waffo wallet checkout/webhook, Waffo Pancake wallet
  checkout/webhook, Creem wallet checkout/webhook, Stripe subscription
  checkout/settlement, Creem subscription checkout/settlement, Epay
  subscription checkout/notify/return settlement, and Waffo Pancake
  subscription checkout/webhook settlement are implemented.
- Public rankings:
  `GET /api/rankings` now returns the default frontend's live rankings
  snapshot from D1 `logs`, honors `HeaderNavModules.rankings`, and removes
  rankings from the status capability clamp.

`bun run check:web:routes` additionally enforces the reviewed debt baseline:
214 frontend Worker-facing calls, 304 Worker routes, 0 missing calls, categories
`{}`, and SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. New
unclassified calls or an unreviewed route-set change fail the check. Local
wrapper methods are inferred, while non-HTTP calls such as `endsWith('/v1')`
are no longer counted. Hidden navigation still does not imply implementation.

`check:web:staging` verifies the public staging deployment without mutating
state. Its seven checks cover status capability clamps, setup shape, 11 SPA
hard-refresh paths, eight static assets, exact local/deployed `index.html`
identity, ten public envelopes, and API-before-SPA routing. This is HTTP
contract evidence, not rendered DOM or authenticated workflow evidence.

## Bundle Budget

`tools/frontend_bundle_budget.json` records the current ratchet budget for the
canonical build output in `apps/web/source/default/dist`. Run the executable
budget audit after every production build:

```powershell
bun run audit:web:bundle-budget
```

As of 2026-07-05, the verified production build is:

- 245 files;
- 18.94 MB total raw / 4.49 MB total gzip;
- 18.25 MB JavaScript raw / 4.14 MB JavaScript gzip;
- 4.29 MB initial JavaScript raw / 1.23 MB initial JavaScript gzip;
- 5.28 MB raw / 1.00 MB gzip for the largest JavaScript chunk.

The budget currently prevents accidental growth; it does not prove that the
bundle is already optimal. Before production G5 approval, keep the budget in
CI and split heavy route-specific dependencies where the deployed browser smoke
or performance runbook shows user-visible load cost.

## Auth

- Cookie name: `session`.
- Rust session format is HMAC-signed and is not compatible with Go's cookie
  store; first Rust visit requires re-authentication.
- Cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`.
- Login, self and logout use the Go-compatible envelope.
- OAuth buttons are advertised only when the corresponding runtime settings are
  complete.

## Secret Hygiene

Only public configuration may appear in `apps/web/dist/`. OAuth client secrets,
provider keys, session secrets, webhook secrets, and Cloudflare credentials
must never be compiled into the bundle.

Run a bundle scan after every production build and review matches rather than
blindly allowlisting broad words:

```powershell
bun run audit:web:bundle
```

## Required Staging Evidence

Before marking frontend hosting complete:

1. Deploy each backend compatibility batch together with the unchanged or
   rebuilt frontend artifact.
2. Render and hard-refresh `/`, `/setup`, `/sign-in`, `/dashboard`, `/keys`, `/channels`,
   `/users`, `/usage-logs`, `/models`, `/system-settings`, and `/profile`.
3. Exercise setup status, login/logout/self, role gating, CRUD mutations and
   expired-session behavior.
4. Capture browser network failures and prove every visible page calls only
   implemented routes.
5. Scan the deployed artifact for secrets and localhost/cross-origin API URLs.
6. Record desktop/mobile console errors and basic loading/performance evidence.

The HTTP-only portions of items 1-2 have staging evidence. Rendered browser
behavior and items 3-6 remain open because the current staging database is
uninitialized and browser-control tooling was unavailable in the audit
session. Do not initialize shared staging solely to make a smoke test pass.

Completion evidence belongs in `docs/verification.md` and the G5 runbook.
