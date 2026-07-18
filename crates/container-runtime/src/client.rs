use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE},
    Method, Request, Response, StatusCode,
};
use hyper_util::{
    client::legacy::{connect::HttpConnector, Client},
    rt::TokioExecutor,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    ClientResponseArtifactManifest, OperationEnvelope, OperationResultManifest,
    ProviderRejectedOutcome, ProviderResponseClassification, INTERPRETED_PROVIDER_REJECTION_STATUS,
};

pub(crate) const PROVIDER_CANARY_OPERATION_KIND: &str = "chat_completions_canary";
const R2_INPUT_URL: &str = "http://r2-input.cinatoken.internal/v1/input";
const PROVIDER_EGRESS_URL: &str =
    "http://provider-egress.cinatoken.internal/v1/provider-attempts/execute";
const OPERATION_ID_HEADER: &str = "x-cinatoken-operation-id";
const OWNER_GENERATION_HEADER: &str = "x-cinatoken-owner-generation";
const ATTEMPT_GENERATION_HEADER: &str = "x-cinatoken-provider-attempt-generation";
const CONTENT_SHA256_HEADER: &str = "x-cinatoken-content-sha256";
const MAX_CANARY_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_GATEWAY_RESPONSE_BYTES: usize = 8 * 1024;

#[derive(Debug)]
pub(crate) enum ExecutionOutcome {
    Completed(OperationResultManifest),
    Rejected(ProviderRejectedOutcome),
    RecoveryRequired,
}

#[derive(Debug)]
pub(crate) enum ExecutionError {
    InputUnavailable,
    Ambiguous,
}

#[async_trait]
pub(crate) trait OperationExecutor: Send + Sync {
    async fn execute(
        &self,
        envelope: &OperationEnvelope,
    ) -> Result<ExecutionOutcome, ExecutionError>;
}

pub(crate) struct InternalProviderClient {
    client: Client<HttpConnector, Full<Bytes>>,
}

impl InternalProviderClient {
    pub(crate) fn new() -> Self {
        let connector = HttpConnector::new();
        let client = Client::builder(TokioExecutor::new()).build(connector);
        Self { client }
    }

    async fn load_input(&self, envelope: &OperationEnvelope) -> Result<Bytes, ExecutionError> {
        if envelope.input.mode != "r2"
            || envelope.input.size > MAX_CANARY_BODY_BYTES as u64
            || !is_json_content_type(&envelope.input.content_type)
        {
            return Err(ExecutionError::InputUnavailable);
        }
        let request = Request::builder()
            .method(Method::GET)
            .uri(R2_INPUT_URL)
            .header(ACCEPT, envelope.input.content_type.as_str())
            .header(OPERATION_ID_HEADER, envelope.operation_id.as_str())
            .header(
                OWNER_GENERATION_HEADER,
                envelope.owner_generation.to_string(),
            )
            .body(Full::new(Bytes::new()))
            .map_err(|_| ExecutionError::InputUnavailable)?;
        let response = self
            .send(request, envelope.execution_deadline_at)
            .await
            .map_err(|_| ExecutionError::InputUnavailable)?;
        if response.status() != StatusCode::OK
            || response
                .headers()
                .get(CONTENT_SHA256_HEADER)
                .and_then(|value| value.to_str().ok())
                != Some(envelope.input.sha256.as_str())
            || response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(is_json_content_type)
                != Some(true)
        {
            return Err(ExecutionError::InputUnavailable);
        }
        let bytes = read_bounded_body(
            response,
            MAX_CANARY_BODY_BYTES,
            envelope.execution_deadline_at,
        )
        .await
        .map_err(|_| ExecutionError::InputUnavailable)?;
        if bytes.len() as u64 != envelope.input.size
            || format!("{:x}", Sha256::digest(&bytes)) != envelope.input.sha256
        {
            return Err(ExecutionError::InputUnavailable);
        }
        Ok(bytes)
    }

