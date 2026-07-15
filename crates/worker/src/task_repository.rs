//! D1-backed task lifecycle repository.
//!
//! Ports the persistence half of Go `model.Task` (`model/task.go`) against the
//! `tasks` table from `migrations/d1/0001_core.sql`. The correctness core is
//! [`update_task_status_cas`], a faithful port of Go `Task.UpdateWithStatus`: a
//! status transition is a conditional UPDATE guarded by the *current* status, so
//! exactly one caller can move a task out of a given state. That guard is what
//! makes settlement idempotent — a task can only be billed or refunded by the
//! caller that wins the transition into a terminal state (item 4.2).
//!
//! Provider-independent: every async-task platform (Suno, Midjourney, video, …)
//! shares this lifecycle, so this layer carries no provider-specific logic.
//!
//! Foundation ahead of the task orchestration that will consume it; allowed to
//! be dead code until then, mirroring [`crate::flow_state`].
#![allow(dead_code)]

use cinatoken_relay::clamp_i64_to_i32 as d1_i32;
use cinatoken_tasks::{build_task_id, settlement_for, TaskInfo, TaskSettlement, TaskStatus};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::{D1Database, D1Type};

pub(crate) const LEGACY_TASK_TIMEOUT_CUTOFF_UNIX: i64 = 1_740_182_400;
pub(crate) const TASK_BILLING_INTENT_MIGRATION: &str = "0031_task_billing_intents.sql";
pub(crate) const TASK_SUBMIT_RECONCILIATION_MIGRATION: &str =
    "0033_task_submit_reconciliation_enforce.sql";
pub(crate) const TASK_POLL_LEASE_MIGRATION: &str = "0035_task_poll_lease_enforce.sql";
pub(crate) const TASK_POLL_LEASE_CONTRACT_VERSION: u32 = 1;
pub(crate) const TASK_POLL_SCHEDULER_MIGRATION: &str = "0036_task_poll_schedule.sql";
pub(crate) const TASK_POLL_SCHEDULER_CONTRACT_VERSION: u32 = 1;
pub(crate) const TASK_POLL_RECOVERY_MIGRATION: &str = "0037_task_poll_recovery.sql";
pub(crate) const TASK_POLL_RECOVERY_CONTRACT_VERSION: u32 = 2;
pub(crate) const TASK_SUBMIT_OPERATION_MIGRATION: &str = "0039_task_submit_operation_enforce.sql";
pub(crate) const TASK_SUBMIT_OPERATION_CONTRACT_VERSION: u32 = 1;
pub(crate) const TASK_BILLING_INTENT_LEASE_SECONDS: i64 = 900;
const TASK_BILLING_INTENT_SWEEP_MAX_LIMIT: i64 = 64;
const TASK_BILLING_INTENT_SWEEP_SELECT: &str = r#"
    SELECT reservation_key, submit_state
    FROM (
      SELECT reservation_key, submit_state, submit_deadline_at AS effective_deadline
      FROM task_billing_intents INDEXED BY idx_task_billing_intents_submit_deadline
      WHERE status = 'reserved'
        AND submit_state IN ('prepared', 'submitting', 'rejected')
        AND submit_deadline_at > 0
        AND submit_deadline_at < ?1
      UNION ALL
      SELECT reservation_key, submit_state, lease_expires_at AS effective_deadline
      FROM task_billing_intents INDEXED BY idx_task_billing_intents_status_lease
      WHERE status = 'reserved'
        AND submit_state IN ('prepared', 'submitting', 'rejected')
        AND submit_deadline_at = 0
        AND lease_expires_at < ?1
    )
    ORDER BY effective_deadline ASC, reservation_key ASC
    LIMIT ?2
