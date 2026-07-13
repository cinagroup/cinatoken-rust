use std::{collections::HashMap, fmt};

use cinatoken_relay::{upstream_v1_url, CHANNEL_TYPE_MISTRAL};
use serde_json::{Map, Number, Value};

const TOOL_CALL_ID_LEN: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MistralRequestTransformError {
    ToolCallIdGenerationFailed,
}

impl fmt::Display for MistralRequestTransformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ToolCallIdGenerationFailed => {
                write!(f, "failed to generate a valid Mistral tool-call id")
            }
        }
    }
}

impl std::error::Error for MistralRequestTransformError {}

pub fn mistral_openai_url(base_url: Option<&str>, endpoint_path: &str) -> String {
    upstream_v1_url(CHANNEL_TYPE_MISTRAL, base_url, endpoint_path)
}

/// Port of Go `requestOpenAI2Mistral`. The caller supplies the ID generator so
/// the pure provider layer remains runtime-independent while Workers can use
/// Web Crypto-backed entropy.
pub fn apply_mistral_chat_request<F>(
    body: &mut Value,
    mut generate_tool_call_id: F,
) -> Result<(), MistralRequestTransformError>
where
    F: FnMut() -> Option<String>,
{
    let Some(input) = body.as_object() else {
        return Ok(());
    };

    let mut output = Map::new();
    copy_nonempty_string(input, &mut output, "model");
    copy_typed(input, &mut output, "stream", Value::is_boolean);
    copy_typed(input, &mut output, "temperature", Value::is_number);
    copy_typed(input, &mut output, "top_p", Value::is_number);

    let mut id_map = HashMap::new();
    if let Some(messages) = input.get("messages").and_then(Value::as_array) {
        let mut transformed = Vec::with_capacity(messages.len());
        for message in messages {
            if let Some(message) =
                transform_message(message, &mut id_map, &mut generate_tool_call_id)?
            {
                transformed.push(message);
            }
        }
        if !transformed.is_empty() {
            output.insert("messages".to_string(), Value::Array(transformed));
        }
    }

    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        let transformed = tools
            .iter()
            .filter_map(|tool| transform_tool_call(tool, None))
            .collect::<Vec<_>>();
        if !transformed.is_empty() {
            output.insert("tools".to_string(), Value::Array(transformed));
        }
    }
    if let Some(tool_choice) = input.get("tool_choice").filter(|value| !value.is_null()) {
        output.insert("tool_choice".to_string(), tool_choice.clone());
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
    Ok(())
}

fn transform_message<F>(
    message: &Value,
    id_map: &mut HashMap<String, String>,
    generate_tool_call_id: &mut F,
) -> Result<Option<Value>, MistralRequestTransformError>
where
    F: FnMut() -> Option<String>,
{
    let Some(input) = message.as_object() else {
        return Ok(None);
    };
    let role = input
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_calls_present = input.get("tool_calls").is_some();

    let mut output = Map::new();
    output.insert("role".to_string(), Value::String(role.to_string()));
    output.insert(
        "content".to_string(),
        transform_content(
            input.get("content"),
            role == "assistant"
                && tool_calls_present
                && input.get("content").and_then(Value::as_str) == Some(""),
        ),
    );

    if let Some(tool_calls) = input.get("tool_calls").and_then(Value::as_array) {
        let mut transformed = Vec::with_capacity(tool_calls.len());
        for tool_call in tool_calls {
            if !tool_call.is_object() {
                continue;
            }
            let old_id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let normalized_id = normalize_tool_call_id(old_id, id_map, generate_tool_call_id)?;
            if let Some(tool_call) = transform_tool_call(tool_call, Some(&normalized_id)) {
                transformed.push(tool_call);
            }
        }
        output.insert("tool_calls".to_string(), Value::Array(transformed));
    }

    if let Some(old_id) = input
        .get("tool_call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let normalized_id = normalize_tool_call_id(old_id, id_map, generate_tool_call_id)?;
        output.insert("tool_call_id".to_string(), Value::String(normalized_id));
    }

    Ok(Some(Value::Object(output)))
}

fn normalize_tool_call_id<F>(
    old_id: &str,
    id_map: &mut HashMap<String, String>,
    generate_tool_call_id: &mut F,
) -> Result<String, MistralRequestTransformError>
where
    F: FnMut() -> Option<String>,
{
    if valid_tool_call_id(old_id) {
        return Ok(old_id.to_string());
    }
    if let Some(mapped) = id_map.get(old_id) {
        return Ok(mapped.clone());
    }

    let generated = generate_tool_call_id()
        .filter(|value| valid_tool_call_id(value))
        .ok_or(MistralRequestTransformError::ToolCallIdGenerationFailed)?;
    id_map.insert(old_id.to_string(), generated.clone());
    Ok(generated)
}

