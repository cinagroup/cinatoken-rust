# cinaVibeSDK Production Migration Mapping

Date: 2026-07-06

Status: production migration mapping for applying cinaVibeSDK architecture
patterns to `cinatoken-rust`. This is a docs-only supplement. It does not
change Rust or TypeScript code.

## Scope

This document turns the cinaVibeSDK patterns into an operator-facing migration
contract for `cinatoken-rust`:

- Rust scheduling gateway at the edge.
- Rust Durable Object long-session ownership for realtime sessions.
- Workers for Platforms Rust tenant scripts for isolated tenant execution.
- Cloudflare AI Gateway forwarding for supported relay and tenant routes.

It complements:

- `docs/cinatoken-rust-migration-plan.md`
- `docs/layered-gateway-architecture.md`
- `docs/production-readiness-matrices.md`

Where this document discusses implementation status, it follows the current
docs: the layered gateway substrate is partially implemented and gated, but
production cutover still requires live staging evidence.

## Inputs Reviewed

`cinatoken-rust` docs:

- `docs/cinatoken-rust-migration-plan.md`
- `docs/layered-gateway-architecture.md`
- `docs/production-readiness-matrices.md`
- supporting smoke/config evidence in `docs/staging-smoke-runbook.md`,
  `docs/cloudflare-production-config-checklist.md`, and `docs/verification.md`

Readable cinaVibeSDK references:

- `C:\cinagroup\cinavibesdk\docs\architecture-diagrams.md`
- `C:\cinagroup\cinavibesdk\worker\index.ts`
- `C:\cinagroup\cinavibesdk\worker\utils\dispatcherUtils.ts`
- `C:\cinagroup\cinavibesdk\worker\agents\core\codingAgent.ts`
- `C:\cinagroup\cinavibesdk\worker\agents\inferutils\config.ts`
- `C:\cinagroup\cinavibesdk\worker\agents\inferutils\core.ts`
- `C:\cinagroup\cinavibesdk\worker\services\aigateway-proxy\controller.ts`

## Target Production Shape

`cinatoken-rust` should use cinaVibeSDK's topology as a pattern, translated to
Rust and to cinatoken's relay, billing, and admin semantics:

```text
Client / Admin / Tenant host
        |
Cloudflare WAF / CDN / rate controls
        |
Rust scheduling gateway
  - route classification
  - relay token or admin auth
  - tenant dispatch decision
  - realtime dispatch decision
  - AI Gateway cutover decision
        |
        +--> Main Rust relay pipeline
        |     - direct provider path
        |     - optional Cloudflare AI Gateway REST path
        |     - same-channel direct fallback
        |     - existing billing and audit settlement
        |
        +--> RealtimeSession Durable Object
        |     - hibernatable client WebSocket
        |     - redacted upstream plan in attachments/status
        |     - request-scoped upstream secret handoff only
        |     - usage accumulation and settlement before v1 cutover
        |
        +--> WFP DISPATCHER namespace
              - Rust/Wasm tenant script
              - internal-path-only AI routes
              - sanitized inbound headers
              - route-specific AI Gateway policy
```

Persistent state remains split by responsibility:

- D1 remains the production source of truth for users, tokens, channels,
  options, logs, billing rows, and task rows until a specific row is migrated.
- KV and Upstash remain cache, rate-limit, and short-lived coordination layers.
- Durable Objects own session-local or concurrency-sensitive state only.
- Queues and R2 remain audit/log/artifact escape hatches for large or async
  writes.

## cinaVibeSDK Pattern Mapping

### 1. Scheduling Gateway

cinaVibeSDK pattern:

- `worker/index.ts` first classifies the host and path.
- Main-domain requests go to static assets, API routes, Git/OAuth handlers, or
  the AI proxy.
- User-app subdomain requests try live sandbox first and then fall back to
  `DISPATCHER.get(appName).fetch(request)`.
- `isDispatcherAvailable(env)` makes Workers for Platforms a runtime capability,
  not a hard dependency.

`cinatoken-rust` mapping:

- Keep one Rust scheduling gateway in the Worker fetch path.
- Run edge auth once for relay/admin paths, then dispatch to the correct owner:
  main relay, realtime DO, WFP tenant script, or admin platform probe.
- Preserve OpenAI-compatible route paths and response shapes. The gateway is a
  router, not a compatibility-breaking API facade.
- Treat WFP as optional and paid-plan-gated. When `DISPATCHER` is absent or
  `WFP_DISPATCH_ENABLED=false`, the default route remains the in-gateway relay.
