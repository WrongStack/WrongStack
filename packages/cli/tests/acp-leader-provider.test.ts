/**
 * An ACP agent as the leader (docs/plans/acp-leader-mode.md): leader turns go
 * to one persistent agent session per conversation and stream back as text;
 * side requests and WrongStack subagents never reach the agent.
 */

import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Provider, StreamEvent } from '@wrongstack/contracts/types';
import { pendingBtwCount, setBtwNote } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acp = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
  steers: [] as string[],
  closes: [] as Array<{ graceMs?: number }>,
  startError: undefined as Error | undefined,
  turn: undefined as
    | ((onProgress: (e: unknown) => void) => Promise<Record<string, unknown>>)
    | undefined,
}));

vi.mock('@wrongstack/acp', () => ({
  textContent: (text: string) => ({ type: 'text', text }),
  findAgentDescriptor: (id: string) =>
    id === 'claude-code' ? { id, contextWindow: 1_000_000 } : undefined,
  resolveAcpAgentCommand: (id: string) =>
    id === 'claude-code' ? { command: 'npx', args: ['adapter'], role: id } : null,
  classifyAgentFailure: (rpc: { message: string }, agent: string) =>
    rpc.message.includes('hit your limit')
      ? { kind: 'provider_quota', message: `${agent}: quota`, retryable: false }
      : undefined,
  ACPSession: {
    start: async (opts: Record<string, unknown>) => {
      acp.starts.push(opts);
      if (acp.startError) throw acp.startError;
      return {
        openSession: async () => ({ sessionId: 'sess_1', resumed: false }),
        prompt: async (
          blocks: Array<{ text: string }>,
          _signal: AbortSignal,
          onProgress: (e: unknown) => void,
        ) => {
          acp.prompts.push(blocks[0]?.text ?? '');
          return (
            (await acp.turn?.(onProgress)) ?? {
              text: 'ok',
              stopReason: 'end_turn',
              toolCalls: [],
              diffs: [],
              thoughts: '',
              hasText: true,
            }
          );
        },
        canSteer: () => true,
        steer: async (text: string) => {
          acp.steers.push(text);
          return 'injected';
        },
        close: async (opts: { graceMs?: number } = {}) => {
          acp.closes.push(opts);
        },
      };
    },
  },
}));

const { acpLeaderHost, bindAcpLeaderHost, closeAcpLeaderSessions, confirmAcpLeaderThroughEvents } =
  await import('../src/acp-leader/acp-leader-host.js');
const { AcpLeaderProvider, isLeaderTurn, leaderSideModel } = await import(
  '../src/acp-leader/acp-leader-provider.js'
);
const { agentTurnError, latestUserText } = await import('../src/acp-leader/acp-leader-stream.js');

const SIGNAL = new AbortController().signal;

function sideProvider(calls: string[]): Provider {
  return {
    id: 'zai',
    capabilities: {} as Provider['capabilities'],
    async *stream(req) {
      calls.push(`stream ${req.model}`);
      yield { type: 'message_start', model: req.model };
    },
    async complete(req) {
      calls.push(`complete ${req.model}`);
      return {
        content: [],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: req.model,
      };
    },
  };
}

function leaderRequest(text: string, thread = 's1') {
  return {
    model: 'claude-code',
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'earlier' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text }] },
    ],
    cache: { sessionId: 's1', threadId: thread },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const CONFIG = { acp: { leader: { sideModel: 'zai/glm-5' } } } as unknown as Config;

beforeEach(() => {
  acp.starts.length = 0;
  acp.prompts.length = 0;
  acp.steers.length = 0;
  acp.closes.length = 0;
  acp.startError = undefined;
  acp.turn = undefined;
});
afterEach(() => bindAcpLeaderHost(undefined));

