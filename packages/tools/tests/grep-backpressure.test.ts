import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: (...args: unknown[]) => spawnMock.fn(...args) };
});

import { __resetRgDetectionForTests, grepTool } from '../src/grep.js';

// rg availability is memoized per process; each test expects its own
// `rg --version` probe spawn, so forget the cache between tests.
beforeEach(() => {
  __resetRgDetectionForTests();
});

class FakeReadable extends EventEmitter {
  pause = vi.fn();
  resume = vi.fn();
  destroy = vi.fn();
}

class FakeChild extends EventEmitter {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe('grep rg stream lifecycle', () => {
  it('backpressures a slow consumer and tears down an abandoned generator', async () => {
    const detector = new FakeChild();
    const rg = new FakeChild();
    spawnMock.fn.mockReset();
    spawnMock.fn.mockImplementationOnce(() => {
      queueMicrotask(() => detector.emit('close', 0));
      return detector;
    });
    spawnMock.fn.mockReturnValueOnce(rg);

    const stream = grepTool.executeStream!(
      { pattern: 'match', output_mode: 'content' },
      { cwd: process.cwd(), projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalledTimes(2));

    // Emit faster than the async-generator consumer can request the next
    // partial event. The rg pipe must be paused at the queue watermark.
    for (let index = 0; index < 140; index++) {
      rg.stdout.emit('data', Buffer.from(`file.ts:${index}:match\n`));
    }
    expect(rg.stdout.pause).toHaveBeenCalledTimes(1);

    await expect(first).resolves.toMatchObject({ value: { type: 'partial_output' } });
    expect(rg.stdout.resume).toHaveBeenCalled();

    await stream.return?.(undefined);
    expect(rg.stdout.listenerCount('data')).toBe(0);
    expect(rg.stdout.destroy).toHaveBeenCalled();
    expect(rg.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills rg and surfaces truncation when a single huge line exceeds MAX_BUF_BYTES (1 MiB)', async () => {
    // A pathological producer emits one unterminated blob larger than the
    // 1 MiB cap (e.g. a binary symlink target with no newlines). Without
    // the cap, `buf` would grow unbounded and pin the child. The code
    // slices the tail, kills the child with SIGTERM, and marks the
    // result `truncated: true` so the caller knows the output is
    // incomplete rather than silently mid-stream.
    const detector = new FakeChild();
    const rg = new FakeChild();
    spawnMock.fn.mockReset();
    spawnMock.fn.mockImplementationOnce(() => {
      queueMicrotask(() => detector.emit('close', 0));
      return detector;
    });
    spawnMock.fn.mockReturnValueOnce(rg);

    const stream = grepTool.executeStream!(
      { pattern: 'match', output_mode: 'content' },
      { cwd: process.cwd(), projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalledTimes(2));

    // Emit a single >1 MiB chunk with NO trailing newline so the parser
    // cannot split it into lines — `buf` keeps growing until it crosses
    // MAX_BUF_BYTES and triggers the kill path.
    const huge = Buffer.alloc(1_100_000, 0x41); // 1.1 MiB of 'A', no newlines
    rg.stdout.emit('data', huge);
    rg.emit('close', 0);

    // Drain the stream to completion and confirm the child was killed
    // and the final result reports truncation.
    const events: Array<{ type: string; output?: { truncated?: boolean; used?: string } }> = [];
    const firstEvent = await first;
    if (firstEvent.value) events.push(firstEvent.value as (typeof events)[number]);
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      const ev = next.value;
      events.push(ev as (typeof events)[number]);
      if (ev.type === 'final') break;
    }

    expect(rg.kill).toHaveBeenCalledWith('SIGTERM');
    const final = events.find((e) => e.type === 'final');
    expect(final?.output?.truncated).toBe(true);
    expect(final?.output?.used).toBe('rg');
  });
});
