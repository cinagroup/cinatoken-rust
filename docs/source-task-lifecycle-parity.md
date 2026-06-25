# Source Async Task Lifecycle Parity (G7)

Date: 2026-06-25

Status: canonical, source-derived specification of the Go async media-task
framework (Midjourney/Suno/video/image): submit -> poll -> settle, with the
three billing hooks and CAS idempotency. This is the G7 long-tail surface. The
Go design uses a persistent polling loop that does not fit the Worker model;
this doc maps it to the Cloudflare-native path (Workflows/Queue/R2/Cron) from
migration-plan §21.5 and pins the idempotency rules that prevent double-refund.

## Source Of Truth

- `relay/channel/adapter.go` — `TaskAdaptor` interface (3 billing hooks +
  submit/poll methods), `OpenAIVideoConverter`.
- `relay/relay_task.go` — `RelayTaskSubmit`, `RelayTaskFetch`,
  `recalcQuotaFromRatios`, `TaskModel2Dto`.
- `service/task_polling.go` — `TaskPollingLoop`, `sweepTimedOutTasks`,
  `DispatchPlatformUpdate`, `updateVideoSingleTask`,
  `settleTaskBillingOnComplete`.
- `model/task.go` — `Task`, `TaskStatus`, `UpdateWithStatus` (CAS),
  `GetTimedOutUnfinishedTasks`.

## Task Model And Statuses

`Task`: public `TaskID` (returned to client), `upstream_task_id` (for polling),
`platform`, `channel_id`, `quota`, `action`, `status`, `progress`,
`fail_reason`, `submit/start/finish_time`, `properties`/`private_data`/`data`
(JSON). Statuses: `NOT_START -> SUBMITTED -> QUEUED -> IN_PROGRESS ->
SUCCESS | FAILURE | UNKNOWN`.

## Submit (`RelayTaskSubmit`, 11 steps)

1. Resolve platform -> `GetTaskAdaptor` -> `Init`.
2. `ValidateRequestAndSetAction`.
3. Resolve model name; apply channel model mapping.
4. Generate **public task id** (first attempt only).
5. Base price (`ModelPriceHelperPerCall`).
6. **`EstimateBilling`** -> OtherRatios (e.g. `{seconds:5, size:1.666}`).
7. Apply ratios to base quota (`quota *= ratio`, unless model in
   `TaskPricePatches`).
8. **Pre-consume (first attempt only)** — skipped when `info.Billing` already
   exists (retry) or the model is free. Idempotent reservation.
9. Build + do upstream request.
10. `DoResponse` -> `upstreamTaskID`, `taskData`.
11. **`AdjustBillingOnSubmit`** -> if upstream returned different actual params,
    recalc quota and settle the delta vs the pre-charge.

The caller persists the `Task` row (status `SUBMITTED`) and returns the public
task id immediately.

## Poll + Settle (`TaskPollingLoop`)

A persistent loop: every 15s -> `sweepTimedOutTasks` -> `GetAllUnFinishSyncTasks`
-> group by platform -> `DispatchPlatformUpdate` (Suno / video / MJ) -> per
channel batch `FetchTask` -> `ParseTaskResult` -> update task status/progress/
result -> on terminal, `settleTaskBillingOnComplete`.

- **Null upstream id** -> mark `FAILURE`.
- **`sweepTimedOutTasks`**: tasks unfinished past `TaskTimeoutMinutes` ->
  CAS to `FAILURE` + `RefundTaskQuota` (legacy tasks before 2026-02-22 are not
  refunded).
- **Per-channel batching** (`taskChannelM`) respects provider grouping/limits.
- **Large results** are stored in `task.Data` with `redactVideoResponseBody` /
  `truncateBase64` (results can be big base64 blobs).

`settleTaskBillingOnComplete`:

1. Per-call-billing tasks skip delta settlement.
2. else `AdjustBillingOnComplete(task, result)` > 0 -> `RecalculateTaskQuota`.
3. else `TotalTokens` > 0 -> `RecalculateTaskQuotaByTokens`.
4. else keep the pre-charged amount.

