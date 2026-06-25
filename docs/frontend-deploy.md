# Frontend Deploy

Date: 2026-06-22

Status: deploy pipeline foundation. The wrangler `[assets]` block, the Worker
SPA fallback, and the build scripts are in place; the actual frontend bundle
build and end-to-end staging smoke happen during G1 (see
`docs/staging-smoke-runbook.md` Phase 8).

## Source frontend

The React dashboard lives in the Go repository at `web/default`. It is a
single-page application (Rsbuild + React 19 + TanStack Router) with **zero
build-time dependency on the backend**: no SSR, no Go templates, no `embed.FS`.
All backend calls go through an axios client (`web/default/src/lib/api.ts`)
that defaults to same-origin.

The frontend is **not** copied into this repository. Only the built `dist/`
artifacts land in `apps/web/dist/` so the Worker can serve them.

## Deploy model

**Worker static assets** (chosen over Cloudflare Pages) so the frontend and
API share one origin. This sidesteps credentialed-CORS complexity: the React
app's `withCredentials: true` axios calls send the `session` cookie to the
same origin that issued it.

`wrangler.toml` carries the `[assets]` block in each environment:

```toml
[assets]
directory = "apps/web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

`not_found_handling = "single-page-application"` makes Cloudflare serve
`index.html` for any path that does not match a static file, so client-side
routes like `/dashboard`, `/channels`, `/keys`, `/sign-in` survive a hard
refresh.

## Worker fallback routing

The Worker's `fetch` handler (`crates/worker/src/lib.rs`) checks
`is_static_asset_path(&path)` before consulting the Router. API prefixes
(`/api/`, `/v1/`, `/v1beta/`, `/mj/`, `/suno/`, `/pg/`) and the exact-match
API endpoints (`/api/status`, `/v1/models`, ...) are routed to the API
router; everything else falls through to `env.assets("ASSETS")` when that
binding is configured. When the binding is absent (local dev without a built
frontend) the request falls through to the router and 404s — `cargo test`
and `cargo check` still work without a built frontend.

## Build commands

Added to `package.json`:

- `bun run build:web` — runs `bun install` + `bun run build` inside
  `apps/web/web-default` and copies the produced `dist/` to `apps/web/dist/`.
- `bun run build:all` — `build:web` then `build:worker`.

The source must first be synced from the Go repository (see
`apps/web/README.md` for the `robocopy` recipe). End-to-end build + smoke is
a G1 staging step.

## Auth model

Same-origin cookie sessions (see `docs/admin-frontend-parity-runbook.md`).
The frontend's existing axios client (`web/default/src/lib/api.ts`) keeps
working without changes because:

- the cookie name is still `session` (`cinatoken_session::COOKIE_NAME`);
- the session cookie is still `HttpOnly` + `SameSite=Strict`;
- `/api/user/login`, `/api/user/self`, `/api/user/logout` return the same
  `{success, message, data}` envelope the React app expects;
- `withCredentials: true` sends the cookie automatically on every request.

## Secret hygiene

The static bundle may only contain **public** configuration values. Allowed
examples: `VITE_REACT_APP_VERSION`, a Turnstile **site** key (public). Never
bake API keys, webhook secrets, OAuth client secrets, session secrets, or
provider credentials into the bundle. After every build, scan the output:

```powershell
rg -n "UPSTASH|SECRET|TOKEN|PRIVATE|CLIENT_SECRET|WEBHOOK|API_KEY" dist
```

Use an allowlist for public names; rotate any value that leaks. Full
redaction policy: `docs/observability-slo-security-runbook.md` "Redaction".

## Differences from the Go deployment

| Area | Go gateway | Rust Worker |
| --- | --- | --- |
| Frontend origin | Same-origin, served by Gin | Same-origin, served by Worker static assets |
| Cookie `Secure` flag | `false` (`main.go:205`) | `true` (hardened) |
| Session format | gin-contrib cookie store (gob + AES) | HMAC-signed JSON (this repo's `crates/session`) |
| Cross-session portability | — | Go-issued cookies do NOT verify in Rust; forced re-auth on first Rust visit |
| `New-Api-User` header | Required as anti-CSRF | NOT required (SameSite=Strict + HttpOnly + Secure is the defense) |
| `VITE_REACT_APP_SERVER_URL` | Optional cross-origin | Empty / same-origin only |

## Open follow-ups (tracked in `docs/admin-frontend-parity-runbook.md`)

- Run the real `bun run build:web` against the source frontend and verify the
  bundle contains no secrets (G1 staging smoke Phase 8 FRONTEND-001/004).
- Hard-refresh SPA routes against the deployed Worker (FRONTEND-002).
- Wire the `require_admin_auth` / `require_root_auth` helpers (already in
  `crates/worker/src/admin.rs`) to the token/channel/user/log/option CRUD
  routes in the next G5 batch.
- OAuth / 2FA / Passkey (deferred per G5 forced re-auth policy).
