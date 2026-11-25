import type { ModelsRegistry } from '@wrongstack/contracts/types/models-registry';
import { describe, expect, it } from 'vitest';
import { startCatalog } from '../src/models/catalog-refresh.js';

describe('startCatalog (F2213)', () => {
  it('does not spin a 1ms interval when intervalMs is Infinity', async () => {
    let refreshes = 0;
    const res = await startCatalog({
      registry: {
        loadCached: async () => true,
        ageSeconds: async () => 9999,
        refresh: async () => {
          refreshes++;
        },
      } as unknown as ModelsRegistry,
      intervalMs: Number.POSITIVE_INFINITY,
    });
    await res.settled;
    await new Promise((r) => setTimeout(r, 25));
    res.stop();

    expect(refreshes).toBe(1);
  });
});
