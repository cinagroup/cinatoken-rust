//! Operator surface for the default-off Container reconciliation observer.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_root_auth, require_secure_verification,
};
use crate::container_reconciliation::{
    container_reconciliation_observer_compiled, container_reconciliation_scan_limit,
    CONTAINER_RECONCILIATION_DEAD_LETTER_REASONS,
};
use crate::container_scheduler::container_operation_runtime_status;
use crate::d1_repositories::{
    apply_relay_container_reconciliation_retry, list_relay_container_reconciliation_observations,
    relay_container_reconciliation_class_counts,
    relay_container_reconciliation_observation_by_sequence,
    relay_container_reconciliation_retry_event, relay_container_reconciliation_retry_schema_ready,
    relay_container_reconciliation_runtime_snapshot, relay_container_reconciliation_schema_ready,
    RelayContainerReconciliationClassCount, RelayContainerReconciliationObservationRow,
    RelayContainerReconciliationRetryEvent, RelayContainerReconciliationRetryMutationError,
    RelayContainerReconciliationRetryMutationOutcome, RelayContainerReconciliationRuntimeSnapshot,
    RELAY_CONTAINER_RECONCILIATION_CLASSES, RELAY_CONTAINER_RECONCILIATION_RETRY_MIGRATION,
    RELAY_CONTAINER_RECONCILIATION_STATUSES,
};

const CONTRACT_VERSION: u32 = 1;
const DEFAULT_LIST_LIMIT: i64 = 20;
const MAX_LIST_LIMIT: i64 = 50;
const OPERATION_REFERENCE_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-operation-reference:v1\0";
const RECONCILIATION_REFERENCE_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-identity-reference:v1\0";
const CURSOR_REFERENCE_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-cursor-reference:v1\0";
const TARGET_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-target:v1\0";
const EVIDENCE_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-retry-evidence:v1\0";
const PREVIEW_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-retry-preview:v1\0";
const IDEMPOTENCY_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-retry-idempotency:v1\0";
const RESOLUTION_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-retry-resolution:v1\0";
const RESOLUTION_REFERENCE_DOMAIN: &[u8] =
    b"cinatoken:container-reconciliation-retry-resolution-reference:v1\0";
