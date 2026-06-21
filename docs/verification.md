# Verification

Last checked: 2026-06-21

## Passed

- `cargo fmt --all`
- `cargo test --workspace --exclude cinatoken-worker`
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
- `bun run check` from `C:\cinagroup\cinatoken-rust`.
- `cargo test -p cinatoken-relay` covering OpenAI-compatible relay helpers,
  generalized `/v1/...` upstream URL generation, Anthropic Messages URL
  generation, native Gemini path parsing and upstream URL generation, relay
  cache key normalization, token fingerprinting, JSON/SSE usage parsing,
  Responses `response.completed` usage parsing, GPT image generation usage
  parsing, nested usage token details, Anthropic cache usage details,
  Anthropic streaming `message_start`/`message_delta` usage merging, Gemini
  generate and embedding `usageMetadata` parsing, Gemini `countTokens`
  `totalTokens` parsing, Jina/Cohere rerank URL and usage parsing including
  Cohere `search_units`, split streaming byte chunks, and versioned
  token/channel cache wrappers.
- `cargo test -p cinatoken-migration` covering `dev-seed` SQL generation.
- `cargo test -p cinatoken-migration` covering source repository inspection
  argument parsing and local SQLite candidate discovery.
- `cargo test -p cinatoken-migration` covering SQLite export argument parsing,
  default core table selection, `--all`, and unknown-table rejection.
- `cargo test -p cinatoken-migration` covering D1 import SQL argument parsing,
  supported-table validation, SQL literal escaping, and `abilities.group` to
  `abilities.group_name` mapping.
- `cargo test -p cinatoken-migration` covering migration verification argument
  parsing, export-bundle validation, malformed-row rejection, and D1 SQL
  execution against SQLite.
- `bun run inspect:source -- --repo Z:\cinatoken` confirming the source
  checkout has the expected Go/backend/frontend markers.
- Smoke-tested `cinatoken-migrate export --sqlite ... --output ... --table users
  --table tokens` against a temporary SQLite database; JSON output included both
  tables and expected rows.
- Smoke-tested `bun run export:sqlite` followed by `bun run import:d1-sql`
  against a temporary SQLite source database, then executed the generated SQL
  with `python tools/verify_sqlite.py --seed <generated.sql>`.
- Smoke-tested `bun run verify:migration -- --input <export.json> --sql
  <generated.sql>` against a generated export and D1 SQL pair.
- `cargo test -p cinatoken-billing` covering quota conversion, settlement
  primitives, billing expression version/variable detection, expression
  execution helpers, request `param()`/`header()` probes, tiered
  pre-consume/post-consume settlement snapshots, and GPT/OpenAI versus Claude
  token normalization.
- `cargo test -p cinatoken-storage` covering shared storage record helpers.
- `cargo test -p cinatoken-cache` covering Upstash REST command encoding,
  response/error parsing, `/multi-exec` expiring counters, and rate limiter
  decisions.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` covering the
  Worker Upstash Redis REST fetch transport and status feature detection.
- `cargo test -p cinatoken-worker --lib` covering relay rate-limit and
  read-through cache TTL configuration parsing and invalid configuration
  rejection, chat/completions/responses/image generation/audio speech,
  Anthropic, and native Gemini streaming relay gating, D1 provider-family
  channel filters, native Gemini embedding/count non-stream action gating, D1
  billing option parsing, tiered settlement metadata, D1 quota mutation
  guardrails, and the Worker crate after D1 SQL was moved behind repository
  functions.
- `cargo test -p cinatoken-worker --lib` covering Worker request-body token
  estimation, max-token extraction, request-time tiered billing preflight
  snapshots, usage-detail token normalization, and settlement deltas against
  frozen snapshots.
- `cargo test -p cinatoken-worker --lib` covering `/v1/rerank` endpoint
  metadata, Jina channel type `38`, Cohere channel type `34`, local
  non-streaming rejection, Go-compatible `query`/`documents` and integer
  `top_n` validation, Cohere rerank request adaptation, Cohere rerank response
  transformation and request-estimate fallback, rerank request-token estimates, and
  endpoint-specific Jina/Cohere rerank usage parsing.
- `cargo test -p cinatoken-worker --lib` covering visible request-body media
  fallback counts for OpenAI-style and Gemini-style token preflight estimates,
  including request-time `img`/`ai` normalization when expressions reference
  those variables.
- `cargo test -p cinatoken-worker --lib` covering tiered reserve
  fallback/refund metadata and compiling the D1 repository pre-consume quota
  mutation paths.
- `cargo test -p cinatoken-worker --lib` covering tiered usage-log display
  metadata, Go-compatible base64 expression encoding, and matched-tier
  injection.
- `cargo test -p cinatoken-worker --lib` compiling the non-stream cloned
  upstream audit branch and buffered fallback path.
- `cargo test -p cinatoken-worker --lib` covering audio speech endpoint
  routing metadata and response-body usage parsing opt-out.
- `cargo test -p cinatoken-worker --lib` covering streaming missing-usage
  refund reason metadata and compiling the Worker streaming audit/reserve path
  for chat, completions, responses, image generation, Anthropic, and native
  Gemini.
- `cargo test -p cinatoken-worker --lib` covering relay JSON request-body
  limit configuration, invalid limit rejection, invalid JSON reporting, and
  payload-too-large errors before parsing.
- No live Jina or Cohere `/v1/rerank` upstream request has been executed yet.
- `bun run dev:seed:sql -- --model gpt-test --token-key ct-test --output .wrangler/dev-seed-test.sql`
  with a local Cargo target directory.
- Python `sqlite3` in-memory execution of `migrations/d1/0001_core.sql` plus
  generated dev seed SQL.
- `python tools/verify_sqlite.py`
- `cargo --version`: `cargo 1.96.0 (30a34c682 2026-05-25)`
- `rustc --version`: `rustc 1.96.0 (ac68faa20 2026-05-25)`
- `bun --version`: `1.3.14`
- `wrangler --version`: `4.101.0`
- Added local Cloudflare preflight scripts:
  `bun run check:cf:dry-run` for `wrangler deploy --dry-run --minify` and
  `bun run check:cf:startup` for `wrangler check startup` over a dry-run
  deploy.

## Local Notes

The preferred workspace is now `C:\cinagroup\cinatoken-rust`, which avoids the
VirtualBox/shared-drive file-lock issues seen under `Z:`. If the old `Z:`
checkout is used, move Cargo output to a local temp directory before running
checks:

```powershell
$env:CARGO_HTTP_TIMEOUT='120'
$env:CARGO_NET_RETRY='10'
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check
```

## Still Pending

- `worker-build` installation previously exceeded the local command timeout.
  Install it with `bun run install:worker-build`, then run `bun run dev` and
  the Cloudflare preflight scripts.
- `bun run check:cf:dry-run` and `bun run check:cf:startup` currently reach
  Wrangler's custom build step but fail on this machine because `worker-build`
  is not installed.
- `wrangler d1 migrations apply cinatoken-rust-db --local` currently fails on
  this Windows/shared-drive machine with `write EOF` from Wrangler's local D1
  process. The same schema and seed SQL pass SQLite execution.
- `wrangler dev` has not been run end-to-end with a real D1 database binding.
- No live upstream provider request has been executed yet.
- Streaming chat completion, completion, response, image generation, Anthropic
  Messages, and native Gemini passthrough have compile/unit coverage only; they
  have not been exercised against live upstream SSE responses yet.
- No source SQLite file or SQL DSN is available in the current shell, so real
  source row counts have not been captured yet.
