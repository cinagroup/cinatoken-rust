//! Closed 0074 registration command assembled from already-verified evidence.
//!
//! The route layer cannot provide command or receipt identities. They are
//! derived here from the typed action, verified WebAuthn proof, and verified
//! isolated-issuer permit before the D1 repository can observe them.

use sha2::{Digest, Sha256};

use crate::container_drain_source_registration_action::{
    DrainSourceRegistrationActionV1, VerifiedDrainSourceRegistrationPasskeyProof,
};
use crate::container_drain_source_registration_coordinator::ValidatedDrainSourceRegistrationCommit;
use crate::container_drain_source_registration_permit::VerifiedDrainSourceRegistrationPermit;

pub(crate) const DRAIN_SOURCE_REGISTRATION_COMMAND_CONTRACT: &str =
    "relay-container-drain-source-registration-command-v1";
pub(crate) const DRAIN_SOURCE_REGISTRATION_COMMAND_MIGRATION: &str =
    "0074_relay_container_drain_source_registration_command.sql";

const SECURE_VERIFICATION_RECEIPT_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-secure-receipt-v1";
const COMMAND_ID_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-command-id-v1";
const REGISTRATION_RECEIPT_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-receipt-v1";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedDrainSourceRegistrationCommand {
    command_id_sha256: String,
    environment: String,
    authorization_id_sha256: String,
    permit_id_sha256: String,
    permit_subject_sha256: String,
    permit_signature_envelope_sha256: String,
    issuer_request_id_sha256: String,
    issuer_version_id: String,
    permit_issuer: String,
    permit_key_id: String,
    permit_signer_identity_sha256: String,
    permit_signer_spki_sha256: String,
    action_subject_sha256: String,
    action_digest_sha256: String,
    registration_request_sha256: String,
    admin_audit_digest_sha256: String,
    change_ticket_sha256: String,
    reason_code: String,
    admin_network_identity_hmac_sha256: String,
    root_admin_id: i64,
    root_session_epoch: i64,
    root_session_binding_sha256: String,
    root_session_issued_at: i64,
    root_session_expires_at: i64,
    passkey_credential_row_id: i64,
    passkey_credential_registration_id_sha256: String,
    passkey_credential_id_sha256: String,
    passkey_credential_binding_sha256: String,
    passkey_previous_use_generation: i64,
    passkey_next_use_generation: i64,
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
    permit_issued_at: i64,
    permit_expires_at: i64,
    secure_verification_receipt_sha256: String,
    registration_receipt_sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DrainSourceRegistrationCommandError {
    BindingMismatch,
    InvalidGeneration,
    InvalidDerivation,
}

impl std::fmt::Display for DrainSourceRegistrationCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::BindingMismatch => "drain_source_registration_command_binding_mismatch",
            Self::InvalidGeneration => "drain_source_registration_command_generation_invalid",
            Self::InvalidDerivation => "drain_source_registration_command_derivation_invalid",
        })
    }
}

impl std::error::Error for DrainSourceRegistrationCommandError {}

impl VerifiedDrainSourceRegistrationCommand {
    pub(crate) fn from_validated_commit(
        commit: &ValidatedDrainSourceRegistrationCommit,
    ) -> Result<Self, DrainSourceRegistrationCommandError> {
        let (action, proof, permit) = commit.command_evidence();
        Self::assemble(action, proof, permit)
    }

