use std::fmt;

use cinatoken_relay::{clamp_i64_to_i32, UsageSummary};
use serde_json::{json, Map, Value};

const DEFAULT_ROOT: &str = "https://dashscope.aliyuncs.com";
const DEFAULT_ANTHROPIC_MESSAGES_MODELS: &str = "qwen,deepseek-v4,kimi,glm,minimax-m";
const DEFAULT_SYNC_IMAGE_MODELS: &str = "z-image,qwen-image,wan2.6,wan2.7,qwen-image-edit,qwen-image-edit-max,qwen-image-edit-max-2026-01-16,qwen-image-edit-plus,qwen-image-edit-plus-2025-12-15,qwen-image-edit-plus-2025-10-30";
const OPENAI_ENDPOINTS: &[&str] = &["chat/completions", "completions", "embeddings", "responses"];
const RERANK_PATH: &str = "api/v1/services/rerank/text-rerank/text-rerank";
const SYNC_IMAGE_PATH: &str = "api/v1/services/aigc/multimodal-generation/generation";
const MAX_IMAGE_COUNT: u32 = 1_024;

#[derive(Debug)]
pub enum AliRerankResponseError {
    InvalidJson(serde_json::Error),
    ProviderError(String),
    MissingResults,
    InvalidUsage,
    Serialize(serde_json::Error),
}

impl fmt::Display for AliRerankResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(f, "invalid JSON: {error}"),
            Self::ProviderError(message) => write!(f, "provider error: {message}"),
            Self::MissingResults => write!(f, "response output.results must be an array"),
            Self::InvalidUsage => write!(f, "response usage.total_tokens must be non-negative"),
            Self::Serialize(error) => write!(f, "failed to serialize response: {error}"),
        }
    }
}

impl std::error::Error for AliRerankResponseError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AliImageCountSource {
    ProviderUsage,
    ConvertedResponse,
    RequestedCount,
}

impl AliImageCountSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderUsage => "provider_usage_image_count",
            Self::ConvertedResponse => "converted_response_data",
            Self::RequestedCount => "requested_count_fallback",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliImageResponse {
    pub body: String,
    pub actual_image_count: u32,
    pub converted_image_count: u32,
    pub count_source: AliImageCountSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AliImageError {
    UnsupportedModel,
    InvalidRequest(&'static str),
    InvalidResponse(&'static str),
    Provider(String),
    Serialize(String),
}

impl fmt::Display for AliImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedModel => write!(f, "model is not a synchronous Ali image model"),
            Self::InvalidRequest(reason) => write!(f, "invalid image request: {reason}"),
            Self::InvalidResponse(reason) => write!(f, "invalid image response: {reason}"),
            Self::Provider(message) => write!(f, "provider error: {message}"),
            Self::Serialize(message) => write!(f, "failed to serialize image response: {message}"),
        }
    }
}

impl std::error::Error for AliImageError {}

pub fn ali_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    if matches!(endpoint_path, "images/generations" | "images/edits") {
        if has_ambiguous_v1_base(base_url) {
            return None;
        }
        return Some(format!(
            "{}/{SYNC_IMAGE_PATH}",
            normalized_root(base_url).trim_end_matches('/')
        ));
    }
    if !OPENAI_ENDPOINTS.contains(&endpoint_path) && endpoint_path != "rerank" {
        return None;
    }
    if endpoint_path == "rerank" {
        if has_ambiguous_v1_base(base_url) {
            return None;
        }
        return Some(format!(
            "{}/{RERANK_PATH}",
            normalized_root(base_url).trim_end_matches('/')
        ));
    }
    Some(format!(
        "{}/{endpoint_path}",
        normalized_openai_base(base_url).trim_end_matches('/')
    ))
}

pub fn ali_messages_url(base_url: Option<&str>) -> Option<String> {
    let base = configured_base(base_url);
    if base.ends_with("/apps/anthropic/v1") {
        return Some(format!("{base}/messages"));
    }
    if base.ends_with("/apps/anthropic") {
        return Some(format!("{base}/v1/messages"));
    }
    if has_ambiguous_v1_base(base_url) {
        return None;
    }
    Some(format!(
        "{}/apps/anthropic/v1/messages",
        normalized_root(base_url)
    ))
}

pub fn supports_ali_anthropic_messages(model: &str) -> bool {
    supports_ali_anthropic_messages_with_config(model, None)
}

