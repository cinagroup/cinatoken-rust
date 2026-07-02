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

As of 2026-07-02, build/typecheck pass. Strict lint still reports 101 errors and
4 warnings; this is tracked debt and the lint rules must not be weakened to
hide it.

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

- rankings;
- playground;
- wallet/top-up;
- Midjourney/task logs;
- redemption;
- subscriptions;
- io.net model deployments.

This is a temporary product boundary. It does not replace route migration or
direct-URL error handling.

## Automated Contract Audit

The repository now has two complementary frontend checks:

```powershell
bun run audit:web:routes
bun run check:web:staging
```

`audit:web:routes` parses the default frontend with the TypeScript compiler API
and compares 212 distinct frontend calls with Worker router registrations. The
2026-07-03 compatibility batch reduced unmatched calls from 122 to 115 by
closing:

- complete 2FA setup/enable/disable/status/backup-code contracts;
- batch token-key reveal;
- channel batch-tag and tag-model lookup;
- admin group lookup;
- the frontend spelling for admin 2FA reset.

The remaining 115 calls include capability-hidden product families and real
parity debt. They are not treated as implemented merely because navigation is
hidden.

`check:web:staging` verifies the public staging deployment without mutating
state. Its seven checks cover status capability clamps, setup shape, 11 SPA
hard-refresh paths, eight static assets, exact local/deployed `index.html`
identity, ten public envelopes, and API-before-SPA routing. This is HTTP
contract evidence, not rendered DOM or authenticated workflow evidence.

## Bundle Budget

The verified production build is approximately:

- 18.9 MB total uncompressed;
- 4.4 MB total gzip;
- largest chunks approximately 5.3 MB, 2.7 MB and 1.9 MB.

Before production G5 approval, record a bundle budget and split heavy,
route-specific dependencies. A successful build alone is not a performance
gate.

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
rg -n "CLIENT_SECRET|PRIVATE_KEY|SESSION_SECRET|WEBHOOK_SECRET|UPSTASH_REDIS_REST_TOKEN" apps/web/dist
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
