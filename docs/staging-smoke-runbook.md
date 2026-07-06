# Staging Smoke Runbook

Date: 2026-06-22

Status: first detailed smoke runbook for the Rust/Cloudflare staging
environment. This runbook supports G1, G3, G4, G5, G6, and G7 in
`docs/production-migration-execution-plan.md`.

## Purpose

Use this runbook to prove that a staging Worker behaves like a production
candidate before any customer canary. It is intentionally evidence-heavy: every
step should leave a request ID, log entry, command output, dashboard screenshot,
or short report.

Use `docs/cloudflare-production-config-checklist.md` before Phase 1,
`docs/route-provider-parity-runbook.md` before Phases 3 and 4,
`docs/data-migration-runbook.md` before Phase 7,
`docs/billing-parity-runbook.md` before Phase 5, and
`docs/admin-frontend-parity-runbook.md` before Phase 8, and
`docs/observability-slo-security-runbook.md` before Phase 9, and
`docs/performance-capacity-cost-runbook.md` before Phase 10. Use
`docs/cutover-rollback-runbook.md` before any G7 canary.

Do not use production secrets in staging. Do not paste secret values into this
file or any smoke report.

## Preconditions

Required local state:

- Clean git worktree or an intentionally documented test branch.
- `bun run check` passes.
- `cargo test -p cinatoken-worker --lib` passes.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes.
- `worker-build` installed for Wrangler dry-run/startup checks.
- Latest `@cloudflare/workers-types` fetched or local generated types refreshed
  after binding changes.

Required Cloudflare staging resources:

- Staging Worker.
- Staging D1 database with migrations applied.
- Staging KV namespaces if still configured.
- Staging R2 bucket if file/task artifacts are enabled.
- Staging queues and DLQ if log/task queue producers are enabled.
- Staging Upstash Redis database or isolated staging key prefix.
- Workers Logs/Traces enabled with the staging sampling policy.
- Staging route or custom domain.
- Staging WAF/rate-limit/CORS policy.

Required secrets, set out of band:

- Upstash REST URL/token.
- At least one low-risk upstream provider key for non-stream relay.
- At least one upstream provider key for SSE relay.
- Any payment/OAuth/Turnstile/JWT/session secrets required by the tested route.
- Admin bootstrap secret, if admin routes are tested.

## Evidence Template

Create a smoke report with these fields:

```text
Date:
Commit:
Wrangler version:
Worker name:
Staging URL:
D1 database:
KV namespaces:
R2 bucket:
Queues:
Upstash environment:
Provider families tested:
Smoke operator:
Rollback operator:
Overall result:
Known deviations:
```

For each request, record:

```text
Case ID:
Route:
Request body class:
Expected status:
Actual status:
Worker request ID:
Upstream request ID:
Token fingerprint:
Channel ID:
Model:
Latency:
Usage fields:
Quota delta:
Log/traces link:
Pass/fail:
Notes:
```

## Phase 0: Static Preflight

Run from `C:\cinagroup\cinatoken-rust`:

```powershell
git status --short --branch
bun run check
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
git diff --check
```

If `worker-build` is installed, also run:

```powershell
bun run check:cf:dry-run
bun run check:cf:startup
```

Pass criteria:

- No test failures.
- No formatting or whitespace errors.
- Cloudflare dry-run/startup checks pass, or the missing local dependency is
  recorded as a known local limitation.

## Phase 1: Cloudflare Binding Smoke

Deploy or update staging using the configured staging command.

Record:

- Wrangler command used.
- Worker version or deployment ID.
- Compatibility date.
- Compatibility flags.
- Generated binding type command/result.
- Observability sampling policy.

Smoke `/api/status`:

```powershell
Invoke-RestMethod -Method GET "$env:STAGING_BASE_URL/api/status"
```

Pass criteria:

- Staging Worker responds successfully.
- D1 feature reports configured.
- Upstash/Redis feature reports configured when expected.
- Environment is staging, not development.
- Logs/traces show the request.

## Phase 1b: WFP Dispatch Smoke

Run this only after the staging dispatch namespace exists, the tenant Worker is
uploaded, and `WFP_DISPATCH_ENABLED=true` plus
`WFP_INTERNAL_DISPATCH_ENABLED=true` are enabled in staging. The default smoke
checks the admin-authenticated internal dispatch path and tenant status route
without sending an AI request:

