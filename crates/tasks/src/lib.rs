use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Task lifecycle status — a faithful port of Go `model.TaskStatus`
/// (`model/task.go`), including its exact wire string values. The D1 `tasks`
/// table stores these strings in its `status` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    NotStart,
    Submitted,
    Queued,
    InProgress,
    Success,
    Failure,
    Unknown,
}

impl TaskStatus {
    /// The Go string value (e.g. `IN_PROGRESS`) stored in `tasks.status`.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::NotStart => "NOT_START",
            TaskStatus::Submitted => "SUBMITTED",
            TaskStatus::Queued => "QUEUED",
            TaskStatus::InProgress => "IN_PROGRESS",
            TaskStatus::Success => "SUCCESS",
            TaskStatus::Failure => "FAILURE",
            TaskStatus::Unknown => "UNKNOWN",
        }
    }

    /// Parse a stored Go status string; unrecognized values map to `Unknown`
    /// (Go's default fallback).
    pub fn from_status_str(value: &str) -> TaskStatus {
        match value {
            "NOT_START" => TaskStatus::NotStart,
            "SUBMITTED" => TaskStatus::Submitted,
            "QUEUED" => TaskStatus::Queued,
            "IN_PROGRESS" => TaskStatus::InProgress,
            "SUCCESS" => TaskStatus::Success,
            "FAILURE" => TaskStatus::Failure,
            _ => TaskStatus::Unknown,
        }
    }

    /// Terminal statuses are never re-settled or refunded — the basis of the
    /// CAS double-refund guard (item 4.2): a settle/refund only proceeds when a
    /// conditional `UPDATE ... WHERE status = <non-terminal>` wins (affects one
    /// row), so a task already in `SUCCESS`/`FAILURE` cannot be billed or
    /// refunded twice.
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskStatus::Success | TaskStatus::Failure)
    }

    /// Project to the OpenAI-video API status vocabulary (Go
    /// `TaskStatus.ToVideoStatus`, values from `dto/openai_video.go`). Used by
    /// the video task-status endpoint.
    pub fn to_video_status(self) -> &'static str {
        match self {
            TaskStatus::Queued | TaskStatus::Submitted => "queued",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Success => "completed",
            TaskStatus::Failure => "failed",
            // NOT_START / UNKNOWN
            _ => "unknown",
        }
    }

    /// Project to the simple polling vocabulary (Go `mapTaskStatusToSimple` in
    /// `relay/relay_task.go`). Note the asymmetry with [`Self::to_video_status`]:
    /// success is `succeeded` (not `completed`) and the non-terminal default is
    /// `processing` (not `unknown`), so `IN_PROGRESS` and `NOT_START` both map
    /// to `processing` here.
    pub fn to_simple_status(self) -> &'static str {
        match self {
            TaskStatus::Success => "succeeded",
            TaskStatus::Failure => "failed",
            TaskStatus::Queued | TaskStatus::Submitted => "queued",
            // NOT_START / IN_PROGRESS / UNKNOWN
            _ => "processing",
        }
    }
}

/// Whether a `from -> to` transition is a billable settlement: leaving a
/// non-terminal state for a terminal one (`SUCCESS`/`FAILURE`). A status-CAS win
/// (Go `Task.UpdateWithStatus`) that matches this predicate is the one-time
/// point at which the caller settles or refunds the task's quota; a transition
/// that does not match (e.g. `QUEUED -> IN_PROGRESS`, or any move out of an
/// already-terminal state) carries no billing effect. Pure, so the guard is
/// unit-testable without a D1.
pub fn is_settlement_transition(from: TaskStatus, to: TaskStatus) -> bool {
    !from.is_terminal() && to.is_terminal()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub id: i64,
    pub public_task_id: String,
    pub upstream_task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub model: String,
    pub quota: i64,
    pub status: TaskStatus,
    pub progress: String,
    pub result_url: Option<String>,
    pub data: Value,
}

