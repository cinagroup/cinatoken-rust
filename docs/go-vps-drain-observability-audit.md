# Go/VPS Production Drain Observability Audit

Date: 2026-07-19

Status: read-only source audit. This document neither authorizes nor performs a
production cutover, process stop, route change, migration, rollback, or remote
mutation.

## Scope And Evidence Pin

This audit is pinned to the Go repository `C:\cinagroup\cinatoken` at:

`73652508abc5cb09214dde02d51d69d1d1ccc703`

All Go line references below refer to that exact commit, not an unpinned working
tree. The Rust-side evidence contract is the current workspace implementation in
`C:\cinagroup\cinatoken-rust`.

The audit was performed from Git objects and selected source files only. It does
not inspect live VPS, reverse-proxy, SQL, LOG_DB, Redis, Cloudflare, or traffic
state. It does not read `C:\cinagroup\cinatoken\controller\nul`, any secret or
authentication value, task private data, order provider payload, raw body,
header, cookie, environment value, or protected external reference.

The conclusion is deliberately fail-closed: the pinned Go process has useful
HTTP and DB evidence surfaces, but it does not expose enough process-local state
to prove a safe production drain by itself.

## Executive Finding

At this Go HEAD, a quiet proxy and `active_connections = 0` are necessary but
not sufficient. The runtime can still contain:

- request-local `BillingSession` state;
- refund goroutines whose durable effects have not completed;
- five deferred batch maps;
- quota-export data held only in a process map;
- recurring scheduler work; and
- task rows whose terminal status and financial settlement are separated by a
  crash window.

There is no coordinated shutdown path. The main server is started with
`server.Run`, while the only process cleanup is a normal-return `defer` that
closes DB connections. No signal handler, `http.Server.Shutdown`, drain flag,
background cancellation, final batch/export flush, or goroutine wait is present
(`main.go:70-92`, `main.go:181-243`). The repository's systemd template uses
`Restart=always` but defines no `ExecStop`, `KillSignal`, `KillMode`, or explicit
stop timeout (`cinatoken.service:1-15`). Therefore a stop/restart or default
SIGTERM is not source-level proof that in-flight financial work completed.

The Rust evidence verifier correctly requires direct per-process zero counts for
BillingSessions, refund jobs, and all five batch maps
(`tools/go_vps_cutover_evidence_contract.mjs:882-970`). The pinned Go binary has
no endpoint or registry that can supply those counts. Unless an independently
validated collector can directly observe them, `process-state-drain` must be
reported as `unknown`, and the overall decision must remain `not-proven`.

## 1. OS And Reverse-Proxy Evidence

### 1.1 What the repository proves

The Go repository contains a generic systemd unit template. It proves only an
intended executable/working-directory relationship, automatic restart, and a
five-second restart delay (`cinatoken.service:1-15`). It does not prove the live
unit path, drop-ins, binary digest, process count, master/replica role, stop
semantics, or whether production is using systemd at all.

The process listens through Gin on the configured port and does not construct an
`http.Server` with shutdown handling (`main.go:232-243`). The repository also
contains a container health check against `/api/status`, but that check only
proves an HTTP response with `success=true`; it is not a drain or dependency
check (`docker-compose.yml:42-46`).

No Nginx, Caddy, HAProxy, or other production reverse-proxy configuration is
present in the pinned tree. Consequently, all proxy topology, connection, route,
timeout, buffering, upgrade, and last-acceptance facts are live evidence, not
source facts.

Long-lived protocols must be handled explicitly. `/v1/realtime` is a WebSocket
route, and the same relay router exposes chat, messages, responses, and other
potentially streaming HTTP routes (`router/relay-router.go:69-105`). An HTTP
request total cannot stand in for SSE or WebSocket state.

### 1.2 Minimum live OS evidence

Collect the following on every production host without reading process
environment, command-line secrets, open file contents, or application payloads:

1. Service manager identity and stop policy. Allowlist only unit identity,
   `ActiveState`, `SubState`, `MainPID`, start time, fragment/drop-in paths,
   `Restart`, `KillMode`, `KillSignal`, and `TimeoutStopUSec`. Do not archive raw
   environment or unrestricted `systemctl cat` output.
2. One complete process inventory, including child/container processes and
   unknown listeners. Map real PIDs to stable opaque IDs such as `go-01` in a
   protected collector index; evidence JSON should use only the opaque IDs.
3. SHA-256 of `/proc/<pid>/exe` for every Go process and a separate digest of the
   redacted deployment definition. The artifact digest must match the candidate
   manifest.
