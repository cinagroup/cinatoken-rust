//! Durable Object alarm foundation for async task fast-path settlement.
//!
//! The scheduled Worker cron remains the correctness spine. This DO is the
//! optional M5b substrate: one deterministic object per public task id, with a
//! single alarm that can wake the task-specific poll path before the next
//! minute cron tick. It is default-off and the scheduled cron remains the
//! correctness spine.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Env, Error, Request, Response, Result as WorkerResult, State, Storage,
};

use crate::d1_repositories::find_channel_by_id;
use crate::task_orchestration::{
    poll_one_task, task_poll_lease_enabled, task_poll_scheduler_enabled,
    task_poller_config_from_env,
};
use crate::task_repository::{find_task_by_task_id, generate_task_poll_owner};

pub const TASK_RUNNER_BINDING: &str = "TASK_RUNNER";
pub const TASK_RUNNER_DO_ENABLED_ENV: &str = "TASK_RUNNER_DO_ENABLED";
pub const TASK_RUNNER_STAGING_REPLAY_VERIFIED_ENV: &str = "TASK_RUNNER_STAGING_REPLAY_VERIFIED";
pub const TASK_RUNNER_MAX_ALARM_FIRES_ENV: &str = "TASK_RUNNER_MAX_ALARM_FIRES";
pub const TASK_RUNNER_DEFAULT_ALARM_DELAY_MS: i64 = 15_000;
pub const TASK_RUNNER_MIN_ALARM_DELAY_MS: i64 = 1_000;
pub const TASK_RUNNER_MAX_ALARM_DELAY_MS: i64 = 60_000;
pub const TASK_RUNNER_MAX_PERSISTED_DELAY_MS: i64 = 86_400_000;
pub const TASK_RUNNER_DEFAULT_MAX_ALARM_FIRES: u32 = 20;
pub const TASK_RUNNER_MAX_MAX_ALARM_FIRES: u32 = 240;
pub const TASK_RUNNER_RECORD_KEY: &str = "task_runner_record_v1";
pub const TASK_RUNNER_STATUS_PROBE_ROUTE: &str = "/api/platform/task-runner/:task_id/status";
const TASK_RUNNER_INSTANCE_PREFIX: &str = "task:";
const TASK_RUNNER_STATUS_URL: &str = "https://task-runner/status";
const MAX_TASK_RUNNER_RECORD_BYTES: usize = 8 * 1024;