```powershell
$env:WFP_SMOKE_URL = $env:STAGING_BASE_URL
$env:WFP_SMOKE_COOKIE = "session=<redacted admin session cookie>"
bun run smoke:wfp-dispatch -- --url $env:WFP_SMOKE_URL --worker tenant-smoke --cookie $env:WFP_SMOKE_COOKIE --expect-runtime rust-wasm --json
```

If the tenant has staging `CF_ACCOUNT_ID`, `CF_API_TOKEN`, and AI Gateway ID
bindings, run one explicit AI route smoke with a low-risk payload:

```powershell
bun run smoke:wfp-dispatch -- --url $env:WFP_SMOKE_URL --worker tenant-smoke --route /v1/responses --body '{"model":"gpt-4o-mini","input":"wfp dispatch smoke","max_output_tokens":1}' --cookie $env:WFP_SMOKE_COOKIE --expect-runtime rust-wasm --json
```

If the generated JS fallback is being tested deliberately, rerun the same smoke
with `--expect-runtime js-fallback` and record it separately from the
Rust/Wasm artifact evidence.

Record:

- Command output.
- Admin-authenticated smoke evidence only; do not paste the raw
  `WFP_SMOKE_COOKIE` value into the report.
- Tenant status body, including `runtime`, `forwarding`, `body_mode`, routes,
  per-route gateway configuration, `ai_gateway_request_policy`,
  `inbound_sensitive_headers_present`, `inbound_dispatch_route`, and
  `inbound_dispatch_worker`.
- `x-cinatoken-wfp-route`, `x-cinatoken-wfp-worker`,
  `x-cinatoken-wfp-tenant`, and `x-cinatoken-wfp-runtime` headers.
- AI Gateway log entry for any opt-in POST route smoke.
- Worker log/trace link for both the main dispatch Worker and the tenant
  Worker.

Pass criteria:

- The same internal dispatch URL without an admin session fails with 401/403,
  while authenticated admin smoke reaches the tenant status route through
  `/api/platform/dispatch/:worker/...`.
- Default WFP dispatch smoke proves the uploaded Rust/Wasm artifact by
  requiring `runtime: "rust-wasm"` in the tenant status body and
  `x-cinatoken-wfp-runtime: rust-wasm` in response headers. Generated fallback
  evidence is accepted only when the command explicitly uses
  `--expect-runtime js-fallback`.
- `forwarding` is `cloudflare-ai-gateway-rest`, `body_mode` is streamed, and
  every supported tenant AI route appears in the route manifest.
- `ai_gateway_request_policy` is present. Any configured policy entry must be
  `valid=true`; invalid tenant policy binding values fail smoke before route
  forwarding evidence is accepted.
- `inbound_sensitive_headers_present` is `false` and
  `inbound_sensitive_headers` is an empty array, proving the dispatch Worker
  stripped the admin cookie, relay/API-key headers, Cloudflare Access client
  headers, and `x-cinatoken-*` platform markers before invoking the tenant
  Worker.
- Tenant status reports `inbound_dispatch_route: "internal-path"` and
  `inbound_dispatch_worker: "<worker>"`, proving the main Worker injected the
  controlled internal-dispatch markers after stripping caller-supplied platform
  markers.
- Dispatch headers identify `internal-path` and the public tenant worker name.
- Optional AI route smoke returns the expected staging status and safe
  response headers only; raw authorization, `cf-aig-*`, and upstream
  `x-cinatoken-*` headers are not exposed to the caller.
- Tenant AI route smoke only passes through the admin-authenticated internal
  dispatch path. Preview-host/public AI attempts must either remain disabled or
  return `403 tenant_internal_dispatch_required`; the tenant status route may
  still be used for non-AI preview diagnostics.

## Phase 2: Auth And Rejection Smoke

Cases:

| Case ID | Request | Expected |
| --- | --- | --- |
| AUTH-001 | Relay request without token | 401/403 compatible error, no quota mutation |
| AUTH-002 | Relay request with malformed bearer token | 401/403 compatible error, no quota mutation |
| AUTH-003 | Relay request with disabled/expired/exhausted token | Correct rejection and token status handling |
| AUTH-004 | Relay request from disallowed IP when allowlist exists | Correct rejection, no upstream call |
| AUTH-005 | Valid token for unsupported model | Correct model-limit rejection |

