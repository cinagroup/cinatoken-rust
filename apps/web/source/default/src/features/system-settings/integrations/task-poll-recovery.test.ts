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
  buildTaskPollRecoveryDecision,
  canApplyTaskPollRecovery,
  compactTaskPollRecoveryDigest,
  isTaskPollRecoveryEvidenceReferenceValid,
  taskPollRecoveryTargetKey,
} from './task-poll-recovery'

describe('task poll recovery contract', () => {
  test('normalizes evidence without changing the selected reason', () => {
    assert.deepEqual(
      buildTaskPollRecoveryDecision(
        'provider_incident_resolved',
        '  incident:INC-42  '
      ),
      {
        reason: 'provider_incident_resolved',
        evidence_reference: 'incident:INC-42',
      }
    )
  })

  test('matches the backend evidence reference allowlist', () => {
    assert.equal(
      isTaskPollRecoveryEvidenceReferenceValid('incident:INC-42/#update_1'),
      true
    )
    assert.equal(
      isTaskPollRecoveryEvidenceReferenceValid('secret value with spaces'),
      false
    )
    assert.equal(
      isTaskPollRecoveryEvidenceReferenceValid('a'.repeat(129)),
      false
    )
  })

  test('compacts only canonical public task id hashes', () => {
    assert.equal(
      compactTaskPollRecoveryDigest('a'.repeat(64)),
      'aaaaaaaaaaaa...aaaaaaaa'
    )
    assert.equal(
      compactTaskPollRecoveryDigest('provider-task-id'),
      'invalid-task-id-hash'
    )
  })

  test('builds an entity-scoped target key without provider identifiers', () => {
    assert.equal(
      taskPollRecoveryTargetKey({ entity_kind: 'midjourney', entity_id: 42 }),
      'midjourney:42'
    )
  })

  test('fails apply closed when runtime, mutation, or timeout eligibility is missing', () => {
    assert.equal(
      canApplyTaskPollRecovery({
        runtimeReady: true,
        mutationEnabled: true,
        timeoutEligible: true,
      }),
      true
    )
    assert.equal(
      canApplyTaskPollRecovery({
        runtimeReady: false,
        mutationEnabled: true,
        timeoutEligible: true,
      }),
      false
    )
    assert.equal(
      canApplyTaskPollRecovery({
        runtimeReady: true,
        mutationEnabled: false,
        timeoutEligible: true,
      }),
      false
    )
    assert.equal(
      canApplyTaskPollRecovery({
        runtimeReady: true,
        mutationEnabled: true,
        timeoutEligible: false,
      }),
      false
    )
  })
})
