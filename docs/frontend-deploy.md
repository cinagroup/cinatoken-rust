# Frontend Deploy

Date: 2026-07-02

Status: source migrated and local production build verified; staging browser
smoke and full frontend/API parity remain open.

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

1. Deploy the current bundle and Worker together.
2. Hard-refresh `/`, `/setup`, `/sign-in`, `/dashboard`, `/keys`, `/channels`,
   `/users`, `/usage-logs`, `/models`, `/system-settings`, and `/profile`.
3. Exercise setup status, login/logout/self, role gating, CRUD mutations and
   expired-session behavior.
4. Capture browser network failures and prove every visible page calls only
   implemented routes.
5. Scan the deployed artifact for secrets and localhost/cross-origin API URLs.
6. Record desktop/mobile console errors and basic loading/performance evidence.

Completion evidence belongs in `docs/verification.md` and the G5 runbook.
