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
export type TaskSubmitReconciliationAction = 'attach' | 'refund'

export type TaskSubmitReconciliationReason =
  | 'provider_task_verified'
  | 'provider_console_verified'
  | 'provider_confirms_not_accepted'
  | 'customer_refund_approved'

export type TaskSubmitReconciliationDecision = {
  action: TaskSubmitReconciliationAction
  reason: TaskSubmitReconciliationReason
  evidence_reference: string
  provider_task_id: string
}

export type TaskSubmitReconciliationQueueRecord = {
  reconciliation_id: string
  reconciliation_revision: number
  task_kind: 'task' | 'midjourney'
  public_task_id: string
  provider_kind: string
  provider_task_id: string
  quota: number
  funding_source: 'wallet' | 'subscription'
  quarantine_reason: string
  quarantine_required_at: number
  attach_contract_sha256: string
  attach_available: boolean
}

export type TaskSubmitReconciliationQueueResponse = {
  success: boolean
  message?: string
  data: {
    contract_version: number
    count: number
    next_cursor: string | null
    records: TaskSubmitReconciliationQueueRecord[]
  }
}

export type TaskSubmitReconciliationPreview = {
  contract_version: number
  reconciliation_id: string
  reconciliation_revision: number
  action: TaskSubmitReconciliationAction
  reason: TaskSubmitReconciliationReason
  evidence_reference: string
  provider_task_id: string
  task_kind: 'task' | 'midjourney'
  public_task_id: string
  provider_kind: string
  quota: number
  funding_source: 'wallet' | 'subscription'
  billing_contract_sha256: string
  attach_contract_sha256: string
  attach_available: boolean
  legacy_refund_only: boolean
  preview_token: string
}

export type TaskSubmitReconciliationPreviewResponse = {
  success: boolean
  message?: string
  data: TaskSubmitReconciliationPreview
}

export type TaskSubmitReconciliationApplyRequest =
  TaskSubmitReconciliationDecision & {
    preview_token: string
    idempotency_key: string
    confirm_resolution: true
  }

export type TaskSubmitReconciliationApplyResponse = {
  success: boolean
  message?: string
  data: {
    contract_version: number
    reconciliation_id: string
    action: TaskSubmitReconciliationAction
    status: 'applied' | 'duplicate'
    reconciliation_revision: number
    resolved_at: number
  }
}

export function compactTaskSubmitReconciliationId(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) return 'invalid-reconciliation-id'
  return `${value.slice(0, 12)}...${value.slice(-8)}`
}

export function isTaskProviderIdValid(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
}

export function canAttachTaskSubmitReconciliation(
  record: TaskSubmitReconciliationQueueRecord
): boolean {
  return record.attach_available
}
