/**
 * F980 — a warm `session/load` carries the client's current systemPrompt.
 *
 * The cold branch has always read it (`'systemPrompt' in p ? parse… :
 * persisted`), and the warm branch honours the client's current cwd and
 * mcpServers for the same reason: a client that changed its configuration
 * since `session/new` must not be stuck with the old one. The warm branch
 * used to skip systemPrompt entirely, so a live session kept answering under
 * the previous prompt (or none) while `session/load` reported success.
 *
 * These tests drive the real handler + turn adapter; only the host agent
 * factory is a recording stub (production: buildAcpServerAgentFactory).
 */
import type { Agent } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { ACPProtocolHandler } from '../src/agent/protocol-handler.js';
import { makeACPServerAgentTurn } from '../src/agent/server-agent-turn.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = process.cwd();

interface AgentForCall {
  systemPrompt: { mode: string; text: string } | undefined;
}

function makeHarness() {
  const calls: AgentForCall[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    send: vi.fn(async (m: Record<string, unknown>) => {
      sent.push(m);
    }),
  } as never as AgentServerTransport;
  const turn = makeACPServerAgentTurn({
    agentFor: async (
      _sessionId: string,
      _cwd: string,
      _api?: unknown,
      _mcpServers?: unknown,
      systemPrompt?: { mode: string; text: string },
    ) => {
      calls.push({ systemPrompt });
      return {
        run: vi.fn(async () => ({ status: 'done', iterations: 1, finalText: 'ok' })),
        teardown: vi.fn(async () => {}),
      } as never as Agent;
    },
  });
  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: CWD,
    runTurn: turn,
    replayFor: turn.replay,
    seedFor: turn.seed,
    disposeFor: turn.dispose,
  });
  let nextId = 1;
  const call = async (method: string, params?: unknown) => {
    const id = nextId++;
    await handler.handleMessage({ id, method, params } as never);
    return sent.findLast((m) => m['id'] === id) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  };
  return { call, calls };
}

const PROMPT_A = { mode: 'append', text: 'Answer in English.' };
const PROMPT_B = { mode: 'override', text: 'Answer in Turkish.' };

async function openSession(
  call: Awaited<ReturnType<typeof makeHarness>>['call'],
  systemPrompt?: unknown,
) {
  await call('initialize', { protocolVersion: 1 });
  const created = await call('session/new', {
    cwd: CWD,
    mcpServers: [],
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
  const sessionId = created.result?.['sessionId'] as string;
  await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  return sessionId;
}

describe('warm session/load carries the current systemPrompt (F980)', () => {
  it('replaces the prompt and rebuilds the session agent for the next turn', async () => {
    const { call, calls } = makeHarness();
    const sessionId = await openSession(call, PROMPT_A);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toEqual(PROMPT_A);

    const loaded = await call('session/load', {
      sessionId,
      cwd: CWD,
      mcpServers: [],
      systemPrompt: PROMPT_B,
    });
    expect(loaded.error).toBeUndefined();
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.systemPrompt).toEqual(PROMPT_B);
  });

  it('clears the prompt on an explicit empty value, as the cold load does', async () => {
    const { call, calls } = makeHarness();
    const sessionId = await openSession(call, PROMPT_A);

    const loaded = await call('session/load', {
      sessionId,
      cwd: CWD,
      mcpServers: [],
      systemPrompt: '',
    });
    expect(loaded.error).toBeUndefined();
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.systemPrompt).toBeUndefined();
  });

  it('adds a prompt to a session that opened without one', async () => {
    const { call, calls } = makeHarness();
    const sessionId = await openSession(call);
    expect(calls[0]?.systemPrompt).toBeUndefined();

    await call('session/load', { sessionId, cwd: CWD, mcpServers: [], systemPrompt: PROMPT_B });
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.systemPrompt).toEqual(PROMPT_B);
  });

  it('keeps the prompt and the live agent when the load omits systemPrompt', async () => {
    const { call, calls } = makeHarness();
    const sessionId = await openSession(call, PROMPT_A);

    await call('session/load', { sessionId, cwd: CWD, mcpServers: [] });
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });

    // No rebuild: the agent stays live and keeps the prompt it was built with.
    expect(calls).toHaveLength(1);
  });

  it('does not rebuild when the load repeats the same prompt', async () => {
    const { call, calls } = makeHarness();
    const sessionId = await openSession(call, PROMPT_A);

    // Whitespace-only difference normalizes to the same stored prompt.
    await call('session/load', {
      sessionId,
      cwd: CWD,
      mcpServers: [],
      systemPrompt: { mode: 'append', text: '  Answer in English.  ' },
    });
    await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] });

    expect(calls).toHaveLength(1);
  });
});
