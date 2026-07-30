//! Route-free authority coordinator for the 0074 Root registration ceremony.
//!
//! D1 remains the global linearization authority. This module only validates
//! one-statement first-primary snapshots before challenge issue, permit issue,
//! and the final atomic command.

use cinatoken_auth::{ROLE_ROOT_USER, USER_STATUS_ENABLED};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::admin_passkey::{decode_stored_passkey_binary, passkey_credential_id_sha256};
use crate::container_drain_source_authorization::{
    VerifiedDrainSourceAuthorization, DRAIN_SOURCE_AUTHORIZATION_CONTRACT,
};
use crate::container_drain_source_registration_action::{
    DrainSourceRegistrationActionV1, DrainSourceRegistrationStoredCredential,
};
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DrainSourceRegistrationCoordinatorPhase {
    BeforeChallenge,
    BeforeIssuer,
    BeforeCommit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DrainSourceRegistrationRootSession {
    pub(crate) root_admin_id: i64,
    pub(crate) session_epoch: i64,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) binding_sha256: String,
}

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedDrainSourceRegistrationPhase {
    pub(crate) phase: DrainSourceRegistrationCoordinatorPhase,
    pub(crate) semantic_fingerprint_sha256: String,
    pub(crate) authorization: VerifiedDrainSourceAuthorization,
    pub(crate) passkey: ValidatedDrainSourceRegistrationPasskey,
    pub(crate) receipt_sequence: i64,
    pub(crate) ledger_head_before_sha256: String,
    pub(crate) database_now: i64,
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
        }
    }
}

impl std::fmt::Display for DrainSourceRegistrationCoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DrainSourceRegistrationCoordinatorError {}

pub(crate) fn validate_before_challenge(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
    session: &DrainSourceRegistrationRootSession,
) -> Result<ValidatedDrainSourceRegistrationPhase, DrainSourceRegistrationCoordinatorError> {
    validate_phase(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
        session,
        DrainSourceRegistrationCoordinatorPhase::BeforeChallenge,
        None,
        None,
    )
}

pub(crate) fn validate_before_issuer(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
    session: &DrainSourceRegistrationRootSession,
    action: &DrainSourceRegistrationActionV1,
    expected_semantic_fingerprint_sha256: &str,
) -> Result<ValidatedDrainSourceRegistrationPhase, DrainSourceRegistrationCoordinatorError> {
    validate_phase(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
        session,
        DrainSourceRegistrationCoordinatorPhase::BeforeIssuer,
        Some(action),
        Some(expected_semantic_fingerprint_sha256),
    )
}

