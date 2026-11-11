import { EventEmitter } from 'node:events';
import { EventBus } from '@wrongstack/contracts/kernel';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import {
  createFrameDiffStdout,
  DEFAULT_FULL_REPAINT_MS,
  INK_FULL_FRAME_PREFIX,
  tuiFrameDiffEnabled,
} from '../src/frame-diff-stdout.js';
import { createAppJourney, createJourneyAgent } from './helpers/app-journey-harness.js';
import { type RealTtyView, renderRealTty } from './helpers/real-tty.js';

const ESC = '\x1b';

class FakeTerminal extends EventEmitter {
  isTTY = true;
  writes: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof cb === 'function') cb(null);
    return true;
  }
}

const asStream = (terminal: FakeTerminal): NodeJS.WriteStream =>
  terminal as unknown as NodeJS.WriteStream;

const frame = (lines: string[]): string => INK_FULL_FRAME_PREFIX + lines.join('\n');

/**
 * A small VT screen: enough of the terminal to say what a byte stream leaves
 * on the grid. Cursor addressing, the two erases the renderer uses, SGR
 * attributes (so an erase with a stray background shows up), and CR/LF.
 */
interface Sgr {
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}
const PLAIN: Sgr = {
  fg: '',
  bg: '',
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
};
const sgrKey = (s: Sgr): string =>
  `${s.fg}|${s.bg}|${Number(s.bold)}${Number(s.dim)}${Number(s.italic)}${Number(s.underline)}${Number(s.inverse)}${Number(s.strike)}`;

function applySgr(state: Sgr, params: number[]): Sgr {
  let next = { ...state };
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 3) next.italic = true;
    else if (code === 23) next.italic = false;
    else if (code === 4) next.underline = true;
    else if (code === 24) next.underline = false;
    else if (code === 7) next.inverse = true;
    else if (code === 27) next.inverse = false;
    else if (code === 9) next.strike = true;
    else if (code === 29) next.strike = false;
    else if (code === 39) next.fg = '';
    else if (code === 49) next.bg = '';
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      const span = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      const value = codes.slice(i, i + span).join(';');
      if (code === 38) next.fg = value;
      else next.bg = value;
      i += span - 1;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.bg = String(code);
  }
  return next;
}

class Screen {
  private cells: string[][];
  private row = 0;
  private col = 0;
  private sgr: Sgr = { ...PLAIN };
  constructor(
    private readonly columns: number,
    private readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => this.blankRow(PLAIN));
  }
  private blankRow(state: Sgr): string[] {
    return Array.from({ length: this.columns }, () => `${state.bg}\u0000 `);
  }
  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i] as string;
      if (ch === ESC && data[i + 1] === '[') {
        const match = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(data.slice(i));
        if (!match) throw new Error(`unparsed CSI at ${i}`);
        this.csi(match[1] as string, match[2] as string);
        i += match[0].length;
        continue;
      }
      if (ch === ESC && data[i + 1] === ']') {
        const end = data.slice(i).search(/\x07|\x1b\\/);
        if (end < 0) throw new Error('unterminated OSC');
        i += end + (data[i + end] === ESC ? 2 : 1);
        continue;
      }
      if (ch === '\n') {
        this.row = Math.min(this.rows - 1, this.row + 1);
        this.col = 0;
      } else if (ch === '\r') {
        this.col = 0;
      } else {
        const point = data.codePointAt(i) as number;
        const glyph = String.fromCodePoint(point);
        if (this.col < this.columns) {
          (this.cells[this.row] as string[])[this.col] = `${sgrKey(this.sgr)}\u0000${glyph}`;
          this.col += 1;
        }
        i += glyph.length;
        continue;
      }
      i += 1;
    }
  }
  private csi(params: string, final: string): void {
    if (params.startsWith('?')) return; // private modes do not touch the grid
    const nums = params === '' ? [] : params.split(';').map((p) => Number(p || 0));
    if (final === 'm') this.sgr = applySgr(this.sgr, nums);
    else if (final === 'H') {
      this.row = Math.min(this.rows - 1, Math.max(0, (nums[0] ?? 1) - 1));
      this.col = Math.min(this.columns - 1, Math.max(0, (nums[1] ?? 1) - 1));
    } else if (final === 'J') {
      if ((nums[0] ?? 0) !== 0) throw new Error(`unsupported ED ${params}`);
      const current = this.cells[this.row] as string[];
      for (let c = this.col; c < this.columns; c++) current[c] = `${this.sgr.bg}\u0000 `;
      for (let r = this.row + 1; r < this.rows; r++) this.cells[r] = this.blankRow(this.sgr);
    } else if (final === 'K') {
      if ((nums[0] ?? 0) !== 2) throw new Error(`unsupported EL ${params}`);
      this.cells[this.row] = this.blankRow(this.sgr);
    } else throw new Error(`unsupported CSI ${params}${final}`);
  }
  snapshot(): string {
    return this.cells.map((row) => row.join('\u0001')).join('\n');
  }
}

