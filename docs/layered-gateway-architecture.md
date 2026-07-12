# Layered Gateway Architecture — Implementation Scheme

Reference provenance update (2026-07-12): cinaVibeSDK commit `918e974` is a
TypeScript Workers and Agents SDK implementation; it has no Rust crate. The
Rust gateway, Durable Objects, and WFP tenant in this repository are a
language/runtime translation of its topology, with cinatoken-specific auth,
billing, replay, and redaction invariants. Dynamic Dispatch and an external
Durable Object namespace are bindings, but they are not ordinary Worker
service bindings.

> **Status:** Partially implemented · updated 2026-07-11 — the provider registry
> (wired), the AI-Gateway cutover planner, the RealtimeSession DO substrate, and
> the WFP dispatch layer have all landed behind env gates. See the **Status
> ledger (TS → Rust)** below for what is wired vs. gated vs. pending, per pillar.
> **Scope:** Introduce a three-layer split (scheduling gateway → Durable Objects →
> Workers-for-Platforms tenant scripts) plus a cross-cutting AI-Gateway router on
> top of the existing relay/billing engine, reusing **cinaVibeSDK's** official
> design paradigms translated to Rust.
> **Precedence:** This document *reconciles and, where noted, supersedes* the
> platform-correction section of the migration plan (`§21.4` realtime, `§21.5`
> async tasks). Where this document conflicts with plan `§1–§20`, **this document
> wins**; where it conflicts with plan `§21`, the reconciliation notes in §7 below
> are authoritative.
> **Grounding:** Every claim is anchored to `file:line` verified against the repo
> after the 2026-07-06 AI Gateway guard increment and the vendored `worker` crate `0.5.0` source. It
> corrects the earlier draft (`reference.md`, 2026-07-04), which predates several
> now-live subsystems — see §2.

---

## 0. TL;DR

Relay admission is now native in every tracked environment. Separate Workers
Rate Limiting namespaces enforce token and IP limits with route-family keys and
hashed IP values. The legacy Upstash counter is an explicit compatibility
backend, not a default hot-path dependency. Cloudflare staging still must prove
429 telemetry, location-local/load behavior, and rollback.

The 2026-07-04 draft proposed the right shape but was written against a stale
tree and an assumed SDK surface. Re-grounded against the current repo, the plan
changes materially:

1. **The Durable Object primitives we need already exist in the pinned SDK.**
   `worker 0.5.0` supports DO **alarms** and **WebSocket Hibernation** natively —
   no upgrade, no JS shim, no new cargo feature. The draft's headline risk
   ("workers-rs DO API unstable") is largely retired. The *real* SDK constraint
   is different: **there is no DO-side SQL** in `0.5.0` (storage is key-value
   only), so every new DO holds JSON records, not queryable tables.
2. **Three of the draft's "new" deliverables are already deployed:** the `[ai]`
   binding, the `LOG_QUEUE` consumer with a DLQ, the 1-minute cron task poller,
   and a SQLite-backed `ChannelAffinity` DO. We *extend* these, not rebuild them.
3. **The billing invariants forbid a naïve QuotaCoordinator.** Pre-deduction is
   **not universal** (only tiered-expression models reserve; flat-billed models
   are post-paid), there is **no existing shadow double-write** to copy, and the
   only concurrency control today is optimistic guarded `UPDATE`s plus manual
   half-batch compensation. The DO migration must be shadow-first and
   tiered-traffic-scoped.
4. **Cross-model fallback exists as default-off substrate, not production
   policy.** The N-attempt `plan_relay_attempts` loop still changes
   channels/groups for one requested logical model. A separate Rust outer loop
   can now attempt one explicitly mapped AI Gateway model for supported
   chat/responses failures, with fallback token/channel checks, billing handoff,
   and requested-versus-served model audit metadata. The local tiered billing
   plan now freezes one expression result, rebases candidate group ratios,
   reserves the maximum estimate once, and settles/refunds against the actual
   serving group; fallback rebuilds that plan for its own model. Deployed
   replay and Queue/D1 proof for both this invariant and the bounded terminal
   attempt audit remain required before production cutover.