## CAS Idempotency (the double-refund guard)

`task.UpdateWithStatus(oldStatus)` is a compare-and-swap:
`UPDATE tasks SET ... WHERE id=? AND status=<old>`; the boolean `won` is true
only if this caller performed the transition. **Refund/settle happens only on a
won CAS.** This prevents two pollers (or two Workflow step retries) from
double-failing or double-refunding the same task.

## Three Billing Hooks (idempotent across retries)

| Hook | When | Effect |
| --- | --- | --- |
| `EstimateBilling` | pre-charge (submit) | request-derived ratios (duration/resolution) |
| `AdjustBillingOnSubmit` | after upstream submit | delta vs estimate from actual upstream params |
| `AdjustBillingOnComplete` | terminal during polling | actual quota -> supplement/refund delta |

Pre-consume is reserved once at submit; the two adjust hooks settle deltas. All
three must be idempotent across retries (keyed to the task + stage), or a
Workflow re-run double-charges.

## Cloudflare Mapping (validates migration-plan §21.5)

The Go design is incompatible with the Worker model and must be re-shaped:

1. **No persistent 15s loop in a Worker.** Replace `TaskPollingLoop` with one of:
   - **Workflows (recommended, §21.5):** one Workflow instance per media task;
     poll upstream with `step.sleep`/`sleepUntil`; persist state per step;
     `sleepUntil(submit + TaskTimeoutMinutes)` enforces the timeout; settle on
     terminal. Durable, retryable, and idempotent by design.
   - **Cron Trigger + Queue:** a Cron periodically enqueues unfinished tasks; a
     Queue consumer polls and updates. Simpler but coarser than per-task sleep.
2. **CAS -> D1 conditional update + rows-affected** (same pattern as
   `docs/source-payment-idempotency-parity.md`): `UPDATE tasks SET status=...
   WHERE id=? AND status=?`; refund/settle only when 1 row was affected. This is
   the critical guard under Workflow step retries.
3. **Large results -> R2.** Do not store base64 video/image blobs in D1; write to
   R2 and keep a pointer. Optionally re-host external upstream URLs in R2 to
   survive upstream expiry (migration-plan §7.10).
4. **`sweepTimedOutTasks` -> Cron Trigger** (or per-task `sleepUntil`): CAS
   timed-out tasks to `FAILURE` and refund once; preserve the legacy-task
   no-refund cutoff.
5. **Per-channel batched polling** -> respect provider rate limits and the
   Rate Limiting binding (§21.1).
6. **Three-stage billing idempotency** must survive Workflow retries; key each
   settle to (task id, stage) so a replay cannot double-charge or double-refund.

## Rust Status And Checklist

Per the matrices, async tasks/media are `Planned`/G7 (D1 `tasks` table exists in
`0001_core.sql`). Checklist:

1. Decide the orchestrator (Workflows recommended) and stand up one instance per
   task with durable poll/sleep/timeout.
2. Port the `TaskAdaptor` surface: validate/build/do/parse + the three billing
   hooks; per-provider adapters in risk-ranked waves (Suno, video, MJ).
3. Implement CAS status transitions in D1 with rows-affected branching; refund/
   settle only on the won transition.
4. Store artifacts in R2; keep `task.data` small (pointer/metadata).
5. Implement timeout sweep (Cron or `sleepUntil`) with the legacy no-refund rule.
6. Make all three billing stages idempotent; add replay tests proving no
   double-charge / double-refund across retries.
7. Return the public task id immediately at submit; expose
   fetch/status routes (`/v1/video/generations/:id`, `/suno/fetch/:id`, etc.).

## Wire-In

- `docs/production-readiness-matrices.md` task/media route rows and the
  `Midjourney`/`Task` table row reference this file.
- `docs/data-migration-runbook.md` Wave 5 (async/media) consumes the task model.
- Billing hooks tie to `docs/source-billing-expr-parity.md` and
  `docs/source-payment-idempotency-parity.md` (CAS idempotency pattern).
- Orchestration/storage follow migration-plan §21.5 (Workflows/Queue) and §7.10
  (R2 artifacts).
