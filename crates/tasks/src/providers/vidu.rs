//! Pure response parser + submit-body builder for the Vidu video task provider,
//! ported from `relay/channel/task/vidu/adaptor.go` (`ParseTaskResult` and
//! `convertToRequestPayload`).

use crate::taskcommon::{default_int, default_string, merge_metadata};
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Default)]
struct Response {
    #[serde(default)]
    state: String,
    #[serde(default)]
    err_code: String,
    #[serde(default)]
    creations: Vec<Creation>,
}

#[derive(Deserialize, Default)]
struct Creation {
    #[serde(default)]
    url: String,
}

/// Map a Vidu poll response onto a [`TaskInfo`]. State vocabulary:
/// `created`/`queueing` → submitted, `processing` → in-progress, `success` →
/// success (URL from the first creation), `failed` → failure (reason from
/// `err_code` when non-empty). Unlike Sora, an unknown state is an error,
/// matching Go (`unknown task state: <state>`).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: Response = serde_json::from_slice(resp_body)
        .map_err(|err| format!("failed to unmarshal response body: {err}"))?;

    let mut url = String::new();
    let mut reason = String::new();
    let status = match resp.state.as_str() {
        "created" | "queueing" => TaskStatus::Submitted,
        "processing" => TaskStatus::InProgress,
        "success" => {
            if let Some(creation) = resp.creations.first() {
                url = creation.url.clone();
            }
            TaskStatus::Success
        }
        "failed" => {
            if !resp.err_code.is_empty() {
                reason = resp.err_code.clone();
            }
            TaskStatus::Failure
        }
        other => return Err(format!("unknown task state: {other}")),
    };

    Ok(TaskInfo {
        code: 0,
        task_id: String::new(),
        status,
        reason,
        url,
        remote_url: String::new(),
        progress: String::new(),
        completion_tokens: 0,
        total_tokens: 0,
    })
}

#[derive(Deserialize, Default)]
struct SubmitResponse {
    #[serde(default)]
    state: String,
    #[serde(default)]
    task_id: String,
}

/// Extract the upstream task id from a Vidu submit response (Go `DoResponse`): a
/// `failed` state is an error, otherwise return the `task_id`.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    parse_submit_response_classified(resp_body).map_err(super::SubmitResponseFailure::into_message)
}

pub fn parse_submit_response_classified(
    resp_body: &[u8],
) -> Result<String, super::SubmitResponseFailure> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body).map_err(|err| {
        super::SubmitResponseFailure::Unknown(format!("unmarshal_response_failed: {err}"))
    })?;
    if resp.state == "failed" {
        return Err(super::SubmitResponseFailure::Rejected(
            "task failed".to_string(),
        ));
    }
    Ok(resp.task_id)
}

/// The Vidu submit payload. The transform sets model/images/prompt/duration/
/// resolution/movement_amplitude/bgm; other fields arrive via metadata (carried
/// in `extra`). `model` and `images` have no omitempty in Go and are always
/// serialized.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestPayload {
    model: String,
    images: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    prompt: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    duration: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    resolution: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    movement_amplitude: String,
    #[serde(default, skip_serializing_if = "is_false")]
    bgm: bool,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Build the Vidu submit payload from the client request — a port of
/// `convertToRequestPayload`. Model defaults to `viduq1`, duration to 5,
/// resolution to `1080p`; movement amplitude is `auto` and bgm off; metadata
/// passthrough is merged last (with `model` stripped). `upstream_model` is Go's
/// `info.UpstreamModelName`.
pub fn convert_to_request_payload(
    req: &TaskSubmitReq,
    upstream_model: &str,
) -> Result<RequestPayload, String> {
    let mut payload = RequestPayload {
        model: default_string(upstream_model, "viduq1").to_string(),
        images: req.images.clone(),
        prompt: req.prompt.clone(),
        duration: default_int(req.duration, 5),
        resolution: default_string(&req.size, "1080p").to_string(),
        movement_amplitude: "auto".to_string(),
        bgm: false,
        extra: Map::new(),
    };

    if let Some(metadata) = &req.metadata {
        let mut value = serde_json::to_value(&payload).map_err(|err| err.to_string())?;
        merge_metadata(&mut value, metadata);
        payload = serde_json::from_value(value).map_err(|err| err.to_string())?;
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_payload_defaults_and_metadata() {
        // Empty model/duration/size -> defaults; auto movement; bgm omitted.
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            images: vec!["i1".to_string()],
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req, "").unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "model": "viduq1",
                "images": ["i1"],
                "prompt": "p",
                "duration": 5,
                "resolution": "1080p",
                "movement_amplitude": "auto"
            })
        );

        // Explicit values + metadata; model stripped from metadata.
        let req = TaskSubmitReq {
            duration: 8,
            size: "720p".to_string(),
            metadata: Some(json!({"seed": 42, "model": "evil"})),
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "viduq2").unwrap()).unwrap();
        assert_eq!(value["model"], json!("viduq2"));
        assert_eq!(value["duration"], json!(8));
        assert_eq!(value["resolution"], json!("720p"));
        assert_eq!(value["seed"], json!(42));
    }

    #[test]
    fn submit_returns_task_id_unless_failed() {
        assert_eq!(
            parse_submit_response(br#"{"task_id":"vidu_9","state":"created"}"#).unwrap(),
            "vidu_9"
        );
        assert_eq!(
            parse_submit_response(br#"{"state":"failed"}"#).unwrap_err(),
            "task failed"
        );
    }

    #[test]
    fn state_vocabulary_maps_to_lifecycle() {
        for raw in ["created", "queueing"] {
            let info = parse_task_result(format!(r#"{{"state":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::Submitted, "{raw}");
        }
        let info = parse_task_result(br#"{"state":"processing"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
    }

    #[test]
    fn success_takes_first_creation_url() {
        let info = parse_task_result(
            br#"{"state":"success","creations":[{"url":"https://cdn/a.mp4"},{"url":"https://cdn/b.mp4"}]}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.url, "https://cdn/a.mp4");
    }

    #[test]
    fn failed_uses_err_code_when_present() {
        let info = parse_task_result(br#"{"state":"failed","err_code":"E42"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "E42");

        // Empty err_code leaves the reason blank (Go only sets it when non-empty).
        let info = parse_task_result(br#"{"state":"failed"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert!(info.reason.is_empty());
    }

    #[test]
    fn unknown_state_is_an_error() {
        let err = parse_task_result(br#"{"state":"bogus"}"#).unwrap_err();
        assert_eq!(err, "unknown task state: bogus");
    }
}
