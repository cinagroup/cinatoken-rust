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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { reconcileQuotaCoordinator } from '../api'
import {
  buildQuotaReconciliationPresentation,
  canRunQuotaCoordinatorReconciliation,
  normalizePositiveI64TokenId,
  stringifyRedactedQuotaReconciliationArchive,
  type CanonicalPositiveI64String,
  type QuotaCoordinatorDiagnostics,
  type QuotaCoordinatorReconciliationReport,
  type QuotaReconciliationField,
  type QuotaReconciliationNotice,
  type QuotaReconciliationStatus,
} from './quota-coordinator-reconciliation'

type Translate = (key: string, options?: Record<string, unknown>) => string

const PROJECTION_FIELD_LABELS: Record<QuotaReconciliationField, string> = {
  reserve_count: 'Reserve count',
  settle_count: 'Settle count',
  refund_count: 'Refund count',
  active_reservations: 'Active reservations',
  terminal_reservations: 'Terminal reservations',
  outstanding_quota: 'Outstanding quota',
  reserved_quota: 'Reserved quota',
  final_quota: 'Final quota',
  refunded_quota: 'Refunded quota',
  user_net_delta: 'User net delta',
  token_net_delta: 'Token net delta',
  channel_used_quota: 'Channel used quota',
  request_count: 'Request count',
}

export function QuotaCoordinatorReconciliationPanel(props: {
  runtimeReady: boolean
}) {
  const { runtimeReady } = props
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard({
    successMessage: t('Redacted reconciliation JSON copied'),
  })
  const [tokenId, setTokenId] = useState('')
  const normalizedTokenId = normalizePositiveI64TokenId(tokenId)
  const canReconcile = canRunQuotaCoordinatorReconciliation(
    runtimeReady,
    normalizedTokenId
  )
  const hasInput = tokenId.trim().length > 0
  const reconciliation = useMutation({
    mutationFn: async (canonicalTokenId: CanonicalPositiveI64String) => {
      const response = await reconcileQuotaCoordinator(canonicalTokenId)
      if (!response.success) {
        throw new Error(response.message || t('Reconciliation failed'))
      }
      return response.data
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canRunQuotaCoordinatorReconciliation(runtimeReady, normalizedTokenId))
      return
    reconciliation.mutate(normalizedTokenId)
  }

  const handleTokenIdChange = (value: string) => {
    setTokenId(value)
    reconciliation.reset()
  }

  const handleCopy = () => {
    if (!reconciliation.data) return
    void copyToClipboard(
      stringifyRedactedQuotaReconciliationArchive(reconciliation.data)
    )
  }

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>
            {t('QuotaCoordinator reconciliation')}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Compare the authoritative D1 projection with the read-only shadow observer for one token scope.'
            )}
          </p>
        </div>
        <StatusBadge
          variant={runtimeReady ? 'success' : 'neutral'}
          copyable={false}
          className='shrink-0'
        >
          {runtimeReady ? t('Runtime ready') : t('Runtime blocked')}
        </StatusBadge>
      </div>

      <form
        className='mt-3 flex flex-col gap-2 sm:flex-row'
        onSubmit={handleSubmit}
      >
        <div className='sm:max-w-sm sm:flex-1'>
          <Input
            aria-invalid={hasInput && !normalizedTokenId}
            aria-label={t('Token id')}
            autoComplete='off'
            inputMode='numeric'
            onChange={(event) => handleTokenIdChange(event.target.value)}
            placeholder={t('Positive token id')}
            spellCheck={false}
            value={tokenId}
          />
        </div>
        <Button
          type='submit'
          variant='outline'
          disabled={!canReconcile || reconciliation.isPending}
        >
          {reconciliation.isPending ? t('Reconciling...') : t('Reconcile')}
        </Button>
      </form>

      {hasInput && !normalizedTokenId ? (
        <p className='text-destructive mt-2 text-xs'>
          {t('Enter a positive signed 64-bit integer.')}
        </p>
      ) : normalizedTokenId && normalizedTokenId !== tokenId.trim() ? (
        <p className='text-muted-foreground mt-2 text-xs'>
          {t('Will query canonical token id {{tokenId}}.', {
            tokenId: normalizedTokenId,
          })}
        </p>
      ) : null}

      {!runtimeReady ? (
        <Alert className='mt-3'>
          <AlertDescription>
            {t(
              'Reconciliation stays disabled until the backend reports runtime readiness.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {reconciliation.error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>
            {reconciliation.error instanceof Error
              ? reconciliation.error.message
              : t('Reconciliation failed')}
          </AlertDescription>
        </Alert>
      ) : null}

      {reconciliation.data ? (
        <ReconciliationResult
          onCopy={handleCopy}
          report={reconciliation.data}
          t={t}
        />
      ) : null}
    </div>
  )
}

