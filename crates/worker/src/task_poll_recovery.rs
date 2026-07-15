use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_root_auth, require_secure_verification,
};
use crate::task_repository::{
    apply_task_poll_recovery, find_task_poll_quarantine, find_task_poll_recovery_event,
    list_task_poll_quarantines, task_poll_lease_runtime_status, task_poll_recovery_runtime_status,
    task_poll_scheduler_runtime_status, TaskPollQuarantineRow, TaskPollRecoveryEvent,
    TaskPollRecoveryMutationError, TaskPollRecoveryMutationOutcome,
    TASK_POLL_RECOVERY_CONTRACT_VERSION,
};

pub(crate) const TASK_POLL_RECOVERY_ENABLED_ENV: &str = "TASK_POLL_RECOVERY_ENABLED";
pub(crate) const TASK_POLL_RECOVERY_STAGING_VERIFIED_ENV: &str =
    "TASK_POLL_RECOVERY_STAGING_VERIFIED";
const EVIDENCE_REFERENCE_MAX_LEN: usize = 128;
const IDEMPOTENCY_KEY_MAX_LEN: usize = 96;
const QUEUE_DEFAULT_LIMIT: i64 = 20;
const QUEUE_MAX_LIMIT: i64 = 50;
const MIN_TIMEOUT_RECOVERY_MARGIN_SECONDS: i64 = 60;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RecoveryReason {
    ProviderConfigurationCorrected,
    ProviderIncidentResolved,
    ProviderTaskVerified,
    OperatorRetryApproved,
}

impl RecoveryReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProviderConfigurationCorrected => "provider_configuration_corrected",
            Self::ProviderIncidentResolved => "provider_incident_resolved",
            Self::ProviderTaskVerified => "provider_task_verified",
            Self::OperatorRetryApproved => "operator_retry_approved",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecoveryDecision {
    reason: RecoveryReason,
    evidence_reference: String,
}

