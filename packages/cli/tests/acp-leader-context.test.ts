/**
 * The ACP leader's context comes from the agent: its `usage_update` readings
 * (shown live, as the window grows over a long turn), a compaction's result,
 * and `/compact`, which the agent runs on its own conversation. The turn's
 * usage stays the summed spend; the context rides beside it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, StreamEvent } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const acp = vi.hoisted(() => ({
  prompts: [] as string[],
  opened: [] as string[],
  turn: undefined as ((onProgress: (e: unknown) => void) => Promise<void>) | undefined,
  result: {} as Record<string, unknown>,
}));

vi.mock('@wrongstack/acp', () => ({
  textContent: (text: string) => ({ type: 'text', text }),
  findAgentDescriptor: (id: string) =>
    id === 'claude-code' ? { id, contextWindow: 1_000_000 } : undefined,
  resolveAcpAgentCommand: (id: string) => ({ command: 'npx', args: ['adapter'], role: id }),
  classifyAgentFailure: () => undefined,
  ACPSession: {
    start: async (opts: { resumeSessionId?: string }) => ({
      openSession: async () => {
        acp.opened.push(opts.resumeSessionId ?? 'new');
        return opts.resumeSessionId
          ? { sessionId: opts.resumeSessionId, resumed: true }
          : { sessionId: `sess_${acp.opened.length}`, resumed: false };
      },
      prompt: async (
        blocks: Array<{ text: string }>,
        _signal: AbortSignal,
        onProgress: (e: unknown) => void,
      ) => {
        acp.prompts.push(blocks[0]?.text ?? '');
        await acp.turn?.(onProgress);
        return {
          text: 'ok',
          stopReason: 'end_turn',
          toolCalls: [],
          diffs: [],
          thoughts: '',
          hasText: true,
          ...acp.result,
        };
      },
      canSteer: () => false,
      close: async () => {},
    }),
  },
}));

const { bindAcpLeaderHost } = await import('../src/acp-leader/acp-leader-host.js');
const { AcpLeaderProvider } = await import('../src/acp-leader/acp-leader-provider.js');
const { LeaderContext } = await import('../src/acp-leader/acp-leader-context.js');
const { earlierConversation } = await import('../src/acp-leader/acp-leader-stream.js');

const SIGNAL = new AbortController().signal;
const CONFIG = { model: 'claude-code', acp: {} } as unknown as Config;

function setup() {
  const events = new EventBus();
  const fills: Array<{ tokens: number; maxContext: number }> = [];
  events.on('ctx.pct', (e) => fills.push({ tokens: e.tokens, maxContext: e.maxContext }));
  bindAcpLeaderHost({
    events,
    projectRoot: '/proj',
    getConfig: () => CONFIG,
    permission: () =>
      ({ evaluate: async () => ({ permission: 'auto', source: 'default' }) }) as never,
    context: () => ({}) as never,
    getTool: () => undefined,
    runTool: async () => ({ content: '', isError: false }),
  });
  const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
  return { provider, fills };
}

async function turn(provider: InstanceType<typeof AcpLeaderProvider>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  const req = {
    model: 'claude-code',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
    cache: { sessionId: 's1', threadId: 's1' },
  };
  for await (const ev of provider.stream(req as never, { signal: SIGNAL })) out.push(ev);
  return out;
}

afterEach(() => {
  acp.prompts.length = 0;
  acp.opened.length = 0;
  acp.turn = undefined;
  acp.result = {};
  bindAcpLeaderHost(undefined);
});

describe("the ACP leader's context", () => {
  it('keeps its own context, shows each reading live, and ends the turn with the last one', async () => {
    const { provider, fills } = setup();
    expect(provider.capabilities.keepsOwnContext).toBe(true);
    acp.turn = async (onProgress) => {
      onProgress({ type: 'usage', usage: { used: 30_000, size: 200_000 } });
      onProgress({ type: 'usage', usage: { used: 55_000, size: 200_000 } });
    };
    acp.result = {
      usage: { used: 55_000, size: 200_000 },
      tokens: { input: 900, output: 400, cacheRead: 300_000, cacheWrite: 2_000 },
    };

    const events = await turn(provider);

    expect(fills.map((f) => f.tokens)).toEqual([30_000, 55_000, 55_000]);
    // The agent's window replaces the catalog's guess (1M) for this agent.
    expect(provider.capabilities.maxContext).toBe(200_000);
    expect(events.at(-1)).toMatchObject({
      type: 'message_stop',
      usage: { input: 900, output: 400, cacheRead: 300_000 },
      agentContext: { used: 55_000, size: 200_000 },
    });
    await provider.closeAll();
  });

  it('starts a new text block after each tool call, as a reply after a tool result would', async () => {
    const { provider } = setup();
    acp.turn = async (onProgress) => {
      onProgress({ type: 'message', text: 'Let me read it.' });
      onProgress({
        type: 'tool_call',
        toolCall: { toolCallId: 't1', title: 'Read a.ts', status: 'pending', rawInput: { p: 1 } },
      });
      onProgress({ type: 'message', text: 'Fixed.' });
    };

    const events = await turn(provider);

    expect(events.map((e) => (e.type === 'text_delta' ? `text ${e.text}` : e.type))).toEqual([
      'message_start',
      'content_block_start',
      'text Let me read it.',
      'content_block_stop',
      'content_block_start',
      'text Fixed.',
      'content_block_stop',
      'message_stop',
    ]);
    await provider.closeAll();
  });

  it('follows a compaction the agent ran mid-turn', async () => {
    const { provider, fills } = setup();
    acp.turn = async (onProgress) => {
      onProgress({ type: 'usage', usage: { used: 180_000, size: 200_000 } });
      onProgress({
        type: 'tool_call_update',
        toolCall: {
          toolCallId: 'c1',
          title: 'Compact conversation',
          status: 'completed',
          rawOutput: { trigger: 'automatic', preTokens: 180_000, postTokens: 12_000 },
        },
      });
    };

    const events = await turn(provider);

    expect(fills.at(-1)).toEqual({ tokens: 12_000, maxContext: 200_000 });
    expect(events.at(-1)).toMatchObject({ agentContext: { used: 12_000, size: 200_000 } });
    await provider.closeAll();
  });

  it('/compact runs on the agent, and is a no-op before the agent has started', async () => {
    const { provider } = setup();
    await expect(
      provider.compactOwnContext({ sessionId: 's1', signal: SIGNAL }),
    ).resolves.toBeUndefined();
    expect(acp.prompts).toEqual([]);

    acp.turn = async (onProgress) =>
      onProgress({ type: 'usage', usage: { used: 90_000, size: 200_000 } });
    await turn(provider);
    acp.turn = async (onProgress) =>
      onProgress({
        type: 'tool_call_update',
        toolCall: {
          toolCallId: 'c2',
          title: 'Compact conversation',
          status: 'completed',
          rawOutput: { trigger: 'manual', preTokens: 90_000, postTokens: 8_000 },
        },
      });

    await expect(provider.compactOwnContext({ sessionId: 's1', signal: SIGNAL })).resolves.toEqual({
      used: 8_000,
      size: 200_000,
    });
    expect(acp.prompts.at(-1)).toBe('/compact');
    await provider.closeAll();
  });

  it('hands an agent joining a conversation the turns before it, newest kept', () => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      { role: 'system', content: 'digest of compacted turns' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: {} }] },
      { role: 'user', content: 'now this' },
    ] as never;
    const seed = earlierConversation(messages) ?? '';
    expect(seed).toContain('User: old question\n\nAssistant: old answer');
    expect(seed).toContain('Summary: digest of compacted turns');
    // The newest user text is the turn itself, sent after the seed.
    expect(seed).not.toContain('now this');
    expect(earlierConversation([{ role: 'user', content: 'first ever' }] as never)).toBeUndefined();

    const long = earlierConversation(messages, 20) ?? '';
    expect(long).toContain('so are its oldest turns');
    expect(long).not.toContain('old question');
  });

  it('runs a fleet call the user approved through the permission request without asking again', async () => {
    const events = new EventBus();
    const asked: string[] = [];
    events.on('tool.confirm_needed', (e) => {
      asked.push(`${e.sessionId} ${e.tool.name}`);
      e.resolve('yes');
    });
    bindAcpLeaderHost({
      events,
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () => ({ trust: async () => {}, deny: async () => {} }) as never,
      context: () => ({}) as never,
      getTool: () => undefined,
      runTool: async () => ({ content: '', isError: false }),
      confirmThroughEvents: true,
    });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    const internals = provider as unknown as {
      confirm(s: string, t: { name: string }, i: unknown, r: unknown): Promise<boolean>;
      approveFleetCall(s: string, t: { name: string }, i: unknown): Promise<boolean>;
    };
    const delegate = { name: 'delegate' };
    const signal = new AbortController().signal;

    // The agent's permission request for the call: asked, approved.
    await expect(
      internals.confirm('tab-2', delegate, { task: 'x', scope: 'a' }, { toolCallId: 't1', signal }),
    ).resolves.toBe(true);
    // The run that follows (keys in another order) uses that approval, once.
    await expect(
      internals.approveFleetCall('tab-2', delegate, { scope: 'a', task: 'x' }),
    ).resolves.toBe(true);
    expect(asked).toEqual(['tab-2 delegate']);
    // A second run of the same call was never approved: it asks.
    await expect(
      internals.approveFleetCall('tab-2', delegate, { scope: 'a', task: 'x' }),
    ).resolves.toBe(true);
    expect(asked).toEqual(['tab-2 delegate', 'tab-2 delegate']);
  });

  it("resumes the agent's own session for a resumed WrongStack session, with no recap", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'acp-leader-resume-'));
    try {
      const bind = () =>
        bindAcpLeaderHost({
          events: new EventBus(),
          projectRoot: '/proj',
          stateDir,
          getConfig: () => CONFIG,
          permission: () =>
            ({ evaluate: async () => ({ permission: 'auto', source: 'default' }) }) as never,
          context: () => ({}) as never,
          getTool: () => undefined,
          runTool: async () => ({ content: '', isError: false }),
        });
      const request = {
        model: 'claude-code',
        messages: [
          { role: 'user' as const, content: 'earlier question' },
          { role: 'assistant' as const, content: 'earlier answer' },
          { role: 'user' as const, content: 'next' },
        ],
        cache: { sessionId: 's1', threadId: 's1' },
      };
      const run = async () => {
        bind();
        const provider = new AcpLeaderProvider({
          bootConfig: CONFIG,
          buildProvider: () => undefined,
        });
        for await (const _ of provider.stream(request as never, { signal: SIGNAL })) {
          // drain
        }
        await provider.closeAll();
      };

      // First run: a new agent session, which joins with the earlier turns.
      await run();
      expect(acp.opened).toEqual(['new']);
      expect(acp.prompts[0]).toContain('<earlier-conversation>');
      await vi.waitFor(async () => {
        const { readLeaderSession } = await import('../src/acp-leader/acp-leader-resume.js');
        expect(await readLeaderSession(stateDir, 's1', 'claude-code')).toBe('sess_1');
      });

      // The process restarts and the session is resumed: the agent continues
      // its own session, so the turn is just the new message.
      await run();
      expect(acp.opened).toEqual(['new', 'sess_1']);
      expect(acp.prompts[1]).not.toContain('<earlier-conversation>');
      expect(acp.prompts[1]).toMatch(/\n\nnext$/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('ignores a settled call that is not a compaction', () => {
    const context = new LeaderContext();
    context.usage({ used: 5_000, size: 0 });
    expect(
      context.toolCall({
        toolCallId: 't',
        title: 'Read a.ts',
        status: 'completed',
        rawOutput: { postTokens: 1 },
      }),
    ).toBeUndefined();
    expect(context.current).toEqual({ used: 5_000, size: 0 });
  });
});
