import { describe, expect, it } from 'vitest';
import { deepMerge } from '../../src/utils/deep-merge.js';

describe('deepMerge nested prototype-pollution protection', () => {
  it('strips forbidden prototype keys inside newly introduced nested objects', () => {
    const patch = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true},"constructor":{"x":1},"safe":2}}',
    ) as Record<string, unknown>;
    const merged = deepMerge({}, patch) as { nested: Record<string, unknown> };
    expect(Object.hasOwn(merged.nested, '__proto__')).toBe(false);
    expect(Object.hasOwn(merged.nested, 'constructor')).toBe(false);
    expect(merged.nested.safe).toBe(2);
  });
});
