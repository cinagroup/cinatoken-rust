use serde_json::{Map, Value};

const DEFAULT_PROVIDER_BASE_URL: &str = "https://open.bigmodel.cn";
const OPENAI_ENDPOINTS: &[&str] = &["chat/completions", "embeddings", "images/generations"];

pub fn zhipu_v4_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    if !OPENAI_ENDPOINTS.contains(&endpoint_path) {
        return None;
    }
    let base = special_plan_roots(base_url)
        .map(|(_, openai_base)| openai_base.to_string())
        .unwrap_or_else(|| normalized_openai_base(base_url));
    Some(format!("{}/{endpoint_path}", base.trim_end_matches('/')))
}

pub fn zhipu_v4_messages_url(base_url: Option<&str>) -> String {
    let base = special_plan_roots(base_url)
        .map(|(messages_base, _)| messages_base.to_string())
        .unwrap_or_else(|| normalized_messages_base(base_url));
    format!("{}/v1/messages", base.trim_end_matches('/'))
}

/// Port the source Zhipu v4 request shape while keeping each route explicit.
pub fn apply_zhipu_v4_request(body: &mut Value, endpoint_path: &str) {
    match endpoint_path.trim().trim_start_matches('/') {
        "chat/completions" => apply_chat_request(body),
        "images/generations" => apply_image_request(body),
        "embeddings" | "messages" => {}
        _ => {}
    }
}

fn apply_chat_request(body: &mut Value) {
    let Some(input) = body.as_object() else {
        return;
    };
    let mut output = Map::new();

    copy_field(input, &mut output, "model");
    copy_field(input, &mut output, "stream");
    if let Some(messages) = input.get("messages").and_then(Value::as_array) {
        output.insert(
            "messages".to_string(),
            Value::Array(messages.iter().map(normalize_message).collect()),
        );
    }
    copy_field(input, &mut output, "temperature");
    if let Some(top_p) = input.get("top_p") {
        let value = if top_p.as_f64().is_some_and(|value| value >= 1.0) {
            Value::from(0.99)
        } else {
            top_p.clone()
        };
        output.insert("top_p".to_string(), value);
    }
    if let Some(stop) = input.get("stop") {
        if let Some(stop) = stop.as_str() {
            output.insert(
                "stop".to_string(),
                Value::Array(vec![Value::String(stop.to_string())]),
            );
        } else if stop.is_array() {
            output.insert("stop".to_string(), stop.clone());
        }
    }
    for field in ["tools", "tool_choice", "thinking"] {
        copy_field(input, &mut output, field);
    }

    if input.contains_key("max_tokens") || input.contains_key("max_completion_tokens") {
        let max_tokens = input
            .get("max_completion_tokens")
            .and_then(Value::as_u64)
            .filter(|value| *value != 0)
            .or_else(|| input.get("max_tokens").and_then(Value::as_u64))
            .unwrap_or_default();
        output.insert("max_tokens".to_string(), Value::from(max_tokens));
    }

    *body = Value::Object(output);
}

fn normalize_message(message: &Value) -> Value {
    let Some(input) = message.as_object() else {
        return message.clone();
    };
    let mut output = Map::new();
    for field in ["role", "tool_calls", "tool_call_id"] {
        copy_field(input, &mut output, field);
    }
    if let Some(content) = input.get("content") {
        output.insert("content".to_string(), normalize_message_content(content));
    }
    Value::Object(output)
}

fn normalize_message_content(content: &Value) -> Value {
    let Some(parts) = content.as_array() else {
        return content.clone();
    };
    Value::Array(parts.iter().map(normalize_content_part).collect())
}

fn normalize_content_part(part: &Value) -> Value {
    let mut part = part.clone();
    let Some(object) = part.as_object_mut() else {
        return part;
    };
    if object.get("type").and_then(Value::as_str) != Some("image_url") {
        return part;
    }
    let Some(image_url) = object.get_mut("image_url").and_then(Value::as_object_mut) else {
        return part;
    };
    let Some(url) = image_url
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return part;
    };
    if url.starts_with("data:image/") {
        if let Some((_, encoded)) = url.split_once(',') {
            image_url.insert("url".to_string(), Value::String(encoded.to_string()));
        }
    }
    part
}

fn apply_image_request(body: &mut Value) {
    let Some(input) = body.as_object() else {
        return;
    };
    let mut output = Map::new();
    for field in [
        "model",
        "prompt",
        "n",
        "quality",
        "size",
        "watermark_enabled",
        "user_id",
    ] {
        copy_field(input, &mut output, field);
    }
    *body = Value::Object(output);
}

