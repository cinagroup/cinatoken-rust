# Performance, Capacity, And Cost Runbook

Date: 2026-06-22

Status: production migration runbook for load, capacity, cost, and efficiency
evidence. This supports G6 observability, G7 canary, G8 cutover, and G9
post-cutover hardening in `docs/production-migration-execution-plan.md`.

## Purpose

This runbook defines how to prove that `cinatoken-rust` can handle
production-shaped traffic on Cloudflare without hidden latency, platform-limit,
or cost regressions versus the Go/VPS deployment.

It is not a generic benchmark plan. It is specific to this migration: relay
auth, channel selection, model mapping, D1 quota and audit paths, Upstash
cache/rate limiting, streaming response passthrough, admin operations, and
future Queue/R2 task workloads.

Read this file with:

- `docs/production-migration-execution-plan.md`
- `docs/production-readiness-matrices.md`
- `docs/staging-smoke-runbook.md`
- `docs/cutover-rollback-runbook.md`
- `docs/observability-slo-security-runbook.md`
- `docs/route-provider-parity-runbook.md`
- `docs/data-migration-runbook.md`
- `docs/admin-frontend-parity-runbook.md`
- `docs/billing-parity-runbook.md` for billing delta thresholds only.
- `docs/verification.md`

Do not commit raw load-test payloads, provider responses, customer-like logs,
screenshots with secrets, or cost exports containing account identifiers.
Commit only redacted summaries.

## References Refreshed

Cloudflare and platform references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Workers pricing:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Workers Logs:
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Workers metrics and analytics:
  <https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>
- D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>
- D1 pricing:
  <https://developers.cloudflare.com/d1/platform/pricing/>
- Queues limits:
  <https://developers.cloudflare.com/queues/platform/limits/>
- R2 limits:
  <https://developers.cloudflare.com/r2/platform/limits/>
- Workers Analytics Engine pricing:
  <https://developers.cloudflare.com/analytics/analytics-engine/pricing/>
- Upstash Redis pricing:
  <https://upstash.com/pricing/redis>
- Upstash Redis REST API:
  <https://upstash.com/docs/redis/features/restapi>

Tooling reference:

- Latest `@cloudflare/workers-types` fetched with `npm pack` on 2026-06-22:
  `4.20260621.1`.

Re-check pricing and limits immediately before production approval. Cost and
platform limits are operational contracts, not static source code.

## Principles

- Benchmark against production-shaped behavior, not synthetic happy paths only.
- Compare Rust/Cloudflare against the Go/VPS baseline by route family,
  provider family, model, token group, and stream mode.
- Keep the Worker hot path small. Heavy transforms, task polling, long retries,
  bulk log writes, and archive writes move to Queues, Workflows, R2, or a
  documented service escape hatch.
- Stream unknown-size request and response bodies. Buffer only bounded JSON or
  small control-plane responses with route-specific limits.
- D1 is source of truth for relational state, but high-volume logs and task
  artifacts must not turn D1 into the only event sink.
- Upstash Redis improves hot-path latency and abuse controls, but D1 remains
  the correctness fallback for auth/channel/user state.
- No canary promotion may depend on metrics that are not visible during the
  observation window.
- Cost approval must include current traffic, 2x traffic, and 5x traffic.

## Platform Guardrails

Record the current official value and observed staging value in every report.

| Area | Current Official Guardrail | Migration Meaning |
| --- | --- | --- |
| Worker memory | 128 MB per isolate | Large provider bodies, audio/video/file uploads, and exports must stream or move off hot path. |
| Worker CPU | Paid plan default 30 seconds, configurable up to 5 minutes | Relay should stay far below default; CPU-heavy parsing/tokenization must be measured. |
| HTTP duration | No hard duration while client remains connected | SSE can stream, but disconnect behavior and post-response work must be measured. |
| `waitUntil()` | Extends post-response work up to 30 seconds | Audit/settlement branches must finish or fail observably within this window. |
| D1 database size | Paid plan database limit is 10 GB | Logs/history cannot grow indefinitely in one D1 database. |
| D1 query duration | Maximum SQL query duration is 30 seconds | Admin search/export queries must be indexed and paginated. |
| D1 per-invocation queries | Paid plan permits more than Free but is still bounded | Count auth, channel, billing, audit, and admin query fan-out. |
| D1 concurrency | Individual D1 databases process queries one at a time | Write-heavy quota/log paths need batching, short queries, and canary observation. |
| Queues message size | 128 KB | Queue messages carry metadata/pointers, not raw payloads. |
| Queues throughput | Per-queue throughput is bounded | High-volume logs/tasks may need batching or multiple queue families. |
| R2 object size | R2 is suitable for large objects | Use R2 for archives/artifacts; avoid hot concurrent writes to the same object key. |
| Workers Logs retention | Current docs list 7 days | Long-term audit/cost data needs Logpush, Analytics Engine, R2, or another approved sink. |

