# Staging Smoke Runbook

Date: 2026-07-10

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

Current gate state (2026-07-14): **NO-GO for remote staging promotion**.
Local migration/config checks and a local Worker-binding Realtime settlement
smoke have passed, but Wrangler is not authenticated and no remote staging
deploy, migration, binding, log, trace, or smoke result was captured. An
exposed Cloudflare token must not be used; revoke/rotate it before authenticating
with a replacement credential.

## Preconditions

Required local state:

- Clean git worktree or an intentionally documented test branch.
- On Windows, Microsoft Visual C++ 2015-2022 Redistributable (x64) is installed
  so Wrangler's local `workerd` can start.
- `bun run check:d1:migration-config` passes.
- `bun run verify:sqlite` reports 24 migrations, 29 required tables, 106
  incremental key columns, and 21 key indexes, including the 0020 and 0021
  active-reservation guards.
- `bun run check:cf:billing-queue` passes.
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
- Staging log, billing-finalization, and task queues plus environment-specific
  DLQs for every enabled producer/consumer.
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
bun run check:d1:migration-config
bun run verify:sqlite
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
- All three D1 binding tables use `migrations/d1`; migrations 0001-0023 are
  contiguous; the local SQLite verifier finds all 29 required tables, 105
  incremental key columns, and 20 key indexes.
- No formatting or whitespace errors.
- Cloudflare dry-run/startup checks pass, or the missing local dependency is
  recorded as a known local limitation.

## Phase 0b: TaskRunner Replay Probe Plan

Run the read-only TaskRunner contracts before enabling any staging alarm fast
path:

```powershell
bun run check:task-runner:alarm-replay-contract
bun run check:task-runner:alarm-replay-plan
bun run check:do-lifecycle-runtime
```

The lifecycle command builds the release Rust/Wasm artifacts and runs them in
Cloudflare's Vitest Workerd pool. Its Realtime case uses a SQLite Durable Object,
explicitly calls `evictDurableObject(..., { webSockets: "hibernate" })`, then
requires the same client socket to return a status frame with the same redacted
bridge segment, incremented persisted metrics, and HTTP readback showing one
active WebSocket plus one restored attachment. This is local runtime evidence;
it does not satisfy the remote staging steps below or the active-upstream bridge
loss/refund drill.

After staging has a low-risk shared task id and `TASK_RUNNER_DO_ENABLED=true`
has been enabled only for the controlled replay, run:

```powershell
bun run smoke:task-runner -- --url "$env:STAGING_BASE_URL" --task-id "$env:TASK_RUNNER_SMOKE_TASK_ID" --cookie "$env:TASK_RUNNER_SMOKE_COOKIE" --confirm-live --expect-gate-enabled --json
```

For archived proof, rerun the same read-only command as the alarm state machine
advances. The GET probe does not cause another alarm; the submit path and the
DO's persisted rearm decision must produce each observed state:

```powershell
bun run smoke:task-runner -- --url "$env:STAGING_BASE_URL" --task-id "$env:TASK_RUNNER_SMOKE_TASK_ID" --cookie "$env:TASK_RUNNER_SMOKE_COOKIE" --confirm-live --expect-gate-enabled --expect-status poll_progressed --expect-poll-status progressed --expect-replay-evidence progress_applied --json
bun run smoke:task-runner -- --url "$env:STAGING_BASE_URL" --task-id "$env:TASK_RUNNER_SMOKE_TASK_ID" --cookie "$env:TASK_RUNNER_SMOKE_COOKIE" --confirm-live --expect-gate-enabled --expect-status poll_applied --expect-poll-status applied --expect-replay-evidence first_apply --json
bun run smoke:task-runner -- --url "$env:STAGING_BASE_URL" --task-id "$env:TASK_RUNNER_SMOKE_TASK_ID" --cookie "$env:TASK_RUNNER_SMOKE_COOKIE" --confirm-live --expect-gate-enabled --expect-replay-evidence second_replay_noop --json
bun run smoke:task-runner -- --url "$env:STAGING_BASE_URL" --task-id "$env:TASK_RUNNER_SMOKE_TASK_ID" --cookie "$env:TASK_RUNNER_SMOKE_COOKIE" --confirm-live --expect-gate-disabled --expect-replay-evidence gate_disabled_fallback --json
```

Pass criteria:

- `/api/platform/capabilities` reports
  `task_runner_rearm_contract_compiled=true`, a bounded
  `task_runner_max_alarm_fires`,
  `task_runner_storage_error_retry_contract_compiled=true`,
  `task_runner_status_probe_compiled=true`, and
  `task_runner_cutover_ready=false`.
- `GET /api/platform/task-runner/:task_id/status` returns only metadata:
  alarm/rearm timing, poll status, bounded reason, CAS ownership, observed
  terminal state, failure count, fast-path horizon, and cron fallback reason.
- The admin Cloudflare Platform panel's `TaskRunner status probe` form can query
  the same task id and display the returned Durable Object metadata without
  exposing arm/delete controls.
- A non-terminal provider result reports `progress_applied`, keeps an alarm
  scheduled, and increments `rearm_count`; it must not report `first_apply`.
- A lost CAS is re-read from D1 and reports either `nonterminal_cas_noop` with a
  new alarm or confirmed-terminal `second_replay_noop` without one.
- Transient failure evidence shows bounded backoff. Horizon exhaustion records
  `fast_path_horizon_exhausted` before cron-only fallback.
- Rollback evidence shows `TASK_RUNNER_DO_ENABLED=false` with cron still owning
  settlement.

## Phase 1: Cloudflare Binding Smoke

Deploy or update staging using the configured staging command.

Before any remote command, confirm the operator has revoked/rotated every
exposed token and authenticated Wrangler with a replacement credential. Record
the account identity and token scope/owner/rotation time, never the token value.
If Wrangler is unauthenticated, stop here and mark Phase 1 blocked; local schema
or localhost smoke output cannot be promoted into this phase.

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

WFP paid traffic is a central relay transport canary, not an admin-dispatch AI
smoke. The central request must complete relay-token authentication, D1 channel
selection, and quota reserve before `channels.other_info.wfp_worker` selects the
tenant Worker. The response must return through central settlement/refund and
audit. Keep `WFP_RELAY_TRANSPORT_ENABLED=false` except for the isolated canary.

Preconditions:

- Provision a staging-only `WFP_RELAY_AUTHORITY_SECRET` of at least 32 bytes on
  the platform Worker only. It signs central-authority v2 directly and is also
  available to the platform-owned replay DO through that script. Do not derive
  or bind an authority key into any tenant, and do not record the value.
- Use a least-privilege Cloudflare deploy token for script PUT/GET. Provision a
  separate `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` only on
  `cinatoken-wfp-outbound`; no tenant runtime Cloudflare token is allowed.
- Apply a staging channel row whose `channels.other_info.wfp_worker` names the
  intended dispatch worker. Record the before/after row without channel keys.
- Keep the generated JavaScript fallback out of the upload path. It is
  status-only, and `/api/platform/wfp/tenant-script/deploy` is disabled.
- Deploy the staging main Worker with migration `v4-wfp-authority-replay` and
  binding `WFP_AUTHORITY_REPLAY` to class `WfpAuthorityReplay`. Deploy the
  staging outbound environment so its external `WFP_AUTHORITY_REPLAY` binding
  points to that exact staging main script; never reuse the production owner.
- Attach the outbound service to `DISPATCHER` with environment `staging` and
  exactly one parameter, `CINATOKEN_WFP_OUTBOUND_CONTEXT`. The main Worker must
  invoke Dynamic Dispatch with the third-argument `outbound` object containing
  that exact parameter.

Build and archive the strict Rust/Wasm dry-run manifest:

```powershell
New-Item -ItemType Directory -Force .wrangler/evidence | Out-Null
bun run build:wfp-tenant
bun tools/deploy_wfp_tenant_artifact.mjs --dry-run --json --script-name tenant-smoke --tenant-id tenant-smoke --namespace $env:WFP_DISPATCH_NAMESPACE --account-id $env:CLOUDFLARE_ACCOUNT_ID > .wrangler/evidence/wfp-tenant-artifact-manifest.json
```

Run the strict uploader only after the dry-run passes. Archive the redacted
Cloudflare PUT result and GET content/metadata readback; verify the returned
module set and SHA-256 values match the dry-run manifest. The official endpoint
contract is the Workers for Platforms Scripts REST API:
<https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/>.

Deploy `cinatoken-wfp-outbound` with `bun run deploy:wfp-outbound:staging` and
collect schema-3 readback before any paid request. The collector must confirm
the exact outbound service/environment/context parameter, private ingress,
outbound-only bearer ownership, account binding, and external platform replay
DO binding. It derives the physical `cinatoken-wfp-outbound-staging` API target
from the logical service and environment. A local Workerd object binding does not prove remote Dynamic
Dispatch parameter propagation.

