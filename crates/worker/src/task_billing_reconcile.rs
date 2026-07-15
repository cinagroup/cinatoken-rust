use cinatoken_tasks::TaskStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_root_auth, require_secure_verification,
};
use crate::task_repository::{
    attach_task_billing_reconciliation, find_task_billing_reconciliation,
    list_task_billing_reconciliations, refund_task_billing_reconciliation, NewTask,
    TaskBillingIntent, TaskBillingReconciliationEvent, TaskBillingReconciliationMutationOutcome,
};

pub(crate) const TASK_SUBMIT_RECONCILIATION_ENABLED_ENV: &str =
    "TASK_SUBMIT_RECONCILIATION_ENABLED";
pub(crate) const TASK_SUBMIT_RECONCILIATION_STAGING_VERIFIED_ENV: &str =
    "TASK_SUBMIT_RECONCILIATION_STAGING_VERIFIED";
const CONTRACT_VERSION: u32 = 1;
const EVIDENCE_REFERENCE_MAX_LEN: usize = 128;
const PROVIDER_TASK_ID_MAX_LEN: usize = 256;
const IDEMPOTENCY_KEY_MAX_LEN: usize = 96;
const QUEUE_DEFAULT_LIMIT: i64 = 20;
const QUEUE_MAX_LIMIT: i64 = 50;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReconciliationAction {
    Attach,
    Refund,
}

