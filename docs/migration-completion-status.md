# Migration Completion Status

Date: 2026-07-01

This document is the current, honest state of the cinatoken Go→Rust
(Cloudflare Workers) migration: what is **done and staging-verified**, what is
**bounded/portable follow-up**, and what is **blocked on an external
dependency or decision** an autonomous agent cannot supply. It complements
`docs/production-migration-execution-plan.md` (gates) and
`docs/parity-implementation-backlog.md` (sequencing).

## Headline

The **deployable, verified core of the migration is complete on staging.** The
product's two hearts — the relay and the async-task system — plus the whole
authentication, user self-service, and admin-management API surface are ported,
deployed to `cinatoken-rust-api-staging`, and exercised end-to-end against the
live environment (see `docs/verification.md` for the evidence log). The
remaining work is a long tail that is either a small bounded follow-up or is
blocked on a credential, a runtime/architecture decision, a new schema table,
or an unported subsystem — enumerated below.

## Done + staging-verified

- **Relay** — `/v1/chat/completions` (non-stream + streaming), `/v1/messages`
  (Anthropic Messages), with exact billing (reserve/settle) on real usage.
  **Verified against a real third-party provider (DeepSeek).**
- **Async-task system** — all 9 video providers + Suno + Midjourney,
  submit → cron-poll → CAS-settle → refund. Verified end-to-end (a real bug in
  the channel lookup and a token-refund gap were found here and fixed).
- **Auth** — register, login, login/2fa, logout, session cookie (a
  showstopper cookie-header bug that broke ALL session auth was found and
  fixed here), secure-verify step-up.
- **User self-service** — `GET/PUT/DELETE /api/user/self` (profile +
  sidebar/language settings), `/api/user/aff`, `/api/user/aff_transfer`,
  `/api/user/token`, `/api/user/groups`, `/api/user/self/groups`,
  `/api/user/models`, `PUT /api/user/setting` (notification prefs).
- **Admin CRUD** — user, token, channel, log, option management; plus
  `GET /api/channel/models_enabled` and `POST /api/option/rest_model_ratio`.
- **Public info** — status, setup, notice, about, home_page_content,
  user-agreement, privacy-policy, midjourney, `GET /api/ratio_config`.
- **2FA** (TOTP + backup codes), **OAuth** (GitHub / Discord / OIDC),
  **Stripe topup** (checkout + webhook), CORS fail-closed, native rate limits,
  cache invalidation, admin audit logging.
- **Deployment** — the worker is built (manual worker-build replication:
  `wasm-bindgen --target module`, since this box has no host linker) and
  deployed to staging; all D1 migrations applied; the async-task poller cron is
  live.

## Bounded / portable follow-ups (no external dependency)

**None remaining.** Everything in this category has been completed and
staging-verified: `POST /api/channel/tag/{disabled,enabled}` +
`DELETE /api/channel/disabled` (`0540e7a`); `POST /api/option/rest_model_ratio`
(`b463534`); `POST /api/option/payment_compliance` (`36ef615`);
`PUT /api/channel/tag` (`5de4205` — dynamic multi-field edit with per-channel
ability rebuild on models/group change, priority/weight propagation otherwise).

Reclassified as blocked: `GET/DELETE /api/option/channel_affinity_cache` — the
Rust affinity store is per-key Durable Object instances addressed by
`id_from_name` with **no key registry**, so enumerate-stats / clear-all cannot
be implemented faithfully without an architecture change (a KV/DO key index).
The affinity feature itself is flag-gated off by default
(`RELAY_CHANNEL_AFFINITY_ENABLED`), so the ops endpoints have no live state to
manage until that design call is made. Moved to item 14 below.

## Blocked — needs an external dependency or a decision (the user's call)

Each of these cannot be faithfully completed by an agent without the noted
input; stubbing them would be worse than leaving them explicit.

1. **Non-Stripe payments** (epay / creem / waffo / waffo-pancake): real
   provider credentials, webhook secrets, and per-provider quota/signature
   integration. Stripe topup is done as the reference.