- Strip credential and `x-cinatoken-*` control headers before tenant dispatch;
  add only controlled dispatch markers such as route and worker identity.

Production rule:

The scheduling gateway can be enabled before WFP and realtime production
ownership only if all new branches are default-off and the legacy relay path is
unchanged for non-canary traffic.

### 2. Durable Object Long Sessions

cinaVibeSDK pattern:

- `CodeGeneratorAgent` is a Durable Object style long-session owner.
- It persists project and conversation state, rebuilds transient service
  handles in `onStart`, and owns WebSocket connection lifecycle through
  `onConnect`, `onMessage`, and `onClose`.
- It separates durable state from transient secrets and runtime handles.

`cinatoken-rust` mapping:

- `RealtimeSession` is the Rust Durable Object equivalent for `/v1/realtime`.
- The DO owns the accepted client WebSocket and stores only safe session
  metadata, attachments, lifecycle metrics, and redacted upstream summaries.
- Upstream API keys, bearer values, Azure `api-key`, and insecure realtime
  subprotocol secrets stay request-scoped. They must not be serialized into DO
  storage, socket attachments, status frames, logs, or metrics.
- Hibernation is useful for the accepted client socket, but not a promise that
  an upstream OpenAI Realtime session can be resumed after eviction. The
  upstream bridge is transient and must be rebuilt or closed deliberately.

Current mapped status from existing docs:

- `REALTIME_SESSIONS` binding and the Rust DO substrate are present.
- `/v1/realtime` is default-off behind `REALTIME_SESSION_V1_ENABLED`.
- Planner, channel selection, connect contract, secret handoff, the
  Worker-native fetch-upgrade adapter, and the transient bridge lifecycle are
  compiled. The transient bridge also has a 1 MiB text/binary frame guard with
  1009 close handling, deterministic close/error code mapping, and fail-closed
  cleanup when either forwarding direction cannot enqueue a frame. Sanitized
  terminal bridge event trace metadata is now available through live bridge
  event frames and persisted session metrics. The smoke harness can prove the
  platform frame-limit terminal event path without a paid upstream call, model
  ordered upstream replay evidence through a local contract self-test, and
  generate review-only D1 seed SQL for a local/staging mock upstream replay
  channel/token setup. A bounded backpressure policy contract is also compiled:
  32 pending frames / 4 MiB pending bytes, fail-closed
  `backpressure_overflow`, and metadata-only overflow events. The transient
  bridge runtime now uses that policy for an in-memory FIFO client-to-upstream
  queue before upstream accept and exposes aggregate queued frame/byte status
  through both HTTP status and WebSocket `status` control frames. The mock
  upstream replay harness now records active/empty-queue runtime status before
  sending ordinary live probe frames and has a `startup-queue-drain` scenario
  that uses explicit mock-channel `queue_probe_delay_ms` metadata to observe
  one queued frame before delayed upstream accept drains it to the mock. It also
  has review-only mock fault plans for `event_stream_failed` and
  `accept_failed`, triggered only by explicit mock-channel
  `realtime_mock_upstream.fault` metadata and expected to close before any
  client probe is forwarded.
- Production-grade bridge hardening and realtime billing settlement are still
  blockers. `realtime_session_v1_cutover_ready` must remain false until live
  queue/drain/fault artifacts are archived from local/staging, live close/error
  replay including upstream abort/error and upstream-to-client send failure,
  live mock/real upstream replay artifacts, and settlement are proven.

Production rule:

Do not route production `/v1/realtime` traffic to the DO until live staging
proves upstream bridge behavior, bounded backpressure, error/close mapping,
attachment restoration, no-echo control frames, usage accumulation, and
settlement parity.

### 3. WFP Rust Tenant Scripts

cinaVibeSDK pattern:

- User app subdomains are isolated behind a dispatch namespace.
- The platform checks `DISPATCHER` availability and then invokes
  `DISPATCHER.get(appName).fetch(request)`.
- Dispatch is a deployment/runtime boundary for user-generated applications.

`cinatoken-rust` mapping:

- Keep the main relay as the default single-tenant path.
- Use `DISPATCHER` only for explicit tenant hosts or admin-authenticated
  internal dispatch routes.
- The tenant runtime target is Rust/Wasm through the `cinatoken-wfp-tenant`
  crate, not a JS fallback for production.
- Tenant scripts may support AI routes, but only through controlled
  internal-path dispatch. Preview-host public AI routes should reject or stay
  disabled unless explicitly approved.
