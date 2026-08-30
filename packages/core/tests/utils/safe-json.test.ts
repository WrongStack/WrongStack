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
  it('safeParse measures the limit in UTF-8 bytes', () => {
    const input = JSON.stringify('€€€€');
    expect(input.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(input, 'utf8')).toBeGreaterThan(10);
    expect(safeParse(input, 10).ok).toBe(false);
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
  it('sanitizeJsonString strips trailing commas', () => {
    expect(sanitizeJsonString('{"a":1,}')).toBe('{"a":1}');
    expect(sanitizeJsonString('[1,2,3,]')).toBe('[1,2,3]');
  });
  it('sanitizeJsonString strips block comments without skipping adjacent punctuation', () => {
    const fixed = sanitizeJsonString('{"a":1/* first */,"b":2,/* second */}');
    expect(JSON.parse(fixed!)).toEqual({ a: 1, b: 2 });
  });
  it('sanitizeJsonString preserves comment markers inside strings', () => {
    const raw = '{"url":"https://example.test/a/*b*/","note":"not // a comment"}';
    expect(JSON.parse(sanitizeJsonString(raw)!)).toEqual({
      url: 'https://example.test/a/*b*/',
      note: 'not // a comment',
    });
  });
  it('sanitizeJsonString handles escaped quotes before comments', () => {
    const raw = String.raw`{"text":"quoted: \\\" // still text",/* comment */"ok":true}`;
    expect(JSON.parse(sanitizeJsonString(raw)!)).toEqual({
      text: 'quoted: \\" // still text',
      ok: true,
    });
  });
  it('sanitizeJsonString rejects unterminated block comments', () => {
    expect(sanitizeJsonString('{"a":1/* unfinished')).toBe(null);
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
  it('sanitizeJsonString does not touch insignificant whitespace outside strings', () => {
    const raw = '{\n  "a": 1,\n  "b": 2\n}';
    expect(JSON.parse(sanitizeJsonString(raw)!)).toEqual({ a: 1, b: 2 });
  });
  it('sanitizeJsonString handles strings ending with escaped backslashes before control characters', () => {
    const raw = '{"path":"C:\\\\","code":"line1\nline2"}';
    const fixed = sanitizeJsonString(raw);
    expect(fixed).not.toBe(null);
    expect(JSON.parse(fixed!)).toEqual({ path: 'C:\\', code: 'line1\nline2' });
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
