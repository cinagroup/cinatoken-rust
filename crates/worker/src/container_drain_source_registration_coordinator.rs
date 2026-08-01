//! Route-free authority coordinator for the 0074 Root registration ceremony.
//!
//! D1 remains the global linearization authority. This module only validates
//! one-statement first-primary snapshots before challenge issue, permit issue,
//! and the final atomic command.

use cinatoken_auth::{ROLE_ROOT_USER, USER_STATUS_ENABLED};
use cinatoken_root_session_phase_proof::{
    RootSessionBeforeChallengeSubjectV1, RootSessionBeforeCommitSubjectV1,
    RootSessionBeforeIssuerSubjectV1, RootSessionPhase, RootSessionPhaseClaims,
    RootSessionPhaseKeySlot, RootSessionPhaseSubjectContext, RootSessionPhaseSubjectV1,
    VerifiedRootSessionPhaseProof,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::admin_passkey::{decode_stored_passkey_binary, passkey_credential_id_sha256};
use crate::container_drain_source_authorization::{
    VerifiedDrainSourceAuthorization, DRAIN_SOURCE_AUTHORIZATION_CONTRACT,
};
use crate::container_drain_source_registration_action::{
    DrainSourceRegistrationActionV1, DrainSourceRegistrationBeginIntentV1,
    DrainSourceRegistrationCeremonyState, DrainSourceRegistrationPermitIssueRequestV1,
    DrainSourceRegistrationStoredCredential, VerifiedDrainSourceRegistrationPasskeyProof,
};
use crate::container_drain_source_registration_permit::VerifiedDrainSourceRegistrationPermit;
use crate::d1_repositories::{
    RelayContainerDrainSourceAuthorizationRow, RelayContainerDrainSourceRegistrationFenceState,
    RelayContainerDrainSourceRegistrationHeadState,
    RelayContainerDrainSourceRegistrationLedgerHead,
    RelayContainerDrainSourceRegistrationPasskeyState,
    RelayContainerDrainSourceRegistrationPhaseSnapshot,
    RelayContainerDrainSourceRegistrationRootState,
    RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_MIGRATION,
    RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256, RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256,
};
use crate::webauthn::{self, StoredCredential};

const AUTHORITY_FINGERPRINT_DOMAIN: &[u8] =
    b"cinatoken-relay-container-drain-source-registration-authority-v1";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAXIMUM_RECEIPT_SEQUENCE: i64 = 1_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedDrainSourceRegistrationPasskey {
    pub(crate) row_id: i64,
    pub(crate) user_id: i64,
    pub(crate) credential_id: Vec<u8>,
    pub(crate) public_key_cose: Vec<u8>,
    pub(crate) credential_registration_id_sha256: String,
    pub(crate) credential_id_sha256: String,
    pub(crate) credential_binding_sha256: String,
    pub(crate) use_generation: i64,
    pub(crate) sign_count: u32,
    pub(crate) clone_warning: bool,
    pub(crate) backup_eligible: bool,
}

impl ValidatedDrainSourceRegistrationPasskey {
    pub(crate) fn stored_credential(&self) -> DrainSourceRegistrationStoredCredential<'_> {
        DrainSourceRegistrationStoredCredential {
            row_id: self.row_id,
            user_id: self.user_id,
            clone_warning: self.clone_warning,
            passkey_credential_registration_id_sha256: &self.credential_registration_id_sha256,
            passkey_credential_binding_sha256: &self.credential_binding_sha256,
            passkey_previous_use_generation: self.use_generation,
            credential: StoredCredential {
                credential_id: &self.credential_id,
                public_key_cose: &self.public_key_cose,
                sign_count: self.sign_count,
                backup_eligible: self.backup_eligible,
            },
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct DrainSourceRegistrationRootSessionAnchorV1 {
    root_admin_id: i64,
    root_role: i32,
    root_status: i32,
    root_deleted_at: Option<i64>,
    root_session_epoch: i64,
    root_session_issued_at: i64,
    root_session_expires_at: i64,
    root_session_binding_sha256: String,
    root_session_id_sha256: String,
}

impl DrainSourceRegistrationRootSessionAnchorV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        root_admin_id: i64,
        root_role: i32,
        root_status: i32,
        root_deleted_at: Option<i64>,
        root_session_epoch: i64,
        root_session_issued_at: i64,
        root_session_expires_at: i64,
        root_session_binding_sha256: impl Into<String>,
        root_session_id_sha256: impl Into<String>,
    ) -> Result<Self, DrainSourceRegistrationCoordinatorError> {
        let anchor = Self {
            root_admin_id,
            root_role,
            root_status,
            root_deleted_at,
            root_session_epoch,
            root_session_issued_at,
            root_session_expires_at,
            root_session_binding_sha256: root_session_binding_sha256.into(),
            root_session_id_sha256: root_session_id_sha256.into(),
        };
        anchor.validate()?;
        Ok(anchor)
    }

    pub(crate) fn root_admin_id(&self) -> i64 {
        self.root_admin_id
    }

    pub(crate) fn root_role(&self) -> i32 {
        self.root_role
    }

    pub(crate) fn root_status(&self) -> i32 {
        self.root_status
    }

    pub(crate) fn root_deleted_at(&self) -> Option<i64> {
        self.root_deleted_at
    }

    pub(crate) fn root_session_epoch(&self) -> i64 {
        self.root_session_epoch
    }

    pub(crate) fn root_session_issued_at(&self) -> i64 {
        self.root_session_issued_at
    }

    pub(crate) fn root_session_expires_at(&self) -> i64 {
        self.root_session_expires_at
    }

    pub(crate) fn root_session_binding_sha256(&self) -> &str {
        &self.root_session_binding_sha256
    }

    pub(crate) fn root_session_id_sha256(&self) -> &str {
        &self.root_session_id_sha256
    }

    fn from_claims(
        claims: &RootSessionPhaseClaims,
    ) -> Result<Self, DrainSourceRegistrationCoordinatorError> {
        Self::new(
            claims.root_admin_id,
            claims.root_role,
            claims.root_status,
            claims.root_deleted_at,
            claims.root_session_epoch,
            claims.root_session_issued_at,
            claims.root_session_expires_at,
            claims.root_session_binding_sha256.clone(),
            claims.root_session_id_sha256.clone(),
        )
    }

    fn validate(&self) -> Result<(), DrainSourceRegistrationCoordinatorError> {
        if self.root_admin_id <= 0
            || self.root_admin_id > MAXIMUM_SAFE_INTEGER
            || self.root_role != ROLE_ROOT_USER
            || self.root_status != USER_STATUS_ENABLED
            || self.root_deleted_at.is_some()
            || self.root_session_epoch < 0
            || self.root_session_epoch > MAXIMUM_SAFE_INTEGER
            || self.root_session_issued_at <= 0
            || self.root_session_issued_at > MAXIMUM_SAFE_INTEGER
            || self.root_session_expires_at <= self.root_session_issued_at
            || self.root_session_expires_at > MAXIMUM_SAFE_INTEGER
            || !valid_sha256(&self.root_session_binding_sha256)
            || !valid_sha256(&self.root_session_id_sha256)
            || self.root_session_binding_sha256 == self.root_session_id_sha256
        {
            return Err(DrainSourceRegistrationCoordinatorError::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct PreparedDrainSourceRegistrationChallengeAuthority {
    begin_intent: DrainSourceRegistrationBeginIntentV1,
    begin_intent_sha256: String,
    root_session: DrainSourceRegistrationRootSessionAnchorV1,
    semantic_fingerprint_sha256: String,
    authorization: VerifiedDrainSourceAuthorization,
    passkey: ValidatedDrainSourceRegistrationPasskey,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    database_now: i64,
}

impl PreparedDrainSourceRegistrationChallengeAuthority {
    pub(crate) fn begin_intent(&self) -> &DrainSourceRegistrationBeginIntentV1 {
        &self.begin_intent
    }

    pub(crate) fn root_session(&self) -> &DrainSourceRegistrationRootSessionAnchorV1 {
        &self.root_session
    }

    pub(crate) fn semantic_fingerprint_sha256(&self) -> &str {
        &self.semantic_fingerprint_sha256
    }

    pub(crate) fn authorization(&self) -> &VerifiedDrainSourceAuthorization {
        &self.authorization
    }

    pub(crate) fn passkey(&self) -> &ValidatedDrainSourceRegistrationPasskey {
        &self.passkey
    }

    pub(crate) fn receipt_sequence(&self) -> i64 {
        self.receipt_sequence
    }

    pub(crate) fn ledger_head_before_sha256(&self) -> &str {
        &self.ledger_head_before_sha256
    }

    pub(crate) fn database_now(&self) -> i64 {
        self.database_now
    }

    pub(crate) fn phase_subject(
        &self,
    ) -> Result<RootSessionPhaseSubjectV1<'_>, DrainSourceRegistrationCoordinatorError> {
        if self.begin_intent.sha256().ok().as_deref() != Some(&self.begin_intent_sha256) {
            return Err(DrainSourceRegistrationCoordinatorError::InvalidInput);
        }
        Ok(RootSessionPhaseSubjectV1::BeforeChallenge(
            RootSessionBeforeChallengeSubjectV1 {
                context: phase_subject_context(
                    &self.begin_intent,
                    &self.semantic_fingerprint_sha256,
                ),
                begin_intent_sha256: &self.begin_intent_sha256,
                authorization_subject_sha256: &self.authorization.authorization_subject_sha256,
                authorization_signature_envelope_sha256: &self
                    .authorization
                    .authorization_signature_envelope_sha256,
            },
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ValidatedDrainSourceRegistrationAuthorityPhase {
    phase: RootSessionPhase,
    semantic_fingerprint_sha256: String,
    parent_session_phase_proof_sha256: Option<String>,
    phase_binding_sha256: String,
    session_phase_proof_sha256: String,
    session_phase_proof_id_sha256: String,
    session_phase_proof_key_id: String,
    session_phase_proof_key_version: u32,
    session_phase_proof_key_slot: RootSessionPhaseKeySlot,
    authorization: VerifiedDrainSourceAuthorization,
    passkey: ValidatedDrainSourceRegistrationPasskey,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    database_now: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedDrainSourceRegistrationChallenge {
    authority: ValidatedDrainSourceRegistrationAuthorityPhase,
    begin_intent: DrainSourceRegistrationBeginIntentV1,
}

impl ValidatedDrainSourceRegistrationChallenge {
    pub(crate) fn begin_intent(&self) -> &DrainSourceRegistrationBeginIntentV1 {
        &self.begin_intent
    }

    pub(crate) fn authorization(&self) -> &VerifiedDrainSourceAuthorization {
        &self.authority.authorization
    }

    pub(crate) fn passkey(&self) -> &ValidatedDrainSourceRegistrationPasskey {
        &self.authority.passkey
    }

    pub(crate) fn receipt_sequence(&self) -> i64 {
        self.authority.receipt_sequence
    }

    pub(crate) fn ledger_head_before_sha256(&self) -> &str {
        &self.authority.ledger_head_before_sha256
    }

    pub(crate) fn database_now(&self) -> i64 {
        self.authority.database_now
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedDrainSourceRegistrationIssuer {
    authority: ValidatedDrainSourceRegistrationAuthorityPhase,
    begin_intent: DrainSourceRegistrationBeginIntentV1,
    ceremony: DrainSourceRegistrationCeremonyState,
    passkey_proof: VerifiedDrainSourceRegistrationPasskeyProof,
    issue_request: DrainSourceRegistrationPermitIssueRequestV1,
}

impl ValidatedDrainSourceRegistrationIssuer {
    pub(crate) fn issue_request(&self) -> &DrainSourceRegistrationPermitIssueRequestV1 {
        &self.issue_request
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedDrainSourceRegistrationCommit {
    authority: ValidatedDrainSourceRegistrationAuthorityPhase,
    begin_intent: DrainSourceRegistrationBeginIntentV1,
    action: DrainSourceRegistrationActionV1,
    passkey_proof: VerifiedDrainSourceRegistrationPasskeyProof,
    issue_request: DrainSourceRegistrationPermitIssueRequestV1,
    permit: VerifiedDrainSourceRegistrationPermit,
}

impl ValidatedDrainSourceRegistrationCommit {
    pub(crate) fn command_evidence(
        &self,
    ) -> (
        &DrainSourceRegistrationActionV1,
        &VerifiedDrainSourceRegistrationPasskeyProof,
        &VerifiedDrainSourceRegistrationPermit,
    ) {
        (&self.action, &self.passkey_proof, &self.permit)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DrainSourceRegistrationCoordinatorError {
    InvalidInput,
    UnsupportedEnvironment,
    AuthorizationStateChanged,
    RootStateChanged,
    SessionStateChanged,
    PasskeyStateChanged,
    FenceStateChanged,
    LedgerStateChanged,
    AuthorizationAlreadyConsumed,
    AuthorityExpired,
    AuthorityDrift,
    ActionMismatch,
    CeremonyMismatch,
    PhaseChainMismatch,
    PhaseBindingMismatch,
    PermitMismatch,
    PermitExpired,
}

impl DrainSourceRegistrationCoordinatorError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "drain_source_registration_coordinator_input_invalid",
            Self::UnsupportedEnvironment => "drain_source_registration_environment_unsupported",
            Self::AuthorizationStateChanged => "drain_source_registration_authorization_changed",
            Self::RootStateChanged => "drain_source_registration_root_changed",
            Self::SessionStateChanged => "drain_source_registration_session_changed",
            Self::PasskeyStateChanged => "drain_source_registration_passkey_changed",
            Self::FenceStateChanged => "drain_source_registration_fence_changed",
            Self::LedgerStateChanged => "drain_source_registration_ledger_changed",
            Self::AuthorizationAlreadyConsumed => {
                "drain_source_registration_authorization_consumed"
            }
            Self::AuthorityExpired => "drain_source_registration_authority_expired",
            Self::AuthorityDrift => "drain_source_registration_authority_drift",
            Self::ActionMismatch => "drain_source_registration_action_mismatch",
            Self::CeremonyMismatch => "drain_source_registration_ceremony_mismatch",
            Self::PhaseChainMismatch => "drain_source_registration_phase_chain_mismatch",
            Self::PhaseBindingMismatch => "drain_source_registration_phase_binding_mismatch",
            Self::PermitMismatch => "drain_source_registration_permit_mismatch",
            Self::PermitExpired => "drain_source_registration_permit_expired",
        }
    }
}

impl std::fmt::Display for DrainSourceRegistrationCoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DrainSourceRegistrationCoordinatorError {}

struct ValidatedDrainSourceRegistrationAuthoritySnapshot {
    semantic_fingerprint_sha256: String,
    authorization: VerifiedDrainSourceAuthorization,
    passkey: ValidatedDrainSourceRegistrationPasskey,
    receipt_sequence: i64,
    ledger_head_before_sha256: String,
    database_now: i64,
}

pub(crate) fn prepare_before_challenge_authority(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    root_session: &DrainSourceRegistrationRootSessionAnchorV1,
    begin_intent: &DrainSourceRegistrationBeginIntentV1,
) -> Result<
    PreparedDrainSourceRegistrationChallengeAuthority,
    DrainSourceRegistrationCoordinatorError,
> {
    begin_intent
        .validate()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::InvalidInput)?;
    root_session.validate()?;
    if begin_intent.environment() != "staging"
        || begin_intent.issued_at() != snapshot.database_now
        || begin_intent.authorization_id_sha256() != snapshot.authorization.authorization_id_sha256
    {
        return Err(DrainSourceRegistrationCoordinatorError::InvalidInput);
    }
    let begin_intent_sha256 = begin_intent
        .sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::InvalidInput)?;
    let authority = validate_authority_snapshot(
        snapshot,
        begin_intent.environment(),
        begin_intent.authorization_id_sha256(),
        root_session,
    )?;
    Ok(PreparedDrainSourceRegistrationChallengeAuthority {
        begin_intent: begin_intent.clone(),
        begin_intent_sha256,
        root_session: root_session.clone(),
        semantic_fingerprint_sha256: authority.semantic_fingerprint_sha256,
        authorization: authority.authorization,
        passkey: authority.passkey,
        receipt_sequence: authority.receipt_sequence,
        ledger_head_before_sha256: authority.ledger_head_before_sha256,
        database_now: authority.database_now,
    })
}

pub(crate) fn validate_before_challenge(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    session_proof: &VerifiedRootSessionPhaseProof,
    begin_intent: &DrainSourceRegistrationBeginIntentV1,
) -> Result<ValidatedDrainSourceRegistrationChallenge, DrainSourceRegistrationCoordinatorError> {
    let mut authority = validate_authority_phase(
        snapshot,
        session_proof,
        AuthorityPhaseEvidence::BeforeChallenge { begin_intent },
    )?;
    let begin_intent_sha256 = begin_intent
        .sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::InvalidInput)?;
    let phase_subject =
        RootSessionPhaseSubjectV1::BeforeChallenge(RootSessionBeforeChallengeSubjectV1 {
            context: phase_subject_context(begin_intent, &authority.semantic_fingerprint_sha256),
            begin_intent_sha256: &begin_intent_sha256,
            authorization_subject_sha256: &authority.authorization.authorization_subject_sha256,
            authorization_signature_envelope_sha256: &authority
                .authorization
                .authorization_signature_envelope_sha256,
        });
    authority.phase_binding_sha256 = validate_phase_binding(session_proof, phase_subject)?;
    Ok(ValidatedDrainSourceRegistrationChallenge {
        authority,
        begin_intent: begin_intent.clone(),
    })
}

pub(crate) fn validate_before_issuer(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    session_proof: &VerifiedRootSessionPhaseProof,
    challenge: &ValidatedDrainSourceRegistrationChallenge,
    ceremony: &DrainSourceRegistrationCeremonyState,
    passkey_proof: &VerifiedDrainSourceRegistrationPasskeyProof,
) -> Result<ValidatedDrainSourceRegistrationIssuer, DrainSourceRegistrationCoordinatorError> {
    if !challenge.begin_intent.matches_action(ceremony.action())
        || ceremony.rp_id() != challenge.begin_intent.rp_id()
        || ceremony.origin() != challenge.begin_intent.origin()
        || ceremony.issued_at() != challenge.begin_intent.issued_at()
    {
        return Err(DrainSourceRegistrationCoordinatorError::CeremonyMismatch);
    }
    let bindings = ceremony
        .registration_permit_bindings(passkey_proof)
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let issue_request = bindings
        .issue_request()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let mut authority = validate_authority_phase(
        snapshot,
        session_proof,
        AuthorityPhaseEvidence::BeforeIssuer {
            challenge,
            action: ceremony.action(),
        },
    )?;
    validate_passkey_proof_against_snapshot(passkey_proof, &authority)?;
    let challenge_sha256 = ceremony
        .secure_verification_challenge_sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let action_subject_sha256 = ceremony
        .action_subject_sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let issue_request_sha256 = issue_request
        .sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let phase_subject = RootSessionPhaseSubjectV1::BeforeIssuer(RootSessionBeforeIssuerSubjectV1 {
        context: phase_subject_context(
            &challenge.begin_intent,
            &authority.semantic_fingerprint_sha256,
        ),
        secure_verification_challenge_sha256: &challenge_sha256,
        action_subject_sha256: &action_subject_sha256,
        permit_issue_request_sha256: &issue_request_sha256,
    });
    authority.phase_binding_sha256 = validate_phase_binding(session_proof, phase_subject)?;
    Ok(ValidatedDrainSourceRegistrationIssuer {
        authority,
        begin_intent: challenge.begin_intent.clone(),
        ceremony: ceremony.clone(),
        passkey_proof: passkey_proof.clone(),
        issue_request,
    })
}

pub(crate) fn validate_before_commit(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    session_proof: &VerifiedRootSessionPhaseProof,
    issuer: &ValidatedDrainSourceRegistrationIssuer,
    permit: &VerifiedDrainSourceRegistrationPermit,
) -> Result<ValidatedDrainSourceRegistrationCommit, DrainSourceRegistrationCoordinatorError> {
    permit
        .validate_issue_request(&issuer.issue_request)
        .map_err(|_| DrainSourceRegistrationCoordinatorError::PermitMismatch)?;
    permit
        .validate_at(snapshot.database_now)
        .map_err(|_| DrainSourceRegistrationCoordinatorError::PermitExpired)?;
    let mut authority = validate_authority_phase(
        snapshot,
        session_proof,
        AuthorityPhaseEvidence::BeforeCommit { issuer },
    )?;
    validate_passkey_proof_against_snapshot(&issuer.passkey_proof, &authority)?;
    if session_proof.claims().authority_expires_at > permit.writer_projection().expires_at() {
        return Err(DrainSourceRegistrationCoordinatorError::PermitExpired);
    }
    let action_subject_sha256 = issuer
        .ceremony
        .action_subject_sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::CeremonyMismatch)?;
    let issuer_request_sha256 = issuer
        .issue_request
        .sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::PermitMismatch)?;
    let authenticated_issuer_request_id_sha256 = permit
        .authenticated_request_id_sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::PermitMismatch)?;
    let phase_subject = RootSessionPhaseSubjectV1::BeforeCommit(RootSessionBeforeCommitSubjectV1 {
        context: phase_subject_context(
            &issuer.begin_intent,
            &authority.semantic_fingerprint_sha256,
        ),
        action_subject_sha256: &action_subject_sha256,
        issuer_request_sha256: &issuer_request_sha256,
        authenticated_issuer_request_id_sha256: &authenticated_issuer_request_id_sha256,
        issuer_version_id: permit.issuer_version_id(),
        permit_id_sha256: permit.permit_id_sha256(),
        permit_subject_sha256: permit.subject_sha256(),
        permit_signature_envelope_sha256: permit.signature_envelope_sha256(),
    });
    authority.phase_binding_sha256 = validate_phase_binding(session_proof, phase_subject)?;
    Ok(ValidatedDrainSourceRegistrationCommit {
        authority,
        begin_intent: issuer.begin_intent.clone(),
        action: issuer.ceremony.action().clone(),
        passkey_proof: issuer.passkey_proof.clone(),
        issue_request: issuer.issue_request.clone(),
        permit: permit.clone(),
    })
}

enum AuthorityPhaseEvidence<'a> {
    BeforeChallenge {
        begin_intent: &'a DrainSourceRegistrationBeginIntentV1,
    },
    BeforeIssuer {
        challenge: &'a ValidatedDrainSourceRegistrationChallenge,
        action: &'a DrainSourceRegistrationActionV1,
    },
    BeforeCommit {
        issuer: &'a ValidatedDrainSourceRegistrationIssuer,
    },
}

impl AuthorityPhaseEvidence<'_> {
    fn phase(&self) -> RootSessionPhase {
        match self {
            Self::BeforeChallenge { .. } => RootSessionPhase::BeforeChallenge,
            Self::BeforeIssuer { .. } => RootSessionPhase::BeforeIssuer,
            Self::BeforeCommit { .. } => RootSessionPhase::BeforeCommit,
        }
    }

    fn begin_intent(&self) -> &DrainSourceRegistrationBeginIntentV1 {
        match self {
            Self::BeforeChallenge { begin_intent } => begin_intent,
            Self::BeforeIssuer { challenge, .. } => &challenge.begin_intent,
            Self::BeforeCommit { issuer } => &issuer.begin_intent,
        }
    }

    fn expected_parent_proof_sha256(&self) -> Option<&str> {
        match self {
            Self::BeforeChallenge { .. } => None,
            Self::BeforeIssuer { challenge, .. } => {
                Some(&challenge.authority.session_phase_proof_sha256)
            }
            Self::BeforeCommit { issuer } => Some(&issuer.authority.session_phase_proof_sha256),
        }
    }

    fn expected_semantic_fingerprint_sha256(&self) -> Option<&str> {
        match self {
            Self::BeforeChallenge { .. } => None,
            Self::BeforeIssuer { challenge, .. } => {
                Some(&challenge.authority.semantic_fingerprint_sha256)
            }
            Self::BeforeCommit { issuer } => Some(&issuer.authority.semantic_fingerprint_sha256),
        }
    }

    fn action(&self) -> Option<&DrainSourceRegistrationActionV1> {
        match self {
            Self::BeforeChallenge { .. } => None,
            Self::BeforeIssuer { action, .. } => Some(action),
            Self::BeforeCommit { issuer } => Some(issuer.ceremony.action()),
        }
    }
}

fn validate_authority_phase(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    session_proof: &VerifiedRootSessionPhaseProof,
    evidence: AuthorityPhaseEvidence<'_>,
) -> Result<ValidatedDrainSourceRegistrationAuthorityPhase, DrainSourceRegistrationCoordinatorError>
{
    let begin_intent = evidence.begin_intent();
    let expected_environment = begin_intent.environment();
    let expected_authorization_id_sha256 = begin_intent.authorization_id_sha256();
    let session = session_proof.claims();
    let expected_proof_phase = evidence.phase();
    if expected_environment != "staging"
        || snapshot.authorization.environment == "production"
        || expected_authorization_id_sha256 != expected_authorization_id_sha256.trim()
        || !valid_sha256(expected_authorization_id_sha256)
        || session.environment != expected_environment
        || session.authorization_id_sha256 != expected_authorization_id_sha256
        || session.phase != expected_proof_phase
        || session.operation_id_sha256 != begin_intent.operation_id_sha256()
        || session.ceremony_id_sha256 != begin_intent.ceremony_id_sha256()
        || session.request_intent_sha256 != begin_intent.request_intent_sha256()
        || !valid_sha256(&session.root_session_binding_sha256)
        || !valid_sha256(&session.root_session_id_sha256)
        || !valid_sha256(&session.operation_id_sha256)
        || !valid_sha256(&session.ceremony_id_sha256)
        || !valid_sha256(&session.request_intent_sha256)
        || !valid_sha256(&session.phase_binding_sha256)
        || !valid_sha256(&session.semantic_authority_fingerprint_sha256)
        || session.root_admin_id <= 0
        || session.root_admin_id > MAXIMUM_SAFE_INTEGER
        || session.root_role != ROLE_ROOT_USER
        || session.root_status != USER_STATUS_ENABLED
        || session.root_deleted_at.is_some()
        || session.root_session_epoch < 0
        || session.root_session_epoch > MAXIMUM_SAFE_INTEGER
        || session.root_session_issued_at <= 0
        || session.root_session_issued_at > MAXIMUM_SAFE_INTEGER
        || session.root_session_expires_at <= session.root_session_issued_at
        || session.root_session_expires_at > MAXIMUM_SAFE_INTEGER
        || session.d1_observed_at != session.issued_at
        || session.d1_observed_at != snapshot.database_now
        || session.not_before != session.issued_at
        || session.authority_expires_at <= session.d1_observed_at
        || begin_intent.issued_at() > snapshot.database_now
        || expected_proof_phase == RootSessionPhase::BeforeChallenge
            && begin_intent.issued_at() != snapshot.database_now
    {
        return Err(
            if expected_environment != "staging"
                || snapshot.authorization.environment == "production"
            {
                DrainSourceRegistrationCoordinatorError::UnsupportedEnvironment
            } else {
                DrainSourceRegistrationCoordinatorError::InvalidInput
            },
        );
    }
    if session.parent_proof_sha256.as_deref() != evidence.expected_parent_proof_sha256() {
        return Err(DrainSourceRegistrationCoordinatorError::PhaseChainMismatch);
    }
    if snapshot.database_now < session.issued_at || snapshot.database_now >= session.expires_at {
        return Err(DrainSourceRegistrationCoordinatorError::SessionStateChanged);
    }
    let root_session = DrainSourceRegistrationRootSessionAnchorV1::from_claims(session)?;
    let authority_snapshot = validate_authority_snapshot(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
        &root_session,
    )?;
    if evidence
        .expected_semantic_fingerprint_sha256()
        .is_some_and(|expected| expected != authority_snapshot.semantic_fingerprint_sha256)
        || session.semantic_authority_fingerprint_sha256
            != authority_snapshot.semantic_fingerprint_sha256
    {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorityDrift);
    }
    if session.authority_expires_at > authority_snapshot.authorization.permit_expires_at {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorityExpired);
    }

    if let Some(action) = evidence.action() {
        validate_action(
            action,
            &authority_snapshot.authorization,
            session,
            &authority_snapshot.passkey,
            authority_snapshot.receipt_sequence,
            &authority_snapshot.ledger_head_before_sha256,
            snapshot.database_now,
        )?;
    }

    Ok(ValidatedDrainSourceRegistrationAuthorityPhase {
        phase: expected_proof_phase,
        semantic_fingerprint_sha256: authority_snapshot.semantic_fingerprint_sha256,
        parent_session_phase_proof_sha256: session.parent_proof_sha256.clone(),
        phase_binding_sha256: String::new(),
        session_phase_proof_sha256: session_proof.token_sha256().to_owned(),
        session_phase_proof_id_sha256: session.proof_id_sha256.clone(),
        session_phase_proof_key_id: session_proof.protected().kid.clone(),
        session_phase_proof_key_version: session_proof.protected().key_version,
        session_phase_proof_key_slot: session_proof.key_slot(),
        authorization: authority_snapshot.authorization,
        passkey: authority_snapshot.passkey,
        receipt_sequence: authority_snapshot.receipt_sequence,
        ledger_head_before_sha256: authority_snapshot.ledger_head_before_sha256,
        database_now: authority_snapshot.database_now,
    })
}

fn validate_authority_snapshot(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
    root_session: &DrainSourceRegistrationRootSessionAnchorV1,
) -> Result<
    ValidatedDrainSourceRegistrationAuthoritySnapshot,
    DrainSourceRegistrationCoordinatorError,
> {
    root_session.validate()?;
    if expected_environment != "staging"
        || snapshot.authorization.environment == "production"
        || expected_authorization_id_sha256 != expected_authorization_id_sha256.trim()
        || !valid_sha256(expected_authorization_id_sha256)
    {
        return Err(
            if expected_environment != "staging"
                || snapshot.authorization.environment == "production"
            {
                DrainSourceRegistrationCoordinatorError::UnsupportedEnvironment
            } else {
                DrainSourceRegistrationCoordinatorError::InvalidInput
            },
        );
    }
    let authorization = validate_authorization(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
    )?;
    let root = validate_root(snapshot.root.as_ref(), &authorization, root_session)?;
    validate_session_anchor(snapshot.database_now, root_session, root)?;
    let passkey = validate_passkey(snapshot.passkey.as_ref(), root)?;
    let (head, fence) = validate_fence(
        snapshot.head.as_ref(),
        snapshot.fence.as_ref(),
        &authorization,
    )?;
    let (receipt_sequence, ledger_head_before_sha256) =
        validate_consumption_and_ledger(snapshot, &authorization)?;
    if snapshot.database_now < snapshot.authorization.recorded_at
        || snapshot.database_now >= authorization.permit_expires_at
    {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorityExpired);
    }
    let semantic_fingerprint_sha256 = semantic_fingerprint(
        snapshot,
        root,
        snapshot
            .passkey
            .as_ref()
            .expect("validated Passkey must remain present"),
        head,
        fence,
        receipt_sequence,
        &ledger_head_before_sha256,
    )?;
    Ok(ValidatedDrainSourceRegistrationAuthoritySnapshot {
        semantic_fingerprint_sha256,
        authorization,
        passkey,
        receipt_sequence,
        ledger_head_before_sha256,
        database_now: snapshot.database_now,
    })
}

fn phase_subject_context<'a>(
    begin_intent: &'a DrainSourceRegistrationBeginIntentV1,
    semantic_authority_fingerprint_sha256: &'a str,
) -> RootSessionPhaseSubjectContext<'a> {
    RootSessionPhaseSubjectContext {
        environment: begin_intent.environment(),
        operation_id_sha256: begin_intent.operation_id_sha256(),
        authorization_id_sha256: begin_intent.authorization_id_sha256(),
        ceremony_id_sha256: begin_intent.ceremony_id_sha256(),
        request_intent_sha256: begin_intent.request_intent_sha256(),
        semantic_authority_fingerprint_sha256,
    }
}

