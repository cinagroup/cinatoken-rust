# Accepted Work Drain and Traffic Return Safety v1

Status: production design with a local read-only foundation only.

Production decision: **NO-GO**. Go/VPS remains the traffic, scheduler,
business, and financial authority.

This document defines the production safety contract for draining work
accepted by the Cloudflare/Rust path and later reviewing a return of authority
to Go/VPS. It is a named protocol, not a shard-placement operation. It MUST
NOT be assigned operation ordinal 15, inserted into the operation 1-14 receipt
ledger, or used to extend operation 14.

The current implementation batch provides:

- a persisted per-shard Durable Object drain snapshot;
- a separate `execution_stop_eligible` predicate;
- a default-off, authenticated Controller read attestation over the fixed
  eight-shard set; and
- a request-independent state digest whose response always says
  `traffic_return_authorized=false`;
- an expand-only 0067 D1 ledger for campaigns, frozen membership, closures,
  shard/global observations, quarantines, reverse sync, and eligibility-only
  receipts; and
- a one-way 0068 D1 admission fence and accepted-sequence authority;
- a default-inert 0069 typed evidence subject/item/seal registry that replaces
  marker-only receipt eligibility with exact campaign/evidence checks; and
- exact read-only Worker schema readiness and campaign lookup boundaries.

It does not provide authenticated 0067/0068/0069 writers, the one-SQL-step
fence-close command, remote production evidence, or traffic authorization.
All five write gates remain false.

## 1. Mandatory order

The only valid production order is:

```text
admission fence
-> accepted set freeze
-> terminal ACK + billing + reconciliation + reverse sync + drain
-> ambiguity quarantine
-> operation 14
-> independent traffic-return review
```

The sequence is intentionally asymmetric:

1. Stop creating new Rust obligations before enumerating existing ones.
2. Freeze exactly which accepted operations must be closed.
3. Finish or explicitly classify every member while terminal ACK and financial
   writers are still enabled.
4. Persist any irreducible provider ambiguity as a non-replayable quarantine.
5. Run operation 14 only after the work and ACK boundary has converged.
6. Let an independent review decide whether Go/VPS traffic may return.

Operation 14 success cannot move, skip, or imply any earlier step. A
Controller process becoming healthy, idle, stopped, evicted, or replaced
cannot move any step either.

## 2. Reviewed source baseline

This design was derived from two read-only source reviews:

- cinaVibeSDK commit
  `918e97480ee44e357abe99bf33c27259d6ac7ebd`;
- cinatoken Go commit
  `73652508abc5cb09214dde02d51d69d1d1ccc703`.

No credential, token value, Cloudflare account state, route, deployment, or
customer traffic was read or changed for this design.

### 2.1 cinaVibeSDK design evidence

| Source path | Responsibility and production lesson |
|---|---|
| `worker/agents/index.ts:21-36` | `getAgentByName` maps a stable agent name to one Agent Durable Object. Stable names define state ownership. |
| `worker/agents/think/ThinkAgent.ts:207-211` | The Agent name is reused with `idFromName` so one session always resolves to the same SpaceDO. |
| `space/src/space/durable-object.ts:61-78` | Each named SpaceDO owns an isolated filesystem and Git repository backed by DO SQLite. Persistent state belongs to the DO, not a Container process. |
| `worker/services/sandbox/sandboxSdkClient.ts:86-107` | `MANY_TO_ONE` hashes a session and takes a modulus over a Container pool. This is capacity placement, not a durable business ownership or financial partition. |
| `worker/agents/services/implementations/DeploymentManager.ts:519-606` | An unhealthy instance is replaced and rebuilt from persisted file state. Container identity is disposable. |
| `worker/services/sandbox/sandboxSdkClient.ts:1128-1150` | Health means metadata exists and a process reports `running`; it does not prove accepted work, settlement, or audit completion. |
| `worker/services/sandbox/sandboxSdkClient.ts:1182-1224` | Shutdown attempts process kill, port cleanup, and file deletion, but some failures are warning-only. Shutdown success is not a business drain receipt. |
| `container/process-monitor.ts:990-1040` | Stop sends a graceful signal and later escalates to force kill. Process exit is a lifecycle fact, not an accepted-work terminal. |
| `docs/llm.md:607-625` | SQLite state survives while promises, abort controllers, timers, and other isolate memory disappear on eviction. |
| `worker/agents/core/behaviors/base.ts:402-455` | Pending input is cleared before generation finishes, so a zero queue does not prove zero in-flight work. |
| `worker/agents/core/behaviors/base.ts:282-284` | `generationPromise` is an in-memory indicator and cannot be an authority across eviction or restart. |

The inherited principle is:

> A deterministic DO identity and durable state can coordinate recovery.
> Container, isolate, process, socket, queue-length, and health state are
> replaceable execution observations.

cinatoken-rust keeps the useful part of the source design while strengthening
it for paid provider effects: Jump Consistent Hash plus a versioned ring
selects a shard, each named shard DO owns a fenced local ledger, the Container
executes frozen work, and D1/R2 own global durable truth and evidence. A
mutable pool modulus is not permitted to redefine paid operation ownership.

