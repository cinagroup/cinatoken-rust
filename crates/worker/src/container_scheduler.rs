//! Default-off capability contract for the native container scheduler.
//!
//! The isolated TypeScript control Worker and native runtime sources now exist,
//! but remain default-off and unbound from the edge Worker. This module exposes
//! local contract evidence without claiming deployed or staging readiness.

use cinatoken_sharding::{
    ShardRing, ShardRoutingKey, CONTAINER_SHARD_CONTRACT_VERSION, CONTAINER_SHARD_INSTANCE_PREFIX,
    MAX_CONTAINER_SHARDS,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use worker::Env;

pub const CONTAINER_SCHEDULER_ENABLED_ENV: &str = "CONTAINER_SCHEDULER_ENABLED";
pub const CONTAINER_SCHEDULER_STAGING_VERIFIED_ENV: &str = "CONTAINER_SCHEDULER_STAGING_VERIFIED";
pub const CONTAINER_OPERATION_WRITE_ENABLED_ENV: &str = "CONTAINER_OPERATION_WRITE_ENABLED";
pub const CONTAINER_TERMINAL_CAS_ENABLED_ENV: &str = "CONTAINER_TERMINAL_CAS_ENABLED";
pub const CONTAINER_FINANCIAL_TERMINAL_ENABLED_ENV: &str = "CONTAINER_FINANCIAL_TERMINAL_ENABLED";
pub const CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED_ENV: &str =
    "CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED";
pub const CONTAINER_OPERATION_RECONCILIATION_ENABLED_ENV: &str =
    "CONTAINER_OPERATION_RECONCILIATION_ENABLED";
pub const CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED_ENV: &str =
    "CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED";
pub const CONTAINER_CHAT_CANARY_ENABLED_ENV: &str = "CONTAINER_CHAT_CANARY_ENABLED";
pub const CONTAINER_OPERATION_STAGING_VERIFIED_ENV: &str = "CONTAINER_OPERATION_STAGING_VERIFIED";
pub const CONTAINER_SHARD_READINESS_STAGING_VERIFIED_ENV: &str =
    "CONTAINER_SHARD_READINESS_STAGING_VERIFIED";
pub const CONTAINER_SCHEDULER_RING_GENERATION_ENV: &str = "CONTAINER_SCHEDULER_RING_GENERATION";
pub const CONTAINER_SCHEDULER_SHARD_COUNT_ENV: &str = "CONTAINER_SCHEDULER_SHARD_COUNT";
pub const CONTAINER_SCHEDULER_ROUTING_SECRET_ENV: &str = "CONTAINER_SCHEDULER_ROUTING_SECRET";
pub const DEFAULT_CONTAINER_SCHEDULER_RING_GENERATION: u64 = 1;
pub const DEFAULT_CONTAINER_SCHEDULER_SHARD_COUNT: u16 = 8;

const CONTAINER_SHARD_ROUTING_DOMAIN: &[u8] = b"cinatoken-container-shard-routing:v1\0";
const MIN_CONTAINER_SHARD_ROUTING_SECRET_BYTES: usize = 32;
const MAX_CONTAINER_SHARD_TENANT_ID_BYTES: usize = 256;

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
    "operation_write_enabled",
    "terminal_cas_enabled",
    "financial_terminal_enabled",
    "exact_response_replay_enabled",
    "operation_reconciliation_enabled",
    "divergence_reconciliation_verified",
    "chat_canary_enabled",
    "operation_staging_verified",
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContainerOperationRuntimeStatus {
    pub operation_write_enabled: bool,
    pub terminal_cas_enabled: bool,
    pub financial_terminal_enabled: bool,
    pub exact_response_replay_enabled: bool,
    pub operation_reconciliation_enabled: bool,
    pub divergence_reconciliation_verified: bool,
    pub chat_canary_enabled: bool,
    pub operation_staging_verified: bool,
}

impl ContainerOperationRuntimeStatus {
    pub fn replay_ready(self) -> bool {
        self.operation_write_enabled
            && self.terminal_cas_enabled
            && self.financial_terminal_enabled
            && self.exact_response_replay_enabled
            && self.operation_reconciliation_enabled
            && self.divergence_reconciliation_verified
            && self.operation_staging_verified
    }

    pub fn cutover_ready(self) -> bool {
        self.replay_ready() && self.chat_canary_enabled
    }
}

pub fn container_scheduler_runtime_status(env: &Env) -> ContainerSchedulerRuntimeStatus {
    let generation = runtime_value(env, CONTAINER_SCHEDULER_RING_GENERATION_ENV);
    let shard_count = runtime_value(env, CONTAINER_SCHEDULER_SHARD_COUNT_ENV);
    parse_container_scheduler_runtime_status(generation.as_deref(), shard_count.as_deref())
}

pub fn container_scheduler_enabled(env: &Env) -> bool {
    let enabled = runtime_value(env, CONTAINER_SCHEDULER_ENABLED_ENV);
    runtime_gate_enabled(enabled.as_deref())
}

pub fn container_operation_runtime_status(env: &Env) -> ContainerOperationRuntimeStatus {
    let operation_write_enabled = runtime_value(env, CONTAINER_OPERATION_WRITE_ENABLED_ENV);
    let terminal_cas_enabled = runtime_value(env, CONTAINER_TERMINAL_CAS_ENABLED_ENV);
    let financial_terminal_enabled = runtime_value(env, CONTAINER_FINANCIAL_TERMINAL_ENABLED_ENV);
    let exact_response_replay_enabled =
        runtime_value(env, CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED_ENV);
    let operation_reconciliation_enabled =
        runtime_value(env, CONTAINER_OPERATION_RECONCILIATION_ENABLED_ENV);
    let divergence_reconciliation_verified =
        runtime_value(env, CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED_ENV);
    let chat_canary_enabled = runtime_value(env, CONTAINER_CHAT_CANARY_ENABLED_ENV);
    let operation_staging_verified = runtime_value(env, CONTAINER_OPERATION_STAGING_VERIFIED_ENV);
    parse_container_operation_runtime_status([
        operation_write_enabled.as_deref(),
        terminal_cas_enabled.as_deref(),
        financial_terminal_enabled.as_deref(),
        exact_response_replay_enabled.as_deref(),
        operation_reconciliation_enabled.as_deref(),
        divergence_reconciliation_verified.as_deref(),
        chat_canary_enabled.as_deref(),
        operation_staging_verified.as_deref(),
    ])
}

pub fn container_scheduler_routing_secret_configured(env: &Env) -> bool {
    env.secret(CONTAINER_SCHEDULER_ROUTING_SECRET_ENV)
        .ok()
        .map(|secret| secret.to_string())
        .map(|secret| secret.trim().to_string())
        .filter(|secret| !secret.is_empty())
        .map(|secret| secret.as_bytes().len() >= MIN_CONTAINER_SHARD_ROUTING_SECRET_BYTES)
        .unwrap_or(false)
}

pub fn container_shard_routing_key(
    secret: &[u8],
    tenant_id: &str,
) -> Result<ShardRoutingKey, &'static str> {
    if secret.len() < MIN_CONTAINER_SHARD_ROUTING_SECRET_BYTES {
        return Err("routing_secret_too_short");
    }
    if tenant_id != tenant_id.trim()
        || tenant_id.is_empty()
        || tenant_id.len() > MAX_CONTAINER_SHARD_TENANT_ID_BYTES
        || tenant_id.chars().any(char::is_control)
    {
        return Err("invalid_tenant_id");
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| "invalid_routing_secret")?;
    mac.update(CONTAINER_SHARD_ROUTING_DOMAIN);
    mac.update(&(tenant_id.len() as u32).to_be_bytes());
    mac.update(tenant_id.as_bytes());
    let digest: [u8; 32] = mac.finalize().into_bytes().into();
    ShardRoutingKey::try_from(digest).map_err(|_| "invalid_routing_key")
}

