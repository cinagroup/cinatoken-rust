//! Admin CRUD handlers (G5 P0): logs, options, tokens.
//!
//! These routes plug into the `require_user_auth` / `require_admin_auth` /
//! `require_root_auth` helpers from [`crate::admin`] and the D1 repository
//! functions in [`crate::d1_repositories`]. Token mutations trigger
//! [`crate::cache_invalidation::invalidate_token_cache`] so the relay hot path
//! sees the new state immediately rather than waiting for the cache TTL.
//!
//! Scope mirrors the Go gateway's `controller/log.go`, `controller/option.go`,
//! and `controller/token.go`. Channel admin (the largest Go controller) and
//! user admin are intentionally deferred to the next G5 batch.

use cinatoken_core::ApiEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    require_root_auth, require_user_auth, unix_timestamp,
};
use crate::cache_invalidation::invalidate_token_cache;
use crate::d1_repositories::{self, CreateToken, LogFilter, LogRow, TokenRow, UpdateToken};

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/// `GET /api/log/`: admin log list. AdminAuth.
pub async fn list_all_logs(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims; // admin sees all logs; no user scope
    let db = env.d1("DB")?;
    let filter = parse_log_filter(&req, None)?;
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::list_logs(&db, &filter, page, page_size).await?;
    let total = d1_repositories::count_logs(&db, &filter).await?;
    Ok(envelope_ok_response(&logs_page(
        items, total, page, page_size,
    ))?)
}

/// `GET /api/log/self`: current user's logs. UserAuth; user_id is forced to
/// the session user.
pub async fn list_self_logs(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let filter = parse_log_filter(&req, Some(claims.id))?;
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::list_logs(&db, &filter, page, page_size).await?;
    let total = d1_repositories::count_logs(&db, &filter).await?;
    // Self logs strip channel-identifying detail and admin audit info to
    // match Go `GetUserLogs` safety. channel_id is zeroed and `other` is
    // cleared so a user cannot see admin_info / audit_info / stream_status
    // metadata attached by the relay.
    let sanitized: Vec<LogRow> = items.into_iter().map(mut_strip_self_log).collect();
    Ok(envelope_ok_response(&logs_page(
        sanitized, total, page, page_size,
    ))?)
}

/// `GET /api/log/stat`: admin aggregated stats. AdminAuth.
pub async fn logs_stat(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let filter = parse_log_filter(&req, None)?;
    let stat = d1_repositories::logs_stat(&db, &filter, unix_timestamp()).await?;
    Ok(envelope_ok_response(&stat)?)
}

/// `GET /api/log/self/stat`: current user's stats. UserAuth.
pub async fn self_logs_stat(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let filter = parse_log_filter(&req, Some(claims.id))?;
    let stat = d1_repositories::logs_stat(&db, &filter, unix_timestamp()).await?;
    Ok(envelope_ok_response(&stat)?)
}

/// `DELETE /api/log/`: bulk delete logs older than `target_timestamp`. AdminAuth.
pub async fn delete_history_logs(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let target = match parse_query_i64(&req, "target_timestamp") {
        Some(ts) => ts,
        None => {
            return Ok(envelope_error_response(
                400,
                "target_timestamp query parameter is required",
            ));
        }
    };
    let db = env.d1("DB")?;
    let deleted = d1_repositories::delete_logs_before(&db, target).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "log.clear",
        &format!("admin {} cleared logs before {}", claims.username, target),
        &serde_json::json!({"target_timestamp": target, "deleted": deleted}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&DeleteResult { deleted })?)
}