### 2.2 cinatoken Go evidence

| Source path | Responsibility and migration consequence |
|---|---|
| `main.go:87-240` | Background loops start without one cancel/wait owner and HTTP uses `server.Run`; there is no process-wide graceful shutdown barrier. A stopped VPS process cannot be treated as drained. |
| `relay/helper/stream_scanner.go:97-121,221` | SSE cleanup is request-local, waits at most five seconds, and uses a background context rather than a process shutdown context. |
| `service/task_polling.go:90-99` | The task poller is an unbounded `Sleep` loop using `context.TODO()`, without a lease epoch or shutdown join. |
| `model/task.go:404-448` | `UpdateWithStatus` provides a useful terminal CAS, while bulk update paths explicitly lack that protection. |
| `service/task_polling.go:473-498` | A task can win terminal CAS before settlement or refund executes. A crash between them leaves task and billing truth split. |
| `relay/relay_task.go:174-223` | A public task ID and pre-consume happen before the provider call, but a network error is surfaced as a server error without a durable provider send journal. |
| `controller/relay.go:572-596,632-646` | The controller may retry 5xx outcomes; on success it settles before inserting the task, and task insertion failure is only logged. Provider acceptance can therefore lack a pollable local task. |
| `service/billing_session.go:25-116` | Settlement/refund guards are process memory; refund marks memory first and performs mutation asynchronously. They are not a durable cross-process workflow. |
| `model/user.go:897-923` and `model/utils.go:24-44` | Batch quota deltas can live in memory until a periodic loop flushes them. There is no shutdown flush barrier. |
| `pkg/billingexpr/expr.md` | One expression is the billing truth; pre-consume freezes a snapshot and settlement re-evaluates actual normalized usage. Migration evidence must retain that expression and normalization identity. |

These are not criticisms to be hidden by a new runtime. They define the
evidence required before authority can return to Go/VPS. In particular, a
Go/VPS process being reachable does not prove that imported Rust work,
provider ambiguity, quota deltas, task rows, or billing terminals have
converged.

## 3. Terms

### 3.1 Accepted work

An operation is accepted only when the D1 admission transaction has committed
both:

- the unique admission receipt for the stable operation identity; and
- the operation row bound to the active admission fence generation.

HTTP receipt, an R2 object, a Queue message, a DO claim, a Container call, or a
provider request is not the acceptance point. If the D1 transaction did not
commit, the operation is not a member of the accepted set.

The stable identity MUST bind at least tenant, token subject, request identity,
model/provider intent, ring generation, shard index, owner generation, request
input digest, billing reservation generation, and provider operation identity
where one exists.

### 3.2 Admission fence

The admission fence is a D1-enforced generation and scope boundary that makes
new Rust admission impossible. It is not a Worker environment flag alone.
Every admission transaction must compare the active fence generation and fail
closed after closure.

### 3.3 Accepted set

The accepted set is the immutable, complete membership list of committed
admission receipts at or before the frozen cutoff. Counts without membership
keys are not a set. A single aggregate query is not a set.

### 3.4 Execution stop eligibility

`execution_stop_eligible` is a per-shard lifecycle predicate. It means the
current DO ledger has no work that can safely continue in the attached
Container:

- zero claimed or running operations;
- zero unclassified operation states;
- zero prepared or dispatched provider attempts;
- zero active or waiting provider retries; and
- zero pending alarm intents.

It may be true while provider ambiguity, `recovery_required`, missing terminal
ACK, billing reconciliation, reverse sync, or global evidence remains open.
It permits a Container stop decision. It does not prove accepted-work drain.

### 3.5 Shard accepted-work snapshot

The current shard snapshot also reports `accepted_work_drained`. That local
predicate adds:

- zero `recovery_required` operations;
- zero ambiguous provider attempts; and
- zero completed or failed operations missing final ACK.

This is stronger than stop eligibility but still is not the global production
claim. Without a D1 admission cutoff and frozen accepted membership, a shard
cannot prove that every accepted operation was observed. It also cannot prove
D1 outbox, billing, reconciliation, R2, Queue, reverse-sync, or old-Worker
closure.

### 3.6 Global accepted-work drained

The global campaign may claim `accepted_set_drained` only when every frozen
member has one valid closure and all scope-bound cross-layer invariants pass.
No Controller response field can create this state directly.

### 3.7 Traffic-return eligibility

`eligible_for_traffic_return_review` means an evidence packet is complete
enough for independent human and automated review. It is not permission to
route traffic. No protocol response, attestation, receipt, or operation in
this design may emit `traffic_return_authorized=true`.

## 4. Authority boundaries