#[async_trait(?Send)]
pub trait TaskRepository {
    async fn insert(&self, task: &TaskRecord) -> cinatoken_core::ApiResult<()>;
    async fn update_status(
        &self,
        public_task_id: &str,
        status: TaskStatus,
        result_url: Option<String>,
    ) -> cinatoken_core::ApiResult<()>;
    async fn get_by_public_id(&self, public_task_id: &str)
        -> cinatoken_core::ApiResult<TaskRecord>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_strings_match_go_and_round_trip() {
        let cases = [
            (TaskStatus::NotStart, "NOT_START"),
            (TaskStatus::Submitted, "SUBMITTED"),
            (TaskStatus::Queued, "QUEUED"),
            (TaskStatus::InProgress, "IN_PROGRESS"),
            (TaskStatus::Success, "SUCCESS"),
            (TaskStatus::Failure, "FAILURE"),
            (TaskStatus::Unknown, "UNKNOWN"),
        ];
        for (status, text) in cases {
            assert_eq!(status.as_str(), text);
            assert_eq!(TaskStatus::from_status_str(text), status);
        }
        // Unrecognized -> Unknown (Go's fallback).
        assert_eq!(TaskStatus::from_status_str("BOGUS"), TaskStatus::Unknown);
        assert_eq!(TaskStatus::from_status_str(""), TaskStatus::Unknown);
    }

    #[test]
    fn only_success_and_failure_are_terminal() {
        assert!(TaskStatus::Success.is_terminal());
        assert!(TaskStatus::Failure.is_terminal());
        for status in [
            TaskStatus::NotStart,
            TaskStatus::Submitted,
            TaskStatus::Queued,
            TaskStatus::InProgress,
            TaskStatus::Unknown,
        ] {
            assert!(!status.is_terminal(), "{status:?} must not be terminal");
        }
    }

    #[test]
    fn settlement_only_on_nonterminal_to_terminal() {
        // Billable settlements: entering a terminal state from a live one.
        assert!(is_settlement_transition(
            TaskStatus::InProgress,
            TaskStatus::Success
        ));
        assert!(is_settlement_transition(
            TaskStatus::Queued,
            TaskStatus::Failure
        ));
        assert!(is_settlement_transition(
            TaskStatus::Submitted,
            TaskStatus::Failure
        ));

        // Mid-flight transitions carry no billing effect.
        assert!(!is_settlement_transition(
            TaskStatus::Queued,
            TaskStatus::InProgress
        ));
        assert!(!is_settlement_transition(
            TaskStatus::NotStart,
            TaskStatus::Submitted
        ));

        // Already terminal: never re-settles (the double-refund guard).
        assert!(!is_settlement_transition(
            TaskStatus::Success,
            TaskStatus::Failure
        ));
        assert!(!is_settlement_transition(
            TaskStatus::Failure,
            TaskStatus::Success
        ));
    }

    #[test]
    fn video_status_projection_matches_go() {
        let cases = [
            (TaskStatus::NotStart, "unknown"),
            (TaskStatus::Submitted, "queued"),
            (TaskStatus::Queued, "queued"),
            (TaskStatus::InProgress, "in_progress"),
            (TaskStatus::Success, "completed"),
            (TaskStatus::Failure, "failed"),
            (TaskStatus::Unknown, "unknown"),
        ];
        for (status, expected) in cases {
            assert_eq!(status.to_video_status(), expected, "{status:?}");
        }
    }

    #[test]
    fn simple_status_projection_matches_go() {
        let cases = [
            (TaskStatus::NotStart, "processing"),
            (TaskStatus::Submitted, "queued"),
            (TaskStatus::Queued, "queued"),
            (TaskStatus::InProgress, "processing"),
            (TaskStatus::Success, "succeeded"),
            (TaskStatus::Failure, "failed"),
            (TaskStatus::Unknown, "processing"),
        ];
        for (status, expected) in cases {
            assert_eq!(status.to_simple_status(), expected, "{status:?}");
        }
    }
}
