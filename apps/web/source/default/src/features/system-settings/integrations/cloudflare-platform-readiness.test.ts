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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildPlatformReadinessSummary,
  type PlatformReadinessCapabilities,
  type PlatformReadinessStageId,
} from './cloudflare-platform-readiness'

const baseCapabilities: PlatformReadinessCapabilities = {
  d1_migration_ready: false,
  relay_ai_gateway_router_ready: false,
  relay_ai_gateway_rest_routes: [],
  relay_ai_gateway_cutover_guards: [],
  relay_ai_gateway_channel_opt_in_supported: false,
  relay_ai_gateway_rest_forwarder_compiled: false,
  relay_ai_gateway_same_channel_fallback_compiled: false,
  relay_ai_gateway_cross_model_fallback_compiled: false,
  relay_ai_gateway_cross_model_actual_group_billing_compiled: false,
  relay_ai_gateway_actual_group_billing_staging_smoke_compiled: false,
  relay_ai_gateway_actual_group_billing_staging_smoke_enabled: false,
  relay_ai_gateway_actual_group_billing_staging_smoke_ready: false,
  relay_ai_gateway_cross_model_terminal_audit_compiled: false,
  relay_ai_gateway_cross_model_fallback_ready: false,
  relay_ai_gateway_cross_model_fallback_staging_verified: false,
  relay_ai_gateway_cross_model_fallback_cutover_ready: false,
  wfp_dispatch_binding_available: false,
  wfp_dispatch_enabled: false,
  wfp_internal_dispatch_enabled: false,
  wfp_tenant_supported_routes: [],
  wfp_tenant_cutover_guards: [],
  wfp_tenant_script_plan_compiled: false,
  wfp_tenant_rust_wasm_runtime_compiled: false,
  wfp_tenant_route_manifest_compiled: false,
  wfp_tenant_internal_dispatch_required_compiled: false,
  wfp_tenant_response_header_guard_compiled: false,
  wfp_tenant_ai_gateway_policy_compiled: false,
  wfp_tenant_smoke_ready: false,
  realtime_sessions_do_available: false,
  realtime_session_gateway_enabled: false,
  realtime_session_v1_enabled: false,
  realtime_session_billing_settlement_write_enabled: false,
  do_websocket_hibernation_compiled: false,
  realtime_session_auth_boundary_compiled: false,
  realtime_session_metrics_persisted_compiled: false,
  realtime_session_control_no_echo_compiled: false,
  realtime_session_platform_header_boundary_compiled: false,
  realtime_session_upstream_bridge_hibernation_fail_closed_compiled: false,
  realtime_session_upstream_bridge_compiled: false,
  realtime_session_billing_settlement_compiled: false,
  realtime_session_platform_smoke_ready: false,
  realtime_session_billing_settlement_staging_smoke_ready: false,
  realtime_session_v1_cutover_ready: false,
  task_runner_do_available: false,
  task_runner_do_enabled: false,
  task_runner_do_foundation_compiled: false,
  task_runner_alarm_contract_compiled: false,
  task_runner_rearm_contract_compiled: false,
  task_runner_submit_path_compiled: false,
  task_runner_poll_path_compiled: false,
  task_runner_status_probe_compiled: false,
  task_runner_staging_replay_verified: false,
  task_runner_cutover_ready: false,
}

