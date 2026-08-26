import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSummaryTracker } from '../../src/storage/session-summary-tracker.js';
import {
  flushBufferSync,
  isClosedHandleError,
} from '../../src/storage/session-writer/session-writer-flush.js';
import type { SessionEvent, SessionMetadata } from '../../src/types/session.js';

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const META: Omit<SessionMetadata, 'startedAt'> = {
  id: 'session-test',
  model: 'test-model',
  provider: 'test-provider',
};

describe('session writer internals', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-writer-internals-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('flushes JSONL events synchronously and identifies closed handle errors', async () => {
    const filePath = path.join(tempDir, 'session.jsonl');
    const events: SessionEvent[] = [
      { type: 'user_input', ts: STARTED_AT, content: 'hello' },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:01.000Z',
        id: 'tool-1',
        content: 'done',
        isError: false,
      },
    ];

    flushBufferSync(filePath, events);
    flushBufferSync(filePath, []);

    const lines = (await fsp.readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line) as SessionEvent)).toEqual(events);
    expect(isClosedHandleError({ code: 'EBADF' })).toBe(true);
    expect(isClosedHandleError({ code: 'ENOENT' })).toBe(false);

    expect(() => flushBufferSync(tempDir, events)).not.toThrow();
    expect(fs.statSync(filePath).size).toBeGreaterThan(0);
  });

  it('tracks observed events, finalizes a summary, and resets state', async () => {
    const tracker = new SessionSummaryTracker({
      id: 'session-test',
      startedAt: STARTED_AT,
      meta: META,
      resumed: false,
    });

    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'Investigate storage' },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:02.000Z',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 3, output: 5 },
      },
      {
        type: 'tool_call_start',
        ts: '2026-01-01T00:00:03.000Z',
        name: 'read',
        id: 'tool-1',
        input: {},
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:04.000Z',
        id: 'tool-1',
        content: 'failed',
        isError: true,
      },
      {
        type: 'file_snapshot',
        ts: '2026-01-01T00:00:05.000Z',
        promptIndex: 0,
        files: [
          { path: 'a.ts', action: 'modified', before: 'a', after: 'b' },
          { path: 'b.ts', action: 'created', before: null, after: 'b' },
        ],
      },
      { type: 'compaction', ts: '2026-01-01T00:00:06.000Z', before: 100, after: 50 },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:07.000Z', context: 'iteration' },
    ];

    for (const event of events) tracker.observe(event);

    expect(tracker.pendingToolUses).toEqual([]);
    const finalized = await tracker.finalize();
    // finalize() stamps endedAt itself, and lastActivityAt clamps forward to
    // it whenever the wall clock is past the newest observed event.
    expect(finalized.lastActivityAt).toBe(finalized.endedAt);
    expect(finalized).toMatchObject({
      title: 'Investigate storage',
      tokenTotal: 8,
      messageCount: 2,
      iterationCount: 1,
      toolCallCount: 1,
      toolErrorCount: 1,
      toolBreakdown: { read: 1 },
      fileChangeCount: 2,
      compactionCount: 1,
      // The fixture's last event is `in_flight_start` — the exact signature of
      // a process that died mid-operation. It used to read 'error', latched
      // from the errored tool_result partway through; 'aborted' says what the
      // journal actually shows. See resolveSessionOutcome.
      outcome: 'aborted',
    });

    tracker.reset('2026-01-02T00:00:00.000Z');
    expect(tracker.currentSummary).toMatchObject({
      id: 'session-test',
      title: '(empty session)',
      startedAt: '2026-01-02T00:00:00.000Z',
      tokenTotal: 0,
      messageCount: 0,
    });
  });

  it('recomputes summary state from valid JSONL lines while skipping malformed input', async () => {
    const filePath = path.join(tempDir, 'replay.jsonl');
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'Replay this' },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:02.000Z',
        content: [{ type: 'text', text: 'Replayed' }],
        stopReason: 'end_turn',
        usage: { input: 2, output: 4 },
      },
    ];
    await fsp.writeFile(
      filePath,
      `${JSON.stringify(events[0])}\nnot-json\n\n${JSON.stringify(events[1])}\n`,
      'utf8',
    );

    const tracker = new SessionSummaryTracker({
      id: 'session-test',
      startedAt: STARTED_AT,
      meta: META,
      resumed: true,
      initialSummary: {
        id: 'old-id',
        title: 'Old title',
        startedAt: STARTED_AT,
        model: 'test-model',
        provider: 'test-provider',
        tokenTotal: 99,
        outcome: 'completed',
      },
    });

    await tracker.recomputeFromDisk(filePath);
    await tracker.recomputeFromDisk(path.join(tempDir, 'missing.jsonl'));

    expect(await tracker.finalize()).toMatchObject({
      id: 'session-test',
      title: 'Replay this',
      tokenTotal: 6,
      messageCount: 2,
      lastUserMessage: 'Replay this',
      // Replayed journal has no session_end and no error, so there is no
      // verdict to report. 'completed' here was an unfounded default.
      outcome: undefined,
    });
  });
});
