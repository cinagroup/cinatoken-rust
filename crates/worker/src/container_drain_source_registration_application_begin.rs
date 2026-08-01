//! Route-free assembly of an exact registration `Prepared` checkpoint.
//!
//! Request-facing Origin, CSRF, rate-limit, and audit gates remain outside this
//! module. Once those gates produce a typed digest-only draft, this boundary
//! performs one exact D1 snapshot read and freezes every downstream artifact
//! from that same observation before persist-before-dispatch orchestration.

use cinatoken_drain_source_registration_coordinator::{
    BeginEvidenceV1, BeginRequestV1, CoordinatorIdentityV1,
};
use cinatoken_session::SessionClaims;
use sha2::{Digest, Sha256};
use worker::Env;

use crate::container_drain_source_registration_action::{
    AdminNetworkIdentityHmacSha256, DrainSourceRegistrationActionInput,
    DrainSourceRegistrationActionV1, DrainSourceRegistrationBeginIntentInput,
    DrainSourceRegistrationBeginIntentV1, DrainSourceRegistrationCeremonyState,
};
use crate::container_drain_source_registration_application_ceremony::DrainSourceRegistrationApplicationCeremonyV1;
use crate::container_drain_source_registration_application_orchestrator::{
    self as application_orchestrator, ApplicationBeginOrchestratorError,
};
use crate::container_drain_source_registration_application_session::{
    ApplicationRootSessionAnchorError, VerifiedApplicationRootSessionV1,
};
use crate::container_drain_source_registration_coordinator::{
    prepare_before_challenge_authority, DrainSourceRegistrationRootSessionAnchorV1,
    PreparedDrainSourceRegistrationChallengeAuthority,
};
use crate::d1_repositories::{
    relay_container_drain_source_registration_phase_snapshot,
    RelayContainerDrainSourceRegistrationPhaseSnapshot,
    RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256,
};

pub(crate) const APPLICATION_CREDENTIAL_ID_SHA256_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_APPLICATION_CREDENTIAL_ID_SHA256";

const REGISTERED_SERVICE_NAME: &str = "cinatoken-relay-application";
const COORDINATOR_BEGIN_REQUEST_ID_DOMAIN: &[u8] =
    b"cinatoken-drain-source-registration-coordinator-begin-request-id-v1";
const MINIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 30;
const MAXIMUM_VERIFICATION_LIFETIME_SECONDS: i64 = 300;
const MAXIMUM_TEXT_BYTES: usize = 2_048;

#[derive(Clone)]
pub(crate) struct DrainSourceRegistrationApplicationBeginDraftInputV1 {
    pub(crate) authorization_id_sha256: String,
    pub(crate) passkey_credential_id_sha256: String,
    pub(crate) operation_id_sha256: String,
    pub(crate) ceremony_id_sha256: String,
    pub(crate) request_intent_sha256: String,
    pub(crate) rp_id: String,
    pub(crate) origin: String,
    pub(crate) action_digest_sha256: String,
    pub(crate) registration_request_sha256: String,
    pub(crate) admin_audit_digest_sha256: String,
    pub(crate) admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256,
    pub(crate) change_ticket_sha256: String,
    pub(crate) reason_code: String,
    pub(crate) verification_lifetime_seconds: i64,
    pub(crate) registration_execution_id_sha256: String,
    pub(crate) ceremony_nonce_sha256: String,
}

#[derive(Clone)]
pub(crate) struct DrainSourceRegistrationApplicationBeginDraftV1 {
    authorization_id_sha256: String,
    passkey_credential_id_sha256: String,
    operation_id_sha256: String,
    ceremony_id_sha256: String,
    request_intent_sha256: String,
    rp_id: String,
    origin: String,
    action_digest_sha256: String,
    registration_request_sha256: String,
    admin_audit_digest_sha256: String,
    admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256,
    change_ticket_sha256: String,
    reason_code: String,
    verification_lifetime_seconds: i64,
    registration_execution_id_sha256: String,
    ceremony_nonce_sha256: String,
}