"#;
const LEGACY_TASK_TIMEOUT_REASON: &str = "任务超时（旧系统遗留任务，不进行退款，请联系管理员）";
const TASK_REFUND_MARKER_PATH: &str = "$.task_refund_marker";
const TASK_REFUND_DONE_AT_PATH: &str = "$.task_refund_done_at";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPollLease {
    pub owner: String,
    pub generation: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct TaskPollLeaseRuntimeStatus {
    pub schema_ready: bool,
    pub authority_enabled: bool,
    pub enforcement_enabled: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct TaskPollSchedulerRuntimeStatus {
    pub schema_ready: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct TaskPollRecoveryRuntimeStatus {
    pub schema_ready: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskPollFailureOutcome {
    pub recorded: bool,
    pub quarantined: bool,
    pub consecutive_failures: i64,
    pub next_poll_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TaskPollQuarantineRow {
    pub entity_kind: String,
    pub entity_id: i64,
    pub public_task_id: String,
    pub platform: String,
    pub channel_id: i64,
    pub status: String,
    pub submit_time: i64,
    pub poll_owner: String,
    pub poll_generation: i64,
    pub poll_lease_expires_at: i64,
    pub poll_write_revision: i64,
    pub poll_attempt_count: i64,
    pub poll_consecutive_failures: i64,
    pub poll_last_error_code: String,
    pub poll_quarantined_at: i64,
    pub poll_quarantine_reason: String,
}

#[derive(Debug, Clone, Copy)]
pub struct TaskPollRecoveryEvent<'a> {
    pub resolution_key: &'a str,
    pub entity_kind: &'a str,
    pub entity_id: i64,
    pub public_task_id: &'a str,
    pub expected_poll_generation: i64,
    pub expected_poll_write_revision: i64,
    pub expected_quarantined_at: i64,
    pub expected_hard_timeout_at: i64,
    pub expected_quarantine_reason: &'a str,
    pub reason: &'a str,
    pub evidence_reference: &'a str,
    pub evidence_sha256: &'a str,
    pub preview_token: &'a str,
    pub decision_sha256: &'a str,
    pub operator_id: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskPollRecoveryMutationOutcome {
    Applied,
    Duplicate,
}

#[derive(Debug)]
pub enum TaskPollRecoveryMutationError {
    Conflict,
    Unavailable(worker::Error),
}

impl From<worker::Error> for TaskPollRecoveryMutationError {
    fn from(error: worker::Error) -> Self {
        Self::Unavailable(error)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TaskPollRecoveryAppliedEvent {
    pub entity_kind: String,
    pub entity_id: i64,
    pub created_at: i64,
}

/// Create an unguessable, bounded owner token for one cron or Durable Object
/// poll attempt. The owner kind is operator-visible but contains no task or
/// provider credentials.
pub fn generate_task_poll_owner(owner_kind: &str) -> worker::Result<String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let owner_kind = owner_kind.trim();
    if owner_kind.is_empty()
        || owner_kind.len() > 32
        || !owner_kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(worker::Error::RustError(
            "task poll owner kind is invalid".to_string(),
        ));
    }
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|err| {
        worker::Error::RustError(format!("task poll owner generation failed: {err}"))
    })?;
    let mut owner = String::with_capacity(owner_kind.len() + 1 + bytes.len() * 2);
    owner.push_str(owner_kind);
    owner.push(':');
    for byte in bytes {
        owner.push(HEX[(byte >> 4) as usize] as char);
        owner.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(owner)
}

#[derive(Debug, Clone, Copy)]
pub struct TaskBillingIntentRecord<'a> {
    pub reservation_key: &'a str,
    pub task_kind: &'a str,
    pub public_task_id: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub quota: i64,
    pub funding_source: &'a str,
    pub subscription_id: i64,
    pub billing_contract_json: &'a str,
    pub attach_contract_json: &'a str,
    pub provider_kind: &'a str,
    pub provider_idempotency_key: &'a str,
    pub client_operation_key_sha256: &'a str,
    pub client_request_sha256: &'a str,
    pub created_at: i64,
    pub submit_deadline_at: i64,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TaskBillingIntent {
    pub reservation_key: String,
    pub task_kind: String,
    pub public_task_id: String,
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub quota: i64,
    pub funding_source: String,
    pub subscription_id: i64,
    pub billing_contract_json: String,
    pub billing_contract_sha256: String,
    pub attach_contract_json: String,
    pub attach_contract_sha256: String,
    pub status: String,
    pub submit_state: String,
    pub provider_kind: String,
    pub provider_idempotency_key: String,
    pub client_operation_key_sha256: String,
    pub client_request_sha256: String,
    pub provider_task_id: String,
    pub request_accounted: i64,
    pub lease_expires_at: i64,
    pub submit_deadline_at: i64,
    pub owner_generation: i64,
    pub reconciliation_id: String,
    pub reconciliation_revision: i64,
    pub reconciliation_resolution: String,
    pub reconciliation_resolution_key: String,
    pub reconciliation_resolved_at: i64,
    pub reconciliation_operator_id: i64,
    pub reconciliation_evidence_sha256: String,
    pub reconciliation_reason: String,
    pub recovery_last_error: String,
    pub recovery_required_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskBillingIntentAttachOutcome {
    Applied,
    MatchingAttached,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskBillingIntentReserveOutcome {
    Applied,
    Replay(TaskBillingIntent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskBillingIntentRefundOutcome {
    Applied,
    AlreadyFinalized,
    NotFound,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaskBillingIntentSweepSummary {
    pub candidates: i64,
    pub refunded: i64,
    pub recovery_required: i64,
    pub already_finalized: i64,
    pub failed: i64,
}

/// Generate a public task id — `"task_"` + 32 CSPRNG characters, the Worker
/// (wasm) half of Go `GenerateTaskID`. Bytes come from `getrandom` (Web Crypto)
/// and are rejection-sampled to a uniform `[0, 62)` (rejecting the biased tail
/// `>= 248 = 62*4`) before mapping through [`build_task_id`], so the alphabet is
/// drawn without modulo bias, matching Go's `crand.Int`.
pub fn generate_task_id() -> String {
    let mut indices: Vec<u8> = Vec::with_capacity(32);
    let mut buffer = [0u8; 64];
    while indices.len() < 32 {
        if getrandom::getrandom(&mut buffer).is_err() {
            break;
        }
        for &byte in &buffer {
            if indices.len() >= 32 {
                break;
            }
            if byte < 248 {
                indices.push(byte % 62);
            }
        }
    }
    build_task_id(&indices)
}

const TASK_BILLING_INTENT_COLUMNS: &str = r#"reservation_key, task_kind, public_task_id,
    user_id, token_id, channel_id, quota, funding_source, subscription_id,
    billing_contract_json, billing_contract_sha256,
    attach_contract_json, attach_contract_sha256, status, submit_state,
    provider_kind, provider_idempotency_key, client_operation_key_sha256,
    client_request_sha256, provider_task_id,
    request_accounted, lease_expires_at, submit_deadline_at, owner_generation,
    reconciliation_id, reconciliation_revision, reconciliation_resolution,
    reconciliation_resolution_key, reconciliation_resolved_at,
    reconciliation_operator_id, reconciliation_evidence_sha256,
    reconciliation_reason, recovery_last_error, recovery_required_at,
    created_at, updated_at"#;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TaskBillingReconciliationQueueRow {
    pub reconciliation_id: String,
    pub reconciliation_revision: i64,
    pub task_kind: String,
    pub public_task_id: String,
    pub provider_kind: String,
    pub provider_task_id: String,
    pub quota: i64,
    pub funding_source: String,
    pub recovery_last_error: String,
    pub recovery_required_at: i64,
    pub attach_contract_sha256: String,
    pub attach_available: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct TaskBillingReconciliationEvent<'a> {
    pub resolution_key: &'a str,
    pub reconciliation_id: &'a str,
    pub reservation_key: &'a str,
    pub expected_revision: i64,
    pub action: &'a str,
    pub reason: &'a str,
    pub provider_task_id: &'a str,
    pub evidence_reference: &'a str,
    pub evidence_sha256: &'a str,
    pub preview_token: &'a str,
    pub decision_sha256: &'a str,
    pub operator_id: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskBillingReconciliationMutationOutcome {
    Applied,
    Conflict,
}

fn task_billing_contract_sha256(contract_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(contract_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn task_reconciliation_id(reservation_key: &str) -> String {
    task_billing_contract_sha256(&format!(
        "cinatoken:task-submit-reconciliation:v1:{}",
        reservation_key.trim()
    ))
}

fn validate_task_billing_intent_record(record: &TaskBillingIntentRecord<'_>) -> worker::Result<()> {
    let reservation_key = record.reservation_key.trim();
    let public_task_id = record.public_task_id.trim();
    let contract_json = record.billing_contract_json.trim();
    let attach_contract_json = record.attach_contract_json.trim();
    if reservation_key.is_empty()
        || reservation_key.len() > 160
        || public_task_id.is_empty()
        || public_task_id.len() > 160
        || !matches!(record.task_kind, "task" | "midjourney")
        || record.user_id <= 0
        || record.token_id < 0
        || record.channel_id <= 0
        || record.quota < 0
        || !matches!(record.funding_source, "wallet" | "subscription")
        || (record.funding_source == "wallet" && record.subscription_id != 0)
        || (record.funding_source == "subscription" && record.subscription_id <= 0)
        || contract_json.len() > 32 * 1024
        || serde_json::from_str::<serde_json::Value>(contract_json).is_err()
        || attach_contract_json == "{}"
        || attach_contract_json.len() > 64 * 1024
        || serde_json::from_str::<serde_json::Value>(attach_contract_json).is_err()
        || record.provider_kind.trim().is_empty()
        || record.provider_kind.trim().len() > 64
        || record.provider_idempotency_key.trim().is_empty()
        || record.provider_idempotency_key.trim().len() > 160
        || !is_lower_hex_digest(record.client_operation_key_sha256)
        || !is_lower_hex_digest(record.client_request_sha256)
        || record.created_at <= 0
        || record.submit_deadline_at <= record.created_at
        || record.submit_deadline_at > record.lease_expires_at
        || !(5..=120).contains(&record.submit_deadline_at.saturating_sub(record.created_at))
        || record.lease_expires_at <= record.created_at
    {
        return Err(worker::Error::RustError(
            "task billing intent contract is invalid".to_string(),
        ));
    }
    Ok(())
}

fn is_lower_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Persist the immutable task billing contract and reserve its funding before
/// any provider request. Migration 0031 owns the wallet/subscription and token
/// mutations in insert/refund triggers so the row and its financial side effect
/// share one D1 transaction.
pub async fn reserve_task_billing_intent(
    db: &D1Database,
    record: TaskBillingIntentRecord<'_>,
) -> worker::Result<TaskBillingIntentReserveOutcome> {
    validate_task_billing_intent_record(&record)?;
    let contract_json = record.billing_contract_json.trim();
    let contract_sha256 = task_billing_contract_sha256(contract_json);
    let attach_contract_json = record.attach_contract_json.trim();
    let attach_contract_sha256 = task_billing_contract_sha256(attach_contract_json);
    let args = [
        D1Type::Text(record.reservation_key.trim()),
        D1Type::Text(record.task_kind),
        D1Type::Text(record.public_task_id.trim()),
        D1Type::Integer(d1_i32(record.user_id)),
        D1Type::Integer(d1_i32(record.token_id)),
        D1Type::Integer(d1_i32(record.channel_id)),
        D1Type::Integer(task_refund_quota_i32(record.quota)?),
        D1Type::Text(record.funding_source),
        D1Type::Integer(d1_i32(record.subscription_id)),
        D1Type::Text(contract_json),
        D1Type::Text(&contract_sha256),
        D1Type::Text(attach_contract_json),
        D1Type::Text(&attach_contract_sha256),
        D1Type::Text(record.provider_kind.trim()),
        D1Type::Text(record.provider_idempotency_key.trim()),
        D1Type::Text(record.client_operation_key_sha256),
        D1Type::Text(record.client_request_sha256),
        D1Type::Integer(d1_i32(record.created_at)),
        D1Type::Integer(d1_i32(record.submit_deadline_at)),
        D1Type::Integer(d1_i32(record.lease_expires_at)),
    ];
    let result = db
        .prepare(
            r#"
            INSERT OR IGNORE INTO task_billing_intents (
              reservation_key, task_kind, public_task_id, user_id, token_id,
              channel_id, quota, funding_source, subscription_id,
              billing_contract_json, billing_contract_sha256,
              attach_contract_json, attach_contract_sha256,
              provider_kind, provider_idempotency_key,
              client_operation_key_sha256, client_request_sha256,
              created_at, updated_at, submit_deadline_at, lease_expires_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
              ?14, ?15, ?16, ?17, ?18, ?18, ?19, ?20
            )
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    if changes == 1 {
        return Ok(TaskBillingIntentReserveOutcome::Applied);
    }
    let Some(existing) = find_task_billing_intent_by_client_operation(
        db,
        record.user_id,
        record.token_id,
        record.task_kind,
        record.client_operation_key_sha256,
    )
    .await?
    else {
        return Err(worker::Error::RustError(
            "task billing intent reserve conflicted".to_string(),
        ));
    };
    if existing.client_request_sha256 != record.client_request_sha256 {
        return Err(worker::Error::RustError(
            "task idempotency key conflicts with a different request".to_string(),
        ));
    }
    Ok(TaskBillingIntentReserveOutcome::Replay(existing))
}

/// Fence the provider call before any outbound I/O. Once this transition wins,
/// an ambiguous network result may only become `submit_unknown`; it is never
/// eligible for the automatic pre-submit refund sweep.
pub async fn mark_task_billing_intent_submitting(
    db: &D1Database,
    reservation_key: &str,
    now: i64,
) -> worker::Result<bool> {
    let lease_expires_at = now.saturating_add(TASK_BILLING_INTENT_LEASE_SECONDS);
    let args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Integer(d1_i32(lease_expires_at)),
        D1Type::Text(reservation_key.trim()),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET submit_state = 'submitting',
                submit_attempt_count = submit_attempt_count + 1,
                lease_expires_at = ?2,
                updated_at = ?1,
                owner_generation = owner_generation + 1,
                recovery_last_error = ''
            WHERE reservation_key = ?3
              AND status = 'reserved'
              AND submit_state = 'prepared'
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

pub async fn mark_task_billing_intent_submit_unknown(
    db: &D1Database,
    reservation_key: &str,
    now: i64,
    reason: &str,
) -> worker::Result<bool> {
    mark_task_billing_intent_submit_unknown_with_provider_task_id(
        db,
        reservation_key,
        now,
        reason,
        "",
    )
    .await
}

pub async fn mark_task_billing_intent_submit_unknown_with_provider_task_id(
    db: &D1Database,
    reservation_key: &str,
    now: i64,
    reason: &str,
    provider_task_id: &str,
) -> worker::Result<bool> {
    let reason = reason.trim().chars().take(256).collect::<String>();
    let provider_task_id = provider_task_id.trim();
    if provider_task_id.len() > 256 {
        return Err(worker::Error::RustError(
            "task provider identity is invalid".to_string(),
        ));
    }
    let reconciliation_id = task_reconciliation_id(reservation_key);
    let args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Text(&reason),
        D1Type::Text(reservation_key.trim()),
        D1Type::Text(provider_task_id),
        D1Type::Text(&reconciliation_id),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'recovery_required',
                submit_state = 'submit_unknown',
                recovery_required_at = CASE
                  WHEN recovery_required_at > 0 THEN recovery_required_at ELSE ?1 END,
                recovery_attempt_count = recovery_attempt_count + 1,
                recovery_last_error = ?2,
                provider_task_id = CASE WHEN ?4 <> '' THEN ?4 ELSE provider_task_id END,
                reconciliation_id = CASE
                  WHEN reconciliation_id = '' THEN ?5 ELSE reconciliation_id END,
                reconciliation_revision = CASE
                  WHEN reconciliation_revision = 0 THEN 1 ELSE reconciliation_revision END,
                updated_at = ?1,
                owner_generation = owner_generation + 1
            WHERE reservation_key = ?3
              AND status = 'reserved'
              AND submit_state = 'submitting'
              AND (provider_task_id = '' OR provider_task_id = ?4)
              AND (reconciliation_id = '' OR reconciliation_id = ?5)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

pub async fn reject_and_refund_task_billing_intent(
    db: &D1Database,
    reservation_key: &str,
    now: i64,
    reason: &str,
) -> worker::Result<bool> {
    let reason = reason.trim().chars().take(256).collect::<String>();
    let args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Text(&reason),
        D1Type::Text(reservation_key.trim()),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'refunded',
                submit_state = 'rejected',
                refunded_at = ?1,
                updated_at = ?1,
                owner_generation = owner_generation + 1,
                recovery_last_error = ?2
            WHERE reservation_key = ?3
              AND status = 'reserved'
              AND submit_state = 'submitting'
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

pub async fn find_task_billing_intent(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<Option<TaskBillingIntent>> {
    let arg = D1Type::Text(reservation_key.trim());
    db.prepare(&format!(
        "SELECT {TASK_BILLING_INTENT_COLUMNS} FROM task_billing_intents WHERE reservation_key = ?1 LIMIT 1"
    ))
    .bind_refs(&arg)?
    .first::<TaskBillingIntent>(None)
    .await
}

pub async fn find_task_billing_intent_by_client_operation(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    task_kind: &str,
    client_operation_key_sha256: &str,
) -> worker::Result<Option<TaskBillingIntent>> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(token_id)),
        D1Type::Text(task_kind),
        D1Type::Text(client_operation_key_sha256),
    ];
    db.prepare(&format!(
        "SELECT {TASK_BILLING_INTENT_COLUMNS} FROM task_billing_intents \
         WHERE user_id = ?1 AND token_id = ?2 AND task_kind = ?3 \
           AND client_operation_key_sha256 = ?4 LIMIT 1"
    ))
    .bind_refs(&args)?
    .first::<TaskBillingIntent>(None)
    .await
}

pub async fn find_task_billing_intent_for_owner(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    public_task_id: &str,
) -> worker::Result<Option<TaskBillingIntent>> {
    let args = [
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(token_id)),
        D1Type::Text(public_task_id),
    ];
    db.prepare(&format!(
        "SELECT {TASK_BILLING_INTENT_COLUMNS} FROM task_billing_intents \
         WHERE user_id = ?1 AND token_id = ?2 AND public_task_id = ?3 LIMIT 1"
    ))
    .bind_refs(&args)?
    .first::<TaskBillingIntent>(None)
    .await
}

pub async fn find_task_billing_reconciliation(
    db: &D1Database,
    reconciliation_id: &str,
) -> worker::Result<Option<TaskBillingIntent>> {
    let arg = D1Type::Text(reconciliation_id.trim());
    db.prepare(&format!(
        "SELECT {TASK_BILLING_INTENT_COLUMNS} FROM task_billing_intents WHERE reconciliation_id = ?1 LIMIT 1"
    ))
    .bind_refs(&arg)?
    .first::<TaskBillingIntent>(None)
    .await
}

pub async fn list_task_billing_reconciliations(
    db: &D1Database,
    after_required_at: i64,
    after_reconciliation_id: &str,
    limit: i64,
) -> worker::Result<Vec<TaskBillingReconciliationQueueRow>> {
    let args = [
        D1Type::Integer(d1_i32(after_required_at)),
        D1Type::Text(after_reconciliation_id),
        D1Type::Integer(d1_i32(limit.clamp(1, 50))),
    ];
    db.prepare(
        r#"
        SELECT reconciliation_id, reconciliation_revision, task_kind,
               public_task_id, provider_kind, provider_task_id, quota,
               funding_source, recovery_last_error, recovery_required_at,
               attach_contract_sha256,
               CASE WHEN attach_contract_json <> '{}' THEN 1 ELSE 0 END AS attach_available
        FROM task_billing_intents
        WHERE status = 'recovery_required'
          AND submit_state = 'submit_unknown'
          AND reconciliation_resolution = ''
          AND reconciliation_id <> ''
          AND (
            recovery_required_at > ?1 OR
            (recovery_required_at = ?1 AND reconciliation_id > ?2)
          )
        ORDER BY recovery_required_at ASC, reconciliation_id ASC
        LIMIT ?3
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<TaskBillingReconciliationQueueRow>()
}

pub(crate) fn task_billing_reconciliation_event_statement(
    db: &D1Database,
    event: &TaskBillingReconciliationEvent<'_>,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Text(event.resolution_key),
        D1Type::Text(event.reconciliation_id),
        D1Type::Text(event.reservation_key),
        D1Type::Integer(d1_i32(event.expected_revision)),
        D1Type::Text(event.action),
        D1Type::Text(event.reason),
        D1Type::Text(event.provider_task_id),
        D1Type::Text(event.evidence_reference),
        D1Type::Text(event.evidence_sha256),
        D1Type::Text(event.preview_token),
        D1Type::Text(event.decision_sha256),
        D1Type::Integer(d1_i32(event.operator_id)),
        D1Type::Integer(d1_i32(event.created_at)),
    ];
    db.prepare(
        r#"
        INSERT INTO task_billing_reconciliation_events (
          resolution_key, reconciliation_id, reservation_key,
          reconciliation_revision, action, reason, provider_task_id,
          evidence_reference, evidence_sha256, preview_token,
          decision_sha256, operator_id, created_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
        WHERE EXISTS (
          SELECT 1 FROM task_billing_intents
          WHERE reservation_key = ?3
            AND reconciliation_id = ?2
            AND reconciliation_revision = ?4
            AND reconciliation_resolution = ''
            AND status = 'recovery_required'
            AND submit_state = 'submit_unknown'
        )
        "#,
    )
    .bind_refs(&args)
}

pub async fn refund_task_billing_reconciliation(
    db: &D1Database,
    event: &TaskBillingReconciliationEvent<'_>,
    admin_audit: worker::D1PreparedStatement,
) -> worker::Result<TaskBillingReconciliationMutationOutcome> {
    let event_insert = task_billing_reconciliation_event_statement(db, event)?;
    let args = [
        D1Type::Integer(d1_i32(event.created_at)),
        D1Type::Text(event.resolution_key),
        D1Type::Integer(d1_i32(event.operator_id)),
        D1Type::Text(event.evidence_sha256),
        D1Type::Text(event.reason),
        D1Type::Text(event.reconciliation_id),
        D1Type::Text(event.reservation_key),
        D1Type::Integer(d1_i32(event.expected_revision)),
    ];
    let update = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'refunded', submit_state = 'rejected',
                refunded_at = ?1, updated_at = ?1,
                owner_generation = owner_generation + 1,
                reconciliation_revision = reconciliation_revision + 1,
                reconciliation_resolution = 'refunded',
                reconciliation_resolution_key = ?2,
                reconciliation_resolved_at = ?1,
                reconciliation_operator_id = ?3,
                reconciliation_evidence_sha256 = ?4,
                reconciliation_reason = ?5,
                recovery_last_error = ''
            WHERE reconciliation_id = ?6
              AND reservation_key = ?7
              AND reconciliation_revision = ?8
              AND reconciliation_resolution = ''
              AND status = 'recovery_required'
              AND submit_state = 'submit_unknown'
              AND request_accounted = 0
              AND NOT EXISTS (
                SELECT 1 FROM tasks
                WHERE json_extract(private_data, '$.billing_reservation_key') = ?7
              )
              AND NOT EXISTS (
                SELECT 1 FROM midjourneys
                WHERE json_extract(
                  CASE WHEN json_valid(properties) THEN properties ELSE '{}' END,
                  '$.billing_reservation_key'
                ) = ?7
              )
              AND EXISTS (
                SELECT 1 FROM task_billing_reconciliation_events
                WHERE resolution_key = ?2 AND reconciliation_id = ?6
              )
            "#,
        )
        .bind_refs(&args)?;
    let results = db
        .batch(vec![
            event_insert,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            update,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            admin_audit,
        ])
        .await?;
    if task_batch_changed(&results, 0)? && task_batch_changed(&results, 2)? {
        Ok(TaskBillingReconciliationMutationOutcome::Applied)
    } else {
        Ok(TaskBillingReconciliationMutationOutcome::Conflict)
    }
}

pub async fn attach_task_billing_reconciliation(
    db: &D1Database,
    task: &NewTask<'_>,
    event: &TaskBillingReconciliationEvent<'_>,
    admin_audit: worker::D1PreparedStatement,
) -> worker::Result<TaskBillingReconciliationMutationOutcome> {
    let event_insert = task_billing_reconciliation_event_statement(db, event)?;
    let private_data = serde_json::json!({
        "token_id": task.token_id,
        "upstream_task_id": task.upstream_task_id,
        "billing_reservation_key": event.reservation_key,
    })
    .to_string();
    let insert_args = [
        D1Type::Text(task.task_id),
        D1Type::Text(task.upstream_task_id),
        D1Type::Text(task.platform),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Text(task.username),
        D1Type::Text(task.group),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Text(task.action),
        D1Type::Text(task.status.as_str()),
        D1Type::Integer(d1_i32(task.submit_time)),
        D1Type::Integer(d1_i32(task.created_at)),
        D1Type::Integer(d1_i32(task.updated_at)),
        D1Type::Text(task.properties),
        D1Type::Text(&private_data),
        D1Type::Text(task.data),
        D1Type::Text(event.reservation_key),
        D1Type::Text(event.reconciliation_id),
        D1Type::Integer(d1_i32(event.expected_revision)),
        D1Type::Integer(d1_i32(task.token_id)),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO tasks
              (task_id, upstream_task_id, platform, user_id, username, "group",
               channel_id, quota, action, status, submit_time, created_at,
               updated_at, properties, private_data, data)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                   ?13, ?14, ?15, ?16
            WHERE EXISTS (
              SELECT 1 FROM task_billing_intents
              WHERE reservation_key = ?17
                AND reconciliation_id = ?18
                AND reconciliation_revision = ?19
                AND reconciliation_resolution = ''
                AND task_kind = 'task'
                AND public_task_id = ?1
                AND user_id = ?4 AND token_id = ?20
                AND channel_id = ?7 AND quota = ?8
                AND status = 'recovery_required'
                AND submit_state = 'submit_unknown'
            )
            "#,
        )
        .bind_refs(&insert_args)?;
    let update_args = [
        D1Type::Text(task.upstream_task_id),
        D1Type::Integer(d1_i32(event.created_at)),
        D1Type::Text(event.resolution_key),
        D1Type::Integer(d1_i32(event.operator_id)),
        D1Type::Text(event.evidence_sha256),
        D1Type::Text(event.reason),
        D1Type::Text(event.reconciliation_id),
        D1Type::Text(event.reservation_key),
        D1Type::Integer(d1_i32(event.expected_revision)),
        D1Type::Text(task.task_id),
    ];
    let update = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'attached', submit_state = 'submitted',
                provider_task_id = ?1, request_accounted = 1,
                attached_at = ?2, updated_at = ?2,
                owner_generation = owner_generation + 1,
                reconciliation_revision = reconciliation_revision + 1,
                reconciliation_resolution = 'attached',
                reconciliation_resolution_key = ?3,
                reconciliation_resolved_at = ?2,
                reconciliation_operator_id = ?4,
                reconciliation_evidence_sha256 = ?5,
                reconciliation_reason = ?6,
                recovery_last_error = ''
            WHERE reconciliation_id = ?7
              AND reservation_key = ?8
              AND reconciliation_revision = ?9
              AND reconciliation_resolution = ''
              AND task_kind = 'task'
              AND public_task_id = ?10
              AND status = 'recovery_required'
              AND submit_state = 'submit_unknown'
              AND request_accounted = 0
              AND (provider_task_id = '' OR provider_task_id = ?1)
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE task_id = ?10 AND upstream_task_id = ?1
                  AND json_extract(private_data, '$.billing_reservation_key') = ?8
              )
              AND EXISTS (
                SELECT 1 FROM task_billing_reconciliation_events
                WHERE resolution_key = ?3 AND reconciliation_id = ?7
              )
            "#,
        )
        .bind_refs(&update_args)?;
    let results = db
        .batch(vec![
            event_insert,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            insert,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            update,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            admin_audit,
        ])
        .await?;
    if task_batch_changed(&results, 0)?
        && task_batch_changed(&results, 2)?
        && task_batch_changed(&results, 4)?
    {
        Ok(TaskBillingReconciliationMutationOutcome::Applied)
    } else {
        Ok(TaskBillingReconciliationMutationOutcome::Conflict)
    }
}

/// Refund only a pre-attachment intent. Attached work must transition through
/// the task/Midjourney terminal CAS so a live task cannot be refunded by an
/// ambiguous submit response.
pub async fn refund_unattached_task_billing_intent(
    db: &D1Database,
    reservation_key: &str,
    now: i64,
    reason: &str,
) -> worker::Result<TaskBillingIntentRefundOutcome> {
    let reason = reason.trim().chars().take(256).collect::<String>();
    let args = [
        D1Type::Integer(d1_i32(now)),
        D1Type::Text(&reason),
        D1Type::Text(reservation_key.trim()),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'refunded',
                refunded_at = ?1,
                updated_at = ?1,
                owner_generation = owner_generation + 1,
                recovery_last_error = ?2
            WHERE reservation_key = ?3
              AND status IN ('reserved', 'recovery_required')
              AND submit_state IN ('prepared', 'rejected')
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1 {
        return Ok(TaskBillingIntentRefundOutcome::Applied);
    }
    match find_task_billing_intent(db, reservation_key).await? {
        None => Ok(TaskBillingIntentRefundOutcome::NotFound),
        Some(_) => Ok(TaskBillingIntentRefundOutcome::AlreadyFinalized),
    }
}

#[derive(Debug, Deserialize)]
struct TaskBillingIntentKeyRow {
    reservation_key: String,
    submit_state: String,
}

pub async fn sweep_expired_task_billing_intents(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<TaskBillingIntentSweepSummary> {
    let limit = limit.clamp(1, TASK_BILLING_INTENT_SWEEP_MAX_LIMIT);
    let args = [D1Type::Integer(d1_i32(now)), D1Type::Integer(d1_i32(limit))];
    let rows = db
        .prepare(TASK_BILLING_INTENT_SWEEP_SELECT)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TaskBillingIntentKeyRow>()?;
    let mut summary = TaskBillingIntentSweepSummary {
        candidates: rows.len() as i64,
        ..TaskBillingIntentSweepSummary::default()
    };
    for row in rows {
        if row.submit_state == "submitting" {
            match mark_task_billing_intent_submit_unknown(
                db,
                &row.reservation_key,
                now,
                "provider_submit_lease_expired",
            )
            .await
            {
                Ok(true) => summary.recovery_required += 1,
                Ok(false) => summary.already_finalized += 1,
                Err(err) => {
                    summary.failed += 1;
                    worker::console_error!(
                        "task billing intent unknown-submit recovery failed for {}: {}",
                        row.reservation_key,
                        err
                    );
                }
            }
            continue;
        }
        match refund_unattached_task_billing_intent(
            db,
            &row.reservation_key,
            now,
            "submit_intent_lease_expired",
        )
        .await
        {
            Ok(TaskBillingIntentRefundOutcome::Applied) => summary.refunded += 1,
            Ok(TaskBillingIntentRefundOutcome::AlreadyFinalized)
            | Ok(TaskBillingIntentRefundOutcome::NotFound) => summary.already_finalized += 1,
            Err(err) => {
                summary.failed += 1;
                worker::console_error!(
                    "task billing intent recovery failed for {}: {}",
                    row.reservation_key,
                    err
                );
            }
        }
    }
    Ok(summary)
}

pub async fn task_billing_intent_schema_ready(db: &D1Database) -> worker::Result<bool> {
    #[derive(Debug, Deserialize)]
    struct SchemaCountRow {
        count: i64,
    }
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM sqlite_master
            WHERE (type = 'table' AND name IN (
                    'task_billing_intents',
                    'task_billing_reconciliation_events'
                  ))
               OR (type = 'index' AND name IN (
                 'idx_task_billing_intents_status_lease',
                 'idx_task_billing_intents_user_status',
                 'idx_task_billing_intents_provider_task',
                 'idx_task_billing_intent_reconciliation_id',
                 'idx_task_billing_intent_reconciliation_resolution_key',
                 'idx_task_billing_intent_reconciliation_queue',
                 'idx_task_billing_reconciliation_event_identity',
                 'idx_task_billing_intents_client_operation',
                 'idx_task_billing_intents_provider_operation',
                 'idx_task_billing_intents_submit_deadline'
               ))
               OR (type = 'trigger' AND name IN (
                 'task_billing_intent_contract_immutable_guard',
                 'task_billing_intent_insert_guard',
                 'task_billing_intent_channel_delete_guard',
                 'task_billing_intent_reserve_apply',
                 'task_billing_intent_submit_transition_guard',
                 'task_billing_intent_status_transition_guard',
                 'task_billing_intent_attach_guard',
                 'task_billing_intent_attach_accounting',
                 'task_billing_intent_terminal_guard',
                 'task_billing_intent_refund_guard',
                 'task_billing_intent_refund_apply',
                 'task_billing_intent_reconciliation_guard',
                 'task_billing_reconciliation_event_update_guard',
                 'task_billing_reconciliation_event_delete_guard',
                 'task_billing_intent_submit_operation_insert_guard',
                 'task_billing_intent_submit_operation_immutable_guard'
               ))
            "#,
        )
        .first::<SchemaCountRow>(None)
        .await?;
    if !row.map(|row| row.count == 28).unwrap_or(false) {
        return Ok(false);
    }
    let columns = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count FROM (
              SELECT name FROM pragma_table_info('task_billing_intents')
              WHERE name IN (
                'attach_contract_json', 'attach_contract_sha256',
                'reconciliation_id', 'reconciliation_revision',
                'reconciliation_resolution', 'reconciliation_resolution_key',
                'reconciliation_resolved_at', 'reconciliation_operator_id',
                'reconciliation_evidence_sha256', 'reconciliation_reason',
                'submit_deadline_at', 'client_operation_key_sha256',
                'client_request_sha256'
              )
              UNION ALL
              SELECT name FROM pragma_table_info('task_billing_reconciliation_events')
              WHERE name IN (
                'resolution_key', 'reconciliation_id', 'reservation_key',
                'reconciliation_revision', 'action', 'reason',
                'provider_task_id', 'evidence_reference', 'evidence_sha256',
                'preview_token', 'decision_sha256', 'operator_id', 'created_at'
              )
            )
            "#,
        )
        .first::<SchemaCountRow>(None)
        .await?;
    Ok(columns.map(|row| row.count == 26).unwrap_or(false))
}

pub(crate) fn task_billing_intent_contract_compiled() -> bool {
    let expand = include_str!("../../../migrations/d1/0038_task_submit_operation_expand.sql");
    let enforce = include_str!("../../../migrations/d1/0039_task_submit_operation_enforce.sql");
    TASK_BILLING_INTENT_MIGRATION == "0031_task_billing_intents.sql"
        && TASK_SUBMIT_RECONCILIATION_MIGRATION == "0033_task_submit_reconciliation_enforce.sql"
        && TASK_SUBMIT_OPERATION_MIGRATION == "0039_task_submit_operation_enforce.sql"
        && TASK_SUBMIT_OPERATION_CONTRACT_VERSION == 1
        && TASK_BILLING_INTENT_LEASE_SECONDS == 900
        && expand.contains("ADD COLUMN submit_deadline_at")
        && expand.contains("idx_task_billing_intents_provider_operation")
        && enforce.contains("task_billing_intent_submit_operation_insert_guard")
        && task_billing_contract_sha256("{}")
            == "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
}

pub(crate) fn task_poll_lease_contract_compiled() -> bool {
    let expand = include_str!("../../../migrations/d1/0034_task_poll_lease.sql");
    let enforce = include_str!("../../../migrations/d1/0035_task_poll_lease_enforce.sql");
    TASK_POLL_LEASE_MIGRATION == "0035_task_poll_lease_enforce.sql"
        && TASK_POLL_LEASE_CONTRACT_VERSION == 1
        && expand.contains("ADD COLUMN poll_generation")
        && expand.contains("ADD COLUMN poll_write_revision")
        && enforce.contains("task_poll_write_revision_guard")
        && enforce.contains("midjourney_poll_write_revision_guard")
}

pub(crate) fn task_poll_scheduler_contract_compiled() -> bool {
    let migration = include_str!("../../../migrations/d1/0036_task_poll_schedule.sql");
    TASK_POLL_SCHEDULER_MIGRATION == "0036_task_poll_schedule.sql"
        && TASK_POLL_SCHEDULER_CONTRACT_VERSION == 1
        && migration.contains("ADD COLUMN next_poll_at")
        && migration.contains("ADD COLUMN poll_consecutive_failures")
        && migration.contains("ADD COLUMN poll_quarantined_at")
        && migration.contains("CREATE TABLE task_poll_family_cursors")
        && migration.contains("idx_tasks_poll_schedule_due")
        && migration.contains("idx_midjourneys_poll_schedule_due")
}

pub(crate) fn task_poll_recovery_contract_compiled() -> bool {
    let migration = include_str!("../../../migrations/d1/0037_task_poll_recovery.sql");
    TASK_POLL_RECOVERY_MIGRATION == "0037_task_poll_recovery.sql"
        && TASK_POLL_RECOVERY_CONTRACT_VERSION == 2
        && migration.contains("CREATE TABLE task_poll_recovery_events")
        && migration.contains("task_poll_recovery_task_guard")
        && migration.contains("task_poll_recovery_midjourney_guard")
        && migration.contains("task_poll_recovery_task_apply")
        && migration.contains("task_poll_recovery_midjourney_apply")
        && migration.contains("task_poll_recovery_event_update_guard")
        && migration.contains("task_poll_recovery_event_delete_guard")
        && migration.contains("idx_tasks_poll_quarantine_queue")
        && migration.contains("idx_midjourneys_poll_quarantine_queue")
        && migration.contains("idx_task_poll_recovery_events_revision")
        && migration.contains("NOT GLOB '*[^0-9a-f]*'")
}

pub async fn task_poll_lease_runtime_status(
    db: &D1Database,
) -> worker::Result<TaskPollLeaseRuntimeStatus> {
    #[derive(Debug, Deserialize)]
    struct SchemaObjectRow {
        object_type: String,
        name: String,
        sql: String,
    }
    #[derive(Debug, Deserialize)]
    struct ColumnShapeRow {
        table_name: String,
        name: String,
        column_type: String,
        not_null: i64,
        default_value: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct IndexColumnRow {
        index_name: String,
        sequence: i64,
        name: String,
    }
    #[derive(Debug, Deserialize)]
    struct ControlRow {
        contract_version: i64,
        authority_enabled: i64,
        enforcement_enabled: i64,
    }
    let objects = db
        .prepare(
            r#"
            SELECT type AS object_type, name, COALESCE(sql, '') AS sql
            FROM sqlite_master
            WHERE name IN (
              'task_poll_lease_control',
              'idx_tasks_poll_lease_due',
              'idx_midjourneys_poll_lease_due',
              'task_poll_lease_shape_guard',
              'midjourney_poll_lease_shape_guard',
              'task_poll_write_revision_guard',
              'midjourney_poll_write_revision_guard'
            )
            "#,
        )
        .all()
        .await?
        .results::<SchemaObjectRow>()?;
    let expected_objects = [
        ("table", "task_poll_lease_control"),
        ("index", "idx_tasks_poll_lease_due"),
        ("index", "idx_midjourneys_poll_lease_due"),
        ("trigger", "task_poll_lease_shape_guard"),
        ("trigger", "midjourney_poll_lease_shape_guard"),
        ("trigger", "task_poll_write_revision_guard"),
        ("trigger", "midjourney_poll_write_revision_guard"),
    ];
    let object_set_ready = objects.len() == expected_objects.len()
        && expected_objects.iter().all(|(object_type, name)| {
            objects
                .iter()
                .any(|row| row.object_type == *object_type && row.name == *name)
        });
    if !object_set_ready {
        return Ok(TaskPollLeaseRuntimeStatus {
            schema_ready: false,
            authority_enabled: false,
            enforcement_enabled: false,
        });
    }

    let columns = db
        .prepare(
            r#"
            SELECT 'tasks' AS table_name, name, type AS column_type,
                   "notnull" AS not_null, dflt_value AS default_value
            FROM pragma_table_info('tasks')
            WHERE name LIKE 'poll_%'
            UNION ALL
            SELECT 'midjourneys' AS table_name, name, type AS column_type,
                   "notnull" AS not_null, dflt_value AS default_value
            FROM pragma_table_info('midjourneys')
            WHERE name LIKE 'poll_%'
            UNION ALL
            SELECT 'task_poll_lease_control' AS table_name, name,
                   type AS column_type, "notnull" AS not_null,
                   dflt_value AS default_value
            FROM pragma_table_info('task_poll_lease_control')
            "#,
        )
        .all()
        .await?
        .results::<ColumnShapeRow>()?;
    let poll_columns = [
        ("poll_owner", "TEXT", "''"),
        ("poll_generation", "INTEGER", "0"),
        ("poll_lease_expires_at", "INTEGER", "0"),
        ("poll_applied_generation", "INTEGER", "0"),
        ("poll_write_revision", "INTEGER", "0"),
    ];
    let poll_column_shape_ready = ["tasks", "midjourneys"].iter().all(|table| {
        poll_columns
            .iter()
            .all(|(name, column_type, default_value)| {
                columns.iter().any(|row| {
                    row.table_name == *table
                        && row.name == *name
                        && row.column_type.eq_ignore_ascii_case(column_type)
                        && row.not_null == 1
                        && row.default_value.as_deref() == Some(*default_value)
                })
            })
    });
    let control_columns_ready = [
        ("contract_version", "1"),
        ("authority_enabled", "0"),
        ("enforcement_enabled", "0"),
        ("updated_at", "0"),
    ]
    .iter()
    .all(|(name, default_value)| {
        columns.iter().any(|row| {
            row.table_name == "task_poll_lease_control"
                && row.name == *name
                && row.column_type.eq_ignore_ascii_case("INTEGER")
                && row.not_null == 1
                && row.default_value.as_deref() == Some(*default_value)
        })
    });

    let index_columns = db
        .prepare(
            r#"
            SELECT 'idx_tasks_poll_lease_due' AS index_name,
                   seqno AS sequence, name
            FROM pragma_index_info('idx_tasks_poll_lease_due')
            UNION ALL
            SELECT 'idx_midjourneys_poll_lease_due' AS index_name,
                   seqno AS sequence, name
            FROM pragma_index_info('idx_midjourneys_poll_lease_due')
            "#,
        )
        .all()
        .await?
        .results::<IndexColumnRow>()?;
    let index_shape_ready = [
        ("idx_tasks_poll_lease_due", 0, "poll_lease_expires_at"),
        ("idx_tasks_poll_lease_due", 1, "id"),
        ("idx_midjourneys_poll_lease_due", 0, "poll_lease_expires_at"),
        ("idx_midjourneys_poll_lease_due", 1, "id"),
    ]
    .iter()
    .all(|(index_name, sequence, name)| {
        index_columns.iter().any(|row| {
            row.index_name == *index_name && row.sequence == *sequence && row.name == *name
        })
    });
    let object_sql = |name: &str| {
        objects
            .iter()
            .find(|row| row.name == name)
            .map(|row| row.sql.to_ascii_lowercase())
            .unwrap_or_default()
    };
    let task_index_sql = object_sql("idx_tasks_poll_lease_due");
    let midjourney_index_sql = object_sql("idx_midjourneys_poll_lease_due");
    let trigger_sql_ready = [
        "task_poll_lease_shape_guard",
        "midjourney_poll_lease_shape_guard",
    ]
    .iter()
    .all(|name| {
        let sql = object_sql(name);
        sql.contains("new.poll_generation < old.poll_generation")
            && sql.contains("new.poll_applied_generation < old.poll_applied_generation")
            && sql.contains("new.poll_applied_generation > new.poll_generation")
            && sql.contains("new.poll_lease_expires_at > old.poll_lease_expires_at")
            && sql.contains("new.poll_generation <= old.poll_generation")
    }) && [
        "task_poll_write_revision_guard",
        "midjourney_poll_write_revision_guard",
    ]
    .iter()
    .all(|name| {
        let sql = object_sql(name);
        sql.contains("task_poll_lease_control")
            && sql.contains("new.poll_write_revision != old.poll_write_revision + 1")
    });

    let control = db
        .prepare(
            r#"
            SELECT contract_version, authority_enabled, enforcement_enabled
            FROM task_poll_lease_control
            WHERE id = 1
            "#,
        )
        .first::<ControlRow>(None)
        .await?;
    let schema_ready = poll_column_shape_ready
        && control_columns_ready
        && index_shape_ready
        && task_index_sql.contains("status not in ('success', 'failure')")
        && task_index_sql.contains("upstream_task_id != ''")
        && midjourney_index_sql.contains("status not in ('success', 'failure')")
        && midjourney_index_sql.contains("mj_id != ''")
        && trigger_sql_ready
        && control
            .as_ref()
            .is_some_and(|row| row.contract_version == TASK_POLL_LEASE_CONTRACT_VERSION as i64);
    Ok(TaskPollLeaseRuntimeStatus {
        schema_ready,
        authority_enabled: schema_ready
            && control
                .as_ref()
                .is_some_and(|row| row.authority_enabled == 1),
        enforcement_enabled: schema_ready
            && control
                .as_ref()
                .is_some_and(|row| row.enforcement_enabled == 1),
    })
}

pub async fn task_poll_scheduler_runtime_status(
    db: &D1Database,
) -> worker::Result<TaskPollSchedulerRuntimeStatus> {
    #[derive(Debug, Deserialize)]
    struct ColumnShapeRow {
        table_name: String,
        name: String,
        column_type: String,
        not_null: i64,
        default_value: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct IndexColumnRow {
        index_name: String,
        sequence: i64,
        name: String,
    }
    #[derive(Debug, Deserialize)]
    struct ObjectRow {
        name: String,
        sql: String,
    }
    #[derive(Debug, Deserialize)]
    struct CursorRow {
        family: String,
        last_row_id: i64,
        round_high_watermark: i64,
        scan_generation: i64,
        updated_at: i64,
    }

    let columns = db
        .prepare(
            r#"
            SELECT 'tasks' AS table_name, name, type AS column_type,
                   "notnull" AS not_null, dflt_value AS default_value
            FROM pragma_table_info('tasks')
            WHERE name IN (
              'next_poll_at', 'poll_attempt_count', 'poll_consecutive_failures',
              'poll_last_attempt_at', 'poll_last_error_code',
              'poll_quarantined_at', 'poll_quarantine_reason'
            )
            UNION ALL
            SELECT 'midjourneys' AS table_name, name, type AS column_type,
                   "notnull" AS not_null, dflt_value AS default_value
            FROM pragma_table_info('midjourneys')
            WHERE name IN (
              'next_poll_at', 'poll_attempt_count', 'poll_consecutive_failures',
              'poll_last_attempt_at', 'poll_last_error_code',
              'poll_quarantined_at', 'poll_quarantine_reason'
            )
            "#,
        )
        .all()
        .await?
        .results::<ColumnShapeRow>()?;
    let integer_columns = [
        "next_poll_at",
        "poll_attempt_count",
        "poll_consecutive_failures",
        "poll_last_attempt_at",
        "poll_quarantined_at",
    ];
    let text_columns = ["poll_last_error_code", "poll_quarantine_reason"];
    let columns_ready = ["tasks", "midjourneys"].iter().all(|table| {
        integer_columns.iter().all(|name| {
            columns.iter().any(|row| {
                row.table_name == *table
                    && row.name == *name
                    && row.column_type.eq_ignore_ascii_case("INTEGER")
                    && row.not_null == 1
                    && row.default_value.as_deref() == Some("0")
            })
        }) && text_columns.iter().all(|name| {
            columns.iter().any(|row| {
                row.table_name == *table
                    && row.name == *name
                    && row.column_type.eq_ignore_ascii_case("TEXT")
                    && row.not_null == 1
                    && row.default_value.as_deref() == Some("''")
            })
        })
    });

    let objects = db
        .prepare(
            r#"
            SELECT name, COALESCE(sql, '') AS sql
            FROM sqlite_master
            WHERE name IN (
              'task_poll_family_cursors',
              'idx_tasks_poll_schedule_due',
              'idx_midjourneys_poll_schedule_due'
            )
            "#,
        )
        .all()
        .await?
        .results::<ObjectRow>()?;
    let object_sql = |name: &str| {
        objects
            .iter()
            .find(|row| row.name == name)
            .map(|row| row.sql.to_ascii_lowercase())
            .unwrap_or_default()
    };
    let task_index_sql = object_sql("idx_tasks_poll_schedule_due");
    let midjourney_index_sql = object_sql("idx_midjourneys_poll_schedule_due");
    let objects_ready = objects.len() == 3
        && task_index_sql.contains("poll_quarantined_at = 0")
        && task_index_sql.contains("upstream_task_id != ''")
        && midjourney_index_sql.contains("poll_quarantined_at = 0")
        && midjourney_index_sql.contains("mj_id != ''");

    let index_columns = db
        .prepare(
            r#"
            SELECT 'idx_tasks_poll_schedule_due' AS index_name,
                   seqno AS sequence, name
            FROM pragma_index_info('idx_tasks_poll_schedule_due')
            UNION ALL
            SELECT 'idx_midjourneys_poll_schedule_due' AS index_name,
                   seqno AS sequence, name
            FROM pragma_index_info('idx_midjourneys_poll_schedule_due')
            "#,
        )
        .all()
        .await?
        .results::<IndexColumnRow>()?;
    let indexes_ready = [
        ("idx_tasks_poll_schedule_due", 0, "next_poll_at"),
        ("idx_tasks_poll_schedule_due", 1, "id"),
        ("idx_midjourneys_poll_schedule_due", 0, "next_poll_at"),
        ("idx_midjourneys_poll_schedule_due", 1, "id"),
    ]
    .iter()
    .all(|(index_name, sequence, name)| {
        index_columns.iter().any(|row| {
            row.index_name == *index_name && row.sequence == *sequence && row.name == *name
        })
    });

    let cursors = db
        .prepare(
            r#"
            SELECT family, last_row_id, round_high_watermark, scan_generation, updated_at
            FROM task_poll_family_cursors
            ORDER BY family
            "#,
        )
        .all()
        .await?
        .results::<CursorRow>()?;
    let expected_families = [
        "midjourney",
        "midjourney_timeout",
        "suno",
        "task_timeout",
        "video",
    ];
    let cursors_ready = cursors.len() == expected_families.len()
        && cursors.iter().zip(expected_families).all(|(row, family)| {
            row.family == family
                && row.last_row_id >= 0
                && row.round_high_watermark >= row.last_row_id
                && row.scan_generation >= 0
                && row.updated_at >= 0
        });

    Ok(TaskPollSchedulerRuntimeStatus {
        schema_ready: task_poll_scheduler_contract_compiled()
            && columns_ready
            && objects_ready
            && indexes_ready
            && cursors_ready,
    })
}

pub async fn task_poll_recovery_runtime_status(
    db: &D1Database,
) -> worker::Result<TaskPollRecoveryRuntimeStatus> {
    #[derive(Debug, Deserialize)]
    struct ObjectRow {
        object_type: String,
        name: String,
        sql: String,
    }
    #[derive(Debug, Deserialize)]
    struct ColumnRow {
        name: String,
        column_type: String,
        not_null: i64,
    }

    let objects = db
        .prepare(
            r#"
            SELECT type AS object_type, name, COALESCE(sql, '') AS sql
            FROM sqlite_master
            WHERE name IN (
              'task_poll_recovery_events',
              'idx_task_poll_recovery_events_entity',
              'idx_task_poll_recovery_events_revision',
              'idx_tasks_poll_quarantine_queue',
              'idx_midjourneys_poll_quarantine_queue',
              'task_poll_recovery_event_update_guard',
              'task_poll_recovery_event_delete_guard',
              'task_poll_recovery_task_guard',
              'task_poll_recovery_midjourney_guard',
              'task_poll_recovery_task_apply',
              'task_poll_recovery_midjourney_apply'
            )
            "#,
        )
        .all()
        .await?
        .results::<ObjectRow>()?;
    let expected_objects = [
        ("table", "task_poll_recovery_events"),
        ("index", "idx_task_poll_recovery_events_entity"),
        ("index", "idx_task_poll_recovery_events_revision"),
        ("index", "idx_tasks_poll_quarantine_queue"),
        ("index", "idx_midjourneys_poll_quarantine_queue"),
        ("trigger", "task_poll_recovery_event_update_guard"),
        ("trigger", "task_poll_recovery_event_delete_guard"),
        ("trigger", "task_poll_recovery_task_guard"),
        ("trigger", "task_poll_recovery_midjourney_guard"),
        ("trigger", "task_poll_recovery_task_apply"),
        ("trigger", "task_poll_recovery_midjourney_apply"),
    ];
    let objects_ready = objects.len() == expected_objects.len()
        && expected_objects.iter().all(|(object_type, name)| {
            objects
                .iter()
                .any(|row| row.object_type == *object_type && row.name == *name)
        });
    if !objects_ready {
        return Ok(TaskPollRecoveryRuntimeStatus {
            schema_ready: false,
        });
    }

    let columns = db
        .prepare(
            r#"
            SELECT name, type AS column_type, "notnull" AS not_null
            FROM pragma_table_info('task_poll_recovery_events')
            "#,
        )
        .all()
        .await?
        .results::<ColumnRow>()?;
    let required_columns = [
        ("resolution_key", "TEXT"),
        ("entity_kind", "TEXT"),
        ("entity_id", "INTEGER"),
        ("public_task_id", "TEXT"),
        ("expected_poll_generation", "INTEGER"),
        ("expected_poll_write_revision", "INTEGER"),
        ("expected_quarantined_at", "INTEGER"),
        ("expected_hard_timeout_at", "INTEGER"),
        ("expected_quarantine_reason", "TEXT"),
        ("action", "TEXT"),
        ("reason", "TEXT"),
        ("evidence_reference", "TEXT"),
        ("evidence_sha256", "TEXT"),
        ("preview_token", "TEXT"),
        ("decision_sha256", "TEXT"),
        ("operator_id", "INTEGER"),
        ("created_at", "INTEGER"),
    ];
    let columns_ready = required_columns.iter().all(|(name, column_type)| {
        columns.iter().any(|row| {
            row.name == *name
                && row.column_type.eq_ignore_ascii_case(column_type)
                && row.not_null == 1
        })
    });
    let object_sql = |name: &str| {
        objects
            .iter()
            .find(|row| row.name == name)
            .map(|row| row.sql.to_ascii_lowercase())
            .unwrap_or_default()
    };
    let guards_ready = [
        "task_poll_recovery_task_guard",
        "task_poll_recovery_midjourney_guard",
    ]
    .iter()
    .all(|name| {
        let sql = object_sql(name);
        sql.contains("poll_owner = ''")
            && sql.contains("poll_lease_expires_at = 0")
            && sql.contains("poll_generation = new.expected_poll_generation")
            && sql.contains("poll_write_revision = new.expected_poll_write_revision")
            && sql.contains("expected_hard_timeout_at")
            && sql.contains("raise(abort")
    });
    let apply_ready = [
        "task_poll_recovery_task_apply",
        "task_poll_recovery_midjourney_apply",
    ]
    .iter()
    .all(|name| {
        let sql = object_sql(name);
        sql.contains("next_poll_at = new.created_at")
            && sql.contains("poll_consecutive_failures = 0")
            && sql.contains("poll_quarantined_at = 0")
            && sql.contains("poll_write_revision = poll_write_revision + 1")
    });
    let immutable_ready = [
        "task_poll_recovery_event_update_guard",
        "task_poll_recovery_event_delete_guard",
    ]
    .iter()
    .all(|name| object_sql(name).contains("events are immutable"));
    let digest_constraints_ready = object_sql("task_poll_recovery_events")
        .matches("not glob '*[^0-9a-f]*'")
        .count()
        >= 4;
    let indexes_ready = object_sql("idx_task_poll_recovery_events_revision")
        .contains("entity_kind, entity_id, expected_poll_write_revision")
        && [
            "idx_tasks_poll_quarantine_queue",
            "idx_midjourneys_poll_quarantine_queue",
        ]
        .iter()
        .all(|name| {
            let sql = object_sql(name);
            sql.contains("poll_quarantined_at, id")
                && sql.contains("poll_quarantined_at > 0")
                && sql.contains("status not in ('success', 'failure')")
        });

    Ok(TaskPollRecoveryRuntimeStatus {
        schema_ready: task_poll_recovery_contract_compiled()
            && columns_ready
            && guards_ready
            && apply_ready
            && immutable_ready
            && digest_constraints_ready
            && indexes_ready,
    })
}

pub async fn list_task_poll_quarantines(
    db: &D1Database,
    after_quarantined_at: i64,
    after_entity_kind: &str,
    after_entity_id: i64,
    limit: i64,
) -> worker::Result<Vec<TaskPollQuarantineRow>> {
    let after_quarantined_at = after_quarantined_at.max(0).to_string();
    let after_entity_id = after_entity_id.max(0).to_string();
    let limit = limit.clamp(1, 51).to_string();
    let args = [
        D1Type::Text(&after_quarantined_at),
        D1Type::Text(after_entity_kind),
        D1Type::Text(&after_entity_id),
        D1Type::Text(&limit),
    ];
    db.prepare(
        r#"
        SELECT entity_kind, entity_id, public_task_id, platform, channel_id,
               status, submit_time, poll_owner, poll_generation, poll_lease_expires_at,
               poll_write_revision, poll_attempt_count,
               poll_consecutive_failures, poll_last_error_code,
               poll_quarantined_at, poll_quarantine_reason
        FROM (
          SELECT 'task' AS entity_kind, id AS entity_id,
                 task_id AS public_task_id, platform, channel_id, status, submit_time,
                 poll_owner, poll_generation, poll_lease_expires_at,
                 poll_write_revision, poll_attempt_count,
                 poll_consecutive_failures, poll_last_error_code,
                 poll_quarantined_at, poll_quarantine_reason
          FROM tasks
          WHERE poll_quarantined_at > 0
            AND status NOT IN ('SUCCESS', 'FAILURE')
            AND upstream_task_id != ''
          UNION ALL
          SELECT 'midjourney' AS entity_kind, id AS entity_id,
                 mj_id AS public_task_id, 'midjourney' AS platform,
                 channel_id, status, submit_time, poll_owner, poll_generation,
                 poll_lease_expires_at, poll_write_revision,
                 poll_attempt_count, poll_consecutive_failures,
                 poll_last_error_code, poll_quarantined_at,
                 poll_quarantine_reason
          FROM midjourneys
          WHERE poll_quarantined_at > 0
            AND status NOT IN ('SUCCESS', 'FAILURE')
            AND mj_id != ''
        ) quarantines
        WHERE poll_quarantined_at > CAST(?1 AS INTEGER)
           OR (
             poll_quarantined_at = CAST(?1 AS INTEGER)
             AND entity_kind > ?2
           )
           OR (
             poll_quarantined_at = CAST(?1 AS INTEGER)
             AND entity_kind = ?2
             AND entity_id > CAST(?3 AS INTEGER)
           )
        ORDER BY poll_quarantined_at ASC, entity_kind ASC, entity_id ASC
        LIMIT CAST(?4 AS INTEGER)
        "#,
    )
    .bind_refs(&args)?
    .all()
    .await?
    .results::<TaskPollQuarantineRow>()
}

pub async fn find_task_poll_quarantine(
    db: &D1Database,
    entity_kind: &str,
    entity_id: i64,
) -> worker::Result<Option<TaskPollQuarantineRow>> {
    let entity_id = entity_id.to_string();
    let args = D1Type::Text(&entity_id);
    let sql = match entity_kind {
        "task" => {
            r#"
            SELECT 'task' AS entity_kind, id AS entity_id,
                   task_id AS public_task_id, platform, channel_id, status, submit_time,
                   poll_owner, poll_generation, poll_lease_expires_at,
                   poll_write_revision, poll_attempt_count,
                   poll_consecutive_failures, poll_last_error_code,
                   poll_quarantined_at, poll_quarantine_reason
            FROM tasks
            WHERE id = CAST(?1 AS INTEGER)
            "#
        }
        "midjourney" => {
            r#"
            SELECT 'midjourney' AS entity_kind, id AS entity_id,
                   mj_id AS public_task_id, 'midjourney' AS platform,
                   channel_id, status, submit_time, poll_owner, poll_generation,
                   poll_lease_expires_at, poll_write_revision,
                   poll_attempt_count, poll_consecutive_failures,
                   poll_last_error_code, poll_quarantined_at,
                   poll_quarantine_reason
            FROM midjourneys
            WHERE id = CAST(?1 AS INTEGER)
            "#
        }
        _ => return Ok(None),
    };
    db.prepare(sql)
        .bind_refs(&args)?
        .first::<TaskPollQuarantineRow>(None)
        .await
}

fn task_poll_recovery_event_statement(
    db: &D1Database,
    event: &TaskPollRecoveryEvent<'_>,
) -> worker::Result<worker::D1PreparedStatement> {
    let entity_id = event.entity_id.to_string();
    let expected_generation = event.expected_poll_generation.to_string();
    let expected_revision = event.expected_poll_write_revision.to_string();
    let expected_quarantined_at = event.expected_quarantined_at.to_string();
    let expected_hard_timeout_at = event.expected_hard_timeout_at.to_string();
    let operator_id = event.operator_id.to_string();
    let created_at = event.created_at.to_string();
    let args = [
        D1Type::Text(event.resolution_key),
        D1Type::Text(event.entity_kind),
        D1Type::Text(&entity_id),
        D1Type::Text(event.public_task_id),
        D1Type::Text(&expected_generation),
        D1Type::Text(&expected_revision),
        D1Type::Text(&expected_quarantined_at),
        D1Type::Text(&expected_hard_timeout_at),
        D1Type::Text(event.expected_quarantine_reason),
        D1Type::Text(event.reason),
        D1Type::Text(event.evidence_reference),
        D1Type::Text(event.evidence_sha256),
        D1Type::Text(event.preview_token),
        D1Type::Text(event.decision_sha256),
        D1Type::Text(&operator_id),
        D1Type::Text(&created_at),
    ];
    db.prepare(
        r#"
        INSERT INTO task_poll_recovery_events (
          resolution_key, entity_kind, entity_id, public_task_id,
          expected_poll_generation, expected_poll_write_revision,
          expected_quarantined_at, expected_hard_timeout_at,
          expected_quarantine_reason,
          action, reason, evidence_reference, evidence_sha256,
          preview_token, decision_sha256, operator_id, created_at
        ) VALUES (
          ?1, ?2, CAST(?3 AS INTEGER), ?4, CAST(?5 AS INTEGER),
          CAST(?6 AS INTEGER), CAST(?7 AS INTEGER), CAST(?8 AS INTEGER), ?9,
          'requeue', ?10, ?11, ?12, ?13, ?14,
          CAST(?15 AS INTEGER), CAST(?16 AS INTEGER)
        )
        "#,
    )
    .bind_refs(&args)
}

pub async fn find_task_poll_recovery_event(
    db: &D1Database,
    resolution_key: &str,
) -> worker::Result<Option<TaskPollRecoveryAppliedEvent>> {
    let args = D1Type::Text(resolution_key);
    db.prepare(
        r#"
            SELECT entity_kind, entity_id, created_at
            FROM task_poll_recovery_events
            WHERE resolution_key = ?1
            "#,
    )
    .bind_refs(&args)?
    .first::<TaskPollRecoveryAppliedEvent>(None)
    .await
}

pub async fn apply_task_poll_recovery(
    db: &D1Database,
    event: &TaskPollRecoveryEvent<'_>,
    admin_audit: worker::D1PreparedStatement,
) -> Result<TaskPollRecoveryMutationOutcome, TaskPollRecoveryMutationError> {
    let insert = task_poll_recovery_event_statement(db, event)?;
    match db.batch(vec![insert, admin_audit]).await {
        Ok(results) if results.len() == 2 => Ok(TaskPollRecoveryMutationOutcome::Applied),
        Ok(_) => Err(TaskPollRecoveryMutationError::Unavailable(
            worker::Error::RustError(
                "task poll recovery batch returned incomplete results".to_string(),
            ),
        )),
        Err(err) => match find_task_poll_recovery_event(db, event.resolution_key).await {
            Ok(Some(applied))
                if applied.entity_kind == event.entity_kind
                    && applied.entity_id == event.entity_id =>
            {
                Ok(TaskPollRecoveryMutationOutcome::Duplicate)
            }
            Ok(Some(_)) => Err(TaskPollRecoveryMutationError::Conflict),
            Ok(None) => match find_task_poll_quarantine(db, event.entity_kind, event.entity_id)
                .await
            {
                Ok(Some(row)) if task_poll_recovery_row_matches_event(&row, event) => {
                    Err(TaskPollRecoveryMutationError::Unavailable(err))
                }
                Ok(_) => Err(TaskPollRecoveryMutationError::Conflict),
                Err(readback_err) => Err(TaskPollRecoveryMutationError::Unavailable(readback_err)),
            },
            Err(readback_err) => Err(TaskPollRecoveryMutationError::Unavailable(readback_err)),
        },
    }
}

fn task_poll_recovery_row_matches_event(
    row: &TaskPollQuarantineRow,
    event: &TaskPollRecoveryEvent<'_>,
) -> bool {
    row.entity_kind == event.entity_kind
        && row.entity_id == event.entity_id
        && row.public_task_id == event.public_task_id
        && row.poll_generation == event.expected_poll_generation
        && row.poll_write_revision == event.expected_poll_write_revision
        && row.poll_quarantined_at == event.expected_quarantined_at
        && row.poll_quarantine_reason == event.expected_quarantine_reason
        && row.poll_owner.is_empty()
        && row.poll_lease_expires_at == 0
        && !matches!(row.status.as_str(), "SUCCESS" | "FAILURE")
}

/// The fields needed to create a task row. Columns not listed take their
/// `0001_core.sql` defaults.
pub struct NewTask<'a> {
    pub task_id: &'a str,
    pub upstream_task_id: &'a str,
    pub platform: &'a str,
    pub user_id: i64,
    pub username: &'a str,
    pub group: &'a str,
    pub channel_id: i64,
    /// The reserving token — persisted in `private_data` (Go
    /// `TaskPrivateData.TokenId`, "令牌 ID，用于令牌额度退款") so a failed task's
    /// reserve can be refunded to the token, not just the user.
    pub token_id: i64,
    /// Migration-0031 pre-provider ownership identity. Empty is accepted only
    /// for imported/legacy rows that predate durable task intents.
    pub billing_reservation_key: &'a str,
    pub quota: i64,
    pub action: &'a str,
    pub status: TaskStatus,
    pub submit_time: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Go `Task.Properties`: model metadata carried to DTO conversion and
    /// OpenAI-compatible video responses.
    pub properties: &'a str,
    /// Raw provider response data persisted as Go `Task.Data`. Upstream task
    /// providers return JSON today; callers pass `{}` for flows that do not
    /// have provider data yet.
    pub data: &'a str,
}

/// A task row as read back from D1. `status` is parsed via
/// [`TaskStatus::from_status_str`] (unknown → `Unknown`, Go's fallback).
#[derive(Debug, Deserialize)]
pub struct TaskRow {
    pub id: i64,
    pub task_id: String,
    pub upstream_task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub channel_id: i64,
    /// Reserving token id, read back from `private_data` (0 for legacy rows that
    /// predate token-id persistence). Drives the token-quota refund on failure.
    #[serde(default)]
    pub token_id: i64,
    #[serde(default)]
    pub billing_reservation_key: String,
    pub quota: i64,
    pub action: String,
    pub status: String,
    pub fail_reason: String,
    pub progress: String,
    pub finish_time: i64,
    pub submit_time: i64,
    pub poll_owner: String,
    pub poll_generation: i64,
    pub poll_lease_expires_at: i64,
    pub poll_applied_generation: i64,
    pub poll_write_revision: i64,
    pub next_poll_at: i64,
    pub poll_attempt_count: i64,
    pub poll_consecutive_failures: i64,
    pub poll_last_attempt_at: i64,
    pub poll_last_error_code: String,
    pub poll_quarantined_at: i64,
    pub poll_quarantine_reason: String,
}

impl TaskRow {
    /// The parsed lifecycle status.
    pub fn status(&self) -> TaskStatus {
        TaskStatus::from_status_str(&self.status)
    }
}

const TASK_POLL_ROW_COLUMNS: &str = r#"
    id, task_id, upstream_task_id, platform, user_id, channel_id,
    CASE WHEN json_valid(private_data)
         THEN COALESCE(json_extract(private_data, '$.token_id'), 0)
         ELSE 0 END AS token_id,
    CASE WHEN json_valid(private_data)
         THEN COALESCE(json_extract(private_data, '$.billing_reservation_key'), '')
         ELSE '' END AS billing_reservation_key,
    quota, action, status, fail_reason, progress, finish_time, submit_time,
    poll_owner, poll_generation, poll_lease_expires_at,
    poll_applied_generation, poll_write_revision,
    next_poll_at, poll_attempt_count, poll_consecutive_failures,
    poll_last_attempt_at, poll_last_error_code, poll_quarantined_at,
    poll_quarantine_reason
"#;

#[derive(Debug, Deserialize)]
pub(crate) struct TaskPollFamilyCursor {
    pub last_row_id: i64,
    pub round_high_watermark: i64,
    pub scan_generation: i64,
}

pub(crate) async fn load_task_poll_family_cursor(
    db: &D1Database,
    family: &str,
) -> worker::Result<TaskPollFamilyCursor> {
    let family_arg = D1Type::Text(family);
    db.prepare(
        r#"
        SELECT last_row_id, round_high_watermark, scan_generation
        FROM task_poll_family_cursors
        WHERE family = ?1
        "#,
    )
    .bind_refs(&family_arg)?
    .first::<TaskPollFamilyCursor>(None)
    .await?
    .ok_or_else(|| worker::Error::RustError(format!("task poll cursor missing: {family}")))
}

pub(crate) async fn advance_task_poll_family_cursor(
    db: &D1Database,
    family: &str,
    last_row_id: i64,
    now: i64,
) -> worker::Result<bool> {
    if last_row_id <= 0 {
        return Ok(false);
    }
    let cursor = load_task_poll_family_cursor(db, family).await?;
    if last_row_id <= cursor.last_row_id {
        return Ok(true);
    }
    if last_row_id > cursor.round_high_watermark {
        return Ok(false);
    }
    let last_row_id_text = last_row_id.to_string();
    let now_text = now.to_string();
    let previous_generation = cursor.scan_generation.to_string();
    let round_high_watermark = cursor.round_high_watermark.to_string();
    let args = [
        D1Type::Text(&last_row_id_text),
        D1Type::Text(&now_text),
        D1Type::Text(family),
        D1Type::Text(&previous_generation),
        D1Type::Text(&round_high_watermark),
    ];
    let result = db
        .prepare(
            r#"
        UPDATE task_poll_family_cursors
        SET last_row_id = CAST(?1 AS INTEGER),
            updated_at = CAST(?2 AS INTEGER)
        WHERE family = ?3
          AND scan_generation = CAST(?4 AS INTEGER)
          AND round_high_watermark = CAST(?5 AS INTEGER)
          AND last_row_id < CAST(?1 AS INTEGER)
          AND CAST(?1 AS INTEGER) <= round_high_watermark
        "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1 {
        return Ok(true);
    }
    let current = load_task_poll_family_cursor(db, family).await?;
    Ok(current.scan_generation == cursor.scan_generation
        && current.round_high_watermark == cursor.round_high_watermark
        && current.last_row_id >= last_row_id)
}

pub(crate) async fn begin_task_poll_family_round(
    db: &D1Database,
    family: &str,
    max_row_id: i64,
    now: i64,
) -> worker::Result<TaskPollFamilyCursor> {
    for _ in 0..3 {
        let cursor = load_task_poll_family_cursor(db, family).await?;
        if cursor.round_high_watermark > 0 && cursor.last_row_id < cursor.round_high_watermark {
            return Ok(cursor);
        }
        let max_row_id = max_row_id.max(0);
        let max_row_id_text = max_row_id.to_string();
        let now_text = now.to_string();
        let previous_row_id = cursor.last_row_id.to_string();
        let previous_high_watermark = cursor.round_high_watermark.to_string();
        let previous_generation = cursor.scan_generation.to_string();
        let args = [
            D1Type::Text(&max_row_id_text),
            D1Type::Text(&now_text),
            D1Type::Text(family),
            D1Type::Text(&previous_row_id),
            D1Type::Text(&previous_high_watermark),
            D1Type::Text(&previous_generation),
        ];
        let result = db
            .prepare(
                r#"
                UPDATE task_poll_family_cursors
                SET last_row_id = 0,
                    round_high_watermark = CAST(?1 AS INTEGER),
                    scan_generation = scan_generation + 1,
                    updated_at = CAST(?2 AS INTEGER)
                WHERE family = ?3
                  AND last_row_id = CAST(?4 AS INTEGER)
                  AND round_high_watermark = CAST(?5 AS INTEGER)
                  AND scan_generation = CAST(?6 AS INTEGER)
                "#,
            )
            .bind_refs(&args)?
            .run()
            .await?;
        if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1 {
            return load_task_poll_family_cursor(db, family).await;
        }
    }
    Err(worker::Error::RustError(format!(
        "task poll cursor contention: {family}"
    )))
}

#[derive(Debug, Deserialize)]
struct TaskPollMaxRow {
    max_row_id: i64,
}

async fn load_task_poll_family_max_row_id(
    db: &D1Database,
    platform_predicate: &str,
) -> worker::Result<i64> {
    let sql =
        format!("SELECT COALESCE(MAX(id), 0) AS max_row_id FROM tasks WHERE {platform_predicate}");
    Ok(db
        .prepare(&sql)
        .first::<TaskPollMaxRow>(None)
        .await?
        .map(|row| row.max_row_id)
        .unwrap_or_default())
}

async fn find_unfinished_task_family(
    db: &D1Database,
    family: &str,
    platform_predicate: &str,
    now: i64,
    limit: i64,
) -> worker::Result<Vec<TaskRow>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let max_row_id = load_task_poll_family_max_row_id(db, platform_predicate).await?;
    let cursor = begin_task_poll_family_round(db, family, max_row_id, now).await?;
    if cursor.round_high_watermark <= 0 {
        return Ok(Vec::new());
    }
    let now_text = now.to_string();
    let cursor_text = cursor.last_row_id.to_string();
    let high_watermark_text = cursor.round_high_watermark.to_string();
    let first_limit = d1_i32(limit);
    let first_sql = format!(
        r#"
        SELECT {TASK_POLL_ROW_COLUMNS}
        FROM tasks
        WHERE status NOT IN ('SUCCESS', 'FAILURE')
          AND upstream_task_id != ''
          AND {platform_predicate}
          AND next_poll_at <= CAST(?1 AS INTEGER)
          AND poll_quarantined_at = 0
          AND poll_lease_expires_at <= CAST(?1 AS INTEGER)
          AND id > CAST(?2 AS INTEGER)
          AND id <= CAST(?3 AS INTEGER)
        ORDER BY id ASC
        LIMIT ?4
        "#,
    );
    let first_args = [
        D1Type::Text(&now_text),
        D1Type::Text(&cursor_text),
        D1Type::Text(&high_watermark_text),
        D1Type::Integer(first_limit),
    ];
    let rows = db
        .prepare(&first_sql)
        .bind_refs(&first_args)?
        .all()
        .await?
        .results::<TaskRow>()?;
    if rows.is_empty() {
        let _ =
            advance_task_poll_family_cursor(db, family, cursor.round_high_watermark, now).await?;
    }
    Ok(rows)
}

/// Insert a new task and account its successful submit exactly once. The task,
/// user request/used-quota totals, and channel used quota share one D1 batch;
/// every accounting UPDATE is conditional on the inserted task identity.
pub async fn insert_task(db: &D1Database, task: &NewTask<'_>) -> worker::Result<()> {
    // Persist the reserving token id in private_data (Go `TaskPrivateData`), so
    // the poller can refund the token on failure. Keep the upstream id there as
    // well for source DTO compatibility; the dedicated column remains the Rust
    // fast path.
    let private_data = serde_json::json!({
        "token_id": task.token_id,
        "upstream_task_id": task.upstream_task_id,
        "billing_reservation_key": task.billing_reservation_key,
    })
    .to_string();
    let args = [
        D1Type::Text(task.task_id),
        D1Type::Text(task.upstream_task_id),
        D1Type::Text(task.platform),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Text(task.username),
        D1Type::Text(task.group),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Text(task.action),
        D1Type::Text(task.status.as_str()),
        D1Type::Integer(d1_i32(task.submit_time)),
        D1Type::Integer(d1_i32(task.created_at)),
        D1Type::Integer(d1_i32(task.updated_at)),
        D1Type::Text(task.properties),
        D1Type::Text(&private_data),
        D1Type::Text(task.data),
    ];
    let insert = db
        .prepare(
            r#"
        INSERT INTO tasks
          (task_id, upstream_task_id, platform, user_id, username, "group",
           channel_id, quota, action, status, submit_time, created_at, updated_at,
           properties, private_data, data)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?4)
          AND EXISTS (SELECT 1 FROM channels WHERE id = ?7)
        "#,
        )
        .bind_refs(&args)?;
    let account_args = [
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Text(task.task_id),
    ];
    let account_user = db
        .prepare(
            r#"
            UPDATE users
            SET used_quota = used_quota + ?1,
                request_count = request_count + 1
            WHERE id = ?2
              AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?3)
            "#,
        )
        .bind_refs(&account_args)?;
    let channel_args = [
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Text(task.task_id),
    ];
    let account_channel = db
        .prepare(
            r#"
            UPDATE channels
            SET used_quota = used_quota + ?1
            WHERE id = ?2
              AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?3)
            "#,
        )
        .bind_refs(&channel_args)?;
    let results = db
        .batch(vec![insert, account_user, account_channel])
        .await?;
    for (index, label) in [
        "task insert",
        "task user accounting",
        "task channel accounting",
    ]
    .into_iter()
    .enumerate()
    {
        let changes = results
            .get(index)
            .ok_or_else(|| worker::Error::RustError(format!("missing {label} result")))?
            .meta()?
            .and_then(|meta| meta.changes)
            .unwrap_or(0);
        if changes != 1 {
            return Err(worker::Error::RustError(format!("{label} did not apply")));
        }
    }
    Ok(())
}

/// Attach a provider-accepted task to its pre-provider billing intent. The task
/// insert and the intent's `reserved -> attached` transition share one D1
/// batch; migration 0031 performs request/channel accounting from that unique
/// transition. A matching committed row is accepted after an ambiguous batch
/// response, while any divergent identity fails closed.
pub async fn attach_task_billing_intent(
    db: &D1Database,
    task: &NewTask<'_>,
) -> worker::Result<TaskBillingIntentAttachOutcome> {
    let reservation_key = task.billing_reservation_key.trim();
    if reservation_key.is_empty()
        || task.task_id.trim().is_empty()
        || task.upstream_task_id.trim().is_empty()
    {
        return Err(worker::Error::RustError(
            "task billing attachment identity is invalid".to_string(),
        ));
    }
    let private_data = serde_json::json!({
        "token_id": task.token_id,
        "upstream_task_id": task.upstream_task_id,
        "billing_reservation_key": reservation_key,
    })
    .to_string();
    let insert_args = [
        D1Type::Text(task.task_id),
        D1Type::Text(task.upstream_task_id),
        D1Type::Text(task.platform),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Text(task.username),
        D1Type::Text(task.group),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Integer(d1_i32(task.quota)),
        D1Type::Text(task.action),
        D1Type::Text(task.status.as_str()),
        D1Type::Integer(d1_i32(task.submit_time)),
        D1Type::Integer(d1_i32(task.created_at)),
        D1Type::Integer(d1_i32(task.updated_at)),
        D1Type::Text(task.properties),
        D1Type::Text(&private_data),
        D1Type::Text(task.data),
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(task.token_id)),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO tasks
              (task_id, upstream_task_id, platform, user_id, username, "group",
               channel_id, quota, action, status, submit_time, created_at, updated_at,
               properties, private_data, data)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
            WHERE EXISTS (
              SELECT 1 FROM task_billing_intents
              WHERE reservation_key = ?17
                AND task_kind = 'task'
                AND public_task_id = ?1
                AND user_id = ?4
                AND token_id = ?18
                AND channel_id = ?7
                AND quota = ?8
                AND status = 'reserved'
                AND submit_state = 'submitting'
            )
            "#,
        )
        .bind_refs(&insert_args)?;
    let attach_args = [
        D1Type::Text(task.upstream_task_id),
        D1Type::Integer(d1_i32(task.updated_at)),
        D1Type::Text(reservation_key),
        D1Type::Text(task.task_id),
        D1Type::Integer(d1_i32(task.user_id)),
        D1Type::Integer(d1_i32(task.token_id)),
        D1Type::Integer(d1_i32(task.channel_id)),
        D1Type::Integer(d1_i32(task.quota)),
    ];
    let attach = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'attached',
                submit_state = 'submitted',
                provider_task_id = ?1,
                request_accounted = 1,
                attached_at = ?2,
                updated_at = ?2,
                owner_generation = owner_generation + 1,
                recovery_last_error = ''
            WHERE reservation_key = ?3
              AND task_kind = 'task'
              AND public_task_id = ?4
              AND user_id = ?5
              AND token_id = ?6
              AND channel_id = ?7
              AND quota = ?8
              AND status = 'reserved'
              AND submit_state = 'submitting'
              AND request_accounted = 0
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE task_id = ?4
                  AND upstream_task_id = ?1
                  AND json_extract(private_data, '$.billing_reservation_key') = ?3
              )
            "#,
        )
        .bind_refs(&attach_args)?;

    match db
        .batch(vec![
            insert,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
            attach,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
        ])
        .await
    {
        Ok(results) => {
            if task_batch_changed(&results, 0)? && task_batch_changed(&results, 2)? {
                return Ok(TaskBillingIntentAttachOutcome::Applied);
            }
        }
        Err(err) => {
            if let Some(intent) = find_task_billing_intent(db, reservation_key).await? {
                if intent.status == "attached"
                    && intent.submit_state == "submitted"
                    && intent.public_task_id == task.task_id
                    && intent.provider_task_id == task.upstream_task_id
                    && intent.request_accounted == 1
                {
                    return Ok(TaskBillingIntentAttachOutcome::MatchingAttached);
                }
            }
            return Err(err);
        }
    }

    match find_task_billing_intent(db, reservation_key).await? {
        Some(intent)
            if intent.status == "attached"
                && intent.submit_state == "submitted"
                && intent.public_task_id == task.task_id
                && intent.provider_task_id == task.upstream_task_id
                && intent.request_accounted == 1 =>
        {
            Ok(TaskBillingIntentAttachOutcome::MatchingAttached)
        }
        Some(_) => Ok(TaskBillingIntentAttachOutcome::Conflict),
        None => Err(worker::Error::RustError(
            "task billing intent disappeared during attachment".to_string(),
        )),
    }
}

/// Load unfinished tasks for the poller — rows not yet in a terminal status that
/// carry an upstream id to poll (Go's "未完成的任务" selection). Bounded by
/// `limit` and ordered by id so a batch is deterministic.
pub async fn find_unfinished_tasks(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<Vec<TaskRow>> {
    find_unfinished_task_family(db, "video", "platform != 'suno'", now, limit).await
}

pub async fn find_unfinished_suno_tasks(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<Vec<TaskRow>> {
    find_unfinished_task_family(db, "suno", "platform = 'suno'", now, limit).await
}

/// Load unfinished tasks that have exceeded the configured async-task timeout
/// window (Go `GetTimedOutUnfinishedTasks`). This runs before the normal poller
/// so a backlog of permanently stuck tasks cannot hide newer rows behind the
/// bounded poll window.
pub async fn find_timed_out_unfinished_tasks(
    db: &D1Database,
    cutoff_unix: i64,
    now: i64,
    limit: i64,
) -> worker::Result<Vec<TaskRow>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let max_row_id = load_task_poll_family_max_row_id(db, "1 = 1").await?;
    let cursor = begin_task_poll_family_round(db, "task_timeout", max_row_id, now).await?;
    if cursor.round_high_watermark <= 0 {
        return Ok(Vec::new());
    }
    let cutoff_unix = cutoff_unix.to_string();
    let now = now.to_string();
    let cursor_text = cursor.last_row_id.to_string();
    let high_watermark_text = cursor.round_high_watermark.to_string();
    let args = [
        D1Type::Text(&cutoff_unix),
        D1Type::Text(&now),
        D1Type::Text(&cursor_text),
        D1Type::Text(&high_watermark_text),
        D1Type::Integer(d1_i32(limit)),
    ];
    let sql = format!(
        r#"
        SELECT {TASK_POLL_ROW_COLUMNS}
        FROM tasks
        WHERE progress != '100%'
          AND status NOT IN ('SUCCESS', 'FAILURE')
          AND submit_time < CAST(?1 AS INTEGER)
          AND poll_lease_expires_at <= CAST(?2 AS INTEGER)
          AND id > CAST(?3 AS INTEGER)
          AND id <= CAST(?4 AS INTEGER)
        ORDER BY id ASC
        LIMIT ?5
        "#,
    );
    let rows = db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TaskRow>()?;
    if rows.is_empty() {
        let cursor_now = now.parse::<i64>().unwrap_or_default();
        let _ = advance_task_poll_family_cursor(
            db,
            "task_timeout",
            cursor.round_high_watermark,
            cursor_now,
        )
        .await?;
    }
    Ok(rows)
}

/// Look up a task by its public `task_id` (Go `GetTaskByTaskId`).
pub async fn find_task_by_task_id(
    db: &D1Database,
    task_id: &str,
) -> worker::Result<Option<TaskRow>> {
    let arg = D1Type::Text(task_id);
    db.prepare(
        r#"
        SELECT id, task_id, upstream_task_id, platform, user_id, channel_id,
               CASE WHEN json_valid(private_data)
                    THEN COALESCE(json_extract(private_data, '$.token_id'), 0)
                    ELSE 0 END AS token_id,
               CASE WHEN json_valid(private_data)
                    THEN COALESCE(json_extract(private_data, '$.billing_reservation_key'), '')
                    ELSE '' END AS billing_reservation_key,
               quota, action, status, fail_reason, progress, finish_time,
               submit_time, poll_owner, poll_generation, poll_lease_expires_at,
               poll_applied_generation, poll_write_revision,
               next_poll_at, poll_attempt_count, poll_consecutive_failures,
               poll_last_attempt_at, poll_last_error_code, poll_quarantined_at,
               poll_quarantine_reason
        FROM tasks
        WHERE task_id = ?1
        LIMIT 1
        "#,
    )
    .bind_refs(&arg)?
    .first::<TaskRow>(None)
    .await
}

pub async fn claim_task_poll_lease(
    db: &D1Database,
    task: &TaskRow,
    owner: &str,
    now: i64,
    lease_seconds: i64,
) -> worker::Result<Option<TaskPollLease>> {
    claim_task_poll_lease_inner(db, task, owner, now, lease_seconds, true).await
}

pub async fn claim_task_timeout_poll_lease(
    db: &D1Database,
    task: &TaskRow,
    owner: &str,
    now: i64,
    lease_seconds: i64,
) -> worker::Result<Option<TaskPollLease>> {
    claim_task_poll_lease_inner(db, task, owner, now, lease_seconds, false).await
}

async fn claim_task_poll_lease_inner(
    db: &D1Database,
    task: &TaskRow,
    owner: &str,
    now: i64,
    lease_seconds: i64,
    require_schedule_due: bool,
) -> worker::Result<Option<TaskPollLease>> {
    if owner.is_empty() || owner.len() > 96 || lease_seconds <= 0 {
        return Err(worker::Error::RustError(
            "task poll lease claim is invalid".to_string(),
        ));
    }
    let generation = task
        .poll_generation
        .checked_add(1)
        .ok_or_else(|| worker::Error::RustError("task poll generation exhausted".to_string()))?;
    let expires_at = now
        .checked_add(lease_seconds)
        .ok_or_else(|| worker::Error::RustError("task poll lease expiry overflow".to_string()))?;
    let expires_at_text = expires_at.to_string();
    let id = task.id.to_string();
    let expected_generation = task.poll_generation.to_string();
    let now_text = now.to_string();
    let args = [
        D1Type::Text(owner),
        D1Type::Text(&expires_at_text),
        D1Type::Text(&id),
        D1Type::Text(task.status.as_str()),
        D1Type::Text(&expected_generation),
        D1Type::Text(&now_text),
    ];
    let lease = TaskPollLease {
        owner: owner.to_string(),
        generation,
        expires_at,
    };
    let result = db
        .prepare(&format!(
            r#"
            UPDATE tasks
            SET poll_owner = ?1,
                poll_generation = poll_generation + 1,
                poll_lease_expires_at = CAST(?2 AS INTEGER),
                poll_attempt_count = poll_attempt_count + 1,
                poll_last_attempt_at = CAST(?6 AS INTEGER)
            WHERE id = CAST(?3 AS INTEGER)
              AND status = ?4
              AND poll_generation = CAST(?5 AS INTEGER)
              AND poll_lease_expires_at <= CAST(?6 AS INTEGER)
              AND status NOT IN ('SUCCESS', 'FAILURE')
              {}
            "#,
            if require_schedule_due {
                "AND next_poll_at <= CAST(?6 AS INTEGER) AND poll_quarantined_at = 0"
            } else {
                ""
            }
        ))
        .bind_refs(&args)?
        .run()
        .await;
    let result = match result {
        Ok(result) => result,
        Err(err) => {
            if task_poll_lease_claim_committed(db, task, &lease)
                .await
                .unwrap_or(false)
            {
                return Ok(Some(lease));
            }
            return Err(err);
        }
    };
    if result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) != 1 {
        return Ok(None);
    }
    Ok(Some(lease))
}

pub async fn release_task_poll_lease(
    db: &D1Database,
    task_id: i64,
    lease: &TaskPollLease,
) -> worker::Result<bool> {
    let task_id = task_id.to_string();
    let generation = lease.generation.to_string();
    let args = [
        D1Type::Text(&task_id),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&generation),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE tasks
            SET poll_owner = '', poll_lease_expires_at = 0
            WHERE id = CAST(?1 AS INTEGER)
              AND poll_owner = ?2
              AND poll_generation = CAST(?3 AS INTEGER)
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1)
}

pub(crate) fn task_poll_retry_delay_seconds(
    base_seconds: i64,
    max_seconds: i64,
    consecutive_failures: i64,
) -> i64 {
    if base_seconds <= 0 || max_seconds < base_seconds || consecutive_failures <= 0 {
        return 0;
    }
    let shift = u32::try_from(consecutive_failures.saturating_sub(1).min(30)).unwrap_or(30);
    base_seconds
        .saturating_mul(1_i64.checked_shl(shift).unwrap_or(i64::MAX))
        .min(max_seconds)
}

pub(crate) fn task_poll_retry_delay_seconds_with_jitter(
    base_seconds: i64,
    max_seconds: i64,
    consecutive_failures: i64,
    entity_key: &str,
    generation: i64,
) -> i64 {
    let delay = task_poll_retry_delay_seconds(base_seconds, max_seconds, consecutive_failures);
    if delay <= 0 || delay >= max_seconds || entity_key.is_empty() {
        return delay;
    }
    let remaining = max_seconds.saturating_sub(delay);
    let jitter_cap = base_seconds.saturating_div(4).max(1).min(remaining);
    let mut hasher = Sha256::new();
    hasher.update(b"cinatoken:task-poll-jitter:v1:");
    hasher.update(entity_key.as_bytes());
    hasher.update(b":");
    hasher.update(generation.to_le_bytes());
    let digest = hasher.finalize();
    let sample = u64::from_le_bytes(digest[..8].try_into().unwrap_or_default());
    let jitter = i64::try_from(sample % (jitter_cap as u64 + 1)).unwrap_or_default();
    delay.saturating_add(jitter).min(max_seconds)
}

fn valid_task_poll_error_code(error_code: &str) -> bool {
    !error_code.is_empty()
        && error_code.len() <= 64
        && error_code.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

pub async fn record_task_poll_failure(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    now: i64,
    retry_base_seconds: i64,
    retry_max_seconds: i64,
    max_consecutive_failures: i64,
    error_code: &str,
) -> worker::Result<TaskPollFailureOutcome> {
    if !valid_task_poll_error_code(error_code)
        || retry_base_seconds <= 0
        || retry_max_seconds < retry_base_seconds
        || max_consecutive_failures <= 0
    {
        return Err(worker::Error::RustError(
            "task poll failure policy is invalid".to_string(),
        ));
    }
    let consecutive_failures = task.poll_consecutive_failures.saturating_add(1);
    let quarantined = consecutive_failures >= max_consecutive_failures;
    let delay = task_poll_retry_delay_seconds_with_jitter(
        retry_base_seconds,
        retry_max_seconds,
        consecutive_failures,
        task.task_id.as_str(),
        lease.generation,
    );
    let next_poll_at = if quarantined {
        0
    } else {
        now.saturating_add(delay)
    };
    let id = task.id.to_string();
    let generation = lease.generation.to_string();
    let now_text = now.to_string();
    let failures_text = consecutive_failures.to_string();
    let next_poll_at_text = next_poll_at.to_string();
    let quarantined_at_text = if quarantined { now } else { 0 }.to_string();
    let quarantine_reason = if quarantined { error_code } else { "" };
    let args = [
        D1Type::Text(&failures_text),
        D1Type::Text(error_code),
        D1Type::Text(&next_poll_at_text),
        D1Type::Text(&quarantined_at_text),
        D1Type::Text(quarantine_reason),
        D1Type::Text(&generation),
        D1Type::Text(&id),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&now_text),
    ];
    let result = db
        .prepare(
            r#"
            UPDATE tasks
            SET poll_consecutive_failures = CAST(?1 AS INTEGER),
                poll_last_error_code = ?2,
                next_poll_at = CAST(?3 AS INTEGER),
                poll_quarantined_at = CAST(?4 AS INTEGER),
                poll_quarantine_reason = ?5,
                poll_owner = '', poll_lease_expires_at = 0,
                poll_applied_generation = CAST(?6 AS INTEGER),
                poll_write_revision = poll_write_revision + 1
            WHERE id = CAST(?7 AS INTEGER)
              AND poll_owner = ?8
              AND poll_generation = CAST(?6 AS INTEGER)
              AND poll_lease_expires_at > CAST(?9 AS INTEGER)
              AND poll_lease_expires_at > unixepoch()
              AND status NOT IN ('SUCCESS', 'FAILURE')
            "#,
        )
        .bind_refs(&args)?
        .run()
        .await;
    let changed = match result {
        Ok(result) => result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1,
        Err(err) => {
            if let Some(outcome) = read_task_poll_failure_outcome(db, task.id, lease).await? {
                return Ok(outcome);
            }
            return Err(err);
        }
    };
    Ok(TaskPollFailureOutcome {
        recorded: changed,
        quarantined: changed && quarantined,
        consecutive_failures: if changed { consecutive_failures } else { 0 },
        next_poll_at: if changed { next_poll_at } else { 0 },
    })
}

async fn read_task_poll_failure_outcome(
    db: &D1Database,
    task_id: i64,
    lease: &TaskPollLease,
) -> worker::Result<Option<TaskPollFailureOutcome>> {
    #[derive(Debug, Deserialize)]
    struct FailureRow {
        poll_owner: String,
        poll_applied_generation: i64,
        poll_consecutive_failures: i64,
        poll_quarantined_at: i64,
        next_poll_at: i64,
    }
    let task_id = task_id.to_string();
    let args = D1Type::Text(&task_id);
    let row = db
        .prepare(
            r#"
            SELECT poll_owner, poll_applied_generation, poll_consecutive_failures,
                   poll_quarantined_at, next_poll_at
            FROM tasks
            WHERE id = CAST(?1 AS INTEGER)
            "#,
        )
        .bind_refs(&args)?
        .first::<FailureRow>(None)
        .await?;
    Ok(row.and_then(|row| {
        (row.poll_owner.is_empty() && row.poll_applied_generation == lease.generation).then_some(
            TaskPollFailureOutcome {
                recorded: true,
                quarantined: row.poll_quarantined_at > 0,
                consecutive_failures: row.poll_consecutive_failures,
                next_poll_at: row.next_poll_at,
            },
        )
    }))
}

async fn task_poll_lease_is_current(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    applied_at: i64,
) -> worker::Result<bool> {
    #[derive(Debug, Deserialize)]
    struct CountRow {
        count: i64,
    }
    let id = task.id.to_string();
    let generation = lease.generation.to_string();
    let applied_at = applied_at.to_string();
    let args = [
        D1Type::Text(&id),
        D1Type::Text(task.status.as_str()),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&generation),
        D1Type::Text(&applied_at),
    ];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM tasks
            WHERE id = CAST(?1 AS INTEGER)
              AND status = ?2
              AND poll_owner = ?3
              AND poll_generation = CAST(?4 AS INTEGER)
              AND poll_lease_expires_at > CAST(?5 AS INTEGER)
              AND poll_lease_expires_at > unixepoch()
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count == 1).unwrap_or(false))
}

async fn task_poll_lease_claim_committed(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
) -> worker::Result<bool> {
    #[derive(Debug, Deserialize)]
    struct CountRow {
        count: i64,
    }
    let id = task.id.to_string();
    let generation = lease.generation.to_string();
    let expires_at = lease.expires_at.to_string();
    let args = [
        D1Type::Text(&id),
        D1Type::Text(task.status.as_str()),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&generation),
        D1Type::Text(&expires_at),
    ];
    let row = db
        .prepare(
            r#"
            SELECT COUNT(*) AS count
            FROM tasks
            WHERE id = CAST(?1 AS INTEGER)
              AND status = ?2
              AND poll_owner = ?3
              AND poll_generation = CAST(?4 AS INTEGER)
              AND poll_lease_expires_at = CAST(?5 AS INTEGER)
            "#,
        )
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count == 1).unwrap_or(false))
}