- Inbound sensitive headers must be empty from the tenant's point of view.
- Tenant responses must pass through a safe response-header allowlist so auth,
  cookies, `cf-aig-*`, upstream transfer metadata, and upstream platform
  headers are not leaked.
- `/api/platform/capabilities` exposes the WFP tenant route manifest, cutover
  guards, tenant script plan, Rust/Wasm artifact plan, internal dispatch
  requirement, response-header guard, AI Gateway request policy contract, and
  `wfp_tenant_smoke_ready` so the admin frontend can distinguish compiled
  substrate from live dispatch readiness.
- Dispatch smoke must enforce that allowlist on both tenant status and opt-in
  AI route responses, failing on auth/cookie, `cf-aig-*`, and non-WFP
  `x-cinatoken-*` leakage while recording Cloudflare edge envelope headers
  separately. Live smoke preflights the capabilities guard surface by default.

Current mapped status from existing docs:

- WFP dispatch code and smoke harnesses exist, but the `DISPATCHER` binding is
  still commented and paid-plan-gated.
- `crates/wfp-tenant` is compile-ready and has local checks.
- The Cloudflare Platform frontend panel now shows WFP tenant route/guard and
  smoke-readiness signals from `/api/platform/capabilities`; those signals do
  not replace archived staging smoke.
- Production proof still needs an uploaded Rust/Wasm tenant artifact, a real
  dispatch namespace, internal-path status smoke, and at least one POST AI route
  smoke.

Production rule:

WFP cutover is last-mile multi-tenant enablement. It must not become a
dependency for the first single-tenant relay production cutover.

### 4. AI Gateway Forwarding

cinaVibeSDK pattern:

- Agent actions are configured with primary and fallback models.
- `buildGatewayUrl` centralizes AI Gateway URL construction.
- `getConfigurationForModel` couples base URL selection to key ownership.
- `cf-aig-metadata` is attached for Cloudflare AI Gateway observability.
- The app proxy authenticates the caller, checks ownership, rate-limits the
  request, forwards to the chosen AI Gateway/provider URL, and allowlists
  response headers.

`cinatoken-rust` mapping:

- Use `ProviderRegistry` and AI Gateway route planners to decide route family,
  provider Gateway path, model-prefix policy, and whether a request is eligible.
- Keep channel-level opt-in through `channels.other_info.ai_gateway.enabled`.
- Keep the global gate `RELAY_AI_GATEWAY_ROUTER_ENABLED=false` until a canary
  window is approved.
