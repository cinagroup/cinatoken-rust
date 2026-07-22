# Migration Completion Status

Date: 2026-07-22

This is the short status page. The current requirement-level evidence audit is
`docs/migration-progress-audit-2026-07-13.md`; the canonical Go route list is
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
| Rust Durable Objects | RealtimeSession has a six-scenario local workerd/D1/mock-upstream suite plus an explicit release-Wasm Workerd/SQLite hibernate-evict-restore test for the client socket, attachment/bridge segment, and persisted metrics; reservation binding, settlement, and refund are isolated by bridge segment; TaskRunner, channel affinity, Passkey ceremony, and WFP authority replay have focused tests | Locally exercised substrate | Active-upstream eviction must prove 1011 fail-closed, exactly-once refund/lease handoff, no replacement call, and clean reconnect; deployed eviction/alarm/reconnect/replay/load evidence remains required on Cloudflare staging |
| Container chat atomic admission | Migration 0050 plus the Rust canary use canonical-current identity, immutable global current/previous HMAC aliases, an order-independent alias-set receipt digest, history-probe-aware fail-closed replay (including 503 for every history-backed alias miss), frozen billing/channel authority, one deferred-FK D1 batch, generation-2 ownership, pre-dispatch Controller readiness, three-record settlement revalidation, and state-specific replay readiness; local capability wiring and the 14-case Workerd / 54-migration SQLite verification are complete | Implemented locally, hard-disabled | Drain every old writer, apply/read back ordered 0050-0054 in isolated staging with the 0054 activation writer still false, implement and prove bounded key-generation coverage/retention, code-audit and sign the replay-only rollback contract, run endpoint-level Worker faults and a real two-version key rotation against remote D1/Controller/R2, archive financial/rollback evidence, and retain `container_chat_canary_admission_compiled=false` until approval |
| WFP Rust tenant script | Dedicated Rust/Wasm tenant crate, strict artifact manifest/uploader, central-authority v3 transport, signed physical-target/policy claims, outbound invocation context, platform-owned Gateway policy, and final-boundary replay guard are present; tenant has no authority key, replay binding, bearer, or Gateway policy authority | Gated substrate | Real staging namespace/schema-3 outbound readback, live context/policy propagation, missing-worker/resource-limit/context faults, tenant-policy spoof negatives, one paid provider call, central billing outcome, and traces |
| AI Gateway multi-model forwarding | Default-off direct and cross-model paths, actual-serving-group billing contract, and operator readiness exist | Gated substrate | Deployed provider-route canary, usage/error reconciliation, terminal audit delivery, fault injection, and rollback |
| HTTP flat billing intent | Migrations 0029-0030, schema-v4 immutable per-candidate snapshots, domain-separated digest validation, reserve/bind/Queue/CAS finalization, request-id replay rejection, exact-decimal final rounding, fail-closed unknown-model admission, a hash-bound Go-generated flat manifest, and Ali synchronous image actual-count settlement pass locally | Gated local substrate | Complete Ali asynchronous task settlement, free-model runtime policy, and provider usage staging reconciliation; regenerate the manifest at cutover; obtain remote 0030/Queue/D1/invoice, abort/idle, rollback, and approval evidence |
| Task v2 durable billing ownership | Migration 0031 reserves before provider I/O, atomically refunds structured rejection, quarantines unknown results, protects active channels, supports soft-deleted refund targets, D1-times-out Midjourney, and atomically attaches/settles video, Suno, and Midjourney locally | Gated local substrate | Add a shared D1 poll lease, stable provider idempotency/lookup recovery, checked 64-bit financial binding, fair persisted retry, unknown-submit reconciliation, remote fault replay, invoice evidence, and staging approval |
| Realtime billing reconciliation | Migration 0028, an admin queue, frozen-expression preview, root step-up apply, atomic settle/refund, and a React/Bun workbench pass locally with mutation default-off | Gated local control plane | Rotated credential, remote 0028, dual-control/retention policy, provider invoice correlation, D1/concurrency/rollback drills, alerts, and approval |
| `cinatoken.com` production deployment | No current deployment evidence; the credential included in the task is exposed and was not used | Not started | Revoke/rotate the exposed token, issue least-privilege replacement credentials, finish G1-G8, deploy staging, canary, then production DNS/cutover |

This re-audit keeps the overall migration goal open. Passing local gates proves
implementation readiness only for the covered behavior.

The current source-tree D1 head is migration 0058 with 58 contiguous migration
files, 66 tables, 848 checked incremental columns, and 97 key indexes. Older
dated sections below retain their historical head/count snapshots. The
0050-0058 admission, response, financial terminal, shard-activation,
one-time campaign, HTTP stream handoff, pre-dispatch intent, and client-abort paths
are local candidate work, not remote schema evidence. Flat intent runtime and
Container readiness do not imply pricing or traffic cutover readiness;
`relay_flat_billing_go_parity_ready` and
`container_chat_canary_admission_compiled()` remain hard false.

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
  The selector APIs now apply per-user `+:`/`-:` usable-group rules and
  `GroupGroupRatio` overrides, and model discovery returns only enabled models
  backed by an enabled channel whose migrated adapter supports Chat
  Completions. The default frontend Playground entry is configuration
  controlled and locally verified against the complete Rust Worker under
  Workerd; remote authenticated staging evidence remains open.
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

### WFP outbound public-ingress isolation (2026-07-13)

- The tracked outbound Wrangler config now explicitly disables workers.dev and
  Preview URLs and declares no public route. Worker capabilities and the
  Cloudflare settings panel expose this as compiled configuration evidence.
- Readback schema 3 requires the deployed script subdomain to report both flags
  false, the service-filtered Worker Domains query to return zero Custom
  Domains, the dispatch attachment to expose the exact environment/context
  parameter, and the outbound service to bind the matching replay DO. The
  collector passes 30 local cases without reading the exposed credential.
- No deployed-state capture or account-wide Zone-route inventory exists yet.
  Credential rotation, remote readback, route inventory, namespace attachment,
  provider/billing canary, and rollback remain required; production is
  **NO-GO**.

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
- Dedicated Partial adapters now include Ali(17), Moonshot(25), ZhipuV4(26),
  Perplexity(27), Jina(38), SiliconFlow(40), Mistral(42), DeepSeek(43),
  VolcEngine(45), BaiduV2(46), xAI(48), and Submodel(53), plus Cohere
  rerank(34) and the Cloudflare adapter(39).
  Moonshot is a direct-only OpenAI/Claude bridge for chat, legacy completions,
  embeddings, rerank, and Messages. SiliconFlow is
  direct-only for chat, legacy completions, embeddings, rerank, and image
  generations; unsupported routes and AI Gateway/WFP configuration fail before
  reserve. Jina(38) is route-explicit for rerank and embeddings; its embedding
  adapter removes OpenAI `encoding_format` while preserving Jina-native fields.
  ZhipuV4 is direct-only for chat, embeddings, image generations, and Messages;
  legacy Zhipu type 16 remains Deferred for migration to type 26. VolcEngine is
  direct-only for chat, embeddings, image generations, and Responses, while
  `doubao-coding-plan` is chat-only. BaiduV2 is direct-only for chat and
  preserves the source `-search` behavior plus `token|appid` separation. The
  Ali adapter is direct-only for chat, legacy completions, current Responses,
  embeddings, native model-allowlisted Messages, and `gte-rerank-v2`. Its
  Messages patterns can be operator-configured, its optional plugin header is
  derived only from bounded server-side `channels.other`, and relay channel
  cache schema v4 prevents stale cached rows from bypassing that field. Main,
  fallback, and Admin OpenAI streaming paths use the same usage-option policy.
  Async images, audio, Gemini, non-native Messages, and qwen3 rerank stay
  Deferred. Tencent Hunyuan(23) is direct-only for non-streaming, text-only
  Chat Completions with exact-body TC3 signing and pre-retry provider-error
  normalization; stream, tools/multimodal, custom base URL, Gateway, and WFP
  remain Deferred. The registry has 16 Ready, 15 Partial, and 22 Deferred channel
  types.
- Admin `GET /api/channel/provider-readiness` and the channel UI expose
  implementation readiness without claiming provider health or production
  proof. Route cache keys are protocol scoped.
- Local provider, relay, focused Worker, frontend, route-audit, wasm, and full
  repository checks pass. Live
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
  selection, and reserve, the main Worker signs the 30-second
  worker/physical-dispatch-worker/policy/method/path/body/channel/request-id
  central-authority v3 HMAC. The
  tenant has no verifier or replay binding and only forwards the opaque
  authority after bounded route/body checks. Cloudflare passes the exact
  route/public-worker/dispatch-worker context to `cinatoken-wfp-outbound`,
  which validates the final request and atomically consumes the request ID in
  the platform-owned `WfpAuthorityReplay` before reading its bearer. Duplicate,
  invalid, and unavailable replay checks fail closed. Production still needs
  strict tenant binding-absence readback, schema-3 outbound attachment/replay
  readback, remote context propagation, sequential/concurrent duplicate,
  eviction, cleanup, throughput, provider-call, billing, audit, and redaction
  evidence. This is exact-envelope replay protection, not exactly-once upstream
  execution for a newly signed retry.
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
gates close. No WFP tenant deployment, outbound service/environment/context
attachment, outbound-secret ownership readback, outbound replay binding
readback, live Dynamic Dispatch parameter propagation, signed-authority billing
canary, live AI egress, or live replay-race evidence is claimed by this status
document. Production remains **NO-GO**.

## 2026-07-13 Realtime Orphan Recovery Status

The previously listed absence of a global D1 scanner is now locally addressed.
Migration 0022 supplies the indexed scan, bounded retry scheduling fields, and
aggregate sweep state. The root scheduled Worker enforces a 300-second
settlement grace/deadline, defaults recovery off, limits each pass to 32
candidates with a hard maximum of 64, and reuses the terminal D1 refund CAS.

Release Workerd tests prove inside-grace no-op, one refund under concurrent
scheduled delivery, replay no-op, and failed-oldest-row deferral followed by
newer-row progress. The admin endpoint exposes only hashed scope/outcome and
policy state with `no-store`; it does not claim to know the running DO owner.

This closes a local implementation gap, not G7. Remote migration 0022,
authenticated reserve/settlement retry across eviction, D1/DO owner
correlation, query-budget measurement, alerts, provider/billing reconciliation,
credential rotation, canary, and rollback remain blockers. Production remains
**NO-GO**.

## 2026-07-14 HTTP Pre-Bind Owner Generation Status

