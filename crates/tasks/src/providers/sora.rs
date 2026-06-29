//! Pure response parser for the Sora video task provider, ported from
//! `relay/channel/task/sora/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct ResponseTask {
    #[serde(default)]
    status: String,
    #[serde(default)]
    progress: i64,
    #[serde(default)]
    error: Option<ErrorInfo>,
}

#[derive(Deserialize)]
struct ErrorInfo {
    #[serde(default)]
    message: String,
}

/// Map a Sora poll response onto a [`TaskInfo`]. Status vocabulary:
/// `queued`/`pending` → queued, `processing`/`in_progress` → in-progress,
/// `completed` → success (URL intentionally left empty — the caller builds the
/// proxy URL from the public task ID), `failed`/`cancelled` → failure (reason
/// from the error object, or `task failed`). Progress is rendered as `"<n>%"`
/// only while strictly between 0 and 100, matching Go.
///
/// Go leaves an unrecognized status as the empty zero-value (no error); this
/// port uses [`TaskStatus::Unknown`], which is the equivalent no-op for the
/// orchestration (it drives no lifecycle transition).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: ResponseTask = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut reason = String::new();
    let status = match resp.status.as_str() {
        "queued" | "pending" => TaskStatus::Queued,
        "processing" | "in_progress" => TaskStatus::InProgress,
        "completed" => TaskStatus::Success,
        "failed" | "cancelled" => {
            reason = match resp.error {
                Some(error) => error.message,
                None => "task failed".to_string(),
            };
            TaskStatus::Failure
        }
        _ => TaskStatus::Unknown,
    };

    let progress = if resp.progress > 0 && resp.progress < 100 {
        format!("{}%", resp.progress)
    } else {
        String::new()
    };

    Ok(TaskInfo {
        code: 0,
        task_id: String::new(),
        status,
        reason,
        url: String::new(),
        remote_url: String::new(),
        progress,
        completion_tokens: 0,
        total_tokens: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_vocabulary_maps_to_lifecycle() {
        for raw in ["queued", "pending"] {
            let info = parse_task_result(format!(r#"{{"status":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::Queued, "{raw}");
        }
        for raw in ["processing", "in_progress"] {
            let info = parse_task_result(format!(r#"{{"status":"{raw}"}}"#).as_bytes()).unwrap();
            assert_eq!(info.status, TaskStatus::InProgress, "{raw}");
        }
        let info = parse_task_result(br#"{"status":"completed"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert!(info.url.is_empty()); // caller builds the proxy URL
    }

    #[test]
    fn failure_reason_from_error_or_default() {
        let info = parse_task_result(br#"{"status":"failed","error":{"message":"nsfw"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "nsfw");

        // No error object -> Go's "task failed" default.
        let info = parse_task_result(br#"{"status":"cancelled"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.reason, "task failed");
    }

    #[test]
    fn progress_only_rendered_strictly_between_0_and_100() {
        assert_eq!(
            parse_task_result(br#"{"status":"processing","progress":45}"#)
                .unwrap()
                .progress,
            "45%"
        );
        // Boundaries (0 and 100) and out-of-range render nothing.
        for p in ["0", "100"] {
            let info = parse_task_result(
                format!(r#"{{"status":"processing","progress":{p}}}"#).as_bytes(),
            )
            .unwrap();
            assert!(info.progress.is_empty(), "progress {p}");
        }
    }

    #[test]
    fn unrecognized_status_is_unknown_no_op() {
        let info = parse_task_result(br#"{"status":"weird"}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Unknown);
    }
}