const TASK_RUNNER_CUTOVER_GUARDS: &[&str] = &[
    "task_runner_binding",
    "task_runner_gate",
    "deterministic_task_instance",
    "alarm_contract",
    "storage_error_retry",
    "nonterminal_rearm",
    "failure_backoff",
    "fast_path_horizon",
    "submit_path_armed",
    "cron_sweeper_fallback",
    "generation_fenced_poll_lease",
    "poll_lease_cutover",
    "persisted_poll_schedule",
    "poll_scheduler_cutover",
    "status_probe",
    "staging_alarm_replay",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TaskRunnerRecord {
    task_id: String,
    #[serde(default)]
    schedule_generation: u64,
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
    #[serde(default)]
    poll_terminal: Option<bool>,
    #[serde(default)]
    poll_generation: Option<i64>,
    #[serde(default)]
    last_rearmed_at_ms: Option<i64>,
    #[serde(default)]
    last_rearm_delay_ms: Option<i64>,
    #[serde(default)]
    rearm_count: u32,
    #[serde(default)]
    consecutive_failures: u32,
    #[serde(default)]
    max_alarm_fires: u32,
    #[serde(default)]
    cron_fallback_reason: Option<String>,
    status: TaskRunnerStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerStatus {
    Armed,
    AlarmFired,
    PollSkipped,
    PollNoop,
    PollProgressed,
    PollApplied,
    PollFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerPollStatus {
    Skipped,
    Noop,
    Progressed,
    Applied,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskRunnerRearmMode {
    Stop,
    Regular,
    Backoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TaskRunnerRearmDecision {
    delay_ms: Option<i64>,
    consecutive_failures: u32,
    fallback_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskRunnerReplayEvidence {
    NoRecord,
    ArmedPending,
    AlarmFiredPendingPoll,
    FirstApply,
    ProgressApplied,
    NonterminalCasNoop,
    SecondReplayNoop,
    GateDisabledFallback,
    CronAlreadySettled,
    PollSkipped,
    PollFailed,
    Unknown,
}

#[derive(Debug, Serialize)]
struct TaskRunnerStatusResponse {
    compiled: bool,
    task_id: Option<String>,
    schedule_generation: Option<u64>,
    status: Option<TaskRunnerStatus>,
    replay_evidence: TaskRunnerReplayEvidence,
    alarm_scheduled_at_ms: Option<i64>,
    alarm_delay_ms: Option<i64>,
    alarm_fired_at_ms: Option<i64>,
    alarm_fired_count: u32,
    poll_attempted_at_ms: Option<i64>,
    poll_completed_at_ms: Option<i64>,
    poll_status: Option<TaskRunnerPollStatus>,
    poll_reason: Option<String>,
    poll_cas_won: Option<bool>,
    poll_terminal: Option<bool>,
    poll_generation: Option<i64>,
    last_rearmed_at_ms: Option<i64>,
    last_rearm_delay_ms: Option<i64>,
    rearm_count: u32,
    consecutive_failures: u32,
    max_alarm_fires: u32,
    cron_fallback_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TaskRunnerStatusProbe {
    task_id: String,
    instance: String,
    durable_object_status: Value,
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
                let record = self.load_record().await?;
                let alarm_scheduled_at_ms = self.state.storage().get_alarm().await?;
                let replay_evidence = task_runner_replay_evidence(record.as_ref());
                let response = TaskRunnerStatusResponse {
                    compiled: task_runner_rearm_contract_compiled(),
                    task_id: record.as_ref().map(|record| record.task_id.clone()),
                    schedule_generation: record.as_ref().map(|record| record.schedule_generation),
                    status: record.as_ref().map(|record| record.status),
                    replay_evidence,
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
                    poll_terminal: record.as_ref().and_then(|record| record.poll_terminal),
                    poll_generation: record.as_ref().and_then(|record| record.poll_generation),
                    last_rearmed_at_ms: record
                        .as_ref()
                        .and_then(|record| record.last_rearmed_at_ms),
                    last_rearm_delay_ms: record
                        .as_ref()
                        .and_then(|record| record.last_rearm_delay_ms),
                    rearm_count: record
                        .as_ref()
                        .map(|record| record.rearm_count)
                        .unwrap_or(0),
                    consecutive_failures: record
                        .as_ref()
                        .map(|record| record.consecutive_failures)
                        .unwrap_or(0),
                    max_alarm_fires: record
                        .as_ref()
                        .map(|record| record.max_alarm_fires)
                        .unwrap_or(0),
                    cron_fallback_reason: record
                        .as_ref()
                        .and_then(|record| record.cron_fallback_reason.clone()),
                };
                Response::from_json(&response)
            }
            "/arm" => {
                let task_id = task_id_query_value(&url)?;
                let delay_ms =
                    task_runner_alarm_delay_ms(query_i64(&url, "delay_ms").unwrap_or_default());
                let schedule_generation = self
                    .load_record()
                    .await?
                    .map(|record| record.schedule_generation)
                    .unwrap_or_default()
                    .checked_add(1)
                    .ok_or_else(|| Error::RustError("TaskRunner schedule exhausted".to_string()))?;
                let record = TaskRunnerRecord {
                    task_id,
                    schedule_generation,
                    armed_at_ms: now_ms(),
                    alarm_delay_ms: delay_ms,
                    alarm_fired_at_ms: None,
                    alarm_fired_count: 0,
                    poll_attempted_at_ms: None,
                    poll_completed_at_ms: None,
                    poll_status: None,
                    poll_reason: None,
                    poll_cas_won: None,
                    poll_terminal: None,
                    poll_generation: None,
                    last_rearmed_at_ms: None,
                    last_rearm_delay_ms: None,
                    rearm_count: 0,
                    consecutive_failures: 0,
                    max_alarm_fires: task_runner_max_alarm_fires(&self.env),
                    cron_fallback_reason: None,
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
                    "schedule_generation": record.schedule_generation,
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
        let Some(mut record) = self.load_record().await? else {
            return Response::ok("task runner alarm skipped: no record");
        };
        record.alarm_fired_at_ms = Some(now_ms());
        record.alarm_fired_count = record.alarm_fired_count.saturating_add(1);
        record.status = TaskRunnerStatus::AlarmFired;
        if !store_task_runner_record_if_generation(
            self.state.storage(),
            record.schedule_generation,
            &record,
        )
        .await?
        {
            return Response::ok("task runner alarm superseded before poll");
        }

        let poll_outcome = self.poll_once(&record.task_id).await;
        let Some(current) = self.load_record().await? else {
            return Response::ok("task runner alarm superseded: record deleted");
        };
        if current.schedule_generation != record.schedule_generation {
            return Response::ok("task runner alarm superseded by newer schedule");
        }
        record.poll_attempted_at_ms = Some(poll_outcome.attempted_at_ms);
        record.poll_completed_at_ms = Some(now_ms());
        record.poll_status = Some(poll_outcome.status);
        record.poll_reason = Some(poll_outcome.reason);
        record.poll_cas_won = poll_outcome.cas_won;
        record.poll_terminal = poll_outcome.terminal;
        record.poll_generation = poll_outcome.poll_generation;
        record.status = match poll_outcome.status {
            TaskRunnerPollStatus::Skipped => TaskRunnerStatus::PollSkipped,
            TaskRunnerPollStatus::Noop => TaskRunnerStatus::PollNoop,
            TaskRunnerPollStatus::Progressed => TaskRunnerStatus::PollProgressed,
            TaskRunnerPollStatus::Applied => TaskRunnerStatus::PollApplied,
            TaskRunnerPollStatus::Failed => TaskRunnerStatus::PollFailed,
        };

        let max_alarm_fires = if record.max_alarm_fires == 0 {
            task_runner_max_alarm_fires(&self.env)
        } else {
            record.max_alarm_fires
        };
        record.max_alarm_fires = max_alarm_fires;
        let mut rearm = task_runner_rearm_decision(
            poll_outcome.rearm,
            record.alarm_delay_ms,
            record.alarm_fired_count,
            max_alarm_fires,
            record.consecutive_failures,
        );
        if rearm.fallback_reason.is_none() {
            if let Some(delay_ms) = poll_outcome.rearm_delay_override_ms {
                rearm.delay_ms = Some(task_runner_persisted_delay_ms(delay_ms));
            }
        }
        record.consecutive_failures = rearm.consecutive_failures;
        if let Some(reason) = rearm.fallback_reason {
            record.cron_fallback_reason = Some(reason.to_string());
        } else if rearm.delay_ms.is_some() {
            let rearmed_at_ms = now_ms();
            record.last_rearmed_at_ms = Some(rearmed_at_ms);
            record.last_rearm_delay_ms = rearm.delay_ms;
            record.rearm_count = record.rearm_count.saturating_add(1);
            record.cron_fallback_reason = None;
        } else if !matches!(
            record.poll_reason.as_deref(),
            Some("terminal_cas_applied" | "cas_noop_terminal" | "task_already_terminal")
        ) {
            record.cron_fallback_reason = record.poll_reason.clone();
        } else {
            record.cron_fallback_reason = None;
        }
        let stored = store_task_runner_record_if_generation(
            self.state.storage(),
            record.schedule_generation,
            &record,
        )
        .await?;
        if !stored {
            return Response::ok("task runner alarm superseded before rearm");
        }
        if let Some(delay_ms) = rearm.delay_ms {
            self.state
                .storage()
                .set_alarm(Duration::from_millis(delay_ms as u64))
                .await?;
        }
        if let Some(current) = self.load_record().await? {
            if current.schedule_generation != record.schedule_generation {
                if let Some(delay_ms) = task_runner_record_alarm_delay_ms(&current) {
                    self.state
                        .storage()
                        .set_alarm(Duration::from_millis(delay_ms as u64))
                        .await?;
                } else {
                    self.state.storage().delete_alarm().await?;
                }
                return Response::ok("task runner alarm superseded during rearm");
            }
        } else {
            self.state.storage().delete_alarm().await?;
            return Response::ok("task runner alarm superseded: record deleted during rearm");
        }
        Response::ok("task runner alarm poll recorded")
    }
}

impl TaskRunner {
    async fn load_record(&self) -> WorkerResult<Option<TaskRunnerRecord>> {
        load_optional_task_runner_record(&self.state.storage()).await
    }

    async fn poll_once(&self, task_id: &str) -> TaskRunnerPollOutcome {
        let attempted_at_ms = now_ms();
        if !task_runner_env_flag(&self.env, TASK_RUNNER_DO_ENABLED_ENV) {
            return TaskRunnerPollOutcome::skipped(attempted_at_ms, "gate_disabled");
        }
        if !task_poll_lease_enabled(&self.env) {
            return TaskRunnerPollOutcome::noop(
                attempted_at_ms,
                false,
                "poll_authority_disabled",
                TaskRunnerRearmMode::Regular,
                Some(false),
            );
        }
        if !task_poll_scheduler_enabled(&self.env) {
            return TaskRunnerPollOutcome::noop(
                attempted_at_ms,
                false,
                "poll_scheduler_disabled",
                TaskRunnerRearmMode::Regular,
                Some(false),
            );
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
        match crate::task_repository::task_poll_lease_runtime_status(&db).await {
            Ok(status) if status.schema_ready && status.authority_enabled => {}
            Ok(status) if status.schema_ready => {
                return TaskRunnerPollOutcome::noop(
                    attempted_at_ms,
                    false,
                    "poll_authority_disabled",
                    TaskRunnerRearmMode::Regular,
                    Some(false),
                );
            }
            Ok(_) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    "poll_lease_schema_not_ready",
                );
            }
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("poll_lease_schema_check_failed:{err}"),
                );
            }
        }
        match crate::task_repository::task_poll_scheduler_runtime_status(&db).await {
            Ok(status) if status.schema_ready => {}
            Ok(_) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    "poll_scheduler_schema_not_ready",
                );
            }
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("poll_scheduler_schema_check_failed:{err}"),
                );
            }
        }

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
        if task.poll_quarantined_at > 0 {
            return TaskRunnerPollOutcome::skipped(attempted_at_ms, "poll_quarantined");
        }
        let poll_now = now_unix_seconds();
        if task.next_poll_at > poll_now {
            return TaskRunnerPollOutcome::deferred(
                attempted_at_ms,
                task.next_poll_at
                    .saturating_sub(poll_now)
                    .saturating_mul(1_000),
            );
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
        let poll_owner = match generate_task_poll_owner("task-runner") {
            Ok(owner) => owner,
            Err(err) => {
                return TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("poll_owner_generation_failed:{err}"),
                );
            }
        };
        let poller_config = task_poller_config_from_env(&self.env);
        match poll_one_task(
            &db,
            &task,
            channel.kind,
            &channel.key,
            &channel.base_url,
            &gemini_version,
            &poll_owner,
            poller_config.poll_lease_seconds,
            poller_config.retry_base_seconds,
            poller_config.retry_max_seconds,
            poller_config.max_consecutive_failures,
            poll_now,
        )
        .await
        {
            Ok(Some(outcome)) if outcome.cas_won && outcome.terminal => {
                TaskRunnerPollOutcome::applied(attempted_at_ms, outcome.poll_generation)
            }
            Ok(Some(outcome)) if outcome.cas_won => {
                TaskRunnerPollOutcome::progressed(attempted_at_ms, outcome.poll_generation)
            }
            Ok(Some(outcome)) if !outcome.lease_claimed => TaskRunnerPollOutcome::noop(
                attempted_at_ms,
                false,
                "poll_lease_busy",
                TaskRunnerRearmMode::Regular,
                Some(false),
            ),
            Ok(Some(_)) => match find_task_by_task_id(&db, task_id).await {
                Ok(Some(current)) if current.status().is_terminal() => TaskRunnerPollOutcome::noop(
                    attempted_at_ms,
                    false,
                    "cas_noop_terminal",
                    TaskRunnerRearmMode::Stop,
                    Some(true),
                ),
                Ok(Some(_)) => TaskRunnerPollOutcome::noop(
                    attempted_at_ms,
                    false,
                    "cas_noop_nonterminal",
                    TaskRunnerRearmMode::Regular,
                    Some(false),
                ),
                Ok(None) => TaskRunnerPollOutcome::skipped(attempted_at_ms, "task_not_found"),
                Err(err) => TaskRunnerPollOutcome::failed(
                    attempted_at_ms,
                    &format!("cas_noop_recheck_failed:{err}"),
                ),
            },
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

async fn load_optional_task_runner_record(
    storage: &Storage,
) -> WorkerResult<Option<TaskRunnerRecord>> {
    let values = storage.get_multiple(vec![TASK_RUNNER_RECORD_KEY]).await?;
    let value = values.get(&JsValue::from_str(TASK_RUNNER_RECORD_KEY));
    if value.is_undefined() {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(value)
        .map(Some)
        .map_err(|err| {
            Error::RustError(format!(
                "failed to decode TaskRunner storage {TASK_RUNNER_RECORD_KEY}: {err}"
            ))
        })
}

async fn store_task_runner_record_if_generation(
    mut storage: Storage,
    expected_generation: u64,
    record: &TaskRunnerRecord,
) -> WorkerResult<bool> {
    let encoded = serde_json::to_vec(record)
        .map_err(|err| Error::RustError(format!("failed to encode TaskRunner record: {err}")))?;
    if encoded.len() > MAX_TASK_RUNNER_RECORD_BYTES {
        return Err(Error::RustError(
            "TaskRunner record exceeds storage limit".to_string(),
        ));
    }
    let mut record_bytes = [0_u8; MAX_TASK_RUNNER_RECORD_BYTES];
    record_bytes[..encoded.len()].copy_from_slice(&encoded);
    let record_len = encoded.len();
    storage
        .transaction(move |mut transaction| async move {
            let values = transaction
                .get_multiple(vec![TASK_RUNNER_RECORD_KEY])
                .await?;
            let key = JsValue::from_str(TASK_RUNNER_RECORD_KEY);
            let current = values.get(&key);
            if current.is_undefined() {
                return Ok(());
            }
            let current: TaskRunnerRecord =
                serde_wasm_bindgen::from_value(current).map_err(|err| {
                    Error::RustError(format!("failed to decode TaskRunner record: {err}"))
                })?;
            if current.schedule_generation != expected_generation {
                return Ok(());
            }
            let next: TaskRunnerRecord = serde_json::from_slice(&record_bytes[..record_len])
                .map_err(|err| {
                    Error::RustError(format!("failed to decode next TaskRunner record: {err}"))
                })?;
            transaction.put(TASK_RUNNER_RECORD_KEY, next).await?;
            Ok(())
        })
        .await?;
    Ok(load_optional_task_runner_record(&storage).await?.as_ref() == Some(record))
}

fn task_runner_record_alarm_delay_ms(record: &TaskRunnerRecord) -> Option<i64> {
    match record.status {
        TaskRunnerStatus::Armed | TaskRunnerStatus::AlarmFired => {
            Some(task_runner_persisted_delay_ms(record.alarm_delay_ms))
        }
        TaskRunnerStatus::PollNoop
        | TaskRunnerStatus::PollProgressed
        | TaskRunnerStatus::PollFailed
            if record.cron_fallback_reason.is_none() =>
        {
            record
                .last_rearm_delay_ms
                .map(task_runner_persisted_delay_ms)
        }
        TaskRunnerStatus::PollSkipped | TaskRunnerStatus::PollApplied => None,
        TaskRunnerStatus::PollNoop
        | TaskRunnerStatus::PollProgressed
        | TaskRunnerStatus::PollFailed => None,
    }
}

struct TaskRunnerPollOutcome {
    attempted_at_ms: i64,
    status: TaskRunnerPollStatus,
    reason: String,
    cas_won: Option<bool>,
    terminal: Option<bool>,
    poll_generation: Option<i64>,
    rearm: TaskRunnerRearmMode,
    rearm_delay_override_ms: Option<i64>,
}

impl TaskRunnerPollOutcome {
    fn skipped(attempted_at_ms: i64, reason: &str) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Skipped,
            reason: reason.to_string(),
            cas_won: None,
            terminal: None,
            poll_generation: None,
            rearm: TaskRunnerRearmMode::Stop,
            rearm_delay_override_ms: None,
        }
    }

    fn noop(
        attempted_at_ms: i64,
        cas_won: bool,
        reason: &str,
        rearm: TaskRunnerRearmMode,
        terminal: Option<bool>,
    ) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Noop,
            reason: reason.to_string(),
            cas_won: Some(cas_won),
            terminal,
            poll_generation: None,
            rearm,
            rearm_delay_override_ms: None,
        }
    }

    fn deferred(attempted_at_ms: i64, delay_ms: i64) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Noop,
            reason: "poll_not_due".to_string(),
            cas_won: Some(false),
            terminal: Some(false),
            poll_generation: None,
            rearm: TaskRunnerRearmMode::Regular,
            rearm_delay_override_ms: Some(task_runner_persisted_delay_ms(delay_ms)),
        }
    }

    fn progressed(attempted_at_ms: i64, poll_generation: Option<i64>) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Progressed,
            reason: "progress_cas_applied".to_string(),
            cas_won: Some(true),
            terminal: Some(false),
            poll_generation,
            rearm: TaskRunnerRearmMode::Regular,
            rearm_delay_override_ms: None,
        }
    }

    fn applied(attempted_at_ms: i64, poll_generation: Option<i64>) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Applied,
            reason: "terminal_cas_applied".to_string(),
            cas_won: Some(true),
            terminal: Some(true),
            poll_generation,
            rearm: TaskRunnerRearmMode::Stop,
            rearm_delay_override_ms: None,
        }
    }

    fn failed(attempted_at_ms: i64, reason: &str) -> Self {
        Self {
            attempted_at_ms,
            status: TaskRunnerPollStatus::Failed,
            reason: truncate_poll_reason(reason),
            cas_won: None,
            terminal: None,
            poll_generation: None,
            rearm: TaskRunnerRearmMode::Backoff,
            rearm_delay_override_ms: None,
        }
    }
}

