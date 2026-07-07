//! Durable Object alarm foundation for async task fast-path settlement.
//!
//! The scheduled Worker cron remains the correctness spine. This DO is the
//! optional M5b substrate: one deterministic object per public task id, with a
//! single alarm that can wake the task-specific poll path before the next
//! minute cron tick. It is default-off and the scheduled cron remains the
//! correctness spine.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use worker::{durable_object, Env, Request, Response, Result as WorkerResult, State};

use crate::d1_repositories::find_channel_by_id;
use crate::task_orchestration::poll_one_task;
use crate::task_repository::find_task_by_task_id;

pub const TASK_RUNNER_BINDING: &str = "TASK_RUNNER";
pub const TASK_RUNNER_DO_ENABLED_ENV: &str = "TASK_RUNNER_DO_ENABLED";
pub const TASK_RUNNER_STAGING_REPLAY_VERIFIED_ENV: &str = "TASK_RUNNER_STAGING_REPLAY_VERIFIED";
pub const TASK_RUNNER_DEFAULT_ALARM_DELAY_MS: i64 = 15_000;
pub const TASK_RUNNER_MIN_ALARM_DELAY_MS: i64 = 1_000;
pub const TASK_RUNNER_MAX_ALARM_DELAY_MS: i64 = 60_000;
pub const TASK_RUNNER_RECORD_KEY: &str = "task_runner_record_v1";
const TASK_RUNNER_INSTANCE_PREFIX: &str = "task:";