First run the admin-authenticated status smoke against only
`/api/platform/dispatch/:worker/__cinatoken/tenant/status`. Then prove that an
admin request to each paid AI path is rejected. The generated fallback is not
acceptable evidence for any AI route.

Archive the structured negative contract before a positive tenant smoke. The
missing-script case is safe to run against a deliberately absent worker name:

```powershell
bun tools/smoke_wfp_dispatch.mjs --url $env:STAGING_BASE_URL --worker missing-tenant-fixture --cookie $env:WFP_SMOKE_COOKIE --expect-dispatch-error wfp_worker_not_found --json
```

Use isolated staging variants/fixtures for the other cases:

- no `DISPATCHER` binding with the internal dispatch gates on:
  `wfp_dispatch_unavailable` / 503;
- a tenant fixture exceeding configured CPU or subrequest limits:
  `wfp_worker_resource_limit_exceeded` / 429;
- a tenant fixture throwing a synthetic non-secret exception:
  `wfp_worker_execution_failed` / 502;
- a normal relay request selecting an absent WFP channel worker:
  `wfp_relay_worker_unavailable` / 502.

Each platform-generated response must be JSON, carry the exact code/status,
include `Cache-Control: no-store`, omit raw exception text, and never fall back
to the main application. Run `bun run check:wfp-dispatch:failure-contract`
locally before staging. The internal status tool cannot prove the paid-relay
case; capture that through the normal relay-token boundary and reconcile its
reserve/refund/audit outcome.

For the paid canary, enable `WFP_RELAY_TRANSPORT_ENABLED` briefly and call one
of the four retained routes through the normal public relay boundary with a
staging relay token:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /ai/run`

Do not send the paid canary through `/api/platform/dispatch/:worker/...`.
`POST /v1/embeddings` is not a WFP tenant route and must be rejected.

Before any paid request, run `bun run check:wfp-outbound:egress-contract` and
archive `bun run check:wfp-outbound:egress-plan`. The isolated canary must use a
fixed non-`auto` token group with exactly one enabled WFP channel, set central
`RELAY_RETRY_TIMES=0`, keep cross-model fallback disabled, and prove tenant
`AI_GATEWAY_MAX_ATTEMPTS=1` in artifact readback. The capabilities endpoint now
reports `relay_retry_times`; the frontend keeps WFP paid smoke blocked unless it
is exactly zero.

Live mode is deliberately one paid route per process. It accepts no URL, model,
body, API-key, or Cookie override; the reviewed staging origin and low-token
payloads are fixed in source, while credentials come only from dedicated
environment variables:

```powershell
$env:CINATOKEN_WFP_EGRESS_SMOKE_TOKEN = '<short-lived fixed-group relay token>'
$env:CINATOKEN_WFP_EGRESS_SMOKE_ADMIN_COOKIE = '<short-lived admin session cookie>'

