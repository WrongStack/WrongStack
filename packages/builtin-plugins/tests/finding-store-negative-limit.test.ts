import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlFindingStore } from '../src/review-finding-store.js';
import type { ChimeraFinding } from '../src/review-finding-types.js';

describe('JsonlFindingStore.list non-positive and non-finite limits (F1856)', () => {
  it('returns [] for zero or negative limits and uses default page size for NaN', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-store-limit-'));
    try {
      const store = new JsonlFindingStore(tmpDir);
      const findings: ChimeraFinding[] = [1, 2, 3].map((i) => ({
        id: `f-${i}`,
        fingerprint: `fp-${i}`,
        title: `Finding ${i}`,
        description: 'desc',
        severity: 'high',
        status: 'active',
        createdAt: `2026-11-25T10:0${i}:00.000Z`,
      })) as unknown as ChimeraFinding[];
      await store.upsert(findings, { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });

      expect(await store.list({ limit: -1 })).toEqual([]);
      expect(await store.list({ limit: 0 })).toEqual([]);
      expect(await store.list({ limit: Number.NaN })).toHaveLength(3);
      expect(await store.list({ limit: 2.9 })).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
