//! Route-free Application orchestration for the registration begin boundary.
//!
//! The first coordinator dispatch is forbidden until the exact Application
//! checkpoint is durably retained. Unknown transport or CAS outcomes converge
//! through checkpoint readback and exact request replay; this module never
//! creates a replacement operation during reconciliation.

use cinatoken_root_session_phase_proof::{
    derive_phase_proof_id_sha256, sign_root_session_phase_proof, verify_root_session_phase_proof,
    RootSessionAnchorExpectation, RootSessionPhase, RootSessionPhaseExpectation,
    RootSessionPhaseInput, RootSessionPhaseKey, RootSessionPhaseKeyRing,
    VerifiedRootSessionPhaseProof,
};
use worker::{Env, WorkerVersionMetadata};

use crate::container_drain_source_registration_action::DrainSourceRegistrationCeremonyError;
use crate::container_drain_source_registration_application_ceremony::DrainSourceRegistrationApplicationCeremonyV1;
use crate::container_drain_source_registration_coordinator::PreparedDrainSourceRegistrationChallengeAuthority;
use crate::container_drain_source_registration_coordinator_client as coordinator_client;
use crate::container_drain_source_registration_coordinator_client::{
    CoordinatorClientError, CoordinatorClientFailureClass, COORDINATOR_AUTHORITY_AUDIENCE_ENV,
    COORDINATOR_AUTHORITY_ISSUER_ENV,
};

pub(crate) const APPLICATION_BEGIN_ENABLED_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_APPLICATION_BEGIN_ENABLED";
pub(crate) const PHASE_PROOF_CURRENT_KID_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_KID";
pub(crate) const PHASE_PROOF_CURRENT_KEY_VERSION_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_KEY_VERSION";
pub(crate) const PHASE_PROOF_CURRENT_SECRET_ENV: &str =
    "DRAIN_SOURCE_REGISTRATION_PHASE_PROOF_CURRENT_SECRET";

const PHASE_PROOF_RANDOM_BYTES: usize = 32;

#[derive(Clone)]
struct ApplicationPhaseProofSignerConfig {
    issuer: String,
    audience: String,
    application_version_id: String,
    kid: String,
    key_version: u32,
    secret: String,
}

impl ApplicationPhaseProofSignerConfig {
    fn new(
        issuer: impl Into<String>,
        audience: impl Into<String>,
        application_version_id: impl Into<String>,
        kid: impl Into<String>,
        key_version: u32,
        secret: impl Into<String>,
    ) -> Result<Self, ApplicationBeginOrchestratorError> {
        let config = Self {
            issuer: issuer.into(),
            audience: audience.into(),
            application_version_id: application_version_id.into(),
            kid: kid.into(),
            key_version,
            secret: secret.into(),
        };
        if !valid_identifier(&config.issuer)
            || !valid_identifier(&config.audience)
            || config.issuer == config.audience
            || !valid_identifier(&config.application_version_id)
            || !valid_identifier(&config.kid)
            || config.key_version == 0
            || !(32..=256).contains(&config.secret.as_bytes().len())
        {
            return Err(ApplicationBeginOrchestratorError::PhaseProofConfiguration);
        }
        Ok(config)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ApplicationBeginOrchestratorError {
    Disabled,
    PhaseProofConfiguration,
    PhaseProofIssuance,
    InvalidCheckpoint,
    CheckpointWriteIndeterminate,
    CheckpointReadIndeterminate,
    CheckpointConfirmationInvalid,
    CheckpointConfirmationIndeterminate,
    Coordinator(CoordinatorClientError),
}

impl ApplicationBeginOrchestratorError {
    pub(crate) const fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "registration_begin_disabled",
            Self::PhaseProofConfiguration => "registration_phase_proof_configuration_invalid",
            Self::PhaseProofIssuance => "registration_phase_proof_issuance_failed",
            Self::InvalidCheckpoint => "registration_begin_checkpoint_invalid",
            Self::CheckpointWriteIndeterminate => {
                "registration_begin_checkpoint_write_indeterminate"
            }
            Self::CheckpointReadIndeterminate => "registration_begin_checkpoint_read_indeterminate",
            Self::CheckpointConfirmationInvalid => {
                "registration_begin_checkpoint_confirmation_invalid"
            }
            Self::CheckpointConfirmationIndeterminate => {
                "registration_begin_checkpoint_confirmation_indeterminate"
            }
            Self::Coordinator(error) => error.code(),
        }
    }

