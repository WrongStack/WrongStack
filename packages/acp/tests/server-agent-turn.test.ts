/**
 * Tests for `makeACPServerAgentTurn`.
 *
 * The adapter takes a `Agent` factory. We inject a fake agent that
 * returns canned text, then drive the adapter through the v1 server
 * handler and assert that:
 *  - the agent is created once per sessionId and reused across turns
 *  - the agent's result text is emitted as an `agent_message_chunk`
 *  - on parent abort, the result stopReason is `cancelled`
 *  - non-text content blocks are converted to bracketed placeholders
 */
import { describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';

import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import { ACPProtocolHandler } from '../src/agent/protocol-handler.js';
import {
  disposeACPServerAgentTurn,
  makeACPServerAgentTurn,
  serverAgentTurnCoverage,
} from '../src/agent/server-agent-turn.js';
import { ACPSessionStore } from '../src/agent/session-store.js';

// The v1 handler validates `params.cwd` on session/new|load|fork (WS-015):
// it must be an absolute path to an existing directory. The old literal
// '/test' only passed on machines where that path happened to exist (e.g.
// D:\test on some Windows hosts) and failed on Linux CI. process.cwd() is
// the workspace root — absolute and always present on every platform.
const ACP_TEST_CWD = process.cwd();

interface FakeAgent {
  run: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(text: string): FakeAgent {
  return {
    run: vi.fn(async (input: unknown) => {
      // Honor the abort signal — if aborted, throw AbortError to
      // simulate the real Agent's behavior.
      const sig = (input as { opts?: { signal?: AbortSignal } })?.opts?.signal;
      if (sig?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return { text, stopReason: 'end_turn' };
    }),
    teardown: vi.fn(async () => {}),
  };
}

interface FakeTransport {
  sent: unknown[];
  send: ReturnType<typeof vi.fn>;
}

function fakeTransport(): FakeTransport {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (m: unknown) => {
      sent.push(m);
    }),
  };
}

function makeHandlerWithFactory(agentFor: (sessionId: string) => FakeAgent) {
  const transport = fakeTransport();
  const turn = makeACPServerAgentTurn({
    agentFor: async () => agentFor('sess') as never as Agent,
  });
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: '/test',
    runTurn: turn,
  });
  return { handler, transport, agents: { current: undefined as FakeAgent | undefined } };
}