Migration 0026 adds the missing ordinary-HTTP pre-bind ownership fence. A new
tiered reservation starts at owner generation 1. Direct provider, AI Gateway,
and model-fallback waits renew only that unbound owner lease. A timely selected
bind advances to generation 2; settlement, refund, or recovery advances once
more, so delayed responses and stale Queue deliveries cannot mutate the new
owner.

Reserve and bind ambiguity use exact frozen-state readback. Bind cannot cross
the original owner deadline, and final recovery repeats its grace predicate in
the CAS: settlement is legal through L+300 and recovery starts at L+301. Queue
schema v2 freezes owner generation; v1 is generation-1 drain compatibility.
Migration 0026 refuses to run while an old `reserved` row exists.

The local chain verifies as 27 migrations, 30 tables, 130 checked incremental
columns, and 24 indexes. Rust, Wasm, frontend, and capability tests distinguish
compiled, configured, staging proof, and cutover. Staging proof remains false,
so scheduled HTTP recovery and production cutover remain false.

Credential rotation, isolated remote migration, delayed-header and D1 ambiguity
fault replay, Queue v2 drain, direct/Gateway/WFP accounting, alerting, rollback,
and G1-G8 approval remain required. Go/VPS stays authoritative and production
remains **NO-GO**.

## 2026-07-15 Native Container Shard Foundation Status

The selected Cloudflare target is edge Rust Worker -> private TypeScript
controller service -> named `RelayShardContainer` DO -> per-shard native Rust
Container. `docs/container-sharded-runtime.md` is the authoritative architecture
and rollout contract.

The current repository implements only a pure, versioned shard planner and
fail-closed capability/configuration surface. Ring generation 1 and eight
logical shards are valid, but scheduler enablement and staging verification are
false in every tracked environment. No routing secret, controller binding,
`[[containers]]` entry, image, native server, or remote evidence exists.

The current completion status is therefore **planner foundation complete,
Container runtime not started**. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-14 Realtime Usage Reconciliation Status

Migration 0027 adds explicit finalization ownership for a Realtime reservation
whose provider identity, terminal usage, or settlement result cannot be safely
interpreted. The owner is a CAS state, not a label: settlement, terminal refund,
lease refund, and global orphan recovery all exclude an owned row. A completed
zero-usage response is ambiguous; explicit zero usage for cancelled, failed, or
incomplete terminal states remains a valid settlement input.

Local release Workerd now proves the null-usage path from authenticated public
upgrade through provider WebSocket frames, D1 pre-reserve, safe client error and
1011 close, retained quota, zero replay/audit, and forced-overdue scheduled
recovery. Capability reporting and the React/Bun admin panel expose only
allowlisted, hashed, read-only state.

At the 0027 checkpoint no operator resolution action existed. The later 0028
control plane below closes that local implementation gap, but remote migration,
provider invoice correlation, missing/malformed/zero/D1/disconnect/redeploy race
coverage, alerts, retention, dual control, rollback, and G1-G8 approval remain
open. Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-13 Ordinary Relay Billing Reservation Status

Migration 0023 now gives positive HTTP tiered pre-consumption an atomic D1
reservation owner. Selected-attempt binding, matching replay classification,
guarded settle/refund batches, request-count ownership, audit correlation, and
a bounded expired-reservation sweep are implemented locally. The sweep refunds
only unbound rows; bound rows with missing final usage enter
`recovery_required`. Buffered tiered settlement is attempted synchronously;
streaming still depends on asynchronous final-usage capture.

Selected positive-reserve SSE now renews the bound lease through an exact
generation-fenced D1 CAS. The interval is configuration-bounded and
deterministically jittered; transient renewal failures are counted and retried
without interrupting the client stream, refunding quota, or accounting a
request. Local Workerd proves one renewal, no active-stream quota/request-count
mutation, one final settlement, exact user/token/channel accounting, and
redacted audit counters. Platform capabilities and the frontend expose
implementation, configuration validity, staging verification, and cutover
readiness separately.

The local chain verifies as 23 migrations, 29 tables, 105 incremental columns,
and 20 key indexes. Recovery is explicitly false in all Wrangler environments.
Remote migration, cron proof, a deployed stream crossing the original lease,
pre-bind loss, client disconnect and malformed-stream accounting, D1 failure,
restart/recovery races, provider/audit reconciliation, alerting, and rollback
remain blockers. This closes a local implementation gap, not the production
migration goal.

## 2026-07-14 HTTP SSE Partial Usage Recovery Status

The cloned audit stream now retains all accumulated evidence when a later chunk
read fails. Upstream-reported usage remains authoritative. With the existing
missing-usage estimate gate enabled, partial OpenAI Chat/Completions output can
settle through the local estimate path. Responses follows the source behavior:
an empty stream remains zero, while `response.output_text.delta` permits an
output estimate and prompt fallback. Bounded audit metadata records stream
error completion and whether billable usage survived the failure.

Release Workerd proves both partial-output-then-error and reported-usage-then-
error paths, exact user/token/channel deltas, one request count, one provider
call, one terminal ledger state, and upstream versus local-estimate source.
Capabilities and the frontend expose compiled support, estimate state, staging
proof, finalization Queue availability, replay implementation, and replay proof
separately.

This remains local E3 evidence. `BILLING_QUEUE` and replay are intentionally
reported unavailable/unimplemented, all new proof flags remain false, and
cutover remains false. Client disconnect beyond the post-response window,
request abort/idle timeout, bounded accumulator memory, staging migration, and
remote direct/Gateway/WFP accounting evidence remain blockers. Pre-bind owner
generation, Queue/DLQ replay, and the positive-reserve non-stream parse window
are addressed by later increments below. Production remains **NO-GO**.

## 2026-07-14 Durable HTTP Billing Finalization Queue Status

Migration 0024 adds a unique finalization event marker to `logs`. The tracked
Wrangler environments now declare a dedicated billing producer, consumer,
bounded retry policy, and environment-specific DLQ, while
`RELAY_BILLING_FINALIZATION_QUEUE_ENABLED=false` keeps transport behavior inert
by default. Reservation-backed tiered settlement/refund emits a bounded,
redacted frozen-decision event only when the gate and binding are both present;
producer failure falls back to the same idempotent D1 finalizer.

The Rust Queue consumer validates the queue name and payload family, parses each
message independently, ACKs applied/matching CAS outcomes, and retries malformed,
cross-queue, conflicting, or D1-failed messages individually. Release Workerd
proves duplicate replay without repeated quota/request/audit mutation,
cross-queue retry, and poison-message isolation. The frontend and capability API
separate queue enablement, binding, consumer, DLQ, replay, reconcile, runtime,
and staging proof; proof cannot override missing prerequisites.

The local chain now verifies as 24 migrations, 29 tables, 106 incremental
columns, and 21 key indexes. At this checkpoint consumer/DLQ/CAS was Partial
E3/E4 and the operator reconcile workflow remained absent; migration 0025 below
supersedes that local gap. Runtime readiness, scheduled HTTP orphan recovery,
and cutover still remain false. Remote
migration/Queue/DLQ readback, retry exhaustion, alerting, client cancellation,
D1 ambiguity and recovery-race accounting, credential rotation, canary, and
rollback remain blockers. Production remains **NO-GO**.

## 2026-07-14 Billing Finalization DLQ Reconcile Status

Migration 0025 now gives exhausted billing-finalization delivery a durable D1
incident owner. Valid frozen events retain an immutable canonical replay body;
invalid messages retain only a digest and classification. Replay state uses a
generation plus lease so it survives Worker replacement without relying on a
global Durable Object or in-memory operator lock.

The control plane is locally implemented but deliberately gated. Admins may
list sanitized incident metadata; only root with fresh secure verification can
claim one exact incident and requeue its stored event. The endpoint never runs
the financial finalizer and never accepts payload, pricing, quota, usage, or
expression input. The main Queue consumer remains the sole settlement/refund
writer and closes the incident after idempotent D1 CAS.

Local Workerd and contract tests cover valid/invalid quarantine, poison-payload
redaction, pre-replay no-mutation, step-up denial, one queue-mediated refund,
one billing and one manage audit, resolution, and duplicate replay rejection.
The local chain verifies as 25 migrations, 30 tables, 123 incremental columns,
and 23 key indexes. The frontend exposes compiled, configured, ready, and proof
states separately.

This closes the local missing-workflow blocker from the previous status; it does
not close production readiness. Queue and reconcile gates remain false. Remote
0025 application, Queue/DLQ/parking readback, four-day-retention alerting,
retry/D1/identity/race fault drills, provider/accounting reconciliation,
credential rotation, canary, and rollback remain blockers. Production remains
**NO-GO**.

## 2026-07-14 QuotaCoordinator Shadow Foundation Status

M4 now has a local pure Rust observer state machine and a deterministic per-token
`QuotaCoordinator` Durable Object. The observer contract is tiered-expression-
only, strict and versioned; state updates are atomic, bounded, idempotent, and
summary-only at the status boundary. Wrangler declares the SQLite-backed class
in every tracked environment, and local Workerd restores the same summary after
eviction.

This does not move billing authority. Tiered reserve, direct finalization,
Queue replay, and orphan recovery now project committed D1 facts through one
best-effort observer, but retention and shadow gates remain false and token
scope is empty. The shadow diff pipeline is absent, write authority is false,
and cutover readiness is false. D1 remains the only financial writer. The
frontend reflects these separate stages instead of collapsing producer coverage
into a readiness claim.

Long-lived-token retention/compaction, bounded storage/load evidence, off-path
reconciliation/observability, a signed disable-first rollback drill, and
at least 30 days of staging zero-diff reconciliation remain required before even
read authority can be discussed. Production remains **NO-GO**.

## 2026-07-14 QuotaCoordinator Bounded Retention Status

The local terminal-capacity blocker is now reduced: the coordinator rotates a
bounded exact replay window into cumulative redacted totals and advances a
monotonic D1 commit-time watermark. Replays outside the retained window are
explicit conflicts and cannot be silently applied again. Legacy records with
no commit-time metadata remain readable but require an explicit observer-state
migration before compaction.

Defaults are 512 active and 1,536 terminal records. The combined capacity
contract and a 1,500,000-byte write guard bound the single persisted value; the
maximum configured fixture is 1,234,821 JSON bytes. Status and platform
capabilities expose compaction separately from retention approval, and Workerd
passes compaction, expired replay, sizing, and eviction recovery.

This closes implementation of local bounded rotation, not the production
retention gate. Real hot-token load/window-duration, structured-clone storage
size, latency, cost, alert, authenticated remote readback, reconciliation, and
rollback evidence are absent. `QUOTA_COORD_RETENTION_VERIFIED`, shadow, and
staging proof remain false with an empty scope. D1 remains authoritative and
production remains **NO-GO**.

