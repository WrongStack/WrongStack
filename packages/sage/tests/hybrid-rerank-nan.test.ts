import { describe, expect, it } from 'vitest';
import { hybridRerankMemories } from '../src/retrieval/hybrid-rerank.js';
import type { Sage } from '../src/types.js';

describe('hybridRerankMemories non-finite weight guard', () => {
  it('falls back to default semantic weight when semanticWeight is NaN', () => {
    const items = [
      { id: '1', text: 'alpha beta gamma' },
      { id: '2', text: 'delta epsilon zeta' },
      { id: '3', text: 'theta iota kappa' },
      { id: '4', text: 'database migration postgres index schema' },
    ] as Sage[];
    const withDefault = hybridRerankMemories(
      'database migration postgres index schema',
      items,
      0.25,
    );
    const withNaN = hybridRerankMemories(
      'database migration postgres index schema',
      items,
      Number.NaN,
    );
    expect(withNaN.map((x) => x.id)).toEqual(withDefault.map((x) => x.id));
  });
});
