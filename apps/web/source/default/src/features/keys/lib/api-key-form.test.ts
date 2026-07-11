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
import { apiKeySchema } from '../types'
import {
  getApiKeyFormDefaultValues,
  transformApiKeyToFormDefaults,
  transformFormDataToPayload,
  type ApiKeyFormValues,
} from './api-key-form'

const baseForm: ApiKeyFormValues = {
  name: 'routing-policy',
  remain_quota_dollars: 10,
  expired_time: undefined,
  unlimited_quota: true,
  model_limits: [],
  allow_ips: '',
  group: 'auto',
  cross_group_retry: true,
  tokenCount: 1,
}

describe('API key cross-group retry form contract', () => {
  test('keeps the existing default tied to default auto-group selection', () => {
    assert.equal(getApiKeyFormDefaultValues(true).cross_group_retry, true)
    assert.equal(getApiKeyFormDefaultValues(false).cross_group_retry, false)
  })

  test('sends the selected policy only for auto-group tokens', () => {
    assert.equal(transformFormDataToPayload(baseForm).cross_group_retry, true)
    assert.equal(
      transformFormDataToPayload({
        ...baseForm,
        cross_group_retry: false,
      }).cross_group_retry,
      false
    )
    assert.equal(
      transformFormDataToPayload({
        ...baseForm,
        group: 'default',
        cross_group_retry: true,
      }).cross_group_retry,
      false
    )
  })

  test('round-trips numeric API values without changing their meaning', () => {
    const enabled = transformApiKeyToFormDefaults(apiKeyFixture(1))
    const disabled = transformApiKeyToFormDefaults(apiKeyFixture(0))

    assert.equal(enabled.cross_group_retry, true)
    assert.equal(disabled.cross_group_retry, false)
    assert.equal(transformFormDataToPayload(enabled).cross_group_retry, true)
    assert.equal(transformFormDataToPayload(disabled).cross_group_retry, false)
  })
})

function apiKeyFixture(crossGroupRetry: 0 | 1) {
  return apiKeySchema.parse({
    id: 1,
    name: 'routing-policy',
    key: 'sk-test',
    status: 1,
    remain_quota: 0,
    used_quota: 0,
    unlimited_quota: true,
    expired_time: -1,
    created_time: 1,
    accessed_time: 1,
    group: 'auto',
    cross_group_retry: crossGroupRetry,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '',
  })
}
