import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppUpdateCheck } from '../src/server/app-update-check.js';

describe('createAppUpdateCheck (F2172)', () => {
  it('clamps positive sub-millisecond timeoutMs to at least 1ms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-f2172-test-'));
    try {
      const checker = createAppUpdateCheck({
        currentVersion: '1.0.0',
        cacheFile: join(dir, 'cache.json'),
        timeoutMs: 0.5,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.signal?.aborted) throw new Error('aborted immediately');
          return new Response(JSON.stringify({ tag_name: 'v1.1.0' }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      await checker.refresh();
      expect(checker.info().updateCheckFailed).toBe(false);
      expect(checker.info().latestVersion).toBe('1.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
