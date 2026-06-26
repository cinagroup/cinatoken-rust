# cinatoken-rust admin frontend

This directory holds the build output of the `web/default` React dashboard
served as Worker static assets. The frontend source lives in the Go repository
at `C:\cinagroup\cinatoken\web\default` (or its production mirror) and is **not
copied into this repo**; only the built `dist/` artifacts land here so the
Worker can serve them at deploy time.

## Build workflow

Sync the source from the Go repo (or its production mirror) and build with Bun:

```powershell
# 1. Sync source from the Go repository (one-time, or whenever web/default
#    changes). Replace the source path with your local checkout.
robocopy C:\cinagroup\cinatoken\web\default .\web-default /MIR /XD node_modules dist .git

# 2. Install dependencies and build.
cd web-default
bun install --frozen-lockfile
bun run typecheck
bun run build

# 3. Copy the produced bundle into apps/web/dist so the Worker can serve it.
cd ..
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path dist | Out-Null
Copy-Item -Recurse web-default\dist\* dist\
```

`bun run typecheck` and `bun run build` are the source frontend's documented
build commands (see `web/default/package.json`). Output goes to `dist/`.

## Configuration

The frontend calls the backend same-origin by default
(`VITE_REACT_APP_SERVER_URL=""`). Because the Worker serves both the API
routes (`/api/*`, `/v1/*`, `/v1beta/*`) and the static assets on the same
origin, no cross-origin CORS configuration is needed for credentialed
session cookies. Do not set `VITE_REACT_APP_SERVER_URL` to a different origin
unless you have also configured credentialed CORS in the Worker.

## Wrangler integration

`wrangler.toml` declares an `[assets]` block in each environment:

```toml
[assets]
directory = "apps/web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

`not_found_handling = "single-page-application"` makes Cloudflare serve
`index.html` for any path that does not match a static file, so client-side
routes like `/dashboard`, `/channels`, `/keys`, `/sign-in` survive a hard
refresh. API routes are handled by the Worker before the asset binding is
consulted, so they never fall through to the SPA fallback.

## Secret hygiene

The static bundle may only contain **public** configuration values. Allowed
examples: `VITE_REACT_APP_VERSION`, a Turnstile **site** key (public). Never
bake API keys, webhook secrets, OAuth client secrets, session secrets, or
provider credentials into the bundle. After every build, scan the output:

```powershell
rg -n "UPSTASH|SECRET|TOKEN|PRIVATE|CLIENT_SECRET|WEBHOOK|API_KEY" dist
```

Use an allowlist for public names; rotate any value that leaks.

## Current status

The deploy pipeline (wrangler `[assets]` + Worker SPA fallback) is in place.
Actual end-to-end build and smoke against a real Worker happens during the
G1 staging smoke phase (see `docs/staging-smoke-runbook.md` Phase 8).