## 2026-07-14 Realtime Billing Reconciliation Control Plane

The previously read-only `usage_reconciliation` queue now has a local,
default-off operator workflow. Migration 0028 adds random public ids, monotonic
revisions, unique terminal resolution keys, operator attribution, and evidence
digests without assigning those fields to ordinary reservations.

Admin queue reads are no-store and stable-cursor paginated. Root preview accepts
only controlled settle/refund reasons and complete normalized usage. Settlement
quota is recomputed from the frozen tiered-expression snapshot; the client
cannot supply a quota or expression. Apply requires fresh secure verification,
explicit confirmation, the exact preview token, and an idempotency key.

Settlement/refund uses owner and revision CAS plus one D1 batch for terminal
state, quota, replay where applicable, and billing/root audit. The React/Bun
workbench surfaces only the allowlisted reconciliation contract. Base, staging,
and production keep `REALTIME_BILLING_RECONCILIATION_ENABLED=false`.

The verified local baseline is 28 migrations, 30 tables, 137 checked
incremental columns, and 27 key indexes. Remote migration, actual-provider
invoice reconciliation, dual-control and evidence retention policy, concurrent
operator races, D1 outage/rollback, alerts, and G1-G8 approval remain open.
Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-14 Non-Stream Billing Finalization And Cutover Interlock

Two financial correctness gaps identified by the production audit are now
closed locally. Positive-reserve non-stream responses use bounded synchronous
inspection instead of detached clone ownership. If an intact provider 2xx
cannot be inspected before body consumption, it is delivered and the frozen
reservation settles at its approved pre-consumption. If the body was consumed
or is malformed, the Worker returns 502 and refunds before returning the error.
Cohere rerank read-limit failure now finalizes its bound reservation by the same
owned path.

Release Workerd covers both cases with one provider invocation, one terminal
ledger state, exact user/token/channel/request accounting, and billing Queue
evidence. This is local E3 evidence only; deployed direct, AI Gateway, and WFP
body-limit/error matrices plus provider-invoice reconciliation remain required.

The Realtime reconciliation workflow now has a separate immutable staging-proof
flag and cutover capability. Base, staging, and production keep
`REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED=false`, and the 37-input v1
predicate requires reconciliation cutover readiness. Active outbound WebSockets
cannot be used as a local hibernation proof because Workerd retains the DO while
that reference is active; only detached-upstream eviction is locally covered.
Credential rotation, remote 0028/resource readback, signed operator and fault
drills, live interruption/redeploy evidence, rollback, and G1-G8 approval remain
open. Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-14 Zero-Reserve And Usage-Less Non-Stream Billing

The next local non-stream gap is closed without changing the frozen billing
expression contract. Successful usage-bearing responses are now bounded and
observed before delivery. An uninspectable response can be forwarded only when
a positive tiered reservation already exists; flat and zero-reserve responses
are blocked with 502 before the client receives an unbillable provider result.

Tiered requests with a zero estimate now create a zero-debit reservation,
bind the selected attempt, and finalize through the existing Queue/CAS path.
Release Workerd proves a zero pre-consumption becomes a positive final debit
exactly once. Separate runtime cases prove flat body-limit blocking with no
charge and synchronous fixed-price audio charging with no usage body.

This does not make generic flat billing replay-safe: its successful debit still
uses the existing non-ledger D1 mutation path. A frozen flat-pricing intent,
abort/idle taxonomy, remote direct/Gateway/WFP fault replay, provider invoices,
alerts, rollback, credential rotation, and G1-G8 approval remain open. Go/VPS
stays authoritative and production remains **NO-GO**.

## 2026-07-14 Flat Pricing Admission And Immutable Contract

This section supersedes the non-ledger conclusion immediately above. Generic
flat billing now owns a frozen reservation, Queue/D1 CAS settlement or refund,
and replay identity. Migration 0030 prevents post-insert mutation of the
reservation's financial contract.

Go-compatible decimal terminal rounding, empty-option-map replacement, site
self-use admission, per-user unset-model admission, fail-closed unknown-model
rejection, fallback ratio 37.5, and matching model-list visibility are covered
locally. Release Workerd passes 38/38 and includes strict rejection before
provider egress, both admitted-unknown policies, exact settlement, and D1
snapshot-mutation rejection. The local schema proof is 30 migrations, 30
tables, 139 checked columns, and 27 indexes.

Flat cutover remains blocked by per-token audio pricing, image size/quality and
actual-count rules, tool-call surcharges, complete provider `OtherRatios` and
usage-source semantics, a Go-generated immutable flat golden manifest, and all
remote Queue/DLQ/provider/accounting/fault/rollback evidence. The parity
capability remains hard false; Go/VPS stays authoritative and production
remains **NO-GO**.

## 2026-07-15 WFP Artifact And Credential Boundary Status

The local WFP deployment path now matches the real Rust/Wasm output: the upload
main is `crates/wfp-tenant/build/index.js`, its referenced Wasm is mandatory,
and the Wrangler shim remains a compatibility entry only. Upload metadata and
both Cloudflare readback surfaces use evidence schema v3 and must agree exactly
on enabled, nonzero observability sampling.

Tenant metadata is explicitly free of AI Gateway identity/policy and every
Cloudflare or WFP authority credential. Main-relay AI Gateway readiness and
runtime share one fail-closed contract requiring the dedicated
`CLOUDFLARE_AI_GATEWAY_TOKEN`; a generic account API token no longer satisfies
the data-plane requirement. Local Worker and deployment-contract tests pass,
and the complete release gate is green.

This closes a local artifact/readiness inconsistency, not the production gate.
Authenticated upload and Settings/Content readback, tenant traffic smoke,
remote Queue/D1/DLQ and provider evidence, fault/load/alert drills, replacement
credential proof, rollback, and G1-G8 approval remain absent. TTS and
OpenRouter flat-billing parity are also open. Go/VPS stays authoritative and
production remains **NO-GO**.

## 2026-07-15 Flat V4 And Go Manifest Status

Flat schema v4 now freezes TTS audio-detail and OpenRouter inference facts, and
the Worker has bounded local settlement coverage for both. The immutable Go
flat manifest is generated by running the real source formulas at commit
`73652508abc5`; its 10 terminal and 8 admission/pre-consume cases are bound to
source/generator/template hashes and replayed by Rust. Offline manifest
integrity and all three Rust replay tests pass.

This removes TTS/OpenRouter and the missing Go flat manifest from the local G4
gap list. Ali synchronous image actual-count replacement and multipart image
edit conversion are now also locally closed. Ali asynchronous task settlement,
free-model runtime policy, provider usage staging reconciliation, cutover-commit
manifest regeneration, remote Queue/D1/provider reconciliation, browser
journeys, credential rotation, rollback, and signed G1-G8 evidence remain open.
Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-15 Ali Synchronous Image Settlement Status

Type 17 now admits `/v1/images/generations` and `/v1/images/edits` only for the
source-audited synchronous model patterns. Generation JSON and bounded
multipart edits are converted to the DashScope multimodal generation contract;
edits preserve up to 16 `image`, `image[]`, or indexed `image[n]` files in
source-compatible precedence order. Wan edits and every asynchronous image
model fail before quota reserve. `ALI_SYNC_IMAGE_MODELS` can replace the
defaults through the same bounded pattern contract used by routing, Admin
Channel Test, and native conversion.

Successful provider responses replace the frozen flat request count using the
first positive source: `usage.image_count`, converted non-empty output count,
then normalized request `n`. Only a terminal clone of the flat pricing snapshot
is adjusted; the stored snapshot/digest and tiered-expression request context
remain immutable. Audit metadata records requested, converted, actual, and
source values without image content or credentials. URL output remains URL;
`b64_json` accepts provider base64 only and never fetches remote URLs. A
URL-only or partial base64 result returns 502 and refunds rather than returning
empty/partial success. Multipart parsing stops on the 17th matching file and
rejects part headers above 8 KiB; response metadata no longer duplicates image
payloads.

Local tests are implementation evidence, not cutover evidence. The published
blocker is now `ali_async_image_task_settlement`; production remains **NO-GO**
until the asynchronous D1/TaskRunner/Queue state machine and synchronous live
provider, billing, invoice, failure, and rollback evidence are complete.

## 2026-07-15 Task Submit Reconciliation Status

Task ambiguity recovery is now implemented locally as a root-only control
plane. D1 migration 0032 adds the frozen attach contract, public reconciliation
identity, monotonic revision, immutable event ledger, resolution audit fields,
and an expand-phase compatibility trigger. Migration 0033 removes that bridge
and enforces non-empty attach contracts for every new Task billing intent. The
current local schema baseline is 33 migrations, 32 tables, 190 checked
incremental columns, and 34 key indexes, plus an object-level Task schema probe.

The Worker exposes a no-store queue, deterministic preview, and root plus fresh
secure-verification apply route. Attach/refund decisions are reason-limited,
evidence-bound, revision-fenced, idempotent, and committed in one D1 batch with
the immutable event, accounting mutation, intent transition, and root audit.
Legacy unknown rows cannot attach and remain refund-only. The Cloudflare
operations panel provides queue pagination, preview, exact-ID confirmation,
step-up, apply, and canonical queue refresh. Both runtime and staging-proof
flags remain false in every tracked environment.

This closes a local operator-control gap, not provider ambiguity itself.
Provider-native idempotency/lookup, frozen-contract retention policy, remote
0032/0033 rollout and fault injection, Task/Midjourney provider evidence,
invoice reconciliation, shared poll lease, fair retry, checked 64-bit D1
binding, FreeModel/subscription parity, credential rotation, and rollback remain
open. Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-15 Generation-Fenced Task Polling Status

This current-head note supersedes only the earlier statement that a shared poll
lease is absent. Migrations 0034/0035 and the Rust Worker now provide a local
generation-fenced D1 poll lease for Task and Midjourney rows. Cron, video
`TaskRunner`, normal provider polling, and both Task/Midjourney timeout paths
must claim before provider or terminal I/O; stale, superseded, or expired
generations cannot apply lifecycle or billing mutations.

The migration remains inert for production use: D1 authority and old-writer
enforcement both default off, Worker env authority defaults off, and staging
proof is absent. Normal video, Suno, and Midjourney polling have separate
bounded candidate windows. Suno is cron-only and must not enter the video
TaskRunner. Provider HTTP polling is bounded below lease expiry, but current
Vertex authentication occurs outside that fetch deadline.