4. Listener and established-connection counts attributed to each old Go PID.
   Capture counts, observation timestamps, and collector status, not peer IPs or
   raw `ss` rows.
5. Process start identity that prevents PID reuse from mixing samples, for
   example opaque host identity plus boot identity plus process start ticks.

An allowlisted service-manager query can be shaped like this:

```sh
systemctl show cinatoken \
  --property=Id,LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp \
  --property=FragmentPath,DropInPaths,Restart,KillMode,KillSignal,TimeoutStopUSec
```

Artifact and socket collectors should reduce their output to digests and counts
before evidence packaging. Do not place raw paths, PIDs, peer addresses, process
arguments, or socket rows in the verifier input.

### 1.3 Minimum live reverse-proxy evidence

First identify the actual proxy/LB product and all config generations serving
the cohort. Do not assume the repository template describes production. Archive
a separately protected, redacted config snapshot and emit only its identity
digest plus derived facts.

The redacted snapshot must prove:

- every listener and route that can reach Go, including HTTP, SSE, WebSocket,
  and task-submit paths;
- the exact old-Go upstream set before and after drain;
- whether connection reuse can continue sending work to a removed upstream;
- WebSocket upgrade handling, SSE buffering, upstream keepalive, and read/send
  timeouts;
- the config generation and reload success used for drain;
- zero load-balancer open connections to Go;
- zero host established connections to every Go PID;
- a last accepted operation timestamp at or before `drainStartedAt`; and
- at least 60 seconds of post-drain observation with zero accepted-after-drain,
  active, and in-flight counts for each required protocol.

Raw proxy configuration may contain sensitive header values. The collector must
allowlist routing and timeout directives and redact all other header values
before hashing or archiving. Raw access log lines are also outside the evidence
JSON; reduce them to timestamps and counts.

These facts map directly to `ingress-drain`, which requires independent HTTP,
SSE, WebSocket, and task-submit zeroes plus host and LB zeroes
(`tools/go_vps_cutover_evidence_contract.mjs:796-879`). A process endpoint is
corroboration only.

## 2. Existing Process Endpoints And Blind Spots

### 2.1 `/api/status`

`GET /api/status` is public (`router/api-router.go:14-27`). Its handler returns
version, start time, feature/configuration fields, and `success=true`, but it
does not ping SQL, LOG_DB, Redis, scheduler state, or process-local work
(`controller/misc.go:42-168`). It is suitable for identifying a responding
instance and its start time. It is not readiness, liveness with dependencies, or
drain completion.

The container health check uses this endpoint (`docker-compose.yml:42-46`), so a
green container health state inherits the same limitation.

### 2.2 `/api/status/test`

`GET /api/status/test` is admin-protected (`router/api-router.go:24-27`). It
returns 503 on `PingDB` failure and otherwise returns `http_stats`
(`controller/misc.go:23-40`). This is the strongest existing process endpoint,
but its only process counter is `active_connections`.

That counter increments around `c.Next()` in `StatsMiddleware`
(`middleware/stats.go:9-40`). The middleware is installed by the relay router
(`router/relay-router.go:13-18`), after API and dashboard routes are registered
(`router/main.go:15-19`). It is useful as a lower-bound view of active relay-side
handlers, including long-lived handlers that have not returned. It does not
count:

- BillingSession objects after/between financial steps;
- refund goroutines;
- batch-map entries or a batch flush in progress;
- quota-export map entries or export progress;
- task pollers and other schedulers;
- DB writes queued in asynchronous cache/log helpers;
- per-protocol accepted-after-drain totals; or
- LB connections that have not reached the Go handler.

An observed zero must never be copied into those unrelated contract fields.

### 2.3 `/api/uptime/status`, perf metrics, and pprof

`GET /api/uptime/status` fetches configured external monitor groups and can
return an empty successful response when none are configured
(`controller/uptime_kuma.go:131-154`). It describes those monitors, not the
local drain state.

The `/api/perf-metrics` routes expose aggregated relay performance data
(`router/api-router.go:35-40`), not process-local financial work or queue depth.

When enabled, pprof is served separately on `0.0.0.0:8005`
(`main.go:168-173`). It is not a defined drain contract, is not sufficient to
identify active BillingSession/refund/batch state, and should not be exposed or
scraped as a substitute for purpose-built redacted observations.

### 2.4 Endpoint truth table

