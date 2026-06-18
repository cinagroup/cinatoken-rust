# Relay MVP

## Implemented

These endpoints currently support non-stream OpenAI-compatible requests:

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

The Worker:

- parses the request body as `serde_json::Value`, preserving unknown fields and
  explicit zero values;
- rejects `stream: true` on chat/completions/responses with `501`;
- accepts API keys from `Authorization: Bearer ...` or `x-api-key`;
- authenticates the token and user from D1;
- checks token status, user status, expiry, token quota presence, user quota
  presence, token model limits, and token IP allowlist;
- marks expired or exhausted tokens in D1 on a best-effort basis;
- selects the first enabled channel from `abilities` matching group and model,
  ordered by ability priority, ability weight, channel priority, and channel ID;
- falls back to channel CSV matching when no ability row exists;
- limits relay candidates to OpenAI-compatible provider types
  `1, 20, 40, 42, 43, 48, 53`;
- applies `model_mapping` when it is a JSON object from source model to
  upstream model;
- forwards the original JSON body to the matching upstream `/v1/...` endpoint;
- returns the upstream body, status, and content type to the client;
- updates token `accessed_time`, increments user `request_count`, and writes a
  zero-quota consume audit log with parsed usage token counts.
- optionally enforces token/IP rate limits when Upstash Redis and relay limit
  environment variables are configured.

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

- Streaming is not implemented yet.
- Formal pre-consume and post-consume quota settlement is not implemented yet.
- The audit log uses `quota = 0` and `other.billing_pending = true`.
- Provider-specific request transforms are not implemented yet.
- Channel weighting, retry, auto-ban, and health scoring are not implemented yet.
- Cache acceleration is not connected to token/channel relay lookups yet.

Full settlement should port the original billing expression flow before any
real quota decrement:

- pre-consume estimate and frozen billing snapshot;
- actual usage extraction;
- token normalization based on expression variables;
- group ratio and quota conversion;
- log display metadata for matched tier and expression details.
