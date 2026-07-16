# Production Readiness Matrices

Date: 2026-07-10

Status: companion evidence matrix for
`docs/production-migration-execution-plan.md`.

## Purpose

This file tracks the concrete evidence required to migrate from the Go/VPS
deployment to the Rust/Cloudflare deployment. The execution plan defines gates;
this file defines the matrices that those gates consume.

Detailed staging/prod Cloudflare binding, secret, and observability gates are
tracked in `docs/cloudflare-production-config-checklist.md`. Traffic ramp,
rollback, reconciliation, and decommission steps are tracked in
`docs/cutover-rollback-runbook.md`. Executable G3 route/provider parity is
tracked in `docs/route-provider-parity-runbook.md`. Executable G5
admin/frontend/auth parity is tracked in
`docs/admin-frontend-parity-runbook.md`. Performance, capacity, and cost
evidence is tracked in `docs/performance-capacity-cost-runbook.md`.

Source inputs inspected for this revision:

- `C:\cinagroup\cinatoken\router\relay-router.go`
- `C:\cinagroup\cinatoken\router\video-router.go`
- `C:\cinagroup\cinatoken\router\api-router.go`
- `C:\cinagroup\cinatoken\router\dashboard.go`
- `C:\cinagroup\cinatoken\router\web-router.go`
- `C:\cinagroup\cinatoken\web\default\package.json`
- `C:\cinagroup\cinatoken\web\default\src`
- `C:\cinagroup\cinatoken\model\main.go`
- `C:\cinagroup\cinatoken\model\{user,token,channel,ability,option,log}.go`
- `migrations/d1/0001_core.sql`
- `C:\cinagroup\cinatoken\constant\channel.go`
- `C:\cinagroup\cinatoken\constant\api_type.go`
- `C:\cinagroup\cinatoken\common\api_type.go`
- `C:\cinagroup\cinatoken\relay\relay_adaptor.go`
- `C:\cinagroup\cinatoken\relay\channel`
- `C:\cinagroup\cinatoken\.env.example`
- `C:\cinagroup\cinatoken\constant\env.go`
- `wrangler.toml`
- `crates/worker/src/lib.rs`
- `crates/worker/src/relay.rs`

Cloudflare references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers for Platforms Scripts REST API:
  <https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/>
- Wrangler configuration:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Compatibility dates:
  <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Workers Fetch:
  <https://developers.cloudflare.com/workers/runtime-apis/fetch/>
- Gradual deployments:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
- Rollbacks:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>
- Workers static assets:
  <https://developers.cloudflare.com/workers/static-assets/>
- Workers SPA routing:
  <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>
- Workers secrets:
  <https://developers.cloudflare.com/workers/configuration/secrets/>
- Turnstile server-side validation:
  <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Workers pricing:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- D1 pricing:
  <https://developers.cloudflare.com/d1/platform/pricing/>
- D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>
- Queues limits:
  <https://developers.cloudflare.com/queues/platform/limits/>
- R2 limits:
  <https://developers.cloudflare.com/r2/platform/limits/>

## Status Legend

| Status | Meaning |
| --- | --- |
| Done | Implemented and covered by local tests or docs evidence. |
| Partial | Some implementation exists, but live evidence or parity is missing. |
| Planned | Required for production but not implemented in Rust yet. |
| Blocked | Cannot proceed until a prerequisite is implemented or external data exists. |
| Deferred | Not part of the first production cutover scenario. |

Gate labels:

- G0: inventory freeze
- G1: Cloudflare staging foundation
- G2: data dry run
- G3: relay parity
- G4: billing parity
- G5: admin/frontend parity
- G6: observability/security
- G7: canary
- G8: cutover
- G9: post-cutover hardening

## Evidence Model

Every production-ready row should eventually carry:

- source evidence: Go route/model/provider/config location;
- Rust evidence: source file, test, or migration file;
- live evidence: staging smoke log, request ID, or dashboard proof;
- data evidence: row counts, hashes, import result, or rollback bundle;
- rollback evidence: how to return authority to Go/VPS.

Do not mark a row `Done` for production solely because local unit tests pass.
Local tests can satisfy implementation evidence, but live staging evidence is
required for G1-G8 decisions.

### 2026-07-10 Local Operations Evidence

| Evidence | Local Result | Production Interpretation |
| --- | --- | --- |
| D1 config audit | Pass: all three D1 binding tables set `migrations_dir = "migrations/d1"`; 20 migrations are contiguous through `0020_realtime_billing_reservation_leases.sql` | Local config invariant only; staging account/resource ownership and remote state are unverified |
| Full SQLite replay | Pass: 20 migrations, 26 required tables, 56 incremental key columns, 14 key indexes | Schema-shape evidence only; no source import, row/hash reconciliation, or staging D1 evidence |
| Local Wrangler D1 | Pass: 20/20 applied on Windows with Microsoft VC++ 2015-2022 x64 runtime installed | Local `workerd`/D1 compatibility only |
| Runtime D1 capability | Compiled expected set is count 21/latest 0021; the previous localhost HTTP snapshot proved 19/0019 and must be refreshed | Fail-closed compiled contract and local SQLite application are proven; refreshed localhost and authenticated staging capability snapshots remain required |
| Worker billing clock | Pass: wasm default clock uses `js_sys::Date`; capability billing probes returned true after rebuild | Removes a local Worker panic; remote billing shadow/reconciliation evidence is still required for G4/G7 |
| Realtime `/v1/realtime` runtime and settlement bindings | Pass: six local workerd/D1/RealtimeSession/mock-upstream scenarios cover normal close, oversized upstream frame, startup queue/drain, response reservation/identity/usage/tiered settlement, event-stream failure, and accept failure; a separate release-Wasm Workerd/SQLite test explicitly evicts the DO and proves the same hibernatable client socket, serialized attachment/bridge segment, and persisted metrics survive; cleanup independently reads back zero fixture users/tokens/channels/abilities/reservations/replays/logs | Strong E3 local runtime evidence, but not deployed staging/provider, active-upstream eviction with 1011/refund/no-second-call proof, concurrent no-double-charge, deployed compatibility-date, or G7 evidence |
| Realtime settlement retry/interlock | Pass: per-response D1 reservation/CAS, hashed response dedupe, bounded 64-record settlement retry collection, persisted active reservation leases, exclusive queue ownership, one earliest-deadline alarm, strict `L+300` settlement / `L+301` recovery ownership, disconnect deferral for bound or in-flight settlement, redacted status, explicit default-off writer config, and v1 cutover/write-gate predicate are compiled and locally tested | Durability and fail-closed control evidence only; live multi-response settle/close/alarm races, exact grace boundaries, D1-refund failure, alarm/eviction, and staging evidence remain required |
| Remote staging | Not run: Wrangler unauthenticated | G1, G2, G7, and production Realtime gates remain closed |
| Exposed token | Must be revoked/rotated; must not be used | Security blocker until replacement credential and rotation evidence exist |

Current 2026-07-16 schema evidence supersedes the migration-count rows above:
the current candidate expects 42 contiguous migrations through
`0042_relay_container_financial_terminal_expand.sql`, 38 tables, 323 checked
incremental columns, and 54 key indexes. Migration 0040 adds the default-inert
global Container operation authority; append-only 0041 tightens same-state
lifecycle and terminal immutability; expand-only 0042 adds scoped client replay
identity plus immutable financial terminal/outbox authority without backfill or
gate activation. The prior remote/local Wrangler snapshots remain historical
and must be refreshed. Exact R2 response replay, the D1/DO/R2 divergence
reconciler, remote reconnect, and cross-segment no-double-charge evidence remain
production blockers.

## Gate Evidence Matrix

| Gate | Required Matrix Rows | Current Status | Next Evidence |
| --- | --- | --- | --- |
| G0 | Route, provider, table, secret, config inventory | Partial | Canonical route inventory (`docs/source-route-inventory.md`), provider/channel mapping (`docs/source-provider-channel-matrix.md`), and deployment env inventory (Environment And Config Inventory below) landed 2026-06-25. Remaining: real production per-table row counts and a redacted secret-name inventory from the production `options` table. |
| G1 | Cloudflare binding/config checklist | Partial | Local D1 config/full-chain checks pass, but staging IDs are not authenticated evidence. Revoke/rotate the exposed token, authenticate Wrangler with a replacement credential, verify the account/resources, deploy staging, and archive generated types, status, logs, and traces. |
| G2 | Table migration matrix | Partial | Current local replay passes migrations 0001-0042 with 38 tables, 323 checked incremental columns, and 54 key indexes. Migrations 0040/0041 add default-inert Container operation authority and append-only lifecycle hardening; 0042 adds the expand-only financial terminal/outbox contract. Remaining: reconcile active reservations/quarantines, drain old writers, apply all 42 to remote staging with all eight Container mutation/proof gates off, then run source export/import/verify with row counts, hashes, Time Travel/rollback evidence, and exact trigger readback. |
| G3 | Relay route and provider matrices | Partial | Route inventory, provider/channel mapping, and channel-selection algorithm captured (`docs/source-route-inventory.md`, `docs/source-provider-channel-matrix.md`, `docs/source-channel-selection-parity.md`). Weighted selection is wired into the retry loop with a Worker CSPRNG-backed bounded RNG and deterministic tests. Remaining: staging weighted-random/affinity/cross-group-retry evidence, retry/auto-ban/recovery parity (`docs/source-retry-autoban-parity.md`), and a redacted G3 report from `docs/route-provider-parity-runbook.md`. |
| G4 | Billing matrix | Partial | Tiered expression fixtures and flat intent/admission are locally implemented. Flat terminal decimal rounding, option-map replacement, site/user unset-model admission, frozen Queue/D1 settlement, D1 contract immutability, a hash-bound Go-generated flat manifest, and the default-off 0042 Container operation/billing/accounting/audit batch pass local tests. Remaining: edge/R2 integration and divergence recovery; provider actual-image/count, image-edit/free-model runtime and usage-source semantics; remote direct/Gateway/WFP/provider-invoice shadow settlement and signed delta report. |
| G5 | Admin/frontend route, auth/session, operator CRUD, cache, and audit matrix | Partial | Auth/session and core operator CRUD have landed, and session-guard authorization now re-fetches current D1 user role/status/group, rejects non-enabled or soft-deleted users before admin/root decisions, and enforces `users.session_epoch` all-devices revocation for stale Rust cookies. The tracked React/Bun workspace now passes type/build, Prettier, and strict ESLint with a zero-debt no-regression baseline enforced during `bun run check`; the built frontend bundle is scanned for high-confidence secret/token leakage; an executable bundle-size ratchet budget is enforced; `/api/status` + `/api/setup` match the frontend contract; and the broadened frontend route audit baseline is down to 0 missing calls / 0 visible-admin / 0 operations-debt / 0 payment-debt / 0 capability-hidden-product gaps across 223 Worker-facing frontend calls. Subscription funding preferences now fail closed to wallet-only until runtime parity exists. Remaining: remote D1 migration application through `0037`, deployed root/step-up recovery browser smoke, Passkey real-authenticator/import/replay/session-isolation evidence, real EMAIL/WeChat Server smoke, custom OAuth staging replay/access-policy smoke, session revocation replay evidence, and provider/deployment replay/reconciliation evidence. See `docs/migration-progress-audit-2026-07-02.md`. |
| G6 | Observability/security matrix | Partial | SSRF-validated video proxy fetches now fail closed on redirects, browser-session guards now use live D1 role/status/group/session_epoch before privilege checks, and fixed/custom OAuth state is bound to the initiating browser before token exchange. Remaining: prove logs, traces, alerts, WAF/rate limits, redaction, deployed session-revocation smoke, custom OAuth replay/access-policy/origin smoke, and runbooks. |
| G7 | Canary matrix, rollback runbook, performance/capacity/cost report | Planned | Rehearse rollback, produce redacted performance/cost report, and run internal-token canary. |
| G8 | Cutover evidence checklist | Planned | Capture final export, DNS/route plan, freeze window, owner sign-off, and approved 1x/2x/5x cost forecast. |
| G9 | Decommission matrix | Planned | Post-cutover audit, cost report, and VPS decommission plan. |

### Scheduling Gateway Ownership Matrix

| Boundary | Rust Status | Required Production Evidence |
| --- | --- | --- |
| Request owner planner | Wired: `cinatoken-gateway` is called by the live fetch entry before bindings and handlers; the owner contract is versioned and shown in the admin frontend | Deployed route/host matrix for main host, tenant preview host, provider-native routes, Realtime, static assets, and unknown paths |
| WFP preview isolation | Wired: recognized tenant preview hosts resolve before central APIs and return `wfp_preview_unavailable` when dispatch is disabled | Staging negative smoke for disabled gate, missing binding, missing tenant Worker, and no main-SPA/API fallback |
| WFP execution failure contract | Wired: dispatcher lookup and dispatched `fetch` errors map to versioned secret-free JSON; direct missing worker is 404, paid-relay missing worker/tenant failure is 502, resource limit is 429, and all platform WFP errors are `no-store` | Run missing-script, missing-binding, CPU/subrequest-limit, tenant-exception, and relay-missing-worker fixtures; archive exact status/code/cache headers and redacted traces |
| Realtime/control precedence | Wired: valid session paths are DO-owned while the settlement smoke path remains platform-router-owned | Deployed status/session/smoke route evidence with gates both on and off |
| Static/API boundary | Wired through the same pure planner | Browser hard-refresh smoke plus API 404/405 evidence proving SPA fallback never shadows API routes |
| Shared edge authentication | Partial: existing relay/admin handlers remain authoritative; no duplicate pre-auth context has been introduced | Extract a secret-safe shared context only after auth-cache hit/miss and role/token parity fixtures prove no policy drift |
| Per-token quota coordination | Producer-complete observer with bounded local retention and read-only reconciliation: tiered reserve, direct finalize/refund, Queue replay, and orphan recovery project frozen post-D1 facts; terminal history compacts behind a commit-time watermark and a 1.5 MB JSON guard; an AdminAuth D1-DO-D1 probe classifies stable match/delta/missing-state/source-change and emits only a token scope hash plus aggregates; retention/shadow gates remain false, scope is empty, and D1 is the sole financial writer | Prove deployed hot-token replay-window duration and structured-clone size, archive repeated zero-diff probe evidence through eviction/replay/recovery/compaction, validate alert delivery and load/cost behavior, rehearse disable-first rollback, and complete at least a 30-day staging bake before considering any read or write authority |

## Route Readiness Matrix

The complete, source-derived route list (every method/path, auth class, handler,
and parity finding) is `docs/source-route-inventory.md` (canonical). The matrix
below is the gated status view; where they disagree on what routes exist, the
inventory wins.

