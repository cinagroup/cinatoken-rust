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
  canAttachTaskSubmitReconciliation,
  compactTaskSubmitReconciliationId,
  isTaskProviderIdValid,
  type TaskSubmitReconciliationQueueRecord,
} from './task-submit-reconciliation'

const record: TaskSubmitReconciliationQueueRecord = {
  reconciliation_id: 'a'.repeat(64),
  reconciliation_revision: 1,
  task_kind: 'task',
  public_task_id: 'task_public',
  provider_kind: 'suno',
  provider_task_id: '',
  quota: 100,
  funding_source: 'wallet',
  quarantine_reason: 'provider_submit_result_unknown',
  quarantine_required_at: 1_800_000_000,
  attach_contract_sha256: 'b'.repeat(64),
  attach_available: true,
}

describe('task submit reconciliation contract', () => {
  test('compacts only canonical reconciliation ids', () => {
    assert.equal(
      compactTaskSubmitReconciliationId('a'.repeat(64)),
      'aaaaaaaaaaaa...aaaaaaaa'
    )
    assert.equal(
      compactTaskSubmitReconciliationId('not-an-id'),
      'invalid-reconciliation-id'
    )
  })

  test('rejects provider ids that could alter a poll path', () => {
    assert.equal(isTaskProviderIdValid('provider-task_1:2'), true)
    assert.equal(isTaskProviderIdValid('../other/task'), false)
    assert.equal(isTaskProviderIdValid('task id'), false)
  })

  test('keeps legacy rows refund-only', () => {
    assert.equal(canAttachTaskSubmitReconciliation(record), true)
    assert.equal(
      canAttachTaskSubmitReconciliation({ ...record, attach_available: false }),
      false
    )
  })
})
