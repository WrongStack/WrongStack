import { describe, expect, it } from 'vitest';
import { jmespathSearch } from '../src/json-query.js';

const data = [
  { n: -1 },
  { n: 0 },
  { n: 1 },
  { n: null },
  { n: false },
  { n: true },
  { n: '' },
  { n: '-1' },
  { n: '0' },
  { n: '1' },
  { n: [] },
  { n: [-1] },
  { n: [0] },
  { n: [1] },
  { n: {} },
  {},
  null,
];

// JMESPath ordering comparisons accept numbers only, not JS numeric coercion.
describe('JSON ordering filters', () => {
  it.each([
    ['<', [{ n: -1 }]],
    ['<=', [{ n: -1 }, { n: 0 }]],
    ['>', [{ n: 1 }]],
    ['>=', [{ n: 0 }, { n: 1 }]],
  ])('excludes non-numeric fields for %s', (op, expected) => {
    expect(jmespathSearch(data, `[?n${op}\`0\`]`)).toEqual(expected);
  });

  it.each(['<', '<=', '>', '>='])('excludes non-numeric literals for %s', (op) => {
    for (const literal of ['`null`', '`false`', '`[]`', '`[0]`', '`"0"`', "'0'"]) {
      expect(jmespathSearch(data, `[?n${op}${literal}]`)).toEqual([]);
    }
  });

  it('keeps empty input and projections after a filter valid', () => {
    expect(jmespathSearch([], '[?n<=`0`]')).toEqual([]);
    expect(jmespathSearch(data, '[?n<=`0`].n')).toEqual([-1, 0]);
  });

  it('keeps numeric boundary and strict equality controls unchanged', () => {
    expect(jmespathSearch([{ n: -1 }, { n: 0 }, { n: 1 }], '[?n<=`0`]')).toEqual([
      { n: -1 },
      { n: 0 },
    ]);
    expect(jmespathSearch(data, '[?n==`"0"`]')).toEqual([{ n: '0' }]);
    expect(jmespathSearch([{ n: 0 }, { n: '0' }], '[?n!=`0`]')).toEqual([{ n: '0' }]);
  });

  it('blocks prototype-property keys in wildcard and filter queries (F224)', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      expect(jmespathSearch({}, `${key}[*]`)).toEqual([]);
      expect(jmespathSearch([{ a: 1 }], `[?${key}!=\`null\`]`)).toEqual([]);
    }
  });
});
