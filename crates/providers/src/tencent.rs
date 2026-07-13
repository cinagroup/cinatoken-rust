use std::fmt;

use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use cinatoken_relay::UsageSummary;

pub const TENCENT_HUNYUAN_HOST: &str = "hunyuan.tencentcloudapi.com";
pub const TENCENT_HUNYUAN_ACTION: &str = "ChatCompletions";
pub const TENCENT_HUNYUAN_VERSION: &str = "2023-09-01";

const DEFAULT_BASE_URL: &str = "https://hunyuan.tencentcloudapi.com";
const SERVICE: &str = "hunyuan";
const ALGORITHM: &str = "TC3-HMAC-SHA256";
const SIGNED_HEADERS: &str = "content-type;host;x-tc-action";

pub struct TencentCredentials<'a> {
    pub app_id: i64,
    pub secret_id: &'a str,
    pub secret_key: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TencentTc3Headers {
    pub authorization: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TencentProviderError {
    pub code: String,
    pub message: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TencentResponseError {
    Malformed(&'static str),
    Provider(TencentProviderError),
}

impl fmt::Display for TencentResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(reason) => write!(f, "{reason}"),
            Self::Provider(error) => write!(f, "{}: {}", error.code, error.message),
        }
    }
}

impl std::error::Error for TencentResponseError {}

pub fn tencent_hunyuan_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    if endpoint_path.trim().trim_start_matches('/') != "chat/completions" {
        return None;
    }
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/');
    (base == DEFAULT_BASE_URL).then(|| format!("{DEFAULT_BASE_URL}/"))
}

pub fn parse_tencent_key(key: &str) -> Result<TencentCredentials<'_>, &'static str> {
    let key = key.trim().strip_prefix("Bearer ").unwrap_or(key.trim());
    let mut parts = key.split('|');
    let app_id = parts
        .next()
        .ok_or("app id is required")?
        .trim()
        .parse::<i64>()
        .map_err(|_| "app id must be an integer")?;
    let secret_id = parts.next().ok_or("secret id is required")?.trim();
    let secret_key = parts.next().ok_or("secret key is required")?.trim();
    if parts.next().is_some() {
        return Err("credential must contain exactly three fields");
    }
    if secret_id.is_empty() {
        return Err("secret id is required");
    }
    if secret_key.is_empty() {
        return Err("secret key is required");
    }
    Ok(TencentCredentials {
        app_id,
        secret_id,
        secret_key,
    })
}

pub fn apply_tencent_chat_request(body: &mut Value) -> Result<(), &'static str> {
    let source = body
        .as_object()
        .ok_or("chat request must be a JSON object")?;
    reject_unsupported_fields(
        source,
        &["model", "messages", "stream", "top_p", "temperature"],
        "Tencent chat request contains an unsupported field",
    )?;
    if source.get("stream").and_then(Value::as_bool) == Some(true) {
        return Err("streaming Tencent relay is not implemented");
    }
    let model = required_non_empty_string(source, "model", "model is required")?;
    let messages = source
        .get("messages")
        .and_then(Value::as_array)
        .filter(|messages| !messages.is_empty())
        .ok_or("messages must be a non-empty array")?;

    let mut converted_messages = Vec::with_capacity(messages.len());
    for message in messages {
        let message = message
            .as_object()
            .ok_or("each message must be a JSON object")?;
        reject_unsupported_fields(
            message,
            &["role", "content"],
            "Tencent chat message contains an unsupported field",
        )?;
        let role = required_non_empty_string(message, "role", "message role is required")?;
        let content = openai_text_content(
            message
                .get("content")
                .ok_or("message content is required")?,
        )?;
        if content.is_empty() {
            return Err("message content must contain text");
        }
        converted_messages.push(json!({"Role": role, "Content": content}));
    }

    let mut converted = Map::new();
    converted.insert("Model".to_string(), Value::String(model.to_string()));
    converted.insert("Messages".to_string(), Value::Array(converted_messages));
    for (source_name, target_name) in [("top_p", "TopP"), ("temperature", "Temperature")] {
        if let Some(value) = source.get(source_name).filter(|value| !value.is_null()) {
            if value.as_f64().is_none() {
                return Err("sampling parameters must be numbers");
            }
            converted.insert(target_name.to_string(), value.clone());
        }
    }
    if let Some(stream) = source.get("stream").filter(|value| !value.is_null()) {
        let stream = stream.as_bool().ok_or("stream must be a boolean")?;
        converted.insert("Stream".to_string(), Value::Bool(stream));
    }
    *body = Value::Object(converted);
    Ok(())
}

