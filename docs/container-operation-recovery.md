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

Future provider-attempt journal:

    prepared -> dispatched -> succeeded
                           -> definite_reject
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
contract drift fails the request closed. Operator retry and any apply workflow
still require separate preview, idempotency, audit, and default-false gates.

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
7. The Container checks reserved admission, reads exact R2 input, runs the
   deterministic local OpenAI-compatible canary, writes immutable R2 output,
   and returns its exact result manifest.
8. The DO attaches the result before completion. The edge verifies and reads
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

- wire the default-off Rust envelope/R2/Controller foundation into the narrow
  non-streaming chat canary after all admission records are committed;
- wire the implemented guarded D1 financial terminal batch into the narrow
  edge canary only after R2 response verification succeeds;
- derive the implemented tenant/user/token/route-scoped client idempotency HMAC
  at admission, require it for the canary, and map the implemented same-key/
  different-request lookup conflict to 409;
- add bounded R2 orphan inventory plus authenticated retry preview around the
  implemented status/list surface, then design any resolution/apply workflow
  as a separately gated generation-fenced protocol with audit;
- dispatch-before-send provider attempt journal and one retry owner;
- deterministic local provider canary in the actual Linux image;
- wire the implemented create-only exact client-response R2 write and verified
  byte replay into the narrow edge canary without enabling any broader route;
- after old writers drain and remote 0042/0043 invariants pass, add a separate 0044
  enforcement migration that rejects legacy empty identity and eventless v1
  terminal transitions;
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