fn valid_tool_call_id(value: &str) -> bool {
    value.len() == TOOL_CALL_ID_LEN && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn transform_tool_call(value: &Value, normalized_id: Option<&str>) -> Option<Value> {
    let input = value.as_object()?;
    let mut output = Map::new();

    let id = normalized_id.or_else(|| {
        input
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    });
    if let Some(id) = id {
        output.insert("id".to_string(), Value::String(id.to_string()));
    }
    output.insert(
        "type".to_string(),
        Value::String(
            input
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    output.insert(
        "function".to_string(),
        transform_function(input.get("function")),
    );
    if let Some(custom) = input.get("custom").filter(|value| !value.is_null()) {
        output.insert("custom".to_string(), custom.clone());
    }
    Some(Value::Object(output))
}

fn transform_function(value: Option<&Value>) -> Value {
    let input = value.and_then(Value::as_object);
    let mut output = Map::new();
    output.insert(
        "name".to_string(),
        Value::String(
            input
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    for field in ["description", "arguments"] {
        if let Some(value) = input
            .and_then(|input| input.get(field))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            output.insert(field.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(parameters) = input
        .and_then(|input| input.get("parameters"))
        .filter(|value| !value.is_null())
    {
        output.insert("parameters".to_string(), parameters.clone());
    }
    Value::Object(output)
}

fn transform_content(value: Option<&Value>, force_empty_array: bool) -> Value {
    if force_empty_array {
        return Value::Array(Vec::new());
    }
    let Some(value) = value else {
        return Value::Null;
    };
    if let Some(text) = value.as_str() {
        let mut part = Map::new();
        part.insert("type".to_string(), Value::String("text".to_string()));
        if !text.is_empty() {
            part.insert("text".to_string(), Value::String(text.to_string()));
        }
        return Value::Array(vec![Value::Object(part)]);
    }
    let Some(parts) = value.as_array() else {
        return Value::Null;
    };

    let transformed = parts
        .iter()
        .filter_map(transform_content_part)
        .collect::<Vec<_>>();
    if transformed.is_empty() {
        Value::Null
    } else {
        Value::Array(transformed)
    }
}

fn transform_content_part(value: &Value) -> Option<Value> {
    let input = value.as_object()?;
    match input.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = input.get("text").and_then(Value::as_str)?;
            let mut output = Map::new();
            output.insert("type".to_string(), Value::String("text".to_string()));
            if !text.is_empty() {
                output.insert("text".to_string(), Value::String(text.to_string()));
            }
            Some(Value::Object(output))
        }
        "image_url" => {
            let image_url = input.get("image_url")?;
            let url = image_url
                .as_str()
                .or_else(|| image_url.get("url").and_then(Value::as_str))
                .unwrap_or_default();
            Some(serde_json::json!({"type": "image_url", "image_url": url}))
        }
        "input_audio" => {
            let audio = input.get("input_audio")?.as_object()?;
            let data = audio.get("data")?.as_str()?;
            let format = audio.get("format")?.as_str()?;
            Some(serde_json::json!({
                "type": "input_audio",
                "input_audio": {"data": data, "format": format}
            }))
        }
        "file" => {
            let file = input.get("file")?.as_object()?;
            let mut normalized = Map::new();
            if let Some(file_id) = file.get("file_id").and_then(Value::as_str) {
                if !file_id.is_empty() {
                    normalized.insert("file_id".to_string(), Value::String(file_id.to_string()));
                }
            } else {
                let filename = file.get("filename")?.as_str()?;
                let file_data = file.get("file_data")?.as_str()?;
                if !filename.is_empty() {
                    normalized.insert("filename".to_string(), Value::String(filename.to_string()));
                }
                if !file_data.is_empty() {
                    normalized.insert(
                        "file_data".to_string(),
                        Value::String(file_data.to_string()),
                    );
                }
            }
            Some(serde_json::json!({"type": "file", "file": normalized}))
        }
        "video_url" => {
            let url = input.get("video_url")?.as_str()?;
            Some(serde_json::json!({"type": "video_url", "video_url": {"url": url}}))
        }
        _ => None,
    }
}

fn copy_nonempty_string(input: &Map<String, Value>, output: &mut Map<String, Value>, key: &str) {
    if let Some(value) = input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        output.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn copy_typed(
    input: &Map<String, Value>,
    output: &mut Map<String, Value>,
    key: &str,
    predicate: impl Fn(&Value) -> bool,
) {
    if let Some(value) = input.get(key).filter(|value| predicate(value)) {
        output.insert(key.to_string(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mistral_url_uses_v1_and_honors_overrides() {
        assert_eq!(
            mistral_openai_url(None, "chat/completions"),
            "https://api.mistral.ai/v1/chat/completions"
        );
        assert_eq!(
            mistral_openai_url(Some("https://mistral.example/v1/"), "/chat/completions"),
            "https://mistral.example/v1/chat/completions"
        );
    }

    #[test]
    fn tool_call_ids_are_valid_consistent_and_preserve_valid_ids() {
        let mut body = json!({
            "model": "mistral-large-latest",
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call-too-long",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "{}"}
                    }]
                },
                {"role": "tool", "tool_call_id": "call-too-long", "content": "ok"},
                {"role": "tool", "tool_call_id": "Abc123xyz", "content": "valid"}
            ]
        });

        apply_mistral_chat_request(&mut body, || Some("A1b2C3d4E".to_string())).unwrap();
        assert_eq!(body["messages"][0]["tool_calls"][0]["id"], "A1b2C3d4E");
        assert_eq!(body["messages"][1]["tool_call_id"], "A1b2C3d4E");
        assert_eq!(body["messages"][2]["tool_call_id"], "Abc123xyz");
        assert_eq!(body["messages"][0]["content"], json!([]));
    }

    #[test]
    fn request_shape_matches_the_go_mistral_whitelist() {
        let mut body = json!({
            "model": "mistral-large-latest",
            "stream": false,
            "messages": [{
                "role": "user",
                "name": "removed",
                "content": [
                    {"type": "text", "text": "inspect"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/a.png", "detail": "high"}},
                    {"type": "unknown", "value": "removed"}
                ]
            }],
            "temperature": 0.0,
            "top_p": 0.9,
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}, "extra": true}],
            "tool_choice": "auto",
            "max_tokens": 100,
            "max_completion_tokens": 40,
            "frequency_penalty": 1,
            "user": "removed",
            "stream_options": {"include_usage": true}
        });

        apply_mistral_chat_request(&mut body, || unreachable!()).unwrap();
        assert_eq!(body["max_tokens"], 40);
        assert_eq!(
            body["messages"][0]["content"][1]["image_url"],
            "https://example.com/a.png"
        );
        assert!(body["messages"][0].get("name").is_none());
        assert!(body.get("frequency_penalty").is_none());
        assert!(body.get("user").is_none());
        assert!(body.get("stream_options").is_none());
        assert!(body["tools"][0].get("extra").is_none());
    }

    #[test]
    fn max_token_presence_matches_go_pointer_semantics() {
        let mut body = json!({"model": "m", "messages": [], "max_completion_tokens": 0});
        apply_mistral_chat_request(&mut body, || unreachable!()).unwrap();
        assert_eq!(body["max_tokens"], 0);
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("messages").is_none());
    }

    #[test]
    fn multimodal_audio_file_and_video_parts_keep_the_go_shape() {
        let mut body = json!({
            "model": "mistral-large-latest",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "input_audio", "input_audio": {"data": "YWJj", "format": "wav"}},
                    {"type": "file", "file": {"filename": "notes.txt", "file_data": "ZGF0YQ=="}},
                    {"type": "file", "file": {"file_id": "file-123"}},
                    {"type": "video_url", "video_url": "https://example.com/demo.mp4"}
                ]
            }]
        });

        apply_mistral_chat_request(&mut body, || unreachable!()).unwrap();
        assert_eq!(
            body["messages"][0]["content"],
            json!([
                {"type": "input_audio", "input_audio": {"data": "YWJj", "format": "wav"}},
                {"type": "file", "file": {"filename": "notes.txt", "file_data": "ZGF0YQ=="}},
                {"type": "file", "file": {"file_id": "file-123"}},
                {"type": "video_url", "video_url": {"url": "https://example.com/demo.mp4"}}
            ])
        );
    }

    #[test]
    fn tool_result_before_call_uses_one_request_local_id_mapping() {
        let mut generated = ["A1b2C3d4E", "F5g6H7i8J"].into_iter();
        let mut body = json!({
            "model": "mistral-large-latest",
            "messages": [
                {"role": "tool", "tool_call_id": "late-call", "content": "ready"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "late-call", "type": "function", "function": {"name": "late"}},
                        {"id": "second-call", "type": "function", "function": {"name": "second"}}
                    ]
                }
            ]
        });

        apply_mistral_chat_request(&mut body, || generated.next().map(str::to_string)).unwrap();
        assert_eq!(body["messages"][0]["tool_call_id"], "A1b2C3d4E");
        assert_eq!(body["messages"][1]["tool_calls"][0]["id"], "A1b2C3d4E");
        assert_eq!(body["messages"][1]["tool_calls"][1]["id"], "F5g6H7i8J");
    }

    #[test]
    fn invalid_or_missing_generated_ids_fail_closed() {
        let source = json!({
            "model": "m",
            "messages": [{
                "role": "assistant",
                "tool_calls": [{"id": "bad", "type": "function", "function": {"name": "x"}}]
            }]
        });
        let mut missing = source.clone();
        assert_eq!(
            apply_mistral_chat_request(&mut missing, || None).unwrap_err(),
            MistralRequestTransformError::ToolCallIdGenerationFailed
        );
        let mut invalid = source;
        assert_eq!(
            apply_mistral_chat_request(&mut invalid, || Some("not-valid".to_string())).unwrap_err(),
            MistralRequestTransformError::ToolCallIdGenerationFailed
        );
    }
}
