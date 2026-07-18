# HTTP relay billing reservations

## Scope

Migration `0023_relay_billing_reservations.sql` gives ordinary HTTP relay
tiered-expression pre-consumption a durable D1 owner. It applies to a positive
tiered reserve only. Flat billing and asynchronous task billing retain their
existing paths.

Migration `0024_relay_billing_finalization_events.sql` adds the unique audit
event marker used by the idempotent finalization consumer. This is a locally
verified, default-off recovery substrate. It is not evidence that migrations
0023-0025, the Queue resources, the cron trigger, or recovery have run in
staging or production.

Migration `0025_relay_billing_finalization_incidents.sql` adds a durable DLQ
incident ledger. Valid frozen events may be held for controlled replay; invalid
messages retain only a SHA-256 fingerprint and error classification, never the
raw poison payload. The D1 replay generation and lease survive Worker restart
or Durable Object hibernation without introducing a global billing DO.

Migration `0050_relay_container_atomic_admission.sql` adds a separate contract
for the bounded Container chat canary. It does not replace ordinary HTTP relay
reservation behavior. For that canary only, reservation creation, user/token
debit, selected channel authority, immutable admission receipt, and prepared
operation are one D1 transaction with owner generation 2. The production canary
gate remains false.

## Invariants

1. The reservation row and user/token debit commit in one D1 batch.
2. Selection binds the actual channel and serving group before response-header
   post-processing and extends the lease from selection time.
3. A positive-reserve SSE response renews only its selected reservation while
   the cloned audit stream remains active. Renewal is generation-fenced by the
   reservation key, channel, group, selected timestamp, and exact prior lease;
   it never changes quota or request count.
4. Settlement changes `reserved -> settled`, applies the quota delta, updates
   user/channel usage, and accounts the request in one guarded D1 batch.
5. Refund changes `reserved -> refunded` and restores user/token quota in one
   guarded D1 batch. Interim model-fallback and orphan-recovery refunds do not
   increment request count.
6. Matching settlement/refund/renewal replays are successful no-ops. A refund that lost
   a settlement race, a settlement that lost a refund race, or mismatched final
   identity is reported distinctly.
7. Recovery never evaluates a billing expression or mutable pricing state. An
   expired unbound reservation can be refunded; an expired bound reservation
   changes to `recovery_required` without changing quota and requires explicit
   reconciliation.
8. D1 stores no request body, prompt, raw request ID, credential, username,
   token name, or client IP. It stores a request-ID SHA-256 hash when available,
   the expression hash, and bounded routing/accounting metadata.
9. `GET /api/platform/relay-billing/ledger/status` is admin-only, `no-store`,
   and exposes only hashed reservation/account scope plus bounded state and
   timing metadata.
10. `logs.other` includes the random reservation key, final ledger outcome, and
   bounded stream-heartbeat counters so
   Queue/D1 audit delivery can be reconciled with the authoritative ledger.
11. A billing Queue event contains only the frozen final decision, identity
    hashes/keys, and a strict audit projection. It excludes username, token
    name, client IP, raw request IDs, upstream request IDs, credentials, and
    request bodies. Duplicate delivery converges through reservation CAS and
    the unique `logs.billing_finalization_event_id` index.

The expression result and `RequestInput` used for a normal settlement remain the
frozen request-scoped values produced before the upstream request. Recovery does
not reconstruct them because usage is not durably available.

## State machine

```text
reserve + debit
      |
      v
  reserved (unbound) ---- explicit/expired refund ----> refunded
      |
      +---- bind selected channel/group + extend lease ----+
                                                           |
                     active SSE ---- fenced renew ---------+
                                                           |
                                     settle + accounting -> settled
                                                           |
                   expired without durable final usage ---> recovery_required
```

All financial transitions use a status compare-and-swap plus guarded quota
statements in one D1 batch. A guard forces the batch to fail and roll back when
any expected mutation changes a row count other than one.

## Runtime behavior

- Buffered tiered responses attempt terminal billing finalization before
  returning the response. The ledger remains authoritative if that attempt
  fails; audit persistence is a later operation and is not atomic with quota.