pub fn supports_ali_anthropic_messages_with_config(
    model: &str,
    configured_patterns: Option<&str>,
) -> bool {
    let model = model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return false;
    }
    configured_patterns
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ANTHROPIC_MESSAGES_MODELS)
        .split(',')
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .take(32)
        .any(|pattern| model.contains(&pattern.to_ascii_lowercase()))
}

pub fn supports_ali_native_rerank(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("gte-rerank-v2")
}

pub fn supports_ali_sync_image_generation(model: &str) -> bool {
    supports_ali_sync_image_generation_with_config(model, None)
}

pub fn supports_ali_sync_image_generation_with_config(
    model: &str,
    configured_patterns: Option<&str>,
) -> bool {
    let model = model.trim().to_ascii_lowercase();
    if model.is_empty() {
        return false;
    }
    configured_patterns
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SYNC_IMAGE_MODELS)
        .split(',')
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty() && pattern.len() <= 128)
        .take(32)
        .any(|pattern| model.contains(&pattern.to_ascii_lowercase()))
}

pub fn supports_ali_sync_image_edit(model: &str) -> bool {
    supports_ali_sync_image_edit_with_config(model, None)
}

pub fn supports_ali_sync_image_edit_with_config(
    model: &str,
    configured_patterns: Option<&str>,
) -> bool {
    supports_ali_sync_image_generation_with_config(model, configured_patterns)
        && !model.trim().to_ascii_lowercase().contains("wan")
}

pub fn ali_plugin_header_value(value: &str) -> Result<Option<&str>, &'static str> {
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 4_096 {
        return Err("Ali plugin header exceeds 4096 bytes");
    }
    if !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() && byte != b'\t')
    {
        return Err("Ali plugin header must contain printable ASCII or tab only");
    }
    Ok(Some(value))
}

pub fn apply_ali_request(body: &mut Value, endpoint_path: &str) {
    match endpoint_path.trim().trim_start_matches('/') {
        "chat/completions" | "completions" => clamp_openai_top_p(body),
        "rerank" => convert_rerank_request(body),
        _ => {}
    }
}

pub fn apply_ali_sync_image_generation_request(body: &mut Value) -> Result<u32, AliImageError> {
    apply_ali_sync_image_generation_request_with_config(body, None)
}

pub fn apply_ali_sync_image_generation_request_with_config(
    body: &mut Value,
    configured_patterns: Option<&str>,
) -> Result<u32, AliImageError> {
    let source = body
        .as_object()
        .ok_or(AliImageError::InvalidRequest("body must be an object"))?;
    let model = source
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(AliImageError::InvalidRequest(
            "model must be a non-empty string",
        ))?;
    if !supports_ali_sync_image_generation_with_config(model, configured_patterns) {
        return Err(AliImageError::UnsupportedModel);
    }
    if source
        .get("stream")
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
    {
        return Err(AliImageError::InvalidRequest(
            "synchronous image generation does not support streaming",
        ));
    }
    let requested_count = ali_image_request_count(source)?;
    let response_format = ali_image_response_format(source.get("response_format"))?;
    let native_parameters_supplied = source.contains_key("parameters");

    let mut parameters = match source.get("parameters") {
        Some(Value::Object(parameters)) => parameters.clone(),
        Some(Value::Null) | None => Map::new(),
        Some(_) => {
            return Err(AliImageError::InvalidRequest(
                "parameters must be an object",
            ))
        }
    };
    if native_parameters_supplied {
        if parameters
            .get("n")
            .is_some_and(|value| value.is_null() || value.as_u64() == Some(0))
        {
            parameters.remove("n");
        }
    } else if source.get("n").and_then(Value::as_u64) == Some(0) {
        parameters.remove("n");
    } else {
        parameters.insert("n".to_string(), Value::from(requested_count));
    }
    if !parameters.contains_key("size") {
        if let Some(size) = source.get("size").and_then(Value::as_str) {
            parameters.insert("size".to_string(), Value::String(size.replace('x', "*")));
        }
    }
    if !parameters.contains_key("watermark") {
        if let Some(watermark) = source.get("watermark").filter(|value| value.is_boolean()) {
            parameters.insert("watermark".to_string(), watermark.clone());
        }
    }

    let input = match source.get("input") {
        Some(value) if !value.is_null() => value.clone(),
        _ => {
            let prompt = source
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(AliImageError::InvalidRequest(
                    "prompt is required when input is absent",
                ))?;
            json!({
                "messages": [{
                    "role": "user",
                    "content": [{"text": prompt}],
                }]
            })
        }
    };

    *body = json!({
        "model": model,
        "input": input,
        "parameters": Value::Object(parameters),
        "response_format": response_format,
    });
    Ok(requested_count)
}

