import { describe, expect, it } from 'vitest';
import { type AgentEntry, updateAgent } from '../src/lib/session-agents';

describe('updateAgent non-negative stats clamp (F1987)', () => {
  it('clamps negative cost, tokens, and iterations to 0', () => {
    const res = updateAgent(
      { agents: [] as AgentEntry[] },
      { subagentId: 'a1', kind: 'spawned', costUsd: -5, tokens: -100, iterations: -3 },
      'subagent.event',
    );
    expect(res.agents[0]?.costUsd).toBe(0);
    expect(res.agents[0]?.tokens).toBe(0);
    expect(res.agents[0]?.iterations).toBe(0);
  });
});