The first production migration should prefer Scenario A from the execution
plan: relay-only beta. Admin, payments, async tasks, and long-tail media routes
should not be cut over until their own rows are proven.
Detailed route body-mode, provider-adapter, smoke, and rollback evidence is
controlled by `docs/route-provider-parity-runbook.md`.

Route audit evidence is useful but not exhaustive. As of 2026-07-05 the local
audit resolves imported constant endpoint objects, SSE constructors,
navigation calls/assignments, and API-prefixed JSX `href`/`src` attributes.
It now covers both `POST /pg/chat/completions` and the task-log video content
link `GET /v1/videos/:task_id/content`, with 0 missing calls. It still does
not replace deployed browser smoke for runtime-generated OAuth/provider URLs,
role/feature-flag-hidden UI branches, credentialed redirects, or routes that
only become visible with production data.

As of 2026-07-07, the default admin frontend also exposes an Operations ->
Cloudflare Platform readiness panel backed by the admin-only
`/api/platform/capabilities` probe. It gives G1/G5 operators a read-only view
of the scheduling-gateway owner contract, Workers AI, AI Gateway, Durable
Object, WFP dispatch, WFP tenant route/guard
contracts, WFP tenant smoke readiness, realtime gate state, async task refund
replay-contract readiness, and the default-off TaskRunner submit/alarm
foundation plus terminal-aware recurring-alarm, backoff/horizon, poll-path, and
status-probe readiness, but it does not
replace live WFP tenant, Realtime DO, staging async-task cron smoke, or live
TaskRunner alarm replay evidence.

As of 2026-07-10, the Realtime capability surface also exposes separate
`realtime_session_billing_settlement_writer_compiled`,
`realtime_session_billing_settlement_replay_marker_compiled`, and
`realtime_session_billing_settlement_audit_log_compiled`, and
`realtime_session_billing_settlement_batch_compiled`, and
`realtime_session_billing_settlement_retry_compiled`,
`realtime_session_billing_reservation_lease_compiled`, and
`realtime_session_billing_reservation_lease_seconds` signals. The capability
also exposes `realtime_session_billing_settlement_write_enabled`; the public
v1 route fails closed when that runtime gate is false. These are
default-off settlement foundations guarded by
`REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED`; they do not make
`realtime_session_billing_settlement_compiled` or
`realtime_session_v1_cutover_ready` true until quota mutation, replay marker,
audit row, matching reserve/refund, per-response D1 CAS, exact D1 migration
readiness through 0020, D1 batch rollback/idempotency proof, live DO
alarm/eviction/lease recovery proof, and staging replay evidence are archived.
The local
`check:realtime-session:settlement-batch-contract` replay
now covers the SQL shape before staging, and
`check:realtime-session:settlement-staging-plan` emits setup/verify/cleanup
artifacts plus Worker-binding apply requirements, but neither is production
evidence by itself.

The next evidence step is now executable but still default-off:
`POST /api/platform/realtime/settlement-batch/smoke` runs only for admins in
non-production when `REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED=true`.
`check:realtime-session:settlement-binding-smoke-plan` records the six fixed
Worker-binding scenarios without touching D1; live `--binding-smoke
--confirm-live` output plus capabilities before/after must be archived before
the settlement readiness cells can move beyond foundation status.

Realtime row correction (2026-07-10): the long route row below predates the
0019-0020 per-response reservation increment. Current status additionally
includes response-correlated D1 reserve/settle/refund CAS, a bounded
multi-record settlement retry queue, active reservation leases, exclusive
queue ownership, stable-key merge after D1 awaits, refund-only exhaustion
recovery, one earliest-deadline alarm, gate-off polling, and capability fields
`realtime_session_billing_reservation_lease_compiled` / `_seconds`. Runtime
cutover also requires `d1_migration_ready` for the exact 20-name set. This
correction supersedes stale settlement-completion wording in that row; all live
multi-response, alarm/eviction/outage, rollback, and no-double-charge evidence
remains G7-blocking.

Realtime usage correction (2026-07-14): migration 0027 and capability
`realtime_session_usage_reconciliation_compiled` add a fail-closed owner for
missing, null, malformed, zero-completed, identity-less, or settlement-
ambiguous terminal usage. These reservations remain pre-consumed and reserved;
settlement, refund, and global orphan recovery exclude them. The admin ledger
v2 and React panel expose only hashed fingerprints and controlled reason/state
metadata. Migration 0028 subsequently adds a default-off, revision-fenced root
preview/apply workflow that prices only from the frozen expression. Its
compiled, runtime-ready, staging-verified, and cutover-ready states are separate;
`realtime_session_v1_cutover_ready` now requires the final reconciliation gate.
No local capability is staging proof.

