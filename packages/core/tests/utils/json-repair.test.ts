import { describe, expect, it } from 'vitest';
import { completePartialObject } from '../../src/utils/json-repair.js';

describe('completePartialObject', () => {
  it('returns input unchanged when it is valid JSON', () => {
    expect(completePartialObject('{"a":1}')).toBe('{"a":1}');
    expect(completePartialObject('{"a":1,"b":"hello"}')).toBe('{"a":1,"b":"hello"}');
  });

  it('returns input unchanged when it does not start with {', () => {
    expect(completePartialObject('not json')).toBe('not json');
    expect(completePartialObject('[1,2,3]')).toBe('[1,2,3]');
    expect(completePartialObject('')).toBe('');
  });

  // ── Brace-closing ────────────────────────────────────────────────────────────

  it('closes a single unclosed brace', () => {
    expect(completePartialObject('{"a":1')).toBe('{"a":1}');
  });

  it('closes multiple unclosed braces for nested objects', () => {
    expect(completePartialObject('{"a":{"b":1')).toBe('{"a":{"b":1}}');
  });

  it('closes deeply nested objects (3+ levels)', () => {
    expect(completePartialObject('{"a":{"b":{"c":true')).toBe('{"a":{"b":{"c":true}}}');
  });

  it('does not add extra braces when all are already closed', () => {
    expect(completePartialObject('{"a":1}')).toBe('{"a":1}');
  });

  // ── String-closing ───────────────────────────────────────────────────────────

  it('closes an unclosed double-quoted string value', () => {
    expect(completePartialObject('{"a":"hello')).toBe('{"a":"hello"}');
  });

  it('closes unclosed string plus unclosed object', () => {
    // Use a variable to hold strings containing literal newlines
    const input = `{"old_string":"line1\nline2`;
    const expected = `{"old_string":"line1\nline2"}`;
    expect(completePartialObject(input)).toBe(expected);
  });

  it('handles a string containing a colon inside', () => {
    const input = '{"url":"http://example.com';
    const expected = '{"url":"http://example.com"}';
    expect(completePartialObject(input)).toBe(expected);
  });

  it('handles a string containing commas inside', () => {
    const input = '{"tags":"a,b,c"}'.slice(0, -1); // remove final quote to truncate
    const expected = '{"tags":"a,b,c"}';
    expect(completePartialObject(input)).toBe(expected);
  });

  // ── Escape sequences ─────────────────────────────────────────────────────────

  it('does not treat an escaped quote as a string terminator', () => {
    const input = '{"msg":"hello\\"world';
    const expected = '{"msg":"hello\\"world"}';
    expect(completePartialObject(input)).toBe(expected);
  });

  it('handles a string ending with an incomplete escape sequence', () => {
    // trailing backslash at end of input — strip it and close
    const input = '{"path":"C:\\Users"}'.slice(0, -1);
    const expected = '{"path":"C:\\Users"}';
    expect(completePartialObject(input)).toBe(expected);
  });

  it('handles deeply escaped content without false positives', () => {
    // \\n in JS source = literal \n in the string = valid JSON escape for newline
    const input = '{"old_string":"line1\\nline2\\nline3","new_string":"replaced\\ncontent"}';
    expect(completePartialObject(input)).toBe(input);
  });

  // ── Truncated multi-field object ────────────────────────────────────────────

  it('closes an incomplete two-field object', () => {
    const input = `{"path":"foo.txt","old_string":"line1\nline2`;
    const expected = `{"path":"foo.txt","old_string":"line1\nline2"}`;
    expect(completePartialObject(input)).toBe(expected);
  });

  it('closes a truncated object with a number at the end', () => {
    const input = '{"timeout":}';
    // Repair should close the value to null
    const result = completePartialObject(input);
    const parsed = JSON.parse(result);
    expect(parsed.timeout).toBeNull();
  });

  it('closes a truncated object with a boolean at the end', () => {
    const input = '{"recursive":}';
    const result = completePartialObject(input);
    const parsed = JSON.parse(result);
    expect(parsed.recursive).toBeNull();
  });

  it('closes a truncated object with null at the end', () => {
    expect(completePartialObject('{"value":null')).toBe('{"value":null}');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  it('handles whitespace at the end before truncation', () => {
    expect(completePartialObject('{"a":"hello"  ')).toBe('{"a":"hello"}');
  });

  it('repairs the classic edit-tool truncation case (unclosed string)', () => {
    // The streaming got cut mid-string — old_string value has no closing quote
    const truncated = '{"path":"src/app.tsx","old_string":"line1\\nline2';
    const expected = '{"path":"src/app.tsx","old_string":"line1\\nline2"}';
    expect(completePartialObject(truncated)).toBe(expected);
  });

  it('repairs a truncation in the middle of a string with nested braces', () => {
    const truncated = '{"edit":{"old_string":"a{"';
    // The string value `a{` is complete (closed by the trailing quote); both
    // open objects are then closed. Result is valid JSON.
    const expected = '{"edit":{"old_string":"a{"}}';
    expect(completePartialObject(truncated)).toBe(expected);
    expect(() => JSON.parse(expected)).not.toThrow();
  });

  it('returns the original when nothing useful can be done', () => {
    expect(completePartialObject('{')).toBe('{');
  });

  it('handles number in a field value at the end', () => {
    expect(completePartialObject('{"port":80')).toBe('{"port":80}');
  });

  it('handles array value truncation', () => {
    expect(completePartialObject('{"files":["a","b"')).toBe('{"files":["a","b"]}');
  });

  it('strips trailing backslash before closing string', () => {
    // C:\ — trailing invalid escape (`\}`) at end of path string. It can't be
    // completed into valid JSON, so the bogus escape is stripped and the string
    // closed cleanly.
    const input = '{"path":"C:\\}';
    const expected = '{"path":"C:"}';
    expect(completePartialObject(input)).toBe(expected);
    expect(() => JSON.parse(expected)).not.toThrow();
  });
});
