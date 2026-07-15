/*
Copyright (C) 2023-2026 CinaGroup

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@cinagroup.com
*/
import type { PlatformCapabilities } from '../types'

export type PlatformReadinessStageId =
  | 'implementation'
  | 'configuration'
  | 'smoke'
  | 'cutover'

export type PlatformReadinessSignalId =
  | 'scheduling-gateway-implementation'
  | 'ai-gateway-implementation'
  | 'wfp-tenant-implementation'
  | 'relay-billing-implementation'
  | 'relay-flat-billing-intent-implementation'
  | 'relay-billing-owner-generation-compiled'
  | 'quota-coordinator-foundation'
  | 'quota-coordinator-relay-observer'
  | 'realtime-implementation'
  | 'realtime-billing-reconciliation-implementation'
  | 'task-runner-implementation'
  | 'ai-gateway-runtime'
  | 'ai-gateway-fallback-runtime'
  | 'wfp-tenant-runtime'
  | 'realtime-runtime'
  | 'realtime-billing-reconciliation-runtime'
  | 'task-runner-runtime'
  | 'quota-coordinator-binding'
  | 'quota-coordinator-shadow-runtime'
  | 'quota-coordinator-reconciliation'
  | 'relay-flat-billing-intent-runtime'
  | 'relay-billing-owner-generation-configured'
  | 'ai-gateway-canary'
  | 'ai-gateway-actual-group-billing-smoke'
  | 'ai-gateway-fallback-replay'
  | 'wfp-tenant-smoke'
  | 'wfp-relay-authority-smoke'
  | 'realtime-smoke'
  | 'realtime-billing-reconciliation-staging-proof'
  | 'task-runner-replay'
  | 'quota-coordinator-staging-bake'
  | 'relay-billing-stream-error-smoke'
  | 'relay-billing-finalization-replay'
  | 'relay-billing-recovery-smoke'
  | 'relay-flat-billing-intent-staging-proof'
  | 'relay-billing-owner-generation-staging-proof'
  | 'task-runner-cutover'
  | 'relay-billing-recovery-cutover'
  | 'relay-flat-billing-intent-cutover'
  | 'relay-billing-owner-generation-cutover'
  | 'quota-coordinator-write-authority'
  | 'quota-coordinator-cutover'
  | 'ai-gateway-fallback-cutover'
  | 'realtime-v1-cutover'
  | 'realtime-billing-reconciliation-cutover'

export type PlatformReadinessSignalStatus =
  | 'ready'
  | 'blocked'
  | 'ready-to-verify'
  | 'verified'