| Layer | Owns | Must not own |
|---|---|---|
| Edge Worker | authentication, rate limits, route selection, admission request construction, and fail-closed handling | inferring terminal state from Container health; bypassing the D1 fence |
| Shard Durable Object | stable shard identity, owner generation, local operation/attempt journal, lifecycle, leases, alarms, final ACK, and shard snapshot | global accepted membership, balance, settlement, refund, provider reselection, reverse sync, or traffic return |
| Linux Container | bounded execution of already accepted frozen work and return of result evidence | admission, routing, replay authority, financial state, terminal ownership, quarantine, or cutover approval |
| Global KV/D1/R2 | D1 relational, admission, financial, reconciliation, campaign, and receipt truth; R2 immutable large artifacts/evidence; KV versioned cache/config only | treating KV or Container disk as business/financial terminal truth |

Additional control-plane boundaries:

- operation-14 Authority proves only the frozen Controller baseline disable;
- Go/VPS remains the rollback authority until the independent review passes;
- a traffic-return reviewer consumes evidence but cannot rewrite evidence;
- a reconciliation owner may resolve financial discrepancies but cannot
  re-dispatch a provider operation.

## 5. Protocol phases

### 5.1 Phase A: activate the admission fence

The future global campaign begins with an expand-only D1 schema and all write
gates disabled. After reader compatibility and old-writer inventory are
proved:

1. Create one campaign with a unique campaign ID, scope digest, expected ring
   generation, shard inventory digest, expected Edge version set, and fence
   generation.
2. In one D1 transaction, close admission for that scope and record
   `closed_at`, D1 time, the last accepted sequence, and the campaign event.
3. Make every new admission transaction require the exact active generation
   and `admission_open=1`.
4. Reject stale Workers in D1, even if their local configuration still says
   enabled.
5. Retain the fence throughout drain, operation 14, and traffic-return review.

The enforcement migration must be installed only after all pre-enforcement
writers are inventoried and drained. A local feature gate is defense in depth,
not the authority.

R2 objects written before failed admission are orphans, not accepted work.
They must be inventoried and retained or garbage-collected under a separate
policy; their existence must not add an operation to the accepted set.

### 5.2 Phase B: freeze the accepted set

After the fence transaction commits:

1. Freeze `accepted_high_watermark`, D1 bookmark, schema version, campaign
   generation, ring generation, shard count, shard inventory digest, Edge
   version set, configuration digest, and cutoff time.
2. Copy every in-scope admission receipt through the high watermark into an
   append-only campaign membership table.
3. Page by stable `(accepted_sequence, operation_id)` keys. Do not use
   `OFFSET`.
4. Canonicalize each member and build page digests plus one complete manifest
   digest.
5. Compare source count, copied count, first/last key, partition counts, and
   digest. Any gap, duplicate, reordered key, or concurrent late receipt moves
   the campaign to `recovery_required`.
6. Seal membership before any global drain result can be written.

The membership row binds operation, shard, owner generation, provider attempt
identity, reservation identity, expected terminal/ACK identity, and required
R2 artifact class. A count-only snapshot is insufficient.

### 5.3 Phase C: terminal ACK, billing, reconciliation, reverse sync, and drain

New admissions remain fenced while existing accepted members are allowed to
finish under their original identities and generations.

For every member, the campaign must join:

- admission receipt and operation generation;
- DO claim/running/attempt history;
- provider send-before journal, response, or ambiguity classification;
- operation terminal event;
- final DO ACK;
- reservation plus exactly one settlement or refund terminal;
- billing audit and request/accounting deltas;
- outbox delivery or scoped dead-letter resolution;
- reconciliation state;
- required R2 artifact/evidence digest; and
- reverse-sync disposition for Go/VPS.

Normal member closure is one of:

- `settled_terminal`: successful business terminal and durable settlement;
- `failed_terminal`: definite failure and durable refund/zero-charge terminal;
- `quarantined`: provider outcome cannot be proved and has entered the
  immutable non-replay quarantine phase.

`recovery_required` is not a successful terminal classification. A terminal
task without billing, billing without a terminal task, a final event without
ACK, or an R2 artifact without an admission receipt remains open.

Scope-bound open work must independently reach zero:

- D1 prepared/dispatched operations and provider attempts;
- DO claimed/running operations and unexpired or expired leases;
- missing final ACK and pending compaction authorization;
- Queue, DLQ, parking, Cron, Workflow, and alarm recovery work;
- SSE, WebSocket, HTTP forwarding, and terminal-finalization ownership;
- billing reservations without terminal settlement/refund;
- reconciliation and outbox rows without accepted disposition;
- process-local refund and settlement work;
- Go/VPS import/shadow mismatches; and
- memory batch deltas that have not been flushed and reconciled.

The billing join must retain the frozen billing contract needed to reproduce
the result: expression text or immutable reference, expression hash and
version, group ratio, request-input digest, usage semantic, normalized token
vector, matched tier, conversion version, and fallback/error disposition.
This follows `pkg/billingexpr/expr.md`: one expression is one truth, and
settlement reuses the frozen pre-consume snapshot with actual normalized
usage.

