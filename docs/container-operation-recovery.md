# Container Operation Recovery Contract

## Scope

This document defines the production operation boundary between the edge
Worker, a named shard Durable Object, its disposable Rust Container, and
shared D1/KV/R2 storage. It is derived from:

- the Go relay request, retry, and billing lifecycle in cinatoken;
- the DO-supervisor and phase-checkpoint patterns in cinaVibeSDK;
- the current Rust billing reservation, sharding, authority, Controller, and
  shared-storage contracts.

It applies first to bounded non-streaming relay operations. Streaming requires
a separate resumability and billing protocol and must not inherit optimistic
claims from this contract.

## Source Audit Decisions

The Go service remains the compatibility source, but several of its failure
semantics must not be copied:

1. A generated request ID is not a durable client operation identity.
2. Process-local retry counters and billing session flags do not survive a
   restart.
3. A transport error after request transmission is ambiguous, not a definite
   failure.
4. Provider success must be persisted and billing-terminal before client
   success is emitted.
5. Subscription-only request idempotency does not make wallet and token quota
   mutations idempotent.
6. Exactly one durable owner, not the edge request and Container
   independently, decides provider retries.

The useful cinaVibeSDK pattern is the durable supervisor checkpoint around a
disposable executor: write an incomplete phase before external work, attach
the immutable result, then mark the phase complete. Container filesystem,
processes, sessions, promises, and logs are evidence only. The Rust design
keeps Jump Consistent Hash, opaque routing keys, and ring-generation fences; it
does not adopt the SDK's modulo pool or local metadata files as authority.

## Required State Machines

Global D1 billing/admission:

    reserved(owner_generation, owner_deadline)
      -> settled
      -> refunded
      -> recovery_required

Shard DO execution:

    claimed
      -> running
         -> completed(result attached)
         -> failed(definite rejection)
         -> recovery_required(ambiguous execution)
      -> failed(deadline before dispatch)

Provider-attempt journal foundation (implemented locally, activation prohibited):

    prepared -> dispatched -> succeeded
             -> cancelled  -> definite_reject
                           -> ambiguous

recovery_required is terminal for automatic execution: normal requests may
query it, but may not create a new provider attempt, switch channel, refund, or
settle. A separately authorized reconciler must use the same operation and
provider operation identities.

## Implemented Local Contract

### Runtime outcome envelope

The Rust Container now emits one strict v1 outcome:

- completed: 2xx, no code, and a validated R2 result manifest for every
  non-health operation;
- rejected: non-2xx, a bounded stable code, and no result;
- recovery_required: exactly 202, a bounded stable code, and either no result
  or the exact already-attached R2 result manifest for reconciliation.

The result manifest contains only object_key, object_version, sha256, size, and
content_type. Unknown fields, explicit nulls, invalid media types, oversized
results, invalid hashes, and contradictory status/code/result combinations
fail closed. health_probe remains the sole result-free completed operation,
and runtime execution remains disabled.

### Durable Controller outcome

The shard ledger now persists:

- operation kind and trace ID;
- response status and stable response code;
- exact R2 result key, version, digest, size, and content type;
- recovery_required separately from failed.

A non-health operation cannot transition to completed before an exact result
manifest has been attached to the same operation and owner generation. The
Controller validates the Container result against the DO columns and returns a
deterministically reconstructed outcome manifest. A terminal duplicate uses
the same durable columns and does not call the Container.

The 0042 financial terminal contract stores a separate exact client-response
manifest: status, canonical allowlisted headers, R2 version, digest, size, and
content type. It deliberately does not reuse the Container result manifest,
because failed operations forbid a result object while their deterministic
client error still needs exact replay. The bounded R2 writer, verified fetch,
and byte-return helpers now compile default-off, but no edge route calls them.
Persisted manifest replay is therefore still not a live byte-for-byte public
response.

### Ambiguous execution

The Controller distinguishes deadlines before and after dispatch:

| Condition | Durable result | Automatic action |
| --- | --- | --- |
| Claimed deadline expires before Container dispatch | failed, 504, container_execution_deadline_expired | No provider retry; reservation may be safely reconciled as not sent |
| Recovery schedule cannot be persisted before dispatch | failed, 503, container_recovery_schedule_unavailable | Do not call Container |
| Running deadline expires | recovery_required, 202, container_execution_ambiguous | No retry, fallback, refund, or new owner |
| Container timeout, malformed response, disconnect, or result mismatch after dispatch | recovery_required, 202 | Query/reconcile the same operation only |
| Strict Container rejection | failed with the returned stable code | Future retry policy may act only after durable attempt classification |
| Completed response plus exact attached result | completed | Eligible for edge R2 replay and billing terminalization |

Before the ledger moves from claimed to running, the Container class persists
a deadline callback with the library's schedule() API. Only after that succeeds
may it enter running and call containerFetch. The callback is owner-fenced and
calls the ledger's deadline CAS. This uses the Container library's alarm
multiplexer instead of overriding its alarm handler.

### D1 admission read

The Container storage gateway now returns admission state only when:

- migration `0040_relay_container_operations.sql` contains the exact operation
  ID and joins it to the same billing reservation key;
- billing and operation owner generations, channel, and selected group match;
- the billing reservation is `reserved` and the operation is `prepared` or
  `dispatched`;
- billing lease, owner lease, owner deadline, and execution deadline are live
  and consistently ordered;
- protocol, operation kind, provider operation ID, admission digest, full shard
  fence, R2 input manifest, and trace ID equal the signed envelope byte for
  byte.

Terminal, expired, malformed, stale-generation, or partially migrated records
fail closed before the DO claim or Container call. The query remains
parameterized and does not expose user, quota, credential, or
pricing-expression fields.

The 0040 table is an expand-only, default-inert global authority. Its explicit
type and null checks prevent SQLite affinity/nullable-CHECK bypasses;
reservation and operation identity are equal and immutable; timestamps are
monotonic; terminal rows cannot be reactivated. The Rust repository creates a
row only through an `INSERT ... SELECT` CAS against the live selected billing
owner. Exact retries match immutable identity even after lifecycle advancement;
collisions never overwrite an existing provider operation.

### Global lifecycle CAS and status-only query

The edge repository now persists `prepared -> dispatched` only while the exact
operation/admission digest, billing owner generation, selected channel/group,
lease, owner deadline, and execution deadline still match. Its outcome is a
dedicated type: `AlreadyDispatched` means query the same operation and must
never be interpreted as permission for another provider call.

Operation-side terminal evidence is also generation/status fenced. Completed
requires a deterministic result manifest; failed forbids one; ambiguous
execution may retain an exact result manifest while entering
`recovery_required`. A replay is matching only when status, HTTP code, bounded
response code, and every result object field are identical. An authorized
reconciler may resolve `recovery_required -> completed|failed`; normal dispatch
may not reactivate it. The append-only lifecycle enforcement migration forbids
same-state timestamp or outcome rewrites in D1.

