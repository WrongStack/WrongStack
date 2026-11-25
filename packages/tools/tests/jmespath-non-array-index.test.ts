import { describe, expect, it } from 'vitest';
import { jmespathSearch } from '../src/json-query.js';

describe('jmespathSearch array index guard', () => {
  it('returns undefined when indexing into non-array values like strings or objects', () => {
    expect(jmespathSearch(['a', 'b'], '[0]')).toBe('a');
    expect(jmespathSearch('hello', '[0]')).toBeUndefined();
    expect(jmespathSearch({ '0': 'secret' }, '[0]')).toBeUndefined();
    expect(jmespathSearch(null, '[0]')).toBeUndefined();
  });
});
