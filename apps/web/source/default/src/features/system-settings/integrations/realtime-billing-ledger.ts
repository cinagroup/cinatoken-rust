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
export type RealtimeBillingLedgerOutcome =
  | 'reserved'
  | 'settled'
  | 'refunded'
  | 'recovery_required'
  | 'unknown'

export type RealtimeBillingRecoveryState =
  | 'settlement_grace'
  | 'retry_backoff'
  | 'recovery_due'
  | 'manual_reconciliation'
  | 'terminal'
  | 'unknown'

export type RealtimeBillingGlobalSweepStatus = {
  last_started_at: number
  last_completed_at: number
  last_success_at: number | null
  last_candidates: number
  last_refunded: number
  last_recovery_required: number
  last_failed: number
  last_deferred: number
}

export type RealtimeBillingLedgerRecord = {
  reservation_fingerprint: string
  scope_kind: string
  scope_fingerprint: string
  outcome: RealtimeBillingLedgerOutcome
  terminal: boolean
  reservation_sequence: number
  lease_expires_at: number
  updated_at: number
  settled_at: number | null
  refunded_at: number | null
  recovery_attempt_count: number
  recovery_next_attempt_at: number | null
  recovery_last_attempt_at: number | null
  recovery_state: RealtimeBillingRecoveryState
  requires_reconciliation: boolean
  finalization_reason: string | null
  finalization_required_at: number | null
  reconciliation_id: string | null
  reconciliation_revision: number
  reconciliation_resolution: 'settled' | 'refunded' | null
  reconciliation_resolved_at: number | null
}

export type RealtimeBillingReconciliationAction = 'settle' | 'refund'

export type RealtimeBillingReconciliationReason =
  | 'provider_usage_verified'
  | 'provider_invoice_verified'
  | 'provider_confirms_no_billable_usage'
  | 'customer_refund_approved'

export type RealtimeBillingReconciliationUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens: number
  cache_creation_tokens: number
  image_input_tokens: number
  image_output_tokens: number
  audio_input_tokens: number
  audio_output_tokens: number
}

export type RealtimeBillingReconciliationDecision = {
  action: RealtimeBillingReconciliationAction
  reason: RealtimeBillingReconciliationReason
  evidence_reference: string
  usage: RealtimeBillingReconciliationUsage | null
}

export type RealtimeBillingReconciliationPreview = {
  contract_version: number
  reconciliation_id: string
  reconciliation_revision: number
  action: RealtimeBillingReconciliationAction
  reason: RealtimeBillingReconciliationReason
  evidence_reference: string
  quarantine_reason: string
  preview_token: string
  pricing_source: 'frozen_tiered_snapshot' | 'reserved_quota_refund'
  pre_consumed_quota: number
  final_quota: number
  refund_quota: number
  additional_quota: number
  settlement: Record<string, unknown> | null
}

export type RealtimeBillingReconciliationApplyRequest =
  RealtimeBillingReconciliationDecision & {
    preview_token: string
    idempotency_key: string
    confirm_resolution: true
  }

export type RealtimeBillingReconciliationApplyResult = {
  contract_version: number
  reconciliation_id: string
  action: RealtimeBillingReconciliationAction
  status: 'applied' | 'duplicate'
  reconciliation_revision: number
  resolved_at: number
}

export type RealtimeBillingReconciliationQueueRecord = {
  reconciliation_id: string
  reconciliation_revision: number
  quarantine_reason: string
  quarantine_required_at: number
  pre_consumed_quota: number
  created_at: number
}

export type RealtimeBillingReconciliationQueue = {
  contract_version: number
  count: number
  next_cursor: string | null
  records: RealtimeBillingReconciliationQueueRecord[]
}

export type RealtimeBillingReconciliationQueueResponse = {
  success: boolean
  message?: string
  data: RealtimeBillingReconciliationQueue
}

export type RealtimeBillingReconciliationPreviewResponse = {
  success: boolean
  message?: string
  data: RealtimeBillingReconciliationPreview
}

export type RealtimeBillingReconciliationApplyResponse = {
  success: boolean
  message?: string
  data: RealtimeBillingReconciliationApplyResult
}

export type RealtimeBillingLedgerStatus = {
  contract_version: number
  count: number
  global_sweep: RealtimeBillingGlobalSweepStatus | null
  records: RealtimeBillingLedgerRecord[]
}

export type RealtimeBillingLedgerResponse = {
  success: boolean
  message?: string
  data: RealtimeBillingLedgerStatus
}

export type RealtimeBillingLedgerSummary = {
  total: number
  active: number
  terminal: number
  reconciliationRequired: number
}

export function summarizeRealtimeBillingLedger(
  status: RealtimeBillingLedgerStatus
): RealtimeBillingLedgerSummary {
  return status.records.reduce<RealtimeBillingLedgerSummary>(
    (summary, record) => ({
      total: summary.total + 1,
      active: summary.active + (record.terminal ? 0 : 1),
      terminal: summary.terminal + (record.terminal ? 1 : 0),
      reconciliationRequired:
        summary.reconciliationRequired +
        (record.requires_reconciliation ? 1 : 0),
    }),
    { total: 0, active: 0, terminal: 0, reconciliationRequired: 0 }
  )
}

export function compactRealtimeBillingFingerprint(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) return 'invalid-fingerprint'
  return `${value.slice(0, 15)}...${value.slice(-8)}`
}

export function compactRealtimeBillingReconciliationId(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) return 'invalid-reconciliation-id'
  return `${value.slice(0, 12)}...${value.slice(-8)}`
}

export function normalizeRealtimeBillingLedgerStatus(
  status: RealtimeBillingLedgerStatus
): RealtimeBillingLedgerStatus {
  return {
    contract_version: status.contract_version,
    count: status.count,
    global_sweep: status.global_sweep
      ? {
          last_started_at: status.global_sweep.last_started_at,
          last_completed_at: status.global_sweep.last_completed_at,
          last_success_at: status.global_sweep.last_success_at,
          last_candidates: status.global_sweep.last_candidates,
          last_refunded: status.global_sweep.last_refunded,
          last_recovery_required: status.global_sweep.last_recovery_required,
          last_failed: status.global_sweep.last_failed,
          last_deferred: status.global_sweep.last_deferred,
        }
      : null,
    records: status.records.map((record) => ({
      reservation_fingerprint: record.reservation_fingerprint,
      scope_kind: record.scope_kind,
      scope_fingerprint: record.scope_fingerprint,
      outcome: record.outcome,
      terminal: record.terminal,
      reservation_sequence: record.reservation_sequence,
      lease_expires_at: record.lease_expires_at,
      updated_at: record.updated_at,
      settled_at: record.settled_at,
      refunded_at: record.refunded_at,
      recovery_attempt_count: record.recovery_attempt_count,
      recovery_next_attempt_at: record.recovery_next_attempt_at,
      recovery_last_attempt_at: record.recovery_last_attempt_at,
      recovery_state: record.recovery_state,
      requires_reconciliation: record.requires_reconciliation,
      finalization_reason: record.finalization_reason,
      finalization_required_at: record.finalization_required_at,
      reconciliation_id: record.reconciliation_id,
      reconciliation_revision: record.reconciliation_revision,
      reconciliation_resolution: record.reconciliation_resolution,
      reconciliation_resolved_at: record.reconciliation_resolved_at,
    })),
  }
}