/// Conditional status transition guarded by the current status — a faithful
/// port of Go `Task.UpdateWithStatus(fromStatus)`.
///
/// Returns `Ok(true)` if this caller won (the row was in `from` and is now in
/// `to`), `Ok(false)` if another process already moved it out of `from`. The
/// guard makes the win unique, which is what callers rely on to settle billing
/// exactly once. Callers should treat a `false` return as "someone else already
/// transitioned this task" and skip the associated billing/refund side effect.
pub async fn update_task_status_cas(
    db: &D1Database,
    id: i64,
    lease: &TaskPollLease,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    next_poll_at: i64,
) -> worker::Result<bool> {
    let result = update_task_status_cas_statement(
        db,
        id,
        lease,
        from,
        to,
        fail_reason,
        progress,
        result_url,
        result_data,
        finish_time,
        updated_at,
        next_poll_at,
    )?
    .run()
    .await?;
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

fn update_task_status_cas_statement(
    db: &D1Database,
    id: i64,
    lease: &TaskPollLease,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    next_poll_at: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let should_update_data = if result_data.is_some() { 1 } else { 0 };
    let result_data = result_data.unwrap_or("");
    let generation = lease.generation.to_string();
    let next_poll_at = next_poll_at.to_string();
    let args = [
        D1Type::Text(to.as_str()),
        D1Type::Text(fail_reason),
        D1Type::Text(progress),
        D1Type::Text(result_url),
        D1Type::Text(result_data),
        D1Type::Integer(should_update_data),
        D1Type::Integer(d1_i32(finish_time)),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(from.as_str()),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&generation),
        D1Type::Text(&next_poll_at),
    ];
    // `json_set` merges the result URL into private_data (Go
    // `Task.PrivateData.ResultURL`) without clobbering the reserving token_id
    // stored there at insert. An empty URL is written as-is (fetch falls back
    // to fail_reason, matching Go `GetResultURL`).
    db.prepare(
        r#"
            UPDATE tasks
            SET status = ?1, fail_reason = ?2, progress = ?3,
                private_data = json_set(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.result_url',
                    ?4
                ),
                data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
                finish_time = ?7, updated_at = ?8,
                poll_owner = '', poll_lease_expires_at = 0,
                poll_applied_generation = CAST(?12 AS INTEGER),
                poll_write_revision = poll_write_revision + 1,
                next_poll_at = CASE
                    WHEN ?1 IN ('SUCCESS', 'FAILURE') THEN 0
                    ELSE CAST(?13 AS INTEGER)
                END,
                poll_consecutive_failures = 0,
                poll_last_error_code = '',
                poll_quarantined_at = 0,
                poll_quarantine_reason = ''
            WHERE id = ?9 AND status = ?10
              AND poll_owner = ?11
              AND poll_generation = CAST(?12 AS INTEGER)
              AND poll_lease_expires_at > ?8
              AND poll_lease_expires_at > unixepoch()
            "#,
    )
    .bind_refs(&args)
}