const DECISION_DOMAIN: &[u8] = b"cinatoken:container-reconciliation-retry-decision:v1\0";
const TARGET_PREFIX: &str = "ctrec1";
const EVIDENCE_REFERENCE_MAX_LEN: usize = 128;
const IDEMPOTENCY_KEY_MAX_LEN: usize = 96;
const MIN_RETRY_MARGIN_SECONDS: i64 = 60;
pub(crate) const CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED_ENV: &str =
    "CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED";

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationStatusResponse {
    contract_version: u32,
    observer_compiled: bool,
    schema_ready: bool,
    runtime_enabled: bool,
    retry_preview_compiled: bool,
    retry_apply_compiled: bool,
    retry_apply_schema_ready: bool,
    retry_apply_enabled: bool,
    scan_limit: i64,
    scan: Option<ReconciliationScanStatus>,
    run: Option<ReconciliationRunStatus>,
    observations: Option<ReconciliationObservationCounts>,
    classes: Vec<ReconciliationClassCount>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationScanStatus {
    generation: i64,
    in_progress: bool,
    cursor_created_at: Option<i64>,
    cursor_reference: Option<String>,
    high_watermark_created_at: Option<i64>,
    high_watermark_reference: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationRunStatus {
    generation: i64,
    owner_present: bool,
    active: bool,
    lease_expires_at: Option<i64>,
    last_started_at: Option<i64>,
    last_completed_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error_code: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationObservationCounts {
    total: i64,
    pending: i64,
    leased: i64,
    retry: i64,
    converged: i64,
    dead_letter: i64,
    due: i64,
    expired_leases: i64,
    oldest_due_at: Option<i64>,
    latest_observed_at: Option<i64>,
    latest_updated_at: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationClassCount {
    class: String,
    count: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationListResponse {
    contract_version: u32,
    count: usize,
    next_cursor: Option<String>,
    status_filter: Option<String>,
    class_filter: Option<String>,
    records: Vec<ReconciliationRecord>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct ReconciliationRecord {
    target: String,
    operation_reference: String,
    reconciliation_reference: Option<String>,
    operation_created_at: i64,
    owner_generation: i64,
    status: String,
    class: Option<String>,
    last_error_code: Option<String>,
    claim_generation: i64,
    attempt_count: i64,
    consecutive_failures: i64,
    due: bool,
    lease_active: bool,
    lease_expired: bool,
    available_at: Option<i64>,
    lease_expires_at: Option<i64>,
    first_observed_at: Option<i64>,
    last_attempt_at: Option<i64>,
    last_observed_at: Option<i64>,
    recovery_deadline_at: i64,
    converged_at: Option<i64>,
    dead_lettered_at: Option<i64>,
    dead_letter_reason: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RetryPreviewReason {
    InfrastructureRecovered,
    StorageRepaired,
    ControllerReconciled,
    OperatorReinspectionApproved,
}

impl RetryPreviewReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::InfrastructureRecovered => "infrastructure_recovered",
            Self::StorageRepaired => "storage_repaired",
            Self::ControllerReconciled => "controller_reconciled",
            Self::OperatorReinspectionApproved => "operator_reinspection_approved",
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RetryPreviewDecision {
    reason: RetryPreviewReason,
    evidence_reference: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetryApplyRequest {
    reason: RetryPreviewReason,
    evidence_reference: String,
    preview_token: String,
    idempotency_key: String,
    confirm_reobserve: bool,
}

impl RetryApplyRequest {
    fn decision(&self) -> RetryPreviewDecision {
        RetryPreviewDecision {
            reason: self.reason,
            evidence_reference: self.evidence_reference.clone(),
        }
    }
}

impl RetryPreviewDecision {
    fn validate(&self) -> Result<(), &'static str> {
        if !valid_evidence_reference(&self.evidence_reference) {
            return Err("Container reconciliation evidence_reference is invalid");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RetryPreviewResponse {
    contract_version: u32,
    target: String,
    operation_reference: String,
    reconciliation_reference: Option<String>,
    owner_generation: i64,
    status: String,
    class: String,
    last_error_code: Option<String>,
    claim_generation: i64,
    attempt_count: i64,
    consecutive_failures: i64,
    recovery_deadline_at: i64,
    dead_lettered_at: i64,
    dead_letter_reason: String,
    action: &'static str,
    reason: RetryPreviewReason,
    evidence_sha256: String,
    candidate_retryable: bool,
    apply_compiled: bool,
    apply_enabled: bool,
    apply_blocker: &'static str,
    step_up_required_for_apply: bool,
    observer_state_mutation_only: bool,
    provider_retry_allowed: bool,
    operation_mutation_allowed: bool,
    financial_mutation_allowed: bool,
    durable_object_mutation_allowed: bool,
    r2_mutation_allowed: bool,
    preview_token: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RetryApplyResponse {
    contract_version: u32,
    target: String,
    resolution_reference: String,
    action: &'static str,
    status: &'static str,
    scheduled_at: i64,
    observer_state_mutation_only: bool,
    provider_retry_allowed: bool,
    operation_mutation_allowed: bool,
    financial_mutation_allowed: bool,
    durable_object_mutation_allowed: bool,
    r2_mutation_allowed: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedTarget {
    observation_sequence: i64,
    digest: String,
}

#[derive(Debug, PartialEq, Eq)]
struct ReconciliationListQuery {
    before_sequence: i64,
    status: String,
    class: String,
    limit: i64,
}

fn retry_preview_compiled() -> bool {
    CONTRACT_VERSION == 1
        && TARGET_PREFIX == "ctrec1"
        && EVIDENCE_REFERENCE_MAX_LEN == 128
        && CONTAINER_RECONCILIATION_DEAD_LETTER_REASONS.len() == 6
}

fn retry_apply_compiled() -> bool {
    retry_preview_compiled()
        && RELAY_CONTAINER_RECONCILIATION_RETRY_MIGRATION
            == "0045_relay_container_reconciliation_retry_apply.sql"
}

pub(crate) fn retry_apply_enabled(env: &Env) -> bool {
    env.var(CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED_ENV)
        .ok()
        .is_some_and(|value| value.to_string() == "true")
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return no_store(response);
    }
    let runtime_enabled = container_operation_runtime_status(&env).operation_reconciliation_enabled;
    let retry_apply_enabled = retry_apply_enabled(&env);
    let scan_limit = container_reconciliation_scan_limit(&env);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation status: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    let schema_ready = match relay_container_reconciliation_schema_ready(&db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("container reconciliation status schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    if !schema_ready {
        return no_store(envelope_ok_response(&ReconciliationStatusResponse {
            contract_version: CONTRACT_VERSION,
            observer_compiled: container_reconciliation_observer_compiled(),
            schema_ready: false,
            runtime_enabled,
            retry_preview_compiled: retry_preview_compiled(),
            retry_apply_compiled: retry_apply_compiled(),
            retry_apply_schema_ready: false,
            retry_apply_enabled,
            scan_limit,
            scan: None,
            run: None,
            observations: None,
            classes: Vec::new(),
        })?);
    }
    let retry_apply_schema_ready =
        match relay_container_reconciliation_retry_schema_ready(&db).await {
            Ok(ready) => ready,
            Err(err) => {
                worker::console_error!(
                    "container reconciliation retry apply schema probe failed: {err}"
                );
                return no_store(envelope_error_response(
                    503,
                    "Container reconciliation status is unavailable",
                ));
            }
        };
    let now = crate::admin::unix_timestamp();
    let snapshot = match relay_container_reconciliation_runtime_snapshot(&db, now).await {
        Ok(snapshot) => snapshot,
        Err(err) => {
            worker::console_error!("container reconciliation status snapshot failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    let classes = match relay_container_reconciliation_class_counts(&db).await {
        Ok(classes) => classes,
        Err(err) => {
            worker::console_error!("container reconciliation class summary failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation status is unavailable",
            ));
        }
    };
    if !status_contract_valid(&snapshot, &classes) {
        worker::console_error!("container reconciliation status contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation status is unavailable",
        ));
    }
    no_store(envelope_ok_response(&status_response(
        runtime_enabled,
        retry_apply_schema_ready,
        retry_apply_enabled,
        scan_limit,
        now,
        &snapshot,
        classes,
    ))?)
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let query = match reconciliation_list_query(&req) {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation list: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    };
    match relay_container_reconciliation_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container reconciliation schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!("container reconciliation list schema probe failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    }
    let mut rows = match list_relay_container_reconciliation_observations(
        &db,
        query.before_sequence,
        &query.status,
        &query.class,
        query.limit.saturating_add(1),
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("container reconciliation observation list failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation observations are unavailable",
            ));
        }
    };
    if rows.iter().any(|row| !observation_contract_valid(row)) {
        worker::console_error!("container reconciliation observation contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation observations are unavailable",
        ));
    }
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|row| row.observation_sequence.to_string())
    } else {
        None
    };
    let now = crate::admin::unix_timestamp();
    let records = rows
        .into_iter()
        .map(|row| reconciliation_record(row, now))
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&ReconciliationListResponse {
        contract_version: CONTRACT_VERSION,
        count: records.len(),
        next_cursor,
        status_filter: (!query.status.is_empty()).then_some(query.status),
        class_filter: (!query.class.is_empty()).then_some(query.class),
        records,
    })?)
}

pub async fn retry_preview(
    mut req: Request,
    env: Env,
    target: Option<String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let (target, parsed_target) =
        match target.and_then(|value| parse_target(&value).map(|parsed| (value, parsed))) {
            Some(target) => target,
            None => {
                return no_store(envelope_error_response(
                    400,
                    "Invalid Container reconciliation target",
                ));
            }
        };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let decision = match serde_json::from_value::<RetryPreviewDecision>(body) {
        Ok(decision) => decision,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid Container reconciliation retry preview request",
            ));
        }
    };
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation retry preview: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry preview is unavailable",
            ));
        }
    };
    match relay_container_reconciliation_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container reconciliation schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!(
                "container reconciliation retry preview schema probe failed: {err}"
            );
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry preview is unavailable",
            ));
        }
    }
    let row = match relay_container_reconciliation_observation_by_sequence(
        &db,
        parsed_target.observation_sequence,
    )
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Container reconciliation target was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("container reconciliation retry preview lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry preview is unavailable",
            ));
        }
    };
    if !observation_contract_valid(&row) {
        worker::console_error!("container reconciliation retry preview contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation retry preview is unavailable",
        ));
    }
    if !constant_time_eq(&parsed_target.digest, &observation_target_digest(&row)) {
        return no_store(envelope_error_response(
            404,
            "Container reconciliation target was not found",
        ));
    }
    if row.status != "dead_letter" {
        return no_store(envelope_error_response(
            409,
            "Container reconciliation observation is already managed by the observer",
        ));
    }
    if !retry_preview_contract_valid(&row) {
        worker::console_error!("container reconciliation dead-letter contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation retry preview is unavailable",
        ));
    }
    no_store(envelope_ok_response(&prepare_retry_preview(
        &target,
        &row,
        decision,
        retry_apply_enabled(&env),
        crate::admin::unix_timestamp(),
    ))?)
}

