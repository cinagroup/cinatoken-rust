use std::fmt;

use cinatoken_relay::{
    upstream_anthropic_messages_url, upstream_gemini_native_url, upstream_v1_url, GeminiNativePath,
};

use crate::ai_gateway::AiGatewayRouteKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAiCompatible,
    AnthropicMessages,
    DeepSeekOpenAi,
    DeepSeekMessages,
    GeminiNative,
    CloudflareWorkersAi,
    AiGateway,
}

impl ProviderKind {
    pub fn ai_gateway_route(self) -> Option<AiGatewayRouteKind> {
        match self {
            Self::OpenAiCompatible => Some(AiGatewayRouteKind::Compat),
            Self::AnthropicMessages => Some(AiGatewayRouteKind::Anthropic),
            Self::DeepSeekOpenAi => Some(AiGatewayRouteKind::Compat),
            Self::DeepSeekMessages => Some(AiGatewayRouteKind::Anthropic),
            Self::GeminiNative => Some(AiGatewayRouteKind::GoogleAiStudio),
            Self::CloudflareWorkersAi => Some(AiGatewayRouteKind::WorkersAi),
            Self::AiGateway => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderEndpoint<'a> {
    pub provider: ProviderKind,
    pub channel_type: i32,
    pub base_url: Option<&'a str>,
    pub endpoint_path: &'a str,
    pub upstream_query: Option<&'a str>,
    pub gemini_route: Option<&'a GeminiNativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRoute {
    pub provider: ProviderKind,
    pub upstream_url: String,
    pub ai_gateway_route: Option<AiGatewayRouteKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderRouteError {
    MissingGeminiRoute,
    BindingOnlyProvider,
    AiGatewayRequiresExplicitConfig,
    UnsupportedProviderRoute,
}

impl fmt::Display for ProviderRouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingGeminiRoute => write!(f, "Gemini native routing requires a parsed route"),
            Self::BindingOnlyProvider => {
                write!(
                    f,
                    "provider is executed through a platform binding, not an HTTP URL"
                )
            }
            Self::AiGatewayRequiresExplicitConfig => {
                write!(
                    f,
                    "AI Gateway routing requires explicit account and gateway config"
                )
            }
            Self::UnsupportedProviderRoute => write!(f, "provider does not support this route"),
        }
    }
}

impl std::error::Error for ProviderRouteError {}

#[derive(Debug, Default, Clone, Copy)]
pub struct ProviderRegistry;

impl ProviderRegistry {
    pub fn resolve(endpoint: ProviderEndpoint<'_>) -> Result<ProviderRoute, ProviderRouteError> {
        let upstream_url = match endpoint.provider {
            ProviderKind::OpenAiCompatible => upstream_v1_url(
                endpoint.channel_type,
                endpoint.base_url,
                endpoint.endpoint_path,
            ),
            ProviderKind::AnthropicMessages => upstream_anthropic_messages_url(endpoint.base_url),
            ProviderKind::DeepSeekOpenAi => {
                crate::deepseek::deepseek_openai_url(endpoint.base_url, endpoint.endpoint_path)
                    .ok_or(ProviderRouteError::UnsupportedProviderRoute)?
            }
            ProviderKind::DeepSeekMessages => {
                crate::deepseek::deepseek_messages_url(endpoint.base_url)
            }
            ProviderKind::GeminiNative => upstream_gemini_native_url(
                endpoint.base_url,
                endpoint
                    .gemini_route
                    .ok_or(ProviderRouteError::MissingGeminiRoute)?,
                endpoint.upstream_query,
            ),
            ProviderKind::CloudflareWorkersAi => {
                return Err(ProviderRouteError::BindingOnlyProvider)
            }
            ProviderKind::AiGateway => {
                return Err(ProviderRouteError::AiGatewayRequiresExplicitConfig)
            }
        };

        Ok(ProviderRoute {
            provider: endpoint.provider,
            upstream_url,
            ai_gateway_route: endpoint.provider.ai_gateway_route(),
        })
    }
}

