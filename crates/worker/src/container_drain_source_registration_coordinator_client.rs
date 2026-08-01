//! Bounded private client for the drain-source registration coordinator.
//!
//! This module has no route. It signs canonical protocol requests and calls
//! the dedicated coordinator Worker only through its Service Binding.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cinatoken_drain_source_registration_coordinator::{
    canonical_json_bytes, derive_coordinator_object_name_v1, sha256_hex_bytes,
    validate_wire_request_v1, BeginRequestV1, CommitAttemptedRequestV1, CoordinatorErrorResponseV1,
    CoordinatorIdentityV1, CoordinatorPhase, CoordinatorStatusResponseV1, FinishClaimRequestV1,
    OutcomeRecordedRequestV1, PermitRequestFrozenRequestV1, PermitVerifiedRequestV1,
    ProofVerifiedRequestV1, RecoverRequestV1, RegistrationOutcome, StatusRequestV1,
    AUTHORITY_DOMAIN, AUTHORITY_HEADER, AUTHORITY_TYPE, AUTHORITY_WINDOW_SECONDS, BEGIN_PATH,
    FINISH_PATH, MAX_JSON_BODY_BYTES, MAX_RESPONSE_BYTES, RECOVER_PATH, STATUS_PATH,
};
use futures_util::future::{select, Either};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use std::time::Duration;
use worker::{Delay, Env, Fetcher, Headers, Method, Request, RequestInit, RequestRedirect};

pub(crate) const COORDINATOR_SERVICE_BINDING: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR";
pub(crate) const COORDINATOR_CLIENT_ENABLED_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_CLIENT_ENABLED";
pub(crate) const COORDINATOR_AUTHORITY_ISSUER_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER";
pub(crate) const COORDINATOR_AUTHORITY_AUDIENCE_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE";
pub(crate) const COORDINATOR_CALLER_IDENTITY_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256";
pub(crate) const COORDINATOR_CURRENT_KID_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID";
pub(crate) const COORDINATOR_CURRENT_SECRET_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET";

const INTERNAL_ORIGIN: &str = "https://drain-source-registration-coordinator.internal";
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CoordinatorClientError {
    Disabled,
    Configuration,
    Binding,
    Request,
    Timeout,
    Transport,
    Response,
    Rejected { status: u16, code: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoordinatorClientFailureClass {
    NotDispatched,
    DeterministicRejection,
    Indeterminate,
    ProtocolViolation,
}

impl CoordinatorClientError {
    pub(crate) const fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "coordinator_client_disabled",
            Self::Configuration => "coordinator_client_configuration_invalid",
            Self::Binding => "coordinator_client_binding_unavailable",
            Self::Request => "coordinator_client_request_invalid",
            Self::Timeout => "coordinator_client_timeout",
            Self::Transport => "coordinator_client_transport_failed",
            Self::Response => "coordinator_client_response_invalid",
            Self::Rejected { .. } => "coordinator_client_rejected",
        }
    }

    pub(crate) const fn class(&self) -> CoordinatorClientFailureClass {
        match self {
            Self::Disabled | Self::Configuration | Self::Binding | Self::Request => {
                CoordinatorClientFailureClass::NotDispatched
            }
            Self::Timeout | Self::Transport => CoordinatorClientFailureClass::Indeterminate,
            Self::Response => CoordinatorClientFailureClass::ProtocolViolation,
            Self::Rejected { status, .. } if *status >= 500 => {
                CoordinatorClientFailureClass::Indeterminate
            }
            Self::Rejected { .. } => CoordinatorClientFailureClass::DeterministicRejection,
        }
    }
}

#[derive(Clone)]
struct CoordinatorClientConfig {
    environment: String,
    issuer: String,
    audience: String,
    caller_identity_sha256: String,
    kid: String,
    secret: String,
}

#[derive(Debug, Serialize)]
struct AuthorityHeader<'a> {
    alg: &'static str,
    kid: &'a str,
    typ: &'static str,
}

#[derive(Debug, Serialize)]
struct AuthorityClaims<'a> {
    audience: &'a str,
    body_sha256: &'a str,
    caller_identity_sha256: &'a str,
    expires_at: i64,
    issued_at: i64,
    issuer: &'a str,
    method: &'static str,
    object_name: &'a str,
    path: &'a str,
    request_id_sha256: &'a str,
}

#[derive(Debug, Clone, Copy)]
struct RequestMetadata<'a> {
    identity: &'a CoordinatorIdentityV1,
    request_id_sha256: &'a str,
    expected_generation: Option<u32>,
    target_phase: Option<CoordinatorPhase>,
    expected_command_id_sha256: Option<&'a str>,
}

