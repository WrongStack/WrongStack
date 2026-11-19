import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { ToolErrorCategory } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import { ChronicleJournal, createChronicleContext, wireToolsToChronicle } from '../src/index.js';

const tempDirs: string[] = [];
const scrubber = {
  scrub: (value: string) => value.replaceAll('SECRET_TOKEN', '[REDACTED]'),
  scrubObject: <T>(obj: T): T => obj,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wireToolsToChronicle tool.failed detail and file.mutation.observed path scrubbing', () => {
  it('scrubs and caps tool.failed detail on UTF-8 byte boundaries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tool-failed-scrub-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's1' },
      'trace-1',
    );
    const off = wireToolsToChronicle({ events, journal, context, scrubber });

    try {
      events.emit('tool.failed', {
        sessionId: 's1',
        id: 'call-short',
        name: 'bash',
        durationMs: 12,
        category: ToolErrorCategory.TRANSIENT,
        retryable: true,
        detail: 'Bearer SECRET_TOKEN rejected',
      } as never);

      events.emit('tool.failed', {
        sessionId: 's1',
        id: 'call-long',
        name: 'bash',
        durationMs: 18,
        category: ToolErrorCategory.TRANSIENT,
        retryable: false,
        detail: `Bearer SECRET_TOKEN ${'界'.repeat(1000)}`,
      } as never);

      await journal.flush();
      const recorded = await journal.readAll();
      expect(recorded).toHaveLength(2);
      expect(recorded[0]?.attributes?.['detail']).toBe('Bearer [REDACTED] rejected');

      const longDetail = recorded[1]?.attributes?.['detail'] as {
        preview: string;
        truncated: boolean;
        totalBytes: number;
      };
      expect(longDetail.truncated).toBe(true);
      expect(longDetail.preview).toContain('[REDACTED]');
      expect(longDetail.preview).not.toContain('SECRET_TOKEN');
      expect(longDetail.preview).not.toContain('\uFFFD');
      expect(Buffer.byteLength(longDetail.preview, 'utf8')).toBeLessThanOrEqual(2048);
    } finally {
      off();
    }
  });

  it('scrubs and byte-bounds file_changed resource paths while keeping short clean paths stable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-progress-path-scrub-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's1' },
      'trace-2',
    );
    const off = wireToolsToChronicle({ events, journal, context, scrubber });

    try {
      events.emit('tool.progress', {
        sessionId: 's1',
        id: 'call-clean',
        name: 'edit',
        event: {
          type: 'file_changed',
          path: 'src/index.ts',
          operation: 'edit',
          line: 10,
          endLine: 15,
        },
      } as never);

      events.emit('tool.progress', {
        sessionId: 's1',
        id: 'call-secret-long',
        name: 'write',
        event: {
          type: 'file_changed',
          path: `src/SECRET_TOKEN/${'界'.repeat(250)}.ts`,
          operation: 'write',
        },
      } as never);

      await journal.flush();
      const recorded = await journal.readAll();
      expect(recorded).toHaveLength(2);

      const expectedCleanId = `file_${createHash('sha256').update('src/index.ts').digest('hex').slice(0, 24)}`;
      expect(recorded[0]?.resource?.path).toBe('src/index.ts');
      expect(recorded[0]?.resource?.id).toBe(expectedCleanId);

      const secretRes = recorded[1]?.resource;
      expect(secretRes?.path).toMatch(/^src\/\[REDACTED\]\//);
      expect(secretRes?.path?.endsWith('…')).toBe(true);
      expect(secretRes?.path).not.toContain('SECRET_TOKEN');
      expect(secretRes?.path).not.toContain('\uFFFD');
      expect(Buffer.byteLength(secretRes?.path ?? '', 'utf8')).toBeLessThanOrEqual(512);
    } finally {
      off();
    }
  });
});
