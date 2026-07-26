# cinaVibeSDK Production Migration Mapping

Date: 2026-07-12

Latest evidence increment: 2026-07-26

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

> **Authoritative safety note:** Historical migration-plan sections 22.64-22.66
> are superseded deployment experiments, not operator instructions. Current WFP
> tenants receive no Cloudflare bearer or tenant runtime token. Use migration
> plan sections 22.162 and 22.212 for the outbound credential and external
> Durable Object binding contract.

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
  `x-cinatoken-wfp-authority` envelope. Central-authority v3 is HMAC-SHA256
  signed directly with platform-only `WFP_RELAY_AUTHORITY_SECRET`, expires
  after 30 seconds, and binds the public worker, physical dispatch Worker,
  fixed outbound policy profile, HTTP method, path, request-body SHA-256,
  selected channel ID, and request ID. The artifact
  uploader binds no authority signing or verification material into the tenant.
- The tenant applies bounded route/body checks and forwards the opaque
  authority. Cloudflare injects `CINATOKEN_WFP_OUTBOUND_CONTEXT` into the
  outbound Worker, which validates route kind, public/dispatch worker, final
  path/body, central signature, fixed policy, and replay before bearer access.
- The tenant forwards no Gateway policy or attribution headers. The outbound
  service owns route Gateway IDs, bounded retry/cache/logging, and metadata
  derived from signed claims.
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
- Each action has at most one configured fallback. `executeInference` switches
  once and subsequent retries stay on that model; it is not an arbitrary chain.
- Rate-limit, security, and cancellation errors stop immediately. The current
  model test service exercises only the primary model, and the checked-in BYOK
  surface does not constitute production-ready user-key fallback evidence.
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
  to that provider. OpenAI, Anthropic, DeepSeek, Mistral, and xAI currently
  satisfy this direct-fallback contract for their implemented routes. Other
  documented REST providers remain Gateway-only until their dedicated Rust
  adapters are no longer deferred.
- The registry now covers the documented OpenAI-compatible REST provider set,
  including `google-ai-studio/`, `deepseek/`, Groq, Mistral, Cohere,
  Perplexity, Google Vertex AI, Cerebras, Baseten, Parallel, and `@cf/`.
  Undocumented `cloudflare/` aliases fail closed; Workers AI uses `@cf/` and
  never attempts provider-direct fallback.
- Billing and usage parsing remain the main relay's responsibility. AI Gateway
  is transport and observability, not a billing replacement.
- The current same-channel direct path is transport failover only. The separate
  default-off Rust outer model-attempt layer implements one central fallback for
  OpenAI-compatible chat/Responses and Anthropic Messages. It revalidates token
  model limits, reads a complete fallback-model D1 candidate set rather than a
  primary/standard single-entry cache hit, applies each candidate's model
  mapping, validates the effective Messages schema and Gateway plan before
  reserve, and rebuilds pricing/reservation plus audit identity. Any primary
  `401`, `403`, or `429` is a sticky veto across later channel attempts.
  Production replay and deployed Queue/D1 proof remain open, with an independent
  Messages staging marker.
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
| Tenant AI routes | Main Rust relay, then WFP Rust tenant transport, outbound security boundary, then AI Gateway | Post-admission dispatch with signed body-bound central authority | Real `DISPATCHER`, exact outbound environment/context parameter, `WFP_RELAY_TRANSPORT_ENABLED`, outbound-only Gateway vars | Central reserve/settlement/audit evidence, authority/replay/Gateway-policy-free tenant readback, schema-3 outbound/replay readback, live context propagation, route-specific Gateway logs, response allowlist, and replay-resistance canary |
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
  canonical shard enforcement, fail-closed outbound consumption, and an
  environment-specific external DO binding on the outbound service. The Rust
  outbound Worker locally defines the bearer-free/authority-free tenant
  boundary, invocation-context checks, and four-route egress allowlist. It
  still needs a real paid-plan `DISPATCHER` binding with exact service,
  environment, and context parameter; outbound-only secret/replay readback;
  strict Rust/Wasm tenant binding-absence proof; and deployed context,
  sequential/concurrent replay, and egress evidence before any paid canary.
  Remote attachment and live evidence are unverified, so WFP production remains
  **NO-GO**.
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

## 2026-07-13 cinaVibeSDK Re-Audit And Workerd Eviction Application

The current cinaVibeSDK `main` at `918e974` was re-read rather than treating its
documentation as executable evidence. The reusable design remains sound:
client WebSockets belong to a hibernatable DO/Agent boundary, durable session
state belongs in SQLite, request-scoped secrets stay outside persisted socket
metadata, and host/tenant/provider responsibilities remain separate. Its
`UserSecretsStore` also reinforces a useful fail-closed rule: encrypted durable
material may survive eviction, while an unlocked in-memory key must not.

Two reference implementation details are deliberately not copied:

- The cinaVibeSDK dispatch path rebuilds a `Response` after WFP fetch without
  explicitly preserving `response.webSocket`; this is not proof of transparent
  `101 Upgrade` forwarding. cinatoken-rust keeps the dispatch response intact
  and still requires a dedicated WebSocket dispatch regression plus remote
  namespace smoke.
- Its current agent inference path still uses AI Gateway `/compat`. New
  cinatoken-rust work continues to use the provider REST API boundary through
  the Rust tenant/outbound services, preserving outbound-only authorization and
  the reviewed route allowlist.

The design is now applied through an executable local runtime gate. The release
Rust/Wasm `RealtimeSession` is exported into Cloudflare's Vitest Workers pool,
bound as a SQLite Durable Object, and explicitly evicted while a hibernatable
client WebSocket is open. The same socket processes another message after
eviction; its redacted attachment and bridge segment are restored, durable
metrics continue from the stored value, and HTTP status reports one active
socket and one restored attachment. This is stronger than a mock or source-only
claim and is absent from the audited cinaVibeSDK test suite.

The evidence boundary remains strict. The passing case intentionally has no
outbound provider WebSocket. An active upstream bridge is transient and cannot
be represented as restored merely because the client attachment survived. The
next Workerd Realtime lifecycle increment must establish a mock upstream,
confirm one active bridge, force reconstruction, then prove metadata-only
`upstream_unavailable`, close 1011, exactly-once refund or lease ownership, no
second provider request, secret-free state/events, and a fresh bridge segment
after client reconnect. Cloudflare staging must repeat the lifecycle and billing
drill before G7 or production cutover can pass.

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

The same boundary now applies to Mistral channel type 42. Only chat completions
are enabled, matching the implemented Go adapter rather than the provider's
broader current API catalog. The provider layer owns message-field reduction,
multimodal conversion, and tool-call ID consistency; the Worker supplies
Web Crypto-backed entropy and keeps central billing/retry/audit authority.
Mistral chat and xAI chat/Responses can use the default-off AI Gateway planner,
and both now have same-channel provider-direct fallback without bypassing their
dedicated request transforms. Perplexity Sonar chat now joins that bounded set:
its direct path uses `/chat/completions`, while Gateway transport uses the
standard chat route and `perplexity/{model}`. Agent Responses stays outside this
adapter because its provider-qualified model IDs require a separate policy.
Router-unavailable, channel-opt-out, and other planner-direct main-relay paths
apply the same provider-native model normalization; a recognized prefix cannot
egress through a mismatched channel.

Submodel channel type 53 uses the same provider-registry ownership boundary but
is deliberately direct-only. Model IDs such as `openai/gpt-oss-120b`,
`deepseek-ai/...`, and `Qwen/...` are opaque Submodel names, not Gateway routing
instructions, so neither central relay nor WFP may classify or strip them.
Only chat and legacy completions are enabled. WFP channels whose resolved
provider path is outside the reviewed WFP path allowlist continue to fail before
quota reserve.

The safe same-channel Gateway-direct provider set is now OpenAI, Anthropic,
DeepSeek, Mistral, Perplexity, and xAI. The explicit Deferred count is now 27.
SiliconFlow is implemented as a direct-only five-route adapter and does not
enter this Gateway-direct set; existing WFP tenants also reject it before
reserve. Moonshot is likewise direct-only for its five audited OpenAI/Claude
routes; its provider-native/coding-plan model IDs never enter Gateway prefix
classification. MokaAI remains Deferred pending hosted API evidence.

## 2026-07-13 Scheduling-Gateway Recovery Application

The global Realtime recovery increment applies the cinaVibeSDK-inspired
responsibility split without copying runtime assumptions that do not hold for
Rust Workers. `RealtimeSession` remains the long-session authority and keeps
its live retry/lease state private. D1 is the durable billing ledger. The root
Rust scheduling gateway now performs only a default-off, migration-gated,
bounded reconciliation pass for rows that outlive both their lease and a
300-second settlement grace.

WFP tenant and outbound Workers do not participate in reservation recovery and
do not gain billing authority. The admin global status exposes hashed D1 policy
state, while current DO ownership still requires a separate redacted DO probe.
This is deliberate: a bridge-scope fingerprint cannot prove that a live
settlement retry exists.

The release Workerd suite now exercises the generated Rust scheduled
entrypoint, concurrent schedule idempotency, and failed-row fairness. Remote
dispatch namespace attachment, deployed DO eviction/redeploy, authenticated
reserve/settlement ownership, AI Gateway/provider correlation, and rollback
remain unverified, so the architecture mapping remains production **NO-GO**.

