import { describe, expect, it } from 'vitest';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';

describe('AcpLeaderProvider concurrent model switch (F252)', () => {
  it('coalesces concurrent model switches and never orphans or double-closes sessions', async () => {
    const provider = new AcpLeaderProvider({
      bootConfig: { model: 'acp/agent-a' } as never,
      buildProvider: () => undefined,
    });

    let started = 0;
    let closed = 0;
    (
      provider as unknown as { startSession: (k: string, a: string) => Promise<unknown> }
    ).startSession = async (_key: string, agentId: string) => {
      started += 1;
      await new Promise((r) => setTimeout(r, 10));
      return {
        agentId,
        session: {
          close: async () => {
            closed += 1;
          },
        },
      };
    };

    const callSessionFor = (key: string, agentId: string) =>
      (
        provider as unknown as { sessionFor: (k: string, a: string) => Promise<unknown> }
      ).sessionFor(key, agentId);

    await callSessionFor('s1', 'agent-a');
    const [s1, s2] = await Promise.all([
      callSessionFor('s1', 'agent-b'),
      callSessionFor('s1', 'agent-b'),
    ]);
    await provider.closeAll();

    expect(s1).toBe(s2);
    expect(started).toBe(2);
    expect(closed).toBe(2);
    expect((provider as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });
});
