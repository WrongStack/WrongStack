import { describe, expect, it } from 'vitest';
import { createSystemOneTierSuggester } from '../src/system-one-tier.js';

describe('createSystemOneTierSuggester option sanitization', () => {
  it('falls back to defaults for negative timeoutMs and NaN minConfidence', async () => {
    const config = {
      modelTiers: {
        enabled: true,
        default: 'fast',
        levels: { fast: { provider: 'p', model: 'm1' }, strong: { provider: 'p', model: 'm2' } },
      },
    } as ReturnType<Parameters<typeof createSystemOneTierSuggester>[0]['getConfig']>;
    const judge = {
      feature: 'tier',
      model: 'judge',
      client: {
        systemOne: async () => ({
          answers: { tier: { type: 'choice', choice: 'strong', confidence: 0.9 } },
        }),
      },
    } as ReturnType<Parameters<typeof createSystemOneTierSuggester>[0]['getJudge']>;

    const suggest = createSystemOneTierSuggester({
      getConfig: () => config,
      getJudge: () => judge,
      timeoutMs: -1,
      minConfidence: Number.NaN,
    });
    expect(await suggest({ task: 'refactor architecture' })).toBe('strong');
  });
});
