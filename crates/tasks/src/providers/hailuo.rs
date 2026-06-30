//! Pure response parser + submit-body builder for the Hailuo (MiniMax) video
//! task provider, ported from `relay/channel/task/hailuo/adaptor.go`
//! (`ParseTaskResult` and `convertToRequestPayload`).

use crate::taskcommon::merge_metadata;
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Default)]
struct QueryTaskResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    base_resp: BaseResp,
}

#[derive(Deserialize, Default)]
struct BaseResp {
    #[serde(default)]
    status_code: i64,
    #[serde(default)]
    status_msg: String,
}

/// Map a Hailuo poll response onto a [`TaskInfo`]. A non-zero `base_resp.
/// status_code` (anything but `StatusSuccess` = 0) carries the error code and
/// message. The task `status` vocabulary is `Preparing`/`Queueing` (30%),
/// `Processing` (50%), `Success` (100%), `Fail` (100%, reason defaulting to
/// `task failed`); any other status is treated as in-progress at 30%.
///
/// Two faithfulness notes: (1) Go also sets `Status=Failure`/`Progress="100%"`
/// in the `base_resp` error branch, but the status switch below unconditionally
/// overrides both, so those are dead stores and are omitted here. (2) The
/// success URL comes from `buildVideoURL`, which performs an authenticated file-
/// retrieve HTTP call — that I/O lives in the Worker adaptor, so the pure parser
/// leaves `url` empty.
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: QueryTaskResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut code = 0;
    let mut reason = String::new();
    if resp.base_resp.status_code != 0 {
        code = resp.base_resp.status_code;
        reason = resp.base_resp.status_msg;
    }

    let (status, progress) = match resp.status.as_str() {
        "Preparing" | "Queueing" => (TaskStatus::InProgress, "30%"),
        "Processing" => (TaskStatus::InProgress, "50%"),
        "Success" => (TaskStatus::Success, "100%"),
        "Fail" => {
            if reason.is_empty() {
                reason = "task failed".to_string();
            }
            (TaskStatus::Failure, "100%")
        }
        _ => (TaskStatus::InProgress, "30%"),
    };

    Ok(TaskInfo {
        code,
        task_id: String::new(),
        status,
        reason,
        url: String::new(),
        remote_url: String::new(),
        progress: progress.to_string(),
        completion_tokens: 0,
        total_tokens: 0,
    })
}

/// Default duration when the request doesn't specify one (Go `DefaultDuration`).
const DEFAULT_DURATION: i64 = 6;

/// The per-model default resolution (Go `GetModelConfig().DefaultResolution`).
/// Only the four 768P models differ; every other model — and the unknown-model
/// fallback — defaults to 720P.
fn default_resolution_for_model(model: &str) -> &'static str {
    match model {
        "MiniMax-Hailuo-2.3"
        | "MiniMax-Hailuo-2.3-Fast"
        | "MiniMax-Hailuo-02"
        | "T2V-01-Director" => "768P",
        _ => "720P",
    }
}

/// Resolve the resolution from the request `size` (Go `parseResolutionFromSize`):
/// the first matching dimension token wins, otherwise the model default.
fn parse_resolution_from_size(size: &str, default_resolution: &str) -> String {
    if size.contains("1080") {
        "1080P".to_string()
    } else if size.contains("768") {
        "768P".to_string()
    } else if size.contains("720") {
        "720P".to_string()
    } else if size.contains("512") {
        "512P".to_string()
    } else {
        default_resolution.to_string()
    }
}

/// The Hailuo submit payload. The transform sets model/prompt/duration/
/// resolution; other fields (prompt_optimizer, frame images, …) arrive via the
/// metadata passthrough carried in `extra`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VideoRequest {
    model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    resolution: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Build the Hailuo submit payload from the client request — a port of
