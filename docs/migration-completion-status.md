# Migration Completion Status

Date: 2026-07-02

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
- Token authentication, channel selection/retry, model mapping, cache, rate
  limits, audit logging, reserve/settle/refund and tiered billing expressions.
- Session auth, registration, core user self-service, 2FA,
  GitHub/Discord/OIDC, Turnstile, secure verification.
- Core admin user/token/channel/log/option/model/vendor APIs with audit and cache
  invalidation.
- Task submit/poll/CAS-settlement foundations and scheduled polling.
- Stripe top-up reference flow.
- Tracked React/Bun source plus a successful production typecheck/build.

Evidence is mixed E2-E4 depending on subsystem; see the audit before relying on
any individual claim.

## In Progress

- Frontend staging deployment and browser/API contract smoke.
- Model-list/retrieve protocol negotiation and remaining JSON relay aliases.
- Task fetch/read/content APIs.
- Dashboard billing compatibility reads.
- Real production Go SQLite -> D1 export/import/reconciliation.
- Billing shadow comparison and exact tokenizer/media parity.
- Frontend lint cleanup and bundle-size reduction.

## Incomplete Product Families

- Multipart image/audio relay.
- OpenAI Realtime WebSocket.
- Subscriptions, redemption and check-in.
- Email verification/reset/bind and Passkey.
- Non-Stripe payment providers.
- Custom OAuth management and several provider-specific OAuth flows.
- Long-tail provider/channel operations, performance/ratio-sync, io.net
  deployment management.

## Production Blockers

1. `wrangler.toml` production resources still contain
   `REPLACE_WITH_PRODUCTION_*` placeholders.
2. Production source data has not completed freeze/export/import/hash and
   relationship reconciliation.
3. The tracked frontend has not passed a deployed browser smoke across all
   visible workflows.
4. Billing/payment production shadow and replay thresholds are not signed off.
5. Capacity, cost, security, SLO, canary and rollback evidence are incomplete.
6. Missing routes must be implemented, intentionally retired with compatible
   responses, or retained behind a documented fallback.

## Current Safe Statement

The current system can support staged and scoped Rust/Cloudflare validation.
It cannot yet be described as a complete replacement for the Go/VPS deployment,
and the Go deployment must remain available for rollback until the production
gates close.
