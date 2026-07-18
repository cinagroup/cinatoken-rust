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
  dedicated Partial adapters include Moonshot(25), ZhipuV4(26), Perplexity(27),
  Jina(38), SiliconFlow(40), Mistral(42), DeepSeek(43), VolcEngine(45),
  BaiduV2(46), xAI(48), and Submodel(53), while their unsupported routes fail
  before quota reserve. Moonshot is a direct-only
  OpenAI/Claude bridge for chat, completions, embeddings, rerank, and Messages;
  SiliconFlow is direct-only and explicitly
  exposes chat/completions, legacy completions, embeddings, rerank, and image
  generations; ZhipuV4 is direct-only and exposes chat/completions, embeddings,
  image generations, and Messages, while legacy type 16 remains Deferred.
  VolcEngine is direct-only for Ark v3 chat, embeddings, image generations, and
  Responses; BaiduV2 is direct-only for Qianfan v2 chat with source-compatible
  search and appid handling. Neither enters the existing AI Gateway/WFP paths.
  Usage-less successful image JSON settles under an explicit request-contract
  audit source without fabricating provider token usage;
- limits `/v1/rerank` relay candidates to Moonshot provider type `25`, Jina
  provider type `38`, Cohere provider type `34`, and SiliconFlow provider type
  `40`;
- admits Jina provider type `38` to `/v1/embeddings`, removes the OpenAI-only
  `encoding_format` field at the provider adapter boundary, and preserves
  Jina-native embedding fields;
- limits Anthropic Messages relay candidates to native Anthropic provider type
  `14`, Moonshot bridge type `25`, ZhipuV4 bridge type `26`, and DeepSeek bridge
  type `43`;
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
- for successful non-streaming usage-bearing relays, performs bounded usage
  inspection and billing observation before returning; an intact
  uninspectable 2xx is forwarded only for a positive frozen tiered reserve,
  while flat or zero-reserve traffic fails closed before delivery;
- returns upstream chat completion, completion, response, image generation,
  Anthropic Messages, and native Gemini streams without buffering the full
  response;
- returns upstream audio speech binary or audio-event responses without
  parsing the response body, but synchronously applies the usage-less request
  contract so configured fixed-price billing completes before delivery;
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

## Admin Channel Probe Contract

`POST /api/channel/test/:id` accepts a bounded JSON object with optional
`model`, `endpoint_type`, and `stream`; the existing GET route remains as a
strict query-compatible shim. Endpoint values are `auto`, `openai`,
`openai-response`, `openai-response-compact`, `anthropic`, `gemini`,
`jina-rerank`, `image-generation`, and `embeddings`. Unknown fields, unknown
endpoint values, surrounding model whitespace, incompatible streaming, and
unsupported channel capabilities fail before provider egress.

The executor reuses production model mapping, provider transforms, URL/header
construction, and direct, AI Gateway REST, WFP, or Workers AI transport
selection. It requires a route-specific bounded JSON response for non-stream
tests or a route-specific non-DONE JSON SSE event for stream tests, all within
15 seconds. Channel health timestamps are persisted only after this validation.
The response includes requested and effective model/endpoint/stream values,
effective route and transport, content type, validation mode, and
`response_validated=true`; provider keys and response bodies are never returned.

`GET /api/channel/test` applies the same executor to a bounded batch. It scans
at most 100 enabled rows, permits at most 12 eligible single-key probes with
concurrency 3, writes successful measurements in one D1 batch, and exposes only
aggregate counts. Full-fleet unattended health checking remains a
Queue/Workflow concern.

## D1 Data Requirements

The MVP expects tables from `migrations/d1/0001_core.sql` and at least:

- a `users` row with `status = 1` and positive `quota`;
- a `tokens` row with `status = 1`, matching `"key"`, positive
  `remain_quota` unless `unlimited_quota = 1`, and a valid `user_id`;
- a `channels` row with `status = 1`, a supported `type`, non-empty `"key"`,
  matching `"group"`, and either empty `models` or a CSV entry for the
  requested model. Route eligibility comes from the provider capability
  registry rather than a shared static OpenAI-shaped type list; dedicated type
  17 is summarized below;
  `/v1/rerank` currently supports Ali type `17` for `gte-rerank-v2`, Jina type
  `38`, and Cohere type `34`; Jina
  type `38` is also explicitly supported by `/v1/embeddings`;
  `/v1/messages` currently supports native Anthropic type `14` and Ali type
  `17` for the configured native model patterns; native Gemini
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
  edits are wired via the multipart/raw-body relay path. Ali type 17 adds a
  direct-only synchronous adapter: generation JSON and up to 16 multipart edit
  images (12 MiB total) are converted to native DashScope JSON, responses are
  converted back to OpenAI image shape behind an 8 MiB parse bound, and flat
  settlement replaces request `n` with positive provider `usage.image_count`
  or converted output count. Asynchronous Ali models and Wan edits fail before
  reserve.
- OpenAI-compatible audio speech supports JSON request passthrough and
  unparsed audio/SSE response passthrough; audio transcription and translation
  are now wired via the multipart/raw-body relay path (model extracted from
  the `model` form field; body forwarded verbatim with boundary preserved).
- The current relay body layer supports JSON and multipart/form-data
  request-body modes backed by shared content-type policy and a bounded byte
  reader. Raw-bytes and pass-through stream modes are defined but
  intentionally inactive (raw-bytes is available for future binary endpoints;
  pass-through streaming is deferred).
