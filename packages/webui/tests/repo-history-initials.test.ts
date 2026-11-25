import { describe, expect, it } from 'vitest';
import { initials } from '../src/components/repository-history-model';

describe('initials whitespace trimming', () => {
  it('trims outer whitespace before extracting up to two initials', () => {
    expect(initials('  Alice Bob  ')).toBe('AB');
    expect(initials('   ')).toBe('');
  });
});