- Streaming responses still use `Response::cloned()` plus `waitUntil()` to
  consume a second upstream branch and obtain final usage. This is a temporary
  implementation, not the target durability contract. After the response ends
  or the client disconnects, Cloudflare gives `waitUntil()` at most 30 seconds;
  permanently lost work leaves a bound row without durable final usage.
- A cloned-stream read error now preserves all usage and OpenAI-shaped output
  accumulated before the error. Reported usage settles normally. When
  `RELAY_MISSING_USAGE_ESTIMATE_ENABLED=true`, partial Chat/Completions output
  uses the existing local estimate path. Responses estimates only after at
  least one `response.output_text.delta`; a fully empty Responses stream remains
  zero usage and refunds. Audit metadata records `completion_reason=stream_error`
  and whether billable usage was recovered.
- A selected positive-reserve SSE stream renews its lease at a deterministic,
  reservation-key-derived jitter around the configured heartbeat. This avoids
  synchronized D1 writes while retaining a bounded interval. A D1 error records
  a failure and retries in at most 60 seconds; it does not interrupt the client
  stream, refund quota, or change request ownership. A final state, stale
  generation, expired deadline, identity conflict, or missing row stops renewal
  without changing the stream parser.
- Renewal is allowed only before the exact expected lease expires. The
  300-second settlement grace is not a renewal window. This prevents a late
  heartbeat from reviving a reservation already eligible for recovery.
- The relay adds no total stream-duration cap, matching the source Go relay.
  That makes deployed proof across the original lease, client disconnect,
  transient D1 failure, and recovery overlap mandatory before recovery can be
  approved. The pre-bind interval and malformed/aborted stream usage fallback
  also remain reconciliation risks. Recovery therefore remains disabled in
  every checked-in Wrangler environment.
- A zero-quota estimate does not create a reservation row and retains the
  weaker legacy post-paid settlement path.
- Ordinary audit transport remains `LOG_QUEUE` with synchronous D1 fallback.
  Reservation-backed tiered settlement/refund can use the dedicated
  `BILLING_QUEUE` only when its explicit default-off gate is enabled. A failed
  producer send falls back to the same idempotent D1 finalizer.
- The local at-least-once consumer validates queue ownership and each message
  independently, uses the frozen final decision plus D1 CAS, ACKs matching
  replays, retries only failed/invalid messages, and has environment-specific
  DLQ configuration. A separate DLQ consumer quarantines each message in D1.
  Root-only replay requires a fresh secure-verification marker, claims exactly
  one incident by generation/lease, writes a redacted manage audit, and sends
  the stored frozen event back through `BILLING_QUEUE`. The HTTP route never
  calls the financial finalizer directly and never accepts payload, quota,
  price, usage, or expression input.
- No ordinary HTTP SSE Durable Object is planned; the Rust gateway remains the
  financial owner while WFP remains transport-only.
- Pre-bind lease ownership and successful non-stream observation are locally
  closed. Every tiered request now creates a ledger identity even when its
  estimate is zero, so actual-positive usage settles through Queue/CAS instead
  of an unkeyed direct debit. Bounded synchronous inspection forwards an intact
  uninspectable 2xx only for a positive frozen reserve; flat or zero-reserve
  traffic is blocked before delivery, and consumed/malformed bodies return 502
  after any owned refund. Usage-less fixed-price audio billing is synchronous.
  A generalized idempotent flat-billing ledger, client abort and idle-timeout
  classification, bounded streamed-text accumulation, remote
  direct/Gateway/WFP replay, and deployed finalization reconciliation remain
  production blockers.

## Configuration

