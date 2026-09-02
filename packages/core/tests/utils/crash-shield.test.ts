import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/term.js', () => ({
  writeErr: vi.fn(),
}));

import { writeErr } from '../../src/utils/term.js';
import {
  addFatalSalvageHook,
  installCrashShield,
  runFatalSalvageSync,
} from '../../src/utils/crash-shield.js';

describe('installCrashShield', () => {
  it('ignores broken output consumer exceptions', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({
      target: target as never,
      write,
      exit,
    });

    target.emit(
      'uncaughtException',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );

    expect(write).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });

  it('reports other uncaught exceptions', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({
      target: target as never,
      write,
      exit,
    });
    const error = Object.assign(new Error('boom'), { code: 'ERR_TEST' });

    target.emit('uncaughtException', error);

    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('boom');
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('fatal salvage hooks', () => {
  it('runFatalSalvageSync runs registered hooks synchronously; unregister removes them', () => {
    const calls: string[] = [];
    const off = addFatalSalvageHook(() => calls.push('a'));

    runFatalSalvageSync();
    expect(calls).toEqual(['a']);

    off();
    runFatalSalvageSync();
    expect(calls).toEqual(['a']);
  });

  it('a throwing hook does not skip later hooks', () => {
    const calls: string[] = [];
    const off1 = addFatalSalvageHook(() => {
      throw new Error('fd already closed');
    });
    const off2 = addFatalSalvageHook(() => calls.push('b'));

    expect(() => runFatalSalvageSync()).not.toThrow();
    expect(calls).toEqual(['b']);

    off1();
    off2();
  });

  it('the shield salvages synchronously before an error-storm exit', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const salvaged = vi.fn();
    const off = addFatalSalvageHook(salvaged);
    const cleanupShield = installCrashShield({ target: target as never, write, exit });

    // Storm limit is 20 errors within a 60s window — emit 21 to trip it.
    for (let i = 0; i < 21; i++) {
      target.emit(
        'unhandledRejection',
        Object.assign(new Error(`boom ${i}`), { code: 'ERR_TEST' }),
      );
    }

    expect(exit).toHaveBeenCalledWith(1);
    // Salvage ran BEFORE the fatal exit decision consumed the storm.
    expect(salvaged).toHaveBeenCalled();
    expect(salvaged.mock.invocationCallOrder[0]!).toBeLessThan(exit.mock.invocationCallOrder[0]!);

    off();
    cleanupShield();
  });
});

describe('installCrashShield — error-type branches', () => {
  it.each(['EPIPE', 'ECONNABORTED'])(
    'treats %s as a broken output consumer (does not report or exit)',
    (code) => {
      const target = new EventEmitter();
      const write = vi.fn();
      const exit = vi.fn();
      const cleanup = installCrashShield({ target: target as never, write, exit });

      target.emit('uncaughtException', Object.assign(new Error(`${code} error`), { code }));

      expect(write).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      cleanup();
    },
  );

  it('reports string rejection reasons via String() (not a broken output consumer)', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, write, exit });

    target.emit('unhandledRejection', 'just a string');

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('just a string');
    cleanup();
  });

  it('reports null rejection reasons via String() (not a broken output consumer)', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, write, exit });

    target.emit('unhandledRejection', null);

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('null');
    cleanup();
  });

  it('reports errors without a code property (not a broken output consumer)', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, write, exit });

    target.emit('uncaughtException', new Error('plain boom'));

    expect(write).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('falls back to error.message when stack is unavailable', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, write, exit });

    const error = Object.assign(new Error('stackless'), { stack: undefined });
    target.emit('uncaughtException', error);

    expect(write).toHaveBeenCalledWith(expect.stringContaining('stackless'));
    cleanup();
  });

  it('swallows write failures so the error-storm path is not blocked', () => {
    const target = new EventEmitter();
    const write = vi.fn(() => {
      throw new Error('stderr broken');
    });
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, write, exit });

    expect(() => target.emit('uncaughtException', new Error('boom'))).not.toThrow();
    cleanup();
  });
});

describe('installCrashShield — default options', () => {
  it('uses default writeErr when write option is omitted', () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installCrashShield({ target: target as never, exit });

    target.emit('uncaughtException', new Error('default write'));

    expect(vi.mocked(writeErr)).toHaveBeenCalledWith(expect.stringContaining('default write'));
    cleanup();
  });

  it('uses process as the default target when target option is omitted', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    const offSpy = vi.spyOn(process, 'off').mockImplementation((() => process) as never);
    const write = vi.fn();
    const exit = vi.fn();

    const cleanup = installCrashShield({ write, exit });

    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));

    cleanup();

    expect(offSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    onSpy.mockRestore();
    offSpy.mockRestore();
  });

  it('uses default process.exit when exit option is omitted and a storm triggers', () => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter();
      vi.mocked(writeErr).mockClear();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      const cleanup = installCrashShield({ target: target as never });

      for (let i = 0; i < 21; i++) {
        target.emit(
          'unhandledRejection',
          Object.assign(new Error(`boom ${i}`), { code: 'ERR_TEST' }),
        );
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      cleanup();
      exitSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('installCrashShield — storm window expiry', () => {
  it('evicts errors outside the 60s window before checking the storm limit', () => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter();
      const write = vi.fn();
      const exit = vi.fn();
      const cleanup = installCrashShield({ target: target as never, write, exit });

      // Seed 5 errors at T0.
      for (let i = 0; i < 5; i++) {
        target.emit(
          'unhandledRejection',
          Object.assign(new Error(`early ${i}`), { code: 'ERR_TEST' }),
        );
      }

      // Advance past the storm window.
      vi.advanceTimersByTime(61_000);

      // Emit 16 more — old ones expired, 16 < 20 limit, no storm.
      for (let i = 0; i < 16; i++) {
        target.emit(
          'unhandledRejection',
          Object.assign(new Error(`late ${i}`), { code: 'ERR_TEST' }),
        );
      }

      expect(exit).not.toHaveBeenCalled();

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('addFatalSalvageHook — unregister edge cases', () => {
  it('calling unregister twice is a safe no-op (hook no longer found)', () => {
    const calls: string[] = [];
    const off = addFatalSalvageHook(() => calls.push('a'));
    off();
    expect(() => off()).not.toThrow();

    runFatalSalvageSync();
    expect(calls).toEqual([]);
  });
});
