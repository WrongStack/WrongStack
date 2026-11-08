/**
 * Regression tests for the shared `truncate` helper.
 *
 * Consolidated here from the former core implementation (commit 555046b61).
 * The contract every consumer (CLI status lines, log headers, agent-context
 * previews) relies on:
 * - input.length <= max → returned unchanged (no suffix, no padding)
 * - input.length >  max → capped to at most `max` characters, ending in the
 *   single U+2026 HORIZONTAL ELLIPSIS (never three ASCII periods — the 1
 *   codepoint ellipsis is what keeps the width math load-bearing)
 * - max <= 0 → '' (output never exceeds the cap; the old slice(0, max - 1)
 *   quirk returned a two-character string for max=0)
 * - the cut never splits a surrogate pair (an astral char straddling the cap
 *   is dropped whole — the repo-wide surrogate-safe truncation convention)
 */

import { describe, expect, it } from 'vitest';
import { safeParse, sanitizeJsonString } from '../src/safe-json.js';
import { truncate } from '../src/string.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('truncate', () => {
  it('returns the string unchanged when it fits under max', () => {
    expect(truncate('hi', 10)).toBe('hi');
    expect(truncate('hi', 2)).toBe('hi');
  });

  it('returns exact-fit strings unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends the single-codepoint ellipsis', () => {
    const out = truncate('hello world', 5);
    expect(out).toBe('hell…');
    expect(out.charCodeAt(4)).toBe(0x2026);
  });

  it('preserves exactly max characters when truncation fires', () => {
    const out = truncate('a-very-long-string-that-exceeds-the-cap', 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string for max of 0 or below', () => {
    expect(truncate('hi', 0)).toBe('');
    expect(truncate('hi', -3)).toBe('');
  });

  it('returns the bare ellipsis for max of 1', () => {
    expect(truncate('hi', 1)).toBe('…');
  });

  it('never splits a surrogate pair at the cut', () => {
    // U+1F600 straddles the cap: walk back and drop it whole.
    expect(truncate('a😀b', 3)).toBe('a…');
    expect(truncate('😀x', 2)).toBe('…');
    expect(truncate('ab😀c', 4)).toBe('ab…');
    for (const out of [truncate('a😀b', 3), truncate('😀x', 2), truncate('ab😀', 4)]) {
      expect(LONE_SURROGATE.test(out), `lone surrogate in ${JSON.stringify(out)}`).toBe(false);
    }
  });

  it('returns an exact-fit astral string unchanged', () => {
    expect(truncate('😀', 2)).toBe('😀');
  });

  it('handles NaN, Infinity, and fractional max values deterministically (F87)', () => {
    expect(truncate('hello', Number.NaN)).toBe('');
    expect(truncate('hello', Number.NEGATIVE_INFINITY)).toBe('');
    expect(truncate('hello', Number.POSITIVE_INFINITY)).toBe('hello');
    expect(truncate('😀abc', 1.9)).toBe('…');
    expect(truncate('😀abc', 2.9)).toBe('…');
    expect(truncate('😀abc', 3.9)).toBe('😀…');
  });

  it('strips CR-only line comments in sanitizeJsonString and normalizes invalid maxBytes in safeParse (F130)', () => {
    const crJson = sanitizeJsonString('{\r// comment\r"a": 1\r}');
    expect(crJson).not.toBeNull();
    expect(JSON.parse(crJson!)).toEqual({ a: 1 });
    expect(safeParse('{"a":1}', -10)).toEqual({ ok: true, value: { a: 1 } });
    expect(safeParse('{"a":1}', Number.NaN)).toEqual({ ok: true, value: { a: 1 } });
  });
});
