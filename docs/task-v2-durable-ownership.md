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

## 2026-07-15 Current-Head Generation-Fenced Polling Overlay

This section supersedes only earlier statements that the shared poll lease is
not implemented. It does not rewrite the historical evidence above. Migrations
`0034_task_poll_lease.sql` and `0035_task_poll_lease_enforce.sql` provide a
local, default-inert ownership substrate for cron, the video `TaskRunner`
Durable Object, Suno polling, Midjourney polling, and timeout settlement.
Production remains **NO-GO** until the staged evidence and open gates below are
closed.

### Durable contract

Each Task or Midjourney claim writes a cryptographically generated owner, an
incremented `poll_generation`, and a bounded `poll_lease_expires_at`. Applying
progress, success, failure, refund, or timeout requires the same owner and
generation, a lease that is still strictly unexpired at apply time, and an
incremented `poll_write_revision`. A successful apply records
`poll_applied_generation` and clears the owner and expiry. A late response from
an expired or superseded generation therefore cannot mutate task or billing
state.

Migration defaults are deliberately inert:

- `0034` adds the columns, due indexes, and the singleton control row with both
  `authority_enabled=0` and `enforcement_enabled=0`;
- `0035` installs shape guards immediately, but those guards only constrain
  invalid transitions of the new lease fields. A 0033-compatible writer that
  does not touch those fields remains compatible while enforcement is off;
- the old-writer lifecycle guards are installed but do not reject legacy
  status/progress writes until `enforcement_enabled=1`;
- the scheduled poller and `TaskRunner` require both D1 authority and
  `TASK_POLL_LEASE_ENABLED=true`. Either authority being false keeps provider
  polling inert.

Capability interpretation is exact: `task_poll_lease_runtime_ready` means
compiled + schema-ready + Worker env authority + D1 authority.
`task_poll_lease_cutover_ready` additionally requires D1 old-writer
enforcement and reviewed staging evidence. Task v2 remains contract version 2
and its staging/cutover gates remain false until the broader fault campaign is
approved.
Operators must archive all lease fields from the capability response:
`task_poll_lease_contract_version`, `task_poll_lease_compiled`,
`task_poll_lease_schema_ready`, `task_poll_lease_enabled`,
`task_poll_lease_authority_enabled`,
`task_poll_lease_enforcement_enabled`, `task_poll_lease_runtime_ready`,
`task_poll_lease_staging_verified`, `task_poll_lease_cutover_ready`, and
`task_poller_poll_lease_seconds`.

### Family and timeout boundaries

Normal candidate selection is separated into three bounded families:

- video uses `tasks.platform != 'suno'` and may use cron or the video-only
  `TaskRunner` fast path;
- Suno uses `tasks.platform = 'suno'`, groups by channel, and is cron-only;
  Suno submission must not arm the video `TaskRunner`;
- Midjourney uses the `midjourneys` table and its own channel-batched cron
  poller and one-hour timeout sweep.

The generic Task timeout sweep may inspect both video and Suno rows, but it
must claim the same fenced lease before writing failure/refund. Midjourney
timeout does the same. Timeout is not an ownership bypass.

`TASK_POLL_LEASE_SECONDS` defaults to 120 and is clamped to 30-900 seconds.
The provider I/O budget is at most `min(90, remaining_lease - 15)`, with a
one-second floor. Vertex OAuth token exchange and task fetch share that one
deadline; channel-batch claim time is deducted before Suno or Midjourney fetch.
Provider timeout aborts the active fetch and releases the lease on a best-effort
basis; expiry remains the final recovery mechanism. The strict D1 apply
predicate checks both the fresh apply timestamp and D1 `unixepoch()`, so it is
the safety boundary even if abort, release, or a Worker clock is ambiguous.
Migration 0035 also rejects any lease-expiry extension that does not advance
the generation; this contract has no in-place renewal path.
Staging must still measure the complete claim/auth/fetch/parse/apply budget.

### Production activation order

1. Back up staging or production D1 and archive the exact migration ledger,
   object shape, candidate commit, Wrangler version, and capability snapshot.
2. Apply 0034 and 0035. Read back all columns, indexes, triggers, and the
   singleton control row. Both control flags must still be zero.
3. Deploy the 0035-aware Worker at 100 percent with
   `TASK_POLL_LEASE_ENABLED=false`, `TASK_POLL_LEASE_STAGING_VERIFIED=false`,
   and `TASK_RUNNER_DO_ENABLED=false`. Prove task polling is inert.
4. Stop legacy Go/Worker task polling, old cron ownership, TaskRunner arming,
   and in-flight alarm/provider work. Wait at least the maximum configured
   lease plus provider/network margin, then prove no old task lifecycle writer
   remains.
5. Set D1 `authority_enabled=1` and read it back. Env authority is still false,
   so no provider poll may start.
6. Set D1 `enforcement_enabled=1` and read it back. Prove a 0033-style
   lifecycle write is rejected while a fenced write succeeds.
7. Enable `TASK_POLL_LEASE_ENABLED=true` only on the isolated candidate. Keep
   `TASK_RUNNER_DO_ENABLED=false`; start cron family canaries first.
8. Run duplicate cron, cron-versus-timeout, stale-generation, expiry takeover,
   D1 ambiguity, provider timeout, partial batch, and invoice reconciliation
   tests. Only after reviewed evidence may
   `TASK_POLL_LEASE_STAGING_VERIFIED=true` be shipped in a new candidate.
9. Enable the video `TaskRunner` only after cron evidence passes, then exercise
   duplicate alarms, replacement schedules, eviction, replay, and cron
   fallback. Suno and Midjourney remain on their separate cron paths.

