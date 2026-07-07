# Layered Gateway Architecture — Implementation Scheme

> **Status:** Partially implemented · updated 2026-07-06 — the provider registry
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
4. **Primary+fallback routing already exists** as an N-attempt planned loop —
   the AI-Gateway "multi-model" paradigm is mostly *configuration + labeling*
   over `plan_relay_attempts`, not new machinery.
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

| Pillar / milestone | Paradigm | Maturity | What landed | What remains | Evidence |
|---|---|---|---|---|---|
| M2 Provider registry | — | **Wired** | `ProviderRegistry::resolve` drives per-endpoint provider routing on the live relay path | Fold remaining private-enum branches into adapters | `crates/providers/src/routing.rs:77-80`; called at `crates/worker/src/relay.rs:194` |
| M7 AiGateway router | C | **Gated substrate (fallback wired)** | Full cutover **decision ladder** + security coupling, gateway **URL builders**, model-author classifier, 8 cutover guards, `channels.other_info` opt-in metadata support, default-off REST forwarder, same-channel direct fallback, admin readiness panel | Live staging canary, AI Gateway log capture, and billing/usage evidence | `crates/providers/src/ai_gateway.rs` (722 ln): `plan_ai_gateway_cutover:190`, `rest_gateway_endpoint_url:353`, guards `:89-98`; `crates/storage/src/lib.rs` opt-in parser; `crates/worker/src/relay.rs` runtime/forwarder/fallback; gate `RELAY_AI_GATEWAY_ROUTER_ENABLED` + readiness `platform_gateway.rs:100-116` |
| M8 WFP dispatch | B | **Gated substrate (capability guarded)** | `dispatch_target_for_request` + `dispatch_request` via `dynamic_dispatcher().get().fetch_request`, credential/marker **header stripping**, worker-name sanitization, preview-host + internal-path routing, admin-auth gate, tenant-script SDK crate, tenant route/guard capability surface, tenant response-header allowlist, AI Gateway policy contract, and dispatch smoke response-header/capability guard | Uncomment `[[dispatch_namespaces]]` binding (needs paid WFP plan); end-to-end tenant smoke with uploaded Rust/Wasm artifact and archived capability preflight | `crates/worker/src/platform_gateway.rs`: dispatch + header strip + capability readiness; `crates/worker/src/wfp_tenant.rs`: tenant script plan/route/guard helpers; `crates/wfp-tenant/src/lib.rs`: tenant runtime/allowlist; `tools/smoke_wfp_dispatch.mjs`: dispatch, capability preflight, and response-header guard; binding commented `wrangler.toml:67,162,262`; gates `WFP_DISPATCH_ENABLED`/`WFP_INTERNAL_DISPATCH_ENABLED` |
| M6 RealtimeSession | A | **Gated substrate (event trace compiled)** | `#[durable_object]` with WS **hibernation** (`accept_web_socket`, `websocket_message/close`, `serialize_attachment`), per-socket `SocketAttachment`, lifecycle metrics persisted to DO storage, upstream URL/handshake planner, `/v1/realtime` D1/cache channel selection with secret-redacted plan summaries in socket attachments, request-scoped upstream connect specs, gateway-to-DO secret handoff with no raw key persistence, Worker-native upstream fetch-upgrade adapter, an in-memory upstream bridge registry that forwards client frames while active and reports `upstream_bridge_not_active` after hibernation/restart, 1 MiB text/binary frame guards with 1009 close handling, deterministic bridge close/error code mapping, fail-closed cleanup when either bridge direction cannot enqueue a frame, a bounded backpressure policy plus transient FIFO client-to-upstream queue before upstream accept, metadata-only overflow events, WebSocket and HTTP status counters for active upstream bridges plus queued frames/bytes, sanitized terminal event trace metadata for close/error/frame-limit/send-failure paths, smoke-level bridge/upstream replay contract self-tests, and a mock upstream replay harness with review-only D1 seed SQL, active/empty-queue runtime-status proof, controlled startup queue/drain, and early `event_stream_failed`/`accept_failed` fault plans before live probes | Production-grade bridge hardening: archived local/staging queue/drain/fault evidence, remaining upstream abort/error and upstream-to-client send-failure replay, **usage accumulation + Go-formula settle** (none yet), protocol parity | `crates/worker/src/realtime_session.rs`: DO + planners/handoff/fetch-upgrade adapter/transient lifecycle/frame guard/close mapping/send-failure/backpressure guard/runtime queue/event trace/startup queue probe/mock fault handoff; `tools/smoke_realtime_session.mjs`: platform/frame-limit/replay-contract smoke; `tools/smoke_realtime_upstream_replay.mjs`: mock upstream replay + D1 seed plan/runtime-status/fault proof; `crates/worker/src/relay.rs`: Realtime channel selection helper; binding **active** `wrangler.toml:117,216,317`; gates `REALTIME_SESSION_V1_ENABLED`/`REALTIME_SESSION_GATEWAY_ENABLED` |
| M4 QuotaCoordinator | — | **Pending** | — | Build the shadow-first per-token DO (§4 M4) | no `crates/coordinator` yet |
| M5 Task correctness / TaskRunner | — | **Partial (timeout sweep + refund replay contract wired)** | Scheduled Worker poller now runs a Go-compatible timeout sweep before provider polling, uses per-task CAS for timeout failure, preserves the legacy imported-task no-refund cutoff, hardens malformed `private_data` during task CAS updates, batches timeout/video/Suno failure refunds behind a CAS-winner marker, normalizes Suno fail-reason rows to terminal failure, locally replays no-duplicate-refund/legacy/stale-window semantics with `bun run check:task-refund-batch`, and exposes task-poller config/refund-batch/replay-contract readiness in `/api/platform/capabilities` plus the admin frontend | Finish staging timeout/refund replay, provider failure replay, then optional `TaskRunner` DO | `crates/worker/src/task_repository.rs`: timed-out query/CAS timeout apply/refund marker batch; `crates/worker/src/task_orchestration.rs`: config + sweep before provider poll; `crates/worker/src/lib.rs`: scheduled handler; `tools/smoke_task_refund_batch.mjs`: local replay contract; `platform_gateway.rs` + frontend Cloudflare Platform panel: capability surface |

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
- **Scope:** Add a `route()` dispatcher **inside the existing `#[event(fetch)]`
  router** (not a big-bang new crate): run `authenticate_edge` once, then branch —
  realtime WS → DO; async submit → task path; tenant Host → WFP (M8); default →
  pipeline. Feature-gate the new dispatch order (`GATEWAY_ROUTER_ENABLED`) so the
  legacy router remains the fallback.
