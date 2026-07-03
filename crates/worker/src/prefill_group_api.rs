//! Admin CRUD for reusable prefill groups (Go
//! `controller/prefill_group.go`, `/api/prefill_group*`, AdminAuth).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{admin_audit_info, envelope_ok_response, require_admin_auth, unix_timestamp};
use crate::d1_repositories::{self, PrefillGroup};

const REQUEST_BODY_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug, Default, Deserialize)]
struct PrefillGroupRequest {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    group_type: String,
    #[serde(default)]
    items: Value,
    #[serde(default)]
    description: String,
    #[serde(default)]
    created_time: i64,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    success: bool,
    message: String,
}

fn group_type_query(req: &Request) -> Option<String> {
    req.url()
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "type")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.parse().ok()
}

async fn read_request(req: &mut Request) -> std::result::Result<PrefillGroupRequest, String> {
    let bytes = req
        .bytes()
        .await
        .map_err(|err| format!("failed to read request body: {err}"))?;
    if bytes.len() > REQUEST_BODY_LIMIT_BYTES {
        return Err("request body is too large".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|err| format!("invalid prefill group request: {err}"))
}

fn error_response(message: impl Into<String>) -> WorkerResult<Response> {
    let mut response = Response::from_json(&ErrorEnvelope {
        success: false,
        message: message.into(),
    })?
    .with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn storage_error(context: &str, err: impl std::fmt::Display) -> WorkerResult<Response> {
    worker::console_error!("prefill group {context}: {err}");
    error_response("prefill group storage is unavailable")
}

/// `GET /api/prefill_group?type=...`: all live groups, optionally filtered by
/// exact type, ordered by most recently updated first.
pub async fn get_prefill_groups(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }

    let group_type = group_type_query(&req);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => return storage_error("D1 binding unavailable during list", err),
    };
    let groups = match d1_repositories::list_prefill_groups(&db, group_type.as_deref()).await {
        Ok(groups) => groups,
        Err(err) => return storage_error("list failed", err),
    };
    envelope_ok_response(&groups)
}

/// `POST /api/prefill_group`: create a reusable group.
pub async fn create_prefill_group(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_request(&mut req).await {
        Ok(payload) => payload,
        Err(message) => return error_response(message),
    };
    if payload.name.is_empty() || payload.group_type.is_empty() {
        return error_response("group name and type must not be empty");
    }

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => return storage_error("D1 binding unavailable during create", err),
    };
    let duplicated =
        match d1_repositories::prefill_group_name_duplicated(&db, 0, &payload.name).await {
            Ok(duplicated) => duplicated,
            Err(err) => return storage_error("duplicate check failed during create", err),
        };
    if duplicated {
        return error_response("group name already exists");
    }

    let now = unix_timestamp();
    let mut group = PrefillGroup {
        id: payload.id,
        name: payload.name,
        group_type: payload.group_type,
        items: payload.items,
        description: payload.description,
        created_time: now,
        updated_time: now,
    };
    group.id = match d1_repositories::insert_prefill_group(&db, &group).await {
        Ok(id) => id,
        Err(err) => return storage_error("insert failed", err),
    };

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "prefill_group.create",
        "POST /api/prefill_group/",
        &serde_json::json!({
            "id": group.id,
            "name": &group.name,
            "type": &group.group_type,
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    envelope_ok_response(&group)
}

/// `PUT /api/prefill_group`: save a group by id.
pub async fn update_prefill_group(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_request(&mut req).await {
        Ok(payload) => payload,
        Err(message) => return error_response(message),
    };
    if payload.id == 0 {
        return error_response("missing group id");
    }

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => return storage_error("D1 binding unavailable during update", err),
    };
    let duplicated = match d1_repositories::prefill_group_name_duplicated(
        &db,
        payload.id,
        &payload.name,
    )
    .await
    {
        Ok(duplicated) => duplicated,
        Err(err) => return storage_error("duplicate check failed during update", err),
    };
    if duplicated {
        return error_response("group name already exists");
    }

    let now = unix_timestamp();
    let group = PrefillGroup {
        id: payload.id,
        name: payload.name,
        group_type: payload.group_type,
        items: payload.items,
        description: payload.description,
        created_time: payload.created_time,
        updated_time: now,
    };
    if let Err(err) = d1_repositories::save_prefill_group(&db, &group).await {
        return storage_error("update failed", err);
    }

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "prefill_group.update",
        "PUT /api/prefill_group/",
        &serde_json::json!({
            "id": group.id,
            "name": &group.name,
            "type": &group.group_type,
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    envelope_ok_response(&group)
}

/// `DELETE /api/prefill_group/:id`: soft-delete a group.
pub async fn delete_prefill_group(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param) else {
        return error_response("invalid prefill group id");
    };

    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => return storage_error("D1 binding unavailable during delete", err),
    };
    let now = unix_timestamp();
    let group = match d1_repositories::get_prefill_group(&db, id).await {
        Ok(group) => group,
        Err(err) => return storage_error("lookup failed during delete", err),
    };
    if let Err(err) = d1_repositories::soft_delete_prefill_group(&db, id, now).await {
        return storage_error("soft delete failed", err);
    }

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "prefill_group.delete",
        "DELETE /api/prefill_group/:id",
        &serde_json::json!({
            "id": id,
            "name": group.as_ref().map(|group| group.name.as_str()),
            "type": group.as_ref().map(|group| group.group_type.as_str()),
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    envelope_ok_response(&Value::Null)
}
