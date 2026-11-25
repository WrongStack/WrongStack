import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { projectSavedProviders } from '../src/server/provider/projection.js';

describe('projectSavedProviders string model trimming', () => {
  it('trims string model entries and skips whitespace-only strings', () => {
    const views = projectSavedProviders({
      openai: { type: 'openai', models: ['   ', '  gpt-4o  ', 'gpt-4o'] } as ProviderConfig,
    });
    expect(views[0]?.models).toEqual(['gpt-4o']);
    expect(views[0]?.pickedModelId).toBe('gpt-4o');
  });
});