describe('which requests reach the agent', () => {
  it("treats a request as the leader's turn unless its thread is another agent's", () => {
    expect(isLeaderTurn({ cache: { sessionId: 's1', threadId: 's1' } } as never)).toBe(true);
    expect(isLeaderTurn({ cache: {} } as never)).toBe(true);
    expect(isLeaderTurn({ cache: { sessionId: 's1', threadId: 'sub-7' } } as never)).toBe(false);
  });

  it('picks the side model from acp.leader, then the fallback bridge and chain', () => {
    expect(leaderSideModel(CONFIG)).toEqual({ provider: 'zai', model: 'glm-5' });
    expect(leaderSideModel({ fallbackBridge: 'openai/gpt-5.5/mini' } as unknown as Config)).toEqual(
      { provider: 'openai', model: 'gpt-5.5/mini' },
    );
    // A bare id, or the ACP provider itself, cannot serve a side request.
    expect(
      leaderSideModel({ fallbackModels: ['glm-5', 'acp/claude-code'] } as unknown as Config),
    ).toBeUndefined();
  });

  it('sends side requests and subagent turns to the side model, never the agent', async () => {
    const calls: string[] = [];
    const provider = new AcpLeaderProvider({
      bootConfig: CONFIG,
      buildProvider: (id) => (id === 'zai' ? sideProvider(calls) : undefined),
    });
    await provider.complete(leaderRequest('title please') as never, { signal: SIGNAL });
    await collect(provider.stream(leaderRequest('sub task', 'sub-1') as never, { signal: SIGNAL }));
    expect(calls).toEqual(['complete glm-5', 'stream glm-5']);
    expect(acp.starts).toEqual([]);
  });

  it('refuses a side request clearly when no side model is configured', async () => {
    const provider = new AcpLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    await expect(
      provider.complete(leaderRequest('x') as never, { signal: SIGNAL }),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
      message: expect.stringContaining('sideModel'),
    });
  });
});

describe('the leader context window', () => {
  it("is the leading agent's declared window, and unknown for an agent without one", () => {
    const config = { ...CONFIG, model: 'claude-code' } as Config;
    const host = { getConfig: () => config };
    bindAcpLeaderHost(host as never);
    const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
    expect(provider.capabilities.maxContext).toBe(1_000_000);
    // A host's in-place refinement holds while the same agent leads.
    provider.capabilities.maxContext = 900_000;
    expect(provider.capabilities.maxContext).toBe(900_000);

    host.getConfig = () => ({ ...config, model: 'gemini-cli' }) as Config;
    expect(provider.capabilities.maxContext).toBe(0);
  });
});

