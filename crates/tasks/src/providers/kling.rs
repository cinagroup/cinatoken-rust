//! Pure response parser for the Kling video task provider, ported from
//! `relay/channel/task/kling/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct Response {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    data: Data,
}

#[derive(Deserialize, Default)]
struct Data {
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    task_status: String,
    #[serde(default)]
    task_status_msg: String,
    #[serde(default)]
    task_result: TaskResult,
    #[serde(default)]
    final_unit_deduction: String,
}

#[derive(Deserialize, Default)]
struct TaskResult {
    #[serde(default)]
    videos: Vec<Video>,
}

#[derive(Deserialize, Default)]
struct Video {
    #[serde(default)]
    url: String,
}

/// Map a Kling poll response onto a [`TaskInfo`]. The upstream `task_status`
/// vocabulary is `submitted` / `processing` / `succeed` / `failed`; anything
/// else is an error (mirroring Go's `unknown task status` fallback). On
/// `succeed`, the first video URL is captured and `final_unit_deduction` is
/// parsed as a float and ceil'd into the actual token charge — but only when it
/// is positive, matching Go (`if rounded > 0`).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: Response = serde_json::from_slice(resp_body)
        .map_err(|err| format!("failed to unmarshal response body: {err}"))?;
    let data = resp.data;

    let mut url = String::new();
    let mut tokens = 0i64;
    let status = match data.task_status.as_str() {
        "submitted" => TaskStatus::Submitted,
        "processing" => TaskStatus::InProgress,
        "succeed" => {
            if let Some(video) = data.task_result.videos.first() {
                url = video.url.clone();
            }
            if let Ok(value) = data.final_unit_deduction.parse::<f64>() {
                let rounded = value.ceil() as i64;
                if rounded > 0 {
                    tokens = rounded;
                }
            }
            TaskStatus::Success
        }
        "failed" => TaskStatus::Failure,
        other => return Err(format!("unknown task status: {other}")),
    };

    Ok(TaskInfo {
        code: resp.code,
        task_id: data.task_id,
        status,
        reason: data.task_status_msg,
        url,
        remote_url: String::new(),
        progress: String::new(),
        completion_tokens: tokens,
        total_tokens: tokens,
    })
}

#[derive(Deserialize, Default)]
struct SubmitResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: SubmitData,
}

#[derive(Deserialize, Default)]
struct SubmitData {
    #[serde(default)]
    task_id: String,
}

/// Extract the upstream task id from a Kling submit response (Go `DoResponse`): a
/// non-zero `code` is an error (carrying `message`), otherwise return
/// `data.task_id`.
pub fn parse_submit_response(resp_body: &[u8]) -> Result<String, String> {
    let resp: SubmitResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_failed: {err}"))?;
    if resp.code != 0 {
        return Err(resp.message);
    }
    Ok(resp.data.task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_returns_task_id_or_message_on_error() {
        assert_eq!(
            parse_submit_response(br#"{"code":0,"data":{"task_id":"k_77"}}"#).unwrap(),
            "k_77"
        );
        assert_eq!(
            parse_submit_response(br#"{"code":1,"message":"quota exceeded"}"#).unwrap_err(),
            "quota exceeded"
        );
    }

    #[test]
    fn submitted_and_processing_map_to_live_states() {
        let info =
            parse_task_result(br#"{"code":0,"data":{"task_id":"t1","task_status":"submitted"}}"#)
                .unwrap();
        assert_eq!(info.status, TaskStatus::Submitted);
        assert_eq!(info.task_id, "t1");
        assert_eq!(info.completion_tokens, 0);
        assert!(info.url.is_empty());

        let info = parse_task_result(br#"{"data":{"task_status":"processing"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::InProgress);
    }

    #[test]
    fn succeed_extracts_url_and_ceils_deduction() {
        let body = br#"{
            "code": 0,
            "data": {
                "task_id": "abc",
                "task_status": "succeed",
                "task_status_msg": "ok",
                "task_result": { "videos": [ {"url": "https://cdn/v1.mp4"} ] },
                "final_unit_deduction": "3.2"
            }
        }"#;
        let info = parse_task_result(body).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.url, "https://cdn/v1.mp4");
        assert_eq!(info.reason, "ok");
        // ceil(3.2) = 4, applied to both completion and total tokens.
        assert_eq!(info.completion_tokens, 4);
        assert_eq!(info.total_tokens, 4);
    }

    #[test]
    fn succeed_without_deduction_or_videos_is_zero_tokens() {
        let info = parse_task_result(br#"{"data":{"task_status":"succeed"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.completion_tokens, 0);
        assert!(info.url.is_empty());
    }

    #[test]
    fn non_positive_deduction_does_not_set_tokens() {
        // "0" ceils to 0, which fails the `> 0` guard, so tokens stay 0.
        let info =
            parse_task_result(br#"{"data":{"task_status":"succeed","final_unit_deduction":"0"}}"#)
                .unwrap();
        assert_eq!(info.completion_tokens, 0);
    }

    #[test]
    fn failed_maps_to_failure() {
        let info =
            parse_task_result(br#"{"data":{"task_status":"failed","task_status_msg":"boom"}}"#)
                .unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "boom");
    }

    #[test]
    fn unknown_status_is_an_error() {
        let err = parse_task_result(br#"{"data":{"task_status":"weird"}}"#).unwrap_err();
        assert_eq!(err, "unknown task status: weird");
    }

    #[test]
    fn malformed_json_is_an_error() {
        let err = parse_task_result(b"not json").unwrap_err();
        assert!(err.starts_with("failed to unmarshal response body"));
    }
}
