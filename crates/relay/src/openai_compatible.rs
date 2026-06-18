use std::collections::HashMap;

use serde_json::Value;

pub const OPENAI_COMPATIBLE_CHANNEL_TYPES: &[i32] = &[
    1,  // OpenAI
    20, // OpenRouter
    40, // SiliconFlow
    42, // Mistral
    43, // DeepSeek
    48, // xAI
    53, // Submodel
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UsageSummary {
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub total_tokens: i32,
}

pub fn is_openai_compatible_channel_type(channel_type: i32) -> bool {
    OPENAI_COMPATIBLE_CHANNEL_TYPES.contains(&channel_type)
}

pub fn csv_contains(csv: &str, needle: &str) -> bool {
    let needle = needle.trim();
    csv.split(',')
        .map(str::trim)
        .any(|item| item.eq_ignore_ascii_case(needle))
}

pub fn ip_allowlist_matches(allow_ips: &str, client_ip: Option<&str>) -> bool {
    let allow_ips = allow_ips.trim();
    if allow_ips.is_empty() {
        return true;
    }
    let Some(client_ip) = client_ip.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    allow_ips
        .lines()
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|allowed| allowed == "*" || allowed == client_ip)
}

pub fn first_channel_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('[') {
        if let Ok(values) = serde_json::from_str::<Vec<Value>>(trimmed) {
            return values
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .find(|value| !value.trim().is_empty());
        }
    }
    trimmed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn upstream_chat_url(channel_type: i32, base_url: Option<&str>) -> String {
    upstream_v1_url(channel_type, base_url, "chat/completions")
}

pub fn upstream_v1_url(channel_type: i32, base_url: Option<&str>, endpoint_path: &str) -> String {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_base_url(channel_type).to_string());
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/{endpoint_path}")
    } else {
        format!("{base}/v1/{endpoint_path}")
    }
}

pub fn default_base_url(channel_type: i32) -> &'static str {
    match channel_type {
        20 => "https://openrouter.ai/api",
        40 => "https://api.siliconflow.cn",
        42 => "https://api.mistral.ai",
        43 => "https://api.deepseek.com",
        48 => "https://api.x.ai",
        53 => "https://llm.submodel.ai",
        _ => "https://api.openai.com",
    }
}

pub fn apply_model_mapping(body: &mut Value, model: &str, mapping: Option<&str>) {
    let Some(mapping) = mapping.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, String>>(mapping) else {
        return;
    };
    let Some(mapped_model) = map.get(model).filter(|value| !value.trim().is_empty()) else {
        return;
    };
    if let Some(obj) = body.as_object_mut() {
        obj.insert("model".to_string(), Value::String(mapped_model.clone()));
    }
}

pub fn usage_summary_from_body(body: &str) -> UsageSummary {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return UsageSummary::default();
    };
    let Some(usage) = value.get("usage") else {
        return UsageSummary::default();
    };

    let prompt_tokens = first_i32_field(usage, &["prompt_tokens", "input_tokens"]);
    let completion_tokens = first_i32_field(usage, &["completion_tokens", "output_tokens"]);
    let total_tokens = first_i32_field(usage, &["total_tokens"])
        .max(prompt_tokens.saturating_add(completion_tokens));

    UsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    }
}

pub fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn first_i32_field(value: &Value, names: &[&str]) -> i32 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(value_to_i64))
        .map(clamp_i64_to_i32)
        .unwrap_or_default()
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value.round() as i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn csv_contains_trims_and_ignores_case() {
        assert!(csv_contains(" default, VIP ,beta", "vip"));
        assert!(csv_contains("gpt-4o,gpt-4.1", " GPT-4O "));
        assert!(!csv_contains("default,vip", "other"));
    }

    #[test]
    fn ip_allowlist_supports_empty_wildcard_commas_and_lines() {
        assert!(ip_allowlist_matches("", None));
        assert!(ip_allowlist_matches("*", Some("203.0.113.1")));
        assert!(ip_allowlist_matches(
            "198.51.100.1, 203.0.113.1\n192.0.2.1",
            Some("203.0.113.1")
        ));
        assert!(!ip_allowlist_matches("198.51.100.1", Some("203.0.113.1")));
        assert!(!ip_allowlist_matches("198.51.100.1", None));
    }

    #[test]
    fn first_channel_key_accepts_plain_multiline_and_json_arrays() {
        assert_eq!(first_channel_key("sk-a\nsk-b").as_deref(), Some("sk-a"));
        assert_eq!(first_channel_key("\n  sk-b  ").as_deref(), Some("sk-b"));
        assert_eq!(
            first_channel_key(r#"["", "sk-json", "sk-next"]"#).as_deref(),
            Some("sk-json")
        );
        assert_eq!(first_channel_key("   "), None);
    }

    #[test]
    fn upstream_chat_url_normalizes_base_urls() {
        assert_eq!(
            upstream_chat_url(1, None),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(20, None),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(1, Some("https://example.test/v1")),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            upstream_chat_url(1, Some("https://example.test/openai/")),
            "https://example.test/openai/v1/chat/completions"
        );
    }

    #[test]
    fn upstream_v1_url_supports_other_endpoints() {
        assert_eq!(
            upstream_v1_url(1, None, "/embeddings"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            upstream_v1_url(1, Some("https://example.test/v1/"), "embeddings"),
            "https://example.test/v1/embeddings"
        );
    }

    #[test]
    fn apply_model_mapping_only_rewrites_matching_model() {
        let mut body = json!({
            "model": "gpt-4o",
            "temperature": 0.0,
            "custom": true
        });
        apply_model_mapping(&mut body, "gpt-4o", Some(r#"{"gpt-4o":"upstream-model"}"#));
        assert_eq!(body["model"], "upstream-model");
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["custom"], true);

        apply_model_mapping(&mut body, "missing", Some(r#"{"missing":""}"#));
        assert_eq!(body["model"], "upstream-model");
    }

    #[test]
    fn usage_summary_handles_openai_and_input_output_names() {
        assert_eq!(
            usage_summary_from_body(
                r#"{"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}"#
            ),
            UsageSummary {
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17,
            }
        );
        assert_eq!(
            usage_summary_from_body(r#"{"usage":{"input_tokens":7,"output_tokens":3}}"#),
            UsageSummary {
                prompt_tokens: 7,
                completion_tokens: 3,
                total_tokens: 10,
            }
        );
    }

    #[test]
    fn clamp_i64_to_i32_prevents_d1_integer_overflow() {
        assert_eq!(clamp_i64_to_i32(i64::MAX), i32::MAX);
        assert_eq!(clamp_i64_to_i32(i64::MIN), i32::MIN);
        assert_eq!(clamp_i64_to_i32(42), 42);
    }
}