Pass criteria:

- No upstream request occurs on rejection.
- Logs are redacted.
- Token/user/channel identifiers are traceable by fingerprint or ID.
- No raw token value appears in logs.

## Phase 3: Non-Stream Relay Smoke

Use `docs/route-provider-parity-runbook.md` for route/provider scope,
body-mode policy, provider adapter evidence, live smoke fields, and failure
mode cases.

Minimum first-canary cases:

| Case ID | Route | Provider Family | Expected Evidence |
| --- | --- | --- | --- |
| RELAY-JSON-001 | `POST /v1/chat/completions` | OpenAI-compatible | Status 200, usage parsed, quota settled, audit log |
| RELAY-JSON-002 | `POST /v1/embeddings` | OpenAI-compatible | Batch usage parsed, response bounded |
| RELAY-JSON-003 | `POST /v1/rerank` | Jina or Cohere | Provider-specific usage parsed |
| RELAY-JSON-004 | `POST /v1/messages` | Anthropic | Message usage parsed |
| RELAY-JSON-005 | `POST /v1beta/models/{model}:generateContent` | Gemini | `usageMetadata` parsed |

Pass criteria:

- Correct upstream URL and headers.
- Model mapping matches source expectations.
- Channel selection respects provider family.
- Usage fields populate audit metadata.
- Reserve/refund/settlement behavior matches the billing mode under test.
- Response body handling is bounded or streamed according to the route policy.

## Phase 3b: Main Relay AI Gateway Canary Smoke

Run this only after:

- `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID`, and
  `CLOUDFLARE_AI_GATEWAY_TOKEN` or a scoped `CLOUDFLARE_API_TOKEN` are
  configured in staging.
- `RELAY_AI_GATEWAY_ROUTER_ENABLED=true` is enabled in the staging Worker only.
- One staging channel has been enabled through the channel editor
  **Cloudflare AI Gateway canary** switch, producing
  `channels.other_info.ai_gateway.enabled=true`.
- The channel's model mapping resolves the test model to a Cloudflare
  AI Gateway provider-prefixed model such as `openai/gpt-4.1`.

First run the dry-run plan:

```powershell
bun run smoke:relay-ai-gateway -- --dry-run --json --url $env:STAGING_BASE_URL --model openai/gpt-4.1
```

Then run the live low-token canary. This command is deliberately gated by
`--confirm-live` because it can call a paid upstream provider:

```powershell
$env:RELAY_AI_GATEWAY_SMOKE_COOKIE = "session=<redacted admin session cookie>"
$env:RELAY_AI_GATEWAY_SMOKE_API_KEY = "<redacted staging relay token>"
bun run smoke:relay-ai-gateway -- --url $env:STAGING_BASE_URL --cookie $env:RELAY_AI_GATEWAY_SMOKE_COOKIE --api-key $env:RELAY_AI_GATEWAY_SMOKE_API_KEY --model openai/gpt-4.1 --expect-router-ready --confirm-live --json
```

For Anthropic-schema canaries, use:

```powershell
bun run smoke:relay-ai-gateway -- --url $env:STAGING_BASE_URL --endpoint messages --model anthropic/claude-sonnet-4-5 --cookie $env:RELAY_AI_GATEWAY_SMOKE_COOKIE --api-key $env:RELAY_AI_GATEWAY_SMOKE_API_KEY --expect-router-ready --confirm-live --json
```

Record:

- Command output, with raw cookie and API key values redacted.
- `/api/platform/capabilities` fields proving router readiness,
  channel opt-in support, compiled forwarder, and compiled same-channel
  fallback.
- Relay response status, safe request IDs, and response content type.
- Cloudflare AI Gateway log entry for the same timestamp/model/gateway.
- Relay audit and billing rows proving usage parsing, settlement, and quota
  delta.
- If a retryable Gateway failure is induced, evidence that the same selected
  channel fell back to the direct provider path without double settlement.

Pass criteria:

- `relay_ai_gateway_router_ready=true` before the relay POST is attempted.
- The live relay request uses a provider-prefixed model and the targeted
  channel's canary metadata is enabled through the editor, not manual D1 edits.
