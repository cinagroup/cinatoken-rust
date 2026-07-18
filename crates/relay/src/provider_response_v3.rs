//! Canonical provider-response protocol v3 envelopes.
//!
//! This module owns only the transport-neutral wire contract. Callers remain
//! responsible for bounded provider I/O, outer HTTP behavior, persistence, and
//! terminal policy.

use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    openai_compatible::UsageCacheFieldPolicy,
    provider_response::{
        first_safe_provider_request_id, interpret_buffered_provider_response,
        valid_provider_request_id, ProviderResponseClass, ProviderResponseProfile,
        PROVIDER_RESPONSE_INTERPRETER_CONTRACT,
    },
    usage_receipt::{
        ProviderUsageReceiptError, ProviderUsageReceiptInput, ProviderUsageReceiptV1,
        MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES, PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE,
    },
};

pub const PROVIDER_RESPONSE_PROTOCOL_V3: u8 = 3;
pub const PROVIDER_RESPONSE_V3_CONTENT_TYPE: &str =
    "application/vnd.cinatoken.provider-response.v3+json";
pub const PROVIDER_RESPONSE_CLIENT_CONTENT_TYPE_V3: &str = "application/json";
pub const PROVIDER_RESPONSE_INTERPRETER_SOURCE_COMMIT: &str =
    "73652508abc5cb09214dde02d51d69d1d1ccc703";
pub const PROVIDER_EVIDENCE_ATTESTATION_CONTRACT_V1: &str =
    "cinatoken-provider-evidence-attestation-v1";
pub const CLIENT_RESPONSE_ATTESTATION_CONTRACT_V1: &str =
    "cinatoken-client-response-attestation-v1";

pub const MAX_PROVIDER_RESPONSE_BODY_BYTES_V3: usize = 4_194_304;
pub const MIN_PROVIDER_CLIENT_BODY_BYTES_V3: usize = 2;
pub const MAX_PROVIDER_RESPONSE_HEADER_JSON_BYTES_V3: usize = 8_192;
pub const MAX_PROVIDER_USAGE_RECEIPT_BYTES_V3: usize = MAX_PROVIDER_USAGE_RECEIPT_JSON_BYTES;
pub const MAX_PROVIDER_RESPONSE_ENVELOPE_BYTES_V3: usize = 12_582_912;
pub const PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const MAX_IDENTITY_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 1_024;
const MAX_CONTENT_TYPE_BYTES: usize = 128;
const ERROR_CLIENT_HEADERS_JSON: &str =
    r#"{"cache-control":"no-store","content-type":"application/json"}"#;

/// Safe observed provider headers, in canonical ASCII order.
pub const PROVIDER_RESPONSE_V3_SAFE_RAW_HEADERS: &[&str] = &[
    "content-language",
    "content-type",
    "openai-request-id",
    "request-id",
    "retry-after",
    "x-request-id",
];

const PROVIDER_RESPONSE_V3_SAFE_CLIENT_HEADERS: &[&str] = &[
    "cache-control",
    "content-language",
    "content-type",
    "openai-request-id",
    "request-id",
    "retry-after",
    "x-request-id",
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderResponseWireClassV3 {
    Success,
    TypedError,
    HttpError,
    InvalidBody,
}

impl ProviderResponseWireClassV3 {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::TypedError => "typed_error",
            Self::HttpError => "http_error",
            Self::InvalidBody => "invalid_body",
        }
    }
}

impl From<ProviderResponseClass> for ProviderResponseWireClassV3 {
    fn from(value: ProviderResponseClass) -> Self {
        match value {
            ProviderResponseClass::Success => Self::Success,
            ProviderResponseClass::TypedError => Self::TypedError,
            ProviderResponseClass::HttpError => Self::HttpError,
            ProviderResponseClass::InvalidBody => Self::InvalidBody,
        }
    }
}

/// Field declaration order is the canonical wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseIdentityV3 {
    pub operation_id: String,
    pub owner_generation: u64,
    pub attempt_generation: u64,
    pub provider_operation_id: String,
    pub request_sha256: String,
    pub egress_profile: String,
    pub egress_worker_version_id: String,
}

/// Field declaration order is the canonical wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseInterpretationV3 {
    pub contract: String,
    pub source_commit: String,
    pub response_class: ProviderResponseWireClassV3,
    pub provider_status: u16,
    pub client_status: u16,
    pub audit_status: u16,
}

/// Field declaration order is the canonical wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseRawV3 {
    pub content_type: Option<String>,
    pub headers_json: String,
    pub headers_length: u64,
    pub headers_sha256: String,
    pub body_length: u64,
    pub body_sha256: String,
    pub body_base64: String,
    pub provider_request_id: Option<String>,
    pub completed_at: u64,
}

/// Field declaration order is the canonical wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseClientV3 {
    pub content_type: String,
    pub headers_json: String,
    pub headers_length: u64,
    pub headers_sha256: String,
    pub body_length: u64,
    pub body_sha256: String,
    pub body_same_as_raw: bool,
    pub body_base64: Option<String>,
}

/// Canonical protocol-v3 envelope. Field declaration order is the wire order.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponseEnvelopeV3 {
    pub protocol_version: u8,
    pub identity: ProviderResponseIdentityV3,
    pub interpretation: ProviderResponseInterpretationV3,
    pub raw: ProviderResponseRawV3,
    pub client: ProviderResponseClientV3,
    /// Embedded canonical `ProviderUsageReceiptV1` object.
    pub usage_receipt: Option<ProviderUsageReceiptV1>,
    pub provider_response_evidence_sha256: String,
    pub client_response_artifact_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderResponseHeaderV3<'a> {
    pub name: &'a str,
    pub value: &'a str,
}

