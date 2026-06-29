//! Pure response parser for the Ali (DashScope) video task provider, ported
//! from `relay/channel/task/ali/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

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
    let resp: SubmitResponse = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal_response_body_failed: {err}"))?;
    if !resp.code.is_empty() {
        return Err(format!("{}: {}", resp.code, resp.message));
    }
    if resp.output.task_id.is_empty() {
        return Err("task_id is empty".to_string());
    }
    Ok(resp.output.task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

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