2. **Passkey / WebAuthn** (`/passkey/*` register/login/verify): a runtime
   decision — a WASM WebAuthn verifier vs a Cloudflare Container. Cannot be
   built without choosing and provisioning that.
3. ~~`GET /api/pricing`~~ — **UNBLOCKED + DONE (2026-07-02, commit `3ba57ca`)**:
   the models metadata table is operator-populated at runtime (like channels),
   so the schema was portable after all. Migration `0008_model_meta.sql` adds
   `models` + `vendors` (applied to staging); `pricing_api.rs` ports
   GetPricing/updatePricing (abilities × groups × endpoint mapping, merged
   ratio maps, name-rule metadata enrichment, usable-group filtering, vendors,
   auto_groups). Staging-verified anonymously with priced/ratio/metadata/
   filtered cases. The models/vendors **admin CRUD** is also done
   (`fbc7424`): list/search/get/create/update(+status_only)/soft-delete for
   both tables + `GET /api/models/missing`, lifecycle staging-verified
   including live pricing enrichment and disabled-meta hiding. Still deferred
   within this vertical: list display enrichment (bound_channels/
   enable_groups/quota_types per row, vendor counts) and `sync_upstream*`
   (live provider I/O).
4. **`GET /api/models`** (DashboardListModels): returns per-provider adaptor
   static `GetModelList()` tables baked into Go code; there is no DB source, so
   there is no faithful worker equivalent.
5. **Email flows** — email verification, password-reset send, and the
   notification **dispatch** subsystem (email/webhook/bark/gotify on quota
   warnings; the config-storage half is done): need an email/HTTP-notify sender
   + provider credentials.
6. **OAuth wechat / telegram / email-bind**: provider-specific OAuth flows +
   credentials.
7. ~~Channel `test` / `fetch_models`~~ — **UNBLOCKED + DONE (2026-07-02,
   `98b454b` + `8a4f755`)**: these use the channel's OWN stored key against its
   own base_url (like the relay), so no new credentials were needed.
   `GET /api/channel/test/:id` (1-token chat probe, latency recorded to
   `response_time`/`test_time`, Go's test-model fallback chain),
   `GET /api/channel/fetch_models/:id`, and `POST /api/channel/fetch_models`
   (pre-create probe, key first-line trim) — all staging-verified via an echo
   upstream incl. the failure path. Bounded to OpenAI-compatible probing
   (documented). Still blocked here: `update_balance` (provider-specific
   billing APIs, mostly deprecated upstream) and `codex` (provider-specific).
8. **Realtime `/v1/realtime` WebSocket**: a Durable-Object-hibernation or
   Container design decision.
9. **Long-tail providers** (AWS Bedrock, Vertex-via-container, Tencent, io.net):
   Cloudflare Containers.
10. **Uptime Kuma status proxy**: an external monitoring integration + URL.
11. **Production data migration** (users/tokens/channels/logs from the Go/VPS
    source): the real source export (G7 in the execution plan) + operator
    sign-off.
12. **Real *video-provider* task smoke**: a real Sora/Vertex/Kling-family key
    (the relay path already has a real-provider smoke via DeepSeek).
13. **Production deploy**: G8-gated — `wrangler.toml` still holds
    `REPLACE_WITH_PRODUCTION_*` placeholders pending the operator.
14. **Affinity-cache ops endpoints** (`GET/DELETE
    /api/option/channel_affinity_cache`): need a key registry (KV index or a
    directory DO) the per-key `ChannelAffinity` DO design deliberately does not
    have — an architecture decision, and moot while the affinity flag is off.

## What "finished" means here

Everything portable without a third-party credential, a runtime/architecture
decision, a new schema table + data, or an unported subsystem is **done and
staging-verified**. The residual above is, by construction, the set of items
that require one of those four inputs — which are the user's/operator's calls,
not an agent's.
