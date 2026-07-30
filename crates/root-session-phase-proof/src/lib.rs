//! Short-lived, phase-bound proof of a live Root browser session.
//!
//! The Application verifies the browser cookie and live D1 user row, then
//! signs this proof with a dedicated key. The cookie and `SESSION_SECRET`
//! never cross the private Service Binding. A coordinator accepts only the
//! typed value returned by [`verify_root_session_phase_proof`].

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const PROOF_TYPE: &str = "CINATOKEN-ROOT-SESSION-PHASE-PROOF";
pub const PROOF_ALGORITHM: &str = "HS256";
pub const PROOF_VERSION: u8 = 1;
pub const PROTOCOL: &str = "relay-container-drain-source-registration-v1";
pub const PHASE_SUBJECT_SCHEMA_VERSION: u8 = 1;
pub const BEFORE_CHALLENGE_SUBJECT_CONTRACT: &str =
    "relay-container-drain-source-registration-before-challenge-subject-v1";
pub const BEFORE_ISSUER_SUBJECT_CONTRACT: &str =
    "relay-container-drain-source-registration-before-issuer-subject-v1";
pub const BEFORE_COMMIT_SUBJECT_CONTRACT: &str =
    "relay-container-drain-source-registration-before-commit-subject-v1";
pub const STAGING_ENVIRONMENT: &str = "staging";
pub const SCOPE_KIND: &str = "global";
pub const GLOBAL_SCOPE_ID_SHA256: &str =
    "53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251";
pub const PRIVATE_METHOD: &str = "POST";
pub const PRIVATE_BEGIN_PATH: &str = "/_cinatoken/private/v1/drain-source-registration/begin";
pub const PRIVATE_FINISH_PATH: &str = "/_cinatoken/private/v1/drain-source-registration/finish";
pub const DEFAULT_TTL_SECONDS: i64 = 10;
pub const MAX_TTL_SECONDS: i64 = 15;
pub const MIN_SECRET_BYTES: usize = 32;
pub const MAX_TOKEN_BYTES: usize = 8192;
pub const MAX_PROTECTED_JSON_BYTES: usize = 512;
pub const MAX_CLAIMS_JSON_BYTES: usize = 6144;
pub const MAX_SESSION_COOKIE_BYTES: usize = 4096;
pub const MAX_REQUEST_INTENT_BYTES: usize = 64 * 1024;
pub const MAX_PHASE_BINDING_BYTES: usize = 64 * 1024;
pub const RANDOM_ID_BYTES: usize = 32;
pub const SESSION_ID_BYTES: usize = 32;
pub const ROOT_ROLE: i32 = 100;
pub const ENABLED_STATUS: i32 = 1;

const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SIGNATURE_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:v1\0";
const SESSION_BINDING_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:session-binding:v1\0";
const SESSION_ID_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:session-id:v1\0";
const REQUEST_INTENT_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:request-intent:v1\0";
const PHASE_BINDING_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:phase-binding:v1\0";
const CEREMONY_ID_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:ceremony-id:v1\0";
const OPERATION_ID_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:operation-id:v1\0";
const PROOF_ID_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:proof-id:v1\0";
const TOKEN_DIGEST_DOMAIN: &[u8] = b"cinatoken-root-session-phase-proof:token:v1\0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootSessionPhase {
    BeforeChallenge,
    BeforeIssuer,
    BeforeCommit,
}

