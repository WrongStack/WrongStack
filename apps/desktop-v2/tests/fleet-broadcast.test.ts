import { describe, expect, it } from 'vitest';
import { broadcastSummary, broadcastTargets } from '../src/FleetBroadcast';

describe('fleet broadcast', () => {
  it('addresses only running runtimes (active or idle)', () => {
    const rows = [
      { sessionId: 'a', status: 'active' },
      { sessionId: 'b', status: 'stale' },
      { sessionId: 'c', status: 'idle' },
      { sessionId: 'd', status: 'lost' },
      { sessionId: 'e', status: 'closing' },
    ] as never[];
    expect(broadcastTargets(rows).map((row: { sessionId: string }) => row.sessionId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('reports delivery and names the sessions it could not reach', () => {
    expect(broadcastSummary(2, [])).toBe(
      'Delivered to 2 session mailboxes. Delivery does not confirm execution.',
    );
    expect(broadcastSummary(1, ['b'])).toBe(
      'Delivered to 1 session mailbox. Not delivered: b. Delivery does not confirm execution.',
    );
  });
});
