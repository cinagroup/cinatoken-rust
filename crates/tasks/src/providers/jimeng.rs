//! Pure response parser for the Jimeng (ByteDance) video task provider, ported
//! from `relay/channel/task/jimeng/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct ResponseTask {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: DataField,
}

#[derive(Deserialize, Default)]
struct DataField {
    #[serde(default)]
    status: String,
    #[serde(default)]
    video_url: String,
}

/// Map a Jimeng poll response onto a [`TaskInfo`]. A `code` other than the
/// success sentinel `10000` carries the error code and message as a failure.
/// Then the inner `data.status` switch recognizes only `in_queue` (queued, 10%)
/// and `done` (success, 100%) — any other status leaves whatever the code gate
/// produced. `data.video_url` is always copied to the URL (Go sets it
/// unconditionally after the switch).
///
/// Faithful quirks: when `code != 10000` but `data.status` is `done`/`in_queue`,
/// the switch overrides the failure status (Go runs the switch unconditionally).
/// When `code == 10000` but `data.status` is unrecognized, Go leaves the empty
/// zero-value status; this port uses [`TaskStatus::Unknown`] (same no-op).
pub fn parse_task_result(resp_body: &[u8]) -> Result<TaskInfo, String> {
    let resp: ResponseTask = serde_json::from_slice(resp_body)
        .map_err(|err| format!("unmarshal task result failed: {err}"))?;

    let mut code = 0;
    let mut reason = String::new();
    let mut status = TaskStatus::Unknown;
    let mut progress = String::new();
    if resp.code != 10000 {
        code = resp.code;
        reason = resp.message;
        status = TaskStatus::Failure;
        progress = "100%".to_string();
    }

    match resp.data.status.as_str() {
        "in_queue" => {
            status = TaskStatus::Queued;
            progress = "10%".to_string();
        }
        "done" => {
            status = TaskStatus::Success;
            progress = "100%".to_string();
        }
        _ => {}
    }

    Ok(TaskInfo {
        code,
        task_id: String::new(),
        status,
        reason,
        url: resp.data.video_url,
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
    fn success_code_with_known_states() {
        let info = parse_task_result(br#"{"code":10000,"data":{"status":"in_queue"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Queued);
        assert_eq!(info.progress, "10%");
        assert_eq!(info.code, 0);

        let info = parse_task_result(
            br#"{"code":10000,"data":{"status":"done","video_url":"https://cdn/v.mp4"}}"#,
        )
        .unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.url, "https://cdn/v.mp4");
    }

    #[test]
    fn error_code_is_failure() {
        let info =
            parse_task_result(br#"{"code":50500,"message":"quota exhausted","data":{}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Failure);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.code, 50500);
        assert_eq!(info.reason, "quota exhausted");
    }

    #[test]
    fn switch_overrides_error_code_when_state_is_terminal() {
        // Faithful quirk: the unconditional switch promotes an error-coded
        // response to success when data.status is "done".
        let info = parse_task_result(br#"{"code":50000,"data":{"status":"done"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Success);
        assert_eq!(info.progress, "100%");
        assert_eq!(info.code, 50000); // code passthrough is unchanged
    }

    #[test]
    fn success_code_unknown_state_is_unknown_no_op() {
        let info = parse_task_result(br#"{"code":10000,"data":{"status":"weird"}}"#).unwrap();
        assert_eq!(info.status, TaskStatus::Unknown);
        assert!(info.progress.is_empty());
    }
}