impl RootSessionPhase {
    pub const fn private_path(self) -> &'static str {
        match self {
            Self::BeforeChallenge => PRIVATE_BEGIN_PATH,
            Self::BeforeIssuer | Self::BeforeCommit => PRIVATE_FINISH_PATH,
        }
    }

    const fn wire_name(self) -> &'static str {
        match self {
            Self::BeforeChallenge => "before_challenge",
            Self::BeforeIssuer => "before_issuer",
            Self::BeforeCommit => "before_commit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootSessionPhaseSubjectContext<'a> {
    pub environment: &'a str,
    pub operation_id_sha256: &'a str,
    pub authorization_id_sha256: &'a str,
    pub ceremony_id_sha256: &'a str,
    pub request_intent_sha256: &'a str,
    pub semantic_authority_fingerprint_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootSessionBeforeChallengeSubjectV1<'a> {
    pub context: RootSessionPhaseSubjectContext<'a>,
    pub begin_intent_sha256: &'a str,
    pub authorization_subject_sha256: &'a str,
    pub authorization_signature_envelope_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootSessionBeforeIssuerSubjectV1<'a> {
    pub context: RootSessionPhaseSubjectContext<'a>,
    pub secure_verification_challenge_sha256: &'a str,
    pub action_subject_sha256: &'a str,
    pub permit_issue_request_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootSessionBeforeCommitSubjectV1<'a> {
    pub context: RootSessionPhaseSubjectContext<'a>,
    pub action_subject_sha256: &'a str,
    pub issuer_request_sha256: &'a str,
    pub authenticated_issuer_request_id_sha256: &'a str,
    pub issuer_version_id: &'a str,
    pub permit_id_sha256: &'a str,
    pub permit_subject_sha256: &'a str,
    pub permit_signature_envelope_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSessionPhaseSubjectV1<'a> {
    BeforeChallenge(RootSessionBeforeChallengeSubjectV1<'a>),
    BeforeIssuer(RootSessionBeforeIssuerSubjectV1<'a>),
    BeforeCommit(RootSessionBeforeCommitSubjectV1<'a>),
}

impl<'a> RootSessionPhaseSubjectV1<'a> {
    pub const fn phase(self) -> RootSessionPhase {
        match self {
            Self::BeforeChallenge(_) => RootSessionPhase::BeforeChallenge,
            Self::BeforeIssuer(_) => RootSessionPhase::BeforeIssuer,
            Self::BeforeCommit(_) => RootSessionPhase::BeforeCommit,
        }
    }

    pub const fn context(self) -> RootSessionPhaseSubjectContext<'a> {
        match self {
            Self::BeforeChallenge(subject) => subject.context,
            Self::BeforeIssuer(subject) => subject.context,
            Self::BeforeCommit(subject) => subject.context,
        }
    }

    pub fn canonical_json(self) -> Result<Vec<u8>, RootSessionPhaseProofError> {
        validate_phase_subject(self)?;
        canonical_phase_subject_json(self)
    }

    pub fn phase_binding_sha256(self) -> Result<String, RootSessionPhaseProofError> {
        derive_phase_binding_sha256(self.phase(), &self.canonical_json()?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootSessionPhaseProtectedHeader {
    pub typ: String,
    pub alg: String,
    pub kid: String,
    pub key_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootSessionPhaseClaims {
    pub proof_version: u8,
    pub protocol: String,
    pub issuer: String,
    pub audience: String,
    pub application_version_id: String,
    pub environment: String,
    pub phase: RootSessionPhase,
    pub method: String,
    pub path: String,
    pub operation_id_sha256: String,
    pub scope_kind: String,
    pub scope_id_sha256: String,
    pub authorization_id_sha256: String,
    pub ceremony_id_sha256: String,
    pub request_intent_sha256: String,
    pub proof_id_sha256: String,
    pub root_admin_id: i64,
    pub root_role: i32,
    pub root_status: i32,
    pub root_deleted_at: Option<i64>,
    pub root_session_epoch: i64,
    pub root_session_issued_at: i64,
    pub root_session_expires_at: i64,
    pub root_session_binding_sha256: String,
    pub root_session_id_sha256: String,
    pub d1_observed_at: i64,
    pub parent_proof_sha256: Option<String>,
    pub phase_binding_sha256: String,
    pub semantic_authority_fingerprint_sha256: String,
    pub authority_expires_at: i64,
    pub issued_at: i64,
    pub not_before: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct RootSessionPhaseKey<'a> {
    pub kid: &'a str,
    pub key_version: u32,
    pub secret: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct RootSessionPhaseKeyRing<'a> {
    pub current: RootSessionPhaseKey<'a>,
    pub previous: Option<RootSessionPhaseKey<'a>>,
}

#[derive(Debug, Clone, Copy)]
pub struct RootSessionPhaseInput<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub application_version_id: &'a str,
    pub environment: &'a str,
    pub phase: RootSessionPhase,
    pub phase_subject: RootSessionPhaseSubjectV1<'a>,
    pub operation_id_sha256: &'a str,
    pub authorization_id_sha256: &'a str,
    pub ceremony_id_sha256: &'a str,
    pub request_intent_sha256: &'a str,
    pub proof_id_sha256: &'a str,
    pub root_admin_id: i64,
    pub root_role: i32,
    pub root_status: i32,
    pub root_deleted_at: Option<i64>,
    pub root_session_epoch: i64,
    pub root_session_issued_at: i64,
    pub root_session_expires_at: i64,
    pub root_session_binding_sha256: &'a str,
    pub root_session_id_sha256: &'a str,
    pub d1_observed_at: i64,
    pub parent_proof_sha256: Option<&'a str>,
    pub semantic_authority_fingerprint_sha256: &'a str,
    pub authority_expires_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct RootSessionAnchorExpectation<'a> {
    pub root_session_epoch: i64,
    pub root_session_issued_at: i64,
    pub root_session_expires_at: i64,
    pub root_session_binding_sha256: &'a str,
    pub root_session_id_sha256: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct RootSessionPhaseExpectation<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub application_version_id: &'a str,
    pub environment: &'a str,
    pub phase: RootSessionPhase,
    pub phase_subject: RootSessionPhaseSubjectV1<'a>,
    pub operation_id_sha256: &'a str,
    pub authorization_id_sha256: &'a str,
    pub ceremony_id_sha256: &'a str,
    pub request_intent_sha256: &'a str,
    pub parent_proof_sha256: Option<&'a str>,
    pub semantic_authority_fingerprint_sha256: &'a str,
    pub authority_expires_at: i64,
    pub root_admin_id: i64,
    pub expected_session: Option<RootSessionAnchorExpectation<'a>>,
    pub now: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSessionPhaseKeySlot {
    Current,
    Previous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRootSessionPhaseProof {
    protected: RootSessionPhaseProtectedHeader,
    claims: RootSessionPhaseClaims,
    key_slot: RootSessionPhaseKeySlot,
    token_sha256: String,
}

impl VerifiedRootSessionPhaseProof {
    pub fn protected(&self) -> &RootSessionPhaseProtectedHeader {
        &self.protected
    }

    pub fn claims(&self) -> &RootSessionPhaseClaims {
        &self.claims
    }

    pub const fn key_slot(&self) -> RootSessionPhaseKeySlot {
        self.key_slot
    }

    /// Domain-separated digest suitable for the next phase's parent binding.
    pub fn token_sha256(&self) -> &str {
        &self.token_sha256
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSessionPhaseProofError {
    InvalidSecret,
    InvalidKeyConfiguration,
    InvalidInput,
    InvalidToken,
    InvalidHeader,
    NonCanonical,
    InvalidSignature,
    KeyNotAccepted,
    ClaimMismatch,
    SessionMismatch,
    Expired,
    InvalidTimeWindow,
}

impl RootSessionPhaseProofError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidSecret => "root_session_phase_proof_secret_invalid",
            Self::InvalidKeyConfiguration => "root_session_phase_proof_key_configuration_invalid",
            Self::InvalidInput => "root_session_phase_proof_input_invalid",
            Self::InvalidToken => "root_session_phase_proof_token_invalid",
            Self::InvalidHeader => "root_session_phase_proof_header_invalid",
            Self::NonCanonical => "root_session_phase_proof_noncanonical",
            Self::InvalidSignature => "root_session_phase_proof_signature_invalid",
            Self::KeyNotAccepted => "root_session_phase_proof_key_not_accepted",
            Self::ClaimMismatch => "root_session_phase_proof_claim_mismatch",
            Self::SessionMismatch => "root_session_phase_proof_session_mismatch",
            Self::Expired => "root_session_phase_proof_expired",
            Self::InvalidTimeWindow => "root_session_phase_proof_time_invalid",
        }
    }
}

impl fmt::Display for RootSessionPhaseProofError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for RootSessionPhaseProofError {}

pub fn sign_root_session_phase_proof(
    key: RootSessionPhaseKey<'_>,
    input: RootSessionPhaseInput<'_>,
) -> Result<String, RootSessionPhaseProofError> {
    sign_root_session_phase_proof_with_ttl(key, input, DEFAULT_TTL_SECONDS)
}

pub fn sign_root_session_phase_proof_with_ttl(
    key: RootSessionPhaseKey<'_>,
    input: RootSessionPhaseInput<'_>,
    ttl_seconds: i64,
) -> Result<String, RootSessionPhaseProofError> {
    validate_key(key)?;
    validate_input(input)?;
    let phase_binding_sha256 = input.phase_subject.phase_binding_sha256()?;
    if !(1..=MAX_TTL_SECONDS).contains(&ttl_seconds) {
        return Err(RootSessionPhaseProofError::InvalidTimeWindow);
    }
    let expires_at = input
        .d1_observed_at
        .checked_add(ttl_seconds)
        .map(|expires_at| {
            expires_at
                .min(input.root_session_expires_at)
                .min(input.authority_expires_at)
        })
        .filter(|expires_at| *expires_at > input.d1_observed_at)
        .ok_or(RootSessionPhaseProofError::InvalidTimeWindow)?;

    let protected = RootSessionPhaseProtectedHeader {
        typ: PROOF_TYPE.to_string(),
        alg: PROOF_ALGORITHM.to_string(),
        kid: key.kid.to_string(),
        key_version: key.key_version,
    };
    let claims = RootSessionPhaseClaims {
        proof_version: PROOF_VERSION,
        protocol: PROTOCOL.to_string(),
        issuer: input.issuer.to_string(),
        audience: input.audience.to_string(),
        application_version_id: input.application_version_id.to_string(),
        environment: input.environment.to_string(),
        phase: input.phase,
        method: PRIVATE_METHOD.to_string(),
        path: input.phase.private_path().to_string(),
        operation_id_sha256: input.operation_id_sha256.to_string(),
        scope_kind: SCOPE_KIND.to_string(),
        scope_id_sha256: GLOBAL_SCOPE_ID_SHA256.to_string(),
        authorization_id_sha256: input.authorization_id_sha256.to_string(),
        ceremony_id_sha256: input.ceremony_id_sha256.to_string(),
        request_intent_sha256: input.request_intent_sha256.to_string(),
        proof_id_sha256: input.proof_id_sha256.to_string(),
        root_admin_id: input.root_admin_id,
        root_role: input.root_role,
        root_status: input.root_status,
        root_deleted_at: input.root_deleted_at,
        root_session_epoch: input.root_session_epoch,
        root_session_issued_at: input.root_session_issued_at,
        root_session_expires_at: input.root_session_expires_at,
        root_session_binding_sha256: input.root_session_binding_sha256.to_string(),
        root_session_id_sha256: input.root_session_id_sha256.to_string(),
        d1_observed_at: input.d1_observed_at,
        parent_proof_sha256: input.parent_proof_sha256.map(str::to_string),
        phase_binding_sha256,
        semantic_authority_fingerprint_sha256: input
            .semantic_authority_fingerprint_sha256
            .to_string(),
        authority_expires_at: input.authority_expires_at,
        issued_at: input.d1_observed_at,
        not_before: input.d1_observed_at,
        expires_at,
    };

    let protected_json =
        serde_json::to_vec(&protected).map_err(|_| RootSessionPhaseProofError::InvalidInput)?;
    let claims_json =
        serde_json::to_vec(&claims).map_err(|_| RootSessionPhaseProofError::InvalidInput)?;
    if protected_json.len() > MAX_PROTECTED_JSON_BYTES || claims_json.len() > MAX_CLAIMS_JSON_BYTES
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    let protected_segment = URL_SAFE_NO_PAD.encode(protected_json);
    let claims_segment = URL_SAFE_NO_PAD.encode(claims_json);
    let signature = sign_segments(key.secret, &protected_segment, &claims_segment)?;
    let token = format!(
        "{protected_segment}.{claims_segment}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    );
    if token.len() > MAX_TOKEN_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(token)
}

pub fn verify_root_session_phase_proof(
    keys: RootSessionPhaseKeyRing<'_>,
    token: &str,
    expected: RootSessionPhaseExpectation<'_>,
) -> Result<VerifiedRootSessionPhaseProof, RootSessionPhaseProofError> {
    validate_key_ring(keys)?;
    validate_expectation(expected)?;
    let decoded = decode_token(token)?;

    let protected: RootSessionPhaseProtectedHeader =
        serde_json::from_slice(&decoded.protected_json)
            .map_err(|_| RootSessionPhaseProofError::InvalidHeader)?;
    validate_protected_header(&protected)?;
    reject_noncanonical_json(&decoded.protected_json, &protected)?;

    let (key, key_slot) = select_key(keys, &protected)?;
    verify_segments(
        key.secret,
        decoded.protected_segment,
        decoded.claims_segment,
        &decoded.signature,
    )?;

    // Claims are never deserialized before their signature succeeds.
    let claims: RootSessionPhaseClaims = serde_json::from_slice(&decoded.claims_json)
        .map_err(|_| RootSessionPhaseProofError::InvalidToken)?;
    reject_noncanonical_json(&decoded.claims_json, &claims)?;
    validate_claims(&claims, expected)?;

    Ok(VerifiedRootSessionPhaseProof {
        protected,
        claims,
        key_slot,
        token_sha256: derive_phase_proof_sha256(token)?,
    })
}

pub fn derive_root_session_binding_sha256(
    root_admin_id: i64,
    signed_cookie: &str,
) -> Result<String, RootSessionPhaseProofError> {
    if root_admin_id <= 0
        || root_admin_id > MAXIMUM_SAFE_INTEGER
        || signed_cookie.is_empty()
        || signed_cookie.len() > MAX_SESSION_COOKIE_BYTES
        || !signed_cookie.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    let root_admin_id = root_admin_id.to_be_bytes();
    Ok(sha256_len_prefixed(
        SESSION_BINDING_DOMAIN,
        &[root_admin_id.as_slice(), signed_cookie.as_bytes()],
    ))
}

pub fn derive_root_session_id_sha256(
    root_admin_id: i64,
    session_id: &str,
) -> Result<String, RootSessionPhaseProofError> {
    let decoded_session_id = URL_SAFE_NO_PAD
        .decode(session_id)
        .map_err(|_| RootSessionPhaseProofError::InvalidInput)?;
    if root_admin_id <= 0
        || root_admin_id > MAXIMUM_SAFE_INTEGER
        || decoded_session_id.len() != SESSION_ID_BYTES
        || URL_SAFE_NO_PAD.encode(decoded_session_id) != session_id
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    let root_admin_id = root_admin_id.to_be_bytes();
    Ok(sha256_len_prefixed(
        SESSION_ID_DOMAIN,
        &[root_admin_id.as_slice(), session_id.as_bytes()],
    ))
}

pub fn derive_request_intent_sha256(
    request_body: &[u8],
) -> Result<String, RootSessionPhaseProofError> {
    if request_body.len() > MAX_REQUEST_INTENT_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(sha256_len_prefixed(REQUEST_INTENT_DOMAIN, &[request_body]))
}

#[derive(Serialize)]
struct CanonicalBeforeChallengeSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    phase: RootSessionPhase,
    environment: &'a str,
    operation_id_sha256: &'a str,
    scope_kind: &'static str,
    scope_id_sha256: &'static str,
    authorization_id_sha256: &'a str,
    ceremony_id_sha256: &'a str,
    request_intent_sha256: &'a str,
    semantic_authority_fingerprint_sha256: &'a str,
    begin_intent_sha256: &'a str,
    authorization_subject_sha256: &'a str,
    authorization_signature_envelope_sha256: &'a str,
}

#[derive(Serialize)]
struct CanonicalBeforeIssuerSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    phase: RootSessionPhase,
    environment: &'a str,
    operation_id_sha256: &'a str,
    scope_kind: &'static str,
    scope_id_sha256: &'static str,
    authorization_id_sha256: &'a str,
    ceremony_id_sha256: &'a str,
    request_intent_sha256: &'a str,
    semantic_authority_fingerprint_sha256: &'a str,
    secure_verification_challenge_sha256: &'a str,
    action_subject_sha256: &'a str,
    permit_issue_request_sha256: &'a str,
}

#[derive(Serialize)]
struct CanonicalBeforeCommitSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    phase: RootSessionPhase,
    environment: &'a str,
    operation_id_sha256: &'a str,
    scope_kind: &'static str,
    scope_id_sha256: &'static str,
    authorization_id_sha256: &'a str,
    ceremony_id_sha256: &'a str,
    request_intent_sha256: &'a str,
    semantic_authority_fingerprint_sha256: &'a str,
    action_subject_sha256: &'a str,
    issuer_request_sha256: &'a str,
    authenticated_issuer_request_id_sha256: &'a str,
    issuer_version_id: &'a str,
    permit_id_sha256: &'a str,
    permit_subject_sha256: &'a str,
    permit_signature_envelope_sha256: &'a str,
}

fn canonical_phase_subject_json(
    subject: RootSessionPhaseSubjectV1<'_>,
) -> Result<Vec<u8>, RootSessionPhaseProofError> {
    let context = subject.context();
    match subject {
        RootSessionPhaseSubjectV1::BeforeChallenge(subject) => {
            serde_json::to_vec(&CanonicalBeforeChallengeSubject {
                schema_version: PHASE_SUBJECT_SCHEMA_VERSION,
                contract: BEFORE_CHALLENGE_SUBJECT_CONTRACT,
                phase: RootSessionPhase::BeforeChallenge,
                environment: context.environment,
                operation_id_sha256: context.operation_id_sha256,
                scope_kind: SCOPE_KIND,
                scope_id_sha256: GLOBAL_SCOPE_ID_SHA256,
                authorization_id_sha256: context.authorization_id_sha256,
                ceremony_id_sha256: context.ceremony_id_sha256,
                request_intent_sha256: context.request_intent_sha256,
                semantic_authority_fingerprint_sha256: context
                    .semantic_authority_fingerprint_sha256,
                begin_intent_sha256: subject.begin_intent_sha256,
                authorization_subject_sha256: subject.authorization_subject_sha256,
                authorization_signature_envelope_sha256: subject
                    .authorization_signature_envelope_sha256,
            })
        }
        RootSessionPhaseSubjectV1::BeforeIssuer(subject) => {
            serde_json::to_vec(&CanonicalBeforeIssuerSubject {
                schema_version: PHASE_SUBJECT_SCHEMA_VERSION,
                contract: BEFORE_ISSUER_SUBJECT_CONTRACT,
                phase: RootSessionPhase::BeforeIssuer,
                environment: context.environment,
                operation_id_sha256: context.operation_id_sha256,
                scope_kind: SCOPE_KIND,
                scope_id_sha256: GLOBAL_SCOPE_ID_SHA256,
                authorization_id_sha256: context.authorization_id_sha256,
                ceremony_id_sha256: context.ceremony_id_sha256,
                request_intent_sha256: context.request_intent_sha256,
                semantic_authority_fingerprint_sha256: context
                    .semantic_authority_fingerprint_sha256,
                secure_verification_challenge_sha256: subject.secure_verification_challenge_sha256,
                action_subject_sha256: subject.action_subject_sha256,
                permit_issue_request_sha256: subject.permit_issue_request_sha256,
            })
        }
        RootSessionPhaseSubjectV1::BeforeCommit(subject) => {
            serde_json::to_vec(&CanonicalBeforeCommitSubject {
                schema_version: PHASE_SUBJECT_SCHEMA_VERSION,
                contract: BEFORE_COMMIT_SUBJECT_CONTRACT,
                phase: RootSessionPhase::BeforeCommit,
                environment: context.environment,
                operation_id_sha256: context.operation_id_sha256,
                scope_kind: SCOPE_KIND,
                scope_id_sha256: GLOBAL_SCOPE_ID_SHA256,
                authorization_id_sha256: context.authorization_id_sha256,
                ceremony_id_sha256: context.ceremony_id_sha256,
                request_intent_sha256: context.request_intent_sha256,
                semantic_authority_fingerprint_sha256: context
                    .semantic_authority_fingerprint_sha256,
                action_subject_sha256: subject.action_subject_sha256,
                issuer_request_sha256: subject.issuer_request_sha256,
                authenticated_issuer_request_id_sha256: subject
                    .authenticated_issuer_request_id_sha256,
                issuer_version_id: subject.issuer_version_id,
                permit_id_sha256: subject.permit_id_sha256,
                permit_subject_sha256: subject.permit_subject_sha256,
                permit_signature_envelope_sha256: subject.permit_signature_envelope_sha256,
            })
        }
    }
    .map_err(|_| RootSessionPhaseProofError::InvalidInput)
}

fn derive_phase_binding_sha256(
    phase: RootSessionPhase,
    canonical_subject: &[u8],
) -> Result<String, RootSessionPhaseProofError> {
    if canonical_subject.is_empty() || canonical_subject.len() > MAX_PHASE_BINDING_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(sha256_len_prefixed(
        PHASE_BINDING_DOMAIN,
        &[phase.wire_name().as_bytes(), canonical_subject],
    ))
}

pub fn derive_ceremony_id_sha256(
    random_bytes: &[u8],
) -> Result<String, RootSessionPhaseProofError> {
    if random_bytes.len() != RANDOM_ID_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(sha256_len_prefixed(CEREMONY_ID_DOMAIN, &[random_bytes]))
}

pub fn derive_operation_id_sha256(
    random_bytes: &[u8],
) -> Result<String, RootSessionPhaseProofError> {
    if random_bytes.len() != RANDOM_ID_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(sha256_len_prefixed(OPERATION_ID_DOMAIN, &[random_bytes]))
}

pub fn derive_phase_proof_id_sha256(
    phase: RootSessionPhase,
    random_bytes: &[u8],
) -> Result<String, RootSessionPhaseProofError> {
    if random_bytes.len() != RANDOM_ID_BYTES {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(sha256_len_prefixed(
        PROOF_ID_DOMAIN,
        &[phase.wire_name().as_bytes(), random_bytes],
    ))
}

pub fn derive_phase_proof_sha256(token: &str) -> Result<String, RootSessionPhaseProofError> {
    let _ = decode_token(token)?;
    Ok(sha256_len_prefixed(
        TOKEN_DIGEST_DOMAIN,
        &[token.as_bytes()],
    ))
}

struct DecodedToken<'a> {
    protected_segment: &'a str,
    claims_segment: &'a str,
    protected_json: Vec<u8>,
    claims_json: Vec<u8>,
    signature: Vec<u8>,
}

fn decode_token(token: &str) -> Result<DecodedToken<'_>, RootSessionPhaseProofError> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(RootSessionPhaseProofError::InvalidToken);
    }
    let mut parts = token.split('.');
    let protected_segment = parts
        .next()
        .ok_or(RootSessionPhaseProofError::InvalidToken)?;
    let claims_segment = parts
        .next()
        .ok_or(RootSessionPhaseProofError::InvalidToken)?;
    let signature_segment = parts
        .next()
        .ok_or(RootSessionPhaseProofError::InvalidToken)?;
    if protected_segment.is_empty()
        || claims_segment.is_empty()
        || signature_segment.is_empty()
        || parts.next().is_some()
    {
        return Err(RootSessionPhaseProofError::InvalidToken);
    }

    let protected_json = decode_canonical_base64(
        protected_segment,
        MAX_PROTECTED_JSON_BYTES,
        RootSessionPhaseProofError::InvalidToken,
    )?;
    let claims_json = decode_canonical_base64(
        claims_segment,
        MAX_CLAIMS_JSON_BYTES,
        RootSessionPhaseProofError::InvalidToken,
    )?;
    let signature = decode_canonical_base64(
        signature_segment,
        32,
        RootSessionPhaseProofError::InvalidToken,
    )?;
    if protected_json.is_empty() || claims_json.is_empty() || signature.len() != 32 {
        return Err(RootSessionPhaseProofError::InvalidToken);
    }
    Ok(DecodedToken {
        protected_segment,
        claims_segment,
        protected_json,
        claims_json,
        signature,
    })
}

fn decode_canonical_base64(
    segment: &str,
    maximum_bytes: usize,
    error: RootSessionPhaseProofError,
) -> Result<Vec<u8>, RootSessionPhaseProofError> {
    let decoded = URL_SAFE_NO_PAD.decode(segment).map_err(|_| error)?;
    if decoded.len() > maximum_bytes || URL_SAFE_NO_PAD.encode(&decoded) != segment {
        return Err(error);
    }
    Ok(decoded)
}

fn reject_noncanonical_json<T: Serialize>(
    encoded: &[u8],
    value: &T,
) -> Result<(), RootSessionPhaseProofError> {
    let canonical =
        serde_json::to_vec(value).map_err(|_| RootSessionPhaseProofError::InvalidToken)?;
    if canonical != encoded {
        return Err(RootSessionPhaseProofError::NonCanonical);
    }
    Ok(())
}

fn sign_segments(
    secret: &[u8],
    protected_segment: &str,
    claims_segment: &str,
) -> Result<[u8; 32], RootSessionPhaseProofError> {
    validate_secret(secret)?;
    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|_| RootSessionPhaseProofError::InvalidSecret)?;
    update_signature_input(&mut mac, protected_segment, claims_segment);
    Ok(mac.finalize().into_bytes().into())
}

fn verify_segments(
    secret: &[u8],
    protected_segment: &str,
    claims_segment: &str,
    signature: &[u8],
) -> Result<(), RootSessionPhaseProofError> {
    validate_secret(secret)?;
    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|_| RootSessionPhaseProofError::InvalidSecret)?;
    update_signature_input(&mut mac, protected_segment, claims_segment);
    mac.verify_slice(signature)
        .map_err(|_| RootSessionPhaseProofError::InvalidSignature)
}

