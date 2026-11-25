import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqEventLog } from '../src/persistence/event-log.js';
import type { HqEventEnvelope } from '../src/protocol.js';

describe('HqEventLog non-finite rotation options (F1851)', () => {
  it('falls back to defaults when maxLines, rotateKeep, maxBytes, or rotateKeepBytes are invalid', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-event-log-nan-'));
    try {
      const badLog = new HqEventLog({
        dataDir: tmpDir,
        maxLines: Number.NaN,
        rotateKeep: Number.NaN,
        maxBytes: -1,
        rotateKeepBytes: Number.NEGATIVE_INFINITY,
      }) as unknown as {
        maxLines: number;
        rotateKeep: number;
        maxBytes: number;
        rotateKeepBytes: number;
      };
      expect(badLog.maxLines).toBe(50_000);
      expect(badLog.rotateKeep).toBe(20_000);
      expect(badLog.maxBytes).toBe(32 * 1024 * 1024);
      expect(badLog.rotateKeepBytes).toBe(16 * 1024 * 1024);

      const rotDir = path.join(tmpDir, 'rot');
      await fs.mkdir(rotDir, { recursive: true });
      const rotLog = new HqEventLog({ dataDir: rotDir, maxLines: 4, rotateKeep: 2 });
      for (let i = 0; i < 5; i++) {
        rotLog.append({
          type: 'hq.event',
          machineId: 'm1',
          timestamp: '2026-11-25T12:00:00.000Z',
          payload: { seq: i },
        } as unknown as HqEventEnvelope);
        await rotLog.drain();
      }
      expect((await rotLog.recent(20)).length).toBeLessThanOrEqual(3);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
