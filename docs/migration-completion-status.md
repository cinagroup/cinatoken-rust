# Migration Completion Status

Date: 2026-07-12

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

## Objective Re-Audit (2026-07-12)

| Objective requirement | Current authoritative evidence | Status | Evidence still required |
| --- | --- | --- | --- |
| Complete Go/VPS to Rust/Cloudflare migration | Rust owns the main route surface and the route audit reports zero explicit frontend gaps, but provider-specific, payment, async-task, data, and operational matrices still contain partial rows | Partial | Production SQLite-to-D1 reconciliation, all enabled provider/payment fixtures, capacity/security evidence, canary, rollback, and decommission proof |
| Frontend migration | React/Bun source, strict lint, bundle redaction/budget, route audit, and production build pass locally | Locally wired | Deployed browser hard-refresh, session/role/CRUD/2FA/Passkey, callback, console, performance, and rollback evidence |
| Rust scheduling gateway | `cinatoken-gateway` is the live versioned owner planner before Worker execution adapters | Locally wired | Main/API/static/tenant host matrix, negative dispatch, edge-auth parity, and rollback smoke on Cloudflare |
| Rust Durable Objects | RealtimeSession now has a six-scenario local workerd/D1/mock-upstream runtime suite; reservation binding, settlement, and refund are isolated by bridge segment; TaskRunner, channel affinity, Passkey ceremony, and WFP authority replay substrates compile with focused tests | Locally exercised substrate | Deployed eviction/alarm/reconnect/replay/load evidence; Realtime upstream and billing must complete without duplicate or cross-segment charge on Cloudflare staging |
| WFP Rust tenant script | Dedicated Rust/Wasm tenant crate, strict artifact manifest/uploader, signed relay authority, and replay guard are present | Gated substrate | Real staging namespace upload/readback, missing-worker/resource-limit faults, one paid provider call, central billing outcome, and traces |
| AI Gateway multi-model forwarding | Default-off direct and cross-model paths, actual-serving-group billing contract, and operator readiness exist | Gated substrate | Deployed provider-route canary, usage/error reconciliation, terminal audit delivery, fault injection, and rollback |
| `cinatoken.com` production deployment | No current deployment evidence; the credential included in the task is exposed and was not used | Not started | Revoke/rotate the exposed token, issue least-privilege replacement credentials, finish G1-G8, deploy staging, canary, then production DNS/cutover |

This re-audit keeps the overall migration goal open. Passing local gates proves
implementation readiness only for the covered behavior.

## Substantial And Verified

- Rust workspace, Cloudflare Worker entrypoint, D1 repositories and migrations.
- Major OpenAI-compatible JSON/SSE relay routes, Anthropic Messages, native
  Gemini actions, rerank, image generation, audio speech, Workers AI.
- Token-authenticated model list/retrieve compatibility for `/v1/models`,
  `/v1/models/:model`, `/v1beta/models`, and `/v1beta/openai/models`, backed
  by D1 abilities and token model limits.
- Token authentication, channel selection/retry, model mapping, cache, rate
  limits, audit logging, reserve/settle/refund and tiered billing expressions.
  Tracked environments use Workers-native token/IP/route-family Rate Limiting
  bindings; Upstash is no longer the default admission hop.
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
  register/login/verify begin/finish paths are Worker-owned; ceremonies use a
  session-bound SQLite-backed Durable Object and finish routes run the
  Worker-native WebAuthn verifier before D1/session mutation.
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
- Source `top_ups` to D1 `topups` conversion and P0 reconciliation, including
  all four Go statuses, provider validation, credited backfill, duplicate-import
  preservation, canonical hashes, and user relationship checks.
- Source Passkey, TOTP 2FA, and backup-code credential import/reconciliation,
  including byte-exact sensitive values, strict Go SQLite timestamp conversion,
  soft-delete filtering, no-overwrite idempotency, domain/uniqueness checks,
  and user/2FA relationships. Production-source and real-login proof remain
  pending.
- AI Gateway model-prefix registration now distinguishes all documented REST
  prefixes from the smaller safe same-channel fallback set. The admin frontend
  exposes both lists, and the smoke contract rejects Gateway-only providers in
  the direct-fallback list.
- A credential-free WFP post-upload verifier now reconciles uploader manifests,
  Cloudflare details/settings/content readback, recomputed module hashes, exact
  bindings, and a live positive dispatch result. No remote evidence has yet
  been supplied to it.
