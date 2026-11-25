import { describe, expect, it } from 'vitest';
import { satisfies } from '../src/plugin/loader-semver.js';

describe('loader-semver empty union branches', () => {
  it('does not treat empty || branches as wildcard matches', () => {
    expect(satisfies('1.0.0 || 2.0.0', '2.0.0')).toBe(true);
    expect(satisfies('1.0.0 || ', '9.9.9')).toBe(false);
    expect(satisfies(' || 1.0.0', '9.9.9')).toBe(false);
    expect(satisfies('||', '9.9.9')).toBe(false);
  });
});