impl<'a> ProviderResponseHeaderV3<'a> {
    pub const fn new(name: &'a str, value: &'a str) -> Self {
        Self { name, value }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderResponseEnvelopeV3Input<'a> {
    pub operation_id: &'a str,
    pub owner_generation: u64,
    pub attempt_generation: u64,
    pub provider_operation_id: &'a str,
    pub request_sha256: &'a str,
    pub egress_profile: &'a str,
    pub egress_worker_version_id: &'a str,
    pub provider_status: u16,
    pub raw_headers: &'a [ProviderResponseHeaderV3<'a>],
    pub raw_body: &'a [u8],
    pub completed_at: u64,
    pub include_usage_receipt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalProviderResponseHeadersV3 {
    pub content_type: Option<String>,
    pub headers_json: String,
    pub headers_length: u64,
    pub headers_sha256: String,
    pub provider_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderResponseV3Error {
    InvalidJson,
    NonCanonical,
    InvalidField(&'static str),
    DuplicateHeader(String),
    InvalidBase64(&'static str),
    DigestMismatch(&'static str),
    TooLarge(&'static str),
    Serialization,
    Receipt(ProviderUsageReceiptError),
}

impl fmt::Display for ProviderResponseV3Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson => formatter.write_str("invalid provider-response v3 JSON"),
            Self::NonCanonical => formatter.write_str("noncanonical provider-response v3 JSON"),
            Self::InvalidField(field) => {
                write!(formatter, "invalid provider-response field: {field}")
            }
            Self::DuplicateHeader(name) => write!(formatter, "duplicate provider header: {name}"),
            Self::InvalidBase64(field) => write!(formatter, "invalid base64url field: {field}"),
            Self::DigestMismatch(field) => {
                write!(formatter, "provider-response digest mismatch: {field}")
            }
            Self::TooLarge(field) => {
                write!(formatter, "provider-response size bound exceeded: {field}")
            }
            Self::Serialization => formatter.write_str("provider-response serialization failed"),
            Self::Receipt(error) => write!(formatter, "invalid provider usage receipt: {error}"),
        }
    }
}

impl Error for ProviderResponseV3Error {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Receipt(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProviderUsageReceiptError> for ProviderResponseV3Error {
    fn from(value: ProviderUsageReceiptError) -> Self {
        Self::Receipt(value)
    }
}

#[derive(Debug)]
struct ValidatedEnvelopeV3 {
    raw_body: Vec<u8>,
    client_body: Vec<u8>,
    usage_receipt_json: Option<Vec<u8>>,
    usage_receipt: Option<ProviderUsageReceiptV1>,
}

impl ProviderResponseEnvelopeV3 {
    pub fn build(
        input: ProviderResponseEnvelopeV3Input<'_>,
    ) -> Result<Self, ProviderResponseV3Error> {
        build_provider_response_v3(input)
    }

    pub fn validate(&self) -> Result<(), ProviderResponseV3Error> {
        self.validate_and_decode().map(|_| ())
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ProviderResponseV3Error> {
        self.validate()?;
        let canonical = serialize_compact(self)?;
        if canonical.len() > MAX_PROVIDER_RESPONSE_ENVELOPE_BYTES_V3 {
            return Err(ProviderResponseV3Error::TooLarge("envelope"));
        }
        Ok(canonical)
    }

    pub fn parse_canonical_json(bytes: &[u8]) -> Result<Self, ProviderResponseV3Error> {
        parse_provider_response_v3(bytes)
    }

    pub fn decoded_raw_body(&self) -> Result<Vec<u8>, ProviderResponseV3Error> {
        Ok(self.validate_and_decode()?.raw_body)
    }

    pub fn decoded_client_body(&self) -> Result<Vec<u8>, ProviderResponseV3Error> {
        Ok(self.validate_and_decode()?.client_body)
    }

    pub fn decoded_usage_receipt_json(&self) -> Result<Option<Vec<u8>>, ProviderResponseV3Error> {
        Ok(self.validate_and_decode()?.usage_receipt_json)
    }

    pub fn canonical_usage_receipt_json(&self) -> Result<Option<Vec<u8>>, ProviderResponseV3Error> {
        self.decoded_usage_receipt_json()
    }

    pub fn parsed_usage_receipt(
        &self,
    ) -> Result<Option<ProviderUsageReceiptV1>, ProviderResponseV3Error> {
        Ok(self.validate_and_decode()?.usage_receipt)
    }

    pub fn provider_evidence_attestation_json(&self) -> Result<Vec<u8>, ProviderResponseV3Error> {
        self.validate()?;
        provider_evidence_attestation_json_unchecked(self)
    }

    pub fn provider_evidence_attestation_sha256(&self) -> Result<String, ProviderResponseV3Error> {
        Ok(sha256_lower_hex(
            &self.provider_evidence_attestation_json()?,
        ))
    }

    pub fn client_response_attestation_json(&self) -> Result<Vec<u8>, ProviderResponseV3Error> {
        let validated = self.validate_and_decode()?;
        let receipt_sha256 = validated
            .usage_receipt_json
            .as_deref()
            .map(sha256_lower_hex);
        client_response_attestation_json_unchecked(self, receipt_sha256.as_deref())
    }

    pub fn client_response_attestation_sha256(&self) -> Result<String, ProviderResponseV3Error> {
        Ok(sha256_lower_hex(&self.client_response_attestation_json()?))
    }

    fn validate_and_decode(&self) -> Result<ValidatedEnvelopeV3, ProviderResponseV3Error> {
        if self.protocol_version != PROVIDER_RESPONSE_PROTOCOL_V3 {
            return Err(ProviderResponseV3Error::InvalidField("protocol_version"));
        }
        validate_identity(&self.identity)?;
        validate_interpretation(&self.interpretation, self.usage_receipt.is_some())?;

        let raw_headers = validate_headers_json(
            &self.raw.headers_json,
            self.raw.headers_length,
            &self.raw.headers_sha256,
            HeaderKind::Raw,
        )?;
        let expected_raw_content_type = raw_headers.get("content-type").cloned();
        if self.raw.content_type != expected_raw_content_type {
            return Err(ProviderResponseV3Error::InvalidField("raw.content_type"));
        }
        if self
            .raw
            .content_type
            .as_deref()
            .is_some_and(|value| !valid_content_type(value))
        {
            return Err(ProviderResponseV3Error::InvalidField("raw.content_type"));
        }
        let expected_provider_request_id = provider_request_id_from_headers(&raw_headers);
        if self.raw.provider_request_id != expected_provider_request_id {
            return Err(ProviderResponseV3Error::InvalidField(
                "raw.provider_request_id",
            ));
        }
        if self.raw.completed_at > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER {
            return Err(ProviderResponseV3Error::InvalidField("raw.completed_at"));
        }
        require_sha256(&self.raw.body_sha256, "raw.body_sha256")?;
        let raw_body = decode_body_base64(
            &self.raw.body_base64,
            self.raw.body_length,
            0,
            MAX_PROVIDER_RESPONSE_BODY_BYTES_V3,
            "raw.body_base64",
        )?;
        if sha256_lower_hex(&raw_body) != self.raw.body_sha256 {
            return Err(ProviderResponseV3Error::DigestMismatch("raw.body_sha256"));
        }

        if self.client.content_type != PROVIDER_RESPONSE_CLIENT_CONTENT_TYPE_V3 {
            return Err(ProviderResponseV3Error::InvalidField("client.content_type"));
        }
        let client_headers = validate_headers_json(
            &self.client.headers_json,
            self.client.headers_length,
            &self.client.headers_sha256,
            HeaderKind::Client,
        )?;
        if client_headers.get("cache-control").map(String::as_str) != Some("no-store")
            || client_headers.get("content-type").map(String::as_str)
                != Some(PROVIDER_RESPONSE_CLIENT_CONTENT_TYPE_V3)
        {
            return Err(ProviderResponseV3Error::InvalidField("client.headers_json"));
        }
        validate_client_header_projection(
            self.interpretation.response_class,
            &raw_headers,
            &client_headers,
            &self.client.headers_json,
        )?;
        require_sha256(&self.client.body_sha256, "client.body_sha256")?;
        let client_body = match (self.client.body_same_as_raw, &self.client.body_base64) {
            (true, None) => {
                if self.client.body_length != self.raw.body_length
                    || self.client.body_sha256 != self.raw.body_sha256
                {
                    return Err(ProviderResponseV3Error::InvalidField(
                        "client.body_same_as_raw",
                    ));
                }
                raw_body.clone()
            }
            (true, Some(_)) | (false, None) => {
                return Err(ProviderResponseV3Error::InvalidField("client.body_base64"));
            }
            (false, Some(encoded)) => decode_body_base64(
                encoded,
                self.client.body_length,
                MIN_PROVIDER_CLIENT_BODY_BYTES_V3,
                MAX_PROVIDER_RESPONSE_BODY_BYTES_V3,
                "client.body_base64",
            )?,
        };
        if !(MIN_PROVIDER_CLIENT_BODY_BYTES_V3..=MAX_PROVIDER_RESPONSE_BODY_BYTES_V3)
            .contains(&client_body.len())
        {
            return Err(ProviderResponseV3Error::InvalidField("client.body_length"));
        }
        if sha256_lower_hex(&client_body) != self.client.body_sha256 {
            return Err(ProviderResponseV3Error::DigestMismatch(
                "client.body_sha256",
            ));
        }
        if self.client.body_same_as_raw != (client_body == raw_body) {
            return Err(ProviderResponseV3Error::InvalidField(
                "client.body_same_as_raw",
            ));
        }

        let (usage_receipt_json, usage_receipt) = match &self.usage_receipt {
            Some(receipt) => {
                if self.interpretation.response_class != ProviderResponseWireClassV3::Success {
                    return Err(ProviderResponseV3Error::InvalidField("usage_receipt"));
                }
                let canonical = canonical_embedded_receipt_json(receipt)?;
                validate_receipt_binding(self, receipt)?;
                (Some(canonical), Some(receipt.clone()))
            }
            None => (None, None),
        };

        require_sha256(
            &self.provider_response_evidence_sha256,
            "provider_response_evidence_sha256",
        )?;
        let provider_attestation = provider_evidence_attestation_json_unchecked(self)?;
        if sha256_lower_hex(&provider_attestation) != self.provider_response_evidence_sha256 {
            return Err(ProviderResponseV3Error::DigestMismatch(
                "provider_response_evidence_sha256",
            ));
        }
        require_sha256(
            &self.client_response_artifact_sha256,
            "client_response_artifact_sha256",
        )?;
        let usage_receipt_sha256 = usage_receipt_json.as_deref().map(sha256_lower_hex);
        let client_attestation =
            client_response_attestation_json_unchecked(self, usage_receipt_sha256.as_deref())?;
        if sha256_lower_hex(&client_attestation) != self.client_response_artifact_sha256 {
            return Err(ProviderResponseV3Error::DigestMismatch(
                "client_response_artifact_sha256",
            ));
        }

        Ok(ValidatedEnvelopeV3 {
            raw_body,
            client_body,
            usage_receipt_json,
            usage_receipt,
        })
    }
}

pub fn build_provider_response_v3(
    input: ProviderResponseEnvelopeV3Input<'_>,
) -> Result<ProviderResponseEnvelopeV3, ProviderResponseV3Error> {
    if input.raw_body.len() > MAX_PROVIDER_RESPONSE_BODY_BYTES_V3 {
        return Err(ProviderResponseV3Error::TooLarge("raw.body"));
    }
    let identity = ProviderResponseIdentityV3 {
        operation_id: input.operation_id.to_string(),
        owner_generation: input.owner_generation,
        attempt_generation: input.attempt_generation,
        provider_operation_id: input.provider_operation_id.to_string(),
        request_sha256: input.request_sha256.to_string(),
        egress_profile: input.egress_profile.to_string(),
        egress_worker_version_id: input.egress_worker_version_id.to_string(),
    };
    validate_identity(&identity)?;
    if input.completed_at > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER {
        return Err(ProviderResponseV3Error::InvalidField("raw.completed_at"));
    }

    let raw_header_map = project_raw_headers(input.raw_headers)?;
    let canonical_headers = canonical_headers_from_map(&raw_header_map)?;
    let interpreted = interpret_buffered_provider_response(
        ProviderResponseProfile::OpenAiCompatible(UsageCacheFieldPolicy::Standard),
        input.provider_status,
        input.raw_body,
    );
    let response_class = ProviderResponseWireClassV3::from(interpreted.class());
    let interpretation = ProviderResponseInterpretationV3 {
        contract: PROVIDER_RESPONSE_INTERPRETER_CONTRACT.to_string(),
        source_commit: PROVIDER_RESPONSE_INTERPRETER_SOURCE_COMMIT.to_string(),
        response_class,
        provider_status: interpreted.upstream_status(),
        client_status: interpreted.client_status(),
        audit_status: interpreted.audit_status(),
    };
    validate_interpretation(&interpretation, input.include_usage_receipt)?;

    let client_body = if response_class == ProviderResponseWireClassV3::Success {
        input.raw_body.to_vec()
    } else {
        let envelope =
            interpreted
                .error_envelope()
                .ok_or(ProviderResponseV3Error::InvalidField(
                    "interpretation.error",
                ))?;
        serialize_compact(&envelope)?
    };
    if !(MIN_PROVIDER_CLIENT_BODY_BYTES_V3..=MAX_PROVIDER_RESPONSE_BODY_BYTES_V3)
        .contains(&client_body.len())
    {
        return Err(ProviderResponseV3Error::TooLarge("client.body"));
    }
    let client_header_map = client_headers(response_class, &raw_header_map);
    let client_headers = canonical_headers_from_map(&client_header_map)?;

    let usage_receipt = if input.include_usage_receipt {
        let receipt = ProviderUsageReceiptV1::from_provider_response(ProviderUsageReceiptInput {
            operation_id: input.operation_id,
            owner_generation: i64::try_from(input.owner_generation)
                .map_err(|_| ProviderResponseV3Error::InvalidField("identity.owner_generation"))?,
            attempt_generation: i64::try_from(input.attempt_generation).map_err(|_| {
                ProviderResponseV3Error::InvalidField("identity.attempt_generation")
            })?,
            provider_operation_id: input.provider_operation_id,
            request_sha256: input.request_sha256,
            egress_worker_version_id: input.egress_worker_version_id,
            provider_response_status: input.provider_status,
            provider_response_body: input.raw_body,
            provider_request_id: canonical_headers.provider_request_id.as_deref(),
            provider_completed_at: i64::try_from(input.completed_at)
                .map_err(|_| ProviderResponseV3Error::InvalidField("raw.completed_at"))?,
        })?;
        Some(receipt)
    } else {
        None
    };
    let usage_receipt_json = usage_receipt
        .as_ref()
        .map(canonical_embedded_receipt_json)
        .transpose()?;

    let raw_body_sha256 = interpreted.body_sha256().to_string();
    let client_body_sha256 = sha256_lower_hex(&client_body);
    let body_same_as_raw = input.raw_body == client_body;
    let mut envelope = ProviderResponseEnvelopeV3 {
        protocol_version: PROVIDER_RESPONSE_PROTOCOL_V3,
        identity,
        interpretation,
        raw: ProviderResponseRawV3 {
            content_type: canonical_headers.content_type,
            headers_json: canonical_headers.headers_json,
            headers_length: canonical_headers.headers_length,
            headers_sha256: canonical_headers.headers_sha256,
            body_length: input.raw_body.len() as u64,
            body_sha256: raw_body_sha256,
            body_base64: encode_base64url_no_pad(input.raw_body),
            provider_request_id: canonical_headers.provider_request_id,
            completed_at: input.completed_at,
        },
        client: ProviderResponseClientV3 {
            content_type: PROVIDER_RESPONSE_CLIENT_CONTENT_TYPE_V3.to_string(),
            headers_json: client_headers.headers_json,
            headers_length: client_headers.headers_length,
            headers_sha256: client_headers.headers_sha256,
            body_length: client_body.len() as u64,
            body_sha256: client_body_sha256,
            body_same_as_raw,
            body_base64: (!body_same_as_raw).then(|| encode_base64url_no_pad(&client_body)),
        },
        usage_receipt,
        provider_response_evidence_sha256: String::new(),
        client_response_artifact_sha256: String::new(),
    };
    let provider_attestation = provider_evidence_attestation_json_unchecked(&envelope)?;
    envelope.provider_response_evidence_sha256 = sha256_lower_hex(&provider_attestation);
    let usage_receipt_sha256 = usage_receipt_json.as_deref().map(sha256_lower_hex);
    let client_attestation =
        client_response_attestation_json_unchecked(&envelope, usage_receipt_sha256.as_deref())?;
    envelope.client_response_artifact_sha256 = sha256_lower_hex(&client_attestation);
    envelope.validate()?;
    if serialize_compact(&envelope)?.len() > MAX_PROVIDER_RESPONSE_ENVELOPE_BYTES_V3 {
        return Err(ProviderResponseV3Error::TooLarge("envelope"));
    }
    Ok(envelope)
}

pub fn parse_provider_response_v3(
    bytes: &[u8],
) -> Result<ProviderResponseEnvelopeV3, ProviderResponseV3Error> {
    if bytes.is_empty() {
        return Err(ProviderResponseV3Error::InvalidJson);
    }
    if bytes.len() > MAX_PROVIDER_RESPONSE_ENVELOPE_BYTES_V3 {
        return Err(ProviderResponseV3Error::TooLarge("envelope"));
    }
    let envelope: ProviderResponseEnvelopeV3 =
        serde_json::from_slice(bytes).map_err(|_| ProviderResponseV3Error::InvalidJson)?;
    envelope.validate()?;
    if serialize_compact(&envelope)? != bytes {
        return Err(ProviderResponseV3Error::NonCanonical);
    }
    Ok(envelope)
}

pub fn canonicalize_provider_response_headers_v3(
    headers: &[ProviderResponseHeaderV3<'_>],
) -> Result<CanonicalProviderResponseHeadersV3, ProviderResponseV3Error> {
    let projected = project_raw_headers(headers)?;
    canonical_headers_from_map(&projected)
}

fn project_raw_headers(
    headers: &[ProviderResponseHeaderV3<'_>],
) -> Result<BTreeMap<String, String>, ProviderResponseV3Error> {
    let mut projected = BTreeMap::new();
    for header in headers {
        if header.name != header.name.trim() || !header.name.is_ascii() {
            continue;
        }
        let name = header.name.to_ascii_lowercase();
        if PROVIDER_RESPONSE_V3_SAFE_RAW_HEADERS
            .binary_search(&name.as_str())
            .is_err()
        {
            continue;
        }
        if !valid_header_value(header.value)
            || (name == "content-type" && !valid_content_type(header.value))
            || (is_request_id_header(&name) && !valid_provider_request_id(header.value))
        {
            continue;
        }
        if projected
            .insert(name.clone(), header.value.to_string())
            .is_some()
        {
            return Err(ProviderResponseV3Error::DuplicateHeader(name));
        }
    }
    Ok(projected)
}

fn canonical_headers_from_map(
    headers: &BTreeMap<String, String>,
) -> Result<CanonicalProviderResponseHeadersV3, ProviderResponseV3Error> {
    let headers_json =
        serde_json::to_string(headers).map_err(|_| ProviderResponseV3Error::Serialization)?;
    if !(2..=MAX_PROVIDER_RESPONSE_HEADER_JSON_BYTES_V3).contains(&headers_json.len()) {
        return Err(ProviderResponseV3Error::TooLarge("headers_json"));
    }
    Ok(CanonicalProviderResponseHeadersV3 {
        content_type: headers.get("content-type").cloned(),
        headers_length: headers_json.len() as u64,
        headers_sha256: sha256_lower_hex(headers_json.as_bytes()),
        provider_request_id: provider_request_id_from_headers(headers),
        headers_json,
    })
}

fn client_headers(
    response_class: ProviderResponseWireClassV3,
    raw_headers: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut client = if response_class == ProviderResponseWireClassV3::Success {
        raw_headers
            .iter()
            .filter(|(name, _)| name.as_str() != "content-type")
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    } else {
        BTreeMap::new()
    };
    client.insert("cache-control".to_string(), "no-store".to_string());
    client.insert(
        "content-type".to_string(),
        PROVIDER_RESPONSE_CLIENT_CONTENT_TYPE_V3.to_string(),
    );
    client
}

#[derive(Debug, Clone, Copy)]
enum HeaderKind {
    Raw,
    Client,
}

fn validate_headers_json(
    headers_json: &str,
    declared_length: u64,
    expected_sha256: &str,
    kind: HeaderKind,
) -> Result<BTreeMap<String, String>, ProviderResponseV3Error> {
    if declared_length > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER
        || declared_length != headers_json.len() as u64
        || !(2..=MAX_PROVIDER_RESPONSE_HEADER_JSON_BYTES_V3).contains(&headers_json.len())
    {
        return Err(ProviderResponseV3Error::InvalidField(match kind {
            HeaderKind::Raw => "raw.headers_length",
            HeaderKind::Client => "client.headers_length",
        }));
    }
    require_sha256(
        expected_sha256,
        match kind {
            HeaderKind::Raw => "raw.headers_sha256",
            HeaderKind::Client => "client.headers_sha256",
        },
    )?;
    if sha256_lower_hex(headers_json.as_bytes()) != expected_sha256 {
        return Err(ProviderResponseV3Error::DigestMismatch(match kind {
            HeaderKind::Raw => "raw.headers_sha256",
            HeaderKind::Client => "client.headers_sha256",
        }));
    }
    let headers: BTreeMap<String, String> = serde_json::from_str(headers_json).map_err(|_| {
        ProviderResponseV3Error::InvalidField(match kind {
            HeaderKind::Raw => "raw.headers_json",
            HeaderKind::Client => "client.headers_json",
        })
    })?;
    let canonical =
        serde_json::to_string(&headers).map_err(|_| ProviderResponseV3Error::Serialization)?;
    if canonical != headers_json {
        return Err(ProviderResponseV3Error::NonCanonical);
    }
    let (allowed, maximum_count) = match kind {
        HeaderKind::Raw => (PROVIDER_RESPONSE_V3_SAFE_RAW_HEADERS, 6),
        HeaderKind::Client => (PROVIDER_RESPONSE_V3_SAFE_CLIENT_HEADERS, 7),
    };
    if headers.len() > maximum_count {
        return Err(ProviderResponseV3Error::InvalidField(match kind {
            HeaderKind::Raw => "raw.headers_json",
            HeaderKind::Client => "client.headers_json",
        }));
    }
    for (name, value) in &headers {
        if allowed.binary_search(&name.as_str()).is_err()
            || !valid_header_value(value)
            || (name == "content-type" && !valid_content_type(value))
            || (is_request_id_header(name) && !valid_provider_request_id(value))
        {
            return Err(ProviderResponseV3Error::InvalidField(match kind {
                HeaderKind::Raw => "raw.headers_json",
                HeaderKind::Client => "client.headers_json",
            }));
        }
    }
    Ok(headers)
}

fn validate_client_header_projection(
    response_class: ProviderResponseWireClassV3,
    raw_headers: &BTreeMap<String, String>,
    actual: &BTreeMap<String, String>,
    actual_json: &str,
) -> Result<(), ProviderResponseV3Error> {
    if response_class == ProviderResponseWireClassV3::Success {
        if &client_headers(response_class, raw_headers) != actual {
            return Err(ProviderResponseV3Error::InvalidField("client.headers_json"));
        }
    } else if actual_json != ERROR_CLIENT_HEADERS_JSON {
        return Err(ProviderResponseV3Error::InvalidField("client.headers_json"));
    }
    Ok(())
}

fn validate_identity(identity: &ProviderResponseIdentityV3) -> Result<(), ProviderResponseV3Error> {
    require_identifier(&identity.operation_id, "identity.operation_id")?;
    if identity.owner_generation > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER {
        return Err(ProviderResponseV3Error::InvalidField(
            "identity.owner_generation",
        ));
    }
    if identity.attempt_generation > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER {
        return Err(ProviderResponseV3Error::InvalidField(
            "identity.attempt_generation",
        ));
    }
    require_identifier(
        &identity.provider_operation_id,
        "identity.provider_operation_id",
    )?;
    require_sha256(&identity.request_sha256, "identity.request_sha256")?;
    if identity.egress_profile != PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE {
        return Err(ProviderResponseV3Error::InvalidField(
            "identity.egress_profile",
        ));
    }
    require_identifier(
        &identity.egress_worker_version_id,
        "identity.egress_worker_version_id",
    )?;
    Ok(())
}

fn validate_interpretation(
    interpretation: &ProviderResponseInterpretationV3,
    has_usage_receipt: bool,
) -> Result<(), ProviderResponseV3Error> {
    if interpretation.contract != PROVIDER_RESPONSE_INTERPRETER_CONTRACT {
        return Err(ProviderResponseV3Error::InvalidField(
            "interpretation.contract",
        ));
    }
    if interpretation.source_commit != PROVIDER_RESPONSE_INTERPRETER_SOURCE_COMMIT {
        return Err(ProviderResponseV3Error::InvalidField(
            "interpretation.source_commit",
        ));
    }
    for (status, field) in [
        (
            interpretation.provider_status,
            "interpretation.provider_status",
        ),
        (interpretation.client_status, "interpretation.client_status"),
        (interpretation.audit_status, "interpretation.audit_status"),
    ] {
        if !(100..=599).contains(&status) {
            return Err(ProviderResponseV3Error::InvalidField(field));
        }
    }
    let valid = match interpretation.response_class {
        ProviderResponseWireClassV3::Success => {
            interpretation.provider_status == 200
                && interpretation.client_status == 200
                && interpretation.audit_status == 200
        }
        ProviderResponseWireClassV3::TypedError => {
            interpretation.provider_status == 200
                && interpretation.client_status == 200
                && interpretation.audit_status == 500
                && !has_usage_receipt
        }
        ProviderResponseWireClassV3::HttpError => {
            interpretation.provider_status != 200
                && interpretation.client_status == interpretation.provider_status
                && interpretation.audit_status
                    == if interpretation.provider_status >= 400 {
                        interpretation.provider_status
                    } else {
                        500
                    }
                && !has_usage_receipt
        }
        ProviderResponseWireClassV3::InvalidBody => {
            interpretation.provider_status == 200
                && interpretation.client_status == 500
                && interpretation.audit_status == 500
                && !has_usage_receipt
        }
    };
    if !valid {
        return Err(ProviderResponseV3Error::InvalidField(
            "interpretation.response_class",
        ));
    }
    Ok(())
}

fn validate_receipt_binding(
    envelope: &ProviderResponseEnvelopeV3,
    receipt: &ProviderUsageReceiptV1,
) -> Result<(), ProviderResponseV3Error> {
    let identity = &envelope.identity;
    let raw = &envelope.raw;
    let matches = receipt.operation_id == identity.operation_id
        && u64::try_from(receipt.owner_generation).ok() == Some(identity.owner_generation)
        && u64::try_from(receipt.attempt_generation).ok() == Some(identity.attempt_generation)
        && receipt.provider_operation_id == identity.provider_operation_id
        && receipt.request_sha256 == identity.request_sha256
        && receipt.egress_profile == identity.egress_profile
        && receipt.egress_worker_version_id == identity.egress_worker_version_id
        && receipt.provider_response_status == envelope.interpretation.provider_status
        && receipt.provider_response_sha256 == raw.body_sha256
        && receipt.provider_request_id == raw.provider_request_id
        && u64::try_from(receipt.provider_completed_at).ok() == Some(raw.completed_at);
    if !matches {
        return Err(ProviderResponseV3Error::InvalidField("usage_receipt"));
    }
    Ok(())
}

fn provider_request_id_from_headers(headers: &BTreeMap<String, String>) -> Option<String> {
    first_safe_provider_request_id([
        headers.get("x-request-id").map(String::as_str),
        headers.get("openai-request-id").map(String::as_str),
        headers.get("request-id").map(String::as_str),
    ])
}

fn valid_header_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HEADER_VALUE_BYTES
        && value.is_ascii()
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn valid_content_type(value: &str) -> bool {
    let token_byte = |byte: u8| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
            )
    };
    let (media_type, parameters) = value
        .split_once(';')
        .map_or((value, None), |(media_type, parameters)| {
            (media_type, Some(parameters))
        });
    value == value.trim()
        && (3..=MAX_CONTENT_TYPE_BYTES).contains(&value.len())
        && value.is_ascii()
        && media_type.split_once('/').is_some_and(|(kind, subtype)| {
            !kind.is_empty()
                && !subtype.is_empty()
                && kind.bytes().all(token_byte)
                && subtype.bytes().all(token_byte)
        })
        && parameters.map_or(true, |parameters| {
            !parameters.is_empty() && parameters.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        })
}

fn is_request_id_header(name: &str) -> bool {
    matches!(name, "openai-request-id" | "request-id" | "x-request-id")
}

fn require_identifier(value: &str, field: &'static str) -> Result<(), ProviderResponseV3Error> {
    if !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
        })
    {
        Ok(())
    } else {
        Err(ProviderResponseV3Error::InvalidField(field))
    }
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), ProviderResponseV3Error> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ProviderResponseV3Error::InvalidField(field))
    }
}

fn decode_body_base64(
    encoded: &str,
    declared_length: u64,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<Vec<u8>, ProviderResponseV3Error> {
    if declared_length > PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER
        || declared_length < minimum as u64
        || declared_length > maximum as u64
    {
        return Err(ProviderResponseV3Error::InvalidField(match field {
            "raw.body_base64" => "raw.body_length",
            _ => "client.body_length",
        }));
    }
    let decoded_length = declared_length as usize;
    if encoded.len() != base64url_no_pad_encoded_len(decoded_length) {
        return Err(ProviderResponseV3Error::InvalidBase64(field));
    }
    let decoded =
        decode_base64url_no_pad(encoded).ok_or(ProviderResponseV3Error::InvalidBase64(field))?;
    if decoded.len() != decoded_length || encode_base64url_no_pad(&decoded) != encoded {
        return Err(ProviderResponseV3Error::InvalidBase64(field));
    }
    Ok(decoded)
}

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_base64url_no_pad(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(base64url_no_pad_encoded_len(bytes.len()));
    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let value = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        encoded.push(char::from(
            BASE64URL_ALPHABET[((value >> 18) & 0x3f) as usize],
        ));
        encoded.push(char::from(
            BASE64URL_ALPHABET[((value >> 12) & 0x3f) as usize],
        ));
        encoded.push(char::from(
            BASE64URL_ALPHABET[((value >> 6) & 0x3f) as usize],
        ));
        encoded.push(char::from(BASE64URL_ALPHABET[(value & 0x3f) as usize]));
    }
    match chunks.remainder() {
        [first] => {
            encoded.push(char::from(BASE64URL_ALPHABET[(first >> 2) as usize]));
            encoded.push(char::from(
                BASE64URL_ALPHABET[((first & 0x03) << 4) as usize],
            ));
        }
        [first, second] => {
            encoded.push(char::from(BASE64URL_ALPHABET[(first >> 2) as usize]));
            encoded.push(char::from(
                BASE64URL_ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize],
            ));
            encoded.push(char::from(
                BASE64URL_ALPHABET[((second & 0x0f) << 2) as usize],
            ));
        }
        [] => {}
        _ => unreachable!("chunks_exact remainder is shorter than three bytes"),
    }
    encoded
}

