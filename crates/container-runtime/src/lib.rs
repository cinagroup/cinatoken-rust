use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Bytes,
    extract::{rejection::BytesRejection, DefaultBodyLimit},
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 8080;
pub const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
pub const MAX_EXECUTION_WINDOW_SECONDS: u64 = 300;
pub const CONTAINER_PROTOCOL_HEADER: &str = "x-cinatoken-container-protocol";
pub const EXECUTION_NOT_ENABLED_CODE: &str = "execution_not_enabled";
pub const AMBIGUOUS_EXECUTION_CODE: &str = "ambiguous_execution";

pub const PROTOCOL_VERSION: u32 = 1;
pub const SHARD_CONTRACT_VERSION: u32 = 1;
const SHARD_INSTANCE_PREFIX: &str = "cinatoken-relay-shard-v1";
const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_OPERATION_KIND_BYTES: usize = 64;
const MAX_PROVIDER_OPERATION_ID_BYTES: usize = 128;
const MAX_TRACE_ID_BYTES: usize = 128;
const MAX_CONTENT_TYPE_BYTES: usize = 255;
const MAX_OBJECT_KEY_BYTES: usize = 1_024;
const MAX_OBJECT_VERSION_BYTES: usize = 256;
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONTAINER_SHARDS: u16 = 1_024;

pub fn app() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/operations", post(operations))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
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

async fn readyz() -> Json<ReadinessResponse> {
    Json(ReadinessResponse {
        status: "ready",
        protocol_version: PROTOCOL_VERSION,
        shard_contract_version: SHARD_CONTRACT_VERSION,
        execution_enabled: false,
    })
}

async fn operations(headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> Response {
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

    let completed = envelope.operation_kind == "health_probe";
    let response = if completed {
        OperationResponse::completed(envelope.operation_id, envelope.trace_id)
    } else {
        OperationResponse::rejected_execution_not_enabled(envelope.operation_id, envelope.trace_id)
    };

    if completed {
        (StatusCode::OK, Json(response)).into_response()
    } else {
        (StatusCode::NOT_IMPLEMENTED, Json(response)).into_response()
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
pub struct OperationResponse {
    protocol_version: u32,
    operation_id: String,
    status: OperationOutcomeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<OperationResultManifest>,
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
        Self::new(
            operation_id,
            trace_id,
            OperationOutcomeStatus::Rejected,
            Some(EXECUTION_NOT_ENABLED_CODE.to_string()),
            None,
        )
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
    trace_id: String,
}

#[derive(Debug)]
enum WireField<T> {
    Missing,
    Present(T),
}

impl<T> Default for WireField<T> {
    fn default() -> Self {
        Self::Missing
    }
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

        let valid_presence = match (&wire.status, &wire.code, &wire.result) {
            (OperationOutcomeStatus::Completed, WireField::Missing, _) => true,
            (
                OperationOutcomeStatus::Rejected | OperationOutcomeStatus::RecoveryRequired,
                WireField::Present(code),
                WireField::Missing,
            ) => valid_outcome_code(code),
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
            trace_id: wire.trace_id,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationEnvelope {
    protocol_version: u32,
    operation_id: String,
    operation_kind: String,
    owner_generation: u64,
    owner_lease_expires_at: u64,
    execution_deadline_at: u64,
    provider_operation_id: String,
    admission_sha256: String,
    input: OperationInput,
    shard: OperationShard,
    trace_id: String,
}

impl OperationEnvelope {
    fn validate(&self, now: u64) -> Result<(), ValidationError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ValidationError::new(
                "invalid_protocol_version",
                "protocol_version must be 1",
            ));
        }
        validate_identifier(
            &self.operation_id,
            MAX_OPERATION_ID_BYTES,
            "invalid_operation_id",
            "operation_id must be a bounded ASCII identifier",
        )?;
        validate_operation_kind(&self.operation_kind)?;
        if self.owner_generation == 0 {
            return Err(ValidationError::new(
                "invalid_owner_generation",
                "owner_generation must be positive",
            ));
        }
        if !(now < self.execution_deadline_at
            && self.execution_deadline_at <= self.owner_lease_expires_at
            && self.execution_deadline_at <= now.saturating_add(MAX_EXECUTION_WINDOW_SECONDS))
        {
            return Err(ValidationError::new(
                "invalid_execution_deadline",
                "execution deadline must be in the future and no later than the owner lease",
            ));
        }
        validate_identifier(
            &self.provider_operation_id,
            MAX_PROVIDER_OPERATION_ID_BYTES,
            "invalid_provider_operation_id",
            "provider_operation_id must be a bounded ASCII identifier",
        )?;
        validate_sha256(&self.admission_sha256, "invalid_admission_sha256")?;
        self.input.validate()?;
        self.shard.validate()?;
        validate_identifier(
            &self.trace_id,
            MAX_TRACE_ID_BYTES,
            "invalid_trace_id",
            "trace_id must be a bounded ASCII identifier",
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationInput {
    mode: String,
    sha256: String,
    size: u64,
    content_type: String,
    request_object_key: Option<String>,
    object_version: Option<String>,
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
            MAX_CONTENT_TYPE_BYTES,
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
                validate_object_key(key)?;
                validate_identifier(
                    version,
                    MAX_OBJECT_VERSION_BYTES,
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
struct OperationShard {
    contract_version: u32,
    ring_generation: u64,
    shard_count: u16,
    shard_index: u16,
    instance_name: String,
}

impl OperationShard {
    fn validate(&self) -> Result<(), ValidationError> {
        if self.contract_version != SHARD_CONTRACT_VERSION {
            return Err(ValidationError::new(
                "invalid_shard_contract_version",
                "shard contract_version must be 1",
            ));
        }
        if self.ring_generation == 0
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

fn validate_object_key(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > MAX_OBJECT_KEY_BYTES
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
    use super::*;

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

    #[test]
    fn serializes_exact_completed_and_recovery_required_outcomes() {
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
    }
}
