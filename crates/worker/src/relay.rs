use cinatoken_billing::{
    build_tiered_token_params, compute_tiered_quota_with_request, detect_billing_expr_variables,
    estimate_tiered_billing_snapshot_with_request, split_billing_expr_request_rule, RequestInput,
    TieredBillingResult, TieredBillingSnapshot, TieredTokenUsage, TokenParams, UsageSemantic,
};
use cinatoken_cache::{ExpiringCounterRateLimiter, KeyValueCache, RateLimiter, UpstashRedis};
use cinatoken_core::{ApiError, ApiResult, ErrorBody};
use cinatoken_relay::{
    apply_gemini_native_model_mapping, apply_model_mapping, csv_contains, first_channel_key,
    ip_allowlist_matches, mapped_model_name, upstream_anthropic_messages_url,
    upstream_gemini_native_url, upstream_v1_url, usage_summary_from_anthropic_body,
    usage_summary_from_body, usage_summary_from_gemini_body, CachedAuthenticatedToken,
    CachedRelayChannel, GeminiNativePath, RelayCacheKeys, SseUsageAccumulator, UsageSummary,
    ANTHROPIC_CHANNEL_TYPES, GEMINI_CHANNEL_TYPES, OPENAI_COMPATIBLE_CHANNEL_TYPES,
};
use cinatoken_storage::{AuthenticatedToken, RelayAuditLog, RelayChannel};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Fetch, Headers, Method, Request, RequestInit, Response};

use crate::{json_with_status, set_cors_headers};

const TOKEN_STATUS_EXPIRED: i32 = 3;
const TOKEN_STATUS_EXHAUSTED: i32 = 4;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS: u32 = 60;
const TOKEN_RATE_LIMIT_ENV: &str = "RELAY_TOKEN_RATE_LIMIT_PER_WINDOW";
const IP_RATE_LIMIT_ENV: &str = "RELAY_IP_RATE_LIMIT_PER_WINDOW";
const RATE_LIMIT_WINDOW_ENV: &str = "RELAY_RATE_LIMIT_WINDOW_SECONDS";
const RELAY_CACHE_TTL_ENV: &str = "RELAY_CACHE_TTL_SECONDS";
const DEFAULT_RELAY_CACHE_TTL_SECONDS: u32 = 60;
const ESTIMATED_IMAGE_INPUT_TOKENS: i64 = 520;
const ESTIMATED_AUDIO_INPUT_TOKENS: i64 = 256;
const ESTIMATED_VIDEO_INPUT_TOKENS: i64 = 4_096 * 2;
const ESTIMATED_FILE_INPUT_TOKENS: i64 = 4_096;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RelayProviderKind {
    OpenAiCompatible,
    AnthropicMessages,
    GeminiNative,
}

struct RelayEndpoint {
    display_name: &'static str,
    cache_family: &'static str,
    upstream_path: String,
    upstream_query: Option<String>,
    gemini_route: Option<GeminiNativePath>,
    provider: RelayProviderKind,
    supported_channel_types: &'static [i32],
    supports_streaming: bool,
    force_streaming: bool,
    stream_not_implemented_feature: Option<&'static str>,
    parse_non_stream_usage: bool,
}

impl RelayEndpoint {
    fn requested_stream(&self, body: &Value) -> bool {
        self.force_streaming || body.get("stream").and_then(Value::as_bool).unwrap_or(false)
    }

    fn stream_not_implemented(&self, body: &Value) -> Option<&'static str> {
        if self.requested_stream(body) && !self.supports_streaming {
            self.stream_not_implemented_feature
        } else {
            None
        }
    }

    fn should_relay_stream(&self, body: &Value) -> bool {
        self.supports_streaming && self.requested_stream(body)
    }

    fn upstream_url(&self, channel: &RelayChannel) -> String {
        match self.provider {
            RelayProviderKind::OpenAiCompatible => upstream_v1_url(
                channel.channel_type,
                channel.base_url.as_deref(),
                &self.upstream_path,
            ),
            RelayProviderKind::AnthropicMessages => {
                upstream_anthropic_messages_url(channel.base_url.as_deref())
            }
            RelayProviderKind::GeminiNative => upstream_gemini_native_url(
                channel.base_url.as_deref(),
                self.gemini_route
                    .as_ref()
                    .expect("Gemini native endpoint must carry parsed route"),
                self.upstream_query.as_deref(),
            ),
        }
    }
}

pub async fn chat_completions(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "chat completions",
            cache_family: "openai_compatible",
            upstream_path: "chat/completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn embeddings(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "embeddings",
            cache_family: "openai_compatible",
            upstream_path: "embeddings".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn image_generations(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "image generations",
            cache_family: "openai_compatible",
            upstream_path: "images/generations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn audio_speech(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "audio speech",
            cache_family: "openai_compatible",
            upstream_path: "audio/speech".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: false,
        },
        None,
    )
    .await
}

pub async fn completions(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "completions",
            cache_family: "openai_compatible",
            upstream_path: "completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn responses(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "responses",
            cache_family: "openai_compatible",
            upstream_path: "responses".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn anthropic_messages(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "Anthropic messages",
            cache_family: "anthropic",
            upstream_path: "messages".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::AnthropicMessages,
            supported_channel_types: ANTHROPIC_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        },
        None,
    )
    .await
}

pub async fn gemini_native(
    req: Request,
    env: Env,
    context: Context,
    route: GeminiNativePath,
) -> worker::Result<Response> {
    if !route.is_supported_native_passthrough() {
        return json_with_status(
            &ErrorBody::not_implemented(format!("Gemini native action {}", route.action)),
            501,
        );
    }
    let query = req.url()?.query().map(str::to_string);
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "Gemini native",
            cache_family: "gemini",
            upstream_path: route.upstream_path(),
            upstream_query: query,
            gemini_route: Some(route.clone()),
            provider: RelayProviderKind::GeminiNative,
            supported_channel_types: GEMINI_CHANNEL_TYPES,
            supports_streaming: route.is_stream_generate_content(),
            force_streaming: route.is_stream_generate_content(),
            stream_not_implemented_feature: Some("streaming Gemini native action"),
            parse_non_stream_usage: true,
        },
        Some(route.model),
    )
    .await
}

