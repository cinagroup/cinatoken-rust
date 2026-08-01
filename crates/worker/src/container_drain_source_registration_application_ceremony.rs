//! Versioned Application-owned checkpoint for drain-source registration.
//!
//! The checkpoint retains only the WebAuthn challenge and redacted authority
//! anchors. A deterministic claim is replayable until expiry; raw browser,
//! assertion, credential, and signing-secret material never enters this state.

use cinatoken_drain_source_registration_coordinator::{
    canonical_json_bytes, derive_coordinator_object_name_v1, sha256_hex_bytes,
    validate_wire_request_v1, BeginRequestV1, CoordinatorPhase, CoordinatorStatusResponseV1,
    BEGIN_PATH,
};
use cinatoken_root_session_phase_proof::{
    RootSessionPhase, RootSessionPhaseClaims, RootSessionPhaseProtectedHeader,
    VerifiedRootSessionPhaseProof, ENABLED_STATUS, GLOBAL_SCOPE_ID_SHA256, PRIVATE_BEGIN_PATH,
    PRIVATE_METHOD, PROOF_ALGORITHM, PROOF_TYPE, PROOF_VERSION, PROTOCOL, ROOT_ROLE, SCOPE_KIND,
    STAGING_ENVIRONMENT,
};
use serde::{Deserialize, Serialize};
use worker::Env;

use crate::container_drain_source_registration_action::{
    DrainSourceRegistrationBeginIntentV1, DrainSourceRegistrationCeremonyError,
    DrainSourceRegistrationCeremonyState,
};
use crate::passkey_ceremony::{self, MAX_PAYLOAD_BYTES, MAX_TTL_SECONDS};

const APPLICATION_CEREMONY_CONTRACT: &str =
    "relay-container-drain-source-registration-application-ceremony-v1";