impl RecoveryDecision {
    fn validate(&self) -> Result<(), &'static str> {
        if !valid_evidence_reference(&self.evidence_reference) {
            return Err("Task poll recovery evidence_reference is invalid");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryApplyRequest {
    reason: RecoveryReason,
    evidence_reference: String,
    preview_token: String,
    idempotency_key: String,
    confirm_requeue: bool,
}

impl RecoveryApplyRequest {
    fn decision(&self) -> RecoveryDecision {
        RecoveryDecision {
            reason: self.reason,
            evidence_reference: self.evidence_reference.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct RecoveryQueueResponse {
    contract_version: u32,
    count: usize,
    next_cursor: Option<String>,
    records: Vec<RecoveryQueueRecord>,
}

#[derive(Debug, Serialize)]
struct RecoveryQueueRecord {
    entity_kind: String,
    entity_id: i64,
    task_reference: String,
    public_task_id_sha256: String,
    platform: String,
    channel_id: i64,
    status: String,
    poll_generation: i64,
    poll_write_revision: i64,
    poll_attempt_count: i64,
    poll_consecutive_failures: i64,
    poll_last_error_code: String,
    poll_quarantined_at: i64,
    poll_quarantine_reason: String,
    hard_timeout_at: Option<i64>,
    timeout_eligible: bool,
    timeout_recovery_margin_seconds: i64,
}

#[derive(Debug, Serialize)]
struct RecoveryPreviewResponse {
    contract_version: u32,
    entity_kind: String,
    entity_id: i64,
    task_reference: String,
    public_task_id_sha256: String,
    platform: String,
    channel_id: i64,
    status: String,
    poll_generation: i64,
    poll_write_revision: i64,
    poll_attempt_count: i64,
    poll_consecutive_failures: i64,
    poll_quarantined_at: i64,
    poll_quarantine_reason: String,
    hard_timeout_at: Option<i64>,
    timeout_eligible: bool,
    timeout_recovery_margin_seconds: i64,
    reason: RecoveryReason,
    evidence_reference: String,
    preview_token: String,
}

#[derive(Debug, Serialize)]
struct RecoveryApplyResponse {
    contract_version: u32,
    entity_kind: String,
    entity_id: i64,
    action: &'static str,
    status: &'static str,
    scheduled_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RecoveryTimeoutMetadata {
    hard_timeout_at: Option<i64>,
    timeout_eligible: bool,
    recovery_margin_seconds: i64,
}

pub(crate) fn task_poll_recovery_compiled() -> bool {
    crate::task_repository::task_poll_recovery_contract_compiled()
}

pub(crate) fn task_poll_recovery_enabled(env: &Env) -> bool {
    env.var(TASK_POLL_RECOVERY_ENABLED_ENV)
        .ok()
        .is_some_and(|value| value.to_string().trim().eq_ignore_ascii_case("true"))
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let (after_quarantined_at, after_entity_kind, after_entity_id, limit) =
        match recovery_queue_query(&req) {
            Ok(query) => query,
            Err(message) => return no_store(envelope_error_response(400, message)),
        };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            return no_store(envelope_error_response(
                503,
                "Task poll recovery queue is unavailable",
            ));
        }
    };
    if !recovery_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task poll recovery schema is not ready",
        ));
    }
    let mut rows = match list_task_poll_quarantines(
        &db,
        after_quarantined_at,
        &after_entity_kind,
        after_entity_id,
        limit.saturating_add(1),
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("task poll recovery queue failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Task poll recovery queue is unavailable",
            ));
        }
    };
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| recovery_cursor(row.poll_quarantined_at, &row.entity_kind, row.entity_id))
    } else {
        None
    };
    let now = crate::admin::unix_timestamp();
    let records = rows
        .iter()
        .map(|row| queue_record(row, recovery_timeout_metadata(row, &env, now)))
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&RecoveryQueueResponse {
        contract_version: TASK_POLL_RECOVERY_CONTRACT_VERSION,
        count: records.len(),
        next_cursor,
        records,
    })?)
}

pub async fn preview(
    mut req: Request,
    env: Env,
    entity_kind: Option<String>,
    entity_id: Option<String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let (entity_kind, entity_id) = match parse_entity(entity_kind, entity_id) {
        Ok(entity) => entity,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let decision = match serde_json::from_value::<RecoveryDecision>(body) {
        Ok(decision) => decision,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid task poll recovery preview request",
            ));
        }
    };
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            return no_store(envelope_error_response(
                503,
                "Task poll recovery is unavailable",
            ));
        }
    };
    if !recovery_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task poll recovery schema is not ready",
        ));
    }
    let row = match load_open_quarantine(&db, &entity_kind, entity_id).await {
        Ok(row) => row,
        Err(response) => return no_store(response),
    };
    let timeout = recovery_timeout_metadata(&row, &env, crate::admin::unix_timestamp());
    no_store(envelope_ok_response(&prepare_preview(
        &row, decision, timeout,
    ))?)
}

