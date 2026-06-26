//! Dashboard data endpoints (G5): quota trend analytics for the React
//! dashboard's charts.
//!
//! Mirrors Go `controller/usedata.go` (`/api/data/*`) and
//! `controller/token.go::GetTokenUsage` (`/api/usage/token/`). Unlike the Go
//! gateway (which reads from a pre-aggregated `quota_data` table), the Rust
//! port computes trends live from the `logs` table — D1's `(created_at, type)`
//! index makes this efficient enough for typical traffic, and avoids the need
//! for a background flush job. A future Cron Trigger + `quota_data` table can
//! replace this for very high-traffic deployments.

use serde::Serialize;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, require_admin_auth, require_user_auth,
};
use crate::d1_repositories;

const SELF_DATA_MAX_RANGE_SECONDS: i64 = 2_592_000; // 30 days, matching Go.

// ---------------------------------------------------------------------------
// /api/data/* — quota trend
// ---------------------------------------------------------------------------

/// `GET /api/data/`: admin quota trend by model. AdminAuth.
pub async fn quota_trend_by_model(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let (start, end) = parse_time_range(&req);
    let username = parse_query_string(&req, "username");
    let db = env.d1("DB")?;
    let rows = d1_repositories::quota_trend_by_model(&db, start, end, username.as_deref()).await?;
    Ok(envelope_ok_response(&rows)?)
}

/// `GET /api/data/self`: current user's quota trend. UserAuth.
pub async fn quota_trend_self(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let (start, end) = parse_time_range(&req);
    if end - start > SELF_DATA_MAX_RANGE_SECONDS {
        return Ok(envelope_error_response(
            400,
            "time range must not exceed 30 days",
        ));
    }
    let db = env.d1("DB")?;
    let rows = d1_repositories::quota_trend_by_user_id(&db, claims.id, start, end).await?;
    Ok(envelope_ok_response(&rows)?)
}

/// `GET /api/data/users`: admin quota trend by user. AdminAuth.
pub async fn quota_trend_by_user(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let (start, end) = parse_time_range(&req);
    let db = env.d1("DB")?;
    let rows = d1_repositories::quota_trend_by_user(&db, start, end).await?;
    Ok(envelope_ok_response(&rows)?)
}

// ---------------------------------------------------------------------------
// /api/usage/token/ — OpenAI-style token usage
// ---------------------------------------------------------------------------

/// `GET /api/usage/token/`: OpenAI-compatible token usage query. Auth is via
/// the relay token (Bearer `sk-...`), the same auth used by `/v1/chat/completions`.
/// Returns a `{code, message, data}` envelope (non-standard, matching Go).
pub async fn token_usage(req: Request, env: Env) -> WorkerResult<Response> {
    let api_key = match extract_bearer_token(&req) {
        Some(key) => key,
        None => {
            return Ok(envelope_error_response(
                401,
                "missing or invalid Authorization header",
            ));
        }
    };
    let db = env.d1("DB")?;
    // Lightweight token usage query — returns just the fields needed for the
    // OpenAI-style usage envelope. Does not go through the relay auth cache
    // since this is a low-frequency dashboard endpoint.
    #[derive(serde::Deserialize)]
    struct TokenUsageRow {
        name: String,
        remain_quota: i64,
        used_quota: i64,
        unlimited_quota: i32,
    }
    use worker::D1Type;
    let key_arg = D1Type::Text(api_key.as_str());
    let row = db
        .prepare(
            r#"
            SELECT name, remain_quota, used_quota, unlimited_quota
            FROM tokens
            WHERE "key" = ?1 AND deleted_at IS NULL AND status = 1
            LIMIT 1
            "#,
        )
        .bind_refs(&[key_arg])?
        .first::<TokenUsageRow>(None)
        .await?;
    let Some(token) = row else {
        return Ok(envelope_error_response(401, "invalid token"));
    };
    let total_available = if token.unlimited_quota != 0 {
        i64::MAX
    } else {
        token.remain_quota
    };
    let total_granted = if token.unlimited_quota != 0 {
        i64::MAX
    } else {
        token.used_quota + token.remain_quota
    };
    let body = TokenUsageResponse {
        code: true,
        message: "ok".to_string(),
        data: TokenUsageData {
            object: "token_usage".to_string(),
            name: token.name,
            total_granted,
            total_used: token.used_quota,
            total_available,
        },
    };
    let mut response = Response::from_json(&body)?.with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_time_range(req: &Request) -> (i64, i64) {
    let start = parse_query_i64(req, "start_timestamp").unwrap_or(0);
    let end = parse_query_i64(req, "end_timestamp").unwrap_or(i64::MAX);
    (start, end)
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

fn extract_bearer_token(req: &Request) -> Option<String> {
    let header = req.headers().get("Authorization").ok().flatten()?;
    let trimmed = header.trim();
    if let Some(rest) = trimmed.strip_prefix("Bearer ") {
        let token = rest.trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    // Some clients send the key directly without the Bearer prefix.
    let token = trimmed.trim();
    if !token.is_empty() {
        Some(token.to_string())
    } else {
        None
    }
}

#[derive(Debug, Serialize)]
struct TokenUsageResponse {
    code: bool,
    message: String,
    data: TokenUsageData,
}

#[derive(Debug, Serialize)]
struct TokenUsageData {
    object: String,
    name: String,
    total_granted: i64,
    total_used: i64,
    total_available: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_data_max_range_is_30_days() {
        assert_eq!(SELF_DATA_MAX_RANGE_SECONDS, 2_592_000);
    }
}
