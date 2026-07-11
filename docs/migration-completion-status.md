# Migration Completion Status

Date: 2026-07-11

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
  GitHub/Discord/OIDC with browser-bound state, Turnstile, secure
  verification, and live D1 role/status/group rechecks before
  session-authenticated privilege decisions.
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
- Default-off TaskRunner recurring-alarm fast path with terminal-aware CAS
  outcomes, D1 recheck after lost CAS, bounded failure backoff/horizon, cron
  fallback metadata, admin status probe, and frontend operator visibility.
- Deterministic P0 source-to-D1 reconciliation CLI for counts, logical-key
  bounds, canonical hashes, samples, and core relationships; production-source
  execution remains pending.
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

### Provider relay capability authority (2026-07-11)

- All 53 real Go channel types now have one route-level Rust implementation
  registry. Relay candidate selection consults it before billing-plan creation
  and quota reservation; unsupported dedicated types fail closed.
- The generic OpenAI set is corrected to the 14 channel types actually served
  by Go's generic adapter. DeepSeek type 43 is implemented only for chat
  completions, legacy completions, and Anthropic Messages, with route-specific
  URLs and thinking suffix handling.
- Admin `GET /api/channel/provider-readiness` and the channel UI expose
  implementation readiness without claiming provider health or production
  proof. Route cache keys are protocol scoped.
- Local provider, relay, focused Worker, frontend, route-audit, wasm, and full
  repository checks pass. Dedicated adapters other than DeepSeek, live
  route/provider fixtures, staging billing reconciliation, and production
  canary evidence remain pending.

- Frontend staging deployment and browser/API contract smoke.
- Model-list/retrieve owner metadata, billing-config visibility filtering, and
  live token smoke.
- Video content proxy (`GET /v1/videos/:task_id/content`, dual-auth, SSRF
  validated with redirect-follow disabled) and the OpenAI-video/kling/jimeng
  native-shape aliases (per-adaptor conversions and live provider replay).
- Real production Go SQLite -> D1 export/import/reconciliation.
- Billing shadow comparison and exact tokenizer/media parity.
- Relay weighted channel-selection staging evidence for distribution, retry,
  auto-group, affinity, and provider-family filter behavior.
- AI Gateway cross-model fallback production proof. A default-off Rust outer
  fallback is now implemented for mapped OpenAI-compatible chat/responses
  requests, with served-model billing handoff, token/channel revalidation,
  provider-native direct bodies, and fail-closed auth/rate-limit handling. It
  now persists bounded secret-free all-fetch/configuration-failed attempt
  metadata as a Go-compatible type-5 error log after reserve refund. It still
  now has a default-off Worker-binding proof route for actual-serving-group
  billing, but still needs deployed Queue/D1 replay and archived remote staging
  evidence before production use.
- Authority-first WFP relay transport and exact-envelope replay prevention are
  locally implemented but remain default-off. After central token auth, D1
  selection, and reserve, the Rust/Wasm tenant verifies the 30-second
  worker/method/path/body/channel/request-id HMAC and atomically consumes its
  request ID in the platform-owned `WfpAuthorityReplay` Durable Object before
  AI Gateway egress. Duplicate, invalid, and unavailable replay checks fail
  closed. The master stays platform-side; the tenant receives a derived key and
  an external DO binding. Production still needs strict Rust/Wasm upload and
  binding readback plus sequential/concurrent duplicate, eviction, cleanup,
  throughput, provider-call, billing, audit, and redaction evidence. This is
  exact-envelope replay protection, not exactly-once upstream execution for a
  newly signed retry.
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
- Custom OAuth management and generic login/bind callbacks are Worker-owned;
  remaining OAuth work is real-provider staging replay, access-policy smoke,
  replay/bind-conflict evidence, Passkey finish, and several provider-specific
  OAuth production proofs.
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
7. Browser-session production approval now has local `session_epoch` /
   all-devices revocation support, but still needs D1 migration application
   through `0017` plus staging browser smoke for password-change and
   admin-disable/delete replay rejection. OAuth production approval still
   needs deployed replay smoke, custom-provider access-policy evidence, and
   separated frontend/API redirect-origin proof where applicable.
8. AI Gateway cross-model fallback and WFP paid traffic are not
   production-ready. Keep `RELAY_AI_GATEWAY_ROUTER_ENABLED`,
   `RELAY_MODEL_FALLBACK_ENABLED`, `WFP_DISPATCH_ENABLED`,
   `WFP_INTERNAL_DISPATCH_ENABLED`, and `WFP_RELAY_TRANSPORT_ENABLED`
   constrained to explicit staging canaries until their billing, authority,
   fallback-policy, upload/readback, and durable audit gates close. Admin WFP
   dispatch is status-only and must never be used for a paid route canary.

## Current Safe Statement

The current system can support staged and scoped Rust/Cloudflare validation.
It cannot yet be described as a complete replacement for the Go/VPS deployment,
and the Go deployment must remain available for rollback until the production
gates close. No WFP tenant deployment, external replay binding readback,
signed-authority billing canary, or live replay-race evidence is claimed by
this status document.