- The default wallet now preserves all four topup states; failed orders are no
  longer presented as pending.
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

### WFP dispatch failure contract (2026-07-11)

- The dynamic-dispatch execution path now catches errors from both dispatcher
  lookup and the dispatched Worker `fetch`, matching Cloudflare's current
  guidance that a missing script is reported during the dispatch call.
- Missing preview/internal workers return structured 404; a missing paid-relay
  worker returns 502; CPU/subrequest limits return 429; other tenant execution
  failures return 502. Raw tenant exception text is not returned or logged.
- Every platform-generated WFP failure uses `Cache-Control: no-store`. The
  capability API/frontend expose contract version/classes as implementation
  evidence, and the smoke tool can assert negative status/code/no-store cases.
- Remaining evidence is a replacement-credential staging run against missing,
  resource-limited, and deliberately failing tenant scripts plus relay billing
  and rollback proof.

### WFP outbound authentication boundary (2026-07-12)

- The new Rust service `cinatoken-wfp-outbound` is the dispatch namespace
  outbound Worker. It alone owns `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` and injects
  Cloudflare authentication; a tenant receives only
  `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1` for outbound auth and
  must never receive `CF_API_TOKEN` or another Cloudflare bearer.
- Its local policy permits only `POST application/json` with valid JSON up to
  4 MiB to exact account-scoped Cloudflare AI REST URLs ending in `/ai/run`,
  `/ai/v1/chat/completions`, `/ai/v1/responses`, or `/ai/v1/messages`. It
  rebuilds request/response headers from allowlists and blocks redirects. This
  follows Cloudflare's
  [Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
  model and documented
  [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
- Remote namespace attachment, outbound-only secret ownership, bearer-free
  tenant readback, live route/negative egress evidence, billing, and rollback
  are unverified. WFP production remains **NO-GO**.

### Rust scheduling gateway ownership (2026-07-11)

- `cinatoken-gateway` is now the live owner planner used before Worker binding
  execution. Its versioned precedence covers WFP host/internal dispatch,
  Gemini-native routes, RealtimeSession, static assets, and compatibility APIs.
- WFP preview hosts no longer fall back to the main SPA when dispatch is off,
  and tenant host ownership precedes central provider routes.
- Realtime session/static/API path classification shares the pure planner; the
  admin capability API and frontend expose implementation status separately
  from smoke and cutover evidence.
- Remaining M3 work is deployed host/path negative smoke and a carefully
  shared edge-auth context. This increment does not enable WFP, Realtime, or AI
  Gateway production traffic.

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
  AI Gateway egress through `cinatoken-wfp-outbound`. Duplicate, invalid, and
  unavailable replay checks fail closed. The authority master and Cloudflare AI
  bearer stay platform-side; the tenant receives a derived authority key, an
  external DO binding, and only the outbound auth marker for outbound
  authentication. Production still needs strict Rust/Wasm upload and binding
  readback, remote outbound attachment/secret isolation, plus sequential/
  concurrent duplicate, eviction, cleanup, throughput, provider-call, billing,
  audit, and redaction evidence. This is exact-envelope replay protection, not
  exactly-once upstream execution for a newly signed retry.
- Frontend bundle-size reduction and budget ratchet tightening after heavy
  route-specific chunks are split. Strict lint is now zero-debt gated and
  `check:web:quality` is green locally.

### Passkey WebAuthn finish contract (2026-07-12)

- Registration, discoverable login, and authenticated step-up finish handlers
  now run a pure Rust/Wasm verifier for `none` attestation plus ES256/RS256
  assertions before any D1, session, or step-up mutation.
- Challenge state moved from eventually consistent KV to a per-ceremony
  SQLite-backed `PasskeyCeremony` Durable Object with transactional one-winner
  take and alarm cleanup. Authenticated ceremonies and secure-verification
  markers are bound to the exact signed browser session by cookie hash.
- D1 stores the Go-compatible standard-base64 credential representation.
  Registration replaces one credential per user atomically; assertions update
  flags, last-used time, clone warning, and sign count through CAS.
- `/api/status` advertises `passkey_login` only when the option is enabled and
  the DO/verifier runtime contract is present. Frontend payloads and login user
  response shape remain unchanged.
- This closes the missing local implementation, not the deployment gate.
  Staging still needs real platform/cross-platform authenticators, origin and
  signature negatives, concurrent replay, session isolation, imported Go
  credential login, DO alarm/eviction, and rollback evidence.

### OpenAI Realtime local runtime contract (2026-07-12)

- A local-only Wrangler configuration and managed smoke suite now exercise the
  built `/v1/realtime` Worker through token auth, D1 channel selection,
  `RealtimeSession`, and a real mock upstream WebSocket.
- All six deterministic scenarios pass: normal close, 1 MiB frame rejection,
  startup queue/drain, response reservation/identity/usage/settlement, event
  stream failure, and upstream accept failure. Evidence contains frame sizes,
  close mappings, usage and billing metadata only.
- Realtime credential subprotocol metadata now replaces the entire key-bearing
  protocol with `<redacted-api-key-protocol>`. The suite also snapshots billing
  options and confirms zero residual users, tokens, channels, abilities,
  reservations, replay markers, and logs after cleanup.
- This closes the missing local runtime replay, not G7. Deployed provider,
  hibernation/eviction, reconnect, alarm/retry, concurrency, no-double-charge,
  observability, compatibility-date, and rollback proof remain open.

### Realtime bridge-segment billing isolation (2026-07-12)

- Migration `0021_realtime_billing_bridge_segments.sql` adds an explicit
  `bridge_segment` owner to each Realtime reservation and a segment/status
  lookup index. It fails closed while any reservation is still `reserved`.
- Response identity binding, settlement lookup, terminal refund, and lease
  handoff now require both session and bridge segment. Closing an old outbound
  bridge cannot refund or bind work owned by a replacement bridge that reuses
  the same logical session name.
- Restored legacy attachments without a segment do not perform a broad session
  refund; their durable reservation lease remains the recovery authority.
- The admin frontend exposes this compiled isolation contract separately from
  remote migration and runtime proof. Production remains blocked on applying
  0021 to staging with zero active reservations and replaying reconnect,
  eviction, concurrent-response, settlement, and rollback scenarios.

## Incomplete Product Families

- Multipart image/audio relay is no longer entirely absent, but production
  parity still needs real-file replay for non-WAV/WebM audio parsers, live
  upstream smoke, image-edit fixture coverage, and billing
  shadow/reconciliation evidence.
- OpenAI Realtime WebSocket is locally implemented and has a six-scenario
  workerd/D1/DO/mock-upstream replay. Production parity still needs deployed
  Cloudflare/provider long-session, hibernation/eviction, reconnect,
  alarm/retry, concurrent response, no-double-charge, trace, and rollback
  evidence.
- Subscription core, redemption, and check-in still need production/staging
  evidence for the full visible workflows, but their core Worker routes are no
  longer entirely absent.
- Passkey register/login/step-up is locally implemented; production parity
  still needs real-authenticator staging and imported-Go-credential evidence.
  Email verification/reset/bind, WeChat OAuth, and admin Passkey reset are also
  Worker-owned;
  WeChat production readiness still requires a real operator WeChat Server
  over public HTTPS plus QR/code smoke, and email production readiness still
  requires real Cloudflare Email Service binding smoke.
- Payment providers: Stripe, Creem, Epay, legacy Waffo, and Waffo Pancake
  wallet/subscription checkout and callback routes used by the default frontend
  are Worker-owned. Remaining payment work is staging replay/reconciliation
  evidence rather than an absent default-frontend provider route.
- Custom OAuth management and generic login/bind callbacks are Worker-owned;
  remaining OAuth work is real-provider staging replay, access-policy smoke,
  replay/bind-conflict evidence and several provider-specific
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
6. Passkey WebAuthn must pass deployed real-authenticator, imported-credential,
   replay/session-isolation, alarm/eviction, observability, and rollback gates.
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
   dispatch is status-only and must never be used for a paid route canary. WFP
   also requires verified `cinatoken-wfp-outbound` namespace attachment,
   outbound-only `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` ownership, bearer-free tenant
   readback, and live positive/negative egress evidence.

## Current Safe Statement

The current system can support staged and scoped Rust/Cloudflare validation.
It cannot yet be described as a complete replacement for the Go/VPS deployment,
and the Go deployment must remain available for rollback until the production
gates close. No WFP tenant deployment, outbound-service namespace attachment,
outbound-secret ownership readback, external replay binding readback,
signed-authority billing canary, live AI egress, or live replay-race evidence is
claimed by this status document. Production remains **NO-GO**.
