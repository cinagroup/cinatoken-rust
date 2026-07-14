use cinatoken_relay::clamp_i64_to_i32;
use cinatoken_storage::RelayAuditLog;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, require_root_auth, require_secure_verification,
};
use crate::d1_repositories::{
    RealtimeBillingReconciliationAdminAudit, RealtimeBillingReconciliationMutation,
    RealtimeBillingReconciliationMutationOutcome, RealtimeBillingReservation,
    RealtimeSettlementReplayRecord, REALTIME_USAGE_RECONCILIATION_OWNER,
};
use crate::realtime_session::{
    realtime_billing_reconciliation_preview, RealtimeBillingReconciliationUsage,
};

pub(crate) const REALTIME_BILLING_RECONCILIATION_ENABLED_ENV: &str =
    "REALTIME_BILLING_RECONCILIATION_ENABLED";
const CONTRACT_VERSION: u32 = 1;
const EVIDENCE_REFERENCE_MAX_LEN: usize = 128;
const IDEMPOTENCY_KEY_MAX_LEN: usize = 96;
const QUEUE_DEFAULT_LIMIT: i64 = 20;
const QUEUE_MAX_LIMIT: i64 = 50;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReconciliationAction {
    Settle,
    Refund,
}

impl ReconciliationAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Settle => "settle",
            Self::Refund => "refund",
        }
    }

    fn terminal_resolution(self) -> &'static str {
        match self {
            Self::Settle => "settled",
            Self::Refund => "refunded",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReconciliationReason {
    ProviderUsageVerified,
    ProviderInvoiceVerified,
    ProviderConfirmsNoBillableUsage,
    CustomerRefundApproved,
}

impl ReconciliationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProviderUsageVerified => "provider_usage_verified",
            Self::ProviderInvoiceVerified => "provider_invoice_verified",
            Self::ProviderConfirmsNoBillableUsage => "provider_confirms_no_billable_usage",
            Self::CustomerRefundApproved => "customer_refund_approved",
        }
    }

    fn supports(self, action: ReconciliationAction) -> bool {
        matches!(
            (self, action),
            (
                Self::ProviderUsageVerified | Self::ProviderInvoiceVerified,
                ReconciliationAction::Settle
            ) | (
                Self::ProviderConfirmsNoBillableUsage | Self::CustomerRefundApproved,
                ReconciliationAction::Refund
            )
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReconciliationUsage {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    #[serde(default)]
    cached_tokens: i64,
    #[serde(default)]
    cache_creation_tokens: i64,
    #[serde(default)]
    image_input_tokens: i64,
    #[serde(default)]
    image_output_tokens: i64,
    #[serde(default)]
    audio_input_tokens: i64,
    #[serde(default)]
    audio_output_tokens: i64,
}

impl ReconciliationUsage {
    fn validate(&self) -> Result<(), &'static str> {
        let values = [
            self.input_tokens,
            self.output_tokens,
            self.total_tokens,
            self.cached_tokens,
            self.cache_creation_tokens,
            self.image_input_tokens,
            self.image_output_tokens,
            self.audio_input_tokens,
            self.audio_output_tokens,
        ];
        if values
            .iter()
            .any(|value| !(0..=i64::from(i32::MAX)).contains(value))
        {
            return Err("Realtime reconciliation token counts must be non-negative i32 values");
        }
        if self.input_tokens.saturating_add(self.output_tokens) != self.total_tokens {
            return Err(
                "Realtime reconciliation total_tokens must equal input_tokens + output_tokens",
            );
        }
        Ok(())
    }

    fn as_billing_usage(&self) -> RealtimeBillingReconciliationUsage {
        RealtimeBillingReconciliationUsage {
            input_tokens: self.input_tokens as i32,
            output_tokens: self.output_tokens as i32,
            total_tokens: self.total_tokens as i32,
            cached_tokens: self.cached_tokens as i32,
            cache_creation_tokens: self.cache_creation_tokens as i32,
            image_input_tokens: self.image_input_tokens as i32,
            image_output_tokens: self.image_output_tokens as i32,
            audio_input_tokens: self.audio_input_tokens as i32,
            audio_output_tokens: self.audio_output_tokens as i32,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReconciliationDecision {
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    usage: Option<ReconciliationUsage>,
}

impl ReconciliationDecision {
    fn validate(&self) -> Result<(), &'static str> {
        if !self.reason.supports(self.action) {
            return Err("Realtime reconciliation reason does not match the requested action");
        }
        if !valid_evidence_reference(&self.evidence_reference) {
            return Err("Realtime reconciliation evidence_reference is invalid");
        }
        match (self.action, self.usage.as_ref()) {
            (ReconciliationAction::Settle, Some(usage)) => usage.validate(),
            (ReconciliationAction::Settle, None) => {
                Err("Realtime reconciliation settlement requires usage")
            }
            (ReconciliationAction::Refund, None) => Ok(()),
            (ReconciliationAction::Refund, Some(_)) => {
                Err("Realtime reconciliation refund must not include usage")
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconciliationApplyRequest {
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    usage: Option<ReconciliationUsage>,
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
            usage: self.usage.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ReconciliationPreviewResponse {
    contract_version: u32,
    reconciliation_id: String,
    reconciliation_revision: i64,
    action: ReconciliationAction,
    reason: ReconciliationReason,
    evidence_reference: String,
    quarantine_reason: String,
    preview_token: String,
    pricing_source: &'static str,
    pre_consumed_quota: i64,
    final_quota: i64,
    refund_quota: i64,
    additional_quota: i64,
    settlement: Option<Value>,
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
    quarantine_reason: String,
    quarantine_required_at: i64,
    pre_consumed_quota: i64,
    created_at: i64,
}

struct PreparedDecision {
    response: ReconciliationPreviewResponse,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
}

pub(crate) fn realtime_billing_reconciliation_compiled() -> bool {
    true
}

pub(crate) fn realtime_billing_reconciliation_enabled(env: &Env) -> bool {
    env.var(REALTIME_BILLING_RECONCILIATION_ENABLED_ENV)
        .ok()
        .is_some_and(|value| value.to_string().trim().eq_ignore_ascii_case("true"))
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
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
            worker::console_error!("realtime reconciliation queue: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation queue is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Realtime reconciliation schema is not ready",
        ));
    }
    let mut rows = match crate::d1_repositories::list_realtime_billing_reconciliations(
        &db,
        after_required_at,
        &after_reconciliation_id,
        limit.saturating_add(1),
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("realtime reconciliation queue query failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation queue is unavailable",
            ));
        }
    };
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = rows.last().and_then(|row| {
        has_more
            .then(|| reconciliation_cursor(row.finalization_required_at, &row.reconciliation_id))
    });
    let records = rows
        .into_iter()
        .map(|row| ReconciliationQueueRecord {
            reconciliation_id: row.reconciliation_id,
            reconciliation_revision: row.reconciliation_revision,
            quarantine_reason: row.finalization_reason,
            quarantine_required_at: row.finalization_required_at,
            pre_consumed_quota: row.pre_consumed_quota,
            created_at: row.created_at,
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
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return no_store(response),
    };
    let reconciliation_id = reconciliation_id.unwrap_or_default();
    if !valid_digest(&reconciliation_id) {
        return no_store(envelope_error_response(
            400,
            "Invalid realtime reconciliation id",
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
                "Invalid realtime reconciliation preview request",
            ));
        }
    };
    if let Err(message) = decision.validate() {
        return no_store(envelope_error_response(400, message));
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("realtime reconciliation preview: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Realtime reconciliation schema is not ready",
        ));
    }
    let reservation = match crate::d1_repositories::realtime_billing_reconciliation(
        &db,
        &reconciliation_id,
    )
    .await
    {
        Ok(Some(reservation)) => reservation,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Realtime reconciliation was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("realtime reconciliation preview lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation is unavailable",
            ));
        }
    };
    if !reservation_is_open(&reservation) {
        return no_store(envelope_error_response(
            409,
            "Realtime reconciliation is no longer open",
        ));
    }
    let prepared = match prepare_decision(&reservation, decision) {
        Ok(prepared) => prepared,
        Err(message) => return no_store(envelope_error_response(409, message)),
    };
    let _ = claims;
    no_store(envelope_ok_response(&prepared.response)?)
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
    if !realtime_billing_reconciliation_enabled(&env) {
        return no_store(envelope_error_response(
            403,
            "Realtime billing reconciliation is disabled",
        ));
    }
    let admin_info = admin_audit_info(&claims, &req);
    let reconciliation_id = reconciliation_id.unwrap_or_default();
    if !valid_digest(&reconciliation_id) {
        return no_store(envelope_error_response(
            400,
            "Invalid realtime reconciliation id",
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
                "Invalid realtime reconciliation apply request",
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
            "Realtime reconciliation requires confirm_resolution=true",
        ));
    }
    if !valid_digest(&apply.preview_token) {
        return no_store(envelope_error_response(
            400,
            "Invalid realtime reconciliation preview_token",
        ));
    }
    if !valid_idempotency_key(&apply.idempotency_key) {
        return no_store(envelope_error_response(
            400,
            "Invalid realtime reconciliation idempotency_key",
        ));
    }
    let resolution_key = digest(&format!(
        "cinatoken:realtime-billing-reconciliation-resolution:v1:{reconciliation_id}:{}:{}:{}",
        apply.idempotency_key,
        apply.action.as_str(),
        apply.preview_token
    ));
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("realtime reconciliation apply: D1 unavailable: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation is unavailable",
            ));
        }
    };
    if !reconciliation_schema_ready(&db).await {
        return no_store(envelope_error_response(
            503,
            "Realtime reconciliation schema is not ready",
        ));
    }
    let reservation = match crate::d1_repositories::realtime_billing_reconciliation(
        &db,
        &reconciliation_id,
    )
    .await
    {
        Ok(Some(reservation)) => reservation,
        Ok(None) => {
            return no_store(envelope_error_response(
                404,
                "Realtime reconciliation was not found",
            ));
        }
        Err(err) => {
            worker::console_error!("realtime reconciliation apply lookup failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation is unavailable",
            ));
        }
    };
    if reservation.status != "reserved" {
        if reservation.reconciliation_resolution_key == resolution_key
            && reservation.reconciliation_resolution == apply.action.terminal_resolution()
        {
            return no_store(envelope_ok_response(&ReconciliationApplyResponse {
                contract_version: CONTRACT_VERSION,
                reconciliation_id,
                action: apply.action,
                status: "duplicate",
                reconciliation_revision: reservation.reconciliation_revision,
                resolved_at: reservation.reconciliation_resolved_at,
            })?);
        }
        return no_store(envelope_error_response(
            409,
            "Realtime reconciliation is already resolved",
        ));
    }
    if !reservation_is_open(&reservation) {
        return no_store(envelope_error_response(
            409,
            "Realtime reconciliation ownership changed",
        ));
    }
    let prepared = match prepare_decision(&reservation, decision) {
        Ok(prepared) => prepared,
        Err(message) => return no_store(envelope_error_response(409, message)),
    };
    if !constant_time_eq(&apply.preview_token, &prepared.response.preview_token) {
        return no_store(envelope_error_response(
            409,
            "Realtime reconciliation preview is stale",
        ));
    }
    let now = crate::admin::unix_timestamp();
    let evidence_sha256 = digest(&format!(
        "cinatoken:realtime-billing-reconciliation-evidence:v1:{}",
        apply.evidence_reference
    ));
    let params = json!({
        "reconciliation_id": reconciliation_id,
        "reconciliation_revision": reservation.reconciliation_revision,
        "action": apply.action.as_str(),
        "reason": apply.reason.as_str(),
        "evidence_reference": apply.evidence_reference.as_str(),
        "quarantine_reason": reservation.finalization_reason.as_str(),
        "quarantine_required_at": reservation.finalization_required_at,
        "normalized_usage": apply.usage.as_ref(),
        "preview_token": apply.preview_token.as_str(),
        "resolution_key": resolution_key.as_str(),
        "pre_consumed_quota": prepared.response.pre_consumed_quota,
        "final_quota": prepared.response.final_quota,
    });
    let admin_audit = RealtimeBillingReconciliationAdminAudit {
        actor_username: &claims.username,
        action: "realtime_billing.reconciliation_resolved",
        content: "Resolved a quarantined Realtime billing reservation",
        params: &params,
        admin_info: &admin_info,
        created_at: now,
    };
    let mutation = RealtimeBillingReconciliationMutation {
        reconciliation_id: &reconciliation_id,
        expected_revision: reservation.reconciliation_revision,
        resolution_key: &resolution_key,
        evidence_sha256: &evidence_sha256,
        operator_id: claims.id,
    };
    let outcome = match apply.action {
        ReconciliationAction::Settle => {
            let other = json!({
                "billing_pending": false,
                "relay_runtime": "cloudflare_worker_rust",
                "endpoint": "realtime",
                "usage_source": "operator_reconciliation",
                "reconciliation_id": reconciliation_id,
                "reconciliation_revision": reservation.reconciliation_revision,
                "reconciliation_reason": apply.reason.as_str(),
                "evidence_sha256": evidence_sha256,
                "quarantine_reason": reservation.finalization_reason.as_str(),
                "quarantine_required_at": reservation.finalization_required_at,
                "normalized_usage": apply.usage.as_ref(),
                "expr_hash": prepared.response.settlement.as_ref()
                    .and_then(|value| value.get("expr_hash"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                "expr_version": prepared.response.settlement.as_ref()
                    .and_then(|value| value.get("expr_version"))
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                "matched_tier": prepared.response.settlement.as_ref()
                    .and_then(|value| value.get("matched_tier"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                "total_tokens": prepared.total_tokens,
            })
            .to_string();
            let audit_log = RelayAuditLog {
                user_id: reservation.user_id,
                username: &reservation.username,
                token_id: reservation.token_id,
                token_name: &reservation.token_name,
                channel_id: reservation.channel_id,
                model: &reservation.model_name,
                group: &reservation.selected_group,
                prompt_tokens: clamp_i64_to_i32(prepared.prompt_tokens),
                completion_tokens: clamp_i64_to_i32(prepared.completion_tokens),
                quota: prepared.response.final_quota,
                use_time_seconds: now.saturating_sub(reservation.started_at),
                is_stream: true,
                ip: &reservation.client_ip,
                request_id: &reservation.request_id,
                upstream_request_id: "",
                other: &other,
            };
            crate::d1_repositories::apply_realtime_usage_reconciliation_settlement_batch(
                &db,
                mutation,
                RealtimeSettlementReplayRecord {
                    replay_key: &resolution_key,
                    session: &reservation.session,
                    user_id: reservation.user_id,
                    token_id: reservation.token_id,
                    channel_id: reservation.channel_id,
                    model_name: &reservation.model_name,
                    pre_consumed_quota: reservation.pre_consumed_quota,
                    final_quota: prepared.response.final_quota,
                    created_at: now,
                    applied_at: now,
                },
                "Rust realtime operator reconciliation settlement",
                &audit_log,
                admin_audit,
            )
            .await
        }
        ReconciliationAction::Refund => {
            crate::d1_repositories::refund_realtime_usage_reconciliation(
                &db,
                mutation,
                now,
                admin_audit,
            )
            .await
        }
    };
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(err) => {
            worker::console_error!("realtime reconciliation mutation failed: {err}");
            return no_store(envelope_error_response(
                503,
                "Realtime reconciliation could not be applied",
            ));
        }
    };
    match outcome {
        RealtimeBillingReconciliationMutationOutcome::Applied
        | RealtimeBillingReconciliationMutationOutcome::Duplicate => {
            let status = if outcome == RealtimeBillingReconciliationMutationOutcome::Applied {
                "applied"
            } else {
                "duplicate"
            };
            let canonical = match crate::d1_repositories::realtime_billing_reconciliation(
                &db,
                &reconciliation_id,
            )
            .await
            {
                Ok(Some(canonical))
                    if canonical.reconciliation_resolution_key == resolution_key
                        && canonical.reconciliation_resolution
                            == apply.action.terminal_resolution() =>
                {
                    canonical
                }
                Ok(_) => {
                    return no_store(envelope_error_response(
                        409,
                        "Realtime reconciliation terminal state is inconsistent",
                    ));
                }
                Err(err) => {
                    worker::console_error!(
                        "realtime reconciliation canonical readback failed: {err}"
                    );
                    return no_store(envelope_error_response(
                        503,
                        "Realtime reconciliation readback is unavailable",
                    ));
                }
            };
            no_store(envelope_ok_response(&ReconciliationApplyResponse {
                contract_version: CONTRACT_VERSION,
                reconciliation_id,
                action: apply.action,
                status,
                reconciliation_revision: canonical.reconciliation_revision,
                resolved_at: canonical.reconciliation_resolved_at,
            })?)
        }
        RealtimeBillingReconciliationMutationOutcome::Conflict => no_store(
            envelope_error_response(409, "Realtime reconciliation changed after preview"),
        ),
        RealtimeBillingReconciliationMutationOutcome::NotFound => no_store(
            envelope_error_response(404, "Realtime reconciliation was not found"),
        ),
    }
}

fn prepare_decision(
    reservation: &RealtimeBillingReservation,
    decision: ReconciliationDecision,
) -> Result<PreparedDecision, &'static str> {
    let (pricing_source, final_quota, refund_quota, additional_quota, settlement) =
        match decision.action {
            ReconciliationAction::Settle => {
                let usage = decision
                    .usage
                    .as_ref()
                    .ok_or("Realtime reconciliation settlement usage is missing")?;
                let preview = realtime_billing_reconciliation_preview(
                    &reservation.snapshot_json,
                    &reservation.request_json,
                    usage.as_billing_usage(),
                )
                .map_err(|_| "Frozen realtime billing input failed integrity validation")?;
                if preview.model_name() != reservation.model_name
                    || preview.pre_consumed_quota() != reservation.pre_consumed_quota
                {
                    return Err("Frozen realtime billing input does not match its reservation");
                }
                let preview_value = serde_json::to_value(&preview)
                    .map_err(|_| "Realtime reconciliation preview serialization failed")?;
                (
                    "frozen_tiered_snapshot",
                    preview.final_quota(),
                    reservation
                        .pre_consumed_quota
                        .saturating_sub(preview.final_quota())
                        .max(0),
                    preview
                        .final_quota()
                        .saturating_sub(reservation.pre_consumed_quota)
                        .max(0),
                    Some(preview_value),
                )
            }
            ReconciliationAction::Refund => (
                "reserved_quota_refund",
                0,
                reservation.pre_consumed_quota,
                0,
                None,
            ),
        };
    let token_payload = json!({
        "contract_version": CONTRACT_VERSION,
        "reconciliation_id": reservation.reconciliation_id,
        "reconciliation_revision": reservation.reconciliation_revision,
        "quarantine_reason": reservation.finalization_reason,
        "quarantine_required_at": reservation.finalization_required_at,
        "action": decision.action,
        "reason": decision.reason,
        "evidence_sha256": digest(&format!(
            "cinatoken:realtime-billing-reconciliation-evidence:v1:{}",
            decision.evidence_reference
        )),
        "usage": decision.usage,
        "pre_consumed_quota": reservation.pre_consumed_quota,
        "final_quota": final_quota,
        "settlement": settlement,
    });
    let preview_token = digest(&format!(
        "cinatoken:realtime-billing-reconciliation-preview:v1:{}",
        serde_json::to_string(&token_payload).map_err(|_| "Preview token serialization failed")?
    ));
    let (prompt_tokens, completion_tokens, total_tokens) = token_payload
        .get("usage")
        .and_then(|value| value.as_object())
        .map(|usage| {
            (
                usage
                    .get("input_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                usage
                    .get("output_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                usage
                    .get("total_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            )
        })
        .unwrap_or_default();
    Ok(PreparedDecision {
        response: ReconciliationPreviewResponse {
            contract_version: CONTRACT_VERSION,
            reconciliation_id: reservation.reconciliation_id.clone(),
            reconciliation_revision: reservation.reconciliation_revision,
            action: decision.action,
            reason: decision.reason,
            evidence_reference: decision.evidence_reference,
            quarantine_reason: reservation.finalization_reason.clone(),
            preview_token,
            pricing_source,
            pre_consumed_quota: reservation.pre_consumed_quota,
            final_quota,
            refund_quota,
            additional_quota,
            settlement,
        },
        prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

async fn reconciliation_schema_ready(db: &worker::D1Database) -> bool {
    match crate::d1_repositories::realtime_billing_reconciliation_schema_ready(db).await {
        Ok(ready) => ready,
        Err(err) => {
            worker::console_error!("realtime reconciliation schema probe failed: {err}");
            false
        }
    }
}

fn reservation_is_open(reservation: &RealtimeBillingReservation) -> bool {
    reservation.status == "reserved"
        && reservation.finalization_owner == REALTIME_USAGE_RECONCILIATION_OWNER
        && reservation.reconciliation_revision > 0
        && reservation.reconciliation_resolution.is_empty()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn reconciliation_queue_query(req: &Request) -> Result<(i64, String, i64), &'static str> {
    let url = req
        .url()
        .map_err(|_| "Invalid realtime reconciliation queue URL")?;
    let mut cursor = (0, String::new());
    let mut limit = QUEUE_DEFAULT_LIMIT;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "cursor" => {
                cursor = parse_reconciliation_cursor(value.as_ref())
                    .ok_or("Invalid realtime reconciliation queue cursor")?;
            }
            "limit" => {
                limit = value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| (1..=QUEUE_MAX_LIMIT).contains(value))
                    .ok_or("Invalid realtime reconciliation queue limit")?;
            }
            _ => return Err("Unsupported realtime reconciliation queue query"),
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
    let required_at = i64::from_str_radix(required_at, 16).ok()?;
    Some((required_at, reconciliation_id.to_string()))
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

    fn settle_decision() -> ReconciliationDecision {
        ReconciliationDecision {
            action: ReconciliationAction::Settle,
            reason: ReconciliationReason::ProviderUsageVerified,
            evidence_reference: "provider:usage/report-123".to_string(),
            usage: Some(ReconciliationUsage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cached_tokens: 2,
                cache_creation_tokens: 0,
                image_input_tokens: 0,
                image_output_tokens: 0,
                audio_input_tokens: 0,
                audio_output_tokens: 0,
            }),
        }
    }

    #[test]
    fn decision_contract_rejects_arbitrary_quota_and_unknown_fields() {
        assert!(serde_json::from_str::<ReconciliationDecision>(
            r#"{"action":"refund","reason":"customer_refund_approved","evidence_reference":"ticket:1","usage":null}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<ReconciliationDecision>(
            r#"{"action":"settle","reason":"provider_usage_verified","evidence_reference":"report:1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"final_quota":1}"#
        )
        .is_err());
    }

    #[test]
    fn settlement_usage_requires_consistent_non_negative_totals() {
        assert!(settle_decision().validate().is_ok());
        let mut decision = settle_decision();
        decision.usage.as_mut().unwrap().total_tokens = 16;
        assert!(decision.validate().is_err());
        decision.usage.as_mut().unwrap().total_tokens = 15;
        decision.usage.as_mut().unwrap().input_tokens = -1;
        assert!(decision.validate().is_err());
    }

    #[test]
    fn reasons_are_action_scoped_and_refunds_reject_usage() {
        let mut decision = settle_decision();
        decision.reason = ReconciliationReason::CustomerRefundApproved;
        assert!(decision.validate().is_err());
        decision.action = ReconciliationAction::Refund;
        assert!(decision.validate().is_err());
        decision.usage = None;
        assert!(decision.validate().is_ok());
    }

    #[test]
    fn public_ids_and_operator_references_are_bounded() {
        assert!(valid_digest(&"a".repeat(64)));
        assert!(!valid_digest(&"A".repeat(64)));
        assert!(valid_idempotency_key("018f-apply_1"));
        assert!(!valid_idempotency_key("contains secret?query"));
        assert!(valid_evidence_reference("provider:invoice/2026-07#42"));
        assert!(!valid_evidence_reference("provider invoice 42"));
    }

    #[test]
    fn preview_token_comparison_checks_every_byte() {
        assert!(constant_time_eq(&"a".repeat(64), &"a".repeat(64)));
        assert!(!constant_time_eq(
            &"a".repeat(64),
            &format!("{}b", "a".repeat(63))
        ));
        assert!(!constant_time_eq("short", "longer"));
    }

    #[test]
    fn queue_cursor_is_stable_and_rejects_unknown_queries() {
        let id = "a".repeat(64);
        let cursor = reconciliation_cursor(1_800_000_000, &id);
        assert_eq!(
            parse_reconciliation_cursor(&cursor),
            Some((1_800_000_000, id))
        );
        assert!(parse_reconciliation_cursor("invalid").is_none());
    }
}
