import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitignoreUpdater } from '../src/gitignore-updater.js';

describe('GitignoreUpdater (F2189)', () => {
  it('falls back to default entries when options.entries is explicitly undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-f2189-test-'));
    try {
      const updater = new GitignoreUpdater({
        gitignorePath: join(dir, '.gitignore'),
        entries: undefined,
      });
      const res = await updater.update();
      expect(res.errors).toEqual([]);
      expect(res.added).toEqual(['security-reports/', 'security-reports/*']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
