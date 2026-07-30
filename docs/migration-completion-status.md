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

## 2026-07-27 WORM B4 Data Collector Foundation

| Status item | Current value |
| --- | --- |
| B1/B3 predecessor binding | Exact canonical single-link receipts and strict chronology |
| B4 publisher continuity | Access-key digest must equal B1 publisher |
| Create-only publication | Six `PutObject` requests with `If-None-Match: *` |
| Artifact integrity | SHA-256 + Content-MD5; 512 MiB each / 768 MiB aggregate |
| Independent inventory | Complete object and multipart pagination |
| Independent object readback | Six `GetObject` requests with exact ETag `If-Match` |
| Local readback files | Empty directory, no-overwrite promotion, second stable digest |
| Focused gate | 11 tests / 76 expectations |
| Strict lifecycle chronology gate | 18 tests / 115 expectations |
| Credential-free self-test | 2 cases / 12 invariants |
| Nine-suite supply-chain gate | 104 tests / 938 expectations |
| Complete repository gate | PASS, exit 0 in 604 seconds; 21 existing Rust warnings |
| Live Cloudflare B4 evidence | **NOT COLLECTED** |
| B5 probes and publisher lifecycle | **PENDING** |
| Complete B2-B7 / S3 | **FALSE** |

This is local B4 collector readiness, not retention evidence. No credential
was read, no provider operation ran, and no collector live phase wrote an
evidence-output file during verification. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-26 Deterministic Container SBOM Status

S1 is complete for one frozen hosted-job subject. Candidate
`53c7e1802dd7461f58bd9755a30dfcf3e5201a20` passed
[run 30200272629](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629)
and
[job 89788901459](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629/job/89788901459).
Two isolated, nonroot, network-disabled Syft 1.49.0 executions cataloged the
two exact OCI archives and produced byte-identical 973,539-byte Syft JSON:
`sha256:0b28e8fb597b6294605a68977f33968b294cebbad79bdac9986e062ff432ec60`.
The catalog contains 10 packages and 1,293 relationships.

The gate independently rebinds the OCI manifest/config, all 19 compressed
layers, all 19 uncompressed diffIDs, and runtime binary
`1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910`.
[Artifact 8631431136](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200272629/artifacts/8631431136)
is 22,725,635 bytes with
`sha256:a189a1f5aaa4ba6d38042fc03fe5472c19b80b4fa9fbeab12c440f6084bfb3a2`
and expires `2026-08-25T11:32:53Z`.

