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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { getPlatformCapabilities } from '../api'
import { SettingsSection } from '../components/settings-section'
import type { PlatformCapabilities } from '../types'

type CapabilityRow = {
  label: string
  description: string
  ready: boolean
  readyLabel: string
  missingLabel: string
  readyVariant?: StatusVariant
  missingVariant?: StatusVariant
}

type CapabilityGroup = {
  title: string
  description: string
  rows: CapabilityRow[]
}

export function CloudflarePlatformSection() {
  const { t } = useTranslation()
  const capabilitiesQuery = useQuery({
    queryKey: ['platform-capabilities'],
    queryFn: async () => {
      const response = await getPlatformCapabilities()
      if (!response.success) {
        throw new Error(response.message || 'Failed to load')
      }
      return response.data
    },
    staleTime: 60 * 1000,
  })

  const capabilities = capabilitiesQuery.data

  const foundationChecks = capabilities
    ? [
        capabilities.ai_binding_available,
        capabilities.ai_gateway_id_configured,
        capabilities.channel_affinity_do_available,
        capabilities.realtime_sessions_do_available,
        capabilities.wfp_dispatch_binding_available,
        capabilities.wfp_tenant_script_plan_compiled,
        capabilities.wfp_tenant_rust_wasm_runtime_compiled,
        capabilities.wfp_tenant_route_manifest_compiled,
        capabilities.wfp_tenant_internal_dispatch_required_compiled,
        capabilities.wfp_tenant_response_header_guard_compiled,
        capabilities.wfp_tenant_ai_gateway_policy_compiled,
        capabilities.do_websocket_hibernation_compiled,
        capabilities.realtime_session_auth_boundary_compiled,
        capabilities.realtime_session_metrics_persisted_compiled,
        capabilities.realtime_session_control_no_echo_compiled,
        capabilities.realtime_session_upstream_bridge_planner_compiled,
        capabilities.realtime_session_upstream_channel_planner_compiled,
        capabilities.realtime_session_upstream_bridge_connect_contract_compiled,
        capabilities.realtime_session_upstream_connect_handoff_compiled,
        capabilities.realtime_session_upstream_fetch_upgrade_adapter_compiled,
        capabilities.realtime_session_upstream_bridge_lifecycle_compiled,
        capabilities.realtime_session_upstream_bridge_frame_guard_compiled,
        capabilities.realtime_session_upstream_bridge_close_mapping_compiled,
        capabilities.realtime_session_upstream_bridge_send_failure_guard_compiled,
        capabilities.realtime_session_upstream_bridge_event_trace_compiled,
        capabilities.realtime_session_upstream_bridge_replay_contract_compiled,
        capabilities.realtime_session_upstream_bridge_backpressure_policy_compiled,
        capabilities.realtime_session_upstream_bridge_backpressure_runtime_compiled,
        capabilities.realtime_session_platform_header_boundary_compiled,
        capabilities.task_poller_scheduled_handler_compiled,
        capabilities.task_poller_timeout_sweep_compiled,
        capabilities.task_poller_refund_batch_compiled,
        capabilities.task_poller_refund_replay_contract_compiled,
        capabilities.task_runner_do_available,
        capabilities.task_runner_do_foundation_compiled,
        capabilities.task_runner_alarm_contract_compiled,
      ]
    : []
  const readyCount = foundationChecks.filter(Boolean).length

  return (
    <SettingsSection title={t('Cloudflare Platform')}>
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4'>
          <div className='space-y-1'>
            <p className='text-sm font-medium'>
              {t('Cloudflare migration readiness')}
            </p>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Tracks Worker bindings, Durable Objects, WFP dispatch, AI Gateway, and realtime feature gates reported by the Rust Worker.'
              )}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            {capabilities ? (
              <StatusBadge
                variant={
                  readyCount === foundationChecks.length ? 'success' : 'warning'
                }
                copyable={false}
              >
                {t('{{ready}}/{{total}} foundation signals ready', {
                  ready: readyCount,
                  total: foundationChecks.length,
                })}
              </StatusBadge>
            ) : null}
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={capabilitiesQuery.isFetching}
              onClick={() => capabilitiesQuery.refetch()}
            >
              {capabilitiesQuery.isFetching ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>
        </div>

        {capabilitiesQuery.isError ? (
          <Alert variant='destructive'>
            <AlertDescription>
              {capabilitiesQuery.error instanceof Error
                ? capabilitiesQuery.error.message
                : t('Failed to load Cloudflare platform capabilities')}
            </AlertDescription>
          </Alert>
        ) : null}

        {capabilities ? (
          <>
            <div className='grid gap-4 lg:grid-cols-2 xl:grid-cols-4'>
              {buildCapabilityGroups(capabilities, t).map((group) => (
                <CapabilityGroupCard key={group.title} group={group} />
              ))}
            </div>

            <div className='rounded-lg border p-4'>
              <p className='text-sm font-medium'>
                {t('Production cutover notes')}
              </p>
              <ul className='text-muted-foreground mt-2 list-disc space-y-1 ps-5 text-xs'>
                <li>
                  {t(
                    'WFP tenant traffic needs the DISPATCHER binding plus WFP_DISPATCH_ENABLED; live internal smoke also requires WFP_INTERNAL_DISPATCH_ENABLED and the tenant contract guards to pass.'
                  )}
                </li>
                <li>
                  {t(
                    'The internal dispatch path should stay admin-only and is mainly for staging smoke tests.'
                  )}
                </li>
                <li>
                  {t(
                    '/v1/realtime remains gated separately from the platform realtime smoke path until upstream bridge and billing settlement are verified.'
                  )}
                </li>
                <li>
                  {t(
                    'Main relay AI Gateway routing stays default-off until route compatibility, provider-prefix policy, fallback behavior, and settlement evidence are captured.'
                  )}
                </li>
                <li>
                  {t(
                    'Async task cron readiness now includes the Go-compatible timeout sweep and CAS-winner refund batch; keep provider replay and settlement evidence separate.'
                  )}
                </li>
              </ul>
            </div>
          </>
        ) : (
          <CapabilitySkeleton />
        )}
      </div>
    </SettingsSection>
  )
}