#[cfg(test)]
mod tests {
    use cinatoken_relay::{
        openai_compatible::CHANNEL_TYPE_CLOUDFLARE, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_GEMINI,
    };

    use super::*;

    #[test]
    fn registry_preserves_openai_compatible_url_semantics() {
        let route = ProviderRegistry::resolve(ProviderEndpoint {
            provider: ProviderKind::OpenAiCompatible,
            channel_type: CHANNEL_TYPE_COHERE,
            base_url: None,
            endpoint_path: "rerank",
            upstream_query: None,
            gemini_route: None,
        })
        .unwrap();

        assert_eq!(route.upstream_url, "https://api.cohere.ai/v1/rerank");
        assert_eq!(route.ai_gateway_route, Some(AiGatewayRouteKind::Compat));
    }

    #[test]
    fn registry_preserves_workers_ai_gateway_base_url_when_configured() {
        let route = ProviderRegistry::resolve(ProviderEndpoint {
            provider: ProviderKind::OpenAiCompatible,
            channel_type: CHANNEL_TYPE_CLOUDFLARE,
            base_url: Some("https://gateway.ai.cloudflare.com/v1/acct123/default/workers-ai/v1"),
            endpoint_path: "chat/completions",
            upstream_query: None,
            gemini_route: None,
        })
        .unwrap();

        assert_eq!(
            route.upstream_url,
            "https://gateway.ai.cloudflare.com/v1/acct123/default/workers-ai/v1/chat/completions"
        );
        assert_eq!(route.ai_gateway_route, Some(AiGatewayRouteKind::Compat));
    }

    #[test]
    fn registry_resolves_anthropic_messages() {
        let route = ProviderRegistry::resolve(ProviderEndpoint {
            provider: ProviderKind::AnthropicMessages,
            channel_type: 0,
            base_url: Some("https://anthropic.example/v1"),
            endpoint_path: "messages",
            upstream_query: None,
            gemini_route: None,
        })
        .unwrap();

        assert_eq!(route.upstream_url, "https://anthropic.example/v1/messages");
        assert_eq!(route.ai_gateway_route, Some(AiGatewayRouteKind::Anthropic));
    }

    #[test]
    fn registry_resolves_gemini_native_with_query() {
        let gemini_route = GeminiNativePath {
            api_version: "v1beta".to_string(),
            model: "gemini-test".to_string(),
            action: "streamGenerateContent".to_string(),
        };

        let route = ProviderRegistry::resolve(ProviderEndpoint {
            provider: ProviderKind::GeminiNative,
            channel_type: CHANNEL_TYPE_GEMINI,
            base_url: None,
            endpoint_path: "ignored",
            upstream_query: Some("key=client-secret&alt=sse"),
            gemini_route: Some(&gemini_route),
        })
        .unwrap();

        assert_eq!(
            route.upstream_url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            route.ai_gateway_route,
            Some(AiGatewayRouteKind::GoogleAiStudio)
        );
    }

    #[test]
    fn registry_rejects_binding_only_and_unconfigured_gateway_routes() {
        assert_eq!(
            ProviderRegistry::resolve(ProviderEndpoint {
                provider: ProviderKind::CloudflareWorkersAi,
                channel_type: CHANNEL_TYPE_CLOUDFLARE,
                base_url: None,
                endpoint_path: "chat/completions",
                upstream_query: None,
                gemini_route: None,
            })
            .unwrap_err(),
            ProviderRouteError::BindingOnlyProvider
        );

        assert_eq!(
            ProviderRegistry::resolve(ProviderEndpoint {
                provider: ProviderKind::AiGateway,
                channel_type: 0,
                base_url: None,
                endpoint_path: "chat/completions",
                upstream_query: None,
                gemini_route: None,
            })
            .unwrap_err(),
            ProviderRouteError::AiGatewayRequiresExplicitConfig
        );
    }
}
