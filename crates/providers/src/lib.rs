use async_trait::async_trait;
use cinatoken_core::ApiResult;
use cinatoken_relay::RelayContext;

pub mod ai_gateway;
pub mod routing;

pub use routing::{
    ProviderEndpoint, ProviderKind, ProviderRegistry, ProviderRoute, ProviderRouteError,
};

#[async_trait(?Send)]
pub trait ProviderAdapter {
    fn kind(&self) -> ProviderKind;
    fn default_base_url(&self) -> &'static str;
    async fn validate(&self, ctx: &RelayContext) -> ApiResult<()>;
}
