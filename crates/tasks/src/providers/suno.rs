//! Pure pieces of the Suno task provider, ported from `dto/suno.go`,
//! `dto/task.go`, and the polling gate in `service/task_polling.go`.
//!
//! Suno polls in batches (`updateSunoTasks`) rather than one task at a time, so
//! there is no per-task `ParseTaskResult`. The stateful merge (applying fields
//! to the task row and refunding on failure) is orchestration with side effects
//! and lives in the Worker; the pure, testable pieces are the response envelope,
//! the per-item DTO, and the [`task_needs_update`] change-detection gate.

use serde::Deserialize;
use serde_json::Value;

/// Generic task response envelope — Go `dto.TaskResponse[T]` (`dto/task.go`).
#[derive(Debug, Clone, Deserialize)]
pub struct TaskResponse<T> {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    pub data: T,
}

impl<T> TaskResponse<T> {
    /// Go `TaskResponse.IsSuccess`: `code == "success"` (`TaskSuccessCode`).
    pub fn is_success(&self) -> bool {
        self.code == "success"
    }
}

/// One Suno task item in a batch poll response — Go `dto.SunoDataResponse`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SunoDataResponse {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub fail_reason: String,
    #[serde(default)]
    pub submit_time: i64,
    #[serde(default)]
    pub start_time: i64,
    #[serde(default)]
    pub finish_time: i64,
    #[serde(default)]
    pub data: Value,
}

/// The current persisted task fields the gate compares against (the subset of
/// the task row Go's `taskNeedsUpdate` reads from `oldTask`).
pub struct CurrentTaskState<'a> {
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub status: &'a str,
    pub fail_reason: &'a str,
    pub progress: &'a str,
    pub data: &'a Value,
}

/// Whether an incoming batch item differs from the stored task enough to apply —
/// a port of Go `taskNeedsUpdate` (`service/task_polling.go`). Returns true when
/// any of submit/start/finish time, status, or fail reason changed, when the
/// task is terminal but its progress has not yet been pinned to `100%`, or when
/// the `data` payload changed.
///
/// Faithfulness note: Go compares `data` by marshaling both sides and sorting
/// the raw bytes (an order-tolerant hack). This port compares the decoded
/// `serde_json::Value` directly, which is the cleaner expression of the same
/// intent ("did the data change") and avoids spurious updates from mere key-order
/// or formatting differences.
pub fn task_needs_update(current: &CurrentTaskState, incoming: &SunoDataResponse) -> bool {
    current.submit_time != incoming.submit_time
        || current.start_time != incoming.start_time
        || current.finish_time != incoming.finish_time
        || current.status != incoming.status
        || current.fail_reason != incoming.fail_reason
        || ((current.status == "FAILURE" || current.status == "SUCCESS")
            && current.progress != "100%")
        || *current.data != incoming.data
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_is_success_only_on_success_code() {
        let resp: TaskResponse<Vec<SunoDataResponse>> =
            serde_json::from_slice(br#"{"code":"success","data":[]}"#).unwrap();
        assert!(resp.is_success());
        assert!(resp.data.is_empty());

        let resp: TaskResponse<Vec<SunoDataResponse>> =
            serde_json::from_slice(br#"{"code":"fail","message":"x","data":[]}"#).unwrap();
        assert!(!resp.is_success());
    }

    #[test]
    fn data_item_deserializes() {
        let resp: TaskResponse<Vec<SunoDataResponse>> = serde_json::from_slice(
            br#"{"code":"success","data":[{"task_id":"t1","status":"IN_PROGRESS","submit_time":5}]}"#,
        )
        .unwrap();
        assert_eq!(resp.data[0].task_id, "t1");
        assert_eq!(resp.data[0].status, "IN_PROGRESS");
        assert_eq!(resp.data[0].submit_time, 5);
    }

    fn base_current<'a>(data: &'a Value) -> CurrentTaskState<'a> {
        CurrentTaskState {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "IN_PROGRESS",
            fail_reason: "",
            progress: "50%",
            data,
        }
    }

    #[test]
    fn no_change_means_no_update() {
        let data = json!({"a": 1});
        let current = base_current(&data);
        let incoming = SunoDataResponse {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "IN_PROGRESS".to_string(),
            fail_reason: String::new(),
            data: json!({"a": 1}),
            ..Default::default()
        };
        assert!(!task_needs_update(&current, &incoming));
    }

    #[test]
    fn scalar_field_changes_trigger_update() {
        let data = json!({"a": 1});
        let base = SunoDataResponse {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "IN_PROGRESS".to_string(),
            data: json!({"a": 1}),
            ..Default::default()
        };
        // status changed
        let mut incoming = base.clone();
        incoming.status = "SUCCESS".to_string();
        assert!(task_needs_update(&base_current(&data), &incoming));
        // finish_time changed
        let mut incoming = base.clone();
        incoming.finish_time = 99;
        assert!(task_needs_update(&base_current(&data), &incoming));
        // fail_reason changed
        let mut incoming = base.clone();
        incoming.fail_reason = "boom".to_string();
        assert!(task_needs_update(&base_current(&data), &incoming));
    }

    #[test]
    fn terminal_without_pinned_progress_triggers_update() {
        // Everything matches, but the task is SUCCESS and progress isn't 100%.
        let data = json!({"a": 1});
        let mut current = base_current(&data);
        current.status = "SUCCESS";
        current.progress = "50%";
        let incoming = SunoDataResponse {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "SUCCESS".to_string(),
            data: json!({"a": 1}),
            ..Default::default()
        };
        assert!(task_needs_update(&current, &incoming));

        // Same but progress already pinned -> no update.
        let mut current = base_current(&data);
        current.status = "SUCCESS";
        current.progress = "100%";
        assert!(!task_needs_update(&current, &incoming));
    }

    #[test]
    fn data_change_triggers_update_order_insensitively() {
        let data = json!({"a": 1, "b": 2});
        let current = base_current(&data);
        // Same keys, different order -> Value equality holds -> no update.
        let incoming = SunoDataResponse {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "IN_PROGRESS".to_string(),
            data: json!({"b": 2, "a": 1}),
            ..Default::default()
        };
        assert!(!task_needs_update(&current, &incoming));
        // Genuinely different data -> update.
        let incoming = SunoDataResponse {
            submit_time: 1,
            start_time: 2,
            finish_time: 3,
            status: "IN_PROGRESS".to_string(),
            data: json!({"a": 2}),
            ..Default::default()
        };
        assert!(task_needs_update(&current, &incoming));
    }
}