fn update_task_status_cas_with_refund_marker_statement(
    db: &D1Database,
    id: i64,
    lease: &TaskPollLease,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    refund_marker: &str,
    next_poll_at: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let should_update_data = if result_data.is_some() { 1 } else { 0 };
    let result_data = result_data.unwrap_or("");
    let generation = lease.generation.to_string();
    let next_poll_at = next_poll_at.to_string();
    let args = [
        D1Type::Text(to.as_str()),
        D1Type::Text(fail_reason),
        D1Type::Text(progress),
        D1Type::Text(result_url),
        D1Type::Text(result_data),
        D1Type::Integer(should_update_data),
        D1Type::Integer(d1_i32(finish_time)),
        D1Type::Integer(d1_i32(updated_at)),
        D1Type::Integer(d1_i32(id)),
        D1Type::Text(from.as_str()),
        D1Type::Text(refund_marker),
        D1Type::Text(lease.owner.as_str()),
        D1Type::Text(&generation),
        D1Type::Text(&next_poll_at),
    ];
    db.prepare(
        r#"
        UPDATE tasks
        SET status = ?1, fail_reason = ?2, progress = ?3,
            private_data = json_set(
                CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                '$.result_url',
                ?4,
                '$.task_refund_marker',
                ?11,
                '$.task_refund_done_at',
                NULL
            ),
            data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
            finish_time = ?7, updated_at = ?8,
            poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = CAST(?13 AS INTEGER),
            poll_write_revision = poll_write_revision + 1,
            next_poll_at = CASE
                WHEN ?1 IN ('SUCCESS', 'FAILURE') THEN 0
                ELSE CAST(?14 AS INTEGER)
            END,
            poll_consecutive_failures = 0,
            poll_last_error_code = '',
            poll_quarantined_at = 0,
            poll_quarantine_reason = ''
        WHERE id = ?9 AND status = ?10
          AND poll_owner = ?12
          AND poll_generation = CAST(?13 AS INTEGER)
          AND poll_lease_expires_at > ?8
          AND poll_lease_expires_at > unixepoch()
        "#,
    )
    .bind_refs(&args)
}

