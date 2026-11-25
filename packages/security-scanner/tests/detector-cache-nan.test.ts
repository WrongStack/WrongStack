import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TechStackDetector } from '../src/detector.js';

describe('TechStackDetector cache bound guard', () => {
  it('enforces a finite cache bound when maxCacheEntries is NaN', async () => {
    const detector = new TechStackDetector(30_000, Number.NaN);
    const dirs: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const d = mkdtempSync(join(tmpdir(), `ws-det-t-${i}-`));
        dirs.push(d);
        await detector.detect(d);
      }
      const cacheSize = (detector as unknown as { cachedResults: Map<string, unknown> })
        .cachedResults.size;
      expect(cacheSize).toBe(1);
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