The Controller exposes a signed status-only route that binds operation ID,
owner generation, full shard fence, and trace ID. It reads the existing named
DO ledger by RPC and remains valid after the execution deadline. It never runs
active D1 admission, claims capacity, schedules work, wakes the Container, or
calls `containerFetch`. A bounded D1 candidate query supplies expired
`prepared`/`dispatched` rows and `recovery_required` rows to the future
reconciler.

Migration 0042 and the Rust repository now provide the financial terminal
transaction. One D1 batch inserts an immutable terminal event and outbox state,
transitions the operation, transitions billing, and applies every user/token/
request/channel accounting statement. Every CAS is followed by an in-batch
`changes() == 1` assertion so a no-op aborts the whole transaction. A matching
replay is accepted only after one joined event/outbox/operation/billing
readback matches every frozen field. The first ambiguous event advances billing
to `recovery_required`; a separately identified revision may later resolve it
to completed+settled or failed+refunded without reusing the old billing
generation.

This is D1 atomicity, not a distributed transaction across D1, the shard DO,
and R2. Those stores converge through deterministic operation/event/object
identity, version and digest checks, and the bounded observer described below.
The 0042 migration remains expand-only for old-writer compatibility; it does
not enforce
that every legacy terminal transition has an event. All eight operation,
financial, replay, reconciliation, canary, divergence-proof, and staging gates
therefore remain false.

### Exact client response and divergence classification

The edge foundation now has a separate create-only R2 client-response object.
It accepts at most 4 MiB, canonicalizes a fixed safe header allowlist, forces
`cache-control: no-store`, and keys by operation ID, owner generation, and body
digest. Status, header digest, size, and content type are frozen in the D1
manifest and exact R2 custom metadata. A conditional-write miss is accepted
only after the existing object passes the same HEAD verification as a newly
created object.

Replay first validates the D1 terminal receipt and reconstructs the same strong
manifest. It then verifies the R2 version, checksum, length, content type, and
custom metadata, performs a bounded GET, recomputes the digest and length from
the returned bytes, and creates a response containing only the canonical
status and allowlisted headers. A digest stored in metadata is never accepted
as proof of the bytes by itself.

The generic relay billing orphan sweep now treats any reservation referenced by
`relay_container_operations` as Container-owned once migration 0040 is
present. Candidate selection and all later mutation race windows exclude those
rows, preventing a legacy refund path from advancing only the billing
generation.

A fail-closed classifier covers normalized D1, DO, and R2 observations. It
distinguishes converged replay, pending execution, D1 lag, resolvable recovery,
terminal conflicts, missing/divergent/orphan R2 objects, legacy eventless
terminal rows, unavailable observations, and contract violations.

### Bounded observer-only reconciliation

Migration 0043 adds durable observer state without changing operation or
financial authority. The observation row freezes operation ID, reservation
key, operation creation time, owner generation, and reconciliation identity.
Its state machine is `pending -> leased -> retry|converged|dead_letter` with
owner/generation/expiry fencing and explicit takeover only after lease expiry.
The singleton cursor separately owns a generation-fenced scheduled-run lease
and stable `(created_at, reservation_key)` scan progress.

Each round freezes the highest currently due key and scans forward without
OFFSET. The default page is 4 and the hard maximum is 8. A run has a 45-second
lease and 25-second wall budget; each item has a 30-second lease. Retry uses
deterministic operation-scoped jittered exponential delay from 15 to 900
seconds and dead-letters after a 24-hour horizon. Concurrent cron invocations,
expired workers, and cursor updates are all fenced by owner and generation.

The observer rereads the canonical operation after claim. It distinguishes
D1 `prepared` from `dispatched`, DO `claimed` from `running`, and accepts a
terminal convergence only when the D1 receipt, DO outcome, and R2 response
manifest match exactly. A DO 404 for a dispatched operation remains ambiguous
because ledger retention can remove a completed row. An R2 orphan class exists
in policy, but discovering an object with no D1 manifest still requires a
separate bounded R2 inventory cursor.

The scheduled runner is enabled only by
`CONTAINER_OPERATION_RECONCILIATION_ENABLED`, which remains false everywhere.
Its only mutations are the 0043 cursor and observation rows. It cannot update
`relay_container_operations`, billing, quota, accounting, the DO ledger, R2,
or provider state; cannot dispatch; and cannot authorize settlement or refund.
The redacted run summary contains only bounded counts and class names.

AdminAuth can read a no-store aggregate status containing schema/runtime
state, scan/run progress, due/expired counts, and class totals. RootAuth can
read a no-store observation queue through an immutable sequence cursor with
strict status/class filters and a 50-row hard limit. Both surfaces replace raw
operation, reconciliation, cursor, and high-watermark identities with
domain-separated SHA-256 references and never select the claim owner. Stored
contract drift fails the request closed. Retry apply remains a separate
RootAuth + fresh-step-up authority and is never implied by read access.

The list also returns a state-bound target for the RootAuth retry preview. The
target combines immutable observation sequence with a domain-separated digest
of operation identity, owner generation, and reconciliation identity. Preview
reloads the row by sequence, verifies the digest, accepts only a valid
dead-letter state and an allowlisted remediation reason/evidence reference,
then returns a full-state-bound preview token. Evidence reference text is not
echoed. Pending, leased, retry, and converged rows remain under automatic
observer ownership and return 409.

Preview is read-only. It reports whether 0045 apply schema and the independent
runtime flag are ready, while explicitly fixing provider retry,
operation/billing mutation, DO mutation, and R2 mutation to false. A
`retry_horizon_exhausted` row or a row with less than 60 seconds of remaining
recovery margin is visible but not a retry candidate.

### Default-off observer retry apply

Migration 0045 adds one immutable retry-event ledger and one event-backed
observer transition. It does not add provider, operation, financial, DO, or R2
write authority. The only legal mutation is an exact, generation-bound
`dead_letter -> retry` transition that preserves operation identity, claim and
attempt generations, first/last attempt timestamps, class, and recovery
deadline; clears the dead-letter/error fields; resets consecutive failures;
and schedules the next observation one second after the event timestamp.

`POST /api/platform/container/reconciliations/:target/retry/apply` requires:

1. an active RootAuth session and fresh secure verification;
2. `CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED=true` in the selected
   environment;
3. migration 0045 plus every required table, index, and trigger;
4. the exact target, preview token, allowlisted reason/evidence reference, a
   bounded idempotency key, and `confirm_reobserve=true`;
5. the same immutable dead-letter generation used by preview; and
6. at least 60 seconds between the new observation schedule and the frozen
   recovery deadline.

The Worker stores only a domain-separated idempotency digest. Event insertion
and the redacted admin audit are submitted in one D1 batch, so either both
commit or both roll back. The insert trigger rereads the exact observation and
operation identity, and the apply trigger requires exactly one observer row to
change. The immutable event supports lost-response readback: an exact repeat
returns `duplicate` with the original schedule and writes no second event or
audit. A different idempotency key with an old preview returns 409 after the
observation has moved back under automatic ownership.

