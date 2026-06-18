use async_trait::async_trait;
use cinatoken_core::ApiResult;
use cinatoken_relay::RelayContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
    CloudflareWorkersAi,
    AiGateway,
}

#[async_trait(?Send)]
pub trait ProviderAdapter {
    fn kind(&self) -> ProviderKind;
    fn default_base_url(&self) -> &'static str;
    async fn validate(&self, ctx: &RelayContext) -> ApiResult<()>;
}