fn validate_phase_binding(
    session_proof: &VerifiedRootSessionPhaseProof,
    phase_subject: RootSessionPhaseSubjectV1<'_>,
) -> Result<String, DrainSourceRegistrationCoordinatorError> {
    let phase_binding_sha256 = phase_subject
        .phase_binding_sha256()
        .map_err(|_| DrainSourceRegistrationCoordinatorError::InvalidInput)?;
    if session_proof.claims().phase_binding_sha256 != phase_binding_sha256 {
        return Err(DrainSourceRegistrationCoordinatorError::PhaseBindingMismatch);
    }
    Ok(phase_binding_sha256)
}

fn validate_passkey_proof_against_snapshot(
    proof: &VerifiedDrainSourceRegistrationPasskeyProof,
    authority: &ValidatedDrainSourceRegistrationAuthorityPhase,
) -> Result<(), DrainSourceRegistrationCoordinatorError> {
    let projection = proof.writer_projection();
    if projection.passkey_credential_row_id() != authority.passkey.row_id
        || projection.passkey_credential_id_sha256() != authority.passkey.credential_id_sha256
        || projection.passkey_credential_registration_id_sha256()
            != authority.passkey.credential_registration_id_sha256
        || projection.passkey_credential_binding_sha256()
            != authority.passkey.credential_binding_sha256
        || projection.passkey_previous_use_generation() != authority.passkey.use_generation
        || projection.previous_sign_count() != authority.passkey.sign_count
        || projection.backup_eligible() != authority.passkey.backup_eligible
        || projection.verified_at() > authority.database_now
    {
        return Err(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged);
    }
    Ok(())
}