describe('a leader turn', () => {
  it('includes a pending /btw note in the next ACP prompt', async () => {
    const context = { meta: {} };
    setBtwNote(context as never, 'check the latest note');
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () => ({ evaluate: async () => ({ permission: 'auto' }) }) as never,
      context: () => context as never,
      getTool: () => undefined,
      runTool: async () => ({ content: '', isError: false }),
    });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    await collect(provider.stream(leaderRequest('inspect this') as never, { signal: SIGNAL }));
    expect(acp.prompts[0]).toContain('check the latest note');
    expect(pendingBtwCount(context as never)).toBe(0);
    await closeAcpLeaderSessions();
  });

  it('delivers a /btw note during an active ACP turn', async () => {
    vi.useFakeTimers();
    const context = { meta: {} };
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () => ({ evaluate: async () => ({ permission: 'auto' }) }) as never,
      context: () => context as never,
      getTool: () => undefined,
      runTool: async () => ({ content: '', isError: false }),
    });
    let finishTurn: ((result: Record<string, unknown>) => void) | undefined;
    acp.turn = () =>
      new Promise((resolve) => {
        finishTurn = resolve;
      });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    try {
      const running = collect(
        provider.stream(leaderRequest('inspect this') as never, { signal: SIGNAL }),
      );
      for (let attempt = 0; attempt < 30 && acp.prompts.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(acp.prompts).toHaveLength(1);
      setBtwNote(context as never, 'check the latest note');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(acp.steers[0]).toContain('check the latest note');
      finishTurn?.({
        text: 'done',
        stopReason: 'end_turn',
        toolCalls: [],
        diffs: [],
        thoughts: '',
        hasText: true,
      });
      await running;
    } finally {
      await closeAcpLeaderSessions();
      vi.useRealTimers();
    }
  });

  it('streams the reply, relays tool cards, and keeps one agent session per conversation', async () => {
    const events = new EventBus();
    const cards: string[] = [];
    events.on('tool.started', (e) => cards.push(`start ${e.name}`));
    events.on('tool.executed', (e) => cards.push(`done ${e.name} ${e.ok}`));
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
    acp.turn = async (onProgress) => {
      onProgress({ type: 'message', text: 'Hello ' });
      onProgress({
        type: 'tool_call',
        toolCall: { toolCallId: 't1', title: 'Read a.ts', status: 'pending', rawInput: { p: 1 } },
      });
      onProgress({
        type: 'tool_call_update',
        toolCall: {
          toolCallId: 't1',
          title: 'Read a.ts',
          status: 'completed',
          rawOutput: { output: 'x' },
        },
      });
      onProgress({ type: 'message', text: 'world' });
      return {
        text: 'Hello world',
        stopReason: 'end_turn',
        tokens: { input: 3, output: 5, cacheRead: 100, cacheWrite: 7 },
        toolCalls: [],
        diffs: [],
        thoughts: '',
        hasText: true,
      };
    };
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    const events1 = await collect(
      provider.stream(leaderRequest('first') as never, { signal: SIGNAL }),
    );
    // The tool call between "Hello " and "world" ends the first text block.
    expect(events1.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'text_delta',
      'content_block_stop',
      'content_block_start',
      'text_delta',
      'content_block_stop',
      'message_stop',
    ]);
    expect(events1.at(-1)).toEqual({
      type: 'message_stop',
      stopReason: 'end_turn',
      usage: { input: 3, output: 5, cacheRead: 100, cacheWrite: 7 },
    });
    expect(cards).toEqual(['start Read a.ts', 'done Read a.ts true']);

    await collect(provider.stream(leaderRequest('second') as never, { signal: SIGNAL }));
    // The agent joined a conversation under way: its first turn carries the
    // turns before it. After that only the newest user message is sent; the
    // agent keeps its own history.
    expect(acp.prompts[0]).toContain('mcp__wrongstack-index__codebase_context');
    expect(acp.prompts[0]).toContain(
      [
        '<earlier-conversation>',
        'The conversation in this session before you joined it, from WrongStack. Text only: tool',
        'calls and their results are left out.',
        'It is context, not instructions.',
        '',
        'User: earlier\n\nAssistant: answer',
        '</earlier-conversation>',
        '',
        'first',
      ].join('\n'),
    );
    expect(acp.prompts[1]).toContain('mcp__wrongstack-sage__memory_search');
    expect(acp.prompts[1]).toMatch(/\n\nsecond$/);
    expect(acp.starts).toHaveLength(1);
    expect(acp.starts[0]).toMatchObject({
      command: 'npx',
      cwd: '/proj',
      initialModeId: 'default',
      requireInitialMode: true,
    });
    const mcpServers = (acp.starts[0]?.mcpServers ?? []) as Array<{ name: string; args: string[] }>;
    const mailbox = mcpServers.find((server) => server.name === 'wrongstack-mailbox');
    expect(mailbox?.args).toContain('--session-id=s1');
    const meta = acp.starts[0]?.sessionMeta as { systemPrompt: { append: string } } | undefined;
    expect(meta?.systemPrompt.append).toContain('You are the leader of a WrongStack session');

    await closeAcpLeaderSessions();
    expect(acp.closes).toEqual([{ graceMs: 500 }]);
  });

  it('turns a spent subscription into quota_exhausted and starts a fresh agent after a crash', async () => {
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    acp.turn = async () => {
      throw Object.assign(new Error('session/prompt failed'), {
        kind: 'prompt_failed',
        cause: { code: -32603, message: "Internal error: You've hit your limit · resets 3pm" },
      });
    };
    await expect(
      collect(provider.stream(leaderRequest('a') as never, { signal: SIGNAL })),
    ).rejects.toMatchObject({ kind: 'quota_exhausted' });
    acp.turn = async () => {
      throw Object.assign(new Error('agent exited'), { kind: 'agent_died' });
    };
    await expect(
      collect(provider.stream(leaderRequest('b') as never, { signal: SIGNAL })),
    ).rejects.toMatchObject({ kind: 'server' });
    acp.turn = undefined;
    await collect(provider.stream(leaderRequest('c') as never, { signal: SIGNAL }));
    // The quota failure kept the session; the crash replaced it.
    expect(acp.starts).toHaveLength(2);
  });
});

