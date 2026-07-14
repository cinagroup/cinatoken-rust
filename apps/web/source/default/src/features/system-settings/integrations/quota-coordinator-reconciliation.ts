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
export const QUOTA_RECONCILIATION_FIELDS = [
  'reserve_count',
  'settle_count',
  'refund_count',
  'active_reservations',
  'terminal_reservations',
  'outstanding_quota',
  'reserved_quota',
  'final_quota',
  'refunded_quota',
  'user_net_delta',
  'token_net_delta',
  'channel_used_quota',
  'request_count',
] as const

export type QuotaReconciliationField =
  (typeof QUOTA_RECONCILIATION_FIELDS)[number]

export type QuotaAccountingProjection = Record<QuotaReconciliationField, number>

export type D1QuotaAccountingProjection = QuotaAccountingProjection & {
  max_updated_at: number
  owner_generation_sum: number
}

export type QuotaCoordinatorDiagnostics = {
  contract_version: number
  observation_count: number
  applied_count: number
  replay_count: number
  conflict_count: number
  retained_terminal_reservations: number
  compacted_terminal_reservations: number
  legacy_terminal_reservations: number
  retention_watermark_committed_at: number
  persisted_state_json_bytes: number
  persisted_state_json_limit_bytes: number
}

export type QuotaReconciliationStatus =
  | 'matched'
  | 'mismatch'
  | 'observer_state_missing'
  | 'source_changed'

export type QuotaCoordinatorReconciliationReport = {
  contract_version: number
  status: QuotaReconciliationStatus
  token_scope_hash: string
  source_stable: boolean
  observer_healthy: boolean
  d1: D1QuotaAccountingProjection
  observer: QuotaAccountingProjection | null
  difference: QuotaAccountingProjection | null
  observer_diagnostics: QuotaCoordinatorDiagnostics | null
}

export type QuotaCoordinatorReconciliationResponse = {
  success: boolean
  message: string
  data: QuotaCoordinatorReconciliationReport
}

export type QuotaReconciliationProjectionRow = {
  field: QuotaReconciliationField
  d1: number
  observer: number | null
  difference: number | null
}

export type QuotaReconciliationNotice = Exclude<
  QuotaReconciliationStatus,
  'matched'
>

export type QuotaReconciliationPresentation = {
  notice: QuotaReconciliationNotice | null
  rows: QuotaReconciliationProjectionRow[]
}

declare const canonicalPositiveI64Brand: unique symbol
export type CanonicalPositiveI64String = string & {
  readonly [canonicalPositiveI64Brand]: true
}

export type QuotaCoordinatorReconciliationRequest = Readonly<{
  token_id: CanonicalPositiveI64String
}>

const MAX_POSITIVE_I64 = '9223372036854775807'

export function normalizePositiveI64TokenId(
  value: string
): CanonicalPositiveI64String | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const canonical = trimmed.replace(/^0+(?=\d)/, '')
  if (canonical === '0') return null
  if (canonical.length > MAX_POSITIVE_I64.length) return null
  if (
    canonical.length === MAX_POSITIVE_I64.length &&
    canonical > MAX_POSITIVE_I64
  ) {
    return null
  }

  return canonical as CanonicalPositiveI64String
}

export function canRunQuotaCoordinatorReconciliation(
  runtimeReady: boolean,
  tokenId: CanonicalPositiveI64String | null
): tokenId is CanonicalPositiveI64String {
  return runtimeReady && tokenId !== null
}

export function buildQuotaCoordinatorReconciliationRequest(
  tokenId: CanonicalPositiveI64String
): QuotaCoordinatorReconciliationRequest {
  return { token_id: tokenId }
}

export function buildQuotaReconciliationPresentation(
  report: QuotaCoordinatorReconciliationReport
): QuotaReconciliationPresentation {
  return {
    notice: report.status === 'matched' ? null : report.status,
    rows: QUOTA_RECONCILIATION_FIELDS.map((field) => ({
      field,
      d1: report.d1[field],
      observer: report.observer?.[field] ?? null,
      difference: report.difference?.[field] ?? null,
    })),
  }
}

export function buildRedactedQuotaReconciliationArchive(
  report: QuotaCoordinatorReconciliationReport
) {
  return {
    archive_schema: 'quota-coordinator-reconciliation-redacted-v1',
    contract_version: report.contract_version,
    status: report.status,
    token_scope_hash: report.token_scope_hash,
    source_stable: report.source_stable,
    observer_healthy: report.observer_healthy,
    d1: pickProjection(report.d1),
    observer: report.observer ? pickProjection(report.observer) : null,
    difference: report.difference ? pickProjection(report.difference) : null,
    observer_diagnostics: report.observer_diagnostics
      ? pickDiagnostics(report.observer_diagnostics)
      : null,
  }
}

export function stringifyRedactedQuotaReconciliationArchive(
  report: QuotaCoordinatorReconciliationReport
) {
  return JSON.stringify(
    buildRedactedQuotaReconciliationArchive(report),
    null,
    2
  )
}

function pickProjection(
  projection: QuotaAccountingProjection
): QuotaAccountingProjection {
  return Object.fromEntries(
    QUOTA_RECONCILIATION_FIELDS.map((field) => [field, projection[field]])
  ) as QuotaAccountingProjection
}

function pickDiagnostics(
  diagnostics: QuotaCoordinatorDiagnostics
): QuotaCoordinatorDiagnostics {
  return {
    contract_version: diagnostics.contract_version,
    observation_count: diagnostics.observation_count,
    applied_count: diagnostics.applied_count,
    replay_count: diagnostics.replay_count,
    conflict_count: diagnostics.conflict_count,
    retained_terminal_reservations: diagnostics.retained_terminal_reservations,
    compacted_terminal_reservations:
      diagnostics.compacted_terminal_reservations,
    legacy_terminal_reservations: diagnostics.legacy_terminal_reservations,
    retention_watermark_committed_at:
      diagnostics.retention_watermark_committed_at,
    persisted_state_json_bytes: diagnostics.persisted_state_json_bytes,
    persisted_state_json_limit_bytes:
      diagnostics.persisted_state_json_limit_bytes,
  }
}
