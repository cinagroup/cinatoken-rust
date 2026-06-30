//! Pure response parser + submit-body builder for the Doubao (Volcengine) video
//! task provider, ported from `relay/channel/task/doubao/adaptor.go`
//! (`ParseTaskResult` and `convertToRequestPayload`).

use crate::taskcommon::merge_metadata;
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Default)]
struct ResponseTask {
    #[serde(default)]
    status: String,
    #[serde(default)]
    content: Content,
    #[serde(default)]
    usage: Usage,
    #[serde(default)]
    error: ErrorInfo,
}

#[derive(Deserialize, Default)]
struct Content {
    #[serde(default)]
    video_url: String,
}

#[derive(Deserialize, Default)]
struct Usage {
    #[serde(default)]
    completion_tokens: i64,
    #[serde(default)]
    total_tokens: i64,
}

#[derive(Deserialize, Default)]
struct ErrorInfo {
    #[serde(default)]
    message: String,
}

/// Map a Doubao poll response onto a [`TaskInfo`]. Status vocabulary:
/// `pending`/`queued` (10%), `processing`/`running` (50%), `succeeded` (100%,
/// with the video URL and the upstream usage tokens for ratio billing),
/// `failed` (100%, reason from the error object); any other status is treated
/// as in-progress at 30%.
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: ResponseTask = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut url = String::new();
    let mut reason = String::new();
    let mut completion_tokens = 0;
    let mut total_tokens = 0;
    let (status, progress) = match resp.status.as_str() {
        "pending" | "queued" => (TaskStatus::Queued, "10%"),
        "processing" | "running" => (TaskStatus::InProgress, "50%"),
        "succeeded" => {
            url = resp.content.video_url;
            completion_tokens = resp.usage.completion_tokens;
            total_tokens = resp.usage.total_tokens;
            (TaskStatus::Success, "100%")
        }
        "failed" => {
            reason = resp.error.message;
            (TaskStatus::Failure, "100%")
        }
        _ => (TaskStatus::InProgress, "30%"),
    };

    Ok(TaskInfo {
        code: 0,
        task_id: String::new(),
        status,
        reason,
        url,
        remote_url: String::new(),
        progress: progress.to_string(),
        completion_tokens,
        total_tokens,
    })
}

#[derive(Deserialize, Default)]
struct SubmitResponse {
    #[serde(default)]
    id: String,
}

/// Extract the upstream task id from a Doubao submit response (Go `DoResponse`):
/// the `id`, which must be non-empty.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_body_failed: {err}"))?;
    if resp.id.is_empty() {
        return Err("task_id is empty".to_string());
    }
    Ok(resp.id)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MediaUrl {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ContentItem {
    #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
    content_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_url: Option<MediaUrl>,
}

/// The Doubao submit payload. The transform actively sets `model`/`content`/
/// `duration`; any other field (resolution, ratio, seed, …) arrives via the
/// metadata passthrough and is carried in `extra` (flattened to the top level on
/// serialize). Note: Go's typed payload would drop metadata keys that aren't
/// real fields; the flattened passthrough keeps them, a benign superset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestPayload {
    model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    content: Vec<ContentItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Build the Doubao submit payload from the client request — a port of
/// `convertToRequestPayload`. Images become `image_url` content items, metadata
/// passthrough fields are merged (with `model` stripped), `seconds` (when > 0)
/// sets `duration`, and finally the prompt is appended as the sole text content
/// item (any pre-existing text content is dropped first).
pub fn convert_to_request_payload(req: &TaskSubmitReq) -> Result<RequestPayload, String> {
    let mut payload = RequestPayload {
        model: req.model.clone(),
        ..Default::default()
    };
    for image in &req.images {
        payload.content.push(ContentItem {
            content_type: "image_url".to_string(),
            image_url: Some(MediaUrl { url: image.clone() }),
            ..Default::default()
        });
    }

    if let Some(metadata) = &req.metadata {
        let mut value = serde_json::to_value(&payload).map_err(|err| err.to_string())?;
        merge_metadata(&mut value, metadata);
        payload = serde_json::from_value(value).map_err(|err| err.to_string())?;
    }

    if let Ok(seconds) = req.seconds.parse::<i64>() {
        if seconds > 0 {
            payload.duration = Some(seconds);
        }
    }

    payload.content.retain(|item| item.content_type != "text");
    payload.content.push(ContentItem {
        content_type: "text".to_string(),
        text: req.prompt.clone(),
        ..Default::default()
    });

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_payload_text_only() {
        let req = TaskSubmitReq {
            prompt: "a flying cat".to_string(),
            model: "doubao-seedance".to_string(),
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req).unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "model": "doubao-seedance",
                "content": [{"type": "text", "text": "a flying cat"}]
            })
        );
    }

    #[test]
    fn request_payload_images_metadata_and_seconds() {
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            model: "m".to_string(),
            images: vec!["https://i/1.png".to_string()],
            seconds: "5".to_string(),
            metadata: Some(json!({"resolution": "720p", "ratio": "16:9", "model": "evil"})),
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req).unwrap();
        let value = serde_json::to_value(&payload).unwrap();
        // Image content first, prompt text last.
        assert_eq!(
            value["content"],
            json!([
                {"type": "image_url", "image_url": {"url": "https://i/1.png"}},
                {"type": "text", "text": "p"}
            ])
        );
        // seconds -> duration; metadata merged; model stripped.
        assert_eq!(value["duration"], json!(5));
        assert_eq!(value["resolution"], json!("720p"));
        assert_eq!(value["ratio"], json!("16:9"));
        assert!(value.get("model").is_some()); // the request model, not metadata's
        assert_eq!(value["model"], json!("m"));
    }

    #[test]
    fn submit_returns_id_or_errors_when_empty() {
        assert_eq!(
            parse_submit_response(br#"{"id":"cgt-123"}"#).unwrap(),
            "cgt-123"
        );
        assert_eq!(
            parse_submit_response(br#"{}"#).unwrap_err(),
            "task_id is empty"
        );
    }

    #[test]
    fn queued_and_running_states() {
        for raw in ["pending", "queued"] {
            let info = parse_task_result(format!(r#"{{"status":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::Queued, "{raw}");
            assert_eq!(info.progress, "10%", "{raw}");
        }
        for raw in ["processing", "running"] {
            let info = parse_task_result(format!(r#"{{"status":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::InProgress, "{raw}");
            assert_eq!(info.progress, "50%", "{raw}");
        }
    }

    #[test]
    fn succeeded_carries_url_and_usage() {
        let info = parse_task_result(
            br#"{"status":"succeeded","content":{"video_url":"https://cdn/d.mp4"},"usage":{"completion_tokens":12,"total_tokens":20}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.url, "https://cdn/d.mp4");
        assert_eq!(info.completion_tokens, 12);
        assert_eq!(info.total_tokens, 20);
    }

    #[test]
    fn failed_uses_error_message() {
        let info = parse_task_result(br#"{"status":"failed","error":{"message":"boom"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.reason, "boom");
    }

    #[test]
    fn unknown_status_is_in_progress_30() {
        let info = parse_task_result(br#"{"status":"weird"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
        assert_eq!(info.progress, "30%");
    }
}
