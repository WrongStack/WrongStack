import { describe, expect, it } from 'vitest';
import { formatLocations } from '../src/formatters/location.js';

describe('formatLocations non-finite range coordinate guard', () => {
  it('clamps non-finite line and character coordinates to 0 instead of emitting NaN', () => {
    const out = formatLocations(
      {
        uri: 'file:///a.ts',
        range: {
          start: { line: Number.NaN, character: Number.NaN },
          end: { line: 0, character: 1 },
        },
      },
      '/',
    );
    expect(out).not.toContain('NaN');
    expect(out).toMatch(/:1:1$/);
  });
});
