//! Default-off capability contract for the native container scheduler.
//!
//! The isolated TypeScript control Worker and native runtime sources now exist,
//! but remain default-off and unbound from the edge Worker. This module exposes
//! local contract evidence without claiming deployed or staging readiness.

use cinatoken_sharding::{
    ShardRing, ShardRoutingKey, CONTAINER_SHARD_CONTRACT_VERSION, CONTAINER_SHARD_INSTANCE_PREFIX,
    MAX_CONTAINER_SHARDS,
};
use worker::Env;

pub const CONTAINER_SCHEDULER_ENABLED_ENV: &str = "CONTAINER_SCHEDULER_ENABLED";
pub const CONTAINER_SCHEDULER_STAGING_VERIFIED_ENV: &str = "CONTAINER_SCHEDULER_STAGING_VERIFIED";
pub const CONTAINER_SHARD_READINESS_STAGING_VERIFIED_ENV: &str =
    "CONTAINER_SHARD_READINESS_STAGING_VERIFIED";
pub const CONTAINER_SCHEDULER_RING_GENERATION_ENV: &str = "CONTAINER_SCHEDULER_RING_GENERATION";
pub const CONTAINER_SCHEDULER_SHARD_COUNT_ENV: &str = "CONTAINER_SCHEDULER_SHARD_COUNT";
pub const CONTAINER_SCHEDULER_ROUTING_SECRET_ENV: &str = "CONTAINER_SCHEDULER_ROUTING_SECRET";
pub const DEFAULT_CONTAINER_SCHEDULER_RING_GENERATION: u64 = 1;
pub const DEFAULT_CONTAINER_SCHEDULER_SHARD_COUNT: u16 = 8;