export type PlatformReadinessCapabilities = Pick<
  PlatformCapabilities,
  | 'scheduling_gateway_compiled'
  | 'scheduling_gateway_active'
  | 'scheduling_gateway_route_precedence'
  | 'scheduling_gateway_preview_fail_closed_compiled'
  | 'd1_migration_ready'
  | 'relay_billing_reservation_ledger_compiled'
  | 'relay_billing_ledger_status_compiled'
  | 'relay_flat_billing_intent_contract_version'
  | 'relay_flat_billing_intent_compiled'
  | 'relay_flat_billing_intent_schema_ready'
  | 'relay_flat_billing_intent_runtime_ready'
  | 'relay_flat_billing_go_parity_ready'
  | 'relay_flat_billing_go_parity_blockers'
  | 'relay_flat_billing_intent_staging_verified'
  | 'relay_flat_billing_intent_cutover_ready'
  | 'relay_billing_prebind_owner_generation_compiled'
  | 'relay_billing_prebind_owner_generation_configured'
  | 'relay_billing_prebind_owner_generation_staging_verified'
  | 'relay_billing_prebind_owner_generation_cutover_ready'
  | 'relay_billing_stream_lease_renewal_compiled'
  | 'relay_billing_stream_lease_heartbeat_configured'
  | 'relay_billing_stream_lease_heartbeat_valid'
  | 'relay_billing_stream_error_usage_recovery_compiled'
  | 'relay_billing_stream_error_usage_recovery_staging_verified'
  | 'relay_billing_missing_usage_estimate_enabled'
  | 'relay_billing_finalization_queue_enabled'
  | 'relay_billing_finalization_queue_available'
  | 'relay_billing_finalization_consumer_compiled'
  | 'relay_billing_finalization_dlq_contract_compiled'
  | 'relay_billing_finalization_dlq_consumer_compiled'
  | 'relay_billing_finalization_replay_compiled'
  | 'relay_billing_finalization_reconcile_compiled'
  | 'relay_billing_finalization_reconcile_enabled'
  | 'relay_billing_finalization_reconcile_ready'
  | 'relay_billing_finalization_runtime_ready'
  | 'relay_billing_finalization_replay_staging_verified'
  | 'relay_billing_orphan_recovery_ready'
  | 'relay_billing_stream_lease_renewal_staging_verified'
  | 'relay_billing_orphan_recovery_cutover_ready'
  | 'relay_ai_gateway_router_ready'
  | 'relay_ai_gateway_rest_routes'
  | 'relay_ai_gateway_model_prefixes'
  | 'relay_ai_gateway_direct_fallback_prefixes'
  | 'relay_ai_gateway_cutover_guards'
  | 'relay_ai_gateway_channel_opt_in_supported'
  | 'relay_ai_gateway_rest_forwarder_compiled'
  | 'relay_ai_gateway_same_channel_fallback_compiled'
  | 'relay_ai_gateway_cross_model_fallback_compiled'
  | 'relay_ai_gateway_messages_cross_model_fallback_compiled'
  | 'relay_ai_gateway_messages_cross_model_fallback_staging_verified'
  | 'relay_ai_gateway_messages_cross_model_fallback_cutover_ready'
  | 'relay_ai_gateway_cross_model_actual_group_billing_compiled'
  | 'relay_ai_gateway_actual_group_billing_staging_smoke_compiled'
  | 'relay_ai_gateway_actual_group_billing_staging_smoke_enabled'
  | 'relay_ai_gateway_actual_group_billing_staging_smoke_ready'
  | 'relay_ai_gateway_cross_model_terminal_audit_compiled'
  | 'relay_ai_gateway_cross_model_fallback_ready'
  | 'relay_ai_gateway_cross_model_fallback_staging_verified'
  | 'relay_ai_gateway_cross_model_fallback_cutover_ready'
  | 'relay_ai_gateway_cross_model_fallback_enabled'
  | 'relay_retry_times'
  | 'quota_coordinator_contract_version'
  | 'quota_coordinator_do_available'
  | 'quota_coordinator_shadow_enabled'
  | 'quota_coordinator_foundation_compiled'
  | 'quota_coordinator_observer_contract_compiled'
  | 'quota_coordinator_reserve_observation_compiled'
  | 'quota_coordinator_finalization_observation_compiled'
  | 'quota_coordinator_recovery_observation_compiled'
  | 'quota_coordinator_relay_observation_compiled'
  | 'quota_coordinator_retention_compaction_compiled'
  | 'quota_coordinator_reconciliation_compiled'
  | 'quota_coordinator_reconciliation_runtime_ready'
  | 'quota_coordinator_storage_retention_ready'
  | 'quota_coordinator_shadow_token_allowlist_configured'
  | 'quota_coordinator_shadow_token_allowlist_valid'
  | 'quota_coordinator_shadow_token_count'
  | 'quota_coordinator_reservation_ledger_only'
  | 'quota_coordinator_tiered_only'
  | 'quota_coordinator_write_authority_enabled'
  | 'quota_coordinator_staging_verified'
  | 'quota_coordinator_shadow_runtime_ready'
  | 'quota_coordinator_cutover_ready'
  | 'quota_coordinator_cutover_guards'
  | 'wfp_dispatch_binding_available'
  | 'wfp_dispatch_enabled'
  | 'wfp_internal_dispatch_enabled'
  | 'wfp_dispatch_failure_contract_compiled'
  | 'wfp_relay_transport_enabled'
  | 'wfp_relay_authority_secret_configured'
  | 'wfp_authority_replay_do_available'
  | 'wfp_authority_replay_do_compiled'
  | 'wfp_tenant_supported_routes'
  | 'wfp_tenant_cutover_guards'
  | 'wfp_tenant_script_plan_compiled'
  | 'wfp_tenant_rust_wasm_runtime_compiled'
  | 'wfp_tenant_route_manifest_compiled'
  | 'wfp_tenant_internal_dispatch_required_compiled'
  | 'wfp_outbound_invocation_context_compiled'
  | 'wfp_outbound_authority_verifier_compiled'
  | 'wfp_outbound_replay_guard_compiled'
  | 'wfp_tenant_response_header_guard_compiled'
  | 'wfp_preview_response_security_headers_compiled'
  | 'wfp_tenant_ai_gateway_policy_compiled'
  | 'wfp_outbound_egress_policy_compiled'
  | 'wfp_outbound_private_ingress_config_compiled'
  | 'wfp_relay_authority_transport_compiled'
  | 'wfp_relay_authority_transport_ready'
  | 'wfp_tenant_smoke_ready'
  | 'realtime_sessions_do_available'
  | 'realtime_session_gateway_enabled'
  | 'realtime_session_v1_enabled'
  | 'realtime_session_billing_settlement_write_enabled'
  | 'do_websocket_hibernation_compiled'
  | 'realtime_session_auth_boundary_compiled'
  | 'realtime_session_metrics_persisted_compiled'
  | 'realtime_session_control_no_echo_compiled'
  | 'realtime_session_platform_header_boundary_compiled'
  | 'realtime_session_platform_admin_auth_compiled'
  | 'realtime_session_upstream_bridge_hibernation_fail_closed_compiled'
  | 'realtime_session_upstream_bridge_compiled'
  | 'realtime_session_billing_settlement_compiled'
  | 'realtime_session_billing_settlement_batch_compiled'
  | 'realtime_session_billing_reconciliation_compiled'
  | 'realtime_session_billing_reconciliation_enabled'
  | 'realtime_session_billing_reconciliation_ready'
  | 'realtime_session_billing_reconciliation_staging_verified'
  | 'realtime_session_billing_reconciliation_cutover_ready'
  | 'realtime_session_platform_smoke_ready'
  | 'realtime_session_billing_settlement_staging_smoke_ready'
  | 'realtime_session_v1_cutover_ready'
  | 'task_runner_do_available'
  | 'task_runner_do_enabled'
  | 'task_runner_do_foundation_compiled'
  | 'task_runner_alarm_contract_compiled'
  | 'task_runner_storage_error_retry_contract_compiled'
  | 'task_runner_rearm_contract_compiled'
  | 'task_runner_submit_path_compiled'
  | 'task_runner_poll_path_compiled'
  | 'task_runner_status_probe_compiled'
  | 'task_runner_staging_replay_verified'
  | 'task_runner_cutover_ready'