impl ReconciliationAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Refund => "refund",
        }
    }

    fn terminal_resolution(self) -> &'static str {
        match self {
            Self::Attach => "attached",
            Self::Refund => "refunded",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReconciliationReason {
    ProviderTaskVerified,
    ProviderConsoleVerified,
    ProviderConfirmsNotAccepted,
    CustomerRefundApproved,
}

impl ReconciliationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProviderTaskVerified => "provider_task_verified",
            Self::ProviderConsoleVerified => "provider_console_verified",
            Self::ProviderConfirmsNotAccepted => "provider_confirms_not_accepted",
            Self::CustomerRefundApproved => "customer_refund_approved",
        }
    }

    fn supports(self, action: ReconciliationAction) -> bool {
        matches!(
            (self, action),
            (
                Self::ProviderTaskVerified | Self::ProviderConsoleVerified,
                ReconciliationAction::Attach
            ) | (
                Self::ProviderConfirmsNotAccepted | Self::CustomerRefundApproved,
                ReconciliationAction::Refund
            )
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReconciliationDecision {
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    #[serde(default)]
    provider_task_id: String,
}

impl ReconciliationDecision {
    fn validate(&self) -> Result<(), &'static str> {
        if !self.reason.supports(self.action) {
            return Err("Task reconciliation reason does not match the requested action");
        }
        if !valid_evidence_reference(&self.evidence_reference) {
            return Err("Task reconciliation evidence_reference is invalid");
        }
        match self.action {
            ReconciliationAction::Attach if !valid_provider_task_id(&self.provider_task_id) => {
                Err("Task reconciliation attach requires a valid provider_task_id")
            }
            ReconciliationAction::Refund if !self.provider_task_id.trim().is_empty() => {
                Err("Task reconciliation refund must not provide provider_task_id")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconciliationApplyRequest {
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    #[serde(default)]
    provider_task_id: String,
    preview_token: String,
    idempotency_key: String,
    confirm_resolution: bool,
}

impl ReconciliationApplyRequest {
    fn decision(&self) -> ReconciliationDecision {
        ReconciliationDecision {
            action: self.action,
            reason: self.reason,
            evidence_reference: self.evidence_reference.clone(),
            provider_task_id: self.provider_task_id.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ReconciliationQueueResponse {
    contract_version: u32,
    count: usize,
    next_cursor: Option<String>,
    records: Vec<ReconciliationQueueRecord>,
}

#[derive(Debug, Serialize)]
struct ReconciliationQueueRecord {
    reconciliation_id: String,
    reconciliation_revision: i64,
    task_kind: String,
    public_task_id: String,
    provider_kind: String,
    provider_task_id: String,
    quota: i64,
    funding_source: String,
    quarantine_reason: String,
    quarantine_required_at: i64,
    attach_contract_sha256: String,
    attach_available: bool,
}

#[derive(Debug, Serialize)]
struct ReconciliationPreviewResponse {
    contract_version: u32,
    reconciliation_id: String,
    reconciliation_revision: i64,
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    provider_task_id: String,
    task_kind: String,
    public_task_id: String,
    provider_kind: String,
    quota: i64,
    funding_source: String,
    billing_contract_sha256: String,
    attach_contract_sha256: String,
    attach_available: bool,
    legacy_refund_only: bool,
    preview_token: String,
}

#[derive(Debug, Serialize)]
struct ReconciliationApplyResponse {
    contract_version: u32,
    reconciliation_id: String,
    action: ReconciliationAction,
    status: &'static str,
    reconciliation_revision: i64,
    resolved_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FrozenAttachContract {
    contract_version: String,
    task_kind: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    group: String,
    action: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    prompt_en: String,
    properties: String,
    #[serde(default = "empty_json_object")]
    data: String,
}

impl FrozenAttachContract {
    fn parse(intent: &TaskBillingIntent) -> Result<Self, &'static str> {
        if intent.attach_contract_json == "{}"
            || digest(&intent.attach_contract_json) != intent.attach_contract_sha256
        {
            return Err("Task reconciliation attachment contract is unavailable");
        }
        let contract = serde_json::from_str::<Self>(&intent.attach_contract_json)
            .map_err(|_| "Task reconciliation attachment contract is invalid")?;
        if contract.contract_version != "task-attach-v1"
            || contract.task_kind != intent.task_kind
            || contract.action.trim().is_empty()
            || serde_json::from_str::<Value>(&contract.properties).is_err()
            || serde_json::from_str::<Value>(&contract.data).is_err()
        {
            return Err("Task reconciliation attachment contract is invalid");
        }
        match contract.task_kind.as_str() {
            "task"
                if !contract.platform.trim().is_empty()
                    && !contract.username.trim().is_empty()
                    && !contract.group.trim().is_empty() =>
            {
                Ok(contract)
            }
            "midjourney" if !contract.prompt.trim().is_empty() => Ok(contract),
            _ => Err("Task reconciliation attachment contract is incomplete"),
        }
    }
}

fn empty_json_object() -> String {
    "{}".to_string()
}

pub(crate) fn task_submit_reconciliation_compiled() -> bool {
    true
}

pub(crate) fn task_submit_reconciliation_enabled(env: &Env) -> bool {
    env.var(TASK_SUBMIT_RECONCILIATION_ENABLED_ENV)
        .ok()
        .is_some_and(|value| value.to_string().trim().eq_ignore_ascii_case("true"))
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let (after_required_at, after_reconciliation_id, limit) = match reconciliation_queue_query(&req)
    {
        Ok(query) => query,
        Err(message) => return no_store(envelope_error_response(400, message)),
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("task reconciliation queue: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Task reconciliation queue is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task reconciliation schema is not ready",
        ));
    }
    let rows = match list_task_billing_reconciliations(
        &db,
        after_required_at,
        &after_reconciliation_id,
        limit,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("task reconciliation queue failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Task reconciliation queue is unavailable",
            ));
        }
    };
    let next_cursor = rows.last().and_then(|row| {
        (rows.len() as i64 == limit)
            .then(|| reconciliation_cursor(row.recovery_required_at, &row.reconciliation_id))
    });
    let records = rows
        .into_iter()
        .map(|row| ReconciliationQueueRecord {
            reconciliation_id: row.reconciliation_id,
            reconciliation_revision: row.reconciliation_revision,
            task_kind: row.task_kind,
            public_task_id: row.public_task_id,
            provider_kind: row.provider_kind,
            provider_task_id: row.provider_task_id,
            quota: row.quota,
            funding_source: row.funding_source,
            quarantine_reason: row.recovery_last_error,
            quarantine_required_at: row.recovery_required_at,
            attach_contract_sha256: row.attach_contract_sha256,
            attach_available: row.attach_available == 1,
        })
        .collect::<Vec<_>>();
    no_store(envelope_ok_response(&ReconciliationQueueResponse {
        contract_version: CONTRACT_VERSION,
        count: records.len(),
        next_cursor,
        records,
    })?)
}

pub async fn preview(
    mut req: Request,
    env: Env,
    reconciliation_id: Option<String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return no_store(response);
    }
    let reconciliation_id = reconciliation_id.unwrap_or_default();
    if !valid_digest(&reconciliation_id) {
        return no_store(envelope_error_response(
            400,
            "Invalid task reconciliation id",
        ));
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let decision = match serde_json::from_value::<ReconciliationDecision>(body) {
        Ok(decision) => decision,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid task reconciliation preview request",
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
                "Task reconciliation is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task reconciliation schema is not ready",
        ));
    }
    let intent = match load_open_intent(&db, &reconciliation_id).await {
        Ok(intent) => intent,
        Err(response) => return no_store(response),
    };
    let preview = match prepare_decision(&intent, decision) {
        Ok(preview) => preview,
        Err(message) => return no_store(envelope_error_response(409, message)),
    };
    no_store(envelope_ok_response(&preview)?)
}

pub async fn apply(
    mut req: Request,
    env: Env,
    reconciliation_id: Option<String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return no_store(response);
    }
    if !task_submit_reconciliation_enabled(&env) {
        return no_store(envelope_error_response(
            403,
            "Task submit reconciliation is disabled",
        ));
    }
    let reconciliation_id = reconciliation_id.unwrap_or_default();
    if !valid_digest(&reconciliation_id) {
        return no_store(envelope_error_response(
            400,
            "Invalid task reconciliation id",
        ));
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let apply = match serde_json::from_value::<ReconciliationApplyRequest>(body) {
        Ok(apply) => apply,
        Err(_) => {
            return no_store(envelope_error_response(
                400,
                "Invalid task reconciliation apply request",
            ));
        }
    };
    let decision = apply.decision();
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    if !apply.confirm_resolution {
        return no_store(envelope_error_response(
            400,
            "Task reconciliation requires confirm_resolution=true",
        ));
    }
    if !valid_digest(&apply.preview_token) || !valid_idempotency_key(&apply.idempotency_key) {
        return no_store(envelope_error_response(
            400,
            "Invalid task reconciliation preview or idempotency key",
        ));
    }
    let resolution_key = digest(&format!(
        "cinatoken:task-submit-reconciliation-resolution:v1:{reconciliation_id}:{}:{}:{}",
        apply.idempotency_key,
        apply.action.as_str(),
        apply.preview_token
    ));
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(_) => {
            return no_store(envelope_error_response(
                503,
                "Task reconciliation is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Task reconciliation schema is not ready",
        ));
    }
    let intent = match find_task_billing_reconciliation(&db, &reconciliation_id).await {
        Ok(Some(intent)) => intent,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Task reconciliation was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("task reconciliation lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Task reconciliation is unavailable",
            ));
        }
    };
    if !intent.reconciliation_resolution.is_empty() {
        if intent.reconciliation_resolution_key == resolution_key
            && intent.reconciliation_resolution == apply.action.terminal_resolution()
        {
            return reconciliation_result(&intent, apply.action, "duplicate");
        }
        return no_store(envelope_error_response(
            409,
            "Task reconciliation is already resolved",
        ));
    }
    if !intent_is_open(&intent) {
        return no_store(envelope_error_response(
            409,
            "Task reconciliation ownership changed",
        ));
    }
    let prepared = match prepare_decision(&intent, decision) {
        Ok(preview) => preview,
        Err(message) => return no_store(envelope_error_response(409, message)),
    };
    if !constant_time_eq(&apply.preview_token, &prepared.preview_token) {
        return no_store(envelope_error_response(
            409,
            "Task reconciliation preview is stale",
        ));
    }
    let now = crate::admin::unix_timestamp();
    let evidence_sha256 = evidence_digest(&apply.evidence_reference);
    let decision_json = json!({
        "contract_version": CONTRACT_VERSION,
        "reconciliation_id": reconciliation_id,
        "reconciliation_revision": intent.reconciliation_revision,
        "action": apply.action.as_str(),
        "reason": apply.reason.as_str(),
        "provider_task_id": prepared.provider_task_id,
        "evidence_sha256": evidence_sha256,
        "preview_token": apply.preview_token,
        "billing_contract_sha256": intent.billing_contract_sha256,
        "attach_contract_sha256": intent.attach_contract_sha256,
    });
    let decision_sha256 = digest(&decision_json.to_string());
    let event = TaskBillingReconciliationEvent {
        resolution_key: &resolution_key,
        reconciliation_id: &reconciliation_id,
        reservation_key: &intent.reservation_key,
        expected_revision: intent.reconciliation_revision,
        action: apply.action.as_str(),
        reason: apply.reason.as_str(),
        provider_task_id: &prepared.provider_task_id,
        evidence_reference: apply.evidence_reference.trim(),
        evidence_sha256: &evidence_sha256,
        preview_token: &apply.preview_token,
        decision_sha256: &decision_sha256,
        operator_id: claims.id,
        created_at: now,
    };
    let params = json!({
        "reconciliation_id": reconciliation_id,
        "reconciliation_revision": intent.reconciliation_revision,
        "resolution_key": resolution_key,
        "action": apply.action.as_str(),
        "reason": apply.reason.as_str(),
        "provider_task_id": prepared.provider_task_id,
        "evidence_reference": apply.evidence_reference,
        "evidence_sha256": evidence_sha256,
        "public_task_id": intent.public_task_id,
        "task_kind": intent.task_kind,
        "quota": intent.quota,
    });
    let admin_info = admin_audit_info(&claims, &req);
    let admin_audit = crate::d1_repositories::admin_audit_log_statement(
        &db,
        Some(intent.user_id),
        None,
        &claims.username,
        "task_billing.submit_reconciliation_resolved",
        "Resolved an ambiguous provider task submission",
        &params,
        &admin_info,
        now,
    )?;
    let mutation = match apply.action {
        ReconciliationAction::Refund => {
            refund_task_billing_reconciliation(&db, &event, admin_audit).await
        }
        ReconciliationAction::Attach => {
            let contract = match FrozenAttachContract::parse(&intent) {
                Ok(contract) => contract,
                Err(message) => return no_store(envelope_error_response(409, message)),
            };
            if intent.task_kind == "task" {
                let task = NewTask {
                    task_id: &intent.public_task_id,
                    upstream_task_id: &prepared.provider_task_id,
                    platform: &contract.platform,
                    user_id: intent.user_id,
                    username: &contract.username,
                    group: &contract.group,
                    channel_id: intent.channel_id,
                    token_id: intent.token_id,
                    billing_reservation_key: &intent.reservation_key,
                    quota: intent.quota,
                    action: &contract.action,
                    status: TaskStatus::Submitted,
                    submit_time: intent.created_at,
                    created_at: intent.created_at,
                    updated_at: now,
                    properties: &contract.properties,
                    data: &contract.data,
                };
                attach_task_billing_reconciliation(&db, &task, &event, admin_audit).await
            } else {
                let mj = crate::mj_repository::NewMidjourney {
                    code: 1,
                    user_id: intent.user_id,
                    action: &contract.action,
                    mj_id: &prepared.provider_task_id,
                    prompt: &contract.prompt,
                    prompt_en: &contract.prompt_en,
                    channel_id: intent.channel_id,
                    quota: intent.quota,
                    status: "SUBMITTED",
                    progress: "0%",
                    submit_time: intent.created_at.saturating_mul(1_000),
                    properties: &contract.properties,
                    billing_reservation_key: &intent.reservation_key,
                };
                crate::mj_repository::attach_midjourney_billing_reconciliation(
                    &db,
                    &mj,
                    &event,
                    admin_audit,
                )
                .await
            }
        }
    };
    let outcome = match mutation {
        Ok(outcome) => outcome,
        Err(err) => {
            worker::console_error!("task reconciliation mutation failed: {err}");
            match find_task_billing_reconciliation(&db, &reconciliation_id).await {
                Ok(Some(canonical))
                    if canonical.reconciliation_resolution_key == resolution_key
                        && canonical.reconciliation_resolution
                            == apply.action.terminal_resolution() =>
                {
                    return reconciliation_result(&canonical, apply.action, "duplicate");
                }
                _ => {
                    return no_store(envelope_error_response(
                        503,
                        "Task reconciliation could not be applied",
                    ));
                }
            }
        }
    };
    if outcome == TaskBillingReconciliationMutationOutcome::Conflict {
        return no_store(envelope_error_response(
            409,
            "Task reconciliation changed after preview",
        ));
    }
    match find_task_billing_reconciliation(&db, &reconciliation_id).await {
        Ok(Some(canonical))
            if canonical.reconciliation_resolution_key == resolution_key
                && canonical.reconciliation_resolution == apply.action.terminal_resolution() =>
        {
            reconciliation_result(&canonical, apply.action, "applied")
        }
        Ok(_) => no_store(envelope_error_response(
            409,
            "Task reconciliation terminal state is inconsistent",
        )),
        Err(err) => {
            worker::console_error!("task reconciliation readback failed: {err}");
            no_store(envelope_error_response(
                503,
                "Task reconciliation readback is unavailable",
            ))
        }
    }
}

fn prepare_decision(
    intent: &TaskBillingIntent,
    decision: ReconciliationDecision,
) -> Result<ReconciliationPreviewResponse, &'static str> {
    if digest(&intent.billing_contract_json) != intent.billing_contract_sha256 {
        return Err("Task reconciliation billing contract digest does not match");
    }
    let attach_available = FrozenAttachContract::parse(intent).is_ok();
    let provider_task_id = match decision.action {
        ReconciliationAction::Attach => {
            if !attach_available {
                return Err("Task reconciliation is legacy refund-only");
            }
            let requested = decision.provider_task_id.trim();
            if !intent.provider_task_id.is_empty() && intent.provider_task_id != requested {
                return Err(
                    "Task reconciliation provider identity conflicts with durable evidence",
                );
            }
            requested.to_string()
        }
        ReconciliationAction::Refund => intent.provider_task_id.clone(),
    };
    let token_payload = json!({
        "contract_version": CONTRACT_VERSION,
        "reconciliation_id": intent.reconciliation_id,
        "reconciliation_revision": intent.reconciliation_revision,
        "owner_generation": intent.owner_generation,
        "action": decision.action,
        "reason": decision.reason,
        "provider_task_id": provider_task_id,
        "evidence_sha256": evidence_digest(&decision.evidence_reference),
        "task_kind": intent.task_kind,
        "public_task_id": intent.public_task_id,
        "user_id": intent.user_id,
        "token_id": intent.token_id,
        "channel_id": intent.channel_id,
        "quota": intent.quota,
        "funding_source": intent.funding_source,
        "billing_contract_sha256": intent.billing_contract_sha256,
        "attach_contract_sha256": intent.attach_contract_sha256,
    });
    let preview_token = digest(&format!(
        "cinatoken:task-submit-reconciliation-preview:v1:{}",
        token_payload
    ));
    Ok(ReconciliationPreviewResponse {
        contract_version: CONTRACT_VERSION,
        reconciliation_id: intent.reconciliation_id.clone(),
        reconciliation_revision: intent.reconciliation_revision,
        action: decision.action,
        reason: decision.reason,
        evidence_reference: decision.evidence_reference,
        provider_task_id,
        task_kind: intent.task_kind.clone(),
        public_task_id: intent.public_task_id.clone(),
        provider_kind: intent.provider_kind.clone(),
        quota: intent.quota,
        funding_source: intent.funding_source.clone(),
        billing_contract_sha256: intent.billing_contract_sha256.clone(),
        attach_contract_sha256: intent.attach_contract_sha256.clone(),
        attach_available,
        legacy_refund_only: !attach_available,
        preview_token,
    })
}

