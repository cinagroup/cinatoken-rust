//! Cloudflare platform gateway foundation.
//!
//! This module is the Rust-side dispatch layer for the cinaVibeSDK-inspired
//! Workers for Platforms shape: the main Worker acts as a dispatch Worker and
//! forwards preview/tenant traffic to scripts inside a dispatch namespace. The
//! feature is off by default and only activates when explicitly configured.

use cinatoken_gateway::{
    WfpDispatchKind, WfpDispatchPlan, SCHEDULING_GATEWAY_OWNER_CONTRACT_VERSION,
    SCHEDULING_GATEWAY_ROUTE_PRECEDENCE,
};
use cinatoken_providers::ai_gateway::{
    AiGatewayDirectModelPolicy, AI_GATEWAY_MODEL_PROVIDERS, MAIN_RELAY_AI_GATEWAY_CUTOVER_GUARDS,
    MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS,
};
use cinatoken_relay::clamp_i64_to_i32 as d1_i32;
use cinatoken_sharding::{ShardRing, CONTAINER_SHARD_CONTRACT_VERSION};
use cinatoken_storage::RelayAuditLog;
use cinatoken_wfp_authority::{OutboundInvocationContext, OUTBOUND_CONTEXT_BINDING};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use worker::{
    D1Database, D1Type, Env, Headers, Request, RequestInit, Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
};
use crate::container_controller::{
    probe as probe_container_controller, probe_shard_readiness,
    CONTAINER_SHARD_READINESS_PROBE_ENABLED_ENV, CONTAINER_SHARD_READINESS_WAKE_ENABLED_ENV,
};
use crate::container_scheduler::{
    container_local_contracts, container_operation_runtime_status,
    container_scheduler_cutover_guards, container_scheduler_cutover_ready,
    container_scheduler_foundation_compiled, container_scheduler_routing_secret_configured,
    container_scheduler_runtime_status, CONTAINER_SCHEDULER_ENABLED_ENV,
    CONTAINER_SCHEDULER_STAGING_VERIFIED_ENV, CONTAINER_SHARD_READINESS_STAGING_VERIFIED_ENV,
};
use crate::quota_coordinator::{
    quota_coordinator_contract_version, quota_coordinator_finalization_observation_compiled,
    quota_coordinator_foundation_compiled, quota_coordinator_observer_contract_compiled,
    quota_coordinator_reconciliation_compiled, quota_coordinator_recovery_observation_compiled,
    quota_coordinator_relay_observation_compiled, quota_coordinator_reserve_observation_compiled,
    quota_coordinator_retention_compaction_compiled, quota_coordinator_shadow_scope_status,
    QUOTA_COORD_BINDING, QUOTA_COORD_RETENTION_VERIFIED_ENV, QUOTA_COORD_SHADOW_ENABLED_ENV,
    QUOTA_COORD_STAGING_VERIFIED_ENV,
};
use crate::realtime_billing_reconcile::{
    realtime_billing_reconciliation_compiled, realtime_billing_reconciliation_enabled,
    REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED_ENV,
};
use crate::realtime_session::{
    realtime_billing_global_orphan_recovery_compiled, realtime_billing_orphan_recovery_enabled,
    realtime_billing_orphan_recovery_grace_seconds, realtime_billing_orphan_sweep_limit,
    realtime_billing_presettlement_snapshot_compiled, realtime_billing_reservation_lease_compiled,
    realtime_billing_reservation_lease_seconds, realtime_billing_settlement_audit_log_compiled,
    realtime_billing_settlement_batch_compiled, realtime_billing_settlement_handoff_compiled,
    realtime_billing_settlement_mutation_plan_compiled,
    realtime_billing_settlement_preview_compiled,
    realtime_billing_settlement_replay_marker_compiled, realtime_billing_settlement_retry_compiled,
    realtime_billing_settlement_writer_compiled, realtime_session_platform_admin_auth_compiled,
    realtime_session_platform_header_boundary_compiled,
    realtime_upstream_bridge_backpressure_policy_compiled,
    realtime_upstream_bridge_backpressure_runtime_compiled,
    realtime_upstream_bridge_close_mapping_compiled,
    realtime_upstream_bridge_connect_contract_compiled,
    realtime_upstream_bridge_event_trace_compiled, realtime_upstream_bridge_frame_guard_compiled,
    realtime_upstream_bridge_hibernation_fail_closed_compiled,
    realtime_upstream_bridge_lifecycle_compiled, realtime_upstream_bridge_planner_compiled,
    realtime_upstream_bridge_replay_contract_compiled,
    realtime_upstream_bridge_send_failure_guard_compiled,
    realtime_upstream_channel_planner_compiled, realtime_upstream_connect_handoff_compiled,
    realtime_upstream_fetch_upgrade_adapter_compiled, realtime_upstream_usage_capture_compiled,
    realtime_usage_reconciliation_compiled, REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED_ENV,
    REALTIME_SESSION_CUTOVER_GUARDS, REALTIME_SESSION_GATEWAY_ENABLED_ENV,
    REALTIME_SESSION_V1_ENABLED_ENV,
};
use crate::relay::{
    relay_actual_serving_group_billing_contract_compiled,
    relay_ai_gateway_direct_fallback_contract_compiled,
    relay_billing_finalization_consumer_compiled, relay_billing_finalization_dlq_consumer_compiled,
    relay_billing_finalization_dlq_contract_compiled, relay_billing_finalization_queue_enabled,
    relay_billing_finalization_reconcile_compiled, relay_billing_finalization_reconcile_enabled,
    relay_billing_finalization_reconcile_ready, relay_billing_finalization_replay_compiled,
    relay_billing_finalization_runtime_contract_ready,
    relay_billing_missing_usage_estimate_enabled, relay_billing_orphan_recovery_enabled,
    relay_billing_orphan_sweep_limit, relay_billing_prebind_owner_generation_compiled,
    relay_billing_prebind_owner_generation_staging_verified,
    relay_billing_reservation_lease_runtime_status, relay_billing_reservation_lease_seconds,
    relay_billing_reservation_ledger_compiled, relay_billing_stream_error_usage_recovery_compiled,
    relay_billing_stream_lease_heartbeat_runtime_status,
    relay_billing_stream_lease_renewal_compiled, relay_messages_model_fallback_contract_compiled,
    relay_model_fallback_contract_compiled, relay_model_fallback_runtime_status,
    relay_retry_times_from_env, relay_terminal_attempt_audit_contract_compiled,
    relay_wfp_authority_transport_contract_compiled,
    RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED_ENV,
    RELAY_BILLING_PREBIND_OWNER_GENERATION_CONTRACT_VERSION,
    RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED_ENV,
    RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED_ENV,
    RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED_ENV, RELAY_MODEL_FALLBACK_STAGING_VERIFIED_ENV,
};
use crate::relay_billing_queue::BILLING_QUEUE_BINDING;
use crate::relay_billing_smoke::{smoke_compiled, smoke_enabled, smoke_ready};
use crate::task_billing_reconcile::{
    task_submit_reconciliation_compiled, task_submit_reconciliation_enabled,
    TASK_SUBMIT_RECONCILIATION_STAGING_VERIFIED_ENV,
};
use crate::task_orchestration::{
    task_client_idempotency_required, task_poller_config_from_env,
    task_submit_timeout_runtime_status, task_timeout_sweep_compiled, TASK_POLL_LEASE_ENABLED_ENV,
    TASK_POLL_SCHEDULER_ENABLED_ENV,
};
use crate::task_poll_recovery::{
    task_poll_recovery_compiled, task_poll_recovery_enabled,
    TASK_POLL_RECOVERY_STAGING_VERIFIED_ENV,
};
use crate::task_repository::{
    task_billing_intent_contract_compiled, task_poll_lease_contract_compiled,
    task_poll_scheduler_contract_compiled, task_refund_cas_batch_compiled,
    task_refund_replay_contract_compiled, TaskPollLeaseRuntimeStatus,
    TaskPollRecoveryRuntimeStatus, TaskPollSchedulerRuntimeStatus,
    TASK_POLL_LEASE_CONTRACT_VERSION, TASK_POLL_RECOVERY_CONTRACT_VERSION,
    TASK_POLL_SCHEDULER_CONTRACT_VERSION, TASK_SUBMIT_OPERATION_CONTRACT_VERSION,
};
use crate::task_runner::{
    fetch_task_runner_status, is_task_runner_cutover_ready, task_runner_alarm_contract_compiled,
    task_runner_cutover_guards, task_runner_do_foundation_compiled, task_runner_max_alarm_fires,
    task_runner_poll_path_compiled, task_runner_rearm_contract_compiled,
    task_runner_staging_replay_verified, task_runner_status_probe_compiled,
    task_runner_status_probe_task_id, task_runner_storage_error_retry_contract_compiled,
    task_runner_submit_path_compiled, TASK_RUNNER_BINDING, TASK_RUNNER_DO_ENABLED_ENV,
};
use crate::wfp_authority_replay::replay_contract_compiled as wfp_authority_replay_contract_compiled;
use crate::wfp_tenant::{
    wfp_outbound_authority_verifier_compiled, wfp_outbound_egress_policy_compiled,
    wfp_outbound_private_ingress_config_compiled, wfp_outbound_replay_guard_compiled,
    wfp_tenant_ai_gateway_policy_compiled, wfp_tenant_cutover_guards,
    wfp_tenant_internal_dispatch_required_compiled, wfp_tenant_response_header_guard_compiled,
    wfp_tenant_route_manifest_compiled, wfp_tenant_rust_wasm_runtime_compiled,
    wfp_tenant_script_plan_compiled, wfp_tenant_supported_routes,
};

pub const WFP_DISPATCH_BINDING: &str = "DISPATCHER";
pub const WFP_DISPATCH_ENABLED_ENV: &str = "WFP_DISPATCH_ENABLED";
pub const WFP_INTERNAL_DISPATCH_ENABLED_ENV: &str = "WFP_INTERNAL_DISPATCH_ENABLED";
pub const WFP_RELAY_TRANSPORT_ENABLED_ENV: &str = "WFP_RELAY_TRANSPORT_ENABLED";
pub const WFP_PREVIEW_HOST_SUFFIX_ENV: &str = "WFP_PREVIEW_HOST_SUFFIX";
pub const WFP_DISPATCH_WORKER_PREFIX_ENV: &str = "WFP_DISPATCH_WORKER_PREFIX";
pub const RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV: &str = "RELAY_AI_GATEWAY_ROUTER_ENABLED";
pub const RELAY_FLAT_BILLING_INTENT_STAGING_VERIFIED_ENV: &str =
    "RELAY_FLAT_BILLING_INTENT_STAGING_VERIFIED";

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(extends = js_sys::Object)]
    type ContextAwareDispatcher;

    #[wasm_bindgen::prelude::wasm_bindgen(method, catch, js_name = get)]
    fn get_with_outbound_context(
        this: &ContextAwareDispatcher,
        name: String,
        args: JsValue,
        options: JsValue,
    ) -> Result<worker_sys::Fetcher, JsValue>;
}

const RELAY_MODEL_FALLBACK_CUTOVER_GUARDS: &[&str] = &[
    "router_ready",
    "fallback_gate",
    "validated_mapping",
    "messages_schema_compatibility",
    "token_model_limit_recheck",
    "fallback_channel_reselection",
    "fallback_billing_rereservation",
    "actual_serving_group_billing",
    "server_failure_only",
    "provider_native_direct_body",
    "model_route_audit",
    "terminal_attempt_audit",
    "staging_replay",
    "messages_staging_replay",
];
pub const REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED_ENV: &str =
    "REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED";
pub const EXPECTED_D1_MIGRATION: &str = "0045_relay_container_reconciliation_retry_apply.sql";
pub const TASK_POLL_LEASE_STAGING_VERIFIED_ENV: &str = "TASK_POLL_LEASE_STAGING_VERIFIED";
pub const TASK_POLL_SCHEDULER_STAGING_VERIFIED_ENV: &str = "TASK_POLL_SCHEDULER_STAGING_VERIFIED";
const RELAY_BILLING_PREBIND_OWNER_GENERATION_CUTOVER_GUARDS: &[&str] = &[
    "migration_0026_applied",
    "legacy_workers_drained",
    "active_reservations_drained_before_migration",
    "prebind_heartbeat",
    "late_bind_deadline",
    "owner_generation_cas",
    "queue_v2_generation",
    "staging_race_replay",
];
const RELAY_FLAT_BILLING_GO_PARITY_BLOCKERS: &[&str] = &[
    "ali_async_image_task_settlement",
    "free_model_runtime_policy",
    "provider_usage_staging_reconciliation",
    "task_v2_durable_ownership",
    "subscription_funding_source_parity",
    "realtime_flat_billing_parity",
];
const TASK_V2_CUTOVER_GUARDS: &[&str] = &[
    "migration_0039_applied",
    "pre_provider_reservation",
    "provider_operation_local_uniqueness",
    "whole_submit_deadline",
    "provider_native_idempotency",
    "provider_operation_lookup",
    "submit_unknown_fail_closed",
    "operator_reconciliation_evidence",
    "atomic_task_attachment",
    "atomic_terminal_financial_transition",
    "shared_poll_lease",
    "poll_lease_old_writer_enforcement",
    "audited_poll_quarantine_recovery",
    "staging_fault_replay",
];
const EXPECTED_D1_MIGRATIONS: &[&str] = &[
    "0001_core.sql",
    "0002_admin_tables.sql",
    "0003_topups.sql",
    "0004_schema_parity.sql",
    "0005_topups_credited.sql",
    "0006_two_fa.sql",
    "0007_midjourneys.sql",
    "0008_model_meta.sql",
    "0009_prefill_groups.sql",
    "0010_custom_oauth.sql",
    "0011_checkins.sql",
    "0012_redemptions.sql",
    "0013_subscriptions.sql",
    "0014_redemptions_credited.sql",
    "0015_topups_payment_provider.sql",
    "0016_passkey_credentials.sql",
    "0017_user_session_epoch.sql",
    "0018_realtime_settlement_replays.sql",
    "0019_realtime_billing_reservations.sql",
    "0020_realtime_billing_reservation_leases.sql",
    "0021_realtime_billing_bridge_segments.sql",
    "0022_realtime_billing_global_recovery.sql",
    "0023_relay_billing_reservations.sql",
    "0024_relay_billing_finalization_events.sql",
    "0025_relay_billing_finalization_incidents.sql",
    "0026_relay_billing_owner_generation.sql",
    "0027_realtime_usage_reconciliation.sql",
    "0028_realtime_usage_reconciliation_resolution.sql",
    "0029_flat_billing_intents.sql",
    "0030_billing_contract_immutability.sql",
    "0031_task_billing_intents.sql",
    "0032_task_submit_reconciliation.sql",
    "0033_task_submit_reconciliation_enforce.sql",
    "0034_task_poll_lease.sql",
    "0035_task_poll_lease_enforce.sql",
    "0036_task_poll_schedule.sql",
    "0037_task_poll_recovery.sql",
    "0038_task_submit_operation_expand.sql",
    "0039_task_submit_operation_enforce.sql",
    "0040_relay_container_operations.sql",
    "0041_relay_container_operation_lifecycle_hardening.sql",
    "0042_relay_container_financial_terminal_expand.sql",
    "0043_relay_container_reconciliation_observer.sql",
    "0044_relay_container_r2_orphan_inventory.sql",
    "0045_relay_container_reconciliation_retry_apply.sql",
];
#[cfg(test)]
const INTERNAL_DISPATCH_PREFIX: &str = "/api/platform/dispatch/";
const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const AI_GATEWAY_ID_ENV: &str = "AI_GATEWAY_ID";
const WFP_ROUTE_REQUEST_HEADER: &str = "x-cinatoken-wfp-route";
const WFP_WORKER_REQUEST_HEADER: &str = "x-cinatoken-wfp-worker";
const BLOCKED_DISPATCH_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "api-key",
    "cf-access-client-id",
    "cf-access-client-secret",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchTarget {
    pub route_kind: DispatchRouteKind,
    pub public_name: String,
    pub worker_name: String,
    pub tenant_path: Option<String>,
    authority: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchRouteKind {
    PreviewHost,
    InternalPath,
    RelayAuthority,
}

impl DispatchRouteKind {
    fn header_value(self) -> &'static str {
        match self {
            DispatchRouteKind::PreviewHost => "preview-host",
            DispatchRouteKind::InternalPath => "internal-path",
            DispatchRouteKind::RelayAuthority => "relay-authority",
        }
    }
}

const WFP_DISPATCH_FAILURE_CONTRACT_VERSION: u32 = 1;
const WFP_DISPATCH_FAILURE_CLASSES: &[&str] = &[
    "worker_not_found",
    "resource_limit_exceeded",
    "tenant_execution_failed",
];
const WFP_PREVIEW_SECURITY_HEADERS: &[&str] = &[
    "service-worker-allowed",
    "service-worker-navigation-preload",
    "clear-site-data",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WfpDispatchFailureKind {
    WorkerNotFound,
    ResourceLimitExceeded,
    TenantExecutionFailed,
}

impl WfpDispatchFailureKind {
    fn label(self) -> &'static str {
        match self {
            Self::WorkerNotFound => "worker_not_found",
            Self::ResourceLimitExceeded => "resource_limit_exceeded",
            Self::TenantExecutionFailed => "tenant_execution_failed",
        }
    }
}

