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
import { StatusBadge } from '@/components/status-badge'
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
import { getTaskSubmitReconciliationQueue } from '../api'
import {
  compactTaskSubmitReconciliationId,
  type TaskSubmitReconciliationQueueRecord,
} from './task-submit-reconciliation'
import { TaskSubmitReconciliationWorkbench } from './task-submit-reconciliation-workbench'

export function TaskSubmitReconciliationPanel(props: {
  runtimeReady: boolean
  mutationEnabled: boolean
}) {
  const { runtimeReady, mutationEnabled } = props
  const { t } = useTranslation()
  const [selected, setSelected] =
    useState<TaskSubmitReconciliationQueueRecord | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [history, setHistory] = useState<string[]>([])
  const queue = useQuery({
    queryKey: ['task-submit-reconciliation-queue', cursor ?? 'first'],
    queryFn: async () => {
      const response = await getTaskSubmitReconciliationQueue(cursor)
      if (!response.success) throw new Error(response.message || 'Failed')
      return response.data
    },
    enabled: runtimeReady,
    staleTime: 30 * 1000,
  })

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>
            {t('Task submit reconciliation')}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Resolve ambiguous video, Suno, and Midjourney submissions from frozen attachment contracts and provider evidence.'
            )}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <StatusBadge
            copyable={false}
            variant={runtimeReady ? 'success' : 'neutral'}
          >
            {runtimeReady ? t('Runtime ready') : t('Runtime blocked')}
          </StatusBadge>
          <StatusBadge
            copyable={false}
            variant={mutationEnabled ? 'warning' : 'neutral'}
          >
            {mutationEnabled ? t('Apply enabled') : t('Apply disabled')}
          </StatusBadge>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!runtimeReady || queue.isFetching}
            onClick={() => void queue.refetch()}
          >
            {queue.isFetching ? t('Refreshing...') : t('Refresh')}
          </Button>
        </div>
      </div>

      {!runtimeReady ? (
        <Alert className='mt-3'>
          <AlertDescription>
            {t(
              'Queue reads stay disabled until migrations 0032 and 0033 and the object-level schema probe are ready.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {queue.error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>
            {queue.error instanceof Error
              ? queue.error.message
              : t('Failed to load task reconciliation queue')}
          </AlertDescription>
        </Alert>
      ) : null}

      {queue.data ? (
        <div className='mt-4 border-t pt-3'>
          <div className='mb-2 flex items-center justify-between gap-2'>
            <p className='text-sm font-medium'>
              {t('Open reconciliation queue')} ({queue.data.count})
            </p>
            <div className='flex items-center gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={history.length === 0 || queue.isFetching}
                onClick={() => {
                  const previous = history.at(-1)
                  setCursor(previous || undefined)
                  setHistory((current) => current.slice(0, -1))
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
                  setHistory((current) => [...current, cursor ?? ''])
                  setCursor(queue.data.next_cursor)
                }}
              >
                {t('Next')}
              </Button>
            </div>
          </div>
          {queue.data.records.length > 0 ? (
            <Table aria-label={t('Open task submit reconciliation queue')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Reconciliation')}</TableHead>
                  <TableHead>{t('Provider')}</TableHead>
                  <TableHead>{t('Task kind')}</TableHead>
                  <TableHead>{t('Recovery')}</TableHead>
                  <TableHead className='text-right'>{t('Quota')}</TableHead>
                  <TableHead className='text-right'>{t('Action')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.data.records.map((record) => (
                  <TableRow key={record.reconciliation_id}>
                    <TableCell className='font-mono text-xs'>
                      {compactTaskSubmitReconciliationId(
                        record.reconciliation_id
                      )}
                    </TableCell>
                    <TableCell>{record.provider_kind}</TableCell>
                    <TableCell>
                      <StatusBadge
                        copyable={false}
                        variant={record.attach_available ? 'info' : 'warning'}
                      >
                        {record.attach_available
                          ? record.task_kind
                          : t('Refund only')}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className='max-w-64 truncate'>
                      {humanizeCode(record.quarantine_reason)}
                    </TableCell>
                    <TableCell className='text-right'>{record.quota}</TableCell>
                    <TableCell className='text-right'>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
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
              {t('No open task submit reconciliations were found.')}
            </p>
          )}
        </div>
      ) : null}

      {selected ? (
        <TaskSubmitReconciliationWorkbench
          key={`${selected.reconciliation_id}:${selected.reconciliation_revision}`}
          target={selected}
          mutationEnabled={mutationEnabled}
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
