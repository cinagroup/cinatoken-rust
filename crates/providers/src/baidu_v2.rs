use serde_json::{json, Value};

const DEFAULT_BASE_URL: &str = "https://qianfan.baidubce.com";

pub fn baidu_v2_openai_url(base_url: Option<&str>, endpoint_path: &str) -> Option<String> {
    if endpoint_path.trim().trim_start_matches('/') != "chat/completions" {
        return None;
    }
    Some(format!(
        "{}/chat/completions",
        normalized_v2_base(base_url).trim_end_matches('/')
    ))
}

pub fn parse_baidu_v2_key(key: &str) -> Result<(&str, Option<&str>), &'static str> {
    let mut parts = key.split('|');
    let token = parts.next().unwrap_or_default().trim();
    if token.is_empty() {
        return Err("authorization token is required");
    }
    let app_id = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok((token, app_id))
}

pub fn apply_baidu_v2_request(body: &mut Value) {
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
    let Some(base_model) = model.strip_suffix("-search") else {
        return;
    };
    if base_model.is_empty() {
        return;
    }

    object.insert("model".to_string(), Value::String(base_model.to_string()));
    if !object.contains_key("web_search") {
        object.insert(
            "web_search".to_string(),
            json!({
                "enable": true,
                "enable_citation": true,
                "enable_trace": true,
                "enable_status": false,
            }),
        );
    }
}

fn normalized_v2_base(base_url: Option<&str>) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/');
    if base.ends_with("/v2") {
        base.to_string()
    } else {
        format!("{base}/v2")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn url_is_route_explicit_and_accepts_root_or_v2_base() {
        assert_eq!(
            baidu_v2_openai_url(None, "chat/completions").as_deref(),
            Some("https://qianfan.baidubce.com/v2/chat/completions")
        );
        assert_eq!(
            baidu_v2_openai_url(Some("https://baidu.example/v2/"), "/chat/completions").as_deref(),
            Some("https://baidu.example/v2/chat/completions")
        );
        for unsupported in [
            "completions",
            "embeddings",
            "images/generations",
            "responses",
        ] {
            assert!(baidu_v2_openai_url(None, unsupported).is_none());
        }
    }

    #[test]
    fn key_parser_separates_optional_app_id_without_echoing_secrets() {
        assert_eq!(
            parse_baidu_v2_key("token-1|app-2"),
            Ok(("token-1", Some("app-2")))
        );
        assert_eq!(parse_baidu_v2_key(" token-1 | "), Ok(("token-1", None)));
        assert_eq!(
            parse_baidu_v2_key("|app-2"),
            Err("authorization token is required")
        );
    }

    #[test]
    fn search_suffix_enables_source_default_search_contract() {
        let mut body = json!({
            "model": "ernie-4.5-turbo-search",
            "messages": [{"role": "user", "content": "news"}]
        });
        apply_baidu_v2_request(&mut body);
        assert_eq!(body["model"], "ernie-4.5-turbo");
        assert_eq!(body["web_search"]["enable"], true);
        assert_eq!(body["web_search"]["enable_citation"], true);
        assert_eq!(body["web_search"]["enable_trace"], true);
        assert_eq!(body["web_search"]["enable_status"], false);

        let mut explicit = json!({
            "model": "ernie-4.5-turbo-search",
            "web_search": {"enable": false}
        });
        apply_baidu_v2_request(&mut explicit);
        assert_eq!(explicit["web_search"], json!({"enable": false}));
    }
}
