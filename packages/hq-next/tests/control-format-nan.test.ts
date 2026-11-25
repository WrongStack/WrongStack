import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/hq/domain/control-format';

describe('relativeTime non-finite now guard', () => {
  it('falls back to Date.now() when now is NaN', () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    expect(relativeTime(recent, Number.NaN)).toMatch(/s ago$/);
  });
});
