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

pub(crate) const LEGACY_TASK_TIMEOUT_CUTOFF_UNIX: i64 = 1_740_182_400;
const LEGACY_TASK_TIMEOUT_REASON: &str = "任务超时（旧系统遗留任务，不进行退款，请联系管理员）";
const TASK_REFUND_MARKER_PATH: &str = "$.task_refund_marker";
const TASK_REFUND_DONE_AT_PATH: &str = "$.task_refund_done_at";

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
    pub submit_time: i64,
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
               quota, action, status, fail_reason, progress, finish_time,
               submit_time
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

/// Load unfinished tasks that have exceeded the configured async-task timeout
/// window (Go `GetTimedOutUnfinishedTasks`). This runs before the normal poller
/// so a backlog of permanently stuck tasks cannot hide newer rows behind the
/// bounded poll window.
pub async fn find_timed_out_unfinished_tasks(
    db: &D1Database,
    cutoff_unix: i64,
    limit: i64,
) -> worker::Result<Vec<TaskRow>> {
    let args = [
        D1Type::Integer(d1_i32(cutoff_unix)),
        D1Type::Integer(d1_i32(limit)),
    ];
    db.prepare(
        r#"
        SELECT id, task_id, upstream_task_id, platform, user_id, channel_id,
               COALESCE(json_extract(private_data, '$.token_id'), 0) AS token_id,
               quota, action, status, fail_reason, progress, finish_time,
               submit_time
        FROM tasks
        WHERE progress != '100%'
          AND status NOT IN ('SUCCESS', 'FAILURE')
          AND submit_time < ?1
        ORDER BY submit_time ASC
        LIMIT ?2
        "#,
    )
    .bind_refs(&args)?
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
               quota, action, status, fail_reason, progress, finish_time,
               submit_time
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
                private_data = json_set(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.result_url',
                    ?4
                ),
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

fn update_task_status_cas_with_refund_marker_statement(
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
    refund_marker: &str,
) -> worker::Result<worker::D1PreparedStatement> {
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
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE tasks
        SET status = ?1, fail_reason = ?2, progress = ?3,
            private_data = json_set(
                CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                '$.result_url',
                ?4,
                '$.task_refund_marker',
                ?11,
                '$.task_refund_done_at',
                NULL
            ),
            data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
            finish_time = ?7, updated_at = ?8
        WHERE id = ?9 AND status = ?10
        "#,
    )
    .bind_refs(&args)
}

fn credit_user_task_refund_statement(
    db: &D1Database,
    task_id: i64,
    user_id: i64,
    quota: i32,
    refund_marker: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota + ?1
        WHERE id = ?2
          AND EXISTS (
              SELECT 1 FROM tasks
              WHERE id = ?3
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_marker'
                ) = ?4
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_done_at'
                ) IS NULL
          )
        "#,
    )
    .bind_refs(&args)
}

fn credit_token_task_refund_statement(
    db: &D1Database,
    task_id: i64,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
    refund_marker: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            accessed_time = ?2
        WHERE id = ?3
          AND EXISTS (
              SELECT 1 FROM tasks
              WHERE id = ?4
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_marker'
                ) = ?5
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_done_at'
                ) IS NULL
          )
        "#,
    )
    .bind_refs(&args)
}

fn mark_task_refund_done_statement(
    db: &D1Database,
    task_id: i64,
    refund_marker: &str,
    done_at: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(d1_i32(done_at)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE tasks
        SET private_data = json_set(
            CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
            '$.task_refund_done_at',
            ?1
        )
        WHERE id = ?2
          AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_marker'
          ) = ?3
          AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_done_at'
          ) IS NULL
        "#,
    )
    .bind_refs(&args)
}

fn task_refund_marker(
    task_id: i64,
    from: TaskStatus,
    to: TaskStatus,
    kind: &str,
    now: i64,
) -> String {
    format!(
        "task-refund:{kind}:{task_id}:{}:{}:{now}",
        from.as_str(),
        to.as_str()
    )
}

fn task_refund_quota_i32(quota: i64) -> worker::Result<i32> {
    if quota < 0 {
        return Err(worker::Error::RustError(
            "task refund quota must be non-negative".to_string(),
        ));
    }
    i32::try_from(quota).map_err(|_| {
        worker::Error::RustError(format!(
            "task refund quota {quota} exceeds D1 integer binding range"
        ))
    })
}