#[derive(Debug, Serialize)]
struct PlatformCapabilities {
    scheduling_gateway_compiled: bool,
    scheduling_gateway_active: bool,
    scheduling_gateway_owner_contract_version: u32,
    scheduling_gateway_route_precedence: Vec<&'static str>,
    scheduling_gateway_preview_fail_closed_compiled: bool,
    d1_migration_status_available: bool,
    d1_migration_applied_count: i64,
    d1_migration_latest: Option<String>,
    d1_expected_migration: &'static str,
    d1_expected_migration_applied: bool,
    d1_migration_set_matches: bool,
    d1_migration_ready: bool,
    ai_binding_available: bool,
    ai_gateway_id_configured: bool,
    cloudflare_account_id_configured: bool,
    cloudflare_ai_gateway_token_configured: bool,
    relay_ai_gateway_router_enabled: bool,
    relay_ai_gateway_router_ready: bool,
    relay_ai_gateway_rest_routes: Vec<&'static str>,
    relay_ai_gateway_model_prefixes: Vec<&'static str>,
    relay_ai_gateway_direct_fallback_prefixes: Vec<&'static str>,
    relay_ai_gateway_cutover_guards: Vec<&'static str>,
    relay_ai_gateway_channel_opt_in_supported: bool,
    relay_ai_gateway_rest_forwarder_compiled: bool,
    relay_ai_gateway_same_channel_fallback_compiled: bool,
    relay_ai_gateway_cross_model_fallback_compiled: bool,
    relay_ai_gateway_messages_cross_model_fallback_compiled: bool,
    relay_ai_gateway_messages_cross_model_fallback_staging_verified: bool,
    relay_ai_gateway_messages_cross_model_fallback_cutover_ready: bool,
    relay_ai_gateway_cross_model_fallback_enabled: bool,
    relay_ai_gateway_cross_model_fallback_configured: bool,
    relay_ai_gateway_cross_model_fallback_config_valid: bool,
    relay_ai_gateway_cross_model_fallback_mapping_count: usize,
    relay_ai_gateway_cross_model_actual_group_billing_compiled: bool,
    relay_ai_gateway_actual_group_billing_staging_smoke_compiled: bool,
    relay_ai_gateway_actual_group_billing_staging_smoke_enabled: bool,
    relay_ai_gateway_actual_group_billing_staging_smoke_ready: bool,
    relay_ai_gateway_cross_model_terminal_audit_compiled: bool,
    relay_ai_gateway_cross_model_fallback_ready: bool,
    relay_ai_gateway_cross_model_fallback_staging_verified: bool,
    relay_ai_gateway_cross_model_fallback_cutover_ready: bool,
    relay_ai_gateway_cross_model_fallback_cutover_guards: Vec<&'static str>,
    relay_retry_times: Option<u32>,
    channel_affinity_do_available: bool,
    realtime_sessions_do_available: bool,
    container_scheduler_contract_version: u32,
    container_scheduler_foundation_compiled: bool,
    container_scheduler_configured: bool,
    container_scheduler_config_valid: bool,
    container_scheduler_ring_generation: u64,
    container_scheduler_shard_count: u16,
    container_scheduler_enabled: bool,
    container_scheduler_routing_secret_configured: bool,
    container_scheduler_controller_service_binding_available: bool,
    container_scheduler_controller_probe_enabled: bool,
    container_scheduler_controller_authority_configured: bool,
    container_scheduler_controller_status_verified: bool,
    container_scheduler_controller_ready: bool,
    container_scheduler_controller_status_state: &'static str,
    container_scheduler_controller_enabled: bool,
    container_scheduler_controller_execution_enabled: bool,
    container_scheduler_controller_previous_secret_configured: bool,
    container_scheduler_shard_readiness_probe_compiled: bool,
    container_scheduler_shard_readiness_probe_enabled: bool,
    container_scheduler_shard_readiness_wake_enabled: bool,
    container_scheduler_shard_readiness_staging_verified: bool,
    container_scheduler_container_runtime_compiled: bool,
    container_scheduler_deny_by_default_egress_compiled: bool,
    container_scheduler_shared_storage_contract_compiled: bool,
    container_financial_terminal_compiled: bool,
    container_exact_response_replay_compiled: bool,
    container_divergence_reconciliation_compiled: bool,
    container_operation_write_enabled: bool,
    container_terminal_cas_enabled: bool,
    container_financial_terminal_enabled: bool,
    container_exact_response_replay_enabled: bool,
    container_operation_reconciliation_enabled: bool,
    container_divergence_reconciliation_verified: bool,
    container_chat_canary_enabled: bool,
    container_operation_staging_verified: bool,
    container_operation_runtime_ready: bool,
    container_scheduler_n_minus_one_protocol_compiled: bool,
    container_scheduler_capacity_rejection_compiled: bool,
    container_scheduler_remote_fault_matrix_verified: bool,
    container_scheduler_staging_verified: bool,
    container_scheduler_cutover_ready: bool,
    container_scheduler_cutover_guards: Vec<&'static str>,
    quota_coordinator_contract_version: u32,
    quota_coordinator_do_available: bool,
    quota_coordinator_shadow_enabled: bool,
    quota_coordinator_foundation_compiled: bool,
    quota_coordinator_observer_contract_compiled: bool,
    quota_coordinator_reserve_observation_compiled: bool,
    quota_coordinator_finalization_observation_compiled: bool,
    quota_coordinator_recovery_observation_compiled: bool,
    quota_coordinator_relay_observation_compiled: bool,
    quota_coordinator_retention_compaction_compiled: bool,
    quota_coordinator_reconciliation_compiled: bool,
    quota_coordinator_reconciliation_runtime_ready: bool,
    quota_coordinator_storage_retention_ready: bool,
    quota_coordinator_shadow_token_allowlist_configured: bool,
    quota_coordinator_shadow_token_allowlist_valid: bool,
    quota_coordinator_shadow_token_count: usize,
    quota_coordinator_reservation_ledger_only: bool,
    quota_coordinator_tiered_only: bool,
    quota_coordinator_write_authority_enabled: bool,
    quota_coordinator_staging_verified: bool,
    quota_coordinator_shadow_runtime_ready: bool,
    quota_coordinator_cutover_ready: bool,
    quota_coordinator_cutover_guards: Vec<&'static str>,
    wfp_dispatch_binding_available: bool,
    wfp_dispatch_enabled: bool,
    wfp_internal_dispatch_enabled: bool,
    wfp_dispatch_failure_contract_version: u32,
    wfp_dispatch_failure_classes: Vec<&'static str>,
    wfp_dispatch_failure_contract_compiled: bool,
    wfp_relay_transport_enabled: bool,
    wfp_relay_authority_secret_configured: bool,
    wfp_authority_replay_do_available: bool,
    wfp_authority_replay_do_compiled: bool,
    wfp_preview_host_suffix_configured: bool,
    wfp_worker_prefix_configured: bool,
    wfp_tenant_supported_routes: Vec<&'static str>,
    wfp_tenant_cutover_guards: Vec<&'static str>,
    wfp_tenant_script_plan_compiled: bool,
    wfp_tenant_rust_wasm_runtime_compiled: bool,
    wfp_tenant_route_manifest_compiled: bool,
    wfp_tenant_internal_dispatch_required_compiled: bool,
    wfp_outbound_invocation_context_compiled: bool,
    wfp_outbound_authority_verifier_compiled: bool,
    wfp_outbound_replay_guard_compiled: bool,
    wfp_tenant_response_header_guard_compiled: bool,
    wfp_preview_response_security_headers_compiled: bool,
    wfp_tenant_ai_gateway_policy_compiled: bool,
    wfp_outbound_egress_policy_compiled: bool,
    wfp_outbound_private_ingress_config_compiled: bool,
    wfp_relay_authority_transport_compiled: bool,
    wfp_relay_authority_transport_ready: bool,
    wfp_tenant_smoke_ready: bool,
    relay_billing_reservation_ledger_compiled: bool,
    relay_billing_ledger_status_compiled: bool,
    relay_flat_billing_intent_contract_version: u32,
    relay_flat_billing_intent_compiled: bool,
    relay_flat_billing_intent_schema_ready: bool,
    relay_flat_billing_intent_runtime_ready: bool,
    relay_flat_billing_go_parity_ready: bool,
    relay_flat_billing_go_parity_blockers: Vec<&'static str>,
    relay_flat_billing_intent_staging_verified: bool,
    relay_flat_billing_intent_cutover_ready: bool,
    subscription_funding_source_compiled: bool,
    subscription_funding_source_runtime_ready: bool,
    subscription_funding_source_staging_verified: bool,
    subscription_funding_source_cutover_ready: bool,
    subscription_funding_supported_surfaces: Vec<&'static str>,
    relay_billing_reservation_lease_seconds: i64,
    relay_billing_prebind_owner_generation_contract_version: u32,
    relay_billing_prebind_owner_generation_compiled: bool,
    relay_billing_prebind_owner_generation_schema_ready: bool,
    relay_billing_prebind_owner_deadline_configured: bool,
    relay_billing_prebind_owner_deadline_valid: bool,
    relay_billing_prebind_owner_deadline_seconds: i64,
    relay_billing_prebind_owner_generation_configured: bool,
    relay_billing_prebind_owner_generation_staging_verified: bool,
    relay_billing_prebind_owner_generation_cutover_ready: bool,
    relay_billing_prebind_owner_generation_cutover_guards: Vec<&'static str>,
    relay_billing_stream_lease_renewal_compiled: bool,
    relay_billing_stream_lease_heartbeat_configured: bool,
    relay_billing_stream_lease_heartbeat_valid: bool,
    relay_billing_stream_lease_heartbeat_seconds: i64,
    relay_billing_stream_lease_renewal_staging_verified: bool,
    relay_billing_stream_error_usage_recovery_compiled: bool,
    relay_billing_stream_error_usage_recovery_staging_verified: bool,
    relay_billing_missing_usage_estimate_enabled: bool,
    relay_billing_finalization_queue_enabled: bool,
    relay_billing_finalization_queue_available: bool,
    relay_billing_finalization_consumer_compiled: bool,
    relay_billing_finalization_dlq_contract_compiled: bool,
    relay_billing_finalization_replay_compiled: bool,
    relay_billing_finalization_dlq_consumer_compiled: bool,
    relay_billing_finalization_reconcile_compiled: bool,
    relay_billing_finalization_reconcile_enabled: bool,
    relay_billing_finalization_reconcile_ready: bool,
    relay_billing_finalization_runtime_ready: bool,
    relay_billing_finalization_replay_staging_verified: bool,
    relay_billing_orphan_recovery_enabled: bool,
    relay_billing_orphan_recovery_ready: bool,
    relay_billing_orphan_recovery_cutover_ready: bool,
    relay_billing_orphan_recovery_grace_seconds: i64,
    relay_billing_orphan_sweep_limit: i64,
    realtime_session_gateway_enabled: bool,
    realtime_session_v1_enabled: bool,
    realtime_session_billing_settlement_write_enabled: bool,
    do_websocket_hibernation_compiled: bool,
    realtime_session_cutover_guards: Vec<&'static str>,
    realtime_session_auth_boundary_compiled: bool,
    realtime_session_metrics_persisted_compiled: bool,
    realtime_session_control_no_echo_compiled: bool,
    realtime_session_upstream_bridge_planner_compiled: bool,
    realtime_session_upstream_channel_planner_compiled: bool,
    realtime_session_upstream_bridge_connect_contract_compiled: bool,
    realtime_session_upstream_connect_handoff_compiled: bool,
    realtime_session_upstream_fetch_upgrade_adapter_compiled: bool,
    realtime_session_upstream_bridge_lifecycle_compiled: bool,
    realtime_session_upstream_bridge_hibernation_fail_closed_compiled: bool,
    realtime_session_upstream_bridge_frame_guard_compiled: bool,
    realtime_session_upstream_bridge_close_mapping_compiled: bool,
    realtime_session_upstream_bridge_send_failure_guard_compiled: bool,
    realtime_session_upstream_bridge_event_trace_compiled: bool,
    realtime_session_upstream_bridge_replay_contract_compiled: bool,
    realtime_session_upstream_bridge_backpressure_policy_compiled: bool,
    realtime_session_upstream_bridge_backpressure_runtime_compiled: bool,
    realtime_session_upstream_usage_capture_compiled: bool,
    realtime_session_billing_presettlement_snapshot_compiled: bool,
    realtime_session_billing_settlement_preview_compiled: bool,
    realtime_session_billing_settlement_handoff_compiled: bool,
    realtime_session_billing_settlement_mutation_plan_compiled: bool,
    realtime_session_billing_settlement_writer_compiled: bool,
    realtime_session_billing_settlement_replay_marker_compiled: bool,
    realtime_session_billing_settlement_audit_log_compiled: bool,
    realtime_session_billing_settlement_batch_compiled: bool,
    realtime_session_billing_settlement_retry_compiled: bool,
    realtime_session_billing_reservation_lease_compiled: bool,
    realtime_session_billing_reservation_lease_seconds: u64,
    realtime_session_billing_global_orphan_recovery_compiled: bool,
    realtime_session_billing_global_orphan_recovery_enabled: bool,
    realtime_session_billing_global_orphan_recovery_ready: bool,
    realtime_session_billing_orphan_recovery_grace_seconds: i64,
    realtime_session_billing_orphan_sweep_limit: i64,
    realtime_session_billing_ledger_status_compiled: bool,
    realtime_session_usage_reconciliation_compiled: bool,
    realtime_session_billing_reconciliation_compiled: bool,
    realtime_session_billing_reconciliation_enabled: bool,
    realtime_session_billing_reconciliation_ready: bool,
    realtime_session_billing_reconciliation_staging_verified: bool,
    realtime_session_billing_reconciliation_cutover_ready: bool,
    realtime_session_billing_settlement_staging_smoke_compiled: bool,
    realtime_session_billing_settlement_staging_smoke_enabled: bool,
    realtime_session_billing_settlement_staging_smoke_ready: bool,
    realtime_session_platform_header_boundary_compiled: bool,
    realtime_session_platform_admin_auth_compiled: bool,
    realtime_session_upstream_bridge_compiled: bool,
    realtime_session_billing_settlement_compiled: bool,
    realtime_session_platform_smoke_ready: bool,
    realtime_session_v1_cutover_ready: bool,
    realtime_flat_billing_compiled: bool,
    realtime_flat_billing_runtime_ready: bool,
    realtime_flat_billing_staging_verified: bool,
    realtime_flat_billing_cutover_ready: bool,
    task_v2_contract_version: u32,
    task_v2_ownership_compiled: bool,
    task_v2_schema_ready: bool,
    task_v2_runtime_ready: bool,
    task_v2_staging_verified: bool,
    task_v2_cutover_ready: bool,
    task_v2_cutover_guards: Vec<&'static str>,
    task_submit_operation_contract_version: u32,
    task_submit_operation_compiled: bool,
    task_submit_operation_schema_ready: bool,
    task_submit_timeout_configured: bool,
    task_submit_timeout_valid: bool,
    task_submit_timeout_seconds: i64,
    task_submit_client_idempotency_compiled: bool,
    task_submit_client_idempotency_required: bool,
    task_submit_status_query_compiled: bool,
    task_submit_local_operation_unique: bool,
    task_submit_provider_native_idempotency_verified: bool,
    task_submit_provider_lookup_verified: bool,
    task_submit_operation_cutover_ready: bool,
    task_poll_lease_contract_version: u32,
    task_poll_lease_compiled: bool,
    task_poll_lease_schema_ready: bool,
    task_poll_lease_enabled: bool,
    task_poll_lease_authority_enabled: bool,
    task_poll_lease_enforcement_enabled: bool,
    task_poll_lease_runtime_ready: bool,
    task_poll_lease_staging_verified: bool,
    task_poll_lease_cutover_ready: bool,
    task_poll_scheduler_contract_version: u32,
    task_poll_scheduler_compiled: bool,
    task_poll_scheduler_schema_ready: bool,
    task_poll_scheduler_enabled: bool,
    task_poll_scheduler_runtime_ready: bool,
    task_poll_scheduler_staging_verified: bool,
    task_poll_scheduler_cutover_ready: bool,
    task_poll_recovery_contract_version: u32,
    task_poll_recovery_compiled: bool,
    task_poll_recovery_schema_ready: bool,
    task_poll_recovery_enabled: bool,
    task_poll_recovery_runtime_ready: bool,
    task_poll_recovery_staging_verified: bool,
    task_poll_recovery_cutover_ready: bool,
    task_submit_reconciliation_compiled: bool,
    task_submit_reconciliation_enabled: bool,
    task_submit_reconciliation_read_ready: bool,
    task_submit_reconciliation_ready: bool,
    task_submit_reconciliation_staging_verified: bool,
    task_submit_reconciliation_cutover_ready: bool,
    task_poller_scheduled_handler_compiled: bool,
    task_poller_timeout_sweep_compiled: bool,
    task_poller_refund_batch_compiled: bool,
    task_poller_refund_replay_contract_compiled: bool,
    task_runner_do_available: bool,
    task_runner_do_enabled: bool,
    task_runner_do_foundation_compiled: bool,
    task_runner_alarm_contract_compiled: bool,
    task_runner_storage_error_retry_contract_compiled: bool,
    task_runner_rearm_contract_compiled: bool,
    task_runner_max_alarm_fires: u32,
    task_runner_submit_path_compiled: bool,
    task_runner_poll_path_compiled: bool,
    task_runner_status_probe_compiled: bool,
    task_runner_staging_replay_verified: bool,
    task_runner_cutover_ready: bool,
    task_runner_cutover_guards: Vec<&'static str>,
    task_poller_timeout_sweep_enabled: bool,
    task_poller_query_limit: i64,
    task_poller_timeout_minutes: i64,
    task_poller_timeout_sweep_limit: i64,
    task_poller_poll_lease_seconds: i64,
    task_poller_retry_base_seconds: i64,
    task_poller_retry_max_seconds: i64,
    task_poller_max_consecutive_failures: i64,
}

