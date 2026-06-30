use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod providers;
pub mod taskcommon;

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

/// The billing action a CAS-won status transition implies during polling — the
/// settlement decision in Go's task pollers (`updateSunoTasks`, the video fetch
/// path): a terminal **failure** refunds the reserved quota, a terminal
/// **success** keeps the pre-charge (which the orchestration may still adjust by
/// the actual completion tokens), and everything else is no billing change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSettlement {
    /// No billing change: a mid-flight transition, or a move out of an
    /// already-terminal state (nothing left to settle).
    None,
    /// Terminal failure — refund the reserved quota to the user.
    Refund,
    /// Terminal success — keep the pre-charged quota.
    Keep,
}

/// Decide the settlement for a `from -> to` transition. Only a
/// [`is_settlement_transition`] (non-terminal → terminal) carries a billing
/// effect: `FAILURE` refunds, `SUCCESS` keeps the charge. Pure and exhaustive,
/// so the billing-critical decision is unit-tested without a D1; the worker
/// applies it after winning the status CAS.
pub fn settlement_for(from: TaskStatus, to: TaskStatus) -> TaskSettlement {
    if !is_settlement_transition(from, to) {
        return TaskSettlement::None;
    }
    match to {
        TaskStatus::Failure => TaskSettlement::Refund,
        TaskStatus::Success => TaskSettlement::Keep,
        // Unreachable: is_settlement_transition guarantees `to` is terminal,
        // and the only terminal states are Success/Failure.
        _ => TaskSettlement::None,
    }
}

/// Recalculate a task's quota when the upstream submit response reports actual
/// parameters (duration, resolution, …) that differ from the pre-charge
/// estimate — a faithful port of Go `recalcQuotaFromRatios` in
/// `relay/relay_task.go`.
///
/// `base_quota_with_old_ratios` is `PriceData.Quota`, which already has the
/// estimate's `OtherRatios` baked in. The function first divides those out to
/// recover the base price, then reapplies the new ratios. Two Go truncation
/// behaviors are preserved exactly:
/// - the divide-out truncates **per step** (`int(quota / ra)` each iteration);
/// - the reapply accumulates in floating point and truncates **once** at the
///   end.
/// Both `as i64` casts truncate toward zero, matching Go's `int(...)`. Ratios
/// equal to `1.0` are skipped (no-op), and non-positive ratios are skipped on
/// the divide-out side (Go's `ra > 0` guard) to avoid division by zero.
///
/// Note: Go iterates `OtherRatios`/`ratios` as maps, whose order is
/// unspecified; with per-step integer truncation the divide-out result can in
/// principle depend on order. Callers pass the ratio values as slices, so the
/// Rust order is explicit and reproducible — pass them in a stable order.
pub fn recalc_quota_from_ratios(
    base_quota_with_old_ratios: i64,
    old_ratios: &[f64],
    new_ratios: &[f64],
) -> i64 {
    let mut base = base_quota_with_old_ratios;
    for &ra in old_ratios {
        if ra != 1.0 && ra > 0.0 {
            base = (base as f64 / ra) as i64;
        }
    }
    let mut result = base as f64;
    for &ra in new_ratios {
        if ra != 1.0 {
            result *= ra;
        }
    }
    result as i64
}

/// Apply the estimate's `OtherRatios` to the base model quota for the pre-charge
/// — a port of step 6 of Go `RelayTaskSubmit`: multiply the base quota by each
/// ratio that isn't `1.0`, truncating toward zero **at each step**
/// (`int(float64(quota) * ra)` per ratio). This per-step truncation is distinct
/// from [`recalc_quota_from_ratios`], which accumulates in float and truncates
/// once. Models in Go's `TaskPricePatches` skip this entirely — the caller makes
/// that check and simply doesn't call this. Pure, so the pre-charge arithmetic
/// is unit-testable without the relay billing path.
pub fn apply_other_ratios(base_quota: i64, ratios: &[f64]) -> i64 {
    let mut quota = base_quota;
    for &ra in ratios {
        if ra != 1.0 {
            quota = (quota as f64 * ra) as i64;
        }
    }
    quota
}

