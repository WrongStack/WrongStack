import { describe, expect, it } from 'vitest';
import { scoreMemoryRelationship } from '../src/memory-similarity.js';
import type { Sage } from '../src/types.js';

function makeMemory(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    kind: 'fact',
    scope: 'project',
    status: 'active',
    text: 'memory',
    tags: ['shared'],
    anchors: [],
    importance: 3,
    confidence: 0.8,
    freshness: 0.9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Sage;
}

describe('scoreMemoryRelationship non-finite score fields (F1980)', () => {
  it('returns a finite score when candidate importance or confidence is NaN', () => {
    const seed = makeMemory('seed');
    const score = scoreMemoryRelationship(
      makeMemory('c2', { importance: Number.NaN, confidence: Number.NaN }),
      [seed],
    );
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });
});
