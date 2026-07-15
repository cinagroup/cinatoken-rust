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
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, ShieldCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RiskAcknowledgementDialog } from '@/components/risk-acknowledgement-dialog'
import { StatusBadge } from '@/components/status-badge'
import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import {
  applyRealtimeBillingReconciliation,
  previewRealtimeBillingReconciliation,
} from '../api'
import {
  compactRealtimeBillingReconciliationId,
  type RealtimeBillingReconciliationAction,
  type RealtimeBillingReconciliationApplyRequest,
  type RealtimeBillingReconciliationDecision,
  type RealtimeBillingReconciliationPreview,
  type RealtimeBillingReconciliationQueueRecord,
  type RealtimeBillingReconciliationReason,
  type RealtimeBillingReconciliationUsage,
} from './realtime-billing-ledger'

type TokenField = keyof RealtimeBillingReconciliationUsage

const TOKEN_FIELDS: Array<{ field: TokenField; label: string }> = [
  { field: 'input_tokens', label: 'Input tokens' },
  { field: 'output_tokens', label: 'Output tokens' },
  { field: 'total_tokens', label: 'Total tokens' },
  { field: 'cached_tokens', label: 'Cached tokens' },
  { field: 'cache_creation_tokens', label: 'Cache creation tokens' },
  { field: 'image_input_tokens', label: 'Image input tokens' },
  { field: 'image_output_tokens', label: 'Image output tokens' },
  { field: 'audio_input_tokens', label: 'Audio input tokens' },
  { field: 'audio_output_tokens', label: 'Audio output tokens' },
]

const EMPTY_TOKENS = TOKEN_FIELDS.reduce<Record<TokenField, string>>(
  (values, item) => ({ ...values, [item.field]: '0' }),
  {} as Record<TokenField, string>
)

