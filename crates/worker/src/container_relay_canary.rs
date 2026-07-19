//! Default-off Edge integration for the non-streaming Container chat canary.
//!
//! The module deliberately owns no provider credential. It freezes one
//! transformed request in R2, atomically admits billing and operation ownership
//! in D1 before dispatch, and only returns bytes after exact durable readback.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::{Context, D1Database, Env, Headers, Response};

use crate::container_artifacts::{
    inspect_container_result, put_container_client_response, put_container_input,
    read_verified_container_provider_response_evidence, read_verified_container_response_artifact,
    read_verified_container_result, ContainerArtifactManifest,
    ContainerProviderResponseEvidenceIdentity, ContainerResponseArtifactIdentity,
    ContainerResultArtifactIdentity, ContainerResultObjectState,
};
use crate::container_controller::{
    dispatch_operation, probe as probe_container_controller, query_operation_status,
    ContainerControllerProbe, ContainerOperationEnvelope, ContainerOperationInput,
    ContainerOperationOutcome, ContainerOperationStatus, ContainerProviderAttemptStatus,
    ContainerProviderResponseArtifactStatus, ContainerProviderResponseArtifactsOutcome,
};
use crate::container_reconciliation::{
    inspect_receipt_client_response, replay_receipt_client_response, ContainerResponseObservation,
};
use crate::container_scheduler::{
    container_operation_runtime_status, container_scheduler_enabled,
    container_scheduler_routing_secret_configured, container_scheduler_runtime_status,
    plan_container_shard, CONTAINER_SCHEDULER_ROUTING_SECRET_ENV,
};
use crate::d1_repositories::{
    admit_relay_container_operation_atomic, commit_relay_container_financial_terminal,
    lookup_relay_container_client_request, mark_relay_container_operation_dispatched,
    quote_relay_container_provider_usage_settlement, relay_billing_reservation,
    relay_container_atomic_admission_schema_ready, relay_container_atomic_admission_sha256,
    relay_container_atomic_reconciliation_id, relay_container_client_response_artifact,
    relay_container_client_response_artifact_integrity_valid,
    relay_container_financial_terminal_receipt_for_operation,
    relay_container_financial_terminal_v2_schema_ready, relay_container_operation,
    relay_container_provider_response_evidence_exists,
    relay_container_provider_usage_receipt_readback, RelayBillingRequestAccounting,
    RelayBillingReservation, RelayBillingReservationRecord, RelayContainerAtomicAdmissionOutcome,
    RelayContainerAtomicAdmissionRecord, RelayContainerClientRequestLookup,
    RelayContainerClientResponseArtifactRecord, RelayContainerClientResponseRecord,
    RelayContainerFinancialTerminalAction, RelayContainerFinancialTerminalCommand,
    RelayContainerFinancialTerminalOutcome, RelayContainerOperation,
    RelayContainerOperationDispatchOutcome, RelayContainerOperationExpectedStatus,
    RelayContainerOperationRecord, RelayContainerOperationResultRecord,
    RelayContainerOperationTerminalRecord, RelayContainerProviderResponseBindingRecord,
    RelayContainerProviderUsageReceiptReadback, RelayContainerReconciliationLease,
    RelayContainerScheduledTerminalizationFence, RELAY_CONTAINER_ATOMIC_ADMISSION_OWNER_GENERATION,
};

pub const CONTAINER_CHAT_CANARY_TOKEN_IDS_ENV: &str = "CONTAINER_CHAT_CANARY_TOKEN_IDS";
pub const CONTAINER_CHAT_CANARY_CHANNEL_ID_ENV: &str = "CONTAINER_CHAT_CANARY_CHANNEL_ID";
pub const CONTAINER_CHAT_CANARY_MODEL_ENV: &str = "CONTAINER_CHAT_CANARY_MODEL";
pub const CONTAINER_CHAT_CANARY_DEADLINE_SECONDS_ENV: &str =
    "CONTAINER_CHAT_CANARY_DEADLINE_SECONDS";
pub const CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV: &str =
    "CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET";
pub const CONTAINER_CHAT_CANARY_IDEMPOTENCY_PREVIOUS_SECRET_ENV: &str =
    "CONTAINER_CHAT_CANARY_IDEMPOTENCY_PREVIOUS_SECRET";
pub const CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED_ENV: &str =
    "CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED";
pub const CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED_ENV: &str =
    "CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED";

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
    client_idempotency_hmac_aliases: Vec<String>,
    client_request_sha256: String,
    deadline_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerChatCanaryReplayIdentity {
    client_idempotency_hmac_sha256: Vec<String>,
    client_request_sha256: String,
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
    pub model: &'a str,
    pub endpoint_path: &'a str,
}

pub struct ContainerChatCanaryExecution<'a> {
    pub billing: ContainerChatCanaryBillingContract<'a>,
    pub selected_group: &'a str,
    pub channel_id: i64,
    pub selected_channel_type: i32,
    pub selected_snapshot_key: &'a str,
    pub plan: &'a ContainerChatCanaryPlan,
    pub audit: ContainerChatCanaryAudit<'a>,
}

#[derive(Debug, Clone, Copy)]
pub struct ContainerChatCanaryBillingContract<'a> {
    pub reservation_key: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub model_name: &'a str,
    pub endpoint_path: &'a str,
    pub request_id_hash: &'a str,
    pub contract_hash: &'a str,
    pub billing_kind: &'a str,
    pub billing_snapshot_json: &'a str,
    pub candidate_group_count: i64,
    pub reservation_strategy: &'a str,
    pub pre_consumed_quota: i64,
    pub lease_seconds: i64,
}

pub fn container_chat_canary_compiled() -> bool {
    CONTAINER_CHAT_CANARY_OPERATION_KIND == "chat_completions_canary"
        && CONTAINER_CHAT_CANARY_EGRESS_PROFILE == "openai-chat-completions-canary-v1"
        && MAX_CANARY_REQUEST_BYTES
            == crate::container_artifacts::MAX_CONTAINER_CLIENT_RESPONSE_BYTES
        && MAX_CONTAINER_CHAT_CANARY_DEADLINE_SECONDS <= 300
        && MIN_IDEMPOTENCY_SECRET_BYTES >= 32
}

/// The atomic admission implementation is compiled separately below. This
/// cutover gate remains closed until migration rollout, remote readiness, and
/// canary evidence have all been approved for production traffic.
pub fn container_chat_canary_admission_compiled() -> bool {
    false
}

pub fn container_chat_canary_atomic_admission_compiled() -> bool {
    true
}

pub fn container_chat_canary_replay_compiled() -> bool {
    true
}

pub fn container_chat_canary_replay_only_enabled(env: &Env) -> bool {
    runtime_gate_enabled(env, CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED_ENV)
}

pub fn container_chat_canary_prepared_resume_enabled(env: &Env) -> bool {
    runtime_gate_enabled(env, CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED_ENV)
}

pub fn container_chat_canary_current_idempotency_secret_configured(env: &Env) -> bool {
    idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV).is_some()
}

pub fn container_chat_canary_previous_idempotency_secret_configured(env: &Env) -> bool {
    idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_PREVIOUS_SECRET_ENV).is_some()
}

pub fn container_chat_canary_replay_cohort_configured(env: &Env) -> bool {
    container_chat_canary_runtime_config(env).is_some()
}

pub fn container_chat_canary_replay_only_cohort_active(
    env: &Env,
    route_eligible: bool,
    token_id: i64,
    model: &str,
) -> Result<bool, ContainerChatCanaryPlanError> {
    if !route_eligible || !container_chat_canary_replay_only_enabled(env) {
        return Ok(false);
    }
    let config = container_chat_canary_runtime_config(env)
        .ok_or(ContainerChatCanaryPlanError::Misconfigured)?;
    Ok(config.token_ids.contains(&token_id) && config.model == model)
}

