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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildQuotaCoordinatorReconciliationRequest,
  buildQuotaReconciliationPresentation,
  buildRedactedQuotaReconciliationArchive,
  canRunQuotaCoordinatorReconciliation,
  normalizePositiveI64TokenId,
  QUOTA_RECONCILIATION_FIELDS,
  type D1QuotaAccountingProjection,
  type QuotaAccountingProjection,
  type QuotaCoordinatorReconciliationReport,
} from './quota-coordinator-reconciliation'

describe('QuotaCoordinator reconciliation helpers', () => {
  test('normalizes only positive signed 64-bit token ids', () => {
    assert.equal(normalizePositiveI64TokenId('1'), '1')
    assert.equal(
      normalizePositiveI64TokenId('9223372036854775807'),
      '9223372036854775807'
    )
    assert.equal(normalizePositiveI64TokenId(' 00042 '), '42')

    for (const invalid of [
      '',
      '0',
      '-1',
      '+1',
      '1.0',
      '9223372036854775808',
      '18446744073709551615',
    ]) {
      assert.equal(normalizePositiveI64TokenId(invalid), null, invalid)
    }
  })

  test('gates execution on runtime readiness and builds a token-only body', () => {
    const tokenId = normalizePositiveI64TokenId('00042')
    assert.ok(tokenId)

    assert.equal(canRunQuotaCoordinatorReconciliation(false, tokenId), false)
    assert.equal(canRunQuotaCoordinatorReconciliation(true, null), false)
    assert.equal(canRunQuotaCoordinatorReconciliation(true, tokenId), true)
    assert.deepEqual(buildQuotaCoordinatorReconciliationRequest(tokenId), {
      token_id: '42',
    })
  })

  test('builds a redacted archive from an explicit field allowlist', () => {
    const report = {
      ...makeReport(),
      token_id: '9223372036854775807',
      unexpected_secret: 'do-not-copy',
    } as QuotaCoordinatorReconciliationReport & {
      token_id: string
      unexpected_secret: string
    }
    const archive = buildRedactedQuotaReconciliationArchive(report)
    const encoded = JSON.stringify(archive)

    assert.equal(Object.hasOwn(archive, 'token_id'), false)
    assert.equal(Object.hasOwn(archive, 'unexpected_secret'), false)
    assert.equal(encoded.includes('do-not-copy'), false)
    assert.equal(archive.token_scope_hash, 'a'.repeat(64))
    assert.deepEqual(Object.keys(archive.d1), QUOTA_RECONCILIATION_FIELDS)
  })

  test('presents mismatch values across D1, observer, and difference', () => {
    const report = makeReport({ status: 'mismatch', observer_healthy: false })
    report.observer = makeProjection({ refund_count: 2 })
    report.difference = makeProjection({ refund_count: 2 })

    const presentation = buildQuotaReconciliationPresentation(report)
    const refundRow = presentation.rows.find(
      (row) => row.field === 'refund_count'
    )

    assert.equal(presentation.notice, 'mismatch')
    assert.equal(presentation.rows.length, 13)
    assert.deepEqual(refundRow, {
      field: 'refund_count',
      d1: 0,
      observer: 2,
      difference: 2,
    })
  })

  test('suppresses differences when the D1 source changes', () => {
    const report = makeReport({
      status: 'source_changed',
      source_stable: false,
      observer_healthy: false,
    })
    report.difference = null

    const presentation = buildQuotaReconciliationPresentation(report)

    assert.equal(presentation.notice, 'source_changed')
    assert.equal(
      presentation.rows.every((row) => row.difference === null),
      true
    )
  })

  test('shows unavailable observer data when observer state is missing', () => {
    const report = makeReport({
      status: 'observer_state_missing',
      observer_healthy: false,
    })
    report.observer = null
    report.difference = null
    report.observer_diagnostics = null

    const presentation = buildQuotaReconciliationPresentation(report)

    assert.equal(presentation.notice, 'observer_state_missing')
    assert.equal(
      presentation.rows.every(
        (row) => row.observer === null && row.difference === null
      ),
      true
    )
  })
})

function makeProjection(
  overrides: Partial<QuotaAccountingProjection> = {}
): QuotaAccountingProjection {
  const projection = Object.fromEntries(
    QUOTA_RECONCILIATION_FIELDS.map((field) => [field, 0])
  ) as QuotaAccountingProjection
  return { ...projection, ...overrides }
}

function makeD1Projection(): D1QuotaAccountingProjection {
  return {
    ...makeProjection(),
    max_updated_at: 1,
    owner_generation_sum: 1,
  }
}

function makeReport(
  overrides: Partial<QuotaCoordinatorReconciliationReport> = {}
): QuotaCoordinatorReconciliationReport {
  return {
    contract_version: 1,
    status: 'matched',
    token_scope_hash: 'a'.repeat(64),
    source_stable: true,
    observer_healthy: true,
    d1: makeD1Projection(),
    observer: makeProjection(),
    difference: makeProjection(),
    observer_diagnostics: {
      contract_version: 1,
      observation_count: 1,
      applied_count: 1,
      replay_count: 0,
      conflict_count: 0,
      retained_terminal_reservations: 0,
      compacted_terminal_reservations: 0,
      legacy_terminal_reservations: 0,
      retention_watermark_committed_at: 0,
      persisted_state_json_bytes: 512,
      persisted_state_json_limit_bytes: 1_500_000,
    },
    ...overrides,
  }
}
