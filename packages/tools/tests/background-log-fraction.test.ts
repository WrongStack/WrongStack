import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tailBackgroundLog } from '../src/background-log.js';

describe('tailBackgroundLog fractional maxLines', () => {
  it('returns an empty array when maxLines floors to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-bglog-frac-'));
    try {
      const file = join(dir, 'app.log');
      writeFileSync(file, 'line1\nline2\nline3\n', 'utf8');
      expect(tailBackgroundLog(file, 0.5)).toEqual([]);
      expect(tailBackgroundLog(file, 1.9)).toEqual(['line3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