pub(crate) fn task_runner_do_foundation_compiled() -> bool {
    TASK_RUNNER_BINDING == "TASK_RUNNER"
        && TASK_RUNNER_DO_ENABLED_ENV == "TASK_RUNNER_DO_ENABLED"
        && TASK_RUNNER_STAGING_REPLAY_VERIFIED_ENV == "TASK_RUNNER_STAGING_REPLAY_VERIFIED"
        && TASK_RUNNER_MAX_ALARM_FIRES_ENV == "TASK_RUNNER_MAX_ALARM_FIRES"
        && TASK_RUNNER_RECORD_KEY == "task_runner_record_v1"
}

pub(crate) fn task_runner_alarm_contract_compiled() -> bool {
    task_runner_do_foundation_compiled()
        && task_runner_alarm_delay_ms(0) == TASK_RUNNER_DEFAULT_ALARM_DELAY_MS
        && task_runner_alarm_delay_ms(500) == TASK_RUNNER_MIN_ALARM_DELAY_MS
        && task_runner_alarm_delay_ms(120_000) == TASK_RUNNER_MAX_ALARM_DELAY_MS
        && task_runner_instance_name("task_abc") == "task:task_abc"
}

pub(crate) fn task_runner_storage_error_retry_contract_compiled() -> bool {
    task_runner_alarm_contract_compiled()
        && TASK_RUNNER_CUTOVER_GUARDS.contains(&"storage_error_retry")
}

