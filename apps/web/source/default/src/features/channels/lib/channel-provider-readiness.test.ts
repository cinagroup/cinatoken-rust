import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  indexProviderReadiness,
  providerReadinessPresentation,
} from './channel-provider-readiness'

describe('channel provider relay readiness', () => {
  test('indexes entries by channel type without changing route evidence', () => {
    const deepseek = {
      channel_type: 43,
      name: 'DeepSeek',
      adapter: 'deep_seek',
      readiness: 'partial' as const,
      routes: [{ method: 'POST', path: '/v1/messages' }],
      reason: 'partial implementation',
    }
    const xai = {
      channel_type: 48,
      name: 'xAI',
      adapter: 'xai_open_ai',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/completions' },
        { method: 'POST', path: '/v1/responses' },
        { method: 'POST', path: '/v1/images/generations' },
      ],
      reason: 'dedicated route-explicit implementation',
    }
    const index = indexProviderReadiness([deepseek, xai])
    assert.equal(index.get(43), deepseek)
    assert.equal(index.get(43)?.routes[0]?.path, '/v1/messages')
    assert.equal(index.get(48), xai)
    assert.deepEqual(
      index.get(48)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/responses',
        '/v1/images/generations',
      ]
    )
    assert.equal(index.get(15), undefined)
  })

  test('maps the three implementation states to stable badge treatments', () => {
    assert.deepEqual(providerReadinessPresentation('ready'), {
      label: 'Ready',
      variant: 'success',
    })
    assert.deepEqual(providerReadinessPresentation('partial'), {
      label: 'Partial',
      variant: 'warning',
    })
    assert.deepEqual(providerReadinessPresentation('deferred'), {
      label: 'Deferred',
      variant: 'neutral',
    })
  })
})
