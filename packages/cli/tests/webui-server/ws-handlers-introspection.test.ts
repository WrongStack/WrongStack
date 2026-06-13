import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleDiagGet,
  handleSkillsList,
  handleStatsGet,
  handleToolsList,
} from '../../src/webui-server/ws-handlers/index.js';
import type { IntrospectionContext } from '../../src/webui-server/ws-handlers/introspection.js';

/**
 * PR 5c of Issue #30: introspection ws-handler unit tests.
 *
 * skills.list / tools.list / diag.get / stats.get are read-only
 * snapshots; these drive them with a fake IntrospectionContext (a stub
 * agent/ctx + capturing send) so no real agent, registry, or socket is
 * involved.
 */

const FAKE_WS = {} as WebSocket;

function makeAgent(over: Record<string, unknown> = {}) {
  const ctx = {
    provider: { id: 'anthropic' },
    model: 'claude-opus-4-8',
    projectRoot: '/proj',
    tokenCounter: {
      total: () => ({ input: 100, output: 50 }),
      cacheStats: () => ({ readTokens: 10, writeTokens: 5 }),
    },
    messages: [{ role: 'user' }, { role: 'assistant' }],
    todos: [{ id: '1' }],
    readFiles: new Set(['a.ts', 'b.ts']),
    ...over,
  };
  return {
    ctx,
    tools: {
      list: () => [
        { name: 'read', description: 'Read a file', inputSchema: { properties: { path: {} } } },
        { name: 'bash', description: 'Run a command' },
      ],
    },
  };
}

function makeCtx(over: Partial<IntrospectionContext> = {}): {
  ctx: IntrospectionContext;
  sent: WsServerMessage[];
} {
  const sent: WsServerMessage[] = [];
  const ctx: IntrospectionContext = {
    agent: makeAgent() as never,
    skillLoader: undefined,
    modelsRegistry: undefined,
    projectRoot: '/proj',
    sessionId: 'sess-1',
    sessionStartedAt: 0,
    send: (_ws, msg) => sent.push(msg),
    broadcast: () => {},
    log: () => {},
    ...over,
  };
  return { ctx, sent };
}

const payloadOf = (sent: WsServerMessage[], type: string) =>
  sent.find((m) => m.type === type)?.payload as Record<string, unknown> | undefined;

describe('handleToolsList', () => {
  it('lists tool names, descriptions and param keys', () => {
    const { ctx, sent } = makeCtx();
    handleToolsList(ctx, FAKE_WS);
    const tools = payloadOf(sent, 'tools.list')?.tools as Array<Record<string, unknown>>;
    expect(tools).toEqual([
      { name: 'read', description: 'Read a file', params: ['path'] },
      { name: 'bash', description: 'Run a command', params: [] },
    ]);
  });
});

describe('handleDiagGet', () => {
  it('snapshots provider/model/tools/usage from the agent ctx', () => {
    const { ctx, sent } = makeCtx();
    handleDiagGet(ctx, FAKE_WS);
    const p = payloadOf(sent, 'diag.get');
    expect(p).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      cwd: '/proj',
      sessionId: 'sess-1',
      tools: { count: 2, names: ['read', 'bash'] },
      messages: 2,
      todos: 1,
    });
  });
});

describe('handleSkillsList', () => {
  it('reports disabled when no skill loader is wired', async () => {
    const { ctx, sent } = makeCtx({ skillLoader: undefined });
    await handleSkillsList(ctx, FAKE_WS);
    expect(payloadOf(sent, 'skills.list')).toEqual({ skills: [], enabled: false });
  });

  it('maps manifests + entry triggers when a loader is present', async () => {
    const loader = {
      list: async () => [
        { name: 's1', description: 'one', version: '1.0', source: 'user', path: '/s1' },
      ],
      listEntries: async () => [{ name: 's1', trigger: '/s1', scope: ['a'] }],
    };
    const { ctx, sent } = makeCtx({ skillLoader: loader as never });
    await handleSkillsList(ctx, FAKE_WS);
    const p = payloadOf(sent, 'skills.list');
    expect(p?.enabled).toBe(true);
    expect((p?.skills as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 's1',
      trigger: '/s1',
      scope: ['a'],
    });
  });

  it('reports an error payload when the loader throws', async () => {
    const loader = {
      list: async () => {
        throw new Error('skills broke');
      },
      listEntries: async () => [],
    };
    const { ctx, sent } = makeCtx({ skillLoader: loader as never });
    await handleSkillsList(ctx, FAKE_WS);
    expect(payloadOf(sent, 'skills.list')).toMatchObject({ enabled: true, error: 'skills broke' });
  });
});

describe('handleStatsGet', () => {
  it('leaves cost null when no models registry is wired', async () => {
    const { ctx, sent } = makeCtx({ modelsRegistry: undefined, sessionStartedAt: 0 });
    await handleStatsGet(ctx, FAKE_WS);
    const p = payloadOf(sent, 'stats.get');
    expect(p).toMatchObject({
      sessionId: 'sess-1',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      cost: null,
      messages: 2,
      readFiles: 2,
      tools: 2,
    });
    expect(typeof p?.elapsedMs).toBe('number');
  });

  it('prices usage when a registry resolves the model', async () => {
    const registry = {
      getModel: async () => ({ cost: { input: 3, output: 15, cache_read: 0.3 } }),
    };
    const { ctx, sent } = makeCtx({ modelsRegistry: registry as never });
    await handleStatsGet(ctx, FAKE_WS);
    const p = payloadOf(sent, 'stats.get');
    // cost computed (non-null number) — exact value depends on getCostRates/computeUsageCost.
    expect(typeof p?.cost).toBe('number');
  });
});