    pub(crate) const fn class(&self) -> CoordinatorClientFailureClass {
        match self {
            Self::Disabled
            | Self::PhaseProofConfiguration
            | Self::PhaseProofIssuance
            | Self::InvalidCheckpoint => CoordinatorClientFailureClass::NotDispatched,
            Self::CheckpointConfirmationInvalid => CoordinatorClientFailureClass::ProtocolViolation,
            Self::CheckpointWriteIndeterminate
            | Self::CheckpointReadIndeterminate
            | Self::CheckpointConfirmationIndeterminate => {
                CoordinatorClientFailureClass::Indeterminate
            }
            Self::Coordinator(error) => error.class(),
        }
    }
}

impl std::fmt::Display for ApplicationBeginOrchestratorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::fmt::Debug for ApplicationBeginOrchestratorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ApplicationBeginOrchestratorError {}

pub(crate) fn issue_before_challenge_phase_proof(
    env: &Env,
    authority: &PreparedDrainSourceRegistrationChallengeAuthority,
) -> Result<VerifiedRootSessionPhaseProof, ApplicationBeginOrchestratorError> {
    let config = phase_proof_signer_config(env)?;
    let mut random = [0_u8; PHASE_PROOF_RANDOM_BYTES];
    getrandom::getrandom(&mut random)
        .map_err(|_| ApplicationBeginOrchestratorError::PhaseProofIssuance)?;
    issue_before_challenge_phase_proof_with_random(authority, &config, &random)
}

fn issue_before_challenge_phase_proof_with_random(
    authority: &PreparedDrainSourceRegistrationChallengeAuthority,
    config: &ApplicationPhaseProofSignerConfig,
    random: &[u8],
) -> Result<VerifiedRootSessionPhaseProof, ApplicationBeginOrchestratorError> {
    let proof_id_sha256 = derive_phase_proof_id_sha256(RootSessionPhase::BeforeChallenge, random)
        .map_err(|_| ApplicationBeginOrchestratorError::PhaseProofIssuance)?;
    let phase_subject = authority
        .phase_subject()
        .map_err(|_| ApplicationBeginOrchestratorError::PhaseProofIssuance)?;
    let begin_intent = authority.begin_intent();
    let root_session = authority.root_session();
    let key = RootSessionPhaseKey {
        kid: &config.kid,
        key_version: config.key_version,
        secret: config.secret.as_bytes(),
    };
    let token = sign_root_session_phase_proof(
        key,
        RootSessionPhaseInput {
            issuer: &config.issuer,
            audience: &config.audience,
            application_version_id: &config.application_version_id,
            environment: begin_intent.environment(),
            phase: RootSessionPhase::BeforeChallenge,
            phase_subject,
            operation_id_sha256: begin_intent.operation_id_sha256(),
            authorization_id_sha256: begin_intent.authorization_id_sha256(),
            ceremony_id_sha256: begin_intent.ceremony_id_sha256(),
            request_intent_sha256: begin_intent.request_intent_sha256(),
            proof_id_sha256: &proof_id_sha256,
            root_admin_id: root_session.root_admin_id(),
            root_role: root_session.root_role(),
            root_status: root_session.root_status(),
            root_deleted_at: root_session.root_deleted_at(),
            root_session_epoch: root_session.root_session_epoch(),
            root_session_issued_at: root_session.root_session_issued_at(),
            root_session_expires_at: root_session.root_session_expires_at(),
            root_session_binding_sha256: root_session.root_session_binding_sha256(),
            root_session_id_sha256: root_session.root_session_id_sha256(),
            d1_observed_at: authority.database_now(),
            parent_proof_sha256: None,
            semantic_authority_fingerprint_sha256: authority.semantic_fingerprint_sha256(),
            authority_expires_at: authority.authorization().permit_expires_at,
        },
    )
    .map_err(|_| ApplicationBeginOrchestratorError::PhaseProofIssuance)?;
    verify_root_session_phase_proof(
        RootSessionPhaseKeyRing {
            current: key,
            previous: None,
        },
        &token,
        RootSessionPhaseExpectation {
            issuer: &config.issuer,
            audience: &config.audience,
            application_version_id: &config.application_version_id,
            environment: begin_intent.environment(),
            phase: RootSessionPhase::BeforeChallenge,
            phase_subject,
            operation_id_sha256: begin_intent.operation_id_sha256(),
            authorization_id_sha256: begin_intent.authorization_id_sha256(),
            ceremony_id_sha256: begin_intent.ceremony_id_sha256(),
            request_intent_sha256: begin_intent.request_intent_sha256(),
            parent_proof_sha256: None,
            semantic_authority_fingerprint_sha256: authority.semantic_fingerprint_sha256(),
            authority_expires_at: authority.authorization().permit_expires_at,
            root_admin_id: root_session.root_admin_id(),
            expected_session: Some(RootSessionAnchorExpectation {
                root_session_epoch: root_session.root_session_epoch(),
                root_session_issued_at: root_session.root_session_issued_at(),
                root_session_expires_at: root_session.root_session_expires_at(),
                root_session_binding_sha256: root_session.root_session_binding_sha256(),
                root_session_id_sha256: root_session.root_session_id_sha256(),
            }),
            now: authority.database_now(),
        },
    )
    .map_err(|_| ApplicationBeginOrchestratorError::PhaseProofIssuance)
}

