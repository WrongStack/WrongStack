import { describe, expect, it } from 'vitest';
import { buildKnownModelSet } from '../src/lib/fallback-ref';

describe('buildKnownModelSet (F2165)', () => {
  it('trims provider/model and omits whitespace-only entries', () => {
    const set = buildKnownModelSet([
      { provider: ' openai ', model: ' gpt-5 ' },
      { provider: '   ', model: 'gpt-5' },
      { provider: 'openai', model: '   ' },
    ]);
    expect([...set]).toEqual(['openai/gpt-5']);
  });
});