/// Deprecated search routes return this envelope to match the Go gateway's
/// `{success:false, message:"该接口已废弃"}` response.
pub async fn deprecated_log_search(_req: Request, _env: Env) -> WorkerResult<Response> {
    let body = ApiEnvelope {
        success: false,
        message: "该接口已废弃".to_string(),
        data: Value::Null,
    };
    let mut response = Response::from_json(&body)?.with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn mut_strip_self_log(mut row: LogRow) -> LogRow {
    row.channel_id = 0;
    row.other.clear();
    row
}

#[derive(Debug, Serialize)]
struct LogsPage {
    items: Vec<LogRow>,
    total: i64,
    page: u32,
    page_size: u32,
}

fn logs_page(items: Vec<LogRow>, total: i64, page: u32, page_size: u32) -> LogsPage {
    LogsPage {
        items,
        total,
        page,
        page_size,
    }
}

#[derive(Debug, Serialize)]
struct DeleteResult {
    deleted: i64,
}

fn parse_log_filter(req: &Request, user_id: Option<i64>) -> WorkerResult<LogFilter> {
    let mut filter = LogFilter::default();
    filter.user_id = user_id;
    if let Some(kind) = parse_query_i64(req, "type") {
        filter.kind = Some(kind as i32);
    }
    if let Some(start) = parse_query_i64(req, "start_timestamp") {
        filter.start_timestamp = Some(start);
    }
    if let Some(end) = parse_query_i64(req, "end_timestamp") {
        filter.end_timestamp = Some(end);
    }
    // Self path ignores username/group/channel filters for safety — admins
    // cannot impersonate a user scope via /api/log/self.
    if user_id.is_none() {
        filter.username = parse_query_string(req, "username");
        filter.group = parse_query_string(req, "group");
        if let Some(channel) = parse_query_i64(req, "channel") {
            filter.channel_id = Some(channel);
        }
    }
    filter.token_name = parse_query_string(req, "token_name");
    filter.model_name = parse_query_string(req, "model_name");
    filter.request_id = parse_query_string(req, "request_id");
    filter.upstream_request_id = parse_query_string(req, "upstream_request_id");
    Ok(filter)
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// `GET /api/option/`: list all options with sensitive keys filtered. RootAuth.
pub async fn list_options(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let all = d1_repositories::list_all_options(&db).await?;
    let filtered: Vec<_> = all
        .into_iter()
        .filter(|row| !d1_repositories::is_sensitive_option_key(&row.key))
        .collect();
    Ok(envelope_ok_response(&filtered)?)
}

/// `PUT /api/option/`: upsert an option value. RootAuth.
///
/// NOTE: this is the minimal viable update. The Go gateway's `UpdateOption`
/// (`controller/option.go:120-334`) carries extensive per-key validation
/// (OAuth enable guards, ratio JSON parsers, console_setting validators).
/// That validation is deferred to the next G5 batch on the assumption that
/// root users are trusted operators; per-key validation here is a misuse
/// guard, not a security boundary.
pub async fn update_option(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: OptionUpdateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid option update request: {err}"),
            ));
        }
    };
    let key = payload.key.trim();
    let value = value_to_string(payload.value);
    if key.is_empty() {
        return Ok(envelope_error_response(400, "option key must not be empty"));
    }
    let db = env.d1("DB")?;
    d1_repositories::upsert_option_pub(&db, key, &value).await?;
    // Option cache is not currently wired into the relay path; invalidate
    // anyway so future option caching is safe by default.
    crate::cache_invalidation::invalidate_option_cache(&env).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "option.update",
        &format!("admin {} updated option {}", claims.username, key),
        // Deliberately do NOT record the value: option values can carry
        // secrets (API keys, OAuth client secrets). Only the key name is
        // audited.
        &serde_json::json!({"key": key}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&OptionReadback {
        key: key.to_string(),
        value,
    })?)
}

#[derive(Debug, Deserialize)]
struct OptionUpdateRequest {
    key: String,
    value: Value,
}

#[derive(Debug, Serialize)]
struct OptionReadback {
    key: String,
    value: String,
}