impl<'a> RequestMetadata<'a> {
    const fn mutation(
        identity: &'a CoordinatorIdentityV1,
        request_id_sha256: &'a str,
        expected_generation: u32,
        target_phase: CoordinatorPhase,
        expected_command_id_sha256: Option<&'a str>,
    ) -> Self {
        Self {
            identity,
            request_id_sha256,
            expected_generation: Some(expected_generation),
            target_phase: Some(target_phase),
            expected_command_id_sha256,
        }
    }

    const fn status(identity: &'a CoordinatorIdentityV1, request_id_sha256: &'a str) -> Self {
        Self {
            identity,
            request_id_sha256,
            expected_generation: None,
            target_phase: None,
            expected_command_id_sha256: None,
        }
    }
}

pub(crate) async fn begin(
    env: &Env,
    request: &BeginRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute(
        env,
        BEGIN_PATH,
        request,
        RequestMetadata::mutation(
            &request.identity,
            &request.request_id_sha256,
            request.expected_generation,
            CoordinatorPhase::ChallengeIssued,
            None,
        ),
    )
    .await
}

pub(crate) async fn claim_finish(
    env: &Env,
    request: &FinishClaimRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        CoordinatorPhase::FinishClaimed,
        None,
    )
    .await
}

pub(crate) async fn record_proof(
    env: &Env,
    request: &ProofVerifiedRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        CoordinatorPhase::ProofVerified,
        None,
    )
    .await
}

pub(crate) async fn freeze_permit_request(
    env: &Env,
    request: &PermitRequestFrozenRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        CoordinatorPhase::PermitRequestFrozen,
        None,
    )
    .await
}

pub(crate) async fn record_permit(
    env: &Env,
    request: &PermitVerifiedRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        CoordinatorPhase::PermitVerified,
        None,
    )
    .await
}

pub(crate) async fn record_commit_attempt(
    env: &Env,
    request: &CommitAttemptedRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        CoordinatorPhase::CommitAttempted,
        None,
    )
    .await
}

pub(crate) async fn record_outcome(
    env: &Env,
    request: &OutcomeRecordedRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute_finish(
        env,
        request,
        &request.identity,
        &request.request_id_sha256,
        request.expected_generation,
        outcome_phase(request.evidence.outcome),
        Some(&request.evidence.command_id_sha256),
    )
    .await
}

pub(crate) async fn status(
    env: &Env,
    request: &StatusRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute(
        env,
        STATUS_PATH,
        request,
        RequestMetadata::status(&request.identity, &request.request_id_sha256),
    )
    .await
}

pub(crate) async fn recover(
    env: &Env,
    request: &RecoverRequestV1,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute(
        env,
        RECOVER_PATH,
        request,
        RequestMetadata::mutation(
            &request.identity,
            &request.request_id_sha256,
            request.expected_generation,
            outcome_phase(request.evidence.outcome),
            Some(&request.evidence.command_id_sha256),
        ),
    )
    .await
}

async fn execute_finish<T: Serialize>(
    env: &Env,
    request: &T,
    identity: &CoordinatorIdentityV1,
    request_id_sha256: &str,
    expected_generation: u32,
    target_phase: CoordinatorPhase,
    expected_command_id_sha256: Option<&str>,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    execute(
        env,
        FINISH_PATH,
        request,
        RequestMetadata::mutation(
            identity,
            request_id_sha256,
            expected_generation,
            target_phase,
            expected_command_id_sha256,
        ),
    )
    .await
}

async fn execute<T: Serialize>(
    env: &Env,
    path: &str,
    request: &T,
    metadata: RequestMetadata<'_>,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    if !runtime_flag(env, COORDINATOR_CLIENT_ENABLED_ENV) {
        return Err(CoordinatorClientError::Disabled);
    }
    let config = client_config(env).ok_or(CoordinatorClientError::Configuration)?;
    let body = canonical_json_bytes(request).map_err(|_| CoordinatorClientError::Request)?;
    if !validate_wire_request_v1(path, &config.environment, &body)
        || body.len() > MAX_JSON_BODY_BYTES
        || metadata.identity.environment != config.environment
        || !valid_sha256(metadata.request_id_sha256)
    {
        return Err(CoordinatorClientError::Request);
    }
    let object_name = derive_coordinator_object_name_v1(metadata.identity)
        .ok_or(CoordinatorClientError::Request)?;
    let body_sha256 = sha256_hex_bytes(&body);
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let authority = sign_authority(
        &config,
        path,
        &object_name,
        metadata.request_id_sha256,
        &body_sha256,
        now,
    )
    .ok_or(CoordinatorClientError::Configuration)?;
    let request =
        service_request(path, &authority, &body).map_err(|_| CoordinatorClientError::Request)?;
    let fetcher = env
        .service(COORDINATOR_SERVICE_BINDING)
        .map_err(|_| CoordinatorClientError::Binding)?;
    let operation = execute_request(&fetcher, request, path, metadata);
    let delay = Delay::from(CLIENT_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    match select(operation, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err(CoordinatorClientError::Timeout),
    }
}