fn credit_user_task_refund_statement(
    db: &D1Database,
    task_id: i64,
    user_id: i64,
    quota: i32,
    refund_marker: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(user_id)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota + ?1
        WHERE id = ?2
          AND EXISTS (
              SELECT 1 FROM tasks
              WHERE id = ?3
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_marker'
                ) = ?4
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_done_at'
                ) IS NULL
          )
        "#,
    )
    .bind_refs(&args)
}

fn credit_token_task_refund_statement(
    db: &D1Database,
    task_id: i64,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
    refund_marker: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            accessed_time = ?2
        WHERE id = ?3
          AND EXISTS (
              SELECT 1 FROM tasks
              WHERE id = ?4
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_marker'
                ) = ?5
                AND json_extract(
                    CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                    '$.task_refund_done_at'
                ) IS NULL
          )
        "#,
    )
    .bind_refs(&args)
}

fn mark_task_refund_done_statement(
    db: &D1Database,
    task_id: i64,
    refund_marker: &str,
    done_at: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(d1_i32(done_at)),
        D1Type::Integer(d1_i32(task_id)),
        D1Type::Text(refund_marker),
    ];
    db.prepare(
        r#"
        UPDATE tasks
        SET private_data = json_set(
            CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
            '$.task_refund_done_at',
            ?1
        )
        WHERE id = ?2
          AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_marker'
          ) = ?3
          AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_done_at'
          ) IS NULL
        "#,
    )
    .bind_refs(&args)
}

