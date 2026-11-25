import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeBackgroundLogFd, openBackgroundLog } from '../src/background-log.js';

describe('openBackgroundLog (F2202)', () => {
  it('sanitizes path separators in toolName so logs stay inside bg-logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-f2202-test-'));
    try {
      const log = openBackgroundLog(dir, '../escape', []);
      expect(log).toBeDefined();
      if (log) {
        closeBackgroundLogFd(log);
        expect(resolve(log.path)).toContain('bg-logs');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