describe('makeACPServerAgentTurn', () => {
  it('drops agent and replay state when the protocol session closes', async () => {
    const agentFor = vi.fn(async () => makeFakeAgent('bounded') as never as Agent);
    const turn = makeACPServerAgentTurn({ agentFor });
    const transport = fakeTransport();
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
      disposeFor: turn.dispose,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: {} });
    const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'remember me' }] },
    });
    expect(turn.replay(sessionId)).toHaveLength(2);
    await handler.handleMessage({ id: 4, method: 'session/close', params: { sessionId } });
    expect(turn.replay(sessionId)).toEqual([]);
  });

  it('bounds in-memory replay history per session', async () => {
    const turn = makeACPServerAgentTurn({
      agentFor: async () => makeFakeAgent('answer') as never as Agent,
      maxHistoryEntries: 2,
      maxHistoryBytes: 1_024,
    });
    const signal = new AbortController().signal;
    await turn(
      { sessionId: 'bounded', prompt: [{ type: 'text', text: 'first' }], signal },
      () => {},
    );
    await turn(
      { sessionId: 'bounded', prompt: [{ type: 'text', text: 'second' }], signal },
      () => {},
    );
    expect(turn.replay('bounded')).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    ]);
  });

  it('runs a turn, emits agent_message_chunk with the agent text, and resolves end_turn', async () => {
    const { handler, transport } = makeHandlerWithFactory(() => makeFakeAgent('hello world'));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const newResp = transport.sent[transport.sent.length - 1] as {
      result?: { sessionId?: string };
    };
    const sessionId = newResp.result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'say hi' }] },
    });

    // Two sends: agent_message_chunk + prompt response
    expect(transport.sent.length).toBe(2);
    const note = transport.sent[0] as {
      params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
    };
    expect(note.params?.update?.sessionUpdate).toBe('agent_message_chunk');
    expect(note.params?.update?.content?.text).toBe('hello world');

    const resp = transport.sent[1] as { result?: { stopReason?: string } };
    expect(resp.result?.stopReason).toBe('end_turn');
  });

  it('routes an image prompt into a multimodal ContentBlock[] input', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
        captured = userMessage;
        return { text: 'ok', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'look at this:' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: 'and tell me' },
        ],
      },
    });
    // With an image present the adapter builds a core ContentBlock[] so a
    // vision model can actually see it (not a bracketed text placeholder).
    expect(Array.isArray(captured)).toBe(true);
    const blocks = captured as Array<{
      type: string;
      text?: string;
      source?: { media_type?: string; data?: string };
    }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(blocks[0]?.text).toBe('look at this:');
    expect(blocks[1]?.source).toMatchObject({ media_type: 'image/png', data: 'AAAA' });
    expect(blocks[2]?.text).toBe('and tell me');
  });

  it('handles audio and resource content blocks in prompts', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
        captured = userMessage;
        return { text: 'ok', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    // Mixed content with audio, resource, resource_link, and text blocks
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'describe this:' },
          { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
          { type: 'resource', resource: { uri: 'file:///doc.md', text: '## Doc' } },
          { type: 'resource_link', uri: 'https://example.com' },
        ],
      },
    });
    // Without images, promptToAgentInput should return a plain string
    expect(typeof captured).toBe('string');
    const text = captured as string;
    expect(text).toContain('describe this:');
    expect(text).toContain('[audio: audio/wav]');
    expect(text).toContain('[embedded resource: file:///doc.md]');
    expect(text).toContain('[resource link: https://example.com]');
  });

  it('routes audio content in multimodal prompts as text placeholders', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
        captured = userMessage;
        return { text: 'ok', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    // Image triggers multimodal path; audio+resource blocks become text placeholders
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'look:' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
          { type: 'resource', resource: { uri: 'file:///doc.md', text: '## Doc text' } },
          { type: 'resource_link', uri: 'https://example.com' },
        ],
      },
    });
    // With an image present, the adapter builds a ContentBlock[] array
    expect(Array.isArray(captured)).toBe(true);
    const blocks = captured as Array<{
      type: string;
      text?: string;
      source?: { media_type?: string };
    }>;
    expect(blocks[0]?.text).toBe('look:');
    expect(blocks[1]?.source?.media_type).toBe('image/png');
    // Audio block becomes a text placeholder
    const audioBlock = blocks.find((b) => b.type === 'text' && b.text?.includes('[audio'));
    expect(audioBlock).toBeDefined();
    // Resource block with text content
    const resourceBlock = blocks.find((b) => b.type === 'text' && b.text?.includes('## Doc text'));
    expect(resourceBlock).toBeDefined();
  });

  it('emits plan and usage updates from the agent result', async () => {
    const planEntries = [
      { content: 'Step 1', priority: 'high' as const, status: 'in_progress' as const },
    ];
    const usage = { used: 100, size: 1000, cost: { amount: 0.05, currency: 'USD' } };
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async () => ({
        text: 'planned',
        stopReason: 'end_turn',
        plan: planEntries,
        usage,
      })),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'plan it' }] },
    });

    // Extract emitted updates from transport sends
    const updates = transport.sent
      .map((m) => (m as { params?: { update?: { sessionUpdate?: string } } }).params?.update)
      .filter((u): u is { sessionUpdate: string } => !!u);
    const planUpdate = updates.find((u) => u.sessionUpdate === 'plan');
    expect(planUpdate).toBeDefined();
    const usageUpdate = updates.find((u) => u.sessionUpdate === 'usage_update');
    expect(usageUpdate).toBeDefined();
    // The result text from the agent
    const result = transport.sent.find((m) => (m as { result?: unknown }).result) as {
      result?: { stopReason?: string };
    };
    expect(result?.result?.stopReason).toBe('end_turn');
  });

  it('handles agent results that have plan and usage in run result', async () => {
    const fakeAgent = {
      run: vi.fn(async () => ({
        text: 'with details',
        stopReason: 'end_turn' as const,
        plan: [{ content: 'step A', priority: 'high' as const, status: 'in_progress' as const }],
        usage: { used: 50, size: 500, cost: { amount: 0.01, currency: 'USD' as const } },
      })),
      teardown: vi.fn(async () => {}),
    };
    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({ agentFor: async () => fakeAgent as never as Agent });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });

    const updates = transport.sent
      .map(
        (m) =>
          (
            m as {
              params?: { update?: { sessionUpdate?: string; entries?: unknown[]; used?: number } };
            }
          ).params?.update,
      )
      .filter(Boolean);
    const planUpd = updates.find((u) => (u as { sessionUpdate?: string }).sessionUpdate === 'plan');
    expect(planUpd).toBeDefined();
    const usageUpd = updates.find(
      (u) => (u as { sessionUpdate?: string }).sessionUpdate === 'usage_update',
    );
    expect(usageUpd).toBeDefined();
    const u = usageUpd as { used?: number; size?: number };
    expect(u.used).toBe(50);
    expect(u.size).toBe(500);
  });

  it('extractPlan returns empty array for non-array plan field', async () => {
    const fakeAgent = {
      run: vi.fn(async () => ({
        text: 'done',
        stopReason: 'end_turn' as const,
        plan: 'not-an-array',
      })),
      teardown: vi.fn(async () => {}),
    };
    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({ agentFor: async () => fakeAgent as never as Agent });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    // Should not throw despite plan being non-array
    await expect(
      handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      }),
    ).resolves.toBeDefined();
  });

  it('handles agent result with usage but no cost', async () => {
    const fakeAgent = {
      run: vi.fn(async () => ({
        text: 'usage without cost',
        stopReason: 'end_turn' as const,
        usage: { used: 10, size: 100 },
      })),
      teardown: vi.fn(async () => {}),
    };
    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({ agentFor: async () => fakeAgent as never as Agent });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await expect(
      handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      }),
    ).resolves.toBeDefined();
  });

  it('keeps an all-text prompt as a plain string input', async () => {
    let captured: unknown;
    const { handler, transport } = makeHandlerWithFactory(() => ({
      run: vi.fn(async (userMessage: unknown) => {
        captured = userMessage;
        return { text: 'ok', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    }));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'just text' }] },
    });
    expect(captured).toBe('just text');
  });

  it('returns cancelled stopReason when the parent signal aborts', async () => {
    const { handler, transport } = makeHandlerWithFactory(() => makeFakeAgent('hello'));
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    const ac = new AbortController();
    ac.abort();
    // The adapter's prompt is called with the parent signal (aborted)
    // — the fake agent throws AbortError. The handler should still
    // resolve with a non-error response, NOT propagate the throw
    // (the agent's adapter catches it).
    await expect(
      handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      }),
    ).resolves.toBeDefined();
  });

  it('streams tool_call / tool_call_update from the core agent event bus', async () => {
    // Minimal event-bus stand-in: captures handlers and lets run() fire them.
    const handlers: Record<string, (e: unknown) => void> = {};
    const bus = {
      on: (name: string, cb: (e: unknown) => void) => {
        handlers[name] = cb;
        return () => delete handlers[name];
      },
    };
    const fakeAgent = {
      events: bus,
      run: vi.fn(async () => {
        handlers['tool.started']?.({ id: 'tc1', name: 'write_file', input: { path: 'a.ts' } });
        handlers['tool.executed']?.({ id: 'tc1', name: 'write_file', ok: true, output: 'wrote' });
        return { text: 'done', stopReason: 'end_turn' };
      }),
      teardown: vi.fn(async () => {}),
    };

    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({ agentFor: async () => fakeAgent as never as Agent });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });

    const updates = transport.sent
      .map(
        (m) =>
          (
            m as {
              params?: { update?: { sessionUpdate?: string; status?: string; kind?: string } };
            }
          ).params?.update,
      )
      .filter((u): u is { sessionUpdate: string; status?: string; kind?: string } => !!u);
    const toolCall = updates.find((u) => u.sessionUpdate === 'tool_call');
    const toolUpdate = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    expect(toolCall).toBeDefined();
    expect(toolCall?.kind).toBe('edit');
    expect(toolUpdate?.status).toBe('completed');
  });

  it('replays recorded user/agent history on session/load', async () => {
    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({
      agentFor: async () => makeFakeAgent('the answer') as never as Agent,
    });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
      replayFor: turn.replay,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;

    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'the question' }] },
    });
    transport.sent.length = 0;

    await handler.handleMessage({
      id: 4,
      method: 'session/load',
      params: { sessionId, cwd: ACP_TEST_CWD },
    });

    const replayed = transport.sent
      .map(
        (m) =>
          m as {
            method?: string;
            params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
          },
      )
      .filter((m) => m.method === 'session/update')
      .map((m) => m.params?.update)
      .filter((u): u is { sessionUpdate: string; content?: { text?: string } } => !!u);
    const user = replayed.find((u) => u.sessionUpdate === 'user_message_chunk');
    const agent = replayed.find((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(user?.content?.text).toBe('the question');
    expect(agent?.content?.text).toBe('the answer');
  });

  it("seeds a restored session's agent context with prior conversation", async () => {
    const appended: Array<{ role: string; content: unknown }> = [];
    const agent = {
      run: vi.fn(async () => ({ text: 'continued', stopReason: 'end_turn' as const })),
      teardown: vi.fn(async () => {}),
      ctx: {
        state: { appendMessage: (m: { role: string; content: unknown }) => appended.push(m) },
      },
    };
    const turn = makeACPServerAgentTurn({ agentFor: async () => agent as never as Agent });

    // Simulate a cold load: seed the prior conversation, then prompt.
    turn.seed('s1', [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first answer' } },
    ]);
    expect(turn.replay('s1')).toHaveLength(2); // seed also feeds replay

    await turn(
      {
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'follow up' }],
        signal: new AbortController().signal,
      },
      () => {},
    );

    // The new agent's context was primed with the prior turns as messages.
    expect(appended).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);

    // Seeding is one-shot: a second prompt on the same session doesn't re-seed.
    appended.length = 0;
    await turn(
      {
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'again' }],
        signal: new AbortController().signal,
      },
      () => {},
    );
    expect(appended).toEqual([]);
  });

  it('persists history and restores it on session/load after a "restart"', async () => {
    const dir = path.join(
      os.tmpdir(),
      `wstack-acp-store-${process.pid}-${Math.round(performance.now())}`,
    );
    const store = new ACPSessionStore({ dir });
    try {
      // First server instance: create a session and run a turn.
      const t1 = fakeTransport();
      const turn1 = makeACPServerAgentTurn({
        agentFor: async () => makeFakeAgent('persisted answer') as never as Agent,
      });
      const h1 = new ACPProtocolHandler({
        transport: t1 as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn: turn1,
        replayFor: turn1.replay,
        store,
      });
      await h1.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await h1.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
      const sessionId = (t1.sent[t1.sent.length - 1] as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      await h1.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'persisted question' }] },
      });

      // Second server instance (fresh in-memory state — simulates a restart),
      // sharing the same durable store.
      const t2 = fakeTransport();
      const turn2 = makeACPServerAgentTurn({
        agentFor: async () => makeFakeAgent('x') as never as Agent,
      });
      const h2 = new ACPProtocolHandler({
        transport: t2 as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn: turn2,
        replayFor: turn2.replay,
        seedFor: turn2.seed,
        store,
      });
      await h2.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      // Before load, the fresh turn engine knows nothing about the session.
      expect(turn2.replay(sessionId)).toHaveLength(0);
      await h2.handleMessage({
        id: 2,
        method: 'session/load',
        params: { sessionId, cwd: ACP_TEST_CWD },
      });
      // After load, the handler seeded the turn engine from the durable store.
      expect(turn2.replay(sessionId)).toHaveLength(2);

      const replayed = t2.sent
        .map(
          (m) =>
            m as {
              method?: string;
              params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
            },
        )
        .filter((m) => m.method === 'session/update')
        .map((m) => m.params?.update)
        .filter((u): u is { sessionUpdate: string; content?: { text?: string } } => !!u);
      expect(replayed.find((u) => u.sessionUpdate === 'user_message_chunk')?.content?.text).toBe(
        'persisted question',
      );
      expect(replayed.find((u) => u.sessionUpdate === 'agent_message_chunk')?.content?.text).toBe(
        'persisted answer',
      );
      // The load response succeeded (no error).
      const loadResp = t2.sent[t2.sent.length - 1] as { result?: unknown; error?: unknown };
      expect(loadResp.error).toBeUndefined();
      expect(loadResp.result).toBeDefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('creates one agent per session and reuses it across turns', async () => {
    const createCount = { value: 0 };
    const sharedRun = vi.fn(async () => ({ text: 'reuse', stopReason: 'end_turn' as const }));
    const sharedTeardown = vi.fn(async () => {});

    const transport = fakeTransport();
    const turn = makeACPServerAgentTurn({
      agentFor: async () => {
        createCount.value++;
        return { run: sharedRun, teardown: sharedTeardown } as never as Agent;
      },
    });
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn: turn,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: ACP_TEST_CWD } });
    const sessionId = (
      transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
    ).result?.sessionId!;
    transport.sent.length = 0;

    // First turn
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'a' }] },
    });
    transport.sent.length = 0;
    // Second turn on the same session
    await handler.handleMessage({
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'b' }] },
    });

    expect(createCount.value).toBe(1);
    expect(sharedRun).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung run when the wall-clock timeout elapses and reports cancelled', async () => {
    // A run that never resolves on its own — it only settles when its signal
    // aborts (a provider that respects cancellation but never returns). With
    // the old dead timer this would hang past the test timeout; the fixed
    // safety belt aborts the derived signal so the turn resolves 'cancelled'.
    const hungAgent = {
      run: vi.fn(
        (_input: unknown, opts: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            opts.signal.addEventListener(
              'abort',
              () => resolve({ text: '', stopReason: 'end_turn' }),
              { once: true },
            );
          }),
      ),
      teardown: vi.fn(async () => {}),
    };
    const turn = makeACPServerAgentTurn({
      agentFor: async () => hungAgent as never as Agent,
      timeoutMs: 20,
    });

    const result = await turn(
      {
        sessionId: 's-timeout',
        prompt: [{ type: 'text', text: 'go' }],
        signal: new AbortController().signal,
      },
      () => {},
    );

    expect(hungAgent.run).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('cancelled');
  });

  it('reacts when the parent aborts after a turn has started', async () => {
    const agent = {
      run: vi.fn(
        (_input: unknown, { signal }: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({}), { once: true });
          }),
      ),
      teardown: vi.fn(),
    };
    const turn = makeACPServerAgentTurn({
      agentFor: async () => agent as never as Agent,
    });
    const controller = new AbortController();
    const pending = turn(
      { sessionId: 'parent-abort', prompt: [], signal: controller.signal },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(turn.replay('parent-abort')).toEqual([]);
  });

  it('starts with an already-aborted parent signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const turn = makeACPServerAgentTurn({
      agentFor: async () =>
        ({
          run: vi.fn(async () => ({})),
          teardown: vi.fn(),
        }) as never as Agent,
    });
    await expect(
      turn({ sessionId: 'already-aborted', prompt: [], signal: controller.signal }, () => {}),
    ).resolves.toMatchObject({ stopReason: 'cancelled' });
  });

  it('covers empty seeds and clears an active timer on dispose', async () => {
    let finish!: (value: unknown) => void;
    const agent = {
      run: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      teardown: vi.fn(),
    };
    const turn = makeACPServerAgentTurn({
      agentFor: async () => agent as never as Agent,
      timeoutMs: 10_000,
    });
    turn.seed('empty', []);
    const pending = turn(
      { sessionId: 'active', prompt: [], signal: new AbortController().signal },
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    turn.dispose('active');
    finish({});
    await pending;
  });

  it('streams failed tool updates without output or structured input', async () => {
    const handlers: Record<string, (event: never) => void> = {};
    const agent = {
      events: {
        on: (name: string, handler: (event: never) => void) => {
          handlers[name] = handler;
          return () => delete handlers[name];
        },
      },
      run: vi.fn(async () => {
        handlers['tool.started']?.({ id: 'one', name: 'mystery', input: 'raw' } as never);
        handlers['tool.executed']?.({ name: 'mystery', ok: false } as never);
        return {};
      }),
      teardown: vi.fn(),
    };
    const emitted: unknown[] = [];
    const turn = makeACPServerAgentTurn({
      agentFor: async () => agent as never as Agent,
    });
    await turn({ sessionId: 'tools', prompt: [], signal: new AbortController().signal }, (update) =>
      emitted.push(update),
    );
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'in_progress', kind: 'other' }),
        expect.objectContaining({ status: 'failed', toolCallId: 'mystery' }),
      ]),
    );
  });
});

