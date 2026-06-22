# Phase 1 Notes

This phase creates the Rust workspace and a Cloudflare Worker MVP.

## Implemented

- Workspace crate layout.
- Worker route entrypoint.
- `GET /api/status`.
- `GET /v1/models`.
- `POST /v1/chat/completions` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/completions` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/responses` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/embeddings` non-stream OpenAI-compatible relay MVP.
- `POST /v1/rerank` non-stream rerank JSON relay MVP for Jina channel type
  `38` and Cohere channel type `34`, including Go-compatible
  `query`/`documents` request validation and Cohere request/response
  adaptation.
- `POST /v1/images/generations` OpenAI-compatible relay MVP, including
  streaming passthrough for `stream: true`.
- `POST /v1/audio/speech` OpenAI-compatible relay MVP for JSON request
  passthrough and unparsed audio/SSE response passthrough.
- `POST /v1/messages` native Anthropic Messages relay MVP for native Anthropic
  channel type `14`, including streaming passthrough for `stream: true`.
- `POST /v1beta/models/{model}:generateContent` and
  `POST /v1beta/models/{model}:streamGenerateContent` native Gemini relay MVP
  for native Gemini channel type `24`, with `/v1/...` aliases.
- `POST /v1beta/models/{model}:embedContent` and
  `POST /v1beta/models/{model}:batchEmbedContents` native Gemini embedding
  relay MVP for native Gemini channel type `24`, with `/v1/...` aliases.
- `POST /v1beta/models/{model}:countTokens` native Gemini token-count relay
  MVP for native Gemini channel type `24`, with `/v1/...` aliases.
- D1 token authentication with status, expiry, quota-presence, model-limit, and IP allowlist checks.
- Best-effort D1 token status update for expired and exhausted tokens.
- D1 channel selection for OpenAI-compatible provider types.
- D1 channel selection can now filter by endpoint provider family, including
  rerank-only selection for `/v1/rerank`, Anthropic-only selection for
  `/v1/messages`, and Gemini-only selection for native Gemini generate-content,
  embedding, and token-count endpoints.
- Ability-first channel selection with channel CSV fallback.
- Model mapping before upstream forwarding.
- Token access update, user request-count update, and zero-quota consume audit logs.
- Streaming chat completion, completion, response, image generation, and
  Anthropic Messages passthrough with pending zero-quota stream audit logs.
- Pure Rust relay helper tests for model mapping, IP allowlists, key
  selection, JSON/SSE usage parsing, and URL normalization.
- OpenAI-compatible JSON/SSE usage parsing extracts cached/cache-creation,
  Anthropic cache, GPT image generation output image tokens, and image/audio
  input/output token details for billing settlement.
- Native Gemini JSON/SSE usage parsing extracts `usageMetadata`, `countTokens`
  totals, cached content, and image/audio token details for billing settlement.
- Pure Rust billing primitives for quota rounding, price conversion,
  expression version parsing, Go-compatible expression hashing, compile-style
  metadata validation, variable detection, tiered token normalization, and
  pre-consume settlement deltas.
- Pure Rust billing expression execution foundation with `tier()`,
  conditionals, math helpers, request `param()`/`header()` probes, `has()`,
  time helpers, multimodal variables, trace capture, and `|||` request-rule
  multiplier handling.
- Pure Rust tiered billing snapshot and settlement helpers that freeze
  pre-consume expression state including expression hash, apply group ratio,
  detect tier crossing, and compute final/refund/additional quota deltas.
- Shared storage-layer record types for authenticated tokens, relay channels, and relay audit logs.
- Worker-side D1 repository boundary for auth, channel selection, token updates, user counters, and relay audit logs.
- Worker-side D1 billing option lookup and non-streaming tiered-expression
  shadow settlement metadata in audit logs.
- Worker-side request-time tiered-expression preflight snapshots with
  prompt/completion token estimates, visible request-body media fallback
  counts, expression-variable-aware `img`/`ai` normalization, frozen request
  probes, and post-response settlement against the frozen snapshot.
- Worker-side tiered-expression settlement rebuilds actual token parameters
  from upstream usage details and the frozen expression's variable usage, so
  cached/image/audio sub-categories are not double-counted in `p` or `c`.
- Cached-auth quota-state refresh plus request-time D1 reserve, failed-request
  refund, and post-response delta settlement for successful tiered-expression
  responses, including streaming chat, completions, responses, image
  generations, Anthropic Messages, and native Gemini after full-stream usage
  reconciliation.
- Worker-side tiered billing metadata now marks whether a frozen expression
  carried a request-rule multiplier without logging the full rule body.
- Successful Worker-side tiered-expression audit logs now include Go-compatible
  top-level usage-log display fields: `billing_mode`, base-expression
  `expr_b64`, and `matched_tier`.
- Worker-side streaming usage reconciliation for chat, completions, responses,
  image generations, Anthropic Messages, and native Gemini passthrough via
  response tee, incremental SSE usage parsing, and `wait_until` audit
  recording.
- Worker-side non-stream relay audit now uses a cloned upstream response branch
  in `wait_until` when a Worker `Context` is available, so the client path can
  return the original upstream response stream without buffering it first.
- Worker-side non-stream relay endpoints can opt out of response-body usage
  parsing, used by audio speech to preserve binary/audio-event passthrough.
- Worker-side non-stream JSON response usage parsing and Cohere rerank
  transformation now use bounded response-body reads with endpoint-specific
  defaults and an optional `RELAY_JSON_RESPONSE_LIMIT_BYTES` global override.
- Worker relay endpoint metadata now carries an explicit JSON request-body
  mode; the JSON preparation stage owns bounded byte reads, validation, and
  the billing request-input snapshot for current relay endpoints.
- Relay request-body reading now has a shared bounded byte reader underneath
  the JSON parser, so future raw and multipart modes can reuse the same
  content-length precheck and stream over-limit guardrails.
- JSON relay mode now preflights explicit request `Content-Type` values and
  rejects non-JSON bodies before buffering; absent `Content-Type` still falls
  through to JSON parsing for client compatibility.
- The `Content-Type` preflight is now a reusable policy layer with tested JSON,
  multipart, and raw passthrough policies; current endpoints still bind only
  JSON mode.
- Multipart, raw-bytes, and pass-through stream request-body modes now have
  explicit metadata plus guarded 501 handling if selected before their
  extraction/forwarding implementation is complete.
- First Go/Rust billing parity fixtures for multi-condition expressions,
  Claude tier boundaries, cache split pricing, `len` tiering,
  ratio-equivalent quota conversion, nested/array/missing request probes,
  request-rule multipliers, common frontend time zones, math helpers,
  multimodal variables, and used-variable detection.
- Cache traits for string KV, expiring counters, and rate limiting.
- Upstash Redis REST client abstraction with Worker fetch transport.
- Runtime status feature detection for D1 and Upstash Redis configuration.
- Optional Upstash-backed relay token/IP rate limiting.
- Relay cache key helpers, versioned token/channel cache record wrappers, and
  Upstash-backed read-through caching.
- Relay channel cache keys include endpoint provider family to avoid
  cross-provider channel reuse for the same group/model.
- Migration CLI `dev-seed` command for local D1 seed SQL.
- Initial D1 schema for users, tokens, channels, abilities, options, and logs.

## Next

- Keep `docs/production-migration-execution-plan.md` current as the production
  gate source of truth for platform, data, relay, billing, observability,
  security, canary, and rollback readiness.
- Keep `docs/production-readiness-matrices.md` and
  `docs/staging-smoke-runbook.md` current as production evidence and live smoke
  requirements become more concrete.
- Continue broadening Go/Rust golden parity tests for billing expression edge
  cases.
- Continue replacing the Worker request-token estimate with Go `TokenCountMeta`
  parity, especially exact tokenizer counts plus image dimension and audio
  duration media counts.
- Extend the explicit request-body mode foundation with multipart/raw/stream
  modes before adding `/v1/audio/transcriptions` and
  `/v1/audio/translations`; the current JSON relay path must not buffer
  unbounded file uploads. Mode metadata, shared content-type policy, and
  bounded byte reading are in place; the next step is raw/multipart extraction
  and upstream forwarding.
- Continue defining explicit response buffering limits as each broader
  provider-specific transform is added.
- Add provider-specific adapters beyond OpenAI-compatible providers.