WFP outbound correction (2026-07-14): WFP is a default-off post-admission transport,
not an admin/public paid entry point. The central relay authenticates the token,
selects the D1 channel, reserves quota, and reads
`channels.other_info.wfp_worker` before dispatch. It signs a 30-second
central-authority v3 HMAC directly with platform-only
`WFP_RELAY_AUTHORITY_SECRET`, over public worker, physical dispatch worker,
fixed outbound policy profile, method, path, body hash, channel ID, and request
ID. No authority signing or verification material is uploaded with the tenant.
The response returns through central settlement/refund and audit.
The dispatch namespace must attach outbound service `cinatoken-wfp-outbound`.
That service alone owns `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` and injects the
Cloudflare bearer. For outbound auth the tenant receives only
`CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1`; any tenant
`CF_API_TOKEN` or other Cloudflare bearer is forbidden. The outbound Worker
allows only `POST application/json`, valid JSON up to 4 MiB, and the exact
account-scoped `/ai/run`, `/ai/v1/chat/completions`, `/ai/v1/responses`, and
`/ai/v1/messages` HTTPS URLs. It discards tenant `cf-aig-*` and attribution
headers, then reconstructs route Gateway ID, timeout, retry, cache, logging, and
signed-claim-derived metadata from platform configuration. It rebuilds response
headers from an allowlist and blocks redirects. The dispatch attachment must pass exactly one outbound
parameter, `CINATOKEN_WFP_OUTBOUND_CONTEXT`; before bearer access the outbound
Worker validates that context, final path/body, central signature, and one-time
replay consumption. See Cloudflare's
[Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
and [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
documentation.
`WFP_RELAY_TRANSPORT_ENABLED` remains false in all
tracked environments. Admin dispatch is status-only; JS fallback AI deploy is
disabled; `/v1/embeddings` has been removed from the tenant route set. This is
local gated substrate, not deployment evidence. The outbound Worker now calls
the platform-owned `WfpAuthorityReplay` DO, which authenticates and consumes
each authority with canonical shard validation and fail-closed outcomes.
Signed-authority billing, remote context propagation, live sequential/
concurrent replay, eviction/cleanup/load, and real Rust/Wasm upload plus
attachment readback evidence remain G7 blockers.
Remote outbound-service attachment, outbound-only secret ownership, bearer-free
tenant readback, and live positive/negative egress evidence are also unverified.
Production remains **NO-GO**.

WFP public-ingress correction (2026-07-13): the outbound service now explicitly
sets `workers_dev=false` and `preview_urls=false` and declares no public route.
The compiled capability is a local configuration invariant, not deployed-state
evidence. Readback schema 3 additionally rejects an enabled workers.dev hostname,
enabled Preview URLs, any Custom Domain, service/environment/context-parameter
drift, or an environment-wrong replay binding on the outbound service.
After credential rotation, an account Zone-route inventory must also prove that
no Worker route targets the outbound script. Until all four public ingress
surfaces are absent remotely, WFP paid traffic remains blocked.

| Route Family | Source Evidence | Rust Status | Body/Stream Mode | Gate | Next Evidence |
| --- | --- | --- | --- | --- | --- |
| Public status and setup: `/api/status`, `/api/setup`, static content endpoints | `api-router.go`, `web-router.go`, `web/default` | Substantial: Go-compatible status/setup envelopes, public content handlers, and SPA routing implemented; deployed frontend contract smoke pending | JSON/read-only/static assets | G1/G5 | Deploy current frontend/status fixes and capture anonymous/setup/hard-refresh smoke. |
| Relay model list: `GET /v1/models`, `GET /v1/models/:model` | `relay-router.go` | Partial: token-authenticated D1-backed list/retrieve implemented using token `model_limits`, effective group/auto-group enabled abilities, OpenAI envelope, Anthropic header-compatible shape, and model-not-found error shape; provider owner metadata and full billing-config visibility filtering remain incomplete | JSON | G3 | Live token smoke for unrestricted token, limited token, auto-group token, Anthropic header shape, missing model, disabled/exhausted token, and provider owner metadata parity. |
| Gemini model list: `GET /v1beta/models`, `/v1beta/openai/models` | `relay-router.go` | Partial: token-authenticated D1-backed Gemini list and Gemini OpenAI-compatible list implemented from the same visible model set | JSON | G3 | Live Gemini-client smoke with `x-goog-api-key` / `key` auth, limited-token filtering, and empty-list behavior. |
| Playground: `POST /pg/chat/completions` | `relay-router.go`, `controller/playground.go`, `middleware/distributor.go`, `service/quota.go` | Substantial locally: Worker-owned session-backed OpenAI chat relay with user-specific `+:`/`-:` usable-group resolution, `GroupGroupRatio` display overrides, enabled/chat-capable model discovery, synthetic zero-id token context, JSON/SSE forwarding, token-table mutation bypass, per-user rate-limit key, and local `group` stripping. Complete-Worker Workerd+D1 evidence covers login, selectors, allow/deny, both response modes, quota debit, request counts, and consume audits. Default frontend capability is operator-controlled. | Bounded JSON request, JSON/SSE response | G5/G3/G4 | Archive isolated-staging browser + API evidence for token-table non-mutation, channel quota reconciliation, native rate-limit scoping, logout/disabled/quota-exhausted errors, deploy/rollback, and no credential leakage. |
| OpenAI chat/completions: `/v1/chat/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI completions: `/v1/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI responses: `/v1/responses` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live smoke for response usage and error mapping. |
| Responses compaction: `/v1/responses/compact` | `relay-router.go` | Partial: Worker relay route is implemented through the OpenAI-compatible Responses pipeline; live upstream smoke and billing shadow evidence remain | Bounded JSON request, JSON/SSE response | G3/G4 | Live compact smoke for success, unsupported channel, usage, and billing settlement/refund shape. |
| Moderations: `/v1/moderations` | `relay-router.go` | Partial: Worker relay route is implemented as OpenAI-compatible JSON passthrough with bounded request/response behavior; live upstream smoke and usage/error fixture remain | Bounded JSON request/response | G3/G4 | Live moderation smoke and fixture evidence for error mapping and zero/absent usage handling. |
| Embeddings: `/v1/embeddings`, `/v1/engines/:model/embeddings` | `relay-router.go` | Partial: `/v1/embeddings` and the legacy `/v1/engines/:model/embeddings` alias are Worker-owned through the same bounded JSON OpenAI-compatible embeddings relay. The engines alias falls back to the path `:model` only when body `model` is missing or blank, matching Go's embeddings-mode model fallback without adding a second provider path. | Bounded JSON request/response | G3/G4 | Live embeddings smoke for canonical and legacy-engine paths, batch-size checks, provider-specific adapter fixtures, and billing shadow evidence. |
| Image generations: `/v1/images/generations` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, bounded/stream response | G3/G4 | Live image smoke and large response policy evidence. |
| Image edits and legacy edits: `/v1/images/edits`, `/v1/edits` | `relay-router.go` | Partial: `/v1/images/edits` multipart forwarding and legacy `/v1/edits` compatibility route are Worker-owned; byte-safe multipart field extraction prevents binary uploads from hiding the `model` field | Multipart or JSON depending provider | G3/G4 | Live image-edit upstream smoke, usage/billing evidence, and provider-specific transform fixtures remain pending. |
| Image variations and files/fine-tunes not implemented in Go | `relay-router.go` | Deferred | Large body/file | G3 | Keep explicit 501/unsupported behavior documented. |
| Audio speech: `/v1/audio/speech` | `relay-router.go` | Partial: JSON passthrough implemented | Bounded JSON request, unparsed audio/SSE response | G3 | Live binary/audio-event smoke and audit policy evidence. |
| Audio transcription/translation: `/v1/audio/transcriptions`, `/v1/audio/translations` | `relay-router.go` | Partial: multipart forwarding is Worker-owned with bounded 25 MiB reads, byte-safe `model` extraction from binary bodies, and duration-derived prompt-token preflight estimates for WAV, MP3, FLAC, M4A/MP4, OGG/Vorbis, Opus, AIFF/AIFC, AAC ADTS, and WebM EBML `Duration`; final settlement policy and live upstream smoke remain pending | Multipart/raw upload | G3/G4 | Add real-file fixtures and replay for non-WAV/WebM formats, run live STT translation/transcription smoke, and capture billing shadow/reconciliation evidence before production ownership. |
| Anthropic Messages: `/v1/messages` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live Anthropic smoke and billing shadow report. |
| Native Gemini: `/v1beta/models/*path`, `/v1/models/*path` aliases | `relay-router.go`, Rust path parser | Partial: generate/stream/embed/count routes implemented | Bounded JSON request, streaming response for stream action | G3/G4 | Live Gemini smoke for generate, stream, embed, and countTokens. |
| OpenAI realtime: `/v1/realtime` | `relay-router.go` | Partial: `RealtimeSession` Durable Object foundation is implemented with WebSocket hibernation accepts, sanitized socket attachments, persisted lifecycle metrics in Durable Object storage, status smoke behavior, metadata-only unsupported-control responses that do not echo client payloads, a default-off `/api/platform/realtime/:session...` gateway hook, and `REALTIME_SESSIONS` Wrangler bindings/migration. `/v1/realtime` is now an early-dispatch, default-off gateway (`REALTIME_SESSION_V1_ENABLED`) that requires GET WebSocket upgrade, `model`, relay token auth (including Go-compatible Realtime subprotocol token extraction), model/IP/quota checks, relay token/IP rate limits, and OpenAI-compatible D1/cache/affinity channel selection before selecting a hibernatable DO session. `/api/platform/capabilities` now exposes Realtime cutover guards plus separate compiled/readiness signals for hibernation, auth boundary, persisted metrics, no-echo controls, upstream bridge planner, upstream channel selection planner, upstream connect contract, upstream connect handoff, upstream fetch-upgrade adapter, upstream bridge lifecycle, hibernation bridge-loss fail-closed recovery, upstream bridge frame guard, upstream bridge close mapping, upstream bridge send-failure guard, upstream bridge event trace, upstream replay contract, upstream bridge backpressure policy, upstream bridge backpressure runtime, upstream usage capture, billing pre-settlement snapshot, billing settlement preview, billing settlement handoff, billing settlement mutation plan, default-off billing settlement writer, billing settlement replay marker, billing settlement audit log, billing settlement D1 batch, platform upstream-header boundary, platform-smoke readiness, upstream bridge, billing settlement, and v1 cutover readiness; `tools/smoke_realtime_session.mjs` can preflight those signals before WebSocket smoke. The upstream bridge planner, channel-selection planner, request-scoped connect contract, gateway-to-DO secret handoff, platform upstream-header boundary, Worker-native fetch-upgrade adapter, transient in-memory bridge lifecycle, 1 MiB text/binary frame guard, deterministic close/error mapping, fail-closed send-failure cleanup, sanitized terminal event trace metadata, ordered upstream replay contract, bounded backpressure policy contract, transient FIFO client-to-upstream queue before upstream accept, metadata-only `response.done` usage capture, redacted pre-settlement billing snapshots, request-scoped settlement handoff, private user/token/channel/pre-consumed-quota mutation planning, redacted settlement-preview metrics, default-off D1 settlement writer status metrics, durable replay-marker metadata, Go-compatible audit-log row foundation, guarded D1 settlement batch foundation, and sensitive-header filtered Realtime billing probes are compiled; only redacted plan metadata, boolean handoff/mutation-plan/writer/replay/audit/batch readiness, safe close/error labels, close codes, frame byte counts, aggregate active/queued frame/byte counts on HTTP and WebSocket status, queue overflow metadata, redacted write enablement/attempt/applied/skip/error/quota-delta metadata, replay-key hash, replay-recorded state, and audit attempt/record/error status reach attachments/status/metrics, while raw upstream keys, raw bridge payloads, mutation identifiers, request-rule bodies, request probe values, usernames, token names, client IPs, and request IDs remain request-scoped/transient or audit-row-only as appropriate. The transient lifecycle forwards through an active upstream WebSocket and drains accepted-startup backlog in order. A restored attachment may still use `ping`/`status` to report `upstream_bridge_not_active`, but its first business text or binary frame now refunds non-retry-owned reservations, emits a metadata-only `upstream_unavailable` terminal event, and closes with safe code 1011 instead of leaving a false-live client open. Oversized bridge frames close with 1009, unsafe upstream close codes map to 1011, application close codes pass through, failed frame forwarding or queue drain closes both sides with safe 1011 reasons without storing payloads, and terminal bridge events expose metadata-only live/persisted replay evidence. The Realtime smoke harness now has a platform frame-limit event mode, a bridge replay contract self-test for upstream close/error/send-failure/backpressure-overflow mapping without requiring a paid upstream call, an ordered upstream replay contract self-test covering active status, forwarded frame metadata, terminal event, close mapping, persisted evidence, and redaction failures, a local mock upstream replay harness with self-test/dry-run plus review-only local D1 seed SQL, active/empty-queue WebSocket runtime-status proof before ordinary live probes, a controlled `startup-queue-drain` scenario that observes one queued frame before delayed mock accept drains it, a `response-done-usage` scenario that seeds an isolated tiered billing expression and requires runtime status to include redacted billing-snapshot plus settlement-preview metrics, controlled mock-channel `event_stream_failed` and `accept_failed` fault plans that emit metadata-only terminal events before forwarding a client probe, live `upstream-normal-close` and `upstream-frame-limit` scenarios when a non-production channel points at the mock, and a platform header-boundary live smoke mode plus local validator self-test that forges internal upstream handoff headers and requires the platform route to strip them. Archived live queue/drain/fault/usage/billing-snapshot/settlement-handoff/mutation-plan/writer/replay-marker/audit-log/batch proof, D1 rollback/idempotency evidence, final billing/audit settlement, deployed DO eviction/restore fail-closed proof, and safe live replay for upstream socket abort/error and upstream-to-client send-failure remain intentionally not complete, so v1 cutover readiness remains false. | WebSocket | G7 | Harden upstream Realtime WebSocket bridge with archived live queue/drain/fault/usage/billing-snapshot/settlement-handoff/mutation-plan/writer/replay-marker/audit-log/batch evidence, D1 rollback/idempotency proof, actual billing/audit settlement, hibernation/resume smoke proving restored attachments, persisted metrics, metadata-only terminal close, and idempotent refund, full live close/error/protocol replay, and then flip `realtime_session_v1_cutover_ready` only when production ownership is actually proven. |
| Midjourney: `/mj/*`, `/:mode/mj/*` | `relay-router.go` | Partial: Rust owns submit, owner-scoped task fetch/list, D1 task state, scheduled polling, structured rejection refund, a channel-independent D1 one-hour timeout sweep, CAS settlement/refund foundation, and admin/self read lists; image proxy/upload aliases and full provider replay remain incomplete | Task + images + uploads | G7 | Staging submit/poll/rejection/timeout/refund replay, image proxy and upload policy, Queue/R2 artifact retention, billing reconciliation, and legacy alias decisions. |
| Suno: `/suno/submit/:action`, `/suno/fetch`, `/suno/fetch/:id` | `relay-router.go` | Partial: Rust owns submit, single/batch fetch, D1 task state, scheduled polling, terminal failure normalization, TaskRunner arming, and CAS settlement/refund foundation | Async task | G7 | Staging submit/poll/failure/refund/idempotency replay, Queue/R2 artifact retention, provider conversion fixtures, and rollback. |
| Video OpenAI-compatible: `/v1/videos`, `/v1/video/generations`, `/v1/videos/:id/remix` | `video-router.go` | Partial: `/v1/video/generations` submit/fetch is Worker-owned through task orchestration; `/v1/videos` submit now uses the same path and returns an OpenAI video `queued` shell. Task rows now persist Go-style `properties`, channel-type `platform`, `private_data.upstream_task_id`, and raw provider submit/poll `data`; `GET /v1/videos/:task_id` uses that data for DB-backed OpenAI video status enrichment including progress fallback, common provider URL shapes, nested first-video arrays, Sora/OpenAI passthrough fields, and provider error fallback while preserving local `created_at` for non-Sora provider data. No-extra-I/O provider-specific serializer pieces are implemented for Ali status/error mapping, Doubao/Kling/Vidu/Jimeng/Hailuo error shapes, Kling provider timestamps/seconds, Doubao legacy `task_id`, and Gemini/Vertex Veo model extraction. `GET /v1/videos/:task_id/content` is Worker-owned for completed token-or-session-owner-scoped tasks when a stored result/provider URL or bounded `data:` URL is available; HTTP URLs are SSRF-validated, fetched with redirect-follow disabled (`RequestRedirect::Error`), and streamed through the Worker, while inline payloads are capped. `POST /v1/videos/:video_id/remix` is Worker-owned for Sora/OpenAI origin tasks: it owner-scopes the public origin id, locks to the origin channel, submits to the stored upstream video id, and derives remix ratios from origin task data. The Worker scheduled poller now runs a Go-compatible timeout sweep before normal video/Suno/Midjourney polling, timeout/video/Suno failure refunds use a CAS-winner marker inside a D1 batch, and `bun run check:task-refund-batch` locally replays no-duplicate-refund, legacy no-refund, and stale-window unblock semantics; `TASK_QUERY_LIMIT`, `TASK_TIMEOUT_MINUTES`, timeout-sweep readiness, refund-batch readiness, and refund-replay-contract readiness are exposed in `/api/platform/capabilities`; credentialed provider refetch and durable artifact retention remain Partial. | Async task + binary content | G7 | Staging timeout/refund/no-duplicate-refund replay, Queue/R2 artifact plan, provider-specific OpenAI video conversion/content fixtures, remix provider replay, task billing replay tests, and artifact retention evidence. |
| Kling/Jimeng video routes | `video-router.go` | Partial: Kling official `POST /kling/v1/videos/text2video`, `POST /kling/v1/videos/image2video`, and their `GET .../:task_id` fetch aliases are Worker-owned. Kling submit wraps the official body into the unified task shape (`model`, `prompt`, `metadata`), preserves official provider fields in metadata, forces the correct `textGenerate`/`generate` action for the upstream Kling URL, and returns the same OpenAI video queued shell as Go's Kling adaptor. Jimeng official `POST /jimeng/` and `POST /jimeng` are also Worker-owned: non-empty submit `Action` values wrap `req_key`, `prompt`, and original metadata into unified task submit, `image` presence selects `generate` vs `textGenerate` like Go, `Action=CVSync2AsyncGetResult` maps body `task_id` to owner-scoped TaskDto fetch, and the Jimeng submit parser now returns `data.task_id` on provider `code == 10000`. | Async task + provider conversion | G7 | Provider-specific conversion fixtures, live Kling/Jimeng text-image submit and fetch replay, task billing replay tests, and artifact retention evidence. |
| Dashboard billing usage: `/dashboard/billing/*`, `/v1/dashboard/billing/*` | `dashboard.go`, `web/default/src/features/dashboard`, `web/default/src/features/pricing` | Partial: Rust owns token-authenticated subscription and usage compatibility endpoints plus both `/v1` aliases; production-shaped token and time-window smoke remains | Token-auth read-only | G5/G4 | Run unrestricted/limited/expired token smoke, usage-window parity, response-shape fixtures, and billing reconciliation. |
| User auth/profile/payment/checkin/OAuth/Passkey/2FA | `api-router.go`, `web/default/src/features/auth`, `profile`, `wallet` | Partial: session login/current-user/logout with live D1 role/status/group/session_epoch recheck, public register, generated access-token and affiliation-code CSPRNG hardening, email verification/reset/bind, WeChat login/bind, fixed GitHub/Discord/OIDC OAuth login/bind with browser-bound single-use state, generic custom OAuth login/bind callbacks with D1 `user_oauth_bindings`, core profile/self-service endpoints, wallet affiliation fields, payment/subscription/redemption surfaces, 2FA frontend contracts, Worker-native Passkey registration/login/step-up finish verification with a session-bound ceremony DO and D1 credential CAS, custom OAuth provider/binding admin surfaces, and D1-backed daily check-in are implemented; real-provider/authenticator staging replay and browser proof remain deferred | Session/JSON/security-sensitive | G5/G6 | Capture authenticated staging browser smoke, Turnstile and stale-session revocation proof, fixed/custom OAuth replay rejection and bind conflict evidence, real Passkey authenticator/imported-credential/replay/session-isolation proof, real WeChat Server/EMAIL binding smoke, and forced re-auth/rebind decisions in `docs/admin-frontend-parity-runbook.md`. |
| Channel admin | `api-router.go`, `web/default/src/features/channels` | Partial: Tier 1 CRUD implemented (list/search/get/create/update/delete/batch/fix-abilities with abilities sync + cache invalidation); key reveal, test, fetch_models, tag ops, multi-key, single-channel and bounded-batch upstream_updates detect/apply, Codex usage/credential refresh, and Rust-native channel-affinity cache stats/clear plus usage diagnostics implemented; Ollama management deferred | Admin JSON + secret access | G5/G6 | D1 APIs, secret redaction, key reveal controls, cache invalidation, admin audit. |
| Token admin/user token management | `api-router.go`, `web/default/src/features/keys` | Partial: list/search/get/create/update/delete/batch/reveal implemented, user-scoped with ownership checks, key masking, cache invalidation | User JSON + secret access | G5/G6 | D1 APIs, cache invalidation, key reveal controls, operator UI smoke. |
| Logs, quota data, usage | `api-router.go`, `web/default/src/features/usage-logs` | Partial: admin + self log list/stat/delete implemented (`admin_crud.rs`); Midjourney and unified task read lists implemented at `/api/mj`, `/api/mj/self`, `/api/task`, and `/api/task/self`; token-authenticated `GET /api/usage/token/` is implemented; remaining aggregate/search compatibility and archive ownership are incomplete | Query/read-heavy | G5/G6 | Authenticated browser/token smoke, D1 query/index evidence, aggregate parity, Queue/R2/archive strategy, and redaction checks. |
| Models, vendors, prefill groups | `api-router.go`, `apps/web/source/default/src/features/models`, `system-settings` | Partial: D1 schema/import, model/vendor CRUD, prefill-group CRUD, missing-model list, fixed-origin official metadata preview/sync, and default-frontend model list/detail enrichment are implemented; enrichment returns bound channels, enabled groups, quota types, matched rule models/counts, endpoint backfill, vendor counts, and server-side status/sync filters | Admin JSON | G5 | Authenticated operator UI smoke for list/search/filter/detail/create/update/delete/sync, pricing/cache invalidation evidence after model metadata mutation, and prefill-group pagination decision. |
| Redemptions, topups, subscriptions, payment webhooks | `api-router.go` | Partial: admin redemption management, public redemption-code topup with D1 `credited` idempotency, Stripe topup checkout/webhook/reference path, Stripe subscription checkout/webhook settlement, Creem subscription checkout/webhook settlement, Epay wallet checkout/callback with provider-aware `topups.payment_provider`, Epay subscription checkout/notify/return settlement with signed callback verification and local amount checks, legacy online amount estimation, Waffo wallet checkout/webhook with RSA signature and amount checks, Waffo Pancake wallet checkout/webhook with env/identity/amount checks, Waffo Pancake subscription checkout/webhook settlement with env/identity/amount checks, Creem wallet checkout/webhook with HMAC signature and amount checks, Waffo Pancake admin config/catalog/subscription-product-option read paths and pair/subscription-product creation helpers, topup info/history/admin completion, subscription core, and balance-pay are implemented; staging replay/reconciliation evidence remains deferred | Payment/idempotent writes | G4/G5/G6 | Provider-specific signature verification, replay tests, double-credit prevention, staging payment evidence, and reconciliation. Order model, per-provider quota formulas, and the two-layer idempotency design (event dedup + conditional `UPDATE WHERE status=0`) specified in `docs/source-payment-idempotency-parity.md`. |
| Custom OAuth provider management | `api-router.go` | Partial: root-admin provider CRUD/discovery, D1 schema/import, secret-redacted responses, admin audit, `/api/status` enabled-provider exposure, and generic login/bind callbacks implemented. Callback supports slug or numeric id, browser-bound single-use state, state-preserved bind redirect URI, params/basic token exchange, bounded SSRF-guarded token/userinfo fetches, configured field extraction, access-policy enforcement, D1 binding conflict checks, and default-frontend JSON login/bind responses. | Root-admin JSON + secrets | G5/G6 | Auth-flow state replay checks, callback origin policy, custom provider login/bind smoke, access-policy deny/allow smoke, account-binding conflict smoke, and staging proof that `client_secret` is never returned. |
| Performance, ratio sync, deployments/io.net | `api-router.go` | Partial: Worker-native performance compatibility, upstream ratio sync, and io.net deployment admin compatibility are implemented; real-credential deployment smoke remains pending | External API/ops | G7 | Capture authenticated staging smoke for performance/ratio sync and io.net settings, catalogs, price estimation, list/detail/log reads, one reversible mutation, and rollback. |

## Admin, Frontend, And Auth Matrix

Executable G5 evidence is tracked in
`docs/admin-frontend-parity-runbook.md`. Keep this matrix conservative until a
redacted G5 staging report exists.

| Area | Source Evidence | Rust/Cloudflare Target | Current Status | Required Evidence |
| --- | --- | --- | --- | --- |
| Frontend build | `web/default/package.json`, `web/default/bun.lock` | Bun-driven typecheck/build with recorded source commit and artifact path | Partial/E2: full workspace tracked at `apps/web/source`; frozen install, TypeScript, Rsbuild production build, Prettier, and strict ESLint pass; built text assets are scanned for high-confidence secret/token leakage during `bun run check`; bundle-size ratchet budgets are enforced during `bun run check`; strict ESLint now has a zero-debt baseline enforced during `bun run check` | Retain build/redaction/budget/lint-baseline evidence, tighten bundle budgets after heavy-route splitting, and capture deployed browser/performance evidence before G5 sign-off |
| Frontend hosting | `web-router.go`, `web/default/src/routes` | Worker static assets with SPA fallback and API route precedence | Partial/E2: real bundle produced and Static Assets wiring exists; staging browser/hard-refresh smoke is pending | Smoke supported visible routes; remaining unsupported auth flows stay deferred until APIs land |
| API base URL and CORS | `web/default/src/lib/api.ts` | Same-origin API and cookie policy | Partial/E2: production base URL is empty and dev proxies cover all known prefixes; deployed credential/session smoke pending | Prove no localhost/cross-origin production URL and capture credentialed session smoke |
| Login/current user/logout | `api-router.go`, `features/auth/api.ts`, `lib/api.ts` | Rust session authority, secure cookies, role checks, or forced re-auth policy | Partial: `/api/user/login`, `/api/user/logout`, `/api/user/self` implemented with HMAC session cookies (`crates/session`); forced re-auth from Go is the documented policy, and Rust cookies now carry `iat` plus live D1 `session_epoch` revocation. Mechanism parity (access-token fallback, `New-Api-User` header, `sk-<key>-<channelid>` admin pin, key extraction) specified in `docs/source-auth-session-parity.md` | Login/current-user/logout smoke, expired-session handling, D1 migration `0017`, and stale-cookie revocation smoke |
| OAuth/Passkey/2FA | `api-router.go`, `features/auth`, `features/users` | Migrated securely or forced rebind/reset/defer | Partial: GitHub/Discord/OIDC and generic custom OAuth with browser-bound single-use state, WeChat, 2FA, secure verification, email verification/reset, admin Passkey reset, and Worker-native Passkey register/login/step-up are owned by Rust. Passkey uses a session-bound SQLite DO challenge, ES256/RS256 verification, D1 credential replace/CAS, session issuance, and method-bound step-up. Local Go-to-D1 import/reconciliation now preserves Passkey, TOTP, and backup-code sensitive fields byte-exact while filtering soft-deleted 2FA rows | Production source count/hash and remote import; real imported Passkey/TOTP/backup-code browser smoke or forced-reset policy; concurrent replay/session-isolation/alarm/eviction evidence; fixed/custom OAuth replay tests; real WeChat Server smoke; and admin reset audit. Flow detail in `docs/source-oauth-2fa-passkey-parity.md` |
| Token management | `api-router.go`, `features/keys/api.ts` | Token CRUD, reveal controls, status changes, cache invalidation | Partial: list/search/get/create/update/delete/batch/reveal implemented with ownership checks, masking, audit, and cache invalidation | Operator smoke, reveal audit, token cache invalidation evidence |
| Channel management | `api-router.go`, `features/channels/api.ts` | Channel CRUD/test/disable/copy, key reveal controls, cache invalidation, Codex usage/refresh, and indexed channel-affinity stats/clear plus usage diagnostics | Partial: the typed `POST /api/channel/test/:id` plus GET shim now consume endpoint/model/stream intent, reuse production capability/model/transform/transport routing, require route-specific bounded JSON/SSE evidence, and persist health only after validation. Test All uses the same executor, scans at most 100 rows, caps eligible probes at 12 with concurrency 3, batch-writes D1, and returns redacted aggregates. Model catalog, balance refresh, copy, GET/POST logout, and strict static/dynamic route matching are also covered. | Authenticated deployed browser probes across enabled direct/Gateway/WFP/Workers AI routes, provider-error and timeout evidence, channel selection/cache update, secret redaction, and Queue/Workflow progress/idempotency for unattended full-fleet maintenance |
| User and quota management | `api-router.go`, `features/users/api.ts` | User list/search/detail/manage/quota/reset with audit | Partial: list/search/get/create/update/delete, manage enable/disable/delete/promote/demote, quota add/subtract/override, generated access-token and affiliation-code CSPRNG hardening, 2FA reset, Passkey reset, and OAuth binding management routes are implemented with role-tier checks and audit rows | Atomic quota smoke, role/status smoke, audit row |
| Logs and usage | `api-router.go`, `features/usage-logs` | Recent D1 searchable logs plus archive path; task/Midjourney read lists | Partial | Request ID search, token/channel/model filters, authenticated browser smoke, no secret leakage |
| Options/settings | `api-router.go`, `features/system-settings` | Typed settings update with audit and cache invalidation | Partial: root-only list (sensitive filtered) + upsert implemented; Waffo Pancake config save, catalog/subscription-product-option reads, and pair/subscription-product creation helpers implemented with blank-private-key preservation, credential fallback, signed Waffo action calls, option-cache invalidation, and redacted audit; broader per-key validation (OAuth/ratio/console_setting) deferred | Safe option update smoke and config-cache evidence |
| Models/vendors/groups | `api-router.go`, `features/models` | Operator-visible model mapping and group/vendor config | Partial: group lookup plus model/vendor/prefill CRUD and model-list enrichment are Worker-owned; staging browser smoke and cache invalidation proof remain | Relay uses updated mapping after invalidation/TTL |
| Payment/subscription surfaces | `api-router.go`, `features/subscriptions`, `features/wallet` | Deferred to Go or covered by G4/G6 evidence | Partial: Stripe wallet topup, Stripe subscription checkout/settlement, Creem subscription checkout/settlement, Epay wallet checkout/callback, Epay subscription checkout/notify/return settlement, Waffo wallet checkout/webhook, Waffo Pancake wallet checkout/webhook, Waffo Pancake subscription checkout/webhook settlement, Creem wallet checkout/webhook, balance-pay subscriptions, redemption-code topup, amount estimation, and Waffo Pancake config/catalog/subscription-product-option/pair/product helper paths are implemented; production cutover still gated by G4/G6 replay and reconciliation evidence | Billing runbook link, webhook replay/idempotency evidence before Rust ownership (`docs/source-payment-idempotency-parity.md`) |
| Admin audit | Go audit/log behavior, Rust relay audit logs | Actor/action/target/request ID on every sensitive mutation | Planned | Redacted audit samples for token, channel, user, and option mutations |
| Frontend bundle redaction | `web/default/dist` after build | Static assets contain public config only | Partial/E2: `tools/audit_frontend_bundle_redaction.mjs` scans built frontend text assets for high-confidence private keys, API tokens, bearer literals, and credentialed URLs. `bun run check:web:bundle` and `bun run check` passed on 2026-07-05 with 460 files / 37,284,076 bytes scanned across both dist roots and 0 findings. | Keep the scan in CI, add an explicit documented allowlist only if real benign findings appear, and capture staging artifact/hash evidence before G5 sign-off |
| Frontend bundle-size budget | `web/default/dist` after build | Static assets stay inside an explicit, reviewed ratchet budget | Partial/E2: `tools/audit_frontend_bundle_budget.mjs` enforces `tools/frontend_bundle_budget.json`. `bun run check:web:bundle-budget` and `bun run check` passed on 2026-07-05 with 245 files, 18.95 MB raw / 4.49 MB gzip total, 4.29 MB raw / 1.23 MB gzip initial JS, and 5.28 MB raw / 1.00 MB gzip largest JS chunk, all within the configured budget. | Keep the budget in CI, avoid raising it without a migration note, split heavy route-specific chunks, and capture deployed browser/performance evidence before G5 sign-off |
| Frontend lint debt | `web/default/src`, `eslint.config.js` | Strict lint debt is paid down without new regressions | Complete/E2: the imported React strict-lint baseline is now zero. The final cleanup moved model mutation drawer initialization out of synchronous effect state writes, initialized ratio settings saved baselines without render-time ref reads, derived tiered-pricing number-input display values during render, and derived upstream ratio-sync endpoint defaults without effect-driven state mirroring. `tools/audit_frontend_lint_debt.mjs` enforces `tools/frontend_lint_debt_baseline.json`. `bun run check:web:quality` and `bun run check:web:lint-debt` pass on 2026-07-05 with 0 ESLint errors / 0 warnings / 0 files with findings and 0 regressions. | Keep the zero-debt lint gate in CI and capture deployed browser smoke before G5 sign-off |

## Provider And Channel Matrix

Canonical, source-derived ground truth is
`docs/source-provider-channel-matrix.md` (one row per channel type, resolved
through `ChannelType2APIType` -> `GetAdaptor`). The family table below is a
cutover-planning view; where it disagrees with the canonical matrix, the
canonical matrix wins.

Correction (2026-06-25): an earlier revision of this table over-broadened the
"OpenAI-compatible" family and double-listed channel types 22, 23, 45, 46, 47
across families. Only channel types served by the generic `openai.Adaptor`
(1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47) are truly OpenAI-compatible at the code
level. Types 16, 25-27, 35, 40, 42-46, 48, 53 have dedicated Go adapters and
need their own Rust adapters/fixtures even when OpenAI-shaped. Two source-level
findings also apply: channel type 21 (AIProxyLibrary) returns a nil adapter in
Go and must stay Unsupported/Deferred; channel type 25 (Moonshot) bridges to the
Claude API and is not plain OpenAI-compatible.

Source channel constants currently span OpenAI-compatible text, native
provider APIs, rerank, task/media providers, deployments, and special
subscription-backed credentials. Rust production should cut over by provider
family rather than by channel number alone. Each provider family must have a
G3 adapter report before canary, as defined in
`docs/route-provider-parity-runbook.md`.

| Provider Family | Source Channel Types | Rust Status | Required Evidence |
| --- | --- | --- | --- |
| OpenAI-compatible (generic `openai.Adaptor`) | 1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47 | Partial | URL mapping, header mapping, model mapping, usage parser, error mapping, live smoke per first-canary provider. Correction: the prior "12 first-party OpenAI-compatible" Rust filter incorrectly included dedicated-adapter types — legacy Zhipu (16), ZhipuV4 (26), Perplexity (27), SiliconFlow (40), Mistral (42), DeepSeek (43), MokaAI (44), xAI (48), Submodel (53) — and Moonshot (25), which bridges to the Claude API. Those are OpenAI-shaped but have their own Go adapters and must each get a Rust adapter + fixtures; they are not covered by the generic OpenAI-compatible path. Channel type 21 (AIProxyLibrary) returns a nil adapter in Go and stays Unsupported. See `docs/source-provider-channel-matrix.md`. |
| Dedicated OpenAI-like text adapters | 17, 25-27, 40, 42-46, 48, 53 | Partial: Ali(17) is direct-only for DashScope chat, legacy completions, current Responses, embeddings, bounded operator-configured native Messages, `gte-rerank-v2`, and audited synchronous image generation/edit models with actual-count settlement and bounded multi-image conversion; optional server-owned plugin forwarding is retained. Ali asynchronous image models fail before reserve. Moonshot(25) is a direct-only OpenAI/Claude bridge for chat, legacy completions, embeddings, rerank, and Anthropic Messages; ZhipuV4(26) is direct-only for chat, embeddings, image generations, and Anthropic Messages; Perplexity(27) is route-explicit for Sonar chat only; SiliconFlow(40) is direct-only for chat, legacy completions, embeddings, rerank, and image generations; Mistral(42) for chat; DeepSeek(43) for chat, legacy completions, and Anthropic Messages; VolcEngine(45) is direct-only for Ark v3 chat, embeddings, image generations, and Responses; BaiduV2(46) is direct-only for Qianfan v2 chat; xAI(48) for chat, legacy completions, Responses, and image generations; Submodel(53) for direct-only chat and legacy completions with opaque model IDs. MokaAI(44) remains Deferred and fails closed before quota reserve. | Types 17, 25-27, 40, 42, 43, 45, 46, 48, and 53 still need archived route-specific live/staging success, error, streaming usage, billing, audit, and rollback evidence. Ali, Moonshot, ZhipuV4, SiliconFlow, VolcEngine, BaiduV2, and Submodel never enter existing Gateway or WFP routing. Ali evidence must cover every admitted text route plus synchronous image generation/edit, multi-image input, URL/base64 output, count provenance, async rejection, SSE header/usage, Messages model rejection and operator patterns, plugin/no-plugin channels, bounded responses, audit/billing/invoice reconciliation, and rollback. Ali asynchronous images additionally require durable task/reservation linkage, provider-terminal CAS, Queue replay, recovery scan, timeout/refund, and duplicate-delivery proof. VolcEngine evidence must cover all four admitted routes, coding-plan and thinking normalization, response bounds, usage, errors/refunds, Bot/TTS/rerank/image-edit/Messages rejection, audit/billing reconciliation, and rollback. BaiduV2 evidence must cover normal/search chat JSON/SSE, Bearer/appid separation, bounded responses, usage, errors/refunds, unsupported-route rejection, audit/billing reconciliation, and rollback. MokaAI requires an official or staging-verifiable hosted embeddings contract before implementation. |
| Anthropic native | 14 | Partial | Live Messages non-stream/SSE smoke, cache token usage parity, error mapping. |
| Gemini native | 24 | Partial | Live generate/stream/embed/batch/count smoke, path alias parity, usageMetadata parity. |
| Jina rerank and embeddings | 38 | Partial: `/v1/rerank` passthrough and `/v1/embeddings` are route-explicit; embeddings remove the OpenAI-only `encoding_format` field before Jina egress while preserving Jina fields. | Live `/v1/rerank` and `/v1/embeddings` success/error smoke, request estimate, bounded response, usage parser, settlement/refund, audit, and rollback evidence. |
| Cohere rerank | 34 | Partial | Live `/v1/rerank` smoke, request/response transform parity, billed unit usage evidence. |
| Tencent Hunyuan | 23 | Partial: direct-only, non-streaming, text-only Chat Completions at the fixed official host; exact-body TC3 signing, strict request filtering, bounded success conversion, and provider error normalization are locally tested. | Rotate credentials; prove live TC3 acceptance and UTC/skew handling, direct and enveloped success, 400/401/403/429/503 mapping and retry, response bounds, usage, reserve/settle/refund, D1 audit/invoice reconciliation, disable/recovery, and Go rollback. |
| Legacy Baidu/Zhipu v3/Xunfei regional adapters | 15, 16, 18 | Planned. Type 16 stays Deferred pending channel migration to type 26 because the current official Zhipu API index exposes v4, not the source v3 invoke protocol. Ali(17), VolcEngine(45), BaiduV2(46), and Tencent(23) are tracked in dedicated rows above. | Adapter fixtures, auth headers, error normalization, usage parser parity; inventory and operator-approved type-15 to type-46 and type-16 to type-26 conversion before cutover. |
| AWS/Vertex AI/Cloudflare Workers AI | 33, 41 and Cloudflare adapter | Partial: Workers AI binding path is implemented for type-39 internal channels, optional `AI_GATEWAY_ID` binding routing is locally wired, WFP tenant routes can forward through Cloudflare AI Gateway REST with route-specific gateway IDs and request policy headers, and `crates/providers` now owns a pure route registry plus AI Gateway URL helpers/readiness planner, default-off REST forwarder, same-channel fallback, channel-editor opt-in, and a default-off explicit cross-model fallback for chat/Responses/Anthropic Messages. Messages requires logical and channel-mapped effective models to support the schema, rejects `@cf/`, reads the full fallback D1 pool, and has an independent staging/cutover signal. Primary `401`/`403`/`429` is a sticky veto. A bounded type-5 terminal attempt audit and actual-serving-group tiered reservation plan are locally compiled. The plan freezes one expression result, rebases candidate group ratios, reserves the maximum estimate once, and settles/refunds against the group that served the response; fallback rebuilds the plan for its own model. AWS/Vertex remain planned. | Workers AI staging smoke; route-specific AI Gateway logs; main-relay canary after `RELAY_AI_GATEWAY_ROUTER_ENABLED`; independent chat/Responses and Messages fallback replays after `RELAY_MODEL_FALLBACK_ENABLED`; Messages logical/effective schema mismatch, mixed policy-status sequence, non-stream/stream, Queue/D1 audit, refund ordering, fixed/`auto` actual-serving-group settlement, served-model/group identity, and rollback evidence; AWS/Vertex credential/binding strategy, region/project config, usage parser, and live smoke. |
| Ollama/Dify/FastGPT self-hosted or application APIs | 4, 37, 49 | Planned | Network reachability model, app-specific request/response fixtures, billing semantics, and any required service fallback or Tunnel. Types 22 and 47 are already tracked in the generic OpenAI-compatible row. |
| Midjourney/Suno/Kling/Jimeng/Vidu/Sora/Replicate/video task providers | 2, 5, 36, 50-52, 54-56 | Partial: Worker task submit/poll/settle foundation exists for several video providers, with channel-type platform persistence and raw provider task data retained for OpenAI video conversion. Midjourney/Suno remain separate task subsystems and broader provider-specific conversion/replay is not production-proven. | Queue/R2 task architecture, callback/polling idempotency, artifact retention. |
| Codex subscription-backed channel | 57 | Partial | Admin usage + OAuth credential refresh implemented with identity preservation, CAS key replacement, best-effort cache invalidation, bounded HTTPS outbound, proxy-setting rejection, and secret-safe audit. Remaining: Codex relay adapter/live subscription smoke and any non-bounded runtime escape hatch. |

Ali synchronous image readiness also requires the production
`ALI_SYNC_IMAGE_MODELS` value to be frozen against Go `SyncImageModels`, plus
live proof of immediate file-17 and 8-KiB part-header rejection, 12-MiB image
and 8-MiB response bounds, compact non-image metadata, and 502/refund for
URL-only or partial `b64_json`. None of these local guards changes the remaining
`ali_async_image_task_settlement` blocker.

## Data And Table Matrix

Source `model/main.go` auto-migrates the following production-relevant models.
Current Rust D1 coverage is intentionally smaller than the Go schema; do not
cut over non-covered table families until the target schema and import/verify
steps exist. The executable data migration procedure is
`docs/data-migration-runbook.md`.

Audit resolution (2026-07-13): all 23 D1 import targets now have deterministic
source/target projections, canonical count/hash/sample comparison, domain
checks, and family relationships. A Rust invariant prevents the import and
reconciliation sets from drifting. G2 remains blocked on a frozen production
snapshot, reviewed import SQL, remote staging D1 application, redacted evidence
archival, rollback rehearsal, and explicit manifests for the three excluded
families (`quota_data`, `setups`, and `perf_metrics`).

Field-level parity for the P0 tables (User, Token, Channel, Ability, Option, Log)
against `migrations/d1/0001_core.sql`, `0002_admin_tables.sql`, and
`0004_schema_parity.sql` is in `docs/source-d1-schema-parity.md`. It records the
source-derived defects that `0004` corrects before G2 import: ability tag,
composite uniqueness, priority/weight/tag indexes, the remaining log token-id
index, user OAuth/admin lookup indexes, and token name lookup. The `group` to
`group_name` rename remains an ETL/query mapping rule.

| Source Model/Table Family | Production Criticality | Current Rust Coverage | Required Migration Evidence |
| --- | --- | --- | --- |
| `User` | P0 | Partial D1 core | Row count/hash, quota fields, role/status, group, OAuth IDs, stripe customer, deletion handling. |
| `Token` | P0 | Partial D1 core | Key handling, quota fields, model limits, IP allowlist, token group, expiry/status, cache invalidation. |
| `Channel` | P0 | Partial D1 core | Provider type, base URL, keys, models, groups, status, weight/priority, key encryption/redaction policy. |
| `Ability` | P0 | Partial D1 core | `0004_schema_parity.sql` restores `tag`, composite uniqueness, and priority/weight/tag indexes. Verify dedup before import and map Go `group` to D1 `group_name`. See `docs/source-d1-schema-parity.md`. |
| `Option` | P0 | Partial D1 core | Billing expressions, group ratios, rate limits, feature flags, security/payment settings. |
| `Log` | P0/P1 | Partial relay audit logs | Recent queryable D1 logs plus Queue/R2 archive plan, request/upstream ID preservation. `0002_admin_tables.sql` and `0004_schema_parity.sql` cover the Go search indexes tracked for P0 parity; heavy log search may still move to Analytics Engine/R2 for write-amplification and retention. `channel_id` serializes as JSON `channel`. See `docs/source-d1-schema-parity.md`. |
| `QuotaData` | P1 | Planned | Aggregation import or recomputation strategy, dashboard parity. |
| `Model`, `Vendor`, `PrefillGroup` | P1 | Local import and canonical reconciliation implemented, including model/vendor relationships, JSON endpoint validity, active-name constraints, and prefill JSON/BLOB preservation | Real source count/hash, remote D1 import, operator smoke, frontend display parity. |
| `Setup` | P1 | Intentionally excluded from row import; versioned rebuild decision exists | Rebuild from reviewed environment/options, archive exclusion manifest, and prove setup cannot reopen after cutover. |
| `TopUp`, `Redemption` | P1 | Partial: redemption import is present; `top_ups -> topups` import maps pending/success/failed/expired to 0/1/2/3, validates/derives provider ownership, marks only success as credited, preserves existing D1 orders with `ON CONFLICT DO NOTHING`, and participates in canonical hash/domain/user-relationship reconciliation | Real source row count/hash, remote D1 import, provider callback replay, no-double-credit, refund, and paid reconciliation evidence. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | P1 security | Partial: explicit-column imports, Go SQLite datetime conversion, byte-exact secrets/keys/hashes, soft-delete filtering, `ON CONFLICT DO NOTHING`, deterministic canonical reconciliation, domain/uniqueness and relationship checks are implemented locally | Real source count/hash, remote D1 import, imported-credential login/step-up/backup-code smoke, replay/session isolation, support fallback and rollback evidence. |
| `SubscriptionPlan`, `SubscriptionOrder`, `UserSubscription`, `SubscriptionPreConsumeRecord` | P1 | Local import and deterministic reconciliation implemented with compatibility-column projection, status/source/reset-period/non-negative domains, JSON validation, and user/plan/subscription relationships | Real source count/hash, remote D1 import, settlement ownership decision, replay/idempotency evidence, and shadow billing report. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | P1/P2 | Partial | `TwoFA`/backup-code and Passkey register/login/step-up flows are locally implemented. Passkey retains Go-compatible credential encoding and D1 fields; production still requires imported-credential or forced-reset evidence plus real-authenticator replay/session-isolation smoke. |
| `CustomOAuthProvider`, `UserOAuthBinding` | P1/P2 | Partial: D1 schema/import, deterministic secret-safe reconciliation, provider/user relationships, and root-admin provider config CRUD/discovery implemented | Real provider secret migration evidence, login/bind state replay protections, callback origin checks, account-binding smoke, forced rebind option. |
| `Checkin` | P2 | Partial: local import/reconciliation and user relationship checks plus user status/submit routes with a UTC daily key and unique `(user_id, checkin_date)` guard | Real source/remote target evidence, verify per-user quota deltas, and smoke idempotent duplicate submit behavior on staging. |
| `Midjourney`, `Task` | P2/G7 | Partial: local import/reconciliation covers both history families and declared JSON fields; D1 task rows, public/upstream task IDs, channel-type platform, submit/poll status CAS, and OpenAI video status DTO enrichment are implemented for the Worker task path. | Queue/R2 task state, provider polling, billing replay, artifact retention. Submit/poll/settle lifecycle, three billing hooks, CAS idempotency, exact provider-specific DTO conversion, and the Workflows/Queue/R2 mapping in `docs/source-task-lifecycle-parity.md`. |
| `PerfMetric` | P2 | Planned | Decide whether to import historical metrics or start fresh with Workers logs/traces. |

## Environment And Config Inventory

Source: `C:\cinagroup\cinatoken\.env.example` and `constant/env.go` (G0 source
inventory). This closes the G0 "environment inventory" row.

Critical migration note: in cinatoken, **`.env`/`os.Getenv` carries only
deployment-level bootstrap config. The bulk of runtime configuration and almost
all integration secrets (JWT/session secret beyond `SESSION_SECRET`, provider
keys, Stripe/Creem/Waffo/Epay keys and webhook secrets, OAuth client secrets,
Turnstile keys, SMTP, ratios, feature flags) live in the DB `options` table**,
managed from the admin UI. Therefore most config/secret migration is governed by
the `Option` table row (P0) in the Data And Table Matrix, the
`docs/cloudflare-production-config-checklist.md` secret inventory, and the
Secrets Store decision in migration-plan §21.7 — not by env vars alone.

Deployment env vars map to Cloudflare destinations as follows:

| Env Group | Examples (Go) | Cloudflare Destination | Notes |
| --- | --- | --- | --- |
| Server/runtime | `PORT`, `HOSTNAME`, `NODE_TYPE` | Drop | Workers are stateless and multi-region; no port or master/slave node model. |
| Frontend | `FRONTEND_BASE_URL` | Worker `[vars]` | Already present; same-origin Static Assets reduces its role. |
| Debug/profiling | `ENABLE_PPROF`, `DEBUG`, `PYROSCOPE_*` | Drop | Replaced by Workers Logs/Traces/observability. |
| Primary database | `SQL_DSN`, `SQLITE_PATH`, `SQL_MAX_*` | Drop | Replaced by the `DB` D1 binding (+ Sessions API). |
| Log database | `LOG_SQL_DSN`, `ERROR_LOG_ENABLED` | Drop / Worker var | Logs go to Queue->D1 + R2/Analytics Engine. |
| Cache/sync | `REDIS_CONN_STRING`, `MEMORY_CACHE_ENABLED`, `SYNC_FREQUENCY`, `CHANNEL_UPDATE_FREQUENCY`, `BATCH_UPDATE_*` | Replace | Rate limit -> Rate Limiting binding; atomic state -> DO; cache -> KV/D1 read replicas (§21.1/§21.2). The Go memory/sync/batch model does not map to per-isolate Workers. |
| Relay behavior | `RELAY_TIMEOUT`, `RELAY_IDLE_CONN_TIMEOUT`, `STREAMING_TIMEOUT`, `GEMINI_VISION_MAX_IMAGE_NUM`, `MAX_REQUEST_BODY_MB`, `STREAM_SCANNER_MAX_BUFFER_MB`, `FORCE_STREAM_OPTION`, `AZURE_DEFAULT_API_VERSION` | Worker `[vars]` or `[limits]` | Map to relay config; body limits already enforced by bounded readers. |
| Token/media accounting | `GET_MEDIA_TOKEN`, `GET_MEDIA_TOKEN_NOT_STREAM`, `COUNT_TOKEN` | Worker `[vars]` | Tie to billing token-estimation parity. |
| TLS | `TLS_INSECURE_SKIP_VERIFY` | Drop | Worker `fetch` does not expose this; not portable. |
| Security/redirect | `TRUSTED_REDIRECT_DOMAINS` | Worker `[vars]` | Feeds SSRF/redirect validation (`docs/ssrf.md`). |
| Session | `SESSION_SECRET` | Worker secret / Secrets Store | Session cookie signing (`crates/session`). |
| Provider tunables | `COHERE_SAFETY_SETTING`, `DIFY_DEBUG` | Worker `[vars]` | Provider-specific behavior flags. |
| OAuth endpoints | `LINUX_DO_TOKEN_ENDPOINT`, `LINUX_DO_USER_ENDPOINT` | Worker `[vars]` | Non-secret endpoints; client secret is in `options`/Secrets Store. |
| Tasks | `UPDATE_TASK`, `TASK_QUERY_LIMIT`, `TASK_TIMEOUT_MINUTES`, `TASK_PRICE_PATCHES`, `TASK_RUNNER_DO_ENABLED`, `TASK_RUNNER_STAGING_REPLAY_VERIFIED`, `TASK_RUNNER_MAX_ALARM_FIRES` | Worker `[vars]` / optional DO/Workflows config | `TASK_QUERY_LIMIT=100` and `TASK_TIMEOUT_MINUTES=1440` are explicit Worker vars; scheduled poller timeout sweep, CAS-winner refund batch, local refund replay contract, and the default-off `TASK_RUNNER` DO alarm foundation plus video/remix/Suno submit-path arming are compiled. The alarm state machine separates terminal settlement from progress CAS, re-reads D1 after a lost CAS, re-arms non-terminal progress, backs off transient failures, and records cron fallback after a bounded horizon. The admin status probe, frontend UI, replay classifier, and smoke plan expose this metadata. Remaining: staging timeout/provider-failure/no-duplicate-refund replay, live TaskRunner progress/rearm/terminal/lost-CAS/horizon replay, rollback, no-double-poll CAS proof, and the final DO-vs-Workflows fast-path decision. |

Required G0 evidence still pending: real production row counts per table and a
redacted secret-name inventory captured from the production `options` table.

## Cloudflare Binding And Secret Matrix

Current `wrangler.toml` is development-shaped. Production readiness requires
real IDs, deliberate environments, generated types, and out-of-band secrets.

| Binding/Config | Current State | Production Target | Evidence |
| --- | --- | --- | --- |
| Config format | `wrangler.toml` | Prefer `wrangler.jsonc` or documented TOML exception | Config migration PR or exception note. |
| `compatibility_date` | `2026-07-11` in the main config; isolated local workerd configs use `2026-06-24` | Keep current; review periodically and prove deployed parity | Date review plus local/deployed runtime evidence. |
| `compatibility_flags` | `nodejs_compat` enabled | Keep enabled | `wrangler types` generated Env after binding changes. |
| Observability | Enabled with `head_sampling_rate = 1` | Staging/prod sampling policy documented | Logs/traces visible in staging. |
| `DB` D1 | Local placeholder; staging ID is present but unauthenticated/unverified; production placeholder remains. All three binding tables set `migrations_dir = "migrations/d1"`. | Separate verified staging/prod D1 IDs | `bun run check:d1:migration-config`; authenticated staging `wrangler d1 info`; remote migrations 0001-0031 applied with every recovery/finalization/reconciliation/quota-shadow gate false; `/api/status` D1 true; HTTP contract and Task submit/financial state-machine negative probes rejected. |
| `QUOTA_COORD` / `QuotaCoordinator` | SQLite-backed class and `v6-quota-coordinator` migration are declared in all three environments. Tiered post-D1 producers cover reserve, direct finalization, Queue replay, and orphan recovery. Bounded compaction, watermark-expiry conflicts, a 1.5 MB JSON guard, and 1,234,821-byte local maximum fixture are compiled. Retention/shadow gates are false, token scope is empty, and the observer has no financial authority. | Separate verified staging/prod namespaces; authenticated structured-clone-size headroom below Cloudflare's 2 MiB SQLite-backed key/value limit; measured replay-window duration, load, cost, expired-window alerts, rollback, and 30-day zero-diff bake | `bun run check:cf:quota-coordinator`; Workerd transaction/compaction/expired-replay/eviction/producer evidence; authenticated namespace readback; deployed hot-token size/load report; signed shadow reconciliation. Compiled compaction alone is not retention readiness. |
| `CACHE_KV`, `CONFIG_KV` | Local/prod placeholders; staging IDs are present but unauthenticated/unverified | Real verified namespaces or remove unused bindings | Authenticated binding checklist and code usage decision. |
| `FILE_BUCKET` | Named bucket, no code usage | Real R2 bucket plus retention policy | R2 smoke for upload/read/delete if enabled. |
| `LOG_QUEUE`, `BILLING_QUEUE`, `TASK_QUEUE` | `LOG_QUEUE` owns async relay audit insertion. Default-off `BILLING_QUEUE` producer, per-message Rust consumer, idempotent D1 CAS/audit replay, bounded retries, DLQ quarantine, D1 generation/lease claims, root + step-up single-incident queue replay, and environment-specific DLQ/parking queues are locally implemented and config-audited. Both Queue and reconcile gates remain false. `TASK_QUEUE` remains declared/planned. | Real queues with authenticated consumer/DLQ/parking readback, alerts, and a four-day-retention response owner | `bun run check:cf:billing-queue`; `bun run check:relay-billing-finalization:reconcile-contract`; Workerd quarantine/auth/replay/duplicate evidence; remote Queue/DLQ/parking create/readback; retry exhaustion; D1 outage and identity-conflict drills; alert and rollback drill; task-queue ownership decision. |
| Native Rate Limiting | Two bindings per environment; 120 token and 600 IP requests per 60s, route-family keys, separate numeric namespaces | Authenticated staging readback and 429 telemetry before relay canary | `bun run check:cf:native-rate-limits`; local six-scenario Realtime replay; staging load/log evidence pending. |
| Upstash vars/secrets | Optional runtime env for read-through cache and explicit legacy mode | Separate staging/prod credentials or documented removal | Secret names, no values, rotation owner. Not a native relay-admission prerequisite. |
| Provider API keys | D1 channel keys | Encrypted/redacted storage policy | Admin key reveal audit and redaction tests. |
| Payment/OAuth/Turnstile/JWT/session secrets | Go/VPS-owned today | Cloudflare secrets or forced re-auth/defer plan | Secret inventory without values. |
| AI Gateway IDs and request policy | Empty main-relay default `AI_GATEWAY_ID`. The WFP outbound service owns its default and four route-specific IDs plus bounded timeout/retry/cache/logging policy. The tenant can forward only `accept` and `content-type`; tenant `cf-aig-*`, identity, metadata, and retry inputs are discarded. Main-relay AI Gateway routing and cross-model fallback remain independently gated. | Real outbound default/route IDs or a documented direct-provider policy, with configuration ownership restricted to the platform outbound service | Live logs for only the four retained WFP routes; no embeddings tenant route. Prove spoofed tenant policy cannot alter Gateway ID, retry, cache, logging, or metadata. Main-relay canary evidence must separately prove channel opt-in, provider policy, billing, terminal audit, and fallback replay. |
| `DISPATCHER` WFP namespace | Commented binding; central relay transport selection exists behind `WFP_RELAY_TRANSPORT_ENABLED=false` and requires `channels.other_info.wfp_worker` after token auth, D1 selection, and reserve. The config shape names outbound service `cinatoken-wfp-outbound`, its matching environment, and exactly one `CINATOKEN_WFP_OUTBOUND_CONTEXT` parameter. A 30-case read-only collector validates this contract, physical `<service>-<environment>` script API target, secret ownership, workers.dev, Preview URL, Custom Domain, and replay binding, but no remote capture exists. Admin dispatch is status-only and preview-host AI is rejected. | Real untrusted staging namespace and exact service/environment/parameter attachment; transport gate enabled only for canary | Run `collect:wfp-outbound:readback` with a rotated read token, archive redacted schema-3 `verified=true` evidence, separately prove no Zone Worker route targets the outbound script, then prove live context propagation and run the signed-authority billing canary. |
| `WFP_AUTHORITY_REPLAY` / `WfpAuthorityReplay` | Platform-owned Rust DO, central v3 authentication, signed physical dispatch-worker and fixed-policy claims, canonical worker/time-bucket shard, atomic digest consumption, alarm cleanup, and fail-closed outbound call are locally compiled. The Workerd lifecycle suite proves one-of-eight concurrent consumption plus context, policy, and final-boundary negatives. `v4-wfp-authority-replay` is declared in all main Worker environments. | Main Worker DO deployed; outbound environment binds the expected main script/class; tenant has no replay binding | `bun run check:do-lifecycle-runtime`; schema-3 outbound readback; staging sequential/concurrent duplicate race; physical-target/policy tamper; eviction/redeploy and cleanup proof; latency/throughput/storage evidence; exactly one provider call. Local Workerd tests are not staging verification. |
| `cinatoken-wfp-tenant` Rust/Wasm runtime | The four retained routes, required outbound auth marker, bounded JSON/body handling, opaque authority forwarding, and fail-closed rejection of tenant Cloudflare/authority/replay material are implemented. Tenant egress forwards only content type, accept, and opaque authority; it cannot select Gateway policy or attribution. Generated JS fallback is status-only; Worker-side fallback deploy is disabled. The strict uploader now freezes enabled, nonzero observability metadata; schema-3 collection/verifier checks Settings and Content readback against it. The tracked tenant template no longer binds `AI_GATEWAY_ID`. | Strict Rust/Wasm artifact uploaded and read back from staging with no authority key, replay DO, Cloudflare bearer, or Gateway-policy binding; staging observability sampled at 1 | Dry-run manifest, REST PUT/GET hash, binding, compatibility, and observability match, exact `platform-outbound-v1` marker, forbidden-binding absence, Rust/Wasm status, minimal-header guard, central billing canary, and replay evidence. No live upload is currently claimed. |
| `cinatoken-wfp-outbound` Rust/Wasm service | Local source enforces exact account/host/path, POST, JSON, 4 MiB, invocation-context identity, central v3 authority/body/path/dispatch-worker/policy checks, replay-before-bearer, platform-owned route Gateway policy, signed-claim metadata, header allowlists, token injection, and redirect rejection. Invalid outbound configuration fails closed. Wrangler disables workers.dev/Preview URLs, declares no route, and binds the environment-specific platform replay DO. | Deployed service attached only through intended dispatch namespaces; no public ingress; exact context parameter; Gateway policy and `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` exist only there | Schema-3 remote collector output, account-wide Zone-route inventory, live context/tamper/body/path/worker/policy/replay negatives with zero provider calls, tenant-policy spoof test, four-route positive smoke, Gateway logs, redaction, and rollback. No remote capture or live egress is currently claimed. |
| `CLOUDFLARE_ACCOUNT_ID`, `WFP_DISPATCH_NAMESPACE`, `WFP_TENANT_COMPATIBILITY_DATE` | Empty/default vars | Real account/namespace/date in staging/prod | Redacted plan response shows deployable metadata. |
| `CLOUDFLARE_API_TOKEN` | Secret-only; not in config | Scoped dispatch script deploy/readback token | Secret inventory, least-privilege scope, redacted PUT/GET evidence, rotation owner. It is explicitly not accepted as a main-relay AI Gateway runtime fallback. |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Dedicated main-relay runtime secret | AI Gateway REST forwarding when the router is enabled | Relay runtime and capability readiness share one fail-closed policy requiring the gate, account ID, Gateway ID, and this dedicated token. A deploy/readback token alone must remain NotReady. |
| `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` | Secret owned only by `cinatoken-wfp-outbound` | Outbound Worker AI REST authentication | Secret inventory/readback proving it is absent from tenant and dispatch Worker bindings, least privilege, rotation owner, and no value in evidence. |
| `CINATOKEN_WFP_OUTBOUND_AUTH_MODE` | Tenant plain-text marker | Must be exactly `platform-outbound-v1` | Upload/readback proves the marker exists and every Cloudflare bearer binding is absent. |
| `WFP_RELAY_AUTHORITY_SECRET` | Platform Worker secret only | Central signer master; never a tenant binding | Minimum 32 bytes, platform-side provisioning evidence, rotation plan, and no value in logs/manifests/tenant metadata. |
| `CINATOKEN_WFP_OUTBOUND_CONTEXT` | Outbound invocation parameter, not a tenant binding | Cloudflare-provided route/public-worker/dispatch-worker context | Exact single-parameter attachment readback plus live missing/wrong-context negatives; local static Workerd binding is not remote propagation evidence. |

Detailed binding and secret ownership is tracked in
`docs/cloudflare-production-config-checklist.md`.

## Billing And Quota Matrix

Billing is a cutover blocker. Rust can relay traffic before it owns paid
settlement only if shadow mode proves deltas. The executable parity and shadow
settlement procedure is `docs/billing-parity-runbook.md`; the source-derived
engine contract and 56-test golden gap map is
`docs/source-billing-expr-parity.md`.

| Billing Area | Rust Status | Required Evidence |
| --- | --- | --- |
| Tiered expression parser/executor | Partial | Golden fixtures across real production expressions. |
| `billing_expr|||request_rule_expr` split | Partial | Go/Rust fixture coverage and metadata redaction evidence. |
| Request-time token estimate | Partial | Go `TokenCountMeta` parity for tokenizer (cl100k+o200k), OpenAI formatting overhead, model-specific image algorithm, audio duration, and media fallbacks — fully specified in `docs/source-token-estimation-parity.md`. |
| Streaming usage reconciliation | Partial | Live SSE smoke with final usage and refund-on-missing-usage behavior. Final-chunk/audio-second-to-last extraction, `ValidUsage` gate, missing-usage estimate fallback, and stream_options matrix specified in `docs/source-usage-parsing-parity.md`. |
| Non-stream usage reconciliation | Partial | Live JSON smoke for each first-canary provider. Usage parse + `ValidUsage`/estimate fallback per `docs/source-usage-parsing-parity.md`. |
| Reserve/refund/additional settlement | Partial: local Realtime Worker-binding smoke passed 6/6 scenarios with zero-row cleanup after the route-precedence fix | Repeat all six through deployed staging D1; archive applied/duplicate/rollback/audit/no-double-charge evidence before G7. |
| Non-tiered billing | Partial (implemented, schema-v4 frozen contract) | Decimal token/fixed arithmetic, cache/media sub-categories, request `OtherRatios`, Gemini input audio, DALL-E request pricing, unset-model admission, bounded Responses/Claude tool surcharges, TTS audio details, OpenRouter cache-write inference, and an immutable Go manifest are wired. Remaining gaps: provider actual-image/count replacements, image-edit/free-model runtime policy, and deployed reconciliation. See `docs/source-pricing-ratio-parity.md`. |
| Subscription/pre-consume records | Planned | Schema, import, idempotency, replay tests. |
| Payment balance mutations | Planned | Webhook signature validation, idempotent event storage, double-credit prevention. |
| Shadow billing report | Planned | Production-shaped request sample with agreed delta threshold. |

## Observability, Security, And SLO Matrix

Executable G6 evidence is tracked in
`docs/observability-slo-security-runbook.md`.

| Area | Required Production Evidence | Current Status |
| --- | --- | --- |
| Structured logs | Request ID, user/token fingerprint, endpoint, model, channel, upstream status, latency, quota delta, billing mode | Partial |
| Workers Logs/Traces | Staging and prod sampling policy; visible traces during smoke | Partial: main/outbound configs and tenant upload metadata are explicit; remote visibility remains unverified |
| Sampling/retention | Environment-specific `head_sampling_rate`, trace sampling, and long-term audit retention decision | Partial: main and tenant use production-shaped 0.1, staging main and tenant evidence require 1; retention approval remains open |
| Alerts | 5xx, D1 failures, Redis failures, queue lag, billing mismatch, payment replay failures, raw secret exposure | Planned |
| Alert drills | At least one staging drill that proves alert source, owner, first action, and rollback action | Planned |
| Redaction and generated randomness | No raw keys, bearer tokens, payment secrets, OAuth secrets, or full provider credentials in logs; generated bearer credentials, payment/order suffixes, and Worker-side bounded random draws avoid `Math.random()` | Partial: admin user access tokens, affiliation codes, balance-pay subscription order suffixes, and relay weighted channel selection are CSPRNG-backed; staging distribution and live route evidence remain required |
| CORS/WAF/rate limits | Environment-specific allowlist and abuse protection | Planned: Turnstile/secure-verification/CORS parity + KV/DO session-state requirement in `docs/source-security-middleware-parity.md` |
| SSRF controls | Any user-controlled URL fetch path is validated | Partial: `crates/ssrf` ported (not yet wired). CIDR-table divergences, DNS-rebinding decision, and wiring gate in `docs/source-ssrf-parity.md` |
| Admin audit | Every sensitive admin mutation writes actor/action/target/request ID | Planned |
| Rollback | DNS/route/feature rollback rehearsed; Rust state preserved for investigation | Planned |
| SLOs | Auth overhead, first-byte overhead, stream duration, D1 write latency, error budget, queue lag, billing delta | Planned |
| Load test | Mixed 500-concurrency or agreed production-shaped equivalent | Planned |

Rollback and reconciliation procedures are tracked in
`docs/cutover-rollback-runbook.md`.

## Performance, Capacity, And Cost Matrix

Executable performance and cost evidence is tracked in
`docs/performance-capacity-cost-runbook.md`. This matrix supports G6, G7, G8,
and G9 decisions.

| Area | Required Production Evidence | Current Status |
| --- | --- | --- |
| Go/VPS baseline | Route/provider/model/stream latency, error rate, and request-count baseline or owner-approved inferred baseline | Planned |
| Traffic mix | Current, staging, and canary traffic mix by route, provider, model, token group, and body-size class | Planned |
| Load profiles | LT-001 through LT-007 for Scenario A; LT-008 before Scenario B; LT-009 before async/task/media cutover | Planned |
| Mixed relay load | 500-concurrency or agreed production-shaped equivalent with JSON and SSE route families | Planned |
| Worker resource limits | CPU, wall time, memory/resource-limit errors, subrequests, and outgoing connection evidence | Planned |
| D1 capacity | Query duration, rows read/written, overloaded/query errors, index coverage, and hot-path row-read bounds | Planned |
| Native rate-limit capacity | Route-family 429 distribution, location-local permissive behavior, logs/Analytics Engine, false-positive review, and binding failure drill | Local runtime passed; staging load evidence planned |
| Upstash capacity | Optional cache command count, latency, error rate, hit ratio, and fail-open cache behavior | Planned only if retained |
| Queue/R2 capacity | Queue backlog, retry/DLQ count, batch size, R2 operation count, artifact size, and retention policy | Planned |
| Log/analytics cost | Workers Logs sampling, Logpush/Analytics Engine decision, retention path, and estimated monthly volume | Planned |
| Cost forecast | Approved current, 2x, 5x, and incident-spike forecast across Worker, D1, Upstash, logs, Queue, R2, and providers | Planned |
| Bottleneck ownership | Top bottlenecks have owner, mitigation, rollback path, and re-test profile | Planned |

## Durable Object Runtime Evidence Boundary (2026-07-14)

| Contract | Local Evidence | Still Required For Staging/Production |
| --- | --- | --- |
| WFP authority atomic consume | Release Rust/Wasm artifact under Workerd: exactly one concurrent winner, duplicate 409s | Deployed namespace race, provider/Gateway correlation, throughput and cost |
| WFP replay persistence | Duplicate rejected after local DO eviction | Worker version rollout/redeploy, namespace binding readback, expiry cleanup alarm |
| HTTP relay selected-stream lease renewal | Release Rust/Wasm under Workerd: a real authenticated SSE route creates and binds one positive tiered reservation, renews its lease through generation-fenced CAS while user request count remains zero, then settles once with exact user/token/channel quota and bounded audit counters | Apply 0023 in isolated staging, run past the original lease on every enabled direct/Gateway/WFP route, inject disconnect/D1/restart/recovery races, measure write cost and latency, reconcile provider/audit/accounting, and approve the default-off recovery gate |
| Realtime attachment, ambiguous usage, and orphan recovery | Release Rust/Wasm under Workerd fails admission before provider or ledger mutation when no tiered expression exists. With a frozen expression it proves authenticated positive reservation, hibernation bridge-loss refund, exact scheduled orphan refund, and failed-oldest-row deferral. A separate provider scenario sends `response.created` followed by terminal `usage:null`; the Worker claims `usage_reconciliation`, suppresses the terminal frame, returns a safe error/1011 close, retains pre-consumption, writes no settlement replay/audit, and remains immune to forced-overdue scheduled refund. | Apply 0022 and 0027 in isolated staging with all write/recovery gates false. Repeat admission, actual-provider settlement, missing/null/malformed/zero usage, identity loss, D1 ambiguity, disconnect, eviction/redeploy, schedule-versus-live-settlement, query budget, alert, ledger redaction, provider invoice, and operator-resolution drills. Local Workerd does not establish remote DO ownership or provider billing correctness. |
| WFP authority negatives | Tampered signature, physical dispatch Worker, fixed policy, body/path, and non-canonical shard are rejected locally; spoofed tenant Gateway policy is discarded | Full worker/dispatch-worker/policy/method/path/body/channel/time matrix and tenant-policy spoof matrix against staging |
| TaskRunner corrupt state | Alarm and status propagate decode failure locally | Cloudflare alarm retry count/backoff, alerting, D1/provider outage drill |
| TaskRunner missing state | Explicit alarm completes as a local no-op | Deployed cleanup/race observation and cron fallback reconciliation |
| Paid WFP route | Mock and dry-run contract only | One route per invocation, exactly one provider call, quota snapshot, settlement/refund, audit, rollback |

Local runtime completion never sets remote or production verification fields.
WFP paid-egress output must retain separate
`positiveRelayBillingVerified`, `authorityNegativeMatrixVerified`,
`replayVerified`, `exactlyOneProviderCallVerified`, and
`productionVerified` fields.

## HTTP Stream Finalization Boundary (2026-07-14)

| Contract | Local Evidence | Production Gate |
| --- | --- | --- |
| Reported usage followed by read error | Workerd preserves the pre-error `10/5/15` usage, settles once, and records `usage_source=upstream` plus `completion_reason=stream_error` | Repeat on direct, AI Gateway, and WFP with real provider invoice/audit correlation |
| Partial output followed by read error | Workerd estimates only when the charge-affecting estimate gate is enabled; exact user/token/channel deltas and one request count are asserted | Prove deployed abort, malformed, idle-timeout, and clean-EOF matrix; keep the staging gate false until approved |
| Empty/output Responses distinction | Rust unit tests keep empty Responses at zero and estimate only after `response.output_text.delta` | Live Responses matrix with provider usage and disconnect evidence |
| Durable finalization after response/disconnect | Partial E3/E4: default-off `BILLING_QUEUE`, per-message consumer, environment DLQ contract, D1 CAS replay, unique audit marker, duplicate/cross-queue/poison Workerd tests, and the 0025 root-step-up DLQ reconcile/requeue workflow are implemented. Deployed cancellation/race and remote resource evidence are absent. | Hard NO-GO for HTTP orphan-recovery cutover until authenticated Queue/DLQ/parking readback, retry exhaustion, alert/retention response, cancellation, D1 ambiguity, and recovery-race evidence exist |
| Pre-bind lease ownership | Partial E3/E4: migration 0026 adds owner generation and pre-bind renewal metadata; reserve starts at generation 1, bind CAS advances to generation 2, and terminal/recovery CAS advances again. Direct, AI Gateway, and model-fallback waits renew only the unbound generation. Queue schema v2 freezes the expected generation; legacy v1 is generation-1 drain compatibility only. | Drain all active old-writer reservations before 0026, deploy with recovery/Queue gates false, and replay delayed provider headers, late bind, ambiguous reserve/bind, concurrent recovery, cancellation, Queue duplicate, and rollback in isolated staging. |
| Buffered success clone/read failure | Local E3 closed across the current non-stream boundary: successful usage-bearing responses are observed synchronously; positive tiered reservations may forward an intact uninspectable 2xx only after reserve settlement, while per-token flat or zero-reserve traffic is blocked before delivery. Tiered and flat requests own frozen reservation and Queue/CAS finalization identities. Usage-less fixed-price audio reserves synchronously and finalizes through Queue/D1. Workerd proves positive fallback, zero-to-positive settlement, flat blocking, fixed audio, consumed Cohere refund, unknown-model admission, and immutable flat contracts. | Repeat on direct, AI Gateway, and WFP with remote Queue/D1, provider invoice, body-limit, cancellation, and failure injection. Complete provider-specific flat formulas, abort/idle taxonomy, and deployed reconciliation before G4/G5 approval. |

Normal missing usage, abnormal termination with partial evidence, and durable
finalization replay are separate gates. A single refund-on-missing-usage rule or
lease-renewal proof cannot approve all three. The capability API therefore
keeps final cutover false until explicit heartbeat configuration, estimate
state, both stream proofs, Queue enablement/binding, consumer, DLQ, replay,
reconcile, replay staging proof, D1 migration, and recovery admission all agree.

## Flat Billing Admission And Pricing Gate (2026-07-14)

| Gate | Local Evidence | Production Gate |
| --- | --- | --- |
| Unknown-model admission | Strict mode returns 400 before provider, ledger, quota, or audit mutation; site self-use and per-user unset policy admit with frozen ratio 37.5; model discovery uses the same rule | Repeat against deployed D1/auth cache and every direct/Gateway/WFP route; archive provider-call absence/presence and accounting readback |
| Option replacement | Present option `{}` replaces the seeded runtime map; missing rows use defaults; explicit zero remains configured | Mutate options through the production admin path and prove cache invalidation, rollback, and cross-isolate consistency |
| Terminal arithmetic | Exact decimal intermediates and half-away-from-zero final rounding pass a hash-bound manifest generated by the real Go source: 10 terminal and 8 admission/pre-consume cases | Regenerate at the approved Go cutover commit, archive the source/generator/template hashes and signed review, then repeat deployed shadow reconciliation |
| Frozen contract | Migrations 0029-0030 require an HTTP snapshot/digest and reject later identity, snapshot, strategy, pre-consume, or quota-contract mutation; 0031 freezes Task funding and pricing identity before provider I/O | Apply 0030-0031 remotely with write gates false, run negative D1 mutation and Task unknown-submit probes, backup/rollback, and ledger reconciliation |
| Runtime | Release main/tenant/outbound Rust/Wasm suite includes bounded TTS settlement/refund and OpenRouter cost reconstruction under Workerd | Local Workerd is E3 only; authenticate staging resources and complete Queue/DLQ, abort/idle, invoice, tracing, load, and rollback drills |
| Cutover | `relay_flat_billing_go_parity_ready` is hard false | TTS/OpenRouter and the Go flat manifest are locally closed; remains NO-GO until Ali asynchronous image task settlement, free-model runtime policy, remaining usage-source parity, remote Queue/D1/provider evidence, G1-G8, and credential rotation are complete |

## HTTP Pre-Bind Owner Generation Gate (2026-07-14)

| Gate | Required Evidence | Current Status |
| --- | --- | --- |
| Implementation | Exact reserve/bind/finalize/recovery CAS generation; pre-bind heartbeat on direct, AI Gateway, and model fallback; exact ambiguous-write readback | Done locally |
| Schema | Exact 31-file migration set, 31 tables, 167 checked incremental columns, 30 indexes; 0026 rejects active `reserved` HTTP rows, 0027 adds non-terminal Realtime reconciliation ownership, 0028 adds revision-fenced operator resolution, 0029 adds guarded flat intent snapshots, 0030 makes HTTP reservation identity immutable, and 0031 adds Task reserve/submit/attach/terminal ownership | Done locally; remote absent |
| Configuration | Explicit valid reservation deadline and heartbeat interval; Queue/recovery gates false during rollout | Done in tracked config |
| Staging proof | Delayed-header race, late-bind rejection, L+300 settlement, L+301 recovery, D1 ambiguity, Queue v2 replay, no double mutation | Planned |
| Cutover | All prior gates, durable finalization runtime, provider/accounting reconciliation, alerts, rollback rehearsal, G1-G8 approval | NO-GO |

The capability API and frontend present implementation, configuration, staging
proof, and cutover as independent states. A compiled bit, an applied migration,
or an operator-set proof variable cannot authorize scheduled recovery or
production traffic by itself.

## Task Submit Reconciliation Gate (2026-07-15)

| Gate | Required Evidence | Current Status |
| --- | --- | --- |
| Implementation | Root queue/preview; fresh-step-up apply; action/reason validation; revision and owner-generation fencing; immutable event; atomic attach/refund/accounting/audit; canonical duplicate readback | Done locally |
| Schema | Expand migration 0032, contract migration 0033, exact 33-file ledger, 32 tables, 190 checked incremental columns, 34 indexes, and object-level Task tables/triggers/indexes/columns | Done locally; remote absent |
| Configuration | Both Task reconciliation flags explicit and false in default, staging, and production | Done in tracked config |
| Privacy | API/audit expose hashes instead of frozen attach JSON; reviewed retention/deletion/access policy for retained prompt and identity metadata | Partial; policy absent |
| Staging proof | Task and Midjourney attach/refund; provider lookup evidence; legacy refund-only; stale revision; duplicate replay; preview/evidence tamper; exact-once accounting; immutable event; D1 failure injection; alert and invoice reconciliation | Not run |
| Rollout | 0032, new Worker, writer verification, traffic drain, old-isolate drain, 0033, same-candidate readback; never roll back to a 0031-era writer after 0033 | Planned |
| Cutover | All prior gates plus provider-native idempotency/lookup, shared poll lease, fair retry, checked i64 binding, FreeModel/subscription parity, rotated credentials, rollback, and G1-G8 approval | NO-GO |

`task_submit_reconciliation_cutover_ready` requires compiled code, runtime
enablement, exact object-verified schema, and an independently reviewed staging
proof flag. It does not make `task_v2_cutover_ready` true and cannot replace any
other production gate.

## Update Rules

1. Update this file when adding a route, provider, table, binding, or billing
   behavior.
2. Keep status conservative: `Partial` is the default until live evidence
   exists.
3. Add links to smoke logs or verification docs instead of pasting secrets or
   raw provider responses.
4. Never store production export bundles, API keys, channel keys, OAuth
   secrets, payment secrets, or raw bearer tokens in this repository.
5. If a billing expression implementation changes, first read
   `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md` and add Go/Rust parity
   evidence before updating production status.

## 2026-07-15 Current-Head Task Poll Ownership Matrix

This matrix is a current-head overlay. It does not alter historical evidence or
previous migration counts recorded above.

| Control | Current local state | Production acceptance | Status |
| --- | --- | --- | --- |
| 0034 expand schema | Task/Midjourney owner, generation, expiry, applied generation, revision, due indexes, control row | Remote ledger and exact object-shape readback; both control flags zero after migration | Local only |
| 0035 enforcement schema | Shape guards active; lifecycle old-writer guards installed and default off | Drain proof, unfenced-write rejection after enforcement, fenced-write success, compatible rollback proof | Local only |
| Runtime authority | Worker env flag and D1 authority are both required | No provider I/O when either is false; staged activation in the documented order | Unverified remotely |
| Stale-result fence | Owner + generation + strictly unexpired lease required at apply | Cron/DO/timeout races, expiry takeover, ambiguous D1 response, duplicate replay | Local only |
| Provider deadline | Poll HTTP deadline is `min(90, lease - 15)` seconds | Abort/read timeout, lease-expiry rejection, Vertex whole-operation timing, batch headroom | Partial |
| Video family | Separate bounded non-Suno Task query; cron plus video TaskRunner | Duplicate alarm, replacement schedule, eviction, replay, cron fallback | Partial |
| Suno family | Separate bounded Task query and channel batch; cron-only | Prove submit never arms video TaskRunner; partial/missing batch release and replay | Partial |
| Midjourney family | Separate table, batch poll, and claimed one-hour timeout | Poll/timeout race, partial response, refund/invoice reconciliation | Partial |
| 0036 scheduler schema | Local additive due/backoff/quarantine columns, two due indexes, five seeded cursors; all env gates false | Remote ordered ledger/object readback and unchanged business-row proof | Local only |
| Fair scheduling | Local minute-slot rotation, finite high-watermark rounds, claim-only cursor advance, and eight-row cap are implemented | Independent deployed cursor advance/wrap, no early poll, bounded work, no starvation | Local only |
| Retry policy | Local 15-second base, 900-second cap, deterministic jitter, success reset, and eight-failure threshold are implemented | Exact deployed sequence, restart persistence, provider classification, and no retry storm | Local only |
| Poison quarantine | Threshold quarantine plus immediate quarantine for unsupported provider, invalid provider task identity, and deterministically invalid credential are implemented; network/upstream/missing-item failures remain threshold-backed | Deployed positive/negative classification, no provider re-poll, no financial side effect, alerts, and retention | Local only |
| 0037 recovery schema | Immutable event, lowercase-hex checks, unique entity/revision index, and exact Task/Midjourney partial quarantine indexes | Remote ledger/object SQL readback, unchanged business hashes, trigger and immutability negatives | Local only |
| Recovery API | Root/no-store list+preview; fresh-step-up apply; task reference + hash redaction; timeout margin; idempotent readback; 409 conflict vs 503 unavailable separation | Deployed root/session/step-up, apply/duplicate/stale/timeout/audit/readback/failure matrix | Local only |
| Recovery cutover dependency | Both recovery vars default false; scheduler cutover requires recovery cutover ready | Independent recovery evidence review and new immutable verified candidate before scheduler verification | Blocked |
| DO acceleration boundary | Video TaskRunner binding exists and defaults off; first Task recovery apply may best-effort rearm after D1 commit | DO obeys D1 due/quarantine/lease state; arm failure adds latency only; cron continues during alarm/DO outage | Local only |
| Provider operation identity | Local task and lease identity exist | Provider-native idempotency or deterministic lookup and uniqueness for every family | Blocked |
| Submit operation deadline | Poll fetch is lease-bounded, but a complete submit operation deadline is not proven | One deadline over auth/build/submit/read/parse/attach for every provider family | Blocked |
| Fault campaign | Focused local schema/CAS tests | Remote failure injection at claim/provider/apply/refund, alerts, load, rollback | Blocked |

Required activation sequence: apply 0034 -> 0035 -> 0036 -> 0037 inertly,
deploy with recovery/lease/scheduler/TaskRunner disabled, drain all old
cron/DO/provider work, enable D1 lease authority, enable D1 lease enforcement,
enable Worker lease authority, then run isolated scheduler runtime and recovery
canaries while both staging-verification flags remain false. Recovery evidence
must be reviewed in a new candidate before scheduler cutover may become ready.
Review scheduler evidence separately; only then may video TaskRunner be
canaried.

Rollback disables recovery first, then scheduler and TaskRunner. Preserve and reconcile
in-flight provider operations, due/backoff/quarantine fields, and cursor state.
For full ownership rollback, disable lease env authority, D1 authority, and D1
enforcement in that order before lease drain and a 0033-compatible Worker.
Reconcile quarantined rows before Go/VPS resumes. Any other sequence is a
G4/G5/G7 abort. No remote or deployment evidence is recorded here; production
remains **NO-GO**.

## 2026-07-15 Native Container Shard Matrix

| Gate | Current local state | Production acceptance | Status |
| --- | --- | --- | --- |
| Shard planner | Contract v1, opaque 32-byte key, Jump Consistent Hash, generation fence, stable names | Cross-language golden vectors and reviewed ring change procedure | Local only |
| Tracked config | Generation 1, eight shards, runtime/staging false in all environments | Exact deployed readback and immutable candidate evidence | Local only |
| Routing privacy | Planner accepts only an opaque digest | Separate HMAC secret provisioned/rotated; no raw identity or digest in logs/status | Blocked |
| Controller Worker | Isolated TypeScript source, generated Env types, no public route, private edge service binding config, signed status and targeted shard POST, strict keyring/ring verification, non-waking ledger inspection, separately gated wake, readiness dispatch replay/generation/CAS/cooldown, draining admission fence, explicit retention, and thirteen Workerd/SQLite scenarios pass locally | Controller-first deployment, authenticated status/ledger/live readback, actual `RelayShardContainer`/Docker lifecycle tests, secret rotation, remote SQLite, and N/N-1 evidence | Local only |
| Native image | Axum health/readiness/strict operation skeleton plus distroless non-root Dockerfile; non-probe execution is disabled | Signed digest, SBOM, scan, actual linux/amd64 build, startup/readiness and scratch-loss proof | Local only |
| Egress | `enableInternet=false`, exported `ContainerProxy`, HTTPS interception, and deny-all handler compile locally | Exact provider allowlist and trusted credential injection with negative remote tests | Local only |
| Data ownership | D1/DO/KV/R2/container responsibilities documented | Binding-level contract tests, D1 Sessions where required, R2 replay and KV-lag tests | Local design only |
| Rollout | N/N-1 and controller-first sequence specified | Rolling update, long request, image rollback, edge disable, and drain evidence | Blocked |
| Capacity | Eight `lite` instances, two in-flight operations per shard, retryable 503 plus `Retry-After`, and ledger backpressure are configured; Workerd proves max+1 serialization, capacity release, expired-claim recovery, retention, and eviction | Remote max+1 race, account limit, overload, sustained-throughput retention, and cost evidence | Local only |
| Fault matrix | Required scenarios enumerated | Eviction, alarm duplicate/exhaustion, sleep, OOM, host restart, D1 ambiguity, overload | Blocked |
| Cutover | Capability has explicit guards and remains false | All guards plus staging soak, canary, billing/provider uniqueness, privacy, cost, approvals | NO-GO |

The Container path is an accelerator behind existing durable admission and
settlement. It cannot become a second billing authority or replace D1/Cron
recovery. Production remains **NO-GO**.

## 2026-07-15 Task Submit Operation Matrix

| Gate | Current local state | Production acceptance | Status |
| --- | --- | --- | --- |
| 0038 expand | Deadline and two digest columns; client/provider unique indexes; deadline index; old-writer defaults allowed | Remote exact object readback, unchanged business hashes, old/new writer compatibility | Local only |
| 0039 enforce | New rows require immutable lowercase SHA-256 digests and 5..120 second deadline | Old writers fully drained; old fixture rejected; new fixture accepted; rollback candidate verified compatible | Local only |
| Client replay | Same token/task/key plus same request digest returns the canonical intent without provider I/O | Required-key client rollout, retry-after-disconnect test, key conflict test, one provider create | Local only |
| Recovery API | Exact creating token receives private no-store public status; other token receives 404 | Staging auth/cache/redaction/load test and client integration evidence | Local only |
| Provider I/O bound | Absolute deadline spans route preparation, Vertex OAuth, fetch, and bounded 4 MiB response read | Per-provider timeout/partial/oversize/late-accept campaign and alert thresholds | Local only |
| Attachment ambiguity | Accepted provider result plus failed local attach returns queryable 202 and retains recovery ownership | D1 batch fault injection, operator reconciliation, invoice convergence | Local only |
| Provider idempotency | Frozen local identity is unique but not forwarded/accepted under a verified universal contract | Native key acceptance or deterministic lookup for every enabled provider/channel | Blocked |
| Client requirement | Capability and config gate exist; tracked default/staging/production value is false | Isolated staging cohort proves all supported callers preserve keys across retries | Blocked |
| Cutover | Requires local schema/runtime, client requirement, provider-native idempotency, provider lookup, staging proof, and broader Task v2 gates | Named security, billing, privacy, SRE, and rollback approval | NO-GO |

The WFP/DO architecture remains bounded by actual evidence: Dynamic Dispatch,
Rust tenant, and Rust outbound policy code exist locally, but remote namespace
upload/readback and paid egress do not. DO hibernation restores inbound client
sockets/state, not an evicted provider WebSocket bridge. AI Gateway and
application fallback must keep one retry owner. Production remains **NO-GO**.

## 2026-07-15 cinaVibeSDK Architecture Audit Matrix

| Audited boundary | Correct interpretation | cinatoken-rust production gate |
| --- | --- | --- |
| WFP data path | Namespace upload plus `DISPATCHER.get(script).fetch()` binding traffic; not a public loop | Dispatch Worker owns host-owner-script mapping, sanitization, and HMAC identity; outbound Worker alone owns egress credentials |
| Agent hibernation | Persisted state/attachment survives, but an unawaited Promise and `shouldBeGenerating` do not prove work resumes | D1/cron correctness spine is mandatory; DO alarm is acceleration only |
| Transient and secret state | In-memory `thoughtSignatures` can disappear; OAuth blobs/AI credentials must not enter client-returnable state | Persist only redacted durable facts; keep credentials in least-privilege bindings/secrets |
| AI Gateway fallback | Model retry/fallback is an application policy, not evidence that multiple retry owners are safe | Exactly one retry owner; cross-model permission check, refund/re-reserve, and terminal audit required |

The audit follows Cloudflare Workers binding/Promise guidance, Durable Object
alarm semantics, and D1 batch rollback behavior. It does not close remote WFP
namespace upload/readback or paid-canary evidence. Production remains
**NO-GO**.

## 2026-07-16 Container Shared Storage Gate Matrix

| Gate | Required evidence | Current verdict |
| --- | --- | --- |
| Local authority contract | Exact operation/owner/deadline grant, narrow hosts, no generic CRUD, persisted result CAS | PASS (local only) |
| Remote binding identity | Deployed Controller binding readback matches approved D1, KV, and R2 resources in the target account | Blocked |
| R2 input | Real Container proves exact version/digest/size/type read and drift rejection | Blocked |
| R2 result and replay | Create-only result, returned object version, exact duplicate replay, concurrent conflict/orphan cleanup, and restart recovery | Blocked |
| KV behavior | Bounded config read plus propagation-lag and stale-value policy evidence | Blocked |
| D1 behavior | Owner-fenced admission under contention, timeout, and ambiguous commit evidence | Blocked |
| Container lifecycle | Cold/warm/sleep/restart/OOM and N/N-1 calls through `outboundByHost` | Blocked |
| Operation cutover | Provider recovery, usage evidence, billing convergence, load/cost, rollback, and C1-C5 approval | **NO-GO** |

A local PASS may only permit a disabled Controller artifact to enter isolated
staging. It may not turn on a storage action flag, execution gate, scheduler,
or customer route. Promotion evidence must identify the exact deployment,
binding resources, image digest, protocol versions, test operation IDs, and
rollback target without recording credentials or request bodies.

## 2026-07-16 Durable Operation Recovery Matrix

| Gate | Required evidence | Current verdict |
| --- | --- | --- |
| Strict Container outcome | completed/rejected/recovery_required, exact fields, result bounds | PASS (local only) |
| Result-required completion | Non-health completed CAS fails without attached R2 descriptor | PASS (Workerd) |
| Terminal manifest replay | Initial and duplicate outcome reconstructed from persisted trace/status/code/result | PASS (local only) |
| Ambiguous execution | Running timeout and post-dispatch response loss become recovery_required with no retry | PASS (local ledger/controller) |
| Global dispatch CAS | Exact operation/admission, billing owner generation, selected attempt, lease, and deadline gate `prepared -> dispatched`; replay is query-only | PASS (local Rust contract only) |
| Global operation terminal CAS | Exact completed/failed/recovery-required operation evidence and authorized recovery resolution; same-state rewrites rejected | PASS (local operation evidence only) |
| Query-only DO recovery | Signed operation/owner/shard/trace query remains valid after deadline and performs no claim, schedule, wake, or Container I/O | PASS (local portable/Workerd only) |
| Atomic financial terminal batch | Operation terminal + billing settle/refund/recovery + quota/request/channel mutation + immutable audit/outbox commit together | PASS (local default-off D1 contract); blocked for edge wiring and remote proof |
| Recovery reconciler | Bounded candidate scan, DO/D1/R2 convergence, divergence metrics, authorization, retry horizon, and operator resolution | PASS for default-off observer-only local foundation: frozen-high-watermark keyset scan, global/item generation leases, bounded jitter/backoff/horizon, exact D1/DO/R2 classes, redacted run summary, AdminAuth aggregate status, RootAuth stable-cursor list, and RootAuth state-bound dead-letter retry preview. Blocked for R2 orphan inventory, retry apply/idempotent audit, provider journal, any resolution mutation, and remote evidence |
| Cold-shard recovery | Persistent schedule invokes owner/deadline CAS in real Container DO | Blocked: no Docker/remote evidence |
| Reserved admission | D1 status, generation, lease, and owner deadline all pass | PASS (local binding test) |
| Original response replay | Exact status, allowlisted headers, and byte-identical R2 body | PASS for default-off local create-only writer and verified bounded read/replay contract; blocked for edge wiring, remote R2 faults, and public canary proof |
| Edge billing order | Selected-attempt D1 bind and frozen billing inputs precede Container dispatch | Blocked |
| Provider attempt journal | Dispatch-before-send identity and one durable retry owner | Blocked |
| Independent cutover gates | Operation write, terminal CAS, reconciliation, chat canary, staging proof, financial terminal, exact response, and divergence proof are explicit false-by-default prerequisites | PASS (local config contract only) |
| Cutover | Real Container, N/N-1, remote faults, billing convergence, load/cost, rollback, C1-C5 | **NO-GO** |
