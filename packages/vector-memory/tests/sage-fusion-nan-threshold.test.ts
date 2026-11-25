import type { Sage } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { fuseWithVectorMemory } from '../src/sage-fusion.js';
import type { VectorSearchHit } from '../src/types.js';

const makeMemory = (id: string, text: string): Sage =>
  ({
    id,
    text,
    kind: 'fact',
    scope: 'project',
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as unknown as Sage;

const makeHit = (sageId: string, score: number): VectorSearchHit => ({
  score,
  entry: {
    id: `vec-${sageId}`,
    scope: 'project',
    kind: 'fact',
    text: `text for ${sageId}`,
    tags: [],
    metadata: { sageId },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

describe('fuseWithVectorMemory non-finite score filtering (F1832)', () => {
  it('does not let NaN or non-finite vector scores bypass threshold filtering', async () => {
    const lexical = [makeMemory('m1', 'first'), makeMemory('m2', 'second')];

    const res = await fuseWithVectorMemory('q', lexical, {
      threshold: 0.5,
      vectorHits: [makeHit('m2', Number.NaN)],
    });
    const m2 = res.find((h) => h.memory.id === 'm2');
    expect(m2?.source).toBe('lexical');
    expect(m2?.vectorScore).toBeNull();
  });
});