function ReconciliationResult(props: {
  onCopy: () => void
  report: QuotaCoordinatorReconciliationReport
  t: Translate
}) {
  const { onCopy, report, t } = props
  const presentation = buildQuotaReconciliationPresentation(report)

  return (
    <div className='mt-4 space-y-4 border-t pt-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex flex-wrap gap-2'>
          <StatusBadge
            variant={reconciliationStatusVariant(report.status)}
            copyable={false}
          >
            {formatReconciliationStatus(report.status, t)}
          </StatusBadge>
          <StatusBadge
            variant={report.source_stable ? 'success' : 'warning'}
            copyable={false}
          >
            {report.source_stable ? t('Source stable') : t('Source changed')}
          </StatusBadge>
          <StatusBadge
            variant={report.observer_healthy ? 'success' : 'warning'}
            copyable={false}
          >
            {report.observer_healthy
              ? t('Observer healthy')
              : t('Observer unhealthy')}
          </StatusBadge>
        </div>
        <Button type='button' size='sm' variant='outline' onClick={onCopy}>
          <Copy data-icon='inline-start' />
          {t('Copy redacted JSON')}
        </Button>
      </div>

      <div className='min-w-0 space-y-1'>
        <p className='text-muted-foreground text-xs'>{t('Scope hash')}</p>
        <p className='font-mono text-xs break-all'>{report.token_scope_hash}</p>
      </div>

      {presentation.notice ? (
        <ReconciliationNotice notice={presentation.notice} t={t} />
      ) : null}

      <div className='space-y-2'>
        <p className='text-xs font-medium'>{t('Projection differences')}</p>
        <Table aria-label={t('QuotaCoordinator projection differences')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Metric')}</TableHead>
              <TableHead className='text-right'>{t('D1')}</TableHead>
              <TableHead className='text-right'>{t('Observer')}</TableHead>
              <TableHead className='text-right'>{t('Difference')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {presentation.rows.map((row) => (
              <TableRow key={row.field}>
                <TableCell className='font-medium'>
                  {formatProjectionField(row.field, t)}
                </TableCell>
                <TableCell className='text-right'>{row.d1}</TableCell>
                <TableCell className='text-right'>
                  {formatOptionalInteger(row.observer)}
                </TableCell>
                <TableCell className='text-right'>
                  {formatOptionalInteger(row.difference)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DiagnosticsPanel diagnostics={report.observer_diagnostics} t={t} />
    </div>
  )
}

function ReconciliationNotice(props: {
  notice: QuotaReconciliationNotice
  t: Translate
}) {
  const { notice, t } = props
  const destructive = notice === 'mismatch'

  return (
    <Alert variant={destructive ? 'destructive' : 'default'}>
      <AlertDescription>
        {notice === 'mismatch'
          ? t(
              'D1 and the shadow observer do not match, or observer diagnostics are unhealthy.'
            )
          : notice === 'source_changed'
            ? t(
                'The D1 source changed during the read window; differences are intentionally unavailable.'
              )
            : t(
                'No observer state exists for this token scope; observer values and differences are unavailable.'
              )}
      </AlertDescription>
    </Alert>
  )
}

function DiagnosticsPanel(props: {
  diagnostics: QuotaCoordinatorDiagnostics | null
  t: Translate
}) {
  const { diagnostics, t } = props
  if (!diagnostics) {
    return (
      <div className='space-y-1'>
        <p className='text-xs font-medium'>{t('Observer diagnostics')}</p>
        <p className='text-muted-foreground text-xs'>{t('Unavailable')}</p>
      </div>
    )
  }

  const fields: Array<{ label: string; value: number }> = [
    { label: t('Contract version'), value: diagnostics.contract_version },
    { label: t('Observations'), value: diagnostics.observation_count },
    { label: t('Applied'), value: diagnostics.applied_count },
    { label: t('Replays'), value: diagnostics.replay_count },
    { label: t('Conflicts'), value: diagnostics.conflict_count },
    {
      label: t('Retained terminal'),
      value: diagnostics.retained_terminal_reservations,
    },
    {
      label: t('Compacted terminal'),
      value: diagnostics.compacted_terminal_reservations,
    },
    {
      label: t('Legacy terminal'),
      value: diagnostics.legacy_terminal_reservations,
    },
    {
      label: t('Retention watermark'),
      value: diagnostics.retention_watermark_committed_at,
    },
    {
      label: t('Persisted JSON bytes'),
      value: diagnostics.persisted_state_json_bytes,
    },
    {
      label: t('Persisted JSON limit'),
      value: diagnostics.persisted_state_json_limit_bytes,
    },
  ]

  return (
    <div className='space-y-2'>
      <p className='text-xs font-medium'>{t('Observer diagnostics')}</p>
      <dl className='grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4'>
        {fields.map((field) => (
          <div key={field.label} className='min-w-0 space-y-0.5'>
            <dt className='text-muted-foreground text-xs'>{field.label}</dt>
            <dd className='font-medium tabular-nums'>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function reconciliationStatusVariant(
  status: QuotaReconciliationStatus
): StatusVariant {
  if (status === 'matched') return 'success'
  if (status === 'mismatch') return 'danger'
  if (status === 'source_changed') return 'warning'
  return 'neutral'
}

function formatReconciliationStatus(
  status: QuotaReconciliationStatus,
  t: Translate
) {
  switch (status) {
    case 'matched':
      return t('Matched')
    case 'mismatch':
      return t('Mismatch')
    case 'observer_state_missing':
      return t('Observer state missing')
    case 'source_changed':
      return t('Source changed')
  }
}

function formatProjectionField(field: QuotaReconciliationField, t: Translate) {
  return t(PROJECTION_FIELD_LABELS[field])
}

function formatOptionalInteger(value: number | null) {
  return value === null ? '-' : value
}
