# Task v2 Durable Billing Ownership

## Scope

Migration `0031_task_billing_intents.sql` introduces the first durable owner for
video, Suno, and Midjourney billing before provider I/O. It closes the old
`reserve -> provider -> local insert` gap, but it is not a production-cutover
claim. Go/VPS remains authoritative until the open gates in this document have
remote evidence.

The billing expression or frozen flat-pricing snapshot remains the pricing
source of truth. The Task intent stores that exact contract and its SHA-256;
recovery code must never recompute price from current options.

## Durable identity

Each submit creates one `task_billing_intents` row before outbound I/O. The row
freezes:

- reservation/public operation identity, task kind, provider kind, and provider
  idempotency identity;
- user, token, channel, quota, funding source, and subscription identity;
- canonical billing contract JSON and SHA-256;
- submission, financial, lease, attempt, recovery, and accounting state.

The current runtime selects `wallet` only. The subscription columns preserve the
future ledger contract, but `subscription_funding_source_parity` remains a
production blocker and the user UI is fail-closed until all consuming surfaces
can use it safely.

## State machines

Submission and financial state are independent:

```text
submit_state:
  prepared -> submitting -> submitted
                        \-> rejected
                        \-> submit_unknown
  submit_unknown -> submitted/rejected (provider or operator evidence)

financial status:
  reserved -> attached -> settled
                      \-> refunded
  reserved -> refunded                  (provider call never started)
  reserved -> recovery_required         (submit result unknown)
  recovery_required -> attached          (later provider identity recovery)
```

Important invariants:

1. Insert plus wallet/token reserve is one D1 transaction.
2. `prepared -> submitting` commits before provider I/O.
3. A structured provider rejection on a `2xx` or `4xx` response atomically
   becomes `rejected + refunded`. A network error, `5xx`, redirect,
   unclassifiable provider response, missing accepted-task ID, or ambiguous
   attachment is `submit_unknown`; it is never auto-refunded and never blindly
   resubmitted.
4. Provider task insertion plus `attached` plus user/channel request accounting
   is one guarded D1 batch. A zero-row conditional statement forces batch abort.
5. Terminal task CAS plus `settled`/`refunded` is one guarded D1 batch. Refund
   triggers verify the original wallet/token targets still exist and allow the
   owned credit to reach those rows after soft deletion.
6. Zero-quota tasks still attach and account one successful submit exactly once.
7. Contract identity and pricing are immutable after reserve.
8. A channel with a non-terminal Task intent cannot be deleted, so an accepted
   provider task cannot lose the channel required for attachment or polling.

## Recovery policy

The scheduled handler scans expired pre-attachment intents:

| State | Automated action | Reason |
| --- | --- | --- |
| `reserved + prepared` | Refund original funding/token reserve | Provider I/O was never claimed |
| `reserved + rejected` | Refund original funding/token reserve | Provider rejection is confirmed |
| `reserved + submitting` | Move to `recovery_required + submit_unknown` | Provider may have accepted work |
| `recovery_required + submit_unknown` | No automatic refund or resubmit | Requires provider lookup or operator evidence |
| `attached` | Poll through task-family terminal CAS | Provider task ID is durable |
| `settled/refunded` | No-op | Financially final |

Midjourney also has a bounded D1 timeout sweep. Rows older than one hour and
not at `100%` transition through the same terminal CAS and refund path before
any provider poll, so a missing channel or permanently failing provider cannot
hold the reserve indefinitely.

Recovery output must retain only bounded errors and identifiers. Provider keys,
API tokens, raw request bodies, and media payloads are forbidden in the intent.

## Remaining production gates

`task_v2_cutover_ready` stays false until all of the following are proven:

- a shared generation-fenced D1 poll lease used by cron, TaskRunner DO, and any
  future Queue/Workflow dispatcher;
- provider-specific idempotency transmission or a deterministic lookup strategy
  for every enabled task family;
- automated or operator-assisted `submit_unknown` reconciliation with immutable
  evidence and no guess-based refund;
- fair task-family pagination, poison-task backoff, and persisted next-attempt;
- Suno and Midjourney TaskRunner policy parity;
- provider-terminal versus financial-terminal recovery/outbox coverage where
  final usage can differ from the reserve;
- checked 64-bit D1 binding for financial identifiers, quota, and timestamps;
- end-to-end FreeModel parity for HTTP, Realtime, additive settlement, and
  subscription funding; Task submit now delays only wallet admission after the
  frozen free-model decision;
- staging fault injection at every reserve/claim/provider/attach/terminal
  boundary, duplicate alarm/Queue replay, DO eviction, D1 ambiguity, and remote
  invoice reconciliation;
- rollback rehearsal, rotated credentials, monitoring, alerting, and signed
  production approval.

`task_runner_cutover_ready` describes only the DO fast path. It must never be
used as a substitute for Task v2 financial ownership readiness.

## Local verification

Required local gates include:

```text
python tools/verify_sqlite.py
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:web:readiness
bun run check
```

The SQLite verifier covers reserve, prepared and rejected refund,
unknown-submit protection, accepted-task attachment and refund after owner soft
deletion, active-channel deletion protection, single attachment accounting,
terminal refund/settle idempotency,
immutable contracts, and illegal transitions. These are local proofs only;
they do not replace remote D1, provider, Queue, browser, or invoice evidence.
