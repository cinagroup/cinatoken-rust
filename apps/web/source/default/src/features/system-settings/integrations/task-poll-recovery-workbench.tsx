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
import { Loader2, RotateCcw, X } from 'lucide-react'
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
import { applyTaskPollRecovery, previewTaskPollRecovery } from '../api'
import {
  buildTaskPollRecoveryDecision,
  canApplyTaskPollRecovery,
  compactTaskPollRecoveryDigest,
  isTaskPollRecoveryEvidenceReferenceValid,
  taskPollRecoveryTargetKey,
  type TaskPollRecoveryApplyRequest,
  type TaskPollRecoveryPreview,
  type TaskPollRecoveryQueueRecord,
  type TaskPollRecoveryReason,
} from './task-poll-recovery'

export function TaskPollRecoveryWorkbench(props: {
  target: TaskPollRecoveryQueueRecord
  runtimeReady: boolean
  mutationEnabled: boolean
  onClose: () => void
}) {
  const { target, runtimeReady, mutationEnabled, onClose } = props
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState<TaskPollRecoveryReason>(
    'provider_task_verified'
  )
  const [evidenceReference, setEvidenceReference] = useState('')
  const [preview, setPreview] = useState<TaskPollRecoveryPreview | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [riskOpen, setRiskOpen] = useState(false)
  const applyEnabled = runtimeReady && mutationEnabled
  const timeoutEligible =
    target.timeout_eligible && (preview?.timeout_eligible ?? true)
  const canApply = canApplyTaskPollRecovery({
    runtimeReady,
    mutationEnabled,
    timeoutEligible,
  })
  const evidenceIsValid =
    isTaskPollRecoveryEvidenceReferenceValid(evidenceReference)
  const decision = useMemo(
    () => buildTaskPollRecoveryDecision(reason, evidenceReference),
    [evidenceReference, reason]
  )

  const previewMutation = useMutation({
    mutationFn: () =>
      previewTaskPollRecovery(target.entity_kind, target.entity_id, decision),
    onSuccess: (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      setPreview(response.data)
      setIdempotencyKey(crypto.randomUUID())
    },
  })
  const applyMutation = useMutation({
    mutationFn: (request: TaskPollRecoveryApplyRequest) =>
      applyTaskPollRecovery(target.entity_kind, target.entity_id, request),
    onSuccess: async (response) => {
      if (!response.success) throw new Error(response.message || 'Failed')
      toast.success(t('Task poll requeue applied'))
      setRiskOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ['task-poll-recovery-queue'],
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
  const applyPreview = async () => {
    if (!canApply || !preview || !idempotencyKey) return
    try {
      await secureVerification.withVerification(
        () =>
          applyMutation.mutateAsync({
            ...decision,
            preview_token: preview.preview_token,
            idempotency_key: idempotencyKey,
            confirm_requeue: true,
          }),
        {
          title: t('Verify task poll recovery'),
          description: t(
            'Root secure verification is required before this quarantined task poll can be requeued.'
          ),
        }
      )
    } catch {
      // Verification and mutation surfaces own their error presentation.
    }
  }

  const targetKey = taskPollRecoveryTargetKey(target)
  const compactHash = compactTaskPollRecoveryDigest(
    target.public_task_id_sha256
  )

  return (
    <div className='mt-4 space-y-4 border-t pt-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-sm font-medium'>{t('Recovery workbench')}</p>
          <p className='mt-1 truncate text-sm'>{target.task_reference}</p>
          <p className='text-muted-foreground font-mono text-xs'>
            {compactHash} - {targetKey}
          </p>
        </div>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          aria-label={t('Close recovery workbench')}
          title={t('Close')}
          onClick={onClose}
        >
          <X className='h-4 w-4' />
        </Button>
      </div>

      {!applyEnabled ? (
        <Alert>
          <AlertDescription>
            {t(
              'Preview is available, but apply remains blocked until TASK_POLL_RECOVERY_ENABLED and runtime readiness are both true.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {!target.timeout_eligible || preview?.timeout_eligible === false ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {t(
              'Apply is blocked because the remaining hard-timeout window is shorter than the required recovery margin. Preview remains available for audit.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className='grid gap-4 md:grid-cols-2'>
        <div className='space-y-2'>
          <Label>{t('Recovery reason')}</Label>
          <Select
            value={reason}
            onValueChange={(value) => {
              if (!value) return
              setReason(value as TaskPollRecoveryReason)
              invalidatePreview()
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value='provider_configuration_corrected'>
                  {t('Provider configuration corrected')}
                </SelectItem>
                <SelectItem value='provider_incident_resolved'>
                  {t('Provider incident resolved')}
                </SelectItem>
                <SelectItem value='provider_task_verified'>
                  {t('Provider task verified')}
                </SelectItem>
                <SelectItem value='operator_retry_approved'>
                  {t('Operator retry approved')}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='task-poll-recovery-evidence'>
            {t('Evidence reference')}
          </Label>
          <Input
            id='task-poll-recovery-evidence'
            value={evidenceReference}
            maxLength={128}
            placeholder='incident:INC-42'
            aria-invalid={evidenceReference.length > 0 && !evidenceIsValid}
            onChange={(event) => {
              setEvidenceReference(event.target.value)
              invalidatePreview()
            }}
          />
        </div>
      </div>

      {previewMutation.error || applyMutation.error ? (
        <Alert variant='destructive'>
          <AlertDescription>
            {errorMessage(previewMutation.error || applyMutation.error)}
          </AlertDescription>
        </Alert>
      ) : null}

      {preview ? (
        <dl className='grid gap-x-6 gap-y-3 border-y py-3 text-sm sm:grid-cols-2 xl:grid-cols-4'>
          <PreviewField
            label={t('Task reference')}
            value={preview.task_reference}
          />
          <PreviewField label={t('Public task hash')} value={compactHash} />
          <PreviewField
            label={t('Poll generation')}
            value={String(preview.poll_generation)}
          />
          <PreviewField
            label={t('Write revision')}
            value={String(preview.poll_write_revision)}
          />
          <PreviewField
            label={t('Attempts')}
            value={String(preview.poll_attempt_count)}
          />
          <PreviewField
            label={t('Consecutive failures')}
            value={String(preview.poll_consecutive_failures)}
          />
          <PreviewField label={t('Platform')} value={preview.platform} />
          <PreviewField
            label={t('Quarantine reason')}
            value={preview.poll_quarantine_reason}
          />
          <PreviewField
            label={t('Hard timeout')}
            value={formatHardTimeout(preview.hard_timeout_at, t)}
          />
          <PreviewField
            label={t('Timeout eligibility')}
            value={preview.timeout_eligible ? t('Eligible') : t('Blocked')}
          />
          <PreviewField
            label={t('Recovery margin')}
            value={t('{{seconds}} seconds', {
              seconds: preview.timeout_recovery_margin_seconds,
            })}
          />
        </dl>
      ) : null}

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap gap-2'>
          <StatusBadge copyable={false} variant='neutral'>
            {t('Generation {{generation}}', {
              generation: target.poll_generation,
            })}
          </StatusBadge>
          <StatusBadge copyable={false} variant='warning'>
            {t('{{count}} consecutive failures', {
              count: target.poll_consecutive_failures,
            })}
          </StatusBadge>
          <StatusBadge
            copyable={false}
            variant={timeoutEligible ? 'success' : 'danger'}
          >
            {timeoutEligible ? t('Timeout eligible') : t('Timeout blocked')}
          </StatusBadge>
        </div>
        <div className='flex flex-wrap justify-end gap-2'>
          <Button type='button' variant='outline' onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type='button'
            variant='secondary'
            disabled={!evidenceIsValid || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : null}
            {t('Preview requeue')}
          </Button>
          <Button
            type='button'
            variant='destructive'
            disabled={!canApply || !preview || applyMutation.isPending}
            onClick={() => setRiskOpen(true)}
          >
            <RotateCcw className='h-4 w-4' />
            {t('Requeue task poll')}
          </Button>
        </div>
      </div>

      <RiskAcknowledgementDialog
        open={riskOpen}
        onOpenChange={setRiskOpen}
        title={t('Requeue quarantined task poll')}
        description={t(
          'This clears quarantine state and schedules another provider poll under the current generation and a new write revision.'
        )}
        items={[
          `${t('Task reference')}: ${target.task_reference}`,
          `${t('Public task hash')}: ${compactHash}`,
          `${t('Recovery reason')}: ${reason}`,
          `${t('Evidence reference')}: ${decision.evidence_reference}`,
          `${t('Hard timeout')}: ${formatHardTimeout(
            preview?.hard_timeout_at ?? target.hard_timeout_at,
            t
          )}`,
          `${t('Recovery margin')}: ${
            preview?.timeout_recovery_margin_seconds ??
            target.timeout_recovery_margin_seconds
          } ${t('seconds')}`,
        ]}
        checklist={[
          t('I verified the provider evidence for this task reference.'),
          t(
            'I confirmed the current quarantine generation and failure history.'
          ),
        ]}
        requiredText={`REQUEUE ${targetKey}`}
        inputPrompt={t('Type REQUEUE and the task target')}
        confirmText={t('Verify and requeue')}
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

function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0 space-y-0.5'>
      <dt className='text-muted-foreground text-xs'>{label}</dt>
      <dd className='truncate font-medium' title={value}>
        {value}
      </dd>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Task poll recovery failed'
}

function formatHardTimeout(
  value: number | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return value === null
    ? t('No hard timeout')
    : new Date(value * 1000).toLocaleString()
}
