//! Pure response parser + submit-body builder for the Ali (DashScope) video task
//! provider, ported from `relay/channel/task/ali/adaptor.go` (`ParseTaskResult`
//! and `convertToAliRequest`).

use crate::taskcommon::merge_value_deep;
use crate::{TaskInfo, TaskStatus, TaskSubmitReq};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Default)]
struct AliVideoResponse {
    #[serde(default)]
    output: AliVideoOutput,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize, Default)]
struct AliVideoOutput {
    #[serde(default)]
    task_status: String,
    #[serde(default)]
    video_url: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

/// Map an Ali poll response onto a [`TaskInfo`]. Status vocabulary (uppercase):
/// `PENDING` → queued, `RUNNING` → in-progress, `SUCCEEDED` → success (Ali
/// returns the video URL directly, no proxy needed), `FAILED`/`CANCELED`/
/// `UNKNOWN` → failure; any other status falls back to queued. The failure
/// reason prefers the top-level `message`, then a formatted `output.code` +
/// `output.message`, else `task failed`. Ali sets no progress string.
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: AliVideoResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut url = String::new();
    let mut reason = String::new();
    let status = match resp.output.task_status.as_str() {
        "PENDING" => TaskStatus::Queued,
        "RUNNING" => TaskStatus::InProgress,
        "SUCCEEDED" => {
            url = resp.output.video_url;
            TaskStatus::Success
        }
        "FAILED" | "CANCELED" | "UNKNOWN" => {
            reason = if !resp.message.is_empty() {
                resp.message
            } else if !resp.output.message.is_empty() {
                format!(
                    "task failed, code: {} , message: {}",
                    resp.output.code, resp.output.message
                )
            } else {
                "task failed".to_string()
            };
            TaskStatus::Failure
        }
        _ => TaskStatus::Queued,
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
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    output: SubmitOutput,
}

#[derive(Deserialize, Default)]
struct SubmitOutput {
    #[serde(default)]
    task_id: String,
}

/// Extract the upstream task id from an Ali submit response (Go `DoResponse`): a
/// non-empty top-level `code` is an API error (`"<code>: <message>"`), an empty
/// `output.task_id` is an error, otherwise return `output.task_id`.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    parse_submit_response_classified(resp_body).map_err(super::SubmitResponseFailure::into_message)
}

pub fn parse_submit_response_classified(
    resp_body: &[u8],
) -> Result<String, super::SubmitResponseFailure> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body).map_err(|err| {
        super::SubmitResponseFailure::Unknown(format!("unmarshal_response_body_failed: {err}"))
    })?;
    if !resp.code.is_empty() {
        return Err(super::SubmitResponseFailure::Rejected(format!(
            "{}: {}",
            resp.code, resp.message
        )));
    }
    if resp.output.task_id.is_empty() {
        return Err(super::SubmitResponseFailure::Unknown(
            "task_id is empty".to_string(),
        ));
    }
    Ok(resp.output.task_id)
}

