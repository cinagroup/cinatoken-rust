use cinatoken_billing::{
    build_tiered_token_params, compute_flat_quota, compute_tiered_quota_with_request,
    detect_billing_expr_variables, estimate_tiered_billing_snapshot_with_request,
    split_billing_expr_request_rule, BillingExprVariables, FlatBillingMode, FlatQuotaResult,
    FlatUsage, PricingConfig, RequestInput, TieredBillingResult, TieredBillingSnapshot,
    TieredTokenUsage, TokenParams, UsageSemantic,
};
use cinatoken_cache::{ExpiringCounterRateLimiter, KeyValueCache, RateLimiter, UpstashRedis};
use cinatoken_core::{
    audio_duration_seconds, audio_transcription_tokens, auto_group_retry_step,
    format_matching_model_name, image_dimensions, image_tokens, image_tokens_needs_dimensions,
    is_openai_text_model, openai_chat_format_overhead, select_weighted, ApiError, ApiResult,
    Candidate, ErrorBody, MediaTokenFlags,
};
use cinatoken_providers::{
    ai_gateway::{
        plan_ai_gateway_cutover, rest_gateway_endpoint_url, AiGatewayCutoverDecision,
        AiGatewayCutoverInput, AiGatewayCutoverPlan,
    },
    ProviderEndpoint, ProviderKind as RegistryProviderKind, ProviderRegistry,
};
use cinatoken_relay::{
    apply_gemini_native_model_mapping, apply_model_mapping, clamp_i64_to_i32, csv_contains,
    first_channel_key, ip_allowlist_matches, is_auto_disable_status, is_retryable_status,
    mapped_model_name, usage_summary_from_anthropic_body, usage_summary_from_body,
    usage_summary_from_gemini_body, usage_summary_from_rerank_body, CachedAuthenticatedToken,
    CachedRelayChannel, GeminiNativePath, RelayCacheKeys, SseUsageAccumulator, UsageSummary,
    ANTHROPIC_CHANNEL_TYPES, CHANNEL_TYPE_COHERE, GEMINI_CHANNEL_TYPES,
    OPENAI_COMPATIBLE_CHANNEL_TYPES, RERANK_CHANNEL_TYPES,
};
use cinatoken_storage::{AuthenticatedToken, RelayAuditLog, RelayChannel};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Env, Fetch, Headers, Method, Request, RequestInit, Response, ResponseBody,
};

use crate::{affinity, json_with_status, set_cors_headers};

const TOKEN_STATUS_EXPIRED: i32 = 3;
const TOKEN_STATUS_EXHAUSTED: i32 = 4;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS: u32 = 60;
const TOKEN_RATE_LIMIT_ENV: &str = "RELAY_TOKEN_RATE_LIMIT_PER_WINDOW";
const IP_RATE_LIMIT_ENV: &str = "RELAY_IP_RATE_LIMIT_PER_WINDOW";
const RATE_LIMIT_WINDOW_ENV: &str = "RELAY_RATE_LIMIT_WINDOW_SECONDS";
const RELAY_CACHE_TTL_ENV: &str = "RELAY_CACHE_TTL_SECONDS";
const RELAY_JSON_BODY_LIMIT_ENV: &str = "RELAY_JSON_BODY_LIMIT_BYTES";
const RELAY_JSON_RESPONSE_LIMIT_ENV: &str = "RELAY_JSON_RESPONSE_LIMIT_BYTES";
const RELAY_RETRY_TIMES_ENV: &str = "RELAY_RETRY_TIMES";
const RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV: &str = "RELAY_AI_GATEWAY_ROUTER_ENABLED";
const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_TOKEN_ENV: &str = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_AI_GATEWAY_TOKEN_ENV: &str = "CLOUDFLARE_AI_GATEWAY_TOKEN";
const AI_GATEWAY_ID_ENV: &str = "AI_GATEWAY_ID";
/// When set (`true`/`1`), a missing or invalid upstream usage block triggers
/// Go's estimate-and-bill fallback instead of refunding the reserve. Default off
/// preserves the current refund-on-missing behavior; flipping it on is the
/// charge-affecting, staging-gated cutover to Go parity.
const MISSING_USAGE_ESTIMATE_ENV: &str = "RELAY_MISSING_USAGE_ESTIMATE_ENABLED";
/// When set, the relay injects `stream_options.include_usage=true` into
/// streaming OpenAI-compatible upstream requests for channels that support it
/// (and strips `stream_options` for those that do not), so the upstream emits a
/// real usage chunk instead of relying on the local estimate. Off by default;
/// behavior-affecting (changes the upstream request and client-facing stream),
/// staging-gated.
const STREAM_OPTIONS_INJECT_ENV: &str = "RELAY_STREAM_OPTIONS_INJECT_ENABLED";
/// When set, the relay inspects a retried channel's error body for a default
/// auto-disable keyword (Go `AutomaticDisableKeywords`) and bans the channel
/// off-path when matched — the keyword branch of Go `ShouldDisableChannel`, on
/// top of the existing status-code (401) and failure-threshold disables. Off by
/// default; behavior-affecting (disables channels), staging-gated.
const CHANNEL_KEYWORD_BAN_ENV: &str = "RELAY_CHANNEL_KEYWORD_BAN_ENABLED";
/// Bound on the error-body prefix read for keyword matching (error bodies are
/// small JSON; this only runs on a response that is about to be discarded).
const CHANNEL_KEYWORD_BAN_MAX_BYTES: usize = 16 * 1024;
const CHANNEL_AUTOBAN_THRESHOLD_ENV: &str = "RELAY_CHANNEL_AUTOBAN_THRESHOLD";
const DEFAULT_RELAY_CACHE_TTL_SECONDS: u32 = 60;
const DEFAULT_RELAY_JSON_BODY_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const EMBEDDINGS_JSON_RESPONSE_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const IMAGE_JSON_RESPONSE_LIMIT_BYTES: usize = 24 * 1024 * 1024;
const RERANK_JSON_RESPONSE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const GEMINI_JSON_RESPONSE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const ESTIMATED_IMAGE_INPUT_TOKENS: i64 = 520;
const ESTIMATED_AUDIO_INPUT_TOKENS: i64 = 256;
const ESTIMATED_VIDEO_INPUT_TOKENS: i64 = 4_096 * 2;
const ESTIMATED_FILE_INPUT_TOKENS: i64 = 4_096;
const MODEL_OBJECT_CREATED: i64 = 1_626_777_600;
const MODEL_LIST_CACHE_MODEL_KEY: &str = "__model_list__";

#[derive(Clone, Copy, PartialEq, Eq)]
enum RelayProviderKind {
    OpenAiCompatible,
    AnthropicMessages,
    GeminiNative,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ModelListFormat {
    OpenAi,
    Anthropic,
    Gemini,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RelayRequestBodyMode {
    Json,
    #[allow(dead_code)]
    MultipartForm,
    #[allow(dead_code)]
    RawBytes,
    #[allow(dead_code)]
    PassThroughStream,
}

impl RelayRequestBodyMode {
    fn body_kind(self) -> &'static str {
        match self {
            Self::Json => "JSON",
            Self::MultipartForm => "multipart",
            Self::RawBytes => "raw",
            Self::PassThroughStream => "pass-through stream",
        }
    }

    fn content_type_policy(self) -> RelayContentTypePolicy {
        match self {
            Self::Json => RelayContentTypePolicy::json(),
            Self::MultipartForm => RelayContentTypePolicy::multipart(),
            Self::RawBytes | Self::PassThroughStream => RelayContentTypePolicy::any(),
        }
    }

    fn pending_feature(self) -> Option<String> {
        match self {
            Self::Json | Self::MultipartForm => None,
            _ => Some(format!("{} relay request body mode", self.body_kind())),
        }
    }
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
    request_body_mode: RelayRequestBodyMode,
    request_validator: Option<fn(&Value) -> Option<&'static str>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayAuthMode {
    ApiKey,
    PlaygroundSession,
}

impl RelayEndpoint {
    fn expects_json_request_body(&self) -> bool {
        self.request_body_mode == RelayRequestBodyMode::Json
    }

    /// Whether requests to this endpoint arrive in the OpenAI chat-completions
    /// format (Go `types.RelayFormatOpenAI`). Only this format gets the
    /// `tools*8 + messages*3 + name*3 + 3` token overhead; Anthropic `/messages`
    /// (which also carries a `messages` array) and Gemini do not.
    fn uses_openai_chat_format(&self) -> bool {
        matches!(self.provider, RelayProviderKind::OpenAiCompatible)
            && self.upstream_path == "chat/completions"
    }

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

    #[cfg(test)]
    fn upstream_url(&self, channel: &RelayChannel) -> String {
        self.try_upstream_url(channel)
            .expect("relay endpoint should have a valid provider route")
    }

    fn try_upstream_url(&self, channel: &RelayChannel) -> worker::Result<String> {
        let route = ProviderRegistry::resolve(ProviderEndpoint {
            provider: self.registry_provider_kind(),
            channel_type: channel.channel_type,
            base_url: channel.base_url.as_deref(),
            endpoint_path: &self.upstream_path,
            upstream_query: self.upstream_query.as_deref(),
            gemini_route: self.gemini_route.as_ref(),
        })
        .map_err(|err| {
            worker::Error::RustError(format!("provider route resolution failed: {err}"))
        })?;
        Ok(route.upstream_url)
    }

    fn registry_provider_kind(&self) -> RegistryProviderKind {
        match self.provider {
            RelayProviderKind::OpenAiCompatible => RegistryProviderKind::OpenAiCompatible,
            RelayProviderKind::AnthropicMessages => RegistryProviderKind::AnthropicMessages,
            RelayProviderKind::GeminiNative => RegistryProviderKind::GeminiNative,
        }
    }

    fn default_json_response_limit_bytes(&self) -> usize {
        match self.provider {
            RelayProviderKind::GeminiNative => GEMINI_JSON_RESPONSE_LIMIT_BYTES,
            RelayProviderKind::OpenAiCompatible => match self.upstream_path.as_str() {
                "embeddings" => EMBEDDINGS_JSON_RESPONSE_LIMIT_BYTES,
                "images/generations" => IMAGE_JSON_RESPONSE_LIMIT_BYTES,
                "rerank" => RERANK_JSON_RESPONSE_LIMIT_BYTES,
                _ => DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES,
            },
            RelayProviderKind::AnthropicMessages => DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES,
        }
    }
}

pub async fn list_models(req: Request, env: Env) -> worker::Result<Response> {
    let format = if is_anthropic_model_list_request(&req) {
        ModelListFormat::Anthropic
    } else {
        ModelListFormat::OpenAi
    };
    list_models_with_format(req, env, format).await
}

pub async fn list_gemini_models(req: Request, env: Env) -> worker::Result<Response> {
    list_models_with_format(req, env, ModelListFormat::Gemini).await
}

pub async fn list_gemini_openai_models(req: Request, env: Env) -> worker::Result<Response> {
    list_models_with_format(req, env, ModelListFormat::OpenAi).await
}

pub async fn retrieve_model(
    req: Request,
    env: Env,
    model: Option<&str>,
) -> worker::Result<Response> {
    let model = model.map(str::trim).filter(|model| !model.is_empty());
    let Some(model) = model else {
        return model_not_found_response("");
    };
    let format = if is_anthropic_model_list_request(&req) {
        ModelListFormat::Anthropic
    } else {
        ModelListFormat::OpenAi
    };
    let visible_models = match authenticated_visible_models(&req, &env).await {
        Ok(models) => models,
        Err(response) => return response,
    };
    if !model_visible(&visible_models, model) {
        return model_not_found_response(model);
    }
    match format {
        ModelListFormat::OpenAi => json_with_status(&openai_model_object(model), 200),
        ModelListFormat::Anthropic => json_with_status(&anthropic_model_object(model), 200),
        ModelListFormat::Gemini => json_with_status(&gemini_model_object(model), 200),
    }
}

async fn list_models_with_format(
    req: Request,
    env: Env,
    format: ModelListFormat,
) -> worker::Result<Response> {
    let models = match authenticated_visible_models(&req, &env).await {
        Ok(models) => models,
        Err(response) => return response,
    };
    json_with_status(&model_list_response(format, &models), 200)
}

async fn authenticated_visible_models(
    req: &Request,
    env: &Env,
) -> Result<Vec<String>, worker::Result<Response>> {
    let api_key = match extract_api_key(req) {
        Some(key) => key,
        None => {
            return Err(json_with_status(
                &ErrorBody::bad_request("missing Authorization Bearer token or x-api-key"),
                401,
            ));
        }
    };
    let db = env.d1("DB").map_err(|err| worker_error_response(err))?;
    let client_ip = client_ip(req);
    let auth = authenticate_for_model_list(&db, env, &api_key, client_ip.as_deref()).await?;
    model_names_for_authenticated_token(&db, &auth).await
}

async fn model_names_for_authenticated_token(
    db: &D1Database,
    auth: &AuthenticatedToken,
) -> Result<Vec<String>, worker::Result<Response>> {
    if auth.model_limits_enabled != 0 {
        return Ok(csv_model_names(&auth.model_limits));
    }
    let group = auth.effective_group();
    let groups = if group == "auto" {
        let groups = crate::d1_repositories::resolve_user_auto_groups(db, &auth.user_group)
            .await
            .map_err(worker_error_response)?;
        if groups.is_empty() {
            return Err(json_with_status(
                &ErrorBody::bad_request("auto groups is not enabled"),
                503,
            ));
        }
        groups
    } else {
        vec![group.to_string()]
    };
    let mut models = Vec::new();
    for group in groups {
        for model in crate::d1_repositories::distinct_enabled_models_for_group(db, &group)
            .await
            .map_err(worker_error_response)?
        {
            push_unique_model(&mut models, model);
        }
    }
    Ok(models)
}

fn model_list_response(format: ModelListFormat, models: &[String]) -> Value {
    match format {
        ModelListFormat::OpenAi => json!({
            "success": true,
            "data": models.iter().map(|model| openai_model_object(model)).collect::<Vec<_>>(),
            "object": "list",
        }),
        ModelListFormat::Anthropic => {
            let data = models
                .iter()
                .map(|model| anthropic_model_object(model))
                .collect::<Vec<_>>();
            json!({
                "data": data,
                "first_id": models.first().cloned().unwrap_or_default(),
                "has_more": false,
                "last_id": models.last().cloned().unwrap_or_default(),
            })
        }
        ModelListFormat::Gemini => json!({
            "models": models.iter().map(|model| gemini_model_object(model)).collect::<Vec<_>>(),
            "nextPageToken": Value::Null,
        }),
    }
}

fn openai_model_object(model: &str) -> Value {
    json!({
        "id": model,
        "object": "model",
        "created": MODEL_OBJECT_CREATED,
        "owned_by": "custom",
        "supported_endpoint_types": [],
    })
}

fn anthropic_model_object(model: &str) -> Value {
    json!({
        "id": model,
        "created_at": "2021-07-20T16:00:00Z",
        "display_name": model,
        "type": "model",
    })
}

fn gemini_model_object(model: &str) -> Value {
    json!({
        "name": model,
        "displayName": model,
    })
}

fn model_not_found_response(model: &str) -> worker::Result<Response> {
    json_with_status(
        &json!({
            "error": {
                "message": format!("The model '{model}' does not exist"),
                "type": "invalid_request_error",
                "param": "model",
                "code": "model_not_found",
            }
        }),
        200,
    )
}

fn is_anthropic_model_list_request(req: &Request) -> bool {
    request_header(req, "x-api-key").is_some() && request_header(req, "anthropic-version").is_some()
}

fn csv_model_names(raw: &str) -> Vec<String> {
    let mut models = Vec::new();
    for model in raw.split([',', '\n', '\r']) {
        push_unique_model(&mut models, model.trim().to_string());
    }
    models
}

fn push_unique_model(models: &mut Vec<String>, model: String) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    if !models.iter().any(|existing| existing == model) {
        models.push(model.to_string());
    }
}

fn model_visible(models: &[String], model: &str) -> bool {
    models.iter().any(|candidate| candidate == model)
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

/// `POST /pg/chat/completions`: the logged-in dashboard playground uses the
/// normal OpenAI chat-completions relay with a Go-compatible temporary token
/// context (`token_id = 0`, `token_name = playground-{group}`).
pub async fn playground_chat_completions(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint_with_auth(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "playground chat completions",
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
        None,
        RelayAuthMode::PlaygroundSession,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

pub async fn engine_embeddings(
    req: Request,
    env: Env,
    context: Context,
    model: Option<String>,
) -> worker::Result<Response> {
    let Some(model) = model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
    else {
        return json_with_status(
            &ErrorBody::bad_request("engine embeddings path must include a non-empty model"),
            400,
        );
    };
    relay_endpoint_with_json_model_fallback(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "engine embeddings",
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        Some(model.clone()),
        Some(model),
    )
    .await
}

pub async fn rerank(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "rerank",
            cache_family: "rerank",
            upstream_path: "rerank".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: RERANK_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: Some("streaming rerank relay"),
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: Some(validate_rerank_request),
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

pub async fn audio_transcriptions(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "audio transcriptions",
            cache_family: "openai_compatible",
            upstream_path: "audio/transcriptions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            // Whisper returns a text response, not a `usage` block. Billing
            // uses 0 tokens unless the operator configures a flat
            // `ModelPrice` for the whisper model.
            parse_non_stream_usage: false,
            request_body_mode: RelayRequestBodyMode::MultipartForm,
            request_validator: None,
        },
        None,
    )
    .await
}

pub async fn audio_translations(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "audio translations",
            cache_family: "openai_compatible",
            upstream_path: "audio/translations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: false,
            request_body_mode: RelayRequestBodyMode::MultipartForm,
            request_validator: None,
        },
        None,
    )
    .await
}