### Rollback order

1. Set `TASK_POLL_LEASE_ENABLED=false` first and disable TaskRunner arming.
2. Set D1 `authority_enabled=0`; verify no new claim can be admitted.
3. Set D1 `enforcement_enabled=0`; only now may a compatible old lifecycle
   writer resume.
4. Wait for or deliberately drain every active lease, recording owner hashes,
   generations, expiries, and unresolved provider operations without secrets.
5. Roll traffic back only to a 0033-compatible Worker. Never roll back to a
   0031-era writer, downgrade D1, decrement a generation, or clear a lease
   without matching its owner and generation.

### Still-blocking work

The lease closes stale local result application, not the whole production
problem. Migration 0036 supplies the local persisted scheduler shape, but no
staging, remote D1, deployment, provider, or rollback evidence is claimed.
Provider-operation uniqueness or native idempotency/lookup, duplicate-submit
reconciliation, a complete provider operation deadline, remote D1 ambiguity
and fault injection at every boundary, provider invoice reconciliation,
alert/load evidence, credential rotation, and signed rollback approval remain
blocking.

## Persisted Scheduler Ownership

The Task v2 ownership hierarchy is strict:

1. D1 0036 fields own due time, retry state, poison quarantine, and the five
   family cursors. D1 0034/0035 fields own poll admission and stale-result
   fencing. D1 terminal batches remain the only lifecycle/billing authority.
2. The scheduled Worker runs both timeout sweeps first, then rotates exactly one
   normal family per minute slot: video, Suno, Midjourney. The selected family
   is capped at eight candidates. Each cursor freezes a round high-watermark and
   advances only after a successful lease claim; ambiguity may repeat work but
   may never authorize provider I/O before `next_poll_at`.
3. `TaskRunner` is an optional video wake-up accelerator. Its alarm and
   `schedule_generation` cannot make a row due, clear quarantine, update a
   family cursor, or replace D1 `poll_generation`. Suno and Midjourney remain
   outside the video DO path.
4. Providers are observations, not authority. A transport failure schedules
   capped exponential backoff with deterministic task/generation jitter; the
   eighth consecutive retryable failure quarantines by default. Quarantine has
   no financial side effect. Unsupported providers, invalid provider task
   identity, and deterministically invalid credentials quarantine immediately;
   network/upstream/missing-item failures still use the threshold. Migration
   0037 provides the reviewed local release/requeue shape, while remote and
   provider evidence remain production blockers.

The scheduler gate is subordinate to all three lease prerequisites: Worker
lease gate true, D1 authority true, and D1 enforcement true. Rollout is
0034 -> 0035 -> 0036, disabled compatible deploy, old-writer drain, lease proof,
isolated scheduler canary, independent evidence review, then a new verified
staging candidate. Rollback disables scheduler and DO wake-ups before touching
lease authority, retains additive schema/state, and reconciles quarantine
before Go/VPS resumes. Go/VPS remains authoritative; production is **NO-GO**.

## Audited Poll Recovery Ownership

Migration `0037_task_poll_recovery.sql` adds the recovery authority that the
0036 scheduler depends on. The scheduler may be runtime-tested while its
staging flag is false, but `task_poll_scheduler_cutover_ready` must remain
false until `task_poll_recovery_cutover_ready` is true. Both recovery env vars
are committed false:

```text
TASK_POLL_RECOVERY_ENABLED=false
TASK_POLL_RECOVERY_STAGING_VERIFIED=false
```

Recovery is an operator command, not a terminal provider or billing decision.
Queue and preview require root and return no-store metadata. Apply additionally
requires fresh step-up, an exact preview token, explicit requeue confirmation,
a bounded idempotency key, an approved reason, and an evidence reference. The
API returns `task_reference` plus `public_task_id_sha256`; a Midjourney provider
ID is not returned.

The D1 insert is the final fence. It atomically writes an immutable recovery
event and root audit while triggers verify the private provider identity,
generation, write revision, quarantine timestamp/reason, empty owner, zero
lease expiry, nonterminal state, and a valid hard-timeout window. All digest
and token columns require lowercase hex. A unique entity/revision index limits
each revision to one recovery event. Exact partial indexes include only open,
provider-identified quarantine rows.

Queue and preview publish `hard_timeout_at`, `timeout_eligible`, and a recovery
margin of at least 60 seconds and at least one poll lease. Apply returns `409`
for stale/conflicting operator state and blocks expired or near-timeout rows.
D1, audit-batch, or canonical readback uncertainty returns `503`. Identical
idempotent replay converges to canonical event readback.

The first successful Task requeue may best-effort arm TaskRunner after commit.
That is a latency hint only: an arm error cannot undo the recovery and cron
continues to discover the D1-due row. Midjourney remains cron-owned.

The verified local SQLite baseline is 37 migrations, 35 tables, 241 checked
incremental columns, and 42 key indexes. Workerd must cover step-up, apply,
duplicate, stale preview, timeout margin, immutable audit, and best-effort
rearm behavior. Provider operation uniqueness/native idempotency, a deadline
covering the complete submit operation, remote D1/staging/provider/TaskRunner
hot paths, WFP namespace upload/readback, paid canary, and signed rollback are
still hard blockers.

Rollback order is recovery off, scheduler and TaskRunner off, lease env
authority off, D1 authority off, then D1 enforcement off. Drain leases and
reconcile accepted provider work. Every quarantine must be resolved, held out,
or explicitly excluded before Go/VPS resumes. Production remains **NO-GO**.
