use crate::release::{canonical_json, reject_duplicate_json, MAX_SAFE_INTEGER};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt;

pub const MAX_DEPLOYMENTS_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TARGET_VERSION_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MIN_OBSERVATION_SECONDS: u64 = 5;
pub const MAX_OBSERVATION_SECONDS: u64 = 120;
pub const MAX_MUTATION_ANNOTATION_BYTES: usize = 256;
pub const READBACK_EVIDENCE_CONTRACT: &str =
    "cinatoken-ring-transition-runner-stable-readback-evidence-v1";
pub const BASELINE_READBACK_EVIDENCE_CONTRACT: &str =
    "cinatoken-ring-transition-runner-stable-baseline-readback-evidence-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadbackClassification {
    Confirmed,
    TargetNotStable,
    Drift,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BaselineReadbackClassification {
    Confirmed,
    Drift,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveVersion {
    version_id: String,
    percentage: u8,
}

impl ActiveVersion {
    pub fn version_id(&self) -> &str {
        &self.version_id
    }

    pub const fn percentage(&self) -> u8 {
        self.percentage
    }
}

impl Serialize for ActiveVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CanonicalActiveVersion<'a> {
            version_id: &'a str,
            percentage: u8,
        }

        CanonicalActiveVersion {
            version_id: &self.version_id,
            percentage: self.percentage,
        }
        .serialize(serializer)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeploymentReadback {
    service_name: String,
    deployment_id: String,
    active_versions: Vec<ActiveVersion>,
    deployment_set_sha256: String,
    mutation_annotation: Option<String>,
}

impl DeploymentReadback {
    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    pub fn deployment_id(&self) -> &str {
        &self.deployment_id
    }

    pub fn active_versions(&self) -> &[ActiveVersion] {
        &self.active_versions
    }

    pub fn deployment_set_sha256(&self) -> &str {
        &self.deployment_set_sha256
    }

