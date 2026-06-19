# Phase 1 Notes

This phase creates the Rust workspace and a Cloudflare Worker MVP.

## Implemented

- Workspace crate layout.
- Worker route entrypoint.
- `GET /api/status`.
- `GET /v1/models`.
- `POST /v1/chat/completions` non-stream OpenAI-compatible relay MVP.
- `POST /v1/completions` non-stream OpenAI-compatible relay MVP.
- `POST /v1/responses` non-stream OpenAI-compatible relay MVP.
- `POST /v1/embeddings` non-stream OpenAI-compatible relay MVP.
- D1 token authentication with status, expiry, quota-presence, model-limit, and IP allowlist checks.
- Best-effort D1 token status update for expired and exhausted tokens.
- D1 channel selection for OpenAI-compatible provider types.
- Ability-first channel selection with channel CSV fallback.
- Model mapping before upstream forwarding.
- Token access update, user request-count update, and zero-quota consume audit logs.
- Pure Rust relay helper tests for model mapping, IP allowlists, key selection, usage parsing, and URL normalization.
- Pure Rust billing primitives for quota rounding, price conversion, and pre-consume settlement deltas.
- Shared storage-layer record types for authenticated tokens, relay channels, and relay audit logs.
- Cache traits for string KV, expiring counters, and rate limiting.
- Upstash Redis REST client abstraction with Worker fetch transport.
- Runtime status feature detection for D1 and Upstash Redis configuration.
- Optional Upstash-backed relay token/IP rate limiting.
- Relay cache key helpers, versioned token/channel cache record wrappers, and
  Upstash-backed read-through caching.
- Migration CLI `dev-seed` command for local D1 seed SQL.
- Initial D1 schema for users, tokens, channels, abilities, options, and logs.

## Next

- Move D1 SQL into storage repositories once the MVP stabilizes.
- Connect token/channel read-through caching to the relay path.
- Implement full quota pre-consume and post-consume settlement.
- Port the billing expression evaluator and token normalization rules.
- Add streaming chat completion relay.
- Add provider-specific adapters beyond OpenAI-compatible providers.
