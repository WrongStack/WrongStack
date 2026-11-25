import { describe, expect, it } from 'vitest';
import { subscribeSubagentStatus } from '../src/agent-status-subagents.js';

describe('subscribeSubagentStatus non-finite/negative metrics guard (F2225)', () => {
  it('ignores non-finite or negative iteration/toolCalls/costUsd values', () => {
    const handlers = new Map<string, (e: string, payload: unknown) => void>();
    const host = {
      agents: new Map(),
      subagentPendingTools: new Map(),
      flush: () => {},
    };
    subscribeSubagentStatus(
      host as unknown as Parameters<typeof subscribeSubagentStatus>[0],
      (p, fn) => {
        handlers.set(p, fn);
        return () => {};
      },
    );

    handlers.get('subagent.iteration_summary')?.('subagent.iteration_summary', {
      subagentId: 'sa-1',
      iteration: Number.NaN,
      toolCalls: -5,
      costUsd: Number.POSITIVE_INFINITY,
    });

    const entry = host.agents.get('sa-1') as {
      iterations: number;
      toolCalls: number;
      costUsd?: number;
    };
    expect(entry.iterations).toBe(0);
    expect(entry.toolCalls).toBe(0);
    expect(entry.costUsd).toBeUndefined();

    handlers.get('subagent.iteration_summary')?.('subagent.iteration_summary', {
      subagentId: 'sa-1',
      iteration: 3,
      toolCalls: 7,
      costUsd: 0.12,
    });
    expect(entry.iterations).toBe(3);
    expect(entry.toolCalls).toBe(7);
    expect(entry.costUsd).toBe(0.12);
  });
});