async fn execute_request(
    fetcher: &Fetcher,
    request: Request,
    path: &str,
    metadata: RequestMetadata<'_>,
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| CoordinatorClientError::Transport)?;
    let status = response.status_code();
    if !valid_response_headers(&response) {
        return Err(CoordinatorClientError::Response);
    }
    let body = crate::relay::read_response_bytes_limited(&mut response, MAX_RESPONSE_BYTES)
        .await
        .map_err(|_| CoordinatorClientError::Response)?;
    decode_response_body(path, status, metadata, &body)
}

fn decode_response_body(
    path: &str,
    status: u16,
    metadata: RequestMetadata<'_>,
    body: &[u8],
) -> Result<CoordinatorStatusResponseV1, CoordinatorClientError> {
    if response_status_may_contain_state(path, status) {
        if let Ok(payload) = serde_json::from_slice::<CoordinatorStatusResponseV1>(body) {
            if canonical_json_bytes(&payload).ok().as_deref() != Some(body) {
                return Err(CoordinatorClientError::Response);
            }
            validate_status_response(path, status, metadata, &payload)?;
            return Ok(payload);
        }
    }
    let payload = serde_json::from_slice::<CoordinatorErrorResponseV1>(body)
        .map_err(|_| CoordinatorClientError::Response)?;
    if payload.contract_version != 1 || !valid_error_code(&payload.code) {
        return Err(CoordinatorClientError::Response);
    }
    if canonical_json_bytes(&payload).ok().as_deref() != Some(body) {
        return Err(CoordinatorClientError::Response);
    }
    Err(CoordinatorClientError::Rejected {
        status,
        code: payload.code,
    })
}

fn validate_status_response(
    path: &str,
    status: u16,
    metadata: RequestMetadata<'_>,
    payload: &CoordinatorStatusResponseV1,
) -> Result<(), CoordinatorClientError> {
    if payload.contract_version != 1
        || payload.event_count != payload.generation
        || !valid_phase_generation(payload.phase, payload.generation)
        || payload.operation_id_sha256 != metadata.identity.operation_id_sha256
        || !valid_sha256(&payload.latest_event_sha256)
        || payload.expires_at_ms <= 0
        || payload.terminal != payload.phase.terminal()
        || !valid_phase_outcome(payload)
        || metadata.expected_command_id_sha256.is_some_and(|expected| {
            payload
                .outcome
                .as_ref()
                .is_none_or(|outcome| outcome.command_id_sha256 != expected)
        })
    {
        return Err(CoordinatorClientError::Response);
    }
    if let (Some(expected_generation), Some(target_phase)) =
        (metadata.expected_generation, metadata.target_phase)
    {
        let next_generation = expected_generation.saturating_add(1);
        let valid_transition = if payload.replayed {
            payload.generation >= next_generation
                && phase_reachable_from(target_phase, payload.phase)
        } else {
            payload.generation == next_generation
                && (payload.phase == target_phase
                    || (payload.phase == CoordinatorPhase::Expired && expected_generation < 6)
                    || (payload.phase == CoordinatorPhase::RecoveryPending
                        && expected_generation == 6))
        };
        if !valid_transition {
            return Err(CoordinatorClientError::Response);
        }
    } else if payload.replayed {
        return Err(CoordinatorClientError::Response);
    }
    let valid_status = if path == STATUS_PATH {
        status == 200
    } else {
        match status {
            201 => {
                path == BEGIN_PATH
                    && payload.phase == CoordinatorPhase::ChallengeIssued
                    && !payload.replayed
            }
            202 => payload.phase == CoordinatorPhase::RecoveryPending,
            409 => payload.phase == CoordinatorPhase::Conflict,
            410 => payload.phase == CoordinatorPhase::Expired,
            200 => !matches!(
                payload.phase,
                CoordinatorPhase::RecoveryPending
                    | CoordinatorPhase::Conflict
                    | CoordinatorPhase::Expired
            ),
            _ => false,
        }
    };
    if valid_status {
        Ok(())
    } else {
        Err(CoordinatorClientError::Response)
    }
}

