# Relay MVP

Production route/provider parity evidence is tracked in
`docs/route-provider-parity-runbook.md`. This file describes the current
implementation shape; the runbook controls G3 smoke, body-mode, provider
adapter, billing-shadow, and rollback evidence.

## Implemented

These endpoints currently support OpenAI-compatible requests:

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/rerank`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`

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
`POST /v1/images/generations`, and native `POST /v1/messages` also support
streaming passthrough when the request body includes `stream: true`. Native
Gemini `streamGenerateContent` paths stream with upstream `alt=sse`.
Embeddings and rerank remain non-streaming in this MVP.

The Worker:

- marks current relay endpoints with an explicit JSON request-body mode and
  reads those JSON bodies through a shared bounded request-byte reader before
  parsing them as `serde_json::Value`, preserving unknown fields and explicit
  zero values;
- defines inactive multipart, raw-bytes, and pass-through stream request-body
  modes with metadata and guarded 501 handling if they are wired before their
  extraction/forwarding implementation is complete;
- routes request `Content-Type` checks through a shared policy layer; JSON
  relay endpoints reject explicit non-JSON bodies before reading while still
  allowing absent `Content-Type` for OpenAI-compatible client tolerance;
- defaults the relay JSON body limit to 4 MiB and allows operators to override
  it with `RELAY_JSON_BODY_LIMIT_BYTES`; values must be positive integers;
- reads non-streaming JSON response bodies for audit parsing and Cohere rerank
  transformation through a bounded reader; general JSON responses default to
  4 MiB, embeddings/image/rerank/Gemini responses have endpoint-specific
  larger defaults, and operators can override all of them with
  `RELAY_JSON_RESPONSE_LIMIT_BYTES`;
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
- walks the full ordered candidate list and retries against the next candidate
  when an upstream returns a retryable status (Go-default
  `AutomaticRetryStatusCodeRanges` minus 504/524) or fetch fails;
  `RELAY_RETRY_TIMES` controls the retry budget (default 0 = single attempt,
  matching the historical behavior);
- when a channel returns the auto-disable status set (default `{401}`) or
  exceeds `RELAY_CHANNEL_AUTOBAN_THRESHOLD` (default 5) rolling errors in a
  60s Upstash Redis window, marks the channel auto-disabled best-effort via
  `disable_channel_best_effort`;
- limits generic OpenAI-compatible relay candidates to the Go `openai.Adaptor`
  types `1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47`; dedicated OpenAI-shaped
  providers are admitted only through route-explicit capabilities. Current
  dedicated Partial adapters include Moonshot(25), Perplexity(27),
  SiliconFlow(40), Mistral(42), DeepSeek(43), xAI(48), and Submodel(53), while
  their unsupported routes fail before quota reserve. Moonshot is a direct-only
  OpenAI/Claude bridge for chat, completions, embeddings, rerank, and Messages;
  SiliconFlow is direct-only and explicitly
  exposes chat/completions, legacy completions, embeddings, rerank, and image
  generations;
- limits `/v1/rerank` relay candidates to Moonshot provider type `25`, Jina
  provider type `38`, Cohere provider type `34`, and SiliconFlow provider type
  `40`;
- limits Anthropic Messages relay candidates to native Anthropic provider type
  `14`, Moonshot bridge type `25`, and DeepSeek bridge type `43`;
- limits native Gemini relay candidates to Gemini provider type `24`;
- applies `model_mapping` when it is a JSON object from source model to
  upstream model, including native Gemini path models and nested Gemini
  request-body `model` fields such as batch embedding requests;
- forwards the original JSON body to the matching upstream `/v1/...` endpoint
  unless a provider-specific adapter is required;
- validates `/v1/rerank` JSON requests with Go-compatible `query` and
  non-empty `documents` checks before forwarding;
- forwards Jina `/v1/rerank` requests as JSON passthrough and adapts Cohere
  rerank requests to the Go-compatible upstream shape with `top_n >= 1` and
  `return_documents = true`;
- forwards native Anthropic Messages requests with `x-api-key`,
  `anthropic-version`, and optional `anthropic-beta` headers;
- forwards native Gemini requests with `x-goog-api-key` and strips downstream
  `key` query parameters before calling the upstream provider;
- returns the upstream body, status, and content type to the client;
- for non-streaming relays with a Worker `Context`, returns the upstream
  response directly and consumes a cloned audit branch in `wait_until`;
- returns upstream chat completion, completion, response, image generation,
  Anthropic Messages, and native Gemini streams without buffering the full
  response;
- returns upstream audio speech binary or audio-event responses without
  buffering or parsing the response body;
- parses OpenAI-compatible usage metadata from JSON responses and streaming
  SSE `data:` events, including cached/cache-creation, GPT image generation
  output image tokens, and image/audio input/output token details;
