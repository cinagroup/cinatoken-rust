# Relay MVP

## Implemented

These endpoints currently support OpenAI-compatible requests:

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

The Worker also supports native Anthropic Messages requests:

- `POST /v1/messages`

The Worker also supports native Gemini generate content and embedding requests:

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `POST /v1beta/models/{model}:embedContent`
- `POST /v1beta/models/{model}:batchEmbedContents`
- `POST /v1beta/models/{model}:countTokens`
- `POST /v1/models/{model}:generateContent`
- `POST /v1/models/{model}:streamGenerateContent`
- `POST /v1/models/{model}:embedContent`
- `POST /v1/models/{model}:batchEmbedContents`
- `POST /v1/models/{model}:countTokens`

`POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/responses`,
and native `POST /v1/messages` also support streaming passthrough when the
request body includes `stream: true`. Native Gemini `streamGenerateContent`
paths stream with upstream `alt=sse`. Embeddings remain non-streaming in this
MVP.

The Worker:

- parses the request body as `serde_json::Value`, preserving unknown fields and
  explicit zero values;
- keeps embeddings non-streaming in this MVP;
- accepts API keys from `Authorization: Bearer ...`, `x-api-key`,
  `x-goog-api-key`, or native Gemini `key` query parameters;
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
- limits OpenAI-compatible relay candidates to provider types
  `1, 20, 40, 42, 43, 48, 53`;
- limits Anthropic Messages relay candidates to native Anthropic provider type
  `14`;
- limits native Gemini relay candidates to Gemini provider type `24`;
- applies `model_mapping` when it is a JSON object from source model to
  upstream model, including native Gemini path models and nested Gemini
  request-body `model` fields such as batch embedding requests;
- forwards the original JSON body to the matching upstream `/v1/...` endpoint;
- forwards native Anthropic Messages requests with `x-api-key`,
  `anthropic-version`, and optional `anthropic-beta` headers;
- forwards native Gemini requests with `x-goog-api-key` and strips downstream
  `key` query parameters before calling the upstream provider;
- returns the upstream body, status, and content type to the client;
- returns upstream chat completion, completion, response, Anthropic Messages,
  and native Gemini streams without buffering the full response;
- parses OpenAI-compatible usage metadata from JSON responses and streaming
  SSE `data:` events, including cached/cache-creation and image/audio
  input/output token details;
- parses Anthropic Messages usage metadata, including streaming
  `message_start`/`message_delta` SSE events, with Claude cache-read and
  cache-creation token semantics for tiered settlement;
- parses Gemini `usageMetadata` from JSON responses and native SSE `data:`
  chunks, plus Gemini `countTokens` `totalTokens` responses, including cached,
  image, and audio token details;
- tees streaming chat completion, completion, response, Anthropic Messages, and
  native Gemini responses so `wait_until` can consume an audit branch
  incrementally without blocking the client stream;
- updates token `accessed_time`, increments user `request_count`, and writes
  consume audit logs with parsed usage token counts;
- reads Go-compatible `billing_setting.billing_mode`,
  `billing_setting.billing_expr`, and group-ratio options from D1 `options`;
- before forwarding successful candidates upstream, builds a request-time
  tiered-expression preflight snapshot from the original request body,
  request probes, group ratio, a prompt/completion token estimate, and visible
  request-body media fallback counts;
- for tiered-expression requests, reserves the estimated wallet/token quota
  before upstream relay and refunds it if upstream forwarding fails or no
  billable usage is returned;
- refreshes cached token quota state from D1 before auth validation so quota
  mutation is not hidden by read-through cache TTLs;
- for successful tiered-expression responses with usage metadata, settles final
  tiered quota against the frozen preflight snapshot, normalizes actual token
  parameters according to the frozen expression's variable usage, applies only
  the delta from pre-consumed quota, increments user/channel usage counters,
  records metadata under `other.tiered_billing`, and adds top-level
  usage-log display fields `billing_mode`, `expr_b64`, and `matched_tier`;
- if post-response tiered expression evaluation fails after a successful
  reserve, falls back to the pre-consumed quota and records
  `other.tiered_billing_fallback`;
- if tiered quota mutation cannot be applied, keeps the audit log pending and
  records the computed result under `other.tiered_billing_shadow` plus an error;
- writes streaming chat completion, completion, response, Anthropic Messages,
  and native Gemini audit logs via `wait_until` after the audit stream branch
  is consumed;
- optionally enforces token/IP rate limits when Upstash Redis and relay limit
  environment variables are configured;
- caches validated token auth rows and selected relay channels in Upstash Redis
  when Redis is configured and `RELAY_CACHE_TTL_SECONDS` is not `0`; channel
  cache keys include endpoint provider family to avoid cross-provider reuse.

## D1 Data Requirements

The MVP expects tables from `migrations/d1/0001_core.sql` and at least:

- a `users` row with `status = 1` and positive `quota`;
- a `tokens` row with `status = 1`, matching `"key"`, positive
  `remain_quota` unless `unlimited_quota = 1`, and a valid `user_id`;
- a `channels` row with `status = 1`, a supported `type`, non-empty `"key"`,
  matching `"group"`, and either empty `models` or a CSV entry for the
  requested model. OpenAI-compatible endpoints currently support types
  `1, 20, 40, 42, 43, 48, 53`; `/v1/messages` currently supports type `14`;
  native Gemini generate-content, embedding, and token-count endpoints
  currently support type `24`.
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

- Anthropic Messages relay is native-format only; OpenAI-to-Claude request
  conversion is still pending.
- Native Gemini relay currently supports generateContent,
  streamGenerateContent, embedContent, batchEmbedContents, and countTokens
  passthrough;
  OpenAI-to-Gemini request conversion, asyncBatchEmbedContent, and image/video
  task paths are still pending.
- Streaming usage reconciliation is wired for OpenAI-compatible SSE usage
  chunks, Anthropic Messages cumulative usage events, and Gemini
  `usageMetadata` chunks, but live upstream SSE coverage is still pending.
- Streaming tiered reserve is applied before the upstream call, but live
  upstream SSE reserve/refund/delta behavior still needs end-to-end coverage.
- Request-time token estimation currently covers JSON-body text, max-token
  extraction, and visible media fallback counts. Exact tokenizer counts plus
  image dimension/audio duration parity are still pending.
- Non-tiered billing still uses `quota = 0` and `other.billing_pending = true`.
- Provider-specific request transforms are not implemented yet.
- Channel weighting, retry, auto-ban, and health scoring are not implemented yet.
- Token/channel cache invalidation is TTL-based; explicit invalidation still
  needs to be added when dashboard/admin mutation paths are ported.

Full settlement still needs to complete the remaining request-time side of the
original billing expression flow:

- exact tokenizer counts plus image dimension/audio duration parity for the
  preflight token estimate.