const REALTIME_BILLING_RECOVERY_STATUS_LIMIT: i64 = 50;
const RELAY_BILLING_RECOVERY_STATUS_LIMIT: i64 = 50;

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RelayBillingLedgerStatus {
    contract_version: u32,
    count: usize,
    global_sweep: Option<RelayBillingGlobalSweepStatus>,
    records: Vec<RelayBillingLedgerStatusMetadata>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RelayBillingGlobalSweepStatus {
    last_started_at: i64,
    last_completed_at: i64,
    last_success_at: Option<i64>,
    last_candidates: i64,
    last_refunded: i64,
    last_recovery_required: i64,
    last_failed: i64,
    last_deferred: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RelayBillingLedgerStatusMetadata {
    reservation_fingerprint: String,
    account_scope_fingerprint: String,
    outcome: RelayBillingLedgerOutcome,
    terminal: bool,
    selected: bool,
    request_accounted: bool,
    lease_expires_at: i64,
    updated_at: i64,
    settled_at: Option<i64>,
    refunded_at: Option<i64>,
    recovery_required_at: Option<i64>,
    recovery_attempt_count: i64,
    recovery_next_attempt_at: Option<i64>,
    recovery_last_attempt_at: Option<i64>,
    recovery_state: RelayBillingRecoveryState,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelayBillingLedgerOutcome {
    Reserved,
    Settled,
    Refunded,
    RecoveryRequired,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelayBillingRecoveryState {
    SettlementGrace,
    RetryBackoff,
    RecoveryDue,
    ManualReconciliation,
    Terminal,
    Unknown,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RealtimeBillingLedgerStatus {
    contract_version: u32,
    count: usize,
    global_sweep: Option<RealtimeBillingGlobalSweepStatus>,
    records: Vec<RealtimeBillingLedgerStatusMetadata>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RealtimeBillingGlobalSweepStatus {
    last_started_at: i64,
    last_completed_at: i64,
    last_success_at: Option<i64>,
    last_candidates: i64,
    last_refunded: i64,
    last_recovery_required: i64,
    last_failed: i64,
    last_deferred: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RealtimeBillingLedgerStatusMetadata {
    reservation_fingerprint: String,
    scope_kind: &'static str,
    scope_fingerprint: String,
    outcome: RealtimeBillingLedgerOutcome,
    terminal: bool,
    reservation_sequence: i64,
    lease_expires_at: i64,
    updated_at: i64,
    settled_at: Option<i64>,
    refunded_at: Option<i64>,
    recovery_attempt_count: i64,
    recovery_next_attempt_at: Option<i64>,
    recovery_last_attempt_at: Option<i64>,
    recovery_state: RealtimeBillingRecoveryState,
    requires_reconciliation: bool,
    finalization_reason: Option<String>,
    finalization_required_at: Option<i64>,
    reconciliation_id: Option<String>,
    reconciliation_revision: i64,
    reconciliation_resolution: Option<String>,
    reconciliation_resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RealtimeBillingLedgerOutcome {
    Reserved,
    Settled,
    Refunded,
    RecoveryRequired,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RealtimeBillingRecoveryState {
    SettlementGrace,
    RecoveryDue,
    RetryBackoff,
    ManualReconciliation,
    Terminal,
    Unknown,
}

const CONTAINER_READINESS_ADMIN_BODY_LIMIT_BYTES: usize = 1_024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContainerShardReadinessRequest {
    shard_index: u16,
    expected_ring_generation: u64,
    wake_container: bool,
    confirm_wake: bool,
}

/// Admin-only targeted shard inspection. Ledger mode is side-effect free;
/// live mode is separately gated because it can cold-start a Container.
pub async fn container_shard_readiness(mut req: Request, env: Env) -> WorkerResult<Response> {
    let admin = match require_admin_auth(&req, &env).await? {
        Ok(admin) => admin,
        Err(response) => return Ok(response),
    };
    if !env_flag(&env, CONTAINER_SHARD_READINESS_PROBE_ENABLED_ENV) {
        return Ok(envelope_error_response(
            503,
            "container shard readiness probe is disabled",
        ));
    }
    let content_type = req
        .headers()
        .get("content-type")?
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if content_type != "application/json" {
        return Ok(envelope_error_response(
            415,
            "container shard readiness requires application/json",
        ));
    }
    if let Some(content_length) = req.headers().get("content-length")? {
        let valid = content_length
            .parse::<usize>()
            .ok()
            .is_some_and(|length| length <= CONTAINER_READINESS_ADMIN_BODY_LIMIT_BYTES);
        if !valid {
            return Ok(envelope_error_response(
                413,
                "container shard readiness request body too large",
            ));
        }
    }
    let mut stream = match req.stream() {
        Ok(stream) => stream,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "failed to read container shard readiness request",
            ));
        }
    };
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                return Ok(envelope_error_response(
                    400,
                    "failed to read container shard readiness request",
                ));
            }
        };
        if body.len().saturating_add(chunk.len()) > CONTAINER_READINESS_ADMIN_BODY_LIMIT_BYTES {
            return Ok(envelope_error_response(
                413,
                "container shard readiness request body too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let input: ContainerShardReadinessRequest = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "invalid container shard readiness request",
            ));
        }
    };
    if input.wake_container != input.confirm_wake {
        return Ok(envelope_error_response(
            400,
            "confirm_wake must exactly match wake_container",
        ));
    }
    let runtime = container_scheduler_runtime_status(&env);
    if !runtime.valid {
        return Ok(envelope_error_response(
            503,
            "container shard ring is misconfigured",
        ));
    }
    if input.expected_ring_generation != runtime.ring_generation {
        return Ok(envelope_error_response(
            409,
            "container shard ring generation changed",
        ));
    }
    if input.wake_container {
        if !env_flag(&env, CONTAINER_SHARD_READINESS_WAKE_ENABLED_ENV) {
            return Ok(envelope_error_response(
                503,
                "container shard readiness wake is disabled",
            ));
        }
        let production = runtime_value(&env, "ENVIRONMENT")
            .is_some_and(|value| matches!(value.as_str(), "production" | "prod"));
        if production && !env_flag(&env, CONTAINER_SHARD_READINESS_STAGING_VERIFIED_ENV) {
            return Ok(envelope_error_response(
                403,
                "container shard readiness wake is not staging-verified",
            ));
        }
    }
    let shard = match ShardRing::new(runtime.ring_generation, runtime.shard_count)
        .and_then(|ring| ring.shard(input.shard_index))
    {
        Ok(shard) => shard,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "container shard index is outside the active ring",
            ));
        }
    };
    let result = match probe_shard_readiness(&env, &shard, input.wake_container).await {
        Ok(result) => result,
        Err(error) => {
            worker::console_warn!(
                "{}",
                json!({
                    "event": "container_shard_readiness_failed",
                    "admin_id": admin.id,
                    "shard_index": input.shard_index,
                    "wake_container": input.wake_container,
                    "error_code": error,
                })
            );
            let (status, message) = match error {
                "shard_fence_rejected" => (409, "container shard fence rejected"),
                "readiness_conflict" => (
                    409,
                    "container shard readiness conflicts with an active or replayed probe",
                ),
                "readiness_rate_limited" => (429, "container shard readiness rate limited"),
                "timeout" => (504, "container shard readiness timed out"),
                "authority_rejected"
                | "contract_mismatch"
                | "invalid_content_type"
                | "invalid_response_body"
                | "invalid_response_size" => (
                    502,
                    "container controller returned an invalid readiness response",
                ),
                _ => (503, "container shard readiness is unavailable"),
            };
            return Ok(envelope_error_response(status, message));
        }
    };
    worker::console_log!(
        "{}",
        json!({
            "event": "container_shard_readiness_completed",
            "admin_id": admin.id,
            "probe_id": &result.probe_id,
            "shard_index": result.shard.shard_index,
            "wake_container": result.wake_requested,
            "mode": &result.mode,
            "ready": result.ready,
            "result_code": &result.result_code,
        })
    );
    let mut response = envelope_ok_response(&result)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

/// Admin-only capability probe for the production migration cockpit.
pub async fn capabilities(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }

    let d1_migration_status = load_d1_migration_status(&env).await;
    let d1_migration_ready = d1_migration_status.ready();
    let (
        task_v2_object_schema_ready,
        task_poll_lease_status,
        task_poll_scheduler_status,
        task_poll_recovery_status,
    ) = match env.d1("DB") {
        Ok(db) => (
            crate::task_repository::task_billing_intent_schema_ready(&db)
                .await
                .unwrap_or(false),
            crate::task_repository::task_poll_lease_runtime_status(&db)
                .await
                .unwrap_or(TaskPollLeaseRuntimeStatus {
                    schema_ready: false,
                    authority_enabled: false,
                    enforcement_enabled: false,
                }),
            crate::task_repository::task_poll_scheduler_runtime_status(&db)
                .await
                .unwrap_or(TaskPollSchedulerRuntimeStatus {
                    schema_ready: false,
                }),
            crate::task_repository::task_poll_recovery_runtime_status(&db)
                .await
                .unwrap_or(TaskPollRecoveryRuntimeStatus {
                    schema_ready: false,
                }),
        ),
        Err(_) => (
            false,
            TaskPollLeaseRuntimeStatus {
                schema_ready: false,
                authority_enabled: false,
                enforcement_enabled: false,
            },
            TaskPollSchedulerRuntimeStatus {
                schema_ready: false,
            },
            TaskPollRecoveryRuntimeStatus {
                schema_ready: false,
            },
        ),
    };
    let ai_gateway_id = runtime_value(&env, AI_GATEWAY_ID_ENV);
    let cloudflare_account_id = runtime_value(&env, CLOUDFLARE_ACCOUNT_ID_ENV);
    let cloudflare_ai_gateway_token = secret_or_var(
        &env,
        crate::relay_ai_gateway_policy::CLOUDFLARE_AI_GATEWAY_TOKEN_ENV,
    );
    let ai_gateway_id_configured = ai_gateway_id.is_some();
    let cloudflare_account_id_configured = cloudflare_account_id.is_some();
    let cloudflare_ai_gateway_token_configured = cloudflare_ai_gateway_token.is_some();
    let relay_ai_gateway_router_enabled = env_flag(&env, RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV);
    let relay_ai_gateway_router_ready =
        crate::relay_ai_gateway_policy::relay_ai_gateway_runtime_config(
            relay_ai_gateway_router_enabled,
            cloudflare_account_id,
            ai_gateway_id,
            cloudflare_ai_gateway_token,
        )
        .is_some();
    let relay_ai_gateway_messages_cross_model_fallback_compiled =
        relay_messages_model_fallback_contract_compiled();
    let relay_ai_gateway_cross_model_fallback_compiled = relay_model_fallback_contract_compiled()
        && relay_ai_gateway_messages_cross_model_fallback_compiled;
    let relay_ai_gateway_cross_model_actual_group_billing_compiled =
        relay_actual_serving_group_billing_contract_compiled();
    let relay_ai_gateway_actual_group_billing_staging_smoke_compiled = smoke_compiled();
    let relay_ai_gateway_actual_group_billing_staging_smoke_enabled = smoke_enabled(&env);
    let relay_ai_gateway_actual_group_billing_staging_smoke_ready =
        smoke_ready(&env, d1_migration_ready);
    let relay_ai_gateway_cross_model_terminal_audit_compiled =
        relay_terminal_attempt_audit_contract_compiled();
    let relay_model_fallback_runtime = relay_model_fallback_runtime_status(&env);
    let relay_ai_gateway_cross_model_fallback_ready = is_relay_model_fallback_ready(
        relay_ai_gateway_router_ready,
        relay_ai_gateway_cross_model_fallback_compiled,
        relay_ai_gateway_cross_model_actual_group_billing_compiled,
        relay_ai_gateway_cross_model_terminal_audit_compiled,
        relay_model_fallback_runtime.enabled,
        relay_model_fallback_runtime.configured,
        relay_model_fallback_runtime.valid,
    );
    let relay_ai_gateway_cross_model_fallback_staging_verified =
        env_flag(&env, RELAY_MODEL_FALLBACK_STAGING_VERIFIED_ENV);
    let relay_ai_gateway_messages_cross_model_fallback_staging_verified =
        env_flag(&env, RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED_ENV);
    let relay_ai_gateway_messages_cross_model_fallback_cutover_ready =
        is_relay_model_fallback_cutover_ready(
            relay_ai_gateway_cross_model_fallback_ready,
            relay_ai_gateway_messages_cross_model_fallback_staging_verified,
        );
    let relay_ai_gateway_cross_model_fallback_cutover_ready = is_relay_model_fallback_cutover_ready(
        relay_ai_gateway_cross_model_fallback_ready,
        relay_ai_gateway_cross_model_fallback_staging_verified
            && relay_ai_gateway_messages_cross_model_fallback_staging_verified,
    );
    let realtime_sessions_do_available = env.durable_object("REALTIME_SESSIONS").is_ok();
    let container_scheduler_status = container_scheduler_runtime_status(&env);
    let container_operation_runtime = container_operation_runtime_status(&env);
    let container_financial_terminal_compiled = true;
    let container_exact_response_replay_compiled = false;
    let container_divergence_reconciliation_compiled = false;
    let container_operation_runtime_ready = container_operation_runtime.cutover_ready()
        && container_financial_terminal_compiled
        && container_exact_response_replay_compiled
        && container_divergence_reconciliation_compiled;
    let container_scheduler_contract_version = CONTAINER_SHARD_CONTRACT_VERSION;
    let container_scheduler_foundation_compiled = container_scheduler_foundation_compiled();
    let container_scheduler_enabled = env_flag(&env, CONTAINER_SCHEDULER_ENABLED_ENV);
    let container_scheduler_routing_secret_configured =
        container_scheduler_routing_secret_configured(&env);
    let container_controller_probe =
        probe_container_controller(&env, container_scheduler_status).await;
    // Local source contracts are reported separately from deployed bindings,
    // rolling compatibility, and remote fault evidence.
    let container_local_contracts = container_local_contracts();
    let container_scheduler_controller_service_binding_available =
        container_controller_probe.binding_available;
    let container_scheduler_controller_probe_enabled = container_controller_probe.probe_enabled;
    let container_scheduler_controller_authority_configured =
        container_controller_probe.authority_configured;
    let container_scheduler_controller_status_verified = container_controller_probe.verified;
    let container_scheduler_controller_ready = container_controller_probe.verified
        && container_controller_probe.controller_enabled
        && container_controller_probe.execution_enabled;
    let container_scheduler_controller_status_state = container_controller_probe.state;
    let container_scheduler_controller_enabled = container_controller_probe.controller_enabled;
    let container_scheduler_controller_execution_enabled =
        container_controller_probe.execution_enabled;
    let container_scheduler_controller_previous_secret_configured =
        container_controller_probe.previous_secret_configured;
    let container_scheduler_shard_readiness_probe_compiled = true;
    let container_scheduler_shard_readiness_probe_enabled =
        env_flag(&env, CONTAINER_SHARD_READINESS_PROBE_ENABLED_ENV);
    let container_scheduler_shard_readiness_wake_enabled =
        env_flag(&env, CONTAINER_SHARD_READINESS_WAKE_ENABLED_ENV);
    let container_scheduler_shard_readiness_staging_verified =
        env_flag(&env, CONTAINER_SHARD_READINESS_STAGING_VERIFIED_ENV);
    let container_scheduler_container_runtime_compiled = container_local_contracts.runtime_compiled;
    let container_scheduler_deny_by_default_egress_compiled =
        container_local_contracts.deny_by_default_egress_compiled;
    let container_scheduler_shared_storage_contract_compiled =
        container_local_contracts.shared_storage_compiled;
    let container_scheduler_n_minus_one_protocol_compiled = false;
    let container_scheduler_capacity_rejection_compiled =
        container_local_contracts.capacity_rejection_compiled;
    let container_scheduler_remote_fault_matrix_verified = false;
    let container_scheduler_staging_verified =
        env_flag(&env, CONTAINER_SCHEDULER_STAGING_VERIFIED_ENV);
    let container_scheduler_cutover_ready = container_scheduler_cutover_ready(
        container_scheduler_foundation_compiled,
        container_scheduler_status.valid,
        container_scheduler_enabled,
        container_scheduler_routing_secret_configured,
        container_scheduler_controller_service_binding_available,
        container_scheduler_controller_ready,
        container_scheduler_shard_readiness_staging_verified,
        container_scheduler_container_runtime_compiled,
        container_scheduler_deny_by_default_egress_compiled,
        container_scheduler_shared_storage_contract_compiled,
        container_operation_runtime_ready,
        container_scheduler_n_minus_one_protocol_compiled,
        container_scheduler_capacity_rejection_compiled,
        container_scheduler_remote_fault_matrix_verified,
        container_scheduler_staging_verified,
    );
    let quota_coordinator_contract_version = quota_coordinator_contract_version();
    let quota_coordinator_do_available = env.durable_object(QUOTA_COORD_BINDING).is_ok();
    let quota_coordinator_shadow_enabled = env_flag(&env, QUOTA_COORD_SHADOW_ENABLED_ENV);
    let quota_coordinator_foundation_compiled = quota_coordinator_foundation_compiled();
    let quota_coordinator_observer_contract_compiled =
        quota_coordinator_observer_contract_compiled();
    let quota_coordinator_reserve_observation_compiled =
        quota_coordinator_reserve_observation_compiled();
    let quota_coordinator_finalization_observation_compiled =
        quota_coordinator_finalization_observation_compiled();
    let quota_coordinator_recovery_observation_compiled =
        quota_coordinator_recovery_observation_compiled();
    let quota_coordinator_relay_observation_compiled =
        quota_coordinator_relay_observation_compiled();
    let quota_coordinator_retention_compaction_compiled =
        quota_coordinator_retention_compaction_compiled();
    let quota_coordinator_reconciliation_compiled = quota_coordinator_reconciliation_compiled();
    // This operator assertion remains false in every tracked environment until
    // long-lived hot-token retention has measured, reviewable evidence.
    let quota_coordinator_storage_retention_ready =
        env_flag(&env, QUOTA_COORD_RETENTION_VERIFIED_ENV);
    let quota_coordinator_shadow_scope = quota_coordinator_shadow_scope_status(&env);
    let quota_coordinator_reservation_ledger_only = true;
    let quota_coordinator_tiered_only = false;
    let quota_coordinator_write_authority_enabled = false;
    let quota_coordinator_staging_verified = env_flag(&env, QUOTA_COORD_STAGING_VERIFIED_ENV);
    let quota_coordinator_shadow_runtime_ready = quota_coordinator_shadow_runtime_ready(
        quota_coordinator_do_available,
        quota_coordinator_shadow_enabled,
        quota_coordinator_foundation_compiled,
        quota_coordinator_observer_contract_compiled,
        quota_coordinator_relay_observation_compiled,
        quota_coordinator_storage_retention_ready,
        quota_coordinator_shadow_scope.configured,
        quota_coordinator_shadow_scope.valid,
        quota_coordinator_reservation_ledger_only,
        quota_coordinator_write_authority_enabled,
    );
    let quota_coordinator_reconciliation_runtime_ready =
        quota_coordinator_shadow_runtime_ready && quota_coordinator_reconciliation_compiled;
    let quota_coordinator_cutover_ready = quota_coordinator_cutover_ready(
        quota_coordinator_do_available,
        quota_coordinator_foundation_compiled,
        quota_coordinator_observer_contract_compiled,
        quota_coordinator_relay_observation_compiled,
        quota_coordinator_storage_retention_ready,
        quota_coordinator_reservation_ledger_only,
        quota_coordinator_staging_verified,
        quota_coordinator_write_authority_enabled,
    );
    let relay_billing_reservation_ledger_compiled = relay_billing_reservation_ledger_compiled();
    let relay_billing_ledger_status_compiled = true;
    let relay_billing_owner_deadline_runtime = relay_billing_reservation_lease_runtime_status(&env);
    let relay_billing_reservation_lease_seconds = relay_billing_reservation_lease_seconds(&env);
    let relay_billing_prebind_owner_generation_contract_version =
        RELAY_BILLING_PREBIND_OWNER_GENERATION_CONTRACT_VERSION;
    let relay_billing_prebind_owner_generation_compiled =
        relay_billing_prebind_owner_generation_compiled();
    let relay_billing_prebind_owner_generation_schema_ready = d1_migration_ready;
    let relay_billing_prebind_owner_deadline_configured =
        relay_billing_owner_deadline_runtime.configured;
    let relay_billing_prebind_owner_deadline_valid = relay_billing_owner_deadline_runtime.valid;
    let relay_billing_prebind_owner_deadline_seconds =
        relay_billing_owner_deadline_runtime.effective_seconds;
    let relay_billing_prebind_owner_generation_staging_verified =
        relay_billing_prebind_owner_generation_staging_verified(&env);
    let relay_billing_stream_lease_renewal_compiled = relay_billing_stream_lease_renewal_compiled();
    let relay_billing_stream_lease_heartbeat_runtime =
        relay_billing_stream_lease_heartbeat_runtime_status(&env);
    let relay_billing_stream_lease_heartbeat_configured =
        relay_billing_stream_lease_heartbeat_runtime.configured;
    let relay_billing_stream_lease_heartbeat_valid =
        relay_billing_stream_lease_heartbeat_runtime.valid;
    let relay_billing_stream_lease_heartbeat_seconds =
        relay_billing_stream_lease_heartbeat_runtime.effective_seconds;
    let relay_billing_prebind_owner_generation_configured =
        relay_billing_prebind_owner_generation_compiled
            && relay_billing_prebind_owner_generation_schema_ready
            && relay_billing_prebind_owner_deadline_configured
            && relay_billing_prebind_owner_deadline_valid
            && relay_billing_stream_lease_heartbeat_configured
            && relay_billing_stream_lease_heartbeat_valid;
    let relay_billing_stream_lease_renewal_staging_verified = env_flag(
        &env,
        RELAY_BILLING_STREAM_LEASE_RENEWAL_STAGING_VERIFIED_ENV,
    );
    let relay_billing_stream_error_usage_recovery_compiled =
        relay_billing_stream_error_usage_recovery_compiled();
    let relay_billing_stream_error_usage_recovery_staging_verified = env_flag(
        &env,
        RELAY_BILLING_STREAM_ERROR_USAGE_RECOVERY_STAGING_VERIFIED_ENV,
    );
    let relay_billing_missing_usage_estimate_enabled =
        relay_billing_missing_usage_estimate_enabled(&env);
    let relay_billing_finalization_queue_enabled = relay_billing_finalization_queue_enabled(&env);
    let relay_billing_finalization_queue_available = env.queue(BILLING_QUEUE_BINDING).is_ok();
    let relay_billing_finalization_consumer_compiled =
        relay_billing_finalization_consumer_compiled();
    let relay_billing_finalization_dlq_contract_compiled =
        relay_billing_finalization_dlq_contract_compiled();
    let relay_billing_finalization_replay_compiled = relay_billing_finalization_replay_compiled();
    let relay_billing_finalization_dlq_consumer_compiled =
        relay_billing_finalization_dlq_consumer_compiled();
    let relay_billing_finalization_reconcile_compiled =
        relay_billing_finalization_reconcile_compiled();
    let relay_billing_finalization_reconcile_enabled =
        relay_billing_finalization_reconcile_enabled(&env);
    let relay_billing_finalization_reconcile_ready =
        relay_billing_finalization_reconcile_ready(&env, d1_migration_ready);
    let relay_billing_finalization_runtime_ready =
        relay_billing_finalization_runtime_contract_ready(
            relay_billing_finalization_queue_enabled,
            relay_billing_finalization_queue_available,
            relay_billing_finalization_consumer_compiled,
            relay_billing_finalization_dlq_contract_compiled,
            relay_billing_finalization_replay_compiled,
            relay_billing_finalization_dlq_consumer_compiled,
            relay_billing_finalization_reconcile_ready,
            d1_migration_ready,
        );
    let relay_billing_finalization_replay_staging_verified =
        env_flag(&env, RELAY_BILLING_FINALIZATION_REPLAY_STAGING_VERIFIED_ENV);
    let relay_flat_billing_intent_contract_version = 1;
    let relay_flat_billing_intent_compiled =
        relay_billing_reservation_ledger_compiled && relay_billing_finalization_consumer_compiled;
    let relay_flat_billing_intent_schema_ready = d1_migration_ready;
    let relay_flat_billing_intent_runtime_ready = relay_flat_billing_intent_compiled
        && relay_flat_billing_intent_schema_ready
        && relay_billing_finalization_runtime_ready;
    // Keep this fail-closed until every structured parity blocker is removed.
    // Staging and cutover evidence remain separate gates below.
    let relay_flat_billing_go_parity_ready = false;
    let relay_flat_billing_intent_staging_verified =
        env_flag(&env, RELAY_FLAT_BILLING_INTENT_STAGING_VERIFIED_ENV);
    let relay_flat_billing_intent_cutover_ready = relay_flat_billing_intent_runtime_ready
        && relay_flat_billing_go_parity_ready
        && relay_flat_billing_intent_staging_verified;
    let relay_billing_prebind_owner_generation_cutover_ready =
        relay_billing_prebind_owner_generation_configured
            && relay_billing_prebind_owner_generation_staging_verified
            && relay_billing_finalization_runtime_ready;
    let relay_billing_orphan_recovery_enabled = relay_billing_orphan_recovery_enabled(&env);
    let relay_billing_orphan_recovery_ready = relay_billing_reservation_ledger_compiled
        && relay_billing_stream_lease_renewal_compiled
        && relay_billing_prebind_owner_generation_configured
        && relay_billing_prebind_owner_generation_staging_verified
        && relay_billing_stream_error_usage_recovery_compiled
        && relay_billing_stream_lease_heartbeat_configured
        && relay_billing_stream_lease_heartbeat_valid
        && relay_billing_missing_usage_estimate_enabled
        && relay_billing_orphan_recovery_enabled
        && d1_migration_ready;
    let relay_billing_orphan_recovery_cutover_ready =
        is_relay_billing_orphan_recovery_cutover_ready(
            relay_billing_orphan_recovery_ready,
            relay_billing_stream_lease_renewal_staging_verified,
            relay_billing_stream_error_usage_recovery_staging_verified,
            relay_billing_finalization_runtime_ready,
            relay_billing_finalization_replay_staging_verified,
            relay_billing_prebind_owner_generation_cutover_ready,
        );
    let relay_billing_orphan_recovery_grace_seconds =
        crate::d1_repositories::RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS;
    let relay_billing_orphan_sweep_limit = relay_billing_orphan_sweep_limit(&env);
    let wfp_dispatch_binding_available = env.dynamic_dispatcher(WFP_DISPATCH_BINDING).is_ok();
    let wfp_dispatch_enabled = env_flag(&env, WFP_DISPATCH_ENABLED_ENV);
    let wfp_internal_dispatch_enabled = env_flag(&env, WFP_INTERNAL_DISPATCH_ENABLED_ENV);
    let wfp_dispatch_failure_contract_compiled = wfp_dispatch_failure_contract_compiled();
    let wfp_relay_transport_enabled = env_flag(&env, WFP_RELAY_TRANSPORT_ENABLED_ENV);
    let wfp_relay_authority_secret_configured =
        secret_or_var(&env, cinatoken_wfp_authority::AUTHORITY_SECRET_ENV)
            .is_some_and(|value| value.as_bytes().len() >= 32);
    let wfp_authority_replay_do_available = env
        .durable_object(cinatoken_wfp_authority::AUTHORITY_REPLAY_BINDING)
        .is_ok();
    let wfp_authority_replay_do_compiled = wfp_authority_replay_contract_compiled();
    let wfp_tenant_script_plan_compiled = wfp_tenant_script_plan_compiled();
    let wfp_tenant_rust_wasm_runtime_compiled = wfp_tenant_rust_wasm_runtime_compiled();
    let wfp_tenant_route_manifest_compiled = wfp_tenant_route_manifest_compiled();
    let wfp_tenant_internal_dispatch_required_compiled =
        wfp_tenant_internal_dispatch_required_compiled();
    let wfp_outbound_invocation_context_compiled =
        wfp_outbound_invocation_context_contract_compiled();
    let wfp_outbound_authority_verifier_compiled = wfp_outbound_authority_verifier_compiled();
    let wfp_outbound_replay_guard_compiled = wfp_outbound_replay_guard_compiled();
    let wfp_tenant_response_header_guard_compiled = wfp_tenant_response_header_guard_compiled();
    let wfp_preview_response_security_headers_compiled =
        wfp_preview_response_security_headers_compiled();
    let wfp_tenant_ai_gateway_policy_compiled = wfp_tenant_ai_gateway_policy_compiled();
    let wfp_outbound_egress_policy_compiled = wfp_outbound_egress_policy_compiled();
    let wfp_outbound_private_ingress_config_compiled =
        wfp_outbound_private_ingress_config_compiled();
    let wfp_relay_authority_transport_compiled = relay_wfp_authority_transport_contract_compiled();
    let wfp_relay_authority_transport_ready = is_wfp_relay_authority_transport_ready(
        wfp_dispatch_binding_available,
        wfp_dispatch_enabled,
        wfp_relay_transport_enabled,
        wfp_relay_authority_secret_configured,
        wfp_authority_replay_do_available,
        wfp_authority_replay_do_compiled,
        wfp_relay_authority_transport_compiled,
        wfp_tenant_rust_wasm_runtime_compiled,
        wfp_tenant_route_manifest_compiled,
        wfp_outbound_invocation_context_compiled,
        wfp_outbound_authority_verifier_compiled,
        wfp_outbound_replay_guard_compiled,
        wfp_tenant_response_header_guard_compiled,
        wfp_outbound_egress_policy_compiled,
        wfp_outbound_private_ingress_config_compiled,
    );
    let wfp_tenant_smoke_ready = is_wfp_tenant_smoke_ready(
        wfp_dispatch_binding_available,
        wfp_dispatch_enabled,
        wfp_internal_dispatch_enabled,
        wfp_dispatch_failure_contract_compiled,
        wfp_tenant_script_plan_compiled,
        wfp_tenant_rust_wasm_runtime_compiled,
        wfp_tenant_route_manifest_compiled,
        wfp_tenant_internal_dispatch_required_compiled,
        wfp_tenant_response_header_guard_compiled,
        wfp_preview_response_security_headers_compiled,
        wfp_tenant_ai_gateway_policy_compiled,
        wfp_outbound_egress_policy_compiled,
        wfp_outbound_private_ingress_config_compiled,
    );
    let realtime_session_gateway_enabled = env_flag(&env, REALTIME_SESSION_GATEWAY_ENABLED_ENV);
    let realtime_session_v1_enabled = env_flag(&env, REALTIME_SESSION_V1_ENABLED_ENV);
    let realtime_session_billing_settlement_write_enabled =
        env_flag(&env, REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED_ENV);
    let do_websocket_hibernation_compiled = true;
    let realtime_session_auth_boundary_compiled = true;
    let realtime_session_metrics_persisted_compiled = true;
    let realtime_session_control_no_echo_compiled = true;
    let realtime_session_upstream_bridge_planner_compiled =
        realtime_upstream_bridge_planner_compiled();
    let realtime_session_upstream_channel_planner_compiled =
        realtime_upstream_channel_planner_compiled();
    let realtime_session_upstream_bridge_connect_contract_compiled =
        realtime_upstream_bridge_connect_contract_compiled();
    let realtime_session_upstream_connect_handoff_compiled =
        realtime_upstream_connect_handoff_compiled();
    let realtime_session_upstream_fetch_upgrade_adapter_compiled =
        realtime_upstream_fetch_upgrade_adapter_compiled();
    let realtime_session_upstream_bridge_lifecycle_compiled =
        realtime_upstream_bridge_lifecycle_compiled();
    let realtime_session_upstream_bridge_hibernation_fail_closed_compiled =
        realtime_upstream_bridge_hibernation_fail_closed_compiled();
    let realtime_session_upstream_bridge_frame_guard_compiled =
        realtime_upstream_bridge_frame_guard_compiled();
    let realtime_session_upstream_bridge_close_mapping_compiled =
        realtime_upstream_bridge_close_mapping_compiled();
    let realtime_session_upstream_bridge_send_failure_guard_compiled =
        realtime_upstream_bridge_send_failure_guard_compiled();
    let realtime_session_upstream_bridge_event_trace_compiled =
        realtime_upstream_bridge_event_trace_compiled();
    let realtime_session_upstream_bridge_replay_contract_compiled =
        realtime_upstream_bridge_replay_contract_compiled();
    let realtime_session_upstream_bridge_backpressure_policy_compiled =
        realtime_upstream_bridge_backpressure_policy_compiled();
    let realtime_session_upstream_bridge_backpressure_runtime_compiled =
        realtime_upstream_bridge_backpressure_runtime_compiled();
    let realtime_session_upstream_usage_capture_compiled =
        realtime_upstream_usage_capture_compiled();
    let realtime_session_billing_presettlement_snapshot_compiled =
        realtime_billing_presettlement_snapshot_compiled();
    let realtime_session_billing_settlement_preview_compiled =
        realtime_billing_settlement_preview_compiled();
    let realtime_session_billing_settlement_handoff_compiled =
        realtime_billing_settlement_handoff_compiled();
    let realtime_session_billing_settlement_mutation_plan_compiled =
        realtime_billing_settlement_mutation_plan_compiled();
    let realtime_session_billing_settlement_writer_compiled =
        realtime_billing_settlement_writer_compiled();
    let realtime_session_billing_settlement_replay_marker_compiled =
        realtime_billing_settlement_replay_marker_compiled();
    let realtime_session_billing_settlement_audit_log_compiled =
        realtime_billing_settlement_audit_log_compiled();
    let realtime_session_billing_settlement_batch_compiled =
        realtime_billing_settlement_batch_compiled();
    let realtime_session_billing_settlement_retry_compiled =
        realtime_billing_settlement_retry_compiled();
    let realtime_session_billing_reservation_lease_compiled =
        realtime_billing_reservation_lease_compiled();
    let realtime_session_billing_reservation_lease_seconds =
        realtime_billing_reservation_lease_seconds(&env);
    let realtime_session_billing_global_orphan_recovery_compiled =
        realtime_billing_global_orphan_recovery_compiled();
    let realtime_session_billing_global_orphan_recovery_enabled =
        realtime_billing_orphan_recovery_enabled(&env);
    let realtime_session_billing_global_orphan_recovery_ready =
        realtime_session_billing_global_orphan_recovery_compiled
            && realtime_session_billing_global_orphan_recovery_enabled
            && d1_migration_ready;
    let realtime_session_billing_orphan_recovery_grace_seconds =
        realtime_billing_orphan_recovery_grace_seconds();
    let realtime_session_billing_orphan_sweep_limit = realtime_billing_orphan_sweep_limit(&env);
    let realtime_session_billing_ledger_status_compiled = true;
    let realtime_session_usage_reconciliation_compiled = realtime_usage_reconciliation_compiled();
    let realtime_session_billing_reconciliation_compiled =
        realtime_billing_reconciliation_compiled();
    let realtime_session_billing_reconciliation_enabled =
        realtime_billing_reconciliation_enabled(&env);
    let realtime_session_billing_reconciliation_ready =
        realtime_session_billing_reconciliation_compiled
            && realtime_session_billing_reconciliation_enabled
            && d1_migration_ready;
    let realtime_session_billing_reconciliation_staging_verified =
        env_flag(&env, REALTIME_BILLING_RECONCILIATION_STAGING_VERIFIED_ENV);
    let realtime_session_billing_reconciliation_cutover_ready =
        realtime_session_billing_reconciliation_ready
            && realtime_session_billing_reconciliation_staging_verified;
    let realtime_session_billing_settlement_staging_smoke_compiled =
        realtime_settlement_staging_smoke_compiled();
    let realtime_session_billing_settlement_staging_smoke_enabled =
        env_flag(&env, REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED_ENV);
    let realtime_session_billing_settlement_staging_smoke_ready =
        realtime_session_billing_settlement_batch_compiled
            && realtime_session_billing_settlement_staging_smoke_compiled
            && realtime_session_billing_settlement_staging_smoke_enabled;
    let realtime_session_platform_header_boundary_compiled =
        realtime_session_platform_header_boundary_compiled();
    let realtime_session_platform_admin_auth_compiled =
        realtime_session_platform_admin_auth_compiled();
    // The managed local workerd suite now exercises the complete upstream
    // WebSocket bridge and D1 settlement/replay path. These fields describe
    // compiled implementation, while the environment gates and remote D1/DO
    // evidence below continue to control cutover readiness.
    let realtime_session_upstream_bridge_compiled = true;
    let realtime_session_billing_settlement_compiled = true;
    let realtime_session_platform_smoke_ready = is_realtime_session_platform_smoke_ready(
        realtime_sessions_do_available,
        realtime_session_gateway_enabled,
        do_websocket_hibernation_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_platform_header_boundary_compiled,
        realtime_session_platform_admin_auth_compiled,
    );
    let realtime_session_v1_cutover_ready = is_realtime_session_v1_cutover_ready(
        realtime_sessions_do_available,
        realtime_session_v1_enabled,
        realtime_session_billing_settlement_write_enabled,
        realtime_session_auth_boundary_compiled,
        do_websocket_hibernation_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_upstream_channel_planner_compiled,
        realtime_session_upstream_bridge_connect_contract_compiled,
        realtime_session_upstream_connect_handoff_compiled,
        realtime_session_upstream_fetch_upgrade_adapter_compiled,
        realtime_session_upstream_bridge_lifecycle_compiled,
        realtime_session_upstream_bridge_hibernation_fail_closed_compiled,
        realtime_session_upstream_bridge_frame_guard_compiled,
        realtime_session_upstream_bridge_close_mapping_compiled,
        realtime_session_upstream_bridge_send_failure_guard_compiled,
        realtime_session_upstream_bridge_event_trace_compiled,
        realtime_session_upstream_bridge_replay_contract_compiled,
        realtime_session_upstream_bridge_backpressure_policy_compiled,
        realtime_session_upstream_bridge_backpressure_runtime_compiled,
        realtime_session_upstream_usage_capture_compiled,
        realtime_session_billing_presettlement_snapshot_compiled,
        realtime_session_billing_settlement_preview_compiled,
        realtime_session_billing_settlement_handoff_compiled,
        realtime_session_billing_settlement_mutation_plan_compiled,
        realtime_session_billing_settlement_writer_compiled,
        realtime_session_billing_settlement_replay_marker_compiled,
        realtime_session_billing_settlement_audit_log_compiled,
        realtime_session_billing_settlement_batch_compiled,
        realtime_session_billing_settlement_retry_compiled,
        realtime_session_billing_reservation_lease_compiled,
        realtime_session_billing_global_orphan_recovery_ready,
        d1_migration_ready,
        realtime_session_platform_header_boundary_compiled,
        realtime_session_upstream_bridge_compiled,
        realtime_session_billing_settlement_compiled,
        realtime_session_billing_reconciliation_cutover_ready,
    );
    let task_poller_config = task_poller_config_from_env(&env);
    let task_poller_timeout_sweep_compiled = task_timeout_sweep_compiled();
    let task_poller_refund_batch_compiled = task_refund_cas_batch_compiled();
    let task_poller_refund_replay_contract_compiled = task_refund_replay_contract_compiled();
    let task_poll_lease_contract_version = TASK_POLL_LEASE_CONTRACT_VERSION;
    let task_poll_lease_compiled = task_poll_lease_contract_compiled();
    let task_poll_lease_schema_ready = task_poll_lease_status.schema_ready;
    let task_poll_lease_enabled = env_flag(&env, TASK_POLL_LEASE_ENABLED_ENV);
    let task_poll_lease_authority_enabled =
        task_poll_lease_schema_ready && task_poll_lease_status.authority_enabled;
    let task_poll_lease_enforcement_enabled =
        task_poll_lease_schema_ready && task_poll_lease_status.enforcement_enabled;
    let task_poll_lease_runtime_ready = task_poll_lease_compiled
        && task_poll_lease_schema_ready
        && task_poll_lease_enabled
        && task_poll_lease_authority_enabled;
    let task_poll_lease_staging_verified = env_flag(&env, TASK_POLL_LEASE_STAGING_VERIFIED_ENV);
    let task_poll_lease_cutover_ready = task_poll_lease_runtime_ready
        && task_poll_lease_enforcement_enabled
        && task_poll_lease_staging_verified;
    let task_poll_scheduler_contract_version = TASK_POLL_SCHEDULER_CONTRACT_VERSION;
    let task_poll_scheduler_compiled = task_poll_scheduler_contract_compiled();
    let task_poll_scheduler_schema_ready = task_poll_scheduler_status.schema_ready;
    let task_poll_scheduler_enabled = env_flag(&env, TASK_POLL_SCHEDULER_ENABLED_ENV);
    let task_poll_scheduler_runtime_ready = task_poll_scheduler_compiled
        && task_poll_scheduler_schema_ready
        && task_poll_scheduler_enabled
        && task_poll_lease_runtime_ready
        && task_poll_lease_enforcement_enabled;
    let task_poll_scheduler_staging_verified =
        env_flag(&env, TASK_POLL_SCHEDULER_STAGING_VERIFIED_ENV);
    let task_poll_recovery_contract_version = TASK_POLL_RECOVERY_CONTRACT_VERSION;
    let task_poll_recovery_compiled = task_poll_recovery_compiled();
    let task_poll_recovery_schema_ready = task_poll_recovery_status.schema_ready;
    let task_poll_recovery_enabled = task_poll_recovery_enabled(&env);
    let task_poll_recovery_runtime_ready = task_poll_recovery_compiled
        && task_poll_recovery_schema_ready
        && task_poll_recovery_enabled
        && task_poll_scheduler_runtime_ready;
    let task_poll_recovery_staging_verified =
        env_flag(&env, TASK_POLL_RECOVERY_STAGING_VERIFIED_ENV);
    let task_poll_recovery_cutover_ready =
        task_poll_recovery_runtime_ready && task_poll_recovery_staging_verified;
    let task_poll_scheduler_cutover_ready = task_poll_scheduler_runtime_ready
        && task_poll_lease_cutover_ready
        && task_poll_scheduler_staging_verified
        && task_poll_recovery_cutover_ready;
    let task_runner_do_available = env.durable_object(TASK_RUNNER_BINDING).is_ok();
    let task_runner_do_enabled = env_flag(&env, TASK_RUNNER_DO_ENABLED_ENV);
    let task_runner_do_foundation_compiled = task_runner_do_foundation_compiled();
    let task_runner_alarm_contract_compiled = task_runner_alarm_contract_compiled();
    let task_runner_storage_error_retry_contract_compiled =
        task_runner_storage_error_retry_contract_compiled();
    let task_runner_rearm_contract_compiled = task_runner_rearm_contract_compiled();
    let task_runner_max_alarm_fires = task_runner_max_alarm_fires(&env);
    let task_runner_submit_path_compiled = task_runner_submit_path_compiled();
    let task_runner_poll_path_compiled = task_runner_poll_path_compiled();
    let task_runner_status_probe_compiled = task_runner_status_probe_compiled();
    let task_runner_staging_replay_verified = task_runner_staging_replay_verified(&env);
    let task_runner_cutover_ready = is_task_runner_cutover_ready(
        task_runner_do_available,
        task_runner_do_enabled,
        task_runner_do_foundation_compiled,
        task_runner_alarm_contract_compiled,
        task_runner_storage_error_retry_contract_compiled,
        task_runner_rearm_contract_compiled,
        task_runner_submit_path_compiled,
        task_runner_poll_path_compiled,
        task_runner_status_probe_compiled,
        task_poll_lease_cutover_ready,
        task_poll_scheduler_cutover_ready,
        task_runner_staging_replay_verified,
    );
    let task_submit_timeout = task_submit_timeout_runtime_status(&env);
    let task_submit_operation_contract_version = TASK_SUBMIT_OPERATION_CONTRACT_VERSION;
    let task_submit_operation_compiled = task_billing_intent_contract_compiled();
    let task_submit_operation_schema_ready = task_v2_object_schema_ready;
    let task_submit_timeout_configured = task_submit_timeout.configured;
    let task_submit_timeout_valid = task_submit_timeout.valid;
    let task_submit_timeout_seconds = task_submit_timeout.effective_seconds;
    let task_submit_client_idempotency_compiled = true;
    let task_submit_client_idempotency_required = task_client_idempotency_required(&env);
    let task_submit_status_query_compiled = true;
    let task_submit_local_operation_unique =
        task_submit_operation_compiled && task_submit_operation_schema_ready;
    // Provider documentation and local code do not prove that every task
    // provider accepts the frozen key or can look an ambiguous operation up by
    // that key. These remain explicit remote-evidence gates.
    let task_submit_provider_native_idempotency_verified = false;
    let task_submit_provider_lookup_verified = false;
    let task_submit_operation_cutover_ready = task_submit_local_operation_unique
        && task_submit_client_idempotency_compiled
        && task_submit_timeout_configured
        && task_submit_timeout_valid
        && task_submit_client_idempotency_required
        && task_submit_status_query_compiled
        && task_submit_provider_native_idempotency_verified
        && task_submit_provider_lookup_verified;
    let task_v2_contract_version = 5;
    let task_v2_ownership_compiled = task_billing_intent_contract_compiled()
        && task_poll_lease_compiled
        && task_poll_scheduler_compiled
        && task_poll_recovery_compiled
        && task_submit_operation_compiled;
    let task_v2_schema_ready = task_v2_object_schema_ready
        && task_poll_lease_schema_ready
        && task_poll_scheduler_schema_ready
        && task_poll_recovery_schema_ready;
    let task_v2_runtime_ready = task_v2_ownership_compiled
        && task_v2_schema_ready
        && task_poll_lease_runtime_ready
        && task_poll_scheduler_runtime_ready
        && task_poll_recovery_runtime_ready
        && task_submit_timeout_configured
        && task_submit_timeout_valid
        && task_submit_client_idempotency_required;
    let task_submit_reconciliation_compiled = task_submit_reconciliation_compiled();
    let task_submit_reconciliation_enabled = task_submit_reconciliation_enabled(&env);
    let task_submit_reconciliation_read_ready =
        task_submit_reconciliation_compiled && task_v2_object_schema_ready;
    let task_submit_reconciliation_ready = task_submit_reconciliation_compiled
        && task_submit_reconciliation_enabled
        && task_v2_object_schema_ready;
    let task_submit_reconciliation_staging_verified =
        env_flag(&env, TASK_SUBMIT_RECONCILIATION_STAGING_VERIFIED_ENV);
    let task_submit_reconciliation_cutover_ready =
        task_submit_reconciliation_ready && task_submit_reconciliation_staging_verified;
    // Task-v2 still needs end-to-end submit/poll fault injection even after the
    // shared poll lease itself becomes cutover-ready.
    let task_v2_staging_verified = false;
    let task_v2_cutover_ready = false;
    let subscription_funding_source_compiled = false;
    let subscription_funding_source_runtime_ready = false;
    let subscription_funding_source_staging_verified = false;
    let subscription_funding_source_cutover_ready = false;
    let realtime_flat_billing_compiled = false;
    let realtime_flat_billing_runtime_ready = false;
    let realtime_flat_billing_staging_verified = false;
    let realtime_flat_billing_cutover_ready = false;
    let capabilities = PlatformCapabilities {
        scheduling_gateway_compiled: true,
        scheduling_gateway_active: true,
        scheduling_gateway_owner_contract_version: SCHEDULING_GATEWAY_OWNER_CONTRACT_VERSION,
        scheduling_gateway_route_precedence: SCHEDULING_GATEWAY_ROUTE_PRECEDENCE.to_vec(),
        scheduling_gateway_preview_fail_closed_compiled: true,
        d1_migration_status_available: d1_migration_status.available,
        d1_migration_applied_count: d1_migration_status.applied_count,
        d1_migration_latest: d1_migration_status.latest,
        d1_expected_migration: EXPECTED_D1_MIGRATION,
        d1_expected_migration_applied: d1_migration_status.expected_applied,
        d1_migration_set_matches: d1_migration_status.set_matches,
        d1_migration_ready,
        ai_binding_available: env.ai("AI").is_ok(),
        ai_gateway_id_configured,
        cloudflare_account_id_configured,
        cloudflare_ai_gateway_token_configured,
        relay_ai_gateway_router_enabled,
        relay_ai_gateway_router_ready,
        relay_ai_gateway_rest_routes: relay_ai_gateway_rest_routes(),
        relay_ai_gateway_model_prefixes: relay_ai_gateway_model_prefixes(),
        relay_ai_gateway_direct_fallback_prefixes: relay_ai_gateway_direct_fallback_prefixes(),
        relay_ai_gateway_cutover_guards: relay_ai_gateway_cutover_guards(),
        relay_ai_gateway_channel_opt_in_supported: true,
        relay_ai_gateway_rest_forwarder_compiled: true,
        relay_ai_gateway_same_channel_fallback_compiled:
            relay_ai_gateway_direct_fallback_contract_compiled(),
        relay_ai_gateway_cross_model_fallback_compiled,
        relay_ai_gateway_messages_cross_model_fallback_compiled,
        relay_ai_gateway_messages_cross_model_fallback_staging_verified,
        relay_ai_gateway_messages_cross_model_fallback_cutover_ready,
        relay_ai_gateway_cross_model_fallback_enabled: relay_model_fallback_runtime.enabled,
        relay_ai_gateway_cross_model_fallback_configured: relay_model_fallback_runtime.configured,
        relay_ai_gateway_cross_model_fallback_config_valid: relay_model_fallback_runtime.valid,
        relay_ai_gateway_cross_model_fallback_mapping_count: relay_model_fallback_runtime
            .mapping_count,
        relay_ai_gateway_cross_model_actual_group_billing_compiled,
        relay_ai_gateway_actual_group_billing_staging_smoke_compiled,
        relay_ai_gateway_actual_group_billing_staging_smoke_enabled,
        relay_ai_gateway_actual_group_billing_staging_smoke_ready,
        relay_ai_gateway_cross_model_terminal_audit_compiled,
        relay_ai_gateway_cross_model_fallback_ready,
        relay_ai_gateway_cross_model_fallback_staging_verified,
        relay_ai_gateway_cross_model_fallback_cutover_ready,
        relay_ai_gateway_cross_model_fallback_cutover_guards: RELAY_MODEL_FALLBACK_CUTOVER_GUARDS
            .to_vec(),
        relay_retry_times: relay_retry_times_from_env(&env),
        channel_affinity_do_available: env.durable_object("CHANNEL_AFFINITY").is_ok(),
        realtime_sessions_do_available,
        container_scheduler_contract_version,
        container_scheduler_foundation_compiled,
        container_scheduler_configured: container_scheduler_status.configured,
        container_scheduler_config_valid: container_scheduler_status.valid,
        container_scheduler_ring_generation: container_scheduler_status.ring_generation,
        container_scheduler_shard_count: container_scheduler_status.shard_count,
        container_scheduler_enabled,
        container_scheduler_routing_secret_configured,
        container_scheduler_controller_service_binding_available,
        container_scheduler_controller_probe_enabled,
        container_scheduler_controller_authority_configured,
        container_scheduler_controller_status_verified,
        container_scheduler_controller_ready,
        container_scheduler_controller_status_state,
        container_scheduler_controller_enabled,
        container_scheduler_controller_execution_enabled,
        container_scheduler_controller_previous_secret_configured,
        container_scheduler_shard_readiness_probe_compiled,
        container_scheduler_shard_readiness_probe_enabled,
        container_scheduler_shard_readiness_wake_enabled,
        container_scheduler_shard_readiness_staging_verified,
        container_scheduler_container_runtime_compiled,
        container_scheduler_deny_by_default_egress_compiled,
        container_scheduler_shared_storage_contract_compiled,
        container_financial_terminal_compiled,
        container_exact_response_replay_compiled,
        container_divergence_reconciliation_compiled,
        container_operation_write_enabled: container_operation_runtime.operation_write_enabled,
        container_terminal_cas_enabled: container_operation_runtime.terminal_cas_enabled,
        container_financial_terminal_enabled: container_operation_runtime
            .financial_terminal_enabled,
        container_exact_response_replay_enabled: container_operation_runtime
            .exact_response_replay_enabled,
        container_operation_reconciliation_enabled: container_operation_runtime
            .operation_reconciliation_enabled,
        container_divergence_reconciliation_verified: container_operation_runtime
            .divergence_reconciliation_verified,
        container_chat_canary_enabled: container_operation_runtime.chat_canary_enabled,
        container_operation_staging_verified: container_operation_runtime
            .operation_staging_verified,
        container_operation_runtime_ready,
        container_scheduler_n_minus_one_protocol_compiled,
        container_scheduler_capacity_rejection_compiled,
        container_scheduler_remote_fault_matrix_verified,
        container_scheduler_staging_verified,
        container_scheduler_cutover_ready,
        container_scheduler_cutover_guards: container_scheduler_cutover_guards(),
        quota_coordinator_contract_version,
        quota_coordinator_do_available,
        quota_coordinator_shadow_enabled,
        quota_coordinator_foundation_compiled,
        quota_coordinator_observer_contract_compiled,
        quota_coordinator_reserve_observation_compiled,
        quota_coordinator_finalization_observation_compiled,
        quota_coordinator_recovery_observation_compiled,
        quota_coordinator_relay_observation_compiled,
        quota_coordinator_retention_compaction_compiled,
        quota_coordinator_reconciliation_compiled,
        quota_coordinator_reconciliation_runtime_ready,
        quota_coordinator_storage_retention_ready,
        quota_coordinator_shadow_token_allowlist_configured: quota_coordinator_shadow_scope
            .configured,
        quota_coordinator_shadow_token_allowlist_valid: quota_coordinator_shadow_scope.valid,
        quota_coordinator_shadow_token_count: quota_coordinator_shadow_scope.token_count,
        quota_coordinator_reservation_ledger_only,
        quota_coordinator_tiered_only,
        quota_coordinator_write_authority_enabled,
        quota_coordinator_staging_verified,
        quota_coordinator_shadow_runtime_ready,
        quota_coordinator_cutover_ready,
        quota_coordinator_cutover_guards: quota_coordinator_cutover_guards(),
        wfp_dispatch_binding_available,
        wfp_dispatch_enabled,
        wfp_internal_dispatch_enabled,
        wfp_dispatch_failure_contract_version: WFP_DISPATCH_FAILURE_CONTRACT_VERSION,
        wfp_dispatch_failure_classes: WFP_DISPATCH_FAILURE_CLASSES.to_vec(),
        wfp_dispatch_failure_contract_compiled,
        wfp_relay_transport_enabled,
        wfp_relay_authority_secret_configured,
        wfp_authority_replay_do_available,
        wfp_authority_replay_do_compiled,
        wfp_preview_host_suffix_configured: runtime_value(&env, WFP_PREVIEW_HOST_SUFFIX_ENV)
            .is_some(),
        wfp_worker_prefix_configured: runtime_value(&env, WFP_DISPATCH_WORKER_PREFIX_ENV).is_some(),
        wfp_tenant_supported_routes: wfp_tenant_supported_routes(),
        wfp_tenant_cutover_guards: wfp_tenant_cutover_guards(),
        wfp_tenant_script_plan_compiled,
        wfp_tenant_rust_wasm_runtime_compiled,
        wfp_tenant_route_manifest_compiled,
        wfp_tenant_internal_dispatch_required_compiled,
        wfp_outbound_invocation_context_compiled,
        wfp_outbound_authority_verifier_compiled,
        wfp_outbound_replay_guard_compiled,
        wfp_tenant_response_header_guard_compiled,
        wfp_preview_response_security_headers_compiled,
        wfp_tenant_ai_gateway_policy_compiled,
        wfp_outbound_egress_policy_compiled,
        wfp_outbound_private_ingress_config_compiled,
        wfp_relay_authority_transport_compiled,
        wfp_relay_authority_transport_ready,
        wfp_tenant_smoke_ready,
        relay_billing_reservation_ledger_compiled,
        relay_billing_ledger_status_compiled,
        relay_flat_billing_intent_contract_version,
        relay_flat_billing_intent_compiled,
        relay_flat_billing_intent_schema_ready,
        relay_flat_billing_intent_runtime_ready,
        relay_flat_billing_go_parity_ready,
        relay_flat_billing_go_parity_blockers: RELAY_FLAT_BILLING_GO_PARITY_BLOCKERS.to_vec(),
        relay_flat_billing_intent_staging_verified,
        relay_flat_billing_intent_cutover_ready,
        subscription_funding_source_compiled,
        subscription_funding_source_runtime_ready,
        subscription_funding_source_staging_verified,
        subscription_funding_source_cutover_ready,
        subscription_funding_supported_surfaces: Vec::new(),
        relay_billing_reservation_lease_seconds,
        relay_billing_prebind_owner_generation_contract_version,
        relay_billing_prebind_owner_generation_compiled,
        relay_billing_prebind_owner_generation_schema_ready,
        relay_billing_prebind_owner_deadline_configured,
        relay_billing_prebind_owner_deadline_valid,
        relay_billing_prebind_owner_deadline_seconds,
        relay_billing_prebind_owner_generation_configured,
        relay_billing_prebind_owner_generation_staging_verified,
        relay_billing_prebind_owner_generation_cutover_ready,
        relay_billing_prebind_owner_generation_cutover_guards:
            RELAY_BILLING_PREBIND_OWNER_GENERATION_CUTOVER_GUARDS.to_vec(),
        relay_billing_stream_lease_renewal_compiled,
        relay_billing_stream_lease_heartbeat_configured,
        relay_billing_stream_lease_heartbeat_valid,
        relay_billing_stream_lease_heartbeat_seconds,
        relay_billing_stream_lease_renewal_staging_verified,
        relay_billing_stream_error_usage_recovery_compiled,
        relay_billing_stream_error_usage_recovery_staging_verified,
        relay_billing_missing_usage_estimate_enabled,
        relay_billing_finalization_queue_enabled,
        relay_billing_finalization_queue_available,
        relay_billing_finalization_consumer_compiled,
        relay_billing_finalization_dlq_contract_compiled,
        relay_billing_finalization_replay_compiled,
        relay_billing_finalization_dlq_consumer_compiled,
        relay_billing_finalization_reconcile_compiled,
        relay_billing_finalization_reconcile_enabled,
        relay_billing_finalization_reconcile_ready,
        relay_billing_finalization_runtime_ready,
        relay_billing_finalization_replay_staging_verified,
        relay_billing_orphan_recovery_enabled,
        relay_billing_orphan_recovery_ready,
        relay_billing_orphan_recovery_cutover_ready,
        relay_billing_orphan_recovery_grace_seconds,
        relay_billing_orphan_sweep_limit,
        realtime_session_gateway_enabled,
        realtime_session_v1_enabled,
        realtime_session_billing_settlement_write_enabled,
        do_websocket_hibernation_compiled,
        realtime_session_cutover_guards: realtime_session_cutover_guards(),
        realtime_session_auth_boundary_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_upstream_bridge_planner_compiled,
        realtime_session_upstream_channel_planner_compiled,
        realtime_session_upstream_bridge_connect_contract_compiled,
        realtime_session_upstream_connect_handoff_compiled,
        realtime_session_upstream_fetch_upgrade_adapter_compiled,
        realtime_session_upstream_bridge_lifecycle_compiled,
        realtime_session_upstream_bridge_hibernation_fail_closed_compiled,
        realtime_session_upstream_bridge_frame_guard_compiled,
        realtime_session_upstream_bridge_close_mapping_compiled,
        realtime_session_upstream_bridge_send_failure_guard_compiled,
        realtime_session_upstream_bridge_event_trace_compiled,
        realtime_session_upstream_bridge_replay_contract_compiled,
        realtime_session_upstream_bridge_backpressure_policy_compiled,
        realtime_session_upstream_bridge_backpressure_runtime_compiled,
        realtime_session_upstream_usage_capture_compiled,
        realtime_session_billing_presettlement_snapshot_compiled,
        realtime_session_billing_settlement_preview_compiled,
        realtime_session_billing_settlement_handoff_compiled,
        realtime_session_billing_settlement_mutation_plan_compiled,
        realtime_session_billing_settlement_writer_compiled,
        realtime_session_billing_settlement_replay_marker_compiled,
        realtime_session_billing_settlement_audit_log_compiled,
        realtime_session_billing_settlement_batch_compiled,
        realtime_session_billing_settlement_retry_compiled,
        realtime_session_billing_reservation_lease_compiled,
        realtime_session_billing_reservation_lease_seconds,
        realtime_session_billing_global_orphan_recovery_compiled,
        realtime_session_billing_global_orphan_recovery_enabled,
        realtime_session_billing_global_orphan_recovery_ready,
        realtime_session_billing_orphan_recovery_grace_seconds,
        realtime_session_billing_orphan_sweep_limit,
        realtime_session_billing_ledger_status_compiled,
        realtime_session_usage_reconciliation_compiled,
        realtime_session_billing_reconciliation_compiled,
        realtime_session_billing_reconciliation_enabled,
        realtime_session_billing_reconciliation_ready,
        realtime_session_billing_reconciliation_staging_verified,
        realtime_session_billing_reconciliation_cutover_ready,
        realtime_session_billing_settlement_staging_smoke_compiled,
        realtime_session_billing_settlement_staging_smoke_enabled,
        realtime_session_billing_settlement_staging_smoke_ready,
        realtime_session_platform_header_boundary_compiled,
        realtime_session_platform_admin_auth_compiled,
        realtime_session_upstream_bridge_compiled,
        realtime_session_billing_settlement_compiled,
        realtime_session_platform_smoke_ready,
        realtime_session_v1_cutover_ready,
        realtime_flat_billing_compiled,
        realtime_flat_billing_runtime_ready,
        realtime_flat_billing_staging_verified,
        realtime_flat_billing_cutover_ready,
        task_v2_contract_version,
        task_v2_ownership_compiled,
        task_v2_schema_ready,
        task_v2_runtime_ready,
        task_v2_staging_verified,
        task_v2_cutover_ready,
        task_v2_cutover_guards: TASK_V2_CUTOVER_GUARDS.to_vec(),
        task_submit_operation_contract_version,
        task_submit_operation_compiled,
        task_submit_operation_schema_ready,
        task_submit_timeout_configured,
        task_submit_timeout_valid,
        task_submit_timeout_seconds,
        task_submit_client_idempotency_compiled,
        task_submit_client_idempotency_required,
        task_submit_status_query_compiled,
        task_submit_local_operation_unique,
        task_submit_provider_native_idempotency_verified,
        task_submit_provider_lookup_verified,
        task_submit_operation_cutover_ready,
        task_poll_lease_contract_version,
        task_poll_lease_compiled,
        task_poll_lease_schema_ready,
        task_poll_lease_enabled,
        task_poll_lease_authority_enabled,
        task_poll_lease_enforcement_enabled,
        task_poll_lease_runtime_ready,
        task_poll_lease_staging_verified,
        task_poll_lease_cutover_ready,
        task_poll_scheduler_contract_version,
        task_poll_scheduler_compiled,
        task_poll_scheduler_schema_ready,
        task_poll_scheduler_enabled,
        task_poll_scheduler_runtime_ready,
        task_poll_scheduler_staging_verified,
        task_poll_scheduler_cutover_ready,
        task_poll_recovery_contract_version,
        task_poll_recovery_compiled,
        task_poll_recovery_schema_ready,
        task_poll_recovery_enabled,
        task_poll_recovery_runtime_ready,
        task_poll_recovery_staging_verified,
        task_poll_recovery_cutover_ready,
        task_submit_reconciliation_compiled,
        task_submit_reconciliation_enabled,
        task_submit_reconciliation_read_ready,
        task_submit_reconciliation_ready,
        task_submit_reconciliation_staging_verified,
        task_submit_reconciliation_cutover_ready,
        task_poller_scheduled_handler_compiled: true,
        task_poller_timeout_sweep_compiled,
        task_poller_refund_batch_compiled,
        task_poller_refund_replay_contract_compiled,
        task_runner_do_available,
        task_runner_do_enabled,
        task_runner_do_foundation_compiled,
        task_runner_alarm_contract_compiled,
        task_runner_storage_error_retry_contract_compiled,
        task_runner_rearm_contract_compiled,
        task_runner_max_alarm_fires,
        task_runner_submit_path_compiled,
        task_runner_poll_path_compiled,
        task_runner_status_probe_compiled,
        task_runner_staging_replay_verified,
        task_runner_cutover_ready,
        task_runner_cutover_guards: task_runner_cutover_guards(),
        task_poller_timeout_sweep_enabled: task_poller_config.timeout_minutes > 0,
        task_poller_query_limit: task_poller_config.query_limit,
        task_poller_timeout_minutes: task_poller_config.timeout_minutes,
        task_poller_timeout_sweep_limit: task_poller_config.timeout_sweep_limit,
        task_poller_poll_lease_seconds: task_poller_config.poll_lease_seconds,
        task_poller_retry_base_seconds: task_poller_config.retry_base_seconds,
        task_poller_retry_max_seconds: task_poller_config.retry_max_seconds,
        task_poller_max_consecutive_failures: task_poller_config.max_consecutive_failures,
    };

    envelope_ok_response(&capabilities)
}