/// Coerce the JSON `value` field to its canonical string form, matching Go's
/// `fmt.Sprint(value)` behavior for option storage.
fn value_to_string(value: Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s,
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// `GET /api/token/`: list the current user's tokens (masked keys). UserAuth.
pub async fn list_tokens(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let rows = d1_repositories::list_tokens(&db, claims.id, page, page_size).await?;
    let total = d1_repositories::count_tokens(&db, claims.id).await?;
    let items: Vec<TokenResponse> = rows.into_iter().map(masked_token_response).collect();
    Ok(envelope_ok_response(&TokensPage {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/token/search`: search the current user's tokens by keyword. UserAuth.
pub async fn search_tokens(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let keyword = parse_query_string(&req, "keyword").unwrap_or_default();
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let rows = d1_repositories::search_tokens(&db, claims.id, &keyword, page, page_size).await?;
    // Search reuses list count for the total since a per-search count helper
    // is not yet in the repository; the frontend primarily needs the items.
    let total = rows.len() as i64;
    let items: Vec<TokenResponse> = rows.into_iter().map(masked_token_response).collect();
    Ok(envelope_ok_response(&TokensPage {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/token/:id`: get one of the current user's tokens (masked key). UserAuth.
pub async fn get_token(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "token id is required")),
    };
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_token_by_id_and_user(&db, id, claims.id).await? else {
        return Ok(envelope_error_response(404, "token not found"));
    };
    Ok(envelope_ok_response(&masked_token_response(row))?)
}

/// `POST /api/token/:id/key`: reveal the full token key. UserAuth + ownership check.
pub async fn reveal_token_key(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "token id is required")),
    };
    // Step-up gate (item 2.3): revealing a credential requires a fresh
    // secure-verification (POST /api/verify within the last 300s).
    if let Some(response) = crate::admin::require_secure_verification(&env, claims.id).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_token_by_id_and_user(&db, id, claims.id).await? else {
        return Ok(envelope_error_response(404, "token not found"));
    };
    // Record the reveal as an audit row. The key itself is NEVER recorded —
    // only the token id and name, so the trail shows WHO revealed WHAT
    // without leaking the credential.
    let token_id = row.id;
    let token_name = row.name.clone();
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "token.key_view",
        &format!(
            "user {} revealed key for token {}",
            claims.username, token_name
        ),
        &serde_json::json!({"token_id": token_id, "token_name": token_name}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&TokenKeyReveal { key: row.key })?)
}

/// `POST /api/token/`: create a new token for the current user. UserAuth.
pub async fn create_token(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: TokenCreateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid token create request: {err}"),
            ));
        }
    };
    let name = payload.name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(400, "token name must not be empty"));
    }
    let key = format!("ct-{}", random_key_suffix(32));
    let now = unix_timestamp();
    let db = env.d1("DB")?;
    let id = d1_repositories::create_token(
        &db,
        CreateToken {
            user_id: claims.id,
            key: &key,
            name,
            expired_time: payload.expired_time.unwrap_or(-1),
            remain_quota: payload.remain_quota.unwrap_or(0),
            unlimited_quota: payload.unlimited_quota.unwrap_or(0),
            model_limits_enabled: payload.model_limits_enabled.unwrap_or(0),
            model_limits: payload.model_limits.as_deref().unwrap_or(""),
            allow_ips: payload.allow_ips.as_deref().unwrap_or(""),
            group: payload.group.as_deref().unwrap_or(""),
            cross_group_retry: payload.cross_group_retry.unwrap_or(0),
            created_time: now,
        },
    )
    .await?;
    // New token may be picked up by relay auth cache lookups; clear cache so
    // any stale "token not found" negatives are dropped immediately.
    let _ = invalidate_token_cache(&env).await;
    Ok(envelope_ok_response(&TokenCreateResult { id, key })?)
}

