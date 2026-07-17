//! Default-off Edge integration for the non-streaming Container chat canary.
//!
//! The module deliberately owns no provider credential. It freezes one
//! transformed request in R2, binds the selected billing attempt in D1 before
//! dispatch, and only returns bytes after an exact financial-terminal readback.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::{Context, D1Database, Env, Headers, Response};

use crate::container_artifacts::{
    canonical_container_client_response_headers, inspect_container_result,
    put_container_client_response, put_container_input, read_verified_container_result,
    ContainerArtifactManifest, ContainerResultArtifactIdentity, ContainerResultObjectState,
};
use crate::container_controller::{
    dispatch_operation, query_operation_status, ContainerOperationEnvelope,
    ContainerOperationInput, ContainerOperationOutcome, ContainerOperationStatus,
    ContainerProviderAttemptStatus,
};
use crate::container_reconciliation::replay_receipt_client_response;
use crate::container_scheduler::{
    container_operation_runtime_status, container_scheduler_enabled,
    container_scheduler_runtime_status, plan_container_shard,
    CONTAINER_SCHEDULER_ROUTING_SECRET_ENV,
};
use crate::d1_repositories::{
    bind_relay_container_operation, commit_relay_container_financial_terminal,
    lookup_relay_container_client_request, mark_relay_container_operation_dispatched,
    quote_relay_container_provider_usage_settlement,
    relay_container_financial_terminal_receipt_for_operation, relay_container_operation,
    relay_container_provider_usage_receipt_readback, RelayContainerClientRequestLookup,
    RelayContainerClientResponseRecord, RelayContainerFinancialTerminalAction,
    RelayContainerFinancialTerminalCommand, RelayContainerFinancialTerminalOutcome,
    RelayContainerOperation, RelayContainerOperationDispatchOutcome,
    RelayContainerOperationExpectedStatus, RelayContainerOperationRecord,
    RelayContainerOperationResultRecord, RelayContainerOperationTerminalRecord,
    RelayContainerOperationWriteOutcome, RelayContainerProviderUsageReceiptReadback,
};

pub const CONTAINER_CHAT_CANARY_TOKEN_IDS_ENV: &str = "CONTAINER_CHAT_CANARY_TOKEN_IDS";
pub const CONTAINER_CHAT_CANARY_CHANNEL_ID_ENV: &str = "CONTAINER_CHAT_CANARY_CHANNEL_ID";
pub const CONTAINER_CHAT_CANARY_MODEL_ENV: &str = "CONTAINER_CHAT_CANARY_MODEL";
pub const CONTAINER_CHAT_CANARY_DEADLINE_SECONDS_ENV: &str =
    "CONTAINER_CHAT_CANARY_DEADLINE_SECONDS";
pub const CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV: &str =
    "CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET";

pub const CONTAINER_CHAT_CANARY_OPERATION_KIND: &str = "chat_completions_canary";
const CONTAINER_CHAT_CANARY_EGRESS_PROFILE: &str = "openai-chat-completions-canary-v1";
const DEFAULT_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS: i64 = 120;
const MIN_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS: i64 = 15;
const MAX_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS: i64 = 300;
const MAX_CONTAINER_CHAT_CANARY_TOKENS: usize = 64;
const MAX_CONTAINER_CHAT_CANARY_MODEL_BYTES: usize = 200;
const MIN_IDEMPOTENCY_SECRET_BYTES: usize = 32;
const MIN_IDEMPOTENCY_KEY_BYTES: usize = 8;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;
const MAX_CANARY_REQUEST_BYTES: usize = 4 * 1024 * 1024;

const IDEMPOTENCY_DOMAIN: &[u8] = b"cinatoken:container-chat-idempotency:v1\0";
const REQUEST_DOMAIN: &[u8] = b"cinatoken:container-chat-request:v1\0";
const PROVIDER_OPERATION_DOMAIN: &[u8] = b"cinatoken:container-provider-operation:v1\0";
const TRACE_DOMAIN: &[u8] = b"cinatoken:container-trace:v1\0";
const ADMISSION_DOMAIN: &[u8] = b"cinatoken:container-admission:v1\0";
const RECONCILIATION_DOMAIN: &[u8] = b"cinatoken:container-reconciliation:v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContainerChatCanaryRuntimeConfig {
    token_ids: Vec<i64>,
    channel_id: i64,
    model: String,
    deadline_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerChatCanaryPlanError {
    Misconfigured,
    IncompatibleRoute,
    MissingIdempotencyKey,
    InvalidIdempotencyKey,
}

