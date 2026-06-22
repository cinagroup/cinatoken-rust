# Staging Smoke Runbook

Date: 2026-06-22

Status: first detailed smoke runbook for the Rust/Cloudflare staging
environment. This runbook supports G1, G3, G4, G6, and G7 in
`docs/production-migration-execution-plan.md`.

## Purpose

Use this runbook to prove that a staging Worker behaves like a production
candidate before any customer canary. It is intentionally evidence-heavy: every
step should leave a request ID, log entry, command output, dashboard screenshot,
or short report.

Use `docs/cloudflare-production-config-checklist.md` before Phase 1,
`docs/data-migration-runbook.md` before Phase 7,
`docs/billing-parity-runbook.md` before Phase 5, and
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

## Phase 4: SSE Relay Smoke

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

## Phase 8: Observability And Security Smoke

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
- Admin mutation routes write audit events before Scenario B/C.

Pass criteria:

- An operator can answer who called what, through which token/channel/model,
  which upstream responded, and which quota mutation occurred.
- Security-sensitive values are redacted.

## Phase 9: Canary Rehearsal

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
