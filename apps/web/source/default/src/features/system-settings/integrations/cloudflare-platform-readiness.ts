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
  | 'realtime-implementation'
  | 'task-runner-implementation'
  | 'ai-gateway-runtime'
  | 'ai-gateway-fallback-runtime'
  | 'wfp-tenant-runtime'
  | 'realtime-runtime'
  | 'task-runner-runtime'
  | 'ai-gateway-canary'
  | 'ai-gateway-actual-group-billing-smoke'
  | 'ai-gateway-fallback-replay'
  | 'wfp-tenant-smoke'
  | 'wfp-relay-authority-smoke'
  | 'realtime-smoke'
  | 'task-runner-replay'
  | 'task-runner-cutover'
  | 'ai-gateway-fallback-cutover'
  | 'realtime-v1-cutover'

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
  | 'relay_ai_gateway_router_ready'
  | 'relay_ai_gateway_rest_routes'
  | 'relay_ai_gateway_model_prefixes'
  | 'relay_ai_gateway_direct_fallback_prefixes'
  | 'relay_ai_gateway_cutover_guards'
  | 'relay_ai_gateway_channel_opt_in_supported'
  | 'relay_ai_gateway_rest_forwarder_compiled'
  | 'relay_ai_gateway_same_channel_fallback_compiled'
  | 'relay_ai_gateway_cross_model_fallback_compiled'
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
  | 'wfp_tenant_relay_authority_verifier_compiled'
  | 'wfp_tenant_response_header_guard_compiled'
  | 'wfp_tenant_ai_gateway_policy_compiled'
  | 'wfp_outbound_egress_policy_compiled'
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
  | 'realtime_session_upstream_bridge_hibernation_fail_closed_compiled'
  | 'realtime_session_upstream_bridge_compiled'
  | 'realtime_session_billing_settlement_compiled'
  | 'realtime_session_billing_settlement_batch_compiled'
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
  'realtime-implementation': 'Realtime',
  'task-runner-implementation': 'TaskRunner',
  'ai-gateway-runtime': 'AI Gateway',
  'ai-gateway-fallback-runtime': 'AI Gateway fallback',
  'wfp-tenant-runtime': 'WFP tenant',
  'realtime-runtime': 'Realtime',
  'task-runner-runtime': 'TaskRunner',
  'ai-gateway-canary': 'AI Gateway canary',
  'ai-gateway-actual-group-billing-smoke':
    'AI Gateway actual-group billing smoke',
  'ai-gateway-fallback-replay': 'AI Gateway fallback replay',
  'wfp-tenant-smoke': 'WFP tenant smoke',
  'wfp-relay-authority-smoke': 'WFP relay authority smoke',
  'realtime-smoke': 'Realtime smoke',
  'task-runner-replay': 'TaskRunner replay',
  'task-runner-cutover': 'TaskRunner',
  'ai-gateway-fallback-cutover': 'AI Gateway fallback',
  'realtime-v1-cutover': 'Realtime v1',
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

export function buildPlatformReadinessSummary(
  capabilities: PlatformReadinessCapabilities
): PlatformReadinessStage[] {
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
    capabilities.wfp_tenant_relay_authority_verifier_compiled,
    capabilities.wfp_tenant_response_header_guard_compiled,
    capabilities.wfp_tenant_ai_gateway_policy_compiled,
    capabilities.wfp_outbound_egress_policy_compiled,
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
    capabilities.realtime_session_upstream_bridge_hibernation_fail_closed_compiled,
    capabilities.realtime_session_upstream_bridge_compiled,
    capabilities.realtime_session_billing_settlement_compiled,
    capabilities.realtime_session_billing_settlement_batch_compiled
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
    readySignal('realtime-implementation', realtimeImplementation),
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
        capabilities.d1_migration_ready,
        capabilities.realtime_sessions_do_available,
        capabilities.realtime_session_gateway_enabled,
        capabilities.realtime_session_v1_enabled,
        capabilities.realtime_session_billing_settlement_write_enabled
      )
    ),
    readySignal(
      'task-runner-runtime',
      allReady(
        capabilities.task_runner_do_available,
        capabilities.task_runner_do_enabled
      )
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
      'task-runner-replay',
      taskRunnerReplayReady,
      capabilities.task_runner_staging_replay_verified
    ),
  ])

  const cutover = createReadyStage('cutover', [
    readySignal(
      'ai-gateway-fallback-cutover',
      capabilities.relay_ai_gateway_cross_model_fallback_cutover_ready
    ),
    readySignal('task-runner-cutover', capabilities.task_runner_cutover_ready),
    readySignal(
      'realtime-v1-cutover',
      capabilities.realtime_session_v1_cutover_ready
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
  if (verified) return { id, status: 'verified' }
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