pub async fn relay_billing_ledger_status(req: Request, env: Env) -> WorkerResult<Response> {
    let mut response = relay_billing_ledger_status_response(req, env).await?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

async fn relay_billing_ledger_status_response(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("relay billing ledger status: D1 unavailable: {err}");
            return Ok(envelope_error_response(
                503,
                "Relay billing ledger status is unavailable",
            ));
        }
    };
    let rows = match crate::d1_repositories::recent_relay_billing_ledger_status(
        &db,
        RELAY_BILLING_RECOVERY_STATUS_LIMIT,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("relay billing ledger status query failed: {err}");
            return Ok(envelope_error_response(
                503,
                "Relay billing ledger status is unavailable",
            ));
        }
    };
    let now = crate::admin::unix_timestamp();
    let records = rows
        .into_iter()
        .map(|row| relay_billing_ledger_status_metadata(row, now))
        .collect::<Vec<_>>();
    let global_sweep = match crate::d1_repositories::relay_billing_recovery_state(&db).await {
        Ok(state) => state.map(relay_billing_global_sweep_status),
        Err(err) => {
            worker::console_error!("relay billing global sweep status query failed: {err}");
            return Ok(envelope_error_response(
                503,
                "Relay billing ledger status is unavailable",
            ));
        }
    };
    let status = RelayBillingLedgerStatus {
        contract_version: 1,
        count: records.len(),
        global_sweep,
        records,
    };
    envelope_ok_response(&status)
}

fn relay_billing_ledger_status_metadata(
    row: crate::d1_repositories::RelayBillingLedgerStatusRow,
    now: i64,
) -> RelayBillingLedgerStatusMetadata {
    let account_scope = format!("{}|{}", row.user_id, row.token_id);
    let recovery_state = relay_billing_recovery_state(&row, now);
    RelayBillingLedgerStatusMetadata {
        reservation_fingerprint: realtime_recovery_fingerprint(
            "relay-reservation-v1",
            &row.reservation_key,
        ),
        account_scope_fingerprint: realtime_recovery_fingerprint(
            "relay-account-v1",
            &account_scope,
        ),
        outcome: relay_billing_ledger_outcome(&row.status),
        terminal: matches!(row.status.as_str(), "settled" | "refunded"),
        selected: row.channel_id > 0 && row.selected_at > 0,
        request_accounted: row.request_accounted == 1,
        lease_expires_at: row.lease_expires_at,
        updated_at: row.updated_at,
        settled_at: (row.settled_at > 0).then_some(row.settled_at),
        refunded_at: (row.refunded_at > 0).then_some(row.refunded_at),
        recovery_required_at: (row.recovery_required_at > 0).then_some(row.recovery_required_at),
        recovery_attempt_count: row.recovery_attempt_count,
        recovery_next_attempt_at: (row.recovery_next_attempt_at > 0)
            .then_some(row.recovery_next_attempt_at),
        recovery_last_attempt_at: (row.recovery_last_attempt_at > 0)
            .then_some(row.recovery_last_attempt_at),
        recovery_state,
    }
}

