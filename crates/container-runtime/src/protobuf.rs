use prost::Message;

use crate::{
    ClientResponseArtifactManifest, ErrorResponse, OperationEnvelope, OperationInput,
    OperationOutcomeStatus, OperationResponse, OperationResultManifest, OperationShard,
    ProviderResponseClassification,
};

pub const CONTENT_TYPE: &str = "application/x-protobuf";

pub mod wire {
    include!(concat!(
        env!("OUT_DIR"),
        "/cinatoken.container.runtime.v1.rs"
    ));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EnvelopeDecodeError;

pub(crate) fn decode_operation_envelope(
    bytes: &[u8],
) -> Result<OperationEnvelope, EnvelopeDecodeError> {
    let envelope = wire::OperationEnvelope::decode(bytes).map_err(|_| EnvelopeDecodeError)?;
    if envelope.encode_to_vec().as_slice() != bytes {
        return Err(EnvelopeDecodeError);
    }
    envelope.try_into()
}

pub(crate) fn encode_operation_response(response: &OperationResponse) -> Vec<u8> {
    wire::OperationResponse::from(response).encode_to_vec()
}

pub(crate) fn encode_error_response(response: &ErrorResponse) -> Vec<u8> {
    wire::ErrorResponse::from(response).encode_to_vec()
}

impl TryFrom<wire::OperationEnvelope> for OperationEnvelope {
    type Error = EnvelopeDecodeError;

    fn try_from(envelope: wire::OperationEnvelope) -> Result<Self, Self::Error> {
        Ok(Self {
            protocol_version: envelope.protocol_version,
            operation_id: envelope.operation_id,
            operation_kind: envelope.operation_kind,
            owner_generation: envelope.owner_generation,
            owner_lease_expires_at: envelope.owner_lease_expires_at,
            execution_deadline_at: envelope.execution_deadline_at,
            provider_operation_id: envelope.provider_operation_id,
            admission_sha256: envelope.admission_sha256,
            input: envelope.input.ok_or(EnvelopeDecodeError)?.try_into()?,
            shard: envelope.shard.ok_or(EnvelopeDecodeError)?.try_into()?,
            trace_id: envelope.trace_id,
        })
    }
}

impl TryFrom<wire::OperationInput> for OperationInput {
    type Error = EnvelopeDecodeError;

    fn try_from(input: wire::OperationInput) -> Result<Self, Self::Error> {
        let mode = match wire::OperationInputMode::try_from(input.mode) {
            Ok(wire::OperationInputMode::Inline) => "inline",
            Ok(wire::OperationInputMode::R2) => "r2",
            Ok(wire::OperationInputMode::Unspecified) | Err(_) => return Err(EnvelopeDecodeError),
        };
        Ok(Self {
            mode: mode.to_string(),
            sha256: input.sha256,
            size: input.size,
            content_type: input.content_type,
            request_object_key: input.request_object_key,
            object_version: input.object_version,
        })
    }
}

impl TryFrom<wire::OperationShard> for OperationShard {
    type Error = EnvelopeDecodeError;

    fn try_from(shard: wire::OperationShard) -> Result<Self, Self::Error> {
        Ok(Self {
            contract_version: shard.contract_version,
            ring_generation: shard.ring_generation,
            shard_count: shard
                .shard_count
                .try_into()
                .map_err(|_| EnvelopeDecodeError)?,
            shard_index: shard
                .shard_index
                .try_into()
                .map_err(|_| EnvelopeDecodeError)?,
            instance_name: shard.instance_name,
        })
    }
}

impl From<&OperationResponse> for wire::OperationResponse {
    fn from(response: &OperationResponse) -> Self {
        Self {
            protocol_version: response.protocol_version,
            operation_id: response.operation_id.clone(),
            status: match response.status {
                OperationOutcomeStatus::Completed => wire::OperationOutcomeStatus::Completed,
                OperationOutcomeStatus::Rejected => wire::OperationOutcomeStatus::Rejected,
                OperationOutcomeStatus::RecoveryRequired => {
                    wire::OperationOutcomeStatus::RecoveryRequired
                }
            } as i32,
            code: response.code.clone(),
            result: response.result.as_ref().map(Into::into),
            classification: response.classification.map(|classification| {
                (match classification {
                    ProviderResponseClassification::TypedError => {
                        wire::ProviderResponseClassification::TypedError
                    }
                    ProviderResponseClassification::HttpError => {
                        wire::ProviderResponseClassification::HttpError
                    }
                    ProviderResponseClassification::InvalidBody => {
                        wire::ProviderResponseClassification::InvalidBody
                    }
                }) as i32
            }),
            provider_status: response.provider_status.map(u32::from),
            client_status: response.client_status.map(u32::from),
            client_artifact: response.client_artifact.as_ref().map(Into::into),
            trace_id: response.trace_id.clone(),
        }
    }
}

impl From<&OperationResultManifest> for wire::OperationResultManifest {
    fn from(manifest: &OperationResultManifest) -> Self {
        Self {
            object_key: manifest.object_key.clone(),
            object_version: manifest.object_version.clone(),
            sha256: manifest.sha256.clone(),
            size: manifest.size,
            content_type: manifest.content_type.clone(),
        }
    }
}

impl From<&ClientResponseArtifactManifest> for wire::ClientResponseArtifactManifest {
    fn from(manifest: &ClientResponseArtifactManifest) -> Self {
        Self {
            object_key: manifest.object_key.clone(),
            object_version: manifest.object_version.clone(),
            client_response_artifact_sha256: manifest.client_response_artifact_sha256.clone(),
            sha256: manifest.sha256.clone(),
            size: manifest.size,
            content_type: manifest.content_type.clone(),
        }
    }
}

impl From<&ErrorResponse> for wire::ErrorResponse {
    fn from(response: &ErrorResponse) -> Self {
        Self {
            code: response.code.to_string(),
            message: response.message.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const CONFORMANCE_NOW: u64 = 2_000_000_000;
    const CONFORMANCE_CASES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/container-runtime/v1/conformance/operation-protobuf-cases.json"
    ));

