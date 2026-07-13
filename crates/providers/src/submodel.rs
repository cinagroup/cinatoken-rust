use cinatoken_relay::{upstream_v1_url, CHANNEL_TYPE_SUBMODEL};

pub fn submodel_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    matches!(endpoint_path, "chat/completions" | "completions")
        .then(|| upstream_v1_url(CHANNEL_TYPE_SUBMODEL, base_url, endpoint_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_allowlist_is_direct_only_and_route_explicit() {
        assert_eq!(
            submodel_openai_url(None, "chat/completions").as_deref(),
            Some("https://llm.submodel.ai/v1/chat/completions")
        );
        assert_eq!(
            submodel_openai_url(Some("https://submodel.example/v1"), "/completions").as_deref(),
            Some("https://submodel.example/v1/completions")
        );
        for unsupported in ["responses", "embeddings", "images/generations"] {
            assert!(submodel_openai_url(None, unsupported).is_none());
        }
    }
}