describe('Cloudflare platform readiness headline', () => {
  test('does not report every stage complete from compiled and bound state', () => {
    const summary = buildPlatformReadinessSummary(
      makeCapabilities({
        d1_migration_ready: true,
        relay_ai_gateway_rest_routes: ['/v1/chat/completions'],
        relay_ai_gateway_cutover_guards: ['channel-opt-in'],
        relay_ai_gateway_channel_opt_in_supported: true,
        relay_ai_gateway_rest_forwarder_compiled: true,
        relay_ai_gateway_same_channel_fallback_compiled: true,
        relay_ai_gateway_cross_model_fallback_compiled: true,
        relay_ai_gateway_cross_model_actual_group_billing_compiled: true,
        relay_ai_gateway_actual_group_billing_staging_smoke_compiled: true,
        relay_ai_gateway_cross_model_terminal_audit_compiled: true,
        wfp_dispatch_binding_available: true,
        wfp_tenant_supported_routes: ['/v1/responses'],
        wfp_tenant_cutover_guards: ['internal-dispatch'],
        wfp_tenant_script_plan_compiled: true,
        wfp_tenant_rust_wasm_runtime_compiled: true,
        wfp_tenant_route_manifest_compiled: true,
        wfp_tenant_internal_dispatch_required_compiled: true,
        wfp_tenant_response_header_guard_compiled: true,
        wfp_tenant_ai_gateway_policy_compiled: true,
        realtime_sessions_do_available: true,
        do_websocket_hibernation_compiled: true,
        realtime_session_auth_boundary_compiled: true,
        realtime_session_metrics_persisted_compiled: true,
        realtime_session_control_no_echo_compiled: true,
        realtime_session_platform_header_boundary_compiled: true,
        realtime_session_upstream_bridge_hibernation_fail_closed_compiled: true,
        realtime_session_upstream_bridge_compiled: true,
        realtime_session_billing_settlement_compiled: true,
        task_runner_do_available: true,
        task_runner_do_foundation_compiled: true,
        task_runner_alarm_contract_compiled: true,
        task_runner_rearm_contract_compiled: true,
        task_runner_submit_path_compiled: true,
        task_runner_poll_path_compiled: true,
        task_runner_status_probe_compiled: true,
      })
    )

    assert.equal(getStage(summary, 'implementation').complete, true)
    assert.equal(getStage(summary, 'configuration').complete, false)
    assert.equal(getStage(summary, 'smoke').complete, false)
    assert.equal(getStage(summary, 'cutover').complete, false)
    assert.equal(
      summary.every((stage) => stage.complete),
      false
    )
  })

  test('blocks AI Gateway implementation without actual serving group billing', () => {
    const implementation = getStage(
      buildPlatformReadinessSummary(
        makeCapabilities({
          relay_ai_gateway_rest_routes: ['/v1/chat/completions'],
          relay_ai_gateway_cutover_guards: ['actual-serving-group-billing'],
          relay_ai_gateway_channel_opt_in_supported: true,
          relay_ai_gateway_rest_forwarder_compiled: true,
          relay_ai_gateway_same_channel_fallback_compiled: true,
          relay_ai_gateway_cross_model_fallback_compiled: true,
          relay_ai_gateway_cross_model_terminal_audit_compiled: true,
        })
      ),
      'implementation'
    )

    assert.equal(implementation.signals[0]?.id, 'ai-gateway-implementation')
    assert.equal(implementation.signals[0]?.status, 'blocked')
  })

  test('keeps canary and smoke prerequisites distinct from verification', () => {
    const summary = buildPlatformReadinessSummary(
      makeCapabilities({
        relay_ai_gateway_router_ready: true,
        wfp_tenant_smoke_ready: true,
        realtime_session_platform_smoke_ready: true,
        realtime_session_billing_settlement_staging_smoke_ready: true,
        task_runner_do_available: true,
        task_runner_do_enabled: true,
        task_runner_status_probe_compiled: true,
        task_runner_staging_replay_verified: true,
      })
    )
    const smoke = getStage(summary, 'smoke')

    assert.equal(smoke.complete, false)
    assert.equal(smoke.readyCount, 4)
    assert.equal(smoke.verifiedCount, 1)
    assert.deepEqual(
      smoke.signals.map((signal) => signal.status),
      [
        'ready-to-verify',
        'blocked',
        'blocked',
        'ready-to-verify',
        'ready-to-verify',
        'verified',
      ]
    )
  })

  test('keeps actual-group smoke readiness separate from verification and cutover', () => {
    const summary = buildPlatformReadinessSummary(
      makeCapabilities({
        relay_ai_gateway_actual_group_billing_staging_smoke_compiled: true,
        relay_ai_gateway_actual_group_billing_staging_smoke_enabled: true,
        relay_ai_gateway_actual_group_billing_staging_smoke_ready: true,
      })
    )
    const smoke = getStage(summary, 'smoke')
    const actualGroupSmoke = smoke.signals.find(
      (signal) => signal.id === 'ai-gateway-actual-group-billing-smoke'
    )

    assert.equal(actualGroupSmoke?.status, 'ready-to-verify')
    assert.equal(smoke.complete, false)
    assert.equal(
      smoke.signals.find((signal) => signal.id === 'ai-gateway-fallback-replay')
        ?.status,
      'blocked'
    )
    assert.equal(getStage(summary, 'cutover').complete, false)
  })

  test('uses only backend cutover readiness fields for cutover success', () => {
    const blocked = buildPlatformReadinessSummary(makeCapabilities())
    const ready = buildPlatformReadinessSummary(
      makeCapabilities({
        relay_ai_gateway_cross_model_fallback_cutover_ready: true,
        task_runner_cutover_ready: true,
        realtime_session_v1_cutover_ready: true,
      })
    )

    assert.equal(getStage(blocked, 'cutover').complete, false)
    assert.equal(getStage(ready, 'cutover').complete, true)
    assert.equal(getStage(ready, 'cutover').readyCount, 3)
  })
})

function makeCapabilities(
  overrides: Partial<PlatformReadinessCapabilities> = {}
): PlatformReadinessCapabilities {
  return { ...baseCapabilities, ...overrides }
}

function getStage(
  summary: ReturnType<typeof buildPlatformReadinessSummary>,
  id: PlatformReadinessStageId
) {
  const stage = summary.find((candidate) => candidate.id === id)
  assert.ok(stage)
  return stage
}