fn relay_billing_global_sweep_status(
    row: crate::d1_repositories::RelayBillingRecoveryStateRow,
) -> RelayBillingGlobalSweepStatus {
    RelayBillingGlobalSweepStatus {
        last_started_at: row.last_started_at,
        last_completed_at: row.last_completed_at,
        last_success_at: (row.last_success_at > 0).then_some(row.last_success_at),
        last_candidates: row.last_candidates,
        last_refunded: row.last_refunded,
        last_recovery_required: row.last_recovery_required,
        last_failed: row.last_failed,
        last_deferred: row.last_deferred,
    }
}

fn relay_billing_recovery_state(
    row: &crate::d1_repositories::RelayBillingLedgerStatusRow,
    now: i64,
) -> RelayBillingRecoveryState {
    match row.status.as_str() {
        "settled" | "refunded" => RelayBillingRecoveryState::Terminal,
        "recovery_required" => RelayBillingRecoveryState::ManualReconciliation,
        "reserved"
            if now
                <= row.lease_expires_at.saturating_add(
                    crate::d1_repositories::RELAY_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS,
                ) =>
        {
            RelayBillingRecoveryState::SettlementGrace
        }
        "reserved" if row.recovery_next_attempt_at > now => RelayBillingRecoveryState::RetryBackoff,
        "reserved" => RelayBillingRecoveryState::RecoveryDue,
        _ => RelayBillingRecoveryState::Unknown,
    }
}

fn relay_billing_ledger_outcome(status: &str) -> RelayBillingLedgerOutcome {
    match status {
        "reserved" => RelayBillingLedgerOutcome::Reserved,
        "settled" => RelayBillingLedgerOutcome::Settled,
        "refunded" => RelayBillingLedgerOutcome::Refunded,
        "recovery_required" => RelayBillingLedgerOutcome::RecoveryRequired,
        _ => RelayBillingLedgerOutcome::Unknown,
    }
}

pub async fn realtime_billing_ledger_status(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("realtime billing ledger status: D1 unavailable: {err}");
            return Ok(envelope_error_response(
                503,
                "Realtime billing ledger status is unavailable",
            ));
        }
    };
    let rows = match crate::d1_repositories::recent_realtime_billing_ledger_status(
        &db,
        REALTIME_BILLING_RECOVERY_STATUS_LIMIT,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            worker::console_error!("realtime billing ledger status query failed: {err}");
            return Ok(envelope_error_response(
                503,
                "Realtime billing ledger status is unavailable",
            ));
        }
    };
    let records = rows
        .into_iter()
        .map(|row| realtime_billing_ledger_status_metadata(row, crate::admin::unix_timestamp()))
        .collect::<Vec<_>>();
    let global_sweep = match crate::d1_repositories::realtime_billing_recovery_state(&db).await {
        Ok(state) => state.map(realtime_billing_global_sweep_status),
        Err(err) => {
            worker::console_error!("realtime billing global sweep status query failed: {err}");
            return Ok(envelope_error_response(
                503,
                "Realtime billing ledger status is unavailable",
            ));
        }
    };
    let status = RealtimeBillingLedgerStatus {
        contract_version: 3,
        count: records.len(),
        global_sweep,
        records,
    };
    let mut response = envelope_ok_response(&status)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn realtime_billing_ledger_status_metadata(
    row: crate::d1_repositories::RealtimeBillingLedgerStatusRow,
    now: i64,
) -> RealtimeBillingLedgerStatusMetadata {
    let owner_seed = format!("{}|{}", row.session, row.bridge_segment);
    let recovery_state = realtime_billing_recovery_state(&row, now);
    RealtimeBillingLedgerStatusMetadata {
        reservation_fingerprint: realtime_recovery_fingerprint(
            "reservation-v1",
            &row.reservation_key,
        ),
        scope_kind: "realtime_bridge_segment",
        scope_fingerprint: realtime_recovery_fingerprint("bridge-scope-v1", &owner_seed),
        outcome: realtime_billing_ledger_outcome(&row.status, &row.finalization_owner),
        terminal: matches!(row.status.as_str(), "settled" | "refunded"),
        reservation_sequence: row.reservation_sequence,
        lease_expires_at: row.lease_expires_at,
        updated_at: row.updated_at,
        settled_at: (row.settled_at > 0).then_some(row.settled_at),
        refunded_at: (row.refunded_at > 0).then_some(row.refunded_at),
        recovery_attempt_count: row.recovery_attempt_count,
        recovery_next_attempt_at: (row.recovery_next_attempt_at > 0)
            .then_some(row.recovery_next_attempt_at),
        recovery_last_attempt_at: (row.recovery_last_attempt_at > 0)
            .then_some(row.recovery_last_attempt_at),
        recovery_state,
        requires_reconciliation: row.finalization_owner
            == crate::d1_repositories::REALTIME_USAGE_RECONCILIATION_OWNER,
        finalization_reason: (!row.finalization_reason.is_empty())
            .then_some(row.finalization_reason),
        finalization_required_at: (row.finalization_required_at > 0)
            .then_some(row.finalization_required_at),
        reconciliation_id: (!row.reconciliation_id.is_empty()).then_some(row.reconciliation_id),
        reconciliation_revision: row.reconciliation_revision,
        reconciliation_resolution: (!row.reconciliation_resolution.is_empty())
            .then_some(row.reconciliation_resolution),
        reconciliation_resolved_at: (row.reconciliation_resolved_at > 0)
            .then_some(row.reconciliation_resolved_at),
    }
}

fn realtime_billing_global_sweep_status(
    row: crate::d1_repositories::RealtimeBillingRecoveryStateRow,
) -> RealtimeBillingGlobalSweepStatus {
    RealtimeBillingGlobalSweepStatus {
        last_started_at: row.last_started_at,
        last_completed_at: row.last_completed_at,
        last_success_at: (row.last_success_at > 0).then_some(row.last_success_at),
        last_candidates: row.last_candidates,
        last_refunded: row.last_refunded,
        last_recovery_required: row.last_recovery_required,
        last_failed: row.last_failed,
        last_deferred: row.last_deferred,
    }
}

fn realtime_billing_recovery_state(
    row: &crate::d1_repositories::RealtimeBillingLedgerStatusRow,
    now: i64,
) -> RealtimeBillingRecoveryState {
    if row.finalization_owner == crate::d1_repositories::REALTIME_USAGE_RECONCILIATION_OWNER {
        return RealtimeBillingRecoveryState::ManualReconciliation;
    }
    match row.status.as_str() {
        "settled" | "refunded" => RealtimeBillingRecoveryState::Terminal,
        "reserved"
            if now
                <= row.lease_expires_at.saturating_add(
                    crate::d1_repositories::REALTIME_BILLING_ORPHAN_RECOVERY_GRACE_SECONDS,
                ) =>
        {
            RealtimeBillingRecoveryState::SettlementGrace
        }
        "reserved" if row.recovery_next_attempt_at > now => {
            RealtimeBillingRecoveryState::RetryBackoff
        }
        "reserved" => RealtimeBillingRecoveryState::RecoveryDue,
        _ => RealtimeBillingRecoveryState::Unknown,
    }
}

fn realtime_billing_ledger_outcome(
    status: &str,
    finalization_owner: &str,
) -> RealtimeBillingLedgerOutcome {
    if finalization_owner == crate::d1_repositories::REALTIME_USAGE_RECONCILIATION_OWNER {
        return RealtimeBillingLedgerOutcome::RecoveryRequired;
    }
    match status {
        "reserved" => RealtimeBillingLedgerOutcome::Reserved,
        "settled" => RealtimeBillingLedgerOutcome::Settled,
        "refunded" => RealtimeBillingLedgerOutcome::Refunded,
        _ => RealtimeBillingLedgerOutcome::Unknown,
    }
}

fn realtime_recovery_fingerprint(domain: &str, value: &str) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(format!("{domain}\0{value}").as_bytes())
    )
}

#[derive(Debug, Deserialize)]
struct D1MigrationNameRow {
    name: String,
}

#[derive(Debug, Default)]
struct D1MigrationStatus {
    available: bool,
    applied_count: i64,
    latest: Option<String>,
    expected_applied: bool,
    set_matches: bool,
}

impl D1MigrationStatus {
    fn ready(&self) -> bool {
        d1_migration_ready(self.available, self.set_matches)
    }
}

async fn load_d1_migration_status(env: &Env) -> D1MigrationStatus {
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_warn!("D1 migration status binding unavailable: {}", err);
            return D1MigrationStatus::default();
        }
    };
    let result = db
        .prepare("SELECT name FROM d1_migrations ORDER BY name")
        .all()
        .await;
    match result {
        Ok(result) => match result.results::<D1MigrationNameRow>() {
            Ok(rows) => {
                let applied: Vec<String> = rows.into_iter().map(|row| row.name).collect();
                D1MigrationStatus {
                    available: true,
                    applied_count: i64::try_from(applied.len()).unwrap_or(i64::MAX),
                    latest: applied.last().cloned(),
                    expected_applied: applied.iter().any(|name| name == EXPECTED_D1_MIGRATION),
                    set_matches: d1_migration_set_matches(&applied),
                }
            }
            Err(err) => {
                worker::console_warn!("D1 migration status decode unavailable: {}", err);
                D1MigrationStatus::default()
            }
        },
        Err(err) => {
            worker::console_warn!("D1 migration status query unavailable: {}", err);
            D1MigrationStatus::default()
        }
    }
}

fn d1_migration_set_matches(applied: &[String]) -> bool {
    applied.len() == EXPECTED_D1_MIGRATIONS.len()
        && applied
            .iter()
            .map(String::as_str)
            .eq(EXPECTED_D1_MIGRATIONS.iter().copied())
}

fn d1_migration_ready(available: bool, set_matches: bool) -> bool {
    available && set_matches
}

pub async fn task_runner_status(
    req: Request,
    env: Env,
    task_id: Option<String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(task_id) = task_id
        .as_deref()
        .and_then(task_runner_status_probe_task_id)
    else {
        return gateway_error(
            400,
            "invalid_task_runner_task_id",
            "TaskRunner status probe requires a valid task id",
        );
    };
    let status = match fetch_task_runner_status(&env, &task_id).await {
        Ok(status) => status,
        Err(err) => {
            worker::console_warn!("TaskRunner status probe unavailable: {}", err);
            return gateway_error(
                503,
                "task_runner_status_unavailable",
                "TaskRunner status probe is unavailable",
            );
        }
    };
    let mut response = envelope_ok_response(&status)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct RealtimeSettlementSmokeRequest {
    scenario: String,
    confirm_live: bool,
    cleanup: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RealtimeSettlementSmokeScenario {
    AdditionalQuotaApplied,
    DuplicateReplayNoop,
    GuardedUpdateRollback,
    AuditFailureRollback,
    RefundDeltaApplied,
    TokenlessApplied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeSettlementSmokeFixture {
    scenario: RealtimeSettlementSmokeScenario,
    user_id: i64,
    token_id: i64,
    channel_id: i64,
    user_quota: i64,
    user_used_quota: i64,
    token_remain_quota: i64,
    token_used_quota: i64,
    channel_used_quota: i64,
    pre_consumed_quota: i64,
    final_quota: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeSettlementSmokeSnapshot {
    user_quota: i64,
    user_used_quota: i64,
    user_request_count: i64,
    token_remain_quota: Option<i64>,
    token_used_quota: Option<i64>,
    token_accessed_time: Option<i64>,
    channel_used_quota: i64,
    replay_rows: i64,
    log_rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeSettlementSmokeReport {
    scenario: &'static str,
    status: &'static str,
    binding_path: &'static str,
    confirmation: &'static str,
    cleanup_requested: bool,
    cleanup_performed: bool,
    first_outcome: String,
    second_outcome: Option<String>,
    error: Option<String>,
    setup_snapshot: RealtimeSettlementSmokeSnapshot,
    final_snapshot: RealtimeSettlementSmokeSnapshot,
    expected_snapshot: RealtimeSettlementSmokeSnapshot,
    expected_outcomes: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
struct UserSmokeSnapshotRow {
    quota: i64,
    used_quota: i64,
    request_count: i64,
}

#[derive(Debug, Deserialize)]
struct TokenSmokeSnapshotRow {
    remain_quota: i64,
    used_quota: i64,
    accessed_time: i64,
}

#[derive(Debug, Deserialize)]
struct ChannelSmokeSnapshotRow {
    used_quota: i64,
}

#[derive(Debug, Deserialize)]
struct SmokeCountRow {
    count: i64,
}

/// Admin-only staging smoke that exercises the actual D1 binding batch used by
/// Realtime settlement. The route is default-off, rejects production, and only
/// accepts fixed scenario names so it cannot become a general SQL console.
pub async fn realtime_settlement_batch_smoke(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    if runtime_value(&env, "ENVIRONMENT")
        .map(|value| matches!(value.as_str(), "production" | "prod"))
        .unwrap_or(false)
    {
        return Ok(envelope_error_response(
            403,
            "Realtime settlement binding smoke is not available in production",
        ));
    }
    if !env_flag(&env, REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED_ENV) {
        return Ok(envelope_error_response(
            403,
            "Realtime settlement binding smoke is disabled",
        ));
    }

    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input: RealtimeSettlementSmokeRequest = match serde_json::from_value(body) {
        Ok(input) => input,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid realtime settlement smoke request: {err}"),
            ));
        }
    };
    if !input.confirm_live {
        return Ok(envelope_error_response(
            400,
            "Realtime settlement binding smoke requires confirm_live=true",
        ));
    }
    let scenario = match realtime_settlement_smoke_scenario(&input.scenario) {
        Some(scenario) => scenario,
        None => {
            return Ok(envelope_error_response(
                400,
                "unknown realtime settlement smoke scenario",
            ));
        }
    };

    let db = env.d1("DB")?;
    let cleanup_requested = input.cleanup.unwrap_or(true);
    let report = run_realtime_settlement_smoke(&db, scenario, cleanup_requested).await?;
    let mut response = envelope_ok_response(&report)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn realtime_settlement_staging_smoke_compiled() -> bool {
    realtime_settlement_smoke_scenarios().len() == 6
        && realtime_settlement_smoke_scenario("additional-quota-applied").is_some()
        && realtime_settlement_smoke_scenario("duplicate-replay-noop").is_some()
        && realtime_settlement_smoke_scenario("guarded-update-rollback").is_some()
        && realtime_settlement_smoke_scenario("audit-failure-rollback").is_some()
        && realtime_settlement_smoke_scenario("refund-delta-applied").is_some()
        && realtime_settlement_smoke_scenario("tokenless-applied").is_some()
}

fn realtime_settlement_smoke_scenarios() -> [RealtimeSettlementSmokeScenario; 6] {
    [
        RealtimeSettlementSmokeScenario::AdditionalQuotaApplied,
        RealtimeSettlementSmokeScenario::DuplicateReplayNoop,
        RealtimeSettlementSmokeScenario::GuardedUpdateRollback,
        RealtimeSettlementSmokeScenario::AuditFailureRollback,
        RealtimeSettlementSmokeScenario::RefundDeltaApplied,
        RealtimeSettlementSmokeScenario::TokenlessApplied,
    ]
}

fn realtime_settlement_smoke_scenario(value: &str) -> Option<RealtimeSettlementSmokeScenario> {
    match value.trim() {
        "additional-quota-applied" => Some(RealtimeSettlementSmokeScenario::AdditionalQuotaApplied),
        "duplicate-replay-noop" => Some(RealtimeSettlementSmokeScenario::DuplicateReplayNoop),
        "guarded-update-rollback" => Some(RealtimeSettlementSmokeScenario::GuardedUpdateRollback),
        "audit-failure-rollback" => Some(RealtimeSettlementSmokeScenario::AuditFailureRollback),
        "refund-delta-applied" => Some(RealtimeSettlementSmokeScenario::RefundDeltaApplied),
        "tokenless-applied" => Some(RealtimeSettlementSmokeScenario::TokenlessApplied),
        _ => None,
    }
}

impl RealtimeSettlementSmokeScenario {
    fn name(self) -> &'static str {
        match self {
            Self::AdditionalQuotaApplied => "additional-quota-applied",
            Self::DuplicateReplayNoop => "duplicate-replay-noop",
            Self::GuardedUpdateRollback => "guarded-update-rollback",
            Self::AuditFailureRollback => "audit-failure-rollback",
            Self::RefundDeltaApplied => "refund-delta-applied",
            Self::TokenlessApplied => "tokenless-applied",
        }
    }

    fn fixture(self) -> RealtimeSettlementSmokeFixture {
        match self {
            Self::AdditionalQuotaApplied => {
                RealtimeSettlementSmokeFixture::new(self, 920101, 900, 0, 400, 100, 0, 100, 150)
            }
            Self::DuplicateReplayNoop => {
                RealtimeSettlementSmokeFixture::new(self, 920102, 900, 0, 400, 100, 0, 100, 150)
            }
            Self::GuardedUpdateRollback => {
                RealtimeSettlementSmokeFixture::new(self, 920103, 105, 0, 400, 100, 0, 100, 250)
            }
            Self::AuditFailureRollback => {
                RealtimeSettlementSmokeFixture::new(self, 920104, 900, 0, 400, 100, 0, 100, 150)
            }
            Self::RefundDeltaApplied => {
                RealtimeSettlementSmokeFixture::new(self, 920105, 800, 0, 300, 200, 0, 200, 120)
            }
            Self::TokenlessApplied => {
                RealtimeSettlementSmokeFixture::new_tokenless(self, 920106, 900, 0, 0, 100, 130)
            }
        }
    }
}

impl RealtimeSettlementSmokeFixture {
    #[allow(clippy::too_many_arguments)]
    fn new(
        scenario: RealtimeSettlementSmokeScenario,
        base_id: i64,
        user_quota: i64,
        user_used_quota: i64,
        token_remain_quota: i64,
        token_used_quota: i64,
        channel_used_quota: i64,
        pre_consumed_quota: i64,
        final_quota: i64,
    ) -> Self {
        Self {
            scenario,
            user_id: base_id,
            token_id: base_id + 10_000,
            channel_id: base_id + 20_000,
            user_quota,
            user_used_quota,
            token_remain_quota,
            token_used_quota,
            channel_used_quota,
            pre_consumed_quota,
            final_quota,
        }
    }

    fn new_tokenless(
        scenario: RealtimeSettlementSmokeScenario,
        base_id: i64,
        user_quota: i64,
        user_used_quota: i64,
        channel_used_quota: i64,
        pre_consumed_quota: i64,
        final_quota: i64,
    ) -> Self {
        Self {
            scenario,
            user_id: base_id,
            token_id: 0,
            channel_id: base_id + 20_000,
            user_quota,
            user_used_quota,
            token_remain_quota: 0,
            token_used_quota: 0,
            channel_used_quota,
            pre_consumed_quota,
            final_quota,
        }
    }

    fn replay_key(self) -> String {
        format!("rtsettle-{}", self.scenario.name())
    }

    fn reservation_key(self) -> String {
        format!("rtreserve-{}", self.scenario.name())
    }

    fn response_id_hash(self) -> String {
        format!("response-hash-{}", self.scenario.name())
    }

    fn session(self) -> String {
        format!("rtsettle-{}", self.scenario.name())
    }

    fn username(self) -> String {
        format!("rtsettle_{}", self.scenario.name().replace('-', "_"))
    }

    fn aff_code(self) -> String {
        format!("rt{}", self.user_id)
    }

    fn token_key(self) -> String {
        format!("rtsettle-smoke-key-{}", self.scenario.name())
    }

    fn token_name(self) -> String {
        if self.token_id > 0 {
            format!("rtsettle smoke token {}", self.scenario.name())
        } else {
            String::new()
        }
    }

    fn channel_name(self) -> String {
        format!("rtsettle smoke {}", self.scenario.name())
    }

    fn request_id(self) -> String {
        format!("req-rtsettle-{}", self.scenario.name())
    }

    fn expected_outcomes(self) -> Vec<&'static str> {
        match self.scenario {
            RealtimeSettlementSmokeScenario::DuplicateReplayNoop => {
                vec!["Applied", "DuplicateReplay"]
            }
            RealtimeSettlementSmokeScenario::GuardedUpdateRollback
            | RealtimeSettlementSmokeScenario::AuditFailureRollback => vec!["Error"],
            _ => vec!["Applied"],
        }
    }

    fn expected_snapshot(self, applied_at: i64) -> RealtimeSettlementSmokeSnapshot {
        match self.scenario {
            RealtimeSettlementSmokeScenario::AdditionalQuotaApplied
            | RealtimeSettlementSmokeScenario::DuplicateReplayNoop => {
                RealtimeSettlementSmokeSnapshot {
                    user_quota: 850,
                    user_used_quota: 150,
                    user_request_count: 1,
                    token_remain_quota: Some(350),
                    token_used_quota: Some(150),
                    token_accessed_time: Some(applied_at),
                    channel_used_quota: 150,
                    replay_rows: 1,
                    log_rows: 1,
                }
            }
            RealtimeSettlementSmokeScenario::GuardedUpdateRollback => {
                self.initial_snapshot_with_rows(0, 0)
            }
            RealtimeSettlementSmokeScenario::AuditFailureRollback => {
                self.initial_snapshot_with_rows(0, 0)
            }
            RealtimeSettlementSmokeScenario::RefundDeltaApplied => {
                RealtimeSettlementSmokeSnapshot {
                    user_quota: 880,
                    user_used_quota: 120,
                    user_request_count: 1,
                    token_remain_quota: Some(380),
                    token_used_quota: Some(120),
                    token_accessed_time: Some(applied_at),
                    channel_used_quota: 120,
                    replay_rows: 1,
                    log_rows: 1,
                }
            }
            RealtimeSettlementSmokeScenario::TokenlessApplied => RealtimeSettlementSmokeSnapshot {
                user_quota: 870,
                user_used_quota: 130,
                user_request_count: 1,
                token_remain_quota: None,
                token_used_quota: None,
                token_accessed_time: None,
                channel_used_quota: 130,
                replay_rows: 1,
                log_rows: 1,
            },
        }
    }

    fn initial_snapshot_with_rows(
        self,
        replay_rows: i64,
        log_rows: i64,
    ) -> RealtimeSettlementSmokeSnapshot {
        RealtimeSettlementSmokeSnapshot {
            user_quota: self.user_quota,
            user_used_quota: self.user_used_quota,
            user_request_count: 0,
            token_remain_quota: (self.token_id > 0).then_some(self.token_remain_quota),
            token_used_quota: (self.token_id > 0).then_some(self.token_used_quota),
            token_accessed_time: (self.token_id > 0).then_some(0),
            channel_used_quota: self.channel_used_quota,
            replay_rows,
            log_rows,
        }
    }
}

async fn run_realtime_settlement_smoke(
    db: &D1Database,
    scenario: RealtimeSettlementSmokeScenario,
    cleanup_requested: bool,
) -> WorkerResult<RealtimeSettlementSmokeReport> {
    let fixture = scenario.fixture();
    cleanup_realtime_settlement_smoke_fixture(db, fixture).await?;
    seed_realtime_settlement_smoke_fixture(db, fixture).await?;
    let setup_snapshot = realtime_settlement_smoke_snapshot(db, fixture).await?;

    let applied_at = crate::admin::unix_timestamp();
    let (first_outcome, second_outcome, error) =
        apply_realtime_settlement_smoke_fixture(db, fixture, applied_at).await?;
    let final_snapshot = realtime_settlement_smoke_snapshot(db, fixture).await?;
    let expected_snapshot = fixture.expected_snapshot(applied_at);
    let expected_outcomes = fixture.expected_outcomes();
    let observed_outcomes = if let Some(second) = second_outcome.as_deref() {
        vec![first_outcome.as_str(), second]
    } else {
        vec![first_outcome.as_str()]
    };
    let status = if final_snapshot == expected_snapshot
        && observed_outcomes == expected_outcomes
        && setup_snapshot == fixture.initial_snapshot_with_rows(0, 0)
    {
        "PASS"
    } else {
        "FAIL"
    };

    if cleanup_requested {
        cleanup_realtime_settlement_smoke_fixture(db, fixture).await?;
    }

    Ok(RealtimeSettlementSmokeReport {
        scenario: scenario.name(),
        status,
        binding_path: "worker_binding",
        confirmation: "D1Database.batch via apply_realtime_settlement_batch",
        cleanup_requested,
        cleanup_performed: cleanup_requested,
        first_outcome,
        second_outcome,
        error,
        setup_snapshot,
        final_snapshot,
        expected_snapshot,
        expected_outcomes,
    })
}

async fn apply_realtime_settlement_smoke_fixture(
    db: &D1Database,
    fixture: RealtimeSettlementSmokeFixture,
    applied_at: i64,
) -> WorkerResult<(String, Option<String>, Option<String>)> {
    if fixture.scenario == RealtimeSettlementSmokeScenario::AuditFailureRollback {
        install_realtime_settlement_smoke_audit_failure_trigger(db).await?;
    }
    let first = apply_realtime_settlement_smoke_once(db, fixture, applied_at).await;
    if fixture.scenario == RealtimeSettlementSmokeScenario::AuditFailureRollback {
        drop_realtime_settlement_smoke_audit_failure_trigger(db).await?;
    }

    match fixture.scenario {
        RealtimeSettlementSmokeScenario::DuplicateReplayNoop => {
            let first = settlement_smoke_outcome(first);
            let second = settlement_smoke_outcome(
                apply_realtime_settlement_smoke_once(db, fixture, applied_at).await,
            );
            let error = first.1.or(second.1);
            Ok((first.0, Some(second.0), error))
        }
        _ => {
            let first = settlement_smoke_outcome(first);
            Ok((first.0, None, first.1))
        }
    }
}

fn settlement_smoke_outcome(
    result: WorkerResult<crate::d1_repositories::RealtimeSettlementBatchOutcome>,
) -> (String, Option<String>) {
    match result {
        Ok(crate::d1_repositories::RealtimeSettlementBatchOutcome::Applied) => {
            ("Applied".to_string(), None)
        }
        Ok(crate::d1_repositories::RealtimeSettlementBatchOutcome::DuplicateReplay) => {
            ("DuplicateReplay".to_string(), None)
        }
        Err(err) => ("Error".to_string(), Some(err.to_string())),
    }
}

async fn apply_realtime_settlement_smoke_once(
    db: &D1Database,
    fixture: RealtimeSettlementSmokeFixture,
    applied_at: i64,
) -> WorkerResult<crate::d1_repositories::RealtimeSettlementBatchOutcome> {
    let replay_key = fixture.replay_key();
    let reservation_key = fixture.reservation_key();
    let response_id_hash = fixture.response_id_hash();
    let session = fixture.session();
    let username = fixture.username();
    let token_name = fixture.token_name();
    let request_id = fixture.request_id();
    let model = "gpt-4o-realtime-preview";
    let group = "default";
    let ip = "198.51.100.42";
    let upstream_request_id = "";
    let audit_other = json!({
        "tiered_billing": {
            "final_quota": fixture.final_quota,
            "pre_consumed_quota": fixture.pre_consumed_quota
        },
        "realtime_billing": {
            "binding_smoke": true,
            "scenario": fixture.scenario.name(),
            "replay_recorded": true
        }
    })
    .to_string();
    let audit_log = RelayAuditLog {
        user_id: fixture.user_id,
        username: &username,
        token_id: fixture.token_id,
        token_name: &token_name,
        channel_id: fixture.channel_id,
        model,
        group,
        prompt_tokens: 1000,
        completion_tokens: 600,
        quota: fixture.final_quota,
        use_time_seconds: 3,
        is_stream: true,
        ip,
        request_id: &request_id,
        upstream_request_id,
        other: &audit_other,
    };
    let content = format!(
        "Rust realtime settlement binding smoke {}; tiered quota {}",
        fixture.scenario.name(),
        fixture.final_quota
    );
    crate::d1_repositories::apply_realtime_reserved_settlement_batch(
        db,
        &reservation_key,
        &response_id_hash,
        crate::d1_repositories::RealtimeSettlementReplayRecord {
            replay_key: &replay_key,
            session: &session,
            user_id: fixture.user_id,
            token_id: fixture.token_id,
            channel_id: fixture.channel_id,
            model_name: model,
            pre_consumed_quota: fixture.pre_consumed_quota,
            final_quota: fixture.final_quota,
            created_at: applied_at,
            applied_at,
        },
        &content,
        &audit_log,
    )
    .await
}

async fn seed_realtime_settlement_smoke_fixture(
    db: &D1Database,
    fixture: RealtimeSettlementSmokeFixture,
) -> WorkerResult<()> {
    let username = fixture.username();
    let aff_code = fixture.aff_code();
    let password = "smoke-disabled";
    let group = "default";
    let user_args = [
        D1Type::Integer(d1_i32(fixture.user_id)),
        D1Type::Text(username.as_str()),
        D1Type::Text(password),
        D1Type::Integer(d1_i32(fixture.user_quota)),
        D1Type::Integer(d1_i32(fixture.user_used_quota)),
        D1Type::Text(group),
        D1Type::Text(aff_code.as_str()),
    ];
    db.prepare(
        r#"
        INSERT INTO users (
          id, username, password, role, status, quota, used_quota,
          request_count, "group", aff_code, created_at
        ) VALUES (?1, ?2, ?3, 1, 1, ?4, ?5, 0, ?6, ?7, 0)
        "#,
    )
    .bind_refs(&user_args)?
    .run()
    .await?;

    if fixture.token_id > 0 {
        let token_key = fixture.token_key();
        let token_name = fixture.token_name();
        let token_args = [
            D1Type::Integer(d1_i32(fixture.token_id)),
            D1Type::Integer(d1_i32(fixture.user_id)),
            D1Type::Text(token_key.as_str()),
            D1Type::Text(token_name.as_str()),
            D1Type::Integer(d1_i32(fixture.token_remain_quota)),
            D1Type::Integer(d1_i32(fixture.token_used_quota)),
            D1Type::Text(group),
        ];
        db.prepare(
            r#"
            INSERT INTO tokens (
              id, user_id, "key", status, name, created_time, accessed_time,
              expired_time, remain_quota, unlimited_quota, used_quota, "group"
            ) VALUES (?1, ?2, ?3, 1, ?4, 0, 0, -1, ?5, 0, ?6, ?7)
            "#,
        )
        .bind_refs(&token_args)?
        .run()
        .await?;
    }

    let channel_key = "smoke-channel-key";
    let channel_name = fixture.channel_name();
    let model = "gpt-4o-realtime-preview";
    let channel_args = [
        D1Type::Integer(d1_i32(fixture.channel_id)),
        D1Type::Text(channel_key),
        D1Type::Text(channel_name.as_str()),
        D1Type::Text(model),
        D1Type::Text(group),
        D1Type::Integer(d1_i32(fixture.channel_used_quota)),
    ];
    db.prepare(
        r#"
        INSERT INTO channels (
          id, type, "key", status, name, created_time, models, "group", used_quota
        ) VALUES (?1, 1, ?2, 1, ?3, 0, ?4, ?5, ?6)
        "#,
    )
    .bind_refs(&channel_args)?
    .run()
    .await?;

    let reservation_key = fixture.reservation_key();
    let session = fixture.session();
    let token_name = fixture.token_name();
    let request_id = fixture.request_id();
    let reservation_args = [
        D1Type::Text(reservation_key.as_str()),
        D1Type::Text(session.as_str()),
        D1Type::Integer(d1_i32(fixture.user_id)),
        D1Type::Integer(d1_i32(fixture.token_id)),
        D1Type::Integer(d1_i32(fixture.channel_id)),
        D1Type::Text(group),
        D1Type::Text(model),
        D1Type::Integer(d1_i32(fixture.pre_consumed_quota)),
        D1Type::Text(username.as_str()),
        D1Type::Text(token_name.as_str()),
        D1Type::Text(request_id.as_str()),
        D1Type::Integer(d1_i32(crate::admin::unix_timestamp().saturating_add(900))),
    ];
    db.prepare(
        r#"
        INSERT INTO realtime_billing_reservations (
          reservation_key, session, client_event_id_hash, reservation_sequence,
          user_id, token_id, channel_id, selected_group, model_name,
          pre_consumed_quota, snapshot_json, request_json,
          username, token_name, request_id, endpoint_path,
          status, created_at, updated_at, lease_expires_at
        ) VALUES (
          ?1, ?2, 'binding-smoke-client-event', 1,
          ?3, ?4, ?5, ?6, ?7, ?8, '{}', '{}',
          ?9, ?10, ?11, 'realtime', 'reserved', 0, 0, ?12
        )
        "#,
    )
    .bind_refs(&reservation_args)?
    .run()
    .await?;

    Ok(())
}

async fn cleanup_realtime_settlement_smoke_fixture(
    db: &D1Database,
    fixture: RealtimeSettlementSmokeFixture,
) -> WorkerResult<()> {
    let replay_key = fixture.replay_key();
    let request_id = fixture.request_id();
    let log_args = [
        D1Type::Text(request_id.as_str()),
        D1Type::Integer(d1_i32(fixture.user_id)),
        D1Type::Integer(d1_i32(fixture.channel_id)),
    ];
    db.prepare(
        r#"
        DELETE FROM logs
        WHERE request_id = ?1
           OR user_id = ?2
           OR channel_id = ?3
        "#,
    )
    .bind_refs(&log_args)?
    .run()
    .await?;

    let replay_args = [D1Type::Text(replay_key.as_str())];
    db.prepare("DELETE FROM realtime_settlement_replays WHERE replay_key = ?1")
        .bind_refs(&replay_args)?
        .run()
        .await?;

    let reservation_key = fixture.reservation_key();
    let reservation_args = [D1Type::Text(reservation_key.as_str())];
    db.prepare("DELETE FROM realtime_billing_reservations WHERE reservation_key = ?1")
        .bind_refs(&reservation_args)?
        .run()
        .await?;

    if fixture.token_id > 0 {
        let token_args = [D1Type::Integer(d1_i32(fixture.token_id))];
        db.prepare("DELETE FROM tokens WHERE id = ?1")
            .bind_refs(&token_args)?
            .run()
            .await?;
    }

    let channel_args = [D1Type::Integer(d1_i32(fixture.channel_id))];
    db.prepare("DELETE FROM channels WHERE id = ?1")
        .bind_refs(&channel_args)?
        .run()
        .await?;

    let user_args = [D1Type::Integer(d1_i32(fixture.user_id))];
    db.prepare("DELETE FROM users WHERE id = ?1")
        .bind_refs(&user_args)?
        .run()
        .await?;

    drop_realtime_settlement_smoke_audit_failure_trigger(db).await?;
    Ok(())
}

async fn realtime_settlement_smoke_snapshot(
    db: &D1Database,
    fixture: RealtimeSettlementSmokeFixture,
) -> WorkerResult<RealtimeSettlementSmokeSnapshot> {
    let user_args = [D1Type::Integer(d1_i32(fixture.user_id))];
    let user = db
        .prepare("SELECT quota, used_quota, request_count FROM users WHERE id = ?1")
        .bind_refs(&user_args)?
        .first::<UserSmokeSnapshotRow>(None)
        .await?
        .ok_or_else(|| worker::Error::RustError("smoke user row missing".to_string()))?;

    let token = if fixture.token_id > 0 {
        let token_args = [D1Type::Integer(d1_i32(fixture.token_id))];
        Some(
            db.prepare("SELECT remain_quota, used_quota, accessed_time FROM tokens WHERE id = ?1")
                .bind_refs(&token_args)?
                .first::<TokenSmokeSnapshotRow>(None)
                .await?
                .ok_or_else(|| worker::Error::RustError("smoke token row missing".to_string()))?,
        )
    } else {
        None
    };

    let channel_args = [D1Type::Integer(d1_i32(fixture.channel_id))];
    let channel = db
        .prepare("SELECT used_quota FROM channels WHERE id = ?1")
        .bind_refs(&channel_args)?
        .first::<ChannelSmokeSnapshotRow>(None)
        .await?
        .ok_or_else(|| worker::Error::RustError("smoke channel row missing".to_string()))?;

    let replay_key = fixture.replay_key();
    let replay_args = [D1Type::Text(replay_key.as_str())];
    let replay_rows = db
        .prepare("SELECT COUNT(1) AS count FROM realtime_settlement_replays WHERE replay_key = ?1")
        .bind_refs(&replay_args)?
        .first::<SmokeCountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0);

    let request_id = fixture.request_id();
    let log_args = [D1Type::Text(request_id.as_str())];
    let log_rows = db
        .prepare("SELECT COUNT(1) AS count FROM logs WHERE request_id = ?1")
        .bind_refs(&log_args)?
        .first::<SmokeCountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0);

    Ok(RealtimeSettlementSmokeSnapshot {
        user_quota: user.quota,
        user_used_quota: user.used_quota,
        user_request_count: user.request_count,
        token_remain_quota: token.as_ref().map(|row| row.remain_quota),
        token_used_quota: token.as_ref().map(|row| row.used_quota),
        token_accessed_time: token.as_ref().map(|row| row.accessed_time),
        channel_used_quota: channel.used_quota,
        replay_rows,
        log_rows,
    })
}

