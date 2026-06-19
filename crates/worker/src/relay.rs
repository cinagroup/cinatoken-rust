use cinatoken_cache::{ExpiringCounterRateLimiter, KeyValueCache, RateLimiter, UpstashRedis};
use cinatoken_core::{ApiError, ApiResult, ErrorBody};
use cinatoken_relay::{
    apply_model_mapping, clamp_i64_to_i32 as d1_i32, csv_contains, first_channel_key,
    ip_allowlist_matches, is_openai_compatible_channel_type, upstream_v1_url,
    usage_summary_from_body, CachedAuthenticatedToken, CachedRelayChannel, RelayCacheKeys,
    UsageSummary,
};
use cinatoken_storage::{AuthenticatedToken, RelayAuditLog, RelayChannel};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{D1Database, D1Type, Env, Fetch, Headers, Method, Request, RequestInit, Response};

use crate::{json_with_status, set_cors_headers};

const TOKEN_STATUS_EXPIRED: i32 = 3;
const TOKEN_STATUS_EXHAUSTED: i32 = 4;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS: u32 = 60;
const TOKEN_RATE_LIMIT_ENV: &str = "RELAY_TOKEN_RATE_LIMIT_PER_WINDOW";
const IP_RATE_LIMIT_ENV: &str = "RELAY_IP_RATE_LIMIT_PER_WINDOW";
const RATE_LIMIT_WINDOW_ENV: &str = "RELAY_RATE_LIMIT_WINDOW_SECONDS";
const RELAY_CACHE_TTL_ENV: &str = "RELAY_CACHE_TTL_SECONDS";
const DEFAULT_RELAY_CACHE_TTL_SECONDS: u32 = 60;

#[derive(Clone, Copy)]
struct OpenAiCompatibleEndpoint {
    display_name: &'static str,
    upstream_path: &'static str,
    stream_not_implemented_feature: Option<&'static str>,
}

pub async fn chat_completions(req: Request, env: Env) -> worker::Result<Response> {
    openai_compatible_endpoint(
        req,
        env,
        OpenAiCompatibleEndpoint {
            display_name: "chat completions",
            upstream_path: "chat/completions",
            stream_not_implemented_feature: Some("streaming chat completions relay"),
        },
    )
    .await
}

pub async fn embeddings(req: Request, env: Env) -> worker::Result<Response> {
    openai_compatible_endpoint(
        req,
        env,
        OpenAiCompatibleEndpoint {
            display_name: "embeddings",
            upstream_path: "embeddings",
            stream_not_implemented_feature: None,
        },
    )
    .await
}

pub async fn completions(req: Request, env: Env) -> worker::Result<Response> {
    openai_compatible_endpoint(
        req,
        env,
        OpenAiCompatibleEndpoint {
            display_name: "completions",
            upstream_path: "completions",
            stream_not_implemented_feature: Some("streaming completions relay"),
        },
    )
    .await
}

pub async fn responses(req: Request, env: Env) -> worker::Result<Response> {
    openai_compatible_endpoint(
        req,
        env,
        OpenAiCompatibleEndpoint {
            display_name: "responses",
            upstream_path: "responses",
            stream_not_implemented_feature: Some("streaming responses relay"),
        },
    )
    .await
}