fn validate_authorization(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
) -> Result<VerifiedDrainSourceAuthorization, DrainSourceRegistrationCoordinatorError> {
    let row = &snapshot.authorization;
    let lifetime = row.permit_expires_at.checked_sub(row.permit_issued_at);
    if row.authorization_id_sha256 != expected_authorization_id_sha256
        || row.environment != expected_environment
        || row.contract_version != 1
        || row.authorization_contract != DRAIN_SOURCE_AUTHORIZATION_CONTRACT
        || row.authorization_migration != RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_MIGRATION
        || row.scope_kind != "global"
        || row.scope_id_sha256 != RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256
        || row.fence_generation != 1
        || row.expected_head_version != 1
        || row.accepted_source_schema_sha256 != RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
        || !(1..=512).contains(&row.page_size)
        || !(1..=1_024).contains(&row.shard_count)
        || row.authorized_by_admin_id <= 0
        || row.authorized_by_admin_id > MAXIMUM_SAFE_INTEGER
        || row.permit_issued_at <= 0
        || row.recorded_at < row.permit_issued_at
        || row.recorded_at >= row.permit_expires_at
        || !matches!(lifetime, Some(60..=900))
        || !valid_service_token(&row.collector_service_name)
        || !valid_service_token(&row.collector_version_id)
        || !valid_service_token(&row.authorizer_issuer)
        || !valid_service_token(&row.authorizer_key_id)
        || row.authorizer_identity_sha256 == row.authorizer_spki_sha256
        || row.authorization_subject_sha256 == row.authorization_signature_envelope_sha256
    {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorizationStateChanged);
    }
    for digest in [
        &row.authorization_id_sha256,
        &row.scope_id_sha256,
        &row.admission_fence_id_sha256,
        &row.expected_fence_state_digest_sha256,
        &row.expected_head_digest_sha256,
        &row.source_scan_id_sha256,
        &row.collector_run_id_sha256,
        &row.started_by_credential_id_sha256,
        &row.accepted_source_schema_sha256,
        &row.authorizer_identity_sha256,
        &row.authorizer_spki_sha256,
        &row.authorization_subject_sha256,
        &row.authorization_signature_envelope_sha256,
        &row.execution_nonce_sha256,
        &snapshot.read_bookmark_sha256,
    ] {
        if !valid_sha256(digest) {
            return Err(DrainSourceRegistrationCoordinatorError::AuthorizationStateChanged);
        }
    }

    Ok(VerifiedDrainSourceAuthorization {
        contract_version: u32::try_from(row.contract_version)
            .map_err(|_| DrainSourceRegistrationCoordinatorError::AuthorizationStateChanged)?,
        authorization_contract: row.authorization_contract.clone(),
        environment: row.environment.clone(),
        authorization_id_sha256: row.authorization_id_sha256.clone(),
        scope_kind: row.scope_kind.clone(),
        scope_id_sha256: row.scope_id_sha256.clone(),
        admission_fence_id_sha256: row.admission_fence_id_sha256.clone(),
        fence_generation: row.fence_generation,
        expected_fence_state_digest_sha256: row.expected_fence_state_digest_sha256.clone(),
        expected_head_version: row.expected_head_version,
        expected_head_digest_sha256: row.expected_head_digest_sha256.clone(),
        source_scan_id_sha256: row.source_scan_id_sha256.clone(),
        collector_service_name: row.collector_service_name.clone(),
        collector_version_id: row.collector_version_id.clone(),
        collector_run_id_sha256: row.collector_run_id_sha256.clone(),
        started_by_credential_id_sha256: row.started_by_credential_id_sha256.clone(),
        page_size: u16::try_from(row.page_size)
            .map_err(|_| DrainSourceRegistrationCoordinatorError::AuthorizationStateChanged)?,
        shard_count: u16::try_from(row.shard_count)
            .map_err(|_| DrainSourceRegistrationCoordinatorError::AuthorizationStateChanged)?,
        accepted_source_schema_sha256: row.accepted_source_schema_sha256.clone(),
        authorizer_issuer: row.authorizer_issuer.clone(),
        authorizer_key_id: row.authorizer_key_id.clone(),
        authorizer_identity_sha256: row.authorizer_identity_sha256.clone(),
        authorizer_spki_sha256: row.authorizer_spki_sha256.clone(),
        authorization_subject_sha256: row.authorization_subject_sha256.clone(),
        authorization_signature_envelope_sha256: row
            .authorization_signature_envelope_sha256
            .clone(),
        execution_nonce_sha256: row.execution_nonce_sha256.clone(),
        permit_issued_at: row.permit_issued_at,
        permit_expires_at: row.permit_expires_at,
        authorized_by_admin_id: row.authorized_by_admin_id,
    })
}

