//! Pure poll-request builders for the simple-auth task providers, ported from
//! each provider's `FetchTask` in `relay/channel/task/<p>/adaptor.go`.
//!
//! A [`PollRequest`] is the fully-resolved upstream poll call (method, URL,
//! headers, body) that the Worker's HTTP layer executes. These six providers
//! authenticate with a plain header derived from the channel key, so building
//! the request is pure and host-testable. Kling (JWT), Jimeng (Volcengine HMAC),
//! and Vertex (GCP OAuth) require signing/token acquisition and are built in the
//! Worker adaptor instead.

use crate::taskcommon::decode_local_task_id;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn get(url: String, headers: Vec<(String, String)>) -> PollRequest {
    PollRequest {
        method: HttpMethod::Get,
        url,
        headers,
        body: None,
    }
}

fn header(name: &str, value: String) -> (String, String) {
    (name.to_string(), value)
}

/// Sora: `GET {base}/v1/videos/{task_id}` with a bearer key.
pub fn sora(base_url: &str, key: &str, task_id: &str) -> PollRequest {
    get(
        format!("{base_url}/v1/videos/{task_id}"),
        vec![header("Authorization", format!("Bearer {key}"))],
    )
}

/// Vidu: `GET {base}/ent/v2/tasks/{task_id}/creations` with the `Token` scheme.
pub fn vidu(base_url: &str, key: &str, task_id: &str) -> PollRequest {
    get(
        format!("{base_url}/ent/v2/tasks/{task_id}/creations"),
        vec![
            header("Accept", "application/json".to_string()),
            header("Authorization", format!("Token {key}")),
        ],
    )
}

/// Ali: `GET {base}/api/v1/tasks/{task_id}` with a bearer key.
pub fn ali(base_url: &str, key: &str, task_id: &str) -> PollRequest {
    get(
        format!("{base_url}/api/v1/tasks/{task_id}"),
        vec![header("Authorization", format!("Bearer {key}"))],
    )
}

/// Doubao: `GET {base}/api/v3/contents/generations/tasks/{task_id}`.
pub fn doubao(base_url: &str, key: &str, task_id: &str) -> PollRequest {
    get(
        format!("{base_url}/api/v3/contents/generations/tasks/{task_id}"),
        vec![
            header("Accept", "application/json".to_string()),
            header("Content-Type", "application/json".to_string()),
            header("Authorization", format!("Bearer {key}")),
        ],
    )
}

/// Hailuo: `GET {base}/v1/query/video_generation?task_id={task_id}`.
pub fn hailuo(base_url: &str, key: &str, task_id: &str) -> PollRequest {
    get(
        format!("{base_url}/v1/query/video_generation?task_id={task_id}"),
        vec![
            header("Accept", "application/json".to_string()),
            header("Authorization", format!("Bearer {key}")),
        ],
    )
}

/// Gemini: `GET {base}/{version}/{operation-name}` with `x-goog-api-key`. The
/// task id is a base64 local id that decodes back to the upstream operation
/// name; `version` is the configured Gemini API version (e.g. `v1beta`).
pub fn gemini(
    base_url: &str,
    key: &str,
    task_id: &str,
    version: &str,
) -> Result<PollRequest, String> {
    let name = decode_local_task_id(task_id)?;
    Ok(get(
        format!("{base_url}/{version}/{name}"),
        vec![
            header("Accept", "application/json".to_string()),
            header("x-goog-api-key", key.to_string()),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskcommon::encode_local_task_id;

    #[test]
    fn sora_request() {
        let req = sora("https://api.sora", "sk-1", "t9");
        assert_eq!(req.method, HttpMethod::Get);
        assert_eq!(req.url, "https://api.sora/v1/videos/t9");
        assert_eq!(
            req.headers,
            vec![("Authorization".into(), "Bearer sk-1".into())]
        );
        assert!(req.body.is_none());
    }

    #[test]
    fn vidu_uses_token_scheme() {
        let req = vidu("https://api.vidu", "k", "abc");
        assert_eq!(req.url, "https://api.vidu/ent/v2/tasks/abc/creations");
        assert!(req
            .headers
            .contains(&("Authorization".into(), "Token k".into())));
    }

    #[test]
    fn ali_and_doubao_paths() {
        assert_eq!(
            ali("https://dashscope", "k", "t").url,
            "https://dashscope/api/v1/tasks/t"
        );
        let d = doubao("https://ark", "k", "t");
        assert_eq!(d.url, "https://ark/api/v3/contents/generations/tasks/t");
        assert!(d
            .headers
            .contains(&("Content-Type".into(), "application/json".into())));
    }

    #[test]
    fn hailuo_uses_query_param() {
        let req = hailuo("https://api.minimax", "k", "tid");
        assert_eq!(
            req.url,
            "https://api.minimax/v1/query/video_generation?task_id=tid"
        );
    }

    #[test]
    fn gemini_decodes_operation_name() {
        let task_id = encode_local_task_id("operations/op-5");
        let req = gemini("https://generativelanguage", "K", &task_id, "v1beta").unwrap();
        assert_eq!(req.url, "https://generativelanguage/v1beta/operations/op-5");
        assert!(req.headers.contains(&("x-goog-api-key".into(), "K".into())));
    }

    #[test]
    fn gemini_rejects_bad_task_id() {
        assert!(gemini("https://x", "K", "not!base64", "v1beta").is_err());
    }
}
