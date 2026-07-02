# cinatoken-rust frontend

The tracked Bun workspace lives in `apps/web/source/`. The default React
frontend is `apps/web/source/default`; `apps/web/dist/` is generated and ignored.

## Commands

From the repository root:

```powershell
bun run build:web
bun run check:web
bun run check:web:quality
```

- `build:web` installs from the frozen workspace lockfile, typechecks, builds,
  and copies the bundle to `apps/web/dist/`.
- `check:web` runs the frontend build contract.
- `check:web:quality` runs strict lint and Prettier checks. The current imported
  source has known lint debt; do not disable rules to make this command pass.

## Configuration

Production uses same-origin API calls:

```dotenv
VITE_REACT_APP_SERVER_URL=
```

The dev server proxies `/api`, `/v1`, `/v1beta`, `/dashboard`, `/mj`, `/suno`,
`/kling`, `/jimeng`, and `/pg` to the configured local backend.

The Worker serves `apps/web/dist/` through the `ASSETS` binding with SPA
fallback. API routes are resolved before static assets.

## Source Updates

The initial tracked baseline came from the Go repository's `web` workspace at
commit `73652508abc5cb09214dde02d51d69d1d1ccc703`. Apply later source updates as
reviewable diffs and keep the workspace lockfile frozen. Do not restore the old
deployment-time copy workflow.

## Production Gate

A local build is necessary but not sufficient. Before frontend cutover, run
the staging browser/API contract smoke in `docs/frontend-deploy.md` and record
the result in `docs/verification.md`.
