# cinaVibeSDK Production Migration Mapping

Date: 2026-07-12

Latest evidence increment: 2026-07-11

Status: production migration mapping for applying cinaVibeSDK architecture
patterns to `cinatoken-rust`.

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

Architecture provenance correction (2026-07-12): the reviewed cinaVibeSDK
commit `918e974` contains no Rust crate or Cargo manifest. Its authoritative
implementation is TypeScript Workers plus the Agents SDK. `cinatoken-rust`
reuses the routing, hibernation, dispatch-namespace, and AI Gateway topology,
then implements that topology with a Rust scheduling planner, Rust Durable
Objects, and a Rust/Wasm WFP tenant. Do not describe those Rust components as
source copied from cinaVibeSDK.

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
- Workers Rate Limiting bindings own relay admission. KV and optional Upstash
  remain cache and short-lived coordination layers; Upstash is not a required
  rate-limit hop on the tracked hot path.
- Durable Objects own session-local or concurrency-sensitive state only.
- Queues and R2 remain audit/log/artifact escape hatches for large or async
  writes.

## Evidence Increment: 2026-07-11 Scheduling Gateway Ownership

- The live fetch path now uses the pure `cinatoken-gateway` owner planner before
  invoking provider-native relay, WFP, RealtimeSession, static assets, or the
  compatibility Router. Route order is a versioned contract rather than an
  incidental sequence of Worker `if` statements.
- Tenant preview-host ownership is resolved before central provider/API routes.
  A preview suffix root, invalid nested host, or disabled tenant host never
  falls through to the main SPA; it returns `wfp_preview_unavailable` instead.
  This applies cinaVibeSDK's explicit rule that user-app handling does not fall
  back to the main Worker.
- Realtime session recognition and static/API classification moved behind the
  same pure boundary. `/api/platform/realtime/settlement-batch/smoke` remains
  owned by the platform control router rather than the session DO.
- The admin capability API and frontend cockpit expose the owner-contract
  version and precedence as implementation evidence only.

Latest Cloudflare documentation was rechecked for this increment:

- A dynamic dispatch Worker is the entry point that selects a User Worker via
  a dispatch namespace; tenant Workers should share an environment namespace,
  with a separate namespace for staging.
- WebSocket hibernation applies when a DO acts as the WebSocket server. An
  active outbound WebSocket prevents hibernation, so the upstream Realtime
  connection remains transient and cannot be advertised as sleep-resumable.
- AI Gateway's Universal Endpoint is deprecated. New work must use the
  OpenAI-compatible endpoint and provider-specific endpoints, with Dynamic
  Routing considered only after central billing can reconcile the selected
  provider/model.

References:

- <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/>
- <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- <https://developers.cloudflare.com/ai-gateway/usage/universal/>

### WFP dispatched-fetch failure refinement

cinaVibeSDK wraps dispatcher lookup and `worker.fetch()` together and never
falls back from a user-app host to the platform Worker. Cloudflare's current
dynamic-dispatch examples additionally identify `Worker not found` as the
stable missing-script signal around the dispatch call. The Rust implementation
now combines those ideas with central-relay semantics:

- preview/internal missing scripts return structured 404;
- a missing WFP worker selected as a paid relay backend returns 502 so the
  OpenAI-compatible relay does not misrepresent a backend outage as a missing
  client route;
- CPU/subrequest limit failures return 429 and other tenant execution failures
  return 502;
- raw tenant exception messages are not logged or returned, all platform WFP
  failures are `no-store`, and no case falls back to the main application;
- the negative smoke contract is executable locally and in staging.

Reference: <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/>.

## Evidence Increment: 2026-07-10 Local D1 And Route Ownership

The 2026-07-10 local evidence advances the migration contract without changing
the production posture:

- All three Wrangler D1 binding declarations now set
  `migrations_dir = "migrations/d1"`. The default, staging, and production
  configurations therefore point at the same contiguous `0001` through `0020`
  migration chain. This is configuration alignment, not proof of a remote
  migration apply.
