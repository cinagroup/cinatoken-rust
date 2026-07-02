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

// ---------------------------------------------------------------------------
// /dashboard/billing/* — OpenAI-compatible billing views (Go billing.go)
// ---------------------------------------------------------------------------

/// Token/user quota stats for the billing endpoints. Honors Go's
/// `DisplayTokenStatEnabled` (default true → the calling TOKEN's stats;
/// false → the owning user's stats). Amounts are the USD-style display value
/// `quota / QuotaPerUnit` (Go's default quota display type; CNY/tokens display
/// variants are deferred).
async fn billing_stats(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<(f64, f64, i64), Response>> {
    let api_key = match extract_bearer_token(req) {
        Some(key) => key,
        None => {
            return Ok(Err(envelope_error_response(
                401,
                "missing or invalid Authorization header",
            )));
        }
    };
    let db = env.d1("DB")?;
    use worker::D1Type;
    #[derive(serde::Deserialize)]
    struct TokenRow {
        user_id: i64,
        remain_quota: i64,
        used_quota: i64,
        unlimited_quota: i32,
        expired_time: i64,
    }
    let key_arg = D1Type::Text(api_key.as_str());
    let row = db
        .prepare(
            r#"SELECT user_id, remain_quota, used_quota, unlimited_quota, expired_time
               FROM tokens WHERE "key" = ?1 AND deleted_at IS NULL AND status = 1 LIMIT 1"#,
        )
        .bind_refs(&[key_arg])?
        .first::<TokenRow>(None)
        .await?;
    let Some(token) = row else {
        return Ok(Err(envelope_error_response(401, "invalid token")));
    };
    let display_token_stats = d1_repositories::get_option(&db, "DisplayTokenStatEnabled")
        .await?
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let quota_per_unit = d1_repositories::get_option(&db, "QuotaPerUnit")
        .await?
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(500_000.0);

    let (remain, used, expired_time, unlimited) = if display_token_stats {
        (
            token.remain_quota,
            token.used_quota,
            token.expired_time.max(0),
            token.unlimited_quota != 0,
        )
    } else {
        #[derive(serde::Deserialize)]
        struct UserRow {
            quota: i64,
            used_quota: i64,
        }
        let user_arg = D1Type::Integer((token.user_id).min(i64::from(i32::MAX)) as i32);
        let user = db
            .prepare(r#"SELECT quota, used_quota FROM users WHERE id = ?1 LIMIT 1"#)
            .bind_refs(&[user_arg])?
            .first::<UserRow>(None)
            .await?;
        let Some(user) = user else {
            return Ok(Err(envelope_error_response(401, "user not found")));
        };
        (user.quota, user.used_quota, 0, false)
    };
    // Subscription limit: remain+used (the token's total allocation); Go caps
    // unlimited tokens at the sentinel 100000000.
    let limit = if unlimited {
        100_000_000.0
    } else {
        (remain + used) as f64 / quota_per_unit
    };
    let used_amount = used as f64 / quota_per_unit;
    Ok(Ok((limit, used_amount, expired_time)))
}

/// `GET /dashboard/billing/subscription` (+ `/v1` alias): OpenAI-style
/// subscription view of the token's allocation (Go `GetSubscription`).
pub async fn billing_subscription(req: Request, env: Env) -> WorkerResult<Response> {
    let (limit, _used, expired_time) = match billing_stats(&req, &env).await? {
        Ok(stats) => stats,
        Err(response) => return Ok(response),
    };
    Response::from_json(&serde_json::json!({
        "object": "billing_subscription",
        "has_payment_method": true,
        "soft_limit_usd": limit,
        "hard_limit_usd": limit,
        "system_hard_limit_usd": limit,
        "access_until": expired_time,
    }))
}

/// `GET /dashboard/billing/usage` (+ `/v1` alias): OpenAI-style usage total
/// in cents (Go `GetUsage`: `amount * 100`).
pub async fn billing_usage(req: Request, env: Env) -> WorkerResult<Response> {
    let (_limit, used, _expired) = match billing_stats(&req, &env).await? {
        Ok(stats) => stats,
        Err(response) => return Ok(response),
    };
    Response::from_json(&serde_json::json!({
        "object": "list",
        "total_usage": used * 100.0,
    }))
}