fn decode_base64url_no_pad(encoded: &str) -> Option<Vec<u8>> {
    let bytes = encoded.as_bytes();
    let remainder = bytes.len() % 4;
    if remainder == 1 {
        return None;
    }
    let decoded_length = bytes.len() / 4 * 3
        + match remainder {
            0 => 0,
            2 => 1,
            3 => 2,
            _ => return None,
        };
    let complete_length = bytes.len() - remainder;
    let mut decoded = Vec::with_capacity(decoded_length);
    for chunk in bytes[..complete_length].chunks_exact(4) {
        let first = base64url_value(chunk[0])?;
        let second = base64url_value(chunk[1])?;
        let third = base64url_value(chunk[2])?;
        let fourth = base64url_value(chunk[3])?;
        decoded.push((first << 2) | (second >> 4));
        decoded.push(((second & 0x0f) << 4) | (third >> 2));
        decoded.push(((third & 0x03) << 6) | fourth);
    }
    match &bytes[complete_length..] {
        [first, second] => {
            let first = base64url_value(*first)?;
            let second = base64url_value(*second)?;
            if second & 0x0f != 0 {
                return None;
            }
            decoded.push((first << 2) | (second >> 4));
        }
        [first, second, third] => {
            let first = base64url_value(*first)?;
            let second = base64url_value(*second)?;
            let third = base64url_value(*third)?;
            if third & 0x03 != 0 {
                return None;
            }
            decoded.push((first << 2) | (second >> 4));
            decoded.push(((second & 0x0f) << 4) | (third >> 2));
        }
        [] => {}
        _ => return None,
    }
    (decoded.len() == decoded_length).then_some(decoded)
}

const fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

const fn base64url_no_pad_encoded_len(decoded_length: usize) -> usize {
    decoded_length / 3 * 4
        + match decoded_length % 3 {
            0 => 0,
            1 => 2,
            _ => 3,
        }
}

fn serialize_compact<T: Serialize>(value: &T) -> Result<Vec<u8>, ProviderResponseV3Error> {
    serde_json::to_vec(value).map_err(|_| ProviderResponseV3Error::Serialization)
}

fn canonical_embedded_receipt_json(
    receipt: &ProviderUsageReceiptV1,
) -> Result<Vec<u8>, ProviderResponseV3Error> {
    let serialized = serialize_compact(receipt)?;
    if serialized.len() > MAX_PROVIDER_USAGE_RECEIPT_BYTES_V3 {
        return Err(ProviderResponseV3Error::TooLarge("usage_receipt"));
    }
    let canonical = receipt.to_canonical_json()?;
    if canonical != serialized {
        return Err(ProviderResponseV3Error::NonCanonical);
    }
    Ok(canonical)
}

fn sha256_lower_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Serialize)]
struct ProviderEvidenceAttestationV1<'a> {
    contract: &'static str,
    identity: &'a ProviderResponseIdentityV3,
    interpretation: &'a ProviderResponseInterpretationV3,
    raw: ProviderEvidenceRawAttestationV1<'a>,
}