| Observation | What it proves | What it does not prove |
| --- | --- | --- |
| `/api/status` returns 200 | Gin can serve one public request and expose a start time | DB/Redis health, correct artifact, drain, scheduler ownership |
| `/api/status/test` returns 200 | Main DB ping passed at that instant | LOG_DB/Redis health or future availability |
| `active_connections = 0` | No handler currently counted by `StatsMiddleware` | Billing/refund/batch/export/scheduler zeroes; LB/SSE/WS/task-submit drain |
| no recent error log | no matching retained line was observed | no failed or abandoned work |
| process exited | memory no longer exists | memory was flushed, refunded, settled, or handed off |
| DB aggregates stable once | selected aggregates did not change once | maps are empty, errors did not occur, or offsetting writes did not happen |

## 3. Process-Local Financial And Deferred State

### 3.1 BillingSession is unregistered process memory

`BillingSession` owns private fields for funding source, pre-consumed quota,
token consumption, extra reserve, trust, funding settlement, full settlement,
refund state, and a mutex (`service/billing_session.go:23-35`). Each session is
stored on request-local `RelayInfo` (`service/billing.go:17-25`); there is no
global registry, gauge, admin endpoint, last-transition timestamp, or shutdown
enumeration.

Settlement is split. Funding settles first, then token quota is adjusted. If the
token adjustment fails, the session logs the error, marks itself settled, and
returns the token error; refund is then intentionally suppressed because the
funding side has already committed (`service/billing_session.go:38-78`). This is
a known partial-settlement state, not an atomic transaction.

Pre-consume also performs token and funding operations in separate steps. A
funding failure attempts token rollback, and a rollback failure is log-only
(`service/billing_session.go:184-229`). Reserve has the same multi-step shape and
uses log-only rollback errors (`service/billing_session.go:152-177`,
`service/billing_session.go:232-278`).

No DB query can prove that the number of live BillingSession objects is zero.
Wallet-backed sessions have no durable session row at all. Subscription
pre-consumption has a durable idempotency row, but that row is only a subset of
BillingSession state and cannot count live sessions.

### 3.2 Refund jobs are marked before asynchronous completion

`BillingSession.Refund` sets `refunded=true`, releases the mutex, and then starts
the actual funding/token refunds in `gopool.Go` (`service/billing_session.go:81-123`).
Funding, extra subscription reserve, and token errors are logged, but there is
no durable retry job, completion marker, queue depth, wait handle, or shutdown
join. A process can therefore report no active HTTP handlers while refund work
is still queued/running; a stop can abandon it after the in-memory session has
already suppressed another refund attempt.

Request failure paths call this asynchronous refund from `defer`
(`controller/relay.go:170-179`, `controller/relay.go:503-507`). Returning the HTTP
error does not mean the refund has durably completed.

### 3.3 Five batch maps

The batch updater defines exactly five map types:

| Rust contract name | Go map type | Durable fields affected |
| --- | --- | --- |
| `user` | `BatchUpdateTypeUserQuota` | `users.quota` |
| `token` | `BatchUpdateTypeTokenQuota` | `tokens.remain_quota`, `tokens.used_quota` |
| `usage` | `BatchUpdateTypeUsedQuota` | `users.used_quota` |
| `channel` | `BatchUpdateTypeChannelUsedQuota` | `channels.used_quota` |
| `request` | `BatchUpdateTypeRequestCount` | `users.request_count` |

The five types and their process maps/locks are defined at `model/utils.go:14-30`.
The periodic loop sleeps for the configured interval and invokes an unexported
flush with no cancellation (`model/utils.go:33-40`). The default interval is
five seconds (`common/init.go:101-105`).

During flush, every live map is replaced with a new empty map before DB writes
start (`model/utils.go:52-76`). Token/channel writes and the combined user write
only log failures; failed deltas are not requeued into the new maps
(`model/utils.go:78-112`). The user/token quota call sites return `nil`
immediately after adding an entry, while the void channel update simply returns
to its caller (`model/user.go:887-926`, `model/token.go:375-421`,
`model/channel.go:855-867`).

There is no public count per map, flush generation, last successful flush,
in-progress flag, dropped-delta counter, forced flush, or shutdown flush. DB
stability can corroborate persistence after observed flushes, but it cannot
directly prove the five process maps are empty.

### 3.4 Quota export cache

Quota export uses another process map, `CacheQuotaData`, protected by a mutex
(`model/usedata.go:34-65`). Its loop invokes `SaveQuotaDataCache` and then sleeps
for the configured interval; the default is five minutes
(`model/usedata.go:24-31`, `common/constants.go:68-70`).

