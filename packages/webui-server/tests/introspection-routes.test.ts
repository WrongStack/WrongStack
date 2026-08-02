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
    listWithOwner: () => entries,
    listDisabled: () => [],
    isDisabled: () => false,
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

  it('reports droppedTools as the surplus when maxToolsCount is set below tool count', async () => {
    const { context, sent } = harness(1);
    await handleIntrospectionRoute(context, {} as WebSocket, { type: 'diag.get' });
    const message = sent[0];
    expect(message).toBeDefined();
    if (!message) throw new Error('Expected diag.get response');
    expect((message.payload as { maxTools: number }).maxTools).toBe(1);
    expect((message.payload as { droppedTools: number }).droppedTools).toBe(1);
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
});