fn refund_attached_task_billing_intent_statement(
    db: &D1Database,
    task: &TaskRow,
    terminal_status: TaskStatus,
    refunded_at: i64,
    refund_kind: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let reason = format!("terminal_{refund_kind}");
    let args = [
        D1Type::Integer(d1_i32(refunded_at)),
        D1Type::Text(&reason),
        D1Type::Text(task.billing_reservation_key.trim()),
        D1Type::Integer(d1_i32(task.id)),
        D1Type::Text(terminal_status.as_str()),
    ];
    db.prepare(
        r#"
        UPDATE task_billing_intents
        SET status = 'refunded',
            refunded_at = ?1,
            updated_at = ?1,
            owner_generation = owner_generation + 1,
            recovery_last_error = ?2
        WHERE reservation_key = ?3
          AND task_kind = 'task'
          AND status = 'attached'
          AND EXISTS (
            SELECT 1 FROM tasks
            WHERE id = ?4
              AND status = ?5
              AND json_extract(
                CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                '$.billing_reservation_key'
              ) = ?3
          )
        "#,
    )
    .bind_refs(&args)
}

pub(crate) fn assert_task_billing_previous_statement_statement(
    db: &D1Database,
    reservation_key: &str,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Text(reservation_key.trim())];
    db.prepare(
        r#"
        INSERT INTO task_billing_intents (
          reservation_key, task_kind, public_task_id, user_id, channel_id,
          billing_contract_json, billing_contract_sha256, lease_expires_at,
          provider_kind, provider_idempotency_key
        )
        SELECT ?1, 'task', ?1, 0, 0, '{}',
               '0000000000000000000000000000000000000000000000000000000000000000',
               1, 'batch_assertion', 'batch_assertion'
        WHERE changes() != 1
        "#,
    )
    .bind_refs(&args)
}