pub fn ali_sync_image_edit_request(
    model: &str,
    prompt: &str,
    images: &[String],
    requested_count: u32,
    watermark: Option<bool>,
    response_format: Option<&str>,
) -> Result<Value, AliImageError> {
    ali_sync_image_edit_request_with_config(
        model,
        prompt,
        images,
        requested_count,
        watermark,
        response_format,
        None,
    )
}

pub fn ali_sync_image_edit_request_with_config(
    model: &str,
    prompt: &str,
    images: &[String],
    requested_count: u32,
    watermark: Option<bool>,
    response_format: Option<&str>,
    configured_patterns: Option<&str>,
) -> Result<Value, AliImageError> {
    let model = model.trim();
    if !supports_ali_sync_image_edit_with_config(model, configured_patterns) {
        return Err(AliImageError::UnsupportedModel);
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AliImageError::InvalidRequest("prompt must be non-empty"));
    }
    if images.is_empty() || images.iter().any(|image| !image.starts_with("data:image/")) {
        return Err(AliImageError::InvalidRequest(
            "at least one image data URL is required",
        ));
    }
    let requested_count = validate_image_count(requested_count)?;
    let response_format = ali_image_response_format(response_format.map(Value::from).as_ref())?;
    let mut content = images
        .iter()
        .map(|image| json!({"image": image}))
        .collect::<Vec<_>>();
    content.push(json!({"text": prompt}));
    let mut parameters = Map::new();
    parameters.insert("n".to_string(), Value::from(requested_count));
    if let Some(watermark) = watermark {
        parameters.insert("watermark".to_string(), Value::Bool(watermark));
    }
    Ok(json!({
        "model": model,
        "input": {
            "messages": [{"role": "user", "content": content}],
        },
        "parameters": Value::Object(parameters),
        "response_format": response_format,
    }))
}

pub fn transform_ali_image_response_body(
    body: &str,
    response_format: Option<&str>,
    requested_count: u32,
    created_at: i64,
) -> Result<AliImageResponse, AliImageError> {
    let value = serde_json::from_str::<Value>(body)
        .map_err(|_| AliImageError::InvalidResponse("body must be valid JSON"))?;
    if let Some(message) = ali_provider_error(&value) {
        return Err(AliImageError::Provider(message));
    }
    let requested_count = validate_image_count(requested_count)?;
    let response_format = ali_image_response_format(response_format.map(Value::from).as_ref())?;
    let mut data = Vec::new();
    if let Some(results) = value.pointer("/output/results").and_then(Value::as_array) {
        for result in results {
            if let Some(image) = convert_ali_result_image(result, response_format)? {
                data.push(image);
            }
        }
    } else if let Some(choices) = value.pointer("/output/choices").and_then(Value::as_array) {
        for choice in choices {
            data.extend(convert_ali_choice_images(choice, response_format)?);
        }
    } else if value.get("output").is_none() {
        return Err(AliImageError::InvalidResponse("output is missing"));
    }
    let converted_image_count = u32::try_from(data.len()).unwrap_or(u32::MAX);
    if converted_image_count > MAX_IMAGE_COUNT {
        return Err(AliImageError::InvalidResponse(
            "converted image count exceeds the safety bound",
        ));
    }
    let provider_count = match value.pointer("/usage/image_count") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64().and_then(|value| u32::try_from(value).ok()) {
            Some(0) => None,
            Some(value) if value <= MAX_IMAGE_COUNT => Some(value),
            _ => {
                return Err(AliImageError::InvalidResponse(
                    "usage.image_count must be a bounded non-negative integer",
                ))
            }
        },
    };
    let (actual_image_count, count_source) = if let Some(count) = provider_count {
        (count, AliImageCountSource::ProviderUsage)
    } else if converted_image_count > 0 {
        (
            converted_image_count,
            AliImageCountSource::ConvertedResponse,
        )
    } else {
        (requested_count, AliImageCountSource::RequestedCount)
    };
    let response = json!({
        "created": created_at,
        "data": data,
        "metadata": ali_image_response_metadata(&value),
    });
    let body = serde_json::to_string(&response)
        .map_err(|error| AliImageError::Serialize(error.to_string()))?;
    Ok(AliImageResponse {
        body,
        actual_image_count,
        converted_image_count,
        count_source,
    })
}