/// `convertToRequestPayload`. Duration defaults to 6, resolution comes from the
/// request size (or the per-model default), and metadata passthrough fields are
/// merged last (with `model` stripped). `upstream_model` is the channel-mapped
/// model name Go reads from `info.UpstreamModelName`.
pub fn convert_to_request_payload(
    req: &TaskSubmitReq,
    upstream_model: &str,
) -> Result<VideoRequest, String> {
    let duration = if req.duration > 0 {
        req.duration
    } else {
        DEFAULT_DURATION
    };
    let default_resolution = default_resolution_for_model(upstream_model);
    let resolution = if req.size.is_empty() {
        default_resolution.to_string()
    } else {
        parse_resolution_from_size(&req.size, default_resolution)
    };

    let mut payload = VideoRequest {
        model: upstream_model.to_string(),
        prompt: req.prompt.clone(),
        duration: Some(duration),
        resolution,
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
    fn resolution_from_size_and_model_default() {
        assert_eq!(parse_resolution_from_size("1920x1080", "720P"), "1080P");
        assert_eq!(parse_resolution_from_size("768x768", "720P"), "768P");
        assert_eq!(parse_resolution_from_size("512x512", "720P"), "512P");
        // Unknown size falls back to the provided default.
        assert_eq!(parse_resolution_from_size("weird", "768P"), "768P");
        // Model defaults.
        assert_eq!(default_resolution_for_model("MiniMax-Hailuo-02"), "768P");
        assert_eq!(default_resolution_for_model("T2V-01"), "720P");
        assert_eq!(default_resolution_for_model("unknown-model"), "720P");
    }

    #[test]
    fn request_payload_defaults_and_overrides() {
        // No duration/size -> default 6 + model default resolution.
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            ..Default::default()
        };
        let payload = convert_to_request_payload(&req, "T2V-01").unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({"model": "T2V-01", "prompt": "p", "duration": 6, "resolution": "720P"})
        );

        // Explicit duration + size + metadata.
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            duration: 10,
            size: "1080x1920".to_string(),
            metadata: Some(json!({"prompt_optimizer": true, "model": "evil"})),
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "MiniMax-Hailuo-02").unwrap())
                .unwrap();
        assert_eq!(value["duration"], json!(10));
        assert_eq!(value["resolution"], json!("1080P"));
        assert_eq!(value["prompt_optimizer"], json!(true));
        assert_eq!(value["model"], json!("MiniMax-Hailuo-02"));
    }

    #[test]
    fn live_states_carry_staged_progress() {
        for raw in ["Preparing", "Queueing"] {
            let info = parse_task_result(format!(r#"{{"status":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::InProgress, "{raw}");
            assert_eq!(info.progress, "30%", "{raw}");
        }
        let info = parse_task_result(br#"{"status":"Processing"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
        assert_eq!(info.progress, "50%");
    }

    #[test]
    fn success_is_100_percent_with_url_left_for_worker() {
        let info = parse_task_result(br#"{"status":"Success"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert!(info.url.is_empty()); // buildVideoURL is I/O, done by the worker
        assert_eq!(info.code, 0);
    }

    #[test]
    fn fail_status_defaults_reason() {
        let info = parse_task_result(br#"{"status":"Fail"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.reason, "task failed");
    }

    #[test]
    fn base_resp_error_sets_code_and_reason_but_switch_drives_status() {
        // base_resp error + unknown status -> default arm: InProgress/30%, with
        // the error code and message preserved from base_resp.
        let info = parse_task_result(
            br#"{"status":"","base_resp":{"status_code":1008,"status_msg":"rate limited"}}"#,
        )
        .unwrap();
        assert_eq!(info.code, 1008);
        assert_eq!(info.reason, "rate limited");
        assert_eq!(info.status, TaskStatus::InProgress);
        assert_eq!(info.progress, "30%");

        // base_resp error + "Fail" -> keeps the base_resp message as the reason.
        let info = parse_task_result(
            br#"{"status":"Fail","base_resp":{"status_code":2,"status_msg":"nsfw"}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "nsfw");
    }
}
