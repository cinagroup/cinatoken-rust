use async_trait::async_trait;
use cinatoken_core::{ApiResult, ChatCompletionRequest};

pub mod cache;
pub mod openai_compatible;
pub use cache::{
    scoped_key, token_fingerprint, CachedAuthenticatedToken, CachedRelayChannel, RelayCacheKeys,
    RELAY_CACHE_SCHEMA_VERSION,
};
pub use openai_compatible::{
    apply_model_mapping, channel_type_supported, clamp_i64_to_i32, csv_contains, first_channel_key,
    ip_allowlist_matches, is_anthropic_channel_type, is_openai_compatible_channel_type,
    upstream_anthropic_messages_url, upstream_chat_url, upstream_v1_url,
    usage_summary_from_anthropic_body, usage_summary_from_anthropic_sse_stream,
    usage_summary_from_body, usage_summary_from_sse_stream, SseUsageAccumulator, UsageSummary,
    ANTHROPIC_CHANNEL_TYPES, CHANNEL_TYPE_ANTHROPIC, OPENAI_COMPATIBLE_CHANNEL_TYPES,
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