pub async fn retry_apply(
    mut req: Request,
    env: Env,
    target: Option<String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    if !retry_apply_enabled(&env) {
        return no_store(envelope_error_response(
            403,
            "Container reconciliation retry apply is disabled",
        ));
    }
    let (target, parsed_target) =
        match target.and_then(|value| parse_target(&value).map(|parsed| (value, parsed))) {
            Some(target) => target,
            None => {
                return no_store(envelope_error_response(
                    400,
                    "Invalid Container reconciliation target",
                ));
            }
        };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let apply = match serde_json::from_value::<RetryApplyRequest>(body) {
        Ok(apply) => apply,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid Container reconciliation retry apply request",
            ));
        }
    };
    let decision = apply.decision();
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    if !apply.confirm_reobserve {
        return no_store(envelope_error_response(
            400,
            "Container reconciliation retry apply requires confirm_reobserve=true",
        ));
    }
    if !valid_lower_hex(&apply.preview_token, 64) || !valid_idempotency_key(&apply.idempotency_key)
    {
        return no_store(envelope_error_response(
            400,
            "Invalid Container reconciliation retry preview or idempotency key",
        ));
    }
    let idempotency_sha256 = reference(IDEMPOTENCY_DOMAIN, &apply.idempotency_key);
    let resolution_key = retry_resolution_key(&target, &apply.preview_token, &idempotency_sha256);
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("container reconciliation retry apply: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply is unavailable",
            ));
        }
    };
    match relay_container_reconciliation_retry_schema_ready(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply schema is not ready",
            ));
        }
        Err(err) => {
            worker::console_error!(
                "container reconciliation retry apply schema probe failed: {err}"
            );
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply is unavailable",
            ));
        }
    }
    match relay_container_reconciliation_retry_event(&db, &resolution_key).await {
        Ok(Some(event))
            if event.observation_sequence == parsed_target.observation_sequence
                && constant_time_eq(&event.preview_token, &apply.preview_token)
                && constant_time_eq(&event.idempotency_sha256, &idempotency_sha256) =>
        {
            return retry_apply_result(target, &resolution_key, "duplicate", event.scheduled_at);
        }
        Ok(Some(_)) => {
            return no_store(envelope_error_response(
                409,
                "Container reconciliation retry idempotency identity conflicts",
            ));
        }
        Ok(None) => {}
        Err(err) => {
            worker::console_error!("container reconciliation retry event lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply is unavailable",
            ));
        }
    }
    let row = match relay_container_reconciliation_observation_by_sequence(
        &db,
        parsed_target.observation_sequence,
    )
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Container reconciliation target was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("container reconciliation retry apply lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply is unavailable",
            ));
        }
    };
    if !observation_contract_valid(&row) {
        worker::console_error!("container reconciliation retry apply observation is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation retry apply is unavailable",
        ));
    }
    if !constant_time_eq(&parsed_target.digest, &observation_target_digest(&row)) {
        return no_store(envelope_error_response(
            404,
            "Container reconciliation target was not found",
        ));
    }
    if row.status != "dead_letter" {
        return no_store(envelope_error_response(
            409,
            "Container reconciliation observation is already managed by the observer",
        ));
    }
    if !retry_preview_contract_valid(&row) {
        worker::console_error!("container reconciliation retry apply contract is invalid");
        return no_store(envelope_error_response(
            503,
            "Container reconciliation retry apply is unavailable",
        ));
    }
    let now = crate::admin::unix_timestamp();
    let prepared = prepare_retry_preview(&target, &row, decision, true, now);
    if !prepared.candidate_retryable {
        return no_store(envelope_error_response(
            409,
            "Container reconciliation retry horizon is exhausted",
        ));
    }
    if !constant_time_eq(&apply.preview_token, &prepared.preview_token) {
        return no_store(envelope_error_response(
            409,
            "Container reconciliation retry preview is stale",
        ));
    }
    let (created_at, scheduled_at) = retry_schedule(&row, now);
    let evidence_sha256 = evidence_digest(&apply.evidence_reference);
    let decision_json = json!({
        "contract_version": CONTRACT_VERSION,
        "target": target,
        "operation_reference": prepared.operation_reference,
        "reconciliation_reference": prepared.reconciliation_reference,
        "operation_created_at": row.operation_created_at,
        "owner_generation": row.owner_generation,
        "status": row.status,
        "class": row.last_class,
        "last_error_code": row.last_error_code,
        "claim_generation": row.claim_generation,
        "attempt_count": row.attempt_count,
        "consecutive_failures": row.consecutive_failures,
        "first_observed_at": row.first_observed_at,
        "last_attempt_at": row.last_attempt_at,
        "last_observed_at": row.last_observed_at,
        "recovery_deadline_at": row.recovery_deadline_at,
        "dead_lettered_at": row.dead_lettered_at,
        "dead_letter_reason": row.dead_letter_reason,
        "updated_at": row.updated_at,
        "action": "reobserve_container_state",
        "reason": apply.reason.as_str(),
        "evidence_sha256": evidence_sha256,
        "preview_token": apply.preview_token,
    });
    let decision_sha256 = reference(DECISION_DOMAIN, &decision_json.to_string());
    let event = RelayContainerReconciliationRetryEvent {
        resolution_key: &resolution_key,
        observation_sequence: row.observation_sequence,
        operation_id: &row.operation_id,
        operation_created_at: row.operation_created_at,
        owner_generation: row.owner_generation,
        reconciliation_id: &row.reconciliation_id,
        expected_claim_generation: row.claim_generation,
        expected_attempt_count: row.attempt_count,
        expected_consecutive_failures: row.consecutive_failures,
        expected_first_observed_at: row.first_observed_at,
        expected_last_attempt_at: row.last_attempt_at,
        expected_last_observed_at: row.last_observed_at,
        expected_last_class: &row.last_class,
        expected_last_error_code: &row.last_error_code,
        expected_recovery_deadline_at: row.recovery_deadline_at,
        expected_dead_lettered_at: row.dead_lettered_at,
        expected_dead_letter_reason: &row.dead_letter_reason,
        expected_updated_at: row.updated_at,
        reason: apply.reason.as_str(),
        evidence_reference: &apply.evidence_reference,
        evidence_sha256: &evidence_sha256,
        preview_token: &apply.preview_token,
        idempotency_sha256: &idempotency_sha256,
        decision_sha256: &decision_sha256,
        operator_id: claims.id,
        scheduled_at,
        created_at,
    };
    let params = json!({
        "target": target,
        "operation_reference": prepared.operation_reference,
        "reconciliation_reference": prepared.reconciliation_reference,
        "owner_generation": row.owner_generation,
        "claim_generation": row.claim_generation,
        "attempt_count": row.attempt_count,
        "dead_lettered_at": row.dead_lettered_at,
        "dead_letter_reason": row.dead_letter_reason,
        "reason": apply.reason.as_str(),
        "evidence_sha256": evidence_sha256,
        "preview_token": apply.preview_token,
        "idempotency_sha256": idempotency_sha256,
        "decision_sha256": decision_sha256,
        "resolution_reference": reference(RESOLUTION_REFERENCE_DOMAIN, &resolution_key),
        "scheduled_at": scheduled_at,
        "observer_state_mutation_only": true,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = crate::d1_repositories::admin_audit_log_statement(
        &db,
        None,
        None,
        &claims.username,
        "container_reconciliation.retry_requeued",
        "Requeued a dead-lettered Container reconciliation observation",
        &params,
        &admin_info,
        created_at,
    )?;
    let outcome = match apply_relay_container_reconciliation_retry(&db, &event, admin_audit).await {
        Ok(outcome) => outcome,
        Err(RelayContainerReconciliationRetryMutationError::Conflict) => {
            return no_store(envelope_error_response(
                409,
                "Container reconciliation observation changed after preview",
            ));
        }
        Err(RelayContainerReconciliationRetryMutationError::Unavailable(err)) => {
            worker::console_error!("container reconciliation retry mutation failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Container reconciliation retry apply is unavailable",
            ));
        }
    };
    match outcome {
        RelayContainerReconciliationRetryMutationOutcome::Applied => {
            retry_apply_result(target, &resolution_key, "applied", scheduled_at)
        }
        RelayContainerReconciliationRetryMutationOutcome::Duplicate => {
            match relay_container_reconciliation_retry_event(&db, &resolution_key).await {
                Ok(Some(applied))
                    if applied.observation_sequence == row.observation_sequence
                        && applied.operation_id == row.operation_id
                        && constant_time_eq(&applied.preview_token, &apply.preview_token)
                        && constant_time_eq(&applied.idempotency_sha256, &idempotency_sha256)
                        && constant_time_eq(&applied.decision_sha256, &decision_sha256) =>
                {
                    retry_apply_result(target, &resolution_key, "duplicate", applied.scheduled_at)
                }
                Ok(Some(_)) => no_store(envelope_error_response(
                    409,
                    "Container reconciliation retry duplicate readback is inconsistent",
                )),
                Ok(None) | Err(_) => no_store(envelope_error_response(
                    503,
                    "Container reconciliation retry duplicate readback is unavailable",
                )),
            }
        }
    }
}

