//! Action-bound, one-shot WebAuthn proof foundation for 0073 registration.
//!
//! This module is deliberately route-free and writer-free. It freezes the
//! exact Root action into a mandatory-UV challenge and returns proof digests
//! only after the WebAuthn signature has been verified.

use std::{collections::BTreeMap, net::IpAddr};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::Env;

use crate::admin_passkey::passkey_credential_id_sha256;
use crate::container_drain_source_authorization::{
    VerifiedDrainSourceAuthorization, DRAIN_SOURCE_AUTHORIZATION_CONTRACT,
};
use crate::d1_repositories::{
    RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256, RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256,
};
use crate::passkey_ceremony::{self, PasskeyCeremonyError};
use crate::webauthn::{
    self, AssertionCredential, CeremonyExpectation, StoredCredential, VerifiedAssertion,
    WebauthnError,
};

pub(crate) const DRAIN_SOURCE_REGISTRATION_ACTION_CONTRACT: &str =
    "relay-container-drain-source-registration-action-v1";
pub(crate) const DRAIN_SOURCE_REGISTRATION_ACTION: &str =
    "relay_container.drain_source_authorization_register";

const ACTION_SUBJECT_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-action-v1";
const CHALLENGE_DOMAIN: &[u8] = b"cinatoken-relay-container-drain-source-registration-challenge-v1";
const ADMIN_NETWORK_IDENTITY_HMAC_DOMAIN: &[u8] =
    b"cinatoken-relay-container-admin-network-identity-hmac-v1";
const CEREMONY_KEY_PREFIX: &str = "drain-source-registration";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAXIMUM_PREVIOUS_USE_GENERATION: i64 = MAXIMUM_SAFE_INTEGER - 1;
const MINIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 30;
const MAXIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 300;
const ACTION_SUBJECT_FIELD_COUNT: usize = 57;
const PERMIT_ISSUE_REQUEST_FIELD_COUNT: usize = 39;
const MINIMUM_ADMIN_NETWORK_HMAC_KEY_BYTES: usize = 32;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdminNetworkIdentityHmacSha256(String);

impl AdminNetworkIdentityHmacSha256 {
    pub(crate) fn derive(
        secret: &[u8],
        trusted_ip: &str,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        if secret.len() < MINIMUM_ADMIN_NETWORK_HMAC_KEY_BYTES || trusted_ip != trusted_ip.trim() {
            return Err(DrainSourceRegistrationCeremonyError::InvalidAction);
        }
        let canonical_ip = trusted_ip
            .parse::<IpAddr>()
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidAction)?
            .to_string();
        let mut mac = HmacSha256::new_from_slice(secret)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidAction)?;
        mac.update(ADMIN_NETWORK_IDENTITY_HMAC_DOMAIN);
        let length = u32::try_from(canonical_ip.len())
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidAction)?;
        mac.update(&length.to_be_bytes());
        mac.update(canonical_ip.as_bytes());
        Ok(Self(encode_hex(&mac.finalize().into_bytes())))
    }

    fn into_inner(self) -> String {
        self.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationActionV1 {
    schema_version: u32,
    contract: String,
    action: String,
    authorization_contract_version: u32,
    authorization_contract: String,
    environment: String,
    authorization_id_sha256: String,
    admission_fence_id_sha256: String,
    fence_generation: i64,
    expected_fence_state_digest_sha256: String,
    expected_head_version: i64,
    expected_head_digest_sha256: String,
    scope_kind: String,
    scope_id_sha256: String,
    source_scan_id_sha256: String,
    collector_service_name: String,
    collector_version_id: String,
    collector_run_id_sha256: String,
    started_by_credential_id_sha256: String,
    page_size: u16,
    shard_count: u16,
    accepted_source_schema_sha256: String,
    authorizer_issuer: String,
    authorizer_key_id: String,
    authorizer_identity_sha256: String,
    authorizer_spki_sha256: String,
    authorization_subject_sha256: String,
    authorization_signature_envelope_sha256: String,
    execution_nonce_sha256: String,
    permit_issued_at: i64,
    permit_expires_at: i64,
    authorized_by_admin_id: i64,
    action_digest_sha256: String,
    registration_request_sha256: String,
    admin_audit_digest_sha256: String,
    admin_network_identity_hmac_sha256: String,
    change_ticket_sha256: String,
    reason_code: String,
    verification_expires_at: i64,
    authority_ledger_identity_sha256: String,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    root_admin_id: i64,
    root_session_epoch: i64,
    root_session_issued_at: i64,
    root_session_expires_at: i64,
    root_session_binding_sha256: String,
    passkey_credential_row_id: i64,
    passkey_credential_id_sha256: String,
    passkey_credential_registration_id_sha256: String,
    passkey_credential_binding_sha256: String,
    passkey_previous_use_generation: i64,
    registered_by_service_name: String,
    registered_by_version_id: String,
    registration_execution_id_sha256: String,
    registration_credential_id_sha256: String,
    ceremony_nonce_sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DrainSourceRegistrationActionInput {
    pub(crate) action_digest_sha256: String,
    pub(crate) registration_request_sha256: String,
    pub(crate) admin_audit_digest_sha256: String,
    pub(crate) admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256,
    pub(crate) change_ticket_sha256: String,
    pub(crate) reason_code: String,
    pub(crate) verification_expires_at: i64,
    pub(crate) receipt_sequence: i64,
    pub(crate) ledger_head_before_sha256: String,
    pub(crate) root_session_epoch: i64,
    pub(crate) root_session_issued_at: i64,
    pub(crate) root_session_expires_at: i64,
    pub(crate) root_session_binding_sha256: String,
    pub(crate) passkey_credential_row_id: i64,
    pub(crate) passkey_credential_id_sha256: String,
    pub(crate) passkey_credential_registration_id_sha256: String,
    pub(crate) passkey_credential_binding_sha256: String,
    pub(crate) passkey_previous_use_generation: i64,
    pub(crate) registered_by_service_name: String,
    pub(crate) registered_by_version_id: String,
    pub(crate) registration_execution_id_sha256: String,
    pub(crate) registration_credential_id_sha256: String,
    pub(crate) ceremony_nonce_sha256: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RequiredUserVerification {
    Required,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationCeremonyState {
    action: DrainSourceRegistrationActionV1,
    challenge: String,
    rp_id: String,
    origin: String,
    issued_at: i64,
    user_verification: RequiredUserVerification,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DrainSourceRegistrationStoredCredential<'a> {
    pub(crate) row_id: i64,
    pub(crate) user_id: i64,
    pub(crate) clone_warning: bool,
    pub(crate) passkey_credential_registration_id_sha256: &'a str,
    pub(crate) passkey_credential_binding_sha256: &'a str,
    pub(crate) passkey_previous_use_generation: i64,
    pub(crate) credential: StoredCredential<'a>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedDrainSourceRegistrationPasskeyProof {
    passkey_credential_row_id: i64,
    passkey_credential_id_sha256: String,
    passkey_credential_registration_id_sha256: String,
    passkey_credential_binding_sha256: String,
    passkey_previous_use_generation: i64,
    passkey_assertion_subject_sha256: String,
    passkey_assertion_signature_sha256: String,
    secure_verification_challenge_sha256: String,
    previous_sign_count: u32,
    sign_count: u32,
    user_present: bool,
    user_verified: bool,
    backup_eligible: bool,
    backup_state: bool,
    verified_at: i64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DrainSourceRegistrationActionWriterProjection<'a> {
    action: &'a DrainSourceRegistrationActionV1,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DrainSourceRegistrationPasskeyProofWriterProjection<'a> {
    proof: &'a VerifiedDrainSourceRegistrationPasskeyProof,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DrainSourceRegistrationPermitBindings {
    environment: String,
    authorization_id_sha256: String,
    authorization_subject_sha256: String,
    authorization_signature_envelope_sha256: String,
    action_subject_sha256: String,
    action_digest_sha256: String,
    registration_request_sha256: String,
    admin_audit_digest_sha256: String,
    admin_network_identity_hmac_sha256: String,
    change_ticket_sha256: String,
    root_admin_id: i64,
    root_session_epoch: i64,
    root_session_issued_at: i64,
    root_session_expires_at: i64,
    root_session_binding_sha256: String,
    passkey_credential_row_id: i64,
    passkey_credential_id_sha256: String,
    passkey_credential_registration_id_sha256: String,
    passkey_credential_binding_sha256: String,
    passkey_previous_use_generation: i64,
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
    verified_at: i64,
}

macro_rules! action_writer_string_accessors {
    ($($field:ident),+ $(,)?) => {
        $(
            pub(crate) fn $field(&self) -> &str {
                &self.action.$field
            }
        )+
    };
}

macro_rules! action_writer_copy_accessors {
    ($($field:ident: $ty:ty),+ $(,)?) => {
        $(
            pub(crate) fn $field(&self) -> $ty {
                self.action.$field
            }
        )+
    };
}

impl DrainSourceRegistrationActionWriterProjection<'_> {
    action_writer_string_accessors!(
        contract,
        action,
        authorization_contract,
        environment,
        authorization_id_sha256,
        admission_fence_id_sha256,
        expected_fence_state_digest_sha256,
        expected_head_digest_sha256,
        scope_kind,
        scope_id_sha256,
        source_scan_id_sha256,
        collector_service_name,
        collector_version_id,
        collector_run_id_sha256,
        started_by_credential_id_sha256,
        accepted_source_schema_sha256,
        authorizer_issuer,
        authorizer_key_id,
        authorizer_identity_sha256,
        authorizer_spki_sha256,
        authorization_subject_sha256,
        authorization_signature_envelope_sha256,
        execution_nonce_sha256,
        action_digest_sha256,
        registration_request_sha256,
        admin_audit_digest_sha256,
        admin_network_identity_hmac_sha256,
        change_ticket_sha256,
        reason_code,
        authority_ledger_identity_sha256,
        ledger_head_before_sha256,
        root_session_binding_sha256,
        passkey_credential_id_sha256,
        passkey_credential_registration_id_sha256,
        passkey_credential_binding_sha256,
        registered_by_service_name,
        registered_by_version_id,
        registration_execution_id_sha256,
        registration_credential_id_sha256,
        ceremony_nonce_sha256,
    );

    action_writer_copy_accessors!(
        schema_version: u32,
        authorization_contract_version: u32,
        fence_generation: i64,
        expected_head_version: i64,
        page_size: u16,
        shard_count: u16,
        permit_issued_at: i64,
        permit_expires_at: i64,
        authorized_by_admin_id: i64,
        verification_expires_at: i64,
        receipt_sequence: i64,
        root_admin_id: i64,
        root_session_epoch: i64,
        root_session_issued_at: i64,
        root_session_expires_at: i64,
        passkey_credential_row_id: i64,
        passkey_previous_use_generation: i64,
    );

    pub(crate) fn action_subject_sha256(
        &self,
    ) -> Result<String, DrainSourceRegistrationCeremonyError> {
        Ok(sha256_hex(self.action.canonical_subject()?))
    }
}

impl DrainSourceRegistrationPasskeyProofWriterProjection<'_> {
    pub(crate) fn passkey_credential_row_id(&self) -> i64 {
        self.proof.passkey_credential_row_id
    }

    pub(crate) fn passkey_credential_id_sha256(&self) -> &str {
        &self.proof.passkey_credential_id_sha256
    }

    pub(crate) fn passkey_credential_registration_id_sha256(&self) -> &str {
        &self.proof.passkey_credential_registration_id_sha256
    }

    pub(crate) fn passkey_credential_binding_sha256(&self) -> &str {
        &self.proof.passkey_credential_binding_sha256
    }

    pub(crate) fn passkey_previous_use_generation(&self) -> i64 {
        self.proof.passkey_previous_use_generation
    }

    pub(crate) fn passkey_assertion_subject_sha256(&self) -> &str {
        &self.proof.passkey_assertion_subject_sha256
    }

    pub(crate) fn passkey_assertion_signature_sha256(&self) -> &str {
        &self.proof.passkey_assertion_signature_sha256
    }

    pub(crate) fn secure_verification_challenge_sha256(&self) -> &str {
        &self.proof.secure_verification_challenge_sha256
    }

    pub(crate) fn previous_sign_count(&self) -> u32 {
        self.proof.previous_sign_count
    }

    pub(crate) fn sign_count(&self) -> u32 {
        self.proof.sign_count
    }

    pub(crate) fn user_present(&self) -> bool {
        self.proof.user_present
    }

    pub(crate) fn user_verified(&self) -> bool {
        self.proof.user_verified
    }

    pub(crate) fn backup_eligible(&self) -> bool {
        self.proof.backup_eligible
    }

    pub(crate) fn backup_state(&self) -> bool {
        self.proof.backup_state
    }

    pub(crate) fn verified_at(&self) -> i64 {
        self.proof.verified_at
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DrainSourceRegistrationPermitIssueRequestV1 {
    canonical_json: Vec<u8>,
}

impl DrainSourceRegistrationPermitIssueRequestV1 {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.canonical_json
    }
}

impl DrainSourceRegistrationPermitBindings {
    pub(crate) fn issue_request(
        &self,
    ) -> Result<DrainSourceRegistrationPermitIssueRequestV1, DrainSourceRegistrationCeremonyError>
    {
        let request = BTreeMap::from([
            (
                "action",
                serde_json::Value::String(DRAIN_SOURCE_REGISTRATION_ACTION.to_owned()),
            ),
            (
                "actionDigestSha256",
                serde_json::Value::String(self.action_digest_sha256.clone()),
            ),
            (
                "actionSubjectSha256",
                serde_json::Value::String(self.action_subject_sha256.clone()),
            ),
            (
                "adminAuditDigestSha256",
                serde_json::Value::String(self.admin_audit_digest_sha256.clone()),
            ),
            (
                "adminNetworkIdentityHmacSha256",
                serde_json::Value::String(self.admin_network_identity_hmac_sha256.clone()),
            ),
            (
                "authorityLedgerIdentitySha256",
                serde_json::Value::String(self.authority_ledger_identity_sha256.clone()),
            ),
            (
                "authorizationIdSha256",
                serde_json::Value::String(self.authorization_id_sha256.clone()),
            ),
            (
                "authorizationSignatureEnvelopeSha256",
                serde_json::Value::String(self.authorization_signature_envelope_sha256.clone()),
            ),
            (
                "authorizationSubjectSha256",
                serde_json::Value::String(self.authorization_subject_sha256.clone()),
            ),
            (
                "changeTicketSha256",
                serde_json::Value::String(self.change_ticket_sha256.clone()),
            ),
            (
                "environment",
                serde_json::Value::String(self.environment.clone()),
            ),
            (
                "ledgerHeadBeforeSha256",
                serde_json::Value::String(self.ledger_head_before_sha256.clone()),
            ),
            (
                "passkeyAssertionSignatureSha256",
                serde_json::Value::String(self.passkey_assertion_signature_sha256.clone()),
            ),
            (
                "passkeyAssertionSubjectSha256",
                serde_json::Value::String(self.passkey_assertion_subject_sha256.clone()),
            ),
            (
                "passkeyBackupEligible",
                serde_json::Value::Bool(self.passkey_backup_eligible),
            ),
            (
                "passkeyBackupState",
                serde_json::Value::Bool(self.passkey_backup_state),
            ),
            (
                "passkeyCredentialBindingSha256",
                serde_json::Value::String(self.passkey_credential_binding_sha256.clone()),
            ),
            (
                "passkeyCredentialIdSha256",
                serde_json::Value::String(self.passkey_credential_id_sha256.clone()),
            ),
            (
                "passkeyCredentialRegistrationIdSha256",
                serde_json::Value::String(self.passkey_credential_registration_id_sha256.clone()),
            ),
            (
                "passkeyCredentialRowId",
                serde_json::Value::from(self.passkey_credential_row_id),
            ),
            (
                "passkeyPreviousSignCount",
                serde_json::Value::from(self.passkey_previous_sign_count),
            ),
            (
                "passkeyPreviousUseGeneration",
                serde_json::Value::from(self.passkey_previous_use_generation),
            ),
            (
                "passkeySignCount",
                serde_json::Value::from(self.passkey_sign_count),
            ),
            (
                "passkeyUserPresent",
                serde_json::Value::Bool(self.passkey_user_present),
            ),
            (
                "passkeyUserVerified",
                serde_json::Value::Bool(self.passkey_user_verified),
            ),
            (
                "receiptSequence",
                serde_json::Value::from(self.receipt_sequence),
            ),
            (
                "registeredByServiceName",
                serde_json::Value::String(self.registered_by_service_name.clone()),
            ),
            (
                "registeredByVersionId",
                serde_json::Value::String(self.registered_by_version_id.clone()),
            ),
            (
                "registrationCredentialIdSha256",
                serde_json::Value::String(self.registration_credential_id_sha256.clone()),
            ),
            (
                "registrationExecutionIdSha256",
                serde_json::Value::String(self.registration_execution_id_sha256.clone()),
            ),
            (
                "registrationRequestSha256",
                serde_json::Value::String(self.registration_request_sha256.clone()),
            ),
            ("rootAdminId", serde_json::Value::from(self.root_admin_id)),
            (
                "rootSessionBindingSha256",
                serde_json::Value::String(self.root_session_binding_sha256.clone()),
            ),
            (
                "rootSessionEpoch",
                serde_json::Value::from(self.root_session_epoch),
            ),
            (
                "rootSessionExpiresAt",
                serde_json::Value::from(self.root_session_expires_at),
            ),
            (
                "rootSessionIssuedAt",
                serde_json::Value::from(self.root_session_issued_at),
            ),
            (
                "secureVerificationChallengeSha256",
                serde_json::Value::String(self.secure_verification_challenge_sha256.clone()),
            ),
            (
                "verificationExpiresAt",
                serde_json::Value::from(self.verification_expires_at),
            ),
            ("verifiedAt", serde_json::Value::from(self.verified_at)),
        ]);
        if request.len() != PERMIT_ISSUE_REQUEST_FIELD_COUNT {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        let canonical_json = serde_json::to_vec(&request)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        Ok(DrainSourceRegistrationPermitIssueRequestV1 { canonical_json })
    }

    #[cfg(test)]
    pub(crate) fn test_fixture(now: i64) -> Self {
        let digest = |byte: u8| format!("{byte:02x}").repeat(32);
        Self {
            environment: "staging".to_owned(),
            authorization_id_sha256: digest(1),
            authorization_subject_sha256: digest(2),
            authorization_signature_envelope_sha256: digest(3),
            action_subject_sha256: digest(4),
            action_digest_sha256: digest(5),
            registration_request_sha256: digest(6),
            admin_audit_digest_sha256: digest(8),
            admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256::derive(
                &[0x42; 32],
                "203.0.113.42",
            )
            .expect("test network identity")
            .into_inner(),
            change_ticket_sha256: digest(9),
            root_admin_id: 1,
            root_session_epoch: 7,
            root_session_issued_at: now - 60,
            root_session_expires_at: now + 300,
            root_session_binding_sha256: digest(10),
            passkey_credential_row_id: 11,
            passkey_credential_id_sha256: digest(11),
            passkey_credential_registration_id_sha256: digest(21),
            passkey_credential_binding_sha256: digest(22),
            passkey_previous_use_generation: 17,
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
            verification_expires_at: now + 24,
            verified_at: now,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_admin_network_identity_hmac_sha256(&self) -> &str {
        &self.admin_network_identity_hmac_sha256
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DrainSourceRegistrationCeremonyError {
    InvalidAction,
    InvalidCeremony,
    StoredCredentialMismatch,
    CloneDetected,
    UserVerificationRequired,
    UserHandleMismatch,
    Webauthn(WebauthnError),
    Storage(PasskeyCeremonyError),
}

impl std::fmt::Display for DrainSourceRegistrationCeremonyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAction => "drain_source_registration_action_invalid",
            Self::InvalidCeremony => "drain_source_registration_ceremony_invalid",
            Self::StoredCredentialMismatch => {
                "drain_source_registration_stored_credential_mismatch"
            }
            Self::CloneDetected => "drain_source_registration_passkey_clone_detected",
            Self::UserVerificationRequired => {
                "drain_source_registration_user_verification_required"
            }
            Self::UserHandleMismatch => "drain_source_registration_user_handle_mismatch",
            Self::Webauthn(_) => "drain_source_registration_webauthn_invalid",
            Self::Storage(_) => "drain_source_registration_ceremony_storage_unavailable",
        })
    }
}

impl std::error::Error for DrainSourceRegistrationCeremonyError {}

impl From<WebauthnError> for DrainSourceRegistrationCeremonyError {
    fn from(error: WebauthnError) -> Self {
        Self::Webauthn(error)
    }
}

impl From<PasskeyCeremonyError> for DrainSourceRegistrationCeremonyError {
    fn from(error: PasskeyCeremonyError) -> Self {
        Self::Storage(error)
    }
}

impl VerifiedDrainSourceRegistrationPasskeyProof {
    pub(crate) fn writer_projection(
        &self,
    ) -> DrainSourceRegistrationPasskeyProofWriterProjection<'_> {
        DrainSourceRegistrationPasskeyProofWriterProjection { proof: self }
    }
}

impl DrainSourceRegistrationCeremonyState {
    pub(crate) fn new(
        action: DrainSourceRegistrationActionV1,
        rp_id: impl Into<String>,
        origin: impl Into<String>,
        issued_at: i64,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let mut state = Self {
            action,
            challenge: String::new(),
            rp_id: rp_id.into(),
            origin: origin.into(),
            issued_at,
            user_verification: RequiredUserVerification::Required,
        };
        state.challenge = state.expected_challenge()?;
        state.validate()?;
        Ok(state)
    }

    pub(crate) fn action(&self) -> &DrainSourceRegistrationActionV1 {
        &self.action
    }

    pub(crate) fn challenge(&self) -> &str {
        &self.challenge
    }

    pub(crate) fn ceremony_key(&self) -> Result<String, DrainSourceRegistrationCeremonyError> {
        Ok(format!(
            "{CEREMONY_KEY_PREFIX}:{}:{}",
            self.action.authorization_id_sha256,
            self.secure_verification_challenge_sha256()?
        ))
    }

    pub(crate) fn action_subject_sha256(
        &self,
    ) -> Result<String, DrainSourceRegistrationCeremonyError> {
        Ok(sha256_hex(self.action.canonical_subject()?))
    }

    pub(crate) fn secure_verification_challenge_sha256(
        &self,
    ) -> Result<String, DrainSourceRegistrationCeremonyError> {
        let decoded = URL_SAFE_NO_PAD
            .decode(&self.challenge)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != self.challenge {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(sha256_hex(decoded))
    }

    pub(crate) fn expectation(&self) -> CeremonyExpectation<'_> {
        CeremonyExpectation {
            challenge: &self.challenge,
            origin: &self.origin,
            rp_id: &self.rp_id,
            require_user_verification: true,
        }
    }

    pub(crate) fn registration_permit_bindings(
        &self,
        proof: &VerifiedDrainSourceRegistrationPasskeyProof,
    ) -> Result<DrainSourceRegistrationPermitBindings, DrainSourceRegistrationCeremonyError> {
        self.validate_at(proof.verified_at)?;
        let action_subject_sha256 = self.action_subject_sha256()?;
        let challenge_sha256 = self.secure_verification_challenge_sha256()?;
        if proof.passkey_credential_row_id != self.action.passkey_credential_row_id
            || proof.passkey_credential_id_sha256 != self.action.passkey_credential_id_sha256
            || proof.passkey_credential_registration_id_sha256
                != self.action.passkey_credential_registration_id_sha256
            || proof.passkey_credential_binding_sha256
                != self.action.passkey_credential_binding_sha256
            || proof.passkey_previous_use_generation != self.action.passkey_previous_use_generation
            || proof.secure_verification_challenge_sha256 != challenge_sha256
            || !proof.user_present
            || !proof.user_verified
            || proof.backup_state && !proof.backup_eligible
            || !valid_sign_count_transition(proof.previous_sign_count, proof.sign_count)
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        for digest in [
            &proof.passkey_assertion_subject_sha256,
            &proof.passkey_assertion_signature_sha256,
        ] {
            if !valid_sha256(digest) {
                return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
            }
        }

        Ok(DrainSourceRegistrationPermitBindings {
            environment: self.action.environment.clone(),
            authorization_id_sha256: self.action.authorization_id_sha256.clone(),
            authorization_subject_sha256: self.action.authorization_subject_sha256.clone(),
            authorization_signature_envelope_sha256: self
                .action
                .authorization_signature_envelope_sha256
                .clone(),
            action_subject_sha256,
            action_digest_sha256: self.action.action_digest_sha256.clone(),
            registration_request_sha256: self.action.registration_request_sha256.clone(),
            admin_audit_digest_sha256: self.action.admin_audit_digest_sha256.clone(),
            admin_network_identity_hmac_sha256: self
                .action
                .admin_network_identity_hmac_sha256
                .clone(),
            change_ticket_sha256: self.action.change_ticket_sha256.clone(),
            root_admin_id: self.action.root_admin_id,
            root_session_epoch: self.action.root_session_epoch,
            root_session_issued_at: self.action.root_session_issued_at,
            root_session_expires_at: self.action.root_session_expires_at,
            root_session_binding_sha256: self.action.root_session_binding_sha256.clone(),
            passkey_credential_row_id: proof.passkey_credential_row_id,
            passkey_credential_id_sha256: proof.passkey_credential_id_sha256.clone(),
            passkey_credential_registration_id_sha256: proof
                .passkey_credential_registration_id_sha256
                .clone(),
            passkey_credential_binding_sha256: proof.passkey_credential_binding_sha256.clone(),
            passkey_previous_use_generation: proof.passkey_previous_use_generation,
            passkey_assertion_subject_sha256: proof.passkey_assertion_subject_sha256.clone(),
            passkey_assertion_signature_sha256: proof.passkey_assertion_signature_sha256.clone(),
            secure_verification_challenge_sha256: proof
                .secure_verification_challenge_sha256
                .clone(),
            passkey_previous_sign_count: proof.previous_sign_count,
            passkey_sign_count: proof.sign_count,
            passkey_user_present: proof.user_present,
            passkey_user_verified: proof.user_verified,
            passkey_backup_eligible: proof.backup_eligible,
            passkey_backup_state: proof.backup_state,
            registered_by_service_name: self.action.registered_by_service_name.clone(),
            registered_by_version_id: self.action.registered_by_version_id.clone(),
            registration_execution_id_sha256: self.action.registration_execution_id_sha256.clone(),
            registration_credential_id_sha256: self
                .action
                .registration_credential_id_sha256
                .clone(),
            authority_ledger_identity_sha256: self.action.authority_ledger_identity_sha256.clone(),
            receipt_sequence: self.action.receipt_sequence,
            ledger_head_before_sha256: self.action.ledger_head_before_sha256.clone(),
            verification_expires_at: self.action.verification_expires_at,
            verified_at: proof.verified_at,
        })
    }

    pub(crate) async fn store_once(
        &self,
        env: &Env,
    ) -> Result<(), DrainSourceRegistrationCeremonyError> {
        let now = unix_timestamp();
        self.validate_at(now)?;
        let payload = serde_json::to_string(self)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let ttl_seconds = u64::try_from(self.action.verification_expires_at - now)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        passkey_ceremony::put_once_json(env, &self.ceremony_key()?, &payload, ttl_seconds).await?;
        Ok(())
    }

    pub(crate) async fn consume(
        env: &Env,
        ceremony_key: &str,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let payload = passkey_ceremony::take_json(env, ceremony_key).await?;
        let state: Self = serde_json::from_str(&payload)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        state.validate_at(unix_timestamp())?;
        if state.ceremony_key()? != ceremony_key {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(state)
    }

    pub(crate) fn verify_assertion(
        &self,
        assertion: &AssertionCredential,
        stored: &DrainSourceRegistrationStoredCredential<'_>,
        now: i64,
    ) -> Result<VerifiedDrainSourceRegistrationPasskeyProof, DrainSourceRegistrationCeremonyError>
    {
        self.validate_at(now)?;
        self.validate_stored_credential(stored)?;
        let verified =
            webauthn::verify_assertion(assertion, &self.expectation(), &stored.credential)?;
        self.proof_from_verified(stored, &verified, now)
    }

    fn validate(&self) -> Result<(), DrainSourceRegistrationCeremonyError> {
        self.action.validate(self.issued_at)?;
        validate_relying_party(&self.rp_id, &self.origin)?;
        if self.user_verification != RequiredUserVerification::Required
            || self.challenge != self.expected_challenge()?
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(())
    }

    fn validate_at(&self, now: i64) -> Result<(), DrainSourceRegistrationCeremonyError> {
        self.validate()?;
        if now < self.issued_at || now >= self.action.verification_expires_at {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(())
    }

    fn expected_challenge(&self) -> Result<String, DrainSourceRegistrationCeremonyError> {
        let action_subject = self.action.canonical_subject()?;
        let issued_at = self.issued_at.to_string();
        let fields = [
            action_subject.as_slice(),
            self.rp_id.as_bytes(),
            self.origin.as_bytes(),
            issued_at.as_bytes(),
            b"required".as_slice(),
        ];
        let message = canonical_message(CHALLENGE_DOMAIN, &fields)?;
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(message)))
    }

    fn validate_stored_credential(
        &self,
        stored: &DrainSourceRegistrationStoredCredential<'_>,
    ) -> Result<(), DrainSourceRegistrationCeremonyError> {
        if stored.row_id != self.action.passkey_credential_row_id
            || stored.user_id != self.action.root_admin_id
            || passkey_credential_id_sha256(stored.credential.credential_id)
                != self.action.passkey_credential_id_sha256
            || stored.passkey_credential_registration_id_sha256
                != self.action.passkey_credential_registration_id_sha256
            || stored.passkey_credential_binding_sha256
                != self.action.passkey_credential_binding_sha256
            || stored.passkey_previous_use_generation != self.action.passkey_previous_use_generation
        {
            return Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch);
        }
        if stored.clone_warning {
            return Err(DrainSourceRegistrationCeremonyError::CloneDetected);
        }
        Ok(())
    }

    fn proof_from_verified(
        &self,
        stored: &DrainSourceRegistrationStoredCredential<'_>,
        verified: &VerifiedAssertion,
        now: i64,
    ) -> Result<VerifiedDrainSourceRegistrationPasskeyProof, DrainSourceRegistrationCeremonyError>
    {
        self.validate_at(now)?;
        self.validate_stored_credential(stored)?;
        if verified.credential_id != stored.credential.credential_id
            || verified.challenge_sha256
                != decode_sha256_hex(&self.secure_verification_challenge_sha256()?)
                    .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?
        {
            return Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch);
        }
        if verified
            .user_handle
            .as_deref()
            .is_some_and(|handle| handle != self.action.root_admin_id.to_string().as_bytes())
        {
            return Err(DrainSourceRegistrationCeremonyError::UserHandleMismatch);
        }
        if verified.clone_warning {
            return Err(DrainSourceRegistrationCeremonyError::CloneDetected);
        }
        if !verified.user_present || !verified.user_verified {
            return Err(DrainSourceRegistrationCeremonyError::UserVerificationRequired);
        }
        Ok(VerifiedDrainSourceRegistrationPasskeyProof {
            passkey_credential_row_id: stored.row_id,
            passkey_credential_id_sha256: self.action.passkey_credential_id_sha256.clone(),
            passkey_credential_registration_id_sha256: stored
                .passkey_credential_registration_id_sha256
                .to_owned(),
            passkey_credential_binding_sha256: stored.passkey_credential_binding_sha256.to_owned(),
            passkey_previous_use_generation: stored.passkey_previous_use_generation,
            passkey_assertion_subject_sha256: encode_hex(&verified.signed_subject_sha256),
            passkey_assertion_signature_sha256: encode_hex(&verified.signature_sha256),
            secure_verification_challenge_sha256: encode_hex(&verified.challenge_sha256),
            previous_sign_count: stored.credential.sign_count,
            sign_count: verified.sign_count,
            user_present: verified.user_present,
            user_verified: verified.user_verified,
            backup_eligible: verified.backup_eligible,
            backup_state: verified.backup_state,
            verified_at: now,
        })
    }
}

impl DrainSourceRegistrationActionV1 {
    pub(crate) fn writer_projection(&self) -> DrainSourceRegistrationActionWriterProjection<'_> {
        DrainSourceRegistrationActionWriterProjection { action: self }
    }

    pub(crate) fn from_verified_authorization(
        authorization: &VerifiedDrainSourceAuthorization,
        input: DrainSourceRegistrationActionInput,
    ) -> Self {
        Self {
            schema_version: 1,
            contract: DRAIN_SOURCE_REGISTRATION_ACTION_CONTRACT.to_owned(),
            action: DRAIN_SOURCE_REGISTRATION_ACTION.to_owned(),
            authorization_contract_version: authorization.contract_version,
            authorization_contract: authorization.authorization_contract.clone(),
            environment: authorization.environment.clone(),
            authorization_id_sha256: authorization.authorization_id_sha256.clone(),
            admission_fence_id_sha256: authorization.admission_fence_id_sha256.clone(),
            fence_generation: authorization.fence_generation,
            expected_fence_state_digest_sha256: authorization
                .expected_fence_state_digest_sha256
                .clone(),
            expected_head_version: authorization.expected_head_version,
            expected_head_digest_sha256: authorization.expected_head_digest_sha256.clone(),
            scope_kind: authorization.scope_kind.clone(),
            scope_id_sha256: authorization.scope_id_sha256.clone(),
            source_scan_id_sha256: authorization.source_scan_id_sha256.clone(),
            collector_service_name: authorization.collector_service_name.clone(),
            collector_version_id: authorization.collector_version_id.clone(),
            collector_run_id_sha256: authorization.collector_run_id_sha256.clone(),
            started_by_credential_id_sha256: authorization.started_by_credential_id_sha256.clone(),
            page_size: authorization.page_size,
            shard_count: authorization.shard_count,
            accepted_source_schema_sha256: authorization.accepted_source_schema_sha256.clone(),
            authorizer_issuer: authorization.authorizer_issuer.clone(),
            authorizer_key_id: authorization.authorizer_key_id.clone(),
            authorizer_identity_sha256: authorization.authorizer_identity_sha256.clone(),
            authorizer_spki_sha256: authorization.authorizer_spki_sha256.clone(),
            authorization_subject_sha256: authorization.authorization_subject_sha256.clone(),
            authorization_signature_envelope_sha256: authorization
                .authorization_signature_envelope_sha256
                .clone(),
            execution_nonce_sha256: authorization.execution_nonce_sha256.clone(),
            permit_issued_at: authorization.permit_issued_at,
            permit_expires_at: authorization.permit_expires_at,
            authorized_by_admin_id: authorization.authorized_by_admin_id,
            action_digest_sha256: input.action_digest_sha256,
            registration_request_sha256: input.registration_request_sha256,
            admin_audit_digest_sha256: input.admin_audit_digest_sha256,
            admin_network_identity_hmac_sha256: input
                .admin_network_identity_hmac_sha256
                .into_inner(),
            change_ticket_sha256: input.change_ticket_sha256,
            reason_code: input.reason_code,
            verification_expires_at: input.verification_expires_at,
            authority_ledger_identity_sha256: authorization.scope_id_sha256.clone(),
            receipt_sequence: input.receipt_sequence,
            ledger_head_before_sha256: input.ledger_head_before_sha256,
            root_admin_id: authorization.authorized_by_admin_id,
            root_session_epoch: input.root_session_epoch,
            root_session_issued_at: input.root_session_issued_at,
            root_session_expires_at: input.root_session_expires_at,
            root_session_binding_sha256: input.root_session_binding_sha256,
            passkey_credential_row_id: input.passkey_credential_row_id,
            passkey_credential_id_sha256: input.passkey_credential_id_sha256,
            passkey_credential_registration_id_sha256: input
                .passkey_credential_registration_id_sha256,
            passkey_credential_binding_sha256: input.passkey_credential_binding_sha256,
            passkey_previous_use_generation: input.passkey_previous_use_generation,
            registered_by_service_name: input.registered_by_service_name,
            registered_by_version_id: input.registered_by_version_id,
            registration_execution_id_sha256: input.registration_execution_id_sha256,
            registration_credential_id_sha256: input.registration_credential_id_sha256,
            ceremony_nonce_sha256: input.ceremony_nonce_sha256,
        }
    }

    fn validate(&self, issued_at: i64) -> Result<(), DrainSourceRegistrationCeremonyError> {
        let lifetime = self.verification_expires_at.checked_sub(issued_at);
        if self.schema_version != 1
            || self.contract != DRAIN_SOURCE_REGISTRATION_ACTION_CONTRACT
            || self.action != DRAIN_SOURCE_REGISTRATION_ACTION
            || self.authorization_contract_version != 1
            || self.authorization_contract != DRAIN_SOURCE_AUTHORIZATION_CONTRACT
            || !matches!(self.environment.as_str(), "staging" | "production")
            || self.fence_generation != 1
            || self.expected_head_version != 1
            || self.scope_kind != "global"
            || self.scope_id_sha256 != RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256
            || self.authority_ledger_identity_sha256 != self.scope_id_sha256
            || !(1..=512).contains(&self.page_size)
            || !(1..=1_024).contains(&self.shard_count)
            || self.accepted_source_schema_sha256 != RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
            || !valid_service_name(&self.collector_service_name)
            || !valid_version_id(&self.collector_version_id)
            || !valid_issuer(&self.authorizer_issuer)
            || !valid_key_id(&self.authorizer_key_id)
            || self.root_admin_id <= 0
            || self.root_admin_id > MAXIMUM_SAFE_INTEGER
            || self.authorized_by_admin_id != self.root_admin_id
            || self.root_session_epoch < 0
            || self.root_session_epoch > MAXIMUM_SAFE_INTEGER
            || self.root_session_issued_at <= 0
            || self.root_session_issued_at > MAXIMUM_SAFE_INTEGER
            || self.root_session_issued_at < self.root_session_epoch
            || self.root_session_expires_at <= self.root_session_issued_at
            || self.root_session_expires_at > MAXIMUM_SAFE_INTEGER
            || self.passkey_credential_row_id <= 0
            || self.passkey_credential_row_id > MAXIMUM_SAFE_INTEGER
            || self.passkey_previous_use_generation < 0
            || self.passkey_previous_use_generation > MAXIMUM_PREVIOUS_USE_GENERATION
            || !(1..=1_000_000).contains(&self.receipt_sequence)
            || issued_at <= 0
            || issued_at > MAXIMUM_SAFE_INTEGER
            || issued_at < self.root_session_issued_at
            || issued_at >= self.root_session_expires_at
            || self.permit_issued_at <= 0
            || self.permit_issued_at > issued_at
            || self.permit_expires_at <= issued_at
            || self.permit_expires_at > MAXIMUM_SAFE_INTEGER
            || !matches!(
                self.permit_expires_at.checked_sub(self.permit_issued_at),
                Some(60..=900)
            )
            || self.verification_expires_at > MAXIMUM_SAFE_INTEGER
            || self.verification_expires_at > self.permit_expires_at
            || self.verification_expires_at > self.root_session_expires_at
            || !matches!(
                lifetime,
                Some(MINIMUM_VERIFICATION_LIFETIME_SECONDS..=MAXIMUM_VERIFICATION_LIFETIME_SECONDS)
            )
            || !valid_service_name(&self.registered_by_service_name)
            || !valid_version_id(&self.registered_by_version_id)
            || !valid_reason_code(&self.reason_code)
            || self.authorization_id_sha256 == self.source_scan_id_sha256
            || self.authorization_id_sha256 == self.collector_run_id_sha256
            || self.authorization_id_sha256 == self.execution_nonce_sha256
            || self.source_scan_id_sha256 == self.collector_run_id_sha256
            || self.source_scan_id_sha256 == self.execution_nonce_sha256
            || self.collector_run_id_sha256 == self.execution_nonce_sha256
            || self.authorizer_identity_sha256 == self.authorizer_spki_sha256
            || self.authorization_subject_sha256 == self.authorization_signature_envelope_sha256
            || self.root_session_binding_sha256 == self.passkey_credential_id_sha256
            || self.passkey_credential_id_sha256 == self.passkey_credential_registration_id_sha256
            || self.passkey_credential_id_sha256 == self.passkey_credential_binding_sha256
            || self.passkey_credential_registration_id_sha256
                == self.passkey_credential_binding_sha256
            || self.registration_execution_id_sha256 == self.registration_credential_id_sha256
            || self.action_digest_sha256 == self.registration_request_sha256
            || self.action_digest_sha256 == self.admin_audit_digest_sha256
            || self.registration_request_sha256 == self.admin_audit_digest_sha256
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidAction);
        }
        for value in [
            &self.authorization_id_sha256,
            &self.admission_fence_id_sha256,
            &self.expected_fence_state_digest_sha256,
            &self.expected_head_digest_sha256,
            &self.action_digest_sha256,
            &self.registration_request_sha256,
            &self.admin_audit_digest_sha256,
            &self.admin_network_identity_hmac_sha256,
            &self.scope_id_sha256,
            &self.source_scan_id_sha256,
            &self.collector_run_id_sha256,
            &self.started_by_credential_id_sha256,
            &self.accepted_source_schema_sha256,
            &self.authorizer_identity_sha256,
            &self.authorizer_spki_sha256,
            &self.authorization_subject_sha256,
            &self.authorization_signature_envelope_sha256,
            &self.execution_nonce_sha256,
            &self.change_ticket_sha256,
            &self.authority_ledger_identity_sha256,
            &self.ledger_head_before_sha256,
            &self.root_session_binding_sha256,
            &self.passkey_credential_id_sha256,
            &self.passkey_credential_registration_id_sha256,
            &self.passkey_credential_binding_sha256,
            &self.registration_execution_id_sha256,
            &self.registration_credential_id_sha256,
            &self.ceremony_nonce_sha256,
        ] {
            if !valid_sha256(value) {
                return Err(DrainSourceRegistrationCeremonyError::InvalidAction);
            }
        }
        Ok(())
    }

    fn canonical_subject(&self) -> Result<Vec<u8>, DrainSourceRegistrationCeremonyError> {
        let fields = vec![
            self.schema_version.to_string(),
            self.contract.clone(),
            self.action.clone(),
            self.authorization_contract_version.to_string(),
            self.authorization_contract.clone(),
            self.environment.clone(),
            self.authorization_id_sha256.clone(),
            self.admission_fence_id_sha256.clone(),
            self.fence_generation.to_string(),
            self.expected_fence_state_digest_sha256.clone(),
            self.expected_head_version.to_string(),
            self.expected_head_digest_sha256.clone(),
            self.scope_kind.clone(),
            self.scope_id_sha256.clone(),
            self.source_scan_id_sha256.clone(),
            self.collector_service_name.clone(),
            self.collector_version_id.clone(),
            self.collector_run_id_sha256.clone(),
            self.started_by_credential_id_sha256.clone(),
            self.page_size.to_string(),
            self.shard_count.to_string(),
            self.accepted_source_schema_sha256.clone(),
            self.authorizer_issuer.clone(),
            self.authorizer_key_id.clone(),
            self.authorizer_identity_sha256.clone(),
            self.authorizer_spki_sha256.clone(),
            self.authorization_subject_sha256.clone(),
            self.authorization_signature_envelope_sha256.clone(),
            self.execution_nonce_sha256.clone(),
            self.permit_issued_at.to_string(),
            self.permit_expires_at.to_string(),
            self.authorized_by_admin_id.to_string(),
            self.action_digest_sha256.clone(),
            self.registration_request_sha256.clone(),
            self.admin_audit_digest_sha256.clone(),
            self.admin_network_identity_hmac_sha256.clone(),
            self.change_ticket_sha256.clone(),
            self.reason_code.clone(),
            self.verification_expires_at.to_string(),
            self.authority_ledger_identity_sha256.clone(),
            self.receipt_sequence.to_string(),
            self.ledger_head_before_sha256.clone(),
            self.root_admin_id.to_string(),
            self.root_session_epoch.to_string(),
            self.root_session_issued_at.to_string(),
            self.root_session_expires_at.to_string(),
            self.root_session_binding_sha256.clone(),
            self.passkey_credential_row_id.to_string(),
            self.passkey_credential_id_sha256.clone(),
            self.passkey_credential_registration_id_sha256.clone(),
            self.passkey_credential_binding_sha256.clone(),
            self.passkey_previous_use_generation.to_string(),
            self.registered_by_service_name.clone(),
            self.registered_by_version_id.clone(),
            self.registration_execution_id_sha256.clone(),
            self.registration_credential_id_sha256.clone(),
            self.ceremony_nonce_sha256.clone(),
        ];
        if fields.len() != ACTION_SUBJECT_FIELD_COUNT {
            return Err(DrainSourceRegistrationCeremonyError::InvalidAction);
        }
        let field_refs = fields
            .iter()
            .map(|field| field.as_bytes())
            .collect::<Vec<_>>();
        canonical_message(ACTION_SUBJECT_DOMAIN, &field_refs)
    }
}