bun run smoke:wfp-outbound-egress -- --target staging --scenario chat --worker tenant-smoke --channel-id <channel-id> --group <fixed-group> --confirm-live --confirm-isolated-staging --confirm-single-channel --confirm-retry-disabled --confirm-tenant-attempts-one > .wrangler/evidence/wfp-egress-chat.json
```

Repeat as separate reviewed invocations for `responses`, `messages`, and
`ai-run`, inspecting billing/audit and Gateway evidence after each call. The
tool rejects a multi-route live invocation, a production/custom origin, model
overrides, streaming, pending billing, the wrong worker/channel/group, duplicate
type-2 audit rows, and sensitive/internal response headers. It bounds request,
response, and admin evidence bytes and emits no response body or raw headers.

Record:

- Capability output showing the dispatch binding, transport gate, authority
  secret readiness, outbound invocation-context/verifier/replay compiled
  states, replay DO availability, four-route manifest, and Rust/Wasm runtime.
- The dry-run artifact manifest plus real PUT and GET readback evidence. Do not
  include either token or any secret value. Readback must prove that the tenant
  has no `WFP_RELAY_AUTHORITY_KEY`, `WFP_RELAY_AUTHORITY_SECRET`, or
  `WFP_AUTHORITY_REPLAY` binding. Schema-3 outbound readback must prove the
  external replay binding targets `WfpAuthorityReplay` on the expected staging
  main Worker and that the dispatch attachment has the exact context parameter.
- Admin status success, unauthenticated status rejection, admin AI rejection,
  preview-host AI rejection, and `/v1/embeddings` rejection.
- Signed-authority and invocation-context negative cases: missing/tampered
  signature, wrong public or dispatch worker, wrong route kind, method, final
  path, body, or channel, and expired or future-invalid timestamps. Every case
  must prove zero provider calls and no bearer-dependent upstream response.
- Replay evidence for the same otherwise-valid authority: sequential and
  concurrent attempts produce exactly one success and `409` duplicates; wrong
  canonical shard is rejected; eviction/redeploy does not reopen consumption;
  alarm cleanup occurs only after expiry. Record latency, bucket throughput,
  storage growth, and exactly one mock/provider egress call.
- D1 evidence for the accepted canary: selected channel ID, one reserve, exactly
  one settlement or refund, final quota delta, and matching audit outcome.
- Redacted central and tenant Worker traces correlated by request ID. Do not
  expose the raw authority header or runtime credential.

Pass criteria:

- Readback proves the uploaded runtime is exactly the reviewed Rust/Wasm module
  graph; no JavaScript AI fallback is present.
- The tenant has `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1`, no
  Cloudflare bearer, no authority signing or verification material, and no
  replay DO binding.
- Admin dispatch reaches status only. No public preview or admin dispatch route
  can invoke tenant AI.
- Accepted tenant AI traffic has a valid HMAC-SHA256 authority with a 30-second
  lifetime binding worker, method, path, body hash, channel, and request ID.
- The platform Worker retains the authority master; the tenant receives only
  the opaque request-scoped authority and forwards it to the outbound boundary.
- The tenant status reports
  `paid_ai_authority_verifier=platform-outbound-central-hmac-v2`,
  `paid_ai_replay_guard=platform-outbound-durable-object-once-v2`, and
  `tenant_authority_replay_binding_bound=false`.
- Remote staging proves that Cloudflare injects the exact outbound context and
  that the outbound Worker validates context, authority, final path, body, and
  replay before reading or injecting its bearer.
- The normal relay path owns token auth, D1 selection, reserve, exactly-once
  settlement/refund, and audit. Tenant forwarding does not duplicate them.
- The transport gate is returned to `false` after the canary.

Status as of 2026-07-13: central-authority v2, outbound context binding, final
verification, and replay consumption pass local Rust and Workerd tests. The
signed-authority billing canary, real Dynamic Dispatch parameter propagation,
live duplicate race, and real upload/binding readback remain pending. This
runbook does not claim deployment evidence or exactly-once upstream execution
across newly signed retries.

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
| RELAY-JSON-006 | SiliconFlow chat/completions and FIM | SiliconFlow(40) | Direct `.cn`/configured root, model preserved, FIM empty message, usage settled |
| RELAY-JSON-007 | SiliconFlow embeddings and rerank | SiliconFlow(40) | Batch response bounded; legacy/current rerank token envelope normalized and settled |
| RELAY-JSON-008 | SiliconFlow image generations | SiliconFlow(40) | JSON response, non-empty images, minimum usage, effective `batch_size`/`n` fixed-price multiplier, no SSE |
| RELAY-JSON-009 | Moonshot chat, completions, embeddings, rerank | Moonshot(25) | Direct provider root, mapped model preserved, Kimi K2.6 explicit temperature normalized, standard/nested cache usage settled |
| RELAY-JSON-010 | Moonshot Messages and coding-plan chat/Messages | Moonshot(25) | Bearer-authenticated Claude wire shape, exact sentinel root, usage settled; embeddings/rerank sentinel fallthrough rejected before reserve |
| RELAY-JSON-011 | `POST /v1/embeddings` | Jina(38) | Direct `/v1/embeddings`, Bearer auth, no forwarded OpenAI `encoding_format`, Jina-native fields preserved, bounded response, usage settled |

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
  fallback. For cross-model readiness, also record
  `relay_ai_gateway_cross_model_actual_group_billing_compiled=true` and the
  `actual_serving_group_billing` guard.
- Relay response status, safe request IDs, and response content type.
- Cloudflare AI Gateway log entry for the same timestamp/model/gateway.
- Relay audit and billing rows proving usage parsing, settlement, and quota
  delta.
- If a Gateway fetch/server failure is induced, evidence that the same selected
  channel used the provider-native direct model without double settlement.
- Prove Gateway `401`, `403`, and `429` do not enter the direct-provider branch.

Pass criteria:

- `relay_ai_gateway_router_ready=true` before the relay POST is attempted.
- The live relay request uses a provider-prefixed model and the targeted
  channel's canary metadata is enabled through the editor, not manual D1 edits.
- AI Gateway logs show the request under the intended account/gateway.
- Relay audit/billing proves the same settlement semantics as direct-provider
  traffic for Gateway success and, when tested, fallback.
- The global router gate is turned back off or left scoped to the approved
  staging canary window after evidence capture.

## Phase 3c: Cross-Model Fallback Replay

This is a separate canary from same-channel transport fallback. Start with a
fixed staging token/group and two low-cost AI-Gateway-opted-in channels, then
repeat the billing cases with an isolated `auto` token whose candidate groups
have deliberately different effective ratios. Do not enable a Cloudflare
Dynamic Route for the same request.

Configure staging only:

```powershell
# Example deployment vars; do not put provider or Cloudflare secrets in JSON.
RELAY_MODEL_FALLBACK_ENABLED = "true"
RELAY_MODEL_FALLBACKS_JSON = '{"openai/gpt-4.1":"anthropic/claude-sonnet-4"}'
RELAY_MODEL_FALLBACK_STAGING_VERIFIED = "false"
```

Run the local contract first, then a live non-stream request whose primary
channel is isolated to return a controlled `5xx`:

```powershell
bun run check:relay-ai-gateway:fallback-contract
bun run smoke:relay-ai-gateway -- --url $env:STAGING_BASE_URL --cookie $env:RELAY_AI_GATEWAY_SMOKE_COOKIE --api-key $env:RELAY_AI_GATEWAY_SMOKE_API_KEY --model openai/gpt-4.1 --expect-router-ready --expect-fallback-enabled --expect-fallback-ready --expect-served-model anthropic/claude-sonnet-4 --confirm-live --json
```

For the isolated fetch-exhaustion case, make both selected transports
unreachable and let the harness prove the resulting admin row:

```powershell
bun run smoke:relay-ai-gateway -- --url $env:STAGING_BASE_URL --cookie $env:RELAY_AI_GATEWAY_SMOKE_COOKIE --api-key $env:RELAY_AI_GATEWAY_SMOKE_API_KEY --model openai/gpt-4.1 --expect-router-ready --expect-fallback-enabled --expect-fallback-ready --allow-non-2xx --expect-terminal-audit --confirm-live --json
```

Archive these independent cases:

1. Primary `5xx` -> fallback success. Response, Gateway log, and relay audit all
   identify the fallback model; the final log has one settlement.
2. Fallback denied by token model limits. No fallback D1 selection/fetch occurs,
   and the primary failure remains authoritative.
3. Missing/disabled fallback channel. Primary reserve is refunded and no
   fallback egress occurs.
4. Fallback fetch exhaustion and fallback preflight/forwarder failure. Exactly
   one active reserve is refunded before the error is returned. Query admin
   logs by `request_id`: one type-5 row must contain
   `error_code=relay_attempts_exhausted`, bounded `admin_info.relay_attempts`,
   the true `attempt_count`, `attempts_truncated`, and `reserve_refund`, with no
   URL, channel name, credential, raw fetch error, or response body. Replay the
   exact same Queue event and prove its random `terminal_audit_event_id` plus
   conditional insert keep exactly one terminal row.
5. Primary `401`, `403`, `429`, `400`, `408`, `504`, and `524`. No cross-model
   fallback occurs.
6. Streaming request. Fallback may occur before a successful response starts;
   it never starts after a `2xx` stream is exposed.
7. Rollback. Set `RELAY_MODEL_FALLBACK_ENABLED=false`, redeploy, and prove the
   existing same-model relay behavior is restored.
8. `auto` group actual-serving-group billing. Prove the expression output is
   frozen once, candidate snapshots differ only by effective group ratio, one
   maximum estimated quota is reserved, and final settlement selects the group
   that served the response and refunds the exact excess. Repeat with a
   cross-model fallback and prove the primary plan is refunded before a new
   fallback-model candidate-group plan is reserved.

Keep `RELAY_MODEL_FALLBACK_STAGING_VERIFIED=false` until all cases, quota row
deltas, final audit `model_route`, actual serving group, reservation strategy,
and rollback timestamps are archived. Actual-serving-group billing and the
terminal attempt ledger are locally compiled; remote D1/Queue delivery,
refund-before-audit ordering, user-log redaction, and admin-log visibility
remain production blockers.

## Phase 3d: Actual-Serving-Group Worker-Binding Smoke

Run the local contract and redacted plan first:

```powershell
bun run check:relay-actual-group-billing:contract
bun run check:relay-actual-group-billing:smoke-plan
```

For an isolated staging D1 only, temporarily set
`RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED=true`, deploy the matching
Worker commit, and verify the three staging-smoke capabilities are all true.
Then run:

```powershell
$env:RELAY_ACTUAL_GROUP_BILLING_SMOKE_COOKIE = "session=<redacted admin session cookie>"
bun run smoke:relay-actual-group-billing -- --url $env:STAGING_BASE_URL --cookie $env:RELAY_ACTUAL_GROUP_BILLING_SMOKE_COOKIE --scenario all --confirm-live --json
```

The CLI fails unless all three scenarios report `PASS`, prove the Worker binding
path, reconcile maximum reserve with final/refund quota, match final and expected
D1 snapshots, and return `cleanupVerified=true`. Archive capability JSON, all
three reports, Worker logs, the git SHA, and the time the smoke flag was restored
to `false`. Never treat self-test or dry-run output as staging execution.

The route rejects `cleanup=false`. Before touching a fixed fixture row it also
verifies that both the reserved ID and ownership marker belong to the smoke;
collisions fail closed instead of deleting unrelated staging data.

The fixture authenticates an `auto` token whose D1 `cross_group_retry` value is
enabled. That value now reaches ordinary REST, fallback, and Realtime attempt
planning; the smoke scenarios specifically prove actual-group refund, primary-
to-fallback plan replacement, and full refund after retry exhaustion.

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
| RELAY-SSE-006 | SiliconFlow chat and legacy completions | Direct-only SSE, final usage or documented estimate/refund, opaque model preserved |
| RELAY-SSE-007 | Moonshot chat and legacy completions | Direct-only SSE; final OpenAI usage merges an earlier `choices[].usage.cached_tokens` event without losing cache settlement |
| RELAY-SSE-008 | Moonshot Messages | Direct-only Anthropic SSE usage events merge under Anthropic cache semantics |

Pass criteria:

- Client receives a stream without Worker buffering the full response.
- Audit/settlement work is attached to `wait_until` where available.
- Missing final usage causes the documented refund/fallback behavior.
- Client disconnect handling does not double-charge.

## Phase 4b: Realtime Durable Object Smoke

Realtime remains G7-gated until the upstream OpenAI Realtime bridge and billing
settlement are proven on remote staging with live close/error/protocol and
no-double-charge evidence. Local foundations and smoke results do not prove the
Cloudflare long-session substrate. First run the local bridge replay contract
self-test; it validates the expected close/error/send-failure terminal-event
metadata without opening a network socket:

```powershell
bun run check:realtime-session:bridge-replay-contract
```

Then run the ordered upstream replay contract self-test. It validates the
mock/live replay evidence shape across active bridge status, forwarded frame
metadata, terminal event, client close mapping, persisted terminal event, and
payload/token redaction before any live upstream replay artifact is accepted:

```powershell
bun run check:realtime-session:upstream-replay-contract
```

Then run the local mock upstream replay harness self-test and dry-run plans.
The self-test validates the harness expectations for externally inducible live
paths (`upstream-normal-close`, `upstream-frame-limit`, and
`startup-queue-drain`), the metadata-only usage capture path
(`response-done-usage`), plus Worker-side mock-fault paths
(`upstream-event-stream-failed` and `upstream-accept-failed`). The dry-runs
print the redacted `/v1/realtime` plan plus the channel `base_url` that must
point at the mock upstream. The harness sends a WebSocket `status` control
frame before ordinary replay probes and requires one active upstream bridge
with zero queued upstream frames/bytes. For `startup-queue-drain`, it sends the
probe first and requires one queued upstream frame before the delayed accept
path drains it. For `response-done-usage`, it sends a client probe, waits for
the mock upstream to forward a `response.done` usage frame, then requires
status metrics to include `usage_event_count >= 1` and a metadata-only
`last_usage` token summary before normal upstream close. For early mock faults,
it expects the Worker to emit the terminal bridge event and close before any
client probe is forwarded:

```powershell
bun run check:realtime-session:mock-upstream-replay-contract
bun run check:realtime-session:mock-upstream-replay-plan
bun run check:realtime-session:mock-upstream-usage-plan
bun run check:realtime-session:mock-upstream-fault-plans
```

After the contracts pass, run the managed local runtime suite from an isolated
local Wrangler state. It builds the Worker, starts a local-only Worker without
AI/Assets/remote bindings, applies each scenario through a temporary SQL file,
executes the real `/v1/realtime` WebSocket path, restores the prior billing
options, and removes all fixture rows:

```powershell
bun run smoke:realtime-local-suite --confirm-local --json
```

The suite refuses non-loopback Worker URLs and requires `--confirm-local`.
Do not point it at staging or production. On Windows it invokes the locked
Wrangler CLI directly rather than nesting `bun x`, because the nested process
can retain handles after D1 execution. Its local configuration currently uses
compatibility date `2026-06-24`, the maximum supported by Wrangler 4.103.0's
bundled workerd; staging/production stay on `2026-07-11` and require separate
deployed evidence. A pass must include all six scenarios and independent zero
row readback for fixture users, tokens, channels, abilities, reservations,
replays, and logs.

Before promoting Realtime settlement beyond default-off code paths, run the
local D1-shape settlement batch replay. It does not write Cloudflare D1; it
proves the Worker batch contract locally for applied, duplicate,
guarded-update rollback, audit-failure rollback, refund, and tokenless
settlement paths, plus the 0020 reservation-lease contract for not-yet-due
work, inclusive settlement grace, first recovery at `L+301`, idempotent replay,
and earliest-deadline scheduling:

```powershell
bun run check:realtime-session:settlement-batch-contract
```

Then generate the isolated staging evidence plan:

```powershell
bun run check:realtime-session:settlement-staging-plan
bun run check:realtime-session:settlement-binding-smoke-plan
```

The staging plan emits setup, verification, duplicate-marker pre-check, and
cleanup SQL artifacts plus the required Worker-binding apply evidence for six
settlement scenarios. Do not use a multi-statement `wrangler d1 execute` file
as substitute proof for the D1 batch apply step: Cloudflare Worker
`D1Database.batch()` executes prepared statements with per-statement
`changes()` boundaries, while standalone Wrangler SQL is only appropriate here
for setup, row snapshots, and cleanup. The batch apply proof must come from the
deployed Worker path, such as a controlled `/v1/realtime` mock-usage replay or
a staging-only Worker binding smoke probe.

The six Worker-binding scenarios exercise the settlement batch itself; they do
not prove Durable Object alarm recovery. Archive separate staging evidence that
uses the minimum safe 900-second test lease to show: alarms at `L` and `L+300`
do not refund, the first alarm at `L+301` after DO eviction/restart refunds
once, a forced D1 refund failure leaves one redacted lease and re-arms the
alarm, settlement-retry ownership suppresses lease refund, and the shared alarm
selects the earliest deadline across both queues. Restore the production
candidate lease value after the test and verify it exceeds measured response-
duration p99 plus the approved retry/clock-skew margin.

### Reservation Lease Recovery Drill

This is a G7-blocking isolated-staging drill. Until a dedicated harness
automates it, execute the steps with the mock upstream and archive redacted
HTTP/WS status plus D1 snapshots before and after every transition:

1. Confirm exact D1 readiness through 0021 and zero `reserved` rows before both
   0020 and 0021.
   Record the current capability value, deploy a temporary staging-only
   `REALTIME_BILLING_RESERVATION_LEASE_SECONDS="900"`, and keep production
   unchanged.
2. Create one response reservation without a terminal `response.done`. Before
   900 seconds, at the raw lease expiry, and at `lease + 300s`, prove the D1 row
   is still `reserved`, `due_count=0`, and no quota refund occurred.
3. Let the DO hibernate or restart the staging Worker without deleting DO/D1
   state. At `lease + 301s`, prove one CAS refund, zero duplicate quota changes,
   and lease removal. Replay the alarm/status path and prove it stays a no-op.
4. On a dedicated fixture reservation, install a temporary D1 trigger that
   aborts the `reserved` to `refunded` update. Prove the redacted lease attempt
   count increases and the alarm re-arms; drop the trigger, then prove recovery
   and cleanup. Archive trigger creation/removal and verify no trigger remains.
5. Force settlement failure for another response. Prove the retry record takes
   ownership and its active lease disappears; when retry exhaustion cannot
   refund immediately, prove exactly one refund-only deadline or lease owner
   remains and eventually clears.
6. Create lease and retry deadlines in both orders. Prove the single alarm
   follows the earlier absolute deadline and later work is not overwritten.
7. Abort D1 reservation insert after the DO lease is stored. At the first
   post-grace recovery instant, prove `NotFound` removes that lease without
   quota mutation.
8. Exercise normal settle, missing usage, forward failure, disconnect, and
   terminal error. Unbound failures must refund immediately; a bound or
   in-flight `response.done` interrupted by disconnect/error must remain
   reserved through `L+300`, then settle or refund exactly once at/after its
   legal boundary. Every terminal path must eventually remove its lease. Then
   use mock-only reservations to prove 128 active records are accepted and the
   129th fails before D1 reservation/upstream forwarding.
9. Restore the production-candidate lease value, redeploy, archive the before
   and after capabilities, and verify both persisted queues and all fixture
   rows/triggers are empty.

The drill is incomplete if eviction/restart is only inferred, fault triggers
are left behind, raw reservation inputs appear in artifacts, or any D1
`reserved` row lacks one redacted lease/retry owner.

The Worker-binding smoke route is `POST
/api/platform/realtime/settlement-batch/smoke`. It is admin-only, rejects
`ENVIRONMENT=production`, and remains unavailable until
`REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED=true` is set in staging. The route
accepts only fixed scenario names (`additional-quota-applied`,
`duplicate-replay-noop`, `guarded-update-rollback`, `audit-failure-rollback`,
`refund-delta-applied`, `tokenless-applied`) and always runs the production
`apply_realtime_settlement_batch` path through the Worker D1 binding. Live smoke
requires an admin cookie and an explicit confirmation:

On 2026-07-10, the route precedence bug that allowed the generic Realtime
gateway matcher to claim this settlement endpoint was corrected. A real local
`wrangler dev` Worker-binding run then passed all six scenarios (6/6) through
the Worker `DB` binding, and default cleanup left zero smoke fixture rows and no
temporary audit-failure trigger. This is stronger than the SQLite-only contract
test, but it is still localhost evidence. Repeat the command below against the
deployed staging Worker and isolated staging D1 before changing any G7 or
Realtime production status.

```powershell
bun tools/smoke_realtime_settlement_batch.mjs --binding-smoke --url "$env:STAGING_BASE_URL" --cookie "$env:REALTIME_SETTLEMENT_SMOKE_COOKIE" --confirm-live --json
```

Use `--retain` only when the evidence bundle needs direct post-run Wrangler row
snapshots before cleanup. Otherwise the route cleans its isolated smoke user,
token, channel, replay, log rows, and the temporary audit-failure trigger after
each scenario.

The dry-run plan now includes a review-only `localD1Seed` block with SQL for a
dedicated smoke user, token, OpenAI-compatible channel, and ability row. Review
the SQL before applying it to a local or isolated staging D1 database; the
smoke tool never writes D1 by itself. After applying the SQL, use the emitted
`localD1Seed.smokeApiKey` as the live replay `--api-key`. The
`startup-queue-drain` dry-run intentionally writes
`channels.other_info.realtime_mock_upstream.queue_probe_delay_ms` for the
dedicated mock channel. The mock-fault dry-runs intentionally write
`channels.other_info.realtime_mock_upstream.fault` as `event_stream_failed` or
`accept_failed`. The release Workerd lifecycle suite also recognizes
`runtime_detached` to close the mock outbound socket while preserving the
hibernatable client for attachment-only reconstruction evidence. Do not copy
any `realtime_mock_upstream` fault/delay metadata
onto production channels.

Also run the local platform header-boundary validator self-test. It proves the
smoke verifier rejects forged upstream handoff markers, upstream plans, active
bridge status, and active bridge counts before any staging evidence is trusted:

```powershell
bun run check:realtime-session:platform-header-boundary-contract
```

Then use the platform smoke path because it
does not require a live relay token or upstream provider credentials:

```powershell
$env:REALTIME_SMOKE_URL = $env:STAGING_BASE_URL
$env:REALTIME_SMOKE_COOKIE = "session=<redacted admin session cookie>"
bun run smoke:realtime-session -- --url $env:REALTIME_SMOKE_URL --session session-smoke --cookie $env:REALTIME_SMOKE_COOKIE --expect-platform-ready --json
```

Then run the platform header-boundary live smoke. This uses Bun's WebSocket
handshake headers to forge `x-cinatoken-realtime-upstream-plan` and
`x-cinatoken-realtime-upstream-connect` on the staging-only platform path, and
requires the Durable Object evidence to show no upstream handoff or active
bridge:

```powershell
bun run smoke:realtime-session -- --url $env:REALTIME_SMOKE_URL --session session-smoke --cookie $env:REALTIME_SMOKE_COOKIE --expect-platform-ready --expect-platform-header-boundary --json
```

Then run the platform frame-limit terminal event smoke. This sends a
metadata-only oversized text-frame probe and validates the close event plus
persisted terminal metrics; it does not require a live upstream provider:

```powershell
bun run smoke:realtime-session -- --url $env:REALTIME_SMOKE_URL --session session-smoke --cookie $env:REALTIME_SMOKE_COOKIE --expect-platform-ready --expect-frame-limit-event --json
```

If `/v1/realtime` is explicitly enabled in staging and a low-risk relay token is
available, also run the OpenAI-compatible entry smoke:

```powershell
$env:REALTIME_SMOKE_API_KEY = "<redacted staging token>"
bun run smoke:realtime-session -- --mode v1 --url $env:STAGING_BASE_URL --model gpt-4o-realtime-preview --api-key $env:REALTIME_SMOKE_API_KEY --cookie $env:REALTIME_SMOKE_COOKIE --expect-v1-gate-enabled --json
```

If a local `wrangler dev` Worker or a staging Worker can reach a dedicated mock
upstream endpoint, run the live mock upstream replay. For local development,
apply the reviewed `localD1Seed` SQL from the dry-run output so the dedicated
enabled OpenAI-compatible channel for `gpt-4o-realtime-preview` points at
`http://127.0.0.1:8799/`; the Worker appends `/v1/realtime?model=...`. For
remote Cloudflare staging, do not use `127.0.0.1`; use a public mock endpoint
or a temporary tunnel and set the test channel `base_url` to that reachable
origin before applying the reviewed seed SQL.

