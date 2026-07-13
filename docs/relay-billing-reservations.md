# HTTP relay billing reservations

## Scope

Migration `0023_relay_billing_reservations.sql` gives ordinary HTTP relay
tiered-expression pre-consumption a durable D1 owner. It applies to a positive
tiered reserve only. Flat billing and asynchronous task billing retain their
existing paths.

This is a locally verified, default-off recovery substrate. It is not evidence
that migration 0023, the cron trigger, or recovery has run in staging or
production.

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
- Streaming responses still use `waitUntil()` to consume the cloned upstream
  stream and obtain final usage. If that work is permanently lost, the row stays
  `reserved` until recovery moves the bound row to `recovery_required`.
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
- Audit transport remains `LOG_QUEUE` with synchronous D1 fallback. Queue is not
  part of quota correctness; `relay_billing_reservations` is authoritative.

## Configuration

| Variable | Default | Contract |
| --- | ---: | --- |
| `RELAY_BILLING_RESERVATION_LEASE_SECONDS` | `3600` | Accepted range 300-86400. Applied at reserve and extended from selected-attempt binding. |
| `RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS` | `900` | Accepted range 5 through one third of the effective lease. Runtime uses deterministic +/-10% jitter (never below 5 seconds). Invalid explicit values fall back safely but report `valid=false` and prevent the scheduled recovery sweep. |
| `RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED` | `false` | Evidence gate only. Set true after the deployed long-stream and recovery-race matrix is archived; it does not start recovery by itself. |
| `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED` | `false` | Enables bounded scheduled handling only after migration and stream-lifetime evidence. Unbound rows refund; bound rows quarantine. Cutover readiness additionally requires the staging-verification gate. |
| `RELAY_BILLING_ORPHAN_SWEEP_LIMIT` | `32` | Accepted range 1-64 per cron invocation. |

Settlement is allowed through the inclusive lease-plus-300-second boundary;
recovery is allowed only after it. Failed recovery mutations use bounded
exponential retry deferral.

## Staging enablement

1. Rotate any exposed Cloudflare credential. Use a least-privilege deployment
   credential and archive only redacted command output.
2. With the old Worker still serving and all relay recovery gates false, apply
   the additive exact 23-file D1 set through migration 0023 to isolated staging.
3. Deploy the new Worker with relay recovery still false. The new relay writes
   the ledger on tiered requests, so migration 0023 must exist before code
   promotion.
4. Verify `/api/platform/capabilities` reports the exact migration set,
   ledger and stream-renewal contracts compiled, heartbeat configured and valid,
   staging verification false, recovery disabled, and cutover readiness false.
5. Run reserve, selected bind, settle, explicit refund, matching replay,
   settle-vs-refund race, model fallback, stream-abandonment, heartbeat
   generation conflict, and renewal-vs-settlement fixtures.
6. Run a deployed SSE response beyond the original selected lease, not merely
   one heartbeat interval. Prove repeated lease growth, one terminal settlement,
   exact user/token/channel quota, one request count, and bounded audit metadata
   on direct, AI Gateway, and WFP routes that are enabled for the release.
7. Repeat with client disconnect, malformed/provider-error termination,
   transient D1 renewal failure, Worker restart/deploy, and a scheduled recovery
   overlap. Archive latency/backpressure and D1 write-count evidence. Keep the
   staging-verification and recovery gates false on any unresolved row or delta.
8. Configure a cron and enable recovery only in isolated staging after the
   renewal matrix passes. Prove the 300-second boundary, sweep bound, retry
   deferral, unbound exactly-once refund, bound quarantine, and no double quota
   mutation.
9. Reconcile user quota, token remain quota, request count, channel used quota,
   ledger outcomes, and audit rows before any traffic expansion.
10. Set `RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED=true` only after
    signed approval of the redacted evidence. `relay_billing_orphan_recovery_cutover_ready`
    must remain false until both this gate and recovery are true.

## Rollback

Disable `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED` first. This stops new automated
refund attempts without reversing completed CAS transitions. Route traffic back
to Go/VPS if needed, retain migration 0023 and all ledger rows, then reconcile
every `reserved` and `recovery_required` row before another cutover. Do not drop
the table or manually credit quota without recording the reservation
fingerprint, observed state, approved disposition, and resulting quota deltas.

## Local verification

```powershell
python tools/verify_sqlite.py
bun run check:d1:migration-config
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