const TASK_RUNNER_CUTOVER_GUARDS: &[&str] = &[
    "task_runner_binding",
    "task_runner_gate",
    "deterministic_task_instance",
    "alarm_contract",
    "submit_path_armed",
    "cron_sweeper_fallback",
    "no_double_poll_cas",
    "staging_alarm_replay",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskRunnerRecord {
    task_id: String,
    armed_at_ms: i64,
    alarm_delay_ms: i64,
    #[serde(default)]
    alarm_fired_at_ms: Option<i64>,
    #[serde(default)]
    alarm_fired_count: u32,
    #[serde(default)]
    poll_attempted_at_ms: Option<i64>,
    #[serde(default)]
    poll_completed_at_ms: Option<i64>,
    #[serde(default)]
    poll_status: Option<TaskRunnerPollStatus>,
    #[serde(default)]
    poll_reason: Option<String>,
    #[serde(default)]
    poll_cas_won: Option<bool>,
    status: TaskRunnerStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerStatus {
    Armed,
    AlarmFired,
    PollSkipped,
    PollNoop,
    PollApplied,
    PollFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerPollStatus {
    Skipped,
    Noop,
    Applied,
    Failed,
}

#[derive(Debug, Serialize)]
struct TaskRunnerStatusResponse {
    compiled: bool,
    task_id: Option<String>,
    status: Option<TaskRunnerStatus>,
    alarm_scheduled_at_ms: Option<i64>,
    alarm_delay_ms: Option<i64>,
    alarm_fired_at_ms: Option<i64>,
    alarm_fired_count: u32,
    poll_attempted_at_ms: Option<i64>,
    poll_completed_at_ms: Option<i64>,
    poll_status: Option<TaskRunnerPollStatus>,
    poll_reason: Option<String>,
    poll_cas_won: Option<bool>,
}

#[durable_object]
pub struct TaskRunner {
    state: State,
    env: Env,
}

#[durable_object]
impl DurableObject for TaskRunner {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        let url = req.url()?;
        match url.path() {
            "/status" => {
                let record = self.load_record().await;
                let alarm_scheduled_at_ms = self.state.storage().get_alarm().await?;
                let response = TaskRunnerStatusResponse {
                    compiled: task_runner_alarm_contract_compiled(),
                    task_id: record.as_ref().map(|record| record.task_id.clone()),
                    status: record.as_ref().map(|record| record.status),
                    alarm_scheduled_at_ms,
                    alarm_delay_ms: record.as_ref().map(|record| record.alarm_delay_ms),
                    alarm_fired_at_ms: record.as_ref().and_then(|record| record.alarm_fired_at_ms),
                    alarm_fired_count: record
                        .as_ref()
                        .map(|record| record.alarm_fired_count)
                        .unwrap_or(0),
                    poll_attempted_at_ms: record
                        .as_ref()
                        .and_then(|record| record.poll_attempted_at_ms),
                    poll_completed_at_ms: record
                        .as_ref()
                        .and_then(|record| record.poll_completed_at_ms),
                    poll_status: record.as_ref().and_then(|record| record.poll_status),
                    poll_reason: record
                        .as_ref()
                        .and_then(|record| record.poll_reason.clone()),
                    poll_cas_won: record.as_ref().and_then(|record| record.poll_cas_won),
                };
                Response::from_json(&response)
            }
            "/arm" => {
                let task_id = task_id_query_value(&url)?;
                let delay_ms =
                    task_runner_alarm_delay_ms(query_i64(&url, "delay_ms").unwrap_or_default());
                let record = TaskRunnerRecord {
                    task_id,
                    armed_at_ms: now_ms(),
                    alarm_delay_ms: delay_ms,
                    alarm_fired_at_ms: None,
                    alarm_fired_count: 0,
                    poll_attempted_at_ms: None,
                    poll_completed_at_ms: None,
                    poll_status: None,
                    poll_reason: None,
                    poll_cas_won: None,
                    status: TaskRunnerStatus::Armed,
                };
                self.state
                    .storage()
                    .put(TASK_RUNNER_RECORD_KEY, record.clone())
                    .await?;
                self.state
                    .storage()
                    .set_alarm(Duration::from_millis(delay_ms as u64))
                    .await?;
                Response::from_json(&serde_json::json!({
                    "ok": true,
                    "task_id": record.task_id,
                    "alarm_delay_ms": record.alarm_delay_ms,
                    "instance": task_runner_instance_name(&record.task_id),
                }))
            }
            "/delete" => {
                self.state.storage().delete(TASK_RUNNER_RECORD_KEY).await?;
                self.state.storage().delete_alarm().await?;
                Response::ok("ok")
            }
            _ => Response::error("not found", 404),
        }
    }

    async fn alarm(&mut self) -> WorkerResult<Response> {
        let Some(mut record) = self.load_record().await else {
            return Response::ok("task runner alarm skipped: no record");
        };
        record.alarm_fired_at_ms = Some(now_ms());
        record.alarm_fired_count = record.alarm_fired_count.saturating_add(1);
        record.status = TaskRunnerStatus::AlarmFired;
        self.state
            .storage()
            .put(TASK_RUNNER_RECORD_KEY, record.clone())
            .await?;

        let poll_outcome = self.poll_once(&record.task_id).await;
        record.poll_attempted_at_ms = Some(poll_outcome.attempted_at_ms);
        record.poll_completed_at_ms = Some(now_ms());
        record.poll_status = Some(poll_outcome.status);
        record.poll_reason = Some(poll_outcome.reason);
        record.poll_cas_won = poll_outcome.cas_won;
        record.status = match poll_outcome.status {
            TaskRunnerPollStatus::Skipped => TaskRunnerStatus::PollSkipped,
            TaskRunnerPollStatus::Noop => TaskRunnerStatus::PollNoop,
            TaskRunnerPollStatus::Applied => TaskRunnerStatus::PollApplied,
            TaskRunnerPollStatus::Failed => TaskRunnerStatus::PollFailed,
        };
        self.state
            .storage()
            .put(TASK_RUNNER_RECORD_KEY, record)
            .await?;
        Response::ok("task runner alarm poll recorded")
    }
}

impl TaskRunner {
    async fn load_record(&self) -> Option<TaskRunnerRecord> {
        self.state
            .storage()
            .get::<TaskRunnerRecord>(TASK_RUNNER_RECORD_KEY)
            .await
            .ok()
    }

    async fn poll_once(&self, task_id: &str) -> TaskRunnerPollOutcome {
        let attempted_at_ms = now_ms();
        if !task_runner_env_flag(&self.env, TASK_RUNNER_DO_ENABLED_ENV) {
            return TaskRunnerPollOutcome::skipped(attempted_at_ms, "gate_disabled");
        }

        let db = match self.env.d1("DB") {
            Ok(db) => db,
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("db_binding_unavailable:{err}"),
                );
            }
        };

        let task = match find_task_by_task_id(&db, task_id).await {
            Ok(Some(task)) => task,
            Ok(None) => return TaskRunnerPollOutcome::skipped(attempted_at_ms, "task_not_found"),
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("task_lookup_failed:{err}"),
                );
            }
        };
        if task.status().is_terminal() {
            return TaskRunnerPollOutcome::skipped(attempted_at_ms, "task_already_terminal");
        }
        if task.upstream_task_id.trim().is_empty() {
            return TaskRunnerPollOutcome::skipped(attempted_at_ms, "missing_upstream_task_id");
        }

        let channel = match find_channel_by_id(&db, task.channel_id).await {
            Ok(Some(channel)) => channel,
            Ok(None) => {
                return TaskRunnerPollOutcome::skipped(attempted_at_ms, "channel_not_found")
            }
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("channel_lookup_failed:{err}"),
                );
            }
        };
        let gemini_version = self
            .env
            .var("GEMINI_VERSION")
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "v1beta".to_string());
        match poll_one_task(
            &db,
            &task,
            channel.kind,
            &channel.key,
            &channel.base_url,
            &gemini_version,
            now_unix_seconds(),
        )
        .await
        {
            Ok(Some(true)) => TaskRunnerPollOutcome::applied(attempted_at_ms),
            Ok(Some(false)) => TaskRunnerPollOutcome::noop(attempted_at_ms, false, "cas_noop"),
            Ok(None) => TaskRunnerPollOutcome::skipped(attempted_at_ms, "unsupported_provider"),
            Err(_err) => {
                worker::console_warn!(
                    "TaskRunner alarm poll failed for task {}; cron fallback remains authoritative",
                    task_id
                );
                TaskRunnerPollOutcome::failed(attempted_at_ms, "poll_failed")
            }
        }
    }
}