```powershell
$env:REALTIME_UPSTREAM_REPLAY_URL = "http://127.0.0.1:8787"
$env:REALTIME_UPSTREAM_REPLAY_API_KEY = "sk-cinatoken-realtime-mock-local"
bun tools/smoke_realtime_upstream_replay.mjs --url $env:REALTIME_UPSTREAM_REPLAY_URL --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --scenario upstream-normal-close --confirm-live --json
bun tools/smoke_realtime_upstream_replay.mjs --url $env:REALTIME_UPSTREAM_REPLAY_URL --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --scenario upstream-frame-limit --confirm-live --json
bun tools/smoke_realtime_upstream_replay.mjs --url $env:REALTIME_UPSTREAM_REPLAY_URL --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --scenario startup-queue-drain --confirm-live --json
bun tools/smoke_realtime_upstream_replay.mjs --url $env:REALTIME_UPSTREAM_REPLAY_URL --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --scenario response-done-usage --confirm-live --json
```

Record:

- Command output with URLs and protocols redacted.
- Bridge replay contract self-test output, including normal/reserved/app
  upstream close handling, upstream error/event-stream/accept failures,
  client-to-upstream and upstream-to-client send-failure metadata, and the
  frame-too-large terminal event contract.
- Upstream replay contract self-test output, including ordered scenarios for
  active bridge status, client-to-upstream forwarding, upstream terminal
  close/error/frame-limit/send-failure events, client close mapping, persisted
  terminal evidence, and redaction rejection cases.
