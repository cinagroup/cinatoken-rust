use cinatoken_relay::{upstream_v1_url, CHANNEL_TYPE_XAI};
use serde_json::{Map, Number, Value};

const CHAT_PATHS: &[&str] = &["chat/completions", "completions"];

pub fn xai_openai_url(base_url: Option<&str>, endpoint_path: &str) -> String {
    upstream_v1_url(CHANNEL_TYPE_XAI, base_url, endpoint_path)
}

/// Apply the dedicated Go xAI adapter semantics without classifying type 48 as
/// a generic OpenAI channel. Responses requests are already xAI-compatible and
/// therefore pass through unchanged.
pub fn apply_xai_request(body: &mut Value, endpoint_path: &str) {
    if endpoint_path == "images/generations" {
        apply_xai_image_request(body);
    } else if CHAT_PATHS.contains(&endpoint_path) {
        apply_xai_text_request(body);
    }
}

fn apply_xai_text_request(body: &mut Value) {
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

    if let Some(upstream_model) = model.strip_suffix("-search") {
        object.insert(
            "model".to_string(),
            Value::String(upstream_model.to_string()),
        );
        object.insert(
            "search_parameters".to_string(),
            serde_json::json!({"mode": "on"}),
        );
        return;
    }

    if !model.starts_with("grok-3-mini") {
        return;
    }

    let max_completion_tokens = object
        .get("max_completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let max_tokens = object
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if max_completion_tokens == 0 && max_tokens > 0 {
        object.remove("max_tokens");
        object.insert(
            "max_completion_tokens".to_string(),
            Value::Number(Number::from(max_tokens)),
        );
    }

    let (upstream_model, reasoning_effort) = if let Some(model) = model.strip_suffix("-high") {
        (model, Some("high"))
    } else if let Some(model) = model.strip_suffix("-low") {
        (model, Some("low"))
    } else {
        (model.as_str(), None)
    };
    if let Some(reasoning_effort) = reasoning_effort {
        object.insert(
            "model".to_string(),
            Value::String(upstream_model.to_string()),
        );
        object.insert(
            "reasoning_effort".to_string(),
            Value::String(reasoning_effort.to_string()),
        );
    }
}

fn apply_xai_image_request(body: &mut Value) {
    let Some(input) = body.as_object() else {
        return;
    };
    let mut output = Map::new();
    output.insert(
        "model".to_string(),
        input
            .get("model")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    output.insert(
        "prompt".to_string(),
        input
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    output.insert(
        "n".to_string(),
        input
            .get("n")
            .filter(|value| value.as_u64().is_some())
            .cloned()
            .unwrap_or_else(|| Value::Number(Number::from(1))),
    );
    if let Some(response_format) = input
        .get("response_format")
        .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
    {
        output.insert("response_format".to_string(), response_format.clone());
    }
    *body = Value::Object(output);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn xai_urls_use_the_official_v1_root_and_honor_overrides() {
        assert_eq!(
            xai_openai_url(None, "chat/completions"),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            xai_openai_url(Some("https://xai.example/v1/"), "/responses"),
            "https://xai.example/v1/responses"
        );
    }

    #[test]
    fn search_suffix_enables_source_compatible_search_and_returns_early() {
        let mut body = json!({
            "model": "grok-3-mini-high-search",
            "messages": [{"role": "user", "content": "news"}],
            "max_tokens": 50
        });
        apply_xai_request(&mut body, "chat/completions");
        assert_eq!(body["model"], "grok-3-mini-high");
        assert_eq!(body["search_parameters"], json!({"mode": "on"}));
        assert_eq!(body["max_tokens"], 50);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn mini_reasoning_suffix_moves_max_tokens_and_preserves_explicit_max() {
        let mut body = json!({"model": "grok-3-mini-high", "max_tokens": 128});
        apply_xai_request(&mut body, "chat/completions");
        assert_eq!(body["model"], "grok-3-mini");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["max_completion_tokens"], 128);
        assert!(body.get("max_tokens").is_none());

        let mut explicit = json!({
            "model": "grok-3-mini-low",
            "max_tokens": 128,
            "max_completion_tokens": 64
        });
        apply_xai_request(&mut explicit, "chat/completions");
        assert_eq!(explicit["reasoning_effort"], "low");
        assert_eq!(explicit["max_completion_tokens"], 64);
        assert_eq!(explicit["max_tokens"], 128);
    }

    #[test]
    fn image_generation_keeps_only_the_xai_shape() {
        let mut body = json!({
            "model": "grok-imagine-image",
            "prompt": "a rust gateway",
            "n": 2,
            "response_format": "url",
            "size": "1024x1024",
            "quality": "hd",
            "style": "vivid",
            "user": "must-not-forward"
        });
        apply_xai_request(&mut body, "images/generations");
        assert_eq!(
            body,
            json!({
                "model": "grok-imagine-image",
                "prompt": "a rust gateway",
                "n": 2,
                "response_format": "url"
            })
        );
    }

    #[test]
    fn responses_requests_pass_through_unchanged() {
        let expected = json!({
            "model": "grok-4.5",
            "input": "hello",
            "tools": [{"type": "web_search"}]
        });
        let mut body = expected.clone();
        apply_xai_request(&mut body, "responses");
        assert_eq!(body, expected);
    }
}