pub fn plan_container_chat_canary_replay_identity(
    env: &Env,
    user_id: i64,
    token_id: i64,
    model: &str,
    idempotency_key: &str,
    request_body: &[u8],
) -> Result<ContainerChatCanaryReplayIdentity, ContainerChatCanaryPlanError> {
    let current = idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV);
    let previous = idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_PREVIOUS_SECRET_ENV);
    build_container_chat_canary_replay_identity(
        current.as_deref(),
        previous.as_deref(),
        user_id,
        token_id,
        model,
        idempotency_key,
        request_body,
    )
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
    let secret = idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_SECRET_ENV)
        .ok_or(ContainerChatCanaryPlanError::Misconfigured)?;
    let scheduler = container_scheduler_runtime_status(env);
    if !scheduler.configured || !scheduler.valid {
        return Err(ContainerChatCanaryPlanError::Misconfigured);
    }
    let previous = idempotency_secret(env, CONTAINER_CHAT_CANARY_IDEMPOTENCY_PREVIOUS_SECRET_ENV);
    let replay_identity = build_container_chat_canary_replay_identity(
        Some(&secret),
        previous.as_deref(),
        eligibility.user_id,
        eligibility.token_id,
        eligibility.model,
        idempotency_key,
        eligibility.request_body,
    )
    .map_err(|_| ContainerChatCanaryPlanError::Misconfigured)?;
    let client_idempotency_hmac_sha256 = replay_identity
        .client_idempotency_hmac_sha256
        .first()
        .cloned()
        .ok_or(ContainerChatCanaryPlanError::Misconfigured)?;
    Ok(Some(ContainerChatCanaryPlan {
        input_sha256: sha256_hex(eligibility.request_body),
        request_body: eligibility.request_body.to_vec(),
        client_idempotency_hmac_sha256,
        client_idempotency_hmac_aliases: replay_identity.client_idempotency_hmac_sha256,
        client_request_sha256: replay_identity.client_request_sha256,
        deadline_seconds: config.deadline_seconds,
    }))
}

pub async fn replay_or_resume_container_chat_canary(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    identity: &ContainerChatCanaryReplayIdentity,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Option<Response>> {
    if !relay_container_atomic_admission_schema_ready(db).await?
        || !relay_container_financial_terminal_v2_schema_ready(db).await?
    {
        return Err(canary_error(
            "container chat canary replay schema is unavailable",
        ));
    }
    let mut matched = None;
    for client_hmac in &identity.client_idempotency_hmac_sha256 {
        match lookup_relay_container_client_request(
            db,
            client_hmac,
            &identity.client_request_sha256,
        )
        .await?
        {
            RelayContainerClientRequestLookup::NotFound => {}
            RelayContainerClientRequestLookup::RequestConflict => {
                return conflict_response("idempotency_key_reused_with_different_request").map(Some)
            }
            RelayContainerClientRequestLookup::ImmutableIdentityConflict => {
                return Err(canary_error(
                    "container chat canary idempotency authority is inconsistent",
                ))
            }
            RelayContainerClientRequestLookup::MatchingOperation(operation) => {
                if replay_operation_identity_conflicts(
                    matched
                        .as_ref()
                        .map(|winner: &RelayContainerOperation| winner.operation_id.as_str()),
                    &operation.operation_kind,
                    &operation.operation_id,
                ) {
                    return conflict_response("idempotency_operation_identity_conflict").map(Some);
                }
                matched = Some(operation);
            }
        }
    }
    let Some(operation) = matched else {
        return Ok(None);
    };
    resume_operation(env, db, context, operation, audit)
        .await
        .map(Some)
}

pub async fn execute_container_chat_canary(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    execution: ContainerChatCanaryExecution<'_>,
) -> worker::Result<Response> {
    if !container_chat_canary_admission_compiled()
        || !container_scheduler_enabled(env)
        || !container_operation_runtime_status(env).cutover_ready()
        || !relay_container_atomic_admission_schema_ready(db).await?
        || !relay_container_financial_terminal_v2_schema_ready(db).await?
    {
        return Err(canary_error(
            "container chat canary atomic admission is unavailable",
        ));
    }
    let owner_generation = RELAY_CONTAINER_ATOMIC_ADMISSION_OWNER_GENERATION;
    let input = put_container_input(
        env,
        execution.billing.reservation_key,
        owner_generation,
        "application/json",
        &execution.plan.request_body,
    )
    .await?;
    if input.manifest.sha256 != execution.plan.input_sha256 {
        return Err(canary_error("container chat canary input digest diverged"));
    }

    let now = current_unix_seconds();
    let owner_lease_expires_at = now.saturating_add(execution.billing.lease_seconds);
    let execution_deadline_at = now
        .saturating_add(execution.plan.deadline_seconds)
        .min(owner_lease_expires_at.saturating_sub(1));
    if execution.billing.reservation_key.is_empty()
        || execution.billing.lease_seconds <= execution.plan.deadline_seconds
        || owner_lease_expires_at <= execution_deadline_at
        || execution_deadline_at <= now
    {
        return Err(canary_error(
            "container chat canary billing lease is invalid",
        ));
    }

    let routing_secret = env
        .secret(CONTAINER_SCHEDULER_ROUTING_SECRET_ENV)
        .map(|value| value.to_string())
        .map_err(|_| canary_error("container shard routing secret is unavailable"))?;
    let tenant_id = format!("user:{}", execution.billing.user_id);
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
                execution.billing.reservation_key.as_bytes(),
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
                execution.billing.reservation_key.as_bytes(),
                execution.plan.client_request_sha256.as_bytes(),
            ],
        )
    );
    let admission_sha256 = operation_admission_sha256(
        execution.billing.reservation_key,
        owner_generation,
        owner_lease_expires_at,
        execution_deadline_at,
        &provider_operation_id,
        &input.manifest,
        &shard,
        &trace_id,
    );
    let reservation = RelayBillingReservationRecord {
        reservation_key: execution.billing.reservation_key,
        user_id: execution.billing.user_id,
        token_id: execution.billing.token_id,
        model_name: execution.billing.model_name,
        endpoint_path: execution.billing.endpoint_path,
        request_id_hash: execution.billing.request_id_hash,
        expr_hash: execution.billing.contract_hash,
        billing_kind: execution.billing.billing_kind,
        billing_snapshot_json: execution.billing.billing_snapshot_json,
        candidate_group_count: execution.billing.candidate_group_count,
        reservation_strategy: execution.billing.reservation_strategy,
        pre_consumed_quota: execution.billing.pre_consumed_quota,
        created_at: now,
        lease_expires_at: owner_lease_expires_at,
    };
    let placeholder_reconciliation_id = "0".repeat(64);
    let operation = RelayContainerOperationRecord {
        reservation_key: execution.billing.reservation_key,
        operation_id: execution.billing.reservation_key,
        owner_generation,
        owner_lease_expires_at,
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
        reconciliation_id: &placeholder_reconciliation_id,
        created_at: now,
    };
    let client_idempotency_hmac_aliases = execution
        .plan
        .client_idempotency_hmac_aliases
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let provisional = RelayContainerAtomicAdmissionRecord {
        reservation,
        operation,
        client_idempotency_hmac_aliases: &client_idempotency_hmac_aliases,
        selected_channel_type: i64::from(execution.selected_channel_type),
        selected_snapshot_key: execution.selected_snapshot_key,
        selected_at: now,
    };
    let atomic_admission_sha256 = relay_container_atomic_admission_sha256(&provisional);
    let reconciliation_id = relay_container_atomic_reconciliation_id(&atomic_admission_sha256)?;
    let operation = RelayContainerOperationRecord {
        reconciliation_id: &reconciliation_id,
        ..operation
    };
    let admission = RelayContainerAtomicAdmissionRecord {
        operation,
        ..provisional
    };
    debug_assert_eq!(
        relay_container_atomic_admission_sha256(&admission),
        atomic_admission_sha256
    );

    let outcome = admit_relay_container_operation_atomic(db, admission).await?;
    let applied = matches!(&outcome, RelayContainerAtomicAdmissionOutcome::Applied(_));
    let operation = match outcome {
        RelayContainerAtomicAdmissionOutcome::Applied(operation)
        | RelayContainerAtomicAdmissionOutcome::MatchingResumable(operation)
        | RelayContainerAtomicAdmissionOutcome::TerminalReplay(operation) => operation,
        RelayContainerAtomicAdmissionOutcome::RequestConflict => {
            return conflict_response("idempotency_key_reused_with_different_request")
        }
        RelayContainerAtomicAdmissionOutcome::ImmutableIdentityConflict => {
            return Err(canary_error(
                "container chat canary atomic admission authority is inconsistent",
            ))
        }
    };
    crate::quota_coordinator::observe_or_defer_committed_relay_billing_reservation(
        context,
        env,
        db,
        &operation.reservation_key,
    )
    .await;
    if applied {
        let envelope = operation_envelope(&operation)?;
        dispatch_or_query_operation(env, db, context, operation, &envelope, execution.audit).await
    } else {
        resume_operation(env, db, context, operation, execution.audit).await
    }
}

