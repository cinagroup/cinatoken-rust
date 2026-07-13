use cinatoken_relay::{upstream_v1_url, CHANNEL_TYPE_MOONSHOT};
use serde_json::Value;

const DEFAULT_BASE_URL: &str = "https://api.moonshot.cn";
const OPENAI_ENDPOINTS: &[&str] = &["chat/completions", "completions", "embeddings", "rerank"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoonshotRequestFormat {
    OpenAi,
    AnthropicMessages,
}

pub fn moonshot_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    if !OPENAI_ENDPOINTS.contains(&endpoint_path) {
        return None;
    }
    if let Some((_, openai_base)) = coding_plan_roots(base_url) {
        return (endpoint_path == "chat/completions")
            .then(|| format!("{}/chat/completions", openai_base.trim_end_matches('/')));
    }
    Some(upstream_v1_url(
        CHANNEL_TYPE_MOONSHOT,
        base_url,
        endpoint_path,
    ))
}

pub fn moonshot_messages_url(base_url: Option<&str>) -> String {
    if let Some((anthropic_base, _)) = coding_plan_roots(base_url) {
        return format!("{}/v1/messages", anthropic_base.trim_end_matches('/'));
    }
    format!("{}/anthropic/v1/messages", normalized_base_url(base_url))
}

/// The source adapter only normalizes Kimi K2.6's explicit temperature.
pub fn apply_moonshot_request(body: &mut Value, format: MoonshotRequestFormat) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if format == MoonshotRequestFormat::AnthropicMessages {
        apply_moonshot_messages_request(object);
        return;
    }
    let is_kimi_k26 = object
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.eq_ignore_ascii_case("kimi-k2.6"));
    if !is_kimi_k26 {
        return;
    }
    if object
        .get("temperature")
        .and_then(Value::as_f64)
        .is_some_and(|temperature| temperature != 1.0)
    {
        object.insert("temperature".to_string(), Value::from(1.0));
    }
}

fn apply_moonshot_messages_request(object: &mut serde_json::Map<String, Value>) {
    let mut max_tokens = object
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if max_tokens == 0 {
        max_tokens = 8_192;
        object.insert("max_tokens".to_string(), Value::from(max_tokens));
    }

    let Some(model) = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some(base_model) = model.strip_suffix("-thinking") else {
        return;
    };
    if object.get("thinking").is_some_and(|value| !value.is_null()) {
        return;
    }
    if max_tokens < 1_280 {
        max_tokens = 1_280;
        object.insert("max_tokens".to_string(), Value::from(max_tokens));
    }
    object.insert("model".to_string(), Value::String(base_model.to_string()));
    object.insert(
        "thinking".to_string(),
        serde_json::json!({
            "type": "enabled",
            "budget_tokens": ((max_tokens as f64) * 0.8) as u64,
        }),
    );
    object.insert("temperature".to_string(), Value::from(1.0));
}

pub fn is_coding_plan_base(base_url: Option<&str>) -> bool {
    coding_plan_roots(base_url).is_some()
}

fn normalized_base_url(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

fn coding_plan_roots(base_url: Option<&str>) -> Option<(&'static str, &'static str)> {
    match base_url.map(str::trim).filter(|value| !value.is_empty())? {
        "glm-coding-plan" => Some((
            "https://open.bigmodel.cn/api/anthropic",
            "https://open.bigmodel.cn/api/coding/paas/v4",
        )),
        "glm-coding-plan-international" => Some((
            "https://api.z.ai/api/anthropic",
            "https://api.z.ai/api/coding/paas/v4",
        )),
        "kimi-coding-plan" => Some((
            "https://api.kimi.com/coding",
            "https://api.kimi.com/coding/v1",
        )),
        "doubao-coding-plan" => Some((
            "https://ark.cn-beijing.volces.com/api/coding",
            "https://ark.cn-beijing.volces.com/api/coding/v3",
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn urls_match_source_routes_and_fail_closed_elsewhere() {
        assert_eq!(
            moonshot_openai_url(None, "chat/completions").as_deref(),
            Some("https://api.moonshot.cn/v1/chat/completions")
        );
        assert_eq!(
            moonshot_openai_url(Some("https://moonshot.example/v1"), "/embeddings").as_deref(),
            Some("https://moonshot.example/v1/embeddings")
        );
        assert_eq!(
            moonshot_messages_url(Some("https://moonshot.example/")),
            "https://moonshot.example/anthropic/v1/messages"
        );
        for unsupported in ["responses", "images/generations", "audio/speech"] {
            assert!(moonshot_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn coding_plan_sentinels_are_limited_to_chat_and_messages() {
        assert_eq!(
            moonshot_openai_url(Some("kimi-coding-plan"), "chat/completions").as_deref(),
            Some("https://api.kimi.com/coding/v1/chat/completions")
        );
        assert_eq!(
            moonshot_messages_url(Some("glm-coding-plan-international")),
            "https://api.z.ai/api/anthropic/v1/messages"
        );
        assert!(moonshot_openai_url(Some("doubao-coding-plan"), "embeddings").is_none());
        assert!(is_coding_plan_base(Some("glm-coding-plan")));
    }

    #[test]
    fn kimi_k26_normalizes_only_an_explicit_non_one_temperature() {
        let mut body = json!({"model": "KIMI-K2.6", "temperature": 0.2});
        apply_moonshot_request(&mut body, MoonshotRequestFormat::OpenAi);
        assert_eq!(body["temperature"], 1.0);

        let mut omitted = json!({"model": "kimi-k2.6"});
        apply_moonshot_request(&mut omitted, MoonshotRequestFormat::OpenAi);
        assert!(omitted.get("temperature").is_none());

        let mut other = json!({"model": "kimi-k2.5", "temperature": 0.2});
        apply_moonshot_request(&mut other, MoonshotRequestFormat::OpenAi);
        assert_eq!(other["temperature"], 0.2);

        let mut messages = json!({"model": "kimi-k2.6", "temperature": 0.2});
        apply_moonshot_request(&mut messages, MoonshotRequestFormat::AnthropicMessages);
        assert_eq!(messages["temperature"], 0.2);
        assert_eq!(messages["max_tokens"], 8192);
    }

    #[test]
    fn messages_apply_source_default_tokens_and_thinking_suffix() {
        let mut body = json!({"model": "kimi-k2-thinking", "max_tokens": 1000});
        apply_moonshot_request(&mut body, MoonshotRequestFormat::AnthropicMessages);
        assert_eq!(body["model"], "kimi-k2");
        assert_eq!(body["max_tokens"], 1280);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 1024);
        assert_eq!(body["temperature"], 1.0);

        let mut explicit = json!({
            "model": "kimi-k2-thinking",
            "max_tokens": 2048,
            "thinking": {"type": "disabled"}
        });
        apply_moonshot_request(&mut explicit, MoonshotRequestFormat::AnthropicMessages);
        assert_eq!(explicit["model"], "kimi-k2-thinking");
        assert_eq!(explicit["thinking"]["type"], "disabled");
    }
}
