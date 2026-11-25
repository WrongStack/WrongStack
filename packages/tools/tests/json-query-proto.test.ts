import { describe, expect, it } from 'vitest';
import { jmespathSearch } from '../src/json-query.js';

describe('jmespathSearch own-property access', () => {
  it('does not read inherited prototype properties in multi-select or filters', () => {
    const protoObj = Object.create({ arr: [{ x: 1 }] });
    expect(jmespathSearch(protoObj, 'arr[*].x')).toEqual([]);
    expect(jmespathSearch({ arr: [{ x: 1 }] }, 'arr[*].x')).toEqual([1]);
    expect(jmespathSearch([{ a: 1 }], "[?toString=='x']")).toEqual([]);
  });
});