- parses Anthropic Messages usage metadata, including streaming
  `message_start`/`message_delta` SSE events, with Claude cache-read and
  cache-creation token semantics for tiered settlement;
- parses Gemini `usageMetadata` from JSON responses and native SSE `data:`
  chunks, plus Gemini `countTokens` `totalTokens` responses, including cached,
  image, and audio token details;
- transforms successful Cohere rerank JSON responses into unified
  `{results, usage}` responses and parses Cohere `meta.billed_units`
  input/output tokens or `search_units` for audit and settlement;
- tees streaming chat completion, completion, response, image generation,
  Anthropic Messages, and native Gemini responses so `wait_until` can consume
  an audit branch incrementally without blocking the client stream;
- updates token `accessed_time`, increments user `request_count`, and writes
  consume audit logs with parsed usage token counts;
- reads Go-compatible `billing_setting.billing_mode`,
  `billing_setting.billing_expr`, and group-ratio options from D1 `options`;
- before forwarding successful candidates upstream, builds a request-time
  tiered-expression preflight snapshot from the original request body,
  request probes, group ratio, a prompt/completion token estimate, and visible
  request-body media fallback counts, then normalizes request-time
  image/audio variables the same way settlement does;
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
- writes streaming chat completion, completion, response, image generation,
  Anthropic Messages, and native Gemini audit logs via `wait_until` after the
  audit stream branch is consumed;
- writes non-streaming chat completion, completion, response, embedding,
  rerank, image generation, audio speech, Anthropic Messages, and native
  Gemini audit logs via `wait_until` when the Worker can clone the upstream
  response;
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
  requested model. OpenAI-compatible endpoints, including image generation and
  audio speech, currently support types `1, 20, 40, 42, 43, 48, 53`;
  `/v1/rerank` currently supports Jina type `38` and Cohere type `34`;
  `/v1/messages` currently supports type `14`; native Gemini
  generate-content, embedding, and token-count endpoints currently support type
  `24`.
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
- OpenAI-compatible image generation supports JSON and SSE passthrough; image
  edits are now wired via the multipart/raw-body relay path.
- OpenAI-compatible audio speech supports JSON request passthrough and
  unparsed audio/SSE response passthrough; audio transcription and translation
  are now wired via the multipart/raw-body relay path (model extracted from
  the `model` form field; body forwarded verbatim with boundary preserved).
- The current relay body layer supports JSON and multipart/form-data
  request-body modes backed by shared content-type policy and a bounded byte
  reader. Raw-bytes and pass-through stream modes are defined but
  intentionally inactive (raw-bytes is available for future binary endpoints;
  pass-through streaming is deferred).
- Rerank support currently covers Jina JSON passthrough and Cohere JSON
  request/response adaptation. Other provider-specific rerank transforms plus
  live upstream coverage are still pending.
- Buffered response limits now have endpoint-specific defaults for current JSON
  relays. Additional provider-specific response transforms still need explicit
  size policies before they are added.
- Streaming usage reconciliation is wired for OpenAI-compatible SSE usage
  chunks, Anthropic Messages cumulative usage events, and Gemini
  `usageMetadata` chunks, but live upstream SSE coverage is still pending.
- Streaming tiered reserve is applied before the upstream call, but live
  upstream SSE reserve/refund/delta behavior still needs end-to-end coverage.
- Request-time token estimation currently covers JSON-body text, max-token
  extraction, visible media fallback counts, and Go-compatible request-time
  `img`/`ai` normalization. Exact tokenizer counts plus image dimension/audio
  duration parity are still pending.
- Non-tiered billing still uses `quota = 0` and `other.billing_pending = true`.
- Provider-specific request transforms are implemented for Cohere rerank only.
- Channel retry, fallback, and best-effort auto-disable are implemented (see
  above), but channel weighting (weighted-random selection within a priority
  tier) and live response-time-based health scoring are not implemented yet.
  The current candidate list is purely priority-then-weight-ordered and the
  retry loop walks it sequentially.
- The retry/auto-ban policy uses the Go-default
  `AutomaticRetryStatusCodeRanges` / `AutomaticDisableStatusCodeRanges` hard
  coded. Operator-configurable status-code ranges (read from options like
  billing expressions) are TODO with the admin option API.
- Token/channel cache invalidation is TTL-based; explicit invalidation still
  needs to be added when dashboard/admin mutation paths are ported.

Full settlement still needs to complete the remaining request-time side of the
original billing expression flow:

- exact tokenizer counts plus image dimension/audio duration parity for the
  preflight token estimate.
- Audio transcription/translation billing currently uses 0 tokens when the
  upstream returns no `usage` block (whisper does not). A per-duration
  estimator (1000 tokens/minute from mp3/wav duration) is the Go behavior
  and remains to be ported; until then operators should configure a flat
  `ModelPrice` for whisper models.
