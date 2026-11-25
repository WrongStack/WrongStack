import { describe, expect, it } from 'vitest';
import { parsePdfPageRange } from '../src/pdf-text.js';

describe('parsePdfPageRange total validation', () => {
  it('throws on non-finite or negative total page counts', () => {
    expect(() => parsePdfPageRange(undefined, Number.NaN)).toThrow(/Invalid PDF page count/);
    expect(() => parsePdfPageRange('1-5', Number.NaN)).toThrow(/Invalid PDF page count/);
    expect(() => parsePdfPageRange(undefined, -1)).toThrow(/Invalid PDF page count/);
    expect(parsePdfPageRange('1-5', 10)).toEqual({ first: 1, last: 5 });
  });
});