- Mock upstream replay harness self-test and dry-run output, including the
  redacted worker WebSocket URL, mock upstream URL, required channel
  `base_url`, review-only `localD1Seed` SQL, queue-probe metadata for
  `startup-queue-drain`, the `response-done-usage` `expectedUsageCapture`
  block, live scenarios covered, and planned fault-injection-only scenarios.
- Live mock upstream replay output when available, including mock connection
  count, forwarded client frame byte metadata, upstream frame byte metadata,
  observed WebSocket runtime status, observed usage capture metrics for
  `response-done-usage`, observed
  `realtime_session_bridge_event`, and client close event.
- Platform header-boundary self-test output, including the clean case plus
  rejected forged handoff marker, forged upstream plan, active bridge status,
  and active bridge count cases.
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
  `realtime_session_upstream_bridge_close_mapping_compiled`,
  `realtime_session_upstream_bridge_send_failure_guard_compiled`,
  `realtime_session_upstream_bridge_event_trace_compiled`,
  `realtime_session_upstream_bridge_replay_contract_compiled`,
  `realtime_session_upstream_bridge_backpressure_policy_compiled`,
  `realtime_session_upstream_bridge_backpressure_runtime_compiled`,
  `realtime_session_upstream_usage_capture_compiled`,
  `realtime_session_billing_presettlement_snapshot_compiled`,
  `realtime_session_billing_settlement_preview_compiled`,
  `realtime_session_billing_settlement_handoff_compiled`,
  `realtime_session_billing_settlement_mutation_plan_compiled`,
  `realtime_session_billing_settlement_writer_compiled`,
  `realtime_session_billing_settlement_replay_marker_compiled`,
  `realtime_session_billing_settlement_audit_log_compiled`,
  `realtime_session_billing_settlement_batch_compiled`,
  `realtime_session_billing_settlement_retry_compiled`,
  `realtime_session_billing_reservation_lease_compiled`,
  `realtime_session_billing_reservation_lease_seconds`,
  `realtime_session_billing_settlement_write_enabled`,
  `realtime_session_platform_header_boundary_compiled`,
  `realtime_session_platform_smoke_ready`, and
  `realtime_session_v1_cutover_ready`.
- WebSocket `pong` response.
- WebSocket `realtime_session_status` frame, including redacted
  `billing_reservation_lease` record/due counts, next expiry, highest attempts,
  bounded last error, and settlement retry ownership without reservation keys.
- WebSocket `realtime_session_control` probe response, including
  `text_bytes`, `text_chars`, `rawProbeEchoed=false`, and no `received` field.
- Platform header-boundary smoke output, including
  `platformHeaderBoundary.forgedHeaderNames`, `upstreamConnectHandoff=false`,
  `upstreamPresent=false`, `activeUpstreamBridges=0`, and HTTP attachments
  without upstream plans.
- Frame-limit smoke output, including `frameLimitControlFrame`,
  `frameLimitClose`, and `bridgeTerminalEvent`.
- HTTP status response for the platform session path.
- Worker log/trace link for the WebSocket accept and status request.

Pass criteria:

- `REALTIME_SESSIONS` binding is present and the gateway flag under test is on
  only in staging.
- Platform capabilities report hibernation, auth boundary, persisted metrics,
  no-echo controls, the upstream bridge planner, the upstream channel planner,
  the request-scoped upstream connect contract, and the gateway-to-DO connect
  handoff plus upstream fetch-upgrade adapter and transient bridge lifecycle as
  compiled, including the text/binary frame guard and bridge close/error
  mapping plus the upstream send-failure guard, terminal event trace, and
  upstream replay contract, usage capture, billing pre-settlement snapshot,
  billing settlement preview, billing settlement handoff, billing settlement
  mutation plan, default-off billing settlement writer, durable replay marker,
  Go-compatible audit-log foundation, guarded D1 settlement batch foundation,
  bounded DO alarm retry foundation, active reservation lease recovery,
  configured lease seconds, exact D1 migration readiness, current
  settlement-write gate state, and platform upstream-header boundary;
  `realtime_session_platform_smoke_ready=true` before the platform WebSocket
  smoke runs.
- The WebSocket opens, `ping` returns `pong`, and `status` returns persisted
  lifecycle metrics.
- Lease/retry status exposes metadata only; every D1 `reserved` reservation has
  exactly one owner, the configured lease seconds match capabilities, and the
  earliest lease/retry deadline remains scheduled across hibernation.
- Metrics show at least one connect and at least two text messages from the
  WebSocket status frame; platform HTTP status shows at least three text
  messages after `ping`, `status`, and the unsupported-control or frame-limit
  probe.
- Neither persisted metrics nor unsupported-control responses store or echo raw
  message payloads, raw bearer tokens, or raw Realtime protocol API keys.
- For `/v1/realtime` smoke, socket status/control context includes a redacted
  upstream summary (`channel_id`, `channel_type`, selected group, upstream
  model, provider, auth mode, header names/protocol names) plus
  `upstream_connect_handoff=true`, and never includes the raw upstream key,
  bearer header value, or `openai-insecure-api-key.<secret>` protocol value.
