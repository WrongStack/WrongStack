import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so we can drive spawn()'s async 'error' event — the failure
// mode that previously crashed the process (#99 class: an unhandled child
// 'error' event terminates the runtime).
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const { killWin32Tree } = await import('../src/process-registry.js');

/** A spawn() stand-in that emits 'error' asynchronously, like a missing binary. */
function erroringChild(): EventEmitter & { unref: () => unknown } {
  const c = new EventEmitter() as EventEmitter & { unref: () => unknown };
  c.unref = vi.fn();
  // Defer so the listener killWin32Tree attaches is in place first.
  queueMicrotask(() => c.emit('error', new Error('spawn taskkill ENOENT')));
  return c;
}

describe('killWin32Tree async-error safety (#99)', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('swallows an async spawn error instead of crashing', async () => {
    const child = erroringChild();
    spawnMock.mockReturnValue(child);

    // Track whether the unhandled 'error' would have escaped to the process.
    let escaped: unknown;
    const onUnhandled = (err: unknown) => {
      escaped = err;
    };
    process.once('uncaughtException', onUnhandled);
    try {
      expect(killWin32Tree(1234)).toBe(true);
      // Let the deferred 'error' fire; it must be absorbed by the listener.
      await new Promise((r) => setTimeout(r, 10));
      expect(escaped).toBeUndefined();
      expect(child.listenerCount('error')).toBeGreaterThan(0);
      expect(child.unref).toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtException', onUnhandled);
    }
  });

  it('returns false when spawn throws synchronously', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('sync spawn failure');
    });
    expect(killWin32Tree(1234)).toBe(false);
  });
});
