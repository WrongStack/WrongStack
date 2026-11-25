import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherFiles } from '../src/file-gathering.js';

describe('gatherFiles non-finite maxDepth (F1861)', () => {
  it('clamps non-finite or negative maxDepth to 0 instead of recursing unboundedly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-gather-depth-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'root.ts'), 'export const a = 1;');
      const deepDir = path.join(tmpDir, 'a', 'b');
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(deepDir, 'deep.ts'), 'export const b = 2;');

      for (const badDepth of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const res = await gatherFiles({ root: tmpDir, extensions: ['.ts'], maxDepth: badDepth });
        expect(res).toHaveLength(1);
        expect(res[0]?.endsWith('root.ts')).toBe(true);
      }

      const full = await gatherFiles({ root: tmpDir, extensions: ['.ts'], maxDepth: 2 });
      expect(full).toHaveLength(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