fn phase_proof_signer_config(
    env: &Env,
) -> Result<ApplicationPhaseProofSignerConfig, ApplicationBeginOrchestratorError> {
    application_begin_preflight(env)?;
    if runtime_value(env, "ENVIRONMENT").as_deref() != Some("staging") {
        return Err(ApplicationBeginOrchestratorError::PhaseProofConfiguration);
    }
    let application_version_id = env
        .get_binding::<WorkerVersionMetadata>("CF_VERSION_METADATA")
        .ok()
        .map(|metadata| metadata.id())
        .filter(|value| valid_identifier(value))
        .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?;
    let key_version = runtime_value(env, PHASE_PROOF_CURRENT_KEY_VERSION_ENV)
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?;
    let secret = env
        .secret(PHASE_PROOF_CURRENT_SECRET_ENV)
        .ok()
        .map(|value| value.to_string())
        .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?;
    ApplicationPhaseProofSignerConfig::new(
        runtime_value(env, COORDINATOR_AUTHORITY_ISSUER_ENV)
            .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?,
        runtime_value(env, COORDINATOR_AUTHORITY_AUDIENCE_ENV)
            .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?,
        application_version_id,
        runtime_value(env, PHASE_PROOF_CURRENT_KID_ENV)
            .ok_or(ApplicationBeginOrchestratorError::PhaseProofConfiguration)?,
        key_version,
        secret,
    )
}

fn application_begin_preflight(env: &Env) -> Result<(), ApplicationBeginOrchestratorError> {
    if runtime_value(env, APPLICATION_BEGIN_ENABLED_ENV).as_deref() != Some("true") {
        return Err(ApplicationBeginOrchestratorError::Disabled);
    }
    coordinator_client::preflight(env).map_err(ApplicationBeginOrchestratorError::Coordinator)
}