fn valid_phase_outcome(payload: &CoordinatorStatusResponseV1) -> bool {
    let Some(outcome) = payload.outcome.as_ref() else {
        return matches!(
            payload.phase,
            CoordinatorPhase::ChallengeIssued
                | CoordinatorPhase::FinishClaimed
                | CoordinatorPhase::ProofVerified
                | CoordinatorPhase::PermitRequestFrozen
                | CoordinatorPhase::PermitVerified
                | CoordinatorPhase::CommitAttempted
                | CoordinatorPhase::Expired
        );
    };
    if !valid_outcome_evidence(outcome) {
        return false;
    }
    match payload.phase {
        CoordinatorPhase::Applied => outcome.outcome == RegistrationOutcome::FreshApplied,
        CoordinatorPhase::ExactReplay => outcome.outcome == RegistrationOutcome::ExactReplay,
        CoordinatorPhase::Conflict => outcome.outcome == RegistrationOutcome::Conflict,
        CoordinatorPhase::RecoveryPending => outcome.outcome == RegistrationOutcome::OutcomeUnknown,
        _ => false,
    }
}

fn valid_outcome_evidence(
    outcome: &cinatoken_drain_source_registration_coordinator::OutcomeEvidenceV1,
) -> bool {
    if !valid_sha256(&outcome.authoritative_readback_sha256)
        || !valid_sha256(&outcome.command_id_sha256)
        || outcome
            .winner_command_id_sha256
            .as_ref()
            .is_some_and(|value| !valid_sha256(value))
    {
        return false;
    }
    match outcome.outcome {
        RegistrationOutcome::FreshApplied | RegistrationOutcome::ExactReplay => {
            outcome.winner_command_id_sha256.as_deref() == Some(outcome.command_id_sha256.as_str())
        }
        RegistrationOutcome::Conflict => outcome
            .winner_command_id_sha256
            .as_deref()
            .is_some_and(|winner| winner != outcome.command_id_sha256),
        RegistrationOutcome::OutcomeUnknown => outcome.winner_command_id_sha256.is_none(),
    }
}

fn valid_phase_generation(phase: CoordinatorPhase, generation: u32) -> bool {
    match phase {
        CoordinatorPhase::ChallengeIssued => generation == 1,
        CoordinatorPhase::FinishClaimed => generation == 2,
        CoordinatorPhase::ProofVerified => generation == 3,
        CoordinatorPhase::PermitRequestFrozen => generation == 4,
        CoordinatorPhase::PermitVerified => generation == 5,
        CoordinatorPhase::CommitAttempted => generation == 6,
        CoordinatorPhase::RecoveryPending => generation == 7,
        CoordinatorPhase::Applied | CoordinatorPhase::ExactReplay | CoordinatorPhase::Conflict => {
            matches!(generation, 7 | 8)
        }
        CoordinatorPhase::Expired => (2..=6).contains(&generation),
    }
}

fn phase_reachable_from(target: CoordinatorPhase, current: CoordinatorPhase) -> bool {
    if target == current {
        return true;
    }
    match target {
        CoordinatorPhase::ChallengeIssued => true,
        CoordinatorPhase::FinishClaimed => current != CoordinatorPhase::ChallengeIssued,
        CoordinatorPhase::ProofVerified => !matches!(
            current,
            CoordinatorPhase::ChallengeIssued | CoordinatorPhase::FinishClaimed
        ),
        CoordinatorPhase::PermitRequestFrozen => matches!(
            current,
            CoordinatorPhase::PermitVerified
                | CoordinatorPhase::CommitAttempted
                | CoordinatorPhase::RecoveryPending
                | CoordinatorPhase::Applied
                | CoordinatorPhase::ExactReplay
                | CoordinatorPhase::Conflict
                | CoordinatorPhase::Expired
        ),
        CoordinatorPhase::PermitVerified => matches!(
            current,
            CoordinatorPhase::CommitAttempted
                | CoordinatorPhase::RecoveryPending
                | CoordinatorPhase::Applied
                | CoordinatorPhase::ExactReplay
                | CoordinatorPhase::Conflict
                | CoordinatorPhase::Expired
        ),
        CoordinatorPhase::CommitAttempted => matches!(
            current,
            CoordinatorPhase::RecoveryPending
                | CoordinatorPhase::Applied
                | CoordinatorPhase::ExactReplay
                | CoordinatorPhase::Conflict
        ),
        CoordinatorPhase::RecoveryPending => matches!(
            current,
            CoordinatorPhase::Applied | CoordinatorPhase::ExactReplay | CoordinatorPhase::Conflict
        ),
        CoordinatorPhase::Applied
        | CoordinatorPhase::ExactReplay
        | CoordinatorPhase::Conflict
        | CoordinatorPhase::Expired => false,
    }
}