pub fn tencent_tc3_headers(
    body: &str,
    credentials: &TencentCredentials<'_>,
    timestamp: i64,
) -> Result<TencentTc3Headers, &'static str> {
    if timestamp < 0 {
        return Err("timestamp must be non-negative");
    }
    let timestamp = timestamp.to_string();
    let date = utc_date_from_unix_seconds(timestamp.parse().map_err(|_| "invalid timestamp")?);
    let canonical_headers = format!(
        "content-type:application/json\nhost:{TENCENT_HUNYUAN_HOST}\nx-tc-action:{}\n",
        TENCENT_HUNYUAN_ACTION.to_ascii_lowercase()
    );
    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}\n{SIGNED_HEADERS}\n{}",
        sha256_hex(body.as_bytes())
    );
    let credential_scope = format!("{date}/{SERVICE}/tc3_request");
    let string_to_sign = format!(
        "{ALGORITHM}\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let secret_date = hmac_sha256(
        format!("TC3{}", credentials.secret_key).as_bytes(),
        date.as_bytes(),
    );
    let secret_service = hmac_sha256(&secret_date, SERVICE.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex_encode(&hmac_sha256(&secret_signing, string_to_sign.as_bytes()));
    let authorization = format!(
        "{ALGORITHM} Credential={}/{credential_scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}",
        credentials.secret_id
    );
    Ok(TencentTc3Headers {
        authorization,
        timestamp,
    })
}

pub fn transform_tencent_chat_response_body(
    body: &str,
    model: &str,
    created_fallback: i64,
) -> Result<(String, UsageSummary, Option<String>), TencentResponseError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| TencentResponseError::Malformed("response is not valid JSON"))?;
    let root = value.get("Response").unwrap_or(&value);
    let root = root.as_object().ok_or(TencentResponseError::Malformed(
        "response must be a JSON object",
    ))?;
    let request_id = optional_non_empty_string(root, &["RequestId", "Req_id"]);

    if let Some(error) = root.get("Error").and_then(Value::as_object) {
        if let Some(code) = non_empty_error_code(error.get("Code")) {
            let message = error
                .get("Message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Tencent provider rejected the request")
                .to_string();
            return Err(TencentResponseError::Provider(TencentProviderError {
                code,
                message,
                request_id,
            }));
        }
    }

    let usage_object = root
        .get("Usage")
        .and_then(Value::as_object)
        .ok_or(TencentResponseError::Malformed("response usage is missing"))?;
    let prompt_tokens = required_token_count(usage_object, "PromptTokens")?;
    let completion_tokens = required_token_count(usage_object, "CompletionTokens")?;
    let total_tokens = required_token_count(usage_object, "TotalTokens")?;
    let usage = UsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        ..UsageSummary::default()
    };

    let choices = root
        .get("Choices")
        .and_then(Value::as_array)
        .filter(|choices| !choices.is_empty())
        .ok_or(TencentResponseError::Malformed(
            "response choices are missing",
        ))?;
    let mut converted_choices = Vec::with_capacity(choices.len());
    for (position, choice) in choices.iter().enumerate() {
        let choice = choice.as_object().ok_or(TencentResponseError::Malformed(
            "response choice is invalid",
        ))?;
        let message = choice.get("Message").and_then(Value::as_object).ok_or(
            TencentResponseError::Malformed("response choice message is missing"),
        )?;
        let content = message.get("Content").and_then(Value::as_str).ok_or(
            TencentResponseError::Malformed("response choice content is missing"),
        )?;
        let role = message
            .get("Role")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("assistant");
        let index = choice
            .get("Index")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(position);
        let finish_reason = choice
            .get("FinishReason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
        converted_choices.push(json!({
            "index": index,
            "message": {"role": role, "content": content},
            "finish_reason": finish_reason,
        }));
    }

    let id = optional_non_empty_string(root, &["Id"])
        .or_else(|| request_id.clone())
        .unwrap_or_else(|| "chatcmpl-tencent".to_string());
    let created = root
        .get("Created")
        .and_then(Value::as_i64)
        .unwrap_or(created_fallback);
    let mut output = json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": converted_choices,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        },
    });
    if let Some(note) = root
        .get("Note")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        output
            .as_object_mut()
            .expect("Tencent response output is an object")
            .insert("note".to_string(), Value::String(note.to_string()));
    }
    let output = serde_json::to_string(&output)
        .map_err(|_| TencentResponseError::Malformed("response serialization failed"))?;
    Ok((output, usage, request_id))
}