const APPLICATION_OBJECT_PREFIX: &str = "drain-source-registration-application:v1";
const APPLICATION_OBJECT_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:application-ceremony:v1";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ApplicationCeremonyPhase {
    Prepared,
    ChallengeIssued,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RootSessionPhaseProofAnchorV1 {
    protected: RootSessionPhaseProtectedHeader,
    claims: RootSessionPhaseClaims,
    token_sha256: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DrainSourceRegistrationApplicationCeremonyV1 {
    schema_version: u32,
    contract: String,
    phase: ApplicationCeremonyPhase,
    application_generation: u32,
    application_object_name: String,
    created_at: i64,
    expires_at: i64,
    begin_intent: DrainSourceRegistrationBeginIntentV1,
    webauthn: DrainSourceRegistrationCeremonyState,
    root_session_phase_proof: RootSessionPhaseProofAnchorV1,
    semantic_authority_fingerprint_sha256: String,
    coordinator_identity_sha256: String,
    coordinator_object_name: String,
    coordinator_begin_body_sha256: String,
    coordinator_begin: BeginRequestV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    coordinator_status: Option<CoordinatorStatusResponseV1>,
}

impl DrainSourceRegistrationApplicationCeremonyV1 {
    pub(crate) fn prepare(
        webauthn: DrainSourceRegistrationCeremonyState,
        begin_intent: DrainSourceRegistrationBeginIntentV1,
        before_challenge_phase_proof: &VerifiedRootSessionPhaseProof,
        coordinator_begin: BeginRequestV1,
        created_at: i64,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let expires_at = webauthn
            .action()
            .writer_projection()
            .verification_expires_at();
        let application_object_name = derive_application_object_name_v1(
            begin_intent.environment(),
            webauthn.action().writer_projection().root_admin_id(),
            begin_intent.operation_id_sha256(),
            begin_intent.ceremony_id_sha256(),
            begin_intent.authorization_id_sha256(),
        )
        .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let coordinator_object_name =
            derive_coordinator_object_name_v1(&coordinator_begin.identity)
                .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let coordinator_begin_body = canonical_json_bytes(&coordinator_begin)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let coordinator_identity = canonical_json_bytes(&coordinator_begin.identity)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let claims = before_challenge_phase_proof.claims();
        let state = Self {
            schema_version: 1,
            contract: APPLICATION_CEREMONY_CONTRACT.to_string(),
            phase: ApplicationCeremonyPhase::Prepared,
            application_generation: 0,
            application_object_name,
            created_at,
            expires_at,
            begin_intent,
            webauthn,
            root_session_phase_proof: RootSessionPhaseProofAnchorV1 {
                protected: before_challenge_phase_proof.protected().clone(),
                claims: claims.clone(),
                token_sha256: before_challenge_phase_proof.token_sha256().to_string(),
            },
            semantic_authority_fingerprint_sha256: claims
                .semantic_authority_fingerprint_sha256
                .clone(),
            coordinator_identity_sha256: sha256_hex_bytes(&coordinator_identity),
            coordinator_object_name,
            coordinator_begin_body_sha256: sha256_hex_bytes(&coordinator_begin_body),
            coordinator_begin,
            coordinator_status: None,
        };
        state.validate_at(created_at)?;
        Ok(state)
    }

    pub(crate) fn ceremony_key(&self) -> &str {
        &self.application_object_name
    }

    pub(crate) fn begin_intent(&self) -> &DrainSourceRegistrationBeginIntentV1 {
        &self.begin_intent
    }

    pub(crate) fn webauthn(&self) -> &DrainSourceRegistrationCeremonyState {
        &self.webauthn
    }

    pub(crate) fn phase_proof_sha256(&self) -> &str {
        &self.root_session_phase_proof.token_sha256
    }

    pub(crate) fn coordinator_begin(&self) -> &BeginRequestV1 {
        &self.coordinator_begin
    }

    pub(crate) fn coordinator_status(&self) -> Option<&CoordinatorStatusResponseV1> {
        self.coordinator_status.as_ref()
    }

    pub(crate) fn is_prepared(&self) -> bool {
        self.phase == ApplicationCeremonyPhase::Prepared
    }

    pub(crate) fn is_challenge_issued(&self) -> bool {
        self.phase == ApplicationCeremonyPhase::ChallengeIssued
    }

    pub(crate) fn confirm_challenge_issued(
        &self,
        mut coordinator_status: CoordinatorStatusResponseV1,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        self.validate_at(self.created_at)?;
        if !self.is_prepared() || self.application_generation != 0 {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }

        // Replay is transport history, not ceremony authority. Normalizing it
        // makes a lost-response retry converge on one persisted checkpoint.
        coordinator_status.replayed = false;
        let mut confirmed = self.clone();
        confirmed.phase = ApplicationCeremonyPhase::ChallengeIssued;
        confirmed.application_generation = 1;
        confirmed.coordinator_status = Some(coordinator_status);
        confirmed.validate_at(self.created_at)?;
        Ok(confirmed)
    }

    pub(crate) async fn store_prepared_once(
        &self,
        env: &Env,
    ) -> Result<(), DrainSourceRegistrationCeremonyError> {
        let now = unix_timestamp();
        self.validate_at(now)?;
        if !self.is_prepared() {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        let payload = self.payload()?;
        let ttl_seconds = self.remaining_ttl_seconds(now)?;
        passkey_ceremony::put_once_json(env, self.ceremony_key(), &payload, ttl_seconds).await?;
        Ok(())
    }

    pub(crate) async fn load_prepared(
        env: &Env,
        ceremony_key: &str,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let state = Self::load_existing(env, ceremony_key).await?;
        if !state.is_prepared() {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(state)
    }

    pub(crate) async fn load_existing(
        env: &Env,
        ceremony_key: &str,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let payload = passkey_ceremony::read_json(env, ceremony_key).await?;
        Self::from_payload(&payload, ceremony_key, unix_timestamp())
    }

    pub(crate) async fn persist_challenge_issued(
        &self,
        env: &Env,
        confirmed: &Self,
    ) -> Result<(), DrainSourceRegistrationCeremonyError> {
        let now = unix_timestamp();
        self.validate_at(now)?;
        confirmed.validate_at(now)?;
        let status = confirmed
            .coordinator_status
            .clone()
            .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        if self.confirm_challenge_issued(status)? != *confirmed {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        let prepared_payload = self.payload()?;
        let confirmed_payload = confirmed.payload()?;
        passkey_ceremony::replace_json_if(
            env,
            self.ceremony_key(),
            &sha256_hex_bytes(prepared_payload.as_bytes()),
            &confirmed_payload,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn claim(
        env: &Env,
        ceremony_key: &str,
        finish_claim_id_sha256: &str,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let observed_payload = passkey_ceremony::read_json(env, ceremony_key).await?;
        let observed = Self::from_payload(&observed_payload, ceremony_key, unix_timestamp())?;
        if observed.phase != ApplicationCeremonyPhase::ChallengeIssued {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        let claimed =
            passkey_ceremony::claim_json(env, ceremony_key, finish_claim_id_sha256).await?;
        let state = Self::from_payload(&claimed.payload, ceremony_key, unix_timestamp())?;
        if state.phase != ApplicationCeremonyPhase::ChallengeIssued || state != observed {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(state)
    }

    fn payload(&self) -> Result<String, DrainSourceRegistrationCeremonyError> {
        let payload = serde_json::to_string(self)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        if payload.is_empty() || payload.len() > MAX_PAYLOAD_BYTES {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(payload)
    }

    fn from_payload(
        payload: &str,
        ceremony_key: &str,
        now: i64,
    ) -> Result<Self, DrainSourceRegistrationCeremonyError> {
        let state: Self = serde_json::from_str(payload)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        state.validate_at(now)?;
        if state.ceremony_key() != ceremony_key || state.payload()? != payload {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(state)
    }

    fn remaining_ttl_seconds(&self, now: i64) -> Result<u64, DrainSourceRegistrationCeremonyError> {
        let ttl_seconds = u64::try_from(self.expires_at - now)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        if ttl_seconds == 0 || ttl_seconds > MAX_TTL_SECONDS {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(ttl_seconds)
    }

    fn validate_at(&self, now: i64) -> Result<(), DrainSourceRegistrationCeremonyError> {
        self.validate()?;
        if now < self.created_at || now >= self.expires_at {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), DrainSourceRegistrationCeremonyError> {
        self.webauthn.validate()?;
        self.begin_intent.validate()?;
        let action = self.webauthn.action().writer_projection();
        let proof = &self.root_session_phase_proof;
        let claims = &proof.claims;
        let expected_expires_at_ms = self
            .expires_at
            .checked_mul(1_000)
            .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let expected_application_object_name = derive_application_object_name_v1(
            self.begin_intent.environment(),
            action.root_admin_id(),
            self.begin_intent.operation_id_sha256(),
            self.begin_intent.ceremony_id_sha256(),
            self.begin_intent.authorization_id_sha256(),
        )
        .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let expected_coordinator_object_name =
            derive_coordinator_object_name_v1(&self.coordinator_begin.identity)
                .ok_or(DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let coordinator_begin_body = canonical_json_bytes(&self.coordinator_begin)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;
        let coordinator_identity = canonical_json_bytes(&self.coordinator_begin.identity)
            .map_err(|_| DrainSourceRegistrationCeremonyError::InvalidCeremony)?;

        let valid_application_phase = match (&self.phase, &self.coordinator_status) {
            (ApplicationCeremonyPhase::Prepared, None) => self.application_generation == 0,
            (ApplicationCeremonyPhase::ChallengeIssued, Some(status)) => {
                self.application_generation == 1
                    && valid_challenge_issued_status(
                        status,
                        self.begin_intent.operation_id_sha256(),
                        expected_expires_at_ms,
                    )
            }
            _ => false,
        };

        if self.schema_version != 1
            || self.contract != APPLICATION_CEREMONY_CONTRACT
            || !valid_application_phase
            || self.application_object_name != expected_application_object_name
            || self.created_at <= 0
            || self.created_at > MAXIMUM_SAFE_INTEGER
            || self.created_at != self.webauthn.issued_at()
            || self.created_at != self.begin_intent.issued_at()
            || self.expires_at != action.verification_expires_at()
            || !self.begin_intent.matches_action(self.webauthn.action())
            || self.begin_intent.rp_id() != self.webauthn.rp_id()
            || self.begin_intent.origin() != self.webauthn.origin()
            || proof.protected.typ != PROOF_TYPE
            || proof.protected.alg != PROOF_ALGORITHM
            || proof.protected.key_version == 0
            || !valid_identifier(&proof.protected.kid)
            || claims.proof_version != PROOF_VERSION
            || claims.protocol != PROTOCOL
            || claims.environment != STAGING_ENVIRONMENT
            || claims.phase != RootSessionPhase::BeforeChallenge
            || claims.method != PRIVATE_METHOD
            || claims.path != PRIVATE_BEGIN_PATH
            || claims.operation_id_sha256 != self.begin_intent.operation_id_sha256()
            || claims.authorization_id_sha256 != self.begin_intent.authorization_id_sha256()
            || claims.ceremony_id_sha256 != self.begin_intent.ceremony_id_sha256()
            || claims.request_intent_sha256 != self.begin_intent.request_intent_sha256()
            || claims.scope_kind != SCOPE_KIND
            || claims.scope_id_sha256 != GLOBAL_SCOPE_ID_SHA256
            || claims.parent_proof_sha256.is_some()
            || claims.root_admin_id != action.root_admin_id()
            || claims.root_role != ROOT_ROLE
            || claims.root_status != ENABLED_STATUS
            || claims.root_deleted_at.is_some()
            || claims.root_session_epoch != action.root_session_epoch()
            || claims.root_session_issued_at != action.root_session_issued_at()
            || claims.root_session_expires_at != action.root_session_expires_at()
            || claims.root_session_binding_sha256 != action.root_session_binding_sha256()
            || claims.authority_expires_at != action.permit_expires_at()
            || claims.d1_observed_at > self.created_at
            || claims.not_before > self.created_at
            || claims.issued_at > self.created_at
            || self.created_at >= claims.expires_at
            || claims.expires_at > claims.authority_expires_at
            || claims.expires_at > claims.root_session_expires_at
            || self.semantic_authority_fingerprint_sha256
                != claims.semantic_authority_fingerprint_sha256
            || self.coordinator_identity_sha256 != sha256_hex_bytes(&coordinator_identity)
            || self.coordinator_object_name != expected_coordinator_object_name
            || self.coordinator_begin_body_sha256 != sha256_hex_bytes(&coordinator_begin_body)
            || !validate_wire_request_v1(
                BEGIN_PATH,
                self.begin_intent.environment(),
                &coordinator_begin_body,
            )
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }

        for digest in [
            &proof.token_sha256,
            &claims.proof_id_sha256,
            &claims.root_session_id_sha256,
            &claims.phase_binding_sha256,
            &claims.semantic_authority_fingerprint_sha256,
            &self.coordinator_identity_sha256,
            &self.coordinator_begin_body_sha256,
        ] {
            if !valid_sha256(digest) {
                return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
            }
        }

        if self
            .coordinator_status
            .as_ref()
            .is_some_and(|status| !valid_sha256(&status.latest_event_sha256))
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }

        let identity = &self.coordinator_begin.identity;
        let evidence = &self.coordinator_begin.evidence;
        if self.coordinator_begin.command != "begin"
            || self.coordinator_begin.expected_generation != 0
            || self.coordinator_begin.expires_at_ms != expected_expires_at_ms
            || identity.contract_version != 1
            || identity.environment != self.begin_intent.environment()
            || identity.operation_id_sha256 != self.begin_intent.operation_id_sha256()
            || identity.authorization_id_sha256 != self.begin_intent.authorization_id_sha256()
            || identity.root_user_id != action.root_admin_id().to_string()
            || identity.scope_kind != SCOPE_KIND
            || identity.scope_id_sha256 != GLOBAL_SCOPE_ID_SHA256
            || evidence.authority_fingerprint_sha256 != self.semantic_authority_fingerprint_sha256
            || evidence.begin_intent_sha256 != self.begin_intent.sha256()?
            || evidence.ceremony_id_sha256 != self.begin_intent.ceremony_id_sha256()
            || evidence.challenge_phase_proof_sha256 != proof.token_sha256
            || evidence.challenge_sha256 != self.webauthn.secure_verification_challenge_sha256()?
            || !valid_sha256(&self.coordinator_begin.request_id_sha256)
        {
            return Err(DrainSourceRegistrationCeremonyError::InvalidCeremony);
        }
        Ok(())
    }
}

fn valid_challenge_issued_status(
    status: &CoordinatorStatusResponseV1,
    operation_id_sha256: &str,
    expires_at_ms: i64,
) -> bool {
    status.contract_version == 1
        && status.operation_id_sha256 == operation_id_sha256
        && status.generation == 1
        && status.event_count == 1
        && status.phase == CoordinatorPhase::ChallengeIssued
        && status.expires_at_ms == expires_at_ms
        && valid_sha256(&status.latest_event_sha256)
        && status.outcome.is_none()
        && !status.replayed
        && !status.terminal
}

fn derive_application_object_name_v1(
    environment: &str,
    root_admin_id: i64,
    operation_id_sha256: &str,
    ceremony_id_sha256: &str,
    authorization_id_sha256: &str,
) -> Option<String> {
    if environment != STAGING_ENVIRONMENT
        || root_admin_id <= 0
        || root_admin_id > MAXIMUM_SAFE_INTEGER
        || [
            operation_id_sha256,
            ceremony_id_sha256,
            authorization_id_sha256,
        ]
        .iter()
        .any(|value| !valid_sha256(value))
    {
        return None;
    }
    let root_admin_id = root_admin_id.to_string();
    let fields = [
        environment.as_bytes(),
        root_admin_id.as_bytes(),
        operation_id_sha256.as_bytes(),
        ceremony_id_sha256.as_bytes(),
        authorization_id_sha256.as_bytes(),
    ];
    let mut message = Vec::with_capacity(512);
    message.extend_from_slice(APPLICATION_OBJECT_DOMAIN);
    for field in fields {
        let length = u32::try_from(field.len()).ok()?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(field);
    }
    Some(format!(
        "{APPLICATION_OBJECT_PREFIX}:{}",
        sha256_hex_bytes(&message)
    ))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1_000.0).max(0.0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_object_name_is_domain_separated_and_stable() {
        let name = derive_application_object_name_v1(
            "staging",
            42,
            &"01".repeat(32),
            &"02".repeat(32),
            &"03".repeat(32),
        )
        .unwrap();
        assert_eq!(
            name,
            "drain-source-registration-application:v1:\
             1d0a1613eefe521118ecc1cc937c44fff75ca3b90f5e37cbd2bc197fd8946690"
                .replace(' ', "")
        );
        assert!(name.len() <= 256);
        assert!(derive_application_object_name_v1(
            "production",
            42,
            &"01".repeat(32),
            &"02".repeat(32),
            &"03".repeat(32),
        )
        .is_none());
    }
}
