import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBoundedTerminalLogView } from '../../src/webui-server/terminal-log-view.js';

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startBoundedTerminalLogView', () => {
  it('leaves non-TTY console output untouched', () => {
    const target = fakeConsole();
    const originalLog = target.log;
    const write = vi.fn();

    const view = startBoundedTerminalLogView({
      isTTY: false,
      consoleTarget: target,
      write,
    });

    expect(view.enabled).toBe(false);
    expect(target.log).toBe(originalLog);
    target.log('kept by the normal sink');
    view.redraw();
    expect(originalLog).toHaveBeenCalledWith('kept by the normal sink');
    expect(write).not.toHaveBeenCalled();
  });

  it('periodically clears and redraws only the newest five physical lines', () => {
    vi.useFakeTimers();
    const target = fakeConsole();
    const originalLog = target.log;
    const originalWarn = target.warn;
    const write = vi.fn();
    const view = startBoundedTerminalLogView({
      isTTY: true,
      consoleTarget: target,
      write,
      refreshMs: 1_000,
    });

    target.log('line 1');
    target.info('line 2\nline 3');
    target.warn('line %d', 4);
    target.error('line 5');
    target.debug('line 6');

    vi.advanceTimersByTime(1_000);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenLastCalledWith('\x1b[2J\x1b[Hline 2\nline 3\nline 4\nline 5\nline 6\n');
    expect(originalLog).toHaveBeenCalledWith('line 1');
    expect(originalWarn).toHaveBeenCalledWith('line %d', 4);
    view.stop();
  });

  it('stops the timer and restores every wrapped console method', () => {
    vi.useFakeTimers();
    const target = fakeConsole();
    const originals = { ...target };
    const write = vi.fn();
    const view = startBoundedTerminalLogView({
      isTTY: true,
      consoleTarget: target,
      write,
      refreshMs: 1_000,
    });

    target.log('last line');
    view.stop();
    vi.advanceTimersByTime(2_000);

    expect(write).not.toHaveBeenCalled();
    expect(target).toEqual(originals);
  });
});
