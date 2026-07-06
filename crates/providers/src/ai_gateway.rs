use std::fmt;

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
}