    #[derive(Debug, Deserialize)]
    struct ConformanceVectors {
        schema_version: u32,
        cases: Vec<ConformanceCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ConformanceCase {
        name: String,
        accepted: bool,
        message_type: String,
        wire_hex: String,
    }

    #[test]
    fn shared_operation_envelope_vectors_use_the_production_decoder_and_validator() {
        let vectors: ConformanceVectors = serde_json::from_str(CONFORMANCE_CASES).unwrap();
        assert_eq!(vectors.schema_version, 1);
        let cases = vectors
            .cases
            .iter()
            .filter(|case| case.message_type.ends_with(".OperationEnvelope"));

        for case in cases {
            let bytes = decode_hex(&case.wire_hex);
            let accepted = decode_operation_envelope(&bytes)
                .and_then(|envelope| {
                    envelope
                        .validate(CONFORMANCE_NOW)
                        .map_err(|_| EnvelopeDecodeError)
                })
                .is_ok();
            assert_eq!(accepted, case.accepted, "conformance case {}", case.name);
        }
    }

    #[test]
    fn shared_response_and_error_vectors_are_canonical_and_semantically_valid() {
        let vectors: ConformanceVectors = serde_json::from_str(CONFORMANCE_CASES).unwrap();
        assert_eq!(vectors.schema_version, 1);

        for case in &vectors.cases {
            let bytes = decode_hex(&case.wire_hex);
            if case.message_type.ends_with(".OperationResponse") {
                let accepted = wire::OperationResponse::decode(bytes.as_slice())
                    .ok()
                    .filter(|response| response.encode_to_vec() == bytes)
                    .is_some_and(|response| valid_operation_response(&response));
                assert_eq!(accepted, case.accepted, "conformance case {}", case.name);
            } else if case.message_type.ends_with(".ErrorResponse") {
                let accepted = wire::ErrorResponse::decode(bytes.as_slice())
                    .ok()
                    .filter(|response| response.encode_to_vec() == bytes)
                    .is_some_and(|response| {
                        !response.code.is_empty() && !response.message.is_empty()
                    });
                assert_eq!(accepted, case.accepted, "conformance case {}", case.name);
            }
        }
    }

    fn valid_operation_response(response: &wire::OperationResponse) -> bool {
        if response.protocol_version != 1
            || response.operation_id.is_empty()
            || response.trace_id.is_empty()
        {
            return false;
        }

        let Ok(status) = wire::OperationOutcomeStatus::try_from(response.status) else {
            return false;
        };
        let valid_classification = response.classification.map_or(true, |classification| {
            wire::ProviderResponseClassification::try_from(classification)
                .is_ok_and(|value| value != wire::ProviderResponseClassification::Unspecified)
        });
        if !valid_classification {
            return false;
        }

        let provider_presence = [
            response.classification.is_some(),
            response.provider_status.is_some(),
            response.client_status.is_some(),
            response.client_artifact.is_some(),
        ];
        match status {
            wire::OperationOutcomeStatus::Completed => {
                response.code.is_none() && provider_presence.iter().all(|present| !present)
            }
            wire::OperationOutcomeStatus::Rejected => {
                response.code.as_ref().is_some_and(|code| !code.is_empty())
                    && response.result.is_none()
                    && (provider_presence.iter().all(|present| *present)
                        || provider_presence.iter().all(|present| !present))
            }
            wire::OperationOutcomeStatus::RecoveryRequired => {
                response.code.as_ref().is_some_and(|code| !code.is_empty())
                    && response.result.is_none()
                    && provider_presence.iter().all(|present| !present)
            }
            wire::OperationOutcomeStatus::Unspecified => false,
        }
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]))
            .collect()
    }

    fn hex_nibble(value: u8) -> u8 {
        match value {
            b'0'..=b'9' => value - b'0',
            b'a'..=b'f' => value - b'a' + 10,
            b'A'..=b'F' => value - b'A' + 10,
            _ => panic!("invalid hexadecimal conformance vector"),
        }
    }
}