The save function holds the map lock, performs one query plus create/update per
entry, then replaces the complete map and logs success unconditionally
(`model/usedata.go:67-90`). Create errors are not checked. Update errors are
logged by the helper, but the map is still cleared (`model/usedata.go:92-101`).
Consume logging feeds this map from another goroutine
(`model/log.go:293-343`).

There is no export depth, generation, last-success timestamp, error count,
forced export, or shutdown export. A success-shaped log message cannot by itself
prove every row persisted.

### 3.5 In-process schedulers

Before entering `server.Run`, main starts option sync, quota export, channel
maintenance, subscription reset, upstream-model maintenance, task pollers, and
the optional batch updater (`main.go:94-165`). These loops use `for` plus sleep or
ticker and do not accept a shutdown context.

Important ownership facts include:

- generic and Midjourney task polling start only when the process considers
  itself master (`main.go:142-161`), then poll every 15 seconds
  (`service/task_polling.go:90-137`, `controller/midjourney.go:23-34`);
- subscription reset uses `sync.Once` and an atomic running flag, but both are
  process-local; it starts only on a process classified as master
  (`service/subscription_reset_task.go:17-51`);
- upstream-model maintenance likewise uses process-local `Once` plus a master
  check (`controller/channel_upstream_update.go:652-680`); and
- `IsMasterNode` defaults to true unless `NODE_TYPE` is exactly `slave`
  (`common/init.go:81-85`).

The master flag is not a distributed lease. Starting a second default-configured
Go process can create another scheduler owner. Setting one process to slave does
not suppress every loop started unconditionally in main. There is no complete
scheduler inventory endpoint, owner-set digest, lease epoch, last-run status, or
shutdown wait. Thus scheduler ownership must come from an external, complete
live inventory; configuration intent is insufficient.

## 4. Task Terminal States And Settlement Cracks

### 4.1 State model

The general task states are `NOT_START`, `SUBMITTED`, `QUEUED`, `IN_PROGRESS`,
`FAILURE`, `SUCCESS`, and `UNKNOWN`; only `FAILURE` and `SUCCESS` are treated as
terminal by polling queries (`model/task.go:15-42`, `model/task.go:292-314`). Task
rows carry status, progress, submit/start/finish times, quota, and a private JSON
column (`model/task.go:44-66`). The private column may contain an upstream key and
must never be selected into an evidence artifact (`model/task.go:99-117`).

Midjourney has a separate `midjourneys` table and considers every row with
`progress != '100%'` unfinished, regardless of status
(`model/midjourney.go:3-26`, `model/midjourney.go:93-101`).

### 4.2 Submission crack

After an upstream task submission succeeds, the handler settles billing and
records consumption before inserting the durable task row. Insert failure is
only logged; there is no compensating refund or durable orphan record
(`controller/relay.go:572-597`). A crash or insert failure in this window can
leave a billed upstream task with no row for later polling or refund.

### 4.3 Terminal-before-finance crack

The generic poller computes a terminal transition, commits it with a status CAS,
and only afterward performs success settlement or failure refund
(`service/task_polling.go:422-499`). If the process stops after the CAS but before
the financial call, the row is terminal and is excluded from future unfinished
polling. Timeout handling has the same ordering: it commits `FAILURE/100%` first
and refunds afterward (`service/task_polling.go:38-87`).

Success adjustment is also non-atomic. It adjusts funding, then token quota,
changes `task.Quota` only in memory, updates usage/channel counters for positive
deltas, and finally writes a billing log (`service/task_billing.go:184-245`). The
generic poller has already saved the task before this function runs, and there is
no later task save, so the persisted task quota can remain the pre-consumed
amount even after a successful delta adjustment
(`service/task_polling.go:473-499`, `service/task_polling.go:538-560`).

Failure refund adjusts the funding source, then token quota, then writes a log;
these are not one transaction (`service/task_billing.go:150-182`). Token
adjustment failure is log-only (`service/task_billing.go:98-117`). There is no
durable task refund state or retry marker.

### 4.4 Additional task paths

The Suno path refunds before `task.Update`. If refund succeeds but the task save
fails, the old nonterminal row can be polled and refunded again
(`service/task_polling.go:223-248`). Missing task IDs and channel lookup failures
are bulk-marked `FAILURE/100%` without a refund path
(`service/task_polling.go:105-129`, `service/task_polling.go:165-188`).

The Midjourney loop also has bulk failure branches with no refund
(`controller/midjourney.go:23-78`). Its normal branch commits the status CAS and
then refunds, so a failed refund is not retried by unfinished polling
(`controller/midjourney.go:168-195`).

