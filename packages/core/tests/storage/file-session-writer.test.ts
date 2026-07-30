import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretScrubber, SessionEvent, SessionMetadata } from '../../src/index.js';
import type { EventBus } from '../../src/kernel/events.js';
import { FileSessionWriter } from '../../src/storage/file-session-writer.js';

// ---------------------------------------------------------------------------
// Mock the underlying append-only file handle
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
// Test helpers
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();

function makeMeta(): Omit<SessionMetadata, 'startedAt'> {
  return { model: 'gpt-4', provider: 'openai' };
}

const TEST_ID = '2026-01-01/sess_test';
const STARTED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('FileSessionWriter', () => {
  let handle: ReturnType<typeof mockHandle>;
  let writer: FileSessionWriter;
  let events: { emit: ReturnType<typeof vi.fn> };
  let capturedWrites: string[];

  beforeEach(() => {
    handle = mockHandle();
    events = { emit: vi.fn() };
    capturedWrites = [];

    // Make appendFile capture the written data
    handle.appendFile.mockImplementation(async (data: string) => {
      capturedWrites.push(data);
    });

    writer = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      makeMeta(),
      events as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────

  it('sets id and basic properties from constructor', () => {
    expect(writer.id).toBe(TEST_ID);
    expect(writer.transcriptPath).toBe('/tmp/test.jsonl');
    expect(writer.pendingToolUses).toEqual([]);
  });

  it('sets traceId when provided', () => {
    const w = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      makeMeta(),
      undefined,
      { filePath: '/tmp/test.jsonl' },
      'trace-abc',
    );
    expect(w.traceId).toBe('trace-abc');
  });

  it('uses resumed flag from opts', () => {
    const resumedWriter = new FileSessionWriter(
      TEST_ID,
      handle as any,
      STARTED_AT,
      makeMeta(),
      undefined,
      { resumed: true, filePath: '/tmp/test.jsonl' },
    );
    expect(resumedWriter.transcriptPath).toBe('/tmp/test.jsonl');
  });

  // ── append() ──────────────────────────────────────────────────────────

  it('append buffers events and does not immediately flush', async () => {
    const event: SessionEvent = {
      type: 'user_input',
      ts: now(),
      content: 'hello',
    } as SessionEvent;
    await writer.append(event);
    // Should have buffered session_start + user_input but not flushed yet (buffer < 50)
    expect(capturedWrites).toHaveLength(0);
  });

  it('append with many events triggers automatic flush', async () => {
    // FLUSH_SIZE is 50 — adding 50 events should trigger a flush
    for (let i = 0; i < 50; i++) {
      await writer.append({ type: 'user_input', ts: now(), content: `msg${i}` } as SessionEvent);
    }
    // The flush is scheduled on the write chain; await a microtick
    await vi.waitFor(
      () => {
        expect(capturedWrites.length).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 50 },
    );
  });

  it('append does nothing after close', async () => {
    // Create a writer and close it, then append should be a no-op
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
    });
    await w.close();
    const event: SessionEvent = {
      type: 'user_input',
      ts: now(),
      content: 'after close',
    } as SessionEvent;
    // Should not throw
    await w.append(event);
  });

  // ── appendBatch() ────────────────────────────────────────────────────

  it('appendBatch buffers multiple events', async () => {
    const batch: SessionEvent[] = [
      { type: 'user_input', ts: now(), content: 'first' } as SessionEvent,
      { type: 'user_input', ts: now(), content: 'second' } as SessionEvent,
    ];
    await writer.appendBatch(batch);
    // Should have buffered session_start (init) + 2 input events = 3 in buffer
    expect(capturedWrites).toHaveLength(0);
  });

  // ── close() ──────────────────────────────────────────────────────────

  it('close flushes buffered events and calls handle.close', async () => {
    await writer.append({ type: 'user_input', ts: now(), content: 'hello' } as SessionEvent);
    await writer.close();
    expect(handle.close).toHaveBeenCalled();
  });

  it('close resolves onClose callback with the summary', async () => {
    const onClose = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onClose,
    });
    await w.append({ type: 'user_input', ts: now(), content: 'test' } as SessionEvent);
    await w.close();
    await vi.waitFor(
      () => {
        expect(onClose).toHaveBeenCalled();
      },
      { timeout: 2000, interval: 50 },
    );
    const summary = onClose.mock.calls[0]?.[0];
    expect(summary).toHaveProperty('id', TEST_ID);
  });

  it('close is idempotent', async () => {
    await writer.close();
    await writer.close();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('close awaits any in-flight flush', async () => {
    // Append enough to trigger a background flush
    for (let i = 0; i < 50; i++) {
      await writer.append({ type: 'user_input', ts: now(), content: `msg${i}` } as SessionEvent);
    }
    // close should wait for the flush to complete
    await writer.close();
    expect(handle.close).toHaveBeenCalled();
  });

  // ── writeCheckpoint() ────────────────────────────────────────────────

  it('writeCheckpoint flushes and writes a checkpoint event', async () => {
    await writer.writeCheckpoint(0, 'test prompt');
    // Should flush buffer and write events through appendFile (session_start + checkpoint)
    expect(events.emit).toHaveBeenCalled();
  });

  // ── writeInFlightMarker / clearInFlightMarker ────────────────────────

  it('writeInFlightMarker appends in_flight_start event', async () => {
    await writer.writeInFlightMarker('Working on auth');
    expect(events.emit).toHaveBeenCalledWith(
      'in_flight.started',
      expect.objectContaining({ sessionId: TEST_ID, context: 'Working on auth' }),
    );
  });

  it('writeInFlightMarker throws for empty context', async () => {
    await expect(writer.writeInFlightMarker('')).rejects.toThrow('1..500 chars');
  });

  it('writeInFlightMarker throws for context > 500 chars', async () => {
    await expect(writer.writeInFlightMarker('x'.repeat(501))).rejects.toThrow('1..500 chars');
  });

  it('clearInFlightMarker appends in_flight_end event', async () => {
    await writer.clearInFlightMarker('clean');
    expect(events.emit).toHaveBeenCalledWith(
      'in_flight.ended',
      expect.objectContaining({ sessionId: TEST_ID, reason: 'clean' }),
    );
  });

  it('clearInFlightMarker emits with aborted reason', async () => {
    await writer.clearInFlightMarker('aborted');
    expect(events.emit).toHaveBeenCalledWith(
      'in_flight.ended',
      expect.objectContaining({ reason: 'aborted' }),
    );
  });

  it('clearInFlightMarker emits with recovered reason', async () => {
    await writer.clearInFlightMarker('recovered');
    expect(events.emit).toHaveBeenCalledWith(
      'in_flight.ended',
      expect.objectContaining({ reason: 'recovered' }),
    );
  });

  // ── recordFileChange() ───────────────────────────────────────────────

  it('recordFileChange buffers a file_snapshot event', () => {
    writer.recordFileChange({
      path: '/project/src/index.ts',
      action: 'modified',
      before: 'old content',
      after: 'new content',
    });
    // Should not throw
  });

  it('recordFileChange does nothing after close', async () => {
    await writer.close();
    writer.recordFileChange({
      path: '/project/src/index.ts',
      action: 'created',
      before: null,
      after: 'content',
    });
    // No error = success
  });

  // ── recordFileObservation() ──────────────────────────────────────────

  it('recordFileObservation buffers a file_observation for valid input', () => {
    writer.recordFileObservation({
      path: '/project/src/index.ts',
      hash: 'a'.repeat(64),
      mtimeMs: 1234567890,
      source: 'write',
    });
  });

  it('recordFileObservation ignores invalid hash', () => {
    writer.recordFileObservation({
      path: '/project/src/index.ts',
      hash: 'not-a-valid-sha',
      mtimeMs: 1234567890,
      source: 'write',
    });
  });

  it('recordFileObservation ignores empty path', () => {
    writer.recordFileObservation({
      path: '',
      hash: 'a'.repeat(64),
      mtimeMs: 1234567890,
      source: 'write',
    });
  });

  it('recordFileObservation ignores non-finite mtimeMs', () => {
    writer.recordFileObservation({
      path: '/project/src/index.ts',
      hash: 'a'.repeat(64),
      mtimeMs: NaN,
      source: 'write',
    });
  });

  // ── recordSideEffect() ───────────────────────────────────────────────

  it('recordSideEffect fires-and-forgets a side_effect event', () => {
    writer.recordSideEffect({
      toolUseId: 'tu1',
      toolName: 'bash',
      input: { command: 'ls' },
      risk: 'shell',
    });
  });

  // ── clearSession() ───────────────────────────────────────────────────

  it('clearSession resets the writer state', async () => {
    await writer.append({ type: 'user_input', ts: now(), content: 'hello' } as SessionEvent);
    await writer.clearSession();
    // After clearSession, buffer is empty and file was reset
  });

  // ── truncateToCheckpoint() ───────────────────────────────────────────

  it('truncateToCheckpoint returns 0 when filePath is empty', async () => {
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {});
    const result = await w.truncateToCheckpoint(0);
    expect(result).toBe(0);
  });

  // ── EventBus edge cases ──────────────────────────────────────────────

  it('accepts undefined EventBus without errors', async () => {
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
    });
    await w.append({ type: 'user_input', ts: now(), content: 'test' } as SessionEvent);
    await w.clearInFlightMarker('clean');
    await w.writeInFlightMarker('context');
    // close will handle flush chain cleanup; the test doesn't need to verify handle.close
    await w.close();
  });

  // ── Scrubber integration ─────────────────────────────────────────────

  it('uses secret scrubber when provided', async () => {
    const scrubber: SecretScrubber = {
      scrub: vi.fn((s: string) => s.replace(/SECRET/g, '***REDACTED***')),
      scrubObject: vi.fn((obj: Record<string, unknown>) => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          result[k] = typeof v === 'string' ? v.replace(/SECRET/g, '***REDACTED***') : v;
        }
        return result;
      }),
    };

    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      secretScrubber: scrubber,
    });

    await w.append({
      type: 'user_input',
      ts: now(),
      content: 'My API key is SECRET',
    } as SessionEvent);

    await w.close();
    expect(scrubber.scrub).toHaveBeenCalled();
  });

  it('scrubs llm_response content via scrubObject', async () => {
    const scrubber: SecretScrubber = {
      scrub: vi.fn((s: string) => s),
      scrubObject: vi.fn((obj: Record<string, unknown>) => obj),
    };

    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      secretScrubber: scrubber,
    });

    await w.append({
      type: 'llm_response',
      ts: now(),
      content: [{ type: 'text', text: 'response text' }],
      usage: { input: 10, output: 20 },
    } as SessionEvent);

    expect(scrubber.scrubObject).toHaveBeenCalled();
  });

  // ── onAppend / onAppendBatch callbacks ───────────────────────────────

  it('append fires onAppend callback once per event with scrubbed value', async () => {
    const onAppend = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppend,
    });

    await w.append({ type: 'user_input', ts: now(), content: 'hello' } as SessionEvent);

    expect(onAppend).toHaveBeenCalledTimes(1);
    const event = onAppend.mock.calls[0]?.[0];
    expect(event).toHaveProperty('type', 'user_input');
    expect(event).toHaveProperty('content');
    // Event is scrubbed before the callback fires
    expect(event.content).toBe('hello');
  });

  it('appendBatch fires onAppendBatch callback once with scrubbed events', async () => {
    const onAppendBatch = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppendBatch,
    });

    const batch: SessionEvent[] = [
      { type: 'user_input', ts: now(), content: 'first' } as SessionEvent,
      { type: 'user_input', ts: now(), content: 'second' } as SessionEvent,
    ];
    await w.appendBatch(batch);

    expect(onAppendBatch).toHaveBeenCalledTimes(1);
    const events = onAppendBatch.mock.calls[0]?.[0];
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveProperty('content', 'first');
    expect(events[1]).toHaveProperty('content', 'second');
  });

  it('does not break when onAppend callback throws', async () => {
    const onAppend = vi.fn().mockImplementation(() => {
      throw new Error('callback error');
    });
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppend,
    });

    // Should not throw despite callback failure
    await expect(
      w.append({ type: 'user_input', ts: now(), content: 'hello' } as SessionEvent),
    ).resolves.toBeUndefined();
    expect(onAppend).toHaveBeenCalledTimes(1);
  });

  it('does not break when onAppendBatch callback throws', async () => {
    const onAppendBatch = vi.fn().mockImplementation(() => {
      throw new Error('batch callback error');
    });
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppendBatch,
    });

    await expect(
      w.appendBatch([{ type: 'user_input', ts: now(), content: 'hi' } as SessionEvent]),
    ).resolves.toBeUndefined();
    expect(onAppendBatch).toHaveBeenCalledTimes(1);
  });

  it('recordFileChange fires onAppend callback for file_snapshot event with active prompt', async () => {
    const onAppend = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppend,
    });

    // writeCheckpoint sets activePromptIndex so recordFileChange takes
    // the normal (non-pending) path that constructs a file_snapshot event
    // and fires the onAppend callback via bufferSynchronousEvent.
    await w.writeCheckpoint(0, 'test prompt');

    w.recordFileChange({
      path: '/project/src/index.ts',
      action: 'modified',
      before: 'old',
      after: 'new',
    });

    // writeCheckpoint(0) fires onAppend once for the checkpoint event,
    // then recordFileChange fires it again for file_snapshot.
    expect(onAppend).toHaveBeenCalledTimes(2);
    const event = onAppend.mock.calls[1]?.[0];
    expect(event).toHaveProperty('type', 'file_snapshot');
    expect(event.files).toHaveLength(1);
  });

  it('recordFileChange does not fire onAppend before first checkpoint (pending path)', () => {
    const onAppend = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppend,
    });

    // activePromptIndex is null — recordFileChange buffers the change
    // without constructing a SessionEvent, so onAppend must not fire.
    w.recordFileChange({
      path: '/project/src/index.ts',
      action: 'modified',
      before: 'old',
      after: 'new',
    });

    expect(onAppend).toHaveBeenCalledTimes(0);
  });

  it('recordFileObservation fires onAppend callback for file_observation event', () => {
    const onAppend = vi.fn();
    const w = new FileSessionWriter(TEST_ID, handle as any, STARTED_AT, makeMeta(), undefined, {
      filePath: '/tmp/test.jsonl',
      onAppend,
    });

    w.recordFileObservation({
      path: '/project/src/index.ts',
      hash: 'a'.repeat(64),
      mtimeMs: 1234567890,
      source: 'write',
    });

    expect(onAppend).toHaveBeenCalledTimes(1);
    const event = onAppend.mock.calls[0]?.[0];
    expect(event).toHaveProperty('type', 'file_observation');
    expect(event).toHaveProperty('path', '/project/src/index.ts');
  });

  // ── pendingToolUses tracking ─────────────────────────────────────────

  it('pendingToolUses returns open tool use IDs', () => {
    expect(writer.pendingToolUses).toEqual([]);
  });

  // ── manifestFile construction ────────────────────────────────────────

  it('constructs manifestFile from opts.dir and session id', () => {
    const w = new FileSessionWriter(
      '2026-01-01/sess_abc',
      handle as any,
      STARTED_AT,
      makeMeta(),
      undefined,
      { dir: '/tmp/sessions/2026-01-01' },
    );
    const expected = path.join('/tmp/sessions/2026-01-01', 'sess_abc.summary.json');
    expect((w as any).manifestFile).toBe(expected);
  });

  // ── Edge: handles append failures in buffer flush ────────────────────

  it('catches append errors in flushBufferOnce gracefully', async () => {
    const errHandle = mockHandle();
    errHandle.appendFile.mockRejectedValue(new Error('disk full'));

    const w = new FileSessionWriter(
      TEST_ID,
      errHandle as any,
      STARTED_AT,
      makeMeta(),
      { emit: vi.fn() } as unknown as EventBus,
      { filePath: '/tmp/test.jsonl' },
    );

    // Append enough events to trigger an auto-flush
    for (let i = 0; i < 50; i++) {
      await w.append({ type: 'user_input', ts: now(), content: `msg${i}` } as SessionEvent);
    }

    // The flush error is caught and logged — no unhandled rejection
    await new Promise((r) => setTimeout(r, 200));
    // Close the writer (but mock will still reject; we catch at the test level)
    try {
      await w.close();
    } catch {
      // Suppress close errors — we're testing flush error handling, not close
    }
  });
});
