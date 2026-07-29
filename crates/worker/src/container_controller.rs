//! Private edge Worker client for the isolated Container Controller.
//!
//! The probe is deliberately admin-only at its call site, bounded, signed, and
//! default-off. A configured service binding proves reachability only after the
//! controller accepts the shared authority token and reports the expected ring.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cinatoken_container_authority::{
    body_sha256, sign_authority, AuthorityInput, MIN_SECRET_BYTES,
};
use cinatoken_sharding::ShardPlan;
use futures_util::future::{select, Either};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::Duration;
use worker::{Delay, Env, Fetcher, Headers, Method, Request, RequestInit, RequestRedirect};

use crate::container_artifacts::{validate_container_artifact_manifest, ContainerArtifactManifest};
use crate::container_scheduler::ContainerSchedulerRuntimeStatus;

pub const CONTAINER_CONTROLLER_BINDING: &str = "CONTAINER_CONTROLLER";
pub const CONTAINER_CONTROLLER_PROBE_ENABLED_ENV: &str = "CONTAINER_CONTROLLER_PROBE_ENABLED";
pub const CONTAINER_SHARD_READINESS_PROBE_ENABLED_ENV: &str =
    "CONTAINER_SHARD_READINESS_PROBE_ENABLED";
pub const CONTAINER_SHARD_READINESS_WAKE_ENABLED_ENV: &str =
    "CONTAINER_SHARD_READINESS_WAKE_ENABLED";
pub const CONTAINER_AUTHORITY_ISSUER_ENV: &str = "CONTAINER_AUTHORITY_ISSUER";
pub const CONTAINER_AUTHORITY_AUDIENCE_ENV: &str = "CONTAINER_AUTHORITY_AUDIENCE";
pub const CONTAINER_AUTHORITY_CURRENT_KID_ENV: &str = "CONTAINER_AUTHORITY_CURRENT_KID";
pub const CONTAINER_AUTHORITY_CURRENT_SECRET_ENV: &str = "CONTAINER_AUTHORITY_CURRENT_SECRET";
pub const CONTAINER_PROTOCOL_VERSION_ENV: &str = "CONTAINER_PROTOCOL_VERSION";

const STATUS_PATH: &str = "/internal/v1/status";
const STATUS_URL: &str = "https://cinatoken-container-controller.internal/internal/v1/status";
const READINESS_PATH: &str = "/internal/v1/shards/readiness";
const READINESS_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v1/shards/readiness";
const AUTHORITY_HEADER: &str = "x-cinatoken-container-authority";
const OPERATION_PATH: &str = "/internal/v1/operations";
const OPERATION_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v1/operations";
const OPERATION_STATUS_PATH: &str = "/internal/v1/operations/status";
const OPERATION_STATUS_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v1/operations/status";
const OPERATION_STATUS_V2_PATH: &str = "/internal/v2/operations/status";
const OPERATION_STATUS_V2_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v2/operations/status";
const OPERATION_STATUS_V3_PATH: &str = "/internal/v3/operations/status";
const OPERATION_STATUS_V3_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v3/operations/status";
const OPERATION_STATUS_V3_AUTHORITY_DOMAIN: &[u8] = b"cinatoken-container-operation-status:v3\0";
const OPERATION_STATUS_V4_PATH: &str = "/internal/v4/operations/status";
const OPERATION_STATUS_V4_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v4/operations/status";
const OPERATION_STATUS_V4_AUTHORITY_DOMAIN: &[u8] = b"cinatoken-container-operation-status:v4\0";
const TERMINAL_ACK_PATH: &str = "/internal/v2/operations/terminal-ack";
const TERMINAL_ACK_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v2/operations/terminal-ack";
const TERMINAL_ACK_V2_AUTHORITY_DOMAIN: &[u8] = b"cinatoken-container-terminal-ack:v2\0";
const TERMINAL_ACK_V3_PATH: &str = "/internal/v3/operations/terminal-ack";
const TERMINAL_ACK_V3_URL: &str =
    "https://cinatoken-container-controller.internal/internal/v3/operations/terminal-ack";
const TERMINAL_ACK_V3_AUTHORITY_DOMAIN: &[u8] = b"cinatoken-container-terminal-ack:v3\0";
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const ACTIVATION_CAMPAIGN_READINESS_MAX_AGE_SECONDS: u64 = 3_600;
const STATUS_MAX_BYTES: usize = 4 * 1024;
const READINESS_MAX_BYTES: usize = 4 * 1024;
const OPERATION_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const OPERATION_STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const TERMINAL_ACK_RESPONSE_MAX_BYTES: usize = 4 * 1024;
const TERMINAL_ACK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
struct ShardReadinessRequest<'a> {
    protocol_version: u32,
    shard: &'a ShardPlan,
    wake_container: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    activation_campaign: Option<&'a ShardActivationCampaignCredential>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShardActivationCampaignCredential {
    pub contract_version: u32,
    pub campaign_id: String,
    pub nonce: String,
    pub confirm_consume: bool,
}

