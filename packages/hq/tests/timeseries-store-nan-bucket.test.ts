import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqTimeseriesStore } from '../src/persistence/timeseries-store.js';

describe('HqTimeseriesStore non-finite bucketMs and signal guards (F1848)', () => {
  it('falls back to valid defaults on bucketMs<=0/NaN and ignores NaN signal deltas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-ts-nan-'));
    try {
      const store = new HqTimeseriesStore({
        dataDir: dir,
        bucketMs: 0,
        maxBuckets: Number.NaN,
      });
      store.record({ ts: 300_000, costUsd: 2.0, inputTokens: 50 });
      store.record({ ts: 300_000, costUsd: Number.NaN, inputTokens: Number.POSITIVE_INFINITY });
      store.record({ ts: Number.NaN, costUsd: 99 });

      const samples = await store.read();
      expect(samples).toHaveLength(1);
      expect(samples[0]?.ts).toBe(300_000);
      expect(samples[0]?.costUsd).toBe(2.0);
      expect(samples[0]?.inputTokens).toBe(50);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