async fn openai_compatible_endpoint(
    mut req: Request,
    env: Env,
    endpoint: OpenAiCompatibleEndpoint,
) -> worker::Result<Response> {
    let started_at = unix_timestamp();
    let client_ip = client_ip(&req);
    let request_id = request_id(&req);

    let request_body = match req.json::<Value>().await {
        Ok(body) => body,
        Err(err) => {
            return json_with_status(
                &ErrorBody::bad_request(format!(
                    "invalid {} request body: {err}",
                    endpoint.display_name
                )),
                400,
            );
        }
    };

    if endpoint.stream_not_implemented_feature.is_some()
        && request_body
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return json_with_status(
            &ErrorBody::not_implemented(endpoint.stream_not_implemented_feature.unwrap()),
            501,
        );
    }

    let model = match request_body.get("model").and_then(Value::as_str) {
        Some(model) if !model.trim().is_empty() => model.trim().to_string(),
        _ => {
            return json_with_status(
                &ErrorBody::bad_request("request body must include a non-empty model"),
                400,
            );
        }
    };

    let api_key = match extract_api_key(&req) {
        Some(key) => key,
        None => {
            return json_with_status(
                &ErrorBody::bad_request("missing Authorization Bearer token or x-api-key"),
                401,
            );
        }
    };

    let db = env.d1("DB")?;
    let auth = match authenticate(&db, &env, &api_key, &model, client_ip.as_deref()).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };

    if let Err(response) = enforce_relay_rate_limits(&env, &auth, client_ip.as_deref()).await {
        return response;
    }

    let channel = match select_channel(&db, &env, &model, auth.effective_group()).await {
        Ok(channel) => channel,
        Err(response) => return response,
    };

    let upstream_key = match first_channel_key(&channel.key) {
        Some(key) => key,
        None => {
            return json_with_status(
                &ErrorBody::bad_request(format!(
                    "channel {} has no usable upstream key",
                    channel.id
                )),
                502,
            );
        }
    };

    let mut upstream_body = request_body;
    apply_model_mapping(&mut upstream_body, &model, channel.model_mapping.as_deref());

    let upstream_url = upstream_v1_url(
        channel.channel_type,
        channel.base_url.as_deref(),
        endpoint.upstream_path,
    );
    let upstream_response =
        match forward_openai_compatible(&upstream_url, &upstream_key, &channel, &upstream_body)
            .await
        {
            Ok(response) => response,
            Err(err) => {
                return json_with_status(
                    &ErrorBody::bad_request(format!(
                        "upstream request failed for channel {} ({}): {err}",
                        channel.id, channel.name
                    )),
                    502,
                );
            }
        };

    complete_relay_response(
        upstream_response,
        &db,
        &auth,
        &channel,
        &model,
        auth.effective_group(),
        endpoint.upstream_path,
        RelayAuditContext {
            started_at,
            client_ip: client_ip.as_deref(),
            request_id: request_id.as_deref(),
        },
    )
    .await
}

pub(crate) fn relay_rate_limit_configured(env: &Env) -> bool {
    let Ok(config) = RelayRateLimitConfig::from_env(env) else {
        return false;
    };
    config.enabled() && crate::cache::upstash_redis_configured(env)
}

pub(crate) fn relay_read_cache_configured(env: &Env) -> bool {
    let Ok(config) = RelayReadCacheConfig::from_env(env) else {
        return false;
    };
    config.enabled() && crate::cache::upstash_redis_configured(env)
}

