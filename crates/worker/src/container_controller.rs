//! Private edge Worker client for the isolated Container Controller.
//!
//! The probe is deliberately admin-only at its call site, bounded, signed, and
//! default-off. A configured service binding proves reachability only after the
//! controller accepts the shared authority token and reports the expected ring.

use cinatoken_container_authority::{
    body_sha256, sign_authority, AuthorityInput, MIN_SECRET_BYTES,
};
use cinatoken_sharding::ShardPlan;
use futures_util::future::{select, Either};
use serde::{Deserialize, Serialize};
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
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const STATUS_MAX_BYTES: usize = 4 * 1024;
const READINESS_MAX_BYTES: usize = 4 * 1024;
const OPERATION_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const OPERATION_STATUS_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
struct ShardReadinessRequest<'a> {
    protocol_version: u32,
    shard: &'a ShardPlan,
    wake_container: bool,
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerOperationPayload {
    protocol_version: u32,
    operation_id: String,
    status: String,
    code: Option<String>,
    trace_id: String,
    result: Option<ControllerOperationResult>,
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
struct ControllerOperationErrorPayload {
    error: String,
    retryable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerOperationStatus {
    InFlight,
    Completed,
    Failed,
    RecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerOperationOutcome {
    pub status: ContainerOperationStatus,
    pub http_status: u16,
    pub code: Option<String>,
    pub result: Option<ContainerArtifactManifest>,
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
    pub execution_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerControllerProbe {
    pub probe_enabled: bool,
    pub binding_available: bool,
    pub authority_configured: bool,
    pub verified: bool,
    pub controller_enabled: bool,
    pub execution_enabled: bool,
    pub previous_secret_configured: bool,
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
        state: "verified",
    }
}

pub async fn probe_shard_readiness(
    env: &Env,
    shard: &ShardPlan,
    wake_container: bool,
) -> Result<ShardReadinessResponse, &'static str> {
    let fetcher = env
        .service(CONTAINER_CONTROLLER_BINDING)
        .map_err(|_| "binding_unavailable")?;
    let authority = authority_config(env).ok_or("authority_unavailable")?;
    let dispatch_id = random_dispatch_id("readiness").ok_or("entropy_unavailable")?;
    let body = serde_json::to_vec(&ShardReadinessRequest {
        protocol_version: authority.protocol_version,
        shard,
        wake_container,
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
    let dispatch_id = random_dispatch_id("operation-status").ok_or("entropy_unavailable")?;
    let body = serde_json::to_vec(&ContainerOperationStatusQuery {
        protocol_version: envelope.protocol_version,
        operation_id: &envelope.operation_id,
        owner_generation: envelope.owner_generation,
        shard: &envelope.shard,
        trace_id: &envelope.trace_id,
    })
    .map_err(|_| "request_encode_failed")?;
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let token = sign_bound_authority(
        &authority,
        &dispatch_id,
        "POST",
        OPERATION_STATUS_PATH,
        &body,
        now,
    )
    .ok_or("authority_sign_failed")?;
    let request = operation_status_request(&token, &body).map_err(|_| "request_build_failed")?;
    let operation = execute_operation(&fetcher, request, envelope);
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
            (403, _) => "authority_rejected",
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
    if !readiness_response_matches(&payload, authority, dispatch_id, shard, wake_container, now) {
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
            (ContainerOperationStatus::InFlight, None)
        }
        "running" if http_status == 202 && payload.code.is_none() => (
            ContainerOperationStatus::InFlight,
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
    Ok(ContainerOperationOutcome {
        status,
        http_status,
        code: payload.code,
        result,
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
        && payload.checked_at >= now.saturating_sub(120)
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

fn operation_status_request(token: &str, body: &[u8]) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body).buffer().into()))
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(OPERATION_STATUS_URL, &init)
}

fn status_matches(
    payload: &ControllerStatusPayload,
    authority: &AuthorityConfig,
    runtime: ContainerSchedulerRuntimeStatus,
) -> bool {
    payload.protocol_version == authority.protocol_version
        && payload.ring_generation == runtime.ring_generation
        && payload.shard_count == runtime.shard_count
        && payload.authority_current_secret_configured
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
        state,
    }
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
    use cinatoken_container_authority::{verify_authority, AuthorityExpectation};

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
            authority_current_secret_configured: true,
            authority_previous_secret_configured: false,
        };
        assert!(status_matches(&payload, &authority, runtime));
        payload.shard_count = 17;
        assert!(!status_matches(&payload, &authority, runtime));
        payload.shard_count = 16;
        payload.authority_current_secret_configured = false;
        assert!(!status_matches(&payload, &authority, runtime));
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
    fn operation_outcome_requires_exact_identity_and_terminal_shape() {
        let envelope = test_operation();
        let in_flight = ControllerOperationPayload {
            protocol_version: 1,
            operation_id: envelope.operation_id.clone(),
            status: "running".to_string(),
            code: None,
            trace_id: envelope.trace_id.clone(),
            result: None,
        };
        assert_eq!(
            operation_outcome(202, in_flight, &envelope).unwrap().status,
            ContainerOperationStatus::InFlight
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
        };
        let outcome = operation_outcome(200, completed.clone(), &envelope).unwrap();
        assert_eq!(outcome.status, ContainerOperationStatus::Completed);
        assert!(outcome.result.is_some());

        let mut running_with_result = completed.clone();
        running_with_result.status = "running".to_string();
        let outcome = operation_outcome(202, running_with_result.clone(), &envelope).unwrap();
        assert_eq!(outcome.status, ContainerOperationStatus::InFlight);
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
        };
        let recovery = operation_outcome(202, recovery, &envelope).unwrap();
        assert_eq!(recovery.status, ContainerOperationStatus::RecoveryRequired);
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
            1_800_000_001,
        ));
        response.ready = true;
        assert!(!readiness_response_matches(
            &response,
            &authority,
            "readiness-test-1",
            &shard,
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
                execution_enabled: false,
            }),
        };
        assert!(readiness_response_matches(
            &response,
            &authority,
            "readiness-live-1",
            &shard,
            true,
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
            1_800_000_002,
        ));
    }
}
