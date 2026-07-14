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
    })),
  }
}
