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
