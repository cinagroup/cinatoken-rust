use std::fmt;

use crate::routing::ProviderKind;

const PROVIDER_GATEWAY_HOST: &str = "https://gateway.ai.cloudflare.com/v1";
const REST_GATEWAY_HOST: &str = "https://api.cloudflare.com/client/v4/accounts";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayRouteKind {
    Compat,
    Anthropic,
    GoogleAiStudio,
    WorkersAi,
}

impl AiGatewayRouteKind {
    pub fn provider_segment(self) -> &'static str {
        match self {
            Self::Compat => "compat",
            Self::Anthropic => "anthropic",
            Self::GoogleAiStudio => "google-ai-studio",
            Self::WorkersAi => "workers-ai",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayRestEndpoint {
    ChatCompletions,
    Responses,
    Messages,
    Run,
}

impl AiGatewayRestEndpoint {
    pub fn path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat/completions",
            Self::Responses => "responses",
            Self::Messages => "messages",
            Self::Run => "run",
        }
    }

    pub fn relay_path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat/completions",
            Self::Responses => "responses",
            Self::Messages => "messages",
            Self::Run => "ai/run",
        }
    }

    pub fn rest_api_path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "v1/chat/completions",
            Self::Responses => "v1/responses",
            Self::Messages => "v1/messages",
            Self::Run => "run",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiGatewayRestRoutePlan {
    pub provider: ProviderKind,
    pub relay_path: &'static str,
    pub rest_endpoint: AiGatewayRestEndpoint,
}

pub const MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS: &[AiGatewayRestRoutePlan] = &[
    AiGatewayRestRoutePlan {
        provider: ProviderKind::OpenAiCompatible,
        relay_path: "chat/completions",
        rest_endpoint: AiGatewayRestEndpoint::ChatCompletions,
    },
    AiGatewayRestRoutePlan {
        provider: ProviderKind::OpenAiCompatible,
        relay_path: "responses",
        rest_endpoint: AiGatewayRestEndpoint::Responses,
    },
    AiGatewayRestRoutePlan {
        provider: ProviderKind::AnthropicMessages,
        relay_path: "messages",
        rest_endpoint: AiGatewayRestEndpoint::Messages,
    },
];

pub const MAIN_RELAY_AI_GATEWAY_CUTOVER_GUARDS: &[&str] = &[
    "router_ready",
    "channel_opted_in",
    "supported_rest_endpoint",
    "prefixed_ai_gateway_model",
    "endpoint_model_schema_match",
    "custom_base_url_security_coupled",
    "direct_provider_fallback",
    "billing_settlement_invariant",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayRestPlanError {
    UnsupportedProvider,
    UnsupportedEndpointPath,
}

impl fmt::Display for AiGatewayRestPlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProvider => write!(
                f,
                "provider is not supported by the main relay AI Gateway REST planner"
            ),
            Self::UnsupportedEndpointPath => write!(
                f,
                "endpoint path is not supported by the main relay AI Gateway REST planner"
            ),
        }
    }
}

impl std::error::Error for AiGatewayRestPlanError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayModelAuthor {
    OpenAi,
    Anthropic,
    Google,
    Xai,
    WorkersAi,
    Unknown,
}