## 2026-07-13 Private WFP Outbound Ingress Alignment

The cinaVibeSDK comparison reinforces that an outbound Worker is an internal
policy and credential boundary, not another public application origin.
cinatoken-rust now encodes that ownership in deploy configuration:
`cinatoken-wfp-outbound` disables workers.dev and Preview URLs and declares no
route, while the dispatch namespace remains its intended caller.

The root Rust Worker compiles this invariant into WFP readiness and the Bun
frontend exposes it without claiming remote verification. Readback schema 3
checks the deployed script subdomain, service-filtered Custom Domains, exact
outbound environment/context parameter, and platform replay binding. This is
stronger than source inspection but still does not enumerate Zone Worker
routes or prove live parameter propagation. After credential rotation, an
account-wide route inventory plus schema-3 readback, remote Dynamic Dispatch
composition, provider call, settlement/audit correlation, and rollback remain
required. Production remains **NO-GO**.

## 2026-07-13 Regional Provider Registry Application

The VolcEngine(45) and BaiduV2(46) increment applies the existing
cinaVibeSDK-derived responsibility split to two more dedicated providers. The
provider crate owns exact route admission, upstream URL construction, and
request transforms. The central Rust relay still owns model/channel selection,
quota reservation, settlement/refund, retry, auto-disable, and audit. A
regional OpenAI-shaped API does not become part of the generic adapter merely
because its payload resembles OpenAI.

Both providers remain direct-only because Cloudflare's native AI Gateway
registry does not list them and the WFP tenant/outbound route policy does not
own their credentials or route set. VolcEngine Bot/TTS/rerank/image-edit/
Messages paths and Baidu embeddings/image/rerank paths fail before reserve
until their complete transport and conversion contracts are implemented. This
keeps WFP as an optional execution boundary and prevents provider-specific
gaps from leaking into central billing authority.

The cinaVibeSDK reference still supplies architectural guidance, not deployed
proof. Production requires rotated credentials, staging route fixtures,
provider/Gateway/WFP traces where applicable, billing/audit reconciliation,
fault evidence, and rollback. Production remains **NO-GO**.

## 2026-07-14 Durable Billing Command Application

The billing-finalization reconcile increment applies three cinaVibeSDK design
principles without copying its application-specific Agent runtime:

1. Hibernation-safe work is persisted. DLQ incident identity, replay generation,
   lease, attempts, and outcome live in D1; no operator lock or pending replay
   depends on Worker memory or a resident Durable Object.
2. Internal work crosses bindings. The root management route sends the stored
   frozen event through `BILLING_QUEUE`; it does not call a public Worker URL or
   execute settlement itself.
3. Control, transport, and finance stay separate. The HTTP route authorizes one
   command, Queue transports it, the central Rust consumer owns financial CAS,
   and WFP tenant/outbound Workers retain transport-only authority.

Adding a singleton billing DO would create an unnecessary global serialization
point and would not replace D1 financial idempotency. The chosen design instead
uses the existing D1 owner and Queue at-least-once semantics, with a generation
lease only for the human control-plane claim.

Local Workerd evidence proves the command flow across quarantine, root step-up,
Queue replay, financial CAS, audit, and resolution. It does not prove remote
Queue attachment, retry exhaustion, DLQ/parking retention response, D1 outage,
or paid-provider reconciliation. Those remain staging gates, and production is
**NO-GO**.

## 2026-07-14 Realtime Reconciliation Ownership Alignment

The ambiguous-usage increment applies the same cinaVibeSDK stateful-runtime
lesson used by the Realtime bridge: a hibernating or replaced Durable Object
cannot be the only owner of unfinished work. When terminal provider usage is
not verifiable, D1 now persists `usage_reconciliation` ownership before the
bridge closes. Startup, alarm, terminal-close, and global scheduled recovery
paths all observe that owner instead of reconstructing a refund decision from
missing in-memory context.

The Realtime DO remains the live socket/ordering owner; D1 remains the financial
truth; the admin frontend is an observation surface only. No singleton Agent or
global DO is introduced, and WFP tenant/outbound Workers gain no settlement or
repair authority. This keeps the cinaVibeSDK-inspired persistent-state boundary
without importing its application-specific Agent lifecycle.

Local Workerd proves persistence against a forced-overdue scheduled sweep, but
remote eviction/redeploy, actual-provider invoice correlation, alerts,
retention, and a dual-control operator resolution workflow remain absent.
Production remains **NO-GO**.

## 2026-07-15 Source Boundary And Browser Evidence Audit

The reference boundary was re-audited at cinaVibeSDK commit `918e974`. That
tree contains no Rust crate or Cargo manifest. Its reusable evidence is the
TypeScript Workers/Agents SDK topology: fail-closed dispatch ownership,
deterministic stateful identity, persisted hibernation state, dispatch namespace
identity, and centrally owned model/credential/fallback policy. The Rust
scheduling planner, Rust Durable Object, Rust/Wasm tenant, outbound Worker, and
request-bound HMAC authority are cinatoken-rust implementations.

The current Rust gateway expresses owner precedence as a tested pure planner;
RealtimeSession restores accepted client sockets from attachments/storage; and
the WFP tenant/outbound split keeps provider bearer credentials outside tenant
code. These local contracts are stronger than copying the reference Worker
header behavior, but they are not deployed evidence. Active outbound WebSockets
still prevent DO hibernation and must never be presented as resumable state.

The reference AI Gateway `/compat` path is deprecated. cinatoken-rust continues
to use current REST/provider boundaries and keeps provider selection plus
billing reconciliation in the central relay. The highest remaining local G5
gap is browser automation: route/build/readiness checks do not prove logout,
expired session, relogin, roles, CRUD, Passkey, desktop/mobile console, or
network behavior. The generation-fenced auth fix closes the known stale-session
race, while Playwright evidence remains planned. Production remains **NO-GO**.

## 2026-07-14 Realtime Reconciliation Control-Plane Alignment

The local operator workflow now applies the same ownership split without
copying cinaVibeSDK application lifecycle code. `RealtimeSession` remains the
socket/order owner, D1 remains the financial writer, and the root frontend is a
preview/confirmation surface. Neither the WFP tenant nor outbound Worker can
discover or mutate reconciliation state.

Migration 0028 persists revision-fenced resolution and idempotency in D1. A
root decision is recomputed from the frozen billing expression and applied in
one financial/audit batch after secure verification. This removes the local
"no operator resolution" gap, but it is not dual-control production proof: the
tracked runtime mutation gate remains false.

cinaVibeSDK's inference helper performs explicit primary/fallback choice above
AI Gateway, and its app proxy is single-model. It is design evidence for
separation and fallback policy, not evidence that Gateway itself provides
cinatoken's multi-model billing authority. Provider selection and
actual-serving-model accounting remain centralized in cinatoken-rust.

Remote 0028, two-person approval policy, evidence retention, provider invoice
correlation, D1/concurrent-operator faults, alerts, rollback, and staging
readback remain required. Production remains **NO-GO**.

## 2026-07-15 Task, Free-Model, And External DO Audit Alignment

This increment updates the production mapping only. It does not claim that the
corresponding code paths, tests, migrations, Cloudflare bindings, or remote
evidence passed in this documentation change.

### Task P0 ownership

The central Rust Worker must own Task authentication, pricing, reserve,
compensation, and accounting before a TaskRunner DO, Queue, Workflow, provider,
or WFP transport participates:

- Task routes require full token/user status, expiry, exhaustion, model, and IP
  checks. Raw-token lookup is not an admission boundary.
- Fixed per-call quota is `ModelPrice * QuotaPerUnit * group_ratio`; the Go
  ratio fallback is `ModelRatio / 2 * QuotaPerUnit * group_ratio`. Missing or
  invalid pricing rejects the request before provider I/O instead of becoming
  zero quota.
- If the provider accepts a submit and D1 cannot persist the owned task and its
  accounting, the reservation requires durable compensation and reconciliation.
- A successful submit increments user request count and selected-channel usage
  exactly once, including legitimate zero-quota Task work. Polling and terminal
  settlement do not count the request again.

This keeps the deterministic TaskRunner DO as a polling coordinator rather than
an authentication or financial authority. The task row and billing reservation
must remain recoverably linked in D1 before asynchronous ownership is considered
production-ready.

### Free-model boundary

Go's free-model decision is not a blanket zero-price override. With
`quota_setting.enable_free_model_pre_consume=false`, flat fixed-price zero,
flat per-token ratio zero, or an effective zero group ratio skips base
pre-consume and wallet admission; tiered billing uses only the zero-group-ratio
case. Token status, expiry, exhaustion, model, and IP policy remain strict, and
terminal tool/search/audio additions may still charge. Successful operations
still count, with Task counted once at successful submit.

The Cloudflare target still lacks complete subscription-versus-wallet funding
source integration for this delayed admission decision, and Realtime still
needs flat/free-model settlement parity. Those are explicit production blockers,
not reasons to treat zero-base-price traffic as fully migrated.

### WFP external binding invariant

