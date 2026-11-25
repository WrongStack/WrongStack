import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChroniclePartitionRangeCache } from '../src/partition-range-cache.js';

describe('ChroniclePartitionRangeCache merge-on-load', () => {
  it('preserves persisted disk entries when set() is called before get()/load()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-range-cache-merge-'));
    try {
      const fileA = join(dir, '2026-11-01.jsonl');
      const fileB = join(dir, '2026-11-02.jsonl');

      const seed = new ChroniclePartitionRangeCache(dir);
      seed.set(fileA, {
        size: 100,
        minOccurredAt: '2026-11-01T00:00:00Z',
        maxOccurredAt: '2026-11-01T23:59:59Z',
      });
      await seed.flush();

      const fresh = new ChroniclePartitionRangeCache(dir);
      fresh.set(fileB, {
        size: 200,
        minOccurredAt: '2026-11-02T00:00:00Z',
        maxOccurredAt: '2026-11-02T23:59:59Z',
      });
      expect(await fresh.get(fileA, 100)).toBeDefined();
      await fresh.flush();

      const verify = new ChroniclePartitionRangeCache(dir);
      expect(await verify.get(fileA, 100)).toBeDefined();
      expect(await verify.get(fileB, 200)).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
