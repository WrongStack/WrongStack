import { describe, expect, it } from 'vitest';
import { sanitizeJsonString } from '../src/safe-json.js';

describe('JSON comment token boundaries', () => {
  it.each([
    '{"amount":1/**/2}',
    '{"amount":1/* split */e2}',
    '{"amount":1e/* split */2}',
    '{"amount":-/* split */1}',
    '{"value":tr/* split */ue}',
    '{"value":fa/* split */lse}',
    '{"value":nu/* split */ll}',
    '[1/* first *//* second */2]',
  ])('does not manufacture a token from %s', (input) => {
    expect(sanitizeJsonString(input)).toBeNull();
  });

  it.each([
    ['/* prefix */{"amount"/* key */:/* value */1/* end */,}/* suffix */', { amount: 1 }],
    ['[1/* first */,/* second */2,/* close */]', [1, 2]],
    [
      '{"value":"literal /* marker */ and // marker"}',
      { value: 'literal /* marker */ and // marker' },
    ],
    ['[1// line comment\n,2]', [1, 2]],
  ])('preserves values for valid comment placement in %s', (input, expected) => {
    const fixed = sanitizeJsonString(input);
    expect(fixed === null ? null : JSON.parse(fixed)).toEqual(expected);
  });

  it('still rejects an unterminated block comment', () => {
    expect(sanitizeJsonString('{"amount":1/* unfinished')).toBeNull();
  });
});
