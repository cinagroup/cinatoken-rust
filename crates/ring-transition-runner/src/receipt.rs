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
use std::fmt;
use std::fs;
#[cfg(not(target_os = "linux"))]
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const EXECUTION_RECEIPT_CONTRACT: &str =
    "cinatoken-ring-transition-runner-execution-receipt-v1";
pub const OPERATION_RECEIPT_CONTRACT: &str =
    "cinatoken-ring-transition-runner-operation-receipt-v1";
const OPERATION_ID_CONTRACT: &str = "cinatoken-ring-transition-runner-operation-id-v1";
const HISTORY_DIGEST_CONTRACT: &str =
    "cinatoken-ring-transition-runner-execution-receipt-history-v1";
const RECEIPTS_DIRECTORY_NAME: &str = "execution-receipts";
const OPERATION_RECEIPTS_DIRECTORY_NAME: &str = "execution-operation-receipts";
const RECEIPT_FILE_SUFFIX: &str = ".receipt.json";
const OPERATION_RECEIPT_FILE_SUFFIX: &str = ".operation.json";
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_RECEIPTS_PER_CHAIN: u64 = 128;
const MAX_OPERATION_RECEIPTS_PER_CHAIN: u64 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    AuthorityClaimCreate,
    AuthorityStepAppend,
    CloudflareDeployment,
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

    pub fn install_terminal_plan(
        &self,
        plan: &ReceiptPlan,
    ) -> Result<InstalledReceiptChain, ReceiptError> {
        if !plan.is_sealed() {
            return Err(ReceiptError::NotSealed);
        }
        self.install_snapshot_plan(plan)
    }

    pub fn install_snapshot_plan(
        &self,
        plan: &ReceiptPlan,
    ) -> Result<InstalledReceiptChain, ReceiptError> {
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
        let directory = self.ensure_operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
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
                Ok(OperationReservation::Fresh)
            }
            Ok(AppendOutcome::ExistingExact) | Err(ReceiptError::Conflict) => {
                let verified = verify_operation_directory(
                    &directory,
                    &context.authorization_id_sha256,
                    &operation.operation_id_sha256,
                )?;
                require_operation_identity(&verified, &context, &operation)?;
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
        let directory = self.operation_directory(
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        let verified = verify_operation_directory(
            &directory,
            &context.authorization_id_sha256,
            &operation.operation_id_sha256,
        )?;
        require_operation_identity(&verified, &context, &operation)?;
        if let Some(outcome) = verified.verified.outcome {
            return Ok(outcome);
        }
        validate_operation_finish_input(input, verified.start_recorded_at)?;
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
        match append_canonical_operation_receipt(&directory, &finish) {
            Ok(_) | Err(ReceiptError::Conflict) => {
                let verified = verify_operation_directory(
                    &directory,
                    &context.authorization_id_sha256,
                    &operation.operation_id_sha256,
                )?;
                require_operation_identity(&verified, &context, &operation)?;
                verified.verified.outcome.ok_or(ReceiptError::Conflict)
            }
            Err(error) => Err(error),
        }
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

    fn ensure_chain_directory(
        &self,
        authorization_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        let receipts = self.root.join(RECEIPTS_DIRECTORY_NAME);
        create_fixed_directory(&receipts, &self.root, "receipts_directory")?;
        let chain = receipts.join(authorization_id_sha256);
        create_fixed_directory(&chain, &receipts, "chain_directory")?;
        Ok(chain)
    }

    fn ensure_operation_directory(
        &self,
        authorization_id_sha256: &str,
        operation_id_sha256: &str,
    ) -> Result<PathBuf, ReceiptError> {
        validate_lower_hex(authorization_id_sha256, "authorization_id_sha256")?;
        validate_lower_hex(operation_id_sha256, "operation_id_sha256")?;
        let receipts = self.root.join(OPERATION_RECEIPTS_DIRECTORY_NAME);
        create_fixed_directory(&receipts, &self.root, "operation_receipts_directory")?;
        let authorization = receipts.join(authorization_id_sha256);
        create_fixed_directory(
            &authorization,
            &receipts,
            "operation_authorization_directory",
        )?;
        let operation = authorization.join(operation_id_sha256);
        create_fixed_directory(&operation, &authorization, "operation_directory")?;
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

fn project_operation_identity(
    context: &OperationContextIdentity,
    input: &OperationIdentityInput,
) -> Result<OperationIdentity, ReceiptError> {
    validate_lower_hex(&input.target_sha256, "operation_target_sha256")?;
    validate_lower_hex(&input.request_sha256, "operation_request_sha256")?;
    match input.kind {
        OperationKind::AuthorityClaimCreate if input.state_version != 0 => {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        OperationKind::AuthorityStepAppend if input.state_version == 0 => {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        OperationKind::CloudflareDeployment if !matches!(input.state_version, 2 | 5) => {
            return Err(ReceiptError::InvalidField("operation_state_version"));
        }
        _ => {}
    }
    let operation_id_sha256 = sha256_hex(
        canonical_json(&OperationIdSubject {
            schema_version: 1,
            contract: OPERATION_ID_CONTRACT,
            activation_sha256: &context.activation_sha256,
            authorization_id_sha256: &context.authorization_id_sha256,
            claim_digest_sha256: &context.claim_digest_sha256,
            kind: input.kind,
            state_version: input.state_version,
            method: "POST",
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
        method: "POST".to_owned(),
        target_sha256: input.target_sha256.clone(),
        request_sha256: input.request_sha256.clone(),
    })
}

fn validate_operation_start_input(
    context: &OperationContextIdentity,
    input: &OperationStartInput,
) -> Result<(), ReceiptError> {
    validate_lower_hex(&input.request_id_sha256, "operation_request_id_sha256")?;
    if input.started_at < context.generated_at
        || input.started_at >= context.expires_at
        || input.started_at > MAX_SAFE_INTEGER
    {
        return Err(ReceiptError::InvalidField("operation_start_time"));
    }
    Ok(())
}

fn validate_operation_finish_input(
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
            if !input
                .http_status
                .is_some_and(|status| (200..=299).contains(&status))
            {
                return Err(ReceiptError::InvalidField("operation_accepted_status"));
            }
        }
        OperationOutcome::Rejected => {
            if !input
                .http_status
                .is_some_and(|status| (400..=499).contains(&status))
            {
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
    if record.operation != projected || record.operation.method != "POST" {
        return Err(ReceiptError::InvalidField("operation_identity"));
    }
    match &record.event {
        OperationReceiptEvent::RequestStarted { request_id_sha256 } => {
            if record.sequence != 1
                || record.recorded_at < record.context.generated_at
                || record.recorded_at >= record.context.expires_at
            {
                return Err(ReceiptError::InvalidField("operation_start"));
            }
            validate_lower_hex(request_id_sha256, "operation_request_id_sha256")?;
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

    let stage = chain_directory.join(staging_file_name(receipt.record.sequence)?);
    write_staging(&stage, receipt.bytes())?;
    if publish_noreplace(&stage, &target).is_err() {
        let _ = fs::remove_file(&stage);
        match target.try_exists() {
            Ok(true) => {
                let existing = read_receipt(&target, &canonical_parent)?;
                if existing.bytes == receipt.bytes {
                    sync_directory(chain_directory, receipt.sha256())?;
                    return Ok(AppendOutcome::ExistingExact);
                }
                return Err(ReceiptError::Conflict);
            }
            Ok(false) | Err(_) => {
                return Err(ReceiptError::DurabilityUnknown {
                    expected_sha256: receipt.sha256().to_owned(),
                });
            }
        }
    }
    sync_directory(chain_directory, receipt.sha256())?;
    let installed = read_receipt(&target, &canonical_parent)?;
    if installed.bytes != receipt.bytes || installed.sha256 != receipt.sha256 {
        return Err(ReceiptError::Conflict);
    }
    if receipt.record.event.is_terminal_seal() {
        set_chain_read_only(chain_directory)?;
        sync_directory(chain_directory, receipt.sha256())?;
    }
    Ok(AppendOutcome::Created)
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

    let stage = operation_directory.join(staging_file_name(receipt.record.sequence)?);
    write_staging(&stage, &receipt.bytes)?;
    if publish_noreplace(&stage, &target).is_err() {
        let _ = fs::remove_file(&stage);
        match target.try_exists() {
            Ok(true) => {
                let existing = read_operation_receipt(&target, &canonical_parent)?;
                if existing.bytes == receipt.bytes {
                    sync_directory(operation_directory, &receipt.sha256)?;
                    return Ok(AppendOutcome::ExistingExact);
                }
                return Err(ReceiptError::Conflict);
            }
            Ok(false) | Err(_) => {
                return Err(ReceiptError::DurabilityUnknown {
                    expected_sha256: receipt.sha256.clone(),
                });
            }
        }
    }
    sync_directory(operation_directory, &receipt.sha256)?;
    let installed = read_operation_receipt(&target, &canonical_parent)?;
    if installed.bytes != receipt.bytes || installed.sha256 != receipt.sha256 {
        return Err(ReceiptError::Conflict);
    }
    if receipt.record.sequence == MAX_OPERATION_RECEIPTS_PER_CHAIN {
        set_chain_read_only(operation_directory)?;
        sync_directory(operation_directory, &receipt.sha256)?;
    }
    Ok(AppendOutcome::Created)
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
    Ok(VerifiedReceiptChain {
        authorization_id_sha256: authorization_id_sha256.to_owned(),
        receipt_count,
        head_sha256: head.sha256,
        sealed,
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
) -> Result<(), ReceiptError> {
    let created = match fs::create_dir(directory) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(ReceiptError::Io(label)),
    };
    require_fixed_directory(directory, expected_parent, label)?;
    if created {
        sync_directory(expected_parent, "directory")?;
    }
    Ok(())
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
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ReceiptError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
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
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(ReceiptError::Io("create_staging"));
    }
    let file = unsafe { fs::File::from_raw_fd(descriptor) };
    write_staging_file(file, bytes)
}

#[cfg(not(target_os = "linux"))]
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ReceiptError> {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| ReceiptError::Io("create_staging"))?;
    write_staging_file(file, bytes)
}

fn write_staging_file(mut file: fs::File, bytes: &[u8]) -> Result<(), ReceiptError> {
    file.write_all(bytes)
        .map_err(|_| ReceiptError::Io("write_staging"))?;
    file.flush()
        .map_err(|_| ReceiptError::Io("flush_staging"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ReceiptError::Io("seek_staging"))?;
    let mut readback = Vec::with_capacity(bytes.len());
    Read::by_ref(&mut file)
        .take((MAX_RECEIPT_BYTES + 1) as u64)
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

#[cfg(target_os = "linux")]
fn publish_noreplace(staging: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if staging.parent() != Some(parent) {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let directory = open_linux_directory(parent)?;
    let staging = CString::new(
        staging
            .file_name()
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?
            .as_bytes(),
    )
    .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let target = CString::new(
        target
            .file_name()
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?
            .as_bytes(),
    )
    .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            staging.as_ptr(),
            directory.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
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

fn receipt_file_name(sequence: u64) -> String {
    format!("{sequence:020}{RECEIPT_FILE_SUFFIX}")
}

fn operation_receipt_file_name(sequence: u64) -> String {
    format!("{sequence:020}{OPERATION_RECEIPT_FILE_SUFFIX}")
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
        let metadata = match read_directory_entry_metadata(&entry.path(), valid_staging)? {
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
        if valid_staging {
            continue;
        }
        return Err(ReceiptError::UnsafeFilesystem("operation_entry_name"));
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
