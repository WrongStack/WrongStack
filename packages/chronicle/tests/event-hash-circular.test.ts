import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/event-hash.js';

describe('hashValue (F2185)', () => {
  it('handles circular references and BigInt without throwing while preserving DAG hashes', () => {
    const obj: Record<string, unknown> = { a: 1, big: 42n };
    obj.self = obj;
    expect(hashValue(obj)).toHaveLength(64);

    const shared = { x: 1 };
    expect(hashValue({ first: shared, second: shared })).toBe(
      hashValue({ first: { x: 1 }, second: { x: 1 } }),
    );
  });
});