struct TaskRunnerPollOutcome {
    attempted_at_ms: i64,
    status: TaskRunnerPollStatus,
    reason: String,
    cas_won: Option<bool>,
}

impl TaskRunnerPollOutcome {
    fn skipped(attempted_at_ms: i64, reason: &str) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Skipped,
            reason: reason.to_string(),
            cas_won: None,
        }
    }

    fn noop(attempted_at_ms: i64, cas_won: bool, reason: &str) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Noop,
            reason: reason.to_string(),
            cas_won: Some(cas_won),
        }
    }

    fn applied(attempted_at_ms: i64) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Applied,
            reason: "cas_applied".to_string(),
            cas_won: Some(true),
        }
    }

    fn failed(attempted_at_ms: i64, reason: &str) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Failed,
            reason: truncate_poll_reason(reason),
            cas_won: None,
        }
    }
}

pub(crate) fn task_runner_do_foundation_compiled() -> bool {
    TASK_RUNNER_BINDING == "TASK_RUNNER"
        && TASK_RUNNER_DO_ENABLED_ENV == "TASK_RUNNER_DO_ENABLED"
        && TASK_RUNNER_STAGING_REPLAY_VERIFIED_ENV == "TASK_RUNNER_STAGING_REPLAY_VERIFIED"
        && TASK_RUNNER_RECORD_KEY == "task_runner_record_v1"
}

pub(crate) fn task_runner_alarm_contract_compiled() -> bool {
    task_runner_do_foundation_compiled()
        && task_runner_alarm_delay_ms(0) == TASK_RUNNER_DEFAULT_ALARM_DELAY_MS
        && task_runner_alarm_delay_ms(500) == TASK_RUNNER_MIN_ALARM_DELAY_MS
        && task_runner_alarm_delay_ms(120_000) == TASK_RUNNER_MAX_ALARM_DELAY_MS
        && task_runner_instance_name("task_abc") == "task:task_abc"
}