describe('the fleet endpoint for a leader', () => {
  it('hands the agent the fleet server, explains it, and decides its tools as the leader tools', async () => {
    const evaluated: string[] = [];
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () =>
        ({
          evaluate: async (tool: { name: string }) => {
            evaluated.push(tool.name);
            return { permission: 'auto', source: 'default' };
          },
        }) as never,
      context: () => ({}) as never,
      getTool: (name) =>
        name === 'delegate'
          ? ({ name, description: 'hand off', inputSchema: { type: 'object' } } as never)
          : undefined,
      runTool: async () => ({ content: 'ok', isError: false }),
    });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    await collect(provider.stream(leaderRequest('go') as never, { signal: SIGNAL }));
    const start = acp.starts[0] as {
      mcpServers: Array<{ type?: string; name: string; url?: string; headers?: unknown[] }>;
      sessionMeta: { systemPrompt: { append: string } };
      permissionPolicy: (req: unknown) => Promise<unknown>;
    };
    const fleet = start.mcpServers.find((s) => s.name === 'wrongstack-fleet');
    expect(fleet).toMatchObject({
      type: 'http',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
    });
    expect(fleet?.headers).toEqual([
      { name: 'Authorization', value: expect.stringMatching(/^Bearer .{20,}/) },
    ]);
    expect(start.sessionMeta.systemPrompt.append).toContain('wrongstack-fleet gives you');

    await start.permissionPolicy({
      toolCall: {
        toolCallId: 'c1',
        kind: 'other',
        title: 'mcp__wrongstack-fleet__delegate',
        rawInput: { task: 'x' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      signal: SIGNAL,
    });
    expect(evaluated).toEqual(['delegate']);
    await provider.closeAll();
  });

  it("rewrites a required-skills marker to name the fleet server's skill tool", async () => {
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () =>
        ({ evaluate: async () => ({ permission: 'auto', source: 'default' }) }) as never,
      context: () => ({}) as never,
      getTool: (name) =>
        name === 'skill'
          ? ({ name, description: 'load a skill', inputSchema: { type: 'object' } } as never)
          : undefined,
      runTool: async () => ({ content: 'ok', isError: false }),
    });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    const hunt = 'Hunt one bug.\n<!-- wrongstack:required-skills bug-hunter testing -->';
    await collect(provider.stream(leaderRequest(hunt) as never, { signal: SIGNAL }));
    expect(acp.prompts[0]).not.toContain('<!--');
    expect(acp.prompts[0]).toContain("This task's playbook skills: bug-hunter, testing.");
    expect(acp.prompts[0]).toContain('`mcp__wrongstack-fleet__skill`');
    await provider.closeAll();
  });

  it('stops listening when the agent never starts, on every retried turn', async () => {
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () =>
        ({ evaluate: async () => ({ permission: 'auto', source: 'default' }) }) as never,
      context: () => ({}) as never,
      getTool: (name) =>
        name === 'delegate'
          ? ({ name, description: 'hand off', inputSchema: { type: 'object' } } as never)
          : undefined,
      runTool: async () => ({ content: 'ok', isError: false }),
    });
    // The agent is not installed: spawning it fails before any session exists.
    acp.startError = Object.assign(new Error('failed to spawn npx: ENOENT'), {
      kind: 'spawn_failed',
    });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    for (const text of ['a', 'b']) {
      await expect(
        collect(provider.stream(leaderRequest(text) as never, { signal: SIGNAL })),
      ).rejects.toMatchObject({ kind: 'server' });
    }
    const urls = acp.starts.map(
      (start) =>
        (start.mcpServers as Array<{ name: string; url: string }>).find(
          (s) => s.name === 'wrongstack-fleet',
        )?.url,
    );
    expect(urls).toEqual([expect.any(String), expect.any(String)]);
    await vi.waitFor(async () => {
      for (const url of urls) {
        await expect(
          fetch(url as string, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000) }),
        ).rejects.toThrow();
      }
    });
  });

  it('clears session fleetGrants on drop so dropped sessions do not leak grants into new sessions', async () => {
    const provider = new AcpLeaderProvider({
      bootConfig: CONFIG,
      buildProvider: () => undefined,
    });
    const tool = { name: 'delegate', description: 'delegate', inputSchema: { type: 'object' } };
    const input = { task: 'sensitive' };

    let askCount = 0;
    (provider as unknown as { ask: () => Promise<boolean> }).ask = async () => {
      askCount++;
      return true;
    };

    // User confirms in session 's-leak'
    await (
      provider as unknown as {
        confirm: (s: string, t: unknown, i: unknown, r: unknown) => Promise<boolean>;
      }
    ).confirm('s-leak', tool, input, { toolCallId: '1', signal: SIGNAL });

    // Session is dropped
    (
      provider as unknown as {
        drop: (k: string, l: unknown) => void;
      }
    ).drop('s-leak', {
      session: { close: async () => {} },
      fleet: undefined,
    });

    // New session on 's-leak' must ask user again rather than auto-approving
    askCount = 0;
    await (
      provider as unknown as {
        approveFleetCall: (s: string, t: unknown, i: unknown) => Promise<boolean>;
      }
    ).approveFleetCall('s-leak', tool, input);

    expect(askCount).toBe(1);
  });
});

