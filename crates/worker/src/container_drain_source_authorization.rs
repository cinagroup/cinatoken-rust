//! Verification for short-lived accepted-source collection authority.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::Env;

use crate::d1_repositories::{
    RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256, RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256,
};

pub(crate) const DRAIN_SOURCE_AUTHORIZATION_CONTRACT: &str =
    "relay-container-drain-source-authorization-v1";
pub(crate) const DRAIN_SOURCE_ATTESTATION_CONTRACT: &str =
    "relay-container-drain-source-attestation-v1";

const AUTHORIZATION_SIGNATURE_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-authorization-v1";
const ATTESTATION_SIGNATURE_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-attestation-v1";
const SIGNATURE_ENVELOPE_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-signature-envelope-v1";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const MINIMUM_PERMIT_LIFETIME_SECONDS: i64 = 60;
const MAXIMUM_PERMIT_LIFETIME_SECONDS: i64 = 900;
const MINIMUM_ATTESTATION_LIFETIME_SECONDS: i64 = 30;
const MAXIMUM_ATTESTATION_LIFETIME_SECONDS: i64 = 900;
const MAXIMUM_CLOCK_SKEW_SECONDS: i64 = 120;
const MINIMUM_REMAINING_SECONDS: i64 = 30;
const MAXIMUM_RAW_NONCE_BYTES: usize = 1_024;
const MAXIMUM_PAGE_SIZE: u16 = 512;
const MAXIMUM_SHARD_COUNT: u16 = 1_024;
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const AUTHORIZER_TRUST_ENV: TrustEnvNames = TrustEnvNames {
    issuer: "CONTAINER_DRAIN_SOURCE_AUTHORIZER_ISSUER",
    key_id: "CONTAINER_DRAIN_SOURCE_AUTHORIZER_KEY_ID",
    identity_sha256: "CONTAINER_DRAIN_SOURCE_AUTHORIZER_IDENTITY_SHA256",
    spki_base64url: "CONTAINER_DRAIN_SOURCE_AUTHORIZER_SPKI_BASE64URL",
    spki_sha256: "CONTAINER_DRAIN_SOURCE_AUTHORIZER_SPKI_SHA256",
};
const ASSEMBLER_TRUST_ENV: TrustEnvNames = TrustEnvNames {
    issuer: "CONTAINER_DRAIN_SOURCE_ASSEMBLER_ISSUER",
    key_id: "CONTAINER_DRAIN_SOURCE_ASSEMBLER_KEY_ID",
    identity_sha256: "CONTAINER_DRAIN_SOURCE_ASSEMBLER_IDENTITY_SHA256",
    spki_base64url: "CONTAINER_DRAIN_SOURCE_ASSEMBLER_SPKI_BASE64URL",
    spki_sha256: "CONTAINER_DRAIN_SOURCE_ASSEMBLER_SPKI_SHA256",
};
const VERIFIER_TRUST_ENV: TrustEnvNames = TrustEnvNames {
    issuer: "CONTAINER_DRAIN_SOURCE_VERIFIER_ISSUER",
    key_id: "CONTAINER_DRAIN_SOURCE_VERIFIER_KEY_ID",
    identity_sha256: "CONTAINER_DRAIN_SOURCE_VERIFIER_IDENTITY_SHA256",
    spki_base64url: "CONTAINER_DRAIN_SOURCE_VERIFIER_SPKI_BASE64URL",
    spki_sha256: "CONTAINER_DRAIN_SOURCE_VERIFIER_SPKI_SHA256",
};

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub(crate) struct DrainSourceAuthorizationPermit {
    pub(crate) schema_version: u32,
    pub(crate) contract: String,
    pub(crate) issuer: String,
    pub(crate) key_id: String,
    pub(crate) environment: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) scope_kind: String,
    pub(crate) scope_id_sha256: String,
    pub(crate) admission_fence_id_sha256: String,
    pub(crate) fence_generation: i64,
    pub(crate) expected_fence_state_digest_sha256: String,
    pub(crate) expected_head_version: i64,
    pub(crate) expected_head_digest_sha256: String,
    pub(crate) source_scan_id_sha256: String,
    pub(crate) collector_service_name: String,
    pub(crate) collector_version_id: String,
    pub(crate) collector_run_id_sha256: String,
    pub(crate) started_by_credential_id_sha256: String,
    pub(crate) page_size: u16,
    pub(crate) shard_count: u16,
    pub(crate) accepted_source_schema_sha256: String,
    pub(crate) authorizer_identity_sha256: String,
    pub(crate) execution_nonce_sha256: String,
    pub(crate) authorized_by_admin_id: i64,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) signature_base64url: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ExpectedDrainSourceAuthorization<'a> {
    pub(crate) environment: &'a str,
    pub(crate) authorization_id_sha256: &'a str,
    pub(crate) admission_fence_id_sha256: &'a str,
    pub(crate) fence_generation: i64,
    pub(crate) expected_fence_state_digest_sha256: &'a str,
    pub(crate) expected_head_version: i64,
    pub(crate) expected_head_digest_sha256: &'a str,
    pub(crate) source_scan_id_sha256: &'a str,
    pub(crate) collector_service_name: &'a str,
    pub(crate) collector_version_id: &'a str,
    pub(crate) collector_run_id_sha256: &'a str,
    pub(crate) started_by_credential_id_sha256: &'a str,
    pub(crate) page_size: u16,
    pub(crate) shard_count: u16,
    pub(crate) authorized_by_admin_id: i64,
    pub(crate) execution_nonce: &'a str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DrainSourceAttestation {
    pub(crate) schema_version: u32,
    pub(crate) contract: String,
    pub(crate) role: String,
    pub(crate) issuer: String,
    pub(crate) key_id: String,
    pub(crate) environment: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) source_scan_id_sha256: String,
    pub(crate) source_seal_id_sha256: String,
    pub(crate) identity_sha256: String,
    pub(crate) accepted_bookmark_sha256: String,
    pub(crate) accepted_set_manifest_sha256: String,
    pub(crate) accepted_source_schema_sha256: String,
    pub(crate) accepted_source_readback_sha256: String,
    pub(crate) page_count: i64,
    pub(crate) first_page_digest_sha256: Option<String>,
    pub(crate) last_page_digest_sha256: Option<String>,
    pub(crate) shard_set_manifest_sha256: String,
    pub(crate) captured_high_watermark: i64,
    pub(crate) captured_member_count: i64,
    pub(crate) captured_first_sequence: i64,
    pub(crate) captured_first_operation_id: Option<String>,
    pub(crate) captured_last_sequence: i64,
    pub(crate) captured_last_operation_id: Option<String>,
    pub(crate) attested_at: i64,
    pub(crate) valid_until: i64,
    pub(crate) signature_base64url: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ExpectedDrainSourceSnapshot<'a> {
    pub(crate) environment: &'a str,
    pub(crate) authorization_id_sha256: &'a str,
    pub(crate) source_scan_id_sha256: &'a str,
    pub(crate) source_seal_id_sha256: &'a str,
    pub(crate) accepted_bookmark_sha256: &'a str,
    pub(crate) accepted_set_manifest_sha256: &'a str,
    pub(crate) accepted_source_readback_sha256: &'a str,
    pub(crate) page_count: i64,
    pub(crate) first_page_digest_sha256: Option<&'a str>,
    pub(crate) last_page_digest_sha256: Option<&'a str>,
    pub(crate) shard_set_manifest_sha256: &'a str,
    pub(crate) captured_high_watermark: i64,
    pub(crate) captured_member_count: i64,
    pub(crate) captured_first_sequence: i64,
    pub(crate) captured_first_operation_id: Option<&'a str>,
    pub(crate) captured_last_sequence: i64,
    pub(crate) captured_last_operation_id: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct VerifiedDrainSourceAuthorization {
    pub(crate) contract_version: u32,
    pub(crate) authorization_contract: String,
    pub(crate) environment: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) scope_kind: String,
    pub(crate) scope_id_sha256: String,
    pub(crate) admission_fence_id_sha256: String,
    pub(crate) fence_generation: i64,
    pub(crate) expected_fence_state_digest_sha256: String,
    pub(crate) expected_head_version: i64,
    pub(crate) expected_head_digest_sha256: String,
    pub(crate) source_scan_id_sha256: String,
    pub(crate) collector_service_name: String,
    pub(crate) collector_version_id: String,
    pub(crate) collector_run_id_sha256: String,
    pub(crate) started_by_credential_id_sha256: String,
    pub(crate) page_size: u16,
    pub(crate) shard_count: u16,
    pub(crate) accepted_source_schema_sha256: String,
    pub(crate) authorizer_issuer: String,
    pub(crate) authorizer_key_id: String,
    pub(crate) authorizer_identity_sha256: String,
    pub(crate) authorizer_spki_sha256: String,
    pub(crate) authorization_subject_sha256: String,
    pub(crate) authorization_signature_envelope_sha256: String,
    pub(crate) execution_nonce_sha256: String,
    pub(crate) permit_issued_at: i64,
    pub(crate) permit_expires_at: i64,
    pub(crate) authorized_by_admin_id: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct VerifiedDrainSourceAttestation {
    pub(crate) contract_version: u32,
    pub(crate) attestation_contract: String,
    pub(crate) attestation_role: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) source_scan_id_sha256: String,
    pub(crate) source_seal_id_sha256: String,
    pub(crate) issuer: String,
    pub(crate) key_id: String,
    pub(crate) identity_sha256: String,
    pub(crate) signer_spki_sha256: String,
    pub(crate) attestation_subject_sha256: String,
    pub(crate) signature_envelope_sha256: String,
    pub(crate) accepted_bookmark_sha256: String,
    pub(crate) accepted_set_manifest_sha256: String,
    pub(crate) accepted_source_schema_sha256: String,
    pub(crate) accepted_source_readback_sha256: String,
    pub(crate) page_count: i64,
    pub(crate) first_page_digest_sha256: Option<String>,
    pub(crate) last_page_digest_sha256: Option<String>,
    pub(crate) shard_set_manifest_sha256: String,
    pub(crate) captured_high_watermark: i64,
    pub(crate) captured_member_count: i64,
    pub(crate) captured_first_sequence: i64,
    pub(crate) captured_first_operation_id: Option<String>,
    pub(crate) captured_last_sequence: i64,
    pub(crate) captured_last_operation_id: Option<String>,
    pub(crate) attested_at: i64,
    pub(crate) valid_until: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct VerifiedDrainSourceAuthorityBundle {
    pub(crate) authorization: VerifiedDrainSourceAuthorization,
    pub(crate) assembler: VerifiedDrainSourceAttestation,
    pub(crate) verifier: VerifiedDrainSourceAttestation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DrainSourceAuthorizationError {
    MissingTrust,
    InvalidTrust,
    InvalidPermit,
    InvalidAttestation,
    BindingMismatch,
    InvalidValidity,
    InvalidSignature,
    IndependenceViolation,
}

impl DrainSourceAuthorizationError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::MissingTrust => "drain_source_authorization_trust_missing",
            Self::InvalidTrust => "drain_source_authorization_trust_invalid",
            Self::InvalidPermit => "drain_source_authorization_permit_invalid",
            Self::InvalidAttestation => "drain_source_attestation_invalid",
            Self::BindingMismatch => "drain_source_authorization_binding_mismatch",
            Self::InvalidValidity => "drain_source_authorization_validity_invalid",
            Self::InvalidSignature => "drain_source_authorization_signature_invalid",
            Self::IndependenceViolation => "drain_source_authorization_independence_invalid",
        }
    }
}

