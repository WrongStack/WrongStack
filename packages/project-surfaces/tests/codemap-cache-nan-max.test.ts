import { describe, expect, it } from 'vitest';
import { touchClientGraphCache } from '../src/atlas/CodeMapActivityHelpers';
import type { CodeMapGraphResponse } from '../src/atlas/codemap-model';

const graph = { nodes: [], edges: [] } as unknown as CodeMapGraphResponse;

describe('touchClientGraphCache maxEntries guard', () => {
  it('bounds cache on NaN maxEntries and retains latest entry on <= 0 maxEntries', () => {
    const nanCache = new Map<string, CodeMapGraphResponse>();
    for (let i = 0; i < 60; i++) {
      touchClientGraphCache(nanCache, `k${i}`, graph, Number.NaN);
    }
    expect(nanCache.size).toBe(48);
    expect(nanCache.has('k59')).toBe(true);
    expect(nanCache.has('k0')).toBe(false);

    const zeroCache = new Map<string, CodeMapGraphResponse>();
    touchClientGraphCache(zeroCache, 'a', graph, 0);
    touchClientGraphCache(zeroCache, 'b', graph, -5);
    expect(zeroCache.size).toBe(1);
    expect(zeroCache.has('b')).toBe(true);
  });
});
