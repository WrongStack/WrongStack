import type { ProviderConfig } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { projectSavedProviders } from '@wrongstack/webui-server';

/**
 * ME-3 regression tests: providers.saved wire shape now carries
 * the full modelsDev payload (cost, modalities.output, dates, etc.)
 * alongside the legacy name/maxOutput/capabilities fields.
 */

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'acme', ...over };
}

describe('ME-3: providers.saved carries full modelsDev', () => {
  it('round-trips modelsDev in the providers.saved broadcast', () => {
    const [view] = projectSavedProviders({
      acme: cfg({
        models: ['acme-pro'],
        customModels: {
          'acme-pro': {
            name: 'Acme Pro',
            maxOutput: 64_000,
            modelsDev: {
              name: 'Acme Pro',
              description: 'Full-featured model',
              cost: { input: 5, output: 20, cache_read: 0.5 },
              limit: { context: 500_000, output: 64_000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
              reasoning: true,
              tool_call: true,
              knowledge: '2025-06-01',
              release_date: '2026-01-15',
            },
          },
        },
      }),
    });
    expect(view?.customModels?.['acme-pro']?.modelsDev).toMatchObject({
      name: 'Acme Pro',
      description: 'Full-featured model',
      cost: { input: 5, output: 20, cache_read: 0.5 },
      limit: { context: 500_000, output: 64_000 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoning: true,
      tool_call: true,
      knowledge: '2025-06-01',
      release_date: '2026-01-15',
    });
  });

  it('passes modelsDev: undefined when customModels has no modelsDev', () => {
    const [view] = projectSavedProviders({
      acme: cfg({
        models: ['legacy'],
        customModels: { legacy: { name: 'Legacy', maxOutput: 4_096 } },
      }),
    });
    expect(view?.customModels?.['legacy']?.modelsDev).toBeUndefined();
  });

  it('returns customModels: undefined when no customModels are set', () => {
    const [view] = projectSavedProviders({
      acme: cfg({ models: ['plain-string-model'] }),
    });
    expect(view?.customModels).toBeUndefined();
  });
});
