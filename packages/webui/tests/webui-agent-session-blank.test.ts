import { describe, expect, it } from 'vitest';
import { agentBelongsToSession } from '../src/lib/agent-session';

describe('agentBelongsToSession blank sessionId guard (F2303)', () => {
  it('treats whitespace-only sessionId as unset and trims valid ids', () => {
    expect(agentBelongsToSession(undefined, '   ')).toBe(true);
    expect(agentBelongsToSession(undefined, 's1')).toBe(false);
    expect(agentBelongsToSession('s1', ' s1 ')).toBe(true);
  });
});
