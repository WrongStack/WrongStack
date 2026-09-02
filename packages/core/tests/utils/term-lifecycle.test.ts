/**
 * Additional coverage for term.ts — TerminalLifecycle, safeEmit edge cases,
 * OutputLineGuard bracketing, onResize, setRawMode, and writeOut/writeErr
 * with guard interactions.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  type EscapeSequence,
  type OutputLineGuard,
  ESCAPE_TERMINATOR,
  TerminalLifecycle,
  buildSgrSequence,
  buildTitleSequence,
  detectTerminal,
  getTermSize,
  onResize,
  safeEmit,
  setOutputLineGuard,
  setRawMode,
  setTitle,
  writeErr,
  writeOut,
} from '../../src/utils/term.js';

// ── Mock stream helpers ──────────────────────────────────────────────────────

function mockWriteStream(overrides: Record<string, unknown> = {}): NodeJS.WriteStream {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    rows: 40,
    columns: 120,
    write: vi.fn(() => true),
    ...overrides,
  }) as never as NodeJS.WriteStream;
}

function mockReadStream(overrides: Record<string, unknown> = {}): NodeJS.ReadStream {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
    isPaused: vi.fn(() => false),
    resume: vi.fn(),
    pause: vi.fn(),
    ...overrides,
  }) as never as NodeJS.ReadStream;
}

// ── TerminalLifecycle ────────────────────────────────────────────────────────

describe('TerminalLifecycle', () => {
  it('acquire returns false for non-TTY stdin', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream({ isTTY: false });
    expect(lc.acquire(stdin)).toBe(false);
    expect(lc.active).toBe(false);
  });

  it('acquire returns false when setRawMode is missing', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream({ setRawMode: undefined });
    expect(lc.acquire(stdin)).toBe(false);
  });

  it('acquire sets raw mode and resumes stdin', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream();
    expect(lc.acquire(stdin)).toBe(true);
    expect(lc.active).toBe(true);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalled();
  });

  it('acquire is idempotent — second call returns false', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream();
    expect(lc.acquire(stdin)).toBe(true);
    expect(lc.acquire(stdin)).toBe(false);
  });

  it('release restores pre-TUI raw state', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream({ isRaw: false });
    lc.acquire(stdin);
    lc.release();
    expect(lc.active).toBe(false);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('release is idempotent', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream();
    lc.acquire(stdin);
    lc.release();
    lc.release(); // second call is a no-op
    expect(lc.active).toBe(false);
  });

  it('release pauses stdin when it was paused before acquire', () => {
    const lc = new TerminalLifecycle();
    const stdin = mockReadStream({ isPaused: vi.fn(() => true) });
    lc.acquire(stdin);
    lc.release();
    expect(stdin.pause).toHaveBeenCalled();
  });

  it('reset writes SGR reset, cursor show, and mouse off', () => {
    const lc = new TerminalLifecycle();
    const stdout = mockWriteStream();
    lc.reset(stdout);
    const writes = (stdout.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(writes).toContain('\x1b[0m');
    expect(writes).toContain('\x1b[?25h');
    expect(writes.join('')).toContain('\x1b[?1003l');
  });

  it('reset is safe on non-writable stream', () => {
    const lc = new TerminalLifecycle();
    const stdout = mockWriteStream({ write: undefined });
    expect(() => lc.reset(stdout)).not.toThrow();
  });

  it('requestExit calls onRequestExit callback', () => {
    const lc = new TerminalLifecycle();
    const cb = vi.fn();
    lc.onRequestExit = cb;
    lc.requestExit(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('requestExit is idempotent', () => {
    const lc = new TerminalLifecycle();
    const cb = vi.fn();
    lc.onRequestExit = cb;
    lc.requestExit(0);
    lc.requestExit(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── safeEmit ─────────────────────────────────────────────────────────────────

describe('safeEmit', () => {
  it('returns empty for empty string', () => {
    const result = safeEmit('', mockWriteStream());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('returns not_a_tty for non-TTY stream', () => {
    const result = safeEmit('\x1b[31m', mockWriteStream({ isTTY: false }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_a_tty');
  });

  it('writes CSI sequences directly', () => {
    const stdout = mockWriteStream();
    const result = safeEmit('\x1b[31m', stdout);
    expect(result.ok).toBe(true);
    expect(stdout.write).toHaveBeenCalledWith('\x1b[31m');
  });

  it('writes OSC sequences with terminator', () => {
    const stdout = mockWriteStream();
    const seq: EscapeSequence = { raw: '\x1b]0;title', terminator: ESCAPE_TERMINATOR.BEL };
    const result = safeEmit(seq, stdout);
    expect(result.ok).toBe(true);
    expect(stdout.write).toHaveBeenCalledWith('\x1b]0;title\x07');
  });

  it('appends BEL to OSC sequences missing a terminator', () => {
    const stdout = mockWriteStream();
    const seq: EscapeSequence = { raw: '\x1b]0;title' };
    const result = safeEmit(seq, stdout);
    expect(result.ok).toBe(true);
    expect(stdout.write).toHaveBeenCalledWith('\x1b]0;title\x07');
  });

  it('returns unwritable when write throws', () => {
    const stdout = mockWriteStream({
      write: vi.fn(() => {
        throw new Error('EPIPE');
      }),
    });
    const result = safeEmit('\x1b[31m', stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unwritable');
  });

  it('handles EscapeSequence objects for CSI', () => {
    const stdout = mockWriteStream();
    const seq = buildSgrSequence(1, 32);
    const result = safeEmit(seq, stdout);
    expect(result.ok).toBe(true);
    expect(stdout.write).toHaveBeenCalledWith('\x1b[1;32m');
  });
});

// ── buildTitleSequence / buildSgrSequence / setTitle ─────────────────────────

describe('sequence builders', () => {
  it('buildTitleSequence strips BEL from title', () => {
    const seq = buildTitleSequence('hello\x07world');
    expect(seq.raw).toBe('\x1b]0;helloworld');
    expect(seq.terminator).toBe(ESCAPE_TERMINATOR.BEL);
  });

  it('buildSgrSequence joins codes with semicolons', () => {
    const seq = buildSgrSequence(38, 2, 255, 128, 0);
    expect(seq.raw).toBe('\x1b[38;2;255;128;0m');
  });

  it('setTitle returns true on TTY', () => {
    const stdout = mockWriteStream();
    expect(setTitle('test', stdout)).toBe(true);
  });

  it('setTitle returns false on non-TTY', () => {
    const stdout = mockWriteStream({ isTTY: false });
    expect(setTitle('test', stdout)).toBe(false);
  });
});

// ── writeOut / writeErr with OutputLineGuard ─────────────────────────────────

describe('writeOut/writeErr with guard', () => {
  it('writeOut brackets writes with suspend/resume when guard is set', () => {
    const guard: OutputLineGuard = { suspend: vi.fn(), resume: vi.fn() };
    setOutputLineGuard(guard);
    const stdout = mockWriteStream();
    writeOut('hello', stdout);
    expect(guard.suspend).toHaveBeenCalledTimes(1);
    expect(guard.resume).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith('hello');
    setOutputLineGuard(null);
  });

  it('writeOut writes directly when no guard', () => {
    setOutputLineGuard(null);
    const stdout = mockWriteStream();
    writeOut('hello', stdout);
    expect(stdout.write).toHaveBeenCalledWith('hello');
  });

  it('writeOut returns false for stream without write method', () => {
    expect(writeOut('x', {} as never)).toBe(false);
  });

  it('writeErr writes to stderr by default', () => {
    setOutputLineGuard(null);
    // Just verify it doesn't throw — process.stderr is the default
    const result = writeErr('test error');
    expect(typeof result).toBe('boolean');
  });
});

// ── onResize ─────────────────────────────────────────────────────────────────

describe('onResize', () => {
  it('calls callback on resize events', () => {
    const stream = mockWriteStream();
    const sizes: Array<{ rows: number; cols: number }> = [];
    const cleanup = onResize((s) => sizes.push(s), stream);
    stream.emit('resize');
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toEqual({ rows: 40, cols: 120 });
    cleanup();
    stream.emit('resize');
    expect(sizes).toHaveLength(1); // no more calls after cleanup
  });

  it('returns no-op cleanup for non-stream input', () => {
    const cleanup = onResize(vi.fn(), null as never);
    expect(() => cleanup()).not.toThrow();
  });
});

// ── setRawMode ───────────────────────────────────────────────────────────────

describe('setRawMode', () => {
  it('returns true and sets raw mode on TTY', () => {
    const stdin = mockReadStream();
    expect(setRawMode(stdin, true)).toBe(true);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
  });

  it('returns false for non-TTY', () => {
    const stdin = mockReadStream({ isTTY: false });
    expect(setRawMode(stdin, true)).toBe(false);
  });

  it('returns false when setRawMode is missing', () => {
    const stdin = mockReadStream({ setRawMode: undefined });
    expect(setRawMode(stdin, true)).toBe(false);
  });
});

// ── detectTerminal ───────────────────────────────────────────────────────────

describe('detectTerminal', () => {
  it('detects a real TTY with color', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'xterm-256color' },
    });
    expect(cap.isRealTTY).toBe(true);
    expect(cap.colorDepth).toBe(2);
    expect(cap.mouseProtocol).toBe('sgr');
    expect(cap.canSetTitle).toBe(true);
  });

  it('returns 0 color for non-TTY', () => {
    const cap = detectTerminal({
      stdin: mockReadStream({ isTTY: false }),
      stdout: mockWriteStream({ isTTY: false }),
      env: { TERM: 'xterm-256color' },
    });
    expect(cap.isRealTTY).toBe(false);
    expect(cap.colorDepth).toBe(0);
  });

  it('respects FORCE_COLOR=0', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'xterm-256color', FORCE_COLOR: '0' },
    });
    expect(cap.colorDepth).toBe(0);
  });

  it('respects FORCE_COLOR for truecolor', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'xterm', FORCE_COLOR: '1' },
    });
    expect(cap.colorDepth).toBe(3);
  });

  it('respects NO_COLOR', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'xterm-256color', NO_COLOR: '1' },
    });
    expect(cap.colorDepth).toBe(0);
  });

  it('detects truecolor from COLORTERM', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'xterm', COLORTERM: 'truecolor' },
    });
    expect(cap.colorDepth).toBe(3);
  });

  it('detects dumb terminal', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'dumb' },
    });
    expect(cap.colorDepth).toBe(0);
    expect(cap.canSetTitle).toBe(false);
  });

  it('detects tmux', () => {
    const cap = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'tmux-256color' },
    });
    expect(cap.isTmux).toBe(true);
    expect(cap.mouseProtocol).toBe('sgr');
  });

  it('detects mouse protocols for various terminals', () => {
    const vt100 = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'vt100' },
    });
    expect(vt100.mouseProtocol).toBe('none');

    const rxvt = detectTerminal({
      stdin: mockReadStream(),
      stdout: mockWriteStream(),
      env: { TERM: 'rxvt' },
    });
    expect(rxvt.mouseProtocol).toBe('urxvt');
  });
});

// ── getTermSize ──────────────────────────────────────────────────────────────

describe('getTermSize', () => {
  it('returns fallback for non-TTY', () => {
    // In test environment, stdout may not be a TTY
    const size = getTermSize();
    expect(size.rows).toBeGreaterThan(0);
    expect(size.cols).toBeGreaterThan(0);
  });
});
