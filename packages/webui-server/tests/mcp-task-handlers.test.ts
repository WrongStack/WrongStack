import type { Agent, Context } from '@wrongstack/core/agent';
import type { MCPRegistry } from '@wrongstack/mcp';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createEmbeddedMcpRoutes } from '../src/server/embedded-mcp-routes.js';
import { createMcpRouteTable } from '../src/server/mcp-route-table.js';
import { handleMcpRoute } from '../src/server/mcp-routes.js';
import { createMcpTaskHandlers, resolveMcpTaskContext } from '../src/server/mcp-task-handlers.js';

const context = (id: string) => ({ session: { id }, agentId: 'leader' }) as Context;
function fixture(ownerId = 'tab-b') {
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = {
    readyState: 1,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;
  const owner = Object.assign(context(ownerId), { eventSessionId: (): string => ownerId });
  const registry = {
    listTasks: vi.fn().mockResolvedValue([
      {
        id: 'receipt',
        server: 'build',
        tool: 'run',
        status: 'working',
        createdAt: '2026-10-22T00:00:00Z',
        lastUpdatedAt: '2026-10-22T00:00:00Z',
        delivered: false,
        leaseExpiresAt: Date.now() + 60_000,
        taskId: 'SECRET-REMOTE-ID',
        binding: 'SECRET-ACCOUNT',
        answeredInputs: { SECRET: 'HASH' },
      },
    ]),
    retryTask: vi.fn().mockResolvedValue('requested'),
    cancelTask: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    registry: registry as unknown as MCPRegistry,
    context: (id: string) => (id === ownerId ? owner : undefined),
  };
  const route = async (type: string, payload: unknown) =>
    handleMcpRoute(ws, { type, payload }, createMcpTaskHandlers(deps) as never);
  return { frames, owner, registry, deps, route };
}
const payload = { sessionId: 'tab-b', requestId: 'req', id: 'receipt' };
describe('session-scoped MCP task routes', () => {
  it.each(['../tab-b', 'tab-b/..', 'a/b/c', 'a\\b', 'a%2fb'])(
    'refuses a malformed session identity %s even if a resolver matches it',
    async (sessionId) => {
      const f = fixture(sessionId);
      await f.route('mcp.tasks.list', { sessionId, requestId: 'invalid-control' });
      expect(f.registry.listTasks).not.toHaveBeenCalled();
      expect(f.frames[0]?.payload.success).toBe(false);
    },
  );
  it('accepts the real dated root session identity for listing and task actions', async () => {
    const sessionId = '2026-10-27/sess_01M5ZJRRB69QSY3QH2VK9WDH7B';
    const f = fixture(sessionId);
    await f.route('mcp.tasks.list', { sessionId, requestId: 'root-list' });
    expect(f.registry.listTasks).toHaveBeenCalledWith(f.owner);
    expect(f.frames[0]).toMatchObject({
      type: 'mcp.tasks.list',
      payload: { sessionId, requestId: 'root-list' },
    });
    await f.route('mcp.tasks.cancel', { sessionId, requestId: 'root-cancel', id: 'receipt' });
    expect(f.registry.cancelTask).toHaveBeenCalledWith(f.owner, 'receipt');
    await f.route('mcp.tasks.retry', { sessionId, requestId: 'root-retry', id: 'receipt' });
    expect(f.registry.retryTask).toHaveBeenCalledWith(f.owner, 'receipt');
  });
  it.each(['standalone', 'embedded'])(
    'binds the named session through the %s host route table',
    async (host) => {
      const f = fixture(),
        root = context('tab-a');
      const peekAgent = (id?: string) => (id === 'tab-b' ? ({ ctx: f.owner } as Agent) : undefined);
      const table =
        host === 'standalone'
          ? createMcpRouteTable(
              {
                context: root,
                peekAgent,
                mcpRegistry: f.deps.registry,
              } as unknown as Parameters<typeof createMcpRouteTable>[0],
              () => false,
            )
          : createEmbeddedMcpRoutes({
              opts: { agent: { ctx: root }, mcpRegistry: f.deps.registry },
              sessionCtx: { peekAgent },
            } as unknown as Parameters<typeof createEmbeddedMcpRoutes>[0]);
      await handleMcpRoute(
        { readyState: 1, send() {} } as unknown as WebSocket,
        { type: 'mcp.tasks.list', payload },
        table,
      );
      expect(f.registry.listTasks).toHaveBeenCalledWith(f.owner);
    },
  );
  it('resolves the named live agent and refuses unknown sessions without creating agents', () => {
    const root = context('tab-a'),
      target = context('tab-b');
    const peek = vi.fn((id?: string) => (id === 'tab-b' ? ({ ctx: target } as Agent) : undefined));
    expect(resolveMcpTaskContext(root, peek, 'tab-b')).toBe(target);
    expect(resolveMcpTaskContext(root, peek, 'tab-a')).toBe(root);
    expect(resolveMcpTaskContext(root, peek, 'unknown')).toBeUndefined();
    expect(resolveMcpTaskContext(root, undefined, 'tab-b')).toBeUndefined();
  });
  it('returns only a safe browser projection in the named session', async () => {
    const f = fixture();
    expect(await f.route('mcp.tasks.list', payload)).toBe(true);
    expect(f.registry.listTasks).toHaveBeenCalledWith(f.owner);
    expect(f.frames[0]).toMatchObject({
      type: 'mcp.tasks.list',
      payload: {
        sessionId: 'tab-b',
        requestId: 'req',
        tasks: [{ id: 'receipt', observing: true }],
      },
    });
    expect(JSON.stringify(f.frames)).not.toContain('SECRET');
    expect(JSON.stringify(f.frames)).not.toContain('lease');
  });
  it.each(['mcp.tasks.list', 'mcp.tasks.retry', 'mcp.tasks.cancel'])(
    'rejects foreign and malformed requests: %s',
    async (type) => {
      const f = fixture();
      await f.route(type, { ...payload, sessionId: 'foreign' });
      await f.route(type, { ...payload, requestId: {} });
      expect(f.registry.listTasks).not.toHaveBeenCalled();
      expect(f.registry.retryTask).not.toHaveBeenCalled();
      expect(f.registry.cancelTask).not.toHaveBeenCalled();
      expect(f.frames.every((frame) => frame.payload.success === false)).toBe(true);
    },
  );
  it('keeps cancellation cooperative and does not update task status', async () => {
    const f = fixture();
    await f.route('mcp.tasks.cancel', payload);
    expect(f.registry.cancelTask).toHaveBeenCalledWith(f.owner, 'receipt');
    expect(f.frames[0]?.payload).toMatchObject({
      success: true,
      message: expect.stringContaining('requested'),
    });
    expect(f.frames[0]?.payload).not.toHaveProperty('status');
    await f.route('mcp.tasks.retry', payload);
    expect(f.registry.retryTask).toHaveBeenCalledWith(f.owner, 'receipt');
  });
  it('redacts operation failures and honours a denying trust boundary', async () => {
    const f = fixture();
    f.registry.cancelTask.mockRejectedValue(new Error('SECRET-ACCOUNT'));
    await f.route('mcp.tasks.cancel', payload);
    expect(f.frames[0]?.payload.success).toBe(false);
    expect(JSON.stringify(f.frames)).not.toContain('SECRET');
    const evaluate = vi.fn(async () => ({
      kind: 'deny' as const,
      reason: 'denied',
      policyId: 'test',
    }));
    const handlers = createMcpTaskHandlers({
      ...f.deps,
      trustBoundary: {
        evaluate,
      },
    });
    await handlers.tasksRetry({ readyState: 1, send() {} } as unknown as WebSocket, {
      type: 'mcp.tasks.retry',
      payload,
    });
    expect(f.registry.retryTask).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'process', id: 'build' },
        scope: { sessionId: 'tab-b' },
      }),
    );
  });
  it('does not send a list if the context switches while loading', async () => {
    const f = fixture();
    f.registry.listTasks.mockImplementation(async () => {
      vi.spyOn(f.owner, 'eventSessionId').mockReturnValue('tab-a');
      return [];
    });
    await f.route('mcp.tasks.list', payload);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toMatchObject({ type: 'mcp.tasks.result', payload: { success: false } });
  });
});
