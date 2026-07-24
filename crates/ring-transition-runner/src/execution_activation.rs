use crate::credentials::CredentialIdentity;
use crate::orchestrator::{self, ServiceTarget, SnapshotClaim};
use crate::publication::{ActivatedPublication, PublicationIdentity};
use crate::release::{
    canonical_json, parse_canonical_json, read_stable_regular_file, sha256_hex,
    ReleaseVerificationError, MAX_SAFE_INTEGER,
};
use crate::STAGING_AUTHORITY_ORIGIN;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const EXECUTION_ACTIVATION_TRUST_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-execution-activation-trust-v1";
pub const EXECUTION_ACTIVATION_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-execution-activation-v1";
pub const CLAIM_REQUEST_CONTRACT: &str = "cinatoken-ring-transition-claim-request-v1";
pub const CLAIM_PERMIT_CONTRACT: &str = "cinatoken-ring-transition-claim-permit-v1";
pub const CLAIM_PERMIT_DOMAIN: &[u8] = b"cinatoken-ring-transition-claim-permit-v1\n";
pub const CLAIMS_PATH: &str = "/internal/v1/ring-transition/claims";
pub const CLAIM_DISPATCH_CONTRACT: &str = "cinatoken-ring-transition-runner-claim-dispatch-v1";

const EXECUTION_ACTIVATIONS_DIRECTORY_NAME: &str = "execution-activations";
const EXECUTION_ACTIVATION_FILE_SUFFIX: &str = ".execution-activation.json";
const CLAIM_DISPATCH_FILE_SUFFIX: &str = ".claim-dispatch.json";
const MAX_EXECUTION_ACTIVATION_BYTES: usize = 128 * 1024;
const MAX_CLAIM_REQUEST_BYTES: usize = 64 * 1024;
const MAXIMUM_RESPONSE_BYTES: u64 = 256 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS: u64 = 10_000;
const MAXIMUM_CLAIM_LIFETIME_SECONDS: u64 = 600;
const MINIMUM_CLAIM_REMAINING_SECONDS: u64 = 60;
const MAXIMUM_PERMIT_LIFETIME_SECONDS: u64 = 60;
const MAXIMUM_CLOCK_SKEW_SECONDS: u64 = 5;
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedExecutionActivationTrust {
    pub schema_version: u8,
    pub contract: &'static str,
    pub enabled: bool,
    pub environment: &'static str,
    pub authority_origin: Option<&'static str>,
    pub claim_path: &'static str,
    pub permit_issuer: Option<&'static str>,
    pub permit_key_id: Option<&'static str>,
    pub permit_spki_sha256: Option<&'static str>,
    pub ledger_identity_sha256: Option<&'static str>,
    pub transition_policy_sha256: Option<&'static str>,
    pub authorization_policy_sha256: Option<&'static str>,
    pub account_id_sha256: Option<&'static str>,
    pub read_credential_id_sha256: Option<&'static str>,
    pub claim_credential_id_sha256: Option<&'static str>,
    pub deploy_credential_id_sha256: Option<&'static str>,
    pub controller_service_name: Option<&'static str>,
    pub edge_service_name: Option<&'static str>,
    pub runner_trust_config_sha256: Option<&'static str>,
}

impl EmbeddedExecutionActivationTrust {
    pub const fn checked_in() -> Self {
        Self {
            schema_version: 1,
            contract: EXECUTION_ACTIVATION_TRUST_CONTRACT,
            enabled: false,
            environment: "staging",
            authority_origin: None,
            claim_path: CLAIMS_PATH,
            permit_issuer: None,
            permit_key_id: None,
            permit_spki_sha256: None,
            ledger_identity_sha256: None,
            transition_policy_sha256: None,
            authorization_policy_sha256: None,
            account_id_sha256: None,
            read_credential_id_sha256: None,
            claim_credential_id_sha256: None,
            deploy_credential_id_sha256: None,
            controller_service_name: None,
            edge_service_name: None,
            runner_trust_config_sha256: None,
        }
    }

    fn validate_for_publication(
        &self,
        publication: &PublicationIdentity,
    ) -> Result<ValidatedExecutionActivationTrust<'_>, ExecutionActivationError> {
        if !self.enabled {
            return Err(ExecutionActivationError::TrustDisabled);
        }
        let authority_origin =
            self.authority_origin
                .ok_or(ExecutionActivationError::MissingTrustField(
                    "authority_origin",
                ))?;
        if self.schema_version != 1
            || self.contract != EXECUTION_ACTIVATION_TRUST_CONTRACT
            || self.environment != "staging"
            || authority_origin != STAGING_AUTHORITY_ORIGIN
            || self.claim_path != CLAIMS_PATH
        {
            return Err(ExecutionActivationError::TrustContractMismatch);
        }

        let permit_issuer =
            required_token(self.permit_issuer, "permit_issuer", 128, identity_byte)?;
        let permit_key_id = required_token(self.permit_key_id, "permit_key_id", 64, key_id_byte)?;
        let permit_spki_sha256 = required_sha256(self.permit_spki_sha256, "permit_spki_sha256")?;
        let ledger_identity_sha256 =
            required_sha256(self.ledger_identity_sha256, "ledger_identity_sha256")?;
        let transition_policy_sha256 =
            required_sha256(self.transition_policy_sha256, "transition_policy_sha256")?;
        let authorization_policy_sha256 = required_sha256(
            self.authorization_policy_sha256,
            "authorization_policy_sha256",
        )?;
        let account_id_sha256 = required_sha256(self.account_id_sha256, "account_id_sha256")?;
        let read_credential_id_sha256 =
            required_sha256(self.read_credential_id_sha256, "read_credential_id_sha256")?;
        let claim_credential_id_sha256 = required_sha256(
            self.claim_credential_id_sha256,
            "claim_credential_id_sha256",
        )?;
        let deploy_credential_id_sha256 = required_sha256(
            self.deploy_credential_id_sha256,
            "deploy_credential_id_sha256",
        )?;
        let controller_service_name = required_token(
            self.controller_service_name,
            "controller_service_name",
            63,
            service_name_byte,
        )?;
        let edge_service_name = required_token(
            self.edge_service_name,
            "edge_service_name",
            63,
            service_name_byte,
        )?;
        let runner_trust_config_sha256 = required_sha256(
            self.runner_trust_config_sha256,
            "runner_trust_config_sha256",
        )?;

        if transition_policy_sha256 == authorization_policy_sha256
            || controller_service_name == edge_service_name
            || read_credential_id_sha256 == claim_credential_id_sha256
            || read_credential_id_sha256 == deploy_credential_id_sha256
            || claim_credential_id_sha256 == deploy_credential_id_sha256
        {
            return Err(ExecutionActivationError::InvalidTrustField(
                "identity_separation",
            ));
        }
        if publication.release.permit_spki_sha256 != permit_spki_sha256
            || publication.release.trust_config_sha256 != runner_trust_config_sha256
            || publication.release.release_key_spki_sha256 == permit_spki_sha256
        {
            return Err(ExecutionActivationError::PublicationIdentityMismatch(
                "trust",
            ));
        }

        Ok(ValidatedExecutionActivationTrust {
            authority_origin,
            permit_issuer,
            permit_key_id,
            permit_spki_sha256,
            ledger_identity_sha256,
            transition_policy_sha256,
            authorization_policy_sha256,
            account_id_sha256,
            read_credential_id_sha256,
            claim_credential_id_sha256,
            deploy_credential_id_sha256,
            controller_service_name,
            edge_service_name,
            runner_trust_config_sha256,
        })
    }
}

