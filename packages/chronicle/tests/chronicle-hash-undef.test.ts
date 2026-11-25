import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/event-hash.js';

describe('chronicle hashValue non-JSON primitives', () => {
  it('handles undefined and non-JSON object members without throwing', () => {
    expect(hashValue(undefined)).toBe(hashValue(null));
    expect(hashValue({ a: 1, fn: () => {} })).toBe(hashValue({ a: 1 }));
  });
});
