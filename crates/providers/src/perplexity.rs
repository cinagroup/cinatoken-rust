use serde_json::{Map, Number, Value};

pub fn perplexity_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    if endpoint_path != "chat/completions" {
        return None;
    }
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.perplexity.ai")
        .trim_end_matches('/');
    Some(format!("{base}/chat/completions"))
}

/// Port of Go `requestOpenAI2Perplexity` plus its `top_p` normalization.
pub fn apply_perplexity_chat_request(body: &mut Value) {
    let Some(input) = body.as_object() else {
        return;
    };
    let mut output = Map::new();

    copy_nonempty_string(input, &mut output, "model");
    copy_typed(input, &mut output, "stream", Value::is_boolean);
    copy_typed(input, &mut output, "temperature", Value::is_number);
    if let Some(top_p) = input.get("top_p").and_then(Value::as_f64) {
        let top_p = if top_p >= 1.0 { 0.99 } else { top_p };
        if let Some(top_p) = Number::from_f64(top_p) {
            output.insert("top_p".to_string(), Value::Number(top_p));
        }
    }

    if let Some(messages) = input.get("messages").and_then(Value::as_array) {
        let messages = messages
            .iter()
            .filter_map(|message| {
                let message = message.as_object()?;
                let mut transformed = Map::new();
                transformed.insert(
                    "role".to_string(),
                    Value::String(
                        message
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    ),
                );
                transformed.insert(
                    "content".to_string(),
                    message.get("content").cloned().unwrap_or(Value::Null),
                );
                Some(Value::Object(transformed))
            })
            .collect();
        output.insert("messages".to_string(), Value::Array(messages));
    }

    for field in ["frequency_penalty", "presence_penalty"] {
        copy_typed(input, &mut output, field, Value::is_number);
    }
    for field in [
        "search_domain_filter",
        "search_recency_filter",
        "search_mode",
    ] {
        if let Some(value) = input.get(field) {
            output.insert(field.to_string(), value.clone());
        }
    }
    for field in ["return_images", "return_related_questions"] {
        copy_typed(input, &mut output, field, Value::is_boolean);
    }

    let max_completion_tokens = input.get("max_completion_tokens").and_then(Value::as_u64);
    let max_tokens = input.get("max_tokens").and_then(Value::as_u64);
    if max_completion_tokens.is_some() || max_tokens.is_some() {
        let selected = max_completion_tokens
            .filter(|value| *value != 0)
            .or(max_tokens)
            .unwrap_or(0);
        output.insert(
            "max_tokens".to_string(),
            Value::Number(Number::from(selected)),
        );
    }

    *body = Value::Object(output);
}

fn copy_nonempty_string(input: &Map<String, Value>, output: &mut Map<String, Value>, field: &str) {
    if let Some(value) = input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        output.insert(field.to_string(), Value::String(value.to_string()));
    }
}

fn copy_typed(
    input: &Map<String, Value>,
    output: &mut Map<String, Value>,
    field: &str,
    predicate: impl Fn(&Value) -> bool,
) {
    if let Some(value) = input.get(field).filter(|value| predicate(value)) {
        output.insert(field.to_string(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn urls_use_the_go_and_official_chat_alias_and_fail_closed_for_other_routes() {
        assert_eq!(
            perplexity_openai_url(None, "chat/completions").as_deref(),
            Some("https://api.perplexity.ai/chat/completions")
        );
        assert_eq!(
            perplexity_openai_url(Some("https://perplexity.example/v1/"), "/chat/completions")
                .as_deref(),
            Some("https://perplexity.example/v1/chat/completions")
        );
        for unsupported in ["responses", "embeddings"] {
            assert!(perplexity_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn chat_request_matches_go_whitelist_and_normalization() {
        let mut body = json!({
            "model": "sonar-pro",
            "stream": true,
            "messages": [{
                "role": "user",
                "content": "search",
                "name": "removed",
                "tool_calls": [{"id": "removed"}]
            }],
            "temperature": 0.2,
            "top_p": 1,
            "frequency_penalty": 0.1,
            "presence_penalty": 0.3,
            "search_domain_filter": ["example.com"],
            "search_recency_filter": "week",
            "return_images": true,
            "return_related_questions": false,
            "search_mode": "academic",
            "max_tokens": 128,
            "max_completion_tokens": 64,
            "tools": [{"type": "function"}],
            "user": "removed",
            "stream_options": {"include_usage": true}
        });

        apply_perplexity_chat_request(&mut body);

        assert_eq!(body["top_p"], 0.99);
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(
            body["messages"][0],
            json!({"role": "user", "content": "search"})
        );
        assert_eq!(body["search_domain_filter"], json!(["example.com"]));
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("tools").is_none());
        assert!(body.get("user").is_none());
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn max_token_pointer_semantics_and_top_p_below_one_are_preserved() {
        let mut body = json!({
            "model": "sonar",
            "messages": [{"role": "user", "content": "hello"}],
            "top_p": 0.7,
            "max_completion_tokens": 0
        });

        apply_perplexity_chat_request(&mut body);

        assert_eq!(body["top_p"], 0.7);
        assert_eq!(body["max_tokens"], 0);
    }
}