#[derive(Serialize)]
struct ProviderEvidenceRawAttestationV1<'a> {
    content_type: Option<&'a str>,
    headers_length: u64,
    headers_sha256: &'a str,
    body_length: u64,
    body_sha256: &'a str,
    provider_request_id: Option<&'a str>,
    completed_at: u64,
}

fn provider_evidence_attestation_json_unchecked(
    envelope: &ProviderResponseEnvelopeV3,
) -> Result<Vec<u8>, ProviderResponseV3Error> {
    serialize_compact(&ProviderEvidenceAttestationV1 {
        contract: PROVIDER_EVIDENCE_ATTESTATION_CONTRACT_V1,
        identity: &envelope.identity,
        interpretation: &envelope.interpretation,
        raw: ProviderEvidenceRawAttestationV1 {
            content_type: envelope.raw.content_type.as_deref(),
            headers_length: envelope.raw.headers_length,
            headers_sha256: &envelope.raw.headers_sha256,
            body_length: envelope.raw.body_length,
            body_sha256: &envelope.raw.body_sha256,
            provider_request_id: envelope.raw.provider_request_id.as_deref(),
            completed_at: envelope.raw.completed_at,
        },
    })
}

#[derive(Serialize)]
struct ClientResponseAttestationV1<'a> {
    contract: &'static str,
    identity: &'a ProviderResponseIdentityV3,
    provider_response_evidence_sha256: &'a str,
    interpretation: &'a ProviderResponseInterpretationV3,
    client: ClientResponseAttestationFactsV1<'a>,
    usage_receipt_sha256: Option<&'a str>,
}

#[derive(Serialize)]
struct ClientResponseAttestationFactsV1<'a> {
    content_type: &'a str,
    headers_length: u64,
    headers_sha256: &'a str,
    body_length: u64,
    body_sha256: &'a str,
    body_same_as_raw: bool,
}

fn client_response_attestation_json_unchecked(
    envelope: &ProviderResponseEnvelopeV3,
    usage_receipt_sha256: Option<&str>,
) -> Result<Vec<u8>, ProviderResponseV3Error> {
    serialize_compact(&ClientResponseAttestationV1 {
        contract: CLIENT_RESPONSE_ATTESTATION_CONTRACT_V1,
        identity: &envelope.identity,
        provider_response_evidence_sha256: &envelope.provider_response_evidence_sha256,
        interpretation: &envelope.interpretation,
        client: ClientResponseAttestationFactsV1 {
            content_type: &envelope.client.content_type,
            headers_length: envelope.client.headers_length,
            headers_sha256: &envelope.client.headers_sha256,
            body_length: envelope.client.body_length,
            body_sha256: &envelope.client.body_sha256,
            body_same_as_raw: envelope.client.body_same_as_raw,
        },
        usage_receipt_sha256,
    })
}

