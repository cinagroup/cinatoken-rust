//! Usage-log list handlers for async tasks.
//!
//! These routes back the React usage-log tabs for Midjourney (`/api/mj`) and
//! unified async tasks (`/api/task`). They are read-only dashboard surfaces:
//! admin routes can filter by channel, while self routes force the session user
//! scope and avoid exposing channel identifiers.

use serde::Serialize;
use serde_json::Value;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_ok_response, require_admin_auth, require_user_auth};
use crate::mj_repository::{self, MjListFilter};
use crate::task_repository::{self, TaskDtoRow, TaskListFilter};

/// `GET /api/mj`: admin Midjourney usage-log list.
pub async fn list_midjourneys_admin(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let filter = parse_mj_filter(&req, None);
    let items = mj_repository::list_midjourneys(&db, &filter, page, page_size).await?;
    let total = mj_repository::count_midjourneys(&db, &filter).await?;
    Ok(envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/mj/self`: current user's Midjourney usage-log list.
pub async fn list_midjourneys_self(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let filter = parse_mj_filter(&req, Some(claims.id));
    let items = mj_repository::list_midjourneys(&db, &filter, page, page_size).await?;
    let total = mj_repository::count_midjourneys(&db, &filter).await?;
    Ok(envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/task`: admin unified task usage-log list.
pub async fn list_tasks_admin(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let filter = parse_task_filter(&req, None);
    let rows = task_repository::list_tasks(&db, &filter, page, page_size).await?;
    let total = task_repository::count_tasks(&db, &filter).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| task_list_dto_json(row, false))
        .collect();
    Ok(envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/task/self`: current user's unified task usage-log list.
pub async fn list_tasks_self(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let filter = parse_task_filter(&req, Some(claims.id));
    let rows = task_repository::list_tasks(&db, &filter, page, page_size).await?;
    let total = task_repository::count_tasks(&db, &filter).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| task_list_dto_json(row, true))
        .collect();
    Ok(envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })?)
}

#[derive(Debug, Serialize)]
struct Page<T> {
    items: Vec<T>,
    total: i64,
    page: u32,
    page_size: u32,
}

fn parse_mj_filter(req: &Request, user_id: Option<i64>) -> MjListFilter {
    MjListFilter {
        user_id,
        channel_id: if user_id.is_none() {
            parse_query_i64(req, "channel_id")
        } else {
            None
        },
        mj_id: parse_query_string(req, "mj_id"),
        start_timestamp: parse_query_i64(req, "start_timestamp").map(|value| value.to_string()),
        end_timestamp: parse_query_i64(req, "end_timestamp").map(|value| value.to_string()),
    }
}

fn parse_task_filter(req: &Request, user_id: Option<i64>) -> TaskListFilter {
    TaskListFilter {
        user_id,
        channel_id: if user_id.is_none() {
            parse_query_i64(req, "channel_id")
        } else {
            None
        },
        platform: parse_query_string(req, "platform"),
        task_id: parse_query_string(req, "task_id"),
        status: parse_query_string(req, "status"),
        action: parse_query_string(req, "action"),
        start_timestamp: parse_query_i64(req, "start_timestamp").map(|value| value.to_string()),
        end_timestamp: parse_query_i64(req, "end_timestamp").map(|value| value.to_string()),
    }
}

fn task_list_dto_json(row: &TaskDtoRow, hide_channel_id: bool) -> Value {
    let private: Value = parse_json_or_null(&row.private_data);
    let result_url = private
        .get("result_url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .unwrap_or(&row.fail_reason)
        .to_string();
    let mut dto = serde_json::json!({
        "id": row.id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "task_id": row.task_id,
        "platform": row.platform,
        "user_id": row.user_id,
        "group": row.group,
        "channel_id": if hide_channel_id { 0 } else { row.channel_id },
        "quota": row.quota,
        "action": row.action,
        "status": row.status,
        "fail_reason": row.fail_reason,
        "submit_time": row.submit_time,
        "start_time": row.start_time,
        "finish_time": row.finish_time,
        "progress": row.progress,
        "properties": parse_json_or_null(&row.properties),
        "data": parse_json_or_null(&row.data),
    });
    if !result_url.is_empty() {
        dto["result_url"] = serde_json::json!(result_url);
    }
    if !row.username.is_empty() {
        dto["username"] = serde_json::json!(row.username);
    }
    dto
}

fn parse_json_or_null(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(trimmed).unwrap_or(Value::Null)
    }
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let page = parse_query_u32(req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(req, "page_size")
        .unwrap_or(10)
        .clamp(1, 100);
    (page, page_size)
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let pair = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if pair.is_empty() {
        None
    } else {
        Some(pair)
    }
}

fn parse_query_i64(req: &Request, key: &str) -> Option<i64> {
    parse_query_string(req, key)?.parse::<i64>().ok()
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}
