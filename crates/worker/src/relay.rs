use cinatoken_billing::{
    build_tiered_token_params, compute_flat_quota_with_fixed_price_multiplier,
    compute_tiered_quota_with_request, detect_billing_expr_variables,
    estimate_tiered_billing_snapshot_with_request, rebase_tiered_billing_snapshot_group_ratio,
    settle, split_billing_expr_request_rule, BillingExprVariables, FlatBillingMode,
    FlatQuotaResult, FlatUsage, PricingConfig, Quota, RequestInput, TieredBillingResult,
    TieredBillingSnapshot, TieredTokenUsage, TokenParams, UsageSemantic,
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
        classify_ai_gateway_model_author, direct_provider_model_for_channel,
        has_ai_gateway_provider_prefix, plan_ai_gateway_cutover, rest_gateway_endpoint_url,
        AiGatewayCutoverDecision, AiGatewayCutoverInput, AiGatewayCutoverPlan,
        AiGatewayModelAuthor,
    },
    ali::{
        ali_plugin_header_value, apply_ali_request, supports_ali_anthropic_messages_with_config,
        supports_ali_native_rerank, transform_ali_rerank_response_body,
    },
    baidu_v2::{apply_baidu_v2_request, parse_baidu_v2_key},
    channel_supports_relay_route, channel_types_for_relay_route,
    deepseek::{apply_deepseek_request, DeepSeekRequestFormat},
    jina::apply_jina_request,
    mistral::apply_mistral_chat_request,
    moonshot::{apply_moonshot_request, is_coding_plan_base, MoonshotRequestFormat},
    perplexity::apply_perplexity_chat_request,
    siliconflow::{
        apply_siliconflow_request, siliconflow_image_response_usage,
        transform_siliconflow_rerank_response_body,
    },
    tencent::{
        apply_tencent_chat_request, parse_tencent_key, tencent_tc3_headers,
        transform_tencent_chat_response_body, TencentResponseError, TENCENT_HUNYUAN_ACTION,
        TENCENT_HUNYUAN_VERSION,
    },
    volcengine::{apply_volcengine_request, is_volcengine_bot_model, is_volcengine_coding_plan},
    xai::apply_xai_request,
    zhipu::apply_zhipu_v4_request,
    ProviderEndpoint, ProviderKind as RegistryProviderKind, ProviderRegistry, ProviderRelayRoute,
};
use cinatoken_relay::{
    apply_gemini_native_model_mapping, apply_model_mapping, clamp_i64_to_i32, csv_contains,
    first_channel_key, ip_allowlist_matches, is_auto_disable_status, is_retryable_status,
    mapped_model_name, usage_summary_from_anthropic_body, usage_summary_from_body,
    usage_summary_from_gemini_body, usage_summary_from_moonshot_body,
    usage_summary_from_rerank_body, CachedAuthenticatedToken, CachedRelayChannel, GeminiNativePath,
    RelayCacheKeys, SseUsageAccumulator, UsageSummary, ANTHROPIC_CHANNEL_TYPES, CHANNEL_TYPE_ALI,
    CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_JINA,
    CHANNEL_TYPE_MISTRAL, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_PERPLEXITY, CHANNEL_TYPE_SILICONFLOW,
    CHANNEL_TYPE_SUBMODEL, CHANNEL_TYPE_TENCENT, CHANNEL_TYPE_VOLCENGINE, CHANNEL_TYPE_XAI,
    CHANNEL_TYPE_ZHIPU_V4, RELAY_CACHE_SCHEMA_VERSION,
};
use cinatoken_storage::{AuditLogEvent, AuthenticatedToken, RelayAuditLog, RelayChannel};
use cinatoken_wfp_authority::{
    sign_authority, verify_authority, AuthorityExpectation, AuthorityInput, AUTHORITY_SECRET_ENV,
};
use futures_util::{
    future::{select, Either},
    StreamExt,
};
use js_sys::{Function, Object, Promise, Reflect};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};
use url::Url;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{
    Context, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit, Response,
    ResponseBody,
};

use crate::{affinity, json_with_status, set_cors_headers};

const TOKEN_STATUS_EXPIRED: i32 = 3;
const TOKEN_STATUS_EXHAUSTED: i32 = 4;
const LOG_TYPE_CONSUME: i32 = 2;
const LOG_TYPE_ERROR: i32 = 5;
const RELAY_ATTEMPT_AUDIT_MAX_ENTRIES: usize = 32;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS: u32 = 60;
const RATE_LIMIT_BACKEND_ENV: &str = "RELAY_RATE_LIMIT_BACKEND";
const TOKEN_RATE_LIMIT_ENV: &str = "RELAY_TOKEN_RATE_LIMIT_PER_WINDOW";
const IP_RATE_LIMIT_ENV: &str = "RELAY_IP_RATE_LIMIT_PER_WINDOW";
const RATE_LIMIT_WINDOW_ENV: &str = "RELAY_RATE_LIMIT_WINDOW_SECONDS";
const NATIVE_TOKEN_RATE_LIMIT_BINDING: &str = "RELAY_TOKEN_RATE_LIMITER";
const NATIVE_IP_RATE_LIMIT_BINDING: &str = "RELAY_IP_RATE_LIMITER";
const RELAY_CACHE_TTL_ENV: &str = "RELAY_CACHE_TTL_SECONDS";
const RELAY_JSON_BODY_LIMIT_ENV: &str = "RELAY_JSON_BODY_LIMIT_BYTES";
const RELAY_JSON_RESPONSE_LIMIT_ENV: &str = "RELAY_JSON_RESPONSE_LIMIT_BYTES";
const RELAY_RETRY_TIMES_ENV: &str = "RELAY_RETRY_TIMES";
const RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV: &str = "RELAY_AI_GATEWAY_ROUTER_ENABLED";
const RELAY_MODEL_FALLBACK_ENABLED_ENV: &str = "RELAY_MODEL_FALLBACK_ENABLED";
const RELAY_MODEL_FALLBACKS_JSON_ENV: &str = "RELAY_MODEL_FALLBACKS_JSON";
pub(crate) const RELAY_MODEL_FALLBACK_STAGING_VERIFIED_ENV: &str =
    "RELAY_MODEL_FALLBACK_STAGING_VERIFIED";
const RELAY_MODEL_FALLBACKS_MAX_ENTRIES: usize = 128;
const RELAY_MODEL_FALLBACK_NAME_MAX_CHARS: usize = 200;
pub(crate) const RELAY_BILLING_RESERVATION_LEASE_SECONDS_ENV: &str =
    "RELAY_BILLING_RESERVATION_LEASE_SECONDS";
pub(crate) const RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS_ENV: &str =
    "RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS";
pub(crate) const RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED_ENV: &str =
    "RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED";
pub(crate) const RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED_ENV: &str =
    "RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED";
pub(crate) const RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED_ENV: &str =
    "RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED";
pub(crate) const RELAY_BILLING_ORPHAN_SWEEP_LIMIT_ENV: &str = "RELAY_BILLING_ORPHAN_SWEEP_LIMIT";
pub(crate) const RELAY_BILLING_ORPHAN_RECOVERY_ENABLED_ENV: &str =
    "RELAY_BILLING_ORPHAN_RECOVERY_ENABLED";
const RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS: i64 = 3_600;
const RELAY_BILLING_RESERVATION_LEASE_MIN_SECONDS: i64 = 300;
const RELAY_BILLING_RESERVATION_LEASE_MAX_SECONDS: i64 = 86_400;
const RELAY_BILLING_STREAM_LEASE_HEARTBEAT_DEFAULT_SECONDS: i64 = 900;
const RELAY_BILLING_STREAM_LEASE_HEARTBEAT_MIN_SECONDS: i64 = 5;
const RELAY_BILLING_STREAM_LEASE_HEARTBEAT_RETRY_MAX_SECONDS: i64 = 60;
const RELAY_BILLING_ORPHAN_SWEEP_DEFAULT_LIMIT: i64 = 32;
pub(crate) const RELAY_BILLING_FINALIZATION_QUEUE_BINDING: &str = "BILLING_QUEUE";
const AI_GATEWAY_DIRECT_FALLBACK_AUDIT_HEADER: &str =
    "x-cinatoken-internal-ai-gateway-direct-fallback";
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
const ADMIN_CHANNEL_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const ADMIN_CHANNEL_PROBE_SSE_LIMIT_BYTES: usize = 512 * 1024;
const CHANNEL_TYPE_MOKAAI: i32 = 44;
const CHANNEL_TYPE_CODEX: i32 = 57;
const REALTIME_MOCK_QUEUE_PROBE_MAX_DELAY_MS: u64 = 1_000;
const REALTIME_BILLING_REQUEST_MAX_HEADERS: usize = 16;
const REALTIME_BILLING_REQUEST_MAX_HEADER_VALUE_CHARS: usize = 256;
const ESTIMATED_IMAGE_INPUT_TOKENS: i64 = 520;
const ESTIMATED_AUDIO_INPUT_TOKENS: i64 = 256;
const ESTIMATED_VIDEO_INPUT_TOKENS: i64 = 4_096 * 2;
const ESTIMATED_FILE_INPUT_TOKENS: i64 = 4_096;
const MODEL_OBJECT_CREATED: i64 = 1_626_777_600;
const MODEL_LIST_CACHE_MODEL_KEY: &str = "__model_list__";
const ALI_ANTHROPIC_MESSAGES_MODELS_ENV: &str = "ALI_ANTHROPIC_MESSAGES_MODELS";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayProviderKind {
    AliOpenAi,
    AliMessages,
    BaiduV2OpenAi,
    OpenAiCompatible,
    AnthropicMessages,
    DeepSeekOpenAi,
    DeepSeekMessages,
    MistralOpenAi,
    MoonshotOpenAi,
    MoonshotMessages,
    PerplexityOpenAi,
    SiliconFlowOpenAi,
    SubmodelOpenAi,
    TencentHunyuan,
    XaiOpenAi,
    VolcEngineOpenAi,
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
    route: ProviderRelayRoute,
    upstream_path: String,
    upstream_query: Option<String>,
    gemini_route: Option<GeminiNativePath>,
    provider: RelayProviderKind,
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
            provider: self.registry_provider_kind(channel.channel_type),
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

    fn effective_provider(&self, channel_type: i32) -> RelayProviderKind {
        if channel_type == CHANNEL_TYPE_ALI {
            return match self.provider {
                RelayProviderKind::OpenAiCompatible => RelayProviderKind::AliOpenAi,
                RelayProviderKind::AnthropicMessages => RelayProviderKind::AliMessages,
                provider => provider,
            };
        }
        if channel_type == CHANNEL_TYPE_BAIDU_V2
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::BaiduV2OpenAi;
        }
        if channel_type == CHANNEL_TYPE_MISTRAL
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::MistralOpenAi;
        }
        if channel_type == CHANNEL_TYPE_PERPLEXITY
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::PerplexityOpenAi;
        }
        if channel_type == CHANNEL_TYPE_MOONSHOT {
            return match self.provider {
                RelayProviderKind::OpenAiCompatible => RelayProviderKind::MoonshotOpenAi,
                RelayProviderKind::AnthropicMessages => RelayProviderKind::MoonshotMessages,
                provider => provider,
            };
        }
        if channel_type == CHANNEL_TYPE_SILICONFLOW
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::SiliconFlowOpenAi;
        }
        if channel_type == CHANNEL_TYPE_SUBMODEL
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::SubmodelOpenAi;
        }
        if channel_type == CHANNEL_TYPE_TENCENT
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::TencentHunyuan;
        }
        if channel_type == CHANNEL_TYPE_XAI && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::XaiOpenAi;
        }
        if channel_type == CHANNEL_TYPE_VOLCENGINE
            && self.provider == RelayProviderKind::OpenAiCompatible
        {
            return RelayProviderKind::VolcEngineOpenAi;
        }
        if channel_type == CHANNEL_TYPE_DEEPSEEK {
            return match self.provider {
                RelayProviderKind::OpenAiCompatible => RelayProviderKind::DeepSeekOpenAi,
                RelayProviderKind::AnthropicMessages => RelayProviderKind::DeepSeekMessages,
                provider => provider,
            };
        }
        self.provider
    }

    fn registry_provider_kind(&self, channel_type: i32) -> RegistryProviderKind {
        if channel_type == CHANNEL_TYPE_ZHIPU_V4 {
            return match self.provider {
                RelayProviderKind::OpenAiCompatible => RegistryProviderKind::ZhipuV4OpenAi,
                RelayProviderKind::AnthropicMessages => RegistryProviderKind::ZhipuV4Messages,
                _ => self.registry_provider_kind_from_effective(channel_type),
            };
        }
        self.registry_provider_kind_from_effective(channel_type)
    }

    fn registry_provider_kind_from_effective(&self, channel_type: i32) -> RegistryProviderKind {
        match self.effective_provider(channel_type) {
            RelayProviderKind::AliOpenAi => RegistryProviderKind::AliOpenAi,
            RelayProviderKind::AliMessages => RegistryProviderKind::AliMessages,
            RelayProviderKind::BaiduV2OpenAi => RegistryProviderKind::BaiduV2OpenAi,
            RelayProviderKind::OpenAiCompatible => RegistryProviderKind::OpenAiCompatible,
            RelayProviderKind::AnthropicMessages => RegistryProviderKind::AnthropicMessages,
            RelayProviderKind::DeepSeekOpenAi => RegistryProviderKind::DeepSeekOpenAi,
            RelayProviderKind::DeepSeekMessages => RegistryProviderKind::DeepSeekMessages,
            RelayProviderKind::MistralOpenAi => RegistryProviderKind::MistralOpenAi,
            RelayProviderKind::MoonshotOpenAi => RegistryProviderKind::MoonshotOpenAi,
            RelayProviderKind::MoonshotMessages => RegistryProviderKind::MoonshotMessages,
            RelayProviderKind::PerplexityOpenAi => RegistryProviderKind::PerplexityOpenAi,
            RelayProviderKind::SiliconFlowOpenAi => RegistryProviderKind::SiliconFlowOpenAi,
            RelayProviderKind::SubmodelOpenAi => RegistryProviderKind::SubmodelOpenAi,
            RelayProviderKind::TencentHunyuan => RegistryProviderKind::TencentHunyuan,
            RelayProviderKind::XaiOpenAi => RegistryProviderKind::XaiOpenAi,
            RelayProviderKind::VolcEngineOpenAi => RegistryProviderKind::VolcEngineOpenAi,
            RelayProviderKind::GeminiNative => RegistryProviderKind::GeminiNative,
        }
    }

    fn ai_gateway_provider_kind(&self, channel_type: i32) -> RegistryProviderKind {
        match self.effective_provider(channel_type) {
            RelayProviderKind::DeepSeekOpenAi => RegistryProviderKind::OpenAiCompatible,
            RelayProviderKind::DeepSeekMessages => RegistryProviderKind::AnthropicMessages,
            _ => self.registry_provider_kind(channel_type),
        }
    }

    fn default_json_response_limit_bytes(&self) -> usize {
        match self.provider {
            RelayProviderKind::GeminiNative => GEMINI_JSON_RESPONSE_LIMIT_BYTES,
            RelayProviderKind::AliOpenAi
            | RelayProviderKind::OpenAiCompatible
            | RelayProviderKind::SiliconFlowOpenAi => match self.upstream_path.as_str() {
                "embeddings" => EMBEDDINGS_JSON_RESPONSE_LIMIT_BYTES,
                "images/generations" => IMAGE_JSON_RESPONSE_LIMIT_BYTES,
                "rerank" => RERANK_JSON_RESPONSE_LIMIT_BYTES,
                _ => DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES,
            },
            RelayProviderKind::AliMessages
            | RelayProviderKind::AnthropicMessages
            | RelayProviderKind::BaiduV2OpenAi
            | RelayProviderKind::DeepSeekOpenAi
            | RelayProviderKind::DeepSeekMessages
            | RelayProviderKind::MistralOpenAi
            | RelayProviderKind::MoonshotOpenAi
            | RelayProviderKind::MoonshotMessages
            | RelayProviderKind::PerplexityOpenAi
            | RelayProviderKind::SubmodelOpenAi
            | RelayProviderKind::TencentHunyuan
            | RelayProviderKind::XaiOpenAi => DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES,
            RelayProviderKind::VolcEngineOpenAi => match self.upstream_path.as_str() {
                "embeddings" => EMBEDDINGS_JSON_RESPONSE_LIMIT_BYTES,
                "images/generations" => IMAGE_JSON_RESPONSE_LIMIT_BYTES,
                _ => DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdminProbeEndpoint {
    Auto,
    OpenAi,
    OpenAiCompletions,
    OpenAiResponse,
    OpenAiResponseCompact,
    Anthropic,
    Gemini,
    JinaRerank,
    ImageGeneration,
    Embeddings,
}

impl AdminProbeEndpoint {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "openai" => Some(Self::OpenAi),
            "openai-completions" => Some(Self::OpenAiCompletions),
            "openai-response" => Some(Self::OpenAiResponse),
            "openai-response-compact" => Some(Self::OpenAiResponseCompact),
            "anthropic" => Some(Self::Anthropic),
            "gemini" => Some(Self::Gemini),
            "jina-rerank" => Some(Self::JinaRerank),
            "image-generation" => Some(Self::ImageGeneration),
            "embeddings" => Some(Self::Embeddings),
            _ => None,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::OpenAi => "openai",
            Self::OpenAiCompletions => "openai-completions",
            Self::OpenAiResponse => "openai-response",
            Self::OpenAiResponseCompact => "openai-response-compact",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::JinaRerank => "jina-rerank",
            Self::ImageGeneration => "image-generation",
            Self::Embeddings => "embeddings",
        }
    }

    const fn route(self) -> Option<ProviderRelayRoute> {
        match self {
            Self::Auto => None,
            Self::OpenAi => Some(ProviderRelayRoute::ChatCompletions),
            Self::OpenAiCompletions => Some(ProviderRelayRoute::Completions),
            Self::OpenAiResponse => Some(ProviderRelayRoute::Responses),
            Self::OpenAiResponseCompact => Some(ProviderRelayRoute::ResponsesCompact),
            Self::Anthropic => Some(ProviderRelayRoute::AnthropicMessages),
            Self::Gemini => Some(ProviderRelayRoute::GeminiNative),
            Self::JinaRerank => Some(ProviderRelayRoute::Rerank),
            Self::ImageGeneration => Some(ProviderRelayRoute::ImageGenerations),
            Self::Embeddings => Some(ProviderRelayRoute::Embeddings),
        }
    }

    const fn supports_stream(self) -> bool {
        matches!(
            self,
            Self::OpenAi
                | Self::OpenAiCompletions
                | Self::OpenAiResponse
                | Self::Anthropic
                | Self::Gemini
        )
    }

    fn relay_endpoint(self, model: &str, stream: bool) -> RelayEndpoint {
        if self == Self::Gemini {
            let route = GeminiNativePath {
                api_version: "v1beta".to_string(),
                model: model.to_string(),
                action: if stream {
                    "streamGenerateContent"
                } else {
                    "generateContent"
                }
                .to_string(),
            };
            return RelayEndpoint {
                display_name: "admin channel Gemini probe",
                route: ProviderRelayRoute::GeminiNative,
                upstream_path: route.upstream_path(),
                upstream_query: stream.then(|| "alt=sse".to_string()),
                gemini_route: Some(route),
                provider: RelayProviderKind::GeminiNative,
                supports_streaming: stream,
                force_streaming: stream,
                stream_not_implemented_feature: None,
                parse_non_stream_usage: false,
                request_body_mode: RelayRequestBodyMode::Json,
                request_validator: None,
            };
        }
        let (display_name, route, upstream_path, provider, request_validator) = match self {
            Self::OpenAi => (
                "admin channel OpenAI probe",
                ProviderRelayRoute::ChatCompletions,
                "chat/completions",
                RelayProviderKind::OpenAiCompatible,
                Some(validate_chat_completions_request as fn(&Value) -> Option<&'static str>),
            ),
            Self::OpenAiCompletions => (
                "admin channel legacy Completions probe",
                ProviderRelayRoute::Completions,
                "completions",
                RelayProviderKind::OpenAiCompatible,
                None,
            ),
            Self::OpenAiResponse => (
                "admin channel Responses probe",
                ProviderRelayRoute::Responses,
                "responses",
                RelayProviderKind::OpenAiCompatible,
                None,
            ),
            Self::OpenAiResponseCompact => (
                "admin channel Responses compact probe",
                ProviderRelayRoute::ResponsesCompact,
                "responses/compact",
                RelayProviderKind::OpenAiCompatible,
                None,
            ),
            Self::Anthropic => (
                "admin channel Anthropic probe",
                ProviderRelayRoute::AnthropicMessages,
                "messages",
                RelayProviderKind::AnthropicMessages,
                None,
            ),
            Self::JinaRerank => (
                "admin channel rerank probe",
                ProviderRelayRoute::Rerank,
                "rerank",
                RelayProviderKind::OpenAiCompatible,
                Some(validate_rerank_request as fn(&Value) -> Option<&'static str>),
            ),
            Self::ImageGeneration => (
                "admin channel image generation probe",
                ProviderRelayRoute::ImageGenerations,
                "images/generations",
                RelayProviderKind::OpenAiCompatible,
                None,
            ),
            Self::Embeddings => (
                "admin channel embeddings probe",
                ProviderRelayRoute::Embeddings,
                "embeddings",
                RelayProviderKind::OpenAiCompatible,
                None,
            ),
            Self::Auto | Self::Gemini => {
                unreachable!("admin probe endpoint must be resolved before construction")
            }
        };
        RelayEndpoint {
            display_name,
            route,
            upstream_path: upstream_path.to_string(),
            upstream_query: None,
            gemini_route: None,
            provider,
            supports_streaming: self.supports_stream(),
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: false,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdminChannelProbeRequest {
    pub model: String,
    pub endpoint_type: AdminProbeEndpoint,
    pub stream: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AdminChannelProbeResult {
    pub requested_model: String,
    pub requested_endpoint_type: &'static str,
    pub requested_stream: bool,
    pub effective_model: String,
    pub effective_endpoint_type: &'static str,
    pub effective_route: String,
    pub effective_stream: bool,
    pub transport: &'static str,
    pub response_time_ms: f64,
    pub validation_mode: &'static str,
    pub content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdminChannelProbeError {
    pub status: u16,
    pub error_code: &'static str,
    pub message: String,
}

impl AdminChannelProbeError {
    pub(crate) fn new(status: u16, error_code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            error_code,
            message: message.into(),
        }
    }

    fn bad_request(error_code: &'static str, message: impl Into<String>) -> Self {
        Self::new(400, error_code, message)
    }

    fn bad_gateway(error_code: &'static str, message: impl Into<String>) -> Self {
        Self::new(502, error_code, message)
    }
}

fn model_sensitive_admin_probe_endpoint(channel_type: i32, model: &str) -> AdminProbeEndpoint {
    let model = model.trim().to_ascii_lowercase();
    if model.ends_with("-openai-compact") {
        AdminProbeEndpoint::OpenAiResponseCompact
    } else if channel_type == CHANNEL_TYPE_CODEX || model.contains("codex") {
        AdminProbeEndpoint::OpenAiResponse
    } else if model.contains("rerank") {
        AdminProbeEndpoint::JinaRerank
    } else if channel_type == CHANNEL_TYPE_ZHIPU_V4
        && (model.starts_with("glm-image") || model.starts_with("cogview-"))
    {
        AdminProbeEndpoint::ImageGeneration
    } else if channel_type == CHANNEL_TYPE_MOKAAI
        || ["embedding", "embed", "m3e", "bge"]
            .iter()
            .any(|marker| model.contains(marker))
    {
        AdminProbeEndpoint::Embeddings
    } else if channel_type == CHANNEL_TYPE_VOLCENGINE && model.contains("seedream") {
        AdminProbeEndpoint::ImageGeneration
    } else {
        AdminProbeEndpoint::OpenAi
    }
}

fn resolve_admin_probe_endpoint(
    channel_type: i32,
    requested: AdminProbeEndpoint,
    model: &str,
    stream: bool,
) -> Result<AdminProbeEndpoint, AdminChannelProbeError> {
    let preferred = if requested == AdminProbeEndpoint::Auto {
        model_sensitive_admin_probe_endpoint(channel_type, model)
    } else {
        requested
    };
    if stream && channel_type == CHANNEL_TYPE_TENCENT {
        return Err(AdminChannelProbeError::bad_request(
            "channel_test_stream_incompatible",
            "Tencent Hunyuan streaming probes are not implemented",
        ));
    }
    if stream && !preferred.supports_stream() {
        return Err(AdminChannelProbeError::bad_request(
            "channel_test_stream_incompatible",
            format!(
                "endpoint_type {} does not support streaming probes",
                preferred.as_str()
            ),
        ));
    }
    let preferred_route = preferred
        .route()
        .expect("resolved admin probe endpoint must have a relay route");
    if channel_supports_relay_route(channel_type, preferred_route) {
        return Ok(preferred);
    }
    if requested != AdminProbeEndpoint::Auto {
        return Err(AdminChannelProbeError::bad_request(
            "channel_test_route_unsupported",
            format!(
                "channel type {channel_type} does not support endpoint_type {}",
                requested.as_str()
            ),
        ));
    }

    if preferred == AdminProbeEndpoint::OpenAiResponseCompact
        && channel_supports_relay_route(channel_type, ProviderRelayRoute::Responses)
    {
        return Ok(AdminProbeEndpoint::OpenAiResponse);
    }
    if preferred != AdminProbeEndpoint::OpenAi {
        return Err(AdminChannelProbeError::bad_request(
            "channel_test_auto_route_unsupported",
            format!(
                "auto selected endpoint_type {} for model {model}, but channel type {channel_type} does not support it",
                preferred.as_str()
            ),
        ));
    }

    const SAFE_AUTO_FALLBACKS: &[AdminProbeEndpoint] = &[
        AdminProbeEndpoint::OpenAiResponse,
        AdminProbeEndpoint::OpenAiCompletions,
        AdminProbeEndpoint::Anthropic,
        AdminProbeEndpoint::Gemini,
        AdminProbeEndpoint::JinaRerank,
        AdminProbeEndpoint::Embeddings,
        AdminProbeEndpoint::ImageGeneration,
    ];
    if let Some(endpoint) = SAFE_AUTO_FALLBACKS.iter().copied().find(|endpoint| {
        (!stream || endpoint.supports_stream())
            && endpoint
                .route()
                .is_some_and(|route| channel_supports_relay_route(channel_type, route))
    }) {
        return Ok(endpoint);
    }

    let has_any_supported_route = [
        AdminProbeEndpoint::OpenAi,
        AdminProbeEndpoint::OpenAiCompletions,
        AdminProbeEndpoint::OpenAiResponse,
        AdminProbeEndpoint::OpenAiResponseCompact,
        AdminProbeEndpoint::Anthropic,
        AdminProbeEndpoint::Gemini,
        AdminProbeEndpoint::JinaRerank,
        AdminProbeEndpoint::ImageGeneration,
        AdminProbeEndpoint::Embeddings,
    ]
    .iter()
    .filter_map(|endpoint| endpoint.route())
    .any(|route| channel_supports_relay_route(channel_type, route));
    let (error_code, message) = if stream && has_any_supported_route {
        (
            "channel_test_stream_incompatible",
            format!(
                "channel type {channel_type} has no production-supported streaming probe route"
            ),
        )
    } else {
        (
            "channel_test_route_unsupported",
            format!("channel type {channel_type} has no production-supported admin probe route"),
        )
    };
    Err(AdminChannelProbeError::bad_request(error_code, message))
}

fn build_admin_probe_body(endpoint: AdminProbeEndpoint, model: &str, stream: bool) -> Value {
    match endpoint {
        AdminProbeEndpoint::OpenAi => json!({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 16,
            "stream": stream,
        }),
        AdminProbeEndpoint::OpenAiCompletions => json!({
            "model": model,
            "prompt": "hi",
            "max_tokens": 16,
            "stream": stream,
        }),
        AdminProbeEndpoint::OpenAiResponse | AdminProbeEndpoint::OpenAiResponseCompact => json!({
            "model": model,
            "input": [{"role": "user", "content": "hi"}],
            "max_output_tokens": 16,
            "stream": stream,
        }),
        AdminProbeEndpoint::Anthropic => json!({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 16,
            "stream": stream,
        }),
        AdminProbeEndpoint::Gemini => json!({
            "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
            "generationConfig": {"maxOutputTokens": 3000},
        }),
        AdminProbeEndpoint::JinaRerank => json!({
            "model": model,
            "query": "hi",
            "documents": ["hello", "world"],
            "top_n": 2,
        }),
        AdminProbeEndpoint::ImageGeneration => json!({
            "model": model,
            "prompt": "a common cat",
            "n": 1,
            "size": "1024x1024",
            "stream": stream,
        }),
        AdminProbeEndpoint::Embeddings => json!({
            "model": model,
            "input": ["hi"],
        }),
        AdminProbeEndpoint::Auto => unreachable!("auto endpoint must be resolved first"),
    }
}

struct PreparedAdminChannelProbe {
    endpoint_type: AdminProbeEndpoint,
    endpoint: RelayEndpoint,
    upstream_key: String,
    upstream_url: String,
    body: Value,
    effective_model: String,
    effective_route: String,
    provider: RelayProviderKind,
}

fn prepare_admin_channel_probe(
    channel: &RelayChannel,
    request: &AdminChannelProbeRequest,
    inject_stream_options: bool,
    ali_messages_model_patterns: Option<&str>,
) -> Result<PreparedAdminChannelProbe, AdminChannelProbeError> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err(AdminChannelProbeError::bad_request(
            "channel_test_model_invalid",
            "channel test model must not be empty",
        ));
    }
    let endpoint_type = resolve_admin_probe_endpoint(
        channel.channel_type,
        request.endpoint_type,
        model,
        request.stream,
    )?;
    let mut endpoint = endpoint_type.relay_endpoint(model, request.stream);
    let upstream_key = first_channel_key(&channel.key).ok_or_else(|| {
        AdminChannelProbeError::new(
            422,
            "channel_test_key_missing",
            "channel has no usable provider key",
        )
    })?;
    let mut body = build_admin_probe_body(endpoint_type, model, request.stream);

    let effective_model = if endpoint_type == AdminProbeEndpoint::Gemini {
        let mapped_model = mapped_model_name(model, channel.model_mapping.as_deref())
            .unwrap_or_else(|| model.to_string());
        apply_gemini_native_model_mapping(&mut body, model, &mapped_model);
        if let Some(route) = endpoint.gemini_route.as_mut() {
            route.model = mapped_model.clone();
            endpoint.upstream_path = route.upstream_path();
        }
        mapped_model
    } else {
        apply_model_mapping(&mut body, model, channel.model_mapping.as_deref());
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or(model)
            .to_string()
    };
    let provider = endpoint.effective_provider(channel.channel_type);
    if channel.channel_type == CHANNEL_TYPE_ALI
        && !ali_accepts_request_shape(&endpoint, channel, &body, true, ali_messages_model_patterns)
    {
        return Err(AdminChannelProbeError::new(
            422,
            "channel_test_request_shape_unsupported",
            format!(
                "channel type {} rejected the minimal {} probe request shape",
                channel.channel_type,
                endpoint_type.as_str()
            ),
        ));
    }
    apply_endpoint_request_transform(&mut body, &endpoint.upstream_path, channel).map_err(
        |err| {
            AdminChannelProbeError::new(
                422,
                "channel_test_transform_invalid",
                format!("channel probe request transform failed: {err}"),
            )
        },
    )?;
    apply_provider_request_transform(&mut body, provider);
    if inject_stream_options && provider_uses_openai_stream_options(provider) {
        cinatoken_relay::openai_compatible::apply_stream_options(
            &mut body,
            channel.channel_type,
            request.stream,
        );
    }
    if channel.channel_type != CHANNEL_TYPE_ALI
        && !channel_accepts_endpoint_request_shape(channel, &endpoint, Some(&body))
    {
        return Err(AdminChannelProbeError::new(
            422,
            "channel_test_request_shape_unsupported",
            format!(
                "channel type {} rejected the minimal {} probe request shape",
                channel.channel_type,
                endpoint_type.as_str()
            ),
        ));
    }

    let upstream_url = endpoint.try_upstream_url(channel).map_err(|err| {
        AdminChannelProbeError::new(
            422,
            "channel_test_route_configuration_invalid",
            format!("failed to resolve channel probe route: {err}"),
        )
    })?;
    let effective_route = Url::parse(&upstream_url)
        .map(|url| url.path().to_string())
        .map_err(|err| {
            AdminChannelProbeError::new(
                422,
                "channel_test_route_configuration_invalid",
                format!("resolved channel probe URL is invalid: {err}"),
            )
        })?;
    let effective_model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&effective_model)
        .to_string();
    Ok(PreparedAdminChannelProbe {
        endpoint_type,
        endpoint,
        upstream_key,
        upstream_url,
        body,
        effective_model,
        effective_route,
        provider,
    })
}

#[derive(Debug)]
enum AdminProbeTransportPlan {
    Direct,
    AiGateway(RelayAiGatewayAttempt),
    WorkersAi,
    Wfp,
}

impl AdminProbeTransportPlan {
    const fn name(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::AiGateway(_) => "ai_gateway",
            Self::WorkersAi => "workers_ai",
            Self::Wfp => "wfp",
        }
    }
}

fn plan_admin_probe_transport(
    runtime: Option<&RelayAiGatewayRuntime>,
    endpoint: &RelayEndpoint,
    channel: &RelayChannel,
    upstream_url: &str,
    upstream_model: &str,
    stream: bool,
) -> Result<AdminProbeTransportPlan, AdminChannelProbeError> {
    if channel.wfp_worker().is_some() && channel.ai_gateway_opted_in() {
        return Err(AdminChannelProbeError::new(
            422,
            "channel_test_transport_conflict",
            "channel cannot enable both AI Gateway and WFP transport",
        ));
    }
    if is_direct_only_provider_channel(channel)
        && (channel.wfp_worker().is_some() || channel.ai_gateway_opted_in())
    {
        return Err(AdminChannelProbeError::new(
            422,
            "channel_test_transport_unsupported",
            "direct-only provider channel cannot use AI Gateway or WFP transport",
        ));
    }
    if is_workers_ai_binding_channel(channel) {
        if stream {
            return Err(AdminChannelProbeError::bad_request(
                "channel_test_stream_incompatible",
                "Workers AI binding channels do not support streaming probes",
            ));
        }
        return Ok(AdminProbeTransportPlan::WorkersAi);
    }
    if channel.wfp_worker().is_some() {
        wfp_relay_path(upstream_url).map_err(|err| {
            AdminChannelProbeError::new(
                422,
                "channel_test_transport_unsupported",
                format!("WFP cannot carry the selected admin probe route: {err}"),
            )
        })?;
        return Ok(AdminProbeTransportPlan::Wfp);
    }
    if let Some(runtime) = runtime {
        if let Some(attempt) =
            plan_relay_ai_gateway_attempt(runtime, endpoint, channel, upstream_model).map_err(
                |err| {
                    AdminChannelProbeError::new(
                        422,
                        "channel_test_transport_configuration_invalid",
                        format!("AI Gateway probe planning failed: {err}"),
                    )
                },
            )?
        {
            return Ok(AdminProbeTransportPlan::AiGateway(attempt));
        }
    }
    Ok(AdminProbeTransportPlan::Direct)
}

struct ForwardedAdminChannelProbe {
    response: Response,
    transport: &'static str,
    effective_model: String,
}

fn effective_body_model(body: &Value, fallback: &str) -> String {
    body.get("model")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

async fn forward_admin_channel_probe(
    env: &Env,
    channel: &RelayChannel,
    prepared: &PreparedAdminChannelProbe,
    plan: AdminProbeTransportPlan,
) -> Result<ForwardedAdminChannelProbe, AdminChannelProbeError> {
    let provider_headers = RelayProviderHeaders {
        anthropic_version: None,
        anthropic_beta: None,
    };
    match plan {
        AdminProbeTransportPlan::WorkersAi => {
            let response =
                forward_workers_ai_binding(env, &prepared.effective_model, &prepared.body)
                    .await
                    .map_err(|err| {
                        AdminChannelProbeError::bad_gateway(
                            "channel_test_upstream_fetch_failed",
                            format!("Workers AI probe failed: {err}"),
                        )
                    })?;
            Ok(ForwardedAdminChannelProbe {
                response,
                transport: AdminProbeTransportPlan::WorkersAi.name(),
                effective_model: prepared.effective_model.clone(),
            })
        }
        AdminProbeTransportPlan::AiGateway(attempt) => {
            let runtime = RelayAiGatewayRuntime::from_env(env).ok_or_else(|| {
                AdminChannelProbeError::new(
                    500,
                    "channel_test_transport_configuration_invalid",
                    "AI Gateway runtime became unavailable during channel probe",
                )
            })?;
            match forward_ai_gateway_rest(&attempt, &runtime, &prepared.body).await {
                Ok(response) if should_ai_gateway_direct_fallback(response.status_code()) => {
                    let status = response.status_code();
                    let Some(direct_body) =
                        prepare_ai_gateway_direct_fallback_body(&prepared.body, &attempt)
                    else {
                        return Ok(ForwardedAdminChannelProbe {
                            response,
                            transport: "ai_gateway",
                            effective_model: prepared.effective_model.clone(),
                        });
                    };
                    let response = forward_relay_request(
                        env,
                        prepared.provider,
                        &prepared.upstream_url,
                        &prepared.upstream_key,
                        channel,
                        &direct_body,
                        &provider_headers,
                    )
                    .await
                    .map_err(|err| {
                        AdminChannelProbeError::bad_gateway(
                            "channel_test_upstream_fetch_failed",
                            format!(
                                "AI Gateway returned status {status} and direct probe fallback failed: {err}"
                            ),
                        )
                    })?;
                    Ok(ForwardedAdminChannelProbe {
                        response,
                        transport: "ai_gateway_direct_fallback",
                        effective_model: effective_body_model(
                            &direct_body,
                            &prepared.effective_model,
                        ),
                    })
                }
                Ok(response) => Ok(ForwardedAdminChannelProbe {
                    response,
                    transport: "ai_gateway",
                    effective_model: prepared.effective_model.clone(),
                }),
                Err(gateway_error) => {
                    let direct_body =
                        prepare_ai_gateway_direct_fallback_body(&prepared.body, &attempt)
                            .ok_or_else(|| {
                                AdminChannelProbeError::bad_gateway(
                                    "channel_test_upstream_fetch_failed",
                                    format!("AI Gateway probe failed: {gateway_error}"),
                                )
                            })?;
                    let response = forward_relay_request(
                        env,
                        prepared.provider,
                        &prepared.upstream_url,
                        &prepared.upstream_key,
                        channel,
                        &direct_body,
                        &provider_headers,
                    )
                    .await
                    .map_err(|err| {
                        AdminChannelProbeError::bad_gateway(
                            "channel_test_upstream_fetch_failed",
                            format!(
                                "AI Gateway probe failed ({gateway_error}) and direct fallback failed: {err}"
                            ),
                        )
                    })?;
                    Ok(ForwardedAdminChannelProbe {
                        response,
                        transport: "ai_gateway_direct_fallback",
                        effective_model: effective_body_model(
                            &direct_body,
                            &prepared.effective_model,
                        ),
                    })
                }
            }
        }
        direct_plan @ (AdminProbeTransportPlan::Direct | AdminProbeTransportPlan::Wfp) => {
            let direct_body = prepare_same_channel_direct_body(
                &prepared.body,
                channel.channel_type,
                &prepared.endpoint.upstream_path,
            )
            .map_err(|err| {
                AdminChannelProbeError::new(
                    422,
                    "channel_test_model_mapping_invalid",
                    format!("failed to prepare direct channel probe body: {err}"),
                )
            })?;
            let body = direct_body.as_ref().unwrap_or(&prepared.body);
            let transport = direct_plan.name();
            let response = forward_relay_request(
                env,
                prepared.provider,
                &prepared.upstream_url,
                &prepared.upstream_key,
                channel,
                body,
                &provider_headers,
            )
            .await
            .map_err(|err| {
                AdminChannelProbeError::bad_gateway(
                    "channel_test_upstream_fetch_failed",
                    format!("channel probe request failed: {err}"),
                )
            })?;
            Ok(ForwardedAdminChannelProbe {
                response,
                transport,
                effective_model: effective_body_model(body, &prepared.effective_model),
            })
        }
    }
}

struct AdminProbeValidation {
    mode: &'static str,
    content_type: String,
}

fn response_content_type_strict(response: &Response) -> Result<String, AdminChannelProbeError> {
    response
        .headers()
        .get("content-type")
        .map_err(|err| {
            AdminChannelProbeError::bad_gateway(
                "channel_test_content_type_invalid",
                format!("failed to inspect channel probe content-type: {err}"),
            )
        })?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AdminChannelProbeError::bad_gateway(
                "channel_test_content_type_invalid",
                "channel probe response is missing content-type",
            )
        })
}

fn content_type_media_type(content_type: &str) -> &str {
    content_type.split(';').next().unwrap_or_default().trim()
}

fn is_json_response_content_type(content_type: &str) -> bool {
    let media_type = content_type_media_type(content_type).to_ascii_lowercase();
    media_type == "application/json" || media_type.ends_with("+json")
}

fn is_sse_response_content_type(content_type: &str) -> bool {
    content_type_media_type(content_type).eq_ignore_ascii_case("text/event-stream")
}

fn nonempty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn admin_probe_json_shape_valid(endpoint: AdminProbeEndpoint, value: &Value) -> bool {
    match endpoint {
        AdminProbeEndpoint::OpenAi | AdminProbeEndpoint::OpenAiCompletions => {
            nonempty_array(value.get("choices"))
        }
        AdminProbeEndpoint::OpenAiResponse | AdminProbeEndpoint::OpenAiResponseCompact => {
            value.is_object()
                && (nonempty_array(value.get("output"))
                    || value
                        .get("object")
                        .and_then(Value::as_str)
                        .is_some_and(|object| object.starts_with("response"))
                    || value.get("compacted_prompt").is_some_and(Value::is_string))
        }
        AdminProbeEndpoint::Anthropic => {
            value.get("type").and_then(Value::as_str) == Some("message")
                && nonempty_array(value.get("content"))
        }
        AdminProbeEndpoint::Gemini => nonempty_array(value.get("candidates")),
        AdminProbeEndpoint::JinaRerank => nonempty_array(value.get("results")),
        AdminProbeEndpoint::ImageGeneration => {
            nonempty_array(value.get("data")) || nonempty_array(value.get("images"))
        }
        AdminProbeEndpoint::Embeddings => {
            value
                .get("data")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    !items.is_empty()
                        && items
                            .iter()
                            .all(|item| item.get("embedding").is_some_and(Value::is_array))
                })
        }
        AdminProbeEndpoint::Auto => false,
    }
}

