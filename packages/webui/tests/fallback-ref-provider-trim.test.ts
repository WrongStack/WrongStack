import { describe, expect, it } from 'vitest';
import { refInactiveReason, splitProviderModel } from '../src/lib/fallback-ref.js';

describe('splitProviderModel provider whitespace trimming (F1877)', () => {
  it('trims providerId around the slash so knownModels lookups succeed', () => {
    const known = new Set(['openai/gpt-5']);
    expect(splitProviderModel('  openai  /  gpt-5  ')).toEqual({
      providerId: 'openai',
      model: 'gpt-5',
    });
    expect(refInactiveReason('  openai  /  gpt-5  ', known)).toBeUndefined();
    expect(refInactiveReason('   / gpt-5', known)).toBe('no provider in reference');
  });
});
