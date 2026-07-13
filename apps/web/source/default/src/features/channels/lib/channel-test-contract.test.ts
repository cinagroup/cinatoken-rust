import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ChannelTestResponse } from '../types'
import {
  channelTestAllContractValid,
  channelTestSuccessContractError,
} from './channel-test-contract'

const validResponse: ChannelTestResponse = {
  success: true,
  message: '',
  time: 0.12,
  data: {
    response_time: 120,
    requested: {
      model: 'gpt-4.1-mini',
      endpoint_type: 'openai',
      stream: false,
    },
    effective: {
      model: 'gpt-4.1-mini',
      endpoint_type: 'openai',
      route: '/v1/chat/completions',
      stream: false,
      transport: 'direct',
    },
    validation: {
      mode: 'json',
      content_type: 'application/json',
      response_validated: true,
    },
  },
}

describe('channel test evidence contract', () => {
  test('accepts matching validated JSON evidence', () => {
    assert.equal(
      channelTestSuccessContractError(validResponse, {
        model: 'gpt-4.1-mini',
        endpoint_type: 'openai',
      }),
      undefined
    )
  })

  test('rejects silently ignored endpoint and stream controls', () => {
    assert.match(
      channelTestSuccessContractError(validResponse, {
        endpoint_type: 'anthropic',
      }) ?? '',
      /endpoint acknowledgement/u
    )
    assert.match(
      channelTestSuccessContractError(validResponse, {
        endpoint_type: 'openai',
        stream: true,
      }) ?? '',
      /stream acknowledgement/u
    )
  })

  test('requires endpoint-specific upstream validation evidence', () => {
    const unvalidated = structuredClone(validResponse)
    unvalidated.data!.validation.response_validated = false
    assert.match(
      channelTestSuccessContractError(unvalidated, {
        endpoint_type: 'openai',
      }) ?? '',
      /not validated/u
    )

    const wrongMode = structuredClone(validResponse)
    wrongMode.data!.requested.stream = true
    wrongMode.data!.effective.stream = true
    assert.match(
      channelTestSuccessContractError(wrongMode, {
        endpoint_type: 'openai',
        stream: true,
      }) ?? '',
      /validation mode/u
    )

    assert.match(
      channelTestSuccessContractError({
        success: true,
        data: {} as ChannelTestResponse['data'],
      }) ?? '',
      /requested probe evidence/u
    )
  })

  test('accepts only internally consistent synchronous batch summaries', () => {
    assert.equal(
      channelTestAllContractValid({
        success: true,
        data: {
          attempted: 3,
          succeeded: 2,
          failed: 1,
          skipped: 4,
          max_channels: 12,
        },
      }),
      true
    )
    assert.equal(
      channelTestAllContractValid({
        success: true,
        data: {
          attempted: 3,
          succeeded: 3,
          failed: 1,
          skipped: 0,
          max_channels: 12,
        },
      }),
      false
    )
  })
})
