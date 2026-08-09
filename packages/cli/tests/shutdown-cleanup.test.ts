import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from '../src/shutdown-cleanup.js';

describe('createGracefulShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // Do not actually exit — just record the call.
    }) as never);
    // Force the 500ms grace timer to fire immediately so tests don't hang.
    // Return an object with .unref() so production code that calls it doesn't
    // crash under the mock.
    setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: (...args: unknown[]) => void, _ms?: number) => {
        const args: unknown[] = [];
        // Fire the callback asynchronously so we can observe ordering.
        Promise.resolve().then(() => fn(...args));
        return { unref: () => {}, ref: () => {}, hasRef: () => false } as never;
      });
    // Reset exitCode between tests so cross-test pollution doesn't break
    // assertions that rely on its initial state.
    process.exitCode = undefined;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    vi.restoreAllMocks();
    // Always peel off any leftover signal listeners we installed during the
    // test, so the next test starts clean.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('beforeExit');
  });

  it('awaits async cleanup before scheduling the 500ms exit', async () => {
    const order: string[] = [];

    const handle = createGracefulShutdown({
      run: async () => {
        order.push('cleanup:start');
        // Simulate the awaited disk write inside registry.markClosing().
        await new Promise((r) => setTimeout(r, 10));
        order.push('cleanup:end');
      },
    });
    handle.install();

    process.emit('SIGINT');

    // Let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(order).toEqual(['cleanup:start', 'cleanup:end']);
    expect(handle.cleanupStarted).toBe(true);
    // The grace timer fires synchronously under our mock, so by this point
    // process.exit must have been called with the default exit code (0).
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(process.exitCode).toBe(0);
  });

  it('runs cleanup exactly once even when multiple signals fire', async () => {
    // Node's default SIGINT/SIGTERM handler exits with 130 / 143 if our
    // handler isn't installed; once we install via `process.once`, the first
    // signal consumes the slot. Subsequent signals fire the default handler.
    // What THIS helper guarantees is that the cleanup function itself never
    // runs more than once across all signal sources.
    let resolveCleanup!: () => void;
    const cleanupStarted = vi.fn();
    const handle = createGracefulShutdown({
      run: () =>
        new Promise<void>((r) => {
          cleanupStarted();
          resolveCleanup = r;
        }),
    });
    handle.install();

    process.emit('SIGINT');
    // beforeExit fires while cleanup is still in flight. The helper must
    // not kick off a second cleanup run.
    process.emit('beforeExit');

    expect(cleanupStarted).toHaveBeenCalledTimes(1);

    // Resolve the original cleanup so we don't leak a pending promise.
    resolveCleanup();
    await new Promise((r) => setImmediate(r));
  });

  it('runs cleanup on beforeExit but does NOT force-exit', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const handle = createGracefulShutdown({ run: cleanup });
    handle.install();

    process.emit('beforeExit');
    await new Promise((r) => setImmediate(r));

    expect(cleanup).toHaveBeenCalledTimes(1);
    // beforeExit means Node is already draining — we should not schedule a
    // 500ms force-exit timer, and we should not call process.exit ourselves.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(0);
  });

  it('swallows cleanup errors so a stuck cleanup cannot wedge the exit', async () => {
    const handle = createGracefulShutdown({
      run: async () => {
        throw new Error('cleanup went sideways');
      },
    });
    handle.install();

    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // exitCode still gets set; force-exit still fires.
    expect(process.exitCode).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('install() is idempotent — multiple installs do not stack listeners', () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const handle = createGracefulShutdown({ run: cleanup });

    handle.install();
    handle.install();
    handle.install();

    expect(process.listenerCount('SIGINT')).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(process.listenerCount('beforeExit')).toBe(1);
  });

  it('cleanupStarted stays false until a signal actually fires', () => {
    const handle = createGracefulShutdown({ run: vi.fn().mockResolvedValue(undefined) });
    handle.install();

    expect(handle.cleanupStarted).toBe(false);
  });

  it('uses a custom exit code when provided', async () => {
    const handle = createGracefulShutdown({
      run: async () => {
        /* nothing */
      },
      exitCode: 130,
    });
    handle.install();

    process.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(process.exitCode).toBe(130);
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('uninstall() removes the listeners', () => {
    const handle = createGracefulShutdown({ run: vi.fn().mockResolvedValue(undefined) });
    handle.install();
    expect(process.listenerCount('SIGINT')).toBe(1);

    handle.uninstall();
    expect(process.listenerCount('SIGINT')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('beforeExit')).toBe(0);
  });
});