impl std::fmt::Display for DrainSourceAuthorizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DrainSourceAuthorizationError {}

#[derive(Clone, Copy)]
struct TrustEnvNames {
    issuer: &'static str,
    key_id: &'static str,
    identity_sha256: &'static str,
    spki_base64url: &'static str,
    spki_sha256: &'static str,
}

#[derive(Clone, Debug)]
struct DrainSourceTrust {
    issuer: String,
    key_id: String,
    identity_sha256: String,
    spki_base64url: String,
    spki_sha256: String,
}

pub(crate) fn verify_drain_source_authority_bundle(
    env: &Env,
    permit: &DrainSourceAuthorizationPermit,
    assembler: &DrainSourceAttestation,
    verifier: &DrainSourceAttestation,
    expected_authorization: &ExpectedDrainSourceAuthorization<'_>,
    expected_snapshot: &ExpectedDrainSourceSnapshot<'_>,
    now: i64,
) -> Result<VerifiedDrainSourceAuthorityBundle, DrainSourceAuthorizationError> {
    let authorizer_trust = DrainSourceTrust::from_env(env, AUTHORIZER_TRUST_ENV)?;
    let assembler_trust = DrainSourceTrust::from_env(env, ASSEMBLER_TRUST_ENV)?;
    let verifier_trust = DrainSourceTrust::from_env(env, VERIFIER_TRUST_ENV)?;
    verify_bundle_with_trusts(
        permit,
        assembler,
        verifier,
        expected_authorization,
        expected_snapshot,
        &authorizer_trust,
        &assembler_trust,
        &verifier_trust,
        now,
    )
}

