import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitignoreUpdater } from '../src/gitignore-updater.js';

describe('GitignoreUpdater.isEntryIgnored blank entry guard', () => {
  it('returns false for empty or whitespace-only entries even when .gitignore has blank lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-gi-t-'));
    const file = join(dir, '.gitignore');
    writeFileSync(file, 'node_modules/\n\ndist/\n');
    try {
      const updater = new GitignoreUpdater({ gitignorePath: file });
      expect(await updater.isEntryIgnored('   ')).toBe(false);
      expect(await updater.isEntryIgnored('')).toBe(false);
      expect(await updater.isEntryIgnored('dist/')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