const CONTAINER_SCHEDULER_CUTOVER_GUARDS: &[&str] = &[
    "planner_contract",
    "valid_ring_config",
    "runtime_enabled",
    "routing_key_hmac_secret",
    "controller_service_binding",
    "controller_status_probe",
    "shard_readiness_probe",
    "container_runtime",
    "deny_by_default_egress",
    "shared_storage_contract",
    "n_minus_one_protocol",
    "capacity_rejection",
    "remote_fault_matrix",
    "staging_verified",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerSchedulerRuntimeStatus {
    pub configured: bool,
    pub valid: bool,
    pub ring_generation: u64,
    pub shard_count: u16,
}

pub fn container_scheduler_runtime_status(env: &Env) -> ContainerSchedulerRuntimeStatus {
    let generation = runtime_value(env, CONTAINER_SCHEDULER_RING_GENERATION_ENV);
    let shard_count = runtime_value(env, CONTAINER_SCHEDULER_SHARD_COUNT_ENV);
    parse_container_scheduler_runtime_status(generation.as_deref(), shard_count.as_deref())
}

pub fn container_scheduler_routing_secret_configured(env: &Env) -> bool {
    env.secret(CONTAINER_SCHEDULER_ROUTING_SECRET_ENV)
        .ok()
        .map(|secret| secret.to_string())
        .map(|secret| secret.trim().to_string())
        .filter(|secret| !secret.is_empty())
        .map(|secret| secret.as_bytes().len() >= 32)
        .unwrap_or(false)
}

pub fn container_scheduler_foundation_compiled() -> bool {
    let Ok(ring) = ShardRing::new(
        DEFAULT_CONTAINER_SCHEDULER_RING_GENERATION,
        DEFAULT_CONTAINER_SCHEDULER_SHARD_COUNT,
    ) else {
        return false;
    };
    let mut digest = [0_u8; 32];
    digest[31] = 1;
    let Ok(key) = ShardRoutingKey::try_from(digest) else {
        return false;
    };
    let plan = ring.plan(key);
    CONTAINER_SHARD_CONTRACT_VERSION == 1
        && MAX_CONTAINER_SHARDS == 1_024
        && CONTAINER_SHARD_INSTANCE_PREFIX == "cinatoken-relay-shard-v1"
        && plan.validate_fence(ring).is_ok()
        && plan
            .instance_name
            .starts_with(CONTAINER_SHARD_INSTANCE_PREFIX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerLocalContracts {
    pub runtime_compiled: bool,
    pub deny_by_default_egress_compiled: bool,
    pub shared_storage_compiled: bool,
    pub capacity_rejection_compiled: bool,
    pub bounded_terminal_retention_compiled: bool,
}

pub fn container_local_contracts() -> ContainerLocalContracts {
    let controller = include_str!("../../../services/container-controller/src/index.ts");
    let ledger = include_str!("../../../services/container-controller/src/ledger.ts");
    let storage_gateway =
        include_str!("../../../services/container-controller/src/storage_gateway.ts");
    let controller_config =
        include_str!("../../../services/container-controller/wrangler.production.jsonc");
    let runtime = include_str!("../../container-runtime/src/lib.rs");
    let dockerfile = include_str!("../../container-runtime/Dockerfile");
    ContainerLocalContracts {
        runtime_compiled: runtime.contains("/v1/operations")
            && runtime.contains("execution_not_enabled")
            && runtime.contains("shard_contract_version")
            && runtime.contains("execution_enabled")
            && dockerfile.contains("cinatoken-container-runtime"),
        deny_by_default_egress_compiled: controller.contains("enableInternet = false")
            && controller.contains("container_egress_denied")
            && controller.contains("export { ContainerProxy }")
            && controller_config.contains("\"enabled\": false"),
        shared_storage_compiled: controller.contains("outboundByHost")
            && controller.contains("authorizeStorageAccess")
            && controller.contains("recordStorageResult")
            && ledger.contains("storage_access_denied")
            && ledger.contains("result_object_version")
            && storage_gateway.contains("R2_INPUT_GET")
            && storage_gateway.contains("R2_RESULT_PUT")
            && storage_gateway.contains("KV_CONFIG_GET")
            && storage_gateway.contains("D1_ADMISSION_GET")
            && storage_gateway.contains("if-none-match")
            && controller_config.contains("CONTAINER_STORAGE_R2_READ_ENABLED")
            && controller_config.contains("\"binding\": \"DB\"")
            && controller_config.contains("\"binding\": \"CONFIG_KV\"")
            && controller_config.contains("\"binding\": \"FILE_BUCKET\""),
        capacity_rejection_compiled: controller.contains("claim.kind === \"capacity\"")
            && controller.contains("CONTAINER_MAX_IN_FLIGHT_PER_SHARD")
            && controller.contains("retry-after"),
        bounded_terminal_retention_compiled: ledger.contains("terminalRetentionSeconds")
            && ledger.contains("maxTerminalOperations")
            && ledger.contains("response_status = 504"),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn container_scheduler_cutover_ready(
    foundation_compiled: bool,
    config_valid: bool,
    enabled: bool,
    routing_secret_configured: bool,
    controller_service_binding_available: bool,
    controller_status_verified: bool,
    shard_readiness_staging_verified: bool,
    container_runtime_compiled: bool,
    deny_by_default_egress_compiled: bool,
    shared_storage_contract_compiled: bool,
    n_minus_one_protocol_compiled: bool,
    capacity_rejection_compiled: bool,
    remote_fault_matrix_verified: bool,
    staging_verified: bool,
) -> bool {
    foundation_compiled
        && config_valid
        && enabled
        && routing_secret_configured
        && controller_service_binding_available
        && controller_status_verified
        && shard_readiness_staging_verified
        && container_runtime_compiled
        && deny_by_default_egress_compiled
        && shared_storage_contract_compiled
        && n_minus_one_protocol_compiled
        && capacity_rejection_compiled
        && remote_fault_matrix_verified
        && staging_verified
}

pub fn container_scheduler_cutover_guards() -> Vec<&'static str> {
    CONTAINER_SCHEDULER_CUTOVER_GUARDS.to_vec()
}

fn parse_container_scheduler_runtime_status(
    generation: Option<&str>,
    shard_count: Option<&str>,
) -> ContainerSchedulerRuntimeStatus {
    let configured = generation.is_some() && shard_count.is_some();
    let parsed_generation = generation.and_then(|value| value.trim().parse::<u64>().ok());
    let parsed_shard_count = shard_count.and_then(|value| value.trim().parse::<u16>().ok());
    let ring = parsed_generation
        .zip(parsed_shard_count)
        .and_then(|(generation, shard_count)| ShardRing::new(generation, shard_count).ok());
    ContainerSchedulerRuntimeStatus {
        configured,
        valid: configured && ring.is_some(),
        ring_generation: ring
            .map(|value| value.generation)
            .unwrap_or(DEFAULT_CONTAINER_SCHEDULER_RING_GENERATION),
        shard_count: ring
            .map(|value| value.shard_count)
            .unwrap_or(DEFAULT_CONTAINER_SCHEDULER_SHARD_COUNT),
    }
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_ring_config_is_valid_and_bounded() {
        let status = parse_container_scheduler_runtime_status(Some("1"), Some("8"));
        assert!(status.configured);
        assert!(status.valid);
        assert_eq!(status.ring_generation, 1);
        assert_eq!(status.shard_count, 8);
        assert!(container_scheduler_foundation_compiled());
    }

    #[test]
    fn missing_or_invalid_ring_config_fails_closed() {
        for status in [
            parse_container_scheduler_runtime_status(None, None),
            parse_container_scheduler_runtime_status(Some("1"), None),
            parse_container_scheduler_runtime_status(Some("0"), Some("8")),
            parse_container_scheduler_runtime_status(Some("1"), Some("0")),
            parse_container_scheduler_runtime_status(Some("1"), Some("1025")),
            parse_container_scheduler_runtime_status(Some("x"), Some("8")),
        ] {
            assert!(!status.valid);
            assert_eq!(
                status.ring_generation,
                DEFAULT_CONTAINER_SCHEDULER_RING_GENERATION
            );
            assert_eq!(status.shard_count, DEFAULT_CONTAINER_SCHEDULER_SHARD_COUNT);
        }
    }

    #[test]
    fn cutover_requires_every_remote_and_runtime_proof() {
        let guards = container_scheduler_cutover_guards();
        assert_eq!(guards.len(), 14);
        assert!(guards.contains(&"remote_fault_matrix"));
        assert!(!container_scheduler_cutover_ready(
            true, true, true, true, true, true, false, true, true, true, true, true, true, true,
        ));
        assert!(container_scheduler_cutover_ready(
            true, true, true, true, true, true, true, true, true, true, true, true, true, true,
        ));
    }

    #[test]
    fn isolated_controller_and_runtime_contracts_are_locally_compiled() {
        let contracts = container_local_contracts();
        assert!(contracts.runtime_compiled);
        assert!(contracts.deny_by_default_egress_compiled);
        assert!(contracts.shared_storage_compiled);
        assert!(contracts.capacity_rejection_compiled);
        assert!(contracts.bounded_terminal_retention_compiled);
    }
}
