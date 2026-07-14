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
import { type FormEvent, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { getWfpTenantPlan } from '../api'
import {
  EMPTY_WFP_TENANT_PLAN_INPUT,
  stringifyRedactedWfpTenantPlanArchive,
  validateWfpTenantPlanInput,
  type WfpTenantPlan,
  type WfpTenantPlanFormInput,
  type WfpTenantPlanValidationError,
} from './wfp-tenant-plan'

type Translate = (key: string, options?: Record<string, unknown>) => string

const VALIDATION_MESSAGES: Record<WfpTenantPlanValidationError, string> = {
  script_name_required: 'Enter a tenant Worker name.',
  script_name_invalid:
    'Worker names must use 1-63 lowercase letters, numbers, hyphens, or underscores and cannot start or end with punctuation.',
  tenant_id_invalid:
    'Tenant IDs must be header-safe and at most 128 characters.',
  dispatch_namespace_invalid:
    'Dispatch namespaces must use at most 64 letters, numbers, hyphens, or underscores.',
  compatibility_date_invalid: 'Compatibility dates must use YYYY-MM-DD.',
}

export function WfpTenantPlanPanel(props: { planningReady: boolean }) {
  const { planningReady } = props
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard({
    successMessage: t('Redacted WFP tenant plan copied'),
  })
  const [input, setInput] = useState<WfpTenantPlanFormInput>({
    ...EMPTY_WFP_TENANT_PLAN_INPUT,
  })
  const validationError = validateWfpTenantPlanInput(input)
  const planMutation = useMutation({
    mutationFn: async (planInput: WfpTenantPlanFormInput) => {
      const response = await getWfpTenantPlan(planInput)
      if (!response.success) {
        throw new Error(response.message || t('Failed to build tenant plan'))
      }
      return response.data
    },
  })

  const updateField = (key: keyof WfpTenantPlanFormInput, value: string) => {
    setInput((current) => ({ ...current, [key]: value }))
    planMutation.reset()
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!planningReady || validationError) return
    planMutation.mutate(input)
  }

  const handleCopy = () => {
    if (!planMutation.data) return
    void copyToClipboard(
      stringifyRedactedWfpTenantPlanArchive(planMutation.data)
    )
  }

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>{t('WFP Rust tenant plan')}</p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Review one dispatch-namespace Rust/Wasm tenant artifact before running the local deployment tool.'
            )}
          </p>
        </div>
        <StatusBadge
          variant={planningReady ? 'success' : 'neutral'}
          copyable={false}
          className='shrink-0'
        >
          {planningReady ? t('Planner ready') : t('Planner blocked')}
        </StatusBadge>
      </div>

      <form className='mt-4 space-y-4' onSubmit={handleSubmit}>
        <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
          <PlanInput
            id='wfp-script-name'
            label={t('Tenant Worker name')}
            onChange={(value) => updateField('scriptName', value)}
            placeholder={t('tenant-a')}
            required
            value={input.scriptName}
          />
          <PlanInput
            id='wfp-tenant-id'
            label={t('Tenant id')}
            onChange={(value) => updateField('tenantId', value)}
            placeholder={t('Defaults to Worker name')}
            value={input.tenantId}
          />
          <PlanInput
            id='wfp-dispatch-namespace'
            label={t('Dispatch namespace')}
            onChange={(value) => updateField('dispatchNamespace', value)}
            placeholder={t('Uses Worker configuration')}
            value={input.dispatchNamespace}
          />
          <PlanInput
            id='wfp-compatibility-date'
            label={t('Compatibility date')}
            onChange={(value) => updateField('compatibilityDate', value)}
            placeholder='YYYY-MM-DD'
            value={input.compatibilityDate}
          />
        </div>

        {validationError && input.scriptName.trim().length > 0 ? (
          <p className='text-destructive text-xs'>
            {t(VALIDATION_MESSAGES[validationError])}
          </p>
        ) : null}

        {!planningReady ? (
          <Alert>
            <AlertDescription>
              {t(
                'Planning stays disabled until both the tenant script planner and Rust/Wasm artifact contract are compiled.'
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {planMutation.error ? (
          <Alert variant='destructive'>
            <AlertDescription>
              {planMutation.error instanceof Error
                ? planMutation.error.message
                : t('Failed to build tenant plan')}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className='flex flex-wrap items-center gap-3'>
          <Button
            type='submit'
            variant='outline'
            disabled={
              !planningReady ||
              Boolean(validationError) ||
              planMutation.isPending
            }
          >
            {planMutation.isPending ? t('Building plan...') : t('Build plan')}
          </Button>
          <p className='text-muted-foreground text-xs'>
            {t(
              'This action never calls the deployment endpoint or sends a Cloudflare token to the browser.'
            )}
          </p>
        </div>
      </form>

      {planMutation.data ? (
        <WfpTenantPlanResult
          onCopy={handleCopy}
          plan={planMutation.data}
          t={t}
        />
      ) : null}
    </div>
  )
}

function PlanInput(props: {
  id: string
  label: string
  onChange: (value: string) => void
  placeholder: string
  required?: boolean
  value: string
}) {
  return (
    <div className='min-w-0 space-y-1.5'>
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        autoComplete='off'
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        required={props.required}
        spellCheck={false}
        value={props.value}
      />
    </div>
  )
}

function WfpTenantPlanResult(props: {
  onCopy: () => void
  plan: WfpTenantPlan
  t: Translate
}) {
  const { onCopy, plan, t } = props

  return (
    <div className='mt-4 space-y-4 border-t pt-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex flex-wrap gap-2'>
          <StatusBadge
            variant={plan.rust_wasm_runtime.available ? 'success' : 'danger'}
            copyable={false}
          >
            {plan.rust_wasm_runtime.available
              ? t('Rust artifact available')
              : t('Rust artifact missing')}
          </StatusBadge>
          <StatusBadge
            variant={plan.deployable ? 'warning' : 'neutral'}
            copyable={false}
          >
            {plan.deployable ? t('Control-plane deployable') : t('Plan only')}
          </StatusBadge>
          <StatusBadge
            variant={
              plan.tenant_cloudflare_token_attached ? 'danger' : 'success'
            }
            copyable={false}
          >
            {plan.tenant_cloudflare_token_attached
              ? t('Tenant token attached')
              : t('No tenant token')}
          </StatusBadge>
        </div>
        <Button type='button' size='sm' variant='outline' onClick={onCopy}>
          <Copy data-icon='inline-start' />
          {t('Copy redacted JSON')}
        </Button>
      </div>

      <dl className='grid gap-x-6 gap-y-3 text-sm md:grid-cols-2 xl:grid-cols-4'>
        <PlanValue label={t('Public Worker')} value={plan.public_script_name} />
        <PlanValue label={t('Uploaded Worker')} value={plan.script_name} />
        <PlanValue label={t('Tenant id')} value={plan.tenant_id} />
        <PlanValue
          label={t('Dispatch namespace')}
          value={plan.namespace ?? t('Missing')}
        />
        <PlanValue label={t('Module')} value={plan.module_name} />
        <PlanValue
          label={t('Compatibility date')}
          value={plan.compatibility_date}
        />
        <PlanValue
          label={t('Outbound authentication')}
          value={plan.outbound_auth_mode}
        />
        <PlanValue
          label={t('Artifact status')}
          value={plan.rust_wasm_runtime.deployment_status}
        />
      </dl>

      <div className='space-y-2'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <p className='text-xs font-medium'>{t('AI Gateway policy owner')}</p>
          <StatusBadge
            variant={
              plan.tenant_gateway_bindings_attached ? 'danger' : 'success'
            }
            copyable={false}
          >
            {plan.tenant_gateway_bindings_attached
              ? t('Tenant bindings attached')
              : t('Platform outbound only')}
          </StatusBadge>
        </div>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Gateway IDs, retries, cache, logging, and metadata are configured and rebuilt only by the platform outbound Worker.'
          )}
        </p>
      </div>

      <div className='space-y-1'>
        <p className='text-xs font-medium'>{t('Local artifact command')}</p>
        <code className='bg-muted block overflow-x-auto rounded px-3 py-2 text-xs'>
          {plan.rust_wasm_runtime.build_command}
        </code>
      </div>

      {plan.missing.length > 0 ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Missing runtime configuration')}:{' '}
            {plan.missing.map((requirement) => requirement.name).join(', ')}
          </AlertDescription>
        </Alert>
      ) : null}

      {plan.warnings.length > 0 ? (
        <div className='space-y-2'>
          <p className='text-xs font-medium'>{t('Plan warnings')}</p>
          <ul className='text-muted-foreground list-disc space-y-1 ps-5 text-xs'>
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function PlanValue(props: { label: string; value: string }) {
  return (
    <div className='min-w-0 space-y-0.5'>
      <dt className='text-muted-foreground text-xs'>{props.label}</dt>
      <dd className='font-mono text-xs break-all'>{props.value}</dd>
    </div>
  )
}
