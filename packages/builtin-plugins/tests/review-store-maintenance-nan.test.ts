import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maybeCompactReviewStores } from '../src/review-store-maintenance.js';

describe('maybeCompactReviewStores non-finite threshold and interval (F1859)', () => {
  it('falls back to default thresholdBytes and intervalMs for NaN, negative, or Infinity', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-maint-nan-'));
    try {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        const res = await maybeCompactReviewStores(tmpDir, {
          thresholdBytes: bad,
          intervalMs: bad,
          now: 1_700_000_000_000,
        });
        expect(res.compacted).toBe(false);
        expect(res.reason).toBe('below_threshold');
      }

      const first = await maybeCompactReviewStores(tmpDir, {
        thresholdBytes: 0,
        intervalMs: Number.NaN,
        now: 1_700_000_000_000,
      });
      expect(first.compacted).toBe(true);
      expect(first.reason).toBe('compacted');

      const second = await maybeCompactReviewStores(tmpDir, {
        thresholdBytes: 0,
        intervalMs: Number.NaN,
        now: 1_700_000_001_000,
      });
      expect(second.compacted).toBe(false);
      expect(second.reason).toBe('interval');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