- For tiered-expr `/v1/realtime` smoke, status metrics include a redacted
  `last_billing_snapshot` with expression hash/version, estimated quota, and
  request-rule presence, but no raw billing expression, request-rule body,
  request parameters, headers, raw payloads, or upstream credentials.
- The current settlement-preview handoff is exposed through capabilities,
  local tests, and DO metrics before live D1 mutation is wired. Once a live
  preview/final settlement status artifact exists, it must show only expression
  hash/version, usage source, final/refund/additional quota numbers, and
  matched-tier metadata; it must not include the raw billing expression,
  request-rule body, request probe values, raw headers, raw payloads, or
  upstream credentials.
- Before `realtime_session_billing_settlement_compiled=true`, the default-off
  writer has archived evidence that the D1 batch applies the replay marker,
  guarded quota settlement, and audit row together; duplicate replays skip
  without a second audit row; guarded-update and audit failures roll back; the
  local SQLite/D1-shape replay passes; the staging plan's setup/verify/cleanup
  artifacts are reviewed; the same cases are archived against an isolated
  staging D1 through the Worker binding path; and `audit_plan_missing`,
  `write_failed`, and `replay_duplicate` status metadata remains redacted.
- Prove the v1 runtime interlock before any upstream smoke: with
  `REALTIME_SESSION_V1_ENABLED=true` and
  `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED=false`, a valid WebSocket upgrade
  request must receive structured HTTP `503` with
  `realtime_billing_settlement_disabled`, and no channel/upstream request may
  occur. Enable the writer only against isolated staging fixtures.
- Inject a transient D1 settlement failure through the live DO path, run the
  Durable Object alarm, and archive redacted pending/attempt/next-retry status,
  eventual applied-or-duplicate terminal state, retry-record cleanup, and no
  duplicate quota/audit mutation. Also archive paused behavior when the writer
  gate is disabled and exhausted behavior after the bounded attempt limit.
- Treat this alarm proof as durability evidence only. Production billing still
  requires real pre-reserve/refund and per-response identity/CAS coverage for
  two legitimate `response.done` events in one Realtime session.
- If the DO is hibernated/restarted and the outbound upstream socket is no
  longer active, client frames return `upstream_bridge_not_active` rather than
  implying that the upstream session was resumed.
- Oversized bridge frames are rejected with WebSocket close code `1009` and
  metadata-only frame kind/byte-count/max-byte evidence; raw frame payloads are
  never logged, stored, or echoed. The frame-limit smoke must show
  `frameLimitControlFrame.status=upstream_bridge_frame_too_large`,
  `frameLimitClose.code=1009`, and
  `bridgeTerminalEvent.event=frame_too_large`.
- Close/error replay evidence matches the compiled mapping: normal upstream
  close `1000` stays `1000`, reserved/unsafe upstream close codes such as
  `1006` map to `1011`, application close codes such as `4000` pass through,
  upstream errors close the client with `1011/upstream_bridge_error`, and
  client websocket errors close the upstream bridge with
  `1011/client_websocket_error`.
- Send-failure evidence is fail-closed and metadata-only: client-to-upstream
  forwarding failure closes both sides with
  `1011/upstream_bridge_forward_failed`, upstream-to-client forwarding failure
  closes both sides with `1011/client_bridge_forward_failed`, and raw bridge
  payloads are not logged, stored, or echoed in the failure path.
- The bridge replay contract self-test passes before live smoke artifacts are
  accepted. It is not a substitute for a real or mock upstream replay run, but
  it proves the smoke verifier will reject mismatched close codes/reasons,
  directions, frame metadata, or leaked probe/API-key material.
- The upstream replay contract self-test passes before live upstream replay
  artifacts are accepted. It is not a substitute for the eventual live/mock
  upstream server run, but it proves the evidence validator rejects inactive
  pre-terminal status, missing persisted terminal events, wrong client close
  reasons, and leaked raw frame/API-key material.
- The mock upstream replay harness self-test and dry-run plan pass before live
  artifacts are accepted. A live run must use a dedicated non-production
  channel prepared from reviewed `localD1Seed` SQL or an equivalent audited
  channel/token setup, prove the mock received the forwarded client frame, and
  observe a metadata-only `realtime_session_bridge_event` plus matching client
  close. For `startup-queue-drain`, the accepted evidence must also show
  `runtimeStatusProbePhase=after_probe_before_drain`,
  `queued_upstream_frames=1`, and `queued_upstream_bytes` equal to the probe
  byte length before the mock receives the drained frame.
  `upstream-error`, `upstream-event-stream-failed`,
  `upstream-accept-failed`, and `upstream-to-client-send-failure` remain
  separate fault-injection evidence until the Worker has an explicit safe
  staging mechanism for those paths.
- Platform Realtime routes strip caller-supplied
  `x-cinatoken-realtime-upstream-plan` and
  `x-cinatoken-realtime-upstream-connect` before forwarding to the Durable
  Object. Only the authenticated `/v1/realtime` gateway may attach those
  request-scoped upstream handoff headers. The platform header-boundary smoke
  must show `upstream_connect_handoff=false`, no upstream plan in pong/status/
  control/HTTP attachment evidence, `control.status=upstream_bridge_not_wired`,
  and `active_upstream_bridges=0`.
- Terminal bridge evidence is metadata-only: live
  `realtime_session_bridge_event` frames and persisted
  `metrics.last_bridge_terminal_event` include event name, direction, close
  codes/reasons, optional upstream close code, and optional frame byte counts,
  but never include raw frame payloads, bearer tokens, or Realtime protocol API
  keys.
- Realtime billing preview evidence is metadata-only: once a tiered-expression
  mock/live replay emits `response.done`, persisted metrics may include
  `last_billing_settlement_preview` with final/refund/additional quota, actual
  token counts, expression hash/version, request-rule presence, matched tier,
  and crossed-tier status, but never raw billing expressions, request-rule
  bodies, request probe values, raw headers, payloads, bearer tokens, or
  upstream credentials.
- Realtime billing writer evidence is also metadata-only: if a controlled
  staging run explicitly enables `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED`,
  persisted metrics may include `last_billing_settlement_write` with
  enabled/attempted/applied/skip/error status, quota deltas, replay-key hash,
  replay-marker recorded state, `audit_plan_present`, `audit_attempted`,
  `audit_recorded`, and truncated `audit_error`, but never `user_id`,
  `token_id`, `channel_id`, selected group, username, token name, client IP,
  request ID, raw billing expressions, request-rule bodies, request probe
  values, raw headers, payloads, bearer tokens, or upstream credentials.
  Duplicate replay evidence must show `replay_duplicate` without a second quota
  mutation or second audit row.
- Realtime billing audit-row evidence must use Go-compatible `logs` type 2
  rows with redacted `other` metadata: base-expression `expr_b64`,
  `billing_mode`, `matched_tier`, `tiered_billing`, and `realtime_billing`
  replay state are allowed; request-rule bodies, request probe values, raw
  headers, raw payloads, bearer tokens, upstream payloads, Realtime protocol API
  keys, and upstream credentials are not allowed. Marker-write-failed or
  audit-write-failed evidence remains a blocker for production until the final
  settlement path is proven with a single D1 transaction or equivalent CAS
  replay proof.
- The platform HTTP status path shows restored socket attachments and the same
  persisted metrics surface.
- `realtime_session_v1_cutover_ready` remains false until the production bridge
  path has live queue/drain evidence, billing settlement, audit logging, and
  live close/error/protocol replay evidence; `/v1/realtime` remains off in
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
| FRONTEND-005 | Provider readiness on `/channels` | Moonshot type 25 shows Partial with chat, completions, embeddings, rerank, and Messages; SiliconFlow type 40 shows Partial with exactly five routes; MokaAI type 44 remains Deferred with zero routes; API and UI agree |

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
## 2026-07-13 Platform Boundary Addendum

Platform Realtime smoke is now an authenticated admin operation. Set the
complete admin Cookie in `REALTIME_SMOKE_COOKIE` or pass `--cookie`; the harness
uses it for capabilities, the platform WebSocket upgrade, and the HTTP status
probe. A live `--mode platform` invocation without the Cookie must fail before
network traffic. The public `/v1/realtime` mode continues to use relay-token
subprotocol authentication and does not receive the admin Cookie.

Before platform Realtime staging smoke, require both
`realtime_session_platform_admin_auth_compiled=true` and
`realtime_session_platform_smoke_ready=true`. Archive only the redacted report;
never archive the Cookie or raw request headers.

For WFP preview-host response smoke, make a tenant fixture return each of
`Service-Worker-Allowed`, `Service-Worker-Navigation-Preload`, and
`Clear-Site-Data`. The browser-facing preview response must omit all three while
preserving a safe marker such as `x-request-id`. Repeat a WebSocket upgrade and
prove the preview-header rule does not replace or break upgrade handling.
Require `wfp_preview_response_security_headers_compiled=true` in the archived
capability snapshot.