pub async fn apply(
    mut req: Request,
    env: Env,
    entity_kind: Option<String>,
    entity_id: Option<String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    if !task_poll_recovery_enabled(&env) {
        return no_store(envelope_error_response(
            403,
            "Task poll recovery is disabled",
        ));
    }
    if !crate::task_orchestration::task_poll_scheduler_enabled(&env)
        || !crate::task_orchestration::task_poll_lease_enabled(&env)
    {
        return no_store(envelope_error_response(
            409,
            "Task poll recovery requires the Rust scheduler and lease gates",
        ));
    }
    let (entity_kind, entity_id) = match parse_entity(entity_kind, entity_id) {
        Ok(entity) => entity,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let apply = match serde_json::from_value::<RecoveryApplyRequest>(body) {
        Ok(apply) => apply,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid task poll recovery apply request",
            ));
        }
    };
    let decision = apply.decision();
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    if !apply.confirm_requeue {
        return no_store(envelope_error_response(
            400,
            "Task poll recovery requires confirm_requeue=true",
        ));
    }
    if !valid_digest(&apply.preview_token) || !valid_idempotency_key(&apply.idempotency_key) {
        return no_store(envelope_error_response(
            400,
            "Invalid task poll recovery preview or idempotency key",
        ));
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            return no_store(envelope_error_response(
                503,
                "Task poll recovery is unavailable",
            ));
        }
    };
    if !recovery_runtime_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task poll recovery runtime is not ready",
        ));
    }
    let resolution_key = digest(&format!(
        "cinatoken:task-poll-recovery-resolution:v1:{entity_kind}:{entity_id}:{}:{}",
        apply.idempotency_key, apply.preview_token
    ));
    match find_task_poll_recovery_event(&db, &resolution_key).await {
        Ok(Some(event)) if event.entity_kind == entity_kind && event.entity_id == entity_id => {
            return recovery_result(entity_kind, entity_id, "duplicate", event.created_at);
        }
        Ok(Some(_)) => {
            return no_store(envelope_error_response(
                409,
                "Task poll recovery idempotency identity conflicts",
            ));
        }
        Ok(None) => {}
        Err(err) => {
            worker::console_error!("task poll recovery event lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Task poll recovery is unavailable",
            ));
        }
    }
    let row = match load_open_quarantine(&db, &entity_kind, entity_id).await {
        Ok(row) => row,
        Err(response) => return no_store(response),
    };
    let now = crate::admin::unix_timestamp();
    let prepared = prepare_preview(&row, decision, recovery_timeout_metadata(&row, &env, now));
    if !prepared.timeout_eligible {
        return no_store(envelope_error_response(
            409,
            "Task poll recovery is too close to the hard-timeout boundary",
        ));
    }
    if !constant_time_eq(&apply.preview_token, &prepared.preview_token) {
        return no_store(envelope_error_response(
            409,
            "Task poll recovery preview is stale",
        ));
    }
    let evidence_sha256 = evidence_digest(&apply.evidence_reference);
    let decision_json = json!({
        "contract_version": TASK_POLL_RECOVERY_CONTRACT_VERSION,
        "entity_kind": entity_kind,
        "entity_id": entity_id,
        "poll_generation": row.poll_generation,
        "poll_write_revision": row.poll_write_revision,
        "poll_quarantined_at": row.poll_quarantined_at,
        "poll_quarantine_reason": row.poll_quarantine_reason,
        "hard_timeout_at": prepared.hard_timeout_at,
        "timeout_recovery_margin_seconds": prepared.timeout_recovery_margin_seconds,
        "action": "requeue",
        "reason": apply.reason.as_str(),
        "evidence_sha256": evidence_sha256,
        "preview_token": apply.preview_token,
    });
    let decision_sha256 = digest(&decision_json.to_string());
    let event = TaskPollRecoveryEvent {
        resolution_key: &resolution_key,
        entity_kind: &entity_kind,
        entity_id,
        public_task_id: &row.public_task_id,
        expected_poll_generation: row.poll_generation,
        expected_poll_write_revision: row.poll_write_revision,
        expected_quarantined_at: row.poll_quarantined_at,
        expected_hard_timeout_at: prepared.hard_timeout_at.unwrap_or_default(),
        expected_quarantine_reason: &row.poll_quarantine_reason,
        reason: apply.reason.as_str(),
        evidence_reference: apply.evidence_reference.trim(),
        evidence_sha256: &evidence_sha256,
        preview_token: &apply.preview_token,
        decision_sha256: &decision_sha256,
        operator_id: claims.id,
        created_at: now,
    };
    let params = json!({
        "entity_kind": entity_kind,
        "entity_id": entity_id,
        "task_reference": task_reference(&row),
        "public_task_id_sha256": digest(&row.public_task_id),
        "poll_generation": row.poll_generation,
        "poll_write_revision": row.poll_write_revision,
        "poll_quarantined_at": row.poll_quarantined_at,
        "poll_quarantine_reason": row.poll_quarantine_reason,
        "reason": apply.reason.as_str(),
        "evidence_sha256": evidence_sha256,
        "resolution_key": resolution_key,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = crate::d1_repositories::admin_audit_log_statement(
        &db,
        None,
        None,
        &claims.username,
        "task_poll.quarantine_requeued",
        "Requeued a quarantined asynchronous task poll",
        &params,
        &admin_info,
        now,
    )?;
    let outcome = match apply_task_poll_recovery(&db, &event, admin_audit).await {
        Ok(outcome) => outcome,
        Err(TaskPollRecoveryMutationError::Conflict) => {
            return no_store(envelope_error_response(
                409,
                "Task poll recovery changed after preview",
            ));
        }
        Err(TaskPollRecoveryMutationError::Unavailable(err)) => {
            worker::console_error!("task poll recovery mutation failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Task poll recovery is unavailable",
            ));
        }
    };
    let was_applied = outcome == TaskPollRecoveryMutationOutcome::Applied;
    let (status, scheduled_at) = match outcome {
        TaskPollRecoveryMutationOutcome::Applied => ("applied", now),
        TaskPollRecoveryMutationOutcome::Duplicate => {
            match find_task_poll_recovery_event(&db, &resolution_key).await {
                Ok(Some(event))
                    if event.entity_kind == entity_kind && event.entity_id == entity_id =>
                {
                    ("duplicate", event.created_at)
                }
                Ok(Some(_)) => {
                    return no_store(envelope_error_response(
                        409,
                        "Task poll recovery duplicate readback is inconsistent",
                    ));
                }
                Ok(None) | Err(_) => {
                    return no_store(envelope_error_response(
                        503,
                        "Task poll recovery duplicate readback is unavailable",
                    ));
                }
            }
        }
    };
    if was_applied && entity_kind == "task" {
        crate::task_runner::arm_task_runner_after_recovery(&env, &row.public_task_id).await;
    }
    recovery_result(entity_kind, entity_id, status, scheduled_at)
}