fn validate_root<'a>(
    root: Option<&'a RelayContainerDrainSourceRegistrationRootState>,
    authorization: &VerifiedDrainSourceAuthorization,
    session: &DrainSourceRegistrationRootSessionAnchorV1,
) -> Result<
    &'a RelayContainerDrainSourceRegistrationRootState,
    DrainSourceRegistrationCoordinatorError,
> {
    let root = root.ok_or(DrainSourceRegistrationCoordinatorError::RootStateChanged)?;
    if root.id != session.root_admin_id
        || root.id != authorization.authorized_by_admin_id
        || root.role != i64::from(ROLE_ROOT_USER)
        || i64::from(session.root_role) != root.role
        || root.status != i64::from(USER_STATUS_ENABLED)
        || i64::from(session.root_status) != root.status
        || root.deleted_at.is_some()
        || session.root_deleted_at != root.deleted_at
        || root.session_epoch < 0
        || root.session_epoch > MAXIMUM_SAFE_INTEGER
    {
        return Err(DrainSourceRegistrationCoordinatorError::RootStateChanged);
    }
    Ok(root)
}

fn validate_session_anchor(
    database_now: i64,
    session: &DrainSourceRegistrationRootSessionAnchorV1,
    root: &RelayContainerDrainSourceRegistrationRootState,
) -> Result<(), DrainSourceRegistrationCoordinatorError> {
    if root.session_epoch != session.root_session_epoch
        || database_now < session.root_session_issued_at
        || database_now >= session.root_session_expires_at
    {
        return Err(DrainSourceRegistrationCoordinatorError::SessionStateChanged);
    }
    Ok(())
}

fn validate_passkey(
    passkey: Option<&RelayContainerDrainSourceRegistrationPasskeyState>,
    root: &RelayContainerDrainSourceRegistrationRootState,
) -> Result<ValidatedDrainSourceRegistrationPasskey, DrainSourceRegistrationCoordinatorError> {
    let passkey = passkey.ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let credential_registration_id_sha256 = passkey
        .credential_registration_id_sha256
        .as_ref()
        .filter(|value| valid_sha256(value))
        .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let credential_id_sha256 = passkey
        .credential_id_sha256
        .as_ref()
        .filter(|value| valid_sha256(value))
        .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let credential_binding_sha256 = passkey
        .credential_binding_sha256
        .as_ref()
        .filter(|value| valid_sha256(value))
        .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let credential_id =
        decode_stored_passkey_binary(&passkey.credential_id, webauthn::MAX_CREDENTIAL_ID_BYTES)
            .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let public_key_cose =
        decode_stored_passkey_binary(&passkey.public_key, webauthn::MAX_COSE_KEY_BYTES)
            .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let sign_count = u32::try_from(passkey.sign_count)
        .map_err(|_| DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let clone_warning = stored_bool(passkey.clone_warning)
        .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    let backup_eligible = stored_bool(passkey.backup_eligible)
        .ok_or(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)?;
    if passkey.id <= 0
        || passkey.id > MAXIMUM_SAFE_INTEGER
        || passkey.user_id != root.id
        || passkey.deleted_at.is_some()
        || clone_warning
        || passkey.credential_use_generation < 0
        || passkey.credential_use_generation >= MAXIMUM_SAFE_INTEGER
        || passkey.updated_at < 0
        || stored_bool(passkey.user_present).is_none()
        || stored_bool(passkey.user_verified).is_none()
        || stored_bool(passkey.backup_state).is_none()
        || credential_id_sha256 != &passkey_credential_id_sha256(&credential_id)
        || credential_registration_id_sha256 == credential_id_sha256
        || credential_registration_id_sha256 == credential_binding_sha256
        || credential_id_sha256 == credential_binding_sha256
    {
        return Err(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged);
    }

    Ok(ValidatedDrainSourceRegistrationPasskey {
        row_id: passkey.id,
        user_id: passkey.user_id,
        credential_id,
        public_key_cose,
        credential_registration_id_sha256: credential_registration_id_sha256.clone(),
        credential_id_sha256: credential_id_sha256.clone(),
        credential_binding_sha256: credential_binding_sha256.clone(),
        use_generation: passkey.credential_use_generation,
        sign_count,
        clone_warning,
        backup_eligible,
    })
}

fn validate_fence<'a>(
    head: Option<&'a RelayContainerDrainSourceRegistrationHeadState>,
    fence: Option<&'a RelayContainerDrainSourceRegistrationFenceState>,
    authorization: &VerifiedDrainSourceAuthorization,
) -> Result<
    (
        &'a RelayContainerDrainSourceRegistrationHeadState,
        &'a RelayContainerDrainSourceRegistrationFenceState,
    ),
    DrainSourceRegistrationCoordinatorError,
