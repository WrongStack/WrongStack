import { afterEach, describe, expect, it, vi } from 'vitest';
import { startQuietSurfaceConsole } from '../../src/webui-server/terminal-log-view.js';

function fakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startQuietSurfaceConsole', () => {
  it('leaves non-TTY console output untouched', () => {
    const target = fakeConsole();
    const originalLog = target.log;

    const view = startQuietSurfaceConsole({ isTTY: false, consoleTarget: target });

    expect(view.enabled).toBe(false);
    expect(target.log).toBe(originalLog);
    target.log('kept by the normal sink');
    expect(originalLog).toHaveBeenCalledWith('kept by the normal sink');
    expect(view.mutedCount).toBe(0);
  });

  it('leaves the console untouched when verbose is requested', () => {
    const target = fakeConsole();
    const originals = { ...target };

    const view = startQuietSurfaceConsole({ isTTY: true, verbose: true, consoleTarget: target });

    expect(view.enabled).toBe(false);
    expect(target).toEqual(originals);
  });

  it('drops log/info/debug chatter but forwards warn/error', () => {
    const target = fakeConsole();
    const originals = { ...target };

    const view = startQuietSurfaceConsole({ isTTY: true, consoleTarget: target });

    target.log('[WebUI] Tool registry loaded');
    target.info('[WebUI] Session created');
    target.debug('[WebUI] Failed to load replay');
    target.warn('provider auto-discovery failed');
    target.error('boom');

    expect(originals.log).not.toHaveBeenCalled();
    expect(originals.info).not.toHaveBeenCalled();
    expect(originals.debug).not.toHaveBeenCalled();
    expect(originals.warn).toHaveBeenCalledWith('provider auto-discovery failed');
    expect(originals.error).toHaveBeenCalledWith('boom');
    expect(view.mutedCount).toBe(3);
    expect(view.recent()).toEqual([
      '[WebUI] Tool registry loaded',
      '[WebUI] Session created',
      '[WebUI] Failed to load replay',
    ]);
    view.stop();
  });

  it('bounds the muted ring buffer while still counting every dropped line', () => {
    const target = fakeConsole();
    const view = startQuietSurfaceConsole({
      isTTY: true,
      consoleTarget: target,
      bufferLines: 2,
    });

    target.log('one');
    target.log('two');
    target.log('three');

    expect(view.mutedCount).toBe(3);
    expect(view.recent()).toEqual(['two', 'three']);
    view.stop();
  });

  it('collapses a repeated warning into a single trailing notice', () => {
    const target = fakeConsole();
    const originalWarn = target.warn;

    const view = startQuietSurfaceConsole({ isTTY: true, consoleTarget: target });

    target.warn('watcher restart failed');
    target.warn('watcher restart failed');
    target.warn('watcher restart failed');
    expect(originalWarn).toHaveBeenCalledTimes(1);

    target.warn('a different problem');

    expect(originalWarn).toHaveBeenNthCalledWith(1, 'watcher restart failed');
    expect(originalWarn).toHaveBeenNthCalledWith(2, '  ↑ previous line repeated 2×');
    expect(originalWarn).toHaveBeenNthCalledWith(3, 'a different problem');
    view.stop();
  });

  it('flushes a pending repeat notice on stop and restores every wrapped method', () => {
    const target = fakeConsole();
    const originals = { ...target };
    const originalError = target.error;

    const view = startQuietSurfaceConsole({ isTTY: true, consoleTarget: target });
    target.error('the same failure');
    target.error('the same failure');
    view.stop();

    expect(originalError).toHaveBeenNthCalledWith(2, '  ↑ previous line repeated 1×');
    expect(target).toEqual(originals);

    // Idempotent: a second stop neither re-flushes nor re-wraps.
    view.stop();
    expect(originalError).toHaveBeenCalledTimes(2);
  });
});
