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
        capabilities.do_websocket_hibernation_compiled,
        capabilities.realtime_session_auth_boundary_compiled,
        capabilities.realtime_session_metrics_persisted_compiled,
        capabilities.realtime_session_control_no_echo_compiled,
        capabilities.realtime_session_upstream_bridge_planner_compiled,
        capabilities.realtime_session_upstream_channel_planner_compiled,
        capabilities.realtime_session_upstream_bridge_connect_contract_compiled,
        capabilities.realtime_session_upstream_connect_handoff_compiled,
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
                    'WFP tenant traffic needs the DISPATCHER binding plus WFP_DISPATCH_ENABLED; preview hosts also need WFP_PREVIEW_HOST_SUFFIX.'
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
          label: t('Upstream realtime bridge'),
          description: t(
            'Bridges the DO session to an upstream Realtime WebSocket with backpressure and error mapping.'
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
