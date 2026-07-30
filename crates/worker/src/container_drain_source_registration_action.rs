//! Action-bound, one-shot WebAuthn proof foundation for 0073 registration.
//!
//! This module is deliberately route-free and writer-free. It freezes the
//! exact Root action into a mandatory-UV challenge and returns proof digests
//! only after the WebAuthn signature has been verified.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::Env;

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
const CEREMONY_KEY_PREFIX: &str = "drain-source-registration";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MINIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 30;
const MAXIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 300;

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
    change_ticket_sha256: String,
    reason_code: String,
    verification_expires_at: i64,
    authority_ledger_identity_sha256: String,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    root_admin_id: i64,
    root_session_epoch: i64,
    root_session_binding_sha256: String,
    passkey_credential_row_id: i64,
    passkey_credential_id_sha256: String,
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
    pub(crate) change_ticket_sha256: String,
    pub(crate) reason_code: String,
    pub(crate) verification_expires_at: i64,
    pub(crate) receipt_sequence: i64,
    pub(crate) ledger_head_before_sha256: String,
    pub(crate) root_session_epoch: i64,
    pub(crate) root_session_binding_sha256: String,
    pub(crate) passkey_credential_row_id: i64,
    pub(crate) passkey_credential_id_sha256: String,
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
    pub(crate) credential: StoredCredential<'a>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct VerifiedDrainSourceRegistrationPasskeyProof {
    pub(crate) passkey_credential_row_id: i64,
    pub(crate) passkey_credential_id_sha256: String,
    pub(crate) passkey_assertion_subject_sha256: String,
    pub(crate) passkey_assertion_signature_sha256: String,
    pub(crate) secure_verification_challenge_sha256: String,
    pub(crate) sign_count: u32,
    pub(crate) user_present: bool,
    pub(crate) user_verified: bool,
    pub(crate) backup_eligible: bool,
    pub(crate) backup_state: bool,
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
            || sha256_hex(stored.credential.credential_id)
                != self.action.passkey_credential_id_sha256
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
            passkey_assertion_subject_sha256: encode_hex(&verified.signed_subject_sha256),
            passkey_assertion_signature_sha256: encode_hex(&verified.signature_sha256),
            secure_verification_challenge_sha256: encode_hex(&verified.challenge_sha256),
            sign_count: verified.sign_count,
            user_present: verified.user_present,
            user_verified: verified.user_verified,
            backup_eligible: verified.backup_eligible,
            backup_state: verified.backup_state,
        })
    }
}

impl DrainSourceRegistrationActionV1 {
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
            change_ticket_sha256: input.change_ticket_sha256,
            reason_code: input.reason_code,
            verification_expires_at: input.verification_expires_at,
            authority_ledger_identity_sha256: authorization.scope_id_sha256.clone(),
            receipt_sequence: input.receipt_sequence,
            ledger_head_before_sha256: input.ledger_head_before_sha256,
            root_admin_id: authorization.authorized_by_admin_id,
            root_session_epoch: input.root_session_epoch,
            root_session_binding_sha256: input.root_session_binding_sha256,
            passkey_credential_row_id: input.passkey_credential_row_id,
            passkey_credential_id_sha256: input.passkey_credential_id_sha256,
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
            || self.passkey_credential_row_id <= 0
            || self.passkey_credential_row_id > MAXIMUM_SAFE_INTEGER
            || !(1..=1_000_000).contains(&self.receipt_sequence)
            || issued_at <= 0
            || issued_at > MAXIMUM_SAFE_INTEGER
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
            self.change_ticket_sha256.clone(),
            self.reason_code.clone(),
            self.verification_expires_at.to_string(),
            self.authority_ledger_identity_sha256.clone(),
            self.receipt_sequence.to_string(),
            self.ledger_head_before_sha256.clone(),
            self.root_admin_id.to_string(),
            self.root_session_epoch.to_string(),
            self.root_session_binding_sha256.clone(),
            self.passkey_credential_row_id.to_string(),
            self.passkey_credential_id_sha256.clone(),
            self.registered_by_service_name.clone(),
            self.registered_by_version_id.clone(),
            self.registration_execution_id_sha256.clone(),
            self.registration_credential_id_sha256.clone(),
            self.ceremony_nonce_sha256.clone(),
        ];
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
                change_ticket_sha256: digest("change-ticket"),
                reason_code: "migration.source-capture".to_owned(),
                verification_expires_at: NOW + 120,
                receipt_sequence: 1,
                ledger_head_before_sha256: digest("ledger-head"),
                root_session_epoch: 7,
                root_session_binding_sha256: digest("session-binding"),
                passkey_credential_row_id: 11,
                passkey_credential_id_sha256: digest("credential-id"),
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
        assert_string_drift!(root_session_binding_sha256, digest("session-binding-2"));
        assert_value_drift!(passkey_credential_row_id, 12);
        assert_string_drift!(passkey_credential_id_sha256, digest("credential-id-2"));
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
            credential,
        };
        let mut state = state;
        state.action.passkey_credential_id_sha256 = sha256_hex(credential_id);
        state.challenge = state.expected_challenge().unwrap();
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

        let mut wrong_challenge = verified;
        wrong_challenge.challenge_sha256 = Sha256::digest(b"wrong-challenge").into();
        assert_eq!(
            state.proof_from_verified(&stored, &wrong_challenge, NOW),
            Err(DrainSourceRegistrationCeremonyError::StoredCredentialMismatch)
        );
    }
}
