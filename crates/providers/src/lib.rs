use async_trait::async_trait;
use cinatoken_core::ApiResult;
use cinatoken_relay::RelayContext;

pub mod ai_gateway;
pub mod channel_capabilities;
pub mod deepseek;
pub mod mistral;
pub mod moonshot;
pub mod perplexity;
pub mod routing;
pub mod siliconflow;
pub mod submodel;
pub mod xai;

pub use channel_capabilities::{
    channel_capabilities, channel_capability, channel_supports_relay_route,
    channel_types_for_relay_route, ChannelAdapterKind, ChannelRelayCapability,
    ChannelRelayReadiness, ProviderRelayRoute,
};
pub use routing::{
    ProviderEndpoint, ProviderKind, ProviderRegistry, ProviderRoute, ProviderRouteError,
};

#[async_trait(?Send)]
pub trait ProviderAdapter {
    fn kind(&self) -> ProviderKind;
    fn default_base_url(&self) -> &'static str;
    async fn validate(&self, ctx: &RelayContext) -> ApiResult<()>;
}