fn retry_apply_result(
    target: String,
    resolution_key: &str,
    status: &'static str,
    scheduled_at: i64,
) -> WorkerResult<Response> {
    no_store(envelope_ok_response(&RetryApplyResponse {
        contract_version: CONTRACT_VERSION,
        target,
        resolution_reference: reference(RESOLUTION_REFERENCE_DOMAIN, resolution_key),
        action: "reobserve_container_state",
        status,
        scheduled_at,
        observer_state_mutation_only: true,
        provider_retry_allowed: false,
        operation_mutation_allowed: false,
        financial_mutation_allowed: false,
        durable_object_mutation_allowed: false,
        r2_mutation_allowed: false,
    })?)
}

fn status_response(
    runtime_enabled: bool,
    retry_apply_schema_ready: bool,
    retry_apply_enabled: bool,
    scan_limit: i64,
    now: i64,
    snapshot: &RelayContainerReconciliationRuntimeSnapshot,
    classes: Vec<RelayContainerReconciliationClassCount>,
) -> ReconciliationStatusResponse {
    let scan_in_progress = snapshot.round_high_created_at > 0
        && (snapshot.last_created_at < snapshot.round_high_created_at
            || (snapshot.last_created_at == snapshot.round_high_created_at
                && snapshot.last_reservation_key < snapshot.round_high_reservation_key));
    let owner_present = !snapshot.run_owner.is_empty();
    ReconciliationStatusResponse {
        contract_version: CONTRACT_VERSION,
        observer_compiled: container_reconciliation_observer_compiled(),
        schema_ready: true,
        runtime_enabled,
        retry_preview_compiled: retry_preview_compiled(),
        retry_apply_compiled: retry_apply_compiled(),
        retry_apply_schema_ready,
        retry_apply_enabled,
        scan_limit,
        scan: Some(ReconciliationScanStatus {
            generation: snapshot.scan_generation,
            in_progress: scan_in_progress,
            cursor_created_at: positive(snapshot.last_created_at),
            cursor_reference: cursor_reference(
                snapshot.last_created_at,
                &snapshot.last_reservation_key,
            ),
            high_watermark_created_at: positive(snapshot.round_high_created_at),
            high_watermark_reference: cursor_reference(
                snapshot.round_high_created_at,
                &snapshot.round_high_reservation_key,
            ),
        }),
        run: Some(ReconciliationRunStatus {
            generation: snapshot.run_generation,
            owner_present,
            active: owner_present && snapshot.run_lease_expires_at > now,
            lease_expires_at: owner_present.then_some(snapshot.run_lease_expires_at),
            last_started_at: positive(snapshot.last_started_at),
            last_completed_at: positive(snapshot.last_completed_at),
            last_success_at: positive(snapshot.last_success_at),
            last_error_code: optional_text(&snapshot.last_error_code),
        }),
        observations: Some(ReconciliationObservationCounts {
            total: snapshot.total_count,
            pending: snapshot.pending_count,
            leased: snapshot.leased_count,
            retry: snapshot.retry_count,
            converged: snapshot.converged_count,
            dead_letter: snapshot.dead_letter_count,
            due: snapshot.due_count,
            expired_leases: snapshot.expired_lease_count,
            oldest_due_at: positive(snapshot.oldest_due_at),
            latest_observed_at: positive(snapshot.latest_observed_at),
            latest_updated_at: positive(snapshot.latest_updated_at),
        }),
        classes: classes
            .into_iter()
            .map(|row| ReconciliationClassCount {
                class: row.last_class,
                count: row.observation_count,
            })
            .collect(),
    }
}