Reverse synchronization is scope-bound and append-only. Its manifest records
snapshot ID, schema version, D1 bookmark/high watermark, source and target
counts, rejected rows, partition digests, Go import identity, and shadow
comparison result. Go writes remain disabled until shadow comparison passes.
Rust remains fenced afterward so reverse sync cannot create dual writers.

### 5.4 Phase D: quarantine provider ambiguity

An ambiguous provider send cannot be retried through Rust or Go. It may leave
execution stop-eligible because no safe execution remains, but it blocks the
normal drained claim until an immutable quarantine is applied.

Each quarantine record must bind:

- campaign/member/operation/reservation/provider identities;
- exact send-before journal and request digest;
- last provider observation and evidence digests;
- `provider_resend_allowed=0`;
- `rust_replay_allowed=0`;
- `go_replay_allowed=0`;
- fixed reconciliation owner and review deadline;
- customer and financial exposure;
- billing hold or reviewed accounting disposition;
- Go tombstone/import disposition;
- append-only evidence and approval digests; and
- retention/WORM location.

Quarantine prevents duplicate effects; it does not make financial
reconciliation disappear. A quarantined member can contribute to execution
closure only. Traffic-return review still requires an approved financial
disposition and conservation proof.

Bulk conversion of `recovery_required` to quarantine is prohibited. Every
member is reviewed and inserted with its own immutable evidence.

### 5.5 Phase E: operation 14

Operation 14 starts only after:

- the accepted set is sealed;
- all normal members have terminal ACK and financial closure;
- all irreducible ambiguity has an immutable non-replay quarantine;
- reverse sync and shadow comparison have the required disposition;
- pre-disable stable drain observations pass; and
- terminal ACK and reconciliation writers have no remaining work.

This ordering matters because operation 14 proves all Controller action gates
false, including the terminal ACK gate. Running it earlier can close the path
needed to finish accepted operations.

Operation 14 then proves only:

- the frozen operation-5 Controller baseline is deployed at 100 percent;
- one mutation authority was used at most once;
- ambiguous mutation recovery is status-only;
- two stable Gateway observations match the exact baseline; and
- the independent Controller disable attestation reports all action gates
  false.

It still does not prove drain, billing, reverse sync, provider reconciliation,
R2 completeness, Go/VPS readiness, DNS, or traffic safety.

### 5.6 Phase F: independent traffic-return review

After operation 14 terminalizes, a separate reviewer assembles a
traffic-return packet. The packet references rather than rewrites:

- the sealed admission fence and accepted-set manifest;
- the complete member closure manifest;
- both stable global observations;
- the shard snapshot/attestation digest set;
- the ambiguity quarantine manifest;
- billing conservation and provider reconciliation;
- reverse-sync and Go shadow comparison;
- the operation-14 terminal receipt and exact baseline digest;
- Rust writer fencing after reverse sync;
- Go/VPS process, scheduler, stream, poller, and batch-flush evidence;
- measured Go/VPS RTO/RPO;
- traffic, DNS, cache, and rollback rehearsal;
- SLO, cost, security, privacy, finance, SRE, and release approvals; and
- immutable evidence location and retention policy.

The only positive protocol result is:

```text
eligible_for_traffic_return_review
```

The reviewer must make a separate go/no-go decision. No Worker route may turn
that result directly into traffic configuration.

## 6. Stop eligibility is not drain

| Observation | May stop Container | Proves shard snapshot drained | Proves global accepted set drained | Authorizes traffic return |
|---|---:|---:|---:|---:|
| process `running` or healthy | no | no | no | no |
| process exited or shutdown returned success | already stopped | no | no | no |
| DO isolate evicted or hibernated | no conclusion | no | no | no |
| pending input/Queue length is zero | no conclusion | no | no | no |
| `execution_stop_eligible=true` | yes, for lifecycle policy | no | no | no |
| shard `accepted_work_drained=true` | yes | local snapshot only | no | no |
| all eight Controller snapshots report drained | yes | local aggregate only | no | no |
| sealed global campaign passes | yes | yes | yes for frozen scope | no |
| operation 14 succeeds | Controller disabled | no | no | no |
| independent packet accepted | n/a | referenced | referenced | separate operator decision only |

The Container may be stopped when execution is no longer safe or useful even
while ambiguity is quarantined. That stop must never be recorded as evidence
that the accepted set financially reconciled.

## 7. Persistent model

Application migration `0067_relay_container_drain_expand.sql` now implements
the expand-only global ledger locally. It does not implement admission
enforcement, expose a write route, or make any tracked write gate safe to
enable.

### 7.1 D1 expand migration

`0067_relay_container_drain_expand.sql` adds:

- `relay_container_drain_campaigns`: scope, fence generation, cutoff,
  accepted high watermark/bookmark, campaign-declared frozen member
  count/manifest and first/last key, immutable 0067 ledger-schema identity,
  Controller/ring/shard inventory, reverse-export identity, state, and
  campaign digest;
- `relay_container_drain_events`: append-only state/evidence hash chain;
- `relay_container_drain_members`: immutable accepted operation membership and
  required closure identities;
