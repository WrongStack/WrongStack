import type { HqAlert } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { episodes } from '../src/features/alerts/model';

describe('alerts episodes durationMs finite guard', () => {
  it('returns 0 durationMs instead of NaN when timestamps are non-finite', () => {
    const res = episodes(
      [{ id: 'a2', ruleId: 'r1', firstFiredAt: Number.NaN, lastFiredAt: 5000 } as HqAlert],
      [],
    );
    expect(res[0]?.durationMs).toBe(0);
  });
});
