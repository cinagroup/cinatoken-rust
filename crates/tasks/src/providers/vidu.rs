//! Pure response parser for the Vidu video task provider, ported from
//! `relay/channel/task/vidu/adaptor.go` (`ParseTaskResult`).

use crate::{TaskInfo, TaskStatus};
use serde::Deserialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
