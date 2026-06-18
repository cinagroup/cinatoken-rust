# cinatoken-rust

Rust and Cloudflare-native migration workspace for `github:cinagroup/cinatoken`.

This repository starts with a Worker MVP:

- `GET /api/status`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

The relay endpoints now perform a first OpenAI-compatible non-stream proxy:

- authenticates `Authorization: Bearer ...` or `x-api-key` against D1 tokens;
- enforces token/user status, expiry, quota presence, model limits, and IP allowlist;
- selects an enabled OpenAI-compatible channel from D1;
- applies model mapping and forwards the original JSON body upstream;
- records token access, request count, and a zero-quota audit log for the call.

Streaming chat and final quota settlement are intentionally still pending. See
`docs/relay-mvp.md` for the exact boundary.

## Layout

```text
crates/core       shared DTOs, error types, JSON-facing structs
crates/api        route-level business handlers independent from Worker APIs
crates/auth       user, token, admin, OAuth, 2FA, and passkey boundaries
crates/storage    D1 repository abstractions
crates/cache      KV and Upstash Redis abstractions
crates/relay      relay pipeline traits and context
crates/providers  upstream provider adapter traits and registry
crates/billing    quota and settlement abstractions
crates/tasks      async media/task lifecycle abstractions
crates/payments   payment order and webhook abstractions
crates/observability logs, audit, and metric event abstractions
crates/migration  import/export/verify CLI scaffolding
crates/xtask      local project automation
crates/worker     Cloudflare Worker entrypoint
migrations/d1     D1 schema migrations
```

## Local setup

Install Rust, Bun, Wrangler, and `worker-build`, then run:

```bash
bun install
bun run install:worker-build
bun run dev
```

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

Copy `.dev.vars.example` to `.dev.vars` for local Wrangler development.

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
```

Generate local D1 seed SQL for a development token and channel:

```powershell
$env:CINATOKEN_DEV_UPSTREAM_KEY='replace-with-real-upstream-key'
bun run dev:seed:sql -- --model gpt-4o-mini --output .wrangler/dev-seed.sql
```