Subscription pre-consumption does have a request-ID idempotency table with
`consumed/refunded` states (`model/subscription.go:1024-1045`) and a transactional
refund-by-request-ID function (`model/subscription.go:1188-1211`). General task
private data stores billing source, subscription ID, and token ID, but not that
request ID (`model/task.go:99-117`). Task refund therefore adjusts a subscription
directly by subscription ID (`service/task_billing.go:82-95`) rather than closing
the idempotency record. The record is useful supporting evidence, but it is not a
complete task settlement ledger.

### 4.5 Operational consequence

For cutover, `SUCCESS/FAILURE` is not synonymous with financially complete.
Evidence must separately account for:

- nonterminal and contradictory task rows;
- upstream submissions with no task row;
- terminal failures with zero, one, or multiple refund records;
- successful tasks whose expected delta cannot be reconstructed from durable
  fields;
- subscription pre-consume rows that do not encode task refund completion; and
- token/user/channel counters still in process maps.

## 5. Read-Only DB Query Templates

These templates use named placeholders to show binding points. Collectors must
bind values through the database client, run under a read-only transaction or
read replica where supported, and record database identity plus snapshot time.
Do not interpolate values into SQL strings.

Do not select `tasks.private_data`, `subscription_orders.provider_payload`,
channel/token key material, raw log `other`, request/response data, or any secret
configuration. The contract evidence JSON accepts counts, timestamps, statuses,
and digests, not raw SQL or result rows.

The Go runtime supports PostgreSQL, MySQL, and SQLite, and LOG_DB may be either
the main DB or a separate database (`model/main.go:118-175`,
`model/main.go:213-243`). Run LOG_DB queries against the actual independently
identified log store.

### 5.1 General task pending inventory

This matches the general poller's unfinished predicate while retaining only
aggregate facts:

```sql
SELECT
  platform,
  status,
  COALESCE(progress, '') AS progress,
  COUNT(*) AS row_count,
  MIN(submit_time) AS oldest_submit_time,
  MAX(updated_at) AS newest_update_time
FROM tasks
WHERE COALESCE(progress, '') <> '100%'
  AND status NOT IN ('FAILURE', 'SUCCESS')
GROUP BY platform, status, COALESCE(progress, '')
ORDER BY platform, status, progress;
```

Use a bound cutoff to identify work that exceeded the agreed handoff window:

```sql
SELECT platform, status, COUNT(*) AS stale_count
FROM tasks
WHERE COALESCE(progress, '') <> '100%'
  AND status NOT IN ('FAILURE', 'SUCCESS')
  AND submit_time < :cutoff_unix
GROUP BY platform, status
ORDER BY platform, status;
```

### 5.2 Task state contradictions

```sql
SELECT status, COALESCE(progress, '') AS progress, COUNT(*) AS row_count
FROM tasks
WHERE (status IN ('FAILURE', 'SUCCESS') AND COALESCE(progress, '') <> '100%')
   OR (status NOT IN ('FAILURE', 'SUCCESS') AND progress = '100%')
   OR status = 'UNKNOWN'
GROUP BY status, COALESCE(progress, '')
ORDER BY status, progress;
```

This query is an anomaly inventory, not an automatic repair instruction.

### 5.3 Midjourney pending inventory

```sql
SELECT
  status,
  COALESCE(progress, '') AS progress,
  COUNT(*) AS row_count,
  MIN(submit_time) AS oldest_submit_time,
  MAX(finish_time) AS newest_finish_time
FROM midjourneys
WHERE COALESCE(progress, '') <> '100%'
GROUP BY status, COALESCE(progress, '')
ORDER BY status, progress;
```

### 5.4 Pending orders

Both top-up and subscription orders use `pending/success/failed/expired` status
values (`common/constants.go:260-263`, `model/topup.go:14-25`,
`model/subscription.go:204-219`). Count both families for the contract's `orders`
pending-work fact:

```sql
SELECT 'top_ups' AS order_family, COUNT(*) AS pending_count,
       MIN(create_time) AS oldest_create_time
FROM top_ups
WHERE status = 'pending'
UNION ALL
SELECT 'subscription_orders' AS order_family, COUNT(*) AS pending_count,
       MIN(create_time) AS oldest_create_time
FROM subscription_orders
WHERE status = 'pending';
```

### 5.5 Subscription pre-consume inventory