fn reconciliation_record(
    row: RelayContainerReconciliationObservationRow,
    now: i64,
) -> ReconciliationRecord {
    let due = matches!(row.status.as_str(), "pending" | "retry") && row.available_at <= now;
    let leased = row.status == "leased";
    let target = observation_target(&row);
    ReconciliationRecord {
        target,
        operation_reference: reference(OPERATION_REFERENCE_DOMAIN, &row.operation_id),
        reconciliation_reference: (!row.reconciliation_id.is_empty())
            .then(|| reference(RECONCILIATION_REFERENCE_DOMAIN, &row.reconciliation_id)),
        operation_created_at: row.operation_created_at,
        owner_generation: row.owner_generation,
        status: row.status,
        class: optional_text(&row.last_class),
        last_error_code: optional_text(&row.last_error_code),
        claim_generation: row.claim_generation,
        attempt_count: row.attempt_count,
        consecutive_failures: row.consecutive_failures,
        due,
        lease_active: leased && row.claim_lease_expires_at > now,
        lease_expired: leased && row.claim_lease_expires_at <= now,
        available_at: positive(row.available_at),
        lease_expires_at: positive(row.claim_lease_expires_at),
        first_observed_at: positive(row.first_observed_at),
        last_attempt_at: positive(row.last_attempt_at),
        last_observed_at: positive(row.last_observed_at),
        recovery_deadline_at: row.recovery_deadline_at,
        converged_at: positive(row.converged_at),
        dead_lettered_at: positive(row.dead_lettered_at),
        dead_letter_reason: optional_text(&row.dead_letter_reason),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn prepare_retry_preview(
    target: &str,
    row: &RelayContainerReconciliationObservationRow,
    decision: RetryPreviewDecision,
    apply_enabled: bool,
    now: i64,
) -> RetryPreviewResponse {
    let operation_reference = reference(OPERATION_REFERENCE_DOMAIN, &row.operation_id);
    let reconciliation_reference = (!row.reconciliation_id.is_empty())
        .then(|| reference(RECONCILIATION_REFERENCE_DOMAIN, &row.reconciliation_id));
    let evidence_sha256 = evidence_digest(&decision.evidence_reference);
    let token_payload = json!({
        "contract_version": CONTRACT_VERSION,
        "target": target,
        "operation_reference": operation_reference,
        "reconciliation_reference": reconciliation_reference,
        "operation_created_at": row.operation_created_at,
        "owner_generation": row.owner_generation,
        "status": row.status,
        "class": row.last_class,
        "last_error_code": row.last_error_code,
        "claim_generation": row.claim_generation,
        "claim_lease_expires_at": row.claim_lease_expires_at,
        "available_at": row.available_at,
        "attempt_count": row.attempt_count,
        "consecutive_failures": row.consecutive_failures,
        "first_observed_at": row.first_observed_at,
        "last_attempt_at": row.last_attempt_at,
        "last_observed_at": row.last_observed_at,
        "recovery_deadline_at": row.recovery_deadline_at,
        "converged_at": row.converged_at,
        "dead_lettered_at": row.dead_lettered_at,
        "dead_letter_reason": row.dead_letter_reason,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "action": "reobserve_container_state",
        "reason": decision.reason,
        "evidence_sha256": evidence_sha256,
        "apply_compiled": true,
    });
    let preview_token = reference(PREVIEW_DOMAIN, &token_payload.to_string());
    let candidate_retryable = retry_candidate(row, now);
    let apply_blocker = if !candidate_retryable {
        "retry_horizon_expired"
    } else if !apply_enabled {
        "retry_apply_disabled"
    } else {
        ""
    };
    RetryPreviewResponse {
        contract_version: CONTRACT_VERSION,
        target: target.to_string(),
        operation_reference,
        reconciliation_reference,
        owner_generation: row.owner_generation,
        status: row.status.clone(),
        class: row.last_class.clone(),
        last_error_code: optional_text(&row.last_error_code),
        claim_generation: row.claim_generation,
        attempt_count: row.attempt_count,
        consecutive_failures: row.consecutive_failures,
        recovery_deadline_at: row.recovery_deadline_at,
        dead_lettered_at: row.dead_lettered_at,
        dead_letter_reason: row.dead_letter_reason.clone(),
        action: "reobserve_container_state",
        reason: decision.reason,
        evidence_sha256,
        candidate_retryable,
        apply_compiled: retry_apply_compiled(),
        apply_enabled,
        apply_blocker,
        step_up_required_for_apply: true,
        observer_state_mutation_only: true,
        provider_retry_allowed: false,
        operation_mutation_allowed: false,
        financial_mutation_allowed: false,
        durable_object_mutation_allowed: false,
        r2_mutation_allowed: false,
        preview_token,
    }
}

fn retry_candidate(row: &RelayContainerReconciliationObservationRow, now: i64) -> bool {
    let (_, scheduled_at) = retry_schedule(row, now);
    row.dead_letter_reason != "retry_horizon_exhausted"
        && row.recovery_deadline_at.saturating_sub(scheduled_at) >= MIN_RETRY_MARGIN_SECONDS
}

fn retry_schedule(row: &RelayContainerReconciliationObservationRow, now: i64) -> (i64, i64) {
    let created_at = now.max(row.updated_at);
    (created_at, created_at.saturating_add(1))
}

fn retry_resolution_key(target: &str, preview_token: &str, idempotency_sha256: &str) -> String {
    let payload = json!({
        "contract_version": CONTRACT_VERSION,
        "target": target,
        "preview_token": preview_token,
        "idempotency_sha256": idempotency_sha256,
    });
    reference(RESOLUTION_DOMAIN, &payload.to_string())
}

fn retry_preview_contract_valid(row: &RelayContainerReconciliationObservationRow) -> bool {
    row.status == "dead_letter"
        && row.claim_generation > 0
        && row.claim_lease_expires_at == 0
        && row.available_at == 0
        && row.attempt_count > 0
        && row.first_observed_at > 0
        && row.last_attempt_at > 0
        && row.last_observed_at == row.updated_at
        && !row.last_class.is_empty()
        && row.converged_at == 0
        && row.dead_lettered_at == row.updated_at
        && CONTAINER_RECONCILIATION_DEAD_LETTER_REASONS.contains(&row.dead_letter_reason.as_str())
        && (row.dead_letter_reason == "retry_horizon_exhausted"
            || row.dead_letter_reason == row.last_class)
}

fn observation_target(row: &RelayContainerReconciliationObservationRow) -> String {
    format!(
        "{TARGET_PREFIX}-{}-{}",
        row.observation_sequence,
        observation_target_digest(row)
    )
}

fn observation_target_digest(row: &RelayContainerReconciliationObservationRow) -> String {
    let mut hasher = Sha256::new();
    hasher.update(TARGET_DOMAIN);
    hasher.update(row.observation_sequence.to_be_bytes());
    hasher.update(row.owner_generation.to_be_bytes());
    hasher.update(row.operation_id.as_bytes());
    hasher.update([0]);
    hasher.update(row.reconciliation_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn parse_target(value: &str) -> Option<ParsedTarget> {
    let mut parts = value.split('-');
    if parts.next()? != TARGET_PREFIX {
        return None;
    }
    let sequence = parts.next()?;
    let observation_sequence = parse_cursor(sequence)?;
    if sequence != observation_sequence.to_string() {
        return None;
    }
    let digest = parts.next()?;
    if parts.next().is_some() || !valid_lower_hex(digest, 64) {
        return None;
    }
    Some(ParsedTarget {
        observation_sequence,
        digest: digest.to_string(),
    })
}

fn valid_evidence_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= EVIDENCE_REFERENCE_MAX_LEN
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/' | b'#' | b'@')
        })
}

fn valid_idempotency_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= IDEMPOTENCY_KEY_MAX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn evidence_digest(value: &str) -> String {
    reference(EVIDENCE_DOMAIN, value)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn status_contract_valid(
    snapshot: &RelayContainerReconciliationRuntimeSnapshot,
    classes: &[RelayContainerReconciliationClassCount],
) -> bool {
    let state_total = snapshot
        .pending_count
        .saturating_add(snapshot.leased_count)
        .saturating_add(snapshot.retry_count)
        .saturating_add(snapshot.converged_count)
        .saturating_add(snapshot.dead_letter_count);
    let class_total = classes.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.observation_count)
    });
    let cursor_valid = (snapshot.last_created_at == 0) == snapshot.last_reservation_key.is_empty()
        && (snapshot.round_high_created_at == 0) == snapshot.round_high_reservation_key.is_empty();
    let run_owner_valid = snapshot.run_owner.is_empty() || valid_lower_hex(&snapshot.run_owner, 32);
    snapshot.total_count >= 0
        && state_total == snapshot.total_count
        && class_total <= snapshot.total_count
        && snapshot.due_count >= 0
        && snapshot.due_count <= snapshot.pending_count.saturating_add(snapshot.retry_count)
        && snapshot.expired_lease_count >= 0
        && snapshot.expired_lease_count <= snapshot.leased_count
        && cursor_valid
        && run_owner_valid
        && classes.iter().all(|row| {
            RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&row.last_class.as_str())
                && row.observation_count > 0
        })
}