pub(crate) fn validate_before_commit(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
    session: &DrainSourceRegistrationRootSession,
    action: &DrainSourceRegistrationActionV1,
    expected_semantic_fingerprint_sha256: &str,
) -> Result<ValidatedDrainSourceRegistrationPhase, DrainSourceRegistrationCoordinatorError> {
    validate_phase(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
        session,
        DrainSourceRegistrationCoordinatorPhase::BeforeCommit,
        Some(action),
        Some(expected_semantic_fingerprint_sha256),
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_phase(
    snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
    expected_environment: &str,
    expected_authorization_id_sha256: &str,
    session: &DrainSourceRegistrationRootSession,
    phase: DrainSourceRegistrationCoordinatorPhase,
    action: Option<&DrainSourceRegistrationActionV1>,
    expected_semantic_fingerprint_sha256: Option<&str>,
) -> Result<ValidatedDrainSourceRegistrationPhase, DrainSourceRegistrationCoordinatorError> {
    if expected_environment != "staging"
        || snapshot.authorization.environment == "production"
        || expected_authorization_id_sha256 != expected_authorization_id_sha256.trim()
        || !valid_sha256(expected_authorization_id_sha256)
        || !valid_sha256(&session.binding_sha256)
        || session.root_admin_id <= 0
        || session.root_admin_id > MAXIMUM_SAFE_INTEGER
        || session.session_epoch < 0
        || session.session_epoch > MAXIMUM_SAFE_INTEGER
        || session.issued_at <= 0
        || session.issued_at > MAXIMUM_SAFE_INTEGER
        || session.expires_at <= session.issued_at
        || session.expires_at > MAXIMUM_SAFE_INTEGER
        || session.issued_at < session.session_epoch
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
    match phase {
        DrainSourceRegistrationCoordinatorPhase::BeforeChallenge => {
            if action.is_some() || expected_semantic_fingerprint_sha256.is_some() {
                return Err(DrainSourceRegistrationCoordinatorError::InvalidInput);
            }
        }
        DrainSourceRegistrationCoordinatorPhase::BeforeIssuer
        | DrainSourceRegistrationCoordinatorPhase::BeforeCommit => {
            if action.is_none() || !expected_semantic_fingerprint_sha256.is_some_and(valid_sha256) {
                return Err(DrainSourceRegistrationCoordinatorError::InvalidInput);
            }
        }
    }

    let authorization = validate_authorization(
        snapshot,
        expected_environment,
        expected_authorization_id_sha256,
    )?;
    let root = validate_root(snapshot.root.as_ref(), &authorization, session)?;
    validate_session(snapshot.database_now, session, root)?;
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
    if expected_semantic_fingerprint_sha256
        .is_some_and(|expected| expected != semantic_fingerprint_sha256)
    {
        return Err(DrainSourceRegistrationCoordinatorError::AuthorityDrift);
    }

    if let Some(action) = action {
        validate_action(
            action,
            &authorization,
            session,
            &passkey,
            receipt_sequence,
            &ledger_head_before_sha256,
            snapshot.database_now,
        )?;
    }

    Ok(ValidatedDrainSourceRegistrationPhase {
        phase,
        semantic_fingerprint_sha256,
        authorization,
        passkey,
        receipt_sequence,
        ledger_head_before_sha256,
        database_now: snapshot.database_now,
    })
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
    session: &DrainSourceRegistrationRootSession,
) -> Result<
    &'a RelayContainerDrainSourceRegistrationRootState,
    DrainSourceRegistrationCoordinatorError,
> {
    let root = root.ok_or(DrainSourceRegistrationCoordinatorError::RootStateChanged)?;
    if root.id != session.root_admin_id
        || root.id != authorization.authorized_by_admin_id
        || root.role != i64::from(ROLE_ROOT_USER)
        || root.status != i64::from(USER_STATUS_ENABLED)
        || root.deleted_at.is_some()
        || root.session_epoch < 0
        || root.session_epoch > MAXIMUM_SAFE_INTEGER
    {
        return Err(DrainSourceRegistrationCoordinatorError::RootStateChanged);
    }
    Ok(root)
}

fn validate_session(
    database_now: i64,
    session: &DrainSourceRegistrationRootSession,
    root: &RelayContainerDrainSourceRegistrationRootState,
) -> Result<(), DrainSourceRegistrationCoordinatorError> {
    if root.session_epoch != session.session_epoch
        || session.issued_at < root.session_epoch
        || database_now < session.issued_at
        || database_now >= session.expires_at
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
    session: &DrainSourceRegistrationRootSession,
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
        || action.root_session_epoch() != session.session_epoch
        || action.root_session_issued_at() != session.issued_at
        || action.root_session_expires_at() != session.expires_at
        || action.root_session_binding_sha256() != session.binding_sha256
        || action.passkey_credential_row_id() != passkey.row_id
        || action.passkey_credential_id_sha256() != passkey.credential_id_sha256
        || action.passkey_credential_registration_id_sha256()
            != passkey.credential_registration_id_sha256
        || action.passkey_credential_binding_sha256() != passkey.credential_binding_sha256
        || action.passkey_previous_use_generation() != passkey.use_generation
        || database_now >= action.verification_expires_at()
        || action.verification_expires_at() > authorization.permit_expires_at
        || action.verification_expires_at() > session.expires_at
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

    use super::*;
    use crate::container_drain_source_registration_action::{
        AdminNetworkIdentityHmacSha256, DrainSourceRegistrationActionInput,
    };

    const NOW: i64 = 2_100_000_000;

    fn digest(label: &str) -> String {
        format!("{:x}", Sha256::digest(label.as_bytes()))
    }

    fn session() -> DrainSourceRegistrationRootSession {
        DrainSourceRegistrationRootSession {
            root_admin_id: 1,
            session_epoch: 7,
            issued_at: NOW - 60,
            expires_at: NOW + 600,
            binding_sha256: digest("session-binding"),
        }
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

    fn action(
        validated: &ValidatedDrainSourceRegistrationPhase,
    ) -> DrainSourceRegistrationActionV1 {
        DrainSourceRegistrationActionV1::from_verified_authorization(
            &validated.authorization,
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
                receipt_sequence: validated.receipt_sequence,
                ledger_head_before_sha256: validated.ledger_head_before_sha256.clone(),
                root_session_epoch: session().session_epoch,
                root_session_issued_at: session().issued_at,
                root_session_expires_at: session().expires_at,
                root_session_binding_sha256: session().binding_sha256,
                passkey_credential_row_id: validated.passkey.row_id,
                passkey_credential_id_sha256: validated.passkey.credential_id_sha256.clone(),
                passkey_credential_registration_id_sha256: validated
                    .passkey
                    .credential_registration_id_sha256
                    .clone(),
                passkey_credential_binding_sha256: validated
                    .passkey
                    .credential_binding_sha256
                    .clone(),
                passkey_previous_use_generation: validated.passkey.use_generation,
                registered_by_service_name: "cinatoken-application".to_owned(),
                registered_by_version_id: "build-2026-07-30".to_owned(),
                registration_execution_id_sha256: digest("registration-execution"),
                registration_credential_id_sha256: digest("registration-credential"),
                ceremony_nonce_sha256: digest("ceremony-nonce"),
            },
        )
    }

    fn begin() -> ValidatedDrainSourceRegistrationPhase {
        let snapshot = snapshot();
        validate_before_challenge(
            &snapshot,
            "staging",
            &snapshot.authorization.authorization_id_sha256,
            &session(),
        )
        .unwrap()
    }

    #[test]
    fn three_phase_validation_ignores_only_time_and_bookmark_evidence() {
        let snapshot = snapshot();
        let begin = validate_before_challenge(
            &snapshot,
            "staging",
            &snapshot.authorization.authorization_id_sha256,
            &session(),
        )
        .unwrap();
        let action = action(&begin);

        let mut later = snapshot.clone();
        later.database_now += 1;
        later.read_bookmark_sha256 = digest("later-bookmark");
        let issuer = validate_before_issuer(
            &later,
            "staging",
            &later.authorization.authorization_id_sha256,
            &session(),
            &action,
            &begin.semantic_fingerprint_sha256,
        )
        .unwrap();
        let commit = validate_before_commit(
            &later,
            "staging",
            &later.authorization.authorization_id_sha256,
            &session(),
            &action,
            &begin.semantic_fingerprint_sha256,
        )
        .unwrap();

        assert_eq!(
            begin.semantic_fingerprint_sha256,
            issuer.semantic_fingerprint_sha256
        );
        assert_eq!(
            issuer.semantic_fingerprint_sha256,
            commit.semantic_fingerprint_sha256
        );
        assert_eq!(
            issuer.phase,
            DrainSourceRegistrationCoordinatorPhase::BeforeIssuer
        );
        assert_eq!(
            commit.phase,
            DrainSourceRegistrationCoordinatorPhase::BeforeCommit
        );
        assert_eq!(commit.database_now, NOW + 1);
        assert_eq!(
            commit.passkey.stored_credential().credential.credential_id,
            b"credential-id"
        );
    }

    #[test]
    fn root_session_and_production_drift_fail_closed() {
        let baseline = begin();
        let action = action(&baseline);
        let assert_error = |snapshot: &RelayContainerDrainSourceRegistrationPhaseSnapshot,
                            session: &DrainSourceRegistrationRootSession,
                            expected| {
            assert_eq!(
                validate_before_commit(
                    snapshot,
                    "staging",
                    &snapshot.authorization.authorization_id_sha256,
                    session,
                    &action,
                    &baseline.semantic_fingerprint_sha256,
                ),
                Err(expected)
            );
        };

        let mut changed = snapshot();
        changed.root.as_mut().unwrap().role -= 1;
        assert_error(
            &changed,
            &session(),
            DrainSourceRegistrationCoordinatorError::RootStateChanged,
        );

        let mut changed = snapshot();
        changed.root.as_mut().unwrap().status = 0;
        assert_error(
            &changed,
            &session(),
            DrainSourceRegistrationCoordinatorError::RootStateChanged,
        );

        let mut changed = snapshot();
        changed.root.as_mut().unwrap().deleted_at = Some(NOW);
        assert_error(
            &changed,
            &session(),
            DrainSourceRegistrationCoordinatorError::RootStateChanged,
        );

        let mut changed = snapshot();
        changed.root.as_mut().unwrap().session_epoch += 1;
        assert_error(
            &changed,
            &session(),
            DrainSourceRegistrationCoordinatorError::SessionStateChanged,
        );

        let mut expired_session = session();
        expired_session.expires_at = NOW;
        assert_error(
            &snapshot(),
            &expired_session,
            DrainSourceRegistrationCoordinatorError::SessionStateChanged,
        );

        let mut production = snapshot();
        production.authorization.environment = "production".to_owned();
        assert_eq!(
            validate_before_challenge(
                &production,
                "production",
                &production.authorization.authorization_id_sha256,
                &session(),
            ),
            Err(DrainSourceRegistrationCoordinatorError::UnsupportedEnvironment)
        );
    }

    #[test]
    fn passkey_fence_and_consumption_drift_fail_closed() {
        let baseline = begin();
        let action = action(&baseline);
        let check = |changed: &RelayContainerDrainSourceRegistrationPhaseSnapshot, expected| {
            assert_eq!(
                validate_before_issuer(
                    changed,
                    "staging",
                    &changed.authorization.authorization_id_sha256,
                    &session(),
                    &action,
                    &baseline.semantic_fingerprint_sha256,
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
            let mut changed = snapshot();
            mutate(changed.passkey.as_mut().unwrap());
            check(
                &changed,
                DrainSourceRegistrationCoordinatorError::AuthorityDrift,
            );
        }

        let mut changed = snapshot();
        changed.passkey.as_mut().unwrap().clone_warning = 1;
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::PasskeyStateChanged,
        );

        let mut changed = snapshot();
        changed.passkey.as_mut().unwrap().deleted_at = Some(NOW);
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::PasskeyStateChanged,
        );

        let mut changed = snapshot();
        changed.head.as_mut().unwrap().head_digest_sha256 = digest("other-head");
        check(
            &changed,
            DrainSourceRegistrationCoordinatorError::FenceStateChanged,
        );

        let mut changed = snapshot();
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
            let mut changed = snapshot();
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
        let validated = validate_before_challenge(
            &snapshot,
            "staging",
            &snapshot.authorization.authorization_id_sha256,
            &session(),
        )
        .unwrap();
        assert_eq!(validated.receipt_sequence, 4);
        assert_eq!(
            validated.ledger_head_before_sha256,
            digest("previous-terminal")
        );

        snapshot.latest_ledger.as_mut().unwrap().event_kind = "registration".to_owned();
        assert_eq!(
            validate_before_challenge(
                &snapshot,
                "staging",
                &snapshot.authorization.authorization_id_sha256,
                &session(),
            ),
            Err(DrainSourceRegistrationCoordinatorError::LedgerStateChanged)
        );
    }

    #[test]
    fn action_and_validity_windows_are_rechecked_at_each_later_phase() {
        let baseline = begin();

        let mut expired = snapshot();
        expired.database_now = expired.authorization.permit_expires_at;
        assert_eq!(
            validate_before_challenge(
                &expired,
                "staging",
                &expired.authorization.authorization_id_sha256,
                &session(),
            ),
            Err(DrainSourceRegistrationCoordinatorError::AuthorityExpired)
        );

        let mut different_session = session();
        different_session.binding_sha256 = digest("other-session");
        assert_eq!(
            validate_before_commit(
                &snapshot(),
                "staging",
                &snapshot().authorization.authorization_id_sha256,
                &different_session,
                &action(&baseline),
                &baseline.semantic_fingerprint_sha256,
            ),
            Err(DrainSourceRegistrationCoordinatorError::ActionMismatch)
        );
    }
}