fn required_non_empty_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    error: &'static str,
) -> Result<&'a str, &'static str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(error)
}

fn openai_text_content(value: &Value) -> Result<String, &'static str> {
    if let Some(content) = value.as_str() {
        return Ok(content.to_string());
    }
    let items = value
        .as_array()
        .ok_or("message content must be text or an array")?;
    let mut output = String::new();
    for item in items {
        let item = item
            .as_object()
            .ok_or("message content items must be JSON objects")?;
        if item.get("type").and_then(Value::as_str) != Some("text") {
            return Err("Tencent chat currently supports text content only");
        }
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .ok_or("text content item is missing text")?;
        output.push_str(text);
    }
    Ok(output)
}

fn reject_unsupported_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    error: &'static str,
) -> Result<(), &'static str> {
    if object
        .iter()
        .any(|(key, value)| !value.is_null() && !allowed.contains(&key.as_str()))
    {
        Err(error)
    } else {
        Ok(())
    }
}

fn optional_non_empty_string(object: &Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn non_empty_error_code(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => {
            let value = value.trim();
            (!value.is_empty() && value != "0").then(|| value.to_string())
        }
        Some(Value::Number(value)) => value
            .as_i64()
            .filter(|value| *value != 0)
            .map(|value| value.to_string()),
        _ => None,
    }
}