export function RealtimeBillingReconciliationWorkbench(props: {
  target: RealtimeBillingReconciliationQueueRecord
  mutationEnabled: boolean
  onClose: () => void
}) {
  const { target, mutationEnabled, onClose } = props
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const reconciliationId = target.reconciliation_id
  const [action, setAction] =
    useState<RealtimeBillingReconciliationAction>('settle')
  const [reason, setReason] = useState<RealtimeBillingReconciliationReason>(
    'provider_usage_verified'
  )
  const [evidenceReference, setEvidenceReference] = useState('')
  const [tokenValues, setTokenValues] = useState(EMPTY_TOKENS)
  const [preview, setPreview] =
    useState<RealtimeBillingReconciliationPreview | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [riskOpen, setRiskOpen] = useState(false)

  const usage = useMemo(() => parseUsage(tokenValues), [tokenValues])
  const totalIsConsistent =
    usage !== null &&
    usage.input_tokens + usage.output_tokens === usage.total_tokens
  const evidenceIsValid = /^[A-Za-z0-9._:/#@-]{1,128}$/u.test(evidenceReference)
  const formIsValid =
    reconciliationId.length === 64 &&
    evidenceIsValid &&
    (action === 'refund' || totalIsConsistent)

  const decision = useMemo<RealtimeBillingReconciliationDecision>(
    () => ({
      action,
      reason,
      evidence_reference: evidenceReference,
      usage: action === 'settle' ? usage : null,
    }),
    [action, evidenceReference, reason, usage]
  )

  const previewMutation = useMutation({
    mutationFn: () =>
      previewRealtimeBillingReconciliation(reconciliationId, decision),
    onSuccess: (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      setPreview(response.data)
      setIdempotencyKey(crypto.randomUUID())
    },
  })

  const applyMutation = useMutation({
    mutationFn: (request: RealtimeBillingReconciliationApplyRequest) =>
      applyRealtimeBillingReconciliation(reconciliationId, request),
    onSuccess: async (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      toast.success(t('Realtime billing reconciliation applied'))
      setRiskOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ['realtime-billing-ledger-status'],
      })
      onClose()
    },
  })

  const secureVerification = useSecureVerification({
    onError: () => undefined,
  })

  const invalidatePreview = () => {
    setPreview(null)
    setIdempotencyKey('')
    previewMutation.reset()
    applyMutation.reset()
  }

  const changeAction = (nextAction: RealtimeBillingReconciliationAction) => {
    setAction(nextAction)
    setReason(
      nextAction === 'settle'
        ? 'provider_usage_verified'
        : 'provider_confirms_no_billable_usage'
    )
    invalidatePreview()
  }

  const applyPreview = async () => {
    if (!preview || !idempotencyKey) return
    const request: RealtimeBillingReconciliationApplyRequest = {
      ...decision,
      preview_token: preview.preview_token,
      idempotency_key: idempotencyKey,
      confirm_resolution: true,
    }
    try {
      await secureVerification.withVerification(
        () => applyMutation.mutateAsync(request),
        {
          title: t('Verify Realtime billing reconciliation'),
          description: t(
            'Confirm your identity before mutating quota and closing this reconciliation.'
          ),
        }
      )
    } catch {
      // Mutation and verification errors are rendered by their owning surfaces.
    }
  }

  const previewError = previewMutation.error
  const applyError = applyMutation.error
  const compactId = compactRealtimeBillingReconciliationId(reconciliationId)

  return (
    <div className='mt-4 space-y-4 border-t pt-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <p className='text-sm font-medium'>
            {t('Realtime billing reconciliation')}
          </p>
          <p className='text-muted-foreground mt-1 font-mono text-xs'>
            {compactId} - {t('Revision')} {target.reconciliation_revision}
          </p>
        </div>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          aria-label={t('Close reconciliation workbench')}
          title={t('Close')}
          onClick={onClose}
        >
          <X className='h-4 w-4' />
        </Button>
      </div>

      {!mutationEnabled ? (
        <Alert>
          <AlertDescription>
            {t(
              'Preview is available, but apply remains blocked by REALTIME_BILLING_RECONCILIATION_ENABLED.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className='grid gap-4 md:grid-cols-3'>
        <div className='space-y-2'>
          <Label>{t('Decision')}</Label>
          <Select
            value={action}
            onValueChange={(value) => {
              if (value) changeAction(value)
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value='settle'>{t('Settle')}</SelectItem>
                <SelectItem value='refund'>{t('Refund')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-2'>
          <Label>{t('Evidence classification')}</Label>
          <Select
            value={reason}
            onValueChange={(value) => {
              if (!value) return
              setReason(value as RealtimeBillingReconciliationReason)
              invalidatePreview()
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {action === 'settle' ? (
                  <>
                    <SelectItem value='provider_usage_verified'>
                      {t('Provider usage verified')}
                    </SelectItem>
                    <SelectItem value='provider_invoice_verified'>
                      {t('Provider invoice verified')}
                    </SelectItem>
                  </>
                ) : (
                  <>
                    <SelectItem value='provider_confirms_no_billable_usage'>
                      {t('Provider confirms no billable usage')}
                    </SelectItem>
                    <SelectItem value='customer_refund_approved'>
                      {t('Customer refund approved')}
                    </SelectItem>
                  </>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='realtime-reconciliation-evidence'>
            {t('Evidence reference')}
          </Label>
          <Input
            id='realtime-reconciliation-evidence'
            value={evidenceReference}
            maxLength={128}
            placeholder='provider:invoice/2026-07#42'
            aria-invalid={evidenceReference.length > 0 && !evidenceIsValid}
            onChange={(event) => {
              setEvidenceReference(event.target.value)
              invalidatePreview()
            }}
          />
        </div>
      </div>

      {action === 'settle' ? (
        <div className='grid gap-3 sm:grid-cols-3'>
          {TOKEN_FIELDS.map(({ field, label }) => (
            <div key={field} className='space-y-2'>
              <Label htmlFor={`realtime-reconciliation-${field}`}>
                {t(label)}
              </Label>
              <Input
                id={`realtime-reconciliation-${field}`}
                inputMode='numeric'
                type='number'
                min={0}
                max={2147483647}
                step={1}
                value={tokenValues[field]}
                aria-invalid={
                  field === 'total_tokens' &&
                  usage !== null &&
                  !totalIsConsistent
                }
                onChange={(event) => {
                  setTokenValues((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                  invalidatePreview()
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {previewError ? (
        <Alert variant='destructive'>
          <AlertDescription>{errorMessage(previewError)}</AlertDescription>
        </Alert>
      ) : null}
      {applyError ? (
        <Alert variant='destructive'>
          <AlertDescription>{errorMessage(applyError)}</AlertDescription>
        </Alert>
      ) : null}

      {preview ? (
        <div className='flex flex-wrap items-center gap-2 border-y py-3 text-sm'>
          <StatusBadge copyable={false} variant='warning'>
            {t('Reserved quota')}: {preview.pre_consumed_quota}
          </StatusBadge>
          <StatusBadge copyable={false} variant='info'>
            {t('Final quota')}: {preview.final_quota}
          </StatusBadge>
          <StatusBadge copyable={false} variant='success'>
            {t('Refund quota')}: {preview.refund_quota}
          </StatusBadge>
          <StatusBadge copyable={false} variant='danger'>
            {t('Additional quota')}: {preview.additional_quota}
          </StatusBadge>
          <span className='text-muted-foreground text-xs'>
            {t('Pricing source')}: {t(humanizeCode(preview.pricing_source))}
          </span>
        </div>
      ) : null}

      <div className='flex flex-wrap justify-end gap-2'>
        <Button type='button' variant='outline' onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button
          type='button'
          variant='secondary'
          disabled={!formIsValid || previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending ? (
            <Loader2 className='h-4 w-4 animate-spin' />
          ) : null}
          {t('Preview decision')}
        </Button>
        <Button
          type='button'
          variant='destructive'
          disabled={!mutationEnabled || !preview || applyMutation.isPending}
          onClick={() => setRiskOpen(true)}
        >
          <ShieldCheck className='h-4 w-4' />
          {t('Apply resolution')}
        </Button>
      </div>

      <RiskAcknowledgementDialog
        open={riskOpen}
        onOpenChange={setRiskOpen}
        title={t('Apply irreversible billing resolution')}
        description={t(
          'This mutates user and token quota, closes the quarantine owner, and writes an immutable audit trail.'
        )}
        items={[
          `${t('Decision')}: ${t(humanizeCode(action))}`,
          `${t('Final quota')}: ${preview?.final_quota ?? '-'}`,
          `${t('Evidence reference')}: ${evidenceReference}`,
        ]}
        checklist={[
          t(
            'I verified the provider evidence against this exact reconciliation.'
          ),
          t('I reviewed the frozen pricing preview and quota delta.'),
        ]}
        requiredText={`${action.toUpperCase()} ${compactId}`}
        inputPrompt={t('Type the decision and reconciliation id shown above')}
        confirmText={t('Verify and apply')}
        isLoading={applyMutation.isPending || secureVerification.isLoading}
        onConfirm={() => void applyPreview()}
      />

      <SecureVerificationDialog
        open={secureVerification.open}
        onOpenChange={secureVerification.setOpen}
        methods={secureVerification.methods}
        state={secureVerification.state}
        onVerify={async (method, code) => {
          try {
            await secureVerification.executeVerification(method, code)
          } catch {
            // The hook owns verification error presentation.
          }
        }}
        onCancel={secureVerification.cancel}
        onCodeChange={secureVerification.setCode}
        onMethodChange={secureVerification.switchMethod}
      />
    </div>
  )
}

function parseUsage(
  values: Record<TokenField, string>
): RealtimeBillingReconciliationUsage | null {
  const parsed = TOKEN_FIELDS.reduce<
    Partial<RealtimeBillingReconciliationUsage>
  >((usage, { field }) => {
    const value = Number(values[field])
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      return usage
    }
    usage[field] = value
    return usage
  }, {})
  return TOKEN_FIELDS.every(({ field }) => parsed[field] !== undefined)
    ? (parsed as RealtimeBillingReconciliationUsage)
    : null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Realtime billing reconciliation failed'
}

function humanizeCode(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}
