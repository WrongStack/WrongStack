import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/utils/slug.js';

describe('slugify', () => {
  // slugify is the canonical "string → filesystem/URL-safe slug" helper
  // used as the stable dedup + registry key for prompts (per the
  // function's docstring). Wrong behavior here = prompt collisions /
  // file-system double-saves. The function has three knobs:
  //   - lowercase + collapse non-alphanumeric to single hyphen
  //   - trim leading/trailing hyphens
  //   - cap at maxLen, then re-trim trailing hyphens
  //   - fall back to `fallback` if the result is the empty string
  //
  // The tests below pin each of these in isolation and in combination.

  it('lowercases input', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses runs of non-alphanumeric chars to a single hyphen', () => {
    expect(slugify('foo   bar')).toBe('foo-bar');
    expect(slugify('foo___bar')).toBe('foo-bar');
    expect(slugify('foo -_- bar')).toBe('foo-bar');
    expect(slugify('foo!@#$bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---foo---')).toBe('foo');
    expect(slugify('  spaces  ')).toBe('spaces');
    expect(slugify('!@#special$%^')).toBe('special');
  });

  it('falls back to the default when the result is empty', () => {
    // All non-alphanumeric; the empty post-slugify result triggers the
    // fallback to the default 'prompt' value.
    expect(slugify('!@#$%^')).toBe('prompt');
  });

  it('honors a custom fallback when the result is empty', () => {
    expect(slugify('!@#$%^', 'my-fallback')).toBe('my-fallback');
  });

  it('caps the result at maxLen', () => {
    const out = slugify('a'.repeat(100));
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).toBe('a'.repeat(64));
  });

  it('passes through short input unchanged modulo lowercasing', () => {
    expect(slugify('hello')).toBe('hello');
    expect(slugify('Hello')).toBe('hello');
  });

  it('treats the cap as inclusive (a 64-char input produces a 64-char output)', () => {
    expect(slugify('a'.repeat(64)).length).toBe(64);
  });

  it('handles non-string inputs safely by returning fallback', () => {
    expect(slugify(undefined as unknown as string)).toBe('prompt');
    expect(slugify(null as unknown as string, 'custom')).toBe('custom');
  });
});