## Baseline Inventory

Capture these before any meaningful load test:

| Input | Source | Required Fields |
| --- | --- | --- |
| Go/VPS baseline | Existing production logs/metrics | Route, provider, model, status, p50/p95/p99, stream first byte, error rate, request count |
| Traffic mix | Go/VPS logs or sampled gateway logs | Route family %, stream %, provider %, model %, token group %, body-size classes |
| Data shape | Source DB inventory and D1 staging import | Row counts, index coverage, hot token/channel counts, log table size |
| Provider keys | Staging secret inventory | Provider families, safe rate/spend limits, concurrency caps |
| Cloudflare resources | Config checklist | Worker env, D1 ID, queues, R2, Upstash env, observability sampling |
| Cost inputs | Cloudflare/Upstash dashboards or exports | Worker requests/CPU, D1 reads/writes/storage, Redis commands/bandwidth, logs volume |

If the Go/VPS baseline is unavailable, run a controlled side-by-side staging
comparison and mark the report as an inferred baseline. Do not use inferred
baselines to approve broad customer canary without owner sign-off.

## Load Test Profiles

Run profiles in order. Stop at the first blocker and write a short finding
before increasing load.

| Profile | Purpose | Minimum Shape | Required Evidence |
| --- | --- | --- | --- |
| LT-001 static/status | Worker startup, routing, `/api/status` overhead | 5-10 minutes, no upstream provider | Worker logs, p95/p99, CPU, D1/Upstash feature status |
| LT-002 auth/cache | Token auth, channel selection, read-through cache | Repeated valid token/model calls with upstream stub or low-cost provider | cache hit ratio, D1 read reduction, Redis latency/errors |
| LT-003 non-stream relay | JSON relay hot path | Mixed chat/completions/responses/embeddings/rerank requests | added latency, D1 writes, usage parsing, quota settlement |
| LT-004 SSE relay | streaming passthrough and audit branch | Stream-enabled chat/responses/messages/Gemini routes | first-byte latency, stream duration, audit completion, missing-usage refund path |
| LT-005 provider errors | upstream 429/5xx/timeouts | Controlled bad upstream key or provider sandbox | error mapping, refund/fallback, no retry storm |
| LT-006 D1 write pressure | quota reserve/refund/settlement and logs | Concurrency ramp with successful and failed upstream calls | D1 latency, overloaded errors, rows read/written, pending/refund metadata |
| LT-007 Redis failure/degrade | cache/rate-limit outage behavior | Inject timeout/error or disable staging credential | fail-open/fail-closed behavior, no D1 corruption |
| LT-008 admin operations | Scenario B operator paths | Token/channel/user/log/settings smoke under relay background load | mutation latency, audit, cache invalidation, no secret leak |
| LT-009 Queue/R2 tasks | Future async workload | Queue producer/consumer and R2 artifact smoke when implemented | backlog, retries, DLQ, artifact read/write/delete |
| LT-010 soak | leak/regression detection | 2-4 hours at approved staging load or internal canary load | stable error rate, no memory/resource-limit errors, cost estimate |

Recommended first target for Scenario A remains a mixed relay test at
500-concurrency or an agreed production-shaped equivalent. If provider spend or
rate limits make live upstream load unsafe, use a staged approach:

1. Worker/D1/Redis load with provider stubs or low-cost local echo upstream.
2. Small live-provider sample to prove headers, streaming, usage, and errors.
3. Internal-token production canary for real edge/provider behavior.

## Traffic Mix Template

Fill before LT-003 and update after each canary window.

| Dimension | Current Baseline | Staging Test Mix | Notes |
| --- | --- | --- | --- |
| Total requests/day | TBD | TBD | Use Go/VPS logs or Cloudflare analytics. |
| Peak requests/minute | TBD | TBD | Record peak window timezone. |
| Stream ratio | TBD | TBD | Separate SSE from JSON. |
| Route mix | TBD | chat, responses, embeddings, rerank, messages, Gemini | Keep blocked multipart routes at 0. |
| Provider mix | TBD | OpenAI-compatible, Anthropic, Gemini, Jina/Cohere | Match first-canary scope only. |
| Average prompt/output class | TBD | small/medium/large buckets | Avoid raw payload storage. |
| Token/channel cache hit target | TBD | TBD | Must improve after warmup. |
| Admin mutation rate | TBD | low background | Scenario B only. |
| Error injection rate | TBD | controlled | Keep safe and reversible. |