- `relay_container_drain_observations`: generation-bound global D1, billing,
  outbox, reconciliation, R2, Queue, and reverse-sync observations;
- `relay_container_drain_shard_observations`: exact shard snapshot and
  Controller state digests bound to an immutable 0061 placement attestation;
- `relay_container_ambiguity_quarantines`: per-operation non-replay and
  financial-exposure sidecars;
- `relay_container_reverse_sync_manifests`: source/target high watermarks,
  counts, rejects, partition digests, and shadow result; and
- `relay_container_traffic_return_receipts`: append-only review packet
  reference that can report eligibility but never authorization.

Every table is scope-bound. Historical global dead letters or unrelated
tenants must not contaminate campaign counts.

Implemented database constraints include:

- unique active campaign per scope; `recovery_required` and `aborted` release
  the active slot only for the next exact fence generation;
- campaign creation rejected unless the future 0068 migration marker already
  exists, even if an application write gate is accidentally enabled;
- immutable campaign scope/fence/cutoff and event-owned state transitions;
- unique accepted member per campaign and operation generation;
- strictly increasing accepted keys, contiguous member/page ordinals, and
  keyset-complete page seals, with explicit NULL rejection;
- membership cannot seal until copied count, declared manifest, and global
  first/last keys exactly equal the campaign freeze values that 0068 must
  derive atomically from the authoritative admission source;
- append-only events, observations, quarantines, and receipts;
- no successful drain state before complete membership seal;
- one immutable closure observation for every accepted member, bound to the
  member's frozen terminal and final-ACK identities, with quarantine required
  before a `quarantined` closure;
- no drain seal without the latest two consecutive stable global observation
  generations, equal state and billing-conservation digests, exact shard
  inventory, zero open/unclassified work, complete member closures, and a
  passing reverse-sync manifest;
- shard watermarks must equal the frozen member high watermark for that shard;
  placement, ring, owner generation, snapshot digest, Controller state, drain
  predicates, and open counts must remain semantically equal across the
  observation pair;
- reverse-sync snapshot/schema/bookmark/count/high-watermark values must equal
  the campaign freeze, generations must be contiguous, and only the latest
  generation is eligible for drain;
- a `billing_hold` quarantine contributes at least one billing-open item, so a
  zero-open global observation cannot conceal it;
- no operation-14 reference before a successful drain seal;
- no eligibility receipt before matching drain, member-closure, quarantine,
  billing-conservation, reverse-sync, and operation-14 evidence; and
- no eligibility receipt at all until the future 0069 typed-evidence
  enforcement migration is installed; and
- `eligible_for_traffic_return_review=1` together with the database-enforced
  `traffic_return_authorized=0`.

The Rust D1 repository exposes an exact 0067 schema/object readiness probe and
a validated read-only campaign lookup. It contains no 0067 mutation method.
The platform capability response reports schema readiness, each tracked gate,
`container_drain_write_gates_all_false`, and
`container_traffic_return_authorization_compiled=false`.

0067 does not recompute the membership manifest from member rows and cannot
prove that intermediate members equal the authoritative admission source.
That proof belongs to the 0068 admission/freeze transaction and its
independent source readback: canonicalize every source and copied member,
recompute page and complete-set manifests, compare counts/partitions and every
key, then retain the result. Until that writer/readback exists, the 0067 seal
is a structural and declared-digest boundary, not production completeness.

Likewise, member billing fields retain only the identity needed to resolve the
existing billing truth. A production writer must join the immutable
pre-consume snapshot and canonical billing contract, then replay normalized
usage, matched tier, group ratio, expression version, and quota conversion
without copying or redefining the billing formula in this ledger.

### 7.2 D1 enforcement migration

`0068_relay_container_drain_admission_enforce.sql` now provides the local
admission transaction guard and terminal invariants. It may be applied
remotely only after:

1. 0067 is remotely applied and read back with gates false;
2. compatible readers and writers are deployed;
3. every pre-0068 writer is inventoried;
4. old writer traffic and in-flight transactions are drained;
5. backup/Time Travel/rollback evidence is retained; and
6. a staging concurrency campaign proves stale generations cannot admit.

0068 is not a down-migration tool. Rollback keeps evidence and fences in place
and repairs forward.

### 7.3 Typed traffic-return evidence enforcement

`0069_relay_container_traffic_return_evidence_enforce.sql` now adds the local,
default-inert registry:

- one immutable subject binds the exact 0067 campaign, fence, accepted set,
  observation pair, reverse-sync, closure/quarantine/billing manifests,
  operation-14 receipt/baseline, review window, evidence policy, assembler,
  and retention horizon;
- exactly one item is required for each of Go/VPS readiness, traffic
  rehearsal, SLO, security, finance, release, retention, and WORM location;
- each type has one fixed issuer role, canonical artifact/approval/signature
  digests, a distinct issuer identity and signing key, a validity window, and
  retention at least as long as the subject;