Status: **gated local substrate**, not production ready. Deployment must follow
migrate -> deploy disabled -> drain old pollers/alarms -> D1 authority -> D1
enforcement -> env authority -> cron canary -> reviewed staging proof -> video
TaskRunner canary. Rollback is env off -> D1 authority off -> D1 enforcement
off -> drain leases -> 0033-compatible Worker only.

Migration 0036 is now present as an unpromoted local expand candidate. It adds
persisted due time, attempt/failure/error/quarantine metadata, filtered due
indexes, and five seeded family cursors with inert defaults. The committed
default/staging/production scheduler gates remain false. This repository state
is not proof that any remote D1 applied 0036 or that a Worker was deployed.

Status: **gated local scheduling substrate**. Scheduler activation depends on
the 0034/0035 lease being present, authoritative, enforced, drained of old
writers, and race/rollback verified. D1 is the scheduling and lifecycle
authority; a TaskRunner DO may only accelerate video wake-up and must obey D1
due/quarantine/lease state.

Local runtime now includes minute-slot family rotation, eight-row family caps,
finite high-watermark cursor rounds, claim-only cursor advance, deterministic
jittered capped backoff, success reset, threshold quarantine, generation-fenced
Alarm rearm, and bounded/redacted video response persistence. Immediate poison
classification and audited manual release/requeue now exist locally through
0037. Provider-operation uniqueness/idempotency lookup, whole-operation
deadlines, remote fault injection, invoice reconciliation, alert/load evidence,
credential rotation, and signed rollback still block Task v2 and production.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-16 Durable Operation Recovery Status

The local operation state now distinguishes claimed, running, completed,
failed, and recovery_required. Trace and stable response code survive DO
eviction; exact R2 result identity is mandatory before non-health completion;
running deadline and post-dispatch response ambiguity never become an
automatically retryable failure. A persisted Container schedule drives
deadline reconciliation, and D1 admission is reserved/lease/deadline fenced.

Current evidence is 32 portable protocol tests, 15 Workerd/SQLite scenarios,
9 runtime unit tests, and 7 runtime HTTP tests, with TypeScript passing. This is
outcome-manifest replay only. Edge business dispatch, provider execution,
original response bytes, billing terminalization, Docker E2E, N/N-1, remote
faults, load/cost, canary, and rollback remain open. No deployment or secret
operation occurred. Production remains **NO-GO**.

## 2026-07-16 Container Shared Storage Gateway Status

The local Controller now has four deny-by-default, owner-fenced storage
actions: exact R2 input, immutable R2 result, bounded KV config, and minimal D1
admission state. The DO ledger persists operation/input identity and records an
exact R2 result version through owner-generation CAS. Portable tests cover
route/method restrictions, integrity bounds, create-only writes, exact replay,
conflict, KV bounds, and D1 fencing; Workerd covers eviction persistence and
terminal-state denial.

This changes the shared-storage line item from absent to local-only. It does
not change the production verdict: every storage action flag remains false,
the real Container and remote bindings are untested, and edge operation,
provider, billing, N/N-1, image, fault, load/cost, canary, and rollback gates
remain open. No deployment or secret operation occurred. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-15 Audited Task Poll Recovery Status

The current local D1 head is `0037_task_poll_recovery.sql`. It creates an
immutable recovery event ledger, one-event-per-entity/revision uniqueness,
lowercase-hex digest/token constraints, and exact partial quarantine indexes
for Task and Midjourney. D1 triggers repeat the generation, write revision,
quarantine timestamp/reason, provider identity, empty lease, nonterminal, and
hard-timeout predicates in the same transaction as requeue.

The root-only, no-store API exposes `task_reference` and SHA-256 instead of the
original Midjourney provider ID. Preview/apply include hard timeout,
`timeout_eligible`, and a recovery margin at least 60 seconds and at least one
poll lease. Apply requires fresh step-up, confirmation, approved reason,
evidence, preview token, and idempotency. Stale/conflicting state returns 409;
D1, audit, or canonical readback uncertainty returns 503. Identical replay
converges. The first successful Task apply may best-effort arm TaskRunner after
D1 commit, while cron remains authoritative.

Unsupported providers, invalid provider task identity, and deterministically
invalid credentials now quarantine immediately. Network failure, invalid
upstream response, and missing batch items remain threshold-backed retries.
Both recovery vars remain false, and scheduler cutover additionally requires
recovery cutover readiness.

The verified local schema report is 37 migrations, 35 tables, 241 checked
incremental columns, and 42 key indexes. The clean release Workerd suite passes
42/42; its recovery scenario covers root/step-up, apply, duplicate convergence,
stale preview, immutable audit, timeout-margin rejection, and default-off DO
fallback. Remote D1/staging/provider and enabled TaskRunner rearm evidence is
not claimed.

Provider-operation uniqueness/native idempotency, whole-submit operation
deadlines, WFP namespace upload/readback, paid WFP canary, invoice/load/alert
evidence, credential rotation, and signed rollback remain hard blockers.
Rollback is recovery off -> scheduler/TaskRunner off -> lease env off -> D1
authority off -> D1 enforcement off, followed by lease/provider reconciliation
and quarantine disposition before Go/VPS resumes. Production remains
**NO-GO**.

## 2026-07-15 Recoverable Task Submit Status

The current local D1 head is now
`0039_task_submit_operation_enforce.sql`. Migration 0038 is a compatible
expand phase; 0039 rejects new task intents without immutable client-operation
and request digests plus a 5..120 second submit deadline. Local client and
provider operation indexes are unique. The verified schema report is 39
migrations, 35 tables, 244 checked incremental columns, and 45 key indexes.

Generic video, OpenAI video/remix, Suno, and Midjourney now share client-key
replay protection. Ambiguous provider/transport/attachment outcomes return a
stable 202 recovery envelope instead of an unqueryable 500. The exact creating
API token can read a no-store, redacted submission status; a different token
receives 404. Provider response buffering is capped and the absolute network
deadline covers Vertex OAuth through response-body read.

This is local correctness, not remote provider proof. Tracked
`TASK_CLIENT_IDEMPOTENCY_REQUIRED` remains false, provider-native idempotency
and provider lookup capabilities remain false, and the D1 attachment phase is
handled through durable ambiguity rather than claimed cancellable by the fetch
deadline. The 0038 -> dual-writer -> drain -> 0039 rollout, remote D1 readback,
provider fault/invoice campaigns, WFP namespace/readback, paid egress,
TaskRunner/provider hot paths, load/alerts, credential rotation, rollback, and
G1-G8 approval remain open. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-16 Container Controller And Runtime Status

The repository now contains the isolated TypeScript Controller Worker,
`RelayShardContainer` SQLite Container DO, separate Rust/TypeScript authority
protocol, native axum runtime skeleton, and an edge-only private Service Binding
client. Every tracked Controller, probe, scheduler, execution, and staging
switch remains false. Provider execution is absent and the native server
returns a stable 501 for every non-probe operation.

Focused local evidence covers generated Env types, strict TypeScript, Wrangler
dry-run bundling, private authority tamper/time/audience/body checks, complete
shard fencing, current/previous key rotation, a Rust/TypeScript golden vector,
bounded native HTTP behavior, deny-all egress source, and ten real
Workerd/SQLite ledger scenarios for max+1 admission, conflicts, expired 504
recovery with late-result CAS, retryable capacity release, time/count
compaction, refreshed-dispatch protection, legacy rejection migration,
replay-window backpressure, and eviction persistence. Terminal history is
explicitly configured for seven days and a 10,000-row target per shard, with
replay-window protection and ledger backpressure.

The Workerd fixture exercises the production ledger module, not the actual
`RelayShardContainer` class or a Docker process. The edge contract signs and
bounds `/internal/v1/status`, validates protocol/ring/shard/keyring state, and
reports transport verification separately from Controller execution readiness.
Remote status evidence, a targeted shard readiness probe, Container lifecycle
callbacks, shared storage, N/N-1, remote faults, staging verification, and
cutover stay open.

No Docker engine is installed, no image or Container was started, no secret was
provisioned, and no remote deployment is claimed. D1/KV/R2 Controller
operations, provider egress and credential injection, provider idempotency,
image supply-chain evidence, fault/load/cost evidence, and C1-C5 promotion
remain open. Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-16 Targeted Container Readiness Status

Local code now includes an admin-only targeted shard readiness route, signed
private edge-to-Controller POST, non-waking ledger mode, separately gated live
mode, strict runtime response, process/execution readiness split, persistent
dispatch replay, generation/deadline/cooldown/result state, stale-completion
CAS, draining admission rejection, and zero-in-flight ring advancement.

Strict TypeScript, portable protocol, Rust authority/response, native runtime
HTTP, and thirteen Workerd/SQLite scenarios pass locally. Every read, wake,
execution, scheduler, and staging marker remains false. The local tests do not
instantiate a real Cloudflare Container or prove Docker, lifecycle callbacks,
N/N-1 rollout, remote storage, provider/billing behavior, image provenance,
load/cost, canary, or rollback. No deployment or secret operation occurred.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-18 Container Atomic Admission Status

Migration `0050_relay_container_atomic_admission.sql` is present in the local
source tree and the Rust Container chat canary calls the corresponding atomic
repository API. The final production-facing admission capability remains
hard-coded false. Nothing in this status records a remote D1 apply, Worker or
Container deployment, provider request, financial mutation, or traffic shift.

### Implemented

- The reservation key is
  `relaycontainer-v1-{client_idempotency_hmac_sha256}`. The HMAC is scoped only
  to user ID, token ID, and the validated `Idempotency-Key`; model, mutable
  selection, provider input, and pricing are excluded.
- The request-conflict digest is model plus the original request body only and
  remains unchanged when provider conversion freezes a different upstream
  input body.
- A separate stable atomic digest binds the persisted winner's billing
  snapshot, positive pre-consumption, selected channel/group/type/snapshot key,
  transformed input, shard, and provider-operation identity. These facts guard
  admission linkage without becoming client identity.
- The receipt fixes owner generation 2, attempt count 1, provider attempt
  generation 1, the billing snapshot digest, the exact selected flat snapshot
  key, `idempotency_alias_count`, and the order-independent
  `idempotency_aliases_sha256` digest of the sorted, length-framed
  current/previous alias set. The snapshot key must be the textual selected
  channel type.
- One D1 batch enables deferred foreign keys, inserts the receipt first, claims
  every current/previous HMAC alias, inserts the reservation, debits the user
  and token, rechecks channel authority, and inserts the prepared operation.
  Guard statements require one changed row after every mutation, so an alias
  collision or any later failure rolls back the whole decision before
  authoritative persisted-winner readback.
- User active/deletion/quota, token ownership/status/deletion/expiry/quota, and
  channel status/type/group/model authority are checked inside that batch.