fn admin_probe_sse_event_shape_valid(endpoint: AdminProbeEndpoint, value: &Value) -> bool {
    match endpoint {
        AdminProbeEndpoint::OpenAi | AdminProbeEndpoint::OpenAiCompletions => {
            value.get("choices").is_some_and(Value::is_array)
                || value.get("object").and_then(Value::as_str) == Some("chat.completion.chunk")
        }
        AdminProbeEndpoint::OpenAiResponse => value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|event_type| {
                event_type.starts_with("response.")
                    && !matches!(event_type, "response.failed" | "response.error")
            }),
        AdminProbeEndpoint::Anthropic => {
            value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|event_type| {
                    event_type.starts_with("message_") || event_type.starts_with("content_block_")
                })
        }
        AdminProbeEndpoint::Gemini => nonempty_array(value.get("candidates")),
        AdminProbeEndpoint::Auto
        | AdminProbeEndpoint::OpenAiResponseCompact
        | AdminProbeEndpoint::JinaRerank
        | AdminProbeEndpoint::ImageGeneration
        | AdminProbeEndpoint::Embeddings => false,
    }
}

fn admin_probe_sse_has_valid_event(
    endpoint: AdminProbeEndpoint,
    bytes: &[u8],
    include_trailing_event: bool,
) -> Result<bool, ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let normalized = text.replace("\r\n", "\n");
    let events = normalized.split("\n\n").collect::<Vec<_>>();
    let event_count = if include_trailing_event || normalized.ends_with("\n\n") {
        events.len()
    } else {
        events.len().saturating_sub(1)
    };
    for event in events.into_iter().take(event_count) {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if admin_probe_sse_event_shape_valid(endpoint, &value) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn validate_admin_probe_sse_response(
    response: &mut Response,
    endpoint: AdminProbeEndpoint,
) -> Result<(), AdminChannelProbeError> {
    let mut bytes = Vec::new();
    match response.body() {
        ResponseBody::Empty => {}
        ResponseBody::Body(body) => {
            if body.len() > ADMIN_CHANNEL_PROBE_SSE_LIMIT_BYTES {
                return Err(AdminChannelProbeError::bad_gateway(
                    "channel_test_response_too_large",
                    format!(
                        "channel probe SSE response exceeds {} bytes",
                        ADMIN_CHANNEL_PROBE_SSE_LIMIT_BYTES
                    ),
                ));
            }
            bytes.extend_from_slice(body);
        }
        ResponseBody::Stream(_) => {
            let mut stream = response.stream().map_err(|err| {
                AdminChannelProbeError::bad_gateway(
                    "channel_test_response_read_failed",
                    format!("failed to open channel probe SSE stream: {err}"),
                )
            })?;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|err| {
                    AdminChannelProbeError::bad_gateway(
                        "channel_test_response_read_failed",
                        format!("failed to read channel probe SSE stream: {err}"),
                    )
                })?;
                let next_len = bytes.len().checked_add(chunk.len()).ok_or_else(|| {
                    AdminChannelProbeError::bad_gateway(
                        "channel_test_response_too_large",
                        "channel probe SSE response size overflowed",
                    )
                })?;
                if next_len > ADMIN_CHANNEL_PROBE_SSE_LIMIT_BYTES {
                    return Err(AdminChannelProbeError::bad_gateway(
                        "channel_test_response_too_large",
                        format!(
                            "channel probe SSE response exceeds {} bytes",
                            ADMIN_CHANNEL_PROBE_SSE_LIMIT_BYTES
                        ),
                    ));
                }
                bytes.extend_from_slice(&chunk);
                match admin_probe_sse_has_valid_event(endpoint, &bytes, false) {
                    Ok(true) => return Ok(()),
                    Ok(false) | Err(()) => {}
                }
            }
        }
    }
    match admin_probe_sse_has_valid_event(endpoint, &bytes, true) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AdminChannelProbeError::bad_gateway(
            "channel_test_sse_event_missing",
            "channel probe SSE response did not contain a non-DONE JSON data event",
        )),
        Err(()) => Err(AdminChannelProbeError::bad_gateway(
            "channel_test_sse_invalid_utf8",
            "channel probe SSE response is not valid UTF-8",
        )),
    }
}

async fn validate_admin_channel_probe_response(
    response: &mut Response,
    endpoint: AdminProbeEndpoint,
    stream: bool,
    max_json_response_bytes: usize,
) -> Result<AdminProbeValidation, AdminChannelProbeError> {
    let status = response.status_code();
    if !(200..300).contains(&status) {
        return Err(AdminChannelProbeError::bad_gateway(
            "channel_test_upstream_status",
            format!("channel probe upstream returned status {status}"),
        ));
    }
    let content_type = response_content_type_strict(response)?;
    if stream {
        if !is_sse_response_content_type(&content_type) {
            return Err(AdminChannelProbeError::bad_gateway(
                "channel_test_content_type_invalid",
                format!(
                    "streaming channel probe requires text/event-stream, received {content_type}"
                ),
            ));
        }
        validate_admin_probe_sse_response(response, endpoint).await?;
        return Ok(AdminProbeValidation {
            mode: "sse",
            content_type,
        });
    }
    if !is_json_response_content_type(&content_type) {
        return Err(AdminChannelProbeError::bad_gateway(
            "channel_test_content_type_invalid",
            format!("non-stream channel probe requires JSON, received {content_type}"),
        ));
    }
    let body = read_response_text_limited(response, max_json_response_bytes)
        .await
        .map_err(|err| {
            let error_code = if matches!(err, RelayBufferedTextError::TooLarge { .. }) {
                "channel_test_response_too_large"
            } else {
                "channel_test_response_read_failed"
            };
            AdminChannelProbeError::bad_gateway(
                error_code,
                err.message("channel probe JSON response"),
            )
        })?;
    let value = serde_json::from_str::<Value>(&body).map_err(|_| {
        AdminChannelProbeError::bad_gateway(
            "channel_test_response_json_invalid",
            "channel probe response is not valid JSON",
        )
    })?;
    if !admin_probe_json_shape_valid(endpoint, &value) {
        return Err(AdminChannelProbeError::bad_gateway(
            "channel_test_response_shape_invalid",
            format!(
                "channel probe response does not match the {} endpoint shape",
                endpoint.as_str()
            ),
        ));
    }
    Ok(AdminProbeValidation {
        mode: "json",
        content_type,
    })
}

async fn execute_admin_channel_probe_inner(
    env: &Env,
    channel: &RelayChannel,
    request: &AdminChannelProbeRequest,
) -> Result<AdminChannelProbeResult, AdminChannelProbeError> {
    let inject_stream_options = stream_options_inject_enabled(env);
    let ali_messages_model_patterns = optional_env_var(env, ALI_ANTHROPIC_MESSAGES_MODELS_ENV);
    let prepared = prepare_admin_channel_probe(
        channel,
        request,
        inject_stream_options,
        ali_messages_model_patterns.as_deref(),
    )?;
    let max_json_response_bytes = RelayJsonResponseConfig::from_env(env)
        .map_err(|err| {
            AdminChannelProbeError::new(
                500,
                "channel_test_response_limit_invalid",
                format!("invalid channel probe response limit: {err}"),
            )
        })?
        .max_bytes_for(&prepared.endpoint);
    let ai_gateway_runtime = RelayAiGatewayRuntime::from_env(env);
    let transport_plan = plan_admin_probe_transport(
        ai_gateway_runtime.as_ref(),
        &prepared.endpoint,
        channel,
        &prepared.upstream_url,
        &prepared.effective_model,
        request.stream,
    )?;
    let started = js_sys::Date::now();
    let mut forwarded =
        forward_admin_channel_probe(env, channel, &prepared, transport_plan).await?;
    let validation = validate_admin_channel_probe_response(
        &mut forwarded.response,
        prepared.endpoint_type,
        request.stream,
        max_json_response_bytes,
    )
    .await?;
    let response_time_ms = (js_sys::Date::now() - started).max(0.0);
    Ok(AdminChannelProbeResult {
        requested_model: request.model.clone(),
        requested_endpoint_type: request.endpoint_type.as_str(),
        requested_stream: request.stream,
        effective_model: forwarded.effective_model,
        effective_endpoint_type: prepared.endpoint_type.as_str(),
        effective_route: prepared.effective_route,
        effective_stream: request.stream,
        transport: forwarded.transport,
        response_time_ms,
        validation_mode: validation.mode,
        content_type: validation.content_type,
    })
}

