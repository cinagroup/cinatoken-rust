use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;

pub const PLACEMENT_EXECUTION_CONTRACT: &str =
    "cinatoken-relay-container-shard-placement-execution-plan-v1";
pub const PLACEMENT_RUNNER_CONTRACT: &str = "cinatoken-relay-container-shard-placement-runner-v1";
pub const INITIAL_STAGING_SHARD_COUNT: u16 = 8;
pub const MUTATION_SEND_ATTEMPTS: u8 = 1;
pub const MUTATION_RETRY_LIMIT: u8 = 0;
pub const MUTATION_OPERATION_COUNT: usize = 13;
pub const RECEIPT_RECORDS_PER_OPERATION: usize = 2;
pub const RECEIPT_RECORD_LIMIT: usize = 128;
pub const CONTROLLER_ACTION_GATE_COUNT: u16 = 22;
const PLAN_DIGEST_DOMAIN: &[u8] = b"cinatoken:relay-container-shard-placement-execution-plan:v1\0";
const OPERATION_DIGEST_DOMAIN: &[u8] = b"cinatoken:relay-container-shard-placement-operation:v1\0";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlacementExecutionPlan {
    pub schema_version: u8,
    pub contract: String,
    pub environment: String,
    pub execution_scope: String,
    pub release_sha256: String,
    pub publication_sha256: String,
    pub execution_activation_sha256: String,
    pub runner_build_sha256: String,
    pub authorization_id_sha256: String,
    pub execution_nonce_sha256: String,
    pub permit_subject_digest_sha256: String,
    pub campaign_id: String,
    pub campaign_nonce_sha256: String,
    pub claim_owner: String,
    pub controller_baseline_version_id: String,
    pub controller_enabled_version_id: String,
    pub controller_disabled_version_id: String,
    pub edge_baseline_version_id: String,
    pub action_gate_inventory_sha256: String,
    pub foundation_manifest_sha256: String,
    pub runtime_build_id: String,
    pub ring_generation: u64,
    pub shard_count: u16,
    pub controller_action_gate_count: u16,
    pub all_controller_action_gates_false: bool,
    pub edge_mutation_allowed: bool,
    pub mutation_retry_limit: u8,
    pub permit_issued_at: u64,
    pub permit_expires_at: u64,
    pub campaign_expires_at: u64,
}

