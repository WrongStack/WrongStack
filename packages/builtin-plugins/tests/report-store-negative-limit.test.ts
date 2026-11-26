import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlReportStore } from '../src/review-report-store.js';

describe('JsonlReportStore.list non-positive and non-finite limits (F1857)', () => {
  it('returns [] for zero or negative limits and uses default page size for NaN', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-store-limit-'));
    try {
      const store = new JsonlReportStore(tmpDir);
      for (let i = 1; i <= 3; i++) {
        await store.persist({
          id: `rep-${i}`,
          sessionId: 's1',
          agentId: 'a1',
          reviewerModel: 'm1',
          source: 'manual' as never,
          reviewStatus: 'success',
          files: [],
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          totalFindings: 0,
          unparseableCount: 0,
          rawText: `report ${i}`,
        });
      }

      expect(await store.list({ limit: -1 })).toEqual([]);
      expect(await store.list({ limit: 0 })).toEqual([]);
      expect(await store.list({ limit: Number.NaN })).toHaveLength(3);
      expect(await store.list({ limit: 2 })).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