pub fn plan_container_shard(
    runtime: ContainerSchedulerRuntimeStatus,
    secret: &[u8],
    tenant_id: &str,
) -> Result<cinatoken_sharding::ShardPlan, &'static str> {
    if !runtime.configured || !runtime.valid {
        return Err("ring_misconfigured");
    }
    let ring = ShardRing::new(runtime.ring_generation, runtime.shard_count)
        .map_err(|_| "ring_misconfigured")?;
    Ok(ring.plan(container_shard_routing_key(secret, tenant_id)?))
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
    let operation_outcome =
        include_str!("../../../services/container-controller/src/operation_outcome.ts");
    let storage_gateway =
        include_str!("../../../services/container-controller/src/storage_gateway.ts");
    let controller_config =
        include_str!("../../../services/container-controller/wrangler.production.jsonc");
    let runtime = include_str!("../../container-runtime/src/lib.rs");
    let dockerfile = include_str!("../../container-runtime/Dockerfile");
    let operation_fetch = controller
        .split_once("override async fetch(request: Request)")
        .map(|(_, source)| source)
        .unwrap_or_default();
    let recovery_is_persisted_before_execution = operation_fetch
        .find("this.ledger.claimOperation(")
        .zip(operation_fetch.find("await this.armOperationRecoveryIntent(intent);"))
        .zip(operation_fetch.find("this.ledger.transitionOperation("))
        .zip(operation_fetch.find("this.containerFetch(\"http://container/v1/operations\""))
        .is_some_and(|(((claim, arm), running), dispatch)| {
            claim < arm && arm < running && running < dispatch
        })
        && ledger.contains("persistRecoveryIntentV1")
        && ledger.contains("this.ensureOperationRecoveryIntentRow(operation, now)");
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
            && controller.contains("reconcileOperationDeadline")
            && controller.contains("container_recovery_schedule_unavailable")
            && recovery_is_persisted_before_execution
            && ledger.contains("storage_access_denied")
            && ledger.contains("result_object_version")
            && ledger.contains("recovery_required")
            && ledger.contains("operation_result_required")
            && operation_outcome.contains("operationOutcomeResponse")
            && operation_outcome.contains("operation_outcome_corrupt")
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
    operation_runtime_ready: bool,
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
        && operation_runtime_ready
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