fn settle_attached_task_billing_intent_statement(
    db: &D1Database,
    task: &TaskRow,
    from: TaskStatus,
    to: TaskStatus,
    settled_at: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(d1_i32(settled_at)),
        D1Type::Text(task.billing_reservation_key.trim()),
        D1Type::Integer(d1_i32(task.id)),
        D1Type::Text(from.as_str()),
        D1Type::Text(to.as_str()),
    ];
    db.prepare(
        r#"
        UPDATE task_billing_intents
        SET status = 'settled',
            settled_at = ?1,
            updated_at = ?1,
            owner_generation = owner_generation + 1,
            recovery_last_error = ''
        WHERE reservation_key = ?2
          AND task_kind = 'task'
          AND status = 'attached'
          AND request_accounted = 1
          AND EXISTS (
            SELECT 1 FROM tasks
            WHERE id = ?3
              AND status = ?5
              AND status <> ?4
              AND json_extract(
                CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
                '$.billing_reservation_key'
              ) = ?2
          )
        "#,
    )
    .bind_refs(&args)
}

fn task_refund_marker(
    task_id: i64,
    from: TaskStatus,
    to: TaskStatus,
    kind: &str,
    now: i64,
) -> String {
    format!(
        "task-refund:{kind}:{task_id}:{}:{}:{now}",
        from.as_str(),
        to.as_str()
    )
}

fn task_refund_quota_i32(quota: i64) -> worker::Result<i32> {
    if quota < 0 {
        return Err(worker::Error::RustError(
            "task refund quota must be non-negative".to_string(),
        ));
    }
    i32::try_from(quota).map_err(|_| {
        worker::Error::RustError(format!(
            "task refund quota {quota} exceeds D1 integer binding range"
        ))
    })
}

pub(crate) fn task_batch_changed(
    results: &[worker::D1Result],
    index: usize,
) -> worker::Result<bool> {
    let Some(result) = results.get(index) else {
        return Err(worker::Error::RustError(format!(
            "missing D1 batch result at index {index}"
        )));
    };
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    Ok(changes == 1)
}

async fn update_task_status_cas_and_refund_batch(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    refund_kind: &str,
    next_poll_at: i64,
) -> worker::Result<bool> {
    let reservation_key = task.billing_reservation_key.trim();
    if !reservation_key.is_empty() {
        let statements = vec![
            update_task_status_cas_statement(
                db,
                task.id,
                lease,
                from,
                to,
                fail_reason,
                progress,
                result_url,
                result_data,
                finish_time,
                updated_at,
                next_poll_at,
            )?,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
            refund_attached_task_billing_intent_statement(db, task, to, updated_at, refund_kind)?,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
        ];
        let results = match db.batch(statements).await {
            Ok(results) => results,
            Err(err) => {
                if !task_poll_lease_is_current(db, task, lease, updated_at).await? {
                    return Ok(false);
                }
                return Err(err);
            }
        };
        return Ok(task_batch_changed(&results, 0)? && task_batch_changed(&results, 2)?);
    }

    let quota = task_refund_quota_i32(task.quota)?;
    if quota == 0 {
        return update_task_status_cas(
            db,
            task.id,
            lease,
            from,
            to,
            fail_reason,
            progress,
            result_url,
            result_data,
            finish_time,
            updated_at,
            next_poll_at,
        )
        .await;
    }

    let refund_marker = task_refund_marker(task.id, from, to, refund_kind, updated_at);
    let mut statements = vec![
        update_task_status_cas_with_refund_marker_statement(
            db,
            task.id,
            lease,
            from,
            to,
            fail_reason,
            progress,
            result_url,
            result_data,
            finish_time,
            updated_at,
            &refund_marker,
            next_poll_at,
        )?,
        assert_task_billing_previous_statement_statement(db, reservation_key)?,
        credit_user_task_refund_statement(db, task.id, task.user_id, quota, &refund_marker)?,
        assert_task_billing_previous_statement_statement(db, reservation_key)?,
    ];
    if task.token_id > 0 {
        statements.push(credit_token_task_refund_statement(
            db,
            task.id,
            task.token_id,
            quota,
            updated_at,
            &refund_marker,
        )?);
        statements.push(assert_task_billing_previous_statement_statement(
            db,
            reservation_key,
        )?);
    }
    let done_statement_index = statements.len();
    statements.push(mark_task_refund_done_statement(
        db,
        task.id,
        &refund_marker,
        updated_at,
    )?);
    statements.push(assert_task_billing_previous_statement_statement(
        db,
        reservation_key,
    )?);

    let results = match db.batch(statements).await {
        Ok(results) => results,
        Err(err) => {
            if !task_poll_lease_is_current(db, task, lease, updated_at).await? {
                return Ok(false);
            }
            return Err(err);
        }
    };
    let won = task_batch_changed(&results, 0)?;
    if won && !task_batch_changed(&results, done_statement_index)? {
        return Err(worker::Error::RustError(
            "task refund batch won CAS but did not mark refund done".to_string(),
        ));
    }
    Ok(won)
}