Cross-hosted-job reproduction is complete. Docs-only successor
`24a7252641bb7906b9a9091a39b624b18cedcbf9` passed
[run 30200802649](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200802649)
with the same 973,539-byte SBOM hash, package/relationship counts, OCI graph,
19 source layers, and runtime binary.
[Artifact 8631590135](https://github.com/cinagroup/cinatoken-rust/actions/runs/30200802649/artifacts/8631590135)
is 22,725,602 bytes with
`sha256:66d3786ffe01cf3cbe38cf4bdba8ea77f173cfe4ad870d9db5402e9b2a5c9b6f`
and expires `2026-08-25T11:49:32Z`.

This status remains `local-sbom-reproducibility-only`. Vulnerability scanning
with a frozen database, provenance, signature, immutable retention,
registry/Cloudflare digest readback, P5 and production review remain open.
Vulnerability counts remain null and all remote, traffic and cutover
authorization remains false. Go/VPS stays authoritative and production
remains **NO-GO**.

## 2026-07-26 Container Vulnerability Gate Status

S2 is implemented and reproducible, but the current glibc runtime candidate is
blocked. Candidate `93dca768deca3f09a3085772e8ba3dff1781c1e9` completed
[run 30204421553](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553)
and
[job 89799900370](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553/job/89799900370).
OCI reproduction and deterministic SBOM generation passed; the final S2
process exited 1 only after emitting a complete decision.

The scan used digest-pinned Grype 0.116.0, exact linux/amd64 scanner manifest
`sha256:3d08845e...`, the exact 973,539-byte S1 SBOM, and a frozen Grype DB
`v6.1.9`. The retained database archive is 137,741,137 bytes at
`sha256:766bec0e...`; both imports produced the same 1,957,412,864-byte
database at `sha256:55279915...`. Network was disabled during both scans, all
database and SBOM inputs were read-only, suppressed findings were visible, and
the ignored match count was zero.

The policy blocks Unknown, Critical, and High findings and has zero approvals.
The exact scan contains 17 unique findings: 12 Negligible, 2 Medium, 2 High,
and 1 Critical. The three blockers are Debian 12 `libc6`
`2.36-9+deb12u14`: Critical `CVE-2026-5450`, High `CVE-2026-5435`, and High
`CVE-2026-5928`. The finding-set digest is
`sha256:60455e147510a64e744e72fff8f3069c73637490b4cd39472497d3f83fc4c194`.

[Artifact 8632661369](https://github.com/cinagroup/cinatoken-rust/actions/runs/30204421553/artifacts/8632661369)
is 160,649,108 bytes with
`sha256:7b3abc803ba0af46da58bc78d3cfdd9d0bf88d7d1969fa61b85469772cbc2b91`
and expires `2026-08-25T13:41:35Z`.

This is a successful policy rejection, not an accepted release candidate.
Static-musl image remediation and a new OCI/SBOM/S2 subject are required before
S3. No exception was added. Canonical registry identity remains null and every
signature, registry, Cloudflare, P5, remote mutation, traffic, and cutover
authorization remains false. Go/VPS stays authoritative and production
remains **NO-GO**.

Cross-job OCI reproduction is also complete for this scoped baseline.
Docs/schema-only successor `61be8211f599a48b14e9419a1ce04e26d5128360`
passed
[run 30197404664](https://github.com/cinagroup/cinatoken-rust/actions/runs/30197404664)
with the same OCI archive/index/manifest/config, all 19 compressed layers and
diffIDs, and the same runtime binary. Its
[artifact 8630552244](https://github.com/cinagroup/cinatoken-rust/actions/runs/30197404664/artifacts/8630552244)
is 20,767,686 bytes,
`sha256:36439496d6b6a1b61821a9ac0b3205b1a4dcc19bd13fcfdbef12f5b47cf14089`,
and expires `2026-08-25T09:59:47Z`. Worker diagnostics make the ZIP identity
job-specific; the portable OCI subject is exact.

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

`bun run check:relay-container:p5-evidence` now passes 66/66. The expanded
Controller config suite passes 12/12, and the deploy-preflight suite passes
18/18; its shared bounded-subprocess suite adds 4/4 termination/UTF-8 tests.
The contract-description command reports eleven evidence kinds, five
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

## 2026-07-26 Container Runtime Isolation Status

The local production-image isolation increment is complete. The runtime now
has a fixed read-only attestation subcommand and the Linux gate proves the
digest-pinned distroless image, root-owned immutable application layout,
nonroot UID/GID 65532 process, zero capability masks, NNP, seccomp, read-only
root, exact private `/tmp`, bounded writable mounts, no ACL override, bounded
FD classes, no path-backed FD leak, internal-only networking, graceful
shutdown, and same-image restart policy stability.

Accepted candidate
`304a8c1569db9c479430ef003379cc55d688ce54` passed
[run 30192249580](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580).
Its image ID is
`sha256:85b333c3804a82031359929ea422baf98f35aed15e3062bff95ba0744f86f9e6`,
runtime build ID is
`1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910`,
and independently recomputed primary/restart policy ID is
`sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`.
[Artifact 8628969468](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/artifacts/8628969468)
is 2761 bytes with
`sha256:c9d7d549c39e6879cf1cb29f7ea1982f93f4c39a537d5381037935c30686964a`
and expires `2026-08-25T07:08:57Z`.

This status closes the local Ubuntu/Docker image/process gate only. Remote
Cloudflare image/version/class readback, host namespace/cgroup and lifecycle
evidence, DO supervisor recovery, D1/DO/R2 provenance joins, persistent
storage/power-loss/restore, load/cost/SLO/alerts, signed/WORM retention,
credential revocation, financial reconciliation, rollback, and G1-G8 remain
open. No remote mutation or traffic switch occurred. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-26 Container Image Reproducibility Status

The local same-checkout image reproducibility item is complete. Contract
version 5 builds the production image twice without cache, rewrites exported
layer timestamps to `SOURCE_DATE_EPOCH=0`, installs the binary into a fully
normalized runtime root, and fails closed unless image ID, image config,
ordered RootFS layers, copied binary hashes, live build identity, runtime
policy, and restart policy all agree.

Accepted candidate
`cbe749907931435e280686c9b8c935b08fdd085f` passed
[run 30194108625](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625).
Both builds produced image
`sha256:6a2f92415570e2b13e033b8c0d3d1acaadccf2bfa60ebd8d63faa359b687c514`,
19 equal ordered layers, binary/build identity
`1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910`,
and runtime policy
`sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`.
[Artifact 8629556865](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/artifacts/8629556865)
is 7822 bytes with
`sha256:1bfac70cb2dd38418da1115ef5b6a15a67b46bb893fd00076a1cc5e8fe2b8ffe`
and expires `2026-08-25T08:10:57Z`.

Runs 30192996455 and 30193875952 are retained negative calibration: the first
rejected epoch-only builds; the second proved that config equality and exporter
timestamp rewriting still left final layer 18 different. Normalizing the
complete runtime root closed that drift.

Remaining image-supply-chain work is independent-host and pinned-builder OCI
manifest reproduction, registry digest readback, SBOM and vulnerability
policy, signed provenance, transparency/WORM retention, and joining the exact
digest to Controller, DO, shard generation, and Cloudflare Container
deployment identities. This local status does not change remote migration or
cutover authority. `productionCutoverAuthorized` remains false, Go/VPS stays
authoritative, and production remains **NO-GO**.

Cross-job reproduction is also complete. Docs-only successor
`d407e44285a71d7d3fab50db0107eeca877450db` passed
[run 30194409010](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010)
with the same image ID, 19 layers, binary/build ID, policy ID, and attestation
JSON digest. Its
[artifact 8629649636](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010/artifacts/8629649636)
is 7828 bytes,
`sha256:ccef6562a6fa8d2774ef196a152c55506472e6c264bffe53c8aab1443c0d7648`,
and expires `2026-08-25T08:20:56Z`. Cross-host Docker storage-driver paths and
tag timestamps changed as expected and are not image identity. The next open
supply-chain status is registry-bound OCI byte reproduction and signed
provenance, not another local Docker image rebuild.

## 2026-07-26 OCI Archive Reproducibility Status

The pinned-builder OCI baseline is locally complete. Contract version 1 uses
two distinct BuildKit `v0.31.2` daemon instances, two no-cache linux/amd64
builds, deterministic gzip/OCI exporter options, and a fail-closed parser for
the complete archive, descriptor graph, layer digests/diffIDs, application
metadata, and binary.

Candidate `383f53f5559674a9947b1939993ef2d9bdf0dd6a` passed
[run 30196543635](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635)
and [job 89778965995](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/job/89778965995).
A/B archives are byte-identical at 10,378,752 bytes and
`sha256:bdd67bd4335a922081e35fe344fb481599730ec37a3833d17fea85407852fb7e`.
The exact index/manifest/config values are `258828d4...`, `84ff0214...`, and
`7b1326fd...`; all 19 compressed layers and diffIDs match, and the runtime
binary remains `1ec31f...`.

[Artifact 8630296572](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/artifacts/8630296572)
is 20,767,686 bytes,
`sha256:8ccbf80f44f8d134579b89f4cde8806d7f1460ee33524b27244ee5c8ed4d8014`,
and expires `2026-08-25T09:31:03Z`. Independent download and extraction
matched the artifact, both tar files, both complete OCI graphs, and the
5223-byte verifier report.

This does not complete the image supply chain. Independent-runner repetition,
registry/Cloudflare digest readback, SBOM, vulnerability policy, signed
provenance, transparency/WORM retention, runtime deployment join, and P5
remain open. Unknown vulnerability counts remain null, not zero.
`p5Eligible` and `productionCutoverAuthorized` remain false; Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-27 Static-musl S2 Accepted

The prior glibc rejection remains valid historical evidence, but its remediation
is now complete for one frozen static-musl subject. Commit
`162cad5b9515309b40addcde52fcb66fc753d3b3` passed
[run 30229751845](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845)
and
[job 89866237796](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845/job/89866237796).
The exact OCI archive/index/manifest/config are `7089fef2...`, `ad706ef6...`,
`21a453f4...`, and `6feab213...`; the static runtime binary is `01fa7759...`.

The 665,849-byte SBOM is byte-identical across A/B at
`sha256:76aa5ae7bc8f849f0bd5af8dd3bb257be191a0e37639f28e858748bc9064ab9c`.
Vulnerability contract v3 independently extracted the frozen database twice.
Both 1,475,883,008-byte files are
`sha256:5e1fd5545a3c4188cb9542003fd3717753c60730c17dcecde14f45e7ee691b50`
with xxh64 `d8a8cef5bc65efe7`; both deterministic 109-byte import records are
`sha256:303e1b7f0192f60b76198859b1896504a2f857e56aa89deca93b43562d6c119c`.
Pre/post input snapshots matched exactly.

Pinned Grype 0.116.0 ran twice nonroot, offline, and against read-only DB/SBOM
mounts. The exact A/B report is 15,691 bytes at
`sha256:62c9c6e8feca90edc0ff740703f7d594fd26b79057d9f85b0bd0b3201d28c95f`:
0 matches, 0 ignored, and 0 Unknown/Critical/High findings. No approval or
exception was added.

[Artifact 8639704084](https://github.com/cinagroup/cinatoken-rust/actions/runs/30229751845/artifacts/8639704084)
is 144,729,887 bytes,
`sha256:29a2f64564298f6b1ed77f6b920be8fcd3d3a93fd882edd80db558884e54d05b`,
and expires `2026-08-26T01:27:29Z`.

R2/S1/S2 are accepted for this subject only. S3 provenance/signature,
transparency/WORM retention, registry and Cloudflare digest readback, isolated
staging, managed lifecycle, P5, remote mutation, traffic, and cutover remain
open and unauthorized. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-27 S3 Cryptographic Subgate Accepted

The status above is superseded only for S3 cryptographic evidence. Commit
`882b5e66d79df39ff29d28beff7d4348e3d12bda` passed source
[run 30235408005](https://github.com/cinagroup/cinatoken-rust/actions/runs/30235408005)
and signer
[run 30235508407](https://github.com/cinagroup/cinatoken-rust/actions/runs/30235508407),
[job 89882466443](https://github.com/cinagroup/cinatoken-rust/actions/runs/30235508407/job/89882466443).

| Status item | Current value |
| --- | --- |
| S3 source/subject binding | PASS for the exact seven OCI/runtime/SBOM/scan subjects |
| S3 signer policy | PASS; exact workflow identity, GitHub OIDC issuer, source event/ref/commit |
| Sigstore verification | PASS; one exact DSSE signature, Fulcio/SCT, Rekor inclusion, RFC3161 |
| Statement / bundle | `352827db...` / `bfe0ab28...` |
| Retained diagnostic packet | [artifact 8641497252](https://github.com/cinagroup/cinatoken-rust/actions/runs/30235508407/artifacts/8641497252), `sha256:5d66b6e...`, 90 days |
| Approved immutable/WORM retention | **PENDING** |
| Complete S3 | **FALSE** |
| Registry publication/readback | Not performed |
| Cloudflare C1 deployment/readback | Not performed |
| P5/canary/cutover | Not authorized |

Independent download reproduced the artifact, statement, bundle, and DSSE
payload hashes. Rekor log index is `2256847653`; both inclusion promise and
proof exist; one signed timestamp is verified. The final report correctly
keeps `imageSignatureVerified=false`, `wormRetentionVerified=false`,
`s3Complete=false`, `p5Eligible=false`, and
`productionCutoverAuthorized=false`.

The next status transition requires a dedicated R2 evidence bucket, reviewed
bucket-lock rule, separate publisher/lock/verifier identities, exact object
readback, provider-side overwrite/delete rejection, and an independently
signed or reviewed receipt. R2's AWS S3 Object Lock headers are not the
selected mechanism; Cloudflare bucket-lock configuration and readback are
required. Only after that evidence passes may R3 registry publication and C1
isolated Cloudflare staging begin.

Go/VPS remains the traffic, scheduler, provider, and financial authority.
Production remains **NO-GO**.

## 2026-07-27 R2 Retention Contract Implemented

The next S3 implementation layer is now present locally. A fail-closed offline
verifier binds the exact source/provenance packets, statement, Sigstore bundle,
report, Cosign log, Cloudflare R2 target, bucket-lock rule, object readbacks,
provider overwrite/delete rejection, writer-credential revocation, and
independent operations/security signatures.

The authority model reflects Cloudflare's real permission surface. The
publisher uses bucket-scoped object read/write; the lock operator necessarily
has R2 Admin Read & Write, including object authority; object and lock
readbacks use distinct read-only credentials. The lock operator must be
revoked before upload and the publisher after probes, leaving no active writer
at decision time.

The focused local suite passes 10/10 tests, including layout, authority, lock,
object, probe, freshness, signature, provenance, and policy weakening
negatives.
Credential-free self-test passes but correctly reports no remote evidence and
no storage mutation. The complete repository aggregate check also passes.

This is contract readiness, not S3 completion. No real R2 bucket-lock bundle
has been collected, so approved immutable/WORM retention is still
**PENDING**, complete S3 is **FALSE**, and R3 registry/C1 Cloudflare staging
remain blocked. Cloudflare lock-rule mutability is an explicit limitation;
regulatory non-bypassable retention would require a separately approved
control. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-27 R2 Staging Collector Foundation

The first credentialed retention operations are implemented but have not been
run. A default-dry-run CLI now separates:

- publisher-only S3 object and multipart empty-prefix baseline collection;
- lock-operator-only Cloudflare bucket-lock `GET -> PUT -> GET` collection.

The collector pins AWS SDK v3, exhausts pagination, preserves unrelated lock
rules, requires exact final readback and Cloudflare correlation, emits only a
canonical redacted stdout receipt, and writes no files. Fourteen focused tests
with 80 expectations cover credential separation, malformed identity,
pagination cycles, prefix escape, existing content, redirect, unknown
response shape, token reflection, ambiguous rerun, and rule drift.

The seven container supply-chain suites pass 72 tests with 642 expectations.
The full repository aggregate also passes in 621.8 seconds.

This is B1/B3 tooling, not B1-B7 evidence. No dedicated bucket was queried, no
lock was changed, no credential was read, and no object was uploaded. B2
independent identity review and provider-confirmed lock-operator revocation
must precede B4 publication. Complete S3 remains **FALSE**; registry and C1
remain blocked; Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-27 Lock-Operator Lifecycle Collector Foundation

The local retention substrate now extends through the lock-operator account
token lifecycle:

| Status item | Current value |
| --- | --- |
| Canonical lock-v2 predecessor validation | PASS locally |
| Lifecycle operator identity separation | PASS locally with provider-shaped fixtures |
| Exact target DELETE plus operator `404` | PASS locally with provider-shaped fixtures |
| Independent verifier identity plus second `404` | PASS locally with provider-shaped fixtures |
| Stable single-link predecessor file boundary | PASS locally, including hard-link rejection |
| Focused gate | 17 tests / 107 expectations |
| Credential-free self-test | 4 cases / 12 invariants |
| Eight-suite container supply-chain gate | 91 tests / 775 expectations |
| Complete repository gate | PASS, exit 0 in 635.0 seconds; 21 existing Rust warnings |
| Live Cloudflare lifecycle evidence | **NOT COLLECTED** |
| Reviewed lifecycle permission inventory | **PENDING** |
| Final verifier v2 lifecycle consumption | **PENDING (P1)** |
| Complete B2 / S3 | **FALSE** |

The collector defaults to dry-run, reads only phase-specific environment
credentials after explicit confirmation, writes no files, and emits canonical
redacted receipts. It binds the raw target token ID to the lock predecessor's
provider-ID digest, requires all three lifecycle identities to differ, and
requires exact DELETE `200`, operator GET `404`, and independent-verifier GET
`404` with matching absence-code sequences.

This status does not supersede the production blockers. Token
self-verification does not prove permissions, the current final retention
verifier cannot consume the lifecycle chain, and no real bucket/token/object
operation occurred. B4-B7, R3 registry, C1 staging, P5, traffic, financial
authority, Go/VPS drain, and cutover remain blocked. Go/VPS stays authoritative
and production remains **NO-GO**.

## 2026-07-27 WORM Final Verifier V2 Foundation

| Status item | Current value |
| --- | --- |
| Protocol/trust/manifest/evidence/anchor contract | v2; v1 rejected |
| Authority model | 6 exact distinct roles with reviewed permission inventory required |
| Lock-operator lifecycle evidence | DELETE `200` + operator `404` + independent `404` required |
| Publisher lifecycle evidence | DELETE `200` + operator `404` + independent `404` required |
| Credential lifetime | Maximum 3600 seconds remaining |
| Focused verifier gate | 11 tests / 217 expectations |
| Staging policy-v2 integration gate | 16 tests / 110 expectations |
| Eight-suite supply-chain gate | 92 tests / 854 expectations |
| Complete repository gate | PASS, exit 0 in 611.2 seconds; 21 existing Rust warnings |
| Credential-free self-test | PASS; all remote/downstream facts false |
| Real permission inventories and live receipts | **NOT COLLECTED** |
| Complete B2 / S3 | **FALSE** |

The old four-role/single-2xx revocation evidence is no longer accepted.
Passing v2 requires both writer lifecycles, distinct receipt-file digests,
provider correlation and response hashes, strict phase ordering, and
operations/security signatures.

This is local contract readiness. No Cloudflare token, bucket, object,
registry, deployment, traffic, billing, or VPS mutation occurred. B4-B7,
R3/C1, P5, Go/VPS drain, and cutover remain blocked. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-27 WORM B5 Enforcement Collector Foundation

| Status item | Current value |
| --- | --- |
| B4/B3 predecessor and five-identity binding | PASS locally |
| Publisher create-only credential preflight | PASS with provider-shaped fixtures |
| Unconditional overwrite/delete raw-response binding | PASS with provider-shaped fixtures |
| Publisher DELETE `200` plus operator/independent `404` | PASS with provider-shaped fixtures |
| Failed-probe emergency DELETE plus independent `404` | PASS; permanently non-promotable |
| Post-probe object-verifier `If-Match` readback | PASS with provider-shaped fixtures |
| Sixth-identity final lock readback | PASS with provider-shaped fixtures |
| Stable canonical receipt-file boundary | PASS locally |
| Focused B5 gate | 18 tests / 91 expectations; self-test 7 cases / 22 invariants |
| Ten-suite container supply-chain gate | 122 tests / 1088 expectations |
| Complete repository gate | PASS, exit 0 in 629.4 seconds; 21 existing Rust warnings |
| Live Cloudflare B5 evidence | **NOT COLLECTED** |
| Reviewed real permission inventories | **PENDING** |
| Canonical v2 assembly and approval | **PENDING (B6/B7)** |
| Complete B2 / S3 | **FALSE** |

The five positive B5 phases and two emergency phases each read only one role's
environment credentials and emit canonical redacted receipts with every
downstream authority false. Raw SigV4
probe transport sends one request, forbids redirects/retries, bounds and
hashes the complete XML error response, correlates body/header request IDs,
and records both attempt and completion time. Publisher revocation starts
only after both enforcement responses complete; independent absence precedes
object readback; final lock readback uses a sixth provider identity.
If a probe is unsafe or ambiguous and cannot produce a positive predecessor,
the emergency operator/verifier pair starts from B3/B4 plus a retained
incident digest, revokes the publisher, and marks both receipts permanently
ineligible for positive evidence.

The pinned `412 PreconditionFailed` preflight proves publisher usability and
key existence only. The actual overwrite/delete policy requires exact
`403 AccessDenied`, but Cloudflare does not document a stable Bucket Lock
error tuple. A disposable-prefix calibration and operations/security review
are mandatory before live use; any tuple drift fails closed.

This is local collector readiness, not retention evidence. No credential,
Cloudflare request, token deletion, object mutation, registry action,
deployment, traffic, billing mutation, or VPS drain occurred. B6/B7 assembly,
real permission review, signatures, and clean-host replay remain open.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-28 Durable Object Jurisdiction Routing Foundation

| Status item | Current value |
| --- | --- |
| Allowed Controller targets | `default`, `eu`, `us`, `fedramp`, `fedramp-high` |
| Restricted namespace selection | Implemented before shard name and container-ID resolution |
| Object-side identity check | Implemented before local ledger initialization |
| Restricted activation gates | Exact two-gate policy; malformed/partial settings return typed 503 |
| Tracked local/staging/production target | `default`; both gates `false` |
| Deploy preflight | Rejects non-default target and any enabled/verified gate |
| Private status visibility | Validated target, restricted flag, and both gates |
| Focused policy gate | 9 tests / 57 expectations |
| Remote restricted object evidence | **NOT COLLECTED** |
| Cross-language jurisdiction provenance | v1 contract, default-only D1 ledger, and default-off runtime writer implemented locally |
| Production eligibility | **NO-GO** |

All Controller routes now use one selector for operation dispatch, status
v1-v4, terminal acknowledgment v1-v3, readiness, storage access,
provider-attempt journal, and provider egress. Restricted routes call
`RELAY_SHARDS.jurisdiction(...)` before deriving an object. A constructed
`RelayShardContainer` rejects a missing, unexpected, or different
`ctx.id.jurisdiction` before its SQLite ledger is initialized. The frozen
22-field activation campaign and D1 `0055` ABI cannot bind jurisdiction, so the
Controller rejects a restricted placement before any v1 campaign claim.

This closes a local wrong-namespace routing gap, not the data-residency gate.
`OperationShard`, D1 operation/activation evidence, and R2 object identity do
not yet persist jurisdiction. Shared D1/KV/R2 residency has no approved
restricted-placement contract, no destination-versioned relocation/drain
protocol exists, and no remote staging campaign has proved eviction, alarms,
Container lifecycle, rollback, or provenance in a restricted namespace.
Changing tracked deployment configuration therefore remains prohibited.
Go/VPS stays authoritative and production remains **NO-GO**.

## 2026-07-28 Shard Placement Attestation Foundation

| Status item | Current value |
| --- | --- |
| Cross-language contract | `ShardPlacementAttestationV1`; Rust/TypeScript shared fixture |
| Bound identity | Controller service/version, DO binding/class, jurisdiction, hashed name/object ID, v1 shard |
| Attestation ABI migration | `0061_relay_container_shard_placement_attestations.sql`; unchanged |
| Current D1 migration head | `0063_relay_container_shard_placement_mutation_authorizations.sql` |
| D1 schema totals | 63 migrations / 72 tables |
| Activation linkage | Exact 0054 activation plus 0055 campaign consumption |
| Immutability | One row per activation; replacement/update/delete rejected |
| Restricted jurisdiction write | Rejected until campaign v2 |
| Controller runtime writer | Implemented locally; exact two-gate policy; disabled in all tracked environments |
| Object/Controller identity cross-check | Implemented; actual `ctx.id` must equal independently selected stub identity |
| Completed-readiness replay | Implemented; object RPC must replay the matching DO journal before attesting |
| D1 writer readback | Implemented; exact 0061 attestation plus 0062 event append/readback, idempotent replay, conflict and malformed-readback rejection |
| Runtime staging permit verification | Implemented locally; Ed25519, candidate-bound, short-lived, and fail-closed |
| D1 authorization consumption | Implemented locally; atomic authorization-before-campaign batch and exact readback |
| Authority foundation | Implemented locally; private service-binding-only Worker, isolated D1, four approval roots, permit verification, append-only issuance/revocation, default-off |
| Deployment runner contract | Implemented locally and inert; staging / 8 shards / Controller-only / 13 deterministic mutations / one send / zero retry / disable-first |
| Authority-to-campaign execution claim | Exclusive claim/lease/receipt ledger implemented and locally exercised in dedicated Authority D1; application-D1 activation handshake still **NOT IMPLEMENTED** and ordinary deploy preflight requires both gates false |
| Focused authorization gate | Authority aggregate, Worker reader, existing permit/runtime, and runner plan tests pass |
| Controller/DO gates | 178 portable + 46 runtime + 53 DO tests |
| Complete repository gate | PASS, exit 0 in 1000.6 seconds; existing Rust `dead_code` warnings only |
| P5 placement reader/collector | Implemented locally; root-only event-sequence and 0063 readers plus capture-v4/collector-v6 pass focused Rust/JS verification |
| Placement read API | Root-only, D1-only, no-store bounded contract at `/api/platform/container/shards/placements` |
| Shard registry capture | v4 retains historical v3 core and requires a stable exact safe 25-column 0063 row before/after the same window |
| Remote placement evidence | **NOT COLLECTED** |
| Shared D1/KV/R2 residency evidence | **NOT COLLECTED** |
| Production eligibility | **NO-GO** |

This increment now closes the local default-jurisdiction write path, but it
does not claim where an object or shared store actually resides. Both writer
gates remain false and deploy preflight rejects enabling them. No remote
0061/0062/0063 schema or placement event/attestation pair has been read back.
Promotion still needs reader-first isolated staging migration, an exact
empty-schema receipt, atomic Authority execution claim/consumption and live
runner transport, an exact writer-version 8/8 campaign, stable bounded P5 readback including its consumed
0063 authorization, and independent review. Restricted relocation/drain
requires a separate campaign v2 and shared-store residency proof. Go/VPS
remains authoritative.

## 2026-07-28 Placement Readback And Registry v4 Contract

| Status item | Current value |
| --- | --- |
| Endpoint | `GET /api/platform/container/shards/placements` |
| Current migration head | `0063_relay_container_shard_placement_mutation_authorizations.sql`, count 63 |
| Ledger layering | Immutable 0061 attestation ABI plus immutable 0062 event sidecar |
| Authorization/cache | Root authentication before D1; `Cache-Control: no-store` on all outcomes |
| Runtime side effects | D1 read only; no namespace enumeration, stub lookup, DO RPC, service binding, Container wake, or mutation |
| Snapshot scope | Exact Controller version, ring generation, and campaign ID |
| Pagination | Frozen maximum database-assigned `placement_event_sequence` plus count; strictly increasing exclusive keyset cursor; maximum 64 rows/page |
| Activation relationship | `activation_id` only associates the attestation/event with 0054; never a placement watermark |
| Row verification | Exact 0061/0062 catalogs and join; canonical field, shard-name hash, and placement-attestation digest recomputation |
| Object identity exposure | Hash only; raw Durable Object ID forbidden |
| Authorization endpoint | Root-only, D1-only, no-store exact row at `/api/platform/container/shards/placement-mutation-authorizations?campaign_id=...` |
| Registry source | `cinatoken-relay-container-shard-registry-capture-v4`, collector version 6; historical v3 retained only as `registryCore` |
| Stability | Sealed campaign, safe 25-column 0063 row, 0054 activations, and 0062 event-backed 0061 placements identical before/after one 300-7200 second window |
| N/N join | One placement per shard, strictly matching its 0054 activation and 0055 receipt |
| Local schema verification | SQLite PASS at 63 migrations / 72 tables / 962 incremental columns / 105 key indexes |
| Writer gates | Both remain false; ordinary deploy preflight rejects true |
| Runtime placement authorization | Implemented locally; signed permit verification, atomic D1 consume, Controller pre-wake and placement-trigger enforcement |
| Authority/runner foundation | Implemented locally and inert; no public Authority route, credentials, network, claim, or mutation |
| Exclusive claim/workload routes | Private claim/read/receipt/renew/takeover routes implemented locally; Access gateway, application activation, and runner workload routes **NOT IMPLEMENTED** |
| Remote placement evidence | **NOT COLLECTED** |
| Exposed Cloudflare credential | Must be revoked and rotated before staging access |
| Complete repository gate | PASS, exit 0 in 1000.6 seconds |
| Production eligibility | **NO-GO** |

This table records the production acceptance contract and verified local
implementation, not deployed state. The increment does not apply 0061/0062/
0063 remotely and does not create a live v4 capture. A valid
capture must freeze one exact candidate by `placement_event_sequence` and
prove identical before/after canonical authorization, campaign, activation,
event, and attestation records. Every placement must match the same-shard 0054 activation
and 0055 receipt across activation ID, campaign, Controller/ring/shard
identity, claim, readiness, activation, and consumption digests. Missing,
duplicate, unknown, non-default, mismatched, or drifting rows are
`not-proven`.

The read route cannot authorize the write route. The two placement-writer
gates stay false until the Authority, runner, and separately reviewed staging
ceremony exist, and ordinary deployment remains unable to enable them. No
remote credential, schema, placement row, deployment, customer traffic, or
production authority is claimed. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-28 Placement Mutation Authorization v1

| Status item | Current value |
| --- | --- |
| Permit contract | `cinatoken-relay-shard-placement-mutation-authorization-v1` |
| Signature | Canonical Ed25519; Rust/JavaScript fixed-vector parity |
| Scope | Staging-only, fixed Controller service, exact candidate and campaign |
| Permit window | 60-600 seconds; 120-second future skew ceiling; at least 60 seconds remaining |
| Replay fences | Unique authorization, execution nonce, campaign nonce, subject, campaign, and campaign digest |
| D1 migration | 0063; append-preserved authorization table and campaign/placement guards |
| Campaign write | One batch: authorization, campaign, audit, campaign readback, authorization readback |
| Controller ordering | Authorization readback before claim, DO lookup, or Container wake |
| Production trust config | Absent |
| Tracked writer gates | False in every environment |
| Authority foundation | Implemented locally; verifies externally signed permit plus four fixed-order Ed25519 approvals; records safe append-only issuance/revocation evidence |
| Authority ingress | Service-binding-only; no public route, `workers.dev`, preview URL, or production config |
| Deployment runner contract | Implemented locally and inert; staging, 8 shards, Controller-only, 13 operation slots, one send, zero retry, readback-only ambiguity, disable-first |
| P5 authorization-row join | Implemented locally; capture v4 and Foundation source v4 bind stable exact 0063 safe projection |
| Authority execution claim/atomic consumption | Claim/lease/predecessor ledger implemented locally; atomic or fail-closed cross-D1 activation/consumption **NOT IMPLEMENTED** |
| Remote permit/schema/evidence | **NOT COLLECTED** |
| Complete repository gate | PASS, exit 0 in 1000.6 seconds |
| Production eligibility | **NO-GO** |

The implementation closes the local verification, Authority record, bounded
runner-plan, and P5 authorization-row substrate. It does not place signing
private keys in the Authority, connect Authority revocation to application D1,
join the cross-host claim to application D1, expose workload-authenticated
campaign routes, or permit an operator to enable staging gates manually. The next
critical path is one dedicated placement-control D1 or formally proven
cross-database activation protocol, an exact runner client, Access-protected
approval gateway plus private Service Binding, compiled runner trust and
credential typestates, and live reader-first staging evidence.

## 2026-07-28 Authority Execution Ledger Status

| Status item | Current value |
| --- | --- |
| D1 migration | Authority migration 0002; claims, 11-operation schedules, receipts, indexes, and projection triggers |
| Active ownership | One active staging scope; expiry alone never releases it |
| Lease | D1-owned 60 seconds; owner/token/generation fence; renewal and expired takeover |
| Receipt chain | Append-only, predecessor-bound, maximum 64 events; unique start/terminal per operation |
| Ambiguous in-flight takeover | Readback-only; no resend authority |
| Post-enable failure | `disable_required`; only operation 13 may start |
| Terminal success | Exact successful operation-13 terminal receipt |
| Local HTTP roles | Separate claim, receipt, and recovery HMAC roles, in addition to read/issue/revoke |
| Local runtime evidence | Concurrent create/exact replay, renewal, op3 start/terminal, revocation, op4 rejection, op13 admission |
| Migration evidence | Append preservation, projection enforcement, expiry-only takeover, generation fencing |
| Checked-in gates | Claim, receipt, and recovery writes all false |
| Public/production config | Absent |
| Application-D1 activation | **NOT IMPLEMENTED** |
| Rust Authority transport | **NOT IMPLEMENTED**; incompatible prototype rejected |
| Remote deployment/evidence | **NOT COLLECTED** |
| Production eligibility | **NO-GO** |

The implementation closes local execution ownership only. It does not close
the cross-database interval between application authorization/campaign state
and Authority execution state. Migration 0064 must add a prepared/activated
ticket and exact digest handshake, or the records must be consolidated into a
single control D1. Operation 3 remains unauthorized until both ledgers prove
the same active tuple.

Focused Authority verification passes type generation, Wrangler dry-run, 10
protocol tests, 3 Workerd lifecycle tests, and 8 migration/config tests. No
Cloudflare credential was read and no remote state was queried or changed.
The complete repository gate passes with exit code 0 in 929.3 seconds;
existing Rust `dead_code` findings remain warnings only.

## 2026-07-28 Two-Ledger Placement Execution Ticket Status

This table supersedes the current-value fields in the placement and Authority
tables above. Earlier tables remain as checkpoint history.

| Status item | Current value |
| --- | --- |
| Application D1 head | `0064_relay_container_shard_placement_execution_tickets.sql` |
| Application D1 catalog | 64 migrations / 75 tables / 1032 checked incremental columns / 109 key indexes |
| Application execution records | Immutable prepared ticket, application activation, and Authority acknowledgement mirror |
| Preparation atomicity | 0063 authorization consumption, ticket, campaign, audit, and exact readbacks in one D1 batch |
| Trusted identities | Application D1, Authority D1, and Authority ledger identities are deployment-owned, pairwise-distinct SHA-256 values |
| Canonical execution plan | 14 slots: disabled baseline, prepare, claim, activate, enable, 8 shard probes, disable |
| Authority schedule | Operations 4-14; operation 4 activation fence, operation 5 enable intent, operation 14 terminal disable |
| Authority pre-enable fence | Operation 5 rejected until successful operation-4 evidence projects the exact application activation digest |
| Application claim fence | Campaign claim rejected until exact activation and Authority acknowledgement rows exist |
| Controller ordering | Exact authorization/ticket/activation/acknowledgement readback before Durable Object lookup or wake |
| Exact lost-response recovery | Claim-create exact replay remains valid after later Authority ledger progress |
| Checked-in gates | All application and Authority writers remain false |
| Application activation writer | **NOT IMPLEMENTED** |
| Authority application-D1 readback workload | **NOT IMPLEMENTED** |
| Application acknowledgement writer | **NOT IMPLEMENTED** |
| Cross-D1 revocation closure | **NOT IMPLEMENTED** |
| Reserved terminal-disable receipt capacity | **NOT PROVEN** |
| Access and least-privilege workload identities | **NOT DEPLOYED** |
| Cross-runtime fixed vectors and fault campaigns | **INCOMPLETE** |
| Remote migration/deployment/evidence | **NOT COLLECTED** |
| Historical exposed credential revocation proof | **NOT COLLECTED** |
| Complete repository gate | PASS, exit 0 in 1043.0 seconds; Worker library 875/875; existing Rust `dead_code` warnings only |
| Production eligibility | **NO-GO** |

The checked-in protocol is a fail-closed local foundation, not distributed
atomicity. It cannot reach operation 5 because the three authenticated live
handshake writers/readers are deliberately absent. Before isolated staging,
the implementation must close those paths, repeat revocation and deadline
checks immediately before enable, reserve disable recovery capacity, use
separate rotated workload credentials behind Access and private Service
Bindings, pass deterministic cross-runtime vectors and adversarial fault
campaigns, and obtain independent remote readback evidence.

No remote state was queried or mutated, no credential was read, and no gate,
ticket, claim, activation, campaign, Container wake, customer traffic,
financial authority, Go/VPS drain, DNS, or production state changed. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-28 Application Activation Writer Status

This table supersedes the application-writer and Rust-transport fields in the
two-ledger status table above. Earlier tables remain checkpoint history.

| Status item | Current value |
| --- | --- |
| Application activation writer | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; root auth plus secure verification, staging-only, strict bounded request |
| Authority application client | Exact signed GET through private `SHARD_PLACEMENT_AUTHORITY`; three-second timeout, bounded strict no-store response, redirects denied |
| Cross-runtime authentication vector | Rust HMAC token accepted by the TypeScript Authority verifier |
| Trusted input boundary | Database/ledger identities, Authority version, receipt, schedule, credential identity, administrator identity, and timestamps are not caller supplied |
| Fresh activation fence | Exact pristine generation-1 claim at operation 4, one acquisition receipt, full operation 4-14 schedule, no in-flight or projected mutation, all deadlines live |
| Application time authority | D1 `unixepoch()` for prechecks; 0064 D1 triggers remain the final write authority |
| Write atomicity | Create-only activation, administrator audit, and exact readback in one D1 batch |
| Response-loss behavior | Exact stored replay only; no overwrite, regenerated request, or second logical activation |
| Enable authority of activation row | **ZERO**; Authority operation 4 must revalidate and conditionally consume its current claim |
| Local/staging gates | Authority read and activation write both checked in as `false` |
| Production binding and gates | **ABSENT** |
| Secret handling | HMAC value is a Worker secret; absent from variables and tracked files |
| Final runner workload identity | **NOT IMPLEMENTED**; current route is a root-operator bootstrap boundary |
| Authority operation-4 application readback/receipt | **NOT IMPLEMENTED** |
| Application acknowledgement writer | **NOT IMPLEMENTED** |
| Immediate pre-operation-5 revocation closure | **NOT IMPLEMENTED** |
| Reserved disable capacity and fault evidence | **NOT PROVEN** |
| Remote migration/deployment/evidence | **NOT COLLECTED** |
| Complete local repository gate | PASS, exit 0 in 935.6 seconds; Worker library 886/886; Worker Wasm check passed |
| Production eligibility | **NO-GO** |

The activation writer closes one local state transition, not the distributed
transaction. Operation 5 remains unreachable until Authority operation 4
reads the exact application row, appends and exposes its terminal receipt,
application D1 mirrors the exact acknowledgement, and revocation is rechecked
at the last pre-enable boundary. Least-privilege workload identities,
credential rotation, Access policy, disable-capacity proof, adversarial
faults, and independent remote readback are still mandatory.

No remote state or credential was accessed and no gate was enabled. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-29 Application Pre-Enable Grant Status

This table supersedes the current Application D1 and operation-5
pre-dispatch fields above. Earlier tables remain checkpoint history.

| Status item | Current value |
| --- | --- |
| Application D1 head | `0065_relay_container_shard_placement_pre_enable_grants.sql` |
| Application D1 catalog | 65 migrations / 76 tables / 1056 checked incremental columns / 110 key indexes |
| Application pre-enable grant | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; create-only, immutable, exact replay |
| Application final write authority | D1 `unixepoch()`, seal absence, ticket/activation/ACK tuple, all application deadlines |
| Authority grant route | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; exact prepared outbox, Application grant, second Authority fence |
| Authority grant receipt | Immutable, append-preserved, claim/outbox/ledger/Controller bound |
| Inbound Authority identity | Independent `grant` HMAC role with current/previous overlap |
| Outbound Application identity | Independent `pre_enable_grant` HMAC role, POST/path/body bound |
| Cross-role isolation | Activation read, ACK read, Application grant, and all Authority roles reject key/credential/secret reuse |
| Exact response loss | Same deterministic Application request can return exact replay; divergent identities fail closed |
| Controller dispatch claim | **NOT IMPLEMENTED** |
| Controller Service Binding/send | **NOT IMPLEMENTED** |
| Controller status-only ambiguity recovery | **NOT IMPLEMENTED** |
| Operation-5 terminal and operations 6-14 | **NOT IMPLEMENTED** |
| Checked-in local/staging gates | All grant and receipt gates `false` |
| Production Authority/grant config | **ABSENT** |
| Remote migration/deployment/fault evidence | **NOT COLLECTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

## 2026-07-31 Root Session Phase-Proof Status

This table supersedes only older rows that describe the phase proof or exact
session-generation mechanism as absent.

| Item | Current status |
|---|---|
| Session revocation authority | **EXACT MONOTONIC D1 GENERATION; COOKIE EQUALITY REQUIRED** |
| Revoking account mutations | **PASSWORD CHANGE/RESET, ROLE, DISABLE, DELETE ATOMIC WITH GENERATION INCREMENT** |
| Per-session identity | **32 RANDOM BYTES ON EVERY ISSUE; CANONICAL BASE64URL `sid`** |
| Legacy Rust Cookie policy | **FAIL CLOSED; FORCED REAUTHENTICATION** |
| Role authority | **ENUM `0/1/10/100`; ROOT IS EXACTLY `100`** |
| Migration 0075 | **LOCAL VERIFIED; ROLE/GENERATION AND BOTH FINAL ROOT WRITE GUARDS** |
| Migration 0076 exact-generation schema | **LOCAL VERIFIED; 0074 BYTE-STABLE, EFFECTIVE TABLE/TRIGGER REBUILT, POST-DROP ROLLBACK AND `5/0` PASS** |
| RootSessionPhaseProofV1 | **IMPLEMENTED; CANONICAL HMAC, 10-SECOND DEFAULT/15-SECOND MAXIMUM** |
| Cross-language vector | **RUST + INDEPENDENT BUN/WEBCRYPTO PASS** |
| Coordinator consumption | **OPAQUE VERIFIED TYPE; ROUTE-FREE PURE VALIDATION** |
| Phase chain | **CHALLENGE -> ISSUER -> COMMIT PARENT DIGESTS VERIFIED** |
| Typed phase subjects | **BLOCKED; CANONICAL SUBJECT STRUCTS NOT FROZEN AND COMMIT BINDING NOT DERIVED FROM VERIFIED PERMIT** |
| Application issuance route | **ABSENT** |
| Private Service Binding / named entrypoint | **ABSENT** |
| Persistent replay/recovery DO | **ABSENT** |
| Staging proof-key lifecycle | **NOT PROVISIONED OR REHEARSED** |
| Remote 0075/0076 / exact `5/0` evidence | **NOT COLLECTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The grant is the final Application-owned pre-enable decision, but it is not a
send token. A later seal, revocation, expiry, fence drift, or version drift
must prevent future dispatch even though the immutable grant remains as audit
evidence. The next production-critical boundary is a one-owner Authority
dispatch claim followed by exactly one Controller call and status-only
ambiguity recovery. No retry path may issue a second enable mutation.

No credential or remote state was accessed and no remote migration, gate,
deployment, Container, customer traffic, billing, Go/VPS, DNS, or production
state was changed. Production remains **NO-GO**.

## 2026-07-29 Operation-5 Immutable Dispatch Claim Status

This table supersedes the dispatch-claim row in the Application pre-enable
grant status above. Earlier tables remain checkpoint history.

| Status item | Current value |
| --- | --- |
| Application D1 catalog | Unchanged: 65 migrations / 76 tables / 1056 checked incremental columns / 110 key indexes |
| Authority migration inventory | Unchanged: 2 files (`0001-0002`); claim schema appended to 0002 |
| Authority dispatch claim | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; create-only, immutable, single-owner, exact replay |
| Dispatch-claim fence | Exact grant receipt, prepared outbox, operation-5 start, live generation-1 lease/deadlines, unrevoked ledger head, versions, and Controller identities |
| Application grant receipt meaning | Historical evidence only; **NOT LIVE SEND AUTHORITY** |
| Inbound claim identity | Independent `send` HMAC role with current/previous isolation |
| Grant-role parser | Exact-role acceptance defect fixed; focused `grant` and `send` coverage added |
| Send attempt | **NOT CREATED**; `sendAttemptCreated=false` |
| Controller request | **NOT SENT**; `controllerRequestSent=false` |
| Existing Controller deployment-enable route | **ABSENT** |
| Existing Controller deployment control-plane client | **ABSENT** |
| `/operations/status` as deployment status | **INVALID**; business-operation status only |
| Application-owned dispatch consumption | **NOT IMPLEMENTED**; next P0 seal-ordering boundary |
| Atomic attempt plus event | **NOT IMPLEMENTED** |
| Dedicated `controller-deployment-gateway` | **NOT IMPLEMENTED**; future sole holder of minimum Cloudflare deployment credential |
| Authority Cloudflare deployment credential | **ABSENT BY DESIGN** |
| Checked-in gates | All related gates `false` |
| Production placement configuration | **ABSENT** |
| Remote mutation/evidence | **NOT PERFORMED / NOT COLLECTED** |
| Complete local repository gate | PASS; `bun run check`, exit 0 in 703.8 seconds |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The next P0 order is Application-owned create-only dispatch consumption
against seal, then one atomic persist-before-I/O attempt and event, then the
independent deployment gateway, and finally status-only ambiguity recovery
with zero resend. No secret was used and no remote state was queried or
changed. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-29 Operation-5 Dispatch Consumption Status

This table supersedes the dispatch-consumption and Authority-receipt rows in
the operation-5 dispatch-claim status above. Earlier tables remain checkpoint
history.

| Status item | Current value |
| --- | --- |
| Application D1 head | `0066_relay_container_shard_placement_dispatch_consumptions.sql` |
| Application D1 catalog | 66 migrations / 77 tables / 1096 checked incremental columns / 111 key indexes |
| Authority migration inventory | 3 files (`0001-0003`) |
| Application dispatch consumption | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; create-only, immutable, append-preserved, exact replay |
| Seal/consumption ordering | Linearized by Application D1 commit visibility |
| Seal commits first | New consumption is rejected |
| Consumption commits first | Later seal remains valid but cannot erase or retroactively undo historical consumption |
| Exact historical replay | Returns the stored row only; does not restore, extend, or create new authorization |
| Authority consumption receipt | **IMPLEMENTED LOCALLY, DEFAULT-OFF**; immutable exact Application response evidence in migration 0003 |
| New-consumption time budget | Authority requires at least 30 seconds remaining on lease, normal deadline, and permit deadline before the Application call |
| Authority-to-Application credentials | Isolated current/previous sets; previous only after current receives a no-write `409` for the same deterministic exact replay |
| Previous credential retention | Required until the corresponding cross-D1 orphan window is proven empty |
| Cross-D1 atomicity | **NOT AVAILABLE** |
| Cross-D1 orphan interval | **REMAINS**; Application may be consumed while Authority receipt is absent |
| Recoverable orphan | Exact POST replay only while the Authority fence is live, the same/previous credential remains, write gates are open, and inbound HMAC/runtime trust pass |
| Unrecoverable orphan | Revoked/expired fence, closed write gate, or retired required previous credential remains permanently fail-closed under the current protocol |
| Independent historical Application readback | **NOT IMPLEMENTED**; next P0 blocker before attempt/event |
| Historical Authority receipt admission | **NOT IMPLEMENTED**; next P0 blocker before attempt/event |
| Authority receipt HTTP replay | Conditional on Authority enabled, write gates, inbound HMAC, and runtime trust; **NOT AN UNCONDITIONAL READ API** |
| Send attempt | **NOT CREATED**; `sendAttemptCreated=false` |
| Controller request | **NOT SENT**; `controllerRequestSent=false` |
| Controller/deployment gateway/control-plane I/O | **NONE** |
| Existing Controller `/operations/status` | Business-operation status only; **NOT DEPLOYMENT STATUS** |
| Atomic Authority attempt plus event | **NOT IMPLEMENTED**; blocked behind historical readback/receipt admission |
| Dedicated `controller-deployment-gateway` | **NOT IMPLEMENTED**; follows atomic attempt/event |
| Status-only ambiguity recovery | **NOT IMPLEMENTED** |
| Checked-in local/staging gates | All related gates `false` |
| Production placement configuration | **ABSENT** |
| Remote mutation/evidence | **NOT PERFORMED / NOT COLLECTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The next P0 must first add an independent historical Application readback
route and historical Authority receipt admission that can append only the
exact missing receipt without reviving send authority. Until then, an orphan
outside the live-fence, open-gate, retained-credential window is permanently
fail-closed and must never create an attempt or send Controller.

After that blocker, one Authority transaction must atomically persist an
immutable send attempt and its `send_started` event before any external I/O.
Only exact readback of that transaction may permit a later call to the
independent deployment gateway. That gateway must own the minimum Cloudflare
deployment credential and expose status-only recovery; Authority must remain
credential-free, and no ambiguous outcome may trigger a second enable.

Focused Application 0066 and Authority 0003 contract evidence has passed.
This status does not claim a new full repository gate or remote deployment
result. No secret was read and no remote state, migration, gate, Controller,
Container, customer traffic, billing, DNS, or Go/VPS state was changed.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-29 Historical Recovery And Send Attempt Status

| Item | Current status |
|---|---|
| Application historical dispatch-consumption readback | **LOCALLY IMPLEMENTED AND VERIFIED** |
| Historical retention | **30 DAYS, APPLICATION D1 TIME** |
| Authority recovery evidence + exact receipt | **ATOMIC D1 BATCH, LOCALLY VERIFIED** |
| Recovered receipt grants send authority | **FORBIDDEN** |
| Authority send attempt + `send_started` event | **ATOMIC D1 BATCH, LOCALLY VERIFIED** |
| Controller/gateway request sent | **NO** |
| Deployment credential in Authority | **ABSENT** |
| Authority migration inventory | **0001-0005** |
| Checked-in local/staging gates | **ALL FALSE** |
| Production placement configuration | **ABSENT** |
| Remote evidence or mutation | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The former orphan-receipt blocker is closed locally: retained immutable
Application consumption can reconstruct only its exact Authority receipt.
That recovery is permanently non-live and cannot create a send attempt.

The send-attempt boundary is also closed locally. One Authority transaction
persists the unique attempt and initial event before any future external I/O.
`send_started` explicitly means the authority was persisted and network I/O
may not have occurred. No Controller or Cloudflare mutation has been added.

The next P0 is the independent private deployment gateway with minimum
credential scope, create-once idempotency, durable status, and status-only
ambiguity recovery. Promotion remains blocked on that gateway, remote D1
schema/trigger evidence, remote fault campaigns, identity and credential
rotation evidence, operation-14 disable, operations 6-13, reverse sync, drain,
traffic, DNS, security, SRE, and migration approvals.

The full repository `bun run check` passed with exit code 0. Focused evidence
also passed: Worker Rust 911, wasm check, scheduler/config 29, Application
Workerd 54, Authority unit 55, two Authority Workerd suites of 6 each, and
root Authority tests 28. Application inventory remains 66 migrations / 77
tables / 1096 checked incremental columns / 111 key indexes. No secret or
remote state was accessed. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-29 Controller Deployment Gateway Foundation Status

| Item | Current status |
|---|---|
| Independent gateway Worker | **LOCALLY IMPLEMENTED** |
| Public ingress | **ABSENT** |
| Gateway D1 migration | **0001, FOUR IMMUTABLE EVIDENCE TABLES** |
| Create-once reservation | **ATOMIC OPERATION + DISPATCH BATCH** |
| Replay mutation | **FORBIDDEN; STATUS-ONLY** |
| Cloudflare mutation retry | **ABSENT** |
| Status readback | **GET DEPLOYMENTS + TARGET VERSION ONLY** |
| Stable target | **TWO CONSECUTIVE TARGET OBSERVATIONS, >=5 SECONDS** |
| Create/status HMAC roles | **SEPARATE CURRENT/PREVIOUS SETS** |
| Deploy/read tokens | **GATEWAY-ONLY FUTURE SECRETS, NOT TRACKED** |
| Local/staging gates | **ALL FALSE** |
| Production gateway config | **ABSENT** |
| Authority Service Binding/client | **NOT IMPLEMENTED** |
| Authority migration 0006 events | **NOT IMPLEMENTED** |
| Real Cloudflare/D1 evidence | **NOT COLLECTED** |
| Operation-5 terminal closure | **NOT IMPLEMENTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The gateway foundation passes its complete focused local gate. Workerd uses a
synthetic outbound Cloudflare service and proves concurrent create
linearization and zero replay mutation. No real deployment or remote read is
claimed.

The next P0 is Authority integration plus append-only gateway outcome/status
events. Only the definite first attempt creation may submit; Authority replay
must never call the create endpoint. Remote fault evidence, Controller status
schema compatibility, operations 6-14, reverse sync, drain, traffic, DNS, and
approvals remain blockers. Production remains **NO-GO**.

## 2026-07-29 Authority To Gateway Integration Status

| Item | Current status |
|---|---|
| Authority migration inventory | **0001-0006** |
| Authority-to-Gateway Service Binding | **LOCALLY IMPLEMENTED, PRIVATE** |
| Create/status HMAC clients | **IMPLEMENTED, ROLE-ISOLATED, NO RETRY** |
| Send attempt + `send_started` + create dispatch | **ONE ATOMIC D1 BATCH** |
| Authority exact replay create call | **ZERO** |
| Gateway result evidence | **ACCEPTED / REJECTED / AMBIGUOUS APPEND-ONLY** |
| Authority status recovery route | **IMPLEMENTED, STATUS-ONLY** |
| Stable target evidence | **TWO CONSECUTIVE MATCHING AUTHORITY OBSERVATIONS** |
| Controller status/Rust strict parser | **EXACT GOLDEN CONTRACT PASSED** |
| Checked-in local/staging gates | **ALL FALSE** |
| Gateway or Cloudflare secret in Authority | **ABSENT** |
| Production placement config | **ABSENT** |
| Remote Cloudflare/D1 evidence | **NOT COLLECTED** |
| Operation-5 terminal closure | **NOT IMPLEMENTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

Authority now persists the unique create authority before private Service
Binding I/O. A definite fresh triple may make one Gateway create call. Every
replay and every post-call persistence failure remains create-free.

The recovery-role route reconstructs the command from immutable D1 state and
uses only Gateway status. Dispatch-only crash state is normalized to an
ambiguous create result before readback. Status observations are predecessor
bound, and the same target digest may be recorded twice to prove stability.

Focused Authority, Gateway, Controller, Workerd, migration/config, and Rust
checks pass. All outbound provider behavior was synthetic. No gate, remote
migration, secret, deployment, DNS, traffic, billing, Container, or Go/VPS
state changed.

The next local P0 is an operation-5 terminal receipt that atomically binds the
stable Gateway event to the execution claim and advances the operation
ordinal. Remote schema readback, token scope, credential rotation, fault
campaigns, operations 6-14, reverse sync, drain, cutover, and approvals remain
blockers. Production remains **NO-GO**.

## 2026-07-29 Operation-5 Terminal Closure Status

| Item | Current status |
|---|---|
| Authority migration inventory | **0001-0007** |
| Stable deployment-state digest | **IMPLEMENTED; CROSS-REQUEST** |
| Stable-state change rejection | **CLASSIFICATION / HTTP / SET / TARGET** |
| Dedicated terminal route | **IMPLEMENTED, RECEIPT HMAC** |
| Terminal write gate | **DEFAULT FALSE** |
| Gateway/Controller/Cloudflare call from terminal route | **NONE** |
| Terminal sidecar + generic receipt + claim advance | **ONE D1 STATEMENT** |
| Execution ledger after success | **SEQUENCE 5 / ORDINAL 5** |
| Next operation | **ORDINAL 6, SHARD-0 READINESS** |
| Exact replay | **ZERO WRITE, ZERO GATEWAY CALL** |
| Gateway chain after terminal | **SEALED** |
| Version drift | **FAIL CLOSED** |
| Controller ID vs target response SHA | **SEPARATE EVIDENCE** |
| Remote Cloudflare/D1 evidence | **NOT COLLECTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

Migration 0007 atomically inserts the operation-5 terminal sidecar, projects
the generic sequence-5 execution receipt through retained migration-0002
logic, advances the claim to `last_completed_ordinal=5`, and clears inflight.
Any source, projection, receipt, or claim mismatch rolls back the statement.

The Gateway status digest defect is also closed locally. Per-request event
identity remains private to the Gateway repository, while public
`observationDigestSha256` now binds deployment state and can match across
different status requests. Workerd verifies two distinct requests can become
stable after the configured interval.

The next local P0 is operation 6 readiness execution and its terminal receipt,
followed by operations 7-13 and independent operation-14 disable/recovery.
Remote schema and trigger readback, least-privilege credentials, rotation,
fault campaigns, mutation-count evidence, reverse sync, drain, cutover, and
approvals remain blockers. Production remains **NO-GO**.

## 2026-07-29 Accepted-Work Drain 0067 Status

| Item | Current status |
|---|---|
| Application D1 head | **0067_relay_container_drain_expand.sql** |
| Application D1 inventory | **67 MIGRATIONS / 85 TABLES / 1310 CHECKED COLUMNS / 126 KEY INDEXES** |
| Global drain persistence | **EIGHT SCOPE-BOUND EVIDENCE FAMILIES, LOCALLY VERIFIED** |
| Campaign before 0068 enforcement | **DATABASE-REJECTED** |
| Active campaign cardinality | **ONE PER ENVIRONMENT/SCOPE; RECOVERY ADVANCES EXACTLY ONE GENERATION** |
| Accepted-set structural seal | **CAMPAIGN-FROZEN COUNT/DECLARED MANIFEST/FIRST/LAST KEY + NULL-SAFE SEALS** |
| Authoritative source/member recomputation | **NOT IMPLEMENTED; 0068 BLOCKER** |
| Accepted-set page/member ordering | **STRICT KEYSET + CONTIGUOUS ORDINALS** |
| Member closure | **ONE IMMUTABLE OBSERVATION PER OPERATION GENERATION, BOUND TO FROZEN TERMINAL/ACK** |
| Ambiguous provider replay | **PROVIDER/RUST/GO REPLAY ALL FORCED FALSE** |
| Billing hold | **CANNOT COEXIST WITH ZERO BILLING-OPEN OBSERVATION** |
| Billing snapshot/vector replay | **NOT IMPLEMENTED; EXISTING SINGLE EXPRESSION TRUTH REMAINS AUTHORITATIVE** |
| Drain seal | **LATEST TWO CONSECUTIVE STABLE GENERATIONS + EXACT/STABLE SHARD SNAPSHOTS + ZERO OPEN/UNKNOWN** |
| Reverse/shard freshness | **FROZEN REVERSE EXPORT + LATEST GENERATION + 0061 PLACEMENT + EXACT WATERMARKS** |
| Operation 14 before drain | **DATABASE-REJECTED** |
| Traffic-return result | **STABLE MANIFEST-BOUND ELIGIBILITY ONLY; AUTHORIZATION FORCED FALSE** |
| Rust 0067 write repository/route | **ABSENT** |
| Tracked 0067 write gates | **FIVE, ALL FALSE IN LOCAL/STAGING/PRODUCTION** |
| Remote 0067 application/readback | **NOT PERFORMED** |
| 0068 admission enforcement | **NOT IMPLEMENTED** |
| 0069 typed approval/WORM evidence enforcement | **NOT IMPLEMENTED; RECEIPTS DATABASE-BLOCKED UNTIL PRESENT** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The 0067 migration is an expand-only compatibility boundary. Rust exposes an
exact schema/object readiness probe and a validated read-only campaign lookup,
but no mutation method. Even accidental gate activation cannot create a
campaign before the 0068 migration marker exists.

The local verifier executes the complete ledger lifecycle and its critical
negative paths. This is not remote evidence and does not prove old-Writer
absence, admission fencing, provider/billing/Queue/R2 convergence, reverse
sync against Go, deployed stable intervals, or traffic safety.

The next production boundary is the 0068 design and writer inventory:
enumerate every admission path, deploy compatible 0067 readers with gates
false, prove stale/current Worker races in isolated staging, retain
Time-Travel/export evidence, and only then add database-enforced admission
generation matching. No credential or remote Cloudflare state was accessed.
After 0068, 0069 must enforce typed campaign evidence, validity, retention,
and reviewer independence before any receipt writer is considered. Production
remains **NO-GO**.

## 2026-07-30 0068 Status Update

This table supersedes the preceding 0067 current-state rows.

| Item | Current status |
|---|---|
| Application D1 head | **0068_relay_container_drain_admission_enforce.sql** |
| Application D1 inventory | **68 MIGRATIONS / 88 TABLES / 1365 CHECKED COLUMNS / 129 KEY INDEXES** |
| Historical 0050 accepted sequence | **DETERMINISTICALLY BACKFILLED AND APPEND-PRESERVED** |
| New Container operation admission | **CURRENT OPEN FENCE COMMIT REQUIRED FOR ALL OPERATION KINDS/PROTOCOLS** |
| Atomic financial admission | **COMMIT + 0050 RECEIPT + ALIASES + RESERVATION + DEBITS + OPERATION IN ONE D1 BATCH** |
| Replay/settlement integrity | **SCHEMA-AWARE PRE-0068 READ; POST-0068 COMMIT REQUIRED AND CURRENT DIGEST RECOMPUTED** |
| Fence close | **EXACT CURRENT HEAD + D1-DERIVED HIGH WATERMARK/COUNT/FIRST/LAST; UNCOMMITTED OPEN OPERATION REJECTED** |
| Campaign close transaction | **FENCE CLOSE AND 0067 CAMPAIGN MUST SHARE ONE SQLITE COMMAND TIME; CROSS-SECOND TWO-STATEMENT CLOSE REJECTED** |
| Recovery generation | **REOPEN PROHIBITED UNDER 0068; FUTURE SEPARATE MIGRATION/APPROVAL REQUIRED** |
| Environment isolation | **ONE ADMISSION ENVIRONMENT PER APPLICATION D1; SEPARATE D1 STILL REQUIRED** |
| Fence lifecycle repository/route | **ABSENT; APPLIED SCHEMA REMAINS DEFAULT-CLOSED** |
| Historical backfill scale | **ONE-SHOT WINDOW BACKFILL; REMOTE CARDINALITY/DURATION PROOF ABSENT** |
| Source bookmark/manifest recomputation | **NOT IMPLEMENTED; VALUES ARE CALLER-ATTESTED** |
| P5 admission-fence evidence type | **MANIFEST V3 + EVIDENCE V2 + OFFLINE ASSEMBLER IMPLEMENTED; AUTHENTICATED REMOTE CAPTURE ABSENT** |
| 0067 evidence writers | **ABSENT; FIVE TRACKED GATES REMAIN FALSE** |
| Remote 0068 application/readback | **NOT PERFORMED** |
| 0069 typed approval/WORM evidence | **NOT IMPLEMENTED** |
| Traffic-return authorization | **NOT COMPILED; DATABASE RECEIPT REMAINS NON-AUTHORIZING** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The next code boundary is an authenticated and audited initial-open/close
control plane plus independently recomputed accepted-set source/page/complete
manifests. It must create fence+head atomically and close fence+campaign through
one SQLite command step, retain readback evidence,
preflight/rehearse the historical backfill, and remain disabled in every
tracked environment until isolated-staging fault campaigns pass. It must not
add an admission-reopen command.

The local P5 gate now has eleven evidence kinds and 66 focused tests. The
offline admission-fence assembler reads no credential, performs no network
request, writes no file, and only emits canonical evidence-v2 to standard
output. Its digest-only supporting projections are not source completeness
proof and do not change the production **NO-GO** verdict.

## 2026-07-30 0069 Status Update

This table supersedes the preceding 0068 current-head rows.

| Item | Current status |
|---|---|
| Application D1 head | **0069_relay_container_traffic_return_evidence_enforce.sql** |
| Application D1 inventory | **69 MIGRATIONS / 91 TABLES / 1424 CHECKED COLUMNS / 133 KEY INDEXES** |
| Typed evidence subject | **EXACT CAMPAIGN/FENCE/ACCEPTED-SET/OBSERVATION/REVERSE-SYNC/BILLING/OP14 BINDING** |
| Required evidence set | **EIGHT FIXED TYPES WITH FIXED ISSUER ROLES** |
| Issuer/key separation | **DISTINCT PER SUBJECT; ASSEMBLER AND SEALER CONFLICTS REJECTED** |
| Validity and retention | **D1-TIME WINDOW + SUBJECT RETENTION FLOOR + WORM/POLICY MATCH** |
| Evidence seal | **EXACTLY EIGHT VALID RETAINED ITEMS; APPEND-PRESERVED** |
| Receipt reviewer | **INDEPENDENT FROM ASSEMBLER, SEALER, AND EVERY ISSUER** |
| Marker-only or arbitrary-hash receipt | **DATABASE-REJECTED** |
| Traffic-return authorization | **FORCED FALSE** |
| 0069 evidence writer/route | **ABSENT; DEFAULT-INERT** |
| One-SQL-step 0068 close + 0067 campaign command | **ABSENT; ASSIGNED TO LATER MIGRATION** |
| Remote 0068/0069 application/readback | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

Current P5 schema identity advances to 0069, but immutable admission-fence
evidence remains pinned to 0068 and its reviewed SQL digest. The next code
boundary is the one-step close/campaign command plus authenticated, audited
writers and independent signature/policy verification, not gate activation.

## 2026-07-30 0070 Status Update

This table supersedes only the preceding 0069 current-head and missing-close
rows; the 0069 evidence checkpoint remains historical evidence.

| Item | Current status |
|---|---|
| Application D1 head | **0070_relay_container_drain_close_command.sql** |
| Application D1 inventory | **70 MIGRATIONS / 92 TABLES / 1463 CHECKED INCREMENTAL COLUMNS / 137 KEY INDEXES** |
| Close primitive | **ONE APPEND-PRESERVED COMMAND INSERT** |
| Fence close + campaign creation | **ONE D1 TRIGGERED SQLITE STATEMENT, SAME D1 TIME** |
| Stale head/accepted boundary | **DATABASE-REJECTED** |
| Standalone fence/campaign write | **DATABASE-REJECTED AFTER 0070** |
| Downstream campaign failure | **COMMAND AND FENCE ROLLED BACK, SQLITE-VERIFIED** |
| Nonempty accepted set | **REAL WORKERD D1 VERIFIED; LATE ADMISSION LEAVES NO PARTIAL STATE** |
| Rust repository mutation | **DEFAULT-INERT; ADMIN AUDIT PREPARED STATEMENT + BATCHED EXACT READBACK REQUIRED** |
| Route / credential / runtime write gate | **ABSENT** |
| 0068 admission provenance | **UNCHANGED; SHA-256 fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50** |
| Accepted source proof | **BOOKMARK/MANIFEST/SCHEMA/READBACK CALLER-ATTESTED; INDEPENDENT RECOMPUTATION OPEN** |
| Billing-expression semantics | **UNCHANGED** |
| Remote D1/Cloudflare operation | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

0070 closes the local SQLite atomicity gap identified by 0068 and 0069. It
does not close the authorization or source-completeness gaps. An independently
authenticated control-plane caller, exact admin audit construction, remote
schema/trigger readback, response-loss and N/N-1 campaigns, source
recomputation, full drain evidence, and independent traffic-return review
remain required before production consideration.

## 2026-07-30 0071 Status Update

This table supersedes only the 0070 current-head and caller-attested
accepted-source rows.

| Item | Current status |
|---|---|
| Application D1 head | **0071_relay_container_drain_accepted_set_source_seal.sql** |
| Application D1 inventory | **71 MIGRATIONS / 97 TABLES / 1550 CHECKED INCREMENTAL COLUMNS / 144 KEY INDEXES** |
| Source scan | **EXACT CURRENT OPEN 0068 FENCE/HEAD + D1-DERIVED HIGH WATERMARK/COUNT/FIRST/LAST** |
| Source members | **CONTIGUOUS KEYSET COPY OF EVERY IMMUTABLE ADMISSION COMMIT** |
| Source pages | **DETERMINISTIC MEMBER/PAGE ORDINALS + PREVIOUS-DIGEST CHAIN** |
| Source shards | **ALL INDICES REQUIRED IN ORDER, INCLUDING ZERO-MEMBER SHARDS** |
| Source seal | **COMPLETE MEMBER/PAGE/SHARD SET + DISTINCT ASSEMBLER/VERIFIER IDENTITIES** |
| Close TOCTOU | **EXACT SEAL VALUES + FINAL SOURCE MAX/COUNT RECHECK** |
| Late admission | **BEFORE-SEAL AND AFTER-SEAL/BEFORE-CLOSE RACES DATABASE-REJECTED** |
| Canonical digest primitives | **LOCAL RUST CONTRACT; INDEPENDENT WRITER/VERIFIER EXECUTION NOT YET DEPLOYED** |
| D1 Session collector | **NOT IMPLEMENTED OR REMOTELY VERIFIED** |
| Signature / authorization receipt | **NOT IMPLEMENTED; DIGEST STRINGS ALONE ARE NOT TRUST PROOF** |
| Route / credential / runtime write gate | **ABSENT** |
| 0068 admission provenance | **UNCHANGED; SHA-256 fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50** |
| Billing-expression semantics | **UNCHANGED** |
| Remote D1/Cloudflare operation | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The next code boundary is not gate activation. It is an authenticated,
replay-protected root-Worker collector/verifier protocol using D1 Sessions,
typed machine authorization plus append-preserved audit receipt, real
signature verification, bounded pagination, stable response-loss readback,
and isolated-staging N/N-1 and late-admission campaigns.

## 2026-07-30 0072 Status Update

This table supersedes only the 0071 current-head and unsigned-source-authority
rows. The 0071 source-seal checkpoint remains historical evidence.

| Item | Current status |
|---|---|
| Application D1 head | **0072_relay_container_drain_source_authorization.sql** |
| Application D1 inventory | **72 MIGRATIONS / 99 TABLES / 1611 CHECKED INCREMENTAL COLUMNS / 148 KEY INDEXES** |
| Migration preflight | **ALL FIVE 0071 SOURCE TABLES MUST BE EMPTY; WRITER STOP REMAINS AN OPERATIONAL PROOF** |
| Authorization binding | **EXACT FENCE/HEAD/SCAN/COLLECTOR/RUN/CREDENTIAL/PAGE/SHARD/SCHEMA/NONCE/TIME** |
| Cryptographic verifier | **THREE DISTINCT DEPLOYMENT-PINNED ED25519 SPKI ROLES; FAIL-CLOSED LOCAL RUST** |
| Attestation order | **ASSEMBLER THEN VERIFIER OVER ONE EXACT SNAPSHOT; ROLE/IDENTITY/SPKI/ENVELOPE REUSE REJECTED** |
| D1 Session readback | **ONE FIRST-PRIMARY SESSION; RAW BOOKMARK NEVER EXPOSED; REAL WORKERD VERIFIED** |
| D1 Session semantics | **SEQUENTIAL CONSISTENCY ONLY; NOT A FROZEN SNAPSHOT** |
| Authorization issuer / RootAuth second factor | **NOT IMPLEMENTED** |
| One-time claim / terminal receipt | **NOT IMPLEMENTED** |
| Source collector / Session batch | **NOT IMPLEMENTED** |
| Immutable R2 offline evidence | **NOT IMPLEMENTED** |
| Route / credential / runtime write gate | **ABSENT** |
| Close / traffic-return / reopen authority | **ABSENT** |
| Billing-expression semantics | **UNCHANGED** |
| Remote D1/Cloudflare operation | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

The next code boundary is M1/M2 authorization consumption and the authoritative
collector, not gate activation. It requires RootAuth plus fresh second-factor
issuance, an atomic single-winner claim and admin audit, exactly one durable
terminal receipt, bounded keyset collection with phase rereads, independent
assembler/verifier execution, create-only locked R2 evidence, ambiguous-write
classification without retry, and remote isolated-staging resource/fault/
rollback proof.

## 2026-07-30 0073 Status Update

This table supersedes only the 0072 current-head and missing consumption-schema
rows. The 0072 authorization and attestation checkpoint remains historical
evidence.

| Item | Current status |
|---|---|
| Application D1 head | **0073_RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_CONSUMPTION.SQL** |
| Application D1 inventory | **73 MIGRATIONS / 103 TABLES / 1701 CHECKED INCREMENTAL COLUMNS / 156 KEY INDEXES** |
| Migration preflight | **EMPTY 0070-0072 DRAIN AUTHORITY + STOPPED WRITERS REQUIRED** |
| Registration | **ONE ACTION-BOUND ROOT/PASSKEY/AUDIT RECEIPT PER AUTHORIZATION** |
| Passkey lifecycle | **LIVE UV ROW CHECKED AT INSERT; ROW FOREIGN KEY INTENTIONALLY ABSENT FOR ROTATION/DELETION** |
| Claim | **ONE OWNER/BUILD/RUN/CREDENTIAL/LEASE-BOUND CLAIM** |
| Claimed expiry | **EXPIRED TERMINAL ALLOWED AFTER LEASE WITHOUT SCAN OR SEAL** |
| Terminal | **ONE SUCCEEDED / FAILED / EXPIRED / AMBIGUOUS RECEIPT PER CLAIM** |
| Successful seal | **TERMINAL INSERT ATOMICALLY PROJECTS EXACT 0071 SEAL AND GLOBAL LEDGER RECEIPT** |
| Global receipt ledger | **APPEND-PRESERVED REGISTRATION -> CLAIM -> TERMINAL HEAD CHAIN** |
| Private claim/terminal repository | **IMPLEMENTED LOCALLY; FRESH=TRIGGER-AWARE 2 CLAIM/NON-SUCCESS OR 3 SUCCESS WRITES, REPLAY=EXPLICIT 0 WRITES, MALFORMED/BATCH/READBACK ERROR=UNKNOWN; NO CALLER** |
| Schema attestation | **34 EXACT SQL OBJECT FINGERPRINTS + 4 TABLE PRAGMA FINGERPRINTS REQUIRED BEFORE MUTATION** |
| Registration repository | **NOT IMPLEMENTED; BLOCKED ON CONNECTED M1 ISSUANCE/AUDIT/ISSUER** |
| M1 passkey/audit/permit controls | **ACTION-BOUND CREATE-ONLY MANDATORY-UV PROOF FOUNDATION IMPLEMENTED; 0074 EXACT AUDIT + PERMIT VERIFIER + ISOLATED ISSUER ABSENT** |
| Issuer / claim worker / collector | **ABSENT** |
| Route / credential / runtime write gate | **ABSENT** |
| Close / traffic-return / reopen authority | **ABSENT** |
| P5 candidate status | **LOCAL CONTRACT ADVANCED ONLY; AUTHENTICATED REMOTE EVIDENCE ABSENT** |
| Remote D1/Cloudflare operation | **NOT PERFORMED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |

M1 remains blocked on connecting the action-bound ceremony through a dedicated
atomic audit writer with exact `request_id` and `auth_method=passkey`, a
permit-only verifier, and an isolated issuer identity. The local create-only,
mandatory-UV proof foundation is not an issuance path. The next runtime
boundary is those remaining controls plus a private single-winner
claim/terminal worker and authoritative collector using the already-inert
repository methods; it is not route or gate activation.

## 2026-07-30 M1 Passkey Foundation Status

| Item | Current status |
|---|---|
| Dedicated registration action | **IMPLEMENTED; DOMAIN-SEPARATED, LENGTH-PREFIXED, UNKNOWN-FIELD REJECTING** |
| Required action bindings | **VERIFIED AUTHORIZATION / FENCE / HEAD / COLLECTOR / ISSUER / PERMIT / ACTION / REQUEST / AUDIT / SCOPE / SOURCE / TICKET / LEDGER / ROOT SESSION / CREDENTIAL / WRITER / NONCE** |
| User verification | **STRUCTURALLY REQUIRED; PREFERRED/DISCOURAGED REJECTED** |
| One-shot storage | **CREATE-ONLY DO LOCK + ATOMIC TAKE; 32-WAY WORKERD SINGLE WINNER** |
| Expiry | **30-300 SECOND ACTION; REMAINING-TTL STORAGE; PRE-ISSUE/AT-EXPIRY REJECTED** |
| Verified proof material | **SIGNED SUBJECT / DECODED SIGNATURE / DECODED CHALLENGE SHA-256 FROM VERIFIED BYTES** |
| Clone handling | **PRE-EXISTING STICKY WARNING + NEW COUNTER ROLLBACK REJECTED** |
| Generic passkey marker eligibility | **NONE** |
| 0073 audit exactness | **INSUFFICIENT; PARTIAL EXISTS MATCH, NON-UNIQUE REQUEST ID, MUTABLE LOG** |
| Required 0074 | **PLANNED SINGLE-STATEMENT COMMAND -> AUDIT -> REGISTRATION -> LEDGER; WORKERD 4/0 NOT YET EVIDENCE** |
| Permit-only verifier / isolated issuer | **ABSENT** |
| Registration writer / route / gate | **ABSENT** |
| Remote Cloudflare/D1 evidence | **NOT COLLECTED** |
| Go/VPS authority | **RETAINED** |
| Production eligibility | **NO-GO** |