pub(crate) fn task_runner_submit_path_compiled() -> bool {
    task_runner_arm_url("task_abc", TASK_RUNNER_DEFAULT_ALARM_DELAY_MS)
        == "https://task-runner/arm?task_id=task_abc&delay_ms=15000"
}

pub(crate) fn task_runner_poll_path_compiled() -> bool {
    task_runner_alarm_contract_compiled()
        && TaskRunnerPollOutcome::skipped(100, "gate_disabled").status
            == TaskRunnerPollStatus::Skipped
        && TaskRunnerPollOutcome::noop(100, false, "cas_noop").cas_won == Some(false)
        && TaskRunnerPollOutcome::applied(100).cas_won == Some(true)
}

pub(crate) fn task_runner_staging_replay_verified(env: &Env) -> bool {
    task_runner_env_flag(env, TASK_RUNNER_STAGING_REPLAY_VERIFIED_ENV)
}

pub(crate) fn task_runner_cutover_guards() -> Vec<&'static str> {
    TASK_RUNNER_CUTOVER_GUARDS.to_vec()
}

pub(crate) fn is_task_runner_cutover_ready(
    binding_available: bool,
    enabled: bool,
    foundation_compiled: bool,
    alarm_contract_compiled: bool,
    submit_path_compiled: bool,
    poll_path_compiled: bool,
    staging_replay_verified: bool,
) -> bool {
    binding_available
        && enabled
        && foundation_compiled
        && alarm_contract_compiled
        && submit_path_compiled
        && poll_path_compiled
        && staging_replay_verified
}

/// Best-effort post-submit alarm arming. A failure must not fail the public
/// submit response because cron remains the correctness path.
pub(crate) async fn arm_task_runner_after_submit(env: &Env, task_id: &str) {
    if !task_runner_env_flag(env, TASK_RUNNER_DO_ENABLED_ENV) {
        return;
    }
    let task_id = sanitize_task_runner_task_id(task_id);
    if task_id == "unknown" {
        worker::console_warn!("TaskRunner arm skipped: invalid public task id");
        return;
    }
    let namespace = match env.durable_object(TASK_RUNNER_BINDING) {
        Ok(namespace) => namespace,
        Err(err) => {
            worker::console_warn!("TaskRunner arm skipped: binding unavailable: {}", err);
            return;
        }
    };
    let object_id = match namespace.id_from_name(&task_runner_instance_name(&task_id)) {
        Ok(object_id) => object_id,
        Err(err) => {
            worker::console_warn!("TaskRunner arm skipped: invalid object id: {}", err);
            return;
        }
    };
    let stub = match object_id.get_stub() {
        Ok(stub) => stub,
        Err(err) => {
            worker::console_warn!("TaskRunner arm skipped: stub unavailable: {}", err);
            return;
        }
    };
    let url = task_runner_arm_url(&task_id, TASK_RUNNER_DEFAULT_ALARM_DELAY_MS);
    let response = match stub.fetch_with_str(&url).await {
        Ok(response) => response,
        Err(err) => {
            worker::console_warn!("TaskRunner arm failed for task {}: {}", task_id, err);
            return;
        }
    };
    if response.status_code() != 200 {
        worker::console_warn!(
            "TaskRunner arm failed for task {} with status {}",
            task_id,
            response.status_code()
        );
    }
}

pub(crate) fn task_runner_instance_name(task_id: &str) -> String {
    format!(
        "{TASK_RUNNER_INSTANCE_PREFIX}{}",
        sanitize_task_runner_task_id(task_id)
    )
}