## Metrics To Capture

| Metric | Source | Why It Matters |
| --- | --- | --- |
| request count by route/provider/model | Workers Logs, analytics, load tool | Traffic attribution and cost. |
| status classes and error classes | Worker structured logs | Abort and rollback decisions. |
| p50/p95/p99 wall latency | Load tool and Worker logs | Customer-visible performance. |
| upstream first-byte latency | Relay audit logs/load client | Separates Rust overhead from provider latency. |
| SSE first-byte overhead | Streaming client | Main streaming UX indicator. |
| stream completion and truncation count | Streaming parser/audit | Detects broken passthrough or disconnect handling. |
| Worker CPU time | Workers Logs/metrics | CPU cost and resource-limit risk. |
| Worker wall time | Workers Logs/metrics | Long streaming/slow provider behavior. |
| memory/resource-limit errors | Workers metrics/logs | Detects unbounded buffering or leaks. |
| D1 query duration and errors | D1 meta/logs/dashboard | Throughput and indexing risk. |
| D1 rows read/written | D1 meta/dashboard | D1 cost and index efficiency. |
| Upstash command count/latency/errors | Upstash metrics and Worker logs | Redis cost and failure behavior. |
| cache hit ratio | Worker logs | D1 load and latency reducer. |
| rate-limit denials | Worker logs | Abuse-control behavior under load. |
| queue backlog/DLQ/retry count | Queue metrics | Async capacity and failure mode. |
| R2 operation count/object size | R2 metrics | Artifact/archive cost and limits. |
| log volume and sampling rate | Workers Logs/Logpush | Observability cost and retention. |

## Candidate Thresholds

These are starting thresholds. Replace them with measured Go/VPS baseline plus
owner-approved tolerances before production canary.

| Signal | Candidate Threshold | Blocks |
| --- | --- | --- |
| Rust 5xx | No worse than Go/VPS baseline plus 0.5 percentage points | Any customer canary promotion |
| Non-stream p95 overhead | Under 300 ms versus Go/VPS for same provider class | Broad relay canary |
| SSE first-byte p95 overhead | Under 500 ms versus Go/VPS | Streaming canary expansion |
| D1 P0 writes | 0 failed auth/reserve/settlement writes in internal canary | Paid traffic ownership |
| D1 overloaded/query errors | 0 in staging load at selected scope | Broad canary |
| Resource-limit errors | 0 memory/CPU limit errors | Any route-family promotion |
| Cache hit ratio after warmup | Target set per route; unexplained drops investigated | Broad canary if D1 pressure rises |
| Upstash error rate | No source-of-truth corruption and documented degrade path | Rate-limit/cache dependent canary |
| Audit branch completion | 100% for selected scope or documented pending/retry path | Paid/operated canary |
| Log availability | Every internal canary request searchable by request ID or approved deterministic sample | Any canary expansion |
| Estimated monthly cost | Approved for current, 2x, and 5x traffic | Full cutover |

## Cost Model

Create a redacted spreadsheet or report with these rows. Use current public
pricing, actual account plan data, or contract terms. If contract terms differ
from public pricing, cite the internal source in the private report and commit
only the approved summary.

| Cost Driver | Formula Input | Source |
| --- | --- | --- |
| Worker requests | monthly request count after static asset/API split | Workers pricing/dashboard |
| Worker CPU | average CPU ms by route * monthly requests | Workers Logs/metrics |
| Static assets | request count and deployment model | Workers/static assets or Pages pricing policy |
| D1 reads | rows read by auth/channel/log/admin queries | D1 meta/dashboard |
| D1 writes | quota/log/admin writes, index write amplification | D1 meta/dashboard |
| D1 storage | current + projected table/index size | D1 dashboard/import report |
| Workers Logs/Logpush | sampled request logs delivered | Workers Logs/Logpush pricing |
| Analytics Engine | data points and query count, if enabled | Analytics Engine pricing |
| Upstash Redis | commands, bandwidth, storage, selected plan | Upstash dashboard/pricing |
| Queues | messages, batch size, retries, DLQ volume | Cloudflare dashboard/pricing |
| R2 | stored GB, Class A/B operations, egress model | R2 dashboard/pricing |
| Provider spend | upstream requests/tokens/media tasks | Provider dashboards |

Forecast scenarios:

| Scenario | Traffic Multiplier | Required Output |
| --- | --- | --- |
| current | 1x | Expected monthly cost and top 3 drivers |
| growth | 2x | Expected monthly cost and saturation risk |
| stress | 5x | Expected monthly cost, first platform bottleneck, mitigation owner |
| incident | provider outage/retry spike | Worst-case cost control and rate-limit behavior |

Cost controls to document:

- per-token and per-IP rate limits;
- provider spend caps and safe staging keys;
- cache TTL and invalidation policy;
- log sampling and retention policy;
- D1 query/index review for high-row-read queries;
- Queue batching and R2 archive thresholds;
- feature flags for expensive provider/task families.

## D1 Capacity Review

For each D1 query used by relay/admin/billing paths, record:

```text
Query family:
Route/use case:
Repository function:
Indexes used:
Expected rows read:
Expected rows written:
P95 SQL duration:
Worst observed duration:
Rows returned:
Can be paginated:
Can be cached:
Can move to Queue/R2/archive:
Risk:
Owner:
```

Rules:

- Any admin/log query that can scan large tables must be indexed, paginated, or
  deferred before Scenario B.
- Any relay hot-path query with unbounded row reads blocks G3/G7 promotion.
- Any write path that updates many rows per request must be redesigned or
  queued.
- D1 `rows_read` and `rows_written` from query meta should be captured in
  staging load reports where feasible.

## Reporting Template

Create a redacted performance/cost report with:

```text
Report:
Date:
Commit:
Worker version:
Wrangler version:
Workers types version:
Staging/prod URL:
Load tool:
Traffic profile:
Provider families:
Data snapshot:
Sampling policy:
Go/VPS baseline source:
Overall result:
Known deviations:
```

For each load profile:

```text
Profile ID:
Duration:
Concurrency/rate:
Route mix:
Provider mix:
Requests:
Error rate:
p50/p95/p99:
SSE first-byte p95:
Worker CPU p95:
D1 rows read/written:
D1 errors:
Upstash commands/errors:
Queue backlog/DLQ:
R2 operations:
Estimated monthly cost at 1x/2x/5x:
Pass/fail:
Notes:
```

## Go/No-Go

Performance/cost evidence is ready for canary when:

1. Baseline traffic mix is recorded or an owner-approved inferred baseline is
   documented.
2. LT-001 through LT-007 pass for Scenario A.
3. LT-008 passes before Scenario B.
4. LT-009 passes before async/task/media cutover.
5. Soak test or internal canary window shows no resource-limit errors.
6. D1 hot-path queries have bounded row reads and acceptable durations.
7. Upstash failure behavior is observed and does not corrupt D1 truth.
8. Logs are available during the load window and cost of sampling is approved.
9. Cost forecast is approved for current, 2x, and 5x traffic.
10. Top bottlenecks have owner, mitigation, and rollback path.

Stay blocked if:

- load tests rely only on stubbed providers and no live-provider sample exists;
- D1 returns overloaded/query errors at the selected canary load;
- any unknown-size route buffers request/response bodies;
- Worker resource-limit errors appear;
- logging is missing during load;
- cost estimate is missing or unapproved;
- rollback cannot stop the expensive or failing traffic segment quickly.

## Rollback And Mitigation

If performance or cost thresholds fail:

1. Stop increasing Rust traffic.
2. Route affected token/group/provider families back to Go/VPS.
3. Preserve Rust logs, D1 rows, Upstash metrics, and load tool output.
4. Disable or lower rate limits for expensive test keys only if safe.
5. Reduce log sampling only after preserving incident evidence.
6. Open an owner-tracked mitigation: index, cache, queue, stream, provider
   adapter, or route-scope rollback.
7. Re-run only the failed profile plus one adjacent profile before resuming
   canary.

Common mitigations:

| Failure | First Mitigation |
| --- | --- |
| High D1 rows read | Add index, narrow query, cache result, or archive old rows. |
| D1 write pressure | Batch non-critical writes, move logs to Queue, reduce sync audit payload. |
| Worker CPU high | Remove hot-path parsing, stream more data, move heavy work to Queue/Workflow. |
| Memory/resource error | Stop buffering, lower response audit limit, block large-body endpoint. |
| Upstash cost spike | Increase cache TTL carefully, reduce rate-limit command fan-out, consider fixed plan. |
| Log cost spike | Adjust sampling, move high-cardinality analytics to approved sink, keep canary traceability. |
| Provider spend spike | Lower canary scope, cap provider keys, add route/provider rate limits. |