- **Files:** `crates/gateway/src/{router,auth_edge}.rs` (new, thin), `crates/worker/src/lib.rs`.
- **Verify:** golden route table unchanged (`check:web:routes` SHA-256 digest);
  auth-cache hit/miss parity.
- **Rollback:** clear the flag → legacy router.

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
- **M5b (optional fast path):** Arm a per-task `TaskRunner` DO alarm at submit
  (`0.5.0` `storage().set_alarm`, `durable.rs:442`) for sub-60s settle latency
  and per-task backoff; the **cron becomes sweeper-of-last-resort**
  (`find_unfinished_tasks` gains `WHERE updated_at < now - grace`). The existing
  CAS arbitrates — whichever path polls second is a no-op. Reuse `poll_one_task`
  (`task_orchestration.rs:1245-1314`) verbatim; the pure parsers in `crates/tasks`
  are untouched.
- **Files:** `crates/worker/src/{task_repository,task_orchestration,lib}.rs`,
  `crates/task-runner/src/lib.rs` (M5b, new), `wrangler.toml` (`TASK_RUNNER`).
- **Verify:** a stuck task no longer blocks the window; refund survives a
  simulated eviction; M5b: settle-latency parity, no double-poll, cron still
  catches unarmed tasks. Gate `TASK_RUNNER_DO_ENABLED`.
- **Rollback:** M5a is pure correctness (keep). M5b flag off → cron-only.

### M6 — `RealtimeSession` DO (3 wk) — Paradigm A
- **Status (2026-07-06): Gated substrate, upstream event trace compiled.** The DO with WS
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
  probe is forwarded.
  **Remaining:** production bridge hardening (archived local/staging
  queue/drain/fault proof and full live protocol replay evidence), usage
  accumulation, and the Go-formula settlement below remains unimplemented.
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
- **Files:** `crates/ai-gateway/src/router.rs` (new), `crates/providers/src/ai_gateway.rs`,
  `crates/worker/src/relay.rs`.
- **Verify:** echo-upstream staging smoke (`verification.md:834-852`); fallback
  trigger and key-coupling unit tests over every key×url combination; providers
  AI Gateway can't proxy fall back to direct. Gate per-channel opt-in.
- **Rollback:** router defaults to today's direct/AI-binding paths.

### M8 — WFP dispatch namespace (2 wk, multi-tenant only) — Paradigm B
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
| `TaskRunner` DO | `TASK_RUNNER` | **Pending (M5b)** |
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