async fn enforce_relay_rate_limits(
    env: &Env,
    auth: &AuthenticatedToken,
    client_ip: Option<&str>,
) -> Result<(), worker::Result<Response>> {
    let config = RelayRateLimitConfig::from_env(env).map_err(|err| {
        openai_error_response(
            format!("invalid relay rate limit configuration: {err}"),
            500,
        )
    })?;
    if !config.enabled() {
        return Ok(());
    }

    let redis = match crate::cache::upstash_redis_from_env(env) {
        Ok(Some(redis)) => redis,
        Ok(None) => {
            worker::console_warn!(
                "relay rate limit is configured but Upstash Redis is not configured; skipping"
            );
            return Ok(());
        }
        Err(err) => {
            return Err(openai_error_response(
                format!("failed to initialize rate limit cache: {err}"),
                500,
            ));
        }
    };

    let limiter = ExpiringCounterRateLimiter::new(redis, "relay:rate");
    if let Some(limit) = config.token_limit_per_window {
        let key = format!("token:{}", auth.token_id);
        let allowed = limiter
            .check(&key, limit, config.window_seconds)
            .await
            .map_err(|err| rate_limit_failure_response(err.to_string()))?;
        if !allowed {
            return Err(rate_limited_response(
                "token rate limit exceeded",
                config.window_seconds,
            ));
        }
    }

    if let (Some(limit), Some(ip)) = (config.ip_limit_per_window, client_ip) {
        let ip = ip.trim();
        if !ip.is_empty() {
            let key = format!("ip:{ip}");
            let allowed = limiter
                .check(&key, limit, config.window_seconds)
                .await
                .map_err(|err| rate_limit_failure_response(err.to_string()))?;
            if !allowed {
                return Err(rate_limited_response(
                    "IP rate limit exceeded",
                    config.window_seconds,
                ));
            }
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayRateLimitConfig {
    token_limit_per_window: Option<u32>,
    ip_limit_per_window: Option<u32>,
    window_seconds: u32,
}

impl RelayRateLimitConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(
            optional_env_var(env, TOKEN_RATE_LIMIT_ENV),
            optional_env_var(env, IP_RATE_LIMIT_ENV),
            optional_env_var(env, RATE_LIMIT_WINDOW_ENV),
        )
    }

    fn from_raw(
        token_limit: Option<String>,
        ip_limit: Option<String>,
        window_seconds: Option<String>,
    ) -> Result<Self, String> {
        let token_limit_per_window = parse_optional_limit(TOKEN_RATE_LIMIT_ENV, token_limit)?;
        let ip_limit_per_window = parse_optional_limit(IP_RATE_LIMIT_ENV, ip_limit)?;
        let window_seconds = match window_seconds.as_deref().map(str::trim) {
            Some("") | None => DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
            Some(raw) => raw
                .parse::<u32>()
                .map_err(|_| format!("{RATE_LIMIT_WINDOW_ENV} must be a positive integer"))?,
        };
        if window_seconds == 0 {
            return Err(format!("{RATE_LIMIT_WINDOW_ENV} must be greater than 0"));
        }

        Ok(Self {
            token_limit_per_window,
            ip_limit_per_window,
            window_seconds,
        })
    }

    fn enabled(&self) -> bool {
        self.token_limit_per_window.is_some() || self.ip_limit_per_window.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayReadCacheConfig {
    ttl_seconds: Option<u32>,
}

impl RelayReadCacheConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(optional_env_var(env, RELAY_CACHE_TTL_ENV))
    }

    fn from_raw(ttl_seconds: Option<String>) -> Result<Self, String> {
        let ttl_seconds = match ttl_seconds.as_deref().map(str::trim) {
            Some("0") => None,
            Some("") | None => Some(DEFAULT_RELAY_CACHE_TTL_SECONDS),
            Some(raw) => Some(
                raw.parse::<u32>()
                    .map_err(|_| format!("{RELAY_CACHE_TTL_ENV} must be a non-negative integer"))?,
            ),
        };

        Ok(Self { ttl_seconds })
    }

    fn enabled(&self) -> bool {
        self.ttl_seconds.is_some()
    }
}

fn optional_env_var(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_optional_limit(name: &str, value: Option<String>) -> Result<Option<u32>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value == "0" {
        return Ok(None);
    }
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("{name} must be a non-negative integer"))?;
    Ok((parsed > 0).then_some(parsed))
}

fn rate_limited_response(message: &str, window_seconds: u32) -> worker::Result<Response> {
    let mut response = json_with_status(
        &ErrorBody::rate_limited(format!("{message}; retry after {window_seconds} seconds")),
        429,
    )?;
    response
        .headers_mut()
        .set("retry-after", &window_seconds.to_string())?;
    Ok(response)
}

fn rate_limit_failure_response(message: String) -> worker::Result<Response> {
    openai_error_response(format!("rate limit check failed: {message}"), 503)
}

fn relay_read_cache(
    env: &Env,
) -> Result<
    Option<(UpstashRedis<crate::cache::WorkerRedisRestTransport>, u32)>,
    worker::Result<Response>,
> {
    let config = RelayReadCacheConfig::from_env(env).map_err(|err| {
        openai_error_response(format!("invalid relay cache configuration: {err}"), 500)
    })?;
    let Some(ttl_seconds) = config.ttl_seconds else {
        return Ok(None);
    };

    crate::cache::upstash_redis_from_env(env)
        .map(|redis| redis.map(|redis| (redis, ttl_seconds)))
        .map_err(|err| {
            openai_error_response(format!("failed to initialize relay cache: {err}"), 500)
        })
}