function buildCapabilityGroups(
  capabilities: PlatformCapabilities,
  t: (key: string, options?: Record<string, unknown>) => string
): CapabilityGroup[] {
  const relayAiGatewayRoutes =
    capabilities.relay_ai_gateway_rest_routes.join(', ') || t('No routes')
  const relayAiGatewayGuards =
    capabilities.relay_ai_gateway_cutover_guards.join(', ') || t('No guards')
  const realtimeSessionGuards =
    capabilities.realtime_session_cutover_guards.join(', ') || t('No guards')
  const wfpTenantRoutes =
    capabilities.wfp_tenant_supported_routes.join(', ') || t('No routes')
  const wfpTenantGuards =
    capabilities.wfp_tenant_cutover_guards.join(', ') || t('No guards')

  return [
    {
      title: t('Runtime bindings'),
      description: t('Cloudflare bindings required by the Rust relay gateway.'),
      rows: [
        {
          label: t('Workers AI binding'),
          description: t('Used for direct Workers AI relay channels.'),
          ready: capabilities.ai_binding_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
        },
        {
          label: t('AI Gateway ID'),
          description: t(
            'Enables Gateway routing and analytics for configured paths.'
          ),
          ready: capabilities.ai_gateway_id_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Not configured'),
        },
        {
          label: t('Channel Affinity Durable Object'),
          description: t(
            'Persists sticky channel selection state at the edge.'
          ),
          ready: capabilities.channel_affinity_do_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
        },
      ],
    },
    {
      title: t('AI Gateway router'),
      description: t(
        'Default-off REST routing readiness for the main Rust relay.'
      ),
      rows: [
        {
          label: t('Cloudflare account ID'),
          description: t('Required for account-scoped AI Gateway REST calls.'),
          ready: capabilities.cloudflare_account_id_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Not configured'),
        },
        {
          label: t('Gateway runtime token'),
          description: t(
            'Secret used by the Worker when the relay router is enabled.'
          ),
          ready: capabilities.cloudflare_ai_gateway_token_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Main relay router gate'),
          description: t('Runtime flag RELAY_AI_GATEWAY_ROUTER_ENABLED.'),
          ready: capabilities.relay_ai_gateway_router_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('REST route planner'),
          description: t('Compiled for {{count}} route families: {{routes}}', {
            count: capabilities.relay_ai_gateway_rest_routes.length,
            routes: relayAiGatewayRoutes,
          }),
          ready: capabilities.relay_ai_gateway_rest_routes.length > 0,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Cutover guard policy'),
          description: t('Compiled guards: {{guards}}', {
            guards: relayAiGatewayGuards,
          }),
          ready: capabilities.relay_ai_gateway_cutover_guards.length > 0,
          readyLabel: t('{{count}} guards', {
            count: capabilities.relay_ai_gateway_cutover_guards.length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('Channel opt-in metadata'),
          description: t(
            'Reads per-channel AI Gateway opt-in from channel other_info before traffic canary.'
          ),
          ready: capabilities.relay_ai_gateway_channel_opt_in_supported,
          readyLabel: t('Supported'),
          missingLabel: t('Missing'),
        },
        {
          label: t('REST request forwarder'),
          description: t(
            'Builds Cloudflare AI Gateway REST requests only when the router gate and channel opt-in allow it.'
          ),
          ready: capabilities.relay_ai_gateway_rest_forwarder_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Same-channel direct fallback'),
          description: t(
            'Retries through the original provider channel when AI Gateway returns a retryable status or fetch error.'
          ),
          ready: capabilities.relay_ai_gateway_same_channel_fallback_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Router cutover readiness'),
          description: t(
            'Requires account, gateway ID, runtime token, and explicit router gate.'
          ),
          ready: capabilities.relay_ai_gateway_router_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Waiting'),
          missingVariant: capabilities.relay_ai_gateway_router_enabled
            ? 'warning'
            : 'neutral',
        },
      ],
    },
    {
      title: t('WFP dispatch'),
      description: t('Workers for Platforms dispatch-worker routing controls.'),
      rows: [
        {
          label: t('Dispatcher binding'),
          description: t('Required before tenant scripts can receive traffic.'),
          ready: capabilities.wfp_dispatch_binding_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant dispatch gate'),
          description: t('Runtime flag WFP_DISPATCH_ENABLED.'),
          ready: capabilities.wfp_dispatch_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('Internal dispatch smoke gate'),
          description: t(
            'Admin-only staging path for tenant status and route smoke.'
          ),
          ready: capabilities.wfp_internal_dispatch_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('Preview host suffix'),
          description: t(
            'Maps tenant preview hostnames into the dispatch namespace.'
          ),
          ready: capabilities.wfp_preview_host_suffix_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Not configured'),
          missingVariant: 'neutral',
        },
        {
          label: t('Worker name prefix'),
          description: t(
            'Optional tenant script prefix used during dispatch lookup.'
          ),
          ready: capabilities.wfp_worker_prefix_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Default names'),
          missingVariant: 'neutral',
        },
        {
          label: t('Tenant route manifest'),
          description: t('Compiled for {{count}} tenant routes: {{routes}}', {
            count: capabilities.wfp_tenant_supported_routes.length,
            routes: wfpTenantRoutes,
          }),
          ready: capabilities.wfp_tenant_route_manifest_compiled,
          readyLabel: t('{{count}} routes', {
            count: capabilities.wfp_tenant_supported_routes.length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant cutover guards'),
          description: t('Compiled guards: {{guards}}', {
            guards: wfpTenantGuards,
          }),
          ready: capabilities.wfp_tenant_cutover_guards.length > 0,
          readyLabel: t('{{count}} guards', {
            count: capabilities.wfp_tenant_cutover_guards.length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant script plan'),
          description: t(
            'Builds the WFP tenant module and upload metadata without embedding secrets in the operator response.'
          ),
          ready: capabilities.wfp_tenant_script_plan_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Rust/Wasm tenant artifact'),
          description: t(
            'Tracks the dedicated crates/wfp-tenant artifact and shim used for Rust tenant uploads.'
          ),
          ready: capabilities.wfp_tenant_rust_wasm_runtime_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Internal dispatch requirement'),
          description: t(
            'Tenant AI routes fail closed unless the main dispatch Worker adds controlled internal WFP markers.'
          ),
          ready: capabilities.wfp_tenant_internal_dispatch_required_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant response-header guard'),
          description: t(
            'Allows only public upstream headers and WFP evidence headers back through the dispatch boundary.'
          ),
          ready: capabilities.wfp_tenant_response_header_guard_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant AI Gateway policy'),
          description: t(
            'Supports route-specific Gateway IDs, retry/cache/log policy headers, and metadata for tenant route smokes.'
          ),
          ready: capabilities.wfp_tenant_ai_gateway_policy_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Tenant smoke readiness'),
          description: t(
            'Requires DISPATCHER, dispatch gates, route manifest, internal dispatch checks, response-header guard, and AI Gateway policy contract.'
          ),
          ready: capabilities.wfp_tenant_smoke_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Waiting'),
          missingVariant: capabilities.wfp_dispatch_enabled
            ? 'warning'
            : 'neutral',
        },
      ],
    },
    {
      title: t('Async task poller'),
      description: t(
        'Cloudflare cron readiness for video, Suno, and Midjourney task settlement.'
      ),
      rows: [
        {
          label: t('Scheduled handler'),
          description: t(
            'Compiles the Worker scheduled event used by the cron-triggered task poller.'
          ),
          ready: capabilities.task_poller_scheduled_handler_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Timeout sweep'),
          description: t(
            'Runs before normal polling so old stuck tasks cannot starve the bounded provider poll window.'
          ),
          ready: capabilities.task_poller_timeout_sweep_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Refund batch'),
          description: t(
            'Guards timeout/provider-failure refunds behind the same CAS winner marker before marking the refund complete.'
          ),
          ready: capabilities.task_poller_refund_batch_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Refund replay contract'),
          description: t(
            'Pairs the CAS marker, no-duplicate-refund guard, legacy no-refund cutoff, and local Bun replay used before staging.'
          ),
          ready: capabilities.task_poller_refund_replay_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('TaskRunner Durable Object'),
          description: t(
            'Binds one optional alarm-capable Durable Object per task for the future sub-minute fast path.'
          ),
          ready: capabilities.task_runner_do_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
          missingVariant: 'neutral',
        },
        {
          label: t('TaskRunner alarm contract'),
          description: t(
            'Compiles deterministic task instance routing, bounded alarm delay, and alarm-fired evidence storage.'
          ),
          ready: capabilities.task_runner_alarm_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('TaskRunner fast path gate'),
          description: t(
            'TASK_RUNNER_DO_ENABLED must stay off until submit-path arming and staging alarm replay are proven.'
          ),
          ready: capabilities.task_runner_do_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Disabled'),
          missingVariant: capabilities.task_runner_submit_path_compiled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('TaskRunner submit path'),
          description: t(
            'Submit-path alarm arming is intentionally pending; cron remains the sweeper of record.'
          ),
          ready: capabilities.task_runner_submit_path_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Pending'),
          missingVariant: 'neutral',
        },
        {
          label: t('Timeout sweep gate'),
          description: t(
            'TASK_TIMEOUT_MINUTES={{minutes}}; zero disables timeout cleanup.',
            {
              minutes: capabilities.task_poller_timeout_minutes,
            }
          ),
          ready: capabilities.task_poller_timeout_sweep_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Disabled'),
          missingVariant: 'neutral',
        },
        {
          label: t('Provider poll window'),
          description: t(
            'TASK_QUERY_LIMIT={{limit}} tasks per family per cron tick.',
            {
              limit: capabilities.task_poller_query_limit,
            }
          ),
          ready: capabilities.task_poller_query_limit > 0,
          readyLabel: t('{{limit}} tasks', {
            limit: capabilities.task_poller_query_limit,
          }),
          missingLabel: t('Invalid'),
        },
        {
          label: t('Timeout sweep window'),
          description: t(
            'Cleans at most {{limit}} oldest timed-out tasks before video/Suno/Midjourney polling.',
            {
              limit: capabilities.task_poller_timeout_sweep_limit,
            }
          ),
          ready: capabilities.task_poller_timeout_sweep_limit > 0,
          readyLabel: t('{{limit}} tasks', {
            limit: capabilities.task_poller_timeout_sweep_limit,
          }),
          missingLabel: t('Invalid'),
        },
      ],
    },
    {
      title: t('Realtime sessions'),
      description: t(
        'Durable Object hibernation path for long-lived sessions.'
      ),
      rows: [
        {
          label: t('Realtime Sessions Durable Object'),
          description: t(
            'Required for hibernatable WebSocket session ownership.'
          ),
          ready: capabilities.realtime_sessions_do_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
        },
        {
          label: t('WebSocket hibernation code path'),
          description: t(
            'Confirms the Rust Worker was compiled with the DO hibernation path.'
          ),
          ready: capabilities.do_websocket_hibernation_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Relay token auth boundary'),
          description: t(
            '/v1/realtime checks relay token auth, model access, quota, and rate limits before selecting a DO session.'
          ),
          ready: capabilities.realtime_session_auth_boundary_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Persistent lifecycle metrics'),
          description: t(
            'Stores connect/message/close/error counters in Durable Object storage for resume smoke evidence.'
          ),
          ready: capabilities.realtime_session_metrics_persisted_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Control frame no-echo'),
          description: t(
            'Unsupported-control responses report byte counts without echoing raw client payloads or tokens.'
          ),
          ready: capabilities.realtime_session_control_no_echo_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime cutover guards'),
          description: t('Compiled guards: {{guards}}', {
            guards: realtimeSessionGuards,
          }),
          ready: capabilities.realtime_session_cutover_guards.length > 0,
          readyLabel: t('{{count}} guards', {
            count: capabilities.realtime_session_cutover_guards.length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('Platform realtime smoke gate'),
          description: t('Runtime flag REALTIME_SESSION_GATEWAY_ENABLED.'),
          ready: capabilities.realtime_session_gateway_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('OpenAI realtime v1 gate'),
          description: t('Runtime flag REALTIME_SESSION_V1_ENABLED.'),
          ready: capabilities.realtime_session_v1_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('Platform smoke readiness'),
          description: t(
            'Requires the REALTIME_SESSIONS binding, platform smoke gate, hibernation path, metrics, and no-echo controls.'
          ),
          ready: capabilities.realtime_session_platform_smoke_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Waiting'),
          missingVariant: capabilities.realtime_session_gateway_enabled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('Upstream bridge planner'),
          description: t(
            'Builds upstream Realtime WebSocket URL and handshake metadata with secret redaction before the full bridge is enabled.'
          ),
          ready: capabilities.realtime_session_upstream_bridge_planner_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream channel selection'),
          description: t(
            'Selects the authenticated /v1/realtime upstream channel through the relay D1/cache routing path and passes only a redacted plan to the Durable Object.'
          ),
          ready:
            capabilities.realtime_session_upstream_channel_planner_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream connect contract'),
          description: t(
            'Builds the request-scoped upstream WebSocket connect spec with secret-bearing headers or subprotocols while exposing only redacted metadata to attachments and status paths.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_connect_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream connect handoff'),
          description: t(
            'Passes the secret-bearing upstream connect material from the relay gateway to the Durable Object only on the live request, while persisting no raw upstream key.'
          ),
          ready:
            capabilities.realtime_session_upstream_connect_handoff_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream fetch-upgrade adapter'),
          description: t(
            'Builds the Worker-native fetch request that upgrades to the selected upstream Realtime WebSocket using request-scoped headers or subprotocols.'
          ),
          ready:
            capabilities.realtime_session_upstream_fetch_upgrade_adapter_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream bridge lifecycle'),
          description: t(
            'Tracks the transient upstream Realtime WebSocket bridge lifecycle, forwards client frames when active, and reports a not-active state after hibernation or restart.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_lifecycle_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream frame guard'),
          description: t(
            'Rejects oversized Realtime bridge text and binary frames with message-too-big close handling alongside the bounded backpressure queue.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_frame_guard_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream close mapping'),
          description: t(
            'Maps Realtime bridge close, error, accept failure, and message-too-big paths to deterministic WebSocket close codes and redacted reasons.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_close_mapping_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream send failure guard'),
          description: t(
            'Closes both sides of the transient Realtime bridge when either client-to-upstream or upstream-to-client forwarding fails, without recording raw payloads.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_send_failure_guard_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream event trace'),
          description: t(
            'Emits and persists sanitized terminal bridge event metadata for close, error, frame-limit, and send-failure evidence without storing payloads.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_event_trace_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream replay contract'),
          description: t(
            'Validates ordered mock/live replay scenarios from active bridge status through terminal event, close mapping, persisted evidence, and no payload leakage.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_replay_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream backpressure policy'),
          description: t(
            'Defines bounded pending frame and byte limits plus metadata-only fail-closed overflow handling for the Realtime bridge.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_backpressure_policy_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream backpressure runtime'),
          description: t(
            'Queues client frames in bounded transient memory until the upstream Realtime socket is accepted, then drains them in order or closes fail-closed on overflow.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_backpressure_runtime_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Platform header boundary'),
          description: t(
            'Strips caller-supplied internal Realtime upstream handoff headers before platform gateway requests reach the Durable Object.'
          ),
          ready:
            capabilities.realtime_session_platform_header_boundary_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Upstream realtime bridge'),
          description: t(
            'Bridges the DO session to an upstream Realtime WebSocket with queued flow-control and production replay evidence.'
          ),
          ready: capabilities.realtime_session_upstream_bridge_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Not wired'),
          missingVariant: 'neutral',
        },
        {
          label: t('Realtime billing settlement'),
          description: t(
            'Required before production /v1/realtime can charge, refund, and audit provider usage.'
          ),
          ready: capabilities.realtime_session_billing_settlement_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Not wired'),
          missingVariant: 'neutral',
        },
        {
          label: t('v1 production readiness'),
          description: t(
            'Requires DO binding, v1 gate, auth boundary, hibernation, metrics, no-echo controls, upstream bridge, and billing settlement.'
          ),
          ready: capabilities.realtime_session_v1_cutover_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Blocked'),
          missingVariant: capabilities.realtime_session_v1_enabled
            ? 'warning'
            : 'neutral',
        },
      ],
    },
  ]
}

function CapabilityGroupCard({ group }: { group: CapabilityGroup }) {
  return (
    <div className='space-y-3 rounded-lg border p-4'>
      <div className='space-y-1'>
        <p className='text-sm font-medium'>{group.title}</p>
        <p className='text-muted-foreground text-xs'>{group.description}</p>
      </div>
      <div className='divide-y'>
        {group.rows.map((row) => (
          <div
            key={row.label}
            className='flex min-w-0 items-start justify-between gap-3 py-3 first:pt-0 last:pb-0'
          >
            <div className='min-w-0 space-y-0.5'>
              <p className='text-sm font-medium'>{row.label}</p>
              <p className='text-muted-foreground text-xs'>{row.description}</p>
            </div>
            <StatusBadge
              variant={
                row.ready
                  ? (row.readyVariant ?? 'success')
                  : (row.missingVariant ?? 'warning')
              }
              copyable={false}
              className='shrink-0'
            >
              {row.ready ? row.readyLabel : row.missingLabel}
            </StatusBadge>
          </div>
        ))}
      </div>
    </div>
  )
}

function CapabilitySkeleton() {
  return (
    <div className='grid gap-4 lg:grid-cols-2 xl:grid-cols-4'>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className='space-y-3 rounded-lg border p-4'>
          <Skeleton className='h-4 w-40' />
          <Skeleton className='h-3 w-full' />
          <Skeleton className='h-12 w-full' />
          <Skeleton className='h-12 w-full' />
          <Skeleton className='h-12 w-full' />
        </div>
      ))}
    </div>
  )
}