- one immutable seal requires all eight valid retained items, binds the
  retention policy and WORM location, and uses an identity/key independent
  from every issuer and the assembler; and
- the eligibility receipt reviewer must be independent from the assembler,
  sealer, and every issuer.

0069 drops and recreates the 0067 receipt insert guard. A migration marker or
a collection of syntactically valid SHA-256 values is no longer sufficient:
the receipt must resolve the exact subject, sealed evidence set, item digests,
validity, retention, and independent reviewer at D1 time. The receipt remains
constrained to `traffic_return_authorized=0`.

### 7.4 Durable Object schema

A future DO schema version may add append-only
`cinatoken_shard_drain_attestations` rows binding:

- campaign and observation generation;
- ring/shard/owner generation;
- snapshot digest;
- local high watermark;
- lifecycle and stop-eligibility state;
- open-work counts;
- final-ACK and ambiguity counts; and
- issue/retention times.

The current implementation derives a read snapshot from existing DO SQLite.
It does not yet persist campaign-bound shard attestation rows.

## 8. Current Controller read foundation

The current local implementation adds:

- `services/container-controller/src/ledger.ts`:
  `readShardDrainSnapshot()` and `readCurrentShardDrainSnapshot()` read
  persisted operation, provider-attempt, retry, alarm, recovery, and final-ACK
  counts from DO SQLite;
- `services/container-controller/src/index.ts`:
  `onActivityExpired()` stops only when `execution_stop_eligible` is true,
  and the private read handler obtains the fixed shard set by deterministic
  DO names;
- `services/container-controller/src/container_drain_attestation.ts`:
  strict empty-body, path-bound, short-lived HMAC authentication with a
  dedicated role/key domain, exact schema validation, sorted eight-shard
  aggregation, and a request-independent state digest;
- `services/container-controller/tests/container_drain_attestation.test.ts`:
  key separation, malformed/missing/divergent shard rejection, stop/drain
  predicate separation, sorted canonical response, and stable state digest;
  and
- `tests/container-controller-runtime.test.ts`: persisted snapshot behavior
  across DO eviction and claimed/running/provider/ambiguity/final-ACK cases.

The private route is:

```text
POST /internal/v1/shard-placement/drain-attestation
```

Its read gate is `CONTAINER_DRAIN_ATTESTATION_READ_ENABLED`, default `false`.
The attestation has a dedicated credential domain separate from operation-14
disable attestation. It validates exactly eight deterministic shard names for
one ring generation and includes:

- per-shard open-work counts;
- a fail-closed unclassified-operation count;
- `execution_stop_eligible` and `accepted_work_drained`;
- `execution_stop_eligible_all` and `accepted_work_drained_all`;
- Controller service/version identity;
- a request-bound request digest;
- a request-independent canonical state digest; and
- `traffic_return_authorized=false`.

This read currently calls each named DO and may activate an evicted isolate to
read persisted SQLite. Therefore it cannot be used as evidence that no DO was
woken, that a Container was not started, or that a globally stable interval
elapsed. The method itself does not dispatch provider work, settle/refund,
create a D1 campaign, freeze admission, quarantine ambiguity, reverse-sync, or
authorize traffic.

## 9. Planned routes and gates

These routes remain design only:

```text
POST /api/platform/container/drains
POST /api/platform/container/drains/:drain_id/observe
GET  /api/platform/container/drains/:drain_id/observe
POST /api/platform/container/drains/:drain_id/ambiguities/:operation_id/quarantine/preview
POST /api/platform/container/drains/:drain_id/ambiguities/:operation_id/quarantine/apply
POST /api/platform/container/drains/:drain_id/traffic-return/receipt
```

Tracked write gates now exist in local, staging, and production Worker
configuration, all default `false`:

- `CONTAINER_DRAIN_CAMPAIGN_WRITE_ENABLED`;
- `CONTAINER_DRAIN_OBSERVATION_WRITE_ENABLED`;
- `CONTAINER_AMBIGUITY_QUARANTINE_WRITE_ENABLED`;
- `CONTAINER_REVERSE_SYNC_MANIFEST_WRITE_ENABLED`; and
- `CONTAINER_TRAFFIC_RETURN_RECEIPT_WRITE_ENABLED`.

There is no route behind these gates yet. The existing read attestation gate
remains independent. Its route is not added
to operation 14's action-gate count; operation 14 attests mutating Controller
action gates, while this protocol consumes read-only shard evidence.

## 10. Stable observation rule

At least two global observations are required after membership closure and
quarantine:

- different request IDs;
- different authenticated observation identities where the deployed trust
  model permits;
- exact campaign, fence, cutoff, ring, shard inventory, Controller version,
  placement attestation, and schema identity;
- equal request-independent state digest;
- no intervening event or membership mutation; and
- a minimum gap at least the maximum of owner lease, execution deadline,
  stream idle/terminal-finalization timeout, Queue visibility/retry delay,
  alarm retry, old-Worker grace window, reverse-sync lag, and configured
  observation floor.

