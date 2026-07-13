use std::fmt;

use cinatoken_relay::{clamp_i64_to_i32, UsageSummary};
use serde_json::{json, Map, Value};

const DEFAULT_ROOT: &str = "https://dashscope.aliyuncs.com";
const DEFAULT_ANTHROPIC_MESSAGES_MODELS: &str = "qwen,deepseek-v4,kimi,glm,minimax-m";
const OPENAI_ENDPOINTS: &[&str] = &["chat/completions", "completions", "embeddings", "responses"];
const RERANK_PATH: &str = "api/v1/services/rerank/text-rerank/text-rerank";

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

pub fn ali_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
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
        for unsupported in [
            "images/generations",
            "images/edits",
            "audio/speech",
            "messages",
        ] {
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
}
