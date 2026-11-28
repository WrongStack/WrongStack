import type { SubagentView } from '@wrongstack/project-surfaces/office/types';
import { describe, expect, it } from 'vitest';
import { agentFacts, fleetSummary } from '../src/agent-facts';

const view = (id: string, extra: Partial<SubagentView> = {}) =>
  ({
    id,
    name: id,
    status: 'running',
    iteration: 1,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: 0,
    toolLog: [],
    sparklineBins: [],
    ...extra,
  }) as SubagentView;

describe('agent facts', () => {
  it('reads model, compact tokens, tool calls and context share when known', () => {
    expect(
      agentFacts(
        view('a', {
          model: 'opus-5-5',
          tokensIn: 160_000,
          tokensOut: 7_000,
          toolCalls: 45,
          ctxPct: 42.4,
          maxContext: 200_000,
        }),
      ),
    ).toEqual({ model: 'opus-5-5', tokens: '167K', tools: 45, context: 42 });
    // No window reported: no context bar, rather than an empty one.
    expect(agentFacts(view('b'))).toEqual({
      model: undefined,
      tokens: undefined,
      tools: 0,
      context: undefined,
    });
    expect(agentFacts(undefined)).toBeUndefined();
  });

  it('counts working and settled agents without the leader, and sums the fleet tokens', () => {
    const agents = [
      view('leader', { isLeader: true }),
      view('a'),
      view('b', { status: 'completed' }),
      view('c', { status: 'failed' }),
    ];
    expect(fleetSummary(agents, 'leader', 500_000, 7_000)).toEqual({
      working: 1,
      settled: 2,
      tokens: '507K',
    });
    expect(fleetSummary([], undefined, 0, 0)).toEqual({
      working: 0,
      settled: 0,
      tokens: undefined,
    });
  });
});