fn extract_api_key(req: &Request) -> Option<String> {
    let authorization = req.headers().get("authorization").ok().flatten();
    if let Some(value) = authorization {
        let value = value.trim();
        if let Some(token) = value.strip_prefix("Bearer ") {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    req.headers()
        .get("x-api-key")
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn authenticate(
    db: &D1Database,
    env: &Env,
    api_key: &str,
    model: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let Some((redis, ttl_seconds)) = relay_read_cache(env)? else {
        return authenticate_from_d1(db, api_key, model, client_ip).await;
    };
    let cache_key = RelayCacheKeys::default().token_auth(api_key, model, client_ip);

    match read_cached_authenticated_token(&redis, &cache_key).await {
        Ok(Some(row)) => return validate_authenticated_token(db, row, model, client_ip).await,
        Ok(None) => {}
        Err(err) => worker::console_warn!("failed to read relay auth cache: {}", err),
    }

    let row = authenticate_from_d1(db, api_key, model, client_ip).await?;
    if let Err(err) = write_cached_authenticated_token(&redis, &cache_key, &row, ttl_seconds).await
    {
        worker::console_warn!("failed to write relay auth cache: {}", err);
    }
    Ok(row)
}

async fn authenticate_from_d1(
    db: &D1Database,
    api_key: &str,
    model: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let stmt = db.prepare(
        r#"
        SELECT
          t.id AS token_id,
          t.user_id AS user_id,
          t.name AS token_name,
          t.status AS token_status,
          t.expired_time AS expired_time,
          t.remain_quota AS remain_quota,
          t.unlimited_quota AS unlimited_quota,
          t.model_limits_enabled AS model_limits_enabled,
          t.model_limits AS model_limits,
          t.allow_ips AS allow_ips,
          t."group" AS token_group,
          u.username AS username,
          u.status AS user_status,
          u.quota AS user_quota,
          u."group" AS user_group
        FROM tokens t
        JOIN users u ON u.id = t.user_id
        WHERE t."key" = ?1
          AND t.deleted_at IS NULL
          AND u.deleted_at IS NULL
        LIMIT 1
        "#,
    );
    let key_arg = D1Type::Text(api_key);
    let row = stmt
        .bind_refs(&key_arg)
        .map_err(worker_error_response)?
        .first::<AuthenticatedToken>(None)
        .await
        .map_err(worker_error_response)?
        .ok_or_else(|| openai_error_response("invalid API key", 401))?;

    validate_authenticated_token(db, row, model, client_ip).await
}

async fn validate_authenticated_token(
    db: &D1Database,
    row: AuthenticatedToken,
    model: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    if row.token_status != 1 || row.user_status != 1 {
        return Err(openai_error_response("token or user is disabled", 403));
    }
    if row.expired_time != -1 && row.expired_time < unix_timestamp() {
        mark_token_status(db, row.token_id, TOKEN_STATUS_EXPIRED).await;
        return Err(openai_error_response("token is expired", 403));
    }
    if !row.has_unlimited_quota() && row.remain_quota <= 0 {
        mark_token_status(db, row.token_id, TOKEN_STATUS_EXHAUSTED).await;
        return Err(openai_error_response("token quota is exhausted", 403));
    }
    if row.user_quota <= 0 {
        return Err(openai_error_response("user quota is exhausted", 403));
    }
    if row.has_model_limits() && !csv_contains(&row.model_limits, model) {
        return Err(openai_error_response(
            format!("model {model} is not allowed for this token"),
            403,
        ));
    }
    if !ip_allowlist_matches(&row.allow_ips, client_ip) {
        return Err(openai_error_response(
            "client IP is not allowed for this token",
            403,
        ));
    }

    Ok(row)
}

async fn read_cached_authenticated_token<C>(
    cache: &C,
    cache_key: &str,
) -> ApiResult<Option<AuthenticatedToken>>
where
    C: KeyValueCache,
{
    let Some(value) = cache.get_string(cache_key).await? else {
        return Ok(None);
    };
    let cached = serde_json::from_str::<CachedAuthenticatedToken>(&value).map_err(|err| {
        ApiError::Internal(format!("failed to decode relay auth cache entry: {err}"))
    })?;
    Ok(cached.into_current())
}

async fn write_cached_authenticated_token<C>(
    cache: &C,
    cache_key: &str,
    row: &AuthenticatedToken,
    ttl_seconds: u32,
) -> ApiResult<()>
where
    C: KeyValueCache,
{
    let value =
        serde_json::to_string(&CachedAuthenticatedToken::new(row.clone())).map_err(|err| {
            ApiError::Internal(format!("failed to encode relay auth cache entry: {err}"))
        })?;
    cache.put_string(cache_key, &value, Some(ttl_seconds)).await
}

async fn mark_token_status(db: &D1Database, token_id: i64, status: i32) {
    let args = [
        D1Type::Integer(status),
        D1Type::Integer(d1_i32(unix_timestamp())),
        D1Type::Integer(d1_i32(token_id)),
    ];
    let result = match db
        .prepare("UPDATE tokens SET status = ?1, accessed_time = ?2 WHERE id = ?3")
        .bind_refs(&args)
    {
        Ok(stmt) => stmt.run().await.map(|_| ()),
        Err(err) => Err(err),
    };
    if let Err(err) = result {
        worker::console_warn!("failed to update token status: {}", err);
    }
}

async fn select_channel(
    db: &D1Database,
    env: &Env,
    model: &str,
    group: &str,
) -> Result<RelayChannel, worker::Result<Response>> {
    let Some((redis, ttl_seconds)) = relay_read_cache(env)? else {
        return select_channel_from_d1(db, model, group).await;
    };
    let cache_key = RelayCacheKeys::default().channel(group, model);

    match read_cached_relay_channel(&redis, &cache_key).await {
        Ok(Some(channel)) => return Ok(channel),
        Ok(None) => {}
        Err(err) => worker::console_warn!("failed to read relay channel cache: {}", err),
    }

    let channel = select_channel_from_d1(db, model, group).await?;
    if let Err(err) = write_cached_relay_channel(&redis, &cache_key, &channel, ttl_seconds).await {
        worker::console_warn!("failed to write relay channel cache: {}", err);
    }
    Ok(channel)
}

async fn select_channel_from_d1(
    db: &D1Database,
    model: &str,
    group: &str,
) -> Result<RelayChannel, worker::Result<Response>> {
    if let Some(channel) = select_channel_from_abilities(db, model, group).await? {
        return Ok(channel);
    }

    select_channel_from_channel_csv(db, model, group).await
}

async fn read_cached_relay_channel<C>(cache: &C, cache_key: &str) -> ApiResult<Option<RelayChannel>>
where
    C: KeyValueCache,
{
    let Some(value) = cache.get_string(cache_key).await? else {
        return Ok(None);
    };
    let cached = serde_json::from_str::<CachedRelayChannel>(&value).map_err(|err| {
        ApiError::Internal(format!("failed to decode relay channel cache entry: {err}"))
    })?;
    Ok(cached.into_current())
}

async fn write_cached_relay_channel<C>(
    cache: &C,
    cache_key: &str,
    channel: &RelayChannel,
    ttl_seconds: u32,
) -> ApiResult<()>
where
    C: KeyValueCache,
{
    let value =
        serde_json::to_string(&CachedRelayChannel::new(channel.clone())).map_err(|err| {
            ApiError::Internal(format!("failed to encode relay channel cache entry: {err}"))
        })?;
    cache.put_string(cache_key, &value, Some(ttl_seconds)).await
}

async fn select_channel_from_abilities(
    db: &D1Database,
    model: &str,
    group: &str,
) -> Result<Option<RelayChannel>, worker::Result<Response>> {
    let group_arg = D1Type::Text(group);
    let model_arg = D1Type::Text(model);
    let args = [group_arg, model_arg];
    let rows = db
        .prepare(
            r#"
            SELECT
              c.id,
              c.type AS channel_type,
              c."key",
              c.name,
              c.base_url,
              c.models,
              c."group" AS channel_group,
              c.model_mapping,
              c.openai_organization
            FROM abilities a
            JOIN channels c ON c.id = a.channel_id
            WHERE a.group_name = ?1
              AND a.model = ?2
              AND a.enabled = 1
              AND c.status = 1
              AND c.type IN (1, 20, 40, 42, 43, 48, 53)
            ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC
            LIMIT 50
            "#,
        )
        .bind_refs(&args)
        .map_err(worker_error_response)?
        .all()
        .await
        .map_err(worker_error_response)?
        .results::<RelayChannel>()
        .map_err(worker_error_response)?;

    Ok(rows.into_iter().next())
}

async fn select_channel_from_channel_csv(
    db: &D1Database,
    model: &str,
    group: &str,
) -> Result<RelayChannel, worker::Result<Response>> {
    let rows = db
        .prepare(
            r#"
            SELECT
              id,
              type AS channel_type,
              "key",
              name,
              base_url,
              models,
              "group" AS channel_group,
              model_mapping,
              openai_organization
            FROM channels
            WHERE status = 1
              AND type IN (1, 20, 40, 42, 43, 48, 53)
            ORDER BY priority DESC, id ASC
            LIMIT 50
            "#,
        )
        .all()
        .await
        .map_err(worker_error_response)?
        .results::<RelayChannel>()
        .map_err(worker_error_response)?;

    rows.into_iter()
        .find(|channel| {
            is_openai_compatible_channel_type(channel.channel_type)
                && csv_contains(&channel.channel_group, group)
                && (channel.models.trim().is_empty() || csv_contains(&channel.models, model))
        })
        .ok_or_else(|| {
            openai_error_response(
                format!(
                    "no enabled OpenAI-compatible channel or ability for model {model} in group {group}"
                ),
                503,
            )
        })
}

async fn forward_openai_compatible(
    url: &str,
    upstream_key: &str,
    channel: &RelayChannel,
    body: &Value,
) -> worker::Result<Response> {
    let body = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &format!("Bearer {upstream_key}"))?;
    if let Some(org) = channel
        .openai_organization
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.set("openai-organization", org)?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn complete_relay_response(
    mut upstream: Response,
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel: &RelayChannel,
    model: &str,
    group: &str,
    endpoint_path: &str,
    audit: RelayAuditContext<'_>,
) -> worker::Result<Response> {
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_else(|| "application/json".to_string());
    let upstream_request_id = response_header(&upstream, &["x-request-id", "cf-ray"]);
    let body = upstream.text().await?;
    let usage = usage_summary_from_body(&body);

    if let Err(err) = record_relay_audit(
        db,
        auth,
        channel,
        model,
        group,
        endpoint_path,
        status,
        &usage,
        RelayAuditContext {
            started_at: audit.started_at,
            client_ip: audit.client_ip,
            request_id: audit.request_id,
        },
        upstream_request_id.as_deref(),
    )
    .await
    {
        worker::console_error!("failed to record relay audit: {}", err);
    }

    let mut response = Response::ok(body)?.with_status(status);
    response.headers_mut().set("content-type", &content_type)?;
    set_cors_headers(&mut response)?;
    Ok(response)
}

#[derive(Clone, Copy)]
struct RelayAuditContext<'a> {
    started_at: i64,
    client_ip: Option<&'a str>,
    request_id: Option<&'a str>,
}

async fn record_relay_audit(
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel: &RelayChannel,
    model: &str,
    group: &str,
    endpoint_path: &str,
    upstream_status: u16,
    usage: &UsageSummary,
    audit: RelayAuditContext<'_>,
    upstream_request_id: Option<&str>,
) -> worker::Result<()> {
    let now = unix_timestamp();
    let token_touch_args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(auth.token_id)),
    ];
    db.prepare("UPDATE tokens SET accessed_time = ?1 WHERE id = ?2")
        .bind_refs(&token_touch_args)?
        .run()
        .await?;

    let user_request_args = [D1Type::Integer(d1_i32(auth.user_id))];
    db.prepare("UPDATE users SET request_count = request_count + 1 WHERE id = ?1")
        .bind_refs(&user_request_args)?
        .run()
        .await?;

    let use_time = now.saturating_sub(audit.started_at);
    let other_json = json!({
        "billing_pending": true,
        "relay_runtime": "cloudflare_worker_rust",
        "endpoint": endpoint_path,
        "upstream_status": upstream_status,
        "total_tokens": usage.total_tokens,
    })
    .to_string();
    let empty = "";
    let audit_log = RelayAuditLog {
        user_id: auth.user_id,
        username: &auth.username,
        token_id: auth.token_id,
        token_name: &auth.token_name,
        channel_id: channel.id,
        model,
        group,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        quota: 0,
        use_time_seconds: use_time,
        is_stream: false,
        ip: audit.client_ip.unwrap_or(empty),
        request_id: audit.request_id.unwrap_or(empty),
        upstream_request_id: upstream_request_id.unwrap_or(empty),
        other: &other_json,
    };

    let content = format!("Rust relay forwarded {endpoint_path}; quota settlement pending");
    let log_args = [
        D1Type::Integer(d1_i32(audit_log.user_id)),
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(2),
        D1Type::Text(&content),
        D1Type::Text(audit_log.username),
        D1Type::Text(audit_log.token_name),
        D1Type::Text(audit_log.model),
        D1Type::Integer(d1_i32(audit_log.quota)),
        D1Type::Integer(audit_log.prompt_tokens),
        D1Type::Integer(audit_log.completion_tokens),
        D1Type::Integer(d1_i32(audit_log.use_time_seconds)),
        D1Type::Integer(i32::from(audit_log.is_stream)),
        D1Type::Integer(d1_i32(audit_log.channel_id)),
        D1Type::Integer(d1_i32(audit_log.token_id)),
        D1Type::Text(audit_log.group),
        D1Type::Text(audit_log.ip),
        D1Type::Text(audit_log.request_id),
        D1Type::Text(audit_log.upstream_request_id),
        D1Type::Text(audit_log.other),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
        "#,
    )
    .bind_refs(&log_args)?
    .run()
    .await?;

    Ok(())
}

