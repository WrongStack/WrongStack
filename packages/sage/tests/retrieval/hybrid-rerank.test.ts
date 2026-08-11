import { describe, expect, it } from 'vitest';
import { hybridRerankMemories } from '../../src/retrieval/hybrid-rerank.js';
import type { Sage } from '../../src/types.js';

function mem(id: string, text: string): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text,
    importance: 0.5,
    confidence: 0.5,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('hybridRerankMemories', () => {
  it('lifts conceptual matches above unrelated early hits', () => {
    const candidates = [
      mem('1', 'database connection pool settings'),
      mem('2', 'cursor-based pagination for list APIs'),
      mem('3', 'pagination and page size conventions'),
    ];
    const ranked = hybridRerankMemories('API pagination cursor', candidates, 0.8);
    expect(ranked.map((m) => m.id)[0]).not.toBe('1');
    expect(ranked.some((m) => m.id === '2' || m.id === '3')).toBe(true);
  });

  it('is a no-op for single candidates or short queries', () => {
    const one = [mem('1', 'hello')];
    expect(hybridRerankMemories('x', one)).toBe(one);
    expect(hybridRerankMemories('ab', [mem('1', 'a'), mem('2', 'b')]).map((m) => m.id)).toEqual([
      '1',
      '2',
    ]);
  });
});