async fn resume_operation(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    let operation_runtime = container_operation_runtime_status(env);
    let prepared_resume_runtime_ready = if operation.status == "prepared" {
        prepared_resume_runtime_ready(env).await
    } else {
        false
    };
    let action = replay_operation_action(
        &operation.status,
        operation_runtime.exact_response_replay_enabled && env.bucket("FILE_BUCKET").is_ok(),
        operation_runtime.replay_ready(),
        prepared_resume_runtime_ready,
    );
    match action {
        ReplayOperationAction::ReplayTerminal => {
            replay_terminal_operation(env, db, &operation).await
        }
        ReplayOperationAction::DispatchPrepared => {
            let envelope = operation_envelope(&operation)?;
            dispatch_or_query_operation(env, db, context, operation, &envelope, audit).await
        }
        ReplayOperationAction::QueryDispatched => {
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
        ReplayOperationAction::QueryRecovery => {
            let envelope = operation_envelope(&operation)?;
            match query_operation_status(env, &envelope).await {
                Ok(outcome) if outcome.status == ContainerOperationStatus::Completed => {
                    finish_controller_outcome(env, db, context, operation, outcome, audit).await
                }
                _ => recovery_pending_response(&operation.operation_id, "recovery_required"),
            }
        }
        ReplayOperationAction::Pending(code) => {
            recovery_pending_response(&operation.operation_id, code)
        }
        ReplayOperationAction::Invalid => {
            Err(canary_error("container operation has an invalid state"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayOperationAction {
    ReplayTerminal,
    DispatchPrepared,
    QueryDispatched,
    QueryRecovery,
    Pending(&'static str),
    Invalid,
}

fn replay_operation_action(
    status: &str,
    terminal_replay_ready: bool,
    replay_runtime_ready: bool,
    prepared_resume_runtime_ready: bool,
) -> ReplayOperationAction {
    match status {
        "completed" | "failed" if terminal_replay_ready => ReplayOperationAction::ReplayTerminal,
        "completed" | "failed" => {
            ReplayOperationAction::Pending("container_terminal_replay_paused")
        }
        "prepared" if replay_runtime_ready && prepared_resume_runtime_ready => {
            ReplayOperationAction::DispatchPrepared
        }
        "prepared" => ReplayOperationAction::Pending("container_prepared_replay_paused"),
        "dispatched" if replay_runtime_ready => ReplayOperationAction::QueryDispatched,
        "recovery_required" if replay_runtime_ready => ReplayOperationAction::QueryRecovery,
        "dispatched" | "recovery_required" => {
            ReplayOperationAction::Pending("container_replay_runtime_paused")
        }
        _ => ReplayOperationAction::Invalid,
    }
}

async fn prepared_resume_runtime_ready(env: &Env) -> bool {
    let scheduler = container_scheduler_runtime_status(env);
    if !container_chat_canary_prepared_resume_enabled(env)
        || !container_scheduler_enabled(env)
        || !container_operation_runtime_status(env).replay_ready()
        || !scheduler.configured
        || !scheduler.valid
        || !container_scheduler_routing_secret_configured(env)
    {
        return false;
    }
    let controller = probe_container_controller(env, scheduler).await;
    prepared_resume_controller_ready(controller)
}

fn prepared_resume_controller_ready(controller: ContainerControllerProbe) -> bool {
    controller.binding_available
        && controller.authority_configured
        && controller.verified
        && controller.controller_enabled
        && controller.execution_enabled
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
    if outcome.status_contract_version == 4 {
        if let Some(artifacts) = outcome.provider_response_artifacts.as_ref() {
            match artifacts.status {
                ContainerProviderResponseArtifactStatus::Succeeded => {
                    return settle_completed_operation(env, db, context, operation, outcome, audit)
                        .await
                }
                ContainerProviderResponseArtifactStatus::InterpretedReject => {
                    return refund_interpreted_rejection(
                        env, db, context, operation, outcome, audit,
                    )
                    .await
                }
                ContainerProviderResponseArtifactStatus::Ambiguous => {}
            }
        }
    }
    let code = match outcome.status {
        ContainerOperationStatus::Completed => "provider_response_evidence_pending",
        ContainerOperationStatus::Claimed | ContainerOperationStatus::Running => {
            "container_operation_pending"
        }
        ContainerOperationStatus::Failed => "container_failure_unresolved",
        ContainerOperationStatus::RecoveryRequired => "provider_ambiguous",
    };
    defer_or_commit_recovery(env, db, context, operation, audit, code, outcome.result).await
}

async fn defer_or_commit_recovery(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    audit: ContainerChatCanaryAudit<'_>,
    response_code: &'static str,
    result: Option<ContainerArtifactManifest>,
) -> worker::Result<Response> {
    if relay_container_provider_response_evidence_exists(
        db,
        &operation.operation_id,
        operation.owner_generation,
    )
    .await?
    {
        return recovery_pending_response(&operation.operation_id, response_code);
    }
    commit_recovery_required(env, db, context, operation, audit, response_code, result).await
}

async fn settle_completed_operation(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    settle_completed_operation_inner(env, db, context, operation, outcome, Some(audit), None)
        .await
        .map_err(ContainerScheduledTerminalizationError::into_worker_error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContainerScheduledTerminalizationOutcome {
    Settled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContainerScheduledTerminalizationFailureClass {
    StoreUnavailable,
    TerminalResponseMissing,
    TerminalResponseDivergent,
    ContractViolation,
}

struct VerifiedContainerProviderClientResponse {
    artifact: RelayContainerClientResponseArtifactRecord,
    body: Vec<u8>,
}

async fn verified_container_provider_client_response(
    env: &Env,
    db: &D1Database,
    operation: &RelayContainerOperation,
    artifacts: &ContainerProviderResponseArtifactsOutcome,
) -> worker::Result<VerifiedContainerProviderClientResponse> {
    let raw_manifest = artifacts
        .raw_manifest
        .as_ref()
        .ok_or_else(|| canary_error("provider response evidence manifest is missing"))?;
    let client_manifest = artifacts
        .client_manifest
        .as_ref()
        .ok_or_else(|| canary_error("provider client response manifest is missing"))?;
    let artifact = relay_container_client_response_artifact(
        db,
        &operation.operation_id,
        operation.owner_generation,
        i64::from(artifacts.attempt_generation),
    )
    .await?
    .ok_or_else(|| canary_error("provider client response D1 evidence is missing"))?;
    if !relay_container_client_response_artifact_integrity_valid(&artifact)
        || artifact.operation_id != operation.operation_id
        || artifact.owner_generation != operation.owner_generation
        || artifact.attempt_generation != i64::from(artifacts.attempt_generation)
        || artifact.provider_response_evidence_sha256
            != raw_manifest.provider_response_evidence_sha256
        || artifact.response_class != artifacts.response_class.as_deref().unwrap_or_default()
        || Some(artifact.client_response_status as u16) != artifacts.client_status
        || artifact.client_response_object_key != client_manifest.object_key
        || artifact.client_response_object_version != client_manifest.object_version
        || artifact.client_response_sha256 != client_manifest.sha256
        || u64::try_from(artifact.client_response_size).ok() != Some(client_manifest.size)
        || artifact.client_response_content_type != client_manifest.content_type
        || artifact.client_response_artifact_sha256
            != client_manifest.client_response_artifact_sha256
        || artifact.provider_usage_receipt_sha256 != artifacts.provider_usage_receipt_sha256
    {
        return Err(canary_error(
            "provider client response evidence did not converge",
        ));
    }
    let raw_body = read_verified_container_provider_response_evidence(
        env,
        &ContainerProviderResponseEvidenceIdentity {
            operation_id: operation.operation_id.clone(),
            owner_generation: operation.owner_generation,
            attempt_generation: i64::from(artifacts.attempt_generation),
            provider_operation_id: artifacts.provider_operation_id.clone(),
            admission_sha256: artifacts.admission_sha256.clone(),
            egress_profile: artifacts.egress_profile.clone(),
            egress_worker_version_id: artifacts.egress_worker_version_id.clone(),
            provider_response_evidence_sha256: raw_manifest
                .provider_response_evidence_sha256
                .clone(),
        },
        &ContainerArtifactManifest {
            object_key: raw_manifest.object_key.clone(),
            object_version: raw_manifest.object_version.clone(),
            sha256: raw_manifest.sha256.clone(),
            size: raw_manifest.size,
            content_type: raw_manifest.content_type.clone(),
        },
    )
    .await?;
    drop(raw_body);
    let identity = ContainerResponseArtifactIdentity {
        operation_id: operation.operation_id.clone(),
        owner_generation: operation.owner_generation,
        attempt_generation: i64::from(artifacts.attempt_generation),
        provider_operation_id: artifacts.provider_operation_id.clone(),
        admission_sha256: artifacts.admission_sha256.clone(),
        egress_profile: artifacts.egress_profile.clone(),
        egress_worker_version_id: artifacts.egress_worker_version_id.clone(),
        client_response_artifact_sha256: artifact.client_response_artifact_sha256.clone(),
    };
    let body = read_verified_container_response_artifact(
        env,
        &identity,
        &ContainerArtifactManifest {
            object_key: artifact.client_response_object_key.clone(),
            object_version: artifact.client_response_object_version.clone(),
            sha256: artifact.client_response_sha256.clone(),
            size: u64::try_from(artifact.client_response_size)
                .map_err(|_| canary_error("provider client response size is invalid"))?,
            content_type: artifact.client_response_content_type.clone(),
        },
    )
    .await?;
    Ok(VerifiedContainerProviderClientResponse { artifact, body })
}

#[derive(Debug)]
pub(crate) struct ContainerScheduledTerminalizationError {
    class: ContainerScheduledTerminalizationFailureClass,
    code: &'static str,
    detail: String,
}

impl ContainerScheduledTerminalizationError {
    pub(crate) fn class(&self) -> ContainerScheduledTerminalizationFailureClass {
        self.class
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    fn store_unavailable(code: &'static str, err: worker::Error) -> Self {
        Self {
            class: ContainerScheduledTerminalizationFailureClass::StoreUnavailable,
            code,
            detail: err.to_string(),
        }
    }

    fn terminal_response_divergent(code: &'static str, detail: &str) -> Self {
        Self {
            class: ContainerScheduledTerminalizationFailureClass::TerminalResponseDivergent,
            code,
            detail: detail.to_string(),
        }
    }

    fn terminal_response_missing(code: &'static str, detail: &str) -> Self {
        Self {
            class: ContainerScheduledTerminalizationFailureClass::TerminalResponseMissing,
            code,
            detail: detail.to_string(),
        }
    }

    fn contract_violation(code: &'static str, detail: &str) -> Self {
        Self {
            class: ContainerScheduledTerminalizationFailureClass::ContractViolation,
            code,
            detail: detail.to_string(),
        }
    }

    fn into_worker_error(self) -> worker::Error {
        canary_error(&self.to_string())
    }
}

impl std::fmt::Display for ContainerScheduledTerminalizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

pub(crate) async fn autonomously_terminalize_completed_operation(
    env: &Env,
    db: &D1Database,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    lease: &RelayContainerReconciliationLease,
) -> Result<ContainerScheduledTerminalizationOutcome, ContainerScheduledTerminalizationError> {
    if outcome.status_contract_version != 4
        || !outcome
            .provider_response_artifacts
            .as_ref()
            .is_some_and(|artifacts| {
                artifacts.status == ContainerProviderResponseArtifactStatus::Succeeded
            })
        || lease.operation_id != operation.operation_id
        || lease.reservation_key != operation.reservation_key
    {
        return Err(ContainerScheduledTerminalizationError::contract_violation(
            "scheduled_terminalization_lease_inconsistent",
            "scheduled terminalization operation or lease is inconsistent",
        ));
    }
    let reservation_key = operation.reservation_key.clone();
    settle_completed_operation_inner(
        env,
        db,
        None,
        operation,
        outcome,
        None,
        Some(RelayContainerScheduledTerminalizationFence {
            observation_claim_generation: lease.claim_generation,
            observation_claim_owner: &lease.claim_owner,
            observation_claim_lease_expires_at: lease.claim_lease_expires_at,
        }),
    )
    .await?;
    let current = relay_container_operation(db, &reservation_key)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "scheduled_terminalization_readback_unavailable",
                err,
            )
        })?
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "scheduled_terminalization_operation_missing",
                "scheduled terminalization operation disappeared",
            )
        })?;
    match current.status.as_str() {
        "completed" => Ok(ContainerScheduledTerminalizationOutcome::Settled),
        _ => Err(ContainerScheduledTerminalizationError::contract_violation(
            "scheduled_terminalization_not_durable",
            "scheduled terminalization did not reach a durable outcome",
        )),
    }
}

async fn settle_completed_operation_inner(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    audit: Option<ContainerChatCanaryAudit<'_>>,
    scheduled_terminalization: Option<RelayContainerScheduledTerminalizationFence<'_>>,
) -> Result<Response, ContainerScheduledTerminalizationError> {
    let reservation = relay_billing_reservation(db, &operation.reservation_key)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "billing_reservation_read_unavailable",
                err,
            )
        })?
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "billing_reservation_missing",
                "container billing reservation is missing",
            )
        })?;
    validate_terminal_audit_identity(&reservation, audit)?;
    let artifacts = outcome
        .provider_response_artifacts
        .as_ref()
        .filter(|artifacts| {
            outcome.status_contract_version == 4
                && artifacts.status == ContainerProviderResponseArtifactStatus::Succeeded
                && artifacts.attempt_generation == 1
                && artifacts.provider_status == Some(200)
                && artifacts.client_status == Some(200)
                && artifacts.response_class.as_deref() == Some("success")
                && artifacts.response_code.is_none()
        })
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "provider_response_artifacts_invalid",
                "completed provider response artifacts are unavailable",
            )
        })?;
    let result = outcome.result.as_ref().ok_or_else(|| {
        ContainerScheduledTerminalizationError::contract_violation(
            "completed_result_missing",
            "completed container operation has no result",
        )
    })?;
    let attempt = outcome
        .provider_attempt
        .as_ref()
        .filter(|attempt| {
            attempt.attempt_generation == 1
                && matches!(
                    attempt.status,
                    ContainerProviderAttemptStatus::Dispatched
                        | ContainerProviderAttemptStatus::Succeeded
                        | ContainerProviderAttemptStatus::Ambiguous
                )
                && attempt
                    .result
                    .as_ref()
                    .is_none_or(|attempt_result| attempt_result == result)
                && attempt.provider_usage_receipt_attached_at.is_some()
        })
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "provider_attempt_contract_invalid",
                "completed provider attempt contract is invalid",
            )
        })?;
    let receipt_sha256 = outcome
        .provider_usage_receipt_sha256
        .as_deref()
        .filter(|value| {
            artifacts.provider_usage_receipt_sha256.as_deref() == Some(*value)
                && attempt.provider_usage_receipt_sha256.as_deref() == Some(*value)
        })
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "provider_usage_receipt_invalid",
                "provider usage receipt is unavailable",
            )
        })?;
    let terminal_result = RelayContainerOperationResultRecord {
        object_key: &result.object_key,
        object_version: &result.object_version,
        sha256: &result.sha256,
        size: i64::try_from(result.size).map_err(|_| {
            ContainerScheduledTerminalizationError::contract_violation(
                "provider_result_size_invalid",
                "container result size is out of range",
            )
        })?,
        content_type: &result.content_type,
    };
    let terminal = RelayContainerOperationTerminalRecord::Completed {
        response_status: 200,
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
    .await
    .map_err(|err| {
        ContainerScheduledTerminalizationError::store_unavailable(
            "provider_usage_quote_unavailable",
            err,
        )
    })?
    .ok_or_else(|| {
        ContainerScheduledTerminalizationError::contract_violation(
            "provider_usage_quote_divergent",
            "provider usage settlement quote did not converge",
        )
    })?;
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
    let result_state = inspect_container_result(env, &result_identity, result)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "provider_result_r2_unavailable",
                err,
            )
        })?;
    if result_identity.egress_profile != CONTAINER_CHAT_CANARY_EGRESS_PROFILE
        || result_state != ContainerResultObjectState::Matching
    {
        if scheduled_terminalization.is_some() {
            return Err(match result_state {
                ContainerResultObjectState::Missing => {
                    ContainerScheduledTerminalizationError::terminal_response_missing(
                        "provider_result_r2_missing",
                        "scheduled terminalization provider result is missing",
                    )
                }
                ContainerResultObjectState::Matching | ContainerResultObjectState::Divergent => {
                    ContainerScheduledTerminalizationError::terminal_response_divergent(
                        "provider_result_r2_divergent",
                        "scheduled terminalization provider result did not converge",
                    )
                }
            });
        }
        return recovery_pending_response(&operation.operation_id, "provider_result_divergent")
            .map_err(|err| {
                ContainerScheduledTerminalizationError::store_unavailable(
                    "recovery_response_unavailable",
                    err,
                )
            });
    }
    let _verified_result = read_verified_container_result(env, result)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "provider_result_r2_read_unavailable",
                err,
            )
        })?;
    let verified_response =
        verified_container_provider_client_response(env, db, &operation, artifacts)
            .await
            .map_err(|err| {
                ContainerScheduledTerminalizationError::store_unavailable(
                    "provider_client_response_read_unavailable",
                    err,
                )
            })?;
    let replay_status =
        u16::try_from(verified_response.artifact.client_response_status).map_err(|_| {
            ContainerScheduledTerminalizationError::contract_violation(
                "provider_client_response_status_invalid",
                "provider client response status is out of range",
            )
        })?;
    let response = put_container_client_response(
        env,
        &operation.operation_id,
        operation.owner_generation,
        replay_status,
        &verified_response.artifact.client_response_headers_json,
        &verified_response.artifact.client_response_headers_sha256,
        &verified_response.artifact.client_response_content_type,
        &verified_response.body,
    )
    .await
    .map_err(|err| {
        ContainerScheduledTerminalizationError::store_unavailable(
            "client_response_r2_write_unavailable",
            err,
        )
    })?;
    if response.manifest.status != replay_status
        || response.manifest.headers_json != verified_response.artifact.client_response_headers_json
        || response.manifest.headers_sha256
            != verified_response.artifact.client_response_headers_sha256
        || response.manifest.body.sha256 != verified_response.artifact.client_response_sha256
        || i64::try_from(response.manifest.body.size).ok()
            != Some(verified_response.artifact.client_response_size)
        || response.manifest.body.content_type
            != verified_response.artifact.client_response_content_type
    {
        return Err(ContainerScheduledTerminalizationError::contract_violation(
            "client_response_r2_write_divergent",
            "legacy exact response did not match provider response evidence",
        ));
    }
    let audit_payload = terminal_provider_response_audit_payload(
        &operation,
        &reservation,
        "settle",
        Some(quote.final_quota),
        quote.prompt_tokens,
        quote.completion_tokens,
        artifacts,
        &verified_response.artifact,
    )
    .map_err(|err| {
        ContainerScheduledTerminalizationError::contract_violation(
            "terminal_audit_payload_invalid",
            &err.to_string(),
        )
    })?;
    let audit_payload_sha256 = sha256_hex(audit_payload.as_bytes());
    let client_response = RelayContainerClientResponseRecord {
        status: i64::from(response.manifest.status),
        artifact_sha256: &verified_response.artifact.client_response_artifact_sha256,
        headers_json: &response.manifest.headers_json,
        headers_sha256: &response.manifest.headers_sha256,
        object_key: &response.manifest.body.object_key,
        object_version: &response.manifest.body.object_version,
        sha256: &response.manifest.body.sha256,
        size: i64::try_from(response.manifest.body.size).map_err(|_| {
            ContainerScheduledTerminalizationError::contract_violation(
                "client_response_size_invalid",
                "client response size is out of range",
            )
        })?,
        content_type: &response.manifest.body.content_type,
    };
    let receipt = require_financial_terminal(
        commit_relay_container_financial_terminal(
            db,
            RelayContainerFinancialTerminalCommand {
                reservation_key: &operation.reservation_key,
                operation_id: &operation.operation_id,
                operation_owner_generation: operation.owner_generation,
                expected_operation_status: operation_expected_status(&operation).map_err(
                    |err| {
                        ContainerScheduledTerminalizationError::contract_violation(
                            "operation_status_ineligible",
                            &err.to_string(),
                        )
                    },
                )?,
                admission_sha256: &operation.admission_sha256,
                billing_owner_generation: financial_owner_generation(&operation).map_err(
                    |err| {
                        ContainerScheduledTerminalizationError::contract_violation(
                            "billing_owner_generation_invalid",
                            &err.to_string(),
                        )
                    },
                )?,
                terminal,
                action: RelayContainerFinancialTerminalAction::Settle {
                    final_quota: quote.final_quota,
                    finalization_reason: "container_provider_usage_settlement",
                    provider_usage_receipt_sha256: receipt_sha256,
                    provider_result_sha256: &result.sha256,
                    provider_attempt_generation: 1,
                },
                client_response: Some(client_response),
                provider_response: Some(RelayContainerProviderResponseBindingRecord {
                    attempt_generation: 1,
                    status: "succeeded",
                    response_class: "success",
                    provider_status: 200,
                    client_status: i64::from(replay_status),
                    response_code: None,
                    provider_response_evidence_sha256: &verified_response
                        .artifact
                        .provider_response_evidence_sha256,
                    client_response_artifact_sha256: &verified_response
                        .artifact
                        .client_response_artifact_sha256,
                }),
                audit_payload_json: &audit_payload,
                audit_payload_sha256: &audit_payload_sha256,
                scheduled_terminalization,
                committed_at: current_unix_seconds(),
            },
        )
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "financial_terminal_commit_unavailable",
                err,
            )
        })?,
    )?;
    crate::quota_coordinator::observe_or_defer_committed_relay_billing_reservation(
        context,
        env,
        db,
        &operation.reservation_key,
    )
    .await;
    match relay_container_provider_usage_receipt_readback(db, &operation, &receipt)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "provider_usage_receipt_readback_unavailable",
                err,
            )
        })? {
        RelayContainerProviderUsageReceiptReadback::Matching(identity)
            if identity == quote.identity => {}
        _ => {
            return Err(ContainerScheduledTerminalizationError::contract_violation(
                "provider_usage_receipt_readback_divergent",
                "provider usage receipt readback did not converge after settlement",
            ))
        }
    }
    match inspect_receipt_client_response(env, &receipt)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "client_response_r2_inspection_unavailable",
                err,
            )
        })? {
        ContainerResponseObservation::Matching => {}
        ContainerResponseObservation::Missing => {
            return Err(
                ContainerScheduledTerminalizationError::terminal_response_missing(
                    "client_response_r2_missing",
                    "exact client response object is missing after settlement",
                ),
            )
        }
        ContainerResponseObservation::Divergent => {
            return Err(
                ContainerScheduledTerminalizationError::terminal_response_divergent(
                    "client_response_r2_divergent",
                    "exact client response object diverged after settlement",
                ),
            )
        }
        ContainerResponseObservation::NotExpected
        | ContainerResponseObservation::Unavailable
        | ContainerResponseObservation::Orphan => {
            return Err(ContainerScheduledTerminalizationError::contract_violation(
                "client_response_receipt_invalid",
                "financial terminal receipt has no exact client response",
            ))
        }
    }
    let mut response = replay_receipt_client_response(env, &receipt)
        .await
        .map_err(|err| {
            ContainerScheduledTerminalizationError::store_unavailable(
                "client_response_r2_read_unavailable",
                err,
            )
        })?
        .ok_or_else(|| {
            ContainerScheduledTerminalizationError::contract_violation(
                "client_response_manifest_missing",
                "exact client response replay is unavailable",
            )
        })?;
    crate::set_cors_headers(&mut response).map_err(|err| {
        ContainerScheduledTerminalizationError::contract_violation(
            "client_response_headers_unavailable",
            &err.to_string(),
        )
    })?;
    Ok(response)
}