fn update_signature_input(mac: &mut HmacSha256, protected_segment: &str, claims_segment: &str) {
    mac.update(SIGNATURE_DOMAIN);
    mac.update(&(protected_segment.len() as u64).to_be_bytes());
    mac.update(protected_segment.as_bytes());
    mac.update(&(claims_segment.len() as u64).to_be_bytes());
    mac.update(claims_segment.as_bytes());
}

fn validate_key(key: RootSessionPhaseKey<'_>) -> Result<(), RootSessionPhaseProofError> {
    validate_secret(key.secret)?;
    if !valid_key_id(key.kid) || !(1..=1_000_000).contains(&key.key_version) {
        return Err(RootSessionPhaseProofError::InvalidKeyConfiguration);
    }
    Ok(())
}

fn validate_key_ring(keys: RootSessionPhaseKeyRing<'_>) -> Result<(), RootSessionPhaseProofError> {
    validate_key(keys.current)?;
    if let Some(previous) = keys.previous {
        validate_key(previous)?;
        if previous.kid == keys.current.kid
            || previous.key_version >= keys.current.key_version
            || previous.secret == keys.current.secret
        {
            return Err(RootSessionPhaseProofError::InvalidKeyConfiguration);
        }
    }
    Ok(())
}

fn select_key<'a>(
    keys: RootSessionPhaseKeyRing<'a>,
    protected: &RootSessionPhaseProtectedHeader,
) -> Result<(RootSessionPhaseKey<'a>, RootSessionPhaseKeySlot), RootSessionPhaseProofError> {
    if protected.kid == keys.current.kid && protected.key_version == keys.current.key_version {
        return Ok((keys.current, RootSessionPhaseKeySlot::Current));
    }
    if let Some(previous) = keys.previous {
        if protected.kid == previous.kid && protected.key_version == previous.key_version {
            return Ok((previous, RootSessionPhaseKeySlot::Previous));
        }
    }
    Err(RootSessionPhaseProofError::KeyNotAccepted)
}

