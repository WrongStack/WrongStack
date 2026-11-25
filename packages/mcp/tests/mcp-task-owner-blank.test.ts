import { describe, expect, it } from 'vitest';
import { taskOwner } from '../src/task-identity.js';

describe('taskOwner blank identifier guard (F2236)', () => {
  it('rejects whitespace-only sessionId/agentId and trims valid identifiers', () => {
    expect(
      taskOwner({
        session: { id: '   ' },
        agentId: '  \t ',
      } as unknown as Parameters<typeof taskOwner>[0]),
    ).toBeUndefined();

    expect(
      taskOwner({
        session: { id: ' s1 ' },
        agentId: ' a1 ',
      } as unknown as Parameters<typeof taskOwner>[0]),
    ).toEqual({ sessionId: 's1', agentId: 'a1' });
  });
});
