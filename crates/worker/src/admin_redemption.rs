//! Admin redemption-code routes (Go controller/redemption.go).

use serde::{Deserialize, Serialize};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    unix_timestamp,
};
use crate::d1_repositories::{self, CreateRedemption, RedemptionRow};

const STATUS_ENABLED: i32 = 1;
const STATUS_DISABLED: i32 = 2;
const STATUS_USED: i32 = 3;
const CURRENT_COMPLIANCE_TERMS_VERSION: &str = "v1";
const PAYMENT_COMPLIANCE_CONFIRMED_KEY: &str = "payment_setting.compliance_confirmed";
const PAYMENT_COMPLIANCE_TERMS_KEY: &str = "payment_setting.compliance_terms_version";

/// `GET /api/redemption/`: admin paginated list.
pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let (items, total) = d1_repositories::list_redemptions(&db, page, page_size).await?;
    Ok(envelope_ok_response(&RedemptionsPage {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/redemption/search`: admin search by id or name prefix.
pub async fn search(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let keyword = parse_query_string(&req, "keyword").unwrap_or_default();
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (items, total) =
        d1_repositories::search_redemptions(&db, &keyword, page, page_size).await?;
    Ok(envelope_ok_response(&RedemptionsPage {
        items,
        total,
        page,
        page_size,
    })?)
}

/// `GET /api/redemption/:id`: admin get one redemption code.
pub async fn get(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(200, "id is required")),
    };
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_redemption_by_id(&db, id).await? else {
        return Ok(envelope_error_response(200, "redemption not found"));
    };
    Ok(envelope_ok_response(&row)?)
}

/// `POST /api/redemption/`: create one or more redemption codes.
pub async fn create(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_redemption_request(&mut req, "redemption create").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    if let Some(message) = validate_create_request(&payload, unix_timestamp()) {
        return Ok(envelope_error_response(200, message));
    }
    let name = payload.name.as_deref().unwrap_or("").trim();
    let quota = clamp_quota(payload.quota.unwrap_or(0));
    let count = payload.count.unwrap_or(1);

    let db = env.d1("DB")?;
    if !payment_compliance_confirmed(&db).await? {
        return Ok(envelope_error_response(
            200,
            "payment compliance is required",
        ));
    }

    let now = unix_timestamp();
    let mut keys = Vec::with_capacity(count.clamp(1, 100) as usize);
    for _ in 0..count {
        let key = generate_redemption_key()?;
        let row = CreateRedemption {
            user_id: claims.id,
            key: &key,
            status: STATUS_ENABLED,
            name,
            quota,
            created_time: now,
            expired_time: payload.expired_time.unwrap_or(0),
        };
        if let Err(err) = d1_repositories::insert_redemption(&db, &row).await {
            let _ = crate::d1_repositories::insert_admin_audit_log(
                &db,
                Some(claims.id),
                Some(&claims.username),
                &claims.username,
                "redemption.create_failed",
                &format!(
                    "admin {} failed to create redemption codes",
                    claims.username
                ),
                &serde_json::json!({"name": name, "created": keys.len()}),
                &crate::admin::admin_audit_info(&claims, &req),
                now,
            )
            .await;
            return Ok(envelope_error_response(
                200,
                &format!("failed to create redemption: {err}"),
            ));
        }
        keys.push(key);
    }

    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "redemption.create",
        &format!(
            "admin {} created {} redemption codes named {}",
            claims.username,
            keys.len(),
            name
        ),
        &serde_json::json!({
            "name": name,
            "count": keys.len(),
            "quota": quota,
            "expired_time": payload.expired_time.unwrap_or(0)
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        now,
    )
    .await;

    Ok(envelope_ok_response(&keys)?)
}

/// `PUT /api/redemption/`: update fields, or status when `?status_only=true`.
pub async fn update(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let status_only = has_query_key(&req, "status_only");
    let payload = match read_redemption_request(&mut req, "redemption update").await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let id = match payload.id.filter(|id| *id > 0) {
        Some(id) => id,
        None => return Ok(envelope_error_response(200, "id is required")),
    };

    let db = env.d1("DB")?;
    if d1_repositories::find_redemption_by_id(&db, id)
        .await?
        .is_none()
    {
        return Ok(envelope_error_response(200, "redemption not found"));
    }

    if status_only {
        let status = match payload.status {
            Some(status) if is_valid_status(status) => status,
            _ => return Ok(envelope_error_response(200, "invalid redemption status")),
        };
        if !d1_repositories::update_redemption_status(&db, id, status).await? {
            return Ok(envelope_error_response(200, "redemption not found"));
        }
    } else {
        if let Some(message) = validate_update_request(&payload, unix_timestamp()) {
            return Ok(envelope_error_response(200, message));
        }
        let name = payload.name.as_deref().unwrap_or("").trim();
        if !d1_repositories::update_redemption_fields(
            &db,
            id,
            name,
            clamp_quota(payload.quota.unwrap_or(0)),
            payload.expired_time.unwrap_or(0),
        )
        .await?
        {
            return Ok(envelope_error_response(200, "redemption not found"));
        }
    }

    let row = d1_repositories::find_redemption_by_id(&db, id)
        .await?
        .ok_or_else(|| worker::Error::RustError("updated redemption disappeared".to_string()))?;

    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        if status_only {
            "redemption.status_update"
        } else {
            "redemption.update"
        },
        &format!("admin {} updated redemption {}", claims.username, id),
        &serde_json::json!({"id": id, "status_only": status_only, "status": row.status}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;

    Ok(envelope_ok_response(&row)?)
}

/// `DELETE /api/redemption/:id`: soft-delete one redemption code.
pub async fn delete(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(200, "id is required")),
    };
    let db = env.d1("DB")?;
    if !d1_repositories::soft_delete_redemption(&db, id, unix_timestamp()).await? {
        return Ok(envelope_error_response(200, "redemption not found"));
    }
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "redemption.delete",
        &format!("admin {} deleted redemption {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

/// `DELETE /api/redemption/invalid`: soft-delete used, disabled, or expired rows.
pub async fn delete_invalid(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let deleted = d1_repositories::soft_delete_invalid_redemptions(&db, unix_timestamp()).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "redemption.delete_invalid",
        &format!(
            "admin {} deleted {} invalid redemptions",
            claims.username, deleted
        ),
        &serde_json::json!({"deleted": deleted}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&deleted)?)
}

#[derive(Debug, Serialize)]
struct RedemptionsPage {
    items: Vec<RedemptionRow>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Deserialize)]
struct RedemptionRequest {
    id: Option<i64>,
    name: Option<String>,
    quota: Option<i64>,
    expired_time: Option<i64>,
    count: Option<i32>,
    status: Option<i32>,
}

async fn read_redemption_request(
    req: &mut Request,
    action: &str,
) -> std::result::Result<RedemptionRequest, Response> {
    let body = read_json_body(req).await?;
    serde_json::from_value(body)
        .map_err(|err| envelope_error_response(400, &format!("invalid {action} request: {err}")))
}

async fn payment_compliance_confirmed(db: &worker::D1Database) -> WorkerResult<bool> {
    let values = d1_repositories::option_values(
        db,
        &[
            PAYMENT_COMPLIANCE_CONFIRMED_KEY,
            PAYMENT_COMPLIANCE_TERMS_KEY,
        ],
    )
    .await?;
    Ok(parse_bool(values[0].as_deref(), false)
        && values[1].as_deref().unwrap_or("") == CURRENT_COMPLIANCE_TERMS_VERSION)
}

fn validate_create_request(payload: &RedemptionRequest, now: i64) -> Option<&'static str> {
    if let Some(message) = validate_common_fields(payload, now) {
        return Some(message);
    }
    match payload.count.unwrap_or(0) {
        1..=100 => None,
        n if n <= 0 => Some("redemption count must be positive"),
        _ => Some("redemption count must be at most 100"),
    }
}

fn validate_update_request(payload: &RedemptionRequest, now: i64) -> Option<&'static str> {
    validate_common_fields(payload, now)
}

fn validate_common_fields(payload: &RedemptionRequest, now: i64) -> Option<&'static str> {
    let name_len = payload.name.as_deref().unwrap_or("").trim().chars().count();
    if name_len == 0 || name_len > 20 {
        return Some("redemption name must be 1-20 characters");
    }
    let expired_time = payload.expired_time.unwrap_or(0);
    if expired_time != 0 && expired_time < now {
        return Some("redemption expire time is invalid");
    }
    None
}

fn is_valid_status(status: i32) -> bool {
    matches!(status, STATUS_ENABLED | STATUS_DISABLED | STATUS_USED)
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    value
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(default)
}

fn clamp_quota(value: i64) -> i64 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX))
}

fn generate_redemption_key() -> WorkerResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|err| {
        worker::Error::RustError(format!("redemption key generation failed: {err}"))
    })?;
    Ok(hex_lower(&bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize]);
        out.push(HEX[(byte & 0x0f) as usize]);
    }
    String::from_utf8(out).unwrap_or_default()
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let page = parse_query_u32(req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(req, "page_size")
        .or_else(|| parse_query_u32(req, "ps"))
        .or_else(|| parse_query_u32(req, "size"))
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

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn has_query_key(req: &Request, key: &str) -> bool {
    req.url()
        .ok()
        .is_some_and(|url| url.query_pairs().any(|(k, _)| k == key))
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().trim_end_matches('/').parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_matches_go_create_bounds() {
        let now = 1_700_000_000;
        let mut req = RedemptionRequest {
            id: None,
            name: Some("promo".to_string()),
            quota: Some(100),
            expired_time: Some(now + 60),
            count: Some(1),
            status: None,
        };
        assert_eq!(validate_create_request(&req, now), None);
        req.name = Some("".to_string());
        assert_eq!(
            validate_create_request(&req, now),
            Some("redemption name must be 1-20 characters")
        );
        req.name = Some("promo".to_string());
        req.count = Some(101);
        assert_eq!(
            validate_create_request(&req, now),
            Some("redemption count must be at most 100")
        );
        req.count = Some(0);
        assert_eq!(
            validate_create_request(&req, now),
            Some("redemption count must be positive")
        );
        req.count = Some(1);
        req.expired_time = Some(now - 1);
        assert_eq!(
            validate_create_request(&req, now),
            Some("redemption expire time is invalid")
        );
    }

    #[test]
    fn status_and_bool_parsers_are_strict_enough_for_frontend() {
        assert!(is_valid_status(STATUS_ENABLED));
        assert!(is_valid_status(STATUS_DISABLED));
        assert!(is_valid_status(STATUS_USED));
        assert!(!is_valid_status(0));
        assert!(parse_bool(Some("true"), false));
        assert!(parse_bool(Some("1"), false));
        assert!(!parse_bool(Some("false"), true));
    }

    #[test]
    fn generated_key_shape_matches_go_uuid_without_dashes() {
        let key = hex_lower(&[0xab; 16]);
        assert_eq!(key.len(), 32);
        assert_eq!(key, "abababababababababababababababab");
    }
}