The production main script is `cinatoken-rust-api`; the production outbound
Worker's external `WFP_AUTHORITY_REPLAY.script_name` must match that exact value,
not `cinatoken-rust-api-production`. The release gate
`bun run check:wfp:external-binding-config` must structurally load the main and
outbound Wrangler TOML, compare default/staging/production script targets and
the `WfpAuthorityReplay` class, and fail closed on drift.

That static contract does not prove deployment. Production still requires
authenticated external-binding readback, exact dispatch namespace outbound
service/environment/context attachment, live replay behavior, bearer-free
tenant binding inventory, provider and billing reconciliation, fault evidence,
credential rotation, and rollback rehearsal. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-16 Dual-Source Container Execution Plane Mapping

The Container design now has two explicit source authorities. cinaVibeSDK
supplies the Cloudflare topology patterns: deterministic DO/Container identity,
class/binding/migration alignment, short health probes, lifecycle hooks, and
separate infrastructure capacity. Go cinatoken supplies the business pipeline:
`TokenAuth` and rate limits precede `Distribute`; model/group/channel/credential
selection precedes relay; pricing and pre-consume precede provider I/O; one
controller loop owns retry; Task persistence and settlement remain linked.

cinatoken-rust therefore keeps authentication, channel selection, reservation,
settlement, retry policy, and provider-operation identity in the edge/D1
correctness spine. A shard DO owns only deterministic routing, lease/fence,
replay, capacity, and lifecycle. Its Container receives an immutable admitted
operation and disposable scratch; it cannot become a second business or
financial authority.

The root Worker now declares a private `CONTAINER_CONTROLLER` service binding
for each environment and has a default-off Rust status client. The client uses
the existing cross-language authority vector, one absolute timeout over fetch
and bounded parsing, strict protocol/ring/config verification, and no public
HTTP fallback. Controller and execution enablement remain independent gates;
cutover requires both in addition to verified transport.

This is configuration and local contract evidence, not deployed readiness.
Controller-first deployment, status readback, targeted `/readyz`, real
Container lifecycle, N/N-1, shared storage, provider/billing, image supply
chain, fault/load/cost, canary, rollback, and approval evidence remain open.
The detailed source mapping is in
`docs/container-execution-plane-source-audit.md`. Production remains
**NO-GO**.

## 2026-07-17 Provider Attempt Ownership Mapping

The refreshed cinaVibeSDK audit retains deterministic named Durable Object
ownership and a persisted phase checkpoint, but does not copy its in-memory
Promise locks, `Promise.race` timeout handling, interval scheduling, local
workspace metadata, modulo shard choice, or best-effort cleanup. Those
mechanisms cannot prove global uniqueness after eviction, redeploy, timeout,
or split ownership.

The refreshed Go cinaToken audit retains model mapping, group resolution,
channel/credential policy, pre-reservation, usage parsing, and terminal billing
semantics. It does not copy request-local channel switching after transport
ambiguity or process-local BillingSession idempotency. A Cloudflare timeout can
outlive the Worker that observed it, so a second local loop is not evidence
that the first provider request was unsent.

The target mapping is therefore:

| Source concern | Rust/Cloudflare owner |
| --- | --- |
| Business admission and frozen billing | Edge Worker plus D1 |
| Deterministic execution identity and deadline | D1 operation plus shard plan |
| Attempt creation, generation, send grant, and classification | Named shard DO SQLite |
| Provider credentials and actual network call | Future private provider Service Binding broker |
| Disposable execution process | Linux Container |
| Immutable input/result bytes | R2, fenced by operation and attempt |
| Settlement/refund/accounting | Existing D1 financial terminal batch |
| Recovery observation and operator re-observation | D1 reconciliation observer |

The landed journal closes only the DO row in this mapping. It creates attempt
1 atomically with operation start, appends immutable transition events, issues
one dispatch grant, exposes a signed v2 snapshot, and fences R2 attachment by
generation. The provider broker and Container client are not implemented;
retry is hard disabled; global D1 terminal acknowledgement is absent. This is
local architecture evidence, not cinaVibeSDK production proof and not a
cinatoken traffic migration authorization. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-18 Exact cinaVibeSDK Container Topology Correction

The reference was reread at clean commit `918e9748`. Its two execution planes
must not be collapsed into a single one-DO-per-Container claim:

```text
Edge -> CodeGeneratorAgent DO(agentId)
     -> SandboxSdkClient(sessionId)
     -> Sandbox DO/UserAppSandboxService
     -> Linux Container

Edge -> SpaceDO(spaceName) -> App Facet(branch)
```

The checked-in configuration does not define `ALLOCATION_STRATEGY`.
Per-session Sandbox identity is therefore the relevant isolation pattern;
optional `many_to_one` modulo allocation would share a failure domain and
remap ownership when the pool size changes. `max_instances` remains an
infrastructure ceiling, not admission or backpressure authority.

cinatoken-rust keeps the useful ideas but not the extra ownership hop. Stable
Jump-Hash shard identity selects `RelayShardContainer`, whose Durable Object
SQLite owns claims, generations, capacity, recovery, and lifecycle while its
Container remains disposable execution. D1 owns business and financial truth;
R2 owns immutable large bytes; KV owns non-authoritative configuration/cache.
Warm promises, timers, process monitors, and Container disk are hints only.

For provider response protocol v3, this mapping requires:

1. a strict canonical Rust-produced and TypeScript-verified envelope;
2. separate provider/client statuses and interpretation class;
3. separate create-only raw and client R2 namespaces plus append-only D1 rows;
4. operation, owner, attempt, provider-operation, shard/ring, and exact Worker
   version fences before terminalization;
5. no provider resend after any completed-response evidence exists; and
6. lifecycle/capacity/artifact telemetry with credentials and bodies excluded.

The exact wire and digest contract is frozen in
`docs/container-provider-response-protocol-v3.md`. This is local design and
implementation evidence only. Go/VPS remains authoritative, all response-v3
writers remain disabled, and production remains **NO-GO**.

## 2026-07-22 Cross-Language Shard Planner Mapping

The current source pins remain cinaVibeSDK `918e9748` and Go cinatoken
`73652508`. cinaVibeSDK demonstrates named Durable Object/Container ownership
and explicit instance lookup, but its optional `many_to_one` allocator hashes a
session with process-language integer arithmetic, applies modulo to a mutable
pool size, and logs the session identifier. That is appropriate only as a
non-financial sandbox allocation hint; it is not copied into relay authority.

cinatoken-rust now freezes the stronger routing contract in
`tests/fixtures/container-shard-routing-v1.json` and verifies it independently
in Bun and in the Rust production planner. HMAC-SHA256 hides the tenant input,
Jump Consistent Hash bounds remapping, canonical instance names prevent caller-
selected DO identities, and every topology change carries a new ring
generation. Four test-only vectors cover 16 plans, eight one-shard expansions,
one move to the newly appended shard, and the 1024-shard maximum.

The independent verifier emits only aggregate counts and booleans; it does not
emit fixture secrets, tenant IDs, or routing digests. Production evidence must
follow the stricter drain transition in `docs/container-sharded-runtime.md`:
hold the routing secret fixed, disable admission, drain the old generation,
activate and verify Controller capacity first, then change generation and shard
count together, and route edge traffic last. Secret rotation and ring expansion
must never be combined in one candidate.

This closes the local cross-language algorithm gap, not remote routing privacy,
secret provisioning/rotation, real-tenant distribution, Container placement,
N/N-1 lifecycle, or billing/provider uniqueness. Production remains
**NO-GO**.

## 2026-07-25 Linux Receipt Filesystem Trust Boundary Mapping

This increment compares the three pinned source trees only:

- cinaVibeSDK `918e97480ee44e357abe99bf33c27259d6ac7ebd`;
- Go cinatoken `73652508abc5cb09214dde02d51d69d1d1ccc703`; and
- cinatoken-rust `33bbda404a01ae2b2e068237f891a44a1a3b8a68`.

Only committed objects at those pins count as source evidence. Concurrent
uncommitted worktree files are excluded from official-design and production
claims.

The narrow question is whether local Linux bytes may authorize another
identity proof, Cloudflare request, provider send, or terminal recovery. This
is not a general Container feature comparison and does not upgrade local
evidence into deployed Cloudflare evidence.

### Direct source evidence

