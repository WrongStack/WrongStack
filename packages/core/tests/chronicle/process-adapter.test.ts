import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireProcessesToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
  runWithProcessTelemetry,
} from '../../src/observability/process-telemetry.js';

const tempDirs: string[] = [];
const scrubber = {
  scrub: (value: string) => value.replaceAll('SECRET', '[REDACTED]'),
  scrubObject: <T>(obj: T): T => obj,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Chronicle process telemetry', () => {
  it('keeps process lifecycle correlated to its async tool context', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-process-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    wireProcessesToChronicle({ events, journal, context, scrubber });

    await runWithProcessTelemetry(
      {
        events,
        sessionId: 'session',
        traceId: 'trace',
        agentId: 'leader',
        toolCallId: 'tool-7',
        toolName: 'test',
      },
      async () => {
        emitProcessStarted({
          pid: 700,
          parentPid: 1,
          command: 'runner SECRET',
          args: ['--token=SECRET'],
          cwd: '/project',
          background: false,
          startedAt: '2026-07-18T00:00:00.000Z',
        });
        await Promise.resolve();
        emitProcessOutput({ pid: 700, stream: 'stdout', chunk: 'hello' });
        emitProcessCompleted({
          pid: 700,
          exitCode: 0,
          durationMs: 25,
          stdoutBytes: 5,
          stderrBytes: 0,
          timedOut: false,
          endedAt: '2026-07-18T00:00:00.025Z',
        });
      },
    );

    const recorded = await journal.readAll();
    expect(recorded.map((event) => event.eventType)).toEqual([
      'process.started',
      'process.completed',
    ]);
    expect(recorded.every((event) => event.correlation.toolCallId === 'tool-7')).toBe(true);
    expect(recorded[0]?.attributes).toMatchObject({
      command: 'runner [REDACTED]',
      args: ['--token=[REDACTED]'],
      parentPid: 1,
    });
    expect(recorded[1]).toMatchObject({ outcome: 'success', durationNs: '25000000' });
    expect(recorded[1]?.runtime?.processId).toBe(700);
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, entries: 2 });
  });
});