fn validate_relying_party(
    rp_id: &str,
    origin: &str,
) -> Result<(), DrainSourceRegistrationCeremonyError> {
    if rp_id.is_empty()
        || rp_id.len() > webauthn::MAX_RP_ID_BYTES
        || rp_id != rp_id.to_ascii_lowercase()
        || rp_id.starts_with('.')
        || rp_id.ends_with('.')
        || rp_id.contains(':')
    {
        return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
    }
    let parsed = url::Url::parse(origin)
        .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
    let host = parsed
        .host_str()
        .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?
        .to_ascii_lowercase();
    let canonical_origin = parsed.origin().ascii_serialization();
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
        || canonical_origin != origin
        || host != rp_id && !host.ends_with(&format!(".{rp_id}"))
    {
        return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
    }
    Ok(())
}

fn canonical_message(
    domain: &[u8],
    fields: &[&[u8]],
) -> Result<Vec<u8>, DrainSourceRegistrationCeremonyError> {
    let payload_bytes = fields.iter().try_fold(0usize, |total, field| {
        u32::try_from(field.len())
            .ok()
            .and_then(|_| total.checked_add(4 + field.len()))
            .ok_or(DrainSourceRegistrationCeremonyError::InvalidAction)
    })?;
    let mut message = Vec::with_capacity(domain.len() + payload_bytes);
    message.extend_from_slice(domain);
    for field in fields {
        let length = u32::try_from(field.len())
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidAction)?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(field);
    }
    Ok(message)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

