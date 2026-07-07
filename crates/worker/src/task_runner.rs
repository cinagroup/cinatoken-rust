//! Durable Object alarm foundation for async task fast-path settlement.
//!
//! The scheduled Worker cron remains the correctness spine. This DO is the
//! optional M5b substrate: one deterministic object per public task id, with a
//! single alarm that can later wake the task-specific poll path before the next
//! minute cron tick. It is default-off and does not yet mutate D1.

use serde::{Deserialize, Serialize};
use worker::{durable_object, Env, Request, Response, Result as WorkerResult, State};

pub const TASK_RUNNER_BINDING: &str = "TASK_RUNNER";
pub const TASK_RUNNER_DO_ENABLED_ENV: &str = "TASK_RUNNER_DO_ENABLED";
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
    status: TaskRunnerStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerStatus {
    Armed,
    AlarmFired,
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
}

#[durable_object]
pub struct TaskRunner {
    state: State,
}

#[durable_object]
impl DurableObject for TaskRunner {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
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
                    alarm_fired_count: record.map(|record| record.alarm_fired_count).unwrap_or(0),
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
                    status: TaskRunnerStatus::Armed,
                };
                self.state
                    .storage()
                    .put(TASK_RUNNER_RECORD_KEY, record.clone())
                    .await?;
                self.state.storage().set_alarm(delay_ms).await?;
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
            .put(TASK_RUNNER_RECORD_KEY, record)
            .await?;
        Response::ok("task runner alarm recorded")
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
}

pub(crate) fn task_runner_do_foundation_compiled() -> bool {
    TASK_RUNNER_BINDING == "TASK_RUNNER"
        && TASK_RUNNER_DO_ENABLED_ENV == "TASK_RUNNER_DO_ENABLED"
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
    false
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
) -> bool {
    binding_available
        && enabled
        && foundation_compiled
        && alarm_contract_compiled
        && submit_path_compiled
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_runner_foundation_contract_is_compiled() {
        assert!(task_runner_do_foundation_compiled());
        assert!(task_runner_alarm_contract_compiled());
        assert!(!task_runner_submit_path_compiled());
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
    fn task_runner_cutover_waits_for_submit_path() {
        assert!(!is_task_runner_cutover_ready(true, true, true, true, false));
        assert!(is_task_runner_cutover_ready(true, true, true, true, true));
        for false_gate in 0..5 {
            let mut flags = [true; 5];
            flags[false_gate] = false;
            assert!(
                !is_task_runner_cutover_ready(flags[0], flags[1], flags[2], flags[3], flags[4]),
                "expected TaskRunner cutover to wait on gate index {false_gate}"
            );
        }
    }
}