pub const PROVIDER_RESPONSE_V3_CORPUS_EXACT_200: &str = "exact_200";
pub const PROVIDER_RESPONSE_V3_CORPUS_TYPED_200: &str = "typed_200";
pub const PROVIDER_RESPONSE_V3_CORPUS_HTTP_202: &str = "http_202";
pub const PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY: &str = "invalid_body";
pub const PROVIDER_RESPONSE_V3_CORPUS_FIXTURE_NAMES: &[&str] = &[
    PROVIDER_RESPONSE_V3_CORPUS_EXACT_200,
    PROVIDER_RESPONSE_V3_CORPUS_TYPED_200,
    PROVIDER_RESPONSE_V3_CORPUS_HTTP_202,
    PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderResponseV3CorpusDigests {
    pub canonical_envelope_sha256: &'static str,
    pub provider_response_evidence_sha256: &'static str,
    pub client_response_artifact_sha256: &'static str,
    pub usage_receipt_sha256: Option<&'static str>,
}

pub const PROVIDER_RESPONSE_V3_CORPUS_EXACT_200_DIGESTS: ProviderResponseV3CorpusDigests =
    ProviderResponseV3CorpusDigests {
        canonical_envelope_sha256:
            "e4b278bd5f0e63d4fded93365ecb83acb4ca2b746f26c327f97f5dfa1a897c5e",
        provider_response_evidence_sha256:
            "794b6d7568c2491ecd8afee9bac0b23d4297cfdb2e41c984a79aee5bc8727ee3",
        client_response_artifact_sha256:
            "95c583b95fef6da49b1f18e35358212799e24ab3bca3ed78f6190dc6ffbb6dbe",
        usage_receipt_sha256: Some(
            "ac8f9f89afbd5eff11058ec3eac2450a381f41d82dae305aab0328f5cf91e9c4",
        ),
    };
pub const PROVIDER_RESPONSE_V3_CORPUS_TYPED_200_DIGESTS: ProviderResponseV3CorpusDigests =
    ProviderResponseV3CorpusDigests {
        canonical_envelope_sha256:
            "83c7cf50d4d6d26de699eeda5f4c35d3cce3027087c9f4e02076b46139b21a2d",
        provider_response_evidence_sha256:
            "3d47257f32905d382f84c9e64a0a4a456bab2677673b22a118b4ecceb66c5947",
        client_response_artifact_sha256:
            "47dd3f6c78e833c689d566cbce15e724449fd9548402aa457313419b554e46fe",
        usage_receipt_sha256: None,
    };
pub const PROVIDER_RESPONSE_V3_CORPUS_HTTP_202_DIGESTS: ProviderResponseV3CorpusDigests =
    ProviderResponseV3CorpusDigests {
        canonical_envelope_sha256:
            "efca2467e1b44c5db5c64bf6028d47f82d5ce222ebf80888390be7479bec6e4e",
        provider_response_evidence_sha256:
            "23de95e9470f41b9c362b82731556e2a9f97574acdd2ae4b8062f814f90841e7",
        client_response_artifact_sha256:
            "8eb419bb5fbced3743fe5a451acc42f7978effb673e322b10188c898bb39ecb0",
        usage_receipt_sha256: None,
    };
pub const PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY_DIGESTS: ProviderResponseV3CorpusDigests =
    ProviderResponseV3CorpusDigests {
        canonical_envelope_sha256:
            "de5019b6b0f661a32c2b282a7de82c9978772dbe363e1442d62742fc6f235858",
        provider_response_evidence_sha256:
            "fe3ec0c935b62309724d379248fea23ad2ce570f8adf1a76b43dcd6abbaab1c4",
        client_response_artifact_sha256:
            "8de579b6470df7d6aa0f6f750dc68d2347ee3a77c8fda2bec4df1bad6312cabe",
        usage_receipt_sha256: None,
    };

pub fn provider_response_v3_corpus_expected_digests(
    name: &str,
) -> Option<ProviderResponseV3CorpusDigests> {
    match name {
        PROVIDER_RESPONSE_V3_CORPUS_EXACT_200 => {
            Some(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200_DIGESTS)
        }
        PROVIDER_RESPONSE_V3_CORPUS_TYPED_200 => {
            Some(PROVIDER_RESPONSE_V3_CORPUS_TYPED_200_DIGESTS)
        }
        PROVIDER_RESPONSE_V3_CORPUS_HTTP_202 => Some(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202_DIGESTS),
        PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY => {
            Some(PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY_DIGESTS)
        }
        _ => None,
    }
}

pub const PROVIDER_RESPONSE_V3_CORPUS_REQUEST_SHA256: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
pub const PROVIDER_RESPONSE_V3_CORPUS_COMPLETED_AT: u64 = 1_784_313_600_000;
pub const PROVIDER_RESPONSE_V3_CORPUS_EXACT_200_BODY: &[u8] =
    br#"{"id":"chatcmpl-1","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}"#;
pub const PROVIDER_RESPONSE_V3_CORPUS_TYPED_200_BODY: &[u8] =
    br#"{"error":{"message":"rate limited","type":"rate_limit_error","param":"model","code":429},"provider_trace":"raw-only"}"#;
pub const PROVIDER_RESPONSE_V3_CORPUS_HTTP_202_BODY: &[u8] = br#"{"id":"queued"}"#;
pub const PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY_BYTES: &[u8] = &[0xff, 0x00];

const CORPUS_EXACT_HEADERS: &[ProviderResponseHeaderV3<'static>] = &[
    ProviderResponseHeaderV3::new("Content-Type", "application/json"),
    ProviderResponseHeaderV3::new("X-Request-ID", "request-exact-200"),
    ProviderResponseHeaderV3::new("Set-Cookie", "secret=discarded"),
];
const CORPUS_TYPED_HEADERS: &[ProviderResponseHeaderV3<'static>] = &[
    ProviderResponseHeaderV3::new("content-type", "application/json; charset=utf-8"),
    ProviderResponseHeaderV3::new("openai-request-id", "request-typed-200"),
    ProviderResponseHeaderV3::new("authorization", "Bearer discarded"),
];
const CORPUS_HTTP_202_HEADERS: &[ProviderResponseHeaderV3<'static>] = &[
    ProviderResponseHeaderV3::new("Content-Type", "application/json"),
    ProviderResponseHeaderV3::new("Retry-After", "2"),
    ProviderResponseHeaderV3::new("Request-Id", "request-http-202"),
];
const CORPUS_INVALID_HEADERS: &[ProviderResponseHeaderV3<'static>] = &[
    ProviderResponseHeaderV3::new("Content-Type", "application/json"),
    ProviderResponseHeaderV3::new("X-Request-Id", "request-invalid-body"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderResponseV3CorpusFixture {
    pub name: &'static str,
    pub expected_digests: ProviderResponseV3CorpusDigests,
    pub canonical_envelope_json: Vec<u8>,
    pub raw_body: Vec<u8>,
    pub client_body: Vec<u8>,
    pub usage_receipt_json: Option<Vec<u8>>,
    pub provider_evidence_attestation_json: Vec<u8>,
    pub client_response_attestation_json: Vec<u8>,
}

pub fn provider_response_v3_corpus_fixture(
    name: &str,
) -> Result<Option<ProviderResponseV3CorpusFixture>, ProviderResponseV3Error> {
    let (status, headers, raw_body, include_usage_receipt) = match name {
        PROVIDER_RESPONSE_V3_CORPUS_EXACT_200 => (
            200,
            CORPUS_EXACT_HEADERS,
            PROVIDER_RESPONSE_V3_CORPUS_EXACT_200_BODY,
            true,
        ),
        PROVIDER_RESPONSE_V3_CORPUS_TYPED_200 => (
            200,
            CORPUS_TYPED_HEADERS,
            PROVIDER_RESPONSE_V3_CORPUS_TYPED_200_BODY,
            false,
        ),
        PROVIDER_RESPONSE_V3_CORPUS_HTTP_202 => (
            202,
            CORPUS_HTTP_202_HEADERS,
            PROVIDER_RESPONSE_V3_CORPUS_HTTP_202_BODY,
            false,
        ),
        PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY => (
            200,
            CORPUS_INVALID_HEADERS,
            PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY_BYTES,
            false,
        ),
        _ => return Ok(None),
    };
    let operation_id = match name {
        PROVIDER_RESPONSE_V3_CORPUS_EXACT_200 => "corpus-operation-exact-200",
        PROVIDER_RESPONSE_V3_CORPUS_TYPED_200 => "corpus-operation-typed-200",
        PROVIDER_RESPONSE_V3_CORPUS_HTTP_202 => "corpus-operation-http-202",
        _ => "corpus-operation-invalid-body",
    };
    let envelope = build_provider_response_v3(ProviderResponseEnvelopeV3Input {
        operation_id,
        owner_generation: 2,
        attempt_generation: 1,
        provider_operation_id: "corpus-provider-operation-1",
        request_sha256: PROVIDER_RESPONSE_V3_CORPUS_REQUEST_SHA256,
        egress_profile: PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE,
        egress_worker_version_id: "corpus-worker-version-1",
        provider_status: status,
        raw_headers: headers,
        raw_body,
        completed_at: PROVIDER_RESPONSE_V3_CORPUS_COMPLETED_AT,
        include_usage_receipt,
    })?;
    Ok(Some(ProviderResponseV3CorpusFixture {
        name: PROVIDER_RESPONSE_V3_CORPUS_FIXTURE_NAMES
            .iter()
            .copied()
            .find(|candidate| *candidate == name)
            .expect("matched corpus fixture name"),
        expected_digests: provider_response_v3_corpus_expected_digests(name)
            .expect("matched corpus fixture digests"),
        canonical_envelope_json: envelope.to_canonical_json()?,
        raw_body: raw_body.to_vec(),
        client_body: envelope.decoded_client_body()?,
        usage_receipt_json: envelope.decoded_usage_receipt_json()?,
        provider_evidence_attestation_json: envelope.provider_evidence_attestation_json()?,
        client_response_attestation_json: envelope.client_response_attestation_json()?,
    }))
}

pub fn provider_response_v3_corpus_fixtures(
) -> Result<Vec<ProviderResponseV3CorpusFixture>, ProviderResponseV3Error> {
    PROVIDER_RESPONSE_V3_CORPUS_FIXTURE_NAMES
        .iter()
        .map(|name| {
            provider_response_v3_corpus_fixture(name)?
                .ok_or(ProviderResponseV3Error::InvalidField("corpus.name"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(name: &str) -> ProviderResponseV3CorpusFixture {
        provider_response_v3_corpus_fixture(name)
            .expect("fixture build")
            .expect("known fixture")
    }

    fn envelope(name: &str) -> ProviderResponseEnvelopeV3 {
        let fixture = fixture(name);
        parse_provider_response_v3(&fixture.canonical_envelope_json).expect("fixture parse")
    }

    fn base_input<'a>(
        raw_headers: &'a [ProviderResponseHeaderV3<'a>],
        raw_body: &'a [u8],
    ) -> ProviderResponseEnvelopeV3Input<'a> {
        ProviderResponseEnvelopeV3Input {
            operation_id: "operation-1",
            owner_generation: 2,
            attempt_generation: 1,
            provider_operation_id: "provider-operation-1",
            request_sha256: PROVIDER_RESPONSE_V3_CORPUS_REQUEST_SHA256,
            egress_profile: PROVIDER_USAGE_RECEIPT_EGRESS_PROFILE,
            egress_worker_version_id: "worker-version-1",
            provider_status: 200,
            raw_headers,
            raw_body,
            completed_at: PROVIDER_RESPONSE_V3_CORPUS_COMPLETED_AT,
            include_usage_receipt: false,
        }
    }

    fn refresh_attestations(envelope: &mut ProviderResponseEnvelopeV3) {
        envelope.provider_response_evidence_sha256 = sha256_lower_hex(
            &provider_evidence_attestation_json_unchecked(envelope).expect("provider attestation"),
        );
        let receipt_sha256 = envelope
            .usage_receipt
            .as_ref()
            .map(|receipt| canonical_embedded_receipt_json(receipt).expect("receipt canonical"))
            .as_deref()
            .map(sha256_lower_hex);
        envelope.client_response_artifact_sha256 = sha256_lower_hex(
            &client_response_attestation_json_unchecked(envelope, receipt_sha256.as_deref())
                .expect("client attestation"),
        );
    }

    #[test]
    fn exact_200_is_canonical_deduplicated_and_receipted() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200);
        let envelope = parse_provider_response_v3(&fixture.canonical_envelope_json).expect("parse");
        assert_eq!(
            envelope.interpretation.response_class,
            ProviderResponseWireClassV3::Success
        );
        assert_eq!(envelope.interpretation.provider_status, 200);
        assert_eq!(envelope.interpretation.client_status, 200);
        assert_eq!(envelope.interpretation.audit_status, 200);
        assert!(envelope.client.body_same_as_raw);
        assert_eq!(envelope.client.body_base64, None);
        assert_eq!(fixture.raw_body, fixture.client_body);
        assert!(fixture.usage_receipt_json.is_some());
        let envelope_text = str::from_utf8(&fixture.canonical_envelope_json).expect("UTF-8");
        let receipt_text =
            str::from_utf8(fixture.usage_receipt_json.as_deref().expect("receipt JSON"))
                .expect("receipt UTF-8");
        assert!(
            serde_json::from_slice::<Value>(&fixture.canonical_envelope_json)
                .expect("envelope value")
                .get("usage_receipt")
                .is_some_and(Value::is_object)
        );
        assert!(envelope_text.contains(&format!(
            r#""usage_receipt":{receipt_text},"provider_response_evidence_sha256":"#
        )));
        assert!(!envelope_text.contains(r#""usage_receipt":""#));
        assert!(receipt_text.starts_with(
            r#"{"schema_version":1,"parser_contract":"openai-chat-completions-usage-v1""#
        ));
        assert_eq!(
            envelope.raw.headers_json,
            r#"{"content-type":"application/json","x-request-id":"request-exact-200"}"#
        );
        assert_eq!(
            envelope.client.headers_json,
            r#"{"cache-control":"no-store","content-type":"application/json","x-request-id":"request-exact-200"}"#
        );
        assert_eq!(
            envelope.to_canonical_json().expect("canonical"),
            fixture.canonical_envelope_json
        );
        assert_eq!(
            sha256_lower_hex(&fixture.provider_evidence_attestation_json),
            envelope.provider_response_evidence_sha256
        );
        assert_eq!(
            sha256_lower_hex(&fixture.client_response_attestation_json),
            envelope.client_response_artifact_sha256
        );
        assert_eq!(
            envelope
                .provider_evidence_attestation_sha256()
                .expect("provider digest"),
            envelope.provider_response_evidence_sha256
        );
        assert_eq!(
            envelope
                .client_response_attestation_sha256()
                .expect("client digest"),
            envelope.client_response_artifact_sha256
        );
        assert!(str::from_utf8(&fixture.provider_evidence_attestation_json)
            .expect("UTF-8")
            .starts_with(r#"{"contract":"cinatoken-provider-evidence-attestation-v1","identity":{"operation_id":"#));
        assert!(str::from_utf8(&fixture.client_response_attestation_json)
            .expect("UTF-8")
            .starts_with(r#"{"contract":"cinatoken-client-response-attestation-v1","identity":{"operation_id":"#));
    }

    #[test]
    fn typed_200_is_a_receiptless_rebuilt_client_artifact() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_TYPED_200);
        let envelope = parse_provider_response_v3(&fixture.canonical_envelope_json).expect("parse");
        assert_eq!(
            envelope.interpretation.response_class,
            ProviderResponseWireClassV3::TypedError
        );
        assert_eq!(envelope.interpretation.provider_status, 200);
        assert_eq!(envelope.interpretation.client_status, 200);
        assert_eq!(envelope.interpretation.audit_status, 500);
        assert_eq!(envelope.usage_receipt, None);
        assert!(!envelope.client.body_same_as_raw);
        assert_eq!(
            fixture.client_body,
            br#"{"error":{"message":"rate limited","type":"rate_limit_error","param":"model","code":429}}"#
        );
        assert_eq!(envelope.client.headers_json, ERROR_CLIENT_HEADERS_JSON);
    }

    #[test]
    fn http_202_is_never_success() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        let envelope = parse_provider_response_v3(&fixture.canonical_envelope_json).expect("parse");
        assert_eq!(
            envelope.interpretation.response_class,
            ProviderResponseWireClassV3::HttpError
        );
        assert_eq!(envelope.interpretation.provider_status, 202);
        assert_eq!(envelope.interpretation.client_status, 202);
        assert_eq!(envelope.interpretation.audit_status, 500);
        assert_eq!(envelope.usage_receipt, None);
        assert_eq!(
            fixture.client_body,
            br#"{"error":{"message":"bad response status code 202","type":"bad_response_status_code","param":"","code":"bad_response_status_code"}}"#
        );
        assert_eq!(envelope.client.headers_json, ERROR_CLIENT_HEADERS_JSON);
    }

    #[test]
    fn invalid_utf8_body_remains_raw_evidence() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY);
        let envelope = parse_provider_response_v3(&fixture.canonical_envelope_json).expect("parse");
        assert_eq!(
            envelope.interpretation.response_class,
            ProviderResponseWireClassV3::InvalidBody
        );
        assert_eq!(envelope.interpretation.provider_status, 200);
        assert_eq!(envelope.interpretation.client_status, 500);
        assert_eq!(envelope.interpretation.audit_status, 500);
        assert_eq!(fixture.raw_body, [0xff, 0x00]);
        assert_eq!(envelope.raw.body_base64, "_wA");
        assert_eq!(
            fixture.client_body,
            br#"{"error":{"message":"invalid upstream JSON response","type":"bad_response_body","param":"","code":"bad_response_body"}}"#
        );
    }

    #[test]
    fn headers_are_projected_lowercase_sorted_and_bounded() {
        let value_1024 = "x".repeat(MAX_HEADER_VALUE_BYTES);
        let value_1025 = "y".repeat(MAX_HEADER_VALUE_BYTES + 1);
        let headers = [
            ProviderResponseHeaderV3::new("X-Request-ID", "request-1"),
            ProviderResponseHeaderV3::new("Authorization", "Bearer secret"),
            ProviderResponseHeaderV3::new("CONTENT-LANGUAGE", &value_1024),
            ProviderResponseHeaderV3::new("Retry-After", &value_1025),
            ProviderResponseHeaderV3::new("Request-Id", "unsafe request id"),
            ProviderResponseHeaderV3::new("Content-Type", "application/json"),
        ];
        let canonical = canonicalize_provider_response_headers_v3(&headers).expect("headers");
        assert_eq!(canonical.content_type.as_deref(), Some("application/json"));
        assert_eq!(canonical.provider_request_id.as_deref(), Some("request-1"));
        assert_eq!(
            canonical.headers_json,
            format!(
                r#"{{"content-language":"{value_1024}","content-type":"application/json","x-request-id":"request-1"}}"#
            )
        );
        assert_eq!(
            canonical.headers_length,
            canonical.headers_json.len() as u64
        );
        assert_eq!(
            canonical.headers_sha256,
            sha256_lower_hex(canonical.headers_json.as_bytes())
        );

        let duplicate = [
            ProviderResponseHeaderV3::new("X-Request-ID", "one"),
            ProviderResponseHeaderV3::new("x-request-id", "two"),
        ];
        assert_eq!(
            canonicalize_provider_response_headers_v3(&duplicate),
            Err(ProviderResponseV3Error::DuplicateHeader(
                "x-request-id".to_string()
            ))
        );
    }

    #[test]
    fn base64url_codec_matches_rfc4648_vectors_and_rejects_aliases() {
        for (decoded, encoded) in [
            (b"".as_slice(), ""),
            (b"f".as_slice(), "Zg"),
            (b"fo".as_slice(), "Zm8"),
            (b"foo".as_slice(), "Zm9v"),
            (b"foob".as_slice(), "Zm9vYg"),
            (b"fooba".as_slice(), "Zm9vYmE"),
            (b"foobar".as_slice(), "Zm9vYmFy"),
            ([0xfb, 0xff].as_slice(), "-_8"),
        ] {
            assert_eq!(encode_base64url_no_pad(decoded), encoded);
            assert_eq!(decode_base64url_no_pad(encoded).as_deref(), Some(decoded));
        }

        let all_bytes = (0..=u8::MAX).collect::<Vec<_>>();
        let encoded = encode_base64url_no_pad(&all_bytes);
        assert_eq!(decode_base64url_no_pad(&encoded), Some(all_bytes));
        for invalid in ["A", "Zg==", "Zg+", "Zg/", "Zh", "Zm9", "é"] {
            assert_eq!(decode_base64url_no_pad(invalid), None, "accepted {invalid}");
        }
    }

    #[test]
    fn parser_rejects_order_unknown_duplicate_and_whitespace_drift() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        let value: Value = serde_json::from_slice(&fixture.canonical_envelope_json).expect("value");
        let reordered = serde_json::to_vec(&value).expect("reordered JSON");
        assert_ne!(reordered, fixture.canonical_envelope_json);
        assert_eq!(
            parse_provider_response_v3(&reordered),
            Err(ProviderResponseV3Error::NonCanonical)
        );

        let canonical = str::from_utf8(&fixture.canonical_envelope_json).expect("UTF-8");
        let unknown = canonical.replacen(
            r#"{"protocol_version":3,"identity":"#,
            r#"{"protocol_version":3,"unexpected":true,"identity":"#,
            1,
        );
        assert_eq!(
            parse_provider_response_v3(unknown.as_bytes()),
            Err(ProviderResponseV3Error::InvalidJson)
        );
        let duplicate = canonical.replacen(
            r#"{"protocol_version":3,"identity":"#,
            r#"{"protocol_version":3,"protocol_version":3,"identity":"#,
            1,
        );
        assert_eq!(
            parse_provider_response_v3(duplicate.as_bytes()),
            Err(ProviderResponseV3Error::InvalidJson)
        );
        let missing = canonical.replacen(r#""usage_receipt":null,"#, "", 1);
        assert_eq!(
            parse_provider_response_v3(missing.as_bytes()),
            Err(ProviderResponseV3Error::NonCanonical)
        );
        let whitespace = format!(" {canonical}");
        assert_eq!(
            parse_provider_response_v3(whitespace.as_bytes()),
            Err(ProviderResponseV3Error::NonCanonical)
        );
        assert_eq!(
            parse_provider_response_v3(&[0xff]),
            Err(ProviderResponseV3Error::InvalidJson)
        );
    }

    #[test]
    fn parser_rejects_base64_digest_receipt_and_dedupe_tampering() {
        let mut invalid_base64 = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        invalid_base64.raw.body_base64.push('=');
        assert_eq!(
            invalid_base64.validate(),
            Err(ProviderResponseV3Error::InvalidBase64("raw.body_base64"))
        );

        let mut non_url_alphabet = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        non_url_alphabet.raw.body_base64.replace_range(0..1, "+");
        assert_eq!(
            non_url_alphabet.validate(),
            Err(ProviderResponseV3Error::InvalidBase64("raw.body_base64"))
        );

        let mut noncanonical_trailing_bits = envelope(PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY);
        noncanonical_trailing_bits
            .raw
            .body_base64
            .replace_range(2..3, "B");
        assert_eq!(
            noncanonical_trailing_bits.validate(),
            Err(ProviderResponseV3Error::InvalidBase64("raw.body_base64"))
        );

        let mut overflowing_length = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        overflowing_length.raw.body_length = MAX_PROVIDER_RESPONSE_BODY_BYTES_V3 as u64 + 1;
        assert_eq!(
            overflowing_length.validate(),
            Err(ProviderResponseV3Error::InvalidField("raw.body_length"))
        );

        let mut body_tamper = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        body_tamper.raw.body_base64.replace_range(0..1, "Z");
        assert_eq!(
            body_tamper.validate(),
            Err(ProviderResponseV3Error::DigestMismatch("raw.body_sha256"))
        );

        let mut digest_tamper = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        digest_tamper.provider_response_evidence_sha256 = "0".repeat(64);
        assert_eq!(
            digest_tamper.validate(),
            Err(ProviderResponseV3Error::DigestMismatch(
                "provider_response_evidence_sha256"
            ))
        );

        let success = envelope(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200);
        let mut receipt_tamper = success.clone();
        receipt_tamper
            .usage_receipt
            .as_mut()
            .expect("receipt")
            .operation_id = "corpus-operation-other-000".to_string();
        assert_eq!(
            receipt_tamper.validate(),
            Err(ProviderResponseV3Error::InvalidField("usage_receipt"))
        );

        let mut redundant = success;
        redundant.client.body_same_as_raw = false;
        redundant.client.body_base64 = Some(redundant.raw.body_base64.clone());
        assert_eq!(
            redundant.validate(),
            Err(ProviderResponseV3Error::InvalidField(
                "client.body_same_as_raw"
            ))
        );
    }

    #[test]
    fn embedded_receipt_key_order_is_part_of_the_envelope_canonical_bytes() {
        let fixture = fixture(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200);
        let canonical = str::from_utf8(&fixture.canonical_envelope_json).expect("UTF-8");
        let receipt = str::from_utf8(fixture.usage_receipt_json.as_deref().expect("receipt JSON"))
            .expect("receipt UTF-8");
        let receipt_value: Value = serde_json::from_str(receipt).expect("receipt value");
        let reordered_receipt = serde_json::to_string(&receipt_value).expect("reordered receipt");
        assert_ne!(reordered_receipt, receipt);
        let reordered_envelope = canonical.replacen(receipt, &reordered_receipt, 1);
        assert_eq!(
            parse_provider_response_v3(reordered_envelope.as_bytes()),
            Err(ProviderResponseV3Error::NonCanonical)
        );
    }

    #[test]
    fn response_class_and_receipt_constraints_fail_closed() {
        let success = envelope(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200);
        let receipt = success.usage_receipt.clone();

        let mut typed = envelope(PROVIDER_RESPONSE_V3_CORPUS_TYPED_200);
        typed.usage_receipt = receipt;
        assert_eq!(
            typed.validate(),
            Err(ProviderResponseV3Error::InvalidField(
                "interpretation.response_class"
            ))
        );

        let mut http = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        http.interpretation.client_status = 200;
        assert_eq!(
            http.validate(),
            Err(ProviderResponseV3Error::InvalidField(
                "interpretation.response_class"
            ))
        );

        let mut invalid = envelope(PROVIDER_RESPONSE_V3_CORPUS_INVALID_BODY);
        invalid.interpretation.audit_status = 200;
        assert_eq!(
            invalid.validate(),
            Err(ProviderResponseV3Error::InvalidField(
                "interpretation.response_class"
            ))
        );
    }

    #[test]
    fn raw_body_and_javascript_integer_boundaries_are_enforced() {
        let headers = [ProviderResponseHeaderV3::new(
            "content-type",
            "application/json",
        )];
        let mut maximum_body = Vec::with_capacity(MAX_PROVIDER_RESPONSE_BODY_BYTES_V3);
        maximum_body.extend_from_slice(b"{}");
        maximum_body.resize(MAX_PROVIDER_RESPONSE_BODY_BYTES_V3, b' ');
        let maximum =
            build_provider_response_v3(base_input(&headers, &maximum_body)).expect("maximum body");
        assert_eq!(
            maximum.raw.body_length,
            MAX_PROVIDER_RESPONSE_BODY_BYTES_V3 as u64
        );
        assert_eq!(maximum.client.body_length, maximum.raw.body_length);

        let oversized = vec![b' '; MAX_PROVIDER_RESPONSE_BODY_BYTES_V3 + 1];
        assert_eq!(
            build_provider_response_v3(base_input(&headers, &oversized)),
            Err(ProviderResponseV3Error::TooLarge("raw.body"))
        );

        let mut safe_integer = base_input(&headers, b"{}");
        safe_integer.owner_generation = PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER;
        assert!(build_provider_response_v3(safe_integer).is_ok());
        safe_integer.owner_generation = PROVIDER_RESPONSE_V3_MAX_JS_SAFE_INTEGER + 1;
        assert_eq!(
            build_provider_response_v3(safe_integer),
            Err(ProviderResponseV3Error::InvalidField(
                "identity.owner_generation"
            ))
        );

        let empty_raw = build_provider_response_v3(base_input(&headers, b"")).expect("empty raw");
        assert_eq!(empty_raw.raw.body_length, 0);
        assert_eq!(empty_raw.raw.body_base64, "");
        assert_eq!(
            empty_raw.interpretation.response_class,
            ProviderResponseWireClassV3::InvalidBody
        );
    }

    #[test]
    fn all_shared_corpus_fixtures_roundtrip_exactly() {
        let fixtures = provider_response_v3_corpus_fixtures().expect("fixtures");
        assert_eq!(
            fixtures.len(),
            PROVIDER_RESPONSE_V3_CORPUS_FIXTURE_NAMES.len()
        );
        for fixture in fixtures {
            let parsed = parse_provider_response_v3(&fixture.canonical_envelope_json)
                .unwrap_or_else(|error| panic!("{} failed: {error}", fixture.name));
            assert_eq!(
                sha256_lower_hex(&fixture.canonical_envelope_json),
                fixture.expected_digests.canonical_envelope_sha256,
                "{} envelope digest drifted",
                fixture.name
            );
            assert_eq!(
                parsed.provider_response_evidence_sha256,
                fixture.expected_digests.provider_response_evidence_sha256,
                "{} provider evidence digest drifted",
                fixture.name
            );
            assert_eq!(
                parsed.client_response_artifact_sha256,
                fixture.expected_digests.client_response_artifact_sha256,
                "{} client artifact digest drifted",
                fixture.name
            );
            assert_eq!(
                fixture
                    .usage_receipt_json
                    .as_deref()
                    .map(sha256_lower_hex)
                    .as_deref(),
                fixture.expected_digests.usage_receipt_sha256,
                "{} usage receipt digest drifted",
                fixture.name
            );
            assert_eq!(parsed.decoded_raw_body().expect("raw"), fixture.raw_body);
            assert_eq!(
                parsed.decoded_client_body().expect("client"),
                fixture.client_body
            );
            assert_eq!(
                parsed.decoded_usage_receipt_json().expect("receipt"),
                fixture.usage_receipt_json
            );
            assert_eq!(
                parsed
                    .provider_evidence_attestation_json()
                    .expect("provider attestation"),
                fixture.provider_evidence_attestation_json
            );
            assert_eq!(
                parsed
                    .client_response_attestation_json()
                    .expect("client attestation"),
                fixture.client_response_attestation_json
            );
            assert_eq!(
                parsed.to_canonical_json().expect("canonical"),
                fixture.canonical_envelope_json
            );
        }
        assert!(provider_response_v3_corpus_fixture("unknown")
            .expect("unknown lookup")
            .is_none());
    }

    #[test]
    fn attestation_field_order_and_domains_are_exact() {
        let envelope = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        let provider = String::from_utf8(
            provider_evidence_attestation_json_unchecked(&envelope).expect("provider"),
        )
        .expect("UTF-8");
        assert!(provider.contains(r#""raw":{"content_type":"application/json","headers_length":"#));
        assert!(!provider.contains("headers_json"));
        assert!(!provider.contains("body_base64"));
        assert!(!provider.contains("provider_response_evidence_sha256"));

        let client = String::from_utf8(
            client_response_attestation_json_unchecked(&envelope, None).expect("client"),
        )
        .expect("UTF-8");
        assert!(client.contains(r#""provider_response_evidence_sha256":"#));
        assert!(client.contains(r#""client":{"content_type":"application/json","headers_length":"#));
        assert!(client.ends_with(r#""usage_receipt_sha256":null}"#));
        assert!(!client.contains("headers_json"));
        assert!(!client.contains("body_base64"));
        assert!(!client.contains("client_response_artifact_sha256"));
    }

    #[test]
    fn refreshing_attestations_does_not_authorize_contradictory_metadata() {
        let mut envelope = envelope(PROVIDER_RESPONSE_V3_CORPUS_HTTP_202);
        envelope.raw.completed_at += 1;
        refresh_attestations(&mut envelope);
        assert!(envelope.validate().is_ok());

        envelope.interpretation.response_class = ProviderResponseWireClassV3::Success;
        envelope.interpretation.provider_status = 200;
        envelope.interpretation.client_status = 200;
        envelope.interpretation.audit_status = 200;
        assert_eq!(
            envelope.validate(),
            Err(ProviderResponseV3Error::InvalidField("client.headers_json"))
        );
    }

    #[test]
    fn receipt_builder_rejects_non_success_even_when_requested() {
        let headers = [ProviderResponseHeaderV3::new(
            "content-type",
            "application/json",
        )];
        let mut input = base_input(&headers, PROVIDER_RESPONSE_V3_CORPUS_TYPED_200_BODY);
        input.include_usage_receipt = true;
        assert_eq!(
            build_provider_response_v3(input),
            Err(ProviderResponseV3Error::InvalidField(
                "interpretation.response_class"
            ))
        );
    }

    #[test]
    fn envelope_and_embedded_receipt_size_bounds_are_checked() {
        let oversized_envelope = vec![b' '; MAX_PROVIDER_RESPONSE_ENVELOPE_BYTES_V3 + 1];
        assert_eq!(
            parse_provider_response_v3(&oversized_envelope),
            Err(ProviderResponseV3Error::TooLarge("envelope"))
        );

        let mut success = envelope(PROVIDER_RESPONSE_V3_CORPUS_EXACT_200);
        success
            .usage_receipt
            .as_mut()
            .expect("receipt")
            .operation_id = "x".repeat(MAX_PROVIDER_USAGE_RECEIPT_BYTES_V3);
        assert_eq!(
            success.validate(),
            Err(ProviderResponseV3Error::TooLarge("usage_receipt"))
        );
    }
}
