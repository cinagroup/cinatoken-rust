//! Admin user CRUD handlers (G5 P0): list, search, get, create, edit,
//! delete, and manage.
//!
//! Mirrors Go `controller/user.go` admin surface. Permission rules use the
//! `cinatoken_auth` helpers (`is_root`, `outranks`) and match the Go
//! `canManageTargetRole` semantics:
//!
//! - GetUser / UpdateUser / ManageUser (non-promote): `is_root || outranks`.
//! - DeleteUser: `outranks` (strict; no root-bypass-via-equality).
//! - CreateUser role: `new_role < caller_role` (strict).
//! - ManageUser promote: `is_root` only.
//! - ManageUser disable/delete/demote: block if target is root.
//!
//! All responses omit `password` (SQL-level omit) and `access_token`
//! (handler redaction). DELETE uses soft delete so tokens do not orphan,
//! differing from the Go gateway's hard delete.

use cinatoken_auth::{
    hash_password, is_root, outranks, ROLE_ADMIN_USER, ROLE_COMMON_USER, ROLE_ROOT_USER,
    USER_STATUS_DISABLED, USER_STATUS_ENABLED,
};
use serde::{Deserialize, Serialize};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    unix_timestamp,
};
use crate::cache_invalidation::invalidate_token_cache;
use crate::d1_repositories;

// ---------------------------------------------------------------------------
// List / search / get
// ---------------------------------------------------------------------------

pub async fn list_users(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::list_users(&db, page, page_size).await?;
    let total = d1_repositories::count_users(&db).await?;
    Ok(envelope_ok_response(&UsersPage {
        items: items.into_iter().map(user_response).collect(),
        total,
        page,
        page_size,
    })?)
}

pub async fn search_users(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let keyword = parse_query_string(&req, "keyword");
    let group = parse_query_string(&req, "group");
    let role = parse_query_i32(&req, "role");
    let status = parse_query_i32(&req, "status");
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::search_users(
        &db,
        keyword.as_deref(),
        group.as_deref(),
        role,
        status,
        page,
        page_size,
    )
    .await?;
    let total = d1_repositories::count_search_users(
        &db,
        keyword.as_deref(),
        group.as_deref(),
        role,
        status,
    )
    .await?;
    Ok(envelope_ok_response(&UsersPage {
        items: items.into_iter().map(user_response).collect(),
        total,
        page,
        page_size,
    })?)
}

pub async fn get_user(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if !is_root(claims.role) && !outranks(claims.role, target.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to view this user",
        ));
    }
    let Some(row) = d1_repositories::find_user_by_id_full(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    Ok(envelope_ok_response(&user_response(row))?)
}

// ---------------------------------------------------------------------------
// Create / edit / delete
// ---------------------------------------------------------------------------

pub async fn create_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UserCreateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid user create request: {err}"),
            ));
        }
    };
    let username = payload.username.trim();
    if username.is_empty() {
        return Ok(envelope_error_response(400, "username must not be empty"));
    }
    if payload.password.is_empty() {
        return Ok(envelope_error_response(400, "password must not be empty"));
    }
    // Role clamp: new role must be STRICTLY less than caller's role.
    let new_role = payload.role.unwrap_or(ROLE_COMMON_USER);
    if new_role >= claims.role {
        return Ok(envelope_error_response(
            403,
            "cannot create a user with role equal to or higher than your own",
        ));
    }
    let display_name = match payload.display_name.as_deref() {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => username.to_string(),
    };
    let password_hash = match hash_password(&payload.password) {
        Ok(hash) => hash,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to hash password: {err}"),
            ));
        }
    };
    let now = unix_timestamp();
    let aff_code = random_aff_code();
    let db = env.d1("DB")?;
    let user_id = d1_repositories::create_user(
        &db,
        d1_repositories::CreateUser {
            username,
            password_hash: &password_hash,
            display_name: &display_name,
            role: new_role,
            group: "default",
            aff_code: &aff_code,
            quota: 0,
            created_at: now,
        },
    )
    .await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(user_id),
        Some(username),
        &claims.username,
        "user.create",
        &format!(
            "admin {} created user {} (role {})",
            claims.username, username, new_role
        ),
        &serde_json::json!({"username": username, "role": new_role}),
        &crate::admin::admin_audit_info(&claims, &req),
        now,
    )
    .await;
    Ok(envelope_ok_response(&UserCreateResult { id: user_id })?)
}

