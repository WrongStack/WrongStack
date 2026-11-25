import { describe, expect, it } from 'vitest';
import { withLiveKanbanPresence } from '../src/manager/presence.js';

describe('withLiveKanbanPresence invalid Date guard (F2233)', () => {
  it('falls back to Date.now() when now is an invalid Date', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const board = {
      id: 'b1',
      presence: [
        {
          id: 's1:a1',
          sessionId: 's1',
          agentId: 'a1',
          firstSeenAt: future,
          lastSeenAt: future,
          activeUntil: future,
          active: true,
        },
      ],
    } as unknown as Parameters<typeof withLiveKanbanPresence>[0];

    const result = withLiveKanbanPresence(board, new Date('not-a-date'));
    expect(result.presence?.[0]?.active).toBe(true);
  });
});