5. **The strongest task-system win is a bug-fix, not a DO.** A missing timeout
   sweep (Go's `sweepTimedOutTasks` was never ported for video/suno) plus a dead
   Midjourney timeout guard (seconds-vs-milliseconds units bug) create a real
   starvation risk. Fix those in the cron path first; the TaskRunner DO is an
   optional fast-path layered *on top* of the CAS that already makes overlapping
   pollers idempotent.

Net topology (unchanged in spirit from the draft, corrected in mechanism):

```
                          ┌────────────────────────────────────┐
   sk-xxx / wss client ─► │  Layer 1 · Scheduling gateway        │
                          │  edge auth · rate-limit · dispatch   │
                          │  (route() seam in #[event(fetch)])   │
                          └───┬──────────┬───────────┬──────────┘
                              │          │           │
                 ┌────────────▼─┐  ┌─────▼──────┐  ┌─▼───────────────┐
                 │ Layer 2 · DO │  │ AiGateway  │  │ Layer 3 · WFP   │
                 │ Realtime     │  │ Router     │  │ dispatch ns     │
                 │ QuotaCoord   │  │ primary+   │  │ dynamic_        │
                 │ TaskRunner   │  │ fallback   │  │ dispatcher.get()│
                 │ (0.5.0 KV +  │  │ unified URL│  │ (paid-plan gate)│
                 │  alarm + WS  │  │ key coupling│ │                 │
                 │  hibernation)│  │            │  │                 │
                 └──────────────┘  └────────────┘  └─────────────────┘
```

---

## §L. Status ledger (TS → Rust) — updated 2026-07-06

Since this doc was first written, a large fraction of the layered architecture has
**already landed in the tree** (from commit `bbcec3b` through this increment), each behind an env
gate in the proven `RELAY_CHANNEL_AFFINITY_ENABLED` style. The milestone bodies in
§4 remain the plan of record; this ledger is the authoritative current state. Three
maturity levels are used:

- **Wired** — code exists *and* runs on a live request path.
- **Gated substrate** — code exists, compiles, is tested and bound, but is inert
  behind an `*_ENABLED=false` flag / commented binding and not yet on a hot path.
- **Pending** — not started.

**2026-07-11 audit correction (supersedes optimistic wording in the ledger):**

- M7 retains AI Gateway -> direct provider fallback on the same selected
  channel, followed by optional same-logical-model channel retries. The
  2026-07-11 increment also adds a default-off Rust outer model-attempt layer for
  OpenAI-compatible chat/responses. It restores provider-native direct model
  names, fails closed on Gateway `401`/`403`/`429`, revalidates token/channel/
  billing policy for fallback, and persists requested-versus-served model
  metadata. All-fetch/configuration-failed requests now write a bounded,
  secret-free type-5 ledger after reserve refund. Actual-serving-group billing
  is now compiled locally for fixed and `auto` groups, but staging Queue/D1
  replay of reservation, settlement, refund, and terminal audit remains P0
  before production cutover.
- A default-off, admin-only Worker-binding smoke route now fixes three D1
  scenarios for actual-group refund, fallback-plan replacement, and retry-
  exhaustion refund. The companion CLI validates capabilities, plan evidence,
  snapshots, and zero-residue cleanup. This is a staging proof mechanism, not
  evidence that staging has already run.
- M8's four tenant AI routes are now a post-admission transport substrate, not
  a paid relay entry. The central relay authenticates the token, selects the D1
  channel, reserves quota, reads `channels.other_info.wfp_worker`, signs a
  30-second body/path/method/channel/request-id authority envelope, and then
  dispatches. The response returns through central settlement and audit. Keep
  `WFP_RELAY_TRANSPORT_ENABLED=false` until staging proves that complete replay.
- M5 TaskRunner is no longer a one-shot alarm: the 2026-07-11 increment separates
  terminal settlement from non-terminal progress CAS, re-reads D1 after a lost
  CAS, re-arms progress, backs off transient failures, and returns ownership to
  cron after a bounded per-task fast-path horizon. Staging alarm/cron race proof
  is still required before enabling the gate.

| Pillar / milestone | Paradigm | Maturity | What landed | What remains | Evidence |
|---|---|---|---|---|---|
| M3 Scheduling gateway | A/B/C | **Wired** | `cinatoken-gateway` is the live, pure owner planner for preflight, WFP host/internal dispatch, Gemini-native relay, RealtimeSession, assets, and the compatibility Router. Tenant preview hosts resolve before central APIs and fail closed when dispatch is disabled. The admin API/frontend expose the contract version and precedence. | Deployed host/path ownership smoke, missing-binding replay, tenant negative tests, and rollback evidence | `crates/gateway/src/lib.rs`; `crates/worker/src/lib.rs`; `crates/worker/src/platform_gateway.rs`; Cloudflare Platform frontend readiness panel |
| M2 Provider registry | — | **Wired** | `ProviderRegistry::resolve` drives per-endpoint provider routing on the live relay path | Fold remaining private-enum branches into adapters | `crates/providers/src/routing.rs:77-80`; called at `crates/worker/src/relay.rs:194` |
| M7 AiGateway router | C | **Gated substrate (fallback wired)** | Full cutover decision ladder, security coupling, current REST URL builders, a table-driven documented model-prefix registry, 8 cutover guards, `channels.other_info` opt-in, default-off forwarder, provider/channel-matched direct fallback, and frontend visibility. Gateway-only prefixes cannot silently enter the direct fallback set | Live staging canary per provider family, AI Gateway log capture, usage/billing reconciliation, failure injection, and rollback | `crates/providers/src/ai_gateway.rs`; `crates/storage/src/lib.rs` opt-in parser; `crates/worker/src/relay.rs` runtime/forwarder/fallback; `crates/worker/src/platform_gateway.rs` capabilities; gate `RELAY_AI_GATEWAY_ROUTER_ENABLED` |
| M8 WFP dispatch | B | **Gated substrate (authority + replay guarded)** | The central relay may select WFP only from `channels.other_info.wfp_worker` after relay-token authentication, D1 selection, and quota reserve. The platform retains `WFP_RELAY_AUTHORITY_SECRET`; the tenant receives a derived key and an external `WfpAuthorityReplay` binding. It verifies the exact-body envelope and atomically consumes the request ID before one of chat, responses, messages, or ai-run can egress. The evidence-only post-upload verifier recomputes module hashes and cross-checks script settings/bindings plus positive dispatch output | Keep `WFP_RELAY_TRANSPORT_ENABLED=false`; run the verifier against real upload/readback/dispatch captures; archive sequential/concurrent duplicate, eviction, cleanup, load, one-provider-call, billing, audit, and redaction evidence | `crates/wfp-authority/src/lib.rs`; `crates/worker/src/wfp_authority_replay.rs`; `crates/worker/src/relay.rs`; `crates/wfp-tenant/src/lib.rs`; `tools/deploy_wfp_tenant_artifact.mjs`; `tools/verify_wfp_post_upload.mjs`; gate `WFP_RELAY_TRANSPORT_ENABLED` |
| M6 RealtimeSession | A | **Gated substrate (default-off settlement/audit compiled)** | `#[durable_object]` with WS **hibernation** (`accept_web_socket`, `websocket_message/close`, `serialize_attachment`), per-socket `SocketAttachment`, lifecycle metrics persisted to DO storage, upstream URL/handshake planner, `/v1/realtime` D1/cache channel selection with secret-redacted plan summaries in socket attachments, request-scoped upstream connect specs, gateway-to-DO secret handoff with no raw key persistence, Worker-native upstream fetch-upgrade adapter, an in-memory upstream bridge registry that forwards client frames while active and reports `upstream_bridge_not_active` after hibernation/restart, 1 MiB text/binary frame guards with 1009 close handling, deterministic bridge close/error code mapping, fail-closed cleanup when either bridge direction cannot enqueue a frame, a bounded backpressure policy plus transient FIFO client-to-upstream queue before upstream accept, metadata-only overflow events, WebSocket and HTTP status counters for active upstream bridges plus queued frames/bytes, sanitized terminal event trace metadata for close/error/frame-limit/send-failure paths, metadata-only `response.done` usage capture into DO metrics, redacted tiered-billing pre-settlement snapshot metadata in upstream plans and connect metrics, request-scoped settlement handoff with a private user/token/channel/pre-consumed-quota mutation plan plus redacted settlement-preview metrics for final/refund/additional quota calculation from frozen snapshots plus `response.done` usage, a `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED` default-off D1 writer foundation that reuses the existing reserve/refund/final helper, a durable replay-marker foundation, and a Go-compatible audit-log row foundation that persists only redacted write/replay/audit status plus quota deltas, smoke-level bridge/upstream replay contract self-tests, and a mock upstream replay harness with review-only D1 seed SQL, active/empty-queue runtime-status proof, controlled startup queue/drain, `response.done` usage-capture plus billing-snapshot/settlement-preview status proof backed by an isolated tiered-expression seed, and early `event_stream_failed`/`accept_failed` fault plans before live probes | Production-grade bridge hardening: archived local/staging queue/drain/fault/usage/billing-snapshot/settlement-handoff/mutation-plan/writer/replay-marker/audit-log evidence, remaining upstream abort/error and upstream-to-client send-failure replay, single-transaction or equivalent CAS settlement idempotency, final Realtime billing/audit settlement, protocol parity | `crates/worker/src/realtime_session.rs`: DO + planners/handoff/fetch-upgrade adapter/transient lifecycle/frame guard/close mapping/send-failure/backpressure guard/runtime queue/event trace/startup queue probe/mock fault handoff/usage metadata capture/billing snapshot metadata/settlement handoff/mutation-plan/preview metrics/default-off writer/replay/audit metrics; `tools/smoke_realtime_session.mjs`: platform/frame-limit/replay-contract/capability smoke; `tools/smoke_realtime_upstream_replay.mjs`: mock upstream replay + D1 seed plan/runtime-status/fault/usage/billing-preview proof; `crates/worker/src/relay.rs`: Realtime channel selection helper plus billing preflight snapshot and settlement/audit handoff; binding **active** `wrangler.toml:117,216,317`; gates `REALTIME_SESSION_V1_ENABLED`/`REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED` |
| M4 QuotaCoordinator | — | **Pending** | — | Build the shadow-first per-token DO (§4 M4) | no `crates/coordinator` yet |
| M5 Task correctness / TaskRunner | — | **Partial (timeout sweep + refund replay + TaskRunner alarm probe compiled)** | Scheduled Worker poller now runs a Go-compatible timeout sweep before provider polling, uses per-task CAS for timeout failure, preserves the legacy imported-task no-refund cutoff, hardens malformed `private_data` during task CAS updates, batches timeout/video/Suno failure refunds behind a CAS-winner marker, normalizes Suno fail-reason rows to terminal failure, locally replays no-duplicate-refund/legacy/stale-window semantics with `bun run check:task-refund-batch`, wires the default-off `TASK_RUNNER` DO alarm foundation plus submit-path arming for video/remix/Suno shared task rows, lets alarm fire reuse the shared `poll_one_task` provider poll + D1 CAS settlement path, and exposes an admin-only per-task status probe with frontend UI, replay-evidence classifier, and smoke replay plan | Finish staging timeout/refund replay, provider failure replay, live TaskRunner alarm replay using the status probe, rollback, cron fallback, and no-double-poll evidence before enabling the DO fast path | `crates/worker/src/task_repository.rs`: timed-out query/CAS timeout apply/refund marker batch; `crates/worker/src/task_orchestration.rs`: config + sweep before provider poll + default-off TaskRunner arming; `crates/worker/src/task_runner.rs`: alarm foundation, submit handoff, gated poll handoff, status probe helper, and replay evidence classifier; `crates/worker/src/lib.rs`: scheduled handler, platform status route, and DO module; `tools/smoke_task_refund_batch.mjs`: local replay contract; `tools/smoke_task_runner_alarm_replay.mjs`: TaskRunner read-only replay probe; `platform_gateway.rs` + frontend Cloudflare Platform panel: capability and status probe surface |

**M6 settlement update (2026-07-08):** the default-off Realtime writer now also
has a guarded D1 batch foundation for replay marker, quota mutation, and audit
row creation, exposed as `realtime_session_billing_settlement_batch_compiled`.
The local settlement-batch replay contract covers the SQL shape before staging,
and the staging-plan tool now generates setup/verify/cleanup artifacts while
requiring the apply proof to come from the Worker binding path. Production
cutover still requires archived staging D1 rollback/idempotency evidence and
live no-double-charge proof.

**M6 binding-smoke update (2026-07-08):** the Worker now exposes a
default-off, admin-only staging route at
`/api/platform/realtime/settlement-batch/smoke`. It runs the six fixed
settlement scenarios through the same D1 binding batch function and reports
setup/final/expected snapshots. The Cloudflare Platform panel surfaces
compiled/enabled/ready smoke fields, but `realtime_session_billing_settlement`
and v1 cutover remain blocked until the live smoke and no-double-charge bundle
are archived.

**M6 local D1 and binding-evidence update (2026-07-10):** all three Wrangler
D1 binding declarations now explicitly use `migrations_dir = "migrations/d1"`.
The real local Wrangler D1 applied the contiguous 20/20 chain through
`0020_realtime_billing_reservation_leases.sql` and exposed 26 business tables. The
gateway matcher was also narrowed so the generic Realtime session branch no
longer captures `/api/platform/realtime/settlement-batch/smoke`. With the route
owned by the platform control plane, the local Worker-binding smoke passed all
six settlement scenarios and cleanup left zero residual fixture rows.

This advances M6 from SQLite/SQL-shape evidence to local Worker `DB` binding
evidence for the quota mutation, replay marker, audit row, rollback, duplicate,
refund, and tokenless paths. It also makes the Layer 1 ownership rule concrete:
explicit platform control routes are classified before Layer 2 DO session
routes or Layer 3 WFP dispatch prefixes. It does **not** validate a remote
staging D1, deployed Realtime DO, live `response.done` settlement,
hibernation/restore, paid WFP dispatch namespace, or Rust/Wasm tenant artifact.

**M6 reservation/retry update (2026-07-10):** migration 0019 and the DO now
reserve each explicit `response.create`, correlate `response.created` and
out-of-order `response.done` by hashed identity, and settle/refund each response
through D1 CAS. Migration 0020 adds a fail-closed active-reservation lease.
Lease and settlement-retry collections share one earliest-deadline alarm,
transfer ownership explicitly, merge by stable key after D1 awaits, preserve a
bounded gate-off poll, and keep exhausted refund-only work scheduled until D1
refund or durable lease transfer succeeds. HTTP/WebSocket status remains
metadata-only. Realtime cutover now also requires the exact 0020 migration set.
This closes the previously listed per-response correctness gaps locally; live
alarm/eviction/outage, multi-response, rollback, and no-double-charge evidence
remain before M6 can own paid traffic.
Wrangler is not authenticated, so staging migration, capability, binding-smoke,
rollback, and no-double-charge evidence remain open and all cutover gates remain
conservative/default-off.

**Two refinements the landed code makes over this doc's original design:**

1. **The AiGateway key-URL coupling is *stricter* than cinaVibeSDK.** vibesdk honors a
   user-supplied gateway `baseURL` *through* the gateway when the key is the user's
   own. cinatoken-rust routes **any** channel with a custom base URL to the **direct**
   provider path — `is_user_credential` only changes the *reason* code
   (`UserBaseUrlOverrideRequiresDirect` vs `CustomBaseUrlWithoutUserCredential`), not
   the outcome (`ai_gateway.rs:203-210`). A platform secret is never paired with a
   caller-controlled URL, and a user credential + custom URL still bypasses the shared
   gateway rather than routing platform traffic through a tenant's endpoint. This is a
   deliberate hardening; §1 Paradigm C's mapping row is updated to match.
2. **The WFP dispatch path hardens vibesdk's verbatim header forwarding.** vibesdk
   forwards raw request headers and copies tenant response headers unchanged
   (`worker/index.ts:164`); cinatoken-rust strips credential + `x-cinatoken-*` headers
   before dispatch, only re-adds controlled route markers, lets the tenant
   rebuild responses from a safe public-header allowlist, and now has a smoke
   guard that fails on auth/cookie, `cf-aig-*`, or non-WFP `x-cinatoken-*`
   response leakage.

---

## 1. cinaVibeSDK paradigm reuse (the design anchor)

The task is explicitly to **reuse cinaVibeSDK's official paradigms**. Three map
directly; each is translated to a Rust-native form the pinned SDK actually
supports.

### Paradigm A — DO long-session hibernation → `RealtimeSession`

| cinaVibeSDK (`worker/agents/core/codingAgent.ts`) | cinatoken-rust translation |
|---|---|
| `CodeGeneratorAgent` DO = one chat session | `RealtimeSession` DO = one `/v1/realtime` WS session |
| `ctx.acceptWebSocket()` + `webSocketMessage/Close/Error` | `State::accept_web_socket` + `websocket_message/close/error` (macro-dispatched) — confirmed present in `worker-0.5.0/src/durable.rs:229` and `worker-macros-0.5.0/src/durable_object.rs` |
| Persistent `this.state` in `cf_agents_state` SQLite; transient `secretsClient`/abort controllers rebuilt in `onStart` | Persistent `RealtimeState` (JSON via `storage().put` + `WebSocket::serialize_attachment`, `websocket.rs:242`); transient `upstream_ws` rebuilt in `fetch`/`new` |
| Client SDK exponential-backoff reconnect masks eviction as "disconnect" | Same, **with a documented caveat** (§5.3): OpenAI Realtime is server-side stateful, so a hibernation-evicted DO cannot *resume* the upstream — reconnect starts a fresh upstream session |

### Paradigm B — WFP intranet forwarding → `DISPATCHER`

| cinaVibeSDK (`worker/index.ts`, `dispatcherUtils.ts`) | cinatoken-rust translation |
|---|---|
| `dispatch_namespaces: [{binding:"DISPATCHER"}]` | `[dispatch_namespaces]` binding (net-new in `wrangler.toml`) |
| `DISPATCHER.get(appName).fetch(req)` | `env.dynamic_dispatcher("DISPATCHER").get(tenant)?.fetch_request(req)` — confirmed in `worker-0.5.0/src/dynamic_dispatch.rs:20-27` |
| `isDispatcherAvailable(env)` graceful degrade | `dispatcher_available()` gate; default-tenant fallback = the in-gateway pipeline |
| Tenant scripts PUT to `.../dispatch/namespaces/<ns>/scripts/<name>` | Tenant-script SDK crate reusing `crates/relay` + `crates/billing`, deployed via the dispatch API |

> **SDK caveat (verified):** `0.5.0`'s `DynamicDispatcher::get` hard-codes
> `JsValue::undefined()` for options (`dynamic_dispatch.rs:23`), so per-tenant
> outbound-params/limits are not expressible from Rust without `js_sys`
> reflection — the same workaround already used for the 3-arg AI-Gateway `run`.

### Paradigm C — AI Gateway multi-model routing → `AiGatewayRouter`

| cinaVibeSDK (`worker/agents/inferutils/`) | cinatoken-rust translation |
|---|---|
| Unified AI Gateway baseURL (`/compat`, `/{provider}`) | `resolve_gateway_url()` — extends the existing `AI_GATEWAY_ID` js_sys-reflection routing (`relay.rs:3195-3276`) |
| `AGENT_CONFIG` primary + fallback model per action | Primary+fallback **already exists** as `plan_relay_attempts` (N-attempt, `relay.rs:1551-1635`); this becomes labeled config + a `fallback_model` field |
| `executeInference` exp-backoff + fallback; no-retry on RateLimit/Security/cancel | Already implemented: `is_retryable_status` table (`crates/relay/src/retry.rs:37-45`) + `plan_relay_attempts` loop |
| `getApiKey` resolution chain + **security coupling** (user `baseUrl` honored only with user key) | **Landed** as `plan_ai_gateway_cutover` with `is_user_credential` (`ai_gateway.rs:190-210`) — and *stricter* than vibesdk: any custom base URL routes **direct**, never through the shared gateway (see §L note 1) |
| Per-model `creditCost` weighted limiting | **Keep the finer tiered-expression engine** (`crates/billing`) — do not regress to fixed cost |

---

## 2. Corrections to the 2026-07-04 draft (verified)

| Draft claim | Ground truth | Evidence |
|---|---|---|
| "no `[ai]` binding" | Present in all 3 env scopes | `wrangler.toml:46-47,119-120,197-198` |
| "Queue only produces, no consumer" | `LOG_QUEUE` consumer + DLQ live | `wrangler.toml:85-90`; `crates/worker/src/lib.rs:1283` |
| "no state layer; DO never landed" | `ChannelAffinity` DO deployed (SQLite-backed, env-gated) | `crates/worker/src/affinity.rs:188-242`; `wrangler.toml:95-101` |
| "workers-rs DO API unstable (high risk)" | `0.5.0` supports alarms + WS hibernation natively, no feature flag | `worker-0.5.0/src/durable.rs:229,816`, `:442`; macro dispatch verified |
| "SQLite-persisted DO state" | **No DO-side SQL in 0.5.0**; key-value storage only | `worker-0.5.0/src/durable.rs:283-495` (no `sql` symbol) |
| "shadow double-write exists for quota" | Does **not** exist; the only "shadow" is failure-diagnostic audit JSON | `relay.rs:4157-4171` |
| "reserve→settle for all traffic" | Only tiered-expr models reserve; flat models post-pay | `relay.rs:1170-1196,4241-4247` |
| `relay.rs` is 3,583 lines | 7,901 lines (~5,700 non-test) | `wc -l` |
| Gate labels "G7 data import, G8 prod deploy" | G2 data dry-run · G3 relay · G4 billing · G5 admin/frontend · G6 obs/security · **G7 canary** · **G8 cutover** · G9 hardening | `docs/production-readiness-matrices.md:97-106` |
| `DISPATCHER.get().fetch` needs new plumbing | `dynamic_dispatcher().get()` already in SDK; only the binding + args support are missing | `worker-0.5.0/src/dynamic_dispatch.rs:20-27` |

**Do not propagate stale repo-doc rows** either: `production-readiness-matrices.md`
still lists `LOG_QUEUE` as "no code usage" (:343), AI Gateway as "Empty var"
(:347), and Workers AI as "Planned" (:252) — all contradicted by the live tree.
Cite `wrangler.toml` / `verification.md` / `source-channel-selection-parity.md`
for current-state facts, and update those matrix rows as part of M0.

---

## 3. Ground-truth seams (where each layer attaches)

All four future components hook into points that **already exist** in `relay.rs`:

- **Edge auth pre-pass:** `authenticate()` with Upstash read-through, keyed by
  `token_auth(api_key, model, ip)`, re-reads quota from D1 on cache hit
  (`relay.rs:2767-3032`). Lift in front of dispatch → `AuthContext`.
- **Channel-plan reorder hook (in) / record hook (out):** affinity already
  reorders the attempt plan pre-loop (`relay.rs:1153-1157`) and records
  stickiness post-success (`relay.rs:1423-1440`). QuotaCoordinator checks and the
  AiGatewayRouter fallback fit the same two seams.
- **The four quota mutation entry points** (the only ones): `reserve_relay_quota`
  (`d1_repositories.rs:467`), `refund_reserved_relay_quota` (`:530`),
  `settle_reserved_relay_quota_usage` (`:562`), `apply_relay_quota_usage`
  (`:420`). Re-pointing their bodies at a DO stub preserves every call site.
- **Shadow attach point:** `logs.other` is freeform JSON; `tiered_billing_metadata(…, shadow_only, applied)`
  already carries a `shadow_only` discriminator (`relay.rs:4562-4595`). A
  DO-vs-D1 comparison key drops in with **zero schema change**.
- **Task CAS arbitration:** `update_task_status_cas` (`task_repository.rs:202-248`)
  makes any second poller a no-op — the property that makes a DO fast-path + cron
  sweeper hybrid safe with no new coordination.
- **Rate-limiter trait seam:** `RateLimiter`/`CounterStore` (`crates/cache/src/lib.rs:14-22`)
  are implementation-agnostic; a DO-backed counter is a drop-in.
- **Dispatcher seam:** `env.dynamic_dispatcher(…).get(tenant)` exists; only the
  `wrangler.toml` binding is missing.

---

## 4. Milestones (strangler-fig; each independently deployable, gated, reversible)

Every milestone is inert until an env flag/config enables it — the proven
`RELAY_CHANNEL_AFFINITY_ENABLED` pattern (`affinity.rs:245-247`) — and rolls back
by clearing the flag, no redeploy required.

### M0 — Doc + matrix reconciliation (0.5 day)
- **Scope:** Register this doc in the plan's Production Execution Cross-References
  list; correct the stale matrix rows (§2); record the realtime **DO-vs-Container
  decision** the gate process requires (`production-readiness-matrices.md:178`).
- **Files:** `docs/cinatoken-rust-migration-plan.md` (cross-ref + a dated `§23`
  pointer), `docs/production-readiness-matrices.md`, `docs/cloudflare-production-config-checklist.md`.
- **Verify:** cross-references resolve; matrix rows match `wrangler.toml`.
- **Rollback:** docs-only.

### M1 — Activate `RelayPipeline` by extraction (1 wk)
- **Scope:** Redefine the dead trait (`crates/relay/src/lib.rs:55-64`, whose typed
  `ChatCompletionRequest` signature mismatches the untyped `serde_json::Value`
  pipeline) into a multi-endpoint, DI-injected shape: `execute(&mut ctx, endpoint)`
  over a `RelayDeps` of trait objects (`auth/channels/quota/audit/cache/limiter/http/clock`).
  Move the **already-pure** decision logic under the trait — attempt planning
  (`plan_relay_attempts`), retryability (`retry.rs`), channel ordering, URL
  building, usage parsing — while worker I/O (`D1Database`, `Fetch`, streaming
  `Response`) stays behind injected trait objects. The worker becomes a thin
  adapter that assembles `RelayDeps` and calls `execute`.
- **Files:** `crates/relay/src/pipeline.rs` (new), `crates/relay/src/lib.rs`,
  `crates/worker/src/relay.rs` (shrink; delegate).
- **Verify:** `cargo test` exercises the planning/settlement path with in-memory
  mocks (no WASM); existing relay e2e stays green; `relay.rs` line count drops.
- **Rollback:** trait is additive; keep the old inline path behind
  `GATEWAY_PIPELINE_TRAIT_ENABLED` until parity is proven.

### M2 — Activate `ProviderRegistry` (1 wk)
- **Status (2026-07-06): Wired.** `ProviderRegistry::resolve` (`crates/providers/src/routing.rs:77-80`)
  drives per-endpoint provider routing on the live relay path (`relay.rs:194`). Remaining:
  fold any residual private-enum branches into per-provider adapters.
- **Scope:** Replace the private 3-variant `RelayProviderKind`
  {`OpenAiCompatible`,`AnthropicMessages`,`GeminiNative`} (`relay.rs:82-87`) with a
  `ProviderAdapter` registry (`crates/providers/src/lib.rs`, now seeded with
  a pure provider route registry and AI-Gateway URL helpers). Five adapters:
  OpenAI-compatible, Anthropic, Gemini, WorkersAi
  (type-39 `env.ai` short-circuit), AiGateway. Each owns URL construction, request
  transform, and usage parsing — all sourced from the pure helpers already in
  `crates/relay/src/openai_compatible.rs`.
- **Files:** `crates/providers/src/{lib,openai,anthropic,gemini,workers_ai,ai_gateway}.rs`,
  `crates/worker/src/relay.rs` (dispatch via registry).
- **Verify:** every provider's golden test passes unchanged; Workers AI staging
  smoke (`verification.md:993-1006`) still exact-bills.
- **Rollback:** registry behind a compile-time default identical to today's enum.

### M3 — Gateway dispatch seam + edge-auth pre-pass (1 wk)
- **Status (2026-07-11): owner planner wired.** The pure
  `cinatoken-gateway` crate now classifies every live fetch into one owner and
  is called before bindings/handlers in `crates/worker/src/lib.rs`. WFP tenant
  preview hosts are isolated before Gemini/central API routes and fail closed
  when dispatch is disabled; Realtime control routes retain explicit Router
  ownership. The remaining part of M3 is shared edge-auth context extraction,
  which must not duplicate relay/admin authentication or expose credentials.
- **Scope:** Keep request execution **inside the existing `#[event(fetch)]`
  Worker** while the small `cinatoken-gateway` crate owns only deterministic,
  Cloudflare-I/O-free route classification. A later `authenticate_edge`
  context may be shared by branches only after auth-cache hit/miss and
  role/token parity are proven; existing handlers remain authoritative until
  then.
- **Files:** `crates/gateway/src/lib.rs`, `crates/worker/src/lib.rs`, and the
  existing WFP/Realtime execution adapters.
- **Verify:** owner-precedence unit tests, route-table audit with zero missing
  frontend calls, Worker/WASM checks, then deployed host/path negative smoke;
  shared auth additionally requires auth-cache hit/miss parity.
- **Rollback:** revert the owner-planner release. WFP, Realtime, and AI Gateway
  traffic continue to have their own default-off runtime gates.

### M4 — `QuotaCoordinator` DO, shadow-first (2 wk build + ≥30-day bake)
- **Scope:** Per-token DO (`id_from_name(token_id)`), **key-value** storage
  (no DO-SQL in 0.5.0), URL-RPC `reserve/settle/refund` mirroring the four D1
  entry points. **Scoped to tiered-expr traffic only** (flat billing stays
  post-paid — do not change its semantics). Stage the migration:
  1. **Shadow:** DO computes alongside the live D1 path; write a `quota_coord_shadow`
     key into `logs.other` and diff (offload comparison to the `LOG_QUEUE`
     consumer, off the hot path). Gate `QUOTA_COORD_SHADOW_ENABLED`.
  2. **Read-from-DO:** DO authoritative for reads; D1 still writes; DO error → D1.
  3. **Write-from-DO:** DO authoritative; D1 write-behind via `wait_until`.
  Preserve every invariant the map flagged: `touch_token` liveness on zero-quota
  ops, `quota_i32` clamp, half-batch compensation, channel `used_quota` +
  `request_count` atomicity.
- **Files:** `crates/coordinator/src/lib.rs` (new DO), `crates/worker/src/{lib,relay}.rs`,
  `wrangler.toml` (`QUOTA_COORD` binding + `new_sqlite_classes` in all 3 envs).
- **Verify:** shadow diff rate ≈ 0 over 30 days; `cargo test` for reserve/settle
  delta math; concurrency test (N parallel reserves on one token) shows no
  over-spend.
- **Rollback:** each stage is a separate flag; revert to the prior stage instantly.

### M5 — Task-system correctness, then optional `TaskRunner` DO (1 wk + 1 wk)
- **M5a (do first, no DO):** Go's `sweepTimedOutTasks` shape is now wired into
  the scheduled Worker poller before normal video/Suno/Midjourney polling. The
  Rust path uses per-task CAS, preserves the legacy imported-task no-refund
  cutoff, batches timeout/video/Suno failure refunds behind a CAS-winner marker,
  and exposes task-poller config/refund-batch/replay-contract readiness in
  `/api/platform/capabilities`. `bun run check:task-refund-batch` now provides
  local SQLite/D1-shape evidence for no-duplicate-refund, legacy no-refund, and
  stale-window unblock semantics. Remaining M5a work: capture the same
  timeout/provider-failure replay, no-duplicate-refund replay, and legacy
  no-refund evidence against staging D1 through the real Worker cron.
- **M5b (optional fast path):** The alarm-capable `TaskRunner` DO foundation is
  wired but default-off (`TASK_RUNNER_DO_ENABLED=false`). Each public task id
  maps to one deterministic instance name (`task:<sanitized_task_id>`), alarm
  delays are bounded to 1s..60s, `/arm`/`/status` provide the internal control
  contract, and `alarm()` now records alarm-fired evidence before attempting
  one gated `poll_one_task` call through the same provider parser and D1 CAS
  settlement path as cron. Successful shared-task inserts for video, OpenAI
  video/remix, and Suno best-effort arm the per-task DO only when the gate is
  enabled. The main Worker now exposes an admin-only
  `/api/platform/task-runner/:task_id/status` probe and
  `tools/smoke_task_runner_alarm_replay.mjs` for read-only staging replay
  evidence. The **cron remains the sweeper-of-record** until staging proves DO
  alarm replay, rollback, cron fallback, and no-double-poll CAS behavior;
  whichever path polls second is a no-op. The pure parsers in `crates/tasks`
  stay untouched.
- **Files:** `crates/worker/src/{task_repository,task_orchestration,task_runner,lib}.rs`,
  `wrangler.toml` (`TASK_RUNNER`).
- **Verify:** a stuck task no longer blocks the window; refund survives a
  simulated eviction; M5b: settle-latency parity, no double-poll, cron still
  catches unarmed tasks. Gate `TASK_RUNNER_DO_ENABLED`.
- **Rollback:** M5a is pure correctness (keep). M5b flag off → cron-only.

### M6 — `RealtimeSession` DO (3 wk) — Paradigm A
- **Status (2026-07-10): Gated substrate, per-response reservation recovery compiled.** The DO with WS
  hibernation (`accept_web_socket`, `websocket_message/close`, `serialize_attachment`)
  and persisted lifecycle metrics has landed (`crates/worker/src/realtime_session.rs`),
  with the `REALTIME_SESSIONS` binding + `new_sqlite_classes` active in all 3
  envs, gated `REALTIME_SESSION_V1_ENABLED=false`. The request-scoped connect
  handoff can now be turned into a Worker `Fetch::Request` WebSocket upgrade
  without persisting upstream secrets, and active DO instances now keep a
  transient upstream WebSocket registry for client-to-upstream forwarding plus
  upstream-to-client event pumping. A 1 MiB text/binary frame guard now rejects
  oversized bridge frames with WebSocket close code 1009, bridge close/error
  paths now have deterministic code/reason mapping, send failures in either
  bridge direction close both sockets with safe 1011 reasons, and sanitized
  terminal bridge events are emitted/persisted as metadata-only evidence. The
  Realtime smoke harness now has a platform frame-limit event mode that proves
  the 1009 close plus persisted `last_bridge_terminal_event` without a paid
  upstream call, a controlled mock startup queue/drain probe that observes one
  queued client frame before delayed upstream accept drains it, and controlled
  mock fault plans for event-stream failure and accept failure before a client
  probe is forwarded. The `response-done-usage` replay now seeds an isolated
  tiered billing expression in review-only D1 SQL and requires runtime status
  metrics to show both the redacted billing snapshot and the redacted
  settlement preview derived from the mock `response.done` usage frame. The
  internal settlement handoff now also carries a private mutation plan with
  user, token, channel, selected group, and pre-consumed quota identifiers so
  the next D1 settle step has the required scope without exposing those fields
  in attachments, status frames, metrics, smoke summaries, or the frontend
  capability panel. The DO can now also apply that private plan through the
  existing D1 reserve/refund/final helper when
  `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED=true`; the default-off writer
  records only redacted enabled/attempt/applied/skip/error status plus quota
  deltas in persisted metrics.
  Migration `0020_realtime_billing_reservation_leases.sql` now adds a D1 lease
  deadline for every active reservation. The DO persists lease work before the
  reservation becomes useful, coordinates the active-lease and settlement-retry
  collections through one earliest-deadline alarm, transfers ownership between
  those collections explicitly, and uses D1 CAS to refund expired work once.
  Refund failures remain durable and re-arm without a fixed retry cap; redacted
  status and the frontend capability panel expose only counts, deadlines,
  attempt totals, and the configured bounded lease duration.
  Migration `0021_realtime_billing_bridge_segments.sql` adds connection-scoped
  bridge ownership to every reservation. Response-created binding,
  response-done settlement, terminal refund, and lease transfer all require the
  same session plus bridge segment. A stale outbound close therefore cannot
  mutate reservations created by a replacement bridge using the same logical
  session; legacy attachments without segment metadata leave recovery to the
  persisted lease instead of issuing a broad session refund.
  **Remaining:** production bridge hardening (archived local/staging
  queue/drain/fault proof and full live protocol replay evidence), remote
  Worker-binding settlement replay, lease-not-due/expiry/eviction/D1-outage
  evidence, Go-formula reconciliation, and production lease calibration remain
  incomplete. Local SQL-shape, batch, lease, and staging-plan evidence cannot
  satisfy G7 by itself.
- **Planner landed:** OpenAI-compatible `/v1/realtime?model=...`, Azure
  `/openai/realtime?deployment=...&api-version=...`, and secret-redacted
  Realtime handshake summaries are compiled and exposed as a separate
  capability signal; the real upstream socket bridge remains off.
- **Connect contract landed:** the secret-bearing upstream WebSocket connect
  spec is now built as a non-serialized, request-scoped value for OpenAI
  Realtime subprotocol auth, OpenAI bearer-header auth, and Azure `api-key`
  auth. `/api/platform/capabilities` reports it separately from the still-false
  full upstream bridge.
- **Connect handoff landed:** `/v1/realtime` now passes the secret-bearing
  connect spec from the authenticated relay gateway to the Durable Object on
  the live request only. The DO persists only `upstream_connect_handoff=true`
  plus the redacted upstream plan; raw upstream keys, bearer headers, and
  `openai-insecure-api-key.<secret>` protocol values are not serialized into
  socket attachments, metrics, status frames, or control frames.
- **Fetch-upgrade adapter landed:** `RealtimeSession` can build a Worker-native
  outbound WebSocket upgrade request from the handoff, preserving OpenAI
  Realtime subprotocol auth, OpenAI bearer headers, and Azure `api-key` headers
  only on the transient request. This is intentionally separate from the
  still-false full upstream bridge signal.
- **Scope:** `/v1/realtime` WS relay. Client WS via `WebSocketPair::new` +
  `Response::from_websocket` (`websocket.rs:24-35`, `response.rs:86-89`); upstream
  OpenAI WS via `WebSocket::connect` (**confirmed present**, `websocket.rs:77`).
  Persist `RealtimeState` (session_id, token_id, model, accumulated
  `realtime_audio_{input,output}_tokens`) via `storage().put` +
  `serialize_attachment`. Settle on close with the **Go parity formula**
  (`source-token-estimation-parity.md:24,89-90`): request-time estimate = 0;
  input = `int(duration/60*100/0.06)`, output = `int(duration/60*200/0.24)`.
- **Honest hibernation semantics (§5.3):** the accepted client socket survives
  hibernation; the outbound `connect`ed upstream socket is a transient JS handle
  that does **not**. OpenAI Realtime is server-side stateful, so an evicted DO
  cannot resume the upstream — reconnect opens a fresh session. Hibernation
  therefore buys idle-*client* survival within an active bridge, **not**
  free resurrection of a long-idle session. If session-resume fidelity is
  required, escalate to the plan `§21.4` Container bridge with the DO for
  idle/accounting only (recorded per M0).
- **Files:** `crates/realtime/src/lib.rs` (new DO), `crates/worker/src/{lib,relay}.rs`,
  `wrangler.toml` (`REALTIME`).
- **Verify:** a session streams ≥30 min; usage accumulates and settles on close
  matching the Go formula; hibernation/reconnect behaves per the documented
  caveat. Gate `REALTIME_ENABLED`. This is **G7 territory** — the DO-vs-Container
  decision must be recorded (M0).
- **Rollback:** flag off → `/v1/realtime` returns the current structured 501.

### M7 — `AiGatewayRouter` (2 wk) — Paradigm C
- **Status (2026-07-06): Gated substrate, request builder wired.** The
  cutover decision ladder (`plan_ai_gateway_cutover`), gateway URL builders
  (`provider_gateway_url`/`rest_gateway_url`), model-author classifier, and 8 cutover
  guards have landed as pure, fully unit-tested logic (`crates/providers/src/ai_gateway.rs`,
  722 ln). Relay channel reads now also carry `channels.other_info` opt-in metadata
  via `RelayChannel::ai_gateway_opted_in()`. The Worker relay loop now builds Cloudflare
  AI Gateway REST requests for JSON attempts only when the runtime gate, route planner,
  provider-prefixed model, and channel opt-in all pass; retryable Gateway
  failures fall back through the same selected provider channel before the
  existing cross-channel retry loop sees the result. Both surfaces feed the admin readiness
  panel (`platform_gateway.rs:100-116`), gated
  `RELAY_AI_GATEWAY_ROUTER_ENABLED=false`. The key-URL coupling is **stricter** than the
  scope below (§L note 1). **Remaining:** live staging canary, AI Gateway log capture,
  and billing/usage evidence.
- **Scope:** Unified gateway URL resolution (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}`
  for AI-Gateway-supported providers; direct otherwise), extending the existing
  `AI_GATEWAY_ID` routing. Promote `plan_relay_attempts` to explicit
  **primary + `fallback_model`** config (the N-attempt loop already exists — this
  is labeling + a config field, not new control flow). Implement the **key-URL
  security coupling** (`resolve_api_key` → `is_user_credential`; honor a user
  `base_url` override only when the resolved key is the user's) — net-new, since
  no BYOK base_url override exists today. Usage still settles through the
  untouched `crates/billing` engine.
- **Current Cloudflare constraint:** do not implement this with the deprecated
  Universal Endpoint. The landed router uses `/compat` or provider-specific
  endpoint forms. Cloudflare Dynamic Routing remains a later option only after
  central billing can reconcile the actual selected provider and model.
- **Files:** `crates/ai-gateway/src/router.rs` (new), `crates/providers/src/ai_gateway.rs`,
  `crates/worker/src/relay.rs`.
- **Verify:** echo-upstream staging smoke (`verification.md:834-852`); fallback
  trigger and key-coupling unit tests over every key×url combination; providers
  AI Gateway can't proxy fall back to direct. Gate per-channel opt-in.
- **Rollback:** router defaults to today's direct/AI-binding paths.

### M8 — WFP dispatch namespace (2 wk, multi-tenant only) — Paradigm B

**2026-07-11 superseding status:** the older design notes in this subsection are
retained as history and must not be used as an operator procedure. Current M8 is
the authority-guarded table row above: central token auth, D1 selection, and
reserve precede `channels.other_info.wfp_worker`; the relay signs the 30-second
HMAC authority using a key derived from the platform-only master; the uploader
binds only `WFP_RELAY_AUTHORITY_KEY` into the tenant. The tenant verifies and
forwards only chat/responses/messages/ai-run; central settlement/refund and
audit follow. Admin dispatch is
status-only, JS fallback AI deploy is disabled, and
`WFP_RELAY_TRANSPORT_ENABLED` remains false pending strict Rust/Wasm
upload/readback, exact replay binding readback, and staging billing plus live
replay-race evidence. The local DO contract is not a cutover marker.
- **Status (2026-07-06): Gated substrate, binding still commented.** Dispatch routing
  (`dispatch_target_for_request`/`dispatch_request` over `dynamic_dispatcher().get().fetch_request`),
  credential/`x-cinatoken-*` header stripping, worker-name sanitization, preview-host +
  internal-path routing with an admin-auth gate, and a tenant-script SDK crate have
  landed (`crates/worker/src/platform_gateway.rs` 627 ln; `crates/wfp-tenant/src/lib.rs`
  814 ln), gated `WFP_DISPATCH_ENABLED=false`. **Remaining:** uncomment
  `[[dispatch_namespaces]]` (`wrangler.toml:67,162,262`; needs a paid WFP plan)
  and run an end-to-end tenant smoke.
- **Scope:** Add the `[dispatch_namespaces]` binding (absent today).
  `resolve_tenant()` by Host → `dynamic_dispatcher("DISPATCHER").get(tenant)?.fetch_request(req)`
  behind `dispatcher_available()`; default-tenant fallback = the in-gateway
  pipeline. A minimal tenant-script SDK crate reuses `crates/relay` + `crates/billing`
  compiled to a WFP script. Note the `0.5.0` no-args limitation (js_sys if
  per-tenant limits are needed).
- **Files:** `crates/tenant/src/lib.rs` (new SDK), `crates/gateway/src/router.rs`,
  `wrangler.toml` (`DISPATCHER`).
- **Verify:** a sample tenant script serves via dispatch on staging; single-tenant
  deploy is byte-for-byte unaffected (gate off). **Requires a paid Workers-for-
  Platforms plan** — the entire plan is fully functional without M8.
- **Rollback:** binding absent / gate off → 100% in-gateway pipeline.

---

## 5. Key design decisions (with the four open questions answered)

The draft's decision checklist, answered from the map:

1. **Enable WFP multi-tenancy?** → **Gated (M8 last).** The SDK supports it, but
   it needs a paid plan and appears in zero current docs. Build behind
   `dispatcher_available()`; ship everything else without it.
2. **QuotaCoordinator scope?** → **Tiered-expr traffic only, shadow-first.** Flat
   billing is post-paid and must not be converted to reserve-then-settle. All-token
   coverage is a later, separate decision after the 30-day shadow bake.
3. **Realtime in scope now?** → **Yes, gated, as M6 — with the honest hibernation
   caveat recorded.** The SDK supports it; the Go billing formula is known. Do not
   promise OpenAI session-resume across eviction.
4. **Route through Cloudflare AI Gateway?** → **Opt-in per channel (M7).** Keep the
   finer tiered billing; use AI Gateway for unified logs/cache/limiting where the
   provider supports it, direct otherwise.

Additional decisions forced by ground truth:
- **No DO-SQL** → all new DOs use key-value JSON records + `serialize_attachment`;
  admin visibility uses the KV-index sidecar pattern (`affinity.rs:631-728`) since
  DO namespaces are unlistable.
- **CAS stays the arbiter** for tasks → DO fast-path and cron coexist safely with
  zero new coordination.
- **Fix correctness before adding layers** (M5a before M5b).

### 5.3 The realtime hibernation caveat, stated plainly
cinaVibeSDK hibernates a DO whose *entire* state is client-owned and
reconstructable. OpenAI Realtime is not: the upstream holds authoritative,
non-serializable session state. So the Rust translation keeps Paradigm A's
structure (persistent `RealtimeState`, transient `upstream_ws`, reconnect-masks-
eviction) but is explicit that eviction **ends** the upstream session. This is the
one place the paradigm does not transfer 1:1, and the plan says so rather than
shipping a silent correctness gap.

---

## 6. Target Cloudflare resources (delta over live)

| Resource | Binding | Status |
|---|---|---|
| `[ai]` Workers AI | `AI` | **Live** |
| `LOG_QUEUE` consumer + DLQ | `LOG_QUEUE` | **Live** |
| Cron task poller (`* * * * *`) | — | **Live** (staging; prod gated by G8) |
| `ChannelAffinity` DO | `CHANNEL_AFFINITY` | **Live** (gated) |
| `QuotaCoordinator` DO | `QUOTA_COORD` | **Pending (M4)** — `new_sqlite_classes` |
| `TaskRunner` DO | `TASK_RUNNER` | **Alarm poll + status probe compiled, default-off** (`TASK_RUNNER_DO_ENABLED=false`; staging replay, rollback, and no-double-poll evidence pending) |
| `RealtimeSession` DO | `REALTIME_SESSIONS` | **Substrate live, gated** (binding + `new_sqlite_classes` active; `REALTIME_SESSION_V1_ENABLED=false`) |
| AI Gateway routing | `AI_GATEWAY_ID` var | **Forwarder wired, gated** (`RELAY_AI_GATEWAY_ROUTER_ENABLED=false`; channel opt-in required) |
| WFP dispatch namespace | `DISPATCHER` | **Dispatch code live, gated, capability-guarded**; tenant route/guard readiness is visible in `/api/platform/capabilities`, but `[[dispatch_namespaces]]` binding is still commented and paid-plan gated |

Each new DO adds a `[[durable_objects.bindings]]` + `[[migrations]] new_sqlite_classes`
entry in **all three** env scopes (dev/staging/prod), matching the affinity
precedent (`RealtimeSession` already follows this). No new cargo feature is required
(`durable`/`websocket` modules are unconditional in `0.5.0`).

---

## 7. Reconciliation with the existing plan

- **Supersedes `§21.4`** (which reassigned realtime WS to Containers): the pinned
  SDK supports DO WS hibernation directly, so M6 is DO-first; the Container path
  is retained only as the escalation for session-resume fidelity (§5.3).
- **Reconciles `§21.5`** (Workflows for task polling): M5 keeps the live cron +
  D1 CAS as the correctness spine and adds an optional DO alarm fast-path.
  Cloudflare Workflows remain a valid alternative to M5b; the CAS makes all three
  orchestrators mutually idempotent, so the choice is operational, not
  correctness-critical.
- **Extends `§21.2`** (atomic state → DO): QuotaCoordinator is the concrete
  landing for the "concurrency / breaker / index → Durable Object" mapping.
- **Slots into Phase 7 / Wave C–D** of the migration plan; does not alter the
  Phase 0–10 gate structure. Realtime and WFP stay behind G7/G8.
- **Affected runbooks** (update on landing, §21.9 convention):
  `production-readiness-matrices.md`, `cloudflare-production-config-checklist.md`,
  `verification.md`, `cutover-rollback-runbook.md`,
  `source-task-lifecycle-parity.md`.

---

## 8. Risks & mitigations (delta over the draft's table)

| Risk | Severity | Mitigation |
|---|---|---|
| No DO-SQL in `0.5.0` misread as "SQLite tables in DO" | High | This doc pins key-value-only; any true-SQL need forces an SDK upgrade (build-chain risk given the custom wasm-bindgen rebuild path) — out of scope |
| QuotaCoordinator changes flat-billing semantics | High | Scope to tiered-expr traffic; flat stays post-paid |
| Shadow migration double-charges during cutover | High | 3-stage flags, DO error → D1 fallback, 30-day zero-diff gate before write-cutover |
| Realtime eviction silently drops the upstream session | High | Documented caveat (§5.3); reconnect = fresh upstream; Container escalation available |
| Refund-after-CAS crash loses a refund (pre-existing) | Low/Med | Timeout/video/Suno failure refunds now use a CAS-winner marker inside D1 batch; staging replay and repair evidence still required |
| Task starvation via old stuck tasks at the bounded poll window | Low/Med | Timeout sweep now runs before normal Worker cron polling; staging replay still required |
| WFP paid-plan assumption | Med | `dispatcher_available()` gate; whole plan works single-tenant |
| DO-macro `&mut self`→`'static` reentrancy across `await` | Med | Design DO fields for reentrancy; single-threaded wasm limits, doesn't erase, the hazard |
| Dispatcher/AI-Gateway no-args in `0.5.0` | Low | js_sys reflection where per-tenant/3-arg options are needed (existing pattern) |

---

## 9. Sequencing

```
Foundation (parity-first, unlocks the rest)
  M0 docs (0.5d) → M1 RelayPipeline (1w) → M2 ProviderRegistry (1w) → M3 gateway seam (1w)
State layer (correctness-gated)
  M4 QuotaCoordinator shadow (2w build + 30d bake) ── promote read→write behind flags
  M5a task correctness (1w, keep) → M5b TaskRunner DO fast-path (1w, optional)
Platform leverage
  M7 AiGatewayRouter (2w) → M6 RealtimeSession (3w, G7)
Multi-tenant (last, paid-plan gated)
  M8 WFP dispatch (2w)
```

Critical path to first user-visible value: **M1→M2→M7** (better routing/fallback)
and **M5a** (task reliability) land before any DO bake completes. Realtime (M6)
and WFP (M8) are the long-pole, correctly last.

**Where we actually are (2026-07-06, see §L):** M2 is wired; M7 has a default-off
request builder in the relay loop; M6/M8 have landed as gated substrate (DO
hibernation, dispatch layer) but are **not yet on a hot path**. The highest-leverage
next increment is staging proof for M7 (real Gateway logs + unchanged billing), followed
by the M6 upstream bridge + settlement. M4 and the remaining M5 refund-batch /
TaskRunner evidence remain unblocked.

## 10. WFP authority replay boundary (2026-07-11)

The paid WFP path now applies the cinaVibeSDK one-time ticket idea at a durable,
platform-owned boundary:

1. The Rust gateway authenticates, selects the channel, reserves quota, and
   signs a short-lived exact-body authority with a worker-derived key.
2. The Rust/Wasm tenant verifies that authority locally.
3. Before AI Gateway egress, the tenant calls the externally bound
   `WfpAuthorityReplay` namespace.
4. The DO verifies the master signature, recomputes the canonical
   worker/issuance-bucket object ID, and atomically stores a hash of the request
   ID. Duplicate is `409`; verifier/storage/binding failure is fail-closed.
5. The response returns to the gateway for central settlement/refund and audit.

This direct DO binding is acceptable only because tenant artifacts are strict,
platform-built Rust/Wasm modules. If arbitrary customer code becomes eligible
for the same namespace, replace direct namespace access with a platform service
binding that selects the DO shard internally. The current guard prevents reuse
of one signed envelope; it does not deduplicate a relay retry that deliberately
creates a fresh signed request ID. The worker/minute shard also needs staging
load evidence before its throughput assumptions are accepted.