async fn load_open_intent(
    db: &worker::D1Database,
    reconciliation_id: &str,
) -> Result<TaskBillingIntent, Response> {
    match find_task_billing_reconciliation(db, reconciliation_id).await {
        Ok(Some(intent)) if intent_is_open(&intent) => Ok(intent),
        Ok(Some(_)) => Err(envelope_error_response(
            409,
            "Task reconciliation is no longer open",
        )),
        Ok(None) => Err(envelope_error_response(
            404,
            "Task reconciliation was not found",
        )),
        Err(err) => {
            worker::console_error!("task reconciliation lookup failed: {err}");
            Err(envelope_error_response(
                503,
                "Task reconciliation is unavailable",
            ))
        }
    }
}

fn intent_is_open(intent: &TaskBillingIntent) -> bool {
    intent.status == "recovery_required"
        && intent.submit_state == "submit_unknown"
        && intent.reconciliation_revision > 0
        && intent.reconciliation_resolution.is_empty()
}

fn reconciliation_result(
    intent: &TaskBillingIntent,
    action: ReconciliationAction,
    status: &'static str,
) -> WorkerResult<Response> {
    no_store(envelope_ok_response(&ReconciliationApplyResponse {
        contract_version: CONTRACT_VERSION,
        reconciliation_id: intent.reconciliation_id.clone(),
        action,
        status,
        reconciliation_revision: intent.reconciliation_revision,
        resolved_at: intent.reconciliation_resolved_at,
    })?)
}

