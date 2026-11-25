import { describe, expect, it } from 'vitest';
import { truncateDelegateTask } from '../src/lib/delegate-format';

describe('truncateDelegateTask UTF-16 surrogate guard (F2304)', () => {
  it('does not split a surrogate pair when truncating with ellipsis', () => {
    const out = truncateDelegateTask('a🚀bcdef', 3);
    expect(out).toBe('a…');
  });
});