> {
    let head = head.ok_or(DrainSourceRegistrationCoordinatorError::FenceStateChanged)?;
    let fence = fence.ok_or(DrainSourceRegistrationCoordinatorError::FenceStateChanged)?;
    if head.environment != authorization.environment
        || head.scope_kind != authorization.scope_kind
        || head.scope_id_sha256 != authorization.scope_id_sha256
        || head.current_fence_id_sha256 != authorization.admission_fence_id_sha256
        || head.current_fence_generation != authorization.fence_generation
        || head.head_version != authorization.expected_head_version
        || head.head_digest_sha256 != authorization.expected_head_digest_sha256
        || fence.admission_fence_id_sha256 != head.current_fence_id_sha256
        || fence.fence_kind != "admission"
        || fence.environment != head.environment
        || fence.scope_kind != head.scope_kind
        || fence.scope_id_sha256 != head.scope_id_sha256
        || fence.fence_generation != head.current_fence_generation
        || fence.admission_open != 1
        || fence.state_digest_sha256 != authorization.expected_fence_state_digest_sha256
        || fence.closed_at.is_some()
        || !valid_sha256(&head.scope_id_sha256)
        || !valid_sha256(&head.current_fence_id_sha256)
        || !valid_sha256(&head.head_digest_sha256)
        || !valid_sha256(&fence.state_digest_sha256)
    {
        return Err(DrainSourceRegistrationCoordinatorError::FenceStateChanged);
    }
    Ok((head, fence))
}

fn validate_consumption_and_ledger(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    authorization: &VerifiedDrainSourceAuthorization,
) -> Result<(i64, String), DrainSourceRegistrationCoordinatorError> {
    if [
        snapshot.registration_command_count,
        snapshot.registration_count,
        snapshot.claim_count,
        snapshot.terminal_count,
        snapshot.source_scan_count,
    ]
    .into_iter()
    .any(|count| count != 0)
    {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorizationAlreadyConsumed);
    }
    if snapshot.ledger_count < 0 {
        return Err(DrainSourceRegistrationCoordinatorError::LedgerStateChanged);
    }
    match (snapshot.ledger_count, snapshot.latest_ledger.as_ref()) {
        (0, None) => Ok((1, authorization.expected_head_digest_sha256.clone())),
        (count, Some(latest))
            if count == latest.receipt_sequence
                && latest.receipt_sequence > 0
                && latest.receipt_sequence < MAXIMUM_RECEIPT_SEQUENCE
                && latest.authority_ledger_identity_sha256 == authorization.scope_id_sha256
                && latest.event_kind == "terminal"
                && latest.authorization_id_sha256 != authorization.authorization_id_sha256
                && latest.recorded_at > 0
                && latest.recorded_at <= snapshot.database_now
                && valid_sha256(&latest.authority_ledger_identity_sha256)
                && valid_sha256(&latest.authorization_id_sha256)
                && valid_sha256(&latest.predecessor_receipt_sha256)
                && valid_sha256(&latest.receipt_digest_sha256) =>
        {
            Ok((
                latest.receipt_sequence + 1,
                latest.receipt_digest_sha256.clone(),
            ))
        }
        _ => Err(DrainSourceRegistrationCoordinatorError::LedgerStateChanged),
    }
}

#[derive(Serialize)]
struct SemanticAuthoritySnapshot<'a> {
    authorization: &'a RelayContainerDrainSourceAuthorizationRow,
    root: &'a RelayContainerDrainSourceRegistrationRootState,
    passkey: &'a RelayContainerDrainSourceRegistrationPasskeyState,
    head: &'a RelayContainerDrainSourceRegistrationHeadState,
    fence: &'a RelayContainerDrainSourceRegistrationFenceState,
    latest_ledger: Option<&'a RelayContainerDrainSourceRegistrationLedgerHead>,
    ledger_count: i64,
    registration_command_count: i64,
    registration_count: i64,
    claim_count: i64,
    terminal_count: i64,
    source_scan_count: i64,
    receipt_sequence: i64,
    ledger_head_before_sha256: &'a str,
}

#[allow(clippy::too_many_arguments)]
fn semantic_fingerprint(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    root: &RelayContainerDrainSourceRegistrationRootState,
    passkey: &RelayContainerDrainSourceRegistrationPasskeyState,
    head: &RelayContainerDrainSourceRegistrationHeadState,
    fence: &RelayContainerDrainSourceRegistrationFenceState,
    receipt_sequence: i64,
    ledger_head_before_sha256: &str,
) -> Result<String, DrainSourceRegistrationCoordinatorError> {
    let canonical = serde_json::to_vec(&SemanticAuthoritySnapshot {
        authorization: &snapshot.authorization,
        root,
        passkey,
        head,
        fence,
        latest_ledger: snapshot.latest_ledger.as_ref(),
        ledger_count: snapshot.ledger_count,
        registration_command_count: snapshot.registration_command_count,
        registration_count: snapshot.registration_count,
        claim_count: snapshot.claim_count,
        terminal_count: snapshot.terminal_count,
        source_scan_count: snapshot.source_scan_count,
        receipt_sequence,
        ledger_head_before_sha256,
    })
    .map_err(|_| DrainSourceRegistrationCoordinatorError::InvalidInput)?;
    let mut hasher = Sha256::new();
    hasher.update(AUTHORITY_FINGERPRINT_DOMAIN);
    hasher.update((canonical.len() as u64).to_be_bytes());
    hasher.update(canonical);
    Ok(format!("{:x}", hasher.finalize()))
}

#[allow(clippy::too_many_arguments)]
fn validate_action(
    action: &DrainSourceRegistrationActionV1,
    authorization: &VerifiedDrainSourceAuthorization,
    session: &RootSessionPhaseClaims,
    passkey: &ValidatedDrainSourceRegistrationPasskey,
    receipt_sequence: i64,
    ledger_head_before_sha256: &str,
    database_now: i64,
) -> Result<(), DrainSourceRegistrationCoordinatorError> {
    let action = action.writer_projection();
    if action.authorization_contract_version() != authorization.contract_version
        || action.authorization_contract() != authorization.authorization_contract
        || action.environment() != authorization.environment
        || action.authorization_id_sha256() != authorization.authorization_id_sha256
        || action.admission_fence_id_sha256() != authorization.admission_fence_id_sha256
        || action.fence_generation() != authorization.fence_generation
        || action.expected_fence_state_digest_sha256()
            != authorization.expected_fence_state_digest_sha256
        || action.expected_head_version() != authorization.expected_head_version
        || action.expected_head_digest_sha256() != authorization.expected_head_digest_sha256
        || action.scope_kind() != authorization.scope_kind
        || action.scope_id_sha256() != authorization.scope_id_sha256
        || action.source_scan_id_sha256() != authorization.source_scan_id_sha256
        || action.collector_service_name() != authorization.collector_service_name
        || action.collector_version_id() != authorization.collector_version_id
        || action.collector_run_id_sha256() != authorization.collector_run_id_sha256
        || action.started_by_credential_id_sha256() != authorization.started_by_credential_id_sha256
        || action.page_size() != authorization.page_size
        || action.shard_count() != authorization.shard_count
        || action.accepted_source_schema_sha256() != authorization.accepted_source_schema_sha256
        || action.authorizer_issuer() != authorization.authorizer_issuer
        || action.authorizer_key_id() != authorization.authorizer_key_id
        || action.authorizer_identity_sha256() != authorization.authorizer_identity_sha256
        || action.authorizer_spki_sha256() != authorization.authorizer_spki_sha256
        || action.authorization_subject_sha256() != authorization.authorization_subject_sha256
        || action.authorization_signature_envelope_sha256()
            != authorization.authorization_signature_envelope_sha256
        || action.execution_nonce_sha256() != authorization.execution_nonce_sha256
        || action.permit_issued_at() != authorization.permit_issued_at
        || action.permit_expires_at() != authorization.permit_expires_at
        || action.authorized_by_admin_id() != authorization.authorized_by_admin_id
        || action.authority_ledger_identity_sha256() != authorization.scope_id_sha256
        || action.receipt_sequence() != receipt_sequence
        || action.ledger_head_before_sha256() != ledger_head_before_sha256
        || action.root_admin_id() != session.root_admin_id
        || action.root_session_epoch() != session.root_session_epoch
        || action.root_session_issued_at() != session.root_session_issued_at
        || action.root_session_expires_at() != session.root_session_expires_at
        || action.root_session_binding_sha256() != session.root_session_binding_sha256
        || action.passkey_credential_row_id() != passkey.row_id
        || action.passkey_credential_id_sha256() != passkey.credential_id_sha256
        || action.passkey_credential_registration_id_sha256()
            != passkey.credential_registration_id_sha256
        || action.passkey_credential_binding_sha256() != passkey.credential_binding_sha256
        || action.passkey_previous_use_generation() != passkey.use_generation
        || database_now >= action.verification_expires_at()
        || action.verification_expires_at() > authorization.permit_expires_at
        || action.verification_expires_at() > session.root_session_expires_at
        || session.authority_expires_at > action.verification_expires_at()
    {
        return Err(DrainSourceRegistrationCoordinatorError::ActionMismatch);
    }
    Ok(())
}

