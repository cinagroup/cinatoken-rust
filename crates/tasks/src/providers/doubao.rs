//! Pure response parser for the Doubao (Volcengine) video task provider, ported
//! from `relay/channel/task/doubao/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
