use serde::de::{Error as _, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::marker::PhantomData;

pub const CLAIM_CONTRACT: &str = "cinatoken-relay-container-ring-transition-execution-claim-v1";
pub const STEP_CONTRACT: &str = "cinatoken-relay-container-ring-transition-execution-step-v1";
pub const EXPIRY_CONTRACT: &str = "cinatoken-relay-container-ring-transition-expiry-event-v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_APPEND_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Claimed,
    T1Verified,
    ControllerInflight,
    ControllerVerified,
    EdgePrechecked,
    EdgeInflight,
    Completed,
    RecoveryRequired,
    Aborted,
    Expired,
}

impl ClaimStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::RecoveryRequired | Self::Aborted | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepCode {
    T1Readback,
    ControllerMutationIntent,
    ControllerPostReadback,
    EdgePreReadback,
    EdgeMutationIntent,
    EdgePostReadback,
    Terminal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportOutcome {
    NotApplicable,
    Success,
    Ambiguous,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum FailureClass {
    #[serde(rename = "")]
    None,
    #[serde(rename = "authorization_expired")]
    AuthorizationExpired,
    #[serde(rename = "operator_abort")]
    OperatorAbort,
    #[serde(rename = "transport_response_lost")]
    TransportResponseLost,
    #[serde(rename = "http_rejected")]
    HttpRejected,
    #[serde(rename = "readback_drift")]
    ReadbackDrift,
    #[serde(rename = "target_not_stable")]
    TargetNotStable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServiceTarget {
    pub service_name: String,
    pub previous_version_id: String,
    pub previous_deployment_set_sha256: String,
    pub target_version_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotClaim {
    pub schema_version: u8,
    pub claim_authority: String,
    pub claim_scope: String,
    pub environment: String,
    pub authorization_id_sha256: String,
    pub execution_nonce_sha256: String,
    pub authorization_manifest_sha256: String,
    pub authorization_subject_sha256: String,
    pub authorization_policy_sha256: String,
    pub transition_manifest_sha256: String,
    pub transition_subject_sha256: String,
    pub transition_policy_sha256: String,
    pub transition_plan_sha256: String,
    pub candidate_sha256: String,
    pub execution_plan_sha256: String,
    pub account_id_sha256: String,
    pub ledger_identity_sha256: String,
    pub read_credential_id_sha256: String,
    pub claim_credential_id_sha256: String,
    pub deploy_credential_id_sha256: String,
    pub controller: ServiceTarget,
    pub edge: ServiceTarget,
    pub runner_build_sha256: String,
    pub runner_trust_config_sha256: String,
    pub claim_owner_sha256: String,
    pub claim_digest_sha256: String,
    pub generated_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotState {
    pub authorization_id_sha256: String,
    pub claim_digest_sha256: String,
    pub claim_owner_sha256: String,
    pub ledger_identity_sha256: String,
    pub claim_credential_id_sha256: String,
    pub status: ClaimStatus,
    pub state_version: u8,
    pub generated_at: u64,
    pub claimed_at: u64,
    pub expires_at: u64,
    pub updated_at: u64,
    pub terminal_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotStep {
    pub state_version: u8,
    pub step_code: StepCode,
    pub from_status: ClaimStatus,
    pub to_status: ClaimStatus,
    pub actor_execution_id_sha256: String,
    pub mutation_request_sha256: Option<String>,
    pub cloudflare_request_id_sha256: Option<String>,
    pub deployment_set_sha256: Option<String>,
    pub evidence_sha256: String,
    pub failure_class: FailureClass,
    pub transport_outcome: TransportOutcome,
    pub step_digest_sha256: String,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SnapshotExpiryEvent {
    pub state_version: u8,
    pub from_status: ClaimStatus,
    pub to_status: ClaimStatus,
    pub authority_actor_id_sha256: String,
    pub evidence_sha256: String,
    pub expiry_event_digest_sha256: String,
    pub failure_class: FailureClass,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthoritySnapshot {
    pub claim: SnapshotClaim,
    pub state: SnapshotState,
    pub steps: Vec<SnapshotStep>,
    pub expiry_events: Vec<SnapshotExpiryEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedSnapshot {
    snapshot: AuthoritySnapshot,
}

impl VerifiedSnapshot {
    pub fn from_json(bytes: &[u8]) -> Result<Self, OrchestratorError> {
        reject_duplicate_json(bytes, MAX_SNAPSHOT_BYTES)?;
        let snapshot: AuthoritySnapshot =
            serde_json::from_slice(bytes).map_err(|_| OrchestratorError::InvalidJson)?;
        validate_snapshot(&snapshot)?;
        Ok(Self { snapshot })
    }

    pub fn authorization_id_sha256(&self) -> &str {
        &self.snapshot.claim.authorization_id_sha256
    }

    pub fn claim_digest_sha256(&self) -> &str {
        &self.snapshot.claim.claim_digest_sha256
    }

    pub fn status(&self) -> ClaimStatus {
        self.snapshot.state.status
    }

    pub fn state_version(&self) -> u8 {
        self.snapshot.state.state_version
    }

    pub fn decision(&self, now: u64) -> Result<RunnerDecision, OrchestratorError> {
        if now < self.snapshot.claim.generated_at {
            return Err(OrchestratorError::ClockBeforeClaim);
        }
        let expired = now >= self.snapshot.claim.expires_at;
        Ok(match self.snapshot.state.status {
            ClaimStatus::Claimed if expired => RunnerDecision::AwaitAuthorityExpiry,
            ClaimStatus::T1Verified if expired => RunnerDecision::AwaitAuthorityExpiry,
            ClaimStatus::ControllerVerified | ClaimStatus::EdgePrechecked if expired => {
                RunnerDecision::AwaitAuthorityRecovery
            }
            ClaimStatus::Claimed => RunnerDecision::ReadT1,
            ClaimStatus::T1Verified => RunnerDecision::AppendControllerIntent,
            ClaimStatus::ControllerInflight => RunnerDecision::ObserveController,
            ClaimStatus::ControllerVerified => RunnerDecision::ReadEdgePrevious,
            ClaimStatus::EdgePrechecked => RunnerDecision::AppendEdgeIntent,
            ClaimStatus::EdgeInflight => RunnerDecision::ObserveEdge,
            ClaimStatus::Completed
            | ClaimStatus::RecoveryRequired
            | ClaimStatus::Aborted
            | ClaimStatus::Expired => RunnerDecision::SealReceipt,
        })
    }

    fn service<P: MutationPhase>(&self) -> &ServiceTarget {
        if P::STATE_VERSION == 2 {
            &self.snapshot.claim.controller
        } else {
            &self.snapshot.claim.edge
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunnerDecision {
    ReadT1,
    AppendControllerIntent,
    ObserveController,
    ReadEdgePrevious,
    AppendEdgeIntent,
    ObserveEdge,
    AwaitAuthorityExpiry,
    AwaitAuthorityRecovery,
    SealReceipt,
}

pub struct ControllerMutation;
pub struct EdgeMutation;

mod sealed {
    pub trait Sealed {}
}

pub trait MutationPhase: sealed::Sealed {
    const STATE_VERSION: u8;
    const STEP_CODE: StepCode;
    const FROM_STATUS: ClaimStatus;
    const TO_STATUS: ClaimStatus;
    const DECISION: RunnerDecision;
}

impl sealed::Sealed for ControllerMutation {}
impl MutationPhase for ControllerMutation {
    const STATE_VERSION: u8 = 2;
    const STEP_CODE: StepCode = StepCode::ControllerMutationIntent;
    const FROM_STATUS: ClaimStatus = ClaimStatus::T1Verified;
    const TO_STATUS: ClaimStatus = ClaimStatus::ControllerInflight;
    const DECISION: RunnerDecision = RunnerDecision::AppendControllerIntent;
}

impl sealed::Sealed for EdgeMutation {}
impl MutationPhase for EdgeMutation {
    const STATE_VERSION: u8 = 5;
    const STEP_CODE: StepCode = StepCode::EdgeMutationIntent;
    const FROM_STATUS: ClaimStatus = ClaimStatus::EdgePrechecked;
    const TO_STATUS: ClaimStatus = ClaimStatus::EdgeInflight;
    const DECISION: RunnerDecision = RunnerDecision::AppendEdgeIntent;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationIntentStep {
    pub schema_version: u8,
    pub contract: &'static str,
    pub ledger_identity_sha256: String,
    pub claim_digest_sha256: String,
    pub state_version: u8,
    pub step_code: StepCode,
    pub from_status: ClaimStatus,
    pub to_status: ClaimStatus,
    pub mutation_request_sha256: Option<String>,
    pub cloudflare_request_id_sha256: Option<String>,
    pub deployment_set_sha256: Option<String>,
    pub evidence_sha256: String,
    pub failure_class: FailureClass,
    pub transport_outcome: TransportOutcome,
    pub step_digest_sha256: String,
}

#[derive(Debug, Eq, PartialEq)]
pub struct PreparedMutationIntent<P: MutationPhase> {
    step: MutationIntentStep,
    authorization_id_sha256: String,
    service_name: String,
    target_version_id: String,
    expires_at: u64,
    phase: PhantomData<P>,
}

pub struct AuthorityAppendAttempt<P: MutationPhase> {
    intent: PreparedMutationIntent<P>,
    request_id: String,
}

impl<P: MutationPhase> AuthorityAppendAttempt<P> {
    pub fn canonical_step_json(&self) -> Result<String, OrchestratorError> {
        self.intent.canonical_step_json()
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

pub fn begin_authority_append<P: MutationPhase>(
    intent: PreparedMutationIntent<P>,
    request_id: &str,
) -> Result<AuthorityAppendAttempt<P>, OrchestratorError> {
    require_token(request_id, 1, 128, "request_id")?;
    Ok(AuthorityAppendAttempt {
        intent,
        request_id: request_id.to_owned(),
    })
}

impl<P: MutationPhase> PreparedMutationIntent<P> {
    pub fn step(&self) -> &MutationIntentStep {
        &self.step
    }

    pub fn canonical_step_json(&self) -> Result<String, OrchestratorError> {
        canonical_json(&self.step)
    }
}

pub fn prepare_controller_intent(
    snapshot: &VerifiedSnapshot,
    mutation_request_sha256: &str,
    evidence_sha256: &str,
    now: u64,
) -> Result<PreparedMutationIntent<ControllerMutation>, OrchestratorError> {
    prepare_intent::<ControllerMutation>(snapshot, mutation_request_sha256, evidence_sha256, now)
}

pub fn prepare_edge_intent(
    snapshot: &VerifiedSnapshot,
    mutation_request_sha256: &str,
    evidence_sha256: &str,
    now: u64,
) -> Result<PreparedMutationIntent<EdgeMutation>, OrchestratorError> {
    prepare_intent::<EdgeMutation>(snapshot, mutation_request_sha256, evidence_sha256, now)
}

fn prepare_intent<P: MutationPhase>(
    snapshot: &VerifiedSnapshot,
    mutation_request_sha256: &str,
    evidence_sha256: &str,
    now: u64,
) -> Result<PreparedMutationIntent<P>, OrchestratorError> {
    if snapshot.decision(now)? != P::DECISION {
        return Err(OrchestratorError::DecisionMismatch);
    }
    require_sha256(mutation_request_sha256, "mutation_request_sha256")?;
    require_sha256(evidence_sha256, "evidence_sha256")?;
    let mut step = MutationIntentStep {
        schema_version: 1,
        contract: STEP_CONTRACT,
        ledger_identity_sha256: snapshot.snapshot.claim.ledger_identity_sha256.clone(),
        claim_digest_sha256: snapshot.snapshot.claim.claim_digest_sha256.clone(),
        state_version: P::STATE_VERSION,
        step_code: P::STEP_CODE,
        from_status: P::FROM_STATUS,
        to_status: P::TO_STATUS,
        mutation_request_sha256: Some(mutation_request_sha256.to_owned()),
        cloudflare_request_id_sha256: None,
        deployment_set_sha256: None,
        evidence_sha256: evidence_sha256.to_owned(),
        failure_class: FailureClass::None,
        transport_outcome: TransportOutcome::NotApplicable,
        step_digest_sha256: String::new(),
    };
    step.step_digest_sha256 = mutation_step_digest(&step)?;
    let service = snapshot.service::<P>();
    Ok(PreparedMutationIntent {
        step,
        authorization_id_sha256: snapshot.authorization_id_sha256().to_owned(),
        service_name: service.service_name.clone(),
        target_version_id: service.target_version_id.clone(),
        expires_at: snapshot.snapshot.claim.expires_at,
        phase: PhantomData,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum AppendResult {
    StepAppended,
    StepReplayed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorityStepAppendResponse {
    result: AppendResult,
    request_id: String,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    status: ClaimStatus,
    state_version: u8,
    step_digest_sha256: String,
    authority_version_id: String,
}

pub struct FreshIntentPermit<P: MutationPhase> {
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    state_version: u8,
    mutation_request_sha256: String,
    service_name: String,
    target_version_id: String,
    expires_at: u64,
    phase: PhantomData<P>,
}

pub fn verify_fresh_append<P: MutationPhase>(
    attempt: AuthorityAppendAttempt<P>,
    response_json: &[u8],
    expected_authority_version_id: &str,
) -> Result<FreshIntentPermit<P>, OrchestratorError> {
    require_token(
        expected_authority_version_id,
        1,
        128,
        "authority_version_id",
    )?;
    reject_duplicate_json(response_json, MAX_APPEND_RESPONSE_BYTES)?;
    let response: AuthorityStepAppendResponse =
        serde_json::from_slice(response_json).map_err(|_| OrchestratorError::InvalidJson)?;
    if response.result != AppendResult::StepAppended {
        return Err(OrchestratorError::AppendNotFresh);
    }
    if response.request_id != attempt.request_id
        || response.authority_version_id != expected_authority_version_id
        || response.authorization_id_sha256 != attempt.intent.authorization_id_sha256
        || response.claim_digest_sha256 != attempt.intent.step.claim_digest_sha256
        || response.status != P::TO_STATUS
        || response.state_version != P::STATE_VERSION
        || response.step_digest_sha256 != attempt.intent.step.step_digest_sha256
    {
        return Err(OrchestratorError::AppendMismatch);
    }
    Ok(FreshIntentPermit {
        authorization_id_sha256: attempt.intent.authorization_id_sha256,
        claim_digest_sha256: attempt.intent.step.claim_digest_sha256,
        state_version: P::STATE_VERSION,
        mutation_request_sha256: attempt
            .intent
            .step
            .mutation_request_sha256
            .expect("prepared mutation intent always has a request digest"),
        service_name: attempt.intent.service_name,
        target_version_id: attempt.intent.target_version_id,
        expires_at: attempt.intent.expires_at,
        phase: PhantomData,
    })
}

pub struct AuthorizedMutation<P: MutationPhase> {
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    state_version: u8,
    mutation_request_sha256: String,
    service_name: String,
    target_version_id: String,
    expires_at: u64,
    phase: PhantomData<P>,
}

impl<P: MutationPhase> AuthorizedMutation<P> {
    pub fn authorization_id_sha256(&self) -> &str {
        &self.authorization_id_sha256
    }

    pub fn claim_digest_sha256(&self) -> &str {
        &self.claim_digest_sha256
    }

    pub fn state_version(&self) -> u8 {
        self.state_version
    }

    pub fn mutation_request_sha256(&self) -> &str {
        &self.mutation_request_sha256
    }

    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    pub fn target_version_id(&self) -> &str {
        &self.target_version_id
    }

    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

pub fn authorize_mutation<P: MutationPhase>(
    permit: FreshIntentPermit<P>,
    request_digest_sha256: &str,
    now: u64,
) -> Result<AuthorizedMutation<P>, OrchestratorError> {
    require_sha256(request_digest_sha256, "request_digest_sha256")?;
    if permit.mutation_request_sha256 != request_digest_sha256 {
        return Err(OrchestratorError::RequestDigestMismatch);
    }
    if now >= permit.expires_at {
        return Err(OrchestratorError::AuthorizationExpired);
    }
    Ok(AuthorizedMutation {
        authorization_id_sha256: permit.authorization_id_sha256,
        claim_digest_sha256: permit.claim_digest_sha256,
        state_version: permit.state_version,
        mutation_request_sha256: permit.mutation_request_sha256,
        service_name: permit.service_name,
        target_version_id: permit.target_version_id,
        expires_at: permit.expires_at,
        phase: PhantomData,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrchestratorError {
    InvalidJson,
    InvalidField(&'static str),
    DigestMismatch(&'static str),
    InconsistentSnapshot,
    InvalidHistory,
    ClockBeforeClaim,
    DecisionMismatch,
    AppendNotFresh,
    AppendMismatch,
    RequestDigestMismatch,
    AuthorizationExpired,
}

impl fmt::Display for OrchestratorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson => formatter.write_str("authority snapshot JSON is invalid"),
            Self::InvalidField(field) => write!(formatter, "authority field is invalid: {field}"),
            Self::DigestMismatch(field) => {
                write!(formatter, "authority digest mismatch: {field}")
            }
            Self::InconsistentSnapshot => {
                formatter.write_str("authority snapshot is not internally consistent")
            }
            Self::InvalidHistory => formatter.write_str("authority history is invalid"),
            Self::ClockBeforeClaim => formatter.write_str("runner clock predates the claim"),
            Self::DecisionMismatch => formatter.write_str("snapshot does not permit this intent"),
            Self::AppendNotFresh => {
                formatter.write_str("authority append was replayed and grants no write permit")
            }
            Self::AppendMismatch => {
                formatter.write_str("authority append response does not match the intent")
            }
            Self::RequestDigestMismatch => {
                formatter.write_str("deployment request does not match the fresh intent")
            }
            Self::AuthorizationExpired => {
                formatter.write_str("fresh mutation intent authorization has expired")
            }
        }
    }
}

impl std::error::Error for OrchestratorError {}

struct NoDuplicateJson;

impl<'de> Deserialize<'de> for NoDuplicateJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(NoDuplicateJsonVisitor)?;
        Ok(Self)
    }
}

struct NoDuplicateJsonVisitor;

impl<'de> Visitor<'de> for NoDuplicateJsonVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON without duplicate object fields")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        NoDuplicateJson::deserialize(deserializer)?;
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<NoDuplicateJson>()?.is_some() {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut fields = BTreeSet::new();
        while let Some(field) = map.next_key::<String>()? {
            if !fields.insert(field) {
                return Err(A::Error::custom("duplicate JSON field"));
            }
            map.next_value::<NoDuplicateJson>()?;
        }
        Ok(())
    }
}

fn reject_duplicate_json(bytes: &[u8], maximum_bytes: usize) -> Result<(), OrchestratorError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(OrchestratorError::InvalidJson);
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    NoDuplicateJson::deserialize(&mut deserializer).map_err(|_| OrchestratorError::InvalidJson)?;
    deserializer
        .end()
        .map_err(|_| OrchestratorError::InvalidJson)
}

fn validate_snapshot(snapshot: &AuthoritySnapshot) -> Result<(), OrchestratorError> {
    validate_claim(&snapshot.claim)?;
    validate_state_binding(&snapshot.claim, &snapshot.state)?;
    if snapshot.steps.len() + snapshot.expiry_events.len()
        != usize::from(snapshot.state.state_version)
    {
        return Err(OrchestratorError::InconsistentSnapshot);
    }
    if snapshot.expiry_events.len() > 1 {
        return Err(OrchestratorError::InvalidHistory);
    }

    let mut history = BTreeMap::new();
    for step in &snapshot.steps {
        if history
            .insert(step.state_version, HistoryEntry::Step(step))
            .is_some()
        {
            return Err(OrchestratorError::InvalidHistory);
        }
    }
    for event in &snapshot.expiry_events {
        if history
            .insert(event.state_version, HistoryEntry::Expiry(event))
            .is_some()
        {
            return Err(OrchestratorError::InvalidHistory);
        }
    }

    let mut status = ClaimStatus::Claimed;
    let mut recorded_at = snapshot.state.claimed_at;
    let mut controller_intent_digest = None;
    let mut edge_intent_digest = None;
    for state_version in 1..=snapshot.state.state_version {
        let Some(entry) = history.get(&state_version) else {
            return Err(OrchestratorError::InvalidHistory);
        };
        match entry {
            HistoryEntry::Step(step) => {
                validate_step(&snapshot.claim, step, status, recorded_at)?;
                if step.step_code == StepCode::ControllerMutationIntent {
                    controller_intent_digest = step.mutation_request_sha256.as_deref();
                }
                if step.step_code == StepCode::ControllerPostReadback
                    && step.mutation_request_sha256.as_deref() != controller_intent_digest
                {
                    return Err(OrchestratorError::InvalidHistory);
                }
                if step.step_code == StepCode::EdgeMutationIntent {
                    edge_intent_digest = step.mutation_request_sha256.as_deref();
                }
                if step.step_code == StepCode::EdgePostReadback
                    && step.mutation_request_sha256.as_deref() != edge_intent_digest
                {
                    return Err(OrchestratorError::InvalidHistory);
                }
                status = step.to_status;
                recorded_at = step.recorded_at;
            }
            HistoryEntry::Expiry(event) => {
                validate_expiry(&snapshot.claim, event, status, recorded_at)?;
                status = event.to_status;
                recorded_at = event.recorded_at;
            }
        }
    }
    if status != snapshot.state.status || recorded_at != snapshot.state.updated_at {
        return Err(OrchestratorError::InconsistentSnapshot);
    }
    let expected_terminal_at = status.is_terminal().then_some(recorded_at);
    if snapshot.state.terminal_at != expected_terminal_at {
        return Err(OrchestratorError::InconsistentSnapshot);
    }
    Ok(())
}

enum HistoryEntry<'a> {
    Step(&'a SnapshotStep),
    Expiry(&'a SnapshotExpiryEvent),
}

fn validate_claim(claim: &SnapshotClaim) -> Result<(), OrchestratorError> {
    if claim.schema_version != 1
        || claim.claim_authority != "d1-unique-claim-v1"
        || claim.claim_scope != "staging-worker-ring-transition"
        || claim.environment != "staging"
    {
        return Err(OrchestratorError::InvalidField("claim_contract"));
    }
    for (field, value) in [
        (
            "authorization_id_sha256",
            claim.authorization_id_sha256.as_str(),
        ),
        (
            "execution_nonce_sha256",
            claim.execution_nonce_sha256.as_str(),
        ),
        (
            "authorization_manifest_sha256",
            claim.authorization_manifest_sha256.as_str(),
        ),
        (
            "authorization_subject_sha256",
            claim.authorization_subject_sha256.as_str(),
        ),
        (
            "authorization_policy_sha256",
            claim.authorization_policy_sha256.as_str(),
        ),
        (
            "transition_manifest_sha256",
            claim.transition_manifest_sha256.as_str(),
        ),
        (
            "transition_subject_sha256",
            claim.transition_subject_sha256.as_str(),
        ),
        (
            "transition_policy_sha256",
            claim.transition_policy_sha256.as_str(),
        ),
        (
            "transition_plan_sha256",
            claim.transition_plan_sha256.as_str(),
        ),
        ("candidate_sha256", claim.candidate_sha256.as_str()),
        (
            "execution_plan_sha256",
            claim.execution_plan_sha256.as_str(),
        ),
        ("account_id_sha256", claim.account_id_sha256.as_str()),
        (
            "ledger_identity_sha256",
            claim.ledger_identity_sha256.as_str(),
        ),
        (
            "read_credential_id_sha256",
            claim.read_credential_id_sha256.as_str(),
        ),
        (
            "claim_credential_id_sha256",
            claim.claim_credential_id_sha256.as_str(),
        ),
        (
            "deploy_credential_id_sha256",
            claim.deploy_credential_id_sha256.as_str(),
        ),
        ("runner_build_sha256", claim.runner_build_sha256.as_str()),
        (
            "runner_trust_config_sha256",
            claim.runner_trust_config_sha256.as_str(),
        ),
        ("claim_owner_sha256", claim.claim_owner_sha256.as_str()),
        ("claim_digest_sha256", claim.claim_digest_sha256.as_str()),
    ] {
        require_sha256(value, field)?;
    }
    if claim.authorization_id_sha256 == claim.execution_nonce_sha256 || {
        let identities = [
            &claim.read_credential_id_sha256,
            &claim.claim_credential_id_sha256,
            &claim.deploy_credential_id_sha256,
        ];
        identities[0] == identities[1]
            || identities[0] == identities[2]
            || identities[1] == identities[2]
    } {
        return Err(OrchestratorError::InvalidField("claim_identity_separation"));
    }
    validate_service(&claim.controller)?;
    validate_service(&claim.edge)?;
    if claim.controller.service_name == claim.edge.service_name {
        return Err(OrchestratorError::InvalidField("service_separation"));
    }
    if claim.generated_at == 0
        || claim.expires_at <= claim.generated_at
        || claim.expires_at - claim.generated_at > 600
        || claim.expires_at > MAX_SAFE_INTEGER
    {
        return Err(OrchestratorError::InvalidField("claim_validity"));
    }
    let actual = claim_digest(claim)?;
    if actual != claim.claim_digest_sha256 {
        return Err(OrchestratorError::DigestMismatch("claim"));
    }
    Ok(())
}

fn validate_service(service: &ServiceTarget) -> Result<(), OrchestratorError> {
    require_service_name(&service.service_name)?;
    require_version_id(&service.previous_version_id)?;
    require_version_id(&service.target_version_id)?;
    require_sha256(
        &service.previous_deployment_set_sha256,
        "previous_deployment_set_sha256",
    )?;
    if service.previous_version_id == service.target_version_id {
        return Err(OrchestratorError::InvalidField("unchanged_target_version"));
    }
    Ok(())
}

fn validate_state_binding(
    claim: &SnapshotClaim,
    state: &SnapshotState,
) -> Result<(), OrchestratorError> {
    for (actual, expected) in [
        (
            state.authorization_id_sha256.as_str(),
            claim.authorization_id_sha256.as_str(),
        ),
        (
            state.claim_digest_sha256.as_str(),
            claim.claim_digest_sha256.as_str(),
        ),
        (
            state.claim_owner_sha256.as_str(),
            claim.claim_owner_sha256.as_str(),
        ),
        (
            state.ledger_identity_sha256.as_str(),
            claim.ledger_identity_sha256.as_str(),
        ),
        (
            state.claim_credential_id_sha256.as_str(),
            claim.claim_credential_id_sha256.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(OrchestratorError::InconsistentSnapshot);
        }
    }
    if state.generated_at != claim.generated_at
        || state.expires_at != claim.expires_at
        || state.claimed_at < claim.generated_at
        || state.claimed_at >= claim.expires_at
        || state.updated_at < state.claimed_at
        || state.updated_at > MAX_SAFE_INTEGER
        || state.state_version > 6
    {
        return Err(OrchestratorError::InconsistentSnapshot);
    }
    Ok(())
}

fn validate_step(
    claim: &SnapshotClaim,
    step: &SnapshotStep,
    expected_from: ClaimStatus,
    previous_recorded_at: u64,
) -> Result<(), OrchestratorError> {
    if step.from_status != expected_from
        || step.actor_execution_id_sha256 != claim.claim_owner_sha256
        || step.recorded_at < previous_recorded_at
        || step.recorded_at > MAX_SAFE_INTEGER
        || (step.recorded_at >= claim.expires_at
            && !matches!(
                step.from_status,
                ClaimStatus::ControllerInflight | ClaimStatus::EdgeInflight
            ))
    {
        return Err(OrchestratorError::InvalidHistory);
    }
    require_sha256(&step.actor_execution_id_sha256, "step_actor")?;
    require_sha256(&step.evidence_sha256, "step_evidence")?;
    require_sha256(&step.step_digest_sha256, "step_digest")?;
    for value in [
        step.mutation_request_sha256.as_deref(),
        step.cloudflare_request_id_sha256.as_deref(),
        step.deployment_set_sha256.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        require_sha256(value, "step_optional_digest")?;
    }
    if !valid_step_shape(step) {
        return Err(OrchestratorError::InvalidHistory);
    }
    let actual = snapshot_step_digest(claim, step)?;
    if actual != step.step_digest_sha256 {
        return Err(OrchestratorError::DigestMismatch("step"));
    }
    Ok(())
}

fn valid_step_shape(step: &SnapshotStep) -> bool {
    let read_only = step.mutation_request_sha256.is_none()
        && step.cloudflare_request_id_sha256.is_none()
        && step.transport_outcome == TransportOutcome::NotApplicable;
    match step.step_code {
        StepCode::T1Readback => {
            step.state_version == 1
                && step.from_status == ClaimStatus::Claimed
                && matches!(
                    step.to_status,
                    ClaimStatus::T1Verified | ClaimStatus::Aborted
                )
                && read_only
                && step.deployment_set_sha256.is_some()
                && matches!(
                    (step.to_status, step.failure_class),
                    (ClaimStatus::T1Verified, FailureClass::None)
                        | (ClaimStatus::Aborted, FailureClass::ReadbackDrift)
                )
        }
        StepCode::ControllerMutationIntent => {
            step.state_version == 2
                && step.from_status == ClaimStatus::T1Verified
                && step.to_status == ClaimStatus::ControllerInflight
                && step.mutation_request_sha256.is_some()
                && step.cloudflare_request_id_sha256.is_none()
                && step.deployment_set_sha256.is_none()
                && step.failure_class == FailureClass::None
                && step.transport_outcome == TransportOutcome::NotApplicable
        }
        StepCode::ControllerPostReadback => {
            step.state_version == 3
                && step.from_status == ClaimStatus::ControllerInflight
                && matches!(
                    step.to_status,
                    ClaimStatus::ControllerVerified | ClaimStatus::RecoveryRequired
                )
                && valid_post_readback(step)
        }
        StepCode::EdgePreReadback => {
            step.state_version == 4
                && step.from_status == ClaimStatus::ControllerVerified
                && matches!(
                    step.to_status,
                    ClaimStatus::EdgePrechecked | ClaimStatus::RecoveryRequired
                )
                && read_only
                && step.deployment_set_sha256.is_some()
                && matches!(
                    (step.to_status, step.failure_class),
                    (ClaimStatus::EdgePrechecked, FailureClass::None)
                        | (ClaimStatus::RecoveryRequired, FailureClass::ReadbackDrift)
                )
        }
        StepCode::EdgeMutationIntent => {
            step.state_version == 5
                && step.from_status == ClaimStatus::EdgePrechecked
                && step.to_status == ClaimStatus::EdgeInflight
                && step.mutation_request_sha256.is_some()
                && step.cloudflare_request_id_sha256.is_none()
                && step.deployment_set_sha256.is_none()
                && step.failure_class == FailureClass::None
                && step.transport_outcome == TransportOutcome::NotApplicable
        }
        StepCode::EdgePostReadback => {
            step.state_version == 6
                && step.from_status == ClaimStatus::EdgeInflight
                && matches!(
                    step.to_status,
                    ClaimStatus::Completed | ClaimStatus::RecoveryRequired
                )
                && valid_post_readback(step)
        }
        StepCode::Terminal => {
            read_only
                && step.deployment_set_sha256.is_none()
                && matches!(
                    (step.from_status, step.to_status, step.failure_class),
                    (
                        ClaimStatus::Claimed | ClaimStatus::T1Verified,
                        ClaimStatus::Aborted,
                        FailureClass::OperatorAbort
                    ) | (
                        ClaimStatus::EdgePrechecked,
                        ClaimStatus::RecoveryRequired,
                        FailureClass::OperatorAbort
                    )
                )
        }
    }
}

fn valid_post_readback(step: &SnapshotStep) -> bool {
    if step.mutation_request_sha256.is_none() || step.deployment_set_sha256.is_none() {
        return false;
    }
    matches!(
        (step.to_status, step.transport_outcome, step.failure_class),
        (
            ClaimStatus::ControllerVerified | ClaimStatus::Completed,
            TransportOutcome::Success | TransportOutcome::Ambiguous,
            FailureClass::None,
        ) | (
            ClaimStatus::RecoveryRequired,
            TransportOutcome::Rejected,
            FailureClass::HttpRejected
        ) | (
            ClaimStatus::RecoveryRequired,
            TransportOutcome::Success | TransportOutcome::Ambiguous,
            FailureClass::TransportResponseLost
                | FailureClass::ReadbackDrift
                | FailureClass::TargetNotStable,
        )
    )
}

fn validate_expiry(
    claim: &SnapshotClaim,
    event: &SnapshotExpiryEvent,
    expected_from: ClaimStatus,
    previous_recorded_at: u64,
) -> Result<(), OrchestratorError> {
    if event.from_status != expected_from
        || event.authority_actor_id_sha256 == claim.claim_owner_sha256
        || event.failure_class != FailureClass::AuthorizationExpired
        || event.recorded_at < previous_recorded_at
        || event.recorded_at < claim.expires_at
        || event.recorded_at > MAX_SAFE_INTEGER
        || !matches!(
            (event.from_status, event.to_status),
            (
                ClaimStatus::Claimed | ClaimStatus::T1Verified,
                ClaimStatus::Expired
            ) | (
                ClaimStatus::ControllerVerified | ClaimStatus::EdgePrechecked,
                ClaimStatus::RecoveryRequired
            )
        )
    {
        return Err(OrchestratorError::InvalidHistory);
    }
    require_sha256(&event.authority_actor_id_sha256, "expiry_actor")?;
    require_sha256(&event.evidence_sha256, "expiry_evidence")?;
    require_sha256(&event.expiry_event_digest_sha256, "expiry_digest")?;
    let actual = snapshot_expiry_digest(claim, event)?;
    if actual != event.expiry_event_digest_sha256 {
        return Err(OrchestratorError::DigestMismatch("expiry"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimDigestInput<'a> {
    schema_version: u8,
    contract: &'static str,
    claim_authority: &'a str,
    claim_scope: &'a str,
    environment: &'a str,
    authorization_id_sha256: &'a str,
    execution_nonce_sha256: &'a str,
    authorization_manifest_sha256: &'a str,
    authorization_subject_sha256: &'a str,
    authorization_policy_sha256: &'a str,
    transition_manifest_sha256: &'a str,
    transition_subject_sha256: &'a str,
    transition_policy_sha256: &'a str,
    transition_plan_sha256: &'a str,
    candidate_sha256: &'a str,
    execution_plan_sha256: &'a str,
    account_id_sha256: &'a str,
    ledger_identity_sha256: &'a str,
    read_credential_id_sha256: &'a str,
    claim_credential_id_sha256: &'a str,
    deploy_credential_id_sha256: &'a str,
    controller: &'a ServiceTarget,
    edge: &'a ServiceTarget,
    runner_build_sha256: &'a str,
    runner_trust_config_sha256: &'a str,
    claim_owner_sha256: &'a str,
    generated_at: u64,
    expires_at: u64,
}

fn claim_digest(claim: &SnapshotClaim) -> Result<String, OrchestratorError> {
    canonical_sha256(&ClaimDigestInput {
        schema_version: claim.schema_version,
        contract: CLAIM_CONTRACT,
        claim_authority: &claim.claim_authority,
        claim_scope: &claim.claim_scope,
        environment: &claim.environment,
        authorization_id_sha256: &claim.authorization_id_sha256,
        execution_nonce_sha256: &claim.execution_nonce_sha256,
        authorization_manifest_sha256: &claim.authorization_manifest_sha256,
        authorization_subject_sha256: &claim.authorization_subject_sha256,
        authorization_policy_sha256: &claim.authorization_policy_sha256,
        transition_manifest_sha256: &claim.transition_manifest_sha256,
        transition_subject_sha256: &claim.transition_subject_sha256,
        transition_policy_sha256: &claim.transition_policy_sha256,
        transition_plan_sha256: &claim.transition_plan_sha256,
        candidate_sha256: &claim.candidate_sha256,
        execution_plan_sha256: &claim.execution_plan_sha256,
        account_id_sha256: &claim.account_id_sha256,
        ledger_identity_sha256: &claim.ledger_identity_sha256,
        read_credential_id_sha256: &claim.read_credential_id_sha256,
        claim_credential_id_sha256: &claim.claim_credential_id_sha256,
        deploy_credential_id_sha256: &claim.deploy_credential_id_sha256,
        controller: &claim.controller,
        edge: &claim.edge,
        runner_build_sha256: &claim.runner_build_sha256,
        runner_trust_config_sha256: &claim.runner_trust_config_sha256,
        claim_owner_sha256: &claim.claim_owner_sha256,
        generated_at: claim.generated_at,
        expires_at: claim.expires_at,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepDigestInput<'a> {
    schema_version: u8,
    contract: &'static str,
    ledger_identity_sha256: &'a str,
    claim_digest_sha256: &'a str,
    state_version: u8,
    step_code: StepCode,
    from_status: ClaimStatus,
    to_status: ClaimStatus,
    mutation_request_sha256: Option<&'a str>,
    cloudflare_request_id_sha256: Option<&'a str>,
    deployment_set_sha256: Option<&'a str>,
    evidence_sha256: &'a str,
    failure_class: FailureClass,
    transport_outcome: TransportOutcome,
}

fn mutation_step_digest(step: &MutationIntentStep) -> Result<String, OrchestratorError> {
    canonical_sha256(&StepDigestInput {
        schema_version: step.schema_version,
        contract: step.contract,
        ledger_identity_sha256: &step.ledger_identity_sha256,
        claim_digest_sha256: &step.claim_digest_sha256,
        state_version: step.state_version,
        step_code: step.step_code,
        from_status: step.from_status,
        to_status: step.to_status,
        mutation_request_sha256: step.mutation_request_sha256.as_deref(),
        cloudflare_request_id_sha256: step.cloudflare_request_id_sha256.as_deref(),
        deployment_set_sha256: step.deployment_set_sha256.as_deref(),
        evidence_sha256: &step.evidence_sha256,
        failure_class: step.failure_class,
        transport_outcome: step.transport_outcome,
    })
}

fn snapshot_step_digest(
    claim: &SnapshotClaim,
    step: &SnapshotStep,
) -> Result<String, OrchestratorError> {
    canonical_sha256(&StepDigestInput {
        schema_version: 1,
        contract: STEP_CONTRACT,
        ledger_identity_sha256: &claim.ledger_identity_sha256,
        claim_digest_sha256: &claim.claim_digest_sha256,
        state_version: step.state_version,
        step_code: step.step_code,
        from_status: step.from_status,
        to_status: step.to_status,
        mutation_request_sha256: step.mutation_request_sha256.as_deref(),
        cloudflare_request_id_sha256: step.cloudflare_request_id_sha256.as_deref(),
        deployment_set_sha256: step.deployment_set_sha256.as_deref(),
        evidence_sha256: &step.evidence_sha256,
        failure_class: step.failure_class,
        transport_outcome: step.transport_outcome,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpiryDigestInput<'a> {
    schema_version: u8,
    contract: &'static str,
    ledger_identity_sha256: &'a str,
    claim_digest_sha256: &'a str,
    state_version: u8,
    from_status: ClaimStatus,
    to_status: ClaimStatus,
    evidence_sha256: &'a str,
    failure_class: FailureClass,
}

fn snapshot_expiry_digest(
    claim: &SnapshotClaim,
    event: &SnapshotExpiryEvent,
) -> Result<String, OrchestratorError> {
    canonical_sha256(&ExpiryDigestInput {
        schema_version: 1,
        contract: EXPIRY_CONTRACT,
        ledger_identity_sha256: &claim.ledger_identity_sha256,
        claim_digest_sha256: &claim.claim_digest_sha256,
        state_version: event.state_version,
        from_status: event.from_status,
        to_status: event.to_status,
        evidence_sha256: &event.evidence_sha256,
        failure_class: event.failure_class,
    })
}

fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, OrchestratorError> {
    let json = canonical_json(value)?;
    Ok(hex_lower(&Sha256::digest(json.as_bytes())))
}

fn canonical_json<T: Serialize>(value: &T) -> Result<String, OrchestratorError> {
    let value =
        serde_json::to_value(value).map_err(|_| OrchestratorError::InvalidField("canonical"))?;
    let mut output = String::new();
    write_canonical(&value, &mut output)?;
    Ok(output)
}

fn write_canonical(value: &Value, output: &mut String) -> Result<(), OrchestratorError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => {
            let valid = number
                .as_u64()
                .map(|value| value <= MAX_SAFE_INTEGER)
                .or_else(|| {
                    number
                        .as_i64()
                        .map(|value| value >= -(MAX_SAFE_INTEGER as i64))
                })
                .unwrap_or(false);
            if !valid || number.as_f64().is_some_and(|value| value.fract() != 0.0) {
                return Err(OrchestratorError::InvalidField("canonical_number"));
            }
            output.push_str(&number.to_string());
        }
        Value::String(value) => {
            output.push_str(
                &serde_json::to_string(value)
                    .map_err(|_| OrchestratorError::InvalidField("canonical_string"))?,
            );
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| OrchestratorError::InvalidField("canonical_key"))?,
                );
                output.push(':');
                write_canonical(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), OrchestratorError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(OrchestratorError::InvalidField(field));
    }
    Ok(())
}

fn require_service_name(value: &str) -> Result<(), OrchestratorError> {
    if value.is_empty()
        || value.len() > 63
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
    {
        return Err(OrchestratorError::InvalidField("service_name"));
    }
    Ok(())
}

fn require_version_id(value: &str) -> Result<(), OrchestratorError> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err(OrchestratorError::InvalidField("version_id"));
    }
    Ok(())
}

fn require_token(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<(), OrchestratorError> {
    if value.len() < minimum
        || value.len() > maximum
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err(OrchestratorError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_784_800_000;
    const REQUEST_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const EDGE_REQUEST_DIGEST: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const EVIDENCE_DIGEST: &str =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn validates_claimed_snapshot_and_returns_only_a_read_decision() {
        let snapshot = verified(base_snapshot());
        assert_eq!(snapshot.state_version(), 0);
        assert_eq!(snapshot.decision(NOW), Ok(RunnerDecision::ReadT1));
    }

    #[test]
    fn rejects_digest_state_and_history_drift_from_sequential_queries() {
        let mut claim_drift = base_snapshot();
        claim_drift.claim.account_id_sha256 = "f".repeat(64);
        assert_eq!(
            parse(claim_drift),
            Err(OrchestratorError::DigestMismatch("claim"))
        );

        let mut state_drift = base_snapshot();
        append_t1(&mut state_drift);
        state_drift.state.state_version = 0;
        assert_eq!(
            parse(state_drift),
            Err(OrchestratorError::InconsistentSnapshot)
        );

        let mut gap = base_snapshot();
        append_t1(&mut gap);
        append_controller_intent(&mut gap);
        gap.steps.remove(0);
        assert_eq!(parse(gap), Err(OrchestratorError::InconsistentSnapshot));
    }

    #[test]
    fn rejects_duplicate_fields_and_unbounded_snapshot_input() {
        let raw = base_snapshot();
        let mut json = serde_json::to_string(&raw).unwrap();
        let duplicate = format!(",\"state\":{}", serde_json::to_string(&raw.state).unwrap());
        json.insert_str(json.len() - 1, &duplicate);
        assert_eq!(
            VerifiedSnapshot::from_json(json.as_bytes()),
            Err(OrchestratorError::InvalidJson)
        );
        assert_eq!(
            VerifiedSnapshot::from_json(&vec![b' '; MAX_SNAPSHOT_BYTES + 1]),
            Err(OrchestratorError::InvalidJson)
        );
    }

    #[test]
    fn restored_inflight_snapshots_are_permanently_readback_only() {
        let mut raw = base_snapshot();
        append_t1(&mut raw);
        append_controller_intent(&mut raw);
        let snapshot = verified(raw);
        assert_eq!(
            snapshot.decision(NOW),
            Ok(RunnerDecision::ObserveController)
        );
        assert!(matches!(
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW),
            Err(OrchestratorError::DecisionMismatch)
        ));
    }

    #[test]
    fn only_exact_step_appended_mints_a_single_use_typed_permit() {
        let mut raw = base_snapshot();
        append_t1(&mut raw);
        let snapshot = verified(raw);
        let intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let appended = append_response(&intent, "step_appended", "request-001");
        let attempt = begin_authority_append(intent, "request-001").unwrap();
        let permit =
            verify_fresh_append(attempt, appended.as_bytes(), "authority-version-001").unwrap();
        let mutation = authorize_mutation(permit, REQUEST_DIGEST, NOW).unwrap();
        assert_eq!(mutation.service_name(), "controller-staging");
        assert_eq!(mutation.target_version_id(), "controller-version-002");
        assert_eq!(mutation.state_version(), 2);
        assert_eq!(mutation.expires_at(), NOW + 300);

        let replay_intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let replayed = append_response(&replay_intent, "step_replayed", "request-002");
        let replay_attempt = begin_authority_append(replay_intent, "request-002").unwrap();
        assert!(matches!(
            verify_fresh_append(replay_attempt, replayed.as_bytes(), "authority-version-001"),
            Err(OrchestratorError::AppendNotFresh)
        ));
    }

    #[test]
    fn append_identity_request_digest_and_expiry_drift_spend_no_write_authority() {
        let mut raw = base_snapshot();
        append_t1(&mut raw);
        let snapshot = verified(raw);
        let intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let mut response: Value =
            serde_json::from_str(&append_response(&intent, "step_appended", "request-001"))
                .unwrap();
        response["stateVersion"] = Value::from(5);
        let attempt = begin_authority_append(intent, "request-001").unwrap();
        assert!(matches!(
            verify_fresh_append(
                attempt,
                serde_json::to_string(&response).unwrap().as_bytes(),
                "authority-version-001"
            ),
            Err(OrchestratorError::AppendMismatch)
        ));

        let intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let appended = append_response(&intent, "step_appended", "request-001");
        let attempt = begin_authority_append(intent, "request-001").unwrap();
        let permit =
            verify_fresh_append(attempt, appended.as_bytes(), "authority-version-001").unwrap();
        assert!(matches!(
            authorize_mutation(permit, &"c".repeat(64), NOW),
            Err(OrchestratorError::RequestDigestMismatch)
        ));

        let intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let appended = append_response(&intent, "step_appended", "request-002");
        let attempt = begin_authority_append(intent, "request-002").unwrap();
        let permit =
            verify_fresh_append(attempt, appended.as_bytes(), "authority-version-001").unwrap();
        assert!(matches!(
            authorize_mutation(permit, REQUEST_DIGEST, NOW + 300),
            Err(OrchestratorError::AuthorizationExpired)
        ));
    }

    #[test]
    fn expiry_waits_for_the_authority_and_inflight_still_observes() {
        let claimed = verified(base_snapshot());
        assert_eq!(
            claimed.decision(NOW + 301),
            Ok(RunnerDecision::AwaitAuthorityExpiry)
        );

        let mut inflight = base_snapshot();
        append_t1(&mut inflight);
        append_controller_intent(&mut inflight);
        assert_eq!(
            verified(inflight.clone()).decision(NOW + 301),
            Ok(RunnerDecision::ObserveController)
        );

        let mut post_expiry_readback = inflight;
        append_controller_post_readback(&mut post_expiry_readback);
        let recorded_at = post_expiry_readback.claim.expires_at + 1;
        post_expiry_readback.steps[2].recorded_at = recorded_at;
        post_expiry_readback.state.updated_at = recorded_at;
        assert_eq!(
            verified(post_expiry_readback).decision(recorded_at),
            Ok(RunnerDecision::AwaitAuthorityRecovery)
        );

        let mut late_t1 = base_snapshot();
        append_t1(&mut late_t1);
        late_t1.steps[0].recorded_at = late_t1.claim.expires_at;
        late_t1.state.updated_at = late_t1.claim.expires_at;
        assert_eq!(parse(late_t1), Err(OrchestratorError::InvalidHistory));
    }

    #[test]
    fn validates_authority_expiry_actor_digest_and_terminal_time() {
        let mut raw = base_snapshot();
        append_expiry(&mut raw);
        let snapshot = verified(raw.clone());
        assert_eq!(snapshot.status(), ClaimStatus::Expired);
        assert_eq!(
            snapshot.decision(NOW + 301),
            Ok(RunnerDecision::SealReceipt)
        );

        raw.expiry_events[0].authority_actor_id_sha256 = raw.claim.claim_owner_sha256.clone();
        refresh_expiry_digest(&mut raw);
        assert_eq!(parse(raw), Err(OrchestratorError::InvalidHistory));
    }

    #[test]
    fn canonical_step_digest_matches_the_javascript_contract_vector() {
        let mut raw = base_snapshot();
        append_t1(&mut raw);
        let snapshot = verified(raw);
        assert_eq!(
            snapshot.claim_digest_sha256(),
            "84490febce426e4a525c1f08a4f9c7650e9df95c317e0bfa21fb17d6946f0b32"
        );
        let intent =
            prepare_controller_intent(&snapshot, REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        assert_eq!(
            intent.step().step_digest_sha256,
            "5d40b3d0610be0c9967a5595cc35421f273c2128cad19b590dd052690f3cc7b5"
        );
    }

    #[test]
    fn validates_full_history_and_mints_only_the_typed_edge_permit() {
        let mut raw = base_snapshot();
        append_t1(&mut raw);
        append_controller_intent(&mut raw);
        append_controller_post_readback(&mut raw);
        append_edge_pre_readback(&mut raw);

        let snapshot = verified(raw.clone());
        assert_eq!(snapshot.decision(NOW), Ok(RunnerDecision::AppendEdgeIntent));
        let intent =
            prepare_edge_intent(&snapshot, EDGE_REQUEST_DIGEST, EVIDENCE_DIGEST, NOW).unwrap();
        let appended = append_response(&intent, "step_appended", "request-edge-001");
        let attempt = begin_authority_append(intent, "request-edge-001").unwrap();
        let permit =
            verify_fresh_append(attempt, appended.as_bytes(), "authority-version-001").unwrap();
        let mutation = authorize_mutation(permit, EDGE_REQUEST_DIGEST, NOW).unwrap();
        assert_eq!(mutation.service_name(), "edge-staging");
        assert_eq!(mutation.target_version_id(), "edge-version-002");
        assert_eq!(mutation.state_version(), 5);

        append_edge_intent(&mut raw);
        assert_eq!(
            verified(raw.clone()).decision(NOW),
            Ok(RunnerDecision::ObserveEdge)
        );
        append_edge_post_readback(&mut raw);
        let completed = verified(raw);
        assert_eq!(completed.status(), ClaimStatus::Completed);
        assert_eq!(completed.decision(NOW), Ok(RunnerDecision::SealReceipt));
    }

    fn base_snapshot() -> AuthoritySnapshot {
        let mut claim = SnapshotClaim {
            schema_version: 1,
            claim_authority: "d1-unique-claim-v1".to_owned(),
            claim_scope: "staging-worker-ring-transition".to_owned(),
            environment: "staging".to_owned(),
            authorization_id_sha256: "1".repeat(64),
            execution_nonce_sha256: "2".repeat(64),
            authorization_manifest_sha256: "3".repeat(64),
            authorization_subject_sha256: "4".repeat(64),
            authorization_policy_sha256: "5".repeat(64),
            transition_manifest_sha256: "6".repeat(64),
            transition_subject_sha256: "7".repeat(64),
            transition_policy_sha256: "8".repeat(64),
            transition_plan_sha256: "9".repeat(64),
            candidate_sha256: "a".repeat(64),
            execution_plan_sha256: "b".repeat(64),
            account_id_sha256: "c".repeat(64),
            ledger_identity_sha256: "d".repeat(64),
            read_credential_id_sha256: "e".repeat(64),
            claim_credential_id_sha256: "f".repeat(64),
            deploy_credential_id_sha256: "0".repeat(64),
            controller: ServiceTarget {
                service_name: "controller-staging".to_owned(),
                previous_version_id: "controller-version-001".to_owned(),
                previous_deployment_set_sha256: "1".repeat(64),
                target_version_id: "controller-version-002".to_owned(),
            },
            edge: ServiceTarget {
                service_name: "edge-staging".to_owned(),
                previous_version_id: "edge-version-001".to_owned(),
                previous_deployment_set_sha256: "2".repeat(64),
                target_version_id: "edge-version-002".to_owned(),
            },
            runner_build_sha256: "3".repeat(64),
            runner_trust_config_sha256: "4".repeat(64),
            claim_owner_sha256: "5".repeat(64),
            claim_digest_sha256: String::new(),
            generated_at: NOW,
            expires_at: NOW + 300,
        };
        claim.claim_digest_sha256 = claim_digest(&claim).unwrap();
        AuthoritySnapshot {
            state: SnapshotState {
                authorization_id_sha256: claim.authorization_id_sha256.clone(),
                claim_digest_sha256: claim.claim_digest_sha256.clone(),
                claim_owner_sha256: claim.claim_owner_sha256.clone(),
                ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
                claim_credential_id_sha256: claim.claim_credential_id_sha256.clone(),
                status: ClaimStatus::Claimed,
                state_version: 0,
                generated_at: claim.generated_at,
                claimed_at: NOW,
                expires_at: claim.expires_at,
                updated_at: NOW,
                terminal_at: None,
            },
            claim,
            steps: Vec::new(),
            expiry_events: Vec::new(),
        }
    }

    fn append_t1(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::T1Readback,
            ClaimStatus::T1Verified,
            None,
            Some("6".repeat(64)),
            FailureClass::None,
            TransportOutcome::NotApplicable,
        );
    }

    fn append_controller_intent(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::ControllerMutationIntent,
            ClaimStatus::ControllerInflight,
            Some(REQUEST_DIGEST.to_owned()),
            None,
            FailureClass::None,
            TransportOutcome::NotApplicable,
        );
    }

    fn append_controller_post_readback(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::ControllerPostReadback,
            ClaimStatus::ControllerVerified,
            Some(REQUEST_DIGEST.to_owned()),
            Some("7".repeat(64)),
            FailureClass::None,
            TransportOutcome::Success,
        );
    }

    fn append_edge_pre_readback(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::EdgePreReadback,
            ClaimStatus::EdgePrechecked,
            None,
            Some("8".repeat(64)),
            FailureClass::None,
            TransportOutcome::NotApplicable,
        );
    }

    fn append_edge_intent(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::EdgeMutationIntent,
            ClaimStatus::EdgeInflight,
            Some(EDGE_REQUEST_DIGEST.to_owned()),
            None,
            FailureClass::None,
            TransportOutcome::NotApplicable,
        );
    }

    fn append_edge_post_readback(snapshot: &mut AuthoritySnapshot) {
        append_step(
            snapshot,
            StepCode::EdgePostReadback,
            ClaimStatus::Completed,
            Some(EDGE_REQUEST_DIGEST.to_owned()),
            Some("9".repeat(64)),
            FailureClass::None,
            TransportOutcome::Success,
        );
    }

    fn append_step(
        snapshot: &mut AuthoritySnapshot,
        step_code: StepCode,
        to_status: ClaimStatus,
        mutation_request_sha256: Option<String>,
        deployment_set_sha256: Option<String>,
        failure_class: FailureClass,
        transport_outcome: TransportOutcome,
    ) {
        let state_version = snapshot.state.state_version + 1;
        let mut step = SnapshotStep {
            state_version,
            step_code,
            from_status: snapshot.state.status,
            to_status,
            actor_execution_id_sha256: snapshot.claim.claim_owner_sha256.clone(),
            mutation_request_sha256,
            cloudflare_request_id_sha256: None,
            deployment_set_sha256,
            evidence_sha256: EVIDENCE_DIGEST.to_owned(),
            failure_class,
            transport_outcome,
            step_digest_sha256: String::new(),
            recorded_at: NOW + u64::from(state_version),
        };
        step.step_digest_sha256 = snapshot_step_digest(&snapshot.claim, &step).unwrap();
        snapshot.state.status = to_status;
        snapshot.state.state_version = state_version;
        snapshot.state.updated_at = step.recorded_at;
        snapshot.state.terminal_at = to_status.is_terminal().then_some(step.recorded_at);
        snapshot.steps.push(step);
    }

    fn append_expiry(snapshot: &mut AuthoritySnapshot) {
        let state_version = snapshot.state.state_version + 1;
        let mut event = SnapshotExpiryEvent {
            state_version,
            from_status: snapshot.state.status,
            to_status: ClaimStatus::Expired,
            authority_actor_id_sha256: "6".repeat(64),
            evidence_sha256: EVIDENCE_DIGEST.to_owned(),
            expiry_event_digest_sha256: String::new(),
            failure_class: FailureClass::AuthorizationExpired,
            recorded_at: snapshot.claim.expires_at,
        };
        event.expiry_event_digest_sha256 = snapshot_expiry_digest(&snapshot.claim, &event).unwrap();
        snapshot.state.status = event.to_status;
        snapshot.state.state_version = state_version;
        snapshot.state.updated_at = event.recorded_at;
        snapshot.state.terminal_at = Some(event.recorded_at);
        snapshot.expiry_events.push(event);
    }

    fn refresh_expiry_digest(snapshot: &mut AuthoritySnapshot) {
        snapshot.expiry_events[0].expiry_event_digest_sha256 =
            snapshot_expiry_digest(&snapshot.claim, &snapshot.expiry_events[0]).unwrap();
    }

    fn append_response<P: MutationPhase>(
        intent: &PreparedMutationIntent<P>,
        result: &str,
        request_id: &str,
    ) -> String {
        serde_json::json!({
            "result": result,
            "requestId": request_id,
            "authorizationIdSha256": intent.authorization_id_sha256,
            "claimDigestSha256": intent.step.claim_digest_sha256,
            "status": P::TO_STATUS,
            "stateVersion": P::STATE_VERSION,
            "stepDigestSha256": intent.step.step_digest_sha256,
            "authorityVersionId": "authority-version-001"
        })
        .to_string()
    }

    fn verified(snapshot: AuthoritySnapshot) -> VerifiedSnapshot {
        parse(snapshot).unwrap()
    }

    fn parse(snapshot: AuthoritySnapshot) -> Result<VerifiedSnapshot, OrchestratorError> {
        VerifiedSnapshot::from_json(&serde_json::to_vec(&snapshot).unwrap())
    }
}