The second observation must repeat source membership and cross-layer joins,
not merely compare a cached aggregate. Any unavailable shard, digest drift,
late admission, new outbox/reconciliation row, new ambiguity, or old writer
observation resets stability and requires a new observation generation.

After operation 14, the independent reviewer also confirms that the referenced
drain observations and fences remain unchanged. Operation-14 Gateway stable
readback is a separate control-plane observation and cannot substitute for
the drain observation pair.

## 11. Failure policy

| Failure | Required result |
|---|---|
| stale Worker attempts admission after fence | reject in D1; record evidence; campaign cannot proceed until old-writer scope is explained |
| accepted membership gap/duplicate/reorder | `recovery_required`; do not drain by count |
| DO unavailable or shard set missing/duplicate/divergent | observation fails; no partial aggregate |
| unknown persisted operation status | stop and drain both fail closed; repair or quarantine under reviewed evidence |
| claimed/running/prepared/dispatched work remains | Container stop ineligible; continue bounded owner recovery |
| only ambiguity or missing financial closure remains | Container may be stop-eligible; global drain remains blocked pending quarantine/reconciliation |
| any quarantine remains in `billing_hold` | billing-open count cannot be zero; drain seal remains blocked |
| terminal event lacks final ACK | member remains open |
| task terminal and billing terminal do not join | member remains open; finance owner required |
| R2 artifact missing or digest differs | member remains open or quarantined with explicit evidence |
| reverse-sync row rejected or Go shadow differs | traffic-return review blocked |
| operation 14 runs before drain seal | protocol violation; no receipt may reference it |
| operation 14 unresolved | `recovery_required`; traffic-return review blocked |
| stable observations drift | start a new observation generation |
| traffic-return receipt code attempts authorization | reject; receipt may report eligibility only |

No failure path deletes accepted membership, rewrites a terminal, blindly
resends a provider operation, silently refunds ambiguity, or truncates
evidence.

## 12. Required verification

### 12.1 Local implementation tests

The complete implementation must cover:

- admission/fence races with stale and current Worker generations;
- exact accepted-set keyset pagination, crash/resume, and source digest;
- missing, duplicate, reordered, and cross-ring members;
- NULL page/count fields, zero/partial copied membership, and frozen
  count/manifest/first/last-key drift;
- DO eviction between every snapshot and terminal boundary;
- Container restart/OOM/stop with unchanged DO ownership;
- claimed/running/prepared/dispatched/retry/alarm stop blockers;
- unknown or legacy operation status blocking both predicates;
- stop eligibility true while accepted-work drain remains false;
- provider response loss and immutable non-replay quarantine;
- terminal event without ACK and ACK without matching terminal;
- settlement/refund/task/outbox/reconciliation join mismatches;
- R2 missing/corrupt/orphan artifacts;
- Queue/DLQ/parking and stream finalization backlog;
- eight-shard missing/duplicate/divergent observations;
- stale placement attestations and per-shard semantic drift between stable
  observations;
- two stable observation timing and drift reset;
- operation 14 alone never satisfying drain or traffic-return review;
- reverse-sync rejects and Go shadow mismatch;
- traffic-return receipt never outputting authorization; and
- traffic-return receipt rejected until typed 0069 evidence enforcement is
  installed; and
- all planned write gates default false in local, staging, and production
  configuration.

Workerd tests must use real DO SQLite and D1 bindings. Node-only mocks cannot
prove eviction, storage, transaction, or binding behavior.

### 12.2 Remote staging evidence

One immutable candidate must prove:

- remote 0067 then guarded 0068 schema/catalog/trigger readback;
- old-Worker admission rejection and no accepted-set gap;
- exact deployed Edge/Controller/DO/Container versions and bindings;
- Container wake/restart/OOM and Worker N/N-1 overlap;
- provider response-loss and mutation-count evidence;
- Queue, alarm, SSE, WebSocket, outbox, reconciliation, billing, and R2
  convergence;
- reverse-sync and Go shadow comparison;
- operation-14 execution only after drain seal;
- stable observation intervals measured from deployed limits;
- Go/VPS RTO/RPO and process-owned drain evidence; and
- independent security, SRE, finance, privacy, release, and rollback
  approvals.

Local green tests are not remote evidence.

## 13. Rollout and rollback

The implementation order and current status are:

1. land this protocol and reader-only shard foundation: complete locally;
2. add 0067 expand-only D1 tables with all gates false: complete locally;
3. deploy compatible readers and collect old-writer inventory;
4. implement campaign creation and accepted-set freeze;
5. implement member closure observations and reverse-sync manifests;
6. implement per-operation ambiguity quarantine;
7. run local and isolated staging fault campaigns;
8. implement 0068 enforcement locally, then apply it remotely only after
   writer-drain proof: local schema complete, remote apply open;
9. integrate the already enforced D1 event order with the real operation-14
   runtime/write path;
10. add and verify the 0069 typed approval/WORM evidence registry: complete
    locally, remote apply open;