fn copy_field(input: &Map<String, Value>, output: &mut Map<String, Value>, field: &str) {
    if let Some(value) = input.get(field).filter(|value| !value.is_null()) {
        output.insert(field.to_string(), value.clone());
    }
}

fn normalized_openai_base(base_url: Option<&str>) -> String {
    let base = normalized_provider_base(base_url);
    if base.ends_with("/api/paas/v4") || base.ends_with("/api/coding/paas/v4") {
        base
    } else if let Some(root) = base.strip_suffix("/api/anthropic") {
        format!("{root}/api/paas/v4")
    } else {
        format!("{base}/api/paas/v4")
    }
}

fn normalized_messages_base(base_url: Option<&str>) -> String {
    let base = normalized_provider_base(base_url);
    if base.ends_with("/api/anthropic") {
        base
    } else if let Some(root) = base.strip_suffix("/api/paas/v4") {
        format!("{root}/api/anthropic")
    } else if let Some(root) = base.strip_suffix("/api/coding/paas/v4") {
        format!("{root}/api/anthropic")
    } else {
        format!("{base}/api/anthropic")
    }
}

fn normalized_provider_base(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROVIDER_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

fn special_plan_roots(base_url: Option<&str>) -> Option<(&'static str, &'static str)> {
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
    fn urls_match_current_v4_and_source_special_plan_contracts() {
        assert_eq!(
            zhipu_v4_openai_url(None, "chat/completions").as_deref(),
            Some("https://open.bigmodel.cn/api/paas/v4/chat/completions")
        );
        assert_eq!(
            zhipu_v4_openai_url(Some("https://zhipu.example/api/paas/v4/"), "embeddings")
                .as_deref(),
            Some("https://zhipu.example/api/paas/v4/embeddings")
        );
        assert_eq!(
            zhipu_v4_messages_url(Some("https://zhipu.example/api/paas/v4")),
            "https://zhipu.example/api/anthropic/v1/messages"
        );
        assert_eq!(
            zhipu_v4_openai_url(Some("glm-coding-plan"), "chat/completions").as_deref(),
            Some("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions")
        );
        assert_eq!(
            zhipu_v4_messages_url(Some("glm-coding-plan-international")),
            "https://api.z.ai/api/anthropic/v1/messages"
        );
        for unsupported in ["completions", "responses", "rerank", "audio/speech"] {
            assert!(zhipu_v4_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn chat_transform_matches_source_shape_and_normalizes_multimodal_data() {
        let mut body = json!({
            "model": "glm-4.7",
            "stream": true,
            "messages": [
                {
                    "role": "user",
                    "name": "removed",
                    "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                },
                {
                    "role": "assistant",
                    "content": "ok",
                    "tool_calls": [{"id": "call_1", "type": "function"}]
                },
                {"role": "tool", "content": "done", "tool_call_id": "call_1"}
            ],
            "temperature": 0.3,
            "top_p": 1.0,
            "stop": "END",
            "tools": [{"type": "function"}],
            "tool_choice": "auto",
            "thinking": {"type": "enabled"},
            "max_tokens": 64,
            "max_completion_tokens": 96,
            "user": "removed"
        });

        apply_zhipu_v4_request(&mut body, "chat/completions");

        assert_eq!(body["top_p"], 0.99);
        assert_eq!(body["stop"], json!(["END"]));
        assert_eq!(body["max_tokens"], 96);
        assert_eq!(
            body["messages"][0]["content"][1]["image_url"]["url"],
            "AAAA"
        );
        assert!(body["messages"][0].get("name").is_none());
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("user").is_none());
    }

    #[test]
    fn image_transform_preserves_source_request_fields() {
        let mut body = json!({
            "model": "glm-image",
            "prompt": "a diagram",
            "quality": "hd",
            "size": "1280x1280",
            "watermark_enabled": true,
            "user_id": "user-123",
            "n": 2,
            "response_format": "b64_json"
        });

        apply_zhipu_v4_request(&mut body, "images/generations");

        assert_eq!(
            body,
            json!({
                "model": "glm-image",
                "prompt": "a diagram",
                "n": 2,
                "quality": "hd",
                "size": "1280x1280",
                "watermark_enabled": true,
                "user_id": "user-123"
            })
        );
    }

    #[test]
    fn embeddings_and_messages_remain_protocol_passthrough() {
        for endpoint in ["embeddings", "messages"] {
            let mut body = json!({"model": "embedding-3", "input": ["hello"]});
            let original = body.clone();
            apply_zhipu_v4_request(&mut body, endpoint);
            assert_eq!(body, original);
        }
    }
}