    fn assemble(
        action: &DrainSourceRegistrationActionV1,
        proof: &VerifiedDrainSourceRegistrationPasskeyProof,
        permit: &VerifiedDrainSourceRegistrationPermit,
    ) -> Result<Self, DrainSourceRegistrationCommandError> {
        let issuer_request_id_sha256 = permit
            .authenticated_request_id_sha256()
            .map_err(|_| DrainSourceRegistrationCommandError::BindingMismatch)?;
        let action = action.writer_projection();
        let proof = proof.writer_projection();
        let permit = permit.writer_projection();
        let action_subject_sha256 = action
            .action_subject_sha256()
            .map_err(|_| DrainSourceRegistrationCommandError::BindingMismatch)?;

        if permit.environment() != action.environment()
            || permit.action() != action.action()
            || permit.authorization_id_sha256() != action.authorization_id_sha256()
            || permit.authorization_subject_sha256() != action.authorization_subject_sha256()
            || permit.authorization_signature_envelope_sha256()
                != action.authorization_signature_envelope_sha256()
            || permit.action_subject_sha256() != action_subject_sha256
            || permit.action_digest_sha256() != action.action_digest_sha256()
            || permit.registration_request_sha256() != action.registration_request_sha256()
            || permit.admin_audit_digest_sha256() != action.admin_audit_digest_sha256()
            || permit.admin_network_identity_hmac_sha256()
                != action.admin_network_identity_hmac_sha256()
            || permit.change_ticket_sha256() != action.change_ticket_sha256()
            || permit.root_admin_id() != action.root_admin_id()
            || permit.root_session_epoch() != action.root_session_epoch()
            || permit.root_session_issued_at() != action.root_session_issued_at()
            || permit.root_session_expires_at() != action.root_session_expires_at()
            || permit.root_session_binding_sha256() != action.root_session_binding_sha256()
            || permit.passkey_credential_row_id() != action.passkey_credential_row_id()
            || permit.passkey_credential_id_sha256() != action.passkey_credential_id_sha256()
            || permit.passkey_credential_registration_id_sha256()
                != action.passkey_credential_registration_id_sha256()
            || permit.passkey_credential_binding_sha256()
                != action.passkey_credential_binding_sha256()
            || permit.passkey_previous_use_generation() != action.passkey_previous_use_generation()
            || permit.registered_by_service_name() != action.registered_by_service_name()
            || permit.registered_by_version_id() != action.registered_by_version_id()
            || permit.registration_execution_id_sha256()
                != action.registration_execution_id_sha256()
            || permit.registration_credential_id_sha256()
                != action.registration_credential_id_sha256()
            || permit.authority_ledger_identity_sha256()
                != action.authority_ledger_identity_sha256()
            || permit.receipt_sequence() != action.receipt_sequence()
            || permit.ledger_head_before_sha256() != action.ledger_head_before_sha256()
            || permit.verification_expires_at() != action.verification_expires_at()
            || permit.passkey_credential_row_id() != proof.passkey_credential_row_id()
            || permit.passkey_credential_id_sha256() != proof.passkey_credential_id_sha256()
            || permit.passkey_credential_registration_id_sha256()
                != proof.passkey_credential_registration_id_sha256()
            || permit.passkey_credential_binding_sha256()
                != proof.passkey_credential_binding_sha256()
            || permit.passkey_previous_use_generation() != proof.passkey_previous_use_generation()
            || permit.passkey_assertion_subject_sha256() != proof.passkey_assertion_subject_sha256()
            || permit.passkey_assertion_signature_sha256()
                != proof.passkey_assertion_signature_sha256()
            || permit.secure_verification_challenge_sha256()
                != proof.secure_verification_challenge_sha256()
            || permit.passkey_previous_sign_count() != proof.previous_sign_count()
            || permit.passkey_sign_count() != proof.sign_count()
            || permit.passkey_user_present() != proof.user_present()
            || permit.passkey_user_verified() != proof.user_verified()
            || permit.passkey_backup_eligible() != proof.backup_eligible()
            || permit.passkey_backup_state() != proof.backup_state()
            || permit.verified_at() != proof.verified_at()
        {
            return Err(DrainSourceRegistrationCommandError::BindingMismatch);
        }

        let passkey_next_use_generation = permit
            .passkey_previous_use_generation()
            .checked_add(1)
            .filter(|generation| *generation <= MAXIMUM_SAFE_INTEGER)
            .ok_or(DrainSourceRegistrationCommandError::InvalidGeneration)?;
        let previous_generation = permit.passkey_previous_use_generation().to_string();
        let next_generation = passkey_next_use_generation.to_string();
        let previous_sign_count = permit.passkey_previous_sign_count().to_string();
        let sign_count = permit.passkey_sign_count().to_string();
        let verified_at = permit.verified_at().to_string();
        let secure_verification_receipt_sha256 = canonical_sha256(
            SECURE_VERIFICATION_RECEIPT_DOMAIN,
            &[
                permit.permit_id_sha256().as_bytes(),
                permit.subject_sha256().as_bytes(),
                permit.signature_envelope_sha256().as_bytes(),
                issuer_request_id_sha256.as_bytes(),
                action_subject_sha256.as_bytes(),
                permit
                    .passkey_credential_registration_id_sha256()
                    .as_bytes(),
                permit.passkey_credential_binding_sha256().as_bytes(),
                permit.passkey_assertion_subject_sha256().as_bytes(),
                permit.passkey_assertion_signature_sha256().as_bytes(),
                permit.secure_verification_challenge_sha256().as_bytes(),
                previous_generation.as_bytes(),
                next_generation.as_bytes(),
                previous_sign_count.as_bytes(),
                sign_count.as_bytes(),
                verified_at.as_bytes(),
            ],
        )?;
        let command_id_sha256 = canonical_sha256(
            COMMAND_ID_DOMAIN,
            &[
                permit.permit_id_sha256().as_bytes(),
                permit.subject_sha256().as_bytes(),
                permit.signature_envelope_sha256().as_bytes(),
                issuer_request_id_sha256.as_bytes(),
                action_subject_sha256.as_bytes(),
                action.action_digest_sha256().as_bytes(),
                action.registration_request_sha256().as_bytes(),
                action.admin_audit_digest_sha256().as_bytes(),
                secure_verification_receipt_sha256.as_bytes(),
            ],
        )?;
        let receipt_sequence = action.receipt_sequence().to_string();
        let verification_expires_at = action.verification_expires_at().to_string();
        let registration_receipt_sha256 = canonical_sha256(
            REGISTRATION_RECEIPT_DOMAIN,
            &[
                command_id_sha256.as_bytes(),
                secure_verification_receipt_sha256.as_bytes(),
                action.authorization_id_sha256().as_bytes(),
                action_subject_sha256.as_bytes(),
                action.action_digest_sha256().as_bytes(),
                action.registration_request_sha256().as_bytes(),
                action.admin_audit_digest_sha256().as_bytes(),
                action.change_ticket_sha256().as_bytes(),
                action.reason_code().as_bytes(),
                action
                    .passkey_credential_registration_id_sha256()
                    .as_bytes(),
                action.passkey_credential_binding_sha256().as_bytes(),
                previous_generation.as_bytes(),
                next_generation.as_bytes(),
                previous_sign_count.as_bytes(),
                sign_count.as_bytes(),
                action.registered_by_service_name().as_bytes(),
                action.registered_by_version_id().as_bytes(),
                action.registration_execution_id_sha256().as_bytes(),
                action.registration_credential_id_sha256().as_bytes(),
                action.authority_ledger_identity_sha256().as_bytes(),
                receipt_sequence.as_bytes(),
                action.ledger_head_before_sha256().as_bytes(),
                verified_at.as_bytes(),
                verification_expires_at.as_bytes(),
            ],
        )?;
        if command_id_sha256 == secure_verification_receipt_sha256
            || command_id_sha256 == registration_receipt_sha256
            || secure_verification_receipt_sha256 == registration_receipt_sha256
        {
            return Err(DrainSourceRegistrationCommandError::InvalidDerivation);
        }

        Ok(Self {
            command_id_sha256,
            environment: action.environment().to_owned(),
            authorization_id_sha256: action.authorization_id_sha256().to_owned(),
            permit_id_sha256: permit.permit_id_sha256().to_owned(),
            permit_subject_sha256: permit.subject_sha256().to_owned(),
            permit_signature_envelope_sha256: permit.signature_envelope_sha256().to_owned(),
            issuer_request_id_sha256,
            issuer_version_id: permit.issuer_version_id().to_owned(),
            permit_issuer: permit.issuer().to_owned(),
            permit_key_id: permit.key_id().to_owned(),
            permit_signer_identity_sha256: permit.signer_identity_sha256().to_owned(),
            permit_signer_spki_sha256: permit.signer_spki_sha256().to_owned(),
            action_subject_sha256,
            action_digest_sha256: action.action_digest_sha256().to_owned(),
            registration_request_sha256: action.registration_request_sha256().to_owned(),
            admin_audit_digest_sha256: action.admin_audit_digest_sha256().to_owned(),
            change_ticket_sha256: action.change_ticket_sha256().to_owned(),
            reason_code: action.reason_code().to_owned(),
            admin_network_identity_hmac_sha256: action
                .admin_network_identity_hmac_sha256()
                .to_owned(),
            root_admin_id: action.root_admin_id(),
            root_session_epoch: action.root_session_epoch(),
            root_session_binding_sha256: action.root_session_binding_sha256().to_owned(),
            root_session_issued_at: action.root_session_issued_at(),
            root_session_expires_at: action.root_session_expires_at(),
            passkey_credential_row_id: proof.passkey_credential_row_id(),
            passkey_credential_registration_id_sha256: proof
                .passkey_credential_registration_id_sha256()
                .to_owned(),
            passkey_credential_id_sha256: proof.passkey_credential_id_sha256().to_owned(),
            passkey_credential_binding_sha256: proof.passkey_credential_binding_sha256().to_owned(),
            passkey_previous_use_generation: proof.passkey_previous_use_generation(),
            passkey_next_use_generation,
            passkey_assertion_subject_sha256: proof.passkey_assertion_subject_sha256().to_owned(),
            passkey_assertion_signature_sha256: proof
                .passkey_assertion_signature_sha256()
                .to_owned(),
            secure_verification_challenge_sha256: proof
                .secure_verification_challenge_sha256()
                .to_owned(),
            passkey_previous_sign_count: proof.previous_sign_count(),
            passkey_sign_count: proof.sign_count(),
            passkey_user_present: proof.user_present(),
            passkey_user_verified: proof.user_verified(),
            passkey_backup_eligible: proof.backup_eligible(),
            passkey_backup_state: proof.backup_state(),
            registered_by_service_name: action.registered_by_service_name().to_owned(),
            registered_by_version_id: action.registered_by_version_id().to_owned(),
            registration_execution_id_sha256: action.registration_execution_id_sha256().to_owned(),
            registration_credential_id_sha256: action
                .registration_credential_id_sha256()
                .to_owned(),
            authority_ledger_identity_sha256: action.authority_ledger_identity_sha256().to_owned(),
            receipt_sequence: action.receipt_sequence(),
            ledger_head_before_sha256: action.ledger_head_before_sha256().to_owned(),
            verification_expires_at: action.verification_expires_at(),
            verified_at: proof.verified_at(),
            permit_issued_at: permit.issued_at(),
            permit_expires_at: permit.expires_at(),
            secure_verification_receipt_sha256,
            registration_receipt_sha256,
        })
    }
}