## Phase 4c: Global Realtime Orphan Recovery

Run this phase only in an isolated staging D1 after the exposed credential has
been revoked and a replacement least-privilege credential is active. Keep
`REALTIME_SESSION_V1_ENABLED=false` and
`REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED=false` during initial migration and
fixture setup.

Preconditions:

1. `bun run check` and `bun run check:do-lifecycle-runtime` pass at the exact
   candidate commit.
2. Remote `d1_migrations` is the exact 24-file set through
   `0024_relay_billing_finalization_events.sql`; archive redacted Wrangler output
   and `/api/platform/capabilities` with `d1_migration_ready=true`.
3. Capabilities report global recovery compiled, grace 300, limit in `1..64`,
   ledger status compiled, recovery disabled, and v1 cutover false.
4. Workers Logs and the Realtime recovery dashboard/alert are visible before a
   money-moving fixture is inserted.

Execution order:

1. Deploy with recovery disabled and sweep limit 1. Trigger cron once; prove no
   reservation or quota row changes.
2. Insert one isolated, already-debited reservation whose lease expired less
   than 300 seconds ago. Enable recovery, trigger cron, and prove it remains
   reserved with unchanged user/token quota.
3. Move only that fixture beyond `lease + 300s`, trigger two overlapping
   schedules, and prove one `reserved -> refunded` CAS, one user credit, one
   token credit, no replay/audit duplication, and an aggregate successful sweep.
4. Create an older fixture with an intentionally missing guarded dependency and
   a newer valid fixture. The first schedule must defer the older row without
   partial quota changes; the next schedule must recover the newer row. Verify
   attempt count, `recovery_next_attempt_at`, failed/deferred logs, and no raw
   key/session/prompt/credential in output.
5. Run the settlement boundary fixture: settlement succeeds at the exact
   deadline; at deadline plus one second it is rejected and global recovery is
   the only terminal winner. Repeat across DO eviction/redeploy with a real
   authenticated reserve and settlement-retry owner.
6. Query `GET /api/platform/realtime-billing/ledger/status` with an admin
   session. Require `Cache-Control: no-store`, only SHA-256 fingerprints,
   explicit policy/outcome states, and aggregate sweep counters. Unauthenticated
   access must fail; public status and WebSocket status must contain no records.

Rollback:

1. Disable new Realtime admission.
2. Set `REALTIME_BILLING_ORPHAN_RECOVERY_ENABLED=false` and redeploy; prove a
   subsequent cron performs no global refund.
3. Preserve all D1 rows and logs. Reconcile reserved/settled/refunded counts and
   every fixture quota delta before cleanup.
4. Route selected traffic back to Go/VPS. Do not reverse migration 0022 during
   an incident; its columns/indexes are inert while the gate is false.

Any wrong winner, double mutation, stale successful-sweep signal, unbounded
query count, raw identifier leakage, or unexplained D1/DO ownership state is an
immediate G7 abort. Local Workerd evidence does not satisfy this remote phase.

## Phase 4c.1: HTTP Tiered Billing Reservation Recovery

Apply migrations 0023-0025 while the old Worker still serves and all billing
recovery/finalization gates are false. Only then deploy the ledger-writing Worker. Do not
enable HTTP recovery merely because the capability endpoint says it is ready
to verify.

Pass criteria:

1. Direct JSON, SSE, AI Gateway, cross-model fallback, and WFP-authority relay
   fixtures produce one central D1 reservation owner; WFP performs no billing
   mutation.
2. Reserve, selected bind, settle, explicit refund, matching replay, ambiguous
   commit, and settle/refund race fixtures have exact user/token/channel/request
   deltas and no half mutation.
3. A post-grace unbound fixture refunds exactly once under overlapping cron
   delivery and leaves `request_accounted=0`. A post-grace bound fixture keeps
   reserved quota and moves exactly once to `recovery_required`.
4. `GET /api/platform/relay-billing/ledger/status` rejects non-admin access,
   sends `Cache-Control: no-store`, contains only SHA-256 reservation/account
   fingerprints, and reports refund/quarantine/failure/defer counters.
5. The staging smoke cleanup leaves zero matching reservation, user, token,
   channel, and audit fixture rows.
6. `/api/platform/capabilities` reports the renewal contract compiled, the
   heartbeat explicitly configured and valid, staging verification false,
   recovery false, and cutover readiness false before the fault matrix starts.
7. A real SSE fixture runs beyond the original selected lease, not merely one
   heartbeat interval. It proves repeated generation-fenced lease growth, no
   quota or request-count mutation while active, one terminal settlement, exact
   user/token/channel deltas, and bounded heartbeat audit counters.
8. Repeat the long-stream fixture for every enabled transport owner: direct,
   AI Gateway, and WFP authority. WFP must still perform zero billing mutation.
   Capture latency/backpressure, D1 write count, provider request count, and
   final audit/provider correlation.
9. Repeat with client disconnect, malformed/provider-error termination,
   transient D1 renewal failure, Worker rollout/restart, stale-generation CAS,
   settlement-vs-renewal, and scheduled recovery overlap. No case may interrupt
   a healthy client stream solely because renewal failed, revive an expired
   lease during grace, double settle/refund, or leave an unexplained delta.
10. Enable recovery only in isolated staging after the matrix passes. Prove the
    grace boundary and unbound/bound outcomes, disable recovery again, reconcile
    every fixture, and obtain approval before setting
    `RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED=true`.
11. The verification flag alone must not start recovery. The final capability
    `relay_billing_orphan_recovery_cutover_ready` may become true only when the
    D1 schema, renewal config, enabled recovery gate, and signed staging evidence
    are all present. Without that proof, leave both gates false.

Rollback disables HTTP recovery and Queue finalization first, retains migrations
0023-0025 and every ledger/audit/incident row, routes affected traffic back to Go/VPS, and reconciles all `reserved` and
`recovery_required` rows before any manual quota correction.

## Phase 4d: Tencent Hunyuan TC3 Chat

Run this phase only after credential rotation in an isolated staging account.
Use one dedicated type-23 channel with `appId|secretId|secretKey`; never archive
the raw channel key, Authorization value, canonical request, or derived TC3
keys. Keep AI Gateway and WFP disabled for this channel.

Preconditions:

1. `bun run check` passes at the exact candidate commit and readiness reports
   type 23 Partial with only Chat Completions.
2. The staging Worker clock is observable and within the provider's accepted
   skew. Record UTC timestamp/date metadata without credentials or body data.
3. The Go/VPS type-23 path remains enabled as the immediate rollback target.

Execution order:

1. Send one minimal non-streaming text request and archive redacted provider
   request id, status, model, usage, Worker audit id, reservation, settlement,
   and provider-console billing evidence.
2. Exercise both provider success shapes if the account/API exposes them and
   confirm the OpenAI response plus optional `note` extension is bounded.
3. Re-run with malformed credentials, permission denial, invalid input, rate
   limiting, and induced service failure. Prove 400/401/403/429/503 mapping,
   retry selection, no successful affinity for failed attempts, and exactly
   one terminal settlement or refund.
4. Exercise an accepted timestamp near UTC midnight and a deliberately stale
   timestamp in a non-billable signature probe. Prove the date scope is UTC and
   skew failure does not reserve or settle quota.
5. Submit stream=true, tool fields, multimodal content, an unsupported root
   field, a custom base URL, AI Gateway, and WFP configuration. Every case must
   fail before provider egress and quota reservation.
6. Disable the channel during a controlled request window, confirm no new Rust
   admission, then route the same fixture through Go/VPS and reconcile both
   systems' audit and quota records.

Any leaked credential/signing material, unbounded body, mismatched usage,
retry-after-success, false successful affinity, duplicate terminal mutation,
or inability to return traffic to Go is an immediate G3 abort.

## Phase 4e: HTTP Stream Billing Finalization

Run this phase only after credential rotation and migrations 0023-0025 in
isolated staging. Keep HTTP orphan recovery, Queue finalization, and all three
billing staging-proof flags false during discovery.

1. Long-stream lease matrix: direct, AI Gateway, and WFP each run beyond the
   original selected lease. Assert repeated generation-fenced renewal, bounded
   D1 writes, one provider call, one settlement, exact accounting, and no row
   entering recovery while the stream is active.
2. Termination matrix: `[DONE]`, clean EOF, malformed event followed by valid
   data, reported usage then read error, partial output then read error, empty
   Responses, Responses output delta, client abort, and idle timeout. Record a
   distinct termination reason and usage source for every case.