fn observation_contract_valid(row: &RelayContainerReconciliationObservationRow) -> bool {
    RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&row.status.as_str())
        && (row.last_class.is_empty()
            || RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&row.last_class.as_str()))
        && row.observation_sequence > 0
        && !row.operation_id.is_empty()
        && row.operation_created_at > 0
        && row.owner_generation > 0
        && (row.reconciliation_id.is_empty() || valid_lower_hex(&row.reconciliation_id, 64))
        && row.claim_generation == row.attempt_count
        && row.consecutive_failures <= row.attempt_count
        && row.recovery_deadline_at > row.created_at
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn reconciliation_list_query(req: &Request) -> Result<ReconciliationListQuery, &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid Container reconciliation list URL")?;
    let mut query = ReconciliationListQuery {
        before_sequence: 0,
        status: String::new(),
        class: String::new(),
        limit: DEFAULT_LIST_LIMIT,
    };
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Duplicate Container reconciliation list query");
        }
        match key.as_ref() {
            "cursor" => {
                query.before_sequence = parse_cursor(value.as_ref())
                    .ok_or("Invalid Container reconciliation list cursor")?;
            }
            "status" => {
                let value = value.trim();
                if !RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&value) {
                    return Err("Invalid Container reconciliation status filter");
                }
                query.status = value.to_string();
            }
            "class" => {
                let value = value.trim();
                if !RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&value) {
                    return Err("Invalid Container reconciliation class filter");
                }
                query.class = value.to_string();
            }
            "limit" => {
                query.limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=MAX_LIST_LIMIT).contains(value))
                    .ok_or("Invalid Container reconciliation list limit")?;
            }
            _ => return Err("Unsupported Container reconciliation list query"),
        }
    }
    Ok(query)
}