- Require `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and a scoped Gateway token
  before any main-relay AI Gateway forwarding can run.
- Preserve stricter cinatoken-rust security: custom channel base URLs route
  direct rather than through the shared platform Gateway, even when a user
  credential is present.
- On retryable AI Gateway failure, fall back through the same selected provider
  channel before cross-channel retry logic sees the result.
- Billing and usage parsing remain the main relay's responsibility. AI Gateway
  is transport and observability, not a billing replacement.

Production rule:

No AI Gateway canary is production-valid unless Gateway logs and relay
audit/billing logs prove the same model, usage, quota delta, channel accounting,
and fallback behavior as the direct path.

## Route Ownership Matrix

| Route or traffic family | Production owner | cinaVibeSDK pattern used | Main gates | Required evidence |
| --- | --- | --- | --- | --- |
| `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings` | Main Rust relay | AI Gateway primary/fallback forwarding | `RELAY_AI_GATEWAY_ROUTER_ENABLED`, per-channel opt-in | Direct and AI Gateway canary, same-channel fallback, unchanged settlement |
| `/v1/realtime` | `RealtimeSession` DO after G7 proof | DO long-session owner | `REALTIME_SESSION_V1_ENABLED` | Transient bridge lifecycle, frame guard, close/error mapping, send-failure cleanup, terminal event trace, upstream replay contract, backpressure policy plus runtime FIFO queue, controlled mock startup queue/drain and early fault plans, archived staging evidence, billing settlement, live protocol replay |
| `/api/platform/realtime/:session...` | Platform smoke gateway | DO smoke/control surface | `REALTIME_SESSION_GATEWAY_ENABLED` | Status frame, persisted metrics, attachment restore, no-echo control probe, forged internal upstream header boundary smoke |
| Tenant preview or internal dispatch hosts | WFP `DISPATCHER` | User-app dispatch boundary | `WFP_DISPATCH_ENABLED`, `WFP_INTERNAL_DISPATCH_ENABLED` | Capability preflight with tenant route/guard contract, Rust/Wasm runtime status, sanitized inbound headers, route markers, 401/403 negative tests |
| Tenant AI routes | WFP Rust tenant script plus AI Gateway | Dispatch plus AI Gateway proxy | Real `DISPATCHER`, tenant Gateway vars | Capability preflight, route-specific Gateway logs, request policy headers, response-header allowlist |
| Admin platform readiness | Main Rust Worker | Capability probe | Admin session | `/api/platform/capabilities` matches bindings, gates, WFP tenant route/guard contracts, and smoke readiness |

## Migration Stages

### Stage 0: Freeze the contract

Keep the layered gateway document as the implementation plan and this document
as the production mapping contract. Update production matrices only when a
route, binding, flag, or readiness signal changes.

Exit evidence:

- This document is present under `docs/`.
- Operators can identify the owner, flag, evidence, and rollback path for each
  of the four cinaVibeSDK-derived pillars.

### Stage 1: Scheduling gateway capability visibility

Expose and verify read-only platform capabilities before routing production
traffic through new branches.

Required evidence:

- Admin-only `/api/platform/capabilities` shows Workers AI, AI Gateway, DO, WFP,
  and realtime signals.
- `WFP_DISPATCH_ENABLED`, `WFP_INTERNAL_DISPATCH_ENABLED`,
  `REALTIME_SESSION_GATEWAY_ENABLED`, `REALTIME_SESSION_V1_ENABLED`, and
  `RELAY_AI_GATEWAY_ROUTER_ENABLED` are visibly default-off outside canary.

Rollback:

- Clear the relevant env flag and keep the legacy relay path.

### Stage 2: Main relay AI Gateway canary

Canary only one or a small number of opted-in channels.

Required evidence:

- Channel editor or admin mutation writes normalized
  `other_info.ai_gateway.enabled=true`.
- Dry-run and live `smoke_relay_ai_gateway_canary` evidence are captured.
- AI Gateway logs show expected provider route and metadata.
- Relay audit and billing rows match direct-provider settlement.
- Retryable Gateway failure falls back through the same channel direct path.

Rollback:

- Disable channel opt-in or set `RELAY_AI_GATEWAY_ROUTER_ENABLED=false`.

### Stage 3: Realtime platform DO smoke

Prove the Durable Object substrate independently of production `/v1/realtime`.

Required evidence:

- `REALTIME_SESSIONS` binding is real in staging.
- `REALTIME_SESSION_GATEWAY_ENABLED=true` only for the smoke window.
- Smoke captures status frame, persisted lifecycle metrics, restored socket
  attachments, and no-echo unsupported control behavior.

Rollback:

- Set `REALTIME_SESSION_GATEWAY_ENABLED=false`; no relay route ownership changes.

### Stage 4: Realtime v1 bridge and settlement canary

Only after Stage 3, wire actual upstream bridge and billing.

Required evidence:

- `/v1/realtime` performs token auth, model/IP/quota checks, rate limits, channel
  selection, and redacted DO plan construction before session creation.
- Upstream WebSocket bridge is live with bounded queues and mapped close/error
  behavior.
- Usage accumulation and Go-compatible settlement are recorded.
- `realtime_session_v1_cutover_ready=true` is justified by live evidence, not
  just local tests.

Rollback:

- Set `REALTIME_SESSION_V1_ENABLED=false`; leave platform smoke gate available
  for diagnostics.

### Stage 5: WFP Rust tenant runtime

Enable WFP only after the paid-plan binding and a Rust/Wasm tenant artifact are
available.

Required evidence:

- Real `DISPATCHER` binding and dispatch namespace.
- Uploaded `cinatoken-wfp-tenant` Rust/Wasm artifact.
- Internal dispatch status smoke shows `runtime: "rust-wasm"`,
  `x-cinatoken-wfp-runtime: rust-wasm`, empty inbound sensitive headers,
  controlled route markers, and matching worker identity.
- Unauthenticated internal dispatch returns 401 or 403.

Rollback:

- Set `WFP_DISPATCH_ENABLED=false` and route tenants back to the default
  in-gateway path or disabled response.

### Stage 6: WFP tenant AI Gateway route canary

Canary only tenant routes that have explicit Gateway ownership.

Required evidence:

- Route-specific Gateway ID or documented default Gateway selection.
- Valid tenant-controlled request policy headers, such as timeout, retry, cache,
  and log collection controls.
- Gateway logs contain tenant metadata without raw credentials.
- Response headers exclude auth, cookies, `cf-aig-*`, transfer, and platform
  internal headers.

Rollback:

- Disable the tenant AI route or route-specific Gateway binding without touching
  the main relay.

### Stage 7: Production canary and cutover

Promote only the routes whose stage evidence is complete.

Required evidence:

- G7 canary report includes route owner, flag values, smoke logs, Gateway logs,
  billing reconciliation, and rollback rehearsal.
- G8 cutover checklist explicitly lists which cinaVibeSDK-derived pillars are
  in production and which remain gated.

Rollback:

- Prefer flag rollback first. DNS or route rollback is reserved for broad
  Worker failures.

## Security Boundaries

The following boundaries are mandatory:

- User API tokens authenticate the main gateway. They are not forwarded to WFP
  tenant scripts.
- WFP tenant scripts receive sanitized requests plus controlled dispatch
  markers only.
- AI Gateway platform tokens are never paired with caller-controlled base URLs.
- Upstream realtime secrets remain request-scoped and are not persisted in DO
  storage or WebSocket attachments.
- `cf-aig-metadata` may contain route, tenant, user, app, model, and request
  fingerprints, but never raw keys, bearer tokens, OAuth codes, payment secrets,
  or full provider credentials.
- Tenant response headers are allowlisted.
- Admin capability probes are read-only and admin-authenticated.

## Billing And Quota Boundaries

The cinaVibeSDK patterns must not weaken cinatoken billing:

- AI Gateway forwarding keeps the existing relay billing engine authoritative.
- Direct fallback after Gateway failure must not double-settle usage.
- Realtime production ownership requires usage accumulation, refund behavior,
  final settlement, and audit rows before `REALTIME_SESSION_V1_ENABLED` can be
  used outside a canary.
- Async video/Suno/Midjourney production ownership now has a Worker cron
  timeout sweep before normal provider polling and a CAS-winner refund batch for
  timeout/video/Suno failure refunds. The local
  `bun run check:task-refund-batch` replay now proves no-duplicate-refund,
  legacy no-refund, and stale-window unblock semantics before staging, but the
  cron still requires staging timeout/provider-failure/no-duplicate-refund
  replay before it can be treated as eviction-proof billing infrastructure.
- WFP tenant AI routes must either call back through an owned billing path or
  produce equivalent audit and settlement evidence before paid traffic is routed
  there.
- Flat-billed and tiered-expression traffic keep their current semantics; do
  not convert flat traffic to pre-reserve semantics as part of this mapping.

## Operational Readiness Checklist

Before enabling any pillar in staging:

- Flag is explicit and default-off in non-canary environments.
- Binding is present and visible in `/api/platform/capabilities`.
- Smoke script has both dry-run and live evidence.
- Logs redact secrets and preserve request IDs.
- Rollback is a flag or channel metadata change.

Before enabling production traffic:

- Live staging smoke exists for the exact route family.
- Billing and audit reconciliation exists for paid routes.
- Negative tests cover unauthorized, disabled, missing binding, and fallback
  paths.
- Production readiness matrix row is updated conservatively. Local tests alone
  are not enough for `Done`.

## Current Production Blockers

As of the docs reviewed on 2026-07-06:

- Main relay AI Gateway forwarding is wired as gated substrate, but still needs
  live staging canary evidence and billing log comparison before cutover.
- Realtime DO has the session substrate, planners, connect contract,
  gateway-to-DO handoff, outbound fetch-upgrade adapter, and transient bridge
  lifecycle/frame guard/close mapping/send-failure cleanup plus terminal event
  trace metadata plus smoke-level bridge replay, ordered upstream replay, and
  platform header-boundary contract self-tests. It now has a controlled mock
  startup queue/drain probe, but still lacks archived staging queue/drain
  artifacts, full live fault replay, and billing settlement required for
  production `/v1/realtime`.
- WFP dispatch has code, local Rust/Wasm tenant checks, and a tool-enforced
  response-header smoke guard, but still needs a real paid-plan `DISPATCHER`
  binding, uploaded tenant artifact, and live internal dispatch smoke.
- The first production cutover should not depend on WFP. Keep WFP as a later
  multi-tenant extension.

## Definition Of Done

This migration mapping is production-ready when each enabled pillar has:

- a named route owner;
- a default-off flag or explicit channel/tenant opt-in;
- a live staging smoke artifact;
- redaction evidence;
- billing or no-billing justification;
- rollback evidence;
- a conservative row in `docs/production-readiness-matrices.md`.

Until then, the correct production posture is "compiled and gated", not
"cutover-ready".
