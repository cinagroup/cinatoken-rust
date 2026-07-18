use async_trait::async_trait;
use cinatoken_core::{ApiResult, ChatCompletionRequest};

pub mod cache;
pub mod multipart;
pub mod openai_compatible;
pub mod provider_response;
pub mod retry;
pub mod usage_receipt;

pub use cache::{
    scoped_key, token_fingerprint, CachedAuthenticatedToken, CachedRelayChannel, RelayCacheKeys,
    RELAY_CACHE_SCHEMA_VERSION,
};
pub use multipart::{
    extract_multipart_field, extract_multipart_file, extract_multipart_files,
    extract_multipart_files_bounded, extract_multipart_files_with_prefix,
    extract_multipart_files_with_prefix_bounded, MultipartFile, MultipartFilesError,
};
pub use openai_compatible::{
    apply_gemini_native_model_mapping, apply_model_mapping, channel_type_supported,
    clamp_i64_to_i32, csv_contains, first_channel_key, gemini_response_completion_text,
    ip_allowlist_matches, is_anthropic_channel_type, is_gemini_channel_type,
    is_openai_compatible_channel_type, is_rerank_channel_type, mapped_model_name,
    openai_response_completion_text, parse_gemini_native_path, upstream_anthropic_messages_url,
    upstream_chat_url, upstream_gemini_native_url, upstream_v1_url,
    usage_summary_from_anthropic_body, usage_summary_from_anthropic_sse_stream,
    usage_summary_from_body, usage_summary_from_body_with_cache_policy,
    usage_summary_from_gemini_body, usage_summary_from_gemini_sse_stream,
    usage_summary_from_moonshot_body, usage_summary_from_moonshot_sse_stream,
    usage_summary_from_rerank_body, usage_summary_from_sse_stream, GeminiNativePath,
    ImageGenerationQuality, ImageGenerationSize, ImageGenerationToolUsage, SseUsageAccumulator,
    ToolUsageSummary, UsageCacheFieldPolicy, UsageSummary, ANTHROPIC_CHANNEL_TYPES,
    CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_COHERE,
    CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_JINA, CHANNEL_TYPE_MISTRAL,
    CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER, CHANNEL_TYPE_PERPLEXITY,
    CHANNEL_TYPE_SILICONFLOW, CHANNEL_TYPE_SUBMODEL, CHANNEL_TYPE_TENCENT, CHANNEL_TYPE_VOLCENGINE,
    CHANNEL_TYPE_XAI, CHANNEL_TYPE_ZHIPU_V4, GEMINI_CHANNEL_TYPES, OPENAI_COMPATIBLE_CHANNEL_TYPES,
    RERANK_CHANNEL_TYPES,
};
pub use provider_response::{
    first_safe_provider_request_id, interpret_buffered_provider_response,
    should_forward_public_response_header, valid_provider_request_id, BufferedProviderResponse,
    OpenAiCompatibleError, OpenAiCompatibleErrorEnvelope, ProviderResponseClass,
    ProviderResponseProfile, MAX_PROVIDER_REQUEST_ID_BYTES, PROVIDER_RESPONSE_INTERPRETER_CONTRACT,
    PUBLIC_SUCCESS_RESPONSE_HEADERS,
};
pub use retry::{
    is_auto_disable_status, is_retryable_status, parse_retry_times_env, RetryConfig,
    DEFAULT_RETRY_TIMES,
};
pub use usage_receipt::{
    ProviderUsageReceiptError, ProviderUsageReceiptInput, ProviderUsageReceiptV1,
    MAX_PROVIDER_USAGE_RECEIPT_ENCODED_BYTES, MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES,
    PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE, PROVIDER_USAGE_RECEIPT_NORMALIZATION_CONTRACT,
    PROVIDER_USAGE_RECEIPT_PARSER_CONTRACT, PROVIDER_USAGE_RECEIPT_SCHEMA_VERSION,
    PROVIDER_USAGE_RECEIPT_SOURCE, REPORTED_USAGE_AUDIO_INPUT_TOKENS,
    REPORTED_USAGE_AUDIO_OUTPUT_TOKENS, REPORTED_USAGE_CACHED_TOKENS,
    REPORTED_USAGE_CACHE_CREATION_TOKENS, REPORTED_USAGE_CACHE_CREATION_TOKENS_1H,
    REPORTED_USAGE_CACHE_CREATION_TOKENS_5M, REPORTED_USAGE_COMPLETION_TOKENS,
    REPORTED_USAGE_FIELDS_ALL, REPORTED_USAGE_IMAGE_INPUT_TOKENS,
    REPORTED_USAGE_IMAGE_OUTPUT_TOKENS, REPORTED_USAGE_PROMPT_TOKENS, REPORTED_USAGE_TOTAL_TOKENS,
};

#[derive(Debug, Clone)]
pub struct RelayContext {
    pub request_id: String,
    pub user_id: Option<i64>,
    pub token_id: Option<i64>,
    pub model: String,
}

impl RelayContext {
    pub fn from_chat_request(
        request_id: impl Into<String>,
        request: &ChatCompletionRequest,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            user_id: None,
            token_id: None,
            model: request.model.clone(),
        }
    }
}

#[async_trait(?Send)]
pub trait RelayPipeline {
    type Response;

    async fn chat_completions(
        &self,
        ctx: RelayContext,
        request: ChatCompletionRequest,
    ) -> ApiResult<Self::Response>;
}