async fn refund_interpreted_rejection(
    env: &Env,
    db: &D1Database,
    context: Option<&Context>,
    operation: RelayContainerOperation,
    outcome: ContainerOperationOutcome,
    audit: ContainerChatCanaryAudit<'_>,
) -> worker::Result<Response> {
    let reservation = relay_billing_reservation(db, &operation.reservation_key)
        .await?
        .ok_or_else(|| canary_error("container billing reservation is missing"))?;
    validate_terminal_audit_identity(&reservation, Some(audit))
        .map_err(ContainerScheduledTerminalizationError::into_worker_error)?;
    let artifacts = outcome
        .provider_response_artifacts
        .as_ref()
        .filter(|artifacts| {
            outcome.status_contract_version == 4
                && artifacts.status == ContainerProviderResponseArtifactStatus::InterpretedReject
                && artifacts.attempt_generation == 1
                && artifacts.provider_status.is_some()
                && artifacts.client_status.is_some()
                && artifacts.response_class.is_some()
                && artifacts.response_code.is_some()
                && artifacts.provider_usage_receipt_sha256.is_none()
        })
        .ok_or_else(|| canary_error("interpreted provider rejection evidence is unavailable"))?;
    let verified_response =
        verified_container_provider_client_response(env, db, &operation, artifacts).await?;
    let response_code = artifacts
        .response_code
        .as_deref()
        .ok_or_else(|| canary_error("interpreted provider rejection code is unavailable"))?;
    let response_class = artifacts
        .response_class
        .as_deref()
        .ok_or_else(|| canary_error("interpreted provider rejection class is unavailable"))?;
    let provider_status = i64::from(
        artifacts
            .provider_status
            .ok_or_else(|| canary_error("provider response status is unavailable"))?,
    );
    let replay_status = artifacts
        .client_status
        .ok_or_else(|| canary_error("client response status is unavailable"))?;
    if i64::from(replay_status) != verified_response.artifact.client_response_status {
        return Err(canary_error(
            "interpreted provider rejection status did not converge",
        ));
    }
    let response = put_container_client_response(
        env,
        &operation.operation_id,
        operation.owner_generation,
        replay_status,
        &verified_response.artifact.client_response_headers_json,
        &verified_response.artifact.client_response_headers_sha256,
        &verified_response.artifact.client_response_content_type,
        &verified_response.body,
    )
    .await?;
    if response.manifest.status != replay_status
        || response.manifest.headers_json != verified_response.artifact.client_response_headers_json
        || response.manifest.headers_sha256
            != verified_response.artifact.client_response_headers_sha256
        || response.manifest.body.sha256 != verified_response.artifact.client_response_sha256
        || i64::try_from(response.manifest.body.size).ok()
            != Some(verified_response.artifact.client_response_size)
        || response.manifest.body.content_type
            != verified_response.artifact.client_response_content_type
    {
        return Err(canary_error(
            "interpreted provider rejection replay object diverged",
        ));
    }

    let audit_payload = terminal_provider_response_audit_payload(
        &operation,
        &reservation,
        "refund",
        None,
        0,
        0,
        artifacts,
        &verified_response.artifact,
    )?;
    let audit_payload_sha256 = sha256_hex(audit_payload.as_bytes());
    let terminal = RelayContainerOperationTerminalRecord::Failed {
        response_status: 422,
        response_code,
    };
    let client_response = RelayContainerClientResponseRecord {
        status: i64::from(response.manifest.status),
        artifact_sha256: &verified_response.artifact.client_response_artifact_sha256,
        headers_json: &response.manifest.headers_json,
        headers_sha256: &response.manifest.headers_sha256,
        object_key: &response.manifest.body.object_key,
        object_version: &response.manifest.body.object_version,
        sha256: &response.manifest.body.sha256,
        size: i64::try_from(response.manifest.body.size)
            .map_err(|_| canary_error("client response size is invalid"))?,
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
                action: RelayContainerFinancialTerminalAction::Refund {
                    finalization_reason: response_code,
                    request_accounting: RelayBillingRequestAccounting::Skip,
                },
                client_response: Some(client_response),
                provider_response: Some(RelayContainerProviderResponseBindingRecord {
                    attempt_generation: 1,
                    status: "interpreted_reject",
                    response_class,
                    provider_status,
                    client_status: i64::from(replay_status),
                    response_code: Some(response_code),
                    provider_response_evidence_sha256: &verified_response
                        .artifact
                        .provider_response_evidence_sha256,
                    client_response_artifact_sha256: &verified_response
                        .artifact
                        .client_response_artifact_sha256,
                }),
                audit_payload_json: &audit_payload,
                audit_payload_sha256: &audit_payload_sha256,
                scheduled_terminalization: None,
                committed_at: current_unix_seconds(),
            },
        )
        .await?,
    )
    .map_err(ContainerScheduledTerminalizationError::into_worker_error)?;
    crate::quota_coordinator::observe_or_defer_committed_relay_billing_reservation(
        context,
        env,
        db,
        &operation.reservation_key,
    )
    .await;
    match inspect_receipt_client_response(env, &receipt).await? {
        ContainerResponseObservation::Matching => {}
        _ => {
            return Err(canary_error(
                "interpreted provider rejection replay did not converge",
            ))
        }
    }
    let mut response = replay_receipt_client_response(env, &receipt)
        .await?
        .ok_or_else(|| canary_error("interpreted provider rejection replay is unavailable"))?;
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
    let reservation = relay_billing_reservation(db, &operation.reservation_key)
        .await?
        .ok_or_else(|| canary_error("container billing reservation is missing"))?;
    validate_terminal_audit_identity(&reservation, Some(audit))
        .map_err(ContainerScheduledTerminalizationError::into_worker_error)?;
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
    let audit_payload =
        terminal_audit_payload(&operation, &reservation, "recovery_required", None, 0, 0)?;
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
                provider_response: None,
                audit_payload_json: &audit_payload,
                audit_payload_sha256: &audit_payload_sha256,
                scheduled_terminalization: None,
                committed_at: current_unix_seconds(),
            },
        )
        .await?,
    )
    .map_err(ContainerScheduledTerminalizationError::into_worker_error)?;
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
) -> Result<
    crate::d1_repositories::RelayContainerFinancialTerminalReceipt,
    ContainerScheduledTerminalizationError,