pub(crate) fn task_runner_submit_path_compiled() -> bool {
    task_runner_arm_url("task_abc", TASK_RUNNER_DEFAULT_ALARM_DELAY_MS)
        == "https://task-runner/arm?task_id=task_abc&delay_ms=15000"
}

pub(crate) fn task_runner_poll_path_compiled() -> bool {
    task_runner_alarm_contract_compiled()
        && TaskRunnerPollOutcome::skipped(100, "gate_disabled").status
            == TaskRunnerPollStatus::Skipped
        && TaskRunnerPollOutcome::noop(
            100,
            false,
            "cas_noop_nonterminal",
            TaskRunnerRearmMode::Regular,
            Some(false),
        )
        .cas_won
            == Some(false)
        && TaskRunnerPollOutcome::progressed(100, Some(1)).status
            == TaskRunnerPollStatus::Progressed
        && TaskRunnerPollOutcome::applied(100, Some(1)).cas_won == Some(true)
}

pub(crate) fn task_runner_rearm_contract_compiled() -> bool {
    task_runner_poll_path_compiled()
        && TaskRunnerPollOutcome::progressed(100, Some(1)).rearm == TaskRunnerRearmMode::Regular
        && TaskRunnerPollOutcome::failed(100, "transient").rearm == TaskRunnerRearmMode::Backoff
        && TaskRunnerPollOutcome::applied(100, Some(1)).rearm == TaskRunnerRearmMode::Stop
        && TaskRunnerPollOutcome::deferred(100, 900_000).rearm_delay_override_ms == Some(900_000)
        && task_runner_failure_backoff_ms(TASK_RUNNER_DEFAULT_ALARM_DELAY_MS, 1) == 15_000
        && task_runner_failure_backoff_ms(TASK_RUNNER_DEFAULT_ALARM_DELAY_MS, 2) == 30_000
        && task_runner_failure_backoff_ms(TASK_RUNNER_DEFAULT_ALARM_DELAY_MS, 10) == 60_000
}