fn validate_secret(secret: &[u8]) -> Result<(), RootSessionPhaseProofError> {
    if secret.len() < MIN_SECRET_BYTES {
        Err(RootSessionPhaseProofError::InvalidSecret)
    } else {
        Ok(())
    }
}

fn validate_protected_header(
    protected: &RootSessionPhaseProtectedHeader,
) -> Result<(), RootSessionPhaseProofError> {
    if protected.typ != PROOF_TYPE
        || protected.alg != PROOF_ALGORITHM
        || !valid_key_id(&protected.kid)
        || !(1..=1_000_000).contains(&protected.key_version)
    {
        return Err(RootSessionPhaseProofError::InvalidHeader);
    }
    Ok(())
}

fn validate_phase_subject(
    subject: RootSessionPhaseSubjectV1<'_>,
) -> Result<(), RootSessionPhaseProofError> {
    let context = subject.context();
    if context.environment != STAGING_ENVIRONMENT {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    let mut digests = vec![
        context.operation_id_sha256,
        GLOBAL_SCOPE_ID_SHA256,
        context.authorization_id_sha256,
        context.ceremony_id_sha256,
        context.request_intent_sha256,
        context.semantic_authority_fingerprint_sha256,
    ];
    match subject {
        RootSessionPhaseSubjectV1::BeforeChallenge(subject) => {
            digests.extend([
                subject.begin_intent_sha256,
                subject.authorization_subject_sha256,
                subject.authorization_signature_envelope_sha256,
            ]);
        }
        RootSessionPhaseSubjectV1::BeforeIssuer(subject) => {
            digests.extend([
                subject.secure_verification_challenge_sha256,
                subject.action_subject_sha256,
                subject.permit_issue_request_sha256,
            ]);
        }
        RootSessionPhaseSubjectV1::BeforeCommit(subject) => {
            if !valid_version_id(subject.issuer_version_id) {
                return Err(RootSessionPhaseProofError::InvalidInput);
            }
            digests.extend([
                subject.action_subject_sha256,
                subject.issuer_request_sha256,
                subject.authenticated_issuer_request_id_sha256,
                subject.permit_id_sha256,
                subject.permit_subject_sha256,
                subject.permit_signature_envelope_sha256,
            ]);
        }
    }
    if digests.iter().any(|digest| !valid_sha256(digest)) {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    for (index, digest) in digests.iter().enumerate() {
        if digests[index + 1..].contains(digest) {
            return Err(RootSessionPhaseProofError::InvalidInput);
        }
    }
    Ok(())
}

fn validate_input(input: RootSessionPhaseInput<'_>) -> Result<(), RootSessionPhaseProofError> {
    validate_phase_subject(input.phase_subject)?;
    let subject_context = input.phase_subject.context();
    let phase_binding_sha256 = input.phase_subject.phase_binding_sha256()?;
    if !valid_identifier(input.issuer)
        || !valid_identifier(input.audience)
        || !valid_version_id(input.application_version_id)
        || input.environment != STAGING_ENVIRONMENT
        || input.phase_subject.phase() != input.phase
        || subject_context.environment != input.environment
        || subject_context.operation_id_sha256 != input.operation_id_sha256
        || subject_context.authorization_id_sha256 != input.authorization_id_sha256
        || subject_context.ceremony_id_sha256 != input.ceremony_id_sha256
        || subject_context.request_intent_sha256 != input.request_intent_sha256
        || subject_context.semantic_authority_fingerprint_sha256
            != input.semantic_authority_fingerprint_sha256
        || !valid_sha256(input.operation_id_sha256)
        || !valid_sha256(input.authorization_id_sha256)
        || !valid_sha256(input.ceremony_id_sha256)
        || !valid_sha256(input.request_intent_sha256)
        || !valid_sha256(input.proof_id_sha256)
        || !valid_sha256(input.root_session_binding_sha256)
        || !valid_sha256(input.root_session_id_sha256)
        || !valid_sha256(input.semantic_authority_fingerprint_sha256)
        || input.root_admin_id <= 0
        || input.root_admin_id > MAXIMUM_SAFE_INTEGER
        || input.root_role != ROOT_ROLE
        || input.root_status != ENABLED_STATUS
        || input.root_deleted_at.is_some()
        || input.root_session_epoch < 0
        || input.root_session_epoch > MAXIMUM_SAFE_INTEGER
        || input.root_session_issued_at <= 0
        || input.root_session_issued_at > MAXIMUM_SAFE_INTEGER
        || input.root_session_expires_at <= input.root_session_issued_at
        || input.root_session_expires_at > MAXIMUM_SAFE_INTEGER
        || input.d1_observed_at < input.root_session_issued_at
        || input.d1_observed_at >= input.root_session_expires_at
        || input.d1_observed_at > MAXIMUM_SAFE_INTEGER
        || input.authority_expires_at <= input.d1_observed_at
        || input.authority_expires_at > MAXIMUM_SAFE_INTEGER
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    match (input.phase, input.parent_proof_sha256) {
        (RootSessionPhase::BeforeChallenge, None) => {}
        (
            RootSessionPhase::BeforeIssuer | RootSessionPhase::BeforeCommit,
            Some(parent_proof_sha256),
        ) if valid_sha256(parent_proof_sha256) => {}
        _ => return Err(RootSessionPhaseProofError::InvalidInput),
    }
    let mut digests = vec![
        input.operation_id_sha256,
        input.authorization_id_sha256,
        input.ceremony_id_sha256,
        input.request_intent_sha256,
        input.proof_id_sha256,
        input.root_session_binding_sha256,
        input.root_session_id_sha256,
        &phase_binding_sha256,
        input.semantic_authority_fingerprint_sha256,
        GLOBAL_SCOPE_ID_SHA256,
    ];
    if let Some(parent_proof_sha256) = input.parent_proof_sha256 {
        digests.push(parent_proof_sha256);
    }
    for (index, digest) in digests.iter().enumerate() {
        if digests[index + 1..].contains(digest) {
            return Err(RootSessionPhaseProofError::InvalidInput);
        }
    }
    Ok(())
}

fn validate_expectation(
    expected: RootSessionPhaseExpectation<'_>,
) -> Result<(), RootSessionPhaseProofError> {
    validate_phase_subject(expected.phase_subject)?;
    let subject_context = expected.phase_subject.context();
    let _ = expected.phase_subject.phase_binding_sha256()?;
    if !valid_identifier(expected.issuer)
        || !valid_identifier(expected.audience)
        || !valid_version_id(expected.application_version_id)
        || expected.environment != STAGING_ENVIRONMENT
        || expected.phase_subject.phase() != expected.phase
        || subject_context.environment != expected.environment
        || subject_context.operation_id_sha256 != expected.operation_id_sha256
        || subject_context.authorization_id_sha256 != expected.authorization_id_sha256
        || subject_context.ceremony_id_sha256 != expected.ceremony_id_sha256
        || subject_context.request_intent_sha256 != expected.request_intent_sha256
        || subject_context.semantic_authority_fingerprint_sha256
            != expected.semantic_authority_fingerprint_sha256
        || !valid_sha256(expected.operation_id_sha256)
        || !valid_sha256(expected.authorization_id_sha256)
        || !valid_sha256(expected.ceremony_id_sha256)
        || !valid_sha256(expected.request_intent_sha256)
        || !valid_sha256(expected.semantic_authority_fingerprint_sha256)
        || expected.authority_expires_at <= 0
        || expected.authority_expires_at > MAXIMUM_SAFE_INTEGER
        || expected.root_admin_id <= 0
        || expected.root_admin_id > MAXIMUM_SAFE_INTEGER
        || expected.now <= 0
        || expected.now > MAXIMUM_SAFE_INTEGER
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    match (
        expected.phase,
        expected.parent_proof_sha256,
        expected.expected_session,
    ) {
        (RootSessionPhase::BeforeChallenge, None, session) => {
            if let Some(session) = session {
                validate_session_expectation(session)?;
            }
        }
        (
            RootSessionPhase::BeforeIssuer | RootSessionPhase::BeforeCommit,
            Some(parent_proof_sha256),
            Some(session),
        ) if valid_sha256(parent_proof_sha256) => validate_session_expectation(session)?,
        _ => return Err(RootSessionPhaseProofError::InvalidInput),
    }
    Ok(())
}

fn validate_session_expectation(
    expected: RootSessionAnchorExpectation<'_>,
) -> Result<(), RootSessionPhaseProofError> {
    if expected.root_session_epoch < 0
        || expected.root_session_epoch > MAXIMUM_SAFE_INTEGER
        || expected.root_session_issued_at <= 0
        || expected.root_session_issued_at > MAXIMUM_SAFE_INTEGER
        || expected.root_session_expires_at <= expected.root_session_issued_at
        || expected.root_session_expires_at > MAXIMUM_SAFE_INTEGER
        || !valid_sha256(expected.root_session_binding_sha256)
        || !valid_sha256(expected.root_session_id_sha256)
    {
        return Err(RootSessionPhaseProofError::InvalidInput);
    }
    Ok(())
}

fn validate_claim_shape(claims: &RootSessionPhaseClaims) -> Result<(), RootSessionPhaseProofError> {
    if !valid_identifier(&claims.issuer)
        || !valid_identifier(&claims.audience)
        || !valid_version_id(&claims.application_version_id)
        || claims.environment != STAGING_ENVIRONMENT
        || !valid_sha256(&claims.operation_id_sha256)
        || !valid_sha256(&claims.authorization_id_sha256)
        || !valid_sha256(&claims.ceremony_id_sha256)
        || !valid_sha256(&claims.request_intent_sha256)
        || !valid_sha256(&claims.proof_id_sha256)
        || !valid_sha256(&claims.root_session_binding_sha256)
        || !valid_sha256(&claims.root_session_id_sha256)
        || !valid_sha256(&claims.phase_binding_sha256)
        || !valid_sha256(&claims.semantic_authority_fingerprint_sha256)
        || claims.root_admin_id <= 0
        || claims.root_admin_id > MAXIMUM_SAFE_INTEGER
        || claims.root_role != ROOT_ROLE
        || claims.root_status != ENABLED_STATUS
        || claims.root_deleted_at.is_some()
        || claims.root_session_epoch < 0
        || claims.root_session_epoch > MAXIMUM_SAFE_INTEGER
        || claims.root_session_issued_at <= 0
        || claims.root_session_issued_at > MAXIMUM_SAFE_INTEGER
        || claims.root_session_expires_at <= claims.root_session_issued_at
        || claims.root_session_expires_at > MAXIMUM_SAFE_INTEGER
        || claims.d1_observed_at < claims.root_session_issued_at
        || claims.d1_observed_at >= claims.root_session_expires_at
        || claims.d1_observed_at > MAXIMUM_SAFE_INTEGER
        || claims.authority_expires_at <= claims.d1_observed_at
        || claims.authority_expires_at > MAXIMUM_SAFE_INTEGER
    {
        return Err(RootSessionPhaseProofError::InvalidToken);
    }
    match (claims.phase, claims.parent_proof_sha256.as_deref()) {
        (RootSessionPhase::BeforeChallenge, None) => {}
        (
            RootSessionPhase::BeforeIssuer | RootSessionPhase::BeforeCommit,
            Some(parent_proof_sha256),
        ) if valid_sha256(parent_proof_sha256) => {}
        _ => return Err(RootSessionPhaseProofError::InvalidToken),
    }
    let mut digests = vec![
        claims.operation_id_sha256.as_str(),
        claims.authorization_id_sha256.as_str(),
        claims.ceremony_id_sha256.as_str(),
        claims.request_intent_sha256.as_str(),
        claims.proof_id_sha256.as_str(),
        claims.root_session_binding_sha256.as_str(),
        claims.root_session_id_sha256.as_str(),
        claims.phase_binding_sha256.as_str(),
        claims.semantic_authority_fingerprint_sha256.as_str(),
        GLOBAL_SCOPE_ID_SHA256,
    ];
    if let Some(parent_proof_sha256) = claims.parent_proof_sha256.as_deref() {
        digests.push(parent_proof_sha256);
    }
    for (index, digest) in digests.iter().enumerate() {
        if digests[index + 1..].contains(digest) {
            return Err(RootSessionPhaseProofError::InvalidToken);
        }
    }
    Ok(())
}

fn validate_claims(
    claims: &RootSessionPhaseClaims,
    expected: RootSessionPhaseExpectation<'_>,
) -> Result<(), RootSessionPhaseProofError> {
    validate_claim_shape(claims)?;
    let expected_phase_binding_sha256 = expected.phase_subject.phase_binding_sha256()?;

    if claims.proof_version != PROOF_VERSION
        || claims.protocol != PROTOCOL
        || claims.method != PRIVATE_METHOD
        || claims.path != claims.phase.private_path()
        || claims.scope_kind != SCOPE_KIND
        || claims.scope_id_sha256 != GLOBAL_SCOPE_ID_SHA256
    {
        return Err(RootSessionPhaseProofError::ClaimMismatch);
    }
    if claims.expires_at <= claims.issued_at
        || claims.issued_at != claims.d1_observed_at
        || claims.not_before != claims.issued_at
        || claims.expires_at > claims.root_session_expires_at
        || claims.expires_at > claims.authority_expires_at
        || claims.expires_at.saturating_sub(claims.issued_at) > MAX_TTL_SECONDS
        || claims.not_before > expected.now
    {
        return Err(RootSessionPhaseProofError::InvalidTimeWindow);
    }
    if claims.expires_at <= expected.now {
        return Err(RootSessionPhaseProofError::Expired);
    }
    if claims.issuer != expected.issuer
        || claims.audience != expected.audience
        || claims.application_version_id != expected.application_version_id
        || claims.environment != expected.environment
        || claims.phase != expected.phase
        || claims.operation_id_sha256 != expected.operation_id_sha256
        || claims.authorization_id_sha256 != expected.authorization_id_sha256
        || claims.ceremony_id_sha256 != expected.ceremony_id_sha256
        || claims.request_intent_sha256 != expected.request_intent_sha256
        || claims.parent_proof_sha256.as_deref() != expected.parent_proof_sha256
        || claims.phase_binding_sha256 != expected_phase_binding_sha256
        || claims.semantic_authority_fingerprint_sha256
            != expected.semantic_authority_fingerprint_sha256
        || claims.authority_expires_at != expected.authority_expires_at
        || claims.root_admin_id != expected.root_admin_id
    {
        return Err(RootSessionPhaseProofError::ClaimMismatch);
    }
    if let Some(session) = expected.expected_session {
        if claims.root_session_epoch != session.root_session_epoch
            || claims.root_session_issued_at != session.root_session_issued_at
            || claims.root_session_expires_at != session.root_session_expires_at
            || claims.root_session_binding_sha256 != session.root_session_binding_sha256
            || claims.root_session_id_sha256 != session.root_session_id_sha256
        {
            return Err(RootSessionPhaseProofError::SessionMismatch);
        }
    }
    Ok(())
}

fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_version_id(value: &str) -> bool {
    valid_identifier(value) && value.len() <= 64
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_len_prefixed(domain: &[u8], fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::{json, Value};

    const CURRENT_SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const PREVIOUS_SECRET: &[u8] = b"abcdef0123456789abcdef0123456789";
    const OTHER_SECRET: &[u8] = b"fedcba9876543210fedcba9876543210";
    const OPERATION_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const AUTHORIZATION_ID: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const CEREMONY_ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REQUEST_INTENT: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const PROOF_ID: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const SESSION_BINDING: &str =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const SESSION_ID: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const CHALLENGE_SHA256: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";
    const AUTHORITY_FINGERPRINT: &str =
        "3333333333333333333333333333333333333333333333333333333333333333";
    const PARENT_PROOF: &str = "4444444444444444444444444444444444444444444444444444444444444444";
    const ACTION_SUBJECT: &str = "5555555555555555555555555555555555555555555555555555555555555555";
    const PERMIT_ISSUE_REQUEST: &str =
        "6666666666666666666666666666666666666666666666666666666666666666";
    const PERMIT_ID: &str = "7777777777777777777777777777777777777777777777777777777777777777";
    const PERMIT_SUBJECT: &str = "8888888888888888888888888888888888888888888888888888888888888888";
    const PERMIT_ENVELOPE: &str =
        "9999999999999999999999999999999999999999999999999999999999999999";
    const BEGIN_INTENT: &str = "abababababababababababababababababababababababababababababababab";
    const AUTHORIZATION_SUBJECT: &str =
        "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
    const AUTHORIZATION_ENVELOPE: &str =
        "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const AUTHENTICATED_ISSUER_REQUEST_ID: &str =
        "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    #[derive(Deserialize)]
    struct FixedVector {
        secret_hex: String,
        protected: RootSessionPhaseProtectedHeader,
        claims: RootSessionPhaseClaims,
        before_challenge_subject: FixedBeforeChallengeSubject,
        before_issuer_subject: FixedBeforeIssuerSubject,
        before_commit_subject: FixedBeforeCommitSubject,
        signature_base64url: String,
        token_sha256: String,
    }

    #[derive(Deserialize)]
    struct FixedBeforeChallengeSubject {
        canonical_json: String,
        begin_intent_sha256: String,
        authorization_subject_sha256: String,
        authorization_signature_envelope_sha256: String,
        phase_binding_sha256: String,
    }

    #[derive(Deserialize)]
    struct FixedBeforeIssuerSubject {
        canonical_json: String,
        secure_verification_challenge_sha256: String,
        action_subject_sha256: String,
        permit_issue_request_sha256: String,
        phase_binding_sha256: String,
    }

    #[derive(Deserialize)]
    struct FixedBeforeCommitSubject {
        canonical_json: String,
        action_subject_sha256: String,
        issuer_request_sha256: String,
        authenticated_issuer_request_id_sha256: String,
        issuer_version_id: String,
        permit_id_sha256: String,
        permit_subject_sha256: String,
        permit_signature_envelope_sha256: String,
    }

    fn current_key() -> RootSessionPhaseKey<'static> {
        RootSessionPhaseKey {
            kid: "root-session-current",
            key_version: 2,
            secret: CURRENT_SECRET,
        }
    }

    fn previous_key() -> RootSessionPhaseKey<'static> {
        RootSessionPhaseKey {
            kid: "root-session-previous",
            key_version: 1,
            secret: PREVIOUS_SECRET,
        }
    }

    fn key_ring() -> RootSessionPhaseKeyRing<'static> {
        RootSessionPhaseKeyRing {
            current: current_key(),
            previous: Some(previous_key()),
        }
    }

    fn phase_subject(phase: RootSessionPhase) -> RootSessionPhaseSubjectV1<'static> {
        let context = RootSessionPhaseSubjectContext {
            environment: STAGING_ENVIRONMENT,
            operation_id_sha256: OPERATION_ID,
            authorization_id_sha256: AUTHORIZATION_ID,
            ceremony_id_sha256: CEREMONY_ID,
            request_intent_sha256: REQUEST_INTENT,
            semantic_authority_fingerprint_sha256: AUTHORITY_FINGERPRINT,
        };
        match phase {
            RootSessionPhase::BeforeChallenge => {
                RootSessionPhaseSubjectV1::BeforeChallenge(RootSessionBeforeChallengeSubjectV1 {
                    context,
                    begin_intent_sha256: BEGIN_INTENT,
                    authorization_subject_sha256: AUTHORIZATION_SUBJECT,
                    authorization_signature_envelope_sha256: AUTHORIZATION_ENVELOPE,
                })
            }
            RootSessionPhase::BeforeIssuer => {
                RootSessionPhaseSubjectV1::BeforeIssuer(RootSessionBeforeIssuerSubjectV1 {
                    context,
                    secure_verification_challenge_sha256: CHALLENGE_SHA256,
                    action_subject_sha256: ACTION_SUBJECT,
                    permit_issue_request_sha256: PERMIT_ISSUE_REQUEST,
                })
            }
            RootSessionPhase::BeforeCommit => {
                RootSessionPhaseSubjectV1::BeforeCommit(RootSessionBeforeCommitSubjectV1 {
                    context,
                    action_subject_sha256: ACTION_SUBJECT,
                    issuer_request_sha256: PERMIT_ISSUE_REQUEST,
                    authenticated_issuer_request_id_sha256: AUTHENTICATED_ISSUER_REQUEST_ID,
                    issuer_version_id: "issuer-build-1",
                    permit_id_sha256: PERMIT_ID,
                    permit_subject_sha256: PERMIT_SUBJECT,
                    permit_signature_envelope_sha256: PERMIT_ENVELOPE,
                })
            }
        }
    }

    fn input(
        phase: RootSessionPhase,
        proof_id_sha256: &'static str,
    ) -> RootSessionPhaseInput<'static> {
        RootSessionPhaseInput {
            issuer: "cinatoken-application",
            audience: "cinatoken-drain-source-registration-coordinator",
            application_version_id: "application-build-1",
            environment: STAGING_ENVIRONMENT,
            phase,
            phase_subject: phase_subject(phase),
            operation_id_sha256: OPERATION_ID,
            authorization_id_sha256: AUTHORIZATION_ID,
            ceremony_id_sha256: CEREMONY_ID,
            request_intent_sha256: REQUEST_INTENT,
            proof_id_sha256,
            root_admin_id: 1,
            root_role: ROOT_ROLE,
            root_status: ENABLED_STATUS,
            root_deleted_at: None,
            root_session_epoch: 7,
            root_session_issued_at: 1_700_000_010,
            root_session_expires_at: 1_700_000_600,
            root_session_binding_sha256: SESSION_BINDING,
            root_session_id_sha256: SESSION_ID,
            d1_observed_at: 1_700_000_100,
            parent_proof_sha256: (phase != RootSessionPhase::BeforeChallenge)
                .then_some(PARENT_PROOF),
            semantic_authority_fingerprint_sha256: AUTHORITY_FINGERPRINT,
            authority_expires_at: 1_700_000_600,
        }
    }

    fn session_expectation() -> RootSessionAnchorExpectation<'static> {
        RootSessionAnchorExpectation {
            root_session_epoch: 7,
            root_session_issued_at: 1_700_000_010,
            root_session_expires_at: 1_700_000_600,
            root_session_binding_sha256: SESSION_BINDING,
            root_session_id_sha256: SESSION_ID,
        }
    }

    fn expectation(phase: RootSessionPhase, now: i64) -> RootSessionPhaseExpectation<'static> {
        RootSessionPhaseExpectation {
            issuer: "cinatoken-application",
            audience: "cinatoken-drain-source-registration-coordinator",
            application_version_id: "application-build-1",
            environment: STAGING_ENVIRONMENT,
            phase,
            phase_subject: phase_subject(phase),
            operation_id_sha256: OPERATION_ID,
            authorization_id_sha256: AUTHORIZATION_ID,
            ceremony_id_sha256: CEREMONY_ID,
            request_intent_sha256: REQUEST_INTENT,
            parent_proof_sha256: (phase != RootSessionPhase::BeforeChallenge)
                .then_some(PARENT_PROOF),
            semantic_authority_fingerprint_sha256: AUTHORITY_FINGERPRINT,
            authority_expires_at: 1_700_000_600,
            root_admin_id: 1,
            expected_session: Some(session_expectation()),
            now,
        }
    }

    fn decode_values(token: &str) -> (Value, Value) {
        let parts = token.split('.').collect::<Vec<_>>();
        let protected = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        let claims = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        (
            serde_json::from_slice(&protected).unwrap(),
            serde_json::from_slice(&claims).unwrap(),
        )
    }

    fn raw_token(protected: &[u8], claims: &[u8], secret: &[u8]) -> String {
        let protected_segment = URL_SAFE_NO_PAD.encode(protected);
        let claims_segment = URL_SAFE_NO_PAD.encode(claims);
        let signature = sign_segments(secret, &protected_segment, &claims_segment).unwrap();
        format!(
            "{protected_segment}.{claims_segment}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        )
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte: u8| match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    _ => panic!("fixture hex must be lowercase"),
                };
                (digit(pair[0]) << 4) | digit(pair[1])
            })
            .collect()
    }

    fn resign_values(protected: &Value, claims: &Value, secret: &[u8]) -> String {
        raw_token(
            &serde_json::to_vec(protected).unwrap(),
            &serde_json::to_vec(claims).unwrap(),
            secret,
        )
    }

    fn resign_typed_claims(
        token: &str,
        mutate: impl FnOnce(&mut RootSessionPhaseClaims),
    ) -> String {
        let parts = token.split('.').collect::<Vec<_>>();
        let protected_json = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        let claims_json = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        let mut claims: RootSessionPhaseClaims = serde_json::from_slice(&claims_json).unwrap();
        mutate(&mut claims);
        raw_token(
            &protected_json,
            &serde_json::to_vec(&claims).unwrap(),
            CURRENT_SECRET,
        )
    }

    #[test]
    fn round_trip_binds_every_private_phase_field() {
        for (phase, expected_path) in [
            (RootSessionPhase::BeforeChallenge, PRIVATE_BEGIN_PATH),
            (RootSessionPhase::BeforeIssuer, PRIVATE_FINISH_PATH),
            (RootSessionPhase::BeforeCommit, PRIVATE_FINISH_PATH),
        ] {
            let token =
                sign_root_session_phase_proof(current_key(), input(phase, PROOF_ID)).unwrap();
            assert!(token.len() <= MAX_TOKEN_BYTES);
            assert_eq!(token.split('.').count(), 3);
            let (header, claims) = decode_values(&token);
            assert_eq!(header["typ"], PROOF_TYPE);
            assert_eq!(header["alg"], PROOF_ALGORITHM);
            assert_eq!(header["kid"], current_key().kid);
            assert_eq!(header["key_version"], current_key().key_version);
            assert_eq!(claims["phase"], phase.wire_name());
            assert_eq!(claims["method"], PRIVATE_METHOD);
            assert_eq!(claims["path"], expected_path);
            assert_eq!(claims["expires_at"], 1_700_000_110_i64);

            let verified = verify_root_session_phase_proof(
                key_ring(),
                &token,
                expectation(phase, 1_700_000_101),
            )
            .unwrap();
            assert_eq!(verified.key_slot(), RootSessionPhaseKeySlot::Current);
            assert_eq!(verified.claims().proof_id_sha256, PROOF_ID);
            assert_eq!(verified.claims().root_session_epoch, 7);
            assert_eq!(verified.claims().root_role, ROOT_ROLE);
            assert_eq!(verified.claims().root_status, ENABLED_STATUS);
            assert_eq!(verified.claims().root_deleted_at, None);
            assert_eq!(verified.claims().operation_id_sha256, OPERATION_ID);
            assert_eq!(
                verified.claims().semantic_authority_fingerprint_sha256,
                AUTHORITY_FINGERPRINT
            );
            assert_eq!(
                verified.token_sha256(),
                derive_phase_proof_sha256(&token).unwrap()
            );
        }
    }

    #[test]
    fn fixed_vector_is_byte_exact() {
        let fixture: FixedVector = serde_json::from_str(include_str!(
            "../../../tests/fixtures/root-session-phase-proof-v1.json"
        ))
        .unwrap();
        let secret = decode_hex(&fixture.secret_hex);
        let claims = &fixture.claims;
        let key = RootSessionPhaseKey {
            kid: &fixture.protected.kid,
            key_version: fixture.protected.key_version,
            secret: &secret,
        };
        let subject_context = RootSessionPhaseSubjectContext {
            environment: &claims.environment,
            operation_id_sha256: &claims.operation_id_sha256,
            authorization_id_sha256: &claims.authorization_id_sha256,
            ceremony_id_sha256: &claims.ceremony_id_sha256,
            request_intent_sha256: &claims.request_intent_sha256,
            semantic_authority_fingerprint_sha256: &claims.semantic_authority_fingerprint_sha256,
        };
        let before_challenge_subject =
            RootSessionPhaseSubjectV1::BeforeChallenge(RootSessionBeforeChallengeSubjectV1 {
                context: subject_context,
                begin_intent_sha256: &fixture.before_challenge_subject.begin_intent_sha256,
                authorization_subject_sha256: &fixture
                    .before_challenge_subject
                    .authorization_subject_sha256,
                authorization_signature_envelope_sha256: &fixture
                    .before_challenge_subject
                    .authorization_signature_envelope_sha256,
            });
        assert_eq!(
            String::from_utf8(before_challenge_subject.canonical_json().unwrap()).unwrap(),
            fixture.before_challenge_subject.canonical_json
        );
        assert_eq!(
            before_challenge_subject.phase_binding_sha256().unwrap(),
            fixture.before_challenge_subject.phase_binding_sha256
        );
        let before_issuer_subject =
            RootSessionPhaseSubjectV1::BeforeIssuer(RootSessionBeforeIssuerSubjectV1 {
                context: subject_context,
                secure_verification_challenge_sha256: &fixture
                    .before_issuer_subject
                    .secure_verification_challenge_sha256,
                action_subject_sha256: &fixture.before_issuer_subject.action_subject_sha256,
                permit_issue_request_sha256: &fixture
                    .before_issuer_subject
                    .permit_issue_request_sha256,
            });
        assert_eq!(
            String::from_utf8(before_issuer_subject.canonical_json().unwrap()).unwrap(),
            fixture.before_issuer_subject.canonical_json
        );
        assert_eq!(
            before_issuer_subject.phase_binding_sha256().unwrap(),
            fixture.before_issuer_subject.phase_binding_sha256
        );
        let phase_subject =
            RootSessionPhaseSubjectV1::BeforeCommit(RootSessionBeforeCommitSubjectV1 {
                context: subject_context,
                action_subject_sha256: &fixture.before_commit_subject.action_subject_sha256,
                issuer_request_sha256: &fixture.before_commit_subject.issuer_request_sha256,
                authenticated_issuer_request_id_sha256: &fixture
                    .before_commit_subject
                    .authenticated_issuer_request_id_sha256,
                issuer_version_id: &fixture.before_commit_subject.issuer_version_id,
                permit_id_sha256: &fixture.before_commit_subject.permit_id_sha256,
                permit_subject_sha256: &fixture.before_commit_subject.permit_subject_sha256,
                permit_signature_envelope_sha256: &fixture
                    .before_commit_subject
                    .permit_signature_envelope_sha256,
            });
        assert_eq!(
            String::from_utf8(phase_subject.canonical_json().unwrap()).unwrap(),
            fixture.before_commit_subject.canonical_json
        );
        assert_eq!(
            phase_subject.phase_binding_sha256().unwrap(),
            claims.phase_binding_sha256
        );
        let input = RootSessionPhaseInput {
            issuer: &claims.issuer,
            audience: &claims.audience,
            application_version_id: &claims.application_version_id,
            environment: &claims.environment,
            phase: claims.phase,
            phase_subject,
            operation_id_sha256: &claims.operation_id_sha256,
            authorization_id_sha256: &claims.authorization_id_sha256,
            ceremony_id_sha256: &claims.ceremony_id_sha256,
            request_intent_sha256: &claims.request_intent_sha256,
            proof_id_sha256: &claims.proof_id_sha256,
            root_admin_id: claims.root_admin_id,
            root_role: claims.root_role,
            root_status: claims.root_status,
            root_deleted_at: claims.root_deleted_at,
            root_session_epoch: claims.root_session_epoch,
            root_session_issued_at: claims.root_session_issued_at,
            root_session_expires_at: claims.root_session_expires_at,
            root_session_binding_sha256: &claims.root_session_binding_sha256,
            root_session_id_sha256: &claims.root_session_id_sha256,
            d1_observed_at: claims.d1_observed_at,
            parent_proof_sha256: claims.parent_proof_sha256.as_deref(),
            semantic_authority_fingerprint_sha256: &claims.semantic_authority_fingerprint_sha256,
            authority_expires_at: claims.authority_expires_at,
        };
        let token = sign_root_session_phase_proof(key, input).unwrap();
        let (_, signature_base64url) = token.rsplit_once('.').unwrap();
        assert_eq!(signature_base64url, fixture.signature_base64url);
        let verified = verify_root_session_phase_proof(
            RootSessionPhaseKeyRing {
                current: key,
                previous: None,
            },
            &token,
            RootSessionPhaseExpectation {
                issuer: &claims.issuer,
                audience: &claims.audience,
                application_version_id: &claims.application_version_id,
                environment: &claims.environment,
                phase: claims.phase,
                phase_subject,
                operation_id_sha256: &claims.operation_id_sha256,
                authorization_id_sha256: &claims.authorization_id_sha256,
                ceremony_id_sha256: &claims.ceremony_id_sha256,
                request_intent_sha256: &claims.request_intent_sha256,
                parent_proof_sha256: claims.parent_proof_sha256.as_deref(),
                semantic_authority_fingerprint_sha256: &claims
                    .semantic_authority_fingerprint_sha256,
                authority_expires_at: claims.authority_expires_at,
                root_admin_id: claims.root_admin_id,
                expected_session: Some(RootSessionAnchorExpectation {
                    root_session_epoch: claims.root_session_epoch,
                    root_session_issued_at: claims.root_session_issued_at,
                    root_session_expires_at: claims.root_session_expires_at,
                    root_session_binding_sha256: &claims.root_session_binding_sha256,
                    root_session_id_sha256: &claims.root_session_id_sha256,
                }),
                now: claims.issued_at,
            },
        )
        .unwrap();
        assert_eq!(verified.protected(), &fixture.protected);
        assert_eq!(verified.claims(), claims);
        assert_eq!(verified.token_sha256(), fixture.token_sha256);
    }

    #[test]
    fn current_and_previous_rotation_is_explicit_and_bounded() {
        let token = sign_root_session_phase_proof(
            previous_key(),
            input(RootSessionPhase::BeforeIssuer, PROOF_ID),
        )
        .unwrap();
        let verified = verify_root_session_phase_proof(
            key_ring(),
            &token,
            expectation(RootSessionPhase::BeforeIssuer, 1_700_000_101),
        )
        .unwrap();
        assert_eq!(verified.key_slot(), RootSessionPhaseKeySlot::Previous);

        let current_only = RootSessionPhaseKeyRing {
            current: current_key(),
            previous: None,
        };
        assert_eq!(
            verify_root_session_phase_proof(
                current_only,
                &token,
                expectation(RootSessionPhase::BeforeIssuer, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::KeyNotAccepted
        );

        for invalid in [
            RootSessionPhaseKeyRing {
                current: current_key(),
                previous: Some(RootSessionPhaseKey {
                    kid: current_key().kid,
                    ..previous_key()
                }),
            },
            RootSessionPhaseKeyRing {
                current: current_key(),
                previous: Some(RootSessionPhaseKey {
                    key_version: current_key().key_version,
                    ..previous_key()
                }),
            },
            RootSessionPhaseKeyRing {
                current: current_key(),
                previous: Some(RootSessionPhaseKey {
                    secret: current_key().secret,
                    ..previous_key()
                }),
            },
        ] {
            let current = sign_root_session_phase_proof(
                current_key(),
                input(RootSessionPhase::BeforeChallenge, PROOF_ID),
            )
            .unwrap();
            assert_eq!(
                verify_root_session_phase_proof(
                    invalid,
                    &current,
                    expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
                )
                .unwrap_err(),
                RootSessionPhaseProofError::InvalidKeyConfiguration
            );
        }
    }

    #[test]
    fn parent_digest_forms_an_exact_three_phase_chain() {
        let challenge_token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        let challenge = verify_root_session_phase_proof(
            key_ring(),
            &challenge_token,
            expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
        )
        .unwrap();

        let issuer_input = RootSessionPhaseInput {
            parent_proof_sha256: Some(challenge.token_sha256()),
            ..input(RootSessionPhase::BeforeIssuer, PROOF_ID)
        };
        let issuer_token = sign_root_session_phase_proof(current_key(), issuer_input).unwrap();
        let issuer = verify_root_session_phase_proof(
            key_ring(),
            &issuer_token,
            RootSessionPhaseExpectation {
                parent_proof_sha256: Some(challenge.token_sha256()),
                ..expectation(RootSessionPhase::BeforeIssuer, 1_700_000_101)
            },
        )
        .unwrap();

        let commit_token = sign_root_session_phase_proof(
            current_key(),
            RootSessionPhaseInput {
                parent_proof_sha256: Some(issuer.token_sha256()),
                ..input(RootSessionPhase::BeforeCommit, PROOF_ID)
            },
        )
        .unwrap();
        assert!(verify_root_session_phase_proof(
            key_ring(),
            &commit_token,
            RootSessionPhaseExpectation {
                parent_proof_sha256: Some(issuer.token_sha256()),
                ..expectation(RootSessionPhase::BeforeCommit, 1_700_000_101)
            },
        )
        .is_ok());
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &commit_token,
                RootSessionPhaseExpectation {
                    parent_proof_sha256: Some(challenge.token_sha256()),
                    ..expectation(RootSessionPhase::BeforeCommit, 1_700_000_101)
                },
            )
            .unwrap_err(),
            RootSessionPhaseProofError::ClaimMismatch
        );
    }

    #[test]
    fn expectation_rejects_phase_operation_and_application_drift() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeIssuer, PROOF_ID),
        )
        .unwrap();
        let baseline = expectation(RootSessionPhase::BeforeIssuer, 1_700_000_101);
        for changed in [
            RootSessionPhaseExpectation {
                issuer: "other-application",
                ..baseline
            },
            RootSessionPhaseExpectation {
                audience: "other-coordinator",
                ..baseline
            },
            RootSessionPhaseExpectation {
                application_version_id: "application-build-2",
                ..baseline
            },
            RootSessionPhaseExpectation {
                parent_proof_sha256: Some(
                    "9999999999999999999999999999999999999999999999999999999999999999",
                ),
                ..baseline
            },
            RootSessionPhaseExpectation {
                phase_subject: RootSessionPhaseSubjectV1::BeforeIssuer(
                    RootSessionBeforeIssuerSubjectV1 {
                        context: phase_subject(RootSessionPhase::BeforeIssuer).context(),
                        secure_verification_challenge_sha256: CHALLENGE_SHA256,
                        action_subject_sha256:
                            "abababababababababababababababababababababababababababababababab",
                        permit_issue_request_sha256: PERMIT_ISSUE_REQUEST,
                    },
                ),
                ..baseline
            },
            RootSessionPhaseExpectation {
                authority_expires_at: baseline.authority_expires_at - 1,
                ..baseline
            },
            RootSessionPhaseExpectation {
                root_admin_id: 2,
                ..baseline
            },
        ] {
            assert_eq!(
                verify_root_session_phase_proof(key_ring(), &token, changed).unwrap_err(),
                RootSessionPhaseProofError::ClaimMismatch
            );
        }
        for changed in [
            RootSessionPhaseExpectation {
                phase: RootSessionPhase::BeforeCommit,
                ..baseline
            },
            RootSessionPhaseExpectation {
                operation_id_sha256:
                    "5555555555555555555555555555555555555555555555555555555555555555",
                ..baseline
            },
            RootSessionPhaseExpectation {
                authorization_id_sha256:
                    "6666666666666666666666666666666666666666666666666666666666666666",
                ..baseline
            },
            RootSessionPhaseExpectation {
                ceremony_id_sha256:
                    "7777777777777777777777777777777777777777777777777777777777777777",
                ..baseline
            },
            RootSessionPhaseExpectation {
                request_intent_sha256:
                    "8888888888888888888888888888888888888888888888888888888888888888",
                ..baseline
            },
            RootSessionPhaseExpectation {
                semantic_authority_fingerprint_sha256:
                    "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                ..baseline
            },
        ] {
            assert_eq!(
                verify_root_session_phase_proof(key_ring(), &token, changed).unwrap_err(),
                RootSessionPhaseProofError::InvalidInput
            );
        }
    }

    #[test]
    fn later_phases_require_the_exact_begin_session_anchor() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeCommit, PROOF_ID),
        )
        .unwrap();
        let baseline = expectation(RootSessionPhase::BeforeCommit, 1_700_000_101);
        let expected = baseline.expected_session.unwrap();
        for changed in [
            RootSessionAnchorExpectation {
                root_session_epoch: expected.root_session_epoch + 1,
                ..expected
            },
            RootSessionAnchorExpectation {
                root_session_issued_at: expected.root_session_issued_at + 1,
                ..expected
            },
            RootSessionAnchorExpectation {
                root_session_expires_at: expected.root_session_expires_at - 1,
                ..expected
            },
            RootSessionAnchorExpectation {
                root_session_binding_sha256:
                    "5656565656565656565656565656565656565656565656565656565656565656",
                ..expected
            },
            RootSessionAnchorExpectation {
                root_session_id_sha256:
                    "7878787878787878787878787878787878787878787878787878787878787878",
                ..expected
            },
        ] {
            assert_eq!(
                verify_root_session_phase_proof(
                    key_ring(),
                    &token,
                    RootSessionPhaseExpectation {
                        expected_session: Some(changed),
                        ..baseline
                    },
                )
                .unwrap_err(),
                RootSessionPhaseProofError::SessionMismatch
            );
        }
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &token,
                RootSessionPhaseExpectation {
                    expected_session: None,
                    ..baseline
                },
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );
    }

    #[test]
    fn signed_root_state_and_d1_time_are_fail_closed() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        let expected = expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101);

        for forged in [
            resign_typed_claims(&token, |claims| claims.root_role = 101),
            resign_typed_claims(&token, |claims| claims.root_status = 2),
            resign_typed_claims(&token, |claims| {
                claims.root_deleted_at = Some(1_700_000_100)
            }),
        ] {
            assert_eq!(
                verify_root_session_phase_proof(key_ring(), &forged, expected).unwrap_err(),
                RootSessionPhaseProofError::InvalidToken
            );
        }

        for forged in [
            resign_typed_claims(&token, |claims| claims.issued_at += 1),
            resign_typed_claims(&token, |claims| claims.not_before += 1),
        ] {
            assert_eq!(
                verify_root_session_phase_proof(key_ring(), &forged, expected).unwrap_err(),
                RootSessionPhaseProofError::InvalidTimeWindow
            );
        }
    }

    #[test]
    fn expiry_future_skew_and_session_ceiling_fail_closed() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &token,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_110),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::Expired
        );

        let mut future = input(RootSessionPhase::BeforeChallenge, PROOF_ID);
        future.d1_observed_at = 1_700_000_200;
        let future = sign_root_session_phase_proof(current_key(), future).unwrap();
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &future,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_199),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidTimeWindow
        );
        assert!(verify_root_session_phase_proof(
            key_ring(),
            &future,
            expectation(RootSessionPhase::BeforeChallenge, 1_700_000_200),
        )
        .is_ok());

        let mut near_session_end = input(RootSessionPhase::BeforeChallenge, PROOF_ID);
        near_session_end.d1_observed_at = 1_700_000_599;
        let near_session_end =
            sign_root_session_phase_proof(current_key(), near_session_end).unwrap();
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &near_session_end,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_599),
            )
            .unwrap()
            .claims()
            .expires_at,
            1_700_000_600
        );
    }

    #[test]
    fn tampering_wrong_key_and_malformed_claims_fail_before_authority() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        let parts = token.split('.').collect::<Vec<_>>();
        let mut signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        signature[0] ^= 0x80;
        let tampered = format!(
            "{}.{}.{}",
            parts[0],
            parts[1],
            URL_SAFE_NO_PAD.encode(signature)
        );
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &tampered,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidSignature
        );

        let wrong_ring = RootSessionPhaseKeyRing {
            current: RootSessionPhaseKey {
                secret: OTHER_SECRET,
                ..current_key()
            },
            previous: None,
        };
        assert_eq!(
            verify_root_session_phase_proof(
                wrong_ring,
                &token,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidSignature
        );

        let malformed_claims = URL_SAFE_NO_PAD.encode(b"not-json");
        let invalid_signature = format!(
            "{}.{}.{}",
            parts[0],
            malformed_claims,
            URL_SAFE_NO_PAD.encode([0_u8; 32])
        );
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &invalid_signature,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidSignature
        );
    }

    #[test]
    fn unknown_fields_and_noncanonical_json_are_rejected() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        let (mut protected, mut claims) = decode_values(&token);
        protected["extra"] = json!(true);
        let unknown_header = resign_values(&protected, &claims, CURRENT_SECRET);
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &unknown_header,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidHeader
        );

        let (protected, _) = decode_values(&token);
        claims["extra"] = json!(true);
        let unknown_claim = resign_values(&protected, &claims, CURRENT_SECRET);
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &unknown_claim,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::NonCanonical
        );

        let protected_json = serde_json::to_string_pretty(&protected).unwrap();
        let claims_json = serde_json::to_vec(&decode_values(&token).1).unwrap();
        let noncanonical = raw_token(protected_json.as_bytes(), &claims_json, CURRENT_SECRET);
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &noncanonical,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::NonCanonical
        );
    }

    #[test]
    fn token_signature_secret_and_ttl_bounds_are_enforced() {
        let token = sign_root_session_phase_proof(
            current_key(),
            input(RootSessionPhase::BeforeChallenge, PROOF_ID),
        )
        .unwrap();
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &"x".repeat(MAX_TOKEN_BYTES + 1),
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidToken
        );
        let parts = token.split('.').collect::<Vec<_>>();
        let short_signature = format!(
            "{}.{}.{}",
            parts[0],
            parts[1],
            URL_SAFE_NO_PAD.encode([0_u8; 31])
        );
        assert_eq!(
            verify_root_session_phase_proof(
                key_ring(),
                &short_signature,
                expectation(RootSessionPhase::BeforeChallenge, 1_700_000_101),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidToken
        );
        assert_eq!(
            sign_root_session_phase_proof(
                RootSessionPhaseKey {
                    secret: b"short",
                    ..current_key()
                },
                input(RootSessionPhase::BeforeChallenge, PROOF_ID),
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidSecret
        );
        assert_eq!(
            sign_root_session_phase_proof_with_ttl(
                current_key(),
                input(RootSessionPhase::BeforeChallenge, PROOF_ID),
                MAX_TTL_SECONDS + 1,
            )
            .unwrap_err(),
            RootSessionPhaseProofError::InvalidTimeWindow
        );
    }

    #[test]
    fn identifiers_digests_and_production_are_strict() {
        let mut invalid = input(RootSessionPhase::BeforeChallenge, PROOF_ID);
        invalid.environment = "production";
        assert_eq!(
            sign_root_session_phase_proof(current_key(), invalid).unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );

        let duplicate_digest = RootSessionPhaseInput {
            ceremony_id_sha256: AUTHORIZATION_ID,
            ..input(RootSessionPhase::BeforeChallenge, PROOF_ID)
        };
        assert_eq!(
            sign_root_session_phase_proof(current_key(), duplicate_digest).unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );
    }

    #[test]
    fn privacy_preserving_derivations_are_domain_separated_and_bounded() {
        let session = derive_root_session_binding_sha256(1, "payload.signature").unwrap();
        let other_session = derive_root_session_binding_sha256(2, "payload.signature").unwrap();
        let canonical_session_id = URL_SAFE_NO_PAD.encode([5_u8; SESSION_ID_BYTES]);
        let session_id = derive_root_session_id_sha256(1, &canonical_session_id).unwrap();
        let request = derive_request_intent_sha256(br#"{"finish":true}"#).unwrap();
        let phase_binding =
            derive_phase_binding_sha256(RootSessionPhase::BeforeCommit, br#"{"command":"commit"}"#)
                .unwrap();
        let ceremony = derive_ceremony_id_sha256(&[7_u8; RANDOM_ID_BYTES]).unwrap();
        let operation = derive_operation_id_sha256(&[6_u8; RANDOM_ID_BYTES]).unwrap();
        let issuer =
            derive_phase_proof_id_sha256(RootSessionPhase::BeforeIssuer, &[8_u8; RANDOM_ID_BYTES])
                .unwrap();
        let commit =
            derive_phase_proof_id_sha256(RootSessionPhase::BeforeCommit, &[8_u8; RANDOM_ID_BYTES])
                .unwrap();
        for value in [
            &session,
            &other_session,
            &session_id,
            &request,
            &phase_binding,
            &ceremony,
            &operation,
            &issuer,
            &commit,
        ] {
            assert!(valid_sha256(value));
        }
        assert_ne!(session, other_session);
        assert_ne!(issuer, commit);
        assert_eq!(
            derive_ceremony_id_sha256(&[0_u8; RANDOM_ID_BYTES - 1]).unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );
        assert_eq!(
            derive_request_intent_sha256(&vec![0_u8; MAX_REQUEST_INTENT_BYTES + 1]).unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );
        for invalid_session_id in [
            "session_id-123".to_string(),
            format!("{canonical_session_id}="),
            URL_SAFE_NO_PAD.encode([5_u8; SESSION_ID_BYTES - 1]),
        ] {
            assert_eq!(
                derive_root_session_id_sha256(1, &invalid_session_id).unwrap_err(),
                RootSessionPhaseProofError::InvalidInput
            );
        }
        assert_eq!(
            derive_root_session_binding_sha256(1, "bad cookie").unwrap_err(),
            RootSessionPhaseProofError::InvalidInput
        );
    }
}
