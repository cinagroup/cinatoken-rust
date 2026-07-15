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
import { StatusBadge } from '@/components/status-badge'
import { getTaskPollRecoveryQueue } from '../api'
import {
  compactTaskPollRecoveryDigest,
  taskPollRecoveryTargetKey,
  type TaskPollRecoveryQueueRecord,
} from './task-poll-recovery'
import { TaskPollRecoveryWorkbench } from './task-poll-recovery-workbench'

export function TaskPollRecoveryPanel(props: {
  previewEnabled: boolean
  runtimeReady: boolean
  mutationEnabled: boolean
}) {
  const { previewEnabled, runtimeReady, mutationEnabled } = props
  const { t } = useTranslation()
  const [selected, setSelected] = useState<TaskPollRecoveryQueueRecord | null>(
    null
  )
  const [cursor, setCursor] = useState<string | undefined>()
  const [history, setHistory] = useState<string[]>([])
  const queue = useQuery({
    queryKey: ['task-poll-recovery-queue', cursor ?? 'first'],
    queryFn: async () => {
      const response = await getTaskPollRecoveryQueue(cursor)
      if (!response.success) throw new Error(response.message || 'Failed')
      return response.data
    },
    enabled: previewEnabled,
    staleTime: 30 * 1000,
  })
  const applyEnabled = runtimeReady && mutationEnabled

  return (
    <div className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <p className='text-sm font-medium'>{t('Task poll recovery')}</p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Inspect quarantined task polling and requeue one generation-fenced record from verified provider evidence.'
            )}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusBadge
            copyable={false}
            variant={previewEnabled ? 'info' : 'neutral'}
          >
            {previewEnabled ? t('Preview available') : t('Preview blocked')}
          </StatusBadge>
          <StatusBadge
            copyable={false}
            variant={applyEnabled ? 'warning' : 'neutral'}
          >
            {applyEnabled ? t('Apply enabled') : t('Apply disabled')}
          </StatusBadge>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={!previewEnabled || queue.isFetching}
            onClick={() => void queue.refetch()}
          >
            {queue.isFetching ? t('Refreshing...') : t('Refresh')}
          </Button>
        </div>
      </div>

      {!previewEnabled ? (
        <Alert className='mt-3'>
          <AlertDescription>
            {t(
              'Quarantine reads and preview stay blocked until the recovery contract and D1 schema are ready.'
            )}
          </AlertDescription>
        </Alert>
      ) : !applyEnabled ? (
        <Alert className='mt-3'>
          <AlertDescription>
            {t(
              'Queue inspection and preview remain available. Apply stays fail-closed until the recovery runtime and mutation gate are ready.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {queue.error ? (
        <Alert className='mt-3' variant='destructive'>
          <AlertDescription>
            {queue.error instanceof Error
              ? queue.error.message
              : t('Failed to load task poll quarantines')}
          </AlertDescription>
        </Alert>
      ) : null}

      {queue.data ? (
        <div className='mt-4 border-t pt-3'>
          <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
            <p className='text-sm font-medium'>
              {t('Current quarantine page')} ({queue.data.count})
            </p>
            <div className='flex items-center gap-2'>
              <StatusBadge copyable={false} variant='neutral'>
                {t('Contract v{{version}}', {
                  version: queue.data.contract_version,
                })}
              </StatusBadge>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={history.length === 0 || queue.isFetching}
                onClick={() => {
                  const previous = history.at(-1)
                  setCursor(previous || undefined)
                  setHistory((current) => current.slice(0, -1))
                  setSelected(null)
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
                  setSelected(null)
                }}
              >
                {t('Next')}
              </Button>
            </div>
          </div>

          {queue.data.records.length > 0 ? (
            <div className='overflow-x-auto'>
              <Table aria-label={t('Task poll quarantine queue')}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Task reference')}</TableHead>
                    <TableHead>{t('Kind')}</TableHead>
                    <TableHead>{t('Platform')}</TableHead>
                    <TableHead>{t('Poll state')}</TableHead>
                    <TableHead>{t('Timeout window')}</TableHead>
                    <TableHead className='text-right'>
                      {t('Failures')}
                    </TableHead>
                    <TableHead>{t('Quarantined')}</TableHead>
                    <TableHead className='text-right'>{t('Action')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.data.records.map((record) => (
                    <TableRow key={taskPollRecoveryTargetKey(record)}>
                      <TableCell className='min-w-56'>
                        <p className='max-w-64 truncate text-sm'>
                          {record.task_reference}
                        </p>
                        <p className='text-muted-foreground font-mono text-xs'>
                          {compactTaskPollRecoveryDigest(
                            record.public_task_id_sha256
                          )}
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusBadge copyable={false} variant='info'>
                          {record.entity_kind}
                        </StatusBadge>
                      </TableCell>
                      <TableCell>
                        <p>{record.platform}</p>
                        <p className='text-muted-foreground text-xs'>
                          {t('Channel {{channel}}', {
                            channel: record.channel_id,
                          })}
                        </p>
                      </TableCell>
                      <TableCell className='min-w-40'>
                        <p>{humanizeCode(record.status)}</p>
                        <p className='text-muted-foreground max-w-48 truncate text-xs'>
                          {humanizeCode(
                            record.poll_last_error_code ||
                              record.poll_quarantine_reason
                          )}
                        </p>
                      </TableCell>
                      <TableCell className='min-w-44'>
                        <StatusBadge
                          copyable={false}
                          variant={
                            record.timeout_eligible ? 'success' : 'danger'
                          }
                        >
                          {record.timeout_eligible
                            ? t('Recovery eligible')
                            : t('Window too short')}
                        </StatusBadge>
                        <p className='text-muted-foreground mt-1 text-xs whitespace-nowrap'>
                          {record.hard_timeout_at === null
                            ? t('No hard timeout')
                            : formatUnixTimestamp(record.hard_timeout_at)}
                        </p>
                        <p className='text-muted-foreground text-xs'>
                          {t('{{seconds}} second margin', {
                            seconds: record.timeout_recovery_margin_seconds,
                          })}
                        </p>
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>
                        <p>{record.poll_consecutive_failures}</p>
                        <p className='text-muted-foreground text-xs'>
                          {t('{{count}} attempts', {
                            count: record.poll_attempt_count,
                          })}
                        </p>
                      </TableCell>
                      <TableCell className='text-xs whitespace-nowrap'>
                        {formatUnixTimestamp(record.poll_quarantined_at)}
                      </TableCell>
                      <TableCell className='text-right'>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={() => setSelected(record)}
                        >
                          {t('Review')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className='text-muted-foreground text-xs'>
              {t('No quarantined task polls were found.')}
            </p>
          )}
        </div>
      ) : null}

      {selected ? (
        <TaskPollRecoveryWorkbench
          key={taskPollRecoveryTargetKey(selected)}
          target={selected}
          runtimeReady={runtimeReady}
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

function formatUnixTimestamp(value: number): string {
  return value > 0 ? new Date(value * 1000).toLocaleString() : '-'
}