fn valid_issuer(value: &str) -> bool {
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

fn valid_version_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_sign_count_transition(previous: u32, current: u32) -> bool {
    previous == 0 && current == 0 || current > previous
}

fn valid_reason_code(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    encode_hex(&Sha256::digest(value.as_ref()))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if !valid_sha256(value) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        bytes[index] = (high << 4) | low;
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1_000.0).max(0.0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 2_100_000_000;

    fn digest(label: &str) -> String {
        sha256_hex(label)
    }

    fn authorization() -> VerifiedDrainSourceAuthorization {
        VerifiedDrainSourceAuthorization {
            contract_version: 1,
            authorization_contract: DRAIN_SOURCE_AUTHORIZATION_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            authorization_id_sha256: digest("authorization"),
            scope_kind: "global".to_owned(),
            scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_owned(),
            admission_fence_id_sha256: digest("admission-fence"),
            fence_generation: 1,
            expected_fence_state_digest_sha256: digest("fence-state"),
            expected_head_version: 1,
            expected_head_digest_sha256: digest("authorization-head"),
            source_scan_id_sha256: digest("source-scan"),
            collector_service_name: "drain-source-collector".to_owned(),
            collector_version_id: "collector-build-1".to_owned(),
            collector_run_id_sha256: digest("collector-run"),
            started_by_credential_id_sha256: digest("collector-credential"),
            page_size: 128,
            shard_count: 16,
            accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256.to_owned(),
            authorizer_issuer: "cinatoken-drain-source-authorizer".to_owned(),
            authorizer_key_id: "drain-source-authorizer-v1".to_owned(),
            authorizer_identity_sha256: digest("authorizer-identity"),
            authorizer_spki_sha256: digest("authorizer-spki"),
            authorization_subject_sha256: digest("authorization-subject"),
            authorization_signature_envelope_sha256: digest("authorization-envelope"),
            execution_nonce_sha256: digest("execution-nonce"),
            permit_issued_at: NOW - 10,
            permit_expires_at: NOW + 300,
            authorized_by_admin_id: 1,
        }
    }

    fn action() -> DrainSourceRegistrationActionV1 {
        DrainSourceRegistrationActionV1::from_verified_authorization(
            &authorization(),
            DrainSourceRegistrationActionInput {
                action_digest_sha256: digest("action"),
                registration_request_sha256: digest("request"),
                admin_audit_digest_sha256: digest("audit"),
                admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256::derive(
                    &[0x42; 32],
                    "203.0.113.42",
                )
                .unwrap(),
                change_ticket_sha256: digest("change-ticket"),
                reason_code: "migration.source-capture".to_owned(),
                verification_expires_at: NOW + 120,
                receipt_sequence: 1,
                ledger_head_before_sha256: digest("ledger-head"),
                root_session_epoch: 7,
                root_session_issued_at: NOW - 60,
                root_session_expires_at: NOW + 300,
                root_session_binding_sha256: digest("session-binding"),
                passkey_credential_row_id: 11,
                passkey_credential_id_sha256: passkey_credential_id_sha256(b"credential-id"),
                passkey_credential_registration_id_sha256: digest("credential-registration-id"),
                passkey_credential_binding_sha256: digest("credential-binding"),
                passkey_previous_use_generation: 17,
                registered_by_service_name: "cinatoken-application".to_owned(),
                registered_by_version_id: "build-2026-07-30".to_owned(),
                registration_execution_id_sha256: digest("execution"),
                registration_credential_id_sha256: digest("service-credential"),
                ceremony_nonce_sha256: digest("ceremony-nonce"),
            },
        )
    }

    fn state() -> DrainSourceRegistrationCeremonyState {
        DrainSourceRegistrationCeremonyState::new(
            action(),
            "cinatoken.com",
            "https://admin.cinatoken.com",
            NOW,
        )
        .unwrap()
    }

    #[test]
    fn challenge_commits_every_m1_plan_binding() {
        let state = state();
        let expected = state.challenge.clone();
        assert_eq!(ACTION_SUBJECT_FIELD_COUNT, 57);
        assert_eq!(PERMIT_ISSUE_REQUEST_FIELD_COUNT, 39);

        macro_rules! assert_string_drift {
            ($field:ident, $value:expr) => {{
                let mut changed = state.clone();
                changed.action.$field = $value.to_owned();
                changed.challenge = changed.expected_challenge().unwrap();
                assert_ne!(changed.challenge, expected, stringify!($field));
            }};
        }

        macro_rules! assert_value_drift {
            ($field:ident, $value:expr) => {{
                let mut changed = state.clone();
                changed.action.$field = $value;
                changed.challenge = changed.expected_challenge().unwrap();
                assert_ne!(changed.challenge, expected, stringify!($field));
            }};
        }

        assert_value_drift!(schema_version, 2);
        assert_string_drift!(
            contract,
            "relay-container-drain-source-registration-action-v2"
        );
        assert_string_drift!(
            action,
            "relay_container.drain_source_authorization_register_other"
        );
        assert_value_drift!(authorization_contract_version, 2);
        assert_string_drift!(
            authorization_contract,
            "relay-container-drain-source-authorization-v2"
        );
        assert_string_drift!(authorization_id_sha256, digest("authorization-2"));
        assert_string_drift!(admission_fence_id_sha256, digest("admission-fence-2"));
        assert_value_drift!(fence_generation, 2);
        assert_string_drift!(expected_fence_state_digest_sha256, digest("fence-state-2"));
        assert_value_drift!(expected_head_version, 2);
        assert_string_drift!(expected_head_digest_sha256, digest("authorization-head-2"));
        assert_string_drift!(scope_kind, "tenant");
        assert_string_drift!(collector_service_name, "drain-source-collector-2");
        assert_string_drift!(collector_version_id, "collector-build-2");
        assert_string_drift!(collector_run_id_sha256, digest("collector-run-2"));
        assert_string_drift!(
            started_by_credential_id_sha256,
            digest("collector-credential-2")
        );
        assert_string_drift!(
            accepted_source_schema_sha256,
            digest("accepted-source-schema-2")
        );
        assert_string_drift!(authorizer_issuer, "cinatoken-drain-source-authorizer-2");
        assert_string_drift!(authorizer_key_id, "drain-source-authorizer-v2");
        assert_string_drift!(authorizer_identity_sha256, digest("authorizer-identity-2"));
        assert_string_drift!(authorizer_spki_sha256, digest("authorizer-spki-2"));
        assert_string_drift!(
            authorization_subject_sha256,
            digest("authorization-subject-2")
        );
        assert_string_drift!(
            authorization_signature_envelope_sha256,
            digest("authorization-envelope-2")
        );
        assert_string_drift!(execution_nonce_sha256, digest("execution-nonce-2"));
        assert_value_drift!(permit_issued_at, NOW - 9);
        assert_value_drift!(authorized_by_admin_id, 2);
        assert_string_drift!(action_digest_sha256, digest("action-2"));
        assert_string_drift!(registration_request_sha256, digest("request-2"));
        assert_string_drift!(admin_audit_digest_sha256, digest("audit-2"));
        assert_string_drift!(
            admin_network_identity_hmac_sha256,
            digest("network-identity-2")
        );
        assert_string_drift!(environment, "production");
        assert_string_drift!(source_scan_id_sha256, digest("source-scan-2"));
        assert_string_drift!(change_ticket_sha256, digest("change-ticket-2"));
        assert_string_drift!(reason_code, "migration.source-capture-2");
        assert_string_drift!(
            authority_ledger_identity_sha256,
            digest("authority-ledger-2")
        );
        assert_string_drift!(ledger_head_before_sha256, digest("ledger-head-2"));
        assert_value_drift!(root_admin_id, 2);
        assert_value_drift!(root_session_epoch, 8);
        assert_value_drift!(root_session_issued_at, NOW - 59);
        assert_value_drift!(root_session_expires_at, NOW + 301);
        assert_string_drift!(root_session_binding_sha256, digest("session-binding-2"));
        assert_value_drift!(passkey_credential_row_id, 12);
        assert_string_drift!(passkey_credential_id_sha256, digest("credential-id-2"));
        assert_string_drift!(
            passkey_credential_registration_id_sha256,
            digest("credential-registration-id-2")
        );
        assert_string_drift!(
            passkey_credential_binding_sha256,
            digest("credential-binding-2")
        );
        assert_value_drift!(passkey_previous_use_generation, 18);
        assert_string_drift!(registered_by_service_name, "cinatoken-application-2");
        assert_string_drift!(registered_by_version_id, "build-2026-07-30-2");
        assert_string_drift!(
            registration_execution_id_sha256,
            digest("registration-execution-2")
        );
        assert_string_drift!(
            registration_credential_id_sha256,
            digest("registration-credential-2")
        );
        assert_string_drift!(ceremony_nonce_sha256, digest("ceremony-nonce-2"));

        assert_value_drift!(verification_expires_at, NOW + 121);
        assert_value_drift!(permit_expires_at, NOW + 301);
        assert_value_drift!(page_size, 129);
        assert_value_drift!(shard_count, 17);
        assert_value_drift!(receipt_sequence, 2);

        let mut changed = state.clone();
        changed.action.scope_id_sha256 = digest("wrong-scope");
        changed.challenge = changed.expected_challenge().unwrap();
        assert_ne!(changed.challenge, expected);
        assert_eq!(
            changed.validate(),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut changed = state.clone();
        changed.rp_id = "admin.cinatoken.com".to_owned();
        changed.challenge = changed.expected_challenge().unwrap();
        assert_ne!(changed.challenge, expected);
        assert!(changed.validate().is_ok());

        let mut changed = state.clone();
        changed.origin = "https://ops.cinatoken.com".to_owned();
        changed.challenge = changed.expected_challenge().unwrap();
        assert_ne!(changed.challenge, expected);
        assert!(changed.validate().is_ok());

        let mut changed = state.clone();
        changed.issued_at += 1;
        changed.challenge = changed.expected_challenge().unwrap();
        assert_ne!(changed.challenge, expected);
        assert!(changed.validate().is_ok());
    }

    #[test]
    fn action_writer_projection_exposes_every_signed_field_read_only() {
        let action_value = action();
        let projection = action_value.writer_projection();

        macro_rules! assert_string_projection {
            ($($field:ident),+ $(,)?) => {
                $(
                    assert_eq!(
                        projection.$field(),
                        action_value.$field,
                        "{}",
                        stringify!($field)
                    );
                )+
            };
        }

        macro_rules! assert_copy_projection {
            ($($field:ident),+ $(,)?) => {
                $(
                    assert_eq!(
                        projection.$field(),
                        action_value.$field,
                        "{}",
                        stringify!($field)
                    );
                )+
            };
        }

        assert_string_projection!(
            contract,
            action,
            authorization_contract,
            environment,
            authorization_id_sha256,
            admission_fence_id_sha256,
            expected_fence_state_digest_sha256,
            expected_head_digest_sha256,
            scope_kind,
            scope_id_sha256,
            source_scan_id_sha256,
            collector_service_name,
            collector_version_id,
            collector_run_id_sha256,
            started_by_credential_id_sha256,
            accepted_source_schema_sha256,
            authorizer_issuer,
            authorizer_key_id,
            authorizer_identity_sha256,
            authorizer_spki_sha256,
            authorization_subject_sha256,
            authorization_signature_envelope_sha256,
            execution_nonce_sha256,
            action_digest_sha256,
            registration_request_sha256,
            admin_audit_digest_sha256,
            admin_network_identity_hmac_sha256,
            change_ticket_sha256,
            reason_code,
            authority_ledger_identity_sha256,
            ledger_head_before_sha256,
            root_session_binding_sha256,
            passkey_credential_id_sha256,
            passkey_credential_registration_id_sha256,
            passkey_credential_binding_sha256,
            registered_by_service_name,
            registered_by_version_id,
            registration_execution_id_sha256,
            registration_credential_id_sha256,
            ceremony_nonce_sha256,
        );
        assert_copy_projection!(
            schema_version,
            authorization_contract_version,
            fence_generation,
            expected_head_version,
            page_size,
            shard_count,
            permit_issued_at,
            permit_expires_at,
            authorized_by_admin_id,
            verification_expires_at,
            receipt_sequence,
            root_admin_id,
            root_session_epoch,
            root_session_issued_at,
            root_session_expires_at,
            passkey_credential_row_id,
            passkey_previous_use_generation,
        );
        assert_eq!(
            projection.action_subject_sha256().unwrap(),
            sha256_hex(action_value.canonical_subject().unwrap())
        );
    }

    #[test]
    fn mandatory_uv_and_unknown_state_fields_fail_closed() {
        let state = state();
        assert!(state.expectation().require_user_verification);
        let json = serde_json::to_string(&state).unwrap();
        let downgraded = json.replace("\"required\"", "\"preferred\"");
        assert!(serde_json::from_str::<DrainSourceRegistrationCeremonyState>(&downgraded).is_err());
        let with_unknown = json.replacen('{', "{\"unexpected\":true,", 1);
        assert!(
            serde_json::from_str::<DrainSourceRegistrationCeremonyState>(&with_unknown).is_err()
        );
    }

    #[test]
    fn ceremony_key_and_challenge_are_canonical_and_bounded() {
        let state = state();
        assert_eq!(URL_SAFE_NO_PAD.decode(state.challenge()).unwrap().len(), 32);
        assert!(state.ceremony_key().unwrap().len() <= 256);
        assert_eq!(state.action_subject_sha256().unwrap().len(), 64);
        assert_eq!(
            state.secure_verification_challenge_sha256().unwrap().len(),
            64
        );
        assert!(state.validate().is_ok());
    }

    #[test]
    fn expiry_origin_and_identity_drift_are_rejected() {
        let valid = state();
        assert!(valid.validate_at(NOW).is_ok());
        assert_eq!(
            valid.validate_at(NOW - 1),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );
        assert_eq!(
            valid.validate_at(NOW + 120),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid = action();
        invalid.verification_expires_at = NOW + 29;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                action(),
                "cinatoken.com",
                "http://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                action(),
                "other.example",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid = action();
        invalid.root_session_issued_at = invalid.root_session_epoch - 1;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut invalid = action();
        invalid.root_session_expires_at = invalid.root_session_issued_at;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut invalid = action();
        invalid.root_session_expires_at = invalid.verification_expires_at - 1;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut invalid = action();
        invalid.passkey_previous_use_generation = -1;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut invalid = action();
        invalid.passkey_previous_use_generation = MAXIMUM_SAFE_INTEGER;
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut maximum = action();
        maximum.passkey_previous_use_generation = MAXIMUM_PREVIOUS_USE_GENERATION;
        assert!(DrainSourceRegistrationCeremonyState::new(
            maximum,
            "cinatoken.com",
            "https://admin.cinatoken.com",
            NOW,
        )
        .is_ok());

        let baseline = action();
        for invalid in [
            DrainSourceRegistrationActionV1 {
                passkey_credential_registration_id_sha256: baseline
                    .passkey_credential_id_sha256
                    .clone(),
                ..baseline.clone()
            },
            DrainSourceRegistrationActionV1 {
                passkey_credential_binding_sha256: baseline.passkey_credential_id_sha256.clone(),
                ..baseline.clone()
            },
            DrainSourceRegistrationActionV1 {
                passkey_credential_binding_sha256: baseline
                    .passkey_credential_registration_id_sha256
                    .clone(),
                ..baseline.clone()
            },
        ] {
            assert_eq!(
                DrainSourceRegistrationCeremonyState::new(
                    invalid,
                    "cinatoken.com",
                    "https://admin.cinatoken.com",
                    NOW,
                ),
                Err(DrainSourceRegistrationCeremonyError::InvalidAction)
            );
        }

        let mut invalid = action();
        invalid.admin_network_identity_hmac_sha256 = "x".repeat(64);
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut invalid = action();
        invalid.admin_network_identity_hmac_sha256 = "A".repeat(64);
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                invalid,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );

        let mut empty_identity = action();
        empty_identity.admin_network_identity_hmac_sha256.clear();
        assert_eq!(
            DrainSourceRegistrationCeremonyState::new(
                empty_identity,
                "cinatoken.com",
                "https://admin.cinatoken.com",
                NOW,
            ),
            Err(DrainSourceRegistrationCeremonyError::InvalidAction)
        );
    }

    #[test]
    fn admin_network_identity_is_canonical_keyed_and_never_plaintext() {
        let key = [0x42; 32];
        let compressed = AdminNetworkIdentityHmacSha256::derive(&key, "2001:db8::42").unwrap();
        let expanded =
            AdminNetworkIdentityHmacSha256::derive(&key, "2001:0db8:0000:0000:0000:0000:0000:0042")
                .unwrap();
        let other_ip = AdminNetworkIdentityHmacSha256::derive(&key, "2001:db8::43").unwrap();
        let other_key =
            AdminNetworkIdentityHmacSha256::derive(&[0x43; 32], "2001:db8::42").unwrap();

        assert_eq!(compressed, expanded);
        assert_ne!(compressed, other_ip);
        assert_ne!(compressed, other_key);
        assert_eq!(compressed.0.len(), 64);
        assert!(compressed
            .0
            .bytes()
            .all(|byte| { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }));
        assert!(!compressed.0.contains("2001:db8"));
        assert!(AdminNetworkIdentityHmacSha256::derive(&[0x42; 31], "192.0.2.1").is_err());
        assert!(AdminNetworkIdentityHmacSha256::derive(&key, " 192.0.2.1").is_err());
        assert!(AdminNetworkIdentityHmacSha256::derive(&key, "not-an-ip").is_err());
    }

    #[test]
    fn verified_proof_uses_only_verified_binary_evidence() {
        let state = state();
        let credential_id = b"credential-id";
        let credential = StoredCredential {
            credential_id,
            public_key_cose: b"unused-in-this-proof-projection",
            sign_count: 7,
            backup_eligible: true,
        };
        let stored = DrainSourceRegistrationStoredCredential {
            row_id: state.action.passkey_credential_row_id,
            user_id: state.action.root_admin_id,
            clone_warning: false,
            passkey_credential_registration_id_sha256: &state
                .action
                .passkey_credential_registration_id_sha256,
            passkey_credential_binding_sha256: &state.action.passkey_credential_binding_sha256,
            passkey_previous_use_generation: state.action.passkey_previous_use_generation,
            credential,
        };
        let verified = VerifiedAssertion {
            credential_id: credential_id.to_vec(),
            user_handle: Some(state.action.root_admin_id.to_string().into_bytes()),
            sign_count: 8,
            clone_warning: false,
            user_present: true,
            user_verified: true,
            backup_eligible: true,
            backup_state: false,
            signed_subject_sha256: Sha256::digest(b"signed-subject").into(),
            signature_sha256: Sha256::digest(b"signature").into(),
            challenge_sha256: decode_sha256_hex(
                &state.secure_verification_challenge_sha256().unwrap(),
            )
            .unwrap(),
        };

        let proof = state.proof_from_verified(&stored, &verified, NOW).unwrap();
        assert_ne!(
            state.action.passkey_credential_id_sha256,
            digest("credential-id"),
            "persisted Passkey credential ids are domain-separated"
        );
        assert_eq!(
            proof.passkey_assertion_subject_sha256,
            sha256_hex(b"signed-subject")
        );
        assert_eq!(
            proof.passkey_assertion_signature_sha256,
            sha256_hex(b"signature")
        );
        assert_eq!(
            proof.secure_verification_challenge_sha256,
            state.secure_verification_challenge_sha256().unwrap()
        );
        assert_eq!(
            proof.passkey_credential_registration_id_sha256,
            state.action.passkey_credential_registration_id_sha256
        );
        assert_eq!(
            proof.passkey_credential_binding_sha256,
            state.action.passkey_credential_binding_sha256
        );
        assert_eq!(
            proof.passkey_previous_use_generation,
            state.action.passkey_previous_use_generation
        );
        assert_eq!(proof.previous_sign_count, 7);
        assert_eq!(proof.sign_count, 8);
        assert_eq!(proof.verified_at, NOW);
        let bindings = state.registration_permit_bindings(&proof).unwrap();
        assert_eq!(
            bindings.action_subject_sha256,
            state.action_subject_sha256().unwrap()
        );
        assert_eq!(
            bindings.passkey_assertion_signature_sha256,
            sha256_hex(b"signature")
        );
        assert_eq!(bindings.passkey_previous_sign_count, 7);
        assert_eq!(bindings.passkey_sign_count, 8);
        assert_eq!(
            bindings.passkey_credential_registration_id_sha256,
            state.action.passkey_credential_registration_id_sha256
        );
        assert_eq!(
            bindings.passkey_credential_binding_sha256,
            state.action.passkey_credential_binding_sha256
        );
        assert_eq!(bindings.passkey_previous_use_generation, 17);
        assert_eq!(bindings.verified_at, NOW);

        let proof_projection = proof.writer_projection();
        assert_eq!(proof_projection.passkey_credential_row_id(), stored.row_id);
        assert_eq!(
            proof_projection.passkey_credential_id_sha256(),
            state.action.passkey_credential_id_sha256
        );
        assert_eq!(
            proof_projection.passkey_credential_registration_id_sha256(),
            stored.passkey_credential_registration_id_sha256
        );
        assert_eq!(
            proof_projection.passkey_credential_binding_sha256(),
            stored.passkey_credential_binding_sha256
        );
        assert_eq!(proof_projection.passkey_previous_use_generation(), 17);
        assert_eq!(
            proof_projection.passkey_assertion_subject_sha256(),
            sha256_hex(b"signed-subject")
        );
        assert_eq!(
            proof_projection.passkey_assertion_signature_sha256(),
            sha256_hex(b"signature")
        );
        assert_eq!(
            proof_projection.secure_verification_challenge_sha256(),
            state.secure_verification_challenge_sha256().unwrap()
        );
        assert_eq!(proof_projection.previous_sign_count(), 7);
        assert_eq!(proof_projection.sign_count(), 8);
        assert!(proof_projection.user_present());
        assert!(proof_projection.user_verified());
        assert!(proof_projection.backup_eligible());
        assert!(!proof_projection.backup_state());
        assert_eq!(proof_projection.verified_at(), NOW);

        let mut invalid_backup = proof.clone();
        invalid_backup.backup_eligible = false;
        invalid_backup.backup_state = true;
        assert_eq!(
            state.registration_permit_bindings(&invalid_backup),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid_sign_count = proof.clone();
        invalid_sign_count.sign_count = invalid_sign_count.previous_sign_count;
        assert_eq!(
            state.registration_permit_bindings(&invalid_sign_count),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid_registration_id = proof.clone();
        invalid_registration_id.passkey_credential_registration_id_sha256 =
            digest("other-registration-id");
        assert_eq!(
            state.registration_permit_bindings(&invalid_registration_id),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid_binding = proof.clone();
        invalid_binding.passkey_credential_binding_sha256 = digest("other-credential-binding");
        assert_eq!(
            state.registration_permit_bindings(&invalid_binding),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut invalid_generation = proof.clone();
        invalid_generation.passkey_previous_use_generation += 1;
        assert_eq!(
            state.registration_permit_bindings(&invalid_generation),
            Err(DrainSourceRegistrationCeremonyError::InvalidCeremony)
        );

        let mut cloned = verified.clone();
        cloned.clone_warning = true;
        assert_eq!(
            state.proof_from_verified(&stored, &cloned, NOW),
            Err(DrainSourceRegistrationCeremonyError::CloneDetected)
        );

        let precloned = DrainSourceRegistrationStoredCredential {
            clone_warning: true,
            ..stored
        };
        assert_eq!(
            state.proof_from_verified(&precloned, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::CloneDetected)
        );

        let mut unverified = verified.clone();
        unverified.user_verified = false;
        assert_eq!(
            state.proof_from_verified(&stored, &unverified, NOW),
            Err(DrainSourceRegistrationCeremonyError::UserVerificationRequired)
        );

        let mut not_present = verified.clone();
        not_present.user_present = false;
        assert_eq!(
            state.proof_from_verified(&stored, &not_present, NOW),
            Err(DrainSourceRegistrationCeremonyError::UserVerificationRequired)
        );

        let mut wrong_handle = verified.clone();
        wrong_handle.user_handle = Some(b"2".to_vec());
        assert_eq!(
            state.proof_from_verified(&stored, &wrong_handle, NOW),
            Err(DrainSourceRegistrationCeremonyError::UserHandleMismatch)
        );

        let wrong_row = DrainSourceRegistrationStoredCredential {
            row_id: stored.row_id + 1,
            ..stored
        };
        assert_eq!(
            state.proof_from_verified(&wrong_row, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );

        let mut plain_digest_action = state.action.clone();
        plain_digest_action.passkey_credential_id_sha256 = digest("credential-id");
        let plain_digest_state = DrainSourceRegistrationCeremonyState::new(
            plain_digest_action,
            "cinatoken.com",
            "https://admin.cinatoken.com",
            NOW,
        )
        .unwrap();
        assert_eq!(
            plain_digest_state.proof_from_verified(&stored, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );

        let wrong_registration_id = digest("wrong-stored-registration-id");
        let wrong_registration = DrainSourceRegistrationStoredCredential {
            passkey_credential_registration_id_sha256: &wrong_registration_id,
            ..stored
        };
        assert_eq!(
            state.proof_from_verified(&wrong_registration, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );

        let wrong_binding_digest = digest("wrong-stored-binding");
        let wrong_binding = DrainSourceRegistrationStoredCredential {
            passkey_credential_binding_sha256: &wrong_binding_digest,
            ..stored
        };
        assert_eq!(
            state.proof_from_verified(&wrong_binding, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );

        let wrong_generation = DrainSourceRegistrationStoredCredential {
            passkey_previous_use_generation: stored.passkey_previous_use_generation + 1,
            ..stored
        };
        assert_eq!(
            state.proof_from_verified(&wrong_generation, &verified, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );

        let mut wrong_challenge = verified;
        wrong_challenge.challenge_sha256 = Sha256::digest(b"wrong-challenge").into();
        assert_eq!(
            state.proof_from_verified(&stored, &wrong_challenge, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );
    }
}