>

export type PlatformReadinessSignal = {
  id: PlatformReadinessSignalId
  status: PlatformReadinessSignalStatus
}

const PLATFORM_READINESS_SIGNAL_LABELS = {
  'scheduling-gateway-implementation': 'Scheduling gateway',
  'ai-gateway-implementation': 'AI Gateway',
  'wfp-tenant-implementation': 'WFP tenant',
  'relay-billing-implementation': 'Relay billing ledger',
  'relay-flat-billing-intent-implementation': 'Relay flat billing intent',
  'relay-billing-owner-generation-compiled': 'Relay billing owner generation',
  'quota-coordinator-foundation': 'QuotaCoordinator foundation',
  'quota-coordinator-relay-observer': 'QuotaCoordinator relay observer',
  'realtime-implementation':
    'Realtime: client hibernation restores; provider bridge fails closed/refunds after DO eviction',
  'realtime-billing-reconciliation-implementation':
    'Realtime billing reconciliation',
  'task-runner-implementation': 'TaskRunner',
  'ai-gateway-runtime': 'AI Gateway',
  'ai-gateway-fallback-runtime': 'AI Gateway fallback',
  'wfp-tenant-runtime': 'WFP tenant',
  'realtime-runtime': 'Realtime fail-closed runtime (no provider restore)',
  'realtime-billing-reconciliation-runtime': 'Realtime billing reconciliation',
  'task-runner-runtime': 'TaskRunner',
  'quota-coordinator-binding': 'QuotaCoordinator binding',
  'quota-coordinator-shadow-runtime': 'QuotaCoordinator shadow runtime',
  'quota-coordinator-reconciliation': 'QuotaCoordinator reconciliation',
  'relay-flat-billing-intent-runtime': 'Relay flat billing intent',
  'relay-billing-owner-generation-configured': 'Relay billing owner generation',
  'ai-gateway-canary': 'AI Gateway canary',
  'ai-gateway-actual-group-billing-smoke':
    'AI Gateway actual-group billing smoke',
  'ai-gateway-fallback-replay': 'AI Gateway fallback replay',
  'wfp-tenant-smoke': 'WFP tenant smoke',
  'wfp-relay-authority-smoke': 'WFP relay authority smoke',
  'realtime-smoke':
    'Realtime client restore and provider eviction refund smoke',
  'realtime-billing-reconciliation-staging-proof':
    'Realtime billing reconciliation proof',
  'task-runner-replay': 'TaskRunner replay',
  'quota-coordinator-staging-bake': 'QuotaCoordinator staging bake',
  'relay-billing-stream-error-smoke': 'Relay stream error usage recovery',
  'relay-billing-finalization-replay': 'Relay billing finalization replay',
  'relay-billing-recovery-smoke': 'Relay billing recovery smoke',
  'relay-flat-billing-intent-staging-proof': 'Relay flat billing intent proof',
  'relay-billing-owner-generation-staging-proof':
    'Relay billing owner race proof',
  'task-runner-cutover': 'TaskRunner',
  'relay-billing-recovery-cutover': 'Relay billing recovery',
  'relay-flat-billing-intent-cutover': 'Relay flat billing intent',
  'relay-billing-owner-generation-cutover': 'Relay billing owner generation',
  'quota-coordinator-write-authority': 'QuotaCoordinator write authority',
  'quota-coordinator-cutover': 'QuotaCoordinator cutover',
  'ai-gateway-fallback-cutover': 'AI Gateway fallback',
  'realtime-v1-cutover': 'Realtime v1 fail-closed cutover',
  'realtime-billing-reconciliation-cutover': 'Realtime billing reconciliation',
} satisfies Record<PlatformReadinessSignalId, string>