impl AiGatewayModelAuthor {
    pub fn requires_gateway_id_header(self) -> bool {
        self == Self::WorkersAi
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiGatewayCutoverInput<'a> {
    pub router_ready: bool,
    pub channel_opted_in: bool,
    pub provider: ProviderKind,
    pub relay_path: &'a str,
    pub model: &'a str,
    pub channel_has_custom_base_url: bool,
    pub is_user_credential: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiGatewayCutoverPlan {
    pub endpoint: AiGatewayRestEndpoint,
    pub model_author: AiGatewayModelAuthor,
    pub requires_gateway_id_header: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayCutoverDecision {
    UseGateway(AiGatewayCutoverPlan),
    UseDirect { reason: AiGatewayCutoverBlockReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiGatewayCutoverBlockReason {
    RouterNotReady,
    ChannelNotOptedIn,
    UnsupportedProvider,
    UnsupportedEndpointPath,
    MissingProviderPrefix,
    ModelEndpointSchemaMismatch,
    CustomBaseUrlWithoutUserCredential,
    UserBaseUrlOverrideRequiresDirect,
}

impl AiGatewayCutoverBlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RouterNotReady => "router_not_ready",
            Self::ChannelNotOptedIn => "channel_not_opted_in",
            Self::UnsupportedProvider => "unsupported_provider",
            Self::UnsupportedEndpointPath => "unsupported_endpoint_path",
            Self::MissingProviderPrefix => "missing_provider_prefix",
            Self::ModelEndpointSchemaMismatch => "model_endpoint_schema_mismatch",
            Self::CustomBaseUrlWithoutUserCredential => "custom_base_url_without_user_credential",
            Self::UserBaseUrlOverrideRequiresDirect => "user_base_url_override_requires_direct",
        }
    }
}

pub fn plan_ai_gateway_cutover(input: AiGatewayCutoverInput<'_>) -> AiGatewayCutoverDecision {
    if !input.router_ready {
        return AiGatewayCutoverDecision::UseDirect {
            reason: AiGatewayCutoverBlockReason::RouterNotReady,
        };
    }

    if !input.channel_opted_in {
        return AiGatewayCutoverDecision::UseDirect {
            reason: AiGatewayCutoverBlockReason::ChannelNotOptedIn,
        };
    }

    if input.channel_has_custom_base_url {
        let reason = if input.is_user_credential {
            AiGatewayCutoverBlockReason::UserBaseUrlOverrideRequiresDirect
        } else {
            AiGatewayCutoverBlockReason::CustomBaseUrlWithoutUserCredential
        };
        return AiGatewayCutoverDecision::UseDirect { reason };
    }

    let endpoint = match rest_endpoint_for_relay_route(input.provider, input.relay_path) {
        Ok(endpoint) => endpoint,
        Err(AiGatewayRestPlanError::UnsupportedProvider) => {
            return AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::UnsupportedProvider,
            }
        }
        Err(AiGatewayRestPlanError::UnsupportedEndpointPath) => {
            return AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::UnsupportedEndpointPath,
            }
        }
    };

    let model_author = classify_ai_gateway_model_author(input.model);
    if model_author == AiGatewayModelAuthor::Unknown {
        return AiGatewayCutoverDecision::UseDirect {
            reason: AiGatewayCutoverBlockReason::MissingProviderPrefix,
        };
    }

    if endpoint == AiGatewayRestEndpoint::Messages
        && model_author == AiGatewayModelAuthor::WorkersAi
    {
        return AiGatewayCutoverDecision::UseDirect {
            reason: AiGatewayCutoverBlockReason::ModelEndpointSchemaMismatch,
        };
    }

    AiGatewayCutoverDecision::UseGateway(AiGatewayCutoverPlan {
        endpoint,
        model_author,
        requires_gateway_id_header: model_author.requires_gateway_id_header(),
    })
}

pub fn rest_endpoint_for_relay_route(
    provider: ProviderKind,
    relay_path: &str,
) -> Result<AiGatewayRestEndpoint, AiGatewayRestPlanError> {
    let relay_path = normalize_relay_path(relay_path);

    if provider == ProviderKind::CloudflareWorkersAi && relay_path == "ai/run" {
        return Ok(AiGatewayRestEndpoint::Run);
    }

    MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS
        .iter()
        .find(|plan| plan.provider == provider && plan.relay_path == relay_path)
        .map(|plan| plan.rest_endpoint)
        .ok_or_else(|| {
            if matches!(
                provider,
                ProviderKind::OpenAiCompatible | ProviderKind::AnthropicMessages
            ) {
                AiGatewayRestPlanError::UnsupportedEndpointPath
            } else {
                AiGatewayRestPlanError::UnsupportedProvider
            }
        })
}

pub fn classify_ai_gateway_model_author(model: &str) -> AiGatewayModelAuthor {
    let model = model.trim().to_ascii_lowercase();
    if model.starts_with("openai/") {
        AiGatewayModelAuthor::OpenAi
    } else if model.starts_with("anthropic/") {
        AiGatewayModelAuthor::Anthropic
    } else if model.starts_with("google/") {
        AiGatewayModelAuthor::Google
    } else if model.starts_with("xai/") {
        AiGatewayModelAuthor::Xai
    } else if model.starts_with("@cf/") || model.starts_with("cloudflare/") {
        AiGatewayModelAuthor::WorkersAi
    } else {
        AiGatewayModelAuthor::Unknown
    }
}

pub fn has_ai_gateway_provider_prefix(model: &str) -> bool {
    classify_ai_gateway_model_author(model) != AiGatewayModelAuthor::Unknown
}

fn normalize_relay_path(value: &str) -> String {
    value.trim().trim_start_matches('/').to_ascii_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiGatewayRouteError {
    InvalidAccountId,
    InvalidGatewayId,
    InvalidEndpointPath,
}

impl fmt::Display for AiGatewayRouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAccountId => write!(f, "invalid Cloudflare account id"),
            Self::InvalidGatewayId => write!(f, "invalid AI Gateway id"),
            Self::InvalidEndpointPath => write!(f, "invalid AI Gateway endpoint path"),
        }
    }
}

