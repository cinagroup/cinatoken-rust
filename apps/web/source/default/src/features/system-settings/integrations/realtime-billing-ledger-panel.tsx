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
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getRealtimeBillingLedgerStatus,
  getRealtimeBillingReconciliationQueue,
} from '../api'
import {
  compactRealtimeBillingFingerprint,
  summarizeRealtimeBillingLedger,
  type RealtimeBillingLedgerOutcome,
  type RealtimeBillingReconciliationQueueRecord,
  type RealtimeBillingRecoveryState,
} from './realtime-billing-ledger'
import { RealtimeBillingReconciliationWorkbench } from './realtime-billing-reconciliation-workbench'

export function RealtimeBillingLedgerPanel(props: {
  runtimeReady: boolean
  reconciliationMutationEnabled: boolean
}) {
  const { runtimeReady, reconciliationMutationEnabled } = props
  const { t } = useTranslation()
  const [selected, setSelected] =
    useState<RealtimeBillingReconciliationQueueRecord | null>(null)
  const [queueCursor, setQueueCursor] = useState<string | undefined>()
  const [queueHistory, setQueueHistory] = useState<string[]>([])
  const ledger = useQuery({
    queryKey: ['realtime-billing-ledger-status'],
    queryFn: async () => {
      const response = await getRealtimeBillingLedgerStatus()
      if (!response.success) {
        throw new Error(response.message || 'Failed to load')
      }
      return response.data
    },
    enabled: runtimeReady,
    staleTime: 30 * 1000,
  })
  const queue = useQuery({
    queryKey: ['realtime-billing-reconciliation-queue', queueCursor ?? 'first'],
    queryFn: async () => {
      const response = await getRealtimeBillingReconciliationQueue(queueCursor)
      if (!response.success) {
        throw new Error(response.message || 'Failed to load')
      }
      return response.data
    },
    enabled: runtimeReady,
    staleTime: 30 * 1000,
  })
  const summary = ledger.data
    ? summarizeRealtimeBillingLedger(ledger.data)
    : null

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>{t('Realtime billing ledger')}</p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Redacted reservation outcomes with a preview-first, step-up protected reconciliation workflow.'
            )}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <StatusBadge
            variant={runtimeReady ? 'success' : 'neutral'}
            copyable={false}
          >
            {runtimeReady ? t('Runtime ready') : t('Runtime blocked')}
          </StatusBadge>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!runtimeReady || ledger.isFetching || queue.isFetching}
            onClick={() => {
              void ledger.refetch()
              void queue.refetch()
            }}
          >
            {ledger.isFetching || queue.isFetching
              ? t('Refreshing...')
              : t('Refresh')}
          </Button>
        </div>
      </div>

      {!runtimeReady ? (
        <Alert className='mt-3'>
          <AlertDescription>
            {t(
              'Ledger reads stay disabled until migration 0028 and the usage reconciliation contract are ready.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {ledger.error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>
            {ledger.error instanceof Error
              ? ledger.error.message
              : t('Failed to load Realtime billing ledger')}
          </AlertDescription>
        </Alert>
      ) : null}

      {queue.error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>
            {queue.error instanceof Error
              ? queue.error.message
              : t('Failed to load Realtime reconciliation queue')}
          </AlertDescription>
        </Alert>
      ) : null}

      {summary ? (
        <div className='mt-3 flex flex-wrap gap-2'>
          <StatusBadge copyable={false} variant='info'>
            {t('Records')}: {summary.total}
          </StatusBadge>
          <StatusBadge copyable={false} variant='warning'>
            {t('Active')}: {summary.active}
          </StatusBadge>
          <StatusBadge copyable={false} variant='success'>
            {t('Terminal')}: {summary.terminal}
          </StatusBadge>
          <StatusBadge
            copyable={false}
            variant={summary.reconciliationRequired > 0 ? 'danger' : 'neutral'}
          >
            {t('Manual reconciliation')}: {summary.reconciliationRequired}
          </StatusBadge>
          {ledger.data?.global_sweep ? (
            <StatusBadge copyable={false} variant='neutral'>
              {t('Last sweep')}: {ledger.data.global_sweep.last_candidates}{' '}
              {t('candidates')}, {ledger.data.global_sweep.last_refunded}{' '}
              {t('refunded')}
            </StatusBadge>
          ) : null}
        </div>
      ) : null}

      {queue.data ? (
        <div className='mt-4 border-t pt-3'>
          <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
            <p className='text-sm font-medium'>
              {t('Open reconciliation queue')}
            </p>
            <div className='flex items-center gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={queueHistory.length === 0 || queue.isFetching}
                onClick={() => {
                  const previous = queueHistory.at(-1)
                  setQueueCursor(previous || undefined)
                  setQueueHistory((history) => history.slice(0, -1))
                }}
              >
                {t('Previous')}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={!queue.data.next_cursor || queue.isFetching}
                onClick={() => {
                  if (!queue.data.next_cursor) return
                  setQueueHistory((history) => [
                    ...history,
                    queueCursor ?? '',
                  ])
                  setQueueCursor(queue.data.next_cursor)
                }}
              >
                {t('Next')}
              </Button>
            </div>
          </div>
          {queue.data.records.length > 0 ? (
            <Table aria-label={t('Open Realtime reconciliation queue')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Reconciliation')}</TableHead>
                  <TableHead>{t('Reason')}</TableHead>
                  <TableHead className='text-right'>
                    {t('Reserved quota')}
                  </TableHead>
                  <TableHead className='text-right'>{t('Required')}</TableHead>
                  <TableHead className='text-right'>{t('Action')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.data.records.map((record) => (
                  <TableRow key={record.reconciliation_id}>
                    <TableCell className='font-mono text-xs'>
                      {record.reconciliation_id.slice(0, 12)}...
                      {record.reconciliation_id.slice(-8)}
                    </TableCell>
                    <TableCell>{t(humanizeCode(record.quarantine_reason))}</TableCell>
                    <TableCell className='text-right'>
                      {record.pre_consumed_quota}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatEpochSeconds(record.quarantine_required_at)}
                    </TableCell>
                    <TableCell className='text-right'>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => setSelected(record)}
                      >
                        {t('Resolve')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className='text-muted-foreground text-xs'>
              {t('No open Realtime billing reconciliations were found.')}
            </p>
          )}
        </div>
      ) : null}

      {ledger.data ? (
        ledger.data.records.length > 0 ? (
          <div className='mt-3 border-t pt-2'>
            <Table aria-label={t('Realtime billing ledger records')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Outcome')}</TableHead>
                  <TableHead>{t('Reservation')}</TableHead>
                  <TableHead>{t('Bridge scope')}</TableHead>
                  <TableHead>{t('Recovery state')}</TableHead>
                  <TableHead>{t('Reason')}</TableHead>
                  <TableHead className='text-right'>{t('Updated')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.data.records.map((record) => (
                  <TableRow key={record.reservation_fingerprint}>
                    <TableCell>
                      <StatusBadge
                        copyable={false}
                        variant={outcomeVariant(record.outcome)}
                      >
                        {t(humanizeCode(record.outcome))}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {compactRealtimeBillingFingerprint(
                        record.reservation_fingerprint
                      )}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {compactRealtimeBillingFingerprint(
                        record.scope_fingerprint
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        copyable={false}
                        variant={recoveryVariant(record.recovery_state)}
                      >
                        {t(humanizeCode(record.recovery_state))}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className='max-w-64 truncate'>
                      {record.finalization_reason
                        ? t(humanizeCode(record.finalization_reason))
                        : '-'}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatEpochSeconds(record.updated_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className='text-muted-foreground mt-3 text-xs'>
            {t('No Realtime billing reservations were found.')}
          </p>
        )
      ) : null}

      {selected ? (
        <RealtimeBillingReconciliationWorkbench
          key={`${selected.reconciliation_id}:${selected.reconciliation_revision}`}
          target={selected}
          mutationEnabled={reconciliationMutationEnabled}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

function humanizeCode(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function outcomeVariant(outcome: RealtimeBillingLedgerOutcome): StatusVariant {
  if (outcome === 'settled' || outcome === 'refunded') return 'success'
  if (outcome === 'recovery_required') return 'danger'
  if (outcome === 'reserved') return 'warning'
  return 'neutral'
}

function recoveryVariant(state: RealtimeBillingRecoveryState): StatusVariant {
  if (state === 'terminal') return 'success'
  if (state === 'manual_reconciliation') return 'danger'
  if (state === 'recovery_due' || state === 'retry_backoff') return 'warning'
  return 'neutral'
}

function formatEpochSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-'
  return new Date(value * 1000).toLocaleString()
}
