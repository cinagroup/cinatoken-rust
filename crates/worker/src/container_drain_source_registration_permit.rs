//! Verification for the isolated drain-source registration permit issuer.
//!
//! The Application owns only the public trust tuple and this verifier. Permit
//! signing and private-key configuration live in the isolated issuer Worker.

use std::collections::BTreeMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
#[cfg(test)]
use serde::Serialize;
use sha2::{Digest, Sha256};
use worker::Env;

use crate::container_drain_source_registration_action::{
    DrainSourceRegistrationPermitBindings, DRAIN_SOURCE_REGISTRATION_ACTION,
};

pub(crate) const DRAIN_SOURCE_REGISTRATION_PERMIT_CONTRACT: &str =
    "relay-container-drain-source-registration-permit-v1";
pub(crate) const DRAIN_SOURCE_REGISTRATION_PERMIT_ENVELOPE_CONTRACT: &str =
    "relay-container-drain-source-registration-permit-envelope-v1";

const PERMIT_SUBJECT_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-permit-v1";
const PERMIT_ENVELOPE_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-permit-envelope-v1";
const PERMIT_ID_DOMAIN: &[u8] = b"cinatoken-relay-container-drain-source-registration-permit-id-v1";
const PERMIT_ALGORITHM: &str = "Ed25519";
const EXPECTED_ENVIRONMENT: &str = "staging";
const MINIMUM_PERMIT_LIFETIME_SECONDS: i64 = 5;
const MAXIMUM_PERMIT_LIFETIME_SECONDS: i64 = 30;
const MAXIMUM_CLOCK_SKEW_SECONDS: i64 = 5;
const MAXIMUM_ISSUER_RESPONSE_BYTES: usize = 32 * 1024;
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

