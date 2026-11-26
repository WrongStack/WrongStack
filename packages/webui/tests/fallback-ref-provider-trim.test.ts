import { describe, expect, it } from 'vitest';
import { refAdvisory, splitProviderModel } from '../src/lib/fallback-ref.js';

describe('splitProviderModel provider whitespace trimming (F1877)', () => {
  it('trims providerId around the slash so knownModels lookups succeed', () => {
    const known = new Set(['openai/gpt-5']);
    expect(splitProviderModel('  openai  /  gpt-5  ')).toEqual({
      providerId: 'openai',
      model: 'gpt-5',
    });
    expect(refAdvisory('  openai  /  gpt-5  ', known)).toBeUndefined();
    expect(refAdvisory('   / gpt-5', known)).toBe(
      'no provider in reference — uses the active provider',
    );
  });
});
