import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { installBrokenPipeHandlers } from '../src/cli-entry-point.js';

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
