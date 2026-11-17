/**
 * `icons = ascii` (the `fallback` profile) against the Nerd profile it replaces:
 * same keys, same cell widths, nothing a common monospace font lacks, nothing
 * in the private-use area, and the automation-visible prompt untouched.
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayWidth } from '../src/terminal-width.js';
import { toolGlyphSet } from '../src/tool-glyph.js';
import { glyphSet, isBrowserSafeGlyph } from '../src/ui-glyphs.js';

const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

const nerd = glyphSet('nerd');
const ascii = glyphSet('fallback');
const nerdTools = toolGlyphSet('nerd');
const asciiTools = toolGlyphSet('fallback');

describe('icons = ascii glyph profile', () => {
  it('has exactly the Nerd profile keys', () => {
    expect(Object.keys(ascii).sort()).toEqual(Object.keys(nerd).sort());
    expect(Object.keys(asciiTools).sort()).toEqual(Object.keys(nerdTools).sort());
  });

  it('gives every glyph the cell width of its Nerd counterpart', () => {
    for (const [key, value] of Object.entries(nerd)) {
      const replacement = ascii[key as keyof typeof ascii];
      expect(displayWidth(replacement), `${key}: ${value} -> ${replacement}`).toBe(
        displayWidth(value),
      );
    }
    for (const [id, value] of Object.entries(nerdTools)) {
      const replacement = asciiTools[id as keyof typeof asciiTools];
      expect(displayWidth(replacement), `tool ${id}`).toBe(displayWidth(value));
    }
  });

  it('writes no private-use code point', () => {
    for (const [key, value] of [...Object.entries(ascii), ...Object.entries(asciiTools)]) {
      expect(PRIVATE_USE.test(value), key).toBe(false);
    }
  });

  it('uses only characters common monospace fonts have, except the prompt', () => {
    for (const [key, value] of [...Object.entries(ascii), ...Object.entries(asciiTools)]) {
      if (key === 'prompt') continue;
      expect(isBrowserSafeGlyph(value), `${key} (${value})`).toBe(true);
    }
  });

  it('replaces every Nerd icon and Powerline separator', () => {
    const replaced = Object.entries(nerd).filter(([, value]) => PRIVATE_USE.test(value));
    expect(replaced.length).toBeGreaterThan(20);
    expect([ascii.segmentStart, ascii.segmentTransition, ascii.segmentEnd]).toEqual([
      '◖',
      '▶',
      '◗',
    ]);
  });

  it('keeps what the input box draws as non-Nerd terminals always saw it', () => {
    // `prompt` and `brand` are the only glyphs the input box reads; the
    // permission prompt reads none.
    expect(ascii.prompt).toBe('❯');
    expect(ascii.brand).toBe(glyphSet('unicode').brand);
  });

  it('keeps glyphs that were already safe exactly as Nerd draws them', () => {
    for (const [key, value] of Object.entries(nerd)) {
      if (!isBrowserSafeGlyph(value)) continue;
      expect(ascii[key as keyof typeof ascii], key).toBe(value);
    }
  });
});

describe('private-use code points in TUI source', () => {
  // A Nerd glyph written anywhere but the two Nerd tables would bypass the
  // icons setting and reach a terminal without the font as an empty box.
  const SRC = path.resolve(import.meta.dirname, '../src');
  const NERD_TABLES = new Set(['ui-glyphs.ts', 'tool-glyph.ts']);
  /** A literal private-use character, or a JS escape naming one. */
  const PRIVATE_USE_SOURCE = new RegExp(
    String.raw`${PRIVATE_USE.source}|\\u(?:E[0-9a-f]{3}|F[0-8][0-9a-f]{2}|\{(?:F[0-9a-f]{4}|10[0-9a-f]{4})\})`,
    'iu',
  );

  it('appear only in the Nerd tables', () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((file) =>
      /\.tsx?$/.test(file),
    );
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources
      .filter((file) => !NERD_TABLES.has(file))
      .filter((file) => PRIVATE_USE_SOURCE.test(readFileSync(path.join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scan recognises every way a private-use glyph can be written', () => {
    const escaped = [
      String.raw`\uE0B0`,
      String.raw`\u{F0379}`,
      String.raw`\u{f09d1}`,
      String.fromCodePoint(0xf0328),
    ];
    for (const sample of escaped) expect(PRIVATE_USE_SOURCE.test(sample), sample).toBe(true);
    expect(PRIVATE_USE_SOURCE.test(String.raw`\u2713 ✓ ◆ ❯`)).toBe(false);
  });
});