| Variable | Default | Contract |
| --- | ---: | --- |
| `RELAY_BILLING_RESERVATION_LEASE_SECONDS` | `3600` | Accepted range 300-86400. Applied at reserve and extended from selected-attempt binding. |
| `RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS` | `900` | Accepted range 5 through one third of the effective lease. Runtime uses deterministic +/-10% jitter (never below 5 seconds). Invalid explicit values fall back safely but report `valid=false` and prevent the scheduled recovery sweep. |
| `RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED` | `false` | Evidence gate only. Set true after the deployed long-stream and recovery-race matrix is archived; it does not start recovery by itself. |
| `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` | `false` | Charge-affecting Go-parity gate. Abnormal streams without reported usage cannot pass recovery readiness while this is disabled. |
| `RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED` | `false` | Evidence gate for reported-usage and partial-output read-error settlement. Local Workerd evidence does not set it. |
| `RELAY_BILLING_FINALIZATION_QUEUE_ENABLED` | `false` | Enables Queue transport only when `BILLING_QUEUE` is also bound. Binding existence alone never changes billing behavior. |
| `RELAY_BILLING_FINALIZATION_RECONCILE_ENABLED` | `false` | Enables the root + step-up single-incident replay command only when D1 migration 0025 and `BILLING_QUEUE` are present. It remains false in every tracked environment. |
| `RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED` | `false` | Evidence gate for Queue retry, DLQ, Worker cancellation, and settlement/recovery race replay. Local duplicate/cross-queue/poison-message evidence does not set it. |
| `RELAY_BILLING_PREBIND_OWNER_GENERATION_STAGING_VERIFIED` | `false` | Evidence gate for delayed-header, late-bind, D1 ambiguity, terminal/recovery, Queue v2, and rollback race replay. It remains false in every tracked environment. |
| `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED` | `false` | Enables bounded scheduled handling only after migration and stream-lifetime evidence. Unbound rows refund; bound rows quarantine. Cutover readiness additionally requires the staging-verification gate. |
| `RELAY_BILLING_ORPHAN_SWEEP_LIMIT` | `32` | Accepted range 1-64 per cron invocation. |

Settlement is allowed through the inclusive lease-plus-300-second boundary;
recovery is allowed only after it. Failed recovery mutations use bounded
exponential retry deferral.

## Staging enablement

1. Rotate any exposed Cloudflare credential. Use a least-privilege deployment
   credential and archive only redacted command output.
2. Freeze old and new Rust admission, prove zero active HTTP `reserved` rows,
   and keep all relay recovery/finalization gates false. Apply the additive
   exact 26-file D1 set through migration 0026. Migration 0026 intentionally
   fails while any active row exists.
3. Deploy the new Worker with relay recovery still false. The new relay writes
   the ledger on tiered requests and can consume finalization events, so
   migrations 0023-0026 must exist before code promotion.
4. Verify `/api/platform/capabilities` reports the exact migration set,
   ledger and stream-renewal contracts compiled, heartbeat explicitly configured
   and valid, missing-usage estimate state, both stream staging proofs false,
   billing finalization gate false, producer binding state, consumer/DLQ/CAS
   compiled, reconcile implementation true, reconcile enable/readiness false,
   runtime readiness false, replay proof false,
   recovery disabled, and cutover readiness false.
5. Run reserve, selected bind, settle, explicit refund, matching replay,
   settle-vs-refund race, model fallback, stream-abandonment, heartbeat
   generation conflict, and renewal-vs-settlement fixtures.
6. Run a deployed SSE response beyond the original selected lease, not merely
   one heartbeat interval. Prove repeated lease growth, one terminal settlement,
   exact user/token/channel quota, one request count, and bounded audit metadata
   on direct, AI Gateway, and WFP routes that are enabled for the release.
7. Repeat with clean EOF, malformed then valid data, reported usage then read
   error, partial output then read error, empty/output Responses streams, client
   disconnect, idle timeout, transient D1 renewal failure, Worker restart/deploy,
   and a scheduled recovery overlap. For every fixture prove provider call=1,
   request count=1 where billable, exact user/token/channel deltas, usage source,
   termination reason, and zero unexplained pending rows.
8. Create and read back the environment-specific producer Queue, consumer,
   retry count, and DLQ. Keep `RELAY_BILLING_FINALIZATION_QUEUE_ENABLED=false`
   until migrations, consumer health, alerts, and rollback are verified.
9. Reconcile user quota, token remain quota, request count, channel used quota,
   ledger outcomes, and audit rows before any traffic expansion.