async fn install_realtime_settlement_smoke_audit_failure_trigger(
    db: &D1Database,
) -> WorkerResult<()> {
    db.prepare(
        r#"
        CREATE TRIGGER IF NOT EXISTS ct_rt_settlement_smoke_abort_log
        BEFORE INSERT ON logs
        WHEN NEW.request_id = 'req-rtsettle-audit-failure-rollback'
        BEGIN
          SELECT RAISE(ABORT, 'cinatoken realtime settlement smoke audit failure');
        END
        "#,
    )
    .run()
    .await?;
    Ok(())
}

async fn drop_realtime_settlement_smoke_audit_failure_trigger(db: &D1Database) -> WorkerResult<()> {
    db.prepare("DROP TRIGGER IF EXISTS ct_rt_settlement_smoke_abort_log")
        .run()
        .await?;
    Ok(())
}

pub async fn dispatch_request(
    req: Request,
    env: Env,
    target: DispatchTarget,
) -> WorkerResult<Response> {
    dispatch_request_with_env(req, &env, target).await
}

pub fn dispatch_target_for_plan(plan: &WfpDispatchPlan, env: &Env) -> WorkerResult<DispatchTarget> {
    let route_kind = match plan.kind {
        WfpDispatchKind::InternalStatus => DispatchRouteKind::InternalPath,
        WfpDispatchKind::PreviewHost => DispatchRouteKind::PreviewHost,
    };
    let prefix = runtime_value(env, WFP_DISPATCH_WORKER_PREFIX_ENV);
    dispatch_target(
        route_kind,
        &plan.public_name,
        prefix.as_deref(),
        plan.tenant_path.clone(),
    )
}

pub fn wfp_preview_unavailable_response() -> WorkerResult<Response> {
    wfp_gateway_error(
        404,
        "wfp_preview_unavailable",
        "This tenant application is not currently available",
    )
}

async fn dispatch_request_with_env(
    req: Request,
    env: &Env,
    target: DispatchTarget,
) -> WorkerResult<Response> {
    if internal_dispatch_requires_admin_auth(&target) {
        if let Err(response) = require_admin_auth(&req, env).await? {
            return Ok(response);
        }
    }

    let dispatcher = match env.dynamic_dispatcher(WFP_DISPATCH_BINDING) {
        Ok(dispatcher) => dispatcher,
        Err(err) => {
            worker::console_error!("WFP dispatch binding unavailable: {}", err);
            return wfp_gateway_error(
                503,
                "wfp_dispatch_unavailable",
                "WFP dispatch binding is not configured",
            );
        }
    };
    let fetcher = match dispatcher_fetcher_with_outbound_context(&dispatcher, &target) {
        Ok(fetcher) => fetcher,
        Err(err) => {
            return wfp_dispatch_failure_response(&target, &err.to_string());
        }
    };

    let outbound = request_for_dispatch_target(req, &target)?;
    let mut response = match fetcher.fetch_request(outbound).await {
        Ok(response) => response,
        Err(err) => return wfp_dispatch_failure_response(&target, &err.to_string()),
    };
    strip_preview_response_security_headers(&mut response, &target)?;
    let headers = response.headers_mut();
    let _ = headers.set(WFP_ROUTE_REQUEST_HEADER, target.route_kind.header_value());
    let _ = headers.set(WFP_WORKER_REQUEST_HEADER, &target.public_name);
    Ok(response)
}

fn dispatcher_fetcher_with_outbound_context(
    dispatcher: &worker::DynamicDispatcher,
    target: &DispatchTarget,
) -> WorkerResult<worker::Fetcher> {
    let context = OutboundInvocationContext::new(
        target.route_kind.header_value(),
        &target.public_name,
        &target.worker_name,
    )
    .map_err(|err| worker::Error::RustError(format!("invalid WFP outbound context: {err}")))?;
    let options = serde_wasm_bindgen::to_value(&dispatch_outbound_options_value(&context))?;
    let raw_dispatcher: &ContextAwareDispatcher = dispatcher.as_ref().unchecked_ref();
    let fetcher = raw_dispatcher
        .get_with_outbound_context(
            target.worker_name.clone(),
            js_sys::Object::new().into(),
            options,
        )
        .map_err(|err| {
            worker::Error::JsError(format!("WFP context-aware dispatch get failed: {err:?}"))
        })?;
    Ok(fetcher.into())
}

fn dispatch_outbound_options_value(context: &OutboundInvocationContext) -> serde_json::Value {
    json!({
        "outbound": {
            (OUTBOUND_CONTEXT_BINDING): context,
        }
    })
}

fn wfp_outbound_invocation_context_contract_compiled() -> bool {
    let Ok(context) = OutboundInvocationContext::new(
        DispatchRouteKind::RelayAuthority.header_value(),
        "tenant-a",
        "staging-tenant-a",
    ) else {
        return false;
    };
    let options = dispatch_outbound_options_value(&context);
    cinatoken_wfp_authority::AUTHORITY_VERSION == 3
        && cinatoken_wfp_authority::OUTBOUND_POLICY_PROFILE == "platform-ai-gateway-v1"
        && OUTBOUND_CONTEXT_BINDING == "CINATOKEN_WFP_OUTBOUND_CONTEXT"
        && options["outbound"][OUTBOUND_CONTEXT_BINDING]["route_kind"] == "relay-authority"
        && options["outbound"][OUTBOUND_CONTEXT_BINDING]["public_worker"] == "tenant-a"
        && options["outbound"][OUTBOUND_CONTEXT_BINDING]["dispatch_worker"] == "staging-tenant-a"
}

fn wfp_preview_response_security_headers_compiled() -> bool {
    WFP_PREVIEW_SECURITY_HEADERS
        == [
            "service-worker-allowed",
            "service-worker-navigation-preload",
            "clear-site-data",
        ]
}

fn should_strip_preview_response_security_headers(
    route_kind: DispatchRouteKind,
    status: u16,
    upgrade: Option<&str>,
) -> bool {
    route_kind == DispatchRouteKind::PreviewHost
        && status != 101
        && !upgrade.is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn strip_preview_response_security_headers(
    response: &mut Response,
    target: &DispatchTarget,
) -> WorkerResult<()> {
    let status = response.status_code();
    let upgrade = response.headers().get("upgrade")?;
    if !should_strip_preview_response_security_headers(
        target.route_kind,
        status,
        upgrade.as_deref(),
    ) {
        return Ok(());
    }

    let headers = response.headers_mut();
    for name in WFP_PREVIEW_SECURITY_HEADERS {
        headers.delete(name)?;
    }
    Ok(())
}

fn classify_wfp_dispatch_failure(message: &str) -> WfpDispatchFailureKind {
    let mut normalized = message.trim().to_ascii_lowercase();
    for _ in 0..3 {
        let Some(unwrapped) = normalized.strip_prefix("error: ") else {
            break;
        };
        normalized = unwrapped.trim_start().to_string();
    }
    if normalized.starts_with("worker not found") {
        return WfpDispatchFailureKind::WorkerNotFound;
    }
    if normalized.contains("cpu time limit")
        || (normalized.contains("subrequest") && normalized.contains("limit"))
    {
        return WfpDispatchFailureKind::ResourceLimitExceeded;
    }
    WfpDispatchFailureKind::TenantExecutionFailed
}

fn wfp_dispatch_failure_contract_compiled() -> bool {
    WFP_DISPATCH_FAILURE_CONTRACT_VERSION == 1
        && WFP_DISPATCH_FAILURE_CLASSES
            == [
                "worker_not_found",
                "resource_limit_exceeded",
                "tenant_execution_failed",
            ]
}

fn wfp_dispatch_failure_response(
    target: &DispatchTarget,
    error_message: &str,
) -> WorkerResult<Response> {
    let failure = classify_wfp_dispatch_failure(error_message);
    worker::console_warn!(
        "WFP dispatch failed: class={} route={} worker={}",
        failure.label(),
        target.route_kind.header_value(),
        target.public_name
    );

    let (status, code, message) = wfp_dispatch_failure_contract(failure, target.route_kind);
    wfp_gateway_error(status, code, message)
}

fn wfp_dispatch_failure_contract(
    failure: WfpDispatchFailureKind,
    route_kind: DispatchRouteKind,
) -> (u16, &'static str, &'static str) {
    match failure {
        WfpDispatchFailureKind::WorkerNotFound
            if route_kind != DispatchRouteKind::RelayAuthority =>
        {
            (
                404,
                "wfp_worker_not_found",
                "WFP tenant worker was not found",
            )
        }
        WfpDispatchFailureKind::WorkerNotFound => (
            502,
            "wfp_relay_worker_unavailable",
            "WFP relay worker is unavailable",
        ),
        WfpDispatchFailureKind::ResourceLimitExceeded => (
            429,
            "wfp_worker_resource_limit_exceeded",
            "WFP tenant worker exceeded its execution limit",
        ),
        WfpDispatchFailureKind::TenantExecutionFailed => (
            502,
            "wfp_worker_execution_failed",
            "WFP tenant worker execution failed",
        ),
    }
}

fn wfp_gateway_error(status: u16, code: &str, message: &str) -> WorkerResult<Response> {
    let mut response = gateway_error(status, code, message)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

/// Dispatch an upstream request selected by the central relay. The caller has
/// already applied relay-token authentication, channel selection, quota
/// reservation, and audit ownership; this helper only supplies the WFP
/// transport and its controlled authority marker.
pub(crate) async fn dispatch_authorized_relay_request(
    req: Request,
    env: &Env,
    public_name: &str,
    signed_dispatch_worker: &str,
    authority: &str,
) -> WorkerResult<Response> {
    if !env_flag(env, WFP_DISPATCH_ENABLED_ENV) || !env_flag(env, WFP_RELAY_TRANSPORT_ENABLED_ENV) {
        return gateway_error(
            503,
            "wfp_relay_transport_disabled",
            "WFP relay transport is disabled",
        );
    }
    let tenant_path = req.path();
    let prefix = runtime_value(env, WFP_DISPATCH_WORKER_PREFIX_ENV);
    let mut target = dispatch_target(
        DispatchRouteKind::RelayAuthority,
        public_name,
        prefix.as_deref(),
        Some(tenant_path),
    )?;
    if target.worker_name != signed_dispatch_worker {
        return gateway_error(
            503,
            "wfp_dispatch_authority_target_mismatch",
            "WFP dispatch target changed after authority signing",
        );
    }
    target.authority = Some(authority.to_string());
    dispatch_request_with_env(req, env, target).await
}

pub(crate) fn authorized_relay_dispatch_worker(
    env: &Env,
    public_name: &str,
) -> WorkerResult<String> {
    let prefix = runtime_value(env, WFP_DISPATCH_WORKER_PREFIX_ENV);
    dispatch_target(
        DispatchRouteKind::RelayAuthority,
        public_name,
        prefix.as_deref(),
        None,
    )
    .map(|target| target.worker_name)
}

fn dispatch_target(
    route_kind: DispatchRouteKind,
    public_name: &str,
    prefix: Option<&str>,
    tenant_path: Option<String>,
) -> WorkerResult<DispatchTarget> {
    let public_name = normalize_worker_name(public_name)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker name".to_string()))?;
    let worker_name = prefixed_worker_name(&public_name, prefix)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker prefix".to_string()))?;
    Ok(DispatchTarget {
        route_kind,
        public_name,
        worker_name,
        tenant_path,
        authority: None,
    })
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct InternalDispatchRoute {
    public_name: String,
    tenant_path: String,
}

#[cfg(test)]
fn internal_dispatch_route(path: &str) -> Option<InternalDispatchRoute> {
    let rest = path.strip_prefix(INTERNAL_DISPATCH_PREFIX)?;
    let (script, tenant_path) = rest.split_once('/').unwrap_or((rest, ""));
    let tenant_path = normalize_tenant_dispatch_path(tenant_path);
    if tenant_path != crate::wfp_tenant::WFP_TENANT_STATUS_PATH {
        return None;
    }
    Some(InternalDispatchRoute {
        public_name: normalize_worker_name(script)?,
        tenant_path,
    })
}

#[cfg(test)]
fn internal_dispatch_script_name(path: &str) -> Option<String> {
    internal_dispatch_route(path).map(|route| route.public_name)
}

#[cfg(test)]
fn normalize_tenant_dispatch_path(value: &str) -> String {
    if value.is_empty() {
        "/".to_string()
    } else {
        format!("/{value}")
    }
}

#[cfg(test)]
fn preview_script_name_from_host(host: &str, suffix: &str) -> Option<String> {
    cinatoken_gateway::preview_tenant_name(host, suffix)
}

fn prefixed_worker_name(public_name: &str, prefix: Option<&str>) -> Option<String> {
    let prefix = prefix.unwrap_or_default().trim();
    if prefix.is_empty() {
        return Some(public_name.to_string());
    }
    if !prefix.chars().all(is_worker_name_char) {
        return None;
    }
    let worker_name = format!("{prefix}{public_name}");
    normalize_worker_name(&worker_name)
}

fn request_for_dispatch_target(req: Request, target: &DispatchTarget) -> WorkerResult<Request> {
    let mut url = req.url()?;
    if let Some(tenant_path) = target.tenant_path.as_deref() {
        url.set_path(tenant_path);
    }

    let headers = dispatch_forward_headers_for_target(req.headers(), target)?;
    let body = req.inner().body().map(JsValue::from);
    let mut init = RequestInit::new();
    init.with_method(req.method()).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(body));
    }
    Request::new_with_init(url.as_str(), &init)
}

fn internal_dispatch_requires_admin_auth(target: &DispatchTarget) -> bool {
    target.route_kind == DispatchRouteKind::InternalPath
}

fn dispatch_forward_headers(input: &Headers) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    for (name, value) in input {
        if should_forward_dispatch_request_header(&name) {
            headers.append(&name, &value)?;
        }
    }
    Ok(headers)
}