/// Parsed result of polling an upstream task provider — a port of
/// `relaycommon.TaskInfo` (`relay/common/relay_info.go`). Each provider's
/// response parser (e.g. [`providers::kling::parse_task_result`]) maps its
/// upstream poll response onto this shape; the orchestration then drives the
/// status CAS and delta settlement from it. Internal type (drives billing/CAS),
/// distinct from the client-facing `TaskDto`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskInfo {
    pub code: i64,
    pub task_id: String,
    pub status: TaskStatus,
    pub reason: String,
    pub url: String,
    pub remote_url: String,
    pub progress: String,
    /// Actual upstream token charge reported on completion (drives delta
    /// settlement); 0 when the upstream reports none.
    pub completion_tokens: i64,
    pub total_tokens: i64,
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
    fn settlement_for_refunds_failure_keeps_success() {
        // Terminal failure from a live state -> refund.
        assert_eq!(
            settlement_for(TaskStatus::InProgress, TaskStatus::Failure),
            TaskSettlement::Refund
        );
        assert_eq!(
            settlement_for(TaskStatus::Queued, TaskStatus::Failure),
            TaskSettlement::Refund
        );
        // Terminal success from a live state -> keep the pre-charge.
        assert_eq!(
            settlement_for(TaskStatus::InProgress, TaskStatus::Success),
            TaskSettlement::Keep
        );
        // Mid-flight transitions and moves out of a terminal state -> no change.
        assert_eq!(
            settlement_for(TaskStatus::Queued, TaskStatus::InProgress),
            TaskSettlement::None
        );
        assert_eq!(
            settlement_for(TaskStatus::Success, TaskStatus::Failure),
            TaskSettlement::None
        );
        assert_eq!(
            settlement_for(TaskStatus::Failure, TaskStatus::Failure),
            TaskSettlement::None
        );
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

    #[test]
    fn recalc_quota_matches_go_arithmetic() {
        // No ratios on either side: quota unchanged.
        assert_eq!(recalc_quota_from_ratios(1000, &[], &[]), 1000);

        // Estimate baked in a 2.0 ratio; divide it out, reapply 3.0.
        // base = 2000 / 2.0 = 1000; result = 1000 * 3.0 = 3000.
        assert_eq!(recalc_quota_from_ratios(2000, &[2.0], &[3.0]), 3000);

        // Ratios of 1.0 are skipped on both sides (no-op).
        assert_eq!(recalc_quota_from_ratios(1500, &[1.0], &[1.0]), 1500);

        // Non-positive divide-out ratio is skipped (Go's ra > 0 guard), so the
        // base is untouched before the new ratio applies: 800 * 2.0 = 1600.
        assert_eq!(recalc_quota_from_ratios(800, &[0.0], &[2.0]), 1600);

        // Per-step truncation on divide-out: 1000 / 3.0 = 333.33 -> 333 (toward
        // zero), then * 2.0 = 666.0 -> 666.
        assert_eq!(recalc_quota_from_ratios(1000, &[3.0], &[2.0]), 666);

        // Reapply accumulates in float, truncating only once at the end:
        // base 100, new ratios 1.5 then 1.5 -> 100 * 2.25 = 225.0 -> 225.
        assert_eq!(recalc_quota_from_ratios(100, &[], &[1.5, 1.5]), 225);
    }

    #[test]
    fn apply_other_ratios_truncates_per_step() {
        assert_eq!(apply_other_ratios(1000, &[]), 1000);
        assert_eq!(apply_other_ratios(1000, &[2.0]), 2000);
        // 1.0 ratios are skipped.
        assert_eq!(apply_other_ratios(1000, &[1.0]), 1000);
        // Per-step truncation differs from a single accumulated multiply:
        // 3 * 1.5 = 4.5 -> 4, then * 2.0 = 8.0 -> 8 (accumulate would give 9).
        assert_eq!(apply_other_ratios(3, &[1.5, 2.0]), 8);
    }
}
