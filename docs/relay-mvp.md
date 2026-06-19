# Relay MVP

## Implemented

These endpoints currently support OpenAI-compatible requests:

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

`POST /v1/chat/completions` also supports streaming passthrough when the request
body includes `stream: true`. The other endpoints remain non-streaming in this
MVP.

The Worker:

- parses the request body as `serde_json::Value`, preserving unknown fields and
  explicit zero values;
- rejects `stream: true` on completions/responses with `501`;
- accepts API keys from `Authorization: Bearer ...` or `x-api-key`;
- authenticates the token and user through Upstash-backed read-through cache
  with D1 fallback;
- checks token status, user status, expiry, token quota presence, user quota
  presence, token model limits, and token IP allowlist;
- marks expired or exhausted tokens in D1 on a best-effort basis;
- selects the first enabled channel through Upstash-backed read-through cache
  with D1 fallback;
- on channel cache miss, uses `abilities` matching group and model, ordered by
  ability priority, ability weight, channel priority, and channel ID;
- falls back to channel CSV matching when no ability row exists;
- limits relay candidates to OpenAI-compatible provider types
  `1, 20, 40, 42, 43, 48, 53`;
- applies `model_mapping` when it is a JSON object from source model to
  upstream model;
- forwards the original JSON body to the matching upstream `/v1/...` endpoint;
- returns the upstream body, status, and content type to the client;
- returns upstream chat completion streams without buffering the full response;
- parses OpenAI-compatible usage metadata from JSON responses and streaming
  SSE `data:` events;
- tees streaming chat responses so `wait_until` can consume an audit branch
  incrementally without blocking the client stream;
- updates token `accessed_time`, increments user `request_count`, and writes
  consume audit logs with parsed usage token counts;
- reads Go-compatible `billing_setting.billing_mode`,
  `billing_setting.billing_expr`, and group-ratio options from D1 `options`;
- before forwarding successful candidates upstream, builds a request-time
  tiered-expression preflight snapshot from the original request body,
  request probes, group ratio, and a lightweight prompt/completion token
  estimate;
- for non-streaming tiered-expression requests, reserves the estimated
  wallet/token quota before upstream relay and refunds it if upstream forwarding
  fails or no billable usage is returned;
- refreshes cached token quota state from D1 before auth validation so quota
  mutation is not hidden by read-through cache TTLs;
- for successful non-streaming tiered-expression responses with usage metadata,
  settles final tiered quota against the frozen preflight snapshot, applies
  only the delta from pre-consumed quota, increments user/channel usage
  counters, and records metadata under `other.tiered_billing`;
- for successful streaming tiered-expression responses with usage metadata,
  settles final tiered quota after the full stream is consumed; streaming
  pre-consume reserve is not wired yet;
- if post-response tiered expression evaluation fails after a successful
  reserve, falls back to the pre-consumed quota and records
  `other.tiered_billing_fallback`;
- if tiered quota mutation cannot be applied, keeps the audit log pending and
  records the computed result under `other.tiered_billing_shadow` plus an error;
- writes streaming chat completion audit logs via `wait_until` after the audit
  stream branch is consumed;
- optionally enforces token/IP rate limits when Upstash Redis and relay limit
  environment variables are configured;
- caches validated token auth rows and selected relay channels in Upstash Redis
  when Redis is configured and `RELAY_CACHE_TTL_SECONDS` is not `0`.

## D1 Data Requirements

The MVP expects tables from `migrations/d1/0001_core.sql` and at least:

- a `users` row with `status = 1` and positive `quota`;
- a `tokens` row with `status = 1`, matching `"key"`, positive
  `remain_quota` unless `unlimited_quota = 1`, and a valid `user_id`;
- a `channels` row with `status = 1`, an OpenAI-compatible `type`, non-empty
  `"key"`, matching `"group"`, and either empty `models` or a CSV entry for the
  requested model.
- preferably an `abilities` row with matching `group_name`, `model`,
  `channel_id`, and `enabled = 1`.

`channels.key` may be a newline-separated key list or a JSON string array. The
first non-empty key is used.

For local development, generate starter data with:

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
$env:CINATOKEN_DEV_UPSTREAM_KEY='replace-with-real-upstream-key'
bun run dev:seed:sql -- --model gpt-4o-mini --output .wrangler/dev-seed.sql
wrangler d1 execute cinatoken-rust-db --local --file .wrangler/dev-seed.sql
```

## Deliberate Limitations

- Streaming is only implemented for chat completion passthrough.
- Streaming usage reconciliation is wired for OpenAI-compatible SSE usage
  chunks, but live upstream SSE coverage is still pending.
- Tiered pre-consume reserve is currently implemented for non-streaming
  OpenAI-compatible requests only; streaming currently settles after full
  stream usage is known.
- Request-time token estimation is currently lightweight JSON-body text
  estimation and max-token extraction, not tokenizer/media parity.
- Non-tiered billing still uses `quota = 0` and `other.billing_pending = true`.
- Provider-specific request transforms are not implemented yet.
- Channel weighting, retry, auto-ban, and health scoring are not implemented yet.
- Token/channel cache invalidation is TTL-based; explicit invalidation still
  needs to be added when dashboard/admin mutation paths are ported.

Full settlement still needs to complete the remaining request-time side of the
original billing expression flow:

- streaming pre-consume reserve plus refund/additional adjustment;
- tokenizer/media parity for the preflight token estimate;
- token normalization based on expression variables;
- log display metadata for matched tier and expression details.
