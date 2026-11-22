import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { createAcpLeaderHost } from '../src/acp-leader/acp-leader-host-binding.js';

// The executor's single-call path rethrows a tool's exception. An approved call
// re-run through it must still settle the announced card and answer the caller,
// as core's own confirmed re-run does (agent-tools executeSingleWithDecision).
describe('ACP leader host: an approved call whose tool throws', () => {
  const tool = { name: 'write' } as Tool;

  it('settles the announced card as failed and answers with an error result', async () => {
    const events = new EventBus();
    const executed: Array<Record<string, unknown>> = [];
    events.on('tool.executed', (e) => executed.push(e as never));
    const host = createAcpLeaderHost({
      agent: {
        ctx: { session: { id: 's1' } },
        permission: {},
        perIterationOutputCapBytes: 1_000,
        toolExecutor: {
          executeBatch: async (uses: Array<{ input: unknown }>) => ({
            outputs: [{ result: { type: 'tool_confirm_pending', input: uses[0]?.input } }],
          }),
          executeTool: async () => {
            throw new Error('disk full');
          },
        },
      } as never,
      events,
      projectRoot: '/proj',
      getConfig: () => ({}) as Config,
      getTool: (name) => (name === 'write' ? tool : undefined),
    });

    const result = await host.runTool(
      'write',
      { path: 'a' },
      { announce: true, approve: async () => true },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('disk full');
    expect(executed).toEqual([
      expect.objectContaining({ name: 'write', ok: false, settlement: 'failed' }),
    ]);
  });
});