impl std::error::Error for AiGatewayRouteError {}

pub fn provider_gateway_url(
    account_id: &str,
    gateway_id: &str,
    route: AiGatewayRouteKind,
    endpoint_path: &str,
    query: Option<&str>,
) -> Result<String, AiGatewayRouteError> {
    let account_id =
        validate_path_segment(account_id).ok_or(AiGatewayRouteError::InvalidAccountId)?;
    let gateway_id =
        validate_path_segment(gateway_id).ok_or(AiGatewayRouteError::InvalidGatewayId)?;
    let endpoint_path =
        validate_endpoint_path(endpoint_path).ok_or(AiGatewayRouteError::InvalidEndpointPath)?;
    Ok(append_query(
        format!(
            "{PROVIDER_GATEWAY_HOST}/{account_id}/{gateway_id}/{}/{}",
            route.provider_segment(),
            endpoint_path
        ),
        query,
    ))
}

pub fn rest_gateway_url(
    account_id: &str,
    endpoint_path: &str,
    query: Option<&str>,
) -> Result<String, AiGatewayRouteError> {
    let account_id =
        validate_path_segment(account_id).ok_or(AiGatewayRouteError::InvalidAccountId)?;
    let endpoint_path =
        validate_endpoint_path(endpoint_path).ok_or(AiGatewayRouteError::InvalidEndpointPath)?;
    Ok(append_query(
        format!("{REST_GATEWAY_HOST}/{account_id}/ai/v1/{endpoint_path}"),
        query,
    ))
}

pub fn rest_gateway_endpoint_url(
    account_id: &str,
    endpoint: AiGatewayRestEndpoint,
    query: Option<&str>,
) -> Result<String, AiGatewayRouteError> {
    let account_id =
        validate_path_segment(account_id).ok_or(AiGatewayRouteError::InvalidAccountId)?;
    Ok(append_query(
        format!(
            "{REST_GATEWAY_HOST}/{account_id}/ai/{}",
            endpoint.rest_api_path()
        ),
        query,
    ))
}

fn append_query(mut url: String, query: Option<&str>) -> String {
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        url.push('?');
        url.push_str(query.trim_start_matches('?'));
    }
    url
}

fn validate_path_segment(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        .then_some(value)
}