    async fn execute_provider(
        &self,
        envelope: &OperationEnvelope,
        body: Bytes,
    ) -> Result<ExecutionOutcome, ExecutionError> {
        let request = Request::builder()
            .method(Method::POST)
            .uri(PROVIDER_EGRESS_URL)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(CONTENT_LENGTH, body.len().to_string())
            .header(OPERATION_ID_HEADER, envelope.operation_id.as_str())
            .header(
                OWNER_GENERATION_HEADER,
                envelope.owner_generation.to_string(),
            )
            .header(ATTEMPT_GENERATION_HEADER, "1")
            .header(CONTENT_SHA256_HEADER, envelope.input.sha256.as_str())
            .body(Full::new(body))
            .map_err(|_| ExecutionError::Ambiguous)?;
        let response = self
            .send(request, envelope.execution_deadline_at)
            .await
            .map_err(|_| ExecutionError::Ambiguous)?;
        let status = response.status();
        if status != StatusCode::OK
            && status != StatusCode::ACCEPTED
            && status != INTERPRETED_PROVIDER_REJECTION_STATUS
        {
            return Err(ExecutionError::Ambiguous);
        }
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(is_json_content_type)
            != Some(true)
        {
            return Err(ExecutionError::Ambiguous);
        }
        let body = read_bounded_body(
            response,
            MAX_GATEWAY_RESPONSE_BYTES,
            envelope.execution_deadline_at,
        )
        .await
        .map_err(|_| ExecutionError::Ambiguous)?;
        let outcome = serde_json::from_slice::<ProviderExecutionResponse>(&body)
            .map_err(|_| ExecutionError::Ambiguous)?;
        outcome.validate(envelope, status)
    }

    async fn send(
        &self,
        request: Request<Full<Bytes>>,
        deadline_at: u64,
    ) -> Result<Response<hyper::body::Incoming>, ()> {
        tokio::time::timeout(remaining(deadline_at)?, self.client.request(request))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())
    }
}

#[async_trait]
impl OperationExecutor for InternalProviderClient {
    async fn execute(
        &self,
        envelope: &OperationEnvelope,
    ) -> Result<ExecutionOutcome, ExecutionError> {
        let input = self.load_input(envelope).await?;
        self.execute_provider(envelope, input).await
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderExecutionResponse {
    protocol_version: u32,
    operation_id: String,
    owner_generation: u64,
    attempt_generation: u32,
    status: ProviderExecutionStatus,
    #[serde(default)]
    provider_status: Option<u16>,
    #[serde(default)]
    client_status: Option<u16>,
    #[serde(default)]
    classification: Option<ProviderResponseClassification>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    result: Option<OperationResultManifest>,
    #[serde(default)]
    client_artifact: Option<ClientResponseArtifactManifest>,
    trace_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProviderExecutionStatus {
    Succeeded,
    Rejected,
    Ambiguous,
}

impl ProviderExecutionResponse {
    fn validate(
        self,
        envelope: &OperationEnvelope,
        http_status: StatusCode,
    ) -> Result<ExecutionOutcome, ExecutionError> {
        if self.protocol_version != 1
            || self.operation_id != envelope.operation_id
            || self.owner_generation != envelope.owner_generation
            || self.attempt_generation != 1
            || self.trace_id != envelope.trace_id
        {
            return Err(ExecutionError::Ambiguous);
        }
        match self.status {
            ProviderExecutionStatus::Succeeded
                if http_status == StatusCode::OK
                    && self.provider_status == Some(200)
                    && self.client_status.is_none()
                    && self.classification.is_none()
                    && self.code.is_none()
                    && self.result.is_some()
                    && self.client_artifact.is_none() =>
            {
                Ok(ExecutionOutcome::Completed(self.result.unwrap()))
            }
            ProviderExecutionStatus::Rejected
                if http_status == INTERPRETED_PROVIDER_REJECTION_STATUS
                    && self.result.is_none()
                    && self.provider_status.is_some()
                    && self.client_status.is_some()
                    && self.classification.is_some()
                    && self.code.as_deref().is_some_and(valid_outcome_code)
                    && self.client_artifact.is_some() =>
            {
                let rejected = ProviderRejectedOutcome {
                    classification: self.classification.unwrap(),
                    provider_status: self.provider_status.unwrap(),
                    client_status: self.client_status.unwrap(),
                    code: self.code.unwrap(),
                    client_artifact: self.client_artifact.unwrap(),
                };
                if !rejected.valid(&envelope.operation_id, envelope.owner_generation) {
                    return Err(ExecutionError::Ambiguous);
                }
                Ok(ExecutionOutcome::Rejected(rejected))
            }
            ProviderExecutionStatus::Ambiguous
                if http_status == StatusCode::ACCEPTED
                    && self.provider_status.is_none()
                    && self.client_status.is_none()
                    && self.classification.is_none()
                    && self.result.is_none()
                    && self.client_artifact.is_none()
                    && self.code.as_deref().is_some_and(valid_outcome_code) =>
            {
                Ok(ExecutionOutcome::RecoveryRequired)
            }
            _ => Err(ExecutionError::Ambiguous),
        }
    }
}

async fn read_bounded_body(
    response: Response<hyper::body::Incoming>,
    limit: usize,
    deadline_at: u64,
) -> Result<Bytes, ()> {
    if let Some(length) = response.headers().get(CONTENT_LENGTH) {
        let length = length
            .to_str()
            .map_err(|_| ())?
            .parse::<usize>()
            .map_err(|_| ())?;
        if length > limit {
            return Err(());
        }
    }
    let body = Limited::new(response.into_body(), limit);
    tokio::time::timeout(remaining(deadline_at)?, body.collect())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
        .map(|collected| collected.to_bytes())
}

fn remaining(deadline_at: u64) -> Result<Duration, ()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?;
    let deadline = Duration::from_secs(deadline_at);
    deadline
        .checked_sub(now)
        .filter(|remaining| !remaining.is_zero())
        .ok_or(())
}

fn is_json_content_type(value: &str) -> bool {
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = essence.split_once('/') else {
        return false;
    };
    kind.eq_ignore_ascii_case("application")
        && (subtype.eq_ignore_ascii_case("json") || subtype.to_ascii_lowercase().ends_with("+json"))
}

fn valid_outcome_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OperationInput, OperationShard};

