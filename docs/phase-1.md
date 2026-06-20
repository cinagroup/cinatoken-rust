# Phase 1 Notes

This phase creates the Rust workspace and a Cloudflare Worker MVP.

## Implemented

- Workspace crate layout.
- Worker route entrypoint.
- `GET /api/status`.
- `GET /v1/models`.
- `POST /v1/chat/completions` OpenAI-compatible relay MVP, including streaming
  passthrough for `stream: true`.
- `POST /v1/completions` non-stream OpenAI-compatible relay MVP.
- `POST /v1/responses` non-stream OpenAI-compatible relay MVP.
- `POST /v1/embeddings` non-stream OpenAI-compatible relay MVP.
- D1 token authentication with status, expiry, quota-presence, model-limit, and IP allowlist checks.
- Best-effort D1 token status update for expired and exhausted tokens.
- D1 channel selection for OpenAI-compatible provider types.
- Ability-first channel selection with channel CSV fallback.
- Model mapping before upstream forwarding.
- Token access update, user request-count update, and zero-quota consume audit logs.
- Streaming chat completion passthrough with pending zero-quota stream audit logs.
- Pure Rust relay helper tests for model mapping, IP allowlists, key
  selection, JSON/SSE usage parsing, and URL normalization.
- OpenAI-compatible JSON/SSE usage parsing extracts cached/cache-creation,
  Anthropic cache, and image/audio input/output token details for billing
  settlement.
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
  counts, frozen request probes, and post-response settlement against the
  frozen snapshot.
- Worker-side tiered-expression settlement rebuilds actual token parameters
  from upstream usage details and the frozen expression's variable usage, so
  cached/image/audio sub-categories are not double-counted in `p` or `c`.
- Cached-auth quota-state refresh plus request-time D1 reserve, failed-request
  refund, and post-response delta settlement for successful tiered-expression
  responses, including streaming chat after full-stream usage reconciliation.
- Worker-side tiered billing metadata now marks whether a frozen expression
  carried a request-rule multiplier without logging the full rule body.
- Successful Worker-side tiered-expression audit logs now include Go-compatible
  top-level usage-log display fields: `billing_mode`, base-expression
  `expr_b64`, and `matched_tier`.
- Worker-side streaming usage reconciliation for chat passthrough via response
  tee, incremental SSE usage parsing, and `wait_until` audit recording.
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
- Migration CLI `dev-seed` command for local D1 seed SQL.
- Initial D1 schema for users, tokens, channels, abilities, options, and logs.

## Next

- Continue broadening Go/Rust golden parity tests for billing expression edge
  cases.
- Continue replacing the Worker request-token estimate with Go `TokenCountMeta`
  parity, especially exact tokenizer counts plus image dimension and audio
  duration media counts.
- Add provider-specific adapters beyond OpenAI-compatible providers.
