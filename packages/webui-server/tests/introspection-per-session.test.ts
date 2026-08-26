import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleIntrospectionRoute,
  type IntrospectionRouteContext,
} from '../src/server/introspection-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

/**
 * `diag.get`, `stats.get` and `side_effects.list` describe ONE conversation.
 *
 * They used to read `ctx.agent` — the agent of whichever session the RUNTIME
 * last switched to. With four tabs open that is a different session from the
 * asking one as often as not, so a background tab asking for its own stats got
 * the foreground's token counts and message totals, stamped with the
 * foreground's id (which the browser's own session filter then dropped,
 * leaving the panel blank).
 */

const ws = {} as WebSocket;

function agentFor(sessionId: string, messages: number, sideEffects: number) {
  return {
    tools: { list: () => [{ name: 'Bash' }], listForProvider: () => [{ name: 'Bash' }] },
    ctx: {
      provider: { id: `provider-${sessionId}`, maxToolsCount: 0 },
      model: `model-${sessionId}`,
      messages: new Array(messages).fill({}),
      todos: [],
      readFiles: new Set<string>(),
      session: { id: sessionId, startedAt: new Date(0).toISOString() },
      tokenCounter: {
        total: () => ({ input: messages, output: 0, total: messages }),
        cacheStats: () => ({ readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }),
        currentRequestTokens: () => 0,
      },
      sideEffects: new Array(sideEffects).fill({
        toolUseId: `t-${sessionId}`,
        toolName: 'Bash',
        ts: '2026-08-26T00:00:00.000Z',
        input: {},
        outcome: 'ok',
        risk: 'standard',
      }),
    },
  };
}

function makeContext() {
  const sent: WSServerMessage[] = [];
  const agents: Record<string, ReturnType<typeof agentFor>> = {
    'tab-1': agentFor('tab-1', 10, 1),
    'tab-2': agentFor('tab-2', 99, 7),
  };
  const ctx = {
    // The runtime is on tab-1 — the foreground, as far as the process knows.
    agent: agents['tab-1'],
    getAgent: (sessionId?: string) => (sessionId ? agents[sessionId] : undefined),
    getConfig: () => ({ features: {} }),
    getProjectRoot: () => '/repo',
    getSessionId: () => 'tab-1',
    getSessionStartedAt: () => 0,
    getModeId: () => 'default',
    send: (_socket: WebSocket, message: WSServerMessage) => sent.push(message),
  } as unknown as IntrospectionRouteContext;
  return { ctx, sent };
}

describe('introspection answers about the asking session', () => {
  it('stats.get reports the ASKING tab’s numbers, not the runtime’s', async () => {
    const { ctx, sent } = makeContext();
    await handleIntrospectionRoute(ctx, ws, {
      type: 'stats.get',
      payload: { sessionId: 'tab-2' },
    } as never);

    const p = sent[0]?.payload as Record<string, unknown>;
    expect(p['sessionId']).toBe('tab-2');
    expect(p['messages']).toBe(99);
    expect(p['sideEffectCount']).toBe(7);
    expect(p['model']).toBe('model-tab-2');
  });

  it('side_effects.list returns the asking tab’s own tool history', async () => {
    const { ctx, sent } = makeContext();
    await handleIntrospectionRoute(ctx, ws, {
      type: 'side_effects.list',
      payload: { sessionId: 'tab-2' },
    } as never);

    const p = sent[0]?.payload as { sessionId: string; sideEffects: unknown[] };
    expect(p.sessionId).toBe('tab-2');
    expect(p.sideEffects).toHaveLength(7);
  });

  it('diag.get describes the asking tab’s provider and model', async () => {
    const { ctx, sent } = makeContext();
    await handleIntrospectionRoute(ctx, ws, {
      type: 'diag.get',
      payload: { sessionId: 'tab-2' },
    } as never);

    const p = sent[0]?.payload as Record<string, unknown>;
    expect(p['sessionId']).toBe('tab-2');
    expect(p['provider']).toBe('provider-tab-2');
    expect(p['messages']).toBe(99);
  });

  it('falls back to the runtime agent when the request names no session', async () => {
    const { ctx, sent } = makeContext();
    await handleIntrospectionRoute(ctx, ws, { type: 'stats.get' } as never);

    const p = sent[0]?.payload as Record<string, unknown>;
    expect(p['sessionId']).toBe('tab-1');
    expect(p['messages']).toBe(10);
  });

  it('falls back to the runtime agent on a host with no per-session registry', async () => {
    // Single-session hosts (the CLI-embedded WebUI) omit `getAgent`; their
    // behaviour must be byte-identical to before.
    const { ctx, sent } = makeContext();
    (ctx as { getAgent?: unknown }).getAgent = undefined;

    await handleIntrospectionRoute(ctx, ws, {
      type: 'stats.get',
      payload: { sessionId: 'tab-2' },
    } as never);

    const p = sent[0]?.payload as Record<string, unknown>;
    expect(p['messages']).toBe(10);
  });
});