fn recovery_result(
    entity_kind: String,
    entity_id: i64,
    status: &'static str,
    scheduled_at: i64,
) -> WorkerResult<Response> {
    no_store(envelope_ok_response(&RecoveryApplyResponse {
        contract_version: TASK_POLL_RECOVERY_CONTRACT_VERSION,
        entity_kind,
        entity_id,
        action: "requeue",
        status,
        scheduled_at,
    })?)
}

fn prepare_preview(
    row: &TaskPollQuarantineRow,
    decision: RecoveryDecision,
    timeout: RecoveryTimeoutMetadata,
) -> RecoveryPreviewResponse {
    let public_task_id_sha256 = digest(&row.public_task_id);
    let RecoveryTimeoutMetadata {
        hard_timeout_at,
        timeout_eligible,
        recovery_margin_seconds: timeout_recovery_margin_seconds,
    } = timeout;
    let token_payload = json!({
        "contract_version": TASK_POLL_RECOVERY_CONTRACT_VERSION,
        "entity_kind": row.entity_kind,
        "entity_id": row.entity_id,
        "public_task_id_sha256": public_task_id_sha256,
        "platform": row.platform,
        "channel_id": row.channel_id,
        "status": row.status,
        "poll_generation": row.poll_generation,
        "poll_write_revision": row.poll_write_revision,
        "poll_attempt_count": row.poll_attempt_count,
        "poll_consecutive_failures": row.poll_consecutive_failures,
        "poll_quarantined_at": row.poll_quarantined_at,
        "poll_quarantine_reason": row.poll_quarantine_reason,
        "hard_timeout_at": hard_timeout_at,
        "timeout_eligible": timeout_eligible,
        "timeout_recovery_margin_seconds": timeout_recovery_margin_seconds,
        "action": "requeue",
        "reason": decision.reason,
        "evidence_sha256": evidence_digest(&decision.evidence_reference),
    });
    let preview_token = digest(&format!(
        "cinatoken:task-poll-recovery-preview:v1:{token_payload}"
    ));
    RecoveryPreviewResponse {
        contract_version: TASK_POLL_RECOVERY_CONTRACT_VERSION,
        entity_kind: row.entity_kind.clone(),
        entity_id: row.entity_id,
        task_reference: task_reference(row),
        public_task_id_sha256,
        platform: row.platform.clone(),
        channel_id: row.channel_id,
        status: row.status.clone(),
        poll_generation: row.poll_generation,
        poll_write_revision: row.poll_write_revision,
        poll_attempt_count: row.poll_attempt_count,
        poll_consecutive_failures: row.poll_consecutive_failures,
        poll_quarantined_at: row.poll_quarantined_at,
        poll_quarantine_reason: row.poll_quarantine_reason.clone(),
        hard_timeout_at,
        timeout_eligible,
        timeout_recovery_margin_seconds,
        reason: decision.reason,
        evidence_reference: decision.evidence_reference,
        preview_token,
    }
}