- AI Gateway logs show the request under the intended account/gateway.
- Relay audit/billing proves the same settlement semantics as direct-provider
  traffic for Gateway success and, when tested, fallback.
- The global router gate is turned back off or left scoped to the approved
  staging canary window after evidence capture.

## Phase 4: SSE Relay Smoke

Use `docs/route-provider-parity-runbook.md` for stream passthrough,
audit-branch, usage parser, client disconnect, and missing-usage evidence.

Minimum first-canary cases:

| Case ID | Route | Expected Evidence |
| --- | --- | --- |
| RELAY-SSE-001 | `POST /v1/chat/completions` with `stream: true` | First chunk observed, final usage observed when provider sends it |
| RELAY-SSE-002 | `POST /v1/responses` streaming | `response.completed` or equivalent usage captured |
| RELAY-SSE-003 | `POST /v1/images/generations` streaming, if provider supports it | Stream passes through and audit branch completes |
| RELAY-SSE-004 | `POST /v1/messages` streaming | Anthropic usage events merged |
| RELAY-SSE-005 | `POST /v1beta/models/{model}:streamGenerateContent` | Gemini latest usage metadata captured |

Pass criteria:

- Client receives a stream without Worker buffering the full response.
- Audit/settlement work is attached to `wait_until` where available.
- Missing final usage causes the documented refund/fallback behavior.
- Client disconnect handling does not double-charge.

## Phase 4b: Realtime Durable Object Smoke

Realtime remains G7-gated until the upstream OpenAI Realtime bridge and billing
settlement are wired, but the Cloudflare long-session substrate must be proven
before that bridge is enabled. Use the platform smoke path first because it
does not require a live relay token or upstream provider credentials:

```powershell
$env:REALTIME_SMOKE_URL = $env:STAGING_BASE_URL
$env:REALTIME_SMOKE_COOKIE = "session=<redacted admin session cookie>"
bun run smoke:realtime-session -- --url $env:REALTIME_SMOKE_URL --session session-smoke --cookie $env:REALTIME_SMOKE_COOKIE --expect-platform-ready --json
```

If `/v1/realtime` is explicitly enabled in staging and a low-risk relay token is
available, also run the OpenAI-compatible entry smoke:

```powershell
$env:REALTIME_SMOKE_API_KEY = "<redacted staging token>"
bun run smoke:realtime-session -- --mode v1 --url $env:STAGING_BASE_URL --model gpt-4o-realtime-preview --api-key $env:REALTIME_SMOKE_API_KEY --cookie $env:REALTIME_SMOKE_COOKIE --expect-v1-gate-enabled --json
```

Record:

- Command output with URLs and protocols redacted.
- `/api/platform/capabilities` Realtime fields, including
  `realtime_session_cutover_guards`,
  `realtime_session_auth_boundary_compiled`,
  `realtime_session_metrics_persisted_compiled`,
  `realtime_session_control_no_echo_compiled`,
  `realtime_session_upstream_bridge_planner_compiled`,
  `realtime_session_upstream_channel_planner_compiled`,
  `realtime_session_upstream_bridge_connect_contract_compiled`,
  `realtime_session_upstream_connect_handoff_compiled`,
  `realtime_session_upstream_fetch_upgrade_adapter_compiled`,
  `realtime_session_upstream_bridge_lifecycle_compiled`,
  `realtime_session_upstream_bridge_frame_guard_compiled`,
  `realtime_session_platform_smoke_ready`, and
  `realtime_session_v1_cutover_ready`.
- WebSocket `pong` response.
- WebSocket `realtime_session_status` frame.
- WebSocket `realtime_session_control` probe response, including
  `text_bytes`, `text_chars`, `rawProbeEchoed=false`, and no `received` field.
- HTTP status response for the platform session path.
- Worker log/trace link for the WebSocket accept and status request.

Pass criteria:

- `REALTIME_SESSIONS` binding is present and the gateway flag under test is on
  only in staging.
- Platform capabilities report hibernation, auth boundary, persisted metrics,
  no-echo controls, the upstream bridge planner, the upstream channel planner,
  the request-scoped upstream connect contract, and the gateway-to-DO connect
  handoff plus upstream fetch-upgrade adapter and transient bridge lifecycle as
  compiled, including the text/binary frame guard;
  `realtime_session_platform_smoke_ready=true` before the platform WebSocket
  smoke runs.