- Readback distinguishes newly applied, matching resumable, terminal replay,
  request conflict, and immutable identity conflict. Completed/failed replay
  requires the exact financial terminal receipt.
- After request parse, model/auth resolution, and relay rate limiting, exact
  replay derives current/previous tenant HMAC candidates and the
  model/original-body digest and queries immutable
  `relay_container_idempotency_aliases` as authority. Retry/model fallback,
  current channel discovery/selection, affinity, provider transformation,
  ordinary reserve/debit, and upstream send happen after a miss only when a
  successful history probe proves 0050 history is empty and replay-only mode is
  inactive. Schema/query errors, partial linkage, and any miss with durable
  history fail closed as 503; a match resumes the persisted winner even if its
  channel is disabled. Immutable linkage divergence is a server integrity
  failure, not a client 409.
- `CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED` and
  `CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED` both default false. Replay-only
  cohort misses return HTTP 503 with `Retry-After: 5` and cannot fall through to
  normal reservation, admission, or upstream execution.
- New admission is canonical-current-write: the current secret names the
  reservation/operation, while the same batch claims the current and distinct
  previous HMACs as global immutable aliases. Rolling versions therefore share
  one alias serialization point instead of allocating separate owners under
  different current keys.
- Every eligible idempotent request probes 0050 history even when a current or
  previous secret is configured. An unavailable/incomplete schema, failed
  history/alias query, immutable linkage conflict, or alias miss with existing
  history returns 503. Ordinary processing after a miss requires a successful
  empty-history result and inactive replay-only mode. Secret-generation/key-ID
  coverage and bounded retention remain required before this conservative rule
  can be relaxed.
- Completed/failed operations permit read-only terminal replay only when the
  exact-response gate and `FILE_BUCKET` are available; otherwise they return
  HTTP 202 pending. `dispatched`/`recovery_required` require their
  Controller/replay readiness. Before `prepared` advances in D1 it also
  requires operation replay readiness, scheduler enablement, valid ring and
  routing-secret configuration, the explicit prepared-resume gate, and a
  verified Controller binding/authority/enabled/execution-ready status.
- Local capabilities expose the boolean-only
  `container_chat_canary_replay_history_probe_known` and
  `container_chat_canary_replay_history_present`, R2 binding availability, and
  `container_chat_canary_terminal_replay_runtime_ready`,
  `container_chat_canary_dispatched_recovery_runtime_ready`, and
  `container_chat_canary_prepared_resume_runtime_ready`. Aggregate replay
  readiness is their conjunction. `container_chat_canary_replay_only_active`
  means only the actual flag plus configured cohort predicate; it cannot
  replace readiness. Per-request route/token/model membership remains a runtime
  check. An unknown history probe forces all replay-readiness fields false.
- Provider-usage settlement looks up the exact atomic receipt by reservation
  and uses its frozen `selected_snapshot_key`; it does not use the channel ID as
  the flat pricing-map key.
- Settlement quote and final financial commit each reread receipt, reservation,
  and operation, recompute `billing_snapshot_sha256` and the complete atomic
  admission digest, and reject any three-record divergence before mutation.
- 0050 refuses to apply over an existing protocol-v1 chat canary operation. Its
  insert guard prevents a pre-0050 writer from creating an unmarked canary
  operation, and its immutable/delete guards preserve receipt linkage.

### Verified locally

The current local test tree covers the real migration/batch path, exact
winner/readback behavior, quota/authority/marker rollback, old-writer
rejection, alias table/digest/immutability checks, three-record settlement,
current/previous identity derivation, and the terminal/prepared/dispatched/
recovery decision matrix. The completed local validation reports Workerd 14/14,
Worker Rust 820/820, and SQLite 50 migrations / 48 tables / 540 incremental
columns / 72 key indexes; the repository-wide `bun run check`, including the
root Worker Wrangler dry-run, also passes.

The replay-only/alias branch still lacks endpoint-level proof for miss
isolation, schema/query 503 behavior, missing/stale-secret history guard,
history-probe uncertainty, real-D1 alias collision during key rotation, and
state gates across D1/R2/DO/Controller.

This is local transaction evidence only. The R2 input write occurs before D1
and is outside the transaction; an unadmitted R2 object is never authority and
still needs a production retention/cleanup policy. The Workerd case does not
start the Linux Container or prove remote D1, DO, R2, provider, invoice, load,
alert, or rollback behavior.

### Pending before any canary

1. Archive the completed local 0050 migration-head/config, capability, Workerd,
   SQLite, Rust, and repository-gate evidence; then obtain authenticated remote
   migration/schema/capability readback without enabling the canary.
2. Rotate the exposed Cloudflare credential, sign the exact candidate, keep all
   gates false including replay-only and prepared-resume, inventory every old
   writer, and observe an empty canary drain query for the computed old-writer
   lifetime.
3. Freeze the target, archive Time Travel and full logical fingerprints, apply
   only 0050 in isolated staging, and read back the receipt/alias tables, both
   indexes, all eight guards, alias-set integrity, and rollback-safe negative
   probes.
4. Deploy the 0050-aware candidate with
   `container_chat_canary_admission_compiled=false`, run an endpoint-level
   Worker fault matrix against remote D1/Controller/R2, and deploy two real
   Worker versions while rotating current/previous secrets. Prove schema/query,
   unknown-history, missing/stale-secret history, and history-backed alias-miss
   503s, one alias winner, no duplicate reservation, debit, operation, or
   provider call, plus correct terminal/dispatched/prepared state gates and no
   `prepared -> dispatched` transition before every Controller/scheduler gate.
5. Complete the owner-fenced scheduled terminalizer, shared response
   interpreter, provider-native idempotency/lookup, financial/invoice
   reconciliation, code-audit and sign the default-off replay-only foundation
   as a rollback artifact, approve the current/previous key retention and drain
   runbook, add dedicated Workerd/remote proof, complete load/cost/alerts,
   security review, rollback rehearsal, and C1-C5/G1-G8 approvals. Until that
   audit closes, secret retirement after admission and rollback to any artifact
   capable of new pre-0050 writes remain forbidden. Rollback evidence must
   archive `container_chat_canary_replay_history_probe_known`,
   `container_chat_canary_replay_history_present`, and all three state-specific
   readiness booleans without exposing any identity.

Go/VPS remains the traffic and financial authority. The overall decision is
production **NO-GO**.

## 2026-07-18 Scheduled Terminalization Status

Migration `0051_relay_container_scheduled_terminalization.sql` and the local
owner-fenced scheduled terminalizer are present in the shared source tree. This
supersedes the 0050 status item that described autonomous terminalization as
unimplemented. It does not supersede any remote, billing, provider, lifecycle,
security, or approval blocker.

### Implemented locally

- Two independent exact-boolean gates,
  `CONTAINER_SCHEDULED_TERMINALIZER_ENABLED` and
  `CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED`, default to `false` in
  every tracked environment and must both be `true`.
- Runtime readiness additionally requires the existing Container operation
  replay authority, the compiled bounded observer, `FILE_BUCKET`, the complete
  0051 schema, and a live Controller probe proving probe/binding/authority,
  verified status, controller enablement, and execution enablement before any
  reconciliation item is claimed.
- Only a D1 `dispatched` or `recovery_required` operation with exact Controller
  `Completed` plus `DefinitiveTerminal` evidence becomes a candidate. The path
  does not dispatch, wake, retry, or resend the provider.
- Status v3 provider receipt/result evidence, with no v1/v2 fallback, read-only
  R2 result verification, frozen 0050 admission/reservation/operation linkage,
  and the recomputed settlement quote must converge before the financial writer
  is called. A manifest above the 4 MiB replay ceiling is rejected before the
  result body is buffered.
- One D1 batch commits terminal event, outbox, user/token/channel accounting,
  operation completion, reservation settlement, and the immutable
  `relay_container_scheduled_terminalizations` row.
- The 0051 insert guard verifies the active observation claim owner and
  generation, exact frozen lease expiry, lease and recovery deadline against
  D1 transaction-time `unixepoch()`, exact reconciliation revision, same-batch
  terminal tuple, settled reservation, completed operation, and immutable 0050
  admission. Any failed check rolls back the whole D1 batch.
- The scheduled evidence is unique per billing event and per
  operation/reconciliation revision. Update and delete are rejected.
- After a successful terminal commit, the observer reloads the operation and
  reobserves convergence. A lost response or crash after commit is resolved by
  durable readback; a crash before commit leaves no financial authority and a
  later lease generation may retry observation.
- Client and scheduled settlement share financial audit schema v2 derived from
  the persisted reservation and operation. The frozen `request_id_hash` is
  included; current request ID/CF Ray and client IP are excluded, preventing
  path-dependent terminal decision hashes.
- Typed failures preserve exact classes and codes: unavailable stores and
  missing replay material retry within the bounded horizon; divergent terminal
  material, contract violations, and conflicting financial decisions
  dead-letter immediately.

The R2 client response artifact remains outside the D1 transaction. It is
create-only replay material, not settlement authority; an artifact without the
matching D1 terminal tuple is orphan inventory and must follow the approved
retention/cleanup policy.

### Local verification checkpoint

The exact local release candidate passes the 51-migration SQLite verifier with
49 tables, 557 incremental columns, and 73 key indexes, including stale-owner,
wrong-frozen-expiry, D1-clock-expired lease, forged-result,
immutable-update/delete, and valid-commit 0051 fixtures. The migration-config
audit reports a contiguous 0051 head. Worker Rust tests pass 827/827,
Workerd/DO lifecycle scenarios pass 48/48, atomic Container admission scenarios
pass 15/15, and scheduler configuration scenarios pass 4/4. Workspace tests,
the Worker wasm32 check, formatting, `git diff --check`, and the repository-wide
`bun run check` aggregate also pass for this candidate.

These results are local SQLite/Workerd/source evidence only. No authenticated
remote migration, D1 batch, deployment, binding readback, provider response,
financial mutation, Container lifecycle, alarm, or traffic evidence exists.

### Remaining completion gates

1. Rotate exposed credentials and create separate least-privilege deployment
   and readback identities without recording secret values.
2. Sign the exact 0050/0051-aware Worker, Controller, DO, Container, broker,
   and rollback artifacts; prove all older terminal and reconciliation writers
   are drained.
3. Apply/read back 0050 then 0051 in isolated staging with all action gates
   false; archive target UUID, Time Travel bookmark, normalized schema/trigger
   bodies, full logical fingerprints, and direct negative probes.
