import { describe, expect, it } from 'vitest';
import { parseParserOutput } from '../src/parser-output.js';

describe('parser output numeric boundaries', () => {
  it('normalizes non-finite symbol and reference coordinates', () => {
    const parsed = parseParserOutput(
      '{"symbols":[{"name":"x","kind":"fn","line":1e999,"col":1e999}],"refs":[{"toName":"y","callType":"call","line":1e999}]}',
      'ts',
    );
    expect([parsed.symbols[0]?.line, parsed.symbols[0]?.col, parsed.refs[0]?.line]).toEqual([
      1, 0, 1,
    ]);
  });
});
