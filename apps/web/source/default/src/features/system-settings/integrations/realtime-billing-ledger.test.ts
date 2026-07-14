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
  compactRealtimeBillingFingerprint,
  compactRealtimeBillingReconciliationId,
  normalizeRealtimeBillingLedgerStatus,
  summarizeRealtimeBillingLedger,
  type RealtimeBillingLedgerStatus,
} from './realtime-billing-ledger'

describe('Realtime billing ledger presentation', () => {
  test('summarizes terminal and manual reconciliation records', () => {
    const status = ledgerFixture()
    assert.deepEqual(summarizeRealtimeBillingLedger(status), {
      total: 2,
      active: 1,
      terminal: 1,
      reconciliationRequired: 1,
    })
  })

  test('normalizes only redacted contract fields', () => {
    const status = ledgerFixture() as RealtimeBillingLedgerStatus & {
      session: string
    }
    status.session = 'raw-session-id'
    Object.assign(status.records[0], {
      bridge_segment: 'raw-bridge-segment',
      upstream_response_id: 'resp_raw_provider_identity',
      reconciliation_resolution_key: 'private-resolution-key',
    })

    const normalized = normalizeRealtimeBillingLedgerStatus(status)
    const serialized = JSON.stringify(normalized)
    assert.doesNotMatch(serialized, /raw-session-id/u)
    assert.doesNotMatch(serialized, /raw-bridge-segment/u)
    assert.doesNotMatch(serialized, /resp_raw_provider_identity/u)
    assert.doesNotMatch(serialized, /private-resolution-key/u)
    assert.match(serialized, /response_usage_null/u)
  })

  test('compacts only canonical reconciliation ids', () => {
    const reconciliationId = 'e'.repeat(64)
    assert.equal(
      compactRealtimeBillingReconciliationId(reconciliationId),
      `${'e'.repeat(12)}...${'e'.repeat(8)}`
    )
    assert.equal(
      compactRealtimeBillingReconciliationId('raw-reservation-id'),
      'invalid-reconciliation-id'
    )
  })

  test('compacts only canonical sha256 fingerprints', () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`
    assert.equal(
      compactRealtimeBillingFingerprint(fingerprint),
      `sha256:${'a'.repeat(8)}...${'a'.repeat(8)}`
    )
    assert.equal(
      compactRealtimeBillingFingerprint('raw-session-id'),
      'invalid-fingerprint'
    )
  })
})

function ledgerFixture(): RealtimeBillingLedgerStatus {
  const fingerprint = `sha256:${'a'.repeat(64)}`
  return {
    contract_version: 3,
    count: 2,
    global_sweep: null,
    records: [
      {
        reservation_fingerprint: fingerprint,
        scope_kind: 'realtime_bridge_segment',
        scope_fingerprint: `sha256:${'b'.repeat(64)}`,
        outcome: 'recovery_required',
        terminal: false,
        reservation_sequence: 1,
        lease_expires_at: 100,
        updated_at: 101,
        settled_at: null,
        refunded_at: null,
        recovery_attempt_count: 0,
        recovery_next_attempt_at: null,
        recovery_last_attempt_at: null,
        recovery_state: 'manual_reconciliation',
        requires_reconciliation: true,
        finalization_reason: 'response_usage_null',
        finalization_required_at: 101,
        reconciliation_id: 'e'.repeat(64),
        reconciliation_revision: 1,
        reconciliation_resolution: null,
        reconciliation_resolved_at: null,
      },
      {
        reservation_fingerprint: `sha256:${'c'.repeat(64)}`,
        scope_kind: 'realtime_bridge_segment',
        scope_fingerprint: `sha256:${'d'.repeat(64)}`,
        outcome: 'settled',
        terminal: true,
        reservation_sequence: 2,
        lease_expires_at: 200,
        updated_at: 201,
        settled_at: 201,
        refunded_at: null,
        recovery_attempt_count: 0,
        recovery_next_attempt_at: null,
        recovery_last_attempt_at: null,
        recovery_state: 'terminal',
        requires_reconciliation: false,
        finalization_reason: null,
        finalization_required_at: null,
        reconciliation_id: 'f'.repeat(64),
        reconciliation_revision: 2,
        reconciliation_resolution: 'settled',
        reconciliation_resolved_at: 201,
      },
    ],
  }
}