fn queue_record(
    row: &TaskPollQuarantineRow,
    timeout: RecoveryTimeoutMetadata,
) -> RecoveryQueueRecord {
    let RecoveryTimeoutMetadata {
        hard_timeout_at,
        timeout_eligible,
        recovery_margin_seconds: timeout_recovery_margin_seconds,
    } = timeout;
    RecoveryQueueRecord {
        entity_kind: row.entity_kind.clone(),
        entity_id: row.entity_id,
        task_reference: task_reference(row),
        public_task_id_sha256: digest(&row.public_task_id),
        platform: row.platform.clone(),
        channel_id: row.channel_id,
        status: row.status.clone(),
        poll_generation: row.poll_generation,
        poll_write_revision: row.poll_write_revision,
        poll_attempt_count: row.poll_attempt_count,
        poll_consecutive_failures: row.poll_consecutive_failures,
        poll_last_error_code: row.poll_last_error_code.clone(),
        poll_quarantined_at: row.poll_quarantined_at,
        poll_quarantine_reason: row.poll_quarantine_reason.clone(),
        hard_timeout_at,
        timeout_eligible,
        timeout_recovery_margin_seconds,
    }
}

fn recovery_timeout_metadata(
    row: &TaskPollQuarantineRow,
    env: &Env,
    now: i64,
) -> RecoveryTimeoutMetadata {
    let config = crate::task_orchestration::task_poller_config_from_env(env);
    let margin = config
        .poll_lease_seconds
        .max(MIN_TIMEOUT_RECOVERY_MARGIN_SECONDS);
    if row.entity_kind == "task" && config.timeout_minutes == 0 {
        return RecoveryTimeoutMetadata {
            hard_timeout_at: None,
            timeout_eligible: true,
            recovery_margin_seconds: margin,
        };
    }
    let hard_timeout_at = if row.entity_kind == "midjourney" {
        (row.submit_time > 0).then(|| {
            crate::mj_repository::midjourney_submit_time_seconds(row.submit_time)
                .saturating_add(crate::mj_repository::MIDJOURNEY_TIMEOUT_SECONDS)
        })
    } else {
        (row.submit_time > 0).then(|| {
            row.submit_time
                .saturating_add(config.timeout_minutes.saturating_mul(60))
        })
    };
    let timeout_eligible =
        hard_timeout_at.is_some_and(|hard_timeout_at| hard_timeout_at.saturating_sub(now) > margin);
    RecoveryTimeoutMetadata {
        hard_timeout_at,
        timeout_eligible,
        recovery_margin_seconds: margin,
    }
}