fn task_batch_changed(results: &[worker::D1Result], index: usize) -> worker::Result<bool> {
    let Some(result) = results.get(index) else {
        return Err(worker::Error::RustError(format!(
            "missing D1 batch result at index {index}"
        )));
    };
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

async fn update_task_status_cas_and_refund_batch(
    db: &D1Database,
    task: &TaskRow,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    refund_kind: &str,
) -> worker::Result<bool> {
    let quota = task_refund_quota_i32(task.quota)?;
    if quota == 0 {
        return update_task_status_cas(
            db,
            task.id,
            from,
            to,
            fail_reason,
            progress,
            result_url,
            result_data,
            finish_time,
            updated_at,
        )
        .await;
    }

    let refund_marker = task_refund_marker(task.id, from, to, refund_kind, updated_at);
    let mut statements = vec![
        update_task_status_cas_with_refund_marker_statement(
            db,
            task.id,
            from,
            to,
            fail_reason,
            progress,
            result_url,
            result_data,
            finish_time,
            updated_at,
            &refund_marker,
        )?,
        credit_user_task_refund_statement(db, task.id, task.user_id, quota, &refund_marker)?,
    ];
    if task.token_id > 0 {
        statements.push(credit_token_task_refund_statement(
            db,
            task.id,
            task.token_id,
            quota,
            updated_at,
            &refund_marker,
        )?);
    }
    let done_statement_index = statements.len();
    statements.push(mark_task_refund_done_statement(
        db,
        task.id,
        &refund_marker,
        updated_at,
    )?);

    let results = db.batch(statements).await?;
    let won = task_batch_changed(&results, 0)?;
    if won && !task_batch_changed(&results, done_statement_index)? {
        return Err(worker::Error::RustError(
            "task refund batch won CAS but did not mark refund done".to_string(),
        ));
    }
    Ok(won)
}

pub(crate) fn task_refund_cas_batch_compiled() -> bool {
    TASK_REFUND_MARKER_PATH == "$.task_refund_marker"
        && TASK_REFUND_DONE_AT_PATH == "$.task_refund_done_at"
}

pub(crate) fn task_refund_replay_contract_compiled() -> bool {
    task_refund_cas_batch_compiled()
        && LEGACY_TASK_TIMEOUT_CUTOFF_UNIX == 1_740_182_400
        && task_refund_marker(
            42,
            TaskStatus::InProgress,
            TaskStatus::Failure,
            "timeout",
            100,
        ) == "task-refund:timeout:42:IN_PROGRESS:FAILURE:100"
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

pub(crate) fn task_timeout_reason(timeout_minutes: i64, legacy: bool) -> String {
    if legacy {
        LEGACY_TASK_TIMEOUT_REASON.to_string()
    } else {
        format!("任务超时（{timeout_minutes}分钟）")
    }
}

pub(crate) fn is_legacy_timeout_task(submit_time: i64) -> bool {
    submit_time > 0 && submit_time < LEGACY_TASK_TIMEOUT_CUTOFF_UNIX
}

fn suno_poll_target_status(
    from: TaskStatus,
    item_status: &str,
    item_fail_reason: &str,
) -> TaskStatus {
    if !item_fail_reason.is_empty() {
        TaskStatus::Failure
    } else if item_status.is_empty() {
        from
    } else {
        TaskStatus::from_status_str(item_status)
    }
}

/// Mark a timed-out task as failed through the same CAS guard used by the
/// poller. Non-legacy rows receive the same user+token reserve refund as Go
/// `sweepTimedOutTasks`; legacy imported rows intentionally skip refund.
pub async fn apply_task_timeout(
    db: &D1Database,
    task: &TaskRow,
    timeout_minutes: i64,
    now: i64,
) -> worker::Result<bool> {
    let from = task.status();
    let legacy = is_legacy_timeout_task(task.submit_time);
    let reason = task_timeout_reason(timeout_minutes, legacy);
    if !legacy && task.quota != 0 {
        return update_task_status_cas_and_refund_batch(
            db,
            task,
            from,
            TaskStatus::Failure,
            &reason,
            "100%",
            "",
            None,
            now,
            now,
            "timeout",
        )
        .await;
    }
    let won = update_task_status_cas(
        db,
        task.id,
        from,
        TaskStatus::Failure,
        &reason,
        "100%",
        "",
        None,
        now,
        now,
    )
    .await?;
    Ok(won)
}

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
    if matches!(settlement_for(from, info.status), TaskSettlement::Refund) && task.quota != 0 {
        return update_task_status_cas_and_refund_batch(
            db,
            task,
            from,
            info.status,
            &info.reason,
            &info.progress,
            &info.url,
            result_data,
            finish_time,
            now,
            "poll",
        )
        .await;
    }
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
    let to = suno_poll_target_status(from, item_status, item_fail_reason);
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

    if is_failure && !from.is_terminal() && task.quota != 0 {
        return update_task_status_cas_and_refund_batch(
            db,
            task,
            from,
            to,
            item_fail_reason,
            progress,
            "",
            None,
            finish_time,
            now,
            "suno",
        )
        .await;
    }

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
    Ok(won)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_reason_matches_go_legacy_and_current_rows() {
        assert_eq!(task_timeout_reason(1_440, false), "任务超时（1440分钟）");
        assert_eq!(
            task_timeout_reason(1_440, true),
            "任务超时（旧系统遗留任务，不进行退款，请联系管理员）"
        );
    }

    #[test]
    fn legacy_timeout_cutoff_matches_go_constant() {
        assert!(is_legacy_timeout_task(LEGACY_TASK_TIMEOUT_CUTOFF_UNIX - 1));
        assert!(!is_legacy_timeout_task(LEGACY_TASK_TIMEOUT_CUTOFF_UNIX));
        assert!(!is_legacy_timeout_task(0));
    }

    #[test]
    fn task_refund_batch_markers_are_namespaced_and_compiled() {
        assert!(task_refund_cas_batch_compiled());
        assert!(task_refund_replay_contract_compiled());
        assert_eq!(TASK_REFUND_MARKER_PATH, "$.task_refund_marker");
        assert_eq!(TASK_REFUND_DONE_AT_PATH, "$.task_refund_done_at");
        assert_eq!(
            task_refund_marker(
                42,
                TaskStatus::Submitted,
                TaskStatus::Failure,
                "timeout",
                1_783_408_664
            ),
            "task-refund:timeout:42:SUBMITTED:FAILURE:1783408664"
        );
    }

    #[test]
    fn suno_fail_reason_forces_terminal_failure_status() {
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "", "upstream failed"),
            TaskStatus::Failure
        );
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "", ""),
            TaskStatus::InProgress
        );
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "SUCCESS", ""),
            TaskStatus::Success
        );
    }
}