async fn reconciliation_schema_ready(db: &worker::D1Database) -> bool {
    match crate::task_repository::task_billing_intent_schema_ready(db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("task reconciliation schema probe failed: {err}");
            false
        }
    }
}

fn reconciliation_queue_query(req: &Request) -> Result<(i64, String, i64), &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid task reconciliation queue URL")?;
    let mut cursor = (0, String::new());
    let mut limit = QUEUE_DEFAULT_LIMIT;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "cursor" => {
                cursor = parse_reconciliation_cursor(value.as_ref())
                    .ok_or("Invalid task reconciliation queue cursor")?;
            }
            "limit" => {
                limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=QUEUE_MAX_LIMIT).contains(value))
                    .ok_or("Invalid task reconciliation queue limit")?;
            }
            _ => return Err("Unsupported task reconciliation queue query"),
        }
    }
    Ok((cursor.0, cursor.1, limit))
}

fn reconciliation_cursor(required_at: i64, reconciliation_id: &str) -> String {
    format!("{:016x}.{reconciliation_id}", required_at.max(0))
}

fn parse_reconciliation_cursor(value: &str) -> Option<(i64, String)> {
    let (required_at, reconciliation_id) = value.split_once('.')?;
    if required_at.len() != 16 || !valid_digest(reconciliation_id) {
        return None;
    }
    Some((
        i64::from_str_radix(required_at, 16).ok()?,
        reconciliation_id.to_string(),
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

fn valid_provider_task_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= PROVIDER_TASK_ID_MAX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn evidence_digest(value: &str) -> String {
    digest(&format!(
        "cinatoken:task-submit-reconciliation-evidence:v1:{}",
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

    fn test_intent() -> TaskBillingIntent {
        let billing_contract_json = r#"{"funding_source":"wallet"}"#.to_string();
        let attach_contract_json = r#"{"contract_version":"task-attach-v1","task_kind":"task","platform":"suno","username":"operator-test","group":"default","action":"generate","properties":"{}","data":"{}"}"#.to_string();
        TaskBillingIntent {
            reservation_key: "reservation-test".to_string(),
            task_kind: "task".to_string(),
            public_task_id: "public-task-test".to_string(),
            user_id: 11,
            token_id: 12,
            channel_id: 13,
            quota: 100,
            funding_source: "wallet".to_string(),
            subscription_id: 0,
            billing_contract_sha256: digest(&billing_contract_json),
            billing_contract_json,
            attach_contract_sha256: digest(&attach_contract_json),
            attach_contract_json,
            status: "recovery_required".to_string(),
            submit_state: "submit_unknown".to_string(),
            provider_kind: "suno".to_string(),
            provider_idempotency_key: "provider-reservation-test".to_string(),
            provider_task_id: String::new(),
            request_accounted: 0,
            lease_expires_at: 1_800_000_000,
            owner_generation: 4,
            reconciliation_id: "a".repeat(64),
            reconciliation_revision: 1,
            reconciliation_resolution: String::new(),
            reconciliation_resolution_key: String::new(),
            reconciliation_resolved_at: 0,
            reconciliation_operator_id: 0,
            reconciliation_evidence_sha256: String::new(),
            reconciliation_reason: String::new(),
            recovery_last_error: "provider_response_unknown".to_string(),
            recovery_required_at: 1_800_000_001,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_001,
        }
    }

    #[test]
    fn decisions_are_action_scoped() {
        let attach = ReconciliationDecision {
            action: ReconciliationAction::Attach,
            reason: ReconciliationReason::ProviderTaskVerified,
            evidence_reference: "provider:console/task-1".to_string(),
            provider_task_id: "provider-task_1".to_string(),
        };
        assert!(attach.validate().is_ok());
        assert!(ReconciliationDecision {
            action: ReconciliationAction::Refund,
            ..attach
        }
        .validate()
        .is_err());
    }

    #[test]
    fn provider_identity_rejects_path_or_whitespace_injection() {
        assert!(valid_provider_task_id("task_abc-123:1"));
        assert!(!valid_provider_task_id("task/../../other"));
        assert!(!valid_provider_task_id("task id"));
    }

    #[test]
    fn cursor_round_trip_is_stable() {
        let id = "a".repeat(64);
        let cursor = reconciliation_cursor(1_800_000_000, &id);
        assert_eq!(
            parse_reconciliation_cursor(&cursor),
            Some((1_800_000_000, id))
        );
    }

    #[test]
    fn preview_comparison_checks_every_byte() {
        assert!(constant_time_eq(&"a".repeat(64), &"a".repeat(64)));
        assert!(!constant_time_eq(&"a".repeat(64), &"b".repeat(64)));
    }

    #[test]
    fn preview_binds_evidence_and_owner_generation() {
        let intent = test_intent();
        let decision = ReconciliationDecision {
            action: ReconciliationAction::Attach,
            reason: ReconciliationReason::ProviderTaskVerified,
            evidence_reference: "provider:console/task-1".to_string(),
            provider_task_id: "provider-task-1".to_string(),
        };
        let first = prepare_decision(&intent, decision.clone()).expect("first preview");
        let changed_evidence = prepare_decision(
            &intent,
            ReconciliationDecision {
                evidence_reference: "provider:console/task-2".to_string(),
                ..decision.clone()
            },
        )
        .expect("changed evidence preview");
        let mut changed_owner = intent;
        changed_owner.owner_generation += 1;
        let changed_owner =
            prepare_decision(&changed_owner, decision).expect("changed owner preview");

        assert_ne!(first.preview_token, changed_evidence.preview_token);
        assert_ne!(first.preview_token, changed_owner.preview_token);
    }

    #[test]
    fn legacy_intent_is_refund_only() {
        let mut intent = test_intent();
        intent.attach_contract_json = "{}".to_string();
        intent.attach_contract_sha256 = digest("{}");
        let attach = prepare_decision(
            &intent,
            ReconciliationDecision {
                action: ReconciliationAction::Attach,
                reason: ReconciliationReason::ProviderTaskVerified,
                evidence_reference: "provider:console/task-1".to_string(),
                provider_task_id: "provider-task-1".to_string(),
            },
        );
        assert_eq!(
            attach.unwrap_err(),
            "Task reconciliation is legacy refund-only"
        );

        let refund = prepare_decision(
            &intent,
            ReconciliationDecision {
                action: ReconciliationAction::Refund,
                reason: ReconciliationReason::ProviderConfirmsNotAccepted,
                evidence_reference: "provider:console/task-1".to_string(),
                provider_task_id: String::new(),
            },
        )
        .expect("legacy refund preview");
        assert!(refund.legacy_refund_only);
        assert!(!refund.attach_available);
    }
}