- A real local Wrangler D1 applied 20/20 migrations and exposed 26 business
  tables, including the per-response Realtime reservation ledger and settlement
  replay-marker path.
- The scheduling gateway no longer treats every
  `/api/platform/realtime/*` path as a Realtime session. Valid session routes
  remain owned by `RealtimeSession`, while
  `/api/platform/realtime/settlement-batch/smoke` remains an explicit platform
  control route.
- The local Worker-binding settlement smoke passed all six fixed
  apply/duplicate/rollback/refund/tokenless scenarios and cleanup left zero
  residual smoke rows. This upgrades M6 settlement evidence from a local SQL
  shape to the real local Worker `DB` binding path.

## Evidence Increment: 2026-07-12 Realtime Bridge Ownership

- The current migration ledger contains 21 files through
  `0021_realtime_billing_bridge_segments.sql`; local SQLite replay requires 26
  tables, 57 incremental columns, and 15 key indexes.
- Realtime reservation identity now carries a generated bridge segment.
  Binding, settlement, terminal refund, and lease handoff require both logical
  session and segment, matching cinaVibeSDK's connection-lifetime boundary and
  preventing an old bridge from mutating replacement-bridge billing work.
- Migration 0021 refuses to run while any reservation remains active. Legacy
  attachments without segment metadata fail closed to durable lease recovery.
- The frontend exposes this as implementation evidence only. WFP upload/readback,
  remote D1 application, provider canary, eviction/reconnect, and rollback proof
  remain separate production gates.

How this maps to the cinaVibeSDK-derived layers:

- **Rust scheduling gateway:** schema readiness and exact route ownership are
  control-plane responsibilities. Explicit control routes must win before a
  generic DO or WFP prefix is considered.
- **Rust Durable Object:** `RealtimeSession` can delegate its final
  quota/replay/audit mutation to a locally proven binding batch, but remote DO
  lifecycle, live usage settlement, and staging no-double-charge evidence are
  still missing.
- **WFP Rust tenant script:** no dispatch namespace, tenant artifact, or tenant
  AI route was exercised by this evidence. The central D1 settlement remains a
  gateway-owned service boundary; tenant scripts must not gain direct ownership
  of that transaction merely because the local Realtime batch passed.

Wrangler is not authenticated for remote Cloudflare operations, so there is no
remote staging deployment, migration result, table inventory, capability
snapshot, or settlement smoke to archive yet. All production and staging
cutover statements below remain conditional on that remote evidence.

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
- Treat WFP as optional and paid-plan-gated. Main-domain relay traffic remains
  in-gateway when WFP is disabled, but a host recognized by
  `WFP_PREVIEW_HOST_SUFFIX` fails closed and never falls back to the main app.
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
- Current reference commit `918e97480ee4` implements inbound dynamic dispatch
  and a platform AI proxy, but its dispatch binding has no `outbound.service`
  and the repository contains no Outbound Worker implementation. Therefore the
  outbound interception and hidden credential injection below are an intentional
  Cloudflare-native hardening beyond the reference, not a copied cinaVibeSDK
  feature. The reusable reference ideas are the inbound dispatch boundary,
  provider/model registry, credential-owner coupling, and response-header
  allowlist.

`cinatoken-rust` mapping:

- Keep the main relay as the default single-tenant path.
- Paid tenant AI traffic remains a central relay request. Relay-token
  authentication, D1 channel selection, and quota reservation run before the
  selected channel's `channels.other_info.wfp_worker` value can choose WFP as
  the outbound transport. The response returns to the same central settlement
  and audit path.
- `WFP_RELAY_TRANSPORT_ENABLED` is a dedicated, default-off transport gate.
  It is independent of preview-host and admin status dispatch.
- The tenant runtime target is Rust/Wasm through the `cinatoken-wfp-tenant`
  crate, not a JS fallback for production.
- The dispatch namespace attaches outbound service `cinatoken-wfp-outbound`.
  The outbound Worker, not the tenant, owns
  `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` and injects the Cloudflare bearer. For
  outbound authentication the tenant receives only the non-secret marker
  `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1`; `CF_API_TOKEN` and
  every other Cloudflare bearer are forbidden tenant bindings.