pub async fn update_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UserUpdateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid user update request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let Some(origin) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    // Caller must outrank the origin role.
    if !is_root(claims.role) && !outranks(claims.role, origin.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to edit this user",
        ));
    }
    // Caller must also outrank the new role if the body attempts to change it.
    // (Edit itself does not persist role, but we check defensively.)
    if let Some(new_role) = payload.role {
        if !is_root(claims.role) && !outranks(claims.role, new_role) {
            return Ok(envelope_error_response(
                403,
                "cannot set a role equal to or higher than your own",
            ));
        }
    }
    let password_hash = if payload.password.as_deref().is_some_and(|p| !p.is_empty()) {
        match hash_password(payload.password.as_deref().unwrap_or("")) {
            Ok(hash) => Some(hash),
            Err(err) => {
                return Ok(envelope_error_response(
                    500,
                    &format!("failed to hash password: {err}"),
                ));
            }
        }
    } else {
        None
    };
    let updated = d1_repositories::edit_user(
        &db,
        id,
        payload.username.as_deref(),
        payload.display_name.as_deref(),
        payload.group.as_deref(),
        payload.remark.as_deref(),
        password_hash.as_deref(),
    )
    .await?;
    if !updated {
        return Ok(envelope_error_response(
            404,
            "user not found or no fields to update",
        ));
    }
    // If a role change was requested, persist it via a dedicated update.
    if let Some(new_role) = payload.role {
        let _ = d1_repositories::set_user_role(&db, id, new_role).await;
        let _ = invalidate_token_cache(&env).await;
    }
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "user.update",
        &format!("admin {} updated user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

pub async fn delete_user(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    // Strict outrank: caller's role must be STRICTLY GREATER than the
    // target's role. This is stricter than the `outranks` helper (which lets
    // root bypass equality) and matches Go's `myRole <= originUser.Role`
    // rejection: even root cannot delete another root.
    if claims.role <= target.role {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to delete this user",
        ));
    }
    let deleted = d1_repositories::soft_delete_user(&db, id, unix_timestamp()).await?;
    if !deleted {
        return Ok(envelope_error_response(
            404,
            "user not found or already deleted",
        ));
    }
    let _ = invalidate_token_cache(&env).await;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "user.delete",
        &format!("admin {} deleted user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

/// `POST /api/user/:id/2fa/disable`: an admin clears a target user's 2FA
/// (account recovery when the user loses their authenticator). Requires manage
/// privilege over the target (`is_root || outranks`) and is audited. Mirrors Go
/// `AdminDisable2FA`.
pub async fn admin_disable_2fa(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if !is_root(claims.role) && !outranks(claims.role, target.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to manage this user",
        ));
    }
    d1_repositories::delete_two_fa(&db, id).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "two_fa.admin_disable",
        &format!("admin {} disabled 2FA for user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::json!({ "disabled": true }))
}

// ---------------------------------------------------------------------------
// ManageUser (the action switch)
// ---------------------------------------------------------------------------