/** Deterministic PRNG so a failing sequence can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createFrameDiffStdout', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes the first frame whole, then only the rows that changed', () => {
    const terminal = new FakeTerminal(20, 3);
    const { stream } = createFrameDiffStdout(asStream(terminal), { now: () => 0 });

    stream.write(frame(['one', 'two', 'three']));
    expect(terminal.writes).toEqual([frame(['one', 'two', 'three'])]);

    stream.write(frame(['one', 'TWO', 'three']));
    expect(terminal.writes.at(-1)).toBe(`${ESC}[2;1H${ESC}[2KTWO`);

    stream.write(frame(['ONE', 'TWO', 'THREE']));
    expect(terminal.writes.at(-1)).toBe(`${ESC}[1;1H${ESC}[2KONE${ESC}[3;1H${ESC}[2KTHREE`);
    expect(terminal.writes).toHaveLength(3);
  });

  it('writes nothing for an unchanged frame and still calls back', () => {
    const terminal = new FakeTerminal(20, 2);
    const { stream } = createFrameDiffStdout(asStream(terminal), { now: () => 0 });
    stream.write(frame(['a', 'b']));
    const done = vi.fn();
    expect(stream.write(frame(['a', 'b']), done)).toBe(true);
    expect(terminal.writes).toHaveLength(1);
    expect(done).toHaveBeenCalledWith(null);
  });

  it('repaints whole after invalidate, a resize, or any grid-touching write', () => {
    const terminal = new FakeTerminal(20, 2);
    const handle = createFrameDiffStdout(asStream(terminal), { now: () => 0 });
    const next = (lines: string[]): string => {
      handle.stream.write(frame(lines));
      return terminal.writes.at(-1) as string;
    };
    next(['a', 'b']);

    handle.invalidate();
    expect(next(['a', 'c'])).toBe(frame(['a', 'c']));

    // A write that is not a frame and could draw on the grid.
    handle.stream.write(`${ESC}[2J`);
    expect(next(['a', 'd'])).toBe(frame(['a', 'd']));

    // The terminal changed size: row addresses mean something else now.
    terminal.columns = 30;
    expect(next(['a', 'e'])).toBe(frame(['a', 'e']));
    terminal.rows = 3;
    expect(next(['a', 'e', 'f'])).toBe(frame(['a', 'e', 'f']));
    // And diffing resumes at the new size.
    expect(next(['a', 'e', 'g'])).toBe(`${ESC}[3;1H${ESC}[2Kg`);
  });

  it('keeps diffing across writes that cannot change the grid', () => {
    const terminal = new FakeTerminal(20, 2);
    const { stream } = createFrameDiffStdout(asStream(terminal), { now: () => 0 });
    stream.write(frame(['a', 'b']));
    for (const neutral of [
      `${ESC}[?2026h`,
      `${ESC}[?2026l`,
      `${ESC}[?25l`,
      `${ESC}[?1000h${ESC}[?1006h`,
      `${ESC}]0;title\x07`,
      `${ESC}]52;c;AAAA${ESC}\\`,
      '\x07',
    ]) {
      stream.write(neutral);
      expect(terminal.writes.at(-1)).toBe(neutral);
    }
    stream.write(frame(['a', 'B']));
    expect(terminal.writes.at(-1)).toBe(`${ESC}[2;1H${ESC}[2KB`);
  });

  it('passes a frame taller than the viewport through and forgets it', () => {
    const terminal = new FakeTerminal(20, 2);
    const { stream } = createFrameDiffStdout(asStream(terminal), { now: () => 0 });
    stream.write(frame(['a', 'b']));
    const tall = frame(['a', 'b', 'c']);
    stream.write(tall);
    expect(terminal.writes.at(-1)).toBe(tall);
    // The scrolled screen is unknown, so the next frame is whole too.
    stream.write(frame(['a', 'x']));
    expect(terminal.writes.at(-1)).toBe(frame(['a', 'x']));
  });

  it('lets a whole frame through once per repaint interval', () => {
    const terminal = new FakeTerminal(20, 2);
    let clock = 0;
    const { stream } = createFrameDiffStdout(asStream(terminal), { now: () => clock });
    stream.write(frame(['a', 'b']));
    clock = DEFAULT_FULL_REPAINT_MS - 1;
    stream.write(frame(['a', 'c']));
    expect(terminal.writes.at(-1)).toBe(`${ESC}[2;1H${ESC}[2Kc`);
    clock = DEFAULT_FULL_REPAINT_MS;
    stream.write(frame(['a', 'd']));
    expect(terminal.writes.at(-1)).toBe(frame(['a', 'd']));
  });

  it('exposes the terminal it wraps and can be switched off', () => {
    const terminal = new FakeTerminal(40, 12);
    const { stream } = createFrameDiffStdout(asStream(terminal));
    expect(stream.columns).toBe(40);
    expect(stream.rows).toBe(12);
    expect(stream.isTTY).toBe(true);
    const onResize = vi.fn();
    stream.on('resize', onResize);
    terminal.emit('resize');
    expect(onResize).toHaveBeenCalledOnce();

    expect(createFrameDiffStdout(asStream(terminal), { enabled: false }).stream).toBe(terminal);
    expect(tuiFrameDiffEnabled()).toBe(true);
    vi.stubEnv('WRONGSTACK_TUI_FRAME_DIFF', '0');
    expect(tuiFrameDiffEnabled()).toBe(false);
  });

  it('leaves the same screen as whole-frame writes over random styled frames', () => {
    const columns = 24;
    const rows = 8;
    const styles = ['', `${ESC}[1m`, `${ESC}[38;2;200;50;10m`, `${ESC}[48;5;22m`, `${ESC}[7m`];
    const ends = ['', `${ESC}[22m`, `${ESC}[39m`, `${ESC}[49m`, `${ESC}[27m`];
    for (const seed of [1, 7, 42, 1337]) {
      const random = mulberry32(seed);
      const pick = (n: number): number => Math.floor(random() * n);
      const makeLine = (): string => {
        const width = pick(columns + 1);
        let line = '';
        let used = 0;
        while (used < width) {
          const style = pick(styles.length);
          const run = Math.min(width - used, 1 + pick(6));
          line += `${styles[style]}${'abcdefghij─│█ '.slice(pick(10)).slice(0, 1).repeat(run)}${ends[style]}`;
          used += run;
        }
        return line;
      };

      const diffed = new FakeTerminal(columns, rows);
      const whole = new FakeTerminal(columns, rows);
      let clock = 0;
      const { stream } = createFrameDiffStdout(asStream(diffed), { now: () => clock });
      const diffedScreen = new Screen(columns, rows);
      const wholeScreen = new Screen(columns, rows);

      let lines = Array.from({ length: rows }, makeLine);
      for (let step = 0; step < 150; step++) {
        lines = lines.map((line) => (pick(4) === 0 ? makeLine() : line));
        clock += pick(40);
        const before = diffed.writes.length;
        stream.write(frame(lines));
        whole.write(frame(lines));
        for (const chunk of diffed.writes.slice(before)) diffedScreen.feed(chunk);
        wholeScreen.feed(whole.writes.at(-1) as string);
        expect(diffedScreen.snapshot(), `seed ${seed} step ${step}`).toBe(wholeScreen.snapshot());
      }
      const bytes = (terminal: FakeTerminal): number =>
        terminal.writes.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(bytes(diffed)).toBeLessThan(bytes(whole));
    }
  });
});

describe('frame diffing real App frames', () => {
  let view: RealTtyView | undefined;

  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  it('reproduces every App frame exactly while writing far fewer bytes', async () => {
    const columns = 100;
    const rows = 36;
    const journey = createAppJourney(createJourneyAgent());
    const events = new EventBus();
    const mounted = renderRealTty(
      React.createElement(App, { ...journey.props, events, enhanceEnabled: false }),
      { columns, rows },
    );
    view = mounted;
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(300);
    // A stream, some typing, and a committed reply: the frames a session produces.
    for (let i = 0; i < 12; i++) {
      events.emit('provider.text_delta', { text: `streamed **line** ${i}\n` } as never);
      if (i % 3 === 0) mounted.stdin.write(String.fromCharCode(97 + i));
      await wait(30);
    }
    events.emit('provider.response', {
      content: [{ type: 'text', text: 'a committed `reply` with a list\n\n- one\n- two' }],
      stopReason: 'end_turn',
    } as never);
    await wait(300);

    // Debug-mode Ink hands over each frame bare; put Ink's Windows full-frame
    // prefix on it, which is the write the differ sees in production.
    const frames = mounted.stdout.frames.filter((raw) => raw.split('\n').length === rows);
    expect(frames.length).toBeGreaterThan(10);

    const diffed = new FakeTerminal(columns, rows);
    let clock = 0;
    const { stream } = createFrameDiffStdout(asStream(diffed), { now: () => clock });
    const diffedScreen = new Screen(columns, rows);
    const wholeScreen = new Screen(columns, rows);
    let wholeBytes = 0;
    frames.forEach((raw, index) => {
      clock += 33;
      const before = diffed.writes.length;
      stream.write(INK_FULL_FRAME_PREFIX + raw);
      for (const chunk of diffed.writes.slice(before)) diffedScreen.feed(chunk);
      wholeScreen.feed(INK_FULL_FRAME_PREFIX + raw);
      wholeBytes += INK_FULL_FRAME_PREFIX.length + raw.length;
      expect(diffedScreen.snapshot(), `frame ${index}`).toBe(wholeScreen.snapshot());
    });
    const diffedBytes = diffed.writes.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(diffedBytes).toBeLessThan(wholeBytes / 2);
  });
});