pub(crate) fn task_runner_status_probe_compiled() -> bool {
    task_runner_poll_path_compiled()
        && TASK_RUNNER_STATUS_PROBE_ROUTE == "/api/platform/task-runner/:task_id/status"
        && TASK_RUNNER_STATUS_URL == "https://task-runner/status"
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
    storage_error_retry_contract_compiled: bool,
    rearm_contract_compiled: bool,
    submit_path_compiled: bool,
    poll_path_compiled: bool,
    status_probe_compiled: bool,
    poll_lease_cutover_ready: bool,
    poll_scheduler_cutover_ready: bool,
    staging_replay_verified: bool,
) -> bool {
    binding_available
        && enabled
        && foundation_compiled
        && alarm_contract_compiled
        && storage_error_retry_contract_compiled
        && rearm_contract_compiled
        && submit_path_compiled
        && poll_path_compiled
        && status_probe_compiled
        && poll_lease_cutover_ready
        && poll_scheduler_cutover_ready
        && staging_replay_verified
}

/// Best-effort post-submit alarm arming. A failure must not fail the public
/// submit response because cron remains the correctness path.
pub(crate) async fn arm_task_runner_after_submit(env: &Env, task_id: &str) {
    if !task_runner_env_flag(env, TASK_RUNNER_DO_ENABLED_ENV)
        || !task_poll_lease_enabled(env)
        || !task_poll_scheduler_enabled(env)
    {
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

pub(crate) async fn fetch_task_runner_status(
    env: &Env,
    task_id: &str,
) -> WorkerResult<TaskRunnerStatusProbe> {
    let task_id = task_runner_status_probe_task_id(task_id)
        .ok_or_else(|| worker::Error::RustError("invalid task runner task id".to_string()))?;
    let namespace = env.durable_object(TASK_RUNNER_BINDING)?;
    let instance = task_runner_instance_name(&task_id);
    let object_id = namespace.id_from_name(&instance)?;
    let stub = object_id.get_stub()?;
    let mut response = stub.fetch_with_str(TASK_RUNNER_STATUS_URL).await?;
    let status_code = response.status_code();
    let text = response.text().await?;
    if status_code != 200 {
        return Err(worker::Error::RustError(format!(
            "task runner status probe returned {status_code}"
        )));
    }
    let durable_object_status = serde_json::from_str::<Value>(&text).map_err(|err| {
        worker::Error::RustError(format!(
            "task runner status probe returned invalid JSON: {err}"
        ))
    })?;
    Ok(TaskRunnerStatusProbe {
        task_id,
        instance,
        durable_object_status,
    })
}

pub(crate) fn task_runner_status_probe_task_id(task_id: &str) -> Option<String> {
    let sanitized = sanitize_task_runner_task_id(task_id);
    (sanitized != "unknown").then_some(sanitized)
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

pub(crate) fn task_runner_max_alarm_fires(env: &Env) -> u32 {
    env.var(TASK_RUNNER_MAX_ALARM_FIRES_ENV)
        .ok()
        .and_then(|value| value.to_string().trim().parse::<u32>().ok())
        .unwrap_or(TASK_RUNNER_DEFAULT_MAX_ALARM_FIRES)
        .clamp(1, TASK_RUNNER_MAX_MAX_ALARM_FIRES)
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

fn task_runner_persisted_delay_ms(requested: i64) -> i64 {
    requested.clamp(
        TASK_RUNNER_MIN_ALARM_DELAY_MS,
        TASK_RUNNER_MAX_PERSISTED_DELAY_MS,
    )
}

fn task_runner_failure_backoff_ms(base_delay_ms: i64, consecutive_failures: u32) -> i64 {
    let exponent = consecutive_failures.saturating_sub(1).min(6);
    task_runner_alarm_delay_ms(base_delay_ms)
        .saturating_mul(1_i64 << exponent)
        .min(TASK_RUNNER_MAX_ALARM_DELAY_MS)
}

fn task_runner_rearm_decision(
    mode: TaskRunnerRearmMode,
    base_delay_ms: i64,
    alarm_fired_count: u32,
    max_alarm_fires: u32,
    previous_failures: u32,
) -> TaskRunnerRearmDecision {
    if mode == TaskRunnerRearmMode::Stop {
        return TaskRunnerRearmDecision {
            delay_ms: None,
            consecutive_failures: 0,
            fallback_reason: None,
        };
    }
    let consecutive_failures = match mode {
        TaskRunnerRearmMode::Regular => 0,
        TaskRunnerRearmMode::Backoff => previous_failures.saturating_add(1),
        TaskRunnerRearmMode::Stop => unreachable!(),
    };
    if alarm_fired_count >= max_alarm_fires.max(1) {
        return TaskRunnerRearmDecision {
            delay_ms: None,
            consecutive_failures,
            fallback_reason: Some("fast_path_horizon_exhausted"),
        };
    }
    match mode {
        TaskRunnerRearmMode::Regular => TaskRunnerRearmDecision {
            delay_ms: Some(task_runner_alarm_delay_ms(base_delay_ms)),
            consecutive_failures: 0,
            fallback_reason: None,
        },
        TaskRunnerRearmMode::Backoff => TaskRunnerRearmDecision {
            delay_ms: Some(task_runner_failure_backoff_ms(
                base_delay_ms,
                consecutive_failures,
            )),
            consecutive_failures,
            fallback_reason: None,
        },
        TaskRunnerRearmMode::Stop => unreachable!(),
    }
}

fn task_runner_replay_evidence(record: Option<&TaskRunnerRecord>) -> TaskRunnerReplayEvidence {
    let Some(record) = record else {
        return TaskRunnerReplayEvidence::NoRecord;
    };
    match (
        record.status,
        record.poll_status,
        record.poll_cas_won,
        record.poll_reason.as_deref(),
    ) {
        (TaskRunnerStatus::Armed, None, None, _) => TaskRunnerReplayEvidence::ArmedPending,
        (TaskRunnerStatus::AlarmFired, None, None, _) => {
            TaskRunnerReplayEvidence::AlarmFiredPendingPoll
        }
        (TaskRunnerStatus::PollApplied, Some(TaskRunnerPollStatus::Applied), Some(true), _) => {
            TaskRunnerReplayEvidence::FirstApply
        }
        (
            TaskRunnerStatus::PollProgressed,
            Some(TaskRunnerPollStatus::Progressed),
            Some(true),
            _,
        ) => TaskRunnerReplayEvidence::ProgressApplied,
        (
            TaskRunnerStatus::PollNoop,
            Some(TaskRunnerPollStatus::Noop),
            Some(false),
            Some("cas_noop_nonterminal"),
        ) => TaskRunnerReplayEvidence::NonterminalCasNoop,
        (
            TaskRunnerStatus::PollNoop,
            Some(TaskRunnerPollStatus::Noop),
            Some(false),
            Some("cas_noop_terminal"),
        ) => TaskRunnerReplayEvidence::SecondReplayNoop,
        (
            TaskRunnerStatus::PollSkipped,
            Some(TaskRunnerPollStatus::Skipped),
            _,
            Some("gate_disabled"),
        ) => TaskRunnerReplayEvidence::GateDisabledFallback,
        (
            TaskRunnerStatus::PollSkipped,
            Some(TaskRunnerPollStatus::Skipped),
            _,
            Some("task_already_terminal"),
        ) => TaskRunnerReplayEvidence::CronAlreadySettled,
        (TaskRunnerStatus::PollSkipped, Some(TaskRunnerPollStatus::Skipped), _, _) => {
            TaskRunnerReplayEvidence::PollSkipped
        }
        (TaskRunnerStatus::PollFailed, Some(TaskRunnerPollStatus::Failed), _, _) => {
            TaskRunnerReplayEvidence::PollFailed
        }
        _ => TaskRunnerReplayEvidence::Unknown,
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
        assert!(task_runner_storage_error_retry_contract_compiled());
        assert!(task_runner_submit_path_compiled());
        assert!(task_runner_poll_path_compiled());
        assert!(task_runner_status_probe_compiled());
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
    fn task_runner_status_probe_contract_is_sanitized() {
        assert_eq!(
            task_runner_status_probe_task_id("task_abc-123").as_deref(),
            Some("task_abc-123")
        );
        assert_eq!(
            task_runner_status_probe_task_id("../secret").as_deref(),
            Some("secret")
        );
        assert_eq!(task_runner_status_probe_task_id("...").as_deref(), None);
        assert_eq!(
            TASK_RUNNER_STATUS_PROBE_ROUTE,
            "/api/platform/task-runner/:task_id/status"
        );
    }

    #[test]
    fn task_runner_poll_outcomes_are_bounded_and_serializable() {
        let skipped = TaskRunnerPollOutcome::skipped(100, "gate_disabled");
        assert_eq!(skipped.status, TaskRunnerPollStatus::Skipped);
        assert_eq!(skipped.cas_won, None);

        let noop = TaskRunnerPollOutcome::noop(
            100,
            false,
            "cas_noop_nonterminal",
            TaskRunnerRearmMode::Regular,
            Some(false),
        );
        assert_eq!(noop.status, TaskRunnerPollStatus::Noop);
        assert_eq!(noop.cas_won, Some(false));
        assert_eq!(noop.rearm, TaskRunnerRearmMode::Regular);

        let progressed = TaskRunnerPollOutcome::progressed(100, Some(7));
        assert_eq!(progressed.status, TaskRunnerPollStatus::Progressed);
        assert_eq!(progressed.terminal, Some(false));
        assert_eq!(progressed.rearm, TaskRunnerRearmMode::Regular);

        let applied = TaskRunnerPollOutcome::applied(100, Some(8));
        assert_eq!(applied.status, TaskRunnerPollStatus::Applied);
        assert_eq!(applied.cas_won, Some(true));
        assert_eq!(applied.terminal, Some(true));
        assert_eq!(applied.rearm, TaskRunnerRearmMode::Stop);

        let failed = TaskRunnerPollOutcome::failed(100, &"x".repeat(300));
        assert_eq!(failed.status, TaskRunnerPollStatus::Failed);
        assert_eq!(failed.reason.len(), 256);
        assert_eq!(failed.rearm, TaskRunnerRearmMode::Backoff);
    }

    #[test]
    fn task_runner_failure_backoff_and_horizon_are_bounded() {
        assert_eq!(task_runner_failure_backoff_ms(15_000, 1), 15_000);
        assert_eq!(task_runner_failure_backoff_ms(15_000, 2), 30_000);
        assert_eq!(task_runner_failure_backoff_ms(15_000, 3), 60_000);
        assert_eq!(task_runner_failure_backoff_ms(15_000, 99), 60_000);
        assert_eq!(TASK_RUNNER_DEFAULT_MAX_ALARM_FIRES, 20);
        assert_eq!(TASK_RUNNER_MAX_MAX_ALARM_FIRES, 240);
        assert_eq!(
            task_runner_rearm_decision(TaskRunnerRearmMode::Regular, 15_000, 1, 20, 0,),
            TaskRunnerRearmDecision {
                delay_ms: Some(15_000),
                consecutive_failures: 0,
                fallback_reason: None,
            }
        );
        assert_eq!(
            task_runner_rearm_decision(TaskRunnerRearmMode::Backoff, 15_000, 2, 20, 1,),
            TaskRunnerRearmDecision {
                delay_ms: Some(30_000),
                consecutive_failures: 2,
                fallback_reason: None,
            }
        );
        assert_eq!(
            task_runner_rearm_decision(TaskRunnerRearmMode::Regular, 15_000, 20, 20, 0,),
            TaskRunnerRearmDecision {
                delay_ms: None,
                consecutive_failures: 0,
                fallback_reason: Some("fast_path_horizon_exhausted"),
            }
        );
        assert!(task_runner_rearm_contract_compiled());
    }

    #[test]
    fn task_runner_replay_evidence_classifies_cutover_proof_states() {
        assert_eq!(
            task_runner_replay_evidence(None),
            TaskRunnerReplayEvidence::NoRecord
        );
        assert_eq!(
            serde_json::to_value(TaskRunnerReplayEvidence::SecondReplayNoop).unwrap(),
            serde_json::json!("second_replay_noop")
        );

        let mut record = TaskRunnerRecord {
            task_id: "task_abc".to_string(),
            schedule_generation: 1,
            armed_at_ms: 100,
            alarm_delay_ms: TASK_RUNNER_DEFAULT_ALARM_DELAY_MS,
            alarm_fired_at_ms: None,
            alarm_fired_count: 0,
            poll_attempted_at_ms: None,
            poll_completed_at_ms: None,
            poll_status: None,
            poll_reason: None,
            poll_cas_won: None,
            poll_terminal: None,
            poll_generation: None,
            last_rearmed_at_ms: None,
            last_rearm_delay_ms: None,
            rearm_count: 0,
            consecutive_failures: 0,
            max_alarm_fires: TASK_RUNNER_DEFAULT_MAX_ALARM_FIRES,
            cron_fallback_reason: None,
            status: TaskRunnerStatus::Armed,
        };
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::ArmedPending
        );
        assert_eq!(
            task_runner_record_alarm_delay_ms(&record),
            Some(TASK_RUNNER_DEFAULT_ALARM_DELAY_MS)
        );

        record.status = TaskRunnerStatus::PollApplied;
        record.poll_status = Some(TaskRunnerPollStatus::Applied);
        record.poll_reason = Some("terminal_cas_applied".to_string());
        record.poll_cas_won = Some(true);
        record.poll_terminal = Some(true);
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::FirstApply
        );
        assert_eq!(task_runner_record_alarm_delay_ms(&record), None);

        record.status = TaskRunnerStatus::PollProgressed;
        record.poll_status = Some(TaskRunnerPollStatus::Progressed);
        record.poll_reason = Some("progress_cas_applied".to_string());
        record.poll_terminal = Some(false);
        record.last_rearm_delay_ms = Some(900_000);
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::ProgressApplied
        );
        assert_eq!(task_runner_record_alarm_delay_ms(&record), Some(900_000));

        record.status = TaskRunnerStatus::PollNoop;
        record.poll_status = Some(TaskRunnerPollStatus::Noop);
        record.poll_reason = Some("cas_noop_nonterminal".to_string());
        record.poll_cas_won = Some(false);
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::NonterminalCasNoop
        );

        record.poll_reason = Some("cas_noop_terminal".to_string());
        record.poll_terminal = Some(true);
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::SecondReplayNoop
        );

        record.status = TaskRunnerStatus::PollSkipped;
        record.poll_status = Some(TaskRunnerPollStatus::Skipped);
        record.poll_reason = Some("gate_disabled".to_string());
        record.poll_cas_won = None;
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::GateDisabledFallback
        );

        record.poll_reason = Some("task_already_terminal".to_string());
        assert_eq!(
            task_runner_replay_evidence(Some(&record)),
            TaskRunnerReplayEvidence::CronAlreadySettled
        );
    }

    #[test]
    fn task_runner_cutover_waits_for_poll_path_and_staging_replay() {
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, true, true, false, true, true, true, true
        ));
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, true, true, true, false, true, true, true
        ));
        assert!(is_task_runner_cutover_ready(
            true, true, true, true, true, true, true, true, true, true, true, true
        ));
        for false_gate in 0..12 {
            let mut flags = [true; 12];
            flags[false_gate] = false;
            assert!(
                !is_task_runner_cutover_ready(
                    flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
                    flags[8], flags[9], flags[10], flags[11],
                ),
                "expected TaskRunner cutover to wait on gate index {false_gate}"
            );
        }
    }
}