pub async fn manage_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ManageUserRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid manage user request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    let action = payload.action.trim().to_ascii_lowercase();
    let target_is_root = target.role >= ROLE_ROOT_USER;

    // Permission gate shared by most actions: caller must outrank the target.
    let can_manage = is_root(claims.role) || outranks(claims.role, target.role);

    let mut invalidate = false;
    match action.as_str() {
        "disable" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot disable a root user"));
            }
            let _ = d1_repositories::set_user_status(&db, id, USER_STATUS_DISABLED).await;
            invalidate = true;
        }
        "enable" => {
            if !can_manage {
                return Ok(forbidden());
            }
            let _ = d1_repositories::set_user_status(&db, id, USER_STATUS_ENABLED).await;
            // Go does not invalidate on enable.
        }
        "delete" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot delete a root user"));
            }
            let _ = d1_repositories::soft_delete_user(&db, id, unix_timestamp()).await;
            invalidate = true;
        }
        "promote" => {
            if !is_root(claims.role) {
                return Ok(envelope_error_response(403, "only root can promote users"));
            }
            if target.role >= ROLE_ADMIN_USER {
                return Ok(envelope_error_response(400, "user is already an admin"));
            }
            let _ = d1_repositories::set_user_role(&db, id, ROLE_ADMIN_USER).await;
            invalidate = true;
        }
        "demote" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot demote a root user"));
            }
            if target.role <= ROLE_COMMON_USER {
                return Ok(envelope_error_response(
                    400,
                    "user is already a common user",
                ));
            }
            let _ = d1_repositories::set_user_role(&db, id, ROLE_COMMON_USER).await;
            invalidate = true;
        }
        "add_quota" => {
            if !can_manage {
                return Ok(forbidden());
            }
            let value = payload.value.unwrap_or(0);
            match payload.mode.as_deref().unwrap_or("add") {
                "add" => {
                    let _ = d1_repositories::increase_user_quota(&db, id, value).await;
                }
                "subtract" => {
                    let _ = d1_repositories::decrease_user_quota(&db, id, value).await;
                }
                "override" => {
                    let _ = d1_repositories::override_user_quota(&db, id, value).await;
                }
                other => {
                    return Ok(envelope_error_response(
                        400,
                        &format!("unknown quota mode: {other}"),
                    ));
                }
            }
            // Go does not invalidate token cache on quota changes.
        }
        other => {
            return Ok(envelope_error_response(
                400,
                &format!("unknown manage action: {other}"),
            ));
        }
    }
    if invalidate {
        let _ = invalidate_token_cache(&env).await;
    }
    // Record the audit row. The action name and params mirror Go's
    // per-action audit calls (user.manage / user.quota_add / etc.).
    let (audit_action, audit_params) = match action.as_str() {
        "add_quota" => {
            let mode = payload.mode.as_deref().unwrap_or("add");
            let named = match mode {
                "subtract" => "user.quota_subtract",
                "override" => "user.quota_override",
                _ => "user.quota_add",
            };
            (
                named,
                serde_json::json!({"id": id, "value": payload.value.unwrap_or(0), "mode": mode}),
            )
        }
        other => (
            "user.manage",
            serde_json::json!({"action": other, "id": id}),
        ),
    };
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        audit_action,
        &format!(
            "admin {} performed {} on user {}",
            claims.username, audit_action, id
        ),
        &audit_params,
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    // Return the post-action role + status (re-read).
    let after = d1_repositories::find_user_role_status(&db, id).await?;
    Ok(envelope_ok_response(&ManageUserResult {
        role: after.as_ref().map(|r| r.role).unwrap_or(target.role),
        status: after.as_ref().map(|r| r.status).unwrap_or(target.status),
    })?)
}

fn forbidden() -> Response {
    envelope_error_response(403, "insufficient privileges to manage this user")
}

// ---------------------------------------------------------------------------
// Helpers and DTOs
// ---------------------------------------------------------------------------

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

fn parse_query_i32(req: &Request, key: &str) -> Option<i32> {
    parse_query_string(req, key)?.parse::<i32>().ok()
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse::<i64>().ok()
}

/// Generate a 4-character alphanumeric affiliation code, matching the Go
/// `common.GetRandomString(4)` behavior.
fn random_aff_code() -> String {
    let alphabet: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut out = String::with_capacity(4);
    for _ in 0..4 {
        let r = js_sys::Math::random() * (alphabet.len() as f64);
        out.push(alphabet[r as usize] as char);
    }
    out
}

/// Admin-facing user response. `access_token` is intentionally absent (never
/// useful in an admin response). `password` is never selected by the SQL.
#[derive(Debug, Serialize)]
struct UserResponse {
    id: i64,
    username: String,
    display_name: String,
    role: i32,
    status: i32,
    email: String,
    quota: i64,
    used_quota: i64,
    request_count: i64,
    #[serde(rename = "group")]
    channel_group: String,
    aff_code: String,
    aff_count: i64,
    aff_quota: i64,
    aff_history_quota: i64,
    inviter_id: i64,
    setting: String,
    remark: String,
    stripe_customer: String,
    created_at: i64,
    last_login_at: i64,
    deleted_at: Option<i64>,
}

