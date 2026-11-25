import { describe, expect, it } from 'vitest';
import { renderFallbackView } from '../src/slash-commands/fallback-chain-view.js';

describe('renderFallbackView prototype-safe profile lookup', () => {
  it('ignores inherited Object.prototype keys when resolving active fallbackProfile', () => {
    const view = renderFallbackView({
      configStore: {
        get: () => ({
          provider: 'openai',
          model: 'gpt-4o',
          fallbackProfile: 'toString',
          fallbackProfiles: {},
        }),
      },
    } as Parameters<typeof renderFallbackView>[0]);
    expect(view).not.toContain('toString');
  });
});