```sql
SELECT
  status,
  COUNT(*) AS row_count,
  COALESCE(SUM(pre_consumed), 0) AS quota_total,
  MIN(updated_at) AS oldest_update_time,
  MAX(updated_at) AS newest_update_time
FROM subscription_pre_consume_records
GROUP BY status
ORDER BY status;
```

A `consumed` row is not automatically a leak, and a `refunded` row does not
prove wallet/token/channel completion. Use this only as one reconciliation
domain.

### 5.6 Task billing-log aggregate

`LogTypeConsume` is 2 and `LogTypeRefund` is 6 (`model/log.go:58-68`). Task
billing logs place `task_id` inside JSON `other` and write through LOG_DB
(`model/log.go:346-386`). Extract only that one field; never emit the raw JSON.

PostgreSQL:

```sql
SELECT
  other::jsonb ->> 'task_id' AS task_id,
  type,
  COUNT(*) AS event_count,
  COALESCE(SUM(quota), 0) AS quota_total,
  MIN(created_at) AS first_event_time,
  MAX(created_at) AS last_event_time
FROM logs
WHERE type IN (2, 6)
  AND created_at >= :window_start_unix
  AND other IS NOT NULL
  AND other <> ''
  AND other::jsonb ? 'task_id'
GROUP BY other::jsonb ->> 'task_id', type;
```

MySQL:

```sql
SELECT
  JSON_UNQUOTE(JSON_EXTRACT(other, '$.task_id')) AS task_id,
  type,
  COUNT(*) AS event_count,
  COALESCE(SUM(quota), 0) AS quota_total,
  MIN(created_at) AS first_event_time,
  MAX(created_at) AS last_event_time
FROM logs
WHERE type IN (2, 6)
  AND created_at >= :window_start_unix
  AND JSON_VALID(other)
  AND JSON_EXTRACT(other, '$.task_id') IS NOT NULL
GROUP BY JSON_UNQUOTE(JSON_EXTRACT(other, '$.task_id')), type;
```

SQLite with JSON1:

```sql
SELECT
  json_extract(other, '$.task_id') AS task_id,
  type,
  COUNT(*) AS event_count,
  COALESCE(SUM(quota), 0) AS quota_total,
  MIN(created_at) AS first_event_time,
  MAX(created_at) AS last_event_time
FROM logs
WHERE type IN (2, 6)
  AND created_at >= :window_start_unix
  AND json_valid(other)
  AND json_extract(other, '$.task_id') IS NOT NULL
GROUP BY json_extract(other, '$.task_id'), type;
```

Keep task identifiers inside the protected reconciliation collector. Emit only
counts and canonical set/chunk digests into evidence. If LOG_DB is separate,
join its normalized digest set to the main task digest set in the collector, not
with an unsafe cross-database ad hoc join.

The expected review sets are:

- failed, non-legacy tasks with nonzero quota and no refund event;
- failed tasks with multiple refund events;
- refund totals that differ from the durable task quota; and
- success adjustment events whose durable task quota did not change.

These are investigation sets. Because unchanged-price successful tasks correctly
have no adjustment event, absence of a success event is not by itself a defect.

### 5.7 Main DB stability aggregates

Take at least two snapshots after the final observed batch/export cycle. These
portable aggregates are useful tripwires:

```sql
SELECT COUNT(*) AS rows, COALESCE(MAX(id), 0) AS high_id,
       COALESCE(SUM(quota), 0) AS quota_total,
       COALESCE(SUM(used_quota), 0) AS used_total,
       COALESCE(SUM(request_count), 0) AS request_total
FROM users;

SELECT COUNT(*) AS rows, COALESCE(MAX(id), 0) AS high_id,
       COALESCE(SUM(remain_quota), 0) AS remain_total,
       COALESCE(SUM(used_quota), 0) AS used_total
FROM tokens;

SELECT COUNT(*) AS rows, COALESCE(MAX(id), 0) AS high_id,
       COALESCE(SUM(used_quota), 0) AS used_total
FROM channels;

SELECT COUNT(*) AS rows, COALESCE(MAX(id), 0) AS high_id,
       COALESCE(MAX(updated_at), 0) AS high_update_time,
       COALESCE(SUM(quota), 0) AS quota_total
FROM tasks;

SELECT COUNT(*) AS rows, COALESCE(MAX(id), 0) AS high_id,
       COALESCE(MAX(created_at), 0) AS newest_bucket,
       COALESCE(SUM(count), 0) AS request_total,
       COALESCE(SUM(quota), 0) AS quota_total,
       COALESCE(SUM(token_used), 0) AS token_total
FROM quota_data;
```