This follows Cloudflare's documented
[D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
contract: statements execute sequentially and a failure rolls back the batch.
The Worker reaches D1 through the `DB` binding, awaits the mutation/readback,
and keeps secrets and credentials out of source in line with
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

Production rollout is deliberately split:

1. Apply 0045 remotely with the retry flag false and verify exact trigger SQL,
   zero retry events, and unchanged business tables.
2. Exercise status/list/preview with the flag false; archive only redacted
   references and counts.
3. In isolated staging, enable only the retry-apply flag for one approved
   dead letter, consume fresh step-up, apply once, repeat the same request, and
   prove one event, one audit, and no operation/billing/DO/R2/provider delta.
4. Disable the apply flag immediately after the drill. Observer processing is
   governed separately by `CONTAINER_OPERATION_RECONCILIATION_ENABLED`.
5. Do not enable either flag in production until remote fault, alert,
   rollback, old-writer, and C1-C5 evidence is approved.

Disabling the apply flag prevents new operator events; it does not delete the
immutable event or silently revert an already queued observation. If automatic
processing must stop, disable the observer gate as a separate rollback action.
All tracked environments currently keep the apply flag false.

### Default-off R2 orphan inventory

Migration 0044 adds an observer-only inventory for immutable Container input,
result, and client-response objects. Each lane owns an independent opaque R2
cursor, scan generation, run generation, owner, and lease. The scheduled
Worker performs at most one LIST page per lane per invocation, defaults to four
objects, and rejects a configured limit above eight. It uses the `FILE_BUCKET`
binding and requests HTTP plus custom metadata; it never GETs an object body
and has no PUT or DELETE path.

The scanner trusts `truncated` rather than page length and persists the returned
cursor without interpreting it. A 24-hour grace period excludes recent
objects. Because a multi-page walk is not a transaction snapshot, an anomaly
must appear in two completed scan generations before it can become a candidate.
An exact D1 key/version/hash/size/content-type and lane-provenance reference
resolves an earlier finding. Valid but unattached objects for `prepared`,
`dispatched`, or `recovery_required` operations are deferred, never promoted.
A divergent object that still has any D1 key/version attachment remains
observed and cannot become a cleanup candidate.

Every listed object is checked against its lane key shape, R2 checksum, size,
content type, and exact custom-metadata contract. Non-canonical objects become
`invalid_contract`; canonical unreferenced objects are separated into
`operation_missing`, `operation_known_unattached`, or `divergent_reference`.
The only writes are the new 0044 cursor and finding tables. Triggers fence every
write to the active lane generation, prohibit identity changes and deletion,
and recheck D1 references plus active-operation state before candidate
promotion. Per-object observation writes and cursor advancement have in-batch
single-row assertions, so a stale/no-op CAS rolls back the whole page.

AdminAuth may read a no-store aggregate status, while RootAuth may read a
no-store, strictly filtered, newest-first finding list. Raw object keys,
versions, operation IDs, and SHA-256 values are replaced with domain-separated
references. Both responses state that apply and delete are not compiled. The
runtime gate remains false in every tracked environment and is not a ninth
Container cutover gate.

## Edge Integration Order

The first real business canary must preserve the existing relay lifecycle:

1. Limit scope to POST /v1/chat/completions, stream=false, bounded JSON, and an
   explicitly configured local canary transport.
2. Authenticate, rate-limit, resolve model mapping, select the channel, and
   freeze billing inputs exactly once at the edge.
3. Bind the selected billing attempt in D1 before any Container dispatch.
   Use the returned owner generation; never assume a generation value.
4. Set operation_id to the exact billing reservation key. Derive the shard
   routing key from tenant identity with the scheduler HMAC secret.
5. Write the transformed request, without provider credentials, as an
   immutable R2 input and freeze key/version/hash/size/content type.
6. Sign and send the operation envelope over the private Controller Service
   Binding. An edge timeout queries the same operation ID and never creates a
   second provider attempt.
7. The Container checks reserved admission, reads and re-hashes exact R2 input,
   and calls only the fixed internal provider-egress host. The Controller
   consumes one DO attempt dispatch, calls the private credential-owning broker,
   writes immutable R2 output, and returns its exact result manifest.
8. The DO attaches the result before attempt success. The edge verifies and reads
   the same R2 object, then reuses the normal usage parser, settlement, and
   audit path.
9. Repeat the same idempotency key and prove one provider/canary execution, one
   result object, one settlement, one audit identity, and byte-identical client
   output.

Before changing billing-expression evaluation or snapshots, reread the source
contract at C:\cinagroup\cinatoken\pkg\billingexpr\expr.md. The Container must
never recompute group ratios, expression inputs, reservation policy, or quota.

## Remaining Production Work

The following are still mandatory:

- complete planned migration 0050, or prove an equivalent schema contract, so
  quota reservation, selected-attempt ownership, and operation preparation are
  one resumable D1 admission decision;
- keep the compiled edge/R2/Controller/receipt/financial-terminal canary behind
  its false code-level admission gate until that atomic contract is verified;
- add an owner-fenced scheduled terminalizer so completion does not depend on a
  surviving client retry;
- prove the default-off R2 orphan inventory against an isolated real bucket,
  including pagination, concurrent creation, metadata drift, cost, alerts, and
  retention;
- prove 0045 observer retry apply in isolated staging with the gate disabled by
  default, then one approved Root + fresh-step-up drill, exact duplicate
  readback, same-batch audit, zero protected-state delta, alerts, and
  disable-first rollback;
- deploy and prove the implemented dispatch-before-send journal, private
  provider egress broker, and Linux client in isolated staging while every
  tracked gate remains false by default;
- add immutable egress-profile identity and provider-native idempotency or
  lookup before any broader provider canary;
- add the DO-owned retry scheduler without exposing prepare or retry authority
  to the Container;
- prove the implemented create-only exact client-response R2 write and verified
  byte replay through source-parity response interpretation in isolated staging;
- remotely apply/read back 0046-0049 only after the documented old-writer drain,
  then reserve 0050 for atomic admission only if its reviewed schema requires it;
- reconciliation for R2 write success followed by DO attach failure;
- current/previous protocol parsers and N/N-1 mixed Controller/image tests;
- real cold/warm/sleep/restart/OOM and network fault evidence;
- image digest, SBOM, signature, scan, load, cost, canary, rollback, and C1-C5
  approvals.

Docker is not available in the current local environment, so no actual
Cloudflare Container process or multi-Worker local E2E is claimed. All
tracked execution, storage, scheduler, and staging switches remain false.
Go/VPS remains authoritative and production remains **NO-GO**.

## Local Verification

    node node_modules/typescript/bin/tsc -p services/container-controller/tsconfig.json --noEmit
    node node_modules/vitest/vitest.mjs run --config vitest.container-controller-protocol.config.mjs
    node node_modules/vitest/vitest.mjs run --config vitest.container-controller.config.mjs
    python tools/verify_sqlite.py
    cargo test -p cinatoken-container-runtime
    cargo test -p cinatoken-worker --lib container_
    cargo check -p cinatoken-worker --target wasm32-unknown-unknown

The protocol suite must cover strict runtime outcomes, terminal manifest
reconstruction, contradictory state, exact result matching, reserved/lease
admission, full 0040 envelope mismatch, and unknown/null rejection. SQLite must
execute null-primary-key, nullable-terminal, type-affinity, identity rewrite,
timestamp rollback, and terminal-reactivation negatives. Workerd must cover
running timeout to recovery, result-required completion, exact result
persistence across eviction, stale owner denial, and terminal storage denial.

## Provider Attempt Journal Boundary

The local journal narrows the ambiguous interval between durable admission and
provider I/O. It does not yet perform provider I/O. Ownership is fixed as
follows:

| Action | Sole owner | Durable precondition | Result |
| --- | --- | --- | --- |
| Create attempt 1 | Shard DO | Recovery schedule persisted; claimed operation and live owner/deadline | Atomic running state, frozen policy, prepared row, immutable event |
| Consume send authority | Shard DO through Container outbound handler | Exact operation/owner/attempt; policy state active; attempt prepared | One dispatched transition; only first response authorizes send |
| Persist provider classification | Shard DO | Exact dispatched attempt and active policy generation | succeeded, definite_reject, or ambiguous event |
| Attach R2 result | Shard DO after create-only R2 write | Exact latest dispatched attempt generation | Operation manifest CAS; stale generation rejected |
| Create later attempt | Future DO scheduler only | Prior definite reject, frozen policy, due time, remaining deadline | Not reachable from Container; runtime retry gate currently hard closed |

The attempt projection and append-only event ledger have separate purposes.
The projection supports bounded current-state reads. Events preserve the
transition evidence required for reconciliation and later global terminal
acknowledgement. Attempt identity, provider operation ID, admission digest,
request digest, generation, and prepared time cannot change. Retry policy,
maximum attempts, enabled bit, deadline, and creation time are also immutable.

### Deadline and terminal classification

| Durable attempt state | Deadline action | Operation action | Retry permission |
| --- | --- | --- | --- |
| No attempt, claimed | failed 504 | `container_execution_deadline_expired` | none |
| prepared | cancelled 504 | failed `provider_attempt_not_dispatched` | none; send was never authorized |
| dispatched | ambiguous 202 | `recovery_required` | none |
| succeeded with exact result | no reinterpretation | completion may finalize | none |
| definite_reject without result | no reinterpretation | failure may finalize | future policy may schedule, currently disabled |
| ambiguous | no reinterpretation | `recovery_required` in the same transaction | none |

A timeout never creates a new provider attempt. `cancelled` is deliberately
different from ambiguous: dispatch authority was not consumed, so the failure
is definite. Once authority is consumed, absence of a terminal response is
ambiguous even when no response bytes were observed.

### Protocol compatibility and R2 fencing

`/internal/v1/operations/status` remains unchanged for old Workers. The signed
v2 route adds one nullable provider-attempt snapshot. A new Worker tries v2,
falls back to v1 only for `route_not_found`, and strictly checks attempt
identity, generation, timestamps, state/operation combination, response shape,
and result equality. A result present on both operation and attempt must match
key, version, digest, size, and content type exactly.

Legacy R2 result writes retain gateway metadata version 1. Journaled writes use
version 2 and include `attempt_generation`. The Container must send the same
generation header, the latest attempt must still be dispatched, and the DO
records the same generation when attaching the R2 manifest. This only supports
max attempts 1 today because the object key remains the v1 operation/owner/hash
shape; a future multi-attempt rollout needs an independently versioned key and
manifest contract.

### Activation prohibition

Every tracked environment keeps the journal, retry, and staging-proof flags
false with max attempts 1. The runtime rejects retry=true and max attempts
above one regardless of environment values. Journal enablement is also
prohibited until the Container image actually uses the dispatch/terminal
protocol and provider calls are mediated by an atomic private Service Binding
broker. Direct internet egress remains disabled.

Terminal journal rows are retained while global D1 acknowledgement is absent.
This can fill the bounded ledger and return capacity backpressure; it must not
be bypassed by deleting attempts or events. Global terminal/outbox integration,
alerting, compaction acknowledgement, Linux lifecycle faults, and remote mixed-
version proof remain mandatory before any isolated staging enablement.

## Private Provider Egress And Recovery Boundary

The local canary now connects the Linux client to the attempt journal through a
private Service Binding broker. The broker executes exactly one already-resolved
attempt. It does not select a channel, rotate credentials, retry, parse usage,
settle billing, disable a channel, or create a later attempt.

The send boundary has two phases:

| Phase | Durable evidence | Allowed outcome | Provider resend |
| --- | --- | --- | --- |
| Before DO dispatch | Attempt remains `prepared` | Reject input, identity, D1 state, deadline, or policy as definite pre-send failure | Not needed; no send authority was consumed |
| DO dispatch committed, broker not called or result unknown | Attempt is `dispatched` | Record/return ambiguous and enter recovery | Forbidden |
| Provider response persisted in R2, DO attach unknown | Immutable object may exist; attempt is dispatched | Re-observe R2 and DO, then attach or classify divergence | Forbidden |
| Result attached, success RPC unknown | Exact manifest is in the DO grant | Reread DO and finish the same attempt | Forbidden |
| Attempt already succeeded | Exact attempt and manifest are durable | Return the same result manifest | Forbidden |

The Controller performs all deterministic checks it owns before consuming
dispatch: exact synthetic host/path/method, bounded JSON, body digest, operation
kind, R2 input identity, provider/admission/request digests, owner and attempt
generation, five-minute deadline, and global D1 `dispatched` state. The broker
binding must also be present before dispatch. The broker repeats the
security-sensitive profile, model, digest, identity, deadline, body-size, and
non-streaming checks before credential injection. This
duplication is a trust-boundary check, not a second source of routing policy.

After dispatch, transport-level evidence cannot distinguish "provider did not
receive" from "provider accepted but the response was lost". Therefore broker
binding transport loss, broker gate/model/credential rejection, absolute
timeout, non-2xx, redirect, malformed or oversized response, R2 write/readback
uncertainty, DO attach uncertainty, and terminal RPC uncertainty all converge
to recovery instead of another request. A replay of a dispatched attempt never
calls the Service Binding. The current canary now performs a pre-dispatch broker
configuration-readiness RPC, but it does not claim provider-native idempotency,
provider health, credential validation, or a provider status lookup.

The successful path is persist-before-terminal: bound provider response bytes,
validate JSON, compute SHA-256, create-or-verify the immutable R2 object, attach
the exact manifest to the same attempt generation, then record attempt success.
If the final RPC response is lost, the Controller rereads canonical DO state.
The current replay uses status 200 because upstream status provenance is not yet
durable independently of the terminal transition; broader rollout requires a
versioned response-provenance record.

Tracked Controller environments keep
`CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED`,
`CONTAINER_PROVIDER_CLIENT_ENABLED`, and
`CONTAINER_PROVIDER_EGRESS_ENABLED` false. Retry and staging verification also
remain false, and maximum attempts remains one. The broker's own gate and model
are false/empty in every tracked environment. No remote canary is authorized
until target-first binding deployment, secret provisioning and rotation proof,
real Container lifecycle tests, R2/DO/D1 fault injection, N/N-1 compatibility,
global terminal acknowledgement, exact edge replay, and financial convergence
all have dated evidence. Go/VPS remains authoritative and production remains
**NO-GO**.

## Broker Readiness Failure Semantics

The pre-dispatch sequence is now exact:

1. validate the Container request body and immutable DO grant;
2. prove the matching global D1 operation is `dispatched`;
3. require the Service Binding and read the broker's exact readiness contract;
4. only then consume DO attempt dispatch; and
5. call the execute endpoint once.

Readiness is bounded to two seconds and the remaining operation deadline. It
checks broker gate, fixed model presence, and secret presence without returning
either value or contacting the provider. The Controller independently validates
status, content type, protocol/profile headers, a 1 KiB body limit, exact JSON
fields, and no unknown fields.

Any readiness transport, configuration, credential-presence, shape, or version
failure occurs while the attempt is still `prepared`. The direct gateway
response is a no-store 503 and dispatch count remains zero. The Linux runtime
uses a conservative recovery-required envelope for any gateway uncertainty;
the DO can still prove no dispatch occurred and atomically converts that
prepared attempt to safe cancellation and operation failure. No provider retry,
lookup, R2 result, or billing settlement is authorized by readiness.

After dispatch, readiness evidence has no retry authority. A deployment could
change between the readiness GET and execute POST, so a later broker error is
still ambiguous. Closing that residual requires remote deployment-version
readback or affinity, N/N-1 proof, and provider-native idempotency or lookup. It
must not be papered over by repeating either request.

## Broker Version Affinity And Recovery Evidence

The local broker path now narrows that deployment race without pretending to
eliminate it. Readiness and execute carry the same
`Cloudflare-Workers-Version-Key`, using the frozen provider operation identity.
Readiness preserves the exact three-field v1 body used by N-1 and returns the
actual `CF_VERSION_METADATA.id` in
`x-cinatoken-provider-egress-worker-version`. The Controller requires both the
stable readiness contract and a valid private version header.

The readiness identity is committed in the same shard SQLite transaction that
changes the attempt from `prepared` to `dispatched`. The attempt row and its
append-only lifecycle events store `egress_profile` and
`egress_worker_version_id`. They are assigned as a pair at dispatch and become
immutable. This gives recovery a durable answer to which broker version was
authorized before the one-shot send.

Execute protocol v2 carries that durable ID in
`x-cinatoken-provider-egress-expected-worker-version`. A conforming broker
compares it with its own Version Metadata before body consumption, credential
read, or outbound fetch. Legacy execute v1 remains accepted only for the N-1
Controller rollout window.

The execute response is checked before status or body interpretation:

| Observation | Durable state | Result | Provider resend |
| --- | --- | --- | --- |
| Readiness body invalid or version header missing/malformed | `prepared` | 503, safely unsent | Not needed |
| V2 dispatch RPC unavailable | `prepared` | 503, safely unsent | Not needed |
| Committed dispatch identity does not match readiness | `dispatched` | 202 `provider_egress_identity_ambiguous` | Forbidden |
| Broker v2 expected version differs from its runtime version | `dispatched` | 202 `provider_egress_version_ambiguous`; broker 409 proves its provider path was not entered | Forbidden |
| Execute response version missing or different | `dispatched` | 202 `provider_egress_version_ambiguous` | Forbidden |
| Execute version equal and response valid | `dispatched` then terminal | Persist and complete the same attempt | Forbidden |

Post-dispatch version mismatch writes no R2 object and cancels the response
body. A valid protocol-v2 409 is generated before provider I/O, but missing,
malformed, or unknown responses remain ambiguous even for HTTP 200 because the
provider-side effect may already have happened. Affinity is not retry authority
and does not permit a second readiness/execute cycle after dispatch.

R2 result metadata is now versioned as follows:

- schema 1: legacy non-journaled result;
- schema 2: legacy journaled result with `attempt_generation`; and
- schema 3: journaled result with attempt generation, broker profile, and actual
  broker Worker version.

The create-only replay comparison includes every schema-3 field. Legacy DO rows
retain a null egress identity and continue to use schema 1 or 2. The old dispatch
RPC remains available for N-1 callers, while a new caller refuses to send when
an old DO does not expose the V2 RPC.

The inventory reader applies the same version split: schema 1 is exactly eight
fields, schema 2 is exactly nine with a canonical attempt generation, and schema
3 is exactly eleven with the complete bounded egress identity. This prevents a
valid schema-3 result from becoming a false recovery anomaly without accepting
unknown or partially upgraded metadata.

Cloudflare version affinity can move a stable key from an old version to a new
version as deployment percentages change. The execute v2 request therefore
checks the expected version inside the broker before provider I/O, while the
Controller still verifies the returned runtime ID. Remote deployment readback,
target-first N/N-1 drills, provider-native idempotency or lookup, and global D1
provenance remain required. D1 migration 0046 is still reserved; a later 0047
must add the global provider-egress identity after old-writer drain.

## Global Terminal Acknowledgement And Retention Fence

The migration-0042 terminal outbox now has a local delivery implementation,
but it remains disabled in every tracked environment. The edge Cron worker
claims a D1 row with a 30-second generation lease, sends one strict signed
request over the private Controller Service Binding, and completes, retries, or
dead-letters only under the same generation and expiry. The default scan is
four rows, the hard maximum is eight, and retry grows from 15 seconds to a
one-hour cap. An exact old Controller `route_not_found` response retries without
changing event identity.

The body is an immutable projection of the terminal event, not the full outbox
JSON. It contains the event and terminal-contract digests, reconciliation
revision and predecessor, operation terminal outcome, optional R2 result
manifest, shard fence, and trace ID. Accounting statements, audit payloads,
client response bytes, credentials, and plaintext idempotency values never
cross this boundary. Both request and response are bounded to 4 KiB; authority
is body-bound and the response is strict JSON with `Cache-Control: no-store`.

Shard SQLite accepts exact duplicate acknowledgements and rejects divergent
ones through the dedicated `cinatoken_shard_terminal_acks` table; this path is
independent of the optional provider-attempt journal, so journal-disabled
operations are still acknowledged and retained. A normal completed or failed
revision 1 is final. A revision-1
`recovery_required` event is retained as non-final; a later revision 2 must
identify it as predecessor, preserve reconciliation and operation/shard
identity, and can resolve to completed or failed. The DO validates revision 2
against its stored revision-1 recovery snapshot because the local operation
correctly remains `recovery_required` while global D1 owns financial
resolution. The recovery snapshot may include the exact result manifest.

Global acknowledgement still does not permit journal compaction. The ledger
requires `final_acked_at` plus a separate `compaction_authorized_at` value in
the acknowledgement table, and the acknowledgement route never writes the
latter. Both age and count compaction first require the independent runtime
gate, then both evidence fields. The tracked acknowledgement and compaction
gates are both false. Until full execution provenance and remote retention
evidence exist, terminal operations, attempts, and events remain durable even
after an acknowledgement.

The D1 financial writer atomically refuses revision 2 unless the exact
revision-1 recovery predecessor already exists for the same operation, owner
generation, and reconciliation ID. This writer-side guard prevents a new
undeliverable successor without consuming migration 0046. Because migration
0042 itself is not rewritten, old-writer drain and deployed-version proof stay
mandatory before activation; 0046 remains the future database enforcement
boundary.

The redacted admin status endpoint reports aggregate outbox lifecycle counts
only. Controller-first rollout keeps all gates false, then enables Controller
acknowledgement before the edge producer in isolated staging. Rollback disables
the edge producer first, drains or expires leases, and rolls the Controller back
last. Local Workerd also proves response-loss replay: a Controller-side prior
acceptance returns `duplicate`, and overlapping schedulers converge one D1
delivery generation. Migration 0046 remains untouched. Go/VPS remains
authoritative and production remains **NO-GO**.

## Financial Terminal Enforcement And Recovery Rollout

The local migration head is now 0046, superseding the earlier statement that
0046 was untouched or future work. It remains unapplied remotely. Four
trigger-only guards enforce complete v1 identity, `prepared` as the only new v1
initial state, exact terminal event plus outbox evidence before a terminal
operation update, and the exact revision-1 recovery predecessor before a
revision-2 event. Existing legacy/eventless rows remain readable and no repair
row is synthesized.

This database boundary is intentionally narrower than the financial batch. The
current Rust writer issues terminal event, outbox, operation transition,
billing transition, and accounting mutations in one D1 batch. The operation
trigger can see the preceding event/outbox statements and reject their absence;
it cannot attest that the deployed writer issued all later billing/accounting
statements. Deployment-version inventory and batch-contract evidence remain
part of recovery authority.

The old-writer drain applies to earlier Cloudflare/D1 writers, not Go/VPS.
Record candidate deployment as `Tdeploy`, but start the drain clock at the later
`Tdrain` only after the candidate version owns all request, Queue, Cron, alarm,
recovery, and maintenance paths and the signed deployment inventory has been
hashed into the readiness report. Any reappearance of an old owner invalidates
that inventory, its digest, every prior preflight, `Tdrain`, and the whole
observation window; recollect and resign the complete inventory before a new
`Tdrain`. That window is the maximum old
execution lifecycle and every pre-cutover operation lease/deadline plus margin, with a
hard CLI floor of 86,400 seconds. The preflight must additionally show that no
protocol-v1 operation from either side of `Tdrain` remains `prepared`,
`dispatched`, or `recovery_required`; with every runtime gate false, this
prevents enforcement from stranding any open D1 work.

Apply/readback order is schema 0045, candidate N, drain/preflight, freeze every
target-D1 writer, verify the exact UUID plus `version: production` and retention
window, capture a pre-apply disaster-recovery Time Travel bookmark and full
application-data fingerprint, apply schema 0046 through an account-pinned
stable-name/UUID/environment config with before/after target readback, then run
postflight with exact normalized trigger bodies and direct negative probes. Each negative probe must
place all fixture statements and its expected failure in one atomic D1 batch,
require the intended failing statement ordinal and exact 0046 trigger message,
reject transport/timeout/ambiguous outcomes, then prove the full
application-table fingerprint unchanged. Candidate N must
work on both schemas. A pre-0046 N-1 writer is never allowed after schema 0046.
Because D1 migrations are forward records, a normal Workers rollback does not
remove the triggers; a Worker rollback may promote the selected artifact to
100%, so only an inventoried, rehearsed 0046-compatible artifact is eligible.

On a clean postflight, resume only the pre-inventoried non-Container D1 writers
in controlled waves with migration count/head/set readback. Every wave also
requires exact writer ownership plus Container-table count/hash/high-watermark
comparison; any unexpected delta refreezes all writers. All Container gates
stay false; passing schema validation does not activate admission, execution,
financial, recovery, outbox, or compaction authority.

Recovery rollback is therefore disable-first: route new admission back to Go,
stop Rust producers and mutation gates, let active outbox leases complete or
expire, retain candidate N (or another 0046-compatible artifact) for existing
D1 recovery, and roll the Controller back last. Never delete trigger or event
evidence, edit the migration ledger, clear ambiguous operations, or retry a
provider/financial side effect merely to make the rollback appear clean.

If post-apply validation fails while gates are still false, keep all writers
frozen and compare the complete pre/post logical-export and per-table
fingerprints. A named data owner and SRE may authorize the destructive in-place
restore only if every application table is unchanged and the exact 0046 ledger
row plus four triggers are the only logical differences. Before restore,
reconfirm the target UUID, `version: production`, bookmark validity inside the
30-day Paid or 7-day Free retention window, and the all-writer freeze. Archive
the restore receipt and returned previous/undo bookmark, then revalidate the
restored ledger and full fingerprint before retry. Any application DML,
incomplete full-database evidence, or uncertain provenance forbids restore.
Quarantine the D1 database, route new admission to Go, preserve compatible
recovery, and use a reviewed forward repair migration. Time Travel is
exceptional disaster recovery, not normal rollback; it overwrites the database
in place and cancels in-flight queries. See the official
[D1 Time Travel contract](https://developers.cloudflare.com/d1/reference/time-travel/).

No remote schema, runtime, provider, or financial authority changed. Go/VPS
remains authoritative and production remains **NO-GO**.

## Immutable Provider Usage Receipt And Recovery Boundary

Migration 0048 adds a local immutable provider-usage evidence boundary after
the 0047 pre-send grant. It does not authorize a remote schema apply, provider
call, settlement, or traffic cutover. Its narrow purpose is to prevent a
provider-accepted response from being settled from estimated, reconstructed,
mutable, or caller-only usage.

### Exact receipt contract

Receipt schema 1 is canonical JSON with exactly 38 fields in declaration and
wire order:

`schema_version`, `parser_contract`, `normalization_contract`, `source`,
`estimated`, `operation_id`, `owner_generation`, `attempt_generation`,
`provider_operation_id`, `request_sha256`, `egress_profile`,
`egress_worker_version_id`, `provider_response_status`,
`provider_response_sha256`, `provider_request_id`, `provider_completed_at`,
`usage_present`, `reported_usage_fields`, `prompt_tokens`,
`completion_tokens`, `total_tokens`, `cached_tokens`,
`cache_creation_tokens`, `cache_creation_tokens_5m`,
`cache_creation_tokens_1h`, `image_input_tokens`, `image_output_tokens`,
`audio_input_tokens`, `audio_output_tokens`,
`is_anthropic_usage_semantic`, `usage_semantic_source`, `provider_cost_usd`,
`cache_creation_source`, `responses_web_search_calls`,
`responses_file_search_calls`, `claude_web_search_calls`,
`image_generation_quality`, and `image_generation_size`.

The fixed values are schema `1`, parser
`openai-chat-completions-usage-v1`, normalization
`billing-token-normalization-v1`, source `provider_response`,
`estimated=false`, and egress profile `openai-chat-completions-canary-v1`.
Canonical JSON is at most 8,192 bytes and the private base64url header is at
most 12,288 bytes. The receipt and digest travel only across the private
broker/Controller boundary; they are not public response headers.

The reported-field mask is frozen:

| Bit | Value | Provider field represented |
| --- | ---: | --- |
| 0 | 1 | Prompt/input tokens |
| 1 | 2 | Completion/output tokens |
| 2 | 4 | Provider total tokens |
| 3 | 8 | Cached input tokens |
| 4 | 16 | Aggregate cache-creation tokens |
| 5 | 32 | Five-minute cache-creation tokens |
| 6 | 64 | One-hour cache-creation tokens |
| 7 | 128 | Image input tokens |
| 8 | 256 | Image output tokens |
| 9 | 512 | Audio input tokens |
| 10 | 1024 | Audio output tokens |

No bit above 10 is legal, so the maximum is `2047`. `usage_present` is true
if and only if bits 0 and 1 are both present. A missing numeric field is
normalized to zero, but its bit remains absent; zero therefore never disguises
provider omission as an explicit reported zero.

All receipt-bound settlement requires native prompt and completion evidence.
The pricing contract then raises the evidence requirement instead of
substituting zero:

- tiered `cr`, `cc`, `cc1h`, `img`, `img_o`, `ai`, and `ao` variables require
  their corresponding reported bits; Anthropic `len` also requires cached,
  five-minute, and one-hour cache evidence;
- OpenAI-semantic tiered `cc` requires aggregate cache creation, while
  Anthropic-semantic `cc` requires five-minute cache creation and `cc1h`
  requires one-hour evidence; non-Anthropic `cc1h` is unsupported and rejects
  rather than evaluating as zero;
- per-token flat snapshots require cached, cache-creation, image, and audio
  bits whenever the selected ratios or audio-detail mode make those fields
  price-relevant; neutral ratios do not invent an unnecessary requirement;
- tiered tool or image-generation charges remain unversioned and are rejected;
  flat tool counts are exact receipt fields bounded to 256; and
- estimated usage, missing required bits, raw token overflow, the flat
  `i64::MAX` overflow sentinel, negative/nonfinite quota,
  unsupported semantics, or a supplied final quota that differs from
  recomputation fails closed.

The receipt parser and financial validator define Anthropic-related evidence,
but the migration-0048 D1 insert guard currently requires
`is_anthropic_usage_semantic=false`. Native Anthropic-semantic settlement is
therefore outside this canary and remains blocked pending a separately
versioned schema and rollout. The bit rules above define fail-closed validation
for that future boundary; they do not authorize it now.

For flat billing, normalized total is a checked
`prompt_tokens + completion_tokens`. Provider `total_tokens` may be absent or
inconsistent and is not the charging total. This preserves the Go charging
shape while retaining the provider total and its presence bit as audit
evidence.

## Edge Chat Canary Admission And Recovery Boundary

The edge orchestration foundation is intentionally unreachable in tracked and
custom environments until `container_chat_canary_admission_compiled()` becomes
true. This is a code-level safety boundary, not an operator assertion.

The future request state transitions are constrained as follows:

| Durable state or CAS outcome | Edge authority | Provider-send authority |
| --- | --- | --- |
| no admission | direct relay may continue only before cohort admission | none |
| atomic admission newly applied | build/read exact operation and attempt dispatch CAS | none yet |
| operation `prepared`, dispatch CAS `Applied` | call the signed Controller once, then query | exactly one |
| dispatch CAS `AlreadyDispatched` | query Controller only | none |
| operation `dispatched` | query status only | none |
| operation `recovery_required` | query exact status/receipt; terminalize only with matching fenced evidence | none |
| operation `completed`/`failed` | replay immutable financial-terminal client artifact | none |
| request hash conflict | return 409 without quota/provider mutation | none |
| identity, receipt, R2, or status divergence | quarantine/recovery with immutable audit evidence | none |

The current local code already enforces `Applied` versus `AlreadyDispatched`
at the dispatch fence and lets a safely unsent `prepared` row resume. It also
uses `operation.owner_generation + 1` when a `recovery_required` billing owner
is settled. These properties do not solve the earlier reserve/bind crash
window, so the hard admission gate remains false.

Planned migration 0050 must make reservation/debit, frozen billing snapshot,
selected channel/group, owner fence, operation input/shard identity, and
`prepared` state one D1 transaction with exact readback. `MatchingReservation`
must become resumable ownership rather than a generic conflict. Any failure
must classify as no admission, exact matching admission, terminal replay, or
immutable conflict; an orphan reservation is forbidden.

Recovery must later gain an independently gated scheduled owner. It may query
the Controller and perform the same receipt/R2/quote/terminal checks as the
edge, but must acquire a generation-fenced reconciliation lease and use the
single financial terminal CAS. Observation-only reconciliation is not enough:
provider completion after edge/client disappearance otherwise remains
unsettled indefinitely. After an uncertain financial-terminal call, no second
terminal decision may be attempted; exact D1 readback is the only recovery.

External traffic also waits for a shared source-parity response interpreter.
The provider broker must durably retain bounded non-2xx status/body/approved
headers, and the interpreter must apply the same success/error and usage rules
before creating the client artifact. Raw-body replay is useful integrity
evidence but is not source-equivalent behavior.

The production contract is now frozen in
`docs/response-interpreter-production-plan.md`. It keeps migration 0048 receipt
v1 immutable and reserves response-artifact migration 0052 for separate raw
provider evidence and interpreted client artifacts. Exact success bodies may be
byte-identical, but their records and object namespaces remain separate. Error
terminalization requires protocol v3 and cannot reuse a successful result or
usage receipt.

All of these paths remain default-off. No remote schema, deployment, secret,
provider, financial, or traffic operation is authorized; production is
**NO-GO**.

### Persist-before-terminal evidence chain

The only accepted local success chain is ordered as follows:

1. D1 operation and billing reservation are live, and migration 0047 freezes
   operation/owner/attempt, provider operation, request/admission, selected
   channel/group, broker profile/version, and billing contract/snapshot before
   DO dispatch and provider I/O.
2. Before dispatch, the Controller proves the exact 0048 table, identity
   ledger, columns, and guards exist. Schema drift returns a pre-send failure.
3. The private egress Worker performs one bounded non-streaming provider call,
   drains the response under the same absolute deadline, validates JSON,
   hashes the exact bytes, parses provider-native usage, and emits canonical
   receipt plus receipt SHA-256 in private headers.
4. The Controller captures those headers before consuming the body, verifies
   strict base64url, digest, canonical byte equality, all 38 fields, exact
   grant/broker/status/body identity, and all size/value bounds.
5. The Controller creates or verifies the immutable R2 result first. Its key,
   version, body SHA-256, size, content type, attempt, broker identity, and
   receipt SHA-256 must match exact custom metadata and readback.
6. The Controller performs `INSERT OR IGNORE` into D1, then rereads the primary
   row, recomputes the canonical receipt digest, and compares every grant,
   billing snapshot, provider response, result, usage, and timestamp field.
7. Only after R2 and D1 readback does the Controller atomically attach the exact
   result and receipt digest to the selected DO operation/attempt, then record
   provider-attempt success.
8. The compiled but hard-gated receipt-aware edge caller rereads the canonical D1
   receipt, recomputes quota from the frozen billing snapshot, and commits the
   receipt hash, result hash, attempt generation, exact client response, event,
   outbox, operation, billing, accounting, and audit mutations in the existing
   atomic D1 terminal batch.

The terminal D1 guard independently requires the client response status and
completed operation response status to equal the receipt's provider response
status. It also requires exact result identity, actual usage, a persisted
receipt no later than the terminal event's millisecond window, and a non-202
provider response. A valid provider 202 may be retained in R2 and D1 as
immutable evidence, but it cannot settle billing or move the global operation
to completed. It remains a global recovery case with no automatic refund and
no provider resend.

The D1 receipt is immutable by more than ordinary update/delete triggers.
SQLite `INSERT OR REPLACE` can perform an implicit delete without firing a
delete trigger when `recursive_triggers` is disabled. Migration 0048 therefore
keeps a separate append-only identity ledger for operation/owner/attempt,
provider operation, and R2 key/version. The receipt `AFTER INSERT` trigger
aborts when any identity already exists; identity update/delete triggers and
restrictive references retain the evidence. `INSERT OR REPLACE` is forbidden
for callers. Production probes must exercise exact and divergent replacement
with `PRAGMA recursive_triggers=OFF` and prove both tables are byte-for-byte
unchanged.

Migration 0049 closes the local receipt-binding loop: R2 metadata, the D1
receipt and terminal event, the DO operation/attempt, status v3, terminal ACK
v2, and the reconciliation observation all compare the same receipt/result
tuple. That remains local implementation evidence, not remote distributed
truth. The Rust terminal writer recomputes the amount, but D1 triggers cannot
independently execute arbitrary billing expressions or attest that amount;
provider invoice comparison and remote fault evidence are also absent.

### Crash-window contract

| Crash or uncertain boundary | Durable evidence after the fault | Required recovery | Provider resend | Settlement/refund |
| --- | --- | --- | --- | --- |
| Before DO dispatch | At most operation, reservation, 0047 grant, and schema-readiness evidence; attempt remains prepared | Query the same identities; cancel/fail only when durable state proves unsent | Not needed | No settle; refund only through the existing proven-unsent path |
| DO dispatch committed, before or during broker RPC | Attempt is dispatched; provider acceptance is unknowable | Enter/query recovery for the same attempt | Forbidden | Neither settle nor refund without later exact evidence |
| Provider response reached broker but receipt or body was not returned to Controller | Provider may have accepted; no trustworthy local R2/D1 receipt | Preserve ambiguous state; use provider-native lookup when available | Forbidden | Neither settle nor automatic refund |
| Receipt parsed, before R2 create/readback | Receipt exists only in volatile memory | Preserve ambiguous state; lookup/reconcile the same provider operation | Forbidden | No settle or automatic refund |
| R2 create committed, response lost before D1 receipt | Immutable result may exist with receipt-hash metadata; D1 may be absent | Exact HEAD/readback and future receipt-aware reconciliation; never infer receipt bytes from metadata alone | Forbidden | No settle or automatic refund until canonical D1 receipt exists |
| D1 receipt insert committed, response lost | Receipt and identity ledger may exist; R2 is exact | Repeat `INSERT OR IGNORE`, exact primary readback, and canonical/hash comparison | Forbidden | Eligible only after the remaining chain matches |
| D1 receipt durable, before DO result attach | R2 and D1 match; DO may lack result/receipt pair | Reattach the same exact result and receipt digest after canonical DO readback | Forbidden | No settle until status v3 and global terminal prerequisites match |
| DO attach committed, attach response lost | DO may hold the exact result/receipt pair | Reread status v3 and compare DO, R2, D1 receipt, and terminal identity | Forbidden | No settle on any divergence |
| DO success committed, before financial terminal | R2, D1 receipt, and DO result/receipt pair may exist | Hard-gated receipt-aware caller reconstructs only from frozen D1/R2/DO evidence | Forbidden | Settle once through exact D1 batch; never estimate |
| Terminal D1 batch committed, response lost | Event/outbox/operation/billing/accounting may all be committed | Joined terminal readback must prove exact replay before responding | Forbidden | No second financial mutation |
| Provider returned valid 202 | R2 and D1 may retain status/body/usage evidence | Keep recovery ownership and alert; no completed terminal | Forbidden | Both settlement and automatic refund forbidden |
| Usage present but a price-relevant field bit is absent | Canonical omission is durable and distinguishable from zero | Quarantine/reconcile provider evidence or pricing support | Forbidden | Fail closed; no settlement or automatic refund |
| Receipt identity or replacement conflict | Original receipt and identity ledger remain authoritative | Quarantine divergent input and preserve both external observations outside authority tables | Forbidden | No terminal mutation |

The provider-response-before-R2 rows are intentionally unresolved. Without
provider-native idempotency or deterministic lookup, no local algorithm can
distinguish an accepted request from a lost response. A second send or an
automatic refund would each create a different financial correctness risk.

### 0047-0049 drain, rollout, and rollback

Schema 0048 is intentionally incompatible with a true 0047 provider writer
after that writer creates a global egress grant: a settle event for that grant
must carry an 0048 receipt. The legacy branch remains available only for
operations with no 0047 grant. This is a drain boundary, not rolling write
compatibility.

The production sequence must therefore keep every Container/provider and
financial gate false while it:

1. deploys and reads back the receipt-emitting broker and 0048-capable
   Controller/financial artifacts without sending provider traffic;
2. inventories every Worker, Controller, Queue, Cron, alarm, recovery, and
   maintenance owner that can create a grant, consume a provider response, or
   write a terminal event;
3. removes every true 0047 owner and starts `Tdrain` only after the signed
   inventory proves continuous absence;
4. drains or quarantines every open 0047 grant/operation that could still need
   a receipt, and resets `Tdrain` if any old owner or new old-format row
   reappears;
5. freezes target-D1 writers, applies migration 0048 through the pinned
   account/name/UUID/environment, reads back both tables, indexes, all eight
   guards, terminal columns, and normalized SQL, then runs atomic negative
   probes including `INSERT OR REPLACE` with recursive triggers off; and
6. resumes only inventoried compatible writers in controlled waves while all
   provider and financial gates remain false. Isolated staging enablement
   requires the remote fault and reconciliation evidence from the readiness
   matrix.

Rollback is disable-first. Stop new Rust admission, provider execution,
receipt/terminal producers, and financial mutation gates; route new traffic to
Go/VPS; let active leases expire or finish under an 0048-compatible recovery
writer; preserve R2 objects, receipt and identity rows, terminal events, and
outbox evidence; then roll the Controller back last. Never promote a true 0047
artifact for an in-flight 0048/granted operation, remove migration 0048,
replace or delete a receipt, resend an ambiguous provider operation, or refund
it merely to clear state.

Production remains **NO-GO** until D1 has an independently attestable amount
authority, the compiled terminal caller and 0049 four-store comparison are
proven remotely, every enabled provider has native idempotency or
lookup, the response-before-R2 ambiguity has an approved operational path,
and authenticated remote deployment/schema/binding/secret, fault, alert,
load/cost, rollback, C1-C5, and G1-G8 evidence is complete. Go/VPS remains
authoritative.
