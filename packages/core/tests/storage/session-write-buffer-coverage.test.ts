vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

import { closeSync, openSync, writeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../src/kernel/events.js';
import {
  type FlushBufferOptions,
  SessionWriteBuffer as ProductionSessionWriteBuffer,
  type SessionWriteBufferOptions,
} from '../../src/storage/session-write-buffer.js';
import type { SessionEvent } from '../../src/types/session.js';

const now = () => new Date().toISOString();

type UserInputSessionEvent = Extract<SessionEvent, { type: 'user_input' }>;

type PublicSessionWriteBuffer = {
  [Key in keyof InstanceType<typeof ProductionSessionWriteBuffer>]: InstanceType<
    typeof ProductionSessionWriteBuffer
  >[Key];
};

const SessionWriteBuffer = ProductionSessionWriteBuffer as unknown as {
  new (
    opts: SessionWriteBufferOptions,
  ): PublicSessionWriteBuffer & {
    flushBufferOnce(isClosed: boolean, opts?: FlushBufferOptions): Promise<void>;
  };
  readonly FLUSH_INTERVAL_MS: number;
  readonly FLUSH_SIZE: number;
  readonly WRITE_BUFFER_MAX_EVENTS: number;
  readonly WRITE_BUFFER_MAX_BYTES: number;
};

function makeEvent(): UserInputSessionEvent {
  return {
    type: 'user_input',
    ts: now(),
    content: 'hello world',
  };
}

function makeLargeEvent(): UserInputSessionEvent {
  return {
    type: 'user_input',
    ts: now(),
    content: 'x'.repeat(SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES + 1),
  };
}

describe('SessionWriteBuffer — coverage', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-wb-cov-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function makeOpts(
    overrides: {
      handle?: Record<string, unknown>;
      filePath?: string;
      events?: EventBus | undefined;
      getTraceId?: () => string | undefined;
    } = {},
  ): SessionWriteBufferOptions {
    const filePath = overrides.filePath ?? path.join(tmp, 'sess.jsonl');
    const handle = overrides.handle ?? {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return {
      sessionId: 's',
      filePath,
      getHandle: () =>
        ({
          appendFile: handle.appendFile,
          datasync: handle.datasync,
          close: handle.close,
        }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
      ...(overrides.events === undefined ? {} : { events: overrides.events }),
      ...(overrides.getTraceId === undefined ? {} : { getTraceId: overrides.getTraceId }),
    };
  }

  it('get isClosed returns false', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    expect(buffer.isClosed).toBe(false);
  });

  it('push rejects events that fail to serialize (circular reference)', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    const event = {
      type: 'user_input',
      ts: now(),
      content: 'ok',
      circular: undefined as unknown,
    } as unknown as SessionEvent & { circular?: unknown };
    event.circular = event; // circular reference → JSON.stringify throws
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(buffer.push(event as never)).toBe(false);
      expect(buffer.length).toBe(0);
      // The drop is reported, never silent.
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('buffer_push_invalid')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('push returns false when the event count exceeds the limit', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    let pushed = true;
    for (let i = 0; i < SessionWriteBuffer.WRITE_BUFFER_MAX_EVENTS; i++) {
      pushed &&= buffer.push(makeEvent());
    }
    expect(pushed).toBe(true);
    expect(buffer.push(makeEvent())).toBe(false);
  });

  it('accepts an oversized single event and marks the buffer flush-ready', async () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    expect(buffer.push(makeLargeEvent())).toBe(true);
    expect(buffer.length).toBe(1);
    expect(buffer.shouldFlushNow()).toBe(true);
    await expect(buffer.flushBuffer()).resolves.toBeUndefined();
  });

  it('push rejects a single event above the hard per-event ceiling', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Pathological payload: far above the retention budget, so the
      // empty-buffer exemption must NOT apply — reject instead of pinning
      // memory and stalling the event loop on stringify.
      const huge = makeLargeEvent();
      huge.content = 'x'.repeat(SessionWriteBuffer.WRITE_BUFFER_MAX_BYTES * 4 + 1);
      expect(buffer.push(huge)).toBe(false);
      expect(buffer.length).toBe(0);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('session.buffer_overflow')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('shouldFlushNow returns true when the buffer reaches the flush size', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    for (let i = 0; i < SessionWriteBuffer.FLUSH_SIZE - 1; i++) {
      buffer.push(makeEvent());
    }
    expect(buffer.shouldFlushNow()).toBe(false);
    buffer.push(makeEvent());
    expect(buffer.shouldFlushNow()).toBe(true);
  });

  it('enqueueWrite reopens the file handle on a closed-handle error', async () => {
    const filePath = path.join(tmp, 'reopen.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'EBADF' })),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    await buffer.enqueueWrite('data\n');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('data\n');
  });

  it('enqueueWrite rethrows non-closed-handle append errors', async () => {
    const handle = {
      appendFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
      datasync: vi.fn(),
      close: vi.fn(),
    };
    const buffer = new SessionWriteBuffer(makeOpts({ handle }));
    await expect(buffer.enqueueWrite('data\n')).rejects.toThrow(/disk full/);
  });

  it('flushBuffer joins an already-running flush', async () => {
    const filePath = path.join(tmp, 'joined.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setImmediate(r));
        return undefined;
      }),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.push(makeEvent());
    const p1 = buffer.flushBuffer();
    const p2 = buffer.flushBuffer();
    await Promise.all([p1, p2]);
    expect(handle.appendFile).toHaveBeenCalled();
  });

  it('flushBuffer join with datasync calls handle.datasync on the running handle', async () => {
    const filePath = path.join(tmp, 'joined-sync.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setImmediate(r));
        return undefined;
      }),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    const p1 = buffer.flushBuffer();
    const p2 = buffer.flushBuffer(false, { datasync: true });
    await Promise.all([p1, p2]);
    expect(handle.datasync).toHaveBeenCalled();
  });

  it('flushBufferOnce returns early when the buffer is empty', async () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    await buffer.flushBufferOnce(false);
  });

  it('flushBufferOnce rethrows append errors and restores the buffer', async () => {
    const handle = {
      appendFile: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOSPC' })),
      datasync: vi.fn(),
      close: vi.fn(),
    };
    const eventBus = { emit: vi.fn() } as unknown as EventBus;
    const buffer = new SessionWriteBuffer(makeOpts({ handle, events: eventBus }));
    buffer.push(makeEvent());
    buffer.push(makeEvent());
    await expect(buffer.flushBufferOnce(false)).rejects.toThrow(/nope/);
    expect(buffer.length).toBe(2);
    expect(eventBus.emit).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({ outcome: 'failure', operation: 'flush' }),
    );
  });

  it('flushBufferOnce performs datasync when requested', async () => {
    const handle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer(makeOpts({ handle }));
    buffer.push(makeEvent());
    await buffer.flushBufferOnce(false, { datasync: true });
    expect(handle.datasync).toHaveBeenCalled();
  });

  it('flushBufferOnce swallows a datasync failure but still writes', async () => {
    const handle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockRejectedValue(Object.assign(new Error('sync failed'), { code: 'EIO' })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer(makeOpts({ handle }));
    buffer.push(makeEvent());
    await buffer.flushBufferOnce(false, { datasync: true });
    expect(buffer.length).toBe(0);
  });

  it('drainWriteChain resolves immediately when the chain is settled', async () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    await expect(buffer.drainWriteChain()).resolves.toBeUndefined();
  });

  it('drainFlushPromise resolves immediately when no flush is in progress', async () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    await expect(buffer.drainFlushPromise()).resolves.toBeUndefined();
  });

  it('drainFlushPromise awaits an in-flight flush', async () => {
    const filePath = path.join(tmp, 'drain.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setImmediate(r));
      }),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    const flushPromise = buffer.flushBuffer();
    const drained = buffer.drainFlushPromise();
    await flushPromise;
    await drained;
  });

  it('scheduleFlush sets a timer that fires the flush', async () => {
    vi.useFakeTimers();
    const filePath = path.join(tmp, 'timer.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.scheduleFlush();
    await vi.advanceTimersByTimeAsync(SessionWriteBuffer.FLUSH_INTERVAL_MS + 100);
    expect(handle.appendFile).toHaveBeenCalled();
    buffer.cancelTimer();
    vi.useRealTimers();
  });

  it('cancelTimer is a no-op when no timer is set', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    buffer.cancelTimer();
  });

  it('cancelTimer clears an active timer', () => {
    vi.useFakeTimers();
    const buffer = new SessionWriteBuffer(makeOpts());
    buffer.push(makeEvent());
    buffer.scheduleFlush();
    buffer.cancelTimer();
    vi.advanceTimersByTime(SessionWriteBuffer.FLUSH_INTERVAL_MS + 100);
    vi.useRealTimers();
  });

  it('scheduleFlush does nothing when already called', () => {
    vi.useFakeTimers();
    const buffer = new SessionWriteBuffer(makeOpts());
    buffer.push(makeEvent());
    buffer.scheduleFlush();
    // second call should be a no-op (timer already set)
    buffer.scheduleFlush();
    vi.useRealTimers();
    buffer.cancelTimer();
  });

  it('scheduleFlush(true) is a no-op (no timer set)', () => {
    vi.useFakeTimers();
    const filePath = path.join(tmp, 'no-schedule.jsonl');
    const handle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => ({ ...handle }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.scheduleFlush(true);
    // Advance past the flush interval — no flush should happen
    vi.advanceTimersByTime(SessionWriteBuffer.FLUSH_INTERVAL_MS + 100);
    expect(handle.appendFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clear resets the buffer and counters', () => {
    const buffer = new SessionWriteBuffer(makeOpts());
    buffer.push(makeEvent());
    buffer.push(makeEvent());
    buffer.clear();
    expect(buffer.length).toBe(0);
  });

  it('flushSync is a no-op when the buffer is empty', () => {
    const filePath = path.join(tmp, 'empty.jsonl');
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () =>
        ({ appendFile: vi.fn(), datasync: vi.fn(), close: vi.fn() }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.flushSync();
  });

  it('flushSync is a no-op when filePath is undefined', () => {
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath: '',
      getHandle: () =>
        ({ appendFile: vi.fn(), datasync: vi.fn(), close: vi.fn() }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.flushSync();
    expect(buffer.length).toBe(1);
  });

  it('flushSync clears the buffer after a successful write+datasync', async () => {
    const filePath = path.join(tmp, 'sync-ok.jsonl');
    await fs.writeFile(filePath, '');
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () =>
        ({ appendFile: vi.fn(), datasync: vi.fn(), close: vi.fn() }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.flushSync();
    expect(buffer.length).toBe(0);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('user_input');
  });

  it('flushSync keeps the buffer when writeSync throws after open', () => {
    const filePath = path.join(tmp, 'sync-write-fail.jsonl');
    vi.mocked(openSync).mockImplementationOnce(() => 42);
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    vi.mocked(closeSync).mockImplementationOnce(() => undefined);
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () =>
        ({ appendFile: vi.fn(), datasync: vi.fn(), close: vi.fn() }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
      getTraceId: () => 'trace-123',
    });
    buffer.push(makeEvent());
    buffer.push(makeEvent());
    buffer.flushSync();
    // openSync succeeded (fd was set), writeSync threw → buffer kept, closeSync called
    expect(buffer.length).toBe(2);
    expect(openSync).toHaveBeenCalledWith(filePath, 'a');
    expect(writeSync).toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledWith(42);
  });

  it('flushSync swallows closeSync errors in the finally block', () => {
    const filePath = path.join(tmp, 'sync-close-fail.jsonl');
    vi.mocked(openSync).mockImplementationOnce(() => 99);
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    vi.mocked(closeSync).mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () =>
        ({ appendFile: vi.fn(), datasync: vi.fn(), close: vi.fn() }) as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push(makeEvent());
    buffer.flushSync();
    expect(buffer.length).toBe(1); // buffer kept because write threw
  });

  it('flushBuffer emits storage.write event with traceId', async () => {
    const handle = {
      appendFile: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const emitCalls: unknown[] = [];
    const eventBus = {
      emit: vi.fn((...args: unknown[]) => {
        emitCalls.push(args);
      }),
    } as unknown as EventBus;
    const buffer = new SessionWriteBuffer(
      makeOpts({ handle, events: eventBus, getTraceId: () => 'trace-456' }),
    );
    buffer.push(makeEvent());
    await buffer.flushBufferOnce(false);
    expect(
      emitCalls.some((call) => {
        const [name, payload] = call as [unknown, { traceId?: string }?];
        return name === 'storage.write' && payload?.traceId === 'trace-456';
      }),
    ).toBe(true);
  });

  it('flushSync defers teardown events behind an already-started async append', async () => {
    const filePath = path.join(tmp, 'sigterm-teardown.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn(async (data: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await fs.appendFile(filePath, data);
      }),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => handle as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push({ type: 'user_input', ts: now(), content: 'in-flight' } as SessionEvent);
    const flushPromise = buffer.flushBuffer();
    // Let the flush issue its async append (started, not yet settled).
    await new Promise((resolve) => setImmediate(resolve));
    // Teardown-time events land in the buffer after the flush snapshot.
    buffer.push({ type: 'user_input', ts: now(), content: 'late-1' } as SessionEvent);
    buffer.push({ type: 'user_input', ts: now(), content: 'late-2' } as SessionEvent);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buffer.flushSync();
      expect(buffer.length).toBe(2);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('flush_sync_deferred')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
    await flushPromise.catch(() => undefined);

    const content = await fs.readFile(filePath, 'utf8');
    const inFlightIdx = content.indexOf('in-flight');
    const late1Idx = content.indexOf('late-1');
    const late2Idx = content.indexOf('late-2');
    expect(inFlightIdx).toBeGreaterThanOrEqual(0);
    expect(late1Idx).toBeGreaterThan(inFlightIdx);
    expect(late2Idx).toBeGreaterThan(late1Idx);
    expect(buffer.length).toBe(0);
  }, 10_000);

  it('flushSync defers with the buffer preserved when the in-flight append never settles', async () => {
    const filePath = path.join(tmp, 'defer-budget.jsonl');
    await fs.writeFile(filePath, '');
    const handle = {
      appendFile: vi.fn(() => new Promise<undefined>(() => {})),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => handle as unknown as fs.FileHandle,
      setHandle: () => undefined,
    });
    buffer.push({ type: 'user_input', ts: now(), content: 'pre' } as SessionEvent);
    void buffer.flushBuffer();
    await new Promise((resolve) => setImmediate(resolve));
    buffer.push({ type: 'user_input', ts: now(), content: 'teardown' } as SessionEvent);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buffer.flushSync(); // started async append is left alone; buffer is kept
      expect(buffer.length).toBe(1);
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes('flush_sync_deferred')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