10. With the reconcile gate still false, read back the DLQ consumer, its
    environment-specific parking queue, and alerts. Then enable reconciliation
    only for one isolated fixture: use a root session with fresh step-up, select
    one explicit incident ID, assert `202 queued`, observe one main-queue CAS
    outcome and one manage audit, then assert a second replay is rejected.
    Reconciliation must never accept a replacement event or pricing input.
11. Only then configure cron and enable recovery in isolated staging. Prove the
    300-second boundary, sweep bound, retry deferral, unbound exactly-once
    refund, bound quarantine, D1 ambiguity, Worker cancellation, settlement/
    recovery overlap, and no double quota mutation.
12. Set each staging-verification gate only after signed approval of its own
    redacted evidence. `relay_billing_orphan_recovery_cutover_ready` must remain
    false until recovery, both streaming proofs, Queue enablement/binding,
    consumer, DLQ, replay, reconcile, D1 schema, and replay staging proof are all
    true.

## Rollback

Disable `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED` first, then reconcile and
Queue finalization. This stops new automated
refund attempts without reversing completed CAS transitions. Route traffic back
to Go/VPS if needed, retain migrations 0023-0026 and all ledger/audit/incident rows, then reconcile
every `reserved` and `recovery_required` row before another cutover. Do not drop
the table or manually credit quota without recording the reservation
fingerprint, observed state, approved disposition, and resulting quota deltas.
Never decrement or reuse `owner_generation`; Queue schema v1 is valid only for
draining generation-1 reservations.

## Local verification

```powershell
python tools/verify_sqlite.py
bun run check:d1:migration-config
bun run check:cf:billing-queue
bun run check:relay-billing-finalization:reconcile-contract
cargo test -p cinatoken-worker --lib relay_billing
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:do-lifecycle-runtime
bun run check:web
bun run check:web:readiness
```

Local SQLite, Rust, Wasm, Workerd, and frontend checks are E3 evidence only.
Production readiness still requires authenticated staging migration, real
Worker scheduled events, a stream that crosses the original lease, disconnect
and D1 fault injection, recovery-race accounting and audit reconciliation,
alerts, retention policy, and rollback proof.

## Container Canary Atomic Admission (0050)

The Container chat canary no longer uses the ordinary sequence of reserve,
later selected-attempt bind, and separate operation insert. Its local 0050 path
constructs one complete selected reservation and commits it with the operation
and immutable admission receipt in one `D1Database.batch()`.

### Stable reservation and frozen settlement identity

The ordinary HTTP reservation key remains contract-scoped. The Container
canary overrides only its key with
`relaycontainer-v1-{client_idempotency_hmac_sha256}`. The HMAC covers only user
ID, token ID, and the validated `Idempotency-Key`. Model, selected
group/channel, transformed provider input, and pricing are deliberately absent.
The separate request-conflict digest covers model plus the original request
body only and remains unchanged after provider-body conversion.

Pricing is not ignored. The atomic admission digest binds the exact expression
or flat contract hash, canonical billing snapshot JSON, reserved quota, model,
endpoint, client hashes, selected group/channel/type/snapshot key, transformed
input, shard, and provider-operation identity of the persisted winner. These
facts define admission/settlement authority, not client identity. The receipt
also binds `idempotency_alias_count` and the order-independent
`idempotency_aliases_sha256` digest of the sorted, length-framed
current/previous HMAC alias set.

After request parse, model/auth resolution, and relay rate limiting, the relay
derives current/previous tenant HMAC candidates plus the model/original-body
digest and queries immutable `relay_container_idempotency_aliases` as the 0050
authority. Retry/model fallback, current channel-pool discovery, affinity,
provider conversion, ordinary billing reservation/debit, and send occur only
after a miss when a successful 0050 history probe proves durable history is
empty and replay-only mode is inactive. Any miss with existing history returns
503 because a dropped old secret could otherwise hide the persisted billing
owner. A match resumes the persisted
winner even if its channel is disabled or removed. A different model/original
body is request conflict. Schema/query failure or divergent persisted linkage
fails closed; immutable divergence is a server-side 503 integrity failure, not
a client 409. None falls back to a new reservation.