impl DrainSourceRegistrationApplicationBeginDraftV1 {
    pub(crate) fn new(
        input: DrainSourceRegistrationApplicationBeginDraftInputV1,
    ) -> Result<Self, ApplicationBeginPreparationError> {
        let draft = Self {
            authorization_id_sha256: input.authorization_id_sha256,
            passkey_credential_id_sha256: input.passkey_credential_id_sha256,
            operation_id_sha256: input.operation_id_sha256,
            ceremony_id_sha256: input.ceremony_id_sha256,
            request_intent_sha256: input.request_intent_sha256,
            rp_id: input.rp_id,
            origin: input.origin,
            action_digest_sha256: input.action_digest_sha256,
            registration_request_sha256: input.registration_request_sha256,
            admin_audit_digest_sha256: input.admin_audit_digest_sha256,
            admin_network_identity_hmac_sha256: input.admin_network_identity_hmac_sha256,
            change_ticket_sha256: input.change_ticket_sha256,
            reason_code: input.reason_code,
            verification_lifetime_seconds: input.verification_lifetime_seconds,
            registration_execution_id_sha256: input.registration_execution_id_sha256,
            ceremony_nonce_sha256: input.ceremony_nonce_sha256,
        };
        draft.validate()?;
        Ok(draft)
    }

