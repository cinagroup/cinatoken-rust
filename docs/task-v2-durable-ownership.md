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

## Submit-unknown operator reconciliation

Migrations `0032_task_submit_reconciliation.sql` and
`0033_task_submit_reconciliation_enforce.sql` add a revision-fenced operator
workflow for the case where provider acceptance is ambiguous. The public
contract is deliberately narrow:

- `GET /api/platform/task-billing/reconciliations` is root-only, paginated,
  `no-store`, and returns redacted ownership facts plus contract hashes;
- `POST .../:reconciliation_id/preview` is root-only and binds action, reason,
  provider identity, evidence digest, current revision, owner generation,
  quota, and both frozen contract hashes into one preview token;
- `POST .../:reconciliation_id/apply` additionally requires fresh secure
  verification, the exact preview token, an explicit confirmation, and a
  bounded idempotency key;
- attach accepts only provider-verified reasons and a validated provider task
  ID; refund accepts only provider-not-accepted or approved-refund reasons;
- event insertion, task attachment or refund, request accounting, intent
  transition, and root audit are one D1 batch. A stale revision or zero-row
  conditional mutation aborts the batch;
- the resolution event is immutable. Identical retries converge on canonical
  readback, while changed decisions, stale previews, and reused identities
  conflict instead of applying a second financial mutation.

Rows created before a frozen attach contract exists are explicitly
`legacy_refund_only`; an operator cannot synthesize a task from missing request
facts. The APIs never return `attach_contract_json`, raw billing JSON, user,
token, channel, reservation, operator, or resolution identities. They expose
only bounded public task/provider facts and SHA-256 digests.

The frozen attach contract currently retains fields needed to reconstruct a
Task or Midjourney row. This includes Midjourney prompt text and Task
username/group metadata. It is never emitted by the reconciliation API or
audit log, but production enablement still requires a reviewed D1 retention,
deletion, access, and incident-response policy for that content.

## Rolling migration contract

The schema change is expand then enforce, not a one-step deploy:

1. Stop reconciliation mutation and keep both Task reconciliation flags false.
2. Apply `0032`. Its compatibility trigger initializes reconciliation identity
   for a still-running 0031 Worker that quarantines an ambiguous submit.
3. Deploy the new Worker, verify exact object shape, and prove every Task writer
   stores both frozen contracts before provider I/O.
4. Drain Task submit traffic and all old Worker isolates. Confirm no new
   0031-era writer can create an intent.
5. Apply `0033`, which removes the compatibility trigger and rejects new rows
   without a valid non-empty attach contract.
6. Redeploy/read back the same candidate before any isolated operator drill.

After step 5, rollback to a 0031-era Worker is blocked by design. Rollback must
disable Task admission and reconciliation, preserve unresolved ownership, and
deploy a 0033-compatible candidate. It must never downgrade the schema or
blindly refund an ambiguous provider submission.

## Remaining production gates

`task_v2_cutover_ready` stays false until all of the following are proven:

- a shared generation-fenced D1 poll lease used by cron, TaskRunner DO, and any
  future Queue/Workflow dispatcher;
- provider-specific idempotency transmission or a deterministic lookup strategy
  for every enabled task family;
- provider-native idempotency or lookup automation for every task family; the
  operator workflow exists locally but still needs remote provider evidence;
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
immutable contracts, event-required operator resolution, atomic refund,
immutable reconciliation events, and illegal transitions. These are local proofs only;
they do not replace remote D1, provider, Queue, browser, or invoice evidence.
