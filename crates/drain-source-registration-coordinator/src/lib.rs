#![allow(dead_code)]

//! Route-free durable journal for drain-source registration.
//!
//! The class is owned by the dedicated coordinator Worker and is reachable
//! only through an explicit Service Binding. Application orchestration, D1
//! winner readback, and secret lifecycle remain outside this crate.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use js_sys::Map;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    durable_object, Env, Error, Method, Request, Response, Result as WorkerResult, State,
};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const COORDINATOR_BINDING: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATORS";

pub const BEGIN_PATH: &str = "/v1/begin";
pub const FINISH_PATH: &str = "/v1/finish";
pub const STATUS_PATH: &str = "/v1/status";
pub const RECOVER_PATH: &str = "/v1/recover";
pub const AUTHORITY_HEADER: &str = "x-cinatoken-drain-source-registration-coordinator-authority";
pub const AUTHORITY_TYPE: &str = "CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR";
pub const AUTHORITY_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:";
pub const OBJECT_NAME_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:coordinator-object:v1";
const EVENT_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:coordinator-event:v1";
const EVENT_GENESIS_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:coordinator-event-genesis:v1";
const EXPIRATION_EVIDENCE_DOMAIN: &[u8] =
    b"cinatoken:relay-container:drain-source-registration:coordinator-expiration:v1";

const STATE_KEY: &str = "drain_source_registration_coordinator_state_v1";
const EVENT_PREFIX: &str = "event:v1:";
const REPLAY_PREFIX: &str = "request:v1:";
pub const MAX_JSON_BODY_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024;
const MAX_AUTHORITY_BYTES: usize = 4096;
const MAX_AUTHORITY_PART_BYTES: usize = 4096;
const MAX_CEREMONY_LIFETIME_MS: i64 = 300_000;
pub const AUTHORITY_WINDOW_SECONDS: i64 = 30;
const CLOCK_SKEW_SECONDS: i64 = 5;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const TX_EXACT_REPLAY: &str = "cinatoken_registration_coordinator_exact_replay";
const TX_REQUEST_CONFLICT: &str = "cinatoken_registration_coordinator_request_conflict";
const TX_STATE_CONFLICT: &str = "cinatoken_registration_coordinator_state_conflict";
const TX_EXPIRED: &str = "cinatoken_registration_coordinator_expired";
const TX_STORAGE_CORRUPT: &str = "cinatoken_registration_coordinator_storage_corrupt";
const TX_NO_EXPIRATION: &str = "cinatoken_registration_coordinator_no_expiration";

const ENVIRONMENT_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT";
const AUTHORITY_ISSUER_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER";
const AUTHORITY_AUDIENCE_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE";
const CALLER_IDENTITY_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256";
const CURRENT_KID_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID";
const CURRENT_SECRET_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET";
const PREVIOUS_KID_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_KID";
const PREVIOUS_SECRET_VAR: &str = "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_SECRET";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CoordinatorRoute {
    Begin,
    Finish,
    Status,
    Recover,
    NotFound,
}