fn required_token_count(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<i32, TencentResponseError> {
    object
        .get(field)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or(TencentResponseError::Malformed(
            "response usage token count is invalid",
        ))
}

fn sha256_hex(value: &[u8]) -> String {
    hex_encode(&Sha256::digest(value))
}

fn hmac_sha256(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(value);
    mac.finalize().into_bytes().to_vec()
}

fn hex_encode(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn utc_date_from_unix_seconds(timestamp: i64) -> String {
    let z = timestamp.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_fixed_to_the_signed_official_host_and_chat_route() {
        assert_eq!(
            tencent_hunyuan_url(None, "chat/completions").as_deref(),
            Some("https://hunyuan.tencentcloudapi.com/")
        );
        assert_eq!(
            tencent_hunyuan_url(
                Some("https://hunyuan.tencentcloudapi.com/"),
                "/chat/completions"
            )
            .as_deref(),
            Some("https://hunyuan.tencentcloudapi.com/")
        );
        assert!(tencent_hunyuan_url(Some("https://proxy.example"), "chat/completions").is_none());
        assert!(tencent_hunyuan_url(None, "embeddings").is_none());
    }

    #[test]
    fn key_parser_preserves_source_three_part_contract() {
        let parsed = parse_tencent_key("123|AKID-test|secret-test").unwrap();
        assert_eq!(parsed.app_id, 123);
        assert_eq!(parsed.secret_id, "AKID-test");
        assert_eq!(parsed.secret_key, "secret-test");
        assert!(parse_tencent_key("123|AKID-test").is_err());
        assert!(parse_tencent_key("123|AKID-test|secret|extra").is_err());
        assert!(parse_tencent_key("not-an-int|AKID-test|secret").is_err());
        assert!(parse_tencent_key("123||secret").is_err());
    }

    #[test]
    fn request_transform_matches_source_pascal_case_text_shape() {
        let mut body = json!({
            "model": "hunyuan-turbo",
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "text", "text": " world"}
                ]}
            ],
            "stream": false,
            "top_p": 0.8,
            "temperature": 0.2
        });
        apply_tencent_chat_request(&mut body).unwrap();
        assert_eq!(
            body,
            json!({
                "Model": "hunyuan-turbo",
                "Messages": [
                    {"Role": "system", "Content": "be brief"},
                    {"Role": "user", "Content": "hello world"}
                ],
                "Stream": false,
                "TopP": 0.8,
                "Temperature": 0.2
            })
        );
    }

    #[test]
    fn request_transform_rejects_stream_and_non_text_messages() {
        let mut streaming = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        });
        assert_eq!(
            apply_tencent_chat_request(&mut streaming),
            Err("streaming Tencent relay is not implemented")
        );

        let mut image_only = json!({
            "model": "hunyuan-vision",
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "https://example.test/a.png"}}
            ]}]
        });
        assert_eq!(
            apply_tencent_chat_request(&mut image_only),
            Err("Tencent chat currently supports text content only")
        );

        for (field, value) in [
            ("max_tokens", json!(100)),
            ("tools", json!([{"type": "function"}])),
            ("response_format", json!({"type": "json_object"})),
        ] {
            let mut unsupported = json!({
                "model": "hunyuan-turbo",
                "messages": [{"role": "user", "content": "hello"}]
            });
            unsupported
                .as_object_mut()
                .unwrap()
                .insert(field.to_string(), value);
            assert_eq!(
                apply_tencent_chat_request(&mut unsupported),
                Err("Tencent chat request contains an unsupported field")
            );
        }

        let mut tool_message = json!({
            "model": "hunyuan-turbo",
            "messages": [{"role": "assistant", "content": "", "tool_calls": []}]
        });
        assert_eq!(
            apply_tencent_chat_request(&mut tool_message),
            Err("Tencent chat message contains an unsupported field")
        );
    }

    #[test]
    fn tc3_signature_is_stable_and_uses_utc_date() {
        let credentials = parse_tencent_key("1250000000|AKIDEXAMPLE|secretEXAMPLE").unwrap();
        let body = r#"{"Model":"hunyuan-turbo","Messages":[{"Role":"user","Content":"hello"}],"Stream":false}"#;
        let headers = tencent_tc3_headers(body, &credentials, 1_550_000_000).unwrap();
        assert_eq!(headers.timestamp, "1550000000");
        assert_eq!(
            headers.authorization,
            "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-12/hunyuan/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=b2171ef0a5cdf0ff68a355b8f702bfb1cef2e6e43f531035ef56fcaee8b3c8fc"
        );
    }

    #[test]
    fn response_transform_accepts_enveloped_success_and_maps_usage() {
        let (body, usage, request_id) = transform_tencent_chat_response_body(
            r#"{"Response":{"RequestId":"req-1","Id":"chat-1","Created":1710902312,"Choices":[{"Message":{"Role":"assistant","Content":"hello"},"FinishReason":"stop"}],"Usage":{"PromptTokens":3,"CompletionTokens":2,"TotalTokens":5}}}"#,
            "hunyuan-turbo",
            1,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["id"], "chat-1");
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["model"], "hunyuan-turbo");
        assert_eq!(body["choices"][0]["message"]["content"], "hello");
        assert_eq!(body["usage"]["total_tokens"], 5);
        assert!(body.get("note").is_none());
        assert_eq!(usage.prompt_tokens, 3);
        assert_eq!(usage.completion_tokens, 2);
        assert_eq!(usage.total_tokens, 5);
        assert_eq!(request_id.as_deref(), Some("req-1"));
    }

    #[test]
    fn response_transform_accepts_direct_success_and_detects_string_error_code() {
        let (body, usage, _) = transform_tencent_chat_response_body(
            r#"{"Id":"chat-2","Choices":[{"Message":{"Content":"ok"},"FinishReason":"stop"}],"Usage":{"PromptTokens":1,"CompletionTokens":1,"TotalTokens":2}}"#,
            "hunyuan-turbo",
            99,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["created"], 99);
        assert_eq!(usage.total_tokens, 2);

        assert_eq!(
            transform_tencent_chat_response_body(
                r#"{"Response":{"RequestId":"req-error","Error":{"Code":"InvalidParameter","Message":"bad temperature"}}}"#,
                "hunyuan-turbo",
                1,
            ),
            Err(TencentResponseError::Provider(TencentProviderError {
                code: "InvalidParameter".to_string(),
                message: "bad temperature".to_string(),
                request_id: Some("req-error".to_string()),
            }))
        );
    }

    #[test]
    fn response_transform_preserves_provider_note_extension() {
        let (body, _, _) = transform_tencent_chat_response_body(
            r#"{"Note":"provider disclosure","Choices":[{"Message":{"Content":"ok"}}],"Usage":{"PromptTokens":1,"CompletionTokens":1,"TotalTokens":2}}"#,
            "hunyuan-turbo",
            1,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["note"], "provider disclosure");
    }

    #[test]
    fn utc_date_handles_epoch_and_midnight_boundaries() {
        assert_eq!(utc_date_from_unix_seconds(0), "1970-01-01");
        assert_eq!(utc_date_from_unix_seconds(1_550_016_000), "2019-02-13");
    }

    #[test]
    fn response_transform_rejects_missing_billable_usage() {
        assert_eq!(
            transform_tencent_chat_response_body(
                r#"{"Choices":[{"Message":{"Content":"ok"}}]}"#,
                "hunyuan-turbo",
                1,
            ),
            Err(TencentResponseError::Malformed("response usage is missing"))
        );
    }
}
