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
3. Settlement changes `reserved -> settled`, applies the quota delta, updates
   user/channel usage, and accounts the request in one guarded D1 batch.
4. Refund changes `reserved -> refunded` and restores user/token quota in one
   guarded D1 batch. Interim model-fallback and orphan-recovery refunds do not
   increment request count.
5. Matching settlement/refund replays are successful no-ops. A refund that lost
   a settlement race, a settlement that lost a refund race, or mismatched final
   identity is reported distinctly.
6. Recovery never evaluates a billing expression or mutable pricing state. An
   expired unbound reservation can be refunded; an expired bound reservation
   changes to `recovery_required` without changing quota and requires explicit
   reconciliation.
7. D1 stores no request body, prompt, raw request ID, credential, username,
   token name, or client IP. It stores a request-ID SHA-256 hash when available,
   the expression hash, and bounded routing/accounting metadata.
8. `GET /api/platform/relay-billing/ledger/status` is admin-only, `no-store`,
   and exposes only hashed reservation/account scope plus bounded state and
   timing metadata.
9. `logs.other` includes the random reservation key and final ledger outcome so
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
- Selection extends the lease, but there is no stream heartbeat yet. Before
  enabling recovery, the relay must enforce a maximum provider/client stream
  duration below the lease minus operational margin, or renew active leases.
  That proof does not exist yet, so recovery remains disabled in every checked-in
  Wrangler environment.
- A zero-quota estimate does not create a reservation row and retains the
  weaker legacy post-paid settlement path.
- Audit transport remains `LOG_QUEUE` with synchronous D1 fallback. Queue is not
  part of quota correctness; `relay_billing_reservations` is authoritative.

## Configuration

| Variable | Default | Contract |
| --- | ---: | --- |
| `RELAY_BILLING_RESERVATION_LEASE_SECONDS` | `3600` | Accepted range 300-86400. Applied at reserve and extended from selected-attempt binding. |
| `RELAY_BILLING_ORPHAN_RECOVERY_ENABLED` | `false` | Enables bounded scheduled handling only after migration and stream-lifetime evidence. Unbound rows refund; bound rows quarantine. |
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
   `relay_billing_reservation_ledger_compiled=true`, and recovery disabled.
5. Run reserve, selected bind, settle, explicit refund, matching replay,
   settle-vs-refund race, model fallback, and stream-abandonment fixtures.
6. Prove the configured maximum stream duration is lower than the selected
   lease. Otherwise keep recovery disabled.
7. Configure a cron, enable recovery only in isolated staging after stream
   lifetime proof, and prove the 300-second boundary, sweep bound, retry
   deferral, unbound exactly-once refund, bound quarantine, and no double quota
   mutation.
8. Reconcile user quota, token remain quota, request count, channel used quota,
   ledger outcomes, and audit rows before any traffic expansion.

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
Worker scheduled events, stream-lifetime fault injection, accounting and audit
reconciliation, alerts, retention policy, and rollback proof.
