/**
 * Coverage for core/src/utils/term.ts — TTY detection, terminal helpers.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  isStdoutTTY,
  isStdinTTY,
  isInteractive,
  getTermSize,
  onResize,
  setRawMode,
  buildTitleSequence,
  buildSgrSequence,
  setTitle,
} from '../../src/utils/term.js';

describe('isStdoutTTY', () => {
  it('returns a boolean', () => {
    expect(typeof isStdoutTTY()).toBe('boolean');
  });
});

describe('isStdinTTY', () => {
  it('returns a boolean', () => {
    expect(typeof isStdinTTY()).toBe('boolean');
  });
});

describe('isInteractive', () => {
  it('returns a boolean', () => {
    expect(typeof isInteractive()).toBe('boolean');
  });
});

describe('getTermSize', () => {
  it('returns rows and cols', () => {
    const size = getTermSize();
    expect(typeof size.rows).toBe('number');
    expect(typeof size.cols).toBe('number');
    expect(size.rows).toBeGreaterThan(0);
    expect(size.cols).toBeGreaterThan(0);
  });
});

describe('onResize', () => {
  it('returns a cleanup function', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    Object.assign(stream, { rows: 24, columns: 80 });
    const cleanup = onResize(() => {}, stream);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('calls callback on resize event', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    Object.assign(stream, { rows: 24, columns: 80 });
    let captured: { rows: number; cols: number } | null = null;
    const cleanup = onResize((size) => {
      captured = size;
    }, stream);
    stream.emit('resize');
    expect(captured).toEqual({ rows: 24, cols: 80 });
    cleanup();
  });

  it('cleanup removes the listener', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    Object.assign(stream, { rows: 24, columns: 80 });
    let callCount = 0;
    const cleanup = onResize(() => {
      callCount++;
    }, stream);
    cleanup();
    stream.emit('resize');
    expect(callCount).toBe(0);
  });

  it('returns no-op for non-stream input', () => {
    const cleanup = onResize(() => {}, null as unknown as NodeJS.WriteStream);
    expect(typeof cleanup).toBe('function');
    cleanup();
  });
});

describe('setRawMode', () => {
  it('returns false for stream without setRawMode', () => {
    const stream = {} as NodeJS.ReadStream;
    expect(setRawMode(stream, true)).toBe(false);
  });

  it('returns false for stream without isTTY', () => {
    const stream = {
      setRawMode: vi.fn(),
      isTTY: false,
    } as unknown as NodeJS.ReadStream;
    expect(setRawMode(stream, true)).toBe(false);
  });

  it('returns true when setRawMode succeeds on TTY stream', () => {
    const stream = {
      setRawMode: vi.fn(),
      isTTY: true,
    } as unknown as NodeJS.ReadStream;
    expect(setRawMode(stream, true)).toBe(true);
    expect(stream.setRawMode).toHaveBeenCalledWith(true);
  });

  it('returns true when setRawMode with false mode on TTY stream', () => {
    const stream = {
      setRawMode: vi.fn(),
      isTTY: true,
    } as unknown as NodeJS.ReadStream;
    expect(setRawMode(stream, false)).toBe(true);
    expect(stream.setRawMode).toHaveBeenCalledWith(false);
  });
});

describe('buildTitleSequence', () => {
  it('builds an escape sequence object with raw and terminator', () => {
    const result = buildTitleSequence('My Title');
    expect(result.raw).toContain('My Title');
    expect(result.raw).toContain('\x1b]0;');
  });

  it('strips embedded BEL bytes from title', () => {
    const result = buildTitleSequence('Hello\x07World');
    expect(result.raw).toContain('HelloWorld');
    expect(result.raw).not.toContain('\x07');
  });
});

describe('buildSgrSequence', () => {
  it('builds an SGR escape sequence object from codes', () => {
    const result = buildSgrSequence(1, 31);
    expect(result.raw).toContain('\x1b[');
    expect(result.raw).toContain('1;31');
    expect(result.raw).toContain('m');
  });

  it('handles single code', () => {
    const result = buildSgrSequence(0);
    expect(result.raw).toContain('0');
  });

  it('handles empty codes', () => {
    const result = buildSgrSequence();
    expect(result.raw).toContain('\x1b[');
  });
});

describe('setTitle', () => {
  it('returns a boolean indicating success', () => {
    const result = setTitle('Terminal Title');
    expect(typeof result).toBe('boolean');
  });
});
