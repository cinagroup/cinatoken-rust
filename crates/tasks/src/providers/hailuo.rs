//! Pure response parser for the Hailuo (MiniMax) video task provider, ported
//! from `relay/channel/task/hailuo/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