export function getPlatformReadinessSignalLabel(
  id: PlatformReadinessSignalId
): string {
  return PLATFORM_READINESS_SIGNAL_LABELS[id]
}

export type PlatformReadinessStage = {
  id: PlatformReadinessStageId
  signals: PlatformReadinessSignal[]
  complete: boolean
  readyCount: number
  verifiedCount: number
}

export function getQuotaCoordinatorReadiness(
  capabilities: PlatformReadinessCapabilities
) {
  const foundation = allReady(
    capabilities.quota_coordinator_contract_version > 0,
    capabilities.quota_coordinator_foundation_compiled,
    capabilities.quota_coordinator_reservation_ledger_only
  )
  const binding = allReady(
    foundation,
    capabilities.quota_coordinator_do_available
  )
  const shadowGate = allReady(
    binding,
    capabilities.quota_coordinator_shadow_enabled
  )
  const relayObserver = allReady(
    foundation,
    capabilities.quota_coordinator_observer_contract_compiled,
    capabilities.quota_coordinator_reserve_observation_compiled,
    capabilities.quota_coordinator_finalization_observation_compiled,
    capabilities.quota_coordinator_recovery_observation_compiled,
    capabilities.quota_coordinator_relay_observation_compiled,
    capabilities.quota_coordinator_retention_compaction_compiled
  )
  const shadowScope = allReady(
    capabilities.quota_coordinator_shadow_token_allowlist_configured,
    capabilities.quota_coordinator_shadow_token_allowlist_valid,
    capabilities.quota_coordinator_shadow_token_count > 0
  )
  const storageRetention = allReady(
    capabilities.quota_coordinator_retention_compaction_compiled,
    capabilities.quota_coordinator_storage_retention_ready
  )
  const reconciliation = allReady(
    capabilities.quota_coordinator_reconciliation_compiled,
    capabilities.quota_coordinator_reconciliation_runtime_ready
  )
  const shadowRuntime = allReady(
    shadowGate,
    relayObserver,
    shadowScope,
    storageRetention,
    capabilities.quota_coordinator_shadow_runtime_ready
  )
  const stagingBake = allReady(
    shadowRuntime,
    reconciliation,
    capabilities.quota_coordinator_staging_verified
  )
  const writeAuthority = allReady(
    stagingBake,
    capabilities.quota_coordinator_write_authority_enabled
  )
  const cutover = allReady(
    writeAuthority,
    capabilities.quota_coordinator_cutover_ready,
    capabilities.quota_coordinator_cutover_guards.length > 0
  )

  return {
    foundation,
    binding,
    shadowGate,
    shadowScope,
    retentionCompaction:
      capabilities.quota_coordinator_retention_compaction_compiled,
    storageRetention,
    reconciliation,
    relayObserver,
    shadowRuntime,
    stagingBake,
    writeAuthority,
    cutover,
  }
}

