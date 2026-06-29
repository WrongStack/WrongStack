import { describe, expect, it } from 'vitest';
import { feedPaste } from '../src/paste-accumulator.js';

const BEGIN = '\x1b[200~';
const END = '\x1b[201~';

describe('feedPaste', () => {
  it('returns null for ordinary input when idle', () => {
    expect(feedPaste(null, 'hello')).toBeNull();
    expect(feedPaste(null, 'a')).toBeNull();
  });

  it('assembles a single-event bracketed paste in one shot', () => {
    const res = feedPaste(null, `${BEGIN}line1\nline2${END}`);
    expect(res).toEqual({ accum: null, complete: 'line1\nline2' });
  });

  it('buffers a paste split across multiple events and finalizes on the end marker', () => {
    let accum: string | null = null;
    const r1 = feedPaste(accum, `${BEGIN}first chunk\n`);
    expect(r1).toEqual({ accum: 'first chunk\n', complete: null });
    accum = r1?.accum ?? null;

    const r2 = feedPaste(accum, 'middle chunk\n');
    expect(r2).toEqual({ accum: 'first chunk\nmiddle chunk\n', complete: null });
    accum = r2?.accum ?? null;

    const r3 = feedPaste(accum, `last chunk${END}`);
    expect(r3).toEqual({ accum: null, complete: 'first chunk\nmiddle chunk\nlast chunk' });
  });

  it('handles bare markers when the terminal/Ink dropped the ESC byte', () => {
    const res = feedPaste(null, '[200~pasted text[201~');
    expect(res).toEqual({ accum: null, complete: 'pasted text' });
  });

  it('treats a mid-paste fragment of just a newline as paste content, not Enter', () => {
    const r1 = feedPaste(null, `${BEGIN}a`);
    expect(r1?.complete).toBeNull();
    const r2 = feedPaste(r1?.accum ?? null, '\n');
    expect(r2).toEqual({ accum: 'a\n', complete: null });
    const r3 = feedPaste(r2?.accum ?? null, `b${END}`);
    expect(r3).toEqual({ accum: null, complete: 'a\nb' });
  });

  it('accumulates \\r (Windows CR) mid-paste same as \\n', () => {
    // Windows terminals send \r\n for newlines. Ink may split these into
    // separate events; feedPaste must accumulate \r as ordinary content.
    const r1 = feedPaste(null, `${BEGIN}hello`);
    expect(r1?.complete).toBeNull();
    const r2 = feedPaste(r1?.accum ?? null, '\r');
    expect(r2).toEqual({ accum: 'hello\r', complete: null });
    const r3 = feedPaste(r2?.accum ?? null, `world${END}`);
    expect(r3).toEqual({ accum: null, complete: 'hello\rworld' });
  });

  it('strips begin and end markers even when both arrive in the same later fragment', () => {
    const r1 = feedPaste(null, `${BEGIN}x`);
    const r2 = feedPaste(r1?.accum ?? null, `y${END}`);
    expect(r2).toEqual({ accum: null, complete: 'xy' });
  });

  // ── ANSI sequence stripping ─────────────────────────────────────────────

  it('strips ANSI SGR reset (ESC[0m) from pasted content', () => {
    // \x1b[0m = SGR reset. The escape sequence adds no visible characters.
    const res = feedPaste(null, `${BEGIN}hello\x1b[0mworld${END}`);
    expect(res?.complete).toBe('helloworld');
  });

  it('strips ANSI SGR codes (color) from pasted content', () => {
    // \x1b[31m = red. \x1b[0m = reset. No visible chars added.
    const res = feedPaste(null, `${BEGIN}\x1b[31mred\x1b[0mblue${END}`);
    expect(res?.complete).toBe('redblue');
  });

  it('strips ANSI cursor-position (H) sequences from pasted content', () => {
    const res = feedPaste(null, `${BEGIN}\x1b[Htop\x1b[Hbottom${END}`);
    expect(res?.complete).toBe('topbottom');
  });

  it('returns null for a bare partial ANSI CSI fragment starting with "["', () => {
    // A bare "[0m" (ESC was stripped from "\x1b[0m") should be treated as
    // mid-paste, not passed through as ordinary input.
    expect(feedPaste(null, '[0m')).toEqual({ accum: '', complete: null });
  });
});
