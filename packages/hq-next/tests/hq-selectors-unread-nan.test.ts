import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { unreadMailboxCount } from '../src/hq/data/selectors';

describe('unreadMailboxCount (F2169)', () => {
  it('returns 0 for NaN/negative values and floors positive counts', () => {
    expect(
      unreadMailboxCount({
        totals: { unreadMailboxMessages: Number.NaN },
      } as unknown as HqSnapshot),
    ).toBe(0);
    expect(
      unreadMailboxCount({ totals: { unreadMailboxMessages: -4 } } as unknown as HqSnapshot),
    ).toBe(0);
    expect(
      unreadMailboxCount({ totals: { unreadMailboxMessages: 3.7 } } as unknown as HqSnapshot),
    ).toBe(3);
  });
});