fn ali_image_request_count(source: &Map<String, Value>) -> Result<u32, AliImageError> {
    let value = if source.contains_key("parameters") {
        source
            .get("parameters")
            .and_then(Value::as_object)
            .and_then(|parameters| parameters.get("n"))
    } else {
        source.get("n")
    };
    match value {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(AliImageError::InvalidRequest(
                "n must be a positive integer",
            ))
            .and_then(validate_image_count),
    }
}

fn validate_image_count(value: u32) -> Result<u32, AliImageError> {
    let value = value.max(1);
    (value <= MAX_IMAGE_COUNT)
        .then_some(value)
        .ok_or(AliImageError::InvalidRequest(
            "n exceeds the supported image count bound",
        ))
}

fn ali_image_response_format(value: Option<&Value>) -> Result<&'static str, AliImageError> {
    match value.and_then(Value::as_str).unwrap_or("url") {
        "url" | "" => Ok("url"),
        "b64_json" => Ok("b64_json"),
        _ => Err(AliImageError::InvalidRequest(
            "response_format must be url or b64_json",
        )),
    }
}

fn ali_provider_error(value: &Value) -> Option<String> {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    code.or(message).map(|fallback| {
        message
            .unwrap_or(fallback)
            .chars()
            .take(512)
            .collect::<String>()
    })
}

fn convert_ali_result_image(
    result: &Value,
    response_format: &str,
) -> Result<Option<Value>, AliImageError> {
    let url = result
        .get("url")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let b64 = result
        .get("b64_image")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    if response_format == "b64_json" {
        if let Some(value) = b64 {
            Ok(Some(json!({"b64_json": value})))
        } else if url.is_some() {
            Err(AliImageError::InvalidResponse(
                "b64_json response contains a remote URL without embedded image data",
            ))
        } else {
            Ok(None)
        }
    } else if let Some(url) = url {
        Ok(Some(json!({"url": url})))
    } else {
        Ok(b64.map(|value| json!({"b64_json": value})))
    }
}

fn convert_ali_choice_images(
    choice: &Value,
    response_format: &str,
) -> Result<Vec<Value>, AliImageError> {
    let Some(content) = choice.pointer("/message/content").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let revised_prompt = content
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .find(|value| !value.is_empty());
    let mut data = Map::new();
    for image in content
        .iter()
        .filter_map(|item| item.get("image").and_then(Value::as_str))
    {
        if image.starts_with("http://") || image.starts_with("https://") {
            if response_format == "b64_json" {
                return Err(AliImageError::InvalidResponse(
                    "b64_json response contains a remote URL without embedded image data",
                ));
            }
            data.insert("url".to_string(), Value::String(image.to_string()));
        } else {
            data.insert("b64_json".to_string(), Value::String(image.to_string()));
        }
    }
    if data.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(prompt) = revised_prompt {
        data.insert(
            "revised_prompt".to_string(),
            Value::String(prompt.to_string()),
        );
    }
    Ok(vec![Value::Object(data)])
}

fn ali_image_response_metadata(value: &Value) -> Value {
    let mut metadata = Map::new();
    if let Some(request_id) = value
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
    {
        metadata.insert(
            "request_id".to_string(),
            Value::String(request_id.to_string()),
        );
    }
    if let Some(usage) = value.get("usage").and_then(Value::as_object) {
        let mut bounded_usage = Map::new();
        for key in [
            "image_count",
            "input_tokens",
            "output_tokens",
            "total_tokens",
        ] {
            if let Some(number) = usage.get(key).filter(|value| value.is_number()) {
                bounded_usage.insert(key.to_string(), number.clone());
            }
        }
        if !bounded_usage.is_empty() {
            metadata.insert("usage".to_string(), Value::Object(bounded_usage));
        }
    }
    if let Some(output) = value.get("output").and_then(Value::as_object) {
        let mut bounded_output = Map::new();
        for key in ["task_id", "task_status", "finish_reason", "code", "message"] {
            if let Some(text) = output
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 512)
            {
                bounded_output.insert(key.to_string(), Value::String(text.to_string()));
            }
        }
        if !bounded_output.is_empty() {
            metadata.insert("output".to_string(), Value::Object(bounded_output));
        }
    }
    Value::Object(metadata)
}