fn sanitize_task_runner_task_id(task_id: &str) -> String {
    let sanitized: String = task_id
        .chars()
        .take(128)
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        .collect();
    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

fn task_runner_arm_url(task_id: &str, delay_ms: i64) -> String {
    format!(
        "https://task-runner/arm?task_id={}&delay_ms={}",
        sanitize_task_runner_task_id(task_id),
        task_runner_alarm_delay_ms(delay_ms)
    )
}

fn task_runner_env_flag(env: &Env, name: &str) -> bool {
    env.var(name)
        .map(|value| value.to_string())
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn task_runner_alarm_delay_ms(requested: i64) -> i64 {
    if requested <= 0 {
        TASK_RUNNER_DEFAULT_ALARM_DELAY_MS
    } else {
        requested.clamp(
            TASK_RUNNER_MIN_ALARM_DELAY_MS,
            TASK_RUNNER_MAX_ALARM_DELAY_MS,
        )
    }
}

fn task_id_query_value(url: &url::Url) -> WorkerResult<String> {
    for (key, value) in url.query_pairs() {
        if key == "task_id" {
            let task_id = sanitize_task_runner_task_id(&value);
            if task_id != "unknown" {
                return Ok(task_id);
            }
        }
    }
    Err(worker::Error::RustError(
        "task_id query parameter is required".to_string(),
    ))
}

fn query_i64(url: &url::Url, name: &str) -> Option<i64> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| value.parse::<i64>().ok())
}

fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

fn now_unix_seconds() -> i64 {
    now_ms() / 1000
}

fn truncate_poll_reason(reason: &str) -> String {
    reason.chars().take(256).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_runner_foundation_contract_is_compiled() {
        assert!(task_runner_do_foundation_compiled());
        assert!(task_runner_alarm_contract_compiled());
        assert!(task_runner_submit_path_compiled());
        assert!(task_runner_poll_path_compiled());
    }

    #[test]
    fn task_runner_instance_names_are_deterministic_and_sanitized() {
        assert_eq!(
            task_runner_instance_name("task_abc-123"),
            "task:task_abc-123"
        );
        assert_eq!(task_runner_instance_name("../secret"), "task:secret");
        assert_eq!(task_runner_instance_name(""), "task:unknown");
    }

    #[test]
    fn task_runner_alarm_delay_is_bounded() {
        assert_eq!(task_runner_alarm_delay_ms(0), 15_000);
        assert_eq!(task_runner_alarm_delay_ms(-1), 15_000);
        assert_eq!(task_runner_alarm_delay_ms(500), 1_000);
        assert_eq!(task_runner_alarm_delay_ms(30_000), 30_000);
        assert_eq!(task_runner_alarm_delay_ms(120_000), 60_000);
    }

    #[test]
    fn task_runner_arm_url_is_sanitized_and_bounded() {
        assert_eq!(
            task_runner_arm_url("../secret", 500),
            "https://task-runner/arm?task_id=secret&delay_ms=1000"
        );
        assert_eq!(
            task_runner_arm_url("task_abc-123", 120_000),
            "https://task-runner/arm?task_id=task_abc-123&delay_ms=60000"
        );
    }

    #[test]
    fn task_runner_poll_outcomes_are_bounded_and_serializable() {
        let skipped = TaskRunnerPollOutcome::skipped(100, "gate_disabled");
        assert_eq!(skipped.status, TaskRunnerPollStatus::Skipped);
        assert_eq!(skipped.cas_won, None);

        let noop = TaskRunnerPollOutcome::noop(100, false, "cas_noop");
        assert_eq!(noop.status, TaskRunnerPollStatus::Noop);
        assert_eq!(noop.cas_won, Some(false));

        let applied = TaskRunnerPollOutcome::applied(100);
        assert_eq!(applied.status, TaskRunnerPollStatus::Applied);
        assert_eq!(applied.cas_won, Some(true));

        let failed = TaskRunnerPollOutcome::failed(100, &"x".repeat(300));
        assert_eq!(failed.status, TaskRunnerPollStatus::Failed);
        assert_eq!(failed.reason.len(), 256);
    }

    #[test]
    fn task_runner_cutover_waits_for_poll_path_and_staging_replay() {
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, false, true
        ));
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, true, false
        ));
        assert!(is_task_runner_cutover_ready(
            true, true, true, true, true, true, true
        ));
        for false_gate in 0..7 {
            let mut flags = [true; 7];
            flags[false_gate] = false;
            assert!(
                !is_task_runner_cutover_ready(
                    flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6],
                ),
                "expected TaskRunner cutover to wait on gate index {false_gate}"
            );
        }
    }
}