11. implement an eligibility-only traffic-return receipt; and
12. rehearse independent Go/VPS review without moving production traffic.

Rollback at any implementation stage:

- keeps migrations and evidence;
- disables new write gates;
- keeps or strengthens admission fences;
- routes no ambiguous operation through another provider or Go replay;
- preserves the accepted set, quarantine, operation-14, and audit history; and
- repairs forward with a new campaign generation.

## 14. Current gap statement

This batch does not claim the complete protocol. Specifically absent are:

- authenticated write routes and writer implementation for the 0067 ledger;
- authenticated initial-fence and one-SQL-step close/campaign commands for
  the locally enforced 0068 boundary;
- authenticated 0069 subject/item/seal writers and approval verification;
- remote accepted-set freeze and manifest evidence;
- authoritative source-to-member canonical recomputation for every accepted
  key, page manifest, and complete-set manifest;
- campaign-bound DO attestation rows;
- deployed global D1/billing/outbox/reconciliation/R2/Queue observations;
- canonical billing snapshot resolution and full settlement-vector replay
  against the existing single expression truth;
- deployed per-operation ambiguity quarantine workflow;
- deployed reverse-sync and Go shadow workflow;
- deployed stable global observation pair;
- integration of the D1 event-order prerequisite with the real operation-14
  runtime/write path; and
- an authenticated eligibility-only traffic-return review workflow and
  independent approval process.

Until all of those are implemented and verified against one immutable remote
candidate, Go/VPS remains authoritative and production remains **NO-GO**.

## 15. 0068 Local Enforcement Checkpoint

The earlier gap statement is historical for 0068. Application migration
`0068_relay_container_drain_admission_enforce.sql` now provides the local
D1-linearized admission boundary:

- deterministic backfill of every historical 0050 atomic admission;
- one insertion-ordered global accepted-sequence ledger;
- environment-bound open fence and scope-head identities;
- a same-batch commit sidecar required before every new 0050 receipt and every
  new Container operation, regardless of operation kind or protocol version;
- stale/closed generation rejection before provider dispatch;
- application readback that recomputes current fence-bound commit digests;
- a close guard that derives count/high-watermark/first/last identities and
  rejects any open operation missing from the commit ledger;
- exact-current-head enforcement for close, with fence close and campaign
  creation required to share one SQLite statement time; and
- an immutable 0068 scope head that rejects every recovery or aborted-campaign
  attempt to reopen admission.

Fence close plus 0067 campaign creation must be one transaction. The future
control-plane implementation must expose neither half as a standalone
operator action. Restoring Rust admission after close is outside 0068 and
requires a separately reviewed migration and authorization protocol.

The following remain production blockers:

- authenticated, audited, generation-CAS initial-open and close writers;
- a cardinality preflight and isolated-D1 duration proof for the one-shot
  historical 0050 backfill;
- independent accepted bookmark, source readback, member, page and complete
  manifest recomputation;
- 0067 member, closure, quarantine, reverse-sync and observation writers;
- canonical billing snapshot/vector replay against the existing expression
  authority;
- remote old-writer inventory, D1 readback and N/N-1 race evidence;
- an authenticated remote P5 admission-fence capture satisfying the local
  manifest-v3 evidence type and verifier;
- campaign-bound DO/R2/Queue/outbox/reconciliation evidence;
- operation-14 runtime integration; and
- remote 0069 approval/WORM evidence and independent traffic-return review.

All five drain write gates remain false. There is no remote 0068 application,
fence row, campaign or traffic change in this checkpoint. Go/VPS remains
authoritative and production remains **NO-GO**.

## 16. 0069 Local Typed-Evidence Checkpoint

Application migration
`0069_relay_container_traffic_return_evidence_enforce.sql` is now the local
schema head. It adds three append-preserved authorities and no mutation route:

- `relay_container_traffic_return_evidence_subjects`;
- `relay_container_traffic_return_evidence_items`; and
- `relay_container_traffic_return_evidence_seals`.

The exact local Application inventory is 69 migrations, 91 required tables,
1424 checked incremental columns, and 133 key indexes. Current P5
candidate/schema readback requires that 0069 head, while the admission-fence
evidence item remains cryptographically pinned to the immutable 0068 SQL
identity. Advancing schema evidence therefore cannot rewrite admission
provenance.

0069 is evidence enforcement, not the fence-close command. The required
single-SQL-step 0068 close plus 0067 campaign creation remains assigned to a
later migration so evidence registration cannot accidentally become an
admission or traffic mutation path.

The remaining production blockers include authenticated signature/policy
verification before item insertion, write authorization and audit, remote
0068/0069 apply/readback, independent issuer and reviewer identity lifecycle,
provider WORM retention readback, one-step fence close, complete source
manifest recomputation, billing-vector replay, full drain/reverse-sync/
operation-14 execution, and one immutable remote P5 packet. No Cloudflare
credential, remote database, route, DNS, traffic, or authority changed.
Go/VPS remains authoritative and production remains **NO-GO**.
