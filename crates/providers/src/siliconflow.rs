use cinatoken_relay::{
    clamp_i64_to_i32, upstream_v1_url, usage_summary_from_body, UsageSummary,
    CHANNEL_TYPE_SILICONFLOW,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

const SUPPORTED_ENDPOINTS: &[&str] = &[
    "chat/completions",
    "completions",
    "embeddings",
    "rerank",
    "images/generations",
];

pub fn siliconflow_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    SUPPORTED_ENDPOINTS
        .contains(&endpoint_path)
        .then(|| upstream_v1_url(CHANNEL_TYPE_SILICONFLOW, base_url, endpoint_path))
}

/// Ports the route-specific request behavior from the Go SiliconFlow adapter.
pub fn apply_siliconflow_request(body: &mut Value, endpoint_path: &str) {
    if matches!(endpoint_path, "chat/completions" | "completions") {
        apply_fim_message_compatibility(body);
    }
    if endpoint_path == "images/generations" {
        apply_image_generation_request(body);
    }
}

fn apply_fim_message_compatibility(body: &mut Value) {
    let Some(request) = body.as_object_mut() else {
        return;
    };
    let is_fim = ["prefix", "suffix"]
        .iter()
        .any(|field| request.get(*field).is_some_and(|value| !value.is_null()));
    let has_messages = request
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| !messages.is_empty());
    if is_fim && !has_messages {
        request.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": ""}]),
        );
    }
}

fn apply_image_generation_request(body: &mut Value) {
    let Some(input) = body.as_object() else {
        return;
    };
    let mut output = Map::new();

    copy_string(input, &mut output, "model");
    copy_string(input, &mut output, "prompt");
    for field in ["negative_prompt", "image", "image2", "image3"] {
        copy_nonempty_string(input, &mut output, field);
    }

    let image_size = input
        .get("image_size")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            input
                .get("size")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
    if let Some(image_size) = image_size {
        output.insert(
            "image_size".to_string(),
            Value::String(image_size.to_string()),
        );
    }

    let batch_size = input
        .get("batch_size")
        .and_then(Value::as_u64)
        .filter(|value| *value != 0)
        .or_else(|| input.get("n").and_then(Value::as_u64));
    if let Some(batch_size) = batch_size {
        output.insert("batch_size".to_string(), Value::from(batch_size));
    }

    for field in ["seed", "num_inference_steps"] {
        copy_u64(input, &mut output, field);
    }
    for field in ["guidance_scale", "cfg"] {
        copy_number(input, &mut output, field);
    }

    *body = Value::Object(output);
}

fn copy_string(input: &Map<String, Value>, output: &mut Map<String, Value>, field: &str) {
    if let Some(value) = input.get(field).and_then(Value::as_str) {
        output.insert(field.to_string(), Value::String(value.to_string()));
    }
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

fn copy_u64(input: &Map<String, Value>, output: &mut Map<String, Value>, field: &str) {
    if let Some(value) = input
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value != 0)
    {
        output.insert(field.to_string(), Value::from(value));
    }
}