impl CoordinatorRoute {
    fn parse(path: &str) -> Self {
        match path {
            BEGIN_PATH => Self::Begin,
            FINISH_PATH => Self::Finish,
            STATUS_PATH => Self::Status,
            RECOVER_PATH => Self::Recover,
            _ => Self::NotFound,
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Begin => BEGIN_PATH,
            Self::Finish => FINISH_PATH,
            Self::Status => STATUS_PATH,
            Self::Recover => RECOVER_PATH,
            Self::NotFound => "",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProtocolError {
    status: u16,
    code: &'static str,
}

impl ProtocolError {
    const fn new(status: u16, code: &'static str) -> Self {
        Self { status, code }
    }
}

#[derive(Clone)]
struct HmacKey {
    kid: String,
    secret: String,
}

#[derive(Clone)]
struct AuthorityConfiguration {
    environment: String,
    issuer: String,
    audience: String,
    caller_identity_sha256: String,
    current: HmacKey,
    previous: Option<HmacKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorityHeaderV1 {
    alg: String,
    kid: String,
    typ: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorityClaimsV1 {
    audience: String,
    body_sha256: String,
    caller_identity_sha256: String,
    expires_at: i64,
    issued_at: i64,
    issuer: String,
    method: String,
    object_name: String,
    path: String,
    request_id_sha256: String,
}

#[derive(Debug, Clone)]
struct AuthenticatedRequest {
    object_name: String,
    request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorIdentityV1 {
    pub authorization_id_sha256: String,
    pub contract_version: u8,
    pub environment: String,
    pub operation_id_sha256: String,
    pub root_user_id: String,
    pub scope_id_sha256: String,
    pub scope_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BeginEvidenceV1 {
    pub authority_fingerprint_sha256: String,
    pub begin_intent_sha256: String,
    pub ceremony_id_sha256: String,
    pub challenge_phase_proof_sha256: String,
    pub challenge_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinishClaimEvidenceV1 {
    pub assertion_envelope_sha256: String,
    pub finish_claim_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProofVerifiedEvidenceV1 {
    pub passkey_assertion_signature_sha256: String,
    pub passkey_state_transition_sha256: String,
    pub verified_passkey_proof_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PermitRequestEvidenceV1 {
    pub issuer_auth_key_id_sha256: String,
    pub issuer_phase_proof_sha256: String,
    pub issuer_request_id_sha256: String,
    pub issuer_request_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PermitVerifiedEvidenceV1 {
    pub issuer_version_sha256: String,
    pub permit_id_sha256: String,
    pub permit_signature_envelope_sha256: String,
    pub permit_subject_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitAttemptEvidenceV1 {
    pub command_body_sha256: String,
    pub command_id_sha256: String,
    pub commit_phase_proof_sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationOutcome {
    FreshApplied,
    ExactReplay,
    Conflict,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutcomeEvidenceV1 {
    pub authoritative_readback_sha256: String,
    pub command_id_sha256: String,
    pub outcome: RegistrationOutcome,
    pub winner_command_id_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ExpirationEvidenceV1 {
    evidence_sha256: String,
    expired_at_ms: i64,
    from_phase: CoordinatorPhase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorPhase {
    ChallengeIssued,
    FinishClaimed,
    ProofVerified,
    PermitRequestFrozen,
    PermitVerified,
    CommitAttempted,
    Applied,
    ExactReplay,
    Conflict,
    RecoveryPending,
    Expired,
}

impl CoordinatorPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChallengeIssued => "challenge_issued",
            Self::FinishClaimed => "finish_claimed",
            Self::ProofVerified => "proof_verified",
            Self::PermitRequestFrozen => "permit_request_frozen",
            Self::PermitVerified => "permit_verified",
            Self::CommitAttempted => "commit_attempted",
            Self::Applied => "applied",
            Self::ExactReplay => "exact_replay",
            Self::Conflict => "conflict",
            Self::RecoveryPending => "recovery_pending",
            Self::Expired => "expired",
        }
    }

    pub const fn terminal(self) -> bool {
        matches!(
            self,
            Self::Applied | Self::ExactReplay | Self::Conflict | Self::Expired
        )
    }

    fn expiry_enforced(self) -> bool {
        matches!(
            self,
            Self::ChallengeIssued
                | Self::FinishClaimed
                | Self::ProofVerified
                | Self::PermitRequestFrozen
                | Self::PermitVerified
        )
    }

    fn deadline_alarm_required(self) -> bool {
        self.expiry_enforced() || self == Self::CommitAttempted
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CoordinatorStateV1 {
    begin: BeginEvidenceV1,
    commit_attempt: Option<CommitAttemptEvidenceV1>,
    contract_version: u8,
    created_at_ms: i64,
    expiration: Option<ExpirationEvidenceV1>,
    expires_at_ms: i64,
    finish_claim: Option<FinishClaimEvidenceV1>,
    generation: u32,
    identity: CoordinatorIdentityV1,
    latest_event_sha256: String,
    outcome: Option<OutcomeEvidenceV1>,
    permit_request: Option<PermitRequestEvidenceV1>,
    permit_verified: Option<PermitVerifiedEvidenceV1>,
    phase: CoordinatorPhase,
    proof_verified: Option<ProofVerifiedEvidenceV1>,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum EventActor {
    Caller,
    Alarm,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CoordinatorEventV1 {
    actor: EventActor,
    body_sha256: Option<String>,
    contract_version: u8,
    event_sha256: String,
    evidence_sha256: String,
    from_phase: Option<CoordinatorPhase>,
    generation: u32,
    occurred_at_ms: i64,
    previous_event_sha256: String,
    request_id_sha256: Option<String>,
    to_phase: CoordinatorPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReplayRecordV1 {
    body_sha256: String,
    contract_version: u8,
    event_sha256: String,
    path: String,
    request_id_sha256: String,
    resulting_generation: u32,
    resulting_phase: CoordinatorPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BeginRequestV1 {
    pub command: String,
    pub evidence: BeginEvidenceV1,
    pub expected_generation: u32,
    pub expires_at_ms: i64,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinishClaimRequestV1 {
    pub command: String,
    pub evidence: FinishClaimEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProofVerifiedRequestV1 {
    pub command: String,
    pub evidence: ProofVerifiedEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PermitRequestFrozenRequestV1 {
    pub command: String,
    pub evidence: PermitRequestEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PermitVerifiedRequestV1 {
    pub command: String,
    pub evidence: PermitVerifiedEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitAttemptedRequestV1 {
    pub command: String,
    pub evidence: CommitAttemptEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutcomeRecordedRequestV1 {
    pub command: String,
    pub evidence: OutcomeEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StatusRequestV1 {
    pub command: String,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoverRequestV1 {
    pub command: String,
    pub evidence: OutcomeEvidenceV1,
    pub expected_generation: u32,
    pub identity: CoordinatorIdentityV1,
    pub request_id_sha256: String,
}

#[derive(Debug, Clone)]
enum MutationRequestV1 {
    Begin(BeginRequestV1),
    FinishClaim(FinishClaimRequestV1),
    ProofVerified(ProofVerifiedRequestV1),
    PermitRequestFrozen(PermitRequestFrozenRequestV1),
    PermitVerified(PermitVerifiedRequestV1),
    CommitAttempted(CommitAttemptedRequestV1),
    OutcomeRecorded(OutcomeRecordedRequestV1),
    Recover(RecoverRequestV1),
}

impl MutationRequestV1 {
    fn identity(&self) -> &CoordinatorIdentityV1 {
        match self {
            Self::Begin(value) => &value.identity,
            Self::FinishClaim(value) => &value.identity,
            Self::ProofVerified(value) => &value.identity,
            Self::PermitRequestFrozen(value) => &value.identity,
            Self::PermitVerified(value) => &value.identity,
            Self::CommitAttempted(value) => &value.identity,
            Self::OutcomeRecorded(value) => &value.identity,
            Self::Recover(value) => &value.identity,
        }
    }

    fn request_id_sha256(&self) -> &str {
        match self {
            Self::Begin(value) => &value.request_id_sha256,
            Self::FinishClaim(value) => &value.request_id_sha256,
            Self::ProofVerified(value) => &value.request_id_sha256,
            Self::PermitRequestFrozen(value) => &value.request_id_sha256,
            Self::PermitVerified(value) => &value.request_id_sha256,
            Self::CommitAttempted(value) => &value.request_id_sha256,
            Self::OutcomeRecorded(value) => &value.request_id_sha256,
            Self::Recover(value) => &value.request_id_sha256,
        }
    }

    fn expected_generation(&self) -> u32 {
        match self {
            Self::Begin(value) => value.expected_generation,
            Self::FinishClaim(value) => value.expected_generation,
            Self::ProofVerified(value) => value.expected_generation,
            Self::PermitRequestFrozen(value) => value.expected_generation,
            Self::PermitVerified(value) => value.expected_generation,
            Self::CommitAttempted(value) => value.expected_generation,
            Self::OutcomeRecorded(value) => value.expected_generation,
            Self::Recover(value) => value.expected_generation,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorStatusResponseV1 {
    pub contract_version: u8,
    pub event_count: u32,
    pub expires_at_ms: i64,
    pub generation: u32,
    pub latest_event_sha256: String,
    pub operation_id_sha256: String,
    pub outcome: Option<OutcomeEvidenceV1>,
    pub phase: CoordinatorPhase,
    pub replayed: bool,
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorErrorResponseV1 {
    pub code: String,
    pub contract_version: u8,
}

#[derive(Debug, Clone)]
struct AppliedTransition {
    event: CoordinatorEventV1,
    replay: Option<ReplayRecordV1>,
    state: CoordinatorStateV1,
}

#[durable_object]
pub struct DrainSourceRegistrationCoordinator {
    state: State,
    env: Env,
}

#[durable_object]
impl DurableObject for DrainSourceRegistrationCoordinator {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&mut self, mut req: Request) -> WorkerResult<Response> {
        let route = CoordinatorRoute::parse(&req.path());
        if route == CoordinatorRoute::NotFound {
            return error_response(404, "not_found");
        }
        if req.method() != Method::Post {
            return error_response(405, "method_not_allowed");
        }
        if !has_json_content_type(&req) {
            return error_response(415, "invalid_content_type");
        }
        let url = match req.url() {
            Ok(value) if value.query().is_none() && value.path() == route.path() => value,
            _ => return error_response(404, "not_found"),
        };
        let path = url.path().to_string();
        let body = match read_bounded_body(&mut req).await {
            Ok(value) => value,
            Err(error) => return error_response(error.status, error.code),
        };
        if canonical_json_value(&body).is_err() {
            return error_response(400, "invalid_canonical_json");
        }
        let configuration = match AuthorityConfiguration::load(&self.env) {
            Ok(value) => value,
            Err(error) => return error_response(error.status, error.code),
        };
        let authentication =
            match verify_authority(&req, &body, &path, &configuration, unix_timestamp_seconds()) {
                Ok(value) => value,
                Err(error) => return error_response(error.status, error.code),
            };

        match route {
            CoordinatorRoute::Begin | CoordinatorRoute::Finish | CoordinatorRoute::Recover => {
                let request = match parse_mutation_request(route, &body) {
                    Ok(value) => value,
                    Err(error) => return error_response(error.status, error.code),
                };
                if request.request_id_sha256() != authentication.request_id_sha256 {
                    return error_response(403, "invalid_authority");
                }
                if let Err(error) =
                    validate_identity(request.identity(), &configuration.environment)
                {
                    return error_response(error.status, error.code);
                }
                if let Err(error) =
                    self.validate_object(request.identity(), &authentication.object_name)
                {
                    return error_response(error.status, error.code);
                }
                self.mutate(route, body).await
            }
            CoordinatorRoute::Status => {
                let request = match parse_status_request(&body) {
                    Ok(value) => value,
                    Err(error) => return error_response(error.status, error.code),
                };
                if request.request_id_sha256 != authentication.request_id_sha256 {
                    return error_response(403, "invalid_authority");
                }
                if let Err(error) = validate_identity(&request.identity, &configuration.environment)
                {
                    return error_response(error.status, error.code);
                }
                if let Err(error) =
                    self.validate_object(&request.identity, &authentication.object_name)
                {
                    return error_response(error.status, error.code);
                }
                self.status(&request.identity).await
            }
            CoordinatorRoute::NotFound => error_response(404, "not_found"),
        }
    }

    async fn alarm(&mut self) -> WorkerResult<Response> {
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();
        let transaction = storage
            .transaction(move |mut transaction| async move {
                let values = transaction.get_multiple(vec![STATE_KEY]).await?;
                let Some(current) =
                    map_record::<CoordinatorStateV1>(&values, STATE_KEY).map_err(storage_error)?
                else {
                    return Err(Error::RustError(TX_NO_EXPIRATION.to_string()));
                };
                validate_stored_state(&current).map_err(storage_error)?;
                let Some(applied) = deadline_transition(current, now_ms, EventActor::Alarm) else {
                    return Err(Error::RustError(TX_NO_EXPIRATION.to_string()));
                };
                persist_transition(&mut transaction, &applied).await
            })
            .await;

        match transaction {
            Ok(()) => {}
            Err(error) if error.to_string().contains(TX_NO_EXPIRATION) => {}
            Err(error) if error.to_string().contains(TX_STORAGE_CORRUPT) => {
                return error_response(500, "coordinator_storage_unavailable");
            }
            Err(error) => return Err(error),
        }
        self.reconcile_alarm().await?;
        Response::empty()
    }
}

impl DrainSourceRegistrationCoordinator {
    fn validate_object(
        &self,
        identity: &CoordinatorIdentityV1,
        authenticated_object_name: &str,
    ) -> Result<(), ProtocolError> {
        let expected_name = coordinator_object_name(identity)?;
        if expected_name != authenticated_object_name {
            return Err(ProtocolError::new(403, "invalid_authority"));
        }
        let namespace = self
            .env
            .durable_object(COORDINATOR_BINDING)
            .map_err(|_| ProtocolError::new(503, "coordinator_unavailable"))?;
        let expected_id = namespace
            .id_from_name(&expected_name)
            .map_err(|_| ProtocolError::new(503, "coordinator_unavailable"))?;
        if expected_id.to_string() != self.state.id().to_string() {
            return Err(ProtocolError::new(403, "invalid_authority"));
        }
        Ok(())
    }

    async fn mutate(&mut self, route: CoordinatorRoute, body: Vec<u8>) -> WorkerResult<Response> {
        let mut transaction_body = [0_u8; MAX_JSON_BODY_BYTES];
        transaction_body[..body.len()].copy_from_slice(&body);
        let body_length = body.len();
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();
        let transaction = storage
            .transaction(move |mut transaction| async move {
                let request = parse_mutation_request(route, &transaction_body[..body_length])
                    .map_err(|_| Error::RustError(TX_STATE_CONFLICT.to_string()))?;
                let body_sha256 = sha256_hex(&transaction_body[..body_length]);
                let replay_key = replay_key(request.request_id_sha256());
                let values = transaction
                    .get_multiple(vec![STATE_KEY.to_string(), replay_key.clone()])
                    .await?;
                if let Some(replay) =
                    map_record::<ReplayRecordV1>(&values, &replay_key).map_err(storage_error)?
                {
                    if replay.body_sha256 == body_sha256
                        && replay.path == route.path()
                        && replay.request_id_sha256 == request.request_id_sha256()
                    {
                        let replay_event_key = event_key(replay.resulting_generation);
                        let replay_event_values = transaction
                            .get_multiple(vec![replay_event_key.clone()])
                            .await?;
                        let replay_event = map_record::<CoordinatorEventV1>(
                            &replay_event_values,
                            &replay_event_key,
                        )
                        .map_err(storage_error)?
                        .ok_or_else(|| Error::RustError(TX_STORAGE_CORRUPT.to_string()))?;
                        validate_replay_record(&replay, &replay_event).map_err(storage_error)?;
                        return Err(Error::RustError(TX_EXACT_REPLAY.to_string()));
                    }
                    return Err(Error::RustError(TX_REQUEST_CONFLICT.to_string()));
                }
                let current =
                    map_record::<CoordinatorStateV1>(&values, STATE_KEY).map_err(storage_error)?;
                if let Some(value) = current.as_ref() {
                    validate_stored_state(value).map_err(storage_error)?;
                }
                let applied = apply_mutation(current, request, route, &body_sha256, now_ms)
                    .map_err(|error| Error::RustError(error.to_string()))?;
                persist_transition(&mut transaction, &applied).await
            })
            .await;

        let replayed = match transaction {
            Ok(()) => false,
            Err(error) if error.to_string().contains(TX_EXACT_REPLAY) => true,
            Err(error)
                if error.to_string().contains(TX_REQUEST_CONFLICT)
                    || error.to_string().contains(TX_STATE_CONFLICT) =>
            {
                return error_response(409, "coordinator_state_conflict");
            }
            Err(error) if error.to_string().contains(TX_EXPIRED) => {
                return error_response(410, "coordinator_expired");
            }
            Err(error) if error.to_string().contains(TX_STORAGE_CORRUPT) => {
                return error_response(500, "coordinator_storage_unavailable");
            }
            Err(error) => return Err(error),
        };

        let state = match self.read_verified_state().await {
            Ok(Some(value)) => value,
            Ok(None) => return error_response(500, "coordinator_storage_unavailable"),
            Err(error) if error.to_string().contains(TX_STORAGE_CORRUPT) => {
                return error_response(500, "coordinator_storage_unavailable");
            }
            Err(error) => return Err(error),
        };
        self.reconcile_alarm_for_state(&state).await?;
        let status = mutation_status(route, &state, replayed);
        status_response(&state, replayed, status)
    }

    async fn status(&mut self, identity: &CoordinatorIdentityV1) -> WorkerResult<Response> {
        self.expire_if_due().await?;
        let state = match self.read_verified_state().await {
            Ok(Some(value)) => value,
            Ok(None) => return error_response(404, "coordinator_not_found"),
            Err(error) if error.to_string().contains(TX_STORAGE_CORRUPT) => {
                return error_response(500, "coordinator_storage_unavailable");
            }
            Err(error) => return Err(error),
        };
        if &state.identity != identity {
            return error_response(409, "coordinator_state_conflict");
        }
        self.reconcile_alarm_for_state(&state).await?;
        status_response(&state, false, 200)
    }

    async fn expire_if_due(&mut self) -> WorkerResult<()> {
        let now_ms = unix_timestamp_ms();
        let mut storage = self.state.storage();
        let transaction = storage
            .transaction(move |mut transaction| async move {
                let values = transaction.get_multiple(vec![STATE_KEY]).await?;
                let Some(current) =
                    map_record::<CoordinatorStateV1>(&values, STATE_KEY).map_err(storage_error)?
                else {
                    return Err(Error::RustError(TX_NO_EXPIRATION.to_string()));
                };
                validate_stored_state(&current).map_err(storage_error)?;
                let Some(applied) = deadline_transition(current, now_ms, EventActor::Alarm) else {
                    return Err(Error::RustError(TX_NO_EXPIRATION.to_string()));
                };
                persist_transition(&mut transaction, &applied).await
            })
            .await;
        match transaction {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains(TX_NO_EXPIRATION) => Ok(()),
            Err(error) if error.to_string().contains(TX_STORAGE_CORRUPT) => Ok(()),
            Err(error) => Err(error),
        }
    }

    async fn read_verified_state(&self) -> WorkerResult<Option<CoordinatorStateV1>> {
        let storage = self.state.storage();
        let values = storage.get_multiple(vec![STATE_KEY]).await?;
        let Some(state) =
            map_record::<CoordinatorStateV1>(&values, STATE_KEY).map_err(storage_error)?
        else {
            return Ok(None);
        };
        validate_stored_state(&state)
            .map_err(storage_error)
            .map_err(|_| Error::RustError(TX_STORAGE_CORRUPT.to_string()))?;
        let event_keys = (1..=state.generation).map(event_key).collect::<Vec<_>>();
        let event_values = storage.get_multiple(event_keys.clone()).await?;
        let object_name = coordinator_object_name(&state.identity)
            .map_err(|_| Error::RustError(TX_STORAGE_CORRUPT.to_string()))?;
        let mut previous_event_sha256 = event_genesis_sha256(&object_name);
        let mut previous_phase = None;
        let mut previous_occurred_at_ms = state.created_at_ms;
        for (index, key) in event_keys.iter().enumerate() {
            let event = map_record::<CoordinatorEventV1>(&event_values, key)
                .map_err(storage_error)?
                .ok_or_else(|| Error::RustError(TX_STORAGE_CORRUPT.to_string()))?;
            validate_event_record(
                &event,
                (index as u32) + 1,
                previous_phase,
                &previous_event_sha256,
                previous_occurred_at_ms,
                state.updated_at_ms,
            )
            .map_err(|_| Error::RustError(TX_STORAGE_CORRUPT.to_string()))?;
            previous_event_sha256 = event.event_sha256;
            previous_phase = Some(event.to_phase);
            previous_occurred_at_ms = event.occurred_at_ms;
        }
        if previous_event_sha256 != state.latest_event_sha256
            || previous_phase != Some(state.phase)
            || previous_occurred_at_ms != state.updated_at_ms
        {
            return Err(Error::RustError(TX_STORAGE_CORRUPT.to_string()));
        }
        Ok(Some(state))
    }

    async fn reconcile_alarm(&self) -> WorkerResult<()> {
        match self.read_verified_state().await? {
            Some(state) => self.reconcile_alarm_for_state(&state).await,
            None => {
                self.state.storage().delete_alarm().await?;
                Ok(())
            }
        }
    }

    async fn reconcile_alarm_for_state(&self, state: &CoordinatorStateV1) -> WorkerResult<()> {
        if state.phase.deadline_alarm_required() {
            let delay_ms = state
                .expires_at_ms
                .saturating_sub(unix_timestamp_ms())
                .max(0) as u64;
            self.state
                .storage()
                .set_alarm(Duration::from_millis(delay_ms))
                .await
        } else {
            self.state.storage().delete_alarm().await
        }
    }
}

impl AuthorityConfiguration {
    fn load(env: &Env) -> Result<Self, ProtocolError> {
        let environment = required_env(env, ENVIRONMENT_VAR)?;
        if environment != "local" && environment != "staging" {
            return Err(ProtocolError::new(503, "coordinator_unavailable"));
        }
        let issuer = required_env(env, AUTHORITY_ISSUER_VAR)?;
        let audience = required_env(env, AUTHORITY_AUDIENCE_VAR)?;
        if !valid_identifier(&issuer) || !valid_identifier(&audience) || issuer == audience {
            return Err(ProtocolError::new(503, "coordinator_unavailable"));
        }
        let caller_identity_sha256 = required_env(env, CALLER_IDENTITY_VAR)?;
        if !valid_sha256(&caller_identity_sha256) {
            return Err(ProtocolError::new(503, "coordinator_unavailable"));
        }
        let current = HmacKey {
            kid: required_env(env, CURRENT_KID_VAR)?,
            secret: required_hmac_secret(env, CURRENT_SECRET_VAR, &environment)?,
        };
        if !valid_hmac_key(&current) {
            return Err(ProtocolError::new(503, "coordinator_unavailable"));
        }

        let previous_values = (
            optional_env(env, PREVIOUS_KID_VAR),
            optional_hmac_secret(env, PREVIOUS_SECRET_VAR, &environment),
        );
        let previous_configured = previous_values.0.is_some() || previous_values.1.is_some();
        let previous = if previous_configured {
            let Some(kid) = previous_values.0 else {
                return Err(ProtocolError::new(503, "coordinator_unavailable"));
            };
            let Some(secret) = previous_values.1 else {
                return Err(ProtocolError::new(503, "coordinator_unavailable"));
            };
            let value = HmacKey { kid, secret };
            if !valid_hmac_key(&value) || value.kid == current.kid || value.secret == current.secret
            {
                return Err(ProtocolError::new(503, "coordinator_unavailable"));
            }
            Some(value)
        } else {
            None
        };

        Ok(Self {
            environment,
            issuer,
            audience,
            caller_identity_sha256,
            current,
            previous,
        })
    }

    fn key(&self, kid: &str) -> Option<&HmacKey> {
        if self.current.kid == kid {
            return Some(&self.current);
        }
        self.previous.as_ref().filter(|value| value.kid == kid)
    }
}

fn verify_authority(
    request: &Request,
    body: &[u8],
    path: &str,
    configuration: &AuthorityConfiguration,
    now_seconds: i64,
) -> Result<AuthenticatedRequest, ProtocolError> {
    let token = request
        .headers()
        .get(AUTHORITY_HEADER)
        .map_err(|_| ProtocolError::new(403, "invalid_authority"))?
        .ok_or_else(|| ProtocolError::new(403, "invalid_authority"))?;
    if token.is_empty() || token.len() > MAX_AUTHORITY_BYTES {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|value| value.is_empty()) {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    let header_bytes = decode_canonical_base64url(parts[0], 1024)?;
    let header = parse_canonical_json::<AuthorityHeaderV1>(&header_bytes)
        .map_err(|_| ProtocolError::new(403, "invalid_authority"))?;
    if header.alg != "HS256" || header.typ != AUTHORITY_TYPE || !valid_key_id(&header.kid) {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    let key = configuration
        .key(&header.kid)
        .ok_or_else(|| ProtocolError::new(403, "invalid_authority"))?;
    let signature = decode_canonical_base64url(parts[2], 32)?;
    if signature.len() != 32 {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    let mut mac = HmacSha256::new_from_slice(key.secret.as_bytes())
        .map_err(|_| ProtocolError::new(503, "coordinator_unavailable"))?;
    mac.update(AUTHORITY_DOMAIN);
    mac.update(parts[0].as_bytes());
    mac.update(b".");
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| ProtocolError::new(403, "invalid_authority"))?;

    let claims_bytes = decode_canonical_base64url(parts[1], MAX_AUTHORITY_PART_BYTES)?;
    let claims = parse_canonical_json::<AuthorityClaimsV1>(&claims_bytes)
        .map_err(|_| ProtocolError::new(403, "invalid_authority"))?;
    let body_sha256 = sha256_hex(body);
    if claims.issuer != configuration.issuer
        || claims.audience != configuration.audience
        || claims.caller_identity_sha256 != configuration.caller_identity_sha256
        || claims.method != "POST"
        || claims.method != request.method().to_string()
        || claims.path != path
        || claims.body_sha256 != body_sha256
        || !valid_sha256(&claims.request_id_sha256)
        || !valid_object_name(&claims.object_name)
    {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    if claims.issued_at > now_seconds.saturating_add(CLOCK_SKEW_SECONDS)
        || now_seconds.saturating_sub(claims.issued_at) > AUTHORITY_WINDOW_SECONDS
        || claims.expires_at <= now_seconds
        || claims.expires_at <= claims.issued_at
        || claims.expires_at.saturating_sub(claims.issued_at) > AUTHORITY_WINDOW_SECONDS
    {
        return Err(ProtocolError::new(403, "authority_time_window"));
    }
    Ok(AuthenticatedRequest {
        object_name: claims.object_name,
        request_id_sha256: claims.request_id_sha256,
    })
}

fn parse_mutation_request(
    route: CoordinatorRoute,
    body: &[u8],
) -> Result<MutationRequestV1, ProtocolError> {
    let value = canonical_json_value(body)?;
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ProtocolError::new(400, "invalid_request"))?;
    let request = match (route, command) {
        (CoordinatorRoute::Begin, "begin") => {
            let value = serde_json::from_value::<BeginRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_begin_evidence(&value.evidence)?;
            MutationRequestV1::Begin(value)
        }
        (CoordinatorRoute::Finish, "claim_finish") => {
            let value = serde_json::from_value::<FinishClaimRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_finish_claim_evidence(&value.evidence)?;
            MutationRequestV1::FinishClaim(value)
        }
        (CoordinatorRoute::Finish, "record_proof") => {
            let value = serde_json::from_value::<ProofVerifiedRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_proof_evidence(&value.evidence)?;
            MutationRequestV1::ProofVerified(value)
        }
        (CoordinatorRoute::Finish, "freeze_permit_request") => {
            let value = serde_json::from_value::<PermitRequestFrozenRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_permit_request_evidence(&value.evidence)?;
            MutationRequestV1::PermitRequestFrozen(value)
        }
        (CoordinatorRoute::Finish, "record_permit") => {
            let value = serde_json::from_value::<PermitVerifiedRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_permit_evidence(&value.evidence)?;
            MutationRequestV1::PermitVerified(value)
        }
        (CoordinatorRoute::Finish, "record_commit_attempt") => {
            let value = serde_json::from_value::<CommitAttemptedRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_commit_evidence(&value.evidence)?;
            MutationRequestV1::CommitAttempted(value)
        }
        (CoordinatorRoute::Finish, "record_outcome") => {
            let value = serde_json::from_value::<OutcomeRecordedRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_outcome_evidence(&value.evidence, true)?;
            MutationRequestV1::OutcomeRecorded(value)
        }
        (CoordinatorRoute::Recover, "recover") => {
            let value = serde_json::from_value::<RecoverRequestV1>(value)
                .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
            validate_outcome_evidence(&value.evidence, false)?;
            MutationRequestV1::Recover(value)
        }
        _ => return Err(ProtocolError::new(400, "invalid_request")),
    };
    validate_identity(request.identity(), request.identity().environment.as_str())?;
    if !valid_sha256(request.request_id_sha256()) {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    Ok(request)
}

fn parse_status_request(body: &[u8]) -> Result<StatusRequestV1, ProtocolError> {
    let value = parse_canonical_json::<StatusRequestV1>(body)?;
    if value.command != "status" || !valid_sha256(&value.request_id_sha256) {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    Ok(value)
}

pub fn validate_wire_request_v1(path: &str, expected_environment: &str, body: &[u8]) -> bool {
    if body.is_empty() || body.len() > MAX_JSON_BODY_BYTES {
        return false;
    }
    let route = CoordinatorRoute::parse(path);
    match route {
        CoordinatorRoute::Begin | CoordinatorRoute::Finish | CoordinatorRoute::Recover => {
            parse_mutation_request(route, body).is_ok_and(|request| {
                validate_identity(request.identity(), expected_environment).is_ok()
            })
        }
        CoordinatorRoute::Status => parse_status_request(body).is_ok_and(|request| {
            validate_identity(&request.identity, expected_environment).is_ok()
        }),
        CoordinatorRoute::NotFound => false,
    }
}

fn apply_mutation(
    current: Option<CoordinatorStateV1>,
    request: MutationRequestV1,
    route: CoordinatorRoute,
    body_sha256: &str,
    now_ms: i64,
) -> Result<AppliedTransition, &'static str> {
    if let Some(value) = current.as_ref() {
        if value.identity != *request.identity() {
            return Err(TX_STATE_CONFLICT);
        }
        if value.phase == CoordinatorPhase::Expired {
            return Err(TX_EXPIRED);
        }
        if value.phase.expiry_enforced() && now_ms >= value.expires_at_ms {
            return deadline_transition(value.clone(), now_ms, EventActor::Alarm)
                .ok_or(TX_STATE_CONFLICT);
        }
    }

    let request_id = request.request_id_sha256().to_string();
    let expected_generation = request.expected_generation();
    let (mut state, from_phase, to_phase) = match request {
        MutationRequestV1::Begin(value) => {
            if current.is_some()
                || value.expected_generation != 0
                || value.expires_at_ms <= now_ms
                || value.expires_at_ms.saturating_sub(now_ms) > MAX_CEREMONY_LIFETIME_MS
            {
                return Err(TX_STATE_CONFLICT);
            }
            let state = CoordinatorStateV1 {
                begin: value.evidence,
                commit_attempt: None,
                contract_version: 1,
                created_at_ms: now_ms,
                expiration: None,
                expires_at_ms: value.expires_at_ms,
                finish_claim: None,
                generation: 0,
                identity: value.identity,
                latest_event_sha256: String::new(),
                outcome: None,
                permit_request: None,
                permit_verified: None,
                phase: CoordinatorPhase::ChallengeIssued,
                proof_verified: None,
                updated_at_ms: now_ms,
            };
            (state, None, CoordinatorPhase::ChallengeIssued)
        }
        MutationRequestV1::FinishClaim(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::ChallengeIssued,
            )?;
            state.finish_claim = Some(value.evidence);
            (
                state,
                Some(CoordinatorPhase::ChallengeIssued),
                CoordinatorPhase::FinishClaimed,
            )
        }
        MutationRequestV1::ProofVerified(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::FinishClaimed,
            )?;
            state.proof_verified = Some(value.evidence);
            (
                state,
                Some(CoordinatorPhase::FinishClaimed),
                CoordinatorPhase::ProofVerified,
            )
        }
        MutationRequestV1::PermitRequestFrozen(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::ProofVerified,
            )?;
            state.permit_request = Some(value.evidence);
            (
                state,
                Some(CoordinatorPhase::ProofVerified),
                CoordinatorPhase::PermitRequestFrozen,
            )
        }
        MutationRequestV1::PermitVerified(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::PermitRequestFrozen,
            )?;
            state.permit_verified = Some(value.evidence);
            (
                state,
                Some(CoordinatorPhase::PermitRequestFrozen),
                CoordinatorPhase::PermitVerified,
            )
        }
        MutationRequestV1::CommitAttempted(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::PermitVerified,
            )?;
            state.commit_attempt = Some(value.evidence);
            (
                state,
                Some(CoordinatorPhase::PermitVerified),
                CoordinatorPhase::CommitAttempted,
            )
        }
        MutationRequestV1::OutcomeRecorded(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::CommitAttempted,
            )?;
            validate_outcome_for_state(&state, &value.evidence)?;
            let phase = outcome_phase(value.evidence.outcome)?;
            state.outcome = Some(value.evidence);
            (state, Some(CoordinatorPhase::CommitAttempted), phase)
        }
        MutationRequestV1::Recover(value) => {
            let mut state = required_state(
                current,
                expected_generation,
                CoordinatorPhase::RecoveryPending,
            )?;
            validate_outcome_for_state(&state, &value.evidence)?;
            let phase = outcome_phase(value.evidence.outcome)?;
            if phase == CoordinatorPhase::RecoveryPending {
                return Err(TX_STATE_CONFLICT);
            }
            state.outcome = Some(value.evidence);
            (state, Some(CoordinatorPhase::RecoveryPending), phase)
        }
    };

    let previous_event_sha256 = if state.generation == 0 {
        event_genesis_sha256(
            &coordinator_object_name(&state.identity).map_err(|_| TX_STATE_CONFLICT)?,
        )
    } else {
        state.latest_event_sha256.clone()
    };
    state.generation = state.generation.checked_add(1).ok_or(TX_STORAGE_CORRUPT)?;
    state.phase = to_phase;
    state.updated_at_ms = now_ms;
    let event = build_event(
        EventActor::Caller,
        Some(body_sha256),
        body_sha256,
        from_phase,
        state.generation,
        now_ms,
        &previous_event_sha256,
        Some(&request_id),
        to_phase,
    );
    state.latest_event_sha256 = event.event_sha256.clone();
    validate_stored_state(&state).map_err(|_| TX_STORAGE_CORRUPT)?;
    let replay = ReplayRecordV1 {
        body_sha256: body_sha256.to_string(),
        contract_version: 1,
        event_sha256: event.event_sha256.clone(),
        path: route.path().to_string(),
        request_id_sha256: request_id,
        resulting_generation: state.generation,
        resulting_phase: state.phase,
    };
    Ok(AppliedTransition {
        event,
        replay: Some(replay),
        state,
    })
}

fn required_state(
    current: Option<CoordinatorStateV1>,
    expected_generation: u32,
    expected_phase: CoordinatorPhase,
) -> Result<CoordinatorStateV1, &'static str> {
    let state = current.ok_or(TX_STATE_CONFLICT)?;
    if state.generation != expected_generation || state.phase != expected_phase {
        return Err(TX_STATE_CONFLICT);
    }
    Ok(state)
}

fn deadline_transition(
    mut state: CoordinatorStateV1,
    now_ms: i64,
    actor: EventActor,
) -> Option<AppliedTransition> {
    if !state.phase.deadline_alarm_required() || now_ms < state.expires_at_ms {
        return None;
    }
    let from_phase = state.phase;
    let evidence_sha256 = length_prefixed_sha256(
        EXPIRATION_EVIDENCE_DOMAIN,
        &[
            state.identity.operation_id_sha256.as_bytes(),
            from_phase.as_str().as_bytes(),
            state.expires_at_ms.to_string().as_bytes(),
        ],
    );
    let previous_event_sha256 = state.latest_event_sha256.clone();
    state.generation = state.generation.checked_add(1)?;
    state.updated_at_ms = now_ms;
    let to_phase = if from_phase == CoordinatorPhase::CommitAttempted {
        let command_id_sha256 = state.commit_attempt.as_ref()?.command_id_sha256.clone();
        state.outcome = Some(OutcomeEvidenceV1 {
            authoritative_readback_sha256: evidence_sha256.clone(),
            command_id_sha256,
            outcome: RegistrationOutcome::OutcomeUnknown,
            winner_command_id_sha256: None,
        });
        CoordinatorPhase::RecoveryPending
    } else {
        state.expiration = Some(ExpirationEvidenceV1 {
            evidence_sha256: evidence_sha256.clone(),
            expired_at_ms: now_ms,
            from_phase,
        });
        CoordinatorPhase::Expired
    };
    state.phase = to_phase;
    let event = build_event(
        actor,
        None,
        &evidence_sha256,
        Some(from_phase),
        state.generation,
        now_ms,
        &previous_event_sha256,
        None,
        to_phase,
    );
    state.latest_event_sha256 = event.event_sha256.clone();
    Some(AppliedTransition {
        event,
        replay: None,
        state,
    })
}

async fn persist_transition(
    transaction: &mut worker::Transaction,
    applied: &AppliedTransition,
) -> WorkerResult<()> {
    transaction
        .put(&event_key(applied.state.generation), &applied.event)
        .await?;
    transaction.put(STATE_KEY, &applied.state).await?;
    if let Some(replay) = applied.replay.as_ref() {
        transaction
            .put(&replay_key(&replay.request_id_sha256), replay)
            .await?;
    }
    Ok(())
}

fn build_event(
    actor: EventActor,
    body_sha256: Option<&str>,
    evidence_sha256: &str,
    from_phase: Option<CoordinatorPhase>,
    generation: u32,
    occurred_at_ms: i64,
    previous_event_sha256: &str,
    request_id_sha256: Option<&str>,
    to_phase: CoordinatorPhase,
) -> CoordinatorEventV1 {
    let actor_value = match actor {
        EventActor::Caller => "caller",
        EventActor::Alarm => "alarm",
    };
    let event_sha256 = length_prefixed_sha256(
        EVENT_DOMAIN,
        &[
            actor_value.as_bytes(),
            body_sha256.unwrap_or("").as_bytes(),
            evidence_sha256.as_bytes(),
            from_phase
                .map(CoordinatorPhase::as_str)
                .unwrap_or("")
                .as_bytes(),
            generation.to_string().as_bytes(),
            occurred_at_ms.to_string().as_bytes(),
            previous_event_sha256.as_bytes(),
            request_id_sha256.unwrap_or("").as_bytes(),
            to_phase.as_str().as_bytes(),
        ],
    );
    CoordinatorEventV1 {
        actor,
        body_sha256: body_sha256.map(str::to_string),
        contract_version: 1,
        event_sha256,
        evidence_sha256: evidence_sha256.to_string(),
        from_phase,
        generation,
        occurred_at_ms,
        previous_event_sha256: previous_event_sha256.to_string(),
        request_id_sha256: request_id_sha256.map(str::to_string),
        to_phase,
    }
}

fn validate_event_record(
    event: &CoordinatorEventV1,
    expected_generation: u32,
    expected_from_phase: Option<CoordinatorPhase>,
    expected_previous_event_sha256: &str,
    minimum_occurred_at_ms: i64,
    maximum_occurred_at_ms: i64,
) -> Result<(), &'static str> {
    let valid_actor_evidence = match event.actor {
        EventActor::Caller => {
            event.body_sha256.as_deref() == Some(event.evidence_sha256.as_str())
                && event.request_id_sha256.is_some()
        }
        EventActor::Alarm => {
            event.body_sha256.is_none()
                && event.request_id_sha256.is_none()
                && matches!(
                    event.to_phase,
                    CoordinatorPhase::Expired | CoordinatorPhase::RecoveryPending
                )
        }
    };
    if event.contract_version != 1
        || event.generation != expected_generation
        || event.from_phase != expected_from_phase
        || event.previous_event_sha256 != expected_previous_event_sha256
        || event.occurred_at_ms < minimum_occurred_at_ms
        || event.occurred_at_ms > maximum_occurred_at_ms
        || !valid_sha256(&event.event_sha256)
        || !valid_sha256(&event.evidence_sha256)
        || event
            .body_sha256
            .as_ref()
            .is_some_and(|value| !valid_sha256(value))
        || event
            .request_id_sha256
            .as_ref()
            .is_some_and(|value| !valid_sha256(value))
        || !valid_actor_evidence
        || !valid_event_transition(event.from_phase, event.to_phase)
        || !valid_phase_generation_v1(event.to_phase, event.generation)
    {
        return Err(TX_STORAGE_CORRUPT);
    }
    let rebuilt = build_event(
        event.actor,
        event.body_sha256.as_deref(),
        &event.evidence_sha256,
        event.from_phase,
        event.generation,
        event.occurred_at_ms,
        &event.previous_event_sha256,
        event.request_id_sha256.as_deref(),
        event.to_phase,
    );
    if rebuilt.event_sha256 != event.event_sha256 {
        return Err(TX_STORAGE_CORRUPT);
    }
    Ok(())
}

fn validate_replay_record(
    replay: &ReplayRecordV1,
    event: &CoordinatorEventV1,
) -> Result<(), &'static str> {
    if replay.contract_version != 1
        || !matches!(
            replay.path.as_str(),
            BEGIN_PATH | FINISH_PATH | RECOVER_PATH
        )
        || !valid_sha256(&replay.body_sha256)
        || !valid_sha256(&replay.event_sha256)
        || !valid_sha256(&replay.request_id_sha256)
        || !valid_phase_generation_v1(replay.resulting_phase, replay.resulting_generation)
        || event.contract_version != 1
        || event.actor != EventActor::Caller
        || event.generation != replay.resulting_generation
        || event.to_phase != replay.resulting_phase
        || event.event_sha256 != replay.event_sha256
        || event.body_sha256.as_deref() != Some(replay.body_sha256.as_str())
        || event.request_id_sha256.as_deref() != Some(replay.request_id_sha256.as_str())
    {
        return Err(TX_STORAGE_CORRUPT);
    }
    Ok(())
}

const fn valid_event_transition(from: Option<CoordinatorPhase>, to: CoordinatorPhase) -> bool {
    matches!(
        (from, to),
        (None, CoordinatorPhase::ChallengeIssued)
            | (
                Some(CoordinatorPhase::ChallengeIssued),
                CoordinatorPhase::FinishClaimed | CoordinatorPhase::Expired
            )
            | (
                Some(CoordinatorPhase::FinishClaimed),
                CoordinatorPhase::ProofVerified | CoordinatorPhase::Expired
            )
            | (
                Some(CoordinatorPhase::ProofVerified),
                CoordinatorPhase::PermitRequestFrozen | CoordinatorPhase::Expired
            )
            | (
                Some(CoordinatorPhase::PermitRequestFrozen),
                CoordinatorPhase::PermitVerified | CoordinatorPhase::Expired
            )
            | (
                Some(CoordinatorPhase::PermitVerified),
                CoordinatorPhase::CommitAttempted | CoordinatorPhase::Expired
            )
            | (
                Some(CoordinatorPhase::CommitAttempted),
                CoordinatorPhase::RecoveryPending
                    | CoordinatorPhase::Applied
                    | CoordinatorPhase::ExactReplay
                    | CoordinatorPhase::Conflict
            )
            | (
                Some(CoordinatorPhase::RecoveryPending),
                CoordinatorPhase::Applied
                    | CoordinatorPhase::ExactReplay
                    | CoordinatorPhase::Conflict
            )
    )
}

const fn valid_phase_generation_v1(phase: CoordinatorPhase, generation: u32) -> bool {
    match phase {
        CoordinatorPhase::ChallengeIssued => generation == 1,
        CoordinatorPhase::FinishClaimed => generation == 2,
        CoordinatorPhase::ProofVerified => generation == 3,
        CoordinatorPhase::PermitRequestFrozen => generation == 4,
        CoordinatorPhase::PermitVerified => generation == 5,
        CoordinatorPhase::CommitAttempted => generation == 6,
        CoordinatorPhase::RecoveryPending => generation == 7,
        CoordinatorPhase::Applied | CoordinatorPhase::ExactReplay | CoordinatorPhase::Conflict => {
            generation == 7 || generation == 8
        }
        CoordinatorPhase::Expired => generation >= 2 && generation <= 6,
    }
}

fn validate_stored_state(state: &CoordinatorStateV1) -> Result<(), &'static str> {
    validate_identity(&state.identity, &state.identity.environment)
        .map_err(|_| TX_STORAGE_CORRUPT)?;
    validate_begin_evidence(&state.begin).map_err(|_| TX_STORAGE_CORRUPT)?;
    if state.contract_version != 1
        || state.generation == 0
        || state.generation > 8
        || state.created_at_ms <= 0
        || state.updated_at_ms < state.created_at_ms
        || state.expires_at_ms <= state.created_at_ms
        || !valid_sha256(&state.latest_event_sha256)
    {
        return Err(TX_STORAGE_CORRUPT);
    }
    let progress = match state.phase {
        CoordinatorPhase::ChallengeIssued => 1,
        CoordinatorPhase::FinishClaimed => 2,
        CoordinatorPhase::ProofVerified => 3,
        CoordinatorPhase::PermitRequestFrozen => 4,
        CoordinatorPhase::PermitVerified => 5,
        CoordinatorPhase::CommitAttempted => 6,
        CoordinatorPhase::RecoveryPending
        | CoordinatorPhase::Applied
        | CoordinatorPhase::ExactReplay
        | CoordinatorPhase::Conflict => 7,
        CoordinatorPhase::Expired => {
            let expiration = state.expiration.as_ref().ok_or(TX_STORAGE_CORRUPT)?;
            if !expiration.from_phase.expiry_enforced()
                || !valid_sha256(&expiration.evidence_sha256)
                || expiration.expired_at_ms < state.expires_at_ms
            {
                return Err(TX_STORAGE_CORRUPT);
            }
            match expiration.from_phase {
                CoordinatorPhase::ChallengeIssued => 1,
                CoordinatorPhase::FinishClaimed => 2,
                CoordinatorPhase::ProofVerified => 3,
                CoordinatorPhase::PermitRequestFrozen => 4,
                CoordinatorPhase::PermitVerified => 5,
                _ => return Err(TX_STORAGE_CORRUPT),
            }
        }
    };
    let valid_generation = match state.phase {
        CoordinatorPhase::Applied | CoordinatorPhase::ExactReplay | CoordinatorPhase::Conflict => {
            matches!(state.generation, 7 | 8)
        }
        CoordinatorPhase::Expired => state.generation == progress + 1,
        _ => state.generation == progress,
    };
    if !valid_generation {
        return Err(TX_STORAGE_CORRUPT);
    }
    if (state.finish_claim.is_some()) != (progress >= 2)
        || (state.proof_verified.is_some()) != (progress >= 3)
        || (state.permit_request.is_some()) != (progress >= 4)
        || (state.permit_verified.is_some()) != (progress >= 5)
        || (state.commit_attempt.is_some()) != (progress >= 6)
    {
        return Err(TX_STORAGE_CORRUPT);
    }
    if let Some(value) = state.finish_claim.as_ref() {
        validate_finish_claim_evidence(value).map_err(|_| TX_STORAGE_CORRUPT)?;
    }
    if let Some(value) = state.proof_verified.as_ref() {
        validate_proof_evidence(value).map_err(|_| TX_STORAGE_CORRUPT)?;
    }
    if let Some(value) = state.permit_request.as_ref() {
        validate_permit_request_evidence(value).map_err(|_| TX_STORAGE_CORRUPT)?;
    }
    if let Some(value) = state.permit_verified.as_ref() {
        validate_permit_evidence(value).map_err(|_| TX_STORAGE_CORRUPT)?;
    }
    if let Some(value) = state.commit_attempt.as_ref() {
        validate_commit_evidence(value).map_err(|_| TX_STORAGE_CORRUPT)?;
    }
    match state.phase {
        CoordinatorPhase::RecoveryPending => {
            let value = state.outcome.as_ref().ok_or(TX_STORAGE_CORRUPT)?;
            if value.outcome != RegistrationOutcome::OutcomeUnknown {
                return Err(TX_STORAGE_CORRUPT);
            }
            validate_outcome_for_state(state, value)?;
        }
        CoordinatorPhase::Applied => {
            validate_terminal_outcome(state, RegistrationOutcome::FreshApplied)?;
        }
        CoordinatorPhase::ExactReplay => {
            validate_terminal_outcome(state, RegistrationOutcome::ExactReplay)?;
        }
        CoordinatorPhase::Conflict => {
            validate_terminal_outcome(state, RegistrationOutcome::Conflict)?;
        }
        CoordinatorPhase::Expired => {
            if state.outcome.is_some() {
                return Err(TX_STORAGE_CORRUPT);
            }
        }
        _ => {
            if state.outcome.is_some() || state.expiration.is_some() {
                return Err(TX_STORAGE_CORRUPT);
            }
        }
    }
    if state.phase != CoordinatorPhase::Expired && state.expiration.is_some() {
        return Err(TX_STORAGE_CORRUPT);
    }
    Ok(())
}

fn validate_terminal_outcome(
    state: &CoordinatorStateV1,
    expected: RegistrationOutcome,
) -> Result<(), &'static str> {
    let value = state.outcome.as_ref().ok_or(TX_STORAGE_CORRUPT)?;
    if value.outcome != expected {
        return Err(TX_STORAGE_CORRUPT);
    }
    validate_outcome_for_state(state, value)
}

fn validate_outcome_for_state(
    state: &CoordinatorStateV1,
    evidence: &OutcomeEvidenceV1,
) -> Result<(), &'static str> {
    validate_outcome_evidence(evidence, true).map_err(|_| TX_STATE_CONFLICT)?;
    let command = state.commit_attempt.as_ref().ok_or(TX_STATE_CONFLICT)?;
    if command.command_id_sha256 != evidence.command_id_sha256 {
        return Err(TX_STATE_CONFLICT);
    }
    match evidence.outcome {
        RegistrationOutcome::FreshApplied | RegistrationOutcome::ExactReplay => {
            if evidence.winner_command_id_sha256.as_deref()
                != Some(command.command_id_sha256.as_str())
            {
                return Err(TX_STATE_CONFLICT);
            }
        }
        RegistrationOutcome::Conflict => {
            if evidence
                .winner_command_id_sha256
                .as_deref()
                .is_none_or(|winner| winner == command.command_id_sha256)
            {
                return Err(TX_STATE_CONFLICT);
            }
        }
        RegistrationOutcome::OutcomeUnknown => {
            if evidence.winner_command_id_sha256.is_some() {
                return Err(TX_STATE_CONFLICT);
            }
        }
    }
    Ok(())
}

fn outcome_phase(outcome: RegistrationOutcome) -> Result<CoordinatorPhase, &'static str> {
    match outcome {
        RegistrationOutcome::FreshApplied => Ok(CoordinatorPhase::Applied),
        RegistrationOutcome::ExactReplay => Ok(CoordinatorPhase::ExactReplay),
        RegistrationOutcome::Conflict => Ok(CoordinatorPhase::Conflict),
        RegistrationOutcome::OutcomeUnknown => Ok(CoordinatorPhase::RecoveryPending),
    }
}

fn validate_identity(
    identity: &CoordinatorIdentityV1,
    expected_environment: &str,
) -> Result<(), ProtocolError> {
    if identity.contract_version != 1
        || identity.environment != expected_environment
        || (identity.environment != "local" && identity.environment != "staging")
        || identity.scope_kind != "global"
        || !valid_sha256(&identity.scope_id_sha256)
        || !valid_sha256(&identity.operation_id_sha256)
        || !valid_sha256(&identity.authorization_id_sha256)
        || !valid_root_user_id(&identity.root_user_id)
    {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    Ok(())
}

fn validate_begin_evidence(value: &BeginEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.authority_fingerprint_sha256,
        &value.begin_intent_sha256,
        &value.ceremony_id_sha256,
        &value.challenge_phase_proof_sha256,
        &value.challenge_sha256,
    ])
}

fn validate_finish_claim_evidence(value: &FinishClaimEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.assertion_envelope_sha256,
        &value.finish_claim_id_sha256,
    ])
}

fn validate_proof_evidence(value: &ProofVerifiedEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.passkey_assertion_signature_sha256,
        &value.passkey_state_transition_sha256,
        &value.verified_passkey_proof_sha256,
    ])
}

fn validate_permit_request_evidence(value: &PermitRequestEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.issuer_auth_key_id_sha256,
        &value.issuer_phase_proof_sha256,
        &value.issuer_request_id_sha256,
        &value.issuer_request_sha256,
    ])
}

fn validate_permit_evidence(value: &PermitVerifiedEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.issuer_version_sha256,
        &value.permit_id_sha256,
        &value.permit_signature_envelope_sha256,
        &value.permit_subject_sha256,
    ])
}

fn validate_commit_evidence(value: &CommitAttemptEvidenceV1) -> Result<(), ProtocolError> {
    validate_distinct_digests(&[
        &value.command_body_sha256,
        &value.command_id_sha256,
        &value.commit_phase_proof_sha256,
    ])
}

fn validate_outcome_evidence(
    value: &OutcomeEvidenceV1,
    allow_unknown: bool,
) -> Result<(), ProtocolError> {
    if !valid_sha256(&value.authoritative_readback_sha256)
        || !valid_sha256(&value.command_id_sha256)
        || value
            .winner_command_id_sha256
            .as_ref()
            .is_some_and(|winner| !valid_sha256(winner))
        || (!allow_unknown && value.outcome == RegistrationOutcome::OutcomeUnknown)
    {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    Ok(())
}

fn validate_distinct_digests(values: &[&String]) -> Result<(), ProtocolError> {
    if values.iter().any(|value| !valid_sha256(value)) {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    for (index, value) in values.iter().enumerate() {
        if values[index + 1..]
            .iter()
            .any(|candidate| candidate == value)
        {
            return Err(ProtocolError::new(400, "invalid_request"));
        }
    }
    Ok(())
}

pub fn derive_coordinator_object_name_v1(identity: &CoordinatorIdentityV1) -> Option<String> {
    coordinator_object_name(identity).ok()
}

pub fn canonical_json_bytes<T: Serialize>(
    value: &T,
) -> std::result::Result<Vec<u8>, serde_json::Error> {
    let value = serde_json::to_value(value)?;
    serde_json::to_vec(&canonicalize_json_value(value))
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

fn coordinator_object_name(identity: &CoordinatorIdentityV1) -> Result<String, ProtocolError> {
    validate_identity(identity, &identity.environment)?;
    let digest = length_prefixed_sha256(
        OBJECT_NAME_DOMAIN,
        &[
            identity.environment.as_bytes(),
            identity.root_user_id.as_bytes(),
            identity.scope_kind.as_bytes(),
            identity.scope_id_sha256.as_bytes(),
            identity.operation_id_sha256.as_bytes(),
        ],
    );
    Ok(format!("drain-source-registration-coordinator-v1:{digest}"))
}

fn event_genesis_sha256(object_name: &str) -> String {
    length_prefixed_sha256(EVENT_GENESIS_DOMAIN, &[object_name.as_bytes()])
}

fn length_prefixed_sha256(domain: &[u8], fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u32).to_be_bytes());
        hasher.update(field);
    }
    hex_lower(&hasher.finalize())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

fn canonical_json_value(body: &[u8]) -> Result<serde_json::Value, ProtocolError> {
    if body.is_empty() {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    let value = serde_json::from_slice::<serde_json::Value>(body)
        .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
    let canonical =
        canonical_json_bytes(&value).map_err(|_| ProtocolError::new(400, "invalid_request"))?;
    if canonical != body {
        return Err(ProtocolError::new(400, "invalid_canonical_json"));
    }
    Ok(value)
}

fn canonicalize_json_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(canonicalize_json_value).collect())
        }
        serde_json::Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize_json_value(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

fn parse_canonical_json<T: DeserializeOwned>(body: &[u8]) -> Result<T, ProtocolError> {
    let value = canonical_json_value(body)?;
    serde_json::from_value(value).map_err(|_| ProtocolError::new(400, "invalid_request"))
}

fn decode_canonical_base64url(value: &str, max_bytes: usize) -> Result<Vec<u8>, ProtocolError> {
    if value.contains('=') {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ProtocolError::new(403, "invalid_authority"))?;
    if bytes.is_empty() || bytes.len() > max_bytes || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(ProtocolError::new(403, "invalid_authority"));
    }
    Ok(bytes)
}

fn required_env(env: &Env, name: &str) -> Result<String, ProtocolError> {
    env.var(name)
        .map(|value| value.to_string())
        .map_err(|_| ProtocolError::new(503, "coordinator_unavailable"))
        .and_then(|value| {
            if value.is_empty() {
                Err(ProtocolError::new(503, "coordinator_unavailable"))
            } else {
                Ok(value)
            }
        })
}

fn optional_env(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn required_hmac_secret(env: &Env, name: &str, environment: &str) -> Result<String, ProtocolError> {
    optional_hmac_secret(env, name, environment)
        .ok_or_else(|| ProtocolError::new(503, "coordinator_unavailable"))
}

fn optional_hmac_secret(env: &Env, name: &str, environment: &str) -> Option<String> {
    let secret = env
        .secret(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());
    if secret.is_some() {
        return secret;
    }
    if environment == "local" {
        return optional_env(env, name);
    }
    None
}

fn valid_hmac_key(value: &HmacKey) -> bool {
    valid_key_id(&value.kid) && (32..=256).contains(&value.secret.as_bytes().len())
}

fn valid_identifier(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    valid_identifier(value)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_root_user_id(value: &str) -> bool {
    let Ok(parsed) = value.parse::<u64>() else {
        return false;
    };
    parsed > 0 && parsed <= MAX_SAFE_INTEGER && parsed.to_string() == value
}

fn valid_object_name(value: &str) -> bool {
    value
        .strip_prefix("drain-source-registration-coordinator-v1:")
        .is_some_and(valid_sha256)
}

fn has_json_content_type(req: &Request) -> bool {
    let Some(value) = req.headers().get("Content-Type").ok().flatten() else {
        return false;
    };
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|media_type| media_type.eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(parameter), None) => parameter.eq_ignore_ascii_case("charset=utf-8"),
        _ => false,
    }
}

async fn read_bounded_body(req: &mut Request) -> Result<Vec<u8>, ProtocolError> {
    if let Some(raw) = req.headers().get("Content-Length").ok().flatten() {
        let length = raw
            .parse::<usize>()
            .map_err(|_| ProtocolError::new(400, "invalid_content_length"))?;
        if length > MAX_JSON_BODY_BYTES {
            return Err(ProtocolError::new(413, "request_too_large"));
        }
    }
    let mut stream = req
        .stream()
        .map_err(|_| ProtocolError::new(400, "invalid_request"))?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ProtocolError::new(400, "invalid_request"))?;
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
            return Err(ProtocolError::new(413, "request_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Err(ProtocolError::new(400, "invalid_request"));
    }
    Ok(body)
}

fn map_record<T: DeserializeOwned>(map: &Map, key: &str) -> WorkerResult<Option<T>> {
    let key = JsValue::from_str(key);
    if !map.has(&key) {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(map.get(&key))
        .map(Some)
        .map_err(|_| Error::RustError(TX_STORAGE_CORRUPT.to_string()))
}

fn storage_error(_: impl std::fmt::Display) -> Error {
    Error::RustError(TX_STORAGE_CORRUPT.to_string())
}

fn replay_key(request_id_sha256: &str) -> String {
    format!("{REPLAY_PREFIX}{request_id_sha256}")
}

fn event_key(generation: u32) -> String {
    format!("{EVENT_PREFIX}{generation:020}")
}

fn mutation_status(route: CoordinatorRoute, state: &CoordinatorStateV1, replayed: bool) -> u16 {
    match state.phase {
        CoordinatorPhase::Expired => 410,
        CoordinatorPhase::RecoveryPending => 202,
        CoordinatorPhase::Conflict => 409,
        CoordinatorPhase::ChallengeIssued if route == CoordinatorRoute::Begin && !replayed => 201,
        _ => 200,
    }
}

fn status_response(
    state: &CoordinatorStateV1,
    replayed: bool,
    status: u16,
) -> WorkerResult<Response> {
    let body = CoordinatorStatusResponseV1 {
        contract_version: 1,
        event_count: state.generation,
        expires_at_ms: state.expires_at_ms,
        generation: state.generation,
        latest_event_sha256: state.latest_event_sha256.clone(),
        operation_id_sha256: state.identity.operation_id_sha256.clone(),
        outcome: state.outcome.clone(),
        phase: state.phase,
        replayed,
        terminal: state.phase.terminal(),
    };
    bounded_json_response(&body, status)
}

fn error_response(status: u16, code: &'static str) -> WorkerResult<Response> {
    bounded_json_response(
        &CoordinatorErrorResponseV1 {
            code: code.to_string(),
            contract_version: 1,
        },
        status,
    )
}

fn bounded_json_response<T: Serialize>(body: &T, status: u16) -> WorkerResult<Response> {
    let bytes = serde_json::to_vec(body)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(Error::RustError(
            "coordinator response exceeded internal limit".to_string(),
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| Error::RustError("coordinator response encoding failed".to_string()))?;
    let mut response = Response::ok(text)?.with_status(status);
    response
        .headers_mut()
        .set("Content-Type", "application/json; charset=utf-8")?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    Ok(response)
}

fn unix_timestamp_ms() -> i64 {
    js_sys::Date::now() as i64
}

fn unix_timestamp_seconds() -> i64 {
    unix_timestamp_ms() / 1_000
}

#[cfg(test)]
mod tests {
    use super::{
        apply_mutation, coordinator_object_name, deadline_transition, event_genesis_sha256,
        validate_event_record, validate_replay_record, validate_stored_state, BeginEvidenceV1,
        BeginRequestV1, CommitAttemptEvidenceV1, CommitAttemptedRequestV1, CoordinatorIdentityV1,
        CoordinatorPhase, CoordinatorRoute, EventActor, FinishClaimEvidenceV1,
        FinishClaimRequestV1, MutationRequestV1, OutcomeEvidenceV1, OutcomeRecordedRequestV1,
        PermitRequestEvidenceV1, PermitRequestFrozenRequestV1, PermitVerifiedEvidenceV1,
        PermitVerifiedRequestV1, ProofVerifiedEvidenceV1, ProofVerifiedRequestV1, RecoverRequestV1,
        RegistrationOutcome,
    };

    fn digest(character: char) -> String {
        character.to_string().repeat(64)
    }

    fn identity() -> CoordinatorIdentityV1 {
        CoordinatorIdentityV1 {
            authorization_id_sha256: digest('a'),
            contract_version: 1,
            environment: "local".to_string(),
            operation_id_sha256: digest('b'),
            root_user_id: "42".to_string(),
            scope_id_sha256: digest('c'),
            scope_kind: "global".to_string(),
        }
    }

    fn begin(request_id: char, now_ms: i64) -> MutationRequestV1 {
        MutationRequestV1::Begin(BeginRequestV1 {
            command: "begin".to_string(),
            evidence: BeginEvidenceV1 {
                authority_fingerprint_sha256: digest('d'),
                begin_intent_sha256: digest('e'),
                ceremony_id_sha256: digest('f'),
                challenge_phase_proof_sha256: digest('1'),
                challenge_sha256: digest('2'),
            },
            expected_generation: 0,
            expires_at_ms: now_ms + 30_000,
            identity: identity(),
            request_id_sha256: digest(request_id),
        })
    }

    fn apply(
        current: Option<super::CoordinatorStateV1>,
        request: MutationRequestV1,
        route: CoordinatorRoute,
        body: char,
        now_ms: i64,
    ) -> super::CoordinatorStateV1 {
        apply_mutation(current, request, route, &digest(body), now_ms)
            .expect("transition")
            .state
    }

    #[test]
    fn object_name_vector_is_stable() {
        assert_eq!(
            coordinator_object_name(&identity()).unwrap(),
            "drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce"
        );
        assert_eq!(
            event_genesis_sha256(
                "drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce"
            ),
            "e503102a11fa67966e984a9d93708c6831831415db9d514de3a3c010e4c7bd34"
        );
    }

    #[test]
    fn full_state_machine_reaches_recovery_and_terminal() {
        let now = 2_100_000_000_000;
        let mut state = apply(None, begin('3', now), CoordinatorRoute::Begin, '4', now);
        state = apply(
            Some(state),
            MutationRequestV1::FinishClaim(FinishClaimRequestV1 {
                command: "claim_finish".to_string(),
                evidence: FinishClaimEvidenceV1 {
                    assertion_envelope_sha256: digest('5'),
                    finish_claim_id_sha256: digest('6'),
                },
                expected_generation: 1,
                identity: identity(),
                request_id_sha256: digest('7'),
            }),
            CoordinatorRoute::Finish,
            '8',
            now + 1,
        );
        state = apply(
            Some(state),
            MutationRequestV1::ProofVerified(ProofVerifiedRequestV1 {
                command: "record_proof".to_string(),
                evidence: ProofVerifiedEvidenceV1 {
                    passkey_assertion_signature_sha256: digest('9'),
                    passkey_state_transition_sha256: digest('0'),
                    verified_passkey_proof_sha256: digest('a'),
                },
                expected_generation: 2,
                identity: identity(),
                request_id_sha256: digest('b'),
            }),
            CoordinatorRoute::Finish,
            'c',
            now + 2,
        );
        state = apply(
            Some(state),
            MutationRequestV1::PermitRequestFrozen(PermitRequestFrozenRequestV1 {
                command: "freeze_permit_request".to_string(),
                evidence: PermitRequestEvidenceV1 {
                    issuer_auth_key_id_sha256: digest('d'),
                    issuer_phase_proof_sha256: digest('e'),
                    issuer_request_id_sha256: digest('f'),
                    issuer_request_sha256: digest('1'),
                },
                expected_generation: 3,
                identity: identity(),
                request_id_sha256: digest('2'),
            }),
            CoordinatorRoute::Finish,
            '3',
            now + 3,
        );
        state = apply(
            Some(state),
            MutationRequestV1::PermitVerified(PermitVerifiedRequestV1 {
                command: "record_permit".to_string(),
                evidence: PermitVerifiedEvidenceV1 {
                    issuer_version_sha256: digest('4'),
                    permit_id_sha256: digest('5'),
                    permit_signature_envelope_sha256: digest('6'),
                    permit_subject_sha256: digest('7'),
                },
                expected_generation: 4,
                identity: identity(),
                request_id_sha256: digest('8'),
            }),
            CoordinatorRoute::Finish,
            '9',
            now + 4,
        );
        state = apply(
            Some(state),
            MutationRequestV1::CommitAttempted(CommitAttemptedRequestV1 {
                command: "record_commit_attempt".to_string(),
                evidence: CommitAttemptEvidenceV1 {
                    command_body_sha256: digest('0'),
                    command_id_sha256: digest('a'),
                    commit_phase_proof_sha256: digest('b'),
                },
                expected_generation: 5,
                identity: identity(),
                request_id_sha256: digest('c'),
            }),
            CoordinatorRoute::Finish,
            'd',
            now + 5,
        );
        state = apply(
            Some(state),
            MutationRequestV1::OutcomeRecorded(OutcomeRecordedRequestV1 {
                command: "record_outcome".to_string(),
                evidence: OutcomeEvidenceV1 {
                    authoritative_readback_sha256: digest('e'),
                    command_id_sha256: digest('a'),
                    outcome: RegistrationOutcome::OutcomeUnknown,
                    winner_command_id_sha256: None,
                },
                expected_generation: 6,
                identity: identity(),
                request_id_sha256: digest('f'),
            }),
            CoordinatorRoute::Finish,
            '1',
            now + 6,
        );
        assert_eq!(state.phase, CoordinatorPhase::RecoveryPending);
        assert_eq!(state.generation, 7);

        state = apply(
            Some(state),
            MutationRequestV1::Recover(RecoverRequestV1 {
                command: "recover".to_string(),
                evidence: OutcomeEvidenceV1 {
                    authoritative_readback_sha256: digest('2'),
                    command_id_sha256: digest('a'),
                    outcome: RegistrationOutcome::FreshApplied,
                    winner_command_id_sha256: Some(digest('a')),
                },
                expected_generation: 7,
                identity: identity(),
                request_id_sha256: digest('3'),
            }),
            CoordinatorRoute::Recover,
            '4',
            now + 7,
        );
        assert_eq!(state.phase, CoordinatorPhase::Applied);
        assert_eq!(state.generation, 8);
        validate_stored_state(&state).unwrap();
    }

    #[test]
    fn expiry_burns_precommit_state_but_not_commit_recovery() {
        let now = 2_100_000_000_000;
        let mut state = apply(None, begin('3', now), CoordinatorRoute::Begin, '4', now);
        let expired = deadline_transition(state.clone(), now + 30_000, EventActor::Alarm)
            .unwrap()
            .state;
        assert_eq!(expired.phase, CoordinatorPhase::Expired);
        assert_eq!(expired.generation, 2);
        validate_stored_state(&expired).unwrap();

        state.expires_at_ms = now - 1;
        state.phase = CoordinatorPhase::CommitAttempted;
        state.finish_claim = Some(FinishClaimEvidenceV1 {
            assertion_envelope_sha256: digest('5'),
            finish_claim_id_sha256: digest('6'),
        });
        state.proof_verified = Some(ProofVerifiedEvidenceV1 {
            passkey_assertion_signature_sha256: digest('7'),
            passkey_state_transition_sha256: digest('8'),
            verified_passkey_proof_sha256: digest('9'),
        });
        state.permit_request = Some(PermitRequestEvidenceV1 {
            issuer_auth_key_id_sha256: digest('0'),
            issuer_phase_proof_sha256: digest('a'),
            issuer_request_id_sha256: digest('b'),
            issuer_request_sha256: digest('c'),
        });
        state.permit_verified = Some(PermitVerifiedEvidenceV1 {
            issuer_version_sha256: digest('d'),
            permit_id_sha256: digest('e'),
            permit_signature_envelope_sha256: digest('f'),
            permit_subject_sha256: digest('1'),
        });
        state.commit_attempt = Some(CommitAttemptEvidenceV1 {
            command_body_sha256: digest('2'),
            command_id_sha256: digest('3'),
            commit_phase_proof_sha256: digest('4'),
        });
        state.generation = 6;
        let recovery = deadline_transition(state, now, EventActor::Alarm)
            .unwrap()
            .state;
        assert_eq!(recovery.phase, CoordinatorPhase::RecoveryPending);
        assert_eq!(recovery.generation, 7);
    }

    #[test]
    fn stale_or_skipped_transition_is_rejected() {
        let now = 2_100_000_000_000;
        let state = apply(None, begin('3', now), CoordinatorRoute::Begin, '4', now);
        let skipped = MutationRequestV1::ProofVerified(ProofVerifiedRequestV1 {
            command: "record_proof".to_string(),
            evidence: ProofVerifiedEvidenceV1 {
                passkey_assertion_signature_sha256: digest('5'),
                passkey_state_transition_sha256: digest('6'),
                verified_passkey_proof_sha256: digest('7'),
            },
            expected_generation: 1,
            identity: identity(),
            request_id_sha256: digest('8'),
        });
        assert!(apply_mutation(
            Some(state),
            skipped,
            CoordinatorRoute::Finish,
            &digest('9'),
            now + 1
        )
        .is_err());
    }

    #[test]
    fn stored_generation_event_and_replay_tampering_are_rejected() {
        let now = 2_100_000_000_000;
        let object_name = coordinator_object_name(&identity()).unwrap();
        let transition = apply_mutation(
            None,
            begin('3', now),
            CoordinatorRoute::Begin,
            &digest('4'),
            now,
        )
        .unwrap();
        let genesis = event_genesis_sha256(&object_name);

        validate_stored_state(&transition.state).unwrap();
        validate_event_record(&transition.event, 1, None, &genesis, now, now).unwrap();
        validate_replay_record(transition.replay.as_ref().unwrap(), &transition.event).unwrap();

        let mut drifted_state = transition.state.clone();
        drifted_state.generation = 2;
        assert!(validate_stored_state(&drifted_state).is_err());

        let mut drifted_event = transition.event.clone();
        drifted_event.generation = 2;
        assert!(validate_event_record(&drifted_event, 2, None, &genesis, now, now).is_err());

        let mut forged_event = transition.event.clone();
        forged_event.event_sha256 = digest('5');
        assert!(validate_event_record(&forged_event, 1, None, &genesis, now, now).is_err());

        let mut drifted_replay = transition.replay.unwrap();
        drifted_replay.resulting_phase = CoordinatorPhase::FinishClaimed;
        assert!(validate_replay_record(&drifted_replay, &transition.event).is_err());
    }
}