const TRUST_ENV: TrustEnvNames = TrustEnvNames {
    issuer: "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER",
    audience: "DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE",
    key_id: "DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID",
    identity_sha256: "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_IDENTITY_SHA256",
    spki_base64url: "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL",
    spki_sha256: "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256",
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationPermitSubject {
    schema_version: u32,
    contract: String,
    issuer: String,
    audience: String,
    key_id: String,
    signer_identity_sha256: String,
    signer_spki_sha256: String,
    environment: String,
    action: String,
    authorization_id_sha256: String,
    authorization_subject_sha256: String,
    authorization_signature_envelope_sha256: String,
    action_subject_sha256: String,
    action_digest_sha256: String,
    registration_request_sha256: String,
    admin_audit_digest_sha256: String,
    change_ticket_sha256: String,
    root_admin_id: i64,
    root_session_epoch: i64,
    root_session_binding_sha256: String,
    passkey_credential_row_id: i64,
    passkey_credential_id_sha256: String,
    passkey_assertion_subject_sha256: String,
    passkey_assertion_signature_sha256: String,
    secure_verification_challenge_sha256: String,
    passkey_previous_sign_count: u32,
    passkey_sign_count: u32,
    passkey_user_present: bool,
    passkey_user_verified: bool,
    passkey_backup_eligible: bool,
    passkey_backup_state: bool,
    registered_by_service_name: String,
    registered_by_version_id: String,
    registration_execution_id_sha256: String,
    registration_credential_id_sha256: String,
    authority_ledger_identity_sha256: String,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    verification_expires_at: i64,
    permit_id_sha256: String,
    verified_at: i64,
    issued_at: i64,
    expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationPermitEnvelope {
    schema_version: u32,
    contract: String,
    algorithm: String,
    subject: DrainSourceRegistrationPermitSubject,
    subject_sha256: String,
    signature_base64url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationPermitIssuerResponse {
    envelope: DrainSourceRegistrationPermitEnvelope,
    subject_sha256: String,
    signature_envelope_sha256: String,
    request_id: String,
    issuer_version_id: String,
}

#[derive(Clone, Debug)]
struct DrainSourceRegistrationPermitTrust {
    issuer: String,
    audience: String,
    key_id: String,
    identity_sha256: String,
    spki_base64url: String,
    spki_sha256: String,
}

#[derive(Clone, Copy)]
struct TrustEnvNames {
    issuer: &'static str,
    audience: &'static str,
    key_id: &'static str,
    identity_sha256: &'static str,
    spki_base64url: &'static str,
    spki_sha256: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedDrainSourceRegistrationPermit {
    subject: DrainSourceRegistrationPermitSubject,
    subject_sha256: String,
    signature_envelope_sha256: String,
}

impl VerifiedDrainSourceRegistrationPermit {
    pub(crate) fn permit_id_sha256(&self) -> &str {
        &self.subject.permit_id_sha256
    }

    pub(crate) fn subject_sha256(&self) -> &str {
        &self.subject_sha256
    }

    pub(crate) fn signature_envelope_sha256(&self) -> &str {
        &self.signature_envelope_sha256
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DrainSourceRegistrationPermitError {
    MissingTrust,
    InvalidTrust,
    InvalidEnvelope,
    InvalidPermit,
    BindingMismatch,
    InvalidValidity,
    InvalidSignature,
}

impl DrainSourceRegistrationPermitError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::MissingTrust => "drain_source_registration_permit_trust_missing",
            Self::InvalidTrust => "drain_source_registration_permit_trust_invalid",
            Self::InvalidEnvelope => "drain_source_registration_permit_envelope_invalid",
            Self::InvalidPermit => "drain_source_registration_permit_invalid",
            Self::BindingMismatch => "drain_source_registration_permit_binding_mismatch",
            Self::InvalidValidity => "drain_source_registration_permit_validity_invalid",
            Self::InvalidSignature => "drain_source_registration_permit_signature_invalid",
        }
    }
}

impl std::fmt::Display for DrainSourceRegistrationPermitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DrainSourceRegistrationPermitError {}

pub(crate) fn verify_drain_source_registration_permit_from_env(
    env: &Env,
    issuer_response_json: &[u8],
    expected: &DrainSourceRegistrationPermitBindings,
    authenticated_request_id: &str,
    now: i64,
) -> Result<VerifiedDrainSourceRegistrationPermit, DrainSourceRegistrationPermitError> {
    if issuer_response_json.is_empty() || issuer_response_json.len() > MAXIMUM_ISSUER_RESPONSE_BYTES
    {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    let response =
        serde_json::from_slice::<DrainSourceRegistrationPermitIssuerResponse>(issuer_response_json)
            .map_err(|_| DrainSourceRegistrationPermitError::InvalidEnvelope)?;
    let trust = DrainSourceRegistrationPermitTrust::from_env(env)?;
    verify_response_with_trust(&response, expected, authenticated_request_id, &trust, now)
}

impl DrainSourceRegistrationPermitTrust {
    fn from_env(env: &Env) -> Result<Self, DrainSourceRegistrationPermitError> {
        Ok(Self {
            issuer: required_env(env, TRUST_ENV.issuer)?,
            audience: required_env(env, TRUST_ENV.audience)?,
            key_id: required_env(env, TRUST_ENV.key_id)?,
            identity_sha256: required_env(env, TRUST_ENV.identity_sha256)?,
            spki_base64url: required_env(env, TRUST_ENV.spki_base64url)?,
            spki_sha256: required_env(env, TRUST_ENV.spki_sha256)?,
        })
    }
}

fn required_env(
    env: &Env,
    name: &'static str,
) -> Result<String, DrainSourceRegistrationPermitError> {
    let value = env
        .var(name)
        .map_err(|_| DrainSourceRegistrationPermitError::MissingTrust)?
        .to_string();
    if value.is_empty() {
        return Err(DrainSourceRegistrationPermitError::MissingTrust);
    }
    Ok(value)
}

fn verify_with_trust(
    envelope: &DrainSourceRegistrationPermitEnvelope,
    expected: &DrainSourceRegistrationPermitBindings,
    authenticated_request_id: &str,
    trust: &DrainSourceRegistrationPermitTrust,
    now: i64,
) -> Result<VerifiedDrainSourceRegistrationPermit, DrainSourceRegistrationPermitError> {
    let verifying_key = validate_trust(trust)?;
    validate_envelope(envelope)?;
    validate_subject_shape(&envelope.subject, trust)?;
    validate_bindings(&envelope.subject, expected)?;
    validate_validity(&envelope.subject, now)?;
    if !valid_request_id(authenticated_request_id)
        || envelope.subject.permit_id_sha256
            != derive_permit_id_sha256(&envelope.subject, authenticated_request_id)?
    {
        return Err(DrainSourceRegistrationPermitError::BindingMismatch);
    }

    let message = permit_subject_message(&envelope.subject)?;
    let subject_sha256 = sha256_hex(&message);
    if envelope.subject_sha256 != subject_sha256 {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    let signature = decode_canonical_base64url(&envelope.signature_base64url, 64)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidEnvelope)?;
    let signature = Signature::from_slice(&signature)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidEnvelope)?;
    verifying_key
        .verify_strict(&message, &signature)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidSignature)?;
    let signature_envelope_sha256 =
        permit_signature_envelope_sha256(&envelope.subject, &subject_sha256, &signature)?;

    Ok(VerifiedDrainSourceRegistrationPermit {
        subject: envelope.subject.clone(),
        subject_sha256,
        signature_envelope_sha256,
    })
}

fn verify_response_with_trust(
    response: &DrainSourceRegistrationPermitIssuerResponse,
    expected: &DrainSourceRegistrationPermitBindings,
    authenticated_request_id: &str,
    trust: &DrainSourceRegistrationPermitTrust,
    now: i64,
) -> Result<VerifiedDrainSourceRegistrationPermit, DrainSourceRegistrationPermitError> {
    if !valid_request_id(&response.request_id) || response.request_id != authenticated_request_id {
        return Err(DrainSourceRegistrationPermitError::BindingMismatch);
    }
    if !valid_version_id(&response.issuer_version_id)
        || !valid_sha256(&response.subject_sha256)
        || !valid_sha256(&response.signature_envelope_sha256)
    {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    let verified = verify_with_trust(
        &response.envelope,
        expected,
        authenticated_request_id,
        trust,
        now,
    )?;
    if response.subject_sha256 != verified.subject_sha256
        || response.signature_envelope_sha256 != verified.signature_envelope_sha256
    {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    Ok(verified)
}

fn validate_trust(
    trust: &DrainSourceRegistrationPermitTrust,
) -> Result<VerifyingKey, DrainSourceRegistrationPermitError> {
    if !valid_identity(&trust.issuer)
        || !valid_identity(&trust.audience)
        || !valid_key_id(&trust.key_id)
        || !valid_sha256(&trust.identity_sha256)
        || !valid_sha256(&trust.spki_sha256)
        || trust.identity_sha256 == trust.spki_sha256
    {
        return Err(DrainSourceRegistrationPermitError::InvalidTrust);
    }
    let spki = decode_canonical_base64url(&trust.spki_base64url, ED25519_SPKI_PREFIX.len() + 32)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidTrust)?;
    if sha256_hex(&spki) != trust.spki_sha256 {
        return Err(DrainSourceRegistrationPermitError::InvalidTrust);
    }
    let key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(DrainSourceRegistrationPermitError::InvalidTrust)?;
    VerifyingKey::from_bytes(key_bytes)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidTrust)
}

fn validate_envelope(
    envelope: &DrainSourceRegistrationPermitEnvelope,
) -> Result<(), DrainSourceRegistrationPermitError> {
    if envelope.schema_version != 1
        || envelope.contract != DRAIN_SOURCE_REGISTRATION_PERMIT_ENVELOPE_CONTRACT
        || envelope.algorithm != PERMIT_ALGORITHM
        || !valid_sha256(&envelope.subject_sha256)
        || envelope.signature_base64url.len() != 86
    {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    Ok(())
}

fn validate_subject_shape(
    subject: &DrainSourceRegistrationPermitSubject,
    trust: &DrainSourceRegistrationPermitTrust,
) -> Result<(), DrainSourceRegistrationPermitError> {
    if subject.schema_version != 1
        || subject.contract != DRAIN_SOURCE_REGISTRATION_PERMIT_CONTRACT
        || subject.issuer != trust.issuer
        || subject.audience != trust.audience
        || subject.key_id != trust.key_id
        || subject.signer_identity_sha256 != trust.identity_sha256
        || subject.signer_spki_sha256 != trust.spki_sha256
        || subject.environment != EXPECTED_ENVIRONMENT
        || subject.action != DRAIN_SOURCE_REGISTRATION_ACTION
        || subject.root_admin_id <= 0
        || subject.root_admin_id > MAXIMUM_SAFE_INTEGER
        || subject.root_session_epoch < 0
        || subject.root_session_epoch > MAXIMUM_SAFE_INTEGER
        || subject.passkey_credential_row_id <= 0
        || subject.passkey_credential_row_id > MAXIMUM_SAFE_INTEGER
        || !subject.passkey_user_present
        || !subject.passkey_user_verified
        || subject.passkey_backup_state && !subject.passkey_backup_eligible
        || !valid_sign_count_transition(
            subject.passkey_previous_sign_count,
            subject.passkey_sign_count,
        )
        || !valid_service_name(&subject.registered_by_service_name)
        || !valid_version_id(&subject.registered_by_version_id)
        || !(1..=1_000_000).contains(&subject.receipt_sequence)
    {
        return Err(DrainSourceRegistrationPermitError::InvalidPermit);
    }
    for digest in [
        &subject.signer_identity_sha256,
        &subject.signer_spki_sha256,
        &subject.authorization_id_sha256,
        &subject.authorization_subject_sha256,
        &subject.authorization_signature_envelope_sha256,
        &subject.action_subject_sha256,
        &subject.action_digest_sha256,
        &subject.registration_request_sha256,
        &subject.admin_audit_digest_sha256,
        &subject.change_ticket_sha256,
        &subject.root_session_binding_sha256,
        &subject.passkey_credential_id_sha256,
        &subject.passkey_assertion_subject_sha256,
        &subject.passkey_assertion_signature_sha256,
        &subject.secure_verification_challenge_sha256,
        &subject.registration_execution_id_sha256,
        &subject.registration_credential_id_sha256,
        &subject.authority_ledger_identity_sha256,
        &subject.ledger_head_before_sha256,
        &subject.permit_id_sha256,
    ] {
        if !valid_sha256(digest) {
            return Err(DrainSourceRegistrationPermitError::InvalidPermit);
        }
    }
    if subject.signer_identity_sha256 == subject.signer_spki_sha256
        || subject.authorization_subject_sha256 == subject.authorization_signature_envelope_sha256
        || subject.action_digest_sha256 == subject.registration_request_sha256
        || subject.action_digest_sha256 == subject.admin_audit_digest_sha256
        || subject.registration_request_sha256 == subject.admin_audit_digest_sha256
        || subject.registration_execution_id_sha256 == subject.registration_credential_id_sha256
        || subject.passkey_assertion_subject_sha256 == subject.passkey_assertion_signature_sha256
    {
        return Err(DrainSourceRegistrationPermitError::InvalidPermit);
    }
    Ok(())
}

fn validate_bindings(
    subject: &DrainSourceRegistrationPermitSubject,
    expected: &DrainSourceRegistrationPermitBindings,
) -> Result<(), DrainSourceRegistrationPermitError> {
    let expected_request = expected
        .issue_request()
        .map_err(|_| DrainSourceRegistrationPermitError::BindingMismatch)?;
    let subject_request = permit_issue_request_bytes(subject)?;
    if subject_request != expected_request.as_bytes() {
        return Err(DrainSourceRegistrationPermitError::BindingMismatch);
    }
    Ok(())
}

fn permit_issue_request_bytes(
    subject: &DrainSourceRegistrationPermitSubject,
) -> Result<Vec<u8>, DrainSourceRegistrationPermitError> {
    let request = BTreeMap::from([
        ("action", serde_json::Value::String(subject.action.clone())),
        (
            "actionDigestSha256",
            serde_json::Value::String(subject.action_digest_sha256.clone()),
        ),
        (
            "actionSubjectSha256",
            serde_json::Value::String(subject.action_subject_sha256.clone()),
        ),
        (
            "adminAuditDigestSha256",
            serde_json::Value::String(subject.admin_audit_digest_sha256.clone()),
        ),
        (
            "authorityLedgerIdentitySha256",
            serde_json::Value::String(subject.authority_ledger_identity_sha256.clone()),
        ),
        (
            "authorizationIdSha256",
            serde_json::Value::String(subject.authorization_id_sha256.clone()),
        ),
        (
            "authorizationSignatureEnvelopeSha256",
            serde_json::Value::String(subject.authorization_signature_envelope_sha256.clone()),
        ),
        (
            "authorizationSubjectSha256",
            serde_json::Value::String(subject.authorization_subject_sha256.clone()),
        ),
        (
            "changeTicketSha256",
            serde_json::Value::String(subject.change_ticket_sha256.clone()),
        ),
        (
            "environment",
            serde_json::Value::String(subject.environment.clone()),
        ),
        (
            "ledgerHeadBeforeSha256",
            serde_json::Value::String(subject.ledger_head_before_sha256.clone()),
        ),
        (
            "passkeyAssertionSignatureSha256",
            serde_json::Value::String(subject.passkey_assertion_signature_sha256.clone()),
        ),
        (
            "passkeyAssertionSubjectSha256",
            serde_json::Value::String(subject.passkey_assertion_subject_sha256.clone()),
        ),
        (
            "passkeyBackupEligible",
            serde_json::Value::Bool(subject.passkey_backup_eligible),
        ),
        (
            "passkeyBackupState",
            serde_json::Value::Bool(subject.passkey_backup_state),
        ),
        (
            "passkeyCredentialIdSha256",
            serde_json::Value::String(subject.passkey_credential_id_sha256.clone()),
        ),
        (
            "passkeyCredentialRowId",
            serde_json::Value::from(subject.passkey_credential_row_id),
        ),
        (
            "passkeyPreviousSignCount",
            serde_json::Value::from(subject.passkey_previous_sign_count),
        ),
        (
            "passkeySignCount",
            serde_json::Value::from(subject.passkey_sign_count),
        ),
        (
            "passkeyUserPresent",
            serde_json::Value::Bool(subject.passkey_user_present),
        ),
        (
            "passkeyUserVerified",
            serde_json::Value::Bool(subject.passkey_user_verified),
        ),
        (
            "receiptSequence",
            serde_json::Value::from(subject.receipt_sequence),
        ),
        (
            "registeredByServiceName",
            serde_json::Value::String(subject.registered_by_service_name.clone()),
        ),
        (
            "registeredByVersionId",
            serde_json::Value::String(subject.registered_by_version_id.clone()),
        ),
        (
            "registrationCredentialIdSha256",
            serde_json::Value::String(subject.registration_credential_id_sha256.clone()),
        ),
        (
            "registrationExecutionIdSha256",
            serde_json::Value::String(subject.registration_execution_id_sha256.clone()),
        ),
        (
            "registrationRequestSha256",
            serde_json::Value::String(subject.registration_request_sha256.clone()),
        ),
        (
            "rootAdminId",
            serde_json::Value::from(subject.root_admin_id),
        ),
        (
            "rootSessionBindingSha256",
            serde_json::Value::String(subject.root_session_binding_sha256.clone()),
        ),
        (
            "rootSessionEpoch",
            serde_json::Value::from(subject.root_session_epoch),
        ),
        (
            "secureVerificationChallengeSha256",
            serde_json::Value::String(subject.secure_verification_challenge_sha256.clone()),
        ),
        (
            "verificationExpiresAt",
            serde_json::Value::from(subject.verification_expires_at),
        ),
        ("verifiedAt", serde_json::Value::from(subject.verified_at)),
    ]);
    serde_json::to_vec(&request).map_err(|_| DrainSourceRegistrationPermitError::InvalidPermit)
}

fn validate_validity(
    subject: &DrainSourceRegistrationPermitSubject,
    now: i64,
) -> Result<(), DrainSourceRegistrationPermitError> {
    let lifetime = subject.expires_at.checked_sub(subject.issued_at);
    let issued_from_verification = subject.issued_at.checked_sub(subject.verified_at);
    if now <= 0
        || subject.verified_at <= 0
        || subject.issued_at <= 0
        || subject.expires_at <= 0
        || subject.verification_expires_at <= 0
        || subject.verified_at > MAXIMUM_SAFE_INTEGER
        || subject.issued_at > MAXIMUM_SAFE_INTEGER
        || subject.expires_at > MAXIMUM_SAFE_INTEGER
        || subject.verification_expires_at > MAXIMUM_SAFE_INTEGER
        || !matches!(
            lifetime,
            Some(MINIMUM_PERMIT_LIFETIME_SECONDS..=MAXIMUM_PERMIT_LIFETIME_SECONDS)
        )
        || !matches!(
            issued_from_verification,
            Some(0..=MAXIMUM_CLOCK_SKEW_SECONDS)
        )
        || subject.issued_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || subject.verified_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || subject.expires_at <= now
        || subject.expires_at > subject.verification_expires_at
    {
        return Err(DrainSourceRegistrationPermitError::InvalidValidity);
    }
    Ok(())
}

fn permit_subject_message(
    subject: &DrainSourceRegistrationPermitSubject,
) -> Result<Vec<u8>, DrainSourceRegistrationPermitError> {
    let fields = vec![
        subject.schema_version.to_string(),
        subject.contract.clone(),
        subject.issuer.clone(),
        subject.audience.clone(),
        subject.key_id.clone(),
        subject.signer_identity_sha256.clone(),
        subject.signer_spki_sha256.clone(),
        subject.environment.clone(),
        subject.action.clone(),
        subject.authorization_id_sha256.clone(),
        subject.authorization_subject_sha256.clone(),
        subject.authorization_signature_envelope_sha256.clone(),
        subject.action_subject_sha256.clone(),
        subject.action_digest_sha256.clone(),
        subject.registration_request_sha256.clone(),
        subject.admin_audit_digest_sha256.clone(),
        subject.change_ticket_sha256.clone(),
        subject.root_admin_id.to_string(),
        subject.root_session_epoch.to_string(),
        subject.root_session_binding_sha256.clone(),
        subject.passkey_credential_row_id.to_string(),
        subject.passkey_credential_id_sha256.clone(),
        subject.passkey_assertion_subject_sha256.clone(),
        subject.passkey_assertion_signature_sha256.clone(),
        subject.secure_verification_challenge_sha256.clone(),
        subject.passkey_previous_sign_count.to_string(),
        subject.passkey_sign_count.to_string(),
        subject.passkey_user_present.to_string(),
        subject.passkey_user_verified.to_string(),
        subject.passkey_backup_eligible.to_string(),
        subject.passkey_backup_state.to_string(),
        subject.registered_by_service_name.clone(),
        subject.registered_by_version_id.clone(),
        subject.registration_execution_id_sha256.clone(),
        subject.registration_credential_id_sha256.clone(),
        subject.authority_ledger_identity_sha256.clone(),
        subject.receipt_sequence.to_string(),
        subject.ledger_head_before_sha256.clone(),
        subject.verification_expires_at.to_string(),
        subject.permit_id_sha256.clone(),
        subject.verified_at.to_string(),
        subject.issued_at.to_string(),
        subject.expires_at.to_string(),
    ];
    canonical_message(PERMIT_SUBJECT_DOMAIN, &fields)
}

fn derive_permit_id_sha256(
    subject: &DrainSourceRegistrationPermitSubject,
    authenticated_request_id: &str,
) -> Result<String, DrainSourceRegistrationPermitError> {
    canonical_message(
        PERMIT_ID_DOMAIN,
        &[
            authenticated_request_id.to_owned(),
            subject.action_subject_sha256.clone(),
            subject.passkey_assertion_signature_sha256.clone(),
            subject.secure_verification_challenge_sha256.clone(),
            subject.issued_at.to_string(),
            subject.expires_at.to_string(),
        ],
    )
    .map(|message| sha256_hex(&message))
}

fn permit_signature_envelope_sha256(
    subject: &DrainSourceRegistrationPermitSubject,
    subject_sha256: &str,
    signature: &Signature,
) -> Result<String, DrainSourceRegistrationPermitError> {
    let signature_base64url = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    canonical_message(
        PERMIT_ENVELOPE_DOMAIN,
        &[
            PERMIT_ALGORITHM.to_owned(),
            subject.issuer.clone(),
            subject.audience.clone(),
            subject.key_id.clone(),
            subject.signer_identity_sha256.clone(),
            subject.signer_spki_sha256.clone(),
            subject_sha256.to_owned(),
            signature_base64url,
        ],
    )
    .map(|message| sha256_hex(&message))
}

fn canonical_message(
    domain: &[u8],
    fields: &[String],
) -> Result<Vec<u8>, DrainSourceRegistrationPermitError> {
    let payload_bytes = fields.iter().try_fold(0usize, |total, field| {
        u32::try_from(field.len())
            .ok()
            .and_then(|_| total.checked_add(4 + field.len()))
            .ok_or(DrainSourceRegistrationPermitError::InvalidPermit)
    })?;
    let mut message = Vec::with_capacity(domain.len() + payload_bytes);
    message.extend_from_slice(domain);
    for field in fields {
        let bytes = field.as_bytes();
        let length = u32::try_from(bytes.len())
            .map_err(|_| DrainSourceRegistrationPermitError::InvalidPermit)?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(bytes);
    }
    Ok(message)
}

fn decode_canonical_base64url(
    value: &str,
    expected_len: usize,
) -> Result<Vec<u8>, DrainSourceRegistrationPermitError> {
    if value.is_empty()
        || value.as_bytes().contains(&b'=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| DrainSourceRegistrationPermitError::InvalidEnvelope)?;
    if decoded.len() != expected_len || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(DrainSourceRegistrationPermitError::InvalidEnvelope);
    }
    Ok(decoded)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identity(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_service_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
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
    valid_identity(value)
}

fn valid_request_id(value: &str) -> bool {
    valid_identity(value)
}

fn valid_sign_count_transition(previous: u32, current: u32) -> bool {
    previous == 0 && current == 0 || current > previous
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(value.as_ref());
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 2_000_000_000;
    const REQUEST_ID: &str = "registration-request-canary-001";

    fn digest(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn label_digest(label: &str) -> String {
        sha256_hex(label)
    }

    fn bindings() -> DrainSourceRegistrationPermitBindings {
        DrainSourceRegistrationPermitBindings::test_fixture(NOW)
    }

    fn signing_material() -> (SigningKey, DrainSourceRegistrationPermitTrust) {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(signing_key.verifying_key().as_bytes());
        let trust = DrainSourceRegistrationPermitTrust {
            issuer: "cinatoken-drain-source-registration-permit-issuer-staging".to_owned(),
            audience: "cinatoken-relay-application:staging:drain-source-registration:v1".to_owned(),
            key_id: "registration-permit-staging-v1".to_owned(),
            identity_sha256: digest(19),
            spki_base64url: URL_SAFE_NO_PAD.encode(&spki),
            spki_sha256: sha256_hex(&spki),
        };
        (signing_key, trust)
    }

    fn signed_envelope(
        _expected: &DrainSourceRegistrationPermitBindings,
    ) -> (
        DrainSourceRegistrationPermitEnvelope,
        DrainSourceRegistrationPermitTrust,
    ) {
        let (signing_key, trust) = signing_material();
        let mut subject = DrainSourceRegistrationPermitSubject {
            schema_version: 1,
            contract: DRAIN_SOURCE_REGISTRATION_PERMIT_CONTRACT.to_owned(),
            issuer: trust.issuer.clone(),
            audience: trust.audience.clone(),
            key_id: trust.key_id.clone(),
            signer_identity_sha256: trust.identity_sha256.clone(),
            signer_spki_sha256: trust.spki_sha256.clone(),
            environment: "staging".to_owned(),
            action: DRAIN_SOURCE_REGISTRATION_ACTION.to_owned(),
            authorization_id_sha256: digest(1),
            authorization_subject_sha256: digest(2),
            authorization_signature_envelope_sha256: digest(3),
            action_subject_sha256: digest(4),
            action_digest_sha256: digest(5),
            registration_request_sha256: digest(6),
            admin_audit_digest_sha256: digest(8),
            change_ticket_sha256: digest(9),
            root_admin_id: 1,
            root_session_epoch: 7,
            root_session_binding_sha256: digest(10),
            passkey_credential_row_id: 11,
            passkey_credential_id_sha256: digest(11),
            passkey_assertion_subject_sha256: digest(12),
            passkey_assertion_signature_sha256: digest(13),
            secure_verification_challenge_sha256: digest(14),
            passkey_previous_sign_count: 41,
            passkey_sign_count: 42,
            passkey_user_present: true,
            passkey_user_verified: true,
            passkey_backup_eligible: true,
            passkey_backup_state: false,
            registered_by_service_name: "cinatoken-application".to_owned(),
            registered_by_version_id: "application-version-001".to_owned(),
            registration_execution_id_sha256: digest(15),
            registration_credential_id_sha256: digest(20),
            authority_ledger_identity_sha256: digest(17),
            receipt_sequence: 1,
            ledger_head_before_sha256: digest(18),
            verification_expires_at: NOW + 24,
            permit_id_sha256: String::new(),
            verified_at: NOW,
            issued_at: NOW,
            expires_at: NOW + 24,
        };
        subject.permit_id_sha256 = derive_permit_id_sha256(&subject, REQUEST_ID).unwrap();
        let message = permit_subject_message(&subject).unwrap();
        let signature = signing_key.sign(&message);
        let envelope = DrainSourceRegistrationPermitEnvelope {
            schema_version: 1,
            contract: DRAIN_SOURCE_REGISTRATION_PERMIT_ENVELOPE_CONTRACT.to_owned(),
            algorithm: PERMIT_ALGORITHM.to_owned(),
            subject,
            subject_sha256: sha256_hex(&message),
            signature_base64url: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        (envelope, trust)
    }

    fn issuer_response(
        envelope: DrainSourceRegistrationPermitEnvelope,
    ) -> DrainSourceRegistrationPermitIssuerResponse {
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(&envelope.signature_base64url)
            .unwrap();
        let signature = Signature::from_slice(&signature_bytes).unwrap();
        let signature_envelope_sha256 = permit_signature_envelope_sha256(
            &envelope.subject,
            &envelope.subject_sha256,
            &signature,
        )
        .unwrap();
        DrainSourceRegistrationPermitIssuerResponse {
            subject_sha256: envelope.subject_sha256.clone(),
            signature_envelope_sha256,
            request_id: REQUEST_ID.to_owned(),
            issuer_version_id: "registration-permit-issuer-version-001".to_owned(),
            envelope,
        }
    }

    #[test]
    fn verifies_exact_action_bound_permit_and_returns_only_verified_digests() {
        let expected = bindings();
        let (envelope, trust) = signed_envelope(&expected);
        assert_eq!(
            trust.spki_base64url,
            "MCowBQYDK2VwAyEA6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw"
        );
        assert_eq!(
            trust.spki_sha256,
            "324be2dea8bc44461b0233e51fa48902ed6b1cc671e7739af2551e0bfe68f54e"
        );
        assert_eq!(
            envelope.subject.permit_id_sha256,
            "33b768701f84f398cbf03fb83daffb0ff850bb1130f07c65551355cf8208c347"
        );
        assert_eq!(
            permit_subject_message(&envelope.subject).unwrap().len(),
            1_884
        );
        assert_eq!(
            envelope.subject_sha256,
            "5bcbcc90ac9a1a46b65e2f2853dfdb032bfe0652984c3066acabe1507498ff52"
        );
        assert_eq!(
            envelope.signature_base64url,
            "cJ5gmP_WydYTQg5SCvPjYfJgHBXy0scIJzsAt8ZU5uAWD5LDOFK9xHfGYPnswhWgAOahyUzE8AwYTlsYYVnCAw"
        );
        let issue_request = expected.issue_request().unwrap();
        assert_eq!(issue_request.as_bytes().len(), 2_120);
        assert_eq!(
            sha256_hex(issue_request.as_bytes()),
            "0af33ec080e15ee14f24877d805deed7fcf27fd5ebd8cda1a48313c0ba8416e1"
        );
        assert_eq!(
            permit_issue_request_bytes(&envelope.subject).unwrap(),
            issue_request.as_bytes()
        );
        let verified =
            verify_with_trust(&envelope, &expected, REQUEST_ID, &trust, NOW + 2).unwrap();
        assert_eq!(
            verified.permit_id_sha256(),
            envelope.subject.permit_id_sha256
        );
        assert_eq!(verified.subject_sha256(), envelope.subject_sha256);
        assert_eq!(verified.signature_envelope_sha256().len(), 64);
        assert_eq!(
            verified.signature_envelope_sha256(),
            "8d8c6c6399f38fa712c6352b341252dd62c201a050166dfd1bac47e10b2296b7"
        );
        assert_ne!(
            verified.signature_envelope_sha256(),
            verified.subject_sha256()
        );

        let response = issuer_response(envelope);
        let verified =
            verify_response_with_trust(&response, &expected, REQUEST_ID, &trust, NOW + 2).unwrap();
        assert_eq!(
            verified.signature_envelope_sha256(),
            response.signature_envelope_sha256
        );
    }

    #[test]
    fn every_expected_binding_is_checked() {
        let expected = bindings();
        let (envelope, trust) = signed_envelope(&expected);

        macro_rules! assert_binding_drift {
            ($field:ident, $value:expr) => {{
                let mut changed = envelope.clone();
                changed.subject.$field = $value;
                assert!(
                    matches!(
                        verify_with_trust(&changed, &expected, REQUEST_ID, &trust, NOW + 2),
                        Err(DrainSourceRegistrationPermitError::BindingMismatch)
                            | Err(DrainSourceRegistrationPermitError::InvalidPermit)
                    ),
                    "{}",
                    stringify!($field),
                );
            }};
        }

        assert_binding_drift!(environment, "production".to_owned());
        assert_binding_drift!(authorization_id_sha256, label_digest("authorization-2"));
        assert_binding_drift!(
            authorization_subject_sha256,
            label_digest("authorization-subject-2")
        );
        assert_binding_drift!(
            authorization_signature_envelope_sha256,
            label_digest("authorization-envelope-2")
        );
        assert_binding_drift!(action_subject_sha256, label_digest("action-subject-2"));
        assert_binding_drift!(action_digest_sha256, label_digest("action-2"));
        assert_binding_drift!(registration_request_sha256, label_digest("request-2"));
        assert_binding_drift!(admin_audit_digest_sha256, label_digest("audit-2"));
        assert_binding_drift!(change_ticket_sha256, label_digest("change-ticket-2"));
        assert_binding_drift!(root_admin_id, 2);
        assert_binding_drift!(root_session_epoch, 8);
        assert_binding_drift!(
            root_session_binding_sha256,
            label_digest("session-binding-2")
        );
        assert_binding_drift!(passkey_credential_row_id, 12);
        assert_binding_drift!(
            passkey_credential_id_sha256,
            label_digest("credential-id-2")
        );
        assert_binding_drift!(
            passkey_assertion_subject_sha256,
            label_digest("assertion-subject-2")
        );
        assert_binding_drift!(
            passkey_assertion_signature_sha256,
            label_digest("assertion-signature-2")
        );
        assert_binding_drift!(
            secure_verification_challenge_sha256,
            label_digest("challenge-2")
        );
        assert_binding_drift!(passkey_previous_sign_count, 7);
        assert_binding_drift!(passkey_sign_count, 10);
        assert_binding_drift!(passkey_user_present, false);
        assert_binding_drift!(passkey_user_verified, false);
        assert_binding_drift!(passkey_backup_eligible, false);
        assert_binding_drift!(passkey_backup_state, true);
        assert_binding_drift!(
            registered_by_service_name,
            "cinatoken-application-2".to_owned()
        );
        assert_binding_drift!(registered_by_version_id, "build-2026-07-30-2".to_owned());
        assert_binding_drift!(
            registration_execution_id_sha256,
            label_digest("execution-2")
        );
        assert_binding_drift!(
            registration_credential_id_sha256,
            label_digest("service-credential-2")
        );
        assert_binding_drift!(authority_ledger_identity_sha256, label_digest("ledger-2"));
        assert_binding_drift!(receipt_sequence, 2);
        assert_binding_drift!(ledger_head_before_sha256, label_digest("ledger-head-2"));
        assert_binding_drift!(verification_expires_at, NOW + 121);
        assert_binding_drift!(verified_at, NOW + 1);
    }

    #[test]
    fn audience_request_signature_and_trust_drift_fail_closed() {
        let expected = bindings();
        let (mut envelope, trust) = signed_envelope(&expected);
        assert_eq!(
            verify_with_trust(&envelope, &expected, "different-request", &trust, NOW + 2),
            Err(DrainSourceRegistrationPermitError::BindingMismatch)
        );

        envelope.signature_base64url.replace_range(0..1, "A");
        assert_eq!(
            verify_with_trust(&envelope, &expected, REQUEST_ID, &trust, NOW + 2),
            Err(DrainSourceRegistrationPermitError::InvalidSignature)
        );

        let (envelope, mut wrong_trust) = signed_envelope(&expected);
        wrong_trust.audience.push_str("-other");
        assert_eq!(
            verify_with_trust(&envelope, &expected, REQUEST_ID, &wrong_trust, NOW + 2),
            Err(DrainSourceRegistrationPermitError::InvalidPermit)
        );

        let (_, mut wrong_spki) = signing_material();
        wrong_spki.spki_sha256 = label_digest("wrong-spki");
        assert_eq!(
            validate_trust(&wrong_spki),
            Err(DrainSourceRegistrationPermitError::InvalidTrust)
        );
    }

    #[test]
    fn validity_and_json_shape_are_strict() {
        let expected = bindings();
        let (mut envelope, trust) = signed_envelope(&expected);
        assert_eq!(
            verify_with_trust(&envelope, &expected, REQUEST_ID, &trust, NOW + 24),
            Err(DrainSourceRegistrationPermitError::InvalidValidity)
        );

        envelope.subject.expires_at = envelope.subject.issued_at + 31;
        assert_eq!(
            validate_validity(&envelope.subject, NOW + 2),
            Err(DrainSourceRegistrationPermitError::InvalidValidity)
        );

        let (mut envelope, _) = signed_envelope(&expected);
        envelope.subject.verified_at = envelope.subject.issued_at + 1;
        assert_eq!(
            validate_validity(&envelope.subject, NOW),
            Err(DrainSourceRegistrationPermitError::InvalidValidity)
        );
        envelope.subject.verified_at = envelope.subject.issued_at - 5;
        assert_eq!(validate_validity(&envelope.subject, NOW), Ok(()));

        let (mut envelope, trust) = signed_envelope(&expected);
        envelope.subject.passkey_sign_count = envelope.subject.passkey_previous_sign_count;
        assert_eq!(
            validate_subject_shape(&envelope.subject, &trust),
            Err(DrainSourceRegistrationPermitError::InvalidPermit)
        );

        let (envelope, _) = signed_envelope(&expected);
        let json = serde_json::to_string(&envelope).unwrap();
        let with_unknown = json.replacen('{', "{\"unknown\":true,", 1);
        assert!(
            serde_json::from_str::<DrainSourceRegistrationPermitEnvelope>(&with_unknown).is_err()
        );
        let duplicate = json.replacen(
            "{\"schemaVersion\":1,",
            "{\"schemaVersion\":1,\"schemaVersion\":1,",
            1,
        );
        assert!(serde_json::from_str::<DrainSourceRegistrationPermitEnvelope>(&duplicate).is_err());
        let padded = json.replace(
            &envelope.signature_base64url,
            &format!("{}=", envelope.signature_base64url),
        );
        let padded: DrainSourceRegistrationPermitEnvelope = serde_json::from_str(&padded).unwrap();
        assert_eq!(
            validate_envelope(&padded),
            Err(DrainSourceRegistrationPermitError::InvalidEnvelope)
        );

        let response = issuer_response(envelope);
        let response_json = serde_json::to_string(&response).unwrap();
        let with_unknown = response_json.replacen('{', "{\"unknown\":true,", 1);
        assert!(
            serde_json::from_str::<DrainSourceRegistrationPermitIssuerResponse>(&with_unknown)
                .is_err()
        );
        let duplicate = response_json.replacen(
            "{\"envelope\":",
            "{\"requestId\":\"duplicate\",\"envelope\":",
            1,
        );
        assert!(
            serde_json::from_str::<DrainSourceRegistrationPermitIssuerResponse>(&duplicate)
                .is_err()
        );

        let mut wrong_request = response.clone();
        wrong_request.request_id = "different-request".to_owned();
        assert_eq!(
            verify_response_with_trust(&wrong_request, &expected, REQUEST_ID, &trust, NOW + 2),
            Err(DrainSourceRegistrationPermitError::BindingMismatch)
        );
        let mut wrong_digest = response;
        wrong_digest.signature_envelope_sha256 = digest(31);
        assert_eq!(
            verify_response_with_trust(&wrong_digest, &expected, REQUEST_ID, &trust, NOW + 2),
            Err(DrainSourceRegistrationPermitError::InvalidEnvelope)
        );
    }
}