fn parse_container_operation_runtime_status(
    values: [Option<&str>; 8],
) -> ContainerOperationRuntimeStatus {
    ContainerOperationRuntimeStatus {
        operation_write_enabled: runtime_gate_enabled(values[0]),
        terminal_cas_enabled: runtime_gate_enabled(values[1]),
        financial_terminal_enabled: runtime_gate_enabled(values[2]),
        exact_response_replay_enabled: runtime_gate_enabled(values[3]),
        operation_reconciliation_enabled: runtime_gate_enabled(values[4]),
        divergence_reconciliation_verified: runtime_gate_enabled(values[5]),
        chat_canary_enabled: runtime_gate_enabled(values[6]),
        operation_staging_verified: runtime_gate_enabled(values[7]),
    }
}

fn runtime_gate_enabled(value: Option<&str>) -> bool {
    value == Some("true")
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

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RoutingContractFixture {
        schema_version: u32,
        contract_version: u32,
        algorithm: String,
        domain_hex: String,
        instance_prefix: String,
        minimum_secret_bytes: usize,
        maximum_shards: u16,
        vectors: Vec<RoutingVectorFixture>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RoutingVectorFixture {
        name: String,
        secret_hex: String,
        tenant_id: String,
        routing_digest_sha256: String,
        plans: Vec<RoutingPlanFixture>,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RoutingPlanFixture {
        ring_generation: u64,
        shard_count: u16,
        shard_index: u16,
        instance_name: String,
    }

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
    fn tenant_routing_is_secret_keyed_stable_and_domain_separated() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let first = container_shard_routing_key(secret, "tenant-42").unwrap();
        let second = container_shard_routing_key(secret, "tenant-42").unwrap();
        let another = container_shard_routing_key(secret, "tenant-43").unwrap();
        assert_eq!(first, second);
        assert_ne!(first, another);
        assert!(!first
            .as_bytes()
            .windows(9)
            .any(|bytes| bytes == b"tenant-42"));

        let runtime = ContainerSchedulerRuntimeStatus {
            configured: true,
            valid: true,
            ring_generation: 7,
            shard_count: 16,
        };
        let plan = plan_container_shard(runtime, secret, "tenant-42").unwrap();
        assert_eq!(plan.ring_generation, 7);
        assert_eq!(plan.shard_count, 16);
        plan.validate_fence(ShardRing::new(7, 16).unwrap()).unwrap();
    }

    #[test]
    fn production_planner_matches_versioned_cross_language_vectors() {
        let fixture: RoutingContractFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/container-shard-routing-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        assert_eq!(fixture.contract_version, CONTAINER_SHARD_CONTRACT_VERSION);
        assert_eq!(fixture.algorithm, "hmac-sha256+jump-consistent-hash-v1");
        assert_eq!(
            decode_fixture_hex(&fixture.domain_hex),
            CONTAINER_SHARD_ROUTING_DOMAIN
        );
        assert_eq!(fixture.instance_prefix, CONTAINER_SHARD_INSTANCE_PREFIX);
        assert_eq!(
            fixture.minimum_secret_bytes,
            MIN_CONTAINER_SHARD_ROUTING_SECRET_BYTES
        );
        assert_eq!(fixture.maximum_shards, MAX_CONTAINER_SHARDS);

        let mut adjacent_transitions = 0_u32;
        let mut moved_to_new_shard = 0_u32;
        let mut maximum_ring_covered = false;
        for vector in fixture.vectors {
            let secret = decode_fixture_hex(&vector.secret_hex);
            assert!(
                secret.len() >= fixture.minimum_secret_bytes,
                "{}",
                vector.name
            );
            let routing_key = container_shard_routing_key(&secret, &vector.tenant_id).unwrap();
            assert_eq!(
                encode_fixture_hex(routing_key.as_bytes()),
                vector.routing_digest_sha256,
                "{}",
                vector.name
            );

            let mut plans = vector.plans;
            plans.sort_by_key(|plan| plan.shard_count);
            for expected in &plans {
                let actual = plan_container_shard(
                    ContainerSchedulerRuntimeStatus {
                        configured: true,
                        valid: true,
                        ring_generation: expected.ring_generation,
                        shard_count: expected.shard_count,
                    },
                    &secret,
                    &vector.tenant_id,
                )
                .unwrap();
                assert_eq!(actual.contract_version, fixture.contract_version);
                assert_eq!(actual.ring_generation, expected.ring_generation);
                assert_eq!(actual.shard_count, expected.shard_count);
                assert_eq!(actual.shard_index, expected.shard_index, "{}", vector.name);
                assert_eq!(
                    actual.instance_name, expected.instance_name,
                    "{}",
                    vector.name
                );
                maximum_ring_covered |= expected.shard_count == fixture.maximum_shards;
            }
            for pair in plans.windows(2) {
                let [previous, current] = pair else {
                    unreachable!()
                };
                assert!(current.ring_generation > previous.ring_generation);
                if current.shard_count != previous.shard_count + 1 {
                    continue;
                }
                assert_eq!(current.ring_generation, previous.ring_generation + 1);
                adjacent_transitions += 1;
                if current.shard_index != previous.shard_index {
                    assert_eq!(current.shard_index, previous.shard_count, "{}", vector.name);
                    moved_to_new_shard += 1;
                }
            }
        }
        assert_eq!(adjacent_transitions, 8);
        assert_eq!(moved_to_new_shard, 1);
        assert!(maximum_ring_covered);
    }

    #[test]
    fn tenant_routing_rejects_weak_or_ambiguous_inputs() {
        let secret = b"0123456789abcdef0123456789abcdef";
        assert_eq!(
            container_shard_routing_key(b"too-short", "tenant-42"),
            Err("routing_secret_too_short")
        );
        assert_eq!(
            container_shard_routing_key(secret, " \t "),
            Err("invalid_tenant_id")
        );
        assert_eq!(
            container_shard_routing_key(secret, "tenant\n42"),
            Err("invalid_tenant_id")
        );
        assert_eq!(
            container_shard_routing_key(secret, " tenant-42"),
            Err("invalid_tenant_id")
        );
        assert_eq!(
            plan_container_shard(
                ContainerSchedulerRuntimeStatus {
                    configured: false,
                    valid: false,
                    ring_generation: 1,
                    shard_count: 8,
                },
                secret,
                "tenant-42",
            ),
            Err("ring_misconfigured")
        );
    }

    fn decode_fixture_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }

    fn encode_fixture_hex(value: &[u8]) -> String {
        value.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn cutover_with_operation_runtime(operation_runtime: ContainerOperationRuntimeStatus) -> bool {
        container_scheduler_cutover_ready(
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            operation_runtime.cutover_ready(),
            true,
            true,
            true,
            true,
        )
    }

    #[test]
    fn cutover_requires_every_remote_and_runtime_proof() {
        let guards = container_scheduler_cutover_guards();
        assert_eq!(guards.len(), 22);
        assert!(guards.contains(&"remote_fault_matrix"));
        for guard in [
            "operation_write_enabled",
            "terminal_cas_enabled",
            "financial_terminal_enabled",
            "exact_response_replay_enabled",
            "operation_reconciliation_enabled",
            "divergence_reconciliation_verified",
            "chat_canary_enabled",
            "operation_staging_verified",
        ] {
            assert!(guards.contains(&guard));
        }
        assert!(!container_scheduler_cutover_ready(
            true, true, true, true, true, true, false, true, true, true, true, true, true, true,
            true,
        ));
        let operation_runtime = parse_container_operation_runtime_status([Some("true"); 8]);
        assert!(cutover_with_operation_runtime(operation_runtime));
    }

    #[test]
    fn every_container_operation_gate_is_independently_fail_closed() {
        let all_enabled = [Some("true"); 8];
        for missing_index in 0..all_enabled.len() {
            let mut missing_one = all_enabled;
            missing_one[missing_index] = None;
            let operation_runtime = parse_container_operation_runtime_status(missing_one);
            assert!(!cutover_with_operation_runtime(operation_runtime));
        }

        for disabled_value in ["false", "1", "TRUE", "yes", "on", "", " true "] {
            let mut disabled_one = all_enabled;
            disabled_one[0] = Some(disabled_value);
            assert!(!parse_container_operation_runtime_status(disabled_one).cutover_ready());
        }
    }

    #[test]
    fn replay_readiness_is_independent_of_new_canary_admission() {
        let mut values = [Some("true"); 8];
        values[6] = Some("false");
        let runtime = parse_container_operation_runtime_status(values);
        assert!(runtime.replay_ready());
        assert!(!runtime.cutover_ready());

        values[3] = Some("false");
        assert!(!parse_container_operation_runtime_status(values).replay_ready());
    }

    #[test]
    fn operation_gates_do_not_change_ring_validity() {
        let ring = parse_container_scheduler_runtime_status(Some("1"), Some("8"));
        let operation_runtime = parse_container_operation_runtime_status([None; 8]);
        assert!(ring.valid);
        assert!(!operation_runtime.cutover_ready());
    }

    #[test]
    fn tracked_wrangler_operation_gates_are_all_false() {
        let config = include_str!("../../../wrangler.toml").replace("\r\n", "\n");
        let (default, environment_overrides) = config.split_once("\n[env.staging]\n").unwrap();
        let (staging, production) = environment_overrides
            .split_once("\n[env.production]\n")
            .unwrap();
        for scope in [default, staging, production] {
            for gate in [
                CONTAINER_OPERATION_WRITE_ENABLED_ENV,
                CONTAINER_TERMINAL_CAS_ENABLED_ENV,
                CONTAINER_FINANCIAL_TERMINAL_ENABLED_ENV,
                CONTAINER_EXACT_RESPONSE_REPLAY_ENABLED_ENV,
                CONTAINER_OPERATION_RECONCILIATION_ENABLED_ENV,
                CONTAINER_DIVERGENCE_RECONCILIATION_VERIFIED_ENV,
                CONTAINER_CHAT_CANARY_ENABLED_ENV,
                CONTAINER_OPERATION_STAGING_VERIFIED_ENV,
            ] {
                assert!(scope.contains(&format!("{gate} = \"false\"")));
                assert!(!scope.contains(&format!("{gate} = \"true\"")));
            }
        }
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
