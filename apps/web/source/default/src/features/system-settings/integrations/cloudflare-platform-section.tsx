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
import { type FormEvent, type ReactNode, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { getPlatformCapabilities, getTaskRunnerStatus } from '../api'
import { SettingsSection } from '../components/settings-section'
import type { PlatformCapabilities, TaskRunnerStatusProbe } from '../types'
import {
  buildPlatformReadinessSummary,
  getPlatformReadinessSignalLabel,
  type PlatformReadinessSignal,
  type PlatformReadinessStage,
} from './cloudflare-platform-readiness'

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
  const [taskRunnerTaskId, setTaskRunnerTaskId] = useState('task-smoke')
  const [taskRunnerProbeId, setTaskRunnerProbeId] = useState<string | null>(
    null
  )
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
  const taskRunnerStatusQuery = useQuery({
    queryKey: ['task-runner-status', taskRunnerProbeId],
    queryFn: async () => {
      if (!taskRunnerProbeId) {
        throw new Error('Task id is required')
      }
      const response = await getTaskRunnerStatus(taskRunnerProbeId)
      if (!response.success) {
        throw new Error(response.message || 'Failed to load')
      }
      return response.data
    },
    enabled: Boolean(taskRunnerProbeId),
    staleTime: 0,
  })

  const capabilities = capabilitiesQuery.data
  const normalizedTaskRunnerTaskId = normalizeTaskRunnerTaskId(taskRunnerTaskId)

  const handleTaskRunnerProbeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!normalizedTaskRunnerTaskId) return
    if (taskRunnerProbeId === normalizedTaskRunnerTaskId) {
      taskRunnerStatusQuery.refetch()
      return
    }
    setTaskRunnerProbeId(normalizedTaskRunnerTaskId)
  }

  return (
    <SettingsSection title={t('Cloudflare Platform')}>
      <div className='space-y-4'>
        <div className='flex flex-col gap-4 rounded-lg border p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='space-y-1'>
              <p className='text-sm font-medium'>
                {t('Cloudflare migration readiness')}
              </p>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'Rust Worker capability report grouped by implementation, runtime configuration, smoke evidence, and production cutover.'
                )}
              </p>
            </div>
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
          {capabilities ? (
            <PlatformReadinessHeadline capabilities={capabilities} />
          ) : null}
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

            <TaskRunnerStatusProbePanel
              capabilities={capabilities}
              error={taskRunnerStatusQuery.error}
              isFetching={taskRunnerStatusQuery.isFetching}
              normalizedTaskId={normalizedTaskRunnerTaskId}
              onSubmit={handleTaskRunnerProbeSubmit}
              onTaskIdChange={setTaskRunnerTaskId}
              status={taskRunnerStatusQuery.data}
              submittedTaskId={taskRunnerProbeId}
              taskId={taskRunnerTaskId}
              t={t}
            />

            <div className='rounded-lg border p-4'>
              <p className='text-sm font-medium'>
                {t('Production cutover notes')}
              </p>
              <ul className='text-muted-foreground mt-2 list-disc space-y-1 ps-5 text-xs'>
                <li>
                  {t(
                    'Configured WFP preview hosts are tenant-owned before central API routes and fail closed when dispatch is disabled.'
                  )}
                </li>
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