    pub fn mutation_annotation(&self) -> Option<&str> {
        self.mutation_annotation.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetVersionReadback {
    version_id: String,
    version_detail_sha256: String,
}

impl TargetVersionReadback {
    pub fn version_id(&self) -> &str {
        &self.version_id
    }

    pub fn version_detail_sha256(&self) -> &str {
        &self.version_detail_sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadbackSnapshot {
    service_name: String,
    target_version_id: String,
    deployment_id: String,
    deployment_set_sha256: String,
    active_versions: Vec<ActiveVersion>,
    mutation_annotation: Option<String>,
    version_detail_sha256: String,
}

impl ReadbackSnapshot {
    pub fn from_normalized(
        deployment: DeploymentReadback,
        target_version: TargetVersionReadback,
    ) -> Result<Self, ReadbackError> {
        require_service_name(&deployment.service_name)?;
        require_opaque_id(&target_version.version_id, "target_version_id")?;
        require_sha256(&deployment.deployment_set_sha256, "deployment_set_sha256")?;
        require_sha256(
            &target_version.version_detail_sha256,
            "version_detail_sha256",
        )?;

        Ok(Self {
            service_name: deployment.service_name,
            target_version_id: target_version.version_id,
            deployment_id: deployment.deployment_id,
            deployment_set_sha256: deployment.deployment_set_sha256,
            active_versions: deployment.active_versions,
            mutation_annotation: deployment.mutation_annotation,
            version_detail_sha256: target_version.version_detail_sha256,
        })
    }

    pub fn from_json(
        service_name: &str,
        target_version_id: &str,
        deployments_json: &[u8],
        target_version_json: &[u8],
    ) -> Result<Self, ReadbackError> {
        let deployment = normalize_deployments_response(deployments_json, service_name)?;
        let target_version =
            normalize_target_version_response(target_version_json, target_version_id)?;
        Self::from_normalized(deployment, target_version)
    }

    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    pub fn target_version_id(&self) -> &str {
        &self.target_version_id
    }

    pub fn deployment_set_sha256(&self) -> &str {
        &self.deployment_set_sha256
    }

    pub fn active_versions(&self) -> &[ActiveVersion] {
        &self.active_versions
    }

    pub fn mutation_annotation(&self) -> Option<&str> {
        self.mutation_annotation.as_deref()
    }

    pub fn version_detail_sha256(&self) -> &str {
        &self.version_detail_sha256
    }

    fn canonical_json(&self) -> Result<String, ReadbackError> {
        canonical_json(&CanonicalSnapshot::from(self)).map_err(|_| ReadbackError::Canonicalization)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedReadback {
    observed_at: u64,
    snapshot: ReadbackSnapshot,
}

impl ObservedReadback {
    pub fn new(observed_at: u64, snapshot: ReadbackSnapshot) -> Result<Self, ReadbackError> {
        if observed_at == 0 || observed_at > MAX_SAFE_INTEGER {
            return Err(ReadbackError::InvalidObservedAt);
        }
        Ok(Self {
            observed_at,
            snapshot,
        })
    }

    pub const fn observed_at(&self) -> u64 {
        self.observed_at
    }

    pub fn snapshot(&self) -> &ReadbackSnapshot {
        &self.snapshot
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableReadbackPair {
    expected_request_digest_sha256: String,
    expected_service_name: String,
    expected_target_version_id: String,
    expected_annotation: String,
    observation_seconds: u64,
    first: ObservedReadback,
    second: ObservedReadback,
}

impl StableReadbackPair {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        expected_request_digest_sha256: &str,
        expected_service_name: &str,
        expected_target_version_id: &str,
        expected_annotation: &str,
        observation_seconds: u64,
        first: ObservedReadback,
        second: ObservedReadback,
    ) -> Result<Self, ReadbackError> {
        require_sha256(
            expected_request_digest_sha256,
            "expected_request_digest_sha256",
        )?;
        require_service_name(expected_service_name)?;
        require_opaque_id(expected_target_version_id, "expected_target_version_id")?;
        require_annotation(expected_annotation)?;
        if !(MIN_OBSERVATION_SECONDS..=MAX_OBSERVATION_SECONDS).contains(&observation_seconds) {
            return Err(ReadbackError::InvalidObservationSeconds);
        }

        for observed in [&first, &second] {
            if observed.snapshot.service_name != expected_service_name
                || observed.snapshot.target_version_id != expected_target_version_id
            {
                return Err(ReadbackError::SnapshotBindingMismatch);
            }
        }
        if first.snapshot.service_name != second.snapshot.service_name
            || first.snapshot.target_version_id != second.snapshot.target_version_id
        {
            return Err(ReadbackError::SnapshotBindingMismatch);
        }

        let actual_interval = second
            .observed_at
            .checked_sub(first.observed_at)
            .ok_or(ReadbackError::ObservationNotMonotonic)?;
        if actual_interval < observation_seconds {
            return Err(ReadbackError::ObservationTooShort);
        }
        if actual_interval > MAX_OBSERVATION_SECONDS {
            return Err(ReadbackError::ObservationTooLong);
        }

        Ok(Self {
            expected_request_digest_sha256: expected_request_digest_sha256.to_owned(),
            expected_service_name: expected_service_name.to_owned(),
            expected_target_version_id: expected_target_version_id.to_owned(),
            expected_annotation: expected_annotation.to_owned(),
            observation_seconds,
            first,
            second,
        })
    }

    pub fn evaluate(&self) -> Result<ReadbackDecision, ReadbackError> {
        let snapshots_stable =
            self.first.snapshot.canonical_json()? == self.second.snapshot.canonical_json()?;
        let target_confirmed = snapshots_stable
            && self.first.snapshot.active_versions.len() == 1
            && self.first.snapshot.active_versions[0].version_id == self.expected_target_version_id
            && self.first.snapshot.active_versions[0].percentage == 100
            && self.first.snapshot.mutation_annotation.as_deref()
                == Some(self.expected_annotation.as_str())
            && self.first.snapshot.version_detail_sha256
                == self.second.snapshot.version_detail_sha256;

        let classification = if !snapshots_stable {
            ReadbackClassification::Drift
        } else if target_confirmed {
            ReadbackClassification::Confirmed
        } else {
            ReadbackClassification::TargetNotStable
        };
        let evidence = CanonicalReadbackEvidence {
            schema_version: 1,
            contract: READBACK_EVIDENCE_CONTRACT,
            classification,
            expected_request_digest_sha256: &self.expected_request_digest_sha256,
            service_name: &self.expected_service_name,
            target_version_id: &self.expected_target_version_id,
            expected_annotation: &self.expected_annotation,
            observation_seconds: self.observation_seconds,
            first: CanonicalObservedSnapshot::from(&self.first),
            second: CanonicalObservedSnapshot::from(&self.second),
        };
        let evidence_json =
            canonical_json(&evidence).map_err(|_| ReadbackError::Canonicalization)?;

        Ok(ReadbackDecision {
            classification,
            deployment_set_sha256: self.second.snapshot.deployment_set_sha256.clone(),
            evidence_digest_sha256: sha256_hex(evidence_json.as_bytes()),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StableBaselineReadbackPair {
    expected_service_name: String,
    expected_version_id: String,
    expected_deployment_set_sha256: String,
    observation_seconds: u64,
    first: ObservedReadback,
    second: ObservedReadback,
}

impl StableBaselineReadbackPair {
    pub fn new(
        expected_service_name: &str,
        expected_version_id: &str,
        expected_deployment_set_sha256: &str,
        observation_seconds: u64,
        first: ObservedReadback,
        second: ObservedReadback,
    ) -> Result<Self, ReadbackError> {
        require_service_name(expected_service_name)?;
        require_opaque_id(expected_version_id, "expected_version_id")?;
        require_sha256(
            expected_deployment_set_sha256,
            "expected_deployment_set_sha256",
        )?;
        if !(MIN_OBSERVATION_SECONDS..=MAX_OBSERVATION_SECONDS).contains(&observation_seconds) {
            return Err(ReadbackError::InvalidObservationSeconds);
        }
        for observed in [&first, &second] {
            if observed.snapshot.service_name != expected_service_name
                || observed.snapshot.target_version_id != expected_version_id
            {
                return Err(ReadbackError::SnapshotBindingMismatch);
            }
        }
        let actual_interval = second
            .observed_at
            .checked_sub(first.observed_at)
            .ok_or(ReadbackError::ObservationNotMonotonic)?;
        if actual_interval < observation_seconds {
            return Err(ReadbackError::ObservationTooShort);
        }
        if actual_interval > MAX_OBSERVATION_SECONDS {
            return Err(ReadbackError::ObservationTooLong);
        }
        Ok(Self {
            expected_service_name: expected_service_name.to_owned(),
            expected_version_id: expected_version_id.to_owned(),
            expected_deployment_set_sha256: expected_deployment_set_sha256.to_owned(),
            observation_seconds,
            first,
            second,
        })
    }

    pub fn evaluate(&self) -> Result<BaselineReadbackDecision, ReadbackError> {
        let snapshots_stable =
            self.first.snapshot.canonical_json()? == self.second.snapshot.canonical_json()?;
        let baseline_confirmed = snapshots_stable
            && self.first.snapshot.deployment_set_sha256 == self.expected_deployment_set_sha256
            && self.first.snapshot.active_versions.len() == 1
            && self.first.snapshot.active_versions[0].version_id == self.expected_version_id
            && self.first.snapshot.active_versions[0].percentage == 100;
        let classification = if baseline_confirmed {
            BaselineReadbackClassification::Confirmed
        } else {
            BaselineReadbackClassification::Drift
        };
        let evidence = CanonicalBaselineReadbackEvidence {
            schema_version: 1,
            contract: BASELINE_READBACK_EVIDENCE_CONTRACT,
            classification,
            expected_service_name: &self.expected_service_name,
            expected_version_id: &self.expected_version_id,
            expected_deployment_set_sha256: &self.expected_deployment_set_sha256,
            observation_seconds: self.observation_seconds,
            first: CanonicalObservedSnapshot::from(&self.first),
            second: CanonicalObservedSnapshot::from(&self.second),
        };
        let evidence_json =
            canonical_json(&evidence).map_err(|_| ReadbackError::Canonicalization)?;
        Ok(BaselineReadbackDecision {
            classification,
            deployment_set_sha256: self.second.snapshot.deployment_set_sha256.clone(),
            evidence_digest_sha256: sha256_hex(evidence_json.as_bytes()),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaselineReadbackDecision {
    classification: BaselineReadbackClassification,
    deployment_set_sha256: String,
    evidence_digest_sha256: String,
}

impl BaselineReadbackDecision {
    pub const fn classification(&self) -> BaselineReadbackClassification {
        self.classification
    }

    pub fn deployment_set_sha256(&self) -> &str {
        &self.deployment_set_sha256
    }

    pub fn evidence_digest_sha256(&self) -> &str {
        &self.evidence_digest_sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadbackDecision {
    classification: ReadbackClassification,
    deployment_set_sha256: String,
    evidence_digest_sha256: String,
}

impl ReadbackDecision {
    pub const fn classification(&self) -> ReadbackClassification {
        self.classification
    }

    pub fn deployment_set_sha256(&self) -> &str {
        &self.deployment_set_sha256
    }

    pub fn evidence_digest_sha256(&self) -> &str {
        &self.evidence_digest_sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadbackError {
    BodyOutsideBound(&'static str),
    InvalidJson(&'static str),
    InvalidEnvelope(&'static str),
    InvalidField(&'static str),
    AliasConflict,
    InvalidPercentage,
    InvalidActiveVersions,
    InvalidAnnotation,
    InvalidCanonicalNumber,
    Canonicalization,
    InvalidObservedAt,
    InvalidObservationSeconds,
    SnapshotBindingMismatch,
    ObservationNotMonotonic,
    ObservationTooShort,
    ObservationTooLong,
}

impl fmt::Display for ReadbackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BodyOutsideBound(label) => write!(formatter, "{label} is outside its byte bound"),
            Self::InvalidJson(label) => write!(formatter, "{label} is invalid JSON"),
            Self::InvalidEnvelope(label) => write!(formatter, "{label} envelope is invalid"),
            Self::InvalidField(field) => write!(formatter, "readback field is invalid: {field}"),
            Self::AliasConflict => formatter.write_str("active version ID aliases are ambiguous"),
            Self::InvalidPercentage => formatter.write_str("active percentage is invalid"),
            Self::InvalidActiveVersions => formatter.write_str("active version set is invalid"),
            Self::InvalidAnnotation => formatter.write_str("mutation annotation is invalid"),
            Self::InvalidCanonicalNumber => {
                formatter.write_str("target version contains an invalid canonical number")
            }
            Self::Canonicalization => formatter.write_str("readback canonicalization failed"),
            Self::InvalidObservedAt => formatter.write_str("observedAt is invalid"),
            Self::InvalidObservationSeconds => {
                formatter.write_str("compiled observationSeconds is invalid")
            }
            Self::SnapshotBindingMismatch => {
                formatter.write_str("readback service or target binding mismatch")
            }
            Self::ObservationNotMonotonic => {
                formatter.write_str("readback observedAt values are not monotonic")
            }
            Self::ObservationTooShort => formatter.write_str("readback interval is too short"),
            Self::ObservationTooLong => formatter.write_str("readback interval is too long"),
        }
    }
}

impl std::error::Error for ReadbackError {}

pub fn normalize_deployments_response(
    response_json: &[u8],
    service_name: &str,
) -> Result<DeploymentReadback, ReadbackError> {
    require_service_name(service_name)?;
    let envelope = parse_bounded_json(
        response_json,
        MAX_DEPLOYMENTS_RESPONSE_BYTES,
        "deployments response",
    )?;
    let envelope = require_object(&envelope, "deployments_envelope")?;
    if envelope.get("success") != Some(&Value::Bool(true)) {
        return Err(ReadbackError::InvalidEnvelope("deployments"));
    }
    let result = require_object(
        envelope
            .get("result")
            .ok_or(ReadbackError::InvalidEnvelope("deployments"))?,
        "deployments_result",
    )?;
    let deployments = result
        .get("deployments")
        .and_then(Value::as_array)
        .ok_or(ReadbackError::InvalidEnvelope("deployments"))?;
    let deployment = deployments
        .first()
        .ok_or(ReadbackError::InvalidEnvelope("deployments"))?;
    let deployment = require_object(deployment, "active_deployment")?;
    let deployment_id = require_opaque_value(deployment.get("id"), "deployment_id")?;
    if deployment.get("strategy").and_then(Value::as_str) != Some("percentage") {
        return Err(ReadbackError::InvalidField("strategy"));
    }
    let active_versions = normalize_active_versions(
        deployment
            .get("versions")
            .ok_or(ReadbackError::InvalidActiveVersions)?,
    )?;
    let mutation_annotation = extract_mutation_annotation(deployment.get("annotations"))?;
    let deployment_set_sha256 =
        deployment_set_digest_sha256(service_name, &deployment_id, &active_versions)?;

    Ok(DeploymentReadback {
        service_name: service_name.to_owned(),
        deployment_id,
        active_versions,
        deployment_set_sha256,
        mutation_annotation,
    })
}

pub fn normalize_target_version_response(
    response_json: &[u8],
    expected_version_id: &str,
) -> Result<TargetVersionReadback, ReadbackError> {
    require_opaque_id(expected_version_id, "expected_version_id")?;
    let envelope = parse_bounded_json(
        response_json,
        MAX_TARGET_VERSION_RESPONSE_BYTES,
        "target version response",
    )?;
    let envelope = require_object(&envelope, "target_version_envelope")?;
    if envelope.get("success") != Some(&Value::Bool(true)) {
        return Err(ReadbackError::InvalidEnvelope("target version"));
    }
    let result = envelope
        .get("result")
        .ok_or(ReadbackError::InvalidEnvelope("target version"))?;
    let result_object = require_object(result, "target_version_result")?;
    if result_object.get("id").and_then(Value::as_str) != Some(expected_version_id) {
        return Err(ReadbackError::InvalidField("target_version_id"));
    }
    let canonical_result = canonical_api_json(result)?;

    Ok(TargetVersionReadback {
        version_id: expected_version_id.to_owned(),
        version_detail_sha256: sha256_hex(canonical_result.as_bytes()),
    })
}

fn parse_bounded_json(
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
) -> Result<Value, ReadbackError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(ReadbackError::BodyOutsideBound(label));
    }
    reject_duplicate_json(bytes, maximum_bytes).map_err(|_| ReadbackError::InvalidJson(label))?;
    serde_json::from_slice(bytes).map_err(|_| ReadbackError::InvalidJson(label))
}

fn normalize_active_versions(value: &Value) -> Result<Vec<ActiveVersion>, ReadbackError> {
    let values = value
        .as_array()
        .filter(|values| (1..=2).contains(&values.len()))
        .ok_or(ReadbackError::InvalidActiveVersions)?;
    let mut versions = Vec::with_capacity(values.len());
    for raw in values {
        let version = require_object(raw, "active_version")?;
        let snake = version.get("version_id");
        let camel = version.get("versionId");
        let version_id = match (snake, camel) {
            (Some(value), None) | (None, Some(value)) => {
                require_opaque_value(Some(value), "active_version_id")?
            }
            (Some(_), Some(_)) => return Err(ReadbackError::AliasConflict),
            (None, None) => return Err(ReadbackError::InvalidField("active_version_id")),
        };
        let percentage = normalize_percentage(
            version
                .get("percentage")
                .ok_or(ReadbackError::InvalidPercentage)?,
        )?;
        versions.push(ActiveVersion {
            version_id,
            percentage,
        });
    }

    versions.sort_unstable_by(|left, right| {
        left.version_id.as_bytes().cmp(right.version_id.as_bytes())
    });
    if versions
        .windows(2)
        .any(|pair| pair[0].version_id == pair[1].version_id)
    {
        return Err(ReadbackError::InvalidActiveVersions);
    }
    let percentage_total: u16 = versions
        .iter()
        .map(|version| u16::from(version.percentage))
        .sum();
    if percentage_total != 100 {
        return Err(ReadbackError::InvalidActiveVersions);
    }
    Ok(versions)
}

fn normalize_percentage(value: &Value) -> Result<u8, ReadbackError> {
    let number = value.as_number().ok_or(ReadbackError::InvalidPercentage)?;
    if let Some(value) = number.as_u64() {
        return u8::try_from(value)
            .ok()
            .filter(|value| (1..=100).contains(value))
            .ok_or(ReadbackError::InvalidPercentage);
    }
    let value = number
        .as_f64()
        .filter(|value| value.is_finite() && value.fract() == 0.0)
        .ok_or(ReadbackError::InvalidPercentage)?;
    if !(1.0..=100.0).contains(&value) {
        return Err(ReadbackError::InvalidPercentage);
    }
    Ok(value as u8)
}

fn extract_mutation_annotation(
    annotations: Option<&Value>,
) -> Result<Option<String>, ReadbackError> {
    let Some(annotations) = annotations else {
        return Ok(None);
    };
    let annotations = require_object(annotations, "annotations")?;
    let Some(annotation) = annotations.get("workers/message") else {
        return Ok(None);
    };
    let annotation = annotation
        .as_str()
        .ok_or(ReadbackError::InvalidAnnotation)?;
    require_annotation(annotation)?;
    Ok(Some(annotation.to_owned()))
}

fn deployment_set_digest_sha256(
    service_name: &str,
    deployment_id: &str,
    versions: &[ActiveVersion],
) -> Result<String, ReadbackError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DeploymentSet<'a> {
        schema_version: u8,
        service_name: &'a str,
        deployment_id: &'a str,
        strategy: &'static str,
        versions: &'a [ActiveVersion],
    }

    let canonical = canonical_json(&DeploymentSet {
        schema_version: 1,
        service_name,
        deployment_id,
        strategy: "percentage",
        versions,
    })
    .map_err(|_| ReadbackError::Canonicalization)?;
    Ok(sha256_hex(canonical.as_bytes()))
}

fn canonical_api_json(value: &Value) -> Result<String, ReadbackError> {
    let mut output = String::new();
    write_canonical_api_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_api_json(value: &Value, output: &mut String) -> Result<(), ReadbackError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => output.push_str(&canonical_api_number(number)?),
        Value::String(value) => output
            .push_str(&serde_json::to_string(value).map_err(|_| ReadbackError::Canonicalization)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_api_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => write_canonical_api_object(values, output)?,
    }
    Ok(())
}

fn write_canonical_api_object(
    values: &Map<String, Value>,
    output: &mut String,
) -> Result<(), ReadbackError> {
    let mut entries = values.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| utf16_cmp(left.0, right.0));
    output.push('{');
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&serde_json::to_string(key).map_err(|_| ReadbackError::Canonicalization)?);
        output.push(':');
        write_canonical_api_json(value, output)?;
    }
    output.push('}');
    Ok(())
}

fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn canonical_api_number(number: &Number) -> Result<String, ReadbackError> {
    let value = number
        .as_f64()
        .ok_or(ReadbackError::InvalidCanonicalNumber)?;
    canonical_finite_f64(value)
}

fn canonical_finite_f64(value: f64) -> Result<String, ReadbackError> {
    if !value.is_finite() {
        return Err(ReadbackError::InvalidCanonicalNumber);
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    let raw = serde_json::to_string(&value).map_err(|_| ReadbackError::InvalidCanonicalNumber)?;
    ecmascript_number_from_shortest(&raw)
}

fn ecmascript_number_from_shortest(raw: &str) -> Result<String, ReadbackError> {
    let (negative, unsigned) = raw
        .strip_prefix('-')
        .map_or((false, raw), |value| (true, value));
    let Some(exponent_index) = unsigned.find(['e', 'E']) else {
        let normalized = unsigned.strip_suffix(".0").unwrap_or(unsigned);
        return Ok(if negative {
            format!("-{normalized}")
        } else {
            normalized.to_owned()
        });
    };

    let mantissa = &unsigned[..exponent_index];
    let exponent = unsigned[exponent_index + 1..]
        .parse::<i32>()
        .map_err(|_| ReadbackError::InvalidCanonicalNumber)?;
    let mut digits = mantissa
        .bytes()
        .filter(|byte| *byte != b'.')
        .map(char::from)
        .collect::<String>();
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    let scientific_exponent = exponent;
    let sign = if negative { "-" } else { "" };
    if (-6..21).contains(&scientific_exponent) {
        let decimal_position = scientific_exponent + 1;
        if decimal_position <= 0 {
            return Ok(format!(
                "{sign}0.{}{digits}",
                "0".repeat((-decimal_position) as usize)
            ));
        }
        if decimal_position as usize >= digits.len() {
            return Ok(format!(
                "{sign}{digits}{}",
                "0".repeat(decimal_position as usize - digits.len())
            ));
        }
        let split = decimal_position as usize;
        return Ok(format!("{sign}{}.{}", &digits[..split], &digits[split..]));
    }

    let fraction = if digits.len() > 1 {
        format!(".{}", &digits[1..])
    } else {
        String::new()
    };
    let exponent_sign = if scientific_exponent >= 0 { "+" } else { "" };
    Ok(format!(
        "{sign}{}{fraction}e{exponent_sign}{scientific_exponent}",
        &digits[..1]
    ))
}

fn require_object<'a>(
    value: &'a Value,
    field: &'static str,
) -> Result<&'a Map<String, Value>, ReadbackError> {
    value.as_object().ok_or(ReadbackError::InvalidField(field))
}

fn require_opaque_value(
    value: Option<&Value>,
    field: &'static str,
) -> Result<String, ReadbackError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or(ReadbackError::InvalidField(field))?;
    require_opaque_id(value, field)?;
    Ok(value.to_owned())
}

fn require_service_name(value: &str) -> Result<(), ReadbackError> {
    if value.is_empty()
        || value.len() > 63
        || !value.as_bytes()[0].is_ascii_lowercase() && !value.as_bytes()[0].is_ascii_digit()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ReadbackError::InvalidField("service_name"));
    }
    Ok(())
}

fn require_opaque_id(value: &str, field: &'static str) -> Result<(), ReadbackError> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ReadbackError::InvalidField(field));
    }
    Ok(())
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), ReadbackError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ReadbackError::InvalidField(field));
    }
    Ok(())
}

fn require_annotation(value: &str) -> Result<(), ReadbackError> {
    if value.len() > MAX_MUTATION_ANNOTATION_BYTES || value.chars().any(char::is_control) {
        return Err(ReadbackError::InvalidAnnotation);
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSnapshot<'a> {
    service_name: &'a str,
    target_version_id: &'a str,
    deployment_id: &'a str,
    deployment_set_sha256: &'a str,
    active_versions: &'a [ActiveVersion],
    mutation_annotation: Option<&'a str>,
    version_detail_sha256: &'a str,
}

impl<'a> From<&'a ReadbackSnapshot> for CanonicalSnapshot<'a> {
    fn from(snapshot: &'a ReadbackSnapshot) -> Self {
        Self {
            service_name: &snapshot.service_name,
            target_version_id: &snapshot.target_version_id,
            deployment_id: &snapshot.deployment_id,
            deployment_set_sha256: &snapshot.deployment_set_sha256,
            active_versions: &snapshot.active_versions,
            mutation_annotation: snapshot.mutation_annotation.as_deref(),
            version_detail_sha256: &snapshot.version_detail_sha256,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalObservedSnapshot<'a> {
    observed_at: u64,
    snapshot: CanonicalSnapshot<'a>,
}

impl<'a> From<&'a ObservedReadback> for CanonicalObservedSnapshot<'a> {
    fn from(observed: &'a ObservedReadback) -> Self {
        Self {
            observed_at: observed.observed_at,
            snapshot: CanonicalSnapshot::from(&observed.snapshot),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalReadbackEvidence<'a> {
    schema_version: u8,
    contract: &'static str,
    classification: ReadbackClassification,
    expected_request_digest_sha256: &'a str,
    service_name: &'a str,
    target_version_id: &'a str,
    expected_annotation: &'a str,
    observation_seconds: u64,
    first: CanonicalObservedSnapshot<'a>,
    second: CanonicalObservedSnapshot<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalBaselineReadbackEvidence<'a> {
    schema_version: u8,
    contract: &'static str,
    classification: BaselineReadbackClassification,
    expected_service_name: &'a str,
    expected_version_id: &'a str,
    expected_deployment_set_sha256: &'a str,
    observation_seconds: u64,
    first: CanonicalObservedSnapshot<'a>,
    second: CanonicalObservedSnapshot<'a>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE: &str = "svc-staging";
    const TARGET: &str = "version-a";
    const ANNOTATION: &str = "cinatoken ring transition test";
    const REQUEST_DIGEST: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    #[test]
    fn normalizes_versions_in_ascii_order_and_matches_js_deployment_set_vector() {
        let response = br#"{
          "success": true,
          "result": {
            "deployments": [{
              "id": "deployment-1",
              "strategy": "percentage",
              "versions": [
                {"versionId": "version-b", "percentage": 40},
                {"version_id": "version-a", "percentage": 60}
              ],
              "annotations": {"workers/message": "cinatoken ring transition test"}
            }]
          }
        }"#;
        let deployment = normalize_deployments_response(response, SERVICE).unwrap();

        assert_eq!(
            deployment
                .active_versions()
                .iter()
                .map(ActiveVersion::version_id)
                .collect::<Vec<_>>(),
            ["version-a", "version-b"]
        );
        assert_eq!(
            deployment.deployment_set_sha256(),
            "3b8c62d2cea34addc1c7058378a3af43392fa9f68ccab4dd8793c68bea9b5326"
        );
        assert_eq!(deployment.mutation_annotation(), Some(ANNOTATION));
    }

    #[test]
    fn accepts_integer_valued_percentage_number_forms() {
        for percentage in ["100.0", "1e2"] {
            let response = deployment_json(
                &format!(r#"[{{"version_id":"version-a","percentage":{percentage}}}]"#),
                "",
            );
            let deployment = normalize_deployments_response(response.as_bytes(), SERVICE).unwrap();
            assert_eq!(deployment.active_versions()[0].percentage(), 100);
        }
    }

    #[test]
    fn accepts_missing_annotation_as_null_and_rejects_unsafe_annotations() {
        let missing = deployment_json(r#"[{"version_id":"version-a","percentage":100}]"#, "");
        let deployment = normalize_deployments_response(missing.as_bytes(), SERVICE).unwrap();
        assert_eq!(deployment.mutation_annotation(), None);

        for annotation in [
            "\"bad\\nannotation\"",
            "\"bad\\u007fannotation\"",
            &format!("\"{}\"", "x".repeat(MAX_MUTATION_ANNOTATION_BYTES + 1)),
            "null",
        ] {
            let response = deployment_json(
                r#"[{"version_id":"version-a","percentage":100}]"#,
                &format!(r#","annotations":{{"workers/message":{annotation}}}"#),
            );
            assert_eq!(
                normalize_deployments_response(response.as_bytes(), SERVICE),
                Err(ReadbackError::InvalidAnnotation)
            );
        }
    }

    #[test]
    fn rejects_duplicate_fields_and_bodies_outside_the_bound() {
        let duplicate = br#"{
          "success": true,
          "success": true,
          "result": {"deployments": []}
        }"#;
        assert_eq!(
            normalize_deployments_response(duplicate, SERVICE),
            Err(ReadbackError::InvalidJson("deployments response"))
        );
        assert_eq!(
            normalize_target_version_response(
                br#"{"success":true,"result":{"id":"version-a","id":"version-a"}}"#,
                TARGET,
            ),
            Err(ReadbackError::InvalidJson("target version response"))
        );

        let oversized = vec![b' '; MAX_DEPLOYMENTS_RESPONSE_BYTES + 1];
        assert_eq!(
            normalize_deployments_response(&oversized, SERVICE),
            Err(ReadbackError::BodyOutsideBound("deployments response"))
        );
    }

    #[test]
    fn rejects_zero_duplicate_wrong_sum_alias_noninteger_and_overflow_percentages() {
        for versions in [
            r#"[{"version_id":"version-a","percentage":0}]"#,
            r#"[{"version_id":"version-a","percentage":50},{"versionId":"version-a","percentage":50}]"#,
            r#"[{"version_id":"version-a","percentage":40},{"versionId":"version-b","percentage":40}]"#,
            r#"[{"version_id":"version-a","versionId":"version-a","percentage":100}]"#,
            r#"[{"version_id":"version-a","percentage":99.5}]"#,
            r#"[{"version_id":"version-a","percentage":18446744073709551616}]"#,
        ] {
            let response = deployment_json(versions, "");
            assert!(normalize_deployments_response(response.as_bytes(), SERVICE).is_err());
        }
    }

    #[test]
    fn hashes_the_complete_target_result_with_sorted_keys_and_preserved_arrays() {
        let first = br#"{
          "success": true,
          "result": {
            "usage_model": "standard",
            "id": "version-a",
            "compatibility_date": "2026-07-01",
            "bindings": [{"type":"plain_text","name":"B"},{"name":"A","type":"kv_namespace"}],
            "limits": {"cpu_ms": 10, "ratio": 0.25}
          }
        }"#;
        let second = br#"{
          "result": {
            "limits": {"ratio": 0.25, "cpu_ms": 10},
            "bindings": [{"name":"B","type":"plain_text"},{"type":"kv_namespace","name":"A"}],
            "compatibility_date": "2026-07-01",
            "id": "version-a",
            "usage_model": "standard"
          },
          "success": true
        }"#;
        let first = normalize_target_version_response(first, TARGET).unwrap();
        let second = normalize_target_version_response(second, TARGET).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.version_detail_sha256(),
            "c97c0d1a4677d63b5f28b14c7b95fc36c30632dceb9807f2335381e627aea54e"
        );
    }

    #[test]
    fn canonical_api_numbers_match_json_stringify_for_supported_finite_values() {
        let value: Value = serde_json::from_str(
            r#"{
              "i": 9007199254740993,
              "h": 1e21,
              "g": 1e20,
              "z": -0.0,
              "d": 1.0,
              "c": 1e-7,
              "b": 0.000001,
              "a": 1.25
            }"#,
        )
        .unwrap();
        assert_eq!(
            canonical_api_json(&value).unwrap(),
            r#"{"a":1.25,"b":0.000001,"c":1e-7,"d":1,"g":100000000000000000000,"h":1e+21,"i":9007199254740992,"z":0}"#
        );
    }

    #[test]
    fn target_version_rejects_id_drift_overflow_and_nonfinite_numbers() {
        assert_eq!(
            normalize_target_version_response(
                br#"{"success":true,"result":{"id":"version-b"}}"#,
                TARGET,
            ),
            Err(ReadbackError::InvalidField("target_version_id"))
        );
        for body in [
            br#"{"success":true,"result":{"id":"version-a","unsafe":NaN}}"#.as_slice(),
            br#"{"success":true,"result":{"id":"version-a","unsafe":1e400}}"#.as_slice(),
        ] {
            assert_eq!(
                normalize_target_version_response(body, TARGET),
                Err(ReadbackError::InvalidJson("target version response"))
            );
        }
        assert_eq!(
            canonical_finite_f64(f64::NAN),
            Err(ReadbackError::InvalidCanonicalNumber)
        );
        assert_eq!(
            canonical_finite_f64(f64::INFINITY),
            Err(ReadbackError::InvalidCanonicalNumber)
        );
    }

    #[test]
    fn confirms_only_two_stable_exact_target_snapshots() {
        let first = observed(1_000, snapshot(ANNOTATION, "detail-a", 100));
        let second = observed(1_005, snapshot(ANNOTATION, "detail-a", 100));
        let decision = pair(first, second, 5).evaluate().unwrap();

        assert_eq!(decision.classification(), ReadbackClassification::Confirmed);
        assert_eq!(
            decision.evidence_digest_sha256(),
            "fe68186649a4e349f725f3ec5a55b794de276f5955f42258c733faedc83ae93b"
        );
        assert_eq!(decision.evidence_digest_sha256().len(), 64);
    }

    #[test]
    fn confirms_only_two_stable_exact_baseline_snapshots() {
        let baseline = snapshot("historical annotation", "detail-a", 100);
        let expected_deployment_set_sha256 = baseline.deployment_set_sha256.clone();
        let decision = StableBaselineReadbackPair::new(
            SERVICE,
            TARGET,
            &expected_deployment_set_sha256,
            5,
            observed(1_000, baseline.clone()),
            observed(1_005, baseline),
        )
        .unwrap()
        .evaluate()
        .unwrap();

        assert_eq!(
            decision.classification(),
            BaselineReadbackClassification::Confirmed
        );
        assert_eq!(
            decision.deployment_set_sha256(),
            expected_deployment_set_sha256
        );
        assert_eq!(decision.evidence_digest_sha256().len(), 64);
    }

    #[test]
    fn baseline_evidence_fails_closed_on_identity_or_snapshot_drift() {
        let baseline = snapshot("historical annotation", "detail-a", 100);
        let expected_deployment_set_sha256 = baseline.deployment_set_sha256.clone();
        let stable_wrong_identity = StableBaselineReadbackPair::new(
            SERVICE,
            TARGET,
            &"f".repeat(64),
            5,
            observed(1_000, baseline.clone()),
            observed(1_005, baseline.clone()),
        )
        .unwrap()
        .evaluate()
        .unwrap();
        assert_eq!(
            stable_wrong_identity.classification(),
            BaselineReadbackClassification::Drift
        );

        let snapshot_drift = StableBaselineReadbackPair::new(
            SERVICE,
            TARGET,
            &expected_deployment_set_sha256,
            5,
            observed(1_000, baseline),
            observed(1_005, snapshot("historical annotation", "detail-b", 100)),
        )
        .unwrap()
        .evaluate()
        .unwrap();
        assert_eq!(
            snapshot_drift.classification(),
            BaselineReadbackClassification::Drift
        );
        assert_ne!(
            stable_wrong_identity.evidence_digest_sha256(),
            snapshot_drift.evidence_digest_sha256()
        );
    }

    #[test]
    fn classifies_annotation_and_version_detail_drift() {
        let annotation_drift = pair(
            observed(1_000, snapshot(ANNOTATION, "detail-a", 100)),
            observed(1_005, snapshot("different annotation", "detail-a", 100)),
            5,
        )
        .evaluate()
        .unwrap();
        assert_eq!(
            annotation_drift.classification(),
            ReadbackClassification::Drift
        );

        let version_drift = pair(
            observed(1_000, snapshot(ANNOTATION, "detail-a", 100)),
            observed(1_005, snapshot(ANNOTATION, "detail-b", 100)),
            5,
        )
        .evaluate()
        .unwrap();
        assert_eq!(
            version_drift.classification(),
            ReadbackClassification::Drift
        );
    }

    #[test]
    fn stable_wrong_annotation_or_non_target_percentage_is_not_confirmed() {
        for stable_snapshot in [
            snapshot("wrong annotation", "detail-a", 100),
            split_snapshot(ANNOTATION, "detail-a"),
        ] {
            let decision = pair(
                observed(1_000, stable_snapshot.clone()),
                observed(1_005, stable_snapshot),
                5,
            )
            .evaluate()
            .unwrap();
            assert_eq!(
                decision.classification(),
                ReadbackClassification::TargetNotStable
            );
        }
    }

    #[test]
    fn rejects_short_long_nonmonotonic_and_invalid_compiled_windows() {
        let first = observed(1_000, snapshot(ANNOTATION, "detail-a", 100));
        let second = observed(1_004, snapshot(ANNOTATION, "detail-a", 100));
        assert_eq!(
            StableReadbackPair::new(
                REQUEST_DIGEST,
                SERVICE,
                TARGET,
                ANNOTATION,
                5,
                first,
                second,
            ),
            Err(ReadbackError::ObservationTooShort)
        );

        let first = observed(1_000, snapshot(ANNOTATION, "detail-a", 100));
        let second = observed(1_121, snapshot(ANNOTATION, "detail-a", 100));
        assert_eq!(
            StableReadbackPair::new(
                REQUEST_DIGEST,
                SERVICE,
                TARGET,
                ANNOTATION,
                5,
                first,
                second,
            ),
            Err(ReadbackError::ObservationTooLong)
        );

        let first = observed(1_005, snapshot(ANNOTATION, "detail-a", 100));
        let second = observed(1_000, snapshot(ANNOTATION, "detail-a", 100));
        assert_eq!(
            StableReadbackPair::new(
                REQUEST_DIGEST,
                SERVICE,
                TARGET,
                ANNOTATION,
                5,
                first,
                second,
            ),
            Err(ReadbackError::ObservationNotMonotonic)
        );

        for observation_seconds in [4, 121] {
            assert_eq!(
                StableReadbackPair::new(
                    REQUEST_DIGEST,
                    SERVICE,
                    TARGET,
                    ANNOTATION,
                    observation_seconds,
                    observed(1_000, snapshot(ANNOTATION, "detail-a", 100)),
                    observed(1_120, snapshot(ANNOTATION, "detail-a", 100)),
                ),
                Err(ReadbackError::InvalidObservationSeconds)
            );
        }
    }

    #[test]
    fn evidence_digest_binds_request_target_annotation_snapshots_and_times() {
        let base_first = observed(1_000, snapshot(ANNOTATION, "detail-a", 100));
        let base_second = observed(1_005, snapshot(ANNOTATION, "detail-a", 100));
        let base = pair(base_first.clone(), base_second.clone(), 5)
            .evaluate()
            .unwrap();

        let later = pair(
            observed(1_001, base_first.snapshot.clone()),
            observed(1_006, base_second.snapshot.clone()),
            5,
        )
        .evaluate()
        .unwrap();
        assert_ne!(
            base.evidence_digest_sha256(),
            later.evidence_digest_sha256()
        );

        let different_request = StableReadbackPair::new(
            &"2".repeat(64),
            SERVICE,
            TARGET,
            ANNOTATION,
            5,
            base_first,
            base_second,
        )
        .unwrap()
        .evaluate()
        .unwrap();
        assert_ne!(
            base.evidence_digest_sha256(),
            different_request.evidence_digest_sha256()
        );

        let different_annotation = StableReadbackPair::new(
            REQUEST_DIGEST,
            SERVICE,
            TARGET,
            "different expected annotation",
            5,
            observed(1_000, snapshot(ANNOTATION, "detail-a", 100)),
            observed(1_005, snapshot(ANNOTATION, "detail-a", 100)),
        )
        .unwrap()
        .evaluate()
        .unwrap();
        assert_ne!(
            base.evidence_digest_sha256(),
            different_annotation.evidence_digest_sha256()
        );

        let different_target = StableReadbackPair::new(
            REQUEST_DIGEST,
            SERVICE,
            "version-b",
            ANNOTATION,
            5,
            observed(
                1_000,
                snapshot_for_target("version-b", ANNOTATION, "detail-a"),
            ),
            observed(
                1_005,
                snapshot_for_target("version-b", ANNOTATION, "detail-a"),
            ),
        )
        .unwrap()
        .evaluate()
        .unwrap();
        assert_ne!(
            base.evidence_digest_sha256(),
            different_target.evidence_digest_sha256()
        );

        let different_snapshot = pair(
            observed(1_000, snapshot(ANNOTATION, "detail-b", 100)),
            observed(1_005, snapshot(ANNOTATION, "detail-b", 100)),
            5,
        )
        .evaluate()
        .unwrap();
        assert_ne!(
            base.evidence_digest_sha256(),
            different_snapshot.evidence_digest_sha256()
        );

        let deployment_body = deployment_json(
            r#"[{"version_id":"version-a","percentage":100}]"#,
            r#","annotations":{"workers/message":"cinatoken ring transition test"}"#,
        );
        let target_body =
            br#"{"success":true,"result":{"id":"version-a","marker":"raw-target-body-marker"}}"#;
        let raw_snapshot =
            ReadbackSnapshot::from_json(SERVICE, TARGET, deployment_body.as_bytes(), target_body)
                .unwrap();
        let raw_pair = pair(
            observed(1_000, raw_snapshot.clone()),
            observed(1_005, raw_snapshot),
            5,
        );
        let raw_decision = raw_pair.evaluate().unwrap();
        assert!(!format!("{raw_pair:?}").contains("raw-target-body-marker"));
        assert!(!format!("{raw_decision:?}").contains("raw-target-body-marker"));
    }

    fn deployment_json(versions: &str, annotation_fragment: &str) -> String {
        format!(
            r#"{{"success":true,"result":{{"deployments":[{{"id":"deployment-1","strategy":"percentage","versions":{versions}{annotation_fragment}}}]}}}}"#
        )
    }

    fn snapshot(annotation: &str, detail_marker: &str, percentage: u8) -> ReadbackSnapshot {
        let mut snapshot = snapshot_for_target(TARGET, annotation, detail_marker);
        snapshot.active_versions[0].percentage = percentage;
        snapshot.deployment_set_sha256 = sha256_hex(format!("deployment-{percentage}").as_bytes());
        snapshot
    }

    fn snapshot_for_target(
        target_version_id: &str,
        annotation: &str,
        detail_marker: &str,
    ) -> ReadbackSnapshot {
        let deployment = DeploymentReadback {
            service_name: SERVICE.to_owned(),
            deployment_id: "deployment-1".to_owned(),
            active_versions: vec![ActiveVersion {
                version_id: target_version_id.to_owned(),
                percentage: 100,
            }],
            deployment_set_sha256: sha256_hex(format!("deployment-{target_version_id}").as_bytes()),
            mutation_annotation: Some(annotation.to_owned()),
        };
        let target = TargetVersionReadback {
            version_id: target_version_id.to_owned(),
            version_detail_sha256: sha256_hex(detail_marker.as_bytes()),
        };
        ReadbackSnapshot::from_normalized(deployment, target).unwrap()
    }

    fn split_snapshot(annotation: &str, detail_marker: &str) -> ReadbackSnapshot {
        let deployment = DeploymentReadback {
            service_name: SERVICE.to_owned(),
            deployment_id: "deployment-1".to_owned(),
            active_versions: vec![
                ActiveVersion {
                    version_id: TARGET.to_owned(),
                    percentage: 60,
                },
                ActiveVersion {
                    version_id: "version-b".to_owned(),
                    percentage: 40,
                },
            ],
            deployment_set_sha256: sha256_hex(b"split-deployment"),
            mutation_annotation: Some(annotation.to_owned()),
        };
        let target = TargetVersionReadback {
            version_id: TARGET.to_owned(),
            version_detail_sha256: sha256_hex(detail_marker.as_bytes()),
        };
        ReadbackSnapshot::from_normalized(deployment, target).unwrap()
    }

    fn observed(observed_at: u64, snapshot: ReadbackSnapshot) -> ObservedReadback {
        ObservedReadback::new(observed_at, snapshot).unwrap()
    }

    fn pair(
        first: ObservedReadback,
        second: ObservedReadback,
        observation_seconds: u64,
    ) -> StableReadbackPair {
        StableReadbackPair::new(
            REQUEST_DIGEST,
            SERVICE,
            TARGET,
            ANNOTATION,
            observation_seconds,
            first,
            second,
        )
        .unwrap()
    }
}
