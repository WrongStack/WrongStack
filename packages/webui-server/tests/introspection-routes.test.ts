import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleIntrospectionRoute,
  type IntrospectionRouteContext,
} from '../src/server/introspection-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/introspection-v1.json', import.meta.url)), 'utf8'),
) as { request: { type: string }; response: WSServerMessage };

function harness(maxToolsCount?: number) {
  const sent: WSServerMessage[] = [];
  const entries = [
    { tool: { name: 'read', inputSchema: { properties: { path: {} } } }, owner: 'core' },
    { tool: { name: 'bash', inputSchema: {} }, owner: 'core' },
  ];
  const tools = {
    list: () => entries.map(({ tool }) => tool),
    listForProvider: () => entries.slice(0, 1).map(({ tool }) => tool),
    listWithOwner: () => entries,
    listDisabled: () => [],
    isDisabled: () => false,
    isExposedToProvider: (name: string) => name === 'read',
    disable: vi.fn(() => true),
    enable: vi.fn(() => true),
  };
  const context = {
    agent: {
      ctx: {
        provider: { id: 'anthropic', ...(maxToolsCount !== undefined ? { maxToolsCount } : {}) },
        model: 'claude-opus-4-8',
        tokenCounter: {
          total: () => ({ input: 100, output: 50 }),
          cacheStats: () => ({ readTokens: 10, writeTokens: 5 }),
        },
        messages: [{ role: 'user' }, { role: 'assistant' }],
        todos: [{ id: '1' }],
        readFiles: new Set(['a.ts']),
        sideEffects: [],
      },
      tools,
    } as never,
    getConfig: () => ({ features: {} }) as never,
    getProjectRoot: () => '/proj',
    getSessionId: () => 'sess-1',
    getSessionStartedAt: () => 0,
    getModeId: () => 'default',
    send: (_ws: WebSocket, message: WSServerMessage) => sent.push(message),
  } satisfies IntrospectionRouteContext;
  return { context, sent, tools };
}

