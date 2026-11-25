import { describe, expect, it } from 'vitest';
import { normalizeBoundaryPath } from '../src/boundary.js';

describe('normalizeBoundaryPath non-string guard', () => {
  it('returns null instead of throwing TypeError on non-string input', () => {
    expect(normalizeBoundaryPath(undefined as never)).toBeNull();
    expect(normalizeBoundaryPath('src/app.ts')).toBe('src/app.ts');
  });
});
