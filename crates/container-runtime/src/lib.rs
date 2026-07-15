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

const PROTOCOL_VERSION: u32 = 1;
const SHARD_CONTRACT_VERSION: u32 = 1;
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

async fn readyz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ready" })
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

    let accepted = envelope.operation_kind == "health_probe";
    let response = OperationResponse {
        protocol_version: PROTOCOL_VERSION,
        operation_id: envelope.operation_id,
        status: if accepted { "accepted" } else { "rejected" },
        code: (!accepted).then_some("execution_not_enabled"),
        trace_id: envelope.trace_id,
    };

    if accepted {
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
struct ErrorResponse {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Serialize)]
struct OperationResponse {
    protocol_version: u32,
    operation_id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    trace_id: String,
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
            && self.execution_deadline_at <= self.owner_lease_expires_at)
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
}