4. Prove remote same-batch rollback, response-loss readback, lease
   expiry/reclaim, duplicate schedule/alarm, DO eviction/cold start, pre-body
   4 MiB rejection, R2 missing/divergent/orphan classification, stable
   client-versus-scheduler audit digest, transient/permanent failure routing,
   Container restart/OOM, and exact replay without a second provider call or
   accounting change.
5. Rehearse the locally implemented stable logical-shard identity, bounded
   cold-start and v0/v1 alarm-intent bridge against the real Container package;
   add the separately approved jurisdiction, one explicitly selected DO
   class-lifecycle mechanism (`exports` for new Workers or the retained legacy
   migration chain, never both), N/N-1 deployment, and complete cross-layer
   provenance.
6. Close provider-native idempotency or deterministic lookup, shared non-2xx
   response semantics, independent amount authority, provider invoice
   convergence, R2 retention, load/cost/SLO/alerts, rollback, security review,
   and C1-C5/G1-G8 approvals.

Normal rollback disables both scheduled-terminalizer gates before draining
reconciliation leases and returning new traffic to Go/VPS. Migration 0051 and
its evidence remain in place; no old writer, schema rollback, evidence delete,
provider resend, or ad hoc quota compensation is allowed. Go/VPS remains the
traffic and financial authority. Production remains **NO-GO**.

## 2026-07-18 RelayShardContainer Alarm Intent v1 Status

### Implemented locally

- DO-local immutable schema migrations 1/2 and the operation deadline intent
  table are initialized under bounded `blockConcurrencyWhile`; unknown future
  migration rows or failed pending-intent rearm reject initialization.
- V1 claim and initial unarmed intent are atomic; schedule success is followed
  by exact armed readback. Terminal operation transitions close pending intent;
  direct delete/replacement and out-of-range delivery state are rejected.
- The callback reads legacy v0 and strict v1, fences owner/shard/deadline and
  delivery generation, retries deterministically, stops after eight deliveries
  or 24 hours, and quarantines permanent or exhausted work.
- The `Container` base class remains the sole alarm owner. Recovery code uses
  `schedule()` and has no provider, settlement, refund, D1, or R2 action.
  Package 0.3.7 catches callback exceptions and deletes the one-shot task, so
  v1 persists delivery and creates its bounded retry/quarantine before return;
  persistence/reschedule failure calls `ctx.abort()` before cleanup can commit.
- The bounded pool remains one canonical DO/Container per logical shard;
  tenant HMAC selects the shard and does not create per-tenant objects.
- Both `CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED` and
  `CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED` are generated into
  all three Controller configurations as exact `false`; v1 reading/rearm is not
  gated. Execution with either writer gate false is rejected before claim by
  both Controller layers and reports not-ready; new v0 writes are removed. No
  D1 0052 exists or is needed.

### Verified locally

TypeScript compilation passes. The Controller Bun suite passes 95/95 and the
Workerd SQLite suite passes 34/34, including migration immutability, atomic
claim/intent, eviction persistence, armed state, early and due delivery,
duplicate terminal replay, stale generation, shard mismatch, retry exhaustion,
future-schema rejection, delete/replace guards, execution-gate interlock, and
zero provider-journal/retry/terminal-ack writes from recovery.

### Still blocked

The actual `RelayShardContainer` base alarm and Linux Container were not
instantiated by the ledger fixture. Remote object/schema/gate readback, real
eviction/cold start/sleep/restart/OOM, package callback failure, N/N-1 or
blue/green rollback, jurisdiction, provider-call counter, load/cost/SLO/alert,
and signed approvals remain open. The next code milestone is shared Go-parity
response/error/usage interpretation. Go/VPS remains authoritative and
production remains **NO-GO**.

### Response interpretation update

The source is pinned to Go commit
`73652508abc5cb09214dde02d51d69d1d1ccc703` and the local pure Rust contract is
`go-openai-response-v1`. Exact-200 success, typed HTTP-200 errors, compatible
non-200 envelopes, success-only usage, a six-header success allowlist, and zero
provider error headers are now the frozen packet-1 boundary.

This is not migration completion. The Container path still lacks migration
0052 raw-provider evidence plus separate interpreted client artifacts, protocol
v3, a DO/runtime rejected outcome that separates provider and client status,
financial terminal linkage, remote proof, and approvals. Receipt v1 remains
unchanged and canary remains blocked. See
`docs/response-interpreter-production-plan.md`.

Local packet P1 is now implemented and verified: the source-pinned 27-case Go
manifest, shared interpreter, Worker adapter, fail-closed Container egress
adapter, exact-200 receipt gate, header boundary, affinity guard, missing-usage
fallback preservation, wasm checks, and full `bun run check` all pass. This
changes no remote or production readiness verdict; packets P2-P5 remain open.

## 2026-07-18 Response Evidence P2 Status

This section supersedes the immediately preceding statement that P2 and D1
0052 are absent. P2 is complete only as a local candidate.

### Implemented locally

- Migration 0052 drains active pre-0052 canary work before adding independent
  immutable raw-provider and interpreted-client evidence, replacement-resistant
  identity ledgers, exact parent keys, and successful-terminal convergence
  guards.
- A no-default immutable operation writer contract rejects a late N-1 writer
  before prepared-operation creation/provider I/O; all four identity ledgers
  reject direct `INSERT OR REPLACE` even with recursive triggers disabled.
- The D1 readiness probe requires the migration marker, all eight persistent P2
  tables, the required raw/client/inventory columns, seven indexes, all 34
  authority/immutability/convergence triggers, and the terminal artifact column.
- The Controller exposes separate internal provider-evidence and client-artifact
  grants/routes. It derives exact keys, accepts empty raw evidence and a minimum
  `{}` client artifact, caps both at 4 MiB, and performs create-only R2 writes
  with exact replay or fail-closed conflict.
- Response inventory is isolated from 0044, immutable, observer-only, and has
  no apply/delete authority. No producer or activation gate is shipped.
- Protocol v3 is specified byte-for-byte, but no P3 encoder/verifier/DO/runtime
  implementation is claimed.

### Verified locally

The SQLite verifier passes 52 contiguous migrations, 57 tables, 667 required
incremental columns, 80 key indexes, exact 0052 object fingerprints, and its
positive/negative drain, identity, replacement, terminal, inventory, and
rollback cases. Controller compilation and its 103 Bun plus 90 protocol and 34
Workerd storage tests pass. Worker D1-head/readiness tests pass.

Negative fixtures also keep typed HTTP-200 out of the inherited failed shape
and prevent receipt-less success settlement. Those are P3/P4 design inputs, not
completed terminal paths.

### Still blocked

No authenticated remote migration/readback or R2/DO/Container evidence exists.
P3 must implement protocol v3 and the rejected terminal shape; P4 must own the
financial terminal decision; P5 must prove reader-first mixed-version rollout,
provider ambiguity, lifecycle/fault/load/cost/SLO/alerts, retention, rollback,
security and signed approvals. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-18 Response Protocol P3 Status

This section supersedes the preceding statement that the protocol-v3 encoder,
Controller verifier, DO migration 3, runtime rejected outcome, and exact replay
are absent. P3 is complete only as a local disabled candidate.

### Implemented locally

- Rust egress emits one canonical v3 envelope for success, typed HTTP-200 error,
  HTTP error, or invalid body, with exact Worker affinity and bounded bodies.
- TypeScript verifies exact transport and canonical bytes without
  reinterpreting provider semantics, then releases envelope base64 text before
  storage work.
- Controller preflight proves 0052/0048 schema and immutable admission authority
  before readiness, dispatch, or provider I/O.
- Raw/client R2 and D1 persistence is create-only/append-only, phase-separated,
  readback-verified, and crash-reentrant. Exact success writes its byte-identical
  compatibility result with exact `application/json` metadata and receipt before
  the client D1 foreign key; receipt-less success fails before raw R2 and every
  error class writes neither.
- DO schema migration 3 attaches the independent manifests and classification
  under operation/owner/attempt/egress fences. Success first binds the same
  compatibility result and receipt digest to the DO operation/attempt; replay
  validates D1 readback and preserves that order without provider resend.
- Runtime protocol 1 adds a strict `Rejected` outcome with outer 422 and a full
  client artifact manifest. Provider 202 is not success.
- Recovery classifies `none`, `raw_only`, or `complete`; all persisted,
  dispatched, unavailable, or conflicting post-provider states perform zero
  additional provider requests.
- The non-streaming P3 rollout limit is 1 MiB provider body and 3.2 MB envelope,
  while the frozen protocol/storage schema retains its 4 MiB compatibility
  ceiling. Exact-length allocation and base64/canonical-copy release preserve
  shared Worker-isolate memory headroom.

### Verified locally

The Controller passes 178 Bun, 165 portable protocol, and 38 Workerd/SQLite
tests. The artifact writer has 32 focused create/replay/conflict/classification,
4 MiB, receiptless-success, metadata-normalization, and crash-boundary tests.
Native Rust, Wasm egress build, and the
cross-language Rust-envelope/TypeScript-reader runtime packet are part of the
same candidate verification sequence. All tracked v3 gates remain false.

### Still blocked

P4 financial terminal ownership is absent, so complete P3 artifacts remain
recovery-required and terminal gate `true` hard-fails before provider I/O.
There is no authenticated remote 0052 readback, real R2 artifact, provider
call, DO/Container lifecycle campaign, deployment, secret change, accounting
mutation, or traffic switch. P5 remote mixed-version, fault/load/cost/SLO,
retention, rollback, security, and signed approvals remain open. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-18 Financial Terminal P4 Status

This section supersedes the preceding statement that P4 financial terminal
ownership is absent. P4 is complete only as a local disabled candidate.

### Implemented locally

- Migration 0053 introduces the drained and immutable
  `container-financial-terminal-v2` contract, generation-fenced response facts,
  anti-downgrade protection, exact terminal replay, and evidence identity.
- Exact success writes completed 200 and settles against its immutable usage
  receipt. Typed, HTTP, and invalid-body rejection writes failed 422, fully
  refunds the reservation, and leaves request accounting and receipt absent.
- Controller status v4 snapshots operation, attempt, raw evidence, client
  artifact, interpretation, and receipt without cross-read mixing.
- ACK v3 binds only response-backed final success or rejection. A recovery
  terminal has no complete P3 binding and remains an ACK-v2 projection.
- The Worker checks the raw R2 object's exact key, version, checksum, size,
  content type, 12 custom metadata fields, and bounded body digest before
  terminal convergence; client replay remains independently artifact-bound.
- Outbox, scheduled terminalization, reconciliation, canary audit, and replay
  share one immutable terminal event and cannot reopen provider dispatch.