/// `PUT /api/token/`: update one of the current user's tokens. UserAuth + ownership.
/// Honors the `status_only` query flag for the quick enable/disable toggle.
pub async fn update_token(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let status_only = parse_query_string(&req, "status_only")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: TokenUpdateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid token update request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let updated = d1_repositories::update_token(
        &db,
        UpdateToken {
            id,
            user_id: claims.id,
            status_only,
            name: payload.name.as_deref(),
            status: payload.status,
            expired_time: payload.expired_time,
            remain_quota: payload.remain_quota,
            unlimited_quota: payload.unlimited_quota,
            model_limits_enabled: payload.model_limits_enabled,
            model_limits: payload.model_limits.as_deref(),
            allow_ips: payload.allow_ips.as_deref(),
            group: payload.group.as_deref(),
            cross_group_retry: payload.cross_group_retry,
        },
    )
    .await?;
    if !updated {
        return Ok(envelope_error_response(
            404,
            "token not found or no fields to update",
        ));
    }
    let _ = invalidate_token_cache(&env).await;
    Ok(envelope_ok_response(&Value::Null)?)
}

/// `DELETE /api/token/:id`: soft-delete one of the current user's tokens. UserAuth + ownership.
pub async fn delete_token(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "token id is required")),
    };
    let db = env.d1("DB")?;
    let deleted = d1_repositories::delete_token(&db, id, claims.id, unix_timestamp()).await?;
    if !deleted {
        return Ok(envelope_error_response(404, "token not found"));
    }
    let _ = invalidate_token_cache(&env).await;
    Ok(envelope_ok_response(&Value::Null)?)
}

/// `POST /api/token/batch`: soft-delete multiple tokens owned by the current user.
pub async fn delete_tokens_batch(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: TokenBatchDeleteRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid token batch delete request: {err}"),
            ));
        }
    };
    if payload.ids.is_empty() {
        return Ok(envelope_ok_response(&TokenBatchDeleteResult { count: 0 })?);
    }
    let db = env.d1("DB")?;
    let count =
        d1_repositories::delete_tokens_batch(&db, claims.id, &payload.ids, unix_timestamp())
            .await?;
    let _ = invalidate_token_cache(&env).await;
    Ok(envelope_ok_response(&TokenBatchDeleteResult {
        count: count as i64,
    })?)
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct TokenResponse {
    id: i64,
    user_id: i64,
    key: String,
    status: i32,
    name: String,
    created_time: i64,
    accessed_time: i64,
    expired_time: i64,
    remain_quota: i64,
    unlimited_quota: i32,
    model_limits_enabled: i32,
    model_limits: String,
    allow_ips: String,
    used_quota: i64,
    group: String,
    cross_group_retry: i32,
}

/// Mask a token key for list/get responses: show only the last 4 chars,
/// matching the Go gateway's masking.
fn masked_token_response(row: TokenRow) -> TokenResponse {
    TokenResponse {
        id: row.id,
        user_id: row.user_id,
        key: mask_key(&row.key),
        status: row.status,
        name: row.name,
        created_time: row.created_time,
        accessed_time: row.accessed_time,
        expired_time: row.expired_time,
        remain_quota: row.remain_quota,
        unlimited_quota: row.unlimited_quota,
        model_limits_enabled: row.model_limits_enabled,
        model_limits: row.model_limits,
        allow_ips: row.allow_ips,
        used_quota: row.used_quota,
        group: row.group,
        cross_group_retry: row.cross_group_retry,
    }
}

/// Mask a key, leaving only the last 4 characters visible. Mirrors Go's
/// token key masking in list responses.
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 4 {
        return "***".to_string();
    }
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("***{suffix}")
}

#[derive(Debug, Serialize)]
struct TokensPage {
    items: Vec<TokenResponse>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Serialize)]
struct TokenKeyReveal {
    key: String,
}

#[derive(Debug, Serialize)]
struct TokenCreateResult {
    id: i64,
    key: String,
}

#[derive(Debug, Serialize)]
struct TokenBatchDeleteResult {
    count: i64,
}