| Source | Direct evidence | Trust-boundary conclusion |
| --- | --- | --- |
| cinaVibeSDK topology | `wrangler.jsonc:80`, `:107`, `:157` and `:220` bind `UserAppSandboxService` as both a Container class and a SQLite-backed Durable Object, while D1, R2 and KV are separate bindings. | Container execution, per-object coordination and shared persistence are separate responsibilities. A Container disk is not implied to be the global source of truth. |
| cinaVibeSDK identity | `worker/services/sandbox/sandboxSdkClient.ts:82-115` preserves the caller's sandbox ID unless optional `many_to_one` allocation is explicitly selected; `:143-162` resolves that deterministic Sandbox and session. The checked-in Wrangler files do not set `ALLOCATION_STRATEGY`. | Stable logical identity and lifecycle ownership are inherited. The optional language-specific hash/modulo pool is not a financial or receipt authority and is not inherited. |
| cinaVibeSDK local runtime state | `sandboxSdkClient.ts:405-440` stores instance metadata under `/workspace` and caches it in memory; `:1033-1063` creates the workspace and metadata; `:1185-1222` kills the process, unexposes the port and removes local files on shutdown. | Workspace files, process IDs, ports and memory maps are disposable lifecycle hints. They cannot prove that an operation was never sent or that an audit chain is complete. |
| cinaVibeSDK local SQLite | `container/storage.ts:48-84` opens path-selected Bun SQLite databases with WAL and `synchronous=NORMAL`; `:107-117` schedules retention cleanup. | The Container log/error database is operational telemetry. Its mutable rows, timer cleanup and path-based opening are not copied as an immutable receipt protocol. |
| cinaVibeSDK durable state | `worker/agents/core/codingAgent.ts:165-235` reconstructs transient behavior from persisted Agent state on every start; `:462-505` moves full conversation history into a separate DO SQLite table instead of one oversized state row. | Persist recoverable coordination before relying on a resident process, and keep large durable state outside transient runtime objects. The application-specific Agent state schema is not copied. |
| Go cinatoken database boundary | `model/main.go:117-175` selects PostgreSQL, MySQL or a SQLite fallback through GORM; `:177-207` initializes the main database; `:258-286` migrates Channel, Token, User, Log, Task and other business rows. | Business and financial truth belongs to the database model, not request memory or ad hoc files. The VPS SQLite fallback is a deployment option, not permission to make a Cloudflare Container filesystem authoritative. |
| Go cinatoken logs and tasks | `model/log.go:94-108` writes audit records through `LOG_DB`; `model/task.go:360-401` inserts and saves tasks through `DB`; `:408-418` uses a status-guarded CAS; `:431-441` explicitly rejects unguarded updates for billing/quota lifecycles. | Durable audit/task ownership and conditional transition semantics are inherited. Go has no equivalent of the Rust local receipt chain, aggregate head set, local seal, Linux inode lock, or external immutable anchor. |
| Rust receipt schema | `crates/ring-transition-runner/src/receipt.rs:249-369` defines the operation head set, local seal and terminal snapshot candidate, binding release, credential, claim, operation, response and expected execution-chain identities. | The receipt filesystem is a new, closed-schema authorization history. It is not a cache of D1/DO state and cannot be reconstructed from an assumed outcome. |
| Rust durable ordering | `ReceiptStore::{install_terminal_closure,recover_terminal_closure,reserve_operation}` and Linux `install_terminal_closure_graph_locked` serialize local terminal decisions under the authorization capability. The transport startup path recovers operations and terminal closure before HTTP construction, while the exact accepted claim read records the terminal candidate before accepted finish. | A committed candidate closes the accepted-response crash window locally. Startup recovery cannot mint a replacement send capability and must finish all other unresolved starts as ambiguous. |
| Rust Linux file checks | `receipt.rs` opens one immediate parent dirfd, creates staging with contained `openat2(..., O_EXCL|O_NOFOLLOW)`, publishes with same-dirfd `renameat2(..., RENAME_NOREPLACE)`, syncs that dirfd, double-reads the target and binds dev/inode/UID/GID/mode/link identity. It reopens the parent pathname only to require that it still resolves to the pinned identity. Terminal consumers retain the complete root/execution/authorization/closure graph around these primitives. | The committed publication primitive rejects writable/foreign/linked targets and parent replacement without redirecting writes, while the transaction graph detects cross-directory attachment or content drift before success. |
| Rust authorization lock | `receipt.rs` defines `LockedAuthorization` over retained `operation-receipts` and authorization descriptors and their stable identities. Acquisition locks the parent, opens the child with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)`, locks the child and revalidates both parent-relative and absolute attachment before reserve, finish, recovery or closure can succeed. | Cooperative processes cannot split across old and replacement authorization inodes at this boundary. The parent lock is control-plane serialization and is released before network I/O; hostile same-UID containment remains an OS ownership/ACL/mount boundary. |
| Rust contained child opens | The same fail-closed `openat2` wrapper creates staging files and reopens immutable targets relative to their immediate parent descriptor. A native test accepts a valid child and rejects `../` escape and symlink traversal; unsupported syscalls do not fall back to `openat`. Reserve, finish, recovery and terminal closure now traverse retained graphs after lock acquisition. | Child lookup rooted at a retained descriptor cannot escape beneath, traverse symlinks or cross mounts. Initial trusted-root and authorization acquisition still requires OS-enforced identity and access controls. |
| Rust reserve operation graph | `LockedOperationDirectory` is created with `mkdirat`, opened beneath the retained authorization dirfd, and bound to stable identity. Capacity publication, `fdopendir`/`readdir` audit, child opens, start append/readback/verification and terminal operation-directory chmod/fsync use retained descriptors. A Linux test replaces and recreates the operation pathname before the final reserve decision and requires fail-closed rejection. | Capacity and per-operation state cannot be redirected to a replacement pathname during reserve. |
| Rust reserve terminal graph | `LockedReserveTerminalBarrier` retains the installation root plus authorization-specific execution-chain and closure topology. Execution receipts, head set, local seal and terminal candidate are read beneath retained dirfds; the authorization-wide sibling/capacity audit also consumes the retained authorization fd. Reserve checks the graph before mutation and before returning a reservation. | Official writers linearize under the authorization `flock`, and captured directory/content drift cannot produce `Fresh`. Continuous absence against a malicious same-UID peer still requires dedicated identity, ACL and mount isolation. |
| Rust finish, recovery and terminal graph | Ordinary, unresolved and candidate-bound finish retain the operation dirfd through verify, append and readback. Recovery retains every audited operation dirfd, rescans the authorization fd and rereads the candidate. Candidate creation, terminal execution append, head-set publication, operation freeze, local-seal publication and closure verification consume the retained root-to-leaf graph. | A replaced operation, execution or closure pathname cannot redirect an authorized terminal result. A merely matching `Accepted` outcome cannot stand in for the candidate response, and a head-set/local-seal crash replays the same closure locally. |
| Rust installed artifact checks | `release.rs::verify_installed_release_at` requires stable regular installed bytes; the Unix file-identity check rejects link counts other than one. | The executable and receipt writer must be bound to one immutable installed generation; source checkout bytes or a mutable current pointer are insufficient. |

The cinaVibeSDK architecture diagram also routes Sandbox persistence to R2
while routing execution to Containers
(`docs/architecture-diagrams.md:88-94`). This supports the separation above,
but a diagram is weaker evidence than the binding and implementation files and
does not prove receipt immutability.

Cloudflare's current
[Container lifecycle documentation](https://developers.cloudflare.com/containers/platform-details/architecture/)
states that Container disk is ephemeral after sleep or restart, that Containers
are backed by Durable Objects, and that the associated DO and Container are not
guaranteed to run in the same location. Therefore local Container bytes are
replaceable scratch, not a durable receipt or financial authority.

### Designs inherited into cinatoken-rust

The following ideas are inherited, with stronger contracts where relay money
or send uniqueness is involved:

1. Deterministic logical ownership selects one stateful coordinator before a
   Container is contacted. The selected identity is an input to authorization,
   not a caller-selected filesystem path.
2. Stateful coordination survives process eviction in DO SQLite or D1. A warm
   object, timer, Promise, process ID, port, in-memory cache or `/workspace`
   file is never the only owner of unfinished work.
3. Container capacity and lifecycle are infrastructure concerns. They do not
   decide token validity, billing, provider retry, operation outcome or receipt
   completeness.
4. Large immutable inputs and outputs belong in R2; business, financial and
   reconciliation rows belong in D1; per-shard lease/fence/attempt state
   belongs in the shard DO. KV remains non-authoritative configuration/cache.
5. Recovery starts from persisted state and is idempotent. A missing local
   process is not evidence that its provider request was never sent.
6. Go's database-owned logs, tasks and guarded transitions remain the semantic
   source for audit and financial parity. The Cloudflare migration changes the
   storage implementation, not that ownership rule.

### Rust and Cloudflare additions

The following controls are new to cinatoken-rust and must not be attributed to
cinaVibeSDK or Go cinatoken:

1. HMAC-hidden tenant routing, Jump Consistent Hash, canonical shard instance
   names and ring-generation fencing replace the optional cinaVibeSDK
   process-language modulo allocator for relay authority.
2. Execution Receipt V1 and operation receipts are canonical, predecessor-
   bound, create-new records. Capacity markers prevent slot reuse; terminal
   operation outcomes are first-writer terminal.
3. `TerminalSnapshotCandidateV1` durably binds the exact accepted claim-read
   response before its operation finish. `OperationHeadSetV1` accounts for
   every terminal or marker-only slot, and `OperationHeadLocalSealV1` binds the
   candidate, execution head and aggregate operation tree.
4. A typed local-filesystem lock capability retains and validates the
   `operation-receipts` parent plus authorization dirfds. Parent then
   authorization `flock` acquisition prevents cooperative split-lock
   replacement; reserve, finish, recovery and closure recheck attachment.
   Process death releases the locks, and possession never authorizes network
   I/O.
5. Linux reserve retains each operation directory through capacity accounting,
   direct entry audit, start publication/readback and final operation binding.
   It also retains the authorization-specific execution and closure graph,
   performs fd-relative terminal reads and sibling audits, and repeats the
   barrier before returning. Linux publication uses descriptor-relative
   no-follow staging creation, same-dirfd no-replace rename, exact-byte double
   readback, file and parent-directory sync, immediate-parent path-identity
   readback and durability-unknown quarantine. Finish and unfinished recovery
   retain operation and terminal graphs through their final decisions.
   Candidate, execution plan, head set, operation freeze, local seal, recovery
   and final closure verification now remain on that retained graph.
6. Startup audits and recovers local receipts before HTTP construction.
   Candidate, terminal execution chain, head set, local seal, or indeterminate
   operation/closure staging is an admission barrier with zero identity,
   Cloudflare or provider calls.
7. The local seal detects changes relative to its locally verified root, but a
   privileged writer could still replace the whole tree and seal. Independent
   DSSE signing and separate deletion-resistant retention are therefore
   additional, non-interchangeable production controls.
8. Container replacement or loss of the receipt filesystem is never treated
   as a blank authorization. The globally persisted D1/DO operation state must
   force quarantine or exact read-only recovery; it must not issue a fresh
   send grant merely because local bytes are absent.

### Production acceptance conditions

The Linux receipt filesystem boundary is production-acceptable only when one
candidate generation satisfies every condition below. Passing Rust unit tests
or the supplied-document JavaScript verifier is insufficient.

| Gate | Required evidence | Reject / quarantine condition |
| --- | --- | --- |
| Trusted root | Exact installed artifact digest and generation; fixed operator-selected receipt root; no checkout, environment, CLI or request-selected fallback. | Mutable current pointer, arbitrary root, mixed-generation sidecars or unbound executable. |
| Pinned directory graph | Trusted parent and authorization directories opened once as dirfds; contained `openat2`/`*at` traversal; `fstat` device/inode/UID/GID/mode/link continuity before and after every mutation. | Path re-resolution, directory rename/replacement, symlink, mount crossing or identity drift. |
| Ownership and access | Dedicated service UID/GID; exact mode and POSIX ACL readback; writer-only mutation, auditor read access, no group/world write; regular-file link count exactly one. | Same-host peer can replace/link/write receipts, ACL is broader than declared, or ownership differs. |
| Atomic durability | `O_EXCL|O_NOFOLLOW` staging, bounded canonical bytes, file sync, `RENAME_NOREPLACE`, parent sync and descriptor readback on the production filesystem. | Replace-in-place, missing sync, partial success, different existing bytes or durability-unknown treated as success. |
| Lock-domain integrity | Two independent processes prove one authorization dirfd/inode and one local `flock` domain through reserve, finish, recovery and closure, including hostile parent/authorization-directory rename attempts. | Split lock domains, inherited permit after process death, lock held across network I/O or conflicting terminal bytes. |
| Crash matrix | Kill after every write/flush/sync/rename/readback boundary. Restart preserves marker-only slots, finishes ordinary starts ambiguous, finishes only the candidate-bound claim read accepted, and completes the unique head set/local seal locally. | Deletion, repair-in-place, synthetic start, slot reuse, outcome change, second send or any identity/network counter above zero during recovery. |
| Filesystem faults | Native release artifact on supported Linux and both ext4 and XFS evidence for ENOSPC, EIO, read-only remount, concurrent replacement, abrupt process kill and power loss; returned-success bytes survive remount/restart. | Windows-only evidence, tmpfs-only evidence, silent loss after acknowledged success or automatic rewrite of ambiguous state. |
| Container/DO lifecycle | Staging exercises DO eviction, Container stop/start/replacement, N/N-1 rollout, shard drain and missing/corrupt local receipt storage while D1/DO fences remain active. | Container loss creates a new authorization, old generation can send, or two instances accept the same operation. |
| Cross-layer reconciliation | D1 operation/financial rows, shard DO attempt journal, R2 immutable object digests and local receipt heads reconcile by authorization, operation, attempt, generation and release identity. | Any layer can terminalize with a missing/mismatched peer, or local disk becomes the sole global truth. |
| External closure | An independent signer signs the exact local-seal and candidate identity; a separate immutable-retention system proves object identity, retention mode/deadline and denied overwrite/deletion; restore is reverified independently. | Signature substituted for retention, retention substituted for signer approval, unverified backup restore or mutable external head. |
| Data minimization | Receipts contain canonical identities, status, lengths and digests only; no bearer/API key, raw request/response body, tenant ID, model secret or provider credential appears in filenames, JSON, logs or external anchors. | Secret/body leakage, tenant-derived path, unbounded payload or diagnostic output that changes authorization behavior. |
| Rollback | Disable admission first, preserve all receipts/markers/candidates/head sets/seals, return traffic to Go/VPS, and create a new authorization for any retry. | Delete/truncate/rewrite history, reopen a sealed authorization or combine rollback with a ring-secret change. |

The committed implementation already has no-follow descriptor-relative
staging creation, no-replace publication, sync/readback, installed-artifact
single-link checks, immediate publication UID/GID/mode/inode/link binding,
terminal-candidate recovery, local aggregate closure and a retained
parent/authorization lock capability. Capacity and reserve's per-operation
subtree now use retained dirfds, including direct entry scans and start
publication. Reserve's execution chain, head set, local seal, terminal
candidate and authorization-wide sibling audit now consume retained
descriptors and are rechecked before return. Finish and unfinished recovery
retain each operation descriptor and enforce exact candidate start and finish
binding. Terminal candidate, execution, head set, operation freeze, local seal,
recovery and verification now use one retained graph. Dedicated
UID/ACL/mount isolation against non-cooperative same-UID writers, true multi-process
replacement/kill campaigns, ext4/XFS power-loss, Container replacement,
independent DSSE and immutable-retention campaigns are not archived.

The current Rust evidence is
[run 30154588102](https://github.com/cinagroup/cinatoken-rust/actions/runs/30154588102):
formatting, 145 Linux tests and warning-free Clippy passed. Clean commit-object
evidence for the pinned Rust commit has Git tree
`c673790199bba2f1090654a4cfbc64b42c977934`, source-archive SHA-256
`08bd3fb6857222853381a72be72c2d2604f85638e3d22de9c92b524098b758d9`
and 31 required modules totaling 1637476 bytes with inventory SHA-256
`a2d6a538fca14072171642185e926db35a1b24837cbda526ec80abda37c0b140`.

Therefore the receipt filesystem is presently a local fail-closed candidate,
not a production authority and not a substitute for D1, DO SQLite or R2.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 Native Receipt Process and Syscall Mapping

The cinaVibeSDK Container topology remains the reference for process
lifecycle and replaceable local execution, while the new Rust evidence is a
cinatoken-specific financial/send authorization control. It must not be
attributed to cinaVibeSDK and does not make Container disk authoritative.

The Rust runner now exercises two real process boundaries. One independent
PID renames and recreates the terminal candidate closure while the writer
retains its descriptor graph; the writer rejects the drift and publishes to
neither inode. Another child publishes and syncs the operation head set while
holding the authorization lock, is killed with `SIGKILL`, and a fresh process
recovers the exact local seal twice without network access or a new send
capability.

The Linux workflow also traces the focused head-set recovery path. After the
first successful `flock(LOCK_EX)`, mutation through `AT_FDCWD` is forbidden,
while numeric-dirfd `openat2` and `renameat2`, descriptor chmod and directory
sync are mandatory. Read-only path identity checks remain allowed. This maps
the local execution plane to retained kernel objects, but durable business
authority still belongs in D1/DO state and immutable evidence still belongs
outside ephemeral Container storage.

The process test exposed an ordering bug: an unfinished closure attempt could
create empty terminal directories before returning
`unfinished_operation_chain`, causing a concurrent operation finish to see
`PredecessorMissing`. The Rust transaction now validates the operation state
before any terminal graph creation, and a regression proves that the failed
attempt leaves no terminal graph and that finish plus closure remain
available.

The frozen evidence is commit
`467fba330164841142c0cdd7c11658acd5605674`,
[run 30157298245](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245)
and
[job 89677148809](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245/job/89677148809):
147 Linux tests, the syscall gate, formatting and warning-free Clippy passed.
The clean source identity is Git tree
`215e80c3220756764afe9cd3ae0829a00a60a887`, archive SHA-256
`54bd395057dfedb4089ba344ad0835215ca717af75d7a440b6a35598363d1e90`
and inventory SHA-256
`ae61249e39efe9cb70ac855302837995d0ea59a0b22d388250f4157e49175b9f`
for 31 modules and 1649358 bytes.

This is focused recovery evidence, not a complete hostile same-UID campaign,
filesystem power-loss result, ACL/mount attestation, external receipt anchor
or Cloudflare lifecycle test. cinaVibeSDK's ephemeral Container model
therefore still requires D1/DO/R2 recovery and quarantine rules. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-25 Audited Linux Syscall Evidence Mapping

The Container execution-plane mapping now includes the verifier that decides
whether local Linux receipt evidence is admissible. This matters because a
replaceable Container process cannot rely on an unreviewed CI text search as
its durability proof.

The hardened cinatoken verifier consumes complete `%file` traces with `-yy`
descriptor identity, requires successful syscall results, tracks descriptor
and lock lifetime, and binds every successful mutation under the isolated
fixture root while both locks are held. It requires exact 4-lock recovery and
10-lock full-transaction protocols, so loss of the parent receipts lock cannot
pass unnoticed.

The verifier and its tests are part of the 33-module release inventory.
Candidate `938950b2f3057167d8cbf5749650681732006e0b` passed
[Ubuntu run 30159686961](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961)
and
[job 89682866508](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961/job/89682866508):
147 Linux tests, both syscall policies, formatting and strict Clippy passed.
Clean source has Git tree
`ed6bcf39865d4cb5ee695cf3f9e53577daa26881`, archive SHA-256
`6a03ced213ccd8837890b2cd7eb5b0903fb416749b3461c6ecbafd3dcf0e6293`
and inventory SHA-256
`6fe6f610a4835faa860d56076009cb8a70cff80fa6036919c0968c1bbb2b3222`.

This makes the local evidence gate stronger; it does not make ephemeral
Container storage authoritative. Candidate-after-sync `SIGKILL`, the rest of
the crash matrix, D1/DO/R2 recovery, image ACL/mount attestation and immutable
external evidence remain required. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-25 Candidate-Synced Process-Death Mapping

The cinaVibeSDK-derived Container remains a replaceable execution resource;
the new Rust gate proves only that one local cinatoken authorization boundary
can fail closed across real process death. The candidate writer uses retained
dirfds, publishes create-new, syncs the closure directory, reads the exact
object back and is then killed by the supervising workflow. Recovery runs in
a fresh process and reconstructs the unique accepted finish plus terminal
closure without network authority.

The four audited traces map to distinct responsibilities:

| Trace | Exact locks | Purpose |
| --- | ---: | --- |
| Focused recovery | 4 | Prepared head-set recovery and exact replay |
| Full terminal transaction | 10 | Reserve through terminal closure and recovery |
| Candidate writer | 4 | Durable candidate publication followed by real SIGKILL |
| Candidate recovery | 8 | Accepted finish, audit, closure and immutable replay |

Every trace rejects successful post-lock unconfined mutation. The candidate
writer additionally proves the same PID performed rename, closure sync and
object-bound readback before `SIGKILL`; the recovery process proves zero
ambiguous outcomes. The startup path completes candidate recovery before
credential verification can construct the HTTP core, so restart does not
restore a POST capability.

The frozen evidence is
`43b1536f0e1f075d27c249ca849f7e67a7655b89`,
[run 30162862290](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290),
[job 89690905464](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/job/89690905464)
and
[artifact 8620731294](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/artifacts/8620731294).
Ubuntu passed 148 library tests and strict Clippy; local gates passed 127
library tests, 3 binary/CLI tests and 72 Bun tests with 276 expectations.

Clean source identity is Git tree
`5a1c408426534d6a27ad7fa1d5b71edf0c2f3f5e`, archive SHA-256
`8c41a77cb0f366e02f6eb3a689669f31ea71654abdf4f53eb8913cc590f63923`
for 36003840 bytes, and inventory SHA-256
`534170adf68de8e647bdd9b0382d00097f5b665df1b356aa6e2466c4d9427e7b`
for 34 modules / 1719654 bytes.

This evidence does not make Container disk the source of truth. cinaVibeSDK's
replaceable execution model still requires D1/DO/R2 reconstruction and
quarantine. The narrower concurrent receipt-store recovery is mapped below;
real dual startup, the remaining crash sweep, production image ACL/mount
attestation, power-loss and restore campaigns, and external immutable evidence
remain open. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Concurrent Receipt-Store Recovery Mapping

The cinaVibeSDK replaceable-Container model requires local recovery to converge
without turning Container disk into business authority. The new Rust gate
tests that local invariant with two independent processes and one shared
candidate fixture. Exactly one process appends the candidate-bound accepted
finish; the other is a read-only replay, and both converge on one sealed
closure identity.

The evidence mapping is:

| cinaVibeSDK concern | Rust/Cloudflare evidence | Remaining boundary |
| --- | --- | --- |
| Replaceable process | Two independent process PIDs validate the fixture before one shared release gate. | Not yet two real credential-verification startup processes. |
| Lock linearization | The actual Rust worker TIDs are separately reported and exactly match two strace lock identities; six locks per TID, twelve total. | Blocking root `flock` has no bounded timeout or availability proof. |
| Idempotent recovery | Unfinished counts are exactly `1:0` or `0:1`; both workers return one closure identity and the final store has one accepted finish. | Candidate-finish-before-plan and remaining receipt-prefix crashes are open. |
| Least mutation | A read-only loser is legal, while bundle union evidence must prove one complete retained-dirfd mutation path and reject two read-only traces. | Zero `socket`/`connect` syscall evidence is not yet captured. |
| Durable evidence | Raw straces, process outputs, PID files, verifier JSON and boundary JSON are configured in one 30-day artifact. | External signature/WORM, ext4/XFS power loss, restore and production mounts remain open. |

Frozen evidence is candidate
`aaa52936765ec47afdc2871ccab4fd2e6115ffbd`,
[run 30183935884](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884),
[job 89745204486](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/job/89745204486)
and
[artifact 8626449986](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/artifacts/8626449986).
Ubuntu passed 148 library tests, exact 4/10/4/8 standalone traces, 6+6
concurrent traces and strict Clippy. GitHub reports artifact digest
`sha256:a97bb267dd8e24d81f5bf16c3e7dd258107ebc251032cd1ee7f3132cb6b2a589`;
the candidate Git tree is `fb8a9ae44621e0c04b57496393391e56762601ff`.

At that candidate this closed only the local receipt-store mapping. The real
dual-startup network-observation mapping is below. Run `30183488782` left one
non-reproduced Linux full-suite failure, so repeated soak remains required.
D1/DO/R2 reconstruction, real Container lifecycle, image isolation,
power-loss/restore, external evidence and G1-G8 remain production gates.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Real Dual-Startup Network Observation Mapping

cinaVibeSDK treats Container processes as replaceable and forbids recovery
from silently creating a second remote effect. The Rust gate now maps that
principle to the real startup entrypoint, not only the receipt-store helper.
Two independent, environment-cleared child processes execute
`verify_loaded_credentials()` concurrently, recover the same local terminal
closure, return no HTTP core and replay `ReceiptSealed`. The production path
handles the losing `AlreadySealed` race by reading the installed closure
rather than constructing transport authority.

| cinaVibeSDK concern | Rust/Cloudflare evidence | Remaining boundary |
| --- | --- | --- |
| Replaceable startup | Two process PIDs and two current-thread Tokio TIDs execute the real startup path behind one shared gate; a third startup performs immutable replay. | This is a Linux test fixture, not a real Cloudflare Container restart/eviction campaign. |
| Exact observation scope | Unique create-new start/finish paths bind one complete syscall window to each reported worker TID. | Marker windows are observation boundaries, not kernel policy. |
| No startup egress | 3880 syscalls inside two windows contain zero successful or failed `%network` attempts. Outside-window network calls are pinned to exactly three `socketpair`; every other name fails globally. | Inherited socket use through ordinary `read`/`write`, `sendfile` or `io_uring` is not covered. |
| Fail-closed concurrency | `AlreadySealed` from initial audit or unfinished recovery can return only the verified installed terminal closure; no HTTP core or mutation outcome is produced. | Blocking `flock` still has no deadline; schedule soak is incomplete. |
| Evidence privacy | Structured summaries/logs/PIDs are separate from successful raw traces; failed raw traces retain for only seven days. | External signing/WORM and production log-classification policy remain open. |
| Durable authority | Local closure identity and direct post-close audit are stable after both startup processes. | Container disk remains replaceable; D1/DO/R2 reconstruction and quarantine still control production authority. |

Frozen acceptance is candidate
`eb90c27af35b56e169b64e676eba2bbb37d0fe15`, Git tree
`cf9a63b698c35b8addaa97c7d84bb69f46ebbfa1`,
[run 30186091600](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600)
and
[job 89750973529](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/job/89750973529).
Ubuntu passed 149 library tests and strict Clippy. The trace parsed 7252
syscalls across six identities, reconciled 64 unscoped split lines and
accepted only the exact three-`socketpair` outside-window baseline.

[Summary artifact 8627086351](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086351)
is 14803 bytes with digest
`sha256:91720d03fd24d8daf49609671d84a238db8b1df0bf1a331b97c8ec6d01b30f5f`;
[raw trace artifact 8627086439](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086439)
is 123728 bytes with digest
`sha256:d177ca95b21a796e3f686644f24af3563079377a7e34d938d0e7fff063bceb95`.
Both expire `2026-08-25T03:24:49Z`.

The negative runs `30184982382`, `30185436031` and `30185637997` record why
process-wide, raw-TID-only and reject-all-split-line claims were unsound. The
accepted scope is deliberately narrower and auditable. It does not authorize
customer traffic, replace network namespace/seccomp/FD-isolation evidence, or
close bounded locking, power-loss/restore, external WORM, Cloudflare
lifecycle or G1-G8. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-26 Bounded Receipt Lock Mapping

The bounded-lock increment closes the specific blocking-wait gap above without
changing cinaVibeSDK's authority split. The local Container filesystem remains
an execution cache; D1/DO state and externally retained evidence remain the
reconstruction and quarantine authority.

| cinaVibeSDK concern | Rust/Cloudflare evidence | Remaining boundary |
| --- | --- | --- |
| Replaceable startup latency | Receipts-root and authorization locks share one 5-second `CLOCK_MONOTONIC` deadline; the second lock receives no fresh budget. | The fixed budget still needs real Cloudflare Container cold-start and eviction SLO calibration. |
| Cooperative lock behavior | Production uses only `LOCK_EX | LOCK_NB`; 10-millisecond retries use absolute monotonic sleep. | A peer sharing the runner UID can ignore advisory locks; dedicated identity and mount isolation remain mandatory. |
| Fail-closed error ownership | Timeout and system failures are typed separately with scope, operation and errno; unexpected errors are never treated as contention. | Operational alert routing and remote Container restart/quarantine evidence remain open. |
| Transaction continuity | Root precedes authorization; authorization retries require root ownership; failure of the second lock releases the first without creating receipt objects. | D1/DO reconstruction still decides whether a new Container may resume. |
| Auditable nondeterminism | Successful lock counts stay exact, while attempts/retries/sleeps are disclosed. The accepted run observed 45 receipt-recovery and 34 startup contention retries, each paired with a monotonic sleep. | Repeated schedule soak and process-level startup timeout evidence remain open. |
| Startup egress boundary | The same accepted startup trace reports zero blocking lock attempts and zero network attempts in both real startup windows. | This remains syscall observation, not network namespace, seccomp or inherited-FD isolation. |

Frozen acceptance is candidate
`d96753c5fe90cc59d0ea539be346c27285fbdb69`, Git tree
`a7a8c8aaa4ce97506432b21f84672c1af7636634`,
[run 30187560531](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531)
and
[job 89754869675](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/job/89754869675).
Ubuntu passed formatting, 154 library tests, all trace policies and strict
Clippy. Concurrent receipt recovery reported 12 successful locks from 57
attempts and 45 monotonic contention sleeps. Concurrent real startup reported
24 successful locks from 58 attempts, 34 monotonic contention sleeps, zero
blocking attempts, 7008 parsed syscalls, 3456 scoped syscalls and zero scoped
network attempts.

[Summary artifact 8627504413](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504413)
is 15924 bytes with digest
`sha256:f6ed76b44a6232ec388ed4a3d1f7ff31974b23c018ace23af7f99697ace09583`.
[Successful raw trace artifact 8627504519](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504519)
is 120805 bytes with digest
`sha256:2390b75f13b58f315b88b64e3f4096e95f203af82489d17d80c12df3da33b720`.
Both expire `2026-08-25T04:19:18Z`.

Runs
[30187320790](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187320790)
and
[30187432173](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187432173)
remain negative evidence for a legitimate concurrent `AlreadySealed` loser
and an unrelated relative harness sleep interrupted by deliberate `SIGKILL`.
The corrections preserve exact closure replay and retain monotonic-sleep
enforcement on every real retry path.

This does not make Container disk authoritative or approve cutover. Real
Container lifecycle, startup lock-timeout propagation, D1/DO/R2 recovery and
quarantine, production image UID/GID/ACL/mounts, power-loss/restore, external
immutable evidence and G1-G8 remain open. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-26 Real Startup Lock-Timeout Mapping

The process-level timeout campaign now closes the remaining local propagation
item in the bounded-lock mapping. It does not change cinaVibeSDK's production
authority split.

| cinaVibeSDK concern | Accepted Rust/Cloudflare evidence | Remaining boundary |
| --- | --- | --- |
| Replaceable startup under a stuck peer | An independent process holds the exact receipts-root lock while a separate current-thread Tokio process runs real `verify_loaded_credentials()` and returns the typed 5-second root timeout in 5,002ms. | Repeat under actual Container cold-start, eviction and replacement schedules; calibrate alert/SLO policy without enlarging the business deadline. |
| No accidental authority while blocked | The scoped trace has 491 contention attempts, 491 absolute monotonic sleeps, zero successful locks, zero network syscalls and zero HTTP exchange construction. | Syscall observation is not network namespace, seccomp or inherited-FD denial. |
| Replaceable local filesystem | Descendant path/type/device/inode/mode/link-count/content snapshot is identical before lock release; after release, real startup safely recovers `ReceiptSealed`. | D1/DO/R2 reconstruction, quarantine and remote replacement remain the authority. |
| Holder continuity | The parent continuously checks that the holder process remains alive until the timeout child exits; internal and workflow watchdogs bound hangs. | Production supervisor ownership, PID namespace and kill/eviction evidence remain open. |
| Auditability | Timeout evidence is isolated from successful concurrency traces and produces a verifier JSON, boundary manifest and raw trace with candidate/digest retention. | Repeated schedule distributions and externally signed immutable retention remain open. |

Frozen acceptance is candidate
`56acfce31dbe5e154dd5450d5112882aef4f5dbd`, Git tree
`d4e6fe556049047745638c1d653b3d0edb50f426`,
[run 30188739169](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169)
and
[job 89757895460](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/job/89757895460).
Ubuntu 24.04.4 passed 156 library tests, formatting, all native trace policies
and strict Clippy. The 5,002ms timeout window parsed 1,008 scoped syscalls and
proved 491 contention/sleep pairs, zero successful locks, zero scoped network
and zero HTTP exchange construction.

[Summary artifact 8627833392](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833392)
is 18671 bytes with digest
`sha256:370e16a6f46c4a0156ca7288e6a4280a4a9b72550a61086ae8ebc2f447c0288a`;
[raw trace artifact 8627833482](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833482)
is 150104 bytes with digest
`sha256:337a52b48e2e1be92b674f05120a128831d34f41da0008bf65a1c7f1a88ddfb1`.
They expire `2026-08-25T05:04:15Z` and `2026-08-25T05:04:16Z`.

This closes a local K7 sub-gate only. Repeated local schedule soak is closed by
the mapping below. Production image identity/filesystem attestation,
power-loss/restore, external WORM evidence, Cloudflare lifecycle and G1-G8
remain open. Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Repeated Startup Schedule Mapping

The local replaceability mapping now includes a bounded 32-iteration
dual-process schedule campaign.

| cinaVibeSDK concern | Accepted Rust/Cloudflare evidence | Remaining boundary |
| --- | --- | --- |
| Repeatable replacement startup | 32 independent exact Rust test invocations all completed; each fixture's two startup processes converged on equal terminal closure evidence and returned `ReceiptSealed`, then safe replay/recovery passed. | The campaign runs on one Ubuntu host, not real Cloudflare cold-start, eviction or shard replacement schedules. |
| Participant isolation | Every admitted sample contains two unequal process PIDs and two unequal current-thread Tokio lock TIDs. | This proves process/thread separation inside the test host, not production PID/user/mount namespaces. |
| Bounded latency | Per-iteration elapsed time was 173-177ms under a 15,000ms watchdog; all 32 iterations completed in 6,133ms under the independent 120,000ms campaign budget. | Production SLO calibration must include image pull, placement, cold start, eviction and regional load. |
| Auditable nondeterminism | All 32 NDJSON samples are embedded in the boundary manifest and bound by `sha256:c72f8ad9a5b80ec88af002883bc33c0d1673c31532184f931fb04639a9bdc1d4`. Seven cross-fixture closure identities were observed but are not pinned. | External signed immutable retention and long-duration distribution analysis remain open. |
| Syscall claim discipline | Policy `single-captured-sample-plus-process-soak-v1` explicitly binds the campaign to one separate successful startup trace instead of claiming 32 traced runs. | Network namespace, seccomp and inherited-FD denial are still not demonstrated. |

Frozen acceptance is candidate
`01c04940c77610a0d98a3feb61fa235724838d58`, tree
`2f2ecc7d93da479d8ebf19e39f880da965c50af7`,
[run 30189628276](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276)
and
[job 89760384170](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/job/89760384170).
Ubuntu 24.04.4 passed 156 library tests, formatting, all syscall policies and
strict Clippy.

[Summary artifact 8628118657](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118657)
contains 24 files, is 28940 bytes and has digest
`sha256:b83cb16e39540e6dc25ec34c5f6ea4562bddcf2faca8f4f9d2054c0ce4e710e0`;
[raw trace artifact 8628118769](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118769)
contains eight traces, is 149155 bytes and has digest
`sha256:16d0a7c08df3b6d62e5776790632d51d8c429a0dcbe06af390982390da624e7e`.
They expire `2026-08-25T05:36:45Z` and `2026-08-25T05:36:46Z`.

Run
[30189502740](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189502740)
preserves the useful negative calibration: 32 exact tests passed, while an
invalid cross-fixture single-closure assertion failed. The accepted mapping
scopes equality to each participant pair.

This closes local repeated scheduling only. Production image identity,
Cloudflare lifecycle replacement, power-loss/restore, external WORM evidence
and G1-G8 remain open. Go/VPS remains authoritative and production remains
**NO-GO**.

## 2026-07-25 Full Terminal Transaction Syscall Mapping

The cinaVibeSDK-derived Container model treats local disk and processes as
replaceable execution resources. The Rust runner now tests the corresponding
cinatoken-specific rule across a complete local terminal transaction: one
independent process reserves an exact read, installs and finishes its terminal
candidate, installs the closure and recovers the same closure. A fresh parent
store then verifies the recovered execution head against the frozen snapshot
plan.

The second `strace` gate maps this workflow to retained Linux kernel
capabilities. After the first exclusive lock, mutation through `AT_FDCWD` is
forbidden. Full-transaction evidence must include at least five exclusive
locks, numeric-dirfd `mkdirat`, `openat2` and `renameat2`, descriptor chmod and
directory sync. The narrower prepared-recovery trace remains independently
enforced with a two-lock minimum.

Local verification passed for
`11c938720875dee8da5d19481a3b39a03bda9c84`, including 126 Rust library
tests, 3 binary/CLI tests and 61 Bun tests with 242 expectations. Its clean
source identity is Git tree
`82d824341ccf6188a4515c4ff2373c3793d7ee86`, archive SHA-256
`f4605c6af5c6924da2262d9531929cd65e4e0b979bb5fcd36b62afc59aad7672`
and inventory SHA-256
`2cc6f847b14da90f66ff0c3b4f82e72d8e60b0fc520ba6718841263e57dc24ab`.

The matching Ubuntu run is still required. Two attempts produced no jobs
during the official GitHub Actions outage and are not counted as either pass
or code failure. This reinforces the production design: Container-local
receipts are fail-closed execution evidence, while durable authority and
recovery must remain anchored in D1/DO/R2 and immutable external evidence.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Container Runtime Isolation Mapping

The cinaVibeSDK topology remains the design authority for lifecycle
supervision: a Durable Object owns one Container instance, reconstructs
disposable compute, and keeps durable state outside the process. The Rust
target now adds a concrete local image/process proof for that disposable
compute boundary.

| cinaVibeSDK design responsibility | cinatoken-rust production mapping | Current evidence |
| --- | --- | --- |
| DO supervises disposable Container lifecycle | Controller/DO remains the owner; `cinatoken-container-runtime` is replaceable compute | Local image starts, stops with SIGTERM, restarts, and retains build/policy identity |
| Container runs with minimum privilege | Distroless nonroot PID 1, UID/GID 65532, all capability sets zero, NNP and seccomp enabled | Accepted Ubuntu/Docker process attestation |
| Image is immutable application code | Read-only overlay root; root-owned 0755 binary and layout; no writable application mount | Exact path, mount, owner/mode, and ACL inventory |
| Ephemeral scratch is explicit | Only `/tmp` is provisioned as private 16 MiB 0700 tmpfs for the application | HostConfig plus PID 1 mountinfo agree |
| Network access is topology-controlled | Internal network, no host-published port, no caller bind/device mount | Docker inspect and in-network probe |
| Process inheritance is bounded | Standard descriptors fixed; only socket/event-loop pseudo descriptors allowed | 12 primary and 10 restart FDs; stable policy, no path-backed leak |
| Durable authority is external | D1/DO/R2 continue to own operation, financial, receipt, and recovery truth | Architectural rule only; no new remote evidence claimed |

The accepted candidate is
`304a8c1569db9c479430ef003379cc55d688ce54`, tree
`66e7ecdbad0430ba38ef120be1957d202afbb170`, from
[run 30192249580](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580).
The image identity is
`sha256:85b333c3804a82031359929ea422baf98f35aed15e3062bff95ba0744f86f9e6`;
the runtime policy identity is
`sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`
for both initial and restarted instances. The retained
[artifact 8628969468](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/artifacts/8628969468)
is 2761 bytes with ZIP digest
`sha256:c9d7d549c39e6879cf1cb29f7ea1982f93f4c39a537d5381037935c30686964a`
and expires `2026-08-25T07:08:57Z`.

The mapping is intentionally asymmetric. Local Docker proves the code-owned
image and PID 1 policy, but only authenticated Cloudflare staging can prove the
managed host runtime, Container class/version, namespace and cgroup behavior,
DO lifecycle replacement, outbound policy, and deployed provenance. The next
mapping evidence must join those remote observations to the same image,
runtime-build, policy, Controller deployment, and shard generation identities.
Until that join and the remaining durability/financial/cutover gates pass,
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Reproducible Image Mapping

The cinaVibeSDK lifecycle model assumes that a DO can discard and replace a
Container without changing the executable workload. `cinatoken-rust` now
enforces the local prerequisite for that assumption: two independent,
no-cache builds from one source candidate must resolve to the same Docker image
identity before lifecycle behavior is tested.

| cinaVibeSDK responsibility | Rust/Cloudflare mapping | Accepted local proof | Still required remotely |
| --- | --- | --- | --- |
| Replacement instances run one immutable workload | Controller and DO must name a digest-bound image, never a mutable tag | Two builds have image ID `sha256:6a2f92415570e2b13e033b8c0d3d1acaadccf2bfa60ebd8d63faa359b687c514` | Registry manifest/index digest and Cloudflare deployment readback |
| Build timestamps do not create false versions | Normalize source epoch and every final application-path mtime | Exact 19-layer RootFS and config equality | Independent-host and pinned-builder reproduction |
| Disposable processes share executable bytes | Runtime root is root-owned and binary is copied out and hashed independently | Both binaries and live readiness equal `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` | Cloudflare instance build-ID sampling across cold starts and evictions |
| Lifecycle replacement preserves security policy | Rebuild identity is joined to process attestation | Primary/restart policy remains `sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d` | Managed namespace, cgroup, mount, FD, and outbound-policy evidence |
| Durable authority remains external | Reproducible compute is still not a durable source of truth | D1/DO/R2 authority remains unchanged | Fault campaign joining operation, shard, deployment, image, and policy IDs |

The accepted candidate is
`cbe749907931435e280686c9b8c935b08fdd085f`, tree
`0a21ce473d857fbcfc2adc60a5e7362bd7784bff`, from
[run 30194108625](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625).
[Artifact 8629556865](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/artifacts/8629556865)
is 7822 bytes with digest
`sha256:1bfac70cb2dd38418da1115ef5b6a15a67b46bb893fd00076a1cc5e8fe2b8ffe`
and expires `2026-08-25T08:10:57Z`.

This mapping closes local replacement-byte equivalence only. Registry
compression and manifest identity, SBOM/provenance signatures, Cloudflare
digest installation, lifecycle distribution, and external immutable evidence
remain open. The mapping does not authorize a mutable image tag, remote
deployment, or traffic. Go/VPS remains authoritative and production remains
**NO-GO**.

A docs-only successor independently repeated this mapping in
[run 30194409010](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010):
image ID, all 19 layer identities, binary/build identity, runtime policy, and
the complete attestation JSON remained unchanged. The successor packet is
[artifact 8629649636](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010/artifacts/8629649636),
7828 bytes with digest
`sha256:ccef6562a6fa8d2774ef196a152c55506472e6c264bffe53c8aab1443c0d7648`.
Host-local `GraphDriver` paths and tag time changed and are correctly excluded
from portable image identity. The cinaVibeSDK replacement assumption now has
two independent local-job proofs; Cloudflare digest installation and
lifecycle equivalence remain open.

## 2026-07-26 OCI Subject Reproduction Mapping

The cinaVibeSDK replacement model requires more than equal uncompressed
RootFS state: the distributable Container subject must also be stable at the
OCI boundary. The Rust migration now maps that requirement to two distinct,
digest-pinned BuildKit instances and byte-identical OCI exports.

| cinaVibeSDK responsibility | Rust/Cloudflare mapping | Accepted proof | Still open |
| --- | --- | --- | --- |
| Replacement uses one distributable subject | Freeze OCI index, platform manifest, config, compressed layers, and diffIDs | A/B tar bytes and complete 19-layer graph are exact | Independent-runner repetition and registry readback |
| Executable identity survives packaging | Join the final OCI layer to runtime readiness/build identity | OCI binary is `1ec31f...`, equal to both prior Docker images and live readiness | Cloudflare cold-start sampling |
| Builder drift is bounded | Two separate BuildKit `v0.31.2` daemon instances use one pinned image digest and compatibility contract | Distinct worker hostnames produced the same tar SHA-256 | Pinned Dockerfile frontend and independent host/client |
| Supply-chain evidence does not mutate the subject | Generate SBOM/provenance later as digest-bound referrers | Default attestations are explicitly disabled for the reproduction baseline | Pinned SBOM, scan, DSSE signature, transparency and WORM |
| Durable authority stays outside the Container | OCI bytes are executable evidence, never operation or financial truth | No D1/DO/R2 authority changed | Remote lifecycle and recovery joins |

Candidate `383f53f5559674a9947b1939993ef2d9bdf0dd6a` passed
[run 30196543635](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635).
Both 10,378,752-byte archives hash to
`bdd67bd4335a922081e35fe344fb481599730ec37a3833d17fea85407852fb7e`;
the OCI index is `258828d4...`, the platform manifest is `84ff0214...`,
the config is `7b1326fd...`, and all 19 compressed layers and diffIDs match.
[Artifact 8630296572](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/artifacts/8630296572)
is 20,767,686 bytes with
`sha256:8ccbf80f44f8d134579b89f4cde8806d7f1460ee33524b27244ee5c8ed4d8014`
and expires `2026-08-25T09:31:03Z`.

This mapping is deliberately `reproducible-only`. It does not claim an
authenticated registry digest, SBOM, provenance, scan result, signature,
Cloudflare deployment, P5 eligibility, customer traffic, or production
authority. Go/VPS remains authoritative and production remains **NO-GO**.
