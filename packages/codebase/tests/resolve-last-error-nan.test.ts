import { describe, expect, it } from 'vitest';
import { resolveLastError } from '../src/background-indexer-policy.js';

describe('resolveLastError (F2181)', () => {
  it('treats non-finite remote.updatedAt as 0 so newer local errors are not hidden', () => {
    expect(resolveLastError({ lastError: null, updatedAt: Number.NaN }, 'local boom', 1000)).toBe(
      'local boom',
    );
    expect(
      resolveLastError({ lastError: 'remote boom', updatedAt: 2000 }, 'local boom', 1000),
    ).toBe('remote boom');
  });
});