impl DrainSourceTrust {
    fn from_env(env: &Env, names: TrustEnvNames) -> Result<Self, DrainSourceAuthorizationError> {
        Ok(Self {
            issuer: required_env(env, names.issuer)?,
            key_id: required_env(env, names.key_id)?,
            identity_sha256: required_env(env, names.identity_sha256)?,
            spki_base64url: required_env(env, names.spki_base64url)?,
            spki_sha256: required_env(env, names.spki_sha256)?,
        })
    }
}

fn required_env(env: &Env, name: &'static str) -> Result<String, DrainSourceAuthorizationError> {
    let value = env
        .var(name)
        .map_err(|_| DrainSourceAuthorizationError::MissingTrust)?
        .to_string();
    if value.is_empty() {
        return Err(DrainSourceAuthorizationError::MissingTrust);
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn verify_bundle_with_trusts(
    permit: &DrainSourceAuthorizationPermit,
    assembler: &DrainSourceAttestation,
    verifier: &DrainSourceAttestation,
    expected_authorization: &ExpectedDrainSourceAuthorization<'_>,
    expected_snapshot: &ExpectedDrainSourceSnapshot<'_>,
    authorizer_trust: &DrainSourceTrust,
    assembler_trust: &DrainSourceTrust,
    verifier_trust: &DrainSourceTrust,
    now: i64,
) -> Result<VerifiedDrainSourceAuthorityBundle, DrainSourceAuthorizationError> {
    validate_independent_trusts(authorizer_trust, assembler_trust, verifier_trust)?;
    let authorization =
        verify_authorization(permit, expected_authorization, authorizer_trust, now)?;
    let assembler = verify_attestation(
        assembler,
        "assembler",
        expected_snapshot,
        assembler_trust,
        now,
    )?;
    let verifier =
        verify_attestation(verifier, "verifier", expected_snapshot, verifier_trust, now)?;

    if expected_snapshot.environment != authorization.environment
        || expected_snapshot.authorization_id_sha256 != authorization.authorization_id_sha256
        || expected_snapshot.source_scan_id_sha256 != authorization.source_scan_id_sha256
        || assembler.attested_at < authorization.permit_issued_at
        || verifier.attested_at < authorization.permit_issued_at
        || assembler.attested_at > verifier.attested_at
        || assembler.valid_until > authorization.permit_expires_at
        || verifier.valid_until > authorization.permit_expires_at
        || assembler.identity_sha256 == verifier.identity_sha256
        || assembler.signer_spki_sha256 == verifier.signer_spki_sha256
        || assembler.signature_envelope_sha256 == verifier.signature_envelope_sha256
    {
        return Err(DrainSourceAuthorizationError::IndependenceViolation);
    }

    Ok(VerifiedDrainSourceAuthorityBundle {
        authorization,
        assembler,
        verifier,
    })
}

fn verify_authorization(
    permit: &DrainSourceAuthorizationPermit,
    expected: &ExpectedDrainSourceAuthorization<'_>,
    trust: &DrainSourceTrust,
    now: i64,
) -> Result<VerifiedDrainSourceAuthorization, DrainSourceAuthorizationError> {
    let verifying_key = validate_trust(trust)?;
    validate_permit_shape(permit, trust)?;
    validate_authorization_bindings(permit, expected)?;
    validate_permit_validity(permit, now)?;
    let message = authorization_message(permit)?;
    let signature = verify_signature(
        &verifying_key,
        &message,
        &permit.signature_base64url,
        DrainSourceAuthorizationError::InvalidPermit,
    )?;
    let subject = sha256_hex(&message);
    let envelope = signature_envelope_sha256(trust, &subject, &signature)?;
    Ok(VerifiedDrainSourceAuthorization {
        contract_version: permit.schema_version,
        authorization_contract: permit.contract.clone(),
        environment: permit.environment.clone(),
        authorization_id_sha256: permit.authorization_id_sha256.clone(),
        scope_kind: permit.scope_kind.clone(),
        scope_id_sha256: permit.scope_id_sha256.clone(),
        admission_fence_id_sha256: permit.admission_fence_id_sha256.clone(),
        fence_generation: permit.fence_generation,
        expected_fence_state_digest_sha256: permit.expected_fence_state_digest_sha256.clone(),
        expected_head_version: permit.expected_head_version,
        expected_head_digest_sha256: permit.expected_head_digest_sha256.clone(),
        source_scan_id_sha256: permit.source_scan_id_sha256.clone(),
        collector_service_name: permit.collector_service_name.clone(),
        collector_version_id: permit.collector_version_id.clone(),
        collector_run_id_sha256: permit.collector_run_id_sha256.clone(),
        started_by_credential_id_sha256: permit.started_by_credential_id_sha256.clone(),
        page_size: permit.page_size,
        shard_count: permit.shard_count,
        accepted_source_schema_sha256: permit.accepted_source_schema_sha256.clone(),
        authorizer_issuer: permit.issuer.clone(),
        authorizer_key_id: permit.key_id.clone(),
        authorizer_identity_sha256: permit.authorizer_identity_sha256.clone(),
        authorizer_spki_sha256: trust.spki_sha256.clone(),
        authorization_subject_sha256: subject,
        authorization_signature_envelope_sha256: envelope,
        execution_nonce_sha256: permit.execution_nonce_sha256.clone(),
        permit_issued_at: permit.issued_at,
        permit_expires_at: permit.expires_at,
        authorized_by_admin_id: permit.authorized_by_admin_id,
    })
}

fn verify_attestation(
    attestation: &DrainSourceAttestation,
    expected_role: &str,
    expected: &ExpectedDrainSourceSnapshot<'_>,
    trust: &DrainSourceTrust,
    now: i64,
) -> Result<VerifiedDrainSourceAttestation, DrainSourceAuthorizationError> {
    let verifying_key = validate_trust(trust)?;
    validate_attestation_shape(attestation, expected_role, trust)?;
    validate_snapshot_bindings(attestation, expected)?;
    validate_attestation_validity(attestation, now)?;
    let message = attestation_message(attestation)?;
    let signature = verify_signature(
        &verifying_key,
        &message,
        &attestation.signature_base64url,
        DrainSourceAuthorizationError::InvalidAttestation,
    )?;
    let subject = sha256_hex(&message);
    let envelope = signature_envelope_sha256(trust, &subject, &signature)?;
    Ok(VerifiedDrainSourceAttestation {
        contract_version: attestation.schema_version,
        attestation_contract: attestation.contract.clone(),
        attestation_role: attestation.role.clone(),
        authorization_id_sha256: attestation.authorization_id_sha256.clone(),
        source_scan_id_sha256: attestation.source_scan_id_sha256.clone(),
        source_seal_id_sha256: attestation.source_seal_id_sha256.clone(),
        issuer: attestation.issuer.clone(),
        key_id: attestation.key_id.clone(),
        identity_sha256: attestation.identity_sha256.clone(),
        signer_spki_sha256: trust.spki_sha256.clone(),
        attestation_subject_sha256: subject,
        signature_envelope_sha256: envelope,
        accepted_bookmark_sha256: attestation.accepted_bookmark_sha256.clone(),
        accepted_set_manifest_sha256: attestation.accepted_set_manifest_sha256.clone(),
        accepted_source_schema_sha256: attestation.accepted_source_schema_sha256.clone(),
        accepted_source_readback_sha256: attestation.accepted_source_readback_sha256.clone(),
        page_count: attestation.page_count,
        first_page_digest_sha256: attestation.first_page_digest_sha256.clone(),
        last_page_digest_sha256: attestation.last_page_digest_sha256.clone(),
        shard_set_manifest_sha256: attestation.shard_set_manifest_sha256.clone(),
        captured_high_watermark: attestation.captured_high_watermark,
        captured_member_count: attestation.captured_member_count,
        captured_first_sequence: attestation.captured_first_sequence,
        captured_first_operation_id: attestation.captured_first_operation_id.clone(),
        captured_last_sequence: attestation.captured_last_sequence,
        captured_last_operation_id: attestation.captured_last_operation_id.clone(),
        attested_at: attestation.attested_at,
        valid_until: attestation.valid_until,
    })
}

fn validate_independent_trusts(
    authorizer: &DrainSourceTrust,
    assembler: &DrainSourceTrust,
    verifier: &DrainSourceTrust,
) -> Result<(), DrainSourceAuthorizationError> {
    validate_trust(authorizer)?;
    validate_trust(assembler)?;
    validate_trust(verifier)?;
    let identities = [
        authorizer.identity_sha256.as_str(),
        assembler.identity_sha256.as_str(),
        verifier.identity_sha256.as_str(),
    ];
    let keys = [
        authorizer.spki_sha256.as_str(),
        assembler.spki_sha256.as_str(),
        verifier.spki_sha256.as_str(),
    ];
    if identities[0] == identities[1]
        || identities[0] == identities[2]
        || identities[1] == identities[2]
        || keys[0] == keys[1]
        || keys[0] == keys[2]
        || keys[1] == keys[2]
    {
        return Err(DrainSourceAuthorizationError::IndependenceViolation);
    }
    Ok(())
}

fn validate_trust(trust: &DrainSourceTrust) -> Result<VerifyingKey, DrainSourceAuthorizationError> {
    if !valid_issuer(&trust.issuer)
        || !valid_key_id(&trust.key_id)
        || !valid_sha256(&trust.identity_sha256)
        || !valid_sha256(&trust.spki_sha256)
        || trust.identity_sha256 == trust.spki_sha256
    {
        return Err(DrainSourceAuthorizationError::InvalidTrust);
    }
    let spki = decode_canonical_base64url(&trust.spki_base64url, ED25519_SPKI_PREFIX.len() + 32)
        .map_err(|_| DrainSourceAuthorizationError::InvalidTrust)?;
    if sha256_hex(&spki) != trust.spki_sha256 {
        return Err(DrainSourceAuthorizationError::InvalidTrust);
    }
    let key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(DrainSourceAuthorizationError::InvalidTrust)?;
    VerifyingKey::from_bytes(key_bytes).map_err(|_| DrainSourceAuthorizationError::InvalidTrust)
}

fn validate_permit_shape(
    permit: &DrainSourceAuthorizationPermit,
    trust: &DrainSourceTrust,
) -> Result<(), DrainSourceAuthorizationError> {
    if permit.schema_version != 1
        || permit.contract != DRAIN_SOURCE_AUTHORIZATION_CONTRACT
        || permit.issuer != trust.issuer
        || permit.key_id != trust.key_id
        || permit.authorizer_identity_sha256 != trust.identity_sha256
        || !matches!(permit.environment.as_str(), "staging" | "production")
        || permit.scope_kind != "global"
        || permit.scope_id_sha256 != RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256
        || permit.fence_generation != 1
        || permit.expected_head_version != 1
        || permit.accepted_source_schema_sha256 != RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
        || !valid_sha256(&permit.authorization_id_sha256)
        || !valid_sha256(&permit.admission_fence_id_sha256)
        || !valid_sha256(&permit.expected_fence_state_digest_sha256)
        || !valid_sha256(&permit.expected_head_digest_sha256)
        || !valid_sha256(&permit.source_scan_id_sha256)
        || !valid_service_name(&permit.collector_service_name)
        || !valid_version_id(&permit.collector_version_id)
        || !valid_sha256(&permit.collector_run_id_sha256)
        || !valid_sha256(&permit.started_by_credential_id_sha256)
        || permit.page_size == 0
        || permit.page_size > MAXIMUM_PAGE_SIZE
        || permit.shard_count == 0
        || permit.shard_count > MAXIMUM_SHARD_COUNT
        || !valid_sha256(&permit.execution_nonce_sha256)
        || permit.authorized_by_admin_id <= 0
        || permit.authorized_by_admin_id > MAXIMUM_SAFE_INTEGER
        || !all_distinct(&[
            &permit.authorization_id_sha256,
            &permit.source_scan_id_sha256,
            &permit.collector_run_id_sha256,
            &permit.execution_nonce_sha256,
        ])
    {
        return Err(DrainSourceAuthorizationError::InvalidPermit);
    }
    Ok(())
}

fn validate_authorization_bindings(
    permit: &DrainSourceAuthorizationPermit,
    expected: &ExpectedDrainSourceAuthorization<'_>,
) -> Result<(), DrainSourceAuthorizationError> {
    if expected.execution_nonce.is_empty()
        || expected.execution_nonce.len() > MAXIMUM_RAW_NONCE_BYTES
        || permit.environment != expected.environment
        || permit.authorization_id_sha256 != expected.authorization_id_sha256
        || permit.admission_fence_id_sha256 != expected.admission_fence_id_sha256
        || permit.fence_generation != expected.fence_generation
        || permit.expected_fence_state_digest_sha256 != expected.expected_fence_state_digest_sha256
        || permit.expected_head_version != expected.expected_head_version
        || permit.expected_head_digest_sha256 != expected.expected_head_digest_sha256
        || permit.source_scan_id_sha256 != expected.source_scan_id_sha256
        || permit.collector_service_name != expected.collector_service_name
        || permit.collector_version_id != expected.collector_version_id
        || permit.collector_run_id_sha256 != expected.collector_run_id_sha256
        || permit.started_by_credential_id_sha256 != expected.started_by_credential_id_sha256
        || permit.page_size != expected.page_size
        || permit.shard_count != expected.shard_count
        || permit.authorized_by_admin_id != expected.authorized_by_admin_id
        || permit.execution_nonce_sha256 != sha256_hex(expected.execution_nonce.as_bytes())
    {
        return Err(DrainSourceAuthorizationError::BindingMismatch);
    }
    Ok(())
}

fn validate_permit_validity(
    permit: &DrainSourceAuthorizationPermit,
    now: i64,
) -> Result<(), DrainSourceAuthorizationError> {
    let lifetime = permit.expires_at.checked_sub(permit.issued_at);
    if now <= 0
        || permit.issued_at <= 0
        || permit.expires_at <= 0
        || !matches!(
            lifetime,
            Some(MINIMUM_PERMIT_LIFETIME_SECONDS..=MAXIMUM_PERMIT_LIFETIME_SECONDS)
        )
        || permit.issued_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || permit.expires_at < now.saturating_add(MINIMUM_REMAINING_SECONDS)
        || permit.issued_at > MAXIMUM_SAFE_INTEGER
        || permit.expires_at > MAXIMUM_SAFE_INTEGER
    {
        return Err(DrainSourceAuthorizationError::InvalidValidity);
    }
    Ok(())
}

fn validate_attestation_shape(
    attestation: &DrainSourceAttestation,
    expected_role: &str,
    trust: &DrainSourceTrust,
) -> Result<(), DrainSourceAuthorizationError> {
    if attestation.schema_version != 1
        || attestation.contract != DRAIN_SOURCE_ATTESTATION_CONTRACT
        || attestation.role != expected_role
        || attestation.issuer != trust.issuer
        || attestation.key_id != trust.key_id
        || attestation.identity_sha256 != trust.identity_sha256
        || !matches!(attestation.environment.as_str(), "staging" | "production")
        || !valid_sha256(&attestation.authorization_id_sha256)
        || !valid_sha256(&attestation.source_scan_id_sha256)
        || !valid_sha256(&attestation.source_seal_id_sha256)
        || !valid_sha256(&attestation.identity_sha256)
        || !valid_sha256(&attestation.accepted_bookmark_sha256)
        || !valid_sha256(&attestation.accepted_set_manifest_sha256)
        || attestation.accepted_source_schema_sha256 != RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
        || !valid_sha256(&attestation.accepted_source_readback_sha256)
        || !valid_sha256(&attestation.shard_set_manifest_sha256)
        || !all_distinct(&[
            &attestation.authorization_id_sha256,
            &attestation.source_scan_id_sha256,
            &attestation.source_seal_id_sha256,
        ])
        || !valid_snapshot_shape(attestation)
    {
        return Err(DrainSourceAuthorizationError::InvalidAttestation);
    }
    Ok(())
}

fn valid_snapshot_shape(attestation: &DrainSourceAttestation) -> bool {
    let page_shape = if attestation.page_count == 0 {
        attestation.first_page_digest_sha256.is_none()
            && attestation.last_page_digest_sha256.is_none()
    } else {
        attestation.page_count > 0
            && attestation
                .first_page_digest_sha256
                .as_deref()
                .is_some_and(valid_sha256)
            && attestation
                .last_page_digest_sha256
                .as_deref()
                .is_some_and(valid_sha256)
    };
    let member_shape = if attestation.captured_member_count == 0 {
        attestation.captured_high_watermark == 0
            && attestation.captured_first_sequence == 0
            && attestation.captured_first_operation_id.is_none()
            && attestation.captured_last_sequence == 0
            && attestation.captured_last_operation_id.is_none()
    } else {
        attestation.captured_member_count > 0
            && attestation.captured_high_watermark == attestation.captured_member_count
            && attestation.captured_first_sequence == 1
            && attestation
                .captured_first_operation_id
                .as_deref()
                .is_some_and(valid_operation_id)
            && attestation.captured_last_sequence == attestation.captured_high_watermark
            && attestation
                .captured_last_operation_id
                .as_deref()
                .is_some_and(valid_operation_id)
    };
    page_shape
        && member_shape
        && [
            attestation.page_count,
            attestation.captured_high_watermark,
            attestation.captured_member_count,
            attestation.captured_first_sequence,
            attestation.captured_last_sequence,
        ]
        .iter()
        .all(|value| (0..=MAXIMUM_SAFE_INTEGER).contains(value))
}

fn validate_snapshot_bindings(
    attestation: &DrainSourceAttestation,
    expected: &ExpectedDrainSourceSnapshot<'_>,
) -> Result<(), DrainSourceAuthorizationError> {
    if attestation.environment != expected.environment
        || attestation.authorization_id_sha256 != expected.authorization_id_sha256
        || attestation.source_scan_id_sha256 != expected.source_scan_id_sha256
        || attestation.source_seal_id_sha256 != expected.source_seal_id_sha256
        || attestation.accepted_bookmark_sha256 != expected.accepted_bookmark_sha256
        || attestation.accepted_set_manifest_sha256 != expected.accepted_set_manifest_sha256
        || attestation.accepted_source_readback_sha256 != expected.accepted_source_readback_sha256
        || attestation.page_count != expected.page_count
        || attestation.first_page_digest_sha256.as_deref() != expected.first_page_digest_sha256
        || attestation.last_page_digest_sha256.as_deref() != expected.last_page_digest_sha256
        || attestation.shard_set_manifest_sha256 != expected.shard_set_manifest_sha256
        || attestation.captured_high_watermark != expected.captured_high_watermark
        || attestation.captured_member_count != expected.captured_member_count
        || attestation.captured_first_sequence != expected.captured_first_sequence
        || attestation.captured_first_operation_id.as_deref()
            != expected.captured_first_operation_id
        || attestation.captured_last_sequence != expected.captured_last_sequence
        || attestation.captured_last_operation_id.as_deref() != expected.captured_last_operation_id
    {
        return Err(DrainSourceAuthorizationError::BindingMismatch);
    }
    Ok(())
}

fn validate_attestation_validity(
    attestation: &DrainSourceAttestation,
    now: i64,
) -> Result<(), DrainSourceAuthorizationError> {
    let lifetime = attestation.valid_until.checked_sub(attestation.attested_at);
    if now <= 0
        || attestation.attested_at <= 0
        || attestation.valid_until <= 0
        || !matches!(
            lifetime,
            Some(MINIMUM_ATTESTATION_LIFETIME_SECONDS..=MAXIMUM_ATTESTATION_LIFETIME_SECONDS)
        )
        || attestation.attested_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || attestation.valid_until < now.saturating_add(MINIMUM_REMAINING_SECONDS)
        || attestation.attested_at > MAXIMUM_SAFE_INTEGER
        || attestation.valid_until > MAXIMUM_SAFE_INTEGER
    {
        return Err(DrainSourceAuthorizationError::InvalidValidity);
    }
    Ok(())
}

fn authorization_message(
    permit: &DrainSourceAuthorizationPermit,
) -> Result<Vec<u8>, DrainSourceAuthorizationError> {
    canonical_message(
        AUTHORIZATION_SIGNATURE_DOMAIN,
        &[
            permit.schema_version.to_string(),
            permit.contract.clone(),
            permit.issuer.clone(),
            permit.key_id.clone(),
            permit.environment.clone(),
            permit.authorization_id_sha256.clone(),
            permit.scope_kind.clone(),
            permit.scope_id_sha256.clone(),
            permit.admission_fence_id_sha256.clone(),
            permit.fence_generation.to_string(),
            permit.expected_fence_state_digest_sha256.clone(),
            permit.expected_head_version.to_string(),
            permit.expected_head_digest_sha256.clone(),
            permit.source_scan_id_sha256.clone(),
            permit.collector_service_name.clone(),
            permit.collector_version_id.clone(),
            permit.collector_run_id_sha256.clone(),
            permit.started_by_credential_id_sha256.clone(),
            permit.page_size.to_string(),
            permit.shard_count.to_string(),
            permit.accepted_source_schema_sha256.clone(),
            permit.authorizer_identity_sha256.clone(),
            permit.execution_nonce_sha256.clone(),
            permit.authorized_by_admin_id.to_string(),
            permit.issued_at.to_string(),
            permit.expires_at.to_string(),
        ],
        DrainSourceAuthorizationError::InvalidPermit,
    )
}

fn attestation_message(
    attestation: &DrainSourceAttestation,
) -> Result<Vec<u8>, DrainSourceAuthorizationError> {
    canonical_message(
        ATTESTATION_SIGNATURE_DOMAIN,
        &[
            attestation.schema_version.to_string(),
            attestation.contract.clone(),
            attestation.role.clone(),
            attestation.issuer.clone(),
            attestation.key_id.clone(),
            attestation.environment.clone(),
            attestation.authorization_id_sha256.clone(),
            attestation.source_scan_id_sha256.clone(),
            attestation.source_seal_id_sha256.clone(),
            attestation.identity_sha256.clone(),
            attestation.accepted_bookmark_sha256.clone(),
            attestation.accepted_set_manifest_sha256.clone(),
            attestation.accepted_source_schema_sha256.clone(),
            attestation.accepted_source_readback_sha256.clone(),
            attestation.page_count.to_string(),
            optional_field(attestation.first_page_digest_sha256.as_deref()),
            optional_field(attestation.last_page_digest_sha256.as_deref()),
            attestation.shard_set_manifest_sha256.clone(),
            attestation.captured_high_watermark.to_string(),
            attestation.captured_member_count.to_string(),
            attestation.captured_first_sequence.to_string(),
            optional_field(attestation.captured_first_operation_id.as_deref()),
            attestation.captured_last_sequence.to_string(),
            optional_field(attestation.captured_last_operation_id.as_deref()),
            attestation.attested_at.to_string(),
            attestation.valid_until.to_string(),
        ],
        DrainSourceAuthorizationError::InvalidAttestation,
    )
}

fn signature_envelope_sha256(
    trust: &DrainSourceTrust,
    subject_sha256: &str,
    signature: &[u8],
) -> Result<String, DrainSourceAuthorizationError> {
    let message = canonical_message(
        SIGNATURE_ENVELOPE_DOMAIN,
        &[
            trust.issuer.clone(),
            trust.key_id.clone(),
            trust.identity_sha256.clone(),
            trust.spki_sha256.clone(),
            subject_sha256.to_owned(),
            URL_SAFE_NO_PAD.encode(signature),
        ],
        DrainSourceAuthorizationError::InvalidSignature,
    )?;
    Ok(sha256_hex(message))
}

fn canonical_message(
    domain: &[u8],
    fields: &[String],
    error: DrainSourceAuthorizationError,
) -> Result<Vec<u8>, DrainSourceAuthorizationError> {
    let payload_bytes = fields.iter().try_fold(0usize, |total, field| {
        u32::try_from(field.len())
            .ok()
            .and_then(|_| total.checked_add(4 + field.len()))
            .ok_or(error)
    })?;
    let mut message = Vec::with_capacity(domain.len() + payload_bytes);
    message.extend_from_slice(domain);
    for field in fields {
        let length = u32::try_from(field.len()).map_err(|_| error)?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(field.as_bytes());
    }
    Ok(message)
}

fn verify_signature(
    key: &VerifyingKey,
    message: &[u8],
    signature_base64url: &str,
    shape_error: DrainSourceAuthorizationError,
) -> Result<Vec<u8>, DrainSourceAuthorizationError> {
    let signature_bytes =
        decode_canonical_base64url(signature_base64url, 64).map_err(|_| shape_error)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| shape_error)?;
    key.verify_strict(message, &signature)
        .map_err(|_| DrainSourceAuthorizationError::InvalidSignature)?;
    Ok(signature_bytes)
}

fn decode_canonical_base64url(value: &str, expected_bytes: usize) -> Result<Vec<u8>, ()> {
    let expected_encoded_bytes = expected_bytes
        .checked_mul(4)
        .and_then(|value| value.checked_add(2))
        .map(|value| value / 3)
        .ok_or(())?;
    if value.len() != expected_encoded_bytes
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(());
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    if decoded.len() != expected_bytes || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

fn optional_field(value: Option<&str>) -> String {
    value
        .map(|value| format!("some:{value}"))
        .unwrap_or_else(|| "none".to_owned())
}

fn all_distinct(values: &[&String]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(index, value)| values[index + 1..].iter().all(|other| value != other))
}

fn valid_issuer(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_service_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_version_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_operation_id(value: &str) -> bool {
    valid_version_id(value)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 2_100_000_000;

    struct Fixture {
        authorizer_key: SigningKey,
        assembler_key: SigningKey,
        verifier_key: SigningKey,
        authorizer_trust: DrainSourceTrust,
        assembler_trust: DrainSourceTrust,
        verifier_trust: DrainSourceTrust,
        permit: DrainSourceAuthorizationPermit,
        assembler: DrainSourceAttestation,
        verifier: DrainSourceAttestation,
        execution_nonce: String,
    }

    impl Fixture {
        fn expected_authorization(&self) -> ExpectedDrainSourceAuthorization<'_> {
            ExpectedDrainSourceAuthorization {
                environment: &self.permit.environment,
                authorization_id_sha256: &self.permit.authorization_id_sha256,
                admission_fence_id_sha256: &self.permit.admission_fence_id_sha256,
                fence_generation: self.permit.fence_generation,
                expected_fence_state_digest_sha256: &self.permit.expected_fence_state_digest_sha256,
                expected_head_version: self.permit.expected_head_version,
                expected_head_digest_sha256: &self.permit.expected_head_digest_sha256,
                source_scan_id_sha256: &self.permit.source_scan_id_sha256,
                collector_service_name: &self.permit.collector_service_name,
                collector_version_id: &self.permit.collector_version_id,
                collector_run_id_sha256: &self.permit.collector_run_id_sha256,
                started_by_credential_id_sha256: &self.permit.started_by_credential_id_sha256,
                page_size: self.permit.page_size,
                shard_count: self.permit.shard_count,
                authorized_by_admin_id: self.permit.authorized_by_admin_id,
                execution_nonce: &self.execution_nonce,
            }
        }

        fn expected_snapshot(&self) -> ExpectedDrainSourceSnapshot<'_> {
            ExpectedDrainSourceSnapshot {
                environment: &self.assembler.environment,
                authorization_id_sha256: &self.assembler.authorization_id_sha256,
                source_scan_id_sha256: &self.assembler.source_scan_id_sha256,
                source_seal_id_sha256: &self.assembler.source_seal_id_sha256,
                accepted_bookmark_sha256: &self.assembler.accepted_bookmark_sha256,
                accepted_set_manifest_sha256: &self.assembler.accepted_set_manifest_sha256,
                accepted_source_readback_sha256: &self.assembler.accepted_source_readback_sha256,
                page_count: self.assembler.page_count,
                first_page_digest_sha256: self.assembler.first_page_digest_sha256.as_deref(),
                last_page_digest_sha256: self.assembler.last_page_digest_sha256.as_deref(),
                shard_set_manifest_sha256: &self.assembler.shard_set_manifest_sha256,
                captured_high_watermark: self.assembler.captured_high_watermark,
                captured_member_count: self.assembler.captured_member_count,
                captured_first_sequence: self.assembler.captured_first_sequence,
                captured_first_operation_id: self.assembler.captured_first_operation_id.as_deref(),
                captured_last_sequence: self.assembler.captured_last_sequence,
                captured_last_operation_id: self.assembler.captured_last_operation_id.as_deref(),
            }
        }

        fn resign_authorization(&mut self) {
            let message = authorization_message(&self.permit).unwrap();
            self.permit.signature_base64url =
                URL_SAFE_NO_PAD.encode(self.authorizer_key.sign(&message).to_bytes());
        }

        fn resign_assembler(&mut self) {
            let message = attestation_message(&self.assembler).unwrap();
            self.assembler.signature_base64url =
                URL_SAFE_NO_PAD.encode(self.assembler_key.sign(&message).to_bytes());
        }

        fn resign_verifier(&mut self) {
            let message = attestation_message(&self.verifier).unwrap();
            self.verifier.signature_base64url =
                URL_SAFE_NO_PAD.encode(self.verifier_key.sign(&message).to_bytes());
        }
    }

    fn trust(label: &str, key: &SigningKey) -> DrainSourceTrust {
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(key.verifying_key().as_bytes());
        DrainSourceTrust {
            issuer: format!("cinatoken-drain-source-{label}"),
            key_id: format!("drain-source-{label}-v1"),
            identity_sha256: sha256_hex(format!("{label}-identity")),
            spki_base64url: URL_SAFE_NO_PAD.encode(&spki),
            spki_sha256: sha256_hex(&spki),
        }
    }

    fn fixture() -> Fixture {
        let authorizer_key = SigningKey::from_bytes(&[7_u8; 32]);
        let assembler_key = SigningKey::from_bytes(&[8_u8; 32]);
        let verifier_key = SigningKey::from_bytes(&[9_u8; 32]);
        let authorizer_trust = trust("authorizer", &authorizer_key);
        let assembler_trust = trust("assembler", &assembler_key);
        let verifier_trust = trust("verifier", &verifier_key);
        let execution_nonce = "raw-execution-nonce-never-persisted".to_owned();
        let authorization_id = sha256_hex("authorization-id");
        let source_scan_id = sha256_hex("source-scan-id");
        let source_seal_id = sha256_hex("source-seal-id");
        let mut fixture = Fixture {
            authorizer_key,
            assembler_key,
            verifier_key,
            permit: DrainSourceAuthorizationPermit {
                schema_version: 1,
                contract: DRAIN_SOURCE_AUTHORIZATION_CONTRACT.to_owned(),
                issuer: authorizer_trust.issuer.clone(),
                key_id: authorizer_trust.key_id.clone(),
                environment: "staging".to_owned(),
                authorization_id_sha256: authorization_id.clone(),
                scope_kind: "global".to_owned(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_owned(),
                admission_fence_id_sha256: sha256_hex("fence"),
                fence_generation: 1,
                expected_fence_state_digest_sha256: sha256_hex("fence-state"),
                expected_head_version: 1,
                expected_head_digest_sha256: sha256_hex("head"),
                source_scan_id_sha256: source_scan_id.clone(),
                collector_service_name: "drain-source-collector".to_owned(),
                collector_version_id: "collector-v1".to_owned(),
                collector_run_id_sha256: sha256_hex("collector-run"),
                started_by_credential_id_sha256: sha256_hex("credential"),
                page_size: 256,
                shard_count: 4,
                accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
                    .to_owned(),
                authorizer_identity_sha256: authorizer_trust.identity_sha256.clone(),
                execution_nonce_sha256: sha256_hex(execution_nonce.as_bytes()),
                authorized_by_admin_id: 42,
                issued_at: NOW - 1,
                expires_at: NOW + 300,
                signature_base64url: String::new(),
            },
            assembler: DrainSourceAttestation {
                schema_version: 1,
                contract: DRAIN_SOURCE_ATTESTATION_CONTRACT.to_owned(),
                role: "assembler".to_owned(),
                issuer: assembler_trust.issuer.clone(),
                key_id: assembler_trust.key_id.clone(),
                environment: "staging".to_owned(),
                authorization_id_sha256: authorization_id.clone(),
                source_scan_id_sha256: source_scan_id.clone(),
                source_seal_id_sha256: source_seal_id.clone(),
                identity_sha256: assembler_trust.identity_sha256.clone(),
                accepted_bookmark_sha256: sha256_hex("bookmark"),
                accepted_set_manifest_sha256: sha256_hex("accepted-set"),
                accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
                    .to_owned(),
                accepted_source_readback_sha256: sha256_hex("readback"),
                page_count: 2,
                first_page_digest_sha256: Some(sha256_hex("page-1")),
                last_page_digest_sha256: Some(sha256_hex("page-2")),
                shard_set_manifest_sha256: sha256_hex("shard-set"),
                captured_high_watermark: 3,
                captured_member_count: 3,
                captured_first_sequence: 1,
                captured_first_operation_id: Some("operation-1".to_owned()),
                captured_last_sequence: 3,
                captured_last_operation_id: Some("operation-3".to_owned()),
                attested_at: NOW,
                valid_until: NOW + 240,
                signature_base64url: String::new(),
            },
            verifier: DrainSourceAttestation {
                schema_version: 1,
                contract: DRAIN_SOURCE_ATTESTATION_CONTRACT.to_owned(),
                role: "verifier".to_owned(),
                issuer: verifier_trust.issuer.clone(),
                key_id: verifier_trust.key_id.clone(),
                environment: "staging".to_owned(),
                authorization_id_sha256: authorization_id,
                source_scan_id_sha256: source_scan_id,
                source_seal_id_sha256: source_seal_id,
                identity_sha256: verifier_trust.identity_sha256.clone(),
                accepted_bookmark_sha256: sha256_hex("bookmark"),
                accepted_set_manifest_sha256: sha256_hex("accepted-set"),
                accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
                    .to_owned(),
                accepted_source_readback_sha256: sha256_hex("readback"),
                page_count: 2,
                first_page_digest_sha256: Some(sha256_hex("page-1")),
                last_page_digest_sha256: Some(sha256_hex("page-2")),
                shard_set_manifest_sha256: sha256_hex("shard-set"),
                captured_high_watermark: 3,
                captured_member_count: 3,
                captured_first_sequence: 1,
                captured_first_operation_id: Some("operation-1".to_owned()),
                captured_last_sequence: 3,
                captured_last_operation_id: Some("operation-3".to_owned()),
                attested_at: NOW + 1,
                valid_until: NOW + 240,
                signature_base64url: String::new(),
            },
            authorizer_trust,
            assembler_trust,
            verifier_trust,
            execution_nonce,
        };
        fixture.resign_authorization();
        fixture.resign_assembler();
        fixture.resign_verifier();
        fixture
    }

    fn verify(
        fixture: &Fixture,
    ) -> Result<VerifiedDrainSourceAuthorityBundle, DrainSourceAuthorizationError> {
        verify_bundle_with_trusts(
            &fixture.permit,
            &fixture.assembler,
            &fixture.verifier,
            &fixture.expected_authorization(),
            &fixture.expected_snapshot(),
            &fixture.authorizer_trust,
            &fixture.assembler_trust,
            &fixture.verifier_trust,
            NOW,
        )
    }

    #[test]
    fn verifies_exact_independent_bundle_without_serializing_secrets() {
        let fixture = fixture();
        let verified = verify(&fixture).unwrap();
        assert_eq!(
            verified.authorization.authorization_contract,
            DRAIN_SOURCE_AUTHORIZATION_CONTRACT
        );
        assert_eq!(verified.assembler.attestation_role, "assembler");
        assert_eq!(verified.verifier.attestation_role, "verifier");
        assert_ne!(
            verified.assembler.signer_spki_sha256,
            verified.verifier.signer_spki_sha256
        );
        let value = serde_json::to_value(verified).unwrap();
        let encoded = serde_json::to_string(&value).unwrap();
        for forbidden in [
            "signature_base64url",
            "spki_base64url",
            "raw-execution-nonce-never-persisted",
        ] {
            assert!(!encoded.contains(forbidden));
        }
        assert!(encoded.contains("authorization_subject_sha256"));
        assert!(encoded.contains("signature_envelope_sha256"));
    }

    #[test]
    fn subject_hashes_are_stable_golden_vectors() {
        let fixture = fixture();
        assert_eq!(
            sha256_hex(authorization_message(&fixture.permit).unwrap()),
            "6d226fdedaad93ffb55d7cbad08a91e724343fa21e666a00c13c1233c4826670"
        );
        assert_eq!(
            sha256_hex(attestation_message(&fixture.assembler).unwrap()),
            "64f624c39cf4e810521506e4525850827c454c053d2e2584990e4c40c39aa2c1"
        );
    }

    #[test]
    fn rejects_signed_snapshot_tampering() {
        let mut fixture = fixture();
        fixture.verifier.accepted_set_manifest_sha256 = sha256_hex("tampered");
        assert_eq!(
            verify(&fixture),
            Err(DrainSourceAuthorizationError::BindingMismatch)
        );

        fixture.resign_verifier();
        let expected = fixture.expected_snapshot();
        assert_eq!(
            verify_bundle_with_trusts(
                &fixture.permit,
                &fixture.assembler,
                &fixture.verifier,
                &fixture.expected_authorization(),
                &expected,
                &fixture.authorizer_trust,
                &fixture.assembler_trust,
                &fixture.verifier_trust,
                NOW,
            ),
            Err(DrainSourceAuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn rejects_authorization_signature_tampering() {
        let mut fixture = fixture();
        fixture.permit.collector_version_id = "collector-v2".to_owned();
        let mut expected = fixture.expected_authorization();
        expected.collector_version_id = "collector-v2";
        assert_eq!(
            verify_bundle_with_trusts(
                &fixture.permit,
                &fixture.assembler,
                &fixture.verifier,
                &expected,
                &fixture.expected_snapshot(),
                &fixture.authorizer_trust,
                &fixture.assembler_trust,
                &fixture.verifier_trust,
                NOW,
            ),
            Err(DrainSourceAuthorizationError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_reused_role_key_or_identity() {
        let fixture = fixture();
        assert_eq!(
            verify_bundle_with_trusts(
                &fixture.permit,
                &fixture.assembler,
                &fixture.verifier,
                &fixture.expected_authorization(),
                &fixture.expected_snapshot(),
                &fixture.authorizer_trust,
                &fixture.assembler_trust,
                &fixture.assembler_trust,
                NOW,
            ),
            Err(DrainSourceAuthorizationError::IndependenceViolation)
        );
    }

    #[test]
    fn rejects_role_order_and_expired_validity() {
        let mut role_order_fixture = fixture();
        role_order_fixture.verifier.attested_at = NOW - 2;
        role_order_fixture.verifier.valid_until = NOW + 240;
        role_order_fixture.resign_verifier();
        assert_eq!(
            verify(&role_order_fixture),
            Err(DrainSourceAuthorizationError::IndependenceViolation)
        );

        let mut expired_fixture = fixture();
        expired_fixture.permit.expires_at = NOW + 20;
        expired_fixture.resign_authorization();
        assert_eq!(
            verify(&expired_fixture),
            Err(DrainSourceAuthorizationError::InvalidValidity)
        );
    }

    #[test]
    fn rejects_noncanonical_signature_encoding_and_unknown_fields() {
        let mut fixture = fixture();
        fixture.assembler.signature_base64url.push('=');
        assert_eq!(
            verify(&fixture),
            Err(DrainSourceAuthorizationError::InvalidAttestation)
        );
        let mut value = serde_json::to_value(&fixture.permit).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<DrainSourceAuthorizationPermit>(value).is_err());
    }
}
