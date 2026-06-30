//! D1-backed task lifecycle repository.
//!
//! Ports the persistence half of Go `model.Task` (`model/task.go`) against the
//! `tasks` table from `migrations/d1/0001_core.sql`. The correctness core is
//! [`update_task_status_cas`], a faithful port of Go `Task.UpdateWithStatus`: a
//! status transition is a conditional UPDATE guarded by the *current* status, so
//! exactly one caller can move a task out of a given state. That guard is what
//! makes settlement idempotent — a task can only be billed or refunded by the
//! caller that wins the transition into a terminal state (item 4.2).
//!
//! Provider-independent: every async-task platform (Suno, Midjourney, video, …)
//! shares this lifecycle, so this layer carries no provider-specific logic.
//!
//! Foundation ahead of the task orchestration that will consume it; allowed to
//! be dead code until then, mirroring [`crate::flow_state`].
#![allow(dead_code)]

use cinatoken_relay::clamp_i64_to_i32 as d1_i32;
use cinatoken_tasks::{build_task_id, settlement_for, TaskInfo, TaskSettlement, TaskStatus};
use serde::Deserialize;
use worker::{D1Database, D1Type};

/// Generate a public task id — `"task_"` + 32 CSPRNG characters, the Worker
/// (wasm) half of Go `GenerateTaskID`. Bytes come from `getrandom` (Web Crypto)
/// and are rejection-sampled to a uniform `[0, 62)` (rejecting the biased tail
/// `>= 248 = 62*4`) before mapping through [`build_task_id`], so the alphabet is
/// drawn without modulo bias, matching Go's `crand.Int`.
pub fn generate_task_id() -> String {
    let mut indices: Vec<u8> = Vec::with_capacity(32);
    let mut buffer = [0u8; 64];
    while indices.len() < 32 {
        if getrandom::getrandom(&mut buffer).is_err() {
            break;
        }
        for &byte in &buffer {
            if indices.len() >= 32 {
                break;
            }
            if byte < 248 {
                indices.push(byte % 62);
            }
        }
    }
    build_task_id(&indices)
}

/// The fields needed to create a task row. Columns not listed take their
/// `0001_core.sql` defaults (`properties`/`private_data`/`data` = `{}`, etc.).
pub struct NewTask<'a> {
    pub task_id: &'a str,
    pub upstream_task_id: &'a str,
    pub platform: &'a str,
    pub user_id: i64,
    pub username: &'a str,
    pub group: &'a str,
    pub channel_id: i64,
    pub quota: i64,
    pub action: &'a str,
    pub status: TaskStatus,
    pub submit_time: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A task row as read back from D1. `status` is parsed via
/// [`TaskStatus::from_status_str`] (unknown → `Unknown`, Go's fallback).
#[derive(Debug, Deserialize)]
pub struct TaskRow {
    pub id: i64,
    pub task_id: String,
    pub upstream_task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub quota: i64,
    pub action: String,
    pub status: String,
    pub fail_reason: String,
    pub progress: String,
    pub finish_time: i64,
}

impl TaskRow {
    /// The parsed lifecycle status.
    pub fn status(&self) -> TaskStatus {
        TaskStatus::from_status_str(&self.status)
    }
}