pub(crate) fn valid_shard_activation_campaign_credential(
    campaign: &ShardActivationCampaignCredential,
) -> bool {
    campaign.contract_version == 1
        && valid_lower_hex(&campaign.campaign_id, 64)
        && valid_lower_hex(&campaign.nonce, 64)
        && campaign.confirm_consume
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerOperationInput {
    pub mode: &'static str,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
    pub request_object_key: String,
    pub object_version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerOperationEnvelope {
    pub protocol_version: u32,
    pub operation_id: String,
    pub operation_kind: String,
    pub owner_generation: i64,
    pub owner_lease_expires_at: i64,
    pub execution_deadline_at: i64,
    pub provider_operation_id: String,
    pub admission_sha256: String,
    pub input: ContainerOperationInput,
    pub shard: ShardPlan,
    pub trace_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct ContainerOperationStatusQuery<'a> {
    protocol_version: u32,
    operation_id: &'a str,
    owner_generation: i64,
    shard: &'a ShardPlan,
    trace_id: &'a str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerTerminalAckResult {
    pub object_key: String,
    pub object_version: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerTerminalAckProviderUsageBinding {
    pub attempt_generation: i64,
    pub receipt_sha256: String,
    pub result_sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerTerminalAckProviderResponseBinding {
    pub attempt_generation: i64,
    pub status: String,
    pub response_class: String,
    pub provider_status: i64,
    pub client_status: i64,
    pub response_code: Option<String>,
    pub provider_response_evidence_sha256: String,
    pub client_response_artifact_sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerTerminalAckEnvelope {
    pub protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_ack_contract_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub financial_terminal_contract_version: Option<u32>,
    pub billing_event_id: String,
    pub terminal_contract_sha256: String,
    pub reconciliation_id: String,
    pub reconciliation_revision: i64,
    pub predecessor_billing_event_id: Option<String>,
    pub operation_id: String,
    pub owner_generation: i64,
    pub operation_from_status: String,
    pub operation_status: String,
    pub response_status: i64,
    pub response_code: Option<String>,
    pub result: Option<ContainerTerminalAckResult>,
    pub provider_usage_binding: Option<ContainerTerminalAckProviderUsageBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_response_binding: Option<ContainerTerminalAckProviderResponseBinding>,
    pub shard: ShardPlan,
    pub trace_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerTerminalAckV2Payload {
    protocol_version: u32,
    billing_event_id: String,
    operation_id: String,
    reconciliation_revision: i64,
    status: String,
    final_ack: bool,
    acknowledged_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerTerminalAckV3Payload {
    protocol_version: u32,
    terminal_ack_contract_version: u32,
    financial_terminal_contract_version: u32,
    billing_event_id: String,
    operation_id: String,
    reconciliation_revision: i64,
    terminal_contract_sha256: String,
    client_response_artifact_sha256: String,
    status: String,
    final_ack: bool,
    acknowledged_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerTerminalAckOutcome {
    Acknowledged { final_ack: bool },
    Duplicate { final_ack: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerTerminalAckError {
    Retryable(&'static str),
    Permanent(&'static str),
}

impl ContainerTerminalAckError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Retryable(code) | Self::Permanent(code) => code,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(self, Self::Retryable(_))
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationPayload {
    protocol_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
    provider_attempt: Option<ControllerProviderAttempt>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationStatusV1Payload {
    protocol_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationStatusV2Payload {
    protocol_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_attempt: Option<ControllerProviderAttempt>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationStatusV3Payload {
    protocol_version: u32,
    status_contract_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_usage_receipt_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_attempt: Option<ControllerProviderAttemptV3>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationStatusV4Payload {
    protocol_version: u32,
    status_contract_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_usage_receipt_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_attempt: Option<ControllerProviderAttemptV3>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_response_artifacts: Option<ControllerProviderResponseArtifacts>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerProviderResponseEvidenceManifest {
    object_key: String,
    object_version: String,
    provider_response_evidence_sha256: String,
    sha256: String,
    size: u64,
    content_type: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerClientResponseArtifactManifest {
    object_key: String,
    object_version: String,
    client_response_artifact_sha256: String,
    sha256: String,
    size: u64,
    content_type: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerProviderResponseArtifacts {
    operation_id: String,
    owner_generation: i64,
    attempt_generation: u32,
    provider_operation_id: String,
    admission_sha256: String,
    request_sha256: String,
    egress_profile: String,
    egress_worker_version_id: String,
    status: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_status: Option<u16>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    client_status: Option<u16>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    response_class: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    response_code: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    raw_manifest: Option<ControllerProviderResponseEvidenceManifest>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    client_manifest: Option<ControllerClientResponseArtifactManifest>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_usage_receipt_sha256: Option<String>,
    attached_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationResult {
    object_key: String,
    object_version: String,
    sha256: String,
    size: u64,
    content_type: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerProviderAttempt {
    attempt_generation: u32,
    provider_operation_id: String,
    admission_sha256: String,
    request_sha256: String,
    status: String,
    response_status: Option<u16>,
    response_code: Option<String>,
    result: Option<ControllerOperationResult>,
    prepared_at: i64,
    dispatched_at: Option<i64>,
    terminal_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerProviderAttemptV3 {
    attempt_generation: u32,
    provider_operation_id: String,
    admission_sha256: String,
    request_sha256: String,
    status: String,
    response_status: Option<u16>,
    response_code: Option<String>,
    result: Option<ControllerOperationResult>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_usage_receipt_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    provider_usage_receipt_attached_at: Option<i64>,
    prepared_at: i64,
    dispatched_at: Option<i64>,
    terminal_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationErrorPayload {
    error: String,
    retryable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerOperationStatus {
    Claimed,
    Running,
    Completed,
    Failed,
    RecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerProviderAttemptStatus {
    Prepared,
    Dispatched,
    Succeeded,
    DefiniteReject,
    Ambiguous,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerProviderAttemptOutcome {
    pub attempt_generation: u32,
    pub status: ContainerProviderAttemptStatus,
    pub response_status: Option<u16>,
    pub response_code: Option<String>,
    pub result: Option<ContainerArtifactManifest>,
    pub provider_usage_receipt_sha256: Option<String>,
    pub provider_usage_receipt_attached_at: Option<i64>,
    pub prepared_at: i64,
    pub dispatched_at: Option<i64>,
    pub terminal_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerProviderResponseEvidenceManifest {
    pub object_key: String,
    pub object_version: String,
    pub provider_response_evidence_sha256: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerClientResponseArtifactManifest {
    pub object_key: String,
    pub object_version: String,
    pub client_response_artifact_sha256: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerProviderResponseArtifactStatus {
    Succeeded,
    InterpretedReject,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerProviderResponseArtifactsOutcome {
    pub attempt_generation: u32,
    pub provider_operation_id: String,
    pub admission_sha256: String,
    pub request_sha256: String,
    pub egress_profile: String,
    pub egress_worker_version_id: String,
    pub status: ContainerProviderResponseArtifactStatus,
    pub provider_status: Option<u16>,
    pub client_status: Option<u16>,
    pub response_class: Option<String>,
    pub response_code: Option<String>,
    pub raw_manifest: Option<ContainerProviderResponseEvidenceManifest>,
    pub client_manifest: Option<ContainerClientResponseArtifactManifest>,
    pub provider_usage_receipt_sha256: Option<String>,
    pub attached_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerOperationOutcome {
    pub status_contract_version: u32,
    pub status: ContainerOperationStatus,
    pub http_status: u16,
    pub code: Option<String>,
    pub result: Option<ContainerArtifactManifest>,
    pub provider_usage_receipt_sha256: Option<String>,
    pub provider_attempt: Option<ContainerProviderAttemptOutcome>,
    pub provider_response_artifacts: Option<ContainerProviderResponseArtifactsOutcome>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShardReadinessResponse {
    pub protocol_version: u32,
    pub probe_id: String,
    pub checked_at: u64,
    pub mode: String,
    pub ready: bool,
    pub verdict: String,
    pub result_code: String,
    pub shard: ShardPlan,
    pub wake_requested: bool,
    pub container_state: Option<ContainerStateSnapshot>,
    pub ledger: ShardLedgerSnapshot,
    pub runtime: Option<RuntimeReadinessSnapshot>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContainerStateSnapshot {
    pub status: String,
    pub last_change_ms: u64,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShardLedgerSnapshot {
    pub initialized: bool,
    pub lifecycle_state: Option<String>,
    pub lifecycle_detail: Option<String>,
    pub lifecycle_updated_at: Option<u64>,
    pub active_in_flight_operations: u32,
    pub expired_in_flight_operations: u32,
    pub terminal_operations: u32,
    pub readiness: PersistedReadinessSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PersistedReadinessSnapshot {
    pub generation: u64,
    pub phase: String,
    pub last_probe_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub deadline_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub result_code: Option<String>,
    pub container_status: Option<String>,
    pub container_last_change_ms: Option<u64>,
    pub container_exit_code: Option<i32>,
    pub runtime_protocol_version: Option<u32>,
    pub runtime_contract_version: Option<u32>,
    pub runtime_execution_enabled: Option<bool>,
    pub last_ready_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeReadinessSnapshot {
    pub process_ready: bool,
    pub execution_ready: bool,
    pub protocol_version: u32,
    pub shard_contract_version: u32,
    pub runtime_build_id: Option<String>,
    pub execution_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerControllerProbe {
    pub probe_enabled: bool,
    pub binding_available: bool,
    pub authority_configured: bool,
    pub verified: bool,
    pub controller_enabled: bool,
    pub execution_enabled: bool,
    pub previous_secret_configured: bool,
    pub controller_version_id: Option<String>,
    pub shard_activation_write_enabled: bool,
    pub shard_activation_candidate_build_configured: bool,
    pub shard_placement_attestation_write_enabled: bool,
    pub shard_placement_attestation_staging_verified: bool,
    pub all_action_gates_false: bool,
    pub action_gate_inventory_sha256: Option<String>,
    pub state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthorityConfig {
    issuer: String,
    audience: String,
    kid: String,
    secret: String,
    protocol_version: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerStatusPayload {
    controller_enabled: bool,
    execution_enabled: bool,
    protocol_version: u32,
    ring_generation: u64,
    shard_count: u16,
    ring_transition_configured: bool,
    ring_transition_valid: bool,
    previous_ring_generation: Option<u64>,
    previous_shard_count: Option<u16>,
    previous_ring_admission_started_at: Option<u64>,
    previous_ring_admission_until: Option<u64>,
    previous_ring_admission_open: bool,
    controller_version_id: String,
    durable_object_jurisdiction: String,
    durable_object_jurisdiction_restricted: bool,
    durable_object_jurisdiction_enabled: bool,
    durable_object_jurisdiction_staging_verified: bool,
    shard_activation_write_enabled: bool,
    shard_activation_candidate_build_configured: bool,
    shard_placement_attestation_write_enabled: bool,
    shard_placement_attestation_staging_verified: bool,
    controller_service_name: String,
    all_action_gates_false: bool,
    action_gate_inventory_sha256: String,
    authority_current_secret_configured: bool,
    authority_previous_secret_configured: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerErrorPayload {
    error: String,
}

pub fn authority_secret_configured(env: &Env) -> bool {
    env.secret(CONTAINER_AUTHORITY_CURRENT_SECRET_ENV)
        .ok()
        .map(|secret| secret.to_string())
        .is_some_and(|secret| secret.as_bytes().len() >= MIN_SECRET_BYTES)
}

pub async fn probe(
    env: &Env,
    runtime: ContainerSchedulerRuntimeStatus,
) -> ContainerControllerProbe {
    let probe_enabled = runtime_flag(env, CONTAINER_CONTROLLER_PROBE_ENABLED_ENV);
    let fetcher = match env.service(CONTAINER_CONTROLLER_BINDING) {
        Ok(fetcher) => fetcher,
        Err(_) => {
            return failed_probe(
                probe_enabled,
                false,
                authority_secret_configured(env),
                "binding_unavailable",
            )
        }
    };
    if !probe_enabled {
        return failed_probe(false, true, authority_secret_configured(env), "disabled");
    }
    if !runtime.valid {
        return failed_probe(true, true, false, "ring_misconfigured");
    }
    let authority = match authority_config(env) {
        Some(authority) => authority,
        None => return failed_probe(true, true, false, "authority_unavailable"),
    };
    let dispatch_id = match random_dispatch_id("status") {
        Some(dispatch_id) => dispatch_id,
        None => return failed_probe(true, true, true, "entropy_unavailable"),
    };
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let token = match sign_status_authority(&authority, &dispatch_id, now) {
        Some(token) => token,
        None => return failed_probe(true, true, true, "authority_sign_failed"),
    };
    let request = match status_request(&token) {
        Ok(request) => request,
        Err(_) => return failed_probe(true, true, true, "request_build_failed"),
    };

    let operation = execute_status_probe(&fetcher, request, &authority, runtime);
    let delay = Delay::from(STATUS_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    let payload = match select(operation, delay).await {
        Either::Left((Ok(payload), _)) => payload,
        Either::Left((Err(state), _)) => return failed_probe(true, true, true, state),
        Either::Right(((), _)) => return failed_probe(true, true, true, "timeout"),
    };

    ContainerControllerProbe {
        probe_enabled: true,
        binding_available: true,
        authority_configured: true,
        verified: true,
        controller_enabled: payload.controller_enabled,
        execution_enabled: payload.execution_enabled,
        previous_secret_configured: payload.authority_previous_secret_configured,
        controller_version_id: Some(payload.controller_version_id),
        shard_activation_write_enabled: payload.shard_activation_write_enabled,
        shard_activation_candidate_build_configured: payload
            .shard_activation_candidate_build_configured,
        shard_placement_attestation_write_enabled: payload
            .shard_placement_attestation_write_enabled,
        shard_placement_attestation_staging_verified: payload
            .shard_placement_attestation_staging_verified,
        all_action_gates_false: payload.all_action_gates_false,
        action_gate_inventory_sha256: Some(payload.action_gate_inventory_sha256),
        state: "verified",
    }
}

pub async fn probe_shard_readiness(
    env: &Env,
    shard: &ShardPlan,
    wake_container: bool,
    activation_campaign: Option<&ShardActivationCampaignCredential>,
) -> Result<ShardReadinessResponse, &'static str> {
    if activation_campaign.is_some_and(|campaign| {
        !wake_container || !valid_shard_activation_campaign_credential(campaign)
    }) {
        return Err("invalid_activation_campaign");
    }
    let fetcher = env
        .service(CONTAINER_CONTROLLER_BINDING)
        .map_err(|_| "binding_unavailable")?;
    let authority = authority_config(env).ok_or("authority_unavailable")?;
    let dispatch_id = match activation_campaign {
        Some(campaign) => activation_campaign_probe_id(&campaign.campaign_id, shard.shard_index),
        None => random_dispatch_id("readiness").ok_or("entropy_unavailable")?,
    };
    let body = serde_json::to_vec(&ShardReadinessRequest {
        protocol_version: authority.protocol_version,
        shard,
        wake_container,
        activation_campaign,
    })
    .map_err(|_| "request_encode_failed")?;
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let token = sign_bound_authority(&authority, &dispatch_id, "POST", READINESS_PATH, &body, now)
        .ok_or("authority_sign_failed")?;
    let request = readiness_request(&token, &body).map_err(|_| "request_build_failed")?;
    let operation = execute_readiness_probe(
        &fetcher,
        request,
        &authority,
        &dispatch_id,
        shard,
        wake_container,
        activation_campaign.is_some(),
    );
    let delay = Delay::from(READINESS_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    match select(operation, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err("timeout"),
    }
}

pub async fn dispatch_operation(
    env: &Env,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    validate_operation_envelope_at(envelope, now)?;
    let fetcher = env
        .service(CONTAINER_CONTROLLER_BINDING)
        .map_err(|_| "binding_unavailable")?;
    let authority = authority_config(env).ok_or("authority_unavailable")?;
    if envelope.protocol_version != authority.protocol_version {
        return Err("protocol_mismatch");
    }
    let dispatch_id = random_dispatch_id("operation").ok_or("entropy_unavailable")?;
    let body = serde_json::to_vec(envelope).map_err(|_| "request_encode_failed")?;
    let token = sign_bound_authority(&authority, &dispatch_id, "POST", OPERATION_PATH, &body, now)
        .ok_or("authority_sign_failed")?;
    let request = operation_request(&token, &body).map_err(|_| "request_build_failed")?;
    let operation = execute_operation(&fetcher, request, envelope);
    let timeout_seconds = envelope
        .execution_deadline_at
        .saturating_sub(now)
        .clamp(1, 300)
        .saturating_add(5) as u64;
    let delay = Delay::from(Duration::from_secs(timeout_seconds));
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    match select(operation, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err("timeout"),
    }
}

pub async fn query_operation_status(
    env: &Env,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    validate_operation_identity(envelope)?;
    let fetcher = env
        .service(CONTAINER_CONTROLLER_BINDING)
        .map_err(|_| "binding_unavailable")?;
    let authority = authority_config(env).ok_or("authority_unavailable")?;
    if envelope.protocol_version != authority.protocol_version {
        return Err("protocol_mismatch");
    }
    let body = serde_json::to_vec(&ContainerOperationStatusQuery {
        protocol_version: envelope.protocol_version,
        operation_id: &envelope.operation_id,
        owner_generation: envelope.owner_generation,
        shard: &envelope.shard,
        trace_id: &envelope.trace_id,
    })
    .map_err(|_| "request_encode_failed")?;
    match query_operation_status_path(
        &fetcher,
        &authority,
        envelope,
        &body,
        OPERATION_STATUS_V4_PATH,
        OPERATION_STATUS_V4_URL,
        4,
    )
    .await
    {
        Err("route_not_found") => {
            match query_operation_status_path(
                &fetcher,
                &authority,
                envelope,
                &body,
                OPERATION_STATUS_V3_PATH,
                OPERATION_STATUS_V3_URL,
                3,
            )
            .await
            {
                Err("route_not_found") => {
                    match query_operation_status_path(
                        &fetcher,
                        &authority,
                        envelope,
                        &body,
                        OPERATION_STATUS_V2_PATH,
                        OPERATION_STATUS_V2_URL,
                        2,
                    )
                    .await
                    {
                        Err("route_not_found") => {
                            query_operation_status_path(
                                &fetcher,
                                &authority,
                                envelope,
                                &body,
                                OPERATION_STATUS_PATH,
                                OPERATION_STATUS_URL,
                                1,
                            )
                            .await
                        }
                        result => result,
                    }
                }
                result => result,
            }
        }
        result => result,
    }
}

pub async fn acknowledge_terminal_event(
    env: &Env,
    envelope: &ContainerTerminalAckEnvelope,
) -> Result<ContainerTerminalAckOutcome, ContainerTerminalAckError> {
    validate_terminal_ack_envelope(envelope).map_err(ContainerTerminalAckError::Permanent)?;
    let fetcher = env
        .service(CONTAINER_CONTROLLER_BINDING)
        .map_err(|_| ContainerTerminalAckError::Retryable("binding_unavailable"))?;
    let authority = authority_config(env).ok_or(ContainerTerminalAckError::Retryable(
        "authority_unavailable",
    ))?;
    if envelope.protocol_version != authority.protocol_version {
        return Err(ContainerTerminalAckError::Retryable("protocol_mismatch"));
    }
    let dispatch_id = random_dispatch_id("terminal-ack")
        .ok_or(ContainerTerminalAckError::Retryable("entropy_unavailable"))?;
    let body = serde_json::to_vec(envelope)
        .map_err(|_| ContainerTerminalAckError::Permanent("request_encode_failed"))?;
    let (path, url, authority_domain) = if envelope.terminal_ack_contract_version == Some(3) {
        (
            TERMINAL_ACK_V3_PATH,
            TERMINAL_ACK_V3_URL,
            TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
        )
    } else {
        (
            TERMINAL_ACK_PATH,
            TERMINAL_ACK_URL,
            TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
        )
    };
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let token = sign_bound_authority_with_domain(
        &authority,
        &dispatch_id,
        "POST",
        path,
        &body,
        now,
        authority_domain,
    )
    .ok_or(ContainerTerminalAckError::Retryable(
        "authority_sign_failed",
    ))?;
    let request = terminal_ack_request(&token, &body, url).map_err(|err| {
        worker::console_error!("container terminal ack request construction failed: {err}");
        ContainerTerminalAckError::Retryable("request_build_failed")
    })?;
    let operation = execute_terminal_ack(&fetcher, request, envelope);
    let delay = Delay::from(TERMINAL_ACK_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    match select(operation, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err(ContainerTerminalAckError::Retryable("timeout")),
    }
}

async fn query_operation_status_path(
    fetcher: &Fetcher,
    authority: &AuthorityConfig,
    envelope: &ContainerOperationEnvelope,
    body: &[u8],
    path: &'static str,
    url: &'static str,
    status_contract_version: u32,
) -> Result<ContainerOperationOutcome, &'static str> {
    let dispatch_id = random_dispatch_id("operation-status").ok_or("entropy_unavailable")?;
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let status_authority_domain = match status_contract_version {
        3 => Some(OPERATION_STATUS_V3_AUTHORITY_DOMAIN),
        4 => Some(OPERATION_STATUS_V4_AUTHORITY_DOMAIN),
        _ => None,
    };
    let token = if let Some(domain) = status_authority_domain {
        sign_bound_authority_with_domain(authority, &dispatch_id, "POST", path, body, now, domain)
    } else {
        sign_bound_authority(authority, &dispatch_id, "POST", path, body, now)
    }
    .ok_or("authority_sign_failed")?;
    let request =
        operation_status_request(url, &token, body).map_err(|_| "request_build_failed")?;
    let operation = execute_operation_status(fetcher, request, envelope, status_contract_version);
    let delay = Delay::from(OPERATION_STATUS_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    match select(operation, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err("timeout"),
    }
}

async fn execute_status_probe(
    fetcher: &Fetcher,
    request: Request,
    authority: &AuthorityConfig,
    runtime: ContainerSchedulerRuntimeStatus,
) -> Result<ControllerStatusPayload, &'static str> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| "request_failed")?;
    if response.status_code() != 200 {
        return Err("unexpected_status");
    }
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err("invalid_content_type");
    }
    let body =
        match crate::relay::read_response_bytes_limited(&mut response, STATUS_MAX_BYTES).await {
            Ok(body) => body,
            Err(_) => return Err("invalid_response_size"),
        };
    let payload = match serde_json::from_slice::<ControllerStatusPayload>(&body) {
        Ok(payload) => payload,
        Err(_) => return Err("invalid_response_body"),
    };
    if !status_matches(&payload, &authority, runtime) {
        return Err("contract_mismatch");
    }
    Ok(payload)
}

async fn execute_readiness_probe(
    fetcher: &Fetcher,
    request: Request,
    authority: &AuthorityConfig,
    dispatch_id: &str,
    shard: &ShardPlan,
    wake_container: bool,
    activation_campaign: bool,
) -> Result<ShardReadinessResponse, &'static str> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| "request_failed")?;
    let status = response.status_code();
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err("invalid_content_type");
    }
    let body = crate::relay::read_response_bytes_limited(&mut response, READINESS_MAX_BYTES)
        .await
        .map_err(|_| "invalid_response_size")?;
    if status != 200 {
        let error = serde_json::from_slice::<ControllerErrorPayload>(&body)
            .map_err(|_| "invalid_response_body")?;
        return Err(match (status, error.error.as_str()) {
            (403, code) if code.starts_with("shard_activation_campaign_") => {
                "activation_campaign_rejected"
            }
            (403, _) => "authority_rejected",
            (409, code) if code.starts_with("shard_activation_campaign_") => {
                "activation_campaign_conflict"
            }
            (409, "stale_shard_fence" | "ring_generation_in_flight") => "shard_fence_rejected",
            (
                409,
                "readiness_probe_in_progress"
                | "readiness_probe_replay"
                | "readiness_probe_superseded",
            ) => "readiness_conflict",
            (429, "readiness_probe_cooldown" | "container_start_rate_limited") => {
                "readiness_rate_limited"
            }
            (426, _) => "protocol_rejected",
            (503, _) => "controller_unavailable",
            _ => "unexpected_status",
        });
    }
    let payload = serde_json::from_slice::<ShardReadinessResponse>(&body)
        .map_err(|_| "invalid_response_body")?;
    let now = (worker::Date::now().as_millis() / 1000) as u64;
    if !readiness_response_matches(
        &payload,
        authority,
        dispatch_id,
        shard,
        wake_container,
        activation_campaign,
        now,
    ) {
        return Err("contract_mismatch");
    }
    Ok(payload)
}

async fn execute_operation(
    fetcher: &Fetcher,
    request: Request,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| "request_failed")?;
    let status = response.status_code();
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err("invalid_content_type");
    }
    let body =
        crate::relay::read_response_bytes_limited(&mut response, OPERATION_RESPONSE_MAX_BYTES)
            .await
            .map_err(|_| "invalid_response_size")?;
    match serde_json::from_slice::<ControllerOperationPayload>(&body) {
        Ok(payload) => operation_outcome(status, payload, envelope),
        Err(_) => {
            let error = serde_json::from_slice::<ControllerOperationErrorPayload>(&body)
                .map_err(|_| "invalid_response_body")?;
            Err(classify_operation_error(status, &error))
        }
    }
}

async fn execute_operation_status(
    fetcher: &Fetcher,
    request: Request,
    envelope: &ContainerOperationEnvelope,
    status_contract_version: u32,
) -> Result<ContainerOperationOutcome, &'static str> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| "request_failed")?;
    let status = response.status_code();
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err("invalid_content_type");
    }
    let body =
        crate::relay::read_response_bytes_limited(&mut response, OPERATION_RESPONSE_MAX_BYTES)
            .await
            .map_err(|_| "invalid_response_size")?;
    match status_contract_version {
        1 => {
            if let Ok(payload) = serde_json::from_slice::<ControllerOperationStatusV1Payload>(&body)
            {
                return operation_status_v1_outcome(status, payload, envelope);
            }
        }
        2 => {
            if let Ok(payload) = serde_json::from_slice::<ControllerOperationStatusV2Payload>(&body)
            {
                return operation_status_v2_outcome(status, payload, envelope);
            }
        }
        3 => {
            if let Ok(payload) = serde_json::from_slice::<ControllerOperationStatusV3Payload>(&body)
            {
                return operation_status_v3_outcome(status, payload, envelope);
            }
        }
        4 => {
            if let Ok(payload) = serde_json::from_slice::<ControllerOperationStatusV4Payload>(&body)
            {
                return operation_status_v4_outcome(status, payload, envelope);
            }
        }
        _ => return Err("contract_mismatch"),
    }
    let error = serde_json::from_slice::<ControllerOperationErrorPayload>(&body)
        .map_err(|_| "invalid_response_body")?;
    Err(classify_operation_error(status, &error))
}

fn operation_status_v1_outcome(
    http_status: u16,
    payload: ControllerOperationStatusV1Payload,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    let mut outcome = operation_outcome(
        http_status,
        ControllerOperationPayload {
            protocol_version: payload.protocol_version,
            operation_id: payload.operation_id,
            status: payload.status,
            code: payload.code,
            trace_id: payload.trace_id,
            result: payload.result,
            provider_attempt: None,
        },
        envelope,
    )?;
    outcome.status_contract_version = 1;
    Ok(outcome)
}

fn operation_status_v2_outcome(
    http_status: u16,
    payload: ControllerOperationStatusV2Payload,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    let mut outcome = operation_outcome(
        http_status,
        ControllerOperationPayload {
            protocol_version: payload.protocol_version,
            operation_id: payload.operation_id,
            status: payload.status,
            code: payload.code,
            trace_id: payload.trace_id,
            result: payload.result,
            provider_attempt: payload.provider_attempt,
        },
        envelope,
    )?;
    outcome.status_contract_version = 2;
    Ok(outcome)
}

fn operation_status_v3_outcome(
    http_status: u16,
    payload: ControllerOperationStatusV3Payload,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    if payload.status_contract_version != 3 {
        return Err("contract_mismatch");
    }
    let root_receipt_sha256 = payload.provider_usage_receipt_sha256;
    let provider_attempt = payload.provider_attempt;
    let attempt_receipt = provider_attempt.as_ref().map(|attempt| {
        (
            attempt.provider_usage_receipt_sha256.clone(),
            attempt.provider_usage_receipt_attached_at,
        )
    });
    let legacy_attempt = provider_attempt.map(|attempt| ControllerProviderAttempt {
        attempt_generation: attempt.attempt_generation,
        provider_operation_id: attempt.provider_operation_id,
        admission_sha256: attempt.admission_sha256,
        request_sha256: attempt.request_sha256,
        status: attempt.status,
        response_status: attempt.response_status,
        response_code: attempt.response_code,
        result: attempt.result,
        prepared_at: attempt.prepared_at,
        dispatched_at: attempt.dispatched_at,
        terminal_at: attempt.terminal_at,
    });
    let mut outcome = operation_outcome(
        http_status,
        ControllerOperationPayload {
            protocol_version: payload.protocol_version,
            operation_id: payload.operation_id,
            status: payload.status,
            code: payload.code,
            trace_id: payload.trace_id,
            result: payload.result,
            provider_attempt: legacy_attempt,
        },
        envelope,
    )?;
    if root_receipt_sha256
        .as_deref()
        .is_some_and(|value| !valid_sha256(value))
    {
        return Err("contract_mismatch");
    }
    if let Some((receipt_sha256, attached_at)) = attempt_receipt {
        let pair_valid = match (receipt_sha256.as_deref(), attached_at) {
            (None, None) => true,
            (Some(receipt_sha256), Some(attached_at)) => {
                valid_sha256(receipt_sha256)
                    && attached_at > 0
                    && outcome.provider_attempt.as_ref().is_some_and(|attempt| {
                        attempt
                            .dispatched_at
                            .is_some_and(|value| attached_at >= value)
                            && attempt.terminal_at.is_none_or(|value| attached_at <= value)
                    })
            }
            _ => false,
        };
        let attempt = outcome
            .provider_attempt
            .as_mut()
            .ok_or("contract_mismatch")?;
        if !pair_valid
            || receipt_sha256.as_deref() != root_receipt_sha256.as_deref()
            || (matches!(
                attempt.status,
                ContainerProviderAttemptStatus::Prepared
                    | ContainerProviderAttemptStatus::DefiniteReject
                    | ContainerProviderAttemptStatus::Cancelled
            ) && receipt_sha256.is_some())
            || (matches!(attempt.status, ContainerProviderAttemptStatus::Ambiguous)
                && attempt.result.is_some() != receipt_sha256.is_some())
        {
            return Err("contract_mismatch");
        }
        attempt.provider_usage_receipt_sha256 = receipt_sha256;
        attempt.provider_usage_receipt_attached_at = attached_at;
    } else if root_receipt_sha256.is_some() {
        return Err("contract_mismatch");
    }
    outcome.status_contract_version = 3;
    outcome.provider_usage_receipt_sha256 = root_receipt_sha256;
    Ok(outcome)
}

fn operation_status_v4_outcome(
    http_status: u16,
    payload: ControllerOperationStatusV4Payload,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    if payload.status_contract_version != 4 {
        return Err("contract_mismatch");
    }
    let artifacts = payload.provider_response_artifacts;
    let mut outcome = operation_status_v3_outcome(
        http_status,
        ControllerOperationStatusV3Payload {
            protocol_version: payload.protocol_version,
            status_contract_version: 3,
            operation_id: payload.operation_id,
            status: payload.status,
            code: payload.code,
            trace_id: payload.trace_id,
            result: payload.result,
            provider_usage_receipt_sha256: payload.provider_usage_receipt_sha256,
            provider_attempt: payload.provider_attempt,
        },
        envelope,
    )?;
    outcome.provider_response_artifacts = artifacts
        .map(|artifacts| provider_response_artifacts_outcome(artifacts, &outcome, envelope))
        .transpose()?;
    outcome.status_contract_version = 4;
    Ok(outcome)
}

fn provider_response_artifacts_outcome(
    artifacts: ControllerProviderResponseArtifacts,
    outcome: &ContainerOperationOutcome,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerProviderResponseArtifactsOutcome, &'static str> {
    let attempt = outcome
        .provider_attempt
        .as_ref()
        .ok_or("contract_mismatch")?;
    if artifacts.operation_id != envelope.operation_id
        || artifacts.owner_generation != envelope.owner_generation
        || artifacts.attempt_generation != 1
        || artifacts.attempt_generation != attempt.attempt_generation
        || artifacts.provider_operation_id != envelope.provider_operation_id
        || artifacts.admission_sha256 != envelope.admission_sha256
        || artifacts.request_sha256 != envelope.input.sha256
        || artifacts.egress_profile != "openai-chat-completions-canary-v1"
        || !valid_egress_worker_version(&artifacts.egress_worker_version_id)
        || artifacts.attached_at < 1
        || attempt
            .dispatched_at
            .is_none_or(|dispatched_at| artifacts.attached_at < dispatched_at)
        || attempt
            .terminal_at
            .is_some_and(|terminal_at| artifacts.attached_at > terminal_at)
    {
        return Err("contract_mismatch");
    }

    let raw_manifest = artifacts
        .raw_manifest
        .map(|manifest| provider_response_evidence_manifest(manifest, envelope, 1))
        .transpose()?;
    let client_manifest = artifacts
        .client_manifest
        .map(|manifest| client_response_artifact_manifest(manifest, envelope))
        .transpose()?;
    let no_financial_evidence = outcome.result.is_none()
        && outcome.provider_usage_receipt_sha256.is_none()
        && attempt.result.is_none()
        && attempt.provider_usage_receipt_sha256.is_none()
        && attempt.provider_usage_receipt_attached_at.is_none()
        && artifacts.provider_usage_receipt_sha256.is_none();

    let status = match artifacts.status.as_str() {
        "succeeded"
            if matches!(
                attempt.status,
                ContainerProviderAttemptStatus::Dispatched
                    | ContainerProviderAttemptStatus::Succeeded
                    | ContainerProviderAttemptStatus::Ambiguous
            ) && artifacts.provider_status == Some(200)
                && artifacts.client_status == Some(200)
                && artifacts.response_class.as_deref() == Some("success")
                && artifacts.response_code.is_none()
                && raw_manifest.is_some()
                && client_manifest.is_some()
                && artifacts
                    .provider_usage_receipt_sha256
                    .as_deref()
                    .is_some_and(valid_sha256)
                && artifacts.provider_usage_receipt_sha256
                    == outcome.provider_usage_receipt_sha256
                && artifacts.provider_usage_receipt_sha256
                    == attempt.provider_usage_receipt_sha256
                && attempt
                    .provider_usage_receipt_attached_at
                    .is_some_and(|attached_at| attached_at <= artifacts.attached_at)
                && outcome.result.as_ref().is_some_and(|result| {
                    client_manifest.as_ref().is_some_and(|manifest| {
                        manifest.sha256 == result.sha256
                            && manifest.size == result.size
                            && manifest.content_type == result.content_type
                    })
                }) =>
        {
            ContainerProviderResponseArtifactStatus::Succeeded
        }
        "interpreted_reject"
            if matches!(
                attempt.status,
                ContainerProviderAttemptStatus::Dispatched
                    | ContainerProviderAttemptStatus::DefiniteReject
                    | ContainerProviderAttemptStatus::Ambiguous
            ) && no_financial_evidence
                && raw_manifest.is_some()
                && client_manifest.is_some()
                && artifacts
                    .response_code
                    .as_deref()
                    .is_some_and(valid_response_code)
                && provider_rejection_binding_valid(
                    artifacts.response_class.as_deref(),
                    artifacts.provider_status,
                    artifacts.client_status,
                    artifacts.response_code.as_deref(),
                ) =>
        {
            ContainerProviderResponseArtifactStatus::InterpretedReject
        }
        "ambiguous"
            if matches!(
                attempt.status,
                ContainerProviderAttemptStatus::Dispatched
                    | ContainerProviderAttemptStatus::Ambiguous
            ) && no_financial_evidence
                && artifacts.provider_status.is_none()
                && artifacts.client_status.is_none()
                && artifacts.response_class.is_none()
                && artifacts
                    .response_code
                    .as_deref()
                    .is_some_and(valid_response_code)
                && raw_manifest.is_none()
                && client_manifest.is_none() =>
        {
            ContainerProviderResponseArtifactStatus::Ambiguous
        }
        _ => return Err("contract_mismatch"),
    };

    Ok(ContainerProviderResponseArtifactsOutcome {
        attempt_generation: artifacts.attempt_generation,
        provider_operation_id: artifacts.provider_operation_id,
        admission_sha256: artifacts.admission_sha256,
        request_sha256: artifacts.request_sha256,
        egress_profile: artifacts.egress_profile,
        egress_worker_version_id: artifacts.egress_worker_version_id,
        status,
        provider_status: artifacts.provider_status,
        client_status: artifacts.client_status,
        response_class: artifacts.response_class,
        response_code: artifacts.response_code,
        raw_manifest,
        client_manifest,
        provider_usage_receipt_sha256: artifacts.provider_usage_receipt_sha256,
        attached_at: artifacts.attached_at,
    })
}

fn provider_response_evidence_manifest(
    manifest: ControllerProviderResponseEvidenceManifest,
    envelope: &ContainerOperationEnvelope,
    attempt_generation: u32,
) -> Result<ContainerProviderResponseEvidenceManifest, &'static str> {
    let expected_key = format!(
        "container-provider-evidence/v1/{}/{}/{}/{}",
        envelope.operation_id, envelope.owner_generation, attempt_generation, manifest.sha256
    );
    if manifest.object_key != expected_key
        || !valid_identifier(&manifest.object_version, 128)
        || !valid_sha256(&manifest.provider_response_evidence_sha256)
        || !valid_sha256(&manifest.sha256)
        || manifest.size > 4 * 1024 * 1024
        || !valid_artifact_content_type(&manifest.content_type)
    {
        return Err("contract_mismatch");
    }
    Ok(ContainerProviderResponseEvidenceManifest {
        object_key: manifest.object_key,
        object_version: manifest.object_version,
        provider_response_evidence_sha256: manifest.provider_response_evidence_sha256,
        sha256: manifest.sha256,
        size: manifest.size,
        content_type: manifest.content_type,
    })
}

fn client_response_artifact_manifest(
    manifest: ControllerClientResponseArtifactManifest,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerClientResponseArtifactManifest, &'static str> {
    let expected_key = format!(
        "container-client-artifacts/v1/{}/{}/{}",
        envelope.operation_id, envelope.owner_generation, manifest.client_response_artifact_sha256
    );
    if manifest.object_key != expected_key
        || !valid_identifier(&manifest.object_version, 128)
        || !valid_sha256(&manifest.client_response_artifact_sha256)
        || !valid_sha256(&manifest.sha256)
        || !(2..=4 * 1024 * 1024).contains(&manifest.size)
        || manifest.content_type != "application/json"
    {
        return Err("contract_mismatch");
    }
    Ok(ContainerClientResponseArtifactManifest {
        object_key: manifest.object_key,
        object_version: manifest.object_version,
        client_response_artifact_sha256: manifest.client_response_artifact_sha256,
        sha256: manifest.sha256,
        size: manifest.size,
        content_type: manifest.content_type,
    })
}

fn provider_rejection_binding_valid(
    response_class: Option<&str>,
    provider_status: Option<u16>,
    client_status: Option<u16>,
    response_code: Option<&str>,
) -> bool {
    match response_class {
        Some("typed_error") => {
            provider_status == Some(200)
                && client_status == Some(200)
                && response_code == Some("provider_typed_error")
        }
        Some("http_error") => {
            provider_status.is_some_and(|status| status != 200)
                && client_status == provider_status
                && response_code == Some("provider_http_error")
        }
        Some("invalid_body") => {
            provider_status == Some(200)
                && client_status == Some(500)
                && response_code == Some("provider_invalid_body")
        }
        _ => false,
    }
}

async fn execute_terminal_ack(
    fetcher: &Fetcher,
    request: Request,
    envelope: &ContainerTerminalAckEnvelope,
) -> Result<ContainerTerminalAckOutcome, ContainerTerminalAckError> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| ContainerTerminalAckError::Retryable("request_failed"))?;
    let status = response.status_code();
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let cache_control = response
        .headers()
        .get("cache-control")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") || !cache_control.contains("no-store") {
        return Err(ContainerTerminalAckError::Retryable(
            "invalid_response_headers",
        ));
    }
    let body =
        crate::relay::read_response_bytes_limited(&mut response, TERMINAL_ACK_RESPONSE_MAX_BYTES)
            .await
            .map_err(|_| ContainerTerminalAckError::Retryable("invalid_response_size"))?;
    if status == 200 {
        if envelope.terminal_ack_contract_version == Some(3) {
            let payload = serde_json::from_slice::<ControllerTerminalAckV3Payload>(&body)
                .map_err(|_| ContainerTerminalAckError::Retryable("invalid_response_body"))?;
            return terminal_ack_v3_outcome(payload, envelope);
        }
        let payload = serde_json::from_slice::<ControllerTerminalAckV2Payload>(&body)
            .map_err(|_| ContainerTerminalAckError::Retryable("invalid_response_body"))?;
        return terminal_ack_v2_outcome(payload, envelope);
    }
    let error = serde_json::from_slice::<ControllerOperationErrorPayload>(&body)
        .map_err(|_| ContainerTerminalAckError::Retryable("invalid_response_body"))?;
    Err(classify_terminal_ack_error(status, &error))
}

fn terminal_ack_v2_outcome(
    payload: ControllerTerminalAckV2Payload,
    envelope: &ContainerTerminalAckEnvelope,
) -> Result<ContainerTerminalAckOutcome, ContainerTerminalAckError> {
    let expected_final = envelope.operation_status != "recovery_required";
    let timestamp_valid = if expected_final {
        payload.acknowledged_at.is_some_and(|value| value > 0)
    } else {
        payload.acknowledged_at.is_none()
    };
    if payload.protocol_version != envelope.protocol_version
        || payload.billing_event_id != envelope.billing_event_id
        || payload.operation_id != envelope.operation_id
        || payload.reconciliation_revision != envelope.reconciliation_revision
        || payload.final_ack != expected_final
        || !timestamp_valid
    {
        return Err(ContainerTerminalAckError::Permanent(
            "terminal_ack_contract_mismatch",
        ));
    }
    match payload.status.as_str() {
        "acknowledged" => Ok(ContainerTerminalAckOutcome::Acknowledged {
            final_ack: payload.final_ack,
        }),
        "duplicate" => Ok(ContainerTerminalAckOutcome::Duplicate {
            final_ack: payload.final_ack,
        }),
        _ => Err(ContainerTerminalAckError::Permanent(
            "terminal_ack_contract_mismatch",
        )),
    }
}

fn terminal_ack_v3_outcome(
    payload: ControllerTerminalAckV3Payload,
    envelope: &ContainerTerminalAckEnvelope,
) -> Result<ContainerTerminalAckOutcome, ContainerTerminalAckError> {
    let binding =
        envelope
            .provider_response_binding
            .as_ref()
            .ok_or(ContainerTerminalAckError::Permanent(
                "terminal_ack_contract_mismatch",
            ))?;
    if payload.protocol_version != envelope.protocol_version
        || payload.terminal_ack_contract_version != 3
        || payload.financial_terminal_contract_version != 2
        || payload.billing_event_id != envelope.billing_event_id
        || payload.operation_id != envelope.operation_id
        || payload.reconciliation_revision != envelope.reconciliation_revision
        || payload.terminal_contract_sha256 != envelope.terminal_contract_sha256
        || payload.client_response_artifact_sha256 != binding.client_response_artifact_sha256
        || !payload.final_ack
        || payload.acknowledged_at <= 0
    {
        return Err(ContainerTerminalAckError::Permanent(
            "terminal_ack_contract_mismatch",
        ));
    }
    match payload.status.as_str() {
        "acknowledged" => Ok(ContainerTerminalAckOutcome::Acknowledged { final_ack: true }),
        "duplicate" => Ok(ContainerTerminalAckOutcome::Duplicate { final_ack: true }),
        _ => Err(ContainerTerminalAckError::Permanent(
            "terminal_ack_contract_mismatch",
        )),
    }
}

fn classify_terminal_ack_error(
    http_status: u16,
    payload: &ControllerOperationErrorPayload,
) -> ContainerTerminalAckError {
    match (http_status, payload.error.as_str(), payload.retryable) {
        (400, "invalid_terminal_ack", _) | (409, "terminal_ack_conflict", _) => {
            ContainerTerminalAckError::Permanent("terminal_ack_conflict")
        }
        (404, "route_not_found", _) => ContainerTerminalAckError::Retryable("route_not_found"),
        (404, "terminal_ack_not_found", _) => {
            ContainerTerminalAckError::Permanent("terminal_ack_not_found")
        }
        (403, _, _) => ContainerTerminalAckError::Retryable("authority_rejected"),
        (409, "stale_shard_fence", _) => {
            ContainerTerminalAckError::Retryable("shard_fence_rejected")
        }
        (409, "authority_expired", _) => ContainerTerminalAckError::Retryable("authority_expired"),
        (409, _, _) => ContainerTerminalAckError::Permanent("terminal_ack_conflict"),
        (426, _, _) => ContainerTerminalAckError::Retryable("protocol_rejected"),
        (429, _, _) => ContainerTerminalAckError::Retryable("controller_rate_limited"),
        (503, _, _) => ContainerTerminalAckError::Retryable("controller_unavailable"),
        _ => ContainerTerminalAckError::Retryable("unexpected_status"),
    }
}

fn operation_outcome(
    http_status: u16,
    payload: ControllerOperationPayload,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerOperationOutcome, &'static str> {
    if payload.protocol_version != envelope.protocol_version
        || payload.operation_id != envelope.operation_id
        || payload.trace_id != envelope.trace_id
    {
        return Err("contract_mismatch");
    }
    let code_valid = payload.code.as_deref().is_some_and(valid_response_code);
    let (status, result) = match payload.status.as_str() {
        "claimed" if http_status == 202 && payload.code.is_none() && payload.result.is_none() => {
            (ContainerOperationStatus::Claimed, None)
        }
        "running" if http_status == 202 && payload.code.is_none() => (
            ContainerOperationStatus::Running,
            payload
                .result
                .map(|result| result_manifest(result, envelope))
                .transpose()?,
        ),
        "completed"
            if (200..=299).contains(&http_status)
                && http_status != 202
                && payload.code.is_none() =>
        {
            let result = payload
                .result
                .map(|result| result_manifest(result, envelope))
                .transpose()?;
            if (envelope.operation_kind == "health_probe") != result.is_none() {
                return Err("contract_mismatch");
            }
            (ContainerOperationStatus::Completed, result)
        }
        "failed"
            if (400..=599).contains(&http_status) && code_valid && payload.result.is_none() =>
        {
            (ContainerOperationStatus::Failed, None)
        }
        "recovery_required" if http_status == 202 && code_valid => (
            ContainerOperationStatus::RecoveryRequired,
            payload
                .result
                .map(|result| result_manifest(result, envelope))
                .transpose()?,
        ),
        _ => return Err("contract_mismatch"),
    };
    let provider_attempt = payload
        .provider_attempt
        .map(|attempt| provider_attempt_outcome(attempt, envelope))
        .transpose()?;
    if provider_attempt.as_ref().is_some_and(|attempt| {
        matches!(status, ContainerOperationStatus::Claimed)
            || (matches!(status, ContainerOperationStatus::Running)
                && matches!(
                    attempt.status,
                    ContainerProviderAttemptStatus::Ambiguous
                        | ContainerProviderAttemptStatus::Cancelled
                ))
            || (matches!(status, ContainerOperationStatus::Completed)
                && !matches!(attempt.status, ContainerProviderAttemptStatus::Succeeded))
            || (matches!(status, ContainerOperationStatus::Failed)
                && !matches!(
                    attempt.status,
                    ContainerProviderAttemptStatus::DefiniteReject
                        | ContainerProviderAttemptStatus::Cancelled
                ))
            || (matches!(status, ContainerOperationStatus::RecoveryRequired)
                && !matches!(attempt.status, ContainerProviderAttemptStatus::Ambiguous))
    }) {
        return Err("contract_mismatch");
    }
    if provider_attempt
        .as_ref()
        .and_then(|attempt| attempt.result.as_ref())
        .is_some_and(|attempt_result| result.as_ref() != Some(attempt_result))
    {
        return Err("contract_mismatch");
    }
    Ok(ContainerOperationOutcome {
        status_contract_version: 1,
        status,
        http_status,
        code: payload.code,
        result,
        provider_usage_receipt_sha256: None,
        provider_attempt,
        provider_response_artifacts: None,
    })
}

fn provider_attempt_outcome(
    attempt: ControllerProviderAttempt,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerProviderAttemptOutcome, &'static str> {
    if attempt.attempt_generation < 1
        || attempt.attempt_generation > 3
        || attempt.provider_operation_id != envelope.provider_operation_id
        || attempt.admission_sha256 != envelope.admission_sha256
        || attempt.request_sha256 != envelope.input.sha256
        || attempt.prepared_at < 1
        || attempt.prepared_at >= envelope.execution_deadline_at
        || attempt.prepared_at >= envelope.owner_lease_expires_at
        || attempt.dispatched_at.is_some_and(|value| {
            value < attempt.prepared_at || value >= envelope.execution_deadline_at
        })
        || attempt.terminal_at.is_some_and(|value| {
            value < attempt.prepared_at
                || attempt
                    .dispatched_at
                    .is_some_and(|dispatched_at| value < dispatched_at)
        })
    {
        return Err("contract_mismatch");
    }
    let result = attempt
        .result
        .map(|result| result_manifest(result, envelope))
        .transpose()?;
    let code_valid = attempt
        .response_code
        .as_deref()
        .is_some_and(valid_response_code);
    let status = match attempt.status.as_str() {
        "prepared"
            if attempt.response_status.is_none()
                && attempt.response_code.is_none()
                && result.is_none()
                && attempt.dispatched_at.is_none()
                && attempt.terminal_at.is_none() =>
        {
            ContainerProviderAttemptStatus::Prepared
        }
        "dispatched"
            if attempt.response_status.is_none()
                && attempt.response_code.is_none()
                && result.is_none()
                && attempt.dispatched_at.is_some()
                && attempt.terminal_at.is_none() =>
        {
            ContainerProviderAttemptStatus::Dispatched
        }
        "succeeded"
            if attempt
                .response_status
                .is_some_and(|status| (200..=299).contains(&status))
                && attempt.response_code.is_none()
                && result.is_some()
                && attempt.dispatched_at.is_some()
                && attempt.terminal_at.is_some_and(|value| {
                    value < envelope.execution_deadline_at
                        && value < envelope.owner_lease_expires_at
                }) =>
        {
            ContainerProviderAttemptStatus::Succeeded
        }
        "definite_reject"
            if attempt
                .response_status
                .is_some_and(|status| (400..=599).contains(&status))
                && code_valid
                && result.is_none()
                && attempt.dispatched_at.is_some()
                && attempt.terminal_at.is_some_and(|value| {
                    value < envelope.execution_deadline_at
                        && value < envelope.owner_lease_expires_at
                }) =>
        {
            ContainerProviderAttemptStatus::DefiniteReject
        }
        "ambiguous"
            if attempt.response_status == Some(202)
                && code_valid
                && attempt.dispatched_at.is_some()
                && attempt.terminal_at.is_some() =>
        {
            ContainerProviderAttemptStatus::Ambiguous
        }
        "cancelled"
            if attempt
                .response_status
                .is_some_and(|status| (400..=599).contains(&status))
                && code_valid
                && result.is_none()
                && attempt.dispatched_at.is_none()
                && attempt.terminal_at.is_some() =>
        {
            ContainerProviderAttemptStatus::Cancelled
        }
        _ => return Err("contract_mismatch"),
    };
    Ok(ContainerProviderAttemptOutcome {
        attempt_generation: attempt.attempt_generation,
        status,
        response_status: attempt.response_status,
        response_code: attempt.response_code,
        result,
        provider_usage_receipt_sha256: None,
        provider_usage_receipt_attached_at: None,
        prepared_at: attempt.prepared_at,
        dispatched_at: attempt.dispatched_at,
        terminal_at: attempt.terminal_at,
    })
}

fn result_manifest(
    result: ControllerOperationResult,
    envelope: &ContainerOperationEnvelope,
) -> Result<ContainerArtifactManifest, &'static str> {
    let manifest = ContainerArtifactManifest {
        object_key: result.object_key,
        object_version: result.object_version,
        sha256: result.sha256,
        size: result.size,
        content_type: result.content_type,
    };
    validate_container_artifact_manifest(&manifest).map_err(|_| "contract_mismatch")?;
    let expected_key = format!(
        "container-results/v1/{}/{}/{}",
        envelope.operation_id, envelope.owner_generation, manifest.sha256
    );
    if manifest.object_key != expected_key {
        return Err("contract_mismatch");
    }
    Ok(manifest)
}

fn classify_operation_error(
    http_status: u16,
    payload: &ControllerOperationErrorPayload,
) -> &'static str {
    match (http_status, payload.error.as_str(), payload.retryable) {
        (403, _, _) => "authority_rejected",
        (404, "operation_status_not_found", _) => "operation_status_not_found",
        (404, "route_not_found", _) => "route_not_found",
        (409, "stale_shard_fence" | "admission_authority_mismatch", _) => {
            "operation_fence_rejected"
        }
        (409, _, _) => "operation_conflict",
        (426, _, _) => "protocol_rejected",
        (503, "container_capacity_exhausted", Some(true)) => "capacity_exhausted",
        (503, _, _) => "controller_unavailable",
        _ => "unexpected_status",
    }
}

fn validate_terminal_ack_envelope(
    envelope: &ContainerTerminalAckEnvelope,
) -> Result<(), &'static str> {
    if envelope.protocol_version == 0
        || envelope.protocol_version > 255
        || !valid_sha256(&envelope.billing_event_id)
        || !valid_sha256(&envelope.terminal_contract_sha256)
        || !valid_sha256(&envelope.reconciliation_id)
        || !matches!(envelope.reconciliation_revision, 1 | 2)
        || !valid_identifier(&envelope.operation_id, 128)
        || envelope.owner_generation <= 0
        || envelope.owner_generation > i64::from(i32::MAX)
        || !matches!(
            envelope.operation_from_status.as_str(),
            "prepared" | "dispatched" | "recovery_required"
        )
        || !matches!(
            envelope.operation_status.as_str(),
            "completed" | "failed" | "recovery_required"
        )
        || envelope.response_status < 100
        || envelope.response_status > 599
        || !valid_identifier(&envelope.trace_id, 128)
        || envelope.shard.contract_version != 1
        || envelope.shard.ring_generation == 0
        || envelope.shard.shard_count == 0
        || envelope.shard.shard_count > 1_024
        || envelope.shard.shard_index >= envelope.shard.shard_count
        || envelope.shard.instance_name
            != format!("cinatoken-relay-shard-v1-{:04}", envelope.shard.shard_index)
    {
        return Err("invalid_terminal_ack");
    }
    let predecessor_valid = match envelope.reconciliation_revision {
        1 => {
            envelope.predecessor_billing_event_id.is_none()
                && matches!(
                    envelope.operation_from_status.as_str(),
                    "prepared" | "dispatched"
                )
        }
        2 => {
            envelope
                .predecessor_billing_event_id
                .as_deref()
                .is_some_and(valid_sha256)
                && envelope.operation_from_status == "recovery_required"
        }
        _ => false,
    };
    let outcome_valid = match envelope.operation_status.as_str() {
        "completed" => {
            (200..=299).contains(&envelope.response_status)
                && envelope.response_status != 202
                && envelope.response_code.is_none()
        }
        "failed" => {
            (400..=599).contains(&envelope.response_status)
                && envelope
                    .response_code
                    .as_deref()
                    .is_some_and(valid_response_code)
                && envelope.result.is_none()
        }
        "recovery_required" => {
            envelope.reconciliation_revision == 1
                && envelope.response_status == 202
                && envelope
                    .response_code
                    .as_deref()
                    .is_some_and(valid_response_code)
        }
        _ => false,
    };
    let result_valid = envelope.result.as_ref().is_none_or(|result| {
        let manifest = ContainerArtifactManifest {
            object_key: result.object_key.clone(),
            object_version: result.object_version.clone(),
            sha256: result.sha256.clone(),
            size: result.size,
            content_type: result.content_type.clone(),
        };
        validate_container_artifact_manifest(&manifest).is_ok()
            && result.object_key
                == format!(
                    "container-results/v1/{}/{}/{}",
                    envelope.operation_id, envelope.owner_generation, result.sha256
                )
    });
    let provider_usage_binding_valid =
        envelope
            .provider_usage_binding
            .as_ref()
            .is_none_or(|binding| {
                envelope.operation_status == "completed"
                    && binding.attempt_generation > 0
                    && binding.attempt_generation <= i64::from(i32::MAX)
                    && valid_sha256(&binding.receipt_sha256)
                    && valid_sha256(&binding.result_sha256)
                    && envelope
                        .result
                        .as_ref()
                        .is_some_and(|result| result.sha256 == binding.result_sha256)
            });
    let contract_valid = match (
        envelope.terminal_ack_contract_version,
        envelope.financial_terminal_contract_version,
        envelope.provider_response_binding.as_ref(),
    ) {
        (None, None, None) => true,
        (Some(3), Some(2), Some(binding)) => validate_terminal_ack_v3_binding(envelope, binding),
        _ => false,
    };
    let transition_valid = match envelope.operation_from_status.as_str() {
        "prepared" => envelope.operation_status != "completed",
        "dispatched" => true,
        "recovery_required" => envelope.operation_status != "recovery_required",
        _ => false,
    };
    if !predecessor_valid
        || !transition_valid
        || !outcome_valid
        || !result_valid
        || !provider_usage_binding_valid
        || !contract_valid
    {
        return Err("invalid_terminal_ack");
    }
    Ok(())
}

fn validate_terminal_ack_v3_binding(
    envelope: &ContainerTerminalAckEnvelope,
    binding: &ContainerTerminalAckProviderResponseBinding,
) -> bool {
    if envelope.owner_generation != 2
        || binding.attempt_generation != 1
        || !valid_sha256(&binding.provider_response_evidence_sha256)
        || !valid_sha256(&binding.client_response_artifact_sha256)
        || !matches!(
            (
                envelope.reconciliation_revision,
                envelope.operation_from_status.as_str()
            ),
            (1, "dispatched") | (2, "recovery_required")
        )
    {
        return false;
    }
    match binding.status.as_str() {
        "succeeded" => {
            binding.response_class == "success"
                && binding.provider_status == 200
                && binding.client_status == 200
                && binding.response_code.is_none()
                && envelope.operation_status == "completed"
                && envelope.response_status == 200
                && envelope.response_code.is_none()
                && envelope.result.is_some()
                && envelope
                    .provider_usage_binding
                    .as_ref()
                    .is_some_and(|usage| {
                        usage.attempt_generation == binding.attempt_generation
                            && envelope
                                .result
                                .as_ref()
                                .is_some_and(|result| usage.result_sha256 == result.sha256)
                    })
        }
        "interpreted_reject" => {
            let matrix_valid = match binding.response_class.as_str() {
                "typed_error" => {
                    binding.provider_status == 200
                        && binding.client_status == 200
                        && binding.response_code.as_deref() == Some("provider_typed_error")
                }
                "http_error" => {
                    (100..=599).contains(&binding.provider_status)
                        && binding.provider_status != 200
                        && binding.client_status == binding.provider_status
                        && binding.response_code.as_deref() == Some("provider_http_error")
                }
                "invalid_body" => {
                    binding.provider_status == 200
                        && binding.client_status == 500
                        && binding.response_code.as_deref() == Some("provider_invalid_body")
                }
                _ => false,
            };
            matrix_valid
                && envelope.operation_status == "failed"
                && envelope.response_status == 422
                && envelope.response_code == binding.response_code
                && envelope.result.is_none()
                && envelope.provider_usage_binding.is_none()
        }
        _ => false,
    }
}

fn validate_operation_envelope_at(
    envelope: &ContainerOperationEnvelope,
    now: i64,
) -> Result<(), &'static str> {
    validate_operation_identity(envelope)?;
    if envelope.owner_lease_expires_at <= now
        || envelope.execution_deadline_at <= now
        || envelope.execution_deadline_at - now > 300
    {
        return Err("invalid_operation_envelope");
    }
    Ok(())
}

fn validate_operation_identity(envelope: &ContainerOperationEnvelope) -> Result<(), &'static str> {
    let input = ContainerArtifactManifest {
        object_key: envelope.input.request_object_key.clone(),
        object_version: envelope.input.object_version.clone(),
        sha256: envelope.input.sha256.clone(),
        size: envelope.input.size,
        content_type: envelope.input.content_type.clone(),
    };
    let expected_input_key = format!(
        "container-inputs/v1/{}/{}/{}",
        envelope.operation_id, envelope.owner_generation, envelope.input.sha256
    );
    if envelope.input.mode != "r2"
        || envelope.protocol_version == 0
        || envelope.protocol_version > 255
        || !valid_identifier(&envelope.operation_id, 128)
        || !valid_operation_kind(&envelope.operation_kind)
        || envelope.owner_generation <= 0
        || envelope.owner_generation > i64::from(i32::MAX)
        || envelope.owner_lease_expires_at <= 0
        || envelope.owner_lease_expires_at > i64::from(i32::MAX)
        || envelope.execution_deadline_at <= 0
        || envelope.execution_deadline_at >= envelope.owner_lease_expires_at
        || !valid_identifier(&envelope.provider_operation_id, 128)
        || !valid_sha256(&envelope.admission_sha256)
        || !valid_identifier(&envelope.trace_id, 128)
        || validate_container_artifact_manifest(&input).is_err()
        || envelope.input.request_object_key != expected_input_key
        || envelope.shard.contract_version != 1
        || envelope.shard.ring_generation == 0
        || envelope.shard.shard_count == 0
        || envelope.shard.shard_count > 1_024
        || envelope.shard.shard_index >= envelope.shard.shard_count
        || envelope.shard.instance_name
            != format!("cinatoken-relay-shard-v1-{:04}", envelope.shard.shard_index)
    {
        return Err("invalid_operation_envelope");
    }
    Ok(())
}

fn valid_identifier(value: &str, max_len: usize) -> bool {
    value == value.trim()
        && !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_egress_worker_version(value: &str) -> bool {
    value == value.trim()
        && !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
        })
}

fn valid_artifact_content_type(value: &str) -> bool {
    if value.len() < 3
        || value.len() > 128
        || value != value.trim()
        || !value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
    {
        return false;
    }
    let media_type = value
        .split_once(';')
        .map_or(value, |(media_type, _)| media_type);
    let Some((kind, subtype)) = media_type.split_once('/') else {
        return false;
    };
    let valid_token = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    valid_token(kind) && valid_token(subtype) && !subtype.contains('/')
}

fn valid_operation_kind(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b':' | b'-')
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_response_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b':' | b'-')
        })
}

fn readiness_response_matches(
    payload: &ShardReadinessResponse,
    authority: &AuthorityConfig,
    dispatch_id: &str,
    shard: &ShardPlan,
    wake_container: bool,
    activation_campaign: bool,
    now: u64,
) -> bool {
    let container_state_valid = payload.container_state.as_ref().map_or(true, |state| {
        matches!(
            state.status.as_str(),
            "running" | "healthy" | "stopping" | "stopped" | "stopped_with_code"
        ) && (state.status == "stopped_with_code" || state.exit_code.is_none())
    });
    let lifecycle_valid = if payload.ledger.initialized {
        payload
            .ledger
            .lifecycle_state
            .as_deref()
            .is_some_and(|state| {
                matches!(
                    state,
                    "idle" | "running" | "ready" | "unready" | "draining" | "stopped" | "error"
                )
            })
            && payload.ledger.lifecycle_updated_at.is_some()
            && payload
                .ledger
                .lifecycle_detail
                .as_deref()
                .map_or(true, |detail| {
                    detail.len() <= 128 && !detail.chars().any(char::is_control)
                })
    } else {
        payload.ledger.lifecycle_state.is_none()
            && payload.ledger.lifecycle_detail.is_none()
            && payload.ledger.lifecycle_updated_at.is_none()
            && payload.ledger.active_in_flight_operations == 0
            && payload.ledger.expired_in_flight_operations == 0
            && payload.ledger.terminal_operations == 0
    };
    let readiness = &payload.ledger.readiness;
    let persisted_valid = matches!(readiness.phase.as_str(), "idle" | "probing" | "complete")
        && if readiness.phase == "idle" {
            readiness.generation == 0
                && readiness.last_probe_id.is_none()
                && readiness.started_at_ms.is_none()
                && readiness.deadline_at_ms.is_none()
                && readiness.completed_at_ms.is_none()
                && readiness.result_code.is_none()
        } else {
            readiness.generation > 0
                && readiness.last_probe_id.is_some()
                && readiness.started_at_ms.is_some()
                && readiness.deadline_at_ms.is_some()
                && (readiness.phase != "complete"
                    || (readiness.completed_at_ms.is_some() && readiness.result_code.is_some()))
        };
    let runtime_valid = payload.runtime.as_ref().map_or(true, |runtime| {
        runtime.protocol_version == authority.protocol_version
            && runtime.shard_contract_version == shard.contract_version
            && runtime
                .runtime_build_id
                .as_deref()
                .map_or(true, valid_sha256)
            && (!runtime.execution_ready || (runtime.process_ready && runtime.execution_enabled))
            && (!runtime.process_ready
                || payload
                    .container_state
                    .as_ref()
                    .is_some_and(|state| state.status == "healthy"))
    });
    let mode_valid = match payload.mode.as_str() {
        "ledger" => {
            !wake_container
                && !payload.wake_requested
                && !payload.ready
                && payload.verdict == "unknown"
                && payload.result_code == "ledger_snapshot"
                && payload.container_state.is_none()
                && payload.runtime.is_none()
        }
        "live" => {
            wake_container
                && payload.wake_requested
                && payload.verdict == if payload.ready { "ready" } else { "not_ready" }
                && payload.runtime.as_ref().map_or(!payload.ready, |runtime| {
                    runtime.execution_ready == payload.ready
                })
                && payload.ledger.initialized
                && readiness.phase == "complete"
                && readiness.last_probe_id.as_deref() == Some(dispatch_id)
                && readiness.result_code.as_deref() == Some(payload.result_code.as_str())
        }
        _ => false,
    };
    payload.protocol_version == authority.protocol_version
        && payload.probe_id == dispatch_id
        && payload.shard == *shard
        && payload.wake_requested == wake_container
        && payload.checked_at > 0
        && payload.checked_at <= now.saturating_add(5)
        && payload.checked_at
            >= now.saturating_sub(if activation_campaign {
                ACTIVATION_CAMPAIGN_READINESS_MAX_AGE_SECONDS
            } else {
                120
            })
        && container_state_valid
        && lifecycle_valid
        && persisted_valid
        && runtime_valid
        && mode_valid
}

fn authority_config(env: &Env) -> Option<AuthorityConfig> {
    let issuer = runtime_value(env, CONTAINER_AUTHORITY_ISSUER_ENV)?;
    let audience = runtime_value(env, CONTAINER_AUTHORITY_AUDIENCE_ENV)?;
    let kid = runtime_value(env, CONTAINER_AUTHORITY_CURRENT_KID_ENV)?;
    let protocol_version = runtime_value(env, CONTAINER_PROTOCOL_VERSION_ENV)?
        .parse::<u32>()
        .ok()
        .filter(|version| (1..=255).contains(version))?;
    let secret = env
        .secret(CONTAINER_AUTHORITY_CURRENT_SECRET_ENV)
        .ok()?
        .to_string();
    if secret.as_bytes().len() < MIN_SECRET_BYTES {
        return None;
    }
    Some(AuthorityConfig {
        issuer,
        audience,
        kid,
        secret,
        protocol_version,
    })
}

fn random_dispatch_id(prefix: &str) -> Option<String> {
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random).ok()?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(format!("{prefix}-{suffix}"))
}

fn sign_status_authority(
    authority: &AuthorityConfig,
    dispatch_id: &str,
    now: i64,
) -> Option<String> {
    sign_bound_authority(authority, dispatch_id, "GET", STATUS_PATH, &[], now)
}

fn sign_bound_authority(
    authority: &AuthorityConfig,
    dispatch_id: &str,
    method: &str,
    path: &str,
    body: &[u8],
    now: i64,
) -> Option<String> {
    let body_hash = body_sha256(body);
    sign_authority(
        authority.secret.as_bytes(),
        &authority.kid,
        AuthorityInput {
            issuer: &authority.issuer,
            audience: &authority.audience,
            protocol_version: authority.protocol_version,
            dispatch_id,
            body_sha256: &body_hash,
            method,
            path,
            issued_at: now,
        },
    )
    .ok()
}

fn sign_bound_authority_with_domain(
    authority: &AuthorityConfig,
    dispatch_id: &str,
    method: &str,
    path: &str,
    body: &[u8],
    now: i64,
    domain: &[u8],
) -> Option<String> {
    let token = sign_bound_authority(authority, dispatch_id, method, path, body, now)?;
    let mut segments = token.split('.');
    let protected = segments.next()?;
    let claims = segments.next()?;
    segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(authority.secret.as_bytes()).ok()?;
    mac.update(domain);
    mac.update(protected.as_bytes());
    mac.update(b".");
    mac.update(claims.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{protected}.{claims}.{signature}"))
}

fn status_request(token: &str) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(STATUS_URL, &init)
}

fn readiness_request(token: &str, body: &[u8]) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body).buffer().into()))
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(READINESS_URL, &init)
}

fn operation_request(token: &str, body: &[u8]) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body).buffer().into()))
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(OPERATION_URL, &init)
}

fn operation_status_request(url: &str, token: &str, body: &[u8]) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body).buffer().into()))
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(url, &init)
}

fn terminal_ack_request(token: &str, body: &[u8], url: &str) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let body = std::str::from_utf8(body).map_err(|_| {
        worker::Error::RustError("container terminal ack JSON body is not UTF-8".to_string())
    })?;
    // Avoid worker-rs 0.5 legacy `cf` defaults; Workerd's no-follow mode is manual.
    let init = web_sys::RequestInit::new();
    init.set_method("POST");
    init.set_headers(headers.as_ref());
    init.set_body(&wasm_bindgen::JsValue::from_str(body));
    init.set_redirect(web_sys::RequestRedirect::Manual);
    web_sys::Request::new_with_str_and_init(url, &init)
        .map(Request::from)
        .map_err(|error| {
            worker::Error::JsError(
                error
                    .as_string()
                    .unwrap_or_else(|| "invalid terminal ack request options".to_string()),
            )
        })
}

fn status_matches(
    payload: &ControllerStatusPayload,
    authority: &AuthorityConfig,
    runtime: ContainerSchedulerRuntimeStatus,
) -> bool {
    payload.protocol_version == authority.protocol_version
        && payload.ring_generation == runtime.ring_generation
        && payload.shard_count == runtime.shard_count
        && valid_ring_transition_status(payload)
        && valid_controller_version_id(&payload.controller_version_id)
        && valid_durable_object_jurisdiction_status(payload)
        && valid_controller_service_name(&payload.controller_service_name)
        && payload.controller_service_name == authority.audience
        && valid_sha256(&payload.action_gate_inventory_sha256)
        && payload.shard_placement_attestation_write_enabled
            == payload.shard_placement_attestation_staging_verified
        && payload.authority_current_secret_configured
}

fn valid_durable_object_jurisdiction_status(payload: &ControllerStatusPayload) -> bool {
    let restricted = match payload.durable_object_jurisdiction.as_str() {
        "default" => false,
        "eu" | "us" | "fedramp" | "fedramp-high" => true,
        _ => return false,
    };
    payload.durable_object_jurisdiction_restricted == restricted
        && payload.durable_object_jurisdiction_enabled == restricted
        && payload.durable_object_jurisdiction_staging_verified == restricted
}

fn valid_ring_transition_status(payload: &ControllerStatusPayload) -> bool {
    if !payload.ring_transition_valid {
        return false;
    }
    if !payload.ring_transition_configured {
        return payload.previous_ring_generation.is_none()
            && payload.previous_shard_count.is_none()
            && payload.previous_ring_admission_started_at.is_none()
            && payload.previous_ring_admission_until.is_none()
            && !payload.previous_ring_admission_open;
    }
    let (
        Some(previous_generation),
        Some(previous_shard_count),
        Some(admission_started_at),
        Some(admission_until),
    ) = (
        payload.previous_ring_generation,
        payload.previous_shard_count,
        payload.previous_ring_admission_started_at,
        payload.previous_ring_admission_until,
    )
    else {
        return false;
    };
    previous_generation.checked_add(1) == Some(payload.ring_generation)
        && previous_shard_count < payload.shard_count
        && admission_started_at < admission_until
        && admission_until - admission_started_at <= 15 * 60
}

fn valid_controller_version_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn valid_controller_service_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (matches!(byte, b'-') && index > 0 && index + 1 < value.len())
        })
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn failed_probe(
    probe_enabled: bool,
    binding_available: bool,
    authority_configured: bool,
    state: &'static str,
) -> ContainerControllerProbe {
    ContainerControllerProbe {
        probe_enabled,
        binding_available,
        authority_configured,
        verified: false,
        controller_enabled: false,
        execution_enabled: false,
        previous_secret_configured: false,
        controller_version_id: None,
        shard_activation_write_enabled: false,
        shard_activation_candidate_build_configured: false,
        shard_placement_attestation_write_enabled: false,
        shard_placement_attestation_staging_verified: false,
        all_action_gates_false: false,
        action_gate_inventory_sha256: None,
        state,
    }
}

fn activation_campaign_probe_id(campaign_id: &str, shard_index: u16) -> String {
    let identity = format!(
        "cinatoken:relay-container-shard-activation-probe:v1\0{campaign_id}\0{shard_index}"
    );
    body_sha256(identity.as_bytes())
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    runtime_value(env, name).as_deref() == Some("true")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinatoken_container_authority::{verify_authority, AuthorityClaims, AuthorityExpectation};

    #[derive(Deserialize)]
    struct GoldenVector {
        secret: String,
        kid: String,
        issuer: String,
        audience: String,
        protocol_version: u32,
        dispatch_id: String,
        issued_at: i64,
        token: String,
    }

    #[test]
    fn activation_campaign_credential_is_an_exact_one_time_capability() {
        let valid = ShardActivationCampaignCredential {
            contract_version: 1,
            campaign_id: "a".repeat(64),
            nonce: "b".repeat(64),
            confirm_consume: true,
        };
        assert!(valid_shard_activation_campaign_credential(&valid));

        let mut invalid = valid.clone();
        invalid.confirm_consume = false;
        assert!(!valid_shard_activation_campaign_credential(&invalid));
        invalid.confirm_consume = true;
        invalid.nonce = "B".repeat(64);
        assert!(!valid_shard_activation_campaign_credential(&invalid));
    }

    #[test]
    fn status_authority_uses_the_shared_empty_body_golden_vector() {
        let vector: GoldenVector = serde_json::from_str(include_str!(
            "../../../tests/fixtures/container-authority-v1.json"
        ))
        .unwrap();
        let authority = AuthorityConfig {
            issuer: vector.issuer,
            audience: vector.audience,
            kid: vector.kid,
            secret: vector.secret,
            protocol_version: vector.protocol_version,
        };
        assert_eq!(
            sign_status_authority(&authority, &vector.dispatch_id, vector.issued_at).unwrap(),
            vector.token
        );
    }

    #[test]
    fn status_payload_must_match_the_active_ring_and_authority() {
        let authority = AuthorityConfig {
            issuer: "cinatoken-edge-test".to_string(),
            audience: "cinatoken-container-controller-test".to_string(),
            kid: "test-v1".to_string(),
            secret: "0123456789abcdef0123456789abcdef".to_string(),
            protocol_version: 1,
        };
        let runtime = ContainerSchedulerRuntimeStatus {
            configured: true,
            valid: true,
            ring_generation: 7,
            shard_count: 16,
        };
        let mut payload = ControllerStatusPayload {
            controller_enabled: false,
            execution_enabled: false,
            protocol_version: 1,
            ring_generation: 7,
            shard_count: 16,
            ring_transition_configured: false,
            ring_transition_valid: true,
            previous_ring_generation: None,
            previous_shard_count: None,
            previous_ring_admission_started_at: None,
            previous_ring_admission_until: None,
            previous_ring_admission_open: false,
            controller_version_id: "controller-version-test".to_string(),
            durable_object_jurisdiction: "default".to_string(),
            durable_object_jurisdiction_restricted: false,
            durable_object_jurisdiction_enabled: false,
            durable_object_jurisdiction_staging_verified: false,
            shard_activation_write_enabled: false,
            shard_activation_candidate_build_configured: false,
            shard_placement_attestation_write_enabled: false,
            shard_placement_attestation_staging_verified: false,
            controller_service_name: "cinatoken-container-controller-test".to_string(),
            all_action_gates_false: true,
            action_gate_inventory_sha256: "a".repeat(64),
            authority_current_secret_configured: true,
            authority_previous_secret_configured: false,
        };
        assert!(status_matches(&payload, &authority, runtime));
        payload.shard_count = 17;
        assert!(!status_matches(&payload, &authority, runtime));
        payload.shard_count = 16;
        payload.authority_current_secret_configured = false;
        assert!(!status_matches(&payload, &authority, runtime));
        payload.authority_current_secret_configured = true;
        payload.durable_object_jurisdiction = "eu".to_string();
        assert!(!status_matches(&payload, &authority, runtime));
        payload.durable_object_jurisdiction_restricted = true;
        payload.durable_object_jurisdiction_enabled = true;
        payload.durable_object_jurisdiction_staging_verified = true;
        assert!(status_matches(&payload, &authority, runtime));
        payload.controller_service_name = "Invalid Controller".to_string();
        assert!(!status_matches(&payload, &authority, runtime));
        payload.controller_service_name = "cinatoken-container-controller-other".to_string();
        assert!(!status_matches(&payload, &authority, runtime));
        payload.controller_service_name = "cinatoken-container-controller-test".to_string();
        payload.ring_transition_configured = true;
        payload.previous_ring_generation = Some(6);
        payload.previous_shard_count = Some(8);
        payload.previous_ring_admission_started_at = Some(1_800_000_000);
        payload.previous_ring_admission_until = Some(1_800_000_300);
        payload.previous_ring_admission_open = true;
        assert!(status_matches(&payload, &authority, runtime));
        payload.previous_ring_generation = Some(5);
        assert!(!status_matches(&payload, &authority, runtime));
    }

    #[test]
    fn controller_status_v1_fixture_is_strictly_cross_contract_compatible() {
        let fixture = include_str!(
            "../../../services/container-controller/tests/fixtures/controller-status-v1.json"
        );
        let payload: ControllerStatusPayload = serde_json::from_str(fixture).unwrap();
        assert_eq!(payload.durable_object_jurisdiction, "default");
        assert_eq!(
            payload.controller_service_name,
            "cinatoken-container-controller-test"
        );

        let mut unknown_field: serde_json::Value = serde_json::from_str(fixture).unwrap();
        unknown_field["unexpected_status_field"] = serde_json::json!(true);
        assert!(
            serde_json::from_value::<ControllerStatusPayload>(unknown_field).is_err(),
            "deny_unknown_fields must reject additive response drift"
        );

        let mut missing_field: serde_json::Value = serde_json::from_str(fixture).unwrap();
        missing_field
            .as_object_mut()
            .unwrap()
            .remove("durable_object_jurisdiction");
        assert!(
            serde_json::from_value::<ControllerStatusPayload>(missing_field).is_err(),
            "required v1 fields must reject subtractive response drift"
        );
    }

    #[test]
    fn activation_campaign_probe_identity_matches_the_controller_vector() {
        assert_eq!(
            activation_campaign_probe_id(
                "a9f9f7aa3b8672759a9a7b37b5ee3a093930c3041ef4b741f0e3c824fbf1a477",
                7,
            ),
            "6a3d0e58ee9be4b475264a2496ab965364535d8979fbcf88df79a9f761c41b74"
        );
    }

    fn test_authority() -> AuthorityConfig {
        AuthorityConfig {
            issuer: "cinatoken-edge-test".to_string(),
            audience: "cinatoken-container-controller-test".to_string(),
            kid: "test-v1".to_string(),
            secret: "0123456789abcdef0123456789abcdef".to_string(),
            protocol_version: 1,
        }
    }

    fn authority_claims_for_domain(token: &str, secret: &[u8], domain: &[u8]) -> AuthorityClaims {
        let segments = token.split('.').collect::<Vec<_>>();
        assert_eq!(segments.len(), 3);
        let signature = URL_SAFE_NO_PAD.decode(segments[2]).unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).unwrap();
        mac.update(domain);
        mac.update(segments[0].as_bytes());
        mac.update(b".");
        mac.update(segments[1].as_bytes());
        mac.verify_slice(&signature).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[1]).unwrap()).unwrap()
    }

    fn test_shard() -> ShardPlan {
        ShardPlan {
            contract_version: 1,
            ring_generation: 1,
            shard_count: 8,
            shard_index: 3,
            instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
        }
    }

    fn test_operation() -> ContainerOperationEnvelope {
        ContainerOperationEnvelope {
            protocol_version: 1,
            operation_id: "relayreserve-test".to_string(),
            operation_kind: "relay_openai".to_string(),
            owner_generation: 2,
            owner_lease_expires_at: 1_800_000_200,
            execution_deadline_at: 1_800_000_120,
            provider_operation_id: "provider-op-1".to_string(),
            admission_sha256: "a".repeat(64),
            input: ContainerOperationInput {
                mode: "r2",
                sha256: "b".repeat(64),
                size: 128,
                content_type: "application/json".to_string(),
                request_object_key: format!(
                    "container-inputs/v1/relayreserve-test/2/{}",
                    "b".repeat(64)
                ),
                object_version: "version-input-1".to_string(),
            },
            shard: test_shard(),
            trace_id: "trace-op-1".to_string(),
        }
    }

    fn test_terminal_ack() -> ContainerTerminalAckEnvelope {
        ContainerTerminalAckEnvelope {
            protocol_version: 1,
            terminal_ack_contract_version: None,
            financial_terminal_contract_version: None,
            billing_event_id: "d".repeat(64),
            terminal_contract_sha256: "e".repeat(64),
            reconciliation_id: "f".repeat(64),
            reconciliation_revision: 1,
            predecessor_billing_event_id: None,
            operation_id: "relayreserve-test".to_string(),
            owner_generation: 2,
            operation_from_status: "dispatched".to_string(),
            operation_status: "completed".to_string(),
            response_status: 200,
            response_code: None,
            result: Some(ContainerTerminalAckResult {
                object_key: format!(
                    "container-results/v1/relayreserve-test/2/{}",
                    "c".repeat(64)
                ),
                object_version: "version-result-1".to_string(),
                sha256: "c".repeat(64),
                size: 256,
                content_type: "application/json".to_string(),
            }),
            provider_usage_binding: None,
            provider_response_binding: None,
            shard: test_shard(),
            trace_id: "trace-op-1".to_string(),
        }
    }

    fn test_terminal_ack_v3() -> ContainerTerminalAckEnvelope {
        let mut envelope = test_terminal_ack();
        envelope.terminal_ack_contract_version = Some(3);
        envelope.financial_terminal_contract_version = Some(2);
        envelope.provider_usage_binding = Some(ContainerTerminalAckProviderUsageBinding {
            attempt_generation: 1,
            receipt_sha256: "a".repeat(64),
            result_sha256: "c".repeat(64),
        });
        envelope.provider_response_binding = Some(ContainerTerminalAckProviderResponseBinding {
            attempt_generation: 1,
            status: "succeeded".to_string(),
            response_class: "success".to_string(),
            provider_status: 200,
            client_status: 200,
            response_code: None,
            provider_response_evidence_sha256: "b".repeat(64),
            client_response_artifact_sha256: "9".repeat(64),
        });
        envelope
    }

    fn idle_readiness() -> PersistedReadinessSnapshot {
        PersistedReadinessSnapshot {
            generation: 0,
            phase: "idle".to_string(),
            last_probe_id: None,
            started_at_ms: None,
            deadline_at_ms: None,
            completed_at_ms: None,
            result_code: None,
            container_status: None,
            container_last_change_ms: None,
            container_exit_code: None,
            runtime_protocol_version: None,
            runtime_contract_version: None,
            runtime_execution_enabled: None,
            last_ready_at_ms: None,
        }
    }

    fn ledger_snapshot(initialized: bool) -> ShardLedgerSnapshot {
        ShardLedgerSnapshot {
            initialized,
            lifecycle_state: initialized.then(|| "running".to_string()),
            lifecycle_detail: None,
            lifecycle_updated_at: initialized.then_some(1_800_000_000),
            active_in_flight_operations: 0,
            expired_in_flight_operations: 0,
            terminal_operations: 0,
            readiness: idle_readiness(),
        }
    }

    #[test]
    fn readiness_authority_is_bound_to_the_non_empty_post_body() {
        let authority = test_authority();
        let shard = test_shard();
        let body = serde_json::to_vec(&ShardReadinessRequest {
            protocol_version: 1,
            shard: &shard,
            wake_container: false,
            activation_campaign: None,
        })
        .unwrap();
        assert!(!body.is_empty());
        let token = sign_bound_authority(
            &authority,
            "readiness-test-1",
            "POST",
            READINESS_PATH,
            &body,
            1_800_000_000,
        )
        .unwrap();
        let body_hash = body_sha256(&body);
        let claims = verify_authority(
            authority.secret.as_bytes(),
            &authority.kid,
            &token,
            AuthorityExpectation {
                issuer: &authority.issuer,
                audience: &authority.audience,
                protocol_version: 1,
                body_sha256: &body_hash,
                method: "POST",
                path: READINESS_PATH,
                now: 1_800_000_001,
            },
        )
        .unwrap();
        assert_eq!(claims.dispatch_id, "readiness-test-1");
        assert_ne!(claims.body_sha256, body_sha256(&[]));
    }

    #[test]
    fn operation_envelope_is_strictly_fenced_before_signing() {
        let valid = test_operation();
        validate_operation_envelope_at(&valid, 1_800_000_000).unwrap();

        let mut invalid = valid.clone();
        invalid.execution_deadline_at = invalid.owner_lease_expires_at;
        assert_eq!(
            validate_operation_envelope_at(&invalid, 1_800_000_000),
            Err("invalid_operation_envelope")
        );
        invalid = valid.clone();
        invalid.input.object_version = " version-input-1".to_string();
        assert!(validate_operation_envelope_at(&invalid, 1_800_000_000).is_err());
        invalid = valid;
        invalid.shard.instance_name = "cinatoken-relay-shard-v1-0004".to_string();
        assert!(validate_operation_envelope_at(&invalid, 1_800_000_000).is_err());
    }

    #[test]
    fn operation_status_query_is_identity_fenced_but_deadline_independent() {
        let envelope = test_operation();
        validate_operation_identity(&envelope).unwrap();
        assert_eq!(
            validate_operation_envelope_at(&envelope, envelope.execution_deadline_at + 1),
            Err("invalid_operation_envelope")
        );

        let query = ContainerOperationStatusQuery {
            protocol_version: envelope.protocol_version,
            operation_id: &envelope.operation_id,
            owner_generation: envelope.owner_generation,
            shard: &envelope.shard,
            trace_id: &envelope.trace_id,
        };
        let body = serde_json::to_vec(&query).unwrap();
        let authority = test_authority();
        let token = sign_bound_authority(
            &authority,
            "operation-status-test-1",
            "POST",
            OPERATION_STATUS_PATH,
            &body,
            envelope.execution_deadline_at + 1,
        )
        .unwrap();
        let body_hash = body_sha256(&body);
        let claims = verify_authority(
            authority.secret.as_bytes(),
            &authority.kid,
            &token,
            AuthorityExpectation {
                issuer: &authority.issuer,
                audience: &authority.audience,
                protocol_version: envelope.protocol_version,
                body_sha256: &body_hash,
                method: "POST",
                path: OPERATION_STATUS_PATH,
                now: envelope.execution_deadline_at + 2,
            },
        )
        .unwrap();
        assert_eq!(claims.dispatch_id, "operation-status-test-1");
    }

    #[test]
    fn operation_status_v3_and_v4_use_domain_separated_authority() {
        let envelope = test_operation();
        let body = serde_json::to_vec(&ContainerOperationStatusQuery {
            protocol_version: envelope.protocol_version,
            operation_id: &envelope.operation_id,
            owner_generation: envelope.owner_generation,
            shard: &envelope.shard,
            trace_id: &envelope.trace_id,
        })
        .unwrap();
        let authority = test_authority();
        let token = sign_bound_authority_with_domain(
            &authority,
            "operation-status-v3-test-1",
            "POST",
            OPERATION_STATUS_V3_PATH,
            &body,
            1_800_000_000,
            OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
        )
        .unwrap();
        let claims = authority_claims_for_domain(
            &token,
            authority.secret.as_bytes(),
            OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
        );
        assert_eq!(claims.dispatch_id, "operation-status-v3-test-1");
        assert_eq!(claims.path, OPERATION_STATUS_V3_PATH);
        assert_eq!(claims.body_sha256, body_sha256(&body));

        let v4_token = sign_bound_authority_with_domain(
            &authority,
            "operation-status-v4-test-1",
            "POST",
            OPERATION_STATUS_V4_PATH,
            &body,
            1_800_000_000,
            OPERATION_STATUS_V4_AUTHORITY_DOMAIN,
        )
        .unwrap();
        let v4_claims = authority_claims_for_domain(
            &v4_token,
            authority.secret.as_bytes(),
            OPERATION_STATUS_V4_AUTHORITY_DOMAIN,
        );
        assert_eq!(v4_claims.dispatch_id, "operation-status-v4-test-1");
        assert_eq!(v4_claims.path, OPERATION_STATUS_V4_PATH);
        assert_eq!(v4_claims.body_sha256, body_sha256(&body));
    }

    #[test]
    fn operation_status_contracts_are_exact_and_v3_binds_provider_usage() {
        let envelope = test_operation();
        let base = serde_json::json!({
            "protocol_version": 1,
            "operation_id": envelope.operation_id,
            "status": "running",
            "trace_id": envelope.trace_id,
        });
        let v1: ControllerOperationStatusV1Payload = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(
            operation_status_v1_outcome(202, v1, &envelope)
                .unwrap()
                .status_contract_version,
            1
        );

        let mut v1_extra = base.clone();
        v1_extra["provider_attempt"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<ControllerOperationStatusV1Payload>(v1_extra).is_err());
        assert!(serde_json::from_value::<ControllerOperationStatusV2Payload>(base).is_err());

        let v2: ControllerOperationStatusV2Payload = serde_json::from_value(serde_json::json!({
            "protocol_version": 1,
            "operation_id": envelope.operation_id,
            "status": "running",
            "trace_id": envelope.trace_id,
            "provider_attempt": null,
        }))
        .unwrap();
        assert_eq!(
            operation_status_v2_outcome(202, v2, &envelope)
                .unwrap()
                .status_contract_version,
            2
        );

        let receipt_sha256 = "d".repeat(64);
        let result = serde_json::json!({
            "object_key": format!(
                "container-results/v1/relayreserve-test/2/{}",
                "c".repeat(64)
            ),
            "object_version": "version-result-1",
            "sha256": "c".repeat(64),
            "size": 256,
            "content_type": "application/json",
        });
        let v3_json = serde_json::json!({
            "protocol_version": 1,
            "status_contract_version": 3,
            "operation_id": envelope.operation_id,
            "status": "completed",
            "trace_id": envelope.trace_id,
            "result": result,
            "provider_usage_receipt_sha256": receipt_sha256,
            "provider_attempt": {
                "attempt_generation": 1,
                "provider_operation_id": envelope.provider_operation_id,
                "admission_sha256": envelope.admission_sha256,
                "request_sha256": envelope.input.sha256,
                "status": "succeeded",
                "response_status": 200,
                "response_code": null,
                "result": result,
                "provider_usage_receipt_sha256": receipt_sha256,
                "provider_usage_receipt_attached_at": 1_800_000_101,
                "prepared_at": 1_800_000_100,
                "dispatched_at": 1_800_000_101,
                "terminal_at": 1_800_000_102,
            },
        });
        let v3: ControllerOperationStatusV3Payload =
            serde_json::from_value(v3_json.clone()).unwrap();
        let outcome = operation_status_v3_outcome(200, v3, &envelope).unwrap();
        assert_eq!(outcome.status_contract_version, 3);
        assert_eq!(
            outcome.provider_usage_receipt_sha256.as_deref(),
            Some(receipt_sha256.as_str())
        );
        assert_eq!(
            outcome
                .provider_attempt
                .as_ref()
                .and_then(|attempt| attempt.provider_usage_receipt_attached_at),
            Some(1_800_000_101)
        );

        let mut legacy_without_receipt = v3_json.clone();
        legacy_without_receipt["provider_usage_receipt_sha256"] = serde_json::Value::Null;
        legacy_without_receipt["provider_attempt"]["provider_usage_receipt_sha256"] =
            serde_json::Value::Null;
        legacy_without_receipt["provider_attempt"]["provider_usage_receipt_attached_at"] =
            serde_json::Value::Null;
        let legacy_outcome = operation_status_v3_outcome(
            200,
            serde_json::from_value(legacy_without_receipt).unwrap(),
            &envelope,
        )
        .unwrap();
        assert_eq!(legacy_outcome.status_contract_version, 3);
        assert_eq!(legacy_outcome.provider_usage_receipt_sha256, None);
        assert_eq!(
            legacy_outcome
                .provider_attempt
                .as_ref()
                .and_then(|attempt| attempt.provider_usage_receipt_sha256.as_deref()),
            None
        );

        let mut missing_root = v3_json.clone();
        missing_root
            .as_object_mut()
            .unwrap()
            .remove("provider_usage_receipt_sha256");
        assert!(
            serde_json::from_value::<ControllerOperationStatusV3Payload>(missing_root).is_err()
        );
        let mut divergent = v3_json.clone();
        divergent["provider_usage_receipt_sha256"] = serde_json::json!("e".repeat(64));
        assert_eq!(
            operation_status_v3_outcome(200, serde_json::from_value(divergent).unwrap(), &envelope,),
            Err("contract_mismatch")
        );

        let raw_sha256 = "1".repeat(64);
        let evidence_sha256 = "2".repeat(64);
        let artifact_sha256 = "3".repeat(64);
        let mut v4_json = v3_json.clone();
        v4_json["status_contract_version"] = serde_json::json!(4);
        v4_json["provider_response_artifacts"] = serde_json::json!({
            "operation_id": envelope.operation_id,
            "owner_generation": envelope.owner_generation,
            "attempt_generation": 1,
            "provider_operation_id": envelope.provider_operation_id,
            "admission_sha256": envelope.admission_sha256,
            "request_sha256": envelope.input.sha256,
            "egress_profile": "openai-chat-completions-canary-v1",
            "egress_worker_version_id": "worker-version-v4-test",
            "status": "succeeded",
            "provider_status": 200,
            "client_status": 200,
            "response_class": "success",
            "response_code": null,
            "raw_manifest": {
                "object_key": format!(
                    "container-provider-evidence/v1/relayreserve-test/2/1/{raw_sha256}"
                ),
                "object_version": "raw-version-v4-test",
                "provider_response_evidence_sha256": evidence_sha256,
                "sha256": raw_sha256,
                "size": 256,
                "content_type": "application/json"
            },
            "client_manifest": {
                "object_key": format!(
                    "container-client-artifacts/v1/relayreserve-test/2/{artifact_sha256}"
                ),
                "object_version": "client-version-v4-test",
                "client_response_artifact_sha256": artifact_sha256,
                "sha256": "c".repeat(64),
                "size": 256,
                "content_type": "application/json"
            },
            "provider_usage_receipt_sha256": receipt_sha256,
            "attached_at": 1_800_000_102
        });
        let v4 =
            serde_json::from_value::<ControllerOperationStatusV4Payload>(v4_json.clone()).unwrap();
        let v4_outcome = operation_status_v4_outcome(200, v4, &envelope).unwrap();
        assert_eq!(v4_outcome.status_contract_version, 4);
        assert!(matches!(
            v4_outcome
                .provider_response_artifacts
                .as_ref()
                .map(|artifacts| artifacts.status),
            Some(ContainerProviderResponseArtifactStatus::Succeeded)
        ));

        let mut missing_artifacts = v4_json.clone();
        missing_artifacts
            .as_object_mut()
            .unwrap()
            .remove("provider_response_artifacts");
        assert!(
            serde_json::from_value::<ControllerOperationStatusV4Payload>(missing_artifacts)
                .is_err()
        );
        let mut tampered_artifact = v4_json;
        tampered_artifact["provider_response_artifacts"]["client_manifest"]
            ["client_response_artifact_sha256"] = serde_json::json!("4".repeat(64));
        assert_eq!(
            operation_status_v4_outcome(
                200,
                serde_json::from_value(tampered_artifact).unwrap(),
                &envelope,
            ),
            Err("contract_mismatch")
        );

        for (response_class, provider_status, client_status, response_code) in [
            ("typed_error", 200, 200, "provider_typed_error"),
            ("http_error", 429, 429, "provider_http_error"),
            ("invalid_body", 200, 500, "provider_invalid_body"),
        ] {
            let reject_artifact_sha256 = "5".repeat(64);
            let reject_raw_sha256 = "6".repeat(64);
            let reject = serde_json::json!({
                "protocol_version": 1,
                "status_contract_version": 4,
                "operation_id": envelope.operation_id,
                "status": "failed",
                "code": response_code,
                "trace_id": envelope.trace_id,
                "result": null,
                "provider_usage_receipt_sha256": null,
                "provider_attempt": {
                    "attempt_generation": 1,
                    "provider_operation_id": envelope.provider_operation_id,
                    "admission_sha256": envelope.admission_sha256,
                    "request_sha256": envelope.input.sha256,
                    "status": "definite_reject",
                    "response_status": 422,
                    "response_code": response_code,
                    "result": null,
                    "provider_usage_receipt_sha256": null,
                    "provider_usage_receipt_attached_at": null,
                    "prepared_at": 1_800_000_100,
                    "dispatched_at": 1_800_000_101,
                    "terminal_at": 1_800_000_102
                },
                "provider_response_artifacts": {
                    "operation_id": envelope.operation_id,
                    "owner_generation": envelope.owner_generation,
                    "attempt_generation": 1,
                    "provider_operation_id": envelope.provider_operation_id,
                    "admission_sha256": envelope.admission_sha256,
                    "request_sha256": envelope.input.sha256,
                    "egress_profile": "openai-chat-completions-canary-v1",
                    "egress_worker_version_id": "worker-version-v4-reject",
                    "status": "interpreted_reject",
                    "provider_status": provider_status,
                    "client_status": client_status,
                    "response_class": response_class,
                    "response_code": response_code,
                    "raw_manifest": {
                        "object_key": format!(
                            "container-provider-evidence/v1/relayreserve-test/2/1/{reject_raw_sha256}"
                        ),
                        "object_version": "raw-version-v4-reject",
                        "provider_response_evidence_sha256": "7".repeat(64),
                        "sha256": reject_raw_sha256,
                        "size": 128,
                        "content_type": "application/json"
                    },
                    "client_manifest": {
                        "object_key": format!(
                            "container-client-artifacts/v1/relayreserve-test/2/{reject_artifact_sha256}"
                        ),
                        "object_version": "client-version-v4-reject",
                        "client_response_artifact_sha256": reject_artifact_sha256,
                        "sha256": "8".repeat(64),
                        "size": 128,
                        "content_type": "application/json"
                    },
                    "provider_usage_receipt_sha256": null,
                    "attached_at": 1_800_000_102
                }
            });
            let reject_outcome = operation_status_v4_outcome(
                422,
                serde_json::from_value(reject).unwrap(),
                &envelope,
            )
            .unwrap();
            assert!(matches!(
                reject_outcome
                    .provider_response_artifacts
                    .as_ref()
                    .map(|artifacts| artifacts.status),
                Some(ContainerProviderResponseArtifactStatus::InterpretedReject)
            ));
        }
    }

    #[test]
    fn terminal_ack_is_body_bound_and_strictly_fenced() {
        let authority = test_authority();
        let envelope = test_terminal_ack();
        validate_terminal_ack_envelope(&envelope).unwrap();
        let body = serde_json::to_vec(&envelope).unwrap();
        let token = sign_bound_authority_with_domain(
            &authority,
            "terminal-ack-test-1",
            "POST",
            TERMINAL_ACK_PATH,
            &body,
            1_800_000_000,
            TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
        )
        .unwrap();
        let body_hash = body_sha256(&body);
        let claims = authority_claims_for_domain(
            &token,
            authority.secret.as_bytes(),
            TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
        );
        assert_eq!(claims.dispatch_id, "terminal-ack-test-1");
        assert_eq!(claims.path, TERMINAL_ACK_PATH);
        assert_eq!(claims.method, "POST");
        assert_eq!(claims.body_sha256, body_hash);

        let mut invalid = envelope.clone();
        invalid.shard.instance_name = "cinatoken-relay-shard-v1-0004".to_string();
        assert_eq!(
            validate_terminal_ack_envelope(&invalid),
            Err("invalid_terminal_ack")
        );
        invalid = envelope.clone();
        invalid.predecessor_billing_event_id = Some("a".repeat(64));
        assert!(validate_terminal_ack_envelope(&invalid).is_err());
        invalid = envelope;
        invalid.operation_status = "failed".to_string();
        invalid.response_status = 502;
        invalid.response_code = Some("provider_failed".to_string());
        assert!(validate_terminal_ack_envelope(&invalid).is_err());
    }

    #[test]
    fn terminal_ack_v2_provider_usage_binding_is_exact_or_explicitly_null() {
        let legacy = test_terminal_ack();
        validate_terminal_ack_envelope(&legacy).unwrap();
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert!(legacy_json
            .get("provider_usage_binding")
            .is_some_and(serde_json::Value::is_null));
        assert!(legacy_json.get("terminal_ack_contract_version").is_none());
        assert!(legacy_json
            .get("financial_terminal_contract_version")
            .is_none());
        assert!(legacy_json.get("provider_response_binding").is_none());
        assert_eq!(TERMINAL_ACK_PATH, "/internal/v2/operations/terminal-ack");

        let mut bound = legacy;
        bound.provider_usage_binding = Some(ContainerTerminalAckProviderUsageBinding {
            attempt_generation: 1,
            receipt_sha256: "a".repeat(64),
            result_sha256: "c".repeat(64),
        });
        validate_terminal_ack_envelope(&bound).unwrap();
        let binding = serde_json::to_value(&bound).unwrap()["provider_usage_binding"].clone();
        assert_eq!(binding["attempt_generation"], 1);
        assert_eq!(binding["receipt_sha256"], "a".repeat(64));
        assert_eq!(binding["result_sha256"], "c".repeat(64));

        let mut divergent = bound.clone();
        divergent
            .provider_usage_binding
            .as_mut()
            .unwrap()
            .result_sha256 = "d".repeat(64);
        assert_eq!(
            validate_terminal_ack_envelope(&divergent),
            Err("invalid_terminal_ack")
        );

        let mut invalid_attempt = bound;
        invalid_attempt
            .provider_usage_binding
            .as_mut()
            .unwrap()
            .attempt_generation = 0;
        assert_eq!(
            validate_terminal_ack_envelope(&invalid_attempt),
            Err("invalid_terminal_ack")
        );
    }

    #[test]
    fn terminal_ack_v3_binds_financial_terminal_and_provider_response() {
        let authority = test_authority();
        let success = test_terminal_ack_v3();
        validate_terminal_ack_envelope(&success).unwrap();
        let body = serde_json::to_vec(&success).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["terminal_ack_contract_version"], 3);
        assert_eq!(json["financial_terminal_contract_version"], 2);
        assert_eq!(
            json["provider_response_binding"]["client_response_artifact_sha256"],
            "9".repeat(64)
        );
        let token = sign_bound_authority_with_domain(
            &authority,
            "terminal-ack-v3-test-1",
            "POST",
            TERMINAL_ACK_V3_PATH,
            &body,
            1_800_000_000,
            TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
        )
        .unwrap();
        let claims = authority_claims_for_domain(
            &token,
            authority.secret.as_bytes(),
            TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
        );
        assert_eq!(claims.path, TERMINAL_ACK_V3_PATH);
        assert_eq!(claims.body_sha256, body_sha256(&body));

        for (response_class, provider_status, client_status, response_code) in [
            ("typed_error", 200, 200, "provider_typed_error"),
            ("http_error", 429, 429, "provider_http_error"),
            ("invalid_body", 200, 500, "provider_invalid_body"),
        ] {
            let mut rejection = success.clone();
            rejection.operation_status = "failed".to_string();
            rejection.response_status = 422;
            rejection.response_code = Some(response_code.to_string());
            rejection.result = None;
            rejection.provider_usage_binding = None;
            let binding = rejection.provider_response_binding.as_mut().unwrap();
            binding.status = "interpreted_reject".to_string();
            binding.response_class = response_class.to_string();
            binding.provider_status = provider_status;
            binding.client_status = client_status;
            binding.response_code = Some(response_code.to_string());
            validate_terminal_ack_envelope(&rejection).unwrap();
        }

        let mut downgrade = success.clone();
        downgrade.terminal_ack_contract_version = None;
        assert_eq!(
            validate_terminal_ack_envelope(&downgrade),
            Err("invalid_terminal_ack")
        );
        let mut divergent = success;
        divergent
            .provider_response_binding
            .as_mut()
            .unwrap()
            .client_status = 201;
        assert_eq!(
            validate_terminal_ack_envelope(&divergent),
            Err("invalid_terminal_ack")
        );
    }

    #[test]
    fn terminal_ack_recovery_requires_an_ordered_second_revision() {
        let mut recovery = test_terminal_ack();
        recovery.operation_from_status = "dispatched".to_string();
        recovery.operation_status = "recovery_required".to_string();
        recovery.response_status = 202;
        recovery.response_code = Some("provider_ambiguous".to_string());
        recovery.result = test_terminal_ack().result;
        validate_terminal_ack_envelope(&recovery).unwrap();
        recovery.result = None;
        validate_terminal_ack_envelope(&recovery).unwrap();

        let mut resolution = test_terminal_ack();
        resolution.reconciliation_revision = 2;
        resolution.predecessor_billing_event_id = Some(recovery.billing_event_id.clone());
        resolution.operation_from_status = "recovery_required".to_string();
        validate_terminal_ack_envelope(&resolution).unwrap();

        resolution.predecessor_billing_event_id = None;
        assert_eq!(
            validate_terminal_ack_envelope(&resolution),
            Err("invalid_terminal_ack")
        );

        let mut health_probe = test_terminal_ack();
        health_probe.result = None;
        validate_terminal_ack_envelope(&health_probe).unwrap();
    }

    #[test]
    fn terminal_ack_response_and_error_classification_fail_closed() {
        let envelope = test_terminal_ack();
        let acknowledged = ControllerTerminalAckV2Payload {
            protocol_version: 1,
            billing_event_id: envelope.billing_event_id.clone(),
            operation_id: envelope.operation_id.clone(),
            reconciliation_revision: 1,
            status: "acknowledged".to_string(),
            final_ack: true,
            acknowledged_at: Some(1_800_000_001),
        };
        assert_eq!(
            terminal_ack_v2_outcome(acknowledged, &envelope),
            Ok(ContainerTerminalAckOutcome::Acknowledged { final_ack: true })
        );

        let v3 = test_terminal_ack_v3();
        let v3_payload = ControllerTerminalAckV3Payload {
            protocol_version: 1,
            terminal_ack_contract_version: 3,
            financial_terminal_contract_version: 2,
            billing_event_id: v3.billing_event_id.clone(),
            operation_id: v3.operation_id.clone(),
            reconciliation_revision: 1,
            terminal_contract_sha256: v3.terminal_contract_sha256.clone(),
            client_response_artifact_sha256: "9".repeat(64),
            status: "duplicate".to_string(),
            final_ack: true,
            acknowledged_at: 1_800_000_001,
        };
        assert_eq!(
            terminal_ack_v3_outcome(v3_payload.clone(), &v3),
            Ok(ContainerTerminalAckOutcome::Duplicate { final_ack: true })
        );
        let mut tampered = v3_payload;
        tampered.client_response_artifact_sha256 = "8".repeat(64);
        assert_eq!(
            terminal_ack_v3_outcome(tampered, &v3),
            Err(ContainerTerminalAckError::Permanent(
                "terminal_ack_contract_mismatch"
            ))
        );

        let conflict = classify_terminal_ack_error(
            409,
            &ControllerOperationErrorPayload {
                error: "terminal_ack_conflict".to_string(),
                retryable: Some(false),
            },
        );
        assert_eq!(
            conflict,
            ContainerTerminalAckError::Permanent("terminal_ack_conflict")
        );
        let old_controller = classify_terminal_ack_error(
            404,
            &ControllerOperationErrorPayload {
                error: "route_not_found".to_string(),
                retryable: None,
            },
        );
        assert_eq!(
            old_controller,
            ContainerTerminalAckError::Retryable("route_not_found")
        );
        let missing_operation = classify_terminal_ack_error(
            404,
            &ControllerOperationErrorPayload {
                error: "terminal_ack_not_found".to_string(),
                retryable: None,
            },
        );
        assert_eq!(
            missing_operation,
            ContainerTerminalAckError::Permanent("terminal_ack_not_found")
        );
        let expired_authority = classify_terminal_ack_error(
            409,
            &ControllerOperationErrorPayload {
                error: "authority_expired".to_string(),
                retryable: None,
            },
        );
        assert_eq!(
            expired_authority,
            ContainerTerminalAckError::Retryable("authority_expired")
        );
    }

    #[test]
    fn operation_outcome_requires_exact_identity_and_terminal_shape() {
        let envelope = test_operation();
        let claimed = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "claimed".to_string(),
            code: None,
            trace_id: envelope.trace_id.clone(),
            result: None,
            provider_attempt: None,
        };
        assert_eq!(
            operation_outcome(202, claimed.clone(), &envelope)
                .unwrap()
                .status,
            ContainerOperationStatus::Claimed
        );

        let mut running = claimed;
        running.status = "running".to_string();
        assert_eq!(
            operation_outcome(202, running, &envelope).unwrap().status,
            ContainerOperationStatus::Running
        );
        let completed = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "completed".to_string(),
            code: None,
            trace_id: envelope.trace_id.clone(),
            result: Some(ControllerOperationResult {
                object_key: format!(
                    "container-results/v1/relayreserve-test/2/{}",
                    "c".repeat(64)
                ),
                object_version: "version-result-1".to_string(),
                sha256: "c".repeat(64),
                size: 256,
                content_type: "application/json".to_string(),
            }),
            provider_attempt: None,
        };
        let outcome = operation_outcome(200, completed.clone(), &envelope).unwrap();
        assert_eq!(outcome.status, ContainerOperationStatus::Completed);
        assert!(outcome.result.is_some());

        let mut running_with_result = completed.clone();
        running_with_result.status = "running".to_string();
        let outcome = operation_outcome(202, running_with_result.clone(), &envelope).unwrap();
        assert_eq!(outcome.status, ContainerOperationStatus::Running);
        assert!(outcome.result.is_some());
        running_with_result.status = "claimed".to_string();
        assert_eq!(
            operation_outcome(202, running_with_result, &envelope),
            Err("contract_mismatch")
        );

        let mut forged = completed.clone();
        forged.trace_id = "trace-forged".to_string();
        assert_eq!(
            operation_outcome(200, forged, &envelope),
            Err("contract_mismatch")
        );
        let mut malformed = completed;
        malformed.status = "failed".to_string();
        malformed.code = Some("provider_failed".to_string());
        assert_eq!(
            operation_outcome(502, malformed, &envelope),
            Err("contract_mismatch")
        );

        let recovery = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "recovery_required".to_string(),
            code: Some("container_execution_ambiguous".to_string()),
            trace_id: envelope.trace_id.clone(),
            result: None,
            provider_attempt: None,
        };
        let recovery = operation_outcome(202, recovery, &envelope).unwrap();
        assert_eq!(recovery.status, ContainerOperationStatus::RecoveryRequired);
    }

    #[test]
    fn provider_attempt_status_is_fenced_and_supports_safe_cancellation() {
        let envelope = test_operation();
        let result = ControllerOperationResult {
            object_key: format!(
                "container-results/v1/relayreserve-test/2/{}",
                "c".repeat(64)
            ),
            object_version: "version-result-attempt-1".to_string(),
            sha256: "c".repeat(64),
            size: 256,
            content_type: "application/json".to_string(),
        };
        let succeeded = ControllerProviderAttempt {
            attempt_generation: 1,
            provider_operation_id: envelope.provider_operation_id.clone(),
            admission_sha256: envelope.admission_sha256.clone(),
            request_sha256: envelope.input.sha256.clone(),
            status: "succeeded".to_string(),
            response_status: Some(200),
            response_code: None,
            result: Some(result.clone()),
            prepared_at: 1_800_000_100,
            dispatched_at: Some(1_800_000_101),
            terminal_at: Some(1_800_000_102),
        };
        let completed = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "completed".to_string(),
            code: None,
            trace_id: envelope.trace_id.clone(),
            result: Some(result.clone()),
            provider_attempt: Some(succeeded.clone()),
        };
        let completed = operation_outcome(200, completed, &envelope).unwrap();
        assert_eq!(
            completed.provider_attempt.unwrap().status,
            ContainerProviderAttemptStatus::Succeeded
        );

        let cancelled = ControllerProviderAttempt {
            attempt_generation: 1,
            provider_operation_id: envelope.provider_operation_id.clone(),
            admission_sha256: envelope.admission_sha256.clone(),
            request_sha256: envelope.input.sha256.clone(),
            status: "cancelled".to_string(),
            response_status: Some(504),
            response_code: Some("provider_attempt_not_dispatched".to_string()),
            result: None,
            prepared_at: 1_800_000_100,
            dispatched_at: None,
            terminal_at: Some(1_800_000_120),
        };
        let failed = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "failed".to_string(),
            code: Some("provider_attempt_not_dispatched".to_string()),
            trace_id: envelope.trace_id.clone(),
            result: None,
            provider_attempt: Some(cancelled.clone()),
        };
        let failed = operation_outcome(504, failed, &envelope).unwrap();
        assert_eq!(
            failed.provider_attempt.unwrap().status,
            ContainerProviderAttemptStatus::Cancelled
        );

        let mut forged_generation = cancelled;
        forged_generation.attempt_generation = 4;
        assert_eq!(
            provider_attempt_outcome(forged_generation, &envelope),
            Err("contract_mismatch")
        );
        let mut missing_result = succeeded.clone();
        missing_result.result = None;
        assert_eq!(
            provider_attempt_outcome(missing_result, &envelope),
            Err("contract_mismatch")
        );
        let mut late_prepare = succeeded.clone();
        late_prepare.prepared_at = envelope.execution_deadline_at;
        late_prepare.dispatched_at = Some(envelope.execution_deadline_at + 1);
        late_prepare.terminal_at = Some(envelope.execution_deadline_at + 2);
        assert_eq!(
            provider_attempt_outcome(late_prepare, &envelope),
            Err("contract_mismatch")
        );
        let mut late_terminal = succeeded.clone();
        late_terminal.terminal_at = Some(envelope.execution_deadline_at);
        assert_eq!(
            provider_attempt_outcome(late_terminal, &envelope),
            Err("contract_mismatch")
        );

        let mut mismatched_attempt = succeeded;
        mismatched_attempt.result = Some(ControllerOperationResult {
            object_key: format!(
                "container-results/v1/relayreserve-test/2/{}",
                "d".repeat(64)
            ),
            object_version: "version-result-attempt-other".to_string(),
            sha256: "d".repeat(64),
            size: 256,
            content_type: "application/json".to_string(),
        });
        let mismatched = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "completed".to_string(),
            code: None,
            trace_id: envelope.trace_id.clone(),
            result: Some(result),
            provider_attempt: Some(mismatched_attempt),
        };
        assert_eq!(
            operation_outcome(200, mismatched, &envelope),
            Err("contract_mismatch")
        );

        let legacy: ControllerOperationPayload = serde_json::from_value(serde_json::json!({
            "protocol_version": 1,
            "operation_id": envelope.operation_id,
            "status": "running",
            "trace_id": envelope.trace_id
        }))
        .unwrap();
        assert!(legacy.provider_attempt.is_none());
    }

    #[test]
    fn controller_errors_preserve_capacity_and_fence_classification() {
        assert_eq!(
            classify_operation_error(
                404,
                &ControllerOperationErrorPayload {
                    error: "operation_status_not_found".to_string(),
                    retryable: None,
                },
            ),
            "operation_status_not_found"
        );
        assert_eq!(
            classify_operation_error(
                503,
                &ControllerOperationErrorPayload {
                    error: "container_capacity_exhausted".to_string(),
                    retryable: Some(true),
                },
            ),
            "capacity_exhausted"
        );
        assert_eq!(
            classify_operation_error(
                409,
                &ControllerOperationErrorPayload {
                    error: "admission_authority_mismatch".to_string(),
                    retryable: None,
                },
            ),
            "operation_fence_rejected"
        );
    }

    #[test]
    fn ledger_readiness_response_cannot_claim_live_health() {
        let authority = test_authority();
        let shard = test_shard();
        let mut response = ShardReadinessResponse {
            protocol_version: 1,
            probe_id: "readiness-test-1".to_string(),
            checked_at: 1_800_000_000,
            mode: "ledger".to_string(),
            ready: false,
            verdict: "unknown".to_string(),
            result_code: "ledger_snapshot".to_string(),
            shard: shard.clone(),
            wake_requested: false,
            container_state: None,
            ledger: ledger_snapshot(false),
            runtime: None,
        };
        assert!(readiness_response_matches(
            &response,
            &authority,
            "readiness-test-1",
            &shard,
            false,
            false,
            1_800_000_001,
        ));
        response.ready = true;
        assert!(!readiness_response_matches(
            &response,
            &authority,
            "readiness-test-1",
            &shard,
            false,
            false,
            1_800_000_001,
        ));
    }

    #[test]
    fn live_readiness_separates_process_and_execution_readiness() {
        let authority = test_authority();
        let shard = test_shard();
        let mut ledger = ledger_snapshot(true);
        ledger.readiness = PersistedReadinessSnapshot {
            generation: 1,
            phase: "complete".to_string(),
            last_probe_id: Some("readiness-live-1".to_string()),
            started_at_ms: Some(1_800_000_000_000),
            deadline_at_ms: Some(1_800_000_010_000),
            completed_at_ms: Some(1_800_000_001_000),
            result_code: Some("process_ready_execution_disabled".to_string()),
            container_status: Some("healthy".to_string()),
            container_last_change_ms: Some(1_800_000_000_500),
            container_exit_code: None,
            runtime_protocol_version: Some(1),
            runtime_contract_version: Some(1),
            runtime_execution_enabled: Some(false),
            last_ready_at_ms: Some(1_800_000_001_000),
        };
        let mut response = ShardReadinessResponse {
            protocol_version: 1,
            probe_id: "readiness-live-1".to_string(),
            checked_at: 1_800_000_001,
            mode: "live".to_string(),
            ready: false,
            verdict: "not_ready".to_string(),
            result_code: "process_ready_execution_disabled".to_string(),
            shard: shard.clone(),
            wake_requested: true,
            container_state: Some(ContainerStateSnapshot {
                status: "healthy".to_string(),
                last_change_ms: 1_800_000_000_500,
                exit_code: None,
            }),
            ledger,
            runtime: Some(RuntimeReadinessSnapshot {
                process_ready: true,
                execution_ready: false,
                protocol_version: 1,
                shard_contract_version: 1,
                runtime_build_id: Some("b".repeat(64)),
                execution_enabled: false,
            }),
        };
        assert!(readiness_response_matches(
            &response,
            &authority,
            "readiness-live-1",
            &shard,
            true,
            false,
            1_800_000_002,
        ));
        response.ready = true;
        response.verdict = "ready".to_string();
        assert!(!readiness_response_matches(
            &response,
            &authority,
            "readiness-live-1",
            &shard,
            true,
            false,
            1_800_000_002,
        ));
    }
}
