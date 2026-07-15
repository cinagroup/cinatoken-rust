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
  applyTaskSubmitReconciliation,
  previewTaskSubmitReconciliation,
} from '../api'
import {
  compactTaskSubmitReconciliationId,
  isTaskProviderIdValid,
  type TaskSubmitReconciliationAction,
  type TaskSubmitReconciliationApplyRequest,
  type TaskSubmitReconciliationDecision,
  type TaskSubmitReconciliationPreview,
  type TaskSubmitReconciliationQueueRecord,
  type TaskSubmitReconciliationReason,
} from './task-submit-reconciliation'

export function TaskSubmitReconciliationWorkbench(props: {
  target: TaskSubmitReconciliationQueueRecord
  mutationEnabled: boolean
  onClose: () => void
}) {
  const { target, mutationEnabled, onClose } = props
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const initialAction: TaskSubmitReconciliationAction = target.attach_available
    ? 'attach'
    : 'refund'
  const [action, setAction] =
    useState<TaskSubmitReconciliationAction>(initialAction)
  const [reason, setReason] = useState<TaskSubmitReconciliationReason>(
    initialAction === 'attach'
      ? 'provider_task_verified'
      : 'provider_confirms_not_accepted'
  )
  const [providerTaskId, setProviderTaskId] = useState(target.provider_task_id)
  const [evidenceReference, setEvidenceReference] = useState('')
  const [preview, setPreview] =
    useState<TaskSubmitReconciliationPreview | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [riskOpen, setRiskOpen] = useState(false)

  const evidenceIsValid = /^[A-Za-z0-9._:/#@-]{1,128}$/u.test(evidenceReference)
  const providerIdIsValid =
    action === 'refund' || isTaskProviderIdValid(providerTaskId)
  const formIsValid = evidenceIsValid && providerIdIsValid
  const decision = useMemo<TaskSubmitReconciliationDecision>(
    () => ({
      action,
      reason,
      evidence_reference: evidenceReference,
      provider_task_id: action === 'attach' ? providerTaskId : '',
    }),
    [action, evidenceReference, providerTaskId, reason]
  )

  const previewMutation = useMutation({
    mutationFn: () =>
      previewTaskSubmitReconciliation(target.reconciliation_id, decision),
    onSuccess: (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      setPreview(response.data)
      setIdempotencyKey(crypto.randomUUID())
    },
  })
  const applyMutation = useMutation({
    mutationFn: (request: TaskSubmitReconciliationApplyRequest) =>
      applyTaskSubmitReconciliation(target.reconciliation_id, request),
    onSuccess: async (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      toast.success(t('Task submit reconciliation applied'))
      setRiskOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ['task-submit-reconciliation-queue'],
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
  const changeAction = (next: TaskSubmitReconciliationAction) => {
    setAction(next)
    setReason(
      next === 'attach'
        ? 'provider_task_verified'
        : 'provider_confirms_not_accepted'
    )
    invalidatePreview()
  }
  const applyPreview = async () => {
    if (!preview || !idempotencyKey) return
    try {
      await secureVerification.withVerification(
        () =>
          applyMutation.mutateAsync({
            ...decision,
            preview_token: preview.preview_token,
            idempotency_key: idempotencyKey,
            confirm_resolution: true,
          }),
        {
          title: t('Verify task submit reconciliation'),
          description: t(
            'Confirm your identity before attaching provider work or refunding reserved quota.'
          ),
        }
      )
    } catch {
      // Verification and mutation surfaces own their error presentation.
    }
  }

  const compactId = compactTaskSubmitReconciliationId(target.reconciliation_id)
  return (
    <div className='mt-4 space-y-4 border-t pt-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <p className='text-sm font-medium'>
            {t('Task submit reconciliation')}
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

      {!target.attach_available ? (
        <Alert>
          <AlertDescription>
            {t(
              'This legacy record has no frozen attachment contract and can only be refunded with verified evidence.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {!mutationEnabled ? (
        <Alert>
          <AlertDescription>
            {t(
              'Preview is available, but apply remains blocked by TASK_SUBMIT_RECONCILIATION_ENABLED.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className='grid gap-4 md:grid-cols-3'>
        <div className='space-y-2'>
          <Label>{t('Decision')}</Label>
          <Select
            value={action}
            onValueChange={(value) => value && changeAction(value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {target.attach_available ? (
                  <SelectItem value='attach'>{t('Attach')}</SelectItem>
                ) : null}
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
              setReason(value as TaskSubmitReconciliationReason)
              invalidatePreview()
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {action === 'attach' ? (
                  <>
                    <SelectItem value='provider_task_verified'>
                      {t('Provider task verified')}
                    </SelectItem>
                    <SelectItem value='provider_console_verified'>
                      {t('Provider console verified')}
                    </SelectItem>
                  </>
                ) : (
                  <>
                    <SelectItem value='provider_confirms_not_accepted'>
                      {t('Provider confirms not accepted')}
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
          <Label htmlFor='task-reconciliation-evidence'>
            {t('Evidence reference')}
          </Label>
          <Input
            id='task-reconciliation-evidence'
            value={evidenceReference}
            maxLength={128}
            placeholder='provider:console/task-123'
            aria-invalid={evidenceReference.length > 0 && !evidenceIsValid}
            onChange={(event) => {
              setEvidenceReference(event.target.value)
              invalidatePreview()
            }}
          />
        </div>
      </div>

      {action === 'attach' ? (
        <div className='space-y-2'>
          <Label htmlFor='task-reconciliation-provider-id'>
            {t('Provider task id')}
          </Label>
          <Input
            id='task-reconciliation-provider-id'
            value={providerTaskId}
            maxLength={256}
            className='font-mono'
            aria-invalid={providerTaskId.length > 0 && !providerIdIsValid}
            readOnly={target.provider_task_id.length > 0}
            onChange={(event) => {
              setProviderTaskId(event.target.value)
              invalidatePreview()
            }}
          />
        </div>
      ) : null}

      {previewMutation.error || applyMutation.error ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {errorMessage(previewMutation.error || applyMutation.error)}
          </AlertDescription>
        </Alert>
      ) : null}
      {preview ? (
        <div className='flex flex-wrap items-center gap-2 border-y py-3 text-sm'>
          <StatusBadge copyable={false} variant='warning'>
            {t('Reserved quota')}: {preview.quota}
          </StatusBadge>
          <StatusBadge copyable={false} variant='info'>
            {t('Task kind')}: {preview.task_kind}
          </StatusBadge>
          <StatusBadge copyable={false} variant='neutral'>
            {t('Funding')}: {preview.funding_source}
          </StatusBadge>
          <span className='text-muted-foreground font-mono text-xs'>
            {t('Public task')}: {preview.public_task_id}
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
        title={t('Apply irreversible task resolution')}
        description={t(
          'This either creates a pollable task and accounts the request, or refunds the frozen reserve. The decision is immutable.'
        )}
        items={[
          `${t('Decision')}: ${action}`,
          `${t('Reserved quota')}: ${preview?.quota ?? '-'}`,
          `${t('Evidence reference')}: ${evidenceReference}`,
        ]}
        checklist={[
          t('I verified the provider evidence against this exact task id.'),
          t('I reviewed the frozen contract hashes and quota outcome.'),
        ]}
        requiredText={`${action.toUpperCase()} ${target.reconciliation_id}`}
        inputPrompt={t('Type the decision and full reconciliation id')}
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

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Task submit reconciliation failed'
}
