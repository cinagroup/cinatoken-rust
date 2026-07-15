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
export const TASK_POLL_RECOVERY_REASONS = [
  'provider_configuration_corrected',
  'provider_incident_resolved',
  'provider_task_verified',
  'operator_retry_approved',
] as const

export type TaskPollRecoveryReason = (typeof TASK_POLL_RECOVERY_REASONS)[number]

export type TaskPollRecoveryEntityKind = 'task' | 'midjourney'

export type TaskPollRecoveryDecision = {
  reason: TaskPollRecoveryReason
  evidence_reference: string
}

export type TaskPollRecoveryQueueRecord = {
  entity_kind: TaskPollRecoveryEntityKind
  entity_id: number
  task_reference: string
  public_task_id_sha256: string
  platform: string
  channel_id: number
  status: string
  hard_timeout_at: number | null
  timeout_eligible: boolean
  timeout_recovery_margin_seconds: number
  poll_generation: number
  poll_write_revision: number
  poll_attempt_count: number
  poll_consecutive_failures: number
  poll_last_error_code: string
  poll_quarantined_at: number
  poll_quarantine_reason: string
}

export type TaskPollRecoveryQueueResponse = {
  success: boolean
  message?: string
  data: {
    contract_version: number
    count: number
    next_cursor: string | null
    records: TaskPollRecoveryQueueRecord[]
  }
}

export type TaskPollRecoveryPreview = Omit<
  TaskPollRecoveryQueueRecord,
  'poll_last_error_code'
> &
  TaskPollRecoveryDecision & {
    contract_version: number
    preview_token: string
  }

export type TaskPollRecoveryPreviewResponse = {
  success: boolean
  message?: string
  data: TaskPollRecoveryPreview
}

export type TaskPollRecoveryApplyRequest = TaskPollRecoveryDecision & {
  preview_token: string
  idempotency_key: string
  confirm_requeue: true
}

export type TaskPollRecoveryApplyResponse = {
  success: boolean
  message?: string
  data: {
    contract_version: number
    entity_kind: TaskPollRecoveryEntityKind
    entity_id: number
    action: 'requeue'
    status: 'applied' | 'duplicate'
    scheduled_at: number
  }
}

export function buildTaskPollRecoveryDecision(
  reason: TaskPollRecoveryReason,
  evidenceReference: string
): TaskPollRecoveryDecision {
  return {
    reason,
    evidence_reference: evidenceReference.trim(),
  }
}

export function isTaskPollRecoveryEvidenceReferenceValid(
  value: string
): boolean {
  return /^[A-Za-z0-9._:/#@-]{1,128}$/u.test(value.trim())
}

export function compactTaskPollRecoveryDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) return 'invalid-task-id-hash'
  return `${value.slice(0, 12)}...${value.slice(-8)}`
}

export function taskPollRecoveryTargetKey(
  target: Pick<TaskPollRecoveryQueueRecord, 'entity_kind' | 'entity_id'>
): string {
  return `${target.entity_kind}:${target.entity_id}`
}

export function canApplyTaskPollRecovery(input: {
  runtimeReady: boolean
  mutationEnabled: boolean
  timeoutEligible: boolean
}): boolean {
  return input.runtimeReady && input.mutationEnabled && input.timeoutEligible
}