- Readiness requires D1 head 0053 and the financial-terminal-v2 schema while
  every response rollout gate remains default false.

### Verified locally

The SQLite verifier passes 53 contiguous migrations, 57 tables, 674 required
incremental columns, 81 key indexes, and the 0053 drain/terminal positive and
negative matrix. Worker unit tests pass 837/837 and the wasm target check
passes. The Controller, response protocol, Workerd lifecycle, atomic-admission,
outbox, frontend, bundle, Wrangler dry-run, and workspace checks all pass in
the complete `bun run check` aggregate.

### Still blocked

No authenticated remote 0053 apply/readback, real R2 evidence, Durable Object
or Container lifecycle/fault campaign, provider call, secret change, financial
mutation, deployment, or traffic switch occurred. P5 still requires
reader-first mixed-version rollout, real response-loss/crash tests,
provider-call counters, load/cost/SLO/alerts, retention/privacy review,
disable-first rollback rehearsal, and named approvals. Go/VPS remains the
traffic and financial authority; production remains **NO-GO**.

## 2026-07-19 P5 Evidence Gate Status

### Implemented locally

- Canonical P5 subject identity binds commits, Worker/Container artifacts,
  shared resources, shard/ring, 0054, the canonical foundation capture,
  protocol contracts, cohort, and evidence.
- Ten category-specific evidence schemas enforce reader-first rollout, exact
  schema, lifecycle and financial faults, provenance, load/cost/SLO, rollback,
  and security/privacy thresholds.
- An external trust policy supplies role-scoped Ed25519 public keys. Five
  distinct owners sign only after the newest evidence capture.
- The verifier performs bounded, regular-file-only, in-bundle path and SHA-256
  checks; it rejects noncanonical JSON and never reads credentials or uses the
  network.
- Local/staging/production Controller configurations now share the same tracked
  D1 name/ID, CONFIG_KV, FILE_BUCKET, and Service Binding values as edge.
  Production placeholders remain hard deployment blockers until authenticated
  resource readback replaces them.
- Controller deploy commands now run a fail-closed preflight first. It rejects
  placeholder/zero IDs, public previews, disabled observability, any enabled
  action gate, and missing Controller/provider-egress secret names without
  reading or printing secret values.
- The staging runbook uses the 0055/55 and 62/771/91 schema baseline; the
  cutover runbook explicitly requires ordered 0052/0053/0054
  apply/readback/retention plus the P5 packet and Go/VPS process-owned drain
  gate.

### Verified locally

`bun run check:relay-container:p5-evidence` passes 42/42. The expanded
Controller config suite passes 12/12, and the deploy-preflight suite passes
18/18; its shared bounded-subprocess suite adds 4/4 termination/UTF-8 tests.
The contract-description command reports ten evidence kinds, five
approval roles, and explicit false authority for remote mutation, customer
traffic, and production cutover.

### Still blocked

No real packet exists. Remote collectors, replacement credentials, exact
versions/resources, all-shard readback, 0053 apply, real Container faults,
provider and financial counters, cross-layer traces, sustained load/cost/SLO,
alert delivery, rollback rehearsal, and owner signatures remain absent.
Production additionally needs a lossless Go/VPS drain and reverse data sync;
Go process maps and request-local billing state make a time-only drain unsafe.
Production remains **NO-GO**.

## 2026-07-19 P5 Foundation Collection And Go/VPS Cutover Status

### Implemented locally

- Foundation collector version 4 runs 13 fixed direct Cloudflare API GET
  requests before and after a bounded five-minute-to-two-hour window. Its
  credential-free plan enforces the exact API origin/account/path/query
  allowlist, fatal UTF-8, streamed and aggregate bounds, and digest-only output.
- The collector injects a rotated `CINATOKEN_P5_READBACK_TOKEN` only into
  in-memory Authorization headers. Live mode requires three explicit
  confirmations and never accepts a credential argument or writes a file.
- Candidate-freeze and remote-inventory P5 facts now bind the same canonical
  foundation capture, collector artifact digest, observation window, and
  complete pagination result.
- Stable shard registry/activation ledger, action-gate, SBOM/signature, R2
  writer/object, and traffic-isolation sources are mandatory. Cloudflare's
  running-instance view is not treated as proof of every sleeping DO shard.
- A separately versioned, canonical Go/VPS cutover verifier covers topology,
  HTTP/SSE/WebSocket/task ingress drain, per-process BillingSession/refund and
  five batch maps, persistence/export stability, scheduler ownership,
  bidirectional reconciliation, pending task/order handoff, and rollback.
- The Go/VPS verifier performs no environment read, network, shell, SQL, or
  file write. A complete packet is only eligible for production-cutover review;
  `productionCutoverAuthorized` is always false.

### Verified locally

- P5 evidence verifier: 44/44.
- P5 foundation collector: 24/24 plus offline self-test.
- Go/VPS cutover evidence contract: 23/23.
- Shared bounded subprocess plus Controller deploy preflight: 22/22.
- Both contract-description commands return hard-false customer/production
  authority.

### Still blocked

No replacement token was used and no authenticated remote readback, source
bundle, real shard ledger, SBOM/signature capture, R2 inventory, traffic proof,
Go process drain, reverse synchronization, rollback rehearsal, deployment, or
traffic change exists. The collector and verifiers can classify future proof;
they do not create that proof or approve release. Go/VPS remains authoritative
and production remains **NO-GO**.

## 2026-07-19 Shard Activation Evidence Status

### Implemented locally

- D1 migration 0054 provides a 20-column immutable shard activation ledger with
  candidate runtime build in both unique identities.
- Container `/readyz` returns a prewarmed, chunk-hashed runtime build ID and a
  typed 503 instead of panicking if executable hashing fails. Controller Version
  Metadata and an explicit expected-build fence bind a recorded row to the
  candidate without enabling provider or financial execution.
- The Controller writer checks the 0054 migration marker, exact 20-column
  catalog, ordered unique indexes, immutable trigger bodies, and critical
  constraints before insert. A real SQLite catalog test applies the migration.
- A root-only Worker endpoint enumerates the ledger with a frozen high
  watermark, bounded keyset pagination, no-store responses, and no DO/Container
  wake path.
- A staging-only collector validates each page and activation digest, computes
  missing/duplicate/unknown shard counts from entries, and requires stable
  before/after snapshots for every index in the candidate ring.
- P5 candidate/source contracts bind runtime build and image-provenance digests,
  use sources v3, and enforce the real 1024-shard limit.
- The P5 manifest reads and hashes the actual canonical foundation capture and
  compares both emitted fact objects, rather than accepting a shared digest
  claim alone.
- The detailed pinned Go source audit documents why existing VPS status and
  connection counters cannot prove process-local financial drain.

### Still blocked

No authenticated 0054/0055 apply/readback, Worker/Container deployment,
runtime probe, sources-v3 packet, image provenance artifact, or live VPS
observation was performed. Collector version 4 now implements bounded,
cursor-aware all-page Cloudflare readback locally, but no rotated credential
has exercised the real endpoints. A same-version one-time activation campaign
is implemented locally but has not been deployed or exercised;
changing the static gate would still create a different Controller version and
cannot satisfy the action-gate evidence. The exposed
credential must be rotated before any remote action. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-19 Migration 0055 Activation Campaign Status

### Implemented locally

- Migration 0055 advances the D1 baseline to 55 migrations, 62 tables, 771
  checked incremental columns, and 91 key indexes. Campaign, claim,
  consumption, and seal rows are immutable; expiry materialization is bounded
  and idempotent.
- Root create/status APIs bind one nonce hash to the exact Controller version,
  all-false 22-gate inventory, foundation manifest, runtime candidate, ring,
  environment, root operator, and D1 expiry. The status API validates and
  returns full receipts.
- The Controller claims D1 before any DO lookup, strips the raw nonce before
  RPC, and treats completed D1 consumption as replay-only. D1 and DO readiness
  result hashes must match.
- Durable Object schema v6 journals each probe as started, completed, or
  ambiguous with canonical result JSON/hash and a minimum two-hour retention
  horizon. Timeout never grants a second wake.
- Final D1 consumption atomically projects the matching 0054 activation and
  auto-seals only at N/N. Failed, expired, and aborted campaigns cannot
  promote and retire any candidate with effect evidence.
- The root readiness gateway now recognizes a strict campaign credential as
  the one-time capability. Ordinary probe/wake requests remain governed by
  their default-off static flags; malformed or absent campaigns cannot bypass
  them.
- Shard registry capture v2 and foundation sources v3 require a stable
  `sealed_complete` campaign, exact receipts `0..N-1`, recomputed readiness,
  activation and consumption hashes, and one matching 0054 row per receipt.

### Local verification boundary

The required gate includes the full Worker unit suite and wasm check,
Controller Bun/type/portable/Workerd suites, exact SQLite migration verifier,
P5 shard/foundation/evidence suites, repository aggregate check, formatting,
and diff hygiene. These commands prove local contracts only; their final
counts must be copied from the actual release-candidate run, not this status
text.

### Still blocked

The exposed Cloudflare credential has not been rotated. Remote staging has not
applied or read back 0055, no same-version candidate was deployed, no campaign
or DO journal exists remotely, and no Container was woken. Authenticated,
stable collector-v4 all-page control-plane inventory, sources-v3, P5 fault/load/cost/SLO
evidence, five approvals, Go/VPS process drain, reverse synchronization, and a
measured rollback remain absent. Go/VPS stays authoritative and production
remains **NO-GO**.

## 2026-07-19 Edge Version And Linux Release Gate Status

### Implemented locally

- Root, staging and production edge Workers now declare non-inherited
  `CF_VERSION_METADATA` bindings.
- The admin platform capability response exposes the edge Worker version ID and
  the verified Controller version, all-false gate result and gate-inventory
  SHA-256.
- Container builder/runtime bases and the Linux test mock are digest-pinned.
- A read-only, credential-free GitHub job builds `linux/amd64` and runs a real
  isolated process gate. It validates image metadata, readiness/build identity,
  one-attempt success, ambiguous no-retry, input-integrity failure, graceful
  SIGTERM and same-image restart.
- The offline contract/self-test is part of `bun run check` and grants hard
  false remote, customer-traffic and production authority.

### Verification boundary

Local tests can prove configuration, parser, supply-chain pins and fail-closed
test design. This Windows workspace has no Docker/Podman/WSL runtime, so it
cannot claim that the Linux image was built or executed here. The dedicated CI
job is the executable evidence producer; its successful candidate run must be
retained before release review.

### Still blocked

