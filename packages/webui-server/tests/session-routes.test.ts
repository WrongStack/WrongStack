import { handleSessionRoute, type SessionRouteHandlers } from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function handlers(): SessionRouteHandlers {
  return {
    newSession: vi.fn(async () => undefined),
    clearContext: vi.fn(async () => undefined),
    debugContext: vi.fn(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    repairContext: vi.fn(async () => undefined),
    openContextEditor: vi.fn(async () => undefined),
    validateContextEditor: vi.fn(async () => undefined),
    applyContextEditor: vi.fn(async () => undefined),
    listContextModes: vi.fn(async () => undefined),
    switchContextMode: vi.fn(async () => undefined),
    createContextMode: vi.fn(async () => undefined),
    updateContextMode: vi.fn(async () => undefined),
    deleteContextMode: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => undefined),
    saveSession: vi.fn(async () => undefined),
    inspectSession: vi.fn(async () => undefined),
    listCheckpoints: vi.fn(async () => undefined),
    rewindSession: vi.fn(async () => undefined),
    subscribeSessions: vi.fn(async () => undefined),
  };
}

describe('handleSessionRoute dispatcher characterization', () => {
  it('returns false and does not send for non-session message types', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleSessionRoute(ws, { type: 'projects.list', payload: {} }, h)).resolves.toBe(
      false,
    );

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    'session.new',
    'context.clear',
    'context.debug',
    'context.compact',
    'context.repair',
    'context.editor.open',
    'context.editor.validate',
    'context.editor.apply',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'sessions.list',
    'session.rename',
    'session.delete',
    'session.resume',
    'session.save',
    'session.inspect',
    'session.checkpoints',
    'session.rewind',
  ])('dispatches %s to the correct handler and returns true', async (type) => {
    const ws = mockWs();
    const h = handlers();
    const handlerMap: Record<string, ReturnType<typeof vi.fn>> = {
      'session.new': h.newSession as ReturnType<typeof vi.fn>,
      'context.clear': h.clearContext as ReturnType<typeof vi.fn>,
      'context.debug': h.debugContext as ReturnType<typeof vi.fn>,
      'context.compact': h.compactContext as ReturnType<typeof vi.fn>,
      'context.repair': h.repairContext as ReturnType<typeof vi.fn>,
      'context.editor.open': h.openContextEditor as ReturnType<typeof vi.fn>,
      'context.editor.validate': h.validateContextEditor as ReturnType<typeof vi.fn>,
      'context.editor.apply': h.applyContextEditor as ReturnType<typeof vi.fn>,
      'context.modes.list': h.listContextModes as ReturnType<typeof vi.fn>,
      'context.mode.switch': h.switchContextMode as ReturnType<typeof vi.fn>,
      'context.mode.create': h.createContextMode as ReturnType<typeof vi.fn>,
      'context.mode.update': h.updateContextMode as ReturnType<typeof vi.fn>,
      'context.mode.delete': h.deleteContextMode as ReturnType<typeof vi.fn>,
      'sessions.list': h.listSessions as ReturnType<typeof vi.fn>,
      'session.rename': h.renameSession as ReturnType<typeof vi.fn>,
      'session.delete': h.deleteSession as ReturnType<typeof vi.fn>,
      'session.resume': h.resumeSession as ReturnType<typeof vi.fn>,
      'session.save': h.saveSession as ReturnType<typeof vi.fn>,
      'session.inspect': h.inspectSession as ReturnType<typeof vi.fn>,
      'session.checkpoints': h.listCheckpoints as ReturnType<typeof vi.fn>,
      'session.rewind': h.rewindSession as ReturnType<typeof vi.fn>,
    };

    await expect(handleSessionRoute(ws, { type, payload: {} }, h)).resolves.toBe(true);

    expect(handlerMap[type]).toHaveBeenCalledTimes(1);
    expect(handlerMap[type]).toHaveBeenCalledWith(ws, expect.anything());
  });

  it('does not invoke any other handler when one type is dispatched', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleSessionRoute(ws, { type: 'session.save', payload: {} }, h);

    expect(h.saveSession).toHaveBeenCalledTimes(1);
    expect(h.newSession).not.toHaveBeenCalled();
    expect(h.clearContext).not.toHaveBeenCalled();
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(h.resumeSession).not.toHaveBeenCalled();
    expect(h.rewindSession).not.toHaveBeenCalled();
  });
});
