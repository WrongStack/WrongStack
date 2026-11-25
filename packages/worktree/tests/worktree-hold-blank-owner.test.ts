import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holdManagedWorktree } from '../src/worktree-hold.js';

describe('holdManagedWorktree (F2212)', () => {
  it('normalizes whitespace-only ownerId so hold markers remain readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-f2212-test-'));
    try {
      const wt = join(dir, 'wt-1');
      const release = await holdManagedWorktree(dir, wt, '   ');
      const marker = JSON.parse(readFileSync(join(dir, '.holds', 'wt-1.json'), 'utf8')) as {
        ownerId: string;
      };
      await release();
      expect(marker.ownerId).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
