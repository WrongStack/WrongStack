import { describe, expect, it } from 'vitest';
import { TaskAuctioneer } from '../src/task-auctioneer.js';

describe('TaskAuctioneer bidWindowMs clamping (F393)', () => {
  it('clamps bidWindowMs above 32-bit signed max instead of firing in 1ms', async () => {
    let evaluated = false;
    const auctioneer = new TaskAuctioneer({
      graph: { getGoals: () => [], getGoal: () => null } as never,
      fleet: { filter: () => () => {}, emit: () => {} } as never,
      mailbox: { send: async () => {} } as never,
      bidWindowMs: 3_000_000_000,
    });
    (auctioneer as unknown as { _evaluateBids: () => Promise<void> })._evaluateBids = async () => {
      evaluated = true;
    };

    try {
      (auctioneer as unknown as { _startBidWindow: (id: string) => void })._startBidWindow(
        'task-1',
      );
      await new Promise((r) => setTimeout(r, 40));
      expect(evaluated).toBe(false);
    } finally {
      auctioneer.dispose();
    }
  });
});
