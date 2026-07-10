# cinatoken-rust

Rust and Cloudflare-native migration workspace for `github:cinagroup/cinatoken`.

This repository starts with a Worker MVP:

- `GET /api/status`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

The relay endpoints now perform a first OpenAI-compatible proxy:

- authenticates `Authorization: Bearer ...` or `x-api-key` against D1 tokens;
- enforces token/user status, expiry, quota presence, model limits, and IP allowlist;
- selects an enabled OpenAI-compatible channel from D1;
- applies model mapping and forwards the original JSON body upstream;
- streams `POST /v1/chat/completions` when `stream: true`;
- records token access, request count, and a zero-quota audit log for the call.

Final quota settlement and stream usage reconciliation are intentionally still
pending. See `docs/relay-mvp.md` for the exact boundary.

## Layout

```text
crates/core       shared DTOs, error types, JSON-facing structs
crates/api        route-level business handlers independent from Worker APIs
crates/auth       user, token, admin, OAuth, 2FA, and passkey boundaries
crates/session    HMAC-signed session cookie codec for the admin/frontend
crates/ssrf       SSRF protection helpers for user-controlled URL paths
crates/storage    D1 repository abstractions
crates/cache      KV, counters, rate limits, and Upstash Redis REST abstractions
crates/relay      relay pipeline traits and context
crates/providers  upstream provider adapter traits and registry
crates/billing    quota and settlement abstractions
crates/tasks      async media/task lifecycle abstractions
crates/payments   payment order and webhook abstractions
crates/observability logs, audit, and metric event abstractions
crates/migration  import/export/verify CLI scaffolding
crates/xtask      local project automation
crates/worker     Cloudflare Worker entrypoint
apps/web          built admin frontend bundle (Worker static assets)
migrations/d1     D1 schema migrations
```

## Local setup

Install Rust, Bun, Wrangler, and `worker-build`, then run:

```bash
bun install
bun run install:worker-build
bun run dev
```

On Windows, Wrangler's local `workerd` process also requires the Microsoft
Visual C++ 2015-2022 Redistributable (x64). If `wrangler dev` or local D1 exits
before startup, install or repair that runtime before treating the failure as a
Worker or migration defect.

Run the D1 migration preflight before local Wrangler startup:

```powershell
bun run check:d1:migration-config
bun run verify:sqlite
wrangler d1 migrations apply cinatoken-rust-db --local
```

As of 2026-07-10, the first command checks all three `wrangler.toml` D1
bindings for `migrations_dir = "migrations/d1"` and a contiguous 19-migration
chain. The SQLite verifier applies all 19 migrations by default and requires
26 tables, 55 incremental key columns, and 13 key indexes. Local Wrangler D1
has also applied 19/19 migrations successfully.
These are local prerequisites only; they do not replace an authenticated
staging migration, deployed Worker smoke, or staging evidence capture.

On the current Windows shared-drive workspace, Cargo checks are more reliable
when the target directory is moved to a local disk:

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
bun run check
```

Secrets are configured with Wrangler:

```bash
wrangler secret put JWT_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put ENCRYPTION_KEY
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

`SESSION_SECRET` is required for the admin/frontend login flow. It must be at
least 32 bytes (256 bits); a missing or short secret makes `POST /api/user/login`
and `POST /api/setup` return 500 with an explicit error instead of falling
back to a random per-boot key (which would silently invalidate every session
on every redeploy). Generate one with, for example,
`openssl rand -base64 48`.

Copy `.dev.vars.example` to `.dev.vars` for local Wrangler development.
See `docs/cache-upstash.md` for the Upstash Redis REST cache boundary and
optional relay token/IP rate limiting.

## Migration CLI

Inspect the legacy Go checkout before exporting data:

```powershell
bun run inspect:source -- --repo Z:\cinatoken
```

Export a legacy SQLite database to a JSON bundle:

```powershell
bun run export:sqlite -- --sqlite Z:\path\to\one-api.db --output exports\core.cinatoken-export.json
```

Convert an export bundle to D1 SQL:

```powershell
bun run import:d1-sql -- --input exports\core.cinatoken-export.json --output exports\core.d1.sql
bun run verify:migration -- --input exports\core.cinatoken-export.json --sql exports\core.d1.sql
```

Generate local D1 seed SQL for a development token and channel:

```powershell
$env:CINATOKEN_DEV_UPSTREAM_KEY='replace-with-real-upstream-key'
bun run dev:seed:sql -- --model gpt-4o-mini --output .wrangler/dev-seed.sql
```