The receipt stores `billing_snapshot_sha256` and the selected channel type plus
`selected_snapshot_key`. For flat pricing, the key must equal the channel type
rendered as decimal text. Container provider-usage settlement first reads the
exact receipt by reservation and verifies its operation linkage, then resolves
the frozen billing JSON by selected group and this snapshot key. It does not
look up the flat snapshot with `channel_id` and it never evaluates mutable
current pricing during replay or recovery.

Settlement quote and final financial commit each reread the admission receipt,
billing reservation, and Container operation. Both paths recompute
`billing_snapshot_sha256`, reconstruct the full atomic admission record, and
recompute `atomic_admission_sha256`; any three-record mismatch rejects before a
financial mutation.

### All-or-nothing batch

The D1 statement order is authoritative:

1. enable deferred foreign keys;
2. insert the immutable admission receipt first;
3. claim every current/previous HMAC alias in the receipt's one- or two-member
   set under a global alias primary key;
4. insert the selected `reserved` billing row with generation 2;
5. debit active, non-deleted user quota;
6. debit the exact active, non-deleted, unexpired owning token;
7. recheck selected channel status, type, group, and model authority; and
8. insert the matching generation-2 `prepared` Container operation.

A guarded assertion follows every required mutation and must observe one
changed row. The receipt's foreign keys are checked at transaction completion,
after the reservation and operation exist. Any quota shortage, authority drift,
trigger rejection, identity/alias collision, or row-count mismatch rolls back
every alias, the receipt, reservation, both quota mutations, and operation
together. Post-error readback queries all supplied aliases and returns the
persisted winner or an immutable/request conflict; it never retries as a fresh
billing owner.

The receipt also fixes owner lease/deadline, selected/created time, admission
attempt count 1, and provider attempt generation 1. The stable atomic digest is
independent of contender timing, lease/deadline, trace, R2 version, and the
winner-specific operation admission digest, allowing equivalent concurrent
contenders to classify the same winner by exact readback.

### Replay and settlement safety

- `Applied` means the batch committed and exact readback returned the prepared
  owner.
- `MatchingResumable` means the same immutable owner is still prepared,
  dispatched, or validly recovery-required. It never debits again.
- `TerminalReplay` requires the exact immutable financial terminal receipt for
  the completed/failed operation.
- `RequestConflict` means the client idempotency identity was reused for a
  different model or original request body.
- `ImmutableIdentityConflict` covers any missing, one-sided, or divergent
  receipt/reservation/operation/financial linkage and returns a server-side 503.

Replay dispatch, settlement, and terminal audit use the channel ID and selected
group stored on the winner operation. A retry-time selector result is never
allowed to replace or relabel that authority.

The 0050 drain guard refuses to apply over an existing protocol-v1
`chat_completions_canary` operation. After apply, the operation insert trigger
requires the receipt, canonical alias, and selected reservation, so an old
writer cannot leave an unmarked prepared canary operation. Alias and receipt
update/delete plus canary operation delete are rejected, and operation updates
require the immutable receipt link.

### Default-off replay-only billing boundary

The local rollback foundation is separate from new admission.
`CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED` and
`CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED` default false and require exact
`true`. The replay-only cohort remains bounded by route, token, and model. New
admission remains impossible while
`container_chat_canary_admission_compiled()` is false.

New admission is canonical-current-write: the current secret names the
reservation and operation, while the same D1 batch claims both the current and
distinct previous HMACs as immutable aliases. Replay derives current then
previous candidates and follows either alias to that canonical winner. A
rolling version with a different current key cannot create a second billing
owner because the global alias claim conflicts and rolls back its whole batch.
Previous-key retention and a proved drain remain part of the billing evidence
contract, because losing that key can hide an existing reservation identity.

Replay cannot treat authority failure as absence. Every eligible idempotent
request probes 0050 history even when a current or previous secret is present.
Missing/incomplete schema, failed history/alias queries, immutable linkage
conflicts, and any alias miss with existing history return 503. Ordinary
billing after a miss may be reached only when the history probe succeeds,
reports no durable 0050 history, and replay-only mode is inactive. This strict
boundary remains until bounded secret-generation/key-ID coverage and retention
are implemented and remotely proved.