fn task_reference(row: &TaskPollQuarantineRow) -> String {
    if row.entity_kind == "task" {
        row.public_task_id.clone()
    } else {
        format!("midjourney:{}", row.entity_id)
    }
}

fn quarantine_is_open(row: &TaskPollQuarantineRow) -> bool {
    row.poll_quarantined_at > 0
        && !row.poll_quarantine_reason.is_empty()
        && row.poll_owner.is_empty()
        && row.poll_lease_expires_at == 0
        && !matches!(row.status.as_str(), "SUCCESS" | "FAILURE")
}

async fn load_open_quarantine(
    db: &worker::D1Database,
    entity_kind: &str,
    entity_id: i64,
) -> Result<TaskPollQuarantineRow, Response> {
    match find_task_poll_quarantine(db, entity_kind, entity_id).await {
        Ok(Some(row)) if quarantine_is_open(&row) => Ok(row),
        Ok(Some(_)) => Err(envelope_error_response(
            409,
            "Task poll quarantine is no longer open",
        )),
        Ok(None) => Err(envelope_error_response(
            404,
            "Task poll quarantine was not found",
        )),
        Err(err) => {
            worker::console_error!("task poll quarantine lookup failed: {err}");
            Err(envelope_error_response(
                503,
                "Task poll recovery is unavailable",
            ))
        }
    }
}

async fn recovery_schema_ready(db: &worker::D1Database) -> bool {
    match task_poll_recovery_runtime_status(db).await {
        Ok(status) => status.schema_ready,
        Err(err) => {
            worker::console_error!("task poll recovery schema probe failed: {err}");
            false
        }
    }
}

async fn recovery_runtime_ready(db: &worker::D1Database) -> bool {
    let recovery = task_poll_recovery_runtime_status(db).await;
    let scheduler = task_poll_scheduler_runtime_status(db).await;
    let lease = task_poll_lease_runtime_status(db).await;
    matches!(recovery, Ok(status) if status.schema_ready)
        && matches!(scheduler, Ok(status) if status.schema_ready)
        && matches!(
            lease,
            Ok(status)
                if status.schema_ready
                    && status.authority_enabled
                    && status.enforcement_enabled
        )
}

fn parse_entity(
    entity_kind: Option<String>,
    entity_id: Option<String>,
) -> Result<(String, i64), &'static str> {
    let entity_kind = entity_kind.unwrap_or_default();
    if !matches!(entity_kind.as_str(), "task" | "midjourney") {
        return Err("Invalid task poll recovery entity kind");
    }
    let entity_id = entity_id
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .ok_or("Invalid task poll recovery entity id")?;
    Ok((entity_kind, entity_id))
}

fn recovery_queue_query(req: &Request) -> Result<(i64, String, i64, i64), &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid task poll recovery queue URL")?;
    let mut cursor = (0, String::new(), 0);
    let mut limit = QUEUE_DEFAULT_LIMIT;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "cursor" => {
                cursor = parse_recovery_cursor(value.as_ref())
                    .ok_or("Invalid task poll recovery queue cursor")?;
            }
            "limit" => {
                limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=QUEUE_MAX_LIMIT).contains(value))
                    .ok_or("Invalid task poll recovery queue limit")?;
            }
            _ => return Err("Unsupported task poll recovery queue query"),
        }
    }
    Ok((cursor.0, cursor.1, cursor.2, limit))
}

fn recovery_cursor(quarantined_at: i64, entity_kind: &str, entity_id: i64) -> String {
    format!(
        "{:016x}.{entity_kind}.{:016x}",
        quarantined_at.max(0),
        entity_id.max(0)
    )
}

