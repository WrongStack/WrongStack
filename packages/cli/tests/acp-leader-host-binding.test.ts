/**
 * The host an ACP leader runs on: each session's fleet calls and permission
 * checks go to that session's own agent (a WebUI tab's), and a call the policy
 * wants confirmed runs once the user approved it — asked once, not twice.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAcpLeaderSessionAgents } from '../src/acp-leader/acp-leader-host.js';
import { createAcpLeaderHost } from '../src/acp-leader/acp-leader-host-binding.js';

const DELEGATE = { name: 'delegate' } as Tool;

function fakeAgent(name: string, pending: boolean) {
  const ran: string[] = [];
  return {
    ran,
    agent: {
      ctx: { name },
      permission: { name },
      perIterationOutputCapBytes: 1_000,
      toolExecutor: {
        executeBatch: vi.fn(async (uses: Array<{ id: string; input: unknown }>) => {
          if (pending) {
            return {
              outputs: [{ result: { type: 'tool_confirm_pending', input: uses[0]?.input } }],
            };
          }
          ran.push(`batch ${name}`);
          return {
            outputs: [
              { result: { type: 'tool_result', content: `ran on ${name}`, is_error: false } },
            ],
          };
        }),
        executeTool: vi.fn(async () => {
          ran.push(`approved ${name}`);
          return { block: { type: 'tool_result', content: `approved on ${name}` }, bytes: 0 };
        }),
      },
    },
  };
}

function host(leader: ReturnType<typeof fakeAgent>, events = new EventBus()) {
  return createAcpLeaderHost({
    agent: leader.agent as never,
    events,
    projectRoot: '/proj',
    getConfig: () => ({}) as Config,
    getTool: (name) => (name === 'delegate' ? DELEGATE : undefined),
  });
}

afterEach(() => setAcpLeaderSessionAgents(undefined));

describe('the ACP leader host', () => {
  it("runs a session's fleet call on that session's agent, the leader's otherwise", async () => {
    const leader = fakeAgent('leader', false);
    const tab = fakeAgent('tab-2', false);
    setAcpLeaderSessionAgents((id) => (id === 'tab-2' ? (tab.agent as never) : undefined));
    const h = host(leader);

    await expect(h.runTool('delegate', { task: 'x' }, { sessionId: 'tab-2' })).resolves.toEqual({
      content: 'ran on tab-2',
      isError: false,
    });
    await h.runTool('delegate', { task: 'x' }, { sessionId: 'unknown' });
    expect(tab.ran).toEqual(['batch tab-2']);
    expect(leader.ran).toEqual(['batch leader']);
    expect(h.context('tab-2')).toBe(tab.agent.ctx);
    expect(h.permission('tab-2')).toBe(tab.agent.permission);
  });

  it('runs a call the policy wants confirmed only once it is approved', async () => {
    const leader = fakeAgent('leader', true);
    const h = host(leader);
    const approve = vi.fn(async () => true);

    await expect(h.runTool('delegate', { task: 'x' }, { approve })).resolves.toEqual({
      content: 'approved on leader',
      isError: false,
    });
    expect(approve).toHaveBeenCalledWith(DELEGATE, { task: 'x' });

    await expect(
      h.runTool('delegate', { task: 'x' }, { approve: async () => false }),
    ).resolves.toEqual({ content: 'delegate was not approved by the user.', isError: true });
    // No way to ask: refused, never run.
    await expect(h.runTool('delegate', { task: 'x' })).resolves.toMatchObject({ isError: true });
    expect(leader.ran).toEqual(['approved leader']);
  });

  // A WrongForge leader's `wstack_*` call: the executor announced it with
  // `tool.started`, and no tool_result or provider card ever settles it.
  it('settles the tool card of an announced call, and only of one', async () => {
    const events = new EventBus();
    const executed: Array<Record<string, unknown>> = [];
    events.on('tool.executed', (e) => executed.push(e as never));
    const leader = fakeAgent('leader', false);
    const h = host(leader, events);

    await h.runTool('delegate', { task: 'x' });
    expect(executed).toEqual([]);

    await h.runTool('delegate', { task: 'x' }, { announce: true });
    const batchUse = leader.agent.toolExecutor.executeBatch.mock.calls[1]?.[0]?.[0];
    expect(executed).toEqual([
      expect.objectContaining({
        id: batchUse?.id,
        name: 'delegate',
        ok: true,
        settlement: 'completed',
        outsideConversation: true,
        output: 'ran on leader',
        input: { task: 'x' },
      }),
    ]);

    const refused = host(fakeAgent('leader', true), events);
    await refused.runTool(
      'delegate',
      { task: 'x' },
      { announce: true, approve: async () => false },
    );
    expect(executed[1]).toMatchObject({ ok: false, settlement: 'declined' });
  });
});