> {
    match outcome {
        RelayContainerFinancialTerminalOutcome::Applied(receipt)
        | RelayContainerFinancialTerminalOutcome::MatchingReplay(receipt) => Ok(receipt),
        RelayContainerFinancialTerminalOutcome::StaleGeneration => {
            Err(ContainerScheduledTerminalizationError::store_unavailable(
                "financial_terminal_stale_generation",
                canary_error("container financial terminal lease generation is stale"),
            ))
        }
        RelayContainerFinancialTerminalOutcome::DifferentDecision => {
            Err(ContainerScheduledTerminalizationError::contract_violation(
                "financial_terminal_different_decision",
                "container financial terminal conflicts with a durable decision",
            ))
        }
        RelayContainerFinancialTerminalOutcome::NotFound => {
            Err(ContainerScheduledTerminalizationError::contract_violation(
                "financial_terminal_identity_missing",
                "container financial terminal identity is missing",
            ))
        }
        RelayContainerFinancialTerminalOutcome::Conflict => {
            Err(ContainerScheduledTerminalizationError::contract_violation(
                "financial_terminal_contract_conflict",
                "container financial terminal contract conflicted",
            ))
        }
        RelayContainerFinancialTerminalOutcome::InvariantViolation => {
            Err(ContainerScheduledTerminalizationError::contract_violation(
                "financial_terminal_invariant_violation",
                "container financial terminal invariant did not converge",
            ))
        }
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
    reservation: &RelayBillingReservation,
    decision: &str,
    final_quota: Option<i64>,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> worker::Result<String> {
    serde_json::to_string(&json!({
        "channel_id": operation.channel_id,
        "completion_tokens": completion_tokens,
        "decision": decision,
        "endpoint_path": reservation.endpoint_path,
        "final_quota": final_quota,
        "model": reservation.model_name,
        "operation_id": operation.operation_id,
        "prompt_tokens": prompt_tokens,
        "request_id_hash": reservation.request_id_hash,
        "schema_version": 2,
        "selected_group": operation.selected_group,
        "token_id": reservation.token_id,
        "transport": "container_chat_canary",
        "user_id": reservation.user_id,
    }))
    .map_err(|err| canary_error(&format!("container audit serialization failed: {err}")))
}

fn terminal_provider_response_audit_payload(
    operation: &RelayContainerOperation,
    reservation: &RelayBillingReservation,
    decision: &str,
    final_quota: Option<i64>,
    prompt_tokens: i64,
    completion_tokens: i64,
    artifacts: &ContainerProviderResponseArtifactsOutcome,
    response: &RelayContainerClientResponseArtifactRecord,
) -> worker::Result<String> {
    serde_json::to_string(&json!({
        "channel_id": operation.channel_id,
        "completion_tokens": completion_tokens,
        "decision": decision,
        "endpoint_path": reservation.endpoint_path,
        "final_quota": final_quota,
        "model": reservation.model_name,
        "operation_id": operation.operation_id,
        "prompt_tokens": prompt_tokens,
        "provider_response": {
            "attempt_generation": artifacts.attempt_generation,
            "client_response_artifact_sha256": response.client_response_artifact_sha256,
            "client_response_sha256": response.client_response_sha256,
            "client_status": artifacts.client_status,
            "provider_response_evidence_sha256": response.provider_response_evidence_sha256,
            "provider_status": artifacts.provider_status,
            "response_class": artifacts.response_class,
            "response_code": artifacts.response_code,
            "status": match artifacts.status {
                ContainerProviderResponseArtifactStatus::Succeeded => "succeeded",
                ContainerProviderResponseArtifactStatus::InterpretedReject => "interpreted_reject",
                ContainerProviderResponseArtifactStatus::Ambiguous => "ambiguous",
            },
        },
        "request_id_hash": reservation.request_id_hash,
        "schema_version": 3,
        "selected_group": operation.selected_group,
        "token_id": reservation.token_id,
        "transport": "container_chat_canary",
        "user_id": reservation.user_id,
    }))
    .map_err(|err| canary_error(&format!("container audit serialization failed: {err}")))
}

fn validate_terminal_audit_identity(
    reservation: &RelayBillingReservation,
    audit: Option<ContainerChatCanaryAudit<'_>>,
) -> Result<(), ContainerScheduledTerminalizationError> {
    if audit.is_some_and(|audit| {
        audit.user_id != reservation.user_id
            || audit.token_id != reservation.token_id
            || audit.model.trim() != reservation.model_name
            || audit.endpoint_path.trim() != reservation.endpoint_path
    }) {
        return Err(ContainerScheduledTerminalizationError::contract_violation(
            "terminal_audit_identity_divergent",
            "request audit identity differs from the frozen billing reservation",
        ));
    }
    Ok(())
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
    idempotency_key: &str,
) -> Result<String, ()> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| ())?;
    mac.update(IDEMPOTENCY_DOMAIN);
    for field in [
        user_id.to_string(),
        token_id.to_string(),
        idempotency_key.to_string(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn replay_operation_identity_conflicts(
    matched_operation_id: Option<&str>,
    candidate_kind: &str,
    candidate_operation_id: &str,
) -> bool {
    candidate_kind != CONTAINER_CHAT_CANARY_OPERATION_KIND
        || matched_operation_id.is_some_and(|winner| winner != candidate_operation_id)
}

fn build_container_chat_canary_replay_identity(
    current_secret: Option<&str>,
    previous_secret: Option<&str>,
    user_id: i64,
    token_id: i64,
    model: &str,
    idempotency_key: &str,
    request_body: &[u8],
) -> Result<ContainerChatCanaryReplayIdentity, ContainerChatCanaryPlanError> {
    if user_id <= 0
        || token_id <= 0
        || model.is_empty()
        || model.len() > MAX_CONTAINER_CHAT_CANARY_MODEL_BYTES
        || model.chars().any(char::is_control)
        || request_body.is_empty()
        || request_body.len() > MAX_CANARY_REQUEST_BYTES
    {
        return Err(ContainerChatCanaryPlanError::IncompatibleRoute);
    }
    if !valid_idempotency_key(idempotency_key) {
        return Err(ContainerChatCanaryPlanError::InvalidIdempotencyKey);
    }
    let mut client_hmacs = Vec::new();
    for secret in [current_secret, previous_secret].into_iter().flatten() {
        if secret.as_bytes().len() < MIN_IDEMPOTENCY_SECRET_BYTES {
            continue;
        }
        let hmac = client_idempotency_hmac(secret.as_bytes(), user_id, token_id, idempotency_key)
            .map_err(|_| ContainerChatCanaryPlanError::Misconfigured)?;
        if !client_hmacs.contains(&hmac) {
            client_hmacs.push(hmac);
        }
    }
    if client_hmacs.is_empty() {
        return Err(ContainerChatCanaryPlanError::Misconfigured);
    }
    Ok(ContainerChatCanaryReplayIdentity {
        client_idempotency_hmac_sha256: client_hmacs,
        client_request_sha256: client_request_sha256(model, request_body),
    })
}

fn idempotency_secret(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| value.as_bytes().len() >= MIN_IDEMPOTENCY_SECRET_BYTES)
}

fn runtime_gate_enabled(env: &Env, name: &str) -> bool {
    env.var(name).ok().map(|value| value.to_string()).as_deref() == Some("true")
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

fn client_request_sha256(model: &str, request_body: &[u8]) -> String {
    domain_hash(REQUEST_DOMAIN, &[model.as_bytes(), request_body])
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
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

pub fn replay_only_miss_response() -> worker::Result<Response> {
    let mut response = no_store_json_response(
        json!({
            "error": {
                "code": "container_replay_identity_not_found",
                "message": "the replay-only cohort has no matching durable operation",
                "type": "operation_replay_required",
            }
        }),
        503,
    )?;
    response.headers_mut().set("retry-after", "5")?;
    Ok(response)
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
    fn replay_state_requires_runtime_and_an_explicit_prepared_resume_gate() {
        assert_eq!(
            replay_operation_action("completed", true, false, false),
            ReplayOperationAction::ReplayTerminal
        );
        assert_eq!(
            replay_operation_action("completed", false, true, true),
            ReplayOperationAction::Pending("container_terminal_replay_paused")
        );
        assert_eq!(
            replay_operation_action("prepared", true, true, false),
            ReplayOperationAction::Pending("container_prepared_replay_paused")
        );
        assert_eq!(
            replay_operation_action("prepared", true, false, true),
            ReplayOperationAction::Pending("container_prepared_replay_paused")
        );
        assert_eq!(
            replay_operation_action("prepared", true, true, true),
            ReplayOperationAction::DispatchPrepared
        );
        assert_eq!(
            replay_operation_action("dispatched", true, false, false),
            ReplayOperationAction::Pending("container_replay_runtime_paused")
        );
        assert_eq!(
            replay_operation_action("dispatched", true, true, false),
            ReplayOperationAction::QueryDispatched
        );
        assert_eq!(
            replay_operation_action("recovery_required", true, true, false),
            ReplayOperationAction::QueryRecovery
        );
        assert_eq!(
            replay_operation_action("unknown", true, true, true),
            ReplayOperationAction::Invalid
        );
    }

    #[test]
    fn prepared_resume_requires_verified_controller_execution_before_dispatch() {
        let ready = ContainerControllerProbe {
            probe_enabled: true,
            binding_available: true,
            authority_configured: true,
            verified: true,
            controller_enabled: true,
            execution_enabled: true,
            previous_secret_configured: false,
            controller_version_id: Some("controller-version-test".to_string()),
            shard_activation_write_enabled: false,
            shard_activation_candidate_build_configured: false,
            all_action_gates_false: false,
            action_gate_inventory_sha256: Some("a".repeat(64)),
            state: "verified",
        };
        assert!(prepared_resume_controller_ready(ready.clone()));

        for blocked in [
            ContainerControllerProbe {
                binding_available: false,
                ..ready.clone()
            },
            ContainerControllerProbe {
                authority_configured: false,
                ..ready.clone()
            },
            ContainerControllerProbe {
                verified: false,
                ..ready.clone()
            },
            ContainerControllerProbe {
                controller_enabled: false,
                ..ready.clone()
            },
            ContainerControllerProbe {
                execution_enabled: false,
                ..ready
            },
        ] {
            assert!(!prepared_resume_controller_ready(blocked));
        }
    }

    #[test]
    fn dual_secret_replay_must_not_resolve_to_different_operations() {
        assert!(!replay_operation_identity_conflicts(
            None,
            CONTAINER_CHAT_CANARY_OPERATION_KIND,
            "operation-a"
        ));
        assert!(!replay_operation_identity_conflicts(
            Some("operation-a"),
            CONTAINER_CHAT_CANARY_OPERATION_KIND,
            "operation-a"
        ));
        assert!(replay_operation_identity_conflicts(
            Some("operation-a"),
            CONTAINER_CHAT_CANARY_OPERATION_KIND,
            "operation-b"
        ));
        assert!(replay_operation_identity_conflicts(
            None,
            "other_kind",
            "operation-a"
        ));
    }

    #[test]
    fn idempotency_identity_is_tenant_scoped_and_request_conflicts_are_visible() {
        let secret = [7_u8; 32];
        let first = client_idempotency_hmac(&secret, 1, 2, "request-123").unwrap();
        let replay = client_idempotency_hmac(&secret, 1, 2, "request-123").unwrap();
        let other_token = client_idempotency_hmac(&secret, 1, 3, "request-123").unwrap();
        assert_eq!(first, replay);
        assert_ne!(first, other_token);
        assert_eq!(first.len(), 64);
        let body = br#"{"model":"gpt","messages":[]}"#;
        assert_eq!(
            client_request_sha256("gpt", body),
            client_request_sha256("gpt", body)
        );
        assert_ne!(
            client_request_sha256("gpt", body),
            client_request_sha256("other", body)
        );
        assert!(valid_idempotency_key("request-123"));
        assert!(!valid_idempotency_key("short"));
        assert!(!valid_idempotency_key(" request-123"));
    }

    #[test]
    fn replay_identity_reads_current_and_previous_secrets_without_duplicate_keys() {
        let current = "c".repeat(MIN_IDEMPOTENCY_SECRET_BYTES);
        let previous = "p".repeat(MIN_IDEMPOTENCY_SECRET_BYTES);
        let body = br#"{"model":"gpt-canary","messages":[]}"#;

        let dual = build_container_chat_canary_replay_identity(
            Some(&current),
            Some(&previous),
            1,
            2,
            "gpt-canary",
            "request-123",
            body,
        )
        .unwrap();
        assert_eq!(dual.client_idempotency_hmac_sha256.len(), 2);
        assert_eq!(
            dual.client_idempotency_hmac_sha256[0],
            client_idempotency_hmac(current.as_bytes(), 1, 2, "request-123").unwrap()
        );
        assert_eq!(
            dual.client_idempotency_hmac_sha256[1],
            client_idempotency_hmac(previous.as_bytes(), 1, 2, "request-123").unwrap()
        );

        let duplicate = build_container_chat_canary_replay_identity(
            Some(&current),
            Some(&current),
            1,
            2,
            "gpt-canary",
            "request-123",
            body,
        )
        .unwrap();
        assert_eq!(duplicate.client_idempotency_hmac_sha256.len(), 1);

        let previous_only = build_container_chat_canary_replay_identity(
            None,
            Some(&previous),
            1,
            2,
            "gpt-canary",
            "request-123",
            body,
        )
        .unwrap();
        assert_eq!(previous_only.client_idempotency_hmac_sha256.len(), 1);
        assert_eq!(
            previous_only.client_request_sha256,
            client_request_sha256("gpt-canary", body)
        );
    }

    #[test]
    fn replay_identity_fails_closed_without_a_valid_read_secret() {
        let short = "s".repeat(MIN_IDEMPOTENCY_SECRET_BYTES - 1);
        let body = br#"{"model":"gpt-canary","messages":[]}"#;
        for (current, previous) in [(None, None), (Some(short.as_str()), None)] {
            assert_eq!(
                build_container_chat_canary_replay_identity(
                    current,
                    previous,
                    1,
                    2,
                    "gpt-canary",
                    "request-123",
                    body,
                ),
                Err(ContainerChatCanaryPlanError::Misconfigured)
            );
        }
    }

    #[test]
    fn replay_lookup_precedes_current_channel_discovery_and_ordinary_reserve() {
        let source = include_str!("relay.rs");
        let replay = source
            .find("// Recovery is intentionally classified before current channel discovery.")
            .unwrap();
        let channel_discovery = source
            .find("let mut group_pools = match resolve_relay_group_pools(")
            .unwrap();
        let ordinary_reserve = source.find("if container_canary_plan.is_none() {").unwrap();
        assert!(replay < channel_discovery);
        assert!(channel_discovery < ordinary_reserve);
    }

    #[test]
    fn provider_body_freeze_preserves_the_client_request_identity() {
        let original_body = br#"{"model":"gpt","client_only":true}"#;
        let provider_body = br#"{"model":"gpt"}"#;
        let plan = ContainerChatCanaryPlan {
            request_body: original_body.to_vec(),
            input_sha256: sha256_hex(original_body),
            client_idempotency_hmac_sha256: "a".repeat(64),
            client_idempotency_hmac_aliases: vec!["a".repeat(64)],
            client_request_sha256: domain_hash(REQUEST_DOMAIN, &[original_body]),
            deadline_seconds: 120,
        };
        let client_request_sha256 = plan.client_request_sha256.clone();
        let client_idempotency_hmac_sha256 = plan.client_idempotency_hmac_sha256.clone();
        let client_idempotency_hmac_aliases = plan.client_idempotency_hmac_aliases.clone();

        let frozen = plan.freeze_provider_request_body(provider_body).unwrap();

        assert_eq!(frozen.request_body, provider_body);
        assert_eq!(frozen.input_sha256, sha256_hex(provider_body));
        assert_eq!(frozen.client_request_sha256, client_request_sha256);
        assert_eq!(
            frozen.client_idempotency_hmac_sha256,
            client_idempotency_hmac_sha256
        );
        assert_eq!(
            frozen.client_idempotency_hmac_aliases,
            client_idempotency_hmac_aliases
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
            assert!(scope.contains("CONTAINER_CHAT_CANARY_REPLAY_ONLY_ENABLED = \"false\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_PREPARED_RESUME_ENABLED = \"false\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_TOKEN_IDS = \"\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_CHANNEL_ID = \"0\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_MODEL = \"\""));
            assert!(scope.contains("CONTAINER_CHAT_CANARY_DEADLINE_SECONDS = \"120\""));
        }
    }

    #[test]
    fn scheduled_settlement_is_owner_fenced_and_never_quarantines_r2_divergence() {
        let source = include_str!("container_relay_canary.rs");
        let client_start = source.find("async fn settle_completed_operation(").unwrap();
        let inner_start = source
            .find("async fn settle_completed_operation_inner(")
            .unwrap();
        let client = &source[client_start..inner_start];
        assert!(client.contains("Some(audit)"));

        let recovery_start = source.find("async fn commit_recovery_required(").unwrap();
        let settlement = &source[inner_start..recovery_start];
        let scheduled_guard = settlement
            .find("if scheduled_terminalization.is_some()")
            .unwrap();
        let recovery_response = settlement
            .find("return recovery_pending_response(")
            .unwrap();
        assert!(scheduled_guard < recovery_response);
        assert!(!settlement.contains("commit_recovery_required("));
        assert!(settlement.contains("scheduled terminalization provider result did not converge"));
        assert!(settlement.contains("scheduled_terminalization,"));
        let audit_start = source.find("fn terminal_audit_payload(").unwrap();
        let audit_end = source.find("fn validate_terminal_audit_identity(").unwrap();
        let audit_payload = &source[audit_start..audit_end];
        assert!(audit_payload.contains("request_id_hash"));
        assert!(audit_payload.contains("\"schema_version\": 2"));
        assert!(audit_payload.contains("\"schema_version\": 3"));
        assert!(audit_payload.contains("provider_response_evidence_sha256"));
        assert!(audit_payload.contains("client_response_artifact_sha256"));
        assert!(!audit_payload.contains("audit.request_id"));
        assert!(!audit_payload.contains("audit.client_ip"));
        let result_read = settlement.find("read_verified_container_result").unwrap();
        let response_read = settlement
            .find("verified_container_provider_client_response")
            .unwrap();
        let response_write = settlement.find("put_container_client_response").unwrap();
        let terminal_commit = settlement
            .find("commit_relay_container_financial_terminal")
            .unwrap();
        assert!(result_read < response_read);
        assert!(response_read < response_write);
        assert!(response_write < terminal_commit);
        assert!(settlement.contains("outcome.status_contract_version == 4"));
    }

    #[test]
    fn terminal_audit_identity_uses_frozen_reservation_not_attempt_metadata() {
        let reservation = RelayBillingReservation {
            reservation_key: "relaycontainer-v1-test".to_string(),
            user_id: 7,
            token_id: 11,
            model_name: "gpt-test".to_string(),
            endpoint_path: "/v1/chat/completions".to_string(),
            request_id_hash: format!("sha256:{}", "a".repeat(64)),
            expr_hash: "b".repeat(64),
            billing_kind: "flat".to_string(),
            billing_snapshot_json: "{}".to_string(),
            candidate_group_count: 1,
            reservation_strategy: "selected_group".to_string(),
            pre_consumed_quota: 100,
            status: "reserved".to_string(),
            channel_id: 17,
            selected_group: "default".to_string(),
            selected_at: 100,
            final_quota: 0,
            finalization_reason: String::new(),
            request_accounted: 0,
            lease_expires_at: 200,
            owner_generation: 1,
            owner_deadline_at: 200,
            owner_lease_renewed_at: 0,
            recovery_attempt_count: 0,
            created_at: 100,
            updated_at: 100,
        };
        for _attempt in 0..2 {
            validate_terminal_audit_identity(
                &reservation,
                Some(ContainerChatCanaryAudit {
                    user_id: 7,
                    token_id: 11,
                    model: "gpt-test",
                    endpoint_path: "/v1/chat/completions",
                }),
            )
            .unwrap();
        }
        validate_terminal_audit_identity(&reservation, None).unwrap();
        let err = validate_terminal_audit_identity(
            &reservation,
            Some(ContainerChatCanaryAudit {
                user_id: 7,
                token_id: 11,
                model: "different-model",
                endpoint_path: "/v1/chat/completions",
            }),
        )
        .unwrap_err();
        assert_eq!(
            err.class(),
            ContainerScheduledTerminalizationFailureClass::ContractViolation
        );
        assert_eq!(err.code(), "terminal_audit_identity_divergent");
    }

    #[test]
    fn financial_terminal_conflicts_are_permanent_but_stale_ownership_retries() {
        let conflict =
            require_financial_terminal(RelayContainerFinancialTerminalOutcome::DifferentDecision)
                .unwrap_err();
        assert_eq!(
            conflict.class(),
            ContainerScheduledTerminalizationFailureClass::ContractViolation
        );
        assert_eq!(conflict.code(), "financial_terminal_different_decision");

        let stale =
            require_financial_terminal(RelayContainerFinancialTerminalOutcome::StaleGeneration)
                .unwrap_err();
        assert_eq!(
            stale.class(),
            ContainerScheduledTerminalizationFailureClass::StoreUnavailable
        );
        assert_eq!(stale.code(), "financial_terminal_stale_generation");
    }
}
