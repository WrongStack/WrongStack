import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollabSessionOptions, SharedFileSnapshot } from '../src/collab-debug-types.js';
import { readCollabSnapshotFiles } from '../src/collab-snapshot.js';

describe('readCollabSnapshotFiles (F2200)', () => {
  it('falls back to DEFAULT_MAX_TARGET_FILES when limit is non-finite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-f2200-test-'));
    try {
      const targetPaths = Array.from({ length: 31 }, (_, i) => {
        const p = join(dir, `f${i}.ts`);
        writeFileSync(p, `export const v${i} = ${i};`);
        return p;
      });
      const snap = {
        createdAt: new Date().toISOString(),
        files: [],
      } as unknown as SharedFileSnapshot;
      await expect(
        readCollabSnapshotFiles(
          snap,
          {
            targetPaths,
            projectRoot: dir,
            allowOutsideProjectRoot: true,
          } as unknown as CollabSessionOptions,
          Number.NaN,
        ),
      ).rejects.toThrow(/exceeds the limit/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