- Rerank support currently covers Ali `gte-rerank-v2` conversion, Jina JSON
  passthrough, and Cohere JSON request/response adaptation. qwen3 rerank
  protocols, other provider transforms, and live upstream coverage are still
  pending.
- Jina embedding support matches the Go adapter's `/v1/embeddings` URL and
  `encoding_format` removal. Live Jina embedding usage, billing, error, and
  rollback evidence remains pending.
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
- Provider-specific request transforms are owned by the dedicated adapters in
  the capability registry; unlisted provider/route pairs remain fail-closed.
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
## 2026-07-13 Ali DashScope Direct Adapter Boundary

Channel type 17 is now Partial through a dedicated direct-only provider
adapter. The admitted routes are `/v1/chat/completions`, `/v1/completions`,
`/v1/responses`, `/v1/embeddings`, `/v1/messages`, and `/v1/rerank`.
OpenAI-shaped routes use the current `/compatible-mode/v1` contract; Messages
uses `/apps/anthropic/v1/messages` only for source-native model patterns; and
rerank uses a bounded provider-native request/response conversion.

The adapter preserves the source `top_p` clamp and streaming
`X-DashScope-SSE: enable` header. OpenAI-shaped main, fallback, and Admin SSE
paths share the same `stream_options.include_usage` policy; native Messages
keeps Anthropic usage semantics. Messages defaults to the source-native model
patterns and accepts a bounded `ALI_ANTHROPIC_MESSAGES_MODELS` operator
override. Rerank currently admits only `gte-rerank-v2`. Optional
`X-DashScope-Plugin` is derived only from printable server-side
`channels.other` up to 4 KiB, and relay cache schema v4 prevents older cached
channels from omitting that configuration. Unsupported asynchronous image
polling, remote provider image fetch, audio, Gemini, non-native Messages, and
qwen3 rerank paths fail before quota reserve. AI Gateway and WFP are also
rejected because this repository has no managed DashScope provider contract in
either transport. Admin Channel Test, including legacy Completions, and
frontend readiness consume the same six-route registry. This is local contract
evidence only; production remains **NO-GO** pending route-specific staging,
billing/audit reconciliation, and rollback proof.

## 2026-07-15 Ali Synchronous Image Safety Closure

Ali synchronous generation and non-Wan edits now use the DashScope multimodal
endpoint with actual-count flat settlement. `ALI_SYNC_IMAGE_MODELS` is a
bounded replacement for the audited Go default patterns and is applied at
candidate filtering, Admin Channel Test, and native request conversion.

Multipart edit conversion retains at most 16 matching files, stops at the 17th,
rejects part headers above 8 KiB, caps image bytes at 12 MiB, and verifies image
signatures. Provider JSON is capped at 8 MiB and response metadata is reduced so
image payloads are not serialized twice. `b64_json` never fetches provider URLs;
a URL-only or partial conversion is a 502/refund, not an empty billed success.
Async submit/poll settlement and live provider/invoice evidence remain NO-GO.

## 2026-07-13 Tencent Hunyuan Direct Adapter Boundary

Channel type 23 is Partial for only `/v1/chat/completions` with a
non-streaming, text-only request. The dedicated adapter targets the fixed
Hunyuan API host/action/version, preserves the Go credential shape
`appId|secretId|secretKey`, and computes request-local TC3-HMAC-SHA256 headers
over the exact serialized provider body. appId is validated for source
compatibility but is not part of the provider request or TC3 signature.

The request converter admits only model, messages, stream=false/null, top_p,
and temperature; unsupported root/message fields and non-text content fail
before reserve. AI Gateway, WFP, custom base URLs, and streaming also fail
before reserve. Provider HTTP-200 `Response.Error` envelopes are mapped into
owned 4xx/429/5xx responses before the shared retry loop chooses a winner, so
failed attempts cannot create successful affinity or settlement. Successful
direct/enveloped responses are bounded and converted to the OpenAI shape with
usage required; the optional provider `Note` remains a bounded extension.

This is local contract evidence, not live Tencent parity. Rotated-credential
staging must still prove TC3 acceptance, UTC/skew behavior, error/retry classes,
usage, reserve/settle/refund, D1/provider reconciliation, disable/recovery, and
Go rollback. Production remains **NO-GO**.

## 2026-07-18 Provider Response Boundary

Buffered JSON responses now use the shared `go-openai-response-v1` interpreter
before audit, estimation, settlement, affinity success, or client delivery.
Only exact HTTP 200 with an object body and no typed top-level error is ordinary
success. A typed error inside HTTP 200 keeps client status 200 but uses failure
audit semantics; malformed HTTP-200 bodies become local `bad_response_body`
errors; every non-200 response is rebuilt as a compatible local error envelope.

Successful responses expose only the six shared public headers documented in
`docs/response-interpreter-production-plan.md`. Provider headers are never
inherited by interpreted errors. Requested streaming enters the streaming path
only for an exact upstream 200; a non-200 response to a streaming request is
buffered and interpreted instead. The existing stream accumulator continues to
retain usage observed before an interrupted read.

This is local packet-1 semantics, not Container production parity. Receipt v1
remains immutable, and Container canary remains blocked on response-artifact
migration 0052, protocol v3, durable raw/client artifacts, financial terminal
ownership, remote faults, and approvals. Production remains **NO-GO**.
