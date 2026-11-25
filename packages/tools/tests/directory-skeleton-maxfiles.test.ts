import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDirectorySkeleton } from '../src/codebase-index/directory-skeleton.js';

describe('extractDirectorySkeleton maxFiles bounds', () => {
  it('returns 0 files instead of throwing RangeError when maxFiles is negative', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-skel-neg-'));
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export function a() { return 1; }\n');
    try {
      const neg = await extractDirectorySkeleton({ dirPath: tmp, maxFiles: -1 });
      expect(neg.files).toEqual([]);
      expect(neg.moreFiles).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
