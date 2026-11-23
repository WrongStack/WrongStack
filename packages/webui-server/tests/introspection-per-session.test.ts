import { ToolRegistry } from '@wrongstack/core/registry';
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
  it('shows Kanban as deferred only for the versioned medium tab', async () => {
    const { ctx, sent } = makeContext();
    const registry = new ToolRegistry();
    const names = ['kanban', 'tool_search', 'tool_use'];
    for (const name of names) {
      registry.register({
        name,
        inputSchema: {},
        description: name,
        permission: 'auto',
        mutating: false,
        async execute() {},
      });
    }
    registry.setProviderToolNames(names, 'medium');
    for (const [id, direct] of [
      ['tab-1', true],
      ['tab-2', false],
    ] as const) {
      const agent = ctx.getAgent?.(id);
      if (!agent?.ctx.session) throw new Error('Missing fixture session');
      Object.assign(agent, { tools: registry });
      Object.assign(agent.ctx.session, { providerToolSchemaVersion: direct ? undefined : 1 });
      await handleIntrospectionRoute(ctx, ws, {
        type: 'tools.list',
        payload: { sessionId: id },
      });
      expect(sent.at(-1)?.payload).toMatchObject({
        sessionId: id,
        tools: expect.arrayContaining([expect.objectContaining({ name: 'kanban', direct })]),
      });
    }
  });

  it('changes a Quick group on the selected tab and rejects a missing tab', async () => {
    const { ctx, sent } = makeContext();
    const registry = new ToolRegistry();
    for (const name of ['kanban', 'bash', 'pwsh', 'tool_search', 'tool_use']) {
      registry.register({
        name,
        inputSchema: {},
        description: name,
        permission: 'auto',
        mutating: false,
        async execute() {},
      });
    }
    for (const sessionId of ['tab-1', 'tab-2']) {
      const agent = ctx.getAgent?.(sessionId);
      if (!agent) throw new Error('Missing fixture agent');
      Object.assign(agent, { tools: registry });
      Object.assign(agent.ctx, { meta: { systemPromptVariant: 'quick' } });
    }
    Object.assign(ctx.getAgent?.('tab-2')?.ctx.session ?? {}, {
      quickToolSchemaVersion: 2,
      quickShellTool: 'pwsh',
    });
    await handleIntrospectionRoute(ctx, ws, {
      type: 'tools.group.set',
      payload: { sessionId: 'missing', group: 'kanban', mode: 'on' },
    });
    expect(sent.at(-1)?.payload).toHaveProperty('groupError');
    await handleIntrospectionRoute(ctx, ws, {
      type: 'tools.group.set',
      payload: { sessionId: 'tab-2', group: 'kanban', mode: 'on', requestId: 'group-update' },
    });
    expect(sent.at(-1)?.payload).toMatchObject({
      sessionId: 'tab-2',
      requestId: 'group-update',
      toolGroups: expect.arrayContaining([
        expect.objectContaining({ group: 'kanban', mode: 'on', enabled: true, required: false }),
      ]),
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'bash', direct: false }),
        expect.objectContaining({ name: 'pwsh', direct: true }),
      ]),
    });
    await handleIntrospectionRoute(ctx, ws, {
      type: 'tools.list',
      payload: { sessionId: 'tab-1' },
    });
    expect(sent.at(-1)?.payload).toMatchObject({
      sessionId: 'tab-1',
      toolGroups: expect.arrayContaining([
        expect.objectContaining({ group: 'kanban', mode: 'auto', enabled: false, required: false }),
      ]),
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'kanban', groupDisabled: true, direct: false }),
        expect.objectContaining({ name: 'bash', direct: true }),
        expect.objectContaining({ name: 'pwsh', direct: true }),
      ]),
    });
  });

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

  it('correlates side-effect reads without changing the requested session', async () => {
    const { ctx, sent } = makeContext();
    await handleIntrospectionRoute(ctx, ws, {
      type: 'side_effects.list',
      payload: { sessionId: 'tab-2', requestId: 'effects-read' },
    } as never);
    expect(sent[0]?.payload).toMatchObject({ sessionId: 'tab-2', requestId: 'effects-read' });
  });

  it('reports the retained runtime count separately from its latest fifty-record window', async () => {
    const { ctx, sent } = makeContext();
    const target = ctx.getAgent?.('tab-2');
    if (!target) throw Error('Missing fixture agent');
    target.ctx.sideEffects = Array.from({ length: 60 }, (_, index) => ({
      toolUseId: `effect-${index}`,
      toolName: 'bash',
      ts: '2026-10-28T00:00:00Z',
      input: {},
      risk: 'shell' as const,
    }));
    await handleIntrospectionRoute(ctx, ws, {
      type: 'side_effects.list',
      payload: { sessionId: 'tab-2' },
    } as never);
    const payload = sent[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ total: 60, truncated: true });
    expect(payload['sideEffects'] as { toolUseId: string }[]).toHaveLength(50);
    expect((payload['sideEffects'] as { toolUseId: string }[])[0]?.toolUseId).toBe('effect-10');
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
