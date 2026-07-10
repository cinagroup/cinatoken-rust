# Local Development

## Toolchain

Required tools:

- Rust toolchain with `cargo` and `rustc`
- Bun
- Wrangler
- `worker-build`
- On Windows, Microsoft Visual C++ 2015-2022 Redistributable (x64), required by
  Wrangler's local `workerd` process

Install the Worker build helper once:

```powershell
bun run install:worker-build
```

## Windows Shared Drive Setup

When the repository is on `Z:`, use a local Cargo target directory to avoid
shared-drive locking and path translation issues:

```powershell
$env:CARGO_HTTP_TIMEOUT='120'
$env:CARGO_NET_RETRY='10'
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
```

Then run:

```powershell
cargo fmt --all
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:d1:migration-config
bun run verify:sqlite
```

If local Wrangler exits before the Worker starts, verify or repair the x64 VC++
runtime first. The 2026-07-10 local validation succeeded after this prerequisite
was present; an early `workerd` process failure is not evidence that the SQL
migration chain is invalid.

## Source Repository Inspection

Inspect the legacy Go checkout before data export:

```powershell
bun run inspect:source -- --repo Z:\cinatoken
```

If the legacy deployment uses SQLite, pass the database file explicitly to get
table counts:

```powershell
bun run inspect:source -- --repo Z:\cinatoken --sqlite Z:\path\to\one-api.db
```

See `docs/source-inspection.md` for the full checklist.

Export a legacy SQLite source database when one is available:

```powershell
bun run export:sqlite -- --sqlite Z:\path\to\one-api.db --output exports\core.cinatoken-export.json
```

The export file contains token and channel secrets. Keep it under `exports/` or
another ignored/private location. See `docs/data-export.md` for table selection
options.

Convert the export bundle to reviewable D1 SQL:

```powershell
bun run import:d1-sql -- --input exports\core.cinatoken-export.json --output exports\core.d1.sql
bun run verify:migration -- --input exports\core.cinatoken-export.json --sql exports\core.d1.sql
```

## Wrangler

Before creating or starting a local D1 database, validate that every configured
environment uses the repository migration directory and that the complete SQL
chain is SQLite-compatible:

```powershell
bun run check:d1:migration-config
bun run verify:sqlite
```

The expected 2026-07-10 result is three D1 binding tables using
`migrations/d1`, 20 contiguous migrations from `0001_core.sql` through
`0020_realtime_billing_reservation_leases.sql`, 26 required tables, 56 incremental key
columns, and 14 key indexes. The SQLite verifier applies the full chain by
default; repeat `--schema` only when a deliberately scoped migration test is
required.

Create local variables from the example file:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Create and migrate a D1 database, then update `wrangler.toml` with the real
database ID:

```powershell
wrangler d1 create cinatoken-rust-db
wrangler d1 migrations apply cinatoken-rust-db --local
```

The local Wrangler apply was exercised successfully for all 20 migrations on
2026-07-10. This proves local Wrangler/workerd compatibility and ordered local
D1 application only. It does not prove Cloudflare authentication, the remote
staging database target, remote migration state, or a deployed Worker binding.

Generate local seed data for a dev user, dev token, and one OpenAI-compatible
channel:

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
$env:CINATOKEN_DEV_UPSTREAM_KEY='replace-with-real-upstream-key'
bun run dev:seed:sql -- --model gpt-4o-mini --output .wrangler/dev-seed.sql
wrangler d1 execute cinatoken-rust-db --local --file .wrangler/dev-seed.sql
```

The default local client token is `ct-dev-key`.

If Wrangler local D1 fails, verify the schema and seed SQL with SQLite:

```powershell
bun run verify:sqlite -- --seed .wrangler/dev-seed.sql
```

Start the Worker:

```powershell
bun run dev
```

Then test the relay:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Headers @{ Authorization = 'Bearer ct-dev-key' } `
  -ContentType 'application/json' `
  -Body '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"temperature":0}'
```

Embeddings use the same auth/channel path:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/embeddings `
  -Headers @{ Authorization = 'Bearer ct-dev-key' } `
  -ContentType 'application/json' `
  -Body '{"model":"gpt-4o-mini","input":"hello"}'
```

Image generation is also JSON passthrough on the same relay path:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/images/generations `
  -Headers @{ Authorization = 'Bearer ct-dev-key' } `
  -ContentType 'application/json' `
  -Body '{"model":"gpt-image-1","prompt":"a tiny migration milestone badge","size":"1024x1024"}'
```

For GPT image streaming, pass through the upstream SSE stream:

```powershell
Invoke-WebRequest `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/images/generations `
  -Headers @{ Authorization = 'Bearer ct-dev-key' } `
  -ContentType 'application/json' `
  -Body '{"model":"gpt-image-1","prompt":"a tiny migration milestone badge","stream":true,"partial_images":1}'
```

Audio speech returns a binary audio response and should be saved by the client:

```powershell
Invoke-WebRequest `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/audio/speech `
  -Headers @{ Authorization = 'Bearer ct-dev-key' } `
  -ContentType 'application/json' `
  -Body '{"model":"gpt-4o-mini-tts","input":"hello from the Rust relay","voice":"alloy"}' `
  -OutFile speech.mp3
```
