/**
 * REGRESSION TEST: critical append propagates flush failures instead of silently swallowing them.
 *
 * Bug: packages/core/src/storage/file-session-writer.ts, append() and appendBatch()
 *      silently suppressed flushBuffer rejections for critical events (user_input,
 *      llm_response, checkpoint, in_flight_*). A disk-full or IO error during the
 *      flush of a critical journal event caused the write to fail silently — the
 *      user prompt or model response was lost from the transcript without any error
 *      being surfaced to the caller.
 *
 * Fix: For critical events, flushBuffer errors now propagate (are NOT caught).
 *      Non-critical events retain the best-effort silent-sweep behavior.
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSessionWriter } from '../../src/storage/file-session-writer.js';

// ---------------------------------------------------------------------------
// Mock handle
// ---------------------------------------------------------------------------
function mockHandle() {
  return {
    appendFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    datasync: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('critical append propagates flush failures (regression for silent-sweep bug)', () => {
  let handle: ReturnType<typeof mockHandle>;
  let events: { emit: ReturnType<typeof vi.fn> };

  const TEST_ID = '2026-01-01/sess_critical_append';
  const STARTED_AT = '2026-01-01T00:00:00.000Z';

  beforeEach(() => {
    handle = mockHandle();
    events = { emit: vi.fn() };
  });

  it('rejects when flushBuffer throws on user_input (critical event)', async () => {
    const writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      { id: TEST_ID, model: 'test-model', provider: 'test-provider' },
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    // Simulate a disk-full / IO error on the journal write
    vi.spyOn((writer as any).buffer, 'flushBuffer').mockImplementation(async () => {
      throw new Error('ENOSPC: no space left on device');
    });
    vi.spyOn((writer as any).buffer, 'shouldFlushNow').mockReturnValue(false);
    vi.spyOn((writer as any).buffer, 'cancelTimer').mockImplementation(() => {});
    vi.spyOn((writer as any).buffer, 'scheduleFlush').mockImplementation(() => {});

    // Critical event: error must propagate
    await expect(
      writer.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'critical message',
      }),
    ).rejects.toThrow('ENOSPC');
  });

  it('rejects when flushBuffer throws on llm_response (critical event)', async () => {
    const writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      { id: TEST_ID, model: 'test-model', provider: 'test-provider' },
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    vi.spyOn((writer as any).buffer, 'flushBuffer').mockImplementation(async () => {
      throw new Error('EIO: read-only filesystem');
    });
    vi.spyOn((writer as any).buffer, 'shouldFlushNow').mockReturnValue(false);
    vi.spyOn((writer as any).buffer, 'cancelTimer').mockImplementation(() => {});
    vi.spyOn((writer as any).buffer, 'scheduleFlush').mockImplementation(() => {});

    await expect(
      writer.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: [],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5 },
      }),
    ).rejects.toThrow('EIO');
  });

  it('rejects when flushBuffer throws on checkpoint (critical event)', async () => {
    const writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      { id: TEST_ID, model: 'test-model', provider: 'test-provider' },
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    vi.spyOn((writer as any).buffer, 'flushBuffer').mockImplementation(async () => {
      throw new Error('EFSCORRUPTED: journal checksum mismatch');
    });
    vi.spyOn((writer as any).buffer, 'shouldFlushNow').mockReturnValue(false);
    vi.spyOn((writer as any).buffer, 'cancelTimer').mockImplementation(() => {});
    vi.spyOn((writer as any).buffer, 'scheduleFlush').mockImplementation(() => {});

    await expect(
      writer.append({
        type: 'checkpoint',
        ts: new Date().toISOString(),
        promptIndex: 0,
        promptPreview: 'critical checkpoint',
      }),
    ).rejects.toThrow('EFSCORRUPTED');
  });

  it('still resolves normally when flushBuffer throws on non-critical events (best-effort)', async () => {
    const writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      { id: TEST_ID, model: 'test-model', provider: 'test-provider' },
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    vi.spyOn((writer as any).buffer, 'flushBuffer').mockImplementation(async () => {
      throw new Error('ENOSPC: no space left on device');
    });
    vi.spyOn((writer as any).buffer, 'shouldFlushNow').mockReturnValue(false);
    vi.spyOn((writer as any).buffer, 'cancelTimer').mockImplementation(() => {});
    vi.spyOn((writer as any).buffer, 'scheduleFlush').mockImplementation(() => {});

    // Non-critical: best-effort is preserved — error stays swallowed
    await expect(
      writer.append({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: 'tu-1',
        content: 'result',
        isError: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects appendBatch when at least one critical event fails to flush', async () => {
    const writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      { id: TEST_ID, model: 'test-model', provider: 'test-provider' },
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    vi.spyOn((writer as any).buffer, 'flushBuffer').mockImplementation(async () => {
      throw new Error('EACCES: permission denied');
    });
    vi.spyOn((writer as any).buffer, 'shouldFlushNow').mockReturnValue(false);
    vi.spyOn((writer as any).buffer, 'cancelTimer').mockImplementation(() => {});
    vi.spyOn((writer as any).buffer, 'scheduleFlush').mockImplementation(() => {});

    await expect(
      writer.appendBatch([
        {
          type: 'tool_result',
          ts: new Date().toISOString(),
          id: 'tu-1',
          content: 'result',
          isError: false,
        },
        {
          type: 'user_input', // critical
          ts: new Date().toISOString(),
          content: 'critical in batch',
        },
      ]),
    ).rejects.toThrow('EACCES');
  });
});