pub fn transform_ali_rerank_response_body(
    body: &str,
) -> Result<(String, UsageSummary), AliRerankResponseError> {
    let value = serde_json::from_str::<Value>(body).map_err(AliRerankResponseError::InvalidJson)?;
    if let Some(code) = value
        .get("code")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(code);
        return Err(AliRerankResponseError::ProviderError(message.to_string()));
    }
    let results = value
        .pointer("/output/results")
        .filter(|value| value.is_array())
        .cloned()
        .ok_or(AliRerankResponseError::MissingResults)?;
    let total_tokens = match value.pointer("/usage/total_tokens") {
        None | Some(Value::Null) => 0,
        Some(value) => value
            .as_i64()
            .filter(|value| *value >= 0)
            .map(clamp_i64_to_i32)
            .ok_or(AliRerankResponseError::InvalidUsage)?,
    };
    let usage = UsageSummary {
        prompt_tokens: total_tokens,
        completion_tokens: 0,
        total_tokens,
        ..UsageSummary::default()
    };
    let response = json!({
        "results": results,
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
    });
    serde_json::to_string(&response)
        .map(|body| (body, usage))
        .map_err(AliRerankResponseError::Serialize)
}

fn clamp_openai_top_p(body: &mut Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let top_p = object.get("top_p").and_then(Value::as_f64).unwrap_or(0.0);
    let top_p = if top_p >= 1.0 {
        0.999
    } else if top_p <= 0.0 {
        0.001
    } else {
        top_p
    };
    object.insert("top_p".to_string(), Value::from(top_p));
}

fn convert_rerank_request(body: &mut Value) {
    let Some(source) = body.as_object() else {
        return;
    };
    let mut parameters = Map::new();
    if let Some(top_n) = source
        .get("top_n")
        .filter(|value| !value.is_null())
        .cloned()
    {
        parameters.insert("top_n".to_string(), top_n);
    }
    parameters.insert(
        "return_documents".to_string(),
        source
            .get("return_documents")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(Value::Bool(true)),
    );
    *body = json!({
        "model": source.get("model").cloned().unwrap_or(Value::Null),
        "input": {
            "query": source.get("query").cloned().unwrap_or(Value::Null),
            "documents": source.get("documents").cloned().unwrap_or(Value::Null),
        },
        "parameters": Value::Object(parameters),
    });
}

fn configured_base(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ROOT)
        .trim_end_matches('/')
        .to_string()
}

fn normalized_openai_base(base_url: Option<&str>) -> String {
    let base = configured_base(base_url);
    let root = strip_anthropic_suffix(&base);
    if root != base {
        return format!("{root}/compatible-mode/v1");
    }
    if base.ends_with("/compatible-mode/v1") || base.ends_with("/v1") {
        return base;
    }
    format!("{base}/compatible-mode/v1")
}

fn normalized_root(base_url: Option<&str>) -> String {
    let base = configured_base(base_url);
    if let Some(root) = base.strip_suffix("/compatible-mode/v1") {
        return root.to_string();
    }
    strip_anthropic_suffix(&base).to_string()
}

fn has_ambiguous_v1_base(base_url: Option<&str>) -> bool {
    let Some(base) = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/'))
    else {
        return false;
    };
    base.ends_with("/v1")
        && !base.ends_with("/compatible-mode/v1")
        && !base.ends_with("/apps/anthropic/v1")
}

