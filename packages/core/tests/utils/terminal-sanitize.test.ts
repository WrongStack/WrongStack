/**
 * `sanitizeTerminalText` is the gate between untrusted text and a TTY, and it
 * had no test file at all.
 *
 * The OSC and control-string patterns used a lazy `[\s\S]*?` scan for their
 * terminator. Lazy is not linear: for every introducer the engine walks
 * forward hunting the terminator, so input that is nothing but introducers is
 * O(n²). Measured before the fix: 565 ms at 64 KiB, 12.5 SECONDS at 256 KiB —
 * and 256 KiB is exactly the diff-render budget, with the permission prompt
 * sanitizing the body twice before clipping. A tool result could freeze the
 * approval prompt the user was about to answer.
 *
 * These tests pin both halves: the escapes are still stripped, and stripping
 * them stays fast enough that a hostile payload cannot wedge the UI.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeTerminalPreview, sanitizeTerminalText } from '../../src/utils/terminal-sanitize.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('sanitizeTerminalText', () => {
  it('strips a terminated OSC sequence', () => {
    expect(sanitizeTerminalText(`${ESC}]0;window title${BEL}rest`)).toBe('rest');
  });

  it('strips an OSC hyperlink terminated by ST', () => {
    expect(sanitizeTerminalText(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe('link');
  });

  it('strips a DCS control string', () => {
    expect(sanitizeTerminalText(`${ESC}Pq payload ${ESC}\\tail`)).toBe('tail');
  });

  it('strips the screen-clear + home payload that repaints over a prompt', () => {
    expect(sanitizeTerminalText(`${ESC}[2J${ESC}[Hfake prompt`)).toBe('fake prompt');
  });

  it('strips ESC c (RIS), the two-character full reset', () => {
    expect(sanitizeTerminalText(`${ESC}cafter`)).toBe('after');
  });

  it('removes carriage returns so a payload cannot overwrite a drawn line', () => {
    expect(sanitizeTerminalText('real\rfake')).toBe('realfake');
  });

  it('keeps newlines', () => {
    expect(sanitizeTerminalText('a\nb')).toBe('a\nb');
  });

  it('strips bidi and zero-width controls', () => {
    const trojan = `admin‮gnp.exe`;
    expect(sanitizeTerminalText(trojan)).toBe('admingnp.exe');
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeTerminalText('plain text 123 — ok')).toBe('plain text 123 — ok');
  });

  it('leaves no control characters behind when an OSC body carries a bare ESC', () => {
    // This body no longer matches the OSC pattern (the negated class stops at
    // the stray ESC), so the guarantee has to come from the later passes. The
    // text may survive as visible characters; control codes may not.
    const out = sanitizeTerminalText(`${ESC}]0;body ${ESC} stray${BEL}tail`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain('tail');
  });
});

describe('sanitizeTerminalText — ReDoS bound', () => {
  // Generous ceilings: the fixed implementation measures ~0.5 ms at 256 KiB,
  // so these fail only on a genuine return to super-linear scanning, not on a
  // slow machine or a cold JIT.
  it('handles 64 KiB of unterminated OSC introducers quickly', () => {
    const hostile = `${ESC}]`.repeat(32 * 1024);
    const started = performance.now();
    sanitizeTerminalText(hostile);
    expect(performance.now() - started).toBeLessThan(1_000); // was ~565 ms
  });

  it('handles 256 KiB of unterminated OSC introducers quickly', () => {
    const hostile = `${ESC}]`.repeat(128 * 1024);
    const started = performance.now();
    sanitizeTerminalText(hostile);
    expect(performance.now() - started).toBeLessThan(2_000); // was ~12,500 ms
  });

  it('handles unterminated DCS introducers quickly', () => {
    const hostile = `${ESC}P`.repeat(128 * 1024);
    const started = performance.now();
    sanitizeTerminalText(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('sanitizeTerminalPreview', () => {
  it('reports the full sanitized size so callers need no second pass', () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = sanitizeTerminalPreview(body, { maxLines: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text.split('\n')).toHaveLength(10);
    expect(result.sanitizedLines).toBe(100);
    expect(result.sanitizedLength).toBe(body.length);
  });

  it('reports sizes of the sanitized text, not the raw input', () => {
    const body = `${ESC}[31mred${ESC}[0m`;
    const result = sanitizeTerminalPreview(body);
    expect(result.sanitizedLength).toBe('red'.length);
    expect(result.truncated).toBe(false);
  });

  it('clips on characters as well as lines', () => {
    const result = sanitizeTerminalPreview('x'.repeat(50), { maxChars: 10 });
    expect(result.text).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.sanitizedLength).toBe(50);
  });
});