async fn relay_endpoint(
    mut req: Request,
    env: Env,
    context: Option<Context>,
    mut endpoint: RelayEndpoint,
    model_override: Option<String>,
) -> worker::Result<Response> {
    let started_at = unix_timestamp();
    let client_ip = client_ip(&req);
    let request_id = request_id(&req);
    let provider_headers = RelayProviderHeaders::from_request(&req);

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
    let billing_request_input = billing_request_input(&req, &request_body);

    if let Some(feature) = endpoint.stream_not_implemented(&request_body) {
        return json_with_status(&ErrorBody::not_implemented(feature), 501);
    }
    let should_relay_stream = endpoint.should_relay_stream(&request_body);
    if should_relay_stream && context.is_none() {
        return openai_error_response("streaming relay context is unavailable", 500);
    }

    let model = match model_override.or_else(|| {
        request_body
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    }) {
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
    let group = auth.effective_group().to_string();

    if let Err(response) = enforce_relay_rate_limits(&env, &auth, client_ip.as_deref()).await {
        return response;
    }

    let channel = match select_channel(
        &db,
        &env,
        &model,
        &group,
        endpoint.cache_family,
        endpoint.supported_channel_types,
    )
    .await
    {
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

    let tiered_billing_preflight = match prepare_tiered_billing_preflight(
        &db,
        &model,
        &group,
        &request_body,
        &billing_request_input,
    )
    .await
    {
        Ok(preflight) => preflight,
        Err(err) => {
            return openai_error_response(format!("tiered billing preflight failed: {err}"), 500);
        }
    };
    let mut tiered_billing_preflight = tiered_billing_preflight;
    if let Some(preflight) = tiered_billing_preflight.as_mut() {
        if let Err(err) =
            reserve_tiered_billing_preflight(&db, &auth, preflight, unix_timestamp()).await
        {
            return openai_error_response(
                format!("tiered billing reserve failed: {err}"),
                quota_mutation_error_status(&err),
            );
        }
    }

    let mut upstream_body = request_body;
    apply_model_mapping(&mut upstream_body, &model, channel.model_mapping.as_deref());
    if endpoint.provider == RelayProviderKind::GeminiNative {
        if let Some(mapped_model) = mapped_model_name(&model, channel.model_mapping.as_deref()) {
            apply_gemini_native_model_mapping(&mut upstream_body, &model, &mapped_model);
            if let Some(route) = endpoint.gemini_route.as_mut() {
                route.model = mapped_model;
                endpoint.upstream_path = route.upstream_path();
            }
        }
    }

    let upstream_url = endpoint.upstream_url(&channel);
    let upstream_response = match forward_relay_request(
        endpoint.provider,
        &upstream_url,
        &upstream_key,
        &channel,
        &upstream_body,
        &provider_headers,
    )
    .await
    {
        Ok(response) => response,
        Err(err) => {
            if let Some(preflight) = tiered_billing_preflight.as_ref() {
                if let Err(refund_err) =
                    refund_tiered_billing_preflight(&db, &auth, preflight, unix_timestamp()).await
                {
                    return openai_error_response(
                            format!(
                                "upstream request failed for channel {} ({}): {err}; tiered billing reserve refund failed: {refund_err}",
                                channel.id, channel.name
                            ),
                            500,
                        );
                }
            }
            return json_with_status(
                &ErrorBody::bad_request(format!(
                    "upstream request failed for channel {} ({}): {err}",
                    channel.id, channel.name
                )),
                502,
            );
        }
    };

    let audit = RelayAuditContext {
        started_at,
        client_ip,
        request_id,
        billing_request_input,
        tiered_billing_preflight,
    };

    if should_relay_stream {
        let context = context.expect("streaming context checked before reserve");
        return complete_streaming_relay_response(
            upstream_response,
            db,
            context,
            auth,
            channel,
            model,
            group,
            endpoint.upstream_path.clone(),
            endpoint.provider,
            audit,
        )
        .await;
    }

    complete_relay_response(
        upstream_response,
        db,
        context,
        auth,
        channel,
        model,
        group,
        endpoint.upstream_path.clone(),
        endpoint.provider,
        endpoint.parse_non_stream_usage,
        audit,
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
        .or_else(|| request_header(req, "x-goog-api-key"))
        .or_else(|| request_query_param(req, "key"))
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
        Ok(Some(mut row)) => {
            let still_exists =
                crate::d1_repositories::refresh_authenticated_token_quota_state(db, &mut row)
                    .await
                    .map_err(worker_error_response)?;
            if !still_exists {
                return Err(openai_error_response("invalid API key", 401));
            }
            return validate_authenticated_token(db, row, model, client_ip).await;
        }
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
    let row = crate::d1_repositories::authenticate_token(db, api_key)
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
    if let Err(err) =
        crate::d1_repositories::mark_token_status(db, token_id, status, unix_timestamp()).await
    {
        worker::console_warn!("failed to update token status: {}", err);
    }
}

async fn select_channel(
    db: &D1Database,
    env: &Env,
    model: &str,
    group: &str,
    cache_family: &str,
    supported_channel_types: &[i32],
) -> Result<RelayChannel, worker::Result<Response>> {
    let Some((redis, ttl_seconds)) = relay_read_cache(env)? else {
        return select_channel_from_d1(db, model, group, supported_channel_types).await;
    };
    let cache_key = RelayCacheKeys::default().channel(cache_family, group, model);

    match read_cached_relay_channel(&redis, &cache_key).await {
        Ok(Some(channel)) => return Ok(channel),
        Ok(None) => {}
        Err(err) => worker::console_warn!("failed to read relay channel cache: {}", err),
    }

    let channel = select_channel_from_d1(db, model, group, supported_channel_types).await?;
    if let Err(err) = write_cached_relay_channel(&redis, &cache_key, &channel, ttl_seconds).await {
        worker::console_warn!("failed to write relay channel cache: {}", err);
    }
    Ok(channel)
}

async fn select_channel_from_d1(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> Result<RelayChannel, worker::Result<Response>> {
    crate::d1_repositories::select_relay_channel(db, model, group, supported_channel_types)
        .await
        .map_err(worker_error_response)?
        .ok_or_else(|| {
            openai_error_response(
                format!("no enabled relay channel or ability for model {model} in group {group}"),
                503,
            )
        })
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayProviderHeaders {
    anthropic_version: Option<String>,
    anthropic_beta: Option<String>,
}

impl RelayProviderHeaders {
    fn from_request(req: &Request) -> Self {
        Self {
            anthropic_version: request_header(req, "anthropic-version"),
            anthropic_beta: request_header(req, "anthropic-beta"),
        }
    }
}

async fn forward_relay_request(
    provider: RelayProviderKind,
    url: &str,
    upstream_key: &str,
    channel: &RelayChannel,
    body: &Value,
    provider_headers: &RelayProviderHeaders,
) -> worker::Result<Response> {
    match provider {
        RelayProviderKind::OpenAiCompatible => {
            forward_openai_compatible(url, upstream_key, channel, body).await
        }
        RelayProviderKind::AnthropicMessages => {
            forward_anthropic_messages(url, upstream_key, body, provider_headers).await
        }
        RelayProviderKind::GeminiNative => forward_gemini_native(url, upstream_key, body).await,
    }
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

async fn forward_anthropic_messages(
    url: &str,
    upstream_key: &str,
    body: &Value,
    provider_headers: &RelayProviderHeaders,
) -> worker::Result<Response> {
    let body = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("x-api-key", upstream_key)?;
    headers.set(
        "anthropic-version",
        provider_headers
            .anthropic_version
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("2023-06-01"),
    )?;
    if let Some(beta) = provider_headers
        .anthropic_beta
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.set("anthropic-beta", beta)?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn forward_gemini_native(
    url: &str,
    upstream_key: &str,
    body: &Value,
) -> worker::Result<Response> {
    let body = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("x-goog-api-key", upstream_key)?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn complete_relay_response(
    mut upstream: Response,
    db: D1Database,
    context: Option<Context>,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    provider: RelayProviderKind,
    parse_usage: bool,
    audit: RelayAuditContext,
) -> worker::Result<Response> {
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_else(|| "application/json".to_string());
    let upstream_request_id = response_header(&upstream, &["x-request-id", "cf-ray"]);
    if !parse_usage {
        if let Some(context) = context {
            context.wait_until(async move {
                if let Err(err) = record_relay_audit(
                    &db,
                    &auth,
                    &channel,
                    &model,
                    &group,
                    &endpoint_path,
                    status,
                    &UsageSummary::default(),
                    &audit,
                    upstream_request_id.as_deref(),
                    false,
                )
                .await
                {
                    worker::console_error!("failed to record relay audit: {}", err);
                }
            });
        } else if let Err(err) = record_relay_audit(
            &db,
            &auth,
            &channel,
            &model,
            &group,
            &endpoint_path,
            status,
            &UsageSummary::default(),
            &audit,
            upstream_request_id.as_deref(),
            false,
        )
        .await
        {
            worker::console_error!("failed to record relay audit: {}", err);
        }

        upstream.headers_mut().set("content-type", &content_type)?;
        set_cors_headers(&mut upstream)?;
        return Ok(upstream);
    }

    if let Some(context) = context {
        let mut audit_response = match upstream.cloned() {
            Ok(response) => response,
            Err(err) => {
                worker::console_error!(
                    "failed to initialize non-streaming audit branch: {}; falling back to buffered relay response",
                    err
                );
                return complete_buffered_relay_response(
                    upstream,
                    &db,
                    &auth,
                    &channel,
                    &model,
                    &group,
                    &endpoint_path,
                    provider,
                    &audit,
                )
                .await;
            }
        };

        context.wait_until(async move {
            let usage = match response_usage_summary(&mut audit_response, provider).await {
                Ok(usage) => usage,
                Err(err) => {
                    worker::console_error!("failed to parse non-streaming relay usage: {}", err);
                    UsageSummary::default()
                }
            };
            if let Err(err) = record_relay_audit(
                &db,
                &auth,
                &channel,
                &model,
                &group,
                &endpoint_path,
                status,
                &usage,
                &audit,
                upstream_request_id.as_deref(),
                false,
            )
            .await
            {
                worker::console_error!("failed to record relay audit: {}", err);
            }
        });

        upstream.headers_mut().set("content-type", &content_type)?;
        set_cors_headers(&mut upstream)?;
        return Ok(upstream);
    }

    complete_buffered_relay_response(
        upstream,
        &db,
        &auth,
        &channel,
        &model,
        &group,
        &endpoint_path,
        provider,
        &audit,
    )
    .await
}

async fn complete_buffered_relay_response(
    mut upstream: Response,
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel: &RelayChannel,
    model: &str,
    group: &str,
    endpoint_path: &str,
    provider: RelayProviderKind,
    audit: &RelayAuditContext,
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
    let usage = usage_summary_for_provider(&body, provider);

    if let Err(err) = record_relay_audit(
        db,
        auth,
        channel,
        model,
        group,
        endpoint_path,
        status,
        &usage,
        audit,
        upstream_request_id.as_deref(),
        false,
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

async fn response_usage_summary(
    response: &mut Response,
    provider: RelayProviderKind,
) -> worker::Result<UsageSummary> {
    let body = response.text().await?;
    Ok(usage_summary_for_provider(&body, provider))
}

fn usage_summary_for_provider(body: &str, provider: RelayProviderKind) -> UsageSummary {
    match provider {
        RelayProviderKind::OpenAiCompatible => usage_summary_from_body(body),
        RelayProviderKind::AnthropicMessages => usage_summary_from_anthropic_body(body),
        RelayProviderKind::GeminiNative => usage_summary_from_gemini_body(body),
    }
}

async fn complete_streaming_relay_response(
    mut upstream: Response,
    db: D1Database,
    context: Context,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    provider: RelayProviderKind,
    audit: RelayAuditContext,
) -> worker::Result<Response> {
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_else(|| "text/event-stream".to_string());
    let upstream_request_id = response_header(&upstream, &["x-request-id", "cf-ray"]);
    let mut audit_response = match upstream.cloned() {
        Ok(response) => response,
        Err(err) => {
            if let Some(preflight) = audit.tiered_billing_preflight.as_ref() {
                if let Err(refund_err) =
                    refund_tiered_billing_preflight(&db, &auth, preflight, unix_timestamp()).await
                {
                    return Err(worker::Error::RustError(format!(
                        "failed to initialize streaming audit branch: {err}; tiered billing reserve refund failed: {refund_err}"
                    )));
                }
            }
            return Err(err);
        }
    };

    context.wait_until(async move {
        let usage = match streaming_usage_summary(&mut audit_response, provider).await {
            Ok(usage) => usage,
            Err(err) => {
                worker::console_error!("failed to parse streaming relay usage: {}", err);
                UsageSummary::default()
            }
        };
        if let Err(err) = record_relay_audit(
            &db,
            &auth,
            &channel,
            &model,
            &group,
            &endpoint_path,
            status,
            &usage,
            &audit,
            upstream_request_id.as_deref(),
            true,
        )
        .await
        {
            worker::console_error!("failed to record streaming relay audit: {}", err);
        }
    });

    upstream.headers_mut().set("content-type", &content_type)?;
    set_cors_headers(&mut upstream)?;
    Ok(upstream)
}

async fn streaming_usage_summary(
    upstream: &mut Response,
    provider: RelayProviderKind,
) -> worker::Result<UsageSummary> {
    let mut stream = upstream.stream()?;
    let mut accumulator = match provider {
        RelayProviderKind::OpenAiCompatible => SseUsageAccumulator::default(),
        RelayProviderKind::AnthropicMessages => SseUsageAccumulator::anthropic(),
        RelayProviderKind::GeminiNative => SseUsageAccumulator::gemini(),
    };

    while let Some(chunk) = stream.next().await {
        accumulator.push_chunk(&chunk?);
    }

    Ok(accumulator.finish())
}

#[derive(Clone)]
struct RelayAuditContext {
    started_at: i64,
    client_ip: Option<String>,
    request_id: Option<String>,
    billing_request_input: RequestInput,
    tiered_billing_preflight: Option<TieredBillingPreflight>,
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
    audit: &RelayAuditContext,
    upstream_request_id: Option<&str>,
    is_stream: bool,
) -> worker::Result<()> {
    let now = unix_timestamp();

    let use_time = now.saturating_sub(audit.started_at);
    let mut other = json!({
        "billing_pending": true,
        "relay_runtime": "cloudflare_worker_rust",
        "endpoint": endpoint_path,
        "upstream_status": upstream_status,
        "total_tokens": usage.total_tokens,
    });
    let mut quota = 0;
    let mut billing_applied = false;
    let mut billing_resolved = false;
    if let Some(preflight) = audit.tiered_billing_preflight.as_ref() {
        if upstream_status < 400 && usage.total_tokens > 0 {
            match tiered_billing_settlement(
                &preflight.snapshot,
                usage,
                &audit.billing_request_input,
            ) {
                Ok(outcome) => {
                    let final_quota = outcome.final_quota;
                    let quota_result = if preflight.reserve_applied {
                        crate::d1_repositories::settle_reserved_relay_quota_usage(
                            db,
                            auth.user_id,
                            auth.token_id,
                            channel.id,
                            preflight.pre_consumed_quota,
                            final_quota,
                            now,
                        )
                        .await
                    } else {
                        crate::d1_repositories::apply_relay_quota_usage(
                            db,
                            auth.user_id,
                            auth.token_id,
                            channel.id,
                            final_quota,
                            now,
                        )
                        .await
                    };
                    match quota_result {
                        Ok(()) => {
                            quota = final_quota;
                            billing_applied = true;
                            billing_resolved = true;
                            set_json_bool(&mut other, "billing_pending", false);
                            apply_tiered_log_display_metadata(
                                &mut other,
                                &outcome.snapshot,
                                Some(&outcome.result),
                            );
                            let metadata = tiered_billing_metadata(
                                outcome.snapshot,
                                preflight.pre_consumed_quota,
                                outcome.result,
                                false,
                                true,
                            );
                            set_json_value(&mut other, "tiered_billing", metadata);
                        }
                        Err(err) => {
                            let metadata = tiered_billing_metadata(
                                outcome.snapshot,
                                preflight.pre_consumed_quota,
                                outcome.result,
                                true,
                                false,
                            );
                            set_json_value(&mut other, "tiered_billing_shadow", metadata);
                            set_json_string(
                                &mut other,
                                "tiered_billing_shadow_error",
                                err.to_string(),
                            );
                        }
                    }
                }
                Err(err) => {
                    if preflight.reserve_applied {
                        match crate::d1_repositories::settle_reserved_relay_quota_usage(
                            db,
                            auth.user_id,
                            auth.token_id,
                            channel.id,
                            preflight.pre_consumed_quota,
                            preflight.pre_consumed_quota,
                            now,
                        )
                        .await
                        {
                            Ok(()) => {
                                quota = preflight.pre_consumed_quota;
                                billing_applied = true;
                                billing_resolved = true;
                                set_json_bool(&mut other, "billing_pending", false);
                                set_json_value(
                                    &mut other,
                                    "tiered_billing_fallback",
                                    tiered_billing_fallback_metadata(preflight, err, true),
                                );
                            }
                            Err(settle_err) => {
                                set_json_string(
                                    &mut other,
                                    "tiered_billing_shadow_error",
                                    format!("{err}; fallback settle failed: {settle_err}"),
                                );
                            }
                        }
                    } else {
                        set_json_string(&mut other, "tiered_billing_shadow_error", err);
                    }
                }
            }
        } else if preflight.reserve_applied {
            match refund_tiered_billing_preflight(db, auth, preflight, now).await {
                Ok(()) => {
                    billing_resolved = true;
                    set_json_bool(&mut other, "billing_pending", false);
                    set_json_value(
                        &mut other,
                        "tiered_billing_refund",
                        tiered_billing_refund_metadata(
                            preflight,
                            refund_reason(upstream_status, usage, is_stream),
                        ),
                    );
                }
                Err(err) => {
                    set_json_string(
                        &mut other,
                        "tiered_billing_shadow_error",
                        format!("failed to refund reserved tiered quota: {err}"),
                    );
                }
            }
        }
    }

    if !billing_applied {
        crate::d1_repositories::touch_token(db, auth.token_id, now).await?;
        crate::d1_repositories::increment_user_request_count(db, auth.user_id).await?;
    }
    let other_json = other.to_string();
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
        quota,
        use_time_seconds: use_time,
        is_stream,
        ip: audit.client_ip.as_deref().unwrap_or(empty),
        request_id: audit.request_id.as_deref().unwrap_or(empty),
        upstream_request_id: upstream_request_id.unwrap_or(empty),
        other: &other_json,
    };

    let action = if is_stream { "streamed" } else { "forwarded" };
    let content = if billing_applied {
        format!("Rust relay {action} {endpoint_path}; tiered quota {quota}")
    } else if billing_resolved {
        format!("Rust relay {action} {endpoint_path}; quota resolved without charge")
    } else {
        format!("Rust relay {action} {endpoint_path}; quota settlement pending")
    };
    crate::d1_repositories::insert_relay_audit_log(db, now, &content, &audit_log).await
}

struct TieredBillingOutcome {
    final_quota: i64,
    snapshot: TieredBillingSnapshot,
    result: TieredBillingResult,
}

#[derive(Clone)]
struct TieredBillingPreflight {
    snapshot: TieredBillingSnapshot,
    pre_consumed_quota: i64,
    reserve_applied: bool,
}

async fn prepare_tiered_billing_preflight(
    db: &D1Database,
    model: &str,
    group: &str,
    request_body: &Value,
    request: &RequestInput,
) -> worker::Result<Option<TieredBillingPreflight>> {
    let Some(expr) = crate::d1_repositories::tiered_billing_expr_for_model(db, model).await? else {
        return Ok(None);
    };
    let group_ratio = crate::d1_repositories::group_ratio_for_group(db, group).await?;
    tiered_billing_preflight_snapshot(model, &expr, group_ratio, request_body, request.clone())
        .map(Some)
        .map_err(worker::Error::RustError)
}

fn tiered_billing_preflight_snapshot(
    model: &str,
    expr: &str,
    group_ratio: f64,
    request_body: &Value,
    request: RequestInput,
) -> Result<TieredBillingPreflight, String> {
    let params = token_params_from_request(request_body);
    let snapshot =
        estimate_tiered_billing_snapshot_with_request(model, expr, params, group_ratio, request)
            .map_err(|err| format!("failed to estimate tiered billing: {err}"))?;
    Ok(TieredBillingPreflight {
        pre_consumed_quota: snapshot.estimated_quota_after_group.0.max(0),
        snapshot,
        reserve_applied: false,
    })
}

async fn reserve_tiered_billing_preflight(
    db: &D1Database,
    auth: &AuthenticatedToken,
    preflight: &mut TieredBillingPreflight,
    now: i64,
) -> worker::Result<()> {
    if preflight.pre_consumed_quota == 0 {
        return Ok(());
    }
    crate::d1_repositories::reserve_relay_quota(
        db,
        auth.user_id,
        auth.token_id,
        preflight.pre_consumed_quota,
        now,
    )
    .await?;
    preflight.reserve_applied = true;
    Ok(())
}

async fn refund_tiered_billing_preflight(
    db: &D1Database,
    auth: &AuthenticatedToken,
    preflight: &TieredBillingPreflight,
    now: i64,
) -> worker::Result<()> {
    if !preflight.reserve_applied || preflight.pre_consumed_quota == 0 {
        return Ok(());
    }
    crate::d1_repositories::refund_reserved_relay_quota(
        db,
        auth.user_id,
        auth.token_id,
        preflight.pre_consumed_quota,
        now,
    )
    .await
}

fn tiered_billing_settlement(
    snapshot: &TieredBillingSnapshot,
    usage: &UsageSummary,
    request: &RequestInput,
) -> Result<TieredBillingOutcome, String> {
    let params = token_params_from_usage(snapshot, usage);
    let result = compute_tiered_quota_with_request(snapshot, params, request.clone())
        .map_err(|err| format!("failed to compute tiered billing: {err}"))?;
    let final_quota = result.settlement.final_quota.0;

    Ok(TieredBillingOutcome {
        final_quota,
        snapshot: snapshot.clone(),
        result,
    })
}

fn tiered_billing_metadata(
    snapshot: TieredBillingSnapshot,
    pre_consumed_quota: i64,
    result: TieredBillingResult,
    shadow_only: bool,
    applied: bool,
) -> Value {
    json!({
        "billing_mode": snapshot.billing_mode,
        "shadow_only": shadow_only,
        "applied": applied,
        "expr_hash": snapshot.expr_hash,
        "expr_version": snapshot.expr_version,
        "has_request_rule": snapshot.request_rule_expr.is_some(),
        "group_ratio": snapshot.group_ratio,
        "pre_consumed_quota": pre_consumed_quota,
        "estimated_prompt_tokens": snapshot.estimated_prompt_tokens,
        "estimated_completion_tokens": snapshot.estimated_completion_tokens,
        "estimated_expression_cost": snapshot.estimated_expression_cost,
        "estimated_quota_before_group": snapshot.estimated_quota_before_group,
        "estimated_quota_after_group": snapshot.estimated_quota_after_group.0,
        "estimated_tier": snapshot.estimated_tier,
        "matched_tier": result.matched_tier,
        "crossed_tier": result.crossed_tier,
        "expression_cost": result.actual_expression_cost,
        "quota_before_group": result.actual_quota_before_group,
        "quota_after_group": result.actual_quota_after_group.0,
        "settlement": {
            "final_quota": result.settlement.final_quota.0,
            "refund_quota": result.settlement.refund_quota.0,
            "additional_quota": result.settlement.additional_quota.0,
        }
    })
}

fn apply_tiered_log_display_metadata(
    other: &mut Value,
    snapshot: &TieredBillingSnapshot,
    result: Option<&TieredBillingResult>,
) {
    set_json_string(other, "billing_mode", snapshot.billing_mode.clone());
    let parts = split_billing_expr_request_rule(&snapshot.expr_string);
    set_json_string(
        other,
        "expr_b64",
        base64_standard_encode(&parts.billing_expr),
    );
    if let Some(result) = result {
        set_json_string(other, "matched_tier", result.matched_tier.clone());
    }
}

fn base64_standard_encode(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let bytes = input.as_bytes();
    let mut encoded = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or_default() as u32;
        let b2 = chunk.get(2).copied().unwrap_or_default() as u32;
        let bits = (b0 << 16) | (b1 << 8) | b2;

        encoded.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
        encoded.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(bits & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

fn tiered_billing_fallback_metadata(
    preflight: &TieredBillingPreflight,
    error: String,
    applied: bool,
) -> Value {
    json!({
        "billing_mode": preflight.snapshot.billing_mode,
        "applied": applied,
        "fallback_to_pre_consumed": true,
        "expr_hash": preflight.snapshot.expr_hash,
        "has_request_rule": preflight.snapshot.request_rule_expr.is_some(),
        "pre_consumed_quota": preflight.pre_consumed_quota,
        "estimated_tier": preflight.snapshot.estimated_tier,
        "estimated_quota_after_group": preflight.snapshot.estimated_quota_after_group.0,
        "error": error,
    })
}

fn tiered_billing_refund_metadata(
    preflight: &TieredBillingPreflight,
    reason: &'static str,
) -> Value {
    json!({
        "billing_mode": preflight.snapshot.billing_mode,
        "refunded": true,
        "expr_hash": preflight.snapshot.expr_hash,
        "has_request_rule": preflight.snapshot.request_rule_expr.is_some(),
        "pre_consumed_quota": preflight.pre_consumed_quota,
        "estimated_tier": preflight.snapshot.estimated_tier,
        "estimated_quota_after_group": preflight.snapshot.estimated_quota_after_group.0,
        "reason": reason,
    })
}

fn refund_reason(upstream_status: u16, usage: &UsageSummary, is_stream: bool) -> &'static str {
    if upstream_status >= 400 {
        "upstream_error"
    } else if usage.total_tokens <= 0 {
        if is_stream {
            return "missing_stream_usage";
        }
        "missing_usage"
    } else {
        "not_billable"
    }
}

fn set_json_bool(value: &mut Value, key: &str, item: bool) {
    set_json_value(value, key, Value::Bool(item));
}

fn set_json_string(value: &mut Value, key: &str, item: String) {
    set_json_value(value, key, Value::String(item));
}

fn set_json_value(value: &mut Value, key: &str, item: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), item);
    }
}

fn token_params_from_request(body: &Value) -> TokenParams {
    let estimate = request_token_estimate_from_body(body);
    let prompt = estimate.prompt_tokens() as f64;
    TokenParams {
        p: prompt,
        c: estimate.completion_tokens as f64,
        len: prompt,
        ..TokenParams::default()
    }
}

#[cfg(test)]
fn estimate_prompt_tokens_from_request(body: &Value) -> i64 {
    request_token_estimate_from_body(body).prompt_tokens()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RequestTokenEstimate {
    text_prompt_tokens: i64,
    image_input_tokens: i64,
    audio_input_tokens: i64,
    video_input_tokens: i64,
    file_input_tokens: i64,
    completion_tokens: i64,
}

impl RequestTokenEstimate {
    fn prompt_tokens(self) -> i64 {
        self.text_prompt_tokens
            .saturating_add(self.image_input_tokens)
            .saturating_add(self.audio_input_tokens)
            .saturating_add(self.video_input_tokens)
            .saturating_add(self.file_input_tokens)
    }
}

fn request_token_estimate_from_body(body: &Value) -> RequestTokenEstimate {
    let mut estimate = RequestTokenEstimate {
        text_prompt_tokens: estimate_text_prompt_tokens_from_request(body),
        completion_tokens: estimate_completion_tokens_from_request(body),
        ..RequestTokenEstimate::default()
    };
    collect_media_token_estimate(body, &mut estimate);
    estimate
}

fn estimate_text_prompt_tokens_from_request(body: &Value) -> i64 {
    let mut chars = 0usize;

    for key in [
        "prompt",
        "input",
        "contents",
        "system",
        "instruction",
        "instructions",
        "prefix",
        "suffix",
    ] {
        if let Some(value) = body.get(key) {
            collect_prompt_text_chars(value, &mut chars);
        }
    }

    let mut structural_tokens = 0i64;
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        structural_tokens = structural_tokens.saturating_add(3);
        structural_tokens =
            structural_tokens.saturating_add(saturating_usize_to_i64(messages.len()) * 3);
        for message in messages {
            if let Some(role) = message.get("role").and_then(Value::as_str) {
                add_text_chars(&mut chars, role);
            }
            if let Some(name) = message.get("name").and_then(Value::as_str) {
                add_text_chars(&mut chars, name);
                structural_tokens = structural_tokens.saturating_add(3);
            }
            if let Some(content) = message.get("content") {
                collect_prompt_text_chars(content, &mut chars);
            }
        }
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        structural_tokens =
            structural_tokens.saturating_add(saturating_usize_to_i64(tools.len()) * 8);
        for tool in tools {
            collect_tool_text_chars(tool, &mut chars);
        }
    }

    estimate_tokens_from_chars(chars).saturating_add(structural_tokens)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestMediaKind {
    Image,
    Audio,
    Video,
    File,
}

fn collect_media_token_estimate(value: &Value, estimate: &mut RequestTokenEstimate) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_media_token_estimate(item, estimate);
            }
        }
        Value::Object(object) => {
            if let Some(kind) = request_media_kind_from_object(object) {
                add_media_token_estimate(kind, estimate);
                return;
            }
            for value in object.values() {
                collect_media_token_estimate(value, estimate);
            }
        }
        _ => {}
    }
}

fn request_media_kind_from_object(
    object: &serde_json::Map<String, Value>,
) -> Option<RequestMediaKind> {
    if let Some(kind) = object
        .get("type")
        .and_then(Value::as_str)
        .and_then(request_media_kind_from_type)
    {
        return Some(kind);
    }

    for key in ["inline_data", "inlineData", "file_data", "fileData"] {
        if let Some(kind) = object
            .get(key)
            .and_then(Value::as_object)
            .and_then(request_media_kind_from_mime_object)
        {
            return Some(kind);
        }
    }

    if object.contains_key("image_url") || object.contains_key("imageUrl") {
        return Some(RequestMediaKind::Image);
    }
    if object.contains_key("input_audio") || object.contains_key("inputAudio") {
        return Some(RequestMediaKind::Audio);
    }
    if object.contains_key("video_url") || object.contains_key("videoUrl") {
        return Some(RequestMediaKind::Video);
    }
    if object.contains_key("file")
        || object.contains_key("file_url")
        || object.contains_key("fileUrl")
        || object.contains_key("file_id")
        || object.contains_key("fileId")
    {
        return Some(RequestMediaKind::File);
    }

    request_media_kind_from_mime_object(object)
}

fn request_media_kind_from_mime_object(
    object: &serde_json::Map<String, Value>,
) -> Option<RequestMediaKind> {
    object
        .get("mime_type")
        .or_else(|| object.get("mimeType"))
        .or_else(|| object.get("media_type"))
        .or_else(|| object.get("mediaType"))
        .and_then(Value::as_str)
        .and_then(request_media_kind_from_mime)
}

fn request_media_kind_from_type(raw_type: &str) -> Option<RequestMediaKind> {
    match raw_type.trim().to_ascii_lowercase().as_str() {
        "image" | "image_url" | "input_image" => Some(RequestMediaKind::Image),
        "audio" | "input_audio" => Some(RequestMediaKind::Audio),
        "video" | "video_url" | "input_video" => Some(RequestMediaKind::Video),
        "file" | "input_file" | "document" => Some(RequestMediaKind::File),
        _ => None,
    }
}

fn request_media_kind_from_mime(mime: &str) -> Option<RequestMediaKind> {
    let mime = mime.trim().to_ascii_lowercase();
    if mime.starts_with("image/") {
        Some(RequestMediaKind::Image)
    } else if mime.starts_with("audio/") {
        Some(RequestMediaKind::Audio)
    } else if mime.starts_with("video/") {
        Some(RequestMediaKind::Video)
    } else if !mime.is_empty() {
        Some(RequestMediaKind::File)
    } else {
        None
    }
}

fn add_media_token_estimate(kind: RequestMediaKind, estimate: &mut RequestTokenEstimate) {
    match kind {
        RequestMediaKind::Image => {
            estimate.image_input_tokens = estimate
                .image_input_tokens
                .saturating_add(ESTIMATED_IMAGE_INPUT_TOKENS);
        }
        RequestMediaKind::Audio => {
            estimate.audio_input_tokens = estimate
                .audio_input_tokens
                .saturating_add(ESTIMATED_AUDIO_INPUT_TOKENS);
        }
        RequestMediaKind::Video => {
            estimate.video_input_tokens = estimate
                .video_input_tokens
                .saturating_add(ESTIMATED_VIDEO_INPUT_TOKENS);
        }
        RequestMediaKind::File => {
            estimate.file_input_tokens = estimate
                .file_input_tokens
                .saturating_add(ESTIMATED_FILE_INPUT_TOKENS);
        }
    }
}

fn estimate_completion_tokens_from_request(body: &Value) -> i64 {
    [
        "max_completion_tokens",
        "max_output_tokens",
        "max_tokens",
        "max_tokens_to_sample",
        "max_new_tokens",
    ]
    .into_iter()
    .filter_map(|key| body.get(key).and_then(value_to_non_negative_i64))
    .max()
    .unwrap_or(0)
}

fn collect_prompt_text_chars(value: &Value, chars: &mut usize) {
    match value {
        Value::String(text) => add_text_chars(chars, text),
        Value::Array(items) => {
            for item in items {
                collect_prompt_text_chars(item, chars);
            }
        }
        Value::Object(object) => {
            let mut matched_prompt_field = false;
            for key in [
                "text",
                "input_text",
                "content",
                "prompt",
                "instruction",
                "instructions",
                "prefix",
                "suffix",
            ] {
                if let Some(value) = object.get(key) {
                    matched_prompt_field = true;
                    collect_prompt_text_chars(value, chars);
                }
            }
            if !matched_prompt_field {
                for (key, value) in object {
                    if should_skip_prompt_text_key(key) {
                        continue;
                    }
                    collect_prompt_text_chars(value, chars);
                }
            }
        }
        _ => {}
    }
}

fn collect_tool_text_chars(value: &Value, chars: &mut usize) {
    match value {
        Value::String(text) => add_text_chars(chars, text),
        Value::Array(items) => {
            for item in items {
                collect_tool_text_chars(item, chars);
            }
        }
        Value::Object(object) => {
            for key in ["name", "description", "parameters"] {
                if let Some(value) = object.get(key) {
                    collect_tool_text_chars(value, chars);
                }
            }
            if let Some(function) = object.get("function") {
                collect_tool_text_chars(function, chars);
            }
        }
        Value::Number(_) | Value::Bool(_) => {
            add_text_chars(chars, &value.to_string());
        }
        Value::Null => {}
    }
}

fn should_skip_prompt_text_key(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "role"
            | "image"
            | "image_url"
            | "imageUrl"
            | "input_audio"
            | "inputAudio"
            | "audio"
            | "video"
            | "video_url"
            | "videoUrl"
            | "input_video"
            | "inputVideo"
            | "inline_data"
            | "inlineData"
            | "url"
            | "file"
            | "file_id"
            | "fileId"
            | "file_url"
            | "fileUrl"
            | "file_data"
            | "fileData"
            | "b64_json"
            | "data"
    )
}

fn add_text_chars(total: &mut usize, text: &str) {
    *total = total.saturating_add(text.chars().count());
}

fn estimate_tokens_from_chars(chars: usize) -> i64 {
    let chars = saturating_usize_to_i64(chars);
    chars.saturating_add(3) / 4
}

fn saturating_usize_to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn value_to_non_negative_i64(value: &Value) -> Option<i64> {
    if let Some(value) = value.as_i64() {
        return Some(value.max(0));
    }
    if let Some(value) = value.as_u64() {
        return Some(i64::try_from(value).unwrap_or(i64::MAX));
    }
    let value = value.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.max(0.0).floor().min(i64::MAX as f64) as i64)
}

fn token_params_from_usage(snapshot: &TieredBillingSnapshot, usage: &UsageSummary) -> TokenParams {
    let tiered_usage = TieredTokenUsage {
        prompt_tokens: i64::from(usage.prompt_tokens.max(0)),
        completion_tokens: i64::from(usage.completion_tokens.max(0)),
        cached_tokens: i64::from(usage.cached_tokens.max(0)),
        cache_creation_tokens: i64::from(usage.cache_creation_tokens.max(0)),
        claude_cache_creation_5m_tokens: i64::from(usage.claude_cache_creation_5m_tokens.max(0)),
        claude_cache_creation_1h_tokens: i64::from(usage.claude_cache_creation_1h_tokens.max(0)),
        image_input_tokens: i64::from(usage.image_input_tokens.max(0)),
        image_output_tokens: i64::from(usage.image_output_tokens.max(0)),
        audio_input_tokens: i64::from(usage.audio_input_tokens.max(0)),
        audio_output_tokens: i64::from(usage.audio_output_tokens.max(0)),
        usage_semantic: if usage.is_anthropic_usage_semantic {
            UsageSemantic::Anthropic
        } else {
            UsageSemantic::OpenAi
        },
    };
    build_tiered_token_params(
        tiered_usage,
        usage.is_anthropic_usage_semantic,
        detect_billing_expr_variables(&snapshot.expr_string),
    )
}

fn billing_request_input(req: &Request, body: &Value) -> RequestInput {
    RequestInput {
        headers: req.headers().entries().collect::<HashMap<_, _>>(),
        body: Some(body.clone()),
    }
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

fn request_header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn request_query_param(req: &Request, name: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

fn quota_mutation_error_status(err: &worker::Error) -> u16 {
    let message = err.to_string().to_ascii_lowercase();
    if message.contains("quota") && message.contains("not enough") {
        403
    } else {
        500
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn endpoint(supports_streaming: bool, feature: Option<&'static str>) -> RelayEndpoint {
        RelayEndpoint {
            display_name: "test",
            cache_family: "test",
            upstream_path: "test".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming,
            force_streaming: false,
            stream_not_implemented_feature: feature,
            parse_non_stream_usage: true,
        }
    }

    #[test]
    fn streaming_supported_endpoint_relays_requested_stream() {
        let endpoint = endpoint(true, None);
        let body = json!({"model": "gpt-test", "stream": true});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn streaming_unsupported_endpoint_reports_feature_when_configured() {
        let endpoint = endpoint(false, Some("streaming test relay"));
        let body = json!({"model": "gpt-test", "stream": true});

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(
            endpoint.stream_not_implemented(&body),
            Some("streaming test relay")
        );
    }

    #[test]
    fn streaming_false_uses_non_streaming_path() {
        let endpoint = endpoint(true, None);
        let body = json!({"model": "gpt-test", "stream": false});

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn anthropic_messages_endpoint_allows_streaming() {
        let endpoint = RelayEndpoint {
            display_name: "Anthropic messages",
            cache_family: "anthropic",
            upstream_path: "messages".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::AnthropicMessages,
            supported_channel_types: ANTHROPIC_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        };
        let body = json!({"model": "claude-test", "stream": true});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn completions_endpoint_allows_streaming() {
        let endpoint = RelayEndpoint {
            display_name: "completions",
            cache_family: "openai_compatible",
            upstream_path: "completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        };
        let body = json!({"model": "gpt-test", "prompt": "hello", "stream": true});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn responses_endpoint_allows_streaming() {
        let endpoint = RelayEndpoint {
            display_name: "responses",
            cache_family: "openai_compatible",
            upstream_path: "responses".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        };
        let body = json!({"model": "gpt-test", "input": "hello", "stream": true});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn image_generations_endpoint_allows_streaming() {
        let endpoint = RelayEndpoint {
            display_name: "image generations",
            cache_family: "openai_compatible",
            upstream_path: "images/generations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        };
        let body = json!({"model": "gpt-image-1", "prompt": "hello", "stream": true});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
        assert_eq!(
            endpoint.upstream_url(&RelayChannel {
                id: 1,
                name: "openai".to_string(),
                channel_type: 1,
                key: "sk-test".to_string(),
                base_url: None,
                models: "gpt-image-1".to_string(),
                channel_group: "default".to_string(),
                model_mapping: None,
                openai_organization: None,
            }),
            "https://api.openai.com/v1/images/generations"
        );
    }

    #[test]
    fn audio_speech_endpoint_skips_non_stream_usage_parsing() {
        let endpoint = RelayEndpoint {
            display_name: "audio speech",
            cache_family: "openai_compatible",
            upstream_path: "audio/speech".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: false,
        };
        let body = json!({
            "model": "gpt-4o-mini-tts",
            "input": "hello",
            "voice": "alloy",
            "stream_format": "audio"
        });

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
        assert!(!endpoint.parse_non_stream_usage);
        assert_eq!(
            endpoint.upstream_url(&RelayChannel {
                id: 1,
                name: "openai".to_string(),
                channel_type: 1,
                key: "sk-test".to_string(),
                base_url: None,
                models: "gpt-4o-mini-tts".to_string(),
                channel_group: "default".to_string(),
                model_mapping: None,
                openai_organization: None,
            }),
            "https://api.openai.com/v1/audio/speech"
        );
    }

    #[test]
    fn gemini_native_endpoint_forces_streaming_from_path_action() {
        let route = GeminiNativePath {
            api_version: "v1beta".to_string(),
            model: "gemini-test".to_string(),
            action: "streamGenerateContent".to_string(),
        };
        let endpoint = RelayEndpoint {
            display_name: "Gemini native generateContent",
            cache_family: "gemini",
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
            supported_channel_types: GEMINI_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: true,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
        };
        let body = json!({"contents": [{"parts": [{"text": "hello"}]}]});

        assert!(endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn gemini_native_embedding_endpoint_stays_non_streaming() {
        let route = GeminiNativePath {
            api_version: "v1beta".to_string(),
            model: "text-embedding-004".to_string(),
            action: "embedContent".to_string(),
        };
        let endpoint = RelayEndpoint {
            display_name: "Gemini native",
            cache_family: "gemini",
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
            supported_channel_types: GEMINI_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: Some("streaming Gemini native action"),
            parse_non_stream_usage: true,
        };
        let body = json!({"content": {"parts": [{"text": "hello"}]}});

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn gemini_native_count_tokens_endpoint_stays_non_streaming() {
        let route = GeminiNativePath {
            api_version: "v1beta".to_string(),
            model: "gemini-test".to_string(),
            action: "countTokens".to_string(),
        };
        let endpoint = RelayEndpoint {
            display_name: "Gemini native",
            cache_family: "gemini",
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
            supported_channel_types: GEMINI_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: Some("streaming Gemini native action"),
            parse_non_stream_usage: true,
        };
        let body = json!({"contents": [{"parts": [{"text": "hello"}]}]});

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
    }

    #[test]
    fn gemini_native_non_stream_action_rejects_stream_body_flag() {
        let endpoint = RelayEndpoint {
            display_name: "Gemini native",
            cache_family: "gemini",
            upstream_path: "v1beta/models/gemini-test:generateContent".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::GeminiNative,
            supported_channel_types: GEMINI_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: Some("streaming Gemini native action"),
            parse_non_stream_usage: true,
        };
        let body = json!({
            "stream": true,
            "contents": [{"parts": [{"text": "hello"}]}]
        });

        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(
            endpoint.stream_not_implemented(&body),
            Some("streaming Gemini native action")
        );
    }

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

    #[test]
    fn usage_summary_converts_to_basic_token_params() {
        let snapshot = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p + c)"#,
            1.0,
            &json!({}),
            RequestInput::default(),
        )
        .unwrap()
        .snapshot;
        let params = token_params_from_usage(
            &snapshot,
            &UsageSummary {
                prompt_tokens: 1_000,
                completion_tokens: 500,
                total_tokens: 1_500,
                ..UsageSummary::default()
            },
        );

        assert_eq!(params.p, 1_000.0);
        assert_eq!(params.c, 500.0);
        assert_eq!(params.len, 1_000.0);
    }

    #[test]
    fn request_prompt_estimate_counts_chat_content_parts() {
        let body = json!({
            "messages": [
                {
                    "role": "user",
                    "name": "ann",
                    "content": [
                        {"type": "text", "text": "abcdefgh"},
                        {"type": "input_text", "text": "ijkl"}
                    ]
                },
                {
                    "role": "assistant",
                    "content": "mnopqrst"
                }
            ]
        });

        assert_eq!(estimate_prompt_tokens_from_request(&body), 21);
    }

    #[test]
    fn request_prompt_estimate_counts_media_parts_without_base64_text() {
        let body = json!({
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "abcdefgh"},
                        {"type": "image_url", "image_url": {"url": "https://example.test/cat.png"}},
                        {"type": "input_audio", "input_audio": {"data": "A".repeat(4096), "format": "wav"}},
                        {"type": "file", "file": {"file_data": "B".repeat(4096)}}
                    ]
                }
            ]
        });

        let estimate = request_token_estimate_from_body(&body);

        assert_eq!(estimate.text_prompt_tokens, 9);
        assert_eq!(estimate.image_input_tokens, ESTIMATED_IMAGE_INPUT_TOKENS);
        assert_eq!(estimate.audio_input_tokens, ESTIMATED_AUDIO_INPUT_TOKENS);
        assert_eq!(estimate.file_input_tokens, ESTIMATED_FILE_INPUT_TOKENS);
        assert_eq!(estimate.video_input_tokens, 0);
        assert_eq!(
            estimate.prompt_tokens(),
            9 + ESTIMATED_IMAGE_INPUT_TOKENS
                + ESTIMATED_AUDIO_INPUT_TOKENS
                + ESTIMATED_FILE_INPUT_TOKENS
        );

        let params = token_params_from_request(&body);
        assert_eq!(params.p, estimate.prompt_tokens() as f64);
        assert_eq!(params.len, estimate.prompt_tokens() as f64);
        assert_eq!(params.img, 0.0);
        assert_eq!(params.ai, 0.0);
    }

    #[test]
    fn request_prompt_estimate_counts_gemini_inline_media_by_mime() {
        let body = json!({
            "contents": [
                {
                    "parts": [
                        {"text": "abcdefgh"},
                        {"inline_data": {"mime_type": "image/png", "data": "A".repeat(1024)}},
                        {"inlineData": {"mimeType": "audio/wav", "data": "B".repeat(1024)}},
                        {"inline_data": {"mime_type": "video/mp4", "data": "C".repeat(1024)}},
                        {"file_data": {"mime_type": "application/pdf", "file_uri": "https://example.test/doc.pdf"}}
                    ]
                }
            ]
        });

        let estimate = request_token_estimate_from_body(&body);

        assert_eq!(estimate.text_prompt_tokens, 2);
        assert_eq!(estimate.image_input_tokens, ESTIMATED_IMAGE_INPUT_TOKENS);
        assert_eq!(estimate.audio_input_tokens, ESTIMATED_AUDIO_INPUT_TOKENS);
        assert_eq!(estimate.video_input_tokens, ESTIMATED_VIDEO_INPUT_TOKENS);
        assert_eq!(estimate.file_input_tokens, ESTIMATED_FILE_INPUT_TOKENS);
        assert_eq!(
            estimate.prompt_tokens(),
            2 + ESTIMATED_IMAGE_INPUT_TOKENS
                + ESTIMATED_AUDIO_INPUT_TOKENS
                + ESTIMATED_VIDEO_INPUT_TOKENS
                + ESTIMATED_FILE_INPUT_TOKENS
        );
    }

    #[test]
    fn request_completion_estimate_uses_largest_known_limit() {
        let body = json!({
            "max_tokens": 10,
            "max_completion_tokens": 24,
            "max_output_tokens": 20
        });

        assert_eq!(estimate_completion_tokens_from_request(&body), 24);
    }

    #[test]
    fn tiered_billing_settlement_normalizes_usage_details_for_expression_variables() {
        let request_body = json!({
            "prompt": "x".repeat(4000),
            "max_completion_tokens": 100
        });
        let request = RequestInput::from_json_body(request_body.clone());
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("detail", p * 2 + c * 10 + cr * 0.5 + img * 3 + ao * 20)"#,
            1.0,
            &request_body,
            request.clone(),
        )
        .unwrap();
        let usage = UsageSummary {
            prompt_tokens: 1_000,
            completion_tokens: 600,
            total_tokens: 1_600,
            cached_tokens: 200,
            image_input_tokens: 100,
            audio_output_tokens: 50,
            ..UsageSummary::default()
        };

        let params = token_params_from_usage(&preflight.snapshot, &usage);
        assert_eq!(params.p, 700.0);
        assert_eq!(params.c, 550.0);
        assert_eq!(params.len, 1_000.0);
        assert_eq!(params.cr, 200.0);
        assert_eq!(params.img, 100.0);
        assert_eq!(params.ao, 50.0);

        let outcome = tiered_billing_settlement(&preflight.snapshot, &usage, &request).unwrap();
        assert_eq!(outcome.result.actual_expression_cost, 8_300.0);
        assert_eq!(outcome.final_quota, 4_150);
    }

    #[test]
    fn tiered_billing_settlement_uses_frozen_preflight_snapshot() {
        let request_body = json!({
            "prompt": "x".repeat(4000),
            "max_completion_tokens": 100,
            "service_tier": "fast"
        });
        let request = RequestInput::from_json_body(request_body.clone());
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"param("service_tier") == "fast" ? tier("fast", p * 4 + c * 20) : tier("normal", p * 2 + c * 10)"#,
            1.5,
            &request_body,
            request.clone(),
        )
        .unwrap();
        let outcome = tiered_billing_settlement(
            &preflight.snapshot,
            &UsageSummary {
                prompt_tokens: 1_000,
                completion_tokens: 500,
                total_tokens: 1_500,
                ..UsageSummary::default()
            },
            &request,
        )
        .unwrap();
        let metadata = tiered_billing_metadata(
            outcome.snapshot,
            preflight.pre_consumed_quota,
            outcome.result,
            true,
            false,
        );

        assert_eq!(metadata["billing_mode"], "tiered_expr");
        assert_eq!(metadata["shadow_only"], true);
        assert_eq!(metadata["applied"], false);
        assert_eq!(metadata["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(metadata["has_request_rule"], false);
        assert_eq!(metadata["pre_consumed_quota"], 4_500);
        assert_eq!(metadata["estimated_prompt_tokens"], 1_000);
        assert_eq!(metadata["estimated_completion_tokens"], 100);
        assert_eq!(metadata["estimated_quota_after_group"], 4_500);
        assert_eq!(metadata["matched_tier"], "fast");
        assert_eq!(metadata["group_ratio"], 1.5);
        assert_eq!(metadata["quota_before_group"], 7_000.0);
        assert_eq!(metadata["quota_after_group"], 10_500);
        assert_eq!(metadata["settlement"]["final_quota"], 10_500);
        assert_eq!(metadata["settlement"]["additional_quota"], 6_000);
    }

    #[test]
    fn base64_standard_encode_matches_go_std_encoding() {
        assert_eq!(base64_standard_encode(""), "");
        assert_eq!(base64_standard_encode("f"), "Zg==");
        assert_eq!(base64_standard_encode("fo"), "Zm8=");
        assert_eq!(base64_standard_encode("foo"), "Zm9v");
        assert_eq!(base64_standard_encode("hello"), "aGVsbG8=");
    }

    #[test]
    fn tiered_log_display_metadata_encodes_base_expression_without_request_rule() {
        let request_body = json!({
            "prompt": "x".repeat(4000),
            "max_completion_tokens": 100,
            "service_tier": "fast"
        });
        let request = RequestInput::from_json_body(request_body.clone());
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p + c)|||(param("service_tier") == "fast" ? 2 : 1)"#,
            1.0,
            &request_body,
            request.clone(),
        )
        .unwrap();
        let outcome = tiered_billing_settlement(
            &preflight.snapshot,
            &UsageSummary {
                prompt_tokens: 1_000,
                completion_tokens: 500,
                total_tokens: 1_500,
                ..UsageSummary::default()
            },
            &request,
        )
        .unwrap();
        let mut other = json!({});

        apply_tiered_log_display_metadata(&mut other, &outcome.snapshot, Some(&outcome.result));

        assert_eq!(other["billing_mode"], "tiered_expr");
        assert_eq!(other["matched_tier"], "base");
        assert_eq!(
            other["expr_b64"],
            base64_standard_encode(r#"tier("base", p + c)"#)
        );
        assert_ne!(
            other["expr_b64"],
            base64_standard_encode(
                r#"tier("base", p + c)|||(param("service_tier") == "fast" ? 2 : 1)"#
            )
        );
    }

    #[test]
    fn tiered_billing_fallback_and_refund_metadata_include_reserved_quota() {
        let request_body = json!({
            "prompt": "x".repeat(4000),
            "max_completion_tokens": 100
        });
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p * 4 + c * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#,
            1.5,
            &request_body,
            RequestInput::from_json_body(request_body.clone()),
        )
        .unwrap();

        let fallback =
            tiered_billing_fallback_metadata(&preflight, "settlement failed".to_string(), true);
        assert_eq!(fallback["fallback_to_pre_consumed"], true);
        assert_eq!(fallback["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(fallback["has_request_rule"], true);
        assert_eq!(fallback["pre_consumed_quota"], 4_500);

        let refund = tiered_billing_refund_metadata(&preflight, "missing_usage");
        assert_eq!(refund["refunded"], true);
        assert_eq!(refund["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(refund["has_request_rule"], true);
        assert_eq!(refund["pre_consumed_quota"], 4_500);
        assert_eq!(refund["reason"], "missing_usage");
    }

    #[test]
    fn refund_reason_distinguishes_missing_stream_usage() {
        assert_eq!(
            refund_reason(200, &UsageSummary::default(), true),
            "missing_stream_usage"
        );
        assert_eq!(
            refund_reason(200, &UsageSummary::default(), false),
            "missing_usage"
        );
    }
}