function PlatformReadinessHeadline(props: {
  capabilities: PlatformCapabilities
}) {
  const { t } = useTranslation()
  const stages = buildPlatformReadinessSummary(props.capabilities)

  return (
    <div className='grid gap-4 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4'>
      {stages.map((stage) => (
        <section
          key={stage.id}
          className='flex min-w-0 flex-col gap-2'
          aria-label={getReadinessStageTitle(stage, t)}
        >
          <div className='flex items-center justify-between gap-2'>
            <p className='text-xs font-medium'>
              {getReadinessStageTitle(stage, t)}
            </p>
            <StatusBadge
              variant={stage.complete ? 'success' : 'warning'}
              copyable={false}
            >
              {getReadinessStageCount(stage, t)}
            </StatusBadge>
          </div>
          <ul className='flex flex-col gap-1.5'>
            {stage.signals.map((signal) => (
              <li
                key={signal.id}
                className='flex min-w-0 items-center justify-between gap-2 text-xs'
              >
                <span className='text-muted-foreground min-w-0 truncate'>
                  {t(getPlatformReadinessSignalLabel(signal.id))}
                </span>
                <StatusBadge
                  type='text'
                  variant={getReadinessSignalVariant(signal)}
                  copyable={false}
                  className='shrink-0'
                >
                  {getReadinessSignalStatus(signal, t)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function getReadinessStageTitle(
  stage: PlatformReadinessStage,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  switch (stage.id) {
    case 'implementation':
      return t('Implementation')
    case 'configuration':
      return t('Runtime configuration')
    case 'smoke':
      return t('Smoke evidence')
    case 'cutover':
      return t('Production cutover')
  }
}

function getReadinessStageCount(
  stage: PlatformReadinessStage,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (stage.id === 'smoke') {
    return t('{{verified}}/{{total}} verified', {
      verified: stage.verifiedCount,
      total: stage.signals.length,
    })
  }
  return t('{{ready}}/{{total}} ready', {
    ready: stage.readyCount,
    total: stage.signals.length,
  })
}

function getReadinessSignalStatus(
  signal: PlatformReadinessSignal,
  t: (key: string) => string
) {
  switch (signal.status) {
    case 'ready':
      return t('Ready')
    case 'verified':
      return t('Verified')
    case 'ready-to-verify':
      return t('Ready to verify')
    case 'blocked':
      return t('Blocked')
  }
}

function getReadinessSignalVariant(
  signal: PlatformReadinessSignal
): StatusVariant {
  return signal.status === 'ready' || signal.status === 'verified'
    ? 'success'
    : 'warning'
}

function buildCapabilityGroups(
  capabilities: PlatformCapabilities,
  t: (key: string, options?: Record<string, unknown>) => string
): CapabilityGroup[] {
  const relayAiGatewayRoutes =
    capabilities.relay_ai_gateway_rest_routes.join(', ') || t('No routes')
  const relayAiGatewayModelPrefixes =
    capabilities.relay_ai_gateway_model_prefixes.join(', ') || t('No prefixes')
  const relayAiGatewayDirectFallbackPrefixes =
    capabilities.relay_ai_gateway_direct_fallback_prefixes.join(', ') ||
    t('No prefixes')
  const relayAiGatewayGuards =
    capabilities.relay_ai_gateway_cutover_guards.join(', ') || t('No guards')
  const relayModelFallbackGuards =
    capabilities.relay_ai_gateway_cross_model_fallback_cutover_guards.join(
      ', '
    ) || t('No guards')
  const realtimeSessionGuards =
    capabilities.realtime_session_cutover_guards.join(', ') || t('No guards')
  const wfpTenantRoutes =
    capabilities.wfp_tenant_supported_routes.join(', ') || t('No routes')
  const wfpTenantGuards =
    capabilities.wfp_tenant_cutover_guards.join(', ') || t('No guards')
  const schedulingGatewayPrecedence =
    capabilities.scheduling_gateway_route_precedence.join(' -> ') ||
    t('Unavailable')

  return [
    {
      title: t('Scheduling gateway'),
      description: t(
        'Request ownership before Cloudflare bindings and compatibility routes execute.'
      ),
      rows: [
        {
          label: t('Owner planner'),
          description: t('Contract version {{version}}; {{precedence}}.', {
            version: capabilities.scheduling_gateway_owner_contract_version,
            precedence: schedulingGatewayPrecedence,
          }),
          ready:
            capabilities.scheduling_gateway_compiled &&
            capabilities.scheduling_gateway_active,
          readyLabel: t('Active'),
          missingLabel: t('Inactive'),
        },
        {
          label: t('WFP preview isolation'),
          description: t(
            'Configured tenant preview hosts never fall back to the main application when dispatch is disabled.'
          ),
          ready: capabilities.scheduling_gateway_preview_fail_closed_compiled,
          readyLabel: t('Fail closed'),
          missingLabel: t('Fallback risk'),
        },
      ],
    },
    {
      title: t('Runtime bindings'),
      description: t('Cloudflare bindings required by the Rust relay gateway.'),
      rows: [
        {
          label: t('D1 migration ledger'),
          description: t('{{count}} migrations applied; latest {{latest}}.', {
            count: capabilities.d1_migration_applied_count,
            latest: capabilities.d1_migration_latest || t('Unavailable'),
          }),
          ready: capabilities.d1_migration_status_available,
          readyLabel: t('Available'),
          missingLabel: t('Unavailable'),
        },
        {
          label: t('D1 schema readiness'),
          description: t(
            'Requires the exact migration set through {{migration}}.',
            {
              migration: capabilities.d1_expected_migration,
            }
          ),
          ready: capabilities.d1_migration_ready,
          readyLabel: t('Ready'),
          missingLabel: !capabilities.d1_migration_status_available
            ? t('Unavailable')
            : capabilities.d1_expected_migration_applied
              ? t('Ledger mismatch')
              : t('Migration missing'),
        },
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
          label: t('Model provider registry'),
          description: t('Accepted REST model prefixes: {{prefixes}}', {
            prefixes: relayAiGatewayModelPrefixes,
          }),
          ready: capabilities.relay_ai_gateway_model_prefixes.length > 0,
          readyLabel: t('{{count}} prefixes', {
            count: capabilities.relay_ai_gateway_model_prefixes.length,
          }),
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
            'Retries only when the selected channel matches a registered provider prefix: {{prefixes}}. Gateway auth and rate-limit responses fail closed.',
            { prefixes: relayAiGatewayDirectFallbackPrefixes }
          ),
          ready: capabilities.relay_ai_gateway_same_channel_fallback_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Cross-model fallback contract'),
          description: t(
            'Revalidates token model limits, reselects D1 channels, re-runs billing reservation, and records requested-versus-served model evidence.'
          ),
          ready: capabilities.relay_ai_gateway_cross_model_fallback_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Actual serving group billing'),
          description: t(
            'Reserves across candidate groups and settles against the group that served the final cross-model response.'
          ),
          ready:
            capabilities.relay_ai_gateway_cross_model_actual_group_billing_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Actual-group billing binding smoke'),
          description: t(
            'Exposes the default-off staging probe that exercises maximum reservation, selected-group settlement, and exhausted-plan refund through the Worker D1 binding.'
          ),
          ready:
            capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Actual-group billing smoke gate'),
          description: t(
            'Requires the dedicated staging smoke flag before the probe can mutate isolated billing fixtures.'
          ),
          ready:
            capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Disabled'),
          missingVariant: 'neutral',
        },
        {
          label: t('Actual-group billing smoke readiness'),
          description: t(
            'Ready means the compiled probe and staging gate can collect evidence; it does not mean the replay is verified or production cutover is approved.'
          ),
          ready:
            capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_ready,
          readyLabel: t('Ready to verify'),
          missingLabel: t('Blocked'),
          missingVariant:
            capabilities.relay_ai_gateway_actual_group_billing_staging_smoke_enabled
              ? 'warning'
              : 'neutral',
        },
        {
          label: t('Terminal attempt audit'),
          description: t(
            'Persists a Go-compatible error log with a bounded, secret-free channel-attempt ledger when no upstream response survives.'
          ),
          ready:
            capabilities.relay_ai_gateway_cross_model_terminal_audit_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Cross-model fallback gate'),
          description: t('Runtime flag RELAY_MODEL_FALLBACK_ENABLED.'),
          ready: capabilities.relay_ai_gateway_cross_model_fallback_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: 'neutral',
        },
        {
          label: t('Fallback model mappings'),
          description:
            capabilities.relay_ai_gateway_cross_model_fallback_config_valid
              ? t('{{count}} validated primary-to-fallback mappings.', {
                  count:
                    capabilities.relay_ai_gateway_cross_model_fallback_mapping_count,
                })
              : t('RELAY_MODEL_FALLBACKS_JSON is invalid.'),
          ready:
            capabilities.relay_ai_gateway_cross_model_fallback_configured &&
            capabilities.relay_ai_gateway_cross_model_fallback_config_valid,
          readyLabel: t('{{count}} mappings', {
            count:
              capabilities.relay_ai_gateway_cross_model_fallback_mapping_count,
          }),
          missingLabel:
            capabilities.relay_ai_gateway_cross_model_fallback_config_valid
              ? t('Not configured')
              : t('Invalid'),
        },
        {
          label: t('Cross-model runtime readiness'),
          description: t(
            'Requires the AI Gateway router, explicit fallback gate, and a validated mapping set.'
          ),
          ready: capabilities.relay_ai_gateway_cross_model_fallback_ready,
          readyLabel: t('Ready to verify'),
          missingLabel: t('Blocked'),
        },
        {
          label: t('Cross-model staging replay'),
          description: t(
            'Requires archived primary failure, fallback identity, single settlement, audit, and rollback evidence.'
          ),
          ready:
            capabilities.relay_ai_gateway_cross_model_fallback_staging_verified,
          readyLabel: t('Verified'),
          missingLabel: t('Required'),
          missingVariant: 'warning',
        },
        {
          label: t('Cross-model cutover guards'),
          description: t('Compiled guards: {{guards}}', {
            guards: relayModelFallbackGuards,
          }),
          ready:
            capabilities.relay_ai_gateway_cross_model_fallback_cutover_guards
              .length > 0,
          readyLabel: t('{{count}} guards', {
            count:
              capabilities.relay_ai_gateway_cross_model_fallback_cutover_guards
                .length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('Cross-model production cutover'),
          description: t(
            'Remains blocked until runtime readiness and staging replay are both true.'
          ),
          ready:
            capabilities.relay_ai_gateway_cross_model_fallback_cutover_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Blocked'),
          missingVariant: 'warning',
        },
        {
          label: t('Router canary readiness'),
          description: t(
            'Runtime prerequisites for an AI Gateway traffic canary: account, gateway ID, token, and explicit router gate.'
          ),
          ready: capabilities.relay_ai_gateway_router_ready,
          readyLabel: t('Ready to verify'),
          missingLabel: t('Blocked'),
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
          label: t('Dispatch failure contract'),
          description: t('Version {{version}}: {{classes}}.', {
            version: capabilities.wfp_dispatch_failure_contract_version,
            classes:
              capabilities.wfp_dispatch_failure_classes.join(', ') ||
              t('Unavailable'),
          }),
          ready: capabilities.wfp_dispatch_failure_contract_compiled,
          readyLabel: t('Fail closed'),
          missingLabel: t('Unstructured'),
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
          label: t('Tenant authority verifier'),
          description: t(
            'Verifies the short-lived worker, path, method, and exact-body signature with a tenant-scoped derived key; the platform master secret is never bound to the tenant.'
          ),
          ready: capabilities.wfp_tenant_relay_authority_verifier_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Central relay WFP transport'),
          description: t(
            'Allows channel other_info.wfp_worker only after central token authentication, D1 selection, quota reservation, and a short-lived worker/path/body-bound authority signature.'
          ),
          ready: capabilities.wfp_relay_authority_transport_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('WFP relay transport gate'),
          description: t(
            'Uses a dedicated default-off gate that is independent from the admin status-dispatch gate.'
          ),
          ready: capabilities.wfp_relay_transport_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Disabled'),
          missingVariant: 'neutral',
        },
        {
          label: t('WFP canary relay retries'),
          description: t(
            'Paid WFP smoke requires RELAY_RETRY_TIMES=0 so one CLI invocation cannot fan out to multiple provider calls.'
          ),
          ready: capabilities.relay_retry_times === 0,
          readyLabel: t('0 retries'),
          missingLabel:
            capabilities.relay_retry_times === null
              ? t('Invalid')
              : t('{{count}} retries', {
                  count: capabilities.relay_retry_times,
                }),
          missingVariant: capabilities.wfp_relay_transport_enabled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('WFP authority secret'),
          description: t(
            'Keeps the WFP_RELAY_AUTHORITY_SECRET master only in the main Worker and uploader; each tenant receives a derived worker-scoped key.'
          ),
          ready: capabilities.wfp_relay_authority_secret_configured,
          readyLabel: t('Configured'),
          missingLabel: t('Missing'),
          missingVariant: capabilities.wfp_relay_transport_enabled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('WFP authority replay Durable Object'),
          description: t(
            'Requires the platform-owned WFP_AUTHORITY_REPLAY binding before a tenant can perform paid AI egress.'
          ),
          ready: capabilities.wfp_authority_replay_do_available,
          readyLabel: t('Bound'),
          missingLabel: t('Missing'),
          missingVariant: capabilities.wfp_relay_transport_enabled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('WFP replay guard contract'),
          description: t(
            'Compiles atomic signed-request consumption and fail-closed duplicate/service-error handling; deployed replay evidence is required separately.'
          ),
          ready: capabilities.wfp_authority_replay_do_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('WFP relay authority readiness'),
          description: t(
            'Ready means the signed central transport can be tested; it does not mean billing replay or production cutover has been verified.'
          ),
          ready: capabilities.wfp_relay_authority_transport_ready,
          readyLabel: t('Ready to verify'),
          missingLabel: t('Blocked'),
          missingVariant: capabilities.wfp_relay_transport_enabled
            ? 'warning'
            : 'neutral',
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
          label: t('Preview browser security boundary'),
          description: t(
            'Strips Service-Worker-Allowed, Service-Worker-Navigation-Preload, and Clear-Site-Data from regular preview HTTP responses while preserving WebSocket upgrades.'
          ),
          ready: capabilities.wfp_preview_response_security_headers_compiled,
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
          label: t('Outbound AI REST egress'),
          description: t(
            'Keeps the Cloudflare AI token in the outbound Worker and permits only exact Cloudflare AI REST routes.'
          ),
          ready: capabilities.wfp_outbound_egress_policy_compiled,
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
          label: t('TaskRunner storage-failure alarm retry contract'),
          description: t(
            'Compiled fail-closed contract keeps storage read and decode failures retryable by the alarm; runtime behavior is not verified by this signal.'
          ),
          ready: capabilities.task_runner_storage_error_retry_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('TaskRunner recurring alarm contract'),
          description: t(
            'Re-arms non-terminal progress, retries transient failures with bounded backoff, and hands work back to cron after the fast-path horizon.'
          ),
          ready: capabilities.task_runner_rearm_contract_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('TaskRunner fast path gate'),
          description: t(
            'TASK_RUNNER_DO_ENABLED must stay off until staging alarm replay and rollback evidence are proven.'
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
            'Successful video/Suno task inserts can arm the per-task alarm when the fast path gate is enabled.'
          ),
          ready: capabilities.task_runner_submit_path_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Pending'),
          missingVariant: 'neutral',
        },
        {
          label: t('TaskRunner poll path'),
          description: t(
            'Alarm firing can reuse the shared provider poll and CAS settlement path, while cron remains the fallback authority.'
          ),
          ready: capabilities.task_runner_poll_path_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Pending'),
          missingVariant: 'neutral',
        },
        {
          label: t('TaskRunner status probe'),
          description: t(
            'Admin-only read probe exposes the per-task Durable Object alarm and poll evidence without arming or deleting alarms.'
          ),
          ready: capabilities.task_runner_status_probe_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Pending'),
          missingVariant: 'neutral',
        },
        {
          label: t('TaskRunner staging replay'),
          description: t(
            'Requires archived alarm-fire, provider-poll, cron-fallback, and no-double-settlement evidence before cutover.'
          ),
          ready: capabilities.task_runner_staging_replay_verified,
          readyLabel: t('Verified'),
          missingLabel: t('Required'),
          missingVariant: capabilities.task_runner_do_enabled
            ? 'warning'
            : 'neutral',
        },
        {
          label: t('TaskRunner cutover guards'),
          description: t('Compiled guards: {{guards}}', {
            guards:
              capabilities.task_runner_cutover_guards.join(', ') ||
              t('No guards'),
          }),
          ready: capabilities.task_runner_cutover_guards.length > 0,
          readyLabel: t('{{count}} guards', {
            count: capabilities.task_runner_cutover_guards.length,
          }),
          missingLabel: t('Missing'),
        },
        {
          label: t('TaskRunner cutover readiness'),
          description: t(
            'Requires the Durable Object binding and gate, compiled submit, poll, storage-error retry and status paths, plus verified staging replay.'
          ),
          ready: capabilities.task_runner_cutover_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Blocked'),
          missingVariant: capabilities.task_runner_do_enabled
            ? 'warning'
            : 'neutral',
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
          label: t('Realtime settlement write gate'),
          description: t(
            'Runtime flag REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED. The public /v1/realtime upgrade fails closed while this gate is off.'
          ),
          ready: capabilities.realtime_session_billing_settlement_write_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Off'),
          missingVariant: capabilities.realtime_session_v1_enabled
            ? 'warning'
            : 'neutral',
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
          label: t('Hibernation fail-closed bridge'),
          description: t(
            'Closes a resumed Realtime session with redacted terminal evidence when transient upstream bridge state is unavailable after hibernation.'
          ),
          ready:
            capabilities.realtime_session_upstream_bridge_hibernation_fail_closed_compiled,
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
          label: t('Realtime usage capture'),
          description: t(
            'Captures response.done usage token metadata into DO metrics without storing raw upstream frames or secrets; final billing settlement remains separately gated.'
          ),
          ready: capabilities.realtime_session_upstream_usage_capture_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime per-response reservation'),
          description: t(
            'Requires explicit response.create events, disables automatic VAD responses, freezes request-aware billing input, and atomically reserves estimated quota before upstream inference.'
          ),
          ready:
            capabilities.realtime_session_billing_presettlement_snapshot_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing settlement preview'),
          description: t(
            'Computes redacted final/refund/additional quota metadata from a frozen tiered snapshot and response.done usage without applying quota yet.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_preview_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing settlement handoff'),
          description: t(
            'Keeps the full tiered snapshot and request probe in the internal connect handoff so the Durable Object can compute redacted settlement preview metrics without persisting raw billing rules.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_handoff_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing mutation plan'),
          description: t(
            'Carries private user, token, channel, and per-response reserved quota identifiers while exposing only redacted readiness metadata to operators.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_mutation_plan_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing D1 writer'),
          description: t(
            'Applies reserved-to-settled or reserved-to-refunded CAS transitions so retries and duplicate response.done events cannot charge or credit quota twice.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_writer_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing replay marker'),
          description: t(
            'Records a durable D1 marker for applied Realtime settlement keys and skips duplicate replay attempts without exposing private user, token, or channel identifiers in DO metrics.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_replay_marker_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing audit log'),
          description: t(
            'Can write Go-compatible logs rows for applied Realtime settlement with redacted tiered billing metadata when the settlement writer is explicitly enabled.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_audit_log_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime billing settlement batch'),
          description: t(
            'Binds response.created identities in sequence order, then settles each response.done against its exact reservation with CAS, replay marker, guarded quota mutations, and a Go-compatible audit row.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_batch_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime bridge billing isolation'),
          description: t(
            'Scopes reservation creation, response binding, settlement lookup, and terminal refund to one persisted bridge segment so concurrent or reconnected sockets in the same Durable Object cannot mutate each other.'
          ),
          ready:
            capabilities.d1_migration_ready &&
            capabilities.realtime_session_billing_settlement_batch_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Blocked'),
        },
        {
          label: t('Realtime reservation lease recovery'),
          description: t(
            'Persists active response reservations across Durable Object hibernation and refunds expired work after {{seconds}} seconds through the same single-alarm scheduler.',
            {
              seconds:
                capabilities.realtime_session_billing_reservation_lease_seconds,
            }
          ),
          ready:
            capabilities.realtime_session_billing_reservation_lease_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime global orphan recovery'),
          description: t(
            'After a {{grace}}-second settlement grace period, scans up to {{limit}} globally expired D1 reservations per cron run, reuses the atomic refund CAS, and exposes only hashed reservation and bridge outcomes to administrators.',
            {
              grace:
                capabilities.realtime_session_billing_orphan_recovery_grace_seconds,
              limit:
                capabilities.realtime_session_billing_orphan_sweep_limit,
            }
          ),
          ready:
            capabilities.realtime_session_billing_global_orphan_recovery_ready &&
            capabilities.realtime_session_billing_ledger_status_compiled,
          readyLabel: t('Ready'),
          missingLabel: capabilities.realtime_session_billing_global_orphan_recovery_enabled
            ? t('Blocked')
            : t('Disabled'),
          missingVariant: capabilities.realtime_session_billing_global_orphan_recovery_enabled
            ? 'red'
            : 'grey',
        },
        {
          label: t('Realtime settlement retry'),
          description: t(
            'Persists up to 64 independent failed settlements in the session Durable Object and schedules the earliest due item through one bounded-backoff alarm without overwriting another response.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_retry_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime settlement binding smoke'),
          description: t(
            'Exposes the default-off, admin-only staging probe that runs the fixed settlement scenarios through the deployed Worker D1 binding path.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_staging_smoke_compiled,
          readyLabel: t('Compiled'),
          missingLabel: t('Missing'),
        },
        {
          label: t('Realtime settlement smoke gate'),
          description: t(
            'Requires REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED=true in staging before the binding smoke route can write isolated smoke rows.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_staging_smoke_enabled,
          readyLabel: t('Enabled'),
          missingLabel: t('Disabled'),
          missingVariant: 'neutral',
        },
        {
          label: t('Realtime settlement smoke readiness'),
          description: t(
            'Ready only when the settlement batch, fixed smoke route, and staging gate are all present for archived Worker-binding evidence.'
          ),
          ready:
            capabilities.realtime_session_billing_settlement_staging_smoke_ready,
          readyLabel: t('Ready'),
          missingLabel: t('Blocked'),
          missingVariant:
            capabilities.realtime_session_billing_settlement_staging_smoke_enabled
              ? 'warning'
              : 'neutral',
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
          label: t('Platform admin boundary'),
          description: t(
            'Requires AdminAuth before platform Realtime WebSocket or status requests can resolve and touch a session Durable Object.'
          ),
          ready: capabilities.realtime_session_platform_admin_auth_compiled,
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
          label: t('v1 cutover readiness'),
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

function TaskRunnerStatusProbePanel(props: {
  capabilities: PlatformCapabilities
  error: Error | null
  isFetching: boolean
  normalizedTaskId: string
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTaskIdChange: (value: string) => void
  status: TaskRunnerStatusProbe | undefined
  submittedTaskId: string | null
  taskId: string
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const {
    capabilities,
    error,
    isFetching,
    normalizedTaskId,
    onSubmit,
    onTaskIdChange,
    status,
    submittedTaskId,
    taskId,
    t,
  } = props
  const durable = status?.durable_object_status
  const canProbe =
    capabilities.task_runner_status_probe_compiled && Boolean(normalizedTaskId)
  const normalizedHint =
    normalizedTaskId && normalizedTaskId !== taskId.trim()
      ? t('Will query sanitized id: {{taskId}}', {
          taskId: normalizedTaskId,
        })
      : null

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>{t('TaskRunner status probe')}</p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Read the per-task Durable Object alarm and poll evidence without arming or deleting alarms.'
            )}
          </p>
        </div>
        <StatusBadge
          variant={
            capabilities.task_runner_status_probe_compiled
              ? 'success'
              : 'warning'
          }
          copyable={false}
          className='shrink-0'
        >
          {capabilities.task_runner_status_probe_compiled
            ? t('Probe compiled')
            : t('Probe unavailable')}
        </StatusBadge>
      </div>

      <form
        className='mt-3 flex flex-col gap-2 sm:flex-row'
        onSubmit={onSubmit}
      >
        <Input
          aria-label={t('TaskRunner task id')}
          autoComplete='off'
          className='sm:max-w-sm'
          disabled={!capabilities.task_runner_status_probe_compiled}
          onChange={(event) => onTaskIdChange(event.target.value)}
          placeholder={t('task-smoke')}
          value={taskId}
        />
        <Button
          type='submit'
          variant='outline'
          disabled={!canProbe || isFetching}
        >
          {isFetching ? t('Querying...') : t('Query status')}
        </Button>
      </form>
      {normalizedHint ? (
        <p className='text-muted-foreground mt-2 text-xs'>{normalizedHint}</p>
      ) : null}

      {error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {status && durable ? (
        <div className='mt-4 space-y-3'>
          <div className='flex flex-wrap gap-2'>
            <StatusBadge
              variant={taskRunnerStatusVariant(durable.status)}
              copyable={false}
            >
              {formatProbeStatus(durable.status, t)}
            </StatusBadge>
            <StatusBadge
              variant={taskRunnerPollStatusVariant(durable.poll_status)}
              copyable={false}
            >
              {durable.poll_status
                ? t('Poll {{status}}', {
                    status: formatSnakeCase(durable.poll_status),
                  })
                : t('Poll not attempted')}
            </StatusBadge>
            <StatusBadge
              variant={taskRunnerCasVariant(durable.poll_cas_won)}
              copyable={false}
            >
              {formatCasWon(durable.poll_cas_won, t)}
            </StatusBadge>
            <StatusBadge
              variant={taskRunnerReplayEvidenceVariant(durable.replay_evidence)}
              copyable={false}
            >
              {formatReplayEvidence(durable.replay_evidence, t)}
            </StatusBadge>
          </div>
          <dl className='grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4'>
            <ProbeField label={t('Requested task')} value={status.task_id} />
            <ProbeField label={t('DO instance')} value={status.instance} />
            <ProbeField
              label={t('Stored task')}
              value={durable.task_id ?? t('No record')}
            />
            <ProbeField
              label={t('Alarm delay')}
              value={formatMilliseconds(durable.alarm_delay_ms, t)}
            />
            <ProbeField
              label={t('Alarm scheduled')}
              value={formatTimestamp(durable.alarm_scheduled_at_ms, t)}
            />
            <ProbeField
              label={t('Alarm fired')}
              value={formatTimestamp(durable.alarm_fired_at_ms, t)}
            />
            <ProbeField
              label={t('Fired count')}
              value={String(durable.alarm_fired_count ?? 0)}
            />
            <ProbeField
              label={t('Rearm count')}
              value={String(durable.rearm_count ?? 0)}
            />
            <ProbeField
              label={t('Last rearmed')}
              value={formatTimestamp(durable.last_rearmed_at_ms, t)}
            />
            <ProbeField
              label={t('Last rearm delay')}
              value={formatMilliseconds(durable.last_rearm_delay_ms, t)}
            />
            <ProbeField
              label={t('Fast-path horizon')}
              value={String(durable.max_alarm_fires ?? 0)}
            />
            <ProbeField
              label={t('Consecutive failures')}
              value={String(durable.consecutive_failures ?? 0)}
            />
            <ProbeField
              label={t('Observed terminal')}
              value={formatObservedTerminal(durable.poll_terminal, t)}
            />
            <ProbeField
              label={t('Cron fallback')}
              value={durable.cron_fallback_reason ?? t('Not active')}
            />
            <ProbeField
              label={t('Poll attempted')}
              value={formatTimestamp(durable.poll_attempted_at_ms, t)}
            />
            <ProbeField
              label={t('Poll completed')}
              value={formatTimestamp(durable.poll_completed_at_ms, t)}
            />
            <ProbeField
              label={t('Poll reason')}
              value={durable.poll_reason ?? t('No reason')}
            />
            <ProbeField
              label={t('Replay evidence')}
              value={formatReplayEvidence(durable.replay_evidence, t)}
            />
            <ProbeField
              label={t('Last queried task')}
              value={submittedTaskId ?? t('None')}
            />
            <ProbeField
              label={t('Compiled')}
              value={durable.compiled ? t('Yes') : t('No')}
            />
          </dl>
        </div>
      ) : null}
    </div>
  )
}

function ProbeField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='min-w-0 space-y-0.5'>
      <dt className='text-muted-foreground text-xs'>{label}</dt>
      <dd className='truncate text-sm font-medium' title={String(value)}>
        {value}
      </dd>
    </div>
  )
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

function normalizeTaskRunnerTaskId(value: string) {
  return value.slice(0, 128).replace(/[^A-Za-z0-9_-]/g, '')
}

function formatProbeStatus(
  status: TaskRunnerStatusProbe['durable_object_status']['status'],
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return status
    ? t('Status {{status}}', {
        status: formatSnakeCase(status),
      })
    : t('No TaskRunner record')
}

function taskRunnerStatusVariant(
  status: TaskRunnerStatusProbe['durable_object_status']['status']
): StatusVariant {
  if (status === 'poll_applied') return 'success'
  if (status === 'poll_progressed') return 'info'
  if (status === 'poll_failed') return 'danger'
  if (status === 'poll_noop' || status === 'poll_skipped') return 'warning'
  if (status === 'alarm_fired') return 'info'
  if (status === 'armed') return 'warning'
  return 'neutral'
}

function taskRunnerPollStatusVariant(
  status: TaskRunnerStatusProbe['durable_object_status']['poll_status']
): StatusVariant {
  if (status === 'applied') return 'success'
  if (status === 'progressed') return 'info'
  if (status === 'failed') return 'danger'
  if (status === 'noop' || status === 'skipped') return 'warning'
  return 'neutral'
}

function taskRunnerCasVariant(value: boolean | null): StatusVariant {
  if (value === true) return 'success'
  if (value === false) return 'warning'
  return 'neutral'
}

function taskRunnerReplayEvidenceVariant(
  evidence: TaskRunnerStatusProbe['durable_object_status']['replay_evidence']
): StatusVariant {
  if (evidence === 'first_apply' || evidence === 'second_replay_noop') {
    return 'success'
  }
  if (evidence === 'progress_applied') return 'info'
  if (
    evidence === 'gate_disabled_fallback' ||
    evidence === 'cron_already_settled' ||
    evidence === 'armed_pending' ||
    evidence === 'alarm_fired_pending_poll' ||
    evidence === 'nonterminal_cas_noop' ||
    evidence === 'poll_skipped'
  ) {
    return 'warning'
  }
  if (evidence === 'poll_failed') return 'danger'
  return 'neutral'
}

function formatCasWon(
  value: boolean | null,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (value === true) return t('CAS won')
  if (value === false) return t('CAS no-op')
  return t('CAS not recorded')
}

function formatObservedTerminal(
  value: boolean | null,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (value === true) return t('Terminal')
  if (value === false) return t('Non-terminal')
  return t('Not observed')
}

function formatReplayEvidence(
  evidence: TaskRunnerStatusProbe['durable_object_status']['replay_evidence'],
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return t('Evidence {{evidence}}', {
    evidence: formatSnakeCase(evidence),
  })
}

function formatMilliseconds(
  value: number | null,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return typeof value === 'number'
    ? t('{{value}} ms', { value })
    : t('Not scheduled')
}

function formatTimestamp(
  value: number | null,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return typeof value === 'number'
    ? new Date(value).toLocaleString()
    : t('Not recorded')
}

function formatSnakeCase(value: string) {
  return value.replaceAll('_', ' ')
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