#[derive(Clone, Copy)]
struct ValidatedExecutionActivationTrust<'a> {
    authority_origin: &'a str,
    permit_issuer: &'a str,
    permit_key_id: &'a str,
    permit_spki_sha256: &'a str,
    ledger_identity_sha256: &'a str,
    transition_policy_sha256: &'a str,
    authorization_policy_sha256: &'a str,
    account_id_sha256: &'a str,
    read_credential_id_sha256: &'a str,
    claim_credential_id_sha256: &'a str,
    deploy_credential_id_sha256: &'a str,
    controller_service_name: &'a str,
    edge_service_name: &'a str,
    runner_trust_config_sha256: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExecutionActivationRecord {
    schema_version: u8,
    contract: String,
    environment: String,
    publication: ExecutionPublicationBinding,
    locator: ExecutionLocator,
    permit_spki_base64url: String,
    claim_request: ClaimRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExecutionPublicationBinding {
    publication_manifest_sha256: String,
    publication_packet_sha256: String,
    generation_sha256: String,
    activation_sequence: u64,
    runner_build_sha256: String,
    runner_trust_config_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExecutionLocator {
    method: String,
    authority_origin: String,
    path: String,
    retry: bool,
    timeout_milliseconds: u64,
    maximum_response_bytes: u64,
    access_service_token_required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClaimRequest {
    schema_version: u8,
    contract: String,
    claim: ActivationClaim,
    permit: ClaimPermit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActivationClaim {
    schema_version: u8,
    contract: String,
    claim_authority: String,
    claim_scope: String,
    environment: String,
    authorization_id_sha256: String,
    execution_nonce_sha256: String,
    authorization_manifest_sha256: String,
    authorization_subject_sha256: String,
    authorization_policy_sha256: String,
    transition_manifest_sha256: String,
    transition_subject_sha256: String,
    transition_policy_sha256: String,
    transition_plan_sha256: String,
    candidate_sha256: String,
    execution_plan_sha256: String,
    account_id_sha256: String,
    ledger_identity_sha256: String,
    read_credential_id_sha256: String,
    claim_credential_id_sha256: String,
    deploy_credential_id_sha256: String,
    controller: ServiceTarget,
    edge: ServiceTarget,
    runner_build_sha256: String,
    runner_trust_config_sha256: String,
    claim_owner_sha256: String,
    generated_at: u64,
    expires_at: u64,
    claim_digest_sha256: String,
}

impl ActivationClaim {
    fn snapshot_claim(&self) -> SnapshotClaim {
        SnapshotClaim {
            schema_version: self.schema_version,
            claim_authority: self.claim_authority.clone(),
            claim_scope: self.claim_scope.clone(),
            environment: self.environment.clone(),
            authorization_id_sha256: self.authorization_id_sha256.clone(),
            execution_nonce_sha256: self.execution_nonce_sha256.clone(),
            authorization_manifest_sha256: self.authorization_manifest_sha256.clone(),
            authorization_subject_sha256: self.authorization_subject_sha256.clone(),
            authorization_policy_sha256: self.authorization_policy_sha256.clone(),
            transition_manifest_sha256: self.transition_manifest_sha256.clone(),
            transition_subject_sha256: self.transition_subject_sha256.clone(),
            transition_policy_sha256: self.transition_policy_sha256.clone(),
            transition_plan_sha256: self.transition_plan_sha256.clone(),
            candidate_sha256: self.candidate_sha256.clone(),
            execution_plan_sha256: self.execution_plan_sha256.clone(),
            account_id_sha256: self.account_id_sha256.clone(),
            ledger_identity_sha256: self.ledger_identity_sha256.clone(),
            read_credential_id_sha256: self.read_credential_id_sha256.clone(),
            claim_credential_id_sha256: self.claim_credential_id_sha256.clone(),
            deploy_credential_id_sha256: self.deploy_credential_id_sha256.clone(),
            controller: self.controller.clone(),
            edge: self.edge.clone(),
            runner_build_sha256: self.runner_build_sha256.clone(),
            runner_trust_config_sha256: self.runner_trust_config_sha256.clone(),
            claim_owner_sha256: self.claim_owner_sha256.clone(),
            claim_digest_sha256: self.claim_digest_sha256.clone(),
            generated_at: self.generated_at,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClaimPermit {
    schema_version: u8,
    contract: String,
    issuer: String,
    key_id: String,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    claim_owner_sha256: String,
    ledger_identity_sha256: String,
    claim_credential_id_sha256: String,
    issued_at: u64,
    expires_at: u64,
    signature_base64url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedClaimPermit<'a> {
    schema_version: u8,
    contract: &'a str,
    issuer: &'a str,
    key_id: &'a str,
    authorization_id_sha256: &'a str,
    claim_digest_sha256: &'a str,
    claim_owner_sha256: &'a str,
    ledger_identity_sha256: &'a str,
    claim_credential_id_sha256: &'a str,
    issued_at: u64,
    expires_at: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ExecutionActivationIdentity {
    activation_sha256: String,
    activation_file_name: String,
    publication_manifest_sha256: String,
    activation_sequence: u64,
    runner_build_sha256: String,
    runner_trust_config_sha256: String,
    authorization_id_sha256: String,
    execution_nonce_sha256: String,
    claim_digest_sha256: String,
    claim_owner_sha256: String,
    ledger_identity_sha256: String,
    account_id_sha256: String,
    read_credential_id_sha256: String,
    claim_credential_id_sha256: String,
    deploy_credential_id_sha256: String,
    permit_spki_sha256: String,
    controller_service_name: String,
    edge_service_name: String,
    claim_request_sha256: String,
    claim_request_bytes: Vec<u8>,
    claim_generated_at: u64,
    permit_expires_at: u64,
    claim_expires_at: u64,
}

impl ExecutionActivationIdentity {
    pub fn activation_sha256(&self) -> &str {
        &self.activation_sha256
    }

    pub fn authorization_id_sha256(&self) -> &str {
        &self.authorization_id_sha256
    }

    pub fn execution_nonce_sha256(&self) -> &str {
        &self.execution_nonce_sha256
    }

    pub fn claim_digest_sha256(&self) -> &str {
        &self.claim_digest_sha256
    }

    pub fn claim_owner_sha256(&self) -> &str {
        &self.claim_owner_sha256
    }

    pub fn ledger_identity_sha256(&self) -> &str {
        &self.ledger_identity_sha256
    }

    pub fn claim_request_sha256(&self) -> &str {
        &self.claim_request_sha256
    }

    pub fn permit_expires_at(&self) -> u64 {
        self.permit_expires_at
    }

    pub fn claim_expires_at(&self) -> u64 {
        self.claim_expires_at
    }

    pub(crate) fn claim_request_bytes(&self) -> &[u8] {
        &self.claim_request_bytes
    }

    pub fn claim_generated_at(&self) -> u64 {
        self.claim_generated_at
    }

    #[cfg(test)]
    pub(crate) fn for_transport_test(
        claim_request_bytes: Vec<u8>,
        authorization_id_sha256: String,
        claim_digest_sha256: String,
        claim_owner_sha256: String,
        ledger_identity_sha256: String,
        generated_at: u64,
        expires_at: u64,
    ) -> Self {
        Self {
            activation_sha256: "8".repeat(64),
            activation_file_name: format!("{}.execution-activation.json", "7".repeat(64)),
            publication_manifest_sha256: "7".repeat(64),
            activation_sequence: 1,
            runner_build_sha256: "3".repeat(64),
            runner_trust_config_sha256: "4".repeat(64),
            authorization_id_sha256,
            execution_nonce_sha256: "2".repeat(64),
            claim_digest_sha256,
            claim_owner_sha256,
            ledger_identity_sha256,
            account_id_sha256: "c".repeat(64),
            read_credential_id_sha256: "e".repeat(64),
            claim_credential_id_sha256: "f".repeat(64),
            deploy_credential_id_sha256: "0".repeat(64),
            permit_spki_sha256: "6".repeat(64),
            controller_service_name: "controller-staging".to_owned(),
            edge_service_name: "edge-staging".to_owned(),
            claim_request_sha256: sha256_hex(&claim_request_bytes),
            claim_request_bytes,
            claim_generated_at: generated_at,
            permit_expires_at: generated_at + 60,
            claim_expires_at: expires_at,
        }
    }

    pub(crate) fn validate_credential_identity(
        &self,
        credentials: &CredentialIdentity,
    ) -> Result<(), ExecutionActivationError> {
        if credentials.activation_sequence != self.activation_sequence {
            return Err(ExecutionActivationError::CredentialIdentityMismatch(
                "activation_sequence",
            ));
        }
        for (field, actual, expected) in [
            (
                "publication_manifest_sha256",
                credentials.publication_manifest_sha256.as_str(),
                self.publication_manifest_sha256.as_str(),
            ),
            (
                "runner_build_sha256",
                credentials.runner_build_sha256.as_str(),
                self.runner_build_sha256.as_str(),
            ),
            (
                "runner_trust_config_sha256",
                credentials.trust_config_sha256.as_str(),
                self.runner_trust_config_sha256.as_str(),
            ),
            (
                "account_id_sha256",
                credentials.account_id_sha256.as_str(),
                self.account_id_sha256.as_str(),
            ),
            (
                "read_credential_id_sha256",
                credentials.read_credential_id_sha256.as_str(),
                self.read_credential_id_sha256.as_str(),
            ),
            (
                "claim_credential_id_sha256",
                credentials.claim_credential_id_sha256.as_str(),
                self.claim_credential_id_sha256.as_str(),
            ),
            (
                "deploy_credential_id_sha256",
                credentials.deploy_credential_id_sha256.as_str(),
                self.deploy_credential_id_sha256.as_str(),
            ),
            (
                "permit_spki_sha256",
                credentials.permit_spki_sha256.as_str(),
                self.permit_spki_sha256.as_str(),
            ),
            (
                "controller_service_name",
                credentials.controller_service_name.as_str(),
                self.controller_service_name.as_str(),
            ),
            (
                "edge_service_name",
                credentials.edge_service_name.as_str(),
                self.edge_service_name.as_str(),
            ),
        ] {
            if actual != expected {
                return Err(ExecutionActivationError::CredentialIdentityMismatch(field));
            }
        }
        Ok(())
    }
}

impl fmt::Debug for ExecutionActivationIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionActivationIdentity")
            .field("activation_sha256", &self.activation_sha256)
            .field(
                "publication_manifest_sha256",
                &self.publication_manifest_sha256,
            )
            .field("activation_sequence", &self.activation_sequence)
            .field("authorization_id_sha256", &self.authorization_id_sha256)
            .field("claim_digest_sha256", &self.claim_digest_sha256)
            .field("claim_owner_sha256", &self.claim_owner_sha256)
            .field("claim_request_sha256", &self.claim_request_sha256)
            .field("permit_expires_at", &self.permit_expires_at)
            .field("claim_expires_at", &self.claim_expires_at)
            .finish_non_exhaustive()
    }
}

pub struct VerifiedExecutionActivation {
    identity: ExecutionActivationIdentity,
    publication: PublicationIdentity,
    bytes: Vec<u8>,
}

impl VerifiedExecutionActivation {
    pub fn identity(&self) -> &ExecutionActivationIdentity {
        &self.identity
    }

    pub fn publication(&self) -> &PublicationIdentity {
        &self.publication
    }
}

impl fmt::Debug for VerifiedExecutionActivation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedExecutionActivation")
            .field("identity", &self.identity)
            .field("publication", &self.publication)
            .field("activation_bytes", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

pub(crate) struct ActivatedExecution {
    publication: PublicationIdentity,
    identity: ExecutionActivationIdentity,
    dispatch_location: ClaimDispatchLocation,
}

impl ActivatedExecution {
    pub(crate) fn into_parts(
        self,
    ) -> (
        PublicationIdentity,
        ExecutionActivationIdentity,
        ClaimDispatchLocation,
    ) {
        (self.publication, self.identity, self.dispatch_location)
    }
}

pub(crate) struct ClaimDispatchLocation {
    installation_root: PathBuf,
    directory: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClaimDispatchReservation {
    Fresh,
    Existing,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClaimDispatchRecord {
    schema_version: u8,
    contract: String,
    environment: String,
    activation_sha256: String,
    publication_manifest_sha256: String,
    activation_sequence: u64,
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    claim_owner_sha256: String,
    claim_request_sha256: String,
    post_request_id_sha256: String,
    reserved_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionActivationInstallOutcome {
    Created,
    ExistingExact,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledExecutionActivation {
    pub identity: ExecutionActivationIdentity,
    pub activation_file: PathBuf,
    pub outcome: ExecutionActivationInstallOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionActivationError {
    TrustDisabled,
    TrustContractMismatch,
    MissingTrustField(&'static str),
    InvalidTrustField(&'static str),
    InvalidJson,
    NonCanonicalJson,
    InvalidField(&'static str),
    DigestMismatch(&'static str),
    SignatureInvalid,
    PublicationIdentityMismatch(&'static str),
    ClaimIdentityMismatch(&'static str),
    CredentialIdentityMismatch(&'static str),
    FileInvalid(&'static str),
    InstallConflict(&'static str),
    Io(&'static str),
    DurabilityUnknown { expected_sha256: String },
}

impl fmt::Display for ExecutionActivationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustDisabled => formatter.write_str("execution activation trust is disabled"),
            Self::TrustContractMismatch => {
                formatter.write_str("execution activation trust contract mismatch")
            }
            Self::MissingTrustField(field) => {
                write!(
                    formatter,
                    "execution activation trust field missing: {field}"
                )
            }
            Self::InvalidTrustField(field) => {
                write!(
                    formatter,
                    "execution activation trust field invalid: {field}"
                )
            }
            Self::InvalidJson => formatter.write_str("execution activation JSON is invalid"),
            Self::NonCanonicalJson => {
                formatter.write_str("execution activation JSON is not canonical")
            }
            Self::InvalidField(field) => {
                write!(formatter, "execution activation field is invalid: {field}")
            }
            Self::DigestMismatch(field) => {
                write!(formatter, "execution activation digest mismatch: {field}")
            }
            Self::SignatureInvalid => {
                formatter.write_str("execution activation permit signature is invalid")
            }
            Self::PublicationIdentityMismatch(field) => {
                write!(
                    formatter,
                    "execution activation publication mismatch: {field}"
                )
            }
            Self::ClaimIdentityMismatch(field) => {
                write!(formatter, "execution activation claim mismatch: {field}")
            }
            Self::CredentialIdentityMismatch(field) => {
                write!(
                    formatter,
                    "execution activation credential mismatch: {field}"
                )
            }
            Self::FileInvalid(label) => {
                write!(formatter, "execution activation file is invalid: {label}")
            }
            Self::InstallConflict(label) => {
                write!(
                    formatter,
                    "execution activation installation conflicts at {label}"
                )
            }
            Self::Io(label) => {
                write!(formatter, "execution activation I/O failed: {label}")
            }
            Self::DurabilityUnknown { expected_sha256 } => write!(
                formatter,
                "execution activation durability is unknown for {expected_sha256}"
            ),
        }
    }
}

impl std::error::Error for ExecutionActivationError {}

pub fn verify_execution_activation_bytes(
    trust: &EmbeddedExecutionActivationTrust,
    publication: &PublicationIdentity,
    bytes: &[u8],
    now: u64,
) -> Result<VerifiedExecutionActivation, ExecutionActivationError> {
    let trust = trust.validate_for_publication(publication)?;
    let record: ExecutionActivationRecord = parse_canonical_json(
        bytes,
        MAX_EXECUTION_ACTIVATION_BYTES,
        "execution_activation",
    )
    .map_err(map_canonical_error)?;
    validate_record(&record, &trust, publication, now)?;
    let claim_request_bytes = canonical_json(&record.claim_request)
        .map_err(|_| ExecutionActivationError::InvalidField("claim_request"))?
        .into_bytes();
    if claim_request_bytes.len() > MAX_CLAIM_REQUEST_BYTES {
        return Err(ExecutionActivationError::InvalidField(
            "claim_request_bytes",
        ));
    }
    let claim = &record.claim_request.claim;
    let identity = ExecutionActivationIdentity {
        activation_sha256: sha256_hex(bytes),
        activation_file_name: activation_file_name(&publication.publication_manifest_sha256),
        publication_manifest_sha256: publication.publication_manifest_sha256.clone(),
        activation_sequence: publication.activation_sequence,
        runner_build_sha256: publication.release.artifact_sha256.clone(),
        runner_trust_config_sha256: trust.runner_trust_config_sha256.to_owned(),
        authorization_id_sha256: claim.authorization_id_sha256.clone(),
        execution_nonce_sha256: claim.execution_nonce_sha256.clone(),
        claim_digest_sha256: claim.claim_digest_sha256.clone(),
        claim_owner_sha256: claim.claim_owner_sha256.clone(),
        ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
        account_id_sha256: claim.account_id_sha256.clone(),
        read_credential_id_sha256: claim.read_credential_id_sha256.clone(),
        claim_credential_id_sha256: claim.claim_credential_id_sha256.clone(),
        deploy_credential_id_sha256: claim.deploy_credential_id_sha256.clone(),
        permit_spki_sha256: trust.permit_spki_sha256.to_owned(),
        controller_service_name: claim.controller.service_name.clone(),
        edge_service_name: claim.edge.service_name.clone(),
        claim_request_sha256: sha256_hex(&claim_request_bytes),
        claim_request_bytes,
        claim_generated_at: claim.generated_at,
        permit_expires_at: record.claim_request.permit.expires_at,
        claim_expires_at: claim.expires_at,
    };
    Ok(VerifiedExecutionActivation {
        identity,
        publication: publication.clone(),
        bytes: bytes.to_vec(),
    })
}

pub fn install_verified_execution_activation(
    installation_root: &Path,
    verified: VerifiedExecutionActivation,
) -> Result<InstalledExecutionActivation, ExecutionActivationError> {
    let canonical_root = require_installation_root(installation_root)?;
    let directory = create_fixed_directory(
        installation_root,
        &canonical_root,
        EXECUTION_ACTIVATIONS_DIRECTORY_NAME,
    )?;
    validate_activation_directory_entries(&directory)?;
    let target = directory.join(&verified.identity.activation_file_name);
    let outcome = if target
        .try_exists()
        .map_err(|_| ExecutionActivationError::Io("activation_exists"))?
    {
        let existing = read_activation_file(&target, &directory)?;
        if existing != verified.bytes {
            return Err(ExecutionActivationError::InstallConflict("activation_file"));
        }
        sync_directory(&directory, &verified.identity.activation_sha256)?;
        ExecutionActivationInstallOutcome::ExistingExact
    } else {
        let staging = directory.join(staging_file_name(
            &verified.publication.publication_manifest_sha256,
        )?);
        write_staging(&staging, &verified.bytes)?;
        match publish_noreplace(&staging, &target) {
            Ok(()) => {}
            Err(error) if is_already_exists(&error) => {
                let _ = fs::remove_file(&staging);
                let existing = read_activation_file(&target, &directory)?;
                if existing != verified.bytes {
                    return Err(ExecutionActivationError::InstallConflict("activation_file"));
                }
                sync_directory(&directory, &verified.identity.activation_sha256)?;
                return Ok(InstalledExecutionActivation {
                    identity: verified.identity,
                    activation_file: target,
                    outcome: ExecutionActivationInstallOutcome::ExistingExact,
                });
            }
            Err(_) => {
                return Err(ExecutionActivationError::DurabilityUnknown {
                    expected_sha256: verified.identity.activation_sha256,
                });
            }
        }
        sync_directory(&directory, &verified.identity.activation_sha256)?;
        let installed = read_activation_file(&target, &directory)?;
        if installed != verified.bytes
            || sha256_hex(&installed) != verified.identity.activation_sha256
        {
            return Err(ExecutionActivationError::InstallConflict(
                "activation_readback",
            ));
        }
        ExecutionActivationInstallOutcome::Created
    };

    Ok(InstalledExecutionActivation {
        identity: verified.identity,
        activation_file: target,
        outcome,
    })
}

pub(crate) fn verify_current_execution_activation(
    publication: ActivatedPublication,
    now: u64,
) -> Result<ActivatedExecution, ExecutionActivationError> {
    let publication = publication.into_identity();
    let trust = EmbeddedExecutionActivationTrust::checked_in();
    trust.validate_for_publication(&publication)?;
    let executable =
        std::env::current_exe().map_err(|_| ExecutionActivationError::FileInvalid("artifact"))?;
    let publication_directory =
        executable
            .parent()
            .ok_or(ExecutionActivationError::FileInvalid(
                "publication_directory",
            ))?;
    if publication_directory
        .file_name()
        .and_then(|value| value.to_str())
        != Some(publication.publication_directory_name.as_str())
    {
        return Err(ExecutionActivationError::PublicationIdentityMismatch(
            "publication_directory",
        ));
    }
    let publications =
        publication_directory
            .parent()
            .ok_or(ExecutionActivationError::FileInvalid(
                "publications_directory",
            ))?;
    if publications.file_name().and_then(|value| value.to_str()) != Some("publications") {
        return Err(ExecutionActivationError::FileInvalid(
            "publications_directory",
        ));
    }
    let root = publications
        .parent()
        .ok_or(ExecutionActivationError::FileInvalid("installation_root"))?;
    let directory = root.join(EXECUTION_ACTIVATIONS_DIRECTORY_NAME);
    require_fixed_directory(&directory, root, "execution_activations")?;
    validate_activation_directory_entries(&directory)?;
    let file = directory.join(activation_file_name(
        &publication.publication_manifest_sha256,
    ));
    let bytes = read_activation_file(&file, &directory)?;
    let verified = verify_execution_activation_bytes(&trust, &publication, &bytes, now)?;
    Ok(ActivatedExecution {
        publication,
        identity: verified.identity,
        dispatch_location: ClaimDispatchLocation {
            installation_root: fs::canonicalize(root)
                .map_err(|_| ExecutionActivationError::FileInvalid("installation_root"))?,
            directory: fs::canonicalize(&directory)
                .map_err(|_| ExecutionActivationError::FileInvalid("execution_activations"))?,
        },
    })
}

pub(crate) fn reserve_claim_dispatch(
    location: &ClaimDispatchLocation,
    identity: &ExecutionActivationIdentity,
    post_request_id: &str,
    now: u64,
) -> Result<ClaimDispatchReservation, ExecutionActivationError> {
    require_fixed_directory(
        &location.directory,
        &location.installation_root,
        "execution_activations",
    )?;
    validate_activation_directory_entries(&location.directory)?;
    let target = location.directory.join(format!(
        "{}{CLAIM_DISPATCH_FILE_SUFFIX}",
        identity.publication_manifest_sha256
    ));
    if target
        .try_exists()
        .map_err(|_| ExecutionActivationError::Io("claim_dispatch_exists"))?
    {
        verify_claim_dispatch_file(&target, &location.directory, identity)?;
        return Ok(ClaimDispatchReservation::Existing);
    }
    if now < identity.claim_generated_at
        || now >= identity.permit_expires_at
        || now >= identity.claim_expires_at
        || post_request_id.is_empty()
        || post_request_id.len() > 128
        || !post_request_id.is_ascii()
        || post_request_id
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(ExecutionActivationError::InvalidField(
            "claim_dispatch_window",
        ));
    }
    if identity.claim_request_bytes.is_empty()
        || identity.claim_request_bytes.len() > MAX_CLAIM_REQUEST_BYTES
        || sha256_hex(&identity.claim_request_bytes) != identity.claim_request_sha256
    {
        return Err(ExecutionActivationError::DigestMismatch(
            "claim_request_sha256",
        ));
    }
    let record = ClaimDispatchRecord {
        schema_version: 1,
        contract: CLAIM_DISPATCH_CONTRACT.to_owned(),
        environment: "staging".to_owned(),
        activation_sha256: identity.activation_sha256.clone(),
        publication_manifest_sha256: identity.publication_manifest_sha256.clone(),
        activation_sequence: identity.activation_sequence,
        authorization_id_sha256: identity.authorization_id_sha256.clone(),
        claim_digest_sha256: identity.claim_digest_sha256.clone(),
        claim_owner_sha256: identity.claim_owner_sha256.clone(),
        claim_request_sha256: identity.claim_request_sha256.clone(),
        post_request_id_sha256: sha256_hex(post_request_id.as_bytes()),
        reserved_at: now,
    };
    let bytes = canonical_json(&record)
        .map_err(|_| ExecutionActivationError::InvalidField("claim_dispatch"))?
        .into_bytes();
    let expected_sha256 = sha256_hex(&bytes);
    if let Err(_error) = write_staging(&target, &bytes) {
        if target.try_exists().unwrap_or(false) {
            verify_claim_dispatch_file(&target, &location.directory, identity)?;
            return Ok(ClaimDispatchReservation::Existing);
        }
        return Err(ExecutionActivationError::DurabilityUnknown { expected_sha256 });
    }
    sync_directory(&location.directory, &expected_sha256)?;
    let installed = read_activation_file(&target, &location.directory)?;
    if installed != bytes || sha256_hex(&installed) != expected_sha256 {
        return Err(ExecutionActivationError::InstallConflict(
            "claim_dispatch_readback",
        ));
    }
    verify_claim_dispatch_bytes(&installed, identity)?;
    Ok(ClaimDispatchReservation::Fresh)
}

fn verify_claim_dispatch_file(
    path: &Path,
    directory: &Path,
    identity: &ExecutionActivationIdentity,
) -> Result<(), ExecutionActivationError> {
    let bytes = read_activation_file(path, directory)?;
    verify_claim_dispatch_bytes(&bytes, identity)
}

fn verify_claim_dispatch_bytes(
    bytes: &[u8],
    identity: &ExecutionActivationIdentity,
) -> Result<(), ExecutionActivationError> {
    let record: ClaimDispatchRecord =
        parse_canonical_json(bytes, MAX_EXECUTION_ACTIVATION_BYTES, "claim_dispatch")
            .map_err(map_canonical_error)?;
    if record.schema_version != 1
        || record.contract != CLAIM_DISPATCH_CONTRACT
        || record.environment != "staging"
        || record.activation_sha256 != identity.activation_sha256
        || record.publication_manifest_sha256 != identity.publication_manifest_sha256
        || record.activation_sequence != identity.activation_sequence
        || record.authorization_id_sha256 != identity.authorization_id_sha256
        || record.claim_digest_sha256 != identity.claim_digest_sha256
        || record.claim_owner_sha256 != identity.claim_owner_sha256
        || record.claim_request_sha256 != identity.claim_request_sha256
        || !valid_sha256(&record.post_request_id_sha256)
        || record.reserved_at < identity.claim_generated_at
        || record.reserved_at >= identity.permit_expires_at
        || record.reserved_at >= identity.claim_expires_at
    {
        return Err(ExecutionActivationError::InstallConflict(
            "claim_dispatch_identity",
        ));
    }
    Ok(())
}

fn validate_record(
    record: &ExecutionActivationRecord,
    trust: &ValidatedExecutionActivationTrust<'_>,
    publication: &PublicationIdentity,
    now: u64,
) -> Result<(), ExecutionActivationError> {
    if record.schema_version != 1
        || record.contract != EXECUTION_ACTIVATION_CONTRACT
        || record.environment != "staging"
    {
        return Err(ExecutionActivationError::InvalidField(
            "activation_contract",
        ));
    }
    let binding = &record.publication;
    if binding.publication_manifest_sha256 != publication.publication_manifest_sha256
        || binding.publication_packet_sha256 != publication.publication_packet_sha256
        || binding.generation_sha256 != publication.generation_sha256
        || binding.activation_sequence != publication.activation_sequence
        || binding.runner_build_sha256 != publication.release.artifact_sha256
        || binding.runner_trust_config_sha256 != publication.release.trust_config_sha256
    {
        return Err(ExecutionActivationError::PublicationIdentityMismatch(
            "binding",
        ));
    }
    let locator = &record.locator;
    if locator.method != "POST"
        || locator.authority_origin != trust.authority_origin
        || locator.path != CLAIMS_PATH
        || locator.retry
        || locator.timeout_milliseconds != REQUEST_TIMEOUT_MILLISECONDS
        || locator.maximum_response_bytes != MAXIMUM_RESPONSE_BYTES
        || !locator.access_service_token_required
    {
        return Err(ExecutionActivationError::InvalidField("locator"));
    }

    let spki = decode_base64url(
        &record.permit_spki_base64url,
        ED25519_SPKI_PREFIX.len() + 32,
        512,
        "permit_spki",
    )?;
    if sha256_hex(&spki) != trust.permit_spki_sha256 {
        return Err(ExecutionActivationError::DigestMismatch("permit_spki"));
    }
    if record.claim_request.schema_version != 1
        || record.claim_request.contract != CLAIM_REQUEST_CONTRACT
    {
        return Err(ExecutionActivationError::InvalidField(
            "claim_request_contract",
        ));
    }
    let claim = &record.claim_request.claim;
    if claim.contract != orchestrator::CLAIM_CONTRACT {
        return Err(ExecutionActivationError::InvalidField("claim_contract"));
    }
    let snapshot_claim = claim.snapshot_claim();
    orchestrator::validate_activation_claim(&snapshot_claim)
        .map_err(|_| ExecutionActivationError::InvalidField("claim"))?;
    validate_claim_identity(claim, trust, publication)?;
    validate_permit(&record.claim_request.permit, claim, trust, &spki, now)
}

fn validate_claim_identity(
    claim: &ActivationClaim,
    trust: &ValidatedExecutionActivationTrust<'_>,
    publication: &PublicationIdentity,
) -> Result<(), ExecutionActivationError> {
    for (field, actual, expected) in [
        (
            "authorization_policy_sha256",
            claim.authorization_policy_sha256.as_str(),
            trust.authorization_policy_sha256,
        ),
        (
            "transition_policy_sha256",
            claim.transition_policy_sha256.as_str(),
            trust.transition_policy_sha256,
        ),
        (
            "account_id_sha256",
            claim.account_id_sha256.as_str(),
            trust.account_id_sha256,
        ),
        (
            "ledger_identity_sha256",
            claim.ledger_identity_sha256.as_str(),
            trust.ledger_identity_sha256,
        ),
        (
            "read_credential_id_sha256",
            claim.read_credential_id_sha256.as_str(),
            trust.read_credential_id_sha256,
        ),
        (
            "claim_credential_id_sha256",
            claim.claim_credential_id_sha256.as_str(),
            trust.claim_credential_id_sha256,
        ),
        (
            "deploy_credential_id_sha256",
            claim.deploy_credential_id_sha256.as_str(),
            trust.deploy_credential_id_sha256,
        ),
        (
            "controller_service_name",
            claim.controller.service_name.as_str(),
            trust.controller_service_name,
        ),
        (
            "edge_service_name",
            claim.edge.service_name.as_str(),
            trust.edge_service_name,
        ),
        (
            "runner_build_sha256",
            claim.runner_build_sha256.as_str(),
            publication.release.artifact_sha256.as_str(),
        ),
        (
            "runner_trust_config_sha256",
            claim.runner_trust_config_sha256.as_str(),
            trust.runner_trust_config_sha256,
        ),
    ] {
        if actual != expected {
            return Err(ExecutionActivationError::ClaimIdentityMismatch(field));
        }
    }
    Ok(())
}

fn validate_permit(
    permit: &ClaimPermit,
    claim: &ActivationClaim,
    trust: &ValidatedExecutionActivationTrust<'_>,
    spki: &[u8],
    now: u64,
) -> Result<(), ExecutionActivationError> {
    if permit.schema_version != 1
        || permit.contract != CLAIM_PERMIT_CONTRACT
        || permit.issuer != trust.permit_issuer
        || permit.key_id != trust.permit_key_id
    {
        return Err(ExecutionActivationError::InvalidField("permit_contract"));
    }
    for (field, actual, expected) in [
        (
            "authorization_id_sha256",
            permit.authorization_id_sha256.as_str(),
            claim.authorization_id_sha256.as_str(),
        ),
        (
            "claim_digest_sha256",
            permit.claim_digest_sha256.as_str(),
            claim.claim_digest_sha256.as_str(),
        ),
        (
            "claim_owner_sha256",
            permit.claim_owner_sha256.as_str(),
            claim.claim_owner_sha256.as_str(),
        ),
        (
            "ledger_identity_sha256",
            permit.ledger_identity_sha256.as_str(),
            claim.ledger_identity_sha256.as_str(),
        ),
        (
            "claim_credential_id_sha256",
            permit.claim_credential_id_sha256.as_str(),
            claim.claim_credential_id_sha256.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(ExecutionActivationError::ClaimIdentityMismatch(field));
        }
    }
    if permit.issued_at < claim.generated_at
        || permit.expires_at <= permit.issued_at
        || permit.expires_at - permit.issued_at > MAXIMUM_PERMIT_LIFETIME_SECONDS
        || permit.expires_at > claim.expires_at
        || permit.issued_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || now.saturating_sub(permit.issued_at) > MAXIMUM_PERMIT_LIFETIME_SECONDS
        || permit.expires_at <= now
        || claim.generated_at > now
        || claim.expires_at < now.saturating_add(MINIMUM_CLAIM_REMAINING_SECONDS)
        || claim.expires_at - claim.generated_at > MAXIMUM_CLAIM_LIFETIME_SECONDS
        || claim.expires_at > MAX_SAFE_INTEGER
    {
        return Err(ExecutionActivationError::InvalidField("permit_validity"));
    }
    let signature_bytes =
        decode_base64url(&permit.signature_base64url, 64, 64, "permit_signature")?;
    let key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|value| value.try_into().ok())
        .ok_or(ExecutionActivationError::InvalidField("permit_public_key"))?;
    let verifying_key = VerifyingKey::from_bytes(key_bytes)
        .map_err(|_| ExecutionActivationError::InvalidField("permit_public_key"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| ExecutionActivationError::SignatureInvalid)?;
    let unsigned = UnsignedClaimPermit {
        schema_version: permit.schema_version,
        contract: &permit.contract,
        issuer: &permit.issuer,
        key_id: &permit.key_id,
        authorization_id_sha256: &permit.authorization_id_sha256,
        claim_digest_sha256: &permit.claim_digest_sha256,
        claim_owner_sha256: &permit.claim_owner_sha256,
        ledger_identity_sha256: &permit.ledger_identity_sha256,
        claim_credential_id_sha256: &permit.claim_credential_id_sha256,
        issued_at: permit.issued_at,
        expires_at: permit.expires_at,
    };
    let canonical =
        canonical_json(&unsigned).map_err(|_| ExecutionActivationError::InvalidField("permit"))?;
    let mut message = Vec::with_capacity(CLAIM_PERMIT_DOMAIN.len() + canonical.len());
    message.extend_from_slice(CLAIM_PERMIT_DOMAIN);
    message.extend_from_slice(canonical.as_bytes());
    verifying_key
        .verify_strict(&message, &signature)
        .map_err(|_| ExecutionActivationError::SignatureInvalid)
}

fn map_canonical_error(error: ReleaseVerificationError) -> ExecutionActivationError {
    match error {
        ReleaseVerificationError::NonCanonicalJson(_) => ExecutionActivationError::NonCanonicalJson,
        ReleaseVerificationError::InvalidJson(_) => ExecutionActivationError::InvalidJson,
        _ => ExecutionActivationError::InvalidField("canonical_json"),
    }
}

fn read_activation_file(path: &Path, parent: &Path) -> Result<Vec<u8>, ExecutionActivationError> {
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| ExecutionActivationError::FileInvalid("execution_activations"))?;
    let bytes = read_stable_regular_file(
        path,
        MAX_EXECUTION_ACTIVATION_BYTES,
        &canonical_parent,
        "execution_activation",
    )
    .map_err(|error| match error {
        ReleaseVerificationError::FileInvalid(_) => {
            ExecutionActivationError::FileInvalid("execution_activation")
        }
        _ => ExecutionActivationError::Io("read_execution_activation"),
    })?;
    require_read_only_activation_file(path)?;
    Ok(bytes)
}

#[cfg(unix)]
fn require_read_only_activation_file(path: &Path) -> Result<(), ExecutionActivationError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)
        .map_err(|_| ExecutionActivationError::FileInvalid("execution_activation_permissions"))?
        .permissions()
        .mode()
        & 0o777;
    if mode != 0o444 {
        return Err(ExecutionActivationError::FileInvalid(
            "execution_activation_permissions",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_read_only_activation_file(path: &Path) -> Result<(), ExecutionActivationError> {
    if !fs::metadata(path)
        .map_err(|_| ExecutionActivationError::FileInvalid("execution_activation_permissions"))?
        .permissions()
        .readonly()
    {
        return Err(ExecutionActivationError::FileInvalid(
            "execution_activation_permissions",
        ));
    }
    Ok(())
}

fn require_installation_root(root: &Path) -> Result<PathBuf, ExecutionActivationError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| ExecutionActivationError::FileInvalid("installation_root"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ExecutionActivationError::FileInvalid("installation_root"));
    }
    fs::canonicalize(root).map_err(|_| ExecutionActivationError::FileInvalid("installation_root"))
}

fn create_fixed_directory(
    root: &Path,
    canonical_root: &Path,
    name: &'static str,
) -> Result<PathBuf, ExecutionActivationError> {
    let directory = root.join(name);
    let created = match fs::create_dir(&directory) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(ExecutionActivationError::Io(name)),
    };
    let metadata =
        fs::symlink_metadata(&directory).map_err(|_| ExecutionActivationError::Io(name))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ExecutionActivationError::InstallConflict(name));
    }
    let canonical = fs::canonicalize(&directory).map_err(|_| ExecutionActivationError::Io(name))?;
    if canonical.parent() != Some(canonical_root) {
        return Err(ExecutionActivationError::InstallConflict(name));
    }
    if created {
        sync_directory(root, "directory")?;
    }
    Ok(directory)
}

fn require_fixed_directory(
    directory: &Path,
    expected_parent: &Path,
    label: &'static str,
) -> Result<(), ExecutionActivationError> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|_| ExecutionActivationError::FileInvalid(label))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ExecutionActivationError::FileInvalid(label));
    }
    let canonical =
        fs::canonicalize(directory).map_err(|_| ExecutionActivationError::FileInvalid(label))?;
    let parent = fs::canonicalize(expected_parent)
        .map_err(|_| ExecutionActivationError::FileInvalid(label))?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err(ExecutionActivationError::FileInvalid(label));
    }
    Ok(())
}

fn activation_file_name(publication_manifest_sha256: &str) -> String {
    format!("{publication_manifest_sha256}{EXECUTION_ACTIVATION_FILE_SUFFIX}")
}

fn staging_file_name(
    publication_manifest_sha256: &str,
) -> Result<String, ExecutionActivationError> {
    let mut random = [0_u8; 16];
    getrandom(&mut random).map_err(|_| ExecutionActivationError::Io("staging_random"))?;
    Ok(format!(
        ".{publication_manifest_sha256}.{}.staging",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn validate_activation_directory_entries(directory: &Path) -> Result<(), ExecutionActivationError> {
    for entry in fs::read_dir(directory)
        .map_err(|_| ExecutionActivationError::Io("read_activation_directory"))?
    {
        let entry = entry.map_err(|_| ExecutionActivationError::Io("read_activation_directory"))?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| ExecutionActivationError::FileInvalid("activation_entry_name"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| ExecutionActivationError::FileInvalid("activation_entry"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ExecutionActivationError::FileInvalid("activation_entry"));
        }
        if valid_activation_file_name(&file_name)
            || valid_claim_dispatch_file_name(&file_name)
            || valid_staging_file_name(&file_name)
        {
            continue;
        }
        return Err(ExecutionActivationError::FileInvalid(
            "activation_entry_name",
        ));
    }
    Ok(())
}

fn valid_activation_file_name(file_name: &str) -> bool {
    file_name
        .strip_suffix(EXECUTION_ACTIVATION_FILE_SUFFIX)
        .is_some_and(valid_sha256)
}

fn valid_claim_dispatch_file_name(file_name: &str) -> bool {
    file_name
        .strip_suffix(CLAIM_DISPATCH_FILE_SUFFIX)
        .is_some_and(valid_sha256)
}

fn valid_staging_file_name(file_name: &str) -> bool {
    let Some(value) = file_name
        .strip_prefix('.')
        .and_then(|value| value.strip_suffix(".staging"))
    else {
        return false;
    };
    let Some((publication, random)) = value.split_once('.') else {
        return false;
    };
    valid_sha256(publication)
        && random.len() == 32
        && random
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(target_os = "linux")]
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ExecutionActivationError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let parent = path
        .parent()
        .ok_or(ExecutionActivationError::FileInvalid("staging_parent"))?;
    let file_name = path
        .file_name()
        .ok_or(ExecutionActivationError::FileInvalid("staging_name"))?;
    let directory = open_linux_directory(parent)
        .map_err(|_| ExecutionActivationError::FileInvalid("staging_parent"))?;
    let file_name = CString::new(file_name.as_bytes())
        .map_err(|_| ExecutionActivationError::FileInvalid("staging_name"))?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(ExecutionActivationError::Io("create_staging"));
    }
    let file = unsafe { fs::File::from_raw_fd(descriptor) };
    write_staging_file(file, bytes)
}

#[cfg(not(target_os = "linux"))]
fn write_staging(path: &Path, bytes: &[u8]) -> Result<(), ExecutionActivationError> {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| ExecutionActivationError::Io("create_staging"))?;
    write_staging_file(file, bytes)
}

fn write_staging_file(mut file: fs::File, bytes: &[u8]) -> Result<(), ExecutionActivationError> {
    file.write_all(bytes)
        .map_err(|_| ExecutionActivationError::Io("write_staging"))?;
    file.flush()
        .map_err(|_| ExecutionActivationError::Io("flush_staging"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| ExecutionActivationError::Io("seek_staging"))?;
    let mut readback = Vec::with_capacity(bytes.len());
    Read::by_ref(&mut file)
        .take((MAX_EXECUTION_ACTIVATION_BYTES + 1) as u64)
        .read_to_end(&mut readback)
        .map_err(|_| ExecutionActivationError::Io("readback_staging"))?;
    if readback != bytes {
        return Err(ExecutionActivationError::InstallConflict(
            "staging_readback",
        ));
    }
    set_file_read_only(&file)?;
    file.sync_all()
        .map_err(|_| ExecutionActivationError::Io("sync_staging"))
}

#[cfg(unix)]
fn set_file_read_only(file: &fs::File) -> Result<(), ExecutionActivationError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o444))
        .map_err(|_| ExecutionActivationError::Io("activation_permissions"))
}

#[cfg(not(unix))]
fn set_file_read_only(file: &fs::File) -> Result<(), ExecutionActivationError> {
    let mut permissions = file
        .metadata()
        .map_err(|_| ExecutionActivationError::Io("activation_permissions"))?
        .permissions();
    permissions.set_readonly(true);
    file.set_permissions(permissions)
        .map_err(|_| ExecutionActivationError::Io("activation_permissions"))
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
fn sync_directory(path: &Path, expected_sha256: &str) -> Result<(), ExecutionActivationError> {
    open_linux_directory(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ExecutionActivationError::DurabilityUnknown {
            expected_sha256: expected_sha256.to_owned(),
        })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn sync_directory(path: &Path, expected_sha256: &str) -> Result<(), ExecutionActivationError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ExecutionActivationError::DurabilityUnknown {
            expected_sha256: expected_sha256.to_owned(),
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path, _expected_sha256: &str) -> Result<(), ExecutionActivationError> {
    // The production runner target is Linux. Windows validates bytes and replay.
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

fn is_already_exists(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists || error.raw_os_error() == Some(eexist())
}

#[cfg(target_os = "linux")]
const fn eexist() -> i32 {
    libc::EEXIST
}

#[cfg(not(target_os = "linux"))]
const fn eexist() -> i32 {
    17
}

fn decode_base64url(
    value: &str,
    minimum_bytes: usize,
    maximum_bytes: usize,
    field: &'static str,
) -> Result<Vec<u8>, ExecutionActivationError> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ExecutionActivationError::InvalidField(field));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ExecutionActivationError::InvalidField(field))?;
    if decoded.len() < minimum_bytes || decoded.len() > maximum_bytes {
        return Err(ExecutionActivationError::InvalidField(field));
    }
    Ok(decoded)
}

fn required_sha256<'a>(
    value: Option<&'a str>,
    field: &'static str,
) -> Result<&'a str, ExecutionActivationError> {
    let value = value.ok_or(ExecutionActivationError::MissingTrustField(field))?;
    if !valid_sha256(value) {
        return Err(ExecutionActivationError::InvalidTrustField(field));
    }
    Ok(value)
}

fn required_token<'a>(
    value: Option<&'a str>,
    field: &'static str,
    maximum_length: usize,
    byte: fn(u8) -> bool,
) -> Result<&'a str, ExecutionActivationError> {
    let value = value.ok_or(ExecutionActivationError::MissingTrustField(field))?;
    if value.is_empty()
        || value.len() > maximum_length
        || !value.as_bytes()[0].is_ascii_lowercase() && !value.as_bytes()[0].is_ascii_digit()
        || !value.bytes().all(byte)
    {
        return Err(ExecutionActivationError::InvalidTrustField(field));
    }
    Ok(value)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn identity_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b':' | b'-')
}

fn key_id_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
}

fn service_name_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::VerifiedRelease;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::Value;

    const NOW: u64 = 2_000_000_000;

    #[test]
    fn verifies_signed_fixed_activation_and_matches_cross_runtime_vector() {
        let fixture = fixture();
        let verified = verify_execution_activation_bytes(
            &fixture.trust,
            &fixture.publication,
            &fixture.bytes,
            NOW,
        )
        .unwrap();
        assert_eq!(
            verified.identity().authorization_id_sha256(),
            "1".repeat(64)
        );
        assert_eq!(verified.identity().execution_nonce_sha256(), "2".repeat(64));
        assert_eq!(
            verified.identity().claim_digest_sha256(),
            "378a7c0f1ca0500ff127a13c20e8e7887900568c5d8b5d66517e7d9018814085"
        );
        assert_eq!(
            verified.identity().activation_sha256(),
            "7654ae29d633a2ec759b906bd2bbfce5ce3ee5170c2dc2e77dfbfdf50ce54994"
        );
        assert_eq!(
            verified.identity().claim_request_sha256(),
            "93172b98f2afd9aafe5dd4c8e4e658090634001df60cbc276182a5443ff0e83e"
        );
        assert_eq!(verified.identity().permit_expires_at(), NOW + 59);
        assert_eq!(verified.identity().claim_expires_at(), NOW + 120);
        assert!(verified.identity().claim_request_bytes().len() < MAX_CLAIM_REQUEST_BYTES);

        let mut credentials = credential_identity(&fixture);
        verified
            .identity()
            .validate_credential_identity(&credentials)
            .unwrap();
        credentials.account_id_sha256 = "0".repeat(64);
        assert_eq!(
            verified
                .identity()
                .validate_credential_identity(&credentials)
                .unwrap_err(),
            ExecutionActivationError::CredentialIdentityMismatch("account_id_sha256")
        );
    }

    #[test]
    fn create_new_install_replays_exact_bytes_and_rejects_conflicts() {
        let root = TemporaryDirectory::new("install");
        let fixture = fixture();
        let expected_bytes = fixture.bytes.clone();
        let installed = install_verified_execution_activation(
            root.path(),
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &fixture.bytes,
                NOW,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            installed.outcome,
            ExecutionActivationInstallOutcome::Created
        );
        assert_eq!(
            fs::read(&installed.activation_file).unwrap(),
            expected_bytes
        );

        let replayed = install_verified_execution_activation(
            root.path(),
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &fixture.bytes,
                NOW,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            replayed.outcome,
            ExecutionActivationInstallOutcome::ExistingExact
        );

        make_file_writable(&replayed.activation_file);
        assert_eq!(
            install_verified_execution_activation(
                root.path(),
                verify_execution_activation_bytes(
                    &fixture.trust,
                    &fixture.publication,
                    &fixture.bytes,
                    NOW,
                )
                .unwrap(),
            )
            .unwrap_err(),
            ExecutionActivationError::FileInvalid("execution_activation_permissions")
        );
        mark_file_read_only(&replayed.activation_file);

        let conflict_root = TemporaryDirectory::new("conflict");
        let directory = conflict_root
            .path()
            .join(EXECUTION_ACTIVATIONS_DIRECTORY_NAME);
        fs::create_dir(&directory).unwrap();
        let conflict_file = directory.join(activation_file_name(
            &fixture.publication.publication_manifest_sha256,
        ));
        fs::write(&conflict_file, b"{}").unwrap();
        mark_file_read_only(&conflict_file);
        assert_eq!(
            install_verified_execution_activation(
                conflict_root.path(),
                verify_execution_activation_bytes(
                    &fixture.trust,
                    &fixture.publication,
                    &fixture.bytes,
                    NOW,
                )
                .unwrap(),
            )
            .unwrap_err(),
            ExecutionActivationError::InstallConflict("activation_file")
        );
    }

    #[test]
    fn claim_dispatch_guard_is_create_new_exact_and_restart_read_only() {
        let root = TemporaryDirectory::new("claim-dispatch");
        let fixture = fixture();
        let installed = install_verified_execution_activation(
            root.path(),
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &fixture.bytes,
                NOW,
            )
            .unwrap(),
        )
        .unwrap();
        let location = claim_dispatch_location(root.path());
        assert_eq!(
            reserve_claim_dispatch(
                &location,
                &installed.identity,
                "claim-post-request-001",
                NOW,
            )
            .unwrap(),
            ClaimDispatchReservation::Fresh
        );
        assert_eq!(
            reserve_claim_dispatch(
                &location,
                &installed.identity,
                "claim-post-request-after-restart",
                NOW + 1,
            )
            .unwrap(),
            ClaimDispatchReservation::Existing
        );

        let guard = location.directory.join(format!(
            "{}{CLAIM_DISPATCH_FILE_SUFFIX}",
            installed.identity.publication_manifest_sha256
        ));
        let bytes = read_activation_file(&guard, &location.directory).unwrap();
        verify_claim_dispatch_bytes(&bytes, &installed.identity).unwrap();
        let rendered = format!("{:?}", installed.identity);
        assert!(!rendered.contains("signatureBase64url"));
        assert!(!rendered.contains("claim-post-request"));
        assert!(!rendered
            .contains(std::str::from_utf8(installed.identity.claim_request_bytes()).unwrap()));
    }

    #[test]
    fn concurrent_claim_dispatch_reservations_mint_at_most_one_post_capability() {
        let root = TemporaryDirectory::new("claim-dispatch-race");
        let fixture = fixture();
        let installed = install_verified_execution_activation(
            root.path(),
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &fixture.bytes,
                NOW,
            )
            .unwrap(),
        )
        .unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let identity = std::sync::Arc::new(installed.identity);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut threads = Vec::new();
        for index in 0..8 {
            let root_path = root_path.clone();
            let identity = identity.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                let location = claim_dispatch_location(&root_path);
                barrier.wait();
                reserve_claim_dispatch(
                    &location,
                    &identity,
                    &format!("claim-post-race-{index}"),
                    NOW,
                )
            }));
        }
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| { matches!(result, Ok(ClaimDispatchReservation::Fresh)) })
                .count(),
            1
        );
        let final_location = claim_dispatch_location(&root_path);
        assert_eq!(
            reserve_claim_dispatch(&final_location, &identity, "claim-post-after-race", NOW + 1,)
                .unwrap(),
            ClaimDispatchReservation::Existing
        );
    }

    #[test]
    fn rejects_noncanonical_duplicate_unknown_and_signature_drift() {
        let fixture = fixture();
        let value: Value = serde_json::from_slice(&fixture.bytes).unwrap();
        let pretty = serde_json::to_vec_pretty(&value).unwrap();
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &pretty, NOW,)
                .unwrap_err(),
            ExecutionActivationError::NonCanonicalJson
        );

        let duplicate = String::from_utf8(fixture.bytes.clone())
            .unwrap()
            .replacen(
                "\"schemaVersion\":1",
                "\"schemaVersion\":1,\"schemaVersion\":1",
                1,
            )
            .into_bytes();
        assert_eq!(
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &duplicate,
                NOW,
            )
            .unwrap_err(),
            ExecutionActivationError::InvalidJson
        );

        let unknown = mutate(&fixture.bytes, |value| {
            value["unknown"] = Value::Bool(true);
        });
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &unknown, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidJson
        );

        let signature = mutate(&fixture.bytes, |value| {
            value["claimRequest"]["permit"]["signatureBase64url"] =
                Value::String(URL_SAFE_NO_PAD.encode([0_u8; 64]));
        });
        assert_eq!(
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &signature,
                NOW,
            )
            .unwrap_err(),
            ExecutionActivationError::SignatureInvalid
        );
    }

    #[test]
    fn rejects_publication_locator_claim_and_trust_drift() {
        let fixture = fixture();
        for (field, value) in [
            ("publicationManifestSha256", "0".repeat(64)),
            ("generationSha256", "0".repeat(64)),
            ("runnerBuildSha256", "0".repeat(64)),
        ] {
            let drift = mutate(&fixture.bytes, |record| {
                record["publication"][field] = Value::String(value.clone());
            });
            assert!(matches!(
                verify_execution_activation_bytes(
                    &fixture.trust,
                    &fixture.publication,
                    &drift,
                    NOW,
                ),
                Err(ExecutionActivationError::PublicationIdentityMismatch(
                    "binding"
                ))
            ));
        }

        let locator = mutate(&fixture.bytes, |record| {
            record["locator"]["path"] = Value::String("/caller/path".to_owned());
        });
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &locator, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidField("locator")
        );

        let claim = mutate(&fixture.bytes, |record| {
            record["claimRequest"]["claim"]["accountIdSha256"] = Value::String("0".repeat(64));
        });
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &claim, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidField("claim")
        );

        let mut disabled = fixture.trust.clone();
        disabled.enabled = false;
        assert_eq!(
            verify_execution_activation_bytes(
                &disabled,
                &fixture.publication,
                &fixture.bytes,
                NOW,
            )
            .unwrap_err(),
            ExecutionActivationError::TrustDisabled
        );

        let mut invalid = fixture.trust.clone();
        invalid.permit_issuer = Some("Authority");
        assert_eq!(
            verify_execution_activation_bytes(&invalid, &fixture.publication, &fixture.bytes, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidTrustField("permit_issuer")
        );

        let mut invalid = fixture.trust.clone();
        invalid.permit_key_id =
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(
            verify_execution_activation_bytes(&invalid, &fixture.publication, &fixture.bytes, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidTrustField("permit_key_id")
        );

        let mut invalid = fixture.trust.clone();
        invalid.controller_service_name = Some("-controller");
        assert_eq!(
            verify_execution_activation_bytes(&invalid, &fixture.publication, &fixture.bytes, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidTrustField("controller_service_name")
        );

        let mut key_overlap = fixture.publication.clone();
        key_overlap.release.release_key_spki_sha256 =
            fixture.trust.permit_spki_sha256.unwrap().to_owned();
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &key_overlap, &fixture.bytes, NOW,)
                .unwrap_err(),
            ExecutionActivationError::PublicationIdentityMismatch("trust")
        );
    }

    #[test]
    fn rejects_permit_identity_time_and_public_key_drift() {
        let fixture = fixture();
        let identity = mutate(&fixture.bytes, |record| {
            record["claimRequest"]["permit"]["claimOwnerSha256"] = Value::String("0".repeat(64));
        });
        assert_eq!(
            verify_execution_activation_bytes(
                &fixture.trust,
                &fixture.publication,
                &identity,
                NOW,
            )
            .unwrap_err(),
            ExecutionActivationError::ClaimIdentityMismatch("claim_owner_sha256")
        );

        let expired = mutate(&fixture.bytes, |record| {
            record["claimRequest"]["permit"]["expiresAt"] = Value::Number((NOW - 1).into());
        });
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &expired, NOW,)
                .unwrap_err(),
            ExecutionActivationError::InvalidField("permit_validity")
        );

        let spki = mutate(&fixture.bytes, |record| {
            record["permitSpkiBase64url"] = Value::String(URL_SAFE_NO_PAD.encode([7_u8; 44]));
        });
        assert_eq!(
            verify_execution_activation_bytes(&fixture.trust, &fixture.publication, &spki, NOW,)
                .unwrap_err(),
            ExecutionActivationError::DigestMismatch("permit_spki")
        );
    }

    #[test]
    fn filesystem_rejects_unknown_entries_and_source_has_no_authority_side_effects() {
        let root = TemporaryDirectory::new("entries");
        let directory = root.path().join(EXECUTION_ACTIVATIONS_DIRECTORY_NAME);
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("caller-selected.json"), b"{}").unwrap();
        let fixture = fixture();
        assert_eq!(
            install_verified_execution_activation(
                root.path(),
                verify_execution_activation_bytes(
                    &fixture.trust,
                    &fixture.publication,
                    &fixture.bytes,
                    NOW,
                )
                .unwrap(),
            )
            .unwrap_err(),
            ExecutionActivationError::FileInvalid("activation_entry_name")
        );

        let source = include_str!("execution_activation.rs");
        let forbidden = [
            ["std::env::", "var("].concat(),
            ["req", "west"].concat(),
            ["std::process::", "Command"].concat(),
            ["hyper", "::"].concat(),
            ["wrang", "ler"].concat(),
        ];
        for forbidden in &forbidden {
            assert!(!source.contains(forbidden), "{forbidden}");
        }
        assert!(source.contains("verify_current_execution_activation("));
        assert!(source.contains("RENAME_NOREPLACE"));
    }

    struct Fixture {
        trust: EmbeddedExecutionActivationTrust,
        publication: PublicationIdentity,
        bytes: Vec<u8>,
    }

    fn credential_identity(fixture: &Fixture) -> CredentialIdentity {
        CredentialIdentity {
            account_id_sha256: "c".repeat(64),
            read_credential_id_sha256: "e".repeat(64),
            claim_credential_id_sha256: "f".repeat(64),
            deploy_credential_id_sha256: "0".repeat(64),
            access_client_id_sha256: "a".repeat(64),
            authority_version_id: "authority-version-001".to_owned(),
            permit_spki_sha256: fixture.trust.permit_spki_sha256.unwrap().to_owned(),
            trust_config_sha256: fixture.publication.release.trust_config_sha256.clone(),
            publication_manifest_sha256: fixture.publication.publication_manifest_sha256.clone(),
            runner_build_sha256: fixture.publication.release.artifact_sha256.clone(),
            controller_service_name: "controller-staging".to_owned(),
            edge_service_name: "edge-staging".to_owned(),
            stable_readback_observation_seconds: 5,
            activation_sequence: fixture.publication.activation_sequence,
        }
    }

    fn fixture() -> Fixture {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(signing_key.verifying_key().as_bytes());
        let spki_sha256 = leaked(sha256_hex(&spki));
        let publication = publication(spki_sha256);
        let trust = trust(spki_sha256);
        let mut claim = ActivationClaim {
            schema_version: 1,
            contract: orchestrator::CLAIM_CONTRACT.to_owned(),
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
            runner_build_sha256: publication.release.artifact_sha256.clone(),
            runner_trust_config_sha256: "4".repeat(64),
            claim_owner_sha256: "6".repeat(64),
            generated_at: NOW - 1,
            expires_at: NOW + 120,
            claim_digest_sha256: String::new(),
        };
        claim.claim_digest_sha256 =
            orchestrator::activation_claim_digest(&claim.snapshot_claim()).unwrap();
        let mut permit = ClaimPermit {
            schema_version: 1,
            contract: CLAIM_PERMIT_CONTRACT.to_owned(),
            issuer: "cinatoken-ring-permit-staging".to_owned(),
            key_id: "permit-v1".to_owned(),
            authorization_id_sha256: claim.authorization_id_sha256.clone(),
            claim_digest_sha256: claim.claim_digest_sha256.clone(),
            claim_owner_sha256: claim.claim_owner_sha256.clone(),
            ledger_identity_sha256: claim.ledger_identity_sha256.clone(),
            claim_credential_id_sha256: claim.claim_credential_id_sha256.clone(),
            issued_at: NOW - 1,
            expires_at: NOW + 59,
            signature_base64url: String::new(),
        };
        let unsigned = UnsignedClaimPermit {
            schema_version: permit.schema_version,
            contract: &permit.contract,
            issuer: &permit.issuer,
            key_id: &permit.key_id,
            authorization_id_sha256: &permit.authorization_id_sha256,
            claim_digest_sha256: &permit.claim_digest_sha256,
            claim_owner_sha256: &permit.claim_owner_sha256,
            ledger_identity_sha256: &permit.ledger_identity_sha256,
            claim_credential_id_sha256: &permit.claim_credential_id_sha256,
            issued_at: permit.issued_at,
            expires_at: permit.expires_at,
        };
        let canonical = canonical_json(&unsigned).unwrap();
        let mut message = CLAIM_PERMIT_DOMAIN.to_vec();
        message.extend_from_slice(canonical.as_bytes());
        permit.signature_base64url = URL_SAFE_NO_PAD.encode(signing_key.sign(&message).to_bytes());
        let record = ExecutionActivationRecord {
            schema_version: 1,
            contract: EXECUTION_ACTIVATION_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            publication: ExecutionPublicationBinding {
                publication_manifest_sha256: publication.publication_manifest_sha256.clone(),
                publication_packet_sha256: publication.publication_packet_sha256.clone(),
                generation_sha256: publication.generation_sha256.clone(),
                activation_sequence: publication.activation_sequence,
                runner_build_sha256: publication.release.artifact_sha256.clone(),
                runner_trust_config_sha256: publication.release.trust_config_sha256.clone(),
            },
            locator: ExecutionLocator {
                method: "POST".to_owned(),
                authority_origin: STAGING_AUTHORITY_ORIGIN.to_owned(),
                path: CLAIMS_PATH.to_owned(),
                retry: false,
                timeout_milliseconds: REQUEST_TIMEOUT_MILLISECONDS,
                maximum_response_bytes: MAXIMUM_RESPONSE_BYTES,
                access_service_token_required: true,
            },
            permit_spki_base64url: URL_SAFE_NO_PAD.encode(spki),
            claim_request: ClaimRequest {
                schema_version: 1,
                contract: CLAIM_REQUEST_CONTRACT.to_owned(),
                claim,
                permit,
            },
        };
        Fixture {
            trust,
            publication,
            bytes: canonical_json(&record).unwrap().into_bytes(),
        }
    }

    fn publication(permit_spki_sha256: &'static str) -> PublicationIdentity {
        PublicationIdentity {
            release: VerifiedRelease {
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
                permit_spki_sha256: permit_spki_sha256.to_owned(),
                trust_config_sha256: "4".repeat(64),
                issued_at: "2033-05-18T03:33:19Z".to_owned(),
                expires_at: "2033-05-18T03:43:19Z".to_owned(),
            },
            publication_manifest_sha256: "b".repeat(64),
            publication_packet_sha256: "c".repeat(64),
            generation_sha256: "d".repeat(64),
            publication_directory_name: format!("publication-{}", "b".repeat(64)),
            activation_sequence: 1,
            previous_publication_manifest_sha256: None,
            published_at: "2033-05-18T03:33:19.000Z".to_owned(),
            expires_at: "2033-05-18T03:43:19.000Z".to_owned(),
        }
    }

    fn trust(permit_spki_sha256: &'static str) -> EmbeddedExecutionActivationTrust {
        EmbeddedExecutionActivationTrust {
            enabled: true,
            authority_origin: Some(STAGING_AUTHORITY_ORIGIN),
            permit_issuer: Some("cinatoken-ring-permit-staging"),
            permit_key_id: Some("permit-v1"),
            permit_spki_sha256: Some(permit_spki_sha256),
            ledger_identity_sha256: Some(leaked("d".repeat(64))),
            transition_policy_sha256: Some(leaked("8".repeat(64))),
            authorization_policy_sha256: Some(leaked("5".repeat(64))),
            account_id_sha256: Some(leaked("c".repeat(64))),
            read_credential_id_sha256: Some(leaked("e".repeat(64))),
            claim_credential_id_sha256: Some(leaked("f".repeat(64))),
            deploy_credential_id_sha256: Some(leaked("0".repeat(64))),
            controller_service_name: Some("controller-staging"),
            edge_service_name: Some("edge-staging"),
            runner_trust_config_sha256: Some(leaked("4".repeat(64))),
            ..EmbeddedExecutionActivationTrust::checked_in()
        }
    }

    fn mutate(bytes: &[u8], mutate: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        mutate(&mut value);
        canonical_json(&value).unwrap().into_bytes()
    }

    fn claim_dispatch_location(root: &Path) -> ClaimDispatchLocation {
        ClaimDispatchLocation {
            installation_root: fs::canonicalize(root).unwrap(),
            directory: fs::canonicalize(root.join(EXECUTION_ACTIVATIONS_DIRECTORY_NAME)).unwrap(),
        }
    }

    fn leaked(value: String) -> &'static str {
        Box::leak(value.into_boxed_str())
    }

    struct TemporaryDirectory {
        path: PathBuf,
    }

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let mut random = [0_u8; 16];
            getrandom(&mut random).unwrap();
            let suffix = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let path = std::env::temp_dir().join(format!("cinatoken-activation-{label}-{suffix}"));
            fs::create_dir(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            #[cfg(windows)]
            make_tree_writable(&self.path);
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[cfg(unix)]
    fn mark_file_read_only(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
    }

    #[cfg(windows)]
    fn mark_file_read_only(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn make_file_writable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    fn make_file_writable(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    fn make_tree_writable(path: &Path) {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let child = entry.path();
                if child.is_dir() {
                    make_tree_writable(&child);
                }
                if let Ok(metadata) = fs::metadata(&child) {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(&child, permissions);
                }
            }
        }
    }
}
