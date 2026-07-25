use crate::credentials::CredentialIdentity;
use crate::execution_activation::ExecutionActivationIdentity;
use crate::orchestrator::{
    AuthoritySnapshot, ClaimStatus, FailureClass, SnapshotExpiryEvent, SnapshotStep, StepCode,
    TransportOutcome, VerifiedSnapshot, EXPIRY_CONTRACT, STEP_CONTRACT,
};
use crate::publication::PublicationIdentity;
use crate::release::{
    canonical_json, parse_canonical_json, parse_whole_second_timestamp, read_stable_regular_file,
    sha256_hex, ReleaseVerificationError, MAX_SAFE_INTEGER,
};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
#[cfg(not(target_os = "linux"))]
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "linux"))]
use std::sync::{Mutex, MutexGuard, OnceLock};

pub const EXECUTION_RECEIPT_CONTRACT: &str =
    "cinatoken-ring-transition-runner-execution-receipt-v1";
pub const OPERATION_RECEIPT_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-receipt-v1";
pub const READ_OPERATION_REQUEST_CONTRACT: &str =
    "cinatoken-ring-transition-runner-read-operation-request-v1";
pub const READ_OPERATION_RECOVERY_WINDOW_SECONDS: u64 = 600;
const OPERATION_ID_CONTRACT: &str = "cinatoken-ring-transition-runner-operation-id-v1";
const OPERATION_CAPACITY_RESERVATION_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-capacity-reservation-v1";
pub const OPERATION_HEAD_SET_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-head-set-v1";
pub const OPERATION_HEAD_LOCAL_SEAL_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-head-local-seal-v1";
pub const TERMINAL_SNAPSHOT_CANDIDATE_CONTRACT: &str =
    "cinatoken-ring-transition-runner-terminal-snapshot-candidate-v1";
const OPERATION_CONTEXT_DIGEST_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-context-digest-v1";
const HISTORY_DIGEST_CONTRACT: &str =
    "cinatoken-ring-transition-runner-execution-receipt-history-v1";
const RECEIPTS_DIRECTORY_NAME: &str = "execution-receipts";
const OPERATION_RECEIPTS_DIRECTORY_NAME: &str = "execution-operation-receipts";
const OPERATION_CLOSURES_DIRECTORY_NAME: &str = "execution-operation-closures";
const RECEIPT_FILE_SUFFIX: &str = ".receipt.json";
const OPERATION_RECEIPT_FILE_SUFFIX: &str = ".operation.json";
const OPERATION_CAPACITY_FILE_SUFFIX: &str = ".operation-capacity.json";
const OPERATION_HEAD_SET_FILE_NAME: &str = "operation-head-set.json";
const OPERATION_HEAD_LOCAL_SEAL_FILE_NAME: &str = "operation-head-local-seal.json";
const TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME: &str = "terminal-snapshot-candidate.json";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES: usize = 320 * 1024;
const MAX_RECEIPTS_PER_CHAIN: u64 = 128;
const MAX_OPERATION_RECEIPTS_PER_CHAIN: u64 = 2;
const MAX_OPERATION_CHAINS_PER_AUTHORIZATION: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    AuthorityClaimCreate,
    AuthorityClaimRead,
    AuthorityPreflightRead,
    AuthorityStepAppend,
    CloudflareDeployment,
    CloudflareDeployTokenVerifyRead,
    CloudflareDeploymentRead,
    CloudflareTokenVerifyRead,
    CloudflareVersionRead,
}

