import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppUpdateCheck } from '../src/server/app-update-check.js';

describe('createAppUpdateCheck non-finite timeoutMs (F1867)', () => {
  it('falls back to 5000ms instead of throwing in AbortSignal.timeout', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-update-nan-'));
    try {
      const mockFetch = (async () =>
        new Response(JSON.stringify({ tag_name: 'v2.3.4' }), { status: 200 })) as typeof fetch;

      for (const [idx, badTimeout] of [
        Number.NaN,
        0,
        -100,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ].entries()) {
        const checker = createAppUpdateCheck({
          currentVersion: '1.0.0',
          cacheFile: path.join(tmpDir, `c-${idx}.json`),
          fetchImpl: mockFetch,
          timeoutMs: badTimeout,
        });
        await checker.refresh();
        expect(checker.info().updateCheckFailed).toBe(false);
        expect(checker.info().latestVersion).toBe('2.3.4');
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
