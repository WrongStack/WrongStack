import { describe, expect, it } from 'vitest';
import { decomposeNonAtomicTasks } from '../src/plan-decompose.js';

describe('decomposeNonAtomicTasks maxDecompositions guard', () => {
  it('falls back to default budget when maxDecompositions is NaN', async () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      id: `n-${i}`,
      title: `Huge task ${i}`,
      description: 'A'.repeat(2000),
      status: 'pending' as const,
      estimateHours: 20,
      metadata: {},
    }));
    let calls = 0;
    await decomposeNonAtomicTasks({
      mode: 'propose',
      maxDecompositions: Number.NaN,
      tracker: {
        getAllNodes: () => nodes,
        getBlockers: () => [],
        patchMetadata: () => {},
      } as never,
      decompose: async () => {
        calls += 1;
        return [
          { title: 'a', description: 'a' },
          { title: 'b', description: 'b' },
        ];
      },
    });
    expect(calls).toBe(10);
  });
});