    fn validate(&self) -> Result<(), ApplicationBeginPreparationError> {
        let digests = [
            &self.authorization_id_sha256,
            &self.passkey_credential_id_sha256,
            &self.operation_id_sha256,
            &self.ceremony_id_sha256,
            &self.request_intent_sha256,
            &self.action_digest_sha256,
            &self.registration_request_sha256,
            &self.admin_audit_digest_sha256,
            &self.change_ticket_sha256,
            &self.registration_execution_id_sha256,
            &self.ceremony_nonce_sha256,
        ];
        if digests.iter().any(|value| !valid_sha256(value))
            || digests.iter().enumerate().any(|(index, value)| {
                digests[index + 1..]
                    .iter()
                    .any(|candidate| *candidate == *value)
            })
            || !matches!(
                self.verification_lifetime_seconds,
                MINIMUM_VERIFICATION_LIFETIME_SECONDS..=MAXIMUM_VERIFICATION_LIFETIME_SECONDS
            )
            || !valid_text(&self.rp_id)
            || !valid_text(&self.origin)
            || !valid_text(&self.reason_code)
        {
            return Err(ApplicationBeginPreparationError::InvalidDraft);
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ApplicationBeginPreparationError {
    InvalidSession,
    InvalidDraft,
    Configuration,
    SnapshotReadIndeterminate,
    SnapshotMissing,
    AuthorityRejected,
    PhaseProofRejected,
    CheckpointRejected,
    Orchestration(ApplicationBeginOrchestratorError),
}

impl ApplicationBeginPreparationError {
    pub(crate) const fn code(&self) -> &'static str {
        match self {
            Self::InvalidSession => "registration_begin_session_invalid",
            Self::InvalidDraft => "registration_begin_draft_invalid",
            Self::Configuration => "registration_begin_preparation_configuration_invalid",
            Self::SnapshotReadIndeterminate => "registration_begin_snapshot_read_indeterminate",
            Self::SnapshotMissing => "registration_begin_snapshot_missing",
            Self::AuthorityRejected => "registration_begin_authority_rejected",
            Self::PhaseProofRejected => "registration_begin_phase_proof_rejected",
            Self::CheckpointRejected => "registration_begin_checkpoint_rejected",
            Self::Orchestration(error) => error.code(),
        }
    }
}

impl std::fmt::Display for ApplicationBeginPreparationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::fmt::Debug for ApplicationBeginPreparationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ApplicationBeginPreparationError {}

struct MaterializedApplicationBeginV1 {
    authority: PreparedDrainSourceRegistrationChallengeAuthority,
    webauthn: DrainSourceRegistrationCeremonyState,
}

pub(crate) async fn prepare_application_begin(
    env: &Env,
    live_root_claims: &SessionClaims,
    draft: &DrainSourceRegistrationApplicationBeginDraftV1,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginPreparationError> {
    // Drop the secret-bearing signer config before the first D1 await. The
    // signer is loaded again only after the exact snapshot has been validated.
    application_orchestrator::preflight_fresh_application_begin(env)
        .map_err(ApplicationBeginPreparationError::Orchestration)?;
    let application_version_id = application_orchestrator::application_version_id(env)
        .map_err(ApplicationBeginPreparationError::Orchestration)?;
    let application_credential_id_sha256 = runtime_value(env, APPLICATION_CREDENTIAL_ID_SHA256_ENV)
        .filter(|value| valid_sha256(value))
        .ok_or(ApplicationBeginPreparationError::Configuration)?;
    let verified_session =
        VerifiedApplicationRootSessionV1::from_live_root_claims(live_root_claims)
            .map_err(map_session_error)?;
    let db = env
        .d1("DB")
        .map_err(|_| ApplicationBeginPreparationError::Configuration)?;
    let snapshot = relay_container_drain_source_registration_phase_snapshot(
        &db,
        &draft.authorization_id_sha256,
        verified_session.anchor().root_admin_id(),
        &draft.passkey_credential_id_sha256,
    )
    .await
    .map_err(|_| ApplicationBeginPreparationError::SnapshotReadIndeterminate)?
    .ok_or(ApplicationBeginPreparationError::SnapshotMissing)?;

    let materialized = materialize_application_begin(
        &snapshot,
        verified_session.anchor(),
        draft,
        &application_version_id,
        &application_credential_id_sha256,
    )?;
    let phase_proof =
        application_orchestrator::issue_before_challenge_phase_proof(env, &materialized.authority)
            .map_err(|_| ApplicationBeginPreparationError::PhaseProofRejected)?;
    freeze_application_checkpoint(materialized, &phase_proof)
}

pub(crate) async fn prepare_and_dispatch_application_begin(
    env: &Env,
    live_root_claims: &SessionClaims,
    draft: &DrainSourceRegistrationApplicationBeginDraftV1,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginPreparationError> {
    let prepared = prepare_application_begin(env, live_root_claims, draft).await?;
    application_orchestrator::dispatch_prepared_begin(env, &prepared)
        .await
        .map_err(ApplicationBeginPreparationError::Orchestration)
}

fn materialize_application_begin(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    root_session: &DrainSourceRegistrationRootSessionAnchorV1,
    draft: &DrainSourceRegistrationApplicationBeginDraftV1,
    application_version_id: &str,
    application_credential_id_sha256: &str,
) -> Result<MaterializedApplicationBeginV1, ApplicationBeginPreparationError> {
    draft.validate()?;
    if !valid_identifier(application_version_id) || !valid_sha256(application_credential_id_sha256)
    {
        return Err(ApplicationBeginPreparationError::Configuration);
    }
    let verification_expires_at = snapshot
        .database_now
        .checked_add(draft.verification_lifetime_seconds)
        .ok_or(ApplicationBeginPreparationError::InvalidDraft)?;
    let begin_intent = DrainSourceRegistrationBeginIntentV1::new(
        "staging",
        draft.operation_id_sha256.clone(),
        draft.authorization_id_sha256.clone(),
        draft.ceremony_id_sha256.clone(),
        draft.request_intent_sha256.clone(),
        draft.rp_id.clone(),
        draft.origin.clone(),
        snapshot.database_now,
        DrainSourceRegistrationBeginIntentInput {
            action_digest_sha256: draft.action_digest_sha256.clone(),
            registration_request_sha256: draft.registration_request_sha256.clone(),
            admin_audit_digest_sha256: draft.admin_audit_digest_sha256.clone(),
            admin_network_identity_hmac_sha256: draft.admin_network_identity_hmac_sha256.clone(),
            change_ticket_sha256: draft.change_ticket_sha256.clone(),
            reason_code: draft.reason_code.clone(),
            verification_expires_at,
            registered_by_service_name: REGISTERED_SERVICE_NAME.to_string(),
            registered_by_version_id: application_version_id.to_string(),
            registration_execution_id_sha256: draft.registration_execution_id_sha256.clone(),
            registration_credential_id_sha256: application_credential_id_sha256.to_string(),
            ceremony_nonce_sha256: draft.ceremony_nonce_sha256.clone(),
        },
    )
    .map_err(|_| ApplicationBeginPreparationError::InvalidDraft)?;
    let authority = prepare_before_challenge_authority(snapshot, root_session, &begin_intent)
        .map_err(|_| ApplicationBeginPreparationError::AuthorityRejected)?;
    let passkey = authority.passkey();
    let root_session = authority.root_session();
    let action = DrainSourceRegistrationActionV1::from_verified_authorization(
        authority.authorization(),
        DrainSourceRegistrationActionInput {
            action_digest_sha256: draft.action_digest_sha256.clone(),
            registration_request_sha256: draft.registration_request_sha256.clone(),
            admin_audit_digest_sha256: draft.admin_audit_digest_sha256.clone(),
            admin_network_identity_hmac_sha256: draft.admin_network_identity_hmac_sha256.clone(),
            change_ticket_sha256: draft.change_ticket_sha256.clone(),
            reason_code: draft.reason_code.clone(),
            verification_expires_at,
            receipt_sequence: authority.receipt_sequence(),
            ledger_head_before_sha256: authority.ledger_head_before_sha256().to_string(),
            root_session_epoch: root_session.root_session_epoch(),
            root_session_issued_at: root_session.root_session_issued_at(),
            root_session_expires_at: root_session.root_session_expires_at(),
            root_session_binding_sha256: root_session.root_session_binding_sha256().to_string(),
            passkey_credential_row_id: passkey.row_id,
            passkey_credential_id_sha256: passkey.credential_id_sha256.clone(),
            passkey_credential_registration_id_sha256: passkey
                .credential_registration_id_sha256
                .clone(),
            passkey_credential_binding_sha256: passkey.credential_binding_sha256.clone(),
            passkey_previous_use_generation: passkey.use_generation,
            registered_by_service_name: REGISTERED_SERVICE_NAME.to_string(),
            registered_by_version_id: application_version_id.to_string(),
            registration_execution_id_sha256: draft.registration_execution_id_sha256.clone(),
            registration_credential_id_sha256: application_credential_id_sha256.to_string(),
            ceremony_nonce_sha256: draft.ceremony_nonce_sha256.clone(),
        },
    );
    let webauthn = DrainSourceRegistrationCeremonyState::new(
        action,
        draft.rp_id.clone(),
        draft.origin.clone(),
        snapshot.database_now,
    )
    .map_err(|_| ApplicationBeginPreparationError::InvalidDraft)?;
    if !authority.begin_intent().matches_action(webauthn.action()) {
        return Err(ApplicationBeginPreparationError::InvalidDraft);
    }
    Ok(MaterializedApplicationBeginV1 {
        authority,
        webauthn,
    })
}

fn freeze_application_checkpoint(
    materialized: MaterializedApplicationBeginV1,
    phase_proof: &cinatoken_root_session_phase_proof::VerifiedRootSessionPhaseProof,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginPreparationError> {
    let begin_intent = materialized.authority.begin_intent().clone();
    let begin_intent_sha256 = begin_intent
        .sha256()
        .map_err(|_| ApplicationBeginPreparationError::CheckpointRejected)?;
    let coordinator_request_id_sha256 =
        derive_coordinator_begin_request_id_sha256(&begin_intent_sha256)?;
    let verification_expires_at = materialized
        .webauthn
        .action()
        .writer_projection()
        .verification_expires_at();
    let expires_at_ms = verification_expires_at
        .checked_mul(1_000)
        .ok_or(ApplicationBeginPreparationError::CheckpointRejected)?;
    let coordinator_begin = BeginRequestV1 {
        command: "begin".to_string(),
        evidence: BeginEvidenceV1 {
            authority_fingerprint_sha256: materialized
                .authority
                .semantic_fingerprint_sha256()
                .to_string(),
            begin_intent_sha256,
            ceremony_id_sha256: begin_intent.ceremony_id_sha256().to_string(),
            challenge_phase_proof_sha256: phase_proof.token_sha256().to_string(),
            challenge_sha256: materialized
                .webauthn
                .secure_verification_challenge_sha256()
                .map_err(|_| ApplicationBeginPreparationError::CheckpointRejected)?,
        },
        expected_generation: 0,
        expires_at_ms,
        identity: CoordinatorIdentityV1 {
            authorization_id_sha256: begin_intent.authorization_id_sha256().to_string(),
            contract_version: 1,
            environment: begin_intent.environment().to_string(),
            operation_id_sha256: begin_intent.operation_id_sha256().to_string(),
            root_user_id: materialized
                .authority
                .root_session()
                .root_admin_id()
                .to_string(),
            scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_string(),
            scope_kind: "global".to_string(),
        },
        request_id_sha256: coordinator_request_id_sha256,
    };
    DrainSourceRegistrationApplicationCeremonyV1::prepare(
        materialized.webauthn,
        begin_intent,
        phase_proof,
        coordinator_begin,
        materialized.authority.database_now(),
    )
    .map_err(|_| ApplicationBeginPreparationError::CheckpointRejected)
}

fn map_session_error(
    _error: ApplicationRootSessionAnchorError,
) -> ApplicationBeginPreparationError {
    ApplicationBeginPreparationError::InvalidSession
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_text(value: &str) -> bool {
    value == value.trim() && !value.is_empty() && value.len() <= MAXIMUM_TEXT_BYTES
}

fn derive_coordinator_begin_request_id_sha256(
    begin_intent_sha256: &str,
) -> Result<String, ApplicationBeginPreparationError> {
    if !valid_sha256(begin_intent_sha256) {
        return Err(ApplicationBeginPreparationError::CheckpointRejected);
    }
    let mut hasher = Sha256::new();
    for field in [
        COORDINATOR_BEGIN_REQUEST_ID_DOMAIN,
        begin_intent_sha256.as_bytes(),
    ] {
        let length = u32::try_from(field.len())
            .map_err(|_| ApplicationBeginPreparationError::CheckpointRejected)?;
        hasher.update(length.to_be_bytes());
        hasher.update(field);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use cinatoken_auth::{ROLE_ROOT_USER, USER_STATUS_ENABLED};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::admin_passkey::passkey_credential_id_sha256;
    use crate::container_drain_source_authorization::DRAIN_SOURCE_AUTHORIZATION_CONTRACT;
    use crate::container_drain_source_registration_application_orchestrator::issue_before_challenge_phase_proof_for_test;
    use crate::d1_repositories::{
        RelayContainerDrainSourceAuthorizationRow, RelayContainerDrainSourceRegistrationFenceState,
        RelayContainerDrainSourceRegistrationHeadState,
        RelayContainerDrainSourceRegistrationPasskeyState,
        RelayContainerDrainSourceRegistrationRootState,
        RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_MIGRATION,
        RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256,
    };

    const NOW: i64 = 1_800_000_000;

    fn digest(label: &str) -> String {
        format!("{:x}", Sha256::digest(label.as_bytes()))
    }

    fn live_root_session() -> VerifiedApplicationRootSessionV1 {
        VerifiedApplicationRootSessionV1::from_live_root_claims(&SessionClaims {
            id: 1,
            username: "root".to_string(),
            role: ROLE_ROOT_USER,
            status: USER_STATUS_ENABLED,
            group: "default".to_string(),
            session_epoch: 7,
            session_id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0x5a; 32]),
            iat: NOW - 60,
            exp: NOW + 600,
        })
        .unwrap()
    }

    fn snapshot() -> RelayContainerDrainSourceRegistrationPhaseSnapshot {
        let credential_id = b"credential-id";
        RelayContainerDrainSourceRegistrationPhaseSnapshot {
            authorization: RelayContainerDrainSourceAuthorizationRow {
                authorization_id_sha256: digest("authorization"),
                contract_version: 1,
                authorization_contract: DRAIN_SOURCE_AUTHORIZATION_CONTRACT.to_string(),
                authorization_migration: RELAY_CONTAINER_DRAIN_SOURCE_AUTHORIZATION_MIGRATION
                    .to_string(),
                environment: "staging".to_string(),
                scope_kind: "global".to_string(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_string(),
                admission_fence_id_sha256: digest("admission-fence"),
                fence_generation: 1,
                expected_fence_state_digest_sha256: digest("fence-state"),
                expected_head_version: 1,
                expected_head_digest_sha256: digest("authorization-head"),
                source_scan_id_sha256: digest("source-scan"),
                collector_service_name: "drain-source-collector".to_string(),
                collector_version_id: "collector-build-1".to_string(),
                collector_run_id_sha256: digest("collector-run"),
                started_by_credential_id_sha256: digest("collector-credential"),
                page_size: 128,
                shard_count: 16,
                accepted_source_schema_sha256: RELAY_CONTAINER_DRAIN_SOURCE_SCHEMA_SHA256
                    .to_string(),
                authorizer_issuer: "cinatoken-drain-source-authorizer".to_string(),
                authorizer_key_id: "drain-source-authorizer-v1".to_string(),
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
                environment: "staging".to_string(),
                scope_kind: "global".to_string(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_string(),
                current_fence_id_sha256: digest("admission-fence"),
                current_fence_generation: 1,
                head_version: 1,
                head_digest_sha256: digest("authorization-head"),
            }),
            fence: Some(RelayContainerDrainSourceRegistrationFenceState {
                admission_fence_id_sha256: digest("admission-fence"),
                fence_kind: "admission".to_string(),
                environment: "staging".to_string(),
                scope_kind: "global".to_string(),
                scope_id_sha256: RELAY_CONTAINER_GLOBAL_ADMISSION_SCOPE_ID_SHA256.to_string(),
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

    fn draft() -> DrainSourceRegistrationApplicationBeginDraftV1 {
        DrainSourceRegistrationApplicationBeginDraftV1::new(
            DrainSourceRegistrationApplicationBeginDraftInputV1 {
                authorization_id_sha256: digest("authorization"),
                passkey_credential_id_sha256: passkey_credential_id_sha256(b"credential-id"),
                operation_id_sha256: digest("operation"),
                ceremony_id_sha256: digest("ceremony"),
                request_intent_sha256: digest("request-intent"),
                rp_id: "cinatoken.com".to_string(),
                origin: "https://admin.cinatoken.com".to_string(),
                action_digest_sha256: digest("action"),
                registration_request_sha256: digest("request"),
                admin_audit_digest_sha256: digest("audit"),
                admin_network_identity_hmac_sha256: AdminNetworkIdentityHmacSha256::derive(
                    &[0x42; 32],
                    "203.0.113.42",
                )
                .unwrap(),
                change_ticket_sha256: digest("change-ticket"),
                reason_code: "migration.source-capture".to_string(),
                verification_lifetime_seconds: 120,
                registration_execution_id_sha256: digest("registration-execution"),
                ceremony_nonce_sha256: digest("ceremony-nonce"),
            },
        )
        .unwrap()
    }

    #[test]
    fn exact_snapshot_materializes_one_coherent_prepared_checkpoint() {
        assert_eq!(
            derive_coordinator_begin_request_id_sha256(&"ab".repeat(32)).unwrap(),
            "c8188c6a2f344dbef217c00ec2275491e0cc99d9be2c26511ac856f98731927e"
        );
        let draft = draft();
        let materialized = materialize_application_begin(
            &snapshot(),
            live_root_session().anchor(),
            &draft,
            "application-build-1",
            &digest("application-credential"),
        )
        .unwrap();
        let proof =
            issue_before_challenge_phase_proof_for_test(&materialized.authority, &[0x6b; 32])
                .unwrap();
        let prepared = freeze_application_checkpoint(materialized, &proof).unwrap();

        assert!(prepared.is_prepared());
        assert_eq!(prepared.begin_intent().issued_at(), NOW);
        assert_eq!(prepared.webauthn().issued_at(), NOW);
        assert_eq!(prepared.coordinator_begin().command, "begin");
        assert_eq!(prepared.coordinator_begin().expected_generation, 0);
        assert_eq!(
            prepared.coordinator_begin().request_id_sha256,
            derive_coordinator_begin_request_id_sha256(&prepared.begin_intent().sha256().unwrap())
                .unwrap()
        );
        assert_eq!(
            prepared
                .coordinator_begin()
                .evidence
                .challenge_phase_proof_sha256,
            proof.token_sha256()
        );
    }

    #[test]
    fn draft_session_and_application_credential_drift_fail_closed() {
        let mut wrong_authorization = draft();
        wrong_authorization.authorization_id_sha256 = digest("other-authorization");
        assert!(matches!(
            materialize_application_begin(
                &snapshot(),
                live_root_session().anchor(),
                &wrong_authorization,
                "application-build-1",
                &digest("application-credential"),
            ),
            Err(ApplicationBeginPreparationError::AuthorityRejected)
        ));

        let mut wrong_epoch_claims = SessionClaims {
            id: 1,
            username: "root".to_string(),
            role: ROLE_ROOT_USER,
            status: USER_STATUS_ENABLED,
            group: "default".to_string(),
            session_epoch: 8,
            session_id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0x5a; 32]),
            iat: NOW - 60,
            exp: NOW + 600,
        };
        let wrong_session =
            VerifiedApplicationRootSessionV1::from_live_root_claims(&wrong_epoch_claims).unwrap();
        assert!(matches!(
            materialize_application_begin(
                &snapshot(),
                wrong_session.anchor(),
                &draft(),
                "application-build-1",
                &digest("application-credential"),
            ),
            Err(ApplicationBeginPreparationError::AuthorityRejected)
        ));

        wrong_epoch_claims.session_epoch = 7;
        assert!(matches!(
            materialize_application_begin(
                &snapshot(),
                live_root_session().anchor(),
                &draft(),
                "application-build-1",
                "",
            ),
            Err(ApplicationBeginPreparationError::Configuration)
        ));
    }
}