fn validate_endpoint_path(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('/');
    if value.is_empty() {
        return None;
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_gateway_url_builds_compat_and_provider_specific_routes() {
        assert_eq!(
            provider_gateway_url(
                "acct_123",
                "default",
                AiGatewayRouteKind::Compat,
                "chat/completions",
                None
            )
            .unwrap(),
            "https://gateway.ai.cloudflare.com/v1/acct_123/default/compat/chat/completions"
        );
        assert_eq!(
            provider_gateway_url(
                "acct123",
                "prod-gw",
                AiGatewayRouteKind::Anthropic,
                "/v1/messages",
                Some("debug=true")
            )
            .unwrap(),
            "https://gateway.ai.cloudflare.com/v1/acct123/prod-gw/anthropic/v1/messages?debug=true"
        );
    }

    #[test]
    fn rest_gateway_url_builds_current_cloudflare_rest_api_routes() {
        assert_eq!(
            rest_gateway_url("acct123", "responses", None).unwrap(),
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/responses"
        );
        assert_eq!(
            rest_gateway_url("acct123", "/chat/completions", Some("?trace=1")).unwrap(),
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions?trace=1"
        );
    }

    #[test]
    fn rest_gateway_endpoint_url_handles_v1_and_ai_run_shapes() {
        assert_eq!(
            rest_gateway_endpoint_url(
                "acct123",
                AiGatewayRestEndpoint::ChatCompletions,
                Some("trace=1")
            )
            .unwrap(),
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions?trace=1"
        );
        assert_eq!(
            rest_gateway_endpoint_url("acct123", AiGatewayRestEndpoint::Run, None).unwrap(),
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run"
        );
    }

    #[test]
    fn gateway_url_validation_rejects_path_traversal_and_bad_segments() {
        assert!(provider_gateway_url(
            "bad/account",
            "default",
            AiGatewayRouteKind::Compat,
            "chat/completions",
            None
        )
        .is_err());
        assert!(provider_gateway_url(
            "acct123",
            "prod",
            AiGatewayRouteKind::Compat,
            "../chat/completions",
            None
        )
        .is_err());
        assert!(rest_gateway_url("", "responses", None).is_err());
    }

    #[test]
    fn rest_route_planner_maps_main_relay_supported_paths() {
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::OpenAiCompatible, "/chat/completions")
                .unwrap(),
            AiGatewayRestEndpoint::ChatCompletions
        );
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::OpenAiCompatible, "responses").unwrap(),
            AiGatewayRestEndpoint::Responses
        );
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::AnthropicMessages, "messages").unwrap(),
            AiGatewayRestEndpoint::Messages
        );
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::CloudflareWorkersAi, "ai/run").unwrap(),
            AiGatewayRestEndpoint::Run
        );
    }

    #[test]
    fn rest_route_planner_rejects_unsupported_relay_paths() {
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::OpenAiCompatible, "embeddings")
                .unwrap_err(),
            AiGatewayRestPlanError::UnsupportedEndpointPath
        );
        assert_eq!(
            rest_endpoint_for_relay_route(ProviderKind::OpenAiCompatible, "completions")
                .unwrap_err(),
            AiGatewayRestPlanError::UnsupportedEndpointPath
        );
        assert_eq!(
            rest_endpoint_for_relay_route(
                ProviderKind::GeminiNative,
                "v1beta/models/gemini:generateContent"
            )
            .unwrap_err(),
            AiGatewayRestPlanError::UnsupportedProvider
        );
    }

    #[test]
    fn model_author_classifier_detects_gateway_prefixes() {
        assert_eq!(
            classify_ai_gateway_model_author("openai/gpt-4o-mini"),
            AiGatewayModelAuthor::OpenAi
        );
        assert_eq!(
            classify_ai_gateway_model_author("anthropic/claude-3-5-sonnet"),
            AiGatewayModelAuthor::Anthropic
        );
        assert_eq!(
            classify_ai_gateway_model_author("google/gemini-2.0-flash"),
            AiGatewayModelAuthor::Google
        );
        assert_eq!(
            classify_ai_gateway_model_author("xai/grok-3"),
            AiGatewayModelAuthor::Xai
        );
        assert_eq!(
            classify_ai_gateway_model_author("@cf/meta/llama-3.1-8b-instruct"),
            AiGatewayModelAuthor::WorkersAi
        );
        assert!(has_ai_gateway_provider_prefix("openai/gpt-4o-mini"));
        assert!(!has_ai_gateway_provider_prefix("gpt-4o-mini"));
    }

    #[test]
    fn cutover_planner_allows_prefixed_supported_main_relay_routes() {
        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "openai/gpt-4.1",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseGateway(AiGatewayCutoverPlan {
                endpoint: AiGatewayRestEndpoint::ChatCompletions,
                model_author: AiGatewayModelAuthor::OpenAi,
                requires_gateway_id_header: false,
            })
        );

        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "responses",
                model: "xai/grok-3",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseGateway(AiGatewayCutoverPlan {
                endpoint: AiGatewayRestEndpoint::Responses,
                model_author: AiGatewayModelAuthor::Xai,
                requires_gateway_id_header: false,
            })
        );
    }

    #[test]
    fn cutover_planner_keeps_default_off_and_channel_opt_in_gates() {
        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: false,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "openai/gpt-4.1",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::RouterNotReady,
            }
        );

        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: false,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "openai/gpt-4.1",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::ChannelNotOptedIn,
            }
        );
    }

    #[test]
    fn cutover_planner_rejects_unsupported_routes_and_unprefixed_models() {
        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "embeddings",
                model: "openai/text-embedding-3-small",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::UnsupportedEndpointPath,
            }
        );

        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::GeminiNative,
                relay_path: "v1beta/models/gemini:generateContent",
                model: "google/gemini-2.0-flash",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::UnsupportedProvider,
            }
        );

        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "gpt-4o-mini",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::MissingProviderPrefix,
            }
        );
    }

    #[test]
    fn cutover_planner_keeps_custom_base_urls_on_direct_provider_path() {
        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "openai/gpt-4.1",
                channel_has_custom_base_url: true,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::CustomBaseUrlWithoutUserCredential,
            }
        );

        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::OpenAiCompatible,
                relay_path: "chat/completions",
                model: "openai/gpt-4.1",
                channel_has_custom_base_url: true,
                is_user_credential: true,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::UserBaseUrlOverrideRequiresDirect,
            }
        );
    }

    #[test]
    fn cutover_planner_rejects_workers_ai_messages_schema_mismatch() {
        assert_eq!(
            plan_ai_gateway_cutover(AiGatewayCutoverInput {
                router_ready: true,
                channel_opted_in: true,
                provider: ProviderKind::AnthropicMessages,
                relay_path: "messages",
                model: "@cf/meta/llama-3.1-8b-instruct",
                channel_has_custom_base_url: false,
                is_user_credential: false,
            }),
            AiGatewayCutoverDecision::UseDirect {
                reason: AiGatewayCutoverBlockReason::ModelEndpointSchemaMismatch,
            }
        );
    }
}
