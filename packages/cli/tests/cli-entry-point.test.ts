import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrokenPipeHandlers, scheduleForcedExit } from '../src/cli-entry-point.js';

describe('CLI crash shield', () => {
  // `runAsMain` early-returns unless the module IS the process entry point, so
  // it cannot be exercised in-process. The regression being guarded is not a
  // behavioural edge case but a deleted call site: the shield was installed
  // here, then silently dropped to zero call sites repo-wide, leaving every
  // in-process host (TUI, WebUI, HQ, fleet) one escaped rejection from death.
  // A source-level assertion is the honest guard for that failure mode.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli-entry-point.ts'),
    'utf8',
  );

  it('runAsMain installs the process-level crash shield', () => {
    expect(source).toMatch(/installCrashShield\(\)/);
  });

  it('installs the crash shield after the broken-pipe handlers', () => {
    // Ordering matters: the shield deliberately ignores EPIPE/ECONNRESET so the
    // broken-pipe handler can turn those into a clean exit(0).
    const pipeAt = source.indexOf('installBrokenPipeHandlers()');
    const shieldAt = source.indexOf('installCrashShield()');
    expect(pipeAt).toBeGreaterThan(-1);
    expect(shieldAt).toBeGreaterThan(pipeAt);
  });
});

describe('CLI broken-pipe handling', () => {
  it('treats stdout EPIPE as a clean exit', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });

    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    cleanup();
  });

  it('treats stdout ECONNRESET as a clean exit', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });

    stdout.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    cleanup();
  });

  it('handles only the first EPIPE when both output streams close', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    stdout.emit('error', brokenPipe);
    stderr.emit('error', brokenPipe);

    expect(exit).toHaveBeenCalledOnce();
    cleanup();
  });

  it('rethrows non-EPIPE output errors', () => {
    const stdout = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout], exit });
    const error = Object.assign(new Error('stream destroyed'), {
      code: 'ERR_STREAM_DESTROYED',
    });

    expect(() => stdout.emit('error', error)).toThrow(error);
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });

  it('removes its listeners during cleanup', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const cleanup = installBrokenPipeHandlers({
      streams: [stdout, stderr],
      exit: vi.fn(),
    });

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);

    cleanup();

    expect(stdout.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('error')).toBe(0);
  });
});

describe('forced-exit scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extends the grace window while a fs write stream stays active, then forces at the ceiling', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    scheduleForcedExit(7, {
      getActiveResources: () => ['WriteStream'],
      exit,
    });

    // Under the 5s ceiling: every 500ms check finds a durability handle and
    // re-arms instead of killing.
    vi.advanceTimersByTime(4_500);
    expect(exit).not.toHaveBeenCalled();

    // At the ceiling the window stops extending and the exit is forced.
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(7);

    const payload = JSON.parse(String(warn.mock.calls[0]?.[0])) as {
      event: string;
      exitCode: number;
      waitedMs: number;
      extensions: number;
      activeResources: string[];
    };
    expect(payload.event).toBe('exit.forced');
    expect(payload.exitCode).toBe(7);
    expect(payload.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(payload.extensions).toBeGreaterThan(0);
    expect(payload.activeResources).toContain('WriteStream');
  });

  it('caps socket-only extensions at one extra window so idle keep-alives cannot stall exit', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    scheduleForcedExit(0, { getActiveResources: () => ['TCPSocketWrap'], exit });

    // First window: the socket earns one extension — it may be mid-flush.
    vi.advanceTimersByTime(500);
    expect(exit).not.toHaveBeenCalled();

    // Second check: the socket budget is spent, so exit is forced instead of
    // stalling to the 5s ceiling on an idle keep-alive.
    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);

    const payload = JSON.parse(String(warn.mock.calls[0]?.[0])) as {
      waitedMs: number;
      extensions: number;
    };
    expect(payload.waitedMs).toBe(1_000);
    expect(payload.extensions).toBe(1);
  });

  it('does not extend for handles that cannot carry writes (TTYWrap), but still reports the forced exit', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    scheduleForcedExit(0, { getActiveResources: () => ['TTYWrap'], exit });

    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);

    const payload = JSON.parse(String(warn.mock.calls[0]?.[0])) as {
      event: string;
      waitedMs: number;
      extensions: number;
      activeResources: string[];
    };
    expect(payload.event).toBe('exit.forced');
    expect(payload.waitedMs).toBe(500);
    expect(payload.extensions).toBe(0);
    expect(payload.activeResources).toEqual(['TTYWrap']);
  });

  it('exits silently when the loop has nothing left to drain', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    scheduleForcedExit(3, { getActiveResources: () => [], exit });

    vi.advanceTimersByTime(2_000);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(3);
    expect(warn).not.toHaveBeenCalled();
  });
});
