import { describe, expect, it } from 'vitest';
import { compareAgentsByActivity } from '../src/lib/agent-status';

describe('compareAgentsByActivity non-finite startedAt', () => {
  it('returns a finite comparison order when startedAt is NaN', () => {
    const cmp = compareAgentsByActivity(
      { status: 'running', startedAt: Number.NaN },
      { status: 'running', startedAt: 20 },
    );
    expect(Number.isFinite(cmp)).toBe(true);
    expect(cmp).toBeGreaterThan(0);
  });
});
