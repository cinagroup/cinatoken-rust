pub(crate) const CLOUDFLARE_AI_GATEWAY_TOKEN_ENV: &str = "CLOUDFLARE_AI_GATEWAY_TOKEN";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RelayAiGatewayRuntimeConfig {
    pub(crate) account_id: String,
    pub(crate) gateway_id: String,
    pub(crate) api_token: String,
}

pub(crate) fn relay_ai_gateway_runtime_config(
    router_enabled: bool,
    account_id: Option<String>,
    gateway_id: Option<String>,
    dedicated_api_token: Option<String>,
) -> Option<RelayAiGatewayRuntimeConfig> {
    if !router_enabled {
        return None;
    }
    Some(RelayAiGatewayRuntimeConfig {
        account_id: non_empty(account_id)?,
        gateway_id: non_empty(gateway_id)?,
        api_token: non_empty(dedicated_api_token)?,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_requires_gate_account_gateway_and_dedicated_token() {
        for missing in 0..4 {
            let mut values: [Option<String>; 4] =
                std::array::from_fn(|_| Some("configured".to_string()));
            values[missing] = None;
            assert!(
                relay_ai_gateway_runtime_config(
                    values[0].is_some(),
                    values[1].clone(),
                    values[2].clone(),
                    values[3].clone(),
                )
                .is_none(),
                "missing policy input {missing} must fail closed"
            );
        }
    }

    #[test]
    fn runtime_normalizes_the_dedicated_configuration() {
        let config = relay_ai_gateway_runtime_config(
            true,
            Some(" account ".to_string()),
            Some(" gateway ".to_string()),
            Some(" dedicated-token ".to_string()),
        )
        .unwrap();
        assert_eq!(config.account_id, "account");
        assert_eq!(config.gateway_id, "gateway");
        assert_eq!(config.api_token, "dedicated-token");
    }

    #[test]
    fn whitespace_only_values_fail_closed() {
        for missing in 0..3 {
            let mut values = [
                Some("account".to_string()),
                Some("gateway".to_string()),
                Some("dedicated-token".to_string()),
            ];
            values[missing] = Some(" \t ".to_string());
            assert!(relay_ai_gateway_runtime_config(
                true,
                values[0].clone(),
                values[1].clone(),
                values[2].clone(),
            )
            .is_none());
        }
    }
}