const fn outcome_phase(outcome: RegistrationOutcome) -> CoordinatorPhase {
    match outcome {
        RegistrationOutcome::FreshApplied => CoordinatorPhase::Applied,
        RegistrationOutcome::ExactReplay => CoordinatorPhase::ExactReplay,
        RegistrationOutcome::Conflict => CoordinatorPhase::Conflict,
        RegistrationOutcome::OutcomeUnknown => CoordinatorPhase::RecoveryPending,
    }
}

fn response_status_may_contain_state(path: &str, status: u16) -> bool {
    if path == STATUS_PATH {
        status == 200
    } else {
        matches!(status, 200 | 201 | 202 | 409 | 410)
    }
}

fn valid_response_headers(response: &worker::Response) -> bool {
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
    let content_options = response
        .headers()
        .get("x-content-type-options")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    valid_json_content_type(&content_type)
        && cache_control
            .split(',')
            .any(|directive| directive.trim() == "no-store")
        && content_options == "nosniff"
}

fn valid_json_content_type(value: &str) -> bool {
    let mut parts = value.split(';').map(str::trim);
    if parts.next() != Some("application/json") {
        return false;
    }
    let parameters = parts.collect::<Vec<_>>();
    parameters.is_empty()
        || (parameters.len() == 1 && parameters[0].eq_ignore_ascii_case("charset=utf-8"))
}

fn client_config(env: &Env) -> Option<CoordinatorClientConfig> {
    let environment = match runtime_value(env, "ENVIRONMENT")?.as_str() {
        "development" => "local".to_string(),
        "staging" => "staging".to_string(),
        _ => return None,
    };
    let issuer = runtime_value(env, COORDINATOR_AUTHORITY_ISSUER_ENV)?;
    let audience = runtime_value(env, COORDINATOR_AUTHORITY_AUDIENCE_ENV)?;
    let caller_identity_sha256 = runtime_value(env, COORDINATOR_CALLER_IDENTITY_ENV)?;
    let kid = runtime_value(env, COORDINATOR_CURRENT_KID_ENV)?;
    let secret = env
        .secret(COORDINATOR_CURRENT_SECRET_ENV)
        .ok()
        .map(|value| value.to_string())
        .or_else(|| {
            (environment == "local")
                .then(|| runtime_value(env, COORDINATOR_CURRENT_SECRET_ENV))
                .flatten()
        })?;
    if !valid_identifier(&issuer)
        || !valid_identifier(&audience)
        || issuer == audience
        || !valid_sha256(&caller_identity_sha256)
        || !valid_identifier(&kid)
        || !(32..=256).contains(&secret.as_bytes().len())
    {
        return None;
    }
    Some(CoordinatorClientConfig {
        environment,
        issuer,
        audience,
        caller_identity_sha256,
        kid,
        secret,
    })
}

