import type { ProviderReadinessEntry, ProviderRelayReadiness } from '../types'

export type ProviderReadinessVariant = 'success' | 'warning' | 'neutral'

export function indexProviderReadiness(
  entries: ProviderReadinessEntry[]
): ReadonlyMap<number, ProviderReadinessEntry> {
  return new Map(entries.map((entry) => [entry.channel_type, entry]))
}

export function providerReadinessPresentation(
  readiness: ProviderRelayReadiness
): {
  label: 'Implemented' | 'Partial' | 'Deferred'
  variant: ProviderReadinessVariant
} {
  switch (readiness) {
    case 'ready':
      return { label: 'Implemented', variant: 'success' }
    case 'partial':
      return { label: 'Partial', variant: 'warning' }
    case 'deferred':
      return { label: 'Deferred', variant: 'neutral' }
  }
}