fn stored_bool(value: i64) -> Option<bool> {
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_service_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use cinatoken_root_session_phase_proof::{
        sign_root_session_phase_proof, verify_root_session_phase_proof,
        RootSessionAnchorExpectation, RootSessionPhaseExpectation, RootSessionPhaseInput,
        RootSessionPhaseKey, RootSessionPhaseKeyRing, STAGING_ENVIRONMENT,
    };

    use super::*;
    use crate::container_drain_source_registration_action::{
        AdminNetworkIdentityHmacSha256, DrainSourceRegistrationActionInput,
        DrainSourceRegistrationBeginIntentInput, DrainSourceRegistrationPermitBindings,
    };
    use crate::container_drain_source_registration_command::VerifiedDrainSourceRegistrationCommand;

    const NOW: i64 = 2_100_000_000;
    const PHASE_PROOF_SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn digest(label: &str) -> String {
        format!("{:x}", Sha256::digest(label.as_bytes()))
    }

    #[derive(Clone)]
    struct TestSession {
        root_admin_id: i64,
        session_epoch: i64,
        issued_at: i64,
        expires_at: i64,
        binding_sha256: String,
        session_id_sha256: String,
    }

    fn session() -> TestSession {
        TestSession {
            root_admin_id: 1,
            session_epoch: 7,
            issued_at: NOW - 60,
            expires_at: NOW + 600,
            binding_sha256: digest("session-binding"),
            session_id_sha256: digest("session-id"),
        }
    }

    fn root_session_anchor() -> DrainSourceRegistrationRootSessionAnchorV1 {
        let session = session();
        DrainSourceRegistrationRootSessionAnchorV1::new(
            session.root_admin_id,
            ROLE_ROOT_USER,
            USER_STATUS_ENABLED,
            None,
            session.session_epoch,
            session.issued_at,
            session.expires_at,
            session.binding_sha256,
            session.session_id_sha256,
        )
        .unwrap()
    }

    fn snapshot() -> RelayContainerDrainSourceRegistrationPhaseSnapshot {
        let credential_id = b"credential-id";
        RelayContainerDrainSourceRegistrationPhaseSnapshot {
            authorization: RelayContainerDrainSourceAuthorizationRow {
                authorization_id_sha256: digest("authorization"),
                contract_version: 1,
                authorization_contract: DRAIN_SOURCE_AUTHORIZATION_CONTRACT.to_owned(),
                authorization_migration: RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_MIGRATION
                    .to_owned(),
                environment: "staging".to_owned(),
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
                accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
                    .to_owned(),
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
                recorded_at: NOW - 9,
            },
            root: Some(RelayContainerDrainSourceRegistrationRootState {
                id: 1,
                role: i64::from(ROLE_ROOT_USER),
                status: i64::from(USER_STATUS_ENABLED),
                session_epoch: 7,
                deleted_at: None,
            }),
            passkey: Some(RelayContainerDrainSourceRegistrationPasskeyState {
                id: 11,
                user_id: 1,
                credential_id: STANDARD.encode(credential_id),
                public_key: STANDARD.encode(b"cose-public-key"),
                credential_registration_id_sha256: Some(digest("credential-registration")),
                credential_id_sha256: Some(passkey_credential_id_sha256(credential_id)),
                credential_binding_sha256: Some(digest("credential-binding")),
                credential_use_generation: 17,
                sign_count: 7,
                clone_warning: 0,
                user_present: 1,
                user_verified: 1,
                backup_eligible: 1,
                backup_state: 0,
                updated_at: NOW - 100,
                deleted_at: None,
            }),
            head: Some(RelayContainerDrainSourceRegistrationHeadState {
                environment: "staging".to_owned(),
                scope_kind: "global".to_owned(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_owned(),
                current_fence_id_sha256: digest("admission-fence"),
                current_fence_generation: 1,
                head_version: 1,
                head_digest_sha256: digest("authorization-head"),
            }),
            fence: Some(RelayContainerDrainSourceRegistrationFenceState {
                admission_fence_id_sha256: digest("admission-fence"),
                fence_kind: "admission".to_owned(),
                environment: "staging".to_owned(),
                scope_kind: "global".to_owned(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_owned(),
                fence_generation: 1,
                admission_open: 1,
                state_digest_sha256: digest("fence-state"),
                closed_at: None,
            }),
            latest_ledger: None,
            ledger_count: 0,
            registration_command_count: 0,
            registration_count: 0,
            claim_count: 0,
            terminal_count: 0,
            source_scan_count: 0,
            database_now: NOW,
            read_bookmark_sha256: digest("bookmark"),
        }
    }

    fn fingerprint(snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot) -> String {
        let authorization = validate_authorization(
            snapshot,
            "staging",
            &snapshot.authorization.authorization_id_sha256,
        )
        .unwrap();
        let root = snapshot.root.as_ref().unwrap();
        let passkey = snapshot.passkey.as_ref().unwrap();
        let (head, fence) = validate_fence(
            snapshot.head.as_ref(),
            snapshot.fence.as_ref(),
            &authorization,
        )
        .unwrap();
        let (receipt_sequence, ledger_head_before_sha256) =
            validate_consumption_and_ledger(snapshot, &authorization).unwrap();
        semantic_fingerprint(
            snapshot,
            root,
            passkey,
            head,
            fence,
            receipt_sequence,
            &ledger_head_before_sha256,
        )
        .unwrap()
    }

    fn phase_proof(
        snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
        phase_subject: RootSessionPhaseSubjectV1<'_>,
        parent_proof_sha256: Option<&str>,
        test_session: &TestSession,
        authority_expires_at: i64,
    ) -> VerifiedRootSessionPhaseProof {
        let phase = phase_subject.phase();
        let context = phase_subject.context();
        let proof_id_sha256 = digest(&format!("proof-{phase:?}"));
        let key = RootSessionPhaseKey {
            kid: "application-root-session-v1",
            key_version: 1,
            secret: PHASE_PROOF_SECRET,
        };
        let token = sign_root_session_phase_proof(
            key,
            RootSessionPhaseInput {
                issuer: "cinatoken-application",
                audience: "cinatoken-drain-source-registration-coordinator",
                application_version_id: "application-build-1",
                environment: STAGING_ENVIRONMENT,
                phase,
                phase_subject,
                operation_id_sha256: context.operation_id_sha256,
                authorization_id_sha256: context.authorization_id_sha256,
                ceremony_id_sha256: context.ceremony_id_sha256,
                request_intent_sha256: context.request_intent_sha256,
                proof_id_sha256: &proof_id_sha256,
                root_admin_id: test_session.root_admin_id,
                root_role: ROLE_ROOT_USER,
                root_status: USER_STATUS_ENABLED,
                root_deleted_at: None,
                root_session_epoch: test_session.session_epoch,
                root_session_issued_at: test_session.issued_at,
                root_session_expires_at: test_session.expires_at,
                root_session_binding_sha256: &test_session.binding_sha256,
                root_session_id_sha256: &test_session.session_id_sha256,
                d1_observed_at: snapshot.database_now,
                parent_proof_sha256,
                semantic_authority_fingerprint_sha256: context
                    .semantic_authority_fingerprint_sha256,
                authority_expires_at,
            },
        )
        .unwrap();
        verify_root_session_phase_proof(
            RootSessionPhaseKeyRing {
                current: key,
                previous: None,
            },
            &token,
            RootSessionPhaseExpectation {
                issuer: "cinatoken-application",
                audience: "cinatoken-drain-source-registration-coordinator",
                application_version_id: "application-build-1",
                environment: STAGING_ENVIRONMENT,
                phase,
                phase_subject,
                operation_id_sha256: context.operation_id_sha256,
                authorization_id_sha256: context.authorization_id_sha256,
                ceremony_id_sha256: context.ceremony_id_sha256,
                request_intent_sha256: context.request_intent_sha256,
                parent_proof_sha256,
                semantic_authority_fingerprint_sha256: context
                    .semantic_authority_fingerprint_sha256,
                authority_expires_at,
                root_admin_id: test_session.root_admin_id,
                expected_session: Some(RootSessionAnchorExpectation {
                    root_session_epoch: test_session.session_epoch,
                    root_session_issued_at: test_session.issued_at,
                    root_session_expires_at: test_session.expires_at,
                    root_session_binding_sha256: &test_session.binding_sha256,
                    root_session_id_sha256: &test_session.session_id_sha256,
                }),
                now: snapshot.database_now,
            },
        )
        .unwrap()
    }

    fn begin_action_input() -> DrainSourceRegistrationBeginIntentInput {
        DrainSourceRegistrationBeginIntentInput {
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
            registered_by_service_name: "cinatoken-application".to_owned(),
            registered_by_version_id: "build-2026-07-30".to_owned(),
            registration_execution_id_sha256: digest("registration-execution"),
            registration_credential_id_sha256: digest("registration-credential"),
            ceremony_nonce_sha256: digest("ceremony-nonce"),
        }
    }

    fn begin_intent(
        snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    ) -> DrainSourceRegistrationBeginIntentV1 {
        DrainSourceRegistrationBeginIntentV1::new(
            "staging",
            digest("operation"),
            snapshot.authorization.authorization_id_sha256.clone(),
            digest("ceremony"),
            digest("request-intent"),
            "cinatoken.com",
            "https://admin.cinatoken.com",
            snapshot.database_now,
            begin_action_input(),
        )
        .unwrap()
    }

    fn challenge_proof(
        snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
        begin_intent: &DrainSourceRegistrationBeginIntentV1,
    ) -> VerifiedRootSessionPhaseProof {
        let semantic_fingerprint_sha256 = fingerprint(snapshot);
        let begin_intent_sha256 = begin_intent.sha256().unwrap();
        let subject =
            RootSessionPhaseSubjectV1::BeforeChallenge(RootSessionBeforeChallengeSubjectV1 {
                context: phase_subject_context(begin_intent, &semantic_fingerprint_sha256),
                begin_intent_sha256: &begin_intent_sha256,
                authorization_subject_sha256: &snapshot.authorization.authorization_subject_sha256,
                authorization_signature_envelope_sha256: &snapshot
                    .authorization
                    .authorization_signature_envelope_sha256,
            });
        phase_proof(
            snapshot,
            subject,
            None,
            &session(),
            snapshot.authorization.permit_expires_at,
        )
    }

    fn issuer_proof(
        snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
        challenge: &ValidatedDrainSourceRegistrationChallenge,
        ceremony: &DrainSourceRegistrationCeremonyState,
        passkey_proof: &VerifiedDrainSourceRegistrationPasskeyProof,
        parent_proof_sha256: &str,
    ) -> VerifiedRootSessionPhaseProof {
        let issue_request = ceremony
            .registration_permit_bindings(passkey_proof)
            .unwrap()
            .issue_request()
            .unwrap();
        let challenge_sha256 = ceremony.secure_verification_challenge_sha256().unwrap();
        let action_subject_sha256 = ceremony.action_subject_sha256().unwrap();
        let issue_request_sha256 = issue_request.sha256().unwrap();
        let subject = RootSessionPhaseSubjectV1::BeforeIssuer(RootSessionBeforeIssuerSubjectV1 {
            context: phase_subject_context(
                &challenge.begin_intent,
                &challenge.authority.semantic_fingerprint_sha256,
            ),
            secure_verification_challenge_sha256: &challenge_sha256,
            action_subject_sha256: &action_subject_sha256,
            permit_issue_request_sha256: &issue_request_sha256,
        });
        phase_proof(
            snapshot,
            subject,
            Some(parent_proof_sha256),
            &session(),
            NOW + 120,
        )
    }

    fn commit_proof(
        snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
        issuer: &ValidatedDrainSourceRegistrationIssuer,
        permit: &VerifiedDrainSourceRegistrationPermit,
        parent_proof_sha256: &str,
    ) -> VerifiedRootSessionPhaseProof {
        let action_subject_sha256 = issuer.ceremony.action_subject_sha256().unwrap();
        let issuer_request_sha256 = issuer.issue_request.sha256().unwrap();
        let authenticated_request_id_sha256 = permit.authenticated_request_id_sha256().unwrap();
        let subject = RootSessionPhaseSubjectV1::BeforeCommit(RootSessionBeforeCommitSubjectV1 {
            context: phase_subject_context(
                &issuer.begin_intent,
                &issuer.authority.semantic_fingerprint_sha256,
            ),
            action_subject_sha256: &action_subject_sha256,
            issuer_request_sha256: &issuer_request_sha256,
            authenticated_issuer_request_id_sha256: &authenticated_request_id_sha256,
            issuer_version_id: permit.issuer_version_id(),
            permit_id_sha256: permit.permit_id_sha256(),
            permit_subject_sha256: permit.subject_sha256(),
            permit_signature_envelope_sha256: permit.signature_envelope_sha256(),
        });
        phase_proof(
            snapshot,
            subject,
            Some(parent_proof_sha256),
            &session(),
            permit.writer_projection().expires_at(),
        )
    }

    fn action_with_begin_input(
        validated: &ValidatedDrainSourceRegistrationChallenge,
        begin_input: DrainSourceRegistrationBeginIntentInput,
    ) -> DrainSourceRegistrationActionV1 {
        DrainSourceRegistrationActionV1::from_verified_authorization(
            validated.authorization(),
            DrainSourceRegistrationActionInput {
                action_digest_sha256: begin_input.action_digest_sha256,
                registration_request_sha256: begin_input.registration_request_sha256,
                admin_audit_digest_sha256: begin_input.admin_audit_digest_sha256,
                admin_network_identity_hmac_sha256: begin_input.admin_network_identity_hmac_sha256,
                change_ticket_sha256: begin_input.change_ticket_sha256,
                reason_code: begin_input.reason_code,
                verification_expires_at: begin_input.verification_expires_at,
                receipt_sequence: validated.receipt_sequence(),
                ledger_head_before_sha256: validated.ledger_head_before_sha256().to_owned(),
                root_session_epoch: session().session_epoch,
                root_session_issued_at: session().issued_at,
                root_session_expires_at: session().expires_at,
                root_session_binding_sha256: session().binding_sha256,
                passkey_credential_row_id: validated.passkey().row_id,
                passkey_credential_id_sha256: validated.passkey().credential_id_sha256.clone(),
                passkey_credential_registration_id_sha256: validated
                    .passkey()
                    .credential_registration_id_sha256
                    .clone(),
                passkey_credential_binding_sha256: validated
                    .passkey()
                    .credential_binding_sha256
                    .clone(),
                passkey_previous_use_generation: validated.passkey().use_generation,
                registered_by_service_name: begin_input.registered_by_service_name,
                registered_by_version_id: begin_input.registered_by_version_id,
                registration_execution_id_sha256: begin_input.registration_execution_id_sha256,
                registration_credential_id_sha256: begin_input.registration_credential_id_sha256,
                ceremony_nonce_sha256: begin_input.ceremony_nonce_sha256,
            },
        )
    }

    fn action(
        validated: &ValidatedDrainSourceRegistrationChallenge,
    ) -> DrainSourceRegistrationActionV1 {
        action_with_begin_input(validated, begin_action_input())
    }

    fn ceremony(
        challenge: &ValidatedDrainSourceRegistrationChallenge,
    ) -> DrainSourceRegistrationCeremonyState {
        DrainSourceRegistrationCeremonyState::new(
            action(challenge),
            challenge.begin_intent().rp_id(),
            challenge.begin_intent().origin(),
            challenge.begin_intent().issued_at(),
        )
        .unwrap()
    }

    fn passkey_proof(
        ceremony: &DrainSourceRegistrationCeremonyState,
    ) -> VerifiedDrainSourceRegistrationPasskeyProof {
        VerifiedDrainSourceRegistrationPasskeyProof::test_fixture_for_state(
            ceremony, 7, 8, true, false, NOW,
        )
        .unwrap()
    }

    #[test]
    fn authority_is_prepared_from_the_exact_snapshot_before_phase_proof_signing() {
        let snapshot = snapshot();
        let begin_intent = begin_intent(&snapshot);
        let prepared =
            prepare_before_challenge_authority(&snapshot, &root_session_anchor(), &begin_intent)
                .unwrap();

        assert_eq!(prepared.begin_intent(), &begin_intent);
        assert_eq!(prepared.database_now(), snapshot.database_now);
        assert_eq!(
            prepared.semantic_fingerprint_sha256(),
            fingerprint(&snapshot)
        );
        assert_eq!(
            prepared.passkey().credential_id_sha256,
            snapshot
                .passkey
                .as_ref()
                .unwrap()
                .credential_id_sha256
                .clone()
                .unwrap()
        );
        assert_eq!(
            prepared.phase_subject().unwrap().phase(),
            RootSessionPhase::BeforeChallenge
        );
        let proof = crate::container_drain_source_registration_application_orchestrator::issue_before_challenge_phase_proof_for_test(
            &prepared,
            &[0x5a; 32],
        )
        .unwrap();
        let validated = validate_before_challenge(&snapshot, &proof, &begin_intent).unwrap();
        assert_eq!(
            validated.authorization().authorization_id_sha256,
            snapshot.authorization.authorization_id_sha256
        );

        let mut wrong_session = root_session_anchor();
        wrong_session.root_session_epoch += 1;
        assert!(matches!(
            prepare_before_challenge_authority(&snapshot, &wrong_session, &begin_intent),
            Err(DrainSourceRegistrationCoordinatorError::SessionStateChanged)
        ));

        let mut wrong_passkey = snapshot.clone();
        wrong_passkey.passkey.as_mut().unwrap().credential_id_sha256 =
            Some(digest("substituted-passkey"));
        assert!(matches!(
            prepare_before_challenge_authority(
                &wrong_passkey,
                &root_session_anchor(),
                &begin_intent,
            ),
            Err(DrainSourceRegistrationCoordinatorError::PasskeyStateChanged)
        ));
    }

    #[test]
    fn typed_three_phase_chain_is_coherent_and_command_cannot_bypass_commit() {
        let initial = snapshot();
        let begin_intent = begin_intent(&initial);
        let begin_proof = challenge_proof(&initial, &begin_intent);
        let begin = validate_before_challenge(&initial, &begin_proof, &begin_intent).unwrap();
        let ceremony = ceremony(&begin);
        let passkey_proof = passkey_proof(&ceremony);

        let mut issuer_snapshot = initial.clone();
        issuer_snapshot.database_now += 1;
        issuer_snapshot.read_bookmark_sha256 = digest("issuer-bookmark");
        let issuer_phase_proof = issuer_proof(
            &issuer_snapshot,
            &begin,
            &ceremony,
            &passkey_proof,
            begin_proof.token_sha256(),
        );
        let issuer = validate_before_issuer(
            &issuer_snapshot,
            &issuer_phase_proof,
            &begin,
            &ceremony,
            &passkey_proof,
        )
        .unwrap();
        let permit = VerifiedDrainSourceRegistrationPermit::test_fixture_from_issue_request(
            issuer.issue_request(),
            "registration-request-001",
            "registration-permit-issuer-version-001",
        )
        .unwrap();

        let mut commit_snapshot = issuer_snapshot.clone();
        commit_snapshot.database_now += 1;
        commit_snapshot.read_bookmark_sha256 = digest("commit-bookmark");
        let commit_phase_proof = commit_proof(
            &commit_snapshot,
            &issuer,
            &permit,
            issuer_phase_proof.token_sha256(),
        );
        let commit =
            validate_before_commit(&commit_snapshot, &commit_phase_proof, &issuer, &permit)
                .unwrap();
        let command =
            VerifiedDrainSourceRegistrationCommand::from_validated_commit(&commit).unwrap();

        assert_eq!(
            begin.authority.semantic_fingerprint_sha256,
            issuer.authority.semantic_fingerprint_sha256
        );
        assert_eq!(
            issuer.authority.semantic_fingerprint_sha256,
            commit.authority.semantic_fingerprint_sha256
        );
        assert_eq!(issuer.authority.phase, RootSessionPhase::BeforeIssuer);
        assert_eq!(commit.authority.phase, RootSessionPhase::BeforeCommit);
        assert_eq!(commit.authority.database_now, NOW + 2);
        assert_eq!(
            commit
                .authority
                .passkey
                .stored_credential()
                .credential
                .credential_id,
            b"credential-id"
        );
        assert_eq!(command.permit_id_sha256(), permit.permit_id_sha256());
        assert_eq!(
            command.issuer_request_id_sha256(),
            permit.authenticated_request_id_sha256().unwrap()
        );
        assert_eq!(
            begin.authority.session_phase_proof_sha256,
            begin_proof.token_sha256()
        );
        assert_eq!(
            issuer
                .authority
                .parent_session_phase_proof_sha256
                .as_deref(),
            Some(begin_proof.token_sha256())
        );
        assert_eq!(
            commit
                .authority
                .parent_session_phase_proof_sha256
                .as_deref(),
            Some(issuer_phase_proof.token_sha256())
        );
    }

    #[test]
    fn phase_binding_parent_chain_and_production_drift_fail_closed() {
        let initial = snapshot();
        let begin_intent = begin_intent(&initial);
        let begin_proof = challenge_proof(&initial, &begin_intent);
        let changed_begin_intent = DrainSourceRegistrationBeginIntentV1::new(
            "staging",
            begin_intent.operation_id_sha256(),
            begin_intent.authorization_id_sha256(),
            begin_intent.ceremony_id_sha256(),
            begin_intent.request_intent_sha256(),
            "cinatoken.com",
            "https://root.cinatoken.com",
            begin_intent.issued_at(),
            begin_action_input(),
        )
        .unwrap();
        assert_eq!(
            validate_before_challenge(&initial, &begin_proof, &changed_begin_intent),
            Err(DrainSourceRegistrationCoordinatorError::PhaseBindingMismatch)
        );

        let challenge = validate_before_challenge(&initial, &begin_proof, &begin_intent).unwrap();
        let ceremony = ceremony(&challenge);
        let passkey_proof = passkey_proof(&ceremony);
        let mut issuer_snapshot = initial.clone();
        issuer_snapshot.database_now += 1;
        let wrong_parent_proof = issuer_proof(
            &issuer_snapshot,
            &challenge,
            &ceremony,
            &passkey_proof,
            &digest("wrong-parent"),
        );
        assert_eq!(
            validate_before_issuer(
                &issuer_snapshot,
                &wrong_parent_proof,
                &challenge,
                &ceremony,
                &passkey_proof,
            ),
            Err(DrainSourceRegistrationCoordinatorError::PhaseChainMismatch)
        );

        let challenge_sha256 = ceremony.secure_verification_challenge_sha256().unwrap();
        let action_subject_sha256 = ceremony.action_subject_sha256().unwrap();
        let wrong_request_sha256 = digest("wrong-issuer-request");
        let wrong_binding_subject =
            RootSessionPhaseSubjectV1::BeforeIssuer(RootSessionBeforeIssuerSubjectV1 {
                context: phase_subject_context(
                    &challenge.begin_intent,
                    &challenge.authority.semantic_fingerprint_sha256,
                ),
                secure_verification_challenge_sha256: &challenge_sha256,
                action_subject_sha256: &action_subject_sha256,
                permit_issue_request_sha256: &wrong_request_sha256,
            });
        let wrong_binding_proof = phase_proof(
            &issuer_snapshot,
            wrong_binding_subject,
            Some(begin_proof.token_sha256()),
            &session(),
            NOW + 120,
        );
        assert_eq!(
            validate_before_issuer(
                &issuer_snapshot,
                &wrong_binding_proof,
                &challenge,
                &ceremony,
                &passkey_proof,
            ),
            Err(DrainSourceRegistrationCoordinatorError::PhaseBindingMismatch)
        );

        let mut production = initial.clone();
        production.authorization.environment = "production".to_owned();
        assert_eq!(
            validate_before_challenge(&production, &begin_proof, &begin_intent),
            Err(DrainSourceRegistrationCoordinatorError::UnsupportedEnvironment)
        );
    }

    #[test]
    fn challenge_cannot_be_replayed_with_a_different_action_intent() {
        let initial = snapshot();
        let begin_intent = begin_intent(&initial);
        let begin_proof = challenge_proof(&initial, &begin_intent);
        let challenge = validate_before_challenge(&initial, &begin_proof, &begin_intent).unwrap();
        let mut changed_input = begin_action_input();
        changed_input.reason_code = "migration.source-replay".to_owned();
        let changed_ceremony = DrainSourceRegistrationCeremonyState::new(
            action_with_begin_input(&challenge, changed_input),
            challenge.begin_intent().rp_id(),
            challenge.begin_intent().origin(),
            challenge.begin_intent().issued_at(),
        )
        .unwrap();
        let passkey_proof = passkey_proof(&changed_ceremony);
        let mut issuer_snapshot = initial.clone();
        issuer_snapshot.database_now += 1;
        let issuer_phase_proof = issuer_proof(
            &issuer_snapshot,
            &challenge,
            &changed_ceremony,
            &passkey_proof,
            begin_proof.token_sha256(),
        );

        assert_eq!(
            validate_before_issuer(
                &issuer_snapshot,
                &issuer_phase_proof,
                &challenge,
                &changed_ceremony,
                &passkey_proof,
            ),
            Err(DrainSourceRegistrationCoordinatorError::CeremonyMismatch)
        );
    }

    #[test]
    fn passkey_fence_and_consumption_drift_fail_closed() {
        let initial = snapshot();
        let begin_intent = begin_intent(&initial);
        let begin_proof = challenge_proof(&initial, &begin_intent);
        let challenge = validate_before_challenge(&initial, &begin_proof, &begin_intent).unwrap();
        let ceremony = ceremony(&challenge);
        let passkey_proof = passkey_proof(&ceremony);
        let mut issuer_snapshot = initial.clone();
        issuer_snapshot.database_now += 1;
        let issuer_phase_proof = issuer_proof(
            &issuer_snapshot,
            &challenge,
            &ceremony,
            &passkey_proof,
            begin_proof.token_sha256(),
        );
        let check = |changed: &RelayContainerDrainSourceRegistrationPhaseSnapshot, expected| {
            assert_eq!(
                validate_before_issuer(
                    changed,
                    &issuer_phase_proof,
                    &challenge,
                    &ceremony,
                    &passkey_proof,
                ),
                Err(expected)
            );
        };

        for mutate in [
            |row: &mut RelayContainerDrainSourceRegistrationPasskeyState| {
                row.credential_use_generation += 1
            },
            |row: &mut RelayContainerDrainSourceRegistrationPasskeyState| row.sign_count += 1,
            |row: &mut RelayContainerDrainSourceRegistrationPasskeyState| {
                row.credential_binding_sha256 = Some(digest("new-binding"))
            },
            |row: &mut RelayContainerDrainSourceRegistrationPasskeyState| {
                row.public_key = STANDARD.encode(b"other-public-key")
            },
        ] {
            let mut changed = issuer_snapshot.clone();
            mutate(changed.passkey.as_mut().unwrap());
            check(
                &changed,
                DrainSourceRegistrationCoordinatorError::AuthorityDrift,
            );
        }

        let mut changed = issuer_snapshot.clone();
        changed.passkey.as_mut().unwrap().clone_warning = 1;
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::PasskeyStateChanged,
        );

        let mut changed = issuer_snapshot.clone();
        changed.passkey.as_mut().unwrap().deleted_at = Some(NOW);
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::PasskeyStateChanged,
        );

        let mut changed = issuer_snapshot.clone();
        changed.head.as_mut().unwrap().head_digest_sha256 = digest("other-head");
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::FenceStateChanged,
        );

        let mut changed = issuer_snapshot.clone();
        changed.fence.as_mut().unwrap().admission_open = 0;
        changed.fence.as_mut().unwrap().closed_at = Some(NOW);
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::FenceStateChanged,
        );

        for set_consumed in [
            |snapshot: &mut RelayContainerDrainSourceRegistrationPhaseSnapshot| {
                snapshot.registration_command_count = 1
            },
            |snapshot: &mut RelayContainerDrainSourceRegistrationPhaseSnapshot| {
                snapshot.registration_count = 1
            },
            |snapshot: &mut RelayContainerDrainSourceRegistrationPhaseSnapshot| {
                snapshot.claim_count = 1
            },
            |snapshot: &mut RelayContainerDrainSourceRegistrationPhaseSnapshot| {
                snapshot.terminal_count = 1
            },
            |snapshot: &mut RelayContainerDrainSourceRegistrationPhaseSnapshot| {
                snapshot.source_scan_count = 1
            },
        ] {
            let mut changed = issuer_snapshot.clone();
            set_consumed(&mut changed);
            check(
                &changed,
                DrainSourceRegistrationCoordinatorError::AuthorizationAlreadyConsumed,
            );
        }
    }

    #[test]
    fn terminal_ledger_head_advances_and_nonterminal_head_is_rejected() {
        let mut snapshot = snapshot();
        snapshot.ledger_count = 3;
        snapshot.latest_ledger = Some(RelayContainerDrainSourceRegistrationLedgerHead {
            authority_ledger_identity_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256
                .to_owned(),
            receipt_sequence: 3,
            event_kind: "terminal".to_owned(),
            authorization_id_sha256: digest("previous-authorization"),
            predecessor_receipt_sha256: digest("previous-claim"),
            receipt_digest_sha256: digest("previous-terminal"),
            recorded_at: NOW - 20,
        });
        let begin_intent = begin_intent(&snapshot);
        let proof = challenge_proof(&snapshot, &begin_intent);
        let validated = validate_before_challenge(&snapshot, &proof, &begin_intent).unwrap();
        assert_eq!(validated.receipt_sequence(), 4);
        assert_eq!(
            validated.ledger_head_before_sha256(),
            digest("previous-terminal")
        );

        snapshot.latest_ledger.as_mut().unwrap().event_kind = "registration".to_owned();
        assert_eq!(
            validate_before_challenge(&snapshot, &proof, &begin_intent),
            Err(DrainSourceRegistrationCoordinatorError::LedgerStateChanged)
        );
    }

    #[test]
    fn commit_requires_the_exact_live_verified_permit_and_fresh_root_state() {
        let initial = snapshot();
        let begin_intent = begin_intent(&initial);
        let begin_proof = challenge_proof(&initial, &begin_intent);
        let challenge = validate_before_challenge(&initial, &begin_proof, &begin_intent).unwrap();
        let ceremony = ceremony(&challenge);
        let passkey_proof = passkey_proof(&ceremony);
        let mut issuer_snapshot = initial.clone();
        issuer_snapshot.database_now += 1;
        let issuer_phase_proof = issuer_proof(
            &issuer_snapshot,
            &challenge,
            &ceremony,
            &passkey_proof,
            begin_proof.token_sha256(),
        );
        let issuer = validate_before_issuer(
            &issuer_snapshot,
            &issuer_phase_proof,
            &challenge,
            &ceremony,
            &passkey_proof,
        )
        .unwrap();
        let permit = VerifiedDrainSourceRegistrationPermit::test_fixture_from_issue_request(
            issuer.issue_request(),
            "registration-request-001",
            "registration-permit-issuer-version-001",
        )
        .unwrap();
        let mut commit_snapshot = issuer_snapshot.clone();
        commit_snapshot.database_now += 1;
        let commit_phase_proof = commit_proof(
            &commit_snapshot,
            &issuer,
            &permit,
            issuer_phase_proof.token_sha256(),
        );

        let unrelated_request = DrainSourceRegistrationPermitBindings::test_fixture(NOW)
            .issue_request()
            .unwrap();
        let unrelated_permit =
            VerifiedDrainSourceRegistrationPermit::test_fixture_from_issue_request(
                &unrelated_request,
                "registration-request-unrelated",
                "registration-permit-issuer-version-001",
            )
            .unwrap();
        assert_eq!(
            validate_before_commit(
                &commit_snapshot,
                &commit_phase_proof,
                &issuer,
                &unrelated_permit,
            ),
            Err(DrainSourceRegistrationCoordinatorError::PermitMismatch)
        );

        let different_permit =
            VerifiedDrainSourceRegistrationPermit::test_fixture_from_issue_request(
                issuer.issue_request(),
                "registration-request-002",
                "registration-permit-issuer-version-002",
            )
            .unwrap();
        assert_eq!(
            validate_before_commit(
                &commit_snapshot,
                &commit_phase_proof,
                &issuer,
                &different_permit,
            ),
            Err(DrainSourceRegistrationCoordinatorError::PhaseBindingMismatch)
        );

        let mut expired = commit_snapshot.clone();
        expired.database_now = permit.writer_projection().expires_at();
        assert_eq!(
            validate_before_commit(&expired, &commit_phase_proof, &issuer, &permit),
            Err(DrainSourceRegistrationCoordinatorError::PermitExpired)
        );

        let mut changed_root = commit_snapshot.clone();
        changed_root.root.as_mut().unwrap().role -= 1;
        assert_eq!(
            validate_before_commit(&changed_root, &commit_phase_proof, &issuer, &permit,),
            Err(DrainSourceRegistrationCoordinatorError::RootStateChanged)
        );
    }
}