export function getFlatBillingIntentReadiness(
  capabilities: PlatformReadinessCapabilities
) {
  const implementation = allReady(
    capabilities.relay_flat_billing_intent_contract_version > 0,
    capabilities.relay_flat_billing_intent_compiled
  )
  const runtime = allReady(
    implementation,
    capabilities.relay_flat_billing_intent_schema_ready,
    capabilities.relay_flat_billing_intent_runtime_ready
  )
  const staging = allReady(
    runtime,
    capabilities.relay_flat_billing_intent_staging_verified
  )
  const parity = allReady(
    capabilities.relay_flat_billing_go_parity_ready,
    capabilities.relay_flat_billing_go_parity_blockers.length === 0
  )
  const cutover = allReady(
    staging,
    parity,
    capabilities.relay_flat_billing_intent_cutover_ready
  )

  return {
    implementation,
    runtime,
    staging,
    parity,
    parityBlockers: capabilities.relay_flat_billing_go_parity_blockers,
    cutover,
  }
}

export function getFlatBillingParityBlockerLabel(blocker: string) {
  switch (blocker) {
    case 'ali_async_image_task_settlement':
      return 'Ali async image task settlement'
    case 'free_model_runtime_policy':
      return 'Free-model runtime policy'
    case 'provider_cache_field_scope_parity':
      return 'Provider cache-field scope parity'
    case 'provider_usage_provenance_parity':
      return 'Provider usage provenance parity'
    case 'provider_usage_staging_reconciliation':
      return 'Provider usage staging reconciliation'
    default:
      return blocker
  }
}