describe('serverAgentTurn deterministic helpers', () => {
  const h = serverAgentTurnCoverage;

  it('normalizes finite positive history limits', () => {
    expect(h.finitePositiveLimit(undefined, 7)).toBe(7);
    expect(h.finitePositiveLimit(Number.NaN, 7)).toBe(7);
    expect(h.finitePositiveLimit(0, 7)).toBe(7);
    expect(h.finitePositiveLimit(-1, 7)).toBe(7);
    expect(h.finitePositiveLimit(2.9, 7)).toBe(2);
  });

  it('trims history by count/bytes and handles an inconsistent byte count', () => {
    const first = { sessionUpdate: 'user_message_chunk', content: { text: 'a' } };
    const second = { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } };
    const entries = [first, second] as never[];
    const bytes = entries.reduce((sum, entry) => sum + h.replayEntryBytes(entry as never), 0);
    expect(h.trimHistory(entries as never, bytes, 1, bytes)).toBe(
      h.replayEntryBytes(second as never),
    );
    expect(entries).toEqual([second]);
    expect(h.trimHistory([], 10, 1, 1)).toBe(10);
    expect(h.trimHistory([first] as never, 0, 0, 0)).toBe(0);
  });

  it('seeds only valid text messages into an available agent state', () => {
    h.seedAgentContext({} as Agent, []);
    const appendMessage = vi.fn();
    h.seedAgentContext({ ctx: { state: { appendMessage } } } as never as Agent, [
      { sessionUpdate: 'user_message_chunk', content: { text: 'question' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 42 } },
      { sessionUpdate: 'agent_message_chunk', content: undefined },
    ]);
    expect(appendMessage).toHaveBeenNthCalledWith(1, {
      role: 'user',
      content: 'question',
    });
    expect(appendMessage).toHaveBeenNthCalledWith(2, {
      role: 'assistant',
      content: 'answer',
    });
  });

  it.each([
    ['read_file', 'read'],
    ['cat_file', 'read'],
    ['write_file', 'edit'],
    ['edit_file', 'edit'],
    ['apply_change', 'edit'],
    ['patch_file', 'edit'],
    ['delete_file', 'delete'],
    ['rm_file', 'delete'],
    ['move_file', 'move'],
    ['rename_file', 'move'],
    ['mv_file', 'move'],
    ['grep_code', 'search'],
    ['glob_code', 'search'],
    ['search_code', 'search'],
    ['find_code', 'search'],
    ['bash_cmd', 'execute'],
    ['shell_cmd', 'execute'],
    ['exec_cmd', 'execute'],
    ['run_cmd', 'execute'],
    ['terminal_cmd', 'execute'],
    ['fetch_url', 'fetch'],
    ['http_get', 'fetch'],
    ['web_get', 'fetch'],
    ['url_get', 'fetch'],
    ['think_hard', 'think'],
    ['plan_work', 'think'],
    ['unknown', 'other'],
  ])('maps tool %s to %s', (name, kind) => {
    expect(h.toolNameToKind(name)).toBe(kind);
  });

  it('builds concise tool titles from every supported input key', () => {
    expect(h.toolTitle('tool', null)).toBe('tool');
    expect(h.toolTitle('tool', [])).toBe('tool');
    expect(h.toolTitle('tool', { path: 42 })).toBe('tool');
    expect(h.toolTitle('tool', { path: '' })).toBe('tool');
    expect(h.toolTitle('tool', { path: 'a' })).toBe('tool: a');
    expect(h.toolTitle('tool', { file: 'b' })).toBe('tool: b');
    expect(h.toolTitle('tool', { filePath: 'c' })).toBe('tool: c');
    expect(h.toolTitle('tool', { pattern: 'd' })).toBe('tool: d');
    expect(h.toolTitle('tool', { command: 'e' })).toBe('tool: e');
    expect(h.toolTitle('tool', { path: 'x'.repeat(81) })).toBe(`tool: ${'x'.repeat(77)}…`);
    expect(h.isRecord({})).toBe(true);
    expect(h.isRecord(null)).toBe(false);
    expect(h.isRecord([])).toBe(false);
    expect(h.isRecord('x')).toBe(false);
  });

  it('converts all prompt block variants', () => {
    expect(
      h.promptToText([
        { type: 'text', text: 'text' },
        { type: 'image', mimeType: 'image/png', data: 'x' },
        { type: 'audio', mimeType: 'audio/wav', data: 'x' },
        { type: 'resource', resource: { uri: 'file:///a' } as never },
        { type: 'resource_link', uri: 'https://a', name: 'a' },
        { type: 'unknown' } as never,
      ]),
    ).toContain('[image: image/png]');

    const multimodal = h.promptToAgentInput([
      { type: 'image', mimeType: 'image/png', data: 'x' },
      { type: 'text', text: 'text' },
      { type: 'audio', mimeType: 'audio/wav', data: 'x' },
      { type: 'resource', resource: { uri: 'file:///a', text: 'embedded' } },
      { type: 'resource', resource: { uri: 'file:///b' } as never },
      { type: 'resource', resource: { uri: 'file:///c', text: 3 } as never },
      { type: 'resource_link', uri: 'https://a', name: 'a' },
      { type: 'unknown' } as never,
    ]);
    expect(multimodal).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'embedded' },
        { type: 'text', text: '[embedded resource: file:///b]' },
        { type: 'text', text: '[resource link: https://a]' },
      ]),
    );
  });

  it('extracts legacy text and defensive empty shapes', () => {
    expect(h.extractText(null)).toBe('');
    expect(h.extractText('text')).toBe('');
    expect(h.extractText({ text: 'direct' })).toBe('direct');
    expect(
      h.extractText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', text: 'ignored' },
          { type: 'text', text: 3 },
          null,
          'primitive',
        ],
      }),
    ).toBe('a');
    expect(h.extractText({})).toBe('');
  });

  it('maps every stop-reason shape', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(h.pickStopReason({}, aborted.signal)).toBe('cancelled');
    const signal = new AbortController().signal;
    expect(h.pickStopReason(null, signal)).toBe('end_turn');
    expect(h.pickStopReason('value', signal)).toBe('end_turn');
    expect(h.pickStopReason({ error: 'failed' }, signal)).toBe('end_turn');
    expect(h.pickStopReason({ stopReason: 'max_tokens' }, signal)).toBe('max_tokens');
    expect(h.pickStopReason({ stopReason: '' }, signal)).toBe('end_turn');
    expect(h.pickStopReason({}, signal)).toBe('end_turn');
  });

  it('filters plans and validates usage including cost', () => {
    expect(h.extractPlan(null)).toEqual([]);
    expect(h.extractPlan('value')).toEqual([]);
    expect(h.extractPlan({ plan: 'no' })).toEqual([]);
    expect(
      h.extractPlan({
        plan: [{ content: 'yes' }, { content: 2 }, null, 'bad'],
      }),
    ).toEqual([{ content: 'yes' }]);

    expect(h.extractUsage(null)).toBeNull();
    expect(h.extractUsage('value')).toBeNull();
    expect(h.extractUsage({})).toBeNull();
    expect(h.extractUsage({ usage: null })).toBeNull();
    expect(h.extractUsage({ usage: { used: '1', size: 2 } })).toBeNull();
    expect(h.extractUsage({ usage: { used: 1, size: '2' } })).toBeNull();
    expect(h.extractUsage({ usage: { used: 1, size: 2, cost: null } })).toEqual({
      used: 1,
      size: 2,
    });
    expect(h.extractUsage({ usage: { used: 1, size: 2, cost: 3 } })).toEqual({
      used: 1,
      size: 2,
    });
    expect(h.extractUsage({ usage: { used: 1, size: 2, cost: { amount: 1 } } })).toEqual({
      used: 1,
      size: 2,
      cost: { amount: 1 },
    });
  });

  it('settles teardown for every registered agent', async () => {
    const first = { teardown: vi.fn(async () => {}) };
    const second = {
      teardown: vi.fn(async () => {
        throw new Error('ignored');
      }),
    };
    await expect(
      disposeACPServerAgentTurn({
        agents: new Map([
          ['first', first as never as Agent],
          ['second', second as never as Agent],
        ]),
      }),
    ).resolves.toBeUndefined();
    expect(first.teardown).toHaveBeenCalledOnce();
    expect(second.teardown).toHaveBeenCalledOnce();
  });
});
