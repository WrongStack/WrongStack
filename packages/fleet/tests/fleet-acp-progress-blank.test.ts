import { describe, expect, it } from 'vitest';
import { publishAcpLiveProgress } from '../src/acp-live-progress.js';

describe('publishAcpLiveProgress whitespace guards', () => {
  it('falls back to "tool" for blank kind and skips blank diff paths', () => {
    const fleetEvents: Array<{ payload?: { name?: string } }> = [];
    const hostEvents: Array<{ t: string; p: unknown }> = [];

    publishAcpLiveProgress({
      event: {
        type: 'tool_call',
        toolCall: { toolCallId: 't1', title: '   ', kind: '   ', rawInput: {} },
      } as never,
      subagentId: 's1',
      agentName: 'agent',
      fleet: { emit: (e) => fleetEvents.push(e as { payload?: { name?: string } }) },
      hostEvents: { emit: (t, p) => hostEvents.push({ t, p }) },
    });

    publishAcpLiveProgress({
      event: {
        type: 'diff',
        diff: { path: '   ', oldText: null, newText: 'hi' },
      } as never,
      subagentId: 's1',
      agentName: 'agent',
      hostEvents: { emit: (t, p) => hostEvents.push({ t, p }) },
    });

    expect(fleetEvents[0]?.payload?.name).toBe('tool');
    expect(hostEvents.some((e) => e.t === 'file.activity')).toBe(false);
  });
});