- The WebSocket opens, `ping` returns `pong`, and `status` returns persisted
  lifecycle metrics.
- Metrics show at least one connect and at least two text messages from the
  WebSocket status frame; platform HTTP status shows at least three text
  messages after `ping`, `status`, and the unsupported-control probe.
- Neither persisted metrics nor unsupported-control responses store or echo raw
  message payloads, raw bearer tokens, or raw Realtime protocol API keys.
- For `/v1/realtime` smoke, socket status/control context includes a redacted
  upstream summary (`channel_id`, `channel_type`, selected group, upstream
  model, provider, auth mode, header names/protocol names) plus
  `upstream_connect_handoff=true`, and never includes the raw upstream key,
  bearer header value, or `openai-insecure-api-key.<secret>` protocol value.
- If the DO is hibernated/restarted and the outbound upstream socket is no
  longer active, client frames return `upstream_bridge_not_active` rather than
  implying that the upstream session was resumed.
- Oversized bridge frames are rejected with WebSocket close code `1009` and
  metadata-only frame kind/byte-count/max-byte evidence; raw frame payloads are
  never logged, stored, or echoed.
- The platform HTTP status path shows restored socket attachments and the same
  persisted metrics surface.
- `realtime_session_v1_cutover_ready` remains false until the production bridge
  path has queued backpressure/flow-control, billing settlement, audit logging,
  and live close/error/protocol replay evidence; `/v1/realtime` remains off in
  production until that changes.

## Phase 5: Billing Shadow Smoke

Run each successful relay smoke in shadow mode when available. Use
`docs/billing-parity-runbook.md` as the source for fixture coverage,
correlation keys, thresholds, and redacted report fields.

Record:

- Pre-consume estimate.
- Frozen expression hash and matched tier.
- Request-rule multiplier presence.
- Actual upstream usage.
- Final Rust delta.
- Go/source expected delta, if available.
- Difference and reason.

Pass criteria:

- No negative balance bug.
- No double charge.
- No unexplained positive or negative delta above the agreed threshold.
- Request-rule body is not logged.
- Cached/image/audio token categories are not double-counted.

## Phase 5b: Relay Feature-Flag Cutover Smoke

The charge/behavior-affecting relay flags ship **off** (see the flag table in
`docs/cloudflare-production-config-checklist.md`). Each must be smoked both off
and on **in staging** before it is armed in production — the on path changes
billing or the upstream request, so it cannot be defaulted on at deploy.

| Case ID | Flag | Off-path expected | On-path expected |
| --- | --- | --- | --- |
| FLAG-001 | `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` | Upstream omits usage ⇒ reserve refunded to zero (pre-cutover behavior) | Same response ⇒ completion tokens estimated and **billed**; audit `usage_source` marks it locally estimated |
| FLAG-002 | `RELAY_STREAM_OPTIONS_INJECT_ENABLED` | Streaming request to a supported channel passes through unmodified | `stream_options.include_usage=true` injected for supported channels (stripped for unsupported); a real usage chunk arrives |
| FLAG-003 | `RELAY_CHANNEL_KEYWORD_BAN_ENABLED` | Auto-ban-keyword error body leaves the channel enabled | Same error body auto-disables the channel; action is audited |

Procedure per flag: run the off case and capture evidence → set the flag to
`true` on the staging env only → re-run the on case → diff the billing/usage and
audit fields against the expected column.

Pass criteria:

- Off path reproduces pre-cutover behavior exactly (no billing/behavior drift
  from merely shipping the code with the flag off).
- On path matches the Go-parity expectation, and the difference between off and
  on is fully explained by the flag.
- No charge-affecting flag is enabled in production without a recorded staging
  on-path pass.

## Phase 6: Cache And Failure-Mode Smoke

Cases:

| Case ID | Failure/Scenario | Expected |
| --- | --- | --- |
| CACHE-001 | Token/channel cache hit | D1 read avoided where expected, result equivalent |
| CACHE-002 | Token/channel cache miss | D1 read succeeds and cache is populated |
| CACHE-003 | Upstash timeout/error | Documented fail-open/fail-closed behavior |
| CACHE-004 | Token/channel admin mutation | Cache invalidation or TTL strategy verified |
| RATE-001 | Token rate limit exceeded | Compatible error and no upstream call |
| RATE-002 | IP rate limit exceeded | Compatible error and no upstream call |