pub async fn image_edits(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "image edits",
            cache_family: "openai_compatible",
            upstream_path: "images/edits".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            // Image edits return the same shape as image generations, so we
            // parse usage from the non-stream response body.
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::MultipartForm,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

/// `POST /v1/moderations` (Go relay passthrough): OpenAI-compatible JSON
/// relay. Moderations responses carry no usage; the missing-usage settlement
/// path applies as configured.
pub async fn moderations(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "moderations",
            cache_family: "openai_compatible",
            upstream_path: "moderations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

/// `POST /v1/edits` (Go relay passthrough): the legacy OpenAI edits endpoint.
pub async fn edits(req: Request, env: Env, context: Context) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "edits",
            cache_family: "openai_compatible",
            upstream_path: "edits".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

/// `POST /v1/responses/compact` (Go relay passthrough).
pub async fn responses_compact(
    req: Request,
    env: Env,
    context: Context,
) -> worker::Result<Response> {
    relay_endpoint(
        req,
        env,
        Some(context),
        RelayEndpoint {
            display_name: "responses compact",
            cache_family: "openai_compatible",
            upstream_path: "responses/compact".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: OPENAI_COMPATIBLE_CHANNEL_TYPES,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        None,
    )
    .await
}

/// Go `RelayNotImplemented`: the structured 501 the unimplemented OpenAI
/// surface (files, fine-tunes, image variations, model delete) returns.
pub fn relay_not_implemented() -> worker::Result<Response> {
    let body = serde_json::json!({
        "error": {
            "message": "API not implemented",
            "type": "new_api_error",
            "param": "",
            "code": "api_not_implemented",
        }
    });
    Response::from_json(&body).map(|response| response.with_status(501))
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        },
        Some(route.model),
    )
    .await
}

async fn relay_endpoint(
    req: Request,
    env: Env,
    context: Option<Context>,
    endpoint: RelayEndpoint,
    model_override: Option<String>,
) -> worker::Result<Response> {
    relay_endpoint_with_json_model_fallback(req, env, context, endpoint, model_override, None).await
}

async fn relay_endpoint_with_json_model_fallback(
    req: Request,
    env: Env,
    context: Option<Context>,
    endpoint: RelayEndpoint,
    model_override: Option<String>,
    json_model_fallback: Option<String>,
) -> worker::Result<Response> {
    relay_endpoint_with_auth(
        req,
        env,
        context,
        endpoint,
        model_override,
        json_model_fallback,
        RelayAuthMode::ApiKey,
    )
    .await
}

async fn relay_endpoint_with_auth(
    mut req: Request,
    env: Env,
    context: Option<Context>,
    mut endpoint: RelayEndpoint,
    model_override: Option<String>,
    json_model_fallback: Option<String>,
    auth_mode: RelayAuthMode,
) -> worker::Result<Response> {
    let started_at = unix_timestamp();
    let client_ip = client_ip(&req);
    let request_id = request_id(&req);
    let provider_headers = RelayProviderHeaders::from_request(&req);

    let json_body_config = match RelayJsonBodyConfig::from_env(&env) {
        Ok(config) => config,
        Err(err) => {
            return openai_error_response(
                format!("invalid relay JSON body configuration: {err}"),
                500,
            );
        }
    };
    let json_response_config = match RelayJsonResponseConfig::from_env(&env) {
        Ok(config) => config,
        Err(err) => {
            return openai_error_response(
                format!("invalid relay JSON response configuration: {err}"),
                500,
            );
        }
    };
    let prepared_request = match prepare_relay_request(
        &mut req,
        &endpoint,
        json_body_config,
        json_model_fallback.as_deref(),
    )
    .await?
    {
        Ok(prepared_request) => prepared_request,
        Err(response) => return Ok(response),
    };
    let request_body = prepared_request.body;
    let billing_request_input = prepared_request.billing_request_input;
    let extra_prompt_tokens = prepared_request.extra_prompt_tokens;

    // Multipart/raw bodies do not support streaming or model-mapping rewrites;
    // they are forwarded verbatim. JSON bodies go through the full pipeline.
    let (model, should_relay_stream, json_body) = match &request_body {
        RelayRequestBody::Json(value) => {
            if let Some(feature) = endpoint.stream_not_implemented(value) {
                return json_with_status(&ErrorBody::not_implemented(feature), 501);
            }
            let stream = endpoint.should_relay_stream(value);
            let model = model_override
                .clone()
                .or_else(|| {
                    value
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            (model, stream, Some(value.clone()))
        }
        RelayRequestBody::Raw { .. } => {
            // Upload endpoints never stream and never carry a JSON body.
            let model = model_override
                .clone()
                .or_else(|| request_body.model())
                .unwrap_or_default();
            (model, false, None)
        }
    };
    let model = match model.trim() {
        "" => {
            return json_with_status(
                &ErrorBody::bad_request("request body must include a non-empty model"),
                400,
            );
        }
        trimmed => trimmed.to_string(),
    };
    if should_relay_stream && context.is_none() {
        return openai_error_response("streaming relay context is unavailable", 500);
    }

    let db = env.d1("DB")?;
    let auth = match auth_mode {
        RelayAuthMode::ApiKey => {
            let api_key = match extract_api_key(&req) {
                Some(key) => key,
                None => {
                    return json_with_status(
                        &ErrorBody::bad_request("missing Authorization Bearer token or x-api-key"),
                        401,
                    );
                }
            };
            match authenticate(&db, &env, &api_key, &model, client_ip.as_deref()).await {
                Ok(auth) => auth,
                Err(response) => return response,
            }
        }
        RelayAuthMode::PlaygroundSession => {
            match authenticate_playground_session(&req, &env, &db, json_body.as_ref()).await {
                Ok(auth) => auth,
                Err(response) => return response,
            }
        }
    };
    let group = auth.effective_group().to_string();

    if let Err(response) = enforce_relay_rate_limits(&env, &auth, client_ip.as_deref()).await {
        return response;
    }

    let retry_config = match RelayRetryConfig::from_env(&env) {
        Ok(config) => config,
        Err(err) => {
            return openai_error_response(format!("invalid relay retry configuration: {err}"), 500);
        }
    };

    // Resolve the candidate pool(s). For an "auto" token group, walk the user's
    // auto groups (Go `CacheGetRandomSatisfiedChannel`); otherwise a single group.
    let is_auto = group == "auto";
    let group_pools: Vec<(String, Vec<RelayChannel>)> = if is_auto {
        let auto_groups =
            match crate::d1_repositories::resolve_user_auto_groups(&db, &auth.user_group).await {
                Ok(groups) => groups,
                Err(err) => {
                    return openai_error_response(
                        format!("failed to resolve auto groups: {err}"),
                        500,
                    );
                }
            };
        if auto_groups.is_empty() {
            return json_with_status(&ErrorBody::bad_request("auto groups is not enabled"), 503);
        }
        let mut pools = Vec::with_capacity(auto_groups.len());
        for auto_group in auto_groups {
            match select_channels(
                &db,
                &env,
                &model,
                &auto_group,
                endpoint.cache_family,
                endpoint.supported_channel_types,
            )
            .await
            {
                Ok(candidates) => pools.push((auto_group, candidates)),
                Err(response) => return response,
            }
        }
        pools
    } else {
        match select_channels(
            &db,
            &env,
            &model,
            &group,
            endpoint.cache_family,
            endpoint.supported_channel_types,
        )
        .await
        {
            Ok(candidates) => vec![(group.clone(), candidates)],
            Err(response) => return response,
        }
    };

    // Plan the ordered (group, channel) attempts up front. `cross_group_retry`
    // is not yet a ported per-token setting; auto tokens default to enabled so
    // priority exhaustion advances to the next group (documented divergence).
    let cross_group_retry = true;
    let attempt_plan = plan_relay_attempts(
        group_pools,
        is_auto,
        retry_config.max_attempts(),
        retry_config.retry_times as i32,
        cross_group_retry,
        random_u64_below,
    )?;

    // Channel affinity (sticky routing): when enabled, prefer the user's last
    // successful channel for this (model, group) if it is still a live candidate
    // (moved to the front of the plan, with the planned order as fallback). Fails
    // open — flag off, no DO binding, or any DO error leaves the plan unchanged.
    let affinity_key =
        affinity::affinity_enabled(optional_env_var(&env, affinity::AFFINITY_ENABLED_ENV))
            .then(|| affinity::affinity_key(auth.user_id, &model, &group));
    let attempt_plan = if let Some(key) = affinity_key.as_deref() {
        let preferred = affinity::lookup_preferred_channel(&env, key).await;
        affinity::move_preferred_to_front(attempt_plan, preferred, |plan| plan.channel.id)
    } else {
        attempt_plan
    };

    // Billing uses the selected group's ratio (Go resolves the ratio post-
    // selection). The first planned attempt's group is the one used unless a
    // cross-group retry advances; settlement below uses the actual serving group.
    let billing_group = attempt_plan
        .first()
        .map(|plan| plan.group.clone())
        .unwrap_or_else(|| group.clone());

    let tiered_billing_preflight = match prepare_tiered_billing_preflight(
        &db,
        &model,
        &billing_group,
        json_body.as_ref().unwrap_or(&Value::Null),
        &billing_request_input,
        endpoint.uses_openai_chat_format(),
        extra_prompt_tokens,
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

    let mut last_failure: Option<RelayAttemptFailure> = None;
    // (channel, selected group, upstream response). The group is the channel's
    // actual serving group (for cross-group it can differ from `billing_group`).
    let mut selected_attempt: Option<(RelayChannel, String, Response)> = None;

    // Selection is planned up front (priority tier + weighted-random, shrinking
    // each group's pool, plus the auto cross-group walk). The loop forwards each
    // planned channel in order, stopping at the first non-retryable response.
    let attempt_count = attempt_plan.len();
    let inject_stream_options = stream_options_inject_enabled(&env);
    let keyword_ban_enabled = channel_keyword_ban_enabled(&env);
    let ai_gateway_runtime = RelayAiGatewayRuntime::from_env(&env);

    for (attempt_index, plan) in attempt_plan.into_iter().enumerate() {
        let RelayAttemptPlan {
            group: selected_group,
            channel,
        } = plan;

        let upstream_key = match first_channel_key(&channel.key) {
            Some(key) => key,
            None => {
                last_failure = Some(RelayAttemptFailure::no_key(
                    channel.id,
                    channel.name.clone(),
                ));
                continue;
            }
        };

        let upstream_url = match endpoint.try_upstream_url(&channel) {
            Ok(url) => url,
            Err(err) => return worker_error_response(err),
        };

        let forward_result = match &request_body {
            RelayRequestBody::Json(_) => {
                let Some(mut upstream_body) = json_body.clone() else {
                    break;
                };
                if auth_mode == RelayAuthMode::PlaygroundSession {
                    strip_playground_request_fields(&mut upstream_body);
                }
                apply_model_mapping(&mut upstream_body, &model, channel.model_mapping.as_deref());
                if endpoint.provider == RelayProviderKind::GeminiNative {
                    if let Some(mapped_model) =
                        mapped_model_name(&model, channel.model_mapping.as_deref())
                    {
                        apply_gemini_native_model_mapping(
                            &mut upstream_body,
                            &model,
                            &mapped_model,
                        );
                        if let Some(route) = endpoint.gemini_route.as_mut() {
                            route.model = mapped_model;
                            endpoint.upstream_path = route.upstream_path();
                        }
                    }
                }
                apply_endpoint_request_transform(
                    &mut upstream_body,
                    &endpoint.upstream_path,
                    &channel,
                );
                // Inject/strip `stream_options.include_usage` for OpenAI-compatible
                // upstreams (Go parity) so supporting channels emit a real usage
                // chunk instead of forcing the local estimate. Native Anthropic/
                // Gemini providers carry usage natively and are left untouched.
                if inject_stream_options && endpoint.provider == RelayProviderKind::OpenAiCompatible
                {
                    cinatoken_relay::openai_compatible::apply_stream_options(
                        &mut upstream_body,
                        channel.channel_type,
                        should_relay_stream,
                    );
                }
                // Workers AI binding channels (type 39, key `internal`) run
                // in-platform instead of over HTTP. Chat completions only;
                // streaming is not supported by the synthesized path, so it is
                // answered with an upstream-shaped 400 (flows the normal
                // upstream-error handling, unbilled).
                if is_workers_ai_binding_channel(&channel)
                    && endpoint.provider == RelayProviderKind::OpenAiCompatible
                    && endpoint.upstream_path == "chat/completions"
                {
                    if should_relay_stream {
                        let error_body = serde_json::json!({
                            "error": {
                                "message": "streaming is not supported for Workers AI binding channels",
                                "type": "invalid_request_error",
                            }
                        });
                        Response::from_json(&error_body).map(|response| response.with_status(400))
                    } else {
                        let upstream_model = upstream_body
                            .get("model")
                            .and_then(Value::as_str)
                            .unwrap_or(&model)
                            .to_string();
                        forward_workers_ai_binding(&env, &upstream_model, &upstream_body).await
                    }
                } else {
                    let upstream_model = upstream_body
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or(&model);
                    match ai_gateway_runtime.as_ref() {
                        Some(runtime) => match plan_relay_ai_gateway_attempt(
                            runtime,
                            &endpoint,
                            &channel,
                            upstream_model,
                        )? {
                            Some(attempt) => {
                                match forward_ai_gateway_rest(&attempt, runtime, &upstream_body)
                                    .await
                                {
                                    Ok(response) => {
                                        let status = response.status_code();
                                        if should_ai_gateway_direct_fallback(status) {
                                            worker::console_warn!(
                                                "relay AI Gateway returned retryable status {}; falling back to direct provider for channel {}",
                                                status,
                                                channel.id
                                            );
                                            forward_relay_request(
                                                endpoint.provider,
                                                &upstream_url,
                                                &upstream_key,
                                                &channel,
                                                &upstream_body,
                                                &provider_headers,
                                            )
                                            .await
                                        } else {
                                            Ok(response)
                                        }
                                    }
                                    Err(err) => {
                                        worker::console_warn!(
                                            "relay AI Gateway fetch failed; falling back to direct provider for channel {}: {}",
                                            channel.id,
                                            err
                                        );
                                        forward_relay_request(
                                            endpoint.provider,
                                            &upstream_url,
                                            &upstream_key,
                                            &channel,
                                            &upstream_body,
                                            &provider_headers,
                                        )
                                        .await
                                    }
                                }
                            }
                            None => {
                                forward_relay_request(
                                    endpoint.provider,
                                    &upstream_url,
                                    &upstream_key,
                                    &channel,
                                    &upstream_body,
                                    &provider_headers,
                                )
                                .await
                            }
                        },
                        None => {
                            forward_relay_request(
                                endpoint.provider,
                                &upstream_url,
                                &upstream_key,
                                &channel,
                                &upstream_body,
                                &provider_headers,
                            )
                            .await
                        }
                    }
                }
            }
            RelayRequestBody::Raw {
                bytes,
                content_type,
            } => {
                // Multipart/raw bodies are forwarded verbatim. Model mapping
                // is intentionally NOT applied (see docs/relay-mvp.md). All
                // upload endpoints are OpenAI-compatible.
                forward_raw_openai_compatible(
                    &upstream_url,
                    &upstream_key,
                    &channel,
                    bytes,
                    content_type,
                )
                .await
            }
        };

        match forward_result {
            Ok(mut response) => {
                let status = response.status_code();
                if is_retryable_status(status) {
                    record_retryable_channel_failure(&env, &channel, status).await;
                    last_failure = Some(RelayAttemptFailure::retryable_status(
                        channel.id,
                        channel.name.clone(),
                        status,
                    ));
                    if attempt_index + 1 < attempt_count {
                        // About to retry and discard this response — inspect its
                        // error body for a disable keyword (Go ShouldDisableChannel
                        // keyword branch) before dropping it.
                        if keyword_ban_enabled {
                            maybe_keyword_disable_channel(&env, &channel, &mut response).await;
                        }
                        continue;
                    }
                    // Out of retries: pass the upstream response through to the
                    // client. The audit/settlement path below will treat it as
                    // a normal response; tiered reserve will be refunded via
                    // the no-usage path because there is no billable usage.
                    selected_attempt = Some((channel, selected_group, response));
                    break;
                }
                selected_attempt = Some((channel, selected_group, response));
                break;
            }
            Err(err) => {
                record_retryable_channel_failure(&env, &channel, 0).await;
                last_failure = Some(RelayAttemptFailure::fetch_error(
                    channel.id,
                    channel.name.clone(),
                    err.to_string(),
                ));
                continue;
            }
        }
    }

    let Some((channel, selected_group, upstream_response)) = selected_attempt else {
        // Every attempt failed with a fetch error or unconfigurable channel.
        // Refund the tiered reserve (if any) and return a structured error
        // describing the last failure.
        if let Some(preflight) = tiered_billing_preflight.as_ref() {
            if let Err(refund_err) =
                refund_tiered_billing_preflight(&db, &auth, preflight, unix_timestamp()).await
            {
                return openai_error_response(
                    format!(
                        "tiered billing reserve refund failed after all retry attempts: {refund_err}"
                    ),
                    500,
                );
            }
        }
        return match last_failure {
            Some(RelayAttemptFailure {
                kind: RelayAttemptFailureKind::FetchError,
                channel_id,
                channel_name,
                detail,
                ..
            }) => json_with_status(
                &ErrorBody::bad_request(format!(
                    "upstream request failed for channel {channel_id} ({channel_name}): {detail}"
                )),
                502,
            ),
            Some(RelayAttemptFailure {
                kind: RelayAttemptFailureKind::NoUsableKey,
                channel_id,
                channel_name,
                ..
            }) => json_with_status(
                &ErrorBody::bad_request(format!(
                    "channel {channel_id} ({channel_name}) has no usable upstream key"
                )),
                502,
            ),
            // Retryable-status exhaustion falls through here only when the loop
            // ran zero iterations (empty candidate list) — the
            // selected_attempt path above handles the "ran out of retries with
            // a real upstream response" case.
            _ => json_with_status(
                &ErrorBody::bad_request(format!(
                    "no enabled relay channel or ability for model {model} in group {group}"
                )),
                503,
            ),
        };
    };

    // Record affinity on a successful upstream response so subsequent requests
    // stick to this channel. Best-effort and fail-open; only when enabled.
    if let Some(key) = affinity_key.as_deref() {
        if upstream_response.status_code() < 400 {
            affinity::record_preferred_channel(
                &env,
                key,
                channel.id,
                affinity::AFFINITY_TTL_SECONDS,
            )
            .await;
        }
    }
    let affinity_audit = affinity_key.as_deref().map(|key| {
        affinity::affinity_audit_context(
            key,
            &model,
            &group,
            &selected_group,
            &endpoint.upstream_path,
            channel.id,
            affinity::AFFINITY_TTL_SECONDS,
        )
    });

    // Single pre-consume prompt estimate for the request, reused by the
    // missing-usage fallback. Prefer the tiered preflight's frozen value (the
    // exact amount pre-consumed); otherwise recompute from the JSON body.
    let estimated_prompt_tokens = tiered_billing_preflight
        .as_ref()
        .map(|preflight| preflight.snapshot.estimated_prompt_tokens as i64)
        .unwrap_or_else(|| {
            json_body
                .as_ref()
                .map(|body| {
                    estimate_prompt_tokens_from_request_for_model(
                        &model,
                        body,
                        endpoint.uses_openai_chat_format(),
                    )
                })
                .unwrap_or(0)
                .saturating_add(extra_prompt_tokens)
        });
    let audit = RelayAuditContext {
        started_at,
        client_ip,
        request_id,
        billing_request_input,
        tiered_billing_preflight,
        estimated_prompt_tokens,
        missing_usage_estimate_enabled: missing_usage_estimate_enabled(&env),
        usage_locally_estimated: false,
        affinity: affinity_audit,
    };

    if should_relay_stream {
        let context = context.expect("streaming context checked before reserve");
        return complete_streaming_relay_response(
            upstream_response,
            env.clone(),
            db,
            context,
            auth,
            channel,
            model,
            selected_group,
            endpoint.upstream_path.clone(),
            endpoint.provider,
            audit,
        )
        .await;
    }

    let max_json_response_bytes = json_response_config.max_bytes_for(&endpoint);
    complete_relay_response(
        upstream_response,
        env.clone(),
        db,
        context,
        auth,
        channel,
        model,
        selected_group,
        endpoint.upstream_path.clone(),
        endpoint.provider,
        endpoint.parse_non_stream_usage,
        max_json_response_bytes,
        audit,
    )
    .await
}

#[derive(Debug, Clone, Copy)]
struct RelayRetryConfig {
    retry_times: u32,
}

impl RelayRetryConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(optional_env_var(env, RELAY_RETRY_TIMES_ENV))
    }

    fn from_raw(retry_times: Option<String>) -> Result<Self, String> {
        let retry_times = cinatoken_relay::parse_retry_times_env(retry_times.as_deref())?;
        Ok(Self { retry_times })
    }

    fn max_attempts(&self) -> usize {
        (self.retry_times as usize).saturating_add(1)
    }
}

/// One planned relay attempt: the channel to try and the group it was selected
/// from (the group drives settlement billing — for `auto` tokens it is the
/// selected group, not the literal `"auto"` token group).
struct RelayAttemptPlan {
    group: String,
    channel: RelayChannel,
}

/// Build the ordered list of `(group, channel)` attempts up to `max_attempts`.
///
/// - **Single group** (`is_auto = false`): the prior inline behavior — pick a
///   priority tier by attempt index, weighted-random within it, and shrink the
///   pool so a channel is never retried.
/// - **Auto cross-group** (`is_auto = true`): drive
///   [`cinatoken_core::auto_group_retry_step`] across the user's pre-fetched
///   per-group pools, exhausting a group's priorities before advancing.
///
/// `rng(total)` must yield `[0, total)`; injected so the selection is
/// deterministically testable.
fn plan_relay_attempts(
    group_pools: Vec<(String, Vec<RelayChannel>)>,
    is_auto: bool,
    max_attempts: usize,
    retry_times: i32,
    cross_group_retry: bool,
    mut rng: impl FnMut(u64) -> worker::Result<u64>,
) -> worker::Result<Vec<RelayAttemptPlan>> {
    let meta_of = |pool: &[RelayChannel]| -> Vec<Candidate> {
        pool.iter()
            .map(|c| Candidate {
                priority: c.priority,
                weight: c.weight,
            })
            .collect()
    };

    if !is_auto {
        let (group, mut pool) = group_pools.into_iter().next().unwrap_or_default();
        let mut order = Vec::new();
        for attempt_index in 0..max_attempts {
            if pool.is_empty() {
                break;
            }
            let meta = meta_of(&pool);
            let Some(pick) = select_weighted_checked(&meta, attempt_index, &mut rng)? else {
                break;
            };
            order.push(RelayAttemptPlan {
                group: group.clone(),
                channel: pool.remove(pick),
            });
        }
        return Ok(order);
    }

    let groups: Vec<String> = group_pools.iter().map(|(g, _)| g.clone()).collect();
    let mut pools: Vec<Vec<RelayChannel>> = group_pools.into_iter().map(|(_, p)| p).collect();
    let mut order = Vec::new();
    let mut group_index = 0usize;
    let mut retry = 0i32;
    // Mirror Go's outer loop `for retry <= RetryTimes`: a group advance resets
    // `retry` to 0 (via auto_group_retry_step), so each group gets its own
    // RetryTimes+1 budget rather than a single global cap (`max_attempts` only
    // bounds the single-group branch). Termination: each step either increments
    // `retry` toward the bound or advances the group until none remain (`None`).
    while retry <= retry_times {
        let mut random_error = None;
        let outcome = auto_group_retry_step(
            pools.len(),
            group_index,
            retry,
            cross_group_retry,
            retry_times,
            |gi, priority_retry| {
                if pools[gi].is_empty() {
                    return None;
                }
                let meta = meta_of(&pools[gi]);
                match select_weighted_checked(&meta, priority_retry.max(0) as usize, &mut rng) {
                    Ok(selected) => selected,
                    Err(err) => {
                        random_error = Some(err);
                        None
                    }
                }
            },
        );
        if let Some(err) = random_error {
            return Err(err);
        }
        let Some(outcome) = outcome else { break };
        let channel = pools[outcome.group_index].remove(outcome.selected);
        order.push(RelayAttemptPlan {
            group: groups[outcome.group_index].clone(),
            channel,
        });
        group_index = outcome.next_group_index;
        retry = outcome.next_retry;
        if !outcome.reset_retry_next_try {
            retry += 1;
        }
    }
    Ok(order)
}

fn select_weighted_checked(
    candidates: &[Candidate],
    retry: usize,
    rng: &mut impl FnMut(u64) -> worker::Result<u64>,
) -> worker::Result<Option<usize>> {
    let mut random_error = None;
    let selected = select_weighted(candidates, retry, |total| match rng(total) {
        Ok(value) => value,
        Err(err) => {
            random_error = Some(err);
            0
        }
    });
    if let Some(err) = random_error {
        return Err(err);
    }
    Ok(selected)
}

fn random_u64_below(total: u64) -> worker::Result<u64> {
    if total == 0 {
        return Ok(0);
    }
    let zone = ((u128::from(u64::MAX) + 1) / u128::from(total)) * u128::from(total);
    let mut bytes = [0u8; 8];
    loop {
        getrandom::getrandom(&mut bytes).map_err(|err| {
            worker::Error::RustError(format!("relay random selection failed: {err}"))
        })?;
        let value = u64::from_le_bytes(bytes);
        if u128::from(value) < zone {
            return Ok(value % total);
        }
    }
}

#[derive(Debug, Clone)]
struct RelayAttemptFailure {
    kind: RelayAttemptFailureKind,
    channel_id: i64,
    channel_name: String,
    #[allow(dead_code)]
    detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayAttemptFailureKind {
    FetchError,
    NoUsableKey,
    RetryableStatus,
}

impl RelayAttemptFailure {
    fn fetch_error(channel_id: i64, channel_name: String, detail: String) -> Self {
        Self {
            kind: RelayAttemptFailureKind::FetchError,
            channel_id,
            channel_name,
            detail,
        }
    }

    fn no_key(channel_id: i64, channel_name: String) -> Self {
        Self {
            kind: RelayAttemptFailureKind::NoUsableKey,
            channel_id,
            channel_name,
            detail: String::new(),
        }
    }

    #[allow(dead_code)]
    fn retryable_status(channel_id: i64, channel_name: String, status: u16) -> Self {
        Self {
            kind: RelayAttemptFailureKind::RetryableStatus,
            channel_id,
            channel_name,
            detail: format!("upstream status {status}"),
        }
    }
}

/// Record a retryable channel failure in Upstash Redis (best-effort) and
/// trigger an automatic D1 disable when the error count exceeds the configured
/// threshold. Mirrors the Go `service.DisableChannel` short-circuit. Failures
/// here are logged but never block the in-flight request.
fn channel_keyword_ban_enabled(env: &Env) -> bool {
    matches!(
        optional_env_var(env, CHANNEL_KEYWORD_BAN_ENV).as_deref(),
        Some("true") | Some("1")
    )
}

/// Keyword branch of Go `ShouldDisableChannel`: inspect a failed channel's error
/// body for a default auto-disable keyword and ban the channel off-path when
/// matched. Only called on a response that is about to be discarded on retry, so
/// consuming the body is safe. Best-effort: any read/D1 error is swallowed.
async fn maybe_keyword_disable_channel(env: &Env, channel: &RelayChannel, response: &mut Response) {
    let Ok(body) = read_response_text_limited(response, CHANNEL_KEYWORD_BAN_MAX_BYTES).await else {
        return;
    };
    if !cinatoken_core::error_body_triggers_auto_disable(&body) {
        return;
    }
    let Ok(db) = env.d1("DB") else {
        return;
    };
    let _ = crate::d1_repositories::disable_channel_best_effort(
        &db,
        channel.id,
        "relay auto-disable: upstream error body matched disable keyword",
    )
    .await;
    let _ = crate::cache_invalidation::invalidate_channel_cache(env).await;
}

async fn record_retryable_channel_failure(env: &Env, channel: &RelayChannel, status: u16) {
    // Auto-disable on bad-credential signals (default: 401) regardless of the
    // Redis counter, matching the Go `AutomaticDisableStatusCodeRanges` default.
    if is_auto_disable_status(status) {
        let db = match env.d1("DB") {
            Ok(db) => db,
            Err(err) => {
                worker::console_warn!(
                    "failed to acquire D1 binding for auto-disable of channel {}: {}",
                    channel.id,
                    err
                );
                return;
            }
        };
        let _ = crate::d1_repositories::disable_channel_best_effort(
            &db,
            channel.id,
            "relay auto-disable: upstream returned 401",
        )
        .await;
        // Evict the channel selection cache so the just-banned channel is not
        // still served (without failover) from cache for the rest of its TTL.
        let _ = crate::cache_invalidation::invalidate_channel_cache(env).await;
        return;
    }

    let Ok(Some(redis)) = crate::cache::upstash_redis_from_env(env) else {
        return;
    };
    let threshold = channel_auto_ban_threshold(env);
    if threshold == 0 {
        return;
    }
    let limiter = ExpiringCounterRateLimiter::new(redis, "relay:chanerr");
    let key = format!("channel:{}", channel.id);
    // Reuse the rate-limit counter store: INCRBY 1 + EXPIRE on the configured
    // window. We treat "allowed" as "below threshold" by asking the limiter to
    // permit threshold+1 requests; when it denies, the threshold has been hit.
    let Ok(under_threshold) = limiter
        .check(&key, threshold, CHANNEL_AUTO_BAN_WINDOW_SECONDS)
        .await
    else {
        // Counter error: fail open, do not disable.
        return;
    };
    if under_threshold {
        return;
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_warn!(
                "failed to acquire D1 binding for auto-disable of channel {}: {}",
                channel.id,
                err
            );
            return;
        }
    };
    let _ = crate::d1_repositories::disable_channel_best_effort(
        &db,
        channel.id,
        "relay auto-disable: consecutive upstream errors exceeded threshold",
    )
    .await;
    // Evict the channel selection cache (see the 401 path above) so the banned
    // channel stops being served from cache before its TTL expires.
    let _ = crate::cache_invalidation::invalidate_channel_cache(env).await;
}

fn channel_auto_ban_threshold(env: &Env) -> u32 {
    const DEFAULT_THRESHOLD: u32 = 5;
    let Some(raw) = optional_env_var(env, CHANNEL_AUTOBAN_THRESHOLD_ENV) else {
        return DEFAULT_THRESHOLD;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return DEFAULT_THRESHOLD;
    }
    raw.parse::<u32>().unwrap_or(DEFAULT_THRESHOLD)
}

const CHANNEL_AUTO_BAN_WINDOW_SECONDS: u32 = 60;

/// The parsed relay request body. JSON endpoints carry a `serde_json::Value`
/// (the historical shape); multipart/raw endpoints carry the original bytes
/// plus the Content-Type so the forwarder can replay them to the upstream
/// verbatim.
enum RelayRequestBody {
    Json(Value),
    Raw {
        bytes: Vec<u8>,
        content_type: String,
    },
}

impl RelayRequestBody {
    /// Return the `model` field value, whether the body is JSON or multipart.
    /// For multipart bodies, the model is extracted from the `model` form
    /// field via boundary split.
    fn model(&self) -> Option<String> {
        match self {
            RelayRequestBody::Json(value) => value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            RelayRequestBody::Raw {
                bytes,
                content_type,
            } => cinatoken_relay::extract_multipart_field(bytes, content_type, "model"),
        }
    }
}

struct PreparedRelayRequest {
    body: RelayRequestBody,
    billing_request_input: RequestInput,
    extra_prompt_tokens: i64,
}

async fn prepare_relay_request(
    req: &mut Request,
    endpoint: &RelayEndpoint,
    json_body_config: RelayJsonBodyConfig,
    json_model_fallback: Option<&str>,
) -> worker::Result<Result<PreparedRelayRequest, Response>> {
    match endpoint.request_body_mode {
        RelayRequestBodyMode::Json => {
            prepare_json_relay_request(
                req,
                endpoint,
                json_body_config.max_bytes,
                json_model_fallback,
            )
            .await
        }
        RelayRequestBodyMode::MultipartForm => prepare_multipart_relay_request(req, endpoint).await,
        mode => {
            let response = json_with_status(
                &ErrorBody::not_implemented(
                    mode.pending_feature()
                        .expect("non-JSON body modes must declare pending feature"),
                ),
                501,
            )?;
            Ok(Err(response))
        }
    }
}

async fn prepare_json_relay_request(
    req: &mut Request,
    endpoint: &RelayEndpoint,
    max_bytes: usize,
    json_model_fallback: Option<&str>,
) -> worker::Result<Result<PreparedRelayRequest, Response>> {
    debug_assert!(endpoint.expects_json_request_body());

    let request_body = match read_relay_json_body(
        req,
        endpoint.display_name,
        endpoint.request_body_mode,
        max_bytes,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => {
            let response = json_with_status(
                &ErrorBody::bad_request(err.message(endpoint.display_name)),
                err.status_code(),
            )?;
            return Ok(Err(response));
        }
    };
    let mut request_body = request_body;
    if let Some(model) = json_model_fallback {
        apply_json_model_fallback(&mut request_body, model);
    }
    if let Some(validate) = endpoint.request_validator {
        if let Some(message) = validate(&request_body) {
            let response = json_with_status(&ErrorBody::bad_request(message), 400)?;
            return Ok(Err(response));
        }
    }

    Ok(Ok(PreparedRelayRequest {
        billing_request_input: billing_request_input(req, &request_body),
        body: RelayRequestBody::Json(request_body),
        extra_prompt_tokens: 0,
    }))
}

fn apply_json_model_fallback(body: &mut Value, model: &str) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let needs_fallback = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty();
    if needs_fallback {
        object.insert("model".to_string(), Value::String(model.to_string()));
    }
}

/// Multipart body size limit. Audio files (mp3/wav) and images can be
/// sizable; 25 MiB matches the Go gateway's effective limit.
const MULTIPART_BODY_LIMIT_BYTES: usize = 25 * 1024 * 1024;

async fn prepare_multipart_relay_request(
    req: &mut Request,
    endpoint: &RelayEndpoint,
) -> worker::Result<Result<PreparedRelayRequest, Response>> {
    if let Err(err) =
        validate_request_content_type(req, endpoint.request_body_mode.content_type_policy())
    {
        let response = json_with_status(
            &ErrorBody::bad_request(err.message(
                endpoint.display_name,
                endpoint.request_body_mode.body_kind(),
            )),
            err.status_code(),
        )?;
        return Ok(Err(response));
    }
    let content_type = match request_content_type(req) {
        Ok(Some(content_type)) => content_type,
        Ok(None) => {
            let response = json_with_status(
                &ErrorBody::bad_request(format!(
                    "{} expects multipart/form-data",
                    endpoint.display_name
                )),
                415,
            )?;
            return Ok(Err(response));
        }
        Err(err) => {
            let response = json_with_status(
                &ErrorBody::bad_request(err.message(
                    endpoint.display_name,
                    endpoint.request_body_mode.body_kind(),
                )),
                err.status_code(),
            )?;
            return Ok(Err(response));
        }
    };

    let bytes = match read_bounded_relay_request_bytes(req, MULTIPART_BODY_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(err) => {
            let response = json_with_status(
                &ErrorBody::bad_request(err.message(
                    endpoint.display_name,
                    endpoint.request_body_mode.body_kind(),
                )),
                err.status_code(),
            )?;
            return Ok(Err(response));
        }
    };

    // Synthesize a minimal JSON body for the billing request input. The
    // tiered billing preflight reads prompt-token estimates from this; for
    // multipart we pass the model through so the channel/billing lookups
    // work, but text-prompt estimation will be empty (acceptable: STT
    // billing is per-duration, not per-text-token).
    let synthetic_body = match endpoint_multipart_model(&bytes, &content_type) {
        Some(model) => json!({ "model": model }),
        None => Value::Object(serde_json::Map::new()),
    };
    let extra_prompt_tokens = multipart_extra_prompt_tokens(endpoint, &bytes, &content_type);

    Ok(Ok(PreparedRelayRequest {
        billing_request_input: billing_request_input(req, &synthetic_body),
        body: RelayRequestBody::Raw {
            bytes,
            content_type,
        },
        extra_prompt_tokens,
    }))
}

fn endpoint_multipart_model(bytes: &[u8], content_type: &str) -> Option<String> {
    cinatoken_relay::extract_multipart_field(bytes, content_type, "model")
}

fn multipart_extra_prompt_tokens(
    endpoint: &RelayEndpoint,
    bytes: &[u8],
    content_type: &str,
) -> i64 {
    if !matches!(
        endpoint.upstream_path.as_str(),
        "audio/transcriptions" | "audio/translations"
    ) {
        return 0;
    }

    cinatoken_relay::extract_multipart_file(bytes, content_type, "file")
        .and_then(|file| {
            audio_duration_seconds(
                file.bytes,
                Some(file.filename.as_str()),
                file.content_type.as_deref(),
            )
        })
        .map(audio_transcription_tokens)
        .unwrap_or_default()
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

pub(crate) async fn enforce_relay_rate_limits(
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
        let key = relay_token_rate_limit_key(auth);
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

fn relay_token_rate_limit_key(auth: &AuthenticatedToken) -> String {
    if auth.token_id > 0 {
        format!("token:{}", auth.token_id)
    } else {
        format!("playground-user:{}", auth.user_id)
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayJsonBodyConfig {
    max_bytes: usize,
}

impl RelayJsonBodyConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(optional_env_var(env, RELAY_JSON_BODY_LIMIT_ENV))
    }

    fn from_raw(max_bytes: Option<String>) -> Result<Self, String> {
        let max_bytes = parse_positive_usize_env(
            RELAY_JSON_BODY_LIMIT_ENV,
            max_bytes,
            DEFAULT_RELAY_JSON_BODY_LIMIT_BYTES,
        )?;
        Ok(Self { max_bytes })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayJsonResponseConfig {
    max_bytes_override: Option<usize>,
}

impl RelayJsonResponseConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(optional_env_var(env, RELAY_JSON_RESPONSE_LIMIT_ENV))
    }

    fn from_raw(max_bytes: Option<String>) -> Result<Self, String> {
        let max_bytes_override = match max_bytes.as_deref().map(str::trim) {
            Some("") | None => None,
            Some(raw) => Some(parse_positive_usize_env(
                RELAY_JSON_RESPONSE_LIMIT_ENV,
                Some(raw.to_string()),
                0,
            )?),
        };
        Ok(Self { max_bytes_override })
    }

    fn max_bytes_for(&self, endpoint: &RelayEndpoint) -> usize {
        self.max_bytes_override
            .unwrap_or_else(|| endpoint.default_json_response_limit_bytes())
    }
}

fn optional_env_var(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn optional_secret_or_env_var(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .ok()
        .map(|value| value.to_string())
        .or_else(|| optional_env_var(env, name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_flag(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[derive(Clone)]
struct RelayAiGatewayRuntime {
    account_id: String,
    gateway_id: String,
    api_token: String,
}

impl RelayAiGatewayRuntime {
    fn from_env(env: &Env) -> Option<Self> {
        Self::from_values(
            env_flag(optional_env_var(env, RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV).as_deref()),
            optional_env_var(env, CLOUDFLARE_ACCOUNT_ID_ENV),
            optional_env_var(env, AI_GATEWAY_ID_ENV),
            optional_secret_or_env_var(env, CLOUDFLARE_AI_GATEWAY_TOKEN_ENV)
                .or_else(|| optional_secret_or_env_var(env, CLOUDFLARE_API_TOKEN_ENV)),
        )
    }

    fn from_values(
        router_enabled: bool,
        account_id: Option<String>,
        gateway_id: Option<String>,
        api_token: Option<String>,
    ) -> Option<Self> {
        if !router_enabled {
            return None;
        }
        Some(Self {
            account_id: account_id?.trim().to_string(),
            gateway_id: gateway_id?.trim().to_string(),
            api_token: api_token?.trim().to_string(),
        })
        .filter(|runtime| {
            !runtime.account_id.is_empty()
                && !runtime.gateway_id.is_empty()
                && !runtime.api_token.is_empty()
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayAiGatewayAttempt {
    url: String,
    plan: AiGatewayCutoverPlan,
}

fn plan_relay_ai_gateway_attempt(
    runtime: &RelayAiGatewayRuntime,
    endpoint: &RelayEndpoint,
    channel: &RelayChannel,
    upstream_model: &str,
) -> worker::Result<Option<RelayAiGatewayAttempt>> {
    let decision = plan_ai_gateway_cutover(AiGatewayCutoverInput {
        router_ready: true,
        channel_opted_in: channel.ai_gateway_opted_in(),
        provider: endpoint.registry_provider_kind(),
        relay_path: &endpoint.upstream_path,
        model: upstream_model,
        channel_has_custom_base_url: channel
            .base_url
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty()),
        is_user_credential: false,
    });
    let AiGatewayCutoverDecision::UseGateway(plan) = decision else {
        return Ok(None);
    };
    let url =
        rest_gateway_endpoint_url(&runtime.account_id, plan.endpoint, None).map_err(|err| {
            worker::Error::RustError(format!("failed to build AI Gateway REST URL: {err}"))
        })?;
    Ok(Some(RelayAiGatewayAttempt { url, plan }))
}

fn should_ai_gateway_direct_fallback(status: u16) -> bool {
    is_retryable_status(status)
}

fn parse_positive_usize_env(
    name: &str,
    value: Option<String>,
    default_value: usize,
) -> Result<usize, String> {
    let parsed = match value.as_deref().map(str::trim) {
        Some("") | None => default_value,
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| format!("{name} must be a positive integer"))?,
    };
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
    }
    Ok(parsed)
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

#[derive(Debug, PartialEq, Eq)]
enum RelayBodyReadError {
    InvalidContentLength(String),
    TooLarge {
        actual_bytes: Option<usize>,
        max_bytes: usize,
    },
    Read(String),
}

impl RelayBodyReadError {
    fn status_code(&self) -> u16 {
        match self {
            Self::TooLarge { .. } => 413,
            Self::InvalidContentLength(_) | Self::Read(_) => 400,
        }
    }

    fn message(&self, endpoint: &str, body_kind: &str) -> String {
        match self {
            Self::InvalidContentLength(err) => {
                format!("invalid {endpoint} request content-length: {err}")
            }
            Self::TooLarge {
                actual_bytes,
                max_bytes,
            } => match actual_bytes {
                Some(actual_bytes) => format!(
                    "{endpoint} {body_kind} request body is too large: {actual_bytes} bytes exceeds {max_bytes} byte limit"
                ),
                None => format!(
                    "{endpoint} {body_kind} request body is too large: exceeds {max_bytes} byte limit"
                ),
            },
            Self::Read(err) => format!("failed to read {endpoint} request body: {err}"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RelayJsonBodyError {
    ContentType(RelayContentTypeError),
    Read(RelayBodyReadError),
    Parse(String),
}

impl From<RelayBodyReadError> for RelayJsonBodyError {
    fn from(err: RelayBodyReadError) -> Self {
        Self::Read(err)
    }
}

impl RelayJsonBodyError {
    fn status_code(&self) -> u16 {
        match self {
            Self::ContentType(err) => err.status_code(),
            Self::Read(err) => err.status_code(),
            Self::Parse(_) => 400,
        }
    }

    fn message(&self, endpoint: &str) -> String {
        match self {
            Self::ContentType(err) => err.message(endpoint, "JSON"),
            Self::Read(err) => err.message(endpoint, "JSON"),
            Self::Parse(err) => format!("invalid {endpoint} request body: {err}"),
        }
    }
}

async fn read_relay_json_body(
    req: &mut Request,
    _endpoint: &str,
    body_mode: RelayRequestBodyMode,
    max_bytes: usize,
) -> Result<Value, RelayJsonBodyError> {
    debug_assert!(body_mode == RelayRequestBodyMode::Json);
    validate_request_content_type(req, body_mode.content_type_policy())
        .map_err(RelayJsonBodyError::ContentType)?;
    let bytes = read_bounded_relay_request_bytes(req, max_bytes).await?;

    parse_relay_json_bytes(&bytes, max_bytes)
}

#[derive(Debug, PartialEq, Eq)]
enum RelayContentTypeError {
    Header(String),
    Unsupported {
        actual: String,
        expected: &'static str,
    },
}

impl RelayContentTypeError {
    fn status_code(&self) -> u16 {
        match self {
            Self::Header(_) => 400,
            Self::Unsupported { .. } => 415,
        }
    }

    fn message(&self, endpoint: &str, body_kind: &str) -> String {
        match self {
            Self::Header(err) => {
                format!("invalid {endpoint} request content-type header: {err}")
            }
            Self::Unsupported { actual, expected } => format!(
                "unsupported {endpoint} {body_kind} request body content-type: {actual}; expected {expected}"
            ),
        }
    }
}

fn request_content_type(req: &Request) -> Result<Option<String>, RelayContentTypeError> {
    let Some(raw) = req
        .headers()
        .get("content-type")
        .map_err(|err| RelayContentTypeError::Header(err.to_string()))?
    else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    Ok(Some(raw.to_string()))
}

#[derive(Clone, Copy)]
struct RelayContentTypePolicy {
    expected: &'static str,
    allow_absent: bool,
    accepts: fn(&str) -> bool,
}

impl RelayContentTypePolicy {
    fn json() -> Self {
        Self {
            expected: "application/json or application/*+json",
            allow_absent: true,
            accepts: is_json_content_type,
        }
    }

    fn multipart() -> Self {
        Self {
            expected: "multipart/form-data",
            allow_absent: false,
            accepts: is_multipart_content_type,
        }
    }

    fn any() -> Self {
        Self {
            expected: "any content-type",
            allow_absent: true,
            accepts: |_| true,
        }
    }

    fn allows(&self, content_type: Option<&str>) -> bool {
        match content_type {
            Some(content_type) => (self.accepts)(content_type),
            None => self.allow_absent,
        }
    }
}

fn validate_request_content_type(
    req: &Request,
    policy: RelayContentTypePolicy,
) -> Result<(), RelayContentTypeError> {
    let content_type = request_content_type(req)?;
    validate_content_type_value(content_type.as_deref(), policy)
}

fn validate_content_type_value(
    content_type: Option<&str>,
    policy: RelayContentTypePolicy,
) -> Result<(), RelayContentTypeError> {
    if policy.allows(content_type) {
        return Ok(());
    }
    Err(RelayContentTypeError::Unsupported {
        actual: content_type
            .map(str::to_string)
            .unwrap_or_else(|| "<absent>".to_string()),
        expected: policy.expected,
    })
}

fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn is_json_content_type(content_type: &str) -> bool {
    let media_type = media_type(content_type);
    media_type == "application/json"
        || (media_type.starts_with("application/") && media_type.ends_with("+json"))
}

fn is_multipart_content_type(content_type: &str) -> bool {
    media_type(content_type) == "multipart/form-data"
}

async fn read_bounded_relay_request_bytes(
    req: &mut Request,
    max_bytes: usize,
) -> Result<Vec<u8>, RelayBodyReadError> {
    let content_length = request_content_length(req)?;
    if let Some(content_length) = content_length {
        if content_length > max_bytes {
            return Err(RelayBodyReadError::TooLarge {
                actual_bytes: Some(content_length),
                max_bytes,
            });
        }
    }

    let mut stream = req
        .stream()
        .map_err(|err| RelayBodyReadError::Read(err.to_string()))?;
    let mut bytes = Vec::with_capacity(
        content_length
            .map(|content_length| content_length.min(max_bytes))
            .unwrap_or_default(),
    );
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| RelayBodyReadError::Read(err.to_string()))?;
        let next_len =
            bytes
                .len()
                .checked_add(chunk.len())
                .ok_or(RelayBodyReadError::TooLarge {
                    actual_bytes: None,
                    max_bytes,
                })?;
        if next_len > max_bytes {
            return Err(RelayBodyReadError::TooLarge {
                actual_bytes: Some(next_len),
                max_bytes,
            });
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

fn request_content_length(req: &Request) -> Result<Option<usize>, RelayBodyReadError> {
    let Some(raw) = req
        .headers()
        .get("content-length")
        .map_err(|err| RelayBodyReadError::InvalidContentLength(err.to_string()))?
    else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    parse_content_length_value(raw).map_err(RelayBodyReadError::InvalidContentLength)
}

fn parse_relay_json_bytes(bytes: &[u8], max_bytes: usize) -> Result<Value, RelayJsonBodyError> {
    if bytes.len() > max_bytes {
        return Err(RelayBodyReadError::TooLarge {
            actual_bytes: Some(bytes.len()),
            max_bytes,
        }
        .into());
    }
    serde_json::from_slice::<Value>(bytes).map_err(|err| RelayJsonBodyError::Parse(err.to_string()))
}

#[derive(Debug, PartialEq, Eq)]
enum RelayBufferedTextError {
    InvalidContentLength(String),
    TooLarge {
        actual_bytes: Option<usize>,
        max_bytes: usize,
        body_consumed: bool,
    },
    Read(String),
    Decode(String),
}

impl RelayBufferedTextError {
    fn body_consumed(&self) -> bool {
        match self {
            Self::InvalidContentLength(_) => false,
            Self::TooLarge { body_consumed, .. } => *body_consumed,
            Self::Read(_) | Self::Decode(_) => true,
        }
    }

    fn message(&self, label: &str) -> String {
        match self {
            Self::InvalidContentLength(err) => {
                format!("invalid {label} content-length: {err}")
            }
            Self::TooLarge {
                actual_bytes,
                max_bytes,
                ..
            } => match actual_bytes {
                Some(actual_bytes) => format!(
                    "{label} is too large: {actual_bytes} bytes exceeds {max_bytes} byte limit"
                ),
                None => format!("{label} is too large: exceeds {max_bytes} byte limit"),
            },
            Self::Read(err) => format!("failed to read {label}: {err}"),
            Self::Decode(err) => format!("failed to decode {label} as UTF-8: {err}"),
        }
    }
}

async fn read_response_text_limited(
    response: &mut Response,
    max_bytes: usize,
) -> Result<String, RelayBufferedTextError> {
    if let Some(content_length) = response_content_length(response)? {
        if content_length > max_bytes {
            return Err(RelayBufferedTextError::TooLarge {
                actual_bytes: Some(content_length),
                max_bytes,
                body_consumed: false,
            });
        }
    }

    match response.body() {
        ResponseBody::Empty => Ok(String::new()),
        ResponseBody::Body(bytes) => decode_limited_text_bytes(bytes, max_bytes, false),
        ResponseBody::Stream(_) => read_response_stream_text_limited(response, max_bytes).await,
    }
}

async fn read_response_stream_text_limited(
    response: &mut Response,
    max_bytes: usize,
) -> Result<String, RelayBufferedTextError> {
    let mut stream = response
        .stream()
        .map_err(|err| RelayBufferedTextError::Read(err.to_string()))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| RelayBufferedTextError::Read(err.to_string()))?;
        let next_len =
            bytes
                .len()
                .checked_add(chunk.len())
                .ok_or(RelayBufferedTextError::TooLarge {
                    actual_bytes: None,
                    max_bytes,
                    body_consumed: true,
                })?;
        if next_len > max_bytes {
            return Err(RelayBufferedTextError::TooLarge {
                actual_bytes: Some(next_len),
                max_bytes,
                body_consumed: true,
            });
        }
        bytes.extend_from_slice(&chunk);
    }

    decode_limited_text_bytes(&bytes, max_bytes, true)
}

fn decode_limited_text_bytes(
    bytes: &[u8],
    max_bytes: usize,
    body_consumed: bool,
) -> Result<String, RelayBufferedTextError> {
    if bytes.len() > max_bytes {
        return Err(RelayBufferedTextError::TooLarge {
            actual_bytes: Some(bytes.len()),
            max_bytes,
            body_consumed,
        });
    }
    String::from_utf8(bytes.to_vec()).map_err(|err| RelayBufferedTextError::Decode(err.to_string()))
}

fn response_content_length(response: &Response) -> Result<Option<usize>, RelayBufferedTextError> {
    let Some(raw) = response
        .headers()
        .get("content-length")
        .map_err(|err| RelayBufferedTextError::InvalidContentLength(err.to_string()))?
    else {
        return Ok(None);
    };
    parse_content_length_value(&raw).map_err(RelayBufferedTextError::InvalidContentLength)
}

fn parse_content_length_value(raw: &str) -> Result<Option<usize>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    raw.parse::<usize>()
        .map(Some)
        .map_err(|_| "must be a non-negative integer".to_string())
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

pub(crate) fn extract_api_key(req: &Request) -> Option<String> {
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

async fn authenticate_playground_session(
    req: &Request,
    env: &Env,
    db: &D1Database,
    body: Option<&Value>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let claims = match crate::admin::parse_session_claims(req, env).await {
        Ok(Ok(Some(claims))) => claims,
        Ok(Ok(None)) => return Err(openai_error_response("not logged in", 401)),
        Ok(Err(_response)) => {
            return Err(openai_error_response("failed to parse session", 500));
        }
        Err(err) => return Err(worker_error_response(err)),
    };
    let Some(user) = crate::d1_repositories::find_user_by_id(db, claims.id)
        .await
        .map_err(worker_error_response)?
    else {
        return Err(openai_error_response("invalid session user", 401));
    };
    if user.status != 1 {
        return Err(openai_error_response("user is disabled", 403));
    }
    if user.quota <= 0 {
        return Err(openai_error_response("user quota is exhausted", 403));
    }

    let group = playground_effective_group(body, &user.group);
    if group != user.group
        && !crate::d1_repositories::user_can_use_group(db, &user.group, &group)
            .await
            .map_err(worker_error_response)?
    {
        return Err(openai_error_response("group access denied", 403));
    }

    Ok(AuthenticatedToken {
        token_id: 0,
        user_id: user.id,
        token_name: format!("playground-{group}"),
        token_status: 1,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: 1,
        model_limits_enabled: 0,
        model_limits: String::new(),
        allow_ips: String::new(),
        token_group: group,
        username: user.username,
        user_status: user.status,
        user_quota: user.quota,
        user_group: user.group,
    })
}

fn playground_effective_group(body: Option<&Value>, user_group: &str) -> String {
    body.and_then(|value| value.get("group"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|group| !group.is_empty())
        .unwrap_or(user_group)
        .to_string()
}

fn strip_playground_request_fields(body: &mut Value) {
    if let Some(object) = body.as_object_mut() {
        object.remove("group");
    }
}

pub(crate) async fn authenticate(
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

async fn authenticate_for_model_list(
    db: &D1Database,
    env: &Env,
    api_key: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let Some((redis, ttl_seconds)) = relay_read_cache(env)? else {
        return authenticate_model_list_from_d1(db, api_key, client_ip).await;
    };
    let cache_key =
        RelayCacheKeys::default().token_auth(api_key, MODEL_LIST_CACHE_MODEL_KEY, client_ip);

    match read_cached_authenticated_token(&redis, &cache_key).await {
        Ok(Some(mut row)) => {
            let still_exists =
                crate::d1_repositories::refresh_authenticated_token_quota_state(db, &mut row)
                    .await
                    .map_err(worker_error_response)?;
            if !still_exists {
                return Err(openai_error_response("invalid API key", 401));
            }
            return validate_authenticated_token_for_model_list(db, row, client_ip).await;
        }
        Ok(None) => {}
        Err(err) => worker::console_warn!("failed to read relay auth cache: {}", err),
    }

    let row = authenticate_model_list_from_d1(db, api_key, client_ip).await?;
    if let Err(err) = write_cached_authenticated_token(&redis, &cache_key, &row, ttl_seconds).await
    {
        worker::console_warn!("failed to write relay auth cache: {}", err);
    }
    Ok(row)
}

async fn authenticate_model_list_from_d1(
    db: &D1Database,
    api_key: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let row = crate::d1_repositories::authenticate_token(db, api_key)
        .await
        .map_err(worker_error_response)?
        .ok_or_else(|| openai_error_response("invalid API key", 401))?;

    validate_authenticated_token_for_model_list(db, row, client_ip).await
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

/// Whether `model` is permitted by a token's model-limit setting, mirroring Go
/// `middleware/distributor.go:60-76` exactly:
/// - limits disabled → allow (true);
/// - otherwise normalize the requested model via `format_matching_modelName`
///   (so a token limited to `gemini-2.5-flash-thinking-*` admits a request for
///   `gemini-2.5-flash-thinking-8192`), and allow iff it is in the limits CSV;
/// - an enabled-but-empty limit list denies everything (Go: empty map → 403),
///   which `csv_contains("") == false` reproduces.
///
/// Pure so the gate logic is unit-testable without a D1.
fn model_allowed_for_token(model_limits_enabled: i32, model_limits: &str, model: &str) -> bool {
    if model_limits_enabled == 0 {
        return true;
    }
    let normalized = format_matching_model_name(model);
    csv_contains(model_limits, &normalized)
}

async fn validate_authenticated_token(
    db: &D1Database,
    row: AuthenticatedToken,
    model: &str,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let row = validate_authenticated_token_base(db, row).await?;
    if !model_allowed_for_token(row.model_limits_enabled, &row.model_limits, model) {
        return Err(openai_error_response(
            format!("model {model} is not allowed for this token"),
            403,
        ));
    }
    validate_authenticated_token_ip(row, client_ip)
}

async fn validate_authenticated_token_for_model_list(
    db: &D1Database,
    row: AuthenticatedToken,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
    let row = validate_authenticated_token_base(db, row).await?;
    validate_authenticated_token_ip(row, client_ip)
}

async fn validate_authenticated_token_base(
    db: &D1Database,
    row: AuthenticatedToken,
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
    Ok(row)
}

fn validate_authenticated_token_ip(
    row: AuthenticatedToken,
    client_ip: Option<&str>,
) -> Result<AuthenticatedToken, worker::Result<Response>> {
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

/// Return the full ordered candidate list for a relay attempt. The Upstash
/// read-through cache only stores the highest-priority candidate (to keep the
/// cache payload small and avoid stale-rotation issues); on cache miss the full
/// list is read from D1, the first entry is cached, and the full list is
/// returned so the retry loop can walk it without re-querying D1.
async fn select_channels(
    db: &D1Database,
    env: &Env,
    model: &str,
    group: &str,
    cache_family: &str,
    supported_channel_types: &[i32],
) -> Result<Vec<RelayChannel>, worker::Result<Response>> {
    let Some((redis, ttl_seconds)) = relay_read_cache(env)? else {
        return select_channels_from_d1(db, model, group, supported_channel_types).await;
    };
    let cache_key = RelayCacheKeys::default().channel(cache_family, group, model);

    if let Ok(Some(cached)) = read_cached_relay_channel(&redis, &cache_key).await {
        // Cache hit: return just the cached channel. We deliberately do not
        // fall through to D1 for the rest of the rotation here; if that
        // channel fails, the loop will still retry, but only with this single
        // candidate. This mirrors the historical single-select behavior under
        // cache and keeps the hot path at one D1 read.
        return Ok(vec![cached]);
    }

    let candidates = select_channels_from_d1(db, model, group, supported_channel_types).await?;
    if let Some(first) = candidates.first() {
        if let Err(err) = write_cached_relay_channel(&redis, &cache_key, first, ttl_seconds).await {
            worker::console_warn!("failed to write relay channel cache: {}", err);
        }
    }
    Ok(candidates)
}

async fn select_channels_from_d1(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> Result<Vec<RelayChannel>, worker::Result<Response>> {
    crate::d1_repositories::select_relay_channels(db, model, group, supported_channel_types)
        .await
        .map_err(worker_error_response)
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

/// Execute a Cloudflare Workers AI channel natively over the `AI` binding —
/// no egress, no API token (the binding is authenticated by the deployment).
/// Selected when a type-39 (Cloudflare) channel's key is the sentinel
/// `internal`. The OpenAI body's `messages` + sampling params map onto the
/// Workers AI native input, and the `{response, usage}` output is synthesized
/// back into an OpenAI `chat.completion`, so the rest of the relay (usage
/// parsing, billing, audit) applies unchanged. When `AI_GATEWAY_ID` is
/// configured, the request is routed through that AI Gateway via the 3-arg
/// `run(model, inputs, {gateway})` the JS binding exposes (workers-rs 0.5 only
/// wraps the 2-arg form, hence the reflection). Non-stream only — the caller
/// rejects stream requests for binding channels before getting here.
async fn forward_ai_gateway_rest(
    attempt: &RelayAiGatewayAttempt,
    runtime: &RelayAiGatewayRuntime,
    body: &Value,
) -> worker::Result<Response> {
    let body = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &format!("Bearer {}", runtime.api_token))?;
    if attempt.plan.requires_gateway_id_header || !runtime.gateway_id.is_empty() {
        headers.set("cf-aig-gateway-id", &runtime.gateway_id)?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(&attempt.url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn forward_workers_ai_binding(
    env: &Env,
    model: &str,
    body: &Value,
) -> worker::Result<Response> {
    use wasm_bindgen::JsCast;

    let mut input = serde_json::Map::new();
    if let Some(messages) = body.get("messages") {
        input.insert("messages".to_string(), messages.clone());
    }
    for key in ["max_tokens", "temperature", "top_p", "seed"] {
        if let Some(value) = body.get(key) {
            input.insert(key.to_string(), value.clone());
        }
    }
    let input_js = js_sys::JSON::parse(&Value::Object(input).to_string())
        .map_err(|_| worker::Error::RustError("workers-ai input encode failed".to_string()))?;

    let ai = env.ai("AI")?;
    let ai_js: &wasm_bindgen::JsValue = ai.as_ref();
    let run_fn = js_sys::Reflect::get(ai_js, &wasm_bindgen::JsValue::from_str("run"))
        .ok()
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
        .ok_or_else(|| worker::Error::RustError("AI binding has no run()".to_string()))?;
    let gateway_id = env
        .var("AI_GATEWAY_ID")
        .map(|value| value.to_string())
        .ok()
        .filter(|value| !value.trim().is_empty());
    let call_result = if let Some(gateway_id) = gateway_id {
        let options =
            js_sys::JSON::parse(&serde_json::json!({"gateway": {"id": gateway_id}}).to_string())
                .map_err(|_| {
                    worker::Error::RustError("workers-ai gateway options encode failed".to_string())
                })?;
        run_fn.call3(
            ai_js,
            &wasm_bindgen::JsValue::from_str(model),
            &input_js,
            &options,
        )
    } else {
        run_fn.call2(ai_js, &wasm_bindgen::JsValue::from_str(model), &input_js)
    };
    let promise: js_sys::Promise = call_result
        .map_err(|err| worker::Error::RustError(format!("workers-ai run failed: {err:?}")))?
        .into();
    let output = wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(|err| worker::Error::RustError(format!("workers-ai error: {err:?}")))?;
    let output_json = js_sys::JSON::stringify(&output)
        .ok()
        .and_then(|value| value.as_string())
        .ok_or_else(|| worker::Error::RustError("workers-ai output encode failed".to_string()))?;
    let output: Value = serde_json::from_str(&output_json)
        .map_err(|err| worker::Error::RustError(format!("workers-ai output parse: {err}")))?;

    let content = output
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Most Workers AI text models report token usage; absence flows the
    // relay's normal missing-usage path (refund or local estimate).
    let usage = output.get("usage").cloned().unwrap_or_else(
        || serde_json::json!({"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
    );
    let completion = serde_json::json!({
        "id": "chatcmpl-workers-ai",
        "object": "chat.completion",
        "created": unix_timestamp(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": usage,
    });
    Response::from_json(&completion)
}

/// `true` when this channel executes over the Workers AI binding rather than
/// an outbound HTTP upstream.
fn is_workers_ai_binding_channel(channel: &RelayChannel) -> bool {
    channel.channel_type == cinatoken_relay::openai_compatible::CHANNEL_TYPE_CLOUDFLARE
        && channel.key.trim() == "internal"
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

/// Forward a raw-bytes body (multipart/form-data, octet-stream, etc.) to an
/// OpenAI-compatible upstream. Used by the upload endpoints
/// (`/v1/audio/transcriptions`, `/v1/audio/translations`,
/// `/v1/images/edits`) that receive `multipart/form-data` instead of JSON.
///
/// The `content_type` must carry the original boundary parameter so the
/// upstream can parse the multipart body correctly.
async fn forward_raw_openai_compatible(
    url: &str,
    upstream_key: &str,
    channel: &RelayChannel,
    bytes: &[u8],
    content_type: &str,
) -> worker::Result<Response> {
    let mut headers = Headers::new();
    headers.set("content-type", content_type)?;
    headers.set("authorization", &format!("Bearer {upstream_key}"))?;
    if let Some(org) = channel
        .openai_organization
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.set("openai-organization", org)?;
    }

    // Convert the raw bytes into a JS ArrayBuffer via Uint8Array so the
    // Worker fetch sends binary data verbatim.
    let body = js_sys::Uint8Array::from(bytes).buffer();
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.into()));
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

/// Build the client-facing response from an upstream (fetched) response.
///
/// A `Response` returned by `fetch()` has immutable headers on the Workers
/// runtime, so content-type / CORS cannot be set on it directly (doing so
/// throws `TypeError: Can't modify immutable headers`). Copy its headers into a
/// fresh, mutable `Headers`, carry over the status and (possibly streaming)
/// body, then apply the content-type override and CORS.
fn finalize_relay_response(upstream: Response, content_type: &str) -> worker::Result<Response> {
    let status = upstream.status_code();
    let mut headers = Headers::new();
    for (name, value) in upstream.headers().entries() {
        // Best-effort copy: skip any single header the runtime rejects on
        // re-emit rather than failing the whole relay response.
        let _ = headers.set(&name, &value);
    }
    let (_, body) = upstream.into_parts();
    let mut response = Response::from_body(body)?
        .with_status(status)
        .with_headers(headers);
    response.headers_mut().set("content-type", content_type)?;
    set_cors_headers(&mut response)?;
    Ok(response)
}

async fn complete_relay_response(
    mut upstream: Response,
    env: Env,
    db: D1Database,
    context: Option<Context>,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    provider: RelayProviderKind,
    parse_usage: bool,
    max_json_response_bytes: usize,
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
    if status == 200 && should_transform_cohere_rerank_response(&endpoint_path, &channel) {
        return complete_cohere_rerank_response(
            upstream,
            env,
            db,
            context,
            auth,
            channel,
            model,
            group,
            endpoint_path,
            audit,
            status,
            upstream_request_id,
            content_type,
            max_json_response_bytes,
        )
        .await;
    }
    if !parse_usage {
        if let Some(context) = context {
            context.wait_until(async move {
                if let Err(err) = record_relay_audit(
                    &env,
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
            &env,
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

        return finalize_relay_response(upstream, &content_type);
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
                    &env,
                    &db,
                    &auth,
                    &channel,
                    &model,
                    &group,
                    &endpoint_path,
                    provider,
                    &audit,
                    max_json_response_bytes,
                )
                .await;
            }
        };

        context.wait_until(async move {
            let mut audit = audit;
            let (usage, usage_locally_estimated) = match response_usage_summary(
                &mut audit_response,
                provider,
                &endpoint_path,
                max_json_response_bytes,
                &model,
                audit.estimated_prompt_tokens,
                audit.missing_usage_estimate_enabled,
            )
            .await
            {
                Ok(resolved) => resolved,
                Err(err) => {
                    worker::console_error!("failed to parse non-streaming relay usage: {}", err);
                    (UsageSummary::default(), false)
                }
            };
            audit.usage_locally_estimated = usage_locally_estimated;
            if let Err(err) = record_relay_audit(
                &env,
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

        return finalize_relay_response(upstream, &content_type);
    }

    complete_buffered_relay_response(
        upstream,
        &env,
        &db,
        &auth,
        &channel,
        &model,
        &group,
        &endpoint_path,
        provider,
        &audit,
        max_json_response_bytes,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn complete_passthrough_relay_response_with_usage(
    upstream: Response,
    env: Env,
    db: D1Database,
    context: Option<Context>,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    status: u16,
    content_type: String,
    usage: UsageSummary,
    audit: RelayAuditContext,
    upstream_request_id: Option<String>,
    log_label: &'static str,
) -> worker::Result<Response> {
    if let Some(context) = context {
        context.wait_until(async move {
            if let Err(err) = record_relay_audit(
                &env,
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
                worker::console_error!("failed to record {} audit: {}", log_label, err);
            }
        });
    } else if let Err(err) = record_relay_audit(
        &env,
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
        worker::console_error!("failed to record {} audit: {}", log_label, err);
    }

    finalize_relay_response(upstream, &content_type)
}

#[allow(clippy::too_many_arguments)]
async fn complete_cohere_rerank_response(
    mut upstream: Response,
    env: Env,
    db: D1Database,
    context: Option<Context>,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    audit: RelayAuditContext,
    status: u16,
    upstream_request_id: Option<String>,
    content_type: String,
    max_json_response_bytes: usize,
) -> worker::Result<Response> {
    let fallback_prompt_tokens = audit
        .billing_request_input
        .body
        .as_ref()
        // Rerank is not the OpenAI chat format, so no chat formatting overhead.
        .map(|body| request_token_estimate_from_body(body, false))
        .map(RequestTokenEstimate::prompt_tokens)
        .unwrap_or_default();
    let body = match read_response_text_limited(&mut upstream, max_json_response_bytes).await {
        Ok(body) => body,
        Err(err) if !err.body_consumed() => {
            worker::console_error!(
                "skipping Cohere rerank response transform: {}",
                err.message("Cohere rerank response body")
            );
            return complete_passthrough_relay_response_with_usage(
                upstream,
                env,
                db,
                context,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                status,
                content_type,
                UsageSummary::default(),
                audit,
                upstream_request_id,
                "Cohere rerank",
            )
            .await;
        }
        Err(err) => {
            return openai_error_response(
                format!(
                    "failed to read Cohere rerank response: {}",
                    err.message("Cohere rerank response body")
                ),
                502,
            );
        }
    };
    let (body, usage) = match transform_cohere_rerank_response_body(&body, fallback_prompt_tokens) {
        Ok(transformed) => transformed,
        Err(err) => {
            worker::console_error!("failed to transform Cohere rerank response: {}", err);
            (
                body.clone(),
                usage_summary_for_provider(&body, RelayProviderKind::OpenAiCompatible, "rerank"),
            )
        }
    };

    if let Some(context) = context {
        context.wait_until(async move {
            if let Err(err) = record_relay_audit(
                &env,
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
                worker::console_error!("failed to record Cohere rerank audit: {}", err);
            }
        });
    } else if let Err(err) = record_relay_audit(
        &env,
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
        worker::console_error!("failed to record Cohere rerank audit: {}", err);
    }

    let mut response = Response::ok(body)?.with_status(status);
    response
        .headers_mut()
        .set("content-type", "application/json")?;
    set_cors_headers(&mut response)?;
    Ok(response)
}

async fn complete_buffered_relay_response(
    mut upstream: Response,
    env: &Env,
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel: &RelayChannel,
    model: &str,
    group: &str,
    endpoint_path: &str,
    provider: RelayProviderKind,
    audit: &RelayAuditContext,
    max_json_response_bytes: usize,
) -> worker::Result<Response> {
    let status = upstream.status_code();
    let content_type = upstream
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_else(|| "application/json".to_string());
    let upstream_request_id = response_header(&upstream, &["x-request-id", "cf-ray"]);
    let body = match read_response_text_limited(&mut upstream, max_json_response_bytes).await {
        Ok(body) => body,
        Err(err) if !err.body_consumed() => {
            worker::console_error!(
                "skipping buffered relay usage parsing: {}",
                err.message("relay response body")
            );
            if let Err(err) = record_relay_audit(
                &env,
                db,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                status,
                &UsageSummary::default(),
                audit,
                upstream_request_id.as_deref(),
                false,
            )
            .await
            {
                worker::console_error!("failed to record relay audit: {}", err);
            }

            return finalize_relay_response(upstream, &content_type);
        }
        Err(err) => {
            return openai_error_response(
                format!(
                    "failed to read relay response: {}",
                    err.message("relay response body")
                ),
                502,
            );
        }
    };
    let usage = usage_summary_for_provider(&body, provider, endpoint_path);

    if let Err(err) = record_relay_audit(
        &env,
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
    endpoint_path: &str,
    max_json_response_bytes: usize,
    model: &str,
    estimated_prompt_tokens: i64,
    estimate_enabled: bool,
) -> worker::Result<(UsageSummary, bool)> {
    let body = read_response_text_limited(response, max_json_response_bytes)
        .await
        .map_err(|err| worker::Error::RustError(err.message("relay response body")))?;
    let usage = usage_summary_for_provider(&body, provider, endpoint_path);
    // Missing-usage estimate fallback only applies to the OpenAI chat shape
    // (the body-text extraction is OpenAI-shaped); rerank carries its own usage.
    let estimate_applicable = estimate_enabled
        && matches!(provider, RelayProviderKind::OpenAiCompatible)
        && endpoint_path != "rerank";
    let (usage, locally_estimated) = resolve_non_stream_usage(
        usage,
        &body,
        model,
        estimated_prompt_tokens,
        estimate_applicable,
    );
    if locally_estimated {
        worker::console_log!(
            "relay usage missing; locally estimated non-stream usage for {} (prompt={}, completion={})",
            model,
            usage.prompt_tokens,
            usage.completion_tokens
        );
    }
    Ok((usage, locally_estimated))
}

fn usage_summary_for_provider(
    body: &str,
    provider: RelayProviderKind,
    endpoint_path: &str,
) -> UsageSummary {
    match provider {
        RelayProviderKind::OpenAiCompatible if endpoint_path == "rerank" => {
            usage_summary_from_rerank_body(body)
        }
        RelayProviderKind::OpenAiCompatible => usage_summary_from_body(body),
        RelayProviderKind::AnthropicMessages => usage_summary_from_anthropic_body(body),
        RelayProviderKind::GeminiNative => usage_summary_from_gemini_body(body),
    }
}

async fn complete_streaming_relay_response(
    mut upstream: Response,
    env: Env,
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
        let mut audit = audit;
        let (usage, usage_locally_estimated) = match streaming_usage_summary(
            &mut audit_response,
            provider,
            &model,
            audit.estimated_prompt_tokens,
            audit.missing_usage_estimate_enabled,
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(err) => {
                worker::console_error!("failed to parse streaming relay usage: {}", err);
                (UsageSummary::default(), false)
            }
        };
        audit.usage_locally_estimated = usage_locally_estimated;
        if let Err(err) = record_relay_audit(
            &env,
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

    finalize_relay_response(upstream, &content_type)
}

async fn streaming_usage_summary(
    upstream: &mut Response,
    provider: RelayProviderKind,
    model: &str,
    estimated_prompt_tokens: i64,
    estimate_enabled: bool,
) -> worker::Result<(UsageSummary, bool)> {
    let mut stream = upstream.stream()?;
    let mut accumulator = match provider {
        RelayProviderKind::OpenAiCompatible => SseUsageAccumulator::default(),
        RelayProviderKind::AnthropicMessages => SseUsageAccumulator::anthropic(),
        RelayProviderKind::GeminiNative => SseUsageAccumulator::gemini(),
    };

    while let Some(chunk) = stream.next().await {
        accumulator.push_chunk(&chunk?);
    }

    let (usage, response_text, tool_count) = accumulator.into_parts();
    // The streamed-text accumulation is OpenAI-shaped; only estimate for that
    // provider (Anthropic/Gemini emit reliable usage chunks).
    let estimate_applicable =
        estimate_enabled && matches!(provider, RelayProviderKind::OpenAiCompatible);
    let (usage, locally_estimated) = resolve_stream_usage(
        usage,
        &response_text,
        tool_count,
        model,
        estimated_prompt_tokens,
        estimate_applicable,
    );
    if locally_estimated {
        worker::console_log!(
            "relay stream usage missing; locally estimated usage for {} (prompt={}, completion={}, tools={})",
            model,
            usage.prompt_tokens,
            usage.completion_tokens,
            tool_count
        );
    }
    Ok((usage, locally_estimated))
}

#[derive(Clone)]
struct RelayAuditContext {
    started_at: i64,
    client_ip: Option<String>,
    request_id: Option<String>,
    billing_request_input: RequestInput,
    tiered_billing_preflight: Option<TieredBillingPreflight>,
    /// Pre-consume prompt-token estimate for this request (Go
    /// `info.GetEstimatePromptTokens()`). Feeds the missing-usage estimate
    /// fallback so a usage-less response settles on `estimate(prompt) +
    /// estimate(completion-text)` instead of refunding.
    estimated_prompt_tokens: i64,
    /// Whether `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` is set. When off (default),
    /// a missing/invalid upstream usage refunds the reserve as before; when on,
    /// the relay estimates and bills it (Go parity). Charge-affecting cutover.
    missing_usage_estimate_enabled: bool,
    /// Set by the settlement path when the usage was locally estimated (the
    /// missing-usage fallback fired) rather than reported by the upstream. Drives
    /// the `usage_source` audit field (Go `ContextKeyLocalCountTokens`).
    usage_locally_estimated: bool,
    /// Fixed-rule channel affinity diagnostics for usage-log UI and upstream
    /// cache-hit stats. `None` when affinity is disabled or unavailable.
    affinity: Option<affinity::AffinityAuditContext>,
}

async fn record_relay_audit(
    env: &Env,
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
    // Whether the upstream reported real usage to settle on. With the Go-parity
    // estimate fallback enabled, a usage is "present" when it passes Go's
    // `ValidUsage` gate (prompt or completion non-zero); otherwise the legacy
    // `total > 0` gate applies so flipping the flag off changes nothing.
    let usage_present = if audit.missing_usage_estimate_enabled {
        cinatoken_tokenizer::valid_usage(usage.prompt_tokens as i64, usage.completion_tokens as i64)
    } else {
        usage.total_tokens > 0
    };
    let mut other = json!({
        "billing_pending": true,
        "relay_runtime": "cloudflare_worker_rust",
        "endpoint": endpoint_path,
        "upstream_status": upstream_status,
        "total_tokens": usage.total_tokens,
        "usage_source": if audit.usage_locally_estimated { "local_estimate" } else { "upstream" },
    });
    if let Some(affinity_context) = audit.affinity.as_ref() {
        set_json_value(
            &mut other,
            "admin_info",
            json!({
                "channel_affinity": affinity::affinity_log_info(affinity_context),
            }),
        );
    }
    let mut quota = 0;
    let mut billing_applied = false;
    let mut billing_resolved = false;
    if let Some(preflight) = audit.tiered_billing_preflight.as_ref() {
        if upstream_status < 400 && usage_present {
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
                            refund_reason(
                                upstream_status,
                                usage,
                                is_stream,
                                audit.missing_usage_estimate_enabled,
                            ),
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

    if !billing_applied && upstream_status < 400 && usage_present {
        // Non-tiered ("flat") billing: compute the per-token (or fixed-price)
        // quota from ModelRatio / CompletionRatio / ModelPrice options and
        // apply it atomically. This is the fallback when no `tiered_expr`
        // is configured for the model. Mirrors Go's
        // `service/text_quota.go::PostTextConsumeQuota` non-tiered path.
        match try_flat_billing(db, auth, channel.id, model, group, usage, now).await {
            Ok(Some(flat_result)) => {
                quota = flat_result.quota;
                billing_applied = true;
                billing_resolved = true;
                set_json_value(
                    &mut other,
                    "flat_billing",
                    serde_json::json!({
                        "quota": flat_result.quota,
                        "mode": match flat_result.mode {
                            FlatBillingMode::FixedPrice => "fixed_price",
                            FlatBillingMode::PerToken => "per_token",
                        },
                        "model_ratio": flat_result.model_ratio,
                        "completion_ratio": flat_result.completion_ratio,
                        "group_ratio": flat_result.group_ratio,
                        "cache_ratio": flat_result.cache_ratio,
                    }),
                );
            }
            Ok(None) => {
                // Config loaded but no model entry; treat as unbilled.
            }
            Err(err) => {
                set_json_string(
                    &mut other,
                    "flat_billing_error",
                    format!("non-tiered billing failed: {err}"),
                );
            }
        }
    }

    if upstream_status < 400 && usage_present {
        if let Some(affinity_context) = audit.affinity.as_ref() {
            let mode = affinity_cached_token_rate_mode(endpoint_path, channel.channel_type);
            if let Err(err) =
                affinity::observe_affinity_usage_cache(env, affinity_context, usage, mode).await
            {
                worker::console_warn!("failed to observe channel affinity usage cache: {err}");
            }
        }
    }

    if !billing_applied {
        if auth.token_id > 0 {
            crate::d1_repositories::touch_token(db, auth.token_id, now).await?;
        }
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
    // Send the audit event to LOG_QUEUE for async batch INSERT. Falls back
    // to a synchronous D1 INSERT when the queue binding is not configured
    // (local dev without wrangler queue, or `cargo test`).
    let event = cinatoken_storage::AuditLogEvent::from_relay_audit(now, &content, &audit_log, 2);
    match env.queue("LOG_QUEUE") {
        Ok(queue) => match queue.send(&event).await {
            Ok(()) => Ok(()),
            Err(err) => {
                worker::console_warn!(
                    "LOG_QUEUE send failed, falling back to synchronous D1 insert: {err}"
                );
                crate::d1_repositories::insert_relay_audit_log(db, now, &content, &audit_log).await
            }
        },
        Err(_) => {
            // Queue binding not configured (local dev / tests).
            crate::d1_repositories::insert_relay_audit_log(db, now, &content, &audit_log).await
        }
    }
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
    is_openai_chat: bool,
    extra_prompt_tokens: i64,
) -> worker::Result<Option<TieredBillingPreflight>> {
    let Some(expr) = crate::d1_repositories::tiered_billing_expr_for_model(db, model).await? else {
        return Ok(None);
    };
    let group_ratio = crate::d1_repositories::group_ratio_for_group(db, group).await?;
    tiered_billing_preflight_snapshot(
        model,
        &expr,
        group_ratio,
        request_body,
        request.clone(),
        is_openai_chat,
        extra_prompt_tokens,
    )
    .map(Some)
    .map_err(worker::Error::RustError)
}

fn tiered_billing_preflight_snapshot(
    model: &str,
    expr: &str,
    group_ratio: f64,
    request_body: &Value,
    request: RequestInput,
    is_openai_chat: bool,
    extra_prompt_tokens: i64,
) -> Result<TieredBillingPreflight, String> {
    let used_vars = detect_billing_expr_variables(expr);
    let params = token_params_from_request(
        model,
        request_body,
        used_vars,
        is_openai_chat,
        extra_prompt_tokens,
    );
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

/// Load pricing options from D1, compute the non-tiered ("flat") quota for
/// the response, and apply it atomically to the user + token + channel.
/// Returns `Ok(None)` when the model has no pricing configured (unbilled),
/// `Ok(Some(result))` on success, `Err` on D1 or config failure.
///
/// Mirrors Go's `service.PostTextConsumeQuota` non-tiered path. The audit
/// metadata is returned to the caller via the `FlatQuotaResult` so it can
/// be recorded in the relay audit log's `other` JSON column.
async fn try_flat_billing(
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel_id: i64,
    model: &str,
    group: &str,
    usage: &UsageSummary,
    now: i64,
) -> Result<Option<FlatQuotaResult>, String> {
    // Load all pricing options in one D1 round-trip.
    let keys = [
        "ModelRatio",
        "CompletionRatio",
        "ModelPrice",
        "CacheRatio",
        "QuotaPerUnit",
        crate::d1_repositories::GROUP_RATIO_OPTION_KEY,
        "CreateCacheRatio",
        "ImageRatio",
        "AudioRatio",
        "AudioCompletionRatio",
    ];
    let values = crate::d1_repositories::option_values(db, &keys)
        .await
        .map_err(|err| format!("failed to load pricing options: {err}"))?;
    let config = PricingConfig::new()
        .with_json_maps(
            values[0].as_deref(),
            values[1].as_deref(),
            values[2].as_deref(),
            values[3].as_deref(),
            values[5].as_deref(), // group ratio
            values[4].as_deref(), // quota per unit
        )
        .with_subcategory_maps(
            values[6].as_deref(), // create cache ratio
            values[7].as_deref(), // image ratio
            values[8].as_deref(), // audio ratio
            values[9].as_deref(), // audio completion ratio
        );

    // A model is "priced" (billable) if it resolves a ratio OR price through
    // any layer (operator map, Go default table, or compact-wildcard), mirroring
    // Go's "is this model configured?" check. Without this, an unconfigured-but-
    // known model like gpt-4o (default ratio 1.25) would be treated as free.
    // `has_model_pricing` normalizes and consults the same layers model_ratio()
    // / model_price() do, so the gate and the lookups can never disagree.
    if !config.has_model_pricing(model) {
        // Truly unconfigured model: treat as unbilled (operator has not
        // configured pricing and Go has no default for it).
        return Ok(None);
    }

    let flat_usage = FlatUsage {
        prompt_tokens: usage.prompt_tokens as i64,
        completion_tokens: usage.completion_tokens as i64,
        total_tokens: usage.total_tokens as i64,
        cached_tokens: usage.cached_tokens as i64,
        cache_creation_tokens: usage.cache_creation_tokens as i64,
        cache_creation_5m_tokens: usage.claude_cache_creation_5m_tokens as i64,
        cache_creation_1h_tokens: usage.claude_cache_creation_1h_tokens as i64,
        image_tokens: usage.image_input_tokens as i64,
        is_anthropic_usage_semantic: usage.is_anthropic_usage_semantic,
    };
    let result = compute_flat_quota(&flat_usage, model, group, &config);
    if result.quota == 0 {
        // Zero-usage or zero-cost: still considered resolved (no refund
        // needed because non-tiered never reserves).
        return Ok(Some(result));
    }
    crate::d1_repositories::apply_relay_quota_usage(
        db,
        auth.user_id,
        auth.token_id,
        channel_id,
        result.quota,
        now,
    )
    .await
    .map_err(|err| format!("failed to apply flat quota: {err}"))?;
    Ok(Some(result))
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

fn missing_usage_estimate_enabled(env: &Env) -> bool {
    matches!(
        optional_env_var(env, MISSING_USAGE_ESTIMATE_ENV).as_deref(),
        Some("true") | Some("1")
    )
}

fn stream_options_inject_enabled(env: &Env) -> bool {
    matches!(
        optional_env_var(env, STREAM_OPTIONS_INJECT_ENV).as_deref(),
        Some("true") | Some("1")
    )
}

fn affinity_cached_token_rate_mode(endpoint_path: &str, channel_type: i32) -> &'static str {
    if ANTHROPIC_CHANNEL_TYPES.contains(&channel_type) || endpoint_path == "messages" {
        affinity::CACHE_TOKEN_RATE_MODE_CACHED_OVER_PROMPT_PLUS_CACHED
    } else if matches!(
        endpoint_path,
        "chat/completions" | "completions" | "responses" | "images/generations"
    ) {
        affinity::CACHE_TOKEN_RATE_MODE_CACHED_OVER_PROMPT
    } else {
        ""
    }
}

/// Resolve a streaming chat usage, applying Go's missing-usage estimate fallback
/// (`OaiStreamHandler`): when the stream carried no valid usage
/// (`!ValidUsage`, i.e. both prompt and completion are zero), estimate from the
/// accumulated completion text and `tool_count * 7`
/// (`ResponseText2Usage` + the tool bump). Returns the (possibly estimated)
/// usage and whether it was locally estimated. A no-op (returns the upstream
/// usage) when the fallback is disabled or the usage is already valid.
fn resolve_stream_usage(
    usage: UsageSummary,
    response_text: &str,
    tool_count: i64,
    model: &str,
    estimated_prompt_tokens: i64,
    enabled: bool,
) -> (UsageSummary, bool) {
    if !enabled
        || cinatoken_tokenizer::valid_usage(
            usage.prompt_tokens as i64,
            usage.completion_tokens as i64,
        )
    {
        return (usage, false);
    }
    let estimate = cinatoken_tokenizer::response_text_to_usage(
        model,
        response_text,
        estimated_prompt_tokens,
        tool_count,
    );
    (
        UsageSummary {
            prompt_tokens: estimate.prompt_tokens as i32,
            completion_tokens: estimate.completion_tokens as i32,
            total_tokens: estimate.total_tokens as i32,
            ..UsageSummary::default()
        },
        true,
    )
}

/// Resolve a non-stream chat usage, applying Go's missing-usage estimate
/// fallback (`OpenaiHandler`): when the upstream reports zero prompt tokens,
/// set prompt to the pre-consume estimate and completion to the upstream
/// completion if non-zero, else the char-class estimate over the response body's
/// assistant text. No `tool_count * 7` bump here (Go adds it only on the stream
/// path). Returns the (possibly estimated) usage and whether it was estimated.
fn resolve_non_stream_usage(
    usage: UsageSummary,
    body: &str,
    model: &str,
    estimated_prompt_tokens: i64,
    enabled: bool,
) -> (UsageSummary, bool) {
    if !enabled || usage.prompt_tokens != 0 {
        return (usage, false);
    }
    let completion_tokens = if usage.completion_tokens != 0 {
        usage.completion_tokens as i64
    } else {
        let text = cinatoken_relay::openai_response_completion_text(body);
        cinatoken_tokenizer::estimate_tokens(model, &text) as i64
    };
    (
        UsageSummary {
            prompt_tokens: estimated_prompt_tokens as i32,
            completion_tokens: completion_tokens as i32,
            total_tokens: (estimated_prompt_tokens + completion_tokens) as i32,
            ..UsageSummary::default()
        },
        true,
    )
}

fn refund_reason(
    upstream_status: u16,
    usage: &UsageSummary,
    is_stream: bool,
    estimate_enabled: bool,
) -> &'static str {
    // Same "is usage present" gate as settlement so the classification agrees
    // with whether billing was attempted.
    let usage_present = if estimate_enabled {
        cinatoken_tokenizer::valid_usage(usage.prompt_tokens as i64, usage.completion_tokens as i64)
    } else {
        usage.total_tokens > 0
    };
    if upstream_status >= 400 {
        "upstream_error"
    } else if !usage_present {
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

fn token_params_from_request(
    model: &str,
    body: &Value,
    used_vars: BillingExprVariables,
    is_openai_chat: bool,
    extra_prompt_tokens: i64,
) -> TokenParams {
    let mut estimate = request_token_estimate_from_body_for_model(model, body, is_openai_chat);
    estimate.text_prompt_tokens = estimate
        .text_prompt_tokens
        .saturating_add(extra_prompt_tokens.max(0));
    build_tiered_token_params(
        TieredTokenUsage {
            prompt_tokens: estimate.prompt_tokens(),
            completion_tokens: estimate.completion_tokens,
            image_input_tokens: estimate.image_input_tokens,
            audio_input_tokens: estimate.audio_input_tokens,
            usage_semantic: UsageSemantic::OpenAi,
            ..TieredTokenUsage::default()
        },
        false,
        used_vars,
    )
}

fn validate_rerank_request(body: &Value) -> Option<&'static str> {
    if body
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Some("rerank request body must include a non-empty query");
    }
    if body
        .get("documents")
        .and_then(Value::as_array)
        .filter(|documents| !documents.is_empty())
        .is_none()
    {
        return Some("rerank request body must include non-empty documents");
    }
    if body
        .get("top_n")
        .is_some_and(|value| !value.is_null() && !value_is_integer_number(value))
    {
        return Some("rerank request top_n must be an integer");
    }
    None
}

fn apply_endpoint_request_transform(body: &mut Value, endpoint_path: &str, channel: &RelayChannel) {
    if endpoint_path == "rerank" && channel.channel_type == CHANNEL_TYPE_COHERE {
        apply_cohere_rerank_request_transform(body);
    }
}

fn should_transform_cohere_rerank_response(endpoint_path: &str, channel: &RelayChannel) -> bool {
    endpoint_path == "rerank" && channel.channel_type == CHANNEL_TYPE_COHERE
}

fn apply_cohere_rerank_request_transform(body: &mut Value) {
    let query = body
        .get("query")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let documents = body
        .get("documents")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let model = body
        .get("model")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let top_n = body
        .get("top_n")
        .and_then(value_to_non_negative_i64)
        .filter(|value| *value > 0)
        .unwrap_or(1);

    *body = json!({
        "query": query,
        "documents": documents,
        "model": model,
        "top_n": top_n,
        "return_documents": true,
    });
}

fn transform_cohere_rerank_response_body(
    body: &str,
    fallback_prompt_tokens: i64,
) -> Result<(String, UsageSummary), serde_json::Error> {
    let value = serde_json::from_str::<Value>(body)?;
    let results = value
        .get("results")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let usage = cohere_rerank_transform_usage(&value, fallback_prompt_tokens);

    let response = json!({
        "results": results,
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
    });
    serde_json::to_string(&response).map(|body| (body, usage))
}

fn cohere_rerank_transform_usage(value: &Value, fallback_prompt_tokens: i64) -> UsageSummary {
    let billed_units = value.get("meta").and_then(|meta| meta.get("billed_units"));
    let input_tokens = billed_units
        .and_then(|usage| usage.get("input_tokens"))
        .and_then(value_to_non_negative_i64)
        .map(clamp_i64_to_i32)
        .unwrap_or_default();
    if input_tokens == 0 {
        let prompt_tokens = clamp_i64_to_i32(fallback_prompt_tokens.max(0));
        return UsageSummary {
            prompt_tokens,
            total_tokens: prompt_tokens,
            ..UsageSummary::default()
        };
    }

    let completion_tokens = billed_units
        .and_then(|usage| usage.get("output_tokens"))
        .and_then(value_to_non_negative_i64)
        .map(clamp_i64_to_i32)
        .unwrap_or_default();
    UsageSummary {
        prompt_tokens: input_tokens,
        completion_tokens,
        total_tokens: input_tokens.saturating_add(completion_tokens),
        ..UsageSummary::default()
    }
}

#[cfg(test)]
fn estimate_prompt_tokens_from_request(body: &Value, is_openai_chat: bool) -> i64 {
    estimate_prompt_tokens_from_request_for_model("gpt-4o", body, is_openai_chat)
}

/// Estimate prompt tokens using the char-class tokenizer for the given
/// model family. Falls back to the legacy char/4 estimate when `model` is
/// empty. Used by the tiered billing preflight to size the reserve.
fn estimate_prompt_tokens_from_request_for_model(
    model: &str,
    body: &Value,
    is_openai_chat: bool,
) -> i64 {
    request_token_estimate_from_body_for_model(model, body, is_openai_chat).prompt_tokens()
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

fn request_token_estimate_from_body(body: &Value, is_openai_chat: bool) -> RequestTokenEstimate {
    request_token_estimate_from_body_for_model("gpt-4o", body, is_openai_chat)
}

fn request_token_estimate_from_body_for_model(
    model: &str,
    body: &Value,
    is_openai_chat: bool,
) -> RequestTokenEstimate {
    let mut estimate = RequestTokenEstimate {
        text_prompt_tokens: estimate_text_prompt_tokens_from_request_for_model(
            model,
            body,
            is_openai_chat,
        ),
        completion_tokens: estimate_completion_tokens_from_request(body),
        ..RequestTokenEstimate::default()
    };
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    collect_media_token_estimate(body, model, stream, &mut estimate);
    estimate
}

fn estimate_text_prompt_tokens_from_request_for_model(
    model: &str,
    body: &Value,
    is_openai_chat: bool,
) -> i64 {
    let mut text = String::new();

    for key in [
        "prompt",
        "input",
        "contents",
        "system",
        "instruction",
        "instructions",
        "query",
        "documents",
        "prefix",
        "suffix",
    ] {
        if let Some(value) = body.get(key) {
            collect_prompt_text(value, &mut text);
        }
    }

    // Collect the message/tool text (counted for every request format) and the
    // counts that feed the OpenAI chat formatting overhead.
    let mut messages_count = 0i64;
    let mut name_count = 0i64;
    let mut tools_count = 0i64;
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        messages_count = saturating_usize_to_i64(messages.len());
        for message in messages {
            if let Some(role) = message.get("role").and_then(Value::as_str) {
                text.push_str(role);
                text.push(' ');
            }
            if let Some(name) = message.get("name").and_then(Value::as_str) {
                text.push_str(name);
                text.push(' ');
                name_count = name_count.saturating_add(1);
            }
            if let Some(content) = message.get("content") {
                collect_prompt_text(content, &mut text);
            }
        }
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        tools_count = saturating_usize_to_i64(tools.len());
        for tool in tools {
            collect_tool_text(tool, &mut text);
        }
    }

    // The chat formatting overhead (Go: tools*8 + messages*3 + name*3 + 3) is
    // added only for the OpenAI chat-completions format (RelayFormatOpenAI);
    // Anthropic /messages and Gemini count the text without it. Gated only when a
    // messages array is present, matching Go's per-request `meta` population.
    let structural_tokens = if is_openai_chat && body.get("messages").is_some() {
        openai_chat_format_overhead(messages_count, tools_count, name_count)
    } else {
        0
    };

    let text_tokens = if model.is_empty() {
        estimate_tokens_from_chars(text.chars().count())
    } else {
        cinatoken_tokenizer::estimate_tokens(model, &text) as i64
    };
    text_tokens.saturating_add(structural_tokens)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestMediaKind {
    Image,
    Audio,
    Video,
    File,
}

fn collect_media_token_estimate(
    value: &Value,
    model: &str,
    stream: bool,
    estimate: &mut RequestTokenEstimate,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_media_token_estimate(item, model, stream, estimate);
            }
        }
        Value::Object(object) => {
            if let Some(kind) = request_media_kind_from_object(object) {
                match kind {
                    RequestMediaKind::Image => {
                        let tokens = image_token_estimate(object, model, stream);
                        estimate.image_input_tokens =
                            estimate.image_input_tokens.saturating_add(tokens);
                    }
                    other => add_media_token_estimate(other, estimate),
                }
                return;
            }
            for value in object.values() {
                collect_media_token_estimate(value, model, stream, estimate);
            }
        }
        _ => {}
    }
}

/// Estimate prompt tokens contributed by one image content part, mirroring Go
/// `EstimateRequestToken`'s image branch: `getImageToken` for OpenAI text models
/// (decode width/height, then patch/tile), a flat `520` for non-OpenAI models.
///
/// Go decodes the image config via `GetImageConfig`, which fetches remote URLs.
/// The preflight estimator does not perform that egress, so only images with
/// inline bytes (base64 data URLs or raw base64 `data` fields) get the precise
/// patch/tile count; remote-URL and undecodable images fall back to the flat
/// `520`. This affects only the reserved-quota estimate — settlement always uses
/// the upstream-reported usage.
fn image_token_estimate(object: &serde_json::Map<String, Value>, model: &str, stream: bool) -> i64 {
    if !is_openai_text_model(model) {
        return ESTIMATED_IMAGE_INPUT_TOKENS;
    }
    let detail = extract_image_detail(object);
    // Go env defaults: GET_MEDIA_TOKEN=true, GET_MEDIA_TOKEN_NOT_STREAM=false.
    let flags = MediaTokenFlags {
        get_media_token: true,
        get_media_token_not_stream: false,
    };
    // Go's dimension-independent short-circuits (detail=low, media flags,
    // non-stream) run before GetImageConfig and need no decoded pixels, so match
    // them even for remote/undecodable images (dimensions here are unused).
    if !image_tokens_needs_dimensions(model, &detail, stream, flags) {
        return image_tokens(0, 0, model, &detail, stream, flags);
    }
    // The patch/tile path genuinely needs pixels. Go fetches remote images to
    // decode them; the preflight estimator does not, so only inline images
    // (base64 data URLs / raw base64 `data`) get the precise count — remote and
    // undecodable images fall back to the flat per-image estimate.
    match extract_inline_image_bytes(object)
        .as_deref()
        .and_then(image_dimensions)
    {
        Some((width, height)) => image_tokens(width, height, model, &detail, stream, flags),
        None => ESTIMATED_IMAGE_INPUT_TOKENS,
    }
}

/// The OpenAI `detail` hint for an image part: `image_url.detail` (object form)
/// or a top-level `detail`. Empty when absent (`image_tokens` treats anything
/// other than `"low"` as high-detail, matching Go's normalization).
fn extract_image_detail(object: &serde_json::Map<String, Value>) -> String {
    object
        .get("image_url")
        .and_then(Value::as_object)
        .and_then(|inner| inner.get("detail"))
        .and_then(Value::as_str)
        .or_else(|| object.get("detail").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// Decode budget for image-dimension parsing: enough to reach a JPEG SOF marker
/// past large EXIF/APP segments without decoding multi-MB payloads.
const IMAGE_DIM_DECODE_CAP: usize = 64 * 1024;

/// Extract inline image bytes (header prefix) for dimension parsing. Handles
/// OpenAI `image_url` (string or `{url}`) base64 data URLs and raw base64 `data`
/// fields (Gemini `inline_data`, Anthropic `source`). Returns `None` for remote
/// `http(s)` URLs (not fetched in preflight) and non-base64 sources.
fn extract_inline_image_bytes(object: &serde_json::Map<String, Value>) -> Option<Vec<u8>> {
    let url = object
        .get("image_url")
        .and_then(|value| match value {
            Value::String(text) => Some(text.as_str()),
            Value::Object(inner) => inner.get("url").and_then(Value::as_str),
            _ => None,
        })
        .or_else(|| object.get("url").and_then(Value::as_str));
    if let Some(url) = url {
        // image_url is present: only inline base64 data URLs are decodable here.
        let bytes = data_url_base64(url)
            .map(|b64| base64_standard_decode_prefix(b64, IMAGE_DIM_DECODE_CAP))
            .filter(|bytes| !bytes.is_empty());
        return bytes;
    }

    let raw = object
        .get("data")
        .and_then(Value::as_str)
        .or_else(|| nested_str(object, "source", "data"))
        .or_else(|| nested_str(object, "inline_data", "data"))
        .or_else(|| nested_str(object, "inlineData", "data"))?;
    // Some clients put a full data URL in the raw `data` field.
    let b64 = data_url_base64(raw).unwrap_or(raw);
    let bytes = base64_standard_decode_prefix(b64, IMAGE_DIM_DECODE_CAP);
    (!bytes.is_empty()).then_some(bytes)
}

fn nested_str<'a>(
    object: &'a serde_json::Map<String, Value>,
    outer: &str,
    inner: &str,
) -> Option<&'a str> {
    object
        .get(outer)
        .and_then(Value::as_object)
        .and_then(|map| map.get(inner))
        .and_then(Value::as_str)
}

/// Return the base64 payload of a `data:[<mediatype>];base64,<payload>` URL, or
/// `None` if `url` is not a base64 data URL.
fn data_url_base64(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let (meta, payload) = rest.split_at(comma);
    if meta.contains(";base64") {
        Some(&payload[1..])
    } else {
        None
    }
}

/// Decode standard base64 (`+/` alphabet, RFC 4648) into bytes, stopping once
/// `max_bytes` are produced. Whitespace is skipped; `=` padding and any invalid
/// byte end the decode. Returns the decoded prefix — sufficient for a header
/// dimension parse without decoding the whole image.
fn base64_standard_decode_prefix(input: &str, max_bytes: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input.as_bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => break,
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            if out.len() >= max_bytes {
                break;
            }
        }
    }
    out
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

/// Legacy char-count collector. Retained for the model-empty fallback
/// path inside `estimate_text_prompt_tokens_from_request_for_model`.
#[allow(dead_code)]
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

#[allow(dead_code)]
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

/// Collect prompt text into a String buffer for tokenizer-based estimation.
/// Mirrors `collect_prompt_text_chars` but accumulates the raw text so the
/// char-class tokenizer can classify CJK / latin / number runs.
fn collect_prompt_text(value: &Value, text: &mut String) {
    match value {
        Value::String(s) => {
            text.push_str(s);
            text.push(' ');
        }
        Value::Array(items) => {
            for item in items {
                collect_prompt_text(item, text);
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
                    collect_prompt_text(value, text);
                }
            }
            if !matched_prompt_field {
                for (key, value) in object {
                    if should_skip_prompt_text_key(key) {
                        continue;
                    }
                    collect_prompt_text(value, text);
                }
            }
        }
        Value::Number(_) | Value::Bool(_) => {
            text.push_str(&value.to_string());
            text.push(' ');
        }
        Value::Null => {}
    }
}

fn collect_tool_text(value: &Value, text: &mut String) {
    match value {
        Value::String(s) => {
            text.push_str(s);
            text.push(' ');
        }
        Value::Array(items) => {
            for item in items {
                collect_tool_text(item, text);
            }
        }
        Value::Object(object) => {
            for key in ["name", "description", "parameters"] {
                if let Some(value) = object.get(key) {
                    collect_tool_text(value, text);
                }
            }
            if let Some(function) = object.get("function") {
                collect_tool_text(function, text);
            }
        }
        Value::Number(_) | Value::Bool(_) => {
            text.push_str(&value.to_string());
            text.push(' ');
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

#[allow(dead_code)]
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

fn value_is_integer_number(value: &Value) -> bool {
    value.as_i64().is_some() || value.as_u64().is_some()
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

pub(crate) fn client_ip(req: &Request) -> Option<String> {
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

    #[test]
    fn affinity_cached_token_rate_mode_matches_relay_families() {
        assert_eq!(
            affinity_cached_token_rate_mode("messages", 14),
            affinity::CACHE_TOKEN_RATE_MODE_CACHED_OVER_PROMPT_PLUS_CACHED
        );
        assert_eq!(
            affinity_cached_token_rate_mode("chat/completions", 1),
            affinity::CACHE_TOKEN_RATE_MODE_CACHED_OVER_PROMPT
        );
        assert_eq!(affinity_cached_token_rate_mode("embeddings", 1), "");
    }

    #[test]
    fn model_limit_disabled_allows_anything() {
        // Go: modelLimitEnable == false -> skip the gate entirely.
        assert!(model_allowed_for_token(0, "", "gpt-4o"));
        assert!(model_allowed_for_token(0, "claude-3-opus", "gpt-4o"));
    }

    #[test]
    fn model_limit_exact_match_allows() {
        assert!(model_allowed_for_token(1, "gpt-4o,claude-3-opus", "gpt-4o"));
        assert!(model_allowed_for_token(
            1,
            "gpt-4o,claude-3-opus",
            "claude-3-opus"
        ));
    }

    #[test]
    fn model_limit_non_match_denies() {
        assert!(!model_allowed_for_token(1, "gpt-4o", "claude-3-opus"));
    }

    #[test]
    fn model_limit_enabled_empty_denies_all() {
        // Go distributor.go: enabled with an empty limit map -> 403 for every
        // model (no entry matches). csv_contains("") == false reproduces it.
        assert!(!model_allowed_for_token(1, "", "gpt-4o"));
        assert!(!model_allowed_for_token(1, "  ", "claude-3-opus"));
    }

    #[test]
    fn model_limit_normalizes_thinking_budget_wildcard() {
        // A token limited to the thinking-* wildcard admits the concrete
        // thinking-budget request (Go distributor.go:72 normalizes first).
        assert!(model_allowed_for_token(
            1,
            "gemini-2.5-flash-thinking-*",
            "gemini-2.5-flash-thinking-8192"
        ));
        assert!(model_allowed_for_token(
            1,
            "gemini-2.5-pro-thinking-*",
            "gemini-2.5-pro-thinking-32768"
        ));
        assert!(model_allowed_for_token(
            1,
            "gemini-2.5-flash-lite-thinking-*",
            "gemini-2.5-flash-lite-thinking-1"
        ));
    }

    #[test]
    fn model_limit_normalizes_gizmo_wildcard() {
        assert!(model_allowed_for_token(
            1,
            "gpt-4-gizmo-*",
            "gpt-4-gizmo-g-abc"
        ));
        assert!(model_allowed_for_token(
            1,
            "gpt-4o-gizmo-*",
            "gpt-4o-gizmo-g-xyz"
        ));
    }

    #[test]
    fn model_limit_match_is_case_insensitive() {
        // csv_contains is case-insensitive; the limits map / CSV may use either.
        assert!(model_allowed_for_token(1, "GPT-4O", "gpt-4o"));
        assert!(model_allowed_for_token(1, "gpt-4o", "GPT-4O"));
    }

    #[test]
    fn csv_model_names_trim_and_deduplicate_token_limits() {
        assert_eq!(
            csv_model_names(" gpt-4o,claude-3-opus\ngpt-4o,, "),
            vec!["gpt-4o", "claude-3-opus"]
        );
    }

    #[test]
    fn openai_model_list_response_matches_go_envelope() {
        let models = vec!["gpt-4o".to_string(), "custom-model".to_string()];
        let response = model_list_response(ModelListFormat::OpenAi, &models);

        assert_eq!(response["success"], true);
        assert_eq!(response["object"], "list");
        assert_eq!(response["data"][0]["id"], "gpt-4o");
        assert_eq!(response["data"][0]["object"], "model");
        assert_eq!(response["data"][0]["created"], MODEL_OBJECT_CREATED);
        assert_eq!(response["data"][0]["owned_by"], "custom");
    }

    #[test]
    fn anthropic_and_gemini_model_lists_use_provider_shapes() {
        let models = vec![
            "claude-3-5-sonnet".to_string(),
            "gemini-2.5-pro".to_string(),
        ];
        let anthropic = model_list_response(ModelListFormat::Anthropic, &models);
        assert_eq!(anthropic["data"][0]["id"], "claude-3-5-sonnet");
        assert_eq!(anthropic["data"][0]["type"], "model");
        assert_eq!(anthropic["first_id"], "claude-3-5-sonnet");
        assert_eq!(anthropic["last_id"], "gemini-2.5-pro");
        assert_eq!(anthropic["has_more"], false);

        let gemini = model_list_response(ModelListFormat::Gemini, &models);
        assert_eq!(gemini["models"][0]["name"], "claude-3-5-sonnet");
        assert_eq!(gemini["models"][0]["displayName"], "claude-3-5-sonnet");
        assert!(gemini["nextPageToken"].is_null());
    }

    #[test]
    fn model_visibility_is_exact() {
        let models = vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()];
        assert!(model_visible(&models, "gpt-4o"));
        assert!(!model_visible(&models, "gpt-4"));
    }

    fn test_auth(token_id: i64, user_id: i64) -> AuthenticatedToken {
        AuthenticatedToken {
            token_id,
            user_id,
            token_name: "test-token".to_string(),
            token_status: 1,
            expired_time: -1,
            remain_quota: 100,
            unlimited_quota: 0,
            model_limits_enabled: 0,
            model_limits: String::new(),
            allow_ips: String::new(),
            token_group: "default".to_string(),
            username: "user".to_string(),
            user_status: 1,
            user_quota: 100,
            user_group: "default".to_string(),
        }
    }

    #[test]
    fn relay_token_rate_limit_key_scopes_playground_by_user() {
        assert_eq!(relay_token_rate_limit_key(&test_auth(42, 7)), "token:42");
        assert_eq!(
            relay_token_rate_limit_key(&test_auth(0, 7)),
            "playground-user:7"
        );
    }

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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        }
    }

    fn wav_header(channels: u16, sample_rate: u32, bits: u16, data_size: u32) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&[0, 0, 0, 0]);
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        let block_align = channels * (bits / 8);
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav
    }

    fn flac_streaminfo(sample_rate: u32, total_samples: u64) -> Vec<u8> {
        let mut flac = Vec::new();
        flac.extend_from_slice(b"fLaC");
        flac.extend_from_slice(&[0x80, 0, 0, 34]);
        let mut streaminfo = [0u8; 34];
        let packed = ((sample_rate as u64) << 44)
            | (1u64 << 41)
            | (15u64 << 36)
            | (total_samples & 0x0000_000f_ffff_ffff);
        streaminfo[10..18].copy_from_slice(&packed.to_be_bytes());
        flac.extend_from_slice(&streaminfo);
        flac
    }

    fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut element = Vec::new();
        element.extend_from_slice(id);
        element.extend_from_slice(&ebml_size(payload.len()));
        element.extend_from_slice(payload);
        element
    }

    fn ebml_size(size: usize) -> Vec<u8> {
        if size < 0x7f {
            return vec![0x80 | size as u8];
        }
        vec![0x40 | ((size >> 8) as u8), size as u8]
    }

    fn webm_duration_metadata(duration_ticks: f64) -> Vec<u8> {
        let duration = ebml_element(&[0x44, 0x89], &duration_ticks.to_bits().to_be_bytes());
        let info = ebml_element(&[0x15, 0x49, 0xa9, 0x66], &duration);
        let mut body = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &[]);
        body.extend_from_slice(&ebml_element(&[0x18, 0x53, 0x80, 0x67], &info));
        body
    }

    fn multipart_audio_body(
        boundary: &str,
        model: &str,
        file_name: &str,
        file_content_type: &str,
        file_bytes: &[u8],
    ) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
        body.extend_from_slice(model.as_bytes());
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {file_content_type}\r\n\r\n").as_bytes());
        body.extend_from_slice(file_bytes);
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        body
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
    fn relay_endpoint_body_mode_is_explicitly_json() {
        let endpoint = endpoint(true, None);

        assert!(endpoint.expects_json_request_body());
        assert_eq!(endpoint.request_body_mode.body_kind(), "JSON");
        assert_eq!(
            endpoint.request_body_mode.pending_feature().as_deref(),
            None
        );
    }

    #[test]
    fn playground_effective_group_uses_request_override_when_present() {
        assert_eq!(
            playground_effective_group(Some(&json!({"group":" vip "})), "default"),
            "vip"
        );
        assert_eq!(
            playground_effective_group(Some(&json!({"group":""})), "default"),
            "default"
        );
        assert_eq!(playground_effective_group(None, "default"), "default");
    }

    #[test]
    fn strip_playground_request_fields_removes_local_group_only() {
        let mut body = json!({
            "model": "gpt-4o-mini",
            "group": "vip",
            "messages": [{"role": "user", "content": "hi"}]
        });
        strip_playground_request_fields(&mut body);
        assert!(body.get("group").is_none());
        assert_eq!(body["model"], "gpt-4o-mini");
        assert!(body.get("messages").is_some());
    }

    #[test]
    fn request_body_modes_expose_content_type_policy() {
        assert!(RelayRequestBodyMode::Json
            .content_type_policy()
            .allows(Some("application/json")));
        assert!(RelayRequestBodyMode::MultipartForm
            .content_type_policy()
            .allows(Some("multipart/form-data; boundary=test")));
        assert!(RelayRequestBodyMode::RawBytes
            .content_type_policy()
            .allows(Some("application/octet-stream")));
        assert!(RelayRequestBodyMode::PassThroughStream
            .content_type_policy()
            .allows(Some("audio/mpeg")));
    }

    #[test]
    fn unsupported_request_body_modes_are_marked_pending() {
        assert_eq!(
            RelayRequestBodyMode::MultipartForm
                .pending_feature()
                .as_deref(),
            None
        );
        assert_eq!(
            RelayRequestBodyMode::RawBytes.pending_feature().as_deref(),
            Some("raw relay request body mode")
        );
        assert_eq!(
            RelayRequestBodyMode::PassThroughStream
                .pending_feature()
                .as_deref(),
            Some("pass-through stream relay request body mode")
        );
    }

    #[test]
    fn multipart_audio_wav_duration_feeds_prompt_estimate() {
        let mut endpoint = endpoint(false, None);
        endpoint.upstream_path = "audio/transcriptions".to_string();
        endpoint.request_body_mode = RelayRequestBodyMode::MultipartForm;
        let boundary = "audio-boundary";
        // 30 seconds, mono 16 kHz 16-bit: 16000 * 2 * 30 bytes.
        let wav = wav_header(1, 16_000, 16, 960_000);
        let body = multipart_audio_body(boundary, "whisper-1", "audio.wav", "audio/wav", &wav);
        let content_type = format!("multipart/form-data; boundary={boundary}");

        assert_eq!(
            endpoint_multipart_model(&body, &content_type),
            Some("whisper-1".to_string())
        );
        assert_eq!(
            multipart_extra_prompt_tokens(&endpoint, &body, &content_type),
            500
        );

        let params = token_params_from_request(
            "whisper-1",
            &json!({"model": "whisper-1"}),
            BillingExprVariables::default(),
            false,
            500,
        );
        assert_eq!(params.p, 500.0);
        assert_eq!(params.len, 500.0);
        assert_eq!(params.ai, 0.0);
    }

    #[test]
    fn multipart_audio_flac_duration_feeds_prompt_estimate() {
        let mut endpoint = endpoint(false, None);
        endpoint.upstream_path = "audio/translations".to_string();
        endpoint.request_body_mode = RelayRequestBodyMode::MultipartForm;
        let boundary = "audio-boundary";
        let flac = flac_streaminfo(48_000, 144_000); // 3 seconds.
        let body = multipart_audio_body(boundary, "whisper-1", "audio.flac", "audio/flac", &flac);
        let content_type = format!("multipart/form-data; boundary={boundary}");

        assert_eq!(
            endpoint_multipart_model(&body, &content_type),
            Some("whisper-1".to_string())
        );
        assert_eq!(
            multipart_extra_prompt_tokens(&endpoint, &body, &content_type),
            50
        );
    }

    #[test]
    fn multipart_audio_webm_duration_feeds_prompt_estimate() {
        let mut endpoint = endpoint(false, None);
        endpoint.upstream_path = "audio/transcriptions".to_string();
        endpoint.request_body_mode = RelayRequestBodyMode::MultipartForm;
        let boundary = "audio-boundary";
        let webm = webm_duration_metadata(42_000.0); // default scale: milliseconds.
        let body = multipart_audio_body(boundary, "whisper-1", "audio.webm", "audio/webm", &webm);
        let content_type = format!("multipart/form-data; boundary={boundary}");

        assert_eq!(
            endpoint_multipart_model(&body, &content_type),
            Some("whisper-1".to_string())
        );
        assert_eq!(
            multipart_extra_prompt_tokens(&endpoint, &body, &content_type),
            700
        );
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
                other_info: String::new(),
                priority: 0,
                weight: 0,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
                other_info: String::new(),
                priority: 0,
                weight: 0,
            }),
            "https://api.openai.com/v1/audio/speech"
        );
    }

    #[test]
    fn rerank_endpoint_uses_rerank_channel_family() {
        let endpoint = RelayEndpoint {
            display_name: "rerank",
            cache_family: "rerank",
            upstream_path: "rerank".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supported_channel_types: RERANK_CHANNEL_TYPES,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: Some("streaming rerank relay"),
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: Some(validate_rerank_request),
        };
        let body = json!({
            "model": "jina-reranker-v2-base-multilingual",
            "query": "rust relay",
            "documents": ["doc one", "doc two"],
            "top_n": 2,
            "return_documents": true
        });

        assert_eq!(endpoint.cache_family, "rerank");
        assert_eq!(endpoint.supported_channel_types, RERANK_CHANNEL_TYPES);
        assert!(!endpoint.should_relay_stream(&body));
        assert_eq!(endpoint.stream_not_implemented(&body), None);
        assert!(endpoint.parse_non_stream_usage);
        assert_eq!((endpoint.request_validator.unwrap())(&body), None);
        assert_eq!(
            endpoint.stream_not_implemented(&json!({
                "model": "jina-reranker-v2-base-multilingual",
                "query": "rust relay",
                "documents": ["doc one"],
                "stream": true
            })),
            Some("streaming rerank relay")
        );
        assert_eq!(
            endpoint.upstream_url(&RelayChannel {
                id: 38,
                name: "jina".to_string(),
                channel_type: 38,
                key: "jina-test".to_string(),
                base_url: None,
                models: "jina-reranker-v2-base-multilingual".to_string(),
                channel_group: "default".to_string(),
                model_mapping: None,
                openai_organization: None,
                other_info: String::new(),
                priority: 0,
                weight: 0,
            }),
            "https://api.jina.ai/v1/rerank"
        );
        assert_eq!(
            endpoint.upstream_url(&RelayChannel {
                id: 34,
                name: "cohere".to_string(),
                channel_type: CHANNEL_TYPE_COHERE,
                key: "cohere-test".to_string(),
                base_url: None,
                models: "rerank-english-v3.0".to_string(),
                channel_group: "default".to_string(),
                model_mapping: None,
                openai_organization: None,
                other_info: String::new(),
                priority: 0,
                weight: 0,
            }),
            "https://api.cohere.ai/v1/rerank"
        );
    }

    #[test]
    fn rerank_request_validation_requires_query_and_documents() {
        assert_eq!(
            validate_rerank_request(&json!({"documents": ["doc"]})),
            Some("rerank request body must include a non-empty query")
        );
        assert_eq!(
            validate_rerank_request(&json!({"query": "   ", "documents": ["doc"]})),
            Some("rerank request body must include a non-empty query")
        );
        assert_eq!(
            validate_rerank_request(&json!({"query": "rust"})),
            Some("rerank request body must include non-empty documents")
        );
        assert_eq!(
            validate_rerank_request(&json!({"query": "rust", "documents": []})),
            Some("rerank request body must include non-empty documents")
        );
        assert_eq!(
            validate_rerank_request(&json!({
                "query": "rust",
                "documents": ["doc"],
                "top_n": 2.5
            })),
            Some("rerank request top_n must be an integer")
        );
        assert_eq!(
            validate_rerank_request(&json!({
                "query": "rust",
                "documents": ["doc"],
                "top_n": null
            })),
            None
        );
        assert_eq!(
            validate_rerank_request(&json!({"query": "rust", "documents": ["doc"]})),
            None
        );
    }

    #[test]
    fn cohere_rerank_request_transform_uses_go_compatible_shape() {
        let channel = RelayChannel {
            id: 34,
            name: "cohere".to_string(),
            channel_type: CHANNEL_TYPE_COHERE,
            key: "cohere-test".to_string(),
            base_url: None,
            models: "rerank-english-v3.0".to_string(),
            channel_group: "default".to_string(),
            model_mapping: None,
            openai_organization: None,
            other_info: String::new(),
            priority: 0,
            weight: 0,
        };
        let mut body = json!({
            "model": "rerank-english-v3.0",
            "query": "rust relay",
            "documents": ["doc one", {"text": "doc two"}],
            "top_n": 2,
            "return_documents": false,
            "max_chunk_per_doc": 4,
            "stream": false
        });

        apply_endpoint_request_transform(&mut body, "rerank", &channel);

        assert_eq!(
            body,
            json!({
                "model": "rerank-english-v3.0",
                "query": "rust relay",
                "documents": ["doc one", {"text": "doc two"}],
                "top_n": 2,
                "return_documents": true
            })
        );
    }

    #[test]
    fn cohere_rerank_request_transform_defaults_top_n_to_one() {
        let mut body = json!({
            "model": "rerank-english-v3.0",
            "query": "rust relay",
            "documents": ["doc one"],
            "top_n": -1
        });

        apply_cohere_rerank_request_transform(&mut body);

        assert_eq!(body["top_n"], json!(1));
        assert_eq!(body["return_documents"], json!(true));
    }

    #[test]
    fn non_cohere_rerank_request_transform_preserves_body() {
        let channel = RelayChannel {
            id: 38,
            name: "jina".to_string(),
            channel_type: 38,
            key: "jina-test".to_string(),
            base_url: None,
            models: "jina-reranker-v2-base-multilingual".to_string(),
            channel_group: "default".to_string(),
            model_mapping: None,
            openai_organization: None,
            other_info: String::new(),
            priority: 0,
            weight: 0,
        };
        let mut body = json!({
            "model": "jina-reranker-v2-base-multilingual",
            "query": "rust relay",
            "documents": ["doc one"],
            "return_documents": false
        });
        let original = body.clone();

        apply_endpoint_request_transform(&mut body, "rerank", &channel);

        assert_eq!(body, original);
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
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
    fn relay_retry_config_defaults_to_no_retries() {
        // Absent or empty env var keeps the historical single-attempt behavior.
        let config = RelayRetryConfig::from_raw(None).unwrap();
        assert_eq!(config.retry_times, 0);
        assert_eq!(config.max_attempts(), 1);
        let config = RelayRetryConfig::from_raw(Some("   ".to_string())).unwrap();
        assert_eq!(config.retry_times, 0);
        assert_eq!(config.max_attempts(), 1);
    }

    #[test]
    fn relay_retry_config_accepts_positive_retry_times() {
        let config = RelayRetryConfig::from_raw(Some("3".to_string())).unwrap();
        assert_eq!(config.retry_times, 3);
        assert_eq!(config.max_attempts(), 4);
    }

    #[test]
    fn relay_retry_config_rejects_invalid_retry_times() {
        assert!(RelayRetryConfig::from_raw(Some("-1".to_string())).is_err());
        assert!(RelayRetryConfig::from_raw(Some("soon".to_string())).is_err());
        assert!(RelayRetryConfig::from_raw(Some("1.5".to_string())).is_err());
    }

    #[test]
    fn channel_auto_ban_threshold_falls_back_when_env_missing() {
        // No Env available in pure unit tests; the helper reads `Env::var` at
        // runtime via `optional_env_var`, which we cannot exercise without a
        // live Worker binding. The constant default is checked here instead.
        assert_eq!(CHANNEL_AUTO_BAN_WINDOW_SECONDS, 60);
    }

    #[test]
    fn relay_attempt_failure_records_correct_kind() {
        let fetch =
            RelayAttemptFailure::fetch_error(7, "alpha".to_string(), "tcp reset".to_string());
        assert_eq!(fetch.kind, RelayAttemptFailureKind::FetchError);
        assert_eq!(fetch.channel_id, 7);

        let no_key = RelayAttemptFailure::no_key(9, "beta".to_string());
        assert_eq!(no_key.kind, RelayAttemptFailureKind::NoUsableKey);

        let status = RelayAttemptFailure::retryable_status(11, "gamma".to_string(), 500);
        assert_eq!(status.kind, RelayAttemptFailureKind::RetryableStatus);
    }

    #[test]
    fn relay_json_body_config_defaults_to_bounded_payloads() {
        let config = RelayJsonBodyConfig::from_raw(None).unwrap();
        assert_eq!(config.max_bytes, DEFAULT_RELAY_JSON_BODY_LIMIT_BYTES);
    }

    #[test]
    fn relay_json_body_config_accepts_positive_limit() {
        let config = RelayJsonBodyConfig::from_raw(Some("1024".to_string())).unwrap();
        assert_eq!(config.max_bytes, 1024);
    }

    #[test]
    fn relay_json_body_config_rejects_zero_and_invalid_limits() {
        assert_eq!(
            RelayJsonBodyConfig::from_raw(Some("0".to_string())).unwrap_err(),
            "RELAY_JSON_BODY_LIMIT_BYTES must be greater than 0"
        );
        assert_eq!(
            RelayJsonBodyConfig::from_raw(Some("huge".to_string())).unwrap_err(),
            "RELAY_JSON_BODY_LIMIT_BYTES must be a positive integer"
        );
    }

    #[test]
    fn relay_json_response_config_defaults_to_bounded_payloads() {
        let config = RelayJsonResponseConfig::from_raw(None).unwrap();
        assert_eq!(config.max_bytes_override, None);
        assert_eq!(
            config.max_bytes_for(&endpoint(false, None)),
            DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES
        );
    }

    #[test]
    fn relay_json_response_config_accepts_global_override() {
        let config = RelayJsonResponseConfig::from_raw(Some("2048".to_string())).unwrap();
        assert_eq!(config.max_bytes_override, Some(2048));

        let mut endpoint = endpoint(false, None);
        endpoint.upstream_path = "embeddings".to_string();
        assert_eq!(config.max_bytes_for(&endpoint), 2048);
    }

    #[test]
    fn relay_json_response_config_rejects_zero_and_invalid_limits() {
        assert_eq!(
            RelayJsonResponseConfig::from_raw(Some("0".to_string())).unwrap_err(),
            "RELAY_JSON_RESPONSE_LIMIT_BYTES must be greater than 0"
        );
        assert_eq!(
            RelayJsonResponseConfig::from_raw(Some("huge".to_string())).unwrap_err(),
            "RELAY_JSON_RESPONSE_LIMIT_BYTES must be a positive integer"
        );
    }

    #[test]
    fn relay_json_response_config_uses_endpoint_defaults_without_override() {
        let config = RelayJsonResponseConfig::from_raw(None).unwrap();

        let mut endpoint = endpoint(false, None);
        endpoint.upstream_path = "embeddings".to_string();
        assert_eq!(
            config.max_bytes_for(&endpoint),
            EMBEDDINGS_JSON_RESPONSE_LIMIT_BYTES
        );

        endpoint.upstream_path = "images/generations".to_string();
        assert_eq!(
            config.max_bytes_for(&endpoint),
            IMAGE_JSON_RESPONSE_LIMIT_BYTES
        );

        endpoint.upstream_path = "rerank".to_string();
        assert_eq!(
            config.max_bytes_for(&endpoint),
            RERANK_JSON_RESPONSE_LIMIT_BYTES
        );

        endpoint.provider = RelayProviderKind::GeminiNative;
        endpoint.cache_family = "gemini";
        assert_eq!(
            config.max_bytes_for(&endpoint),
            GEMINI_JSON_RESPONSE_LIMIT_BYTES
        );
    }

    #[test]
    fn json_model_fallback_only_fills_missing_legacy_engine_model() {
        let mut missing = json!({"input": "hello"});
        apply_json_model_fallback(&mut missing, " text-embedding-3-small ");
        assert_eq!(missing["model"], "text-embedding-3-small");

        let mut empty = json!({"model": " ", "input": "hello"});
        apply_json_model_fallback(&mut empty, "text-embedding-3-small");
        assert_eq!(empty["model"], "text-embedding-3-small");

        let mut explicit = json!({"model": "body-model", "input": "hello"});
        apply_json_model_fallback(&mut explicit, "path-model");
        assert_eq!(explicit["model"], "body-model");

        let mut non_object = json!(["not", "an", "object"]);
        apply_json_model_fallback(&mut non_object, "path-model");
        assert_eq!(non_object, json!(["not", "an", "object"]));
    }

    #[test]
    fn relay_body_read_error_reports_payload_too_large() {
        let err = RelayBodyReadError::TooLarge {
            actual_bytes: Some(17),
            max_bytes: 16,
        };

        assert_eq!(err.status_code(), 413);
        assert_eq!(
            err.message("chat completions", "JSON"),
            "chat completions JSON request body is too large: 17 bytes exceeds 16 byte limit"
        );
        assert_eq!(
            err.message("audio transcriptions", "multipart"),
            "audio transcriptions multipart request body is too large: 17 bytes exceeds 16 byte limit"
        );
    }

    #[test]
    fn relay_json_body_error_delegates_read_errors() {
        let err = RelayJsonBodyError::from(RelayBodyReadError::TooLarge {
            actual_bytes: Some(17),
            max_bytes: 16,
        });

        assert_eq!(err.status_code(), 413);
        assert_eq!(
            err.message("chat completions"),
            "chat completions JSON request body is too large: 17 bytes exceeds 16 byte limit"
        );
    }

    #[test]
    fn content_type_policy_accepts_json_media_types() {
        let policy = RelayContentTypePolicy::json();

        assert!(policy.allows(None));
        assert!(policy.allows(Some("application/json")));
        assert!(policy.allows(Some("application/json; charset=utf-8")));
        assert!(policy.allows(Some("Application/Problem+JSON")));

        assert!(!policy.allows(Some("text/plain")));
        assert!(!policy.allows(Some("multipart/form-data; boundary=test")));
        assert!(!policy.allows(Some("application/octet-stream")));
    }

    #[test]
    fn content_type_policy_accepts_multipart_only_when_explicit() {
        let policy = RelayContentTypePolicy::multipart();

        assert!(policy.allows(Some("multipart/form-data; boundary=test")));
        assert!(!policy.allows(None));
        assert!(!policy.allows(Some("application/json")));

        let err = validate_content_type_value(None, policy).unwrap_err();
        assert_eq!(err.status_code(), 415);
        assert_eq!(
            err.message("audio transcriptions", "multipart"),
            "unsupported audio transcriptions multipart request body content-type: <absent>; expected multipart/form-data"
        );
    }

    #[test]
    fn content_type_policy_can_allow_raw_passthrough() {
        let policy = RelayContentTypePolicy::any();

        assert!(policy.allows(None));
        assert!(policy.allows(Some("application/octet-stream")));
        assert!(policy.allows(Some("audio/mpeg")));
        assert!(policy.allows(Some("multipart/form-data; boundary=test")));
    }

    #[test]
    fn relay_json_body_error_reports_unsupported_content_type() {
        let err = RelayJsonBodyError::ContentType(RelayContentTypeError::Unsupported {
            actual: "multipart/form-data; boundary=test".to_string(),
            expected: "application/json or application/*+json",
        });

        assert_eq!(err.status_code(), 415);
        assert_eq!(
            err.message("chat completions"),
            "unsupported chat completions JSON request body content-type: multipart/form-data; boundary=test; expected application/json or application/*+json"
        );
    }

    #[test]
    fn parse_relay_json_bytes_enforces_size_limit() {
        assert_eq!(
            parse_relay_json_bytes(br#"{"model":"gpt-test"}"#, 64).unwrap()["model"],
            json!("gpt-test")
        );

        let err = parse_relay_json_bytes(br#"{"model":"gpt-test"}"#, 4).unwrap_err();
        assert_eq!(
            err,
            RelayJsonBodyError::Read(RelayBodyReadError::TooLarge {
                actual_bytes: Some(20),
                max_bytes: 4
            })
        );
        assert_eq!(err.status_code(), 413);
    }

    #[test]
    fn parse_relay_json_bytes_reports_invalid_json() {
        let err = parse_relay_json_bytes(br#"{"model":"gpt-test""#, 64).unwrap_err();

        assert_eq!(err.status_code(), 400);
        assert!(err
            .message("chat completions")
            .contains("invalid chat completions request body"));
    }

    #[test]
    fn decode_limited_text_bytes_enforces_size_limit_without_consuming_fixed_body() {
        assert_eq!(
            decode_limited_text_bytes(br#"{"ok":true}"#, 32, false).unwrap(),
            r#"{"ok":true}"#
        );

        let err = decode_limited_text_bytes(br#"{"ok":true}"#, 4, false).unwrap_err();
        assert_eq!(
            err,
            RelayBufferedTextError::TooLarge {
                actual_bytes: Some(11),
                max_bytes: 4,
                body_consumed: false
            }
        );
        assert!(!err.body_consumed());
    }

    #[test]
    fn relay_buffered_text_error_marks_stream_limit_as_consumed() {
        let err = RelayBufferedTextError::TooLarge {
            actual_bytes: Some(17),
            max_bytes: 16,
            body_consumed: true,
        };

        assert!(err.body_consumed());
        assert_eq!(
            err.message("relay response body"),
            "relay response body is too large: 17 bytes exceeds 16 byte limit"
        );
    }

    #[test]
    fn usage_summary_converts_to_basic_token_params() {
        let snapshot = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p + c)"#,
            1.0,
            &json!({}),
            RequestInput::default(),
            true,
            0,
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
    fn rerank_endpoint_uses_rerank_usage_parser() {
        assert_eq!(
            usage_summary_for_provider(
                r#"{"usage":{"total_tokens":21}}"#,
                RelayProviderKind::OpenAiCompatible,
                "rerank"
            ),
            UsageSummary {
                prompt_tokens: 21,
                total_tokens: 21,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_for_provider(
                r#"{"meta":{"billed_units":{"input_tokens":34,"output_tokens":2}}}"#,
                RelayProviderKind::OpenAiCompatible,
                "rerank"
            ),
            UsageSummary {
                prompt_tokens: 34,
                completion_tokens: 2,
                total_tokens: 36,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_for_provider(
                r#"{"meta":{"billed_units":{"search_units":1}}}"#,
                RelayProviderKind::OpenAiCompatible,
                "rerank"
            ),
            UsageSummary {
                prompt_tokens: 1,
                total_tokens: 1,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            usage_summary_for_provider(
                r#"{"usage":{"total_tokens":21}}"#,
                RelayProviderKind::OpenAiCompatible,
                "chat/completions"
            ),
            UsageSummary {
                total_tokens: 21,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn cohere_rerank_response_transform_outputs_unified_usage() {
        let (body, usage) = transform_cohere_rerank_response_body(
            r#"{"results":[{"index":0,"relevance_score":0.99,"document":{"text":"doc"}}],"meta":{"billed_units":{"input_tokens":34,"output_tokens":2}}}"#,
            0,
        )
        .expect("valid Cohere rerank response");
        let value = serde_json::from_str::<Value>(&body).expect("transformed JSON");

        assert_eq!(value["results"][0]["index"], json!(0));
        assert_eq!(value["usage"]["prompt_tokens"], json!(34));
        assert_eq!(value["usage"]["completion_tokens"], json!(2));
        assert_eq!(value["usage"]["total_tokens"], json!(36));
        assert_eq!(
            usage,
            UsageSummary {
                prompt_tokens: 34,
                completion_tokens: 2,
                total_tokens: 36,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn cohere_rerank_response_transform_falls_back_to_request_estimate() {
        let (body, usage) = transform_cohere_rerank_response_body(
            r#"{"results":[{"index":0,"relevance_score":0.99}],"meta":{"billed_units":{"input_tokens":0,"output_tokens":9}}}"#,
            17,
        )
        .expect("valid Cohere rerank response");
        let value = serde_json::from_str::<Value>(&body).expect("transformed JSON");

        assert_eq!(value["usage"]["prompt_tokens"], json!(17));
        assert_eq!(value["usage"]["completion_tokens"], json!(0));
        assert_eq!(value["usage"]["total_tokens"], json!(17));
        assert_eq!(
            usage,
            UsageSummary {
                prompt_tokens: 17,
                total_tokens: 17,
                ..UsageSummary::default()
            }
        );
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

        assert_eq!(estimate_prompt_tokens_from_request(&body, true), 21);
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

        let estimate = request_token_estimate_from_body(&body, true);

        // Default model gpt-4o, no `stream` field (non-stream): Go's getImageToken
        // returns 3*baseTokens (3*85) before any fetch, so the remote image is
        // counted without egress. Audio/video/file keep the flat fallbacks.
        let non_stream_image = 3 * 85;
        assert_eq!(estimate.text_prompt_tokens, 9);
        assert_eq!(estimate.image_input_tokens, non_stream_image);
        assert_eq!(estimate.audio_input_tokens, ESTIMATED_AUDIO_INPUT_TOKENS);
        assert_eq!(estimate.file_input_tokens, ESTIMATED_FILE_INPUT_TOKENS);
        assert_eq!(estimate.video_input_tokens, 0);
        assert_eq!(
            estimate.prompt_tokens(),
            9 + non_stream_image + ESTIMATED_AUDIO_INPUT_TOKENS + ESTIMATED_FILE_INPUT_TOKENS
        );

        let params =
            token_params_from_request("gpt-4o", &body, BillingExprVariables::default(), true, 0);
        assert_eq!(params.p, estimate.prompt_tokens() as f64);
        assert_eq!(params.len, estimate.prompt_tokens() as f64);
        assert_eq!(params.img, non_stream_image as f64);
        assert_eq!(params.ai, ESTIMATED_AUDIO_INPUT_TOKENS as f64);

        let detail_params = token_params_from_request(
            "gpt-4o",
            &body,
            BillingExprVariables {
                img: true,
                ai: true,
                ..BillingExprVariables::default()
            },
            true,
            0,
        );
        assert_eq!(
            detail_params.p,
            (estimate.text_prompt_tokens + estimate.file_input_tokens) as f64
        );
        assert_eq!(detail_params.len, estimate.prompt_tokens() as f64);
        assert_eq!(detail_params.img, non_stream_image as f64);
        assert_eq!(detail_params.ai, ESTIMATED_AUDIO_INPUT_TOKENS as f64);
    }

    fn test_channel(id: i64, priority: i64, weight: i32) -> RelayChannel {
        RelayChannel {
            id,
            channel_type: 1,
            key: format!("sk-{id}"),
            name: format!("c{id}"),
            base_url: None,
            models: String::new(),
            channel_group: String::new(),
            model_mapping: None,
            openai_organization: None,
            other_info: String::new(),
            priority,
            weight,
        }
    }

    fn ai_gateway_runtime_for_tests() -> RelayAiGatewayRuntime {
        RelayAiGatewayRuntime::from_values(
            true,
            Some("acct123".to_string()),
            Some("default".to_string()),
            Some("cf-token".to_string()),
        )
        .unwrap()
    }

    fn ai_gateway_chat_endpoint_for_tests() -> RelayEndpoint {
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
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        }
    }

    #[test]
    fn relay_ai_gateway_runtime_requires_gate_and_complete_config() {
        assert!(RelayAiGatewayRuntime::from_values(
            false,
            Some("acct".to_string()),
            Some("gw".to_string()),
            Some("token".to_string())
        )
        .is_none());
        assert!(RelayAiGatewayRuntime::from_values(
            true,
            None,
            Some("gw".to_string()),
            Some("token".to_string())
        )
        .is_none());
        assert!(RelayAiGatewayRuntime::from_values(
            true,
            Some("acct".to_string()),
            None,
            Some("token".to_string())
        )
        .is_none());
        assert!(RelayAiGatewayRuntime::from_values(
            true,
            Some("acct".to_string()),
            Some("gw".to_string()),
            None
        )
        .is_none());

        let runtime = RelayAiGatewayRuntime::from_values(
            true,
            Some(" acct ".to_string()),
            Some(" gw ".to_string()),
            Some(" token ".to_string()),
        )
        .unwrap();
        assert_eq!(runtime.account_id, "acct");
        assert_eq!(runtime.gateway_id, "gw");
        assert_eq!(runtime.api_token, "token");
    }

    #[test]
    fn relay_ai_gateway_attempt_requires_channel_opt_in_and_prefixed_model() {
        let runtime = ai_gateway_runtime_for_tests();
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut channel = test_channel(1, 0, 1);

        assert!(
            plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "openai/gpt-4.1")
                .unwrap()
                .is_none()
        );

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(
            plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "gpt-4.1")
                .unwrap()
                .is_none()
        );

        let attempt =
            plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "openai/gpt-4.1")
                .unwrap()
                .unwrap();
        assert_eq!(
            attempt.url,
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions"
        );
        assert!(!attempt.plan.requires_gateway_id_header);
    }

    #[test]
    fn relay_ai_gateway_attempt_keeps_custom_base_url_direct() {
        let runtime = ai_gateway_runtime_for_tests();
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut channel = test_channel(1, 0, 1);
        channel.other_info = r#"{"ai_gateway":true}"#.to_string();
        channel.base_url = Some("https://custom.example/v1".to_string());

        assert!(
            plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "openai/gpt-4.1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn relay_ai_gateway_attempt_rejects_unsupported_endpoint() {
        let runtime = ai_gateway_runtime_for_tests();
        let mut endpoint = ai_gateway_chat_endpoint_for_tests();
        endpoint.upstream_path = "embeddings".to_string();
        let mut channel = test_channel(1, 0, 1);
        channel.other_info = r#"{"ai_gateway":true}"#.to_string();

        assert!(plan_relay_ai_gateway_attempt(
            &runtime,
            &endpoint,
            &channel,
            "openai/text-embedding-3-small"
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn relay_ai_gateway_direct_fallback_uses_retryable_status_table() {
        for status in [100, 302, 401, 403, 429, 500, 502, 503, 523, 525, 599] {
            assert!(
                should_ai_gateway_direct_fallback(status),
                "{status} should fall back to direct provider"
            );
        }

        for status in [200, 201, 204, 400, 408, 504, 524] {
            assert!(
                !should_ai_gateway_direct_fallback(status),
                "{status} should keep the AI Gateway response"
            );
        }
    }

    #[test]
    fn plan_single_group_walks_priority_tiers_with_shrink() {
        // Distinct priorities 10/5/1: retry index walks tiers high->low, and the
        // pool shrinks so each channel is tried once (the prior inline behavior).
        let pools = vec![(
            "g".to_string(),
            vec![
                test_channel(1, 10, 1),
                test_channel(2, 5, 1),
                test_channel(3, 1, 1),
            ],
        )];
        let plan = plan_relay_attempts(pools, false, 3, 2, false, |_| Ok(0)).unwrap();
        let ids: Vec<i64> = plan.iter().map(|p| p.channel.id).collect();
        // attempt 0 -> tier 0 = p10 (ch1); after the shrink the remaining
        // distinct priorities are [5,1], so attempt 1 (tier index 1) hits p1
        // (ch3); attempt 2 clamps to the last remaining tier (ch2). This matches
        // the prior inline select_weighted + pool-shrink behavior exactly.
        assert_eq!(ids, vec![1, 3, 2]);
        assert!(plan.iter().all(|p| p.group == "g"));
    }

    #[test]
    fn plan_single_group_respects_max_attempts() {
        let pools = vec![(
            "g".to_string(),
            vec![test_channel(1, 1, 1), test_channel(2, 1, 1)],
        )];
        // max_attempts = 1 -> only one planned attempt despite two channels.
        let plan = plan_relay_attempts(pools, false, 1, 0, false, |_| Ok(0)).unwrap();
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn plan_auto_advances_group_after_each_priority_when_cross_group() {
        let pools = vec![
            ("g0".to_string(), vec![test_channel(1, 0, 1)]),
            ("g1".to_string(), vec![test_channel(2, 0, 1)]),
        ];
        // retry_times = 0 (max_attempts = 1); cross_group_retry advances each
        // attempt. The plan spans BOTH groups despite max_attempts=1 because auto
        // gives each group its own budget (not a global cap).
        let plan = plan_relay_attempts(pools, true, 1, 0, true, |_| Ok(0)).unwrap();
        let trace: Vec<(&str, i64)> = plan
            .iter()
            .map(|p| (p.group.as_str(), p.channel.id))
            .collect();
        assert_eq!(trace, vec![("g0", 1), ("g1", 2)]);
    }

    #[test]
    fn plan_auto_gives_each_group_its_own_retry_budget() {
        // Go resets the retry counter on group advance, so each group gets
        // RetryTimes+1 attempts. g0 has two priority tiers (consumes retry 0 and
        // 1, then arms the advance at retry>=RetryTimes=1); g1 is then reached.
        let pools = vec![
            (
                "g0".to_string(),
                vec![test_channel(1, 10, 1), test_channel(2, 5, 1)],
            ),
            ("g1".to_string(), vec![test_channel(3, 0, 1)]),
        ];
        // max_attempts = retry_times + 1 = 2 (the single-group cap); auto must
        // still reach g1 — a global cap of 2 would have stopped at g0.
        let plan = plan_relay_attempts(pools, true, 2, 1, true, |_| Ok(0)).unwrap();
        let trace: Vec<(&str, i64)> = plan
            .iter()
            .map(|p| (p.group.as_str(), p.channel.id))
            .collect();
        assert_eq!(trace, vec![("g0", 1), ("g0", 2), ("g1", 3)]);
    }

    #[test]
    fn plan_auto_skips_a_group_with_no_channels() {
        let pools = vec![
            ("g0".to_string(), vec![]),
            ("g1".to_string(), vec![test_channel(2, 0, 1)]),
        ];
        let plan = plan_relay_attempts(pools, true, 4, 3, true, |_| Ok(0)).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].group, "g1");
        assert_eq!(plan[0].channel.id, 2);
    }

    #[test]
    fn relay_random_below_stays_inside_total() {
        for total in [1u64, 2, 10, 1_000, u64::from(u32::MAX) + 7] {
            for _ in 0..16 {
                let value = random_u64_below(total).unwrap();
                assert!(value < total, "{value} should be below {total}");
            }
        }
    }

    #[test]
    fn plan_relay_attempts_propagates_rng_errors() {
        let pools = vec![(
            "g".to_string(),
            vec![test_channel(1, 1, 1), test_channel(2, 1, 1)],
        )];
        let result = plan_relay_attempts(pools, false, 1, 0, false, |_| {
            Err(worker::Error::RustError("rng failed".to_string()))
        });
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(format!("{err:?}").contains("rng failed"));
    }

    fn encode_base64_bytes(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = chunk.get(1).copied().unwrap_or_default() as u32;
            let b2 = chunk.get(2).copied().unwrap_or_default() as u32;
            let bits = (b0 << 16) | (b1 << 8) | b2;
            out.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
            out.push(if chunk.len() > 1 {
                TABLE[((bits >> 6) & 0x3f) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[(bits & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    fn png_data_url(width: u32, height: u32) -> String {
        let mut data = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]); // IHDR length
        data.extend_from_slice(b"IHDR");
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&[8, 6, 0, 0, 0]);
        format!("data:image/png;base64,{}", encode_base64_bytes(&data))
    }

    #[test]
    fn inline_openai_image_uses_tile_based_image_tokens() {
        // 512x256 inline PNG, streaming gpt-4o (tile base 85, tile 170): fit
        // <=2048; scale shortest side 256 -> 768 (x3) => 1536x768 => 3x2=6 tiles
        // => 6*170 + 85 = 1105 (not the flat 520).
        let body = json!({
            "stream": true,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "abcdefgh"},
                    {"type": "image_url", "image_url": {"url": png_data_url(512, 256), "detail": "high"}}
                ]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, 1105);
        assert_ne!(estimate.image_input_tokens, ESTIMATED_IMAGE_INPUT_TOKENS);
    }

    #[test]
    fn inline_openai_image_non_stream_uses_three_base_tokens() {
        // Non-stream with GET_MEDIA_TOKEN_NOT_STREAM=false -> Go 3*baseTokens.
        let body = json!({
            "stream": false,
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": png_data_url(512, 256)}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, 3 * 85);
    }

    #[test]
    fn inline_openai_image_detail_low_uses_base_tokens() {
        let body = json!({
            "stream": true,
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": png_data_url(512, 256), "detail": "low"}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, 85);
    }

    #[test]
    fn inline_image_non_openai_model_uses_flat_estimate() {
        // Non-OpenAI models add a flat 520 per image (Go's else branch), even
        // with decodable inline dimensions.
        let body = json!({
            "stream": true,
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": png_data_url(512, 256), "detail": "high"}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("claude-3-5-sonnet", &body, true);
        assert_eq!(estimate.image_input_tokens, ESTIMATED_IMAGE_INPUT_TOKENS);
    }

    #[test]
    fn remote_image_non_stream_uses_three_base_tokens_without_fetch() {
        // gpt-4o, remote URL (no inline bytes), non-stream: Go short-circuits to
        // 3*baseTokens before fetching, so the estimate matches with no egress.
        let body = json!({
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.test/cat.png"}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, 3 * 85);
    }

    #[test]
    fn remote_image_detail_low_uses_base_tokens_without_fetch() {
        // detail=low short-circuits to baseTokens before any fetch.
        let body = json!({
            "stream": true,
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.test/cat.png", "detail": "low"}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, 85);
    }

    #[test]
    fn remote_image_stream_high_detail_falls_back_to_flat_estimate() {
        // Stream + high detail genuinely needs pixels; the remote URL is not
        // fetched in preflight, so it falls back to the flat per-image estimate.
        let body = json!({
            "stream": true,
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.test/cat.png", "detail": "high"}}]
            }]
        });
        let estimate = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        assert_eq!(estimate.image_input_tokens, ESTIMATED_IMAGE_INPUT_TOKENS);
    }

    #[test]
    fn anthropic_format_skips_openai_chat_overhead() {
        // Anthropic /v1/messages requests also carry a `messages` array, but Go
        // adds the tools*8 + messages*3 + name*3 + 3 overhead only for the
        // OpenAI chat format. With is_openai_chat=false it must be omitted; the
        // text count itself is identical, so the difference is exactly the
        // overhead (1*8 + 2*3 + 1*3 + 3 = 20).
        let body = json!({
            "messages": [
                {"role": "user", "name": "alice", "content": "abcdefgh"},
                {"role": "assistant", "content": "ijklmnop"}
            ],
            "tools": [{"type": "function", "function": {"name": "f", "description": "d"}}]
        });
        let openai = request_token_estimate_from_body_for_model("gpt-4o", &body, true);
        let anthropic = request_token_estimate_from_body_for_model("gpt-4o", &body, false);
        assert_eq!(openai.text_prompt_tokens - anthropic.text_prompt_tokens, 20);
    }

    #[test]
    fn request_prompt_estimate_counts_rerank_query_and_documents() {
        let body = json!({
            "model": "jina-reranker-v2-base-multilingual",
            "query": "abcdefgh",
            "documents": ["ijklmnop", "qrst"],
            "top_n": 2
        });

        assert_eq!(estimate_prompt_tokens_from_request(&body, false), 5);
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

        let estimate = request_token_estimate_from_body(&body, false);

        // Default model gpt-4o, non-stream: the inline PNG bytes here are not a
        // real header (all-zero), but the non-stream short-circuit returns
        // 3*baseTokens (3*85) before decoding, matching Go. Audio/video/file
        // keep the flat fallbacks.
        let non_stream_image = 3 * 85;
        assert_eq!(estimate.text_prompt_tokens, 2);
        assert_eq!(estimate.image_input_tokens, non_stream_image);
        assert_eq!(estimate.audio_input_tokens, ESTIMATED_AUDIO_INPUT_TOKENS);
        assert_eq!(estimate.video_input_tokens, ESTIMATED_VIDEO_INPUT_TOKENS);
        assert_eq!(estimate.file_input_tokens, ESTIMATED_FILE_INPUT_TOKENS);
        assert_eq!(
            estimate.prompt_tokens(),
            2 + non_stream_image
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
            true,
            0,
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
    fn tiered_billing_preflight_normalizes_request_media_for_expression_variables() {
        let request_body = json!({
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "abcdefgh"},
                        {"type": "image_url", "image_url": {"url": "https://example.test/cat.png"}},
                        {"type": "input_audio", "input_audio": {"data": "A".repeat(4096), "format": "wav"}}
                    ]
                }
            ],
            "max_completion_tokens": 100
        });
        let request = RequestInput::from_json_body(request_body.clone());
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("detail", p * 2 + c * 10 + img * 3 + ai * 4)"#,
            1.0,
            &request_body,
            request,
            true,
            0,
        )
        .unwrap();

        let estimated_text_prompt = 9.0;
        // Remote image, non-stream, OpenAI base model (85): 3*baseTokens, matching
        // Go's pre-fetch short-circuit (no egress).
        let estimated_image = (3 * 85) as f64;
        let estimated_prompt =
            estimated_text_prompt + estimated_image + ESTIMATED_AUDIO_INPUT_TOKENS as f64;
        let estimated_cost = (estimated_text_prompt * 2.0)
            + (100.0 * 10.0)
            + (estimated_image * 3.0)
            + (ESTIMATED_AUDIO_INPUT_TOKENS as f64 * 4.0);

        assert_eq!(
            preflight.snapshot.estimated_prompt_tokens,
            estimated_text_prompt as i64
        );
        assert_eq!(preflight.snapshot.estimated_completion_tokens, 100);
        assert_eq!(preflight.snapshot.estimated_expression_cost, estimated_cost);
        assert_eq!(
            preflight.pre_consumed_quota,
            // quota_round: round half away from zero, matching Go QuotaRound.
            (estimated_cost / 1_000_000.0 * 500_000.0).round() as i64
        );

        let params = token_params_from_request(
            "gpt-4o",
            &request_body,
            BillingExprVariables {
                img: true,
                ai: true,
                ..BillingExprVariables::default()
            },
            true,
            0,
        );
        assert_eq!(params.p, estimated_text_prompt);
        assert_eq!(params.len, estimated_prompt);
        assert_eq!(params.img, estimated_image);
        assert_eq!(params.ai, ESTIMATED_AUDIO_INPUT_TOKENS as f64);
    }

    #[test]
    fn tiered_billing_settlement_uses_frozen_preflight_snapshot() {
        // A realistic space-separated prompt so the token estimator (the Go
        // per-rune state machine in `crates/tokenizer`) yields a stable,
        // meaningful count: 1000 "word" tokens → ~1440 estimated tokens.
        let prompt = (0..1000).map(|_| "word").collect::<Vec<_>>().join(" ");
        let request_body = json!({
            "prompt": prompt,
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
            true,
            0,
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
        // With the realistic 1000-word prompt the estimator yields ~1440 prompt
        // tokens (Go per-rune state machine); the pre-consume and downstream
        // settlement figures follow from that.
        assert_eq!(metadata["pre_consumed_quota"], 5_820);
        assert_eq!(metadata["estimated_prompt_tokens"], 1_440);
        assert_eq!(metadata["estimated_completion_tokens"], 100);
        assert_eq!(metadata["estimated_quota_after_group"], 5_820);
        assert_eq!(metadata["matched_tier"], "fast");
        assert_eq!(metadata["group_ratio"], 1.5);
        assert_eq!(metadata["quota_before_group"], 7_000.0);
        assert_eq!(metadata["quota_after_group"], 10_500);
        assert_eq!(metadata["settlement"]["final_quota"], 10_500);
        assert_eq!(metadata["settlement"]["additional_quota"], 4_680);
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
            true,
            0,
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
        // Realistic 1000-word prompt (matches the sibling settlement test) so
        // the estimator yields a stable ~1440 prompt-token estimate.
        let prompt = (0..1000).map(|_| "word").collect::<Vec<_>>().join(" ");
        let request_body = json!({
            "prompt": prompt,
            "max_completion_tokens": 100
        });
        let preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p * 4 + c * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#,
            1.5,
            &request_body,
            RequestInput::from_json_body(request_body.clone()),
            true,
            0,
        )
        .unwrap();

        let fallback =
            tiered_billing_fallback_metadata(&preflight, "settlement failed".to_string(), true);
        assert_eq!(fallback["fallback_to_pre_consumed"], true);
        assert_eq!(fallback["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(fallback["has_request_rule"], true);
        assert_eq!(fallback["pre_consumed_quota"], 5_820);

        let refund = tiered_billing_refund_metadata(&preflight, "missing_usage");
        assert_eq!(refund["refunded"], true);
        assert_eq!(refund["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(refund["has_request_rule"], true);
        assert_eq!(refund["pre_consumed_quota"], 5_820);
        assert_eq!(refund["reason"], "missing_usage");
    }

    #[test]
    fn refund_reason_distinguishes_missing_stream_usage() {
        assert_eq!(
            refund_reason(200, &UsageSummary::default(), true, false),
            "missing_stream_usage"
        );
        assert_eq!(
            refund_reason(200, &UsageSummary::default(), false, false),
            "missing_usage"
        );
    }

    #[test]
    fn refund_reason_uses_valid_usage_gate_when_estimate_enabled() {
        // A prompt-only usage has total>0 but is "present" under both gates.
        let prompt_only = UsageSummary {
            prompt_tokens: 5,
            total_tokens: 5,
            ..UsageSummary::default()
        };
        assert_eq!(
            refund_reason(200, &prompt_only, false, true),
            "not_billable"
        );
        // A total-only usage (provider sent only total_tokens) is present under
        // the legacy gate but absent under ValidUsage (Go parity).
        let total_only = UsageSummary {
            total_tokens: 12,
            ..UsageSummary::default()
        };
        assert_eq!(
            refund_reason(200, &total_only, false, false),
            "not_billable"
        );
        assert_eq!(
            refund_reason(200, &total_only, false, true),
            "missing_usage"
        );
    }

    #[test]
    fn resolve_stream_usage_estimates_when_invalid_and_enabled() {
        // Both-zero usage is invalid (Go ValidUsage) -> estimate from streamed
        // text + toolCount*7. "Hello world" -> 3 OpenAI tokens, + 2*7.
        let (resolved, estimated) = resolve_stream_usage(
            UsageSummary::default(),
            "Hello world",
            2,
            "gpt-4o",
            100,
            true,
        );
        assert!(estimated);
        assert_eq!(resolved.prompt_tokens, 100);
        assert_eq!(resolved.completion_tokens, 3 + 14);
        assert_eq!(resolved.total_tokens, 100 + 17);
    }

    #[test]
    fn resolve_stream_usage_noop_when_disabled_or_valid() {
        let valid = UsageSummary {
            prompt_tokens: 5,
            total_tokens: 5,
            ..UsageSummary::default()
        };
        // Disabled -> no-op even though usage is invalid.
        let (r, est) = resolve_stream_usage(UsageSummary::default(), "x", 1, "gpt-4o", 100, false);
        assert!(!est);
        assert_eq!(r, UsageSummary::default());
        // Enabled but usage already valid (prompt != 0) -> no-op.
        let (r2, est2) = resolve_stream_usage(valid, "x", 1, "gpt-4o", 100, true);
        assert!(!est2);
        assert_eq!(r2, valid);
    }

    #[test]
    fn resolve_non_stream_usage_keeps_upstream_completion_when_prompt_zero() {
        // prompt==0 triggers the fallback, but a non-zero upstream completion is
        // preserved (Go only re-estimates completion when it is also zero).
        let usage = UsageSummary {
            completion_tokens: 42,
            total_tokens: 42,
            ..UsageSummary::default()
        };
        let body = r#"{"choices":[{"message":{"content":"ignored"}}]}"#;
        let (r, est) = resolve_non_stream_usage(usage, body, "gpt-4o", 100, true);
        assert!(est);
        assert_eq!(r.prompt_tokens, 100);
        assert_eq!(r.completion_tokens, 42);
        assert_eq!(r.total_tokens, 142);
    }

    #[test]
    fn resolve_non_stream_usage_estimates_completion_from_body_when_zero() {
        let body = r#"{"choices":[{"message":{"content":"Hello world"}}]}"#;
        let (r, est) = resolve_non_stream_usage(UsageSummary::default(), body, "gpt-4o", 50, true);
        assert!(est);
        assert_eq!(r.prompt_tokens, 50);
        // "Hello world" -> 3; no tool bump on the non-stream path.
        assert_eq!(r.completion_tokens, 3);
        assert_eq!(r.total_tokens, 53);
    }

    #[test]
    fn resolve_non_stream_usage_noop_when_prompt_present_or_disabled() {
        let with_prompt = UsageSummary {
            prompt_tokens: 7,
            total_tokens: 7,
            ..UsageSummary::default()
        };
        // prompt present -> no-op even when enabled.
        let (r, est) = resolve_non_stream_usage(with_prompt, "{}", "gpt-4o", 100, true);
        assert!(!est);
        assert_eq!(r, with_prompt);
        // disabled -> no-op even with zero prompt.
        let (r2, est2) =
            resolve_non_stream_usage(UsageSummary::default(), "{}", "gpt-4o", 100, false);
        assert!(!est2);
        assert_eq!(r2, UsageSummary::default());
    }
}
