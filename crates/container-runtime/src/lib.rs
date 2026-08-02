use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt,
    fs::File,
    io::Read,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Bytes,
    extract::State,
    extract::{rejection::BytesRejection, DefaultBodyLimit},
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod client;

use client::{ExecutionError, ExecutionOutcome, InternalProviderClient, OperationExecutor};

#[cfg(target_os = "linux")]
mod attestation;

pub const DEFAULT_PORT: u16 = 8080;
pub const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
pub const MAX_EXECUTION_WINDOW_SECONDS: u64 = 300;
pub const CONTAINER_PROTOCOL_HEADER: &str = "x-cinatoken-container-protocol";
pub const EXECUTION_NOT_ENABLED_CODE: &str = "execution_not_enabled";
pub const AMBIGUOUS_EXECUTION_CODE: &str = "ambiguous_execution";
pub const PROVIDER_INPUT_UNAVAILABLE_CODE: &str = "provider_input_unavailable";
pub const INTERPRETED_PROVIDER_REJECTION_STATUS: StatusCode = StatusCode::UNPROCESSABLE_ENTITY;

pub const PROTOCOL_VERSION: u32 = 1;
pub const SHARD_CONTRACT_VERSION: u32 = 1;
const SHARD_INSTANCE_PREFIX: &str = "cinatoken-relay-shard-v1";
const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_OPERATION_KIND_BYTES: usize = 64;
const MAX_PROVIDER_OPERATION_ID_BYTES: usize = 128;
const MAX_TRACE_ID_BYTES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CONTENT_TYPE_BYTES: usize = 255;
const MAX_OBJECT_KEY_BYTES: usize = 1_024;
const MAX_OBJECT_VERSION_BYTES: usize = 256;
const MAX_RESPONSE_ARTIFACT_OBJECT_VERSION_BYTES: usize = 128;
const MAX_REQUEST_CONTENT_TYPE_BYTES: usize = 128;
const MIN_REQUEST_OBJECT_KEY_BYTES: usize = 8;
const MAX_REQUEST_OBJECT_KEY_BYTES: usize = 512;
const MAX_REQUEST_OBJECT_VERSION_BYTES: usize = 128;
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CLIENT_RESPONSE_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CONTAINER_SHARDS: u16 = 1_024;
static RUNTIME_BUILD_ID: OnceLock<Result<String, String>> = OnceLock::new();

#[cfg(target_os = "linux")]
pub fn runtime_process_attestation() -> std::io::Result<serde_json::Value> {
    attestation::collect_runtime_attestation()
}

pub fn app() -> Router {
    let _ = runtime_build_id();
    let execution_enabled = env::var("CINATOKEN_CONTAINER_PROVIDER_CLIENT_ENABLED")
        .ok()
        .is_some_and(|value| value == "true");
    app_with_state(AppState {
        executor: Arc::new(InternalProviderClient::new()),
        execution_enabled,
    })
}

fn app_with_state(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/operations", post(operations))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state)
}

#[derive(Clone)]
struct AppState {
    executor: Arc<dyn OperationExecutor>,
    execution_enabled: bool,
}

pub fn container_port() -> Result<u16, PortConfigError> {
    match env::var_os("CINATOKEN_CONTAINER_PORT") {
        Some(value) => parse_port(value),
        None => Ok(DEFAULT_PORT),
    }
}

fn parse_port(value: OsString) -> Result<u16, PortConfigError> {
    let value = value.into_string().map_err(|_| PortConfigError)?;
    let port = value.parse::<u16>().map_err(|_| PortConfigError)?;
    if port == 0 {
        return Err(PortConfigError);
    }
    Ok(port)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortConfigError;

impl fmt::Display for PortConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CINATOKEN_CONTAINER_PORT must be an integer from 1 through 65535")
    }
}

impl Error for PortConfigError {}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn readyz(State(state): State<AppState>) -> Response {
    let Ok(runtime_build_id) = runtime_build_id() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_build_id_unavailable",
            "runtime build identity is unavailable",
        );
    };
    Json(ReadinessResponse {
        status: "ready",
        protocol_version: PROTOCOL_VERSION,
        shard_contract_version: SHARD_CONTRACT_VERSION,
        runtime_build_id,
        execution_enabled: state.execution_enabled,
    })
    .into_response()
}

fn runtime_build_id() -> Result<&'static str, &'static str> {
    RUNTIME_BUILD_ID
        .get_or_init(compute_runtime_build_id)
        .as_deref()
        .map_err(String::as_str)
}

fn compute_runtime_build_id() -> Result<String, String> {
    let executable = env::current_exe()
        .map_err(|_| "container runtime executable path is unavailable".to_string())?;
    let mut file = File::open(executable)
        .map_err(|_| "container runtime executable is unreadable".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "container runtime executable read failed".to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn operations(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_body_too_large",
                "request body exceeds 65536 bytes",
            );
        }
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_request_body",
                "request body could not be read",
            );
        }
    };

    if headers
        .get(CONTAINER_PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return error_response(
            StatusCode::UPGRADE_REQUIRED,
            "invalid_container_protocol",
            "x-cinatoken-container-protocol must be 1",
        );
    }

    if !has_json_content_type(&headers) {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "content-type must be application/json",
        );
    }

    let envelope = match serde_json::from_slice::<OperationEnvelope>(&body) {
        Ok(envelope) => envelope,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_operation_envelope",
                "request body must match the operation envelope",
            );
        }
    };

    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "clock_unavailable",
                "system clock is before the Unix epoch",
            );
        }
    };

    if let Err(error) = envelope.validate(now) {
        return error_response(StatusCode::BAD_REQUEST, error.code, error.message);
    }

    if envelope.operation_kind == "health_probe" {
        return (
            StatusCode::OK,
            Json(OperationResponse::completed(
                envelope.operation_id,
                envelope.trace_id,
            )),
        )
            .into_response();
    }
    if !state.execution_enabled || envelope.operation_kind != client::PROVIDER_CANARY_OPERATION_KIND
    {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(OperationResponse::rejected_execution_not_enabled(
                envelope.operation_id,
                envelope.trace_id,
            )),
        )
            .into_response();
    }

    match state.executor.execute(&envelope).await {
        Ok(ExecutionOutcome::Completed(result)) => (
            StatusCode::OK,
            Json(OperationResponse::completed_with_result(
                envelope.operation_id,
                envelope.trace_id,
                result,
            )),
        )
            .into_response(),
        Ok(ExecutionOutcome::Rejected(rejected)) => (
            INTERPRETED_PROVIDER_REJECTION_STATUS,
            Json(OperationResponse::rejected_provider_response(
                envelope.operation_id,
                envelope.trace_id,
                rejected,
            )),
        )
            .into_response(),
        Ok(ExecutionOutcome::RecoveryRequired) | Err(ExecutionError::Ambiguous) => (
            StatusCode::ACCEPTED,
            Json(
                OperationResponse::recovery_required_for_ambiguous_execution(
                    envelope.operation_id,
                    envelope.trace_id,
                ),
            ),
        )
            .into_response(),
        Err(ExecutionError::InputUnavailable) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(OperationResponse::rejected(
                envelope.operation_id,
                envelope.trace_id,
                PROVIDER_INPUT_UNAVAILABLE_CODE,
            )),
        )
            .into_response(),
    }
}