3. Queue resource gate: authenticated readback must prove the staging producer,
   consumer, bounded batch/retries, environment-specific DLQ, alerts, and no
   production queue reuse. Enable Queue finalization only for isolated fixtures.
4. Durable replay matrix: inject Worker cancellation after response completion,
   D1 ambiguous commit, Queue retry and duplicate delivery, DLQ routing, and
   settlement-versus-recovery overlap. The frozen final decision
   must settle through idempotent D1 CAS without re-reading mutable pricing.
5. Reconcile gate: first prove unauthenticated, non-root, and root-without-step-
   up requests fail. A root operator with a fresh `/api/verify` marker then
   selects one explicit 64-hex incident ID and sends only
   `{ "confirm_replay": true }`. Require `202 queued`, one redacted manage
   audit, one main-queue financial CAS, terminal incident resolution, and `409`
   on a second replay. Invalid incidents must contain no raw payload and must
   never be replayable. Disable reconciliation immediately after the fixture.
6. Recovery matrix: verify the 300-second boundary, unbound refund, bound
   quarantine, pre-bind generation race, failed-oldest deferral, and manual
   reconciliation. No fixture may leave an unexplained `reserved` or
   `recovery_required` row.
7. For every fixture archive provider call count, user/token/channel before and
   after values, request count, ledger outcome, usage source, termination reason,
   Queue event/retry identity, audit row, trace, and cleanup readback.

Attaching clone-stream work to `waitUntil()` is not a pass condition. Do not set
`RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED`,
`RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED`, or
`RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED` until the corresponding
matrix is signed independently. `relay_billing_orphan_recovery_cutover_ready`
must remain false without Queue enablement/binding, consumer, DLQ, replay,
reconcile, D1 readiness, and signed staging proof.

Queue readback for this phase must include the producer, primary consumer, DLQ
consumer, per-message retry policy, DLQ, and environment-specific parking
queue. Attach lag and oldest-message alerts plus an owner action that completes
before Cloudflare's four-day DLQ retention. At-least-once delivery means every
fixture must prove duplicate convergence; an ACK only proves local handling,
not exactly-once delivery.

## Phase 4f: HTTP Pre-Bind Owner Generation Race

Run only after credential rotation, old-Worker drain, and migration 0026 in an
isolated staging environment. Keep Queue finalization, reconcile, orphan
recovery, and every billing staging-proof variable false at deployment time.

Preconditions:

1. Query `relay_billing_reservations` from the frozen old deployment and prove
   zero `status='reserved'` rows. Migration 0026 must fail if this count is not
   zero; do not edit around its guard.
2. Apply the exact 26-file migration set and archive redacted evidence for 30
   tables, 126 checked incremental columns, 23 indexes, and latest migration
   `0026_relay_billing_owner_generation.sql`.
3. Deploy one candidate with explicit reservation deadline and heartbeat
   values. Require capability state compiled=true, schema-ready=true,
   configured=true, staging-verified=false, and cutover-ready=false.
4. Confirm Queue schema v2 is deployed before creating generation-2 events.
   Legacy v1 messages are drain-only and valid only for owner generation 1.

Execution matrix:

1. Hold provider response headers behind a deterministic barrier. While held,
   prove pre-bind heartbeats update only lease metadata and preserve generation
   1, quota, request count, and unbound channel identity.
2. Release before the original deadline. Exactly one bind CAS selects the
   channel/group and advances generation 1 to 2. Repeat through direct provider,
   AI Gateway direct fallback, and model fallback.
3. Release after the original deadline. Bind fails closed even if a heartbeat
   recently renewed the observation lease. No provider response is accepted
   under an expired owner deadline.
4. Inject ambiguous D1 responses after reserve and bind commits. Exact readback
   may accept only the identical frozen reservation or selection. Any changed
   field, generation, deadline, channel, or group is a conflict.
5. Race settlement/refund, Queue duplicate delivery, and scheduled recovery.
   The winner advances generation once; losers perform no accounting or audit
   mutation.
6. Prove settlement is legal at `lease_expires_at + 300` and recovery is not.
   At `lease_expires_at + 301`, recovery may win and late settlement/bind is
   rejected.
7. Interrupt and redeploy during every phase, then rehearse Go/VPS rollback.
   Disable recovery and reconcile first, stop Rust admission, drain Queue and
   ledger ownership, and preserve the highest generation.

Archive hashes and bounded metadata only: candidate SHA, capability response,
reservation fingerprint, generation transitions, timestamps, Queue attempts,
provider-call count, accounting before/after, audit identity, and rollback.
Any raw credential, mutable-price replay, generation reuse, double mutation,
pending row, or second provider call is an abort.

## Phase 4g: QuotaCoordinator Tiered Shadow Foundation

Do not run this phase until the exposed credential is rotated, the exact
candidate is deployed with `QUOTA_COORD_SHADOW_ENABLED=false`, and every
financial path remains D1-authoritative. The class binding alone is not a pass.

Preconditions:

1. Authenticated configuration readback proves one SQLite-backed
   `QuotaCoordinator` class in staging and no namespace reuse with production.
   Capabilities must report foundation/binding and all producer families true,
   plus `quota_coordinator_retention_compaction_compiled=true` and
   `quota_coordinator_reconciliation_compiled=true`, but operator retention
   readiness, reconciliation runtime, shadow runtime, write authority, staging
   proof, and cutover false while the token allowlist remains empty.
2. A producer-coverage audit maps tiered reserve, synchronous settle/refund,
   billing Queue finalize/replay, and orphan recovery to exactly one observer
   emission after the corresponding D1 outcome. Flat billing emits none.
3. Start from the local baseline: 512 active, 1,536 retained terminal records,
   a 1,500,000-byte JSON write guard, and a 1,234,821-byte configured-maximum
   fixture. Load evidence must measure the deployed structured-clone size,
   p50/p95/p99 transaction latency, per-token terminal rate, resulting replay-
   window duration, eviction, compaction rate, expired-window conflicts, alert
   thresholds, and expected cost. The local JSON measurement is not remote
   proof. Any legacy terminal count, size-guard failure, unexplained expired
   event, or capacity saturation is an abort.

Execution:

1. With retention and shadow gates false and the token allowlist empty, run
   representative tiered requests and prove zero DO mutation and unchanged D1
   accounting.
2. After precondition 3 is signed, set `QUOTA_COORD_RETENTION_VERIFIED=true`,
   configure `QUOTA_COORD_SHADOW_TOKEN_IDS` with isolated staging tokens, and
   open `QUOTA_COORD_SHADOW_ENABLED` last. Exercise reserve, exact replay,
   payload conflict, settle-above/below reserve, refund, Queue duplicate,
   orphan recovery, terminal-window rotation, replay before/after the watermark,
   Worker replacement, DO eviction, and malformed/corrupt state. Before-window
   replay must be idempotent; after-window replay must be an explicit conflict
   and alert without any D1 mutation. D1 remains the sole mutation source.
3. Confirm capabilities now report
   `quota_coordinator_reconciliation_runtime_ready=true`, then run the read-only
   D1-DO-D1 probe for each isolated allowlisted token:

   ```powershell
   bun run smoke:quota-coordinator-reconciliation -- `
     --url https://<staging-worker-origin> `
     --token-id $env:QUOTA_COORD_RECONCILIATION_TOKEN_ID `
     --cookie $env:QUOTA_COORD_RECONCILIATION_COOKIE `
     --confirm-live --json
   ```

   PASS requires `matched`, `source_stable=true`, `observer_healthy=true`, all
   13 differences equal to zero, no persisted conflict, no legacy terminal
   record, and state bytes within the reported limit. `source_changed` is an
   inconclusive sample and may be retried after the ledger is quiet;
   `mismatch` or `observer_state_missing` is an abort and alert. Reconcile
   normal settle-above/below-reserve, refund, Queue replay, orphan recovery,
   eviction, and compaction windows. Archive only the candidate SHA, capability
   snapshot, token scope hash, aggregate projections/deltas, diagnostics,
   timestamps, and alert/rollback evidence. Never archive the cookie or raw
   token/reservation identity.
4. Disable shadow before rollback traffic changes, then clear retention and
   token-scope assertions. Prove requests and all D1 finalizers continue
   normally, drain observer/reconciliation work, and retain DO state only as
   non-authoritative evidence.
5. Repeat for at least 30 days. Set `QUOTA_COORD_STAGING_VERIFIED=true` only
   after zero unexplained deltas, no state-size/capacity breach, alert/rollback
   drills, and data/billing/SRE owner signatures.

This phase cannot grant read or write authority. Any observer-driven quota
mutation, hot-path comparison latency, raw token/reservation identifier, false
ready capability, or unexplained delta is an immediate G4/G5/G7 abort.