/// Resolve Ali's submit `(size, resolution, duration)` from the request — the
/// non-trivial core of Go `convertToAliRequest`. `model` is the client model
/// (Go's prefix checks read `req.Model`). Exactly one of `size`/`resolution` is
/// set per Go's branching:
/// - explicit size containing `*` → `size`; otherwise it's upcased to a
///   resolution (a trailing `P` is appended if missing);
/// - a t2v request with a `*`-less explicit size is an error;
/// - no size → a model-prefix default (t2v: `1920*1080` for wan2.5/wan2.2 else
///   `1280*720`; i2v: `1080P` for wan2.6/wan2.5/wan2.2-i2v-plus, `720P` for
///   wan2.2-i2v-flash and the rest).
///
/// Duration is `req.Duration` when positive, else parsed from `seconds` (error on
/// non-numeric), else the default 5. The struct assembly + metadata merge around
/// this is worker-side (Ali merges metadata without stripping `model`, unlike
/// the other providers).
pub fn resolve_parameters(
    model: &str,
    size: &str,
    duration: i64,
    seconds: &str,
) -> Result<(String, String, i64), String> {
    let mut out_size = String::new();
    let mut out_resolution = String::new();

    if !size.is_empty() {
        if model.contains("t2v") && !size.contains('*') {
            return Err(format!("invalid size: {size}, example: 1920*1080"));
        }
        if size.contains('*') {
            out_size = size.to_string();
        } else {
            let mut resolution = size.to_uppercase();
            if !resolution.ends_with('P') {
                resolution.push('P');
            }
            out_resolution = resolution;
        }
    } else if model.contains("t2v") {
        out_size = if model.starts_with("wan2.5") || model.starts_with("wan2.2") {
            "1920*1080".to_string()
        } else {
            "1280*720".to_string()
        };
    } else {
        out_resolution = if model.starts_with("wan2.6") || model.starts_with("wan2.5") {
            "1080P".to_string()
        } else if model.starts_with("wan2.2-i2v-flash") {
            "720P".to_string()
        } else if model.starts_with("wan2.2-i2v-plus") {
            "1080P".to_string()
        } else {
            "720P".to_string()
        };
    }

    let out_duration = if duration > 0 {
        duration
    } else if !seconds.is_empty() {
        seconds
            .parse::<i64>()
            .map_err(|_| "convert seconds to int failed".to_string())?
    } else {
        5
    };

    Ok((out_size, out_resolution, out_duration))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AliVideoInput {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    prompt: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    img_url: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AliVideoParameters {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    resolution: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    size: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    duration: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    prompt_extend: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    watermark: bool,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// The Ali submit payload (`input` + `parameters` are always serialized, as in
/// Go). The transform fills model/input/parameters; metadata is deep-merged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AliVideoRequest {
    model: String,
    input: AliVideoInput,
    parameters: AliVideoParameters,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Build the Ali submit payload from the client request — a port of
/// `convertToAliRequest`. Model is the upstream model; the size/resolution/
/// duration come from [`resolve_parameters`] (which keys off the *client* model);
/// `prompt_extend` defaults on, `watermark` off. Metadata is deep-merged
/// **without** stripping `model` (Ali unmarshals raw metadata into the request),
/// unlike the other providers' [`crate::taskcommon::merge_metadata`].
pub fn convert_to_request_payload(
    req: &TaskSubmitReq,
    upstream_model: &str,
) -> Result<AliVideoRequest, String> {
    let (size, resolution, duration) =
        resolve_parameters(&req.model, &req.size, req.duration, &req.seconds)?;

    let mut payload = AliVideoRequest {
        model: upstream_model.to_string(),
        input: AliVideoInput {
            prompt: req.prompt.clone(),
            img_url: req.input_reference.clone(),
            extra: Map::new(),
        },
        parameters: AliVideoParameters {
            resolution,
            size,
            duration,
            prompt_extend: true,
            watermark: false,
            extra: Map::new(),
        },
        extra: Map::new(),
    };

    if let Some(metadata) = &req.metadata {
        let mut value = serde_json::to_value(&payload).map_err(|err| err.to_string())?;
        merge_value_deep(&mut value, metadata);
        payload = serde_json::from_value(value).map_err(|err| err.to_string())?;
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_payload_assembly_and_deep_metadata() {
        // i2v model, no size -> resolution default 720P; prompt + img_url; duration 5.
        let req = TaskSubmitReq {
            prompt: "p".to_string(),
            input_reference: "https://i/1.png".to_string(),
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "wan-i2v").unwrap()).unwrap();
        assert_eq!(
            value,
            json!({
                "model": "wan-i2v",
                "input": {"prompt": "p", "img_url": "https://i/1.png"},
                "parameters": {"resolution": "720P", "duration": 5, "prompt_extend": true}
            })
        );

        // Deep metadata merge into parameters (model NOT stripped).
        let req = TaskSubmitReq {
            metadata: Some(json!({"model": "override", "parameters": {"seed": 9}})),
            ..Default::default()
        };
        let value =
            serde_json::to_value(convert_to_request_payload(&req, "wan-i2v").unwrap()).unwrap();
        assert_eq!(value["model"], json!("override")); // Ali keeps metadata model
        assert_eq!(value["parameters"]["seed"], json!(9));
        assert_eq!(value["parameters"]["resolution"], json!("720P")); // computed value preserved
    }

    #[test]
    fn resolve_parameters_size_and_resolution() {
        // Explicit "*" size -> size; t2v happy path.
        assert_eq!(
            resolve_parameters("wan2.2-t2v", "1920*1080", 0, "").unwrap(),
            ("1920*1080".to_string(), String::new(), 5)
        );
        // t2v + size without "*" -> error.
        assert!(resolve_parameters("wan2.2-t2v", "720p", 0, "").is_err());
        // i2v + bare size -> upcased resolution with trailing P.
        assert_eq!(
            resolve_parameters("wan-i2v", "720p", 0, "").unwrap(),
            (String::new(), "720P".to_string(), 5)
        );
    }

    #[test]
    fn resolve_parameters_model_defaults() {
        // t2v defaults.
        assert_eq!(
            resolve_parameters("wan2.2-t2v", "", 0, "").unwrap().0,
            "1920*1080"
        );
        assert_eq!(
            resolve_parameters("foo-t2v", "", 0, "").unwrap().0,
            "1280*720"
        );
        // i2v resolution defaults.
        assert_eq!(
            resolve_parameters("wan2.5-i2v", "", 0, "").unwrap().1,
            "1080P"
        );
        assert_eq!(
            resolve_parameters("wan2.2-i2v-flash", "", 0, "").unwrap().1,
            "720P"
        );
        assert_eq!(
            resolve_parameters("wan2.2-i2v-plus", "", 0, "").unwrap().1,
            "1080P"
        );
        assert_eq!(
            resolve_parameters("other-i2v", "", 0, "").unwrap().1,
            "720P"
        );
    }

    #[test]
    fn resolve_parameters_duration() {
        assert_eq!(resolve_parameters("m-i2v", "720p", 8, "").unwrap().2, 8);
        assert_eq!(resolve_parameters("m-i2v", "720p", 0, "10").unwrap().2, 10);
        assert_eq!(resolve_parameters("m-i2v", "720p", 0, "").unwrap().2, 5);
        assert!(resolve_parameters("m-i2v", "720p", 0, "bad").is_err());
    }

    #[test]
    fn submit_extracts_output_task_id_with_error_checks() {
        assert_eq!(
            parse_submit_response(br#"{"output":{"task_id":"ali_5"}}"#).unwrap(),
            "ali_5"
        );
        assert_eq!(
            parse_submit_response(br#"{"code":"InvalidApiKey","message":"bad key"}"#).unwrap_err(),
            "InvalidApiKey: bad key"
        );
        assert_eq!(
            parse_submit_response(br#"{"output":{}}"#).unwrap_err(),
            "task_id is empty"
        );
    }

    #[test]
    fn pending_running_succeeded() {
        let info = parse_task_result(br#"{"output":{"task_status":"PENDING"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Queued);

        let info = parse_task_result(br#"{"output":{"task_status":"RUNNING"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);

        let info = parse_task_result(
            br#"{"output":{"task_status":"SUCCEEDED","video_url":"https://cdn/a.mp4"}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.url, "https://cdn/a.mp4");
    }

    #[test]
    fn failure_reason_precedence() {
        // Top-level message wins.
        let info = parse_task_result(
            br#"{"message":"top","output":{"task_status":"FAILED","code":"C1","message":"out"}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "top");

        // Falls back to formatted output code+message.
        let info = parse_task_result(
            br#"{"output":{"task_status":"CANCELED","code":"C1","message":"out"}}"#,
        )
        .unwrap();
        assert_eq!(info.reason, "task failed, code: C1 , message: out");

        // Nothing -> default.
        let info = parse_task_result(br#"{"output":{"task_status":"UNKNOWN"}}"#).unwrap();
        assert_eq!(info.reason, "task failed");
    }

    #[test]
    fn unrecognized_status_falls_back_to_queued() {
        let info = parse_task_result(br#"{"output":{"task_status":"WAT"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Queued);
    }
}