fn has_json_content_type(headers: &HeaderMap) -> bool {
    let Some(value) = headers.get(CONTENT_TYPE) else {
        return false;
    };
    let Ok(value) = value.to_str() else {
        return false;
    };
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = essence.split_once('/') else {
        return false;
    };
    kind.eq_ignore_ascii_case("application")
        && (subtype.eq_ignore_ascii_case("json") || subtype.to_ascii_lowercase().ends_with("+json"))
}

fn error_response(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (status, Json(ErrorResponse { code, message })).into_response()
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ReadinessResponse {
    status: &'static str,
    protocol_version: u32,
    shard_contract_version: u32,
    runtime_build_id: &'static str,
    execution_enabled: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutcomeStatus {
    Completed,
    Rejected,
    RecoveryRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderResponseClassification {
    TypedError,
    HttpError,
    InvalidBody,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRejectedOutcome {
    pub classification: ProviderResponseClassification,
    pub provider_status: u16,
    pub client_status: u16,
    pub code: String,
    pub client_artifact: ClientResponseArtifactManifest,
}

impl ProviderRejectedOutcome {
    fn statuses_match(&self) -> bool {
        match self.classification {
            ProviderResponseClassification::TypedError => {
                self.provider_status == 200 && self.client_status == 200
            }
            ProviderResponseClassification::HttpError => {
                self.provider_status != 200 && self.client_status == self.provider_status
            }
            ProviderResponseClassification::InvalidBody => {
                self.provider_status == 200 && self.client_status == 500
            }
        }
    }

    fn valid(&self, operation_id: &str, owner_generation: u64) -> bool {
        self.statuses_match()
            && valid_outcome_code(&self.code)
            && self
                .client_artifact
                .matches_operation(operation_id, owner_generation)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperationResultManifest {
    object_key: String,
    object_version: String,
    sha256: String,
    size: u64,
    content_type: String,
}

impl OperationResultManifest {
    pub fn try_new(
        object_key: String,
        object_version: String,
        sha256: String,
        size: u64,
        content_type: String,
    ) -> Result<Self, ResultManifestError> {
        validate_result_object_key(&object_key).map_err(ResultManifestError::from)?;
        validate_identifier(
            &object_version,
            MAX_OBJECT_VERSION_BYTES,
            "invalid_result_object_version",
            "result object_version must be a bounded ASCII identifier",
        )
        .map_err(ResultManifestError::from)?;
        validate_sha256(&sha256, "invalid_result_sha256").map_err(ResultManifestError::from)?;
        if size > MAX_INPUT_BYTES {
            return Err(ResultManifestError::new(
                "invalid_result_size",
                "result size exceeds the 64 MiB operation limit",
            ));
        }
        validate_visible_ascii(
            &content_type,
            MAX_CONTENT_TYPE_BYTES,
            "invalid_result_content_type",
            "result content_type must be bounded visible ASCII",
            true,
        )
        .map_err(ResultManifestError::from)?;
        if !valid_content_type(&content_type) {
            return Err(ResultManifestError::new(
                "invalid_result_content_type",
                "result content_type must be a valid bounded media type",
            ));
        }

        Ok(Self {
            object_key,
            object_version,
            sha256,
            size,
            content_type,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationResultManifestWire {
    object_key: String,
    object_version: String,
    sha256: String,
    size: u64,
    content_type: String,
}

impl<'de> Deserialize<'de> for OperationResultManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = OperationResultManifestWire::deserialize(deserializer)?;
        Self::try_new(
            wire.object_key,
            wire.object_version,
            wire.sha256,
            wire.size,
            wire.content_type,
        )
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResultManifestError {
    code: &'static str,
    message: &'static str,
}

impl ResultManifestError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl From<ValidationError> for ResultManifestError {
    fn from(error: ValidationError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl fmt::Display for ResultManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for ResultManifestError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientResponseArtifactManifest {
    object_key: String,
    object_version: String,
    client_response_artifact_sha256: String,
    sha256: String,
    size: u64,
    content_type: String,
}

impl ClientResponseArtifactManifest {
    pub fn try_new(
        object_key: String,
        object_version: String,
        client_response_artifact_sha256: String,
        sha256: String,
        size: u64,
        content_type: String,
    ) -> Result<Self, ResultManifestError> {
        validate_client_artifact_object_key(&object_key).map_err(ResultManifestError::from)?;
        validate_identifier(
            &object_version,
            MAX_RESPONSE_ARTIFACT_OBJECT_VERSION_BYTES,
            "invalid_client_artifact_object_version",
            "client artifact object_version must be a bounded ASCII identifier",
        )
        .map_err(ResultManifestError::from)?;
        validate_sha256(
            &client_response_artifact_sha256,
            "invalid_client_response_artifact_sha256",
        )
        .map_err(ResultManifestError::from)?;
        validate_sha256(&sha256, "invalid_client_artifact_sha256")
            .map_err(ResultManifestError::from)?;
        if !(2..=MAX_CLIENT_RESPONSE_ARTIFACT_BYTES).contains(&size) {
            return Err(ResultManifestError::new(
                "invalid_client_artifact_size",
                "client artifact size must be between 2 bytes and 4 MiB",
            ));
        }
        if content_type != "application/json" {
            return Err(ResultManifestError::new(
                "invalid_client_artifact_content_type",
                "client artifact content_type must be application/json",
            ));
        }
        Ok(Self {
            object_key,
            object_version,
            client_response_artifact_sha256,
            sha256,
            size,
            content_type,
        })
    }

    fn matches_operation(&self, operation_id: &str, owner_generation: u64) -> bool {
        self.object_key
            == format!(
                "container-client-artifacts/v1/{operation_id}/{owner_generation}/{}",
                self.client_response_artifact_sha256
            )
    }

    fn matches_operation_prefix(&self, operation_id: &str) -> bool {
        self.object_key
            .strip_prefix(&format!("container-client-artifacts/v1/{operation_id}/"))
            .and_then(|remainder| remainder.split_once('/'))
            .is_some_and(|(owner_generation, digest)| {
                owner_generation.parse::<u64>().is_ok()
                    && digest == self.client_response_artifact_sha256
            })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientResponseArtifactManifestWire {
    object_key: String,
    object_version: String,
    client_response_artifact_sha256: String,
    sha256: String,
    size: u64,
    content_type: String,
}

impl<'de> Deserialize<'de> for ClientResponseArtifactManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ClientResponseArtifactManifestWire::deserialize(deserializer)?;
        Self::try_new(
            wire.object_key,
            wire.object_version,
            wire.client_response_artifact_sha256,
            wire.sha256,
            wire.size,
            wire.content_type,
        )
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperationResponse {
    protocol_version: u32,
    operation_id: String,
    status: OperationOutcomeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<OperationResultManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    classification: Option<ProviderResponseClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_artifact: Option<ClientResponseArtifactManifest>,
    trace_id: String,
}

impl OperationResponse {
    pub fn completed(operation_id: String, trace_id: String) -> Self {
        Self::new(
            operation_id,
            trace_id,
            OperationOutcomeStatus::Completed,
            None,
            None,
        )
    }

    pub fn completed_with_result(
        operation_id: String,
        trace_id: String,
        result: OperationResultManifest,
    ) -> Self {
        Self::new(
            operation_id,
            trace_id,
            OperationOutcomeStatus::Completed,
            None,
            Some(result),
        )
    }

    pub fn rejected_execution_not_enabled(operation_id: String, trace_id: String) -> Self {
        Self::rejected(operation_id, trace_id, EXECUTION_NOT_ENABLED_CODE)
    }

    pub fn rejected(operation_id: String, trace_id: String, code: &str) -> Self {
        Self::new(
            operation_id,
            trace_id,
            OperationOutcomeStatus::Rejected,
            Some(code.to_string()),
            None,
        )
    }

    pub fn rejected_provider_response(
        operation_id: String,
        trace_id: String,
        rejected: ProviderRejectedOutcome,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            operation_id,
            status: OperationOutcomeStatus::Rejected,
            code: Some(rejected.code),
            result: None,
            classification: Some(rejected.classification),
            provider_status: Some(rejected.provider_status),
            client_status: Some(rejected.client_status),
            client_artifact: Some(rejected.client_artifact),
            trace_id,
        }
    }

    pub fn recovery_required_for_ambiguous_execution(
        operation_id: String,
        trace_id: String,
    ) -> Self {
        Self::new(
            operation_id,
            trace_id,
            OperationOutcomeStatus::RecoveryRequired,
            Some(AMBIGUOUS_EXECUTION_CODE.to_string()),
            None,
        )
    }

    fn new(
        operation_id: String,
        trace_id: String,
        status: OperationOutcomeStatus,
        code: Option<String>,
        result: Option<OperationResultManifest>,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            operation_id,
            status,
            code,
            result,
            classification: None,
            provider_status: None,
            client_status: None,
            client_artifact: None,
            trace_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationResponseWire {
    protocol_version: u32,
    operation_id: String,
    status: OperationOutcomeStatus,
    #[serde(default)]
    code: WireField<String>,
    #[serde(default)]
    result: WireField<OperationResultManifest>,
    #[serde(default)]
    classification: WireField<ProviderResponseClassification>,
    #[serde(default)]
    provider_status: WireField<u16>,
    #[serde(default)]
    client_status: WireField<u16>,
    #[serde(default)]
    client_artifact: WireField<ClientResponseArtifactManifest>,
    trace_id: String,
}

#[derive(Debug, Default)]
enum WireField<T> {
    #[default]
    Missing,
    Present(T),
}

impl<'de, T> Deserialize<'de> for WireField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Self::Present)
    }
}

impl<'de> Deserialize<'de> for OperationResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = OperationResponseWire::deserialize(deserializer)?;
        if wire.protocol_version != PROTOCOL_VERSION {
            return Err(serde::de::Error::custom("protocol_version must be 1"));
        }
        validate_identifier(
            &wire.operation_id,
            MAX_OPERATION_ID_BYTES,
            "invalid_operation_id",
            "operation_id must be a bounded ASCII identifier",
        )
        .map_err(|error| serde::de::Error::custom(error.message))?;
        validate_identifier(
            &wire.trace_id,
            MAX_TRACE_ID_BYTES,
            "invalid_trace_id",
            "trace_id must be a bounded ASCII identifier",
        )
        .map_err(|error| serde::de::Error::custom(error.message))?;

        let valid_presence = match (
            &wire.status,
            &wire.code,
            &wire.result,
            &wire.classification,
            &wire.provider_status,
            &wire.client_status,
            &wire.client_artifact,
        ) {
            (
                OperationOutcomeStatus::Completed,
                WireField::Missing,
                _,
                WireField::Missing,
                WireField::Missing,
                WireField::Missing,
                WireField::Missing,
            ) => true,
            (
                OperationOutcomeStatus::Rejected | OperationOutcomeStatus::RecoveryRequired,
                WireField::Present(code),
                WireField::Missing,
                WireField::Missing,
                WireField::Missing,
                WireField::Missing,
                WireField::Missing,
            ) => valid_outcome_code(code),
            (
                OperationOutcomeStatus::Rejected,
                WireField::Present(code),
                WireField::Missing,
                WireField::Present(classification),
                WireField::Present(provider_status),
                WireField::Present(client_status),
                WireField::Present(client_artifact),
            ) => {
                ProviderRejectedOutcome {
                    classification: *classification,
                    provider_status: *provider_status,
                    client_status: *client_status,
                    code: code.clone(),
                    client_artifact: client_artifact.clone(),
                }
                .statuses_match()
                    && valid_outcome_code(code)
                    && client_artifact.matches_operation_prefix(&wire.operation_id)
            }
            _ => false,
        };
        if !valid_presence {
            return Err(serde::de::Error::custom(
                "operation outcome fields do not match status",
            ));
        }

        Ok(Self {
            protocol_version: wire.protocol_version,
            operation_id: wire.operation_id,
            status: wire.status,
            code: match wire.code {
                WireField::Missing => None,
                WireField::Present(code) => Some(code),
            },
            result: match wire.result {
                WireField::Missing => None,
                WireField::Present(result) => Some(result),
            },
            classification: match wire.classification {
                WireField::Missing => None,
                WireField::Present(classification) => Some(classification),
            },
            provider_status: match wire.provider_status {
                WireField::Missing => None,
                WireField::Present(status) => Some(status),
            },
            client_status: match wire.client_status {
                WireField::Missing => None,
                WireField::Present(status) => Some(status),
            },
            client_artifact: match wire.client_artifact {
                WireField::Missing => None,
                WireField::Present(artifact) => Some(artifact),
            },
            trace_id: wire.trace_id,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationEnvelope {
    pub(crate) protocol_version: u32,
    pub(crate) operation_id: String,
    pub(crate) operation_kind: String,
    pub(crate) owner_generation: u64,
    pub(crate) owner_lease_expires_at: u64,
    pub(crate) execution_deadline_at: u64,
    pub(crate) provider_operation_id: String,
    pub(crate) admission_sha256: String,
    pub(crate) input: OperationInput,
    pub(crate) shard: OperationShard,
    pub(crate) trace_id: String,
}

impl OperationEnvelope {
    fn validate(&self, now: u64) -> Result<(), ValidationError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ValidationError::new(
                "invalid_protocol_version",
                "protocol_version must be 1",
            ));
        }
        validate_controller_identifier(
            &self.operation_id,
            MAX_OPERATION_ID_BYTES,
            "invalid_operation_id",
            "operation_id must be a bounded ASCII identifier",
        )?;
        validate_operation_kind(&self.operation_kind)?;
        if !is_positive_safe_integer(self.owner_generation) {
            return Err(ValidationError::new(
                "invalid_owner_generation",
                "owner_generation must be a positive JavaScript safe integer",
            ));
        }
        if !is_positive_safe_integer(self.owner_lease_expires_at)
            || !is_positive_safe_integer(self.execution_deadline_at)
            || !(now < self.execution_deadline_at
                && self.execution_deadline_at <= self.owner_lease_expires_at
                && self.execution_deadline_at <= now.saturating_add(MAX_EXECUTION_WINDOW_SECONDS))
        {
            return Err(ValidationError::new(
                "invalid_execution_deadline",
                "execution deadline must be in the future and no later than the owner lease",
            ));
        }
        validate_controller_identifier(
            &self.provider_operation_id,
            MAX_PROVIDER_OPERATION_ID_BYTES,
            "invalid_provider_operation_id",
            "provider_operation_id must be a bounded ASCII identifier",
        )?;
        validate_sha256(&self.admission_sha256, "invalid_admission_sha256")?;
        self.input.validate()?;
        self.shard.validate()?;
        validate_controller_identifier(
            &self.trace_id,
            MAX_TRACE_ID_BYTES,
            "invalid_trace_id",
            "trace_id must be a bounded ASCII identifier",
        )
    }
}

#[derive(Debug)]
pub(crate) struct OperationInput {
    pub(crate) mode: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
    pub(crate) content_type: String,
    pub(crate) request_object_key: Option<String>,
    pub(crate) object_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationInputWire {
    mode: String,
    sha256: String,
    size: u64,
    content_type: String,
    #[serde(default)]
    request_object_key: WireField<String>,
    #[serde(default)]
    object_version: WireField<String>,
}

impl<'de> Deserialize<'de> for OperationInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = OperationInputWire::deserialize(deserializer)?;
        Ok(Self {
            mode: wire.mode,
            sha256: wire.sha256,
            size: wire.size,
            content_type: wire.content_type,
            request_object_key: match wire.request_object_key {
                WireField::Missing => None,
                WireField::Present(value) => Some(value),
            },
            object_version: match wire.object_version {
                WireField::Missing => None,
                WireField::Present(value) => Some(value),
            },
        })
    }
}

impl OperationInput {
    fn validate(&self) -> Result<(), ValidationError> {
        validate_sha256(&self.sha256, "invalid_input_sha256")?;
        if self.size > MAX_INPUT_BYTES {
            return Err(ValidationError::new(
                "invalid_input_size",
                "input size exceeds the 64 MiB operation limit",
            ));
        }
        validate_visible_ascii(
            &self.content_type,
            MAX_REQUEST_CONTENT_TYPE_BYTES,
            "invalid_input_content_type",
            "input content_type must be bounded visible ASCII",
            true,
        )?;
        if !valid_content_type(&self.content_type) {
            return Err(ValidationError::new(
                "invalid_input_content_type",
                "input content_type must be a valid bounded media type",
            ));
        }

        match self.mode.as_str() {
            "inline" if self.request_object_key.is_none() && self.object_version.is_none() => {}
            "r2" => {
                let key = self.request_object_key.as_deref().ok_or_else(|| {
                    ValidationError::new(
                        "invalid_input_references",
                        "r2 input requires request_object_key and object_version",
                    )
                })?;
                let version = self.object_version.as_deref().ok_or_else(|| {
                    ValidationError::new(
                        "invalid_input_references",
                        "r2 input requires request_object_key and object_version",
                    )
                })?;
                validate_request_object_key(key)?;
                validate_controller_identifier(
                    version,
                    MAX_REQUEST_OBJECT_VERSION_BYTES,
                    "invalid_object_version",
                    "object_version must be a bounded ASCII identifier",
                )?;
            }
            "inline" => {
                return Err(ValidationError::new(
                    "invalid_input_references",
                    "inline input must not include object references",
                ));
            }
            _ => {
                return Err(ValidationError::new(
                    "invalid_input_mode",
                    "input mode must be inline or r2",
                ));
            }
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationShard {
    pub(crate) contract_version: u32,
    pub(crate) ring_generation: u64,
    pub(crate) shard_count: u16,
    pub(crate) shard_index: u16,
    pub(crate) instance_name: String,
}

impl OperationShard {
    fn validate(&self) -> Result<(), ValidationError> {
        if self.contract_version != SHARD_CONTRACT_VERSION {
            return Err(ValidationError::new(
                "invalid_shard_contract_version",
                "shard contract_version must be 1",
            ));
        }
        if !is_positive_safe_integer(self.ring_generation)
            || self.shard_count == 0
            || self.shard_count > MAX_CONTAINER_SHARDS
        {
            return Err(ValidationError::new(
                "invalid_shard_topology",
                "ring_generation and shard_count must be positive",
            ));
        }
        if self.shard_index >= self.shard_count {
            return Err(ValidationError::new(
                "invalid_shard_topology",
                "shard_index must be less than shard_count",
            ));
        }
        let expected = format!("{SHARD_INSTANCE_PREFIX}-{:04}", self.shard_index);
        if self.instance_name != expected {
            return Err(ValidationError::new(
                "invalid_shard_instance_name",
                "shard instance_name is not canonical",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ValidationError {
    code: &'static str,
    message: &'static str,
}

impl ValidationError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

fn validate_identifier(
    value: &str,
    max_bytes: usize,
    code: &'static str,
    message: &'static str,
) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/' | b'@')
        })
    {
        return Err(ValidationError::new(code, message));
    }
    Ok(())
}

fn validate_controller_identifier(
    value: &str,
    max_bytes: usize,
    code: &'static str,
    message: &'static str,
) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ValidationError::new(code, message));
    }
    Ok(())
}

const fn is_positive_safe_integer(value: u64) -> bool {
    value > 0 && value <= MAX_SAFE_INTEGER
}

fn validate_operation_kind(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > MAX_OPERATION_KIND_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b':' | b'-')
        })
    {
        return Err(ValidationError::new(
            "invalid_operation_kind",
            "operation_kind must be a bounded lowercase ASCII identifier",
        ));
    }
    Ok(())
}

fn validate_request_object_key(value: &str) -> Result<(), ValidationError> {
    if value.len() < MIN_REQUEST_OBJECT_KEY_BYTES
        || value.len() > MAX_REQUEST_OBJECT_KEY_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b':' | b'-')
        })
    {
        return Err(ValidationError::new(
            "invalid_request_object_key",
            "request_object_key must be a bounded storage key",
        ));
    }
    Ok(())
}

fn validate_result_object_key(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > MAX_OBJECT_KEY_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b':' | b'-')
        })
    {
        return Err(ValidationError::new(
            "invalid_result_object_key",
            "result object_key must be a bounded storage key",
        ));
    }
    Ok(())
}

fn validate_client_artifact_object_key(value: &str) -> Result<(), ValidationError> {
    validate_result_object_key(value)?;
    if !value.starts_with("container-client-artifacts/v1/") {
        return Err(ValidationError::new(
            "invalid_client_artifact_object_key",
            "client artifact object_key must use the v1 client artifact namespace",
        ));
    }
    Ok(())
}

fn valid_outcome_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATION_KIND_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn valid_content_type(value: &str) -> bool {
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = essence.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && kind.bytes().all(valid_media_type_byte)
        && subtype.bytes().all(valid_media_type_byte)
}

fn valid_media_type_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
        )
}

fn validate_visible_ascii(
    value: &str,
    max_bytes: usize,
    code: &'static str,
    message: &'static str,
    allow_space: bool,
) -> Result<(), ValidationError> {
    let minimum = if allow_space { 0x20 } else { 0x21 };
    if value.is_empty()
        || value.len() > max_bytes
        || !value.bytes().all(|byte| (minimum..=0x7e).contains(&byte))
    {
        return Err(ValidationError::new(code, message));
    }
    Ok(())
}

fn validate_sha256(value: &str, code: &'static str) -> Result<(), ValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ValidationError::new(
            code,
            "SHA-256 digests must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::*;

    struct FakeExecutor {
        outcome: Result<ExecutionOutcome, ExecutionError>,
    }

    #[async_trait::async_trait]
    impl OperationExecutor for FakeExecutor {
        async fn execute(
            &self,
            _envelope: &OperationEnvelope,
        ) -> Result<ExecutionOutcome, ExecutionError> {
            match &self.outcome {
                Ok(ExecutionOutcome::Completed(result)) => {
                    Ok(ExecutionOutcome::Completed(result.clone()))
                }
                Ok(ExecutionOutcome::Rejected(rejected)) => {
                    Ok(ExecutionOutcome::Rejected(rejected.clone()))
                }
                Ok(ExecutionOutcome::RecoveryRequired) => Ok(ExecutionOutcome::RecoveryRequired),
                Err(ExecutionError::InputUnavailable) => Err(ExecutionError::InputUnavailable),
                Err(ExecutionError::Ambiguous) => Err(ExecutionError::Ambiguous),
            }
        }
    }

    fn valid_operation(now: u64) -> OperationEnvelope {
        OperationEnvelope {
            protocol_version: 1,
            operation_id: "operation-123".to_string(),
            operation_kind: "health_probe".to_string(),
            owner_generation: 1,
            owner_lease_expires_at: now + 120,
            execution_deadline_at: now + 60,
            provider_operation_id: "provider-operation-123".to_string(),
            admission_sha256: "a".repeat(64),
            input: OperationInput {
                mode: "inline".to_string(),
                sha256: "b".repeat(64),
                size: 0,
                content_type: "application/json".to_string(),
                request_object_key: None,
                object_version: None,
            },
            shard: OperationShard {
                contract_version: 1,
                ring_generation: 1,
                shard_count: 8,
                shard_index: 3,
                instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
            },
            trace_id: "trace-123".to_string(),
        }
    }

    #[derive(Deserialize)]
    struct EnvelopeConformanceSuite {
        schema_version: u32,
        now: u64,
        cases: Vec<EnvelopeConformanceCase>,
    }

    #[derive(Deserialize)]
    struct EnvelopeConformanceCase {
        name: String,
        valid: bool,
        envelope: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ResponseConformanceSuite {
        schema_version: u32,
        envelope: ResponseConformanceEnvelope,
        cases: Vec<ResponseConformanceCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ResponseConformanceEnvelope {
        protocol_version: u32,
        operation_id: String,
        owner_generation: u64,
        trace_id: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ResponseConformanceCase {
        name: String,
        operation_kind: String,
        http_status: u16,
        content_type: String,
        accepted: bool,
        #[serde(default)]
        expected_kind: Option<ResponseConformanceKind>,
        body: serde_json::Value,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum ResponseConformanceKind {
        Outcome,
        ProtocolError,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ResponseConformanceError {
        code: String,
        message: String,
    }

    fn response_conformance_content_type_is_json(content_type: &str) -> bool {
        content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("application/json")
    }

    fn response_conformance_protocol_error_status(status: u16) -> bool {
        matches!(status, 400 | 413 | 415 | 422 | 426 | 500)
    }

    fn classify_response_conformance_case(
        case: &ResponseConformanceCase,
        envelope: &ResponseConformanceEnvelope,
    ) -> Option<ResponseConformanceKind> {
        if !response_conformance_content_type_is_json(&case.content_type) {
            return None;
        }

        if response_conformance_protocol_error_status(case.http_status) {
            let protocol_error =
                serde_json::from_value::<ResponseConformanceError>(case.body.clone()).ok();
            if protocol_error
                .is_some_and(|error| valid_outcome_code(&error.code) && !error.message.is_empty())
            {
                return Some(ResponseConformanceKind::ProtocolError);
            }
        }

        let response = serde_json::from_value::<OperationResponse>(case.body.clone()).ok()?;
        if response.protocol_version != envelope.protocol_version
            || response.operation_id != envelope.operation_id
            || response.trace_id != envelope.trace_id
        {
            return None;
        }

        let status_matches = match response.status {
            OperationOutcomeStatus::Completed => {
                case.http_status == 200
                    && if case.operation_kind == "health_probe" {
                        response.result.is_none()
                    } else {
                        response.result.is_some()
                    }
            }
            OperationOutcomeStatus::RecoveryRequired => case.http_status == 202,
            OperationOutcomeStatus::Rejected => {
                if response.classification.is_some() {
                    case.http_status == 422
                        && response.client_artifact.as_ref().is_some_and(|artifact| {
                            artifact.matches_operation(
                                &envelope.operation_id,
                                envelope.owner_generation,
                            )
                        })
                } else {
                    matches!(case.http_status, 501 | 503)
                }
            }
        };
        status_matches.then_some(ResponseConformanceKind::Outcome)
    }

    #[test]
    fn matches_shared_operation_envelope_conformance_vectors() {
        let suite: EnvelopeConformanceSuite = serde_json::from_str(include_str!(
            "../../../contracts/container-runtime/v1/conformance/operation-envelope-cases.json"
        ))
        .expect("shared operation envelope conformance vectors must be valid JSON");
        assert_eq!(suite.schema_version, 1);

        for case in suite.cases {
            let accepted = serde_json::from_value::<OperationEnvelope>(case.envelope)
                .is_ok_and(|envelope| envelope.validate(suite.now).is_ok());
            assert_eq!(accepted, case.valid, "conformance case {}", case.name);
        }
    }

    #[test]
    fn matches_shared_operation_response_conformance_vectors() {
        let suite: ResponseConformanceSuite = serde_json::from_str(include_str!(
            "../../../contracts/container-runtime/v1/conformance/operation-response-cases.json"
        ))
        .expect("shared operation response conformance vectors must be valid JSON");
        assert_eq!(suite.schema_version, 1);

        for case in suite.cases {
            let actual_kind = classify_response_conformance_case(&case, &suite.envelope);
            assert_eq!(
                actual_kind.is_some(),
                case.accepted,
                "conformance case {} acceptance",
                case.name
            );
            if case.accepted {
                let expected_kind = case.expected_kind.unwrap_or_else(|| {
                    panic!(
                        "accepted conformance case {} must declare expected_kind",
                        case.name
                    )
                });
                assert_eq!(
                    actual_kind,
                    Some(expected_kind),
                    "conformance case {} kind",
                    case.name
                );
            } else {
                assert!(
                    case.expected_kind.is_none(),
                    "rejected conformance case {} must omit expected_kind",
                    case.name
                );
            }
        }
    }

    #[test]
    fn accepts_the_complete_v1_health_probe_envelope() {
        assert_eq!(valid_operation(1_000).validate(1_000), Ok(()));
    }

    #[test]
    fn enforces_protocol_owner_and_deadline_fences() {
        let mut operation = valid_operation(1_000);
        operation.protocol_version = 2;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_protocol_version"
        );

        operation = valid_operation(1_000);
        operation.owner_generation = 0;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_owner_generation"
        );

        operation = valid_operation(1_000);
        operation.execution_deadline_at = 1_000;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_execution_deadline"
        );

        operation = valid_operation(1_000);
        operation.execution_deadline_at = operation.owner_lease_expires_at + 1;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_execution_deadline"
        );

        operation = valid_operation(1_000);
        operation.owner_lease_expires_at = 1_000 + MAX_EXECUTION_WINDOW_SECONDS + 1;
        operation.execution_deadline_at = 1_000 + MAX_EXECUTION_WINDOW_SECONDS + 1;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_execution_deadline"
        );
    }

    #[test]
    fn enforces_digest_and_ascii_identifier_bounds() {
        let mut operation = valid_operation(1_000);
        operation.admission_sha256 = "A".repeat(64);
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_admission_sha256"
        );

        operation = valid_operation(1_000);
        operation.trace_id = "trace with spaces".to_string();
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_trace_id"
        );

        operation = valid_operation(1_000);
        operation.operation_id = "x".repeat(MAX_OPERATION_ID_BYTES + 1);
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_operation_id"
        );
    }

    #[test]
    fn enforces_inline_and_r2_reference_consistency() {
        let mut operation = valid_operation(1_000);
        operation.input.request_object_key = Some("requests/op-123".to_string());
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_input_references"
        );

        operation = valid_operation(1_000);
        operation.input.mode = "r2".to_string();
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_input_references"
        );

        operation.input.request_object_key = Some("requests/op-123".to_string());
        operation.input.object_version = Some("version-1".to_string());
        assert_eq!(operation.validate(1_000), Ok(()));

        operation.input.size = MAX_INPUT_BYTES + 1;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_input_size"
        );
    }

    #[test]
    fn enforces_controller_request_bounds() {
        let mut operation = valid_operation(1_000);
        operation.owner_generation = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_owner_generation"
        );

        operation = valid_operation(1_000);
        operation.input.content_type = format!("application/{}", "a".repeat(117));
        assert_eq!(operation.input.content_type.len(), 129);
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_input_content_type"
        );

        operation = valid_operation(1_000);
        operation.input.mode = "r2".to_string();
        operation.input.request_object_key = Some("short".to_string());
        operation.input.object_version = Some("version-1".to_string());
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_request_object_key"
        );

        operation.input.request_object_key = Some("r".repeat(MAX_REQUEST_OBJECT_KEY_BYTES + 1));
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_request_object_key"
        );

        operation.input.request_object_key = Some("requests/operation-1".to_string());
        operation.input.object_version = Some("v".repeat(MAX_REQUEST_OBJECT_VERSION_BYTES + 1));
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_object_version"
        );

        operation.input.object_version = Some("version/1".to_string());
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_object_version"
        );
    }

    #[test]
    fn enforces_canonical_shard_topology() {
        let mut operation = valid_operation(1_000);
        operation.shard.ring_generation = 0;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_shard_topology"
        );

        operation = valid_operation(1_000);
        operation.shard.shard_index = operation.shard.shard_count;
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_shard_topology"
        );

        operation = valid_operation(1_000);
        operation.shard.instance_name = "cinatoken-relay-shard-v1-3".to_string();
        assert_eq!(
            operation.validate(1_000).unwrap_err().code,
            "invalid_shard_instance_name"
        );
    }

    #[test]
    fn validates_port_values_without_fallback() {
        assert_eq!(parse_port(OsString::from("8081")), Ok(8081));
        for invalid in ["", "0", "65536", " 8080", "not-a-port"] {
            assert_eq!(parse_port(OsString::from(invalid)), Err(PortConfigError));
        }
    }

    fn result_manifest() -> OperationResultManifest {
        OperationResultManifest::try_new(
            "container-results/v1/operation-123/1/result".to_string(),
            "version-123".to_string(),
            "c".repeat(64),
            42,
            "application/json".to_string(),
        )
        .unwrap()
    }

    fn client_artifact_manifest() -> ClientResponseArtifactManifest {
        let artifact_sha256 = "d".repeat(64);
        ClientResponseArtifactManifest::try_new(
            format!("container-client-artifacts/v1/operation-123/2/{artifact_sha256}"),
            "client-artifact-version-123".to_string(),
            artifact_sha256,
            "e".repeat(64),
            128,
            "application/json".to_string(),
        )
        .unwrap()
    }

    fn provider_rejected_outcome() -> ProviderRejectedOutcome {
        ProviderRejectedOutcome {
            classification: ProviderResponseClassification::HttpError,
            provider_status: 202,
            client_status: 202,
            code: "provider_http_error".to_string(),
            client_artifact: client_artifact_manifest(),
        }
    }

    #[test]
    fn serializes_exact_completed_rejected_and_recovery_required_outcomes() {
        let completed = OperationResponse::completed_with_result(
            "operation-123".to_string(),
            "trace-123".to_string(),
            result_manifest(),
        );
        assert_eq!(
            serde_json::to_value(completed).unwrap(),
            serde_json::json!({
                "protocol_version": 1,
                "operation_id": "operation-123",
                "status": "completed",
                "result": {
                    "object_key": "container-results/v1/operation-123/1/result",
                    "object_version": "version-123",
                    "sha256": "c".repeat(64),
                    "size": 42,
                    "content_type": "application/json"
                },
                "trace_id": "trace-123"
            })
        );

        let recovery = OperationResponse::recovery_required_for_ambiguous_execution(
            "operation-123".to_string(),
            "trace-123".to_string(),
        );
        assert_eq!(
            serde_json::to_value(recovery).unwrap(),
            serde_json::json!({
                "protocol_version": 1,
                "operation_id": "operation-123",
                "status": "recovery_required",
                "code": "ambiguous_execution",
                "trace_id": "trace-123"
            })
        );

        let rejected = OperationResponse::rejected_provider_response(
            "operation-123".to_string(),
            "trace-123".to_string(),
            provider_rejected_outcome(),
        );
        assert_eq!(
            serde_json::to_value(rejected).unwrap(),
            serde_json::json!({
                "protocol_version": 1,
                "operation_id": "operation-123",
                "status": "rejected",
                "code": "provider_http_error",
                "classification": "http_error",
                "provider_status": 202,
                "client_status": 202,
                "client_artifact": {
                    "object_key": format!(
                        "container-client-artifacts/v1/operation-123/2/{}",
                        "d".repeat(64)
                    ),
                    "object_version": "client-artifact-version-123",
                    "client_response_artifact_sha256": "d".repeat(64),
                    "sha256": "e".repeat(64),
                    "size": 128,
                    "content_type": "application/json"
                },
                "trace_id": "trace-123"
            })
        );
    }

    #[test]
    fn response_deserialization_denies_unknown_and_invalid_presence() {
        let completed = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "status": "completed",
            "trace_id": "trace-123"
        });
        assert!(serde_json::from_value::<OperationResponse>(completed.clone()).is_ok());

        let mut with_code = completed.clone();
        with_code["code"] = serde_json::json!("unexpected_code");
        assert!(serde_json::from_value::<OperationResponse>(with_code).is_err());

        let mut with_null_result = completed.clone();
        with_null_result["result"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<OperationResponse>(with_null_result).is_err());

        let mut with_unknown = completed;
        with_unknown["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<OperationResponse>(with_unknown).is_err());

        let rejected_without_code = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "status": "rejected",
            "trace_id": "trace-123"
        });
        assert!(serde_json::from_value::<OperationResponse>(rejected_without_code).is_err());

        let rejected_with_result = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "status": "rejected",
            "code": "execution_not_enabled",
            "result": serde_json::to_value(result_manifest()).unwrap(),
            "trace_id": "trace-123"
        });
        assert!(serde_json::from_value::<OperationResponse>(rejected_with_result).is_err());

        let rejected = serde_json::to_value(OperationResponse::rejected_provider_response(
            "operation-123".to_string(),
            "trace-123".to_string(),
            provider_rejected_outcome(),
        ))
        .unwrap();
        assert!(serde_json::from_value::<OperationResponse>(rejected.clone()).is_ok());
        for field in [
            "classification",
            "provider_status",
            "client_status",
            "client_artifact",
        ] {
            let mut incomplete = rejected.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<OperationResponse>(incomplete).is_err());
        }
        let mut accepted_as_success = rejected;
        accepted_as_success["status"] = serde_json::json!("completed");
        accepted_as_success.as_object_mut().unwrap().remove("code");
        assert!(serde_json::from_value::<OperationResponse>(accepted_as_success).is_err());
    }

    #[test]
    fn result_manifest_is_validated_and_denies_unknown_fields() {
        let mut manifest = serde_json::to_value(result_manifest()).unwrap();
        manifest["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<OperationResultManifest>(manifest).is_err());

        let error = OperationResultManifest::try_new(
            "container-results/v1/result".to_string(),
            "version-123".to_string(),
            "C".repeat(64),
            42,
            "application/json".to_string(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "invalid_result_sha256");

        let artifact_digest = "d".repeat(64);
        let artifact_error = ClientResponseArtifactManifest::try_new(
            format!("container-client-artifacts/v1/operation-123/2/{artifact_digest}"),
            "v".repeat(129),
            artifact_digest,
            "e".repeat(64),
            2,
            "application/json".to_string(),
        )
        .unwrap_err();
        assert_eq!(
            artifact_error.code(),
            "invalid_client_artifact_object_version"
        );
    }

    #[tokio::test]
    async fn enabled_canary_returns_only_the_executor_manifest() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let operation = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "operation_kind": client::PROVIDER_CANARY_OPERATION_KIND,
            "owner_generation": 1,
            "owner_lease_expires_at": now + 120,
            "execution_deadline_at": now + 60,
            "provider_operation_id": "provider-operation-123",
            "admission_sha256": "a".repeat(64),
            "input": {
                "mode": "r2",
                "sha256": "b".repeat(64),
                "size": 42,
                "content_type": "application/json",
                "request_object_key": "container-inputs/v1/operation-123/input.json",
                "object_version": "input-version-1"
            },
            "shard": {
                "contract_version": 1,
                "ring_generation": 1,
                "shard_count": 8,
                "shard_index": 3,
                "instance_name": "cinatoken-relay-shard-v1-0003"
            },
            "trace_id": "trace-123"
        });
        let router = app_with_state(AppState {
            executor: Arc::new(FakeExecutor {
                outcome: Ok(ExecutionOutcome::Completed(result_manifest())),
            }),
            execution_enabled: true,
        });
        let response = router
            .oneshot(
                Request::post("/v1/operations")
                    .header(CONTENT_TYPE, "application/json")
                    .header(CONTAINER_PROTOCOL_HEADER, "1")
                    .body(Body::from(operation.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], "completed");
        assert_eq!(value["result"]["object_version"], "version-123");
        assert!(value.get("code").is_none());
    }

    #[tokio::test]
    async fn enabled_canary_returns_a_structured_interpreted_rejection() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let operation = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-123",
            "operation_kind": client::PROVIDER_CANARY_OPERATION_KIND,
            "owner_generation": 2,
            "owner_lease_expires_at": now + 120,
            "execution_deadline_at": now + 60,
            "provider_operation_id": "provider-operation-123",
            "admission_sha256": "a".repeat(64),
            "input": {
                "mode": "r2",
                "sha256": "b".repeat(64),
                "size": 42,
                "content_type": "application/json",
                "request_object_key": "container-inputs/v1/operation-123/input.json",
                "object_version": "input-version-1"
            },
            "shard": {
                "contract_version": 1,
                "ring_generation": 1,
                "shard_count": 8,
                "shard_index": 3,
                "instance_name": "cinatoken-relay-shard-v1-0003"
            },
            "trace_id": "trace-123"
        });
        let router = app_with_state(AppState {
            executor: Arc::new(FakeExecutor {
                outcome: Ok(ExecutionOutcome::Rejected(provider_rejected_outcome())),
            }),
            execution_enabled: true,
        });
        let response = router
            .oneshot(
                Request::post("/v1/operations")
                    .header(CONTENT_TYPE, "application/json")
                    .header(CONTAINER_PROTOCOL_HEADER, "1")
                    .body(Body::from(operation.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), INTERPRETED_PROVIDER_REJECTION_STATUS);
        let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], "rejected");
        assert_eq!(value["classification"], "http_error");
        assert_eq!(value["provider_status"], 202);
        assert_eq!(value["client_status"], 202);
        assert!(value.get("result").is_none());
    }

    #[tokio::test]
    async fn enabled_canary_converts_unknown_execution_into_recovery() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let operation = serde_json::json!({
            "protocol_version": 1,
            "operation_id": "operation-ambiguous",
            "operation_kind": client::PROVIDER_CANARY_OPERATION_KIND,
            "owner_generation": 1,
            "owner_lease_expires_at": now + 120,
            "execution_deadline_at": now + 60,
            "provider_operation_id": "provider-operation-ambiguous",
            "admission_sha256": "a".repeat(64),
            "input": {
                "mode": "r2",
                "sha256": "b".repeat(64),
                "size": 42,
                "content_type": "application/json",
                "request_object_key": "container-inputs/v1/operation-ambiguous/input.json",
                "object_version": "input-version-1"
            },
            "shard": {
                "contract_version": 1,
                "ring_generation": 1,
                "shard_count": 8,
                "shard_index": 3,
                "instance_name": "cinatoken-relay-shard-v1-0003"
            },
            "trace_id": "trace-ambiguous"
        });
        let router = app_with_state(AppState {
            executor: Arc::new(FakeExecutor {
                outcome: Err(ExecutionError::Ambiguous),
            }),
            execution_enabled: true,
        });
        let response = router
            .oneshot(
                Request::post("/v1/operations")
                    .header(CONTENT_TYPE, "application/json")
                    .header(CONTAINER_PROTOCOL_HEADER, "1")
                    .body(Body::from(operation.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], "recovery_required");
        assert_eq!(value["code"], AMBIGUOUS_EXECUTION_CODE);
    }
}