fn client_ip(req: &Request) -> Option<String> {
    req.headers()
        .get("cf-connecting-ip")
        .ok()
        .flatten()
        .or_else(|| req.headers().get("x-forwarded-for").ok().flatten())
        .and_then(|value| value.split(',').next().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
}

fn request_id(req: &Request) -> Option<String> {
    response_or_request_header(
        |name| req.headers().get(name).ok().flatten(),
        &["x-request-id", "cf-ray"],
    )
}

fn response_header(response: &Response, names: &[&str]) -> Option<String> {
    response_or_request_header(|name| response.headers().get(name).ok().flatten(), names)
}

fn response_or_request_header(
    get: impl Fn(&str) -> Option<String>,
    names: &[&str],
) -> Option<String> {
    names.iter().find_map(|name| {
        get(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

fn openai_error_response(message: impl Into<String>, status: u16) -> worker::Result<Response> {
    json_with_status(&ErrorBody::bad_request(message), status)
}

fn worker_error_response(err: worker::Error) -> worker::Result<Response> {
    json_with_status(
        &ErrorBody::bad_request(format!("worker runtime error: {err}")),
        500,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_config_defaults_to_disabled() {
        let config = RelayRateLimitConfig::from_raw(None, None, None).unwrap();
        assert!(!config.enabled());
        assert_eq!(config.window_seconds, DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
    }

    #[test]
    fn rate_limit_config_parses_limits_and_window() {
        let config = RelayRateLimitConfig::from_raw(
            Some("120".to_string()),
            Some("60".to_string()),
            Some("30".to_string()),
        )
        .unwrap();

        assert!(config.enabled());
        assert_eq!(config.token_limit_per_window, Some(120));
        assert_eq!(config.ip_limit_per_window, Some(60));
        assert_eq!(config.window_seconds, 30);
    }

    #[test]
    fn rate_limit_config_treats_zero_limits_as_disabled() {
        let config =
            RelayRateLimitConfig::from_raw(Some("0".to_string()), Some("0".to_string()), None)
                .unwrap();

        assert!(!config.enabled());
    }

    #[test]
    fn rate_limit_config_rejects_invalid_window() {
        let err =
            RelayRateLimitConfig::from_raw(Some("1".to_string()), None, Some("0".to_string()))
                .unwrap_err();

        assert!(err.contains(RATE_LIMIT_WINDOW_ENV));
    }

    #[test]
    fn parse_optional_limit_rejects_non_integer() {
        let err = parse_optional_limit(TOKEN_RATE_LIMIT_ENV, Some("many".to_string())).unwrap_err();
        assert!(err.contains(TOKEN_RATE_LIMIT_ENV));
    }

    #[test]
    fn relay_read_cache_config_defaults_to_enabled() {
        let config = RelayReadCacheConfig::from_raw(None).unwrap();
        assert!(config.enabled());
        assert_eq!(config.ttl_seconds, Some(DEFAULT_RELAY_CACHE_TTL_SECONDS));
    }

    #[test]
    fn relay_read_cache_config_zero_disables_cache() {
        let config = RelayReadCacheConfig::from_raw(Some("0".to_string())).unwrap();
        assert!(!config.enabled());
        assert_eq!(config.ttl_seconds, None);
    }

    #[test]
    fn relay_read_cache_config_rejects_invalid_ttl() {
        let err = RelayReadCacheConfig::from_raw(Some("fast".to_string())).unwrap_err();
        assert!(err.contains(RELAY_CACHE_TTL_ENV));
    }
}