fn user_response(row: d1_repositories::AdminUserFullRow) -> UserResponse {
    UserResponse {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        status: row.status,
        email: row.email,
        quota: row.quota,
        used_quota: row.used_quota,
        request_count: row.request_count,
        channel_group: row.channel_group,
        aff_code: row.aff_code,
        aff_count: row.aff_count,
        aff_quota: row.aff_quota,
        aff_history_quota: row.aff_history_quota,
        inviter_id: row.inviter_id,
        setting: row.setting,
        remark: row.remark,
        stripe_customer: row.stripe_customer,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
        deleted_at: row.deleted_at,
    }
}

#[derive(Debug, Serialize)]
struct UsersPage {
    items: Vec<UserResponse>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Serialize)]
struct UserCreateResult {
    id: i64,
}

#[derive(Debug, Serialize)]
struct ManageUserResult {
    role: i32,
    status: i32,
}

#[derive(Debug, Deserialize)]
struct UserCreateRequest {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    role: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct UserUpdateRequest {
    id: i64,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    remark: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    role: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ManageUserRequest {
    id: i64,
    action: String,
    #[serde(default)]
    value: Option<i64>,
    #[serde(default)]
    mode: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinatoken_auth::{ROLE_ADMIN_USER, ROLE_COMMON_USER, ROLE_ROOT_USER};

    #[test]
    fn permission_rules_match_go_canmanage() {
        // Root can manage anyone (including other roots).
        assert!(is_root(ROLE_ROOT_USER) || outranks(ROLE_ROOT_USER, ROLE_ROOT_USER));
        assert!(is_root(ROLE_ROOT_USER) || outranks(ROLE_ROOT_USER, ROLE_ADMIN_USER));
        // Admin can manage common users but not other admins.
        assert!(!is_root(ROLE_ADMIN_USER));
        assert!(outranks(ROLE_ADMIN_USER, ROLE_COMMON_USER));
        assert!(!outranks(ROLE_ADMIN_USER, ROLE_ADMIN_USER));
        // Common users cannot manage anyone.
        assert!(!outranks(ROLE_COMMON_USER, ROLE_COMMON_USER));
    }

    #[test]
    fn delete_requires_strict_outrank() {
        // DeleteUser uses `claims.role > target.role` (strictly greater).
        // Root can delete admin/common but NOT another root; admin can
        // delete common only.
        assert!(ROLE_ROOT_USER > ROLE_ADMIN_USER);
        assert!(ROLE_ROOT_USER > ROLE_COMMON_USER);
        assert!(!(ROLE_ROOT_USER > ROLE_ROOT_USER));
        assert!(ROLE_ADMIN_USER > ROLE_COMMON_USER);
        assert!(!(ROLE_ADMIN_USER > ROLE_ADMIN_USER));
    }

    #[test]
    fn user_create_request_defaults_role_to_common() {
        let req: UserCreateRequest =
            serde_json::from_str(r#"{"username":"alice","password":"pw123456"}"#).unwrap();
        assert_eq!(req.role, None); // handler defaults to ROLE_COMMON_USER
        assert!(req.display_name.is_none());
    }

    #[test]
    fn manage_user_request_parses_quota_action() {
        let req: ManageUserRequest =
            serde_json::from_str(r#"{"id":7,"action":"add_quota","value":500,"mode":"add"}"#)
                .unwrap();
        assert_eq!(req.id, 7);
        assert_eq!(req.action, "add_quota");
        assert_eq!(req.value, Some(500));
        assert_eq!(req.mode.as_deref(), Some("add"));
    }

    #[test]
    fn manage_user_request_defaults_mode_and_value() {
        let req: ManageUserRequest =
            serde_json::from_str(r#"{"id":1,"action":"disable"}"#).unwrap();
        assert_eq!(req.value, None);
        assert_eq!(req.mode, None);
    }

    #[test]
    fn user_update_request_all_fields_optional_except_id() {
        let req: UserUpdateRequest = serde_json::from_str(r#"{"id":42}"#).unwrap();
        assert_eq!(req.id, 42);
        assert!(req.username.is_none());
        assert!(req.password.is_none());
        assert!(req.role.is_none());
    }

    #[test]
    fn parse_id_param_accepts_numeric_strings() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"  7 ".to_string())), Some(7));
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
        assert_eq!(parse_id_param(None), None);
    }
}
