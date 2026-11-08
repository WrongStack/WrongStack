import { describe, expect, it } from 'vitest';
import { sanitizeJsonString } from '../src/safe-json.js';

const parseSanitized = (input: string): unknown => JSON.parse(sanitizeJsonString(input) ?? 'null');

describe('JSON repair respects ECMAScript line-comment terminators', () => {
  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'preserves the property following a comment terminated by %j',
    (separator) => {
      const input = `{"safe":true,// comment${separator}"enabled":false\n}`;
      expect(parseSanitized(input)).toEqual({ safe: true, enabled: false });
    },
  );

  it.each(['\u2028', '\u2029'])(
    'keeps the closing brace after %j without a later newline',
    (separator) => {
      expect(parseSanitized(`{"a":1// comment${separator}}`)).toEqual({ a: 1 });
    },
  );

  it.each(['\u2028', '\u2029'])('does not join number fragments across %j', (separator) => {
    expect(sanitizeJsonString(`1// comment${separator}2`)).toBeNull();
  });

  it.each(['\u2028', '\u2029'])('preserves %j and comment markers inside a string', (separator) => {
    const value = `before//not a comment${separator}after`;
    expect(parseSanitized(JSON.stringify({ value }))).toEqual({ value });
  });

  it('retains CRLF and end-of-input comment handling', () => {
    expect(parseSanitized('{"a":1,// comment\r\n"b":2}')).toEqual({ a: 1, b: 2 });
    expect(parseSanitized('{"a":1}// final comment')).toEqual({ a: 1 });
  });
});
