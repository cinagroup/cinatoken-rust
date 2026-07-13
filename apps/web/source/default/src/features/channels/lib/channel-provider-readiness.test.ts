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
    const mistral = {
      channel_type: 42,
      name: 'Mistral',
      adapter: 'mistral_open_ai',
      readiness: 'partial' as const,
      routes: [{ method: 'POST', path: '/v1/chat/completions' }],
      reason: 'dedicated Go-compatible chat implementation',
    }
    const perplexity = {
      channel_type: 27,
      name: 'Perplexity',
      adapter: 'perplexity_open_ai',
      readiness: 'partial' as const,
      routes: [{ method: 'POST', path: '/v1/chat/completions' }],
      reason: 'dedicated Sonar chat implementation',
    }
    const submodel = {
      channel_type: 53,
      name: 'Submodel',
      adapter: 'submodel_open_ai',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/completions' },
      ],
      reason: 'direct-only opaque-model implementation',
    }
    const siliconflow = {
      channel_type: 40,
      name: 'SiliconFlow',
      adapter: 'silicon_flow_open_ai',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/completions' },
        { method: 'POST', path: '/v1/embeddings' },
        { method: 'POST', path: '/v1/rerank' },
        { method: 'POST', path: '/v1/images/generations' },
      ],
      reason: 'direct-only multi-route implementation',
    }
    const jina = {
      channel_type: 38,
      name: 'Jina',
      adapter: 'rerank',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/rerank' },
        { method: 'POST', path: '/v1/embeddings' },
      ],
      reason: 'rerank and embeddings implementation',
    }
    const mokaai = {
      channel_type: 44,
      name: 'MokaAI',
      adapter: 'dedicated_pending',
      readiness: 'deferred' as const,
      routes: [],
      reason: 'hosted provider contract remains unverified',
    }
    const moonshot = {
      channel_type: 25,
      name: 'Moonshot',
      adapter: 'moonshot',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/completions' },
        { method: 'POST', path: '/v1/embeddings' },
        { method: 'POST', path: '/v1/rerank' },
        { method: 'POST', path: '/v1/messages' },
      ],
      reason: 'direct-only dual-format implementation',
    }
    const zhipuV4 = {
      channel_type: 26,
      name: 'ZhipuV4',
      adapter: 'zhipu_v4',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/embeddings' },
        { method: 'POST', path: '/v1/images/generations' },
        { method: 'POST', path: '/v1/messages' },
      ],
      reason: 'direct-only current v4 implementation',
    }
    const volcengine = {
      channel_type: 45,
      name: 'VolcEngine',
      adapter: 'volc_engine_open_ai',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/embeddings' },
        { method: 'POST', path: '/v1/images/generations' },
        { method: 'POST', path: '/v1/responses' },
      ],
      reason: 'direct-only Ark v3 implementation',
    }
    const baiduV2 = {
      channel_type: 46,
      name: 'BaiduV2',
      adapter: 'baidu_v2_open_ai',
      readiness: 'partial' as const,
      routes: [{ method: 'POST', path: '/v1/chat/completions' }],
      reason: 'direct-only Qianfan v2 chat implementation',
    }
    const ali = {
      channel_type: 17,
      name: 'Ali',
      adapter: 'ali',
      readiness: 'partial' as const,
      routes: [
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'POST', path: '/v1/completions' },
        { method: 'POST', path: '/v1/responses' },
        { method: 'POST', path: '/v1/embeddings' },
        { method: 'POST', path: '/v1/messages' },
        { method: 'POST', path: '/v1/rerank' },
      ],
      reason: 'direct-only DashScope multi-route implementation',
    }
    const index = indexProviderReadiness([
      ali,
      moonshot,
      zhipuV4,
      perplexity,
      jina,
      siliconflow,
      mistral,
      deepseek,
      mokaai,
      volcengine,
      baiduV2,
      xai,
      submodel,
    ])
    assert.equal(index.get(17), ali)
    assert.deepEqual(
      index.get(17)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/responses',
        '/v1/embeddings',
        '/v1/messages',
        '/v1/rerank',
      ]
    )
    assert.equal(index.get(25), moonshot)
    assert.deepEqual(
      index.get(25)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/embeddings',
        '/v1/rerank',
        '/v1/messages',
      ]
    )
    assert.equal(index.get(27), perplexity)
    assert.equal(index.get(26), zhipuV4)
    assert.deepEqual(
      index.get(26)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/embeddings',
        '/v1/images/generations',
        '/v1/messages',
      ]
    )
    assert.deepEqual(index.get(27)?.routes, [
      { method: 'POST', path: '/v1/chat/completions' },
    ])
    assert.equal(index.get(42), mistral)
    assert.deepEqual(index.get(42)?.routes, [
      { method: 'POST', path: '/v1/chat/completions' },
    ])
    assert.equal(index.get(43), deepseek)
    assert.equal(index.get(43)?.routes[0]?.path, '/v1/messages')
    assert.equal(index.get(38), jina)
    assert.deepEqual(
      index.get(38)?.routes.map((route) => route.path),
      ['/v1/rerank', '/v1/embeddings']
    )
    assert.equal(index.get(40), siliconflow)
    assert.deepEqual(
      index.get(40)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/embeddings',
        '/v1/rerank',
        '/v1/images/generations',
      ]
    )
    assert.equal(index.get(44), mokaai)
    assert.equal(index.get(44)?.readiness, 'deferred')
    assert.deepEqual(index.get(44)?.routes, [])
    assert.equal(index.get(45), volcengine)
    assert.deepEqual(
      index.get(45)?.routes.map((route) => route.path),
      [
        '/v1/chat/completions',
        '/v1/embeddings',
        '/v1/images/generations',
        '/v1/responses',
      ]
    )
    assert.equal(index.get(46), baiduV2)
    assert.deepEqual(index.get(46)?.routes, [
      { method: 'POST', path: '/v1/chat/completions' },
    ])
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
    assert.equal(index.get(53), submodel)
    assert.deepEqual(
      index.get(53)?.routes.map((route) => route.path),
      ['/v1/chat/completions', '/v1/completions']
    )
    assert.equal(index.get(15), undefined)
  })

  test('maps the three implementation states to stable badge treatments', () => {
    assert.deepEqual(providerReadinessPresentation('ready'), {
      label: 'Implemented',
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