export function buildPlatformReadinessSummary(
  capabilities: PlatformReadinessCapabilities
): PlatformReadinessStage[] {
  const quotaCoordinator = getQuotaCoordinatorReadiness(capabilities)
  const flatBillingIntent = getFlatBillingIntentReadiness(capabilities)
  const schedulingGatewayImplementation = allReady(
    capabilities.scheduling_gateway_compiled,
    capabilities.scheduling_gateway_active,
    capabilities.scheduling_gateway_route_precedence.length > 0,
    capabilities.scheduling_gateway_preview_fail_closed_compiled
  )
  const aiGatewayImplementation = allReady(
    capabilities.relay_ai_gateway_rest_routes.length > 0,
    capabilities.relay_ai_gateway_model_prefixes.length > 0,
    capabilities.relay_ai_gateway_direct_fallback_prefixes.length > 0,
    capabilities.relay_ai_gateway_cutover_guards.length > 0,
    capabilities.relay_ai_gateway_channel_opt_in_supported,
    capabilities.relay_ai_gateway_rest_forwarder_compiled,
    capabilities.relay_ai_gateway_same_channel_fallback_compiled,
    capabilities.relay_ai_gateway_cross_model_fallback_compiled,
    capabilities.relay_ai_gateway_messages_cross_model_fallback_compiled,
    capabilities.relay_ai_gateway_cross_model_actual_group_billing_compiled,
    capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_compiled,
    capabilities.relay_ai_gateway_cross_model_terminal_audit_compiled
  )
  const wfpTenantImplementation = allReady(
    capabilities.wfp_tenant_supported_routes.length > 0,
    capabilities.wfp_tenant_cutover_guards.length > 0,
    capabilities.wfp_tenant_script_plan_compiled,
    capabilities.wfp_tenant_rust_wasm_runtime_compiled,
    capabilities.wfp_tenant_route_manifest_compiled,
    capabilities.wfp_tenant_internal_dispatch_required_compiled,
    capabilities.wfp_outbound_invocation_context_compiled,
    capabilities.wfp_outbound_authority_verifier_compiled,
    capabilities.wfp_outbound_replay_guard_compiled,
    capabilities.wfp_tenant_response_header_guard_compiled,
    capabilities.wfp_preview_response_security_headers_compiled,
    capabilities.wfp_tenant_ai_gateway_policy_compiled,
    capabilities.wfp_outbound_egress_policy_compiled,
    capabilities.wfp_outbound_private_ingress_config_compiled,
    capabilities.wfp_authority_replay_do_compiled,
    capabilities.wfp_relay_authority_transport_compiled,
    capabilities.wfp_dispatch_failure_contract_compiled
  )
  const realtimeImplementation = allReady(
    capabilities.do_websocket_hibernation_compiled,
    capabilities.realtime_session_auth_boundary_compiled,
    capabilities.realtime_session_metrics_persisted_compiled,
    capabilities.realtime_session_control_no_echo_compiled,
    capabilities.realtime_session_platform_header_boundary_compiled,
    capabilities.realtime_session_platform_admin_auth_compiled,
    capabilities.realtime_session_upstream_bridge_hibernation_fail_closed_compiled,
    capabilities.realtime_session_upstream_bridge_compiled,
    capabilities.realtime_session_billing_settlement_compiled,
    capabilities.realtime_session_billing_settlement_batch_compiled
  )
  const relayBillingImplementation = allReady(
    capabilities.relay_billing_reservation_ledger_compiled,
    capabilities.relay_billing_ledger_status_compiled,
    capabilities.relay_billing_stream_lease_renewal_compiled,
    capabilities.relay_billing_stream_error_usage_recovery_compiled,
    capabilities.relay_billing_finalization_consumer_compiled,
    capabilities.relay_billing_finalization_dlq_contract_compiled,
    capabilities.relay_billing_finalization_dlq_consumer_compiled,
    capabilities.relay_billing_finalization_replay_compiled,
    capabilities.relay_billing_finalization_reconcile_compiled
  )
  const taskRunnerImplementation = allReady(
    capabilities.task_runner_do_foundation_compiled,
    capabilities.task_runner_alarm_contract_compiled,
    capabilities.task_runner_storage_error_retry_contract_compiled,
    capabilities.task_runner_rearm_contract_compiled,
    capabilities.task_runner_submit_path_compiled,
    capabilities.task_runner_poll_path_compiled,
    capabilities.task_runner_status_probe_compiled
  )

  const implementation = createReadyStage('implementation', [
    readySignal(
      'scheduling-gateway-implementation',
      schedulingGatewayImplementation
    ),
    readySignal('ai-gateway-implementation', aiGatewayImplementation),
    readySignal('wfp-tenant-implementation', wfpTenantImplementation),
    readySignal('relay-billing-implementation', relayBillingImplementation),
    readySignal(
      'relay-flat-billing-intent-implementation',
      flatBillingIntent.implementation
    ),
    readySignal(
      'relay-billing-owner-generation-compiled',
      capabilities.relay_billing_prebind_owner_generation_compiled
    ),
    readySignal('quota-coordinator-foundation', quotaCoordinator.foundation),
    readySignal(
      'quota-coordinator-relay-observer',
      quotaCoordinator.relayObserver
    ),
    readySignal('realtime-implementation', realtimeImplementation),
    readySignal(
      'realtime-billing-reconciliation-implementation',
      capabilities.realtime_session_billing_reconciliation_compiled
    ),
    readySignal('task-runner-implementation', taskRunnerImplementation),
  ])

  const configuration = createReadyStage('configuration', [
    readySignal(
      'ai-gateway-runtime',
      capabilities.relay_ai_gateway_router_ready
    ),
    readySignal(
      'ai-gateway-fallback-runtime',
      capabilities.relay_ai_gateway_cross_model_fallback_ready
    ),
    readySignal(
      'wfp-tenant-runtime',
      allReady(
        capabilities.wfp_dispatch_binding_available,
        capabilities.wfp_dispatch_enabled,
        capabilities.wfp_internal_dispatch_enabled
      )
    ),
    readySignal(
      'realtime-runtime',
      allReady(
        realtimeImplementation,
        capabilities.d1_migration_ready,
        capabilities.realtime_sessions_do_available,
        capabilities.realtime_session_gateway_enabled,
        capabilities.realtime_session_v1_enabled,
        capabilities.realtime_session_billing_settlement_write_enabled
      )
    ),
    readySignal(
      'realtime-billing-reconciliation-runtime',
      capabilities.realtime_session_billing_reconciliation_ready
    ),
    readySignal(
      'task-runner-runtime',
      allReady(
        capabilities.task_runner_do_available,
        capabilities.task_runner_do_enabled
      )
    ),
    readySignal('quota-coordinator-binding', quotaCoordinator.binding),
    readySignal(
      'quota-coordinator-shadow-runtime',
      quotaCoordinator.shadowRuntime
    ),
    readySignal(
      'quota-coordinator-reconciliation',
      quotaCoordinator.reconciliation
    ),
    readySignal('relay-flat-billing-intent-runtime', flatBillingIntent.runtime),
    readySignal(
      'relay-billing-owner-generation-configured',
      capabilities.relay_billing_prebind_owner_generation_configured
    ),
  ])

  const taskRunnerReplayReady = allReady(
    capabilities.task_runner_do_available,
    capabilities.task_runner_do_enabled,
    capabilities.task_runner_storage_error_retry_contract_compiled,
    capabilities.task_runner_status_probe_compiled
  )
  const smoke = createVerificationStage('smoke', [
    verificationSignal(
      'ai-gateway-canary',
      capabilities.relay_ai_gateway_router_ready,
      false
    ),
    verificationSignal(
      'ai-gateway-actual-group-billing-smoke',
      capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_ready,
      false
    ),
    verificationSignal(
      'ai-gateway-fallback-replay',
      capabilities.relay_ai_gateway_cross_model_fallback_ready,
      capabilities.relay_ai_gateway_cross_model_fallback_staging_verified
    ),
    verificationSignal(
      'wfp-tenant-smoke',
      capabilities.wfp_tenant_smoke_ready,
      false
    ),
    verificationSignal(
      'wfp-relay-authority-smoke',
      allReady(
        capabilities.wfp_relay_authority_transport_ready,
        capabilities.relay_retry_times === 0,
        !capabilities.relay_ai_gateway_cross_model_fallback_enabled
      ),
      false
    ),
    verificationSignal(
      'realtime-smoke',
      allReady(
        capabilities.realtime_session_platform_smoke_ready,
        capabilities.realtime_session_billing_settlement_staging_smoke_ready
      ),
      false
    ),
    verificationSignal(
      'realtime-billing-reconciliation-staging-proof',
      capabilities.realtime_session_billing_reconciliation_ready,
      capabilities.realtime_session_billing_reconciliation_staging_verified
    ),
    verificationSignal(
      'task-runner-replay',
      taskRunnerReplayReady,
      capabilities.task_runner_staging_replay_verified
    ),
    verificationSignal(
      'quota-coordinator-staging-bake',
      quotaCoordinator.shadowRuntime,
      quotaCoordinator.stagingBake
    ),
    verificationSignal(
      'relay-billing-stream-error-smoke',
      allReady(
        capabilities.relay_billing_stream_error_usage_recovery_compiled,
        capabilities.relay_billing_stream_lease_heartbeat_configured,
        capabilities.relay_billing_missing_usage_estimate_enabled,
        capabilities.relay_billing_stream_lease_heartbeat_valid
      ),
      capabilities.relay_billing_stream_error_usage_recovery_staging_verified
    ),
    verificationSignal(
      'relay-billing-finalization-replay',
      allReady(
        capabilities.relay_billing_finalization_runtime_ready,
        capabilities.relay_billing_finalization_reconcile_enabled,
        capabilities.relay_billing_finalization_reconcile_ready
      ),
      capabilities.relay_billing_finalization_replay_staging_verified
    ),
    verificationSignal(
      'relay-billing-recovery-smoke',
      capabilities.relay_billing_orphan_recovery_ready,
      capabilities.relay_billing_stream_lease_renewal_staging_verified
    ),
    verificationSignal(
      'relay-flat-billing-intent-staging-proof',
      flatBillingIntent.runtime,
      flatBillingIntent.staging
    ),
    verificationSignal(
      'relay-billing-owner-generation-staging-proof',
      capabilities.relay_billing_prebind_owner_generation_configured,
      capabilities.relay_billing_prebind_owner_generation_staging_verified
    ),
  ])

  const cutover = createReadyStage('cutover', [
    readySignal(
      'ai-gateway-fallback-cutover',
      capabilities.relay_ai_gateway_cross_model_fallback_cutover_ready
    ),
    readySignal('task-runner-cutover', capabilities.task_runner_cutover_ready),
    readySignal(
      'relay-billing-recovery-cutover',
      capabilities.relay_billing_orphan_recovery_cutover_ready
    ),
    readySignal('relay-flat-billing-intent-cutover', flatBillingIntent.cutover),
    readySignal(
      'relay-billing-owner-generation-cutover',
      capabilities.relay_billing_prebind_owner_generation_cutover_ready
    ),
    readySignal(
      'quota-coordinator-write-authority',
      quotaCoordinator.writeAuthority
    ),
    readySignal('quota-coordinator-cutover', quotaCoordinator.cutover),
    readySignal(
      'realtime-v1-cutover',
      capabilities.realtime_session_v1_cutover_ready
    ),
    readySignal(
      'realtime-billing-reconciliation-cutover',
      capabilities.realtime_session_billing_reconciliation_cutover_ready
    ),
  ])

  return [implementation, configuration, smoke, cutover]
}

