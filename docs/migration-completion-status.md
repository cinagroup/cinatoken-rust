# Migration Completion Status

Date: 2026-07-04

This is the short status page. The evidence-based audit is
`docs/migration-progress-audit-2026-07-02.md`; the canonical Go route list is
`docs/source-route-inventory.md`.

## Headline

The Rust/Cloudflare migration has a **substantial deployable core**, but the
full Go product migration is **not complete** and an all-traffic production
cutover is not yet approved.

Do not interpret code presence, passing unit tests, or a subsystem staging smoke
as production completion. Production requires data reconciliation, frontend
runtime parity, capacity/cost/security evidence, canary, and rollback rehearsal.

## Substantial And Verified

- Rust workspace, Cloudflare Worker entrypoint, D1 repositories and migrations.
- Major OpenAI-compatible JSON/SSE relay routes, Anthropic Messages, native
  Gemini actions, rerank, image generation, audio speech, Workers AI.
- Token-authenticated model list/retrieve compatibility for `/v1/models`,
  `/v1/models/:model`, `/v1beta/models`, and `/v1beta/openai/models`, backed
  by D1 abilities and token model limits.
- Token authentication, channel selection/retry, model mapping, cache, rate
  limits, audit logging, reserve/settle/refund and tiered billing expressions.
  Relay weighted channel selection now uses Worker CSPRNG-backed bounded draws
  while preserving the deterministic Go-compatible selector core.
- Multipart upload relay is now Worker-owned for `/v1/audio/transcriptions`,
  `/v1/audio/translations`, and `/v1/images/edits`, with byte-safe model-field
  extraction from binary bodies and duration-derived preflight estimates for
  common audio containers used by transcription/translation uploads.
- Session-backed playground chat relay at `POST /pg/chat/completions`, using a
  synthetic zero-id token context that preserves user quota, group checks, rate
  limits, streaming, and audit logging without mutating the `tokens` table.
- Session auth, registration, core user self-service, 2FA,
  GitHub/Discord/OIDC, Turnstile, secure verification.
- Passkey route boundary: default-frontend status/delete and
  register/login/verify begin/finish paths are Worker-owned; begin routes create
  KV-backed WebAuthn challenges and finish routes fail closed until verifier
  work lands.
- Core admin user/token/channel/log/option/model/vendor APIs with audit and cache
  invalidation. Generated user access tokens and affiliation codes now use
  Worker CSPRNG-backed base62 strings, and model metadata list/detail responses
  include default-frontend enrichment for bound channels, enabled groups, quota
  types, rule matches, endpoint backfill, vendor counts, and server-side
  status/sync filters.
- Task submit/poll/CAS-settlement foundations and scheduled polling.
- Stripe top-up reference flow plus Epay wallet checkout/callback with D1
  provider-aware credited-anchor settlement. Subscription balance-pay order
  suffixes now preserve the Go-visible shape while using CSPRNG digits.
- Public redemption-code topup and daily check-in core routes.
- Tracked React/Bun source plus a successful production typecheck/build.

Evidence is mixed E2-E4 depending on subsystem; see the audit before relying on
any individual claim.

## Route Review Closures (2026-07-02, second pass)

A full diff of every Go-registered route against the Rust worker closed these
(commits `aca6772`, `22edffb`; staging-verified, see `docs/verification.md`):

- Client-facing async-task fetch (Go `RelayTaskFetch`):
  `GET /v1/video/generations/:task_id`, `GET /suno/fetch/:id`,
  `POST /suno/fetch` — owner-scoped `TaskDto`, Go error shapes. The review
  also found and fixed a poll-path bug: the parsed result URL was never
  persisted (now `json_set` into `private_data.result_url`).
- Midjourney client fetch (Go `RelayMidjourneyTask`):
  `GET /mj/task/:id/fetch`, `POST /mj/task/list-by-condition`.
- Dashboard billing reads (Go `billing.go`):
  `GET /dashboard/billing/{subscription,usage}` + `/v1` aliases.
- Relay passthroughs: `POST /v1/moderations`, `/v1/edits`,
  `/v1/responses/compact`.
- Go `RelayNotImplemented` parity: structured 501s for files / fine-tunes /
  image-variations / model-delete, plus the PaLM-era Gemini-format legacy
  aliases (`/v1/engines/:model/embeddings`, which Go relays in Gemini format —
  a wrong-format OpenAI relay would be worse than an honest 501).

- Superseding update: `/v1/engines/:model/embeddings` is now Worker-owned
  through the bounded embeddings relay with Go-compatible path-model fallback
  when body `model` is missing or blank. Files / fine-tunes / image-variations /
  model-delete remain structured 501 compatibility surfaces.

## In Progress

- Frontend staging deployment and browser/API contract smoke.
- Model-list/retrieve owner metadata, billing-config visibility filtering, and
  live token smoke.
- Video content proxy (`GET /v1/videos/:task_id/content`, dual-auth) and the
  OpenAI-video/kling/jimeng native-shape aliases (per-adaptor conversions).
- Real production Go SQLite -> D1 export/import/reconciliation.
- Billing shadow comparison and exact tokenizer/media parity.
- Relay weighted channel-selection staging evidence for distribution, retry,
  auto-group, affinity, and provider-family filter behavior.
- Frontend bundle-size reduction and budget ratchet tightening after heavy
  route-specific chunks are split. Strict lint is now zero-debt gated and
  `check:web:quality` is green locally.

## Incomplete Product Families

- Multipart image/audio relay is no longer entirely absent, but production
  parity still needs real-file replay for non-WAV/WebM audio parsers, live
  upstream smoke, image-edit fixture coverage, and billing
  shadow/reconciliation evidence.
- OpenAI Realtime WebSocket.
- Subscription core, redemption, and check-in still need production/staging
  evidence for the full visible workflows, but their core Worker routes are no
  longer entirely absent.
- Full Passkey register/login/step-up finish verification. The route boundary,
  challenge generation, status/delete, email verification/reset/bind, WeChat
  OAuth, and admin Passkey reset are Worker-owned;
  WeChat production readiness still requires a real operator WeChat Server
  over public HTTPS plus QR/code smoke, and email production readiness still
  requires real Cloudflare Email Service binding smoke.
- Payment providers: Stripe, Creem, Epay, legacy Waffo, and Waffo Pancake
  wallet/subscription checkout and callback routes used by the default frontend
  are Worker-owned. Remaining payment work is staging replay/reconciliation
  evidence rather than an absent default-frontend provider route.
- Custom OAuth management and several provider-specific OAuth flows.
- Long-tail provider/channel operations and performance/ratio-sync need more
  staging evidence.
- io.net deployment management routes used by the default frontend are
  Worker-owned and option-gated; remaining work is real-credential staging
  smoke, reversible mutation evidence, and rollback documentation.

## Production Blockers

1. `wrangler.toml` production resources still contain
   `REPLACE_WITH_PRODUCTION_*` placeholders.
2. Production source data has not completed freeze/export/import/hash and
   relationship reconciliation.
3. The tracked frontend has not passed a deployed browser smoke across all
   visible workflows.
4. Billing/payment production shadow and replay thresholds are not signed off.
5. Capacity, cost, security, SLO, canary and rollback evidence are incomplete.
6. Passkey WebAuthn finish verification must be implemented in a Worker-safe
   verifier or kept disabled with a signed forced-reset/re-enroll policy.

## Current Safe Statement

The current system can support staged and scoped Rust/Cloudflare validation.
It cannot yet be described as a complete replacement for the Go/VPS deployment,
and the Go deployment must remain available for rollback until the production
gates close.
