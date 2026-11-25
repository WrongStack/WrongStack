import type { MailboxAgentStatus } from '@wrongstack/contracts/types/mailbox';
import { describe, expect, it } from 'vitest';
import { buildFleetPulseBlock } from '../src/core/fleet-pulse.js';

describe('buildFleetPulseBlock bounds and prototype safety', () => {
  it('clamps negative maxAgents to 0 instead of slicing from the end', () => {
    const peers: MailboxAgentStatus[] = [
      {
        agentId: 'a1',
        name: 'w1',
        online: true,
        status: 'running',
        toolCalls: 1,
      } as MailboxAgentStatus,
      {
        agentId: 'a2',
        name: 'w2',
        online: true,
        status: 'idle',
        toolCalls: 0,
      } as MailboxAgentStatus,
    ];
    const block = buildFleetPulseBlock(peers, { selfId: 'leader', maxAgents: -1 });
    expect(block?.text).not.toContain('• w1');
    expect(block?.text).toContain('+2 more');
  });
});