### 5.8 LOG_DB stability aggregate

```sql
SELECT
  COUNT(*) AS rows,
  COALESCE(MAX(id), 0) AS high_id,
  COALESCE(MAX(created_at), 0) AS high_created_at,
  COALESCE(SUM(CASE WHEN type = 2 THEN quota ELSE 0 END), 0) AS consume_total,
  COALESCE(SUM(CASE WHEN type = 6 THEN quota ELSE 0 END), 0) AS refund_total
FROM logs;
```

Aggregate equality can miss offsetting mutations. The production collector must
also generate the contract's canonical normalized snapshot and chunk-set
digests over allowlisted, non-secret columns. The evidence verifier requires two
stable SQL snapshots and two stable LOG_DB snapshots, not just these sums
(`tools/go_vps_cutover_evidence_contract.mjs:1111-1145`).

## 6. Required Drain Sequence

1. Freeze one exact candidate and full-production cohort. Record the pinned Go
   HEAD, Go artifact/deployment digest, Cloudflare deployment digest, SQL,
   LOG_DB, Redis, and LB identities, plus complete process and scheduler lists.
2. Capture pre-drain task/order, reconciliation, and rollback snapshots. Do not
   stop or restart Go to make counters disappear.
3. Fence old Go from new ingress at every proxy/LB layer and protocol. Capture
   `drainStartedAt`, config generation/reload status, and the last accepted
   operation derived from redacted proxy telemetry.
4. Observe at least 60 seconds with zero accepted-after-drain, active, and
   in-flight HTTP/SSE/WebSocket/task-submit work and zero LB/host connections.
   `/api/status/test` is only a supporting lower-bound sample.
5. While the old process is still identifiable, observe at least two complete
   configured batch intervals after the last acceptance and one complete quota
   export interval. Require zero batch/export/refund/settlement/token/log-write
   errors and then take two stable SQL and LOG_DB snapshots.
6. Capture direct per-process BillingSession, refund-job, and five-map counts
   after persistence stability. At this Go HEAD, no built-in surface can do so;
   without an independently validated direct collector, stop here with
   `unknown/not-proven`.
7. Prove exactly one live owner for every scheduler after drain start. Never
   infer ownership from the default master flag or process count alone.
8. Query pending tasks and orders after ingress observation. Either prove both
   empty or create a durable handoff whose source count, target readback count,
   and canonical digest match with zero unaccounted work.
9. Prove both synchronization directions and all reconciliation domains after
   persistence stability. Forward-only replication does not preserve a safe Go
   rollback.
10. Rehearse rollback from the frozen bundle on isolated restored data, including
    schema/startup behavior, scheduler fencing, session continuity, and every
    accepted post-cutover write. Only then assemble the immutable evidence
    packet for independent review.

The contract enforces the important ordering relationships: flush/export after
last acceptance, snapshots after the cycles, process state after persistence
stability, scheduler ownership after drain starts, and pending work after
ingress observation (`tools/go_vps_cutover_evidence_contract.mjs:1677-1735`).

## 7. Rollback And AutoMigrate Risk

DB initialization runs before the HTTP server starts (`main.go:291-318`). A
process classified as master automatically runs migration before it can become
ready (`model/main.go:177-206`). The default classification is master unless
explicitly set to slave (`common/init.go:81-85`).

The migration path performs custom type work and then `AutoMigrate` across
channels, tokens, users, logs, Midjourney, quota data, tasks, subscription
orders/subscriptions/pre-consume records, and other business tables
(`model/main.go:250-297`). A separate LOG_DB is also auto-migrated on master
startup (`model/main.go:213-243`, `model/main.go:370-375`).

This creates four rollback hazards:

1. Merely starting the old Go rollback binary against production can mutate
   schema before its readiness can be tested.
2. Starting it with incomplete role configuration can also create scheduler
   ownership before traffic moves.
3. A schema accepted by Rust/Cloudflare may not be behaviorally compatible with
   the pinned Go models or startup migrations.
4. If Cloudflare has accepted writes, a Go rollback without zero-lag reverse
   sync can serve stale quota, task, order, subscription, provider, or audit
   state even when the process is technically healthy.

The rollback bundle must therefore contain the exact Go artifact, redacted
configuration, SQL/LOG_DB/Redis snapshots, route plan, scheduler-owner plan,
reverse-sync checkpoint, runbook, and evidence index required by the contract
(`tools/go_vps_cutover_evidence_contract.mjs:1564-1674`). Rehearse startup only
against isolated restores. Compare schema and allowlisted data digests before
and after startup, prove no unexpected migration, and measure RTO/RPO. Do not
use a production startup as the rehearsal.