pub(crate) async fn dispatch_prepared_begin(
    env: &Env,
    prepared: &DrainSourceRegistrationApplicationCeremonyV1,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginOrchestratorError> {
    // Fresh dispatch requires the same signer capability that created the
    // retained proof. Reconciliation below intentionally needs only the
    // already-retained checkpoint and coordinator client.
    drop(phase_proof_signer_config(env)?);
    if !prepared.is_prepared() {
        return Err(ApplicationBeginOrchestratorError::InvalidCheckpoint);
    }

    // This must remain the first await in the fresh path. Once it returns, the
    // exact coordinator request is recoverable even if every later response is
    // lost.
    prepared
        .store_prepared_once(env)
        .await
        .map_err(|_| ApplicationBeginOrchestratorError::CheckpointWriteIndeterminate)?;
    dispatch_retained_prepared_begin(env, prepared).await
}

pub(crate) async fn reconcile_prepared_begin(
    env: &Env,
    ceremony_key: &str,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginOrchestratorError> {
    application_begin_preflight(env)?;
    let retained = DrainSourceRegistrationApplicationCeremonyV1::load_existing(env, ceremony_key)
        .await
        .map_err(|_| ApplicationBeginOrchestratorError::CheckpointReadIndeterminate)?;
    if retained.is_challenge_issued() {
        return Ok(retained);
    }
    if !retained.is_prepared() {
        return Err(ApplicationBeginOrchestratorError::InvalidCheckpoint);
    }
    dispatch_retained_prepared_begin(env, &retained).await
}

async fn dispatch_retained_prepared_begin(
    env: &Env,
    prepared: &DrainSourceRegistrationApplicationCeremonyV1,
) -> Result<DrainSourceRegistrationApplicationCeremonyV1, ApplicationBeginOrchestratorError> {
    let status = coordinator_client::begin(env, prepared.coordinator_begin())
        .await
        .map_err(ApplicationBeginOrchestratorError::Coordinator)?;
    let confirmed = prepared
        .confirm_challenge_issued(status)
        .map_err(map_confirmation_error)?;
    prepared
        .persist_challenge_issued(env, &confirmed)
        .await
        .map_err(|_| ApplicationBeginOrchestratorError::CheckpointConfirmationIndeterminate)?;
    Ok(confirmed)
}

fn map_confirmation_error(
    _error: DrainSourceRegistrationCeremonyError,
) -> ApplicationBeginOrchestratorError {
    ApplicationBeginOrchestratorError::CheckpointConfirmationInvalid
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
pub(crate) fn issue_before_challenge_phase_proof_for_test(
    authority: &PreparedDrainSourceRegistrationChallengeAuthority,
    random: &[u8],
) -> Result<VerifiedRootSessionPhaseProof, ApplicationBeginOrchestratorError> {
    let config = ApplicationPhaseProofSignerConfig::new(
        "cinatoken-rust-api-staging",
        "cinatoken-drain-source-registration-coordinator-staging",
        "application-build-1",
        "root-session-phase-proof-v1",
        1,
        "0123456789abcdef0123456789abcdef",
    )?;
    issue_before_challenge_phase_proof_with_random(authority, &config, random)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_classes_preserve_dispatch_and_reconciliation_semantics() {
        for error in [
            CoordinatorClientError::Disabled,
            CoordinatorClientError::Configuration,
            CoordinatorClientError::Binding,
            CoordinatorClientError::Request,
        ] {
            assert_eq!(
                ApplicationBeginOrchestratorError::Coordinator(error).class(),
                CoordinatorClientFailureClass::NotDispatched
            );
        }
        for error in [
            CoordinatorClientError::Timeout,
            CoordinatorClientError::Transport,
            CoordinatorClientError::Rejected {
                status: 503,
                code: "coordinator_unavailable".to_string(),
            },
        ] {
            assert_eq!(
                ApplicationBeginOrchestratorError::Coordinator(error).class(),
                CoordinatorClientFailureClass::Indeterminate
            );
        }
        assert_eq!(
            ApplicationBeginOrchestratorError::Coordinator(CoordinatorClientError::Rejected {
                status: 409,
                code: "coordinator_conflict".to_string(),
            },)
            .class(),
            CoordinatorClientFailureClass::DeterministicRejection
        );
        assert_eq!(
            ApplicationBeginOrchestratorError::CheckpointConfirmationInvalid.class(),
            CoordinatorClientFailureClass::ProtocolViolation
        );
        assert_eq!(
            ApplicationBeginOrchestratorError::CheckpointWriteIndeterminate.class(),
            CoordinatorClientFailureClass::Indeterminate
        );
    }

    #[test]
    fn fresh_dispatch_is_persist_before_await_and_recovery_reuses_exact_bytes() {
        let source =
            include_str!("container_drain_source_registration_application_orchestrator.rs");
        let implementation = &source[..source.find("#[cfg(test)]").unwrap()];
        let dispatch_start = source
            .find("pub(crate) async fn dispatch_prepared_begin")
            .unwrap();
        let reconcile_start = source
            .find("pub(crate) async fn reconcile_prepared_begin")
            .unwrap();
        let dispatch = &source[dispatch_start..reconcile_start];
        assert!(
            dispatch.find(".store_prepared_once(env)").unwrap()
                < dispatch
                    .find("dispatch_retained_prepared_begin(env, prepared).await")
                    .unwrap()
        );
        assert_eq!(dispatch.matches(".await").count(), 2);

        let retained_dispatch_start = source
            .find("async fn dispatch_retained_prepared_begin")
            .unwrap();
        let reconcile = &source[reconcile_start..retained_dispatch_start];
        assert!(reconcile.contains("load_existing(env, ceremony_key)"));
        assert!(reconcile.contains("retained.is_challenge_issued()"));
        assert!(reconcile.contains("dispatch_retained_prepared_begin(env, &retained).await"));
        assert!(!reconcile.contains("getrandom"));
        assert!(!reconcile.contains("derive_operation_id"));
        for forbidden in [
            "Request::new",
            "fetch(",
            "operation_id_sha256 =",
            "Cookie",
            "Authorization",
        ] {
            assert!(
                !implementation.contains(forbidden),
                "route-free begin orchestrator gained forbidden capability: {forbidden}"
            );
        }
    }
}
