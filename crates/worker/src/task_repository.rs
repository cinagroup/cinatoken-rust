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
/// `0001_core.sql` defaults.
pub struct NewTask<'a> {
    pub task_id: &'a str,
    pub upstream_task_id: &'a str,
    pub platform: &'a str,
    pub user_id: i64,
    pub username: &'a str,
    pub group: &'a str,
    pub channel_id: i64,
    /// The reserving token — persisted in `private_data` (Go
    /// `TaskPrivateData.TokenId`, "令牌 ID，用于令牌额度退款") so a failed task's
    /// reserve can be refunded to the token, not just the user.
    pub token_id: i64,
    pub quota: i64,
    pub action: &'a str,
    pub status: TaskStatus,
    pub submit_time: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Go `Task.Properties`: model metadata carried to DTO conversion and
    /// OpenAI-compatible video responses.
    pub properties: &'a str,
    /// Raw provider response data persisted as Go `Task.Data`. Upstream task
    /// providers return JSON today; callers pass `{}` for flows that do not
    /// have provider data yet.
    pub data: &'a str,
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
    /// Reserving token id, read back from `private_data` (0 for legacy rows that
    /// predate token-id persistence). Drives the token-quota refund on failure.
    #[serde(default)]
    pub token_id: i64,
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
    // Persist the reserving token id in private_data (Go `TaskPrivateData`), so
    // the poller can refund the token on failure. Keep the upstream id there as
    // well for source DTO compatibility; the dedicated column remains the Rust
    // fast path.
    let private_data = serde_json::json!({
        "token_id": task.token_id,
        "upstream_task_id": task.upstream_task_id,
    })
    .to_string();
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
        D1Type::Text(task.properties),
        D1Type::Text(&private_data),
        D1Type::Text(task.data),
    ];
    db.prepare(
        r#"
        INSERT INTO tasks
          (task_id, upstream_task_id, platform, user_id, username, "group",
           channel_id, quota, action, status, submit_time, created_at, updated_at,
           properties, private_data, data)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
               COALESCE(json_extract(private_data, '$.token_id'), 0) AS token_id,
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
               COALESCE(json_extract(private_data, '$.token_id'), 0) AS token_id,
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
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
) -> worker::Result<bool> {
    let should_update_data = if result_data.is_some() { 1 } else { 0 };
    let result_data = result_data.unwrap_or("");
    let args = [
        D1Type::Text(to.as_str()),
        D1Type::Text(fail_reason),
        D1Type::Text(progress),
        D1Type::Text(result_url),
        D1Type::Text(result_data),
        D1Type::Integer(should_update_data),
        D1Type::Integer(d1_i32(finish_time)),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(from.as_str()),
    ];
    // `json_set` merges the result URL into private_data (Go
    // `Task.PrivateData.ResultURL`) without clobbering the reserving token_id
    // stored there at insert. An empty URL is written as-is (fetch falls back
    // to fail_reason, matching Go `GetResultURL`).
    let result = db
        .prepare(
            r#"
            UPDATE tasks
            SET status = ?1, fail_reason = ?2, progress = ?3,
                private_data = json_set(private_data, '$.result_url', ?4),
                data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
                finish_time = ?7, updated_at = ?8
            WHERE id = ?9 AND status = ?10
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

/// A full task row for the client-facing fetch endpoints (Go `dto.TaskDto`
/// source fields). Distinct from the poller's lean [`TaskRow`].
#[derive(Debug, serde::Deserialize)]
pub struct TaskDtoRow {
    pub id: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub group: String,
    pub channel_id: i64,
    pub quota: i64,
    pub action: String,
    pub status: String,
    pub fail_reason: String,
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub progress: String,
    pub properties: String,
    pub username: String,
    pub data: String,
    pub private_data: String,
}

const TASK_DTO_COLUMNS: &str = r#"id, created_at, updated_at, task_id, platform, user_id,
    "group" AS "group", channel_id, quota, action, status, fail_reason,
    submit_time, start_time, finish_time, progress, properties, username, data,
    private_data"#;

/// One task by public task id, scoped to its owner (Go `GetByTaskId`).
pub async fn find_task_dto(
    db: &D1Database,
    user_id: i64,
    task_id: &str,
) -> worker::Result<Option<TaskDtoRow>> {
    let args = [D1Type::Integer(d1_i32(user_id)), D1Type::Text(task_id)];
    db.prepare(&format!(
        "SELECT {TASK_DTO_COLUMNS} FROM tasks WHERE user_id = ?1 AND task_id = ?2 LIMIT 1"
    ))
    .bind_refs(&args)?
    .first::<TaskDtoRow>(None)
    .await
}

/// The owner's tasks matching a set of public task ids (Go `GetByTaskIds`).
/// Chunked IN-list; order unspecified (Go's is too).
pub async fn find_task_dtos(
    db: &D1Database,
    user_id: i64,
    task_ids: &[String],
) -> worker::Result<Vec<TaskDtoRow>> {
    let mut rows = Vec::new();
    for chunk in task_ids.chunks(50) {
        let mut args: Vec<D1Type<'_>> = vec![D1Type::Integer(d1_i32(user_id))];
        for task_id in chunk {
            args.push(D1Type::Text(task_id));
        }
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let sql = format!(
            "SELECT {TASK_DTO_COLUMNS} FROM tasks WHERE user_id = ?1 AND task_id IN ({})",
            placeholders.join(", ")
        );
        rows.extend(
            db.prepare(&sql)
                .bind_refs(&args)?
                .all()
                .await?
                .results::<TaskDtoRow>()?,
        );
    }
    Ok(rows)
}

/// Filters shared by the admin (`GET /api/task`) and self (`GET /api/task/self`)
/// usage-log pages.
#[derive(Debug, Default)]
pub struct TaskListFilter {
    pub user_id: Option<i64>,
    pub channel_id: Option<i64>,
    pub platform: Option<String>,
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub action: Option<String>,
    pub start_timestamp: Option<String>,
    pub end_timestamp: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

/// List unified task rows for the dashboard usage-log tables. Mirrors Go
/// `TaskGetAllTasks` / `TaskGetAllUserTask`: optional platform/task/action/
/// status/time filters, admin-only channel filter, ordered newest first.
pub async fn list_tasks(
    db: &D1Database,
    filter: &TaskListFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<TaskDtoRow>> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = task_where_clause(filter, &mut args);
    let limit_idx = args.len() + 1;
    let offset_idx = args.len() + 2;
    let offset = ((page.max(1) - 1) as i64) * page_size as i64;
    args.push(D1Type::Integer(d1_i32(page_size as i64)));
    args.push(D1Type::Integer(d1_i32(offset)));
    let sql = format!(
        "SELECT {TASK_DTO_COLUMNS} FROM tasks{where_sql} ORDER BY id DESC LIMIT ?{limit_idx} OFFSET ?{offset_idx}"
    );
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TaskDtoRow>()
}

/// Count unified task rows matching the usage-log filters.
pub async fn count_tasks(db: &D1Database, filter: &TaskListFilter) -> worker::Result<i64> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = task_where_clause(filter, &mut args);
    let sql = format!("SELECT COUNT(*) AS count FROM tasks{where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

fn task_where_clause<'a>(filter: &'a TaskListFilter, args: &mut Vec<D1Type<'a>>) -> String {
    let mut conditions = Vec::new();
    if let Some(user_id) = filter.user_id {
        args.push(D1Type::Integer(d1_i32(user_id)));
        conditions.push(format!("user_id = ?{}", args.len()));
    }
    if let Some(channel_id) = filter.channel_id {
        args.push(D1Type::Integer(d1_i32(channel_id)));
        conditions.push(format!("channel_id = ?{}", args.len()));
    }
    if let Some(platform) = filter.platform.as_deref() {
        args.push(D1Type::Text(platform));
        conditions.push(format!("platform = ?{}", args.len()));
    }
    if let Some(task_id) = filter.task_id.as_deref() {
        args.push(D1Type::Text(task_id));
        conditions.push(format!("task_id = ?{}", args.len()));
    }
    if let Some(status) = filter.status.as_deref() {
        args.push(D1Type::Text(status));
        conditions.push(format!("status = ?{}", args.len()));
    }
    if let Some(action) = filter.action.as_deref() {
        args.push(D1Type::Text(action));
        conditions.push(format!("action = ?{}", args.len()));
    }
    if let Some(start) = filter.start_timestamp.as_deref() {
        args.push(D1Type::Text(start));
        conditions.push(format!("submit_time >= ?{}", args.len()));
    }
    if let Some(end) = filter.end_timestamp.as_deref() {
        args.push(D1Type::Text(end));
        conditions.push(format!("submit_time <= ?{}", args.len()));
    }
    if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    }
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
    result_data: Option<&str>,
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
        &info.url,
        result_data,
        finish_time,
        now,
    )
    .await?;
    if won && matches!(settlement_for(from, info.status), TaskSettlement::Refund) {
        // Go RefundTaskQuota refunds BOTH the user funding and the reserving
        // token; the reserve debited both, so the refund must credit both.
        crate::d1_repositories::increase_user_quota(db, task.user_id, task.quota).await?;
        crate::d1_repositories::refund_task_token_quota(db, task.token_id, task.quota, now).await?;
    }
    Ok(won)
}

/// Apply one Suno batch-poll item to a stored task — a port of the per-item merge
/// in Go `updateSunoTasks`. The upstream status (empty keeps the current one,
/// Go's `lo.If(!= "")`) is CAS-applied; the progress is pinned to `100%` on
/// success or failure; and the reserve is refunded when the item is a failure
/// (`fail_reason` set **or** status `FAILURE`) and this caller wins a transition
/// out of a non-terminal state — so the CAS guard makes the refund happen once.
///
/// Simplification vs Go: submit/start times and the `data` blob aren't merged
/// here (display-only); the status/progress/fail-reason/finish-time + refund —
/// the billing-critical core — are. Returns whether this caller won the CAS.
pub async fn apply_suno_poll_result(
    db: &D1Database,
    task: &TaskRow,
    item_status: &str,
    item_fail_reason: &str,
    now: i64,
) -> worker::Result<bool> {
    let from = task.status();
    let to = if item_status.is_empty() {
        from
    } else {
        TaskStatus::from_status_str(item_status)
    };
    let is_failure = !item_fail_reason.is_empty() || to == TaskStatus::Failure;
    let progress = if is_failure || to == TaskStatus::Success {
        "100%"
    } else {
        ""
    };
    let finish_time = if is_failure || to.is_terminal() {
        now
    } else {
        0
    };

    let won = update_task_status_cas(
        db,
        task.id,
        from,
        to,
        item_fail_reason,
        progress,
        "",
        None,
        finish_time,
        now,
    )
    .await?;
    if won && is_failure && !from.is_terminal() {
        // Refund both user funding and the reserving token (Go RefundTaskQuota).
        crate::d1_repositories::increase_user_quota(db, task.user_id, task.quota).await?;
        crate::d1_repositories::refund_task_token_quota(db, task.token_id, task.quota, now).await?;
    }
    Ok(won)
}