impl ContainerChatCanaryPlanError {
    pub fn status(self) -> u16 {
        match self {
            Self::MissingIdempotencyKey | Self::InvalidIdempotencyKey => 400,
            Self::Misconfigured | Self::IncompatibleRoute => 503,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Misconfigured => "container_chat_canary_misconfigured",
            Self::IncompatibleRoute => "container_chat_canary_incompatible",
            Self::MissingIdempotencyKey => "container_chat_canary_idempotency_required",
            Self::InvalidIdempotencyKey => "container_chat_canary_idempotency_invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerChatCanaryPlan {
    request_body: Vec<u8>,
    input_sha256: String,
    client_idempotency_hmac_sha256: String,
    client_request_sha256: String,
    deadline_seconds: i64,
}

impl ContainerChatCanaryPlan {
    pub fn billing_request_identity(&self) -> &str {
        &self.client_idempotency_hmac_sha256
    }

    pub fn freeze_provider_request_body(
        mut self,
        request_body: &[u8],
    ) -> Result<Self, ContainerChatCanaryPlanError> {
        if request_body.is_empty() || request_body.len() > MAX_CANARY_REQUEST_BYTES {
            return Err(ContainerChatCanaryPlanError::IncompatibleRoute);
        }
        self.input_sha256 = sha256_hex(request_body);
        self.request_body = request_body.to_vec();
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ContainerChatCanaryEligibility<'a> {
    pub user_id: i64,
    pub token_id: i64,
    pub model: &'a str,
    pub selected_group: &'a str,
    pub selected_channel_id: i64,
    pub selected_channel_type: i32,
    pub selected_channel_has_model_mapping: bool,
    pub selected_channel_has_custom_base_url: bool,
    pub selected_channel_has_organization: bool,
    pub selected_channel_key_is_single: bool,
    pub selected_channel_has_extra_config: bool,
    pub selected_channel_has_wfp_worker: bool,
    pub selected_channel_uses_ai_gateway: bool,
    pub attempt_count: usize,
    pub retry_times: u32,
    pub model_fallback_configured: bool,
    pub api_key_auth: bool,
    pub openai_chat_route: bool,
    pub non_streaming: bool,
    pub idempotency_key: Option<&'a str>,
    pub request_body: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct ContainerChatCanaryAudit<'a> {
    pub user_id: i64,
    pub token_id: i64,
    pub channel_id: i64,
    pub model: &'a str,
    pub selected_group: &'a str,
    pub endpoint_path: &'a str,
    pub request_id: Option<&'a str>,
    pub client_ip: Option<&'a str>,
}

pub struct ContainerChatCanaryExecution<'a> {
    pub reservation_key: &'a str,
    pub billing_owner_generation: i64,
    pub billing_owner_lease_expires_at: i64,
    pub selected_group: &'a str,
    pub channel_id: i64,
    pub user_id: i64,
    pub plan: &'a ContainerChatCanaryPlan,
    pub audit: ContainerChatCanaryAudit<'a>,
}

pub fn container_chat_canary_compiled() -> bool {
    CONTAINER_CHAT_CANARY_OPERATION_KIND == "chat_completions_canary"
        && CONTAINER_CHAT_CANARY_EGRESS_PROFILE == "openai-chat-completions-canary-v1"
        && MAX_CANARY_REQUEST_BYTES
            == crate::container_artifacts::MAX_CONTAINER_CLIENT_RESPONSE_BYTES
        && MAX_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS <= 300
        && MIN_IDEMPOTENCY_SECRET_BYTES >= 32
}

/// The transport and replay foundation is compiled, but durable admission is
/// not cutover-safe until billing reservation, selected-attempt binding, and
/// operation preparation are one atomic D1 ownership transition.
pub fn container_chat_canary_admission_compiled() -> bool {
    false
}

pub fn container_chat_canary_cohort_active(
    env: &Env,
    route_eligible: bool,
    token_id: i64,
    model: &str,
) -> Result<bool, ContainerChatCanaryPlanError> {
    if !route_eligible
        || !container_chat_canary_admission_compiled()
        || !container_scheduler_enabled(env)
        || !container_operation_runtime_status(env).cutover_ready()
    {
        return Ok(false);
    }
    let Some(config) = container_chat_canary_runtime_config(env) else {
        return Ok(false);
    };
    Ok(config.token_ids.contains(&token_id) && config.model == model)
}

pub fn plan_container_chat_canary(
    env: &Env,
    eligibility: ContainerChatCanaryEligibility<'_>,
) -> Result<Option<ContainerChatCanaryPlan>, ContainerChatCanaryPlanError> {
    if !container_chat_canary_admission_compiled()
        || !container_scheduler_enabled(env)
        || !container_operation_runtime_status(env).cutover_ready()
    {
        return Ok(None);
    }
    let config = container_chat_canary_runtime_config(env)
        .ok_or(ContainerChatCanaryPlanError::Misconfigured)?;
    if !config.token_ids.contains(&eligibility.token_id) || config.model != eligibility.model {
        return Ok(None);
    }
    if eligibility.user_id <= 0
        || eligibility.selected_group == "auto"
        || eligibility.selected_channel_id != config.channel_id
        || eligibility.selected_channel_type != cinatoken_relay::CHANNEL_TYPE_OPENAI
        || eligibility.selected_channel_has_model_mapping
        || eligibility.selected_channel_has_custom_base_url
        || eligibility.selected_channel_has_organization
        || !eligibility.selected_channel_key_is_single
        || eligibility.selected_channel_has_extra_config
        || eligibility.selected_channel_has_wfp_worker
        || eligibility.selected_channel_uses_ai_gateway
        || eligibility.attempt_count != 1
        || eligibility.retry_times != 0
        || eligibility.model_fallback_configured
        || !eligibility.api_key_auth
        || !eligibility.openai_chat_route
        || !eligibility.non_streaming
        || eligibility.request_body.is_empty()
        || eligibility.request_body.len() > MAX_CANARY_REQUEST_BYTES
    {
        return Err(ContainerChatCanaryPlanError::IncompatibleRoute);
    }
    let idempotency_key = eligibility
        .idempotency_key
        .ok_or(ContainerChatCanaryPlanError::MissingIdempotencyKey)?;
    if !valid_idempotency_key(idempotency_key) {
        return Err(ContainerChatCanaryPlanError::InvalidIdempotencyKey);
    }
    let secret = env
        .secret(CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| value.as_bytes().len() >= MIN_IDEMPOTENCY_SECRET_BYTES)
        .ok_or(ContainerChatCanaryPlanError::Misconfigured)?;
    let scheduler = container_scheduler_runtime_status(env);
    if !scheduler.configured || !scheduler.valid {
        return Err(ContainerChatCanaryPlanError::Misconfigured);
    }
    let client_idempotency_hmac_sha256 = client_idempotency_hmac(
        secret.as_bytes(),
        eligibility.user_id,
        eligibility.token_id,
        eligibility.model,
        eligibility.selected_group,
        idempotency_key,
    )
    .map_err(|_| ContainerChatCanaryPlanError::Misconfigured)?;
    let client_request_sha256 = domain_hash(
        REQUEST_DOMAIN,
        &[
            eligibility.model.as_bytes(),
            eligibility.selected_group.as_bytes(),
            eligibility.request_body,
        ],
    );
    Ok(Some(ContainerChatCanaryPlan {
        input_sha256: sha256_hex(eligibility.request_body),
        request_body: eligibility.request_body.to_vec(),
        client_idempotency_hmac_sha256,
        client_request_sha256,
        deadline_seconds: config.deadline_seconds,
    }))
}

pub async fn replay_or_resume_container_chat_canary(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    plan: &ContainerChatCanaryPlan,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Option<Response>> {
    match lookup_relay_container_client_request(
        db,
        &plan.client_idempotency_hmac_sha256,
        &plan.client_request_sha256,
    )
    .await?
    {
        RelayContainerClientRequestLookup::NotFound => Ok(None),
        RelayContainerClientRequestLookup::RequestConflict => {
            conflict_response("idempotency_key_reused_with_different_request").map(Some)
        }
        RelayContainerClientRequestLookup::MatchingOperation(operation) => {
            if operation.input_sha256 != plan.input_sha256
                || operation.operation_kind != CONTAINER_CHAT_CANARY_OPERATION_KIND
                || operation.channel_id != audit.channel_id
                || operation.selected_group != audit.selected_group
            {
                return conflict_response("idempotency_operation_identity_conflict").map(Some);
            }
            resume_operation(env, db, context, operation, audit)
                .await
                .map(Some)
        }
    }
}

pub async fn execute_container_chat_canary(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    execution: ContainerChatCanaryExecution<'_>,
) -> worker::Result<Response> {
    let now = current_unix_seconds();
    let execution_deadline_at = now
        .saturating_add(execution.plan.deadline_seconds)
        .min(execution.billing_owner_lease_expires_at.saturating_sub(1));
    if execution.reservation_key.is_empty()
        || execution.billing_owner_generation <= 0
        || execution.billing_owner_lease_expires_at <= execution_deadline_at
        || execution_deadline_at <= now
    {
        return Err(canary_error(
            "container chat canary billing lease is invalid",
        ));
    }

    let input = put_container_input(
        env,
        execution.reservation_key,
        execution.billing_owner_generation,
        "application/json",
        &execution.plan.request_body,
    )
    .await?;
    if input.manifest.sha256 != execution.plan.input_sha256 {
        return Err(canary_error("container chat canary input digest diverged"));
    }

    let routing_secret = env
        .secret(CONTAINER_SCHEDULER_ROUTING_SECRET_ENV)
        .map(|value| value.to_string())
        .map_err(|_| canary_error("container shard routing secret is unavailable"))?;
    let tenant_id = format!("user:{}", execution.user_id);
    let shard = plan_container_shard(
        container_scheduler_runtime_status(env),
        routing_secret.as_bytes(),
        &tenant_id,
    )
    .map_err(|code| canary_error(&format!("container shard planning failed: {code}")))?;

    let provider_operation_id = format!(
        "provider-op-v1-{}",
        domain_hash(
            PROVIDER_OPERATION_DOMAIN,
            &[
                execution.reservation_key.as_bytes(),
                execution.plan.client_idempotency_hmac_sha256.as_bytes(),
                execution.plan.input_sha256.as_bytes(),
            ],
        )
    );
    let trace_id = format!(
        "trace-v1-{}",
        domain_hash(
            TRACE_DOMAIN,
            &[
                execution.reservation_key.as_bytes(),
                execution.plan.client_request_sha256.as_bytes(),
            ],
        )
    );
    let admission_sha256 = operation_admission_sha256(
        execution.reservation_key,
        execution.billing_owner_generation,
        execution.billing_owner_lease_expires_at,
        execution_deadline_at,
        &provider_operation_id,
        &input.manifest,
        &shard,
        &trace_id,
    );
    let reconciliation_id = domain_hash(
        RECONCILIATION_DOMAIN,
        &[
            execution.reservation_key.as_bytes(),
            admission_sha256.as_bytes(),
            execution.plan.client_request_sha256.as_bytes(),
        ],
    );
    let envelope = ContainerOperationEnvelope {
        protocol_version: 1,
        operation_id: execution.reservation_key.to_string(),
        operation_kind: CONTAINER_CHAT_CANARY_OPERATION_KIND.to_string(),
        owner_generation: execution.billing_owner_generation,
        owner_lease_expires_at: execution.billing_owner_lease_expires_at,
        execution_deadline_at,
        provider_operation_id: provider_operation_id.clone(),
        admission_sha256: admission_sha256.clone(),
        input: ContainerOperationInput {
            mode: "r2",
            sha256: input.manifest.sha256.clone(),
            size: input.manifest.size,
            content_type: input.manifest.content_type.clone(),
            request_object_key: input.manifest.object_key.clone(),
            object_version: input.manifest.object_version.clone(),
        },
        shard: shard.clone(),
        trace_id: trace_id.clone(),
    };
    let record = RelayContainerOperationRecord {
        reservation_key: execution.reservation_key,
        operation_id: execution.reservation_key,
        owner_generation: execution.billing_owner_generation,
        owner_lease_expires_at: execution.billing_owner_lease_expires_at,
        channel_id: execution.channel_id,
        selected_group: execution.selected_group,
        operation_kind: CONTAINER_CHAT_CANARY_OPERATION_KIND,
        provider_operation_id: &provider_operation_id,
        admission_sha256: &admission_sha256,
        protocol_version: 1,
        shard_contract_version: i64::from(shard.contract_version),
        ring_generation: i64::try_from(shard.ring_generation)
            .map_err(|_| canary_error("container ring generation is out of range"))?,
        shard_count: i64::from(shard.shard_count),
        shard_index: i64::from(shard.shard_index),
        instance_name: &shard.instance_name,
        execution_deadline_at,
        input_mode: "r2",
        input_object_key: &input.manifest.object_key,
        input_object_version: &input.manifest.object_version,
        input_sha256: &input.manifest.sha256,
        input_size: i64::try_from(input.manifest.size)
            .map_err(|_| canary_error("container input size is out of range"))?,
        input_content_type: &input.manifest.content_type,
        trace_id: &trace_id,
        client_idempotency_hmac_sha256: &execution.plan.client_idempotency_hmac_sha256,
        client_request_sha256: &execution.plan.client_request_sha256,
        reconciliation_id: &reconciliation_id,
        created_at: now,
    };
    match bind_relay_container_operation(db, record).await? {
        RelayContainerOperationWriteOutcome::Applied
        | RelayContainerOperationWriteOutcome::MatchingOperation => {}
        outcome => {
            return Err(canary_error(&format!(
                "container operation bind did not apply: {outcome:?}"
            )))
        }
    }
    let operation = relay_container_operation(db, execution.reservation_key)
        .await?
        .ok_or_else(|| canary_error("container operation readback is missing"))?;
    dispatch_or_query_operation(env, db, context, operation, &envelope, execution.audit).await
}

async fn resume_operation(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    match operation.status.as_str() {
        "completed" | "failed" => replay_terminal_operation(env, db, &operation).await,
        "prepared" => {
            let envelope = operation_envelope(&operation)?;
            dispatch_or_query_operation(env, db, context, operation, &envelope, audit).await
        }
        "dispatched" => {
            let envelope = operation_envelope(&operation)?;
            match query_operation_status(env, &envelope).await {
                Ok(outcome) => {
                    finish_controller_outcome(env, db, context, operation, outcome, audit).await
                }
                Err(_) => {
                    commit_recovery_required(
                        env,
                        db,
                        context,
                        operation,
                        audit,
                        "controller_status_unavailable",
                        None,
                    )
                    .await
                }
            }
        }
        "recovery_required" => {
            let envelope = operation_envelope(&operation)?;
            match query_operation_status(env, &envelope).await {
                Ok(outcome) if outcome.status == ContainerOperationStatus::Completed => {
                    finish_controller_outcome(env, db, context, operation, outcome, audit).await
                }
                _ => recovery_pending_response(&operation.operation_id, "recovery_required"),
            }
        }
        _ => Err(canary_error("container operation has an invalid state")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchFenceAction {
    Send,
    QueryOnly,
    RecoveryRequired,
}

fn dispatch_fence_action(outcome: RelayContainerOperationDispatchOutcome) -> DispatchFenceAction {
    match outcome {
        RelayContainerOperationDispatchOutcome::Applied => DispatchFenceAction::Send,
        RelayContainerOperationDispatchOutcome::AlreadyDispatched => DispatchFenceAction::QueryOnly,
        _ => DispatchFenceAction::RecoveryRequired,
    }
}

async fn dispatch_or_query_operation(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    envelope: &ContainerOperationEnvelope,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    let dispatch_outcome = mark_relay_container_operation_dispatched(
        db,
        &operation.reservation_key,
        &operation.operation_id,
        operation.owner_generation,
        &operation.admission_sha256,
        current_unix_seconds(),
    )
    .await?;
    let dispatch_error = match dispatch_fence_action(dispatch_outcome) {
        DispatchFenceAction::Send => dispatch_operation(env, envelope).await.err(),
        DispatchFenceAction::QueryOnly => None,
        DispatchFenceAction::RecoveryRequired => {
            return commit_recovery_required(
                env,
                db,
                context,
                operation,
                audit,
                "edge_dispatch_fence_failed",
                None,
            )
            .await
        }
    };

    let status = query_operation_status(env, envelope).await;
    let operation = relay_container_operation(db, &operation.reservation_key)
        .await?
        .ok_or_else(|| canary_error("container operation disappeared after dispatch"))?;
    match status {
        Ok(outcome) => finish_controller_outcome(env, db, context, operation, outcome, audit).await,
        Err(status_error) => {
            let code = if dispatch_error.is_some() {
                "controller_dispatch_and_status_unavailable"
            } else {
                "controller_status_unavailable"
            };
            worker::console_warn!(
                "container chat canary status query failed: {}; dispatch_error={:?}",
                status_error,
                dispatch_error
            );
            commit_recovery_required(env, db, context, operation, audit, code, None).await
        }
    }
}

async fn finish_controller_outcome(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    let code = match outcome.status {
        ContainerOperationStatus::Completed => {
            return settle_completed_operation(env, db, context, operation, outcome, audit).await
        }
        ContainerOperationStatus::Claimed | ContainerOperationStatus::Running => {
            "container_operation_pending"
        }
        ContainerOperationStatus::Failed => "container_failure_unresolved",
        ContainerOperationStatus::RecoveryRequired => "provider_ambiguous",
    };
    commit_recovery_required(env, db, context, operation, audit, code, outcome.result).await
}

async fn settle_completed_operation(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    let result = outcome
        .result
        .as_ref()
        .ok_or_else(|| canary_error("completed container operation has no result"))?;
    let attempt = outcome
        .provider_attempt
        .as_ref()
        .filter(|attempt| {
            attempt.attempt_generation == 1
                && attempt.status == ContainerProviderAttemptStatus::Succeeded
                && attempt.response_status == Some(outcome.http_status)
                && attempt.result.as_ref() == Some(result)
                && attempt.provider_usage_receipt_attached_at.is_some()
        })
        .ok_or_else(|| canary_error("completed provider attempt contract is invalid"))?;
    let receipt_sha256 = outcome
        .provider_usage_receipt_sha256
        .as_deref()
        .filter(|value| {
            outcome.status_contract_version == 3
                && attempt.provider_usage_receipt_sha256.as_deref() == Some(*value)
        })
        .ok_or_else(|| canary_error("provider usage receipt is unavailable"))?;
    let terminal_result = RelayContainerOperationResultRecord {
        object_key: &result.object_key,
        object_version: &result.object_version,
        sha256: &result.sha256,
        size: i64::try_from(result.size)
            .map_err(|_| canary_error("container result size is out of range"))?,
        content_type: &result.content_type,
    };
    let terminal = RelayContainerOperationTerminalRecord::Completed {
        response_status: i64::from(outcome.http_status),
        result: terminal_result,
    };
    let quote = quote_relay_container_provider_usage_settlement(
        db,
        &operation,
        terminal,
        receipt_sha256,
        &result.sha256,
        1,
    )
    .await?
    .ok_or_else(|| canary_error("provider usage settlement quote did not converge"))?;
    let result_identity = ContainerResultArtifactIdentity {
        operation_id: quote.identity.operation_id.clone(),
        owner_generation: quote.identity.owner_generation,
        provider_operation_id: quote.identity.provider_operation_id.clone(),
        admission_sha256: quote.identity.admission_sha256.clone(),
        attempt_generation: quote.identity.attempt_generation,
        egress_profile: quote.identity.egress_profile.clone(),
        egress_worker_version_id: quote.identity.egress_worker_version_id.clone(),
        usage_receipt_sha256: quote.identity.usage_receipt_sha256.clone(),
    };
    if result_identity.egress_profile != CONTAINER_CHAT_CANARY_EGRESS_PROFILE
        || inspect_container_result(env, &result_identity, result).await?
            != ContainerResultObjectState::Matching
    {
        return commit_recovery_required(
            env,
            db,
            context,
            operation,
            audit,
            "provider_result_divergent",
            Some(result.clone()),
        )
        .await;
    }
    let body = read_verified_container_result(env, result).await?;
    let (headers_json, headers_sha256) = canonical_container_client_response_headers(
        [("content-type", result.content_type.as_str())],
        &result.content_type,
    )?;
    let response = put_container_client_response(
        env,
        &operation.operation_id,
        operation.owner_generation,
        outcome.http_status,
        &headers_json,
        &headers_sha256,
        &result.content_type,
        &body,
    )
    .await?;
    let audit_payload = terminal_audit_payload(
        &operation,
        audit,
        "settle",
        Some(quote.final_quota),
        quote.prompt_tokens,
        quote.completion_tokens,
    )?;
    let audit_payload_sha256 = sha256_hex(audit_payload.as_bytes());
    let client_response = RelayContainerClientResponseRecord {
        status: i64::from(response.manifest.status),
        headers_json: &response.manifest.headers_json,
        headers_sha256: &response.manifest.headers_sha256,
        object_key: &response.manifest.body.object_key,
        object_version: &response.manifest.body.object_version,
        sha256: &response.manifest.body.sha256,
        size: i64::try_from(response.manifest.body.size)
            .map_err(|_| canary_error("client response size is out of range"))?,
        content_type: &response.manifest.body.content_type,
    };
    let receipt = require_financial_terminal(
        commit_relay_container_financial_terminal(
            db,
            RelayContainerFinancialTerminalCommand {
                reservation_key: &operation.reservation_key,
                operation_id: &operation.operation_id,
                operation_owner_generation: operation.owner_generation,
                expected_operation_status: operation_expected_status(&operation)?,
                admission_sha256: &operation.admission_sha256,
                billing_owner_generation: financial_owner_generation(&operation)?,
                terminal,
                action: RelayContainerFinancialTerminalAction::Settle {
                    final_quota: quote.final_quota,
                    finalization_reason: "container_provider_usage_settlement",
                    provider_usage_receipt_sha256: receipt_sha256,
                    provider_result_sha256: &result.sha256,
                    provider_attempt_generation: 1,
                },
                client_response: Some(client_response),
                audit_payload_json: &audit_payload,
                audit_payload_sha256: &audit_payload_sha256,
                committed_at: current_unix_seconds(),
            },
        )
        .await?,
    )?;
    crate::quota_coordinator::observe_or_defer_committed_relay_billing_reservation(
        context,
        env,
        db,
        &operation.reservation_key,
    )
    .await;
    match relay_container_provider_usage_receipt_readback(db, &operation, &receipt).await? {
        RelayContainerProviderUsageReceiptReadback::Matching(identity)
            if identity == quote.identity => {}
        _ => {
            return Err(canary_error(
                "provider usage receipt readback did not converge after settlement",
            ))
        }
    }
    let mut response = replay_receipt_client_response(env, &receipt)
        .await?
        .ok_or_else(|| canary_error("exact client response replay is unavailable"))?;
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

async fn commit_recovery_required(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    audit: ContainerChatCanaryAudit<'_>,
    response_code: &'static str,
    result: Option<ContainerArtifactManifest>,
) -> worker::Result<Response> {
    if operation.status == "recovery_required" {
        return recovery_pending_response(&operation.operation_id, response_code);
    }
    let result_record = match result.as_ref() {
        Some(result) => Some(RelayContainerOperationResultRecord {
            object_key: result.object_key.as_str(),
            object_version: result.object_version.as_str(),
            sha256: result.sha256.as_str(),
            size: i64::try_from(result.size)
                .map_err(|_| canary_error("container recovery result size is out of range"))?,
            content_type: result.content_type.as_str(),
        }),
        None => None,
    };
    let terminal = RelayContainerOperationTerminalRecord::RecoveryRequired {
        response_code,
        result: result_record,
    };
    let audit_payload = terminal_audit_payload(&operation, audit, "recovery_required", None, 0, 0)?;
    let audit_payload_sha256 = sha256_hex(audit_payload.as_bytes());
    require_financial_terminal(
        commit_relay_container_financial_terminal(
            db,
            RelayContainerFinancialTerminalCommand {
                reservation_key: &operation.reservation_key,
                operation_id: &operation.operation_id,
                operation_owner_generation: operation.owner_generation,
                expected_operation_status: operation_expected_status(&operation)?,
                admission_sha256: &operation.admission_sha256,
                billing_owner_generation: financial_owner_generation(&operation)?,
                terminal,
                action: RelayContainerFinancialTerminalAction::RecoveryRequired {
                    finalization_reason: response_code,
                },
                client_response: None,
                audit_payload_json: &audit_payload,
                audit_payload_sha256: &audit_payload_sha256,
                committed_at: current_unix_seconds(),
            },
        )
        .await?,
    )?;
    crate::quota_coordinator::observe_or_defer_committed_relay_billing_reservation(
        context,
        env,
        db,
        &operation.reservation_key,
    )
    .await;
    recovery_pending_response(&operation.operation_id, response_code)
}

async fn replay_terminal_operation(
    env: &Env,
    db: &D1Database,
    operation: &RelayContainerOperation,
) -> worker::Result<Response> {
    let receipt =
        relay_container_financial_terminal_receipt_for_operation(db, &operation.operation_id)
            .await?
            .ok_or_else(|| canary_error("container financial terminal receipt is missing"))?;
    if receipt.billing_action == "settle" {
        match relay_container_provider_usage_receipt_readback(db, operation, &receipt).await? {
            RelayContainerProviderUsageReceiptReadback::Matching(_) => {}
            _ => {
                return Err(canary_error(
                    "provider usage receipt replay readback did not converge",
                ))
            }
        }
    }
    let mut response = replay_receipt_client_response(env, &receipt)
        .await?
        .ok_or_else(|| canary_error("terminal client response is unavailable"))?;
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn operation_expected_status(
    operation: &RelayContainerOperation,
) -> worker::Result<RelayContainerOperationExpectedStatus> {
    match operation.status.as_str() {
        "prepared" => Ok(RelayContainerOperationExpectedStatus::Prepared),
        "dispatched" => Ok(RelayContainerOperationExpectedStatus::Dispatched),
        "recovery_required" => Ok(RelayContainerOperationExpectedStatus::RecoveryRequired),
        _ => Err(canary_error(
            "container operation is not eligible for financial terminal",
        )),
    }
}

fn financial_owner_generation(operation: &RelayContainerOperation) -> worker::Result<i64> {
    financial_owner_generation_for(operation.status.as_str(), operation.owner_generation)
}

fn financial_owner_generation_for(status: &str, owner_generation: i64) -> worker::Result<i64> {
    match status {
        "prepared" | "dispatched" => Ok(owner_generation),
        "recovery_required" => owner_generation
            .checked_add(1)
            .ok_or_else(|| canary_error("container billing owner generation overflowed")),
        _ => Err(canary_error(
            "container operation has no financial owner generation",
        )),
    }
}

fn require_financial_terminal(
    outcome: RelayContainerFinancialTerminalOutcome,
) -> worker::Result<crate::d1_repositories::RelayContainerFinancialTerminalReceipt> {
    match outcome {
        RelayContainerFinancialTerminalOutcome::Applied(receipt)
        | RelayContainerFinancialTerminalOutcome::MatchingReplay(receipt) => Ok(receipt),
        outcome => Err(canary_error(&format!(
            "container financial terminal did not converge: {outcome:?}"
        ))),
    }
}

fn operation_envelope(
    operation: &RelayContainerOperation,
) -> worker::Result<ContainerOperationEnvelope> {
    Ok(ContainerOperationEnvelope {
        protocol_version: u32::try_from(operation.protocol_version)
            .map_err(|_| canary_error("container protocol version is invalid"))?,
        operation_id: operation.operation_id.clone(),
        operation_kind: operation.operation_kind.clone(),
        owner_generation: operation.owner_generation,
        owner_lease_expires_at: operation.owner_lease_expires_at,
        execution_deadline_at: operation.execution_deadline_at,
        provider_operation_id: operation.provider_operation_id.clone(),
        admission_sha256: operation.admission_sha256.clone(),
        input: ContainerOperationInput {
            mode: "r2",
            sha256: operation.input_sha256.clone(),
            size: u64::try_from(operation.input_size)
                .map_err(|_| canary_error("container input size is invalid"))?,
            content_type: operation.input_content_type.clone(),
            request_object_key: operation.input_object_key.clone(),
            object_version: operation.input_object_version.clone(),
        },
        shard: cinatoken_sharding::ShardPlan {
            contract_version: u32::try_from(operation.shard_contract_version)
                .map_err(|_| canary_error("container shard contract is invalid"))?,
            ring_generation: u64::try_from(operation.ring_generation)
                .map_err(|_| canary_error("container ring generation is invalid"))?,
            shard_count: u16::try_from(operation.shard_count)
                .map_err(|_| canary_error("container shard count is invalid"))?,
            shard_index: u16::try_from(operation.shard_index)
                .map_err(|_| canary_error("container shard index is invalid"))?,
            instance_name: operation.instance_name.clone(),
        },
        trace_id: operation.trace_id.clone(),
    })
}

fn terminal_audit_payload(
    operation: &RelayContainerOperation,
    audit: ContainerChatCanaryAudit<'_>,
    decision: &str,
    final_quota: Option<i64>,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> worker::Result<String> {
    serde_json::to_string(&json!({
        "channel_id": audit.channel_id,
        "client_ip_sha256": optional_sha256(audit.client_ip),
        "completion_tokens": completion_tokens,
        "decision": decision,
        "endpoint_path": audit.endpoint_path,
        "final_quota": final_quota,
        "model": audit.model,
        "operation_id": operation.operation_id,
        "prompt_tokens": prompt_tokens,
        "request_id_sha256": optional_sha256(audit.request_id),
        "schema_version": 1,
        "selected_group": audit.selected_group,
        "token_id": audit.token_id,
        "transport": "container_chat_canary",
        "user_id": audit.user_id,
    }))
    .map_err(|err| canary_error(&format!("container audit serialization failed: {err}")))
}

fn operation_admission_sha256(
    operation_id: &str,
    owner_generation: i64,
    owner_lease_expires_at: i64,
    execution_deadline_at: i64,
    provider_operation_id: &str,
    input: &ContainerArtifactManifest,
    shard: &cinatoken_sharding::ShardPlan,
    trace_id: &str,
) -> String {
    let fields = [
        operation_id.to_string(),
        owner_generation.to_string(),
        owner_lease_expires_at.to_string(),
        execution_deadline_at.to_string(),
        provider_operation_id.to_string(),
        input.object_key.clone(),
        input.object_version.clone(),
        input.sha256.clone(),
        input.size.to_string(),
        input.content_type.clone(),
        shard.contract_version.to_string(),
        shard.ring_generation.to_string(),
        shard.shard_count.to_string(),
        shard.shard_index.to_string(),
        shard.instance_name.clone(),
        trace_id.to_string(),
    ];
    let refs = fields
        .iter()
        .map(|field| field.as_bytes())
        .collect::<Vec<_>>();
    domain_hash(ADMISSION_DOMAIN, &refs)
}

fn container_chat_canary_runtime_config(env: &Env) -> Option<ContainerChatCanaryRuntimeConfig> {
    parse_runtime_config(
        env.var(CONTAINER_CHAT_CANARY_TOKEN_IDS_ENV)
            .ok()
            .map(|value| value.to_string())
            .as_deref(),
        env.var(CONTAINER_CHAT_CANARY_CHANNEL_ID_ENV)
            .ok()
            .map(|value| value.to_string())
            .as_deref(),
        env.var(CONTAINER_CHAT_CANARY_MODEL_ENV)
            .ok()
            .map(|value| value.to_string())
            .as_deref(),
        env.var(CONTAINER_CHAT_CANARY_DEADLINE_SECONDS_ENV)
            .ok()
            .map(|value| value.to_string())
            .as_deref(),
    )
}

fn parse_runtime_config(
    token_ids: Option<&str>,
    channel_id: Option<&str>,
    model: Option<&str>,
    deadline_seconds: Option<&str>,
) -> Option<ContainerChatCanaryRuntimeConfig> {
    let mut parsed_tokens = Vec::new();
    for value in token_ids?.split(',') {
        let value = value.trim();
        let parsed = value.parse::<i64>().ok()?;
        if parsed.to_string() != value {
            return None;
        }
        parsed_tokens.push(parsed);
    }
    parsed_tokens.sort_unstable();
    if parsed_tokens
        .windows(2)
        .any(|tokens| tokens[0] == tokens[1])
    {
        return None;
    }
    let channel_id = channel_id?.parse::<i64>().ok()?;
    let model = model?.trim();
    let deadline_seconds = match deadline_seconds {
        Some(value) => value.parse::<i64>().ok()?,
        None => DEFAULT_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS,
    };
    if parsed_tokens.is_empty()
        || parsed_tokens.len() > MAX_CONTAINER_CHAT_CANARY_TOKENS
        || parsed_tokens.iter().any(|value| *value <= 0)
        || channel_id <= 0
        || model.is_empty()
        || model.len() > MAX_CONTAINER_CHAT_CANARY_MODEL_BYTES
        || model.chars().any(char::is_control)
        || !(MIN_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS
            ..=MAX_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS)
            .contains(&deadline_seconds)
    {
        return None;
    }
    Some(ContainerChatCanaryRuntimeConfig {
        token_ids: parsed_tokens,
        channel_id,
        model: model.to_string(),
        deadline_seconds,
    })
}

fn client_idempotency_hmac(
    secret: &[u8],
    user_id: i64,
    token_id: i64,
    model: &str,
    selected_group: &str,
    idempotency_key: &str,
) -> Result<String, ()> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| ())?;
    mac.update(IDEMPOTENCY_DOMAIN);
    for field in [
        user_id.to_string(),
        token_id.to_string(),
        model.to_string(),
        selected_group.to_string(),
        idempotency_key.to_string(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn domain_hash(domain: &[u8], fields: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain);
    for field in fields {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    format!("{:x}", digest.finalize())
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn optional_sha256(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| sha256_hex(value.as_bytes()))
}

fn valid_idempotency_key(value: &str) -> bool {
    value == value.trim()
        && (MIN_IDEMPOTENCY_KEY_BYTES..=MAX_IDEMPOTENCY_KEY_BYTES).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn current_unix_seconds() -> i64 {
    i64::try_from(worker::Date::now().as_millis() / 1_000).unwrap_or(i64::MAX)
}

fn conflict_response(code: &str) -> worker::Result<Response> {
    no_store_json_response(
        json!({
            "error": {
                "code": code,
                "message": "the idempotency key is already bound to a different request",
                "type": "invalid_request_error",
            }
        }),
        409,
    )
}

fn recovery_pending_response(operation_id: &str, code: &str) -> worker::Result<Response> {
    let mut response = no_store_json_response(
        json!({
            "error": {
                "code": code,
                "message": "the container operation is durably pending reconciliation",
                "type": "operation_recovery_required",
            },
            "operation_id": operation_id,
            "status": "recovery_required",
        }),
        202,
    )?;
    response.headers_mut().set("retry-after", "5")?;
    Ok(response)
}

fn no_store_json_response(value: Value, status: u16) -> worker::Result<Response> {
    let mut headers = Headers::new();
    headers.set("cache-control", "no-store")?;
    headers.set("content-type", "application/json; charset=utf-8")?;
    let mut response = Response::from_json(&value)?
        .with_status(status)
        .with_headers(headers);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn canary_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_config_requires_a_bounded_explicit_cohort() {
        let config =
            parse_runtime_config(Some("9, 7"), Some("11"), Some("gpt-canary"), Some("120"))
                .unwrap();
        assert_eq!(config.token_ids, vec![7, 9]);
        assert_eq!(config.channel_id, 11);
        assert_eq!(config.model, "gpt-canary");
        assert_eq!(config.deadline_seconds, 120);

        assert!(
            parse_runtime_config(Some(""), Some("11"), Some("gpt-canary"), Some("120")).is_none()
        );
        assert!(
            parse_runtime_config(Some("7"), Some("0"), Some("gpt-canary"), Some("120")).is_none()
        );
        assert!(parse_runtime_config(Some("7"), Some("11"), Some(""), Some("120")).is_none());
        assert!(
            parse_runtime_config(Some("7"), Some("11"), Some("gpt-canary"), Some("301")).is_none()
        );
        assert!(
            parse_runtime_config(Some("7"), Some("11"), Some("gpt-canary"), Some("invalid"))
                .is_none()
        );
        assert!(
            parse_runtime_config(Some("7,7"), Some("11"), Some("gpt-canary"), Some("120"))
                .is_none()
        );
        assert!(
            parse_runtime_config(Some("07"), Some("11"), Some("gpt-canary"), Some("120")).is_none()
        );
    }

    #[test]
    fn already_dispatched_is_query_only_and_recovery_advances_the_billing_fence() {
        assert_eq!(
            dispatch_fence_action(RelayContainerOperationDispatchOutcome::Applied),
            DispatchFenceAction::Send
        );
        assert_eq!(
            dispatch_fence_action(RelayContainerOperationDispatchOutcome::AlreadyDispatched),
            DispatchFenceAction::QueryOnly
        );
        assert_eq!(financial_owner_generation_for("dispatched", 4).unwrap(), 4);
        assert_eq!(
            financial_owner_generation_for("recovery_required", 4).unwrap(),
            5
        );
    }

    #[test]
    fn idempotency_identity_is_tenant_scoped_and_request_conflicts_are_visible() {
        let secret = [7_u8; 32];
        let first =
            client_idempotency_hmac(&secret, 1, 2, "gpt", "default", "request-123").unwrap();
        let replay =
            client_idempotency_hmac(&secret, 1, 2, "gpt", "default", "request-123").unwrap();
        let other_token =
            client_idempotency_hmac(&secret, 1, 3, "gpt", "default", "request-123").unwrap();
        assert_eq!(first, replay);
        assert_ne!(first, other_token);
        assert_eq!(first.len(), 64);
        assert!(valid_idempotency_key("request-123"));
        assert!(!valid_idempotency_key("short"));
        assert!(!valid_idempotency_key(" request-123"));
    }

    #[test]
    fn provider_body_freeze_preserves_the_client_request_identity() {
        let original_body = br#"{"model":"gpt","client_only":true}"#;
        let provider_body = br#"{"model":"gpt"}"#;
        let plan = ContainerChatCanaryPlan {
            request_body: original_body.to_vec(),
            input_sha256: sha256_hex(original_body),
            client_idempotency_hmac_sha256: "a".repeat(64),
            client_request_sha256: domain_hash(REQUEST_DOMAIN, &[original_body]),
            deadline_seconds: 120,
        };
        let client_request_sha256 = plan.client_request_sha256.clone();
        let client_idempotency_hmac_sha256 = plan.client_idempotency_hmac_sha256.clone();

        let frozen = plan.freeze_provider_request_body(provider_body).unwrap();

        assert_eq!(frozen.request_body, provider_body);
        assert_eq!(frozen.input_sha256, sha256_hex(provider_body));
        assert_eq!(frozen.client_request_sha256, client_request_sha256);
        assert_eq!(
            frozen.client_idempotency_hmac_sha256,
            client_idempotency_hmac_sha256
        );
    }

    #[test]
    fn tracked_canary_cohort_is_empty_and_disabled_everywhere() {
        let config = include_str!("../../../wrangler.toml").replace("\r\n", "\n");
        let (default, environment_overrides) = config.split_once("\n[env.staging]\n").unwrap();
        let (staging, production) = environment_overrides
            .split_once("\n[env.production]\n")
            .unwrap();
        for scope in [default, staging, production] {
            assert!(scope.contains("CONTAINER_CHAT_CANARY_ENABLED = \"false\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_TOKEN_IDS = \"\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_CHANNEL_ID = \"0\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_MODEL = \"\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_DEADLINE_SECONDS = \"120\""));
        }
    }
}