fn dispatch_forward_headers_for_target(
    input: &Headers,
    target: &DispatchTarget,
) -> WorkerResult<Headers> {
    let mut headers = dispatch_forward_headers(input)?;
    append_dispatch_platform_headers(&mut headers, target)?;
    Ok(headers)
}

fn append_dispatch_platform_headers(
    headers: &mut Headers,
    target: &DispatchTarget,
) -> WorkerResult<()> {
    let values = dispatch_platform_header_values(target);
    headers.set(WFP_ROUTE_REQUEST_HEADER, values.route)?;
    headers.set(WFP_WORKER_REQUEST_HEADER, values.worker)?;
    if let Some(authority) = values.authority {
        headers.set(cinatoken_wfp_authority::AUTHORITY_HEADER, authority)?;
    }
    Ok(())
}

struct DispatchPlatformHeaderValues<'a> {
    route: &'static str,
    worker: &'a str,
    authority: Option<&'a str>,
}

fn dispatch_platform_header_values(target: &DispatchTarget) -> DispatchPlatformHeaderValues<'_> {
    DispatchPlatformHeaderValues {
        route: target.route_kind.header_value(),
        worker: &target.public_name,
        authority: target.authority.as_deref(),
    }
}

fn should_forward_dispatch_request_header(name: &str) -> bool {
    !is_blocked_dispatch_request_header(name)
}

fn is_blocked_dispatch_request_header(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    BLOCKED_DISPATCH_REQUEST_HEADERS.contains(&name.as_str()) || name.starts_with("x-cinatoken-")
}

pub(crate) fn normalize_worker_name(value: &str) -> Option<String> {
    cinatoken_gateway::normalize_worker_name(value)
}

pub(crate) fn is_worker_name_char(ch: char) -> bool {
    cinatoken_gateway::is_worker_name_char(ch)
}

pub(crate) fn env_flag(env: &Env, name: &str) -> bool {
    runtime_value(env, name)
        .map(|value| matches!(value.as_str(), "true" | "1" | "yes" | "on"))
        .unwrap_or(false)
}

pub(crate) fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn secret_or_var(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| runtime_value(env, name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn relay_ai_gateway_rest_routes() -> Vec<&'static str> {
    MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS
        .iter()
        .fold(Vec::new(), |mut routes, plan| {
            let route = plan.rest_endpoint.relay_path();
            if !routes.contains(&route) {
                routes.push(route);
            }
            routes
        })
}

fn relay_ai_gateway_cutover_guards() -> Vec<&'static str> {
    MAIN_RELAY_AI_GATEWAY_CUTOVER_GUARDS.to_vec()
}

fn relay_ai_gateway_model_prefixes() -> Vec<&'static str> {
    AI_GATEWAY_MODEL_PROVIDERS
        .iter()
        .map(|provider| provider.prefix)
        .collect()
}

fn relay_ai_gateway_direct_fallback_prefixes() -> Vec<&'static str> {
    AI_GATEWAY_MODEL_PROVIDERS
        .iter()
        .filter(|provider| {
            provider.direct_model_policy == AiGatewayDirectModelPolicy::StripPrefix
                && !provider.direct_channel_types.is_empty()
        })
        .map(|provider| provider.prefix)
        .collect()
}

fn realtime_session_cutover_guards() -> Vec<&'static str> {
    REALTIME_SESSION_CUTOVER_GUARDS.to_vec()
}

fn quota_coordinator_cutover_guards() -> Vec<&'static str> {
    vec![
        "quota_coord_binding",
        "shadow_gate",
        "reservation_ledger_only",
        "observer_contract",
        "relay_observation",
        "bounded_retention",
        "shadow_reconciliation",
        "staging_shadow_bake",
        "write_authority",
    ]
}

fn quota_coordinator_shadow_runtime_ready(
    binding_available: bool,
    shadow_enabled: bool,
    foundation_compiled: bool,
    observer_contract_compiled: bool,
    relay_observation_compiled: bool,
    storage_retention_ready: bool,
    token_allowlist_configured: bool,
    token_allowlist_valid: bool,
    reservation_ledger_only: bool,
    write_authority_enabled: bool,
) -> bool {
    binding_available
        && shadow_enabled
        && foundation_compiled
        && observer_contract_compiled
        && relay_observation_compiled
        && storage_retention_ready
        && token_allowlist_configured
        && token_allowlist_valid
        && reservation_ledger_only
        && !write_authority_enabled
}

fn quota_coordinator_cutover_ready(
    binding_available: bool,
    foundation_compiled: bool,
    observer_contract_compiled: bool,
    relay_observation_compiled: bool,
    storage_retention_ready: bool,
    reservation_ledger_only: bool,
    staging_verified: bool,
    write_authority_enabled: bool,
) -> bool {
    binding_available
        && foundation_compiled
        && observer_contract_compiled
        && relay_observation_compiled
        && storage_retention_ready
        && reservation_ledger_only
        && staging_verified
        && write_authority_enabled
}

fn is_relay_model_fallback_ready(
    router_ready: bool,
    contract_compiled: bool,
    actual_group_billing_compiled: bool,
    terminal_audit_compiled: bool,
    enabled: bool,
    configured: bool,
    config_valid: bool,
) -> bool {
    router_ready
        && contract_compiled
        && actual_group_billing_compiled
        && terminal_audit_compiled
        && enabled
        && configured
        && config_valid
}

fn is_relay_model_fallback_cutover_ready(ready: bool, staging_verified: bool) -> bool {
    ready && staging_verified
}

fn is_relay_billing_orphan_recovery_cutover_ready(
    ready: bool,
    lease_renewal_staging_verified: bool,
    stream_error_usage_recovery_staging_verified: bool,
    finalization_runtime_ready: bool,
    finalization_replay_staging_verified: bool,
    prebind_owner_generation_cutover_ready: bool,
) -> bool {
    ready
        && lease_renewal_staging_verified
        && stream_error_usage_recovery_staging_verified
        && finalization_runtime_ready
        && finalization_replay_staging_verified
        && prebind_owner_generation_cutover_ready
}

#[allow(clippy::too_many_arguments)]
fn is_wfp_tenant_smoke_ready(
    dispatcher_bound: bool,
    dispatch_enabled: bool,
    internal_dispatch_enabled: bool,
    dispatch_failure_contract_compiled: bool,
    tenant_script_plan_compiled: bool,
    rust_wasm_runtime_compiled: bool,
    route_manifest_compiled: bool,
    internal_dispatch_required_compiled: bool,
    response_header_guard_compiled: bool,
    preview_response_security_headers_compiled: bool,
    ai_gateway_policy_compiled: bool,
    outbound_egress_policy_compiled: bool,
    outbound_private_ingress_config_compiled: bool,
) -> bool {
    dispatcher_bound
        && dispatch_enabled
        && internal_dispatch_enabled
        && dispatch_failure_contract_compiled
        && tenant_script_plan_compiled
        && rust_wasm_runtime_compiled
        && route_manifest_compiled
        && internal_dispatch_required_compiled
        && response_header_guard_compiled
        && preview_response_security_headers_compiled
        && ai_gateway_policy_compiled
        && outbound_egress_policy_compiled
        && outbound_private_ingress_config_compiled
}

fn is_wfp_relay_authority_transport_ready(
    dispatcher_bound: bool,
    dispatch_enabled: bool,
    relay_transport_enabled: bool,
    authority_secret_configured: bool,
    authority_replay_do_available: bool,
    authority_replay_do_compiled: bool,
    relay_transport_compiled: bool,
    rust_wasm_runtime_compiled: bool,
    route_manifest_compiled: bool,
    outbound_invocation_context_compiled: bool,
    outbound_authority_verifier_compiled: bool,
    outbound_replay_guard_compiled: bool,
    response_header_guard_compiled: bool,
    outbound_egress_policy_compiled: bool,
    outbound_private_ingress_config_compiled: bool,
) -> bool {
    dispatcher_bound
        && dispatch_enabled
        && relay_transport_enabled
        && authority_secret_configured
        && authority_replay_do_available
        && authority_replay_do_compiled
        && relay_transport_compiled
        && rust_wasm_runtime_compiled
        && route_manifest_compiled
        && outbound_invocation_context_compiled
        && outbound_authority_verifier_compiled
        && outbound_replay_guard_compiled
        && response_header_guard_compiled
        && outbound_egress_policy_compiled
        && outbound_private_ingress_config_compiled
}

fn is_realtime_session_platform_smoke_ready(
    do_available: bool,
    platform_gate_enabled: bool,
    hibernation_compiled: bool,
    metrics_persisted_compiled: bool,
    control_no_echo_compiled: bool,
    platform_header_boundary_compiled: bool,
    platform_admin_auth_compiled: bool,
) -> bool {
    do_available
        && platform_gate_enabled
        && hibernation_compiled
        && metrics_persisted_compiled
        && control_no_echo_compiled
        && platform_header_boundary_compiled
        && platform_admin_auth_compiled
}

#[allow(clippy::too_many_arguments)]
fn is_realtime_session_v1_cutover_ready(
    do_available: bool,
    v1_gate_enabled: bool,
    billing_settlement_write_enabled: bool,
    auth_boundary_compiled: bool,
    hibernation_compiled: bool,
    metrics_persisted_compiled: bool,
    control_no_echo_compiled: bool,
    upstream_channel_planner_compiled: bool,
    upstream_bridge_connect_contract_compiled: bool,
    upstream_connect_handoff_compiled: bool,
    upstream_fetch_upgrade_adapter_compiled: bool,
    upstream_bridge_lifecycle_compiled: bool,
    upstream_bridge_hibernation_fail_closed_compiled: bool,
    upstream_bridge_frame_guard_compiled: bool,
    upstream_bridge_close_mapping_compiled: bool,
    upstream_bridge_send_failure_guard_compiled: bool,
    upstream_bridge_event_trace_compiled: bool,
    upstream_bridge_replay_contract_compiled: bool,
    upstream_bridge_backpressure_policy_compiled: bool,
    upstream_bridge_backpressure_runtime_compiled: bool,
    upstream_usage_capture_compiled: bool,
    billing_presettlement_snapshot_compiled: bool,
    billing_settlement_preview_compiled: bool,
    billing_settlement_handoff_compiled: bool,
    billing_settlement_mutation_plan_compiled: bool,
    billing_settlement_writer_compiled: bool,
    billing_settlement_replay_marker_compiled: bool,
    billing_settlement_audit_log_compiled: bool,
    billing_settlement_batch_compiled: bool,
    billing_settlement_retry_compiled: bool,
    billing_reservation_lease_compiled: bool,
    billing_global_orphan_recovery_ready: bool,
    d1_migration_ready: bool,
    platform_header_boundary_compiled: bool,
    upstream_bridge_compiled: bool,
    billing_settlement_compiled: bool,
    billing_reconciliation_cutover_ready: bool,
) -> bool {
    do_available
        && v1_gate_enabled
        && billing_settlement_write_enabled
        && auth_boundary_compiled
        && hibernation_compiled
        && metrics_persisted_compiled
        && control_no_echo_compiled
        && upstream_channel_planner_compiled
        && upstream_bridge_connect_contract_compiled
        && upstream_connect_handoff_compiled
        && upstream_fetch_upgrade_adapter_compiled
        && upstream_bridge_lifecycle_compiled
        && upstream_bridge_hibernation_fail_closed_compiled
        && upstream_bridge_frame_guard_compiled
        && upstream_bridge_close_mapping_compiled
        && upstream_bridge_send_failure_guard_compiled
        && upstream_bridge_event_trace_compiled
        && upstream_bridge_replay_contract_compiled
        && upstream_bridge_backpressure_policy_compiled
        && upstream_bridge_backpressure_runtime_compiled
        && upstream_usage_capture_compiled
        && billing_presettlement_snapshot_compiled
        && billing_settlement_preview_compiled
        && billing_settlement_handoff_compiled
        && billing_settlement_mutation_plan_compiled
        && billing_settlement_writer_compiled
        && billing_settlement_replay_marker_compiled
        && billing_settlement_audit_log_compiled
        && billing_settlement_batch_compiled
        && billing_settlement_retry_compiled
        && billing_reservation_lease_compiled
        && billing_global_orphan_recovery_ready
        && d1_migration_ready
        && platform_header_boundary_compiled
        && upstream_bridge_compiled
        && billing_settlement_compiled
        && billing_reconciliation_cutover_ready
}