fn strip_anthropic_suffix(base: &str) -> &str {
    base.strip_suffix("/apps/anthropic/v1")
        .or_else(|| base.strip_suffix("/apps/anthropic"))
        .unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_use_current_dashscope_contract_and_reject_unowned_families() {
        assert_eq!(
            ali_openai_url(None, "chat/completions").as_deref(),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
        );
        assert_eq!(
            ali_openai_url(None, "responses").as_deref(),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/responses")
        );
        assert_eq!(
            ali_openai_url(
                Some("https://workspace.example/compatible-mode/v1/"),
                "embeddings"
            )
            .as_deref(),
            Some("https://workspace.example/compatible-mode/v1/embeddings")
        );
        assert_eq!(
            ali_openai_url(None, "rerank").as_deref(),
            Some("https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank")
        );
        assert_eq!(
            ali_messages_url(None).as_deref(),
            Some("https://dashscope.aliyuncs.com/apps/anthropic/v1/messages")
        );
        assert_eq!(
            ali_messages_url(Some("https://workspace.example/apps/anthropic")).as_deref(),
            Some("https://workspace.example/apps/anthropic/v1/messages")
        );
        assert_eq!(
            ali_openai_url(
                Some("https://workspace.example/apps/anthropic/v1"),
                "completions"
            )
            .as_deref(),
            Some("https://workspace.example/compatible-mode/v1/completions")
        );
        for unsupported in ["audio/speech", "messages"] {
            assert!(ali_openai_url(None, unsupported).is_none());
        }
        assert!(ali_messages_url(Some("https://coding.example/v1")).is_none());
        assert!(ali_openai_url(Some("https://coding.example/v1"), "rerank").is_none());
        assert_eq!(
            ali_openai_url(Some("https://coding.example/v1"), "chat/completions").as_deref(),
            Some("https://coding.example/v1/chat/completions")
        );
    }

    #[test]
    fn message_model_allowlist_matches_the_source_native_bridge() {
        for model in [
            "qwen3.7-plus",
            "deepseek-v4",
            "kimi-k2",
            "glm-5",
            "MiniMax-M2",
        ] {
            assert!(supports_ali_anthropic_messages(model));
        }
        assert!(!supports_ali_anthropic_messages("claude-sonnet-4"));
        assert!(supports_ali_anthropic_messages_with_config(
            "custom-native-model",
            Some("custom-native")
        ));
        assert!(!supports_ali_anthropic_messages_with_config(
            "qwen-plus",
            Some("custom-native")
        ));
        assert!(supports_ali_native_rerank("GTE-RERANK-V2"));
        assert!(!supports_ali_native_rerank("qwen3-rerank"));
    }

    #[test]
    fn plugin_header_is_server_owned_and_bounded() {
        assert_eq!(ali_plugin_header_value("").unwrap(), None);
        assert_eq!(
            ali_plugin_header_value(r#"{"plugin":"web-search"}"#).unwrap(),
            Some(r#"{"plugin":"web-search"}"#)
        );
        assert!(ali_plugin_header_value("bad\r\nheader").is_err());
        assert!(ali_plugin_header_value(&"x".repeat(4_097)).is_err());
    }

    #[test]
    fn openai_top_p_matches_source_clamping() {
        let mut omitted = json!({"model": "qwen-plus"});
        apply_ali_request(&mut omitted, "chat/completions");
        assert_eq!(omitted["top_p"], 0.001);

        let mut high = json!({"model": "qwen-plus", "top_p": 1});
        apply_ali_request(&mut high, "completions");
        assert_eq!(high["top_p"], 0.999);

        let mut valid = json!({"model": "qwen-plus", "top_p": 0.4});
        apply_ali_request(&mut valid, "chat/completions");
        assert_eq!(valid["top_p"], 0.4);
    }

    #[test]
    fn rerank_contract_is_converted_in_both_directions() {
        let mut request = json!({
            "model": "gte-rerank-v2",
            "query": "hello",
            "documents": ["a", "b"],
            "top_n": 1
        });
        apply_ali_request(&mut request, "rerank");
        assert_eq!(request["input"]["query"], "hello");
        assert_eq!(request["parameters"]["top_n"], 1);
        assert_eq!(request["parameters"]["return_documents"], true);

        let mut nullable = json!({
            "model": "gte-rerank-v2",
            "query": "hello",
            "documents": ["a"],
            "top_n": null,
            "return_documents": null
        });
        apply_ali_request(&mut nullable, "rerank");
        assert!(nullable["parameters"].get("top_n").is_none());
        assert_eq!(nullable["parameters"]["return_documents"], true);

        let (body, usage) = transform_ali_rerank_response_body(
            r#"{"output":{"results":[{"index":0,"relevance_score":0.9}]},"usage":{"total_tokens":12}}"#,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["results"][0]["index"], 0);
        assert_eq!(body["usage"]["prompt_tokens"], 12);
        assert_eq!(usage.total_tokens, 12);

        let (body, usage) = transform_ali_rerank_response_body(
            r#"{"output":{"results":[{"index":0,"relevance_score":0.9}]}}"#,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["usage"]["total_tokens"], 0);
        assert_eq!(usage, UsageSummary::default());
    }

    #[test]
    fn malformed_rerank_success_bodies_fail_closed() {
        assert!(matches!(
            transform_ali_rerank_response_body(r#"{"output":{},"usage":{"total_tokens":1}}"#),
            Err(AliRerankResponseError::MissingResults)
        ));
        assert!(matches!(
            transform_ali_rerank_response_body(r#"{"code":"InvalidParameter","message":"bad"}"#),
            Err(AliRerankResponseError::ProviderError(_))
        ));
    }

    #[test]
    fn synchronous_image_routes_and_model_guards_are_explicit() {
        assert_eq!(
            ali_openai_url(None, "images/generations").as_deref(),
            Some(
                "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
            )
        );
        assert_eq!(
            ali_openai_url(
                Some("https://workspace.example/compatible-mode/v1"),
                "images/edits"
            )
            .as_deref(),
            Some("https://workspace.example/api/v1/services/aigc/multimodal-generation/generation")
        );
        for model in [
            "z-image-turbo",
            "qwen-image-plus",
            "wan2.6-t2i",
            "wan2.7-t2i",
            "qwen-image-edit-plus-2025-12-15",
        ] {
            assert!(supports_ali_sync_image_generation(model));
        }
        assert!(!supports_ali_sync_image_generation("wan2.5-t2i-preview"));
        assert!(supports_ali_sync_image_edit("qwen-image-edit-plus"));
        assert!(!supports_ali_sync_image_edit("wan2.6-image-edit"));
        assert!(!supports_ali_sync_image_generation("custom-sync-v1"));
        assert!(supports_ali_sync_image_generation_with_config(
            "custom-sync-v1",
            Some("custom-sync")
        ));
        assert!(!supports_ali_sync_image_generation_with_config(
            "qwen-image-plus",
            Some("custom-sync")
        ));
    }

    #[test]
    fn synchronous_generation_request_preserves_native_overrides() {
        let mut standard = json!({
            "model": "qwen-image-plus",
            "prompt": "a lighthouse",
            "n": 3,
            "size": "1024x1024",
            "watermark": true,
            "response_format": "url"
        });
        assert_eq!(
            apply_ali_sync_image_generation_request(&mut standard).unwrap(),
            3
        );
        assert_eq!(
            standard["input"]["messages"][0]["content"][0]["text"],
            "a lighthouse"
        );
        assert_eq!(standard["parameters"]["n"], 3);
        assert_eq!(standard["parameters"]["size"], "1024*1024");
        assert_eq!(standard["parameters"]["watermark"], true);

        let mut native = json!({
            "model": "z-image-turbo",
            "prompt": "ignored",
            "n": 9,
            "input": {"messages": [{"role": "user", "content": [{"text": "native"}]}]},
            "parameters": {"n": 2, "prompt_extend": true}
        });
        assert_eq!(
            apply_ali_sync_image_generation_request(&mut native).unwrap(),
            2
        );
        assert_eq!(
            native["input"]["messages"][0]["content"][0]["text"],
            "native"
        );
        assert_eq!(native["parameters"]["prompt_extend"], true);

        let mut native_default = json!({
            "model": "z-image-turbo",
            "prompt": "ignored",
            "n": 9,
            "input": {"messages": [{"role": "user", "content": [{"text": "native"}]}]},
            "parameters": {"prompt_extend": true}
        });
        assert_eq!(
            apply_ali_sync_image_generation_request(&mut native_default).unwrap(),
            1
        );
        assert!(native_default["parameters"].get("n").is_none());

        let mut explicit_zero = json!({
            "model": "qwen-image-plus",
            "prompt": "default count",
            "n": 0
        });
        assert_eq!(
            apply_ali_sync_image_generation_request(&mut explicit_zero).unwrap(),
            1
        );
        assert!(explicit_zero["parameters"].get("n").is_none());

        let mut asynchronous = json!({"model": "wan2.5-t2i-preview", "prompt": "x"});
        assert_eq!(
            apply_ali_sync_image_generation_request(&mut asynchronous),
            Err(AliImageError::UnsupportedModel)
        );
    }

    #[test]
    fn synchronous_edit_request_embeds_images_without_remote_fetches() {
        let request = ali_sync_image_edit_request(
            "qwen-image-edit-plus",
            "remove the sign",
            &["data:image/png;base64,AAAA".to_string()],
            2,
            Some(false),
            Some("b64_json"),
        )
        .unwrap();
        assert_eq!(request["parameters"]["n"], 2);
        assert_eq!(request["parameters"]["watermark"], false);
        assert_eq!(
            request["input"]["messages"][0]["content"][0]["image"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            request["input"]["messages"][0]["content"][1]["text"],
            "remove the sign"
        );
        assert_eq!(
            ali_sync_image_edit_request(
                "wan2.6-image-edit",
                "x",
                &["data:image/png;base64,AAAA".to_string()],
                1,
                None,
                None,
            ),
            Err(AliImageError::UnsupportedModel)
        );
    }

    #[test]
    fn image_response_count_precedence_matches_the_source_adapter() {
        let provider = transform_ali_image_response_body(
            r#"{"output":{"results":[{"url":"https://example.test/a.png"}]},"usage":{"image_count":3}}"#,
            Some("url"),
            2,
            123,
        )
        .unwrap();
        assert_eq!(provider.actual_image_count, 3);
        assert_eq!(provider.converted_image_count, 1);
        assert_eq!(provider.count_source, AliImageCountSource::ProviderUsage);
        let provider_body: Value = serde_json::from_str(&provider.body).unwrap();
        assert_eq!(provider_body["created"], 123);
        assert_eq!(
            provider_body["data"][0]["url"],
            "https://example.test/a.png"
        );
        assert_eq!(provider_body["metadata"]["usage"]["image_count"], 3);
        assert!(provider_body["metadata"].get("output").is_none());

        let converted = transform_ali_image_response_body(
            r#"{"output":{"choices":[{"message":{"content":[{"image":"AAAA"},{"text":"revised"}]}},{"message":{"content":[{"image":"BBBB"}]}}]}}"#,
            Some("b64_json"),
            4,
            123,
        )
        .unwrap();
        assert_eq!(converted.actual_image_count, 2);
        assert_eq!(
            converted.count_source,
            AliImageCountSource::ConvertedResponse
        );

        let one_choice = transform_ali_image_response_body(
            r#"{"output":{"choices":[{"message":{"content":[{"image":"AAAA"},{"image":"BBBB"},{"text":"revised"}]}}]}}"#,
            Some("b64_json"),
            4,
            123,
        )
        .unwrap();
        assert_eq!(one_choice.converted_image_count, 1);
        let one_choice_body: Value = serde_json::from_str(&one_choice.body).unwrap();
        assert_eq!(one_choice_body["data"][0]["b64_json"], "BBBB");
        assert_eq!(one_choice_body["data"][0]["revised_prompt"], "revised");

        let requested =
            transform_ali_image_response_body(r#"{"output":{"results":[]}}"#, None, 4, 123)
                .unwrap();
        assert_eq!(requested.actual_image_count, 4);
        assert_eq!(requested.count_source, AliImageCountSource::RequestedCount);

        let zero_usage = transform_ali_image_response_body(
            r#"{"output":{"results":[{"url":"https://example.test/a.png"}]},"usage":{"image_count":0}}"#,
            None,
            0,
            123,
        )
        .unwrap();
        assert_eq!(zero_usage.actual_image_count, 1);
        assert_eq!(
            zero_usage.count_source,
            AliImageCountSource::ConvertedResponse
        );
    }

    #[test]
    fn base64_mode_never_fetches_provider_urls_and_errors_fail_closed() {
        assert!(matches!(
            transform_ali_image_response_body(
                r#"{"output":{"results":[{"url":"https://example.test/a.png"},{"b64_image":"AAAA"}]}}"#,
                Some("b64_json"),
                2,
                123,
            ),
            Err(AliImageError::InvalidResponse(_))
        ));
        let response = transform_ali_image_response_body(
            r#"{"output":{"results":[{"b64_image":"AAAA"}]}}"#,
            Some("b64_json"),
            1,
            123,
        )
        .unwrap();
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["data"].as_array().unwrap().len(), 1);
        assert_eq!(body["data"][0]["b64_json"], "AAAA");
        assert!(matches!(
            transform_ali_image_response_body(
                r#"{"output":{"choices":[{"message":{"content":[{"image":"AAAA"},{"image":"https://example.test/b.png"}]}}]}}"#,
                Some("b64_json"),
                2,
                123,
            ),
            Err(AliImageError::InvalidResponse(_))
        ));
        assert!(matches!(
            transform_ali_image_response_body(
                r#"{"code":"InvalidParameter","message":"bad image request"}"#,
                None,
                1,
                123,
            ),
            Err(AliImageError::Provider(_))
        ));
        assert!(matches!(
            transform_ali_image_response_body(
                r#"{"output":{},"usage":{"image_count":-1}}"#,
                None,
                1,
                123,
            ),
            Err(AliImageError::InvalidResponse(_))
        ));
    }
}