/// Insert a new task (Go `Task.Insert`). The unique `task_id` enforces that a
/// given public task is created once.
pub async fn insert_task(db: &D1Database, task: &NewTask<'_>) -> worker::Result<()> {
    let args = [
        D1Type::Text(task.task_id),
        D1Type::Text(task.upstream_task_id),
        D1Type::Text(task.platform),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Text(task.username),
        D1Type::Text(task.group),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Text(task.action),
        D1Type::Text(task.status.as_str()),
        D1Type::Integer(d1_i32(task.submit_time)),
        D1Type::Integer(d1_i32(task.created_at)),
        D1Type::Integer(d1_i32(task.updated_at)),
    ];
    db.prepare(
        r#"
        INSERT INTO tasks
          (task_id, upstream_task_id, platform, user_id, username, "group",
           channel_id, quota, action, status, submit_time, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await
    .map(|_| ())
}

/// Load unfinished tasks for the poller — rows not yet in a terminal status that
/// carry an upstream id to poll (Go's "未完成的任务" selection). Bounded by
/// `limit` and ordered by id so a batch is deterministic.
pub async fn find_unfinished_tasks(db: &D1Database, limit: i64) -> worker::Result<Vec<TaskRow>> {
    let arg = D1Type::Integer(d1_i32(limit));
    db.prepare(
        r#"
        SELECT id, task_id, upstream_task_id, platform, user_id, channel_id,
               quota, action, status, fail_reason, progress, finish_time
        FROM tasks
        WHERE status NOT IN ('SUCCESS', 'FAILURE')
          AND upstream_task_id != ''
        ORDER BY id ASC
        LIMIT ?1
        "#,
    )
    .bind_refs(&arg)?
    .all()
    .await?
    .results::<TaskRow>()
}

/// Look up a task by its public `task_id` (Go `GetTaskByTaskId`).
pub async fn find_task_by_task_id(
    db: &D1Database,
    task_id: &str,
) -> worker::Result<Option<TaskRow>> {
    let arg = D1Type::Text(task_id);
    db.prepare(
        r#"
        SELECT id, task_id, upstream_task_id, platform, user_id, channel_id,
               quota, action, status, fail_reason, progress, finish_time
        FROM tasks
        WHERE task_id = ?1
        LIMIT 1
        "#,
    )
    .bind_refs(&arg)?
    .first::<TaskRow>(None)
    .await
}

/// Conditional status transition guarded by the current status — a faithful
/// port of Go `Task.UpdateWithStatus(fromStatus)`.
///
/// Returns `Ok(true)` if this caller won (the row was in `from` and is now in
/// `to`), `Ok(false)` if another process already moved it out of `from`. The
/// guard makes the win unique, which is what callers rely on to settle billing
/// exactly once. Callers should treat a `false` return as "someone else already
/// transitioned this task" and skip the associated billing/refund side effect.
pub async fn update_task_status_cas(
    db: &D1Database,
    id: i64,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    finish_time: i64,
    updated_at: i64,
) -> worker::Result<bool> {
    let args = [
        D1Type::Text(to.as_str()),
        D1Type::Text(fail_reason),
        D1Type::Text(progress),
        D1Type::Integer(d1_i32(finish_time)),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(from.as_str()),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE tasks
            SET status = ?1, fail_reason = ?2, progress = ?3,
                finish_time = ?4, updated_at = ?5
            WHERE id = ?6 AND status = ?7
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

// The pure settlement-detection guard a caller pairs with a CAS win lives in
// `cinatoken_tasks::is_settlement_transition` (host-tested there, since this
// wasm-only crate cannot run host unit tests).

/// Apply a parsed upstream poll result to a stored task: CAS its status from the
/// current value to the parsed one and, on a winning settlement transition,
/// refund the reserved quota for a terminal failure (Go `RefundTaskQuota`) or
/// keep the pre-charge for a success. Returns whether this caller won the
/// transition, so the orchestration knows it owns any one-time side effects.
///
/// The CAS guard makes this idempotent: a concurrent poller that already settled
/// the task wins the transition, and this call becomes a no-op that performs no
/// second refund. The pure decision (`settlement_for`) and the CAS semantics are
/// unit-tested in `cinatoken_tasks`; this function is the thin wasm I/O that
/// wires them to the D1 quota helpers and is verified by a staging poll.
pub async fn apply_poll_result(
    db: &D1Database,
    task: &TaskRow,
    info: &TaskInfo,
    finish_time: i64,
    now: i64,
) -> worker::Result<bool> {
    let from = task.status();
    let won = update_task_status_cas(
        db,
        task.id,
        from,
        info.status,
        &info.reason,
        &info.progress,
        finish_time,
        now,
    )
    .await?;
    if won && matches!(settlement_for(from, info.status), TaskSettlement::Refund) {
        crate::d1_repositories::increase_user_quota(db, task.user_id, task.quota).await?;
    }
    Ok(won)
}