- Outbound egress is fail-closed: only `POST application/json` requests with a
  valid JSON body up to 4 MiB may target the exact account-scoped Cloudflare AI
  REST URLs ending in `/ai/run`, `/ai/v1/chat/completions`,
  `/ai/v1/responses`, or `/ai/v1/messages`. The outbound Worker strips
  sensitive request/response headers by rebuilding allowlists and blocks
  redirects.
- Before WFP dispatch, the central relay creates an
  `x-cinatoken-wfp-authority` envelope. It is HMAC-SHA256 signed with a
  per-worker key derived from the platform-only
  `WFP_RELAY_AUTHORITY_SECRET`, expires after 30 seconds, and binds the worker,
  HTTP method, path, request-body SHA-256, selected channel ID, and request ID.
  The artifact uploader binds only the derived `WFP_RELAY_AUTHORITY_KEY` into
  that named tenant. The Rust/Wasm tenant verifies with that key and must never
  receive the platform master.
- The paid tenant route set is deliberately limited to
  `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and `/ai/run`.
  `/v1/embeddings` is not a valid WFP tenant route and has been removed.
- `/api/platform/dispatch/:worker/...` is admin-authenticated and status-only.
  It may reach `/__cinatoken/tenant/status`, but it cannot invoke paid tenant AI
  routes. Preview-host/public AI dispatch is also rejected.
- The generated JavaScript fallback is status-only and its control-plane deploy
  route is disabled. Production upload must use the strict
  `tools/deploy_wfp_tenant_artifact.mjs` Rust/Wasm artifact path.
- Inbound sensitive headers must be empty from the tenant's point of view.
- Tenant responses must pass through a safe response-header allowlist so auth,
  cookies, `cf-aig-*`, upstream transfer metadata, and upstream platform
  headers are not leaked.
- `/api/platform/capabilities` exposes the WFP tenant route manifest, cutover
  guards, tenant script plan, Rust/Wasm artifact plan, internal dispatch
  requirement, response-header guard, AI Gateway request policy contract, and
  `wfp_tenant_smoke_ready` so the admin frontend can distinguish compiled
  substrate from live dispatch readiness.
- Capabilities also expose parsed `relay_retry_times`. The frontend requires
  zero central retries and disabled cross-model fallback before marking the
  paid WFP relay smoke ready to verify, preventing one smoke process from
  silently fanning out to multiple providers.
- Dispatch smoke must enforce that allowlist on both tenant status and opt-in
  AI route responses, failing on auth/cookie, `cf-aig-*`, and non-WFP
  `x-cinatoken-*` leakage while recording Cloudflare edge envelope headers
  separately. Live smoke preflights the capabilities guard surface by default.

Current mapped status from existing docs:

- WFP dispatch code and smoke harnesses exist, but the `DISPATCHER` binding is
  still commented and paid-plan-gated.
- `crates/wfp-authority` and `crates/wfp-tenant` provide the local signed
  authority and Rust/Wasm verification substrate.
- The Cloudflare Platform frontend panel now shows WFP tenant route/guard and
  smoke-readiness signals from `/api/platform/capabilities`; those signals do
  not replace archived staging smoke.
- The artifact uploader rejects tenant token flags and binds the outbound auth
  marker instead. The Cloudflare deploy token is used only for dispatch-
  namespace script administration and is never attached to the tenant or the
  outbound Worker.
- No remote outbound-service attachment, tenant binding readback, or live AI
  request is claimed. Production proof still needs a real Rust/Wasm upload plus
  REST readback, an archived manifest with per-module SHA-256 hashes, proof that
  `cinatoken-wfp-outbound` alone owns its AI token, and a staging signed-
  authority billing canary proving one central reserve followed by exactly one
  settlement or refund and one audit outcome. Replay-resistance evidence is
  separate and remains pending; short lifetime and body binding are not
  described as replay-proof. Production remains **NO-GO**.

Cloudflare documents the platform egress interception model in
[Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
and the four allowed upstream shapes in the
[AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

Production rule:

WFP cutover is last-mile multi-tenant enablement. It must not become a
dependency for the first single-tenant relay production cutover, and it must
never become a second public or admin paid-request authority.

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
  channel before cross-channel retry logic sees the result, but only when the
  model-prefix registry proves that the selected Rust channel adapter belongs
  to that provider. OpenAI, Anthropic, and DeepSeek currently satisfy this
  direct-fallback contract. Other documented REST providers remain
  Gateway-only until their dedicated Rust adapters are no longer deferred.
- The registry now covers the documented OpenAI-compatible REST provider set,
  including `google-ai-studio/`, `deepseek/`, Groq, Mistral, Cohere,
  Perplexity, Google Vertex AI, Cerebras, Baseten, Parallel, and `@cf/`.
  Undocumented `cloudflare/` aliases fail closed; Workers AI uses `@cf/` and
  never attempts provider-direct fallback.
- Billing and usage parsing remain the main relay's responsibility. AI Gateway
  is transport and observability, not a billing replacement.
- The current same-channel direct path is transport failover only; it does not
  implement cinaVibeSDK's primary/fallback model switch. The default-off Rust
  outer model-attempt layer now implements that switch for OpenAI-compatible
  chat/responses: it revalidates token model limits, channel availability,
  pricing/reservation, and audit identity for the fallback model. Production
  replay and deployed Queue/D1 proof for the locally compiled terminal
  attempt-ledger remain open.
- Do not reuse the Gateway-prefixed body for direct egress, and do not treat
  Gateway `401`, `403`, or `429` as permission to bypass Gateway policy by going
  direct. The Rust direct-fallback classifier and provider-native body rewrite
  now enforce this; staging still has to prove the behavior against a deployed
  Gateway.

Production rule:

No AI Gateway canary is production-valid unless Gateway logs and relay
audit/billing logs prove the same model, usage, quota delta, channel accounting,
and fallback behavior as the direct path.

## Route Ownership Matrix

| Route or traffic family | Production owner | cinaVibeSDK pattern used | Main gates | Required evidence |
| --- | --- | --- | --- | --- |
| `/v1/chat/completions`, `/v1/responses`, `/v1/messages` | Main Rust relay | AI Gateway primary/fallback forwarding | `RELAY_AI_GATEWAY_ROUTER_ENABLED`, per-channel opt-in | Direct and AI Gateway canary, same-channel fallback, unchanged settlement |
| `/v1/embeddings` | Main Rust relay direct-provider path | Central auth, channel selection, bounded body, and settlement only; Cloudflare exposes no generic AI Gateway REST embeddings route | Existing relay gates | Direct-provider canary, batch policy, usage, and billing evidence |
| `/v1/realtime` | `RealtimeSession` DO after G7 proof | DO long-session owner | `REALTIME_SESSION_V1_ENABLED` | Transient bridge lifecycle, frame guard, close/error mapping, send-failure cleanup, terminal event trace, upstream replay contract, backpressure policy plus runtime FIFO queue, controlled mock startup queue/drain and early fault plans, archived staging evidence, billing settlement, live protocol replay |
| `/api/platform/realtime/:session...` | Platform smoke gateway | DO smoke/control surface | `REALTIME_SESSION_GATEWAY_ENABLED` | Status frame, persisted metrics, attachment restore, no-echo control probe, forged internal upstream header boundary smoke |
| Tenant preview or internal dispatch hosts | WFP `DISPATCHER` | User-app dispatch boundary | `WFP_DISPATCH_ENABLED`, `WFP_INTERNAL_DISPATCH_ENABLED` | Capability preflight with tenant route/guard contract, Rust/Wasm runtime status, sanitized inbound headers, route markers, 401/403 negative tests |
| Tenant AI routes | Main Rust relay, then WFP Rust tenant transport, then AI Gateway | Post-admission dispatch with signed body-bound authority | Real `DISPATCHER`, `WFP_RELAY_TRANSPORT_ENABLED`, tenant Gateway vars | Central reserve/settlement/audit evidence, tenant-scoped authority-key readback, route-specific Gateway logs, request policy headers, response-header allowlist, and replay-resistance canary |
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
- Deployed `cinatoken-wfp-outbound` service attached as that namespace's
  outbound Worker, with `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` present only on the
  service.
- Uploaded `cinatoken-wfp-tenant` Rust/Wasm artifact.
- Redacted artifact manifest from
  `tools/deploy_wfp_tenant_artifact.mjs --dry-run --json`, proving
  `runtime: "rust-wasm"`, main module presence, Wasm module presence, module
  byte counts, content types, per-module SHA-256 values, the exact outbound auth
  marker, and absence of every Cloudflare bearer binding.
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
- Live negative egress proof for non-POST methods, non-JSON or invalid JSON,
  bodies over 4 MiB, wrong scheme/host/account/path, query/fragment variants,
  sensitive caller headers, and redirects.
- Live positive egress proof for each of the four exact Cloudflare AI REST URLs,
  showing outbound-owned authentication without exposing a bearer to tenant
  bindings, logs, responses, or evidence artifacts.
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
  final settlement, durable replay markers, Go-compatible audit rows, guarded
  D1 batch/CAS proof, and staging no-double-charge evidence before
  `REALTIME_SESSION_V1_ENABLED` can be used outside a canary.
- Async video/Suno/Midjourney production ownership now has a Worker cron
  timeout sweep before normal provider polling and a CAS-winner refund batch for
  timeout/video/Suno failure refunds. The local
  `bun run check:task-refund-batch` replay now proves no-duplicate-refund,
  legacy no-refund, and stale-window unblock semantics before staging, but the
  cron still requires staging timeout/provider-failure/no-duplicate-refund
  replay before it can be treated as eviction-proof billing infrastructure.
- Optional TaskRunner M5b follows the cinaVibeSDK recurring DO-alarm idea without
  changing billing authority: one deterministic `TASK_RUNNER` DO per task,
  terminal-aware poll outcomes, non-terminal rearm, D1 recheck after lost CAS,
  bounded failure backoff and fast-path horizon, with cron remaining the
  correctness spine. The status probe/frontend/smoke plan expose progress,
  terminal, retry, and cron-fallback metadata. Live alarm/cron race and
  no-double-poll CAS proof remain required before the fast path can influence
  settlement latency.
- The Rust cross-model fallback is a separate default-off policy layer around
  the existing channel loop. It must not be stacked with Cloudflare Dynamic
  Routes until the actual Gateway-selected provider/model can be reconciled
  with central billing and exactly-one settlement. The local `auto` group plan
  now freezes one expression result, rebases only the effective ratio for each
  candidate group, reserves the maximum estimate once, and settles/refunds from
  the snapshot belonging to the actual serving group. A cross-model fallback
  refunds the primary plan and builds a new plan for the fallback model. This
  remains default-off until isolated staging D1 replay proves those invariants.
- The per-token `cross_group_retry` switch is now loaded by D1 authentication and
  propagated through ordinary REST, cross-model fallback, and Realtime attempt
  planning. The default-off actual-group Worker-binding smoke exercises the same
  authenticated value, but local self-test/dry-run output is not remote staging
  evidence.
- WFP tenant AI is now locally shaped as a post-admission transport, but remains
  a production NO-GO. Central token policy, D1 channel selection, reserve,
  settlement/refund, and audit remain authoritative; WFP is selected only from
  `channels.other_info.wfp_worker` and receives the 30-second signed authority.
  Admin dispatch is status-only. Keep `WFP_RELAY_TRANSPORT_ENABLED=false` until
  staging signed-authority billing canary, live replay-DO race evidence, and
  real Rust/Wasm upload plus external-binding readback are archived.
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

As of 2026-07-12, including the scheduling-gateway and local D1 evidence above:

- Main relay AI Gateway forwarding is wired as gated substrate, but still needs
  live staging canary evidence and billing log comparison before cutover.
- Realtime DO has the session substrate, planners, connect contract,
  gateway-to-DO handoff, outbound fetch-upgrade adapter, and transient bridge
  lifecycle/frame guard/close mapping/send-failure cleanup plus terminal event
  trace metadata plus smoke-level bridge replay, ordered upstream replay, and
  platform header-boundary contract self-tests. It now has a controlled mock
  startup queue/drain probe plus default-off replay/audit/batch settlement
  foundations, a local SQL-shape settlement-batch replay, and a staging
  setup/verify/cleanup evidence plan plus a default-off Worker-binding
  settlement smoke route for the six fixed apply/duplicate/rollback scenarios.
  The real local Worker binding now passes all six scenarios with zero residual
  smoke rows after cleanup. Realtime billing is now modeled per
  `response.create`: migration 0019 provides an idempotent D1 reservation
  ledger, the DO reserves before forwarding, `response.created` binds the
  oldest unclaimed sequence to a hashed response identity, and
  `response.done` settles that exact identity even when completions arrive out
  of order. Terminal failures refund through reservation CAS. Failed
  settlements coexist in a bounded private retry collection and one DO alarm
  schedules the earliest due item, matching the cinaVibeSDK
  single-alarm/multiple-persisted-work pattern. Terminal D1 rows clear private
  recovery payloads. Migration 0020 adds a persisted active-reservation lease;
  abandoned work refunds through the same alarm after hibernation, transient
  refund failures remain scheduled, and settlement retry ownership suppresses
  concurrent lease refunds. The public v1 route still fails closed while the
  settlement-write gate is off.
  This closes the audited local session-scoping defect, but the migration still
  lacks archived live staging binding-smoke output, staging
  queue/drain and D1 rollback artifacts, full live fault replay, and billing
  reconciliation plus alarm/eviction/multi-response proof required for
  production `/v1/realtime`.
- WFP dispatch now also has a platform-owned one-time authority Durable Object,
  canonical shard enforcement, fail-closed tenant consumption, and external DO
  upload metadata. The new Rust outbound Worker locally defines the required
  bearer-free tenant boundary and four-route egress allowlist. It still needs a
  real paid-plan `DISPATCHER` binding with `cinatoken-wfp-outbound` attached,
  outbound-only secret readback, strict Rust/Wasm artifact plus replay binding
  readback, and deployed sequential/concurrent replay and egress proof before
  any paid canary. Remote attachment and live evidence are unverified, so WFP
  production remains **NO-GO**.
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

## 2026-07-13 Preview Response Chokepoint Alignment

The reference audit at cinaVibeSDK commit `918e97480ee4` and its current preview
response hardening change identified three browser side-effect headers that
must not cross the tenant preview chokepoint:
`Service-Worker-Allowed`, `Service-Worker-Navigation-Preload`, and
`Clear-Site-Data`.

cinatoken-rust now applies the same boundary in the Rust platform dispatch
gateway for regular `PreviewHost` HTTP responses. WebSocket upgrades are
excluded, and internal status dispatch is unchanged. This complements rather
than replaces the tenant/outbound response allowlists: the tenant boundary
protects provider secrets, while the dispatch preview boundary prevents a
tenant response from changing browser state outside the intended preview
surface.

The local multi-service Workerd suite additionally proves the Rust tenant and
outbound Worker can cooperate through service bindings with one replay winner
and one terminal provider call. This is stronger local runtime evidence than a
source-only mapping, but it is still not remote dispatch-namespace attachment,
deployed compatibility, or production evidence.

## 2026-07-13 Dedicated Provider Registry Boundary

The xAI channel migration exercises the same separation of responsibilities as
the cinaVibeSDK-inspired Worker architecture: the central Rust relay retains
channel selection, quota reservation, settlement, audit, and fallback policy;
`crates/providers` owns provider-specific URL, capability, request-transform,
and AI Gateway route planning; WFP remains an optional transport boundary and
does not acquire billing authority or provider credentials.

Channel type 48 is deliberately not admitted to the generic OpenAI-compatible
set. Its explicit capability permits chat completions, legacy completions,
Responses, and image generations. AI Gateway planning remains default-off,
channel-opt-in, and narrower: only chat and Responses are eligible. This local
boundary proof does not replace remote Gateway logs, WFP attachment readback,
provider usage correlation, or rollback evidence.
