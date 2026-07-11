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
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  transformFormDataToCreatePayload,
} from './channel-form'

describe('WFP channel transport form contract', () => {
  const validSchemaValues = {
    ...CHANNEL_FORM_DEFAULT_VALUES,
    name: 'WFP channel',
    models: 'openai/gpt-4.1',
  }

  test('stores the worker in other_info without dropping unrelated settings', () => {
    const result = transformFormDataToCreatePayload({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'WFP channel',
      models: 'openai/gpt-4.1',
      key: 'internal',
      other_info: JSON.stringify({ custom: { keep: true } }),
      wfp_worker: 'tenant-a',
    })

    assert.deepEqual(JSON.parse(result.channel.other_info || '{}'), {
      custom: { keep: true },
      wfp_worker: 'tenant-a',
    })
  })

  test('does not silently drop an explicit worker when legacy other_info is malformed', () => {
    const result = transformFormDataToCreatePayload({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'WFP channel',
      models: 'openai/gpt-4.1',
      key: 'internal',
      other_info: 'legacy-not-json',
      wfp_worker: 'tenant-a',
    })
    assert.deepEqual(JSON.parse(result.channel.other_info || '{}'), {
      wfp_worker: 'tenant-a',
    })
  })

  test('rejects invalid names and conflicting direct AI Gateway routing', () => {
    assert.equal(
      channelFormSchema.safeParse({
        ...validSchemaValues,
        wfp_worker: '../tenant',
      }).success,
      false
    )
    assert.equal(
      channelFormSchema.safeParse({
        ...validSchemaValues,
        ai_gateway_enabled: true,
        wfp_worker: 'tenant-a',
      }).success,
      false
    )
  })

  test('accepts an explicit WFP worker without direct Gateway opt-in', () => {
    assert.equal(
      channelFormSchema.safeParse({
        ...validSchemaValues,
        ai_gateway_enabled: false,
        wfp_worker: 'tenant_1',
      }).success,
      true
    )
  })
})
