use serde_json::{json, Value};

const DEFAULT_BASE_URL: &str = "https://ark.cn-beijing.volces.com";
const CODING_PLAN_SENTINEL: &str = "doubao-coding-plan";
const CODING_PLAN_OPENAI_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/coding/v3";
const OPENAI_ENDPOINTS: &[&str] = &[
    "chat/completions",
    "embeddings",
    "images/generations",
    "responses",
];

pub fn volcengine_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    let endpoint_path = endpoint_path.trim().trim_start_matches('/');
    if !OPENAI_ENDPOINTS.contains(&endpoint_path) {
        return None;
    }
    if is_volcengine_coding_plan(base_url) {
        return (endpoint_path == "chat/completions")
            .then(|| format!("{CODING_PLAN_OPENAI_BASE_URL}/{endpoint_path}"));
    }
    Some(format!(
        "{}/{endpoint_path}",
        normalized_v3_base(base_url).trim_end_matches('/')
    ))
}

pub fn is_volcengine_coding_plan(base_url: Option<&str>) -> bool {
    base_url
        .map(str::trim)
        .is_some_and(|value| value == CODING_PLAN_SENTINEL)
}

pub fn is_volcengine_bot_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("bot")
}

pub fn apply_volcengine_request(body: &mut Value) {
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
    let Some(base_model) = model.strip_suffix("-thinking") else {
        return;
    };
    if !base_model.starts_with("deepseek") || base_model.is_empty() {
        return;
    }
    object.insert("model".to_string(), Value::String(base_model.to_string()));
    object.insert("thinking".to_string(), json!({ "type": "enabled" }));
}

fn normalized_v3_base(base_url: Option<&str>) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/');
    if base.ends_with("/api/v3") || base.ends_with("/api/coding/v3") {
        base.to_string()
    } else {
        format!("{base}/api/v3")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn urls_match_current_ark_v3_and_source_coding_plan_contract() {
        assert_eq!(
            volcengine_openai_url(None, "chat/completions").as_deref(),
            Some("https://ark.cn-beijing.volces.com/api/v3/chat/completions")
        );
        assert_eq!(
            volcengine_openai_url(Some("https://ark.example/api/v3/"), "embeddings").as_deref(),
            Some("https://ark.example/api/v3/embeddings")
        );
        assert_eq!(
            volcengine_openai_url(Some(CODING_PLAN_SENTINEL), "chat/completions").as_deref(),
            Some("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions")
        );
        for endpoint in ["embeddings", "images/generations", "responses"] {
            assert!(volcengine_openai_url(Some(CODING_PLAN_SENTINEL), endpoint).is_none());
        }
        for unsupported in ["completions", "rerank", "audio/speech", "messages"] {
            assert!(volcengine_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn deepseek_thinking_suffix_matches_source_request_transform() {
        let mut body = json!({"model": "deepseek-v3-thinking", "thinking": {"type": "disabled"}});
        apply_volcengine_request(&mut body);
        assert_eq!(body["model"], "deepseek-v3");
        assert_eq!(body["thinking"]["type"], "enabled");

        let mut unrelated = json!({"model": "doubao-seed-1-6-thinking"});
        let original = unrelated.clone();
        apply_volcengine_request(&mut unrelated);
        assert_eq!(unrelated, original);
    }

    #[test]
    fn bot_and_coding_plan_detection_is_explicit() {
        assert!(is_volcengine_bot_model("bot-2025"));
        assert!(is_volcengine_bot_model(" BOT-app "));
        assert!(!is_volcengine_bot_model("doubao-seed"));
        assert!(is_volcengine_coding_plan(Some(CODING_PLAN_SENTINEL)));
        assert!(!is_volcengine_coding_plan(None));
    }
}