macro_rules! command_string_accessors {
    ($($field:ident),+ $(,)?) => {
        $(
            pub(crate) fn $field(&self) -> &str {
                &self.$field
            }
        )+
    };
}

macro_rules! command_copy_accessors {
    ($($field:ident: $ty:ty),+ $(,)?) => {
        $(
            pub(crate) fn $field(&self) -> $ty {
                self.$field
            }
        )+
    };
}

impl VerifiedDrainSourceRegistrationCommand {
    command_string_accessors!(
        command_id_sha256,
        environment,
        authorization_id_sha256,
        permit_id_sha256,
        permit_subject_sha256,
        permit_signature_envelope_sha256,
        issuer_request_id_sha256,
        issuer_version_id,
        permit_issuer,
        permit_key_id,
        permit_signer_identity_sha256,
        permit_signer_spki_sha256,
        action_subject_sha256,
        action_digest_sha256,
        registration_request_sha256,
        admin_audit_digest_sha256,
        change_ticket_sha256,
        reason_code,
        admin_network_identity_hmac_sha256,
        root_session_binding_sha256,
        passkey_credential_registration_id_sha256,
        passkey_credential_id_sha256,
        passkey_credential_binding_sha256,
        passkey_assertion_subject_sha256,
        passkey_assertion_signature_sha256,
        secure_verification_challenge_sha256,
        registered_by_service_name,
        registered_by_version_id,
        registration_execution_id_sha256,
        registration_credential_id_sha256,
        authority_ledger_identity_sha256,
        ledger_head_before_sha256,
        secure_verification_receipt_sha256,
        registration_receipt_sha256,
    );

