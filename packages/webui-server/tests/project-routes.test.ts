import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleProjectRoute, type ProjectRouteHandlers } from '@wrongstack/webui-server';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(
    ([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> },
  );
}

function handlers(): ProjectRouteHandlers {
  return {
    listProjects: vi.fn(async () => undefined),
    addProject: vi.fn(async () => undefined),
    selectProject: vi.fn(async () => undefined),
    setWorkingDir: vi.fn(async () => undefined),
  };
}

describe('handleProjectRoute dispatcher characterization', () => {
  it('returns false and does not send for non-project message types', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleProjectRoute(ws, { type: 'git.info', payload: {} }, h)).resolves.toBe(false);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([['projects.list'], ['projects.add'], ['projects.select'], ['working_dir.set']])(
    'dispatches %s to the correct handler and returns true',
    async (type) => {
      const ws = mockWs();
      const h = handlers();

      await expect(handleProjectRoute(ws, { type, payload: {} }, h)).resolves.toBe(true);

      const handlerMap: Record<string, ReturnType<typeof vi.fn>> = {
        'projects.list': h.listProjects as ReturnType<typeof vi.fn>,
        'projects.add': h.addProject as ReturnType<typeof vi.fn>,
        'projects.select': h.selectProject as ReturnType<typeof vi.fn>,
        'working_dir.set': h.setWorkingDir as ReturnType<typeof vi.fn>,
      };

      expect(handlerMap[type]).toHaveBeenCalledTimes(1);
      expect(handlerMap[type]).toHaveBeenCalledWith(ws, expect.anything());
    },
  );

  it('does not invoke any other handler when one type is dispatched', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleProjectRoute(ws, { type: 'projects.list', payload: {} }, h);

    expect(h.listProjects).toHaveBeenCalledTimes(1);
    expect(h.addProject).not.toHaveBeenCalled();
    expect(h.selectProject).not.toHaveBeenCalled();
    expect(h.setWorkingDir).not.toHaveBeenCalled();
  });

  it('dispatches working_dir.set with the original message object', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'working_dir.set', payload: { path: 'src/lib' } };

    await handleProjectRoute(ws, msg, h);

    expect(h.setWorkingDir).toHaveBeenCalledWith(ws, msg);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('dispatches projects.add with the original message object', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = {
      type: 'projects.add',
      payload: { root: '/home/user/project', name: 'My Project' },
    };

    await handleProjectRoute(ws, msg, h);

    expect(h.addProject).toHaveBeenCalledWith(ws, msg);
  });

  it('does not send any messages for a valid dispatch when the handler is a no-op stub', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleProjectRoute(ws, { type: 'projects.select', payload: { root: '/path' } }, h);

    expect(sentMessages(ws)).toEqual([]);
  });
});
