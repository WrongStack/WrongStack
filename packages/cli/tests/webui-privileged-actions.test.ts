import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleProcessKill: vi.fn(),
  handleProcessKillAll: vi.fn(),
  handleProcessList: vi.fn(),
}));

vi.mock('@wrongstack/webui-server', () => mocks);

import {
  authorizeCliWebUIAction,
  createCliProcessRoutes,
} from '../src/webui-server/privileged-actions.js';

describe('CLI WebUI privileged actions', () => {
  it('evaluates actions against the remote session trust boundary', async () => {
    const evaluate = vi.fn().mockResolvedValue({ kind: 'allow', reason: 'policy allowed' });
    const result = await authorizeCliWebUIAction({ evaluate } as never, {
      capability: 'process.kill',
      subject: { kind: 'process', id: '123' },
      risk: 'critical',
      cwd: 'D:\\work\\repo',
      metadata: { transport: 'websocket' },
    });

    expect(result).toEqual({ allowed: true, reason: 'policy allowed' });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        requestId: expect.any(String),
        actor: { kind: 'remote-client' },
        surface: 'webui',
        capability: 'process.kill',
        scope: { cwd: 'D:\\work\\repo' },
        authContext: { method: 'session' },
        metadata: { backend: 'cli-embedded', transport: 'websocket' },
      }),
    );
  });

  it('wires process routes through the same CLI trust boundary', async () => {
    const boundary = { evaluate: vi.fn() } as never;
    const ws = { send: vi.fn() } as never;
    const routes = createCliProcessRoutes(boundary);

    await routes.list(ws, { payload: { sessionId: 'sess-a' } } as never);
    await routes.kill(ws, { payload: { pid: 42 } } as never);
    await routes.killAll(ws, { payload: { sessionId: 'sess-a' } } as never);

    expect(mocks.handleProcessList).toHaveBeenCalledWith(ws, {
      payload: { sessionId: 'sess-a' },
    });
    expect(mocks.handleProcessKill).toHaveBeenCalledWith(ws, { pid: 42 }, boundary, undefined, {
      backend: 'cli-embedded',
    });
    expect(mocks.handleProcessKillAll).toHaveBeenCalledWith(
      ws,
      boundary,
      undefined,
      { backend: 'cli-embedded' },
      { sessionId: 'sess-a' },
    );
  });
});
