use serde_json::{json, Value};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepSeekRequestFormat {
    OpenAi,
    AnthropicMessages,
}

pub fn deepseek_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let base = normalized_base_url(base_url);
    match endpoint_path.trim().trim_start_matches('/') {
        "chat/completions" => Some(format!("{base}/v1/chat/completions")),
        "completions" => {
            let beta_base = if base.ends_with("/beta") {
                base
            } else {
                format!("{base}/beta")
            };
            Some(format!("{beta_base}/completions"))
        }
        _ => None,
    }
}

pub fn deepseek_messages_url(base_url: Option<&str>) -> String {
    format!("{}/anthropic/v1/messages", normalized_base_url(base_url))
}

pub fn apply_deepseek_request(body: &mut Value, format: DeepSeekRequestFormat) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let Some(model) = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Some((base_model, thinking_type, effort)) = parse_v4_thinking_suffix(&model) else {
        return;
    };

    object.insert("model".to_string(), Value::String(base_model));
    object.insert("thinking".to_string(), json!({ "type": thinking_type }));
    match format {
        DeepSeekRequestFormat::OpenAi => {
            if let Some(effort) = effort {
                object.insert(
                    "reasoning_effort".to_string(),
                    Value::String(effort.to_string()),
                );
            } else {
                object.remove("reasoning_effort");
            }
        }
        DeepSeekRequestFormat::AnthropicMessages => {
            if let Some(effort) = effort {
                object.insert("output_config".to_string(), json!({ "effort": effort }));
            } else {
                object.remove("output_config");
            }
        }
    }
}

fn normalized_base_url(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

fn parse_v4_thinking_suffix(model: &str) -> Option<(String, &'static str, Option<&'static str>)> {
    let (base, thinking_type, effort) = if let Some(base) = model.strip_suffix("-none") {
        (base, "disabled", None)
    } else if let Some(base) = model.strip_suffix("-max") {
        (base, "enabled", Some("max"))
    } else {
        return None;
    };
    base.starts_with("deepseek-v4-")
        .then(|| (base.to_string(), thinking_type, effort))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_match_go_deepseek_adapter() {
        assert_eq!(
            deepseek_openai_url(None, "chat/completions").as_deref(),
            Some("https://api.deepseek.com/v1/chat/completions")
        );
        assert_eq!(
            deepseek_openai_url(Some("https://deepseek.example/beta"), "completions").as_deref(),
            Some("https://deepseek.example/beta/completions")
        );
        assert_eq!(
            deepseek_messages_url(Some("https://deepseek.example/")),
            "https://deepseek.example/anthropic/v1/messages"
        );
        assert!(deepseek_openai_url(None, "responses").is_none());
        assert!(deepseek_openai_url(None, "embeddings").is_none());
    }

    #[test]
    fn openai_thinking_suffix_matches_go_contract() {
        let mut disabled = json!({
            "model": "deepseek-v4-preview-none",
            "reasoning_effort": "stale"
        });
        apply_deepseek_request(&mut disabled, DeepSeekRequestFormat::OpenAi);
        assert_eq!(disabled["model"], "deepseek-v4-preview");
        assert_eq!(disabled["thinking"]["type"], "disabled");
        assert!(disabled.get("reasoning_effort").is_none());

        let mut enabled = json!({ "model": "deepseek-v4-preview-max" });
        apply_deepseek_request(&mut enabled, DeepSeekRequestFormat::OpenAi);
        assert_eq!(enabled["model"], "deepseek-v4-preview");
        assert_eq!(enabled["thinking"]["type"], "enabled");
        assert_eq!(enabled["reasoning_effort"], "max");
    }

    #[test]
    fn anthropic_thinking_suffix_matches_go_contract() {
        let mut disabled = json!({
            "model": "deepseek-v4-preview-none",
            "output_config": { "effort": "stale" }
        });
        apply_deepseek_request(&mut disabled, DeepSeekRequestFormat::AnthropicMessages);
        assert_eq!(disabled["thinking"]["type"], "disabled");
        assert!(disabled.get("output_config").is_none());

        let mut enabled = json!({ "model": "deepseek-v4-preview-max" });
        apply_deepseek_request(&mut enabled, DeepSeekRequestFormat::AnthropicMessages);
        assert_eq!(enabled["thinking"]["type"], "enabled");
        assert_eq!(enabled["output_config"]["effort"], "max");
    }

    #[test]
    fn unrelated_models_are_unchanged() {
        let mut body = json!({ "model": "deepseek-chat-max" });
        let original = body.clone();
        apply_deepseek_request(&mut body, DeepSeekRequestFormat::OpenAi);
        assert_eq!(body, original);
    }
}