A permanently running "hot" Go rollback target is not automatically safer. The
pinned binary starts several loops before serving and does not have a complete
standby/no-write mode. A safe rollback target needs explicit route and scheduler
fencing plus proven reverse synchronization, not only a responding process.

## 8. How To Use The Rust Evidence Contract

The implementation pins the same Go HEAD and requires eight evidence kinds:
candidate topology, ingress drain, process-state drain, persistence stability,
scheduler ownership, bidirectional sync, pending work, and rollback bundle
(`tools/go_vps_cutover_evidence_contract.mjs:6-29`). It also fixes the four
protocols and five batch-map names used in this audit
(`tools/go_vps_cutover_evidence_contract.mjs:31-44`).

Use this audit as the collector design and truthfulness policy:

| Evidence kind | Use of this audit | Current Go-only result |
| --- | --- | --- |
| `candidate-topology` | Pin source, hash every live artifact/deployment, identify DB/LOG_DB/Redis/LB and complete process/scheduler cohort | live collection required |
| `ingress-drain` | Combine proxy last-accept/count facts with LB and PID-attributed host connections; endpoint counter is corroboration | live collection required |
| `process-state-drain` | Directly observe BillingSessions, refund jobs, and mapped five batch maps per process | `unknown` without new direct observation |
| `persistence-stability` | Use configured intervals, verified cycles, zero error counts, and two digest snapshots for SQL and LOG_DB | partial; logs/DB alone cannot prove maps empty |
| `scheduler-ownership` | Expand source inventory and prove one live owner set per scheduler | `unknown` without external owner observation |
| `bidirectional-sync` | Reconcile all required domains in both directions after stability | outside Go endpoint capability |
| `pending-work` | Use aggregate task/order queries; prove empty or exact durable handoff/readback | DB evidence plus target readback required |
| `rollback-bundle` | Rehearse isolated restore/startup, AutoMigrate behavior, routing, scheduler fencing, and reverse sync | rehearsal required |

Never manufacture a passing zero from absence of logs, a stable aggregate, a
stopped process, or `/api/status/test`. The contract permits `unknown`, and only
`pass` satisfies a required fact (`tools/go_vps_cutover_evidence_contract.mjs:197-239`).
An unobservable fact must carry `unknown` status and yield `not-proven`; any
required numeric field must remain explicitly non-authoritative under that
status and must never be presented as a directly observed zero. A guessed
`pass` is invalid evidence.

The verifier is intentionally offline. It rejects fields associated with secret
values, raw bodies/headers/cookies, SQL text, and log lines
(`tools/go_vps_cutover_evidence_contract.mjs:99-129`). Operational collectors
must reduce source material to exact-schema redacted facts before invoking it.

Inspect the contract:

```powershell
bun run plan:go-vps-cutover:evidence
```

Verify a pre-generated immutable bundle:

```powershell
bun run verify:go-vps-cutover:evidence -- --manifest <manifest.json> --json
```

Run the local contract suite:

```powershell
bun run check:go-vps-cutover:evidence
```

The verifier can return only `not-proven` or
`eligible-for-production-cutover-review`; even the latter always has
`productionCutoverAuthorized: false`
(`tools/go_vps_cutover_evidence_contract.mjs:197-239`). Independent release
review remains mandatory.

## 9. Go/No-Go Checklist

Production review is blocked if any item below is not directly proven:

- exact Go artifact/deployment and complete process inventory;
- exact live reverse-proxy/LB route generation;
- no acceptance after drain and zero HTTP/SSE/WebSocket/task-submit activity;
- zero LB and host connections to every Go process;
- two verified batch intervals and one verified export interval after final
  acceptance;
- zero batch/export/refund/settlement/token/log-write errors;
- two stable digest snapshots for both SQL and LOG_DB;
- direct zero BillingSession and refund-job counts for every process;
- direct zero counts for user/token/channel/usage/request batch maps;
- exactly one owner for every scheduler;
- task and order work either empty or durably handed off with exact readback;
- zero-lag, zero-conflict bidirectional sync across every required domain; and
- an isolated, measured rollback rehearsal that includes AutoMigrate behavior
  and all accepted writes.

For the unmodified pinned Go binary, the direct process-state observations are
not available. Until that gap is resolved with trustworthy evidence, the honest
cutover result is `not-proven`.
