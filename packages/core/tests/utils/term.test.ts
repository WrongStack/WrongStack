import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTermSize,
  isInteractive,
  isStdinTTY,
  isStdoutTTY,
  onResize,
  setOutputLineGuard,
  setRawMode,
  TerminalLifecycle,
  writeErr,
  writeOut,
} from '../../src/utils/term.js';

describe('term helpers', () => {
  // Snapshot the original stream props so afterEach can restore them, even
  // when the test environment started non-TTY (CI: isTTY is typically
  // undefined). configurable:true is required so defineProperty can overwrite
  // the readonly native getter.
  const orig = {
    in: process.stdin.isTTY,
    out: process.stdout.isTTY,
    rows: process.stdout.rows,
    cols: process.stdout.columns,
  } as const;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: orig.in, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: orig.out, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: orig.rows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: orig.cols, configurable: true });
  });

  function setTty(inTty: boolean, outTty: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
  }

  describe('isStdoutTTY', () => {
    it('returns true when stdout is a TTY', () => {
      setTty(false, true);
      expect(isStdoutTTY()).toBe(true);
    });

    it('returns false when stdout is piped/redirected', () => {
      setTty(false, false);
      expect(isStdoutTTY()).toBe(false);
    });
  });

  describe('isStdinTTY', () => {
    it('returns true when stdin is a TTY', () => {
      setTty(true, false);
      expect(isStdinTTY()).toBe(true);
    });

    it('returns false when stdin is piped/redirected', () => {
      setTty(false, false);
      expect(isStdinTTY()).toBe(false);
    });
  });

  describe('isInteractive', () => {
    it('is true only when both streams are TTYs', () => {
      setTty(true, true);
      expect(isInteractive()).toBe(true);
    });

    it('is false when only stdin is a TTY', () => {
      setTty(true, false);
      expect(isInteractive()).toBe(false);
    });

    it('is false when only stdout is a TTY', () => {
      setTty(false, true);
      expect(isInteractive()).toBe(false);
    });

    it('is false when neither stream is a TTY', () => {
      setTty(false, false);
      expect(isInteractive()).toBe(false);
    });
  });

  describe('getTermSize', () => {
    it('returns the live terminal size when available', () => {
      Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
      expect(getTermSize()).toEqual({ rows: 30, cols: 100 });
    });

    it('falls back to 24x80 when size is unavailable', () => {
      Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
      expect(getTermSize()).toEqual({ rows: 24, cols: 80 });
    });
  });

  describe('onResize', () => {
    // Fake stream with the same surface area the helper needs (on/off/rows/cols).
    // We never bind it to a real TTY — onResize is allowed by signature to take
    // any object that quacks like NodeJS.WriteStream.
    function makeFakeStream(
      rows = 24,
      cols = 80,
    ): {
      rows: number;
      columns: number;
      on: (ev: string, h: (...a: unknown[]) => void) => unknown;
      off: (ev: string, h: (...a: unknown[]) => void) => unknown;
      _listeners: Map<string, Set<(...a: unknown[]) => void>>;
      emit: (ev: string) => void;
    } {
      const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
      return {
        rows,
        columns: cols,
        on(ev, h) {
          let set = listeners.get(ev);
          if (!set) {
            set = new Set();
            listeners.set(ev, set);
          }
          set.add(h);
          return this;
        },
        off(ev, h) {
          listeners.get(ev)?.delete(h);
          return this;
        },
        _listeners: listeners,
        emit(ev) {
          for (const h of listeners.get(ev) ?? []) h();
        },
      };
    }

    it('registers a listener and calls cb on resize with the current size', () => {
      const stream = makeFakeStream(40, 120);
      const cb = vi.fn();
      const off = onResize(cb, stream as never as NodeJS.WriteStream);

      stream.rows = 50;
      stream.columns = 130;
      stream.emit('resize');

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ rows: 50, cols: 130 });

      off();
    });

    it('returns a cleanup that unregisters the listener', () => {
      const stream = makeFakeStream();
      const cb = vi.fn();
      const off = onResize(cb, stream as never as NodeJS.WriteStream);

      stream.emit('resize');
      expect(cb).toHaveBeenCalledTimes(1);

      off();
      stream.emit('resize');
      expect(cb).toHaveBeenCalledTimes(1); // unchanged
    });

    it('falls back to 24x80 when the stream has no size info', () => {
      const stream = makeFakeStream();
      // null overrides simulate "not yet known"
      stream.columns = null as never as number;
      stream.columns = null as number;
      const cb = vi.fn();
      onResize(cb, stream as never as NodeJS.WriteStream);

      stream.emit('resize');

      expect(cb).toHaveBeenCalledWith({ rows: 24, cols: 80 });
    });

    it('returns a no-op cleanup when stream is null/undefined', () => {
      const cb = vi.fn();
      const off = onResize(cb, null as never as NodeJS.WriteStream);

      // Must not throw, must not register anywhere
      expect(typeof off).toBe('function');
      expect(() => off()).not.toThrow();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('setRawMode', () => {
    function makeInput(isTTY: boolean | undefined = true, hasSetRawMode = true): NodeJS.ReadStream {
      return {
        isTTY,
        setRawMode: hasSetRawMode ? vi.fn() : undefined,
      } as never as NodeJS.ReadStream;
    }

    it('toggles raw mode on a TTY stream and returns true', () => {
      const input = makeInput(true);
      expect(setRawMode(input, true)).toBe(true);
      expect(input.setRawMode as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(true);
    });

    it('returns false (no throw) when stream is null/undefined', () => {
      expect(setRawMode(undefined as never as NodeJS.ReadStream, true)).toBe(false);
      expect(setRawMode(undefined as NodeJS.ReadStream, true)).toBe(false);
    });

    it('returns false (no throw) when stream is not a TTY (piped/redirected)', () => {
      const input = makeInput(false);
      expect(setRawMode(input, true)).toBe(false);
      // setRawMode must NOT have been called on a non-TTY stream
      expect(input.setRawMode as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('returns false when stream is a TTY but lacks setRawMode (Windows ConPTY edge case)', () => {
      const input = makeInput(true, false);
      expect(setRawMode(input, true)).toBe(false);
    });
  });

  describe('TerminalLifecycle', () => {
    function makeInput(paused: boolean): NodeJS.ReadStream & {
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      setRawMode: ReturnType<typeof vi.fn>;
    } {
      let isPaused = paused;
      const input = {
        isTTY: true,
        isRaw: false,
        isPaused: () => isPaused,
        pause: vi.fn(() => {
          isPaused = true;
          return input;
        }),
        resume: vi.fn(() => {
          isPaused = false;
          return input;
        }),
        setRawMode: vi.fn((raw: boolean) => {
          input.isRaw = raw;
          return input;
        }),
      };
      return input as never;
    }

    it('resumes stdin when taking over from a closed readline prompt', () => {
      const input = makeInput(true);
      const lifecycle = new TerminalLifecycle();

      expect(lifecycle.acquire(input)).toBe(true);
      expect(input.setRawMode).toHaveBeenCalledWith(true);
      expect(input.resume).toHaveBeenCalledOnce();
    });

    it('restores the paused state captured before TUI ownership', () => {
      const input = makeInput(true);
      const lifecycle = new TerminalLifecycle();

      lifecycle.acquire(input);
      lifecycle.release();

      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(input.pause).toHaveBeenCalledOnce();
    });

    it('does not pause a stream that was already active', () => {
      const input = makeInput(false);
      const lifecycle = new TerminalLifecycle();

      lifecycle.acquire(input);
      lifecycle.release();

      expect(input.pause).not.toHaveBeenCalled();
    });
  });

  describe('writeOut', () => {
    it('writes the string to the given stream and returns true', () => {
      const write = vi.fn();
      const stream = { write } as never as NodeJS.WriteStream;
      expect(writeOut('hello', stream)).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('hello');
    });

    it('defaults to process.stdout when no stream is supplied', () => {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        expect(writeOut('hi')).toBe(true);
        expect(write).toHaveBeenCalledWith('hi');
      } finally {
        write.mockRestore();
      }
    });

    it('returns false (no throw) when stream is null', () => {
      // (passing `undefined` triggers the default parameter and routes to
      // process.stdout — that is the documented behaviour, not a guard)
      expect(writeOut('x', null as never as NodeJS.WriteStream)).toBe(false);
    });

    it('returns false when stream lacks a callable write method', () => {
      const stream = { write: 'not-a-fn' } as never as NodeJS.WriteStream;
      expect(writeOut('x', stream)).toBe(false);
    });
  });

  describe('writeErr', () => {
    it('writes to the given stream and returns true', () => {
      const write = vi.fn();
      const stream = { write } as never as NodeJS.WriteStream;
      expect(writeErr('oops', stream)).toBe(true);
      expect(write).toHaveBeenCalledWith('oops');
    });

    it('defaults to process.stderr when no stream is supplied', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(writeErr('boom')).toBe(true);
        expect(write).toHaveBeenCalledWith('boom');
      } finally {
        write.mockRestore();
      }
    });

    it('returns false (no throw) when stream is null', () => {
      expect(writeErr('x', null as never as NodeJS.WriteStream)).toBe(false);
    });
  });

  describe('output line guard', () => {
    afterEach(() => setOutputLineGuard(null));

    it('passes writes straight through when no guard is installed', () => {
      const order: string[] = [];
      const stream = {
        write: (s: string) => {
          order.push(`write:${s}`);
          return true;
        },
      } as never as NodeJS.WriteStream;
      expect(writeErr('WARN telegram\n', stream)).toBe(true);
      expect(order).toEqual(['write:WARN telegram\n']);
    });

    it('brackets an out-of-band write with suspend()/resume() in order', () => {
      const order: string[] = [];
      setOutputLineGuard({
        suspend: () => order.push('suspend'),
        resume: () => order.push('resume'),
      });
      const stream = {
        write: (s: string) => {
          order.push(`write:${s}`);
          return true;
        },
      } as never as NodeJS.WriteStream;

      // Simulates a logger WARN landing while a readline prompt is live:
      // the draft row is cleared, the message prints, the prompt repaints.
      expect(writeErr('WARN telegram poll failed\n', stream)).toBe(true);
      expect(order).toEqual(['suspend', 'write:WARN telegram poll failed\n', 'resume']);
    });

    it('stops bracketing once the guard is cleared', () => {
      const order: string[] = [];
      setOutputLineGuard({
        suspend: () => order.push('suspend'),
        resume: () => order.push('resume'),
      });
      setOutputLineGuard(null);
      const stream = {
        write: (s: string) => {
          order.push(`write:${s}`);
          return true;
        },
      } as never as NodeJS.WriteStream;
      writeOut('plain\n', stream);
      expect(order).toEqual(['write:plain\n']);
    });

    it('does not invoke the guard when the stream is unwritable', () => {
      const suspend = vi.fn();
      const resume = vi.fn();
      setOutputLineGuard({ suspend, resume });
      expect(writeOut('x', null as never as NodeJS.WriteStream)).toBe(false);
      expect(suspend).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });
  });
});