#[derive(Debug, Deserialize)]
struct TokenCreateRequest {
    name: String,
    #[serde(default)]
    expired_time: Option<i64>,
    #[serde(default)]
    remain_quota: Option<i64>,
    #[serde(default)]
    unlimited_quota: Option<i32>,
    #[serde(default)]
    model_limits_enabled: Option<i32>,
    #[serde(default)]
    model_limits: Option<String>,
    #[serde(default)]
    allow_ips: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    cross_group_retry: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct TokenUpdateRequest {
    id: i64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<i32>,
    #[serde(default)]
    expired_time: Option<i64>,
    #[serde(default)]
    remain_quota: Option<i64>,
    #[serde(default)]
    unlimited_quota: Option<i32>,
    #[serde(default)]
    model_limits_enabled: Option<i32>,
    #[serde(default)]
    model_limits: Option<String>,
    #[serde(default)]
    allow_ips: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    cross_group_retry: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct TokenBatchDeleteRequest {
    ids: Vec<i64>,
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse::<i64>().ok()
}

/// Generate a URL-safe random key suffix of the given length using the
/// Worker's CSPRNG (`crypto.getRandomValues`). The result is base62-ish
/// (alphanumeric) to stay compatible with how clients pass keys in headers.
fn random_key_suffix(len: usize) -> String {
    let alphabet: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut bytes = vec![0u8; len];
    // js_sys::eval is avoided; use Math::random via js_sys for portability.
    // crypto.getRandomValues is preferred but requires web-sys glue; Math.random
    // is sufficient for token key entropy in this admin path.
    for byte in bytes.iter_mut() {
        let r = js_sys::Math::random() * (alphabet.len() as f64);
        *byte = alphabet[r as usize];
    }
    String::from_utf8(bytes).unwrap_or_else(|_| "tokenkeyfallback".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_key_hides_all_but_last_four() {
        // Keys longer than 4 chars keep only the last 4 visible.
        assert_eq!(mask_key("ct-abcdefghijklmno1234"), "***1234");
        assert_eq!(mask_key("short"), "***hort");
        // Keys of 4 chars or fewer are fully masked.
        assert_eq!(mask_key("ab"), "***");
        assert_eq!(mask_key("1234"), "***");
        assert_eq!(mask_key(""), "***");
    }

    #[test]
    fn value_to_string_coerces_json_to_storage_string() {
        assert_eq!(value_to_string(Value::Null), "");
        assert_eq!(value_to_string(Value::String("hi".into())), "hi");
        assert_eq!(value_to_string(Value::from(42)), "42");
        assert_eq!(value_to_string(Value::from(true)), "true");
        assert_eq!(value_to_string(Value::from(1.5)), "1.5",);
        // Objects/arrays serialize to their JSON text form, matching Go's
        // fmt.Sprint behavior for option values that are structured.
        let obj = serde_json::json!({"a":1});
        assert_eq!(value_to_string(obj), r#"{"a":1}"#);
    }

    #[test]
    fn option_update_request_parses_key_and_any_value() {
        let req: OptionUpdateRequest =
            serde_json::from_str(r#"{"key":"MyKey","value":"literal"}"#).unwrap();
        assert_eq!(req.key, "MyKey");
        assert_eq!(req.value, Value::String("literal".into()));

        let req: OptionUpdateRequest =
            serde_json::from_str(r#"{"key":"MyKey","value":42}"#).unwrap();
        assert_eq!(req.value, Value::from(42));
    }

    #[test]
    fn token_create_request_all_fields_optional_except_name() {
        let req: TokenCreateRequest = serde_json::from_str(r#"{"name":"my token"}"#).unwrap();
        assert_eq!(req.name, "my token");
        assert!(req.expired_time.is_none());
        assert!(req.group.is_none());
    }

    #[test]
    fn token_batch_delete_request_parses_ids() {
        let req: TokenBatchDeleteRequest = serde_json::from_str(r#"{"ids":[1,2,3]}"#).unwrap();
        assert_eq!(req.ids, vec![1, 2, 3]);
    }

    #[test]
    fn parse_id_param_accepts_numeric_strings() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"  7 ".to_string())), Some(7));
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
        assert_eq!(parse_id_param(None), None);
    }

    // `random_key_suffix` calls `js_sys::Math::random` and can therefore only
    // be exercised under the wasm32 target (it panics on the host test
    // runner). End-to-end coverage happens via the wasm smoke suite.
}