Replay lookup runs after request parse, model/auth, and relay rate limiting but
before retry/model fallback, current channel discovery/selection, affinity,
provider transformation, ordinary pre-reserve/debit, and upstream send. In an
active replay-only cohort, a miss returns HTTP 503 with `Retry-After: 5`; it
cannot enter ordinary reserve or provider execution. Completed/failed owners
use read-only terminal replay only when exact-response replay and `FILE_BUCKET`
are available; otherwise they return HTTP 202 pending. `dispatched` and
`recovery_required` require Controller/replay readiness. Before `prepared`
advances in D1 it additionally requires operation replay readiness, scheduler
enablement, a valid ring and routing secret, the explicit prepared-resume gate,
and verified Controller binding, authority, controller enablement, and
execution enablement. Closed gates preserve the existing billing owner in
`prepared` and return HTTP 202 pending evidence.

### Evidence and production gate

The current local test tree covers the migration/batch path, concurrent winner
readback without a second debit, quota/authority/marker rollback, old-writer
rejection, alias schema/digest/immutability checks, three-record settlement,
frozen snapshot lookup, current/previous identity derivation, and replay state
decisions. The completed local validation reports Workerd 14/14, Worker Rust
820/820, and SQLite 50 migrations / 48 tables / 540 incremental columns / 72
key indexes; the repository-wide `bun run check`, including the root Worker
Wrangler dry-run, also passes.

Endpoint-level replay-only miss isolation, schema/query 503s,
missing/stale-secret history, unknown-history probing, history-backed alias
miss, real-D1 alias collision during key rotation, and replay state gates across
D1/R2/DO/Controller still lack dedicated local and remote proof.

The R2 input write happens before this batch and is not financial authority.
Local capability integration now exposes boolean-only
`container_chat_canary_replay_history_probe_known` and
`container_chat_canary_replay_history_present`, R2 binding availability, and
`container_chat_canary_terminal_replay_runtime_ready`,
`container_chat_canary_dispatched_recovery_runtime_ready`, and
`container_chat_canary_prepared_resume_runtime_ready`; aggregate replay
readiness is their conjunction. `container_chat_canary_replay_only_active`
means only the actual replay-only flag plus a configured cohort predicate and
cannot replace readiness. An unknown history probe forces every replay-readiness
field false. A false history boolean is usable only with schema-ready and
`container_chat_canary_replay_history_probe_known=true`, and no identity is
exposed.

Remote 0050 apply/readback, endpoint-level Worker faults, a real two-version
current/previous rotation, remote D1/Controller/R2 evidence, old-writer drain,
R2 orphan policy, real Container/provider faults, scheduled terminalization,
invoice/accounting reconciliation, alerts, rollback, and approval remain
pending. No deployment is claimed. Go/VPS remains authoritative; production
and the Container canary remain **NO-GO** because
`container_chat_canary_admission_compiled()` is still false.

The default-off replay-only and atomic current/previous-alias foundation is
implemented locally. Cutover remains blocked until code audit accepts it as a
signed rollback artifact, the key-retention and previous-key drain runbook is
approved, and endpoint-level remote fault/financial proof shows existing
generation-2 owners can terminalize or resume without new admission, duplicate
reservation/debit/provider execution, or upstream fallthrough.

## Scheduled Financial Terminalization (0051)

Migration `0051_relay_container_scheduled_terminalization.sql` records the
exact reconciliation lease that won a locally autonomous settlement. It
supersedes the prior statement that scheduled terminalization is unimplemented,
but only for the bounded exact-completion path. It does not authorize a remote
schema apply, canary, provider request, refund, or financial cutover.

The scheduled path is disabled unless both
`CONTAINER_SCHEDULED_TERMINALIZER_ENABLED` and
`CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED` are exact `true`. Existing
operation replay authority, `FILE_BUCKET`, the bounded reconciliation observer,
and complete 0051 schema readiness are additional requirements. A live
Controller probe must prove probe/binding/authority, verified status, controller
enablement, and execution enablement before any scheduled item is claimed. Both
new gates remain `false` in every tracked environment.

### Financial authority