fn gateway_error(status: u16, code: &str, message: &str) -> WorkerResult<Response> {
    crate::json_with_status(
        &json!({
            "error": {
                "code": code,
                "message": message,
                "type": "platform_gateway_error"
            }
        }),
        status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduling_gateway_contract_is_operator_visible_and_tenant_first() {
        assert_eq!(SCHEDULING_GATEWAY_OWNER_CONTRACT_VERSION, 1);
        assert_eq!(
            SCHEDULING_GATEWAY_ROUTE_PRECEDENCE,
            &[
                "cors_preflight",
                "wfp_internal_dispatch",
                "wfp_preview_dispatch",
                "wfp_preview_unavailable",
                "gemini_native",
                "realtime_session",
                "static_assets",
                "api_router",
            ]
        );
        assert_eq!(
            crate::wfp_tenant::WFP_TENANT_STATUS_PATH,
            "/__cinatoken/tenant/status"
        );
    }

    #[test]
    fn wfp_dispatch_failures_follow_the_versioned_fail_closed_contract() {
        assert_eq!(WFP_DISPATCH_FAILURE_CONTRACT_VERSION, 1);
        assert_eq!(
            WFP_DISPATCH_FAILURE_CLASSES,
            &[
                "worker_not_found",
                "resource_limit_exceeded",
                "tenant_execution_failed",
            ]
        );
        assert_eq!(
            classify_wfp_dispatch_failure("Worker not found: tenant-a"),
            WfpDispatchFailureKind::WorkerNotFound
        );
        assert_eq!(
            classify_wfp_dispatch_failure(
                "Error: Error: Worker not found: tenant-a - Cause: Error: Worker not found"
            ),
            WfpDispatchFailureKind::WorkerNotFound
        );
        assert_eq!(
            classify_wfp_dispatch_failure("CPU time limit exceeded"),
            WfpDispatchFailureKind::ResourceLimitExceeded
        );
        assert_eq!(
            classify_wfp_dispatch_failure("Subrequest limit exceeded"),
            WfpDispatchFailureKind::ResourceLimitExceeded
        );
        assert_eq!(
            classify_wfp_dispatch_failure("secret-bearing tenant exception"),
            WfpDispatchFailureKind::TenantExecutionFailed
        );
        let preview_missing = wfp_dispatch_failure_contract(
            WfpDispatchFailureKind::WorkerNotFound,
            DispatchRouteKind::PreviewHost,
        );
        assert_eq!(preview_missing.0, 404);
        assert_eq!(preview_missing.1, "wfp_worker_not_found");
        let relay_missing = wfp_dispatch_failure_contract(
            WfpDispatchFailureKind::WorkerNotFound,
            DispatchRouteKind::RelayAuthority,
        );
        assert_eq!(relay_missing.0, 502);
        assert_eq!(relay_missing.1, "wfp_relay_worker_unavailable");
        let limited = wfp_dispatch_failure_contract(
            WfpDispatchFailureKind::ResourceLimitExceeded,
            DispatchRouteKind::PreviewHost,
        );
        assert_eq!(limited.0, 429);
        assert_eq!(limited.1, "wfp_worker_resource_limit_exceeded");
        let failed = wfp_dispatch_failure_contract(
            WfpDispatchFailureKind::TenantExecutionFailed,
            DispatchRouteKind::InternalPath,
        );
        assert_eq!(failed.0, 502);
        assert_eq!(failed.1, "wfp_worker_execution_failed");
        assert!(wfp_dispatch_failure_contract_compiled());
    }

    #[test]
    fn internal_dispatch_extracts_script_name_only() {
        assert_eq!(
            internal_dispatch_script_name(
                "/api/platform/dispatch/tenant-a/__cinatoken/tenant/status"
            )
            .as_deref(),
            Some("tenant-a")
        );
        assert_eq!(
            internal_dispatch_script_name(
                "/api/platform/dispatch/Tenant_1/__cinatoken/tenant/status"
            )
            .as_deref(),
            Some("tenant_1")
        );
        assert!(internal_dispatch_script_name("/api/platform/dispatch/../x").is_none());
        assert!(internal_dispatch_script_name("/api/platform/dispatch/-bad").is_none());
    }

    #[test]
    fn internal_dispatch_rewrites_to_tenant_visible_path() {
        let route =
            internal_dispatch_route("/api/platform/dispatch/tenant-a/__cinatoken/tenant/status")
                .unwrap();
        assert_eq!(route.public_name, "tenant-a");
        assert_eq!(route.tenant_path, "/__cinatoken/tenant/status");

        assert!(internal_dispatch_route("/api/platform/dispatch/tenant-a/v1/responses").is_none());
        assert!(internal_dispatch_route("/api/platform/dispatch/tenant-a").is_none());
    }

    #[test]
    fn only_operator_internal_dispatch_requires_admin_auth() {
        let internal = DispatchTarget {
            route_kind: DispatchRouteKind::InternalPath,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/__cinatoken/tenant/status".to_string()),
            authority: None,
        };
        assert!(internal_dispatch_requires_admin_auth(&internal));

        let preview = DispatchTarget {
            route_kind: DispatchRouteKind::PreviewHost,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: None,
            authority: None,
        };
        assert!(!internal_dispatch_requires_admin_auth(&preview));

        let relay = DispatchTarget {
            route_kind: DispatchRouteKind::RelayAuthority,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/v1/responses".to_string()),
            authority: Some("signed".to_string()),
        };
        assert!(!internal_dispatch_requires_admin_auth(&relay));
        assert_eq!(relay.route_kind.header_value(), "relay-authority");
    }

    #[test]
    fn dispatch_request_header_forwarding_strips_credentials_and_platform_markers() {
        for header in [
            "Authorization",
            "Cookie",
            "Proxy-Authorization",
            "X-Api-Key",
            "X-Goog-Api-Key",
            "Api-Key",
            "CF-Access-Client-Id",
            "CF-Access-Client-Secret",
            "X-Cinatoken-Smoke",
            "x-cinatoken-tenant",
            cinatoken_wfp_authority::AUTHORITY_HEADER,
        ] {
            assert!(
                !should_forward_dispatch_request_header(header),
                "expected {header} to be stripped before WFP dispatch"
            );
        }

        for header in ["Content-Type", "Accept", "User-Agent", "Traceparent"] {
            assert!(
                should_forward_dispatch_request_header(header),
                "expected {header} to be forwarded to WFP dispatch"
            );
        }
    }

    #[test]
    fn dispatch_request_header_forwarding_adds_controlled_platform_markers() {
        let target = DispatchTarget {
            route_kind: DispatchRouteKind::InternalPath,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/v1/responses".to_string()),
            authority: None,
        };

        let values = dispatch_platform_header_values(&target);

        assert_eq!(values.route, "internal-path");
        assert_eq!(values.worker, "tenant-a");
        assert_eq!(values.authority, None);
        assert!(!should_forward_dispatch_request_header(
            WFP_ROUTE_REQUEST_HEADER
        ));
        assert!(!should_forward_dispatch_request_header(
            WFP_WORKER_REQUEST_HEADER
        ));

        let relay = DispatchTarget {
            route_kind: DispatchRouteKind::RelayAuthority,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/v1/responses".to_string()),
            authority: Some("signed-envelope".to_string()),
        };
        let relay_values = dispatch_platform_header_values(&relay);
        assert_eq!(relay_values.route, "relay-authority");
        assert_eq!(relay_values.authority, Some("signed-envelope"));
    }

    #[test]
    fn preview_host_maps_single_label_subdomains() {
        assert_eq!(
            preview_script_name_from_host(
                "Tenant-A.preview.example.com:443",
                "preview.example.com"
            )
            .as_deref(),
            Some("tenant-a")
        );
        assert_eq!(
            preview_script_name_from_host("tenant-a.preview.example.com", ".preview.example.com")
                .as_deref(),
            Some("tenant-a")
        );
        assert!(
            preview_script_name_from_host("preview.example.com", "preview.example.com").is_none()
        );
        assert!(preview_script_name_from_host(
            "nested.tenant.preview.example.com",
            "preview.example.com"
        )
        .is_none());
    }

    #[test]
    fn worker_name_prefix_is_validated() {
        assert_eq!(
            prefixed_worker_name("tenant-a", Some("ct-")).as_deref(),
            Some("ct-tenant-a")
        );
        assert!(prefixed_worker_name("tenant-a", Some("bad.prefix.")).is_none());
        assert!(normalize_worker_name("").is_none());
        assert!(normalize_worker_name("bad/path").is_none());
    }

    #[test]
    fn relay_ai_gateway_rest_routes_match_compiled_main_relay_plan() {
        assert_eq!(
            relay_ai_gateway_rest_routes(),
            vec!["chat/completions", "responses", "messages"]
        );
    }

    #[test]
    fn relay_ai_gateway_cutover_guards_are_operator_visible() {
        assert!(relay_ai_gateway_cutover_guards().contains(&"router_ready"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"channel_opted_in"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"direct_provider_fallback"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"billing_settlement_invariant"));
    }

    #[test]
    fn flat_billing_parity_blockers_are_structured_and_operator_visible() {
        assert_eq!(
            RELAY_FLAT_BILLING_GO_PARITY_BLOCKERS,
            [
                "ali_async_image_task_settlement",
                "free_model_runtime_policy",
                "provider_usage_staging_reconciliation",
                "task_v2_durable_ownership",
                "subscription_funding_source_parity",
                "realtime_flat_billing_parity",
            ]
        );
    }

    #[test]
    fn relay_ai_gateway_model_registry_is_operator_visible() {
        let prefixes = relay_ai_gateway_model_prefixes();
        assert!(prefixes.contains(&"google-ai-studio/"));
        assert!(prefixes.contains(&"deepseek/"));
        assert!(prefixes.contains(&"@cf/"));

        let direct = relay_ai_gateway_direct_fallback_prefixes();
        assert!(direct.contains(&"deepseek/"));
        assert!(direct.contains(&"mistral/"));
        assert!(direct.contains(&"xai/"));
        assert!(!direct.contains(&"@cf/"));
        assert!(!direct.contains(&"cloudflare/"));
    }

    #[test]
    fn relay_ai_gateway_router_ready_requires_explicit_gate_and_config() {
        let configured = || Some("configured".to_string());
        assert!(
            crate::relay_ai_gateway_policy::relay_ai_gateway_runtime_config(
                true,
                configured(),
                configured(),
                configured(),
            )
            .is_some()
        );
        for missing in 0..4 {
            let mut values = [configured(), configured(), configured(), configured()];
            values[missing] = None;
            assert!(
                crate::relay_ai_gateway_policy::relay_ai_gateway_runtime_config(
                    values[0].is_some(),
                    values[1].clone(),
                    values[2].clone(),
                    values[3].clone(),
                )
                .is_none()
            );
        }
    }

    #[test]
    fn relay_billing_recovery_cutover_requires_stream_and_durable_replay_proofs() {
        assert!(is_relay_billing_orphan_recovery_cutover_ready(
            true, true, true, true, true, true
        ));
        for false_gate in 0..6 {
            let mut flags = [true; 6];
            flags[false_gate] = false;
            assert!(
                !is_relay_billing_orphan_recovery_cutover_ready(
                    flags[0], flags[1], flags[2], flags[3], flags[4], flags[5]
                ),
                "expected relay billing recovery cutover to wait on gate index {false_gate}"
            );
        }
    }

    #[test]
    fn relay_billing_finalization_runtime_requires_every_durable_boundary() {
        assert!(relay_billing_finalization_runtime_contract_ready(
            true, true, true, true, true, true, true, true
        ));
        for false_gate in 0..8 {
            let mut flags = [true; 8];
            flags[false_gate] = false;
            assert!(
                !relay_billing_finalization_runtime_contract_ready(
                    flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7]
                ),
                "expected billing finalization runtime to wait on gate index {false_gate}"
            );
        }
        assert!(relay_billing_finalization_consumer_compiled());
        assert!(relay_billing_finalization_dlq_contract_compiled());
        assert!(relay_billing_finalization_replay_compiled());
        assert!(relay_billing_finalization_dlq_consumer_compiled());
        assert!(relay_billing_finalization_reconcile_compiled());
    }

    #[test]
    fn relay_model_fallback_readiness_requires_every_runtime_and_replay_gate() {
        assert!(relay_model_fallback_contract_compiled());
        assert!(relay_messages_model_fallback_contract_compiled());
        assert!(relay_actual_serving_group_billing_contract_compiled());
        assert!(smoke_compiled());
        assert!(relay_terminal_attempt_audit_contract_compiled());
        assert!(is_relay_model_fallback_ready(
            true, true, true, true, true, true, true
        ));
        for false_gate in 0..7 {
            let mut flags = [true; 7];
            flags[false_gate] = false;
            assert!(
                !is_relay_model_fallback_ready(
                    flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6]
                ),
                "expected model fallback readiness to wait on gate index {false_gate}"
            );
        }
        assert!(!is_relay_model_fallback_cutover_ready(true, false));
        assert!(is_relay_model_fallback_cutover_ready(true, true));
        for guard in [
            "router_ready",
            "fallback_gate",
            "validated_mapping",
            "messages_schema_compatibility",
            "token_model_limit_recheck",
            "fallback_channel_reselection",
            "fallback_billing_rereservation",
            "actual_serving_group_billing",
            "server_failure_only",
            "provider_native_direct_body",
            "model_route_audit",
            "terminal_attempt_audit",
            "staging_replay",
            "messages_staging_replay",
        ] {
            assert!(
                RELAY_MODEL_FALLBACK_CUTOVER_GUARDS.contains(&guard),
                "missing model fallback guard {guard}"
            );
        }
    }

    #[test]
    fn wfp_tenant_capability_contract_is_operator_visible() {
        let routes = wfp_tenant_supported_routes();
        for route in [
            "/__cinatoken/tenant/status",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/messages",
            "/ai/run",
        ] {
            assert!(routes.contains(&route), "missing WFP tenant route {route}");
        }

        let guards = wfp_tenant_cutover_guards();
        for guard in [
            "dispatcher_binding",
            "dispatch_gate",
            "dispatch_failure_contract",
            "relay_transport_gate",
            "internal_dispatch_gate",
            "central_relay_authority",
            "signed_body_bound_authority",
            "authority_replay_do",
            "central_master_only_authority",
            "outbound_invocation_context",
            "outbound_worker_egress_policy",
            "outbound_worker_token_injection",
            "no_tenant_cloudflare_token",
            "tenant_script_plan",
            "rust_wasm_runtime",
            "rust_wasm_artifact_validation",
            "route_manifest",
            "internal_dispatch_required",
            "request_header_scrub",
            "response_header_allowlist",
            "preview_response_security_headers",
            "ai_gateway_policy_headers",
            "outbound_owned_ai_gateway_policy",
            "signed_dispatch_worker",
            "central_billing_settlement",
            "tenant_status_smoke",
            "relay_authority_staging_replay",
        ] {
            assert!(guards.contains(&guard), "missing WFP tenant guard {guard}");
        }

        assert!(wfp_tenant_script_plan_compiled());
        assert!(wfp_tenant_rust_wasm_runtime_compiled());
        assert!(wfp_tenant_route_manifest_compiled());
        assert!(wfp_tenant_internal_dispatch_required_compiled());
        assert!(wfp_outbound_invocation_context_contract_compiled());
        assert!(wfp_outbound_authority_verifier_compiled());
        assert!(wfp_outbound_replay_guard_compiled());
        assert!(wfp_authority_replay_contract_compiled());
        assert!(wfp_tenant_response_header_guard_compiled());
        assert!(wfp_preview_response_security_headers_compiled());
        assert!(wfp_tenant_ai_gateway_policy_compiled());
        assert!(wfp_outbound_egress_policy_compiled());
        assert!(wfp_outbound_private_ingress_config_compiled());
    }

    #[test]
    fn wfp_tenant_smoke_ready_requires_binding_gate_and_contracts() {
        assert!(wfp_tenant_smoke_ready_with_flags([true; 13]));

        for false_gate in 0..13 {
            let mut flags = [true; 13];
            flags[false_gate] = false;
            assert!(
                !wfp_tenant_smoke_ready_with_flags(flags),
                "expected WFP tenant smoke readiness to wait on gate index {false_gate}"
            );
        }
    }

    #[test]
    fn preview_response_security_headers_apply_only_to_regular_preview_http() {
        assert!(wfp_preview_response_security_headers_compiled());
        assert!(should_strip_preview_response_security_headers(
            DispatchRouteKind::PreviewHost,
            200,
            None,
        ));
        assert!(!should_strip_preview_response_security_headers(
            DispatchRouteKind::PreviewHost,
            101,
            Some("websocket"),
        ));
        assert!(!should_strip_preview_response_security_headers(
            DispatchRouteKind::PreviewHost,
            200,
            Some("WebSocket"),
        ));
        assert!(!should_strip_preview_response_security_headers(
            DispatchRouteKind::InternalPath,
            200,
            None,
        ));
        assert!(!should_strip_preview_response_security_headers(
            DispatchRouteKind::RelayAuthority,
            200,
            None,
        ));
    }

    #[test]
    fn wfp_relay_authority_readiness_requires_every_transport_boundary() {
        assert!(relay_wfp_authority_transport_contract_compiled());
        assert!(wfp_relay_authority_ready_with_flags([true; 15]));
        for false_gate in 0..15 {
            let mut flags = [true; 15];
            flags[false_gate] = false;
            assert!(
                !wfp_relay_authority_ready_with_flags(flags),
                "expected WFP relay authority readiness to wait on gate index {false_gate}"
            );
        }
    }

    #[test]
    fn task_poller_timeout_sweep_is_operator_visible() {
        assert!(task_timeout_sweep_compiled());
        assert!(task_refund_cas_batch_compiled());
        assert!(task_refund_replay_contract_compiled());
    }

    #[test]
    fn task_runner_alarm_foundation_is_operator_visible_but_not_cutover_ready() {
        assert!(task_runner_do_foundation_compiled());
        assert!(task_runner_alarm_contract_compiled());
        assert!(task_runner_storage_error_retry_contract_compiled());
        assert!(task_runner_rearm_contract_compiled());
        assert!(task_runner_submit_path_compiled());
        assert!(task_runner_poll_path_compiled());
        assert!(task_runner_status_probe_compiled());
        let guards = task_runner_cutover_guards();
        assert!(guards.contains(&"task_runner_binding"));
        assert!(guards.contains(&"alarm_contract"));
        assert!(guards.contains(&"storage_error_retry"));
        assert!(guards.contains(&"nonterminal_rearm"));
        assert!(guards.contains(&"failure_backoff"));
        assert!(guards.contains(&"fast_path_horizon"));
        assert!(guards.contains(&"submit_path_armed"));
        assert!(guards.contains(&"cron_sweeper_fallback"));
        assert!(guards.contains(&"generation_fenced_poll_lease"));
        assert!(guards.contains(&"poll_lease_cutover"));
        assert!(guards.contains(&"persisted_poll_schedule"));
        assert!(guards.contains(&"poll_scheduler_cutover"));
        assert!(guards.contains(&"status_probe"));
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, true, true, true, true, false, true, true
        ));
    }

    #[test]
    fn quota_coordinator_foundation_is_visible_without_runtime_or_cutover_claims() {
        assert!(quota_coordinator_foundation_compiled());
        assert!(quota_coordinator_observer_contract_compiled());
        assert!(quota_coordinator_retention_compaction_compiled());
        let guards = quota_coordinator_cutover_guards();
        for guard in [
            "quota_coord_binding",
            "shadow_gate",
            "reservation_ledger_only",
            "observer_contract",
            "relay_observation",
            "bounded_retention",
            "shadow_reconciliation",
            "staging_shadow_bake",
            "write_authority",
        ] {
            assert!(guards.contains(&guard));
        }
        assert!(!quota_coordinator_shadow_runtime_ready(
            true, true, true, true, false, true, true, true, true, false,
        ));
        assert!(!quota_coordinator_shadow_runtime_ready(
            true, true, true, true, true, true, false, true, true, false,
        ));
        assert!(!quota_coordinator_shadow_runtime_ready(
            true, true, true, true, true, false, true, true, true, false,
        ));
        assert!(quota_coordinator_shadow_runtime_ready(
            true, true, true, true, true, true, true, true, true, false,
        ));
        assert!(!quota_coordinator_cutover_ready(
            true, true, true, false, true, true, true, true,
        ));
        assert!(!quota_coordinator_cutover_ready(
            true, true, true, true, false, true, true, true,
        ));
        assert!(quota_coordinator_cutover_ready(
            true, true, true, true, true, true, true, true,
        ));
    }

    #[test]
    fn realtime_session_cutover_guards_expose_remaining_blockers() {
        let guards = realtime_session_cutover_guards();
        assert!(guards.contains(&"platform_gateway_gate"));
        assert!(guards.contains(&"platform_admin_auth"));
        assert!(guards.contains(&"v1_gateway_gate"));
        assert!(guards.contains(&"relay_token_auth"));
        assert!(guards.contains(&"relay_rate_limits"));
        assert!(guards.contains(&"upstream_fetch_upgrade_adapter"));
        assert!(guards.contains(&"upstream_bridge_lifecycle"));
        assert!(guards.contains(&"upstream_bridge_hibernation_fail_closed"));
        assert!(guards.contains(&"upstream_bridge_frame_guard"));
        assert!(guards.contains(&"upstream_bridge_close_mapping"));
        assert!(guards.contains(&"upstream_bridge_send_failure_guard"));
        assert!(guards.contains(&"upstream_bridge_event_trace"));
        assert!(guards.contains(&"upstream_bridge_replay_contract"));
        assert!(guards.contains(&"upstream_bridge_backpressure_policy"));
        assert!(guards.contains(&"upstream_bridge_backpressure_runtime"));
        assert!(guards.contains(&"upstream_usage_capture"));
        assert!(guards.contains(&"billing_presettlement_snapshot"));
        assert!(guards.contains(&"billing_settlement_preview"));
        assert!(guards.contains(&"billing_settlement_handoff"));
        assert!(guards.contains(&"billing_settlement_mutation_plan"));
        assert!(guards.contains(&"billing_settlement_writer"));
        assert!(guards.contains(&"billing_settlement_replay_marker"));
        assert!(guards.contains(&"billing_settlement_audit_log"));
        assert!(guards.contains(&"billing_settlement_batch"));
        assert!(guards.contains(&"billing_global_orphan_recovery"));
        assert!(guards.contains(&"platform_upstream_header_boundary"));
        assert!(guards.contains(&"hibernation_attachment_restore"));
        assert!(guards.contains(&"metadata_only_control_frames"));
        assert!(guards.contains(&"upstream_bridge"));
        assert!(guards.contains(&"billing_settlement"));
    }

    #[test]
    fn realtime_settlement_staging_smoke_contract_is_operator_visible() {
        assert!(realtime_settlement_staging_smoke_compiled());
        let scenarios = realtime_settlement_smoke_scenarios()
            .into_iter()
            .map(RealtimeSettlementSmokeScenario::name)
            .collect::<Vec<_>>();
        assert_eq!(
            scenarios,
            vec![
                "additional-quota-applied",
                "duplicate-replay-noop",
                "guarded-update-rollback",
                "audit-failure-rollback",
                "refund-delta-applied",
                "tokenless-applied",
            ]
        );

        let duplicate = RealtimeSettlementSmokeScenario::DuplicateReplayNoop.fixture();
        assert_eq!(
            duplicate.expected_outcomes(),
            vec!["Applied", "DuplicateReplay"]
        );
        let tokenless = RealtimeSettlementSmokeScenario::TokenlessApplied.fixture();
        let expected = tokenless.expected_snapshot(1_800_100_000);
        assert_eq!(expected.token_remain_quota, None);
        assert_eq!(expected.user_quota, 870);
        assert_eq!(expected.replay_rows, 1);
        assert_eq!(expected.log_rows, 1);
    }

    #[test]
    fn d1_migration_readiness_requires_the_current_schema_marker() {
        let expected: Vec<String> = EXPECTED_D1_MIGRATIONS
            .iter()
            .map(|name| (*name).to_string())
            .collect();
        assert!(d1_migration_set_matches(&expected));
        assert!(d1_migration_ready(true, true));
        assert!(!d1_migration_ready(false, true));
        assert!(!d1_migration_ready(true, false));

        let mut missing = expected.clone();
        missing.remove(0);
        assert!(!d1_migration_set_matches(&missing));

        let mut substituted = expected.clone();
        substituted[0] = "0001_unexpected.sql".to_string();
        assert!(!d1_migration_set_matches(&substituted));

        let mut extra = expected;
        extra.push("0023_unexpected.sql".to_string());
        assert!(!d1_migration_set_matches(&extra));
        assert_eq!(
            EXPECTED_D1_MIGRATION,
            "0045_relay_container_reconciliation_retry_apply.sql"
        );
        assert!(
            include_str!("../../../migrations/d1/0018_realtime_settlement_replays.sql")
                .contains("CREATE TABLE IF NOT EXISTS realtime_settlement_replays")
        );
        assert!(
            include_str!("../../../migrations/d1/0019_realtime_billing_reservations.sql")
                .contains("CREATE TABLE IF NOT EXISTS realtime_billing_reservations")
        );
        assert!(include_str!(
            "../../../migrations/d1/0020_realtime_billing_reservation_leases.sql"
        )
        .contains("lease_expires_at"));
        assert!(
            include_str!("../../../migrations/d1/0021_realtime_billing_bridge_segments.sql")
                .contains("bridge_segment")
        );
        let recovery =
            include_str!("../../../migrations/d1/0022_realtime_billing_global_recovery.sql");
        assert!(recovery.contains("idx_realtime_billing_reservations_global_lease"));
        assert!(recovery.contains("idx_realtime_billing_reservations_recent_outcome"));
        let relay_reservations =
            include_str!("../../../migrations/d1/0023_relay_billing_reservations.sql");
        assert!(
            relay_reservations.contains("CREATE TABLE IF NOT EXISTS relay_billing_reservations")
        );
        assert!(relay_reservations.contains("idx_relay_billing_reservations_global_lease"));
        let relay_finalization =
            include_str!("../../../migrations/d1/0024_relay_billing_finalization_events.sql");
        assert!(relay_finalization.contains("billing_finalization_event_id"));
        assert!(relay_finalization.contains("CREATE UNIQUE INDEX"));
        let relay_incidents =
            include_str!("../../../migrations/d1/0025_relay_billing_finalization_incidents.sql");
        assert!(relay_incidents.contains("CREATE TABLE relay_billing_finalization_incidents"));
        assert!(relay_incidents.contains("replay_generation"));
        assert!(relay_incidents.contains("idx_relay_billing_finalization_incidents_event"));
        let relay_owner_generation =
            include_str!("../../../migrations/d1/0026_relay_billing_owner_generation.sql");
        assert!(relay_owner_generation.contains("CHECK (active_count = 0)"));
        assert!(relay_owner_generation.contains("ADD COLUMN owner_generation"));
        let realtime_usage_reconciliation =
            include_str!("../../../migrations/d1/0027_realtime_usage_reconciliation.sql");
        assert!(realtime_usage_reconciliation.contains("finalization_owner"));
        assert!(realtime_usage_reconciliation.contains("usage_reconciliation"));
        assert!(realtime_usage_reconciliation.contains("last_recovery_required"));
        let realtime_usage_resolution = include_str!(
            "../../../migrations/d1/0028_realtime_usage_reconciliation_resolution.sql"
        );
        assert!(realtime_usage_resolution.contains("reconciliation_id"));
        assert!(realtime_usage_resolution.contains("reconciliation_revision"));
        assert!(realtime_usage_resolution.contains("idx_realtime_billing_reconciliation_id"));
        let flat_billing_intents =
            include_str!("../../../migrations/d1/0029_flat_billing_intents.sql");
        assert!(flat_billing_intents.contains("ADD COLUMN billing_kind"));
        assert!(flat_billing_intents.contains("ADD COLUMN billing_snapshot_json"));
        assert!(flat_billing_intents.contains("relay_flat_billing_snapshot_insert_guard"));
        assert!(flat_billing_intents.contains("relay_flat_billing_snapshot_update_guard"));
        let billing_contract_immutability =
            include_str!("../../../migrations/d1/0030_billing_contract_immutability.sql");
        assert!(billing_contract_immutability.contains("relay_billing_contract_immutable_guard"));
        let task_billing_intents =
            include_str!("../../../migrations/d1/0031_task_billing_intents.sql");
        assert!(task_billing_intents.contains("submit_unknown"));
        assert!(task_billing_intents.contains("task_billing_intent_refund_guard"));
        assert!(task_billing_intents
            .contains("ON task_billing_intents(task_kind, channel_id, provider_task_id)"));
        let task_submit_reconciliation =
            include_str!("../../../migrations/d1/0032_task_submit_reconciliation.sql");
        assert!(task_submit_reconciliation.contains("attach_contract_json"));
        assert!(task_submit_reconciliation.contains("task_billing_reconciliation_events"));
        assert!(task_submit_reconciliation.contains("task_billing_intent_reconciliation_guard"));
        assert!(
            task_submit_reconciliation.contains("task_billing_reconciliation_event_delete_guard")
        );
        let task_submit_reconciliation_enforce =
            include_str!("../../../migrations/d1/0033_task_submit_reconciliation_enforce.sql");
        assert!(task_submit_reconciliation_enforce.contains("attach_contract_json = '{}'"));
        assert!(task_submit_reconciliation_enforce
            .contains("DROP TRIGGER task_billing_intent_reconciliation_expand_backfill"));
        let task_submit_operation_expand =
            include_str!("../../../migrations/d1/0038_task_submit_operation_expand.sql");
        let task_submit_operation_enforce =
            include_str!("../../../migrations/d1/0039_task_submit_operation_enforce.sql");
        assert!(task_submit_operation_expand.contains("ADD COLUMN submit_deadline_at"));
        assert!(
            task_submit_operation_expand.contains("idx_task_billing_intents_provider_operation")
        );
        assert!(task_submit_operation_enforce
            .contains("task_billing_intent_submit_operation_immutable_guard"));
        let relay_container_operations =
            include_str!("../../../migrations/d1/0040_relay_container_operations.sql");
        assert!(relay_container_operations
            .contains("CREATE TABLE IF NOT EXISTS relay_container_operations"));
        assert!(relay_container_operations
            .contains("relay_container_operation_identity_immutable_guard"));
        assert!(relay_container_operations.contains("idx_relay_container_operations_recovery"));
        let relay_container_operation_lifecycle_hardening = include_str!(
            "../../../migrations/d1/0041_relay_container_operation_lifecycle_hardening.sql"
        );
        assert!(relay_container_operation_lifecycle_hardening
            .contains("DROP TRIGGER relay_container_operation_lifecycle_guard"));
        assert!(relay_container_operation_lifecycle_hardening
            .contains("OLD.status IN ('completed', 'failed')"));
        assert!(relay_container_operation_lifecycle_hardening.contains("NEW.status = OLD.status"));
        let relay_container_financial_terminal = include_str!(
            "../../../migrations/d1/0042_relay_container_financial_terminal_expand.sql"
        );
        assert!(relay_container_financial_terminal
            .contains("CREATE TABLE relay_container_terminal_events"));
        assert!(relay_container_financial_terminal
            .contains("CREATE TABLE relay_container_terminal_outbox_state"));
        assert!(relay_container_financial_terminal.contains("client_idempotency_hmac_sha256"));
        let relay_container_reconciliation_observer =
            include_str!("../../../migrations/d1/0043_relay_container_reconciliation_observer.sql");
        assert!(relay_container_reconciliation_observer
            .contains("CREATE TABLE relay_container_reconciliation_observations"));
        assert!(relay_container_reconciliation_observer
            .contains("CREATE TABLE relay_container_reconciliation_cursor"));
        assert!(relay_container_reconciliation_observer.contains("operation_observer_v1"));
        assert!(relay_container_reconciliation_observer.contains("run_generation"));
        assert!(relay_container_reconciliation_observer.contains("run_lease_expires_at"));
        assert!(relay_container_reconciliation_observer.contains("last_success_at"));
        let relay_container_r2_inventory =
            include_str!("../../../migrations/d1/0044_relay_container_r2_orphan_inventory.sql");
        assert!(relay_container_r2_inventory
            .contains("CREATE TABLE relay_container_r2_inventory_cursors"));
        assert!(relay_container_r2_inventory
            .contains("CREATE TABLE relay_container_r2_inventory_findings"));
        assert!(relay_container_r2_inventory.contains("distinct_scan_generations >= 2"));
        assert!(relay_container_r2_inventory
            .contains("relay_container_r2_inventory_finding_delete_guard"));
        let relay_container_reconciliation_retry = include_str!(
            "../../../migrations/d1/0045_relay_container_reconciliation_retry_apply.sql"
        );
        assert!(relay_container_reconciliation_retry
            .contains("CREATE TABLE relay_container_reconciliation_retry_events"));
        assert!(relay_container_reconciliation_retry
            .contains("relay_container_reconciliation_retry_event_insert_guard"));
        assert!(relay_container_reconciliation_retry
            .contains("relay_container_reconciliation_retry_event_apply"));
    }

    #[test]
    fn relay_ledger_status_hashes_private_reservation_and_account_identity() {
        let metadata = relay_billing_ledger_status_metadata(
            crate::d1_repositories::RelayBillingLedgerStatusRow {
                reservation_key: "private-relay-reservation".to_string(),
                user_id: 123,
                token_id: 456,
                status: "recovery_required".to_string(),
                channel_id: 7,
                selected_at: 800,
                request_accounted: 0,
                lease_expires_at: 900,
                updated_at: 1_201,
                settled_at: 0,
                refunded_at: 0,
                recovery_required_at: 1_201,
                recovery_attempt_count: 1,
                recovery_next_attempt_at: 0,
                recovery_last_attempt_at: 1_201,
            },
            1_201,
        );
        let encoded = serde_json::to_string(&metadata).unwrap();
        assert!(!encoded.contains("private-relay-reservation"));
        assert!(!encoded.contains("123|456"));
        assert!(metadata.reservation_fingerprint.starts_with("sha256:"));
        assert!(metadata.account_scope_fingerprint.starts_with("sha256:"));
        assert_ne!(
            metadata.reservation_fingerprint,
            metadata.account_scope_fingerprint
        );
        assert_eq!(
            metadata.outcome,
            RelayBillingLedgerOutcome::RecoveryRequired
        );
        assert!(!metadata.terminal);
        assert!(metadata.selected);
        assert!(!metadata.request_accounted);
        assert_eq!(metadata.recovery_required_at, Some(1_201));
        assert_eq!(
            metadata.recovery_state,
            RelayBillingRecoveryState::ManualReconciliation
        );
        assert_eq!(
            relay_billing_ledger_outcome("unexpected"),
            RelayBillingLedgerOutcome::Unknown
        );
    }

    #[test]
    fn realtime_ledger_status_hashes_private_reservation_and_bridge_identity() {
        let metadata = realtime_billing_ledger_status_metadata(
            crate::d1_repositories::RealtimeBillingLedgerStatusRow {
                reservation_key: "private-reservation".to_string(),
                session: "private-session".to_string(),
                bridge_segment: "private-segment".to_string(),
                status: "refunded".to_string(),
                reservation_sequence: 7,
                lease_expires_at: 900,
                updated_at: 901,
                settled_at: 0,
                refunded_at: 901,
                recovery_attempt_count: 2,
                recovery_next_attempt_at: 0,
                recovery_last_attempt_at: 899,
                finalization_owner: String::new(),
                finalization_reason: String::new(),
                finalization_required_at: 0,
                reconciliation_id: "a".repeat(64),
                reconciliation_revision: 2,
                reconciliation_resolution: "refunded".to_string(),
                reconciliation_resolution_key: "private-resolution-key".to_string(),
                reconciliation_resolved_at: 901,
                reconciliation_operator_id: 42,
                reconciliation_evidence_sha256: "private-evidence-hash".to_string(),
            },
            901,
        );
        let encoded = serde_json::to_string(&metadata).unwrap();
        assert!(!encoded.contains("private-reservation"));
        assert!(!encoded.contains("private-session"));
        assert!(!encoded.contains("private-segment"));
        assert!(!encoded.contains("private-resolution-key"));
        assert!(!encoded.contains("private-evidence-hash"));
        assert!(metadata.reservation_fingerprint.starts_with("sha256:"));
        assert!(metadata.scope_fingerprint.starts_with("sha256:"));
        assert_ne!(metadata.reservation_fingerprint, metadata.scope_fingerprint);
        assert_eq!(metadata.scope_kind, "realtime_bridge_segment");
        assert_eq!(metadata.outcome, RealtimeBillingLedgerOutcome::Refunded);
        assert!(metadata.terminal);
        assert_eq!(metadata.settled_at, None);
        assert_eq!(metadata.refunded_at, Some(901));
        assert_eq!(metadata.recovery_attempt_count, 2);
        assert_eq!(
            metadata.recovery_state,
            RealtimeBillingRecoveryState::Terminal
        );
        assert_eq!(
            realtime_billing_ledger_outcome("unexpected", ""),
            RealtimeBillingLedgerOutcome::Unknown
        );
    }

    #[test]
    fn realtime_platform_smoke_ready_requires_do_gate_and_safe_control_surface() {
        assert!(is_realtime_session_platform_smoke_ready(
            true, true, true, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            false, true, true, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, false, true, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, false, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, true, false, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, true, true, false, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, true, true, true, false
        ));
    }

    #[test]
    fn realtime_v1_cutover_ready_requires_every_runtime_and_environment_gate() {
        assert!(realtime_v1_ready_with_flags([true; 37]));

        for false_gate in 0..37 {
            let mut flags = [true; 37];
            flags[false_gate] = false;
            assert!(
                !realtime_v1_ready_with_flags(flags),
                "expected realtime v1 cutover to wait on gate index {false_gate}"
            );
        }
    }

    fn realtime_v1_ready_with_flags(flags: [bool; 37]) -> bool {
        is_realtime_session_v1_cutover_ready(
            flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
            flags[8], flags[9], flags[10], flags[11], flags[12], flags[13], flags[14], flags[15],
            flags[16], flags[17], flags[18], flags[19], flags[20], flags[21], flags[22], flags[23],
            flags[24], flags[25], flags[26], flags[27], flags[28], flags[29], flags[30], flags[31],
            flags[32], flags[33], flags[34], flags[35], flags[36],
        )
    }

    fn wfp_tenant_smoke_ready_with_flags(flags: [bool; 13]) -> bool {
        is_wfp_tenant_smoke_ready(
            flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
            flags[8], flags[9], flags[10], flags[11], flags[12],
        )
    }

    fn wfp_relay_authority_ready_with_flags(flags: [bool; 15]) -> bool {
        is_wfp_relay_authority_transport_ready(
            flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
            flags[8], flags[9], flags[10], flags[11], flags[12], flags[13], flags[14],
        )
    }
}