    fn envelope() -> OperationEnvelope {
        OperationEnvelope {
            protocol_version: 1,
            operation_id: "operation-1".to_string(),
            operation_kind: PROVIDER_CANARY_OPERATION_KIND.to_string(),
            owner_generation: 2,
            owner_lease_expires_at: 200,
            execution_deadline_at: 150,
            provider_operation_id: "provider-operation-1".to_string(),
            admission_sha256: "a".repeat(64),
            input: OperationInput {
                mode: "r2".to_string(),
                sha256: "b".repeat(64),
                size: 10,
                content_type: "application/json".to_string(),
                request_object_key: Some("container-inputs/v1/input".to_string()),
                object_version: Some("version-1".to_string()),
            },
            shard: OperationShard {
                contract_version: 1,
                ring_generation: 1,
                shard_count: 8,
                shard_index: 3,
                instance_name: "cinatoken-relay-shard-v1-0003".to_string(),
            },
            trace_id: "trace-1".to_string(),
        }
    }

    #[test]
    fn validates_strict_success_and_ambiguous_gateway_outcomes() {
        let operation = envelope();
        let result = OperationResultManifest::try_new(
            "container-results/v1/operation-1/2/abc".to_string(),
            "version-1".to_string(),
            "c".repeat(64),
            10,
            "application/json".to_string(),
        )
        .unwrap();
        let success = ProviderExecutionResponse {
            protocol_version: 1,
            operation_id: operation.operation_id.clone(),
            owner_generation: operation.owner_generation,
            attempt_generation: 1,
            status: ProviderExecutionStatus::Succeeded,
            provider_status: Some(200),
            client_status: None,
            classification: None,
            code: None,
            result: Some(result),
            client_artifact: None,
            trace_id: operation.trace_id.clone(),
        };
        assert!(matches!(
            success.validate(&operation, StatusCode::OK),
            Ok(ExecutionOutcome::Completed(_))
        ));
        let ambiguous = ProviderExecutionResponse {
            protocol_version: 1,
            operation_id: operation.operation_id.clone(),
            owner_generation: operation.owner_generation,
            attempt_generation: 1,
            status: ProviderExecutionStatus::Ambiguous,
            provider_status: None,
            client_status: None,
            classification: None,
            code: Some(crate::AMBIGUOUS_EXECUTION_CODE.to_string()),
            result: None,
            client_artifact: None,
            trace_id: operation.trace_id.clone(),
        };
        assert!(matches!(
            ambiguous.validate(&operation, StatusCode::ACCEPTED),
            Ok(ExecutionOutcome::RecoveryRequired)
        ));

        let artifact_digest = "d".repeat(64);
        let rejected = ProviderExecutionResponse {
            protocol_version: 1,
            operation_id: operation.operation_id.clone(),
            owner_generation: operation.owner_generation,
            attempt_generation: 1,
            status: ProviderExecutionStatus::Rejected,
            provider_status: Some(202),
            client_status: Some(202),
            classification: Some(ProviderResponseClassification::HttpError),
            code: Some("provider_http_error".to_string()),
            result: None,
            client_artifact: Some(
                ClientResponseArtifactManifest::try_new(
                    format!("container-client-artifacts/v1/operation-1/2/{artifact_digest}"),
                    "artifact-version-1".to_string(),
                    artifact_digest,
                    "e".repeat(64),
                    64,
                    "application/json".to_string(),
                )
                .unwrap(),
            ),
            trace_id: operation.trace_id.clone(),
        };
        assert!(matches!(
            rejected.validate(&operation, INTERPRETED_PROVIDER_REJECTION_STATUS),
            Ok(ExecutionOutcome::Rejected(ProviderRejectedOutcome {
                classification: ProviderResponseClassification::HttpError,
                provider_status: 202,
                client_status: 202,
                ..
            }))
        ));
    }
}