pub(crate) async fn execute_admin_channel_probe(
    env: &Env,
    channel: &RelayChannel,
    request: AdminChannelProbeRequest,
) -> Result<AdminChannelProbeResult, AdminChannelProbeError> {
    let probe = execute_admin_channel_probe_inner(env, channel, &request);
    let timeout = Delay::from(ADMIN_CHANNEL_PROBE_TIMEOUT);
    futures_util::pin_mut!(probe);
    futures_util::pin_mut!(timeout);
    match select(probe, timeout).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err(AdminChannelProbeError::new(
            504,
            "channel_test_timeout",
            format!(
                "channel probe exceeded {} seconds",
                ADMIN_CHANNEL_PROBE_TIMEOUT.as_secs()
            ),
        )),
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
            route: ProviderRelayRoute::ChatCompletions,
            upstream_path: "chat/completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: Some(validate_chat_completions_request),
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
            route: ProviderRelayRoute::ChatCompletions,
            upstream_path: "chat/completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: Some(validate_chat_completions_request),
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
            route: ProviderRelayRoute::Embeddings,
            upstream_path: "embeddings".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Embeddings,
            upstream_path: "embeddings".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Rerank,
            upstream_path: "rerank".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::ImageGenerations,
            upstream_path: "images/generations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::AudioSpeech,
            upstream_path: "audio/speech".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::AudioTranscriptions,
            upstream_path: "audio/transcriptions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::AudioTranslations,
            upstream_path: "audio/translations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::ImageEdits,
            upstream_path: "images/edits".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Completions,
            upstream_path: "completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Moderations,
            upstream_path: "moderations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Edits,
            upstream_path: "edits".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::ResponsesCompact,
            upstream_path: "responses/compact".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Responses,
            upstream_path: "responses".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::AnthropicMessages,
            upstream_path: "messages".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::AnthropicMessages,
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
            route: ProviderRelayRoute::GeminiNative,
            upstream_path: route.upstream_path(),
            upstream_query: query,
            gemini_route: Some(route.clone()),
            provider: RelayProviderKind::GeminiNative,
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
    let mut billing_request_input = prepared_request.billing_request_input;
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

    if let Err(response) = enforce_relay_rate_limits(
        &env,
        &auth,
        client_ip.as_deref(),
        endpoint.route.cache_family(),
    )
    .await
    {
        return response;
    }

    let retry_config = match RelayRetryConfig::from_env(&env) {
        Ok(config) => config,
        Err(err) => {
            return openai_error_response(format!("invalid relay retry configuration: {err}"), 500);
        }
    };
    let model_fallback_config = match RelayModelFallbackConfig::from_env(&env) {
        Ok(config) => config,
        Err(err) => {
            return openai_error_response(
                format!("invalid relay model fallback configuration: {err}"),
                500,
            );
        }
    };
    let configured_fallback_model = model_fallback_config
        .as_ref()
        .and_then(|config| config.fallback_for(&model))
        .map(str::to_string);
    let mut model_route_audit =
        RelayModelRouteAudit::primary(&model, configured_fallback_model.as_deref());
    let mut served_model = model.clone();
    let ali_messages_model_patterns = optional_env_var(&env, ALI_ANTHROPIC_MESSAGES_MODELS_ENV);

    // Resolve the candidate pool(s). For an "auto" token group, walk the user's
    // auto groups (Go `CacheGetRandomSatisfiedChannel`); otherwise a single group.
    let is_auto = group == "auto";
    let supported_channel_types = channel_types_for_relay_route(endpoint.route);
    let mut group_pools = match resolve_relay_group_pools(
        &db,
        &env,
        &model,
        &group,
        &auth.user_group,
        endpoint.route.cache_family(),
        &supported_channel_types,
    )
    .await
    {
        Ok(pools) => pools,
        Err(response) => return response,
    };
    retain_route_capable_channels(&mut group_pools, Some(endpoint.route));
    let tencent_is_only_stream_candidate = should_relay_stream
        && group_pools
            .iter()
            .flat_map(|(_, channels)| channels)
            .any(|channel| channel.channel_type == CHANNEL_TYPE_TENCENT)
        && group_pools
            .iter()
            .flat_map(|(_, channels)| channels)
            .all(|channel| channel.channel_type == CHANNEL_TYPE_TENCENT);
    retain_pre_reserve_capable_channels(
        &mut group_pools,
        &endpoint,
        should_relay_stream,
        json_body.as_ref(),
        ali_messages_model_patterns.as_deref(),
    );
    if tencent_is_only_stream_candidate
        && group_pools.iter().all(|(_, channels)| channels.is_empty())
    {
        return json_with_status(
            &ErrorBody::not_implemented("Tencent Hunyuan streaming relay"),
            501,
        );
    }

    // Go applies the per-token cross-group switch only to `auto` tokens. Empty
    // groups can still be skipped during initial selection, but retry
    // exhaustion must not advance to another non-empty group when disabled.
    let cross_group_retry = auth.cross_group_retry_enabled();
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
    let mut affinity_key =
        affinity::affinity_enabled(optional_env_var(&env, affinity::AFFINITY_ENABLED_ENV))
            .then(|| affinity::affinity_key(auth.user_id, &model, &group));
    let attempt_plan = if let Some(key) = affinity_key.as_deref() {
        let preferred = affinity::lookup_preferred_channel(&env, key).await;
        affinity::move_preferred_to_front(attempt_plan, preferred, |plan| plan.channel.id)
    } else {
        attempt_plan
    };

    // Freeze one expression result for every possible serving group, reserve
    // the maximum candidate-group estimate once, then settle with the snapshot
    // belonging to the group that actually returns the final response.
    let billing_groups = attempt_plan
        .iter()
        .map(|plan| plan.group.clone())
        .collect::<Vec<_>>();
    model_route_audit.cross_group_retry = cross_group_retry;
    model_route_audit.primary_planned_group_count = unique_group_count(&billing_groups);
    let mut tiered_billing_group_plan = match prepare_tiered_billing_group_plan(
        &db,
        &model,
        &auth.user_group,
        &billing_groups,
        json_body.as_ref().unwrap_or(&Value::Null),
        &billing_request_input,
        endpoint.uses_openai_chat_format(),
        extra_prompt_tokens,
    )
    .await
    {
        Ok(plan) => plan,
        Err(err) => {
            return openai_error_response(format!("tiered billing preflight failed: {err}"), 500);
        }
    };
    if let Some(plan) = tiered_billing_group_plan.as_mut() {
        if let Err(err) = reserve_tiered_billing_group_plan(
            &db,
            &auth,
            plan,
            &model,
            &endpoint.upstream_path,
            request_id.as_deref(),
            relay_billing_reservation_lease_seconds(&env),
            unix_timestamp(),
        )
        .await
        {
            return openai_error_response(
                format!("tiered billing reserve failed: {err}"),
                quota_mutation_error_status(&err),
            );
        }
    }
    let mut tiered_billing_preflight: Option<TieredBillingPreflight> = None;
    let mut terminal_reserve_refund = if tiered_billing_group_plan
        .as_ref()
        .is_some_and(|plan| plan.reserve_applied)
    {
        "pending"
    } else {
        "not_reserved"
    };

    let mut last_failure: Option<RelayAttemptFailure> = None;
    let mut attempt_audits = RelayAttemptAuditLedger::default();
    // (channel, selected group, upstream response). The group is the actual
    // serving group and selects the authoritative billing snapshot.
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
        let attempt_provider = endpoint.effective_provider(channel.channel_type);

        let upstream_key = match first_channel_key(&channel.key) {
            Some(key) => key,
            None => {
                let failure = RelayAttemptFailure::no_key(
                    channel.id,
                    channel.name.clone(),
                    channel.ai_gateway_opted_in(),
                );
                attempt_audits.push(RelayAttemptAudit::from_failure(
                    "primary",
                    &model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
                continue;
            }
        };

        let upstream_url = match endpoint.try_upstream_url(&channel) {
            Ok(url) => url,
            Err(err) => {
                let failure = RelayAttemptFailure::configuration_error(
                    channel.id,
                    channel.name.clone(),
                    err.to_string(),
                    channel.ai_gateway_opted_in(),
                );
                attempt_audits.push(RelayAttemptAudit::from_failure(
                    "primary",
                    &model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
                continue;
            }
        };

        let mut forward_error_kind = RelayAttemptFailureKind::FetchError;
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
                if let Err(error) = apply_endpoint_request_transform(
                    &mut upstream_body,
                    &endpoint.upstream_path,
                    &channel,
                ) {
                    let failure = RelayAttemptFailure::configuration_error(
                        channel.id,
                        channel.name.clone(),
                        error.to_string(),
                        channel.ai_gateway_opted_in(),
                    );
                    attempt_audits.push(RelayAttemptAudit::from_failure(
                        "primary",
                        &model,
                        &selected_group,
                        &failure,
                    ));
                    last_failure = Some(failure);
                    continue;
                }
                apply_provider_request_transform(&mut upstream_body, attempt_provider);
                // Inject/strip `stream_options.include_usage` for OpenAI-compatible
                // upstreams (Go parity) so supporting channels emit a real usage
                // chunk instead of forcing the local estimate. Native Anthropic/
                // Gemini providers carry usage natively and are left untouched.
                if inject_stream_options && provider_uses_openai_stream_options(attempt_provider) {
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
                        Some(runtime) => {
                            match plan_relay_ai_gateway_attempt(
                                runtime,
                                &endpoint,
                                &channel,
                                upstream_model,
                            ) {
                                Ok(Some(attempt)) => {
                                    match forward_ai_gateway_rest(&attempt, runtime, &upstream_body)
                                        .await
                                    {
                                        Ok(response) => {
                                            let status = response.status_code();
                                            if should_ai_gateway_direct_fallback(status) {
                                                if let Some(direct_body) =
                                                    prepare_ai_gateway_direct_fallback_body(
                                                        &upstream_body,
                                                        &attempt,
                                                    )
                                                {
                                                    worker::console_warn!(
                                                    "relay AI Gateway returned server status {}; falling back to direct provider for channel {}",
                                                    status,
                                                    channel.id
                                                );
                                                    forward_relay_request(
                                                        &env,
                                                        attempt_provider,
                                                        &upstream_url,
                                                        &upstream_key,
                                                        &channel,
                                                        &direct_body,
                                                        &provider_headers,
                                                    )
                                                    .await
                                                    .and_then(|response| {
                                                        mark_ai_gateway_direct_fallback(
                                                            response,
                                                            &format!("gateway_status_{status}"),
                                                        )
                                                    })
                                                } else {
                                                    Ok(response)
                                                }
                                            } else {
                                                Ok(response)
                                            }
                                        }
                                        Err(err) => {
                                            if let Some(direct_body) =
                                                prepare_ai_gateway_direct_fallback_body(
                                                    &upstream_body,
                                                    &attempt,
                                                )
                                            {
                                                worker::console_warn!(
                                                "relay AI Gateway fetch failed; falling back to direct provider for channel {}: {}",
                                                channel.id,
                                                err
                                            );
                                                forward_relay_request(
                                                    &env,
                                                    attempt_provider,
                                                    &upstream_url,
                                                    &upstream_key,
                                                    &channel,
                                                    &direct_body,
                                                    &provider_headers,
                                                )
                                                .await
                                                .and_then(|response| {
                                                    mark_ai_gateway_direct_fallback(
                                                        response,
                                                        "gateway_fetch_error",
                                                    )
                                                })
                                            } else {
                                                Err(err)
                                            }
                                        }
                                    }
                                }
                                Ok(None) => {
                                    match prepare_same_channel_direct_body(
                                        &upstream_body,
                                        channel.channel_type,
                                        &endpoint.upstream_path,
                                    ) {
                                        Ok(direct_body) => {
                                            forward_relay_request(
                                                &env,
                                                attempt_provider,
                                                &upstream_url,
                                                &upstream_key,
                                                &channel,
                                                direct_body.as_ref().unwrap_or(&upstream_body),
                                                &provider_headers,
                                            )
                                            .await
                                        }
                                        Err(err) => {
                                            forward_error_kind =
                                                RelayAttemptFailureKind::ConfigurationError;
                                            Err(err)
                                        }
                                    }
                                }
                                Err(err) => {
                                    forward_error_kind =
                                        RelayAttemptFailureKind::ConfigurationError;
                                    Err(err)
                                }
                            }
                        }
                        None => {
                            match prepare_same_channel_direct_body(
                                &upstream_body,
                                channel.channel_type,
                                &endpoint.upstream_path,
                            ) {
                                Ok(direct_body) => {
                                    forward_relay_request(
                                        &env,
                                        attempt_provider,
                                        &upstream_url,
                                        &upstream_key,
                                        &channel,
                                        direct_body.as_ref().unwrap_or(&upstream_body),
                                        &provider_headers,
                                    )
                                    .await
                                }
                                Err(err) => {
                                    forward_error_kind =
                                        RelayAttemptFailureKind::ConfigurationError;
                                    Err(err)
                                }
                            }
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
                if let Err(err) = ensure_wfp_json_body(&channel) {
                    forward_error_kind = RelayAttemptFailureKind::ConfigurationError;
                    Err(err)
                } else {
                    forward_raw_openai_compatible(
                        &upstream_url,
                        &upstream_key,
                        &channel,
                        bytes,
                        content_type,
                    )
                    .await
                }
            }
        };

        match forward_result {
            Ok(mut response) => {
                let status = response.status_code();
                if is_retryable_status(status) {
                    record_retryable_channel_failure(&env, &channel, status).await;
                    let failure = RelayAttemptFailure::retryable_status(
                        channel.id,
                        channel.name.clone(),
                        status,
                        channel.ai_gateway_opted_in(),
                    );
                    attempt_audits.push(RelayAttemptAudit::from_failure(
                        "primary",
                        &model,
                        &selected_group,
                        &failure,
                    ));
                    last_failure = Some(failure);
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
                let failure = RelayAttemptFailure::with_detail(
                    forward_error_kind,
                    channel.id,
                    channel.name.clone(),
                    err.to_string(),
                    channel.ai_gateway_opted_in(),
                );
                attempt_audits.push(RelayAttemptAudit::from_failure(
                    "primary",
                    &model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
                continue;
            }
        }
    }

    let fallback_trigger = selected_attempt
        .as_ref()
        .and_then(|(_, _, response)| {
            let status = response.status_code();
            should_model_fallback_status(status).then(|| format!("upstream_status_{status}"))
        })
        .or_else(|| {
            (selected_attempt.is_none()).then(|| {
                last_failure
                    .as_ref()
                    .and_then(|failure| match failure.kind {
                        RelayAttemptFailureKind::FetchError => Some("fetch_exhausted".to_string()),
                        RelayAttemptFailureKind::ConfigurationError
                        | RelayAttemptFailureKind::NoUsableKey
                        | RelayAttemptFailureKind::RetryableStatus => None,
                    })
            })?
        });

    if let (Some(fallback_model), Some(trigger)) =
        (configured_fallback_model.as_deref(), fallback_trigger)
    {
        model_route_audit.fallback_trigger = Some(trigger);
        let primary_ai_gateway_opted_in = selected_attempt
            .as_ref()
            .map(|(channel, _, _)| channel.ai_gateway_opted_in())
            .or_else(|| {
                last_failure
                    .as_ref()
                    .map(|failure| failure.ai_gateway_opted_in)
            })
            .unwrap_or(false);
        if ai_gateway_runtime.is_none() {
            model_route_audit.fallback_skip_reason =
                Some("ai_gateway_router_not_ready".to_string());
        } else if !primary_ai_gateway_opted_in {
            model_route_audit.fallback_skip_reason =
                Some("primary_channel_not_opted_in".to_string());
        } else if !relay_model_fallback_supported(&endpoint) {
            model_route_audit.fallback_skip_reason = Some("endpoint_not_supported".to_string());
        } else if !model_allowed_for_token(
            auth.model_limits_enabled,
            &auth.model_limits,
            fallback_model,
        ) {
            model_route_audit.fallback_skip_reason = Some("token_model_limit".to_string());
        } else {
            if let Some(plan) = tiered_billing_group_plan
                .as_ref()
                .filter(|plan| plan.reserve_applied)
            {
                if let Err(err) = refund_tiered_billing_group_plan(
                    &db,
                    &auth,
                    plan,
                    "model_fallback",
                    unix_timestamp(),
                )
                .await
                {
                    return openai_error_response(
                        format!(
                            "primary tiered billing reserve refund failed before model fallback: {err}"
                        ),
                        500,
                    );
                }
                terminal_reserve_refund = "primary_refunded_for_fallback";
            }
            tiered_billing_group_plan = None;
            tiered_billing_preflight = None;

            let mut fallback_group_pools = match resolve_relay_group_pools(
                &db,
                &env,
                fallback_model,
                &group,
                &auth.user_group,
                endpoint.route.cache_family(),
                &supported_channel_types,
            )
            .await
            {
                Ok(pools) => pools,
                Err(response) => return response,
            };
            retain_route_capable_channels(&mut fallback_group_pools, Some(endpoint.route));
            retain_pre_reserve_capable_channels(
                &mut fallback_group_pools,
                &endpoint,
                should_relay_stream,
                json_body.as_ref(),
                ali_messages_model_patterns.as_deref(),
            );
            for (_, candidates) in &mut fallback_group_pools {
                candidates.retain(RelayChannel::ai_gateway_opted_in);
            }
            let fallback_attempt_plan = plan_relay_attempts(
                fallback_group_pools,
                is_auto,
                retry_config.max_attempts(),
                retry_config.retry_times as i32,
                cross_group_retry,
                random_u64_below,
            )?;
            let fallback_affinity_key =
                affinity::affinity_enabled(optional_env_var(&env, affinity::AFFINITY_ENABLED_ENV))
                    .then(|| affinity::affinity_key(auth.user_id, fallback_model, &group));
            let fallback_attempt_plan = if let Some(key) = fallback_affinity_key.as_deref() {
                let preferred = affinity::lookup_preferred_channel(&env, key).await;
                affinity::move_preferred_to_front(fallback_attempt_plan, preferred, |plan| {
                    plan.channel.id
                })
            } else {
                fallback_attempt_plan
            };

            if fallback_attempt_plan.is_empty() {
                model_route_audit.fallback_skip_reason = Some("no_fallback_channel".to_string());
            } else {
                let fallback_billing_groups = fallback_attempt_plan
                    .iter()
                    .map(|plan| plan.group.clone())
                    .collect::<Vec<_>>();
                model_route_audit.fallback_planned_group_count =
                    Some(unique_group_count(&fallback_billing_groups));
                let mut fallback_request_body = json_body
                    .clone()
                    .unwrap_or_else(|| Value::Object(Default::default()));
                apply_model_attempt_body(&mut fallback_request_body, fallback_model, None);
                let mut fallback_billing_request_input = billing_request_input.clone();
                fallback_billing_request_input.body = Some(fallback_request_body.clone());
                let mut fallback_group_plan = match prepare_tiered_billing_group_plan(
                    &db,
                    fallback_model,
                    &auth.user_group,
                    &fallback_billing_groups,
                    &fallback_request_body,
                    &fallback_billing_request_input,
                    endpoint.uses_openai_chat_format(),
                    extra_prompt_tokens,
                )
                .await
                {
                    Ok(plan) => plan,
                    Err(err) => {
                        return openai_error_response(
                            format!("fallback tiered billing preflight failed: {err}"),
                            500,
                        );
                    }
                };
                if let Some(plan) = fallback_group_plan.as_mut() {
                    if let Err(err) = reserve_tiered_billing_group_plan(
                        &db,
                        &auth,
                        plan,
                        fallback_model,
                        &endpoint.upstream_path,
                        request_id.as_deref(),
                        relay_billing_reservation_lease_seconds(&env),
                        unix_timestamp(),
                    )
                    .await
                    {
                        return openai_error_response(
                            format!("fallback tiered billing reserve failed: {err}"),
                            quota_mutation_error_status(&err),
                        );
                    }
                    terminal_reserve_refund = "pending_fallback";
                }

                let primary_selected_attempt = selected_attempt.take();
                let primary_failure = last_failure.take();
                model_route_audit.fallback_attempted = true;
                let mut fallback_execution = execute_relay_attempt_plan(
                    fallback_attempt_plan,
                    &env,
                    &mut endpoint,
                    &request_body,
                    Some(&fallback_request_body),
                    auth_mode,
                    fallback_model,
                    should_relay_stream,
                    inject_stream_options,
                    keyword_ban_enabled,
                    ai_gateway_runtime.as_ref(),
                    &provider_headers,
                )
                .await;
                attempt_audits.append(&mut fallback_execution.attempts);
                if let Some(fallback_selected) = fallback_execution.selected_attempt {
                    let fallback_selected_group = fallback_selected.1.clone();
                    tiered_billing_preflight = match fallback_group_plan.as_ref() {
                        Some(plan) => match plan.selected_preflight(&fallback_selected_group) {
                            Some(preflight) => Some(preflight),
                            None => {
                                return openai_error_response(
                                    format!(
                                        "fallback billing snapshot missing for selected group {fallback_selected_group}"
                                    ),
                                    500,
                                );
                            }
                        },
                        None => None,
                    };
                    selected_attempt = Some(fallback_selected);
                    last_failure = fallback_execution.last_failure;
                    billing_request_input = fallback_billing_request_input;
                    served_model = fallback_model.to_string();
                    model_route_audit.served_model = fallback_model.to_string();
                    affinity_key = fallback_affinity_key;
                } else {
                    if let Some(plan) = fallback_group_plan
                        .as_ref()
                        .filter(|plan| plan.reserve_applied)
                    {
                        if let Err(err) = refund_tiered_billing_group_plan(
                            &db,
                            &auth,
                            plan,
                            "fallback_exhausted",
                            unix_timestamp(),
                        )
                        .await
                        {
                            return openai_error_response(
                                format!(
                                    "fallback tiered billing reserve refund failed after attempt exhaustion: {err}"
                                ),
                                500,
                            );
                        }
                        terminal_reserve_refund = "fallback_refunded";
                    }
                    selected_attempt = primary_selected_attempt;
                    last_failure = fallback_execution.last_failure.or(primary_failure);
                }
            }
        }
    }

    let Some((channel, selected_group, mut upstream_response)) = selected_attempt else {
        // Every attempt failed with a fetch error or unconfigurable channel.
        // Refund the tiered reserve (if any) and return a structured error
        // describing the last failure.
        let mut refund_error = None;
        if let Some(plan) = tiered_billing_group_plan
            .as_ref()
            .filter(|plan| plan.reserve_applied)
        {
            match refund_tiered_billing_group_plan(
                &db,
                &auth,
                plan,
                "attempts_exhausted",
                unix_timestamp(),
            )
            .await
            {
                Ok(()) => terminal_reserve_refund = "refunded",
                Err(err) => {
                    terminal_reserve_refund = "refund_failed";
                    refund_error = Some(err);
                }
            }
        }
        let now = unix_timestamp();
        let terminal_audit_event_id = random_terminal_audit_event_id();
        let event = terminal_relay_failure_event(
            now,
            started_at,
            &auth,
            &model,
            &group,
            &endpoint.upstream_path,
            client_ip.as_deref(),
            request_id.as_deref(),
            should_relay_stream,
            &model_route_audit,
            &attempt_audits,
            last_failure.as_ref(),
            terminal_audit_event_id.as_deref(),
            terminal_reserve_refund,
        );
        if let Err(err) = persist_audit_log_event(&env, &db, &event).await {
            worker::console_error!("failed to record terminal relay attempt audit: {err}");
        }
        if let Some(refund_err) = refund_error {
            return openai_error_response(
                format!(
                    "tiered billing reserve refund failed after all retry attempts: {refund_err}"
                ),
                500,
            );
        }
        return match last_failure {
            Some(RelayAttemptFailure {
                kind: RelayAttemptFailureKind::ConfigurationError,
                channel_id,
                channel_name,
                ..
            }) => json_with_status(
                &ErrorBody::bad_request(format!(
                    "relay configuration failed for channel {channel_id} ({channel_name})"
                )),
                502,
            ),
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
    let selected_provider = endpoint.effective_provider(channel.channel_type);
    model_route_audit.wfp_worker = channel.wfp_worker();
    if tiered_billing_preflight.is_none() {
        tiered_billing_preflight = match tiered_billing_group_plan.as_ref() {
            Some(plan) => match plan.selected_preflight(&selected_group) {
                Some(preflight) => Some(preflight),
                None => {
                    return openai_error_response(
                        format!(
                            "billing snapshot missing for actual serving group {selected_group}"
                        ),
                        500,
                    );
                }
            },
            None => None,
        };
    }
    if let Some(preflight) = tiered_billing_preflight
        .as_mut()
        .filter(|preflight| preflight.reserve_applied)
    {
        let selected_at = unix_timestamp();
        let lease_seconds = relay_billing_reservation_lease_seconds(&env);
        if let Err(err) = bind_tiered_billing_selected_attempt(
            &db,
            preflight,
            channel.id,
            &selected_group,
            selected_at,
            lease_seconds,
        )
        .await
        {
            return openai_error_response(
                format!("failed to bind selected relay billing attempt: {err}"),
                500,
            );
        }
        preflight.selected_at = Some(selected_at);
        preflight.selected_lease_expires_at = Some(selected_at.saturating_add(lease_seconds));
    }
    if model_route_audit.wfp_worker.is_some() {
        strip_wfp_internal_response_headers(upstream_response.headers_mut())?;
    }
    let ai_gateway_direct_fallback = upstream_response
        .headers()
        .get(AI_GATEWAY_DIRECT_FALLBACK_AUDIT_HEADER)?;
    if ai_gateway_direct_fallback.is_some() {
        upstream_response
            .headers_mut()
            .delete(AI_GATEWAY_DIRECT_FALLBACK_AUDIT_HEADER)?;
    }
    model_route_audit.ai_gateway_direct_fallback = ai_gateway_direct_fallback;

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
            &served_model,
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
                        &served_model,
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
        missing_usage_estimate_enabled: relay_billing_missing_usage_estimate_enabled(&env),
        usage_locally_estimated: false,
        stream_lease_heartbeat: None,
        affinity: affinity_audit,
        model_route: model_route_audit,
        attempts: attempt_audits,
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
            served_model,
            selected_group,
            endpoint.upstream_path.clone(),
            selected_provider,
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
        served_model,
        selected_group,
        endpoint.upstream_path.clone(),
        selected_provider,
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

pub(crate) fn relay_retry_times_from_env(env: &Env) -> Option<u32> {
    RelayRetryConfig::from_env(env)
        .ok()
        .map(|config| config.retry_times)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayModelFallbackConfig {
    mappings: HashMap<String, String>,
}

impl RelayModelFallbackConfig {
    fn from_env(env: &Env) -> Result<Option<Self>, String> {
        Self::from_values(
            env_flag(optional_env_var(env, RELAY_MODEL_FALLBACK_ENABLED_ENV).as_deref()),
            optional_env_var(env, RELAY_MODEL_FALLBACKS_JSON_ENV),
        )
    }

    fn from_values(enabled: bool, raw: Option<String>) -> Result<Option<Self>, String> {
        if !enabled {
            return Ok(None);
        }
        let raw = raw
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "{RELAY_MODEL_FALLBACKS_JSON_ENV} is required when {RELAY_MODEL_FALLBACK_ENABLED_ENV}=true"
                )
            })?;
        let parsed = serde_json::from_str::<HashMap<String, String>>(raw).map_err(|err| {
            format!("{RELAY_MODEL_FALLBACKS_JSON_ENV} must be a JSON object: {err}")
        })?;
        if parsed.is_empty() {
            return Err(format!(
                "{RELAY_MODEL_FALLBACKS_JSON_ENV} must contain at least one mapping"
            ));
        }
        if parsed.len() > RELAY_MODEL_FALLBACKS_MAX_ENTRIES {
            return Err(format!(
                "{RELAY_MODEL_FALLBACKS_JSON_ENV} exceeds {RELAY_MODEL_FALLBACKS_MAX_ENTRIES} mappings"
            ));
        }
        let mut mappings = HashMap::with_capacity(parsed.len());
        for (primary, fallback) in parsed {
            let primary = primary.trim();
            let fallback = fallback.trim();
            if primary.is_empty() || fallback.is_empty() {
                return Err(format!(
                    "{RELAY_MODEL_FALLBACKS_JSON_ENV} model names must be non-empty"
                ));
            }
            if primary.chars().count() > RELAY_MODEL_FALLBACK_NAME_MAX_CHARS
                || fallback.chars().count() > RELAY_MODEL_FALLBACK_NAME_MAX_CHARS
            {
                return Err(format!(
                    "{RELAY_MODEL_FALLBACKS_JSON_ENV} model names must not exceed {RELAY_MODEL_FALLBACK_NAME_MAX_CHARS} characters"
                ));
            }
            if primary.eq_ignore_ascii_case(fallback) {
                return Err(format!(
                    "{RELAY_MODEL_FALLBACKS_JSON_ENV} cannot map a model to itself"
                ));
            }
            if !has_ai_gateway_provider_prefix(fallback) {
                return Err(format!(
                    "{RELAY_MODEL_FALLBACKS_JSON_ENV} fallback model {fallback} must use an AI Gateway provider prefix"
                ));
            }
            mappings.insert(primary.to_ascii_lowercase(), fallback.to_string());
        }
        Ok(Some(Self { mappings }))
    }

    fn fallback_for(&self, model: &str) -> Option<&str> {
        self.mappings
            .get(&model.trim().to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RelayModelFallbackRuntimeStatus {
    pub enabled: bool,
    pub configured: bool,
    pub valid: bool,
    pub mapping_count: usize,
}

pub(crate) fn relay_model_fallback_runtime_status(env: &Env) -> RelayModelFallbackRuntimeStatus {
    let enabled = env_flag(optional_env_var(env, RELAY_MODEL_FALLBACK_ENABLED_ENV).as_deref());
    match RelayModelFallbackConfig::from_env(env) {
        Ok(Some(config)) => RelayModelFallbackRuntimeStatus {
            enabled,
            configured: true,
            valid: true,
            mapping_count: config.mappings.len(),
        },
        Ok(None) => RelayModelFallbackRuntimeStatus {
            enabled,
            configured: false,
            valid: true,
            mapping_count: 0,
        },
        Err(_) => RelayModelFallbackRuntimeStatus {
            enabled,
            configured: false,
            valid: false,
            mapping_count: 0,
        },
    }
}

pub(crate) fn relay_model_fallback_contract_compiled() -> bool {
    RELAY_MODEL_FALLBACK_ENABLED_ENV == "RELAY_MODEL_FALLBACK_ENABLED"
        && RELAY_MODEL_FALLBACKS_JSON_ENV == "RELAY_MODEL_FALLBACKS_JSON"
        && RELAY_MODEL_FALLBACK_STAGING_VERIFIED_ENV == "RELAY_MODEL_FALLBACK_STAGING_VERIFIED"
        && relay_model_fallback_supported(&RelayEndpoint {
            display_name: "contract",
            route: ProviderRelayRoute::ChatCompletions,
            upstream_path: "chat/completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        })
        && !should_model_fallback_status(401)
        && !should_model_fallback_status(403)
        && !should_model_fallback_status(429)
        && should_model_fallback_status(500)
}

pub(crate) fn relay_ai_gateway_direct_fallback_contract_compiled() -> bool {
    !should_ai_gateway_direct_fallback(401)
        && !should_ai_gateway_direct_fallback(403)
        && !should_ai_gateway_direct_fallback(429)
        && should_ai_gateway_direct_fallback(500)
        && direct_provider_model_for_channel("openai/gpt-4.1", AiGatewayModelAuthor::OpenAi, 1)
            == Some("gpt-4.1")
        && direct_provider_model_for_channel(
            "deepseek/deepseek-chat",
            AiGatewayModelAuthor::DeepSeek,
            1,
        )
        .is_none()
        && direct_provider_model_for_channel(
            "mistral/mistral-large-latest",
            AiGatewayModelAuthor::Mistral,
            CHANNEL_TYPE_MISTRAL,
        ) == Some("mistral-large-latest")
        && direct_provider_model_for_channel(
            "perplexity/sonar-pro",
            AiGatewayModelAuthor::Perplexity,
            CHANNEL_TYPE_PERPLEXITY,
        ) == Some("sonar-pro")
        && direct_provider_model_for_channel(
            "xai/grok-4.5",
            AiGatewayModelAuthor::Xai,
            CHANNEL_TYPE_XAI,
        ) == Some("grok-4.5")
}

pub(crate) fn relay_terminal_attempt_audit_contract_compiled() -> bool {
    LOG_TYPE_ERROR == 5
        && RelayAttemptFailureKind::ConfigurationError.audit_label() == "configuration_error"
        && RelayAttemptFailureKind::FetchError.audit_label() == "fetch_error"
        && RelayAttemptFailureKind::NoUsableKey.audit_label() == "no_usable_key"
        && RelayAttemptFailureKind::RetryableStatus.audit_label() == "retryable_status"
}

pub(crate) fn relay_actual_serving_group_billing_contract_compiled() -> bool {
    RELAY_CACHE_SCHEMA_VERSION == 4
        && TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY == "max_candidate_group"
        && TIERED_BILLING_SELECTED_GROUP_STRATEGY == "selected_group"
        && settle(Quota(20), Quota(10)).refund_quota == Quota(10)
        && settle(Quota(10), Quota(20)).additional_quota == Quota(10)
}

pub(crate) fn relay_wfp_authority_transport_contract_compiled() -> bool {
    cinatoken_storage::channel_wfp_worker(r#"{"wfp_worker":"tenant-a"}"#).as_deref()
        == Some("tenant-a")
        && WFP_RELAY_SUPPORTED_PATHS
            == [
                "/v1/chat/completions",
                "/v1/responses",
                "/v1/messages",
                "/ai/run",
            ]
        && wfp_authority_contract_self_check()
}

fn wfp_authority_contract_self_check() -> bool {
    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    let body = br#"{"model":"openai/gpt-4.1"}"#;
    let Ok(token) = sign_authority(
        SECRET,
        AuthorityInput {
            worker: "tenant-a",
            method: "POST",
            path: "/v1/chat/completions",
            body,
            request_id: "contract",
            channel_id: 1,
            issued_at: 100,
        },
    ) else {
        return false;
    };
    verify_authority(
        SECRET,
        &token,
        AuthorityExpectation {
            worker: "tenant-a",
            method: "POST",
            path: "/v1/chat/completions",
            body,
            now: 101,
        },
    )
    .is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayModelRouteAudit {
    requested_model: String,
    served_model: String,
    fallback_model: Option<String>,
    fallback_attempted: bool,
    fallback_trigger: Option<String>,
    fallback_skip_reason: Option<String>,
    ai_gateway_direct_fallback: Option<String>,
    cross_group_retry: bool,
    primary_planned_group_count: usize,
    fallback_planned_group_count: Option<usize>,
    wfp_worker: Option<String>,
}

impl RelayModelRouteAudit {
    fn primary(model: &str, fallback_model: Option<&str>) -> Self {
        Self {
            requested_model: model.to_string(),
            served_model: model.to_string(),
            fallback_model: fallback_model.map(str::to_string),
            fallback_attempted: false,
            fallback_trigger: None,
            fallback_skip_reason: None,
            ai_gateway_direct_fallback: None,
            cross_group_retry: false,
            primary_planned_group_count: 0,
            fallback_planned_group_count: None,
            wfp_worker: None,
        }
    }
}

fn relay_model_fallback_supported(endpoint: &RelayEndpoint) -> bool {
    endpoint.provider == RelayProviderKind::OpenAiCompatible
        && matches!(
            endpoint.upstream_path.as_str(),
            "chat/completions" | "responses"
        )
        && endpoint.expects_json_request_body()
}

fn should_model_fallback_status(status: u16) -> bool {
    matches!(status, 500..=503 | 505..=523 | 525..=599)
}

/// One planned relay attempt: the channel to try and the group it was selected
/// from (the group drives settlement billing — for `auto` tokens it is the
/// selected group, not the literal `"auto"` token group).
struct RelayAttemptPlan {
    group: String,
    channel: RelayChannel,
}

fn retain_route_capable_channels(
    group_pools: &mut [(String, Vec<RelayChannel>)],
    route: Option<ProviderRelayRoute>,
) {
    let Some(route) = route else {
        for (_, channels) in group_pools {
            channels.clear();
        }
        return;
    };
    for (_, channels) in group_pools {
        channels.retain(|channel| channel_supports_relay_route(channel.channel_type, route));
    }
}

fn retain_pre_reserve_capable_channels(
    group_pools: &mut [(String, Vec<RelayChannel>)],
    endpoint: &RelayEndpoint,
    should_relay_stream: bool,
    request_body: Option<&Value>,
    ali_messages_model_patterns: Option<&str>,
) {
    for (_, channels) in group_pools {
        channels.retain(|channel| {
            if first_channel_key(&channel.key).is_none() {
                return false;
            }
            if channel.wfp_worker().is_some() && channel.ai_gateway_opted_in() {
                return false;
            }
            if is_direct_only_provider_channel(channel)
                && (channel.wfp_worker().is_some() || channel.ai_gateway_opted_in())
            {
                return false;
            }
            if is_workers_ai_binding_channel(channel) && should_relay_stream {
                return false;
            }
            if channel.channel_type == CHANNEL_TYPE_TENCENT && should_relay_stream {
                return false;
            }
            let request_shape_supported = if channel.channel_type == CHANNEL_TYPE_ALI {
                request_body.is_some_and(|body| {
                    ali_accepts_request_shape(
                        endpoint,
                        channel,
                        body,
                        false,
                        ali_messages_model_patterns,
                    )
                })
            } else {
                channel_accepts_endpoint_request_shape(channel, endpoint, request_body)
            };
            if !request_shape_supported {
                return false;
            }
            let Ok(url) = endpoint.try_upstream_url(channel) else {
                return false;
            };
            channel.wfp_worker().is_none() || wfp_relay_path(&url).is_ok()
        });
    }
}

fn channel_accepts_endpoint_request_shape(
    channel: &RelayChannel,
    endpoint: &RelayEndpoint,
    request_body: Option<&Value>,
) -> bool {
    if channel.channel_type == CHANNEL_TYPE_TENCENT {
        let key_is_valid =
            first_channel_key(&channel.key).is_some_and(|key| parse_tencent_key(&key).is_ok());
        if endpoint.route != ProviderRelayRoute::ChatCompletions || !key_is_valid {
            return false;
        }
        let Some(body) = request_body else {
            return false;
        };
        if body.get("model").is_some() || body.get("messages").is_some() {
            let mut converted = body.clone();
            return apply_tencent_chat_request(&mut converted).is_ok();
        }
        let model_is_present = body
            .get("Model")
            .and_then(Value::as_str)
            .is_some_and(|model| !model.trim().is_empty());
        let has_messages = body
            .get("Messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| !messages.is_empty());
        let stream_is_disabled = body.get("Stream").map_or(true, |stream| {
            stream.is_null() || stream.as_bool() == Some(false)
        });
        return model_is_present && has_messages && stream_is_disabled;
    }
    if channel.channel_type == CHANNEL_TYPE_BAIDU_V2 {
        let key_is_valid =
            first_channel_key(&channel.key).is_some_and(|key| parse_baidu_v2_key(&key).is_ok());
        let has_messages = request_body
            .and_then(|body| body.get("messages"))
            .and_then(Value::as_array)
            .is_some_and(|messages| !messages.is_empty());
        return endpoint.route == ProviderRelayRoute::ChatCompletions
            && key_is_valid
            && has_messages;
    }
    if channel.channel_type == CHANNEL_TYPE_VOLCENGINE {
        let Some(body) = request_body else {
            return false;
        };
        let Some(request_model) = body.get("model").and_then(Value::as_str) else {
            return false;
        };
        let effective_model = mapped_model_name(request_model, channel.model_mapping.as_deref())
            .unwrap_or_else(|| request_model.to_string());
        if is_volcengine_bot_model(&effective_model) {
            return false;
        }
        if is_volcengine_coding_plan(channel.base_url.as_deref())
            && endpoint.route != ProviderRelayRoute::ChatCompletions
        {
            return false;
        }
    }
    if channel.channel_type == CHANNEL_TYPE_ALI {
        return request_body
            .is_some_and(|body| ali_accepts_request_shape(endpoint, channel, body, false, None));
    }
    if channel.channel_type == CHANNEL_TYPE_PERPLEXITY
        && endpoint.route == ProviderRelayRoute::ChatCompletions
    {
        return request_body
            .and_then(|body| body.get("messages"))
            .and_then(Value::as_array)
            .is_some_and(|messages| !messages.is_empty());
    }
    if channel.channel_type == CHANNEL_TYPE_SILICONFLOW {
        return request_body.is_some_and(|body| siliconflow_accepts_request_shape(endpoint, body));
    }
    if channel.channel_type == CHANNEL_TYPE_MOONSHOT {
        return request_body
            .is_some_and(|body| moonshot_accepts_request_shape(endpoint, channel, body));
    }
    true
}

fn is_direct_only_provider_channel(channel: &RelayChannel) -> bool {
    matches!(
        channel.channel_type,
        CHANNEL_TYPE_ALI
            | CHANNEL_TYPE_BAIDU_V2
            | CHANNEL_TYPE_MOONSHOT
            | CHANNEL_TYPE_ZHIPU_V4
            | CHANNEL_TYPE_SILICONFLOW
            | CHANNEL_TYPE_SUBMODEL
            | CHANNEL_TYPE_TENCENT
            | CHANNEL_TYPE_VOLCENGINE
    )
}

fn ali_accepts_request_shape(
    endpoint: &RelayEndpoint,
    channel: &RelayChannel,
    body: &Value,
    model_already_mapped: bool,
    ali_messages_model_patterns: Option<&str>,
) -> bool {
    if ali_plugin_header_value(&channel.other).is_err() {
        return false;
    }
    let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
    else {
        return false;
    };
    let effective_model = if model_already_mapped {
        model.to_string()
    } else {
        mapped_model_name(model, channel.model_mapping.as_deref())
            .unwrap_or_else(|| model.to_string())
    };
    let top_p_is_valid = body
        .get("top_p")
        .map_or(true, |value| value.is_null() || value.as_f64().is_some());

    match endpoint.route {
        ProviderRelayRoute::ChatCompletions => {
            top_p_is_valid
                && body
                    .get("messages")
                    .and_then(Value::as_array)
                    .is_some_and(|messages| !messages.is_empty())
        }
        ProviderRelayRoute::Completions => {
            top_p_is_valid && body.get("prompt").is_some_and(non_empty_string_or_array)
        }
        ProviderRelayRoute::Responses => body.get("input").is_some_and(|input| !input.is_null()),
        ProviderRelayRoute::Embeddings => body.get("input").is_some_and(non_empty_string_or_array),
        ProviderRelayRoute::AnthropicMessages => {
            supports_ali_anthropic_messages_with_config(
                &effective_model,
                ali_messages_model_patterns,
            ) && body
                .get("max_tokens")
                .and_then(Value::as_u64)
                .is_some_and(|max_tokens| max_tokens > 0)
                && body
                    .get("messages")
                    .and_then(Value::as_array)
                    .is_some_and(|messages| !messages.is_empty())
        }
        ProviderRelayRoute::Rerank => {
            supports_ali_native_rerank(&effective_model)
                && body.get("query").is_some_and(Value::is_string)
                && body
                    .get("documents")
                    .and_then(Value::as_array)
                    .is_some_and(|documents| !documents.is_empty())
                && body
                    .get("top_n")
                    .map_or(true, |value| value.is_null() || value.as_u64().is_some())
                && body
                    .get("return_documents")
                    .map_or(true, |value| value.is_null() || value.is_boolean())
        }
        _ => false,
    }
}

fn non_empty_string_or_array(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.is_empty())
        || value.as_array().is_some_and(|values| !values.is_empty())
}

fn moonshot_accepts_request_shape(
    endpoint: &RelayEndpoint,
    channel: &RelayChannel,
    body: &Value,
) -> bool {
    let has_model = body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.trim().is_empty());
    let temperature_is_valid = body.get("temperature").map_or(true, |temperature| {
        temperature.is_null() || temperature.as_f64().is_some()
    });
    if !has_model || !temperature_is_valid {
        return false;
    }
    if is_coding_plan_base(channel.base_url.as_deref())
        && !matches!(
            endpoint.route,
            ProviderRelayRoute::ChatCompletions | ProviderRelayRoute::AnthropicMessages
        )
    {
        return false;
    }
    match endpoint.route {
        ProviderRelayRoute::ChatCompletions | ProviderRelayRoute::AnthropicMessages => true,
        ProviderRelayRoute::Completions => body.get("prompt").is_some_and(|prompt| {
            prompt.is_string() || prompt.as_array().is_some_and(|prompts| !prompts.is_empty())
        }),
        ProviderRelayRoute::Embeddings => body.get("input").is_some_and(|input| !input.is_null()),
        ProviderRelayRoute::Rerank => body
            .get("documents")
            .and_then(Value::as_array)
            .is_some_and(|documents| !documents.is_empty()),
        _ => false,
    }
}

fn siliconflow_accepts_request_shape(endpoint: &RelayEndpoint, body: &Value) -> bool {
    let has_model = body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.trim().is_empty());
    if !has_model {
        return false;
    }
    match endpoint.route {
        ProviderRelayRoute::ChatCompletions => true,
        ProviderRelayRoute::Completions => body.get("prompt").is_some_and(|prompt| {
            prompt.is_string() || prompt.as_array().is_some_and(|prompts| !prompts.is_empty())
        }),
        ProviderRelayRoute::Embeddings => body.get("input").is_some_and(|input| !input.is_null()),
        ProviderRelayRoute::Rerank => {
            body.get("documents")
                .and_then(Value::as_array)
                .is_some_and(|documents| {
                    !documents.is_empty() && documents.iter().all(Value::is_string)
                })
        }
        ProviderRelayRoute::ImageGenerations => siliconflow_image_request_shape_is_valid(body),
        _ => false,
    }
}

fn siliconflow_image_request_shape_is_valid(body: &Value) -> bool {
    if body
        .get("stream")
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
    {
        return false;
    }
    if !body
        .get("prompt")
        .and_then(Value::as_str)
        .is_some_and(|prompt| !prompt.trim().is_empty())
    {
        return false;
    }
    for field in [
        "negative_prompt",
        "size",
        "image_size",
        "image",
        "image2",
        "image3",
    ] {
        if body
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            return false;
        }
    }
    for field in ["n", "batch_size", "seed", "num_inference_steps"] {
        if body
            .get(field)
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return false;
        }
    }
    for field in ["guidance_scale", "cfg"] {
        if body
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_number())
        {
            return false;
        }
    }
    let effective_batch_size = body
        .get("batch_size")
        .and_then(Value::as_u64)
        .filter(|value| *value != 0)
        .or_else(|| body.get("n").and_then(Value::as_u64))
        .unwrap_or(1);
    (1..=4).contains(&effective_batch_size)
}

struct RelayAttemptExecution {
    selected_attempt: Option<(RelayChannel, String, Response)>,
    last_failure: Option<RelayAttemptFailure>,
    attempts: RelayAttemptAuditLedger,
}

#[allow(clippy::too_many_arguments)]
async fn execute_relay_attempt_plan(
    attempt_plan: Vec<RelayAttemptPlan>,
    env: &Env,
    endpoint: &mut RelayEndpoint,
    request_body: &RelayRequestBody,
    json_body: Option<&Value>,
    auth_mode: RelayAuthMode,
    model: &str,
    should_relay_stream: bool,
    inject_stream_options: bool,
    keyword_ban_enabled: bool,
    ai_gateway_runtime: Option<&RelayAiGatewayRuntime>,
    provider_headers: &RelayProviderHeaders,
) -> RelayAttemptExecution {
    let mut last_failure = None;
    let mut selected_attempt = None;
    let mut attempts = RelayAttemptAuditLedger::default();
    let attempt_count = attempt_plan.len();

    for (attempt_index, plan) in attempt_plan.into_iter().enumerate() {
        let RelayAttemptPlan {
            group: selected_group,
            channel,
        } = plan;
        let attempt_provider = endpoint.effective_provider(channel.channel_type);

        let upstream_key = match first_channel_key(&channel.key) {
            Some(key) => key,
            None => {
                let failure = RelayAttemptFailure::no_key(
                    channel.id,
                    channel.name.clone(),
                    channel.ai_gateway_opted_in(),
                );
                attempts.push(RelayAttemptAudit::from_failure(
                    "fallback",
                    model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
                continue;
            }
        };

        let upstream_url = match endpoint.try_upstream_url(&channel) {
            Ok(url) => url,
            Err(err) => {
                let failure = RelayAttemptFailure::configuration_error(
                    channel.id,
                    channel.name.clone(),
                    err.to_string(),
                    channel.ai_gateway_opted_in(),
                );
                attempts.push(RelayAttemptAudit::from_failure(
                    "fallback",
                    model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
                continue;
            }
        };
        let mut forward_error_kind = RelayAttemptFailureKind::FetchError;
        let forward_result = match request_body {
            RelayRequestBody::Json(_) => {
                let Some(mut upstream_body) = json_body.cloned() else {
                    break;
                };
                if auth_mode == RelayAuthMode::PlaygroundSession {
                    strip_playground_request_fields(&mut upstream_body);
                }
                apply_model_attempt_body(
                    &mut upstream_body,
                    model,
                    channel.model_mapping.as_deref(),
                );
                if endpoint.provider == RelayProviderKind::GeminiNative {
                    if let Some(mapped_model) =
                        mapped_model_name(model, channel.model_mapping.as_deref())
                    {
                        apply_gemini_native_model_mapping(&mut upstream_body, model, &mapped_model);
                        if let Some(route) = endpoint.gemini_route.as_mut() {
                            route.model = mapped_model;
                            endpoint.upstream_path = route.upstream_path();
                        }
                    }
                }
                if let Err(error) = apply_endpoint_request_transform(
                    &mut upstream_body,
                    &endpoint.upstream_path,
                    &channel,
                ) {
                    let failure = RelayAttemptFailure::configuration_error(
                        channel.id,
                        channel.name.clone(),
                        error.to_string(),
                        channel.ai_gateway_opted_in(),
                    );
                    attempts.push(RelayAttemptAudit::from_failure(
                        "fallback",
                        model,
                        &selected_group,
                        &failure,
                    ));
                    last_failure = Some(failure);
                    continue;
                }
                apply_provider_request_transform(&mut upstream_body, attempt_provider);
                if inject_stream_options && provider_uses_openai_stream_options(attempt_provider) {
                    cinatoken_relay::openai_compatible::apply_stream_options(
                        &mut upstream_body,
                        channel.channel_type,
                        should_relay_stream,
                    );
                }
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
                            .unwrap_or(model)
                            .to_string();
                        forward_workers_ai_binding(env, &upstream_model, &upstream_body).await
                    }
                } else {
                    let upstream_model = upstream_body
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or(model);
                    match ai_gateway_runtime {
                        Some(runtime) => {
                            match plan_relay_ai_gateway_attempt(
                                runtime,
                                endpoint,
                                &channel,
                                upstream_model,
                            ) {
                                Ok(Some(attempt)) => {
                                    match forward_ai_gateway_rest(&attempt, runtime, &upstream_body)
                                        .await
                                    {
                                        Ok(response) => {
                                            let status = response.status_code();
                                            if should_ai_gateway_direct_fallback(status) {
                                                if let Some(direct_body) =
                                                    prepare_ai_gateway_direct_fallback_body(
                                                        &upstream_body,
                                                        &attempt,
                                                    )
                                                {
                                                    worker::console_warn!(
                                                    "relay AI Gateway returned server status {}; falling back to direct provider for channel {}",
                                                    status,
                                                    channel.id
                                                );
                                                    forward_relay_request(
                                                        env,
                                                        attempt_provider,
                                                        &upstream_url,
                                                        &upstream_key,
                                                        &channel,
                                                        &direct_body,
                                                        provider_headers,
                                                    )
                                                    .await
                                                    .and_then(|response| {
                                                        mark_ai_gateway_direct_fallback(
                                                            response,
                                                            &format!("gateway_status_{status}"),
                                                        )
                                                    })
                                                } else {
                                                    Ok(response)
                                                }
                                            } else {
                                                Ok(response)
                                            }
                                        }
                                        Err(err) => {
                                            if let Some(direct_body) =
                                                prepare_ai_gateway_direct_fallback_body(
                                                    &upstream_body,
                                                    &attempt,
                                                )
                                            {
                                                worker::console_warn!(
                                                "relay AI Gateway fetch failed; falling back to direct provider for channel {}: {}",
                                                channel.id,
                                                err
                                            );
                                                forward_relay_request(
                                                    env,
                                                    attempt_provider,
                                                    &upstream_url,
                                                    &upstream_key,
                                                    &channel,
                                                    &direct_body,
                                                    provider_headers,
                                                )
                                                .await
                                                .and_then(|response| {
                                                    mark_ai_gateway_direct_fallback(
                                                        response,
                                                        "gateway_fetch_error",
                                                    )
                                                })
                                            } else {
                                                Err(err)
                                            }
                                        }
                                    }
                                }
                                Ok(None) => Err(worker::Error::RustError(format!(
                                    "cross-model fallback channel {} did not produce an AI Gateway plan",
                                    channel.id
                                ))),
                                Err(err) => {
                                    forward_error_kind =
                                        RelayAttemptFailureKind::ConfigurationError;
                                    Err(err)
                                }
                            }
                        }
                        None => Err(worker::Error::RustError(
                            "cross-model fallback requires a ready AI Gateway runtime".to_string(),
                        )),
                    }
                }
            }
            RelayRequestBody::Raw {
                bytes,
                content_type,
            } => {
                if let Err(err) = ensure_wfp_json_body(&channel) {
                    forward_error_kind = RelayAttemptFailureKind::ConfigurationError;
                    Err(err)
                } else {
                    forward_raw_openai_compatible(
                        &upstream_url,
                        &upstream_key,
                        &channel,
                        bytes,
                        content_type,
                    )
                    .await
                }
            }
        };

        match forward_result {
            Ok(mut response) => {
                let status = response.status_code();
                if is_retryable_status(status) {
                    record_retryable_channel_failure(env, &channel, status).await;
                    let failure = RelayAttemptFailure::retryable_status(
                        channel.id,
                        channel.name.clone(),
                        status,
                        channel.ai_gateway_opted_in(),
                    );
                    attempts.push(RelayAttemptAudit::from_failure(
                        "fallback",
                        model,
                        &selected_group,
                        &failure,
                    ));
                    last_failure = Some(failure);
                    if attempt_index + 1 < attempt_count {
                        if keyword_ban_enabled {
                            maybe_keyword_disable_channel(env, &channel, &mut response).await;
                        }
                        continue;
                    }
                    selected_attempt = Some((channel, selected_group, response));
                    break;
                }
                selected_attempt = Some((channel, selected_group, response));
                break;
            }
            Err(err) => {
                record_retryable_channel_failure(env, &channel, 0).await;
                let failure = RelayAttemptFailure::with_detail(
                    forward_error_kind,
                    channel.id,
                    channel.name.clone(),
                    err.to_string(),
                    channel.ai_gateway_opted_in(),
                );
                attempts.push(RelayAttemptAudit::from_failure(
                    "fallback",
                    model,
                    &selected_group,
                    &failure,
                ));
                last_failure = Some(failure);
            }
        }
    }

    RelayAttemptExecution {
        selected_attempt,
        last_failure,
        attempts,
    }
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

fn unique_group_count(groups: &[String]) -> usize {
    let mut unique = Vec::new();
    for group in groups {
        if !unique.iter().any(|existing| *existing == group) {
            unique.push(group);
        }
    }
    unique.len()
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
    ai_gateway_opted_in: bool,
    status: Option<u16>,
    #[allow(dead_code)]
    detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayAttemptFailureKind {
    ConfigurationError,
    FetchError,
    NoUsableKey,
    RetryableStatus,
}

impl RelayAttemptFailureKind {
    fn audit_label(self) -> &'static str {
        match self {
            Self::ConfigurationError => "configuration_error",
            Self::FetchError => "fetch_error",
            Self::NoUsableKey => "no_usable_key",
            Self::RetryableStatus => "retryable_status",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayAttemptAudit {
    phase: &'static str,
    model: String,
    group: String,
    channel_id: i64,
    outcome: &'static str,
    status: Option<u16>,
    ai_gateway_opted_in: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RelayAttemptAuditLedger {
    entries: Vec<RelayAttemptAudit>,
    total: usize,
}

impl RelayAttemptAuditLedger {
    fn push(&mut self, attempt: RelayAttemptAudit) {
        self.total = self.total.saturating_add(1);
        if self.entries.len() < RELAY_ATTEMPT_AUDIT_MAX_ENTRIES {
            self.entries.push(attempt);
        }
    }

    fn append(&mut self, other: &mut Self) {
        self.total = self.total.saturating_add(other.total);
        let remaining = RELAY_ATTEMPT_AUDIT_MAX_ENTRIES.saturating_sub(self.entries.len());
        let take = remaining.min(other.entries.len());
        self.entries.extend(other.entries.drain(..take));
        other.total = 0;
    }

    fn is_empty(&self) -> bool {
        self.total == 0
    }

    fn truncated(&self) -> bool {
        self.total > self.entries.len()
    }

    fn json_entries(&self) -> Vec<Value> {
        self.entries
            .iter()
            .enumerate()
            .map(|(index, attempt)| attempt.to_json(index + 1))
            .collect()
    }
}

impl RelayAttemptAudit {
    fn from_failure(
        phase: &'static str,
        model: &str,
        group: &str,
        failure: &RelayAttemptFailure,
    ) -> Self {
        Self {
            phase,
            model: model.to_string(),
            group: group.to_string(),
            channel_id: failure.channel_id,
            outcome: failure.kind.audit_label(),
            status: failure.status,
            ai_gateway_opted_in: failure.ai_gateway_opted_in,
        }
    }

    fn to_json(&self, sequence: usize) -> Value {
        json!({
            "sequence": sequence,
            "phase": self.phase,
            "model": self.model,
            "group": self.group,
            "channel_id": self.channel_id,
            "outcome": self.outcome,
            "status": self.status,
            "ai_gateway_opted_in": self.ai_gateway_opted_in,
        })
    }
}

impl RelayAttemptFailure {
    fn with_detail(
        kind: RelayAttemptFailureKind,
        channel_id: i64,
        channel_name: String,
        detail: String,
        ai_gateway_opted_in: bool,
    ) -> Self {
        Self {
            kind,
            channel_id,
            channel_name,
            ai_gateway_opted_in,
            status: None,
            detail,
        }
    }

    fn configuration_error(
        channel_id: i64,
        channel_name: String,
        detail: String,
        ai_gateway_opted_in: bool,
    ) -> Self {
        Self::with_detail(
            RelayAttemptFailureKind::ConfigurationError,
            channel_id,
            channel_name,
            detail,
            ai_gateway_opted_in,
        )
    }

    fn no_key(channel_id: i64, channel_name: String, ai_gateway_opted_in: bool) -> Self {
        Self {
            kind: RelayAttemptFailureKind::NoUsableKey,
            channel_id,
            channel_name,
            ai_gateway_opted_in,
            status: None,
            detail: String::new(),
        }
    }

    #[allow(dead_code)]
    fn retryable_status(
        channel_id: i64,
        channel_name: String,
        status: u16,
        ai_gateway_opted_in: bool,
    ) -> Self {
        Self {
            kind: RelayAttemptFailureKind::RetryableStatus,
            channel_id,
            channel_name,
            ai_gateway_opted_in,
            status: Some(status),
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
    let Ok(config) = RelayRateLimitRuntimeConfig::from_env(env) else {
        return false;
    };
    match config.backend {
        RelayRateLimitBackend::Disabled => false,
        RelayRateLimitBackend::Native => {
            native_rate_limit_binding_available(env, NATIVE_TOKEN_RATE_LIMIT_BINDING)
                && native_rate_limit_binding_available(env, NATIVE_IP_RATE_LIMIT_BINDING)
        }
        RelayRateLimitBackend::Upstash => {
            config.legacy.enabled() && crate::cache::upstash_redis_configured(env)
        }
    }
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
    route_family: &str,
) -> Result<(), worker::Result<Response>> {
    let config = RelayRateLimitRuntimeConfig::from_env(env).map_err(|err| {
        openai_error_response(
            format!("invalid relay rate limit configuration: {err}"),
            500,
        )
    })?;

    match config.backend {
        RelayRateLimitBackend::Disabled => Ok(()),
        RelayRateLimitBackend::Native => {
            enforce_native_relay_rate_limits(env, auth, client_ip, route_family).await
        }
        RelayRateLimitBackend::Upstash => {
            enforce_upstash_relay_rate_limits(env, auth, client_ip, route_family, config.legacy)
                .await
        }
    }
}

async fn enforce_native_relay_rate_limits(
    env: &Env,
    auth: &AuthenticatedToken,
    client_ip: Option<&str>,
    route_family: &str,
) -> Result<(), worker::Result<Response>> {
    let token_allowed = call_native_rate_limit(
        env,
        NATIVE_TOKEN_RATE_LIMIT_BINDING,
        relay_token_rate_limit_key(auth, route_family),
    )
    .await
    .map_err(|err| rate_limit_failure_response(err.to_string()))?;
    if !token_allowed {
        return Err(rate_limited_response(
            "token rate limit exceeded",
            DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
        ));
    }

    if let Some(ip) = client_ip.map(str::trim).filter(|ip| !ip.is_empty()) {
        let ip_allowed = call_native_rate_limit(
            env,
            NATIVE_IP_RATE_LIMIT_BINDING,
            relay_ip_rate_limit_key(ip, route_family),
        )
        .await
        .map_err(|err| rate_limit_failure_response(err.to_string()))?;
        if !ip_allowed {
            return Err(rate_limited_response(
                "IP rate limit exceeded",
                DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
            ));
        }
    }

    Ok(())
}

fn native_rate_limit_binding_available(env: &Env, name: &str) -> bool {
    native_rate_limit_binding(env, name).is_ok()
}

fn native_rate_limit_binding(env: &Env, name: &str) -> worker::Result<(JsValue, Function)> {
    // workers-rs 0.5 expects the constructor name `RateLimiter`, while the
    // current runtime exposes `Ratelimit`. Validate the platform method at this
    // narrow boundary instead of accepting an unchecked class-name cast.
    let binding = Reflect::get(env.as_ref(), &JsValue::from_str(name)).map_err(|error| {
        worker::Error::JsError(format!(
            "failed to read native rate limit binding {name}: {error:?}"
        ))
    })?;
    if binding.is_null() || binding.is_undefined() {
        return Err(worker::Error::JsError(format!(
            "native rate limit binding {name} is unavailable"
        )));
    }
    let limit = Reflect::get(&binding, &JsValue::from_str("limit"))
        .map_err(|error| {
            worker::Error::JsError(format!(
                "failed to read {name}.limit from native rate limit binding: {error:?}"
            ))
        })?
        .dyn_into::<Function>()
        .map_err(|_| {
            worker::Error::JsError(format!(
                "native rate limit binding {name} does not expose limit()"
            ))
        })?;
    Ok((binding, limit))
}

async fn call_native_rate_limit(env: &Env, name: &str, key: String) -> worker::Result<bool> {
    let (binding, limit) = native_rate_limit_binding(env, name)?;
    let options = Object::new();
    Reflect::set(
        &options,
        &JsValue::from_str("key"),
        &JsValue::from_str(&key),
    )
    .map_err(|error| {
        worker::Error::JsError(format!(
            "failed to construct native rate limit input for {name}: {error:?}"
        ))
    })?;
    let promise = limit
        .call1(&binding, &options)
        .map_err(|error| {
            worker::Error::JsError(format!(
                "native rate limit binding {name} rejected limit(): {error:?}"
            ))
        })?
        .dyn_into::<Promise>()
        .map_err(|_| {
            worker::Error::JsError(format!(
                "native rate limit binding {name} returned a non-Promise"
            ))
        })?;
    let outcome = JsFuture::from(promise).await.map_err(|error| {
        worker::Error::JsError(format!(
            "native rate limit binding {name} failed: {error:?}"
        ))
    })?;
    Reflect::get(&outcome, &JsValue::from_str("success"))
        .map_err(|error| {
            worker::Error::JsError(format!(
                "native rate limit binding {name} outcome is unreadable: {error:?}"
            ))
        })?
        .as_bool()
        .ok_or_else(|| {
            worker::Error::JsError(format!(
                "native rate limit binding {name} outcome is missing boolean success"
            ))
        })
}

async fn enforce_upstash_relay_rate_limits(
    env: &Env,
    auth: &AuthenticatedToken,
    client_ip: Option<&str>,
    route_family: &str,
    config: RelayRateLimitConfig,
) -> Result<(), worker::Result<Response>> {
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
        let key = relay_token_rate_limit_key(auth, route_family);
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
            let key = relay_ip_rate_limit_key(ip, route_family);
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

pub(crate) async fn plan_realtime_upstream_channel(
    db: &D1Database,
    env: &Env,
    req: &Request,
    auth: &AuthenticatedToken,
    model: &str,
    client_requested_subprotocol: bool,
) -> Result<crate::realtime_session::RealtimeSelectedUpstream, worker::Result<Response>> {
    let retry_config = RelayRetryConfig::from_env(env).map_err(|err| {
        openai_error_response(format!("invalid relay retry configuration: {err}"), 500)
    })?;
    let group = auth.effective_group().to_string();
    let is_auto = group == "auto";
    let realtime_route = ProviderRelayRoute::Realtime;
    let realtime_channel_types = channel_types_for_relay_route(realtime_route);
    let group_pools: Vec<(String, Vec<RelayChannel>)> = if is_auto {
        let auto_groups =
            match crate::d1_repositories::resolve_user_auto_groups(db, &auth.user_group).await {
                Ok(groups) => groups,
                Err(err) => {
                    return Err(openai_error_response(
                        format!("failed to resolve auto groups: {err}"),
                        500,
                    ));
                }
            };
        if auto_groups.is_empty() {
            return Err(json_with_status(
                &ErrorBody::bad_request("auto groups is not enabled"),
                503,
            ));
        }

        let mut pools = Vec::with_capacity(auto_groups.len());
        for auto_group in auto_groups {
            let candidates = select_channels(
                db,
                env,
                model,
                &auto_group,
                realtime_route.cache_family(),
                &realtime_channel_types,
            )
            .await?;
            pools.push((auto_group, candidates));
        }
        pools
    } else {
        let candidates = select_channels(
            db,
            env,
            model,
            &group,
            realtime_route.cache_family(),
            &realtime_channel_types,
        )
        .await?;
        vec![(group.clone(), candidates)]
    };

    let attempt_plan = plan_relay_attempts(
        group_pools,
        is_auto,
        retry_config.max_attempts(),
        retry_config.retry_times as i32,
        auth.cross_group_retry_enabled(),
        random_u64_below,
    )
    .map_err(worker_error_response)?;
    let affinity_key =
        affinity::affinity_enabled(optional_env_var(env, affinity::AFFINITY_ENABLED_ENV))
            .then(|| affinity::affinity_key(auth.user_id, model, &group));
    let attempt_plan = if let Some(key) = affinity_key.as_deref() {
        let preferred = affinity::lookup_preferred_channel(env, key).await;
        affinity::move_preferred_to_front(attempt_plan, preferred, |plan| plan.channel.id)
    } else {
        attempt_plan
    };

    for RelayAttemptPlan {
        group: selected_group,
        channel,
    } in attempt_plan
    {
        let Some(upstream_key) = first_channel_key(&channel.key) else {
            continue;
        };
        let upstream_model = mapped_model_name(model, channel.model_mapping.as_deref())
            .unwrap_or_else(|| model.to_string());
        let billing_presettlement =
            realtime_billing_presettlement(db, auth, channel.id, model, &selected_group, req)
                .await
                .map_err(|err| {
                    openai_error_response(
                        format!("realtime billing pre-settlement snapshot failed: {err}"),
                        500,
                    )
                })?;
        let (billing_snapshot, billing_settlement) = billing_presettlement
            .map(|billing| {
                (
                    Some(billing.snapshot_metadata),
                    Some(billing.settlement_handoff),
                )
            })
            .unwrap_or((None, None));
        return crate::realtime_session::realtime_selected_upstream(
            crate::realtime_session::RealtimeSelectedUpstreamInput {
                selected_group: &selected_group,
                channel_id: channel.id,
                channel_type: channel.channel_type,
                channel_name: &channel.name,
                channel_base_url: channel.base_url.as_deref(),
                request_model: model,
                upstream_model: &upstream_model,
                upstream_api_key: &upstream_key,
                api_version: None,
                client_requested_subprotocol,
                billing_snapshot,
                billing_settlement,
                startup_queue_probe_delay_ms: realtime_mock_queue_probe_delay_ms(
                    &channel.other_info,
                ),
                mock_upstream_fault: realtime_mock_upstream_fault(&channel.other_info),
            },
        )
        .map_err(|err| {
            openai_error_response(format!("realtime upstream planning failed: {err}"), 500)
        });
    }

    Err(openai_error_response(
        "no usable realtime upstream channel is available",
        503,
    ))
}

struct RealtimeBillingPresettlement {
    snapshot_metadata: crate::realtime_session::RealtimeBillingSnapshotMetadata,
    settlement_handoff: crate::realtime_session::RealtimeBillingSettlementHandoff,
}

async fn realtime_billing_presettlement(
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel_id: i64,
    model: &str,
    group: &str,
    req: &Request,
) -> worker::Result<Option<RealtimeBillingPresettlement>> {
    let request_body = json!({
        "model": model,
        "endpoint": "realtime"
    });
    let request = realtime_billing_request_input(req, &request_body);
    let Some(preflight) = prepare_tiered_billing_preflight(
        db,
        model,
        &auth.user_group,
        group,
        &request_body,
        &request,
        false,
        0,
    )
    .await?
    else {
        return Ok(None);
    };

    let snapshot_metadata =
        crate::realtime_session::RealtimeBillingSnapshotMetadata::from_tiered_snapshot(
            &preflight.snapshot,
        );
    let settlement_handoff =
        crate::realtime_session::RealtimeBillingSettlementHandoff::new(preflight.snapshot, request)
            .with_mutation_plan(
                crate::realtime_session::RealtimeBillingSettlementMutationPlan::new(
                    auth.user_id,
                    auth.token_id,
                    channel_id,
                    group,
                    preflight.pre_consumed_quota,
                ),
            )
            .with_audit_plan(
                crate::realtime_session::RealtimeBillingSettlementAuditPlan::new(
                    &auth.username,
                    &auth.token_name,
                    client_ip(req),
                    request_id(req),
                    unix_timestamp(),
                    "realtime",
                ),
            );
    Ok(Some(RealtimeBillingPresettlement {
        snapshot_metadata,
        settlement_handoff,
    }))
}

pub(crate) fn realtime_billing_response_snapshot(
    template: &TieredBillingSnapshot,
    request: RequestInput,
) -> Result<TieredBillingSnapshot, String> {
    let request_body = request
        .body
        .as_ref()
        .ok_or_else(|| "realtime response billing request body is missing".to_string())?;
    let params = token_params_from_request(
        &template.model_name,
        request_body,
        detect_billing_expr_variables(&template.expr_string),
        false,
        0,
    );
    estimate_tiered_billing_snapshot_with_request(
        template.model_name.clone(),
        template.expr_string.clone(),
        params,
        template.group_ratio,
        request,
    )
    .map_err(|err| format!("failed to freeze realtime response billing snapshot: {err}"))
}

fn realtime_mock_queue_probe_delay_ms(other_info: &str) -> Option<u32> {
    let value: Value = serde_json::from_str(other_info.trim()).ok()?;
    let mock = value.get("realtime_mock_upstream")?.as_object()?;
    let delay = mock
        .get("queue_probe_delay_ms")
        .or_else(|| mock.get("startup_queue_probe_delay_ms"))?
        .as_u64()?;
    if delay == 0 || delay > REALTIME_MOCK_QUEUE_PROBE_MAX_DELAY_MS {
        return None;
    }
    Some(delay as u32)
}

fn realtime_mock_upstream_fault(
    other_info: &str,
) -> Option<crate::realtime_session::RealtimeMockUpstreamFault> {
    let value: Value = serde_json::from_str(other_info.trim()).ok()?;
    let mock = value.get("realtime_mock_upstream")?.as_object()?;
    match mock.get("fault")?.as_str()? {
        "event_stream_failed" => {
            Some(crate::realtime_session::RealtimeMockUpstreamFault::EventStreamFailed)
        }
        "accept_failed" => Some(crate::realtime_session::RealtimeMockUpstreamFault::AcceptFailed),
        "runtime_detached" => {
            Some(crate::realtime_session::RealtimeMockUpstreamFault::RuntimeDetached)
        }
        _ => None,
    }
}

fn relay_token_rate_limit_key(auth: &AuthenticatedToken, route_family: &str) -> String {
    let actor = if auth.token_id > 0 {
        format!("token:{}", auth.token_id)
    } else {
        format!("playground-user:{}", auth.user_id)
    };
    format!("{actor}:family:{route_family}")
}

fn relay_ip_rate_limit_key(ip: &str, route_family: &str) -> String {
    let digest = Sha256::digest(ip.trim().as_bytes());
    format!("ip-sha256:{digest:x}:family:{route_family}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayRateLimitBackend {
    Disabled,
    Native,
    Upstash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayRateLimitRuntimeConfig {
    backend: RelayRateLimitBackend,
    legacy: RelayRateLimitConfig,
}

impl RelayRateLimitRuntimeConfig {
    fn from_env(env: &Env) -> Result<Self, String> {
        Self::from_raw(
            optional_env_var(env, RATE_LIMIT_BACKEND_ENV),
            optional_env_var(env, TOKEN_RATE_LIMIT_ENV),
            optional_env_var(env, IP_RATE_LIMIT_ENV),
            optional_env_var(env, RATE_LIMIT_WINDOW_ENV),
        )
    }

    fn from_raw(
        backend: Option<String>,
        token_limit: Option<String>,
        ip_limit: Option<String>,
        window_seconds: Option<String>,
    ) -> Result<Self, String> {
        let legacy = RelayRateLimitConfig::from_raw(token_limit, ip_limit, window_seconds)?;
        let backend = match backend.as_deref().map(str::trim) {
            Some("") | None if legacy.enabled() => RelayRateLimitBackend::Upstash,
            Some("") | None => RelayRateLimitBackend::Disabled,
            Some("disabled") => RelayRateLimitBackend::Disabled,
            Some("native") => RelayRateLimitBackend::Native,
            Some("upstash") if legacy.enabled() => RelayRateLimitBackend::Upstash,
            Some("upstash") => {
                return Err(format!(
                    "{RATE_LIMIT_BACKEND_ENV}=upstash requires {TOKEN_RATE_LIMIT_ENV} or {IP_RATE_LIMIT_ENV}"
                ));
            }
            Some(other) => {
                return Err(format!(
                    "{RATE_LIMIT_BACKEND_ENV} must be disabled, native, or upstash; got {other}"
                ));
            }
        };
        Ok(Self { backend, legacy })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RelayRateLimitConfig {
    token_limit_per_window: Option<u32>,
    ip_limit_per_window: Option<u32>,
    window_seconds: u32,
}

impl RelayRateLimitConfig {
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

pub(crate) fn relay_billing_reservation_ledger_compiled() -> bool {
    RELAY_BILLING_RESERVATION_LEASE_MIN_SECONDS < RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
        && RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
            <= RELAY_BILLING_RESERVATION_LEASE_MAX_SECONDS
        && RELAY_BILLING_STREAM_LEASE_HEARTBEAT_MIN_SECONDS
            < RELAY_BILLING_STREAM_LEASE_HEARTBEAT_DEFAULT_SECONDS
        && crate::d1_repositories::RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS > 0
}

pub(crate) fn relay_billing_stream_lease_renewal_compiled() -> bool {
    relay_billing_reservation_ledger_compiled()
        && relay_billing_stream_lease_heartbeat_seconds_from_raw(
            RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS,
            None,
        ) < RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
}

pub(crate) fn relay_billing_stream_error_usage_recovery_compiled() -> bool {
    true
}

pub(crate) fn relay_billing_finalization_replay_compiled() -> bool {
    false
}

pub(crate) fn relay_billing_orphan_recovery_enabled(env: &Env) -> bool {
    env_flag(optional_env_var(env, RELAY_BILLING_ORPHAN_RECOVERY_ENABLED_ENV).as_deref())
}

pub(crate) fn relay_billing_reservation_lease_seconds(env: &Env) -> i64 {
    optional_env_var(env, RELAY_BILLING_RESERVATION_LEASE_SECONDS_ENV)
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| {
            (RELAY_BILLING_RESERVATION_LEASE_MIN_SECONDS
                ..=RELAY_BILLING_RESERVATION_LEASE_MAX_SECONDS)
                .contains(value)
        })
        .unwrap_or(RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS)
}

pub(crate) fn relay_billing_stream_lease_heartbeat_seconds(env: &Env) -> i64 {
    relay_billing_stream_lease_heartbeat_runtime_status(env).effective_seconds
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RelayBillingStreamLeaseHeartbeatRuntimeStatus {
    pub configured: bool,
    pub valid: bool,
    pub effective_seconds: i64,
}

pub(crate) fn relay_billing_stream_lease_heartbeat_runtime_status(
    env: &Env,
) -> RelayBillingStreamLeaseHeartbeatRuntimeStatus {
    relay_billing_stream_lease_heartbeat_runtime_status_from_raw(
        relay_billing_reservation_lease_seconds(env),
        optional_env_var(env, RELAY_BILLING_STREAM_LEASE_HEARTBEAT_SECONDS_ENV).as_deref(),
    )
}

fn relay_billing_stream_lease_heartbeat_seconds_from_raw(
    lease_seconds: i64,
    raw: Option<&str>,
) -> i64 {
    relay_billing_stream_lease_heartbeat_runtime_status_from_raw(lease_seconds, raw)
        .effective_seconds
}

fn relay_billing_stream_lease_heartbeat_runtime_status_from_raw(
    lease_seconds: i64,
    raw: Option<&str>,
) -> RelayBillingStreamLeaseHeartbeatRuntimeStatus {
    let maximum = (lease_seconds / 3).max(RELAY_BILLING_STREAM_LEASE_HEARTBEAT_MIN_SECONDS);
    let default = RELAY_BILLING_STREAM_LEASE_HEARTBEAT_DEFAULT_SECONDS.min(maximum);
    let configured = raw.is_some_and(|value| !value.trim().is_empty());
    let parsed = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok());
    let accepted = parsed.filter(|value| {
        (RELAY_BILLING_STREAM_LEASE_HEARTBEAT_MIN_SECONDS..=maximum).contains(value)
    });
    RelayBillingStreamLeaseHeartbeatRuntimeStatus {
        configured,
        valid: !configured || accepted.is_some(),
        effective_seconds: accepted.unwrap_or(default),
    }
}

fn relay_billing_stream_lease_heartbeat_interval_seconds(
    heartbeat_seconds: i64,
    reservation_key: &str,
) -> i64 {
    let spread = (heartbeat_seconds / 10).max(1);
    let digest = Sha256::digest(reservation_key.as_bytes());
    let seed = i64::from(u16::from_be_bytes([digest[0], digest[1]]));
    let offset = seed % spread.saturating_mul(2).saturating_add(1) - spread;
    heartbeat_seconds
        .saturating_add(offset)
        .max(RELAY_BILLING_STREAM_LEASE_HEARTBEAT_MIN_SECONDS)
}

pub(crate) fn relay_billing_orphan_sweep_limit(env: &Env) -> i64 {
    optional_env_var(env, RELAY_BILLING_ORPHAN_SWEEP_LIMIT_ENV)
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| (1..=64).contains(value))
        .unwrap_or(RELAY_BILLING_ORPHAN_SWEEP_DEFAULT_LIMIT)
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
    direct_channel_type: i32,
}

fn plan_relay_ai_gateway_attempt(
    runtime: &RelayAiGatewayRuntime,
    endpoint: &RelayEndpoint,
    channel: &RelayChannel,
    upstream_model: &str,
) -> worker::Result<Option<RelayAiGatewayAttempt>> {
    if channel.wfp_worker().is_some() && channel.ai_gateway_opted_in() {
        return Err(worker::Error::RustError(
            "channel cannot enable both relay AI Gateway and WFP transport".to_string(),
        ));
    }
    if is_direct_only_provider_channel(channel)
        && (channel.wfp_worker().is_some() || channel.ai_gateway_opted_in())
    {
        return Err(worker::Error::RustError(
            "direct-only provider channel cannot use AI Gateway or WFP transport".to_string(),
        ));
    }
    let decision = plan_ai_gateway_cutover(AiGatewayCutoverInput {
        router_ready: true,
        channel_opted_in: channel.ai_gateway_opted_in(),
        provider: endpoint.ai_gateway_provider_kind(channel.channel_type),
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
    Ok(Some(RelayAiGatewayAttempt {
        url,
        plan,
        direct_channel_type: channel.channel_type,
    }))
}

fn should_ai_gateway_direct_fallback(status: u16) -> bool {
    matches!(status, 500..=503 | 505..=523 | 525..=599)
}

fn prepare_ai_gateway_direct_fallback_body(
    body: &Value,
    attempt: &RelayAiGatewayAttempt,
) -> Option<Value> {
    let gateway_model = body.get("model")?.as_str()?;
    if classify_ai_gateway_model_author(gateway_model) != attempt.plan.model_author {
        return None;
    }
    prepare_same_channel_direct_body(
        body,
        attempt.direct_channel_type,
        attempt.plan.endpoint.relay_path(),
    )
    .ok()
    .flatten()
}

fn prepare_same_channel_direct_body(
    body: &Value,
    channel_type: i32,
    endpoint_path: &str,
) -> worker::Result<Option<Value>> {
    // Submodel model IDs are opaque provider-native namespaces. Values such as
    // `openai/gpt-oss-120b` are model names, not AI Gateway routing prefixes.
    if matches!(
        channel_type,
        CHANNEL_TYPE_MOONSHOT | CHANNEL_TYPE_SILICONFLOW | CHANNEL_TYPE_SUBMODEL
    ) {
        return Ok(None);
    }
    let Some(gateway_model) = body.get("model").and_then(Value::as_str) else {
        return Ok(None);
    };
    let model_author = classify_ai_gateway_model_author(gateway_model);
    if model_author == AiGatewayModelAuthor::Unknown {
        return Ok(None);
    }
    let direct_model = direct_provider_model_for_channel(gateway_model, model_author, channel_type)
        .ok_or_else(|| {
            worker::Error::RustError(format!(
                "AI Gateway model prefix is not approved for direct channel type {channel_type}"
            ))
        })?;
    let mut direct_body = body.clone();
    let direct_object = direct_body.as_object_mut().ok_or_else(|| {
        worker::Error::RustError("relay request body must be a JSON object".to_string())
    })?;
    direct_object.insert("model".to_string(), Value::String(direct_model.to_string()));
    if channel_type == CHANNEL_TYPE_XAI {
        apply_xai_request(&mut direct_body, endpoint_path);
    }
    Ok(Some(direct_body))
}

fn mark_ai_gateway_direct_fallback(response: Response, reason: &str) -> worker::Result<Response> {
    let status = response.status_code();
    let mut headers = Headers::new();
    for (name, value) in response.headers().entries() {
        let _ = headers.set(&name, &value);
    }
    let (_, body) = response.into_parts();
    let mut response = Response::from_body(body)?
        .with_status(status)
        .with_headers(headers);
    response
        .headers_mut()
        .set(AI_GATEWAY_DIRECT_FALLBACK_AUDIT_HEADER, reason)?;
    Ok(response)
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
    let claims = match crate::admin::require_user_auth(req, env).await {
        Ok(Ok(claims)) => claims,
        Ok(Err(response)) => {
            let status = response.status_code();
            let message = match status {
                401 => "not logged in",
                403 => "user is disabled",
                _ => "failed to parse session",
            };
            return Err(openai_error_response(message, status));
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
        cross_group_retry: 0,
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

fn apply_model_attempt_body(body: &mut Value, logical_model: &str, model_mapping: Option<&str>) {
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(logical_model.to_string()),
        );
    }
    apply_model_mapping(body, logical_model, model_mapping);
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

async fn resolve_relay_group_pools(
    db: &D1Database,
    env: &Env,
    model: &str,
    token_group: &str,
    user_group: &str,
    cache_family: &str,
    supported_channel_types: &[i32],
) -> Result<Vec<(String, Vec<RelayChannel>)>, worker::Result<Response>> {
    if token_group != "auto" {
        let candidates = select_channels(
            db,
            env,
            model,
            token_group,
            cache_family,
            supported_channel_types,
        )
        .await?;
        return Ok(vec![(token_group.to_string(), candidates)]);
    }

    let auto_groups = crate::d1_repositories::resolve_user_auto_groups(db, user_group)
        .await
        .map_err(|err| {
            openai_error_response(format!("failed to resolve auto groups: {err}"), 500)
        })?;
    if auto_groups.is_empty() {
        return Err(json_with_status(
            &ErrorBody::bad_request("auto groups is not enabled"),
            503,
        ));
    }

    let mut pools = Vec::with_capacity(auto_groups.len());
    for auto_group in auto_groups {
        let candidates = select_channels(
            db,
            env,
            model,
            &auto_group,
            cache_family,
            supported_channel_types,
        )
        .await?;
        pools.push((auto_group, candidates));
    }
    Ok(pools)
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
        if supported_channel_types.contains(&cached.channel_type) {
            // Cache hit: return just the cached channel. Route-scoped cache
            // families prevent a channel selected for one protocol from being
            // reused by another. A stale/incompatible legacy entry is treated
            // as a miss and refreshed from D1 below.
            return Ok(vec![cached]);
        }
        worker::console_warn!(
            "ignoring incompatible relay channel cache entry for family {}",
            cache_family
        );
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
    env: &Env,
    provider: RelayProviderKind,
    url: &str,
    upstream_key: &str,
    channel: &RelayChannel,
    body: &Value,
    provider_headers: &RelayProviderHeaders,
) -> worker::Result<Response> {
    if channel.wfp_worker().is_some() && channel.ai_gateway_opted_in() {
        return Err(worker::Error::RustError(
            "channel cannot enable both relay AI Gateway and WFP transport".to_string(),
        ));
    }
    if is_direct_only_provider_channel(channel)
        && (channel.wfp_worker().is_some() || channel.ai_gateway_opted_in())
    {
        return Err(worker::Error::RustError(
            "direct-only provider channel cannot use AI Gateway or WFP transport".to_string(),
        ));
    }
    if let Some(worker_name) = channel.wfp_worker() {
        return forward_wfp_relay_transport(env, url, &worker_name, channel.id, body).await;
    }
    match provider {
        RelayProviderKind::AliOpenAi | RelayProviderKind::AliMessages => {
            forward_ali(url, upstream_key, channel, body).await
        }
        RelayProviderKind::BaiduV2OpenAi => forward_baidu_v2_openai(url, upstream_key, body).await,
        RelayProviderKind::TencentHunyuan => forward_tencent_hunyuan(url, upstream_key, body).await,
        RelayProviderKind::OpenAiCompatible
        | RelayProviderKind::DeepSeekOpenAi
        | RelayProviderKind::MistralOpenAi
        | RelayProviderKind::MoonshotOpenAi
        | RelayProviderKind::PerplexityOpenAi
        | RelayProviderKind::SiliconFlowOpenAi
        | RelayProviderKind::SubmodelOpenAi
        | RelayProviderKind::XaiOpenAi
        | RelayProviderKind::VolcEngineOpenAi => {
            forward_openai_compatible(url, upstream_key, channel, body).await
        }
        RelayProviderKind::AnthropicMessages => {
            forward_anthropic_messages(url, upstream_key, body, provider_headers).await
        }
        RelayProviderKind::DeepSeekMessages => {
            forward_openai_compatible(url, upstream_key, channel, body).await
        }
        RelayProviderKind::MoonshotMessages => {
            forward_openai_compatible(url, upstream_key, channel, body).await
        }
        RelayProviderKind::GeminiNative => forward_gemini_native(url, upstream_key, body).await,
    }
}

fn ensure_wfp_json_body(channel: &RelayChannel) -> worker::Result<()> {
    if channel.wfp_worker().is_some() {
        Err(worker::Error::RustError(
            "WFP relay transport supports JSON request bodies only".to_string(),
        ))
    } else {
        Ok(())
    }
}

const WFP_RELAY_SUPPORTED_PATHS: &[&str] = &[
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/ai/run",
];
const WFP_INTERNAL_RESPONSE_HEADERS: &[&str] = &[
    "x-cinatoken-wfp-route",
    "x-cinatoken-wfp-worker",
    "x-cinatoken-wfp-tenant",
    "x-cinatoken-wfp-runtime",
];

fn strip_wfp_internal_response_headers(headers: &mut Headers) -> worker::Result<()> {
    for name in WFP_INTERNAL_RESPONSE_HEADERS {
        headers.delete(name)?;
    }
    Ok(())
}

fn wfp_relay_path(url: &str) -> worker::Result<String> {
    let url = Url::parse(url)
        .map_err(|err| worker::Error::RustError(format!("invalid WFP relay URL: {err}")))?;
    if url.query().is_some() {
        return Err(worker::Error::RustError(
            "WFP relay transport does not allow unsigned upstream query parameters".to_string(),
        ));
    }
    let path = url.path();
    if !WFP_RELAY_SUPPORTED_PATHS.contains(&path) {
        return Err(worker::Error::RustError(format!(
            "WFP relay transport does not support upstream path {path}"
        )));
    }
    Ok(path.to_string())
}

async fn forward_wfp_relay_transport(
    env: &Env,
    url: &str,
    worker_name: &str,
    channel_id: i64,
    body: &Value,
) -> worker::Result<Response> {
    let worker_name =
        crate::platform_gateway::normalize_worker_name(worker_name).ok_or_else(|| {
            worker::Error::RustError("channel WFP worker name is invalid".to_string())
        })?;
    let path = wfp_relay_path(url)?;
    let mut target = Url::parse(url)
        .map_err(|err| worker::Error::RustError(format!("invalid WFP relay URL: {err}")))?;
    target.set_path(&path);
    let body = serde_json::to_string(body)?;
    let secret = optional_secret_or_env_var(env, AUTHORITY_SECRET_ENV)
        .ok_or_else(|| worker::Error::RustError(format!("{AUTHORITY_SECRET_ENV} must be bound")))?;
    let request_id = wfp_authority_request_id()?;
    let authority = sign_authority(
        secret.as_bytes(),
        AuthorityInput {
            worker: &worker_name,
            method: "POST",
            path: &path,
            body: body.as_bytes(),
            request_id: &request_id,
            channel_id,
            issued_at: unix_timestamp(),
        },
    )
    .map_err(|err| worker::Error::RustError(format!("failed to sign WFP authority: {err}")))?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("accept", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(target.as_str(), &init)?;
    crate::platform_gateway::dispatch_authorized_relay_request(
        outbound,
        env,
        &worker_name,
        &authority,
    )
    .await
}

fn wfp_authority_request_id() -> worker::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|err| {
        worker::Error::RustError(format!(
            "failed to generate WFP authority request id: {err}"
        ))
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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

async fn forward_ali(
    url: &str,
    upstream_key: &str,
    channel: &RelayChannel,
    body: &Value,
) -> worker::Result<Response> {
    let body_text = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &format!("Bearer {upstream_key}"))?;
    if body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        headers.set("x-dashscope-sse", "enable")?;
    }
    if let Some(plugin) = ali_plugin_header_value(&channel.other)
        .map_err(|reason| worker::Error::RustError(reason.to_string()))?
    {
        headers.set("x-dashscope-plugin", plugin)?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body_text)));
    let outbound = Request::new_with_init(url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn forward_baidu_v2_openai(
    url: &str,
    upstream_key: &str,
    body: &Value,
) -> worker::Result<Response> {
    let (token, app_id) = parse_baidu_v2_key(upstream_key).map_err(|reason| {
        worker::Error::RustError(format!("invalid Baidu V2 API key: {reason}"))
    })?;
    let body = serde_json::to_string(body)?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &format!("Bearer {token}"))?;
    if let Some(app_id) = app_id {
        headers.set("appid", app_id)?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(url, &init)?;
    Fetch::Request(outbound).send().await
}

async fn forward_tencent_hunyuan(
    url: &str,
    upstream_key: &str,
    body: &Value,
) -> worker::Result<Response> {
    let credentials = parse_tencent_key(upstream_key)
        .map_err(|reason| worker::Error::RustError(format!("invalid Tencent API key: {reason}")))?;
    let model = body
        .get("Model")
        .and_then(Value::as_str)
        .unwrap_or("tencent-hunyuan")
        .to_string();
    let body = serde_json::to_string(body)?;
    let signed = tencent_tc3_headers(&body, &credentials, unix_timestamp()).map_err(|reason| {
        worker::Error::RustError(format!("failed to sign Tencent request: {reason}"))
    })?;
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &signed.authorization)?;
    headers.set("x-tc-action", TENCENT_HUNYUAN_ACTION)?;
    headers.set("x-tc-version", TENCENT_HUNYUAN_VERSION)?;
    headers.set("x-tc-timestamp", &signed.timestamp)?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let outbound = Request::new_with_init(url, &init)?;
    let response = Fetch::Request(outbound).send().await?;
    normalize_tencent_hunyuan_response(response, &model).await
}

async fn normalize_tencent_hunyuan_response(
    mut response: Response,
    model: &str,
) -> worker::Result<Response> {
    if response.status_code() != 200 {
        return Ok(response);
    }
    let mut headers = Headers::new();
    for name in ["x-tc-requestid", "x-request-id", "retry-after"] {
        if let Some(value) = response.headers().get(name).ok().flatten() {
            let _ = headers.set(name, &value);
        }
    }
    let transformed =
        match read_response_text_limited(&mut response, DEFAULT_RELAY_JSON_RESPONSE_LIMIT_BYTES)
            .await
        {
            Ok(body) => {
                match transform_tencent_chat_response_body(&body, model, unix_timestamp()) {
                    Ok((body, _, request_id)) => {
                        if let Some(request_id) = request_id {
                            let _ = headers.set("x-tc-requestid", &request_id);
                        }
                        (200, body)
                    }
                    Err(TencentResponseError::Provider(error)) => {
                        if let Some(request_id) = error.request_id.as_deref() {
                            let _ = headers.set("x-tc-requestid", request_id);
                        }
                        let status = tencent_provider_error_status(&error.code);
                        (
                            status,
                            tencent_openai_error_body(status, &error.code, &error.message)?,
                        )
                    }
                    Err(TencentResponseError::Malformed(reason)) => (
                        502,
                        tencent_openai_error_body(502, "invalid_provider_response", reason)?,
                    ),
                }
            }
            Err(err) => (
                502,
                tencent_openai_error_body(
                    502,
                    "invalid_provider_response",
                    &err.message("Tencent response body"),
                )?,
            ),
        };
    let mut response = Response::ok(transformed.1)?
        .with_status(transformed.0)
        .with_headers(headers);
    response
        .headers_mut()
        .set("content-type", "application/json")?;
    Ok(response)
}

fn tencent_provider_error_status(code: &str) -> u16 {
    let code = code.trim().to_ascii_lowercase();
    if code.starts_with("invalidparameter") || code.starts_with("missingparameter") {
        400
    } else if code.starts_with("authfailure")
        || code.contains("signaturefailure")
        || code.contains("invalidcredential")
    {
        401
    } else if code.starts_with("unauthorizedoperation") {
        403
    } else if code.starts_with("requestlimitexceeded") {
        429
    } else if code.starts_with("internalerror")
        || code.starts_with("failedoperation.enginerequesttimeout")
        || code.starts_with("failedoperation.engineservererror")
        || code.starts_with("failedoperation.engineserverlimitexceeded")
    {
        503
    } else {
        502
    }
}

fn tencent_openai_error_body(status: u16, code: &str, message: &str) -> worker::Result<String> {
    let code = code.chars().take(128).collect::<String>();
    let message = message.chars().take(512).collect::<String>();
    let error_type = match status {
        400 => "invalid_request_error",
        401 | 403 => "authentication_error",
        429 => "rate_limit_error",
        503 => "provider_unavailable",
        _ => "provider_error",
    };
    serde_json::to_string(&json!({
        "error": {"message": message, "type": error_type, "code": code}
    }))
    .map_err(Into::into)
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
    let upstream_request_id =
        response_header(&upstream, &["x-tc-requestid", "x-request-id", "cf-ray"]);
    if status == 200 && provider == RelayProviderKind::AliOpenAi && endpoint_path == "rerank" {
        return complete_ali_rerank_response(
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
    if status == 200
        && provider == RelayProviderKind::SiliconFlowOpenAi
        && matches!(endpoint_path.as_str(), "rerank" | "images/generations")
    {
        return complete_siliconflow_response(
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
async fn complete_ali_rerank_response(
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
    _content_type: String,
    max_json_response_bytes: usize,
) -> worker::Result<Response> {
    let body = match read_response_text_limited(&mut upstream, max_json_response_bytes).await {
        Ok(body) => body,
        Err(err) => {
            let message = format!(
                "failed to read Ali rerank response: {}",
                err.message("Ali rerank response body")
            );
            record_owned_relay_audit(
                context,
                env,
                db,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                502,
                UsageSummary::default(),
                audit,
                upstream_request_id,
                "Ali rerank response validation",
            )
            .await;
            return openai_error_response(message, 502);
        }
    };
    let (body, usage) = match transform_ali_rerank_response_body(&body) {
        Ok(transformed) => transformed,
        Err(err) => {
            worker::console_error!("failed to validate Ali rerank response: {}", err);
            record_owned_relay_audit(
                context,
                env,
                db,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                502,
                UsageSummary::default(),
                audit,
                upstream_request_id,
                "Ali rerank response validation",
            )
            .await;
            return openai_error_response("invalid Ali rerank response body".to_string(), 502);
        }
    };

    record_owned_relay_audit(
        context,
        env,
        db,
        auth,
        channel,
        model,
        group,
        endpoint_path,
        status,
        usage,
        audit,
        upstream_request_id,
        "Ali rerank",
    )
    .await;

    let mut response = Response::ok(body)?.with_status(status);
    response
        .headers_mut()
        .set("content-type", "application/json")?;
    set_cors_headers(&mut response)?;
    Ok(response)
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

#[allow(clippy::too_many_arguments)]
async fn complete_siliconflow_response(
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
    let body = match read_response_text_limited(&mut upstream, max_json_response_bytes).await {
        Ok(body) => body,
        Err(err) => {
            let message = format!(
                "failed to read SiliconFlow response: {}",
                err.message("SiliconFlow response body")
            );
            record_owned_relay_audit(
                context,
                env,
                db,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                502,
                UsageSummary::default(),
                audit,
                upstream_request_id,
                "SiliconFlow response validation",
            )
            .await;
            return openai_error_response(message, 502);
        }
    };

    let transformed = if endpoint_path == "rerank" {
        transform_siliconflow_rerank_response_body(&body)
    } else {
        siliconflow_image_response_usage(&body).map(|usage| (body.clone(), usage))
    };
    let (body, usage) = match transformed {
        Ok(transformed) => transformed,
        Err(err) => {
            worker::console_error!("failed to validate SiliconFlow response: {}", err);
            record_owned_relay_audit(
                context,
                env,
                db,
                auth,
                channel,
                model,
                group,
                endpoint_path,
                502,
                UsageSummary::default(),
                audit,
                upstream_request_id,
                "SiliconFlow response validation",
            )
            .await;
            return openai_error_response("invalid SiliconFlow response body".to_string(), 502);
        }
    };

    record_owned_relay_audit(
        context,
        env,
        db,
        auth,
        channel,
        model,
        group,
        endpoint_path,
        status,
        usage,
        audit,
        upstream_request_id,
        "SiliconFlow",
    )
    .await;

    let mut response = Response::ok(body)?.with_status(status);
    response.headers_mut().set("content-type", &content_type)?;
    set_cors_headers(&mut response)?;
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
async fn record_owned_relay_audit(
    context: Option<Context>,
    env: Env,
    db: D1Database,
    auth: AuthenticatedToken,
    channel: RelayChannel,
    model: String,
    group: String,
    endpoint_path: String,
    status: u16,
    usage: UsageSummary,
    audit: RelayAuditContext,
    upstream_request_id: Option<String>,
    log_label: &'static str,
) {
    // A tiered reserve has durable financial state and must be finalized before
    // returning a buffered response. Streaming responses retain waitUntil so
    // their cloned body can be consumed after the client response starts; the
    // D1 lease sweep conservatively refunds an abandoned stream reservation.
    if audit
        .tiered_billing_preflight
        .as_ref()
        .is_some_and(|preflight| preflight.reserve_applied)
    {
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
        return;
    }
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
        && matches!(
            provider,
            RelayProviderKind::AliOpenAi
                | RelayProviderKind::BaiduV2OpenAi
                | RelayProviderKind::OpenAiCompatible
                | RelayProviderKind::DeepSeekOpenAi
                | RelayProviderKind::MistralOpenAi
                | RelayProviderKind::MoonshotOpenAi
                | RelayProviderKind::PerplexityOpenAi
                | RelayProviderKind::SiliconFlowOpenAi
                | RelayProviderKind::SubmodelOpenAi
                | RelayProviderKind::XaiOpenAi
                | RelayProviderKind::VolcEngineOpenAi
        )
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
        RelayProviderKind::AliOpenAi if endpoint_path == "rerank" => {
            usage_summary_from_rerank_body(body)
        }
        RelayProviderKind::AliOpenAi => usage_summary_from_body(body),
        RelayProviderKind::AliMessages => usage_summary_from_anthropic_body(body),
        RelayProviderKind::OpenAiCompatible if endpoint_path == "rerank" => {
            usage_summary_from_rerank_body(body)
        }
        RelayProviderKind::MoonshotOpenAi if endpoint_path == "rerank" => {
            usage_summary_from_rerank_body(body)
        }
        RelayProviderKind::MoonshotOpenAi => usage_summary_from_moonshot_body(body),
        RelayProviderKind::BaiduV2OpenAi
        | RelayProviderKind::OpenAiCompatible
        | RelayProviderKind::DeepSeekOpenAi
        | RelayProviderKind::MistralOpenAi
        | RelayProviderKind::PerplexityOpenAi
        | RelayProviderKind::SiliconFlowOpenAi
        | RelayProviderKind::SubmodelOpenAi
        | RelayProviderKind::TencentHunyuan
        | RelayProviderKind::XaiOpenAi
        | RelayProviderKind::VolcEngineOpenAi => usage_summary_from_body(body),
        RelayProviderKind::AnthropicMessages
        | RelayProviderKind::DeepSeekMessages
        | RelayProviderKind::MoonshotMessages => usage_summary_from_anthropic_body(body),
        RelayProviderKind::GeminiNative => usage_summary_from_gemini_body(body),
    }
}

#[derive(Debug, Clone)]
struct RelayBillingStreamLease {
    reservation_key: String,
    channel_id: i64,
    selected_group: String,
    selected_at: i64,
    initial_lease_expires_at: i64,
    lease_seconds: i64,
    heartbeat_seconds: i64,
}

#[derive(Debug, Clone)]
struct RelayBillingStreamLeaseHeartbeatAudit {
    interval_seconds: i64,
    initial_lease_expires_at: i64,
    final_lease_expires_at: i64,
    last_renewed_at: Option<i64>,
    attempt_count: u32,
    renewed_count: u32,
    matching_count: u32,
    failure_count: u32,
    stopped_reason: Option<&'static str>,
    completion_reason: Option<&'static str>,
    usage_recovered_after_error: bool,
}

impl RelayBillingStreamLeaseHeartbeatAudit {
    fn new(interval_seconds: i64, initial_lease_expires_at: i64) -> Self {
        Self {
            interval_seconds,
            initial_lease_expires_at,
            final_lease_expires_at: initial_lease_expires_at,
            last_renewed_at: None,
            attempt_count: 0,
            renewed_count: 0,
            matching_count: 0,
            failure_count: 0,
            stopped_reason: None,
            completion_reason: None,
            usage_recovered_after_error: false,
        }
    }
}

#[derive(Debug, Default)]
struct StreamingUsageResolution {
    usage: UsageSummary,
    locally_estimated: bool,
    terminal_error: Option<String>,
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
                if let Err(refund_err) = refund_tiered_billing_preflight(
                    &db,
                    &auth,
                    preflight,
                    "stream_clone_failed",
                    crate::d1_repositories::RelayBillingRequestAccounting::Skip,
                    unix_timestamp(),
                )
                .await
                {
                    return Err(worker::Error::RustError(format!(
                        "failed to initialize streaming audit branch: {err}; tiered billing reserve refund failed: {refund_err}"
                    )));
                }
            }
            return Err(err);
        }
    };
    let stream_lease = audit
        .tiered_billing_preflight
        .as_ref()
        .filter(|preflight| preflight.reserve_applied)
        .and_then(|preflight| {
            let reservation_key = preflight.reservation_key.clone()?;
            let heartbeat_seconds = relay_billing_stream_lease_heartbeat_interval_seconds(
                relay_billing_stream_lease_heartbeat_seconds(&env),
                &reservation_key,
            );
            Some(RelayBillingStreamLease {
                reservation_key,
                channel_id: channel.id,
                selected_group: group.clone(),
                selected_at: preflight.selected_at?,
                initial_lease_expires_at: preflight.selected_lease_expires_at?,
                lease_seconds: relay_billing_reservation_lease_seconds(&env),
                heartbeat_seconds,
            })
        });

    context.wait_until(async move {
        let mut audit = audit;
        let mut heartbeat_audit = stream_lease.as_ref().map(|lease| {
            RelayBillingStreamLeaseHeartbeatAudit::new(
                lease.heartbeat_seconds,
                lease.initial_lease_expires_at,
            )
        });
        let resolution = match streaming_usage_summary(
            &mut audit_response,
            provider,
            &endpoint_path,
            &model,
            audit.estimated_prompt_tokens,
            audit.missing_usage_estimate_enabled,
            &db,
            stream_lease.as_ref(),
            heartbeat_audit.as_mut(),
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(err) => {
                worker::console_error!("failed to initialize streaming relay usage audit: {}", err);
                StreamingUsageResolution::default()
            }
        };
        if let Some(err) = resolution.terminal_error.as_deref() {
            worker::console_error!(
                "streaming relay usage audit recovered partial evidence after read error: {}",
                err
            );
        }
        audit.usage_locally_estimated = resolution.locally_estimated;
        audit.stream_lease_heartbeat = heartbeat_audit;
        if let Err(err) = record_relay_audit(
            &env,
            &db,
            &auth,
            &channel,
            &model,
            &group,
            &endpoint_path,
            status,
            &resolution.usage,
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
    endpoint_path: &str,
    model: &str,
    estimated_prompt_tokens: i64,
    estimate_enabled: bool,
    db: &D1Database,
    stream_lease: Option<&RelayBillingStreamLease>,
    heartbeat_audit: Option<&mut RelayBillingStreamLeaseHeartbeatAudit>,
) -> worker::Result<StreamingUsageResolution> {
    let mut stream = upstream.stream()?;
    let mut accumulator = match provider {
        RelayProviderKind::AliOpenAi
        | RelayProviderKind::BaiduV2OpenAi
        | RelayProviderKind::OpenAiCompatible
        | RelayProviderKind::DeepSeekOpenAi
        | RelayProviderKind::MistralOpenAi
        | RelayProviderKind::PerplexityOpenAi
        | RelayProviderKind::SiliconFlowOpenAi
        | RelayProviderKind::SubmodelOpenAi
        | RelayProviderKind::TencentHunyuan
        | RelayProviderKind::XaiOpenAi
        | RelayProviderKind::VolcEngineOpenAi => SseUsageAccumulator::default(),
        RelayProviderKind::MoonshotOpenAi => SseUsageAccumulator::moonshot(),
        RelayProviderKind::AliMessages
        | RelayProviderKind::AnthropicMessages
        | RelayProviderKind::DeepSeekMessages
        | RelayProviderKind::MoonshotMessages => SseUsageAccumulator::anthropic(),
        RelayProviderKind::GeminiNative => SseUsageAccumulator::gemini(),
    };

    let mut heartbeat_audit = heartbeat_audit;
    let mut terminal_error = None;
    let mut heartbeat_active = stream_lease.is_some();
    let mut expected_lease_expires_at = stream_lease
        .map(|lease| lease.initial_lease_expires_at)
        .unwrap_or_default();
    let mut next_heartbeat_at = stream_lease
        .map(|lease| unix_timestamp().saturating_add(lease.heartbeat_seconds))
        .unwrap_or_default();
    loop {
        if let Some(lease) = stream_lease.filter(|_| heartbeat_active) {
            let now = unix_timestamp();
            if now >= next_heartbeat_at {
                if let Some(audit) = heartbeat_audit.as_deref_mut() {
                    audit.attempt_count = audit.attempt_count.saturating_add(1);
                }
                use crate::d1_repositories::RelayBillingLeaseRenewalOutcome as Outcome;
                let requested_lease_expires_at = now.saturating_add(lease.lease_seconds);
                let mut next_delay_seconds = lease.heartbeat_seconds;
                match crate::d1_repositories::renew_relay_billing_selected_attempt_lease(
                    db,
                    &lease.reservation_key,
                    lease.channel_id,
                    &lease.selected_group,
                    lease.selected_at,
                    expected_lease_expires_at,
                    now,
                    requested_lease_expires_at,
                )
                .await
                {
                    Ok(Outcome::Applied) => {
                        expected_lease_expires_at = requested_lease_expires_at;
                        if let Some(audit) = heartbeat_audit.as_deref_mut() {
                            audit.renewed_count = audit.renewed_count.saturating_add(1);
                            audit.final_lease_expires_at = requested_lease_expires_at;
                            audit.last_renewed_at = Some(now);
                        }
                    }
                    Ok(Outcome::MatchingRenewal) => {
                        expected_lease_expires_at = requested_lease_expires_at;
                        if let Some(audit) = heartbeat_audit.as_deref_mut() {
                            audit.matching_count = audit.matching_count.saturating_add(1);
                            audit.final_lease_expires_at = requested_lease_expires_at;
                            audit.last_renewed_at = Some(now);
                        }
                    }
                    Ok(outcome) => {
                        heartbeat_active = false;
                        let reason = match outcome {
                            Outcome::AlreadyFinalized => "already_finalized",
                            Outcome::StaleGeneration => "stale_generation",
                            Outcome::DeadlineExpired => "deadline_expired",
                            Outcome::Conflict => "identity_conflict",
                            Outcome::NotFound => "not_found",
                            Outcome::Applied | Outcome::MatchingRenewal => unreachable!(),
                        };
                        if let Some(audit) = heartbeat_audit.as_deref_mut() {
                            audit.stopped_reason = Some(reason);
                        }
                        worker::console_warn!(
                            "relay billing stream lease heartbeat stopped: {reason}"
                        );
                    }
                    Err(err) => {
                        next_delay_seconds = lease
                            .heartbeat_seconds
                            .min(RELAY_BILLING_STREAM_LEASE_HEARTBEAT_RETRY_MAX_SECONDS);
                        if let Some(audit) = heartbeat_audit.as_deref_mut() {
                            audit.failure_count = audit.failure_count.saturating_add(1);
                        }
                        worker::console_warn!(
                            "relay billing stream lease heartbeat failed; stream remains active: {err}"
                        );
                    }
                }
                next_heartbeat_at = now.saturating_add(next_delay_seconds);
            }
        }

        if heartbeat_active {
            let wait_seconds = next_heartbeat_at.saturating_sub(unix_timestamp()).max(1);
            let next_chunk = Box::pin(stream.next());
            let heartbeat = Box::pin(Delay::from(Duration::from_secs(
                u64::try_from(wait_seconds).unwrap_or(1),
            )));
            match select(next_chunk, heartbeat).await {
                Either::Left((Some(chunk), _)) => match chunk {
                    Ok(chunk) => accumulator.push_chunk(&chunk),
                    Err(err) => {
                        if let Some(audit) = heartbeat_audit.as_deref_mut() {
                            audit.completion_reason = Some("stream_error");
                        }
                        terminal_error = Some(err.to_string());
                        break;
                    }
                },
                Either::Left((None, _)) => break,
                Either::Right((_, pending_chunk)) => {
                    drop(pending_chunk);
                }
            }
        } else {
            match stream.next().await {
                Some(Ok(chunk)) => accumulator.push_chunk(&chunk),
                Some(Err(err)) => {
                    if let Some(audit) = heartbeat_audit.as_deref_mut() {
                        audit.completion_reason = Some("stream_error");
                    }
                    terminal_error = Some(err.to_string());
                    break;
                }
                None => break,
            }
        }
    }
    if terminal_error.is_none() {
        if let Some(audit) = heartbeat_audit.as_deref_mut() {
            audit.completion_reason = Some("stream_completed");
        }
    }

    let (usage, response_text, tool_count) = accumulator.into_parts();
    // The streamed-text accumulation is OpenAI-shaped; only estimate for that
    // provider (Anthropic/Gemini emit reliable usage chunks).
    let estimate_applicable = estimate_enabled
        && matches!(
            provider,
            RelayProviderKind::AliOpenAi
                | RelayProviderKind::BaiduV2OpenAi
                | RelayProviderKind::OpenAiCompatible
                | RelayProviderKind::DeepSeekOpenAi
                | RelayProviderKind::MistralOpenAi
                | RelayProviderKind::MoonshotOpenAi
                | RelayProviderKind::PerplexityOpenAi
                | RelayProviderKind::SiliconFlowOpenAi
                | RelayProviderKind::SubmodelOpenAi
                | RelayProviderKind::XaiOpenAi
                | RelayProviderKind::VolcEngineOpenAi
        );
    let (usage, locally_estimated) = resolve_stream_usage(
        usage,
        &response_text,
        tool_count,
        endpoint_path,
        model,
        estimated_prompt_tokens,
        estimate_applicable,
    );
    let usage_recovered_after_error = terminal_error.is_some()
        && cinatoken_tokenizer::valid_usage(
            usage.prompt_tokens as i64,
            usage.completion_tokens as i64,
        );
    if let Some(audit) = heartbeat_audit.as_deref_mut() {
        audit.usage_recovered_after_error = usage_recovered_after_error;
    }
    if locally_estimated {
        worker::console_log!(
            "relay stream usage missing; locally estimated usage for {} (prompt={}, completion={}, tools={})",
            model,
            usage.prompt_tokens,
            usage.completion_tokens,
            tool_count
        );
    }
    Ok(StreamingUsageResolution {
        usage,
        locally_estimated,
        terminal_error,
    })
}

/*
 * Keep the endpoint-aware resolution below separate from stream I/O. This lets
 * unit tests lock Go parity without requiring a Worker ReadableStream.
 */
fn resolve_stream_usage(
    usage: UsageSummary,
    response_text: &str,
    tool_count: i64,
    endpoint_path: &str,
    model: &str,
    estimated_prompt_tokens: i64,
    enabled: bool,
) -> (UsageSummary, bool) {
    if !enabled {
        return (usage, false);
    }
    if matches!(endpoint_path, "responses" | "responses/compact") {
        let mut resolved = usage;
        let mut locally_estimated = false;
        if resolved.completion_tokens == 0 && !response_text.is_empty() {
            let estimate = cinatoken_tokenizer::response_text_to_usage(
                model,
                response_text,
                estimated_prompt_tokens,
                0,
            );
            resolved.completion_tokens = estimate.completion_tokens as i32;
            locally_estimated = resolved.completion_tokens > 0;
        }
        if resolved.prompt_tokens == 0 && resolved.completion_tokens != 0 {
            resolved.prompt_tokens = estimated_prompt_tokens as i32;
            locally_estimated = true;
        }
        if locally_estimated {
            resolved.total_tokens = resolved
                .prompt_tokens
                .saturating_add(resolved.completion_tokens);
        }
        return (resolved, locally_estimated);
    }
    if cinatoken_tokenizer::valid_usage(usage.prompt_tokens as i64, usage.completion_tokens as i64)
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
    /// Bounded D1 lease-renewal evidence for positive-reserve SSE requests.
    /// This is populated by the cloned stream branch and never contains the
    /// reservation key or account identity.
    stream_lease_heartbeat: Option<RelayBillingStreamLeaseHeartbeatAudit>,
    /// Fixed-rule channel affinity diagnostics for usage-log UI and upstream
    /// cache-hit stats. `None` when affinity is disabled or unavailable.
    affinity: Option<affinity::AffinityAuditContext>,
    /// Request-vs-served model routing evidence. This keeps cross-model
    /// fallback visible without changing the final relay log's role as the
    /// authoritative settlement row.
    model_route: RelayModelRouteAudit,
    /// Bounded, secret-free channel-attempt evidence. User log responses strip
    /// `other`; operators retain this ledger under `other.admin_info`.
    attempts: RelayAttemptAuditLedger,
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
    let reported_usage_present =
        usage_summary_is_present(usage, audit.missing_usage_estimate_enabled);
    // Image-generation APIs commonly return a successful URL without token
    // usage. Treat that response as billable by request contract while keeping
    // the real zero-token vector for tiered expressions and fixed-price audit.
    let request_contract_usage =
        usage_less_request_contract_applies(endpoint_path, reported_usage_present);
    let usage_present = reported_usage_present || request_contract_usage;
    let usage_source = if audit.usage_locally_estimated {
        "local_estimate"
    } else if request_contract_usage {
        "request_contract"
    } else {
        "upstream"
    };
    let mut other = json!({
        "billing_pending": true,
        "relay_runtime": "cloudflare_worker_rust",
        "endpoint": endpoint_path,
        "upstream_status": upstream_status,
        "total_tokens": usage.total_tokens,
        "usage_source": usage_source,
        "model_route": {
            "requested_model": audit.model_route.requested_model,
            "served_model": audit.model_route.served_model,
            "fallback_model": audit.model_route.fallback_model,
            "fallback_attempted": audit.model_route.fallback_attempted,
            "fallback_trigger": audit.model_route.fallback_trigger,
            "fallback_skip_reason": audit.model_route.fallback_skip_reason,
            "ai_gateway_direct_fallback": audit.model_route.ai_gateway_direct_fallback,
            "cross_group_retry": audit.model_route.cross_group_retry,
            "primary_planned_group_count": audit.model_route.primary_planned_group_count,
            "fallback_planned_group_count": audit.model_route.fallback_planned_group_count,
            "wfp_worker": audit.model_route.wfp_worker,
        },
    });
    let mut admin_info = serde_json::Map::new();
    if let Some(affinity_context) = audit.affinity.as_ref() {
        admin_info.insert(
            "channel_affinity".to_string(),
            affinity::affinity_log_info(affinity_context),
        );
    }
    if !audit.attempts.is_empty() {
        admin_info.insert(
            "relay_attempts".to_string(),
            Value::Array(audit.attempts.json_entries()),
        );
        admin_info.insert(
            "relay_attempt_count".to_string(),
            json!(audit.attempts.total),
        );
        admin_info.insert(
            "relay_attempts_truncated".to_string(),
            json!(audit.attempts.truncated()),
        );
    }
    if let Some(heartbeat) = audit.stream_lease_heartbeat.as_ref() {
        admin_info.insert(
            "relay_billing_stream_lease_heartbeat".to_string(),
            json!({
                "interval_seconds": heartbeat.interval_seconds,
                "initial_lease_expires_at": heartbeat.initial_lease_expires_at,
                "final_lease_expires_at": heartbeat.final_lease_expires_at,
                "last_renewed_at": heartbeat.last_renewed_at,
                "attempt_count": heartbeat.attempt_count,
                "renewed_count": heartbeat.renewed_count,
                "matching_count": heartbeat.matching_count,
                "failure_count": heartbeat.failure_count,
                "stopped_reason": heartbeat.stopped_reason,
                "completion_reason": heartbeat.completion_reason,
                "usage_recovered_after_error": heartbeat.usage_recovered_after_error,
            }),
        );
    }
    if !admin_info.is_empty() {
        set_json_value(&mut other, "admin_info", Value::Object(admin_info));
    }
    let mut quota = 0;
    let mut billing_applied = false;
    let mut billing_resolved = false;
    let mut request_count_owned_by_ledger = audit
        .tiered_billing_preflight
        .as_ref()
        .is_some_and(|preflight| preflight.reserve_applied);
    if let Some(preflight) = audit.tiered_billing_preflight.as_ref() {
        if let Some(reservation_key) = preflight.reservation_key.as_deref() {
            set_json_string(
                &mut other,
                "billing_reservation_key",
                reservation_key.to_string(),
            );
            set_json_string(&mut other, "billing_ledger_outcome", "pending".to_string());
        }
        if upstream_status < 400 && usage_present {
            match tiered_billing_settlement(preflight, usage, &audit.billing_request_input) {
                Ok(outcome) => {
                    let final_quota = outcome.final_quota;
                    let quota_result = if preflight.reserve_applied {
                        let reservation_key =
                            preflight.reservation_key.as_deref().ok_or_else(|| {
                                worker::Error::RustError(
                                    "relay billing reservation key is missing".to_string(),
                                )
                            });
                        match reservation_key {
                            Ok(reservation_key) => {
                                crate::d1_repositories::settle_relay_billing_reservation(
                                    db,
                                    reservation_key,
                                    channel.id,
                                    group,
                                    final_quota,
                                    "usage_settlement",
                                    now,
                                )
                                .await
                                .and_then(|outcome| {
                                    require_relay_billing_finalization(outcome, "settlement")
                                })
                            }
                            Err(err) => Err(err),
                        }
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
                            request_count_owned_by_ledger = true;
                            set_json_bool(&mut other, "billing_pending", false);
                            set_json_string(
                                &mut other,
                                "billing_ledger_outcome",
                                "settled".to_string(),
                            );
                            apply_tiered_log_display_metadata(
                                &mut other,
                                &outcome.snapshot,
                                Some(&outcome.result),
                            );
                            let metadata = tiered_billing_metadata(
                                preflight,
                                outcome.snapshot,
                                outcome.result,
                                false,
                                true,
                            );
                            set_json_value(&mut other, "tiered_billing", metadata);
                        }
                        Err(err) => {
                            let metadata = tiered_billing_metadata(
                                preflight,
                                outcome.snapshot,
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
                        let fallback_settlement = match preflight.reservation_key.as_deref() {
                            Some(reservation_key) => {
                                crate::d1_repositories::settle_relay_billing_reservation(
                                    db,
                                    reservation_key,
                                    channel.id,
                                    group,
                                    preflight.pre_consumed_quota,
                                    "expression_fallback_settlement",
                                    now,
                                )
                                .await
                                .and_then(|outcome| {
                                    require_relay_billing_finalization(
                                        outcome,
                                        "fallback settlement",
                                    )
                                })
                            }
                            None => Err(worker::Error::RustError(
                                "relay billing reservation key is missing".to_string(),
                            )),
                        };
                        match fallback_settlement {
                            Ok(()) => {
                                quota = preflight.pre_consumed_quota;
                                billing_applied = true;
                                billing_resolved = true;
                                request_count_owned_by_ledger = true;
                                set_json_bool(&mut other, "billing_pending", false);
                                set_json_string(
                                    &mut other,
                                    "billing_ledger_outcome",
                                    "settled".to_string(),
                                );
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
            let reason = refund_reason(
                upstream_status,
                usage,
                is_stream,
                audit.missing_usage_estimate_enabled,
            );
            match refund_tiered_billing_preflight(
                db,
                auth,
                preflight,
                reason,
                crate::d1_repositories::RelayBillingRequestAccounting::Account,
                now,
            )
            .await
            {
                Ok(()) => {
                    billing_resolved = true;
                    request_count_owned_by_ledger = true;
                    set_json_bool(&mut other, "billing_pending", false);
                    set_json_string(&mut other, "billing_ledger_outcome", "refunded".to_string());
                    set_json_value(
                        &mut other,
                        "tiered_billing_refund",
                        tiered_billing_refund_metadata(preflight, reason),
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

    if should_apply_flat_billing(
        audit.tiered_billing_preflight.is_some(),
        billing_applied,
        upstream_status,
        usage_present,
    ) {
        // Non-tiered ("flat") billing: compute the per-token (or fixed-price)
        // quota from ModelRatio / CompletionRatio / ModelPrice options and
        // apply it atomically. This path is used only when no `tiered_expr`
        // preflight exists; a failed tiered mutation must remain pending rather
        // than attempting a second, flat charge. Mirrors Go's
        // `service/text_quota.go::PostTextConsumeQuota` non-tiered path.
        match try_flat_billing(
            db,
            auth,
            channel.id,
            channel.channel_type,
            model,
            group,
            endpoint_path,
            audit.billing_request_input.body.as_ref(),
            usage,
            now,
        )
        .await
        {
            Ok(Some(flat_result)) => {
                quota = flat_result.quota;
                billing_applied = true;
                billing_resolved = true;
                apply_flat_billing_audit(&mut other, &flat_result);
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

    if !billing_applied && !request_count_owned_by_ledger {
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
    let event = AuditLogEvent::from_relay_audit(now, &content, &audit_log, LOG_TYPE_CONSUME);
    persist_audit_log_event(env, db, &event).await
}

fn should_apply_flat_billing(
    has_tiered_preflight: bool,
    billing_applied: bool,
    upstream_status: u16,
    usage_present: bool,
) -> bool {
    !has_tiered_preflight && !billing_applied && upstream_status < 400 && usage_present
}

fn usage_summary_is_present(usage: &UsageSummary, estimate_enabled: bool) -> bool {
    if estimate_enabled {
        cinatoken_tokenizer::valid_usage(usage.prompt_tokens as i64, usage.completion_tokens as i64)
    } else {
        usage.total_tokens > 0
    }
}

fn usage_less_request_contract_applies(endpoint_path: &str, reported_usage_present: bool) -> bool {
    endpoint_path == "images/generations" && !reported_usage_present
}

fn apply_flat_billing_audit(other: &mut Value, result: &FlatQuotaResult) {
    set_json_bool(other, "billing_pending", false);
    set_json_value(
        other,
        "flat_billing",
        serde_json::json!({
            "quota": result.quota,
            "mode": match result.mode {
                FlatBillingMode::FixedPrice => "fixed_price",
                FlatBillingMode::PerToken => "per_token",
            },
            "model_ratio": result.model_ratio,
            "completion_ratio": result.completion_ratio,
            "group_ratio": result.group_ratio,
            "cache_ratio": result.cache_ratio,
            "fixed_price_multiplier": result.fixed_price_multiplier,
        }),
    );
}

async fn persist_audit_log_event(
    env: &Env,
    db: &D1Database,
    event: &AuditLogEvent,
) -> worker::Result<()> {
    match env.queue("LOG_QUEUE") {
        Ok(queue) => match queue.send(&event).await {
            Ok(()) => Ok(()),
            Err(err) => {
                worker::console_warn!(
                    "LOG_QUEUE send failed, falling back to synchronous D1 insert: {err}"
                );
                crate::d1_repositories::insert_audit_log_event(db, event).await
            }
        },
        Err(_) => {
            // Queue binding not configured (local dev / tests).
            crate::d1_repositories::insert_audit_log_event(db, event).await
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn terminal_relay_failure_event(
    now: i64,
    started_at: i64,
    auth: &AuthenticatedToken,
    model: &str,
    group: &str,
    endpoint_path: &str,
    client_ip: Option<&str>,
    request_id: Option<&str>,
    is_stream: bool,
    model_route: &RelayModelRouteAudit,
    attempts: &RelayAttemptAuditLedger,
    last_failure: Option<&RelayAttemptFailure>,
    terminal_audit_event_id: Option<&str>,
    reserve_refund: &str,
) -> AuditLogEvent {
    let channel_id = last_failure.map(|failure| failure.channel_id).unwrap_or(0);
    let failure_kind = last_failure
        .map(|failure| failure.kind.audit_label())
        .unwrap_or("no_candidate");
    let status = last_failure.and_then(|failure| failure.status);
    let attempt_values = attempts.json_entries();
    let other = json!({
        "relay_runtime": "cloudflare_worker_rust",
        "request_path": endpoint_path,
        "error_type": "upstream_error",
        "error_code": "relay_attempts_exhausted",
        "status_code": status,
        "channel_id": channel_id,
        "terminal_failure": true,
        "terminal_audit_event_id": terminal_audit_event_id,
        "model_route": {
            "requested_model": model_route.requested_model,
            "served_model": model_route.served_model,
            "fallback_model": model_route.fallback_model,
            "fallback_attempted": model_route.fallback_attempted,
            "fallback_trigger": model_route.fallback_trigger,
            "fallback_skip_reason": model_route.fallback_skip_reason,
            "ai_gateway_direct_fallback": model_route.ai_gateway_direct_fallback,
            "cross_group_retry": model_route.cross_group_retry,
            "primary_planned_group_count": model_route.primary_planned_group_count,
            "fallback_planned_group_count": model_route.fallback_planned_group_count,
            "wfp_worker": model_route.wfp_worker,
        },
        "admin_info": {
            "attempt_count": attempts.total,
            "relay_attempts": attempt_values,
            "attempts_truncated": attempts.truncated(),
            "last_failure_kind": failure_kind,
            "reserve_refund": reserve_refund,
        },
    });
    let other_json = other.to_string();
    let content = format!("Rust relay failed {endpoint_path}: all upstream attempts exhausted");
    let empty = "";
    let audit_log = RelayAuditLog {
        user_id: auth.user_id,
        username: &auth.username,
        token_id: auth.token_id,
        token_name: &auth.token_name,
        channel_id,
        model,
        group,
        prompt_tokens: 0,
        completion_tokens: 0,
        quota: 0,
        use_time_seconds: now.saturating_sub(started_at),
        is_stream,
        ip: client_ip.unwrap_or(empty),
        request_id: request_id.unwrap_or(empty),
        upstream_request_id: empty,
        other: &other_json,
    };
    AuditLogEvent::from_relay_audit(now, &content, &audit_log, LOG_TYPE_ERROR)
}

fn random_terminal_audit_event_id() -> Option<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Some(encoded)
}

struct TieredBillingOutcome {
    final_quota: i64,
    snapshot: TieredBillingSnapshot,
    result: TieredBillingResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActualGroupBillingSmokeAction {
    SettleSelectedGroup,
    RefundExhaustedPlan,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ActualGroupBillingSmokeEvidence {
    pub candidate_group_count: usize,
    pub reservation_strategy: &'static str,
    pub reserved_quota: i64,
    pub selected_group: Option<String>,
    pub selected_group_ratio: Option<f64>,
    pub selected_group_estimated_quota: Option<i64>,
    pub final_quota: i64,
    pub refund_quota: i64,
    pub additional_quota: i64,
}

const TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY: &str = "max_candidate_group";
const TIERED_BILLING_SELECTED_GROUP_STRATEGY: &str = "selected_group";

#[derive(Clone)]
struct TieredBillingPreflight {
    snapshot: TieredBillingSnapshot,
    pre_consumed_quota: i64,
    reserve_applied: bool,
    selected_group: String,
    candidate_group_count: usize,
    reservation_strategy: &'static str,
    reservation_key: Option<String>,
    selected_at: Option<i64>,
    selected_lease_expires_at: Option<i64>,
}

#[derive(Clone)]
struct TieredBillingGroupPlan {
    snapshots: HashMap<String, TieredBillingSnapshot>,
    reserved_quota: i64,
    reserve_applied: bool,
    reservation_key: Option<String>,
}

impl TieredBillingGroupPlan {
    fn selected_preflight(&self, selected_group: &str) -> Option<TieredBillingPreflight> {
        let snapshot = self.snapshots.get(selected_group)?.clone();
        Some(TieredBillingPreflight {
            snapshot,
            pre_consumed_quota: self.reserved_quota,
            reserve_applied: self.reserve_applied,
            selected_group: selected_group.to_string(),
            candidate_group_count: self.snapshots.len(),
            reservation_strategy: if self.snapshots.len() > 1 {
                TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY
            } else {
                TIERED_BILLING_SELECTED_GROUP_STRATEGY
            },
            reservation_key: self.reservation_key.clone(),
            selected_at: None,
            selected_lease_expires_at: None,
        })
    }
}

async fn prepare_tiered_billing_preflight(
    db: &D1Database,
    model: &str,
    user_group: &str,
    group: &str,
    request_body: &Value,
    request: &RequestInput,
    is_openai_chat: bool,
    extra_prompt_tokens: i64,
) -> worker::Result<Option<TieredBillingPreflight>> {
    let Some(expr) = crate::d1_repositories::tiered_billing_expr_for_model(db, model).await? else {
        return Ok(None);
    };
    let groups = [group.to_string()];
    let group_ratios =
        crate::d1_repositories::group_ratios_for_user_and_groups(db, user_group, &groups).await?;
    let group_ratio = group_ratios.get(group).copied().unwrap_or(1.0);
    let mut preflight = tiered_billing_preflight_snapshot(
        model,
        &expr,
        group_ratio,
        request_body,
        request.clone(),
        is_openai_chat,
        extra_prompt_tokens,
    )
    .map_err(worker::Error::RustError)?;
    preflight.selected_group = group.to_string();
    Ok(Some(preflight))
}

#[allow(clippy::too_many_arguments)]
async fn prepare_tiered_billing_group_plan(
    db: &D1Database,
    model: &str,
    user_group: &str,
    groups: &[String],
    request_body: &Value,
    request: &RequestInput,
    is_openai_chat: bool,
    extra_prompt_tokens: i64,
) -> worker::Result<Option<TieredBillingGroupPlan>> {
    let mut unique_groups = Vec::new();
    for group in groups {
        if !group.trim().is_empty() && !unique_groups.contains(group) {
            unique_groups.push(group.clone());
        }
    }
    let Some(first_group) = unique_groups.first() else {
        return Ok(None);
    };
    let Some(expr) = crate::d1_repositories::tiered_billing_expr_for_model(db, model).await? else {
        return Ok(None);
    };
    let group_ratios =
        crate::d1_repositories::group_ratios_for_user_and_groups(db, user_group, &unique_groups)
            .await?;
    let first_ratio = group_ratios.get(first_group).copied().unwrap_or(1.0);
    let base = tiered_billing_preflight_snapshot(
        model,
        &expr,
        first_ratio,
        request_body,
        request.clone(),
        is_openai_chat,
        extra_prompt_tokens,
    )
    .map_err(worker::Error::RustError)?;
    tiered_billing_group_plan_from_base(base.snapshot, &unique_groups, &group_ratios)
        .map(Some)
        .map_err(worker::Error::RustError)
}

/// Execute one fixed staging-smoke billing plan through the same D1 reserve,
/// selected-group settlement, and refund functions used by the relay. The
/// caller owns fixture setup/cleanup and must gate this away from production.
pub(crate) async fn execute_actual_group_billing_smoke_plan(
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel_id: i64,
    model: &str,
    groups: &[String],
    selected_group: &str,
    action: ActualGroupBillingSmokeAction,
    now: i64,
) -> worker::Result<ActualGroupBillingSmokeEvidence> {
    let request_body = json!({
        "model": model,
        "messages": [{"role": "user", "content": "word ".repeat(1_000)}],
        "max_completion_tokens": 2_000
    });
    let request = RequestInput::from_json_body(request_body.clone());
    let Some(mut plan) = prepare_tiered_billing_group_plan(
        db,
        model,
        &auth.user_group,
        groups,
        &request_body,
        &request,
        true,
        0,
    )
    .await?
    else {
        return Err(worker::Error::RustError(format!(
            "actual-group billing smoke model {model} is not configured for tiered billing"
        )));
    };
    let candidate_group_count = plan.snapshots.len();
    let reservation_strategy = if candidate_group_count > 1 {
        TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY
    } else {
        TIERED_BILLING_SELECTED_GROUP_STRATEGY
    };
    let reserved_quota = plan.reserved_quota;
    reserve_tiered_billing_group_plan(
        db,
        auth,
        &mut plan,
        model,
        "actual-group-billing-smoke",
        None,
        RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS,
        now,
    )
    .await?;

    match action {
        ActualGroupBillingSmokeAction::RefundExhaustedPlan => {
            refund_tiered_billing_group_plan(db, auth, &plan, "staging_smoke_refund", now).await?;
            Ok(ActualGroupBillingSmokeEvidence {
                candidate_group_count,
                reservation_strategy,
                reserved_quota,
                selected_group: None,
                selected_group_ratio: None,
                selected_group_estimated_quota: None,
                final_quota: 0,
                refund_quota: reserved_quota,
                additional_quota: 0,
            })
        }
        ActualGroupBillingSmokeAction::SettleSelectedGroup => {
            let Some(preflight) = plan.selected_preflight(selected_group) else {
                let _ =
                    refund_tiered_billing_group_plan(db, auth, &plan, "staging_smoke_cleanup", now)
                        .await;
                return Err(worker::Error::RustError(format!(
                    "actual-group billing smoke snapshot missing for selected group {selected_group}"
                )));
            };
            let selected_group_ratio = preflight.snapshot.group_ratio;
            let selected_group_estimated_quota = preflight.snapshot.estimated_quota_after_group.0;
            bind_tiered_billing_selected_attempt(
                db,
                &preflight,
                channel_id,
                selected_group,
                now,
                RELAY_BILLING_RESERVATION_LEASE_DEFAULT_SECONDS,
            )
            .await?;
            let usage = UsageSummary {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                ..UsageSummary::default()
            };
            let outcome = match tiered_billing_settlement(&preflight, &usage, &request) {
                Ok(outcome) => outcome,
                Err(err) => {
                    let _ = refund_tiered_billing_group_plan(
                        db,
                        auth,
                        &plan,
                        "staging_smoke_cleanup",
                        now,
                    )
                    .await;
                    return Err(worker::Error::RustError(err));
                }
            };
            let reservation_key = preflight.reservation_key.as_deref().ok_or_else(|| {
                worker::Error::RustError("relay billing reservation key is missing".to_string())
            })?;
            require_relay_billing_finalization(
                crate::d1_repositories::settle_relay_billing_reservation(
                    db,
                    reservation_key,
                    channel_id,
                    selected_group,
                    outcome.final_quota,
                    "staging_smoke_settlement",
                    now,
                )
                .await?,
                "staging-smoke settlement",
            )?;
            Ok(ActualGroupBillingSmokeEvidence {
                candidate_group_count,
                reservation_strategy,
                reserved_quota,
                selected_group: Some(selected_group.to_string()),
                selected_group_ratio: Some(selected_group_ratio),
                selected_group_estimated_quota: Some(selected_group_estimated_quota),
                final_quota: outcome.final_quota,
                refund_quota: outcome.result.settlement.refund_quota.0,
                additional_quota: outcome.result.settlement.additional_quota.0,
            })
        }
    }
}

fn tiered_billing_group_plan_from_base(
    base_snapshot: TieredBillingSnapshot,
    groups: &[String],
    group_ratios: &HashMap<String, f64>,
) -> Result<TieredBillingGroupPlan, String> {
    let mut snapshots = HashMap::new();
    let mut reserved_quota = 0i64;
    for group in groups {
        if snapshots.contains_key(group) {
            continue;
        }
        let ratio = group_ratios
            .get(group)
            .copied()
            .ok_or_else(|| format!("missing resolved billing ratio for serving group {group}"))?;
        let snapshot = rebase_tiered_billing_snapshot_group_ratio(&base_snapshot, ratio);
        reserved_quota = reserved_quota.max(snapshot.estimated_quota_after_group.0.max(0));
        snapshots.insert(group.clone(), snapshot);
    }
    if snapshots.is_empty() {
        return Err("tiered billing group plan requires at least one serving group".to_string());
    }
    Ok(TieredBillingGroupPlan {
        snapshots,
        reserved_quota,
        reserve_applied: false,
        reservation_key: None,
    })
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
        selected_group: String::new(),
        candidate_group_count: 1,
        reservation_strategy: TIERED_BILLING_SELECTED_GROUP_STRATEGY,
        reservation_key: None,
        selected_at: None,
        selected_lease_expires_at: None,
    })
}

async fn reserve_tiered_billing_group_plan(
    db: &D1Database,
    auth: &AuthenticatedToken,
    plan: &mut TieredBillingGroupPlan,
    model: &str,
    endpoint_path: &str,
    request_id: Option<&str>,
    lease_seconds: i64,
    now: i64,
) -> worker::Result<()> {
    if plan.reserved_quota == 0 {
        return Ok(());
    }
    let reservation_key = format!(
        "relayreserve-{}",
        random_terminal_audit_event_id().ok_or_else(|| {
            worker::Error::RustError(
                "cryptographic entropy unavailable for relay billing reservation".to_string(),
            )
        })?
    );
    let expr_hash = plan
        .snapshots
        .values()
        .next()
        .map(|snapshot| snapshot.expr_hash.as_str())
        .unwrap_or_default();
    let reservation_strategy = if plan.snapshots.len() > 1 {
        TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY
    } else {
        TIERED_BILLING_SELECTED_GROUP_STRATEGY
    };
    let request_id_hash = request_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("sha256:{:x}", Sha256::digest(value.as_bytes())))
        .unwrap_or_default();
    let outcome = crate::d1_repositories::reserve_relay_billing_quota(
        db,
        crate::d1_repositories::RelayBillingReservationRecord {
            reservation_key: &reservation_key,
            user_id: auth.user_id,
            token_id: auth.token_id,
            model_name: model,
            endpoint_path,
            request_id_hash: &request_id_hash,
            expr_hash,
            candidate_group_count: i64::try_from(plan.snapshots.len()).unwrap_or(i64::MAX),
            reservation_strategy,
            pre_consumed_quota: plan.reserved_quota,
            created_at: now,
            lease_expires_at: now.saturating_add(lease_seconds),
        },
    )
    .await?;
    if outcome != crate::d1_repositories::RelayBillingReservationWriteOutcome::Applied {
        return Err(worker::Error::RustError(
            "relay billing reservation key collision".to_string(),
        ));
    }
    plan.reserve_applied = true;
    plan.reservation_key = Some(reservation_key);
    Ok(())
}

async fn refund_tiered_billing_group_plan(
    db: &D1Database,
    _auth: &AuthenticatedToken,
    plan: &TieredBillingGroupPlan,
    finalization_reason: &str,
    now: i64,
) -> worker::Result<()> {
    if !plan.reserve_applied || plan.reserved_quota == 0 {
        return Ok(());
    }
    let reservation_key = plan.reservation_key.as_deref().ok_or_else(|| {
        worker::Error::RustError("relay billing reservation key is missing".to_string())
    })?;
    require_relay_billing_finalization(
        crate::d1_repositories::refund_relay_billing_reservation(
            db,
            reservation_key,
            finalization_reason,
            crate::d1_repositories::RelayBillingRequestAccounting::Skip,
            now,
        )
        .await?,
        "refund",
    )
}

async fn refund_tiered_billing_preflight(
    db: &D1Database,
    _auth: &AuthenticatedToken,
    preflight: &TieredBillingPreflight,
    finalization_reason: &str,
    request_accounting: crate::d1_repositories::RelayBillingRequestAccounting,
    now: i64,
) -> worker::Result<()> {
    if !preflight.reserve_applied || preflight.pre_consumed_quota == 0 {
        return Ok(());
    }
    let reservation_key = preflight.reservation_key.as_deref().ok_or_else(|| {
        worker::Error::RustError("relay billing reservation key is missing".to_string())
    })?;
    require_relay_billing_finalization(
        crate::d1_repositories::refund_relay_billing_reservation(
            db,
            reservation_key,
            finalization_reason,
            request_accounting,
            now,
        )
        .await?,
        "refund",
    )
}

fn require_relay_billing_finalization(
    outcome: crate::d1_repositories::RelayBillingReservationFinalizationOutcome,
    action: &str,
) -> worker::Result<()> {
    use crate::d1_repositories::RelayBillingReservationFinalizationOutcome as Outcome;
    match outcome {
        Outcome::Applied | Outcome::MatchingSettled | Outcome::MatchingRefund => Ok(()),
        Outcome::SettlementWon => Err(worker::Error::RustError(format!(
            "relay billing settlement already won before {action}"
        ))),
        Outcome::RefundWon => Err(worker::Error::RustError(format!(
            "relay billing refund already won before {action}"
        ))),
        Outcome::Conflict => Err(worker::Error::RustError(format!(
            "relay billing reservation conflicts with {action}"
        ))),
        Outcome::NotFound => Err(worker::Error::RustError(format!(
            "relay billing reservation was not found during {action}"
        ))),
        Outcome::LeaseActive => Err(worker::Error::RustError(format!(
            "relay billing reservation lease is still active during {action}"
        ))),
        Outcome::DeadlineExpired => Err(worker::Error::RustError(format!(
            "relay billing reservation deadline expired before {action}"
        ))),
        Outcome::RecoveryRequired => Err(worker::Error::RustError(format!(
            "relay billing reservation requires reconciliation before {action}"
        ))),
    }
}

async fn bind_tiered_billing_selected_attempt(
    db: &D1Database,
    preflight: &TieredBillingPreflight,
    channel_id: i64,
    selected_group: &str,
    selected_at: i64,
    lease_seconds: i64,
) -> worker::Result<()> {
    use crate::d1_repositories::RelayBillingSelectionOutcome as Outcome;
    let reservation_key = preflight.reservation_key.as_deref().ok_or_else(|| {
        worker::Error::RustError("relay billing reservation key is missing".to_string())
    })?;
    match crate::d1_repositories::bind_relay_billing_selected_attempt(
        db,
        reservation_key,
        channel_id,
        selected_group,
        selected_at,
        selected_at.saturating_add(lease_seconds),
    )
    .await?
    {
        Outcome::Applied | Outcome::MatchingSelection => Ok(()),
        Outcome::AlreadyFinalized => Err(worker::Error::RustError(
            "relay billing reservation was finalized before selected-attempt binding".to_string(),
        )),
        Outcome::Conflict => Err(worker::Error::RustError(
            "relay billing reservation selected-attempt conflict".to_string(),
        )),
        Outcome::NotFound => Err(worker::Error::RustError(
            "relay billing reservation was not found during selected-attempt binding".to_string(),
        )),
    }
}

fn tiered_billing_settlement(
    preflight: &TieredBillingPreflight,
    usage: &UsageSummary,
    request: &RequestInput,
) -> Result<TieredBillingOutcome, String> {
    let params = token_params_from_usage(&preflight.snapshot, usage);
    let mut result =
        compute_tiered_quota_with_request(&preflight.snapshot, params, request.clone())
            .map_err(|err| format!("failed to compute tiered billing: {err}"))?;
    result.settlement = settle(
        Quota(preflight.pre_consumed_quota),
        result.actual_quota_after_group,
    );
    let final_quota = result.settlement.final_quota.0;

    Ok(TieredBillingOutcome {
        final_quota,
        snapshot: preflight.snapshot.clone(),
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
#[allow(clippy::too_many_arguments)]
async fn try_flat_billing(
    db: &D1Database,
    auth: &AuthenticatedToken,
    channel_id: i64,
    channel_type: i32,
    model: &str,
    group: &str,
    endpoint_path: &str,
    request_body: Option<&Value>,
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
        crate::d1_repositories::LEGACY_GROUP_RATIO_OPTION_KEY,
        crate::d1_repositories::GROUP_GROUP_RATIO_OPTION_KEY,
        crate::d1_repositories::LEGACY_GROUP_GROUP_RATIO_OPTION_KEY,
        "CreateCacheRatio",
        "ImageRatio",
        "AudioRatio",
        "AudioCompletionRatio",
    ];
    let values = crate::d1_repositories::option_values(db, &keys)
        .await
        .map_err(|err| format!("failed to load pricing options: {err}"))?;
    let mut config = PricingConfig::new()
        .with_json_maps(
            values[0].as_deref(),
            values[1].as_deref(),
            values[2].as_deref(),
            values[3].as_deref(),
            values[5].as_deref(), // group ratio
            values[4].as_deref(), // quota per unit
        )
        .with_subcategory_maps(
            values[9].as_deref(),  // create cache ratio
            values[10].as_deref(), // image ratio
            values[11].as_deref(), // audio ratio
            values[12].as_deref(), // audio completion ratio
        );
    let effective_ratios = crate::d1_repositories::resolve_effective_group_ratios_from_options(
        &auth.user_group,
        &[group.to_string()],
        values[7].as_deref(),
        values[8].as_deref(),
        values[5].as_deref(),
        values[6].as_deref(),
    )
    .map_err(|err| format!("failed to resolve effective group ratio: {err}"))?;
    config.group_ratios.insert(
        group.to_string(),
        effective_ratios.get(group).copied().unwrap_or(1.0),
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
    let fixed_price_multiplier =
        fixed_price_request_multiplier(endpoint_path, channel_type, request_body);
    let result = compute_flat_quota_with_fixed_price_multiplier(
        &flat_usage,
        model,
        group,
        &config,
        fixed_price_multiplier,
    );
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

fn fixed_price_request_multiplier(
    endpoint_path: &str,
    channel_type: i32,
    request_body: Option<&Value>,
) -> f64 {
    if endpoint_path != "images/generations" {
        return 1.0;
    }
    let Some(body) = request_body else {
        return 1.0;
    };
    let image_count = if channel_type == CHANNEL_TYPE_SILICONFLOW {
        body.get("batch_size")
            .and_then(Value::as_u64)
            .filter(|value| *value != 0)
            .or_else(|| body.get("n").and_then(Value::as_u64))
    } else {
        body.get("n").and_then(Value::as_u64)
    };
    image_count.unwrap_or(1).max(1) as f64
}

fn tiered_billing_metadata(
    preflight: &TieredBillingPreflight,
    snapshot: TieredBillingSnapshot,
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
        "selected_group": preflight.selected_group,
        "candidate_group_count": preflight.candidate_group_count,
        "reservation_strategy": preflight.reservation_strategy,
        "pre_consumed_quota": preflight.pre_consumed_quota,
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
        "selected_group": preflight.selected_group,
        "candidate_group_count": preflight.candidate_group_count,
        "reservation_strategy": preflight.reservation_strategy,
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
        "selected_group": preflight.selected_group,
        "candidate_group_count": preflight.candidate_group_count,
        "reservation_strategy": preflight.reservation_strategy,
        "pre_consumed_quota": preflight.pre_consumed_quota,
        "estimated_tier": preflight.snapshot.estimated_tier,
        "estimated_quota_after_group": preflight.snapshot.estimated_quota_after_group.0,
        "reason": reason,
    })
}

pub(crate) fn relay_billing_missing_usage_estimate_enabled(env: &Env) -> bool {
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

fn validate_chat_completions_request(body: &Value) -> Option<&'static str> {
    let Some(request) = body.as_object() else {
        return Some("chat completions request body must be a JSON object");
    };
    if !request
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.trim().is_empty())
    {
        return Some("field model is required");
    }

    match request.get("messages") {
        Some(Value::Array(messages)) if !messages.is_empty() => {
            if messages.iter().any(|message| !message.is_object()) {
                return Some("field messages must contain JSON objects");
            }
            for message in messages.iter().filter_map(Value::as_object) {
                for field in [
                    "role",
                    "name",
                    "reasoning_content",
                    "reasoning",
                    "tool_call_id",
                ] {
                    if message
                        .get(field)
                        .is_some_and(|value| !value.is_null() && !value.is_string())
                    {
                        return Some("chat message string field has an invalid type");
                    }
                }
                if message
                    .get("prefix")
                    .is_some_and(|value| !value.is_null() && !value.is_boolean())
                {
                    return Some("chat message prefix must be a boolean");
                }
            }
        }
        Some(Value::Array(_)) | None
            if !request.get("prefix").is_some_and(|value| !value.is_null())
                && !request.get("suffix").is_some_and(|value| !value.is_null()) =>
        {
            return Some("field messages is required");
        }
        Some(Value::Array(_)) | None => {}
        Some(_) => return Some("field messages must be an array"),
    }

    for field in ["stream", "return_images", "return_related_questions"] {
        if request
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_boolean())
        {
            return Some("chat completions boolean field has an invalid type");
        }
    }
    for field in [
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
    ] {
        if request
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_number())
        {
            return Some("chat completions numeric field has an invalid type");
        }
    }
    for field in ["max_tokens", "max_completion_tokens"] {
        if request
            .get(field)
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return Some("chat completion token limit must be a non-negative integer");
        }
    }
    if request
        .get("max_tokens")
        .and_then(Value::as_u64)
        .is_some_and(|value| value > (i32::MAX as u64) / 2)
    {
        return Some("max_tokens is invalid");
    }

    if let Some(tools) = request.get("tools").filter(|value| !value.is_null()) {
        let Some(tools) = tools.as_array() else {
            return Some("field tools must be an array");
        };
        if tools.iter().any(|tool| !tool.is_object()) {
            return Some("field tools must contain JSON objects");
        }
        for tool in tools.iter().filter_map(Value::as_object) {
            for field in ["id", "type"] {
                if tool
                    .get(field)
                    .is_some_and(|value| !value.is_null() && !value.is_string())
                {
                    return Some("chat tool string field has an invalid type");
                }
            }
            if let Some(function) = tool.get("function").filter(|value| !value.is_null()) {
                let Some(function) = function.as_object() else {
                    return Some("chat tool function must be a JSON object");
                };
                for field in ["description", "name", "arguments"] {
                    if function
                        .get(field)
                        .is_some_and(|value| !value.is_null() && !value.is_string())
                    {
                        return Some("chat tool function string field has an invalid type");
                    }
                }
            }
        }
    }

    None
}

fn apply_endpoint_request_transform(
    body: &mut Value,
    endpoint_path: &str,
    channel: &RelayChannel,
) -> worker::Result<()> {
    if channel.channel_type == CHANNEL_TYPE_ALI {
        apply_ali_request(body, endpoint_path);
    }
    if endpoint_path == "rerank" && channel.channel_type == CHANNEL_TYPE_COHERE {
        apply_cohere_rerank_request_transform(body);
    }
    if channel.channel_type == CHANNEL_TYPE_JINA {
        apply_jina_request(body, endpoint_path);
    }
    if endpoint_path == "chat/completions" && channel.channel_type == CHANNEL_TYPE_MISTRAL {
        apply_mistral_chat_request(body, random_mistral_tool_call_id).map_err(|error| {
            worker::Error::RustError(format!("Mistral request transform failed: {error}"))
        })?;
    }
    if endpoint_path == "chat/completions" && channel.channel_type == CHANNEL_TYPE_PERPLEXITY {
        apply_perplexity_chat_request(body);
    }
    if channel.channel_type == CHANNEL_TYPE_SILICONFLOW {
        apply_siliconflow_request(body, endpoint_path);
    }
    if channel.channel_type == CHANNEL_TYPE_XAI {
        apply_xai_request(body, endpoint_path);
    }
    if channel.channel_type == CHANNEL_TYPE_ZHIPU_V4 {
        apply_zhipu_v4_request(body, endpoint_path);
    }
    if channel.channel_type == CHANNEL_TYPE_BAIDU_V2 {
        apply_baidu_v2_request(body);
    }
    if channel.channel_type == CHANNEL_TYPE_TENCENT {
        apply_tencent_chat_request(body).map_err(|reason| {
            worker::Error::RustError(format!("Tencent request transform failed: {reason}"))
        })?;
    }
    if channel.channel_type == CHANNEL_TYPE_VOLCENGINE {
        apply_volcengine_request(body);
    }
    Ok(())
}

fn apply_provider_request_transform(body: &mut Value, provider: RelayProviderKind) {
    match provider {
        RelayProviderKind::DeepSeekOpenAi => {
            apply_deepseek_request(body, DeepSeekRequestFormat::OpenAi)
        }
        RelayProviderKind::DeepSeekMessages => {
            apply_deepseek_request(body, DeepSeekRequestFormat::AnthropicMessages)
        }
        RelayProviderKind::MoonshotOpenAi => {
            apply_moonshot_request(body, MoonshotRequestFormat::OpenAi)
        }
        RelayProviderKind::MoonshotMessages => {
            apply_moonshot_request(body, MoonshotRequestFormat::AnthropicMessages)
        }
        RelayProviderKind::AliOpenAi
        | RelayProviderKind::AliMessages
        | RelayProviderKind::BaiduV2OpenAi
        | RelayProviderKind::OpenAiCompatible
        | RelayProviderKind::AnthropicMessages
        | RelayProviderKind::MistralOpenAi
        | RelayProviderKind::PerplexityOpenAi
        | RelayProviderKind::SiliconFlowOpenAi
        | RelayProviderKind::SubmodelOpenAi
        | RelayProviderKind::TencentHunyuan
        | RelayProviderKind::XaiOpenAi
        | RelayProviderKind::VolcEngineOpenAi
        | RelayProviderKind::GeminiNative => {}
    }
}

fn provider_uses_openai_stream_options(provider: RelayProviderKind) -> bool {
    matches!(
        provider,
        RelayProviderKind::AliOpenAi
            | RelayProviderKind::BaiduV2OpenAi
            | RelayProviderKind::OpenAiCompatible
            | RelayProviderKind::DeepSeekOpenAi
            | RelayProviderKind::MoonshotOpenAi
            | RelayProviderKind::SubmodelOpenAi
            | RelayProviderKind::XaiOpenAi
            | RelayProviderKind::VolcEngineOpenAi
    )
}

fn random_mistral_tool_call_id() -> Option<String> {
    const ALPHABET: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const UNBIASED_BYTE_LIMIT: u8 = 248;
    const ID_LEN: usize = 9;

    let mut output = String::with_capacity(ID_LEN);
    let mut entropy = [0_u8; 16];
    while output.len() < ID_LEN {
        getrandom::getrandom(&mut entropy).ok()?;
        for byte in entropy {
            if byte >= UNBIASED_BYTE_LIMIT {
                continue;
            }
            output.push(ALPHABET[usize::from(byte % 62)] as char);
            if output.len() == ID_LEN {
                break;
            }
        }
    }
    Some(output)
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

fn realtime_billing_request_input(req: &Request, body: &Value) -> RequestInput {
    RequestInput {
        headers: safe_realtime_billing_headers(req),
        body: Some(body.clone()),
    }
}

fn safe_realtime_billing_headers(req: &Request) -> HashMap<String, String> {
    safe_realtime_billing_headers_from_entries(req.headers().entries())
}

fn safe_realtime_billing_headers_from_entries(
    entries: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for (name, value) in entries {
        if headers.len() >= REALTIME_BILLING_REQUEST_MAX_HEADERS {
            break;
        }
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() || is_sensitive_billing_probe_header(&name) {
            continue;
        }
        let value = truncate_realtime_billing_header_value(&value);
        if !value.is_empty() {
            headers.insert(name, value);
        }
    }
    headers
}

fn is_sensitive_billing_probe_header(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "cookie"
            | "proxy-authorization"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "x-goog-api-key"
            | "cf-access-token"
            | "cf-authorization"
    ) || name.contains("token")
        || name.contains("secret")
        || name.contains("credential")
        || name.ends_with("-key")
}

fn truncate_realtime_billing_header_value(value: &str) -> String {
    value
        .trim()
        .chars()
        .take(REALTIME_BILLING_REQUEST_MAX_HEADER_VALUE_CHARS)
        .collect()
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
    use cinatoken_billing::compute_flat_quota;
    use serde_json::json;

    #[test]
    fn admin_probe_endpoint_mapping_is_strict_and_complete() {
        let cases = [
            ("auto", AdminProbeEndpoint::Auto, None),
            (
                "openai",
                AdminProbeEndpoint::OpenAi,
                Some("/v1/chat/completions"),
            ),
            (
                "openai-completions",
                AdminProbeEndpoint::OpenAiCompletions,
                Some("/v1/completions"),
            ),
            (
                "openai-response",
                AdminProbeEndpoint::OpenAiResponse,
                Some("/v1/responses"),
            ),
            (
                "openai-response-compact",
                AdminProbeEndpoint::OpenAiResponseCompact,
                Some("/v1/responses/compact"),
            ),
            (
                "anthropic",
                AdminProbeEndpoint::Anthropic,
                Some("/v1/messages"),
            ),
            (
                "gemini",
                AdminProbeEndpoint::Gemini,
                Some("/v1beta/models/*"),
            ),
            (
                "jina-rerank",
                AdminProbeEndpoint::JinaRerank,
                Some("/v1/rerank"),
            ),
            (
                "image-generation",
                AdminProbeEndpoint::ImageGeneration,
                Some("/v1/images/generations"),
            ),
            (
                "embeddings",
                AdminProbeEndpoint::Embeddings,
                Some("/v1/embeddings"),
            ),
        ];
        for (raw, endpoint, route) in cases {
            assert_eq!(AdminProbeEndpoint::parse(raw), Some(endpoint));
            assert_eq!(endpoint.as_str(), raw);
            assert_eq!(endpoint.route().map(ProviderRelayRoute::path), route);
        }
        for invalid in ["", "OPENAI", "chat", "openai-responses", "unknown"] {
            assert_eq!(AdminProbeEndpoint::parse(invalid), None);
        }
    }

    #[test]
    fn admin_probe_auto_preserves_model_sensitive_go_rules() {
        assert_eq!(
            resolve_admin_probe_endpoint(
                1,
                AdminProbeEndpoint::Auto,
                "gpt-4.1-openai-compact",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::OpenAiResponseCompact
        );
        assert_eq!(
            resolve_admin_probe_endpoint(1, AdminProbeEndpoint::Auto, "gpt-5-codex", false)
                .unwrap(),
            AdminProbeEndpoint::OpenAiResponse
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                38,
                AdminProbeEndpoint::Auto,
                "jina-reranker-v2-base-multilingual",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::JinaRerank
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                38,
                AdminProbeEndpoint::Auto,
                "jina-embeddings-v4",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::Embeddings
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                1,
                AdminProbeEndpoint::Auto,
                "text-embedding-3-small",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::Embeddings
        );
        assert_eq!(
            model_sensitive_admin_probe_endpoint(45, "doubao-seedream-4-0"),
            AdminProbeEndpoint::ImageGeneration
        );
        assert_eq!(
            model_sensitive_admin_probe_endpoint(44, "moka-model"),
            AdminProbeEndpoint::Embeddings
        );
    }

    #[test]
    fn admin_probe_auto_falls_back_only_to_supported_safe_routes() {
        assert_eq!(
            resolve_admin_probe_endpoint(14, AdminProbeEndpoint::Auto, "claude-3-haiku", false)
                .unwrap(),
            AdminProbeEndpoint::Anthropic
        );
        assert_eq!(
            resolve_admin_probe_endpoint(24, AdminProbeEndpoint::Auto, "gemini-2.5-flash", false)
                .unwrap(),
            AdminProbeEndpoint::Gemini
        );
        let deferred = resolve_admin_probe_endpoint(
            CHANNEL_TYPE_CODEX,
            AdminProbeEndpoint::Auto,
            "gpt-5-codex",
            false,
        )
        .unwrap_err();
        assert_eq!(deferred.error_code, "channel_test_auto_route_unsupported");
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_VOLCENGINE,
                AdminProbeEndpoint::Auto,
                "doubao-seedream-4-0",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::ImageGeneration
        );
    }

    #[test]
    fn admin_probe_rejects_unsupported_routes_and_incompatible_streams() {
        let unsupported =
            resolve_admin_probe_endpoint(14, AdminProbeEndpoint::OpenAi, "claude-3-haiku", false)
                .unwrap_err();
        assert_eq!(unsupported.status, 400);
        assert_eq!(unsupported.error_code, "channel_test_route_unsupported");

        for endpoint in [
            AdminProbeEndpoint::OpenAiResponseCompact,
            AdminProbeEndpoint::JinaRerank,
            AdminProbeEndpoint::ImageGeneration,
            AdminProbeEndpoint::Embeddings,
        ] {
            let error = resolve_admin_probe_endpoint(1, endpoint, "model", true).unwrap_err();
            assert_eq!(error.status, 400);
            assert_eq!(error.error_code, "channel_test_stream_incompatible");
        }
        let auto_rerank = resolve_admin_probe_endpoint(
            38,
            AdminProbeEndpoint::Auto,
            "jina-reranker-v2-base-multilingual",
            true,
        )
        .unwrap_err();
        assert_eq!(auto_rerank.error_code, "channel_test_stream_incompatible");
    }

    #[test]
    fn admin_probe_minimal_bodies_match_route_contracts() {
        let embeddings = build_admin_probe_body(
            AdminProbeEndpoint::Embeddings,
            "text-embedding-3-small",
            false,
        );
        assert_eq!(embeddings["input"], json!(["hi"]));
        let image = build_admin_probe_body(
            AdminProbeEndpoint::ImageGeneration,
            "doubao-seedream-4-0",
            false,
        );
        assert_eq!(image["prompt"], "a common cat");
        assert_eq!(image["size"], "1024x1024");
        let rerank = build_admin_probe_body(
            AdminProbeEndpoint::JinaRerank,
            "jina-reranker-v2-base-multilingual",
            false,
        );
        assert_eq!(rerank["documents"].as_array().unwrap().len(), 2);
        assert_eq!(rerank["top_n"], 2);
        let responses =
            build_admin_probe_body(AdminProbeEndpoint::OpenAiResponse, "gpt-4.1", false);
        assert_eq!(responses["input"][0]["role"], "user");
        let chat = build_admin_probe_body(AdminProbeEndpoint::OpenAi, "gpt-4.1", false);
        assert_eq!(chat["max_tokens"], 16);
        let completions =
            build_admin_probe_body(AdminProbeEndpoint::OpenAiCompletions, "qwen-coder", false);
        assert_eq!(completions["prompt"], "hi");
        let gemini = build_admin_probe_body(AdminProbeEndpoint::Gemini, "gemini-2.5-flash", false);
        assert_eq!(gemini["generationConfig"]["maxOutputTokens"], 3000);
    }

    #[test]
    fn admin_probe_json_shape_validation_is_route_specific() {
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::OpenAi,
            &json!({"choices": [{"message": {"content": "hi"}}]})
        ));
        assert!(!admin_probe_json_shape_valid(
            AdminProbeEndpoint::OpenAi,
            &json!({"choices": []})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::OpenAiCompletions,
            &json!({"choices": [{"text": "hi"}]})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::OpenAiResponse,
            &json!({"object": "response", "output": []})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::Anthropic,
            &json!({"type": "message", "content": [{"type": "text", "text": "hi"}]})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::Gemini,
            &json!({"candidates": [{"content": {"parts": [{"text": "hi"}]}}]})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::JinaRerank,
            &json!({"results": [{"index": 0, "relevance_score": 1.0}]})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::ImageGeneration,
            &json!({"images": [{"url": "https://example.test/cat.png"}]})
        ));
        assert!(admin_probe_json_shape_valid(
            AdminProbeEndpoint::Embeddings,
            &json!({"data": [{"embedding": [0.1, 0.2]}]})
        ));
        assert!(!admin_probe_json_shape_valid(
            AdminProbeEndpoint::Embeddings,
            &json!({"data": [{"index": 0}]})
        ));
    }

    #[test]
    fn admin_probe_sse_parser_requires_route_specific_non_done_json_event() {
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"event: response.created\r\ndata: {\"type\":\"response.created\"}\r\n\r\n",
                false,
            ),
            Ok(true)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"data: [DONE]\n\n",
                true,
            ),
            Ok(false)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"data: not-json\n\n",
                true,
            ),
            Ok(false)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"data: {\"type\":\"response.created\"}",
                false,
            ),
            Ok(false)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"data: {\"type\":\"response.created\"}",
                true,
            ),
            Ok(true)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAi,
                b"data: {\"type\":\"response.created\"}\n\n",
                true,
            ),
            Ok(false)
        );
        assert_eq!(
            admin_probe_sse_has_valid_event(
                AdminProbeEndpoint::OpenAiResponse,
                b"data: {\"type\":\"response.failed\"}\n\n",
                true,
            ),
            Ok(false)
        );
    }

    #[test]
    fn admin_probe_preparation_reuses_first_key_and_model_mapping() {
        let mut channel = test_channel(1, 0, 1);
        channel.key = " first-key\nsecond-key ".to_string();
        channel.model_mapping = Some(r#"{"gpt-test":"provider-model"}"#.to_string());
        let request = AdminChannelProbeRequest {
            model: "gpt-test".to_string(),
            endpoint_type: AdminProbeEndpoint::OpenAi,
            stream: false,
        };
        let prepared = prepare_admin_channel_probe(&channel, &request, false, None).unwrap();
        assert_eq!(prepared.upstream_key, "first-key");
        assert_eq!(prepared.body["model"], "provider-model");
        assert_eq!(prepared.effective_model, "provider-model");
        assert_eq!(prepared.effective_route, "/v1/chat/completions");
    }

    #[test]
    fn admin_probe_transport_planning_reuses_production_transports() {
        let endpoint = AdminProbeEndpoint::OpenAi.relay_endpoint("gpt-4.1", false);
        let direct = test_channel(1, 0, 1);
        let direct_url = endpoint.try_upstream_url(&direct).unwrap();
        assert!(matches!(
            plan_admin_probe_transport(None, &endpoint, &direct, &direct_url, "gpt-4.1", false,)
                .unwrap(),
            AdminProbeTransportPlan::Direct
        ));

        let mut workers_ai = test_channel(39, 0, 1);
        workers_ai.channel_type = 39;
        workers_ai.key = "internal".to_string();
        let workers_ai_url = endpoint.try_upstream_url(&workers_ai).unwrap();
        assert!(matches!(
            plan_admin_probe_transport(
                None,
                &endpoint,
                &workers_ai,
                &workers_ai_url,
                "@cf/meta/llama-3.1-8b-instruct",
                false,
            )
            .unwrap(),
            AdminProbeTransportPlan::WorkersAi
        ));

        let mut wfp = test_channel(2, 0, 1);
        wfp.other_info = r#"{"wfp_worker":"tenant-a"}"#.to_string();
        let wfp_url = endpoint.try_upstream_url(&wfp).unwrap();
        assert!(matches!(
            plan_admin_probe_transport(None, &endpoint, &wfp, &wfp_url, "gpt-4.1", false,).unwrap(),
            AdminProbeTransportPlan::Wfp
        ));

        let runtime = ai_gateway_runtime_for_tests();
        let mut gateway = test_channel(3, 0, 1);
        gateway.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        let gateway_url = endpoint.try_upstream_url(&gateway).unwrap();
        assert!(matches!(
            plan_admin_probe_transport(
                Some(&runtime),
                &endpoint,
                &gateway,
                &gateway_url,
                "openai/gpt-4.1",
                false,
            )
            .unwrap(),
            AdminProbeTransportPlan::AiGateway(_)
        ));
    }

    #[test]
    fn realtime_billing_request_headers_strip_sensitive_values() {
        let headers = safe_realtime_billing_headers_from_entries([
            (
                "Authorization".to_string(),
                "Bearer relay-secret".to_string(),
            ),
            ("Cookie".to_string(), "session=secret".to_string()),
            ("X-API-Key".to_string(), "key-secret".to_string()),
            ("X-Request-Tier".to_string(), "fast".to_string()),
            (
                "X-Long-Probe".to_string(),
                "x".repeat(REALTIME_BILLING_REQUEST_MAX_HEADER_VALUE_CHARS + 8),
            ),
        ]);

        assert_eq!(
            headers.get("x-request-tier").map(String::as_str),
            Some("fast")
        );
        assert_eq!(
            headers
                .get("x-long-probe")
                .map(|value| value.chars().count()),
            Some(REALTIME_BILLING_REQUEST_MAX_HEADER_VALUE_CHARS)
        );
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("cookie"));
        assert!(!headers.contains_key("x-api-key"));
    }

    #[test]
    fn realtime_response_snapshot_estimates_each_response_create_body() {
        let template = estimate_tiered_billing_snapshot_with_request(
            "gpt-4o-realtime-preview",
            r#"tier("base", p * 2 + c * 10)|||(param("service_tier") == "fast" ? 2 : 1)"#,
            TokenParams::default(),
            1.0,
            RequestInput::default(),
        )
        .expect("template snapshot");
        let request = RequestInput::from_json_body(json!({
            "model": "gpt-4o-realtime-preview",
            "endpoint": "realtime",
            "service_tier": "fast",
            "instructions": "Answer briefly but include the important operational details.",
            "max_output_tokens": 256
        }));
        let snapshot =
            realtime_billing_response_snapshot(&template, request).expect("response snapshot");

        assert!(snapshot.estimated_prompt_tokens > 0);
        assert_eq!(snapshot.estimated_completion_tokens, 256);
        assert_eq!(snapshot.estimated_tier, "base");
        assert!(snapshot.estimated_quota_after_group.0 > 0);
    }

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
    fn realtime_mock_queue_probe_delay_requires_explicit_mock_object() {
        assert_eq!(realtime_mock_queue_probe_delay_ms("{}"), None);
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(r#"{"realtime_mock_upstream":true}"#),
            None
        );
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"queue_probe_delay_ms":250}}"#
            ),
            Some(250)
        );
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"startup_queue_probe_delay_ms":500}}"#
            ),
            Some(500)
        );
    }

    #[test]
    fn realtime_mock_queue_probe_delay_clamps_to_safe_bounds() {
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"queue_probe_delay_ms":0}}"#
            ),
            None
        );
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"queue_probe_delay_ms":1001}}"#
            ),
            None
        );
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"queue_probe_delay_ms":"250"}}"#
            ),
            None
        );
        assert_eq!(
            realtime_mock_queue_probe_delay_ms(
                r#"{"realtime_mock_upstream":{"queue_probe_delay_ms":1000}}"#
            ),
            Some(1000)
        );
    }

    #[test]
    fn realtime_mock_upstream_fault_requires_explicit_allowed_value() {
        assert_eq!(realtime_mock_upstream_fault("{}"), None);
        assert_eq!(
            realtime_mock_upstream_fault(r#"{"realtime_mock_upstream":true}"#),
            None
        );
        assert_eq!(
            realtime_mock_upstream_fault(
                r#"{"realtime_mock_upstream":{"fault":"event_stream_failed"}}"#
            ),
            Some(crate::realtime_session::RealtimeMockUpstreamFault::EventStreamFailed)
        );
        assert_eq!(
            realtime_mock_upstream_fault(r#"{"realtime_mock_upstream":{"fault":"accept_failed"}}"#),
            Some(crate::realtime_session::RealtimeMockUpstreamFault::AcceptFailed)
        );
        assert_eq!(
            realtime_mock_upstream_fault(
                r#"{"realtime_mock_upstream":{"fault":"runtime_detached"}}"#
            ),
            Some(crate::realtime_session::RealtimeMockUpstreamFault::RuntimeDetached)
        );
        assert_eq!(
            realtime_mock_upstream_fault(
                r#"{"realtime_mock_upstream":{"fault":"upstream_error"}}"#
            ),
            None
        );
        assert_eq!(
            realtime_mock_upstream_fault(r#"{"realtime_mock_upstream":{"fault":1}}"#),
            None
        );
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
            cross_group_retry: 0,
            username: "user".to_string(),
            user_status: 1,
            user_quota: 100,
            user_group: "default".to_string(),
        }
    }

    #[test]
    fn relay_token_rate_limit_key_scopes_playground_by_user() {
        assert_eq!(
            relay_token_rate_limit_key(&test_auth(42, 7), "route:chat"),
            "token:42:family:route:chat"
        );
        assert_eq!(
            relay_token_rate_limit_key(&test_auth(0, 7), "route:responses"),
            "playground-user:7:family:route:responses"
        );
    }

    #[test]
    fn relay_ip_rate_limit_key_hashes_personal_data_and_scopes_route() {
        let key = relay_ip_rate_limit_key("203.0.113.9", "route:chat");
        assert!(key.starts_with("ip-sha256:"));
        assert!(key.ends_with(":family:route:chat"));
        assert!(!key.contains("203.0.113.9"));
    }

    fn endpoint(supports_streaming: bool, feature: Option<&'static str>) -> RelayEndpoint {
        RelayEndpoint {
            display_name: "test",
            route: ProviderRelayRoute::ChatCompletions,
            upstream_path: "test".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::AnthropicMessages,
            upstream_path: "messages".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::AnthropicMessages,
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
            route: ProviderRelayRoute::Completions,
            upstream_path: "completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::Responses,
            upstream_path: "responses".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
            route: ProviderRelayRoute::ImageGenerations,
            upstream_path: "images/generations".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
                other: String::new(),
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
            route: ProviderRelayRoute::AudioSpeech,
            upstream_path: "audio/speech".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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
                other: String::new(),
                other_info: String::new(),
                priority: 0,
                weight: 0,
            }),
            "https://api.openai.com/v1/audio/speech"
        );
    }

    #[test]
    fn chat_completions_request_validation_matches_go_typed_request_boundary() {
        assert_eq!(
            validate_chat_completions_request(&json!({
                "model": "mistral-large-latest",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": true,
                "temperature": 0.5,
                "top_p": 1,
                "max_tokens": 64,
                "tools": [{
                    "type": "function",
                    "function": {"name": "lookup", "parameters": {"type": "object"}}
                }]
            })),
            None
        );
        assert_eq!(
            validate_chat_completions_request(&json!({
                "model": "deepseek-chat",
                "prefix": "fn main() {",
                "suffix": "}"
            })),
            None
        );

        for invalid in [
            json!({"model": "m", "messages": []}),
            json!({"model": "m", "messages": ["invalid"]}),
            json!({"model": "m", "messages": [{}], "max_tokens": 1.5}),
            json!({"model": "m", "messages": [{}], "temperature": "0.5"}),
            json!({"model": "m", "messages": [{}], "frequency_penalty": "0.5"}),
            json!({"model": "m", "messages": [{}], "return_images": "yes"}),
            json!({"model": "m", "messages": [{}], "tools": "invalid"}),
            json!({"model": "m", "messages": [{}], "tools": [{"type": 1}]}),
        ] {
            assert!(
                validate_chat_completions_request(&invalid).is_some(),
                "invalid request was accepted: {invalid}"
            );
        }
    }

    #[test]
    fn rerank_endpoint_uses_rerank_channel_family() {
        let endpoint = RelayEndpoint {
            display_name: "rerank",
            route: ProviderRelayRoute::Rerank,
            upstream_path: "rerank".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
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

        assert_eq!(endpoint.route, ProviderRelayRoute::Rerank);
        assert_eq!(endpoint.route.cache_family(), "route:rerank");
        assert_eq!(
            channel_types_for_relay_route(endpoint.route),
            vec![17, 25, 34, 38, 40]
        );
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
                other: String::new(),
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
                other: String::new(),
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
            other: String::new(),
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

        apply_endpoint_request_transform(&mut body, "rerank", &channel).unwrap();

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
            other: String::new(),
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

        apply_endpoint_request_transform(&mut body, "rerank", &channel).unwrap();

        assert_eq!(body, original);
    }

    #[test]
    fn jina_embeddings_use_explicit_route_and_remove_openai_encoding_format() {
        let endpoint = RelayEndpoint {
            display_name: "embeddings",
            route: ProviderRelayRoute::Embeddings,
            upstream_path: "embeddings".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supports_streaming: false,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        };
        let channel = RelayChannel {
            id: 38,
            name: "jina".to_string(),
            channel_type: CHANNEL_TYPE_JINA,
            key: "jina-test".to_string(),
            base_url: None,
            models: "jina-embeddings-v4".to_string(),
            channel_group: "default".to_string(),
            model_mapping: None,
            openai_organization: None,
            other: String::new(),
            other_info: String::new(),
            priority: 0,
            weight: 0,
        };
        let mut body = json!({
            "model": "jina-embeddings-v4",
            "input": ["hello"],
            "encoding_format": "base64",
            "dimensions": 512,
            "task": "retrieval.query",
            "normalized": true
        });

        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_JINA,
            ProviderRelayRoute::Embeddings
        ));
        assert_eq!(
            endpoint.upstream_url(&channel),
            "https://api.jina.ai/v1/embeddings"
        );
        apply_endpoint_request_transform(&mut body, "embeddings", &channel).unwrap();

        assert!(body.get("encoding_format").is_none());
        assert_eq!(body["input"], json!(["hello"]));
        assert_eq!(body["dimensions"], 512);
        assert_eq!(body["task"], "retrieval.query");
        assert_eq!(body["normalized"], true);
    }

    #[test]
    fn non_jina_embeddings_preserve_openai_encoding_format() {
        let channel = RelayChannel {
            id: 1,
            name: "openai".to_string(),
            channel_type: 1,
            key: "openai-test".to_string(),
            base_url: None,
            models: "text-embedding-3-small".to_string(),
            channel_group: "default".to_string(),
            model_mapping: None,
            openai_organization: None,
            other: String::new(),
            other_info: String::new(),
            priority: 0,
            weight: 0,
        };
        let mut body = json!({
            "model": "text-embedding-3-small",
            "input": "hello",
            "encoding_format": "base64"
        });

        apply_endpoint_request_transform(&mut body, "embeddings", &channel).unwrap();

        assert_eq!(body["encoding_format"], "base64");
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
            route: ProviderRelayRoute::GeminiNative,
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
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
            route: ProviderRelayRoute::GeminiNative,
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
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
            route: ProviderRelayRoute::GeminiNative,
            upstream_path: route.upstream_path(),
            upstream_query: None,
            gemini_route: Some(route),
            provider: RelayProviderKind::GeminiNative,
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
            route: ProviderRelayRoute::GeminiNative,
            upstream_path: "v1beta/models/gemini-test:generateContent".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::GeminiNative,
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
    fn rate_limit_runtime_config_selects_native_without_legacy_limits() {
        let config =
            RelayRateLimitRuntimeConfig::from_raw(Some("native".to_string()), None, None, None)
                .unwrap();
        assert_eq!(config.backend, RelayRateLimitBackend::Native);
        assert!(!config.legacy.enabled());
    }

    #[test]
    fn rate_limit_runtime_config_preserves_legacy_auto_detection() {
        let config = RelayRateLimitRuntimeConfig::from_raw(
            None,
            Some("120".to_string()),
            None,
            Some("60".to_string()),
        )
        .unwrap();
        assert_eq!(config.backend, RelayRateLimitBackend::Upstash);
        assert!(config.legacy.enabled());
    }

    #[test]
    fn rate_limit_runtime_config_rejects_unconfigured_upstash() {
        let error =
            RelayRateLimitRuntimeConfig::from_raw(Some("upstash".to_string()), None, None, None)
                .unwrap_err();
        assert!(error.contains(TOKEN_RATE_LIMIT_ENV));
    }

    #[test]
    fn rate_limit_runtime_config_rejects_unknown_backend() {
        let error =
            RelayRateLimitRuntimeConfig::from_raw(Some("external".to_string()), None, None, None)
                .unwrap_err();
        assert!(error.contains(RATE_LIMIT_BACKEND_ENV));
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
    fn relay_billing_stream_heartbeat_is_bounded_by_the_effective_lease() {
        assert_eq!(
            relay_billing_stream_lease_heartbeat_runtime_status_from_raw(300, None),
            RelayBillingStreamLeaseHeartbeatRuntimeStatus {
                configured: false,
                valid: true,
                effective_seconds: 100,
            }
        );
        assert_eq!(
            relay_billing_stream_lease_heartbeat_runtime_status_from_raw(300, Some("5")),
            RelayBillingStreamLeaseHeartbeatRuntimeStatus {
                configured: true,
                valid: true,
                effective_seconds: 5,
            }
        );
        assert_eq!(
            relay_billing_stream_lease_heartbeat_runtime_status_from_raw(300, Some("4")),
            RelayBillingStreamLeaseHeartbeatRuntimeStatus {
                configured: true,
                valid: false,
                effective_seconds: 100,
            }
        );
        assert_eq!(
            relay_billing_stream_lease_heartbeat_seconds_from_raw(3_600, None),
            900
        );
        assert_eq!(
            relay_billing_stream_lease_heartbeat_seconds_from_raw(300, None),
            100
        );
        assert_eq!(
            relay_billing_stream_lease_heartbeat_seconds_from_raw(300, Some("5")),
            5
        );
        for invalid in ["0", "4", "101", "soon"] {
            assert_eq!(
                relay_billing_stream_lease_heartbeat_seconds_from_raw(300, Some(invalid)),
                100
            );
        }
        let jittered =
            relay_billing_stream_lease_heartbeat_interval_seconds(900, "relayreserve-jitter-test");
        assert_eq!(
            jittered,
            relay_billing_stream_lease_heartbeat_interval_seconds(900, "relayreserve-jitter-test")
        );
        assert!((810..=990).contains(&jittered));
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
        let fetch = RelayAttemptFailure::with_detail(
            RelayAttemptFailureKind::FetchError,
            7,
            "alpha".to_string(),
            "tcp reset".to_string(),
            true,
        );
        assert_eq!(fetch.kind, RelayAttemptFailureKind::FetchError);
        assert_eq!(fetch.channel_id, 7);
        assert!(fetch.ai_gateway_opted_in);

        let configuration = RelayAttemptFailure::configuration_error(
            8,
            "configured".to_string(),
            "invalid URL".to_string(),
            true,
        );
        assert_eq!(
            configuration.kind,
            RelayAttemptFailureKind::ConfigurationError
        );

        let no_key = RelayAttemptFailure::no_key(9, "beta".to_string(), false);
        assert_eq!(no_key.kind, RelayAttemptFailureKind::NoUsableKey);

        let status = RelayAttemptFailure::retryable_status(11, "gamma".to_string(), 500, true);
        assert_eq!(status.kind, RelayAttemptFailureKind::RetryableStatus);
        assert_eq!(status.status, Some(500));
    }

    #[test]
    fn terminal_relay_attempt_audit_is_error_typed_bounded_and_secret_free() {
        assert!(relay_terminal_attempt_audit_contract_compiled());
        let auth = test_auth(42, 7);
        let failure = RelayAttemptFailure::with_detail(
            RelayAttemptFailureKind::FetchError,
            9,
            "private-channel-name".to_string(),
            "fetch https://provider.example/?api_key=secret-value failed".to_string(),
            true,
        );
        let mut attempts = RelayAttemptAuditLedger::default();
        attempts.push(RelayAttemptAudit::from_failure(
            "primary",
            "openai/gpt-4.1",
            "default",
            &failure,
        ));
        let event = terminal_relay_failure_event(
            110,
            100,
            &auth,
            "openai/gpt-4.1",
            "default",
            "chat/completions",
            Some("203.0.113.8"),
            Some("req_terminal"),
            false,
            &RelayModelRouteAudit::primary("openai/gpt-4.1", Some("anthropic/claude-sonnet-4")),
            &attempts,
            Some(&failure),
            Some("00112233445566778899aabbccddeeff"),
            "refunded",
        );
        let other: Value = serde_json::from_str(&event.other).unwrap();

        assert_eq!(event.log_type, LOG_TYPE_ERROR);
        assert_eq!(event.quota, 0);
        assert_eq!(event.prompt_tokens, 0);
        assert_eq!(event.completion_tokens, 0);
        assert_eq!(event.channel_id, 9);
        assert_eq!(event.request_id, "req_terminal");
        assert_eq!(other["error_code"], "relay_attempts_exhausted");
        assert_eq!(
            other["terminal_audit_event_id"],
            "00112233445566778899aabbccddeeff"
        );
        assert_eq!(other["admin_info"]["attempt_count"], 1);
        assert_eq!(
            other["admin_info"]["relay_attempts"][0]["outcome"],
            "fetch_error"
        );
        assert_eq!(other["admin_info"]["reserve_refund"], "refunded");
        assert!(!event.other.contains("secret-value"));
        assert!(!event.other.contains("private-channel-name"));
    }

    #[test]
    fn relay_attempt_audit_ledger_caps_entries_without_losing_total() {
        let mut ledger = RelayAttemptAuditLedger::default();
        for status in 0..(RELAY_ATTEMPT_AUDIT_MAX_ENTRIES + 5) {
            let failure = RelayAttemptFailure::retryable_status(
                7,
                "private-name".to_string(),
                500 + status as u16,
                true,
            );
            ledger.push(RelayAttemptAudit::from_failure(
                "primary", "gpt-test", "default", &failure,
            ));
        }

        assert_eq!(
            ledger.total,
            RELAY_ATTEMPT_AUDIT_MAX_ENTRIES.saturating_add(5)
        );
        assert_eq!(ledger.entries.len(), RELAY_ATTEMPT_AUDIT_MAX_ENTRIES);
        assert!(ledger.truncated());
        assert_eq!(ledger.json_entries().len(), RELAY_ATTEMPT_AUDIT_MAX_ENTRIES);
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
            other: String::new(),
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
            route: ProviderRelayRoute::ChatCompletions,
            upstream_path: "chat/completions".to_string(),
            upstream_query: None,
            gemini_route: None,
            provider: RelayProviderKind::OpenAiCompatible,
            supports_streaming: true,
            force_streaming: false,
            stream_not_implemented_feature: None,
            parse_non_stream_usage: true,
            request_body_mode: RelayRequestBodyMode::Json,
            request_validator: None,
        }
    }

    #[test]
    fn deepseek_uses_route_specific_provider_urls_and_request_suffixes() {
        let mut channel = test_channel(43, 0, 1);
        channel.channel_type = CHANNEL_TYPE_DEEPSEEK;
        channel.base_url = Some("https://api.deepseek.com".to_string());

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert!(matches!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::DeepSeekOpenAi
        ));
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.deepseek.com/v1/chat/completions"
        );

        let mut completions = endpoint(false, None);
        completions.route = ProviderRelayRoute::Completions;
        completions.upstream_path = "completions".to_string();
        assert_eq!(
            completions.upstream_url(&channel),
            "https://api.deepseek.com/beta/completions"
        );

        let mut messages = endpoint(true, None);
        messages.route = ProviderRelayRoute::AnthropicMessages;
        messages.provider = RelayProviderKind::AnthropicMessages;
        messages.upstream_path = "messages".to_string();
        assert!(matches!(
            messages.effective_provider(channel.channel_type),
            RelayProviderKind::DeepSeekMessages
        ));
        assert_eq!(
            messages.upstream_url(&channel),
            "https://api.deepseek.com/anthropic/v1/messages"
        );

        let mut body = json!({"model": "deepseek-v4-preview-max"});
        apply_provider_request_transform(&mut body, RelayProviderKind::DeepSeekOpenAi);
        assert_eq!(body["model"], "deepseek-v4-preview");
        assert_eq!(body["thinking"]["type"], "enabled");
    }

    #[test]
    fn mistral_uses_a_dedicated_provider_and_csprng_tool_ids() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_MISTRAL), 0, 1);
        channel.channel_type = CHANNEL_TYPE_MISTRAL;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::MistralOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::MistralOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.mistral.ai/v1/chat/completions"
        );

        let mut body = json!({
            "model": "mistral/mistral-large-latest",
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call-too-long",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "{}"}
                    }]
                },
                {"role": "tool", "tool_call_id": "call-too-long", "content": "ok"}
            ],
            "max_completion_tokens": 32,
            "user": "removed"
        });
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        let generated = body["messages"][0]["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(generated.len(), 9);
        assert!(generated.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_eq!(body["messages"][1]["tool_call_id"], generated);
        assert_eq!(body["max_tokens"], 32);
        assert!(body.get("user").is_none());

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        let gateway = plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "mistral/mistral-large-latest",
        )
        .unwrap()
        .unwrap();
        let direct = prepare_ai_gateway_direct_fallback_body(&body, &gateway).unwrap();
        assert_eq!(direct["model"], "mistral-large-latest");

        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_MISTRAL,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_MISTRAL,
            ProviderRelayRoute::Embeddings
        ));
    }

    #[test]
    fn perplexity_uses_a_dedicated_provider_and_chat_gateway_only() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_PERPLEXITY), 0, 1);
        channel.channel_type = CHANNEL_TYPE_PERPLEXITY;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::PerplexityOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::PerplexityOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.perplexity.ai/chat/completions"
        );

        let mut body = json!({
            "model": "perplexity/sonar-pro",
            "messages": [{"role": "user", "content": "search", "name": "removed"}],
            "top_p": 1,
            "max_completion_tokens": 32,
            "tools": [{"type": "function"}],
            "search_recency_filter": "week"
        });
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["top_p"], 0.99);
        assert_eq!(body["max_tokens"], 32);
        assert!(body.get("tools").is_none());
        assert!(body["messages"][0].get("name").is_none());

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        let gateway = plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "perplexity/sonar-pro",
        )
        .unwrap()
        .unwrap();
        let direct = prepare_ai_gateway_direct_fallback_body(&body, &gateway).unwrap();
        assert_eq!(direct["model"], "sonar-pro");

        let mut responses = ai_gateway_chat_endpoint_for_tests();
        responses.route = ProviderRelayRoute::Responses;
        responses.upstream_path = "responses".to_string();
        assert!(responses.try_upstream_url(&channel).is_err());
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &responses,
            &channel,
            "perplexity/sonar-pro"
        )
        .unwrap()
        .is_none());

        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_PERPLEXITY,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_PERPLEXITY,
            ProviderRelayRoute::Responses
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_PERPLEXITY,
            ProviderRelayRoute::Embeddings
        ));
    }

    #[test]
    fn moonshot_is_a_direct_only_dual_format_provider() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_MOONSHOT), 0, 1);
        channel.channel_type = CHANNEL_TYPE_MOONSHOT;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::MoonshotOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::MoonshotOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.moonshot.cn/v1/chat/completions"
        );

        let mut messages = endpoint(true, None);
        messages.route = ProviderRelayRoute::AnthropicMessages;
        messages.provider = RelayProviderKind::AnthropicMessages;
        messages.upstream_path = "messages".to_string();
        assert_eq!(
            messages.effective_provider(channel.channel_type),
            RelayProviderKind::MoonshotMessages
        );
        assert_eq!(
            messages.upstream_url(&channel),
            "https://api.moonshot.cn/anthropic/v1/messages"
        );

        let mut body = json!({
            "model": "kimi-k2.6",
            "messages": [{"role": "user", "content": "hello"}],
            "temperature": 0.2,
            "stream": true
        });
        apply_provider_request_transform(&mut body, RelayProviderKind::MoonshotOpenAi);
        assert_eq!(body["temperature"], 1.0);
        cinatoken_relay::openai_compatible::apply_stream_options(
            &mut body,
            channel.channel_type,
            true,
        );
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(
            prepare_same_channel_direct_body(&body, channel.channel_type, "chat/completions")
                .unwrap()
                .is_none()
        );

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "kimi-k2.6"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        for route in [
            ProviderRelayRoute::ChatCompletions,
            ProviderRelayRoute::Completions,
            ProviderRelayRoute::Embeddings,
            ProviderRelayRoute::Rerank,
            ProviderRelayRoute::AnthropicMessages,
        ] {
            assert!(channel_supports_relay_route(CHANNEL_TYPE_MOONSHOT, route));
        }
        for route in [
            ProviderRelayRoute::Responses,
            ProviderRelayRoute::ImageGenerations,
            ProviderRelayRoute::AudioSpeech,
        ] {
            assert!(!channel_supports_relay_route(CHANNEL_TYPE_MOONSHOT, route));
        }
    }

    #[test]
    fn ali_is_route_explicit_direct_only_and_dual_format() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_ALI), 0, 1);
        channel.channel_type = CHANNEL_TYPE_ALI;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::AliOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::AliOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );

        let mut messages = endpoint(true, None);
        messages.route = ProviderRelayRoute::AnthropicMessages;
        messages.provider = RelayProviderKind::AnthropicMessages;
        messages.upstream_path = "messages".to_string();
        assert_eq!(
            messages.effective_provider(channel.channel_type),
            RelayProviderKind::AliMessages
        );
        assert_eq!(
            messages.upstream_url(&channel),
            "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages"
        );

        let mut body = json!({
            "model": "qwen-plus",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        });
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["top_p"], 0.001);
        cinatoken_relay::openai_compatible::apply_stream_options(
            &mut body,
            channel.channel_type,
            true,
        );
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(provider_uses_openai_stream_options(
            RelayProviderKind::AliOpenAi
        ));
        assert!(!provider_uses_openai_stream_options(
            RelayProviderKind::AliMessages
        ));

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "qwen-plus"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        for route in [
            ProviderRelayRoute::ChatCompletions,
            ProviderRelayRoute::Completions,
            ProviderRelayRoute::Responses,
            ProviderRelayRoute::Embeddings,
            ProviderRelayRoute::AnthropicMessages,
            ProviderRelayRoute::Rerank,
        ] {
            assert!(channel_supports_relay_route(CHANNEL_TYPE_ALI, route));
        }
        for route in [
            ProviderRelayRoute::ImageGenerations,
            ProviderRelayRoute::ImageEdits,
            ProviderRelayRoute::AudioSpeech,
            ProviderRelayRoute::GeminiNative,
        ] {
            assert!(!channel_supports_relay_route(CHANNEL_TYPE_ALI, route));
        }
    }

    #[test]
    fn ali_shape_guards_and_rerank_transform_run_before_reserve() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_ALI), 0, 1);
        channel.channel_type = CHANNEL_TYPE_ALI;
        let chat = ai_gateway_chat_endpoint_for_tests();
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "qwen-plus",
                "messages": [{"role": "user", "content": "hello"}],
                "top_p": 0.5
            }))
        ));
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "qwen-plus",
                "messages": [{"role": "user", "content": "hello"}],
                "top_p": "wide"
            }))
        ));

        let mut messages = endpoint(true, None);
        messages.route = ProviderRelayRoute::AnthropicMessages;
        messages.provider = RelayProviderKind::AnthropicMessages;
        messages.upstream_path = "messages".to_string();
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &messages,
            Some(&json!({
                "model": "qwen3.7-plus",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 64
            }))
        ));
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &messages,
            Some(&json!({
                "model": "claude-sonnet-4",
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 64
            }))
        ));

        channel.model_mapping = Some(r#"{"alias":"qwen3.7-plus"}"#.to_string());
        let already_mapped = json!({
            "model": "alias",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 64
        });
        assert!(!ali_accepts_request_shape(
            &messages,
            &channel,
            &already_mapped,
            true,
            None,
        ));
        assert!(ali_accepts_request_shape(
            &messages,
            &channel,
            &already_mapped,
            false,
            None,
        ));
        channel.model_mapping = None;

        let mut rerank = endpoint(false, None);
        rerank.route = ProviderRelayRoute::Rerank;
        rerank.upstream_path = "rerank".to_string();
        let mut rerank_body = json!({
            "model": "gte-rerank-v2",
            "query": "hello",
            "documents": ["a", "b"],
            "top_n": 1
        });
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &rerank,
            Some(&rerank_body)
        ));
        apply_endpoint_request_transform(&mut rerank_body, "rerank", &channel).unwrap();
        assert_eq!(rerank_body["input"]["query"], "hello");
        assert_eq!(rerank_body["parameters"]["return_documents"], true);
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &rerank,
            Some(&json!({
                "model": "qwen3-rerank",
                "query": "hello",
                "documents": ["a"]
            }))
        ));

        channel.other = "invalid\r\nplugin".to_string();
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "qwen-plus",
                "messages": [{"role": "user", "content": "hello"}]
            }))
        ));
        channel.other.clear();

        let mut images = endpoint(false, None);
        images.route = ProviderRelayRoute::ImageGenerations;
        images.upstream_path = "images/generations".to_string();
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &images,
            Some(&json!({"model": "wan2.6-t2i", "prompt": "hello"}))
        ));
        assert!(images.try_upstream_url(&channel).is_err());
    }

    #[test]
    fn ali_admin_probes_cover_the_supported_route_families() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_ALI), 0, 1);
        channel.channel_type = CHANNEL_TYPE_ALI;
        let rerank_request = AdminChannelProbeRequest {
            model: "gte-rerank-v2".to_string(),
            endpoint_type: AdminProbeEndpoint::JinaRerank,
            stream: false,
        };
        let prepared = prepare_admin_channel_probe(&channel, &rerank_request, false, None).unwrap();
        assert_eq!(prepared.provider, RelayProviderKind::AliOpenAi);
        assert_eq!(prepared.body["input"]["query"], "hi");
        assert_eq!(prepared.body["parameters"]["return_documents"], true);
        assert_eq!(
            prepared.upstream_url,
            "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
        );

        channel.model_mapping = Some(r#"{"public-model":"custom-native"}"#.to_string());
        let messages_request = AdminChannelProbeRequest {
            model: "public-model".to_string(),
            endpoint_type: AdminProbeEndpoint::Anthropic,
            stream: true,
        };
        assert!(prepare_admin_channel_probe(&channel, &messages_request, true, None).is_err());
        let prepared =
            prepare_admin_channel_probe(&channel, &messages_request, true, Some("custom-native"))
                .unwrap();
        assert_eq!(prepared.provider, RelayProviderKind::AliMessages);
        assert_eq!(prepared.body["model"], "custom-native");
        assert!(prepared.body.get("stream_options").is_none());
        channel.model_mapping = None;

        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_ALI,
                AdminProbeEndpoint::Auto,
                "text-embedding-v4",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::Embeddings
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_ALI,
                AdminProbeEndpoint::Auto,
                "gte-rerank-v2",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::JinaRerank
        );
        for endpoint in [
            AdminProbeEndpoint::OpenAi,
            AdminProbeEndpoint::OpenAiCompletions,
            AdminProbeEndpoint::OpenAiResponse,
            AdminProbeEndpoint::Anthropic,
            AdminProbeEndpoint::Embeddings,
            AdminProbeEndpoint::JinaRerank,
        ] {
            assert_eq!(
                resolve_admin_probe_endpoint(CHANNEL_TYPE_ALI, endpoint, "qwen-plus", false)
                    .unwrap(),
                endpoint
            );
        }
        assert!(resolve_admin_probe_endpoint(
            CHANNEL_TYPE_ALI,
            AdminProbeEndpoint::ImageGeneration,
            "wan2.6-t2i",
            false,
        )
        .is_err());
    }

    #[test]
    fn moonshot_shape_and_coding_plan_guards_run_before_reserve() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_MOONSHOT), 0, 1);
        channel.channel_type = CHANNEL_TYPE_MOONSHOT;
        let chat = ai_gateway_chat_endpoint_for_tests();

        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "kimi-k2.6",
                "messages": [{"role": "user", "content": "hello"}],
                "temperature": 1
            }))
        ));
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "kimi-k2.6",
                "messages": [{"role": "user", "content": "hello"}],
                "temperature": "hot"
            }))
        ));

        channel.base_url = Some("kimi-coding-plan".to_string());
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.kimi.com/coding/v1/chat/completions"
        );
        let mut embeddings = ai_gateway_chat_endpoint_for_tests();
        embeddings.route = ProviderRelayRoute::Embeddings;
        embeddings.upstream_path = "embeddings".to_string();
        let embedding_body = json!({"model": "kimi-embedding", "input": "hello"});
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &embeddings,
            Some(&embedding_body)
        ));
        assert!(embeddings.try_upstream_url(&channel).is_err());
    }

    #[test]
    fn moonshot_usage_parser_handles_non_stream_and_nested_stream_cache_tokens() {
        assert_eq!(
            usage_summary_for_provider(
                r#"{"usage":{"prompt_tokens":13,"completion_tokens":2,"total_tokens":15},"choices":[{"usage":{"cached_tokens":8}}]}"#,
                RelayProviderKind::MoonshotOpenAi,
                "chat/completions"
            ),
            UsageSummary {
                prompt_tokens: 13,
                completion_tokens: 2,
                total_tokens: 15,
                cached_tokens: 8,
                ..UsageSummary::default()
            }
        );
        let mut accumulator = SseUsageAccumulator::moonshot();
        accumulator.push_chunk(
            b"data: {\"choices\":[{\"usage\":{\"cached_tokens\":21}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3,\"total_tokens\":12}}\n\n",
        );
        let usage = accumulator.finish();
        assert_eq!(usage.total_tokens, 12);
        assert_eq!(usage.cached_tokens, 21);
        assert_eq!(
            usage_summary_for_provider(
                r#"{"usage":{"total_tokens":19}}"#,
                RelayProviderKind::MoonshotOpenAi,
                "rerank"
            ),
            UsageSummary {
                prompt_tokens: 19,
                total_tokens: 19,
                ..UsageSummary::default()
            }
        );
    }

    #[test]
    fn zhipu_v4_is_route_explicit_and_direct_only() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_ZHIPU_V4), 0, 1);
        channel.channel_type = CHANNEL_TYPE_ZHIPU_V4;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::ZhipuV4OpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );

        let mut messages = endpoint(true, None);
        messages.route = ProviderRelayRoute::AnthropicMessages;
        messages.provider = RelayProviderKind::AnthropicMessages;
        messages.upstream_path = "messages".to_string();
        assert_eq!(
            messages.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::ZhipuV4Messages
        );
        assert_eq!(
            messages.upstream_url(&channel),
            "https://open.bigmodel.cn/api/anthropic/v1/messages"
        );

        let mut body = json!({
            "model": "glm-4.7",
            "messages": [{
                "role": "user",
                "name": "removed",
                "content": [{
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AAAA"}
                }]
            }],
            "top_p": 1,
            "stop": "END",
            "max_completion_tokens": 64,
            "user": "removed"
        });
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["top_p"], 0.99);
        assert_eq!(body["stop"], json!(["END"]));
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(
            body["messages"][0]["content"][0]["image_url"]["url"],
            "AAAA"
        );
        assert!(body["messages"][0].get("name").is_none());
        assert!(body.get("user").is_none());

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "glm-4.7"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        for route in [
            ProviderRelayRoute::ChatCompletions,
            ProviderRelayRoute::Embeddings,
            ProviderRelayRoute::ImageGenerations,
            ProviderRelayRoute::AnthropicMessages,
        ] {
            assert!(channel_supports_relay_route(CHANNEL_TYPE_ZHIPU_V4, route));
        }
        for route in [
            ProviderRelayRoute::Completions,
            ProviderRelayRoute::Responses,
            ProviderRelayRoute::Rerank,
            ProviderRelayRoute::AudioSpeech,
        ] {
            assert!(!channel_supports_relay_route(CHANNEL_TYPE_ZHIPU_V4, route));
        }
        assert!(!channel_supports_relay_route(
            16,
            ProviderRelayRoute::ChatCompletions
        ));
    }

    #[test]
    fn zhipu_v4_admin_auto_probe_uses_model_specific_supported_routes() {
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_ZHIPU_V4,
                AdminProbeEndpoint::Auto,
                "embedding-3",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::Embeddings
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_ZHIPU_V4,
                AdminProbeEndpoint::Auto,
                "glm-image",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::ImageGeneration
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_ZHIPU_V4,
                AdminProbeEndpoint::ImageGeneration,
                "glm-image",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::ImageGeneration
        );
    }

    #[test]
    fn baidu_v2_chat_is_route_explicit_direct_only_and_search_aware() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_BAIDU_V2), 0, 1);
        channel.channel_type = CHANNEL_TYPE_BAIDU_V2;
        channel.key = "token-1|app-2".to_string();
        let chat = ai_gateway_chat_endpoint_for_tests();

        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::BaiduV2OpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://qianfan.baidubce.com/v2/chat/completions"
        );
        let mut body = json!({
            "model": "ernie-4.5-turbo-search",
            "messages": [{"role": "user", "content": "news"}],
            "stream": false
        });
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&body)
        ));
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["model"], "ernie-4.5-turbo");
        assert_eq!(body["web_search"]["enable"], true);

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "ernie-4.5-turbo"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        channel.other_info.clear();
        channel.key = "|app-2".to_string();
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&body)
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_BAIDU_V2,
            ProviderRelayRoute::Embeddings
        ));
    }

    #[test]
    fn volcengine_standard_routes_are_explicit_direct_only_and_fail_closed_for_bots() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_VOLCENGINE), 0, 1);
        channel.channel_type = CHANNEL_TYPE_VOLCENGINE;
        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::VolcEngineOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );

        let mut body = json!({
            "model": "deepseek-v3-thinking",
            "messages": [{"role": "user", "content": "hello"}]
        });
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&body)
        ));
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["model"], "deepseek-v3");
        assert_eq!(body["thinking"]["type"], "enabled");

        for route in [
            ProviderRelayRoute::ChatCompletions,
            ProviderRelayRoute::Embeddings,
            ProviderRelayRoute::ImageGenerations,
            ProviderRelayRoute::Responses,
        ] {
            assert!(channel_supports_relay_route(CHANNEL_TYPE_VOLCENGINE, route));
        }
        for route in [
            ProviderRelayRoute::Completions,
            ProviderRelayRoute::Rerank,
            ProviderRelayRoute::AudioSpeech,
            ProviderRelayRoute::AnthropicMessages,
        ] {
            assert!(!channel_supports_relay_route(
                CHANNEL_TYPE_VOLCENGINE,
                route
            ));
        }

        let bot_body = json!({
            "model": "bot-app-1",
            "messages": [{"role": "user", "content": "hello"}]
        });
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&bot_body)
        ));

        channel.base_url = Some("doubao-coding-plan".to_string());
        let mut responses = endpoint(false, None);
        responses.route = ProviderRelayRoute::Responses;
        responses.upstream_path = "responses".to_string();
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &responses,
            Some(&json!({"model": "doubao-seed", "input": "hello"}))
        ));
        assert_eq!(
            chat.upstream_url(&channel),
            "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
        );
    }

    #[test]
    fn regional_provider_admin_auto_probe_uses_only_migrated_routes() {
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_VOLCENGINE,
                AdminProbeEndpoint::Auto,
                "doubao-seedream-4-0",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::ImageGeneration
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_VOLCENGINE,
                AdminProbeEndpoint::Auto,
                "doubao-embedding",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::Embeddings
        );
        assert_eq!(
            resolve_admin_probe_endpoint(
                CHANNEL_TYPE_BAIDU_V2,
                AdminProbeEndpoint::Auto,
                "ernie-4.5-turbo-search",
                false,
            )
            .unwrap(),
            AdminProbeEndpoint::OpenAi
        );
    }

    #[test]
    fn tencent_hunyuan_is_non_streaming_direct_only_and_tc3_shaped() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_TENCENT), 0, 1);
        channel.channel_type = CHANNEL_TYPE_TENCENT;
        channel.key = "1250000000|AKID-test|secret-test".to_string();
        let chat = ai_gateway_chat_endpoint_for_tests();

        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::TencentHunyuan
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::TencentHunyuan
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://hunyuan.tencentcloudapi.com/"
        );

        let mut body = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false,
            "top_p": 0.8,
            "temperature": 0.2
        });
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&body)
        ));
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["Model"], "hunyuan-turbo");
        assert_eq!(body["Messages"][0]["Content"], "hello");
        assert_eq!(body["Stream"], false);
        assert!(body.get("model").is_none());
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&body)
        ));

        let null_stream = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": null
        });
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&null_stream)
        ));

        let mut unsupported = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 16
        });
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&unsupported)
        ));
        assert!(
            apply_endpoint_request_transform(&mut unsupported, "chat/completions", &channel)
                .is_err()
        );

        let streaming_body = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        });
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&streaming_body)
        ));
        assert!(resolve_admin_probe_endpoint(
            CHANNEL_TYPE_TENCENT,
            AdminProbeEndpoint::OpenAi,
            "hunyuan-turbo",
            true,
        )
        .is_err());

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "hunyuan-turbo"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));
        channel.other_info.clear();
        channel.key = "invalid".to_string();
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &chat,
            Some(&json!({
                "model": "hunyuan-turbo",
                "messages": [{"role": "user", "content": "hello"}]
            }))
        ));
    }

    #[test]
    fn tencent_provider_errors_map_into_retry_and_refund_status_classes() {
        assert_eq!(
            tencent_provider_error_status("InvalidParameterValue.Model"),
            400
        );
        assert_eq!(
            tencent_provider_error_status("AuthFailure.SignatureFailure"),
            401
        );
        assert_eq!(tencent_provider_error_status("UnauthorizedOperation"), 403);
        assert_eq!(tencent_provider_error_status("RequestLimitExceeded"), 429);
        assert_eq!(
            tencent_provider_error_status("FailedOperation.EngineRequestTimeout"),
            503
        );
        assert_eq!(tencent_provider_error_status("UnknownProviderError"), 502);
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(503));

        let body = tencent_openai_error_body(429, "RequestLimitExceeded", "rate limited").unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["error"]["type"], "rate_limit_error");
        assert_eq!(body["error"]["code"], "RequestLimitExceeded");
    }

    #[test]
    fn submodel_is_direct_only_and_keeps_opaque_model_names() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_SUBMODEL), 0, 1);
        channel.channel_type = CHANNEL_TYPE_SUBMODEL;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::SubmodelOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::SubmodelOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://llm.submodel.ai/v1/chat/completions"
        );

        let mut body = json!({
            "model": "openai/gpt-oss-120b",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        });
        cinatoken_relay::openai_compatible::apply_stream_options(
            &mut body,
            channel.channel_type,
            true,
        );
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(
            prepare_same_channel_direct_body(&body, channel.channel_type, "chat/completions")
                .unwrap()
                .is_none()
        );
        assert_eq!(body["model"], "openai/gpt-oss-120b");

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "openai/gpt-oss-120b"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        let mut completions = ai_gateway_chat_endpoint_for_tests();
        completions.route = ProviderRelayRoute::Completions;
        completions.upstream_path = "completions".to_string();
        assert_eq!(
            completions.upstream_url(&channel),
            "https://llm.submodel.ai/v1/completions"
        );
        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_SUBMODEL,
            ProviderRelayRoute::ChatCompletions
        ));
        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_SUBMODEL,
            ProviderRelayRoute::Completions
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_SUBMODEL,
            ProviderRelayRoute::Responses
        ));
    }

    #[test]
    fn siliconflow_is_direct_only_and_exposes_only_audited_routes() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_SILICONFLOW), 0, 1);
        channel.channel_type = CHANNEL_TYPE_SILICONFLOW;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::SiliconFlowOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::SiliconFlowOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.siliconflow.cn/v1/chat/completions"
        );

        let mut body = json!({
            "model": "deepseek-ai/DeepSeek-V3",
            "prefix": "fn main() {",
            "suffix": "}",
            "stream": true
        });
        apply_endpoint_request_transform(&mut body, "chat/completions", &channel).unwrap();
        assert_eq!(body["messages"], json!([{"role": "user", "content": ""}]));
        cinatoken_relay::openai_compatible::apply_stream_options(
            &mut body,
            channel.channel_type,
            true,
        );
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(
            prepare_same_channel_direct_body(&body, channel.channel_type, "chat/completions")
                .unwrap()
                .is_none()
        );
        assert_eq!(body["model"], "deepseek-ai/DeepSeek-V3");

        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        assert!(plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "deepseek-ai/DeepSeek-V3"
        )
        .unwrap_err()
        .to_string()
        .contains("direct-only provider"));

        for route in [
            ProviderRelayRoute::ChatCompletions,
            ProviderRelayRoute::Completions,
            ProviderRelayRoute::Embeddings,
            ProviderRelayRoute::Rerank,
            ProviderRelayRoute::ImageGenerations,
        ] {
            assert!(channel_supports_relay_route(
                CHANNEL_TYPE_SILICONFLOW,
                route
            ));
        }
        for route in [
            ProviderRelayRoute::Responses,
            ProviderRelayRoute::AnthropicMessages,
            ProviderRelayRoute::ImageEdits,
            ProviderRelayRoute::AudioSpeech,
        ] {
            assert!(!channel_supports_relay_route(
                CHANNEL_TYPE_SILICONFLOW,
                route
            ));
        }
    }

    #[test]
    fn siliconflow_shape_and_direct_transport_guards_run_before_reserve() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_SILICONFLOW), 0, 1);
        channel.channel_type = CHANNEL_TYPE_SILICONFLOW;
        let mut image = ai_gateway_chat_endpoint_for_tests();
        image.route = ProviderRelayRoute::ImageGenerations;
        image.upstream_path = "images/generations".to_string();

        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &image,
            Some(&json!({
                "model": "Kwai-Kolors/Kolors",
                "prompt": "rust skyline",
                "batch_size": 4
            }))
        ));
        for invalid in [
            json!({"model": "Kwai-Kolors/Kolors", "prompt": "rust", "batch_size": 5}),
            json!({"model": "Kwai-Kolors/Kolors", "prompt": "rust", "stream": true}),
            json!({"model": "Kwai-Kolors/Kolors", "prompt": 42}),
        ] {
            assert!(!channel_accepts_endpoint_request_shape(
                &channel,
                &image,
                Some(&invalid)
            ));
        }

        let mut rerank = ai_gateway_chat_endpoint_for_tests();
        rerank.route = ProviderRelayRoute::Rerank;
        rerank.upstream_path = "rerank".to_string();
        assert!(channel_accepts_endpoint_request_shape(
            &channel,
            &rerank,
            Some(&json!({
                "model": "BAAI/bge-reranker-v2-m3",
                "query": "rust",
                "documents": ["one", "two"]
            }))
        ));
        assert!(!channel_accepts_endpoint_request_shape(
            &channel,
            &rerank,
            Some(&json!({
                "model": "BAAI/bge-reranker-v2-m3",
                "query": "rust",
                "documents": [{"text": "not supported"}]
            }))
        ));

        let body = json!({
            "model": "deepseek-ai/DeepSeek-V3",
            "messages": [{"role": "user", "content": "hello"}]
        });
        channel.other_info = r#"{"wfp_worker":"tenant-a"}"#.to_string();
        let mut pools = vec![("default".to_string(), vec![channel])];
        retain_pre_reserve_capable_channels(
            &mut pools,
            &ai_gateway_chat_endpoint_for_tests(),
            false,
            Some(&body),
            None,
        );
        assert!(pools[0].1.is_empty());

        let mut submodel = test_channel(i64::from(CHANNEL_TYPE_SUBMODEL), 0, 1);
        submodel.channel_type = CHANNEL_TYPE_SUBMODEL;
        submodel.other_info = r#"{"wfp_worker":"tenant-a"}"#.to_string();
        let mut pools = vec![("default".to_string(), vec![submodel])];
        retain_pre_reserve_capable_channels(
            &mut pools,
            &ai_gateway_chat_endpoint_for_tests(),
            false,
            Some(&body),
            None,
        );
        assert!(pools[0].1.is_empty());
    }

    #[test]
    fn xai_uses_a_dedicated_provider_with_route_specific_transforms() {
        let mut channel = test_channel(i64::from(CHANNEL_TYPE_XAI), 0, 1);
        channel.channel_type = CHANNEL_TYPE_XAI;

        let chat = ai_gateway_chat_endpoint_for_tests();
        assert_eq!(
            chat.effective_provider(channel.channel_type),
            RelayProviderKind::XaiOpenAi
        );
        assert_eq!(
            chat.registry_provider_kind(channel.channel_type),
            RegistryProviderKind::XaiOpenAi
        );
        assert_eq!(
            chat.upstream_url(&channel),
            "https://api.x.ai/v1/chat/completions"
        );

        let mut chat_body = json!({
            "model": "grok-3-mini-high",
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 64
        });
        apply_endpoint_request_transform(&mut chat_body, "chat/completions", &channel).unwrap();
        assert_eq!(chat_body["model"], "grok-3-mini");
        assert_eq!(chat_body["reasoning_effort"], "high");
        assert_eq!(chat_body["max_completion_tokens"], 64);

        let mut responses = ai_gateway_chat_endpoint_for_tests();
        responses.route = ProviderRelayRoute::Responses;
        responses.upstream_path = "responses".to_string();
        assert_eq!(
            responses.upstream_url(&channel),
            "https://api.x.ai/v1/responses"
        );
        channel.other_info = r#"{"ai_gateway":{"enabled":true}}"#.to_string();
        let gateway = plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &responses,
            &channel,
            "xai/grok-4.5",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            gateway.plan.endpoint,
            cinatoken_providers::ai_gateway::AiGatewayRestEndpoint::Responses
        );
        let gateway_body = json!({"model": "xai/grok-4.5", "input": "hello"});
        let direct = prepare_ai_gateway_direct_fallback_body(&gateway_body, &gateway).unwrap();
        assert_eq!(direct["model"], "grok-4.5");

        let chat_gateway = plan_relay_ai_gateway_attempt(
            &ai_gateway_runtime_for_tests(),
            &chat,
            &channel,
            "xai/grok-3-mini-high",
        )
        .unwrap()
        .unwrap();
        let direct = prepare_ai_gateway_direct_fallback_body(
            &json!({"model": "xai/grok-3-mini-high", "messages": [], "max_tokens": 64}),
            &chat_gateway,
        )
        .unwrap();
        assert_eq!(direct["model"], "grok-3-mini");
        assert_eq!(direct["reasoning_effort"], "high");
        assert_eq!(direct["max_completion_tokens"], 64);
        assert!(direct.get("max_tokens").is_none());

        assert!(channel_supports_relay_route(
            CHANNEL_TYPE_XAI,
            ProviderRelayRoute::ImageGenerations
        ));
        assert!(!channel_supports_relay_route(
            CHANNEL_TYPE_XAI,
            ProviderRelayRoute::Embeddings
        ));
    }

    #[test]
    fn pre_reserve_filter_fails_closed_for_unroutable_channels() {
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut valid_deepseek = test_channel(43, 0, 1);
        valid_deepseek.channel_type = CHANNEL_TYPE_DEEPSEEK;
        valid_deepseek.base_url = Some("https://api.deepseek.com".to_string());

        let mut dedicated_pending = test_channel(15, 0, 1);
        dedicated_pending.channel_type = 15;
        dedicated_pending.base_url = Some("https://example.com/v1".to_string());
        let mut missing_key = test_channel(1, 0, 1);
        missing_key.key.clear();
        let mut conflicting_transport = test_channel(1, 0, 1);
        conflicting_transport.other_info =
            r#"{"ai_gateway":{"enabled":true},"wfp_worker":"tenant-a"}"#.to_string();
        let mut streaming_workers_ai = test_channel(39, 0, 1);
        streaming_workers_ai.channel_type =
            cinatoken_relay::openai_compatible::CHANNEL_TYPE_CLOUDFLARE;
        streaming_workers_ai.key = "internal".to_string();

        let mut pools = vec![(
            "default".to_string(),
            vec![
                valid_deepseek,
                dedicated_pending,
                missing_key,
                conflicting_transport,
                streaming_workers_ai,
            ],
        )];
        retain_route_capable_channels(&mut pools, Some(endpoint.route));
        retain_pre_reserve_capable_channels(&mut pools, &endpoint, true, None, None);

        let remaining = pools[0]
            .1
            .iter()
            .map(|channel| channel.channel_type)
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec![43]);
    }

    #[test]
    fn perplexity_fim_without_messages_is_filtered_before_reserve() {
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut perplexity = test_channel(i64::from(CHANNEL_TYPE_PERPLEXITY), 0, 1);
        perplexity.channel_type = CHANNEL_TYPE_PERPLEXITY;

        assert!(!channel_accepts_endpoint_request_shape(
            &perplexity,
            &endpoint,
            Some(&json!({"model": "sonar", "prefix": "fn main() {"}))
        ));
        assert!(channel_accepts_endpoint_request_shape(
            &perplexity,
            &endpoint,
            Some(&json!({
                "model": "sonar",
                "messages": [{"role": "user", "content": "hello"}]
            }))
        ));
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
    fn relay_ai_gateway_attempt_rejects_conflicting_wfp_transport() {
        let runtime = ai_gateway_runtime_for_tests();
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut channel = test_channel(1, 0, 1);
        channel.other_info =
            r#"{"ai_gateway":{"enabled":true},"wfp_worker":"tenant-a"}"#.to_string();

        let error = plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "openai/gpt-4.1")
            .unwrap_err();
        assert!(error.to_string().contains("cannot enable both"));
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
    fn relay_ai_gateway_direct_fallback_is_server_failure_only() {
        assert!(relay_ai_gateway_direct_fallback_contract_compiled());
        for status in [500, 502, 503, 523, 525, 599] {
            assert!(
                should_ai_gateway_direct_fallback(status),
                "{status} should fall back to direct provider"
            );
        }

        for status in [100, 200, 201, 204, 302, 400, 401, 403, 408, 429, 504, 524] {
            assert!(
                !should_ai_gateway_direct_fallback(status),
                "{status} should keep the AI Gateway response"
            );
        }
    }

    #[test]
    fn relay_ai_gateway_direct_fallback_restores_provider_native_model() {
        let runtime = ai_gateway_runtime_for_tests();
        let endpoint = ai_gateway_chat_endpoint_for_tests();
        let mut channel = test_channel(1, 0, 1);
        channel.other_info = r#"{"ai_gateway":true}"#.to_string();
        let attempt =
            plan_relay_ai_gateway_attempt(&runtime, &endpoint, &channel, "openai/gpt-4.1")
                .unwrap()
                .unwrap();
        let body = json!({"model": "openai/gpt-4.1", "messages": []});
        let direct = prepare_ai_gateway_direct_fallback_body(&body, &attempt).unwrap();
        assert_eq!(direct["model"], "gpt-4.1");
        assert_eq!(body["model"], "openai/gpt-4.1");

        assert_eq!(
            direct_provider_model_for_channel(
                "anthropic/claude-sonnet-4",
                AiGatewayModelAuthor::Anthropic,
                14
            ),
            Some("claude-sonnet-4")
        );
        assert_eq!(
            direct_provider_model_for_channel(
                "@cf/meta/llama",
                AiGatewayModelAuthor::WorkersAi,
                39
            ),
            None
        );

        let mut mismatched_channel = channel.clone();
        mismatched_channel.channel_type = CHANNEL_TYPE_DEEPSEEK;
        let mismatched_attempt = plan_relay_ai_gateway_attempt(
            &runtime,
            &endpoint,
            &mismatched_channel,
            "openai/gpt-4.1",
        )
        .unwrap()
        .unwrap();
        assert!(prepare_ai_gateway_direct_fallback_body(&body, &mismatched_attempt).is_none());

        let deepseek_body = json!({"model": "deepseek/deepseek-chat", "messages": []});
        let deepseek_attempt = plan_relay_ai_gateway_attempt(
            &runtime,
            &endpoint,
            &mismatched_channel,
            "deepseek/deepseek-chat",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            prepare_ai_gateway_direct_fallback_body(&deepseek_body, &deepseek_attempt).unwrap()
                ["model"],
            "deepseek-chat"
        );

        // `worker::Response` headers call wasm-bindgen imports and cannot be
        // instantiated by the native unit-test target.
        #[cfg(target_arch = "wasm32")]
        {
            let marked = mark_ai_gateway_direct_fallback(
                Response::ok("ok").unwrap().with_status(502),
                "gateway_status_500",
            )
            .unwrap();
            assert_eq!(marked.status_code(), 502);
            assert_eq!(
                marked
                    .headers()
                    .get(AI_GATEWAY_DIRECT_FALLBACK_AUDIT_HEADER)
                    .unwrap()
                    .as_deref(),
                Some("gateway_status_500")
            );
        }
    }

    #[test]
    fn relay_direct_route_normalizes_only_matching_gateway_prefixed_models() {
        let mistral_body = json!({
            "model": "mistral/mistral-large-latest",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        });
        let mistral_direct = prepare_same_channel_direct_body(
            &mistral_body,
            CHANNEL_TYPE_MISTRAL,
            "chat/completions",
        )
        .unwrap()
        .unwrap();
        assert_eq!(mistral_direct["model"], "mistral-large-latest");
        assert_eq!(mistral_direct["messages"], mistral_body["messages"]);
        assert_eq!(mistral_body["model"], "mistral/mistral-large-latest");

        let openai_direct = prepare_same_channel_direct_body(
            &json!({"model": "openai/gpt-4.1", "messages": []}),
            1,
            "chat/completions",
        )
        .unwrap()
        .unwrap();
        assert_eq!(openai_direct["model"], "gpt-4.1");

        let xai_body = json!({
            "model": "xai/grok-3-mini-high",
            "messages": [],
            "max_tokens": 64
        });
        let xai_direct =
            prepare_same_channel_direct_body(&xai_body, CHANNEL_TYPE_XAI, "chat/completions")
                .unwrap()
                .unwrap();
        assert_eq!(xai_direct["model"], "grok-3-mini");
        assert_eq!(xai_direct["reasoning_effort"], "high");
        assert_eq!(xai_direct["max_completion_tokens"], 64);
        assert!(xai_direct.get("max_tokens").is_none());

        assert!(prepare_same_channel_direct_body(
            &mistral_body,
            CHANNEL_TYPE_XAI,
            "chat/completions"
        )
        .is_err());
        assert!(prepare_same_channel_direct_body(
            &json!({"model": "mistral-large-latest", "messages": []}),
            CHANNEL_TYPE_MISTRAL,
            "chat/completions"
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn relay_model_fallback_config_is_explicit_bounded_and_case_insensitive() {
        assert_eq!(
            RelayModelFallbackConfig::from_values(
                false,
                Some(r#"{"gpt-4.1":"claude-sonnet-4"}"#.to_string())
            )
            .unwrap(),
            None
        );
        assert!(RelayModelFallbackConfig::from_values(true, None).is_err());
        assert!(RelayModelFallbackConfig::from_values(true, Some("{}".to_string())).is_err());
        assert!(RelayModelFallbackConfig::from_values(
            true,
            Some(r#"{"gpt-4.1":"GPT-4.1"}"#.to_string())
        )
        .is_err());
        assert!(RelayModelFallbackConfig::from_values(
            true,
            Some(r#"{"gpt-4.1":"claude-sonnet-4"}"#.to_string())
        )
        .is_err());

        let config = RelayModelFallbackConfig::from_values(
            true,
            Some(r#"{"OpenAI/GPT-4.1":"anthropic/claude-sonnet-4"}"#.to_string()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            config.fallback_for("openai/gpt-4.1"),
            Some("anthropic/claude-sonnet-4")
        );
    }

    #[test]
    fn relay_model_fallback_requires_compatible_route_and_server_failure() {
        let mut endpoint = ai_gateway_chat_endpoint_for_tests();
        assert!(relay_model_fallback_supported(&endpoint));
        endpoint.upstream_path = "responses".to_string();
        assert!(relay_model_fallback_supported(&endpoint));
        endpoint.upstream_path = "embeddings".to_string();
        assert!(!relay_model_fallback_supported(&endpoint));

        for status in [500, 503, 505, 523, 525, 599] {
            assert!(should_model_fallback_status(status));
        }
        for status in [400, 401, 403, 408, 429, 504, 524] {
            assert!(!should_model_fallback_status(status));
        }
    }

    #[test]
    fn relay_model_fallback_body_replaces_primary_before_channel_mapping() {
        let mut unmapped = json!({
            "model": "openai/gpt-4.1",
            "messages": [{"role": "user", "content": "hello"}]
        });
        apply_model_attempt_body(&mut unmapped, "anthropic/claude-sonnet-4", None);
        assert_eq!(unmapped["model"], "anthropic/claude-sonnet-4");

        let mut mapped = json!({"model": "openai/gpt-4.1", "messages": []});
        apply_model_attempt_body(
            &mut mapped,
            "anthropic/claude-sonnet-4",
            Some(r#"{"anthropic/claude-sonnet-4":"anthropic/claude-sonnet-4-20250514"}"#),
        );
        assert_eq!(mapped["model"], "anthropic/claude-sonnet-4-20250514");
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
    fn plan_auto_stays_in_first_nonempty_group_when_cross_group_is_disabled() {
        let pools = vec![
            ("g0".to_string(), vec![test_channel(1, 0, 1)]),
            ("g1".to_string(), vec![test_channel(2, 0, 1)]),
        ];
        let plan = plan_relay_attempts(pools, true, 1, 0, false, |_| Ok(0)).unwrap();
        let trace = plan
            .iter()
            .map(|attempt| (attempt.group.as_str(), attempt.channel.id))
            .collect::<Vec<_>>();

        assert_eq!(trace, vec![("g0", 1)]);
    }

    #[test]
    fn unique_group_count_ignores_retry_duplicates() {
        assert_eq!(
            unique_group_count(&[
                "default".to_string(),
                "default".to_string(),
                "vip".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn wfp_relay_transport_accepts_only_cloudflare_ai_rest_routes() {
        assert!(relay_wfp_authority_transport_contract_compiled());
        for path in WFP_RELAY_SUPPORTED_PATHS {
            let url = format!("https://upstream.invalid{path}");
            assert_eq!(wfp_relay_path(&url).unwrap(), *path);
        }
        assert!(wfp_relay_path("https://upstream.invalid/v1/responses?trace=1").is_err());
        assert!(wfp_relay_path("https://upstream.invalid/v1/embeddings").is_err());
        assert!(wfp_relay_path("https://upstream.invalid/v1/audio/transcriptions").is_err());
    }

    #[test]
    fn wfp_relay_transport_rejects_raw_body_attempts() {
        let mut channel = test_channel(1, 0, 1);
        assert!(ensure_wfp_json_body(&channel).is_ok());
        channel.other_info = r#"{"wfp_worker":"tenant-a"}"#.to_string();
        assert!(ensure_wfp_json_body(&channel)
            .unwrap_err()
            .to_string()
            .contains("JSON request bodies only"));
    }

    #[test]
    fn wfp_relay_transport_internal_response_header_set_is_explicit() {
        assert_eq!(
            WFP_INTERNAL_RESPONSE_HEADERS,
            [
                "x-cinatoken-wfp-route",
                "x-cinatoken-wfp-worker",
                "x-cinatoken-wfp-tenant",
                "x-cinatoken-wfp-runtime",
            ]
        );
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

        let outcome = tiered_billing_settlement(&preflight, &usage, &request).unwrap();
        assert_eq!(outcome.result.actual_expression_cost, 8_300.0);
        assert_eq!(outcome.final_quota, 4_150);
    }

    #[test]
    fn tiered_group_plan_reserves_max_and_settles_selected_group() {
        let request_body = json!({
            "prompt": "word ".repeat(1_000),
            "max_completion_tokens": 2_000
        });
        let request = RequestInput::from_json_body(request_body.clone());
        let base = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"tier("base", p * 2 + c * 10)"#,
            1.0,
            &request_body,
            request.clone(),
            true,
            0,
        )
        .unwrap();
        let groups = vec!["default".to_string(), "vip".to_string()];
        let ratios = HashMap::from([("default".to_string(), 1.0), ("vip".to_string(), 2.0)]);
        let mut plan =
            tiered_billing_group_plan_from_base(base.snapshot, &groups, &ratios).unwrap();
        plan.reserve_applied = true;

        assert_eq!(
            plan.reserved_quota,
            plan.snapshots["vip"].estimated_quota_after_group.0
        );
        let selected = plan.selected_preflight("default").unwrap();
        assert_eq!(selected.selected_group, "default");
        assert_eq!(selected.candidate_group_count, 2);
        assert_eq!(
            selected.reservation_strategy,
            TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY
        );
        assert_eq!(selected.pre_consumed_quota, plan.reserved_quota);

        let outcome = tiered_billing_settlement(
            &selected,
            &UsageSummary {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                ..UsageSummary::default()
            },
            &request,
        )
        .unwrap();
        assert_eq!(outcome.final_quota, 350);
        assert_eq!(
            outcome.result.settlement.refund_quota.0,
            plan.reserved_quota - outcome.final_quota
        );
    }

    #[test]
    fn actual_serving_group_billing_contract_is_compiled() {
        assert!(relay_actual_serving_group_billing_contract_compiled());
    }

    #[test]
    fn flat_billing_never_runs_after_tiered_preflight() {
        assert!(!should_apply_flat_billing(true, false, 200, true));
        assert!(should_apply_flat_billing(false, false, 200, true));
        assert!(!should_apply_flat_billing(false, true, 200, true));
        assert!(!should_apply_flat_billing(false, false, 500, true));
        assert!(!should_apply_flat_billing(false, false, 200, false));
    }

    #[test]
    fn usage_less_image_success_is_billable_by_request_contract() {
        let usage = UsageSummary::default();
        assert!(!usage_summary_is_present(&usage, false));
        assert!(!usage_summary_is_present(&usage, true));
        assert!(usage_less_request_contract_applies(
            "images/generations",
            false
        ));
        assert!(!usage_less_request_contract_applies(
            "images/generations",
            true
        ));
        assert!(!usage_less_request_contract_applies(
            "chat/completions",
            false
        ));
    }

    #[test]
    fn flat_billing_audit_marks_successfully_applied_quota_resolved() {
        let config = PricingConfig::new();
        let result = compute_flat_quota(
            &FlatUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                ..FlatUsage::default()
            },
            "gpt-4o",
            "default",
            &config,
        );
        let mut other = json!({ "billing_pending": true });

        apply_flat_billing_audit(&mut other, &result);

        assert_eq!(other["billing_pending"], false);
        assert_eq!(other["flat_billing"]["quota"], result.quota);
        assert_eq!(other["flat_billing"]["mode"], "per_token");
    }

    #[test]
    fn image_fixed_price_multiplier_uses_provider_effective_count() {
        let siliconflow = json!({"n": 2, "batch_size": 4});
        assert_eq!(
            fixed_price_request_multiplier(
                "images/generations",
                CHANNEL_TYPE_SILICONFLOW,
                Some(&siliconflow)
            ),
            4.0
        );
        assert_eq!(
            fixed_price_request_multiplier(
                "images/generations",
                CHANNEL_TYPE_XAI,
                Some(&siliconflow)
            ),
            2.0
        );
        assert_eq!(
            fixed_price_request_multiplier(
                "chat/completions",
                CHANNEL_TYPE_SILICONFLOW,
                Some(&siliconflow)
            ),
            1.0
        );
        assert_eq!(
            fixed_price_request_multiplier(
                "images/generations",
                CHANNEL_TYPE_SILICONFLOW,
                Some(&json!({"batch_size": 0}))
            ),
            1.0
        );
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
        let mut preflight = tiered_billing_preflight_snapshot(
            "gpt-test",
            r#"param("service_tier") == "fast" ? tier("fast", p * 4 + c * 20) : tier("normal", p * 2 + c * 10)"#,
            1.5,
            &request_body,
            request.clone(),
            true,
            0,
        )
        .unwrap();
        preflight.selected_group = "vip".to_string();
        preflight.candidate_group_count = 2;
        preflight.reservation_strategy = TIERED_BILLING_MAX_CANDIDATE_GROUP_STRATEGY;
        let outcome = tiered_billing_settlement(
            &preflight,
            &UsageSummary {
                prompt_tokens: 1_000,
                completion_tokens: 500,
                total_tokens: 1_500,
                ..UsageSummary::default()
            },
            &request,
        )
        .unwrap();
        let metadata =
            tiered_billing_metadata(&preflight, outcome.snapshot, outcome.result, true, false);

        assert_eq!(metadata["billing_mode"], "tiered_expr");
        assert_eq!(metadata["shadow_only"], true);
        assert_eq!(metadata["applied"], false);
        assert_eq!(metadata["expr_hash"].as_str().unwrap().len(), 64);
        assert_eq!(metadata["has_request_rule"], false);
        assert_eq!(metadata["selected_group"], "vip");
        assert_eq!(metadata["candidate_group_count"], 2);
        assert_eq!(metadata["reservation_strategy"], "max_candidate_group");
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
            &preflight,
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
            "chat/completions",
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
        let (r, est) = resolve_stream_usage(
            UsageSummary::default(),
            "x",
            1,
            "chat/completions",
            "gpt-4o",
            100,
            false,
        );
        assert!(!est);
        assert_eq!(r, UsageSummary::default());
        // Enabled but usage already valid (prompt != 0) -> no-op.
        let (r2, est2) =
            resolve_stream_usage(valid, "x", 1, "chat/completions", "gpt-4o", 100, true);
        assert!(!est2);
        assert_eq!(r2, valid);
    }

    #[test]
    fn resolve_stream_usage_keeps_empty_responses_usage_at_zero() {
        for endpoint in ["responses", "responses/compact"] {
            let (resolved, estimated) = resolve_stream_usage(
                UsageSummary::default(),
                "",
                0,
                endpoint,
                "gpt-4o",
                100,
                true,
            );
            assert!(!estimated, "unexpected estimate for {endpoint}");
            assert_eq!(resolved, UsageSummary::default());
        }
    }

    #[test]
    fn resolve_stream_usage_estimates_responses_only_after_output() {
        let (resolved, estimated) = resolve_stream_usage(
            UsageSummary::default(),
            "hi",
            0,
            "responses",
            "gpt-4o",
            100,
            true,
        );
        assert!(estimated);
        assert_eq!(resolved.prompt_tokens, 100);
        assert!(resolved.completion_tokens > 0);
        assert_eq!(
            resolved.total_tokens,
            resolved.prompt_tokens + resolved.completion_tokens
        );
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