There is no retained successful Linux candidate job in this local evidence, no
SBOM/signature or image-to-runtime provenance packet, and no authenticated
Cloudflare version/image/lifecycle readback. The exposed credential still must
be revoked. Remote migration 0055, sealed N/N activation, P5 faults/load/cost/
SLO/rollback/signatures, durable streaming/financial closure, and Go/VPS drain
remain outstanding. Go/VPS stays authoritative and production remains
**NO-GO**.

## 2026-07-19 Linux Gate First Remote Failure Closure

### Remote evidence

GitHub run `29675418915` for exact commit
`16fd13b63832562aaf6399fb426a871b829fcdff` built the pinned Linux/amd64 image
successfully but failed before the first runtime scenario because host port
discovery returned a non-zero result. It is explicitly a failed release gate,
not partial success.

### Implemented locally

- Host port publication and `docker port` discovery are removed.
- A read-only Node probe runs inside the digest-pinned mock container and uses
  only the internal runtime alias plus mock loopback.
- Runtime and mock remain on one `--internal` network with read-only roots,
  dropped capabilities, `no-new-privileges`, and memory/PID limits.
- `actions/checkout` advances to the full v7 commit and retains
  `persist-credentials: false`.
- Offline tests require the probe, internal alias, `docker exec`, and the
  absence of any host publish argument.

### Verification boundary

Focused local verification passes 18/18 with 273 expectations and the Linux
contract passes 5/5 with 42 expectations. A new exact-candidate GitHub run is
still required to prove the native process path. This closure grants no
Cloudflare, customer-traffic, financial, or production authority. Production
remains **NO-GO**.

## 2026-07-22 Native Linux Gate Green Evidence

### Exact run history

- Run `29884596667` at commit
  `a67afa164a644e3f66e12fc7d8e97e89a59c8a0f` passed checkout, contract, and
  image build, then exposed the mock port mismatch at `docker exec`.
- Run `29885010523` at commit
  `20908f8282876d08046d55967e42eddf00015934` passed the complete
  `linux-amd64-e2e` job, including real image build and process execution.

The green report proves the digest-pinned image is `amd64`, runs as
`nonroot:nonroot`, has stable build ID
`dcda452174385d048e8b25f1f9cf0dcb762b0c02b90462022802d62829b1d824`, and
passes health, single-attempt success, ambiguity, input-integrity, SIGTERM, and
same-image restart scenarios without host-published ports. No Cloudflare or
provider credential was present.

### Next production-critical slice

Cross-repository audits of cinaVibeSDK, Go/VPS cinatoken, and the Rust target
agree that ordinary paid HTTP SSE still lacks a durable owner between first
client byte and persisted financial finalization. The next vertical slice is
`Ordinary HTTP SSE Durable Terminal Handoff v1`: persist owner/attempt and the
frozen billing snapshot before forwarding; use one instrumented stream; persist
bounded terminal evidence/outbox before releasing the terminal event; and let a
generation-fenced recovery owner close stale forwarding rows without provider
resend.

Container `stream:true` and all remote capability gates remain false. Remote
migration 0055+, Cloudflare image/version/lifecycle readback, P5 fault/load/
cost/SLO/rollback/signature evidence, exposed-credential rotation, and Go/VPS
drain are still missing. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Durable Handoff Status

Migration 0056 and the default-off Worker candidate now provide a durable
terminal boundary for positive paid ordinary HTTP SSE. The implementation
freezes reservation/owner/attempt identity, Worker version and billing hashes,
persists monotonic bounded stream checkpoints, stages immutable finalization
event evidence before releasing the provider terminal chunk, leases Queue
outbox work atomically, and permits financial-terminal convergence only after
an exact append-preserved apply receipt.

The request path rejects matching handoff replay. Recovery is generation-fenced
and never re-dispatches the provider. Provider failed/incomplete terminals,
read/parser/idle failures, lease loss, dead-letter, and uncertain terminal
evidence remain explicit `recovery_required`. Partial usage is never used after
a stream parse failure; settlement freezes at the approved pre-consumption.

All four producer/staging/outbox/recovery flags remain false in every tracked
environment. Local implementation and D1/Workerd contracts do not close the
provider-dispatch-to-handoff crash window, immediate client cancellation,
total stream deadline, or real Cloudflare Queue/D1/restart/version-skew fault
evidence. Remote 0056, credential rotation, P5, and Go/VPS drain remain absent.
See `docs/relay-http-stream-durable-handoff.md`. Production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Dispatch Intent Status

Migration 0057 was the local head for that increment at 57 migrations, 65 tables, 841
checked incremental columns, and 96 key indexes. It closes the gated paid SSE
provider-dispatch-to-handoff persistence window by adding an atomic
reservation-bound `prepared` intent, a single send-authorizing dispatch CAS,
conservative response/transport recovery, and transactional 0056
`stream_bound` promotion before client bytes.

The first candidate permits one provider attempt and disables retry/fallback
after dispatch. Response headers are bounded to 120 seconds. A 900-second
immutable hard deadline caps stream leases, and the scheduler recovers expired
pre-handoff intents without provider resend. Dispatch recovery atomically
advances the billing reservation recovery owner.

The recorded 0057 local SQLite 57/65/841/96, config audits, Worker 858/858, production Worker
build, Workerd lifecycle 50/50, P5 fixture tests, and the complete 878.4-second
repository aggregate pass. All four SSE gates remain false.

At the 0057 increment, immediate client cancellation still lacked a
`Request.signal`-driven durable watchdog, and the durable-disabled clone/tee
path lacked slow-consumer backpressure proof. The 0058 and single-forwarding
sections below supersede both local gaps. Remote current-head Queue/D1/restart/
version-skew/provider-invoice campaigns, P5, credential rotation, and Go/VPS
drain/rollback evidence remain absent. Go/VPS stays authoritative and
production remains **NO-GO**.

## 2026-07-22 Migration 0058 Client-Abort Status

The current source-tree D1 head is now 0058 with 58 contiguous migrations, 66
tables, 848 checked incremental columns, and 97 key indexes. Historical 0057
counts remain valid only for their recorded increment and are not the current
candidate baseline.

Implemented locally:

- incoming `Request.signal` compatibility and capture before body consumption;
- 0058 readiness before provider I/O;
- synchronous abort-listener arm before response return;
- append-only exact abort evidence and atomic
  `forwarding -> recovery_required/client_disconnected`;
- first-durable-decision-wins provider-terminal/abort races;
- bounded D1 retry, no automatic refund/resend, and durable-readback disarm;
- direct SQLite/Workerd D1 race coverage; and
- an end-to-end gate-enabled Rust Worker service-binding test that reads one
  SSE chunk, cancels the reader, observes one provider call, preserves billing
  pre-consumption, and records zero request accounting.

The end-to-end test also discovered a 0057 D1 parameter-binding mismatch before
provider I/O; admission UPDATE and INSERT now bind exact independent arrays in
the same atomic batch. This is a real runtime correction, not only a schema
test update.

The exact source worktree passes Worker 858/858, all remaining Rust workspace
tests, SQLite 58/66/848/97, P5 68/68, Workerd 52/52, configured wasm checks and
the complete `bun run check` aggregate in 845.2 seconds.

Not complete: real Cloudflare HTTP/2/HTTP/3/TCP/WFP cancellation, D1
write/response loss, isolate restart/deploy/version skew, Queue ambiguity,
provider invoice reconciliation, remote 0058 apply/readback, load/SLO/cost and
alerts, P5 signatures, credential revocation proof, and Go/VPS drain/reverse
sync/rollback. The clone/tee backpressure item was open at this checkpoint and
is superseded by the single-forwarding status below. All four SSE gates remain
false. Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-22 Ordinary HTTP SSE Single-Forwarding Status

The ordinary durable-disabled HTTP SSE path now has one response-owned,
pull-driven forwarding stream. It no longer uses `Response::cloned()`, clone,
or tee for audit/billing consumption. Usage accumulation remains in that stream;
provider terminal ownership is synchronously claimed and registered as a
short-lived `waitUntil` task before the terminal chunk is yielded. A separate
`Request.signal` listener and stream-drop fallback claim only a pending owner and
then register client finalization. The bounded lease heartbeat uses one
cancelable timer and one short renewal task at a time; it does not consume the
provider body or hold a response-lifetime `waitUntil`.

The focused local Workerd case reads one chunk from a 256-chunk provider and
pauses for 300 ms. The provider remains incomplete with no more than eight
pulls. After controlled terminal release and client drain, source pulls advance
by at most one and stay below 256; billing settles with positive upstream usage,
no parse failure, one request accounting update, Queue transport, and
`provider_terminal_event` convergence. Static mutation audit separately rejects
pull-owned async financial finalization.

Accepted: one pull-driven response stream, bounded incremental state,
synchronous provider-terminal `waitUntil` registration, a separate first-owner
client-abort listener/drop fallback, a single-timer heartbeat, and frozen-reserve
cancellation.
Rejected: clone/tee, detached body consumption, unbounded prefetch/buffering,
partial-usage charging after ambiguous disconnect, automatic refund/resend, or
promoting local reader cancellation as edge-network proof.

Rollout freezes the candidate and hot Go/VPS fallback, keeps durable SSE gates
false, runs isolated slow-reader/terminal/fault canaries, and requires retained
HTTP/2, HTTP/3, direct/Gateway/WFP reconciliation before promotion. Rollback
routes new SSE traffic to Go/VPS and keeps the exact N drain owner plus
migrations/evidence; it does not restore clone/tee or resend ambiguous provider
work.

The local clone/tee and bounded-provider-read blocker is complete. Real
Cloudflare HTTP/2, HTTP/3, and TCP client-disconnect propagation remains remote
evidence, alongside the existing D1/Queue/restart/invoice/SLO/security/P5 and
Go/VPS drain gates. Production remains **NO-GO**.

## 2026-07-22 Container Shard Routing Contract Status

The previously open cross-language shard-planner item is now locally complete.
One strict fixture is consumed by an independent Bun HMAC/Jump-Hash verifier
and the Rust production planner. It covers four test-only secrets and tenant
inputs, 16 exact plans, eight generation-fenced one-shard expansions, one move
only to the appended shard, canonical instance names, mutation rejection, and
the 1024-shard maximum. The aggregate gate now runs this contract before the
tracked scheduler configuration tests.

The result proves deterministic cross-language planning, not deployment. A
production ring change still requires admission stop, complete old-generation
drain, Controller-first N+1 activation, generation/count atomic change at the
release level, remote distribution and capacity replay, lifecycle faults,
billing/provider uniqueness, and rollback. Routing-secret rotation is a
separate candidate and the exposed Cloudflare credential remains unusable
until revocation is proven. Go/VPS stays authoritative and production remains
**NO-GO**.