async fn update_task_status_cas_and_settle_intent_batch(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    from: TaskStatus,
    to: TaskStatus,
    fail_reason: &str,
    progress: &str,
    result_url: &str,
    result_data: Option<&str>,
    finish_time: i64,
    updated_at: i64,
    next_poll_at: i64,
) -> worker::Result<bool> {
    let reservation_key = task.billing_reservation_key.trim();
    if reservation_key.is_empty() {
        return update_task_status_cas(
            db,
            task.id,
            lease,
            from,
            to,
            fail_reason,
            progress,
            result_url,
            result_data,
            finish_time,
            updated_at,
            next_poll_at,
        )
        .await;
    }
    let results = match db
        .batch(vec![
            update_task_status_cas_statement(
                db,
                task.id,
                lease,
                from,
                to,
                fail_reason,
                progress,
                result_url,
                result_data,
                finish_time,
                updated_at,
                next_poll_at,
            )?,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
            settle_attached_task_billing_intent_statement(db, task, from, to, updated_at)?,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
        ])
        .await
    {
        Ok(results) => results,
        Err(err) => {
            if !task_poll_lease_is_current(db, task, lease, updated_at).await? {
                return Ok(false);
            }
            return Err(err);
        }
    };
    Ok(task_batch_changed(&results, 0)? && task_batch_changed(&results, 2)?)
}

pub(crate) fn task_refund_cas_batch_compiled() -> bool {
    TASK_REFUND_MARKER_PATH == "$.task_refund_marker"
        && TASK_REFUND_DONE_AT_PATH == "$.task_refund_done_at"
}

pub(crate) fn task_refund_replay_contract_compiled() -> bool {
    task_refund_cas_batch_compiled()
        && LEGACY_TASK_TIMEOUT_CUTOFF_UNIX == 1_740_182_400
        && task_refund_marker(
            42,
            TaskStatus::InProgress,
            TaskStatus::Failure,
            "timeout",
            100,
        ) == "task-refund:timeout:42:IN_PROGRESS:FAILURE:100"
}

/// A full task row for the client-facing fetch endpoints (Go `dto.TaskDto`
/// source fields). Distinct from the poller's lean [`TaskRow`].
#[derive(Debug, serde::Deserialize)]
pub struct TaskDtoRow {
    pub id: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub group: String,
    pub channel_id: i64,
    pub quota: i64,
    pub action: String,
    pub status: String,
    pub fail_reason: String,
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub progress: String,
    pub properties: String,
    pub username: String,
    pub data: String,
    pub private_data: String,
}

const TASK_DTO_COLUMNS: &str = r#"id, created_at, updated_at, task_id, platform, user_id,
    "group" AS "group", channel_id, quota, action, status, fail_reason,
    submit_time, start_time, finish_time, progress, properties, username, data,
    private_data"#;

/// One task by public task id, scoped to its owner (Go `GetByTaskId`).
pub async fn find_task_dto(
    db: &D1Database,
    user_id: i64,
    task_id: &str,
) -> worker::Result<Option<TaskDtoRow>> {
    let args = [D1Type::Integer(d1_i32(user_id)), D1Type::Text(task_id)];
    db.prepare(&format!(
        "SELECT {TASK_DTO_COLUMNS} FROM tasks WHERE user_id = ?1 AND task_id = ?2 LIMIT 1"
    ))
    .bind_refs(&args)?
    .first::<TaskDtoRow>(None)
    .await
}

/// The owner's tasks matching a set of public task ids (Go `GetByTaskIds`).
/// Chunked IN-list; order unspecified (Go's is too).
pub async fn find_task_dtos(
    db: &D1Database,
    user_id: i64,
    task_ids: &[String],
) -> worker::Result<Vec<TaskDtoRow>> {
    let mut rows = Vec::new();
    for chunk in task_ids.chunks(50) {
        let mut args: Vec<D1Type<'_>> = vec![D1Type::Integer(d1_i32(user_id))];
        for task_id in chunk {
            args.push(D1Type::Text(task_id));
        }
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let sql = format!(
            "SELECT {TASK_DTO_COLUMNS} FROM tasks WHERE user_id = ?1 AND task_id IN ({})",
            placeholders.join(", ")
        );
        rows.extend(
            db.prepare(&sql)
                .bind_refs(&args)?
                .all()
                .await?
                .results::<TaskDtoRow>()?,
        );
    }
    Ok(rows)
}

/// Filters shared by the admin (`GET /api/task`) and self (`GET /api/task/self`)
/// usage-log pages.
#[derive(Debug, Default)]
pub struct TaskListFilter {
    pub user_id: Option<i64>,
    pub channel_id: Option<i64>,
    pub platform: Option<String>,
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub action: Option<String>,
    pub start_timestamp: Option<String>,
    pub end_timestamp: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

/// List unified task rows for the dashboard usage-log tables. Mirrors Go
/// `TaskGetAllTasks` / `TaskGetAllUserTask`: optional platform/task/action/
/// status/time filters, admin-only channel filter, ordered newest first.
pub async fn list_tasks(
    db: &D1Database,
    filter: &TaskListFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<TaskDtoRow>> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = task_where_clause(filter, &mut args);
    let limit_idx = args.len() + 1;
    let offset_idx = args.len() + 2;
    let offset = ((page.max(1) - 1) as i64) * page_size as i64;
    args.push(D1Type::Integer(d1_i32(page_size as i64)));
    args.push(D1Type::Integer(d1_i32(offset)));
    let sql = format!(
        "SELECT {TASK_DTO_COLUMNS} FROM tasks{where_sql} ORDER BY id DESC LIMIT ?{limit_idx} OFFSET ?{offset_idx}"
    );
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<TaskDtoRow>()
}

/// Count unified task rows matching the usage-log filters.
pub async fn count_tasks(db: &D1Database, filter: &TaskListFilter) -> worker::Result<i64> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = task_where_clause(filter, &mut args);
    let sql = format!("SELECT COUNT(*) AS count FROM tasks{where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

fn task_where_clause<'a>(filter: &'a TaskListFilter, args: &mut Vec<D1Type<'a>>) -> String {
    let mut conditions = Vec::new();
    if let Some(user_id) = filter.user_id {
        args.push(D1Type::Integer(d1_i32(user_id)));
        conditions.push(format!("user_id = ?{}", args.len()));
    }
    if let Some(channel_id) = filter.channel_id {
        args.push(D1Type::Integer(d1_i32(channel_id)));
        conditions.push(format!("channel_id = ?{}", args.len()));
    }
    if let Some(platform) = filter.platform.as_deref() {
        args.push(D1Type::Text(platform));
        conditions.push(format!("platform = ?{}", args.len()));
    }
    if let Some(task_id) = filter.task_id.as_deref() {
        args.push(D1Type::Text(task_id));
        conditions.push(format!("task_id = ?{}", args.len()));
    }
    if let Some(status) = filter.status.as_deref() {
        args.push(D1Type::Text(status));
        conditions.push(format!("status = ?{}", args.len()));
    }
    if let Some(action) = filter.action.as_deref() {
        args.push(D1Type::Text(action));
        conditions.push(format!("action = ?{}", args.len()));
    }
    if let Some(start) = filter.start_timestamp.as_deref() {
        args.push(D1Type::Text(start));
        conditions.push(format!("submit_time >= ?{}", args.len()));
    }
    if let Some(end) = filter.end_timestamp.as_deref() {
        args.push(D1Type::Text(end));
        conditions.push(format!("submit_time <= ?{}", args.len()));
    }
    if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    }
}

// The pure settlement-detection guard a caller pairs with a CAS win lives in
// `cinatoken_tasks::is_settlement_transition` (host-tested there, since this
// wasm-only crate cannot run host unit tests).

pub(crate) fn task_timeout_reason(timeout_minutes: i64, legacy: bool) -> String {
    if legacy {
        LEGACY_TASK_TIMEOUT_REASON.to_string()
    } else {
        format!("任务超时（{timeout_minutes}分钟）")
    }
}

pub(crate) fn is_legacy_timeout_task(submit_time: i64) -> bool {
    submit_time > 0 && submit_time < LEGACY_TASK_TIMEOUT_CUTOFF_UNIX
}

fn suno_poll_target_status(
    from: TaskStatus,
    item_status: &str,
    item_fail_reason: &str,
) -> TaskStatus {
    if !item_fail_reason.is_empty() {
        TaskStatus::Failure
    } else if item_status.is_empty() {
        from
    } else {
        TaskStatus::from_status_str(item_status)
    }
}

/// Mark a timed-out task as failed through the same CAS guard used by the
/// poller. Non-legacy rows receive the same user+token reserve refund as Go
/// `sweepTimedOutTasks`; legacy imported rows intentionally skip refund.
pub async fn apply_task_timeout(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    timeout_minutes: i64,
    now: i64,
) -> worker::Result<bool> {
    let from = task.status();
    let legacy = is_legacy_timeout_task(task.submit_time);
    let reason = task_timeout_reason(timeout_minutes, legacy);
    if !legacy && (task.quota != 0 || !task.billing_reservation_key.trim().is_empty()) {
        return update_task_status_cas_and_refund_batch(
            db,
            task,
            lease,
            from,
            TaskStatus::Failure,
            &reason,
            "100%",
            "",
            None,
            now,
            now,
            "timeout",
            0,
        )
        .await;
    }
    let won = update_task_status_cas(
        db,
        task.id,
        lease,
        from,
        TaskStatus::Failure,
        &reason,
        "100%",
        "",
        None,
        now,
        now,
        0,
    )
    .await?;
    Ok(won)
}

/// Apply a parsed upstream poll result to a stored task: CAS its status from the
/// current value to the parsed one and, on a winning settlement transition,
/// refund the reserved quota for a terminal failure (Go `RefundTaskQuota`) or
/// keep the pre-charge for a success. Returns whether this caller won the
/// transition, so the orchestration knows it owns any one-time side effects.
///
/// The CAS guard makes this idempotent: a concurrent poller that already settled
/// the task wins the transition, and this call becomes a no-op that performs no
/// second refund. The pure decision (`settlement_for`) and the CAS semantics are
/// unit-tested in `cinatoken_tasks`; this function is the thin wasm I/O that
/// wires them to the D1 quota helpers and is verified by a staging poll.
pub async fn apply_poll_result(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    info: &TaskInfo,
    result_data: Option<&str>,
    finish_time: i64,
    now: i64,
    next_poll_at: i64,
) -> worker::Result<bool> {
    let from = task.status();
    match settlement_for(from, info.status) {
        TaskSettlement::Refund
            if task.quota != 0 || !task.billing_reservation_key.trim().is_empty() =>
        {
            return update_task_status_cas_and_refund_batch(
                db,
                task,
                lease,
                from,
                info.status,
                &info.reason,
                &info.progress,
                &info.url,
                result_data,
                finish_time,
                now,
                "poll",
                next_poll_at,
            )
            .await;
        }
        TaskSettlement::Keep if !task.billing_reservation_key.trim().is_empty() => {
            return update_task_status_cas_and_settle_intent_batch(
                db,
                task,
                lease,
                from,
                info.status,
                &info.reason,
                &info.progress,
                &info.url,
                result_data,
                finish_time,
                now,
                next_poll_at,
            )
            .await;
        }
        _ => {}
    }
    let won = update_task_status_cas(
        db,
        task.id,
        lease,
        from,
        info.status,
        &info.reason,
        &info.progress,
        &info.url,
        result_data,
        finish_time,
        now,
        next_poll_at,
    )
    .await?;
    Ok(won)
}

/// Apply one Suno batch-poll item to a stored task — a port of the per-item merge
/// in Go `updateSunoTasks`. The upstream status (empty keeps the current one,
/// Go's `lo.If(!= "")`) is CAS-applied; the progress is pinned to `100%` on
/// success or failure; and the reserve is refunded when the item is a failure
/// (`fail_reason` set **or** status `FAILURE`) and this caller wins a transition
/// out of a non-terminal state — so the CAS guard makes the refund happen once.
///
/// Simplification vs Go: submit/start times and the `data` blob aren't merged
/// here (display-only); the status/progress/fail-reason/finish-time + refund —
/// the billing-critical core — are. Returns whether this caller won the CAS.
pub async fn apply_suno_poll_result(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    item_status: &str,
    item_fail_reason: &str,
    now: i64,
    next_poll_at: i64,
) -> worker::Result<bool> {
    let from = task.status();
    let to = suno_poll_target_status(from, item_status, item_fail_reason);
    let is_failure = !item_fail_reason.is_empty() || to == TaskStatus::Failure;
    let progress = if is_failure || to == TaskStatus::Success {
        "100%"
    } else {
        task.progress.as_str()
    };
    let finish_time = if is_failure || to.is_terminal() {
        now
    } else {
        0
    };

    if is_failure
        && !from.is_terminal()
        && (task.quota != 0 || !task.billing_reservation_key.trim().is_empty())
    {
        return update_task_status_cas_and_refund_batch(
            db,
            task,
            lease,
            from,
            to,
            item_fail_reason,
            progress,
            "",
            None,
            finish_time,
            now,
            "suno",
            next_poll_at,
        )
        .await;
    }

    if to == TaskStatus::Success
        && !from.is_terminal()
        && !task.billing_reservation_key.trim().is_empty()
    {
        return update_task_status_cas_and_settle_intent_batch(
            db,
            task,
            lease,
            from,
            to,
            item_fail_reason,
            progress,
            "",
            None,
            finish_time,
            now,
            next_poll_at,
        )
        .await;
    }

    let won = update_task_status_cas(
        db,
        task.id,
        lease,
        from,
        to,
        item_fail_reason,
        progress,
        "",
        None,
        finish_time,
        now,
        next_poll_at,
    )
    .await?;
    Ok(won)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_poll_retry_backoff_is_bounded_and_scheduler_contract_is_compiled() {
        assert_eq!(task_poll_retry_delay_seconds(15, 900, 1), 15);
        assert_eq!(task_poll_retry_delay_seconds(15, 900, 2), 30);
        assert_eq!(task_poll_retry_delay_seconds(15, 900, 7), 900);
        assert_eq!(task_poll_retry_delay_seconds(15, 900, 99), 900);
        assert_eq!(task_poll_retry_delay_seconds(0, 900, 1), 0);
        let jittered = task_poll_retry_delay_seconds_with_jitter(15, 900, 2, "task_abc", 7);
        assert!((30..=33).contains(&jittered));
        assert_eq!(
            jittered,
            task_poll_retry_delay_seconds_with_jitter(15, 900, 2, "task_abc", 7)
        );
        assert_eq!(
            task_poll_retry_delay_seconds_with_jitter(15, 900, 99, "task_abc", 7),
            900
        );
        assert!(task_poll_scheduler_contract_compiled());
    }

    #[test]
    fn timeout_reason_matches_go_legacy_and_current_rows() {
        assert_eq!(task_timeout_reason(1_440, false), "任务超时（1440分钟）");
        assert_eq!(
            task_timeout_reason(1_440, true),
            "任务超时（旧系统遗留任务，不进行退款，请联系管理员）"
        );
    }

    #[test]
    fn legacy_timeout_cutoff_matches_go_constant() {
        assert!(is_legacy_timeout_task(LEGACY_TASK_TIMEOUT_CUTOFF_UNIX - 1));
        assert!(!is_legacy_timeout_task(LEGACY_TASK_TIMEOUT_CUTOFF_UNIX));
        assert!(!is_legacy_timeout_task(0));
    }

    #[test]
    fn task_refund_batch_markers_are_namespaced_and_compiled() {
        assert!(task_refund_cas_batch_compiled());
        assert!(task_refund_replay_contract_compiled());
        assert_eq!(TASK_REFUND_MARKER_PATH, "$.task_refund_marker");
        assert_eq!(TASK_REFUND_DONE_AT_PATH, "$.task_refund_done_at");
        assert_eq!(
            task_refund_marker(
                42,
                TaskStatus::Submitted,
                TaskStatus::Failure,
                "timeout",
                1_783_408_664
            ),
            "task-refund:timeout:42:SUBMITTED:FAILURE:1783408664"
        );
    }

    #[test]
    fn suno_fail_reason_forces_terminal_failure_status() {
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "", "upstream failed"),
            TaskStatus::Failure
        );
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "", ""),
            TaskStatus::InProgress
        );
        assert_eq!(
            suno_poll_target_status(TaskStatus::InProgress, "SUCCESS", ""),
            TaskStatus::Success
        );
    }

    #[test]
    fn task_billing_sweep_recovers_confirmed_pre_provider_rejections() {
        assert!(TASK_BILLING_INTENT_SWEEP_SELECT.contains("'prepared'"));
        assert!(TASK_BILLING_INTENT_SWEEP_SELECT.contains("'submitting'"));
        assert!(TASK_BILLING_INTENT_SWEEP_SELECT.contains("'rejected'"));
    }
}