function allReady(...checks: boolean[]) {
  return checks.every(Boolean)
}

function readySignal(
  id: PlatformReadinessSignalId,
  ready: boolean
): PlatformReadinessSignal {
  return { id, status: ready ? 'ready' : 'blocked' }
}

function verificationSignal(
  id: PlatformReadinessSignalId,
  ready: boolean,
  verified: boolean
): PlatformReadinessSignal {
  if (ready && verified) return { id, status: 'verified' }
  return { id, status: ready ? 'ready-to-verify' : 'blocked' }
}

function createReadyStage(
  id: PlatformReadinessStageId,
  signals: PlatformReadinessSignal[]
): PlatformReadinessStage {
  const readyCount = signals.filter(
    (signal) => signal.status === 'ready'
  ).length
  return {
    id,
    signals,
    complete: readyCount === signals.length,
    readyCount,
    verifiedCount: 0,
  }
}

function createVerificationStage(
  id: PlatformReadinessStageId,
  signals: PlatformReadinessSignal[]
): PlatformReadinessStage {
  const verifiedCount = signals.filter(
    (signal) => signal.status === 'verified'
  ).length
  return {
    id,
    signals,
    complete: verifiedCount === signals.length,
    readyCount: signals.filter(
      (signal) =>
        signal.status === 'verified' || signal.status === 'ready-to-verify'
    ).length,
    verifiedCount,
  }
}