describe('canonical introspection handler family', () => {
  it.each(['disable', 'enable'] as const)(
    'correlates tool %s success and refusal without altering legacy replies',
    async (action) => {
      const { context, sent, tools } = harness();
      await handleIntrospectionRoute(context, {} as WebSocket, {
        type: `tool.${action}`,
        payload: { name: 'read', requestId: 'native-tool-1' },
      });
      expect(sent.at(-1)?.payload).toEqual({ name: 'read', ok: true, requestId: 'native-tool-1' });
      tools[action].mockReturnValueOnce(false);
      await handleIntrospectionRoute(context, {} as WebSocket, {
        type: `tool.${action}`,
        payload: { name: 'missing', requestId: 'native-tool-2' },
      });
      expect(sent.at(-1)?.payload).toEqual({
        name: 'missing',
        ok: false,
        requestId: 'native-tool-2',
      });
      await handleIntrospectionRoute(context, {} as WebSocket, {
        type: `tool.${action}`,
        payload: { name: 'read' },
      });
      expect(sent.at(-1)?.payload).toEqual({ name: 'read', ok: true });
    },
  );
  it('matches the shared diagnostics golden fixture', async () => {
    const { context, sent } = harness();
    expect(await handleIntrospectionRoute(context, {} as WebSocket, fixture.request)).toBe(true);
    expect(sent).toEqual([fixture.response]);
  });

  it('reports droppedTools as 0 when maxToolsCount is unset (no limit)', async () => {
    const { context, sent } = harness();
    await handleIntrospectionRoute(context, {} as WebSocket, { type: 'diag.get' });
    const message = sent[0];
    expect(message).toBeDefined();
    if (!message) throw new Error('Expected diag.get response');
    expect((message.payload as { maxTools: number }).maxTools).toBe(0);
    expect((message.payload as { droppedTools: number }).droppedTools).toBe(0);
  });

  it('computes droppedTools from the direct surface instead of the lazy catalog', async () => {
    const { context, sent } = harness(1);
    await handleIntrospectionRoute(context, {} as WebSocket, { type: 'diag.get' });
    const message = sent[0];
    expect(message).toBeDefined();
    if (!message) throw new Error('Expected diag.get response');
    expect((message.payload as { maxTools: number }).maxTools).toBe(1);
    expect((message.payload as { droppedTools: number }).droppedTools).toBe(0);
  });

  it('reports direct versus lazy exposure in the tool catalog', async () => {
    const { context, sent } = harness();
    await handleIntrospectionRoute(context, {} as WebSocket, { type: 'tools.list' });
    const payload = sent[0]?.payload as { tools: Array<{ name: string; direct: boolean }> };
    expect(payload.tools.map(({ name, direct }) => ({ name, direct }))).toEqual([
      { name: 'read', direct: true },
      { name: 'bash', direct: false },
    ]);
  });

  it('pages side effects backwards from the newest with a bounded limit', async () => {
    const { context, sent } = harness();
    const effects = Array.from({ length: 130 }, (_, i) => ({
      toolUseId: `t${i}`,
      toolName: 'write',
      ts: i,
      input: {},
      outcome: 'success',
      risk: 'low',
    }));
    (context.agent as unknown as { ctx: { sideEffects: unknown[] } }).ctx.sideEffects = effects;
    const page = async (payload?: Record<string, unknown>) => {
      await handleIntrospectionRoute(context, {} as WebSocket, {
        type: 'side_effects.list',
        ...(payload ? { payload } : {}),
      });
      const reply = sent.at(-1)?.payload as Record<string, unknown> & {
        sideEffects: Array<{ toolUseId: string }>;
      };
      return { ...reply, ids: reply.sideEffects.map((effect) => effect.toolUseId) };
    };
    // The default stays the newest 50.
    const latest = await page();
    expect(latest).toMatchObject({ total: 130, truncated: true, start: 80 });
    expect(latest.ids[0]).toBe('t80');
    expect(latest.ids.at(-1)).toBe('t129');
    const older = await page({ before: 80, limit: 60 });
    expect(older).toMatchObject({ start: 20, truncated: true });
    expect(older.ids).toHaveLength(60);
    expect(older.ids[0]).toBe('t20');
    const oldest = await page({ before: 20, limit: 500 });
    expect(oldest).toMatchObject({ start: 0, truncated: false });
    expect(oldest.ids).toHaveLength(20);
    // Invalid paging falls back to the newest page instead of guessing.
    expect((await page({ before: -1, limit: 0 })).start).toBe(80);
  });

  it('claims every family member and rejects foreign messages', async () => {
    const types = [
      'diag.get',
      'stats.get',
      'side_effects.list',
      'tools.list',
      'tool.disable',
      'tool.enable',
    ];
    for (const type of types) {
      const { context } = harness();
      expect(
        await handleIntrospectionRoute(context, {} as WebSocket, {
          type,
          ...(type.startsWith('tool.') ? { payload: { name: 'read' } } : {}),
        }),
      ).toBe(true);
    }
    const { context } = harness();
    expect(await handleIntrospectionRoute(context, {} as WebSocket, { type: 'test.foreign' })).toBe(
      false,
    );
  });

  it('rejects malformed tool mutations without touching the registry', async () => {
    const { context, sent, tools } = harness();
    await handleIntrospectionRoute(context, {} as WebSocket, {
      type: 'tool.disable',
      payload: {},
    });
    expect(tools.disable).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({
      type: 'error',
      payload: { message: 'tool.disable requires a name' },
    });
  });

  it('runs /browser against the project policy and answers the asking tab', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { browserPrivateOrigins } = await import('@wrongstack/tools');
    const root = await mkdtemp(join(tmpdir(), 'webui-browser-policy-'));
    vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
    vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
    try {
      const { context, sent } = harness();
      const ctx = { ...context, getProjectRoot: () => root };
      expect(
        await handleIntrospectionRoute(ctx, {} as WebSocket, {
          type: 'browser.policy',
          payload: { args: 'allow loopback', sessionId: 'tab-2' },
        }),
      ).toBe(true);
      expect(sent[0]).toMatchObject({
        type: 'browser.policy.result',
        payload: { ok: true, sessionId: 'tab-2' },
      });
      expect((sent[0]?.payload as { message?: string } | undefined)?.message).toContain('loopback');
      expect(browserPrivateOrigins(root)).toEqual(['loopback']);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
