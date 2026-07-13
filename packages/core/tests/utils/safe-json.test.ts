import { describe, expect, it } from 'vitest';
import {
  safeParse,
  safeStringify,
  sanitizeJsonString,
  stripCodeFences,
} from '../../src/utils/safe-json.js';

describe('safe-json', () => {
  it('safeParse returns value on valid', () => {
    const r = safeParse<{ a: number }>('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });
  it('safeParse returns error on invalid', () => {
    const r = safeParse('{not json}');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
  it('safeParse rejects oversized input', () => {
    const r = safeParse('x'.repeat(100), 10);
    expect(r.ok).toBe(false);
  });
  it('safeParse maxBytes uses byte length, not char length', () => {
    // '€' is 3 bytes in UTF-8, so 4 of them = 12 bytes > 10-byte limit
    const r = safeParse('€€€€', 10);
    expect(r.ok).toBe(false);
  });
  it('safeParse allows input when byte length is within limit', () => {
    // 4 chars * 1 byte each = 4 bytes < 10-byte limit
    const r = safeParse('"abc"', 10);
    expect(r.ok).toBe(true);
  });
  it('safeStringify handles circular refs', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = safeStringify(obj);
    expect(out).toContain('[Circular]');
  });
  it('safeStringify handles BigInt', () => {
    const out = safeStringify({ n: 9007199254740993n });
    expect(out).toContain('9007199254740993');
  });
  it('safeStringify handles Error', () => {
    const out = safeStringify({ err: new Error('boom') });
    expect(out).toContain('boom');
  });
  it('safeStringify survives non-extensible objects', () => {
    const obj = Object.preventExtensions({ a: 1 });
    const out = safeStringify(obj);
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });
  it('sanitizeJsonString strips trailing commas', () => {
    expect(sanitizeJsonString('{"a":1,}')).toBe('{"a":1}');
    expect(sanitizeJsonString('[1,2,3,]')).toBe('[1,2,3]');
  });
  it('sanitizeJsonString returns null for unrecoverable input', () => {
    expect(sanitizeJsonString('{not json at all}')).toBe(null);
    expect(sanitizeJsonString('{"a":1]')).toBe(null); // mismatched bracket
  });
  it('sanitizeJsonString escapes literal newlines inside string values', () => {
    // The classic edit-tool failure: a code payload with a raw newline.
    const raw = '{"old_string":"line1\nline2"}';
    const fixed = sanitizeJsonString(raw);
    expect(fixed).not.toBe(null);
    expect(JSON.parse(fixed!)).toEqual({ old_string: 'line1\nline2' });
  });
  it('sanitizeJsonString escapes tabs and carriage returns inside strings', () => {
    const raw = '{"code":"a\tb\r\nc"}';
    const fixed = sanitizeJsonString(raw);
    expect(JSON.parse(fixed!)).toEqual({ code: 'a\tb\r\nc' });
  });
  it('sanitizeJsonString leaves already-escaped sequences intact', () => {
    const raw = '{"code":"line1\\nline2"}';
    expect(JSON.parse(sanitizeJsonString(raw)!)).toEqual({ code: 'line1\nline2' });
  });
  it('sanitizeJsonString strips single-line JSON5 comments', () => {
    const raw = `{
  // this is a comment
  "a": 1,
  "b": 2 // trailing comment
}`;
    const fixed = sanitizeJsonString(raw);
    expect(fixed).not.toBe(null);
    expect(JSON.parse(fixed!)).toEqual({ a: 1, b: 2 });
  });

  it('sanitizeJsonString strips block comments outside strings', () => {
    const raw = `{
  /* multi-line
     block comment */
  "a": 1,
  /* another one */ "b": 2
}`;
    const fixed = sanitizeJsonString(raw);
    expect(fixed).not.toBe(null);
    expect(JSON.parse(fixed!)).toEqual({ a: 1, b: 2 });
  });

  it('sanitizeJsonString does not strip // or /* inside string values', () => {
    const raw = '{"url":"https://example.com","code":"/* not a comment */"}';
    const fixed = sanitizeJsonString(raw);
    expect(fixed).not.toBe(null);
    expect(JSON.parse(fixed!)).toEqual({
      url: 'https://example.com',
      code: '/* not a comment */',
    });
  });

  it('sanitizeJsonString handles unterminated block comment gracefully', () => {
    // Unterminated /* ... consumes rest — over-stripping is safer than leaking
    const raw = '{"a":1,/* unterminated\n"b":2}';
    const fixed = sanitizeJsonString(raw);
    // With /* consumed to end, "b":2 never appears → can't be valid JSON
    expect(fixed).toBe(null);
  });

  it('sanitizeJsonString does not touch insignificant whitespace outside strings', () => {
    const raw = '{\n  "a": 1,\n  "b": 2\n}';
    expect(JSON.parse(sanitizeJsonString(raw)!)).toEqual({ a: 1, b: 2 });
  });

  describe('stripCodeFences', () => {
    it('strips a ```json fence with closer', () => {
      expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('strips a bare ``` fence', () => {
      expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('strips a fence whose closer is missing (truncated stream)', () => {
      expect(stripCodeFences('```json\n{"a":1')).toBe('{"a":1');
    });
    it('strips a single-line fence without newlines', () => {
      expect(stripCodeFences('```{"a":1}```')).toBe('{"a":1}');
    });
    it('tolerates surrounding whitespace', () => {
      expect(stripCodeFences('  ```json\n{"a":1}\n```  ')).toBe('{"a":1}');
    });
    it('extracts the first complete fenced block embedded in prose', () => {
      expect(stripCodeFences('Args below:\n```json\n{"a":1}\n```\nthanks')).toBe('{"a":1}');
    });
    it('returns null when no fence is present', () => {
      expect(stripCodeFences('{"a":1}')).toBe(null);
      expect(stripCodeFences('plain text')).toBe(null);
    });
  });
});
