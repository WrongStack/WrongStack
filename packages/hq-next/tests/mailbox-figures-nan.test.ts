import type { HqMailboxSummary } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { mailFigures } from '../src/features/mailbox/model';

describe('mailFigures non-finite count guards', () => {
  it('ignores NaN, Infinity, and negative counts when summing mailbox totals', () => {
    const res = mailFigures([
      {
        messageCount: 5,
        unreadCount: 2,
        incompleteCount: 1,
        highPriorityCount: 1,
        onlineAgentCount: 3,
      } as HqMailboxSummary,
      {
        messageCount: Number.NaN,
        unreadCount: -4,
        incompleteCount: Number.POSITIVE_INFINITY,
        highPriorityCount: 0,
        onlineAgentCount: 0,
      } as HqMailboxSummary,
    ]);
    expect(res.messages).toBe(5);
    expect(res.unread).toBe(2);
    expect(res.open).toBe(1);
  });
});
