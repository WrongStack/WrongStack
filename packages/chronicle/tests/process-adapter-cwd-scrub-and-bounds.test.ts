import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireProcessesToChronicle,
} from '../src/index.js';

const tempDirs: string[] = [];
const scrubber = {
  scrub: (value: string) => value.replaceAll('SECRET_KEY', '[REDACTED]'),
  scrubObject: <T>(obj: T): T => obj,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wireProcessesToChronicle scrubbing and bounds', () => {
  it('scrubs cwd and UTF-8 byte-bounds command, args, and cwd while capping argument count', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-process-bounds-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's1' },
      'trace-p',
    );
    const off = wireProcessesToChronicle({ events, journal, context, scrubber });

    try {
      events.emit('process.started', {
        pid: 801,
        parentPid: 1,
        sessionId: 's1',
        toolCallId: 'tc-1',
        toolName: 'bash',
        command: `sh -c SECRET_KEY ${'界'.repeat(250)}`,
        args: Array.from({ length: 70 }, (_, i) =>
          i === 0 ? `arg-SECRET_KEY-${'界'.repeat(250)}` : `arg-${i}`,
        ),
        cwd: `/tmp/work-SECRET_KEY/${'界'.repeat(250)}`,
        background: false,
        startedAt: '2026-11-19T00:00:00.000Z',
      });

      await journal.flush();
      const recorded = await journal.readAll();
      expect(recorded).toHaveLength(1);
      const attrs = recorded[0]?.attributes ?? {};
      const command = String(attrs['command']);
      const cwd = String(attrs['cwd']);
      const args = attrs['args'] as string[];

      expect(args).toHaveLength(64);
      expect(attrs['argsTruncated']).toBe(6);
      for (const field of [command, cwd, args[0]!]) {
        expect(field).toContain('[REDACTED]');
        expect(field).not.toContain('SECRET_KEY');
        expect(field).not.toContain('\uFFFD');
        expect(field.endsWith('…')).toBe(true);
        expect(Buffer.byteLength(field, 'utf8')).toBeLessThanOrEqual(512);
      }
    } finally {
      off();
    }
  });
});