fn sign_authority(
    config: &CoordinatorClientConfig,
    path: &str,
    object_name: &str,
    request_id_sha256: &str,
    body_sha256: &str,
    now: i64,
) -> Option<String> {
    if !matches!(path, BEGIN_PATH | FINISH_PATH | STATUS_PATH | RECOVER_PATH)
        || !valid_sha256(request_id_sha256)
        || !valid_sha256(body_sha256)
        || now <= 0
    {
        return None;
    }
    let header = canonical_json_bytes(&AuthorityHeader {
        alg: "HS256",
        kid: &config.kid,
        typ: AUTHORITY_TYPE,
    })
    .ok()?;
    let claims = canonical_json_bytes(&AuthorityClaims {
        audience: &config.audience,
        body_sha256,
        caller_identity_sha256: &config.caller_identity_sha256,
        expires_at: now.checked_add(AUTHORITY_WINDOW_SECONDS)?,
        issued_at: now,
        issuer: &config.issuer,
        method: "POST",
        object_name,
        path,
        request_id_sha256,
    })
    .ok()?;
    let header_part = URL_SAFE_NO_PAD.encode(header);
    let claims_part = URL_SAFE_NO_PAD.encode(claims);
    let mut mac = Hmac::<Sha256>::new_from_slice(config.secret.as_bytes()).ok()?;
    mac.update(AUTHORITY_DOMAIN);
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(claims_part.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{header_part}.{claims_part}.{signature}"))
}

fn service_request(path: &str, authority: &str, body: &[u8]) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/json")?;
    headers.set(AUTHORITY_HEADER, authority)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(body).buffer().into()))
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(&format!("{INTERNAL_ORIGIN}{path}"), &init)
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    runtime_value(env, name).as_deref() == Some("true")
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinatoken_drain_source_registration_coordinator::{
        BeginEvidenceV1, CommitAttemptEvidenceV1, FinishClaimEvidenceV1, OutcomeEvidenceV1,
        PermitRequestEvidenceV1, PermitVerifiedEvidenceV1, ProofVerifiedEvidenceV1,
    };

    fn digest(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn identity() -> CoordinatorIdentityV1 {
        CoordinatorIdentityV1 {
            authorization_id_sha256: digest(1),
            contract_version: 1,
            environment: "staging".to_string(),
            operation_id_sha256: digest(2),
            root_user_id: "42".to_string(),
            scope_id_sha256: digest(3),
            scope_kind: "global".to_string(),
        }
    }

    fn status_response(phase: CoordinatorPhase, generation: u32) -> CoordinatorStatusResponseV1 {
        let command_id_sha256 = digest(22);
        let outcome = match phase {
            CoordinatorPhase::Applied => Some(RegistrationOutcome::FreshApplied),
            CoordinatorPhase::ExactReplay => Some(RegistrationOutcome::ExactReplay),
            CoordinatorPhase::Conflict => Some(RegistrationOutcome::Conflict),
            CoordinatorPhase::RecoveryPending => Some(RegistrationOutcome::OutcomeUnknown),
            _ => None,
        }
        .map(|outcome| {
            let winner_command_id_sha256 = match outcome {
                RegistrationOutcome::FreshApplied | RegistrationOutcome::ExactReplay => {
                    Some(command_id_sha256.clone())
                }
                RegistrationOutcome::Conflict => Some(digest(23)),
                RegistrationOutcome::OutcomeUnknown => None,
            };
            OutcomeEvidenceV1 {
                authoritative_readback_sha256: digest(21),
                command_id_sha256: command_id_sha256.clone(),
                outcome,
                winner_command_id_sha256,
            }
        });
        CoordinatorStatusResponseV1 {
            contract_version: 1,
            event_count: generation,
            expires_at_ms: 2_100_000_120_000,
            generation,
            latest_event_sha256: digest(20),
            operation_id_sha256: identity().operation_id_sha256,
            outcome,
            phase,
            replayed: false,
            terminal: phase.terminal(),
        }
    }

    #[test]
    fn every_client_request_uses_the_shared_canonical_protocol() {
        let identity = identity();
        let requests: Vec<(&str, Vec<u8>)> = vec![
            (
                BEGIN_PATH,
                canonical_json_bytes(&BeginRequestV1 {
                    command: "begin".to_string(),
                    evidence: BeginEvidenceV1 {
                        authority_fingerprint_sha256: digest(4),
                        begin_intent_sha256: digest(5),
                        ceremony_id_sha256: digest(6),
                        challenge_phase_proof_sha256: digest(7),
                        challenge_sha256: digest(8),
                    },
                    expected_generation: 0,
                    expires_at_ms: 2_100_000_120_000,
                    identity: identity.clone(),
                    request_id_sha256: digest(9),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&FinishClaimRequestV1 {
                    command: "claim_finish".to_string(),
                    evidence: FinishClaimEvidenceV1 {
                        assertion_envelope_sha256: digest(10),
                        finish_claim_id_sha256: digest(11),
                    },
                    expected_generation: 1,
                    identity: identity.clone(),
                    request_id_sha256: digest(12),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&ProofVerifiedRequestV1 {
                    command: "record_proof".to_string(),
                    evidence: ProofVerifiedEvidenceV1 {
                        passkey_assertion_signature_sha256: digest(13),
                        passkey_state_transition_sha256: digest(14),
                        verified_passkey_proof_sha256: digest(15),
                    },
                    expected_generation: 2,
                    identity: identity.clone(),
                    request_id_sha256: digest(16),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&PermitRequestFrozenRequestV1 {
                    command: "freeze_permit_request".to_string(),
                    evidence: PermitRequestEvidenceV1 {
                        issuer_auth_key_id_sha256: digest(17),
                        issuer_phase_proof_sha256: digest(18),
                        issuer_request_id_sha256: digest(19),
                        issuer_request_sha256: digest(20),
                    },
                    expected_generation: 3,
                    identity: identity.clone(),
                    request_id_sha256: digest(21),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&PermitVerifiedRequestV1 {
                    command: "record_permit".to_string(),
                    evidence: PermitVerifiedEvidenceV1 {
                        issuer_version_sha256: digest(22),
                        permit_id_sha256: digest(23),
                        permit_signature_envelope_sha256: digest(24),
                        permit_subject_sha256: digest(25),
                    },
                    expected_generation: 4,
                    identity: identity.clone(),
                    request_id_sha256: digest(26),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&CommitAttemptedRequestV1 {
                    command: "record_commit_attempt".to_string(),
                    evidence: CommitAttemptEvidenceV1 {
                        command_body_sha256: digest(27),
                        command_id_sha256: digest(28),
                        commit_phase_proof_sha256: digest(29),
                    },
                    expected_generation: 5,
                    identity: identity.clone(),
                    request_id_sha256: digest(30),
                })
                .unwrap(),
            ),
            (
                FINISH_PATH,
                canonical_json_bytes(&OutcomeRecordedRequestV1 {
                    command: "record_outcome".to_string(),
                    evidence: OutcomeEvidenceV1 {
                        authoritative_readback_sha256: digest(31),
                        command_id_sha256: digest(32),
                        outcome: RegistrationOutcome::OutcomeUnknown,
                        winner_command_id_sha256: None,
                    },
                    expected_generation: 6,
                    identity: identity.clone(),
                    request_id_sha256: digest(33),
                })
                .unwrap(),
            ),
            (
                STATUS_PATH,
                canonical_json_bytes(&StatusRequestV1 {
                    command: "status".to_string(),
                    identity: identity.clone(),
                    request_id_sha256: digest(34),
                })
                .unwrap(),
            ),
            (
                RECOVER_PATH,
                canonical_json_bytes(&RecoverRequestV1 {
                    command: "recover".to_string(),
                    evidence: OutcomeEvidenceV1 {
                        authoritative_readback_sha256: digest(35),
                        command_id_sha256: digest(36),
                        outcome: RegistrationOutcome::FreshApplied,
                        winner_command_id_sha256: Some(digest(36)),
                    },
                    expected_generation: 7,
                    identity,
                    request_id_sha256: digest(37),
                })
                .unwrap(),
            ),
        ];
        for (path, body) in requests {
            assert!(body.len() <= MAX_JSON_BODY_BYTES);
            assert!(validate_wire_request_v1(path, "staging", &body));
            assert_eq!(
                canonical_json_bytes(&serde_json::from_slice::<serde_json::Value>(&body).unwrap())
                    .unwrap(),
                body
            );
        }
    }

    #[test]
    fn authority_vector_binds_body_object_request_and_path() {
        let config = CoordinatorClientConfig {
            environment: "staging".to_string(),
            issuer: "cinatoken-rust-api-staging".to_string(),
            audience: "cinatoken-drain-source-registration-coordinator-staging".to_string(),
            caller_identity_sha256: digest(40),
            kid: "coordinator-client-v1".to_string(),
            secret: "coordinator-client-fixed-test-secret-v1".to_string(),
        };
        let identity = identity();
        let object_name = derive_coordinator_object_name_v1(&identity).unwrap();
        let body = canonical_json_bytes(&StatusRequestV1 {
            command: "status".to_string(),
            identity,
            request_id_sha256: digest(41),
        })
        .unwrap();
        let token = sign_authority(
            &config,
            STATUS_PATH,
            &object_name,
            &digest(41),
            &sha256_hex_bytes(&body),
            2_100_000_000,
        )
        .unwrap();
        assert_eq!(token.split('.').count(), 3);
        assert_eq!(
            sha256_hex_bytes(token.as_bytes()),
            "458a0b9e229f9a36c27841c61c2f4cdcd34912c7f28c933c2154b880da2191ec"
        );
        assert_ne!(
            token,
            sign_authority(
                &config,
                BEGIN_PATH,
                &object_name,
                &digest(41),
                &sha256_hex_bytes(&body),
                2_100_000_000,
            )
            .unwrap()
        );
    }

    #[test]
    fn status_validation_fails_closed_on_generation_phase_and_outcome_drift() {
        let identity = identity();
        let request_id = digest(42);
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            0,
            CoordinatorPhase::ChallengeIssued,
            None,
        );
        let valid = status_response(CoordinatorPhase::ChallengeIssued, 1);
        assert!(validate_status_response(BEGIN_PATH, 201, metadata, &valid).is_ok());

        let mut drifted = valid.clone();
        drifted.generation = 2;
        assert_eq!(
            validate_status_response(BEGIN_PATH, 201, metadata, &drifted),
            Err(CoordinatorClientError::Response)
        );

        let mut drifted = valid.clone();
        drifted.phase = CoordinatorPhase::Applied;
        drifted.terminal = true;
        assert_eq!(
            validate_status_response(BEGIN_PATH, 201, metadata, &drifted),
            Err(CoordinatorClientError::Response)
        );

        let mut pending = status_response(CoordinatorPhase::RecoveryPending, 7);
        pending.outcome = None;
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            6,
            CoordinatorPhase::RecoveryPending,
            None,
        );
        assert_eq!(
            validate_status_response(FINISH_PATH, 202, metadata, &pending),
            Err(CoordinatorClientError::Response)
        );
    }

    #[test]
    fn client_contract_is_route_free_bounded_and_fail_closed() {
        assert_eq!(
            COORDINATOR_SERVICE_BINDING,
            "DRAIN_SOURCE_REGISTRATION_COORDINATOR"
        );
        assert_eq!(CLIENT_TIMEOUT, Duration::from_secs(3));
        assert!(MAX_RESPONSE_BYTES <= 8 * 1024);
        assert!(MAX_JSON_BODY_BYTES <= 16 * 1024);
        assert_eq!(
            CoordinatorClientError::Disabled.code(),
            "coordinator_client_disabled"
        );
        assert!(!valid_identifier(""));
        assert!(!valid_sha256(&"A".repeat(64)));
        assert!(!valid_error_code("secret detail"));
        assert_eq!(
            CoordinatorClientError::Timeout.class(),
            CoordinatorClientFailureClass::Indeterminate
        );
        assert_eq!(
            CoordinatorClientError::Response.class(),
            CoordinatorClientFailureClass::ProtocolViolation
        );
        assert_eq!(
            CoordinatorClientError::Rejected {
                status: 503,
                code: "coordinator_unavailable".to_string(),
            }
            .class(),
            CoordinatorClientFailureClass::Indeterminate
        );
    }

    #[test]
    fn conflict_and_expiry_error_bodies_are_rejections_not_malformed_state() {
        let identity = identity();
        let request_id = digest(43);
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            1,
            CoordinatorPhase::FinishClaimed,
            None,
        );
        for (status, code) in [
            (409, "coordinator_state_conflict"),
            (410, "coordinator_expired"),
        ] {
            let body = canonical_json_bytes(&CoordinatorErrorResponseV1 {
                code: code.to_string(),
                contract_version: 1,
            })
            .unwrap();
            assert_eq!(
                decode_response_body(FINISH_PATH, status, metadata, &body),
                Err(CoordinatorClientError::Rejected {
                    status,
                    code: code.to_string(),
                })
            );
        }
    }

    #[test]
    fn malformed_state_on_a_success_status_fails_closed() {
        let identity = identity();
        let request_id = digest(44);
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            0,
            CoordinatorPhase::ChallengeIssued,
            None,
        );
        assert_eq!(
            decode_response_body(BEGIN_PATH, 201, metadata, br#"{"contract_version":1}"#),
            Err(CoordinatorClientError::Response)
        );
    }

    #[test]
    fn historical_exact_replay_accepts_only_reachable_current_state() {
        let identity = identity();
        let request_id = digest(45);
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            0,
            CoordinatorPhase::ChallengeIssued,
            None,
        );
        let mut terminal = status_response(CoordinatorPhase::Applied, 7);
        terminal.replayed = true;
        assert!(validate_status_response(BEGIN_PATH, 200, metadata, &terminal).is_ok());

        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            5,
            CoordinatorPhase::CommitAttempted,
            None,
        );
        let mut impossible = status_response(CoordinatorPhase::Expired, 6);
        impossible.replayed = true;
        assert_eq!(
            validate_status_response(FINISH_PATH, 410, metadata, &impossible),
            Err(CoordinatorClientError::Response)
        );
    }

    #[test]
    fn canonical_response_and_terminal_winner_rules_fail_closed() {
        let identity = identity();
        let request_id = digest(46);
        let command_id = digest(22);
        let metadata = RequestMetadata::mutation(
            &identity,
            &request_id,
            6,
            CoordinatorPhase::Applied,
            Some(&command_id),
        );
        let valid = status_response(CoordinatorPhase::Applied, 7);
        assert!(validate_status_response(FINISH_PATH, 200, metadata, &valid).is_ok());

        let mut invalid = valid.clone();
        invalid.outcome.as_mut().unwrap().winner_command_id_sha256 = None;
        assert_eq!(
            validate_status_response(FINISH_PATH, 200, metadata, &invalid),
            Err(CoordinatorClientError::Response)
        );

        let pretty = serde_json::to_vec_pretty(&valid).unwrap();
        assert_eq!(
            decode_response_body(FINISH_PATH, 200, metadata, &pretty),
            Err(CoordinatorClientError::Response)
        );
        assert!(valid_json_content_type("application/json; charset=utf-8"));
        assert!(!valid_json_content_type("application/json-seq"));
        assert!(!valid_json_content_type("application/json; profile=v1"));
    }
}