impl PlacementExecutionPlan {
    pub fn validate(&self) -> Result<(), PlacementPlanError> {
        if self.schema_version != 1
            || self.contract != PLACEMENT_EXECUTION_CONTRACT
            || self.environment != "staging"
            || self.execution_scope != "controller_only"
        {
            return Err(PlacementPlanError::ContractMismatch);
        }
        if self.shard_count != INITIAL_STAGING_SHARD_COUNT {
            return Err(PlacementPlanError::InvalidField("shard_count"));
        }
        if !(1..=1_000_000).contains(&self.ring_generation) {
            return Err(PlacementPlanError::InvalidField("ring_generation"));
        }
        if self.controller_action_gate_count != CONTROLLER_ACTION_GATE_COUNT
            || !self.all_controller_action_gates_false
        {
            return Err(PlacementPlanError::InvalidField("controller_action_gates"));
        }
        if self.edge_mutation_allowed {
            return Err(PlacementPlanError::InvalidField("edge_mutation_allowed"));
        }
        if self.mutation_retry_limit != MUTATION_RETRY_LIMIT {
            return Err(PlacementPlanError::InvalidField("mutation_retry_limit"));
        }
        for (field, value) in [
            ("release_sha256", self.release_sha256.as_str()),
            ("publication_sha256", self.publication_sha256.as_str()),
            (
                "execution_activation_sha256",
                self.execution_activation_sha256.as_str(),
            ),
            ("runner_build_sha256", self.runner_build_sha256.as_str()),
            (
                "authorization_id_sha256",
                self.authorization_id_sha256.as_str(),
            ),
            (
                "execution_nonce_sha256",
                self.execution_nonce_sha256.as_str(),
            ),
            (
                "permit_subject_digest_sha256",
                self.permit_subject_digest_sha256.as_str(),
            ),
            ("campaign_id", self.campaign_id.as_str()),
            ("campaign_nonce_sha256", self.campaign_nonce_sha256.as_str()),
            (
                "action_gate_inventory_sha256",
                self.action_gate_inventory_sha256.as_str(),
            ),
            (
                "foundation_manifest_sha256",
                self.foundation_manifest_sha256.as_str(),
            ),
            ("runtime_build_id", self.runtime_build_id.as_str()),
        ] {
            if !valid_sha256(value) {
                return Err(PlacementPlanError::InvalidField(field));
            }
        }
        if HashSet::from([
            self.authorization_id_sha256.as_str(),
            self.execution_nonce_sha256.as_str(),
            self.permit_subject_digest_sha256.as_str(),
            self.campaign_id.as_str(),
            self.campaign_nonce_sha256.as_str(),
        ])
        .len()
            != 5
        {
            return Err(PlacementPlanError::IdentityCollision);
        }
        if !valid_token(&self.claim_owner, 1, 128)
            || !valid_version_id(&self.controller_baseline_version_id)
            || !valid_version_id(&self.controller_enabled_version_id)
            || !valid_version_id(&self.controller_disabled_version_id)
            || !valid_version_id(&self.edge_baseline_version_id)
            || self.controller_enabled_version_id == self.controller_baseline_version_id
            || self.controller_enabled_version_id == self.controller_disabled_version_id
        {
            return Err(PlacementPlanError::InvalidField("deployment_identity"));
        }
        if self.permit_issued_at == 0
            || self.permit_expires_at < self.permit_issued_at.saturating_add(60)
            || self.permit_expires_at > self.permit_issued_at.saturating_add(600)
            || self.campaign_expires_at <= self.permit_issued_at
        {
            return Err(PlacementPlanError::InvalidField("execution_window"));
        }
        Ok(())
    }