fn parse_recovery_cursor(value: &str) -> Option<(i64, String, i64)> {
    let mut parts = value.split('.');
    let quarantined_at = parts.next()?;
    let entity_kind = parts.next()?;
    let entity_id = parts.next()?;
    if parts.next().is_some()
        || quarantined_at.len() != 16
        || entity_id.len() != 16
        || !matches!(entity_kind, "task" | "midjourney")
    {
        return None;
    }
    Some((
        i64::from_str_radix(quarantined_at, 16).ok()?,
        entity_kind.to_string(),
        i64::from_str_radix(entity_id, 16).ok()?,
    ))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_idempotency_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= IDEMPOTENCY_KEY_MAX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_evidence_reference(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= EVIDENCE_REFERENCE_MAX_LEN
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/' | b'#' | b'@')
        })
}

fn evidence_digest(value: &str) -> String {
    digest(&format!(
        "cinatoken:task-poll-recovery-evidence:v1:{}",
        value.trim()
    ))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quarantine() -> TaskPollQuarantineRow {
        TaskPollQuarantineRow {
            entity_kind: "task".to_string(),
            entity_id: 41,
            public_task_id: "task_public_41".to_string(),
            platform: "suno".to_string(),
            channel_id: 7,
            status: "IN_PROGRESS".to_string(),
            submit_time: 1_799_999_000,
            poll_owner: String::new(),
            poll_generation: 3,
            poll_lease_expires_at: 0,
            poll_write_revision: 9,
            poll_attempt_count: 12,
            poll_consecutive_failures: 8,
            poll_last_error_code: "provider_poll_failed".to_string(),
            poll_quarantined_at: 1_800_000_000,
            poll_quarantine_reason: "provider_poll_failed".to_string(),
        }
    }

    #[test]
    fn preview_binds_generation_revision_quarantine_and_evidence() {
        let row = quarantine();
        let decision = RecoveryDecision {
            reason: RecoveryReason::ProviderIncidentResolved,
            evidence_reference: "incident:INC-41".to_string(),
        };
        let timeout = RecoveryTimeoutMetadata {
            hard_timeout_at: Some(1_800_085_400),
            timeout_eligible: true,
            recovery_margin_seconds: 120,
        };
        let first = prepare_preview(&row, decision.clone(), timeout);
        let mut changed = row.clone();
        changed.poll_write_revision += 1;
        assert_ne!(
            first.preview_token,
            prepare_preview(&changed, decision.clone(), timeout).preview_token
        );
        let different_evidence = prepare_preview(
            &row,
            RecoveryDecision {
                evidence_reference: "incident:INC-42".to_string(),
                ..decision
            },
            timeout,
        );
        assert_ne!(first.preview_token, different_evidence.preview_token);
        assert_ne!(
            first.preview_token,
            prepare_preview(
                &row,
                RecoveryDecision {
                    reason: RecoveryReason::ProviderIncidentResolved,
                    evidence_reference: "incident:INC-41".to_string(),
                },
                RecoveryTimeoutMetadata {
                    hard_timeout_at: Some(1_800_085_401),
                    ..timeout
                },
            )
            .preview_token
        );
    }

    #[test]
    fn recovery_requires_a_closed_lease_and_open_quarantine() {
        let row = quarantine();
        assert!(quarantine_is_open(&row));
        assert!(!quarantine_is_open(&TaskPollQuarantineRow {
            poll_owner: "cron:owner".to_string(),
            poll_lease_expires_at: 1_800_000_100,
            ..row.clone()
        }));
        assert!(!quarantine_is_open(&TaskPollQuarantineRow {
            status: "SUCCESS".to_string(),
            ..row
        }));
    }

    #[test]
    fn cursor_and_operator_inputs_are_bounded() {
        let cursor = recovery_cursor(1_800_000_000, "midjourney", 42);
        assert_eq!(
            parse_recovery_cursor(&cursor),
            Some((1_800_000_000, "midjourney".to_string(), 42))
        );
        assert!(valid_evidence_reference("incident:INC-42"));
        assert!(!valid_evidence_reference("secret value with spaces"));
        assert!(valid_idempotency_key("requeue-42.1"));
        assert!(!valid_idempotency_key("requeue 42"));
    }
}