Pass criteria:

- Cache keys are environment-scoped.
- Provider family is included where channel selection differs.
- Redis failure does not corrupt D1 source-of-truth state.

## Phase 7: Data And D1 Smoke

Before customer canary, run a staging import from a non-production or approved
production-shaped source export. Use `docs/data-migration-runbook.md` for the
source inventory, artifact policy, import commands, row-count/sample-hash
checks, freeze rules, and rollback point.

Required evidence:

- Export bundle checksum.
- Source row counts.
- D1 target row counts.
- Deterministic sample hashes.
- Failed-row report.
- Rollback export or restore steps.

Additional D1 behavior cases:

| Case ID | Scenario | Expected |
| --- | --- | --- |
| D1-001 | Auth lookup | Correct token/user/channel result |
| D1-002 | Quota reserve | Atomic enough for staging concurrency target |
| D1-003 | Refund after upstream error | Balance restored |
| D1-004 | Settlement after success | Final quota delta correct |
| D1-005 | D1 write failure simulation, if feasible | Customer-safe error or refund path |

## Phase 8: Admin, Frontend, And Auth Smoke

Use `docs/admin-frontend-parity-runbook.md` for frontend deployment model,
auth/session strategy, operator CRUD scope, cache invalidation, audit, and the
redacted G5 report template.

Frontend cases:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| FRONTEND-001 | Build frontend with Bun | Source commit, command output, artifact path |
| FRONTEND-002 | Hard-refresh SPA routes | `/dashboard`, `/channels`, `/keys`, `/users`, `/usage-logs`, `/models`, `/subscriptions`, `/system-settings`, and `/profile` route fallback works |
| FRONTEND-003 | API base URL/CORS policy | Same-origin or approved cross-origin credential policy works |
| FRONTEND-004 | Bundle redaction scan | No secret values in static assets; public config allowlist documented |

Admin/auth cases:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| ADMIN-001 | Login, current user, logout, expired session | Correct role, secure cookie policy, 401 after logout |
| ADMIN-002 | Create/update/disable token and reveal key | Mutation works, reveal is audited, token cache invalidates |
| ADMIN-003 | Create/update/disable channel and run test | Channel selection reflects change, secret is redacted, channel cache invalidates |
| ADMIN-004 | Update model mapping or group config | Relay route uses new mapping after invalidation or documented TTL |
| ADMIN-005 | Adjust user quota/status/role | Single D1 mutation, audit event, no double mutation |
| ADMIN-006 | Search logs by token/channel/model/request ID | Recent request is queryable and redacted |
| ADMIN-007 | Update safe system option | Readback works, audit event exists, config cache invalidates |
| ADMIN-008 | Normal user attempts admin mutation | Correct rejection and no mutation |
| ADMIN-009 | Disable a bad token/channel during relay smoke | New relay requests stop quickly or within documented TTL |

Optional in-scope cases:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| AUTH-ADMIN-001 | OAuth login/bind/unbind | State/callback validation and forced rebind/defer policy |
| AUTH-ADMIN-002 | Passkey or 2FA login/reset | Credential handling or forced reset policy; admin reset audit |
| PAY-ADMIN-001 | Subscription/payment admin action | Link to billing runbook evidence; no double-credit risk |

Pass criteria:

- Operators can complete P0 token, channel, user, log, and settings flows
  without direct D1 edits.
- Every sensitive mutation has actor/action/target/request ID audit evidence.
- Secret-bearing responses use no-store behavior and redacted logs.
- Token/channel/model/option changes invalidate caches or document a safe TTL.
- Frontend routes and API calls work under the selected Cloudflare deployment
  model.

## Phase 9: Observability And Security Smoke

Use `docs/observability-slo-security-runbook.md` for the log schema,
sampling/retention policy, SLO thresholds, alert drill, redaction checks, and
G6 report template.

Observability cases:

- Worker log exists for every smoke request.
- Trace exists for sampled requests.
- Error logs are structured.
- Upstream failures are searchable by provider/channel/model.
- D1, Upstash, queue, and provider failure metrics are visible or logged.

Security cases:

- Raw bearer token does not appear in logs.
- Raw upstream API key does not appear in logs.
- Payment/OAuth secrets do not appear in logs.
- CORS policy matches staging origin.
- WAF/rate-limit rules are active on staging routes.
- OAuth state/webhook signature tests pass for any enabled auth/payment route.
- Creem wallet smoke covers checkout URL creation, pending topup row, signed
  `checkout.completed` webhook credit, duplicate webhook no-op, amount mismatch
  no-credit, and empty-user-email backfill only after signature verification.
- Legacy Waffo wallet smoke covers checkout URL creation, pending topup row,
  raw-body RSA-signed `PAYMENT_NOTIFICATION` webhook credit, signed webhook
  success/failure ACKs, duplicate webhook no-op, and amount/provider mismatch
  no-credit cases before paid traffic.
- Waffo Pancake wallet smoke covers checkout URL creation, pending topup row,
  signed `order.completed` webhook credit, duplicate webhook no-op, and
  env/identity/amount mismatch no-credit cases before paid traffic.
- Admin mutation routes write audit events before Scenario B/C.

Pass criteria:

- An operator can answer who called what, through which token/channel/model,
  which upstream responded, and which quota mutation occurred.
- Security-sensitive values are redacted.

## Phase 10: Performance, Capacity, And Cost Smoke

Use `docs/performance-capacity-cost-runbook.md` for load profiles, metrics,
D1/Upstash/Queue/R2 capacity checks, cost forecasts, and go/no-go rules.

Minimum pre-canary cases:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| PERF-001 | `/api/status` and route overhead load | Worker p95/p99, CPU, resource-limit errors, logs visible |
| PERF-002 | Auth/channel cache warmup | cache hit ratio, D1 read reduction, Upstash latency/errors |
| PERF-003 | Mixed non-stream relay load | p50/p95/p99, usage parsing, D1 rows read/written, quota settlement |
| PERF-004 | Mixed SSE relay load | first-byte p95, stream completion, audit branch completion |
| PERF-005 | Provider 429/5xx/timeout injection | error mapping, refund/fallback behavior, no retry storm |
| PERF-006 | D1 write-pressure smoke | auth/reserve/settlement write health, no overloaded errors |
| PERF-007 | Upstash timeout/error smoke | documented fail-open/fail-closed behavior, no D1 corruption |
| PERF-008 | 1x/2x/5x cost forecast | approved forecast or documented blocker |

Scenario-specific cases:

| Case ID | Flow | Expected Evidence |
| --- | --- | --- |
| PERF-ADMIN-001 | Admin operations under relay background load | mutation latency, audit, cache invalidation, no secret leak |
| PERF-ASYNC-001 | Queue/R2 task load, when implemented | backlog, retries, DLQ, R2 operation and artifact evidence |

Pass criteria:

- 500-concurrency mixed relay test, or an agreed production-shaped equivalent,
  passes the selected SLOs.
- No Worker CPU/memory/resource-limit errors appear.
- D1 hot-path queries have bounded rows read and acceptable duration.
- Upstash failure behavior matches the documented cache/rate-limit policy.
- Logs remain available during load.
- Cost forecast is approved for current, 2x, and 5x traffic.

## Phase 11: Canary Rehearsal

Before any customer canary:

1. Select internal tokens only.
2. Define rollback operator and communication channel.
3. Rehearse route/DNS/feature rollback without customer traffic.
4. Confirm Go/VPS remains authoritative for data outside the canary scope.
5. Confirm Rust logs and D1 state will be preserved after rollback.

Pass criteria:

- Rollback can stop Rust traffic quickly.
- Any Rust-applied quota/payment deltas can be reconciled.
- The team knows which system is source of truth for every write family.

## Abort Criteria

Abort staging promotion or canary if any of these occur:

- Any quota/balance corruption.
- Any payment double-credit or missed-credit event.
- Repeated D1 mutation failures on auth/reserve/settlement.
- Sustained Worker 5xx above the agreed threshold.
- Provider routing sends traffic to the wrong channel family.
- Logs/traces are unavailable during smoke.
- Raw secrets appear in logs.
- Multipart/raw upload endpoints are accidentally enabled before body modes are
  implemented.

## Report Location

Store smoke reports outside the source tree if they contain request payloads,
customer-like data, API responses, or operational screenshots. Commit only a
redacted summary to `docs/verification.md` or a future `docs/smoke-reports/`
index.