impl OperationKind {
    fn method(self) -> &'static str {
        if self.is_read() {
            "GET"
        } else {
            "POST"
        }
    }

    fn is_read(self) -> bool {
        matches!(
            self,
            Self::AuthorityClaimRead
                | Self::AuthorityPreflightRead
                | Self::CloudflareDeployTokenVerifyRead
                | Self::CloudflareDeploymentRead
                | Self::CloudflareTokenVerifyRead
                | Self::CloudflareVersionRead
        )
    }

    fn may_start_during_recovery(self) -> bool {
        matches!(
            self,
            Self::AuthorityClaimRead
                | Self::AuthorityPreflightRead
                | Self::CloudflareDeployTokenVerifyRead
                | Self::CloudflareTokenVerifyRead
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationOutcome {
    Accepted,
    Rejected,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationIdentityInput {
    pub kind: OperationKind,
    pub state_version: u8,
    pub target_sha256: String,
    pub request_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationStartInput {
    pub identity: OperationIdentityInput,
    pub request_id_sha256: String,
    pub started_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationFinishInput {
    pub outcome: OperationOutcome,
    pub finished_at: u64,
    pub http_status: Option<u16>,
    pub response_body_sha256: Option<String>,
    pub response_id_sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OperationReservation {
    Fresh,
    ExistingUnfinished,
    ExistingFinished(OperationOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedOperationReceiptChain {
    pub operation_id_sha256: String,
    pub receipt_count: u64,
    pub head_sha256: String,
    pub outcome: Option<OperationOutcome>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OperationReceiptAudit {
    pub operation_count: usize,
    pub unfinished_count: usize,
    pub recovered_ambiguous_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationContextIdentity {
    source_commit: String,
    git_tree_sha: String,
    release_manifest_sha256: String,
    release_packet_sha256: String,
    release_policy_sha256: String,
    artifact_sha256: String,
    module_inventory_sha256: String,
    module_count: u64,
    publication_manifest_sha256: String,
    publication_packet_sha256: String,
    generation_sha256: String,
    activation_sha256: String,
    activation_sequence: u64,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    ledger_identity_sha256: String,
    claim_owner_sha256: String,
    account_id_sha256: String,
    read_credential_id_sha256: String,
    claim_credential_id_sha256: String,
    deploy_credential_id_sha256: String,
    access_client_id_sha256: String,
    authority_version_id: String,
    permit_spki_sha256: String,
    trust_config_sha256: String,
    controller_service_name: String,
    edge_service_name: String,
    generated_at: u64,
    expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationIdentity {
    operation_id_sha256: String,
    kind: OperationKind,
    state_version: u8,
    method: String,
    target_sha256: String,
    request_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
enum OperationReceiptEvent {
    #[serde(rename = "request_started")]
    RequestStarted { request_id_sha256: String },
    #[serde(rename = "request_finished")]
    RequestFinished {
        outcome: OperationOutcome,
        http_status: Option<u16>,
        response_body_sha256: Option<String>,
        response_id_sha256: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationReceipt {
    schema_version: u8,
    contract: String,
    environment: String,
    sequence: u64,
    predecessor_receipt_sha256: Option<String>,
    recorded_at: u64,
    context: OperationContextIdentity,
    operation: OperationIdentity,
    event: OperationReceiptEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CanonicalOperationReceipt {
    record: OperationReceipt,
    bytes: Vec<u8>,
    sha256: String,
}

struct VerifiedOperationReceiptChainInternal {
    verified: VerifiedOperationReceiptChain,
    context: OperationContextIdentity,
    operation: OperationIdentity,
    start_sha256: String,
    start_recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationHeadSetEntry {
    slot: u16,
    operation_id_sha256: String,
    chain_state: OperationHeadSetChainState,
    start_receipt_sha256: Option<String>,
    receipt_count: u64,
    head_sha256: Option<String>,
    outcome: Option<OperationOutcome>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OperationHeadSetChainState {
    MarkerOnly,
    Terminal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationHeadSetManifest {
    schema_version: u8,
    contract: String,
    environment: String,
    activation_sha256: String,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    operation_context_sha256: String,
    capacity_limit: u64,
    operation_count: u64,
    capacity_reservation_count: u64,
    marker_only_count: u64,
    entries: Vec<OperationHeadSetEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedOperationHeadSet {
    pub sha256: String,
    pub bytes: u64,
    pub operation_context_sha256: String,
    pub operation_count: u64,
    pub capacity_reservation_count: u64,
    pub marker_only_count: u64,
}

struct CanonicalOperationHeadSet {
    record: OperationHeadSetManifest,
    bytes: Vec<u8>,
    verified: VerifiedOperationHeadSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationHeadLocalSeal {
    schema_version: u8,
    contract: String,
    environment: String,
    activation_sha256: String,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    operation_context_sha256: String,
    execution_receipt_head_sha256: String,
    execution_receipt_count: u64,
    terminal_status: ClaimStatus,
    terminal_state_version: u8,
    operation_head_set_sha256: String,
    operation_head_set_bytes: u64,
    operation_count: u64,
    capacity_reservation_count: u64,
    marker_only_count: u64,
    terminal_snapshot_candidate_sha256: Option<String>,
    terminal_snapshot_candidate_bytes: Option<u64>,
    terminal_candidate_operation_id_sha256: Option<String>,
    terminal_candidate_start_receipt_sha256: Option<String>,
}

struct CanonicalOperationHeadLocalSeal {
    record: OperationHeadLocalSeal,
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TerminalSnapshotCandidate {
    schema_version: u8,
    contract: String,
    environment: String,
    activation_sha256: String,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    operation_context_sha256: String,
    snapshot_sha256: String,
    snapshot_bytes: u64,
    operation_id_sha256: String,
    operation_start_receipt_sha256: String,
    operation_outcome: OperationOutcome,
    operation_finished_at: u64,
    operation_http_status: u16,
    operation_response_body_sha256: String,
    operation_response_id_sha256: Option<String>,
    expected_execution_receipt_head_sha256: String,
    expected_execution_receipt_count: u64,
    snapshot: AuthoritySnapshot,
}

struct CanonicalTerminalSnapshotCandidate {
    record: TerminalSnapshotCandidate,
    bytes: Vec<u8>,
    sha256: String,
    snapshot: VerifiedSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedTerminalClosure {
    pub authorization_id_sha256: String,
    pub terminal_status: ClaimStatus,
    pub terminal_state_version: u8,
    pub execution_receipt_head_sha256: String,
    pub operation_head_set_sha256: String,
    pub local_seal_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptReleaseIdentity {
    pub source_commit: String,
    pub git_tree_sha: String,
    pub release_manifest_sha256: String,
    pub release_packet_sha256: String,
    pub release_policy_sha256: String,
    pub artifact_sha256: String,
    pub module_inventory_sha256: String,
    pub module_count: u64,
    pub publication_manifest_sha256: String,
    pub publication_packet_sha256: String,
    pub generation_sha256: String,
    pub activation_sequence: u64,
    pub previous_publication_manifest_sha256: Option<String>,
    pub published_at: String,
    pub expires_at: String,
}

impl From<&PublicationIdentity> for ReceiptReleaseIdentity {
    fn from(identity: &PublicationIdentity) -> Self {
        Self {
            source_commit: identity.release.source_commit.clone(),
            git_tree_sha: identity.release.git_tree_sha.clone(),
            release_manifest_sha256: identity.release.manifest_sha256.clone(),
            release_packet_sha256: identity.release.packet_sha256.clone(),
            release_policy_sha256: identity.release.policy_sha256.clone(),
            artifact_sha256: identity.release.artifact_sha256.clone(),
            module_inventory_sha256: identity.release.module_inventory_sha256.clone(),
            module_count: identity.release.module_count,
            publication_manifest_sha256: identity.publication_manifest_sha256.clone(),
            publication_packet_sha256: identity.publication_packet_sha256.clone(),
            generation_sha256: identity.generation_sha256.clone(),
            activation_sequence: identity.activation_sequence,
            previous_publication_manifest_sha256: identity
                .previous_publication_manifest_sha256
                .clone(),
            published_at: identity.published_at.clone(),
            expires_at: identity.expires_at.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptCredentialIdentity {
    pub account_id_sha256: String,
    pub read_credential_id_sha256: String,
    pub claim_credential_id_sha256: String,
    pub deploy_credential_id_sha256: String,
    pub access_client_id_sha256: String,
    pub authority_version_id: String,
    pub permit_spki_sha256: String,
    pub trust_config_sha256: String,
    pub runner_build_sha256: String,
    pub controller_service_name: String,
    pub edge_service_name: String,
    pub stable_readback_observation_seconds: u16,
}

impl From<&CredentialIdentity> for ReceiptCredentialIdentity {
    fn from(identity: &CredentialIdentity) -> Self {
        Self {
            account_id_sha256: identity.account_id_sha256.clone(),
            read_credential_id_sha256: identity.read_credential_id_sha256.clone(),
            claim_credential_id_sha256: identity.claim_credential_id_sha256.clone(),
            deploy_credential_id_sha256: identity.deploy_credential_id_sha256.clone(),
            access_client_id_sha256: identity.access_client_id_sha256.clone(),
            authority_version_id: identity.authority_version_id.clone(),
            permit_spki_sha256: identity.permit_spki_sha256.clone(),
            trust_config_sha256: identity.trust_config_sha256.clone(),
            runner_build_sha256: identity.runner_build_sha256.clone(),
            controller_service_name: identity.controller_service_name.clone(),
            edge_service_name: identity.edge_service_name.clone(),
            stable_readback_observation_seconds: identity.stable_readback_observation_seconds,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptClaimIdentity {
    pub authorization_id_sha256: String,
    pub claim_digest_sha256: String,
    pub ledger_identity_sha256: String,
    pub claim_owner_sha256: String,
    pub account_id_sha256: String,
    pub generated_at: u64,
    pub claimed_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptStepEvent {
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
}

impl From<&SnapshotStep> for ReceiptStepEvent {
    fn from(step: &SnapshotStep) -> Self {
        Self {
            state_version: step.state_version,
            step_code: step.step_code,
            from_status: step.from_status,
            to_status: step.to_status,
            actor_execution_id_sha256: step.actor_execution_id_sha256.clone(),
            mutation_request_sha256: step.mutation_request_sha256.clone(),
            cloudflare_request_id_sha256: step.cloudflare_request_id_sha256.clone(),
            deployment_set_sha256: step.deployment_set_sha256.clone(),
            evidence_sha256: step.evidence_sha256.clone(),
            failure_class: step.failure_class,
            transport_outcome: step.transport_outcome,
            step_digest_sha256: step.step_digest_sha256.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptExpiryEvent {
    pub state_version: u8,
    pub from_status: ClaimStatus,
    pub to_status: ClaimStatus,
    pub authority_actor_id_sha256: String,
    pub evidence_sha256: String,
    pub expiry_event_digest_sha256: String,
    pub failure_class: FailureClass,
}

impl From<&SnapshotExpiryEvent> for ReceiptExpiryEvent {
    fn from(event: &SnapshotExpiryEvent) -> Self {
        Self {
            state_version: event.state_version,
            from_status: event.from_status,
            to_status: event.to_status,
            authority_actor_id_sha256: event.authority_actor_id_sha256.clone(),
            evidence_sha256: event.evidence_sha256.clone(),
            expiry_event_digest_sha256: event.expiry_event_digest_sha256.clone(),
            failure_class: event.failure_class,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
pub enum ReceiptEvent {
    #[serde(rename = "claim_observed")]
    ClaimObserved {
        status: ClaimStatus,
        state_version: u8,
    },
    #[serde(rename = "authority_step")]
    AuthorityStep { step: ReceiptStepEvent },
    #[serde(rename = "authority_expiry")]
    AuthorityExpiry { expiry: ReceiptExpiryEvent },
    #[serde(rename = "terminal_seal")]
    TerminalSeal {
        status: ClaimStatus,
        state_version: u8,
        terminal_at: u64,
        final_snapshot_sha256: String,
        final_snapshot_bytes: u64,
        history_sha256: String,
        chain_length: u64,
    },
}

impl ReceiptEvent {
    fn is_terminal_seal(&self) -> bool {
        matches!(self, Self::TerminalSeal { .. })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExecutionReceipt {
    pub schema_version: u8,
    pub contract: String,
    pub environment: String,
    pub sequence: u64,
    pub predecessor_receipt_sha256: Option<String>,
    pub recorded_at: u64,
    pub release: ReceiptReleaseIdentity,
    pub credential_identity: ReceiptCredentialIdentity,
    pub claim: ReceiptClaimIdentity,
    pub event: ReceiptEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalReceipt {
    record: ExecutionReceipt,
    bytes: Vec<u8>,
    sha256: String,
}

impl CanonicalReceipt {
    pub fn record(&self) -> &ExecutionReceipt {
        &self.record
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptPlan {
    authorization_id_sha256: String,
    receipts: Vec<CanonicalReceipt>,
}

impl ReceiptPlan {
    pub fn authorization_id_sha256(&self) -> &str {
        &self.authorization_id_sha256
    }

    pub fn receipts(&self) -> &[CanonicalReceipt] {
        &self.receipts
    }

    pub fn head_sha256(&self) -> &str {
        self.receipts
            .last()
            .expect("a receipt plan is never empty")
            .sha256()
    }

    pub fn is_sealed(&self) -> bool {
        self.receipts
            .last()
            .is_some_and(|receipt| receipt.record.event.is_terminal_seal())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendOutcome {
    Created,
    ExistingExact,
}

#[derive(Debug, Eq, PartialEq)]
enum ExactPublicationOutcome {
    Created,
    ExistingExact,
    ExistingDifferent(Vec<u8>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledReceiptChain {
    pub authorization_id_sha256: String,
    pub chain_directory: PathBuf,
    pub receipt_count: u64,
    pub head_sha256: String,
    pub sealed: bool,
    pub created_count: u64,
    pub replayed_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedReceiptChain {
    pub authorization_id_sha256: String,
    pub receipt_count: u64,
    pub head_sha256: String,
    pub sealed: bool,
    pub terminal_status: Option<ClaimStatus>,
    pub terminal_state_version: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiptError {
    Projection(&'static str),
    InvalidJson,
    NonCanonicalJson,
    InvalidField(&'static str),
    Io(&'static str),
    UnsafeFilesystem(&'static str),
    PredecessorMissing,
    PredecessorMismatch,
    Gap,
    Conflict,
    AlreadySealed,
    NotSealed,
    DurabilityUnknown { expected_sha256: String },
}

impl fmt::Display for ReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Projection(field) => write!(formatter, "receipt projection mismatch: {field}"),
            Self::InvalidJson => formatter.write_str("receipt JSON is invalid"),
            Self::NonCanonicalJson => formatter.write_str("receipt JSON is not canonical"),
            Self::InvalidField(field) => write!(formatter, "receipt field is invalid: {field}"),
            Self::Io(stage) => write!(formatter, "receipt I/O failed: {stage}"),
            Self::UnsafeFilesystem(stage) => {
                write!(formatter, "receipt filesystem is unsafe: {stage}")
            }
            Self::PredecessorMissing => formatter.write_str("receipt predecessor is missing"),
            Self::PredecessorMismatch => formatter.write_str("receipt predecessor mismatch"),
            Self::Gap => formatter.write_str("receipt chain contains a gap"),
            Self::Conflict => formatter.write_str("receipt slot conflicts with canonical bytes"),
            Self::AlreadySealed => formatter.write_str("receipt chain is already sealed"),
            Self::NotSealed => formatter.write_str("receipt chain is not terminally sealed"),
            Self::DurabilityUnknown { expected_sha256 } => write!(
                formatter,
                "receipt publication durability is unknown for {expected_sha256}"
            ),
        }
    }
}

impl std::error::Error for ReceiptError {}

pub fn plan_terminal_receipts(
    snapshot: &VerifiedSnapshot,
    publication: &PublicationIdentity,
    credentials: &CredentialIdentity,
) -> Result<ReceiptPlan, ReceiptError> {
    let plan = plan_snapshot_receipts(snapshot, publication, credentials)?;
    if !plan.is_sealed() {
        return Err(ReceiptError::NotSealed);
    }
    validate_planned_chain(plan.receipts())?;
    Ok(plan)
}

pub fn plan_snapshot_receipts(
    snapshot: &VerifiedSnapshot,
    publication: &PublicationIdentity,
    credentials: &CredentialIdentity,
) -> Result<ReceiptPlan, ReceiptError> {
    let snapshot = snapshot.receipt_snapshot();
    validate_projection(snapshot, publication, credentials)?;

    let release = ReceiptReleaseIdentity::from(publication);
    let credential_identity = ReceiptCredentialIdentity::from(credentials);
    let claim = ReceiptClaimIdentity {
        authorization_id_sha256: snapshot.claim.authorization_id_sha256.clone(),
        claim_digest_sha256: snapshot.claim.claim_digest_sha256.clone(),
        ledger_identity_sha256: snapshot.claim.ledger_identity_sha256.clone(),
        claim_owner_sha256: snapshot.claim.claim_owner_sha256.clone(),
        account_id_sha256: snapshot.claim.account_id_sha256.clone(),
        generated_at: snapshot.claim.generated_at,
        claimed_at: snapshot.state.claimed_at,
        expires_at: snapshot.claim.expires_at,
    };

    let mut ordered_history = Vec::with_capacity(usize::from(snapshot.state.state_version));
    for step in &snapshot.steps {
        ordered_history.push(OrderedHistory::Step(step));
    }
    for expiry in &snapshot.expiry_events {
        ordered_history.push(OrderedHistory::Expiry(expiry));
    }
    ordered_history.sort_by_key(OrderedHistory::state_version);

    let mut receipts = Vec::with_capacity(ordered_history.len() + 2);
    push_receipt(
        &mut receipts,
        release.clone(),
        credential_identity.clone(),
        claim.clone(),
        snapshot.state.claimed_at,
        ReceiptEvent::ClaimObserved {
            status: ClaimStatus::Claimed,
            state_version: 0,
        },
    )?;

    let mut history_digests = Vec::with_capacity(ordered_history.len());
    for history in ordered_history {
        let (recorded_at, digest, event) = match history {
            OrderedHistory::Step(step) => (
                step.recorded_at,
                step.step_digest_sha256.clone(),
                ReceiptEvent::AuthorityStep {
                    step: ReceiptStepEvent::from(step),
                },
            ),
            OrderedHistory::Expiry(expiry) => (
                expiry.recorded_at,
                expiry.expiry_event_digest_sha256.clone(),
                ReceiptEvent::AuthorityExpiry {
                    expiry: ReceiptExpiryEvent::from(expiry),
                },
            ),
        };
        history_digests.push(digest);
        push_receipt(
            &mut receipts,
            release.clone(),
            credential_identity.clone(),
            claim.clone(),
            recorded_at,
            event,
        )?;
    }

    if snapshot.state.status.is_terminal() {
        let snapshot_bytes = canonical_json(snapshot)
            .map_err(|_| ReceiptError::Projection("final_snapshot"))?
            .into_bytes();
        let history_sha256 = sha256_hex(
            canonical_json(&HistoryDigestSubject {
                schema_version: 1,
                contract: HISTORY_DIGEST_CONTRACT,
                history_digests: &history_digests,
            })
            .map_err(|_| ReceiptError::Projection("history"))?
            .as_bytes(),
        );
        let terminal_at = snapshot
            .state
            .terminal_at
            .ok_or(ReceiptError::Projection("terminal_at"))?;
        let chain_length = u64::try_from(receipts.len() + 1)
            .map_err(|_| ReceiptError::Projection("chain_length"))?;
        push_receipt(
            &mut receipts,
            release,
            credential_identity,
            claim,
            terminal_at,
            ReceiptEvent::TerminalSeal {
                status: snapshot.state.status,
                state_version: snapshot.state.state_version,
                terminal_at,
                final_snapshot_sha256: sha256_hex(&snapshot_bytes),
                final_snapshot_bytes: snapshot_bytes
                    .len()
                    .try_into()
                    .map_err(|_| ReceiptError::Projection("final_snapshot_bytes"))?,
                history_sha256,
                chain_length,
            },
        )?;
    }

    validate_planned_prefix(&receipts)?;
    Ok(ReceiptPlan {
        authorization_id_sha256: snapshot.claim.authorization_id_sha256.clone(),
        receipts,
    })
}

pub struct ReceiptStore {
    root: PathBuf,
}

#[cfg(target_os = "linux")]
struct LockedAuthorization {
    receipts: fs::File,
    authorization: fs::File,
    receipts_path: PathBuf,
    authorization_path: PathBuf,
    authorization_name: std::ffi::CString,
    receipts_identity: LinuxFilesystemIdentity,
    authorization_identity: LinuxFilesystemIdentity,
}

#[cfg(target_os = "linux")]
impl LockedAuthorization {
    fn require_bound(&self) -> Result<(), ReceiptError> {
        require_linux_directory_path_object(
            &self.receipts_path,
            &self.receipts_identity,
            "operation_receipts_lock",
        )?;
        require_linux_directory_at_object(
            &self.receipts,
            &self.authorization_name,
            &self.authorization_identity,
            "operation_authorization_lock",
        )?;
        require_linux_directory_path_object(
            &self.authorization_path,
            &self.authorization_identity,
            "operation_authorization_lock",
        )
    }
}

#[cfg(target_os = "linux")]
impl Drop for LockedAuthorization {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        unsafe {
            libc::flock(self.authorization.as_raw_fd(), libc::LOCK_UN);
            libc::flock(self.receipts.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(not(target_os = "linux"))]
struct LockedAuthorization {
    _guard: MutexGuard<'static, ()>,
}

#[cfg(not(target_os = "linux"))]
impl LockedAuthorization {
    fn require_bound(&self) -> Result<(), ReceiptError> {
        Ok(())
    }
}

impl ReceiptStore {
    pub fn open(root: &Path) -> Result<Self, ReceiptError> {
        let metadata = fs::symlink_metadata(root)
            .map_err(|_| ReceiptError::UnsafeFilesystem("installation_root"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(ReceiptError::UnsafeFilesystem("installation_root"));
        }
        let canonical = fs::canonicalize(root)
            .map_err(|_| ReceiptError::UnsafeFilesystem("installation_root"))?;
        Ok(Self { root: canonical })
    }

    pub(crate) fn install_terminal_plan(
        &self,
        plan: &ReceiptPlan,
    ) -> Result<InstalledReceiptChain, ReceiptError> {
        if !plan.is_sealed() {
            return Err(ReceiptError::NotSealed);
        }
        self.install_plan(plan)
    }

    pub fn install_snapshot_plan(
        &self,
        plan: &ReceiptPlan,
    ) -> Result<InstalledReceiptChain, ReceiptError> {
        if plan.is_sealed() {
            return Err(ReceiptError::InvalidField("terminal_closure_required"));
        }
        self.install_plan(plan)
    }

    fn install_plan(&self, plan: &ReceiptPlan) -> Result<InstalledReceiptChain, ReceiptError> {
        validate_planned_prefix(&plan.receipts)?;
        validate_lower_hex(&plan.authorization_id_sha256, "authorization_id_sha256")?;
        let chain_directory = self.ensure_chain_directory(&plan.authorization_id_sha256)?;
        let mut created_count = 0_u64;
        let mut replayed_count = 0_u64;
        for receipt in &plan.receipts {
            match append_canonical_receipt(&chain_directory, receipt)? {
                AppendOutcome::Created => created_count += 1,
                AppendOutcome::ExistingExact => replayed_count += 1,
            }
        }
        let verified = verify_chain_directory(&chain_directory, &plan.authorization_id_sha256)?;
        if verified.sealed != plan.is_sealed()
            || verified.receipt_count
                != u64::try_from(plan.receipts.len())
                    .map_err(|_| ReceiptError::InvalidField("receipt_count"))?
            || verified.head_sha256 != plan.head_sha256()
        {
            return Err(ReceiptError::Conflict);
        }
        Ok(InstalledReceiptChain {
            authorization_id_sha256: plan.authorization_id_sha256.clone(),
            chain_directory,
            receipt_count: verified.receipt_count,
            head_sha256: verified.head_sha256,
            sealed: verified.sealed,
            created_count,
            replayed_count,
        })
    }

    pub fn verify(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<VerifiedReceiptChain, ReceiptError> {
        let verified = self.verify_prefix(authorization_id_sha256)?;
        if !verified.sealed {
            return Err(ReceiptError::NotSealed);
        }
        Ok(verified)
    }

    pub fn verify_prefix(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<VerifiedReceiptChain, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let receipts = self.root.join(RECEIPTS_DIRECTORY_NAME);
        require_fixed_directory(&receipts, &self.root, "receipts_directory")?;
        let chain = receipts.join(authorization_id_sha256);
        require_fixed_directory(&chain, &receipts, "chain_directory")?;
        verify_chain_directory(&chain, authorization_id_sha256)
    }

    pub(crate) fn install_terminal_closure(
        &self,
        plan: &ReceiptPlan,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
    ) -> Result<VerifiedTerminalClosure, ReceiptError> {
        if !plan.is_sealed() {
            return Err(ReceiptError::NotSealed);
        }
        let context = project_operation_context(publication, credentials, activation)?;
        if plan.authorization_id_sha256 != context.authorization_id_sha256 {
            return Err(ReceiptError::Projection("authorization_id_sha256"));
        }
        let authorization =
            self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if let Some(candidate) = self.read_terminal_snapshot_candidate(&context)? {
            let candidate_plan =
                plan_terminal_receipts(&candidate.snapshot, publication, credentials)?;
            if candidate_plan != *plan {
                return Err(ReceiptError::Conflict);
            }
        }
        let operations = self.authorization_operations(&context)?;
        if operations
            .iter()
            .any(|operation| operation.verified.outcome.is_none())
        {
            return Err(ReceiptError::InvalidField("unfinished_operation_chain"));
        }
        self.install_terminal_plan(plan)?;
        locked.require_bound()?;
        self.install_terminal_closure_locked(&locked, &context)
    }

    pub(crate) fn install_terminal_snapshot_candidate(
        &self,
        snapshot: &VerifiedSnapshot,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        identity: &OperationIdentityInput,
        finish: &OperationFinishInput,
    ) -> Result<(), ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operation = project_operation_identity(&context, identity)?;
        let plan = plan_terminal_receipts(snapshot, publication, credentials)?;
        if plan.authorization_id_sha256 != context.authorization_id_sha256 {
            return Err(ReceiptError::Projection("authorization_id_sha256"));
        }
        let authorization =
            self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if self.execution_chain_is_sealed(&context.authorization_id_sha256)?
            || self.terminal_artifact_exists(&context.authorization_id_sha256)?
        {
            return Err(ReceiptError::AlreadySealed);
        }
        let operation_directory = self.operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        let verified_operation = verify_operation_directory(
            &operation_directory,
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        require_operation_identity(&verified_operation, &context, &operation)?;
        if verified_operation.verified.outcome.is_some() {
            return Err(ReceiptError::Conflict);
        }
        validate_operation_finish_input(
            operation.kind,
            finish,
            verified_operation.start_recorded_at,
        )?;
        if operation.kind != OperationKind::AuthorityClaimRead
            || finish.outcome != OperationOutcome::Accepted
            || finish.http_status != Some(200)
            || finish.response_body_sha256.is_none()
        {
            return Err(ReceiptError::InvalidField("terminal_candidate_operation"));
        }
        let candidate = canonical_terminal_snapshot_candidate(
            snapshot,
            &context,
            &verified_operation,
            finish,
            &plan,
        )?;
        let closure = self.ensure_operation_closure_directory(&context.authorization_id_sha256)?;
        let path = closure.join(TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME);
        publish_canonical_bytes_with_limit(
            &closure,
            &path,
            1,
            &candidate.bytes,
            MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES,
            "terminal_snapshot_candidate",
        )?;
        let installed = read_terminal_snapshot_candidate(&path, &closure, &context)?;
        if installed.bytes != candidate.bytes || installed.record != candidate.record {
            return Err(ReceiptError::Conflict);
        }
        sync_directory(&closure, &candidate.sha256)?;
        locked.require_bound()
    }

    pub(crate) fn recover_terminal_closure(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
    ) -> Result<Option<VerifiedTerminalClosure>, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        if self.read_terminal_snapshot_candidate(&context)?.is_some() {
            let authorization =
                self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
            let locked = lock_operation_authorization(&authorization)?;
            locked.require_bound()?;
            let candidate = self
                .read_terminal_snapshot_candidate(&context)?
                .ok_or(ReceiptError::Conflict)?;
            let operations = self.authorization_operations(&context)?;
            if operations
                .iter()
                .any(|operation| operation.verified.outcome.is_none())
            {
                return Err(ReceiptError::InvalidField("unfinished_operation_chain"));
            }
            let plan = plan_terminal_receipts(&candidate.snapshot, publication, credentials)?;
            self.install_terminal_plan(&plan)?;
            locked.require_bound()?;
            return self
                .install_terminal_closure_locked(&locked, &context)
                .map(Some);
        }
        let Some(chain) = self.find_execution_chain(&context.authorization_id_sha256)? else {
            if self.terminal_artifact_exists(&context.authorization_id_sha256)? {
                return Err(ReceiptError::Conflict);
            }
            return Ok(None);
        };
        let verified = verify_chain_directory(&chain, &context.authorization_id_sha256)?;
        if !verified.sealed {
            if self.terminal_artifact_exists(&context.authorization_id_sha256)? {
                return Err(ReceiptError::Conflict);
            }
            return Ok(None);
        }
        require_execution_chain_identity(&chain, publication, credentials, &context)?;
        let authorization =
            self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        let operations = self.authorization_operations(&context)?;
        if operations
            .iter()
            .any(|operation| operation.verified.outcome.is_none())
        {
            return Err(ReceiptError::InvalidField("unfinished_operation_chain"));
        }
        locked.require_bound()?;
        self.install_terminal_closure_locked(&locked, &context)
            .map(Some)
    }

    pub(crate) fn reserve_operation(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        input: &OperationStartInput,
    ) -> Result<OperationReservation, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operation = project_operation_identity(&context, &input.identity)?;
        validate_operation_start_input(&context, input)?;
        if self.execution_chain_is_sealed(&context.authorization_id_sha256)?
            || self.terminal_admission_artifact_exists(&context)?
        {
            return Err(ReceiptError::AlreadySealed);
        }
        let authorization =
            self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if self.terminal_barrier_exists(&context, &authorization)? {
            return Err(ReceiptError::AlreadySealed);
        }
        locked.require_bound()?;
        reserve_operation_capacity(&authorization, &operation.operation_id_sha256)?;
        locked.require_bound()?;
        let directory = self.ensure_operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        locked.require_bound()?;
        self.authorization_operation_ids(&context.authorization_id_sha256)?;
        let start_path = directory.join(operation_receipt_file_name(1));
        if start_path
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_start_exists"))?
        {
            let verified = verify_operation_directory(
                &directory,
                &context.authorization_id_sha256,
                &operation.operation_id_sha256,
            )?;
            require_operation_identity(&verified, &context, &operation)?;
            self.authorization_operations(&context)?;
            locked.require_bound()?;
            return Ok(operation_reservation(&verified));
        }

        let start = canonical_operation_receipt(
            1,
            None,
            input.started_at,
            context.clone(),
            operation.clone(),
            OperationReceiptEvent::RequestStarted {
                request_id_sha256: input.request_id_sha256.clone(),
            },
        )?;
        match append_canonical_operation_receipt(&directory, &start) {
            Ok(AppendOutcome::Created) => {
                let verified = verify_operation_directory(
                    &directory,
                    &context.authorization_id_sha256,
                    &operation.operation_id_sha256,
                )?;
                require_operation_identity(&verified, &context, &operation)?;
                if verified.verified.receipt_count != 1
                    || verified.verified.head_sha256 != start.sha256
                {
                    return Err(ReceiptError::Conflict);
                }
                self.authorization_operations(&context)?;
                locked.require_bound()?;
                Ok(OperationReservation::Fresh)
            }
            Ok(AppendOutcome::ExistingExact) | Err(ReceiptError::Conflict) => {
                let verified = verify_operation_directory(
                    &directory,
                    &context.authorization_id_sha256,
                    &operation.operation_id_sha256,
                )?;
                require_operation_identity(&verified, &context, &operation)?;
                self.authorization_operations(&context)?;
                locked.require_bound()?;
                Ok(operation_reservation(&verified))
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn finish_operation(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        identity: &OperationIdentityInput,
        input: &OperationFinishInput,
    ) -> Result<OperationOutcome, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operation = project_operation_identity(&context, identity)?;
        let (_, authorization) = self
            .find_operation_authorization_directory(&context.authorization_id_sha256)?
            .ok_or(ReceiptError::PredecessorMissing)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if self.terminal_barrier_exists(&context, &authorization)? {
            return Err(ReceiptError::AlreadySealed);
        }
        self.finish_operation_locked(&locked, &context, &operation, input)
    }

    pub(crate) fn finish_operation_after_terminal_candidate(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        identity: &OperationIdentityInput,
        input: &OperationFinishInput,
    ) -> Result<OperationOutcome, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operation = project_operation_identity(&context, identity)?;
        if operation.kind != OperationKind::AuthorityClaimRead
            || input.outcome != OperationOutcome::Accepted
        {
            return Err(ReceiptError::InvalidField("terminal_candidate_operation"));
        }
        let (_, authorization) = self
            .find_operation_authorization_directory(&context.authorization_id_sha256)?
            .ok_or(ReceiptError::PredecessorMissing)?;
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if self.execution_chain_is_sealed(&context.authorization_id_sha256)?
            || self.terminal_artifact_exists(&context.authorization_id_sha256)?
        {
            return Err(ReceiptError::AlreadySealed);
        }
        let candidate = self
            .read_terminal_snapshot_candidate(&context)?
            .ok_or(ReceiptError::PredecessorMissing)?;
        if candidate.record.operation_id_sha256 != operation.operation_id_sha256
            || candidate.record.operation_outcome != input.outcome
            || candidate.record.operation_finished_at != input.finished_at
            || Some(candidate.record.operation_http_status) != input.http_status
            || Some(candidate.record.operation_response_body_sha256.as_str())
                != input.response_body_sha256.as_deref()
            || candidate.record.operation_response_id_sha256.as_deref()
                != input.response_id_sha256.as_deref()
        {
            return Err(ReceiptError::Conflict);
        }
        self.finish_operation_locked(&locked, &context, &operation, input)
    }

    fn finish_operation_locked(
        &self,
        locked: &LockedAuthorization,
        context: &OperationContextIdentity,
        operation: &OperationIdentity,
        input: &OperationFinishInput,
    ) -> Result<OperationOutcome, ReceiptError> {
        locked.require_bound()?;
        let directory = self.operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        let verified = verify_operation_directory(
            &directory,
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        require_operation_identity(&verified, context, operation)?;
        if let Some(outcome) = verified.verified.outcome {
            locked.require_bound()?;
            return Ok(outcome);
        }
        validate_operation_finish_input(operation.kind, input, verified.start_recorded_at)?;
        let finish = canonical_operation_receipt(
            2,
            Some(verified.start_sha256),
            input.finished_at,
            verified.context,
            verified.operation,
            OperationReceiptEvent::RequestFinished {
                outcome: input.outcome,
                http_status: input.http_status,
                response_body_sha256: input.response_body_sha256.clone(),
                response_id_sha256: input.response_id_sha256.clone(),
            },
        )?;
        let outcome = match append_canonical_operation_receipt(&directory, &finish) {
            Ok(_) | Err(ReceiptError::Conflict) => {
                let verified = verify_operation_directory(
                    &directory,
                    &context.authorization_id_sha256,
                    &operation.operation_id_sha256,
                )?;
                require_operation_identity(&verified, context, operation)?;
                verified.verified.outcome.ok_or(ReceiptError::Conflict)
            }
            Err(error) => Err(error),
        }?;
        locked.require_bound()?;
        Ok(outcome)
    }

    pub(crate) fn finish_unresolved_operation(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        identity: &OperationIdentityInput,
        input: &OperationFinishInput,
    ) -> Result<Option<OperationOutcome>, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operation = project_operation_identity(&context, identity)?;
        let Some(directory) = self.find_operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?
        else {
            return Ok(None);
        };
        let verified = verify_operation_directory(
            &directory,
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        require_operation_identity(&verified, &context, &operation)?;
        if let Some(outcome) = verified.verified.outcome {
            return Ok(Some(outcome));
        }
        self.finish_operation(publication, credentials, activation, identity, input)
            .map(Some)
    }

    pub(crate) fn audit_authorization_operations(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
    ) -> Result<OperationReceiptAudit, ReceiptError> {
        let context = project_operation_context(publication, credentials, activation)?;
        let operations = self.authorization_operations(&context)?;
        Ok(OperationReceiptAudit {
            operation_count: operations.len(),
            unfinished_count: operations
                .iter()
                .filter(|operation| operation.verified.outcome.is_none())
                .count(),
            recovered_ambiguous_count: 0,
        })
    }

    pub(crate) fn recover_unfinished_operations(
        &self,
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
        now: u64,
    ) -> Result<OperationReceiptAudit, ReceiptError> {
        if now > MAX_SAFE_INTEGER {
            return Err(ReceiptError::InvalidField("operation_recovery_time"));
        }
        let context = project_operation_context(publication, credentials, activation)?;
        let Some((_, authorization)) =
            self.find_operation_authorization_directory(&context.authorization_id_sha256)?
        else {
            return Ok(OperationReceiptAudit {
                operation_count: 0,
                unfinished_count: 0,
                recovered_ambiguous_count: 0,
            });
        };
        let locked = lock_operation_authorization(&authorization)?;
        locked.require_bound()?;
        if self.terminal_artifact_exists(&context.authorization_id_sha256)? {
            return Err(ReceiptError::AlreadySealed);
        }
        let candidate = self.read_terminal_snapshot_candidate(&context)?;
        let operations = self.authorization_operations(&context)?;
        let operation_count = operations.len();
        let unfinished_count = operations
            .iter()
            .filter(|operation| operation.verified.outcome.is_none())
            .count();
        let candidate_already_finished = if let Some(candidate) = &candidate {
            let operation = operations
                .iter()
                .find(|operation| {
                    operation.verified.operation_id_sha256 == candidate.record.operation_id_sha256
                })
                .ok_or(ReceiptError::Conflict)?;
            if operation.start_sha256 != candidate.record.operation_start_receipt_sha256
                || operation.operation.kind != OperationKind::AuthorityClaimRead
                || operation
                    .verified
                    .outcome
                    .is_some_and(|outcome| outcome != OperationOutcome::Accepted)
            {
                return Err(ReceiptError::Conflict);
            }
            operation.verified.outcome == Some(OperationOutcome::Accepted)
        } else {
            false
        };
        let mut recovered_ambiguous_count = 0_usize;
        let mut recovered_candidate = candidate.is_none() || candidate_already_finished;
        for operation in operations {
            if operation.verified.outcome.is_some() {
                continue;
            }
            let candidate_matches = candidate.as_ref().is_some_and(|candidate| {
                candidate.record.operation_id_sha256 == operation.verified.operation_id_sha256
            });
            let finish = if let Some(candidate) = candidate.as_ref().filter(|_| candidate_matches) {
                recovered_candidate = true;
                OperationFinishInput {
                    outcome: candidate.record.operation_outcome,
                    finished_at: candidate.record.operation_finished_at,
                    http_status: Some(candidate.record.operation_http_status),
                    response_body_sha256: Some(
                        candidate.record.operation_response_body_sha256.clone(),
                    ),
                    response_id_sha256: candidate.record.operation_response_id_sha256.clone(),
                }
            } else {
                OperationFinishInput {
                    outcome: OperationOutcome::Ambiguous,
                    finished_at: now.max(operation.start_recorded_at),
                    http_status: None,
                    response_body_sha256: None,
                    response_id_sha256: None,
                }
            };
            let outcome =
                self.finish_operation_locked(&locked, &context, &operation.operation, &finish)?;
            if outcome != finish.outcome {
                return Err(ReceiptError::Conflict);
            }
            if !candidate_matches {
                recovered_ambiguous_count += 1;
            }
        }
        if !recovered_candidate {
            return Err(ReceiptError::Conflict);
        }
        locked.require_bound()?;
        let verified = self.authorization_operations(&context)?;
        if verified.len() != operation_count
            || verified
                .iter()
                .any(|operation| operation.verified.outcome.is_none())
        {
            return Err(ReceiptError::Conflict);
        }
        locked.require_bound()?;
        Ok(OperationReceiptAudit {
            operation_count,
            unfinished_count,
            recovered_ambiguous_count,
        })
    }

    #[cfg(test)]
    pub(crate) fn verify_operation(
        &self,
        authorization_id_sha256: &str,
        operation_id_sha256: &str,
    ) -> Result<VerifiedOperationReceiptChain, ReceiptError> {
        let directory = self.operation_directory(authorization_id_sha256, operation_id_sha256)?;
        Ok(
            verify_operation_directory(&directory, authorization_id_sha256, operation_id_sha256)?
                .verified,
        )
    }

    fn authorization_operations(
        &self,
        context: &OperationContextIdentity,
    ) -> Result<Vec<VerifiedOperationReceiptChainInternal>, ReceiptError> {
        let (authorization, operation_ids, _) =
            self.authorization_operation_ids(&context.authorization_id_sha256)?;
        if operation_ids.len() > MAX_OPERATION_CHAINS_PER_AUTHORIZATION {
            return Err(ReceiptError::InvalidField("operation_chain_count"));
        }
        let mut verified = Vec::with_capacity(operation_ids.len());
        for operation_id in operation_ids {
            let operation = verify_operation_directory(
                &authorization.join(&operation_id),
                &context.authorization_id_sha256,
                &operation_id,
            )?;
            if operation.context != *context {
                return Err(ReceiptError::Conflict);
            }
            verified.push(operation);
        }
        Ok(verified)
    }

    fn authorization_operation_ids(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<(PathBuf, Vec<String>, Vec<OperationCapacityReservation>), ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let receipts = self.root.join(OPERATION_RECEIPTS_DIRECTORY_NAME);
        let authorization = receipts.join(authorization_id_sha256);
        if !receipts
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_receipts_exists"))?
        {
            return Ok((authorization, Vec::new(), Vec::new()));
        }
        require_fixed_directory(&receipts, &self.root, "operation_receipts_directory")?;
        for entry in
            fs::read_dir(&receipts).map_err(|_| ReceiptError::Io("operation_receipts_read"))?
        {
            let entry = entry.map_err(|_| ReceiptError::Io("operation_receipts_entry"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| ReceiptError::UnsafeFilesystem("operation_authorization_name"))?;
            validate_lower_hex(&name, "operation_authorization_id")?;
            require_fixed_directory(
                &entry.path(),
                &receipts,
                "operation_authorization_directory",
            )?;
        }

        if !authorization
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_authorization_exists"))?
        {
            return Ok((authorization, Vec::new(), Vec::new()));
        }
        require_fixed_directory(
            &authorization,
            &receipts,
            "operation_authorization_directory",
        )?;
        let mut operation_ids = Vec::new();
        let mut directory_operation_ids = Vec::new();
        let mut capacity_reservations = Vec::new();
        for entry in fs::read_dir(&authorization)
            .map_err(|_| ReceiptError::Io("operation_authorization_read"))?
        {
            let entry = entry.map_err(|_| ReceiptError::Io("operation_authorization_entry"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| ReceiptError::UnsafeFilesystem("operation_directory_name"))?;
            let valid_staging =
                valid_staging_file_name(&name, MAX_OPERATION_CHAINS_PER_AUTHORIZATION as u64);
            if valid_staging {
                return Err(ReceiptError::UnsafeFilesystem("operation_capacity_staging"));
            }
            if name == OPERATION_HEAD_SET_FILE_NAME {
                let metadata = read_directory_entry_metadata(&entry.path(), false)?
                    .ok_or(ReceiptError::UnsafeFilesystem("operation_head_set"))?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(ReceiptError::UnsafeFilesystem("operation_head_set"));
                }
                continue;
            }
            if let Some(slot) = parse_operation_capacity_file_name(&name) {
                let reservation =
                    read_operation_capacity_reservation(&entry.path(), &authorization)?;
                if usize::from(reservation.slot) != slot {
                    return Err(ReceiptError::InvalidField("operation_capacity_slot"));
                }
                capacity_reservations.push(reservation);
                continue;
            }
            let operation_id = name;
            validate_lower_hex(&operation_id, "operation_id_sha256")?;
            require_fixed_directory(&entry.path(), &authorization, "operation_directory")?;
            validate_operation_directory_entries(&entry.path())?;
            directory_operation_ids.push(operation_id.clone());
            let start_path = entry.path().join(operation_receipt_file_name(1));
            if !start_path
                .try_exists()
                .map_err(|_| ReceiptError::Io("operation_start_exists"))?
            {
                if has_future_operation_receipt(&entry.path(), 2)? {
                    return Err(ReceiptError::PredecessorMissing);
                }
                continue;
            }
            operation_ids.push(operation_id);
        }
        operation_ids.sort();
        directory_operation_ids.sort();
        capacity_reservations.sort_by_key(|reservation| reservation.slot);
        let mut capacity_operation_ids = capacity_reservations
            .iter()
            .map(|reservation| reservation.operation_id_sha256.as_str())
            .collect::<Vec<_>>();
        capacity_operation_ids.sort_unstable();
        if capacity_reservations.len() > MAX_OPERATION_CHAINS_PER_AUTHORIZATION
            || capacity_operation_ids
                .windows(2)
                .any(|window| window[0] == window[1])
            || directory_operation_ids.iter().any(|operation_id| {
                capacity_operation_ids
                    .binary_search(&operation_id.as_str())
                    .is_err()
            })
        {
            return Err(ReceiptError::InvalidField(
                "operation_capacity_reservations",
            ));
        }
        Ok((authorization, operation_ids, capacity_reservations))
    }

    fn install_terminal_closure_locked(
        &self,
        locked: &LockedAuthorization,
        context: &OperationContextIdentity,
    ) -> Result<VerifiedTerminalClosure, ReceiptError> {
        locked.require_bound()?;
        let execution_chain = self.verify(&context.authorization_id_sha256)?;
        require_execution_chain_identity_from_context(
            &self.execution_chain(&context.authorization_id_sha256)?,
            context,
        )?;
        let canonical_head_set = self.canonical_operation_head_set(context)?;
        let authorization =
            self.ensure_operation_authorization_directory(&context.authorization_id_sha256)?;
        let head_set_path = authorization.join(OPERATION_HEAD_SET_FILE_NAME);
        publish_canonical_bytes(
            &authorization,
            &head_set_path,
            MAX_OPERATION_CHAINS_PER_AUTHORIZATION as u64,
            &canonical_head_set.bytes,
            "operation_head_set",
        )?;
        let installed_head_set = read_operation_head_set(&head_set_path, &authorization)?;
        if installed_head_set.bytes != canonical_head_set.bytes
            || installed_head_set.record != canonical_head_set.record
        {
            return Err(ReceiptError::Conflict);
        }
        freeze_operation_directories(&authorization, &canonical_head_set.record)?;
        set_chain_read_only(&authorization)?;
        sync_directory(&authorization, &canonical_head_set.verified.sha256)?;

        let terminal_candidate = self.read_terminal_snapshot_candidate(context)?;
        let canonical_local_seal = canonical_operation_head_local_seal(
            context,
            &execution_chain,
            &canonical_head_set,
            terminal_candidate.as_ref(),
        )?;
        let closure = self.ensure_operation_closure_directory(&context.authorization_id_sha256)?;
        let local_seal_path = closure.join(OPERATION_HEAD_LOCAL_SEAL_FILE_NAME);
        publish_canonical_bytes(
            &closure,
            &local_seal_path,
            2,
            &canonical_local_seal.bytes,
            "operation_head_local_seal",
        )?;
        let installed_local_seal = read_operation_head_local_seal(&local_seal_path, &closure)?;
        if installed_local_seal.bytes != canonical_local_seal.bytes
            || installed_local_seal.record != canonical_local_seal.record
        {
            return Err(ReceiptError::Conflict);
        }
        set_chain_read_only(&closure)?;
        sync_directory(&closure, &canonical_local_seal.sha256)?;
        locked.require_bound()?;
        let verified = self.verify_terminal_closure(context)?;
        locked.require_bound()?;
        Ok(verified)
    }

    fn verify_terminal_closure(
        &self,
        context: &OperationContextIdentity,
    ) -> Result<VerifiedTerminalClosure, ReceiptError> {
        let execution_chain = self.verify(&context.authorization_id_sha256)?;
        let execution_path = self.execution_chain(&context.authorization_id_sha256)?;
        require_execution_chain_identity_from_context(&execution_path, context)?;
        let terminal_candidate = self.read_terminal_snapshot_candidate(context)?;
        if let Some(candidate) = &terminal_candidate {
            require_execution_chain_matches_terminal_candidate(
                &execution_path,
                &execution_chain,
                candidate,
            )?;
        }
        let expected_head_set = self.canonical_operation_head_set(context)?;
        let authorization = self
            .find_operation_authorization_directory(&context.authorization_id_sha256)?
            .map(|(_, path)| path)
            .ok_or(ReceiptError::PredecessorMissing)?;
        let installed_head_set = read_operation_head_set(
            &authorization.join(OPERATION_HEAD_SET_FILE_NAME),
            &authorization,
        )?;
        if installed_head_set.bytes != expected_head_set.bytes {
            return Err(ReceiptError::Conflict);
        }
        let expected_local_seal = canonical_operation_head_local_seal(
            context,
            &execution_chain,
            &expected_head_set,
            terminal_candidate.as_ref(),
        )?;
        let closure = self.operation_closure_directory(&context.authorization_id_sha256)?;
        let installed_local_seal = read_operation_head_local_seal(
            &closure.join(OPERATION_HEAD_LOCAL_SEAL_FILE_NAME),
            &closure,
        )?;
        if installed_local_seal.bytes != expected_local_seal.bytes {
            return Err(ReceiptError::Conflict);
        }
        Ok(VerifiedTerminalClosure {
            authorization_id_sha256: context.authorization_id_sha256.clone(),
            terminal_status: execution_chain
                .terminal_status
                .ok_or(ReceiptError::NotSealed)?,
            terminal_state_version: execution_chain
                .terminal_state_version
                .ok_or(ReceiptError::NotSealed)?,
            execution_receipt_head_sha256: execution_chain.head_sha256,
            operation_head_set_sha256: expected_head_set.verified.sha256,
            local_seal_sha256: expected_local_seal.sha256,
        })
    }

    fn canonical_operation_head_set(
        &self,
        context: &OperationContextIdentity,
    ) -> Result<CanonicalOperationHeadSet, ReceiptError> {
        let (_, operation_ids, capacity_reservations) =
            self.authorization_operation_ids(&context.authorization_id_sha256)?;
        let mut operations = BTreeMap::new();
        for operation_id in operation_ids {
            let operation = verify_operation_directory(
                &self.operation_directory(&context.authorization_id_sha256, &operation_id)?,
                &context.authorization_id_sha256,
                &operation_id,
            )?;
            if operation.context != *context
                || operation.verified.receipt_count != MAX_OPERATION_RECEIPTS_PER_CHAIN
                || operation.verified.outcome.is_none()
            {
                return Err(ReceiptError::InvalidField("operation_head_set_chain"));
            }
            if operations.insert(operation_id, operation).is_some() {
                return Err(ReceiptError::Conflict);
            }
        }
        canonical_operation_head_set(context, capacity_reservations, operations)
    }

    fn execution_chain_is_sealed(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<bool, ReceiptError> {
        let Some(chain) = self.find_execution_chain(authorization_id_sha256)? else {
            return Ok(false);
        };
        verify_chain_directory(&chain, authorization_id_sha256).map(|chain| chain.sealed)
    }

    fn terminal_barrier_exists(
        &self,
        context: &OperationContextIdentity,
        authorization: &Path,
    ) -> Result<bool, ReceiptError> {
        if self.execution_chain_is_sealed(&context.authorization_id_sha256)? {
            return Ok(true);
        }
        let head_set = authorization.join(OPERATION_HEAD_SET_FILE_NAME);
        if head_set
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_head_set_exists"))?
        {
            read_operation_head_set(&head_set, authorization)?;
            return Ok(true);
        }
        if self.local_seal_exists(&context.authorization_id_sha256)? {
            return Ok(true);
        }
        Ok(self.read_terminal_snapshot_candidate(context)?.is_some())
    }

    fn terminal_admission_artifact_exists(
        &self,
        context: &OperationContextIdentity,
    ) -> Result<bool, ReceiptError> {
        if self.terminal_artifact_exists(&context.authorization_id_sha256)? {
            return Ok(true);
        }
        Ok(self.read_terminal_snapshot_candidate(context)?.is_some())
    }

    fn terminal_artifact_exists(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<bool, ReceiptError> {
        if let Some((_, authorization)) =
            self.find_operation_authorization_directory(authorization_id_sha256)?
        {
            let head_set = authorization.join(OPERATION_HEAD_SET_FILE_NAME);
            if head_set
                .try_exists()
                .map_err(|_| ReceiptError::Io("operation_head_set_exists"))?
            {
                read_operation_head_set(&head_set, &authorization)?;
                return Ok(true);
            }
        }
        self.local_seal_exists(authorization_id_sha256)
    }

    fn local_seal_exists(&self, authorization_id_sha256: &str) -> Result<bool, ReceiptError> {
        let Some(closure) = self.find_operation_closure_directory(authorization_id_sha256)? else {
            return Ok(false);
        };
        let local_seal = closure.join(OPERATION_HEAD_LOCAL_SEAL_FILE_NAME);
        if !local_seal
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_head_local_seal_exists"))?
        {
            return Ok(false);
        }
        read_operation_head_local_seal(&local_seal, &closure)?;
        Ok(true)
    }

    fn read_terminal_snapshot_candidate(
        &self,
        context: &OperationContextIdentity,
    ) -> Result<Option<CanonicalTerminalSnapshotCandidate>, ReceiptError> {
        let Some(closure) =
            self.find_operation_closure_directory(&context.authorization_id_sha256)?
        else {
            return Ok(None);
        };
        let path = closure.join(TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME);
        if !path
            .try_exists()
            .map_err(|_| ReceiptError::Io("terminal_snapshot_candidate_exists"))?
        {
            return Ok(None);
        }
        read_terminal_snapshot_candidate(&path, &closure, context).map(Some)
    }

    fn find_operation_closure_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<Option<PathBuf>, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let closures = self.root.join(OPERATION_CLOSURES_DIRECTORY_NAME);
        if !closures
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_closures_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(&closures, &self.root, "operation_closures_directory")?;
        validate_operation_closures_root(&closures)?;
        let closure = closures.join(authorization_id_sha256);
        if !closure
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_closure_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(
            &closure,
            &closures,
            "operation_authorization_closure_directory",
        )?;
        validate_operation_closure_directory_entries(&closure)?;
        Ok(Some(closure))
    }

    fn find_execution_chain(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<Option<PathBuf>, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let receipts = self.root.join(RECEIPTS_DIRECTORY_NAME);
        if !receipts
            .try_exists()
            .map_err(|_| ReceiptError::Io("receipts_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(&receipts, &self.root, "receipts_directory")?;
        let chain = receipts.join(authorization_id_sha256);
        if !chain
            .try_exists()
            .map_err(|_| ReceiptError::Io("chain_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(&chain, &receipts, "chain_directory")?;
        Ok(Some(chain))
    }

    fn execution_chain(&self, authorization_id_sha256: &str) -> Result<PathBuf, ReceiptError> {
        self.find_execution_chain(authorization_id_sha256)?
            .ok_or(ReceiptError::PredecessorMissing)
    }

    fn ensure_chain_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        let receipts = self.root.join(RECEIPTS_DIRECTORY_NAME);
        let _ = create_fixed_directory(&receipts, &self.root, "receipts_directory")?;
        let chain = receipts.join(authorization_id_sha256);
        let _ = create_fixed_directory(&chain, &receipts, "chain_directory")?;
        Ok(chain)
    }

    fn ensure_operation_authorization_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let receipts = self.root.join(OPERATION_RECEIPTS_DIRECTORY_NAME);
        let _ = create_fixed_directory(&receipts, &self.root, "operation_receipts_directory")?;
        let authorization = receipts.join(authorization_id_sha256);
        let _ = create_fixed_directory(
            &authorization,
            &receipts,
            "operation_authorization_directory",
        )?;
        Ok(authorization)
    }

    fn find_operation_authorization_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<Option<(PathBuf, PathBuf)>, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let receipts = self.root.join(OPERATION_RECEIPTS_DIRECTORY_NAME);
        if !receipts
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_receipts_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(&receipts, &self.root, "operation_receipts_directory")?;
        let authorization = receipts.join(authorization_id_sha256);
        if !authorization
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_authorization_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(
            &authorization,
            &receipts,
            "operation_authorization_directory",
        )?;
        Ok(Some((receipts, authorization)))
    }

    fn ensure_operation_closure_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let closures = self.root.join(OPERATION_CLOSURES_DIRECTORY_NAME);
        let _ = create_fixed_directory(&closures, &self.root, "operation_closures_directory")?;
        validate_operation_closures_root(&closures)?;
        let closure = closures.join(authorization_id_sha256);
        let _ = create_fixed_directory(
            &closure,
            &closures,
            "operation_authorization_closure_directory",
        )?;
        validate_operation_closure_directory_entries(&closure)?;
        Ok(closure)
    }

    fn operation_closure_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        let closures = self.root.join(OPERATION_CLOSURES_DIRECTORY_NAME);
        require_fixed_directory(&closures, &self.root, "operation_closures_directory")?;
        validate_operation_closures_root(&closures)?;
        let closure = closures.join(authorization_id_sha256);
        require_fixed_directory(
            &closure,
            &closures,
            "operation_authorization_closure_directory",
        )?;
        validate_operation_closure_directory_entries(&closure)?;
        Ok(closure)
    }

    fn ensure_operation_directory(
        &self,
        authorization_id_sha256: &str,
        operation_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        validate_lower_hex(operation_id_sha256, "operation_id_sha256")?;
        let authorization =
            self.ensure_operation_authorization_directory(authorization_id_sha256)?;
        let operation = authorization.join(operation_id_sha256);
        let _ = create_fixed_directory(&operation, &authorization, "operation_directory")?;
        Ok(operation)
    }

    fn operation_directory(
        &self,
        authorization_id_sha256: &str,
        operation_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        self.find_operation_directory(authorization_id_sha256, operation_id_sha256)?
            .ok_or(ReceiptError::PredecessorMissing)
    }

    fn find_operation_directory(
        &self,
        authorization_id_sha256: &str,
        operation_id_sha256: &str,
    ) -> Result<Option<PathBuf>, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        validate_lower_hex(operation_id_sha256, "operation_id_sha256")?;
        let Some((_, authorization)) =
            self.find_operation_authorization_directory(authorization_id_sha256)?
        else {
            return Ok(None);
        };
        let operation = authorization.join(operation_id_sha256);
        if !operation
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_directory_exists"))?
        {
            return Ok(None);
        }
        require_fixed_directory(&operation, &authorization, "operation_directory")?;
        Ok(Some(operation))
    }
}

enum OrderedHistory<'a> {
    Step(&'a SnapshotStep),
    Expiry(&'a SnapshotExpiryEvent),
}

impl OrderedHistory<'_> {
    fn state_version(&self) -> u8 {
        match self {
            Self::Step(step) => step.state_version,
            Self::Expiry(expiry) => expiry.state_version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDigestSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    history_digests: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationIdSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    activation_sha256: &'a str,
    authorization_id_sha256: &'a str,
    claim_digest_sha256: &'a str,
    kind: OperationKind,
    state_version: u8,
    method: &'static str,
    target_sha256: &'a str,
    request_sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadOperationRequestSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    method: &'static str,
    target_sha256: &'a str,
    request_id_sha256: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationCapacityReservation {
    schema_version: u8,
    contract: String,
    slot: u16,
    operation_id_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationContextDigestSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    context: &'a OperationContextIdentity,
}

pub(crate) fn read_operation_request_sha256(
    target_sha256: &str,
    request_id_sha256: &str,
) -> Result<String, ReceiptError> {
    validate_lower_hex(target_sha256, "operation_target_sha256")?;
    validate_lower_hex(request_id_sha256, "operation_request_id_sha256")?;
    canonical_json(&ReadOperationRequestSubject {
        schema_version: 1,
        contract: READ_OPERATION_REQUEST_CONTRACT,
        method: "GET",
        target_sha256,
        request_id_sha256,
    })
    .map(|subject| sha256_hex(subject.as_bytes()))
    .map_err(|_| ReceiptError::InvalidField("operation_read_request"))
}

fn project_operation_context(
    publication: &PublicationIdentity,
    credentials: &CredentialIdentity,
    activation: &ExecutionActivationIdentity,
) -> Result<OperationContextIdentity, ReceiptError> {
    activation
        .validate_credential_identity(credentials)
        .map_err(|_| ReceiptError::Projection("activation_credential_identity"))?;
    for (field, left, right) in [
        (
            "publication_manifest_sha256",
            credentials.publication_manifest_sha256.as_str(),
            publication.publication_manifest_sha256.as_str(),
        ),
        (
            "runner_build_sha256",
            credentials.runner_build_sha256.as_str(),
            publication.release.artifact_sha256.as_str(),
        ),
        (
            "authority_version_id",
            credentials.authority_version_id.as_str(),
            publication.release.authority_version_id.as_str(),
        ),
        (
            "permit_spki_sha256",
            credentials.permit_spki_sha256.as_str(),
            publication.release.permit_spki_sha256.as_str(),
        ),
        (
            "trust_config_sha256",
            credentials.trust_config_sha256.as_str(),
            publication.release.trust_config_sha256.as_str(),
        ),
    ] {
        if left != right {
            return Err(ReceiptError::Projection(field));
        }
    }
    if credentials.activation_sequence != publication.activation_sequence {
        return Err(ReceiptError::Projection("activation_sequence"));
    }
    let context = OperationContextIdentity {
        source_commit: publication.release.source_commit.clone(),
        git_tree_sha: publication.release.git_tree_sha.clone(),
        release_manifest_sha256: publication.release.manifest_sha256.clone(),
        release_packet_sha256: publication.release.packet_sha256.clone(),
        release_policy_sha256: publication.release.policy_sha256.clone(),
        artifact_sha256: publication.release.artifact_sha256.clone(),
        module_inventory_sha256: publication.release.module_inventory_sha256.clone(),
        module_count: publication.release.module_count,
        publication_manifest_sha256: publication.publication_manifest_sha256.clone(),
        publication_packet_sha256: publication.publication_packet_sha256.clone(),
        generation_sha256: publication.generation_sha256.clone(),
        activation_sha256: activation.activation_sha256().to_owned(),
        activation_sequence: publication.activation_sequence,
        authorization_id_sha256: activation.authorization_id_sha256().to_owned(),
        claim_digest_sha256: activation.claim_digest_sha256().to_owned(),
        ledger_identity_sha256: activation.ledger_identity_sha256().to_owned(),
        claim_owner_sha256: activation.claim_owner_sha256().to_owned(),
        account_id_sha256: credentials.account_id_sha256.clone(),
        read_credential_id_sha256: credentials.read_credential_id_sha256.clone(),
        claim_credential_id_sha256: credentials.claim_credential_id_sha256.clone(),
        deploy_credential_id_sha256: credentials.deploy_credential_id_sha256.clone(),
        access_client_id_sha256: credentials.access_client_id_sha256.clone(),
        authority_version_id: credentials.authority_version_id.clone(),
        permit_spki_sha256: credentials.permit_spki_sha256.clone(),
        trust_config_sha256: credentials.trust_config_sha256.clone(),
        controller_service_name: credentials.controller_service_name.clone(),
        edge_service_name: credentials.edge_service_name.clone(),
        generated_at: activation.claim_generated_at(),
        expires_at: activation.claim_expires_at(),
    };
    validate_operation_context(&context)?;
    Ok(context)
}

fn operation_context_sha256(context: &OperationContextIdentity) -> Result<String, ReceiptError> {
    canonical_json(&OperationContextDigestSubject {
        schema_version: 1,
        contract: OPERATION_CONTEXT_DIGEST_CONTRACT,
        context,
    })
    .map(|subject| sha256_hex(subject.as_bytes()))
    .map_err(|_| ReceiptError::InvalidField("operation_context_sha256"))
}

fn canonical_terminal_snapshot_candidate(
    snapshot: &VerifiedSnapshot,
    context: &OperationContextIdentity,
    operation: &VerifiedOperationReceiptChainInternal,
    finish: &OperationFinishInput,
    plan: &ReceiptPlan,
) -> Result<CanonicalTerminalSnapshotCandidate, ReceiptError> {
    validate_terminal_snapshot_context(snapshot.receipt_snapshot(), context)?;
    if !snapshot.status().is_terminal() {
        return Err(ReceiptError::NotSealed);
    }
    let snapshot_bytes = canonical_json(snapshot.receipt_snapshot())
        .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate"))?
        .into_bytes();
    let record = TerminalSnapshotCandidate {
        schema_version: 1,
        contract: TERMINAL_SNAPSHOT_CANDIDATE_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        activation_sha256: context.activation_sha256.clone(),
        authorization_id_sha256: context.authorization_id_sha256.clone(),
        claim_digest_sha256: context.claim_digest_sha256.clone(),
        operation_context_sha256: operation_context_sha256(context)?,
        snapshot_sha256: sha256_hex(&snapshot_bytes),
        snapshot_bytes: u64::try_from(snapshot_bytes.len())
            .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate_bytes"))?,
        operation_id_sha256: operation.verified.operation_id_sha256.clone(),
        operation_start_receipt_sha256: operation.start_sha256.clone(),
        operation_outcome: finish.outcome,
        operation_finished_at: finish.finished_at,
        operation_http_status: finish
            .http_status
            .ok_or(ReceiptError::InvalidField("terminal_candidate_http_status"))?,
        operation_response_body_sha256: finish.response_body_sha256.clone().ok_or(
            ReceiptError::InvalidField("terminal_candidate_response_body_sha256"),
        )?,
        operation_response_id_sha256: finish.response_id_sha256.clone(),
        expected_execution_receipt_head_sha256: plan.head_sha256().to_owned(),
        expected_execution_receipt_count: u64::try_from(plan.receipts.len())
            .map_err(|_| ReceiptError::InvalidField("terminal_candidate_receipt_count"))?,
        snapshot: snapshot.receipt_snapshot().clone(),
    };
    validate_terminal_snapshot_candidate_record(&record, context)?;
    let bytes = canonical_json(&record)
        .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate"))?
        .into_bytes();
    if bytes.is_empty() || bytes.len() > MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES {
        return Err(ReceiptError::InvalidField(
            "terminal_snapshot_candidate_bytes",
        ));
    }
    Ok(CanonicalTerminalSnapshotCandidate {
        record,
        sha256: sha256_hex(&bytes),
        bytes,
        snapshot: snapshot.clone(),
    })
}

fn validate_terminal_snapshot_candidate_record(
    record: &TerminalSnapshotCandidate,
    context: &OperationContextIdentity,
) -> Result<(), ReceiptError> {
    if record.schema_version != 1
        || record.contract != TERMINAL_SNAPSHOT_CANDIDATE_CONTRACT
        || record.environment != "staging"
        || record.activation_sha256 != context.activation_sha256
        || record.authorization_id_sha256 != context.authorization_id_sha256
        || record.claim_digest_sha256 != context.claim_digest_sha256
        || record.operation_context_sha256 != operation_context_sha256(context)?
        || record.snapshot_bytes == 0
        || record.snapshot_bytes > MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES as u64
        || record.operation_outcome != OperationOutcome::Accepted
        || record.operation_http_status != 200
        || record.operation_finished_at > MAX_SAFE_INTEGER
        || !valid_terminal_receipt_shape(
            record.snapshot.state.status,
            record.snapshot.state.state_version,
            record.expected_execution_receipt_count,
        )
    {
        return Err(ReceiptError::InvalidField("terminal_snapshot_candidate"));
    }
    for value in [
        record.activation_sha256.as_str(),
        record.authorization_id_sha256.as_str(),
        record.claim_digest_sha256.as_str(),
        record.operation_context_sha256.as_str(),
        record.snapshot_sha256.as_str(),
        record.operation_id_sha256.as_str(),
        record.operation_start_receipt_sha256.as_str(),
        record.operation_response_body_sha256.as_str(),
        record.expected_execution_receipt_head_sha256.as_str(),
    ] {
        validate_lower_hex(value, "terminal_snapshot_candidate_sha256")?;
    }
    if let Some(response_id_sha256) = &record.operation_response_id_sha256 {
        validate_lower_hex(
            response_id_sha256,
            "terminal_snapshot_candidate_response_id_sha256",
        )?;
    }
    validate_terminal_snapshot_context(&record.snapshot, context)
}

fn validate_terminal_snapshot_context(
    snapshot: &AuthoritySnapshot,
    context: &OperationContextIdentity,
) -> Result<(), ReceiptError> {
    let claim = &snapshot.claim;
    let matches = claim.environment == "staging"
        && claim.authorization_id_sha256 == context.authorization_id_sha256
        && claim.claim_digest_sha256 == context.claim_digest_sha256
        && claim.ledger_identity_sha256 == context.ledger_identity_sha256
        && claim.claim_owner_sha256 == context.claim_owner_sha256
        && claim.account_id_sha256 == context.account_id_sha256
        && claim.read_credential_id_sha256 == context.read_credential_id_sha256
        && claim.claim_credential_id_sha256 == context.claim_credential_id_sha256
        && claim.deploy_credential_id_sha256 == context.deploy_credential_id_sha256
        && claim.runner_build_sha256 == context.artifact_sha256
        && claim.runner_trust_config_sha256 == context.trust_config_sha256
        && claim.controller.service_name == context.controller_service_name
        && claim.edge.service_name == context.edge_service_name
        && claim.generated_at == context.generated_at
        && claim.expires_at == context.expires_at;
    if !matches {
        return Err(ReceiptError::Projection(
            "terminal_snapshot_candidate_context",
        ));
    }
    Ok(())
}

fn canonical_operation_head_set(
    context: &OperationContextIdentity,
    mut capacity_reservations: Vec<OperationCapacityReservation>,
    mut operations: BTreeMap<String, VerifiedOperationReceiptChainInternal>,
) -> Result<CanonicalOperationHeadSet, ReceiptError> {
    capacity_reservations.sort_by_key(|reservation| reservation.slot);
    if capacity_reservations
        .windows(2)
        .any(|window| window[0].slot >= window[1].slot)
    {
        return Err(ReceiptError::InvalidField(
            "operation_capacity_reservations",
        ));
    }
    let mut entries = Vec::with_capacity(capacity_reservations.len());
    let mut operation_count = 0_u64;
    let mut marker_only_count = 0_u64;
    for reservation in capacity_reservations {
        let entry = match operations.remove(&reservation.operation_id_sha256) {
            Some(operation) => {
                let outcome = operation
                    .verified
                    .outcome
                    .ok_or(ReceiptError::InvalidField("operation_head_outcome"))?;
                if operation.verified.receipt_count != MAX_OPERATION_RECEIPTS_PER_CHAIN
                    || operation.verified.operation_id_sha256 != reservation.operation_id_sha256
                {
                    return Err(ReceiptError::Conflict);
                }
                operation_count = operation_count
                    .checked_add(1)
                    .ok_or(ReceiptError::InvalidField("operation_count"))?;
                OperationHeadSetEntry {
                    slot: reservation.slot,
                    operation_id_sha256: reservation.operation_id_sha256,
                    chain_state: OperationHeadSetChainState::Terminal,
                    start_receipt_sha256: Some(operation.start_sha256),
                    receipt_count: operation.verified.receipt_count,
                    head_sha256: Some(operation.verified.head_sha256),
                    outcome: Some(outcome),
                }
            }
            None => {
                marker_only_count = marker_only_count
                    .checked_add(1)
                    .ok_or(ReceiptError::InvalidField("marker_only_count"))?;
                OperationHeadSetEntry {
                    slot: reservation.slot,
                    operation_id_sha256: reservation.operation_id_sha256,
                    chain_state: OperationHeadSetChainState::MarkerOnly,
                    start_receipt_sha256: None,
                    receipt_count: 0,
                    head_sha256: None,
                    outcome: None,
                }
            }
        };
        entries.push(entry);
    }
    if !operations.is_empty() {
        return Err(ReceiptError::InvalidField(
            "operation_capacity_reservations",
        ));
    }
    let capacity_reservation_count = u64::try_from(entries.len())
        .map_err(|_| ReceiptError::InvalidField("capacity_reservation_count"))?;
    let record = OperationHeadSetManifest {
        schema_version: 1,
        contract: OPERATION_HEAD_SET_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        activation_sha256: context.activation_sha256.clone(),
        authorization_id_sha256: context.authorization_id_sha256.clone(),
        claim_digest_sha256: context.claim_digest_sha256.clone(),
        operation_context_sha256: operation_context_sha256(context)?,
        capacity_limit: u64::try_from(MAX_OPERATION_CHAINS_PER_AUTHORIZATION)
            .map_err(|_| ReceiptError::InvalidField("capacity_limit"))?,
        operation_count,
        capacity_reservation_count,
        marker_only_count,
        entries,
    };
    validate_operation_head_set(&record)?;
    let bytes = canonical_json(&record)
        .map_err(|_| ReceiptError::InvalidField("operation_head_set"))?
        .into_bytes();
    let verified = VerifiedOperationHeadSet {
        sha256: sha256_hex(&bytes),
        bytes: u64::try_from(bytes.len())
            .map_err(|_| ReceiptError::InvalidField("operation_head_set_bytes"))?,
        operation_context_sha256: record.operation_context_sha256.clone(),
        operation_count,
        capacity_reservation_count,
        marker_only_count,
    };
    Ok(CanonicalOperationHeadSet {
        record,
        bytes,
        verified,
    })
}

fn canonical_operation_head_local_seal(
    context: &OperationContextIdentity,
    execution_chain: &VerifiedReceiptChain,
    head_set: &CanonicalOperationHeadSet,
    terminal_candidate: Option<&CanonicalTerminalSnapshotCandidate>,
) -> Result<CanonicalOperationHeadLocalSeal, ReceiptError> {
    if !execution_chain.sealed
        || execution_chain.authorization_id_sha256 != context.authorization_id_sha256
        || head_set.record.authorization_id_sha256 != context.authorization_id_sha256
        || head_set.record.activation_sha256 != context.activation_sha256
        || head_set.record.claim_digest_sha256 != context.claim_digest_sha256
    {
        return Err(ReceiptError::Conflict);
    }
    if let Some(candidate) = terminal_candidate {
        let operation_bound = head_set.record.entries.iter().any(|entry| {
            entry.operation_id_sha256 == candidate.record.operation_id_sha256
                && entry.chain_state == OperationHeadSetChainState::Terminal
                && entry.start_receipt_sha256.as_deref()
                    == Some(candidate.record.operation_start_receipt_sha256.as_str())
                && entry.outcome == Some(OperationOutcome::Accepted)
        });
        if !operation_bound
            || execution_chain.head_sha256
                != candidate.record.expected_execution_receipt_head_sha256
            || execution_chain.receipt_count != candidate.record.expected_execution_receipt_count
        {
            return Err(ReceiptError::Conflict);
        }
    }
    let record = OperationHeadLocalSeal {
        schema_version: 1,
        contract: OPERATION_HEAD_LOCAL_SEAL_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        activation_sha256: context.activation_sha256.clone(),
        authorization_id_sha256: context.authorization_id_sha256.clone(),
        claim_digest_sha256: context.claim_digest_sha256.clone(),
        operation_context_sha256: head_set.verified.operation_context_sha256.clone(),
        execution_receipt_head_sha256: execution_chain.head_sha256.clone(),
        execution_receipt_count: execution_chain.receipt_count,
        terminal_status: execution_chain
            .terminal_status
            .ok_or(ReceiptError::NotSealed)?,
        terminal_state_version: execution_chain
            .terminal_state_version
            .ok_or(ReceiptError::NotSealed)?,
        operation_head_set_sha256: head_set.verified.sha256.clone(),
        operation_head_set_bytes: head_set.verified.bytes,
        operation_count: head_set.verified.operation_count,
        capacity_reservation_count: head_set.verified.capacity_reservation_count,
        marker_only_count: head_set.verified.marker_only_count,
        terminal_snapshot_candidate_sha256: terminal_candidate
            .map(|candidate| candidate.sha256.clone()),
        terminal_snapshot_candidate_bytes: terminal_candidate
            .map(|candidate| u64::try_from(candidate.bytes.len()))
            .transpose()
            .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate_bytes"))?,
        terminal_candidate_operation_id_sha256: terminal_candidate
            .map(|candidate| candidate.record.operation_id_sha256.clone()),
        terminal_candidate_start_receipt_sha256: terminal_candidate
            .map(|candidate| candidate.record.operation_start_receipt_sha256.clone()),
    };
    validate_operation_head_local_seal(&record)?;
    let bytes = canonical_json(&record)
        .map_err(|_| ReceiptError::InvalidField("operation_head_local_seal"))?
        .into_bytes();
    let sha256 = sha256_hex(&bytes);
    Ok(CanonicalOperationHeadLocalSeal {
        record,
        bytes,
        sha256,
    })
}

fn project_operation_identity(
    context: &OperationContextIdentity,
    input: &OperationIdentityInput,
) -> Result<OperationIdentity, ReceiptError> {
    validate_lower_hex(&input.target_sha256, "operation_target_sha256")?;
    validate_lower_hex(&input.request_sha256, "operation_request_sha256")?;
    match input.kind {
        OperationKind::AuthorityClaimCreate
        | OperationKind::AuthorityClaimRead
        | OperationKind::AuthorityPreflightRead
        | OperationKind::CloudflareDeployTokenVerifyRead
        | OperationKind::CloudflareTokenVerifyRead
            if input.state_version != 0 =>
        {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        OperationKind::AuthorityStepAppend if input.state_version == 0 => {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        OperationKind::CloudflareDeployment if !matches!(input.state_version, 2 | 5) => {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        OperationKind::CloudflareDeploymentRead | OperationKind::CloudflareVersionRead
            if !matches!(input.state_version, 1 | 3 | 4 | 6) =>
        {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        _ => {}
    }
    let method = input.kind.method();
    let operation_id_sha256 = sha256_hex(
        canonical_json(&OperationIdSubject {
            schema_version: 1,
            contract: OPERATION_ID_CONTRACT,
            activation_sha256: &context.activation_sha256,
            authorization_id_sha256: &context.authorization_id_sha256,
            claim_digest_sha256: &context.claim_digest_sha256,
            kind: input.kind,
            state_version: input.state_version,
            method,
            target_sha256: &input.target_sha256,
            request_sha256: &input.request_sha256,
        })
        .map_err(|_| ReceiptError::InvalidField("operation_id"))?
        .as_bytes(),
    );
    Ok(OperationIdentity {
        operation_id_sha256,
        kind: input.kind,
        state_version: input.state_version,
        method: method.to_owned(),
        target_sha256: input.target_sha256.clone(),
        request_sha256: input.request_sha256.clone(),
    })
}

fn validate_operation_start_input(
    context: &OperationContextIdentity,
    input: &OperationStartInput,
) -> Result<(), ReceiptError> {
    validate_lower_hex(&input.request_id_sha256, "operation_request_id_sha256")?;
    if input.identity.kind.is_read()
        && input.identity.request_sha256
            != read_operation_request_sha256(
                &input.identity.target_sha256,
                &input.request_id_sha256,
            )?
    {
        return Err(ReceiptError::InvalidField("operation_read_request_sha256"));
    }
    let recovery_start_is_valid = if input.started_at >= context.expires_at {
        context
            .expires_at
            .checked_add(READ_OPERATION_RECOVERY_WINDOW_SECONDS)
            .is_some_and(|deadline| {
                input.identity.kind.may_start_during_recovery() && input.started_at <= deadline
            })
    } else {
        true
    };
    if input.started_at < context.generated_at
        || input.started_at > MAX_SAFE_INTEGER
        || !recovery_start_is_valid
    {
        return Err(ReceiptError::InvalidField("operation_start_time"));
    }
    Ok(())
}

fn validate_operation_finish_input(
    kind: OperationKind,
    input: &OperationFinishInput,
    started_at: u64,
) -> Result<(), ReceiptError> {
    if input.finished_at < started_at || input.finished_at > MAX_SAFE_INTEGER {
        return Err(ReceiptError::InvalidField("operation_finish_time"));
    }
    if let Some(status) = input.http_status {
        if !(100..=599).contains(&status) {
            return Err(ReceiptError::InvalidField("operation_http_status"));
        }
    }
    for (field, value) in [
        (
            "operation_response_body_sha256",
            input.response_body_sha256.as_deref(),
        ),
        (
            "operation_response_id_sha256",
            input.response_id_sha256.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            validate_lower_hex(value, field)?;
        }
    }
    match input.outcome {
        OperationOutcome::Accepted => {
            if !input.http_status.is_some_and(|status| match kind {
                OperationKind::AuthorityClaimCreate | OperationKind::AuthorityStepAppend => {
                    matches!(status, 200 | 201)
                }
                OperationKind::CloudflareDeployment => (200..=299).contains(&status),
                _ => status == 200,
            }) {
                return Err(ReceiptError::InvalidField("operation_accepted_status"));
            }
        }
        OperationOutcome::Rejected => {
            if !input.http_status.is_some_and(|status| {
                (400..=499).contains(&status)
                    && !matches!(status, 408 | 425 | 429)
                    && (!matches!(
                        kind,
                        OperationKind::AuthorityClaimCreate | OperationKind::AuthorityStepAppend
                    ) || status != 409)
            }) {
                return Err(ReceiptError::InvalidField("operation_rejected_status"));
            }
        }
        OperationOutcome::Ambiguous => {}
    }
    Ok(())
}

fn canonical_operation_receipt(
    sequence: u64,
    predecessor_receipt_sha256: Option<String>,
    recorded_at: u64,
    context: OperationContextIdentity,
    operation: OperationIdentity,
    event: OperationReceiptEvent,
) -> Result<CanonicalOperationReceipt, ReceiptError> {
    let record = OperationReceipt {
        schema_version: 1,
        contract: OPERATION_RECEIPT_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        sequence,
        predecessor_receipt_sha256,
        recorded_at,
        context,
        operation,
        event,
    };
    validate_operation_record(&record)?;
    let bytes = canonical_json(&record)
        .map_err(|_| ReceiptError::InvalidField("operation_canonical_json"))?
        .into_bytes();
    if bytes.is_empty() || bytes.len() > MAX_RECEIPT_BYTES {
        return Err(ReceiptError::InvalidField("operation_receipt_bytes"));
    }
    let sha256 = sha256_hex(&bytes);
    Ok(CanonicalOperationReceipt {
        record,
        bytes,
        sha256,
    })
}

fn validate_projection(
    snapshot: &AuthoritySnapshot,
    publication: &PublicationIdentity,
    credentials: &CredentialIdentity,
) -> Result<(), ReceiptError> {
    for (field, left, right) in [
        (
            "account_id_sha256",
            snapshot.claim.account_id_sha256.as_str(),
            credentials.account_id_sha256.as_str(),
        ),
        (
            "read_credential_id_sha256",
            snapshot.claim.read_credential_id_sha256.as_str(),
            credentials.read_credential_id_sha256.as_str(),
        ),
        (
            "claim_credential_id_sha256",
            snapshot.claim.claim_credential_id_sha256.as_str(),
            credentials.claim_credential_id_sha256.as_str(),
        ),
        (
            "deploy_credential_id_sha256",
            snapshot.claim.deploy_credential_id_sha256.as_str(),
            credentials.deploy_credential_id_sha256.as_str(),
        ),
        (
            "runner_build_sha256",
            snapshot.claim.runner_build_sha256.as_str(),
            credentials.runner_build_sha256.as_str(),
        ),
        (
            "runner_trust_config_sha256",
            snapshot.claim.runner_trust_config_sha256.as_str(),
            credentials.trust_config_sha256.as_str(),
        ),
        (
            "controller_service_name",
            snapshot.claim.controller.service_name.as_str(),
            credentials.controller_service_name.as_str(),
        ),
        (
            "edge_service_name",
            snapshot.claim.edge.service_name.as_str(),
            credentials.edge_service_name.as_str(),
        ),
        (
            "publication_manifest_sha256",
            credentials.publication_manifest_sha256.as_str(),
            publication.publication_manifest_sha256.as_str(),
        ),
        (
            "artifact_sha256",
            credentials.runner_build_sha256.as_str(),
            publication.release.artifact_sha256.as_str(),
        ),
        (
            "authority_version_id",
            credentials.authority_version_id.as_str(),
            publication.release.authority_version_id.as_str(),
        ),
        (
            "permit_spki_sha256",
            credentials.permit_spki_sha256.as_str(),
            publication.release.permit_spki_sha256.as_str(),
        ),
        (
            "trust_config_sha256",
            credentials.trust_config_sha256.as_str(),
            publication.release.trust_config_sha256.as_str(),
        ),
    ] {
        if left != right {
            return Err(ReceiptError::Projection(field));
        }
    }
    if credentials.activation_sequence != publication.activation_sequence {
        return Err(ReceiptError::Projection("activation_sequence"));
    }
    Ok(())
}

fn push_receipt(
    receipts: &mut Vec<CanonicalReceipt>,
    release: ReceiptReleaseIdentity,
    credential_identity: ReceiptCredentialIdentity,
    claim: ReceiptClaimIdentity,
    recorded_at: u64,
    event: ReceiptEvent,
) -> Result<(), ReceiptError> {
    let sequence =
        u64::try_from(receipts.len() + 1).map_err(|_| ReceiptError::InvalidField("sequence"))?;
    let predecessor_receipt_sha256 = receipts.last().map(|receipt| receipt.sha256().to_owned());
    let record = ExecutionReceipt {
        schema_version: 1,
        contract: EXECUTION_RECEIPT_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        sequence,
        predecessor_receipt_sha256,
        recorded_at,
        release,
        credential_identity,
        claim,
        event,
    };
    let bytes = canonical_json(&record)
        .map_err(|_| ReceiptError::InvalidField("canonical_json"))?
        .into_bytes();
    if bytes.len() > MAX_RECEIPT_BYTES {
        return Err(ReceiptError::InvalidField("receipt_bytes"));
    }
    let sha256 = sha256_hex(&bytes);
    receipts.push(CanonicalReceipt {
        record,
        bytes,
        sha256,
    });
    Ok(())
}

fn validate_planned_chain(receipts: &[CanonicalReceipt]) -> Result<(), ReceiptError> {
    validate_planned_prefix(receipts)?;
    if !receipts
        .last()
        .is_some_and(|receipt| receipt.record.event.is_terminal_seal())
    {
        return Err(ReceiptError::NotSealed);
    }
    Ok(())
}

fn validate_planned_prefix(receipts: &[CanonicalReceipt]) -> Result<(), ReceiptError> {
    if receipts.is_empty() || receipts.len() > MAX_RECEIPTS_PER_CHAIN as usize {
        return Err(ReceiptError::InvalidField("receipt_count"));
    }
    let first = &receipts[0].record;
    if first.sequence != 1
        || first.predecessor_receipt_sha256.is_some()
        || !matches!(
            first.event,
            ReceiptEvent::ClaimObserved {
                status: ClaimStatus::Claimed,
                state_version: 0
            }
        )
    {
        return Err(ReceiptError::InvalidField("genesis"));
    }
    let mut status = ClaimStatus::Claimed;
    let mut state_version = 0_u8;
    for (index, receipt) in receipts.iter().enumerate() {
        let expected_sequence =
            u64::try_from(index + 1).map_err(|_| ReceiptError::InvalidField("sequence"))?;
        if receipt.record.sequence != expected_sequence
            || receipt.record.predecessor_receipt_sha256
                != index
                    .checked_sub(1)
                    .map(|previous| receipts[previous].sha256.clone())
        {
            return Err(ReceiptError::PredecessorMismatch);
        }
        validate_record(&receipt.record)?;
        validate_event_progress(
            &receipt.record,
            index,
            receipts.len(),
            &mut status,
            &mut state_version,
        )?;
        if index + 1 != receipts.len() && receipt.record.event.is_terminal_seal() {
            return Err(ReceiptError::AlreadySealed);
        }
    }
    if status.is_terminal()
        && !receipts
            .last()
            .is_some_and(|receipt| receipt.record.event.is_terminal_seal())
    {
        return Err(ReceiptError::NotSealed);
    }
    Ok(())
}

fn validate_record(record: &ExecutionReceipt) -> Result<(), ReceiptError> {
    if record.schema_version != 1
        || record.contract != EXECUTION_RECEIPT_CONTRACT
        || record.environment != "staging"
        || record.sequence == 0
        || record.sequence > MAX_RECEIPTS_PER_CHAIN
    {
        return Err(ReceiptError::InvalidField("contract"));
    }
    if record.sequence == 1 {
        if record.predecessor_receipt_sha256.is_some() {
            return Err(ReceiptError::InvalidField("predecessor_receipt_sha256"));
        }
    } else {
        validate_lower_hex(
            record
                .predecessor_receipt_sha256
                .as_deref()
                .ok_or(ReceiptError::InvalidField("predecessor_receipt_sha256"))?,
            "predecessor_receipt_sha256",
        )?;
    }
    for (field, value) in [
        (
            "authorization_id_sha256",
            record.claim.authorization_id_sha256.as_str(),
        ),
        (
            "claim_digest_sha256",
            record.claim.claim_digest_sha256.as_str(),
        ),
        (
            "ledger_identity_sha256",
            record.claim.ledger_identity_sha256.as_str(),
        ),
        (
            "claim_owner_sha256",
            record.claim.claim_owner_sha256.as_str(),
        ),
        ("account_id_sha256", record.claim.account_id_sha256.as_str()),
        (
            "release_manifest_sha256",
            record.release.release_manifest_sha256.as_str(),
        ),
        (
            "release_packet_sha256",
            record.release.release_packet_sha256.as_str(),
        ),
        (
            "release_policy_sha256",
            record.release.release_policy_sha256.as_str(),
        ),
        ("artifact_sha256", record.release.artifact_sha256.as_str()),
        (
            "module_inventory_sha256",
            record.release.module_inventory_sha256.as_str(),
        ),
        (
            "publication_manifest_sha256",
            record.release.publication_manifest_sha256.as_str(),
        ),
        (
            "publication_packet_sha256",
            record.release.publication_packet_sha256.as_str(),
        ),
        (
            "generation_sha256",
            record.release.generation_sha256.as_str(),
        ),
        (
            "credential_account_id_sha256",
            record.credential_identity.account_id_sha256.as_str(),
        ),
        (
            "read_credential_id_sha256",
            record
                .credential_identity
                .read_credential_id_sha256
                .as_str(),
        ),
        (
            "claim_credential_id_sha256",
            record
                .credential_identity
                .claim_credential_id_sha256
                .as_str(),
        ),
        (
            "deploy_credential_id_sha256",
            record
                .credential_identity
                .deploy_credential_id_sha256
                .as_str(),
        ),
        (
            "access_client_id_sha256",
            record.credential_identity.access_client_id_sha256.as_str(),
        ),
        (
            "permit_spki_sha256",
            record.credential_identity.permit_spki_sha256.as_str(),
        ),
        (
            "trust_config_sha256",
            record.credential_identity.trust_config_sha256.as_str(),
        ),
        (
            "runner_build_sha256",
            record.credential_identity.runner_build_sha256.as_str(),
        ),
    ] {
        validate_lower_hex(value, field)?;
    }
    if let Some(previous) = &record.release.previous_publication_manifest_sha256 {
        validate_lower_hex(previous, "previous_publication_manifest_sha256")?;
    }
    if record.claim.account_id_sha256 != record.credential_identity.account_id_sha256
        || record.release.artifact_sha256 != record.credential_identity.runner_build_sha256
        || record.release.module_count == 0
        || record.release.activation_sequence == 0
        || record
            .credential_identity
            .stable_readback_observation_seconds
            < 5
        || record
            .credential_identity
            .stable_readback_observation_seconds
            > 120
    {
        return Err(ReceiptError::InvalidField("identity_binding"));
    }
    validate_lower_hex_length(&record.release.source_commit, 40, "source_commit")?;
    validate_lower_hex_length(&record.release.git_tree_sha, 40, "git_tree_sha")?;
    validate_token(
        &record.credential_identity.authority_version_id,
        1,
        128,
        "authority_version_id",
    )?;
    validate_service_name(
        &record.credential_identity.controller_service_name,
        "controller_service_name",
    )?;
    validate_service_name(
        &record.credential_identity.edge_service_name,
        "edge_service_name",
    )?;
    let published_at = parse_whole_second_timestamp(&record.release.published_at, "published_at")
        .map_err(|_| ReceiptError::InvalidField("published_at"))?;
    let release_expires_at =
        parse_whole_second_timestamp(&record.release.expires_at, "release_expires_at")
            .map_err(|_| ReceiptError::InvalidField("release_expires_at"))?;
    if published_at >= release_expires_at
        || record.claim.generated_at > record.claim.claimed_at
        || record.claim.claimed_at > record.claim.expires_at
        || record.claim.expires_at > MAX_SAFE_INTEGER
        || record.recorded_at < record.claim.claimed_at
        || record.recorded_at > MAX_SAFE_INTEGER
    {
        return Err(ReceiptError::InvalidField("time_binding"));
    }
    match &record.event {
        ReceiptEvent::ClaimObserved {
            status,
            state_version,
        } => {
            if *status != ClaimStatus::Claimed
                || *state_version != 0
                || record.sequence != 1
                || record.recorded_at != record.claim.claimed_at
            {
                return Err(ReceiptError::InvalidField("claim_observed"));
            }
        }
        ReceiptEvent::AuthorityStep { step } => {
            if step.state_version == 0 {
                return Err(ReceiptError::InvalidField("step_state_version"));
            }
            for (field, value) in [
                (
                    "actor_execution_id_sha256",
                    Some(step.actor_execution_id_sha256.as_str()),
                ),
                (
                    "mutation_request_sha256",
                    step.mutation_request_sha256.as_deref(),
                ),
                (
                    "cloudflare_request_id_sha256",
                    step.cloudflare_request_id_sha256.as_deref(),
                ),
                (
                    "deployment_set_sha256",
                    step.deployment_set_sha256.as_deref(),
                ),
                ("evidence_sha256", Some(step.evidence_sha256.as_str())),
                ("step_digest_sha256", Some(step.step_digest_sha256.as_str())),
            ] {
                if let Some(value) = value {
                    validate_lower_hex(value, field)?;
                }
            }
            if step.actor_execution_id_sha256 != record.claim.claim_owner_sha256
                || (record.recorded_at >= record.claim.expires_at
                    && !matches!(
                        step.from_status,
                        ClaimStatus::ControllerInflight | ClaimStatus::EdgeInflight
                    ))
                || !valid_step_shape(step)
                || receipt_step_digest(&record.claim, step)? != step.step_digest_sha256
            {
                return Err(ReceiptError::InvalidField("authority_step"));
            }
        }
        ReceiptEvent::AuthorityExpiry { expiry } => {
            if expiry.state_version == 0
                || expiry.failure_class != FailureClass::AuthorizationExpired
                || expiry.authority_actor_id_sha256 == record.claim.claim_owner_sha256
                || record.recorded_at < record.claim.expires_at
                || !matches!(
                    (expiry.from_status, expiry.to_status),
                    (
                        ClaimStatus::Claimed | ClaimStatus::T1Verified,
                        ClaimStatus::Expired
                    ) | (
                        ClaimStatus::ControllerVerified | ClaimStatus::EdgePrechecked,
                        ClaimStatus::RecoveryRequired
                    )
                )
            {
                return Err(ReceiptError::InvalidField("authority_expiry"));
            }
            for (field, value) in [
                (
                    "authority_actor_id_sha256",
                    expiry.authority_actor_id_sha256.as_str(),
                ),
                ("evidence_sha256", expiry.evidence_sha256.as_str()),
                (
                    "expiry_event_digest_sha256",
                    expiry.expiry_event_digest_sha256.as_str(),
                ),
            ] {
                validate_lower_hex(value, field)?;
            }
            if receipt_expiry_digest(&record.claim, expiry)? != expiry.expiry_event_digest_sha256 {
                return Err(ReceiptError::InvalidField("authority_expiry_digest"));
            }
        }
        ReceiptEvent::TerminalSeal {
            status,
            state_version: _,
            terminal_at,
            final_snapshot_sha256,
            final_snapshot_bytes,
            history_sha256,
            chain_length,
        } => {
            if !status.is_terminal()
                || *terminal_at != record.recorded_at
                || *final_snapshot_bytes == 0
                || *final_snapshot_bytes > 256 * 1024
                || *chain_length != record.sequence
            {
                return Err(ReceiptError::InvalidField("terminal_seal"));
            }
            validate_lower_hex(final_snapshot_sha256, "final_snapshot_sha256")?;
            validate_lower_hex(history_sha256, "history_sha256")?;
        }
    }
    Ok(())
}

fn validate_operation_context(context: &OperationContextIdentity) -> Result<(), ReceiptError> {
    for (field, value) in [
        (
            "release_manifest_sha256",
            context.release_manifest_sha256.as_str(),
        ),
        (
            "release_packet_sha256",
            context.release_packet_sha256.as_str(),
        ),
        (
            "release_policy_sha256",
            context.release_policy_sha256.as_str(),
        ),
        ("artifact_sha256", context.artifact_sha256.as_str()),
        (
            "module_inventory_sha256",
            context.module_inventory_sha256.as_str(),
        ),
        (
            "publication_manifest_sha256",
            context.publication_manifest_sha256.as_str(),
        ),
        (
            "publication_packet_sha256",
            context.publication_packet_sha256.as_str(),
        ),
        ("generation_sha256", context.generation_sha256.as_str()),
        ("activation_sha256", context.activation_sha256.as_str()),
        (
            "authorization_id_sha256",
            context.authorization_id_sha256.as_str(),
        ),
        ("claim_digest_sha256", context.claim_digest_sha256.as_str()),
        (
            "ledger_identity_sha256",
            context.ledger_identity_sha256.as_str(),
        ),
        ("claim_owner_sha256", context.claim_owner_sha256.as_str()),
        ("account_id_sha256", context.account_id_sha256.as_str()),
        (
            "read_credential_id_sha256",
            context.read_credential_id_sha256.as_str(),
        ),
        (
            "claim_credential_id_sha256",
            context.claim_credential_id_sha256.as_str(),
        ),
        (
            "deploy_credential_id_sha256",
            context.deploy_credential_id_sha256.as_str(),
        ),
        (
            "access_client_id_sha256",
            context.access_client_id_sha256.as_str(),
        ),
        ("permit_spki_sha256", context.permit_spki_sha256.as_str()),
        ("trust_config_sha256", context.trust_config_sha256.as_str()),
    ] {
        validate_lower_hex(value, field)?;
    }
    validate_lower_hex_length(&context.source_commit, 40, "source_commit")?;
    validate_lower_hex_length(&context.git_tree_sha, 40, "git_tree_sha")?;
    validate_token(
        &context.authority_version_id,
        1,
        128,
        "authority_version_id",
    )?;
    validate_service_name(&context.controller_service_name, "controller_service_name")?;
    validate_service_name(&context.edge_service_name, "edge_service_name")?;
    if context.module_count == 0
        || context.activation_sequence == 0
        || context.generated_at >= context.expires_at
        || context.expires_at > MAX_SAFE_INTEGER
    {
        return Err(ReceiptError::InvalidField("operation_context"));
    }
    Ok(())
}

fn validate_operation_record(record: &OperationReceipt) -> Result<(), ReceiptError> {
    if record.schema_version != 1
        || record.contract != OPERATION_RECEIPT_CONTRACT
        || record.environment != "staging"
        || record.sequence == 0
        || record.sequence > MAX_OPERATION_RECEIPTS_PER_CHAIN
        || record.recorded_at > MAX_SAFE_INTEGER
    {
        return Err(ReceiptError::InvalidField("operation_contract"));
    }
    match record.sequence {
        1 if record.predecessor_receipt_sha256.is_some() => {
            return Err(ReceiptError::InvalidField(
                "operation_predecessor_receipt_sha256",
            ));
        }
        2 => validate_lower_hex(
            record
                .predecessor_receipt_sha256
                .as_deref()
                .ok_or(ReceiptError::InvalidField(
                    "operation_predecessor_receipt_sha256",
                ))?,
            "operation_predecessor_receipt_sha256",
        )?,
        _ => {}
    }
    validate_operation_context(&record.context)?;
    validate_lower_hex(&record.operation.operation_id_sha256, "operation_id_sha256")?;
    let projected = project_operation_identity(
        &record.context,
        &OperationIdentityInput {
            kind: record.operation.kind,
            state_version: record.operation.state_version,
            target_sha256: record.operation.target_sha256.clone(),
            request_sha256: record.operation.request_sha256.clone(),
        },
    )?;
    if record.operation != projected || record.operation.method != record.operation.kind.method() {
        return Err(ReceiptError::InvalidField("operation_identity"));
    }
    match &record.event {
        OperationReceiptEvent::RequestStarted { request_id_sha256 } => {
            if record.sequence != 1 || record.recorded_at < record.context.generated_at {
                return Err(ReceiptError::InvalidField("operation_start"));
            }
            validate_lower_hex(request_id_sha256, "operation_request_id_sha256")?;
            if record.operation.kind.is_read()
                && record.operation.request_sha256
                    != read_operation_request_sha256(
                        &record.operation.target_sha256,
                        request_id_sha256,
                    )?
            {
                return Err(ReceiptError::InvalidField("operation_read_request_sha256"));
            }
            if record.recorded_at >= record.context.expires_at {
                let recovery_start_is_valid = record
                    .context
                    .expires_at
                    .checked_add(READ_OPERATION_RECOVERY_WINDOW_SECONDS)
                    .is_some_and(|deadline| {
                        record.operation.kind.may_start_during_recovery()
                            && record.recorded_at <= deadline
                    });
                if !recovery_start_is_valid {
                    return Err(ReceiptError::InvalidField("operation_start"));
                }
            }
        }
        OperationReceiptEvent::RequestFinished {
            outcome,
            http_status,
            response_body_sha256,
            response_id_sha256,
        } => {
            if record.sequence != 2 {
                return Err(ReceiptError::InvalidField("operation_finish"));
            }
            validate_operation_finish_input(
                record.operation.kind,
                &OperationFinishInput {
                    outcome: *outcome,
                    finished_at: record.recorded_at,
                    http_status: *http_status,
                    response_body_sha256: response_body_sha256.clone(),
                    response_id_sha256: response_id_sha256.clone(),
                },
                record.context.generated_at,
            )?;
        }
    }
    Ok(())
}

fn valid_step_shape(step: &ReceiptStepEvent) -> bool {
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

fn valid_post_readback(step: &ReceiptStepEvent) -> bool {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptStepDigestInput<'a> {
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

fn receipt_step_digest(
    claim: &ReceiptClaimIdentity,
    step: &ReceiptStepEvent,
) -> Result<String, ReceiptError> {
    Ok(sha256_hex(
        canonical_json(&ReceiptStepDigestInput {
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
        .map_err(|_| ReceiptError::InvalidField("step_digest"))?
        .as_bytes(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiptExpiryDigestInput<'a> {
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

fn receipt_expiry_digest(
    claim: &ReceiptClaimIdentity,
    expiry: &ReceiptExpiryEvent,
) -> Result<String, ReceiptError> {
    Ok(sha256_hex(
        canonical_json(&ReceiptExpiryDigestInput {
            schema_version: 1,
            contract: EXPIRY_CONTRACT,
            ledger_identity_sha256: &claim.ledger_identity_sha256,
            claim_digest_sha256: &claim.claim_digest_sha256,
            state_version: expiry.state_version,
            from_status: expiry.from_status,
            to_status: expiry.to_status,
            evidence_sha256: &expiry.evidence_sha256,
            failure_class: expiry.failure_class,
        })
        .map_err(|_| ReceiptError::InvalidField("expiry_digest"))?
        .as_bytes(),
    ))
}

fn validate_event_progress(
    record: &ExecutionReceipt,
    index: usize,
    receipt_count: usize,
    status: &mut ClaimStatus,
    state_version: &mut u8,
) -> Result<(), ReceiptError> {
    match &record.event {
        ReceiptEvent::ClaimObserved { .. } if index == 0 => {}
        ReceiptEvent::AuthorityStep { step } => {
            let next = state_version
                .checked_add(1)
                .ok_or(ReceiptError::InvalidField("state_version"))?;
            if step.state_version != next || step.from_status != *status {
                return Err(ReceiptError::InvalidField("step_progress"));
            }
            *state_version = next;
            *status = step.to_status;
        }
        ReceiptEvent::AuthorityExpiry { expiry } => {
            let next = state_version
                .checked_add(1)
                .ok_or(ReceiptError::InvalidField("state_version"))?;
            if expiry.state_version != next || expiry.from_status != *status {
                return Err(ReceiptError::InvalidField("expiry_progress"));
            }
            *state_version = next;
            *status = expiry.to_status;
        }
        ReceiptEvent::TerminalSeal {
            status: terminal_status,
            state_version: terminal_version,
            chain_length,
            ..
        } => {
            if index + 1 != receipt_count
                || *terminal_status != *status
                || *terminal_version != *state_version
                || *chain_length
                    != u64::try_from(receipt_count)
                        .map_err(|_| ReceiptError::InvalidField("chain_length"))?
            {
                return Err(ReceiptError::InvalidField("terminal_progress"));
            }
        }
        ReceiptEvent::ClaimObserved { .. } => {
            return Err(ReceiptError::InvalidField("claim_progress"));
        }
    }
    Ok(())
}

fn append_canonical_receipt(
    chain_directory: &Path,
    receipt: &CanonicalReceipt,
) -> Result<AppendOutcome, ReceiptError> {
    validate_record(&receipt.record)?;
    validate_receipt_directory_entries(chain_directory)?;
    let canonical_parent = fs::canonicalize(chain_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("chain_directory"))?;
    let target = chain_directory.join(receipt_file_name(receipt.record.sequence));
    if target
        .try_exists()
        .map_err(|_| ReceiptError::Io("receipt_exists"))?
    {
        let existing = read_receipt(&target, &canonical_parent)?;
        if existing.bytes == receipt.bytes {
            sync_directory(chain_directory, receipt.sha256())?;
            return Ok(AppendOutcome::ExistingExact);
        }
        return Err(ReceiptError::Conflict);
    }
    if receipt.record.sequence > 1 {
        let predecessor_path = chain_directory.join(receipt_file_name(receipt.record.sequence - 1));
        let predecessor = read_receipt(&predecessor_path, &canonical_parent)?;
        if predecessor.sha256
            != receipt
                .record
                .predecessor_receipt_sha256
                .as_deref()
                .ok_or(ReceiptError::PredecessorMissing)?
        {
            return Err(ReceiptError::PredecessorMismatch);
        }
        if predecessor.record.event.is_terminal_seal() {
            return Err(ReceiptError::AlreadySealed);
        }
    } else if chain_directory
        .join(receipt_file_name(2))
        .try_exists()
        .map_err(|_| ReceiptError::Io("future_receipt"))?
    {
        return Err(ReceiptError::Gap);
    }

    if has_future_receipt(chain_directory, receipt.record.sequence + 1)? {
        return Err(ReceiptError::Gap);
    }

    match publish_exact_bytes(
        chain_directory,
        &target,
        receipt.record.sequence,
        receipt.bytes(),
        MAX_RECEIPT_BYTES,
        "execution_receipt",
    )? {
        ExactPublicationOutcome::Created => {
            if receipt.record.event.is_terminal_seal() {
                set_chain_read_only(chain_directory)?;
                sync_directory(chain_directory, receipt.sha256())?;
            }
            Ok(AppendOutcome::Created)
        }
        ExactPublicationOutcome::ExistingExact => Ok(AppendOutcome::ExistingExact),
        ExactPublicationOutcome::ExistingDifferent(_) => Err(ReceiptError::Conflict),
    }
}

fn append_canonical_operation_receipt(
    operation_directory: &Path,
    receipt: &CanonicalOperationReceipt,
) -> Result<AppendOutcome, ReceiptError> {
    validate_operation_record(&receipt.record)?;
    validate_operation_directory_entries(operation_directory)?;
    let canonical_parent = fs::canonicalize(operation_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("operation_directory"))?;
    let target = operation_directory.join(operation_receipt_file_name(receipt.record.sequence));
    if target
        .try_exists()
        .map_err(|_| ReceiptError::Io("operation_receipt_exists"))?
    {
        let existing = read_operation_receipt(&target, &canonical_parent)?;
        if existing.bytes == receipt.bytes {
            sync_directory(operation_directory, &receipt.sha256)?;
            return Ok(AppendOutcome::ExistingExact);
        }
        return Err(ReceiptError::Conflict);
    }
    if receipt.record.sequence == 2 {
        let predecessor_path = operation_directory.join(operation_receipt_file_name(1));
        let predecessor = read_operation_receipt(&predecessor_path, &canonical_parent)?;
        if predecessor.sha256
            != receipt
                .record
                .predecessor_receipt_sha256
                .as_deref()
                .ok_or(ReceiptError::PredecessorMissing)?
        {
            return Err(ReceiptError::PredecessorMismatch);
        }
    } else if operation_directory
        .join(operation_receipt_file_name(2))
        .try_exists()
        .map_err(|_| ReceiptError::Io("operation_future_receipt"))?
    {
        return Err(ReceiptError::Gap);
    }
    if has_future_operation_receipt(operation_directory, receipt.record.sequence + 1)? {
        return Err(ReceiptError::Gap);
    }

    match publish_exact_bytes(
        operation_directory,
        &target,
        receipt.record.sequence,
        &receipt.bytes,
        MAX_RECEIPT_BYTES,
        "operation_receipt",
    )? {
        ExactPublicationOutcome::Created => {
            if receipt.record.sequence == MAX_OPERATION_RECEIPTS_PER_CHAIN {
                set_chain_read_only(operation_directory)?;
                sync_directory(operation_directory, &receipt.sha256)?;
            }
            Ok(AppendOutcome::Created)
        }
        ExactPublicationOutcome::ExistingExact => Ok(AppendOutcome::ExistingExact),
        ExactPublicationOutcome::ExistingDifferent(_) => Err(ReceiptError::Conflict),
    }
}

fn verify_chain_directory(
    chain_directory: &Path,
    authorization_id_sha256: &str,
) -> Result<VerifiedReceiptChain, ReceiptError> {
    validate_receipt_directory_entries(chain_directory)?;
    let canonical_parent = fs::canonicalize(chain_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("chain_directory"))?;
    let mut previous: Option<CanonicalReceipt> = None;
    let mut sealed = false;
    let mut status = ClaimStatus::Claimed;
    let mut state_version = 0_u8;
    let mut records = Vec::new();
    for sequence in 1..=MAX_RECEIPTS_PER_CHAIN {
        let path = chain_directory.join(receipt_file_name(sequence));
        if !path
            .try_exists()
            .map_err(|_| ReceiptError::Io("receipt_exists"))?
        {
            if has_future_receipt(chain_directory, sequence + 1)? {
                return Err(ReceiptError::Gap);
            }
            break;
        }
        if sealed {
            return Err(ReceiptError::AlreadySealed);
        }
        let receipt = read_receipt(&path, &canonical_parent)?;
        if receipt.record.sequence != sequence
            || receipt.record.claim.authorization_id_sha256 != authorization_id_sha256
        {
            return Err(ReceiptError::InvalidField("chain_identity"));
        }
        match &previous {
            None if receipt.record.predecessor_receipt_sha256.is_none() => {}
            Some(predecessor)
                if receipt.record.predecessor_receipt_sha256.as_deref()
                    == Some(predecessor.sha256()) => {}
            None => return Err(ReceiptError::PredecessorMissing),
            Some(_) => return Err(ReceiptError::PredecessorMismatch),
        }
        if let Some(predecessor) = &previous {
            if receipt.record.release != predecessor.record.release
                || receipt.record.credential_identity != predecessor.record.credential_identity
                || receipt.record.claim != predecessor.record.claim
                || receipt.record.recorded_at < predecessor.record.recorded_at
            {
                return Err(ReceiptError::Conflict);
            }
        }
        sealed = receipt.record.event.is_terminal_seal();
        records.push(receipt.clone());
        previous = Some(receipt);
    }
    let head = previous.ok_or(ReceiptError::PredecessorMissing)?;
    let receipt_count = head.record.sequence;
    if let ReceiptEvent::TerminalSeal { chain_length, .. } = head.record.event {
        if chain_length != receipt_count {
            return Err(ReceiptError::InvalidField("chain_length"));
        }
    }
    let record_count = records.len();
    for (index, receipt) in records.iter().enumerate() {
        validate_event_progress(
            &receipt.record,
            index,
            record_count,
            &mut status,
            &mut state_version,
        )?;
    }
    if status.is_terminal() && !sealed {
        return Err(ReceiptError::NotSealed);
    }
    let (terminal_status, terminal_state_version) = match &head.record.event {
        ReceiptEvent::TerminalSeal {
            status,
            state_version,
            ..
        } => (Some(*status), Some(*state_version)),
        _ => (None, None),
    };
    Ok(VerifiedReceiptChain {
        authorization_id_sha256: authorization_id_sha256.to_owned(),
        receipt_count,
        head_sha256: head.sha256,
        sealed,
        terminal_status,
        terminal_state_version,
    })
}

fn verify_operation_directory(
    operation_directory: &Path,
    authorization_id_sha256: &str,
    operation_id_sha256: &str,
) -> Result<VerifiedOperationReceiptChainInternal, ReceiptError> {
    validate_operation_directory_entries(operation_directory)?;
    let canonical_parent = fs::canonicalize(operation_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("operation_directory"))?;
    let start = read_operation_receipt(
        &operation_directory.join(operation_receipt_file_name(1)),
        &canonical_parent,
    )?;
    if start.record.sequence != 1
        || start.record.context.authorization_id_sha256 != authorization_id_sha256
        || start.record.operation.operation_id_sha256 != operation_id_sha256
        || start.record.predecessor_receipt_sha256.is_some()
        || !matches!(
            start.record.event,
            OperationReceiptEvent::RequestStarted { .. }
        )
    {
        return Err(ReceiptError::InvalidField("operation_chain_identity"));
    }
    let finish_path = operation_directory.join(operation_receipt_file_name(2));
    let finish = if finish_path
        .try_exists()
        .map_err(|_| ReceiptError::Io("operation_finish_exists"))?
    {
        let finish = read_operation_receipt(&finish_path, &canonical_parent)?;
        if finish.record.sequence != 2
            || finish.record.predecessor_receipt_sha256.as_deref() != Some(&start.sha256)
            || finish.record.context != start.record.context
            || finish.record.operation != start.record.operation
            || finish.record.recorded_at < start.record.recorded_at
        {
            return Err(ReceiptError::Conflict);
        }
        Some(finish)
    } else {
        None
    };
    let (receipt_count, head_sha256, outcome) = match finish {
        Some(finish) => {
            let OperationReceiptEvent::RequestFinished { outcome, .. } = finish.record.event else {
                return Err(ReceiptError::InvalidField("operation_finish"));
            };
            (2, finish.sha256, Some(outcome))
        }
        None => (1, start.sha256.clone(), None),
    };
    Ok(VerifiedOperationReceiptChainInternal {
        verified: VerifiedOperationReceiptChain {
            operation_id_sha256: operation_id_sha256.to_owned(),
            receipt_count,
            head_sha256,
            outcome,
        },
        context: start.record.context,
        operation: start.record.operation,
        start_sha256: start.sha256,
        start_recorded_at: start.record.recorded_at,
    })
}

fn require_operation_identity(
    verified: &VerifiedOperationReceiptChainInternal,
    context: &OperationContextIdentity,
    operation: &OperationIdentity,
) -> Result<(), ReceiptError> {
    if &verified.context != context || &verified.operation != operation {
        return Err(ReceiptError::Conflict);
    }
    Ok(())
}

fn operation_reservation(verified: &VerifiedOperationReceiptChainInternal) -> OperationReservation {
    match verified.verified.outcome {
        Some(outcome) => OperationReservation::ExistingFinished(outcome),
        None => OperationReservation::ExistingUnfinished,
    }
}

fn read_receipt(path: &Path, canonical_parent: &Path) -> Result<CanonicalReceipt, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_RECEIPT_BYTES,
        canonical_parent,
        "execution_receipt",
    )
    .map_err(map_release_file_error)?;
    let record: ExecutionReceipt =
        parse_canonical_json(&bytes, MAX_RECEIPT_BYTES, "execution_receipt").map_err(|error| {
            match error {
                ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
                ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
                _ => ReceiptError::UnsafeFilesystem("execution_receipt"),
            }
        })?;
    validate_record(&record)?;
    let sha256 = sha256_hex(&bytes);
    Ok(CanonicalReceipt {
        record,
        bytes,
        sha256,
    })
}

fn read_operation_receipt(
    path: &Path,
    canonical_parent: &Path,
) -> Result<CanonicalOperationReceipt, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_RECEIPT_BYTES,
        canonical_parent,
        "operation_receipt",
    )
    .map_err(map_release_file_error)?;
    let record: OperationReceipt =
        parse_canonical_json(&bytes, MAX_RECEIPT_BYTES, "operation_receipt").map_err(|error| {
            match error {
                ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
                ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
                _ => ReceiptError::UnsafeFilesystem("operation_receipt"),
            }
        })?;
    validate_operation_record(&record)?;
    let sha256 = sha256_hex(&bytes);
    Ok(CanonicalOperationReceipt {
        record,
        bytes,
        sha256,
    })
}

fn reserve_operation_capacity(
    authorization_directory: &Path,
    operation_id_sha256: &str,
) -> Result<(), ReceiptError> {
    validate_lower_hex(operation_id_sha256, "operation_id_sha256")?;
    let initial_slot = usize::from_str_radix(&operation_id_sha256[..16], 16)
        .map_err(|_| ReceiptError::InvalidField("operation_id_sha256"))?
        % MAX_OPERATION_CHAINS_PER_AUTHORIZATION;
    for offset in 0..MAX_OPERATION_CHAINS_PER_AUTHORIZATION {
        let slot = (initial_slot + offset) % MAX_OPERATION_CHAINS_PER_AUTHORIZATION;
        let record = OperationCapacityReservation {
            schema_version: 1,
            contract: OPERATION_CAPACITY_RESERVATION_CONTRACT.to_owned(),
            slot: u16::try_from(slot)
                .map_err(|_| ReceiptError::InvalidField("operation_capacity_slot"))?,
            operation_id_sha256: operation_id_sha256.to_owned(),
        };
        let bytes = canonical_json(&record)
            .map_err(|_| ReceiptError::InvalidField("operation_capacity_reservation"))?
            .into_bytes();
        let path = authorization_directory.join(operation_capacity_file_name(slot));
        if path
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_capacity_reservation_exists"))?
        {
            let existing = read_operation_capacity_reservation(&path, authorization_directory)?;
            if existing.operation_id_sha256 == operation_id_sha256 {
                return Ok(());
            }
            continue;
        }
        let staging_sequence = u64::try_from(slot + 1)
            .map_err(|_| ReceiptError::InvalidField("operation_capacity_slot"))?;
        match publish_exact_bytes(
            authorization_directory,
            &path,
            staging_sequence,
            &bytes,
            MAX_RECEIPT_BYTES,
            "operation_capacity_reservation",
        )? {
            ExactPublicationOutcome::Created | ExactPublicationOutcome::ExistingExact => {
                return Ok(());
            }
            ExactPublicationOutcome::ExistingDifferent(existing_bytes) => {
                let existing = parse_operation_capacity_reservation_bytes(&existing_bytes)?;
                if existing.operation_id_sha256 == operation_id_sha256 {
                    return Ok(());
                }
                continue;
            }
        }
    }
    Err(ReceiptError::InvalidField("operation_chain_count"))
}

fn read_operation_capacity_reservation(
    path: &Path,
    canonical_parent: &Path,
) -> Result<OperationCapacityReservation, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_RECEIPT_BYTES,
        canonical_parent,
        "operation_capacity_reservation",
    )
    .map_err(map_release_file_error)?;
    parse_operation_capacity_reservation_bytes(&bytes)
}

fn parse_operation_capacity_reservation_bytes(
    bytes: &[u8],
) -> Result<OperationCapacityReservation, ReceiptError> {
    let record: OperationCapacityReservation =
        parse_canonical_json(bytes, MAX_RECEIPT_BYTES, "operation_capacity_reservation").map_err(
            |error| match error {
                ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
                ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
                _ => ReceiptError::UnsafeFilesystem("operation_capacity_reservation"),
            },
        )?;
    if record.schema_version != 1
        || record.contract != OPERATION_CAPACITY_RESERVATION_CONTRACT
        || usize::from(record.slot) >= MAX_OPERATION_CHAINS_PER_AUTHORIZATION
        || validate_lower_hex(&record.operation_id_sha256, "operation_id_sha256").is_err()
    {
        return Err(ReceiptError::InvalidField("operation_capacity_reservation"));
    }
    Ok(record)
}

fn validate_operation_head_set(record: &OperationHeadSetManifest) -> Result<(), ReceiptError> {
    let capacity_limit = u64::try_from(MAX_OPERATION_CHAINS_PER_AUTHORIZATION)
        .map_err(|_| ReceiptError::InvalidField("capacity_limit"))?;
    if record.schema_version != 1
        || record.contract != OPERATION_HEAD_SET_CONTRACT
        || record.environment != "staging"
        || record.capacity_limit != capacity_limit
        || record.capacity_reservation_count
            != u64::try_from(record.entries.len())
                .map_err(|_| ReceiptError::InvalidField("capacity_reservation_count"))?
        || record
            .operation_count
            .checked_add(record.marker_only_count)
            .ok_or(ReceiptError::InvalidField("capacity_reservation_count"))?
            != record.capacity_reservation_count
        || record.capacity_reservation_count > capacity_limit
    {
        return Err(ReceiptError::InvalidField("operation_head_set"));
    }
    for value in [
        record.activation_sha256.as_str(),
        record.authorization_id_sha256.as_str(),
        record.claim_digest_sha256.as_str(),
        record.operation_context_sha256.as_str(),
    ] {
        validate_lower_hex(value, "operation_head_set_sha256")?;
    }
    let mut terminal_count = 0_u64;
    let mut marker_only_count = 0_u64;
    let mut previous_slot = None;
    let mut operation_ids = BTreeMap::new();
    for entry in &record.entries {
        if usize::from(entry.slot) >= MAX_OPERATION_CHAINS_PER_AUTHORIZATION
            || previous_slot.is_some_and(|slot| slot >= entry.slot)
        {
            return Err(ReceiptError::InvalidField("operation_head_set_slot"));
        }
        previous_slot = Some(entry.slot);
        validate_lower_hex(&entry.operation_id_sha256, "operation_id_sha256")?;
        if operation_ids
            .insert(entry.operation_id_sha256.as_str(), ())
            .is_some()
        {
            return Err(ReceiptError::InvalidField("operation_head_set_operation"));
        }
        match entry.chain_state {
            OperationHeadSetChainState::MarkerOnly => {
                if entry.start_receipt_sha256.is_some()
                    || entry.receipt_count != 0
                    || entry.head_sha256.is_some()
                    || entry.outcome.is_some()
                {
                    return Err(ReceiptError::InvalidField("operation_head_set_marker"));
                }
                marker_only_count = marker_only_count
                    .checked_add(1)
                    .ok_or(ReceiptError::InvalidField("marker_only_count"))?;
            }
            OperationHeadSetChainState::Terminal => {
                validate_lower_hex(
                    entry
                        .start_receipt_sha256
                        .as_deref()
                        .ok_or(ReceiptError::InvalidField("start_receipt_sha256"))?,
                    "start_receipt_sha256",
                )?;
                validate_lower_hex(
                    entry
                        .head_sha256
                        .as_deref()
                        .ok_or(ReceiptError::InvalidField("operation_head_sha256"))?,
                    "operation_head_sha256",
                )?;
                if entry.receipt_count != MAX_OPERATION_RECEIPTS_PER_CHAIN
                    || entry.outcome.is_none()
                {
                    return Err(ReceiptError::InvalidField("operation_head_set_terminal"));
                }
                terminal_count = terminal_count
                    .checked_add(1)
                    .ok_or(ReceiptError::InvalidField("operation_count"))?;
            }
        }
    }
    if terminal_count != record.operation_count || marker_only_count != record.marker_only_count {
        return Err(ReceiptError::InvalidField("operation_head_set_count"));
    }
    Ok(())
}

fn validate_operation_head_local_seal(record: &OperationHeadLocalSeal) -> Result<(), ReceiptError> {
    if record.schema_version != 1
        || record.contract != OPERATION_HEAD_LOCAL_SEAL_CONTRACT
        || record.environment != "staging"
        || record.execution_receipt_count == 0
        || record.execution_receipt_count > MAX_RECEIPTS_PER_CHAIN
        || !valid_terminal_receipt_shape(
            record.terminal_status,
            record.terminal_state_version,
            record.execution_receipt_count,
        )
        || record.operation_head_set_bytes == 0
        || record.operation_head_set_bytes > MAX_RECEIPT_BYTES as u64
        || record
            .operation_count
            .checked_add(record.marker_only_count)
            .ok_or(ReceiptError::InvalidField("capacity_reservation_count"))?
            != record.capacity_reservation_count
        || record.capacity_reservation_count
            > u64::try_from(MAX_OPERATION_CHAINS_PER_AUTHORIZATION)
                .map_err(|_| ReceiptError::InvalidField("capacity_reservation_count"))?
    {
        return Err(ReceiptError::InvalidField("operation_head_local_seal"));
    }
    for value in [
        record.activation_sha256.as_str(),
        record.authorization_id_sha256.as_str(),
        record.claim_digest_sha256.as_str(),
        record.operation_context_sha256.as_str(),
        record.execution_receipt_head_sha256.as_str(),
        record.operation_head_set_sha256.as_str(),
    ] {
        validate_lower_hex(value, "operation_head_local_seal_sha256")?;
    }
    match (
        &record.terminal_snapshot_candidate_sha256,
        record.terminal_snapshot_candidate_bytes,
        &record.terminal_candidate_operation_id_sha256,
        &record.terminal_candidate_start_receipt_sha256,
    ) {
        (None, None, None, None) => {}
        (Some(candidate_sha256), Some(candidate_bytes), Some(operation_id), Some(start_sha256))
            if candidate_bytes > 0
                && candidate_bytes <= MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES as u64 =>
        {
            for value in [
                candidate_sha256.as_str(),
                operation_id.as_str(),
                start_sha256.as_str(),
            ] {
                validate_lower_hex(value, "operation_head_local_seal_candidate_sha256")?;
            }
        }
        _ => {
            return Err(ReceiptError::InvalidField(
                "operation_head_local_seal_candidate",
            ));
        }
    }
    Ok(())
}

fn valid_terminal_receipt_shape(
    status: ClaimStatus,
    state_version: u8,
    receipt_count: u64,
) -> bool {
    let status_matches = matches!(
        (status, state_version),
        (ClaimStatus::Completed, 6)
            | (ClaimStatus::RecoveryRequired, 3..=6)
            | (ClaimStatus::Aborted | ClaimStatus::Expired, 1..=2)
    );
    status_matches && receipt_count == u64::from(state_version) + 2
}

fn read_operation_head_set(
    path: &Path,
    canonical_parent: &Path,
) -> Result<CanonicalOperationHeadSet, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_RECEIPT_BYTES,
        canonical_parent,
        "operation_head_set",
    )
    .map_err(map_release_file_error)?;
    let record: OperationHeadSetManifest =
        parse_canonical_json(&bytes, MAX_RECEIPT_BYTES, "operation_head_set").map_err(|error| {
            match error {
                ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
                ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
                _ => ReceiptError::UnsafeFilesystem("operation_head_set"),
            }
        })?;
    validate_operation_head_set(&record)?;
    let verified = VerifiedOperationHeadSet {
        sha256: sha256_hex(&bytes),
        bytes: u64::try_from(bytes.len())
            .map_err(|_| ReceiptError::InvalidField("operation_head_set_bytes"))?,
        operation_context_sha256: record.operation_context_sha256.clone(),
        operation_count: record.operation_count,
        capacity_reservation_count: record.capacity_reservation_count,
        marker_only_count: record.marker_only_count,
    };
    Ok(CanonicalOperationHeadSet {
        record,
        bytes,
        verified,
    })
}

fn read_operation_head_local_seal(
    path: &Path,
    canonical_parent: &Path,
) -> Result<CanonicalOperationHeadLocalSeal, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_RECEIPT_BYTES,
        canonical_parent,
        "operation_head_local_seal",
    )
    .map_err(map_release_file_error)?;
    let record: OperationHeadLocalSeal =
        parse_canonical_json(&bytes, MAX_RECEIPT_BYTES, "operation_head_local_seal").map_err(
            |error| match error {
                ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
                ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
                _ => ReceiptError::UnsafeFilesystem("operation_head_local_seal"),
            },
        )?;
    validate_operation_head_local_seal(&record)?;
    let sha256 = sha256_hex(&bytes);
    Ok(CanonicalOperationHeadLocalSeal {
        record,
        bytes,
        sha256,
    })
}

fn read_terminal_snapshot_candidate(
    path: &Path,
    canonical_parent: &Path,
    context: &OperationContextIdentity,
) -> Result<CanonicalTerminalSnapshotCandidate, ReceiptError> {
    let bytes = read_stable_regular_file(
        path,
        MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES,
        canonical_parent,
        "terminal_snapshot_candidate",
    )
    .map_err(map_release_file_error)?;
    let record: TerminalSnapshotCandidate = parse_canonical_json(
        &bytes,
        MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES,
        "terminal_snapshot_candidate",
    )
    .map_err(|error| match error {
        ReleaseVerificationError::InvalidJson(_) => ReceiptError::InvalidJson,
        ReleaseVerificationError::NonCanonicalJson(_) => ReceiptError::NonCanonicalJson,
        _ => ReceiptError::UnsafeFilesystem("terminal_snapshot_candidate"),
    })?;
    validate_terminal_snapshot_candidate_record(&record, context)?;
    let snapshot_bytes = canonical_json(&record.snapshot)
        .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate"))?
        .into_bytes();
    if sha256_hex(&snapshot_bytes) != record.snapshot_sha256
        || u64::try_from(snapshot_bytes.len())
            .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate_bytes"))?
            != record.snapshot_bytes
    {
        return Err(ReceiptError::Conflict);
    }
    let snapshot = VerifiedSnapshot::from_json(&snapshot_bytes)
        .map_err(|_| ReceiptError::InvalidField("terminal_snapshot_candidate_snapshot"))?;
    if !snapshot.status().is_terminal() {
        return Err(ReceiptError::NotSealed);
    }
    Ok(CanonicalTerminalSnapshotCandidate {
        record,
        sha256: sha256_hex(&bytes),
        bytes,
        snapshot,
    })
}

fn require_execution_chain_matches_terminal_candidate(
    chain_directory: &Path,
    chain: &VerifiedReceiptChain,
    candidate: &CanonicalTerminalSnapshotCandidate,
) -> Result<(), ReceiptError> {
    if chain.head_sha256 != candidate.record.expected_execution_receipt_head_sha256
        || chain.receipt_count != candidate.record.expected_execution_receipt_count
    {
        return Err(ReceiptError::Conflict);
    }
    let canonical_parent = fs::canonicalize(chain_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("chain_directory"))?;
    let terminal = read_receipt(
        &chain_directory.join(receipt_file_name(chain.receipt_count)),
        &canonical_parent,
    )?;
    let ReceiptEvent::TerminalSeal {
        status,
        state_version,
        final_snapshot_sha256,
        final_snapshot_bytes,
        ..
    } = &terminal.record.event
    else {
        return Err(ReceiptError::NotSealed);
    };
    if *status != candidate.snapshot.status()
        || *state_version != candidate.snapshot.state_version()
        || final_snapshot_sha256 != &candidate.record.snapshot_sha256
        || *final_snapshot_bytes != candidate.record.snapshot_bytes
    {
        return Err(ReceiptError::Conflict);
    }
    Ok(())
}

fn publish_canonical_bytes(
    parent: &Path,
    target: &Path,
    staging_sequence: u64,
    bytes: &[u8],
    label: &'static str,
) -> Result<AppendOutcome, ReceiptError> {
    publish_canonical_bytes_with_limit(
        parent,
        target,
        staging_sequence,
        bytes,
        MAX_RECEIPT_BYTES,
        label,
    )
}

fn publish_canonical_bytes_with_limit(
    parent: &Path,
    target: &Path,
    staging_sequence: u64,
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
) -> Result<AppendOutcome, ReceiptError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(ReceiptError::InvalidField("canonical_publication_bytes"));
    }
    match publish_exact_bytes(
        parent,
        target,
        staging_sequence,
        bytes,
        maximum_bytes,
        label,
    )? {
        ExactPublicationOutcome::Created => Ok(AppendOutcome::Created),
        ExactPublicationOutcome::ExistingExact => Ok(AppendOutcome::ExistingExact),
        ExactPublicationOutcome::ExistingDifferent(_) => Err(ReceiptError::Conflict),
    }
}

fn freeze_operation_directories(
    authorization: &Path,
    head_set: &OperationHeadSetManifest,
) -> Result<(), ReceiptError> {
    for entry in &head_set.entries {
        let operation = authorization.join(&entry.operation_id_sha256);
        if !operation
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_directory_exists"))?
        {
            continue;
        }
        require_fixed_directory(&operation, authorization, "operation_directory")?;
        validate_operation_directory_entries(&operation)?;
        set_chain_read_only(&operation)?;
        sync_directory(&operation, &entry.operation_id_sha256)?;
    }
    Ok(())
}

fn require_execution_chain_identity(
    chain_directory: &Path,
    publication: &PublicationIdentity,
    credentials: &CredentialIdentity,
    context: &OperationContextIdentity,
) -> Result<(), ReceiptError> {
    let canonical_parent = fs::canonicalize(chain_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("chain_directory"))?;
    let first = read_receipt(
        &chain_directory.join(receipt_file_name(1)),
        &canonical_parent,
    )?;
    if first.record.release != ReceiptReleaseIdentity::from(publication)
        || first.record.credential_identity != ReceiptCredentialIdentity::from(credentials)
    {
        return Err(ReceiptError::Projection("execution_receipt_identity"));
    }
    require_execution_receipt_context(&first.record, context)
}

fn require_execution_chain_identity_from_context(
    chain_directory: &Path,
    context: &OperationContextIdentity,
) -> Result<(), ReceiptError> {
    let canonical_parent = fs::canonicalize(chain_directory)
        .map_err(|_| ReceiptError::UnsafeFilesystem("chain_directory"))?;
    let first = read_receipt(
        &chain_directory.join(receipt_file_name(1)),
        &canonical_parent,
    )?;
    require_execution_receipt_context(&first.record, context)
}

fn require_execution_receipt_context(
    receipt: &ExecutionReceipt,
    context: &OperationContextIdentity,
) -> Result<(), ReceiptError> {
    let release = &receipt.release;
    let credential = &receipt.credential_identity;
    let claim = &receipt.claim;
    let matches = release.source_commit == context.source_commit
        && release.git_tree_sha == context.git_tree_sha
        && release.release_manifest_sha256 == context.release_manifest_sha256
        && release.release_packet_sha256 == context.release_packet_sha256
        && release.release_policy_sha256 == context.release_policy_sha256
        && release.artifact_sha256 == context.artifact_sha256
        && release.module_inventory_sha256 == context.module_inventory_sha256
        && release.module_count == context.module_count
        && release.publication_manifest_sha256 == context.publication_manifest_sha256
        && release.publication_packet_sha256 == context.publication_packet_sha256
        && release.generation_sha256 == context.generation_sha256
        && release.activation_sequence == context.activation_sequence
        && credential.account_id_sha256 == context.account_id_sha256
        && credential.read_credential_id_sha256 == context.read_credential_id_sha256
        && credential.claim_credential_id_sha256 == context.claim_credential_id_sha256
        && credential.deploy_credential_id_sha256 == context.deploy_credential_id_sha256
        && credential.access_client_id_sha256 == context.access_client_id_sha256
        && credential.authority_version_id == context.authority_version_id
        && credential.permit_spki_sha256 == context.permit_spki_sha256
        && credential.trust_config_sha256 == context.trust_config_sha256
        && credential.runner_build_sha256 == context.artifact_sha256
        && credential.controller_service_name == context.controller_service_name
        && credential.edge_service_name == context.edge_service_name
        && claim.authorization_id_sha256 == context.authorization_id_sha256
        && claim.claim_digest_sha256 == context.claim_digest_sha256
        && claim.ledger_identity_sha256 == context.ledger_identity_sha256
        && claim.claim_owner_sha256 == context.claim_owner_sha256
        && claim.account_id_sha256 == context.account_id_sha256
        && claim.generated_at == context.generated_at
        && claim.expires_at == context.expires_at;
    if !matches {
        return Err(ReceiptError::Projection("execution_receipt_context"));
    }
    Ok(())
}

fn map_release_file_error(error: ReleaseVerificationError) -> ReceiptError {
    match error {
        ReleaseVerificationError::FileInvalid(_) => {
            ReceiptError::UnsafeFilesystem("execution_receipt")
        }
        _ => ReceiptError::Io("execution_receipt"),
    }
}

fn create_fixed_directory(
    directory: &Path,
    expected_parent: &Path,
    label: &'static str,
) -> Result<bool, ReceiptError> {
    let created = match fs::create_dir(directory) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(ReceiptError::Io(label)),
    };
    require_fixed_directory(directory, expected_parent, label)?;
    if created {
        sync_directory(expected_parent, "directory")?;
    }
    Ok(created)
}

fn require_fixed_directory(
    directory: &Path,
    expected_parent: &Path,
    label: &'static str,
) -> Result<(), ReceiptError> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    let canonical =
        fs::canonicalize(directory).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    let parent =
        fs::canonicalize(expected_parent).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn publish_exact_bytes(
    parent: &Path,
    target: &Path,
    staging_sequence: u64,
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
) -> Result<ExactPublicationOutcome, ReceiptError> {
    publish_exact_bytes_linux_with_hook(
        parent,
        target,
        staging_sequence,
        bytes,
        maximum_bytes,
        label,
        || {},
    )
}

#[cfg(target_os = "linux")]
fn publish_exact_bytes_linux_with_hook<F>(
    parent: &Path,
    target: &Path,
    staging_sequence: u64,
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
    after_staging_sync: F,
) -> Result<ExactPublicationOutcome, ReceiptError>
where
    F: FnOnce(),
{
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    if bytes.is_empty() || bytes.len() > maximum_bytes || target.parent() != Some(parent) {
        return Err(ReceiptError::InvalidField("canonical_publication_bytes"));
    }
    let target_name = target
        .file_name()
        .ok_or(ReceiptError::UnsafeFilesystem(label))?;
    let target_name =
        CString::new(target_name.as_bytes()).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    let directory =
        open_linux_directory(parent).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    let directory_identity = linux_directory_identity(&directory, label)?;
    if let Some((existing, _)) =
        read_stable_linux_regular_at(&directory, &target_name, maximum_bytes, label)?
    {
        sync_linux_directory(&directory, &sha256_hex(bytes))?;
        require_linux_directory_path_identity(parent, &directory_identity, label)?;
        return Ok(if existing == bytes {
            ExactPublicationOutcome::ExistingExact
        } else {
            ExactPublicationOutcome::ExistingDifferent(existing)
        });
    }

    let stage_name = staging_file_name(staging_sequence)?;
    let stage_name = CString::new(stage_name.as_bytes())
        .map_err(|_| ReceiptError::UnsafeFilesystem("staging_name"))?;
    let stage = create_linux_staging_at(&directory, &stage_name)?;
    let stage_writer = stage
        .try_clone()
        .map_err(|_| ReceiptError::Io("clone_staging"))?;
    write_staging_file(stage_writer, bytes, maximum_bytes)?;
    let stage_identity = linux_regular_file_identity(&stage, "staging_file")?;
    after_staging_sync();

    let rename_result = unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            stage_name.as_ptr(),
            directory.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rename_result != 0 {
        let _ = unsafe { libc::unlinkat(directory.as_raw_fd(), stage_name.as_ptr(), 0) };
        sync_linux_directory(&directory, &sha256_hex(bytes))?;
        require_linux_directory_path_identity(parent, &directory_identity, label)?;
        if let Some((existing, _)) =
            read_stable_linux_regular_at(&directory, &target_name, maximum_bytes, label)?
        {
            return Ok(if existing == bytes {
                ExactPublicationOutcome::ExistingExact
            } else {
                ExactPublicationOutcome::ExistingDifferent(existing)
            });
        }
        return Err(ReceiptError::DurabilityUnknown {
            expected_sha256: sha256_hex(bytes),
        });
    }

    sync_linux_directory(&directory, &sha256_hex(bytes))?;
    let (installed, installed_identity) =
        read_stable_linux_regular_at(&directory, &target_name, maximum_bytes, label)?.ok_or_else(
            || ReceiptError::DurabilityUnknown {
                expected_sha256: sha256_hex(bytes),
            },
        )?;
    if installed != bytes
        || installed_identity != stage_identity
        || linux_directory_identity(&directory, label)? != directory_identity
    {
        return Err(ReceiptError::Conflict);
    }
    require_linux_directory_path_identity(parent, &directory_identity, label)?;
    Ok(ExactPublicationOutcome::Created)
}

#[cfg(not(target_os = "linux"))]
fn publish_exact_bytes(
    parent: &Path,
    target: &Path,
    staging_sequence: u64,
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
) -> Result<ExactPublicationOutcome, ReceiptError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes || target.parent() != Some(parent) {
        return Err(ReceiptError::InvalidField("canonical_publication_bytes"));
    }
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if target.try_exists().map_err(|_| ReceiptError::Io(label))? {
        let existing = read_stable_regular_file(target, maximum_bytes, &canonical_parent, label)
            .map_err(map_release_file_error)?;
        sync_directory(parent, &sha256_hex(bytes))?;
        return Ok(if existing == bytes {
            ExactPublicationOutcome::ExistingExact
        } else {
            ExactPublicationOutcome::ExistingDifferent(existing)
        });
    }
    let stage = parent.join(staging_file_name(staging_sequence)?);
    write_staging_with_limit(&stage, bytes, maximum_bytes)?;
    if publish_noreplace(&stage, target).is_err() {
        let _ = fs::remove_file(&stage);
        match target.try_exists() {
            Ok(true) => {
                let existing =
                    read_stable_regular_file(target, maximum_bytes, &canonical_parent, label)
                        .map_err(map_release_file_error)?;
                sync_directory(parent, &sha256_hex(bytes))?;
                return Ok(if existing == bytes {
                    ExactPublicationOutcome::ExistingExact
                } else {
                    ExactPublicationOutcome::ExistingDifferent(existing)
                });
            }
            Ok(false) | Err(_) => {
                return Err(ReceiptError::DurabilityUnknown {
                    expected_sha256: sha256_hex(bytes),
                });
            }
        }
    }
    let sha256 = sha256_hex(bytes);
    sync_directory(parent, &sha256)?;
    let installed = read_stable_regular_file(target, maximum_bytes, &canonical_parent, label)
        .map_err(map_release_file_error)?;
    if installed != bytes {
        return Err(ReceiptError::Conflict);
    }
    Ok(ExactPublicationOutcome::Created)
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LinuxFilesystemIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
}

#[cfg(target_os = "linux")]
fn linux_file_identity(file: &fs::File) -> Result<(libc::stat, LinuxFilesystemIdentity), ()> {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(());
    }
    let stat = unsafe { stat.assume_init() };
    let identity = LinuxFilesystemIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
        uid: stat.st_uid,
        gid: stat.st_gid,
        mode: stat.st_mode,
        links: stat.st_nlink,
    };
    Ok((stat, identity))
}

#[cfg(target_os = "linux")]
fn linux_directory_identity(
    directory: &fs::File,
    label: &'static str,
) -> Result<LinuxFilesystemIdentity, ReceiptError> {
    let (stat, identity) =
        linux_file_identity(directory).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR
        || stat.st_uid != unsafe { libc::geteuid() }
        || stat.st_gid != unsafe { libc::getegid() }
        || stat.st_mode & 0o022 != 0
        || stat.st_nlink < 2
    {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(identity)
}

#[cfg(target_os = "linux")]
fn require_linux_directory_path_identity(
    path: &Path,
    expected: &LinuxFilesystemIdentity,
    label: &'static str,
) -> Result<(), ReceiptError> {
    let reopened = open_linux_directory(path).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if linux_directory_identity(&reopened, label)? != *expected {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn same_linux_directory_object(
    left: &LinuxFilesystemIdentity,
    right: &LinuxFilesystemIdentity,
) -> bool {
    left.device == right.device
        && left.inode == right.inode
        && left.uid == right.uid
        && left.gid == right.gid
}

#[cfg(target_os = "linux")]
fn require_linux_directory_path_object(
    path: &Path,
    expected: &LinuxFilesystemIdentity,
    label: &'static str,
) -> Result<(), ReceiptError> {
    let reopened = open_linux_directory(path).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    let actual = linux_directory_identity(&reopened, label)?;
    if !same_linux_directory_object(&actual, expected) {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_linux_directory_at_object(
    parent: &fs::File,
    file_name: &std::ffi::CStr,
    expected: &LinuxFilesystemIdentity,
    label: &'static str,
) -> Result<(), ReceiptError> {
    let reopened = open_linux_directory_at(parent, file_name)
        .map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    let actual = linux_directory_identity(&reopened, label)?;
    if !same_linux_directory_object(&actual, expected) {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_regular_file_identity(
    file: &fs::File,
    label: &'static str,
) -> Result<LinuxFilesystemIdentity, ReceiptError> {
    let (stat, identity) =
        linux_file_identity(file).map_err(|_| ReceiptError::UnsafeFilesystem(label))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_uid != unsafe { libc::geteuid() }
        || stat.st_gid != unsafe { libc::getegid() }
        || stat.st_mode & 0o777 != 0o444
        || stat.st_nlink != 1
    {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    Ok(identity)
}

#[cfg(target_os = "linux")]
fn create_linux_staging_at(
    directory: &fs::File,
    file_name: &std::ffi::CStr,
) -> Result<fs::File, ReceiptError> {
    open_linux_beneath(
        directory,
        file_name,
        libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
    .map_err(|_| ReceiptError::Io("create_staging"))
}

#[cfg(target_os = "linux")]
fn read_stable_linux_regular_at(
    directory: &fs::File,
    file_name: &std::ffi::CStr,
    maximum_bytes: usize,
    label: &'static str,
) -> Result<Option<(Vec<u8>, LinuxFilesystemIdentity)>, ReceiptError> {
    let mut file = match open_linux_beneath(
        directory,
        file_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    ) {
        Ok(file) => file,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(ReceiptError::UnsafeFilesystem(label));
        }
    };
    let before = linux_regular_file_identity(&file, label)?;
    let length = file
        .metadata()
        .map_err(|_| ReceiptError::UnsafeFilesystem(label))?
        .len();
    if length == 0 || length > maximum_bytes as u64 {
        return Err(ReceiptError::UnsafeFilesystem(label));
    }
    let mut first = Vec::with_capacity(length as usize);
    Read::by_ref(&mut file)
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut first)
        .map_err(|_| ReceiptError::Io(label))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ReceiptError::Io(label))?;
    let mut second = Vec::with_capacity(first.len());
    Read::by_ref(&mut file)
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut second)
        .map_err(|_| ReceiptError::Io(label))?;
    let after = linux_regular_file_identity(&file, label)?;
    if first != second || before != after || first.len() != length as usize {
        return Err(ReceiptError::Conflict);
    }
    Ok(Some((first, after)))
}

#[cfg(target_os = "linux")]
fn sync_linux_directory(directory: &fs::File, expected_sha256: &str) -> Result<(), ReceiptError> {
    directory
        .sync_all()
        .map_err(|_| ReceiptError::DurabilityUnknown {
            expected_sha256: expected_sha256.to_owned(),
        })
}

#[cfg(all(test, target_os = "linux"))]
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ReceiptError> {
    write_staging_with_limit(path, bytes, MAX_RECEIPT_BYTES)
}

#[cfg(all(test, target_os = "linux"))]
fn write_staging_with_limit(
    path: &Path,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<(), ReceiptError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let parent = path
        .parent()
        .ok_or(ReceiptError::UnsafeFilesystem("staging_parent"))?;
    let file_name = path
        .file_name()
        .ok_or(ReceiptError::UnsafeFilesystem("staging_name"))?;
    let directory = open_linux_directory(parent)
        .map_err(|_| ReceiptError::UnsafeFilesystem("staging_parent"))?;
    let file_name = CString::new(file_name.as_bytes())
        .map_err(|_| ReceiptError::UnsafeFilesystem("staging_name"))?;
    let file = create_linux_staging_at(&directory, &file_name)?;
    write_staging_file(file, bytes, maximum_bytes)
}

#[cfg(all(test, not(target_os = "linux")))]
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ReceiptError> {
    write_staging_with_limit(path, bytes, MAX_RECEIPT_BYTES)
}

#[cfg(not(target_os = "linux"))]
fn write_staging_with_limit(
    path: &Path,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<(), ReceiptError> {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| ReceiptError::Io("create_staging"))?;
    write_staging_file(file, bytes, maximum_bytes)
}

fn write_staging_file(
    mut file: fs::File,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<(), ReceiptError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(ReceiptError::InvalidField("staging_bytes"));
    }
    file.write_all(bytes)
        .map_err(|_| ReceiptError::Io("write_staging"))?;
    file.flush()
        .map_err(|_| ReceiptError::Io("flush_staging"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ReceiptError::Io("seek_staging"))?;
    let mut readback = Vec::with_capacity(bytes.len());
    Read::by_ref(&mut file)
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut readback)
        .map_err(|_| ReceiptError::Io("readback_staging"))?;
    if readback != bytes {
        return Err(ReceiptError::Conflict);
    }
    set_file_read_only(&file)?;
    file.sync_all()
        .map_err(|_| ReceiptError::Io("sync_staging"))
}

#[cfg(unix)]
fn set_file_read_only(file: &fs::File) -> Result<(), ReceiptError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o444))
        .map_err(|_| ReceiptError::Io("receipt_permissions"))
}

#[cfg(not(unix))]
fn set_file_read_only(file: &fs::File) -> Result<(), ReceiptError> {
    let mut permissions = file
        .metadata()
        .map_err(|_| ReceiptError::Io("receipt_permissions"))?
        .permissions();
    permissions.set_readonly(true);
    file.set_permissions(permissions)
        .map_err(|_| ReceiptError::Io("receipt_permissions"))
}

#[cfg(unix)]
fn set_chain_read_only(path: &Path) -> Result<(), ReceiptError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o555))
        .map_err(|_| ReceiptError::Io("chain_permissions"))
}

#[cfg(not(unix))]
fn set_chain_read_only(_path: &Path) -> Result<(), ReceiptError> {
    Ok(())
}

#[cfg(windows)]
fn publish_noreplace(staging: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::rename(staging, target)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn publish_noreplace(staging: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::hard_link(staging, target)?;
    fs::remove_file(staging)
}

#[cfg(not(any(unix, windows)))]
fn publish_noreplace(staging: &Path, target: &Path) -> Result<(), std::io::Error> {
    if target.try_exists()? {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    fs::rename(staging, target)
}

#[cfg(target_os = "linux")]
fn sync_directory(path: &Path, expected_sha256: &str) -> Result<(), ReceiptError> {
    open_linux_directory(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ReceiptError::DurabilityUnknown {
            expected_sha256: expected_sha256.to_owned(),
        })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn sync_directory(path: &Path, expected_sha256: &str) -> Result<(), ReceiptError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ReceiptError::DurabilityUnknown {
            expected_sha256: expected_sha256.to_owned(),
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path, _expected_sha256: &str) -> Result<(), ReceiptError> {
    // The production runner target is Linux. Windows exercises contract and replay semantics.
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_linux_directory(path: &Path) -> Result<fs::File, std::io::Error> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(descriptor) })
    }
}

#[cfg(target_os = "linux")]
fn open_linux_directory_at(
    parent: &fs::File,
    file_name: &std::ffi::CStr,
) -> Result<fs::File, std::io::Error> {
    open_linux_beneath(
        parent,
        file_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
}

#[cfg(target_os = "linux")]
fn open_linux_beneath(
    parent: &fs::File,
    path: &std::ffi::CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<fs::File, std::io::Error> {
    use std::mem::{size_of, zeroed};
    use std::os::fd::{AsRawFd, FromRawFd};

    // Linux requires unknown trailing open_how fields to remain zero.
    let mut how: libc::open_how = unsafe { zeroed() };
    how.flags = flags as u64;
    how.mode = mode as u64;
    how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_XDEV;
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            path.as_ptr(),
            &how,
            size_of::<libc::open_how>(),
        )
    };
    if descriptor < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(descriptor as libc::c_int) })
    }
}

#[cfg(target_os = "linux")]
fn lock_linux_directory(file: &fs::File, label: &'static str) -> Result<(), ReceiptError> {
    use std::os::fd::AsRawFd;

    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result != 0 {
        return Err(ReceiptError::Io(label));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn lock_operation_authorization(path: &Path) -> Result<LockedAuthorization, ReceiptError> {
    lock_operation_authorization_linux_with_hook(path, || {})
}

#[cfg(target_os = "linux")]
fn lock_operation_authorization_linux_with_hook<F>(
    path: &Path,
    after_locks: F,
) -> Result<LockedAuthorization, ReceiptError>
where
    F: FnOnce(),
{
    use std::os::unix::ffi::OsStrExt;

    let receipts_path = path
        .parent()
        .ok_or(ReceiptError::UnsafeFilesystem("operation_receipts_lock"))?
        .to_owned();
    let authorization_name = path.file_name().ok_or(ReceiptError::UnsafeFilesystem(
        "operation_authorization_lock",
    ))?;
    let authorization_name = std::ffi::CString::new(authorization_name.as_bytes())
        .map_err(|_| ReceiptError::UnsafeFilesystem("operation_authorization_lock"))?;

    let receipts = open_linux_directory(&receipts_path)
        .map_err(|_| ReceiptError::UnsafeFilesystem("operation_receipts_lock"))?;
    let receipts_identity = linux_directory_identity(&receipts, "operation_receipts_lock")?;
    lock_linux_directory(&receipts, "operation_receipts_lock")?;
    require_linux_directory_path_identity(
        &receipts_path,
        &receipts_identity,
        "operation_receipts_lock",
    )?;

    let authorization = open_linux_directory_at(&receipts, &authorization_name)
        .map_err(|_| ReceiptError::UnsafeFilesystem("operation_authorization_lock"))?;
    let authorization_identity =
        linux_directory_identity(&authorization, "operation_authorization_lock")?;
    lock_linux_directory(&authorization, "operation_authorization_lock")?;

    let locked = LockedAuthorization {
        receipts,
        authorization,
        receipts_path,
        authorization_path: path.to_owned(),
        authorization_name,
        receipts_identity,
        authorization_identity,
    };
    after_locks();
    locked.require_bound()?;
    Ok(locked)
}

#[cfg(not(target_os = "linux"))]
fn lock_operation_authorization(_path: &Path) -> Result<LockedAuthorization, ReceiptError> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .map(|guard| LockedAuthorization { _guard: guard })
        .map_err(|_| ReceiptError::Io("operation_authorization_lock"))
}

fn receipt_file_name(sequence: u64) -> String {
    format!("{sequence:020}{RECEIPT_FILE_SUFFIX}")
}

fn operation_receipt_file_name(sequence: u64) -> String {
    format!("{sequence:020}{OPERATION_RECEIPT_FILE_SUFFIX}")
}

fn operation_capacity_file_name(slot: usize) -> String {
    format!("{slot:03}{OPERATION_CAPACITY_FILE_SUFFIX}")
}

fn parse_operation_capacity_file_name(name: &str) -> Option<usize> {
    let prefix = name.strip_suffix(OPERATION_CAPACITY_FILE_SUFFIX)?;
    if prefix.len() != 3 || !prefix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let slot = prefix.parse::<usize>().ok()?;
    (slot < MAX_OPERATION_CHAINS_PER_AUTHORIZATION && name == operation_capacity_file_name(slot))
        .then_some(slot)
}

fn staging_file_name(sequence: u64) -> Result<String, ReceiptError> {
    let mut random = [0_u8; 16];
    getrandom(&mut random).map_err(|_| ReceiptError::Io("staging_random"))?;
    Ok(format!(
        ".{sequence:020}.{}.staging",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn validate_receipt_directory_entries(directory: &Path) -> Result<(), ReceiptError> {
    for entry in fs::read_dir(directory).map_err(|_| ReceiptError::Io("read_chain_directory"))? {
        let entry = entry.map_err(|_| ReceiptError::Io("read_chain_directory"))?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| ReceiptError::UnsafeFilesystem("chain_entry_name"))?;
        let valid_staging = valid_staging_file_name(&file_name, MAX_RECEIPTS_PER_CHAIN);
        let metadata = match read_directory_entry_metadata(&entry.path(), valid_staging)? {
            Some(metadata) => metadata,
            None => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ReceiptError::UnsafeFilesystem("chain_entry_type"));
        }
        if let Some(sequence) = parse_receipt_file_name(&file_name) {
            if sequence == 0 || sequence > MAX_RECEIPTS_PER_CHAIN {
                return Err(ReceiptError::InvalidField("receipt_sequence"));
            }
            continue;
        }
        if valid_staging {
            continue;
        }
        return Err(ReceiptError::UnsafeFilesystem("chain_entry_name"));
    }
    Ok(())
}

fn validate_operation_directory_entries(directory: &Path) -> Result<(), ReceiptError> {
    for entry in
        fs::read_dir(directory).map_err(|_| ReceiptError::Io("read_operation_directory"))?
    {
        let entry = entry.map_err(|_| ReceiptError::Io("read_operation_directory"))?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| ReceiptError::UnsafeFilesystem("operation_entry_name"))?;
        let valid_staging = valid_staging_file_name(&file_name, MAX_OPERATION_RECEIPTS_PER_CHAIN);
        if valid_staging {
            return Err(ReceiptError::UnsafeFilesystem("operation_receipt_staging"));
        }
        let metadata = match read_directory_entry_metadata(&entry.path(), false)? {
            Some(metadata) => metadata,
            None => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ReceiptError::UnsafeFilesystem("operation_entry_type"));
        }
        if let Some(sequence) = parse_operation_receipt_file_name(&file_name) {
            if sequence == 0 || sequence > MAX_OPERATION_RECEIPTS_PER_CHAIN {
                return Err(ReceiptError::InvalidField("operation_receipt_sequence"));
            }
            continue;
        }
        return Err(ReceiptError::UnsafeFilesystem("operation_entry_name"));
    }
    Ok(())
}

fn validate_operation_closure_directory_entries(directory: &Path) -> Result<(), ReceiptError> {
    for entry in
        fs::read_dir(directory).map_err(|_| ReceiptError::Io("read_operation_closure_directory"))?
    {
        let entry = entry.map_err(|_| ReceiptError::Io("read_operation_closure_directory"))?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| ReceiptError::UnsafeFilesystem("operation_closure_entry_name"))?;
        let valid_staging = valid_staging_file_name(&file_name, 2);
        if valid_staging {
            return Err(ReceiptError::UnsafeFilesystem("operation_closure_staging"));
        }
        let metadata = match read_directory_entry_metadata(&entry.path(), false)? {
            Some(metadata) => metadata,
            None => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ReceiptError::UnsafeFilesystem(
                "operation_closure_entry_type",
            ));
        }
        if file_name == OPERATION_HEAD_LOCAL_SEAL_FILE_NAME
            || file_name == TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME
        {
            continue;
        }
        return Err(ReceiptError::UnsafeFilesystem(
            "operation_closure_entry_name",
        ));
    }
    Ok(())
}

fn validate_operation_closures_root(directory: &Path) -> Result<(), ReceiptError> {
    for entry in fs::read_dir(directory)
        .map_err(|_| ReceiptError::Io("read_operation_closures_directory"))?
    {
        let entry = entry.map_err(|_| ReceiptError::Io("read_operation_closures_directory"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| ReceiptError::UnsafeFilesystem("operation_closure_name"))?;
        validate_lower_hex(&name, "operation_closure_authorization_id")?;
        require_fixed_directory(
            &entry.path(),
            directory,
            "operation_authorization_closure_directory",
        )?;
    }
    Ok(())
}

fn read_directory_entry_metadata(
    path: &Path,
    transient_staging: bool,
) -> Result<Option<fs::Metadata>, ReceiptError> {
    for attempt in 0..8 {
        match fs::symlink_metadata(path) {
            Ok(metadata) => return Ok(Some(metadata)),
            Err(error) if transient_staging && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error)
                if transient_staging
                    && attempt < 7
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(_) => {
                return Err(ReceiptError::UnsafeFilesystem("chain_entry_metadata"));
            }
        }
    }
    Err(ReceiptError::UnsafeFilesystem("chain_entry_metadata"))
}

fn parse_receipt_file_name(file_name: &str) -> Option<u64> {
    let digits = file_name.strip_suffix(RECEIPT_FILE_SUFFIX)?;
    if digits.len() != 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn parse_operation_receipt_file_name(file_name: &str) -> Option<u64> {
    let digits = file_name.strip_suffix(OPERATION_RECEIPT_FILE_SUFFIX)?;
    if digits.len() != 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn valid_staging_file_name(file_name: &str, maximum_sequence: u64) -> bool {
    let Some(value) = file_name
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".staging"))
    else {
        return false;
    };
    let Some((sequence, random)) = value.split_once('.') else {
        return false;
    };
    let sequence_valid = sequence
        .parse::<u64>()
        .is_ok_and(|value| value > 0 && value <= maximum_sequence);
    sequence.len() == 20
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
        && sequence_valid
        && random.len() == 32
        && random
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn has_future_receipt(directory: &Path, start: u64) -> Result<bool, ReceiptError> {
    for sequence in start..=MAX_RECEIPTS_PER_CHAIN {
        if directory
            .join(receipt_file_name(sequence))
            .try_exists()
            .map_err(|_| ReceiptError::Io("future_receipt"))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn has_future_operation_receipt(directory: &Path, start: u64) -> Result<bool, ReceiptError> {
    for sequence in start..=MAX_OPERATION_RECEIPTS_PER_CHAIN {
        if directory
            .join(operation_receipt_file_name(sequence))
            .try_exists()
            .map_err(|_| ReceiptError::Io("operation_future_receipt"))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_lower_hex(value: &str, field: &'static str) -> Result<(), ReceiptError> {
    validate_lower_hex_length(value, 64, field)
}

fn validate_lower_hex_length(
    value: &str,
    length: usize,
    field: &'static str,
) -> Result<(), ReceiptError> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ReceiptError::InvalidField(field));
    }
    Ok(())
}

fn validate_token(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<(), ReceiptError> {
    if value.len() < minimum
        || value.len() > maximum
        || !value.is_ascii()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err(ReceiptError::InvalidField(field));
    }
    Ok(())
}

fn validate_service_name(value: &str, field: &'static str) -> Result<(), ReceiptError> {
    if value.len() > 63
        || value.is_empty()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
    {
        return Err(ReceiptError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_new_chain_is_exactly_replayable_and_conflicts_fail_closed() {
        let root = temporary_root("replay");
        let plan = synthetic_plan();
        let store = ReceiptStore::open(&root).unwrap();

        let created = store.install_terminal_plan(&plan).unwrap();
        assert_eq!(created.created_count, 3);
        assert_eq!(created.replayed_count, 0);
        assert_eq!(created.head_sha256, plan.head_sha256());

        let replayed = store.install_terminal_plan(&plan).unwrap();
        assert_eq!(replayed.created_count, 0);
        assert_eq!(replayed.replayed_count, 3);
        assert_eq!(
            store
                .verify(plan.authorization_id_sha256())
                .unwrap()
                .head_sha256,
            plan.head_sha256()
        );

        let first = created.chain_directory.join(receipt_file_name(1));
        make_writable(&first);
        fs::write(&first, b"{}").unwrap();
        assert!(store.install_terminal_plan(&plan).is_err());
        cleanup(&root);
    }

    #[test]
    fn unsealed_prefix_extends_exactly_and_never_satisfies_terminal_verification() {
        let root = temporary_root("prefix");
        let terminal = synthetic_plan();
        let mut genesis = terminal.clone();
        genesis.receipts.truncate(1);
        validate_planned_prefix(genesis.receipts()).unwrap();
        assert!(!genesis.is_sealed());

        let store = ReceiptStore::open(&root).unwrap();
        let first = store.install_snapshot_plan(&genesis).unwrap();
        assert_eq!(first.created_count, 1);
        assert_eq!(first.replayed_count, 0);
        assert_eq!(first.receipt_count, 1);
        assert!(!first.sealed);
        assert_eq!(
            store.verify(genesis.authorization_id_sha256()),
            Err(ReceiptError::NotSealed)
        );
        assert_eq!(
            store
                .verify_prefix(genesis.authorization_id_sha256())
                .unwrap()
                .head_sha256,
            genesis.head_sha256()
        );

        let replay = store.install_snapshot_plan(&genesis).unwrap();
        assert_eq!(replay.created_count, 0);
        assert_eq!(replay.replayed_count, 1);

        let sealed = store.install_terminal_plan(&terminal).unwrap();
        assert_eq!(sealed.created_count, 2);
        assert_eq!(sealed.replayed_count, 1);
        assert!(sealed.sealed);
        assert_eq!(sealed.receipt_count, 3);
        assert_eq!(
            store
                .verify(terminal.authorization_id_sha256())
                .unwrap()
                .head_sha256,
            terminal.head_sha256()
        );
        cleanup(&root);
    }

    #[test]
    fn concurrent_genesis_prefix_has_one_create_and_exact_replays_only() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root = temporary_root("concurrent-prefix");
        let terminal = synthetic_plan();
        let mut genesis = terminal.clone();
        genesis.receipts.truncate(1);
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let root = root.clone();
            let plan = genesis.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                let store = ReceiptStore::open(&root).unwrap();
                barrier.wait();
                store.install_snapshot_plan(&plan)
            }));
        }

        let installed = workers
            .into_iter()
            .map(|worker| worker.join().expect("prefix worker"))
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            installed
                .iter()
                .map(|result| result.created_count)
                .sum::<u64>(),
            1
        );
        assert_eq!(
            installed
                .iter()
                .map(|result| result.replayed_count)
                .sum::<u64>(),
            7
        );
        let verified = ReceiptStore::open(&root)
            .unwrap()
            .verify_prefix(genesis.authorization_id_sha256())
            .unwrap();
        assert_eq!(verified.receipt_count, 1);
        assert_eq!(verified.head_sha256, genesis.head_sha256());
        assert!(!verified.sealed);
        cleanup(&root);
    }

    #[test]
    fn operation_start_is_deterministic_single_writer_and_finish_is_first_terminal_wins() {
        let root = temporary_root("operation");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );

        let mut replay = start.clone();
        replay.request_id_sha256 = "b".repeat(64);
        replay.started_at += 1;
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &replay)
                .unwrap(),
            OperationReservation::ExistingUnfinished
        );

        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        assert_eq!(
            operation.operation_id_sha256,
            "9e499bf7a66322d55ebc9104845bd79d26f9585185a24926f61d49a65b604544"
        );
        assert_eq!(
            store
                .verify_operation(
                    activation.authorization_id_sha256(),
                    &operation.operation_id_sha256,
                )
                .unwrap()
                .head_sha256,
            "4ca2eb642f701c9c201f3835f0d2d1431620d4ec951ca573c0a9714bfd377ece"
        );
        let accepted = OperationFinishInput {
            outcome: OperationOutcome::Accepted,
            finished_at: NOW + 1,
            http_status: Some(201),
            response_body_sha256: Some("c".repeat(64)),
            response_id_sha256: Some("d".repeat(64)),
        };
        assert_eq!(
            store
                .finish_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &start.identity,
                    &accepted,
                )
                .unwrap(),
            OperationOutcome::Accepted
        );
        let verified = store
            .verify_operation(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();
        assert_eq!(verified.receipt_count, 2);
        assert_eq!(
            verified.head_sha256,
            "14869d3a336dcf7dca017aba41d2232ce6ead0a9dcef9e1f4feee3f7698eb0c4"
        );
        assert_eq!(verified.outcome, Some(OperationOutcome::Accepted));

        let ambiguous = OperationFinishInput {
            outcome: OperationOutcome::Ambiguous,
            finished_at: NOW + 2,
            http_status: None,
            response_body_sha256: None,
            response_id_sha256: None,
        };
        assert_eq!(
            store
                .finish_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &replay.identity,
                    &ambiguous,
                )
                .unwrap(),
            OperationOutcome::Accepted
        );
        cleanup(&root);
    }

    #[test]
    fn read_operation_binds_request_id_uses_get_and_may_finish_after_claim_expiry() {
        let root = temporary_root("read-operation");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let target_sha256 = "a".repeat(64);
        let request_id_sha256 = "e".repeat(64);
        let request_sha256 =
            read_operation_request_sha256(&target_sha256, &request_id_sha256).unwrap();
        let start = OperationStartInput {
            identity: OperationIdentityInput {
                kind: OperationKind::AuthorityClaimRead,
                state_version: 0,
                target_sha256,
                request_sha256: request_sha256.clone(),
            },
            request_id_sha256,
            started_at: NOW + 301,
        };
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        assert_eq!(operation.method, "GET");
        assert_eq!(
            request_sha256,
            "6344097a6f022e09b2589e570e92bcaff8df407f56edfe85e32c7c29e55dba7d"
        );
        assert_eq!(
            operation.operation_id_sha256,
            "468efe016ebf4ec7a517c6213cab5d861b27c46eaea89329251c1b42d0aaa230"
        );
        let started = store
            .verify_operation(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();
        assert_eq!(started.receipt_count, 1);
        assert_eq!(started.outcome, None);
        assert_eq!(
            started.head_sha256,
            "070c862e67b2f0a4aba4273d1f2fe3f0abac75462469a962aabacdc7d0fd6dbf"
        );

        assert_eq!(
            store
                .finish_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &start.identity,
                    &OperationFinishInput {
                        outcome: OperationOutcome::Accepted,
                        finished_at: NOW + 302,
                        http_status: Some(200),
                        response_body_sha256: Some("c".repeat(64)),
                        response_id_sha256: Some("d".repeat(64)),
                    },
                )
                .unwrap(),
            OperationOutcome::Accepted
        );

        for (kind, request_nibble, started_at) in [
            (
                OperationKind::AuthorityClaimRead,
                "f",
                activation.claim_expires_at() + READ_OPERATION_RECOVERY_WINDOW_SECONDS + 1,
            ),
            (
                OperationKind::CloudflareDeploymentRead,
                "9",
                activation.claim_expires_at(),
            ),
        ] {
            let request_id_sha256 = request_nibble.repeat(64);
            let target_sha256 = "b".repeat(64);
            let request_sha256 =
                read_operation_request_sha256(&target_sha256, &request_id_sha256).unwrap();
            assert!(matches!(
                store.reserve_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &OperationStartInput {
                        identity: OperationIdentityInput {
                            kind,
                            state_version: if kind == OperationKind::CloudflareDeploymentRead {
                                1
                            } else {
                                0
                            },
                            target_sha256,
                            request_sha256,
                        },
                        request_id_sha256,
                        started_at,
                    },
                ),
                Err(ReceiptError::InvalidField("operation_start_time"))
            ));
        }
        cleanup(&root);
    }

    #[test]
    fn operation_capacity_fails_the_129th_reservation_before_authority_progress() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root = temporary_root("operation-capacity");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let target_sha256 = "a".repeat(64);

        for index in 0..(MAX_OPERATION_CHAINS_PER_AUTHORIZATION - 1) {
            let request_id_sha256 = sha256_hex(format!("read-{index}").as_bytes());
            let request_sha256 =
                read_operation_request_sha256(&target_sha256, &request_id_sha256).unwrap();
            assert_eq!(
                store
                    .reserve_operation(
                        &publication,
                        &credentials,
                        &activation,
                        &OperationStartInput {
                            identity: OperationIdentityInput {
                                kind: OperationKind::AuthorityClaimRead,
                                state_version: 0,
                                target_sha256: target_sha256.clone(),
                                request_sha256,
                            },
                            request_id_sha256,
                            started_at: NOW,
                        },
                    )
                    .unwrap(),
                OperationReservation::Fresh
            );
        }

        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for index in 0..8 {
            let root = root.clone();
            let publication = publication.clone();
            let credentials = credentials.clone();
            let activation = activation.clone();
            let target_sha256 = target_sha256.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                let store = ReceiptStore::open(&root).unwrap();
                let request_id_sha256 = sha256_hex(format!("boundary-read-{index}").as_bytes());
                let request_sha256 =
                    read_operation_request_sha256(&target_sha256, &request_id_sha256).unwrap();
                barrier.wait();
                store.reserve_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &OperationStartInput {
                        identity: OperationIdentityInput {
                            kind: OperationKind::AuthorityClaimRead,
                            state_version: 0,
                            target_sha256,
                            request_sha256,
                        },
                        request_id_sha256,
                        started_at: NOW,
                    },
                )
            }));
        }
        let reservations = workers
            .into_iter()
            .map(|worker| worker.join().expect("capacity worker"))
            .collect::<Vec<_>>();
        let fresh_count = reservations
            .iter()
            .filter(|result| matches!(result, Ok(OperationReservation::Fresh)))
            .count();
        assert_eq!(fresh_count, 1);
        assert!(reservations.iter().all(|result| {
            matches!(
                result,
                Ok(OperationReservation::Fresh)
                    | Err(ReceiptError::InvalidField("operation_chain_count"))
            )
        }));
        let audit = store
            .audit_authorization_operations(&publication, &credentials, &activation)
            .unwrap();
        assert_eq!(
            audit.operation_count,
            MAX_OPERATION_CHAINS_PER_AUTHORIZATION
        );

        let request_id_sha256 = sha256_hex(b"read-over-capacity");
        let request_sha256 =
            read_operation_request_sha256(&target_sha256, &request_id_sha256).unwrap();
        assert!(matches!(
            store.reserve_operation(
                &publication,
                &credentials,
                &activation,
                &OperationStartInput {
                    identity: OperationIdentityInput {
                        kind: OperationKind::AuthorityClaimRead,
                        state_version: 0,
                        target_sha256,
                        request_sha256,
                    },
                    request_id_sha256,
                    started_at: NOW,
                },
            ),
            Err(ReceiptError::InvalidField("operation_chain_count"))
        ));
        let audit = store
            .audit_authorization_operations(&publication, &credentials, &activation)
            .unwrap();
        assert_eq!(
            audit.operation_count,
            MAX_OPERATION_CHAINS_PER_AUTHORIZATION
        );
        assert_eq!(
            store
                .authorization_operation_ids(activation.authorization_id_sha256())
                .unwrap()
                .1
                .len(),
            MAX_OPERATION_CHAINS_PER_AUTHORIZATION
        );
        assert_eq!(
            store
                .authorization_operation_ids(activation.authorization_id_sha256())
                .unwrap()
                .2
                .len(),
            MAX_OPERATION_CHAINS_PER_AUTHORIZATION
        );
        cleanup(&root);
    }

    #[test]
    fn stranded_capacity_staging_fails_closed_before_creating_an_operation_directory() {
        let root = temporary_root("operation-capacity-crash");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let authorization = store
            .ensure_operation_authorization_directory(activation.authorization_id_sha256())
            .unwrap();
        for index in 0..MAX_OPERATION_CHAINS_PER_AUTHORIZATION {
            reserve_operation_capacity(
                &authorization,
                &sha256_hex(format!("stranded-capacity-{index}").as_bytes()),
            )
            .unwrap();
        }
        fs::write(
            authorization.join(staging_file_name(1).unwrap()),
            b"interrupted-capacity-staging",
        )
        .unwrap();

        assert!(matches!(
            store.reserve_operation(
                &publication,
                &credentials,
                &activation,
                &operation_start("a", NOW),
            ),
            Err(ReceiptError::InvalidField("operation_chain_count"))
                | Err(ReceiptError::UnsafeFilesystem("operation_capacity_staging"))
        ));
        assert_eq!(
            store.authorization_operation_ids(activation.authorization_id_sha256()),
            Err(ReceiptError::UnsafeFilesystem("operation_capacity_staging"))
        );
        assert_eq!(
            store.audit_authorization_operations(&publication, &credentials, &activation),
            Err(ReceiptError::UnsafeFilesystem("operation_capacity_staging"))
        );
        cleanup(&root);

        let root = temporary_root("operation-capacity-empty-directory");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        let authorization = store
            .ensure_operation_authorization_directory(activation.authorization_id_sha256())
            .unwrap();
        reserve_operation_capacity(&authorization, &operation.operation_id_sha256).unwrap();
        store
            .ensure_operation_directory(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();

        assert_eq!(
            store
                .audit_authorization_operations(&publication, &credentials, &activation)
                .unwrap()
                .operation_count,
            0
        );
        assert_eq!(
            store
                .recover_unfinished_operations(&publication, &credentials, &activation, NOW + 1)
                .unwrap()
                .recovered_ambiguous_count,
            0
        );
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );
        assert_eq!(
            store
                .audit_authorization_operations(&publication, &credentials, &activation)
                .unwrap()
                .operation_count,
            1
        );
        cleanup(&root);
    }

    #[test]
    fn operation_receipts_reject_canonical_identity_tampering_and_future_slots() {
        let root = temporary_root("operation-tamper");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        let operation_directory = store
            .operation_directory(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();
        let start_path = operation_directory.join(operation_receipt_file_name(1));
        make_writable(&start_path);
        let start_bytes = fs::read(&start_path).unwrap();
        let mut start_record: OperationReceipt =
            parse_canonical_json(&start_bytes, MAX_RECEIPT_BYTES, "operation_receipt").unwrap();
        start_record.operation.operation_id_sha256 = "f".repeat(64);
        fs::write(
            &start_path,
            canonical_json(&start_record).unwrap().as_bytes(),
        )
        .unwrap();
        assert!(store
            .verify_operation(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .is_err());
        cleanup(&root);

        let root = temporary_root("operation-future-slot");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        store
            .reserve_operation(&publication, &credentials, &activation, &start)
            .unwrap();
        store
            .finish_operation(
                &publication,
                &credentials,
                &activation,
                &start.identity,
                &OperationFinishInput {
                    outcome: OperationOutcome::Ambiguous,
                    finished_at: NOW + 1,
                    http_status: None,
                    response_body_sha256: None,
                    response_id_sha256: None,
                },
            )
            .unwrap();
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        let operation_directory = store
            .operation_directory(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();
        make_directory_writable(&operation_directory);
        fs::write(
            operation_directory.join(operation_receipt_file_name(3)),
            b"{}",
        )
        .unwrap();
        assert!(store
            .verify_operation(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .is_err());
        cleanup(&root);

        for (kind, outcome, status, field) in [
            (
                OperationKind::AuthorityClaimRead,
                OperationOutcome::Accepted,
                201,
                "operation_accepted_status",
            ),
            (
                OperationKind::AuthorityClaimRead,
                OperationOutcome::Rejected,
                408,
                "operation_rejected_status",
            ),
            (
                OperationKind::AuthorityClaimRead,
                OperationOutcome::Rejected,
                425,
                "operation_rejected_status",
            ),
            (
                OperationKind::AuthorityClaimRead,
                OperationOutcome::Rejected,
                429,
                "operation_rejected_status",
            ),
            (
                OperationKind::AuthorityStepAppend,
                OperationOutcome::Rejected,
                409,
                "operation_rejected_status",
            ),
        ] {
            assert_eq!(
                validate_operation_finish_input(
                    kind,
                    &OperationFinishInput {
                        outcome,
                        finished_at: NOW + 1,
                        http_status: Some(status),
                        response_body_sha256: None,
                        response_id_sha256: None,
                    },
                    NOW,
                ),
                Err(ReceiptError::InvalidField(field))
            );
        }
        assert!(validate_operation_finish_input(
            OperationKind::CloudflareDeployment,
            &OperationFinishInput {
                outcome: OperationOutcome::Rejected,
                finished_at: NOW + 1,
                http_status: Some(409),
                response_body_sha256: None,
                response_id_sha256: None,
            },
            NOW,
        )
        .is_ok());
    }

    #[test]
    fn concurrent_operation_reservation_mints_exactly_one_send_capability() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root = temporary_root("operation-race");
        let (publication, credentials, activation) = operation_context();
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for index in 0..8_u8 {
            let root = root.clone();
            let publication = publication.clone();
            let credentials = credentials.clone();
            let activation = activation.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                let store = ReceiptStore::open(&root).unwrap();
                let start = operation_start(&format!("{index:x}"), NOW + u64::from(index));
                barrier.wait();
                store.reserve_operation(&publication, &credentials, &activation, &start)
            }));
        }
        let reservations = workers
            .into_iter()
            .map(|worker| worker.join().expect("operation worker"))
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            reservations
                .iter()
                .filter(|reservation| **reservation == OperationReservation::Fresh)
                .count(),
            1
        );
        assert_eq!(
            reservations
                .iter()
                .filter(|reservation| { **reservation == OperationReservation::ExistingUnfinished })
                .count(),
            7
        );
        cleanup(&root);
    }

    #[test]
    fn unfinished_operation_is_recovered_as_ambiguous_without_creating_absent_start() {
        let root = temporary_root("operation-recovery");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("e", NOW);
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );
        let ambiguous = OperationFinishInput {
            outcome: OperationOutcome::Ambiguous,
            finished_at: NOW + 1,
            http_status: None,
            response_body_sha256: None,
            response_id_sha256: None,
        };
        assert_eq!(
            store
                .finish_unresolved_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &start.identity,
                    &ambiguous,
                )
                .unwrap(),
            Some(OperationOutcome::Ambiguous)
        );

        let mut absent = start.identity.clone();
        absent.request_sha256 = "f".repeat(64);
        assert_eq!(
            store
                .finish_unresolved_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &absent,
                    &ambiguous,
                )
                .unwrap(),
            None
        );
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let absent_id = project_operation_identity(&context, &absent)
            .unwrap()
            .operation_id_sha256;
        assert_eq!(
            store.verify_operation(activation.authorization_id_sha256(), &absent_id),
            Err(ReceiptError::PredecessorMissing)
        );
        cleanup(&root);
    }

    #[test]
    fn authorization_operation_audit_recovers_every_unfinished_start_once() {
        let root = temporary_root("operation-authorization-recovery");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        assert_eq!(
            store
                .audit_authorization_operations(&publication, &credentials, &activation)
                .unwrap(),
            OperationReceiptAudit {
                operation_count: 0,
                unfinished_count: 0,
                recovered_ambiguous_count: 0,
            }
        );

        let finished = operation_start("a", NOW);
        store
            .reserve_operation(&publication, &credentials, &activation, &finished)
            .unwrap();
        store
            .finish_operation(
                &publication,
                &credentials,
                &activation,
                &finished.identity,
                &OperationFinishInput {
                    outcome: OperationOutcome::Accepted,
                    finished_at: NOW + 1,
                    http_status: Some(201),
                    response_body_sha256: Some("c".repeat(64)),
                    response_id_sha256: Some("d".repeat(64)),
                },
            )
            .unwrap();

        let mut unfinished = operation_start("e", NOW + 2);
        unfinished.identity.state_version = 2;
        unfinished.identity.request_sha256 = "f".repeat(64);
        store
            .reserve_operation(&publication, &credentials, &activation, &unfinished)
            .unwrap();
        assert_eq!(
            store
                .audit_authorization_operations(&publication, &credentials, &activation)
                .unwrap(),
            OperationReceiptAudit {
                operation_count: 2,
                unfinished_count: 1,
                recovered_ambiguous_count: 0,
            }
        );

        assert_eq!(
            store
                .recover_unfinished_operations(&publication, &credentials, &activation, NOW + 3,)
                .unwrap(),
            OperationReceiptAudit {
                operation_count: 2,
                unfinished_count: 1,
                recovered_ambiguous_count: 1,
            }
        );
        assert_eq!(
            store
                .recover_unfinished_operations(&publication, &credentials, &activation, NOW + 4,)
                .unwrap(),
            OperationReceiptAudit {
                operation_count: 2,
                unfinished_count: 0,
                recovered_ambiguous_count: 0,
            }
        );

        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &unfinished.identity).unwrap();
        assert_eq!(
            store
                .verify_operation(
                    activation.authorization_id_sha256(),
                    &operation.operation_id_sha256,
                )
                .unwrap()
                .outcome,
            Some(OperationOutcome::Ambiguous)
        );
        cleanup(&root);
    }

    #[test]
    fn predecessor_gaps_and_post_seal_files_are_rejected() {
        let root = temporary_root("gap");
        let plan = synthetic_plan();
        let store = ReceiptStore::open(&root).unwrap();
        let chain = store
            .ensure_chain_directory(plan.authorization_id_sha256())
            .unwrap();
        let second = &plan.receipts()[1];
        write_staging(&chain.join(receipt_file_name(2)), second.bytes()).unwrap();
        assert_eq!(store.install_terminal_plan(&plan), Err(ReceiptError::Gap));
        cleanup(&root);

        let root = temporary_root("sealed");
        let store = ReceiptStore::open(&root).unwrap();
        let installed = store.install_terminal_plan(&plan).unwrap();
        let mut extra = plan.receipts()[1].record().clone();
        extra.sequence = 4;
        extra.predecessor_receipt_sha256 = Some(plan.head_sha256().to_owned());
        extra.event = ReceiptEvent::ClaimObserved {
            status: ClaimStatus::Claimed,
            state_version: 0,
        };
        let bytes = canonical_json(&extra).unwrap().into_bytes();
        make_directory_writable(&installed.chain_directory);
        fs::write(installed.chain_directory.join(receipt_file_name(4)), bytes).unwrap();
        assert_eq!(
            store.verify(plan.authorization_id_sha256()),
            Err(ReceiptError::AlreadySealed)
        );
        cleanup(&root);

        let root = temporary_root("overbound");
        let store = ReceiptStore::open(&root).unwrap();
        let installed = store.install_terminal_plan(&plan).unwrap();
        make_directory_writable(&installed.chain_directory);
        fs::write(
            installed
                .chain_directory
                .join(receipt_file_name(MAX_RECEIPTS_PER_CHAIN + 1)),
            plan.receipts()[0].bytes(),
        )
        .unwrap();
        assert_eq!(
            store.verify(plan.authorization_id_sha256()),
            Err(ReceiptError::InvalidField("receipt_sequence"))
        );
        cleanup(&root);
    }

    #[test]
    fn noncanonical_and_linked_receipts_are_rejected() {
        let root = temporary_root("canonical");
        let plan = synthetic_plan();
        let store = ReceiptStore::open(&root).unwrap();
        let chain = store
            .ensure_chain_directory(plan.authorization_id_sha256())
            .unwrap();
        let mut noncanonical = plan.receipts()[0].bytes().to_vec();
        noncanonical.push(b'\n');
        fs::write(chain.join(receipt_file_name(1)), noncanonical).unwrap();
        assert_eq!(
            store.verify(plan.authorization_id_sha256()),
            Err(ReceiptError::NonCanonicalJson)
        );
        cleanup(&root);
    }

    #[test]
    fn semantic_step_digest_and_identity_drift_are_rejected_before_io() {
        let mut plan = synthetic_plan();
        if let ReceiptEvent::AuthorityStep { step } = &mut plan.receipts[1].record.event {
            step.step_digest_sha256 = "f".repeat(64);
        } else {
            panic!("synthetic plan must contain an Authority step");
        }
        assert_eq!(
            validate_planned_chain(&plan.receipts),
            Err(ReceiptError::InvalidField("authority_step"))
        );

        let mut plan = synthetic_plan();
        plan.receipts[1].record.release.source_commit = "not-a-commit".to_owned();
        assert_eq!(
            validate_planned_chain(&plan.receipts),
            Err(ReceiptError::InvalidField("source_commit"))
        );
    }

    #[test]
    fn terminal_closure_binds_terminal_operations_and_marker_only_capacity() {
        let root = temporary_root("terminal-closure");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        assert_eq!(
            store
                .reserve_operation(&publication, &credentials, &activation, &start)
                .unwrap(),
            OperationReservation::Fresh
        );
        assert_eq!(
            store
                .finish_operation(
                    &publication,
                    &credentials,
                    &activation,
                    &start.identity,
                    &OperationFinishInput {
                        outcome: OperationOutcome::Accepted,
                        finished_at: NOW + 1,
                        http_status: Some(200),
                        response_body_sha256: Some("a".repeat(64)),
                        response_id_sha256: Some("b".repeat(64)),
                    },
                )
                .unwrap(),
            OperationOutcome::Accepted
        );
        let authorization = store
            .ensure_operation_authorization_directory(activation.authorization_id_sha256())
            .unwrap();
        let mut marker_only_start = operation_start("b", NOW + 2);
        marker_only_start.identity.target_sha256 = "e".repeat(64);
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let marker_only_operation =
            project_operation_identity(&context, &marker_only_start.identity).unwrap();
        reserve_operation_capacity(&authorization, &marker_only_operation.operation_id_sha256)
            .unwrap();
        let _marker_only_directory = store
            .ensure_operation_directory(
                activation.authorization_id_sha256(),
                &marker_only_operation.operation_id_sha256,
            )
            .unwrap();

        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        let closure = store
            .install_terminal_closure(&plan, &publication, &credentials, &activation)
            .unwrap();
        assert_eq!(closure.terminal_status, ClaimStatus::Aborted);
        assert_eq!(closure.terminal_state_version, 1);
        assert_eq!(closure.execution_receipt_head_sha256, plan.head_sha256());

        let head_set = read_operation_head_set(
            &authorization.join(OPERATION_HEAD_SET_FILE_NAME),
            &authorization,
        )
        .unwrap();
        assert_eq!(head_set.record.operation_count, 1);
        assert_eq!(head_set.record.capacity_reservation_count, 2);
        assert_eq!(head_set.record.marker_only_count, 1);
        assert!(head_set
            .record
            .entries
            .windows(2)
            .all(|window| window[0].slot < window[1].slot));
        assert!(head_set.record.entries.iter().any(|entry| {
            entry.chain_state == OperationHeadSetChainState::Terminal
                && entry.receipt_count == 2
                && entry.start_receipt_sha256.is_some()
                && entry.head_sha256.is_some()
                && entry.outcome == Some(OperationOutcome::Accepted)
        }));
        assert!(head_set.record.entries.iter().any(|entry| {
            entry.chain_state == OperationHeadSetChainState::MarkerOnly
                && entry.receipt_count == 0
                && entry.start_receipt_sha256.is_none()
                && entry.head_sha256.is_none()
                && entry.outcome.is_none()
        }));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&_marker_only_directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o555
            );
        }

        let replay = store
            .recover_terminal_closure(&publication, &credentials, &activation)
            .unwrap()
            .unwrap();
        assert_eq!(replay, closure);
        assert_eq!(
            store.reserve_operation(&publication, &credentials, &activation, &start),
            Err(ReceiptError::AlreadySealed)
        );
        assert_eq!(
            store.reserve_operation(&publication, &credentials, &activation, &marker_only_start),
            Err(ReceiptError::AlreadySealed)
        );
        assert_eq!(
            store.finish_operation(
                &publication,
                &credentials,
                &activation,
                &start.identity,
                &OperationFinishInput {
                    outcome: OperationOutcome::Accepted,
                    finished_at: NOW + 2,
                    http_status: Some(200),
                    response_body_sha256: Some("a".repeat(64)),
                    response_id_sha256: Some("b".repeat(64)),
                },
            ),
            Err(ReceiptError::AlreadySealed)
        );
        cleanup(&root);
    }

    #[test]
    fn terminal_snapshot_candidate_closes_the_accepted_read_crash_window_locally() {
        let root = temporary_root("terminal-candidate-recovery");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation, snapshot) = terminal_snapshot_context();
        let mut read = operation_start("a", NOW);
        read.identity.kind = OperationKind::AuthorityClaimRead;
        read.identity.state_version = 0;
        read.identity.request_sha256 =
            read_operation_request_sha256(&read.identity.target_sha256, &read.request_id_sha256)
                .unwrap();
        store
            .reserve_operation(&publication, &credentials, &activation, &read)
            .unwrap();
        let accepted = OperationFinishInput {
            outcome: OperationOutcome::Accepted,
            finished_at: NOW + 1,
            http_status: Some(200),
            response_body_sha256: Some("a".repeat(64)),
            response_id_sha256: Some("b".repeat(64)),
        };
        store
            .install_terminal_snapshot_candidate(
                &snapshot,
                &publication,
                &credentials,
                &activation,
                &read.identity,
                &accepted,
            )
            .unwrap();
        assert_eq!(
            store.reserve_operation(
                &publication,
                &credentials,
                &activation,
                &operation_start("b", NOW + 1),
            ),
            Err(ReceiptError::AlreadySealed)
        );
        assert_eq!(
            store.finish_operation(
                &publication,
                &credentials,
                &activation,
                &read.identity,
                &accepted,
            ),
            Err(ReceiptError::AlreadySealed)
        );

        let recovery = store
            .recover_unfinished_operations(&publication, &credentials, &activation, NOW + 2)
            .unwrap();
        assert_eq!(recovery.unfinished_count, 1);
        assert_eq!(recovery.recovered_ambiguous_count, 0);
        let closure = store
            .recover_terminal_closure(&publication, &credentials, &activation)
            .unwrap()
            .unwrap();
        let plan = plan_terminal_receipts(&snapshot, &publication, &credentials).unwrap();
        assert_eq!(closure.execution_receipt_head_sha256, plan.head_sha256());
        assert_eq!(closure.terminal_status, ClaimStatus::Aborted);
        assert_eq!(closure.terminal_state_version, 1);
        assert_eq!(
            store
                .verify_operation(
                    activation.authorization_id_sha256(),
                    &project_operation_identity(
                        &project_operation_context(&publication, &credentials, &activation)
                            .unwrap(),
                        &read.identity,
                    )
                    .unwrap()
                    .operation_id_sha256,
                )
                .unwrap()
                .outcome,
            Some(OperationOutcome::Accepted)
        );
        cleanup(&root);
    }

    #[test]
    fn terminal_snapshot_candidate_finishes_only_the_accepted_claim_read() {
        let root = temporary_root("terminal-candidate-finish");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation, snapshot) = terminal_snapshot_context();
        let mut read = operation_start("a", NOW);
        read.identity.kind = OperationKind::AuthorityClaimRead;
        read.identity.state_version = 0;
        read.identity.request_sha256 =
            read_operation_request_sha256(&read.identity.target_sha256, &read.request_id_sha256)
                .unwrap();
        store
            .reserve_operation(&publication, &credentials, &activation, &read)
            .unwrap();
        let accepted = OperationFinishInput {
            outcome: OperationOutcome::Accepted,
            finished_at: NOW + 1,
            http_status: Some(200),
            response_body_sha256: Some("a".repeat(64)),
            response_id_sha256: Some("b".repeat(64)),
        };
        store
            .install_terminal_snapshot_candidate(
                &snapshot,
                &publication,
                &credentials,
                &activation,
                &read.identity,
                &accepted,
            )
            .unwrap();
        assert_eq!(
            store
                .finish_operation_after_terminal_candidate(
                    &publication,
                    &credentials,
                    &activation,
                    &read.identity,
                    &accepted,
                )
                .unwrap(),
            OperationOutcome::Accepted
        );
        let plan = plan_terminal_receipts(&snapshot, &publication, &credentials).unwrap();
        let closure = store
            .install_terminal_closure(&plan, &publication, &credentials, &activation)
            .unwrap();
        assert_eq!(closure.execution_receipt_head_sha256, plan.head_sha256());
        let closure_directory = root
            .join(OPERATION_CLOSURES_DIRECTORY_NAME)
            .join(activation.authorization_id_sha256());
        let canonical_closure_directory = fs::canonicalize(&closure_directory).unwrap();
        let candidate = read_terminal_snapshot_candidate(
            &closure_directory.join(TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME),
            &canonical_closure_directory,
            &project_operation_context(&publication, &credentials, &activation).unwrap(),
        )
        .unwrap();
        let local_seal = read_operation_head_local_seal(
            &closure_directory.join(OPERATION_HEAD_LOCAL_SEAL_FILE_NAME),
            &canonical_closure_directory,
        )
        .unwrap();
        assert_eq!(
            local_seal.record.terminal_snapshot_candidate_sha256,
            Some(candidate.sha256)
        );
        assert_eq!(
            local_seal.record.terminal_candidate_operation_id_sha256,
            Some(candidate.record.operation_id_sha256)
        );

        make_directory_writable(&closure_directory);
        let candidate_path = closure_directory.join(TERMINAL_SNAPSHOT_CANDIDATE_FILE_NAME);
        make_writable(&candidate_path);
        fs::remove_file(candidate_path).unwrap();
        assert_eq!(
            store.recover_terminal_closure(&publication, &credentials, &activation),
            Err(ReceiptError::Conflict)
        );
        cleanup(&root);
    }

    #[test]
    fn terminal_candidate_staging_residue_is_a_fail_closed_admission_barrier() {
        let root = temporary_root("terminal-candidate-staging");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let closure = store
            .ensure_operation_closure_directory(activation.authorization_id_sha256())
            .unwrap();
        let staging = closure.join(staging_file_name(1).unwrap());
        fs::write(&staging, b"indeterminate").unwrap();

        assert_eq!(
            store.reserve_operation(
                &publication,
                &credentials,
                &activation,
                &operation_start("a", NOW),
            ),
            Err(ReceiptError::UnsafeFilesystem("operation_closure_staging"))
        );
        assert_eq!(
            store.recover_terminal_closure(&publication, &credentials, &activation),
            Err(ReceiptError::UnsafeFilesystem("operation_closure_staging"))
        );
        cleanup(&root);
    }

    #[test]
    fn terminal_execution_receipt_crash_recovers_local_closure_without_new_operations() {
        let root = temporary_root("terminal-closure-recovery");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        let unfinished = operation_start("a", NOW - 1);
        store
            .reserve_operation(&publication, &credentials, &activation, &unfinished)
            .unwrap();

        store.install_terminal_plan(&plan).unwrap();
        let authorization = activation.authorization_id_sha256().to_owned();
        assert_eq!(
            store.reserve_operation(
                &publication,
                &credentials,
                &activation,
                &operation_start("a", NOW),
            ),
            Err(ReceiptError::AlreadySealed)
        );
        let recovery = store
            .recover_unfinished_operations(&publication, &credentials, &activation, NOW + 1)
            .unwrap();
        assert_eq!(recovery.operation_count, 1);
        assert_eq!(recovery.unfinished_count, 1);
        assert_eq!(recovery.recovered_ambiguous_count, 1);
        let closure = store
            .recover_terminal_closure(&publication, &credentials, &activation)
            .unwrap()
            .unwrap();
        assert_eq!(closure.authorization_id_sha256, authorization);
        assert_eq!(closure.execution_receipt_head_sha256, plan.head_sha256());
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let head_set = store.canonical_operation_head_set(&context).unwrap();
        assert_eq!(head_set.verified.operation_count, 1);
        assert_eq!(head_set.verified.capacity_reservation_count, 1);
        assert_eq!(head_set.verified.marker_only_count, 0);
        assert_eq!(
            head_set.record.entries[0].outcome,
            Some(OperationOutcome::Ambiguous)
        );
        cleanup(&root);
    }

    #[test]
    fn orphaned_local_seal_remains_an_admission_barrier_and_fails_recovery_closed() {
        let root = temporary_root("orphaned-local-seal");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        store
            .install_terminal_closure(&plan, &publication, &credentials, &activation)
            .unwrap();

        let authorization = root
            .join(OPERATION_RECEIPTS_DIRECTORY_NAME)
            .join(activation.authorization_id_sha256());
        make_directory_writable(&authorization);
        let head_set = authorization.join(OPERATION_HEAD_SET_FILE_NAME);
        make_writable(&head_set);
        fs::remove_file(head_set).unwrap();
        let execution_chain = root
            .join(RECEIPTS_DIRECTORY_NAME)
            .join(activation.authorization_id_sha256());
        make_tree_writable(&execution_chain);
        fs::remove_dir_all(execution_chain).unwrap();

        let start = operation_start("a", NOW);
        assert_eq!(
            store.reserve_operation(&publication, &credentials, &activation, &start),
            Err(ReceiptError::AlreadySealed)
        );
        assert_eq!(
            store.recover_terminal_closure(&publication, &credentials, &activation),
            Err(ReceiptError::Conflict)
        );
        cleanup(&root);
    }

    #[test]
    fn terminal_closure_rejects_operation_head_and_manifest_tampering() {
        let root = temporary_root("terminal-closure-tamper");
        let store = ReceiptStore::open(&root).unwrap();
        let (publication, credentials, activation) = operation_context();
        let start = operation_start("a", NOW);
        store
            .reserve_operation(&publication, &credentials, &activation, &start)
            .unwrap();
        store
            .finish_operation(
                &publication,
                &credentials,
                &activation,
                &start.identity,
                &OperationFinishInput {
                    outcome: OperationOutcome::Accepted,
                    finished_at: NOW + 1,
                    http_status: Some(200),
                    response_body_sha256: Some("a".repeat(64)),
                    response_id_sha256: Some("b".repeat(64)),
                },
            )
            .unwrap();
        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        store
            .install_terminal_closure(&plan, &publication, &credentials, &activation)
            .unwrap();

        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let operation = project_operation_identity(&context, &start.identity).unwrap();
        let operation_directory = store
            .operation_directory(
                activation.authorization_id_sha256(),
                &operation.operation_id_sha256,
            )
            .unwrap();
        let operation_head = operation_directory.join(operation_receipt_file_name(2));
        make_directory_writable(&operation_directory);
        make_writable(&operation_head);
        let mut mutated_operation: serde_json::Value =
            serde_json::from_slice(&fs::read(&operation_head).unwrap()).unwrap();
        mutated_operation["event"]["response_id_sha256"] =
            serde_json::Value::String("c".repeat(64));
        overwrite_and_restore_read_only(
            &operation_head,
            canonical_json(&mutated_operation).unwrap().as_bytes(),
        );
        assert_eq!(
            store.recover_terminal_closure(&publication, &credentials, &activation),
            Err(ReceiptError::Conflict)
        );

        cleanup(&root);

        let root = temporary_root("terminal-closure-manifest-tamper");
        let store = ReceiptStore::open(&root).unwrap();
        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        store
            .install_terminal_closure(&plan, &publication, &credentials, &activation)
            .unwrap();
        let authorization = root
            .join(OPERATION_RECEIPTS_DIRECTORY_NAME)
            .join(activation.authorization_id_sha256());
        let head_set = authorization.join(OPERATION_HEAD_SET_FILE_NAME);
        make_directory_writable(&authorization);
        make_writable(&head_set);
        let mut mutated_head_set: serde_json::Value =
            serde_json::from_slice(&fs::read(&head_set).unwrap()).unwrap();
        mutated_head_set["operationContextSha256"] = serde_json::Value::String("f".repeat(64));
        overwrite_and_restore_read_only(
            &head_set,
            canonical_json(&mutated_head_set).unwrap().as_bytes(),
        );
        assert_eq!(
            store.recover_terminal_closure(&publication, &credentials, &activation),
            Err(ReceiptError::Conflict)
        );
        cleanup(&root);
    }

    #[test]
    fn operation_head_closure_matches_the_javascript_fixed_vector() {
        let head_set = OperationHeadSetManifest {
            schema_version: 1,
            contract: OPERATION_HEAD_SET_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            activation_sha256: "1".repeat(64),
            authorization_id_sha256: "2".repeat(64),
            claim_digest_sha256: "3".repeat(64),
            operation_context_sha256: "4".repeat(64),
            capacity_limit: 128,
            operation_count: 0,
            capacity_reservation_count: 0,
            marker_only_count: 0,
            entries: Vec::new(),
        };
        validate_operation_head_set(&head_set).unwrap();
        let head_set_bytes = canonical_json(&head_set).unwrap().into_bytes();
        let head_set_sha256 = sha256_hex(&head_set_bytes);
        assert_eq!(head_set_bytes.len(), 568);
        assert_eq!(
            head_set_sha256,
            "5c70cdf03cfdc9f00878b20bffe3e4e790dedbb593bef4c5929713d33a601564"
        );

        let local_seal = OperationHeadLocalSeal {
            schema_version: 1,
            contract: OPERATION_HEAD_LOCAL_SEAL_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            activation_sha256: head_set.activation_sha256,
            authorization_id_sha256: head_set.authorization_id_sha256,
            claim_digest_sha256: head_set.claim_digest_sha256,
            operation_context_sha256: head_set.operation_context_sha256,
            execution_receipt_head_sha256: "5".repeat(64),
            execution_receipt_count: 8,
            terminal_status: ClaimStatus::Completed,
            terminal_state_version: 6,
            operation_head_set_sha256: head_set_sha256,
            operation_head_set_bytes: 568,
            operation_count: 0,
            capacity_reservation_count: 0,
            marker_only_count: 0,
            terminal_snapshot_candidate_sha256: None,
            terminal_snapshot_candidate_bytes: None,
            terminal_candidate_operation_id_sha256: None,
            terminal_candidate_start_receipt_sha256: None,
        };
        validate_operation_head_local_seal(&local_seal).unwrap();
        let local_seal_bytes = canonical_json(&local_seal).unwrap().into_bytes();
        assert_eq!(local_seal_bytes.len(), 1000);
        assert_eq!(
            sha256_hex(&local_seal_bytes),
            "5875614a4d23597ccf6406c013a8aaab99f9f3cb762d2c793ad4ab7b89fbe9b3"
        );
    }

    #[test]
    fn reserve_and_terminal_closure_linearize_under_one_authorization_lock() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let root = temporary_root("terminal-closure-race");
        let (publication, credentials, activation) = operation_context();
        let plan = terminal_plan_for_operation_context(&publication, &credentials, &activation);
        let barrier = Arc::new(Barrier::new(2));

        let reserve_root = root.clone();
        let reserve_publication = publication.clone();
        let reserve_credentials = credentials.clone();
        let reserve_activation = activation.clone();
        let reserve_barrier = Arc::clone(&barrier);
        let reserve = thread::spawn(move || {
            let store = ReceiptStore::open(&reserve_root).unwrap();
            let start = operation_start("a", NOW);
            reserve_barrier.wait();
            let result = store.reserve_operation(
                &reserve_publication,
                &reserve_credentials,
                &reserve_activation,
                &start,
            );
            if result == Ok(OperationReservation::Fresh) {
                store
                    .finish_operation(
                        &reserve_publication,
                        &reserve_credentials,
                        &reserve_activation,
                        &start.identity,
                        &OperationFinishInput {
                            outcome: OperationOutcome::Accepted,
                            finished_at: NOW + 1,
                            http_status: Some(200),
                            response_body_sha256: Some("a".repeat(64)),
                            response_id_sha256: Some("b".repeat(64)),
                        },
                    )
                    .unwrap();
            }
            result
        });

        let close_root = root.clone();
        let close_publication = publication.clone();
        let close_credentials = credentials.clone();
        let close_activation = activation.clone();
        let close_barrier = Arc::clone(&barrier);
        let close = thread::spawn(move || {
            let store = ReceiptStore::open(&close_root).unwrap();
            close_barrier.wait();
            loop {
                match store.install_terminal_closure(
                    &plan,
                    &close_publication,
                    &close_credentials,
                    &close_activation,
                ) {
                    Ok(closure) => break closure,
                    Err(ReceiptError::InvalidField("unfinished_operation_chain")) => {
                        thread::yield_now();
                    }
                    Err(error) => panic!("unexpected closure failure: {error}"),
                }
            }
        });

        let reservation = reserve.join().unwrap();
        let closure = close.join().unwrap();
        let store = ReceiptStore::open(&root).unwrap();
        let context = project_operation_context(&publication, &credentials, &activation).unwrap();
        let verified = store.verify_terminal_closure(&context).unwrap();
        assert_eq!(verified, closure);
        let head_set = store.canonical_operation_head_set(&context).unwrap();
        match reservation {
            Ok(OperationReservation::Fresh) => {
                assert_eq!(head_set.verified.operation_count, 1);
                assert_eq!(head_set.verified.capacity_reservation_count, 1);
            }
            Err(ReceiptError::AlreadySealed) => {
                assert_eq!(head_set.verified.operation_count, 0);
                assert_eq!(head_set.verified.capacity_reservation_count, 0);
            }
            result => panic!("unexpected reservation result: {result:?}"),
        }
        cleanup(&root);
    }

    fn synthetic_plan() -> ReceiptPlan {
        let release = ReceiptReleaseIdentity {
            source_commit: "a".repeat(40),
            git_tree_sha: "b".repeat(40),
            release_manifest_sha256: "1".repeat(64),
            release_packet_sha256: "2".repeat(64),
            release_policy_sha256: "3".repeat(64),
            artifact_sha256: "4".repeat(64),
            module_inventory_sha256: "5".repeat(64),
            module_count: 25,
            publication_manifest_sha256: "6".repeat(64),
            publication_packet_sha256: "7".repeat(64),
            generation_sha256: "8".repeat(64),
            activation_sequence: 1,
            previous_publication_manifest_sha256: None,
            published_at: "2026-07-24T00:00:00.000Z".to_owned(),
            expires_at: "2026-07-25T00:00:00.000Z".to_owned(),
        };
        let credentials = ReceiptCredentialIdentity {
            account_id_sha256: "9".repeat(64),
            read_credential_id_sha256: "a".repeat(64),
            claim_credential_id_sha256: "b".repeat(64),
            deploy_credential_id_sha256: "c".repeat(64),
            access_client_id_sha256: "d".repeat(64),
            authority_version_id: "authority-v1".to_owned(),
            permit_spki_sha256: "e".repeat(64),
            trust_config_sha256: "f".repeat(64),
            runner_build_sha256: "4".repeat(64),
            controller_service_name: "controller-staging".to_owned(),
            edge_service_name: "edge-staging".to_owned(),
            stable_readback_observation_seconds: 5,
        };
        let claim = ReceiptClaimIdentity {
            authorization_id_sha256: "1".repeat(64),
            claim_digest_sha256: "2".repeat(64),
            ledger_identity_sha256: "3".repeat(64),
            claim_owner_sha256: "4".repeat(64),
            account_id_sha256: "9".repeat(64),
            generated_at: 10,
            claimed_at: 11,
            expires_at: 100,
        };
        let mut receipts = Vec::new();
        push_receipt(
            &mut receipts,
            release.clone(),
            credentials.clone(),
            claim.clone(),
            11,
            ReceiptEvent::ClaimObserved {
                status: ClaimStatus::Claimed,
                state_version: 0,
            },
        )
        .unwrap();
        let mut step = ReceiptStepEvent {
            state_version: 1,
            step_code: StepCode::Terminal,
            from_status: ClaimStatus::Claimed,
            to_status: ClaimStatus::Aborted,
            actor_execution_id_sha256: "4".repeat(64),
            mutation_request_sha256: None,
            cloudflare_request_id_sha256: None,
            deployment_set_sha256: None,
            evidence_sha256: "5".repeat(64),
            failure_class: FailureClass::OperatorAbort,
            transport_outcome: TransportOutcome::NotApplicable,
            step_digest_sha256: String::new(),
        };
        step.step_digest_sha256 = receipt_step_digest(&claim, &step).unwrap();
        push_receipt(
            &mut receipts,
            release.clone(),
            credentials.clone(),
            claim.clone(),
            12,
            ReceiptEvent::AuthorityStep { step },
        )
        .unwrap();
        push_receipt(
            &mut receipts,
            release,
            credentials,
            claim,
            13,
            ReceiptEvent::TerminalSeal {
                status: ClaimStatus::Aborted,
                state_version: 1,
                terminal_at: 13,
                final_snapshot_sha256: "5".repeat(64),
                final_snapshot_bytes: 128,
                history_sha256: "6".repeat(64),
                chain_length: 3,
            },
        )
        .unwrap();
        validate_planned_chain(&receipts).unwrap();
        ReceiptPlan {
            authorization_id_sha256: "1".repeat(64),
            receipts,
        }
    }

    const NOW: u64 = 1_700_000_100;

    fn operation_start(request_id_nibble: &str, started_at: u64) -> OperationStartInput {
        OperationStartInput {
            identity: OperationIdentityInput {
                kind: OperationKind::AuthorityStepAppend,
                state_version: 1,
                target_sha256: "a".repeat(64),
                request_sha256: "b".repeat(64),
            },
            request_id_sha256: request_id_nibble.repeat(64),
            started_at,
        }
    }

    fn terminal_snapshot_context() -> (
        PublicationIdentity,
        CredentialIdentity,
        ExecutionActivationIdentity,
        VerifiedSnapshot,
    ) {
        let (publication, credentials, _) = operation_context();
        let generated_at = NOW - 100;
        let expires_at = NOW + 300;
        let mut claim = crate::orchestrator::SnapshotClaim {
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
            account_id_sha256: credentials.account_id_sha256.clone(),
            ledger_identity_sha256: "d".repeat(64),
            read_credential_id_sha256: credentials.read_credential_id_sha256.clone(),
            claim_credential_id_sha256: credentials.claim_credential_id_sha256.clone(),
            deploy_credential_id_sha256: credentials.deploy_credential_id_sha256.clone(),
            controller: crate::orchestrator::ServiceTarget {
                service_name: credentials.controller_service_name.clone(),
                previous_version_id: "controller-version-001".to_owned(),
                previous_deployment_set_sha256: "1".repeat(64),
                target_version_id: "controller-version-002".to_owned(),
            },
            edge: crate::orchestrator::ServiceTarget {
                service_name: credentials.edge_service_name.clone(),
                previous_version_id: "edge-version-001".to_owned(),
                previous_deployment_set_sha256: "2".repeat(64),
                target_version_id: "edge-version-002".to_owned(),
            },
            runner_build_sha256: credentials.runner_build_sha256.clone(),
            runner_trust_config_sha256: credentials.trust_config_sha256.clone(),
            claim_owner_sha256: "5".repeat(64),
            claim_digest_sha256: String::new(),
            generated_at,
            expires_at,
        };
        claim.claim_digest_sha256 = crate::orchestrator::activation_claim_digest(&claim).unwrap();
        let receipt_claim = ReceiptClaimIdentity {
            authorization_id_sha256: claim.authorization_id_sha256.clone(),
            claim_digest_sha256: claim.claim_digest_sha256.clone(),
            ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
            claim_owner_sha256: claim.claim_owner_sha256.clone(),
            account_id_sha256: claim.account_id_sha256.clone(),
            generated_at,
            claimed_at: generated_at + 1,
            expires_at,
        };
        let mut receipt_step = ReceiptStepEvent {
            state_version: 1,
            step_code: StepCode::Terminal,
            from_status: ClaimStatus::Claimed,
            to_status: ClaimStatus::Aborted,
            actor_execution_id_sha256: claim.claim_owner_sha256.clone(),
            mutation_request_sha256: None,
            cloudflare_request_id_sha256: None,
            deployment_set_sha256: None,
            evidence_sha256: "a".repeat(64),
            failure_class: FailureClass::OperatorAbort,
            transport_outcome: TransportOutcome::NotApplicable,
            step_digest_sha256: String::new(),
        };
        receipt_step.step_digest_sha256 =
            receipt_step_digest(&receipt_claim, &receipt_step).unwrap();
        let snapshot_record = AuthoritySnapshot {
            claim: claim.clone(),
            state: crate::orchestrator::SnapshotState {
                authorization_id_sha256: claim.authorization_id_sha256.clone(),
                claim_digest_sha256: claim.claim_digest_sha256.clone(),
                claim_owner_sha256: claim.claim_owner_sha256.clone(),
                ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
                claim_credential_id_sha256: claim.claim_credential_id_sha256.clone(),
                status: ClaimStatus::Aborted,
                state_version: 1,
                generated_at,
                claimed_at: generated_at + 1,
                expires_at,
                updated_at: NOW,
                terminal_at: Some(NOW),
            },
            steps: vec![SnapshotStep {
                state_version: receipt_step.state_version,
                step_code: receipt_step.step_code,
                from_status: receipt_step.from_status,
                to_status: receipt_step.to_status,
                actor_execution_id_sha256: receipt_step.actor_execution_id_sha256,
                mutation_request_sha256: receipt_step.mutation_request_sha256,
                cloudflare_request_id_sha256: receipt_step.cloudflare_request_id_sha256,
                deployment_set_sha256: receipt_step.deployment_set_sha256,
                evidence_sha256: receipt_step.evidence_sha256,
                failure_class: receipt_step.failure_class,
                transport_outcome: receipt_step.transport_outcome,
                step_digest_sha256: receipt_step.step_digest_sha256,
                recorded_at: NOW,
            }],
            expiry_events: Vec::new(),
        };
        let snapshot_bytes = canonical_json(&snapshot_record).unwrap().into_bytes();
        let snapshot = VerifiedSnapshot::from_json(&snapshot_bytes).unwrap();
        let activation = ExecutionActivationIdentity::for_transport_test(
            br#"{"claim":"terminal-candidate"}"#.to_vec(),
            claim.authorization_id_sha256,
            claim.claim_digest_sha256,
            claim.claim_owner_sha256,
            claim.ledger_identity_sha256,
            generated_at,
            expires_at,
        );
        (publication, credentials, activation, snapshot)
    }

    fn operation_context() -> (
        PublicationIdentity,
        CredentialIdentity,
        ExecutionActivationIdentity,
    ) {
        let activation = ExecutionActivationIdentity::for_transport_test(
            br#"{"claim":"operation"}"#.to_vec(),
            "1".repeat(64),
            "2".repeat(64),
            "4".repeat(64),
            "3".repeat(64),
            NOW - 100,
            NOW + 300,
        );
        let publication = PublicationIdentity {
            release: crate::release::VerifiedRelease {
                source_commit: "1".repeat(40),
                git_tree_sha: "2".repeat(40),
                target_triple: "x86_64-unknown-linux-gnu".to_owned(),
                manifest_sha256: "5".repeat(64),
                packet_sha256: "6".repeat(64),
                policy_sha256: "7".repeat(64),
                release_key_id: "release-v1".to_owned(),
                release_key_spki_base64url: "release-spki".to_owned(),
                release_key_spki_sha256: "8".repeat(64),
                artifact_file_name: "cinatoken-ring-transition-runner".to_owned(),
                artifact_byte_length: 1,
                artifact_sha256: "3".repeat(64),
                module_inventory_sha256: "9".repeat(64),
                module_count: 28,
                module_bytes: 1,
                authority_version_id: "authority-version-001".to_owned(),
                permit_spki_sha256: "6".repeat(64),
                trust_config_sha256: "4".repeat(64),
                issued_at: "2026-07-24T00:00:00Z".to_owned(),
                expires_at: "2026-07-25T00:00:00Z".to_owned(),
            },
            publication_manifest_sha256: "7".repeat(64),
            publication_packet_sha256: "b".repeat(64),
            generation_sha256: "d".repeat(64),
            publication_directory_name: format!("publication-{}", "7".repeat(64)),
            activation_sequence: 1,
            previous_publication_manifest_sha256: None,
            published_at: "2026-07-24T00:00:00.000Z".to_owned(),
            expires_at: "2026-07-25T00:00:00.000Z".to_owned(),
        };
        let credentials = CredentialIdentity {
            account_id_sha256: "c".repeat(64),
            read_credential_id_sha256: "e".repeat(64),
            claim_credential_id_sha256: "f".repeat(64),
            deploy_credential_id_sha256: "0".repeat(64),
            access_client_id_sha256: "1".repeat(64),
            authority_version_id: "authority-version-001".to_owned(),
            permit_spki_sha256: "6".repeat(64),
            trust_config_sha256: "4".repeat(64),
            publication_manifest_sha256: "7".repeat(64),
            runner_build_sha256: "3".repeat(64),
            controller_service_name: "controller-staging".to_owned(),
            edge_service_name: "edge-staging".to_owned(),
            stable_readback_observation_seconds: 5,
            activation_sequence: 1,
        };
        (publication, credentials, activation)
    }

    fn terminal_plan_for_operation_context(
        publication: &PublicationIdentity,
        credentials: &CredentialIdentity,
        activation: &ExecutionActivationIdentity,
    ) -> ReceiptPlan {
        let release = ReceiptReleaseIdentity::from(publication);
        let credential_identity = ReceiptCredentialIdentity::from(credentials);
        let claim = ReceiptClaimIdentity {
            authorization_id_sha256: activation.authorization_id_sha256().to_owned(),
            claim_digest_sha256: activation.claim_digest_sha256().to_owned(),
            ledger_identity_sha256: activation.ledger_identity_sha256().to_owned(),
            claim_owner_sha256: activation.claim_owner_sha256().to_owned(),
            account_id_sha256: credentials.account_id_sha256.clone(),
            generated_at: activation.claim_generated_at(),
            claimed_at: NOW - 90,
            expires_at: activation.claim_expires_at(),
        };
        let mut receipts = Vec::new();
        push_receipt(
            &mut receipts,
            release.clone(),
            credential_identity.clone(),
            claim.clone(),
            claim.claimed_at,
            ReceiptEvent::ClaimObserved {
                status: ClaimStatus::Claimed,
                state_version: 0,
            },
        )
        .unwrap();
        let mut step = ReceiptStepEvent {
            state_version: 1,
            step_code: StepCode::Terminal,
            from_status: ClaimStatus::Claimed,
            to_status: ClaimStatus::Aborted,
            actor_execution_id_sha256: activation.claim_owner_sha256().to_owned(),
            mutation_request_sha256: None,
            cloudflare_request_id_sha256: None,
            deployment_set_sha256: None,
            evidence_sha256: "a".repeat(64),
            failure_class: FailureClass::OperatorAbort,
            transport_outcome: TransportOutcome::NotApplicable,
            step_digest_sha256: String::new(),
        };
        step.step_digest_sha256 = receipt_step_digest(&claim, &step).unwrap();
        push_receipt(
            &mut receipts,
            release.clone(),
            credential_identity.clone(),
            claim.clone(),
            NOW,
            ReceiptEvent::AuthorityStep { step },
        )
        .unwrap();
        push_receipt(
            &mut receipts,
            release,
            credential_identity,
            claim,
            NOW,
            ReceiptEvent::TerminalSeal {
                status: ClaimStatus::Aborted,
                state_version: 1,
                terminal_at: NOW,
                final_snapshot_sha256: "b".repeat(64),
                final_snapshot_bytes: 256,
                history_sha256: "c".repeat(64),
                chain_length: 3,
            },
        )
        .unwrap();
        validate_planned_chain(&receipts).unwrap();
        ReceiptPlan {
            authorization_id_sha256: activation.authorization_id_sha256().to_owned(),
            receipts,
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_exact_publication_fails_closed_after_parent_path_replacement() {
        let root = temporary_root("linux-parent-fd");
        let parent = root.join("parent");
        let displaced = root.join("displaced");
        fs::create_dir(&parent).unwrap();
        let target = parent.join("receipt.json");
        let bytes = br#"{"contract":"single-parent-fd"}"#;
        let hook_parent = parent.clone();
        let hook_displaced = displaced.clone();

        let outcome = publish_exact_bytes_linux_with_hook(
            &parent,
            &target,
            1,
            bytes,
            MAX_RECEIPT_BYTES,
            "linux_parent_fd_test",
            move || {
                fs::rename(&hook_parent, &hook_displaced).unwrap();
                fs::create_dir(&hook_parent).unwrap();
            },
        );

        assert_eq!(
            outcome,
            Err(ReceiptError::UnsafeFilesystem("linux_parent_fd_test"))
        );
        assert_eq!(fs::read(displaced.join("receipt.json")).unwrap(), bytes);
        assert!(!parent.join("receipt.json").exists());
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        cleanup(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_exact_publication_never_overwrites_a_competing_target() {
        let root = temporary_root("linux-noreplace");
        let target = root.join("receipt.json");
        let competing = br#"{"contract":"competitor"}"#;
        let requested = br#"{"contract":"requested"}"#;
        let hook_target = target.clone();

        let outcome = publish_exact_bytes_linux_with_hook(
            &root,
            &target,
            1,
            requested,
            MAX_RECEIPT_BYTES,
            "linux_noreplace_test",
            move || {
                use std::os::unix::fs::PermissionsExt;

                fs::write(&hook_target, competing).unwrap();
                fs::set_permissions(&hook_target, fs::Permissions::from_mode(0o444)).unwrap();
            },
        )
        .unwrap();

        let ExactPublicationOutcome::ExistingDifferent(existing) = outcome else {
            panic!("the competing target must win");
        };
        assert_eq!(existing, competing);
        assert_eq!(fs::read(&target).unwrap(), competing);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".staging"))
                .count(),
            0
        );
        cleanup(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_exact_publication_rejects_hard_linked_targets() {
        let root = temporary_root("linux-hardlink");
        let target = root.join("receipt.json");
        let alias = root.join("receipt.alias");
        fs::write(&target, br#"{"contract":"linked"}"#).unwrap();
        fs::hard_link(&target, &alias).unwrap();

        assert_eq!(
            publish_exact_bytes(
                &root,
                &target,
                1,
                br#"{"contract":"linked"}"#,
                MAX_RECEIPT_BYTES,
                "linux_hardlink_test",
            ),
            Err(ReceiptError::UnsafeFilesystem("linux_hardlink_test"))
        );
        cleanup(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_locked_authorization_fails_closed_after_path_replacement() {
        let root = temporary_root("linux-authorization-replacement");
        let receipts = root.join("operation-receipts");
        let authorization = receipts.join("a".repeat(64));
        let displaced = receipts.join("displaced");
        fs::create_dir(&receipts).unwrap();
        fs::create_dir(&authorization).unwrap();
        let hook_authorization = authorization.clone();
        let hook_displaced = displaced.clone();

        let result = lock_operation_authorization_linux_with_hook(&authorization, move || {
            fs::rename(&hook_authorization, &hook_displaced).unwrap();
            fs::create_dir(&hook_authorization).unwrap();
        });

        assert!(matches!(
            result,
            Err(ReceiptError::UnsafeFilesystem(
                "operation_authorization_lock"
            ))
        ));
        assert_eq!(fs::read_dir(&authorization).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&displaced).unwrap().count(), 0);
        cleanup(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_locked_authorization_holds_the_parent_flock() {
        use std::os::fd::AsRawFd;

        let root = temporary_root("linux-authorization-parent-lock");
        let receipts = root.join("operation-receipts");
        let authorization = receipts.join("a".repeat(64));
        fs::create_dir(&receipts).unwrap();
        fs::create_dir(&authorization).unwrap();
        let locked = lock_operation_authorization(&authorization).unwrap();
        let contender = open_linux_directory(&receipts).unwrap();

        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            -1
        );
        let error = std::io::Error::last_os_error();
        assert_eq!(error.raw_os_error(), Some(libc::EWOULDBLOCK));

        drop(locked);
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_UN) },
            0
        );
        cleanup(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_openat2_child_open_rejects_escape_and_symlink() {
        use std::ffi::CString;
        use std::os::unix::fs::symlink;

        let root = temporary_root("linux-openat2-containment");
        let parent = root.join("parent");
        let child = parent.join("child");
        let outside = root.join("outside");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&child).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, parent.join("linked")).unwrap();
        let parent = open_linux_directory(&parent).unwrap();

        assert!(open_linux_directory_at(&parent, &CString::new("child").unwrap()).is_ok());
        assert!(open_linux_directory_at(&parent, &CString::new("../outside").unwrap()).is_err());
        assert!(open_linux_directory_at(&parent, &CString::new("linked").unwrap()).is_err());

        cleanup(&root);
    }

    fn temporary_root(label: &str) -> PathBuf {
        let mut random = [0_u8; 8];
        getrandom(&mut random).unwrap();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let root = std::env::temp_dir().join(format!("cinatoken-receipt-{label}-{suffix}"));
        fs::create_dir(&root).unwrap();
        root
    }

    fn cleanup(root: &Path) {
        make_tree_writable(root);
        let _ = fs::remove_dir_all(root);
    }

    fn make_tree_writable(path: &Path) {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let child = entry.path();
                if child.is_dir() {
                    make_directory_writable(&child);
                    make_tree_writable(&child);
                } else {
                    make_writable(&child);
                }
            }
        }
        make_directory_writable(path);
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn make_writable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));
        }
        #[cfg(not(unix))]
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }

    fn overwrite_and_restore_read_only(path: &Path, bytes: &[u8]) {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.flush().unwrap();
        set_file_read_only(&file).unwrap();
    }

    fn make_directory_writable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
        }
        #[cfg(not(unix))]
        make_writable(path);
    }
}