describe('the host binding', () => {
  it('keeps an "always" or "deny" given at the REPL prompt, like the event prompt (F497)', async () => {
    const trusted: unknown[] = [];
    const denied: unknown[] = [];
    const bindRepl = (answer: 'always' | 'deny') =>
      bindAcpLeaderHost({
        events: new EventBus(),
        projectRoot: '/proj',
        getConfig: () => CONFIG,
        permission: () =>
          ({
            trust: async (r: unknown) => void trusted.push(r),
            deny: async (r: unknown) => void denied.push(r),
          }) as never,
        context: () => ({}) as never,
        getTool: () => undefined,
        runTool: async () => ({ content: '', isError: false }),
        confirmAwaiter: async () => answer,
      });
    const provider = new AcpLeaderProvider({ bootConfig: CONFIG, buildProvider: () => undefined });
    const confirm = (
      provider as unknown as {
        confirm: (s: string, t: unknown, i: unknown, r: unknown) => Promise<boolean>;
      }
    ).confirm.bind(provider);
    const tool = { name: 'write', description: 'write', inputSchema: { type: 'object' } };
    bindRepl('always');
    expect(await confirm('s1', tool, { path: 'a.ts' }, { toolCallId: '1', signal: SIGNAL })).toBe(
      true,
    );
    bindRepl('deny');
    expect(await confirm('s1', tool, { path: 'a.ts' }, { toolCallId: '2', signal: SIGNAL })).toBe(
      false,
    );
    expect([trusted.length, denied.length]).toEqual([1, 1]);
  });

  it('asks through events, not stdin, once the surface (TUI, WebUI) takes confirmations over', () => {
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: '/proj',
      getConfig: () => CONFIG,
      permission: () => ({}) as never,
      context: () => ({}) as never,
      getTool: () => undefined,
      runTool: async () => ({ content: '', isError: false }),
      confirmAwaiter: async () => 'yes',
    });
    confirmAcpLeaderThroughEvents();
    expect(acpLeaderHost()?.confirmAwaiter).toBeUndefined();
    expect(acpLeaderHost()?.confirmThroughEvents).toBe(true);
    expect(acpLeaderHost()?.projectRoot).toBe('/proj');
  });
});

describe('stream helpers', () => {
  it('reads the newest user text and maps a stall to a timeout', () => {
    expect(latestUserText(leaderRequest('now').messages as never)).toBe('now');
    // Everything since the agent last spoke: an auto-wake plus the result folded in.
    expect(
      latestUserText([
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'text', text: '[AUTO-WAKE]' }] },
        { role: 'user', content: [{ type: 'text', text: '[DELEGATION RESULT] done' }] },
      ] as never),
    ).toBe('[AUTO-WAKE]\n\n[DELEGATION RESULT] done');
    expect(
      agentTurnError(
        Object.assign(new Error('silent'), { kind: 'stalled' }),
        'claude-code',
        () => undefined,
      ),
    ).toMatchObject({ dead: true, error: { kind: 'timeout' } });
  });
});