fn copy_number(input: &Map<String, Value>, output: &mut Map<String, Value>, field: &str) {
    if let Some(value) = input
        .get(field)
        .filter(|value| value.as_f64().is_some_and(|number| number != 0.0))
    {
        output.insert(field.to_string(), value.clone());
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct SiliconFlowTokens {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
}

#[derive(Debug, Default, Deserialize)]
struct SiliconFlowMeta {
    #[serde(default)]
    tokens: Option<SiliconFlowTokens>,
    #[serde(default)]
    billed_units: Option<SiliconFlowTokens>,
}

#[derive(Debug, Deserialize)]
struct SiliconFlowRerankResponse {
    #[serde(default)]
    results: Option<Vec<Value>>,
    #[serde(default)]
    tokens: Option<SiliconFlowTokens>,
    #[serde(default)]
    meta: SiliconFlowMeta,
}

pub fn transform_siliconflow_rerank_response_body(
    body: &str,
) -> Result<(String, UsageSummary), serde_json::Error> {
    let response = serde_json::from_str::<SiliconFlowRerankResponse>(body)?;
    let results = response.results.ok_or_else(|| {
        <serde_json::Error as serde::de::Error>::custom(
            "SiliconFlow rerank response must include results",
        )
    })?;
    let tokens = response
        .tokens
        .or(response.meta.tokens)
        .or(response.meta.billed_units);
    let mut usage = tokens.map(usage_from_tokens).unwrap_or_default();
    if usage.total_tokens == 0 {
        usage = usage_summary_from_body(body);
    }
    let transformed = json!({
        "results": results,
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
        }
    });
    serde_json::to_string(&transformed).map(|body| (body, usage))
}

pub fn siliconflow_image_response_usage(body: &str) -> Result<UsageSummary, serde_json::Error> {
    #[derive(Deserialize)]
    struct ImageResponse {
        #[serde(default)]
        images: Vec<Value>,
    }

    let response = serde_json::from_str::<ImageResponse>(body)?;
    if response.images.is_empty() {
        return Err(<serde_json::Error as serde::de::Error>::custom(
            "SiliconFlow image response must include at least one image",
        ));
    }
    let usage = usage_summary_from_body(body);
    if usage.total_tokens > 0 {
        return Ok(usage);
    }
    Ok(UsageSummary {
        prompt_tokens: 1,
        total_tokens: 1,
        ..UsageSummary::default()
    })
}

fn usage_from_tokens(tokens: SiliconFlowTokens) -> UsageSummary {
    let prompt_tokens = clamp_i64_to_i32(tokens.input_tokens.max(0));
    let completion_tokens = clamp_i64_to_i32(tokens.output_tokens.max(0));
    UsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens.saturating_add(completion_tokens),
        ..UsageSummary::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_allowlist_preserves_source_default_and_custom_v1_roots() {
        assert_eq!(
            siliconflow_openai_url(None, "chat/completions").as_deref(),
            Some("https://api.siliconflow.cn/v1/chat/completions")
        );
        assert_eq!(
            siliconflow_openai_url(Some("https://siliconflow.example/v1"), "/rerank").as_deref(),
            Some("https://siliconflow.example/v1/rerank")
        );
        for unsupported in ["responses", "messages", "images/edits", "audio/speech"] {
            assert!(siliconflow_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn fim_request_injects_only_the_go_compatibility_message() {
        let mut body =
            json!({"model": "Qwen/Qwen2.5-Coder", "prefix": "fn main() {", "suffix": "}"});
        apply_siliconflow_request(&mut body, "chat/completions");
        assert_eq!(body["messages"], json!([{"role": "user", "content": ""}]));

        let mut existing = json!({
            "model": "Qwen/Qwen2.5-Coder",
            "prefix": "fn main() {",
            "messages": [{"role": "user", "content": "keep"}]
        });
        apply_siliconflow_request(&mut existing, "chat/completions");
        assert_eq!(existing["messages"][0]["content"], "keep");
    }

    #[test]
    fn image_request_maps_standard_aliases_and_whitelists_provider_fields() {
        let mut body = json!({
            "model": "Kwai-Kolors/Kolors",
            "prompt": "rust skyline",
            "negative_prompt": "blur",
            "size": "1024x1024",
            "image_size": "768x1024",
            "n": 2,
            "batch_size": 3,
            "seed": 42,
            "num_inference_steps": 20,
            "guidance_scale": 7.5,
            "cfg": 0.5,
            "image": "data:image/png;base64,a",
            "response_format": "removed"
        });
        apply_siliconflow_request(&mut body, "images/generations");
        assert_eq!(body["image_size"], "768x1024");
        assert_eq!(body["batch_size"], 3);
        assert_eq!(body["seed"], 42);
        assert!(body.get("size").is_none());
        assert!(body.get("n").is_none());
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn rerank_response_supports_legacy_and_current_token_envelopes() {
        for body in [
            r#"{"results":[{"index":0,"relevance_score":0.9}],"meta":{"tokens":{"input_tokens":11,"output_tokens":2}}}"#,
            r#"{"results":[{"index":0,"relevance_score":0.9}],"tokens":{"input_tokens":11,"output_tokens":2}}"#,
        ] {
            let (body, usage) = transform_siliconflow_rerank_response_body(body).unwrap();
            let body = serde_json::from_str::<Value>(&body).unwrap();
            assert_eq!(usage.prompt_tokens, 11);
            assert_eq!(usage.completion_tokens, 2);
            assert_eq!(usage.total_tokens, 13);
            assert_eq!(body["usage"]["total_tokens"], 13);
            assert!(body.get("tokens").is_none());
            assert!(body.get("meta").is_none());
        }
        assert!(transform_siliconflow_rerank_response_body(r#"{"error":"failed"}"#).is_err());
    }

    #[test]
    fn image_response_synthesizes_go_compatible_usage() {
        assert_eq!(
            siliconflow_image_response_usage(
                r#"{"images":[{"url":"https://example.test/image.png"}],"seed":42}"#
            )
            .unwrap(),
            UsageSummary {
                prompt_tokens: 1,
                total_tokens: 1,
                ..UsageSummary::default()
            }
        );
        assert_eq!(
            siliconflow_image_response_usage(
                r#"{"images":[{"url":"one"},{"url":"two"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}"#
            )
            .unwrap(),
            UsageSummary {
                prompt_tokens: 7,
                completion_tokens: 2,
                total_tokens: 9,
                ..UsageSummary::default()
            }
        );
        assert!(siliconflow_image_response_usage(r#"{"images":[]}"#).is_err());
        assert!(siliconflow_image_response_usage(r#"{"error":"failed"}"#).is_err());
        assert!(siliconflow_image_response_usage("not-json").is_err());
    }
}
