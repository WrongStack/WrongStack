import { expect, it } from 'vitest';
import { parseRange, type RangeParseError } from '../../src/policy/resolver.js';

it('reports an invalid range token at its offset in the original expression', () => {
  const input = '  ^1.0.0 || >=2.0.0 || bad';
  expect(() => parseRange(input)).toThrow(
    expect.objectContaining<Partial<RangeParseError>>({
      input,
      position: input.indexOf('bad'),
    }),
  );
});
