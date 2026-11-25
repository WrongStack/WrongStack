import { describe, expect, it } from 'vitest';
import { matchesPattern } from '../src/dep-guard/name-match.js';

describe('dep-guard matchesPattern whitespace and empty guards', () => {
  it('trims pattern whitespace and never matches empty names against wildcards', () => {
    expect(matchesPattern('evil-pkg', ' evil-pkg ', 'npm')).toBe(true);
    expect(matchesPattern('Evil_Pkg', ' evil-pkg ', 'PyPI')).toBe(true);
    expect(matchesPattern('', '*', 'npm')).toBe(false);
    expect(matchesPattern('pkg', '   ', 'npm')).toBe(false);
  });
});