    command_copy_accessors!(
        root_admin_id: i64,
        root_session_epoch: i64,
        root_session_issued_at: i64,
        root_session_expires_at: i64,
        passkey_credential_row_id: i64,
        passkey_previous_use_generation: i64,
        passkey_next_use_generation: i64,
        passkey_previous_sign_count: u32,
        passkey_sign_count: u32,
        passkey_user_present: bool,
        passkey_user_verified: bool,
        passkey_backup_eligible: bool,
        passkey_backup_state: bool,
        receipt_sequence: i64,
        verification_expires_at: i64,
        verified_at: i64,
        permit_issued_at: i64,
        permit_expires_at: i64,
    );
}

fn canonical_sha256(
    domain: &[u8],
    fields: &[&[u8]],
) -> Result<String, DrainSourceRegistrationCommandError> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for field in fields {
        let length = u32::try_from(field.len())
            .map_err(|_| DrainSourceRegistrationCommandError::InvalidDerivation)?;
        hasher.update(length.to_be_bytes());
        hasher.update(field);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_domains_are_distinct_and_length_prefixed() {
        let fields = [b"ab".as_slice(), b"c".as_slice()];
        let alternate = [b"a".as_slice(), b"bc".as_slice()];
        let command = canonical_sha256(COMMAND_ID_DOMAIN, &fields).unwrap();
        let command_alternate = canonical_sha256(COMMAND_ID_DOMAIN, &alternate).unwrap();
        let secure = canonical_sha256(SECURE_VERIFICATION_RECEIPT_DOMAIN, &fields).unwrap();
        let registration = canonical_sha256(REGISTRATION_RECEIPT_DOMAIN, &fields).unwrap();

        assert_ne!(command, command_alternate);
        assert_ne!(command, secure);
        assert_ne!(command, registration);
        assert_ne!(secure, registration);
        assert_eq!(command.len(), 64);
        assert!(command
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')));
    }
}