fn parse_cursor(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<i64>().ok().filter(|value| *value > 0)
}

fn cursor_reference(created_at: i64, key: &str) -> Option<String> {
    if created_at <= 0 || key.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(CURSOR_REFERENCE_DOMAIN);
    hasher.update(created_at.to_be_bytes());
    hasher.update(key.as_bytes());
    Some(format!("{:x}", hasher.finalize()))
}

fn reference(domain: &[u8], value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn positive(value: i64) -> Option<i64> {
    (value > 0).then_some(value)
}

fn optional_text(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

fn no_store(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_snapshot() -> RelayContainerReconciliationRuntimeSnapshot {
        RelayContainerReconciliationRuntimeSnapshot {
            last_created_at: 100,
            last_reservation_key: "raw-cursor-operation".to_string(),
            round_high_created_at: 200,
            round_high_reservation_key: "raw-high-operation".to_string(),
            scan_generation: 3,
            run_generation: 4,
            run_owner: "a".repeat(32),
            run_lease_expires_at: 400,
            last_started_at: 300,
            last_completed_at: 250,
            last_success_at: 250,
            last_error_code: String::new(),
            total_count: 5,
            pending_count: 1,
            leased_count: 1,
            retry_count: 1,
            converged_count: 1,
            dead_letter_count: 1,
            due_count: 2,
            expired_lease_count: 0,
            oldest_due_at: 120,
            latest_observed_at: 280,
            latest_updated_at: 300,
        }
    }

    fn test_row() -> RelayContainerReconciliationObservationRow {
        RelayContainerReconciliationObservationRow {
            observation_sequence: 9,
            operation_id: "raw-operation-id".to_string(),
            operation_created_at: 100,
            owner_generation: 2,
            reconciliation_id: "b".repeat(64),
            status: "retry".to_string(),
            claim_generation: 3,
            claim_lease_expires_at: 0,
            available_at: 250,
            attempt_count: 3,
            consecutive_failures: 1,
            first_observed_at: 150,
            last_attempt_at: 200,
            last_observed_at: 210,
            last_class: "store_unavailable".to_string(),
            last_error_code: "controller_status_unavailable".to_string(),
            recovery_deadline_at: 1_000,
            converged_at: 0,
            dead_lettered_at: 0,
            dead_letter_reason: String::new(),
            created_at: 140,
            updated_at: 210,
        }
    }

    fn dead_letter_row() -> RelayContainerReconciliationObservationRow {
        RelayContainerReconciliationObservationRow {
            status: "dead_letter".to_string(),
            claim_lease_expires_at: 0,
            available_at: 0,
            last_class: "terminal_conflict".to_string(),
            last_error_code: "controller_contract_violation".to_string(),
            converged_at: 0,
            dead_lettered_at: 210,
            dead_letter_reason: "terminal_conflict".to_string(),
            ..test_row()
        }
    }

    #[test]
    fn status_projection_redacts_cursor_and_run_owners() {
        let snapshot = test_snapshot();
        let response = status_response(
            false,
            true,
            false,
            4,
            350,
            &snapshot,
            vec![RelayContainerReconciliationClassCount {
                last_class: "store_unavailable".to_string(),
                observation_count: 2,
            }],
        );
        let json = serde_json::to_string(&response).unwrap();
        assert!(!json.contains("raw-cursor-operation"));
        assert!(!json.contains("raw-high-operation"));
        assert!(!json.contains(&snapshot.run_owner));
        assert!(json.contains("cursor_reference"));
        assert!(json.contains("store_unavailable"));
        assert!(response.run.unwrap().active);
    }

    #[test]
    fn observation_projection_exposes_only_domain_scoped_references() {
        let row = test_row();
        let raw_operation = row.operation_id.clone();
        let raw_reconciliation = row.reconciliation_id.clone();
        let record = reconciliation_record(row, 200);
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains(&raw_operation));
        assert!(!json.contains(&raw_reconciliation));
        assert_eq!(record.operation_reference.len(), 64);
        assert_eq!(record.reconciliation_reference.unwrap().len(), 64);
        assert!(parse_target(&record.target).is_some());
        assert!(!record.due);
        assert_eq!(record.class.as_deref(), Some("store_unavailable"));
    }

    #[test]
    fn retry_preview_binds_exact_state_and_reports_narrow_apply_authority() {
        let row = dead_letter_row();
        assert!(retry_preview_contract_valid(&row));
        let target = observation_target(&row);
        let decision = RetryPreviewDecision {
            reason: RetryPreviewReason::OperatorReinspectionApproved,
            evidence_reference: "incident:CT-41".to_string(),
        };
        let preview = prepare_retry_preview(&target, &row, decision.clone(), true, 300);
        let json = serde_json::to_string(&preview).unwrap();
        assert!(!json.contains(&row.operation_id));
        assert!(!json.contains(&row.reconciliation_id));
        assert!(!json.contains(&decision.evidence_reference));
        assert!(preview.candidate_retryable);
        assert!(preview.apply_compiled);
        assert!(preview.apply_enabled);
        assert_eq!(preview.apply_blocker, "");
        assert!(!preview.provider_retry_allowed);
        assert!(!preview.operation_mutation_allowed);
        assert!(!preview.financial_mutation_allowed);
        assert!(!preview.durable_object_mutation_allowed);
        assert!(!preview.r2_mutation_allowed);
        assert_eq!(preview.preview_token.len(), 64);

        let mut changed = row.clone();
        changed.updated_at += 1;
        changed.last_observed_at += 1;
        changed.dead_lettered_at += 1;
        assert_ne!(
            preview.preview_token,
            prepare_retry_preview(&target, &changed, decision.clone(), true, 300).preview_token
        );
        assert_ne!(
            preview.preview_token,
            prepare_retry_preview(
                &target,
                &row,
                RetryPreviewDecision {
                    evidence_reference: "incident:CT-42".to_string(),
                    ..decision
                },
                true,
                300,
            )
            .preview_token
        );
    }

    #[test]
    fn retry_target_is_sequence_bound_and_strictly_parsed() {
        let row = dead_letter_row();
        let target = observation_target(&row);
        let parsed = parse_target(&target).unwrap();
        assert_eq!(parsed.observation_sequence, row.observation_sequence);
        assert!(constant_time_eq(
            &parsed.digest,
            &observation_target_digest(&row)
        ));
        for invalid in [
            "",
            "ctrec1-0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ctrec1-09-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ctrec2-9-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ctrec1-9-not-a-digest",
            "ctrec1-9-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert_eq!(parse_target(invalid), None);
        }
        let mut changed = row;
        changed.owner_generation += 1;
        assert_ne!(parsed.digest, observation_target_digest(&changed));
    }

    #[test]
    fn retry_preview_accepts_only_valid_dead_letters_and_evidence() {
        assert!(!retry_preview_contract_valid(&test_row()));
        let mut row = dead_letter_row();
        row.dead_letter_reason = "unknown".to_string();
        assert!(!retry_preview_contract_valid(&row));
        let mut mismatched = dead_letter_row();
        mismatched.dead_letter_reason = "response_r2_orphan".to_string();
        assert!(!retry_preview_contract_valid(&mismatched));
        let mut horizon = dead_letter_row();
        horizon.last_class = "store_unavailable".to_string();
        horizon.dead_letter_reason = "retry_horizon_exhausted".to_string();
        assert!(retry_preview_contract_valid(&horizon));
        let horizon_preview = prepare_retry_preview(
            &observation_target(&horizon),
            &horizon,
            RetryPreviewDecision {
                reason: RetryPreviewReason::StorageRepaired,
                evidence_reference: "incident:CT-43".to_string(),
            },
            true,
            300,
        );
        assert!(!horizon_preview.candidate_retryable);
        assert_eq!(horizon_preview.apply_blocker, "retry_horizon_expired");
        let disabled_preview = prepare_retry_preview(
            &observation_target(&dead_letter_row()),
            &dead_letter_row(),
            RetryPreviewDecision {
                reason: RetryPreviewReason::ControllerReconciled,
                evidence_reference: "incident:CT-44".to_string(),
            },
            false,
            300,
        );
        assert!(disabled_preview.candidate_retryable);
        assert_eq!(disabled_preview.apply_blocker, "retry_apply_disabled");
        assert!(valid_evidence_reference("incident:CT-41"));
        assert!(!valid_evidence_reference(""));
        assert!(!valid_evidence_reference("contains spaces"));
        assert!(!valid_evidence_reference(" incident:CT-41"));
        assert!(!valid_evidence_reference("incident:CT-41\n"));
        assert!(!valid_evidence_reference(&"a".repeat(129)));
    }

    #[test]
    fn cursor_and_filter_contracts_are_strictly_bounded() {
        assert_eq!(parse_cursor("42"), Some(42));
        for invalid in ["", "0", "-1", "+1", " 1", "1.0", "9223372036854775808"] {
            assert_eq!(parse_cursor(invalid), None);
        }
        assert!(RELAY_CONTAINER_RECONCILIATION_STATUSES.contains(&"dead_letter"));
        assert!(RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&"terminal_conflict"));
        assert!(!RELAY_CONTAINER_RECONCILIATION_CLASSES.contains(&"unknown"));
        assert_eq!(DEFAULT_LIST_LIMIT, 20);
        assert_eq!(MAX_LIST_LIMIT, 50);
    }

    #[test]
    fn operator_surface_keeps_retry_apply_root_step_up_scoped_and_no_store() {
        let source = include_str!("container_reconciliation_admin.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let router = include_str!("lib.rs");
        assert!(source.contains("require_admin_auth(&req, &env)"));
        assert!(source.contains("require_root_auth(&req, &env)"));
        assert!(source.contains("Cache-Control\", \"no-store"));
        assert!(source.contains("require_secure_verification(&req, &env, claims.id)"));
        assert!(source.contains("CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED"));
        assert!(source.contains("observer_state_mutation_only: true"));
        assert!(!source.contains("INSERT INTO"));
        assert!(!source.contains("UPDATE relay_container"));
        assert!(!source.contains("DELETE FROM"));
        assert!(router.contains("/api/platform/container/reconciliation/status"));
        assert!(router.contains("/api/platform/container/reconciliations"));
        assert!(router.contains("/api/platform/container/reconciliations/:target/retry/preview"));
        assert!(router.contains("/api/platform/container/reconciliations/:target/retry/apply"));
    }

    #[test]
    fn corrupted_observer_rows_fail_the_read_contract() {
        let snapshot = test_snapshot();
        let classes = vec![RelayContainerReconciliationClassCount {
            last_class: "store_unavailable".to_string(),
            observation_count: 2,
        }];
        assert!(status_contract_valid(&snapshot, &classes));

        let mut invalid_snapshot = snapshot;
        invalid_snapshot.dead_letter_count = 2;
        assert!(!status_contract_valid(&invalid_snapshot, &classes));

        let mut row = test_row();
        assert!(observation_contract_valid(&row));
        row.last_class = "unknown".to_string();
        assert!(!observation_contract_valid(&row));
    }
}