The scheduler does not invent usage or amount authority. It can settle only an
existing 0050 atomic admission whose D1 operation is `dispatched` or
`recovery_required` and whose Controller evidence is exact `Completed` plus
`DefinitiveTerminal`. It then reuses the same provider-usage settlement path as
client replay:

1. verify status-v3 attempt 1, with no v1/v2 fallback, provider receipt, result
   identity, and response status;
2. reread the immutable provider usage receipt and exact 0050
   admission/reservation/operation linkage;
3. recompute the frozen billing snapshot digest, atomic admission digest, and
   final quota quote;
4. reject a declared result above the 4 MiB replay ceiling before buffering its
   body, then verify the create-only R2 result and create or exactly replay the
   R2 client response; and
5. submit one owner-fenced D1 financial terminal batch.

It never evaluates mutable current pricing and never sends, retries, or looks
up a provider as a side effect of terminalization. Missing receipt fields,
incomplete R2 evidence, amount drift, status mismatch, stale lease, or
ambiguous provider state fails closed. Store unavailability and replay material
that is still missing remain bounded retries. Divergent response material,
protocol/identity/quote violations, and conflicting financial decisions retain
their exact error codes and dead-letter immediately. Automatic refund or quota
compensation is not a fallback.

The terminal audit is schema v2 and is path-independent. Both client replay and
scheduled replay serialize it from the persisted reservation and operation,
including frozen `request_id_hash`; the current request ID/CF Ray and client IP
are excluded. Caller-provided user, token, model, and endpoint fields can only
validate the persisted tuple and cannot alter the financial decision hash.

### Atomic settlement proof

The D1 batch commits the terminal event, outbox, user/token/channel accounting,
operation completion, reservation settlement, and the 0051 row together. The
0051 row freezes billing event, reservation/operation, operation owner
generation, prior operation state, prior billing owner generation,
reconciliation identity/revision, observation claim generation/owner, exact
claim lease expiry, receipt and result digests, terminal contract digest, and
commit time.

Its final insert proves that the observation claim is still leased by the same
owner/generation with the exact frozen lease expiry, and that lease and recovery
deadlines are later than both the supplied commit time and D1 transaction-time
`unixepoch()`. It also proves the same-batch event is exact
`completed`/`settle`, the operation is completed, the reservation is settled
with generation advanced exactly once and the request accounted, and the 0050
admission still matches. `dispatched` is revision 1 and
`recovery_required` is revision 2. Any failed predicate or statement aborts all
D1 effects. The row is immutable and cannot be deleted.

The R2 client-response write precedes D1 and cannot join its transaction. A
failed D1 commit can therefore leave a create-only R2 orphan. That object has
no billing authority; cleanup requires the separate retention policy and exact
absence of terminal/admission authority. Operators must never infer settlement
from R2 presence alone.

### Replay, crash, and rollback

- Before D1 commit, a crash leaves no settlement winner; a later observation
  lease generation may reverify the entire contract.
- A stale/concurrent observer cannot commit because claim owner, generation,
  attempt count, and lease horizon are checked inside D1.
- After D1 commit, response loss is resolved from the immutable terminal
  receipt/event/outbox/0051 tuple. The next observer reloads the completed
  operation and records convergence without a second accounting mutation.
- Duplicate schedules, Controller status replays, and lease reclamation are
  idempotent only by durable readback. They never authorize provider resend.

Rollback first sets both terminalizer gates false, then closes new admission,
prepared resume, provider, and terminal/reconciliation producers. New traffic
returns to Go/VPS while a 0051-aware reader drains or quarantines existing
owners. Retain 0050/0051, financial receipts, events/outbox, R2 artifacts and DO
evidence. Do not drop schema, delete evidence, edit quota by hand, retire an
identity key before a proved drain, or deploy an incompatible old writer.

Production promotion remains blocked on authenticated 0051 apply/readback,
remote full-batch rollback and response-loss proof, independent settlement
amount authority, provider invoice convergence, provider-native idempotency or
deterministic lookup, R2 orphan retention, shared non-2xx semantics, real
DO/Container lifecycle and N/N-1 alarm proof, alerts/load/cost, rollback, and
C1-C5/G1-G8 approval. Go/VPS remains the sole production financial authority
and production remains **NO-GO**.
