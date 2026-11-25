import { describe, expect, it } from 'vitest';
import { removeJsonPath } from '../src/utils/config-json.js';

describe('removeJsonPath (F2195)', () => {
  it('refuses fractional array indices instead of truncating and deleting index 0', () => {
    const obj = { arr: ['first', 'second'] };
    expect(removeJsonPath(obj, ['arr', 0.5])).toBe(false);
    expect(obj.arr).toEqual(['first', 'second']);

    expect(removeJsonPath(obj, ['arr', 0])).toBe(true);
    expect(obj.arr).toEqual(['second']);
  });
});
