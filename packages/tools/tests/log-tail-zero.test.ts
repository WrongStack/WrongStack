import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLogTail } from '../src/background-exit-notice.js';

describe('readLogTail maxLines bounds', () => {
  it('returns empty array when maxLines is zero or negative', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-tail-t-'));
    const file = join(dir, 'out.log');
    writeFileSync(file, 'line1\nline2\nline3\nline4\n');
    try {
      expect(await readLogTail(file, 0)).toEqual([]);
      expect(await readLogTail(file, -2)).toEqual([]);
      expect(await readLogTail(file, 2)).toEqual(['line3', 'line4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