    pub fn digest_sha256(&self) -> Result<String, PlacementPlanError> {
        self.validate()?;
        let mut hasher = Sha256::new();
        hasher.update(PLAN_DIGEST_DOMAIN);
        for value in [
            self.schema_version.to_string(),
            self.contract.clone(),
            self.environment.clone(),
            self.execution_scope.clone(),
            self.release_sha256.clone(),
            self.publication_sha256.clone(),
            self.execution_activation_sha256.clone(),
            self.runner_build_sha256.clone(),
            self.authorization_id_sha256.clone(),
            self.execution_nonce_sha256.clone(),
            self.permit_subject_digest_sha256.clone(),
            self.campaign_id.clone(),
            self.campaign_nonce_sha256.clone(),
            self.claim_owner.clone(),
            self.controller_baseline_version_id.clone(),
            self.controller_enabled_version_id.clone(),
            self.controller_disabled_version_id.clone(),
            self.edge_baseline_version_id.clone(),
            self.action_gate_inventory_sha256.clone(),
            self.foundation_manifest_sha256.clone(),
            self.runtime_build_id.clone(),
            self.ring_generation.to_string(),
            self.shard_count.to_string(),
            self.controller_action_gate_count.to_string(),
            self.all_controller_action_gates_false.to_string(),
            self.edge_mutation_allowed.to_string(),
            self.mutation_retry_limit.to_string(),
            self.permit_issued_at.to_string(),
            self.permit_expires_at.to_string(),
            self.campaign_expires_at.to_string(),
        ] {
            update_digest_part(&mut hasher, value.as_bytes());
        }
        Ok(format!("{:x}", hasher.finalize()))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlacementMutationKind {
    ProveDisabledDeployment,
    CreateAuthorityClaim,
    EnableControllerDeployment,
    CreateActivationCampaign,
    ProbeShardReadiness,
    DisableControllerDeployment,
}

impl PlacementMutationKind {
    const fn label(self) -> &'static str {
        match self {
            Self::ProveDisabledDeployment => "prove_disabled_deployment",
            Self::CreateAuthorityClaim => "create_authority_claim",
            Self::EnableControllerDeployment => "enable_controller_deployment",
            Self::CreateActivationCampaign => "create_activation_campaign",
            Self::ProbeShardReadiness => "probe_shard_readiness",
            Self::DisableControllerDeployment => "disable_controller_deployment",
        }
    }

    const fn ambiguous_readback(self) -> &'static str {
        match self {
            Self::ProveDisabledDeployment | Self::DisableControllerDeployment => {
                "stable_disabled_controller_deployment"
            }
            Self::CreateAuthorityClaim => "exact_authority_claim",
            Self::EnableControllerDeployment => "stable_enabled_controller_deployment",
            Self::CreateActivationCampaign => "campaign_and_0063_authorization",
            Self::ProbeShardReadiness => "exact_shard_consumption_receipt",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementMutationOperation {
    pub ordinal: u16,
    pub operation_id_sha256: String,
    pub kind: PlacementMutationKind,
    pub shard_index: Option<u16>,
    pub send_attempt_limit: u8,
    pub retry_limit: u8,
    pub persist_start_before_send: bool,
    pub ambiguous_readback: &'static str,
    pub missing_readback_allows_resend: bool,
    pub disable_first_after_enable_intent: bool,
}

pub fn mutation_schedule(
    plan: &PlacementExecutionPlan,
) -> Result<Vec<PlacementMutationOperation>, PlacementPlanError> {
    let plan_digest = plan.digest_sha256()?;
    let mut specs = vec![
        (PlacementMutationKind::ProveDisabledDeployment, None),
        (PlacementMutationKind::CreateAuthorityClaim, None),
        (PlacementMutationKind::EnableControllerDeployment, None),
        (PlacementMutationKind::CreateActivationCampaign, None),
    ];
    for shard_index in 0..plan.shard_count {
        specs.push((
            PlacementMutationKind::ProbeShardReadiness,
            Some(shard_index),
        ));
    }
    specs.push((PlacementMutationKind::DisableControllerDeployment, None));
    if specs.len() != MUTATION_OPERATION_COUNT
        || specs.len().saturating_mul(RECEIPT_RECORDS_PER_OPERATION) > RECEIPT_RECORD_LIMIT
    {
        return Err(PlacementPlanError::ReceiptCapacityExceeded);
    }
    Ok(specs
        .into_iter()
        .enumerate()
        .map(|(index, (kind, shard_index))| PlacementMutationOperation {
            ordinal: (index + 1) as u16,
            operation_id_sha256: operation_id(&plan_digest, (index + 1) as u16, kind, shard_index),
            kind,
            shard_index,
            send_attempt_limit: MUTATION_SEND_ATTEMPTS,
            retry_limit: MUTATION_RETRY_LIMIT,
            persist_start_before_send: true,
            ambiguous_readback: kind.ambiguous_readback(),
            missing_readback_allows_resend: false,
            disable_first_after_enable_intent: matches!(
                kind,
                PlacementMutationKind::EnableControllerDeployment
                    | PlacementMutationKind::CreateActivationCampaign
                    | PlacementMutationKind::ProbeShardReadiness
                    | PlacementMutationKind::DisableControllerDeployment
            ),
        })
        .collect())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRunnerDescription {
    pub ok: bool,
    pub schema_version: u8,
    pub contract: &'static str,
    pub plan_contract: &'static str,
    pub environment: &'static str,
    pub execution_scope: &'static str,
    pub initial_shard_count: u16,
    pub mutation_operation_count: usize,
    pub mutation_send_attempt_limit: u8,
    pub mutation_retry_limit: u8,
    pub persist_start_before_send: bool,
    pub ambiguous_outcome_readback_only: bool,
    pub missing_readback_allows_resend: bool,
    pub disable_first_after_enable_intent: bool,
    pub edge_mutation_allowed: bool,
    pub authority_exclusive_claim_compiled: bool,
    pub workload_routes_compiled: bool,
    pub credentials_read: bool,
    pub network_requests_performed: bool,
    pub mutation_performed: bool,
    pub remote_execution_authorized: bool,
    pub production_cutover_authorized: bool,
}

pub const fn describe() -> PlacementRunnerDescription {
    PlacementRunnerDescription {
        ok: true,
        schema_version: 1,
        contract: PLACEMENT_RUNNER_CONTRACT,
        plan_contract: PLACEMENT_EXECUTION_CONTRACT,
        environment: "staging",
        execution_scope: "controller_only",
        initial_shard_count: INITIAL_STAGING_SHARD_COUNT,
        mutation_operation_count: MUTATION_OPERATION_COUNT,
        mutation_send_attempt_limit: MUTATION_SEND_ATTEMPTS,
        mutation_retry_limit: MUTATION_RETRY_LIMIT,
        persist_start_before_send: true,
        ambiguous_outcome_readback_only: true,
        missing_readback_allows_resend: false,
        disable_first_after_enable_intent: true,
        edge_mutation_allowed: false,
        authority_exclusive_claim_compiled: false,
        workload_routes_compiled: false,
        credentials_read: false,
        network_requests_performed: false,
        mutation_performed: false,
        remote_execution_authorized: false,
        production_cutover_authorized: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlacementPlanError {
    ContractMismatch,
    InvalidField(&'static str),
    IdentityCollision,
    ReceiptCapacityExceeded,
}

impl fmt::Display for PlacementPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ContractMismatch => formatter.write_str("placement execution contract mismatch"),
            Self::InvalidField(field) => {
                write!(formatter, "placement execution field invalid: {field}")
            }
            Self::IdentityCollision => {
                formatter.write_str("placement execution identities are not distinct")
            }
            Self::ReceiptCapacityExceeded => {
                formatter.write_str("placement execution exceeds receipt capacity")
            }
        }
    }
}

impl std::error::Error for PlacementPlanError {}

fn operation_id(
    plan_digest: &str,
    ordinal: u16,
    kind: PlacementMutationKind,
    shard_index: Option<u16>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(OPERATION_DIGEST_DOMAIN);
    for value in [
        plan_digest.to_string(),
        ordinal.to_string(),
        kind.label().to_string(),
        shard_index
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string()),
    ] {
        update_digest_part(&mut hasher, value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn update_digest_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u32).to_be_bytes());
    hasher.update(value);
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_token(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_version_id(value: &str) -> bool {
    valid_token(value, 1, 128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_description_is_inert_and_explicitly_zero_retry() {
        let description = describe();
        assert_eq!(description.initial_shard_count, 8);
        assert_eq!(description.mutation_operation_count, 13);
        assert_eq!(description.mutation_send_attempt_limit, 1);
        assert_eq!(description.mutation_retry_limit, 0);
        assert!(description.persist_start_before_send);
        assert!(description.ambiguous_outcome_readback_only);
        assert!(!description.missing_readback_allows_resend);
        assert!(description.disable_first_after_enable_intent);
        assert!(!description.edge_mutation_allowed);
        assert!(!description.authority_exclusive_claim_compiled);
        assert!(!description.workload_routes_compiled);
        assert!(!description.credentials_read);
        assert!(!description.network_requests_performed);
        assert!(!description.mutation_performed);
        assert!(!description.remote_execution_authorized);
        assert!(!description.production_cutover_authorized);
    }

    #[test]
    fn plan_builds_one_bounded_deterministic_mutation_schedule() {
        let plan = plan();
        let first = mutation_schedule(&plan).unwrap();
        let second = mutation_schedule(&plan).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), MUTATION_OPERATION_COUNT);
        assert!(first.len() * RECEIPT_RECORDS_PER_OPERATION <= RECEIPT_RECORD_LIMIT);
        assert_eq!(
            first
                .iter()
                .filter(|operation| {
                    operation.kind == PlacementMutationKind::ProbeShardReadiness
                })
                .map(|operation| operation.shard_index.unwrap())
                .collect::<Vec<_>>(),
            (0..INITIAL_STAGING_SHARD_COUNT).collect::<Vec<_>>()
        );
        assert_eq!(
            first
                .iter()
                .map(|operation| operation.operation_id_sha256.as_str())
                .collect::<HashSet<_>>()
                .len(),
            MUTATION_OPERATION_COUNT
        );
        assert!(first.iter().all(|operation| {
            operation.send_attempt_limit == 1
                && operation.retry_limit == 0
                && operation.persist_start_before_send
                && !operation.missing_readback_allows_resend
        }));
        assert_eq!(
            first.last().unwrap().kind,
            PlacementMutationKind::DisableControllerDeployment
        );
    }

    #[test]
    fn rejects_scope_retry_capacity_and_identity_drift() {
        for invalid in [
            PlacementExecutionPlan {
                environment: "production".to_string(),
                ..plan()
            },
            PlacementExecutionPlan {
                execution_scope: "controller_and_edge".to_string(),
                ..plan()
            },
            PlacementExecutionPlan {
                shard_count: 16,
                ..plan()
            },
            PlacementExecutionPlan {
                edge_mutation_allowed: true,
                ..plan()
            },
            PlacementExecutionPlan {
                mutation_retry_limit: 1,
                ..plan()
            },
            PlacementExecutionPlan {
                campaign_nonce_sha256: "5".repeat(64),
                ..plan()
            },
            PlacementExecutionPlan {
                controller_enabled_version_id: "controller-disabled-v1".to_string(),
                ..plan()
            },
        ] {
            assert!(invalid.validate().is_err());
            assert!(mutation_schedule(&invalid).is_err());
        }
    }

    fn plan() -> PlacementExecutionPlan {
        PlacementExecutionPlan {
            schema_version: 1,
            contract: PLACEMENT_EXECUTION_CONTRACT.to_string(),
            environment: "staging".to_string(),
            execution_scope: "controller_only".to_string(),
            release_sha256: "1".repeat(64),
            publication_sha256: "2".repeat(64),
            execution_activation_sha256: "3".repeat(64),
            runner_build_sha256: "4".repeat(64),
            authorization_id_sha256: "5".repeat(64),
            execution_nonce_sha256: "6".repeat(64),
            permit_subject_digest_sha256: "7".repeat(64),
            campaign_id: "8".repeat(64),
            campaign_nonce_sha256: "9".repeat(64),
            claim_owner: "placement-runner-staging-001".to_string(),
            controller_baseline_version_id: "controller-disabled-v1".to_string(),
            controller_enabled_version_id: "controller-enabled-v1".to_string(),
            controller_disabled_version_id: "controller-disabled-v1".to_string(),
            edge_baseline_version_id: "edge-baseline-v1".to_string(),
            action_gate_inventory_sha256: "a".repeat(64),
            foundation_manifest_sha256: "b".repeat(64),
            runtime_build_id: "c".repeat(64),
            ring_generation: 7,
            shard_count: INITIAL_STAGING_SHARD_COUNT,
            controller_action_gate_count: CONTROLLER_ACTION_GATE_COUNT,
            all_controller_action_gates_false: true,
            edge_mutation_allowed: false,
            mutation_retry_limit: MUTATION_RETRY_LIMIT,
            permit_issued_at: 1_900_000_000,
            permit_expires_at: 1_900_000_300,
            campaign_expires_at: 1_900_000_600,
        }
    }
}
